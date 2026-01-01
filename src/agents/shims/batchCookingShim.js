// src/agents/shims/batchCookingAgent.js
// -----------------------------------------------------------------------------
// SSA Batch Cooking Shim
// - Replaces the old "BatchCookingAgent" logic-heavy agent
// - Delegates planning/simulation/commit/undo to the Reasoner
// - Handles budget, gating, guards, freshness, memoization, schemas
// - Optionally composes cooking sessions and exports to the Hub
// - Keeps thin backward-compatible wrappers: plan, simulate, commit, undo,
//   generateBatchCookingPlan, BatchCookingAgent class.
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

const SHIM_SOURCE = "agents/shims/batchCooking";
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
  const base = { reason };
  const data = err
    ? {
        ...base,
        error: {
          message: err.message || String(err),
          name: err.name || "Error",
        },
      }
    : base;

  return buildShimResponse(false, mode, data, [{ type: "error", reason }], debug);
}

/**
 * Enforce budget constraints using budget.json for cooking/batch-cooking.
 *
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {{ ok: boolean, reason?: string }}
 */
function enforceBudget(req, debug) {
  const domainBudget =
    (budget && (budget.cooking || budget.batchCooking || budget["cooking.batch"])) || {};
  const maxChars = domainBudget.maxChars || 20000;

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
 * Map legacy/agent commands to Reasoner intents for batch cooking.
 *
 * @param {string} command
 * @returns {string}
 */
function mapCommandToIntent(command) {
  if (!command) return "cooking.batch.plan";

  const cmd = String(command).trim().toLowerCase();

  const lookup = {
    plan: "cooking.batch.plan",
    simulate: "cooking.batch.simulate",
    commit: "cooking.batch.commit",
    undo: "cooking.batch.undo",
    generateplan: "cooking.batch.generatePlan",
    generatebatchcookingplan: "cooking.batch.generatePlan",
  };

  return lookup[cmd] || cmd;
}

/**
 * Resolve Reasoner mode for this batch-cooking request via modes/map.js.
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
    }) || "cooking.batch.generic"
  );
}

/**
 * Compose sessions from a batch-cooking output, if session drafts are present.
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
 * Export planner outputs/sessions to Family Fund Hub if enabled.
 *
 * @param {Array<Object>} sessions
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<void>}
 */
async function maybeExportToHub(sessions, normalizedData, req, debug) {
  if (!familyFundMode) return;

  const packets = HubPacketFormatter.fromBatchCookingPlan({
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
      origin: "batchCooking",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main Batch Cooking shim entry point.
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

    const intent = req.intent || "cooking.batch.plan";
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

      // Note: We return ok:true but no Reasoner work; caller can show a
      // "guarded" status instead of a hard error.
      return buildShimResponse(
        true,
        "cooking.batch.guarded.noop",
        {
          guards: guardsResult,
          note: "Batch cooking operation blocked by guard conditions.",
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
    // 11. Compose sessions from batch-cooking output
    // -------------------------------------------------
    const sessions = await maybeComposeSessions(
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // SessionRunner will emit session.started / session.step.changed / etc.
    // when these sessions are actually executed.

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
    // 13. Optional Hub export when appropriate
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
    domain: "cooking",
    intent,
    input: payload || {},
    runtime,
  });
}

/**
 * plan(...) wrapper
 * Previously: returned an "envelope" with scheduled/cleanup/toolTimeline.
 * Now: returns the full ShimResponse.
 *
 * @param {Object} options
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function plan(options = {}, runtime = {}) {
  return handleCommand("plan", options, runtime);
}

/**
 * simulate(...) wrapper
 * Previously: added Sabbath holds and LLM tips.
 * Now: Reasoner mode "cooking.batch.simulate" handles that.
 *
 * @param {Object} options
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function simulate(options = {}, runtime = {}) {
  return handleCommand("simulate", options, runtime);
}

/**
 * commit(...) wrapper
 * Previously: emitted calendar/add and returned undoToken.
 * Now: Reasoner + automation runtime should handle calendar & undo tokens;
 * this wrapper returns the ShimResponse.
 *
 * @param {Object} options
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function commit(options = {}, runtime = {}) {
  return handleCommand("commit", options, runtime);
}

/**
 * undo(...) wrapper
 *
 * @param {Object} options
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function undo(options = {}, runtime = {}) {
  return handleCommand("undo", options, runtime);
}

/**
 * generateBatchCookingPlan(...)
 * For callers that expect a *plain* plan object rather than a ShimResponse.
 *
 * Tries to map Reasoner output into a legacy-like shape:
 * {
 *   timeline,
 *   inventoryReport: { used, missing },
 *   toolSchedule,
 *   cleanupPlan,
 *   summaryNotes
 * }
 *
 * @param {Object} options
 * @param {Object} [runtime]
 * @returns {Promise<Object>}
 */
export async function generateBatchCookingPlan(options = {}, runtime = {}) {
  const res = await handleCommand("generatePlan", options, runtime);

  if (!res || !res.ok) {
    return {
      timeline: [],
      inventoryReport: { used: [], missing: [] },
      toolSchedule: {},
      cleanupPlan: [],
      summaryNotes: ["Batch cooking plan unavailable (shim error or Reasoner blocked)."],
    };
  }

  const planner = res.data && res.data.planner ? res.data.planner : res.data || {};

  return {
    timeline: planner.timeline || [],
    inventoryReport: planner.inventoryReport || { used: [], missing: [] },
    toolSchedule: planner.toolSchedule || {},
    cleanupPlan: planner.cleanupPlan || [],
    summaryNotes: planner.summaryNotes || [],
  };
}

/**
 * subscribe()
 * In the old agent, this wired UI nudges to runtime events.
 * In shim form, UI/event glue belongs elsewhere, so we provide
 * a no-op for backward compatibility.
 *
 * @returns {boolean}
 */
export function subscribe() {
  // Intentionally a no-op to keep shim free of UI/event wiring.
  return false;
}

/* ------------------------------------------------------------------
 * Class facade for registry compatibility
 * ------------------------------------------------------------------ */

export class BatchCookingAgent {
  /**
   * @param {Object} [opts]
   */
  constructor(opts = {}) {
    this.name = "batchCookingAgent";
    this.version = "2.0.0-shim";
    this.opts = opts;
  }

  /**
   * @param {string} command
   * @param {Object} payload
   * @returns {Promise<ShimResponse|Object>}
   */
  async handleCommand(command, payload = {}) {
    const normalized = typeof payload?.payload === "object" && !Object.keys(payload).length
      ? payload.payload
      : payload;

    // Keep same mapping as mapCommandToIntent
    if (!command) return handleCommand("plan", normalized, this.opts.runtime || {});
    const c = String(command || "").trim().toLowerCase();

    if (c === "plan") return plan(normalized, this.opts.runtime || {});
    if (c === "simulate") return simulate(normalized, this.opts.runtime || {});
    if (c === "commit") return commit(normalized, this.opts.runtime || {});
    if (c === "undo") return undo(normalized, this.opts.runtime || {});
    if (c === "generateplan" || c === "generatebatchcookingplan") {
      return generateBatchCookingPlan(normalized, this.opts.runtime || {});
    }

    return handleCommand(command, normalized, this.opts.runtime || {});
  }

  /**
   * Legacy API; now a no-op.
   */
  subscribe() {
    return subscribe();
  }
}

/**
 * Factory for registries that prefer an instance.
 *
 * @param {Object} opts
 * @returns {BatchCookingAgent}
 */
export function createAgent(opts) {
  return new BatchCookingAgent(opts);
}

export default {
  invokeShim,
  handleCommand,
  plan,
  simulate,
  commit,
  undo,
  generateBatchCookingPlan,
  subscribe,
  BatchCookingAgent,
  createAgent,
};
