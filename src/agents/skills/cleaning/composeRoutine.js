/**
 * src/agents/skills/cleaning/composeRoutine.js
 *
 * How this fits:
 * - Consumes a normalized CleaningPlan-like object (zones -> tasks) and composes a runnable
 *   SSA Session for the "cleaning" domain.
 * - Synthesizes prep/gather steps, staging, and safe fallbacks when durations or tasks are missing.
 * - Infers guard blockers: quietHours (noisy equipment), sabbath (plan meta), weather (outdoor),
 *   inventory (supplies missing), equipment (vacuum/steam-mop/etc. not available).
 * - Leaves emission/persistence to the caller (creator or SessionRunner).
 *
 * Extension points:
 * - addPrepSynthesizer(fn): inject more prep steps based on plan meta or household policies.
 * - addTimingHeuristic(fn): refine duration estimation (per task type/equipment/soil level).
 * - addGuardInferer(fn): extend or override guard inference logic.
 *
 * Contract references:
 * - Returns a Session object conforming to the shared SSA session contract.
 */

import { emit } from "@/services/events/eventBus"; // optional analytics (unused here to remain pure)

/** ------------------------------- Types ----------------------------------- */
/**
 * @typedef {Object} CleaningTask
 * @property {string} id
 * @property {string} title                   // e.g., "Vacuum carpet", "Wipe counters"
 * @property {string} [desc]
 * @property {number} [durationSec]           // optional explicit duration
 * @property {("vacuum"|"mop"|"steam-mop"|"wash"|"dry"|"laundry"|"declutter"|"dust"|"sanitize"|"windows"|"trash"|"outdoor"|"dishwasher"|"wipe"|"scrub"|"disinfect"|"polish")} [type]
 * @property {Array<string>} [supplies]       // e.g., ["dish soap","glass cleaner","microfiber cloth"]
 * @property {Array<string>} [equipment]      // e.g., ["vacuum","mop","steam cleaner"]
 * @property {("low"|"medium"|"high")} [soilLevel]
 * @property {boolean} [outdoor]              // weather-sensitive
 * @property {Record<string, any>} [meta]     // e.g., { fragranceFree:true, quietPreferred:true }
 */

/**
 * @typedef {Object} CleaningZone
 * @property {string} id
 * @property {string} name                    // "Kitchen", "Living Room", etc.
 * @property {Array<CleaningTask>} tasks
 * @property {("high"|"medium"|"low")} [priority]
 */

/**
 * @typedef {Object} CleaningPlanLike
 * @property {string} id
 * @property {string} title
 * @property {Array<CleaningZone>} zones
 * @property {Record<string, any>} [meta]     // e.g., { sabbathSensitive:true, fragranceFree:true }
 * @property {{ refUrl?: string, author?: string }} [source]
 */

/**
 * @typedef {Object} ComposeOptions
 * @property {{voiceGuidance?:boolean,haptic?:boolean,autoAdvance?:boolean}} [prefs]
 * @property {(supplyName:string)=>boolean} [inventoryHas] // check storehouse for supplies
 * @property {(equipmentName:string)=>boolean} [equipmentHas] // check equipment registry
 * @property {boolean} [assumeQuietHoursSensitive] // default true
 * @property {boolean} [assumeSabbathSensitive]    // default true
 * @property {boolean} [assumeWeatherSensitive]    // default true
 * @property {number}  [defaultStepDurationSec]    // default 120 (2min)
 * @property {string}  [nowIso]                    // default ISO now
 */

/** ------------------------------- Defaults -------------------------------- */

const SAFE_DEFAULT_STEP_SEC = 120;
const ISO_NOW = () => new Date().toISOString();

const NOISY_TYPES = new Set([
  "vacuum",
  "steam-mop",
  "wash",
  "dry",
  "laundry",
  "dishwasher",
  "polish",
]);
const OUTDOOR_TYPES = new Set(["outdoor", "windows"]);

/** -------------------------- Registries (extensible) ---------------------- */

const prepSynthesizers = [
  /** Stage supplies if plan lists any task with supplies */
  (plan) => {
    const allSupplies = new Set();
    for (const z of plan?.zones || []) {
      for (const t of z?.tasks || [])
        for (const s of t?.supplies || []) allSupplies.add(s);
    }
    if (!allSupplies.size) return null;
    return {
      title: "Stage supplies",
      desc: `Gather: ${Array.from(allSupplies).join(", ")}`,
      durationSec: 60,
      metadata: { cueNotes: "Mise en place" },
    };
  },
  /** Stage equipment */
  (plan) => {
    const allEquip = new Set();
    for (const z of plan?.zones || [])
      for (const t of z?.tasks || [])
        for (const e of t?.equipment || []) allEquip.add(e);
    if (!allEquip.size) return null;
    return {
      title: "Stage equipment",
      desc: `Prepare: ${Array.from(allEquip).join(", ")}`,
      durationSec: 60,
      metadata: { cueNotes: "Check batteries, fill tanks" },
    };
  },
  /** Pre-treat heavy soil (heuristic) */
  (plan) => {
    const heavy = (plan?.zones || []).some((z) =>
      (z?.tasks || []).some((t) => t.soilLevel === "high")
    );
    if (!heavy) return null;
    return {
      title: "Pre-treat heavy soil",
      desc: "Spray degreaser/spot remover where needed; soak 5–10 min.",
      durationSec: 5 * 60,
      metadata: { donenessCue: "timer", cueNotes: "Allow dwell time" },
    };
  },
];

const timingHeuristics = [
  // explicit duration
  (task, _ctx) =>
    Number.isFinite(task.durationSec)
      ? clamp(task.durationSec, 10, 8 * 3600)
      : null,
  // by type
  (task, _ctx) => {
    const t = (task.type || "").toLowerCase();
    if (t === "vacuum") return scaleBySoil(3 * 60, task.soilLevel);
    if (t === "mop" || t === "steam-mop")
      return scaleBySoil(4 * 60, task.soilLevel);
    if (t === "dust") return scaleBySoil(2 * 60, task.soilLevel);
    if (t === "sanitize" || t === "disinfect") return 3 * 60;
    if (t === "windows") return scaleBySoil(4 * 60, task.soilLevel);
    if (t === "declutter") return scaleBySoil(5 * 60, task.soilLevel);
    if (t === "wash" || t === "dry" || t === "laundry") return 60; // per action checkpoint (not full cycle)
    if (t === "trash") return 90;
    if (t === "wipe" || t === "scrub")
      return scaleBySoil(3 * 60, task.soilLevel);
    if (t === "polish") return 2 * 60;
    return null;
  },
  // fallback
  (_task, ctx) => ctx.defaultStepDurationSec ?? SAFE_DEFAULT_STEP_SEC,
];

const guardInferers = [
  // Inventory guard: required supplies missing
  (ctx, step) => {
    const blockers = new Set();
    if (
      ctx.inventoryHas &&
      Array.isArray(step.metadata?.supplies) &&
      step.metadata.supplies.length
    ) {
      const missing = step.metadata.supplies.filter(
        (s) => !ctx.inventoryHas(s)
      );
      if (missing.length) blockers.add("inventory");
    }
    return blockers;
  },
  // Equipment guard: equipment required but not available
  (ctx, step) => {
    const blockers = new Set();
    const eqs = Array.isArray(step.metadata?.equipment)
      ? step.metadata.equipment
      : [];
    if (
      ctx.equipmentHas &&
      eqs.length &&
      !eqs.every((e) => ctx.equipmentHas(e))
    ) {
      blockers.add("equipment");
    }
    return blockers;
  },
  // Quiet hours: noisy equipment types
  (ctx, step) => {
    const blockers = new Set();
    if (ctx.assumeQuietHoursSensitive !== false) {
      const eqs = Array.isArray(step.metadata?.equipment)
        ? step.metadata.equipment
        : [];
      const noisy = eqs.some((e) => NOISY_TYPES.has(String(e).toLowerCase()));
      if (noisy) blockers.add("quietHours");
    }
    return blockers;
  },
  // Weather: outdoor steps
  (ctx, step) => {
    const blockers = new Set();
    const isOutdoor =
      ctx.assumeWeatherSensitive !== false &&
      (step.metadata?.outdoor === true ||
        (Array.isArray(step.metadata?.equipment) &&
          step.metadata.equipment.some((e) =>
            OUTDOOR_TYPES.has(String(e).toLowerCase())
          )));
    if (isOutdoor) blockers.add("weather");
    return blockers;
  },
  // Sabbath: plan meta flag
  (ctx, _step) => {
    const blockers = new Set();
    if (
      ctx.assumeSabbathSensitive !== false &&
      ctx.planMeta?.sabbathSensitive
    ) {
      blockers.add("sabbath");
    }
    return blockers;
  },
];

/** --------------------------- Extension registration ---------------------- */

export function addPrepSynthesizer(fn) {
  if (typeof fn === "function") prepSynthesizers.push(fn);
}
export function addTimingHeuristic(fn) {
  if (typeof fn === "function") timingHeuristics.push(fn);
}
export function addGuardInferer(fn) {
  if (typeof fn === "function") guardInferers.push(fn);
}

/** ------------------------------- Public API ------------------------------- */

/**
 * Compose a runnable SSA Session for the cleaning domain from a CleaningPlan-like input.
 * @param {CleaningPlanLike} plan
 * @param {ComposeOptions} options
 * @returns {import('../../types').Session|any}
 */
export function composeRoutine(plan, options = {}) {
  const errs = validatePlan(plan);
  if (errs.length) console.warn("[composeRoutine] Invalid plan:", errs);

  const nowIso = options.nowIso || ISO_NOW();
  const sessionId = `sess-clean-${plan?.id || uuid()}`;

  const ctx = {
    sessionId,
    planMeta: plan?.meta || {},
    inventoryHas: options.inventoryHas,
    equipmentHas: options.equipmentHas,
    assumeQuietHoursSensitive: options.assumeQuietHoursSensitive ?? true,
    assumeSabbathSensitive: options.assumeSabbathSensitive ?? true,
    assumeWeatherSensitive: options.assumeWeatherSensitive ?? true,
    defaultStepDurationSec:
      options.defaultStepDurationSec ?? SAFE_DEFAULT_STEP_SEC,
  };

  // 1) Synthesized prep
  const prep = synthesizePrep(plan).map((p, i) => stepFromPrep(p, ctx, i));

  // 2) Zone tasks → steps
  const taskSteps = [];
  let idx = 0;
  for (const z of plan?.zones || []) {
    const headerStep = zoneHeaderStep(z, ctx, idx++);
    taskSteps.push(headerStep);
    for (const t of z?.tasks || []) {
      taskSteps.push(stepFromTask(t, z, ctx, idx++));
    }
    // Quick checkpoint after zone
    taskSteps.push(zoneWrapStep(z, ctx, idx++));
  }

  // 3) Final safety de-dupe and index IDs
  const steps = [...prep, ...taskSteps].map((s, i) => ({
    ...s,
    id: `${sessionId}-${i + 1}`,
  }));

  /** @type {import('../../types').Session|any} */
  const session = {
    id: sessionId,
    domain: "cleaning",
    title: plan?.title || "Cleaning Session",
    source: { type: "cleaningPlan", refId: plan?.id || null },
    steps,
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false,
      ...(options?.prefs || {}),
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const sessionErrs = validateSession(session);
  if (sessionErrs.length)
    console.warn("[composeRoutine] Session contract warnings:", sessionErrs);

  return session;
}

/** ------------------------------ Builders --------------------------------- */

function synthesizePrep(plan) {
  /** @type {Array<{title:string,desc:string,durationSec:number,metadata?:Record<string,any>}>} */
  const out = [];

  for (const fn of prepSynthesizers) {
    const s = safeCall(fn, plan);
    if (s && s.title)
      out.push({
        title: s.title,
        desc: s.desc || s.title,
        durationSec: clamp(
          Number(s.durationSec) || SAFE_DEFAULT_STEP_SEC,
          10,
          8 * 3600
        ),
        metadata: s.metadata || {},
      });
  }

  // General opening step
  out.unshift({
    title: "Wash hands & set timer",
    desc: "Wash hands, start a session timer, and open windows if needed.",
    durationSec: 30,
    metadata: { cueNotes: "Safety & ventilation" },
  });

  return out;
}

function stepFromPrep(prep, ctx, _index) {
  const step = {
    id: `${ctx.sessionId}-prep-${uuid().slice(0, 8)}`,
    title: prep.title,
    desc: prep.desc,
    durationSec: prep.durationSec,
    blockers: [],
    metadata: { ...(prep.metadata || {}) },
  };
  const blockers = new Set();
  for (const inf of guardInferers)
    for (const b of inf(ctx, step)) blockers.add(b);
  step.blockers = Array.from(blockers);
  return step;
}

function stepFromTask(task, zone, ctx, _index) {
  const durationSec = estimateDuration(task, ctx);
  const metadata = {
    equipment: task.equipment || [],
    supplies: task.supplies || [],
    outdoor: !!task.outdoor,
    cueNotes: cueNotesForTask(task),
  };

  /** @type {any} */
  const step = {
    id: `${ctx.sessionId}-t-${task?.id || uuid().slice(0, 8)}`,
    title: formatTaskTitle(task, zone),
    desc: task.desc || task.title || "Do the task",
    durationSec,
    blockers: [],
    metadata,
  };

  // Blockers
  const blockers = new Set();
  for (const inf of guardInferers)
    for (const b of inf(ctx, step)) blockers.add(b);
  step.blockers = Array.from(blockers);

  return step;
}

function zoneHeaderStep(zone, ctx, _i) {
  const step = {
    id: `${ctx.sessionId}-zone-${zone?.id || uuid().slice(0, 6)}-start`,
    title: `Zone: ${zone?.name || "Unnamed Area"} — Start`,
    desc: `Quick scan for hazards, pick up clutter, open blinds for light.`,
    durationSec: 60,
    blockers: [],
    metadata: {
      cueNotes: "Reset the space; prioritize high-traffic paths first",
    },
  };
  const blockers = new Set();
  for (const inf of guardInferers)
    for (const b of inf(ctx, step)) blockers.add(b);
  step.blockers = Array.from(blockers);
  return step;
}

function zoneWrapStep(zone, ctx, _i) {
  const step = {
    id: `${ctx.sessionId}-zone-${zone?.id || uuid().slice(0, 6)}-wrap`,
    title: `Zone: ${zone?.name || "Unnamed Area"} — Wrap up`,
    desc: `Replace items, take trash/recyclables out, quick visual QA (streaks, residue).`,
    durationSec: 60,
    blockers: [],
    metadata: { cueNotes: "QA pass; leave room tidy and ventilated" },
  };
  const blockers = new Set();
  for (const inf of guardInferers)
    for (const b of inf(ctx, step)) blockers.add(b);
  step.blockers = Array.from(blockers);
  return step;
}

/** ------------------------------ Heuristics -------------------------------- */

function estimateDuration(task, ctx) {
  for (const h of timingHeuristics) {
    const v = safeCall(h, task, ctx);
    if (typeof v === "number" && v > 0) return clamp(v, 10, 8 * 3600);
  }
  return SAFE_DEFAULT_STEP_SEC;
}

function scaleBySoil(base, soil) {
  if (soil === "high") return Math.round(base * 1.6);
  if (soil === "medium") return Math.round(base * 1.2);
  return base;
}

function cueNotesForTask(task) {
  const t = (task.type || "").toLowerCase();
  if (t === "windows")
    return "Use 'S' strokes; wipe edges; check for streaks against light";
  if (t === "vacuum")
    return "Slow overlapping passes; edges first; empty canister if >2/3 full";
  if (t === "mop" || t === "steam-mop")
    return "Figure-8 pattern; keep solution fresh; wring well";
  if (t === "sanitize" || t === "disinfect")
    return "Respect dwell time per label; avoid mixing chemicals";
  if (t === "dust")
    return "Top-to-bottom; capture (don't spread); use microfiber";
  if (t === "declutter")
    return "Use 3 bins: keep/donate/trash; set a 10-min cap";
  if (t === "trash")
    return "Tie bags securely; wipe bin rims; insert fresh liner";
  return "Work clean → dirty; high → low";
}

function formatTaskTitle(task, zone) {
  const z = zone?.name ? ` (${zone.name})` : "";
  const title = task?.title || "Task";
  return `${title}${z}`;
}

/** ------------------------------- Validation ------------------------------- */

function validatePlan(plan) {
  /** @type {string[]} */
  const errs = [];
  if (!plan || typeof plan !== "object") {
    errs.push("plan object required");
    return errs;
  }
  if (!plan.title) errs.push("plan.title missing");
  if (!Array.isArray(plan.zones) || plan.zones.length === 0)
    errs.push("plan.zones missing or empty");
  plan.zones?.forEach((z, zi) => {
    if (!Array.isArray(z.tasks) || z.tasks.length === 0)
      errs.push(`zones[${zi}].tasks missing or empty`);
  });
  return errs;
}

function validateSession(session) {
  /** @type {string[]} */
  const errs = [];
  if (!session.id) errs.push("session.id missing");
  if (session.domain !== "cleaning")
    errs.push("session.domain must be 'cleaning'");
  if (!Array.isArray(session.steps) || !session.steps.length)
    errs.push("session.steps missing/empty");
  session.steps?.forEach((s, i) => {
    if (!s.title) errs.push(`steps[${i}].title missing`);
    if (!Number.isFinite(s.durationSec))
      errs.push(`steps[${i}].durationSec invalid`);
    if (!Array.isArray(s.blockers)) errs.push(`steps[${i}].blockers invalid`);
  });
  return errs;
}

/** -------------------------------- Utilities ------------------------------- */

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function safeCall(fn, ...args) {
  try {
    return fn?.(...args);
  } catch {
    return null;
  }
}

/** RFC4122-ish fallback UUID (browser crypto preferred) */
function uuid() {
  try {
    // @ts-ignore
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* --------------------------------- Exports -------------------------------- */

export default {
  composeRoutine,
  addPrepSynthesizer,
  addTimingHeuristic,
  addGuardInferer,
};
