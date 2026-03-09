// src/reasoner/freshness.js
// Simple deterministic freshness policy.
// Later you can expand to decay weights by age, etc.

export function applyFreshnessRules(result = {}, ctx = {}) {
  const out = { ...(result || {}) };

  // If result has timestamps, keep them; otherwise stamp
  out.ts = out.ts || ctx.ts || new Date().toISOString();

  // Placeholder: no mutation yet, just returns stable shape
  out.freshness = out.freshness || { policy: "none", applied: false };

  return out;
}
