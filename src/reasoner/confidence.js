// src/reasoner/confidence.js
function clamp(n, a = 0, b = 1) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

// Scores a result object in a consistent way.
export function evaluateConfidence(result = {}) {
  // If upstream supplied a confidence, respect it.
  const c = result?.confidence;
  if (typeof c === "number") return clamp(c, 0, 1);

  // Otherwise derive a small score from “signals present”.
  const hasActions =
    Array.isArray(result?.actions) && result.actions.length > 0;
  const hasRules =
    Array.isArray(result?.rulesFired) && result.rulesFired.length > 0;
  const hasMatches =
    Array.isArray(result?.matches) && result.matches.length > 0;

  const score =
    (hasActions ? 0.4 : 0) + (hasRules ? 0.35 : 0) + (hasMatches ? 0.25 : 0);

  return clamp(score, 0.05, 0.95);
}

/**
 * Back-compat export expected by agent shims.
 * checkConfidence(result) returns a clamped confidence number in [0,1].
 */
export function checkConfidence(result = {}) {
  return evaluateConfidence(result);
}

/**
 * Back-compat export expected by agent shims (gardenEstimateShim, etc.).
 *
 * applyConfidenceRules(result, ctx?)
 * - Attaches a computed confidence score if missing
 * - Emits a simple "confidence" decision bucket
 * - Returns the same object for convenient chaining
 */
export function applyConfidenceRules(result = {}, ctx = {}) {
  const out = result && typeof result === "object" ? result : {};

  const conf = evaluateConfidence(out);
  out.confidence = conf;

  // Optional: provide a coarse bucket for downstream gating/UI
  if (!out.confidenceBand) {
    out.confidenceBand =
      conf >= 0.85
        ? "high"
        : conf >= 0.6
        ? "medium"
        : conf >= 0.35
        ? "low"
        : "very_low";
  }

  // Optional: attach lightweight meta for debugging
  if (ctx && typeof ctx === "object" && ctx._debugConfidence) {
    out._confidenceMeta = {
      ts: new Date().toISOString(),
      band: out.confidenceBand,
    };
  }

  return out;
}
