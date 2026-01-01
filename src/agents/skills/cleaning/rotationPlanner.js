/**
 * src/agents/skills/cleaning/rotationPlanner.js
 *
 * How this fits:
 * - Creates a forward-looking cleaning rotation (schedule) from a CleaningPlan-like object
 *   plus per-zone cadence rules (daily/weekly/biweekly/monthly/custom RRULE-ish).
 * - Returns "suggested sessions" and (optionally) materializes real SSA Sessions
 *   using composeRoutine() for the "cleaning" domain.
 * - Emits `automation.schedule.request` so your Automation Runtime can pick up and
 *   persist/enqueue items; also supports a soft Dexie write if SessionsRepo exists.
 *
 * Events (optional):
 * - automation.schedule.request  (payload: { type, ts, source, data })
 *
 * Extension points:
 * - registerCadence(name, fn): add more cadence calculators.
 * - addGuardAdvisor(fn): inject guard-aware scheduling tweaks (quiet hours, sabbath, weather).
 * - setDefaultOptions({ weekStartsOn, quietHours, sabbathDays, timezone })
 *
 * Notes:
 * - Deliberately does NOT handle wake-lock, notifications, or runner state. This is planning only.
 * - If `materializeSessions` is true, will call composeRoutine(plan, { ... }) and persist/enqueue.
 */

import { emit } from "@/services/eventBus"; // safe-optional
let composeRoutine = null; // lazy-loaded to avoid circular deps

/* -------------------------------- Types ----------------------------------- */
/**
 * @typedef {Object} CleaningPlanLike
 * @property {string} id
 * @property {string} title
 * @property {Array<{ id:string, name:string, tasks:Array<any>, priority?: "high"|"medium"|"low" }>} zones
 * @property {Record<string,any>} [meta]
 */

/**
 * @typedef {Object} ZoneRule
 * @property {"daily"|"weekly"|"biweekly"|"monthly"|"custom"} cadence
 * @property {Array<number>} [byWeekday]     // 0..6 (Sun..Sat) — for weekly/biweekly/custom
 * @property {Array<number>} [byMonthday]    // 1..31             — for monthly/custom
 * @property {string}        [at]            // "HH:MM" local time (24h)
 * @property {string}        [rrule]         // optional string for custom cadence (lightweight)
 * @property {string}        [lastDoneAt]    // ISO timestamp, seed next occurrence
 * @property {"high"|"medium"|"low"} [priority]
 * @property {boolean}       [outdoor]       // schedule away from bad weather (advisory only)
 * @property {boolean}       [avoidQuietHours] // default true for noisy tasks
 */

/**
 * @typedef {Object} RotationOptions
 * @property {number}  [horizonDays]        // how far ahead to plan; default 21
 * @property {number}  [maxPerZone]         // cap per-zone occurrences; default 6
 * @property {{start:string,end:string}} [quietHours] // "HH:MM" local time window
 * @property {Array<number>} [sabbathDays]  // 0..6 (Sun..Sat) treated as sabbath; default [5] (Fri sunset..Sat)
 * @property {number}  [weekStartsOn]       // 0..6, default 0 (Sunday)
 * @property {string}  [timezone]           // IANA tz string, best-effort local default
 * @property {boolean} [materializeSessions]// compose & emit schedule requests
 * @property {Object}  [composePrefs]       // forwarded to composeRoutine({ prefs })
 * @property {(supply:string)=>boolean} [inventoryHas]
 * @property {(equipment:string)=>boolean} [equipmentHas]
 */

/**
 * @typedef {Object} SuggestedSlot
 * @property {string} id
 * @property {string} planId
 * @property {string} zoneId
 * @property {string} zoneName
 * @property {string} scheduledAt // ISO local-converted
 * @property {"high"|"medium"|"low"} priority
 * @property {number} estimatedDurationSec
 * @property {Array<"quietHours"|"sabbath"|"weather"|"inventory"|"equipment">} blockers // advisory
 */

/* ------------------------------- Defaults --------------------------------- */

const DEFAULTS = {
  horizonDays: 21,
  maxPerZone: 6,
  weekStartsOn: 0,
  quietHours: { start: "21:00", end: "07:00" }, // 9pm–7am
  sabbathDays: [6], // Saturday
  timezone: undefined, // use browser/local
};

export function setDefaultOptions(partial = {}) {
  Object.assign(DEFAULTS, sanitize(partial));
}

/* -------------------------- Guard Advisor Hooks ---------------------------- */

const guardAdvisors = [];
/**
 * Add custom guard-aware scheduling advice.
 * @param {(ctx:{plan:CleaningPlanLike, zone:any, rule:ZoneRule, candidate:Date, options:RotationOptions})=>Array<string>|null} fn
 */
export function addGuardAdvisor(fn) {
  if (typeof fn === "function") guardAdvisors.push(fn);
}

/* Built-in advisors */
addGuardAdvisor(({ rule, candidate, options }) => {
  const b = new Set();
  if (isSabbath(candidate, options)) b.add("sabbath");
  if (isInQuietHours(candidate, options?.quietHours)) b.add("quietHours");
  // equipment/weather are heuristics at planning time — conservatively flag outdoor
  if (rule?.outdoor) b.add("weather");
  return Array.from(b);
});

/* --------------------------- Cadence Calculators --------------------------- */

const cadenceMap = new Map();

/**
 * Register/override a cadence function.
 * fn signature: (seed:Date, rule:ZoneRule, options:RotationOptions) => Date[]
 */
export function registerCadence(name, fn) {
  cadenceMap.set(String(name), fn);
}

/* Built-in: daily */
registerCadence("daily", (seed, rule, options) => {
  const out = [];
  const at = rule?.at || "09:00";
  for (let i = 0; i < options.maxPerZone && i < options.horizonDays; i++) {
    out.push(withLocalTime(addDays(seed, i + 1), at, options.timezone));
  }
  return out;
});

/* Built-in: weekly */
registerCadence("weekly", (seed, rule, options) => {
  const out = [];
  const at = rule?.at || "09:00";
  const days = Array.isArray(rule?.byWeekday) && rule.byWeekday.length ? rule.byWeekday : [options.weekStartsOn];
  let d = startOfDay(addDays(seed, 1));
  const end = addDays(seed, options.horizonDays + 1);
  while (d < end && out.length < options.maxPerZone) {
    if (days.includes(d.getDay())) out.push(withLocalTime(d, at, options.timezone));
    d = addDays(d, 1);
  }
  return out;
});

/* Built-in: biweekly (every other week on given weekdays) */
registerCadence("biweekly", (seed, rule, options) => {
  const base = cadenceMap.get("weekly")(seed, rule, { ...options, horizonDays: options.horizonDays * 2 }); // generate more, filter alt weeks
  const out = [];
  for (const dt of base) {
    if (out.length >= options.maxPerZone) break;
    // Even/odd week distance from seed
    const diffWeeks = Math.floor((startOfDay(dt) - startOfDay(seed)) / (7 * 24 * 3600 * 1000));
    if (diffWeeks % 2 === 1) out.push(dt); // schedule on alternate week from seed
  }
  return out;
});

/* Built-in: monthly — by day of month */
registerCadence("monthly", (seed, rule, options) => {
  const out = [];
  const at = rule?.at || "09:00";
  const dom = Array.isArray(rule?.byMonthday) && rule.byMonthday.length ? rule.byMonthday : [seed.getDate()];
  let m = new Date(seed);
  for (let i = 0; i < options.maxPerZone; i++) {
    m = addMonths(m, 1);
    for (const day of dom) {
      const dt = new Date(m.getFullYear(), m.getMonth(), clampInt(day, 1, daysInMonth(m)), 0, 0, 0, 0);
      out.push(withLocalTime(dt, at, options.timezone));
      if (out.length >= options.maxPerZone) break;
    }
    if (out.length >= options.maxPerZone) break;
  }
  // Clip to horizon
  return out.filter((d) => d <= addDays(seed, options.horizonDays + 1));
});

/* Built-in: custom (lightweight RRULE-ish) */
registerCadence("custom", (seed, rule, options) => {
  // Supported tokens (very small subset):
  // FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0
  // FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=10
  // FREQ=DAILY;BYHOUR=8;BYMINUTE=30
  const out = [];
  const parsed = parseRRULE(rule?.rrule || "");
  if (!parsed) return cadenceMap.get("weekly")(seed, rule, options); // fallback

  const at = formatTimeFromRRULE(parsed) || rule?.at || "09:00";
  const end = addDays(seed, options.horizonDays + 1);

  if (parsed.FREQ === "DAILY") {
    let d = startOfDay(addDays(seed, 1));
    while (d < end && out.length < options.maxPerZone) {
      out.push(withLocalTime(d, at, options.timezone));
      d = addDays(d, 1);
    }
    return out;
  }

  if (parsed.FREQ === "WEEKLY") {
    const days = (parsed.BYDAY || []).map(dayOfWeekFromToken);
    let d = startOfDay(addDays(seed, 1));
    while (d < end && out.length < options.maxPerZone) {
      if (!days.length || days.includes(d.getDay())) out.push(withLocalTime(d, at, options.timezone));
      d = addDays(d, 1);
    }
    return out;
  }

  if (parsed.FREQ === "MONTHLY") {
    const dom = (parsed.BYMONTHDAY || []).map((n) => clampInt(n, 1, 31));
    let m = new Date(seed);
    for (let i = 0; i < options.maxPerZone; i++) {
      m = addMonths(m, 1);
      for (const day of dom.length ? dom : [seed.getDate()]) {
        const dt = new Date(m.getFullYear(), m.getMonth(), clampInt(day, 1, daysInMonth(m)));
        out.push(withLocalTime(dt, at, options.timezone));
        if (out.length >= options.maxPerZone) break;
      }
      if (out.length >= options.maxPerZone) break;
    }
    return out.filter((d) => d <= end);
  }

  // default fallback
  return cadenceMap.get("weekly")(seed, rule, options);
});

/* ------------------------------- Public API -------------------------------- */

/**
 * Build a rotation (suggested slots) for all zones in a plan given per-zone rules.
 * Optionally materializes sessions and emits an automation schedule request event.
 *
 * @param {CleaningPlanLike} plan
 * @param {Record<string, ZoneRule>} rulesByZoneId
 * @param {RotationOptions} [options]
 * @returns {{ slots: SuggestedSlot[], sessions?: any[] }}
 */
export async function buildRotation(plan, rulesByZoneId = {}, options = {}) {
  const opts = applyDefaults(options);
  const now = new Date();
  const seed = opts._seedDate || now; // testability
  const slots = [];

  for (const zone of plan?.zones || []) {
    const rule = sanitize(rulesByZoneId[zone.id] || {});
    const cadenceFn = cadenceMap.get(rule.cadence || "weekly") || cadenceMap.get("weekly");

    const seedDate = rule.lastDoneAt ? safeDate(rule.lastDoneAt) || seed : seed;
    const candidates = cadenceFn(seedDate, rule, opts);

    for (const dt of candidates) {
      if (slots.length >= 1000) break; // hard cap for safety
      const blockers = adviseGuards(plan, zone, rule, dt, opts);
      const prio = rule.priority || zone.priority || "medium";
      const dur = estimateZoneDuration(zone);

      slots.push({
        id: `slot-clean-${zone.id}-${dt.toISOString()}`,
        planId: plan.id,
        zoneId: zone.id,
        zoneName: zone.name,
        scheduledAt: dt.toISOString(),
        priority: prio,
        estimatedDurationSec: dur,
        blockers,
      });
    }
  }

  // Sort: by datetime, then priority (high first)
  slots.sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : a.scheduledAt > b.scheduledAt ? 1 : prioRank(b.priority) - prioRank(a.priority)));

  let sessions = undefined;

  if (opts.materializeSessions) {
    // Lazy import composeRoutine to avoid circular deps if any
    composeRoutine = composeRoutine || (await softImport("@/agents/skills/cleaning/composeRoutine")).composeRoutine;
    if (typeof composeRoutine === "function") {
      sessions = await materialize(plan, slots, opts);
    }
  }

  // Emit a single automation.schedule.request envelope for the batch (analytics-friendly)
  try {
    emit?.({
      type: "automation.schedule.request",
      ts: new Date().toISOString(),
      source: "cleaning.rotationPlanner",
      data: {
        planId: plan?.id || null,
        count: slots.length,
        materialized: Array.isArray(sessions) ? sessions.length : 0,
      },
    });
  } catch {}

  return { slots, sessions };
}

/* ----------------------------- Materialization ----------------------------- */

async function materialize(plan, slots, opts) {
  const out = [];
  for (const slot of slots) {
    // Compose a session limited to the specific zone
    const zone = (plan.zones || []).find((z) => z.id === slot.zoneId);
    if (!zone) continue;

    const subPlan = {
      id: `${plan.id}__${zone.id}`,
      title: `${plan.title} — ${zone.name}`,
      zones: [zone],
      meta: { ...plan.meta },
      source: plan.source,
    };

    const session = composeRoutine(subPlan, {
      prefs: opts.composePrefs || { voiceGuidance: true, haptic: true, autoAdvance: false },
      inventoryHas: opts.inventoryHas,
      equipmentHas: opts.equipmentHas,
      defaultStepDurationSec: 120,
      nowIso: new Date().toISOString(),
    });

    // Stash scheduledAt (not in base contract; runner can read this from analytics/meta)
    session.analytics = session.analytics || {};
    session.analytics.scheduledAt = slot.scheduledAt;
    session.analytics.priority = slot.priority;

    out.push(session);
  }

  // Soft-write to SessionsRepo if available (Dexie or your repo abstraction)
  try {
    const repo = await softImport("@/data/SessionsRepo");
    if (repo?.createManyPending) {
      await repo.createManyPending(out);
    } else if (repo?.create) {
      for (const s of out) await repo.create(s);
    }
  } catch {
    // no-op if repo not present — automation runtime may persist from event
  }

  return out;
}

/* --------------------------- Guard / Heuristic bits ------------------------ */

function adviseGuards(plan, zone, rule, dt, options) {
  const blocks = new Set();
  for (const fn of guardAdvisors) {
    const res = safeCall(fn, { plan, zone, rule, candidate: dt, options }) || [];
    for (const b of res) blocks.add(b);
  }
  // quietHours avoidance hint
  if ((rule?.avoidQuietHours ?? true) && isInQuietHours(dt, options.quietHours)) blocks.add("quietHours");
  // sabbath awareness (already added by advisor)
  return Array.from(blocks);
}

function isInQuietHours(date, quiet = DEFAULTS.quietHours) {
  const { start = "21:00", end = "07:00" } = quiet || {};
  const h = date.getHours();
  const m = date.getMinutes();
  const cur = h * 60 + m;
  const { min: sMin, max: eMin } = timeToMinRange(start, end);
  // If window crosses midnight, quiet if cur >= start || cur < end
  return sMin < eMin ? (cur >= sMin && cur < eMin) : (cur >= sMin || cur < eMin);
}

function isSabbath(date, options) {
  const days = Array.isArray(options?.sabbathDays) ? options.sabbathDays : DEFAULTS.sabbathDays;
  return days.includes(date.getDay());
}

function estimateZoneDuration(zone) {
  // quick heuristic: sum task hints if present; else 6 min per task + 1 min header + 1 min wrap
  let total = 120; // header + wrap baseline
  for (const t of zone?.tasks || []) {
    if (Number.isFinite(t?.durationSec)) total += clampInt(t.durationSec, 10, 8 * 3600);
    else total += 6 * 60;
  }
  return total;
}

/* ------------------------------- RRULE parse ------------------------------- */

function parseRRULE(s) {
  if (!s || typeof s !== "string") return null;
  const parts = s.split(";").map((p) => p.trim()).filter(Boolean);
  const out = {};
  for (const p of parts) {
    const [k, v] = p.split("=").map((x) => x.trim());
    if (!k) continue;
    if (k === "BYDAY") out[k] = v.split(",").map((x) => x.trim());
    else if (k === "BYMONTHDAY") out[k] = v.split(",").map((n) => parseInt(n, 10));
    else if (k === "FREQ") out[k] = v.toUpperCase();
    else if (k === "BYHOUR") out[k] = parseInt(v, 10);
    else if (k === "BYMINUTE") out[k] = parseInt(v, 10);
  }
  return out;
}

function formatTimeFromRRULE(parsed) {
  if (Number.isFinite(parsed?.BYHOUR)) {
    const hh = pad2(parsed.BYHOUR);
    const mm = pad2(Number.isFinite(parsed.BYMINUTE) ? parsed.BYMINUTE : 0);
    return `${hh}:${mm}`;
  }
  return "";
}

function dayOfWeekFromToken(tok) {
  switch (tok?.toUpperCase()) {
    case "SU": return 0; case "MO": return 1; case "TU": return 2; case "WE": return 3;
    case "TH": return 4; case "FR": return 5; case "SA": return 6;
    default: return NaN;
  }
}

/* ------------------------------ Date helpers ------------------------------- */

function addDays(d, n) { const dt = new Date(d); dt.setDate(dt.getDate() + n); return dt; }
function addMonths(d, n) { const dt = new Date(d); dt.setMonth(dt.getMonth() + n); return dt; }
function startOfDay(d) { const dt = new Date(d); dt.setHours(0, 0, 0, 0); return dt; }

function daysInMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }

function withLocalTime(date, hhmm = "09:00", tz) {
  // Build local time at hh:mm in the user's timezone (best-effort)
  const base = new Date(date);
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  base.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  return base;
}

function timeToMinRange(start, end) {
  const [sh, sm] = (start || "21:00").split(":").map((n) => parseInt(n, 10));
  const [eh, em] = (end || "07:00").split(":").map((n) => parseInt(n, 10));
  return { min: (sh * 60 + (sm || 0)) % (24 * 60), max: (eh * 60 + (em || 0)) % (24 * 60) };
}

function pad2(n) { return String(n).padStart(2, "0"); }
function clampInt(n, min, max) { const v = Math.round(Number(n) || 0); return Math.min(Math.max(v, min), max); }
function safeDate(iso) { const d = new Date(iso); return isFinite(d.getTime()) ? d : null; }
function sanitize(obj) { if (!obj || typeof obj !== "object") return {}; const o = {}; for (const k of Object.keys(obj)) if (obj[k] !== undefined) o[k] = obj[k]; return o; }
function applyDefaults(opts) { return { ...DEFAULTS, ...sanitize(opts) }; }
function safeCall(fn, ...args) { try { return fn?.(...args); } catch { return null; } }
function prioRank(p) { return p === "high" ? 3 : p === "medium" ? 2 : 1; }

/* ------------------------------ Soft imports ------------------------------- */

async function softImport(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.default || mod;
  } catch { return null; }
}

/* --------------------------------- Exports -------------------------------- */

export default {
  buildRotation,
  registerCadence,
  addGuardAdvisor,
  setDefaultOptions,
};
