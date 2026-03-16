// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\MicronutrientCalculator\MicronutrientCalculator.hooks.js

/**
 * MicronutrientCalculator.hooks.js
 * --------------------------------
 * Custom hooks that:
 *  - manage form state for the Micronutrient Calculator UI
 *  - call core logic from MicronutrientCalculator.shim.js
 *  - emit SSA events so Planning Graph / Next Steps can react
 *
 * HOW THIS FITS INTO SSA:
 *  - This hook is the “brain” behind MicronutrientCalculator.view.jsx.
 *  - It does NOT talk directly to Dexie, SessionRunner, or Hub here.
 *    Those concerns stay in higher-level orchestrators.
 *  - It CAN emit events with eventBus so the Planning Graph / Next Steps
 *    engine can suggest:
 *      • meals to cover nutrient gaps,
 *      • garden crops to grow,
 *      • animal products to prioritize,
 *      • plus storehouse / inventory checks.
 *  - `handleNextStepsClick` is the bridge into the global Next Steps flow.
 */

import { useCallback, useMemo, useState } from "react";
import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import {
  normalizeMicronutrientInput,
  calculateMicronutrientTargets,
} from "./MicronutrientCalculator.shim";

/**
 * Default input shape that stays compatible with MicronutrientCalculator.schema.json
 * and MicronutrientCalculator.shim.js.
 */
const DEFAULT_INPUT = {
  profile: {
    name: "",
    sex: "unspecified", // "female" | "male" | "unspecified"
    ageYears: "",
    pregnancyStatus: "none", // "none" | "trimester1" | "trimester2" | "trimester3"
    lactationStatus: "none", // "none" | "lactating0to6m" | "lactating7to12m"
  },
  unitSystem: "imperial", // "imperial" | "metric"
  healthFocus: {
    boneHealth: false,
    bloodHealth: false,
    immuneSupport: false,
    heartHealth: false,
    brainHealth: false,
    metabolicHealth: false,
  },
  constraints: {
    kidneyIssues: false,
    liverIssues: false,
    limitSodium: false,
    limitAddedSugar: false,
    limitSaturatedFat: false,
  },
  dietaryPattern: {
    primaryPattern: "omnivore", // "omnivore" | "pescatarian" | "vegetarian" | "vegan"
    avoidsPork: true, // SSA default preference
    avoidsShellfish: true,
    avoidsDairy: false,
    avoidsGluten: false,
  },
  rounding: {
    gramsDecimals: 1,
    milligramsDecimals: 0,
    microgramsDecimals: 0,
  },
  ssaIntegration: {
    autosaveProfile: false,
    allowLinkToMealPlanner: true,
    allowLinkToInventoryGaps: true,
  },
  meta: {
    // reserved for planner/runtime metadata; kept opaque here
  },
};

const MODULE_SOURCE = "features/calculators/health/MicronutrientCalculator";
const NODE_ID = "health.micronutrientCalculator";

/**
 * Shallow helper to safely clone and set nested values using dot-path.
 * Only supports up to a few nesting levels, which is enough here.
 *
 * @param {object} obj
 * @param {string} path
 * @param {any} value
 * @returns {object}
 */
function setByPath(obj, path, value) {
  if (!path) return obj;
  const segments = path.split(".");
  const clone = { ...obj };

  let cursor = clone;
  for (let i = 0; i < segments.length; i++) {
    const key = segments[i];
    if (i === segments.length - 1) {
      cursor[key] = value;
    } else {
      const existing = cursor[key];
      cursor[key] =
        existing && typeof existing === "object" ? { ...existing } : {};
      cursor = cursor[key];
    }
  }

  return clone;
}

/**
 * Very light validation: we mainly check presence of age and basic ranges.
 * Deeper validation is handled by JSON schema + shim functions.
 *
 * @param {object} input
 * @returns {{ [key: string]: string }}
 */
function validateInput(input) {
  const errors = {};
  const profile = input.profile || {};

  if (profile.ageYears === "" || profile.ageYears == null) {
    errors["profile.ageYears"] = "Age is required.";
  } else if (Number.isNaN(Number(profile.ageYears))) {
    errors["profile.ageYears"] = "Age must be a number.";
  } else if (Number(profile.ageYears) < 1 || Number(profile.ageYears) > 120) {
    errors["profile.ageYears"] = "Age must be between 1 and 120.";
  }

  if (!["imperial", "metric"].includes(input.unitSystem)) {
    errors["unitSystem"] = "Unit system must be imperial or metric.";
  }

  return errors;
}

/**
 * Emit a calculator-level event for observability and Planning Graph hooks.
 *
 * @param {string} type
 * @param {object} payload
 */
function emitCalculatorEvent(type, payload) {
  try {
    emit({
      type,
      ts: new Date().toISOString(),
      source: MODULE_SOURCE,
      data: payload,
    });
  } catch (err) {
    // Fails silently; calculators should never crash the app.
    // eslint-disable-next-line no-console
    console.warn("[MicronutrientCalculator] Failed to emit event", err);
  }
}

/**
 * Main hook used by MicronutrientCalculator.view.jsx
 *
 * @returns {{
 *   input: object,
 *   result: object | null,
 *   isCalculating: boolean,
 *   hasResult: boolean,
 *   errors: Record<string,string>,
 *   handleChange: (path: string, value: any) => void,
 *   handleToggle: (path: string) => void,
 *   handleSubmit: () => Promise<void> | void,
 *   handleReset: () => void,
 *   handleNextStepsClick: () => void
 * }}
 */
export function useMicronutrientCalculator() {
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState({});
  const [isCalculating, setIsCalculating] = useState(false);
  const [lastRunAt, setLastRunAt] = useState(null);

  const hasResult = useMemo(() => !!result, [result]);

  const handleChange = useCallback((path, value) => {
    setInput((prev) => setByPath(prev, path, value));
    // Clear error for this field, if present
    setErrors((prev) => {
      if (!prev || !prev[path]) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  const handleToggle = useCallback((path) => {
    setInput((prev) => {
      // Read current value
      let current = prev;
      const segments = path.split(".");
      for (let i = 0; i < segments.length - 1; i++) {
        current = current?.[segments[i]] ?? {};
      }
      const lastKey = segments[segments.length - 1];
      const currentVal = !!current[lastKey];
      return setByPath(prev, path, !currentVal);
    });
    setErrors((prev) => {
      if (!prev || !prev[path]) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    setInput(DEFAULT_INPUT);
    setResult(null);
    setErrors({});
    setIsCalculating(false);
    setLastRunAt(null);

    emitCalculatorEvent("calculator.micronutrient.reset", {
      nodeId: NODE_ID,
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    const validationErrors = validateInput(input);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      emitCalculatorEvent("calculator.micronutrient.validationFailed", {
        nodeId: NODE_ID,
        errors: validationErrors,
      });
      return;
    }

    setIsCalculating(true);
    setErrors({});

    try {
      const normalized = normalizeMicronutrientInput(input);
      const calcResult = calculateMicronutrientTargets(normalized);

      setResult(calcResult);
      const now = new Date().toISOString();
      setLastRunAt(now);

      emitCalculatorEvent("calculator.micronutrient.calculated", {
        nodeId: NODE_ID,
        input: normalized,
        result: calcResult,
        ranAt: now,
        familyFundMode: !!familyFundMode,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[MicronutrientCalculator] Calculation failed", err);
      setErrors({
        _global: "Something went wrong while calculating. Please try again.",
      });

      emitCalculatorEvent("calculator.micronutrient.error", {
        nodeId: NODE_ID,
        error: String(err),
      });
    } finally {
      setIsCalculating(false);
    }
  }, [input]);

  /**
   * Trigger the Next Steps / Planning Graph flow for this node.
   * This does NOT directly start a SessionRunner; it signals to
   * the orchestration layer that the user wants to use these
   * micronutrient targets to plan meals, garden crops, or animal
   * products.
   */
  const handleNextStepsClick = useCallback(() => {
    if (!result) {
      // Nothing to export; quietly no-op.
      return;
    }

    const normalized = normalizeMicronutrientInput(input);

    emitCalculatorEvent("planningGraph.nextSteps.requested", {
      nodeId: NODE_ID,
      kind: "calculator",
      source: "health",
      label: "Micronutrient Daily Targets",
      input: normalized,
      result,
      lastRunAt,
      familyFundMode: !!familyFundMode,
      // Suggestions for downstream consumers:
      //  - meal planner: use nutrient gaps to suggest recipes
      //  - garden: map to crops that supply key nutrients
      //  - animal: identify cuts/organs that fill gaps
      preferredModules: [
        "MealPlanner",
        "GardenPlanner",
        "AnimalPlanner",
        "StorehouseInventory",
      ],
    });
  }, [input, result, lastRunAt]);

  return {
    input,
    result,
    isCalculating,
    hasResult,
    errors,
    handleChange,
    handleToggle,
    handleSubmit,
    handleReset,
    handleNextStepsClick,
  };
}
