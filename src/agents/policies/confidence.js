// C:\Users\larho\suka-smart-assistant\src\agents\policies\confidence.js
// -----------------------------------------------------------------------------
// PURPOSE (Browser-safe confidence policy)
// -----------------------------------------------------------------------------
// Ensures reasoned outputs meet minimum confidence requirements before SSA
// acts on them (compose sessions, swaps, "now" resolver, etc.).
//
// BUILD FIX:
// ✅ Export `ensureConfidence` (HouseholdOrchestrator imports it)
// ✅ No Node imports.
// ✅ Conservative defaults, never throws unless requested.
// -----------------------------------------------------------------------------

/* -------------------------------------------------------------------------- */
/*  Types (JSDoc)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {'low'|'medium'|'high'|'critical'} RiskLevel
 */

/**
 * @typedef {'veryLow'|'low'|'medium'|'high'|''} ConfidenceLabel
 */

/**
 * @typedef {Object} ConfidencePolicy
 * @property {RiskLevel} [riskLevel]                 // how risky the action is
 * @property {ConfidenceLabel} [minConfidence]       // minimum allowed confidence label
 * @property {number} [minScore]                     // optional numeric threshold 0..1
 * @property {boolean} [blockOnUnknown]              // if true, unknown confidence blocks
 * @property {boolean} [throwOnBlock]                // if true, throw when blocked
 * @property {string} [scope]                        // for logging/debug
 */

/**
 * @typedef {Object} ConfidenceDecision
 * @property {boolean} ok
 * @property {string} reason
 * @property {RiskLevel} riskLevel
 * @property {ConfidenceLabel} minConfidence
 * @property {ConfidenceLabel} observedLabel
 * @property {number|null} observedScore
 */

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Ensure an output meets confidence thresholds.
 *
 * Accepts "result" objects in flexible forms:
 * - { confidence: { label: 'high', score: 0.82 } }
 * - { confidenceLabel: 'medium', confidenceScore: 0.6 }
 * - { meta: { confidenceLabel, confidenceScore } }
 *
 * Returns a decision; optionally throws if policy.throwOnBlock === true.
 *
 * @param {any} result
 * @param {ConfidencePolicy} [policy]
 * @returns {ConfidenceDecision}
 */
export function ensureConfidence(result, policy = {}) {
  const riskLevel = normalizeRiskLevel(policy.riskLevel || "medium");
  const minConfidence = normalizeConfidenceLabel(
    policy.minConfidence || defaultMinConfidenceForRisk(riskLevel)
  );

  const minScore =
    Number.isFinite(policy.minScore) && Number(policy.minScore) >= 0
      ? Math.min(1, Math.max(0, Number(policy.minScore)))
      : null;

  const blockOnUnknown = !!policy.blockOnUnknown;

  const observed = extractConfidence(result);
  const observedLabel = normalizeConfidenceLabel(observed.label || "");
  const observedScore =
    Number.isFinite(observed.score) && observed.score >= 0
      ? Math.min(1, Math.max(0, Number(observed.score)))
      : null;

  // Unknown handling
  if (!observedLabel && observedScore == null) {
    const decision = {
      ok: !blockOnUnknown,
      reason: blockOnUnknown
        ? "confidence-unknown-blocked"
        : "confidence-unknown-allowed",
      riskLevel,
      minConfidence,
      observedLabel: "",
      observedScore: null,
    };
    if (!decision.ok && policy.throwOnBlock) throw new Error(decision.reason);
    return decision;
  }

  // Label check (if present)
  const labelOk = observedLabel
    ? compareConfidenceLabels(observedLabel, minConfidence) >= 0
    : true;

  // Score check (if required)
  const scoreOk =
    minScore == null
      ? true
      : observedScore != null
      ? observedScore >= minScore
      : !blockOnUnknown;

  const ok = !!labelOk && !!scoreOk;

  let reason = "confidence-ok";
  if (!labelOk) reason = "confidence-label-too-low";
  else if (!scoreOk) reason = "confidence-score-too-low";

  const decision = {
    ok,
    reason,
    riskLevel,
    minConfidence,
    observedLabel,
    observedScore,
  };

  if (!ok && policy.throwOnBlock) throw new Error(reason);
  return decision;
}

/**
 * Helper to build a policy object from risk level (optional convenience).
 * @param {RiskLevel} riskLevel
 * @returns {ConfidencePolicy}
 */
export function policyForRisk(riskLevel) {
  const rl = normalizeRiskLevel(riskLevel);
  return {
    riskLevel: rl,
    minConfidence: defaultMinConfidenceForRisk(rl),
    blockOnUnknown: rl === "high" || rl === "critical",
  };
}

export default {
  ensureConfidence,
  policyForRisk,
};

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

function extractConfidence(result) {
  try {
    const c = result?.confidence;
    if (c && typeof c === "object") {
      return {
        label: c.label || c.confidenceLabel || "",
        score: c.score ?? c.confidenceScore,
      };
    }
    if (result && typeof result === "object") {
      if ("confidenceLabel" in result || "confidenceScore" in result) {
        return {
          label: result.confidenceLabel || "",
          score: result.confidenceScore,
        };
      }
      const m = result.meta;
      if (m && typeof m === "object") {
        return { label: m.confidenceLabel || "", score: m.confidenceScore };
      }
    }
  } catch {
    // ignore
  }
  return { label: "", score: null };
}

function normalizeRiskLevel(v) {
  const s = String(v || "").toLowerCase();
  if (s === "low" || s === "medium" || s === "high" || s === "critical")
    return s;
  return "medium";
}

function normalizeConfidenceLabel(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const t = s.toLowerCase();
  if (t === "verylow") return "veryLow";
  if (t === "low") return "low";
  if (t === "medium") return "medium";
  if (t === "high") return "high";
  return "";
}

function defaultMinConfidenceForRisk(riskLevel) {
  switch (riskLevel) {
    case "critical":
      return "high";
    case "high":
      return "medium";
    case "low":
      return "low";
    case "medium":
    default:
      return "low";
  }
}

/**
 * Compare labels. Returns:
 *  -1 if a < b, 0 if equal, +1 if a > b
 */
function compareConfidenceLabels(a, b) {
  const rank = { veryLow: 0, low: 1, medium: 2, high: 3 };
  const ra = rank[normalizeConfidenceLabel(a)] ?? -1;
  const rb = rank[normalizeConfidenceLabel(b)] ?? -1;
  if (ra < rb) return -1;
  if (ra > rb) return 1;
  return 0;
}
