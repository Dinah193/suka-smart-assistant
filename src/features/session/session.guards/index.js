/**
 * C:\Users\larho\suka-smart-assistant\src\features\session\session.guards\index.js
 *
 * Session Guards — centralized, pluggable guard engine for SSA sessions.
 *
 * How this fits:
 * - SessionRunner (and/or SessionRunnerModal) calls evaluateGuards(step, ctx)
 *   before starting/resuming a step and again just-in-time before auto-advance.
 *   It receives { ok, failed, details }.
 * - Only guards whose codes appear in step.blockers[] are evaluated (if provided);
 *   otherwise all registered guards run (progressive enhancement).
 * - Guards are small async functions that *never throw* and return:
 *     { ok: true } OR { ok: false, code: "quietHours", details?: any }
 * - You can enable/disable guards at runtime and update per-guard config.
 *
 * Contracts honored:
 * - Blocker codes: "inventory","weather","quietHours","sabbath","equipment"
 * - Optional device battery guard ("battery") included; not referenced by default.
 *
 * Extension points:
 * - registerGuard(code, fn, { enabled: boolean, weight: number })
 * - setGuardConfig(code, config)
 * - enableGuard(code)/disableGuard(code)
 *
 * Defensive behavior:
 * - Unknown/misbehaving guards are treated as ok and logged via console.warn.
 * - Returns a compact { ok, failed: string[], details: Record<string,any> }.
 *
 * NOTE:
 * - This index.js is the module you import as "./session.guards"
 *   (no need for a separate sessionGuards.js).
 * - It also exports a "sessionGuards" object for convenience.
 *
 * © Suka Smart Assistant
 */

const GUARD_CODES = {
  INVENTORY: "inventory",
  WEATHER: "weather",
  QUIET: "quietHours",
  SABBATH: "sabbath",
  EQUIPMENT: "equipment",
  BATTERY: "battery", // optional
};

const registry = new Map(); // code -> { fn, enabled, config, weight }

/** Safe wrapper to call a guard without ever throwing. */
async function safeCallGuard(code, fn, step, ctx) {
  try {
    const res = await fn(
      { code, config: registry.get(code)?.config || {} },
      step,
      ctx
    );
    if (!res || typeof res.ok !== "boolean") return { ok: true };
    // enforce code echo
    if (res.ok === false && !res.code) res.code = code;
    return res;
  } catch (err) {
    console.warn(`[guards] "${code}" failed:`, err);
    return { ok: true };
  }
}

/**
 * Register a guard.
 * @param {string} code - one of GUARD_CODES.* or your custom code.
 * @param {(info:{code:string,config:any}, step:any, ctx:any)=>Promise<{ok:boolean, code?:string, details?:any}>} fn
 * @param {{enabled?:boolean, weight?:number, config?:any}} [opts]
 */
function registerGuard(code, fn, opts = {}) {
  if (!code || typeof fn !== "function") return;
  if (registry.has(code)) console.warn(`[guards] overriding guard: ${code}`);
  registry.set(code, {
    fn,
    enabled: opts.enabled !== false, // default enabled
    config: opts.config || {},
    weight: Number.isFinite(opts.weight) ? opts.weight : 0,
  });
}

/** Update a guard's config (merge). */
function setGuardConfig(code, patch) {
  const e = registry.get(code);
  if (!e) return;
  e.config = { ...(e.config || {}), ...(patch || {}) };
}

/** Enable or disable a guard. */
function enableGuard(code) {
  const e = registry.get(code);
  if (e) e.enabled = true;
}
function disableGuard(code) {
  const e = registry.get(code);
  if (e) e.enabled = false;
}

/** List registered guards (debug). */
function listGuards() {
  return Array.from(registry.entries()).map(([code, v]) => ({
    code,
    enabled: !!v.enabled,
    weight: v.weight,
    config: v.config,
  }));
}

/**
 * Evaluate guards for a step. Only guards matching step.blockers[] are executed
 * (if blockers are present). Otherwise all enabled guards run.
 * @param {any} step
 * @param {any} ctx - environment context: time, tz, services, feature flags, etc. (see guards)
 * @returns {Promise<{ok:boolean, failed:string[], details:Record<string, any>}>}
 */
async function evaluateGuards(step, ctx = {}) {
  const enabled = Array.from(registry.entries()).filter(([, v]) => v.enabled);
  if (!enabled.length) return { ok: true, failed: [], details: {} };

  const allowList =
    Array.isArray(step?.blockers) && step.blockers.length
      ? new Set(step.blockers)
      : null;

  const targets = enabled
    .filter(([code]) => (allowList ? allowList.has(code) : true))
    .sort((a, b) => (a[1].weight || 0) - (b[1].weight || 0)); // low weight runs first

  const failed = [];
  const details = {};
  for (const [code, entry] of targets) {
    const res = await safeCallGuard(code, entry.fn, step, ctx);
    if (res && res.ok === false) {
      failed.push(res.code || code);
      if (res.details != null) details[code] = res.details;
    }
  }
  return { ok: failed.length === 0, failed, details };
}

// ---------------------------------------------------------------------------
// Default guard registrations (using local files). Each guard is defensive.
// This loader works whether guards are CommonJS or ES module style.
// ---------------------------------------------------------------------------

function loadGuard(path) {
  try {
    // eslint-disable-next-line global-require
    const mod = require(path);
    if (typeof mod === "function") return mod;
    if (mod && typeof mod.default === "function") return mod.default;
    if (mod && typeof mod.guard === "function") return mod.guard;
    return null;
  } catch (err) {
    console.warn(`[guards] failed to load guard from ${path}:`, err);
    return null;
  }
}

const sabbathGuard = loadGuard("./sabbath.js");
if (sabbathGuard) {
  registerGuard(GUARD_CODES.SABBATH, sabbathGuard);
}

const quietGuard = loadGuard("./quietHours.js");
if (quietGuard) {
  registerGuard(GUARD_CODES.QUIET, quietGuard);
}

const weatherGuard = loadGuard("./weather.js");
if (weatherGuard) {
  registerGuard(GUARD_CODES.WEATHER, weatherGuard);
}

const inventoryGuard = loadGuard("./inventory.js");
if (inventoryGuard) {
  registerGuard(GUARD_CODES.INVENTORY, inventoryGuard);
}

const equipmentGuard = loadGuard("./equipment.js");
if (equipmentGuard) {
  registerGuard(GUARD_CODES.EQUIPMENT, equipmentGuard);
}

const batteryGuard = loadGuard("./battery.js");
if (batteryGuard) {
  // Optional; disabled by default
  registerGuard(GUARD_CODES.BATTERY, batteryGuard, { enabled: false });
}

// ---------------------------------------------------------------------------
// Aggregated export object so you can:
//   import { sessionGuards } from "./session.guards";
// or with CJS:
//   const { sessionGuards } = require("./session.guards");
// ---------------------------------------------------------------------------

const sessionGuards = {
  GUARD_CODES,
  evaluateGuards,
  registerGuard,
  listGuards,
  setGuardConfig,
  enableGuard,
  disableGuard,
};

module.exports = {
  GUARD_CODES,
  evaluateGuards,
  registerGuard,
  listGuards,
  setGuardConfig,
  enableGuard,
  disableGuard,
  sessionGuards,
};
