/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\agents\shims\sausageShim.js

/**
 * Sausage Shim — Torah-Aligned Batch & Forcemeat Planner (SSA Reasoner Shim)
 * -----------------------------------------------------------------------------
 * This shim replaces the old sausageAgent. It:
 *  - Enforces SSA runtime rules (budget, gating, freshness, confidence, memo).
 *  - Calls the Reasoner in sausage-specific modes (planBatch, simulate, commit, undo, listTemplates).
 *  - Focuses on Torah-aligned meats by default; shellfish & hog casings are opt-in via profile.
 *  - Expects the Reasoner to:
 *      • Apply Torah Integrity Policy (TIP) to species & casings.
 *      • Respect Sabbath / appointed times in the schedule at the planning level.
 *      • Produce structured JSON for batch plans, simulations, template lists, etc.
 *  - Produces normalized JSON for automation (no UI, no DOM, no direct inventory/calendar writes).
 *
 * Supported intents (examples):
 *  - "sausage.planBatch"     → draft sausage batch plan with schedule.
 *  - "sausage.simulate"      → inventory & timing simulation (commit packet).
 *  - "sausage.commit"        → commit summary + undo packet (no side-effects here).
 *  - "sausage.undo"          → undo summary (no side-effects here).
 *  - "sausage.listTemplates" → starter sausage recipes/templates.
 *
 * All flows return a ShimResponse:
 *  {
 *    ok: boolean,
 *    mode: string,
 *    data: {...normalized sausage data...},
 *    warnings?: Array<Object>,
 *    debug?: Array<Object>
 *  }
 */

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} intent
 * @property {Object} input
 * @property {Object} [runtime]
 */

/**
 * @typedef {Object} ShimResponse
 * @property {boolean} ok
 * @property {string} mode
 * @property {Object} data
 * @property {Array<Object>} [warnings]
 * @property {Array<Object>} [debug]
 */

// -----------------------------------------------------------------------------
// Imports — SSA Runtime + Event Bus + Hub
// (Adjust paths to match your project aliases as needed.)
// -----------------------------------------------------------------------------

import { emit as emitEvent } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

import { HubPacketFormatter } from "@/services/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/FamilyFundConnector";

// Runtime enforcement & helpers
import { checkBudget } from "@/agents/runtime/budget";
import { isReasonerAllowed } from "@/agents/runtime/gating";
import { applyConfidenceRules } from "@/agents/runtime/confidence";
import { applyFreshnessRules } from "@/agents/runtime/freshness";

// Context selectors (Dexie-backed)
import {
  getHouseholdContextForSausage,
  getTorahDietaryProfile,
  getSabbathWindows,
} from "@/agents/runtime/selectors";

// Cache layer
import {
  getMemoized,
  setMemoized,
} from "@/agents/runtime/cache/memo";
import {
  makeSausageCacheKey,
} from "@/agents/runtime/cache/keys";

// Mode mapping + Reasoner + schema validator
import {
  resolveSausageMode, // (req: ShimRequest) => { mode: string, schemaId: string }
} from "@/agents/shims/sausage/modes/map";

import {
  callReasoner,
} from "@/agents/runtime/reasonerDriver";

import {
  validateModeOutput,
} from "@/agents/runtime/schemaValidator";

// Optional: session composition & guard evaluation if you later want
// sausage planning to produce runnable sessions for SessionRunner.
// For now, kept commented as this shim is Reasoner-only.
/*
import {
  composeSausageSession,
} from "@/skills/sessions/compose";

import {
  evaluateGuardsForSession,
} from "@/skills/sessions/guardsEvaluate";

import {
  saveSessionCheckpoint,
} from "@/services/db/sessions";
*/

// -----------------------------------------------------------------------------
// Constants & small utilities
// -----------------------------------------------------------------------------

const SHIM_SOURCE = "agents/shims/sausage";

const nowISO = () => new Date().toISOString();

/**
 * Build a basic ShimResponse object.
 * @param {Object} params
 * @param {boolean} params.ok
 * @param {string} params.mode
 * @param {Object} params.data
 * @param {Array<Object>} [params.warnings]
 * @param {Array<Object>} [params.debug]
 * @returns {ShimResponse}
 */
function buildShimResponse({ ok, mode, data, warnings = [], debug = [] }) {
  return {
    ok,
    mode,
    data,
    warnings,
    debug,
  };
}

/**
 * Emit a reasoner-related event via eventBus.
 * @param {string} type
 * @param {Object} data
 */
function emitReasonerEvent(type, data) {
  try {
    emitEvent({
      type,
      ts: nowISO(),
      source: SHIM_SOURCE,
      data,
    });
  } catch (err) {
    // Never crash shim if event bus fails
    console.warn("[sausageShim] event emit failed:", err?.message || err);
  }
}

// -----------------------------------------------------------------------------
// Prompt Builder — Torah-aligned sausage / forcemeat aware
// -----------------------------------------------------------------------------

/**
 * Build Reasoner prompts + payload for a given mode.
 * This is where we encode the Torah Integrity Policy expectations
 * and the high-level sausage planning behavior.
 *
 * @param {ShimRequest} req
 * @param {string} mode
 * @param {Object} context
 * @returns {{ systemPrompt: string, userPrompt: string, payload: Object }}
 */
function buildPromptForMode(req, mode, context) {
  const { intent, input } = req;

  const torahProfile =
    context?.torahProfile ||
    context?.torahDietaryProfile ||
    {};
  const household = context?.household || {};
  const sabbathWindows = context?.sabbathWindows || [];
  const timezone = household.timezone || "America/New_York";

  // System prompt: Sausage planner with TIP + Sabbath guard expectations
  const systemPrompt =
    (context?.modeConfig && context.modeConfig.prompts && context.modeConfig.prompts.system) ||
    [
      "You are the Sausage & Forcemeat Planner for an African American Israelite household.",
      "Apply the household Torah Integrity Policy (TIP) and scheduling safeguards as follows:",
      "",
      "Torah Integrity Policy (TIP) expectations:",
      "- Land species: allow beef, lamb, goat, venison, turkey, chicken, duck by default.",
      "- Block pork, boar, rabbit, horse, camel and other non-permitted land species unless the profile explicitly overrides.",
      "- Fish: only fish with fins and scales should be permitted by default.",
      "- Shellfish (shrimp, crab, lobster, etc.):",
      "  * Default OFF — do not schedule or suggest shellfish forcemeats.",
      "  * If household.shellfishAllowed === true in the torahProfile, then you may allow shellfish sausages,",
      "    but you MUST mark them with fields like usesShellfish: true and torah.shellfishAllowed: true.",
      "- Casings: default to beef collagen or cellulose; hog casings should be treated as disallowed unless explicitly enabled.",
      "",
      "Scheduling expectations:",
      "- Use Sabbath and appointed-time windows from context.sabbathWindows as sacred blocks.",
      "- Do not schedule intensive active tasks inside sacred windows when avoidable.",
      "- If an active step must overlap, mark it with kind='hold' and note that it is a hands-off cold hold.",
      "- You may still propose a full schedule, but clearly indicate any Sabbath overlaps in task metadata.",
      "",
      "Behavior & output expectations per intent:",
      "- sausage.planBatch: build a batch plan with:",
      "  * plan: { planned: [...], schedule: [...], anyShellfishUsed: boolean, timezone: string }",
      "  * Each planned item should have: recipeId, name, species, kind, casings, lot, targetWeightKg, cook, ingredients, and a torah object.",
      "  * torah object should include: allowed (boolean), reason (string|null), usesShellfish (boolean), shellfishAllowed (boolean).",
      "- sausage.simulate: from a given plan, compute:",
      "  * commitPacket: { inventoryOps, undoOps, calendarEvents, labels, plan }",
      "  * labels should be ready for printing with torah-aware chips/badges if possible.",
      "- sausage.commit: from a commitPacket, derive commitSummary (no side effects here).",
      "- sausage.undo: from an undoToken, derive undoSummary (no side effects here).",
      "- sausage.listTemplates: return a templates array of Torah-aligned starter recipes.",
      "",
      "Important:",
      "- You do NOT perform actual inventory/calendar/label side effects; you only describe them in structured JSON.",
      "- Return ONLY JSON that the SSA automation runtime can consume. Do not include commentary outside of JSON.",
    ].join("\n");

  const userPrompt = JSON.stringify(
    {
      task: "sausage-batch-planning",
      intent,
      mode,
      input,
      context: {
        householdId: household.id || household.householdId || null,
        household,
        timezone,
        torahProfile,
        sabbathWindows,
      },
    },
    null,
    2
  );

  const payload = {
    intent,
    mode,
    input,
    context: {
      householdId: household.id || household.householdId || null,
      household,
      timezone,
      torahProfile,
      sabbathWindows,
    },
    task: "sausage-batch-planning",
  };

  return { systemPrompt, userPrompt, payload };
}

// -----------------------------------------------------------------------------
// Result Normalizer — planBatch / simulate / commit / undo / templates
// -----------------------------------------------------------------------------

/**
 * Normalize Reasoner output into sausage-aware structure.
 *
 * The Reasoner is responsible for building the detailed structures.
 * The normalizer mainly:
 *  - Ensures a consistent shape per intent.
 *  - Adds lightweight derived fields (e.g., torahSummary) when available.
 *
 * @param {string} intent
 * @param {Object} raw
 * @param {Object} context
 * @returns {Object}
 */
function normalizeResult(intent, raw, context) {
  const out = raw || {};
  const household = context?.household || {};
  const torahProfile =
    context?.torahProfile ||
    context?.torahDietaryProfile ||
    {};

  // Basic derived torah summary for convenience
  const torahSummary = out.torahSummary || {
    shellfishAllowed: !!torahProfile.shellfishAllowed,
    notes:
      out.torahSummary?.notes ||
      "Household TIP applied at planning time; check per-item torah flags.",
  };

  if (intent === "sausage.planBatch") {
    const plan = out.plan || {};
    const planned = plan.planned || [];
    const schedule = plan.schedule || [];
    const anyShellfishUsed =
      typeof plan.anyShellfishUsed === "boolean"
        ? plan.anyShellfishUsed
        : planned.some(
            (p) =>
              p.torah?.usesShellfish === true ||
              p.ingredients?.some((i) => i.isShellfish === true)
          );

    return {
      type: "sausage.planBatch",
      plan: {
        planned,
        schedule,
        anyShellfishUsed,
        timezone: plan.timezone || household.timezone || "America/New_York",
      },
      torahSummary,
      household,
    };
  }

  if (intent === "sausage.simulate") {
    const commitPacket = out.commitPacket || {};
    return {
      type: "sausage.simulate",
      commitPacket: {
        inventoryOps: commitPacket.inventoryOps || [],
        undoOps: commitPacket.undoOps || [],
        calendarEvents: commitPacket.calendarEvents || [],
        labels: commitPacket.labels || [],
        plan: commitPacket.plan || null,
      },
      torahSummary,
      household,
    };
  }

  if (intent === "sausage.commit") {
    const commitSummary = out.commitSummary || {};
    const lots =
      commitSummary.lots ||
      commitSummary.planLots ||
      commitSummary.commitPacket?.plan?.planned?.map((p) => p.lot) ||
      [];

    return {
      type: "sausage.commit",
      commitSummary: {
        lots,
        labels: commitSummary.labels || [],
        undoToken: commitSummary.undoToken || null,
        committed: commitSummary.committed !== false,
      },
      torahSummary,
      household,
    };
  }

  if (intent === "sausage.undo") {
    const undoSummary = out.undoSummary || {};
    return {
      type: "sausage.undo",
      undoSummary: {
        undone: undoSummary.undone !== false,
        undoToken: undoSummary.undoToken || null,
      },
      torahSummary,
      household,
    };
  }

  if (intent === "sausage.listTemplates") {
    const templates = out.templates || [];
    return {
      type: "sausage.listTemplates",
      templates,
      torahSummary,
      household,
    };
  }

  // Generic fallback
  return {
    type: "sausage.generic",
    result: out,
    torahSummary,
    household,
  };
}

// -----------------------------------------------------------------------------
// Main Shim Entry — invokeShim
// -----------------------------------------------------------------------------

/**
 * Invoke Sausage Shim.
 * - Enforces budget & gating.
 * - Uses selectors to build household/Torah/Sabbath context.
 * - Applies freshness & memoization with sausage-specific cache key.
 * - Calls Reasoner, validates, normalizes.
 * - Optionally exports to Hub when familyFundMode is on.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const debug = [];
  const warnings = [];

  if (!req || typeof req !== "object") {
    return buildShimResponse({
      ok: false,
      mode: "sausage.none",
      data: { error: "Missing ShimRequest" },
      warnings: [{ code: "bad_request", message: "Request object is required." }],
      debug,
    });
  }

  const { domain, intent, input = {}, runtime = {} } = req;

  if (!domain || !intent) {
    return buildShimResponse({
      ok: false,
      mode: "sausage.none",
      data: { error: "Missing domain or intent" },
      warnings: [{ code: "bad_request", message: "domain and intent are required." }],
      debug,
    });
  }

  // Resolve mode via modes/map.js (with defensive fallback)
  let modeInfo = null;
  try {
    modeInfo = resolveSausageMode
      ? resolveSausageMode(req)
      : null;
  } catch (err) {
    debug.push({
      stage: "resolveMode",
      error: err?.message || String(err),
    });
  }

  const fallbackModeMap = {
    "sausage.planBatch": "sausage.planBatch.v1",
    "sausage.simulate": "sausage.simulate.v1",
    "sausage.commit": "sausage.commit.v1",
    "sausage.undo": "sausage.undo.v1",
    "sausage.listTemplates": "sausage.listTemplates.v1",
  };

  const mode =
    modeInfo?.mode ||
    fallbackModeMap[intent] ||
    "sausage.generic.v1";

  const schemaId =
    modeInfo?.schemaId ||
    `sausage.${mode}.delta.schema.json`;

  debug.push({ stage: "modeSelected", mode, schemaId, intent, domain });

  // Gating: check if Reasoner is allowed for this call
  const gating = await isReasonerAllowed({
    domain,
    intent,
    mode,
    runtime,
  });

  if (!gating?.ok) {
    warnings.push({
      code: "gating_blocked",
      message: gating?.reason || "Reasoner call not allowed for this request.",
    });

    return buildShimResponse({
      ok: false,
      mode,
      data: { gating },
      warnings,
      debug,
    });
  }

  // Budget enforcement
  const budget = await checkBudget({
    domain,
    intent,
    mode,
    runtime,
  });

  if (!budget?.ok) {
    warnings.push({
      code: "budget_exceeded",
      message: budget?.reason || "Budget exceeded for this request.",
    });

    return buildShimResponse({
      ok: false,
      mode,
      data: { budget },
      warnings,
      debug,
    });
  }

  // Pull Dexie-backed context via selectors
  let context = {};
  try {
    const [householdCtx, torahDiet, sabbathWindows] = await Promise.all([
      getHouseholdContextForSausage(domain),
      getTorahDietaryProfile(domain),
      getSabbathWindows(domain),
    ]);

    context = {
      ...householdCtx,
      torahProfile: torahDiet || {},
      torahDietaryProfile: torahDiet || {},
      sabbathWindows: sabbathWindows || [],
    };

    debug.push({
      stage: "contextLoaded",
      contextKeys: Object.keys(context),
      hasSabbathWindows: !!(sabbathWindows && sabbathWindows.length),
    });
  } catch (err) {
    warnings.push({
      code: "context_error",
      message: "Failed to load full sausage context; proceeding with partial context.",
    });
    debug.push({
      stage: "contextError",
      error: err?.message || String(err),
    });
  }

  // Freshness + memo cache
  const cacheKey = makeSausageCacheKey({
    domain,
    intent,
    mode,
    input,
    contextHash: context?.hash || null,
  });

  try {
    const cached = await getMemoized(cacheKey);
    if (cached) {
      const freshness = applyFreshnessRules({
        domain,
        intent,
        mode,
        cachedAt: cached.ts,
      });

      if (freshness?.useCache) {
        emitReasonerEvent("reasoner.cachedHit", {
          domain,
          intent,
          mode,
          cacheKey,
        });

        debug.push({
          stage: "cacheHit",
          ts: cached.ts,
          freshness,
        });

        // Cached result assumed already normalized and validated
        return buildShimResponse({
          ok: true,
          mode,
          data: cached.data,
          warnings,
          debug,
        });
      }

      debug.push({
        stage: "cacheStale",
        ts: cached.ts,
        freshness,
      });
    } else {
      emitReasonerEvent("reasoner.cachedMiss", {
        domain,
        intent,
        mode,
        cacheKey,
      });
      debug.push({ stage: "cacheMiss", cacheKey });
    }
  } catch (err) {
    debug.push({
      stage: "cacheError",
      error: err?.message || String(err),
    });
  }

  // Build prompt & Reasoner payload
  const { systemPrompt, userPrompt, payload } = buildPromptForMode(
    req,
    mode,
    context
  );

  emitReasonerEvent("reasoner.invoked", {
    domain,
    intent,
    mode,
    cacheKey,
  });

  // Call Reasoner
  let rawResult;
  try {
    rawResult = await callReasoner({
      mode,
      systemPrompt,
      userPrompt,
      payload,
      runtime,
    });

    debug.push({
      stage: "reasonerReturned",
      hasResult: !!rawResult,
    });
  } catch (err) {
    warnings.push({
      code: "reasoner_error",
      message: err?.message || "Reasoner call failed.",
    });

    return buildShimResponse({
      ok: false,
      mode,
      data: { error: "Reasoner call failed", detail: err?.message || String(err) },
      warnings,
      debug,
    });
  }

  // Schema validation
  const validation = validateModeOutput(schemaId, rawResult);
  if (!validation?.ok) {
    emitReasonerEvent("reasoner.invalidSchema", {
      domain,
      intent,
      mode,
      schemaId,
      errors: validation?.errors || [],
    });

    warnings.push({
      code: "invalid_schema",
      message:
        "Reasoner output did not match schema; see debug for validation errors.",
    });

    debug.push({
      stage: "schemaValidationFailed",
      schemaId,
      errors: validation?.errors || [],
    });

    // Still attempt to normalize so the caller has *something* usable.
  } else {
    emitReasonerEvent("reasoner.validated", {
      domain,
      intent,
      mode,
      schemaId,
    });

    debug.push({
      stage: "schemaValidationPassed",
      schemaId,
    });
  }

  // Normalize result into sausage structure
  const normalized = normalizeResult(intent, rawResult, context);

  // Confidence rules
  const confidence = applyConfidenceRules({
    domain,
    intent,
    mode,
    output: normalized,
  });

  if (!confidence?.ok) {
    warnings.push({
      code: "low_confidence",
      message:
        confidence?.reason ||
        "Output confidence below preferred threshold; review before committing.",
    });

    debug.push({
      stage: "confidenceLow",
      score: confidence?.score,
      details: confidence,
    });
  } else {
    debug.push({
      stage: "confidenceOk",
      score: confidence?.score,
    });
  }

  // Memoize normalized result
  try {
    await setMemoized(cacheKey, {
      ts: nowISO(),
      mode,
      data: normalized,
    });
  } catch (err) {
    debug.push({
      stage: "cacheSetError",
      error: err?.message || String(err),
    });
  }

  // Optional: Hub export when familyFundMode is on
  if (familyFundMode && runtime?.exportToHub) {
    try {
      const packet = HubPacketFormatter.format({
        domain,
        source: SHIM_SOURCE,
        kind: "sausage",
        payload: normalized,
      });

      await FamilyFundConnector.send(packet);

      emitReasonerEvent("session.exported", {
        domain,
        intent,
        mode,
        hub: { sent: true },
      });

      debug.push({
        stage: "hubExported",
        packetSummary: {
          kind: packet.kind,
          size: JSON.stringify(packet).length,
        },
      });
    } catch (err) {
      warnings.push({
        code: "hub_export_failed",
        message: err?.message || "Failed to export sausage result to Hub.",
      });
      debug.push({
        stage: "hubExportError",
        error: err?.message || String(err),
      });
    }
  }

  return buildShimResponse({
    ok: true,
    mode,
    data: normalized,
    warnings,
    debug,
  });
}

// -----------------------------------------------------------------------------
// Legacy compatibility wrapper (old sausageAgent-style API)
// -----------------------------------------------------------------------------

/**
 * Optional small wrapper to keep a similar API to the old sausageAgent
 * while the rest of the app is being migrated.
 *
 * Example usage:
 *   await invokeSausageCommand("planBatch", { recipes, household, options })
 *
 * @param {string} command
 * @param {Object} payload
 * @returns {Promise<ShimResponse>}
 */
export async function invokeSausageCommand(command, payload = {}) {
  const cmd = String(command || "").toLowerCase().trim();
  const map = {
    planbatch: "sausage.planBatch",
    plan: "sausage.planBatch",
    simulate: "sausage.simulate",
    commit: "sausage.commit",
    undo: "sausage.undo",
    listtemplates: "sausage.listTemplates",
    templates: "sausage.listTemplates",
  };

  const intent = map[cmd] || "sausage.planBatch";

  return invokeShim({
    domain: "preservation",
    intent,
    input: payload || {},
    runtime: payload.runtime || {},
  });
}

export default {
  name: "sausageShim",
  invokeShim,
  invokeSausageCommand,
};
