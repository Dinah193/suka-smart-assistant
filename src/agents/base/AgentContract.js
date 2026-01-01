// src/agents/base/AgentContract.js
// Wrap an agent to guarantee estimatePlan / generatePlan exist with the same signature.

export function ensureAgentContract(agent, name = "agent") {
  const missing = [];
  if (typeof agent.estimatePlan !== "function") missing.push("estimatePlan(ctx, options)");
  if (typeof agent.generatePlan !== "function") missing.push("generatePlan(ctx, options)");
  if (missing.length) {
    // Soft error: don’t crash app, but warn dev
    console.warn(`[${name}] missing contract methods: ${missing.join(", ")}`);
    // Provide graceful fallbacks
    if (!agent.estimatePlan) agent.estimatePlan = async (ctx) => ({ summary: `${name} has no estimatePlan`, suggestions: [] });
    if (!agent.generatePlan) agent.generatePlan = async (ctx) => ({ plan: [], emits: [] });
  }
  return agent;
}
