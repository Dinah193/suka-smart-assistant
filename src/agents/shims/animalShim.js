// src/agents/shims/animalShim.js
// -------------------------------------------------------------
// SSA Animal Shim
// - Thin, defensive wrapper around the Reasoner for animal domain
// - Replaces legacy animalAgent/AnimalAgent logic
// - No UI, no timers, no global mutable state
// -------------------------------------------------------------

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

import budget from "@/reasoner/budget.js";
import { canInvokeReasoner } from "@/reasoner/gating";
import { evaluateConfidence } from "@/reasoner/confidence";
import { selectAnimalContext } from "@/reasoner/selectors";
import { applyFreshnessRules } from "@/reasoner/freshness";
import { getMemo, setMemo } from "@/reasoner/cache/memo";
import { buildAnimalMemoKey } from "@/reasoner/cache/keys";
import { resolveMode } from "@/reasoner/modes/map";
import { validateModeOutput } from "@/reasoner/modes/validate";
import { getSystemPrompt } from "@/reasoner/prompts/system";
import { buildAnimalPrompt } from "@/reasoner/prompts/templates";
import { invokeReasoner } from "@/reasoner/core";

import { evaluateGuards } from "@/agents/skills/sessions/guardsEvaluate";

import { composeSessionsFromAnimalPlan } from "@agents/skills/sessions/compose";

import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} intent                // e.g. "planFeeding", "generateBreedingSchedule", "planFromGoal"
 * @property {Object} input                 // Caller-provided payload (livestockInventory, feedInventory, goals, etc.)
 * @property {Object} [runtime]             // Optional runtime hints (userId, locale, requestId, etc.)
 */

/**
 * @typedef {Object} ShimResponse
 * @property {boolean} ok
 * @property {string} mode                  // Resolved Reasoner mode, e.g. "animals.plan.fromGoal"
 * @property {Object} data                  // Normalized data from Reasoner/schema
 * @property {Array<Object>} [warnings]     // Non-fatal issues
 * @property {Array<Object>} [debug]        // Debug breadcrumbs (for logs/DevTools)
 */

const SHIM_SOURCE = "agents/shims/animals";

const isoNow = () => new Date().toISOString();

/**
 * Build a standard ShimResponse object.
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
 * Build an error-shaped ShimResponse with minimal leakage.
 * @param {string} reason
 * @param {string} [mode]
 * @param {Error} [err]
 * @param {Array<Object>} [debug]
 * @returns {ShimResponse}
 */
function buildErrorResponse(reason, mode = "none", err, debug = []) {
  const base = {
    reason,
  };

  const data = err
    ? {
        ...base,
        error: {
          message: err.message || String(err),
          name: err.name || "Error",
        },
      }
    : base;

  return buildShimResponse(
    false,
    mode,
    data,
    [{ type: "error", reason }],
    debug
  );
}

/**
 * Enforce a simple, defensive "budget" heuristic using budget.json.
 * NOTE: Token/time enforcement is mostly advisory here; hard limits should
 * be enforced in the Reasoner itself. We short-circuit obvious excess.
 *
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {{ok: boolean, reason?: string}}
 */
function enforceBudget(req, debug) {
  const domainBudget = (budget && budget.animals) || {};
  const maxChars = domainBudget.maxChars || 12000;

  const sizeEstimate = JSON.stringify(req.input || {}).length;
  debug.push({
    stage: "budget.check",
    maxChars,
    sizeEstimate,
  });

  if (sizeEstimate > maxChars) {
    return {
      ok: false,
      reason: "input_too_large_for_budget",
    };
  }

  return { ok: true };
}

/**
 * Map legacy "command" style to shim intents.
 * (Useful for small backward-compatible wrappers below.)
 *
 * @param {string} command
 * @returns {string}
 */
function mapCommandToIntent(command) {
  if (!command) return "unknown";

  const cmd = String(command).trim();

  const lookup = {
    updateInventory: "animals.updateInventory",
    planFeeding: "animals.planFeeding",
    generateBreedingSchedule: "animals.generateBreedingSchedule",
    trackHealth: "animals.trackHealth",
    planButchering: "animals.planButchering",
    calculateFertilizer: "animals.calculateFertilizer",
    planFromGoal: "animals.planFromGoal",
  };

  return lookup[cmd] || cmd;
}

/**
 * Derive a Reasoner mode for this shim request.
 * Delegates to the global modes/map.js with a lightweight adapter.
 *
 * @param {ShimRequest} req
 * @param {Object} context
 * @returns {string}
 */
function resolveShimMode(req, context) {
  return (
    resolveMode({
      domain: req.domain,
      intent: req.intent,
      context,
      runtime: req.runtime || {},
      source: SHIM_SOURCE,
    }) || "animals.plan.generic"
  );
}

/**
 * Optionally compose sessions from Reasoner output and persist them.
 * This shim does *not* start or time sessions; it only prepares them.
 *
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<Array<Object>>}
 */
async function maybeComposeSessions(normalizedData, req, debug) {
  // Assume the Reasoner returns something like { sessionsDraft?: [...] }
  const drafts = normalizedData && normalizedData.sessionsDraft;
  if (!Array.isArray(drafts) || !drafts.length) {
    return [];
  }

  const sessions = await composeSessionsFromAnimalPlan({
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

  // Persistence is handled inside composeSessionsFromAnimalPlan / sessions store.
  return Array.isArray(sessions) ? sessions : [];
}

/**
 * Optionally export sessions/plan to Family Fund Hub if familyFundMode is enabled.
 *
 * @param {Array<Object>} sessions
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<void>}
 */
async function maybeExportToHub(sessions, normalizedData, req, debug) {
  if (!familyFundMode) return;

  const packets = HubPacketFormatter.fromAnimalsPlan({
    domain: "animals",
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
      domain: "animals",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main shim entry point.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const debug = [];
  const warnings = [];

  try {
    // -------------------------------
    // 1. Basic request validation
    // -------------------------------
    if (!req || typeof req !== "object") {
      return buildErrorResponse("invalid_request", "none", undefined, debug);
    }

    const domain = req.domain;
    if (domain !== "animals") {
      warnings.push({
        type: "domain.mismatch",
        expected: "animals",
        got: domain,
      });
    }

    const intent = req.intent || "animals.planFromGoal";
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

    // -------------------------------
    // 2. Budget + gating
    // -------------------------------
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

    // -------------------------------
    // 3. Context selection
    // -------------------------------
    const context = await selectAnimalContext({
      intent,
      input,
      runtime,
    });

    debug.push({
      stage: "context.selected",
      keys: Object.keys(context || {}),
    });

    // -------------------------------
    // 4. Guards (Sabbath, Quiet Hours, Weather, Inventory, Battery)
    // -------------------------------
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
        "animals.guarded.noop",
        {
          guards: guardsResult,
          note: "Operation blocked by guard conditions (Sabbath/quiet hours/weather/inventory/battery).",
        },
        warnings,
        debug
      );
    }

    // -------------------------------
    // 5. Mode resolution
    // -------------------------------
    const mode = resolveShimMode({ domain, intent, input, runtime }, context);

    debug.push({
      stage: "mode.resolved",
      mode,
    });

    // -------------------------------
    // 6. Cache / memoization
    // -------------------------------
    const memoKey = buildAnimalMemoKey({
      mode,
      intent,
      input,
      context,
      runtime,
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

    // -------------------------------
    // 7. Prompt construction
    // -------------------------------
    const systemPrompt = getSystemPrompt("animals");

    const prompt = buildAnimalPrompt({
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

    // -------------------------------
    // 8. Reasoner invocation
    // -------------------------------
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

    // -------------------------------
    // 9. Schema validation + normalization
    // -------------------------------
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

    // -------------------------------
    // 10. Confidence evaluation
    // -------------------------------
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

    // -------------------------------
    // 11. Compose sessions + persist
    // -------------------------------
    const sessions = await maybeComposeSessions(
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // Note: We do NOT emit session.started here; SessionRunner will handle
    // lifecycle events once the user actually runs these sessions.

    // -------------------------------
    // 12. Cache / memo store
    // -------------------------------
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

    // -------------------------------
    // 13. Optional Hub export (Family Fund)
    // -------------------------------
    await maybeExportToHub(
      sessions,
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // -------------------------------
    // 14. Final response
    // -------------------------------
    const data = {
      plan: normalized,
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
 * Backward-compatible thin wrappers
 * ------------------------------------------------------------------ */

/**
 * Legacy-style "command" handler → wraps into a ShimRequest and calls invokeShim.
 *
 * @param {string} command                    // e.g. "planFeeding"
 * @param {Object} payload                    // Same payload old handleAnimalCommand expected
 * @param {Object} [runtime]                  // Optional runtime (userId, locale, etc.)
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}, runtime = {}) {
  const intent = mapCommandToIntent(command);

  return invokeShim({
    domain: "animals",
    intent,
    input: payload,
    runtime,
  });
}

/**
 * Legacy-style "animalAgent" call that primarily mapped a "userGoal" to a plan.
 * This now just redirects to the generic animals.planFromGoal intent.
 *
 * @param {Object} params
 * @param {Array<Object>} [params.livestockInventory]
 * @param {Array<Object>} [params.feedInventory]
 * @param {string} [params.userGoal]
 * @param {Object} [params.settings]
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function animalAgent(params = {}, runtime = {}) {
  const {
    livestockInventory = [],
    feedInventory = [],
    userGoal = "",
    settings = {},
  } = params;

  const input = {
    livestockInventory,
    feedInventory,
    userGoal,
    settings,
  };

  return invokeShim({
    domain: "animals",
    intent: "animals.planFromGoal",
    input,
    runtime,
  });
}

export default {
  invokeShim,
  handleCommand,
  animalAgent,
};
