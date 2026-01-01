/**
 * @file src/agents/policies/gating.js
 *
 * Reasoner gating policy for Suka Smart Assistant (SSA).
 *
 * HOW THIS FITS:
 * - Central place that decides whether a *heavy* Reasoner run is allowed,
 *   should fall back to a light model, or must be blocked entirely.
 * - Uses:
 *   - static budget policy at `src/agents/policies/budget.json`,
 *   - caller-supplied “today usage” counters,
 *   - per-intent priority and caps.
 * - Emits telemetry via `eventBus` so you can trace how/when Reasoner
 *   calls are downgraded or blocked.
 *
 * TYPICAL USAGE (inside an agent wrapper):
 * ```js
 * import { gateReasoner } from '../../agents/policies/gating';
 *
 * const gate = gateReasoner({
 *   domain: 'sessions',
 *   intent: 'session.compose.cooking',
 *   estimatedTokens: 4500,
 *   estimatedTimeMs: 8000,
 *   todayTokenUsage: todayTokensForThisIntent,
 *   todayTimeUsageMs: todayTimeForThisIntent,
 *   forceLightModel: featureFlags.lowPowerMode
 * });
 *
 * if (gate.mode === 'blocked') {
 *   // Short-circuit; return a friendly “busy / try again later” response.
 * }
 *
 * if (gate.mode === 'light') {
 *   // Call lightweight model / heuristic instead of Reasoner.
 * } else {
 *   // Call full Reasoner.
 * }
 * ```
 */

import { emit } from "../../services/events/eventBus";
import budgetPolicy from "./budget.json";

/**
 * @typedef {'reasoner'|'light'|'blocked'} GateMode
 */

/**
 * @typedef {Object} ReasonerGateInput
 * @property {string} domain                    One of the SSA domains, e.g. 'sessions', 'imports'
 * @property {string} intent                    Policy intent key, e.g. 'session.compose.cooking'
 * @property {number} [estimatedTokens]         Approximate tokens this run is expected to use
 * @property {number} [estimatedTimeMs]         Approximate wall-clock time this run is expected to use
 * @property {number} [todayTokenUsage]         Tokens already spent today for this intent
 * @property {number} [todayTimeUsageMs]        Time already spent today for this intent
 * @property {boolean} [forceLightModel]        If true, always downgrade to light model (unless blocked)
 * @property {boolean} [forceAllow]             If true, allow Reasoner even if soft caps exceeded (NOT hard caps)
 * @property {boolean} [disableReasoner]        If true, never use Reasoner (always 'light' or 'blocked')
 */

/**
 * @typedef {Object} ReasonerGateDecision
 * @property {GateMode} mode                    'reasoner' | 'light' | 'blocked'
 * @property {string} reasonCode                'ok'|'forcedLight'|'disabled'|'overSoftCap'|'overHardCap'|'domainCapExceeded'|'intentCapExceeded'|'noPolicy'|'error'
 * @property {string[]} warnings                Non-fatal policy / input issues
 * @property {number} effectiveSoftTokenCap     Effective soft token cap for this run
 * @property {number} effectiveHardTokenCap     Effective hard token cap for this run
 * @property {number} effectiveSoftTimeCapMs    Effective soft time cap for this run
 * @property {number} effectiveHardTimeCapMs    Effective hard time cap for this run
 * @property {number|null} remainingDailyTokens Remaining daily tokens for this intent (if known)
 * @property {number|null} remainingDailyTimeMs Remaining daily time for this intent (if known)
 * @property {object} policySnapshot            The slice of budget policy that was applied
 */

/**
 * Global constant: maximum share of an intent's *daily* token budget
 * that Reasoner is allowed to consume. Above this, we downgrade to light.
 * Value in [0, 1].
 * @type {number}
 */
const MAX_REASONER_DAILY_SHARE = 0.7;

/**
 * Gate a Reasoner call based on the budget policy and current usage.
 *
 * This is a *pure* function: it does not mutate counters. The caller is
 * responsible for tracking `todayTokenUsage` and `todayTimeUsageMs`.
 *
 * @param {ReasonerGateInput} input
 * @returns {ReasonerGateDecision}
 */
export function gateReasoner(input) {
  /** @type {ReasonerGateDecision} */
  const baseDecision = {
    mode: "reasoner",
    reasonCode: "ok",
    warnings: [],
    effectiveSoftTokenCap: 0,
    effectiveHardTokenCap: 0,
    effectiveSoftTimeCapMs: 0,
    effectiveHardTimeCapMs: 0,
    remainingDailyTokens: null,
    remainingDailyTimeMs: null,
    policySnapshot: {},
  };

  const safeInput = sanitizeInput(input);

  try {
    const { domain, intent } = safeInput;

    const { defaults, domainPolicy, intentPolicy } = resolvePolicy(
      domain,
      intent
    );

    if (!defaults && !domainPolicy && !intentPolicy) {
      const decision = {
        ...baseDecision,
        mode: "light",
        reasonCode: "noPolicy",
        warnings: [
          `No budget policy found for domain='${domain}', intent='${intent}'. Falling back to light model.`,
        ],
        policySnapshot: {},
      };
      safeEmitGatingEvaluated(safeInput, decision);
      return decision;
    }

    const eff = computeEffectiveCaps(defaults, intentPolicy);
    const dailyEff = computeDailyCaps(defaults, domainPolicy, intentPolicy);

    let decision = {
      ...baseDecision,
      ...eff,
      remainingDailyTokens: dailyEff.remainingTokens,
      remainingDailyTimeMs: dailyEff.remainingTimeMs,
      policySnapshot: {
        defaults,
        domainPolicy,
        intentPolicy,
      },
    };

    // 1) Hard disable flags
    if (safeInput.disableReasoner) {
      decision.mode = "light";
      decision.reasonCode = "disabled";
      decision.warnings.push(
        "Reasoner explicitly disabled via input.disableReasoner."
      );
      safeEmitGatingEvaluated(safeInput, decision);
      return decision;
    }

    // 2) Hard caps: NEVER exceed these – block if we would.
    const projectedTokens =
      (safeInput.todayTokenUsage ?? 0) + (safeInput.estimatedTokens ?? 0);
    const projectedTime =
      (safeInput.todayTimeUsageMs ?? 0) + (safeInput.estimatedTimeMs ?? 0);

    if (
      dailyEff.intentDailyCapTokens != null &&
      projectedTokens > dailyEff.intentDailyCapTokens
    ) {
      decision.mode = "blocked";
      decision.reasonCode = "intentCapExceeded";
      decision.warnings.push(
        `Intent-level daily token cap exceeded: projected ${projectedTokens} > ${dailyEff.intentDailyCapTokens}.`
      );
      safeEmitGatingEvaluated(safeInput, decision);
      return decision;
    }

    if (
      dailyEff.domainDailyCapTokens != null &&
      projectedTokens > dailyEff.domainDailyCapTokens
    ) {
      decision.mode = "blocked";
      decision.reasonCode = "domainCapExceeded";
      decision.warnings.push(
        `Domain-level daily token cap exceeded: projected ${projectedTokens} > ${dailyEff.domainDailyCapTokens}.`
      );
      safeEmitGatingEvaluated(safeInput, decision);
      return decision;
    }

    if (
      eff.hardTokenCap &&
      safeInput.estimatedTokens &&
      safeInput.estimatedTokens > eff.hardTokenCap
    ) {
      decision.mode = "blocked";
      decision.reasonCode = "overHardCap";
      decision.warnings.push(
        `Estimated tokens (${safeInput.estimatedTokens}) exceed hardTokenCap (${eff.hardTokenCap}).`
      );
      safeEmitGatingEvaluated(safeInput, decision);
      return decision;
    }

    if (
      eff.hardTimeCapMs &&
      safeInput.estimatedTimeMs &&
      safeInput.estimatedTimeMs > eff.hardTimeCapMs
    ) {
      decision.mode = "blocked";
      decision.reasonCode = "overHardCap";
      decision.warnings.push(
        `Estimated time (${safeInput.estimatedTimeMs}ms) exceeds hardTimeCapMs (${eff.hardTimeCapMs}ms).`
      );
      safeEmitGatingEvaluated(safeInput, decision);
      return decision;
    }

    // 3) Soft caps & share limits – may downgrade to light model.
    let downgradeToLight = false;
    let softReason = "";

    // If caller demands light-only, honor it (unless we would block anyway).
    if (safeInput.forceLightModel) {
      downgradeToLight = true;
      softReason = "forcedLight";
      decision.warnings.push(
        "forceLightModel=true; Reasoner downgraded to light model."
      );
    }

    // Soft caps
    if (!safeInput.forceAllow) {
      if (
        eff.softTokenCap &&
        safeInput.estimatedTokens &&
        safeInput.estimatedTokens > eff.softTokenCap
      ) {
        downgradeToLight = true;
        softReason = "overSoftCap";
        decision.warnings.push(
          `Estimated tokens (${safeInput.estimatedTokens}) exceed softTokenCap (${eff.softTokenCap}); downgrading.`
        );
      }

      if (
        eff.softTimeCapMs &&
        safeInput.estimatedTimeMs &&
        safeInput.estimatedTimeMs > eff.softTimeCapMs
      ) {
        downgradeToLight = true;
        softReason = "overSoftCap";
        decision.warnings.push(
          `Estimated time (${safeInput.estimatedTimeMs}ms) exceeds softTimeCapMs (${eff.softTimeCapMs}ms); downgrading.`
        );
      }
    }

    // Daily share: limit Reasoner to <= MAX_REASONER_DAILY_SHARE of intent daily token cap.
    if (
      !safeInput.forceAllow &&
      dailyEff.intentDailyCapTokens != null &&
      safeInput.estimatedTokens
    ) {
      const projectedShare = projectedTokens / dailyEff.intentDailyCapTokens;
      if (projectedShare > MAX_REASONER_DAILY_SHARE) {
        downgradeToLight = true;
        softReason = softReason || "intentCapExceeded";
        decision.warnings.push(
          `Projected Reasoner usage would exceed ${Math.round(
            MAX_REASONER_DAILY_SHARE * 100
          )}% of intent daily token cap; downgrading to light model.`
        );
      }
    }

    if (downgradeToLight) {
      decision.mode = "light";
      decision.reasonCode = softReason || "overSoftCap";
    } else {
      decision.mode = "reasoner";
      decision.reasonCode = "ok";
    }

    safeEmitGatingEvaluated(safeInput, decision);
    return decision;
  } catch (err) {
    const decision = {
      ...baseDecision,
      mode: "light",
      reasonCode: "error",
      warnings: [`Error while applying gating policy: ${String(err)}`],
      policySnapshot: {},
    };
    safeEmitGatingEvaluated(safeInput, decision);
    return decision;
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Sanitize raw input and apply safe fallbacks.
 *
 * @param {ReasonerGateInput} input
 * @returns {ReasonerGateInput}
 */
function sanitizeInput(input) {
  const safe =
    input ||
    /** @type {ReasonerGateInput} */ ({
      domain: "sessions",
      intent: "session.compose.generic",
    });

  const domain =
    typeof safe.domain === "string" && safe.domain.trim()
      ? safe.domain.trim()
      : "sessions";

  const intent =
    typeof safe.intent === "string" && safe.intent.trim()
      ? safe.intent.trim()
      : "session.compose.generic";

  return {
    domain,
    intent,
    estimatedTokens: Number.isFinite(safe.estimatedTokens)
      ? Number(safe.estimatedTokens)
      : undefined,
    estimatedTimeMs: Number.isFinite(safe.estimatedTimeMs)
      ? Number(safe.estimatedTimeMs)
      : undefined,
    todayTokenUsage: Number.isFinite(safe.todayTokenUsage)
      ? Number(safe.todayTokenUsage)
      : 0,
    todayTimeUsageMs: Number.isFinite(safe.todayTimeUsageMs)
      ? Number(safe.todayTimeUsageMs)
      : 0,
    forceLightModel: !!safe.forceLightModel,
    forceAllow: !!safe.forceAllow,
    disableReasoner: !!safe.disableReasoner,
  };
}

/**
 * Resolve the relevant policy for the given domain and intent from
 * `budget.json`.
 *
 * @param {string} domain
 * @param {string} intent
 * @returns {{ defaults: any, domainPolicy: any, intentPolicy: any }}
 */
function resolvePolicy(domain, intent) {
  if (!budgetPolicy || typeof budgetPolicy !== "object") {
    return { defaults: null, domainPolicy: null, intentPolicy: null };
  }

  const defaults = budgetPolicy.defaults || null;
  const domainPolicy =
    budgetPolicy.domains && budgetPolicy.domains[domain]
      ? budgetPolicy.domains[domain]
      : null;
  const intentPolicy =
    budgetPolicy.intents && budgetPolicy.intents[intent]
      ? budgetPolicy.intents[intent]
      : null;

  return { defaults, domainPolicy, intentPolicy };
}

/**
 * Compute effective per-run caps, giving precedence to per-intent settings
 * then falling back to `defaults`.
 *
 * @param {any} defaults
 * @param {any} intentPolicy
 * @returns {{
 *   softTokenCap: number|null,
 *   hardTokenCap: number|null,
 *   softTimeCapMs: number|null,
 *   hardTimeCapMs: number|null
 * }}
 */
function computeEffectiveCaps(defaults, intentPolicy) {
  const d = defaults || {};
  const i = intentPolicy || {};

  const softTokenCap = pickFirstNumber(i.softTokenCap, d.softTokenCap);
  const hardTokenCap = pickFirstNumber(i.hardTokenCap, d.hardTokenCap);
  const softTimeCapMs = pickFirstNumber(i.softTimeCapMs, d.softTimeCapMs);
  const hardTimeCapMs = pickFirstNumber(i.hardTimeCapMs, d.hardTimeCapMs);

  return {
    softTokenCap,
    hardTokenCap,
    softTimeCapMs,
    hardTimeCapMs,
  };
}

/**
 * Compute effective daily caps and remaining budgets for a domain+intent
 * combo. This function does *not* know the global “totalTokenCap”; it only
 * uses the per-domain and per-intent values from budget.json.
 *
 * @param {any} defaults
 * @param {any} domainPolicy
 * @param {any} intentPolicy
 * @returns {{
 *   intentDailyCapTokens: number|null,
 *   intentDailyCapTimeMs: number|null,
 *   domainDailyCapTokens: number|null,
 *   domainDailyCapTimeMs: number|null,
 *   remainingTokens: number|null,
 *   remainingTimeMs: number|null
 * }}
 */
function computeDailyCaps(defaults, domainPolicy, intentPolicy) {
  const d = defaults || {};
  const dom = domainPolicy || {};
  const i = intentPolicy || {};

  const intentDailyCapTokens = pickFirstNumber(
    i.dailyTokenCap,
    d.daily && d.daily.totalTokenCap // fallback to global if no intent-specific cap
  );
  const intentDailyCapTimeMs = pickFirstNumber(
    i.dailyTimeCapMs,
    d.daily && d.daily.totalTimeCapMs
  );

  const domainDailyCapTokens = pickFirstNumber(dom.dailyTokenCap, null);
  const domainDailyCapTimeMs = pickFirstNumber(dom.dailyTimeCapMs, null);

  // NOTE: Remaining budgets require the caller to subtract usage. We'll just
  // return null here as we don't know actual usage; if you have usage
  // counters, you can compute remaining budgets before calling gateReasoner
  // and pass them in via separate interfaces if desired.
  return {
    intentDailyCapTokens,
    intentDailyCapTimeMs,
    domainDailyCapTokens,
    domainDailyCapTimeMs,
    remainingTokens: null,
    remainingTimeMs: null,
  };
}

/**
 * Pick the first numeric value from the given arguments, or null if none.
 *
 * @param  {...any} candidates
 * @returns {number|null}
 */
function pickFirstNumber(...candidates) {
  for (const c of candidates) {
    if (Number.isFinite(c)) return Number(c);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Telemetry                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Emit a `reasoner.gating.evaluated` event so other parts of SSA can
 * observe how often we downgrade or block Reasoner calls.
 *
 * Payload:
 * {
 *   type: 'reasoner.gating.evaluated',
 *   ts: ISO8601,
 *   source: 'agents.policies.gating',
 *   data: {
 *     input: ReasonerGateInput,
 *     decision: ReasonerGateDecision
 *   }
 * }
 *
 * @param {ReasonerGateInput} input
 * @param {ReasonerGateDecision} decision
 */
function safeEmitGatingEvaluated(input, decision) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "reasoner.gating.evaluated",
      ts: new Date().toISOString(),
      source: "agents.policies.gating",
      data: {
        input,
        decision,
      },
    });
  } catch {
    // Telemetry must never break gating.
  }
}
