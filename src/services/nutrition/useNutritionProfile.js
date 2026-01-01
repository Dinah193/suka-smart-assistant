/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\nutrition\useNutritionProfile.js
//
// useNutritionProfile() — Shared Nutrition Wiring Hook (SSA)
// -----------------------------------------------------------------------------
// Goal: Give BMI/Macros/Micros a single, simple hook surface that:
//   - boots the shared nutritionStore
//   - keeps an "active profile" in sync across tools
//   - exposes cross-tool flows (save profile -> recompute BMI/macros/micros;
//     macro activity change -> mealplan preferences applied; reset defaults)
//   - remains defensive (SSA standalone) and won't break pages if deps missing
//
// This hook is a *thin convenience wrapper* over:
//   - "@/services/nutrition/nutritionStore"
//   - "@/services/nutrition/nutritionEvents"
//
// It does NOT replace the store; it standardizes usage and wiring.
// -----------------------------------------------------------------------------
//
// Required coverage checklist (in this file):
// 1) User flows:
//    - save profile in BMI updates Macro/Micro tools (PROFILE_UPDATED + BMI_COMPUTED)
//    - changing activity level in Macros updates Meal Planner suggestions
//      (PROFILE_UPDATED + MEALPLAN_PREFERENCES_APPLIED)
//    - reset to defaults (TARGETS_UPDATED + CONSTRAINTS_UPDATED + MEALPLAN...)
// 2) Data contract: canonical objects documented below (JSDoc typedefs)
// 3) State model: uses nutritionStore reducer/store + derived selectors; versioning/migrations live there
// 4) Persistence: Dexie integration + getActivePerson/setActivePerson live there (soft import db)
// 5) EventBus: standardized events through nutritionEvents (soft-import eventBus path inside service)
// 6) Wiring: see patch snippets at bottom for BMI/Macros/Micros usage
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";

// ----------------------------- Defensive Imports -----------------------------
let _useNutritionStore = null;
try {
  // eslint-disable-next-line import/no-unresolved
  const mod = require("@/services/nutrition/nutritionStore");
  _useNutritionStore =
    mod?.useNutritionStore || mod?.default?.useNutritionStore || null;
} catch {}

let _events = null;
try {
  // eslint-disable-next-line import/no-unresolved
  _events = require("@/services/nutrition/nutritionEvents");
} catch {}

// Fall back to no-op event helpers if missing
const NUTRITION_EVENTS = _events?.NUTRITION_EVENTS || {
  ACTIVE_PERSON_CHANGED: "nutrition.activePerson.changed",
  TARGETS_UPDATED: "nutrition.targets.updated",
  CONSTRAINTS_UPDATED: "nutrition.constraints.updated",
  TOOLRUN_LOGGED: "nutrition.toolrun.logged",
  PROFILE_UPDATED: "nutrition.profile.updated",
  BMI_COMPUTED: "nutrition.bmi.computed",
  MACROS_COMPUTED: "nutrition.macros.computed",
  MICROS_COMPUTED: "nutrition.micros.computed",
  MEALPLAN_PREFERENCES_APPLIED: "mealplan.preferences.applied",
};

const onNutritionEvent =
  _events?.onNutritionEvent ||
  (async () => {
    return () => {};
  });

/**
 * PersonProfile (canonical)
 * @typedef {Object} PersonProfile
 * @property {string} id
 * @property {string|null} householdId
 * @property {string} name
 * @property {"female"|"male"|"other"|"unknown"} sex
 * @property {number|null} age
 * @property {number|null} heightCm
 * @property {number|null} weightKg
 * @property {"sedentary"|"light"|"moderate"|"active"|"very_active"|string} activityLevel
 * @property {string} updatedAt
 */

/**
 * DietConstraints (canonical)
 * @typedef {Object} DietConstraints
 * @property {boolean} porkFree
 * @property {boolean} glutenFree
 * @property {boolean} dairyFree
 * @property {boolean} lowCarb
 * @property {boolean} vegetarian
 * @property {boolean} vegan
 * @property {Object.<string, boolean>} custom
 */

/**
 * Allergens (canonical)
 * @typedef {Object} Allergens
 * @property {boolean} peanuts
 * @property {boolean} treeNuts
 * @property {boolean} shellfish
 * @property {boolean} fish
 * @property {boolean} eggs
 * @property {boolean} soy
 * @property {boolean} wheat
 * @property {boolean} milk
 * @property {Object.<string, boolean>} custom
 */

/**
 * NutritionTargets (canonical)
 * @typedef {Object} NutritionTargets
 * @property {number|null} caloriesKcal
 * @property {{proteinG:number|null, carbsG:number|null, fatG:number|null, fiberG:number|null}} macros
 * @property {Object.<string, number|null>} micros
 */

/**
 * ToolDerivations (canonical)
 * @typedef {Object} ToolDerivations
 * @property {Object|null} bmi
 * @property {Object|null} macros
 * @property {Object|null} micros
 * @property {Object.<string, any>} meta
 */

// ------------------------------ Hook API -------------------------------------
/**
 * useNutritionProfile(options?)
 *
 * What it returns (stable shapes):
 * - active: PersonProfile|null
 * - prefs: NutritionPreferencesRecord|null (from store selectors)
 * - targets: NutritionTargets|null
 * - constraints/allergens: DietConstraints/Allergens|null
 * - derived: { bmi, macros, micros }
 * - actions: convenience wrappers:
 *    - bootstrapAndWire()
 *    - setActivePerson(personId)
 *    - saveProfile(profilePatch, opts)  // setActive default true
 *    - changeActivityLevel(nextLevel)   // emits mealplan.preferences.applied via store action
 *    - recomputeBmi(), recomputeMacros(), recomputeMicros()
 *    - resetDefaults()
 * - events: { NUTRITION_EVENTS, onNutritionEvent }
 *
 * This hook intentionally delegates ALL persistence, versioning, migrations,
 * and reducer/store logic to nutritionStore.js.
 */
export function useNutritionProfile(options = {}) {
  const {
    autoBootstrap = true,
    autoWire = true,
    // When saving profile in BMI, most flows want setActive: true
    defaultSetActiveOnSave = true,
    // Optionally listen to extra events to trigger a local UI refresh
    listen = [],
  } = options || {};

  // If nutritionStore is missing, do not break the page.
  const store = _useNutritionStore
    ? _useNutritionStore()
    : { state: {}, actions: {}, selectors: {} };
  const { actions: storeActions = {}, selectors = {}, state = {} } = store;

  const active = selectors.getActivePerson
    ? selectors.getActivePerson()
    : state.activePerson || null;
  const prefs = selectors.getActivePrefs ? selectors.getActivePrefs() : null;
  const targets = selectors.getActiveTargets
    ? selectors.getActiveTargets()
    : prefs?.targets || null;
  const constraints = selectors.getActiveConstraints
    ? selectors.getActiveConstraints()
    : prefs?.constraints || null;
  const allergens = prefs?.allergens || null;
  const derived = selectors.getDerived
    ? selectors.getDerived()
    : state.derived || { bmi: null, macros: null, micros: null };

  const [booted, setBooted] = useState(false);
  const [wired, setWired] = useState(false);
  const unsubRefs = useRef([]);

  const bootstrapAndWire = async () => {
    // bootstrap
    try {
      if (storeActions.bootstrap) await storeActions.bootstrap();
    } catch (e) {
      if (import.meta?.env?.DEV)
        console.warn("[useNutritionProfile] bootstrap failed", e);
    }
    setBooted(true);

    // wire subscriptions (store-level)
    let unsubStore = null;
    try {
      if (autoWire && storeActions.wireSubscriptions) {
        unsubStore = await storeActions.wireSubscriptions();
        unsubRefs.current.push(unsubStore);
        setWired(true);
      }
    } catch (e) {
      if (import.meta?.env?.DEV)
        console.warn("[useNutritionProfile] wireSubscriptions failed", e);
    }

    // optional additional listeners (page-specific)
    try {
      for (const evtType of listen || []) {
        // eslint-disable-next-line no-await-in-loop
        const off = await onNutritionEvent(evtType, () => {
          // no-op by default; hook is about wiring, not forcing UI behavior
          // pages can pass listen + set their own local effects if desired
        });
        unsubRefs.current.push(off);
      }
    } catch (e) {
      if (import.meta?.env?.DEV)
        console.warn("[useNutritionProfile] extra listeners failed", e);
    }

    return () => {
      const offs = unsubRefs.current || [];
      unsubRefs.current = [];
      offs.forEach((fn) => {
        try {
          fn && fn();
        } catch {}
      });
    };
  };

  useEffect(() => {
    let cleanup = null;
    let canceled = false;

    if (!autoBootstrap) return () => {};

    (async () => {
      cleanup = await bootstrapAndWire();
      if (canceled && cleanup) cleanup();
    })();

    return () => {
      canceled = true;
      if (cleanup) cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBootstrap, autoWire]);

  // Convenience wrappers (delegate to nutritionStore actions)
  const api = useMemo(() => {
    const safe = (fn) => (typeof fn === "function" ? fn : async () => null);

    const setActivePerson = async (personId, opts) =>
      safe(storeActions.setActivePerson)(personId, opts);

    const saveProfile = async (profilePatch, opts = {}) => {
      const setActive = opts?.setActive ?? defaultSetActiveOnSave;
      const saved = await safe(storeActions.savePersonProfile)(profilePatch, {
        setActive,
      });

      // By design, BMI page typically wants immediate BMI compute after save.
      // We DO NOT auto-run BMI here unless caller asks; keep deterministic.
      return saved;
    };

    // Changing activity level in Macro tool must also update Meal Planner suggestions.
    // The store action updateActivityLevel emits PROFILE_UPDATED + MEALPLAN_PREFERENCES_APPLIED.
    const changeActivityLevel = async (nextLevel) => {
      if (!active?.id) return null;
      const saved = await safe(storeActions.updateActivityLevel)(
        active.id,
        nextLevel
      );
      // optionally recompute macros immediately (typical Macros UX)
      await safe(storeActions.runMacros)(active.id);
      return saved;
    };

    const recomputeBmi = async () => {
      if (!active?.id) return null;
      return safe(storeActions.runBmi)(active.id);
    };
    const recomputeMacros = async (override = {}) => {
      if (!active?.id) return null;
      return safe(storeActions.runMacros)(active.id, override);
    };
    const recomputeMicros = async () => {
      if (!active?.id) return null;
      return safe(storeActions.runMicros)(active.id);
    };

    const resetDefaults = async () => {
      if (!active?.id) return null;
      return safe(storeActions.resetToDefaults)(active.id);
    };

    const getActivePersonId = async () => safe(storeActions.getActivePerson)();
    const getActivePerson = async () => {
      const pid = await safe(storeActions.getActivePerson)();
      if (!pid) return null;
      // store already provides selectors.getActivePerson() for UI; this is only for callers who want an async read
      return pid;
    };

    return {
      bootstrapAndWire,
      setActivePerson,
      saveProfile,
      changeActivityLevel,
      recomputeBmi,
      recomputeMacros,
      recomputeMicros,
      resetDefaults,
      getActivePersonId,
      getActivePerson,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, defaultSetActiveOnSave, storeActions]);

  return {
    // data
    active,
    prefs,
    targets,
    constraints,
    allergens,
    derived,

    // store passthroughs (in case pages need more)
    storeState: state,
    storeActions: storeActions,
    selectors,

    // convenience action layer
    actions: api,

    // event helpers
    events: { NUTRITION_EVENTS, onNutritionEvent },
    flags: { booted, wired },
  };
}

// -----------------------------------------------------------------------------
// Wiring snippets (minimal patches) — copy/paste into pages
// -----------------------------------------------------------------------------

/**
 * BMI.jsx (minimal patch)
 *
 * + import { useNutritionProfile } from "@/services/nutrition/useNutritionProfile";
 *
 * export default function BMI() {
 * +  const { active, actions, events } = useNutritionProfile({
 * +    autoBootstrap: true,
 * +    autoWire: true,
 * +    listen: [events?.NUTRITION_EVENTS?.ACTIVE_PERSON_CHANGED],
 * +  });
 *
 * +  async function onSaveProfile(profilePatch) {
 * +    const saved = await actions.saveProfile(profilePatch, { setActive: true });
 * +    if (saved?.id) await actions.recomputeBmi();
 * +  }
 * }
 */

/**
 * macros.jsx (minimal patch)
 *
 * + import { useNutritionProfile } from "@/services/nutrition/useNutritionProfile";
 *
 * export default function Macros() {
 * +  const { active, actions, events } = useNutritionProfile({
 * +    autoBootstrap: true,
 * +    autoWire: true,
 * +    listen: [events?.NUTRITION_EVENTS?.PROFILE_UPDATED],
 * +  });
 *
 * +  async function onChangeActivityLevel(nextLevel) {
 * +    await actions.changeActivityLevel(nextLevel); // emits MEALPLAN_PREFERENCES_APPLIED
 * +  }
 *
 * +  async function onRecomputeMacros() {
 * +    await actions.recomputeMacros();
 * +  }
 * }
 */

/**
 * micros.jsx (minimal patch)
 *
 * + import { useNutritionProfile } from "@/services/nutrition/useNutritionProfile";
 *
 * export default function Micros() {
 * +  const { active, actions, events } = useNutritionProfile({
 * +    autoBootstrap: true,
 * +    autoWire: true,
 * +    listen: [events?.NUTRITION_EVENTS?.MACROS_COMPUTED],
 * +  });
 *
 * +  async function onRecomputeMicros() {
 * +    await actions.recomputeMicros();
 * +  }
 *
 * +  async function onResetDefaults() {
 * +    await actions.resetDefaults();
 * +  }
 * }
 */

// -----------------------------------------------------------------------------
// Event/payload examples (what other tools should expect)
// -----------------------------------------------------------------------------
/**
 * ACTIVE_PERSON_CHANGED
 * {
 *   type: "nutrition.activePerson.changed",
 *   ts: "2025-12-21T12:34:56.000Z",
 *   source: "nutritionStore",
 *   data: { personId: "person_...", reason: "setActivePerson" }
 * }
 *
 * TARGETS_UPDATED
 * {
 *   type: "nutrition.targets.updated",
 *   ts: "...",
 *   source: "nutritionStore",
 *   data: { personId: "person_...", targets: { caloriesKcal, macros:{...}, micros:{...} }, reason: "macros" }
 * }
 *
 * CONSTRAINTS_UPDATED
 * {
 *   type: "nutrition.constraints.updated",
 *   ts: "...",
 *   source: "nutritionStore",
 *   data: { personId: "person_...", constraints:{...}, allergens:{...} }
 * }
 *
 * TOOLRUN_LOGGED
 * {
 *   type: "nutrition.toolrun.logged",
 *   ts: "...",
 *   source: "nutritionStore",
 *   data: { personId: "person_...", tool: "MACROS", logId: "toolrun_..." }
 * }
 *
 * MEALPLAN_PREFERENCES_APPLIED (cross-domain)
 * {
 *   type: "mealplan.preferences.applied",
 *   ts: "...",
 *   source: "nutritionStore",
 *   data: { personId: "person_...", from: "nutritionStore.runMacros", targets, constraints, allergens }
 * }
 */
