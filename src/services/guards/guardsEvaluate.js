// C:\Users\larho\suka-smart-assistant\src\services\guards\guardsEvaluate.js
/**
 * guardsEvaluate (service)
 * -----------------------------------------------------------------------------
 * PURPOSE
 * - Evaluate a set of "guards" against a session (or shim-produced session draft)
 *   BEFORE a SessionRunner starts or BEFORE we persist/export a session.
 *
 * WHY THIS EXISTS
 * - Multiple parts of SSA reference "evaluateGuards" but your repo has moved
 *   code around over time (agents/skills/sessions, services/guards, etc.).
 * - This file provides a stable, production-safe implementation under:
 *     src/services/guards/guardsEvaluate.js
 *
 * COMPAT
 * - Common call signatures seen in your shims:
 *     evaluateGuards({ session, domain, guards: ["Sabbath","QuietHours", ...] })
 * - Also works with:
 *     evaluateGuards(session, opts)
 *
 * OUTPUT
 *  {
 *    ok: boolean,
 *    session: Object,          // possibly patched
 *    blocked: boolean,
 *    blockers: Array<{code,message,guard,meta?}>,
 *    warnings: Array<{code,message,guard,meta?}>,
 *    notes: Array<{code,message,guard,meta?}>,
 *    debug: Array<Object>
 *  }
 *
 * IMPORTANT
 * - This file does NOT hard-depend on any specific calendars, Dexie tables,
 *   or UI. It is "pure service" logic and will not touch DOM.
 */

const DEFAULT_GUARDS = ["Sabbath", "QuietHours", "Inventory", "Battery"];
const SOURCE = "services/guards/guardsEvaluate";

const isoNow = () => new Date().toISOString();

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function lower(s) {
  return String(s || "").toLowerCase();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function safeBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = lower(v).trim();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return fallback;
}

function makeItem(guard, code, message, meta) {
  return {
    guard,
    code,
    message,
    meta: meta && isObj(meta) ? meta : undefined,
    ts: isoNow(),
    source: SOURCE,
  };
}

/* -------------------------------------------------------------------------- */
/* Session helpers                                                            */
/* -------------------------------------------------------------------------- */

function ensureSessionShape(session) {
  const s = isObj(session) ? { ...session } : {};
  if (!s.id) s.id = `sess_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  if (!s.domain) s.domain = "unknown";
  if (!s.title) s.title = s.name || `${s.domain} session`;
  if (!s.steps) s.steps = [];
  if (!s.meta) s.meta = {};
  if (!s.analytics) s.analytics = {};
  if (!s.createdAt) s.createdAt = isoNow();
  return s;
}

/**
 * Extract "quiet hours" policy from session/runtime/user prefs if present.
 *
 * We intentionally support many shapes since your app is evolving:
 * - session.meta.quietHours = { startHour, endHour, enabled }
 * - session.meta.guards.quietHours = ...
 * - runtime.quietHours = ...
 */
function getQuietHoursPolicy({ session, runtime, defaults }) {
  const d = defaults || {};
  const s = session || {};
  const meta = s.meta || {};

  const candidate =
    meta.quietHours ||
    (meta.guards && meta.guards.quietHours) ||
    (runtime && runtime.quietHours) ||
    (runtime && runtime.guards && runtime.guards.quietHours) ||
    d.quietHours ||
    null;

  const enabled =
    candidate && typeof candidate === "object"
      ? safeBool(candidate.enabled, true)
      : safeBool(candidate, !!candidate);

  // Typical quiet hours window: 21:00 -> 07:00
  const startHour = clamp(
    safeInt(candidate?.startHour, d.startHour ?? 21),
    0,
    23
  );
  const endHour = clamp(safeInt(candidate?.endHour, d.endHour ?? 7), 0, 23);

  return { enabled, startHour, endHour };
}

function isWithinQuietHours(now, startHour, endHour) {
  const h = now.getHours();
  // If start < end (e.g. 22 -> 6) crosses midnight.
  if (startHour === endHour) return true; // all day (degenerate)
  if (startHour < endHour) {
    // e.g. 1 -> 5
    return h >= startHour && h < endHour;
  }
  // crosses midnight: e.g. 21 -> 7 means quiet if h >= 21 OR h < 7
  return h >= startHour || h < endHour;
}

/**
 * Determine if it's "Sabbath" based on a very simple default:
 * - Saturday (local time) is sabbath by default.
 * - Optionally uses session.meta.sabbath = { dayOfWeek: 6, enabled }
 *   where dayOfWeek is 0=Sunday ... 6=Saturday
 *
 * This is intentionally minimal and avoids coupling to your Hebrew calendar logic.
 */
function getSabbathPolicy({ session, runtime, defaults }) {
  const d = defaults || {};
  const s = session || {};
  const meta = s.meta || {};

  const candidate =
    meta.sabbath ||
    (meta.guards && meta.guards.sabbath) ||
    (runtime && runtime.sabbath) ||
    (runtime && runtime.guards && runtime.guards.sabbath) ||
    d.sabbath ||
    null;

  const enabled =
    candidate && typeof candidate === "object"
      ? safeBool(candidate.enabled, true)
      : safeBool(candidate, !!candidate);

  const dayOfWeek = clamp(
    safeInt(candidate?.dayOfWeek, d.dayOfWeek ?? 6),
    0,
    6
  );

  // Optional "startAtSunset" and "endAtSunset" are acknowledged but not implemented
  // without your calendar engine; we emit a warning if requested.
  const startAtSunset = safeBool(candidate?.startAtSunset, false);
  const endAtSunset = safeBool(candidate?.endAtSunset, false);

  return { enabled, dayOfWeek, startAtSunset, endAtSunset };
}

/**
 * Minimal battery policy:
 * - runtime.battery: { level: 0..1, charging: boolean }
 * - session.meta.battery: { minLevel, requireChargingBelowMin }
 */
function getBatteryPolicy({ session, runtime, defaults }) {
  const d = defaults || {};
  const meta = session?.meta || {};
  const candidate =
    meta.battery ||
    (meta.guards && meta.guards.battery) ||
    (runtime && runtime.batteryPolicy) ||
    (runtime && runtime.guards && runtime.guards.battery) ||
    d.battery ||
    null;

  const enabled =
    candidate && typeof candidate === "object"
      ? safeBool(candidate.enabled, true)
      : safeBool(candidate, !!candidate);

  const minLevel = clamp(
    Number(candidate?.minLevel ?? d.minLevel ?? 0.15),
    0,
    1
  );

  const requireChargingBelowMin = safeBool(
    candidate?.requireChargingBelowMin,
    d.requireChargingBelowMin ?? false
  );

  return { enabled, minLevel, requireChargingBelowMin };
}

function getInventoryPolicy({ session, runtime, defaults }) {
  const d = defaults || {};
  const meta = session?.meta || {};
  const candidate =
    meta.inventory ||
    (meta.guards && meta.guards.inventory) ||
    (runtime && runtime.inventoryPolicy) ||
    (runtime && runtime.guards && runtime.guards.inventory) ||
    d.inventory ||
    null;

  const enabled =
    candidate && typeof candidate === "object"
      ? safeBool(candidate.enabled, true)
      : safeBool(candidate, !!candidate);

  // If strict, block when session requires inventory items but they are missing.
  const strict = safeBool(candidate?.strict, d.strict ?? false);

  return { enabled, strict };
}

/* -------------------------------------------------------------------------- */
/* Guard evaluators                                                           */
/* -------------------------------------------------------------------------- */

async function evalSabbath({ session, runtime, defaults, now }) {
  const blockers = [];
  const warnings = [];
  const notes = [];
  const debug = [];

  const policy = getSabbathPolicy({ session, runtime, defaults });
  debug.push({ guard: "Sabbath", policy });

  if (!policy.enabled) return { blockers, warnings, notes, debug };

  const dow = now.getDay(); // 0..6
  const isSabbath = dow === policy.dayOfWeek;

  if (policy.startAtSunset || policy.endAtSunset) {
    warnings.push(
      makeItem(
        "Sabbath",
        "SABBATH_SUNSET_UNSUPPORTED",
        "Sabbath sunset boundaries requested but sunset-based guard is not wired here. Defaulting to day-of-week only.",
        { startAtSunset: policy.startAtSunset, endAtSunset: policy.endAtSunset }
      )
    );
  }

  if (isSabbath) {
    // Decide policy: block or warn? Default: block only if session explicitly says so.
    const meta = session?.meta || {};
    const sabbathBehavior =
      meta.sabbathBehavior ||
      meta.sabbath?.behavior ||
      (runtime && runtime.sabbathBehavior) ||
      "warn"; // "block" | "warn" | "allow"

    if (sabbathBehavior === "allow") {
      notes.push(
        makeItem(
          "Sabbath",
          "SABBATH_ALLOW",
          "Sabbath detected; session explicitly allows running."
        )
      );
    } else if (sabbathBehavior === "block") {
      blockers.push(
        makeItem(
          "Sabbath",
          "SABBATH_BLOCK",
          "Sabbath detected; session is blocked by sabbath guard.",
          { dayOfWeek: dow }
        )
      );
    } else {
      warnings.push(
        makeItem(
          "Sabbath",
          "SABBATH_WARN",
          "Sabbath detected; consider postponing this session.",
          { dayOfWeek: dow }
        )
      );
    }
  }

  return { blockers, warnings, notes, debug };
}

async function evalQuietHours({ session, runtime, defaults, now }) {
  const blockers = [];
  const warnings = [];
  const notes = [];
  const debug = [];

  const policy = getQuietHoursPolicy({ session, runtime, defaults });
  debug.push({ guard: "QuietHours", policy });

  if (!policy.enabled) return { blockers, warnings, notes, debug };

  const within = isWithinQuietHours(now, policy.startHour, policy.endHour);

  if (within) {
    const behavior =
      session?.meta?.quietHoursBehavior ||
      session?.meta?.quietHours?.behavior ||
      (runtime && runtime.quietHoursBehavior) ||
      "warn"; // "block" | "warn" | "allow"

    if (behavior === "allow") {
      notes.push(
        makeItem(
          "QuietHours",
          "QUIET_ALLOW",
          "Quiet hours are active; session explicitly allows running."
        )
      );
    } else if (behavior === "block") {
      blockers.push(
        makeItem(
          "QuietHours",
          "QUIET_BLOCK",
          "Quiet hours are active; session is blocked.",
          { startHour: policy.startHour, endHour: policy.endHour }
        )
      );
    } else {
      warnings.push(
        makeItem(
          "QuietHours",
          "QUIET_WARN",
          "Quiet hours are active; consider postponing or switching to a quiet-mode session.",
          { startHour: policy.startHour, endHour: policy.endHour }
        )
      );
    }
  }

  return { blockers, warnings, notes, debug };
}

async function evalBattery({ session, runtime, defaults, now }) {
  const blockers = [];
  const warnings = [];
  const notes = [];
  const debug = [];

  const policy = getBatteryPolicy({ session, runtime, defaults });
  debug.push({ guard: "Battery", policy });

  if (!policy.enabled) return { blockers, warnings, notes, debug };

  const level = runtime?.battery?.level;
  const charging = !!runtime?.battery?.charging;

  if (typeof level !== "number" || !Number.isFinite(level)) {
    // no signal - warn only
    warnings.push(
      makeItem(
        "Battery",
        "BATTERY_UNKNOWN",
        "Battery level not available to guard; skipping battery check."
      )
    );
    return { blockers, warnings, notes, debug };
  }

  if (level < policy.minLevel) {
    if (policy.requireChargingBelowMin && !charging) {
      blockers.push(
        makeItem(
          "Battery",
          "BATTERY_BLOCK_LOW",
          "Battery is below minimum and device is not charging; session is blocked.",
          { level, minLevel: policy.minLevel, charging }
        )
      );
    } else {
      warnings.push(
        makeItem(
          "Battery",
          "BATTERY_WARN_LOW",
          "Battery is below minimum; consider plugging in before starting.",
          { level, minLevel: policy.minLevel, charging }
        )
      );
    }
  } else {
    notes.push(
      makeItem(
        "Battery",
        "BATTERY_OK",
        "Battery level meets minimum threshold.",
        { level, minLevel: policy.minLevel, charging }
      )
    );
  }

  return { blockers, warnings, notes, debug };
}

async function evalInventory({ session, runtime, defaults, now }) {
  const blockers = [];
  const warnings = [];
  const notes = [];
  const debug = [];

  const policy = getInventoryPolicy({ session, runtime, defaults });
  debug.push({ guard: "Inventory", policy });

  if (!policy.enabled) return { blockers, warnings, notes, debug };

  // We do NOT query Dexie here. We only validate what session already carries.
  // Expected optional fields:
  // - session.meta.requiresInventory = [{ inventoryItemId, label, qty, unit }]
  // - session.inventory.requires = [...]
  const requires =
    asArray(session?.meta?.requiresInventory) ||
    asArray(session?.inventory?.requires) ||
    [];

  if (!requires.length) {
    notes.push(
      makeItem(
        "Inventory",
        "INV_NONE",
        "No inventory requirements attached to session."
      )
    );
    return { blockers, warnings, notes, debug };
  }

  // Optional runtime fulfillment map:
  // - runtime.inventorySnapshot = { [inventoryItemId]: { availableQty, unit } }
  const snap =
    runtime?.inventorySnapshot && isObj(runtime.inventorySnapshot)
      ? runtime.inventorySnapshot
      : null;

  if (!snap) {
    // Without snapshot, we can only warn that requirements exist.
    warnings.push(
      makeItem(
        "Inventory",
        "INV_REQUIREMENTS_PRESENT",
        "Session has inventory requirements, but no runtime inventory snapshot was provided to verify availability.",
        { count: requires.length }
      )
    );
    return { blockers, warnings, notes, debug };
  }

  const missing = [];
  const insufficient = [];

  for (const req of requires) {
    const id = req.inventoryItemId || req.itemId || req.id;
    if (!id) continue;

    const have = snap[id];
    if (!have) {
      missing.push({ id, label: req.label || req.name || null });
      continue;
    }

    const needQty = req.qty ?? req.quantity ?? null;
    const need = typeof needQty === "number" ? needQty : Number(needQty);
    const haveQty = have.availableQty ?? have.qty ?? have.quantity ?? null;
    const haveN = typeof haveQty === "number" ? haveQty : Number(haveQty);

    if (Number.isFinite(need) && Number.isFinite(haveN) && haveN < need) {
      insufficient.push({
        id,
        label: req.label || req.name || null,
        need,
        have: haveN,
        unit: req.unit || have.unit || null,
      });
    }
  }

  if (missing.length || insufficient.length) {
    const meta = { missing, insufficient };

    if (policy.strict) {
      blockers.push(
        makeItem(
          "Inventory",
          "INV_BLOCK",
          "Inventory requirements are missing or insufficient; session is blocked by strict inventory policy.",
          meta
        )
      );
    } else {
      warnings.push(
        makeItem(
          "Inventory",
          "INV_WARN",
          "Some inventory requirements appear missing or insufficient. You may still proceed, but expect substitutions or stops.",
          meta
        )
      );
    }
  } else {
    notes.push(
      makeItem(
        "Inventory",
        "INV_OK",
        "Inventory snapshot indicates requirements are available.",
        { count: requires.length }
      )
    );
  }

  return { blockers, warnings, notes, debug };
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const GUARD_REGISTRY = {
  sabbath: evalSabbath,
  quiethours: evalQuietHours,
  quiet_hours: evalQuietHours,
  battery: evalBattery,
  inventory: evalInventory,
};

/**
 * Resolve guard names to evaluator functions.
 * Allows: "Sabbath" / "quietHours" / "Quiet Hours" etc.
 */
function resolveGuardFns(guards) {
  const list = asArray(guards);
  const fns = [];

  for (const g of list) {
    const key = lower(g).replace(/\s+/g, "");
    const altKey = lower(g).replace(/\s+/g, "_");
    const fn =
      GUARD_REGISTRY[key] || GUARD_REGISTRY[altKey] || GUARD_REGISTRY[lower(g)];
    if (fn) fns.push({ name: String(g), fn });
  }

  return fns;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate guards against a session.
 *
 * Supported signatures:
 *   1) evaluateGuards({ session, domain, guards, runtime, defaults, now })
 *   2) evaluateGuards(session, { domain, guards, runtime, defaults, now })
 *
 * @param {Object|any} arg1
 * @param {Object} [arg2]
 * @returns {Promise<{
 *  ok: boolean,
 *  session: Object,
 *  blocked: boolean,
 *  blockers: Array,
 *  warnings: Array,
 *  notes: Array,
 *  debug: Array
 * }>}
 */
export async function evaluateGuards(arg1, arg2 = {}) {
  const isWrapped = isObj(arg1) && isObj(arg1.session);

  const sessionIn = isWrapped ? arg1.session : arg1;
  const opts = isWrapped ? arg1 : arg2;

  const domain = opts?.domain || sessionIn?.domain || "unknown";
  const guards = opts?.guards || DEFAULT_GUARDS;
  const runtime = opts?.runtime || {};
  const defaults = opts?.defaults || {};
  const now = opts?.now instanceof Date ? opts.now : new Date();

  const session = ensureSessionShape({ ...(sessionIn || {}), domain });

  const debug = [
    {
      stage: "guards.start",
      domain,
      guardsRequested: asArray(guards),
      ts: isoNow(),
    },
  ];

  const blockers = [];
  const warnings = [];
  const notes = [];

  const guardFns = resolveGuardFns(guards);

  // If no resolvable guards, treat as OK.
  if (!guardFns.length) {
    debug.push({
      stage: "guards.noneResolved",
      message: "No matching guards found in registry.",
    });
    return {
      ok: true,
      session,
      blocked: false,
      blockers,
      warnings,
      notes,
      debug,
    };
  }

  for (const g of guardFns) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await g.fn({ session, domain, runtime, defaults, now });
      blockers.push(...asArray(res.blockers));
      warnings.push(...asArray(res.warnings));
      notes.push(...asArray(res.notes));
      debug.push(...asArray(res.debug));
    } catch (err) {
      // Guard failures should never crash session creation.
      warnings.push(
        makeItem(
          g.name,
          "GUARD_ERROR",
          `Guard "${g.name}" failed; continuing without blocking.`,
          { error: String(err) }
        )
      );
      debug.push({ guard: g.name, stage: "guard.error", error: String(err) });
    }
  }

  const blocked = blockers.length > 0;

  // Patch session meta with guard results (non-destructive)
  const nextSession = {
    ...session,
    meta: {
      ...(session.meta || {}),
      guards: {
        ...(session.meta?.guards || {}),
        lastEvaluatedAt: isoNow(),
        blocked,
        blockers: blockers.map((b) => ({
          guard: b.guard,
          code: b.code,
          message: b.message,
          ts: b.ts,
        })),
        warnings: warnings.map((w) => ({
          guard: w.guard,
          code: w.code,
          message: w.message,
          ts: w.ts,
        })),
      },
    },
  };

  debug.push({
    stage: "guards.done",
    blocked,
    blockerCount: blockers.length,
    warningCount: warnings.length,
    ts: isoNow(),
  });

  return {
    ok: !blocked,
    session: nextSession,
    blocked,
    blockers,
    warnings,
    notes,
    debug,
  };
}

/**
 * Alias used by some older codebases.
 */
export const guardsEvaluate = evaluateGuards;

export default evaluateGuards;
