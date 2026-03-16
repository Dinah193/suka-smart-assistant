// src/agents/shims/cleaningRoutineShim.js
// -----------------------------------------------------------------------------
// SSA Cleaning Routine Shim
// Replaces the old "CleaningRoutineAgent" that:
//   - Pulled zones/preferences/inventory from stores
//   - Applied Sabbath + energy/time window logic
//   - Created a daily cleaning session + visible draft
//   - Forwarded to TaskBoard + Calendar via AutomationBus
//   - Updated "last done" on chores
//
// New behavior:
//   - Delegates all planning/finalization/forwarding to centralized Reasoner
//   - Uses SSA contracts: budget, gating, confidence, freshness, memo cache
//   - Pulls context via selectors.js instead of direct stores
//   - Uses modes/map.js + schemas for validation
//   - Optionally composes SessionRunner sessions
//   - Optionally exports to Hub when familyFundMode is enabled
//
// Supported intents:
//   - "cleaning.plan.daily"    → generateDailyCleaningPlan
//   - "cleaning.forward"       → sendPlanToTasksAndCalendar
//   - "cleaning.finalize"      → finalizeCleaningSession
// -----------------------------------------------------------------------------

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

import budget from "@/reasoner/budget.js";
import { canInvokeReasoner } from "@/reasoner/gating";
import { evaluateConfidence } from "@/reasoner/confidence";
import { selectCleaningContext } from "@/reasoner/selectors";
import { applyFreshnessRules } from "@/reasoner/freshness";
import { getMemo, setMemo } from "@/reasoner/cache/memo";
import { buildCleaningMemoKey } from "@/reasoner/cache/keys";
import { resolveMode } from "@/reasoner/modes/map";
import { validateModeOutput } from "@/reasoner/modes/validate";
import { getSystemPrompt } from "@/reasoner/prompts/system";
import { buildCleaningPrompt } from "@/reasoner/prompts/templates";
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

const SHIM_SOURCE = "agents/shims/cleaningRoutine";
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
 * Enforce budget constraints using budget.json for cleaning routines.
 * This replaces all local heuristics around "heavy" requests.
 *
 * @param {ShimRequest} reqLike
 * @param {Array<Object>} debug
 * @returns {{ ok: boolean, reason?: string }}
 */
function enforceBudget(reqLike, debug) {
  const domainBudget =
    (budget &&
      (budget.cleaningRoutine || budget.cleaning || budget.household)) ||
    {};

  const maxChars = domainBudget.maxChars || 20000;
  const estimateSize = JSON.stringify(reqLike.input || {}).length;

  debug.push({
    stage: "budget.check",
    maxChars,
    estimateSize,
  });

  if (estimateSize > maxChars) {
    return {
      ok: false,
      reason: "input_too_large_for_cleaningRoutine_budget",
    };
  }

  return { ok: true };
}

/**
 * Resolve Reasoner mode for a cleaning routine request.
 *
 * @param {ShimRequest} req
 * @param {Object} context
 * @returns {string}
 */
function resolveShimMode(req, context) {
  return (
    resolveMode({
      domain: "cleaning",
      intent: req.intent,
      context,
      runtime: req.runtime || {},
      source: SHIM_SOURCE,
    }) || "cleaning.plan.daily"
  );
}

/**
 * Compose sessions from a routine/plan output if drafts are present.
 * The Reasoner output is expected (for daily plans / forwards) to
 * include something like:
 *
 *  {
 *    sessionsDraft: [
 *      {
 *        title: "Kitchen + Common Areas daily",
 *        domain: "cleaning",
 *        // ...step drafts...
 *      }
 *    ],
 *    // ...other plan metadata...
 *  }
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
    domain: "cleaning",
    drafts,
    source: {
      type: normalizedData.sourceType || "cleaningPlan",
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
 * Export plan/session info to Hub if familyFundMode is enabled.
 *
 * @param {Array<Object>} sessions
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<void>}
 */
async function maybeExportToHub(sessions, normalizedData, req, debug) {
  if (!familyFundMode) return;

  const packets = HubPacketFormatter.fromCleaningPlan({
    domain: "cleaning",
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
      domain: "cleaning",
      origin: "CleaningRoutineShim",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main Cleaning Routine shim.
 *
 * Intents this shim expects (but you can add more via modes/map.js):
 *
 *   - "cleaning.plan.daily"
 *       Input example:
 *       {
 *         userCtx: {
 *           zones?: ...,
 *           preferences?: {
 *             sabbath?: "hebrew-7" | "saturday",
 *             energy?: "low" | "moderate" | "high",
 *             availableMinutes?: number,
 *             tz?: string
 *           },
 *           // etc.
 *         }
 *       }
 *
 *   - "cleaning.forward"
 *       Input example:
 *       {
 *         plan: { ... },     // daily plan JSON
 *         forward: {
 *           toTasks?: boolean,
 *           toCalendar?: boolean,
 *           requireApproval?: boolean
 *         }
 *       }
 *
 *   - "cleaning.finalize"
 *       Input example:
 *       {
 *         plan: { ... },     // completed plan JSON
 *         completionMeta?: { ... }
 *       }
 *
 * Reasoner is responsible for:
 *   - Sabbath & quiet-hours awareness
 *   - Energy/time-window scheduling
 *   - Multi-timer-friendly steps
 *   - Homemade cleaning supplies & shortages
 *   - Visible draft markdown + JSON
 *   - Forwarding instructions hooks (no direct bus/calendar calls here)
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

    const domain = req.domain || "cleaning";
    if (domain !== "cleaning") {
      warnings.push({
        type: "domain.mismatch",
        expected: "cleaning",
        got: domain,
      });
    }

    const intent = req.intent || "cleaning.plan.daily";
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
      domain: "cleaning",
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
    //    This replaces the old _useCleaningStore/_useInventoryStore/_useCalendarStore
    // -------------------------------------------------
    const context = await selectCleaningContext({
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
      domain: "cleaning",
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
          domain: "cleaning",
          intent,
          guards: guardsResult,
        },
      });

      // For routine planning, a "noop" result is acceptable when blocked.
      return buildShimResponse(
        true,
        "cleaning.guarded.noop",
        {
          guards: guardsResult,
          note: "Cleaning routine action blocked by guard conditions.",
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
    const memoKey = buildCleaningMemoKey({
      mode,
      intent,
      input,
      context,
      runtime,
    });

    const cached = await getMemo(memoKey);

    if (cached) {
      const isFresh = applyFreshnessRules({
        domain: "cleaning",
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
            domain: "cleaning",
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
        domain: "cleaning",
        mode,
        intent,
        memoKey,
      },
    });

    // -------------------------------------------------
    // 7. Prompt construction
    // -------------------------------------------------
    const systemPrompt = getSystemPrompt("cleaning");
    const prompt = buildCleaningPrompt({
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
        domain: "cleaning",
        mode,
        intent,
        runtime,
      },
    });

    const rawOutput = await invokeReasoner({
      domain: "cleaning",
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
    //    (using modes/schemas.md + cleaning.*.schema.json behind validateModeOutput)
    // -------------------------------------------------
    const validation = await validateModeOutput({
      domain: "cleaning",
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
          domain: "cleaning",
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
        domain: "cleaning",
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
      domain: "cleaning",
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
    // 11. Compose sessions (if provided by Reasoner)
    //     e.g., for "cleaning.plan.daily" and "cleaning.forward"
    // -------------------------------------------------
    const sessions = await maybeComposeSessions(
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // Session lifecycle events (session.started / step.changed / etc.)
    // are handled by SessionRunner when those sessions actually run.

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
 * Thin intent wrappers (shim-backed public API)
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
    domain: "cleaning",
    intent,
    input,
    runtime,
  });
}

/**
 * Generate a daily cleaning plan.
 * Replaces the old generateDailyCleaningPlan(userCtx).
 *
 * @param {Object} userCtx
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function generateDailyCleaningPlan(userCtx = {}, runtime = {}) {
  // Old agent: planWithLLM(userCtx) → { ok, plan, supplies, draft, ... }
  // New shim: Reasoner mode "cleaning.plan.daily" produces that same structure
  // under response.data.planner.
  return handleIntent("cleaning.plan.daily", { userCtx }, runtime);
}

/**
 * Forward plan to tasks and calendar.
 * Replaces sendPlanToTasksAndCalendar(userCtx).
 *
 * You can:
 *  - Call with a userCtx to let the Reasoner both plan & forward
 *  - Call with an already-built plan (e.g., planner.plan)
 *
 * @param {Object} payload
 *   Example:
 *   { userCtx: {...} } OR { plan: {...}, forward: { toTasks: true, toCalendar: true } }
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function sendPlanToTasksAndCalendar(payload = {}, runtime = {}) {
  // Old agent: generateDailyCleaningPlan → toTaskBoard + toCalendar.
  // New shim: Reasoner intent "cleaning.forward" emits hooks for
  // automation runtime to attach tasks/calendar entries (no direct bus here).
  return handleIntent("cleaning.forward", payload, runtime);
}

/**
 * Finalize a cleaning session.
 * Replaces finalizeCleaningSession(plan).
 *
 * @param {Object} plan
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function finalizeCleaningSession(plan = {}, runtime = {}) {
  // Old agent: markCompleted(plan) via CleaningStore.
  // New shim: Reasoner intent "cleaning.finalize" will decide what deltas
  // to apply; automation runtime / selectors handle actual persistence.
  return handleIntent("cleaning.finalize", { plan }, runtime);
}

/* ------------------------------------------------------------------
 * Pure helper: suggestMakeBuyActions (retained)
 * ------------------------------------------------------------------ */

/**
 * Suggest "make or buy" actions based on shortages.
 * This is kept as a pure helper, identical to the old agent behavior.
 *
 * @param {Array<Object>} shortages
 * @returns {Array<Object>}
 */
export function suggestMakeBuyActions(shortages = []) {
  const uid = (prefix = "id") =>
    `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
  if (!Array.isArray(shortages) || !shortages.length) return [];
  return shortages.map((s) => ({
    id: uid("mb"),
    type: "make_or_buy",
    title: `Resolve shortage: ${s.name}`,
    detail: `Needed ${s.need}${s.unit}, have ${s.have}${s.unit} (for ${s.recipe})`,
    options: [
      { label: "Make now", action: "MAKE", payload: { key: s.key } },
      {
        label: "Add to shopping list",
        action: "BUY",
        payload: { key: s.key, qty: s.need - s.have, unit: s.unit },
      },
    ],
  }));
}

/* ------------------------------------------------------------------
 * Default export (for compatibility with old imports)
 * ------------------------------------------------------------------ */

const CleaningRoutineShim = {
  id: "CleaningRoutineAgent", // preserve old id for compatibility
  invokeShim,
  generateDailyCleaningPlan,
  sendPlanToTasksAndCalendar,
  finalizeCleaningSession,
  suggestMakeBuyActions,
};

export default CleaningRoutineShim;
