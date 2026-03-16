// src/agents/shims/cureCalcShim.js
// -----------------------------------------------------------------------------
// SSA Cure Calculation Shim
//
// This shim replaces the old cureCalc-style agent. Instead of directly
// calculating curing salt/brine formulas and interacting with UI/services,
// it now:
//
//  - Delegates cure/planning logic to the central Reasoner.
//  - Enforces budget.json, gating, confidence, freshness.
//  - Uses selectors.js to pull preservation context (inventory, meat cuts,
//    weight history, user safety prefs).
//  - Uses modes/map.js + schemas for validation.
//  - Optionally composes Sessions for preservation workflows.
//  - Optionally exports to the Family Fund Hub when familyFundMode is true.
//
// Recommended intents for this shim:
//   - "preservation.cure.compute"     ← compute basic cure (salt, sugar, nitrite)
//   - "preservation.cure.planSession" ← compute cure AND propose a session
//   - "preservation.cure.checkSafety" ← check safety (water activity, temp, time)
//
// -----------------------------------------------------------------------------

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

import budget from "@/reasoner/budget.js";
import { canInvokeReasoner } from "@/reasoner/gating";
import { evaluateConfidence } from "@/reasoner/confidence";
import { selectPreservationContext } from "@/reasoner/selectors";
import { applyFreshnessRules } from "@/reasoner/freshness";
import { getMemo, setMemo } from "@/reasoner/cache/memo";
import { buildPreservationMemoKey } from "@/reasoner/cache/keys";
import { resolveMode } from "@/reasoner/modes/map";
import { validateModeOutput } from "@/reasoner/modes/validate";
import { getSystemPrompt } from "@/reasoner/prompts/system";
import { buildPreservationPrompt } from "@/reasoner/prompts/templates";
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

const SHIM_SOURCE = "agents/shims/cureCalc";
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

  return buildShimResponse(
    false,
    mode,
    payload,
    [{ type: "error", reason }],
    debug
  );
}

/**
 * Enforce budget constraints using budget.json for preservation/cure flows.
 *
 * @param {ShimRequest} reqLike
 * @param {Array<Object>} debug
 * @returns {{ ok: boolean, reason?: string }}
 */
function enforceBudget(reqLike, debug) {
  const domainBudget =
    (budget &&
      (budget.preservationCure || budget.preservation || budget.household)) ||
    {};

  const maxChars = domainBudget.maxChars || 12000;
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
      reason: "input_too_large_for_preservation_cure_budget",
    };
  }

  return { ok: true };
}

/**
 * Resolve Reasoner mode for a cureCalc-style request via modes/map.js.
 *
 * @param {ShimRequest} req
 * @param {Object} context
 * @returns {string}
 */
function resolveShimMode(req, context) {
  return (
    resolveMode({
      domain: "preservation",
      intent: req.intent,
      context,
      runtime: req.runtime || {},
      source: SHIM_SOURCE,
    }) ||
    req.intent ||
    "preservation.cure.compute"
  );
}

/**
 * Optionally compose preservation Sessions from Reasoner output.
 *
 * Expected payload shape from Reasoner (example, documented in schemas):
 *
 * {
 *   curePlan: {
 *     input: { weightKg, cutType, saltPct, sugarPct, nitritePpm, method, ... },
 *     phases: [
 *       { id, title, desc, durationSec, environment, tempTargetF, blockers, ... }
 *     ],
 *     safety: {...},
 *     notes: string[]
 *   },
 *   sessionsDraft?: [
 *     {
 *       title: "Dry cure – pork belly",
 *       domain: "preservation",
 *       sourceType: "manual" | "import" | "recipe",
 *       refId: "cure:belly:dry",
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
    domain: "preservation",
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
 * Export cure plan + sessions to Hub if familyFundMode is enabled.
 *
 * @param {Array<Object>} sessions
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<void>}
 */
async function maybeExportToHub(sessions, normalizedData, req, debug) {
  if (!familyFundMode) return;

  const packets = HubPacketFormatter.fromPreservationPlan({
    domain: "preservation",
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
      domain: "preservation",
      origin: "CureCalcShim",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main Cure Calculation shim.
 *
 * Typical inputs for "preservation.cure.compute":
 *
 *  input: {
 *    cutType: "pork_belly" | "ham" | "beef_brisket" | "fish" | string,
 *    weight: {
 *      value: number,
 *      unit: "g" | "kg" | "lb"
 *    },
 *    method: "dry" | "equilibrium_brine" | "injection" | string,
 *    saltPct?: number,       // desired % of green weight
 *    sugarPct?: number,
 *    nitritePpm?: number,
 *    spices?: string[],
 *    environment?: {
 *      tempF?: number,
 *      humidityPct?: number
 *    }
 *  }
 *
 * The Reasoner schema for this mode should define exact fields.
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

    const domain = req.domain || "preservation";
    if (domain !== "preservation") {
      warnings.push({
        type: "domain.mismatch",
        expected: "preservation",
        got: domain,
      });
    }

    const intent = req.intent || "preservation.cure.compute";
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
      domain: "preservation",
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
    //    Replaces any direct cureCalc storage or prefs usage.
    // -------------------------------------------------
    const context = await selectPreservationContext({
      intent,
      input,
      runtime,
      hint: "cureCalc",
    });

    debug.push({
      stage: "context.selected",
      keys: Object.keys(context || {}),
    });

    // -------------------------------------------------
    // 4. Guard evaluation (Sabbath, Quiet Hours, Weather, Inventory, Battery)
    // -------------------------------------------------
    const guardsResult = await evaluateGuards({
      domain: "preservation",
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
          domain: "preservation",
          intent,
          guards: guardsResult,
        },
      });

      return buildShimResponse(
        true,
        "preservation.cure.guarded.noop",
        {
          guards: guardsResult,
          note: "Cure calculation/preservation action blocked by guard conditions.",
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
    const memoKey = buildPreservationMemoKey({
      mode,
      intent,
      input,
      context,
      runtime,
      scope: "cureCalc",
    });

    const cached = await getMemo(memoKey);

    if (cached) {
      const isFresh = applyFreshnessRules({
        domain: "preservation",
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
            domain: "preservation",
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
        domain: "preservation",
        mode,
        intent,
        memoKey,
      },
    });

    // -------------------------------------------------
    // 7. Prompt construction
    // -------------------------------------------------
    const systemPrompt = getSystemPrompt("preservation");
    const prompt = buildPreservationPrompt({
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
        domain: "preservation",
        mode,
        intent,
        runtime,
      },
    });

    const rawOutput = await invokeReasoner({
      domain: "preservation",
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
      domain: "preservation",
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
          domain: "preservation",
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
        domain: "preservation",
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
      domain: "preservation",
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
    // 11. Optional: compose Sessions
    // -------------------------------------------------
    const sessions = await maybeComposeSessions(
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // Session lifecycle events (session.started, etc.) live in SessionRunner.

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
      cure: normalized, // whatever schema defines: curePlan, safety, notes, etc.
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
    domain: "preservation",
    intent,
    input,
    runtime,
  });
}

/**
 * Compute cure formula for a given cut/weight/method.
 * (high-level equivalent of old cureCalc compute function)
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function computeCure(payload = {}, runtime = {}) {
  return handleIntent("preservation.cure.compute", payload, runtime);
}

/**
 * Compute cure + propose a preservation Session for SessionRunner.
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function planCureSession(payload = {}, runtime = {}) {
  return handleIntent("preservation.cure.planSession", payload, runtime);
}

/**
 * Check safety parameters (salt %, nitrite ppm, temp/time, water activity)
 * for a given cure plan.
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function checkCureSafety(payload = {}, runtime = {}) {
  return handleIntent("preservation.cure.checkSafety", payload, runtime);
}

/* ------------------------------------------------------------------
 * Backward-compatible command router (if old agent used commands)
 * ------------------------------------------------------------------ */

/**
 * Backward-compatible router.
 *
 * Supported commands (map to intents above):
 *  - "computeCure"
 *  - "planCureSession"
 *  - "checkCureSafety"
 *
 * @param {string} command
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}, runtime = {}) {
  switch (command) {
    case "computeCure":
      return computeCure(payload, runtime);
    case "planCureSession":
      return planCureSession(payload, runtime);
    case "checkCureSafety":
      return checkCureSafety(payload, runtime);
    default:
      return buildShimResponse(
        false,
        "preservation.cure.unknownCommand",
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
 * Default export (for compatibility with `import cureCalc from ...`)
 * ------------------------------------------------------------------ */

const CureCalcShim = {
  id: "CureCalcShim",
  invokeShim,
  handleCommand,
  computeCure,
  planCureSession,
  checkCureSafety,
};

export default CureCalcShim;
