// File: src/agents/runtime/reasoner/confidence.js
// SSA — Reasoner Confidence Utilities (production-ready)
//
// Purpose
// - Provide deterministic confidence scoring for SSA "reasoner" outputs.
// - Combine multiple evidence signals into a stable 0..1 confidence value.
// - Offer helpers to degrade confidence with time (freshness), conflicts, or missing data.
// - Keep dependencies at zero; safe for offline builds and Vite.
//
// Design notes
// - Confidence is not "truth" — it is an engine-side reliability indicator.
// - Default combination uses a softened multiplicative model (sqrt/product) to avoid harsh drops.
// - All functions are pure and side-effect free.

function clamp01(n) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function safeNum(v, fallback = 0) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Combine confidence parts into a single score.
 * Soft multiplicative model:
 * - multiply all parts (punishes weak links),
 * - then apply sqrt softening to avoid overly harsh compounding.
 *
 * @param  {...number} parts
 * @returns {number} 0..1
 */
export function combineConfidence(...parts) {
  const vals = (parts || [])
    .flat()
    .map((x) => (typeof x === "number" ? x : safeNum(x, 1)))
    .map((x) => clamp01(x));

  if (!vals.length) return 0.5;

  let prod = 1;
  for (const v of vals) prod *= v;

  // soften compounding
  return clamp01(Math.sqrt(prod));
}

/**
 * Weighted average of confidence parts.
 * Useful when signals are additive and independent.
 *
 * @param {Array<{ value:number, weight?:number }>} items
 * @param {number} [fallback=0.5]
 * @returns {number}
 */
export function weightedConfidence(items, fallback = 0.5) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return clamp01(fallback);

  let wsum = 0;
  let sum = 0;

  for (const it of arr) {
    const v = clamp01(safeNum(it?.value, NaN));
    if (!Number.isFinite(v)) continue;
    const w = safeNum(it?.weight, 1);
    if (!Number.isFinite(w) || w <= 0) continue;
    wsum += w;
    sum += v * w;
  }

  if (wsum <= 0) return clamp01(fallback);
  return clamp01(sum / wsum);
}

/**
 * Confidence for coverage/hit-rate scenarios:
 * e.g., matched 7 out of 10 items -> base confidence.
 *
 * @param {number} hits
 * @param {number} total
 * @param {{ floor?:number, ceiling?:number, curve?:number }} [opts]
 * @returns {number}
 */
export function confidenceFromCoverage(hits, total, opts = {}) {
  const h = Math.max(0, safeNum(hits, 0));
  const t = Math.max(0, safeNum(total, 0));

  if (!t) return 0.2;

  const ratio = clamp01(h / t);
  const floor = clamp01(opts.floor ?? 0.15);
  const ceiling = clamp01(opts.ceiling ?? 0.95);
  const curve = Math.max(0.1, safeNum(opts.curve ?? 1.0, 1.0));

  // Curve >1 makes it stricter; <1 more generous
  const curved = Math.pow(ratio, curve);

  return clamp01(floor + (ceiling - floor) * curved);
}

/**
 * Apply penalties to an existing confidence score.
 * Penalties multiply; each penalty is interpreted as a multiplier in (0..1].
 *
 * @param {number} base
 * @param {Array<number|{multiplier:number}>} penalties
 * @returns {number}
 */
export function applyPenalties(base, penalties = []) {
  let out = clamp01(safeNum(base, 0.5));
  const arr = Array.isArray(penalties) ? penalties : [];

  for (const p of arr) {
    const m = typeof p === "number" ? p : p?.multiplier;
    const mult = clamp01(safeNum(m, 1));
    // do not increase confidence by penalty
    out = clamp01(out * Math.min(mult, 1));
  }

  return out;
}

/**
 * Apply boosts to an existing confidence score.
 * Boosts should be gentle; this uses a saturating approach so you never jump too high.
 *
 * @param {number} base
 * @param {Array<number|{amount:number}>} boosts Each boost is 0..1 (small recommended like 0.02..0.10)
 * @returns {number}
 */
export function applyBoosts(base, boosts = []) {
  let out = clamp01(safeNum(base, 0.5));
  const arr = Array.isArray(boosts) ? boosts : [];

  for (const b of arr) {
    const a = typeof b === "number" ? b : b?.amount;
    const amt = clamp01(safeNum(a, 0));
    // saturating add: out += (1-out)*amt
    out = clamp01(out + (1 - out) * amt);
  }

  return out;
}

/**
 * Confidence decay over time.
 * If data is old, confidence decreases toward floor.
 *
 * @param {number} base 0..1
 * @param {number} ageMs how old the evidence is
 * @param {{ halfLifeMs?:number, floor?:number }} [opts]
 * @returns {number}
 */
export function decayConfidenceByAge(base, ageMs, opts = {}) {
  const b = clamp01(safeNum(base, 0.5));
  const age = Math.max(0, safeNum(ageMs, 0));
  const halfLifeMs = Math.max(
    1,
    safeNum(
      opts.halfLifeMs ?? 1000 * 60 * 60 * 24 * 30,
      1000 * 60 * 60 * 24 * 30
    )
  ); // 30 days
  const floor = clamp01(opts.floor ?? 0.15);

  // exponential decay: b * 0.5^(age/halfLife)
  const factor = Math.pow(0.5, age / halfLifeMs);
  const decayed = b * factor;

  // never fall below floor unless base is already below it
  return clamp01(Math.max(Math.min(b, decayed), Math.min(b, floor)));
}

/**
 * Confidence adjustment based on conflicts.
 * - If there are conflicts, reduce confidence proportional to severity.
 *
 * @param {number} base
 * @param {Array<{ severity?:number }>|number} conflicts
 * @param {{ maxPenalty?:number }} [opts]
 * @returns {number}
 */
export function reduceConfidenceForConflicts(base, conflicts, opts = {}) {
  const b = clamp01(safeNum(base, 0.5));
  const maxPenalty = clamp01(opts.maxPenalty ?? 0.65); // at worst multiply by 0.35

  let sevSum = 0;

  if (typeof conflicts === "number") {
    sevSum = Math.max(0, conflicts);
  } else if (Array.isArray(conflicts)) {
    for (const c of conflicts) {
      const s = safeNum(c?.severity, 1);
      if (Number.isFinite(s) && s > 0) sevSum += s;
    }
  } else {
    return b;
  }

  if (sevSum <= 0) return b;

  // severity->multiplier curve: more conflict reduces
  // multiplier = 1 / (1 + k*sevSum)
  const k = 0.35;
  const multRaw = 1 / (1 + k * sevSum);

  // bound penalty so it doesn't become absurd
  const mult = clamp01(Math.max(multRaw, 1 - maxPenalty));

  return clamp01(b * mult);
}

/**
 * Normalize arbitrary confidence input:
 * - supports { confidence }, { conf }, or plain number
 *
 * @param {any} v
 * @param {number} [fallback=0.5]
 * @returns {number}
 */
export function normalizeConfidence(v, fallback = 0.5) {
  if (typeof v === "number") return clamp01(v);
  if (v && typeof v === "object") {
    if (typeof v.confidence === "number") return clamp01(v.confidence);
    if (typeof v.conf === "number") return clamp01(v.conf);
    if (typeof v.score === "number") return clamp01(v.score);
  }
  return clamp01(fallback);
}

/**
 * Build a standard confidence meta object used across reasoner outputs.
 *
 * @param {object} params
 * @param {number} params.base
 * @param {Array<number>} [params.parts]
 * @param {Array<any>} [params.penalties]
 * @param {Array<any>} [params.boosts]
 * @param {number} [params.ageMs]
 * @param {Array<any>|number} [params.conflicts]
 * @param {object} [params.opts]
 * @returns {{ confidence:number, trace: object }}
 */
export function buildConfidence(params = {}) {
  const base = clamp01(safeNum(params.base, 0.5));

  const parts = Array.isArray(params.parts) ? params.parts : [];
  const combined = parts.length ? combineConfidence(base, ...parts) : base;

  let c = combined;

  if (params.ageMs != null) {
    c = decayConfidenceByAge(c, params.ageMs, params.opts?.decay || {});
  }
  if (params.conflicts != null) {
    c = reduceConfidenceForConflicts(
      c,
      params.conflicts,
      params.opts?.conflicts || {}
    );
  }
  if (params.penalties != null) {
    c = applyPenalties(c, params.penalties);
  }
  if (params.boosts != null) {
    c = applyBoosts(c, params.boosts);
  }

  return {
    confidence: clamp01(c),
    trace: {
      base,
      parts,
      combined,
      ageMs: params.ageMs ?? null,
      conflicts: params.conflicts ?? null,
      penalties: params.penalties ?? null,
      boosts: params.boosts ?? null,
    },
  };
}

/**
 * Convenience: confidence from hit-rate plus optional freshness decay.
 *
 * @param {number} hits
 * @param {number} total
 * @param {{ ageMs?:number, halfLifeMs?:number, floor?:number, curve?:number }} [opts]
 * @returns {number}
 */
export function confidenceFromCoverageWithFreshness(hits, total, opts = {}) {
  const base = confidenceFromCoverage(hits, total, {
    curve: opts.curve ?? 1.0,
    floor: opts.floor ?? 0.15,
    ceiling: 0.95,
  });

  if (opts.ageMs == null) return base;

  return decayConfidenceByAge(base, opts.ageMs, {
    halfLifeMs: opts.halfLifeMs ?? 1000 * 60 * 60 * 24 * 30,
    floor: opts.floor ?? 0.15,
  });
}

/**
 * Back-compat export expected by some shims.
 *
 * Name used by shims: `evaluateConfidence(...)`
 * In SSA, this is the runtime "confidence pass" used to produce a single 0..1 score
 * plus optional trace metadata.
 *
 * Supported inputs:
 * - Number -> normalized to 0..1
 * - Object -> { base, parts, penalties, boosts, ageMs, conflicts, opts } (passed to buildConfidence)
 * - (value, policy?) -> if policy has confidence thresholds/weights, you can pass it; we remain best-effort.
 *
 * @param {any} value
 * @param {any} [policy]
 * @returns {{ confidence:number, trace?:object }}
 */
export function evaluateConfidence(value, policy) {
  // If it's already a number, just normalize and return a minimal trace.
  if (typeof value === "number") {
    const c = clamp01(value);
    return { confidence: c, trace: { base: c, policy: policy ?? null } };
  }

  // If value looks like a buildConfidence params object, use it.
  if (value && typeof value === "object") {
    // If value already contains "confidence", treat as normalized input.
    if (typeof value.confidence === "number") {
      const c = clamp01(value.confidence);
      return {
        confidence: c,
        trace: { base: c, from: "confidence-field", policy: policy ?? null },
      };
    }

    // Common alternate field names
    const base =
      value.base ??
      value.score ??
      value.conf ??
      value.value ??
      value.initial ??
      0.5;

    // Best-effort: if policy includes weights, allow passing them through opts.
    // We do NOT enforce any policy thresholds here; shims can decide gating.
    const opts = {
      ...(value.opts || {}),
      ...(policy && typeof policy === "object"
        ? { policyHint: policy.confidence || policy }
        : {}),
    };

    return buildConfidence({
      ...value,
      base: clamp01(safeNum(base, 0.5)),
      opts,
    });
  }

  // Fallback
  const c = normalizeConfidence(value, 0.5);
  return { confidence: c, trace: { base: c, policy: policy ?? null } };
}

/* ------------------------------ shim-facing guard ------------------------------ */

/**
 * Back-compat export expected by storehouseShim (and similar):
 *   import { enforceConfidence } from "@/agents/runtime/reasoner/confidence";
 *
 * This does NOT run any AI. It deterministically checks whether a confidence score
 * meets policy thresholds.
 *
 * @param {any} value - number or object accepted by evaluateConfidence()
 * @param {object} [policy] - resolved policy object (e.g., from resolvePolicy/resolvePromptPolicy)
 * @param {object} [opts]
 * @returns {{
 *   ok: boolean,
 *   level: "accept" | "warn" | "block",
 *   confidence: number,
 *   thresholds: { minAccept:number, minWarn:number, minBlock:number },
 *   reasons: Array<{ code:string, message:string, detail?:any }>,
 *   trace?: any
 * }}
 */
export function enforceConfidence(value, policy, opts = {}) {
  const p = policy && typeof policy === "object" ? policy : {};
  const pc =
    p.confidence && typeof p.confidence === "object" ? p.confidence : {};

  // Defaults match ReasonerModes BASE_DEFAULTS in your modes/map.js
  const thresholds = {
    minAccept: clamp01(safeNum(pc.minAccept ?? 0.72, 0.72)),
    minWarn: clamp01(safeNum(pc.minWarn ?? 0.55, 0.55)),
    minBlock: clamp01(safeNum(pc.minBlock ?? 0.35, 0.35)),
  };

  // Optional override knobs (rare, but useful in some shims)
  if (opts && typeof opts === "object") {
    if (opts.minAccept != null)
      thresholds.minAccept = clamp01(
        safeNum(opts.minAccept, thresholds.minAccept)
      );
    if (opts.minWarn != null)
      thresholds.minWarn = clamp01(safeNum(opts.minWarn, thresholds.minWarn));
    if (opts.minBlock != null)
      thresholds.minBlock = clamp01(
        safeNum(opts.minBlock, thresholds.minBlock)
      );
  }

  const out = evaluateConfidence(value, p);
  const c = clamp01(safeNum(out?.confidence, 0.5));

  const reasons = [];

  let level = "accept";
  let ok = true;

  // Interpret thresholds as:
  // - >= minAccept => accept (auto-apply OK)
  // - >= minWarn   => warn (require confirm / banner)
  // - >= minBlock  => warn (still warn; caller decides)
  // - <  minBlock  => block (do not auto-apply)
  if (c < thresholds.minBlock) {
    ok = false;
    level = "block";
    reasons.push({
      code: "confidence.block",
      message: `Confidence ${c.toFixed(
        3
      )} is below minBlock ${thresholds.minBlock.toFixed(3)}.`,
      detail: { confidence: c, thresholds },
    });
  } else if (c < thresholds.minWarn) {
    ok = true;
    level = "warn";
    reasons.push({
      code: "confidence.warn_low",
      message: `Confidence ${c.toFixed(
        3
      )} is below minWarn ${thresholds.minWarn.toFixed(3)} (treat as warning).`,
      detail: { confidence: c, thresholds },
    });
  } else if (c < thresholds.minAccept) {
    ok = true;
    level = "warn";
    reasons.push({
      code: "confidence.warn",
      message: `Confidence ${c.toFixed(
        3
      )} is below minAccept ${thresholds.minAccept.toFixed(
        3
      )} (require confirm).`,
      detail: { confidence: c, thresholds },
    });
  } else {
    reasons.push({
      code: "confidence.accept",
      message: `Confidence ${c.toFixed(
        3
      )} meets minAccept ${thresholds.minAccept.toFixed(3)}.`,
      detail: { confidence: c, thresholds },
    });
  }

  return {
    ok,
    level,
    confidence: c,
    thresholds,
    reasons,
    trace: out?.trace,
  };
}

/**
 * Back-compat export expected by sababShim (and potentially others):
 *   import { applyConfidenceRules } from "@/agents/runtime/reasoner/confidence";
 *
 * This is a small wrapper around enforceConfidence(). It returns the same core
 * info, but uses a name aligned to the "rules pass" pipeline in shims.
 *
 * Accepted signatures (tolerant):
 *  - applyConfidenceRules(output, policy, opts)
 *  - applyConfidenceRules({ output, policy, opts })
 *
 * @param {any} a
 * @param {any} [b]
 * @param {any} [c]
 * @returns {{
 *   ok:boolean,
 *   level:"accept"|"warn"|"block",
 *   confidence:number,
 *   thresholds: { minAccept:number, minWarn:number, minBlock:number },
 *   reasons:Array,
 *   trace?:any
 * }}
 */
export function applyConfidenceRules(a, b, c) {
  // Object form: { output, policy, opts }
  if (
    a &&
    typeof a === "object" &&
    ("output" in a || "policy" in a || "opts" in a)
  ) {
    return enforceConfidence(a.output, a.policy, a.opts || {});
  }
  // Positional: (output, policy, opts)
  return enforceConfidence(a, b, c || {});
}

/* ------------------------------ budgeting (shim back-compat) ------------------------------ */

/**
 * enforceBudgetForMode(modeId, budgetConfig, usageOrRequest, opts)
 * ------------------------------------------------------------------
 * Back-compat export expected by procurementShim:
 *   import { enforceBudgetForMode } from "@/agents/runtime/reasoner/confidence";
 *
 * This is a deterministic "budget gate" that can be used BEFORE attempting any
 * network/LLM calls. It does not depend on any runtime state.
 *
 * Inputs are intentionally tolerant:
 * - modeId: string like "local", "balanced", "deep", etc.
 * - budgetConfig: object from JSON (policies/budget.json). Shape varies; we best-effort.
 * - usageOrRequest: may include { estTokens, tokens, estMs, ms, cost, calls } etc.
 *
 * Output:
 * {
 *   ok: boolean,
 *   level: "ok" | "warn" | "block",
 *   remaining: number|null,
 *   limit: number|null,
 *   reasons: [{code,message,detail?}],
 *   meta: { modeId, metric, used, limit, remaining }
 * }
 */
export function enforceBudgetForMode(
  modeId,
  budgetConfig,
  usageOrRequest,
  opts = {}
) {
  const reasons = [];
  const mode = String(modeId || "default").toLowerCase();

  const cfg =
    budgetConfig && typeof budgetConfig === "object" ? budgetConfig : {};

  const usage =
    usageOrRequest && typeof usageOrRequest === "object" ? usageOrRequest : {};

  // Decide which metric we are budgeting on.
  // Prefer explicit opts.metric, else tokens, else ms, else calls.
  const metricHint = String(opts.metric || "").toLowerCase();
  const metric =
    metricHint ||
    (usage.estTokens != null || usage.tokens != null
      ? "tokens"
      : usage.estMs != null || usage.ms != null
      ? "ms"
      : "calls");

  // Extract "used" amount from usage
  const used =
    metric === "tokens"
      ? safeNum(usage.estTokens ?? usage.tokens ?? usage.tokenCount, 0)
      : metric === "ms"
      ? safeNum(usage.estMs ?? usage.ms ?? usage.timeMs, 0)
      : safeNum(usage.calls ?? usage.count ?? 1, 1);

  // Extract limits from config (best-effort):
  // Allow:
  // - cfg[mode].tokensPerRun / msPerRun / callsPerRun
  // - cfg.modes[mode].limits.tokens / etc.
  // - cfg.limits.tokens / etc.
  const modeCfg =
    (cfg.modes && cfg.modes[mode]) ||
    cfg[mode] ||
    cfg.mode ||
    cfg.default ||
    {};

  const limits =
    (modeCfg.limits && typeof modeCfg.limits === "object"
      ? modeCfg.limits
      : modeCfg) || {};

  const limit =
    metric === "tokens"
      ? safeNum(
          limits.tokens ??
            limits.maxTokens ??
            limits.tokensPerRun ??
            limits.perRunTokens ??
            limits.tokenLimit ??
            null,
          null
        )
      : metric === "ms"
      ? safeNum(
          limits.ms ??
            limits.maxMs ??
            limits.msPerRun ??
            limits.perRunMs ??
            limits.timeLimitMs ??
            null,
          null
        )
      : safeNum(
          limits.calls ??
            limits.maxCalls ??
            limits.callsPerRun ??
            limits.perRunCalls ??
            limits.callLimit ??
            null,
          null
        );

  // If we don't have a numeric limit, we can't block deterministically.
  if (!Number.isFinite(limit) || limit == null) {
    reasons.push({
      code: "budget.no_limit",
      message:
        "No numeric budget limit found for this mode/metric; allowing by default.",
      detail: { mode, metric },
    });
    return {
      ok: true,
      level: "ok",
      remaining: null,
      limit: null,
      reasons,
      meta: { modeId: mode, metric, used, limit: null, remaining: null },
    };
  }

  // Remaining is limit - used; negative means over.
  const remaining = limit - used;

  // Determine thresholds:
  // - block if used > limit
  // - warn if remaining <= warnThreshold (defaults 10% of limit or opts.warnAt)
  const warnAt =
    Number.isFinite(opts.warnAt) && opts.warnAt != null
      ? safeNum(opts.warnAt, 0)
      : Math.max(1, Math.floor(limit * 0.1));

  if (remaining < 0) {
    reasons.push({
      code: "budget.exceeded",
      message: `Budget exceeded for mode "${mode}" (${metric}): used ${used} > limit ${limit}.`,
      detail: { mode, metric, used, limit, remaining },
    });
    return {
      ok: false,
      level: "block",
      remaining,
      limit,
      reasons,
      meta: { modeId: mode, metric, used, limit, remaining },
    };
  }

  if (remaining <= warnAt) {
    reasons.push({
      code: "budget.near_limit",
      message: `Budget near limit for mode "${mode}" (${metric}): remaining ${remaining} (warnAt ${warnAt}).`,
      detail: { mode, metric, used, limit, remaining, warnAt },
    });
    return {
      ok: true,
      level: "warn",
      remaining,
      limit,
      reasons,
      meta: { modeId: mode, metric, used, limit, remaining, warnAt },
    };
  }

  reasons.push({
    code: "budget.ok",
    message: `Budget OK for mode "${mode}" (${metric}).`,
    detail: { mode, metric, used, limit, remaining },
  });

  return {
    ok: true,
    level: "ok",
    remaining,
    limit,
    reasons,
    meta: { modeId: mode, metric, used, limit, remaining },
  };
}

export default {
  combineConfidence,
  weightedConfidence,
  confidenceFromCoverage,
  applyPenalties,
  applyBoosts,
  decayConfidenceByAge,
  reduceConfidenceForConflicts,
  normalizeConfidence,
  buildConfidence,
  confidenceFromCoverageWithFreshness,
  evaluateConfidence,
  enforceConfidence,
  applyConfidenceRules,
  enforceBudgetForMode,
};
