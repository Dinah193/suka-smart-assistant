// src/reasoner/budget.js
// Deterministic “budget” defaults for reasoner runs.
// This replaces the need for budget.json.

export const DEFAULT_BUDGET = {
  // hard caps to keep shims safe
  maxRules: 200,
  maxSignals: 200,
  maxActions: 200,
  maxMatches: 500,
  maxMs: 250, // soft runtime target for any reasoner pass
};

/**
 * normalizeBudget(input)
 * - Accepts undefined/null, partial objects, or numbers (treated as maxMs).
 * - Returns a safe, fully-populated budget object.
 */
export function normalizeBudget(input) {
  let partial = {};

  if (typeof input === "number" && Number.isFinite(input)) {
    partial = { maxMs: Math.max(0, input) };
  } else if (input && typeof input === "object") {
    partial = input;
  }

  const merged = { ...DEFAULT_BUDGET, ...partial };

  // Clamp everything to sane non-negative integers where applicable
  const clampInt = (v, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.floor(n));
  };

  return {
    maxRules: clampInt(merged.maxRules, DEFAULT_BUDGET.maxRules),
    maxSignals: clampInt(merged.maxSignals, DEFAULT_BUDGET.maxSignals),
    maxActions: clampInt(merged.maxActions, DEFAULT_BUDGET.maxActions),
    maxMatches: clampInt(merged.maxMatches, DEFAULT_BUDGET.maxMatches),
    maxMs: clampInt(merged.maxMs, DEFAULT_BUDGET.maxMs),
  };
}

/**
 * checkBudget(input, budget?)
 * -----------------------------------------------------------------------------
 * Back-compat export expected by shims:
 *   import { checkBudget } from "@/reasoner/budget";
 *
 * Purpose:
 * - Provide a *pure* helper that returns a normalized budget without mutating.
 *
 * Common uses:
 * - checkBudget(ctx.budget)
 * - checkBudget(ctx, ctx.budget)  (tolerant; will check ctx.budget if present)
 */
export function checkBudget(input, budget) {
  // If caller passed a context object + a second arg, prefer second arg.
  if (budget !== undefined) return normalizeBudget(budget);

  // If caller passed a ctx-like object with .budget, use it.
  if (input && typeof input === "object" && "budget" in input) {
    return normalizeBudget(input.budget);
  }

  // Otherwise treat input as the budget-ish value.
  return normalizeBudget(input);
}

/**
 * evaluateBudget(input, budget?)
 * -----------------------------------------------------------------------------
 * Back-compat alias expected by some runtime modules:
 *   import { evaluateBudget } from "@/reasoner/budget";
 *
 * Keep semantics identical to checkBudget().
 */
export function evaluateBudget(input, budget) {
  return checkBudget(input, budget);
}

/**
 * enforceBudget(state, budget)
 * -----------------------------------------------------------------------------
 * Compatibility export expected by shims.
 *
 * Purpose:
 * - Guarantee the reasoner "state" has a .budget with safe caps.
 * - Return the same state object (mutated) for convenience OR a new one if null.
 *
 * It does NOT stop execution by itself; it only attaches limits that other parts
 * of the pipeline can consult.
 */
export function enforceBudget(state = {}, budget) {
  const normalized = normalizeBudget(budget ?? state.budget);

  // Mutate for compatibility (many shims expect mutation)
  state.budget = normalized;
  return state;
}

export default DEFAULT_BUDGET;
