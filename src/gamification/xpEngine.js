// File: src/gamification/xpEngine.js
/**
 * XP Engine (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Central, browser-only XP + level + streak + badge evaluation engine.
 *  - Safe to import anywhere (no Node imports).
 *  - Emits events via SSA eventBus when available.
 *
 * Design Goals
 *  - Deterministic: same inputs => same XP.
 *  - Extensible: rules-based scoring you can evolve without breaking older data.
 *  - Offline-first: works without network.
 *  - SSA-native: understands "session.*" + "inventory.*" + "cleaning.*" patterns.
 *
 * Key Concepts
 *  - XP Event: canonical envelope (via eventBus), or raw object.
 *  - Ledger Entry: normalized record you can persist (Dexie or localStorage).
 *  - Profile: per-user or per-household XP totals, levels, streaks.
 *
 * Integrations
 *  - If "@/services/events/eventBus" exists:
 *      - emits ui/toast for big level-ups (optional)
 *      - emits gamification/xp.awarded and gamification/level.up
 *      - provides a "subscribe" helper that auto-awards XP from events
 *
 * What this file does NOT do
 *  - It does NOT define a DB schema (Dexie). You can persist using your own repo.
 *  - It does NOT assume auth/user IDs. Caller passes actorId/householdId.
 */

/* ----------------------------- optional eventBus ---------------------------- */

let eventBus = null;
let Events = null;
try {
  // eslint-disable-next-line import/no-unresolved
  const mod = require("@/services/events/eventBus");
  eventBus = mod?.eventBus || mod?.default || null;
  Events = mod?.Events || mod?.eventBus?.Events || null;
} catch {
  // optional
}

/* ---------------------------------- utils --------------------------------- */

const SOURCE = "gamification.xpEngine";

function nowISO() {
  return new Date().toISOString();
}

function genId(prefix = "xp") {
  return `${prefix}_${Math.random()
    .toString(36)
    .slice(2)}_${Date.now().toString(36)}`;
}

function clamp(n, min, max) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
}

function asInt(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : fallback;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function safeString(v) {
  return String(v ?? "");
}

function deepGet(obj, path, fallback = undefined) {
  try {
    const parts = safeString(path).split(".");
    let cur = obj;
    for (const p of parts) {
      if (!cur) return fallback;
      cur = cur[p];
    }
    return cur === undefined ? fallback : cur;
  } catch {
    return fallback;
  }
}

function emit(type, data, opts = {}) {
  try {
    eventBus?.emit?.(type, data, { source: SOURCE, ...(opts || {}) });
  } catch {
    // noop
  }
}

function emitToast(payload) {
  try {
    const type = Events?.UI_TOAST || eventBus?.Events?.UI_TOAST || "ui/toast";
    emit(type, payload);
  } catch {
    // noop
  }
}

/* --------------------------- leveling + milestones -------------------------- */

/**
 * Default leveling curve:
 *  - Level 1 starts at 0 XP
 *  - Next level requires: 100 * level^1.35 (tunable)
 * This yields a "pleasant" early ramp and slower later progression.
 */
export function defaultXpForNextLevel(level) {
  const L = clamp(level, 1, 9999);
  const req = 100 * Math.pow(L, 1.35);
  return Math.round(req);
}

/**
 * Compute level and progress for a total XP amount.
 * @returns {{ level:number, xpIntoLevel:number, xpForNext:number, progress:number }}
 */
export function computeLevel(totalXp, curveFn = defaultXpForNextLevel) {
  let xp = Math.max(0, asInt(totalXp, 0));
  let level = 1;
  let req = curveFn(level);

  // Hard safety cap to prevent infinite loops on crazy inputs
  for (let guard = 0; guard < 20000; guard++) {
    if (xp < req) break;
    xp -= req;
    level += 1;
    req = curveFn(level);
    if (level >= 9999) break;
  }

  const xpIntoLevel = xp;
  const xpForNext = req;
  const progress = xpForNext > 0 ? clamp(xpIntoLevel / xpForNext, 0, 1) : 0;

  return { level, xpIntoLevel, xpForNext, progress };
}

/**
 * getLevelProgress (Build fix)
 * -----------------------------------------------------------------------------
 * HeaderStats.jsx expects:
 *   import { getLevelProgress } from "@/gamification/xpEngine";
 *
 * This is a convenience wrapper over computeLevel() that accepts either:
 *   - a profile object { totalXp } or { xp } or { level/xpIntoLevel/xpForNext }
 *   - a raw totalXp number
 *
 * It returns:
 *   { level, totalXp, xpIntoLevel, xpForNext, progress }
 */
export function getLevelProgress(
  profileOrTotalXp,
  curveFn = defaultXpForNextLevel
) {
  // Already in computed form
  if (isPlainObject(profileOrTotalXp)) {
    const p = profileOrTotalXp;

    // If caller already has computed values, normalize + return.
    if (
      typeof p.level === "number" &&
      typeof p.xpIntoLevel === "number" &&
      typeof p.xpForNext === "number"
    ) {
      const totalXp = asInt(p.totalXp ?? p.xp ?? 0, 0);
      const level = clamp(asInt(p.level, 1), 1, 9999);
      const xpIntoLevel = Math.max(0, asInt(p.xpIntoLevel, 0));
      const xpForNext = Math.max(
        1,
        asInt(p.xpForNext, defaultXpForNextLevel(level))
      );
      const progress = xpForNext > 0 ? clamp(xpIntoLevel / xpForNext, 0, 1) : 0;

      return { level, totalXp, xpIntoLevel, xpForNext, progress };
    }

    // Otherwise compute from totals
    const totalXp = asInt(p.totalXp ?? p.xp ?? p.totalXP ?? 0, 0);
    const computed = computeLevel(totalXp, curveFn);
    return {
      level: computed.level,
      totalXp,
      xpIntoLevel: computed.xpIntoLevel,
      xpForNext: computed.xpForNext,
      progress: computed.progress,
    };
  }

  // Numeric total XP
  const totalXp = asInt(profileOrTotalXp, 0);
  const computed = computeLevel(totalXp, curveFn);
  return {
    level: computed.level,
    totalXp,
    xpIntoLevel: computed.xpIntoLevel,
    xpForNext: computed.xpForNext,
    progress: computed.progress,
  };
}

/* ------------------------------ XP rule system ------------------------------ */

/**
 * XP Rule
 * -----------------------------------------------------------------------------
 * id: stable identifier for auditing
 * match: event => boolean
 * score: (event, ctx) => number
 * capPerDay?: number   // optional daily cap per actor per rule
 * description?: string
 */

/**
 * Normalize input into a canonical-ish "xp event".
 * Supports:
 *  - SSA EventEnvelope {type, ts, source, data}
 *  - Raw objects {type, ...}
 *  - Raw name + data (via awardFromSignal)
 */
export function normalizeXpEvent(evt) {
  if (!evt) {
    return {
      type: "unknown",
      ts: nowISO(),
      source: "unknown",
      data: {},
    };
  }

  // SSA canonical envelope
  if (
    isPlainObject(evt) &&
    typeof evt.type === "string" &&
    typeof evt.ts === "string" &&
    "data" in evt
  ) {
    return {
      type: safeString(evt.type),
      ts: safeString(evt.ts || nowISO()),
      source: safeString(evt.source || "unknown"),
      data: evt.data ?? {},
      _envelope: evt,
    };
  }

  // raw object with type
  if (isPlainObject(evt) && typeof evt.type === "string") {
    return {
      type: safeString(evt.type),
      ts: safeString(evt.ts || nowISO()),
      source: safeString(evt.source || "unknown"),
      data: evt.data ?? evt,
    };
  }

  // fallback
  return {
    type: "unknown",
    ts: nowISO(),
    source: "unknown",
    data: isPlainObject(evt) ? evt : { value: evt },
  };
}

function isType(evt, prefixOrExact) {
  const t = safeString(evt?.type);
  const p = safeString(prefixOrExact);
  if (!p) return false;
  if (p.endsWith("/**")) {
    return t.startsWith(p.slice(0, -3));
  }
  if (p.endsWith("/*")) {
    const base = p.slice(0, -2);
    return (
      t.startsWith(base) && t.split("/").length === base.split("/").length + 1
    );
  }
  return t === p;
}

/**
 * Default XP rules for SSA domains.
 * You can replace/extend this list via configure().
 */
export const DefaultXpRules = [
  {
    id: "session_completed_base",
    description: "Session completed base XP (scaled by duration/steps)",
    match: (evt) =>
      isType(evt, "session/completed") || isType(evt, "session/completed/**"),
    score: (evt) => {
      // expected shapes:
      // data: { session, durationSec, stepsCompleted, stepsTotal, intensity? }
      const d = evt.data || {};
      const durationSec = asInt(
        d.durationSec ?? deepGet(d, "session.durationSec"),
        0
      );
      const stepsCompleted = asInt(
        d.stepsCompleted ?? deepGet(d, "session.stepsCompleted"),
        0
      );
      const stepsTotal = asInt(
        d.stepsTotal ?? deepGet(d, "session.stepsTotal"),
        stepsCompleted || 0
      );
      const intensity = clamp(
        Number(d.intensity ?? deepGet(d, "session.intensity") ?? 1),
        0.5,
        2.5
      );

      // Base: 25 XP for any completed session
      let xp = 25;

      // Steps: +1 per completed step (cap 60)
      xp += clamp(stepsCompleted, 0, 60);

      // Completion bonus: if stepsCompleted >= stepsTotal and stepsTotal >= 5 => +10
      if (stepsTotal >= 5 && stepsCompleted >= stepsTotal) xp += 10;

      // Duration: +1 per 10 minutes (cap 30)
      xp += clamp(Math.floor(durationSec / 600), 0, 30);

      // Intensity multiplier (like "deep clean", "heavy batch cooking")
      xp = Math.round(xp * intensity);

      return clamp(xp, 5, 250);
    },
    capPerDay: 1200,
  },

  {
    id: "session_started_small",
    description: "Small XP for starting a session (encourages momentum)",
    match: (evt) =>
      isType(evt, "session/started") || isType(evt, "session/started/**"),
    score: () => 5,
    capPerDay: 50,
  },

  {
    id: "cleaning_tasks_saved",
    description: "Planning XP for saving cleaning tasks / plan",
    match: (evt) => isType(evt, "cleaning/tasksSaved"),
    score: (evt) => {
      const d = evt.data || {};
      const count =
        asInt(d.count, 0) ||
        asInt(Array.isArray(d.tasks) ? d.tasks.length : 0, 0) ||
        asInt(Array.isArray(d.items) ? d.items.length : 0, 0);
      // 10 base + 1 per task (cap 30)
      return clamp(10 + clamp(count, 0, 30), 5, 60);
    },
    capPerDay: 120,
  },

  {
    id: "inventory_updated_usage",
    description:
      "Small XP for responsibly updating inventory (consumption/restock)",
    match: (evt) => isType(evt, "inventory/updated"),
    score: (evt) => {
      const d = evt.data || {};
      const diffs = Array.isArray(d.diffs) ? d.diffs : [];
      if (!diffs.length) return 1;

      // reward meaningful updates, discourage spam:
      // +2 per unique item changed (cap 25)
      const unique = new Set(
        diffs
          .map((x) => safeString(x?.id || x?.sku || x?.itemId || x?.name))
          .filter(Boolean)
      );
      let xp = 2 * unique.size;

      // if any negative delta (usage) and any positive delta (restock), bonus
      const hasNeg = diffs.some((x) => Number(x?.delta) < 0);
      const hasPos = diffs.some((x) => Number(x?.delta) > 0);
      if (hasNeg && hasPos) xp += 6;

      return clamp(xp, 1, 60);
    },
    capPerDay: 200,
  },

  {
    id: "garden_harvest_logged",
    description: "XP for logging garden harvest",
    match: (evt) => isType(evt, "garden/harvestLogged"),
    score: (evt) => {
      const d = evt.data || {};
      const items = Array.isArray(d.items)
        ? d.items
        : Array.isArray(d.harvest)
        ? d.harvest
        : [];
      const count = items.length || asInt(d.count, 0) || 1;

      // 12 base + 3 per harvest item (cap 20 items)
      return clamp(12 + 3 * clamp(count, 0, 20), 8, 120);
    },
    capPerDay: 200,
  },

  {
    id: "preservation_completed",
    description:
      "XP for completing a preservation batch (canning, drying, fermenting, etc.)",
    match: (evt) => isType(evt, "preservation/completed"),
    score: (evt) => {
      const d = evt.data || {};
      // expected: { method, jars, weightKg, durationSec, difficulty? }
      const jars = asInt(d.jars, 0);
      const weightKg = Number(d.weightKg ?? d.kg ?? 0);
      const durationSec = asInt(d.durationSec ?? 0, 0);
      const difficulty = clamp(Number(d.difficulty ?? 1.2), 0.7, 2.5);

      let xp = 30;
      xp += clamp(jars, 0, 60) * 1; // +1 per jar
      xp += clamp(Math.floor(weightKg * 4), 0, 80); // +4 per kg (cap)
      xp += clamp(Math.floor(durationSec / 900), 0, 20); // +1 per 15 min
      xp = Math.round(xp * difficulty);

      return clamp(xp, 15, 300);
    },
    capPerDay: 900,
  },

  {
    id: "mealplan_updated",
    description: "XP for updating meal plan (planning discipline)",
    match: (evt) => isType(evt, "mealplan/updated"),
    score: (evt) => {
      const d = evt.data || {};
      const days = asInt(d.days, 0) || asInt(d.horizonDays, 0) || 7;
      // base 10 + 2 per day planned (cap 14 days)
      return clamp(10 + 2 * clamp(days, 0, 14), 5, 60);
    },
    capPerDay: 120,
  },
];

/* ------------------------- streaks + badge evaluation ------------------------ */

/**
 * A simple streak model:
 *  - dailyActive: did the actor earn any XP today?
 *  - streakDays: consecutive dailyActive days
 */
export function updateDailyStreak(
  profile,
  ledgerEntries,
  actorId,
  dayKeyFn = toDayKeyLocal
) {
  const p = { ...(profile || {}) };
  const actor = safeString(actorId || p.actorId || "default");

  // Build a set of day keys where XP > 0
  const daySet = new Set();
  for (const e of ledgerEntries || []) {
    if (!e || safeString(e.actorId) !== actor) continue;
    if (asInt(e.xp, 0) <= 0) continue;
    const dk = safeString(e.dayKey || (e.ts ? dayKeyFn(e.ts) : ""));
    if (dk) daySet.add(dk);
  }

  if (!daySet.size) {
    p.streakDays = 0;
    p.lastActiveDayKey = "";
    return p;
  }

  // Determine streak ending at latest active day
  const daysSorted = Array.from(daySet).sort(); // "YYYY-MM-DD"
  const last = daysSorted[daysSorted.length - 1];

  let streak = 1;
  let cur = last;
  for (;;) {
    const prev = prevDayKey(cur);
    if (daySet.has(prev)) {
      streak += 1;
      cur = prev;
      continue;
    }
    break;
  }

  p.streakDays = streak;
  p.lastActiveDayKey = last;
  return p;
}

function toDayKeyLocal(tsOrISO) {
  const d = new Date(tsOrISO);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prevDayKey(dayKey) {
  const d = new Date(`${dayKey}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return toDayKeyLocal(d.toISOString());
}

/**
 * Basic badge evaluation hooks.
 * You can extend badges by calling configure({ badges: [...] })
 */
export const DefaultBadges = [
  {
    id: "first_steps",
    name: "First Steps",
    description: "Earn your first XP.",
    test: (profile) => asInt(profile?.totalXp, 0) > 0,
  },
  {
    id: "level_5",
    name: "Level 5",
    description: "Reach level 5.",
    test: (profile) => asInt(profile?.level, 1) >= 5,
  },
  {
    id: "streak_7",
    name: "7-Day Streak",
    description: "Earn XP 7 days in a row.",
    test: (profile) => asInt(profile?.streakDays, 0) >= 7,
  },
  {
    id: "streak_30",
    name: "30-Day Streak",
    description: "Earn XP 30 days in a row.",
    test: (profile) => asInt(profile?.streakDays, 0) >= 30,
  },
];

/* ------------------------------ engine state ------------------------------- */

const _state = {
  rules: [...DefaultXpRules],
  badges: [...DefaultBadges],
  curveFn: defaultXpForNextLevel,
  // caps tracker: { [actorId]: { [dayKey]: { [ruleId]: xpAwarded } } }
  dailyCaps: new Map(),
  // options
  toastOnLevelUp: true,
  emitEvents: true,
  dayKeyFn: toDayKeyLocal,
};

/* -------------------------------- configure ------------------------------- */

export function configure(opts = {}) {
  if (!isPlainObject(opts)) return getConfig();
  if (Array.isArray(opts.rules)) _state.rules = opts.rules.slice();
  if (Array.isArray(opts.badges)) _state.badges = opts.badges.slice();
  if (typeof opts.curveFn === "function") _state.curveFn = opts.curveFn;

  if (typeof opts.toastOnLevelUp === "boolean")
    _state.toastOnLevelUp = opts.toastOnLevelUp;
  if (typeof opts.emitEvents === "boolean") _state.emitEvents = opts.emitEvents;
  if (typeof opts.dayKeyFn === "function") _state.dayKeyFn = opts.dayKeyFn;

  return getConfig();
}

export function getConfig() {
  return {
    rules: _state.rules.slice(),
    badges: _state.badges.slice(),
    curveFn: _state.curveFn,
    toastOnLevelUp: _state.toastOnLevelUp,
    emitEvents: _state.emitEvents,
    dayKeyFn: _state.dayKeyFn,
  };
}

/* -------------------------- ledger + award pipeline ------------------------- */

/**
 * Create a ledger entry (normalized).
 */
export function makeLedgerEntry({
  actorId = "default",
  householdId = "default",
  event = null,
  ruleId = "manual",
  xp = 0,
  note = "",
  meta = {},
} = {}) {
  const evt = normalizeXpEvent(event);
  const ts = evt.ts || nowISO();
  const dayKey = _state.dayKeyFn(ts);

  return {
    id: genId("xpl"),
    ts,
    dayKey,
    actorId: safeString(actorId),
    householdId: safeString(householdId),
    type: safeString(evt.type || "unknown"),
    source: safeString(evt.source || "unknown"),
    ruleId: safeString(ruleId),
    xp: asInt(xp, 0),
    note: safeString(note),
    meta: isPlainObject(meta) ? meta : { value: meta },
    eventEnvelope: evt._envelope || null, // optional reference
  };
}

function getDailyCapBucket(actorId, dayKey) {
  const a = safeString(actorId || "default");
  let actorMap = _state.dailyCaps.get(a);
  if (!actorMap) {
    actorMap = new Map();
    _state.dailyCaps.set(a, actorMap);
  }
  let dayMap = actorMap.get(dayKey);
  if (!dayMap) {
    dayMap = new Map();
    actorMap.set(dayKey, dayMap);
  }
  return dayMap; // Map(ruleId -> xpAwarded)
}

function applyRuleCaps(actorId, dayKey, rule, proposedXp) {
  const xp = asInt(proposedXp, 0);
  const cap = asInt(rule?.capPerDay, 0);
  if (!cap) return { xp, capped: false };

  const dayMap = getDailyCapBucket(actorId, dayKey);
  const used = asInt(dayMap.get(rule.id) || 0, 0);

  if (used >= cap) return { xp: 0, capped: true, remaining: 0 };

  const remaining = cap - used;
  const finalXp = clamp(xp, 0, remaining);
  dayMap.set(rule.id, used + finalXp);

  return {
    xp: finalXp,
    capped: finalXp !== xp,
    remaining: remaining - finalXp,
  };
}

/**
 * Score an event against configured rules and return ledger entries.
 * Caller can persist these entries.
 */
export function scoreEventToLedgerEntries(event, ctx = {}) {
  const evt = normalizeXpEvent(event);

  const actorId = safeString(ctx.actorId || "default");
  const householdId = safeString(ctx.householdId || "default");
  const ts = evt.ts || nowISO();
  const dayKey = _state.dayKeyFn(ts);

  const entries = [];

  for (const rule of _state.rules) {
    try {
      if (
        !rule?.id ||
        typeof rule?.match !== "function" ||
        typeof rule?.score !== "function"
      )
        continue;
      if (!rule.match(evt, ctx)) continue;

      const rawXp = asInt(rule.score(evt, ctx), 0);
      if (rawXp <= 0) continue;

      const capped = applyRuleCaps(actorId, dayKey, rule, rawXp);
      if (capped.xp <= 0) continue;

      entries.push(
        makeLedgerEntry({
          actorId,
          householdId,
          event: evt,
          ruleId: rule.id,
          xp: capped.xp,
          note: rule.description || "",
          meta: {
            ...(isPlainObject(ctx.meta) ? ctx.meta : {}),
            capApplied: !!capped.capped,
            capRemaining: Number.isFinite(capped.remaining)
              ? capped.remaining
              : undefined,
          },
        })
      );
    } catch {
      // ignore individual rule failures
    }
  }

  return entries;
}

/**
 * Apply ledger entries to an XP profile and compute new level/badges.
 *
 * Profile shape (recommended)
 * -----------------------------------------------------------------------------
 * {
 *   actorId, householdId,
 *   totalXp, level, xpIntoLevel, xpForNext, progress,
 *   streakDays, lastActiveDayKey,
 *   badges: [{id, earnedAtISO}],
 *   updatedAtISO
 * }
 */
export function applyLedgerToProfile(profile, ledgerEntries) {
  const p = isPlainObject(profile) ? { ...profile } : {};
  const entries = Array.isArray(ledgerEntries) ? ledgerEntries : [];

  const beforeTotal = asInt(p.totalXp, 0);
  const gained = entries.reduce((sum, e) => sum + asInt(e?.xp, 0), 0);

  const afterTotal = beforeTotal + gained;
  const beforeLevel = computeLevel(beforeTotal, _state.curveFn);
  const afterLevel = computeLevel(afterTotal, _state.curveFn);

  p.totalXp = afterTotal;
  p.level = afterLevel.level;
  p.xpIntoLevel = afterLevel.xpIntoLevel;
  p.xpForNext = afterLevel.xpForNext;
  p.progress = afterLevel.progress;
  p.updatedAtISO = nowISO();

  // streak update (requires access to whole ledger; caller can pass in their full ledger)
  // Here we only infer from passed entries (minimum viable):
  try {
    const actorId = safeString(p.actorId || entries?.[0]?.actorId || "default");
    const tempLedger = Array.isArray(p._ledgerForStreak)
      ? p._ledgerForStreak
      : entries;
    const upd = updateDailyStreak(p, tempLedger, actorId, _state.dayKeyFn);
    p.streakDays = upd.streakDays;
    p.lastActiveDayKey = upd.lastActiveDayKey;
  } catch {
    // ignore
  }

  // badge evaluation
  const earned = new Set((p.badges || []).map((b) => b?.id).filter(Boolean));
  const newlyEarned = [];

  for (const b of _state.badges) {
    if (!b?.id || typeof b?.test !== "function") continue;
    if (earned.has(b.id)) continue;
    let ok = false;
    try {
      ok = !!b.test(p, entries);
    } catch {
      ok = false;
    }
    if (ok) {
      newlyEarned.push({
        id: b.id,
        earnedAtISO: nowISO(),
        name: b.name,
        description: b.description,
      });
      earned.add(b.id);
    }
  }

  if (!Array.isArray(p.badges)) p.badges = [];
  if (newlyEarned.length) {
    p.badges = [
      ...p.badges,
      ...newlyEarned.map((x) => ({ id: x.id, earnedAtISO: x.earnedAtISO })),
    ];
    p._newBadges = newlyEarned;
  } else {
    p._newBadges = [];
  }

  p._delta = {
    gained,
    beforeTotal,
    afterTotal,
    levelBefore: beforeLevel.level,
    levelAfter: afterLevel.level,
    leveledUp: afterLevel.level > beforeLevel.level,
  };

  return p;
}

/**
 * Main award function:
 *  - scores event
 *  - returns { entries, profilePatch, delta }
 *
 * Caller is responsible for:
 *  - persisting entries
 *  - persisting updated profile
 *
 * @param {any} event
 * @param {{
 *   actorId?: string,
 *   householdId?: string,
 *   profile?: object,
 *   ledgerForStreak?: Array, // optional whole ledger for proper streak evaluation
 *   meta?: object
 * }} ctx
 */
export function award(event, ctx = {}) {
  const actorId = safeString(ctx.actorId || ctx.profile?.actorId || "default");
  const householdId = safeString(
    ctx.householdId || ctx.profile?.householdId || "default"
  );

  const entries = scoreEventToLedgerEntries(event, {
    ...ctx,
    actorId,
    householdId,
  });

  const baseProfile = isPlainObject(ctx.profile) ? { ...ctx.profile } : {};
  baseProfile.actorId = actorId;
  baseProfile.householdId = householdId;

  // optional full ledger for streak computation
  if (Array.isArray(ctx.ledgerForStreak)) {
    baseProfile._ledgerForStreak = ctx.ledgerForStreak;
  }

  const nextProfile = applyLedgerToProfile(baseProfile, entries);

  const delta = nextProfile._delta || { gained: 0, leveledUp: false };
  const newBadges = nextProfile._newBadges || [];

  // emit SSA events (optional)
  if (_state.emitEvents) {
    try {
      emit("gamification/xp.awarded", {
        actorId,
        householdId,
        gained: delta.gained,
        entries,
        level: nextProfile.level,
        progress: nextProfile.progress,
        badges: newBadges,
      });

      if (delta.leveledUp) {
        emit("gamification/level.up", {
          actorId,
          householdId,
          from: delta.levelBefore,
          to: delta.levelAfter,
          totalXp: nextProfile.totalXp,
        });
        if (_state.toastOnLevelUp) {
          emitToast({
            variant: "success",
            title: `Level Up!`,
            message: `You reached level ${delta.levelAfter}.`,
          });
        }
      }

      if (newBadges.length) {
        emit("gamification/badges.earned", {
          actorId,
          householdId,
          badges: newBadges,
        });
      }
    } catch {
      // noop
    }
  }

  // cleanup internals
  delete nextProfile._delta;
  delete nextProfile._newBadges;
  delete nextProfile._ledgerForStreak;

  return { entries, profile: nextProfile, delta, newBadges };
}

/**
 * Award XP from a signal name + data (without building full envelopes).
 * Useful for manual calls.
 */
export function awardFromSignal(type, data, ctx = {}) {
  const evt = {
    type: safeString(type || "manual"),
    ts: nowISO(),
    source: ctx?.source || SOURCE,
    data: isPlainObject(data) ? data : { value: data },
  };
  return award(evt, ctx);
}

/* -------------------- eventBus subscription / auto-awarding ----------------- */

/**
 * Subscribe the XP engine to SSA events and auto-award.
 *
 * You provide a persistence adapter so XP can be saved properly.
 *
 * adapter contract:
 * -----------------------------------------------------------------------------
 * {
 *   getProfile: async ({actorId, householdId}) => profileObj | null
 *   saveProfile: async (profileObj) => void
 *   appendLedger: async (entriesArray) => void
 *   getLedgerForStreak?: async ({actorId, householdId, daysBack}) => entries[]
 * }
 *
 * Returns unsubscribe function.
 */
export function subscribeToEventBus({
  patterns = [
    "session/**",
    "cleaning/**",
    "inventory/**",
    "garden/**",
    "preservation/**",
    "mealplan/**",
  ],
  adapter,
  actorId = "default",
  householdId = "default",
  daysBackForStreak = 45,
  priority = -5,
} = {}) {
  if (!eventBus?.on) return () => {};

  const pats =
    Array.isArray(patterns) && patterns.length ? patterns : ["session/**"];

  const handler = async (envelope, meta) => {
    try {
      const evt = normalizeXpEvent(envelope);
      const aId = safeString(actorId);
      const hId = safeString(householdId);

      const profile = (await adapter?.getProfile?.({
        actorId: aId,
        householdId: hId,
      })) || {
        actorId: aId,
        householdId: hId,
        totalXp: 0,
        badges: [],
      };

      let ledgerForStreak = null;
      if (adapter?.getLedgerForStreak) {
        ledgerForStreak = await adapter.getLedgerForStreak({
          actorId: aId,
          householdId: hId,
          daysBack: daysBackForStreak,
        });
      }

      const res = award(evt, {
        actorId: aId,
        householdId: hId,
        profile,
        ledgerForStreak,
        meta: { fromEvent: meta?.event || evt.type },
      });

      if (res?.entries?.length) {
        await adapter?.appendLedger?.(res.entries);
        await adapter?.saveProfile?.(res.profile);
      }
    } catch {
      // ignore
    }
  };

  const unsubs = pats.map((p) =>
    eventBus.on(p, handler, { priority, replayLast: false })
  );
  return () => {
    for (const u of unsubs) {
      try {
        if (typeof u === "function") u();
      } catch {}
    }
  };
}

/* --------------------------------- exports -------------------------------- */

export const xpEngine = {
  configure,
  getConfig,

  computeLevel,
  defaultXpForNextLevel,
  getLevelProgress,

  normalizeXpEvent,
  makeLedgerEntry,

  scoreEventToLedgerEntries,
  applyLedgerToProfile,

  award,
  awardFromSignal,

  subscribeToEventBus,

  DefaultXpRules,
  DefaultBadges,
};

export default xpEngine;
