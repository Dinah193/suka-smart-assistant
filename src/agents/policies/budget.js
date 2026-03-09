// C:\Users\larho\suka-smart-assistant\src\agents\policies\budget.js
// -----------------------------------------------------------------------------
// PURPOSE (Browser-safe policy module)
// -----------------------------------------------------------------------------
// Provides a simple, deterministic budget policy evaluator for SSA agents.
//
// Why this exists:
// - Code (e.g., HouseholdOrchestrator) imports `checkBudget` from "@/agents/policies/budget".
// - Without this .js module, Vite may resolve that import to budget.json, which cannot export
//   named functions, causing build failures.
//
// This module:
// ✅ Is browser-safe (no Node imports).
// ✅ Loads budget defaults from budget.json.
// ✅ Exports `checkBudget()` and `getBudgetPolicy()`.
// ✅ Allows callers to override policy at runtime.
//
// NOTE:
// - Keep `budget.json` as the *data* file.
// - Put logic here.

import budgetDefaults from "@/agents/policies/budget.json";

/* -------------------------------------------------------------------------- */
/*  Types (JSDoc)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} BudgetPolicy
 * @property {boolean} [enabled]
 * @property {number} [dailyLimit]        // dollars, default 0 means "no limit" unless enabled rules say otherwise
 * @property {number} [weeklyLimit]       // dollars
 * @property {number} [monthlyLimit]      // dollars
 * @property {number} [perTripLimit]      // dollars
 * @property {number} [perItemLimit]      // dollars
 * @property {number} [minRemaining]      // dollars (guardrail: must keep at least this remaining)
 * @property {boolean} [blockIfUnknown]   // if true, unknown spend causes block when enabled
 * @property {string}  [currency]         // e.g. "USD"
 * @property {string}  [note]
 */

/**
 * @typedef {Object} BudgetState
 * @property {number} [spentToday]
 * @property {number} [spentThisWeek]
 * @property {number} [spentThisMonth]
 * @property {number} [tripTotal]         // current cart/receipt estimate total
 */

/**
 * @typedef {Object} BudgetCheckInput
 * @property {BudgetPolicy} [policy]      // optional override policy (else uses json defaults)
 * @property {BudgetState}  [state]       // current spend totals (can be partial)
 * @property {number|null}  [amount]      // amount we are considering adding/spending (single item, delta, etc.)
 * @property {number|null}  [itemPrice]   // optional specific item price for per-item checks
 * @property {string}       [scope]       // "shopping" | "mealplanning" | "storehouse" | etc.
 * @property {string}       [id]          // optional identifier for telemetry/debug
 */

/**
 * @typedef {Object} BudgetCheckResult
 * @property {boolean} ok
 * @property {"allow"|"warn"|"block"} verdict
 * @property {string} reason
 * @property {string} currency
 * @property {Object} limits
 * @property {Object} totals
 * @property {Object} remaining
 * @property {string[]} [violations]
 * @property {string} [note]
 */

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Return the normalized effective budget policy (defaults + override).
 * @param {Partial<BudgetPolicy>} [override]
 * @returns {BudgetPolicy}
 */
export function getBudgetPolicy(override) {
  const base = normalizePolicy(budgetDefaults);
  if (!override || typeof override !== "object") return base;
  return normalizePolicy({ ...base, ...override });
}

/**
 * Evaluate a proposed spend against budget policy.
 *
 * Deterministic rules:
 * - If policy.enabled is false -> allow.
 * - If limits are 0/undefined -> treated as "no limit" for that dimension.
 * - If blockIfUnknown is true and amount is null/NaN -> block.
 * - perItemLimit uses itemPrice if provided else amount.
 * - perTripLimit uses state.tripTotal + amount (if tripTotal provided).
 *
 * @param {BudgetCheckInput} input
 * @returns {BudgetCheckResult}
 */
export function checkBudget(input = {}) {
  const policy = getBudgetPolicy(input.policy);
  const currency = policy.currency || "USD";

  const enabled = !!policy.enabled;
  if (!enabled) {
    return {
      ok: true,
      verdict: "allow",
      reason: "budget-policy-disabled",
      currency,
      limits: describeLimits(policy),
      totals: describeTotals(input.state, input.amount),
      remaining: describeRemaining(policy, input.state, input.amount),
      note: policy.note || "",
    };
  }

  const amount = normalizeMoney(input.amount);
  const itemPrice = normalizeMoney(
    Number.isFinite(input.itemPrice) ? input.itemPrice : input.amount
  );

  const state = normalizeState(input.state);

  if (policy.blockIfUnknown && amount == null) {
    return {
      ok: false,
      verdict: "block",
      reason: "amount-unknown-and-policy-blocks",
      currency,
      limits: describeLimits(policy),
      totals: describeTotals(state, amount),
      remaining: describeRemaining(policy, state, amount),
      violations: ["unknown-amount"],
      note: policy.note || "",
    };
  }

  // Treat unknown amount as 0 for non-blocking policies.
  const delta = amount == null ? 0 : amount;

  const violations = [];

  // Per-item
  if (isPositive(policy.perItemLimit) && itemPrice != null) {
    if (itemPrice > policy.perItemLimit) {
      violations.push("per-item-limit-exceeded");
    }
  }

  // Per-trip/cart (if we have a cart total)
  if (isPositive(policy.perTripLimit)) {
    const nextTrip = isFiniteNumber(state.tripTotal)
      ? state.tripTotal + delta
      : null;

    // If no tripTotal and this is a "trip" scope, fall back to amount only.
    const tripBasis =
      nextTrip != null ? nextTrip : amount == null ? null : amount;

    if (tripBasis != null && tripBasis > policy.perTripLimit) {
      violations.push("per-trip-limit-exceeded");
    }
  }

  // Daily/Weekly/Monthly limits using totals + delta
  if (isPositive(policy.dailyLimit)) {
    const next = state.spentToday + delta;
    if (next > policy.dailyLimit) violations.push("daily-limit-exceeded");
  }

  if (isPositive(policy.weeklyLimit)) {
    const next = state.spentThisWeek + delta;
    if (next > policy.weeklyLimit) violations.push("weekly-limit-exceeded");
  }

  if (isPositive(policy.monthlyLimit)) {
    const next = state.spentThisMonth + delta;
    if (next > policy.monthlyLimit) violations.push("monthly-limit-exceeded");
  }

  // Minimum remaining guard (interpreted against the tightest active limit)
  if (isPositive(policy.minRemaining)) {
    const rem = computeTightestRemaining(policy, state, delta);
    if (rem != null && rem < policy.minRemaining) {
      violations.push("min-remaining-guardrail-hit");
    }
  }

  if (!violations.length) {
    return {
      ok: true,
      verdict: "allow",
      reason: "within-budget",
      currency,
      limits: describeLimits(policy),
      totals: describeTotals(state, amount),
      remaining: describeRemaining(policy, state, amount),
      note: policy.note || "",
    };
  }

  // If violations exist: choose block vs warn.
  // Default behavior: hard block on any limit exceed, warn on minRemaining only.
  const hasHard =
    violations.some((v) => v !== "min-remaining-guardrail-hit") ||
    policy.blockIfUnknown;

  return {
    ok: !hasHard ? true : false,
    verdict: hasHard ? "block" : "warn",
    reason: hasHard ? "budget-limit-exceeded" : "budget-guardrail-warning",
    currency,
    limits: describeLimits(policy),
    totals: describeTotals(state, amount),
    remaining: describeRemaining(policy, state, amount),
    violations,
    note: policy.note || "",
  };
}

export default {
  getBudgetPolicy,
  checkBudget,
};

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

function normalizePolicy(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: !!p.enabled,
    dailyLimit: normalizeMoney(p.dailyLimit) ?? 0,
    weeklyLimit: normalizeMoney(p.weeklyLimit) ?? 0,
    monthlyLimit: normalizeMoney(p.monthlyLimit) ?? 0,
    perTripLimit: normalizeMoney(p.perTripLimit) ?? 0,
    perItemLimit: normalizeMoney(p.perItemLimit) ?? 0,
    minRemaining: normalizeMoney(p.minRemaining) ?? 0,
    blockIfUnknown: !!p.blockIfUnknown,
    currency:
      typeof p.currency === "string" && p.currency.trim()
        ? p.currency.trim()
        : "USD",
    note: typeof p.note === "string" ? p.note : "",
  };
}

function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    spentToday: normalizeMoney(s.spentToday) ?? 0,
    spentThisWeek: normalizeMoney(s.spentThisWeek) ?? 0,
    spentThisMonth: normalizeMoney(s.spentThisMonth) ?? 0,
    tripTotal: normalizeMoney(s.tripTotal) ?? 0,
  };
}

function normalizeMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // keep cents but avoid ridiculous values
  const clamped = Math.max(-1_000_000_000, Math.min(1_000_000_000, n));
  return Math.round(clamped * 100) / 100;
}

function isFiniteNumber(v) {
  return Number.isFinite(Number(v));
}

function isPositive(v) {
  return Number.isFinite(v) && v > 0;
}

function describeLimits(policy) {
  return {
    dailyLimit: policy.dailyLimit || 0,
    weeklyLimit: policy.weeklyLimit || 0,
    monthlyLimit: policy.monthlyLimit || 0,
    perTripLimit: policy.perTripLimit || 0,
    perItemLimit: policy.perItemLimit || 0,
    minRemaining: policy.minRemaining || 0,
    blockIfUnknown: !!policy.blockIfUnknown,
  };
}

function describeTotals(state, amount) {
  const s = normalizeState(state);
  const a = normalizeMoney(amount);

  return {
    spentToday: s.spentToday,
    spentThisWeek: s.spentThisWeek,
    spentThisMonth: s.spentThisMonth,
    tripTotal: s.tripTotal,
    delta: a,
    next: {
      spentToday: a == null ? null : s.spentToday + a,
      spentThisWeek: a == null ? null : s.spentThisWeek + a,
      spentThisMonth: a == null ? null : s.spentThisMonth + a,
      tripTotal: a == null ? null : s.tripTotal + a,
    },
  };
}

function describeRemaining(policy, state, amount) {
  const p = normalizePolicy(policy);
  const s = normalizeState(state);
  const a = normalizeMoney(amount);
  const delta = a == null ? 0 : a;

  const remDaily = isPositive(p.dailyLimit)
    ? p.dailyLimit - (s.spentToday + delta)
    : null;
  const remWeekly = isPositive(p.weeklyLimit)
    ? p.weeklyLimit - (s.spentThisWeek + delta)
    : null;
  const remMonthly = isPositive(p.monthlyLimit)
    ? p.monthlyLimit - (s.spentThisMonth + delta)
    : null;
  const remTrip = isPositive(p.perTripLimit)
    ? p.perTripLimit - (s.tripTotal + delta)
    : null;

  return {
    daily: remDaily,
    weekly: remWeekly,
    monthly: remMonthly,
    trip: remTrip,
    tightest: computeTightestRemaining(p, s, delta),
  };
}

function computeTightestRemaining(policy, state, delta) {
  const p = normalizePolicy(policy);
  const s = normalizeState(state);

  const candidates = [];
  if (isPositive(p.dailyLimit))
    candidates.push(p.dailyLimit - (s.spentToday + delta));
  if (isPositive(p.weeklyLimit))
    candidates.push(p.weeklyLimit - (s.spentThisWeek + delta));
  if (isPositive(p.monthlyLimit))
    candidates.push(p.monthlyLimit - (s.spentThisMonth + delta));
  if (isPositive(p.perTripLimit))
    candidates.push(p.perTripLimit - (s.tripTotal + delta));

  if (!candidates.length) return null;
  return Math.min(...candidates);
}
