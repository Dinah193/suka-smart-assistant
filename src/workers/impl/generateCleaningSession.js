// src/workers/impl/generateCleaningSession.js
// Dynamic cleaning session generator for Suka Smart Assistant
// - Cadence-aware (daily/weekly/monthly + custom rhythms)
// - Trigger-aware (afterCooking, lowSupplies, guestMode, deepClean windows)
// - Supplies-aware (homemade cleaners + inventory picks + resupply flags)
// - Emits rich editable draft for SessionDraftDetail modal
// - CalendarSync happens ONLY after approval (handled by main thread)

/* --------------------------------- Guards ---------------------------------- */
const IS_BROWSER = typeof self !== "undefined";

/* --------------------------------- Utils ----------------------------------- */
const uid = (p = "cln") =>
  `${p}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const deepClone = (obj) => {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
};

const minutes = (n) => n * 60 * 1000;

/* ---------------------------- Lazy/Dynamic Imports -------------------------- */
/** We lazy import stores so Vite won't over-eagerly bundle Node builtins. */
async function loadStores() {
  const out = {};
  try { out.InventoryStore = (await import(/* @vite-ignore */ "@/store/InventoryStore.js")).default; } catch {}
  try { out.IngredientsIndex = (await import(/* @vite-ignore */ "@/store/IngredientsIndex.js")).default; } catch {}
  try { out.HouseholdCalendarStore = (await import(/* @vite-ignore */ "@/store/HouseholdCalendarStore.js")).useHouseholdCalendar; } catch {}
  try { out.CookingStore = (await import(/* @vite-ignore */ "@/store/CookingStore.js")).default; } catch {}
  try { out.EventBus = (await import(/* @vite-ignore */ "@/services/events/eventBus.js")).default; } catch {}
  // Optional user prefs; ignore if not present
  try { out.CleaningPrefsStore = (await import(/* @vite-ignore */ "@/store/CleaningPrefsStore.js")).default; } catch {}
  return out;
}

/* ----------------------------- Supply Heuristics ---------------------------- */
const DEFAULT_SUPPLIES = [
  { key: "microfiber_cloths", label: "Microfiber cloths", min: 6 },
  { key: "paper_towels", label: "Paper towels", min: 1 }, // rolls
  { key: "trash_bags_13g", label: "13-gal trash bags", min: 10 },
  { key: "baking_soda", label: "Baking soda", min: 1 }, // boxes
  { key: "distilled_vinegar", label: "Distilled vinegar", min: 1 }, // gallons
  { key: "castile_soap", label: "Castile soap", min: 1 },
  { key: "hydrogen_peroxide_3", label: "Hydrogen peroxide 3%", min: 1 },
  { key: "isopropyl_70", label: "Isopropyl alcohol 70%", min: 1 },
  { key: "borax", label: "Borax", min: 1 },
  { key: "washing_soda", label: "Washing soda", min: 1 },
  { key: "lemon_juice", label: "Lemon juice", min: 1 },
];

const HOMEMADE_RECIPES = [
  {
    id: "glass_cleaner",
    name: "Streak-free Glass Cleaner",
    yield: "16 oz",
    ingredients: [
      { item: "distilled_vinegar", qty: "1/2 cup" },
      { item: "isopropyl_70", qty: "1/4 cup" },
      { item: "water", qty: "1 1/4 cup" },
      { item: "lemon_juice", qty: "1 tbsp (optional)" },
    ],
    steps: [
      "Combine all liquids in a spray bottle.",
      "Invert gently to mix; label bottle and date.",
    ],
    targets: ["glass", "mirrors", "chrome"],
  },
  {
    id: "all_purpose",
    name: "All-Purpose Cleaner (Non-stone)",
    yield: "24 oz",
    ingredients: [
      { item: "castile_soap", qty: "2 tbsp" },
      { item: "water", qty: "24 oz" },
      { item: "isopropyl_70", qty: "2 tbsp (optional boost)" },
    ],
    steps: [
      "Add castile soap to bottle; fill with water; invert gently.",
      "Optional: add alcohol; avoid marble/granite (use stone-safe).",
    ],
    targets: ["counters", "appliances", "tables"],
  },
  {
    id: "stone_safe",
    name: "Stone-Safe Counter Spray",
    yield: "24 oz",
    ingredients: [
      { item: "castile_soap", qty: "1 tbsp" },
      { item: "water", qty: "24 oz" },
    ],
    steps: [
      "Mix soap + water in bottle; invert to combine.",
      "Do not use acids on stone; use microfiber.",
    ],
    targets: ["granite", "marble", "quartz"],
  },
];

/* ------------------------------- Task Library ------------------------------- */
function baseTasks(room, opts) {
  const quick = [
    { label: "Declutter visible surfaces", estMin: 3 },
    { label: "Empty trash; replace liner", estMin: 2 },
    { label: "Dust high surfaces & flat areas", estMin: 4 },
    { label: "Wipe commonly touched handles/switches", estMin: 3, timer: 60 },
    { label: "Vacuum or sweep floor", estMin: 6 },
    { label: "Spot mop high-traffic zones", estMin: 4 },
  ];
  const deep = {
    kitchen: [
      { label: "Wipe cabinet faces & pulls", estMin: 7 },
      { label: "Degrease backsplash & stove rails", estMin: 8, hazards: ["Avoid hot surfaces"] },
      { label: "Clean microwave (inside/out)", estMin: 6, timer: 120 },
      { label: "Descale coffee/tea equipment", estMin: 10, timer: 600 },
      { label: "Mop entire kitchen floor", estMin: 10 },
    ],
    bathroom: [
      { label: "Scrub sink & faucet", estMin: 6 },
      { label: "Disinfect toilet (tank, seat, base)", estMin: 8, hazards: ["Ventilate area"] },
      { label: "Clean shower/tub; squeegee glass", estMin: 12, timer: 300 },
      { label: "Replace towels; restock TP", estMin: 2 },
      { label: "Mop entire bathroom floor", estMin: 8 },
    ],
    livingRoom: [
      { label: "Vacuum upholstery & under cushions", estMin: 10 },
      { label: "Dust media center, frames, vents", estMin: 8 },
      { label: "Clean windows & glass", estMin: 10, timer: 120 },
      { label: "Rotate cushions/throws", estMin: 3 },
      { label: "Mop entire floor (if hard surface)", estMin: 10 },
    ],
    bedroom: [
      { label: "Change linens; rotate mattress per plan", estMin: 10 },
      { label: "Dust nightstands, lamps, headboard", estMin: 6 },
      { label: "Vacuum under bed & baseboards", estMin: 10 },
      { label: "Closet quick fold & hang", estMin: 8 },
      { label: "Mop/vacuum floor thoroughly", estMin: 10 },
    ],
  };

  return {
    quick,
    deep: deep[room] || [],
  };
}

/* ------------------------------ Cadence Resolver ---------------------------- */
function resolveCadence(cadence) {
  // cadence: "daily+weekly", "weekly", "monthly", or rhythm object
  const plan = { daily: false, weekly: false, monthly: false };
  if (!cadence || typeof cadence !== "string") return { ...plan, daily: true, weekly: true };

  const lc = cadence.toLowerCase();
  plan.daily = lc.includes("daily");
  plan.weekly = lc.includes("weekly");
  plan.monthly = lc.includes("monthly");

  // If none explicitly set, default to daily+weekly
  if (!plan.daily && !plan.weekly && !plan.monthly) {
    plan.daily = true;
    plan.weekly = true;
  }
  return plan;
}

/* ------------------------------ Room Sequencing ------------------------------ */
function pickRooms(targets) {
  // Default set if none provided
  const base = ["kitchen", "bathroom", "livingRoom"];
  const req = Array.isArray(targets) && targets.length ? targets : base;
  // Guarantee order for flow efficiency: kitchen -> living -> bath -> bedrooms (or provided order)
  const priority = { kitchen: 0, livingRoom: 1, bathroom: 2, bedroom: 3, other: 4 };
  return [...req].sort((a, b) => (priority[a] ?? 4) - (priority[b] ?? 4));
}

/* --------------------------- After-Cooking Heuristic ------------------------- */
function buildAfterCookingBoost(cookingStore, windowMins = 180) {
  // If there was a cooking session in the last X minutes, boost kitchen/bathroom quick tasks
  try {
    const last = cookingStore?.getters?.lastCookingEnd?.();
    const now = Date.now();
    if (!last) return 0;
    const delta = now - new Date(last).getTime();
    return delta <= minutes(windowMins) ? 1 : 0;
  } catch {
    return 0;
  }
}

/* ------------------------------ Inventory Checks ---------------------------- */
function computeSupplyStatus(inventoryStore) {
  const items = [];
  const low = [];
  let score = 1; // 0..1 (1 means fully stocked)

  for (const s of DEFAULT_SUPPLIES) {
    const stock = inventoryStore?.getQuantity
      ? inventoryStore.getQuantity(s.key) ?? 0
      : 0;

    items.push({
      key: s.key,
      label: s.label,
      have: stock,
      min: s.min,
      isLow: stock < s.min,
    });
    if (stock < s.min) low.push(s.key);
  }

  // crude score: fraction of items above min
  const ok = items.filter((i) => !i.isLow).length;
  score = items.length ? ok / items.length : 1;

  return { items, lowKeys: low, score: clamp(score, 0, 1) };
}

/* ------------------------------ Time Estimation ----------------------------- */
function estimateTaskBlock(tasks, baseSpeed = 1) {
  // baseSpeed: 1 normal, >1 faster, <1 slower
  const total = tasks.reduce((m, t) => m + (t.estMin || 3), 0);
  return Math.ceil(total / baseSpeed);
}

/* --------------------------- Build Room Task Bundle -------------------------- */
function buildRoomBundle(room, cadencePlan, afterCookingBoost, opts = {}) {
  const lib = baseTasks(room, opts);
  const steps = [];

  // Daily quick tasks (always candidates)
  if (cadencePlan.daily) {
    steps.push(...lib.quick);
  }

  // Weekly deep tasks (rotate a subset)
  if (cadencePlan.weekly) {
    const weeklySubset = lib.deep.slice(0, Math.ceil(lib.deep.length / 2));
    steps.push(...weeklySubset);
  }

  // Monthly deep tasks (the rest + extras)
  if (cadencePlan.monthly) {
    const monthlySubset = lib.deep.slice(Math.ceil(lib.deep.length / 2));
    steps.push(...monthlySubset);
    // Bonus monthly specifics
    steps.push({ label: "Baseboards detailed wipe", estMin: 8 });
    steps.push({ label: "Air vents & returns cleaned", estMin: 7 });
  }

  // AfterCooking bias for kitchen/bathroom
  if (afterCookingBoost && (room === "kitchen" || room === "bathroom")) {
    steps.unshift({ label: "Hot zone sanitization (handles, faucet, stove knobs)", estMin: 3, timer: 90 });
  }

  // Normalize step objects
  const normalized = steps.map((s, i) => ({
    id: uid("step"),
    label: s.label,
    estMin: s.estMin ?? 3,
    timer: s.timer ?? null, // seconds; UI can edit in SessionDraftDetail
    hazards: s.hazards ?? [],
    tools: s.tools ?? [],
    supplies: s.supplies ?? [],
    done: false,
    order: i + 1,
  }));

  // Suggest supplies by surface type
  const supplyHints =
    room === "kitchen"
      ? [{ key: "all_purpose" }, { key: "glass_cleaner" }, { key: "trash_bags_13g" }]
      : room === "bathroom"
      ? [{ key: "all_purpose" }, { key: "glass_cleaner" }, { key: "hydrogen_peroxide_3" }]
      : room === "livingRoom"
      ? [{ key: "glass_cleaner" }, { key: "microfiber_cloths" }]
      : [{ key: "all_purpose" }];

  return {
    room,
    steps: normalized,
    suppliesSuggested: supplyHints,
    estMinutes: estimateTaskBlock(normalized, opts.speedFactor ?? 1),
  };
}

/* --------------------------- Draft Construction Core ------------------------ */
function composeCleaningDraft(params) {
  const {
    cadencePlan,
    rooms,
    afterCookingBoost,
    supplyStatus,
    homemadeEnabled,
    schedWindow,
    guestMode,
    deepCleanMode,
    userSpeedFactor,
  } = params;

  // Build room task bundles
  const bundles = rooms.map((r) =>
    buildRoomBundle(r, cadencePlan, afterCookingBoost, { speedFactor: userSpeedFactor })
  );

  // Total duration = sum of bundles (time-box to user target if provided)
  let totalMin = bundles.reduce((m, b) => m + b.estMinutes, 0);

  // Deep clean mode boosts by ~20%
  if (deepCleanMode) totalMin = Math.round(totalMin * 1.2);

  // Supplies section with homemade suggestions
  const homemade = homemadeEnabled ? HOMEMADE_RECIPES : [];

  // Resupply panel from inventory
  const resupply = supplyStatus.items
    .filter((i) => i.isLow)
    .map((i) => ({ key: i.key, label: i.label, need: i.min - i.have }));

  const draftId = uid("cleaningDraft");
  const titleParts = [];
  if (guestMode) titleParts.push("Guest-Ready");
  if (deepCleanMode) titleParts.push("Deep Clean");
  titleParts.push("Cleaning Session");
  const draftTitle = titleParts.join(" ");

  const draft = {
    id: draftId,
    type: "cleaning",
    title: draftTitle,
    cadence: Object.entries(cadencePlan)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join("+"),
    createdAt: new Date().toISOString(),
    scheduledWindow: schedWindow || null, // { start: ISO, end: ISO } – UI can set/adjust
    guestMode: !!guestMode,
    deepCleanMode: !!deepCleanMode,

    // For the SessionDraftDetail modal (pre-approval)
    approvals: { status: "draft" },

    // Recommended overall flow & parallelization hints
    flow: {
      sequence: bundles.map((b) => b.room),
      parallelizableRooms: ["livingRoom", "bedroom"],
      timeboxing: { totalEstMinutes: totalMin, suggestedPomodoro: { work: 25, break: 5 } },
    },

    // Room bundles with steps
    tasks: bundles,

    // Supplies + resupply panel
    supplies: {
      stockScore: supplyStatus.score, // 0..1
      items: supplyStatus.items,
      resupply, // actionable list
      homemadeEnabled: !!homemadeEnabled,
      homemadeRecipes: homemade,
    },

    // Safety, ventilation, allergy flags (UI can display badges)
    safety: {
      ventilationRecommended: true,
      petsInside: true, // UI can toggle if needed
      allergySensitive: false, // from user prefs if available
    },

    // Metrics for progress visualization
    metrics: {
      totalRooms: bundles.length,
      totalSteps: bundles.reduce((m, b) => m + b.steps.length, 0),
      estMinutes: totalMin,
    },

    // Integration hints for CalendarSync hook (only used AFTER approval)
    integrations: {
      calendarSync: {
        enabled: false, // main app sets true on approval
        calendarId: null,
        reminders: [{ offsetMinutes: 10, type: "notification" }],
      },
      telemetry: { event: "draft.cleaning.generated" },
    },
  };

  return draft;
}

/* ------------------------------ Public API ---------------------------------- */
/**
 * Generate a cleaning session draft.
 *
 * @param {Object} input
 *   - targets?: string[] e.g. ["kitchen","bathroom","livingRoom","bedroom"]
 *   - cadence?: string e.g. "daily+weekly", "weekly", "monthly"
 *   - triggers?: { afterCooking?: boolean, lowSupplies?: boolean, guestMode?: boolean, deepClean?: boolean }
 *   - schedule?: { start?: string|Date, end?: string|Date }  // optional preferred window
 *   - userSpeedFactor?: number (1 = normal; 1.2 faster; 0.8 slower)
 *   - homemadeEnabled?: boolean (default true)
 * @param {Object} ctx
 *   - onProgress?: (phase, pct) => void
 *   - signal?: AbortSignal
 * @returns {Promise<{ draft: Object, meta: Object }>}
 */
export default async function generateCleaningSession(input = {}, ctx = {}) {
  const {
    targets,
    cadence = "daily+weekly",
    triggers = { afterCooking: true, lowSupplies: true, guestMode: false, deepClean: false },
    schedule = null,
    userSpeedFactor = 1,
    homemadeEnabled = true,
  } = input;

  const { onProgress, signal } = ctx;

  const progress = (phase, pct) => {
    if (typeof onProgress === "function") onProgress(phase, pct);
  };

  progress("init", 3);

  const {
    InventoryStore,
    IngredientsIndex,
    HouseholdCalendarStore,
    CookingStore,
    EventBus,
    CleaningPrefsStore,
  } = await loadStores();

  if (signal?.aborted) throw new Error("aborted");

  // Resolve cadence and rooms
  const cadencePlan = resolveCadence(cadence);
  const rooms = pickRooms(targets);

  // Triggers
  const afterCookingBoost = triggers.afterCooking
    ? buildAfterCookingBoost(CookingStore, 180)
    : 0;

  progress("inventory-check", 12);
  // Inventory/supply status
  const supplyStatus = computeSupplyStatus(InventoryStore);

  // If lowSupplies trigger is on and stock is low, auto-enable resupply panel (UI already gets list)
  const lowSuppliesTriggered = !!triggers.lowSupplies && supplyStatus.score < 0.7;

  // Guest / Deep-clean modes (may also be stored in CleaningPrefs)
  let guestMode = !!triggers.guestMode;
  let deepCleanMode = !!triggers.deepClean;

  try {
    const prefs = CleaningPrefsStore?.get?.() || CleaningPrefsStore?.getState?.();
    if (prefs?.guestModeDefault === true) guestMode = guestMode || true;
    if (prefs?.deepCleanOnWeekX) {
      // Example: turn on deepClean the first week of each month
      const d = new Date();
      if (prefs.deepCleanOnWeekX === Math.ceil(d.getDate() / 7)) deepCleanMode = true;
    }
  } catch {}

  progress("compose-draft", 30);

  // Schedule window normalization
  const schedWindow = schedule
    ? {
        start: schedule.start ? new Date(schedule.start).toISOString() : null,
        end: schedule.end ? new Date(schedule.end).toISOString() : null,
      }
    : null;

  // Draft creation
  const draft = composeCleaningDraft({
    cadencePlan,
    rooms,
    afterCookingBoost,
    supplyStatus,
    homemadeEnabled,
    schedWindow,
    guestMode,
    deepCleanMode,
    userSpeedFactor,
  });

  if (signal?.aborted) throw new Error("aborted");

  // Optional: Announce on event bus for app-wide listeners (non-blocking)
  try {
    EventBus?.emit?.("draft.cleaning.ready", deepClone(draft));
  } catch {}

  progress("ready", 95);

  const meta = {
    lowSuppliesTriggered,
    afterCookingBoost,
    roomsCount: rooms.length,
    cadencePlan,
  };

  progress("done", 100);
  return { draft, meta };
}

/* ------------------------------ Example Usage ------------------------------- */
/*
In agentsWorker.js (already wired), you can call:

  import generateCleaningSession from "@/workers/impl/generateCleaningSession.js";

  const { draft, meta } = await generateCleaningSession({
    targets: ["kitchen","bathroom","livingRoom"],
    cadence: "daily+weekly",
    triggers: { afterCooking: true, lowSupplies: true, guestMode: false, deepClean: false },
    schedule: null,
    userSpeedFactor: 1,
    homemadeEnabled: true,
  }, {
    onProgress: (phase, pct) => postMessage({ type: "PROGRESS", data: { phase, pct } })
  });

Then emit:
  postMessage({ type: "DRAFT_READY", data: { draft, draftType: "cleaning" } });

On APPROVE in your SessionDraftDetail modal:
  // main thread toggles approvals + calendar flags, persists, and runs CalendarSync hook.
*/
