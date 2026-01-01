// src/store/NutritionGoalsStore.js
import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { persist, createJSONStorage } from "zustand/middleware";

/* ----------------------------------------------------------------------------
   NutritionGoalsStore (v1)
   - Multi-profile nutrition targets (household-aware)
   - BMR/TDEE calculators (Mifflin-St Jeor), goal deltas (+/-%), activity factors
   - Macro presets: USDA, Keto, Low-Carb, Muscle-Gain, Cut, Custom
   - Rhythm-aware day modifiers: IF/OMAD/ADF/36h => zero/reduced intake; Refeed days
   - Per-date overrides (calories/macros/micros)
   - Allergen/ingredient avoid list (guides suggestions downstream)
   - Event/Automation taps for Orchestrators & UI (TargetsBadge, NBAToolbar)
   - Undo/Redo (local stack, non-persisted)
---------------------------------------------------------------------------- */

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const ISO = (d) => {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d + "T00:00:00") : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
};

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

/* ------------------------ Calculators ------------------------ */
/** Mifflin–St Jeor BMR */
function calcBMR({ sex = "female", weightKg = 70, heightCm = 170, ageYears = 30 }) {
  const s = sex === "male" ? 5 : -161;
  return 10 * weightKg + 6.25 * heightCm - 5 * ageYears + s;
}

const ActivityFactor = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very: 1.725,
  extra: 1.9,
};

function calcTDEE(bmr, activity = "moderate") {
  const f = ActivityFactor[activity] || ActivityFactor.moderate;
  return bmr * f;
}

/** Macro split helpers */
function macrosFromCalories({ calories = 2000, split = { proteinPct: 30, fatPct: 30, carbPct: 40 } }) {
  const pCals = (calories * clamp(split.proteinPct, 0, 100)) / 100;
  const fCals = (calories * clamp(split.fatPct, 0, 100)) / 100;
  const cCals = (calories * clamp(split.carbPct, 0, 100)) / 100;
  return {
    calories,
    protein: Math.round(pCals / 4),
    fat: Math.round(fCals / 9),
    carbs: Math.round(cCals / 4),
  };
}

function pctSplitFromStyle(style = "usda") {
  switch ((style || "").toLowerCase()) {
    case "keto": return { proteinPct: 25, fatPct: 70, carbPct: 5 };
    case "lowcarb": return { proteinPct: 35, fatPct: 45, carbPct: 20 };
    case "muscle": return { proteinPct: 35, fatPct: 25, carbPct: 40 };
    case "cut": return { proteinPct: 40, fatPct: 30, carbPct: 30 };
    default: return { proteinPct: 30, fatPct: 30, carbPct: 40 }; // USDA-ish
  }
}

/* ------------------------ Defaults ------------------------ */
const DEFAULT_PROFILE = {
  id: "primary",
  displayName: "You",
  sex: "female",          // "male" | "female"
  ageYears: 30,
  heightCm: 170,
  weightKg: 70,
  activity: "moderate",   // sedentary|light|moderate|very|extra
  goal: "maintain",       // lose|maintain|gain
  goalDeltaPct: 0,        // -20 … +20
  macroStyle: "usda",     // usda|keto|lowcarb|muscle|cut|custom
  customSplit: { proteinPct: 30, fatPct: 30, carbPct: 40 }, // used if macroStyle=custom
  // Micronutrients (optional minimal set; UI can expand)
  micros: {
    sodiumMg: 2300,
    potassiumMg: 3500,
    fiberG: 25,
    ironMg: 18,
    calciumMg: 1000,
    magnesiumMg: 320,
    vitaminCMg: 75,
  },
};

const DEFAULT_STATE = {
  activeProfileId: "primary",
  profiles: { primary: DEFAULT_PROFILE },
  avoidList: { allergens: [], ingredients: [] }, // e.g., {allergens:["dairy"], ingredients:["soy lecithin"]}
  perDateOverrides: {
    // "2025-10-12": { calories: 1800, macros: { protein: 130, fat: 60, carbs: 160 }, note: "Refeed day" }
  },
  rhythmHints: {
    // Optional shadow from MealPlan rhythms if you want: { "2025-10-12": { preset: "16:8" } }
  },
  units: "imperial", // imperial | metric (UI can convert when editing)
};

/* ------------------------ Store ------------------------ */
export const useNutritionGoalsStore = create(
  persist(
    (set, get) => ({
      ...DEFAULT_STATE,

      /* ------------ Local undo/redo (non-persisted) ------------ */
      _history: [],
      _future: [],
      _pushHistory: (snap) => {
        const hist = get()._history.slice(-49);
        hist.push(snap);
        set({ _history: hist, _future: [] });
      },

      /* ------------ Profiles CRUD ------------ */
      setActiveProfile: (id) => {
        if (!id) return;
        const prev = get().activeProfileId;
        if (prev === id) return;
        get()._pushHistory({ ...get() });
        set({ activeProfileId: id });
        emitEvent("nutrition/activeProfileChanged", { id });
      },

      upsertProfile: (profile) => {
        if (!profile?.id) return;
        const profiles = { ...get().profiles, [profile.id]: { ...(get().profiles[profile.id] || DEFAULT_PROFILE), ...profile } };
        get()._pushHistory({ ...get() });
        set({ profiles });
        emitEvent("nutrition/profileUpserted", { id: profile.id });
      },

      removeProfile: (id) => {
        const profiles = { ...get().profiles };
        if (!profiles[id] || id === "primary") return; // keep primary
        get()._pushHistory({ ...get() });
        delete profiles[id];
        const nextActive = get().activeProfileId === id ? "primary" : get().activeProfileId;
        set({ profiles, activeProfileId: nextActive });
        emitEvent("nutrition/profileRemoved", { id });
      },

      setUnits: (units = "imperial") => {
        get()._pushHistory({ ...get() });
        set({ units });
        emitEvent("nutrition/unitsChanged", { units });
      },

      /* ------------ Avoid list ------------ */
      setAvoidList: (avoid) => {
        const next = {
          allergens: Array.isArray(avoid?.allergens) ? avoid.allergens : (get().avoidList.allergens || []),
          ingredients: Array.isArray(avoid?.ingredients) ? avoid.ingredients : (get().avoidList.ingredients || []),
        };
        get()._pushHistory({ ...get() });
        set({ avoidList: next });
        emitEvent("nutrition/avoidListChanged", next);
      },

      /* ------------ Date overrides (per-day targets) ------------ */
      setDateOverride: (dateIso, override) => {
        const iso = ISO(dateIso);
        if (!iso || !override) return;
        const perDate = { ...(get().perDateOverrides || {}) };
        perDate[iso] = { ...(perDate[iso] || {}), ...override };
        get()._pushHistory({ ...get() });
        set({ perDateOverrides: perDate });
        emitEvent("nutrition/dateOverrideSet", { dateIso: iso });
      },

      clearDateOverride: (dateIso) => {
        const iso = ISO(dateIso);
        if (!iso) return;
        const perDate = { ...(get().perDateOverrides || {}) };
        if (!perDate[iso]) return;
        get()._pushHistory({ ...get() });
        delete perDate[iso];
        set({ perDateOverrides: perDate });
        emitEvent("nutrition/dateOverrideCleared", { dateIso: iso });
      },

      /* ------------ Rhythm hints (optional sync from MealPlan rhythms) ------------ */
      setRhythmHintForDate: (dateIso, hint) => {
        const iso = ISO(dateIso);
        if (!iso) return;
        const rh = { ...(get().rhythmHints || {}) };
        rh[iso] = { ...(rh[iso] || {}), ...(hint || {}) };
        get()._pushHistory({ ...get() });
        set({ rhythmHints: rh });
        emitEvent("nutrition/rhythmHint", { dateIso: iso, hint: rh[iso] });
      },

      /* ------------ Compute Targets (base → adjusted) ------------ */
      /** Returns base daily targets (no date modifiers) for the active profile */
      getBaseTargets: () => {
        const { profiles, activeProfileId } = get();
        const p = profiles[activeProfileId] || DEFAULT_PROFILE;

        // BMR/TDEE
        const bmr = calcBMR(p);
        let tdee = calcTDEE(bmr, p.activity);

        // Goal delta
        const delta = clamp(
          p.goal === "lose" ? (p.goalDeltaPct || -15) : p.goal === "gain" ? (p.goalDeltaPct || 10) : 0,
          -40, 40
        );
        const calories = Math.round(tdee * (1 + delta / 100));

        const split = p.macroStyle === "custom" ? (p.customSplit || pctSplitFromStyle("usda")) : pctSplitFromStyle(p.macroStyle);
        const macros = macrosFromCalories({ calories, split });

        return {
          profileId: p.id,
          bmr: Math.round(bmr),
          tdee: Math.round(tdee),
          calories: macros.calories,
          protein: macros.protein,
          fat: macros.fat,
          carbs: macros.carbs,
          micros: { ...(p.micros || {}) },
          meta: { macroStyle: p.macroStyle, split },
        };
      },

      /**
       * Returns FINAL targets for a given date, applying:
       * - Rhythm hint (IF/OMAD/ADF/36h => zero or reduced intake)
       * - Per-date overrides (wins last)
       * - Optional "refeed" day bump
       */
      getTargetsForDate: (dateIso, opts = { fastingReductionPct: 100, refeedBumpPct: 15 }) => {
        const iso = ISO(dateIso);
        const base = get().getBaseTargets();
        const rh = (get().rhythmHints || {})[iso] || {};
        const override = (get().perDateOverrides || {})[iso];

        let out = { ...base };

        // Apply rhythm: if fasting preset says "no meals" today, reduce calories/macros
        const preset = (rh.preset || "").toLowerCase();
        if (preset === "omad") {
          // keep calories but condense to one window → no change here; UI/MealPlan handles slots
        } else if (preset === "36h" || preset === "fast" || rh.isFastDay) {
          const red = clamp(opts.fastingReductionPct ?? 100, 0, 100);
          const factor = (100 - red) / 100; // 0 when 100% reduction
          out.calories = Math.round(out.calories * factor);
          out.protein = Math.round(out.protein * factor);
          out.fat = Math.round(out.fat * factor);
          out.carbs = Math.round(out.carbs * factor);
        } else if (preset === "adf") {
          if (rh.isFastDay) {
            const red = clamp(opts.fastingReductionPct ?? 100, 0, 100);
            const factor = (100 - red) / 100;
            out.calories = Math.round(out.calories * factor);
            out.protein = Math.round(out.protein * factor);
            out.fat = Math.round(out.fat * factor);
            out.carbs = Math.round(out.carbs * factor);
          }
        }

        // Refeed bump (gentle surplus after a fast)
        if (rh.refeed) {
          const bump = clamp(opts.refeedBumpPct ?? 15, 0, 40) / 100;
          out.calories = Math.round(out.calories * (1 + bump));
          // simple heuristic: distribute bump mostly to protein/carb
          out.protein = Math.round(out.protein * (1 + bump * 0.6));
          out.carbs   = Math.round(out.carbs * (1 + bump * 0.6));
          out.fat     = Math.round(out.fat * (1 + bump * 0.3));
        }

        // Apply explicit per-date override last
        if (override) {
          out = {
            ...out,
            ...(override.calories != null ? { calories: override.calories } : {}),
            ...(override.macros ? {
              protein: override.macros.protein ?? out.protein,
              fat: override.macros.fat ?? out.fat,
              carbs: override.macros.carbs ?? out.carbs,
            } : {}),
            micros: { ...out.micros, ...(override.micros || {}) },
          };
        }

        return out;
      },

      /* ------------ Quick Presets / Helpers ------------ */
      applyMacroStyle: (macroStyle = "usda") => {
        const { profiles, activeProfileId } = get();
        const p = profiles[activeProfileId];
        if (!p) return;
        const next = { ...p, macroStyle, ...(macroStyle === "custom" ? {} : { customSplit: pctSplitFromStyle(macroStyle) }) };
        get()._pushHistory({ ...get() });
        set({ profiles: { ...profiles, [activeProfileId]: next } });
        emitEvent("nutrition/macroStyleChanged", { profileId: activeProfileId, macroStyle });
      },

      setCustomSplit: (split) => {
        const { profiles, activeProfileId } = get();
        const p = profiles[activeProfileId];
        if (!p) return;
        const cs = {
          proteinPct: clamp(split?.proteinPct ?? p.customSplit.proteinPct ?? 30, 0, 100),
          fatPct: clamp(split?.fatPct ?? p.customSplit.fatPct ?? 30, 0, 100),
          carbPct: clamp(split?.carbPct ?? p.customSplit.carbPct ?? 40, 0, 100),
        };
        const sum = cs.proteinPct + cs.fatPct + cs.carbPct;
        if (sum !== 100) {
          const scale = 100 / sum;
          cs.proteinPct = Math.round(cs.proteinPct * scale);
          cs.fatPct = Math.round(cs.fatPct * scale);
          cs.carbPct = 100 - cs.proteinPct - cs.fatPct;
        }
        const next = { ...p, macroStyle: "custom", customSplit: cs };
        get()._pushHistory({ ...get() });
        set({ profiles: { ...profiles, [activeProfileId]: next } });
        emitEvent("nutrition/customSplitSet", { profileId: activeProfileId, split: cs });
      },

      setGoal: (goal = "maintain", goalDeltaPct = 0) => {
        const { profiles, activeProfileId } = get();
        const p = profiles[activeProfileId];
        if (!p) return;
        const next = { ...p, goal, goalDeltaPct: clamp(goalDeltaPct, -40, 40) };
        get()._pushHistory({ ...get() });
        set({ profiles: { ...profiles, [activeProfileId]: next } });
        emitEvent("nutrition/goalSet", { profileId: activeProfileId, goal: next.goal, delta: next.goalDeltaPct });
      },

      updateStats: (stats = {}) => {
        const { profiles, activeProfileId } = get();
        const p = profiles[activeProfileId];
        if (!p) return;
        const next = {
          ...p,
          sex: stats.sex ?? p.sex,
          ageYears: stats.ageYears ?? p.ageYears,
          heightCm: stats.heightCm ?? p.heightCm,
          weightKg: stats.weightKg ?? p.weightKg,
          activity: stats.activity ?? p.activity,
        };
        get()._pushHistory({ ...get() });
        set({ profiles: { ...profiles, [activeProfileId]: next } });
        emitEvent("nutrition/statsUpdated", { profileId: activeProfileId });
      },

      /* ------------ Nutrition Glance for TargetsBadge ------------ */
      getTargetsBadgeModel: (dateIso) => {
        const t = get().getTargetsForDate(dateIso);
        return {
          calories: t.calories,
          protein: t.protein,
          carbs: t.carbs,
          fat: t.fat,
          // You can add percentage-of-target math in the UI by comparing to MealPlan totals
        };
      },

      /* ------------ Undo / Redo ------------ */
      undo: () => {
        const hist = get()._history.slice();
        if (!hist.length) return;
        const snap = hist.pop();
        const curr = { ...get() };
        const future = get()._future.slice();
        future.push(curr);
        // Ensure we don't overwrite methods; only state keys:
        const { activeProfileId, profiles, avoidList, perDateOverrides, rhythmHints, units } = snap;
        set({ activeProfileId, profiles, avoidList, perDateOverrides, rhythmHints, units, _history: hist, _future: future });
        emitEvent("nutrition/undo", {});
      },

      redo: () => {
        const future = get()._future.slice();
        if (!future.length) return;
        const next = future.pop();
        const hist = get()._history.slice();
        hist.push({ ...get() });
        const { activeProfileId, profiles, avoidList, perDateOverrides, rhythmHints, units } = next;
        set({ activeProfileId, profiles, avoidList, perDateOverrides, rhythmHints, units, _history: hist, _future: future });
        emitEvent("nutrition/redo", {});
      },
    }),
    {
      name: "nutrition-goals-store-v1",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) => persisted,
      partialize: (s) => ({
        activeProfileId: s.activeProfileId,
        profiles: s.profiles,
        avoidList: s.avoidList,
        perDateOverrides: s.perDateOverrides,
        rhythmHints: s.rhythmHints,
        units: s.units,
      }),
    }
  )
);

/* ---------------------------------------------
   Lightweight selectors (UI-friendly)
---------------------------------------------- */
export const useNutritionProfiles = () =>
  useNutritionGoalsStore((s) => ({ activeProfileId: s.activeProfileId, profiles: s.profiles }), shallow);

export const useNutritionActions = () =>
  useNutritionGoalsStore(
    (s) => ({
      // profiles
      setActiveProfile: s.setActiveProfile,
      upsertProfile: s.upsertProfile,
      removeProfile: s.removeProfile,
      updateStats: s.updateStats,
      // prefs
      setUnits: s.setUnits,
      setAvoidList: s.setAvoidList,
      // dates
      setDateOverride: s.setDateOverride,
      clearDateOverride: s.clearDateOverride,
      setRhythmHintForDate: s.setRhythmHintForDate,
      // targets + presets
      getBaseTargets: s.getBaseTargets,
      getTargetsForDate: s.getTargetsForDate,
      getTargetsBadgeModel: s.getTargetsBadgeModel,
      applyMacroStyle: s.applyMacroStyle,
      setCustomSplit: s.setCustomSplit,
      setGoal: s.setGoal,
      // undo/redo
      undo: s.undo,
      redo: s.redo,
    }),
    shallow
  );
