// src/agents/shims/cookingShim.js
// -----------------------------------------------------------------------------
// SSA Cooking Shim
//
// Replaces the old "CookingAgent" that:
//   - Pulled recipes from RecipeStore
//   - Applied dietary / allergy / tool / time filters
//   - Scored and picked cookable meals
//   - Called callLLM to:
//       • rewrite steps,
//       • propose substitutions,
//       • explain nutrition/fitness fit,
//       • parse freeform prompts,
//       • summarize recipes,
//       • scale recipes.
//   - Coordinated multi-household "coalition" batch sessions
//   - Created label batches and performed lightweight undo
//   - Emitted ad-hoc UI events ("ui.toast", "nba.suggest", etc.)
//
// New behavior (SSA-compliant shim):
//   - Delegates all planning and LLM work to the central Reasoner
//   - Uses budget.json, gating, confidence, freshness, memo cache
//   - Uses selectors.js to pull cooking context (recipes, inventory, prefs, coalitions, etc.)
//   - Uses modes/map.js + schemas for validation
//   - Emits standardized reasoner.* events via eventBus
//   - Optionally composes cooking sessions and exports to Hub when familyFundMode is enabled
//
// Logical mapping of old commands → Reasoner intents:
//
//   "suggestMeals"        → "cooking.suggestMeals"
//   "planFromPrompt"      → "cooking.planFromPrompt"
//   "substitutionsFor"    → "cooking.substitutionsFor"
//   "summarizeRecipes"    → "cooking.summarizeRecipes"
//   "scaleRecipe"         → "cooking.scaleRecipe"
//   "getDashboard"        → "cooking.getDashboard"
//   "groupBatchSuggest"   → "cooking.groupBatchSuggest"
//   "startBatchSession"   → "cooking.startBatchSession"
//   "labelsForBatch"      → "cooking.labelsForBatch"
//   "undo"                → "cooking.undo"
//
// NOTE: All UI / toast / NBA suggestions, direct LLM calls,
// RecipeStore, Coalition, Labels, Analytics interactions are now
// handled by the Reasoner + downstream automation, not in the shim.
// -----------------------------------------------------------------------------

import { emit } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

import budget from "@/reasoner/budget.json";
import { canInvokeReasoner } from "@/reasoner/gating";
import { evaluateConfidence } from "@/reasoner/confidence";
import { selectCookingContext } from "@/reasoner/selectors";
import { applyFreshnessRules } from "@/reasoner/freshness";
import { getMemo, setMemo } from "@/reasoner/cache/memo";
import { buildCookingMemoKey } from "@/reasoner/cache/keys";
import { resolveMode } from "@/reasoner/modes/map";
import { validateModeOutput } from "@/reasoner/modes/validate";
import { getSystemPrompt } from "@/reasoner/prompts/system";
import { buildCookingPrompt } from "@/reasoner/prompts/templates";
import { invokeReasoner } from "@/reasoner/core";

import { evaluateGuards } from "@/guards/guardsEvaluate";
import { composeSessionsFromPlan } from "@/skills/sessions/compose";

import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

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

const SHIM_SOURCE = "agents/shims/cooking";
const isoNow = () => new Date().toISOString();

/**
 * Build a standard ShimResponse.
 * @param {boolean} ok
 * @param {string} mode
 * @param {Object} data
 * @param {Array<Object>} [warnings]
 * @param {Array<Object>} [debug]
 * @returns {ShimResponse}
 */
function buildShimResponse(ok, mode, data, warnings = [], debug = []) {
  return {
    ok: Boolean(ok),
    mode: mode || "none",
    data: data || {},
    warnings,
    debug,
  };
}

/**
 * Build an error ShimResponse.
 * @param {string} reason
 * @param {string} [mode]
 * @param {Error} [err]
 * @param {Array<Object>} [debug]
 * @returns {ShimResponse}
 */
function buildErrorResponse(reason, mode = "none", err, debug = []) {
  const payload = {
    reason,
    ...(err
      ? {
          error: {
            message: err.message || String(err),
            name: err.name || "Error",
          },
        }
      : {}),
  };

  return buildShimResponse(false, mode, payload, [{ type: "error", reason }], debug);
}

/**
 * Enforce budget constraints using budget.json for cooking.
 *
 * @param {ShimRequest} reqLike
 * @param {Array<Object>} debug
 * @returns {{ ok: boolean, reason?: string }}
 */
function enforceBudget(reqLike, debug) {
  const domainBudget =
    (budget && (budget.cooking || budget.cookingAgent || budget.household)) || {};

  const maxChars = domainBudget.maxChars || 25000;
  const serializedInput = JSON.stringify(reqLike.input || {});
  const estimateSize = serializedInput.length;

  debug.push({
    stage: "budget.check",
    maxChars,
    estimateSize,
  });

  if (estimateSize > maxChars) {
    return {
      ok: false,
      reason: "input_too_large_for_cooking_budget",
    };
  }

  return { ok: true };
}

/**
 * Resolve Reasoner mode for a cooking request via modes/map.js.
 *
 * @param {ShimRequest} req
 * @param {Object} context
 * @returns {string}
 */
function resolveShimMode(req, context) {
  return (
    resolveMode({
      domain: "cooking",
      intent: req.intent,
      context,
      runtime: req.runtime || {},
      source: SHIM_SOURCE,
    }) || req.intent || "cooking.suggestMeals"
  );
}

/**
 * Optionally compose cooking sessions from Reasoner output.
 *
 * The Reasoner is expected (for suggest / plan / batch / scale flows) to
 * optionally return something like:
 *
 * {
 *   sessionsDraft: [
 *     {
 *       title: "Cook 3 dinners in 90 minutes",
 *       domain: "cooking",
 *       sourceType: "recipe",
 *       refId: "batch-2025-04-01-123",
 *       // step drafts, etc...
 *     }
 *   ],
 *   // additional structured plan data...
 * }
 *
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<Array<Object>>}
 */
async function maybeComposeSessions(normalizedData, req, debug) {
  const drafts = normalizedData && normalizedData.sessionsDraft;
  if (!Array.isArray(drafts) || !drafts.length) return [];

  const sessions = await composeSessionsFromPlan({
    domain: "cooking",
    drafts,
    source: {
      type: normalizedData.sourceType || "recipe",
      refId: normalizedData.sourceRefId || null,
    },
    runtime: req.runtime || {},
  });

  debug.push({
    stage: "sessions.compose",
    count: Array.isArray(sessions) ? sessions.length : 0,
  });

  return Array.isArray(sessions) ? sessions : [];
}

/**
 * Export cooking plan/session info to Hub if familyFundMode is enabled.
 *
 * @param {Array<Object>} sessions
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<void>}
 */
async function maybeExportToHub(sessions, normalizedData, req, debug) {
  if (!familyFundMode) return;

  const packets = HubPacketFormatter.fromCookingPlan({
    domain: "cooking",
    sessions,
    plan: normalizedData,
    runtime: req.runtime || {},
  });

  debug.push({
    stage: "hub.format",
    packetCount: Array.isArray(packets) ? packets.length : 0,
  });

  if (!packets || !packets.length) return;

  await FamilyFundConnector.sendBatch(packets);

  emit({
    type: "session.exported",
    ts: isoNow(),
    source: SHIM_SOURCE,
    data: {
      domain: "cooking",
      origin: "CookingShim",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main Cooking shim.
 *
 * High-level intents aligned with old CookingAgent commands:
 *
 * 1) "cooking.suggestMeals"
 *    - Old: suggestCookableMeals({ userPreferences, inventorySnapshot })
 *    - Input example:
 *      {
 *        userPreferences?: {...},
 *        inventorySnapshot?: {...}
 *      }
 *    - Output via Reasoner schema:
 *      {
 *        options: [...],
 *        groceryList: [...],
 *        summary: string,
 *        emptyHint?: string,
 *        nextAction?: string,
 *        // possibly sessionsDraft for batch sessions
 *      }
 *
 * 2) "cooking.planFromPrompt"
 * 3) "cooking.substitutionsFor"
 * 4) "cooking.summarizeRecipes"
 * 5) "cooking.scaleRecipe"
 * 6) "cooking.getDashboard"
 * 7) "cooking.groupBatchSuggest"
 * 8) "cooking.startBatchSession"
 * 9) "cooking.labelsForBatch"
 * 10) "cooking.undo"
 *
 * All detailed logic (recipe filtering, coalition splitting, label queues,
 * undo tokens, nutrition explanations, etc.) is now owned by the Reasoner.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const debug = [];
  const warnings = [];

  try {
    // -------------------------------------------------
    // 1. Basic validation & normalization
    // -------------------------------------------------
    if (!req || typeof req !== "object") {
      return buildErrorResponse("invalid_request", "none", undefined, debug);
    }

    const domain = req.domain || "cooking";
    if (domain !== "cooking") {
      warnings.push({
        type: "domain.mismatch",
        expected: "cooking",
        got: domain,
      });
    }

    const intent = req.intent || "cooking.suggestMeals";
    const runtime = req.runtime || {};
    const input = req.input || {};

    debug.push({
      stage: "request.parsed",
      domain,
      intent,
      runtimeSummary: {
        userId: runtime.userId || null,
        requestId: runtime.requestId || null,
      },
    });

    // -------------------------------------------------
    // 2. Budget + gating
    // -------------------------------------------------
    const budgetCheck = enforceBudget({ domain, intent, input, runtime }, debug);
    if (!budgetCheck.ok) {
      warnings.push({
        type: "budget.blocked",
        reason: budgetCheck.reason,
      });
      return buildErrorResponse(budgetCheck.reason, "none", undefined, debug);
    }

    const allowed = canInvokeReasoner({
      domain: "cooking",
      intent,
      runtime,
      input,
    });

    debug.push({
      stage: "gating.check",
      allowed,
    });

    if (!allowed) {
      return buildErrorResponse("gated_by_policy", "none", undefined, debug);
    }

    // -------------------------------------------------
    // 3. Context selection (Dexie-backed)
    //    Replaces direct getRecipes / inventory / coalition / labels usage.
    // -------------------------------------------------
    const context = await selectCookingContext({
      intent,
      input,
      runtime,
    });

    debug.push({
      stage: "context.selected",
      keys: Object.keys(context || {}),
    });

    // -------------------------------------------------
    // 4. Guard evaluation (Sabbath, Quiet Hours, Weather, Inventory, Battery)
    // -------------------------------------------------
    const guardsResult = await evaluateGuards({
      domain: "cooking",
      intent,
      input,
      context,
      runtime,
    });

    debug.push({
      stage: "guards.evaluated",
      result: guardsResult,
    });

    if (guardsResult && guardsResult.blocked) {
      warnings.push({
        type: "guards.blocked",
        guards: guardsResult,
      });

      emit({
        type: "reasoner.skipped.guardsBlocked",
        ts: isoNow(),
        source: SHIM_SOURCE,
        data: {
          domain: "cooking",
          intent,
          guards: guardsResult,
        },
      });

      // For cooking suggestions/plans, a "noop" is acceptable if blocked.
      return buildShimResponse(
        true,
        "cooking.guarded.noop",
        {
          guards: guardsResult,
          note: "Cooking action blocked by guard conditions.",
        },
        warnings,
        debug
      );
    }

    // -------------------------------------------------
    // 5. Mode resolution via modes/map.js
    // -------------------------------------------------
    const mode = resolveShimMode({ domain, intent, input, runtime }, context);

    debug.push({
      stage: "mode.resolved",
      mode,
    });

    // -------------------------------------------------
    // 6. Cache / memoization
    // -------------------------------------------------
    const memoKey = buildCookingMemoKey({
      mode,
      intent,
      input,
      context,
      runtime,
    });

    const cached = await getMemo(memoKey);

    if (cached) {
      const isFresh = applyFreshnessRules({
        domain: "cooking",
        mode,
        cached,
        context,
        runtime,
      });

      debug.push({
        stage: "memo.checked",
        hit: true,
        fresh: isFresh,
      });

      if (isFresh) {
        emit({
          type: "reasoner.cachedHit",
          ts: isoNow(),
          source: SHIM_SOURCE,
          data: {
            domain: "cooking",
            mode,
            intent,
            memoKey,
          },
        });

        return buildShimResponse(true, mode, cached.data, warnings, debug);
      }

      warnings.push({
        type: "memo.stale",
        memoKey,
      });
    } else {
      debug.push({
        stage: "memo.checked",
        hit: false,
      });
    }

    emit({
      type: "reasoner.cachedMiss",
      ts: isoNow(),
      source: SHIM_SOURCE,
      data: {
        domain: "cooking",
        mode,
        intent,
        memoKey,
      },
    });

    // -------------------------------------------------
    // 7. Prompt construction
    // -------------------------------------------------
    const systemPrompt = getSystemPrompt("cooking");
    const prompt = buildCookingPrompt({
      mode,
      intent,
      input,
      context,
    });

    debug.push({
      stage: "prompt.built",
      systemLength: systemPrompt ? systemPrompt.length : 0,
      userLength: prompt ? prompt.length : 0,
    });

    // -------------------------------------------------
    // 8. Reasoner invocation
    // -------------------------------------------------
    emit({
      type: "reasoner.invoked",
      ts: isoNow(),
      source: SHIM_SOURCE,
      data: {
        domain: "cooking",
        mode,
        intent,
        runtime,
      },
    });

    const rawOutput = await invokeReasoner({
      domain: "cooking",
      mode,
      intent,
      system: systemPrompt,
      prompt,
      context,
      runtime,
    });

    debug.push({
      stage: "reasoner.returned",
      typeofRaw: typeof rawOutput,
    });

    // -------------------------------------------------
    // 9. Schema validation + normalization
    // -------------------------------------------------
    const validation = await validateModeOutput({
      domain: "cooking",
      mode,
      payload: rawOutput,
    });

    if (!validation || !validation.ok) {
      const errors = (validation && validation.errors) || [];

      warnings.push({
        type: "schema.invalid",
        mode,
        errors,
      });

      emit({
        type: "reasoner.invalidSchema",
        ts: isoNow(),
        source: SHIM_SOURCE,
        data: {
          domain: "cooking",
          mode,
          intent,
          errors,
        },
      });

      return buildErrorResponse("invalid_schema", mode, undefined, debug);
    }

    emit({
      type: "reasoner.validated",
      ts: isoNow(),
      source: SHIM_SOURCE,
      data: {
        domain: "cooking",
        mode,
        intent,
      },
    });

    const normalized = validation.value || validation.data || rawOutput;

    debug.push({
      stage: "schema.normalized",
      keys: Object.keys(normalized || {}),
    });

    // -------------------------------------------------
    // 10. Confidence evaluation
    // -------------------------------------------------
    const confidence = evaluateConfidence({
      domain: "cooking",
      mode,
      intent,
      output: normalized,
      context,
      runtime,
    });

    debug.push({
      stage: "confidence.evaluated",
      confidence,
    });

    if (confidence && confidence.level === "low") {
      warnings.push({
        type: "confidence.low",
        confidence,
      });
    }

    // -------------------------------------------------
    // 11. Compose sessions (optional)
    // -------------------------------------------------
    const sessions = await maybeComposeSessions(normalized, { domain, intent, input, runtime }, debug);

    // Session lifecycle events (session.started / step.changed / etc.)
    // are emitted by the SessionRunner when those sessions execute,
    // not by this shim.

    // -------------------------------------------------
    // 12. Cache store
    // -------------------------------------------------
    await setMemo(memoKey, {
      data: normalized,
      mode,
      intent,
      storedAt: isoNow(),
      confidence,
    });

    debug.push({
      stage: "memo.stored",
      memoKey,
    });

    // -------------------------------------------------
    // 13. Optional Hub export
    // -------------------------------------------------
    await maybeExportToHub(sessions, normalized, { domain, intent, input, runtime }, debug);

    // -------------------------------------------------
    // 14. Final response
    // -------------------------------------------------
    const data = {
      planner: normalized,
      sessions,
      meta: {
        confidence,
        guards: guardsResult,
      },
    };

    return buildShimResponse(true, mode, data, warnings, debug);
  } catch (err) {
    return buildErrorResponse("shim_runtime_error", "none", err, [
      ...debug,
      {
        stage: "error",
        message: err.message || String(err),
        name: err.name || "Error",
      },
    ]);
  }
}

/* ------------------------------------------------------------------
 * Thin intent helpers (shim-backed public API)
 * ------------------------------------------------------------------ */

/**
 * Internal helper to build a ShimRequest and call invokeShim.
 *
 * @param {string} intent
 * @param {Object} input
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
async function handleIntent(intent, input = {}, runtime = {}) {
  return invokeShim({
    domain: "cooking",
    intent,
    input,
    runtime,
  });
}

/**
 * Suggest cookable meals given user preferences and inventory.
 * Replaces suggestCookableMeals + "suggestMeals" command.
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function suggestMeals(payload = {}, runtime = {}) {
  return handleIntent("cooking.suggestMeals", payload, runtime);
}

/**
 * Parse a freeform cooking prompt into preferences/inventory and
 * suggest meals accordingly.
 * Replaces "planFromPrompt".
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function planFromPrompt(payload = {}, runtime = {}) {
  return handleIntent("cooking.planFromPrompt", payload, runtime);
}

/**
 * Suggest substitutions given available ingredients and missing items.
 * Replaces "substitutionsFor".
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function substitutionsFor(payload = {}, runtime = {}) {
  return handleIntent("cooking.substitutionsFor", payload, runtime);
}

/**
 * Summarize recipes for a dashboard or overview.
 * Replaces "summarizeRecipes".
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function summarizeRecipes(payload = {}, runtime = {}) {
  return handleIntent("cooking.summarizeRecipes", payload, runtime);
}

/**
 * Scale a recipe from base servings to target servings.
 * Replaces "scaleRecipe".
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function scaleRecipe(payload = {}, runtime = {}) {
  return handleIntent("cooking.scaleRecipe", payload, runtime);
}

/**
 * Get a cooking dashboard snapshot (quick picks, tags, etc.).
 * Replaces "getDashboard".
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function getDashboard(payload = {}, runtime = {}) {
  return handleIntent("cooking.getDashboard", payload, runtime);
}

/**
 * Suggest a group batch session (coalition cooking).
 * Replaces "groupBatchSuggest".
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function groupBatchSuggest(payload = {}, runtime = {}) {
  return handleIntent("cooking.groupBatchSuggest", payload, runtime);
}

/**
 * Start a batch cooking session (possibly coalition-linked).
 * Replaces "startBatchSession".
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function startBatchSession(payload = {}, runtime = {}) {
  return handleIntent("cooking.startBatchSession", payload, runtime);
}

/**
 * Build label batches for cooked items.
 * Replaces "labelsForBatch".
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function labelsForBatch(payload = {}, runtime = {}) {
  return handleIntent("cooking.labelsForBatch", payload, runtime);
}

/**
 * Undo a recent cooking-related action (Reasoner-defined).
 * Replaces "undo" token stack inside agent.
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function undo(payload = {}, runtime = {}) {
  return handleIntent("cooking.undo", payload, runtime);
}

/* ------------------------------------------------------------------
 * Backward-compatible command router (like old handleCommand)
 * ------------------------------------------------------------------ */

/**
 * Backward-compatible router that mimics the old:
 *   handleCommand(command, payload)
 *
 * It maps old commands to new Reasoner-backed intents.
 *
 * @param {string} command
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}, runtime = {}) {
  switch (command) {
    case "suggestMeals":
      return suggestMeals(payload, runtime);
    case "planFromPrompt":
      return planFromPrompt(payload, runtime);
    case "substitutionsFor":
      return substitutionsFor(payload, runtime);
    case "summarizeRecipes":
      return summarizeRecipes(payload, runtime);
    case "scaleRecipe":
      return scaleRecipe(payload, runtime);
    case "getDashboard":
      return getDashboard(payload, runtime);
    case "groupBatchSuggest":
      return groupBatchSuggest(payload, runtime);
    case "startBatchSession":
      return startBatchSession(payload, runtime);
    case "labelsForBatch":
      return labelsForBatch(payload, runtime);
    case "undo":
      return undo(payload, runtime);
    default:
      return buildShimResponse(
        false,
        "cooking.unknownCommand",
        {
          reason: "unknown_command",
          command,
        },
        [
          {
            type: "unknown.command",
            command,
          },
        ],
        []
      );
  }
}

/* ------------------------------------------------------------------
 * Default export (for compatibility with old imports)
 * ------------------------------------------------------------------ */

const CookingShim = {
  id: "CookingAgent",
  invokeShim,
  handleCommand,
  suggestMeals,
  planFromPrompt,
  substitutionsFor,
  summarizeRecipes,
  scaleRecipe,
  getDashboard,
  groupBatchSuggest,
  startBatchSession,
  labelsForBatch,
  undo,
};

export default CookingShim;
