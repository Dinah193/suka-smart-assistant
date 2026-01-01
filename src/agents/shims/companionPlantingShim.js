// src/agents/shims/companionPlantingShim.js
// -----------------------------------------------------------------------------
// SSA Companion Planting Shim
//
// Replaces the old "CompanionPlantingAgent" that:
//   - Contained all companion-planting rule tables (good/avoid/caution/isolate)
//   - Did layout planning, placement, interplant/succession scheduling
//   - Built seasonal rotations and validation diffs
//   - Optionally used callLLM for narrative notes
//
// New behavior (SSA-compliant):
//   - Delegates all logic to the central Reasoner
//   - Uses budget.json, gating, confidence, freshness, memo cache
//   - Uses selectors.js to pull garden context (beds, catalog, zone, frost dates, etc.)
//   - Uses modes/map.js + schemas for validation
//   - Emits standard reasoner.* events via eventBus
//   - Optionally composes garden sessions and exports to Hub when familyFundMode is enabled
//
// Supported intents (logical mapping of old commands):
//   - "garden.companion.suggest"        ← suggestCompanions
//   - "garden.companion.planLayout"     ← planLayout
//   - "garden.companion.validatePlan"   ← validatePlan
//   - "garden.companion.seasonalRotation" ← seasonalRotation
//   - "garden.companion.getGuide"       ← getGuide
//   - "garden.companion.sync"           ← syncWithGardenAgent
//
// For backward compatibility, a thin handleCompanionCommand(command, payload)
// wrapper is provided at the bottom, as well as a default export object.
// -----------------------------------------------------------------------------

import { emit } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

import budget from "@/reasoner/budget.json";
import { canInvokeReasoner } from "@/reasoner/gating";
import { evaluateConfidence } from "@/reasoner/confidence";
import { selectGardenContext } from "@/reasoner/selectors";
import { applyFreshnessRules } from "@/reasoner/freshness";
import { getMemo, setMemo } from "@/reasoner/cache/memo";
import { buildGardenMemoKey } from "@/reasoner/cache/keys";
import { resolveMode } from "@/reasoner/modes/map";
import { validateModeOutput } from "@/reasoner/modes/validate";
import { getSystemPrompt } from "@/reasoner/prompts/system";
import { buildGardenPrompt } from "@/reasoner/prompts/templates";
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

const SHIM_SOURCE = "agents/shims/companionPlanting";
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
 * Enforce budget constraints using budget.json for companion planting.
 *
 * @param {ShimRequest} reqLike
 * @param {Array<Object>} debug
 * @returns {{ ok: boolean, reason?: string }}
 */
function enforceBudget(reqLike, debug) {
  const domainBudget =
    (budget && (budget.companionPlanting || budget.garden || budget.household)) || {};

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
      reason: "input_too_large_for_companionPlanting_budget",
    };
  }

  return { ok: true };
}

/**
 * Resolve Reasoner mode for a garden companion request via modes/map.js.
 *
 * @param {ShimRequest} req
 * @param {Object} context
 * @returns {string}
 */
function resolveShimMode(req, context) {
  return (
    resolveMode({
      domain: "garden",
      intent: req.intent,
      context,
      runtime: req.runtime || {},
      source: SHIM_SOURCE,
    }) || req.intent || "garden.companion.planLayout"
  );
}

/**
 * Optionally compose garden sessions from Reasoner output.
 *
 * The Reasoner is expected (for layout / seasonal / validation flows) to
 * optionally return something like:
 *
 * {
 *   sessionsDraft: [
 *     {
 *       title: "Plant bed A",
 *       domain: "garden",
 *       sourceType: "gardenPlan",
 *       refId: "bedA-2025-spring",
 *       // step drafts, etc...
 *     }
 *   ],
 *   // other structured plan data...
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
    domain: "garden",
    drafts,
    source: {
      type: normalizedData.sourceType || "gardenPlan",
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
 * Export garden plan/session info to Hub if familyFundMode is enabled.
 *
 * @param {Array<Object>} sessions
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<void>}
 */
async function maybeExportToHub(sessions, normalizedData, req, debug) {
  if (!familyFundMode) return;

  const packets = HubPacketFormatter.fromGardenPlan({
    domain: "garden",
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
      domain: "garden",
      origin: "CompanionPlantingShim",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main Companion Planting shim.
 *
 * High-level intents (aligned with old commands):
 *
 * 1) "garden.companion.suggest"
 *    - Old: cmdSuggestCompanions(payload)
 *    - Input example:
 *      {
 *        targetCrops: string[],
 *        settings?: { narrativeNotes?: boolean },
 *        options?: { useLLM?: boolean }
 *      }
 *    - Output via Reasoner schema:
 *      {
 *        guide: {...},  // structured companions/conflicts/cautions
 *        recommendations: string[],
 *        gardenUpdates: [...]
 *      }
 *
 * 2) "garden.companion.planLayout"
 *    - Old: cmdPlanLayout(payload)
 *    - Input example:
 *      {
 *        beds: [...],
 *        plantingPlans: [...],
 *        plantCatalog: [...],
 *        pestPressure?: [...],
 *        zoneInfo?: {...},
 *        settings?: {...},
 *        options?: {...}
 *      }
 *
 * 3) "garden.companion.validatePlan"
 *    - Old: cmdValidatePlan(payload)
 *
 * 4) "garden.companion.seasonalRotation"
 *    - Old: cmdSeasonalRotation(payload)
 *
 * 5) "garden.companion.getGuide"
 *    - Old: cmdGetGuide(payload)
 *
 * 6) "garden.companion.sync"
 *    - Old: cmdSyncWithGardenAgent(payload)
 *
 * The Reasoner owns all companion rule tables, allelopathy constraints,
 * bed grids, rotation logic, and narrative; this shim simply coordinates.
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

    const domain = req.domain || "garden";
    if (domain !== "garden") {
      warnings.push({
        type: "domain.mismatch",
        expected: "garden",
        got: domain,
      });
    }

    const intent = req.intent || "garden.companion.planLayout";
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
      domain: "garden",
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
    //    Replaces direct store usage (beds, plantCatalog, zoneInfo, history).
    // -------------------------------------------------
    const context = await selectGardenContext({
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
      domain: "garden",
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
          domain: "garden",
          intent,
          guards: guardsResult,
        },
      });

      // For companion planning, a "noop" is acceptable if blocked.
      return buildShimResponse(
        true,
        "garden.companion.guarded.noop",
        {
          guards: guardsResult,
          note: "Companion planting action blocked by guard conditions.",
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
    const memoKey = buildGardenMemoKey({
      mode,
      intent,
      input,
      context,
      runtime,
    });

    const cached = await getMemo(memoKey);

    if (cached) {
      const isFresh = applyFreshnessRules({
        domain: "garden",
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
            domain: "garden",
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
        domain: "garden",
        mode,
        intent,
        memoKey,
      },
    });

    // -------------------------------------------------
    // 7. Prompt construction
    // -------------------------------------------------
    const systemPrompt = getSystemPrompt("garden");
    const prompt = buildGardenPrompt({
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
        domain: "garden",
        mode,
        intent,
        runtime,
      },
    });

    const rawOutput = await invokeReasoner({
      domain: "garden",
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
      domain: "garden",
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
          domain: "garden",
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
        domain: "garden",
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
      domain: "garden",
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
    // are handled by the SessionRunner when those sessions execute.

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
    domain: "garden",
    intent,
    input,
    runtime,
  });
}

/**
 * Suggest companions/conflicts/cautions for a set of crops.
 * Replaces cmdSuggestCompanions(payload).
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function suggestCompanions(payload = {}, runtime = {}) {
  return handleIntent("garden.companion.suggest", payload, runtime);
}

/**
 * Plan layout(s) for one or more beds.
 * Replaces cmdPlanLayout(payload).
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function planLayout(payload = {}, runtime = {}) {
  return handleIntent("garden.companion.planLayout", payload, runtime);
}

/**
 * Validate an existing bed layout for conflicts/overcrowding.
 * Replaces cmdValidatePlan(payload).
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function validatePlan(payload = {}, runtime = {}) {
  return handleIntent("garden.companion.validatePlan", payload, runtime);
}

/**
 * Recommend seasonal rotations for beds based on family history.
 * Replaces cmdSeasonalRotation(payload).
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function seasonalRotation(payload = {}, runtime = {}) {
  return handleIntent("garden.companion.seasonalRotation", payload, runtime);
}

/**
 * Get a quick companion guide for given crops.
 * Replaces cmdGetGuide(payload).
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function getGuide(payload = {}, runtime = {}) {
  return handleIntent("garden.companion.getGuide", payload, runtime);
}

/**
 * Sync companion layouts into SSA/gardenAgent format.
 * Replaces cmdSyncWithGardenAgent(payload).
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function syncWithGardenAgent(payload = {}, runtime = {}) {
  return handleIntent("garden.companion.sync", payload, runtime);
}

/* ------------------------------------------------------------------
 * Backward-compatible command router
 * ------------------------------------------------------------------ */

/**
 * Backward-compatible router that mimics the old:
 *   handleCompanionCommand(command, payload)
 *
 * It maps old commands to new Reasoner-backed intents.
 *
 * @param {string} command
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCompanionCommand(command, payload = {}, runtime = {}) {
  switch (command) {
    case "suggestCompanions":
      return suggestCompanions(payload, runtime);
    case "planLayout":
      return planLayout(payload, runtime);
    case "validatePlan":
      return validatePlan(payload, runtime);
    case "seasonalRotation":
      return seasonalRotation(payload, runtime);
    case "getGuide":
      return getGuide(payload, runtime);
    case "syncWithGardenAgent":
      return syncWithGardenAgent(payload, runtime);
    default:
      return buildShimResponse(
        false,
        "garden.companion.unknownCommand",
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

const CompanionPlantingShim = {
  id: "CompanionPlantingAgent",
  invokeShim,
  handleCompanionCommand,
  suggestCompanions,
  planLayout,
  validatePlan,
  seasonalRotation,
  getGuide,
  syncWithGardenAgent,
};

export default CompanionPlantingShim;
