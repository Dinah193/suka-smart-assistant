// src/agents/shims/cleaningShim.js
// -----------------------------------------------------------------------------
// SSA Cleaning Shim
// - Replaces the old "cleaningAgent" that built 7-day plans locally and
//   called callLLM directly.
// - Delegates to Reasoner modes for:
//     • 7-day cleaning planning
//     • weekly/biweekly/daily routines
//     • seasonal routines (Spring, Summer, Fall, Winter)
//     • monthly routines
//     • custom-timeframe routines (date range or day-span)
//     • next-task suggestions
//     • label rewriting
//     • dashboard snapshots
//     • plan-from-prompt parsing
//
// - Integrates with SSA runtime:
//     • budget.json enforcement
//     • gating, confidence, freshness, memo cache
//     • Dexie-backed context via selectors
//     • guards (Sabbath, Quiet Hours, Weather, Inventory, Battery)
//     • sessions composition for SessionRunner
//     • optional Hub export in familyFundMode
//
// - Provides backward-compatible command wrappers:
//     generatePlan, buildCleaningRoutine, suggestNextTask,
//     rewriteLabels, getDashboard, planFromPrompt,
//     buildSeasonalRoutine, buildMonthlyRoutine, buildCustomRoutine,
//     plus a CleaningAgent class for registries.
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

const SHIM_SOURCE = "agents/shims/cleaning";
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
  const payload = err
    ? {
        reason,
        error: {
          message: err.message || String(err),
          name: err.name || "Error",
        },
      }
    : { reason };

  return buildShimResponse(
    false,
    mode,
    payload,
    [{ type: "error", reason }],
    debug
  );
}

/**
 * Enforce budget constraints using budget.json for cleaning.
 *
 * @param {ShimRequest} reqLike
 * @param {Array<Object>} debug
 * @returns {{ ok: boolean, reason?: string }}
 */
function enforceBudget(reqLike, debug) {
  const domainBudget =
    (budget &&
      (budget.cleaning || budget.household || budget["cleaning.plan"])) ||
    {};

  const maxChars = domainBudget.maxChars || 18000;
  const estimateSize = JSON.stringify(reqLike.input || {}).length;

  debug.push({
    stage: "budget.check",
    maxChars,
    estimateSize,
  });

  if (estimateSize > maxChars) {
    return {
      ok: false,
      reason: "input_too_large_for_cleaning_budget",
    };
  }

  return { ok: true };
}

/**
 * Map legacy CleaningAgent commands to Reasoner intents.
 *
 * We use this to keep handleCommand + thin wrapper functions aligned with
 * centralized Reasoner modes.
 *
 * @param {string} command
 * @returns {string}
 */
function mapCommandToIntent(command) {
  if (!command) return "cleaning.plan.7day";

  const c = String(command).trim().toLowerCase();

  const map = {
    // 7-day plan (original generatePlan)
    generateplan: "cleaning.plan.7day",
    "generate-plan": "cleaning.plan.7day",

    // Generic weekly routine builder
    buildcleaningroutine: "cleaning.routine.build",
    "build-cleaning-routine": "cleaning.routine.build",

    // Seasonal routine
    buildseasonalroutine: "cleaning.routine.seasonal",
    "build-seasonal-routine": "cleaning.routine.seasonal",
    seasonalroutine: "cleaning.routine.seasonal",
    "seasonal-routine": "cleaning.routine.seasonal",

    // Monthly routine
    buildmonthlyroutine: "cleaning.routine.monthly",
    "build-monthly-routine": "cleaning.routine.monthly",
    monthlyroutine: "cleaning.routine.monthly",
    "monthly-routine": "cleaning.routine.monthly",

    // Custom timeframe routines (date range or day-span)
    buildcustomroutine: "cleaning.routine.customRange",
    "build-custom-routine": "cleaning.routine.customRange",
    customroutine: "cleaning.routine.customRange",
    "custom-routine": "cleaning.routine.customRange",

    // Task helpers
    suggestnexttask: "cleaning.tasks.suggestNext",
    "suggest-next-task": "cleaning.tasks.suggestNext",

    // Label helpers
    rewritelabels: "cleaning.labels.rewrite",
    "rewrite-labels": "cleaning.labels.rewrite",

    // Dashboard
    getdashboard: "cleaning.dashboard.snapshot",
    "get-dashboard": "cleaning.dashboard.snapshot",

    // Freeform prompt → plan
    planfromprompt: "cleaning.plan.fromPrompt",
    "plan-from-prompt": "cleaning.plan.fromPrompt",
  };

  return map[c] || c;
}

/**
 * Resolve Reasoner mode for this cleaning request.
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
    }) || "cleaning.generic"
  );
}

/**
 * Compose sessions from a cleaning plan output, if drafts are present.
 * Expected Reasoner shape: { sessionsDraft: [...] }
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
      type:
        normalizedData.sourceType ||
        // allow seasonal/monthly/custom to declare their own type
        (normalizedData.timeframeType === "seasonal"
          ? "cleaningPlan"
          : normalizedData.timeframeType === "monthly"
          ? "cleaningPlan"
          : "cleaningPlan"),
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
 * Export cleaning planner outputs/sessions to Family Fund Hub if enabled.
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
      origin: "cleaningAgent",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main Cleaning shim entry point.
 *
 * NOTE: For seasonal/monthly/custom routines, Reasoner should interpret:
 *  - input.timeframe.type: "seasonal" | "monthly" | "customRange"
 *  - input.timeframe.season?: "spring" | "summer" | "fall" | "winter"
 *  - input.timeframe.month?: "YYYY-MM"
 *  - input.timeframe.range?: { startISO: string, endISO: string }
 *  - input.timeframe.days?: number
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

    const intent = req.intent || "cleaning.plan.7day";
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
      timeframe: input.timeframe || null,
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

      return buildShimResponse(
        true,
        "cleaning.guarded.noop",
        {
          guards: guardsResult,
          note: "Cleaning operation blocked by guard conditions.",
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
    // 11. Compose sessions from cleaning output (if provided)
    // -------------------------------------------------
    const sessions = await maybeComposeSessions(
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // Session lifecycle events (started/paused/etc.) are emitted by SessionRunner.

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
 * Backward-compatible thin wrappers
 * ------------------------------------------------------------------ */

/**
 * Legacy-style command API → wraps into ShimRequest and calls invokeShim.
 *
 * @param {string} command
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}, runtime = {}) {
  const intent = mapCommandToIntent(command);

  return invokeShim({
    domain: "cleaning",
    intent,
    input: payload || {},
    runtime,
  });
}

// ------- Original-style helper wrappers, now shim-backed ---------

/**
 * 7-day cleaning plan (original generateCleaningPlan).
 * Expects payload similar to:
 * { zones, userTools, sessionSettings }
 */
export async function generatePlan(options = {}, runtime = {}) {
  return handleCommand("generatePlan", options, runtime);
}

/**
 * Weekly/recurring routine builder (original buildCleaningRoutine).
 */
export async function buildCleaningRoutine(options = {}, runtime = {}) {
  return handleCommand("buildCleaningRoutine", options, runtime);
}

/**
 * Suggest the next best cleaning task from a list.
 * { taskLabels: string[] }
 */
export async function suggestNextTask(options = {}, runtime = {}) {
  return handleCommand("suggestNextTask", options, runtime);
}

/**
 * Rewrite cleaning task labels.
 * { labels: string[] }
 */
export async function rewriteLabels(options = {}, runtime = {}) {
  return handleCommand("rewriteLabels", options, runtime);
}

/**
 * Dashboard snapshot (quick wins, deep clean focus, etc.).
 */
export async function getDashboard(options = {}, runtime = {}) {
  return handleCommand("getDashboard", options, runtime);
}

/**
 * Plan from freeform cleaning prompt.
 * { promptText, dayOfWeek? }
 */
export async function planFromPrompt(options = {}, runtime = {}) {
  return handleCommand("planFromPrompt", options, runtime);
}

/**
 * Seasonal cleaning routine.
 *
 * Expected payload (the Reasoner can be more flexible, this is a baseline):
 * {
 *   season: "spring" | "summer" | "fall" | "winter",
 *   zones?: { ... },
 *   userTools?: { ... }
 * }
 */
export async function buildSeasonalRoutine(options = {}, runtime = {}) {
  return handleCommand("buildSeasonalRoutine", options, runtime);
}

/**
 * Monthly cleaning routine.
 *
 * Expected payload:
 * {
 *   month: "YYYY-MM",       // e.g., "2025-03"
 *   zones?: { ... },
 *   userTools?: { ... }
 * }
 */
export async function buildMonthlyRoutine(options = {}, runtime = {}) {
  return handleCommand("buildMonthlyRoutine", options, runtime);
}

/**
 * Custom timeframe cleaning routine.
 *
 * Expected payload shape (one of):
 * {
 *   timeframe: {
 *     type: "customRange",
 *     range: { startISO: string, endISO: string }
 *   },
 *   zones?: { ... },
 *   userTools?: { ... }
 * }
 * OR:
 * {
 *   timeframe: {
 *     type: "customRange",
 *     days: number
 *   },
 *   zones?: { ... },
 *   userTools?: { ... }
 * }
 */
export async function buildCustomRoutine(options = {}, runtime = {}) {
  return handleCommand("buildCustomRoutine", options, runtime);
}

/* ------------------------------------------------------------------
 * Class facade for registry compatibility
 * ------------------------------------------------------------------ */

export class CleaningAgent {
  /**
   * @param {Object} [opts]
   */
  constructor(opts = {}) {
    this.name = "cleaningAgent";
    this.version = "2.1.0-shim";
    this.opts = opts;
  }

  /**
   * Legacy entry: (command, payload) → ShimResponse
   * Mirrors old handleCommand interface but routes to the shim.
   *
   * Supported commands (case/format-insensitive):
   *  - "generatePlan"
   *  - "buildCleaningRoutine"
   *  - "suggestNextTask"
   *  - "rewriteLabels"
   *  - "getDashboard"
   *  - "planFromPrompt"
   *  - "buildSeasonalRoutine"
   *  - "buildMonthlyRoutine"
   *  - "buildCustomRoutine"
   *
   * @param {string} command
   * @param {Object} payload
   * @returns {Promise<ShimResponse>}
   */
  async handleCommand(command, payload = {}) {
    const normalized =
      typeof payload?.payload === "object" && !Object.keys(payload).length
        ? payload.payload
        : payload;

    const rt = this.opts.runtime || {};

    const c = (command || "").toString().trim().toLowerCase();

    if (c === "generateplan" || c === "generate-plan") {
      return generatePlan(normalized, rt);
    }
    if (c === "buildcleaningroutine" || c === "build-cleaning-routine") {
      return buildCleaningRoutine(normalized, rt);
    }
    if (c === "suggestnexttask" || c === "suggest-next-task") {
      return suggestNextTask(normalized, rt);
    }
    if (c === "rewritelabels" || c === "rewrite-labels") {
      return rewriteLabels(normalized, rt);
    }
    if (c === "getdashboard" || c === "get-dashboard") {
      return getDashboard(normalized, rt);
    }
    if (c === "planfromprompt" || c === "plan-from-prompt") {
      return planFromPrompt(normalized, rt);
    }
    if (
      c === "buildseasonalroutine" ||
      c === "build-seasonal-routine" ||
      c === "seasonalroutine" ||
      c === "seasonal-routine"
    ) {
      return buildSeasonalRoutine(normalized, rt);
    }
    if (
      c === "buildmonthlyroutine" ||
      c === "build-monthly-routine" ||
      c === "monthlyroutine" ||
      c === "monthly-routine"
    ) {
      return buildMonthlyRoutine(normalized, rt);
    }
    if (
      c === "buildcustomroutine" ||
      c === "build-custom-routine" ||
      c === "customroutine" ||
      c === "custom-routine"
    ) {
      return buildCustomRoutine(normalized, rt);
    }

    // Fallback: generic handler (still mapped via mapCommandToIntent)
    return handleCommand(command, normalized, rt);
  }
}

/**
 * Factory for registries that prefer an instance.
 *
 * @param {Object} opts
 * @returns {CleaningAgent}
 */
export function createAgent(opts) {
  return new CleaningAgent(opts);
}

/**
 * Default export: shim-based CleaningAgent utilities.
 */
export default {
  invokeShim,
  handleCommand,
  generatePlan,
  buildCleaningRoutine,
  suggestNextTask,
  rewriteLabels,
  getDashboard,
  planFromPrompt,
  buildSeasonalRoutine,
  buildMonthlyRoutine,
  buildCustomRoutine,
  CleaningAgent,
  createAgent,
};
