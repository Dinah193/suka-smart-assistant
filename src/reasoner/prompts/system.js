// src/reasoner/prompts/system.js
// Even if you later use an LLM, keep a deterministic system prompt builder.
// For now, it’s just a string used by logs/audits.

export function getSystemPrompt() {
  return [
    "SSA Reasoner System",
    "- Deterministic rules-first pipeline",
    "- No hallucinated instructions",
    "- Output must be machine-actionable",
  ].join("\n");
}

/**
 * Back-compat export expected by agent shims (e.g., mealPlanningShim).
 * Keep getSystemPrompt() as the canonical implementation.
 */
export function buildSystemPrompt(ctx = {}) {
  // ctx is accepted for future expansion, but we keep output deterministic for now.
  // If you later add ctx-sensitive lines, keep them stable and bounded.
  void ctx;
  return getSystemPrompt();
}
