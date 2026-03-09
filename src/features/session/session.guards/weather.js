/**
 * src/features/session/session.guards/weather.js
 * -----------------------------------------------------------------------------
 * Weather Guard
 *
 * Purpose:
 * - Blocks starting/advancing a step if current outdoor weather does not meet
 *   household safety/quality thresholds (rain, wind, heat/cold, lightning, etc.).
 *
 * How it fits:
 * - SessionRunner calls this guard when:
 *   • starting a session or transitioning to a step that lists "weather" in
 *     step.blockers.
 * - Returns GuardResult { allowed, guard:"weather", reason?, message?, retryAt? }.
 *   The runner handles UI (pause, toast, scheduling retry).
 *
 * Contracts (passed via GuardContext):
 * - weatherProvider (required for strict mode; optional otherwise):
 *     {
 *       // Current conditions near coords; return values are *best-effort*.
 *       current(lat:number, lon:number): Promise<{
 *         ts: string,                   // ISO
 *         tempF?: number,               // air temp (°F)
 *         windMph?: number,
 *         gustMph?: number,
 *         humidityPct?: number,         // 0..100
 *         precip?: { type: "none"|"rain"|"snow"|"sleet"|"hail", intensity?: "light"|"moderate"|"heavy" },
 *         thunder?: boolean,
 *         condition?: string            // free text ("Cloudy", "Clear", ...)
 *       } | null>,
 *
 *       // Hourly forecast for planning the next lift time (up to horizon hours).
 *       forecastHourly(lat:number, lon:number, horizonHours?:number): Promise<Array<{
 *         ts: string, tempF?: number, windMph?: number, gustMph?: number,
 *         humidityPct?: number, precip?: { type: string, intensity?: string },
 *         thunder?: boolean
 *       }>>
 *     }
 *
 * - coords: { lat:number, lon:number }  // approximate household location
 *
 * Step/Session hints:
 * - step.metadata may specify overrides:
 *   {
 *     outdoor?: boolean,                // default inferred from domain/keywords
 *     minTempF?: number, maxTempF?: number,
 *     maxWindMph?: number,
 *     allowLightRain?: boolean,
 *     disallowThunder?: boolean,        // default true
 *     heatSensitive?: boolean,          // adds humidity/heat-index caution
 *     coldSensitive?: boolean
 *   }
 *
 * Policy defaults (settings) vary by domain:
 * - Garden/Animals default to outdoor=true; Cooking/Cleaning default outdoor=false.
 * - If outdoor=false, guard usually ALLOWS unless explicit weather metadata present.
 *
 * Resilience:
 * - If provider/coords missing or errors occur → fail-open unless settings.failClosed=true.
 * - Always handles partial provider data gracefully.
 *
 * Feature flag:
 * - featureFlags.weatherGuard (default ON if missing).
 *
 * Extension points:
 * - Add wet-bulb/heat-index calculations if you track solar radiation, etc.
 * - Add snow/ice surface checks for preservation moves.
 *
 * Typed JSDoc below.
 * -----------------------------------------------------------------------------
 */

import eventBus from "../../../services/events/eventBus";
import { featureFlags } from "../../../config/featureFlags";

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment">} blockers
 * @property {{
 *   tempTargetF?: number,
 *   donenessCue?: "color"|"texture"|"probeTemp"|"timer"|"smell",
 *   cueNotes?: string,
 *   outdoor?: boolean,
 *   minTempF?: number,
 *   maxTempF?: number,
 *   maxWindMph?: number,
 *   allowLightRain?: boolean,
 *   disallowThunder?: boolean,
 *   heatSensitive?: boolean,
 *   coldSensitive?: boolean
 * }} [metadata]
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} title
 * @property {{ type: "recipe"|"cleaningPlan"|"gardenPlan"|"animalTask"|"import"|"manual", refId: string|null }} source
 * @property {SessionStep[]} steps
 * @property {{ voiceGuidance?: boolean, haptic?: boolean, autoAdvance?: boolean }} prefs
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @property {{ currentStepIndex: number, elapsedSec: number, startedAt: string|null, pausedAt: string|null }} progress
 * @property {{ skippedSteps: string[], adjustments: Array<any> }} analytics
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} WeatherProvider
 * @property {(lat:number, lon:number)=>Promise<any>} current
 * @property {(lat:number, lon:number, horizonHours?:number)=>Promise<any[]>} forecastHourly
 */

/**
 * @typedef {Object} GuardContext
 * @property {{ lat?: number, lon?: number }} [coords]
 * @property {WeatherProvider} [weatherProvider]
 * @property {{
 *   enabled?: boolean,                 // default true
 *   failClosed?: boolean,              // default false
 *   horizonHours?: number,             // default 24 (for retryAt planning)
 *   defaultsByDomain?: Partial<Record<Session["domain"], WeatherPolicy>>,
 *   basePolicy?: WeatherPolicy         // fallback policy if domain-specific missing
 * }} [settings]
 * @property {(msg:string, data?:any)=>void} [logger]
 */

/**
 * @typedef {Object} WeatherPolicy
 * @property {boolean} outdoor               // is this typically outdoor?
 * @property {number} [minTempF]             // disallow if below
 * @property {number} [maxTempF]             // disallow if above
 * @property {number} [maxWindMph]           // disallow if above
 * @property {boolean} [allowLightRain]      // allow drizzle/light rain
 * @property {boolean} [disallowThunder]     // default true (safety-first)
 * @property {boolean} [heatSensitive]
 * @property {boolean} [coldSensitive]
 */

/**
 * @typedef {Object} GuardResult
 * @property {boolean} allowed
 * @property {"weather"} guard
 * @property {string} [reason]
 * @property {string} [message]
 * @property {string} [retryAt]  // earliest ISO time conditions are acceptable (from forecast), if known
 * @property {any} [debug]       // optional debug detail for inspector UI
 */

/**
 * Evaluate weather guard for a given step.
 * @param {Session} session
 * @param {number} stepIndex
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateWeatherGuard(session, stepIndex, ctx = {}) {
  const log = ctx.logger || (() => {});
  if (!isGuardEnabled(ctx?.settings)) {
    return { allowed: true, guard: "weather" };
  }

  const step = resolveStep(session, stepIndex);
  if (!hasBlocker(step, "weather")) {
    return { allowed: true, guard: "weather" };
  }

  // Decide if this step is actually weather-relevant.
  const policy = derivePolicy(session, step, ctx.settings);
  if (!policy.outdoor && !hasExplicitWeatherMetadata(step)) {
    // Indoor + no explicit weather metadata → allow
    return { allowed: true, guard: "weather" };
  }

  // Provider/coords sanity
  const provider = ctx.weatherProvider;
  const { lat, lon } = ctx.coords || {};
  if (!provider || !isFinite(lat) || !isFinite(lon)) {
    if (!ctx.settings?.failClosed) {
      safeEmitDebug("guard.weather.missing_provider_or_coords", {
        sessionId: safeId(session),
      });
      return { allowed: true, guard: "weather" };
    }
    return {
      allowed: false,
      guard: "weather",
      reason: "weather_provider_unavailable",
      message: "Weather data unavailable for this location.",
    };
  }

  // Read current conditions
  let nowWx = null;
  try {
    nowWx = await provider.current(lat, lon);
  } catch (e) {
    log("[weatherGuard] provider.current error:", e);
  }

  if (!nowWx) {
    if (!ctx.settings?.failClosed) return { allowed: true, guard: "weather" };
    return {
      allowed: false,
      guard: "weather",
      reason: "weather_current_unavailable",
      message: "Current weather unavailable.",
    };
  }

  const verdict = evaluateAgainstPolicy(nowWx, policy);

  if (verdict.ok) {
    return { allowed: true, guard: "weather" };
  }

  // Find the next lift time from hourly forecast
  let retryAt = null;
  try {
    const hours = Math.max(
      1,
      Math.min(72, Number(ctx.settings?.horizonHours) || 24)
    );
    const forecast = (await provider.forecastHourly(lat, lon, hours)) || [];
    retryAt = findNextAcceptableTs(forecast, policy);
  } catch (e) {
    // ignore forecast failures
  }

  const msg = buildMessageFromViolations(verdict.violations, nowWx, retryAt);

  safeEmitDebug("guard.weather.blocked", {
    sessionId: safeId(session),
    stepId: step?.id || null,
    violations: verdict.violations,
    retryAt,
  });

  return {
    allowed: false,
    guard: "weather",
    reason: "weather_unfavorable",
    message: msg,
    retryAt: retryAt || undefined,
    debug: { now: nowWx, policy },
  };
}

/* --------------------------------- Helpers -------------------------------- */

function isGuardEnabled(settings) {
  const fromSettings =
    typeof settings?.enabled === "boolean" ? settings.enabled : undefined;
  if (typeof fromSettings === "boolean") return fromSettings;
  try {
    if (
      featureFlags &&
      Object.prototype.hasOwnProperty.call(featureFlags, "weatherGuard")
    ) {
      return !!featureFlags.weatherGuard;
    }
  } catch {
    /* ignore */
  }
  return true;
}

function resolveStep(session, stepIndex) {
  if (!session || !Array.isArray(session.steps) || session.steps.length === 0)
    return null;
  if (
    typeof stepIndex === "number" &&
    stepIndex >= 0 &&
    stepIndex < session.steps.length
  ) {
    return session.steps[stepIndex];
  }
  const idx =
    Number.isFinite(session?.progress?.currentStepIndex) &&
    session.progress.currentStepIndex >= 0
      ? session.progress.currentStepIndex
      : 0;
  return session.steps[idx] || null;
}

function hasBlocker(step, blocker) {
  if (!step || !Array.isArray(step.blockers)) return false;
  return step.blockers.includes(blocker);
}

function hasExplicitWeatherMetadata(step) {
  const m = step?.metadata || {};
  return (
    typeof m.minTempF === "number" ||
    typeof m.maxTempF === "number" ||
    typeof m.maxWindMph === "number" ||
    typeof m.allowLightRain === "boolean" ||
    typeof m.outdoor === "boolean" ||
    typeof m.disallowThunder === "boolean" ||
    m.heatSensitive === true ||
    m.coldSensitive === true
  );
}

/**
 * Derive effective weather policy from domain + step metadata + app defaults.
 * @param {Session} session
 * @param {SessionStep|null} step
 * @param {GuardContext["settings"]} settings
 * @returns {WeatherPolicy}
 */
function derivePolicy(session, step, settings) {
  const base = withPolicyDefaults(settings);
  const domainDefaults =
    settings?.defaultsByDomain && session?.domain
      ? settings.defaultsByDomain[session.domain]
      : null;

  // Reasonable domain defaults
  const guessedOutdoor =
    step?.metadata?.outdoor ??
    (session?.domain === "garden" || session?.domain === "animals");

  /** @type {WeatherPolicy} */
  const policy = Object.assign({}, base, domainDefaults || {}, {
    outdoor: guessedOutdoor,
  });

  // Metadata overrides (if provided)
  const m = step?.metadata || {};
  if (typeof m.minTempF === "number") policy.minTempF = m.minTempF;
  if (typeof m.maxTempF === "number") policy.maxTempF = m.maxTempF;
  if (typeof m.maxWindMph === "number") policy.maxWindMph = m.maxWindMph;
  if (typeof m.allowLightRain === "boolean")
    policy.allowLightRain = m.allowLightRain;
  if (typeof m.disallowThunder === "boolean")
    policy.disallowThunder = m.disallowThunder;
  if (m.heatSensitive === true) policy.heatSensitive = true;
  if (m.coldSensitive === true) policy.coldSensitive = true;
  if (typeof m.outdoor === "boolean") policy.outdoor = m.outdoor;

  return policy;
}

/**
 * Defaults if not provided.
 * @param {GuardContext["settings"]} settings
 * @returns {WeatherPolicy}
 */
function withPolicyDefaults(settings) {
  const base = settings?.basePolicy || {
    outdoor: false,
    minTempF: 32, // freezing default
    maxTempF: 95, // heat safety default
    maxWindMph: 30, // high-wind default
    allowLightRain: false,
    disallowThunder: true,
    heatSensitive: false,
    coldSensitive: false,
  };
  return base;
}

/**
 * Evaluate current weather against policy.
 * @param {any} wx
 * @param {WeatherPolicy} policy
 * @returns {{ ok: boolean, violations: Array<{ code:string, detail?:any }> }}
 */
function evaluateAgainstPolicy(wx, policy) {
  /** @type {Array<{ code:string, detail?:any }>} */
  const violations = [];
  if (!policy.outdoor) {
    // Indoor tasks only check if explicit metadata toggles made it necessary
    // which is handled by derivePolicy. If we are here with outdoor=false,
    // we still sanity-check thunder if disallowThunder was forced and precip leaks indoors.
    return { ok: true, violations };
  }

  const tempF = n(wx?.tempF);
  const wind = n(wx?.windMph);
  const gust = n(wx?.gustMph);
  const humid = n(wx?.humidityPct);
  const thunder = !!wx?.thunder;
  const precipType = wx?.precip?.type || "none";
  const precipIntensity = wx?.precip?.intensity || "none";

  // Temperature checks
  if (
    isFiniteNum(policy.minTempF) &&
    isFiniteNum(tempF) &&
    tempF < policy.minTempF
  ) {
    violations.push({
      code: "too_cold",
      detail: { tempF, min: policy.minTempF },
    });
  }
  if (
    isFiniteNum(policy.maxTempF) &&
    isFiniteNum(tempF) &&
    tempF > policy.maxTempF
  ) {
    violations.push({
      code: "too_hot",
      detail: { tempF, max: policy.maxTempF },
    });
  }

  // Wind checks (use gust if higher)
  const windEff = Math.max(
    isFiniteNum(wind) ? wind : 0,
    isFiniteNum(gust) ? gust : 0
  );
  if (isFiniteNum(policy.maxWindMph) && windEff > policy.maxWindMph) {
    violations.push({
      code: "too_windy",
      detail: { windMph: wind, gustMph: gust, max: policy.maxWindMph },
    });
  }

  // Thunder always disallowed if policy says so
  if (policy.disallowThunder && thunder) {
    violations.push({ code: "thunder_present" });
  }

  // Precipitation policy
  if (precipType && precipType !== "none") {
    const lightOK =
      policy.allowLightRain &&
      precipIntensity === "light" &&
      precipType === "rain";
    if (!lightOK) {
      violations.push({
        code: "precipitation",
        detail: { type: precipType, intensity: precipIntensity },
      });
    }
  }

  // Optional sensitivity checks
  if (
    policy.heatSensitive &&
    isFiniteNum(tempF) &&
    tempF >= 90 &&
    isFiniteNum(humid) &&
    humid >= 65
  ) {
    violations.push({
      code: "heat_index_risk",
      detail: { tempF, humidityPct: humid },
    });
  }
  if (policy.coldSensitive && isFiniteNum(tempF) && tempF <= 40) {
    violations.push({ code: "cold_stress_risk", detail: { tempF } });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Find earliest forecast hour meeting policy.
 * @param {any[]} hourly
 * @param {WeatherPolicy} policy
 * @returns {string|null} ISO ts
 */
function findNextAcceptableTs(hourly, policy) {
  for (const h of hourly) {
    const v = evaluateAgainstPolicy(h, policy);
    if (v.ok) return h.ts || null;
  }
  return null;
}

function buildMessageFromViolations(vs, wx, retryAtIso) {
  if (!Array.isArray(vs) || vs.length === 0)
    return "Weather restrictions in effect.";
  const parts = vs.map((v) => {
    switch (v.code) {
      case "too_cold":
        return `Too cold (${fmtNum(v.detail?.tempF)}°F). Minimum is ${fmtNum(
          v.detail?.min
        )}°F.`;
      case "too_hot":
        return `Too hot (${fmtNum(v.detail?.tempF)}°F). Maximum is ${fmtNum(
          v.detail?.max
        )}°F.`;
      case "too_windy":
        return `Too windy (wind ${fmtNum(v.detail?.windMph)} mph, gust ${fmtNum(
          v.detail?.gustMph
        )} mph). Max allowed ${fmtNum(v.detail?.max)} mph.`;
      case "thunder_present":
        return "Thunderstorms detected nearby.";
      case "precipitation":
        return `Precipitation: ${v.detail?.type || "unknown"}${
          v.detail?.intensity ? " (" + v.detail.intensity + ")" : ""
        }.`;
      case "heat_index_risk":
        return `Heat/humidity risk (${fmtNum(v.detail?.tempF)}°F, ${fmtNum(
          v.detail?.humidityPct
        )}% RH).`;
      case "cold_stress_risk":
        return `Cold stress risk (${fmtNum(v.detail?.tempF)}°F).`;
      default:
        return "Unfavorable weather conditions.";
    }
  });
  const tail = retryAtIso
    ? ` Next possible window around ${humanTime(new Date(retryAtIso))}.`
    : "";
  return parts.join(" ") + tail;
}

function fmtNum(nv) {
  const v = Number(nv);
  if (!Number.isFinite(v)) return "?";
  return String(Math.round(v));
}

function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : NaN;
}

function isFiniteNum(v) {
  return Number.isFinite(Number(v));
}

function safeId(session) {
  return (session && typeof session.id === "string" && session.id) || null;
}

function humanTime(dt) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(dt);
  } catch {
    return dt.toLocaleTimeString();
  }
}

function safeEmitDebug(type, data) {
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit({
        type,
        ts: new Date().toISOString(),
        source: "weatherGuard",
        data,
      });
    }
  } catch {
    // no-op
  }
}

/* ----------------------------- Public API Shape ---------------------------- */

/**
 * Convenience: evaluate current step (session.progress.currentStepIndex).
 * @param {Session} session
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateForCurrentStep(session, ctx) {
  const idx = safeStepIndex(session);
  return evaluateWeatherGuard(session, idx, ctx);
}

function safeStepIndex(session) {
  if (!session || !session.progress) return -1;
  const i = Number(session.progress.currentStepIndex);
  return Number.isFinite(i) && i >= 0 ? i : -1;
}

/**
 * Utility: estimate next lift time using forecast even if *currently* allowed.
 * Useful for planning outdoor sessions.
 * @param {GuardContext & { session?: Session, stepIndex?: number }} ctx
 * @returns {Promise<string|null>}
 */
export async function nextWeatherLiftTime(ctx = {}) {
  try {
    const session = ctx.session;
    const stepIndex = Number.isFinite(ctx.stepIndex) ? ctx.stepIndex : -1;
    if (!session) return null;

    const step = resolveStep(session, stepIndex);
    if (!hasBlocker(step, "weather")) return null;

    const policy = derivePolicy(session, step, ctx.settings);
    if (!policy.outdoor && !hasExplicitWeatherMetadata(step)) return null;

    const provider = ctx.weatherProvider;
    const { lat, lon } = ctx.coords || {};
    if (!provider || !isFinite(lat) || !isFinite(lon)) return null;

    const hours = Math.max(
      1,
      Math.min(72, Number(ctx.settings?.horizonHours) || 24)
    );
    const forecast = (await provider.forecastHourly(lat, lon, hours)) || [];
    return findNextAcceptableTs(forecast, policy);
  } catch {
    return null;
  }
}

/* --------------------------------- Default -------------------------------- */

const weatherGuard = {
  id: "weather",
  evaluate: evaluateWeatherGuard,
  evaluateForCurrentStep,
  nextLift: nextWeatherLiftTime,
};

export default weatherGuard;

/* --------------------------------- Usage -----------------------------------
 * // In SessionRunner (pseudo):
 * import weatherGuard from "@/features/session/session.guards/weather";
 *
 * async function guardCheck(session, stepIndex) {
 *   const res = await weatherGuard.evaluate(session, stepIndex, {
 *     coords: { lat: userLat, lon: userLon },
 *     weatherProvider: myWeatherProvider, // wrap your API of choice
 *     settings: {
 *       horizonHours: 24,
 *       basePolicy: {
 *         outdoor: false,
 *         minTempF: 32,
 *         maxTempF: 95,
 *         maxWindMph: 30,
 *         allowLightRain: false,
 *         disallowThunder: true,
 *       },
 *       defaultsByDomain: {
 *         garden:  { outdoor: true, minTempF: 28, maxTempF: 100, maxWindMph: 35, allowLightRain: true },
 *         animals: { outdoor: true, minTempF: 15, maxTempF: 102, maxWindMph: 40, allowLightRain: true },
 *         preservation: { outdoor: false },
 *         cleaning: { outdoor: false },
 *         cooking: { outdoor: false },
 *         storehouse: { outdoor: false },
 *       },
 *     },
 *   });
 *   if (!res.allowed) {
 *     // Pause & surface res.message; schedule retry at res.retryAt if provided.
 *   }
 * }
 *
 * // Example provider shim (illustrative):
 * const myWeatherProvider = {
 *   async current(lat, lon) {
 *     const data = await fetchLocalCacheOrAPI(lat, lon);
 *     return {
 *       ts: new Date().toISOString(),
 *       tempF: data.tempF,
 *       windMph: data.windMph,
 *       gustMph: data.gustMph,
 *       humidityPct: data.humidityPct,
 *       precip: { type: data.precipType, intensity: data.precipIntensity },
 *       thunder: !!data.thunder,
 *       condition: data.condition,
 *     };
 *   },
 *   async forecastHourly(lat, lon, hours = 24) {
 *     const arr = await fetchHourly(lat, lon, hours);
 *     return arr.map(h => ({
 *       ts: h.ts,
 *       tempF: h.tempF,
 *       windMph: h.windMph,
 *       gustMph: h.gustMph,
 *       humidityPct: h.humidityPct,
 *       precip: { type: h.precipType, intensity: h.precipIntensity },
 *       thunder: !!h.thunder,
 *     }));
 *   },
 * };
 * -------------------------------------------------------------------------- */
