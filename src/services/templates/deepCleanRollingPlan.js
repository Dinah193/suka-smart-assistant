// src/services/templates/deepCleanRollingPlan.js

import * as timeUtils from "@/utils/timeUtils";
// Optional (guarded) modules your app likely has:
let MealPlanStore, CalendarSyncModule, TaskStore, SettingsStore;
try { MealPlanStore = require("@/store/MealPlanStore"); } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}
try { TaskStore = require("@/store/TaskStore"); } catch (_) {}
try { SettingsStore = require("@/store/SettingsStore"); } catch (_) {}

/**
 * Contract-compliant metadata
 */
export const template = {
  id: "deep_clean_rolling_plan_13w_v2",
  version: "2.2.0",
  purpose: "Keep the home continuously tidy using a 13-week rolling, season- and allergen-aware plan with visible drafts.",
  // Morning sweep every Sunday + UI open trigger
  triggers: ["RRULE:FREQ=WEEKLY;BYDAY=SU;BYHOUR=7;BYMINUTE=0;BYSECOND=0", "ui::RoutineScheduleDnD.jsx.open"],
  inputs: {
    // zones: [{ id, name, size?:'S'|'M'|'L', allergens?:['dust','pet','pollen'], tags?:[] }]
    // allergens: ['dust','pet','mold','pollen',...]
    // season: 'winter'|'spring'|'summer'|'autumn'
    required: [],
    optional: ["zones", "allergens", "season", "settings"]
  },
  logic: {
    selectors: [
      "MealPlanStore.getWeek() (optional, to identify light meal weeks)",
      "Calendar completion/TaskStore done-state to detect misses",
      "13-week rotation: 1–2 zones per week with budget targeting",
      "Season + allergens map to heavier tasks (filters, vents, bedding, windows)"
    ],
    rules: [
      "Distribute all zones across a 13-week cycle.",
      "Prefer heavier tasks on light-meal weeks; lighter bundles on heavy-meal weeks.",
      "If a week is missed, softly merge its tasks into the next two weeks.",
      "Overflow → emit micro-tasks mode (3–7min tasks) to keep momentum."
    ],
    llm_roles: []
  },
  actions: [
    "OPEN_UI",               // RoutineScheduleDnD
    "PATCH_PLAN",            // save draft / apply / revert
    "CALENDAR_SYNC",         // CalendarSyncModule.load
    "CREATE_TASKS",          // push checklists as tasks
    "NOTIFY",                // heads-up notifications
    "REMIND",                // lightweight reminders
    "LINK_CHECKLIST"         // open QuickChecklist UI with today's items
  ],
  outputs: {
    ui: ["RoutineScheduleDnD.jsx", "CalendarSyncModule.jsx", "QuickChecklist.jsx"],
    data: ["weeklyDeepCleanTasks", "rotation", "draftPlan"],
    alerts: ["reminders"],
    actions: "array"
  },
  fallbacks: [
    "If missed week → soft merge into next 2 weeks.",
    "If over budget → auto-generate micro-tasks list for daily nibbling."
  ],
  success_message: "13-week deep-clean rotation drafted and synced. Review & apply in your Routine board.",
  used_by: ["cleaningAgent"]
};

/** ---------------- Config & Helpers ---------------- **/

const SEASONS = new Set(["winter", "spring", "summer", "autumn"]);

const DEFAULTS = {
  anchorStorageKey: "deep_clean_anchor_sunday_iso",
  weeklyLightBudgetMin: 40,
  weeklyHeavyBudgetMin: 70,
  microTaskFallbackMin: 25,         // threshold to top up with micro tasks
  microTaskChunkMin: [3, 7],        // per micro task duration range
  preferWeekendPush: true,          // if plan created midweek, push heavier items to next weekend
  reminderHourLocal: 18,            // evening nudge
  openUIRoute: "/tier2/household/routines#deep-clean"
};

function getLocalISODate(d = new Date()) {
  return (typeof timeUtils?.toLocalISODate === "function")
    ? timeUtils.toLocalISODate(d)
    : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDays(d, n) {
  return (typeof timeUtils?.addDays === "function")
    ? timeUtils.addDays(d, n)
    : new Date(d.getTime() + n * 86400000);
}
function startOfWeekSunday(d = new Date()) {
  const dd = new Date(d);
  const day = dd.getDay(); // 0=Sun
  return addDays(dd, -day);
}
function sameDay(a, b) {
  return getLocalISODate(a) === getLocalISODate(b);
}

/** Persist a rolling anchor Sunday so the 13w cadence feels consistent across months */
function getOrSetAnchorSunday(now = new Date()) {
  try {
    const existingISO = SettingsStore?.get?.(DEFAULTS.anchorStorageKey);
    if (existingISO) return new Date(existingISO);
    const anchor = startOfWeekSunday(now);
    SettingsStore?.set?.(DEFAULTS.anchorStorageKey, anchor.toISOString());
    return anchor;
  } catch {
    return startOfWeekSunday(now);
  }
}

function isLightMealWeek(date = new Date()) {
  try {
    const week = MealPlanStore?.getWeek?.(getLocalISODate(date));
    const meals = Array.isArray(week?.days) ? week.days.reduce((acc, d) => acc + (d.recipeIds?.length ?? 0), 0) : 0;
    // ≤7 meals across the week counts as “light”
    return meals <= 7;
  } catch (_) {
    // If MealPlanStore not present, default to every other week light-ish
    const w = Number(new Intl.DateTimeFormat("en-US", { week: "numeric" }).format(date)) || 0;
    return (w % 2) === 0;
  }
}

/** Task library */
function minutesWithSize(base, size = "M") {
  const s = String(size || "M").toUpperCase();
  const bias = s === "L" ? 1.3 : s === "S" ? 0.8 : 1.0;
  return Math.round(base * bias);
}

function baseTasksForZone(zone, { allergens = [], season = "autumn" }) {
  const size = zone?.size ?? "M";
  const tasks = [];

  // Core deep-clean tasks
  tasks.push({ title: "Dust high surfaces & vents", estMinutes: minutesWithSize(10, size), tag: "dust" });
  tasks.push({ title: "Detail vacuum (edges/baseboards)", estMinutes: minutesWithSize(12, size), tag: "floors" });
  tasks.push({ title: "Wipe switches, handles, door frames", estMinutes: minutesWithSize(6, size), tag: "touchpoints" });

  // Allergen-aware
  if ((allergens || []).includes("pet")) tasks.push({ title: "Lint-roll upholstery & pet zones", estMinutes: minutesWithSize(8, size), tag: "pet" });
  if ((allergens || []).includes("dust")) tasks.push({ title: "Wash/replace pillow & throw covers", estMinutes: minutesWithSize(10, size), tag: "allergen" });
  if ((allergens || []).includes("mold")) tasks.push({ title: "De-scale & dry sink/shower seal lines", estMinutes: minutesWithSize(12, size), tag: "bath" });

  // Seasonal accents
  const s = SEASONS.has(String(season)) ? String(season) : "autumn";
  if (s === "spring") tasks.push({ title: "Windows: tracks & screens", estMinutes: minutesWithSize(15, size), tag: "windows" });
  if (s === "summer") tasks.push({ title: "Ceiling fan blades + AC intake grill", estMinutes: minutesWithSize(10, size), tag: "hvac" });
  if (s === "autumn") tasks.push({ title: "HVAC filter check/replace", estMinutes: minutesWithSize(7, size), tag: "hvac" });
  if (s === "winter") tasks.push({ title: "Radiators/vents dust-out", estMinutes: minutesWithSize(10, size), tag: "hvac" });

  // Zone tags can add specifics
  if ((zone.tags || []).includes("kitchen")) {
    tasks.push({ title: "Degrease hood & backsplash", estMinutes: minutesWithSize(12, size), tag: "kitchen" });
  }
  if ((zone.tags || []).includes("bathroom")) {
    tasks.push({ title: "Descale showerhead & faucet aerators", estMinutes: minutesWithSize(8, size), tag: "bath" });
  }

  return tasks;
}

/** Distribute zones across 13 weeks (size-aware) */
function distributeZones13Weeks(zones = []) {
  const W = 13;
  const buckets = Array.from({ length: W }, () => []);
  if (zones.length === 0) return buckets;

  const ordered = [...zones].sort((a, b) => {
    const aSize = (a.size === "L" ? 3 : a.size === "S" ? 1 : 2);
    const bSize = (b.size === "L" ? 3 : b.size === "S" ? 1 : 2);
    return bSize - aSize;
  });

  let i = 0;
  for (const z of ordered) {
    buckets[i % W].push(z);
    i++;
  }
  return buckets;
}

/** Build week bundle */
function buildWeeklyTasks(zones, opts, date, budgets) {
  const light = isLightMealWeek(date);
  const budget = light ? budgets.heavy : budgets.light; // invert: do more when meals are light
  const tasks = [];
  let used = 0;

  for (const z of zones) {
    const zTasks = baseTasksForZone(z, opts);

    // Choose heavier set if light week; otherwise choose 1–2 lighter items
    const sorted = zTasks.sort((a, b) => b.estMinutes - a.estMinutes);
    const picks = light ? sorted : sorted.filter((t) => t.estMinutes <= 12);

    for (const t of picks) {
      if (used + t.estMinutes > budget) break;
      tasks.push({
        id: `${z.id}__${t.tag}`,
        zoneId: z.id,
        zoneName: z.name,
        title: t.title,
        estMinutes: t.estMinutes,
        tags: ["deep_clean", t.tag],
        weekWeight: light ? "heavy" : "light"
      });
      used += t.estMinutes;
    }
  }

  return { tasks, used, budget, lightMealsWeek: light };
}

/** Micro-task fallback generation */
function microTaskTopUp(neededMin, zones, opts) {
  const micro = [];
  const [minA, minB] = DEFAULTS.microTaskChunkMin;
  const chunk = (n) => Math.max(minA, Math.min(minB, n));

  for (const z of zones) {
    if (neededMin <= 0) break;
    // Generic quick wins
    const options = [
      { title: `5-min surface reset — ${z.name}`, estMinutes: 5, tag: "reset" },
      { title: `Spot mop high-traffic — ${z.name}`, estMinutes: 6, tag: "spot_mop" },
      { title: `Mirror & chrome quick shine — ${z.name}`, estMinutes: 4, tag: "shine" },
    ];
    for (const opt of options) {
      if (neededMin <= 0) break;
      const m = { ...opt, id: `${z.id}__micro__${opt.tag}`, zoneId: z.id, zoneName: z.name, tags: ["deep_clean", "micro", opt.tag] };
      micro.push(m);
      neededMin -= chunk(opt.estMinutes);
    }
  }
  return micro;
}

/** Pull completion info for last week if TaskStore/Calendar available */
function lastWeekCompleted(anchorSunday) {
  try {
    const lastSun = addDays(anchorSunday, -7);
    const thisSun = anchorSunday;
    const done = TaskStore?.completedInRange?.(getLocalISODate(lastSun), getLocalISODate(thisSun)) || [];
    const anyDeepClean = (done || []).some((t) => (t.tags || []).includes("deep_clean"));
    return anyDeepClean;
  } catch {
    return true; // assume OK if store not present
  }
}

/** Merge missed week's tasks softly into next two weeks (50/50). */
function softMergeMissed(missedTasks = [], weekA = [], weekB = []) {
  const mergedA = [...weekA];
  const mergedB = [...weekB];
  missedTasks.forEach((t, idx) => {
    const carry = { ...t, id: `${t.id}__carry`, tags: [...(t.tags || []), "carryover"] };
    if (idx % 2 === 0) mergedA.push(carry);
    else mergedB.push(carry);
  });
  return { mergedA, mergedB };
}

/** nextRuns: return next Sunday 7:00 local */
export function nextRuns(now = new Date()) {
  const anchor = startOfWeekSunday(now);
  const next = sameDay(anchor, now) ? addDays(anchor, 7) : anchor;
  const n = new Date(next);
  n.setHours(7, 0, 0, 0);
  return [n.toISOString()];
}

/** ---------------- Execute ---------------- **/

/**
 * Execute the template.
 * @param {Object} payload
 * @param {Array<Object>} [payload.zones]
 * @param {Array<string>}  [payload.allergens]
 * @param {string}         [payload.season]
 * @param {Object}         [payload.settings] // { weeklyLightBudgetMin?, weeklyHeavyBudgetMin?, reminderHourLocal?, preferWeekendPush?, anchorISO? }
 * @param {Object}         [ctx]              // { openUI?, now? }
 * @returns {Promise<{ok:boolean, weeklyDeepCleanTasks:Array, rotation:Array, draftPlan:Object, actions:Array, message:string}>}
 */
export async function execute(payload = {}, ctx = {}) {
  const {
    zones: zonesIn = [],
    allergens = [],
    season = "autumn",
    settings = {}
  } = payload;

  const {
    openUI,
    now = new Date()
  } = ctx;

  const S = {
    ...DEFAULTS,
    weeklyLightBudgetMin: Number.isFinite(settings.weeklyLightBudgetMin) ? settings.weeklyLightBudgetMin : DEFAULTS.weeklyLightBudgetMin,
    weeklyHeavyBudgetMin: Number.isFinite(settings.weeklyHeavyBudgetMin) ? settings.weeklyHeavyBudgetMin : DEFAULTS.weeklyHeavyBudgetMin,
    reminderHourLocal: Number.isFinite(settings.reminderHourLocal) ? settings.reminderHourLocal : DEFAULTS.reminderHourLocal,
    preferWeekendPush: settings.preferWeekendPush ?? DEFAULTS.preferWeekendPush
  };

  // 0) Resolve Anchor
  let anchorSunday = settings.anchorISO ? new Date(settings.anchorISO) : getOrSetAnchorSunday(now);

  // 1) Resolve zones
  const zones = (zonesIn.length > 0 ? zonesIn : []).map((z, i) => ({
    id: z.id ?? `zone_${i}`,
    name: z.name ?? `Zone ${i + 1}`,
    size: z.size ?? "M",
    tags: z.tags ?? []
  }));

  // 2) Build 13-week rotation buckets
  const buckets = distributeZones13Weeks(zones);

  // 3) Build weekly bundles w/ budgets
  const rotation = [];
  for (let w = 0; w < buckets.length; w++) {
    const weekStart = addDays(anchorSunday, w * 7);
    const { tasks, used, budget, lightMealsWeek } = buildWeeklyTasks(
      buckets[w],
      { allergens, season },
      weekStart,
      { light: S.weeklyLightBudgetMin, heavy: S.weeklyHeavyBudgetMin }
    );

    let finalTasks = tasks;
    // Top up with micro tasks if too light
    if (used < Math.max(DEFAULTS.microTaskFallbackMin, Math.round(budget * 0.6))) {
      const microNeed = Math.max(0, Math.round(budget * 0.7) - used);
      const micro = microTaskTopUp(microNeed, buckets[w], { allergens, season });
      finalTasks = [...tasks, ...micro];
    }

    rotation.push({ weekStart, tasks: finalTasks, meta: { budget, used, lightMealsWeek } });
  }

  // 4) Missed-last-week reconciliation via TaskStore/Calendar
  if (!lastWeekCompleted(anchorSunday) && rotation.length >= 2) {
    const missed = rotation[0].tasks.filter((t) => t.tags?.includes("deep_clean"));
    const { mergedA, mergedB } = softMergeMissed(missed, rotation[0].tasks, rotation[1].tasks);
    rotation[0].tasks = mergedA;
    rotation[1].tasks = mergedB;
  }

  // 5) Prepare UI payload (RoutineScheduleDnD.jsx) — visible draft
  const uiParams = {
    title: "Deep Clean: 13-Week Rolling Plan",
    startSunday: getLocalISODate(anchorSunday),
    weeks: rotation.map((r, idx) => ({
      weekIndex: idx,
      weekStart: getLocalISODate(r.weekStart),
      tasks: r.tasks
    })),
    focusWeekIndex: 0,
    draft: true
  };

  const actions = [];

  // OPEN_UI (draft view)
  actions.push({
    type: "OPEN_UI",
    route: S.openUIRoute,
    component: "RoutineScheduleDnD",
    params: uiParams
  });

  // PATCH_PLAN (allow orchestrator to save draft or apply)
  actions.push({
    type: "PATCH_PLAN",
    plan: uiParams,
    draft: true
  });

  // CALENDAR_SYNC (visible)
  try {
    const events = rotation.map((r, i) => {
      const day = r.weekStart;
      const title = i === 0 ? "Deep Clean — This Week" : `Deep Clean — Week ${i + 1}`;
      return {
        start: new Date(day),
        end: addDays(new Date(day), 1),
        title,
        description: r.tasks.map((t) => `• ${t.zoneName}: ${t.title} (${t.estMinutes}m)`).join("\n"),
        tags: ["deep_clean"],
        allDay: true
      };
    });

    actions.push({ type: "CALENDAR_SYNC", events, draft: true });

    // Also call module if available (non-blocking)
    CalendarSyncModule?.load?.(events);
  } catch (_) {
    // Optional, ignore failures
  }

  // CREATE_TASKS for this week's checklist
  const thisWeekTasks = rotation[0]?.tasks ?? [];
  actions.push({
    type: "CREATE_TASKS",
    items: thisWeekTasks.map((t) => ({
      title: `${t.zoneName}: ${t.title}`,
      estMinutes: t.estMinutes,
      tags: t.tags || ["deep_clean"],
      due: getLocalISODate(addDays(anchorSunday, 6)), // by Saturday
    })),
    draft: true
  });

  // Reminder nudge today @ reminderHourLocal
  const nudge = new Date(now);
  nudge.setHours(S.reminderHourLocal, 0, 0, 0);
  actions.push({
    type: "REMIND",
    atISO: nudge.toISOString(),
    title: "Deep Clean Nudge",
    body: "Pick one quick clean task tonight. 5–10 minutes makes a difference.",
    tags: ["deep_clean", "nudge"]
  });

  // QuickChecklist deep link
  actions.push({
    type: "LINK_CHECKLIST",
    route: "/tier2/household/quick-checklist",
    params: {
      title: "Today's Deep Clean Picks",
      items: thisWeekTasks.slice(0, 6).map((t) => ({ label: `${t.zoneName}: ${t.title}`, minutes: t.estMinutes }))
    },
    draft: true
  });

  // Prefer weekend push of heavier items if midweek creation
  if (S.preferWeekendPush) {
    const dow = now.getDay(); // 0=Sun
    if (dow >= 2 && dow <= 5) {
      actions.push({
        type: "NOTIFY",
        channel: "inbox",
        title: "Deep Clean Plan ready",
        body: "Heavier items are nudged toward the weekend. Review & apply when ready.",
        tags: ["deep_clean"]
      });
    }
  }

  // Return
  const result = {
    ok: true,
    weeklyDeepCleanTasks: thisWeekTasks,
    rotation: uiParams.weeks,
    draftPlan: uiParams,
    actions,
    message: template.success_message
  };

  // Fire UI immediately if handler provided
  if (typeof openUI === "function") {
    openUI("RoutineScheduleDnD", uiParams);
  } else {
    // Soft navigate event for environments without direct handler
    try {
      window.dispatchEvent(
        new CustomEvent("ui:navigate", {
          detail: { route: "RoutineScheduleDnD", params: uiParams }
        })
      );
    } catch {}
  }

  return result;
}

export default {
  template,
  execute,
};
