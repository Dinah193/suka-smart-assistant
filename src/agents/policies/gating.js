// C:\Users\larho\suka-smart-assistant\src\agents\policies\gating.js
/**
 * @file src/agents/policies/gating.js
 *
 * LLM / Reasoner gating policy for SSA (browser-safe).
 *
 * Build constraint:
 * - NEVER import named exports like { allowLLM, debugAgents } from featureFlags.
 * - featureFlags is treated as a module that may expose snapshot functions,
 *   OR a default object, OR loose properties.
 */

import * as featureFlagsModule from "@/config/featureFlags";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} GatingContext
 * @property {string} [role]           // "admin" | "tester" | "user" | etc.
 * @property {string} [tier]           // "hub" | "ssa-only" | etc.
 * @property {string} [deviceProfile]  // "kiosk-demo" | "desktop" | etc.
 * @property {boolean} [forceAllow]    // hard override (testing)
 * @property {boolean} [forceDeny]     // hard override (safety)
 */

/**
 * @typedef {Object} GatingDecision
 * @property {boolean} allowed
 * @property {string} reason
 * @property {Record<string, any>} flags
 */

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Determine whether the Reasoner/LLM is allowed right now.
 *
 * Priority:
 * 1) forceDeny => deny
 * 2) forceAllow => allow
 * 3) kiosk-demo => deny (unless forced allow)
 * 4) flags.allowLLM => allow
 * 5) privileged role AND flags.debugAgents => allow
 * else deny
 *
 * @param {GatingContext} [context]
 * @returns {Promise<GatingDecision>}
 */
export async function isReasonerAllowed(context = {}) {
  const flags = await safeGetFeatureFlagsSnapshot();

  if (context?.forceDeny)
    return { allowed: false, reason: "forced-deny", flags };
  if (context?.forceAllow)
    return { allowed: true, reason: "forced-allow", flags };

  if (String(context?.deviceProfile || "").toLowerCase() === "kiosk-demo") {
    return { allowed: false, reason: "deviceProfile-kiosk-demo", flags };
  }

  const allowLLM = !!flags.allowLLM;
  const debugAgents = !!flags.debugAgents;

  const role = String(context?.role || "").toLowerCase();
  const isPrivileged = role === "admin" || role === "tester";

  if (allowLLM) return { allowed: true, reason: "flag-allowLLM", flags };
  if (isPrivileged && debugAgents) {
    return { allowed: true, reason: "privileged-debugAgents", flags };
  }

  return { allowed: false, reason: "flag-disallows-llm", flags };
}

/**
 * Sync convenience (best-effort).
 * Defaults to deny if flags can't be resolved.
 *
 * @param {GatingContext} [context]
 * @returns {GatingDecision}
 */
export function isReasonerAllowedSync(context = {}) {
  const flags = safeGetFeatureFlagsSnapshotSync();

  if (context?.forceDeny)
    return { allowed: false, reason: "forced-deny", flags };
  if (context?.forceAllow)
    return { allowed: true, reason: "forced-allow", flags };

  if (String(context?.deviceProfile || "").toLowerCase() === "kiosk-demo") {
    return { allowed: false, reason: "deviceProfile-kiosk-demo", flags };
  }

  const allowLLM = !!flags.allowLLM;
  const debugAgents = !!flags.debugAgents;

  const role = String(context?.role || "").toLowerCase();
  const isPrivileged = role === "admin" || role === "tester";

  if (allowLLM) return { allowed: true, reason: "flag-allowLLM", flags };
  if (isPrivileged && debugAgents) {
    return { allowed: true, reason: "privileged-debugAgents", flags };
  }

  return { allowed: false, reason: "flag-disallows-llm", flags };
}

export default {
  isReasonerAllowed,
  isReasonerAllowedSync,
};

/* -------------------------------------------------------------------------- */
/*  Feature flags snapshot helpers                                            */
/* -------------------------------------------------------------------------- */

async function safeGetFeatureFlagsSnapshot() {
  try {
    if (typeof featureFlagsModule?.snapshotFlags === "function") {
      return await featureFlagsModule.snapshotFlags();
    }
    if (typeof featureFlagsModule?.getAllFeatureFlags === "function") {
      return await featureFlagsModule.getAllFeatureFlags();
    }
    if (typeof featureFlagsModule?.getFeatureFlags === "function") {
      return await featureFlagsModule.getFeatureFlags();
    }
    if (
      featureFlagsModule?.default &&
      typeof featureFlagsModule.default === "object"
    ) {
      return featureFlagsModule.default;
    }

    /** @type {Record<string, any>} */
    const fallback = {};
    if ("familyFundMode" in featureFlagsModule)
      fallback.familyFundMode = !!featureFlagsModule.familyFundMode;
    if ("allowLLM" in featureFlagsModule)
      fallback.allowLLM = !!featureFlagsModule.allowLLM;
    if ("debugAgents" in featureFlagsModule)
      fallback.debugAgents = !!featureFlagsModule.debugAgents;
    return fallback;
  } catch {
    return {};
  }
}

function safeGetFeatureFlagsSnapshotSync() {
  try {
    if (
      featureFlagsModule?.default &&
      typeof featureFlagsModule.default === "object"
    ) {
      return featureFlagsModule.default;
    }

    /** @type {Record<string, any>} */
    const fallback = {};
    if ("familyFundMode" in featureFlagsModule)
      fallback.familyFundMode = !!featureFlagsModule.familyFundMode;
    if ("allowLLM" in featureFlagsModule)
      fallback.allowLLM = !!featureFlagsModule.allowLLM;
    if ("debugAgents" in featureFlagsModule)
      fallback.debugAgents = !!featureFlagsModule.debugAgents;
    return fallback;
  } catch {
    return {};
  }
}
