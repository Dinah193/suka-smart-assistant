// src/reasoner/core.js
import { evaluateConfidence } from "./confidence";
import { applyFreshnessRules } from "./freshness";
import { validateModeOutput } from "./modes/validate";

// Minimal deterministic “reasoner” core.
// Later: plug lexicons + rules + action emitters.

export async function invokeReasoner(payload = {}, opts = {}) {
  const ctx = payload?.input || payload?.ctx || payload || {};
  const mode = opts?.mode || "default";

  // No-op rules engine for now: returns stable empty actions.
  let result = {
    actions: [],
    matches: [],
    rulesFired: [],
    notes: [],
    warnings: [],
    meta: { mode, engine: "reasoner.core", version: "0.1.0" },
    ts: new Date().toISOString(),
  };

  // Freshness rules hook
  result = applyFreshnessRules(result, ctx);

  // Confidence
  result.confidence = evaluateConfidence(result);

  // Validate shape
  return validateModeOutput(result);
}

/**
 * Back-compat export expected by agent shims (e.g., mealPlanningShim).
 * callReasoner() is an alias for invokeReasoner().
 */
export async function callReasoner(payload = {}, opts = {}) {
  return invokeReasoner(payload, opts);
}
