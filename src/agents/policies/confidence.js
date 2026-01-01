/**
 * @file src/agents/policies/confidence.js
 *
 * Confidence thresholds and follow-up rules for Suka Smart Assistant (SSA).
 *
 * HOW THIS FITS:
 * - Central policy module for how SSA reacts to model/heuristic confidence:
 *   - When to auto-proceed with an action (e.g., composing a session).
 *   - When to ask user follow-up questions or confirmations.
 *   - When to downgrade scope (read-only preview instead of auto-running).
 *   - When to log / flag results for later review.
 *
 * - Intended consumers:
 *   - Any Reasoner wrapper (before committing to a plan or session).
 *   - SessionRunner “Now” resolver (deciding whether to auto-start).
 *   - Import agents (recipe/plan parsing) deciding whether to silently
 *     normalize or show a “Verify import” modal.
 *
 * MODEL:
 * - Confidence is expressed as a float in [0, 1] from the calling agent.
 * - This module classifies it into one of: high | medium | low | veryLow.
 * - It then applies domain + intent risk rules to decide how aggressive
 *   follow-up should be.
 *
 * EVENT TELEMETRY:
 * - Emits `confidence.policy.evaluated` via eventBus so you can trace
 *   how often SSA is asking follow-ups vs. auto-proceeding.
 */

import { emit } from "../../services/events/eventBus";

/**
 * @typedef {'high'|'medium'|'low'|'veryLow'} ConfidenceLabel
 */

/**
 * @typedef {'low'|'medium'|'high'|'critical'} RiskLevel
 */

/**
 * Input payload for evaluating confidence policy.
 *
 * @typedef {Object} ConfidenceInput
 * @property {number} score                 Confidence score in [0, 1]
 * @property {string} [domain]              SSA domain, e.g. 'sessions', 'imports', 'nutrition'
 * @property {string} [intent]              Intent key, e.g. 'session.compose.cooking'
 * @property {RiskLevel} [riskOverride]     Explicit risk, skips domain/intent inference if provided
 * @property {boolean} [userInitiatedNow]   True if this came from an explicit “Now” click
 */

/**
 * Output decision from confidence policy.
 *
 * @typedef {Object} ConfidenceDecision
 * @property {ConfidenceLabel} label
 * @property {RiskLevel} riskLevel
 * @property {boolean} shouldAskFollowUp       Ask a lightweight clarifying question before acting
 * @property {boolean} requireUserConfirmation Require explicit “Yes, do this” before side-effects
 * @property {boolean} allowAutoStartSession   Whether SessionRunner may auto-launch this session
 * @property {boolean} degradeScope            If true, prefer read-only preview vs. fully-automated action
 * @property {boolean} logLowConfidence        Whether to log/telemetry this as a low-confidence event
 * @property {string} reasonCode               'ok'|'lowConfidence'|'veryLowConfidence'|'unknownScore'|'error'
 * @property {string[]} warnings               Non-fatal policy issues / notes
 * @property {object} policySnapshot           The policy entry that was applied (for debugging)
 */

/* -------------------------------------------------------------------------- */
/*  Policy configuration                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Static confidence policy table.
 *
 * - `thresholds` define the global mapping from numeric scores to labels.
 * - `riskDefaults` define generic behavior for each (label, riskLevel) pair.
 * - `riskOverrides` map specific domains/intents to a risk category.
 */
export const CONFIDENCE_POLICY = {
  version: "1.0.0",
  updatedAt: "2025-11-14T00:00:00.000Z",
  thresholds: {
    high: 0.8, // score >= 0.80
    medium: 0.6, // 0.60 <= score < 0.80
    low: 0.35, // 0.35 <= score < 0.60
    // score < 0.35 → veryLow
  },
  /**
   * Default behaviors per (confidenceLabel, riskLevel).
   * These are conservative for higher risk domains like nutrition and
   * long-running sessions with safety implications (heat, chemicals, etc.).
   */
  riskDefaults: {
    low: {
      high: {
        shouldAskFollowUp: false,
        requireUserConfirmation: false,
        allowAutoStartSession: true,
        degradeScope: false,
      },
      medium: {
        shouldAskFollowUp: false,
        requireUserConfirmation: false,
        allowAutoStartSession: true,
        degradeScope: false,
      },
      low: {
        shouldAskFollowUp: true,
        requireUserConfirmation: false,
        allowAutoStartSession: true,
        degradeScope: false,
      },
      veryLow: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: false,
        degradeScope: true,
      },
    },
    medium: {
      high: {
        shouldAskFollowUp: false,
        requireUserConfirmation: false,
        allowAutoStartSession: true,
        degradeScope: false,
      },
      medium: {
        shouldAskFollowUp: true,
        requireUserConfirmation: false,
        allowAutoStartSession: true,
        degradeScope: false,
      },
      low: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: false,
        degradeScope: true,
      },
      veryLow: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: false,
        degradeScope: true,
      },
    },
    high: {
      high: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: true, // e.g., user clicked “Now”; still ask “Ready to start?”
        degradeScope: false,
      },
      medium: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: false,
        degradeScope: false,
      },
      low: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: false,
        degradeScope: true,
      },
      veryLow: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: false,
        degradeScope: true,
      },
    },
    critical: {
      high: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: false,
        degradeScope: false,
      },
      medium: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: false,
        degradeScope: true,
      },
      low: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: false,
        degradeScope: true,
      },
      veryLow: {
        shouldAskFollowUp: true,
        requireUserConfirmation: true,
        allowAutoStartSession: false,
        degradeScope: true,
      },
    },
  },
  /**
   * Domain / intent → risk overrides.
   *
   * NOTE: This can be extended at any time without changing code. If a
   * specific (domain, intent) key exists, it wins; otherwise we fall back
   * to a domain-level risk or 'medium'.
   */
  riskOverrides: {
    domains: {
      // Sessions involving heat, sharp tools, heavy lifting, or chemicals.
      sessions: "medium",
      imports: "medium",
      nutrition: "high",
      automation: "low",
    },
    intents: {
      // Cooking and preservation have food safety & burn risks.
      "session.compose.cooking": "high",
      "session.compose.preservation": "high",
      "session.compose.animals": "medium",
      "session.compose.garden": "medium",
      "session.compose.cleaning": "medium",
      "session.compose.storehouse": "low",

      // Nutrition is treated as high risk by default.
      "nutrition.scrapeAndNormalize": "high",

      // Background automation should be conservative but low risk.
      "automation.scheduler.tick": "low",
      "automation.backgroundGuardRefresh": "low",
    },
  },
  /**
   * Telemetry rule: label ≤ 'low' → always log.
   */
  logLowConfidence: true,
};

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Classify a numeric score into one of the confidence labels using the
 * current policy thresholds.
 *
 * @param {number} score Numeric confidence in [0, 1]
 * @returns {ConfidenceLabel}
 */
export function classifyConfidence(score) {
  const s = Number.isFinite(score) ? Number(score) : 0;
  const { thresholds } = CONFIDENCE_POLICY;
  if (s >= thresholds.high) return "high";
  if (s >= thresholds.medium) return "medium";
  if (s >= thresholds.low) return "low";
  return "veryLow";
}

/**
 * Determine the risk level for a given domain / intent combination.
 *
 * ORDER OF PRECEDENCE:
 *   1. explicit riskOverride in input
 *   2. intent-level override from policy
 *   3. domain-level override from policy
 *   4. 'medium' (default)
 *
 * @param {ConfidenceInput} input
 * @returns {RiskLevel}
 */
export function inferRiskLevel(input) {
  if (input && input.riskOverride) {
    return input.riskOverride;
  }

  const domain = (input.domain || "").trim();
  const intent = (input.intent || "").trim();

  const overrides = CONFIDENCE_POLICY.riskOverrides || {
    domains: {},
    intents: {},
  };

  if (intent && overrides.intents && overrides.intents[intent]) {
    return overrides.intents[intent];
  }

  if (domain && overrides.domains && overrides.domains[domain]) {
    return overrides.domains[domain];
  }

  return "medium";
}

/**
 * Evaluate confidence policy for a given score + context.
 *
 * Typical usage:
 * ```js
 * import { evaluateConfidence } from '../../agents/policies/confidence';
 *
 * const decision = evaluateConfidence({
 *   score: modelConfidence,
 *   domain: 'sessions',
 *   intent: 'session.compose.cooking',
 *   userInitiatedNow: true
 * });
 *
 * if (decision.requireUserConfirmation) {
 *   // Show “Does this look right?” modal before starting.
 * }
 * ```
 *
 * @param {ConfidenceInput} input
 * @returns {ConfidenceDecision}
 */
export function evaluateConfidence(input) {
  /** @type {ConfidenceDecision} */
  const base = {
    label: "veryLow",
    riskLevel: "medium",
    shouldAskFollowUp: true,
    requireUserConfirmation: true,
    allowAutoStartSession: false,
    degradeScope: true,
    logLowConfidence: true,
    reasonCode: "ok",
    warnings: [],
    policySnapshot: {},
  };

  const score = Number.isFinite(input.score) ? Number(input.score) : NaN;
  const hasScore = Number.isFinite(score);

  if (!hasScore) {
    const decision = {
      ...base,
      label: "veryLow",
      riskLevel: inferRiskLevel(input),
      reasonCode: "unknownScore",
      warnings: [
        "Confidence score was not a finite number; treating as veryLow.",
      ],
    };
    safeEmitConfidenceEvaluated(input, decision);
    return decision;
  }

  const label = classifyConfidence(score);
  const riskLevel = inferRiskLevel(input);

  const behavior = resolveBehaviorFor(label, riskLevel);

  let reasonCode = "ok";
  const warnings = [];

  if (label === "low") {
    reasonCode = "lowConfidence";
  } else if (label === "veryLow") {
    reasonCode = "veryLowConfidence";
  }

  // If the user explicitly clicked “Now”, we can slightly relax and allow
  // auto-start in some cases, but only when the risk is not high/critical.
  let allowAutoStartSession = behavior.allowAutoStartSession;
  if (
    input.userInitiatedNow &&
    allowAutoStartSession &&
    (riskLevel === "low" || riskLevel === "medium")
  ) {
    // Keep it true as per behavior; we don't auto-upgrade for high risk.
  } else if (riskLevel === "high" || riskLevel === "critical") {
    // For higher risk, require explicit confirmation even on "Now".
    allowAutoStartSession = false;
  }

  const decision = {
    ...base,
    label,
    riskLevel,
    shouldAskFollowUp: behavior.shouldAskFollowUp,
    requireUserConfirmation: behavior.requireUserConfirmation,
    allowAutoStartSession,
    degradeScope: behavior.degradeScope,
    logLowConfidence:
      CONFIDENCE_POLICY.logLowConfidence &&
      (label === "low" || label === "veryLow"),
    reasonCode,
    warnings,
    policySnapshot: {
      label,
      riskLevel,
      behavior,
    },
  };

  safeEmitConfidenceEvaluated(input, decision);
  return decision;
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve behavior for a (label, riskLevel) pair using CONFIDENCE_POLICY.
 *
 * @param {ConfidenceLabel} label
 * @param {RiskLevel} riskLevel
 * @returns {{
 *   shouldAskFollowUp: boolean,
 *   requireUserConfirmation: boolean,
 *   allowAutoStartSession: boolean,
 *   degradeScope: boolean
 * }}
 */
function resolveBehaviorFor(label, riskLevel) {
  const defaults = CONFIDENCE_POLICY.riskDefaults || {};
  const riskBucket = defaults[riskLevel] || defaults.medium || {};

  const behavior = riskBucket[label] ||
    // Fallback: medium risk, medium label
    (defaults.medium && defaults.medium.medium) || {
      shouldAskFollowUp: true,
      requireUserConfirmation: true,
      allowAutoStartSession: false,
      degradeScope: true,
    };

  return {
    shouldAskFollowUp: !!behavior.shouldAskFollowUp,
    requireUserConfirmation: !!behavior.requireUserConfirmation,
    allowAutoStartSession: !!behavior.allowAutoStartSession,
    degradeScope: !!behavior.degradeScope,
  };
}

/* -------------------------------------------------------------------------- */
/*  Telemetry                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Emit `confidence.policy.evaluated` for analytics and debugging.
 *
 * Payload:
 * {
 *   type: 'confidence.policy.evaluated',
 *   ts: ISO8601,
 *   source: 'agents.policies.confidence',
 *   data: {
 *     input: ConfidenceInput,
 *     decision: ConfidenceDecision
 *   }
 * }
 *
 * @param {ConfidenceInput} input
 * @param {ConfidenceDecision} decision
 */
function safeEmitConfidenceEvaluated(input, decision) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "confidence.policy.evaluated",
      ts: new Date().toISOString(),
      source: "agents.policies.confidence",
      data: {
        input,
        decision,
      },
    });
  } catch {
    // Telemetry must never break core logic.
  }
}
