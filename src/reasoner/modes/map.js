// src/reasoner/modes/map.js
// Resolves a “mode” to a canonical pipeline behavior.
// Keep minimal for now.

/**
 * resolveMode(mode)
 * - Normalizes a provided mode string to: "default" | "fast" | "strict"
 */
export function resolveMode(mode) {
  const m = String(mode || "default").toLowerCase();
  if (["fast", "lite"].includes(m)) return "fast";
  if (["strict", "safe"].includes(m)) return "strict";
  return "default";
}

/**
 * getModeForIntent(domain, intent, opts?)
 * -----------------------------------------------------------------------------
 * Back-compat export expected by some shims:
 *   import { getModeForIntent } from "@/reasoner/modes/map";
 *
 * Signature:
 *   (domain, intent) -> mode string
 *   (domain, intent, opts) -> mode string
 *
 * Internally forwards to selectModeForIntent(ctx).
 */
export function getModeForIntent(domain, intent, opts = {}) {
  return selectModeForIntent({
    ...(opts || {}),
    domain,
    intent,
  });
}

/**
 * selectModeForIntent(ctx)
 * -----------------------------------------------------------------------------
 * Compatibility export expected by shims (e.g. mealPlanningShim).
 *
 * Goal (SSA-friendly, deterministic):
 * - Default to "default"
 * - If the caller explicitly requests a mode, honor it (via resolveMode)
 * - Otherwise map certain intents to a mode (minimal ruleset for now)
 *
 * Notes:
 * - You can tighten this later (FamilyFund mode, confidence gating, etc.).
 */
export function selectModeForIntent(ctx = {}) {
  const {
    mode, // explicit request wins
    intent,
    domain,
    familyFundMode,
    strict, // sometimes shims pass booleans
    fast,
  } = ctx;

  // 1) Explicit request
  if (mode != null) return resolveMode(mode);

  // 2) Boolean hints (if any)
  if (strict === true) return "strict";
  if (fast === true) return "fast";

  // 3) Minimal intent mapping
  const i = String(intent || "").toLowerCase();
  const d = String(domain || "").toLowerCase();

  // In FamilyFund mode we can prefer safer behavior; keep permissive but slightly stricter.
  if (familyFundMode) {
    if (i.includes("plan") || i.includes("budget") || i.includes("export"))
      return "strict";
  }

  // Meal planning and purchasing suggestions can be slightly stricter by default.
  if (d.includes("meal") || i.includes("meal") || i.includes("plan"))
    return "strict";

  // Quick suggestion intents can be fast.
  if (i.includes("quick") || i.includes("suggest") || i.includes("idea"))
    return "fast";

  return "default";
}
