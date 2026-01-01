// C:\Users\larho\suka-smart-assistant\src\services\weather\signals.js
// Weather → Planning Signals for garden / animals / outdoor cooking / chores
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//                                    └─ this module converts forecast → signals
//                                       that planning engines use to schedule,
//                                       re-route, or add preparation steps.
//
// What this file does
// -------------------
// • Provides a provider-agnostic interface to fetch forecast slices by time window
// • Computes domain-aware “signals” (heat, frost, wind, rain, UV, lightning risk,
//   humidity, mud risk) with severities + suggestions
// • Exposes an RPC via eventBus.respond("weather/signals") returning signals for
//   a window + domain
// • Listens to session request/approval events and emits `weather/signalsReady`
//   for that session; engines may add modifiers (move indoor, reschedule, add PPE)
// • Implements basic caching + rate limit to avoid spamming the weather backend
//
// Canonical events (via eventBus; payload canonicalized upstream):
//   • "weather/signalsReady" { window, domain, location, signals, summary }
//   • "ui/toast" (informational prompts when notable weather detected)
//
// No hard dependency on the Hub: we mirror to Hub only if familyFundMode is on.
//
// Assumptions
// -----------
//   - There exists a weather provider at "@/services/weather/provider" exporting
//     { getForecastRange({ lat, lon, startISO, endISO, units }) } returning
//     an object like:
//     {
//       points: [{
//         ts: "2025-11-08T15:00:00Z",
//         tempC, relHum, windKph, gustKph, precipMm, pop, uv, cloud, lightningProb,
//       }, ...],
//       source: "OpenMeteo" | "NOAA" | ...
//     }
//
//   - Location can come from config user profile or be passed in call:
//     { location: { lat, lon, tz?, elevation? } }
//
//   - If provider is unavailable, we degrade gracefully and return [].
//
// -----------------------------------------------------------------------------


/* --------------------------------- Imports --------------------------------- */
let eventBus, Events;
try {
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb.default || eb.eventBus || eb;
  Events = eb.Events || {};
} catch {
  try {
    const eb = require("@/services/eventBus.js");
    eventBus = eb.default || eb.eventBus || eb;
    Events = eb.Events || {};
  } catch {
    eventBus = { emit: () => {}, on: () => () => {}, respond: () => () => {} };
    Events = {};
  }
}

let featureFlags = {};
try {
  featureFlags = require("@/config/featureFlags").default || require("@/config/featureFlags");
} catch {}

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {}

let provider = null;
try {
  provider = require("@/services/weather/provider").default || require("@/services/weather/provider");
} catch {}

/* ------------------------------- Configuration ----------------------------- */
const DEFAULT_THRESHOLDS = {
  // Temperature (°C)
  heat_caution: 30,           // outdoor cooking/animals: caution threshold
  heat_danger: 35,
  cold_caution: 5,
  frost: 0.5,
  freeze: -2,
  // Wind (kph)
  wind_caution: 25,
  wind_danger: 40,
  gust_danger: 55,
  // Rain / Precipitation
  precip_mm_caution: 3,       // per-hour
  precip_mm_heavy: 10,
  pop_caution: 50,            // probability of precipitation (percent)
  // UV
  uv_caution: 6,
  uv_high: 8,
  // Humidity (percent)
  humidity_high: 85,
  // Lightning probability (percent)
  lightning_prob_caution: 10,
  lightning_prob_high: 25,
};

const DEFAULT_LOCATION = () => {
  // Fallback if caller doesn't pass location
  try {
    const cfg = require("@/config/app").default || require("@/config/app");
    if (cfg?.location?.lat && cfg?.location?.lon) return { lat: cfg.location.lat, lon: cfg.location.lon, tz: cfg.location.tz };
  } catch {}
  return { lat: 0, lon: 0 }; // safe default (equator, prime meridian)
};

/* ---------------------------------- State ---------------------------------- */
const _cache = new Map(); // key -> { ts, window, location, domain, signals, summary, expires }
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_CALL_GAP_MS = 10 * 1000;   // debouncing back-to-back identical queries
const _lastCall = new Map();         // simple rate limit

let _initialized = false;

/* ----------------------------------- API ----------------------------------- */
export async function initWeatherSignals() {
  if (_initialized) return;
  _initialized = true;

  // RPC: engines ask for signals for a planning window
  eventBus.respond("weather/signals", async (req) => {
    try {
      const res = await getSignalsForWindow(req || {});
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // When engines request sessions, enrich with weather signals (emit advisory)
  eventBus.on(Events?.COOKING_REQUEST_SESSION || "cooking/requestSession", ({ data }) => {
    autoAnnotateIfOutdoor(data, "cooking");
  }, { priority: -1 });

  eventBus.on(Events?.CLEANING_REQUEST_SESSION || "cleaning/requestSession", ({ data }) => {
    autoAnnotateIfOutdoor(data, "cleaning");
  }, { priority: -1 });

  // Garden & Animals often outdoors
  eventBus.on(Events?.GARDEN_PLAN_GENERATE_REQ || "garden/plan.generate.requested", ({ data }) => {
    const time = readWindowFrom(data);
    if (!time) return;
    getSignalsForWindow({ ...time, domain: "garden" }).then((res) => {
      emit("weather/signalsReady", res);
    }).catch(() => {});
  }, { priority: -1 });

  // On session approval, run signals and emit for that specific session window
  eventBus.on(Events?.SESSION_APPROVED || "session/approved", ({ data }) => {
    const time = readWindowFrom(data);
    if (!time) return;
    const domain = data?.session?.domain || data?.domain;
    getSignalsForWindow({ ...time, domain }).then((res) => {
      emit("weather/signalsReady", { ...res, sessionId: data?.session?.id || data?.id });
      if (shouldToastFor(res.signals)) {
        emit(Events?.UI_TOAST || "ui/toast", {
          variant: "info",
          title: "Weather considerations",
          message: res.summary || "Upcoming weather may affect your plan.",
        });
      }
    }).catch(() => {});
  });
}

/**
 * Primary API: compute signals for a time window and domain.
 * @param {{startISO:string,endISO:string,domain?:string,location?:{lat:number,lon:number,tz?:string},units?:'metric'|'imperial'}} args
 * @returns {{window:{startISO,endISO}, domain:string, location:{lat,lon,tz?}, source?:string, signals:Array<WeatherSignal>, summary:string}}
 */
export async function getSignalsForWindow(args) {
  const startISO = firstISO(args?.startISO, args?.start);
  const endISO = firstISO(args?.endISO, args?.end);
  if (!isISO(startISO) || !isISO(endISO)) throw new Error("weather/signals: invalid window");

  const domain = String(args?.domain || "general");
  const location = normalizeLocation(args?.location) || DEFAULT_LOCATION();
  const units = args?.units === "imperial" ? "imperial" : "metric";

  // Cache key
  const key = JSON.stringify({
    s: truncateIsoToHour(startISO),
    e: truncateIsoToHour(endISO),
    d: domain,
    loc: [location.lat, location.lon].map(n => +n.toFixed(3)),
    u: units,
    th: thresholdsHash(),
  });

  // Rate limit identical rapid calls
  const last = _lastCall.get(key) || 0;
  const now = Date.now();
  if (now - last < MIN_CALL_GAP_MS && _cache.has(key)) {
    const cached = _cache.get(key);
    if (cached && cached.expires > now) return cached;
  }
  _lastCall.set(key, now);

  // Cache hit
  const cached = _cache.get(key);
  if (cached && cached.expires > now) return cached;

  const th = getThresholds();
  const fc = await fetchForecastRangeSafe({ startISO, endISO, location, units });
  const signals = computeSignals(fc?.points || [], th, { domain, units });
  const summary = summarizeSignals(signals, domain);
  const result = {
    ts: new Date().toISOString(),
    window: { startISO, endISO },
    domain,
    location,
    source: fc?.source,
    signals,
    summary,
    expires: now + CACHE_TTL_MS,
  };
  _cache.set(key, result);

  return result;
}

/* -------------------------- Signal Computation ----------------------------- */
/**
 * @typedef {Object} WeatherSignal
 * @property {"info"|"caution"|"danger"} severity
 * @property {string} type           // "heat"|"cold"|"frost"|"wind"|"gust"|"rain"|"uv"|"humidity"|"lightning"|"mud"
 * @property {string} label
 * @property {string} [fromISO]
 * @property {string} [toISO]
 * @property {string[]} [recommendations] // actions to take
 * @property {Object}   [metrics]  // domain: raw values (maxWindKph, popMax, etc.)
 */

function computeSignals(points, th, { domain, units }) {
  if (!Array.isArray(points) || points.length === 0) return [];

  // Aggregate metrics across the window
  const agg = {
    maxTempC: -Infinity, minTempC: +Infinity,
    maxWindKph: 0, maxGustKph: 0,
    totalPrecipMm: 0, popMax: 0,
    uvMax: 0, rhMax: 0,
    frostHits: 0, freezeHits: 0,
    lightningProbMax: 0,
    hours: points.length,
    first: points[0]?.ts, last: points[points.length - 1]?.ts,
  };
  for (const p of points) {
    const tC = num(p.tempC);
    agg.maxTempC = Math.max(agg.maxTempC, tC);
    agg.minTempC = Math.min(agg.minTempC, tC);
    agg.maxWindKph = Math.max(agg.maxWindKph, num(p.windKph));
    agg.maxGustKph = Math.max(agg.maxGustKph, num(p.gustKph));
    agg.totalPrecipMm += safe(num(p.precipMm));
    agg.popMax = Math.max(agg.popMax, safe(num(p.pop)));
    agg.uvMax = Math.max(agg.uvMax, safe(num(p.uv)));
    agg.rhMax = Math.max(agg.rhMax, safe(num(p.relHum)));
    agg.frostHits += tC <= th.frost ? 1 : 0;
    agg.freezeHits += tC <= th.freeze ? 1 : 0;
    agg.lightningProbMax = Math.max(agg.lightningProbMax, safe(num(p.lightningProb)));
  }

  const signals = [];

  // Heat / Cold / Frost
  if (agg.maxTempC >= th.heat_danger) {
    signals.push(makeSig("danger", "heat", `Danger heat (${fmtTemp(agg.maxTempC, units)})`, agg, recsHeat(domain)));
  } else if (agg.maxTempC >= th.heat_caution) {
    signals.push(makeSig("caution", "heat", `Heat caution (${fmtTemp(agg.maxTempC, units)})`, agg, recsHeat(domain)));
  }
  if (agg.minTempC <= th.freeze) {
    signals.push(makeSig("danger", "cold", `Freeze risk (${fmtTemp(agg.minTempC, units)})`, agg, recsFreeze(domain)));
  } else if (agg.minTempC <= th.frost) {
    signals.push(makeSig("caution", "frost", `Frost possible (${fmtTemp(agg.minTempC, units)})`, agg, recsFrost(domain)));
  } else if (agg.minTempC <= th.cold_caution) {
    signals.push(makeSig("caution", "cold", `Cold conditions (${fmtTemp(agg.minTempC, units)})`, agg, recsCold(domain)));
  }

  // Wind / Gust
  if (agg.maxGustKph >= th.gust_danger || agg.maxWindKph >= th.wind_danger) {
    signals.push(makeSig("danger", "wind", `High winds (${Math.round(agg.maxWindKph)} kph gust ${Math.round(agg.maxGustKph)} kph)`, agg, recsWind(domain)));
  } else if (agg.maxWindKph >= th.wind_caution) {
    signals.push(makeSig("caution", "wind", `Windy (${Math.round(agg.maxWindKph)} kph)`, agg, recsWind(domain)));
  }

  // Rain / Mud
  const avgPerHour = agg.totalPrecipMm / Math.max(1, agg.hours);
  if (avgPerHour >= th.precip_mm_heavy || agg.popMax >= 80) {
    signals.push(makeSig("danger", "rain", `Heavy rain likely (avg ${avgPerHour.toFixed(1)} mm/h, POP ${Math.round(agg.popMax)}%)`, agg, recsRain(domain, true)));
    if (domain === "garden" || domain === "animals") {
      signals.push(makeSig("caution", "mud", `Mud risk after heavy rain`, agg, recsMud(domain)));
    }
  } else if (avgPerHour >= th.precip_mm_caution || agg.popMax >= th.pop_caution) {
    signals.push(makeSig("caution", "rain", `Rain possible (avg ${avgPerHour.toFixed(1)} mm/h, POP ${Math.round(agg.popMax)}%)`, agg, recsRain(domain, false)));
  }

  // UV
  if (agg.uvMax >= th.uv_high) {
    signals.push(makeSig("danger", "uv", `Very high UV (${agg.uvMax})`, agg, recsUV(domain)));
  } else if (agg.uvMax >= th.uv_caution) {
    signals.push(makeSig("caution", "uv", `High UV (${agg.uvMax})`, agg, recsUV(domain)));
  }

  // Humidity
  if (agg.rhMax >= th.humidity_high && agg.maxTempC >= th.heat_caution) {
    signals.push(makeSig("caution", "humidity", `Humid & hot (RH ${Math.round(agg.rhMax)}%)`, agg, recsHumidity(domain)));
  }

  // Lightning
  if (agg.lightningProbMax >= th.lightning_prob_high) {
    signals.push(makeSig("danger", "lightning", `Electrical storm risk (${Math.round(agg.lightningProbMax)}%)`, agg, recsLightning(domain)));
  } else if (agg.lightningProbMax >= th.lightning_prob_caution) {
    signals.push(makeSig("caution", "lightning", `Lightning possible (${Math.round(agg.lightningProbMax)}%)`, agg, recsLightning(domain)));
  }

  // Include time bounds on signals (window bounds)
  for (const s of signals) {
    s.fromISO = points[0]?.ts;
    s.toISO = points[points.length - 1]?.ts;
  }

  return signals;
}

function summarizeSignals(signals, domain) {
  if (!signals.length) return "No significant weather issues expected.";
  const worst = signals.reduce((a, b) => rank(b.severity) > rank(a.severity) ? b : a, signals[0]);
  const dangerCount = signals.filter(s => s.severity === "danger").length;
  const cautionCount = signals.filter(s => s.severity === "caution").length;
  const parts = [];
  if (dangerCount) parts.push(`${dangerCount} danger`);
  if (cautionCount) parts.push(`${cautionCount} caution`);
  const noun = parts.length ? parts.join(" & ") : `${signals.length} advisory`;
  return `${capitalize(domain)}: ${noun}${worst?.type ? ` (notably ${worst.type})` : ""}.`;
}

/* ------------------------------ Event wiring ------------------------------- */
function autoAnnotateIfOutdoor(data, domain) {
  const time = readWindowFrom(data);
  if (!time) return;
  // Heuristic: if explicit "outdoor" flag or domain implies outdoor (garden/animals)
  const isOutdoor = data?.outdoor === true || data?.meta?.outdoor === true || domain === "garden" || domain === "animals";
  if (!isOutdoor) return;
  getSignalsForWindow({ ...time, domain }).then((res) => {
    emit("weather/signalsReady", res);
    if (shouldToastFor(res.signals)) {
      emit(Events?.UI_TOAST || "ui/toast", {
        variant: "info",
        title: "Weather considerations",
        message: res.summary || "Upcoming weather may affect your plan.",
      });
    }
  }).catch(() => {});
}

function shouldToastFor(signals = []) {
  return signals.some(s => s.severity === "danger") || signals.length >= 2;
}

/* ------------------------------- Provider I/O ------------------------------ */
async function fetchForecastRangeSafe({ startISO, endISO, location, units }) {
  try {
    if (!provider?.getForecastRange) return { points: [], source: "none" };
    const fc = await provider.getForecastRange({
      lat: location.lat,
      lon: location.lon,
      startISO,
      endISO,
      units, // "metric" | "imperial"
    });
    // Defensive normalization
    const points = Array.isArray(fc?.points) ? fc.points.filter(p => isISO(p?.ts)) : [];
    return { points, source: fc?.source || "unknown" };
  } catch {
    return { points: [], source: "error" };
  }
}

/* ----------------------------- Hub mirroring ------------------------------- */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const pkt = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(pkt);
  } catch {/* fail-silent */}
}

/* --------------------------------- Helpers --------------------------------- */
function emit(type, data) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, { source: "weather.signals" });
}

function getThresholds() {
  const ff = featureFlags?.weather || {};
  return { ...DEFAULT_THRESHOLDS, ...ff.thresholds };
}
function thresholdsHash() {
  const t = getThresholds();
  return Object.values(t).map(v => String(v)).join(",");
}

function readWindowFrom(data) {
  const s = firstISO(data?.start, data?.time?.start, data?.window?.startISO, data?.startISO);
  const e = firstISO(data?.end, data?.time?.end, data?.window?.endISO, data?.endISO);
  if (!isISO(s) || !isISO(e)) return null;
  return { startISO: s, endISO: e };
}

function normalizeLocation(loc) {
  if (!loc || typeof loc !== "object") return null;
  const lat = Number(loc.lat), lon = Number(loc.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, tz: loc.tz, elevation: loc.elevation };
}

function makeSig(severity, type, label, agg, recs) {
  return {
    severity,
    type,
    label,
    recommendations: recs || [],
    metrics: {
      maxTempC: round(agg.maxTempC),
      minTempC: round(agg.minTempC),
      maxWindKph: round(agg.maxWindKph),
      maxGustKph: round(agg.maxGustKph),
      totalPrecipMm: round(agg.totalPrecipMm, 1),
      popMax: Math.round(agg.popMax),
      uvMax: Math.round(agg.uvMax),
      rhMax: Math.round(agg.rhMax),
      lightningProbMax: Math.round(agg.lightningProbMax),
    }
  };
}

function recsHeat(domain) {
  const base = ["Hydrate often", "Schedule earlier/later", "Provide shade/rest"];
  if (domain === "animals") base.push("Top off water troughs", "Avoid transport/handling mid-day");
  if (domain === "garden") base.push("Mulch & deep water morning", "Protect tender plants");
  if (domain === "cooking") base.push("Move grill to shade", "Shorten outdoor burners time");
  return base;
}
function recsCold(domain) {
  const base = ["Layer clothing", "Shorten exposure time"];
  if (domain === "animals") base.push("Check bedding", "Heat lamps (safely) for chicks");
  if (domain === "garden") base.push("Delay sowing warm-season crops");
  if (domain === "cooking") base.push("Pre-warm equipment", "Wind baffle for burners");
  return base;
}
function recsFrost(domain) {
  const base = ["Cover tender plants", "Drain hoses", "Bring containers inside"];
  if (domain === "animals") base.push("Wrap exposed pipes", "Heated buckets if possible");
  return base;
}
function recsFreeze(domain) {
  const base = ["Protect plumbing", "Avoid washing tasks outdoors"];
  if (domain === "animals") base.push("Check waterers for ice", "Increase calories in feed");
  if (domain === "garden") base.push("Harvest vulnerable produce before freeze");
  return base;
}
function recsWind(domain) {
  const base = ["Secure loose items", "Avoid ladder work"];
  if (domain === "cooking") base.push("Windbreak for flame", "Avoid high-heat searing outdoors");
  if (domain === "garden") base.push("Stake fragile plants", "Delay spraying (drift)");
  return base;
}
function recsRain(domain, heavy) {
  const base = heavy ? ["Expect runoff", "Avoid electrical tools outdoors"] : ["Have tarps ready"];
  if (domain === "garden") base.push(heavy ? "Delay tilling or harvest" : "Plan raised bed access");
  if (domain === "animals") base.push("Check shelter dryness", "Elevate feed");
  if (domain === "cooking") base.push("Move grill under cover", "Dry fuel storage");
  return base;
}
function recsMud(domain) {
  const base = ["Plan alternate paths", "Use boards/gravel on high-traffic areas"];
  if (domain === "animals") base.push("Bedding refresh", "Hoof health check");
  return base;
}
function recsUV() { return ["Sunscreen", "Hats & sleeves", "Schedule morning/late PM"]; }
function recsHumidity(domain) {
  const base = ["Reduce exertion", "Extra hydration"];
  if (domain === "cooking") base.push("Watch dehydration time (smoker/dehydrator)");
  return base;
}
function recsLightning(domain) {
  const base = ["Seek shelter", "Stop field work", "Avoid trees & metal equipment"];
  if (domain === "cooking") base.push("Do not grill during lightning nearby");
  return base;
}

/* -------------------------------- Small utils ------------------------------ */
function isISO(s) { return typeof s === "string" && !Number.isNaN(Date.parse(s)); }
function firstISO(...vals) { return vals.find(isISO) || null; }
function num(n) { return Number.isFinite(n) ? n : 0; }
function safe(n) { return Number.isFinite(n) ? n : 0; }
function round(n, d = 0) { const p = Math.pow(10, d); return Math.round(n * p) / p; }
function rank(sev) { return sev === "danger" ? 3 : sev === "caution" ? 2 : 1; }
function capitalize(s) { return String(s || "").replace(/^\w/, c => c.toUpperCase()); }
function fmtTemp(c, units) {
  if (units === "imperial") {
    const f = c * 9/5 + 32;
    return `${Math.round(f)}°F`;
  }
  return `${Math.round(c)}°C`;
}
function truncateIsoToHour(iso) {
  const d = new Date(iso);
  d.setUTCMinutes(0,0,0);
  return d.toISOString();
}

/* --------------------------------- Exports --------------------------------- */
export default {
  initWeatherSignals,
  getSignalsForWindow,
};
