// src/reasoner/modes/validate.js
export function validateModeOutput(output) {
  // Ensures the reasoner output shape is stable for shims
  const o = output || {};
  return {
    ok: true,
    actions: Array.isArray(o.actions) ? o.actions : [],
    matches: Array.isArray(o.matches) ? o.matches : [],
    rulesFired: Array.isArray(o.rulesFired) ? o.rulesFired : [],
    notes: Array.isArray(o.notes) ? o.notes : [],
    warnings: Array.isArray(o.warnings) ? o.warnings : [],
    confidence: typeof o.confidence === "number" ? o.confidence : undefined,
    meta: o.meta && typeof o.meta === "object" ? o.meta : {},
    ts: o.ts || new Date().toISOString(),
  };
}

/**
 * Back-compat export expected by agent shims (e.g., mealPlanningShim).
 * validateResponse() is an alias for validateModeOutput().
 */
export function validateResponse(output) {
  return validateModeOutput(output);
}
