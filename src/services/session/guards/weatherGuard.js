/* eslint-disable no-console */
// weatherGuard.js — Domain-aware weather guard (e.g., skip watering if rain forecast, delay spray on high wind)
// Plays nicely with RelativeScheduler + NBA by emitting planner.conflict.detected (kind: "weather") w/ 'until' windows.

(function () {
  // ------------------------------ Defensive deps ------------------------------
  const isBrowser = typeof window !== "undefined";
  const now = () => Date.now();

  let eventBus = { on(){}, off(){}, emit(){} };
  try {
    const eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  // Optional helpers: provides withholdsForDomain(domain) that's consumed elsewhere
  let scheduleHelpers = null;
  try { scheduleHelpers = require("@/services/scheduleHelpers"); } catch (_e) {}

  // Optional runtime for toasts/banners
  let automation = null;
  try { automation = (require("@/services/automation/runtime") || {}).automation || null; } catch (_e) {}

  // Optional Relative Scheduler to pause anchors when weather blocks a step
  let relativeScheduler = null;
  try { relativeScheduler = (require("@/services/session/RelativeScheduler") || {}).relativeScheduler || null; } catch (_e) {}

  // Optional weather client: prefer your internal client if present
  // Expected shape:
  //   await weatherClient.getForecast({ lat, lon, units, horizonHours }) -> { hourly:[{ts, pop, rainMm, windKph, gustKph, tempC, rh, uv, ...}], daily:[...], updatedAt }
  let weatherClient = null;
  try { weatherClient = (require("@/services/weather/weatherClient") || {}).weatherClient || null; } catch (_e) {}

  // ------------------------------ Storage utils -------------------------------
  const K = {
    PREFS: "suka:weatherGuard:prefs:v1",
    CACHE: "suka:weatherGuard:cache:v1", // { coords:{lat,lon}, forecast, at }
  };
  const safeJSON = {
    parse: (s, f = null) => { try { return JSON.parse(s); } catch { return f; } },
    stringify: (o) => { try { return JSON.stringify(o); } catch { return "{}"; } },
  };
  const load = (key, fallback) => isBrowser ? (safeJSON.parse(localStorage.getItem(key), fallback)) : fallback;
  const save = (key, val) => { if (isBrowser) localStorage.setItem(key, safeJSON.stringify(val)); };

  // ------------------------------ Preferences / Defaults ----------------------
  // Tuned for common household/garden tasks. All thresholds are user-tweakable via setPrefs().
  const DEFAULTS = {
    enabled: true,
    units: "metric", // or "imperial"
    // Where to get weather: "client" uses @/services/weather/weatherClient, "cache" uses last saved
    source: "client",
    // If location is unknown, optionally use last known cache (safe)
    allowCacheFallback: true,

    // Decision thresholds:
    thresholds: {
      // Watering is wasteful if decent rain is likely soon; POP/precip windows define "soon"
      watering: {
        lookAheadHours: 12,         // see next half day
        minPopPct: 40,              // probability-of-precip (%) to decide skip
        minExpectedMm: 3,           // if expected precip >= X mm (or ~0.12 in), skip watering
      },
      spraying: {
        lookAheadHours: 6,
        maxWindKph: 20,             // ~12 mph, above this drift risk is high
        maxGustKph: 30,
        maxUvIndex: 7,              // avoid spraying in strong sun/UV (leaf burn)
        minDryHoursBefore: 1,       // require at least 1h dry before
        minDryHoursAfter: 2,        // require at least 2h dry after
      },
      transplanting: {
        lookAheadHours: 24,
        maxHeatIndexC: 32,          // avoid high heat stress days
        frostRisk: true,            // block if frost advisory or forecast temp < 1°C/34°F
      },
      mowing: {
        lookAheadHours: 6,
        recentRainHours: 3,         // if it rained in last 3h, grass likely wet → delay
        maxWindKph: 35,             // safety for debris/wind
      }
    },

    // NBA suggestion messages (per action)
    messages: {
      wateringSkip: "Rain is likely soon. Skipping watering saves water and prevents overwatering.",
      sprayingDelay: "Winds or UV are high. Delay spraying to avoid drift or leaf burn.",
      transplantingDelay: "Frost/heat risk detected. Shift transplanting to a safer window.",
      mowingDelay: "Recent rain or high winds. Delay mowing until conditions improve.",
    },

    // How often to refresh forecast (ms)
    refreshMs: 30 * 60 * 1000, // 30m

    // Domain mapping (action kinds that weatherGuard evaluates)
    domainMap: {
      garden: ["watering", "spraying", "transplanting", "mowing"],
      // animals/cleaning/meals not gated by weather here, but can be added later
    }
  };

  let prefs = Object.assign({}, DEFAULTS, load(K.PREFS, {}));
  const setPrefs = (patch) => {
    prefs = Object.assign({}, prefs, patch || {});
    save(K.PREFS, prefs);
    eventBus.emit("weather.guard.prefs.updated", { prefs });
  };

  // ------------------------------ Forecast cache ------------------------------
  let cache = load(K.CACHE, { coords: null, forecast: null, at: 0 });

  function setCache(next) {
    cache = next;
    save(K.CACHE, cache);
    eventBus.emit("weather.forecast.cached", { at: cache.at, coords: cache.coords });
  }

  // ------------------------------ Utility: Units ------------------------------
  function mmToIn(mm) { return mm / 25.4; }
  function kphToMph(k) { return k * 0.621371; }
  function cToF(c) { return c * 9/5 + 32; }

  // ------------------------------ Utility: Forecast windows -------------------
  function sliceHourly(forecast, lookAheadHours, fromTs = now()) {
    if (!forecast?.hourly?.length) return [];
    const until = fromTs + lookAheadHours * 3600000;
    return forecast.hourly.filter(h => h.ts >= fromTs && h.ts <= until);
  }
  function sumExpectedRainMm(hours) {
    return (hours || []).reduce((acc, h) => acc + (h.rainMm || 0), 0);
  }
  function maxValue(hours, field) {
    return (hours || []).reduce((acc, h) => Math.max(acc, +((h[field] ?? 0))), 0);
  }
  function anyPopAtLeast(hours, pct) {
    return (hours || []).some(h => (h.pop || 0) * 100 >= pct);
  }
  function hoursWithRain(hours) {
    return (hours || []).filter(h => (h.rainMm || 0) > 0);
  }
  function findNextDryWindow(forecast, startTs, durationHours) {
    // naive: find a contiguous block of 'durationHours' with zero rainMm
    if (!forecast?.hourly?.length) return null;
    const sorted = forecast.hourly.filter(h => h.ts >= startTs).sort((a,b) => a.ts - b.ts);
    const need = durationHours;
    let run = 0;
    let start = null;
    for (let i = 0; i < sorted.length; i++) {
      if ((sorted[i].rainMm || 0) === 0) {
        run += 1;
        if (start === null) start = sorted[i].ts;
        if (run >= need) return { startAt: start, endAt: start + durationHours*3600000 };
      } else {
        run = 0; start = null;
      }
    }
    return null;
  }

  // ------------------------------ Weather fetch -------------------------------
  async function getForecast(options = {}) {
    // options: { coords:{lat,lon}, horizonHours }
    const { coords, horizonHours = 48 } = options;
    const ts = now();

    // Fresh enough cache?
    if (cache.forecast && (ts - cache.at) < prefs.refreshMs) {
      return cache.forecast;
    }

    // Try preferred client
    if (prefs.source === "client" && weatherClient && typeof weatherClient.getForecast === "function" && coords) {
      try {
        const fc = await weatherClient.getForecast({ ...coords, units: prefs.units, horizonHours });
        if (fc?.hourly?.length) {
          setCache({ coords, forecast: fc, at: ts });
          eventBus.emit("weather.forecast.updated", { at: ts, coords });
          return fc;
        }
      } catch (e) { console.warn("[weatherGuard] client.getForecast failed:", e); }
    }

    // Fallback to cache if allowed
    if (prefs.allowCacheFallback && cache.forecast) return cache.forecast;

    // Last resort: minimal fake (clear & calm), prevents hard failures
    const fallback = {
      updatedAt: ts,
      hourly: Array.from({ length: horizonHours }).map((_, i) => ({
        ts: ts + i * 3600000,
        pop: 0,
        rainMm: 0,
        windKph: 8,
        gustKph: 12,
        tempC: 20,
        uv: 3,
      })),
      daily: [],
    };
    setCache({ coords: coords || cache.coords, forecast: fallback, at: ts });
    return fallback;
  }

  // ------------------------------ Rules (by action) ---------------------------
  function evaluateWatering(forecast, fromTs = now()) {
    const th = prefs.thresholds.watering;
    const hours = sliceHourly(forecast, th.lookAheadHours, fromTs);
    const expectedMm = sumExpectedRainMm(hours);
    const rainLikely = anyPopAtLeast(hours, th.minPopPct);
    if (rainLikely || expectedMm >= th.minExpectedMm) {
      // propose next dry window AFTER the rain finishes (2h dry window to allow infiltration)
      const dry = findNextDryWindow(forecast, fromTs + 2*3600000, 2) || null;
      const until = dry ? dry.startAt : (hours.length ? hours[hours.length - 1].ts + 2*3600000 : fromTs + 6*3600000);
      return {
        allow: false,
        reason: "rain-likely",
        until,
        message: prefs.messages.wateringSkip,
        details: { expectedMm, minPopPct: th.minPopPct },
      };
    }
    return { allow: true };
  }

  function evaluateSpraying(forecast, fromTs = now()) {
    const th = prefs.thresholds.spraying;
    const hours = sliceHourly(forecast, th.lookAheadHours, fromTs);
    const windy = maxValue(hours, "windKph") > th.maxWindKph || maxValue(hours, "gustKph") > th.maxGustKph;
    const tooSunny = maxValue(hours, "uv") >= th.maxUvIndex;
    const beforeWet = hoursWithRain(sliceHourly(forecast, th.minDryHoursBefore, fromTs)).length > 0;
    const afterWet = hoursWithRain(sliceHourly(forecast, th.minDryHoursAfter, fromTs + 1)).length > 0;
    if (windy || tooSunny || beforeWet || afterWet) {
      // find earliest 2h calm window (low wind + no rain + UV below threshold)
      const horizon = sliceHourly(forecast, th.lookAheadHours + 12, fromTs);
      let slot = null;
      for (let i = 0; i < horizon.length - 1; i++) {
        const a = horizon[i], b = horizon[i+1];
        const calm = (a.windKph < th.maxWindKph && a.gustKph < th.maxGustKph && a.uv < th.maxUvIndex && a.rainMm === 0)
                  && (b.windKph < th.maxWindKph && b.gustKph < th.maxGustKph && b.uv < th.maxUvIndex && b.rainMm === 0);
        if (calm) { slot = { startAt: a.ts, endAt: b.ts + 3600000 }; break; }
      }
      const until = slot ? slot.startAt : (fromTs + 6*3600000);
      return { allow: false, reason: "wind/uv/wet", until, message: prefs.messages.sprayingDelay };
    }
    return { allow: true };
   }

  function evaluateTransplanting(forecast, fromTs = now()) {
    const th = prefs.thresholds.transplanting;
    const hours = sliceHourly(forecast, th.lookAheadHours, fromTs);
    const maxHeatC = maxValue(hours, "tempC");
    const frostRisk = hours.some(h => (h.tempC ?? 5) < 1);
    if ((th.frostRisk && frostRisk) || maxHeatC >= th.maxHeatIndexC) {
      // choose morning window tomorrow as safer
      const start = fromTs + 24*3600000; // +1 day
      const morning = new Date(start); morning.setHours(8,0,0,0);
      return { allow: false, reason: "frost/heat", until: morning.getTime(), message: prefs.messages.transplantingDelay };
    }
    return { allow: true };
  }

  function evaluateMowing(forecast, fromTs = now()) {
    const th = prefs.thresholds.mowing;
    const hours = sliceHourly(forecast, th.lookAheadHours, fromTs);
    const recentHours = sliceHourly(forecast, th.recentRainHours, fromTs - th.recentRainHours*3600000);
    const wetRecently = sumExpectedRainMm(recentHours) > 0;
    const windy = maxValue(hours, "windKph") > th.maxWindKph;
    if (wetRecently || windy) {
      const dry = findNextDryWindow(forecast, fromTs + 1*3600000, 2);
      const until = dry ? dry.startAt : fromTs + 3*3600000;
      return { allow: false, reason: wetRecently ? "wet" : "wind", until, message: prefs.messages.mowingDelay };
    }
    return { allow: true };
  }

  const evaluators = {
    watering: evaluateWatering,
    spraying: evaluateSpraying,
    transplanting: evaluateTransplanting,
    mowing: evaluateMowing,
  };

  // ------------------------------ Core guard ----------------------------------
  async function guardAction(action = {}, forecast, coords) {
    // action: { domain, kind, at?, anchorId?, sessionId?, payload? }
    // Only evaluate configured domain/kinds
    const allowedKinds = prefs.domainMap[action.domain || ""] || [];
    if (!allowedKinds.includes(action.kind)) {
      return { allow: true, reason: null };
    }

    const fromTs = action.at || now();
    let fc = forecast;
    if (!fc) {
      fc = await getForecast({ coords, horizonHours: 48 });
    }

    const fn = evaluators[action.kind];
    if (!fn) return { allow: true };
    const verdict = fn(fc, fromTs);
    return verdict;
  }

  // ------------------------------ Event wiring --------------------------------
  // We treat any "garden" action request or schedule creation as an opportunity to pre-check weather.
  async function handleActionRequested(e = {}) {
    // e: { domain, kind, sessionId?, anchorId?, at?, payload?, coords? }
    if (!prefs.enabled) return;
    const verdict = await guardAction(
      { domain: e.domain, kind: e.kind, at: e.at, anchorId: e.anchorId, sessionId: e.sessionId, payload: e.payload },
      null,
      e.coords || cache.coords || null
    );

    if (!verdict.allow) {
      // Emit a domain-aware withhold conflict; RelativeScheduler (and others) already listen for this
      eventBus.emit("planner.conflict.detected", {
        kind: "weather",
        domain: e.domain || "garden",
        until: verdict.until || null,
        source: "weatherGuard",
        item: {
          anchorId: e.anchorId || null,
          sessionId: e.sessionId || null,
          title: e.kind,
          kind: "guard",
          payload: Object.assign({}, e.payload || {}, { reason: verdict.reason }),
        },
      });

      // Pause the related anchor if we have one, so suspendable steps freeze
      if (relativeScheduler && e.anchorId) {
        try { relativeScheduler.pauseAnchor(e.anchorId); } catch (_e) {}
      }

      // Notify politely + ask NBA for a suggestion (e.g., "shift watering to tomorrow morning")
      if (automation?.notify) {
        automation.notify({
          title: `Delayed: ${e.kind}`,
          message: verdict.message || "Weather suggests delaying this task.",
          scope: "local",
          severity: "info",
          ts: now(),
          tags: ["weather", e.domain || "garden"],
        });
      }
      eventBus.emit("nba.suggestion.requested", {
        context: "weather",
        reasons: [verdict.reason || "weather"],
        item: { domain: e.domain, kind: e.kind, until: verdict.until || null },
      });
    }
  }

  // When a relative schedule is created (e.g., garden session), scan the items and pre-mark withholds
  async function handleScheduleCreated(e = {}) {
    // e: { anchorId, sessionId, domain, items:[{id,title,dueAt, ...}] }
    if (!prefs.enabled || (e.domain !== "garden")) return;
    const coords = cache.coords;
    const fc = await getForecast({ coords, horizonHours: 48 });
    const ts = now();

    for (const item of (e.items || [])) {
      // Try to infer action kind from title/payload (very light heuristic); callers can pass item.payload.kind for precision
      const kind = (item.kind || item.title || "").toLowerCase().includes("water") ? "watering"
                : (item.kind || item.title || "").toLowerCase().includes("spray") ? "spraying"
                : null;
      if (!kind) continue;

      const verdict = await guardAction(
        { domain: e.domain, kind, at: item.dueAt || ts, anchorId: e.anchorId, sessionId: e.sessionId, payload: { itemId: item.id } },
        fc,
        coords
      );
      if (!verdict.allow) {
        // Pre-flag conflict
        eventBus.emit("planner.conflict.detected", {
          kind: "weather",
          domain: e.domain || "garden",
          until: verdict.until || null,
          source: "weatherGuard",
          item: { anchorId: e.anchorId, sessionId: e.sessionId, title: item.title, kind: "guard", payload: { itemId: item.id, reason: verdict.reason } },
        });
      }
    }
  }

  // ------------------------------ Public API ----------------------------------
  const weatherGuard = {
    init(userPrefs = {}) {
      setPrefs(userPrefs);

      // Public action channel — use this from GardenQueueManager, Procedure cards, etc.
      // Example usage:
      //   eventBus.emit("garden.action.requested", { domain:"garden", kind:"watering", sessionId, anchorId, at: Date.now(), coords:{lat,lon} })
      eventBus.on("garden.action.requested", handleActionRequested);

      // Integrate with RelativeScheduler flow — pre-scan schedule items for garden sessions
      eventBus.on("relative.schedule.created", handleScheduleCreated);

      // Allow UI to push current coordinates (from settings or geolocation)
      eventBus.on("weather.coords.set", (e = {}) => {
        // e: { lat, lon }
        if (e.lat && e.lon) {
          setCache({ coords: { lat: e.lat, lon: e.lon }, forecast: cache.forecast, at: cache.at || 0 });
        }
      });

      // Manual refresh
      eventBus.on("weather.refresh.requested", async (e = {}) => {
        const coords = e.coords || cache.coords || null;
        await getForecast({ coords, horizonHours: e.horizonHours || 48 });
      });

      // HUD ask
      eventBus.on("weather.guard.status.requested", () => {
        eventBus.emit("weather.guard.status", { enabled: prefs.enabled, coords: cache.coords, cachedAt: cache.at });
      });

      // Example: simple “skip watering” hook whenever a watering modal tries to open
      eventBus.on("ui.modal.open", async (m = {}) => {
        if (!prefs.enabled) return;
        if ((m.domain === "garden") && /water/i.test(m.title || m.id || "")) {
          const verdict = await guardAction({ domain: "garden", kind: "watering", at: now() }, null, cache.coords || null);
          if (!verdict.allow) {
            // Convert modal to notify and queue a suggestion
            eventBus.emit("ui.modal.converted", {
              type: "toast",
              cancelOriginal: true,
              payload: {
                title: "Watering delayed",
                message: prefs.messages.wateringSkip,
                runAt: verdict.until || null,
                actions: [{ id: "viewForecast", label: "View forecast", kind: "view" }],
              },
            });
            eventBus.emit("nba.suggestion.requested", {
              context: "weather",
              reasons: [verdict.reason || "rain-likely"],
              item: { domain: "garden", kind: "watering", until: verdict.until || null },
            });
          }
        }
      });

      // Periodic refresh while app is open
      if (isBrowser && prefs.refreshMs > 0) {
        setInterval(() => {
          if (!prefs.enabled) return;
          getForecast({ coords: cache.coords || null, horizonHours: 48 }).catch(()=>{});
        }, Math.max(10 * 60 * 1000, prefs.refreshMs)); // not less than 10m
      }
    },

    async guard(action = {}, opts = {}) {
      // Imperative API for direct callers
      const fc = await getForecast({ coords: opts.coords || cache.coords || null, horizonHours: opts.horizonHours || 48 });
      return guardAction(action, fc, opts.coords || cache.coords || null);
    },

    async getForecast(opts = {}) { return getForecast(opts); },

    // Preferences
    getPrefs() { return Object.assign({}, prefs); },
    setPrefs,

    // Cache
    getCache() { return Object.assign({}, cache); },
    setCoords(coords) { setCache({ coords, forecast: cache.forecast, at: cache.at }); },
  };

  // ------------------------------ Export --------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { weatherGuard };
  } else {
    // @ts-ignore
    window.weatherGuard = weatherGuard;
  }

  // ------------------------------ Autoinit ------------------------------------
  weatherGuard.init();
})();
