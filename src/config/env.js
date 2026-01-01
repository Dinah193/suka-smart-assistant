// C:\Users\larho\suka-smart-assistant\src\config\env.js
// -----------------------------------------------------------------------------
// SSA Runtime Configuration (browser-first, Vite-friendly)
//
// Centralized config reader that merges Vite env (import.meta.env) with any
// runtime flags placed on window (window.sukaConfig, window.__SUKA_FLAGS__).
// Exposes:
//   - getConfig()     -> fresh merged snapshot each call
//   - updateFeatureFlags(patch)
//   - onConfigChange(handler) -> unsubscribe()
//
// Defensive and flexible: never throws if values are missing; safe in SSR/tests.
// -----------------------------------------------------------------------------

/** @typedef {Object} SukaFeatureFlags
 *  @property {boolean} familyFundMode
 *  @property {boolean} sabbathGuard
 *  @property {boolean} debugAutomation
 *  @property {boolean} scanCompareTrust
 */

/** @typedef {Object} SukaRuntimeHints
 *  @property {string=} domChannel
 *  @property {boolean=} sharedBus
 */

/** @typedef {Object} SukaConfig
 *  @property {string} appEnv
 *  @property {SukaFeatureFlags} featureFlags
 *  @property {Record<string, any>} domains
 *  @property {boolean} allowUserFavorites
 *  @property {boolean} allowUserSchedules
 *  @property {SukaRuntimeHints} runtimeHints
 */

const IS_BROWSER = typeof window !== "undefined";

/* -------------------------------------------------------------
   Small utilities
------------------------------------------------------------- */
function toBool(val, fallback = false) {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  if (typeof val === "number") return val !== 0;
  return fallback;
}

function safeGet(obj, key, fallback) {
  try {
    const v = obj?.[key];
    return typeof v === "undefined" ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Shallow merge (right-most wins), ignoring null/undefined on the right. */
function merge(a, b) {
  const out = { ...(a || {}) };
  const src = b || {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (typeof v !== "undefined" && v !== null) out[k] = v;
  }
  return out;
}

/* -------------------------------------------------------------
   Sources of truth
   - Vite env (build-time): import.meta.env (guarded)
   - Window runtime: window.sukaConfig + window.__SUKA_FLAGS__/window.sukaFeatureFlags
------------------------------------------------------------- */
function readViteEnv() {
  // Access import.meta.env safely; avoid invalid `typeof import`.
  let ENV = {};
  try {
    // In Vite, import.meta is available; in other contexts this may throw.
    ENV = (import.meta && import.meta.env) ? import.meta.env : {};
  } catch {
    ENV = {};
  }

  return {
    appEnv: ENV.MODE || ENV.VITE_APP_ENV || "development",
    featureFlags: {
      familyFundMode: toBool(ENV.VITE_FAMILY_FUND_MODE, false),
      sabbathGuard: toBool(ENV.VITE_SABBATH_GUARD, false),
      debugAutomation: toBool(ENV.VITE_DEBUG_AUTOMATION, false),
      scanCompareTrust: toBool(ENV.VITE_SCAN_COMPARE_TRUST, true),
    },
  };
}

function readWindowConfig() {
  if (!IS_BROWSER) return {};
  const flatFlags = window.__SUKA_FLAGS__ || window.sukaFeatureFlags || {};
  const sukaConfig = window.sukaConfig || {};
  const domains = sukaConfig.domains || {};
  const runtimeHints = sukaConfig.runtimeHints || {};
  const allowUserFavorites =
    typeof sukaConfig.allowUserFavorites === "boolean" ? sukaConfig.allowUserFavorites : true;
  const allowUserSchedules =
    typeof sukaConfig.allowUserSchedules === "boolean" ? sukaConfig.allowUserSchedules : true;

  return {
    appEnv: sukaConfig.appEnv,
    featureFlags: merge(sukaConfig.featureFlags || {}, flatFlags),
    domains,
    runtimeHints,
    allowUserFavorites,
    allowUserSchedules,
  };
}

/* -------------------------------------------------------------
   Public: getConfig()
------------------------------------------------------------- */
/** @returns {SukaConfig} */
export function getConfig() {
  const vite = readViteEnv();
  const win = readWindowConfig();

  const featureFlags = {
    familyFundMode: toBool(safeGet(win.featureFlags, "familyFundMode", vite.featureFlags.familyFundMode)),
    sabbathGuard: toBool(safeGet(win.featureFlags, "sabbathGuard", vite.featureFlags.sabbathGuard)),
    debugAutomation: toBool(safeGet(win.featureFlags, "debugAutomation", vite.featureFlags.debugAutomation)),
    scanCompareTrust: toBool(safeGet(win.featureFlags, "scanCompareTrust", vite.featureFlags.scanCompareTrust)),
  };

  /** @type {SukaConfig} */
  const cfg = {
    appEnv: win.appEnv || vite.appEnv || "development",
    featureFlags,
    domains: win.domains || {},
    allowUserFavorites:
      typeof win.allowUserFavorites === "boolean" ? win.allowUserFavorites : true,
    allowUserSchedules:
      typeof win.allowUserSchedules === "boolean" ? win.allowUserSchedules : true,
    runtimeHints: {
      domChannel: win.runtimeHints?.domChannel || "window.__suka?.eventBus",
      sharedBus:
        typeof win.runtimeHints?.sharedBus === "boolean" ? win.runtimeHints.sharedBus : true,
    },
  };

  return cfg;
}

/* -------------------------------------------------------------
   Feature flag utilities
------------------------------------------------------------- */
export function updateFeatureFlags(patch = {}) {
  if (!IS_BROWSER) return;
  const sukaConfig = (window.sukaConfig = window.sukaConfig || {});
  sukaConfig.featureFlags = merge(sukaConfig.featureFlags || {}, patch);
  try {
    window.dispatchEvent(
      new CustomEvent("config.updated", {
        detail: { type: "featureFlags", patch, at: new Date().toISOString() },
      }),
    );
  } catch {}
}

export function onConfigChange(handler) {
  if (!IS_BROWSER || typeof handler !== "function") return () => {};
  const fn = (e) => handler(e?.detail || { type: "unknown" });
  window.addEventListener("config.updated", fn);
  return () => window.removeEventListener("config.updated", fn);
}

/* -------------------------------------------------------------
   Compatibility exports
------------------------------------------------------------- */
const env = { getConfig, onConfigChange, updateFeatureFlags };
export default getConfig; // allow: import cfg from "@/config/env"
export { env };
