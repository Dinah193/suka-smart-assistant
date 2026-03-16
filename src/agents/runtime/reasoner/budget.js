// File: src/agents/runtime/reasoner/budget.js
// SSA — Agents Runtime Budget Wrapper (production-ready)
//
// Purpose
// - Provide a stable runtime import surface for agent shims (storehouseShim, cleaningShim, etc.).
// - Delegate actual budget reasoning to src/reasoner/budget.js.
// - Keep shims decoupled from reasoner folder layout so future refactors don’t cascade.
//
// Notes
// - This wrapper intentionally does NOT add caching, persistence, or network calls.
// - If you later add “modes”, “selectors”, “confidence”, “freshness”, etc.,
//   those can live in src/reasoner/* and be surfaced here as needed.

import * as BudgetReasoner from "@/reasoner/budget";

/**
 * Primary API expected by agent shims.
 * Keep signature flexible: (input, context?)
 */
export function evaluateBudget(input, context = {}) {
  // Prefer the canonical export if it exists
  if (typeof BudgetReasoner.evaluateBudget === "function") {
    return BudgetReasoner.evaluateBudget(input, context);
  }

  // Fallbacks (in case reasoner exports a default or different name)
  if (typeof BudgetReasoner.default === "function") {
    return BudgetReasoner.default(input, context);
  }

  if (
    BudgetReasoner.default &&
    typeof BudgetReasoner.default.evaluateBudget === "function"
  ) {
    return BudgetReasoner.default.evaluateBudget(input, context);
  }

  throw new Error(
    "agents/runtime/reasoner/budget.js: Could not find evaluateBudget export in '@/reasoner/budget'. " +
      "Ensure src/reasoner/budget.js exports `evaluateBudget` (named) or a default function."
  );
}

/**
 * Back-compat API expected by some shims (e.g., preservationShim.js).
 *
 * `checkBudget` is treated as a thin alias for `evaluateBudget`.
 * It returns whatever the underlying reasoner returns (sync/async supported).
 *
 * @param {any} input
 * @param {object} [context]
 * @returns {any}
 */
export function checkBudget(input, context = {}) {
  return evaluateBudget(input, context);
}

/* ------------------------------ shim-facing guard ------------------------------ */

/**
 * Back-compat named export expected by storehouseShim (and similar):
 *   import { enforceBudget } from "@/agents/runtime/reasoner/budget";
 *
 * This does NOT run any AI. It deterministically interprets "budget" signals and/or
 * reasoner output into an OK/WARN/BLOCK decision.
 *
 * Inputs supported:
 * - Plain object:
 *   { ok?:boolean, remaining?:number, limit?:number, cost?:number, reason?:string }
 * - Number:
 *   treated as "remaining" (>=0 OK, <0 BLOCK)
 * - Any value returned by src/reasoner/budget.js (best-effort)
 *
 * Policy supported (best-effort):
 * - policy.budget.*:
 *   { minRemaining?:number, minRemainingRatio?:number, allowIfUnknown?:boolean }
 *
 * @param {any} value
 * @param {object} [policy]
 * @param {object} [opts]
 * @returns {{
 *   ok: boolean,
 *   level: "accept" | "warn" | "block",
 *   budget: { ok?:boolean, remaining?:number, limit?:number, cost?:number, reason?:string },
 *   thresholds: { minRemaining:number|null, minRemainingRatio:number|null, allowIfUnknown:boolean },
 *   reasons: Array<{ code:string, message:string, detail?:any }>,
 *   trace?: any
 * }}
 */
export function enforceBudget(value, policy, opts = {}) {
  const p = policy && typeof policy === "object" ? policy : {};
  const pb = p.budget && typeof p.budget === "object" ? p.budget : {};

  const thresholds = {
    minRemaining:
      pb.minRemaining != null
        ? Number(pb.minRemaining)
        : opts.minRemaining != null
        ? Number(opts.minRemaining)
        : null,
    minRemainingRatio:
      pb.minRemainingRatio != null
        ? Number(pb.minRemainingRatio)
        : opts.minRemainingRatio != null
        ? Number(opts.minRemainingRatio)
        : null,
    allowIfUnknown:
      pb.allowIfUnknown != null
        ? !!pb.allowIfUnknown
        : opts.allowIfUnknown != null
        ? !!opts.allowIfUnknown
        : true,
  };

  const reasons = [];

  // Normalize to a canonical budget object
  const budget = normalizeBudget(value);

  // Unknown budget: allow by default (but warn) unless explicitly disallowed.
  const hasSignal =
    budget &&
    (typeof budget.ok === "boolean" ||
      typeof budget.remaining === "number" ||
      typeof budget.limit === "number" ||
      typeof budget.cost === "number");

  if (!hasSignal) {
    const ok = thresholds.allowIfUnknown === true;
    const level = ok ? "warn" : "block";
    reasons.push({
      code: ok ? "budget.unknown_warn" : "budget.unknown_block",
      message: ok
        ? "Budget signals unavailable; allowing by default (allowIfUnknown=true)."
        : "Budget signals unavailable; blocking (allowIfUnknown=false).",
      detail: { thresholds },
    });

    return {
      ok,
      level,
      budget: budget || {},
      thresholds,
      reasons,
      trace: value,
    };
  }

  // If budget.ok is explicitly false => block
  if (budget.ok === false) {
    reasons.push({
      code: "budget.block_flag",
      message: "Budget indicates not OK (ok=false).",
      detail: { budget, thresholds },
    });
    return {
      ok: false,
      level: "block",
      budget,
      thresholds,
      reasons,
      trace: value,
    };
  }

  // Remaining checks (absolute)
  if (
    typeof budget.remaining === "number" &&
    Number.isFinite(budget.remaining)
  ) {
    if (
      thresholds.minRemaining != null &&
      Number.isFinite(thresholds.minRemaining)
    ) {
      if (budget.remaining < thresholds.minRemaining) {
        reasons.push({
          code: "budget.block_min_remaining",
          message: `Remaining budget ${budget.remaining} is below minRemaining ${thresholds.minRemaining}.`,
          detail: { budget, thresholds },
        });
        return {
          ok: false,
          level: "block",
          budget,
          thresholds,
          reasons,
          trace: value,
        };
      }
    }

    // If remaining is negative, block regardless
    if (budget.remaining < 0) {
      reasons.push({
        code: "budget.block_negative_remaining",
        message: `Remaining budget ${budget.remaining} is negative.`,
        detail: { budget, thresholds },
      });
      return {
        ok: false,
        level: "block",
        budget,
        thresholds,
        reasons,
        trace: value,
      };
    }
  }

  // Remaining ratio checks (remaining/limit)
  if (
    thresholds.minRemainingRatio != null &&
    Number.isFinite(thresholds.minRemainingRatio) &&
    typeof budget.remaining === "number" &&
    typeof budget.limit === "number" &&
    Number.isFinite(budget.remaining) &&
    Number.isFinite(budget.limit) &&
    budget.limit > 0
  ) {
    const ratio = budget.remaining / budget.limit;
    if (ratio < thresholds.minRemainingRatio) {
      reasons.push({
        code: "budget.warn_low_ratio",
        message: `Remaining ratio ${(ratio * 100).toFixed(
          1
        )}% is below minRemainingRatio ${(
          thresholds.minRemainingRatio * 100
        ).toFixed(1)}%.`,
        detail: { ratio, budget, thresholds },
      });
      return {
        ok: true,
        level: "warn",
        budget: { ...budget, remainingRatio: ratio },
        thresholds,
        reasons,
        trace: value,
      };
    }
  }

  // If cost is known and remaining is known and remaining < cost => warn/block
  if (
    typeof budget.cost === "number" &&
    Number.isFinite(budget.cost) &&
    typeof budget.remaining === "number" &&
    Number.isFinite(budget.remaining)
  ) {
    if (budget.remaining < budget.cost) {
      reasons.push({
        code: "budget.warn_cost_exceeds_remaining",
        message: `Estimated cost ${budget.cost} exceeds remaining ${budget.remaining}.`,
        detail: { budget, thresholds },
      });
      return {
        ok: true,
        level: "warn",
        budget,
        thresholds,
        reasons,
        trace: value,
      };
    }
  }

  // Default accept
  reasons.push({
    code: "budget.accept",
    message: "Budget checks passed.",
    detail: { budget, thresholds },
  });

  return {
    ok: true,
    level: "accept",
    budget,
    thresholds,
    reasons,
    trace: value,
  };
}

function normalizeBudget(v) {
  // Number -> treat as remaining
  if (typeof v === "number") {
    return { remaining: Number.isFinite(v) ? v : undefined };
  }

  if (!v || typeof v !== "object") return {};

  // Common shapes
  // - { ok, remaining, limit, reason }
  // - { budget: { ... } }
  // - { result: { ... } }
  // - { meta: { budget: ... } }
  const direct = v;

  const b1 =
    direct.budget && typeof direct.budget === "object" ? direct.budget : null;
  const b2 =
    direct.result && typeof direct.result === "object" ? direct.result : null;
  const b3 =
    direct.meta &&
    typeof direct.meta === "object" &&
    direct.meta.budget &&
    typeof direct.meta.budget === "object"
      ? direct.meta.budget
      : null;

  const src = b1 || b2 || b3 || direct;

  const out = {
    ok: typeof src.ok === "boolean" ? src.ok : undefined,
    remaining:
      typeof src.remaining === "number"
        ? src.remaining
        : typeof src.remainingBudget === "number"
        ? src.remainingBudget
        : undefined,
    limit:
      typeof src.limit === "number"
        ? src.limit
        : typeof src.max === "number"
        ? src.max
        : typeof src.budget === "number"
        ? src.budget
        : undefined,
    cost:
      typeof src.cost === "number"
        ? src.cost
        : typeof src.estimatedCost === "number"
        ? src.estimatedCost
        : undefined,
    reason:
      typeof src.reason === "string"
        ? src.reason
        : typeof src.message === "string"
        ? src.message
        : undefined,
  };

  // Clean NaN/Infinity
  for (const k of ["remaining", "limit", "cost"]) {
    if (out[k] != null && !Number.isFinite(out[k])) out[k] = undefined;
  }

  return out;
}

/**
 * Optional: convenience default export for older import styles.
 */
export default {
  evaluateBudget,
  checkBudget,
  enforceBudget,
};
