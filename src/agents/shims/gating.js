// C:\Users\larho\suka-smart-assistant\src\agents\shims\gating.js
/**
 * Shim-local gating (browser-safe)
 * -----------------------------------------------------------------------------
 * Why this exists:
 * - Shims in this folder import "./gating.js"
 * - Vite build failed because that relative file didn't exist.
 *
 * Design:
 * - Keep it deterministic and lightweight.
 * - Do NOT import Node-only modules.
 * - Do NOT depend on other agent folders (avoids path churn).
 *
 * Contract:
 *   isReasonerCallAllowed({ domain, intent, runtime, input }) -> {
 *     allowed: boolean,
 *     reason?: string,
 *     meta?: object
 *   }
 */

/**
 * @typedef {Object} GatingDecision
 * @property {boolean} allowed
 * @property {string} [reason]
 * @property {Object} [meta]
 */

/**
 * @param {Object} args
 * @param {string} [args.domain]
 * @param {string} [args.intent]
 * @param {Object} [args.runtime]
 * @param {Object} [args.input]
 * @returns {GatingDecision}
 */
export function isReasonerCallAllowed(args = {}) {
  const domain = String(args.domain || "").toLowerCase();
  const intent = String(args.intent || "").toLowerCase();
  const runtime = args.runtime || {};
  const input = args.input || {};

  // --- Hard blocks (explicit runtime switches) ------------------------------
  if (runtime?.offline === true) {
    return {
      allowed: false,
      reason: "runtime.offline",
      meta: { domain, intent },
    };
  }
  if (runtime?.noReasoner === true || runtime?.disableReasoner === true) {
    return {
      allowed: false,
      reason: "runtime.reasoner.disabled",
      meta: { domain, intent },
    };
  }
  if (runtime?.forceLocal === true || runtime?.localOnly === true) {
    return {
      allowed: false,
      reason: "runtime.forceLocal",
      meta: { domain, intent },
    };
  }

  // --- Intent-based blocks --------------------------------------------------
  // Let you define "never call reasoner" intents by naming convention
  if (
    intent.includes(".local") ||
    intent.includes(".offline") ||
    intent.includes(".dryrun")
  ) {
    return {
      allowed: false,
      reason: "intent.localOnly",
      meta: { domain, intent },
    };
  }

  // --- Privacy / PII conservative gating (optional) -------------------------
  // If you later add a redaction pipeline, you can relax this.
  // For now: if caller marks input as sensitive, block.
  if (input?.sensitive === true || runtime?.sensitive === true) {
    return {
      allowed: false,
      reason: "input.sensitive",
      meta: { domain, intent },
    };
  }

  // --- Domain allowlist (default allow) ------------------------------------
  // If you want to lock down, flip DEFAULT_ALLOW to false and add allow rules.
  const DEFAULT_ALLOW = true;

  // Example optional restrictor:
  // if (runtime?.allowedDomains && Array.isArray(runtime.allowedDomains)) {
  //   const allow = runtime.allowedDomains.map(String).map(s => s.toLowerCase());
  //   if (!allow.includes(domain)) return { allowed:false, reason:"domain.notAllowed", meta:{domain,intent} };
  // }

  if (DEFAULT_ALLOW) {
    return { allowed: true, reason: "ok", meta: { domain, intent } };
  }

  // If you ever flip DEFAULT_ALLOW:
  return { allowed: false, reason: "default.deny", meta: { domain, intent } };
}

export default {
  isReasonerCallAllowed,
};
