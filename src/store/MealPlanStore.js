// src/store/MealPlanStore.js
import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { persist, createJSONStorage } from "zustand/middleware";

/* ----------------------------------------------------------------------------
   MealPlanStore (v3)
   - Rhythm-aware planning w/ IF presets (16:8, 18:6, OMAD, 36h, ADF) + overrides
   - West-African-forward “Next Best Action” (NBA) suggestions for UI toolbar
   - Optional hooks into Inventory/Recipe stores (no hard deps)
   - Undo/Redo for user actions (local, non-persisted)
   - Event/Automation taps for Orchestrators, Batch Cooking, CalendarSync
   - Nutrition targets glance (supports TargetsBadge)

   Patch (compat):
   - Add `plan` alias in state (mirrors `mealPlan`)
   - Add `setPlan(plan, meta)` action that sets plan + mealPlan (keeps other code)

   Patch (hydration/source-of-truth):
   - Hydrate MealPlanStore from known legacy localStorage keys at startup
   - Normalize any loaded plan shape to envelope: { schedule, shoppingList, prepTasks }
   - Mirror to BOTH `mealPlan` and `plan` so dashboards always see it
---------------------------------------------------------------------------- */

const ISO = (d) => {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d + "T00:00:00") : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const normId = (x) => String(x ?? "").trim();

/* ---------- shallow equal helpers for no-op writes ---------- */
function arraysShallowEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
    return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function objectShallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/* ---------- Events / Automation (safe, optional) ---------- */
async function emitEvent(topic, payload) {
  try {
    const mod = await import("@/services/events/eventBus");
    const bus = mod?.eventBus || mod?.default;
    if (bus?.emit) bus.emit(topic, payload);
  } catch (_) {}
  try {
    const rt = await import("@/services/automation/runtime");
    const automation = rt?.automation || rt?.default;
    if (automation?.notify) automation.notify(topic, payload);
  } catch (_) {}
}

/* ---------- Inventory/Recipe optional side-effects ---------- */
async function optionalRecipeSideEffects({
  added = [],
  removed = [],
  dateIso,
}) {
  try {
    const InventoryStore = await import("@/store/InventoryStore");
    // e.g., InventoryStore.useInventoryActions.getState()?.reserveForRecipes(added)
    void InventoryStore;
  } catch (_) {}
  try {
    const RecipeStore = await import("@/store/RecipeStore");
    // e.g., RecipeStore.useRecipeActions.getState()?.touchRecent(added)
    void RecipeStore;
  } catch (_) {}
  // Hint Orchestrators
  emitEvent("mealPlan/recipesChanged", { dateIso, added, removed });
}

/* ---------- Targets / Preferences (optional) ---------- */
async function getTargetMacros() {
  try {
    const pref = await import("@/store/PreferencesStore");
    const get = pref?.usePreferencesStore?.getState;
    const targets = get?.()?.foodTargets;
    // { calories, protein, carbs, fat } optional
    return targets || null;
  } catch (_) {
    return null;
  }
}

/* ---------- Presets ---------- */
function buildSlotsFromPreset(preset) {
  switch ((preset || "").toLowerCase()) {
    case "16:8":
      return [
        {
          slotId: "F",
          label: "Fasting",
          type: "fast",
          start: "20:00",
          end: "12:00",
        },
        {
          slotId: "M1",
          label: "Meal 1",
          type: "meal",
          start: "12:00",
          end: "12:45",
        },
        {
          slotId: "M2",
          label: "Meal 2",
          type: "meal",
          start: "19:00",
          end: "19:45",
        },
      ];
    case "18:6":
      return [
        {
          slotId: "F",
          label: "Fasting",
          type: "fast",
          start: "20:00",
          end: "14:00",
        },
        {
          slotId: "M1",
          label: "Meal 1",
          type: "meal",
          start: "14:00",
          end: "14:45",
        },
        {
          slotId: "M2",
          label: "Meal 2",
          type: "meal",
          start: "19:00",
          end: "19:45",
        },
      ];
    case "omad":
      return [
        {
          slotId: "F",
          label: "Fasting",
          type: "fast",
          start: "20:00",
          end: "18:00",
        },
        {
          slotId: "OMAD",
          label: "Single Meal",
          type: "meal",
          start: "18:00",
          end: "19:00",
        },
      ];
    case "36h":
      return [
        {
          slotId: "F36",
          label: "Extended Fast",
          type: "fast",
          start: "20:00",
          end: "08:00",
        },
      ];
    case "adf":
      return buildSlotsFromPreset("16:8");
    default:
      return [
        {
          slotId: "B",
          label: "Breakfast",
          type: "meal",
          start: "08:00",
          end: "08:45",
        },
        {
          slotId: "L",
          label: "Lunch",
          type: "meal",
          start: "12:30",
          end: "13:15",
        },
        {
          slotId: "D",
          label: "Dinner",
          type: "meal",
          start: "18:30",
          end: "19:15",
        },
      ];
  }
}

function dietTagForDow(dietByDow, dow) {
  if (!dietByDow) return "unrestricted";
  return Object.prototype.hasOwnProperty.call(dietByDow, dow)
    ? dietByDow[dow]
    : dietByDow.default || "unrestricted";
}

function isAdfFastDay(dateIso, adfCfg) {
  if (!adfCfg || !adfCfg.fastEveryOtherDay || !adfCfg.startIso) return false;
  const start = new Date(adfCfg.startIso + "T00:00:00");
  const cur = new Date(dateIso + "T00:00:00");
  const diffDays = Math.round((cur - start) / 86400000);
  if (diffDays < 0) return false;
  return diffDays % 2 === 1; // even=feed, odd=fast
}

function seedSlotsForDate(baseSlots, dietTag) {
  return (baseSlots || []).map((s) => ({
    id: `${s.slotId}-${Math.random().toString(36).slice(2, 8)}`,
    slotId: s.slotId,
    label: s.label,
    type: s.type,
    start: s.start,
    end: s.end,
    dietTag,
    recipes: [],
    status: "planned",
  }));
}

/* ---------- West-African-forward suggestion helpers ---------- */
const WEST_AFRICAN_INDEX = [
  {
    id: "jollof-rice",
    tag: ["unrestricted"],
    title: "Jollof Rice",
    proteinBias: "chicken/lamb",
  },
  {
    id: "suya-spiced-beef",
    tag: ["keto", "unrestricted"],
    title: "Suya-Spiced Beef Skewers",
    proteinBias: "beef",
  },
  {
    id: "egusi-soup",
    tag: ["keto", "unrestricted"],
    title: "Egusi Soup",
    proteinBias: "goat",
  },
  {
    id: "waakye-bowl",
    tag: ["unrestricted"],
    title: "Waakye Bowl",
    proteinBias: "fish",
  },
  {
    id: "grilled-tilapia-attaieke",
    tag: ["unrestricted"],
    title: "Grilled Tilapia + Attiéké",
    proteinBias: "fish",
  },
  {
    id: "yassa-onions-lamb",
    tag: ["keto", "unrestricted"],
    title: "Yassa Lamb (Onion-Lemon)",
    proteinBias: "lamb",
  },
  {
    id: "akara",
    tag: ["unrestricted"],
    title: "Akara (Bean Fritters)",
    proteinBias: "legume",
  },
];

function suggestWestAfrican(dietTag, wantHighProtein = false) {
  let pool = WEST_AFRICAN_INDEX.filter(
    (x) => x.tag.includes(dietTag) || x.tag.includes("unrestricted")
  );
  if (wantHighProtein) {
    pool = pool.filter((x) =>
      ["beef", "goat", "lamb", "fish", "chicken"].some((p) =>
        x.proteinBias.includes(p)
      )
    );
  }
  if (!pool.length) pool = WEST_AFRICAN_INDEX;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return { id: pick.id, title: pick.title };
}

/* ----------------------------------------------------------------------------
   Hydration helpers (source-of-truth fixes)
---------------------------------------------------------------------------- */

/**
 * Detect whether an object looks like an "envelope" plan.
 * Envelope shape:
 *   { schedule: {...}, shoppingList: [...], prepTasks: [...] }
 */
function isEnvelopePlan(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && !!v.schedule;
}

/**
 * Normalize any known shape to the envelope format.
 * Accepts:
 *  - envelope already
 *  - legacy schedule object: { "2026-01-10": [...], "Day 1": [...] }
 *  - legacy "plan" wrappers: { plan: {...} } or { mealPlan: {...} }
 */
function normalizeToEnvelope(input) {
  const v = input && typeof input === "object" ? input : null;
  if (!v) return { schedule: {}, shoppingList: [], prepTasks: [] };

  // If already an envelope, ensure arrays exist.
  if (isEnvelopePlan(v)) {
    const schedule =
      v.schedule && typeof v.schedule === "object" ? v.schedule : {};
    const shoppingList = Array.isArray(v.shoppingList) ? v.shoppingList : [];
    const prepTasks = Array.isArray(v.prepTasks) ? v.prepTasks : [];
    return { ...v, schedule, shoppingList, prepTasks };
  }

  // If wrapped
  if (v.plan && typeof v.plan === "object") return normalizeToEnvelope(v.plan);
  if (v.mealPlan && typeof v.mealPlan === "object")
    return normalizeToEnvelope(v.mealPlan);
  if (v.schedule && typeof v.schedule === "object")
    return normalizeToEnvelope({ schedule: v.schedule });

  // Otherwise treat as schedule object
  const schedule = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  return { schedule, shoppingList: [], prepTasks: [] };
}

/**
 * Convert envelope back to store "mealPlan" state that some pages expect.
 * The store state historically used `mealPlan` as either:
 *  - envelope (preferred now)
 *  - schedule-only object (legacy)
 *
 * We store the envelope in state to satisfy dashboards that expect schedule fields.
 */
function envelopeToStoreState(envelope) {
  const env = normalizeToEnvelope(envelope);
  return env;
}

/**
 * Best-effort read of various legacy localStorage keys.
 * We DO NOT rely on this for correctness long term; it just unblocks UI
 * when generators save to a different key than the dashboard reads.
 */
function readLegacyPlanFromLocalStorage() {
  if (typeof window === "undefined") return null;
  try {
    const keysToTry = [
      // likely custom keys used by older generators
      "mealPlanner.plan",
      "mealPlan",
      "meal-plan",
      "ssa.mealPlan",
      "ssa.mealPlanner.plan",
      "ssa.mealPlanner",
      "MealPlan",
      "MealPlannerPlan",
      // zustand persist keys (common)
      "meal-plan-store",
      "meal-plan-store-v1",
      "meal-plan-store-v2",
      "meal-plan-store-v3",
      // older patterns you may have used
      "mealPlanStore",
      "MealPlanStore",
      "MealPlannerStore",
    ];

    for (const k of keysToTry) {
      const raw = window.localStorage.getItem(k);
      if (!raw) continue;

      // zustand persist typically stores JSON with { state, version }
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          if (parsed.state) {
            const st = parsed.state;
            if (st.mealPlan) return st.mealPlan;
            if (st.plan) return st.plan;
            if (st.schedule) return st;
          } else {
            // direct plan object
            if (parsed.mealPlan || parsed.plan || parsed.schedule)
              return parsed;
            // schedule-only object
            if (typeof parsed === "object") return parsed;
          }
        }
      } catch (_) {
        // ignore non-json
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Decide if a store state is "empty" enough to warrant legacy hydration.
 * We only auto-hydrate when:
 *  - mealPlan is empty or has empty schedule
 *  - AND legacy storage contains a non-empty schedule
 */
function shouldHydrateFromLegacy(currentMealPlan, legacyCandidate) {
  const curEnv = normalizeToEnvelope(currentMealPlan);
  const curKeys = Object.keys(curEnv.schedule || {});
  const curHasMeals = curKeys.some((k) => {
    const v = curEnv.schedule[k];
    return Array.isArray(v) ? v.length > 0 : !!v;
  });

  if (curHasMeals) return false;

  const legacyEnv = normalizeToEnvelope(legacyCandidate);
  const legacyKeys = Object.keys(legacyEnv.schedule || {});
  const legacyHasMeals = legacyKeys.some((k) => {
    const v = legacyEnv.schedule[k];
    return Array.isArray(v) ? v.length > 0 : !!v;
  });

  return legacyHasMeals;
}

/* ----------------------------------------------------------------------------
   Store
---------------------------------------------------------------------------- */
export const useMealPlanStore = create(
  persist(
    (set, get) => ({
      /* ---------------- Core State ---------------- */
      mealPlan: {},

      // ✅ compat alias (some dashboards read `plan`)
      // Keep it mirrored with mealPlan on every write path we control.
      plan: {},

      // Rhythm config with safe defaults
      rhythm: {
        preset: "custom",
        timezone: "America/New_York",
        slots: buildSlotsFromPreset("custom"),
        dietByDow: {
          default: "unrestricted",
          1: "keto",
          2: "keto",
          3: "keto",
          4: "keto",
          5: "keto",
          6: "unrestricted",
          0: "unrestricted",
        },
        adf: null, // { startIso: "2025-09-01", fastEveryOtherDay: true }
        overrides: {},
      },

      /* ---------------- Local (non-persisted) helpers ---------------- */
      _history: [], // undo stack
      _future: [], // redo stack
      _pushHistory: (snapshot) => {
        const hist = get()._history.slice(-49); // cap 50
        hist.push(snapshot);
        set({ _history: hist, _future: [] });
      },

      /* ---------------- Source-of-truth hydration hook ---------------- */
      // Called by onRehydrateStorage (below) once zustand has loaded persisted state.
      _hydrateFromLegacyIfNeeded: () => {
        try {
          const st = get();
          const legacy = readLegacyPlanFromLocalStorage();
          if (!legacy) return;

          if (!shouldHydrateFromLegacy(st.mealPlan, legacy)) return;

          const env = envelopeToStoreState(legacy);
          // Keep alias mirrored
          set({ mealPlan: env, plan: env });

          emitEvent("mealPlan/hydratedFromLegacy", {
            scheduleDays: Object.keys(env.schedule || {}).length,
          });
        } catch (_) {}
      },

      /* ---------------- Core compat API ---------------- */
      // ✅ required by some pages/facades:
      // setPlan(plan, meta) sets BOTH `plan` and `mealPlan` and emits a signal.
      setPlan: (plan, meta = {}) => {
        const nextEnv = envelopeToStoreState(plan);
        const prev = get().mealPlan;

        // For comparisons, compare envelope schedule shallowly if possible.
        const prevEnv = normalizeToEnvelope(prev);
        const nextEnvN = normalizeToEnvelope(nextEnv);

        // If both schedules are same reference/shape shallowly, treat as no-op.
        // (We avoid deep compare to keep perf; generators should produce new objects.)
        const prevSched = prevEnv.schedule || {};
        const nextSched = nextEnvN.schedule || {};
        const sameTopKeys =
          Object.keys(prevSched).length === Object.keys(nextSched).length &&
          Object.keys(prevSched).every((k) => prevSched[k] === nextSched[k]);

        if (prev === nextEnv || sameTopKeys) {
          // Still ensure alias is not drifting
          if (get().plan !== prev) set({ plan: prev });
          return;
        }

        get()._pushHistory({ mealPlan: prev, rhythm: get().rhythm });
        set({ mealPlan: nextEnvN, plan: nextEnvN });

        emitEvent("mealPlan/planSet", {
          days: Object.keys(nextEnvN.schedule || {}).length,
          meta: meta || {},
        });
      },

      /* ---------------- Rhythm API ---------------- */
      setRhythmPreset: (preset) => {
        const prev = get().rhythm;
        const r = {
          ...prev,
          preset: preset || "custom",
          slots: buildSlotsFromPreset(preset),
        };
        if (objectShallowEqual(prev, r)) return;
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ rhythm: r });
        emitEvent("mealPlan/rhythmChanged", { preset: r.preset });
      },

      setRhythmSlots: (slots) => {
        const r = { ...get().rhythm, slots: Array.isArray(slots) ? slots : [] };
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ rhythm: r });
        emitEvent("mealPlan/rhythmSlotsChanged", { slots: r.slots });
      },

      setDietByDow: (dietByDow) => {
        const r = {
          ...get().rhythm,
          dietByDow: dietByDow || { default: "unrestricted" },
        };
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ rhythm: r });
        emitEvent("mealPlan/dietByDowChanged", { dietByDow: r.dietByDow });
      },

      setAdfConfig: (adf) => {
        const r = { ...get().rhythm, adf: adf || null };
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ rhythm: r });
        emitEvent("mealPlan/adfChanged", { adf: r.adf });
      },

      setRhythmOverrideForDate: (dateIso, override) => {
        const iso = ISO(dateIso);
        if (!iso) return;
        const r = { ...get().rhythm };
        const nextOverrides = { ...(r.overrides || {}) };
        nextOverrides[iso] = {
          ...(nextOverrides[iso] || {}),
          ...(override || {}),
        };
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        r.overrides = nextOverrides;
        set({ rhythm: r });
        emitEvent("mealPlan/overrideChanged", {
          dateIso: iso,
          override: nextOverrides[iso],
        });
      },

      clearRhythmOverrideForDate: (dateIso) => {
        const iso = ISO(dateIso);
        if (!iso) return;
        const r = { ...get().rhythm };
        const nextOverrides = { ...(r.overrides || {}) };
        delete nextOverrides[iso];
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        r.overrides = nextOverrides;
        set({ rhythm: r });
        emitEvent("mealPlan/overrideCleared", { dateIso: iso });
      },

      /* ---------------- Plan CRUD (slot-aware + legacy) ---------------- */
      setMealPlan: (plan) => {
        const nextEnv = envelopeToStoreState(plan);
        const prev = get().mealPlan;

        // same-as above: if schedule appears unchanged, avoid rewrite
        const prevEnv = normalizeToEnvelope(prev);
        const nextEnvN = normalizeToEnvelope(nextEnv);
        const prevSched = prevEnv.schedule || {};
        const nextSched = nextEnvN.schedule || {};
        const sameTopKeys =
          Object.keys(prevSched).length === Object.keys(nextSched).length &&
          Object.keys(prevSched).every((k) => prevSched[k] === nextSched[k]);

        if (prev === nextEnvN || sameTopKeys) {
          if (get().plan !== prev) set({ plan: prev });
          return;
        }

        get()._pushHistory({ mealPlan: prev, rhythm: get().rhythm });
        // ✅ keep alias mirrored
        set({ mealPlan: nextEnvN, plan: nextEnvN });
        emitEvent("mealPlan/planSet", {
          days: Object.keys(nextEnvN.schedule || {}).length,
        });
      },

      updateMealPlanForDay: (day, items) => {
        const key = ISO(day) || String(day ?? "").trim();

        const prevEnv = normalizeToEnvelope(get().mealPlan);
        const prevSchedule = prevEnv.schedule || {};
        const prevDay = prevSchedule[key] || [];

        const nextDay = Array.isArray(items) ? items : [];
        if (arraysShallowEqual(prevDay, nextDay)) return;

        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });

        const nextSchedule = { ...prevSchedule, [key]: nextDay };
        const nextEnv = { ...prevEnv, schedule: nextSchedule };

        // ✅ keep alias mirrored
        set({ mealPlan: nextEnv, plan: nextEnv });
        emitEvent("mealPlan/dayUpdated", {
          dateIso: key,
          count: nextDay.length,
        });
      },

      addRecipeToDay: async (day, recipe, slotId = null) => {
        if (!recipe) return;
        const key = ISO(day) || String(day ?? "").trim();

        // Ensure a day exists in schedule
        const env = normalizeToEnvelope(get().mealPlan);
        const schedule = env.schedule || {};

        if (!schedule[key] || schedule[key].length === 0) {
          // generate rhythm-based slots into schedule
          get().generateDayFromRhythm(key);
        }

        // Re-read after generation
        const env2 = normalizeToEnvelope(get().mealPlan);
        const schedule2 = env2.schedule || {};
        const listNow = schedule2[key] ? [...schedule2[key]] : [];

        // Find a target slot
        let targetIndex = -1;
        if (slotId) targetIndex = listNow.findIndex((x) => x.slotId === slotId);
        if (targetIndex === -1)
          targetIndex = listNow.findIndex((x) => x.type === "meal");

        const rid = normId(recipe.id || recipe.title || `${Date.now()}`);
        const exists = listNow.some((r) =>
          r.recipes?.some?.((rr) => normId(rr.id) === rid)
        );
        if (exists) return;

        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });

        if (targetIndex >= 0) {
          const slot = { ...listNow[targetIndex] };
          const nextRecipes = Array.isArray(slot.recipes)
            ? [...slot.recipes]
            : [];
          nextRecipes.push({ ...recipe, id: rid });
          slot.recipes = nextRecipes;
          listNow[targetIndex] = slot;

          const nextSchedule = {
            ...normalizeToEnvelope(get().mealPlan).schedule,
            [key]: listNow,
          };
          const nextEnv = {
            ...normalizeToEnvelope(get().mealPlan),
            schedule: nextSchedule,
          };

          set({ mealPlan: nextEnv, plan: nextEnv });

          optionalRecipeSideEffects({
            added: [recipe],
            removed: [],
            dateIso: key,
          });
          emitEvent("mealPlan/recipeAdded", {
            dateIso: key,
            slotId: slot.slotId,
            recipeId: rid,
          });
          return;
        }

        // Fallback legacy append
        listNow.push({ ...recipe, id: rid });

        const nextSchedule = {
          ...normalizeToEnvelope(get().mealPlan).schedule,
          [key]: listNow,
        };
        const nextEnv = {
          ...normalizeToEnvelope(get().mealPlan),
          schedule: nextSchedule,
        };

        set({ mealPlan: nextEnv, plan: nextEnv });

        optionalRecipeSideEffects({
          added: [recipe],
          removed: [],
          dateIso: key,
        });
        emitEvent("mealPlan/recipeAddedLegacy", {
          dateIso: key,
          recipeId: rid,
        });
      },

      removeRecipeFromDay: async (day, recipeId) => {
        const key = ISO(day) || String(day ?? "").trim();

        const env = normalizeToEnvelope(get().mealPlan);
        const schedule = env.schedule || {};
        const list = schedule[key] || [];

        let removed = null;

        const next = list.map((entry) => {
          if (entry.recipes && Array.isArray(entry.recipes)) {
            const before = entry.recipes.length;
            const filtered = entry.recipes.filter(
              (r) => normId(r.id) !== normId(recipeId)
            );
            if (filtered.length !== before) {
              removed =
                (entry.recipes || []).find(
                  (r) => normId(r.id) === normId(recipeId)
                ) || null;
              return { ...entry, recipes: filtered };
            }
            return entry;
          }
          return entry;
        });

        // If unchanged, try legacy flatten removal
        if (JSON.stringify(next) === JSON.stringify(list)) {
          const legacyNext = list.filter(
            (r) => normId(r.id) !== normId(recipeId)
          );
          if (legacyNext.length === list.length) return;

          get()._pushHistory({
            mealPlan: get().mealPlan,
            rhythm: get().rhythm,
          });

          const nextSchedule = { ...schedule, [key]: legacyNext };
          const nextEnv = { ...env, schedule: nextSchedule };

          set({ mealPlan: nextEnv, plan: nextEnv });

          optionalRecipeSideEffects({
            added: [],
            removed: [{ id: recipeId }],
            dateIso: key,
          });
          emitEvent("mealPlan/recipeRemovedLegacy", { dateIso: key, recipeId });
          return;
        }

        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });

        const nextSchedule = { ...schedule, [key]: next };
        const nextEnv = { ...env, schedule: nextSchedule };

        set({ mealPlan: nextEnv, plan: nextEnv });

        optionalRecipeSideEffects({
          added: [],
          removed: removed ? [removed] : [],
          dateIso: key,
        });
        emitEvent("mealPlan/recipeRemoved", { dateIso: key, recipeId });
      },

      getRecipesForDay: (day) => {
        const key = ISO(day) || String(day ?? "").trim();
        const env = normalizeToEnvelope(get().mealPlan);
        const entries = (env.schedule || {})[key] || [];
        const all = [];
        entries.forEach((e) => {
          if (e.recipes && Array.isArray(e.recipes)) all.push(...e.recipes);
          else if (e.type !== "fast") all.push(e);
        });
        return all;
      },

      resetMealPlan: () => {
        const prev = get().mealPlan;
        const env = normalizeToEnvelope(prev);
        const hasAnything = Object.keys(env.schedule || {}).length > 0;
        if (!hasAnything) return;

        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ mealPlan: {}, plan: {} });
        emitEvent("mealPlan/reset", {});
      },

      /* ---------------- Generators ---------------- */
      generateDayFromRhythm: (dateIso) => {
        const iso = ISO(dateIso);
        if (!iso) return [];
        const { rhythm } = get();

        const dow = new Date(iso + "T00:00:00").getDay();
        const baseDiet = dietTagForDow(rhythm.dietByDow, dow);

        const ov = (rhythm.overrides || {})[iso] || {};
        const effectiveDiet = ov.dietTag || baseDiet;

        let baseSlots = rhythm.slots;

        if (
          (rhythm.preset || "").toLowerCase() === "adf" &&
          isAdfFastDay(iso, rhythm.adf)
        ) {
          baseSlots = [
            {
              slotId: "ADF",
              label: "ADF Fast",
              type: "fast",
              start: "00:00",
              end: "23:59",
            },
          ];
        }

        if ((rhythm.preset || "").toLowerCase() === "36h") {
          baseSlots = [
            {
              slotId: "F36",
              label: "36h Fast (cont.)",
              type: "fast",
              start: "00:00",
              end: "23:59",
            },
          ];
        }

        if (Array.isArray(ov.slots)) baseSlots = ov.slots;

        const seeded = seedSlotsForDate(baseSlots, effectiveDiet);

        const env = normalizeToEnvelope(get().mealPlan);
        const schedule = env.schedule || {};
        const nextSchedule = { ...schedule, [iso]: seeded };
        const nextEnv = { ...env, schedule: nextSchedule };

        set({ mealPlan: nextEnv, plan: nextEnv });

        emitEvent("mealPlan/dayGenerated", {
          dateIso: iso,
          slots: seeded.length,
        });
        return seeded;
      },

      generateRangeFromRhythm: (startIso, endIso, { force = false } = {}) => {
        const start = new Date(ISO(startIso) + "T00:00:00");
        const end = new Date(ISO(endIso) + "T00:00:00");
        if (Number.isNaN(start) || Number.isNaN(end) || start > end) return;

        const env = normalizeToEnvelope(get().mealPlan);
        const schedule = { ...(env.schedule || {}) };

        const cursor = new Date(start);
        let count = 0;

        while (cursor <= end) {
          const iso = ISO(cursor);
          const existing = schedule[iso];
          if (force || !existing || existing.length === 0) {
            const seeded = seedSlotsForDate(
              get().rhythm.slots,
              dietTagForDow(get().rhythm.dietByDow, cursor.getDay())
            );
            schedule[iso] = seeded;
            count++;
          }
          cursor.setDate(cursor.getDate() + 1);
        }

        const nextEnv = { ...env, schedule };
        set({ mealPlan: nextEnv, plan: nextEnv });

        emitEvent("mealPlan/rangeGenerated", {
          start: ISO(start),
          end: ISO(end),
          days: count,
        });
      },

      /* ---------------- Convenience & Selectors ---------------- */
      getDayEntries: (dateIso) => {
        const iso = ISO(dateIso);
        const env = normalizeToEnvelope(get().mealPlan);
        return ((env.schedule || {})[iso] || []).slice();
      },

      getDaySlots: (dateIso) => {
        const iso = ISO(dateIso);
        const env = normalizeToEnvelope(get().mealPlan);
        const entries = (env.schedule || {})[iso] || [];
        return entries.filter((e) => e.type === "meal" || e.type === "fast");
      },

      upsertSlotForDay: (dateIso, slot) => {
        const iso = ISO(dateIso);
        const env = normalizeToEnvelope(get().mealPlan);
        const schedule = env.schedule || {};
        const entries = (schedule[iso] || []).slice();

        const idx = entries.findIndex((e) => e.slotId === slot.slotId);
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });

        if (idx >= 0) entries[idx] = { ...entries[idx], ...slot };
        else
          entries.push({
            id:
              slot.id ||
              `${slot.slotId}-${Math.random().toString(36).slice(2, 8)}`,
            recipes: [],
            status: "planned",
            ...slot,
          });

        const nextSchedule = { ...schedule, [iso]: entries };
        const nextEnv = { ...env, schedule: nextSchedule };

        set({ mealPlan: nextEnv, plan: nextEnv });
        emitEvent("mealPlan/slotUpserted", {
          dateIso: iso,
          slotId: slot.slotId,
        });
      },

      setSlotStatus: (dateIso, slotId, status) => {
        const iso = ISO(dateIso);
        const env = normalizeToEnvelope(get().mealPlan);
        const schedule = env.schedule || {};
        const entries = (schedule[iso] || []).slice();

        const idx = entries.findIndex((e) => e.slotId === slotId);
        if (idx >= 0) {
          get()._pushHistory({
            mealPlan: get().mealPlan,
            rhythm: get().rhythm,
          });
          entries[idx] = { ...entries[idx], status };

          const nextSchedule = { ...schedule, [iso]: entries };
          const nextEnv = { ...env, schedule: nextSchedule };

          set({ mealPlan: nextEnv, plan: nextEnv });
          emitEvent("mealPlan/slotStatus", { dateIso: iso, slotId, status });
        }
      },

      /* ---------------- Quick diet helpers ---------------- */
      setWeekdayWeekendDiet: (
        weekdayTag = "keto",
        weekendTag = "unrestricted"
      ) => {
        const dietByDow = {
          default: weekendTag,
          1: weekdayTag,
          2: weekdayTag,
          3: weekdayTag,
          4: weekdayTag,
          5: weekdayTag,
          6: weekendTag,
          0: weekendTag,
        };
        const r = { ...get().rhythm, dietByDow };
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ rhythm: r });
        emitEvent("mealPlan/weekdayWeekendSet", { weekdayTag, weekendTag });
      },

      setAlternateWeekPattern: (
        pattern = {
          weekA: "keto",
          weekB: "unrestricted",
          startIso: ISO(new Date()),
        }
      ) => {
        const start = new Date(pattern.startIso + "T00:00:00");
        const overrides = { ...(get().rhythm.overrides || {}) };

        for (let w = 0; w < 8; w++) {
          const isA = w % 2 === 0;
          for (let d = 0; d < 7; d++) {
            const cur = new Date(start);
            cur.setDate(cur.getDate() + w * 7 + d);
            const iso = ISO(cur);
            overrides[iso] = {
              ...(overrides[iso] || {}),
              dietTag: isA ? pattern.weekA : pattern.weekB,
            };
          }
        }

        const rhythm = { ...get().rhythm, overrides };
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ rhythm });
        emitEvent("mealPlan/altWeekPattern", pattern);
      },

      /* ---------------- NBA: Next Best Action suggestions ---------------- */
      getNextBestActions: async (dateIso) => {
        const iso = ISO(dateIso);
        const env = normalizeToEnvelope(get().mealPlan);
        const day = (env.schedule || {})[iso] || [];
        const targets = await getTargetMacros();
        const actions = [];

        if (!day.length) {
          actions.push({
            key: "seed-day",
            label: "Generate today from your rhythm",
            intent: "primary",
            onInvoke: () => get().generateDayFromRhythm(iso),
          });
        }

        const hasMeal = day.some((e) => e.type === "meal");
        const isAllFast = day.length > 0 && !hasMeal;
        if (isAllFast) {
          actions.push({
            key: "plan-refeed",
            label: "Add gentle Refeed (broth + protein)",
            intent: "suggest",
            onInvoke: () => {
              const pick = suggestWestAfrican("keto", true);
              get().addRecipeToDay(
                iso,
                { id: pick.id, title: `${pick.title} (Refeed)` },
                null
              );
            },
          });
        }

        if (targets && targets.protein) {
          const mealCount = day.reduce(
            (acc, s) => acc + (s.recipes?.length || 0),
            0
          );
          if (mealCount < 2) {
            const pick = suggestWestAfrican("keto", true);
            actions.push({
              key: "boost-protein",
              label: `Boost protein with ${pick.title}`,
              intent: "suggest",
              onInvoke: () =>
                get().addRecipeToDay(
                  iso,
                  { id: pick.id, title: pick.title },
                  null
                ),
            });
          }
        }

        actions.push({
          key: "link-batch",
          label: "Add to Batch Session Planner",
          intent: "link",
          onInvoke: () =>
            emitEvent("mealPlan/requestBatchPlanLink", { dateIso: iso }),
        });

        actions.push({
          key: "calendar-sync",
          label: "Sync these slots to your calendar",
          intent: "link",
          onInvoke: () =>
            emitEvent("mealPlan/requestCalendarSync", { dateIso: iso }),
        });

        return actions;
      },

      /* ---------------- Nutrition glance (for TargetsBadge) -------------- */
      getNutritionGlance: async (dateIso) => {
        const iso = ISO(dateIso);
        const targets = await getTargetMacros();
        const env = normalizeToEnvelope(get().mealPlan);
        const entries = (env.schedule || {})[iso] || [];

        let calories = 0,
          protein = 0,
          carbs = 0,
          fat = 0,
          counted = 0;

        entries.forEach((slot) => {
          (slot.recipes || []).forEach((r) => {
            const m = r?.macros;
            if (m) {
              calories += m.calories || 0;
              protein += m.protein || 0;
              carbs += m.carbs || 0;
              fat += m.fat || 0;
              counted++;
            }
          });
        });

        return {
          counted,
          totals: { calories, protein, carbs, fat },
          targets: targets || null,
        };
      },

      /* ---------------- Undo / Redo ---------------- */
      undo: () => {
        const hist = get()._history.slice();
        if (!hist.length) return;
        const snap = hist.pop();
        const curr = { mealPlan: get().mealPlan, rhythm: get().rhythm };
        const future = get()._future.slice();
        future.push(curr);
        // ✅ keep alias mirrored
        set({
          mealPlan: snap.mealPlan,
          plan: snap.mealPlan,
          rhythm: snap.rhythm,
          _history: hist,
          _future: future,
        });
        emitEvent("mealPlan/undo", {});
      },

      redo: () => {
        const future = get()._future.slice();
        if (!future.length) return;
        const next = future.pop();
        const hist = get()._history.slice();
        hist.push({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        // ✅ keep alias mirrored
        set({
          mealPlan: next.mealPlan,
          plan: next.mealPlan,
          rhythm: next.rhythm,
          _history: hist,
          _future: future,
        });
        emitEvent("mealPlan/redo", {});
      },
    }),
    {
      name: "meal-plan-store-v3",
      version: 3,
      storage: createJSONStorage(() => localStorage),

      // ✅ after persisted state rehydrates, pull from legacy keys if needed
      onRehydrateStorage: () => (state, error) => {
        try {
          if (error) return;
          // state is the store state object; call our helper safely
          state?._hydrateFromLegacyIfNeeded?.();
        } catch (_) {}
      },

      migrate: (persisted, version) => {
        if (!persisted) return persisted;

        // Normalize persisted mealPlan/plan into envelope so UI dashboards always see schedule.
        if (persisted.mealPlan)
          persisted.mealPlan = envelopeToStoreState(persisted.mealPlan);
        if (persisted.plan)
          persisted.plan = envelopeToStoreState(persisted.plan);

        // Ensure alias exists after hydration (older persisted shapes)
        if (!persisted.plan && persisted.mealPlan)
          persisted.plan = persisted.mealPlan;

        if (version < 2 && persisted.mealPlan) {
          // If very old shape had schedule-only, wrap it into schedule
          const env = normalizeToEnvelope(persisted.mealPlan);
          const schedule = { ...(env.schedule || {}) };

          // Legacy conversion: if day is an array of recipes (no slot objects), wrap into a LEG slot
          Object.keys(schedule).forEach((k) => {
            const day = schedule[k];
            if (
              Array.isArray(day) &&
              day.length > 0 &&
              !day[0]?.slotId &&
              !day[0]?.type
            ) {
              schedule[k] = [
                {
                  id: `LEG-${Math.random().toString(36).slice(2, 8)}`,
                  slotId: "LEG",
                  label: "Planned Items",
                  type: "meal",
                  start: "12:00",
                  end: "12:30",
                  dietTag: "unrestricted",
                  recipes: day,
                  status: "planned",
                },
              ];
            }
          });

          persisted.mealPlan = { ...env, schedule };
          persisted.plan = persisted.mealPlan;
        }

        if (version < 3) {
          // nothing destructive; keep rhythm/meals
          if (persisted.mealPlan && !persisted.plan)
            persisted.plan = persisted.mealPlan;
        }

        return persisted;
      },

      partialize: (state) => ({
        mealPlan: state.mealPlan,
        plan: state.mealPlan, // persist alias consistently (keeps hydration stable)
        rhythm: state.rhythm,
      }),
    }
  )
);

/* ---------------------------------------------
   Lightweight selectors for lean components
---------------------------------------------- */
export const useMealPlan = () => useMealPlanStore((s) => s.mealPlan, shallow);

export const useMealPlanActions = () =>
  useMealPlanStore(
    (s) => ({
      setMealPlan: s.setMealPlan,
      setPlan: s.setPlan, // ✅ required compat
      updateMealPlanForDay: s.updateMealPlanForDay,
      addRecipeToDay: s.addRecipeToDay,
      removeRecipeFromDay: s.removeRecipeFromDay,
      getRecipesForDay: s.getRecipesForDay,
      resetMealPlan: s.resetMealPlan,
      setRhythmPreset: s.setRhythmPreset,
      setRhythmSlots: s.setRhythmSlots,
      setDietByDow: s.setDietByDow,
      setAdfConfig: s.setAdfConfig,
      setRhythmOverrideForDate: s.setRhythmOverrideForDate,
      clearRhythmOverrideForDate: s.clearRhythmOverrideForDate,
      generateDayFromRhythm: s.generateDayFromRhythm,
      generateRangeFromRhythm: s.generateRangeFromRhythm,
      getDayEntries: s.getDayEntries,
      getDaySlots: s.getDaySlots,
      upsertSlotForDay: s.upsertSlotForDay,
      setSlotStatus: s.setSlotStatus,
      setWeekdayWeekendDiet: s.setWeekdayWeekendDiet,
      setAlternateWeekPattern: s.setAlternateWeekPattern,
      getNextBestActions: s.getNextBestActions,
      getNutritionGlance: s.getNutritionGlance,
      undo: s.undo,
      redo: s.redo,
    }),
    shallow
  );

/* -------------------------------------------------------------------------- */
/* Compatibility exports (used by templates and facade modules)                */
/* -------------------------------------------------------------------------- */

export const useMealPlanningStore = useMealPlanStore;
export const useStore = useMealPlanStore;

export function getDay(isoDate) {
  return useMealPlanStore.getState().getDayEntries(isoDate);
}

export function next7d(start = null) {
  const base = start ? new Date(start) : new Date();
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    out.push({ iso, entries: getDay(iso) });
  }
  return out;
}

export function getRecent(count = 7) {
  const st = useMealPlanStore.getState();
  const env = normalizeToEnvelope(st.mealPlan || {});
  const schedule = env.schedule || {};
  const keys = Object.keys(schedule);
  keys.sort((a, b) => (a < b ? 1 : -1));
  return keys
    .slice(0, Math.max(0, count))
    .map((iso) => ({ iso, entries: schedule[iso] }));
}

export function addQuickPlan(isoDate, slots) {
  const st = useMealPlanStore.getState();
  const list = Array.isArray(slots) ? slots : slots ? [slots] : [];
  list.forEach((slot) => {
    if (!slot) return;
    st.upsertSlotForDay?.(isoDate, slot);
  });
  return getDay(isoDate);
}

// Provide a default export for facades that check StoreModule.default.
const MealPlanStoreModule = {
  useMealPlanStore,
  useMealPlanningStore,
  useStore,
  actions: {
    setMealPlan: (...a) => useMealPlanStore.getState().setMealPlan?.(...a),
    setPlan: (...a) => useMealPlanStore.getState().setPlan?.(...a), // ✅ required compat
    updateMealPlanForDay: (...a) =>
      useMealPlanStore.getState().updateMealPlanForDay?.(...a),
    addRecipeToDay: (...a) =>
      useMealPlanStore.getState().addRecipeToDay?.(...a),
    removeRecipeFromDay: (...a) =>
      useMealPlanStore.getState().removeRecipeFromDay?.(...a),
    resetMealPlan: (...a) => useMealPlanStore.getState().resetMealPlan?.(...a),
    generateDayFromRhythm: (...a) =>
      useMealPlanStore.getState().generateDayFromRhythm?.(...a),
    generateRangeFromRhythm: (...a) =>
      useMealPlanStore.getState().generateRangeFromRhythm?.(...a),
    upsertSlotForDay: (...a) =>
      useMealPlanStore.getState().upsertSlotForDay?.(...a),
  },
  selectors: {
    getDay,
    next7d,
    getRecent,
  },
};

export default MealPlanStoreModule;

/**
 * ✅ Named export expected by:
 *   import { MealPlanStore } from "@/store/MealPlanStore";
 *
 * Provide the module-style object (hooks + actions + selectors).
 */
export const MealPlanStore = MealPlanStoreModule;

/**
 * ✅ Named export expected by:
 *   import { MealPlans } from "@/store/MealPlanStore";
 *
 * Provide the same facade object for back-compat.
 */
export const MealPlans = MealPlanStoreModule;
