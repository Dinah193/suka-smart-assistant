// src/agents/shims/cookingStylesShim.js
// -----------------------------------------------------------------------------
// SSA Cooking Styles Shim
//
// Replaces the old "cookingStylesAgent" that used to:
//
//  - Load a JSON template and call callLLM directly to generate a style plan
//  - Pull preferences and sliders from CookingPrefsStore
//  - Apply slider/texture adjustments to the returned plan
//  - Emit automation events for draftReady, timers, bucket suggestions, etc.
//  - Learn from feedback and nudge CookingPrefsStore
//  - Drive UI timers and step events
//
// New behavior (SSA-compliant shim):
//  - Delegates all LLM + planning logic to the central Reasoner.
//  - Uses budget.json, gating, confidence, freshness, memo cache.
//  - Uses selectors.js to fetch cooking-style context (prefs, sliders, history).
//  - Uses modes/map.js + mode schemas for validation.
//  - Emits standardized reasoner.* and session.* export events via eventBus.
//  - Optionally composes Sessions from style plans and exports to the Hub.
//
// High-level intents:
//
//   "cooking.style.generate"        ← old generateStyle()
//   "cooking.style.approveDraft"    ← old approveStyleDraft()
//   "cooking.style.startRun"        ← old startPlanRun()
//   "cooking.style.markStepComplete"← old markStepComplete()
//   "cooking.style.learnFeedback"   ← old learnFromFeedback()
//
// NOTE:
// - All UI wiring (timers/register, styles/draftReady, styles/approved, etc.)
//   now lives in the automation/runtime + SessionRunner layer, not the shim.
// - All direct CookingPrefsStore manipulation is now a Reasoner responsibility.
//
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

const SHIM_SOURCE = "agents/shims/cookingStyles";
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
 * Enforce budget constraints using budget.json for cooking styles.
 *
 * @param {ShimRequest} reqLike
 * @param {Array<Object>} debug
 * @returns {{ ok: boolean, reason?: string }}
 */
function enforceBudget(reqLike, debug) {
  const domainBudget =
    (budget && (budget.cookingStyles || budget.cooking || budget.household)) || {};

  const maxChars = domainBudget.maxChars || 20000;
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
      reason: "input_too_large_for_cookingStyles_budget",
    };
  }

  return { ok: true };
}

/**
 * Resolve Reasoner mode for a cooking styles request via modes/map.js.
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
    }) || req.intent || "cooking.style.generate"
  );
}

/**
 * Optionally compose cooking sessions from Reasoner output.
 *
 * Expected payload shape from Reasoner (example):
 *
 * {
 *   stylePlan: {...},        // full style plan
 *   sessionsDraft: [
 *     {
 *       title: "House-style braise workflow",
 *       domain: "cooking",
 *       sourceType: "manual",
 *       refId: "style:bolognese:house",
 *       // stepsDraft, timing, etc...
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
    domain: "cooking",
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
 * Export cooking style plan/session info to Hub if familyFundMode is enabled.
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
    mode: req.intent, // typically a style intent
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
      origin: "CookingStylesShim",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main Cooking Styles shim.
 *
 * Intents:
 *
 *  - "cooking.style.generate"
 *      Input: {
 *        cuisine: string,
 *        dish?: string,
 *        constraints?: {...},
 *        inventoryHints?: string[],
 *        shoppingContext?: {...},
 *        now?: string
 *      }
 *      Output (schema-owned): {
 *        stylePlan: {...},        // full style JSON
 *        variants: {...},
 *        events?: {...},
 *        sessionsDraft?: [...],
 *        summary: string
 *      }
 *
 *  - "cooking.style.approveDraft"
 *  - "cooking.style.startRun"
 *  - "cooking.style.markStepComplete"
 *  - "cooking.style.learnFeedback"
 *
 * All detailed logic (template loading, slider adjustments, texture matrix,
 * feedback heuristics, timers, automation events) now lives with the Reasoner
 * and/or downstream SessionRunner + prefs pipeline, not in this shim.
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

    const intent = req.intent || "cooking.style.generate";
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
    //    Replaces direct CookingPrefsStore usage.
    // -------------------------------------------------
    const context = await selectCookingContext({
      intent,
      input,
      runtime,
      hint: "styles", // optional hint so selectors can load style-related prefs
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

      return buildShimResponse(
        true,
        "cooking.style.guarded.noop",
        {
          guards: guardsResult,
          note: "Cooking style action blocked by guard conditions.",
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
      scope: "styles",
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
    //    We reuse the generic cooking prompt builder; it should
    //    branch internally on mode (style vs non-style).
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

    // Session start/step/complete events are emitted by SessionRunner,
    // not this shim.

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
    // 13. Optional Hub export (for familyFundMode)
    // -------------------------------------------------
    await maybeExportToHub(sessions, normalized, { domain, intent, input, runtime }, debug);

    // -------------------------------------------------
    // 14. Final response
    // -------------------------------------------------
    const data = {
      style: normalized,
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
 * Generate a cooking style plan (tradition-first, with variants).
 * Replaces generateStyle().
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function generateStyle(payload = {}, runtime = {}) {
  return handleIntent("cooking.style.generate", payload, runtime);
}

/**
 * Approve a generated style draft (orthodox/house/quick) so that
 * downstream modules can persist and schedule it.
 * Replaces approveStyleDraft().
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function approveStyleDraft(payload = {}, runtime = {}) {
  return handleIntent("cooking.style.approveDraft", payload, runtime);
}

/**
 * Start running a style plan (used when the user chooses to cook
 * a given variant now).
 * Replaces startPlanRun().
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function startPlanRun(payload = {}, runtime = {}) {
  return handleIntent("cooking.style.startRun", payload, runtime);
}

/**
 * Mark a specific step in the style plan complete.
 * Replaces markStepComplete().
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function markStepComplete(payload = {}, runtime = {}) {
  return handleIntent("cooking.style.markStepComplete", payload, runtime);
}

/**
 * Learn from user feedback and nudge the cooking style profile
 * and sliders accordingly.
 * Replaces learnFromFeedback().
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function learnFromFeedback(payload = {}, runtime = {}) {
  return handleIntent("cooking.style.learnFeedback", payload, runtime);
}

/* ------------------------------------------------------------------
 * Backward-compatible command router (like old agent.handleCommand)
 * ------------------------------------------------------------------ */

/**
 * Backward-compatible router (if you previously used a command-based API).
 *
 * @param {string} command
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}, runtime = {}) {
  switch (command) {
    case "generateStyle":
      return generateStyle(payload, runtime);
    case "approveStyleDraft":
      return approveStyleDraft(payload, runtime);
    case "startPlanRun":
      return startPlanRun(payload, runtime);
    case "markStepComplete":
      return markStepComplete(payload, runtime);
    case "learnFromFeedback":
      return learnFromFeedback(payload, runtime);
    default:
      return buildShimResponse(
        false,
        "cooking.style.unknownCommand",
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

const CookingStylesShim = {
  id: "CookingStylesAgent",
  invokeShim,
  handleCommand,
  generateStyle,
  approveStyleDraft,
  startPlanRun,
  markStepComplete,
  learnFromFeedback,
};

export default CookingStylesShim;
