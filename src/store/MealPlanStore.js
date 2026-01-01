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
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
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
async function optionalRecipeSideEffects({ added = [], removed = [], dateIso }) {
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
        { slotId: "F", label: "Fasting", type: "fast", start: "20:00", end: "12:00" },
        { slotId: "M1", label: "Meal 1", type: "meal", start: "12:00", end: "12:45" },
        { slotId: "M2", label: "Meal 2", type: "meal", start: "19:00", end: "19:45" },
      ];
    case "18:6":
      return [
        { slotId: "F", label: "Fasting", type: "fast", start: "20:00", end: "14:00" },
        { slotId: "M1", label: "Meal 1", type: "meal", start: "14:00", end: "14:45" },
        { slotId: "M2", label: "Meal 2", type: "meal", start: "19:00", end: "19:45" },
      ];
    case "omad":
      return [
        { slotId: "F", label: "Fasting", type: "fast", start: "20:00", end: "18:00" },
        { slotId: "OMAD", label: "Single Meal", type: "meal", start: "18:00", end: "19:00" },
      ];
    case "36h":
      return [{ slotId: "F36", label: "Extended Fast", type: "fast", start: "20:00", end: "08:00" }];
    case "adf":
      return buildSlotsFromPreset("16:8");
    default:
      return [
        { slotId: "B", label: "Breakfast", type: "meal", start: "08:00", end: "08:45" },
        { slotId: "L", label: "Lunch", type: "meal", start: "12:30", end: "13:15" },
        { slotId: "D", label: "Dinner", type: "meal", start: "18:30", end: "19:15" },
      ];
  }
}

function dietTagForDow(dietByDow, dow) {
  if (!dietByDow) return "unrestricted";
  return Object.prototype.hasOwnProperty.call(dietByDow, dow)
    ? dietByDow[dow]
    : (dietByDow.default || "unrestricted");
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
  { id: "jollof-rice", tag: ["unrestricted"], title: "Jollof Rice", proteinBias: "chicken/lamb" },
  { id: "suya-spiced-beef", tag: ["keto", "unrestricted"], title: "Suya-Spiced Beef Skewers", proteinBias: "beef" },
  { id: "egusi-soup", tag: ["keto", "unrestricted"], title: "Egusi Soup", proteinBias: "goat" },
  { id: "waakye-bowl", tag: ["unrestricted"], title: "Waakye Bowl", proteinBias: "fish" },
  { id: "grilled-tilapia-attaieke", tag: ["unrestricted"], title: "Grilled Tilapia + Attiéké", proteinBias: "fish" },
  { id: "yassa-onions-lamb", tag: ["keto", "unrestricted"], title: "Yassa Lamb (Onion-Lemon)", proteinBias: "lamb" },
  { id: "akara", tag: ["unrestricted"], title: "Akara (Bean Fritters)", proteinBias: "legume" },
];

function suggestWestAfrican(dietTag, wantHighProtein = false) {
  let pool = WEST_AFRICAN_INDEX.filter((x) => x.tag.includes(dietTag) || x.tag.includes("unrestricted"));
  if (wantHighProtein) {
    pool = pool.filter((x) => ["beef", "goat", "lamb", "fish", "chicken"].some((p) => x.proteinBias.includes(p)));
  }
  if (!pool.length) pool = WEST_AFRICAN_INDEX;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return { id: pick.id, title: pick.title };
}

/* ----------------------------------------------------------------------------
   Store
---------------------------------------------------------------------------- */
export const useMealPlanStore = create(
  persist(
    (set, get) => ({
      /* ---------------- Core State ---------------- */
      mealPlan: {},

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
      _history: [],      // undo stack
      _future: [],       // redo stack
      _pushHistory: (snapshot) => {
        const hist = get()._history.slice(-49); // cap 50
        hist.push(snapshot);
        set({ _history: hist, _future: [] });
      },

      /* ---------------- Rhythm API ---------------- */
      setRhythmPreset: (preset) => {
        const prev = get().rhythm;
        const r = { ...prev, preset: preset || "custom", slots: buildSlotsFromPreset(preset) };
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
        const r = { ...get().rhythm, dietByDow: dietByDow || { default: "unrestricted" } };
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
        nextOverrides[iso] = { ...(nextOverrides[iso] || {}), ...(override || {}) };
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        r.overrides = nextOverrides;
        set({ rhythm: r });
        emitEvent("mealPlan/overrideChanged", { dateIso: iso, override: nextOverrides[iso] });
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
        const next = plan && typeof plan === "object" ? plan : {};
        const prev = get().mealPlan;
        if (objectShallowEqual(prev, next)) return;
        get()._pushHistory({ mealPlan: prev, rhythm: get().rhythm });
        set({ mealPlan: next });
        emitEvent("mealPlan/planSet", { days: Object.keys(next).length });
      },

      updateMealPlanForDay: (day, items) => {
        const key = ISO(day) || String(day ?? "").trim();
        const prevPlan = get().mealPlan;
        const prevDay = prevPlan[key] || [];
        const nextDay = Array.isArray(items) ? items : [];
        if (arraysShallowEqual(prevDay, nextDay)) return;
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ mealPlan: { ...prevPlan, [key]: nextDay } });
        emitEvent("mealPlan/dayUpdated", { dateIso: key, count: nextDay.length });
      },

      addRecipeToDay: async (day, recipe, slotId = null) => {
        if (!recipe) return;
        const key = ISO(day) || String(day ?? "").trim();

        if (!get().mealPlan[key] || get().mealPlan[key].length === 0) {
          get().generateDayFromRhythm(key);
        }

        const listNow = get().mealPlan[key] ? [...get().mealPlan[key]] : [];

        // Find a target slot
        let targetIndex = -1;
        if (slotId) targetIndex = listNow.findIndex((x) => x.slotId === slotId);
        if (targetIndex === -1) targetIndex = listNow.findIndex((x) => x.type === "meal");

        const rid = normId(recipe.id || recipe.title || `${Date.now()}`);
        const exists = listNow.some((r) => r.recipes?.some?.((rr) => normId(rr.id) === rid));
        if (exists) return;

        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });

        if (targetIndex >= 0) {
          const slot = { ...listNow[targetIndex] };
          const nextRecipes = Array.isArray(slot.recipes) ? [...slot.recipes] : [];
          nextRecipes.push({ ...recipe, id: rid });
          slot.recipes = nextRecipes;
          listNow[targetIndex] = slot;
          set({ mealPlan: { ...get().mealPlan, [key]: listNow } });
          optionalRecipeSideEffects({ added: [recipe], removed: [], dateIso: key });
          emitEvent("mealPlan/recipeAdded", { dateIso: key, slotId: slot.slotId, recipeId: rid });
          return;
        }

        // Fallback legacy append
        listNow.push({ ...recipe, id: rid });
        set({ mealPlan: { ...get().mealPlan, [key]: listNow } });
        optionalRecipeSideEffects({ added: [recipe], removed: [], dateIso: key });
        emitEvent("mealPlan/recipeAddedLegacy", { dateIso: key, recipeId: rid });
      },

      removeRecipeFromDay: async (day, recipeId) => {
        const key = ISO(day) || String(day ?? "").trim();
        const plan = get().mealPlan;
        const list = plan[key] || [];

        let removed = null;

        const next = list.map((entry) => {
          if (entry.recipes && Array.isArray(entry.recipes)) {
            const before = entry.recipes.length;
            const filtered = entry.recipes.filter((r) => normId(r.id) !== normId(recipeId));
            if (filtered.length !== before) {
              removed = (entry.recipes || []).find((r) => normId(r.id) === normId(recipeId)) || null;
              return { ...entry, recipes: filtered };
            }
            return entry;
          }
          return entry;
        });

        if (JSON.stringify(next) === JSON.stringify(list)) {
          // legacy flatten
          const legacyNext = list.filter((r) => normId(r.id) !== normId(recipeId));
          if (legacyNext.length === list.length) return;
          get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
          set({ mealPlan: { ...plan, [key]: legacyNext } });
          optionalRecipeSideEffects({ added: [], removed: [{ id: recipeId }], dateIso: key });
          emitEvent("mealPlan/recipeRemovedLegacy", { dateIso: key, recipeId });
          return;
        }

        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ mealPlan: { ...plan, [key]: next } });
        optionalRecipeSideEffects({ added: [], removed: removed ? [removed] : [], dateIso: key });
        emitEvent("mealPlan/recipeRemoved", { dateIso: key, recipeId });
      },

      getRecipesForDay: (day) => {
        const key = ISO(day) || String(day ?? "").trim();
        const entries = get().mealPlan[key] || [];
        const all = [];
        entries.forEach((e) => {
          if (e.recipes && Array.isArray(e.recipes)) all.push(...e.recipes);
          else if (e.type !== "fast") all.push(e);
        });
        return all;
      },

      resetMealPlan: () => {
        const prev = get().mealPlan;
        if (!prev || Object.keys(prev).length === 0) return;
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ mealPlan: {} });
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

        if ((rhythm.preset || "").toLowerCase() === "adf" && isAdfFastDay(iso, rhythm.adf)) {
          baseSlots = [{ slotId: "ADF", label: "ADF Fast", type: "fast", start: "00:00", end: "23:59" }];
        }

        if ((rhythm.preset || "").toLowerCase() === "36h") {
          baseSlots = [{ slotId: "F36", label: "36h Fast (cont.)", type: "fast", start: "00:00", end: "23:59" }];
        }

        if (Array.isArray(ov.slots)) baseSlots = ov.slots;

        const seeded = seedSlotsForDate(baseSlots, effectiveDiet);
        const plan = get().mealPlan;
        set({ mealPlan: { ...plan, [iso]: seeded } });
        emitEvent("mealPlan/dayGenerated", { dateIso: iso, slots: seeded.length });
        return seeded;
      },

      generateRangeFromRhythm: (startIso, endIso, { force = false } = {}) => {
        const start = new Date(ISO(startIso) + "T00:00:00");
        const end = new Date(ISO(endIso) + "T00:00:00");
        if (Number.isNaN(start) || Number.isNaN(end) || start > end) return;

        const plan = { ...get().mealPlan };
        const cursor = new Date(start);
        let count = 0;
        while (cursor <= end) {
          const iso = ISO(cursor);
          if (force || !plan[iso] || plan[iso].length === 0) {
            const seeded = get().generateDayFromRhythm(iso);
            plan[iso] = seeded;
            count++;
          }
          cursor.setDate(cursor.getDate() + 1);
        }
        set({ mealPlan: plan });
        emitEvent("mealPlan/rangeGenerated", { start: ISO(start), end: ISO(end), days: count });
      },

      /* ---------------- Convenience & Selectors ---------------- */
      getDayEntries: (dateIso) => {
        const iso = ISO(dateIso);
        return (get().mealPlan[iso] || []).slice();
      },

      getDaySlots: (dateIso) => {
        const iso = ISO(dateIso);
        const entries = get().mealPlan[iso] || [];
        return entries.filter((e) => e.type === "meal" || e.type === "fast");
      },

      upsertSlotForDay: (dateIso, slot) => {
        const iso = ISO(dateIso);
        const plan = { ...get().mealPlan };
        const entries = (plan[iso] || []).slice();

        const idx = entries.findIndex((e) => e.slotId === slot.slotId);
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        if (idx >= 0) entries[idx] = { ...entries[idx], ...slot };
        else
          entries.push({
            id: slot.id || `${slot.slotId}-${Math.random().toString(36).slice(2, 8)}`,
            recipes: [],
            status: "planned",
            ...slot,
          });

        plan[iso] = entries;
        set({ mealPlan: plan });
        emitEvent("mealPlan/slotUpserted", { dateIso: iso, slotId: slot.slotId });
      },

      setSlotStatus: (dateIso, slotId, status) => {
        const iso = ISO(dateIso);
        const plan = { ...get().mealPlan };
        const entries = (plan[iso] || []).slice();
        const idx = entries.findIndex((e) => e.slotId === slotId);
        if (idx >= 0) {
          get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
          entries[idx] = { ...entries[idx], status };
          plan[iso] = entries;
          set({ mealPlan: plan });
          emitEvent("mealPlan/slotStatus", { dateIso: iso, slotId, status });
        }
      },

      /* ---------------- Quick diet helpers ---------------- */
      setWeekdayWeekendDiet: (weekdayTag = "keto", weekendTag = "unrestricted") => {
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

      setAlternateWeekPattern: (pattern = { weekA: "keto", weekB: "unrestricted", startIso: ISO(new Date()) }) => {
        const start = new Date(pattern.startIso + "T00:00:00");
        const overrides = { ...(get().rhythm.overrides || {}) };

        for (let w = 0; w < 8; w++) {
          const isA = w % 2 === 0;
          for (let d = 0; d < 7; d++) {
            const cur = new Date(start);
            cur.setDate(cur.getDate() + w * 7 + d);
            const iso = ISO(cur);
            overrides[iso] = { ...(overrides[iso] || {}), dietTag: isA ? pattern.weekA : pattern.weekB };
          }
        }

        const rhythm = { ...get().rhythm, overrides };
        get()._pushHistory({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ rhythm });
        emitEvent("mealPlan/altWeekPattern", pattern);
      },

      /* ---------------- NBA: Next Best Action suggestions ----------------
         Feeds NBAToolbar.jsx with context-aware actions.
      ------------------------------------------------------------------- */
      getNextBestActions: async (dateIso) => {
        const iso = ISO(dateIso);
        const day = get().mealPlan[iso] || [];
        const targets = await getTargetMacros();
        const actions = [];

        // 1) Empty day? Seed it.
        if (!day.length) {
          actions.push({
            key: "seed-day",
            label: "Generate today from your rhythm",
            intent: "primary",
            onInvoke: () => get().generateDayFromRhythm(iso),
          });
        }

        // 2) Fast-only day? Offer refeed planning.
        const hasMeal = day.some((e) => e.type === "meal");
        const isAllFast = day.length > 0 && !hasMeal;
        if (isAllFast) {
          actions.push({
            key: "plan-refeed",
            label: "Add gentle Refeed (broth + protein)",
            intent: "suggest",
            onInvoke: () => {
              const pick = suggestWestAfrican("keto", true);
              get().addRecipeToDay(iso, { id: pick.id, title: `${pick.title} (Refeed)` }, null);
            },
          });
        }

        // 3) Missing protein? Suggest WA high-protein.
        if (targets && targets.protein) {
          // simple heuristic: count recipes
          const mealCount = day.reduce((acc, s) => acc + (s.recipes?.length || 0), 0);
          if (mealCount < 2) {
            const pick = suggestWestAfrican("keto", true);
            actions.push({
              key: "boost-protein",
              label: `Boost protein with ${pick.title}`,
              intent: "suggest",
              onInvoke: () => get().addRecipeToDay(iso, { id: pick.id, title: pick.title }, null),
            });
          }
        }

        // 4) Batch cooking link
        actions.push({
          key: "link-batch",
          label: "Add to Batch Session Planner",
          intent: "link",
          onInvoke: () => emitEvent("mealPlan/requestBatchPlanLink", { dateIso: iso }),
        });

        // 5) Calendar sync
        actions.push({
          key: "calendar-sync",
          label: "Sync these slots to your calendar",
          intent: "link",
          onInvoke: () => emitEvent("mealPlan/requestCalendarSync", { dateIso: iso }),
        });

        return actions;
      },

      /* ---------------- Nutrition glance (for TargetsBadge) --------------
         Returns minimal aggregate info UI can use quickly.
      ------------------------------------------------------------------- */
      getNutritionGlance: async (dateIso) => {
        const iso = ISO(dateIso);
        const targets = await getTargetMacros();
        const entries = get().mealPlan[iso] || [];
        // If macros exist on recipes, sum them. Otherwise, return counts only.
        let calories = 0, protein = 0, carbs = 0, fat = 0, counted = 0;
        entries.forEach((slot) => {
          (slot.recipes || []).forEach((r) => {
            // expected shape { macros: { calories, protein, carbs, fat } }
            const m = r?.macros;
            if (m) {
              calories += m.calories || 0;
              protein  += m.protein  || 0;
              carbs    += m.carbs    || 0;
              fat      += m.fat      || 0;
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
        set({ mealPlan: snap.mealPlan, rhythm: snap.rhythm, _history: hist, _future: future });
        emitEvent("mealPlan/undo", {});
      },

      redo: () => {
        const future = get()._future.slice();
        if (!future.length) return;
        const next = future.pop();
        const hist = get()._history.slice();
        hist.push({ mealPlan: get().mealPlan, rhythm: get().rhythm });
        set({ mealPlan: next.mealPlan, rhythm: next.rhythm, _history: hist, _future: future });
        emitEvent("mealPlan/redo", {});
      },
    }),
    {
      name: "meal-plan-store-v3",
      version: 3,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) => {
        if (!persisted) return persisted;
        // v1->v2 migration (legacy flatten → slot bucket)
        if (version < 2 && persisted.mealPlan) {
          const mp = { ...persisted.mealPlan };
          Object.keys(mp).forEach((k) => {
            const day = mp[k];
            if (Array.isArray(day) && day.length > 0 && !day[0].slotId && !day[0].type) {
              mp[k] = [
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
          persisted.mealPlan = mp;
        }
        // v2->v3 migration: preserve data; rename key if needed.
        if (version < 3) {
          // nothing destructive; keep rhythm/meals
        }
        return persisted;
      },
      partialize: (state) => ({
        mealPlan: state.mealPlan,
        rhythm: state.rhythm,
        // NOTE: undo/redo stacks are intentionally NOT persisted
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
      // Legacy-friendly
      setMealPlan: s.setMealPlan,
      updateMealPlanForDay: s.updateMealPlanForDay,
      addRecipeToDay: s.addRecipeToDay,
      removeRecipeFromDay: s.removeRecipeFromDay,
      getRecipesForDay: s.getRecipesForDay,
      resetMealPlan: s.resetMealPlan,
      // Rhythm
      setRhythmPreset: s.setRhythmPreset,
      setRhythmSlots: s.setRhythmSlots,
      setDietByDow: s.setDietByDow,
      setAdfConfig: s.setAdfConfig,
      setRhythmOverrideForDate: s.setRhythmOverrideForDate,
      clearRhythmOverrideForDate: s.clearRhythmOverrideForDate,
      generateDayFromRhythm: s.generateDayFromRhythm,
      generateRangeFromRhythm: s.generateRangeFromRhythm,
      // Slots and helpers
      getDayEntries: s.getDayEntries,
      getDaySlots: s.getDaySlots,
      upsertSlotForDay: s.upsertSlotForDay,
      setSlotStatus: s.setSlotStatus,
      // Quick diets
      setWeekdayWeekendDiet: s.setWeekdayWeekendDiet,
      setAlternateWeekPattern: s.setAlternateWeekPattern,
      // NBA + Nutrition
      getNextBestActions: s.getNextBestActions,
      getNutritionGlance: s.getNutritionGlance,
      // Undo/Redo
      undo: s.undo,
      redo: s.redo,
    }),
    shallow
  );
