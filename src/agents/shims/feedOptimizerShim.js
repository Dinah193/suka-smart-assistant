// src/agents/shims/feedOptimizerShim.js
// -----------------------------------------------------------------------------
// Feed Optimizer Shim for SSA
//
// Replaces the old feedOptimizerAgent "big brain" with a thin shim that:
//
//  - Delegates feed coverage, ration optimization, rotation, sourcing, and
//    scenario reasoning to the central Reasoner.
//  - Enforces budget, gating, confidence, freshness, memoization.
//  - Pulls herd/feed context from Dexie via selectors.js.
//  - Evaluates guard modules (Sabbath / Quiet Hours / Weather / Inventory / Battery).
//  - Optionally composes Sessions (feeding, mixing, rotation) for SessionRunner.
//  - Optionally exports to the Family Fund Hub when familyFundMode is enabled.
//  - Exposes a backward-compatible command router for your old call sites.
//
// Intents this shim supports (mirroring the old commands):
//   - "animals.feed.planCoverage"
//   - "animals.feed.optimizeRations"
//   - "animals.feed.generateRotation"
//   - "animals.feed.sourceFeed"
//   - "animals.feed.simulate"
//   - "animals.feed.syncWithInventoryAgent"
//
// -----------------------------------------------------------------------------

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

import budget from "@/reasoner/budget.js";
import { canInvokeReasoner } from "@/reasoner/gating";
import { evaluateConfidence } from "@/reasoner/confidence";
import {
  selectAnimalsContext,
  // if your selectors are namespaced differently, adjust this import
} from "@/reasoner/selectors";
import { applyFreshnessRules } from "@/reasoner/freshness";
import { getMemo, setMemo } from "@/reasoner/cache/memo";
import { buildAnimalsFeedMemoKey } from "@/reasoner/cache/keys";
import { resolveMode } from "@/reasoner/modes/map";
import { validateModeOutput } from "@/reasoner/modes/validate";
import { getSystemPrompt } from "@/reasoner/prompts/system";
import { buildAnimalsPrompt } from "@/reasoner/prompts/templates";
import { invokeReasoner } from "@/reasoner/core";

import { evaluateGuards } from "@/agents/skills/sessions/guardsEvaluate";
import { composeSessionsFromPlan } from "@agents/skills/sessions/compose";

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

const SHIM_SOURCE = "agents/shims/feedOptimizer";
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
 * Build an error ShimResponse, with optional error details.
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

  return buildShimResponse(
    false,
    mode,
    payload,
    [{ type: "error", reason }],
    debug
  );
}

/**
 * Enforce budget constraints using budget.json for animals/feed flows.
 *
 * @param {ShimRequest} reqLike
 * @param {Array<Object>} debug
 * @returns {{ ok: boolean, reason?: string }}
 */
function enforceBudget(reqLike, debug) {
  // Prefer a feed-specific budget if defined; fall back to animals/household.
  const domainBudget =
    (budget && (budget.animalsFeed || budget.animals || budget.household)) ||
    {};

  const maxChars = domainBudget.maxChars || 18000;
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
      reason: "input_too_large_for_animals_feed_budget",
    };
  }

  return { ok: true };
}

/**
 * Resolve Reasoner mode for a feed optimizer request via modes/map.js.
 *
 * @param {ShimRequest} req
 * @param {Object} context
 * @returns {string}
 */
function resolveShimMode(req, context) {
  return (
    resolveMode({
      domain: "animals",
      intent: req.intent,
      context,
      runtime: req.runtime || {},
      source: SHIM_SOURCE,
    }) ||
    req.intent ||
    "animals.feed.planCoverage"
  );
}

/**
 * Optionally compose Sessions from Reasoner output.
 *
 * Expected normalized payload shape (example, documented via schemas):
 *
 * {
 *   feedPlan: {
 *     coverage: {...},
 *     rations: [...],
 *     rotation: [...],
 *     sourcing: {...},
 *     inventorySync: {...},
 *     notes: string[]
 *   },
 *   sessionsDraft?: [
 *     {
 *       title: "Evening Feeding – Layer Hens",
 *       domain: "animals",
 *       sourceType: "manual" | "import",
 *       refId: "feed:layers:evening",
 *       stepsDraft: [...]
 *     }
 *   ]
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
    domain: "animals",
    drafts,
    source: {
      type: normalizedData.sourceType || "manual",
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
 * Export feed plan + sessions to Hub if familyFundMode is enabled.
 *
 * @param {Array<Object>} sessions
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<void>}
 */
async function maybeExportToHub(sessions, normalizedData, req, debug) {
  if (!familyFundMode) return;

  const packets = HubPacketFormatter.fromFeedPlan({
    domain: "animals",
    sessions,
    plan: normalizedData,
    runtime: req.runtime || {},
    mode: req.intent,
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
      domain: "animals",
      origin: "FeedOptimizerShim",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main Feed Optimizer shim entry point.
 *
 * It does NOT perform the math/logic itself; instead it:
 *  - checks budget/gating,
 *  - loads context from selectors.js,
 *  - runs guard checks,
 *  - resolves Reasoner mode,
 *  - uses memoization + freshness,
 *  - builds prompts & calls Reasoner,
 *  - validates against mode schema,
 *  - evaluates confidence,
 *  - composes Sessions (optional),
 *  - optionally exports to the Hub,
 *  - returns a ShimResponse.
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

    const domain = req.domain || "animals";
    if (domain !== "animals") {
      warnings.push({
        type: "domain.mismatch",
        expected: "animals",
        got: domain,
      });
    }

    const intent = req.intent || "animals.feed.planCoverage";
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
    const budgetCheck = enforceBudget(
      { domain, intent, input, runtime },
      debug
    );
    if (!budgetCheck.ok) {
      warnings.push({
        type: "budget.blocked",
        reason: budgetCheck.reason,
      });
      return buildErrorResponse(budgetCheck.reason, "none", undefined, debug);
    }

    const allowed = canInvokeReasoner({
      domain: "animals",
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
    //    Replaces direct herd/feed/pasture/inventory usage in old agent.
    // -------------------------------------------------
    const context = await selectAnimalsContext({
      intent,
      input,
      runtime,
      hint: "feedOptimizer",
    });

    debug.push({
      stage: "context.selected",
      keys: Object.keys(context || {}),
    });

    // -------------------------------------------------
    // 4. Guard evaluation (Sabbath, Quiet Hours, Weather, Inventory, Battery)
    // -------------------------------------------------
    const guardsResult = await evaluateGuards({
      domain: "animals",
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
          domain: "animals",
          intent,
          guards: guardsResult,
        },
      });

      return buildShimResponse(
        true,
        "animals.feed.guarded.noop",
        {
          guards: guardsResult,
          note: "Feed optimization / planning blocked by guard conditions.",
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
    const memoKey = buildAnimalsFeedMemoKey({
      mode,
      intent,
      input,
      context,
      runtime,
      scope: "feedOptimizer",
    });

    const cached = await getMemo(memoKey);

    if (cached) {
      const isFresh = applyFreshnessRules({
        domain: "animals",
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
            domain: "animals",
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
        domain: "animals",
        mode,
        intent,
        memoKey,
      },
    });

    // -------------------------------------------------
    // 7. Prompt construction
    // -------------------------------------------------
    const systemPrompt = getSystemPrompt("animals");
    const prompt = buildAnimalsPrompt({
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
        domain: "animals",
        mode,
        intent,
        runtime,
      },
    });

    const rawOutput = await invokeReasoner({
      domain: "animals",
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
      domain: "animals",
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
          domain: "animals",
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
        domain: "animals",
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
      domain: "animals",
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
    // 11. Optional: compose Sessions (feeding / mixing / rotation)
    // -------------------------------------------------
    const sessions = await maybeComposeSessions(
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // Session lifecycle events are handled by SessionRunner, not by the shim.

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
    await maybeExportToHub(
      sessions,
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // -------------------------------------------------
    // 14. Final response
    // -------------------------------------------------
    const data = {
      feedPlan: normalized, // whatever your animals.feed.* schema defines: coverage, rations, rotation, sourcing, inventorySync, etc.
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
    domain: "animals",
    intent,
    input,
    runtime,
  });
}

/**
 * Plan coverage vs feed inventory (old: command "planCoverage").
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function planCoverage(payload = {}, runtime = {}) {
  return handleIntent("animals.feed.planCoverage", payload, runtime);
}

/**
 * Optimize rations by species & stage (old: "optimizeRations").
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function optimizeRations(payload = {}, runtime = {}) {
  return handleIntent("animals.feed.optimizeRations", payload, runtime);
}

/**
 * Generate pasture/grazing rotation schedule (old: "generateRotation").
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function generateRotation(payload = {}, runtime = {}) {
  return handleIntent("animals.feed.generateRotation", payload, runtime);
}

/**
 * Propose sourcing & substitutions (old: "sourceFeed").
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function sourceFeed(payload = {}, runtime = {}) {
  return handleIntent("animals.feed.sourceFeed", payload, runtime);
}

/**
 * Run a what-if scenario (old: "simulate").
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function simulateFeedScenario(payload = {}, runtime = {}) {
  return handleIntent("animals.feed.simulate", payload, runtime);
}

/**
 * Normalize feed deltas for inventoryAgent (old: "syncWithInventoryAgent").
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function syncWithInventoryAgent(payload = {}, runtime = {}) {
  return handleIntent("animals.feed.syncWithInventoryAgent", payload, runtime);
}

/* ------------------------------------------------------------------
 * Backward-compatible command router
 * ------------------------------------------------------------------ */

/**
 * Backward-compatible router for the old feedOptimizerAgent commands.
 *
 * Supported commands (mapped to new intents):
 *  - "planCoverage"            → animals.feed.planCoverage
 *  - "optimizeRations"         → animals.feed.optimizeRations
 *  - "generateRotation"        → animals.feed.generateRotation
 *  - "sourceFeed"              → animals.feed.sourceFeed
 *  - "simulate"                → animals.feed.simulate
 *  - "syncWithInventoryAgent"  → animals.feed.syncWithInventoryAgent
 *
 * @param {string} command
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}, runtime = {}) {
  switch (command) {
    case "planCoverage":
      return planCoverage(payload, runtime);
    case "optimizeRations":
      return optimizeRations(payload, runtime);
    case "generateRotation":
      return generateRotation(payload, runtime);
    case "sourceFeed":
      return sourceFeed(payload, runtime);
    case "simulate":
      return simulateFeedScenario(payload, runtime);
    case "syncWithInventoryAgent":
      return syncWithInventoryAgent(payload, runtime);
    default:
      return buildShimResponse(
        false,
        "animals.feed.unknownCommand",
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
 * Default export (for compatibility with `import FeedOptimizerAgent`)
 * ------------------------------------------------------------------ */

const FeedOptimizerShim = {
  id: "FeedOptimizerShim",
  invokeShim,
  handleCommand,
  planCoverage,
  optimizeRations,
  generateRotation,
  sourceFeed,
  simulateFeedScenario,
  syncWithInventoryAgent,
};

export default FeedOptimizerShim;
