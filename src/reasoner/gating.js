// src/reasoner/gating.js

/**
 * Reasoner Gating
 * -----------------------------------------------------------------------------
 * Build fix:
 *  - mealPlanningShim imports { isGated } from "@/reasoner/gating"
 *  - sababShim imports { isReasonerAllowed } from "@/reasoner/gating"
 *  - shoppingShim imports { canCallReasoner } from "@/reasoner/gating"
 *  - existing code exported canInvokeReasoner() + isGated()
 *
 * Keep behavior permissive for now (SSA can tighten later).
 */

export function canInvokeReasoner({ familyFundMode, intent, domain } = {}) {
  // Deterministic gate:
  // - allow by default
  // - optionally block in strict FamilyFund mode for “nonessential” domains later
  if (!domain) return true;
  if (!familyFundMode) return true;
  // keep permissive for now — SSA can tighten later
  return true;
}

/**
 * canCallReasoner
 * -----------------------------------------------------------------------------
 * Compatibility helper expected by shoppingShim:
 *   - returns true when the request is allowed (NOT gated)
 *
 * Alias of canInvokeReasoner to avoid hard build errors.
 */
export function canCallReasoner({ familyFundMode, intent, domain } = {}) {
  return canInvokeReasoner({ familyFundMode, intent, domain });
}

/**
 * isGated
 * -----------------------------------------------------------------------------
 * Compatibility helper expected by some shims:
 *   - returns true when the request should be blocked (i.e., gated)
 *
 * With our current permissive gate, this will almost always be false.
 */
export function isGated({ familyFundMode, intent, domain } = {}) {
  return !canInvokeReasoner({ familyFundMode, intent, domain });
}

/**
 * isReasonerAllowed
 * -----------------------------------------------------------------------------
 * Compatibility helper expected by sababShim:
 *   - returns true when the request is allowed (NOT gated)
 *
 * This is the positive form of isGated/canInvokeReasoner.
 */
export function isReasonerAllowed({ familyFundMode, intent, domain } = {}) {
  return canInvokeReasoner({ familyFundMode, intent, domain });
}
