// src/agents/shims/breedingAndButcheringAgent.js
// -----------------------------------------------------------------------------
// SSA Breeding & Butchering Shim
// - Replaces the old "breedingAndButcheringAgent" logic-heavy agent
// - Delegates headcount forecasting, breeding plans, culling/butchering,
//   carcass yield estimates, and scenario simulations to the Reasoner.
// - Handles budget, gating, guards, freshness, memoization, schemas.
// - Optionally composes animal-care / butchering sessions and exports to Hub.
// - Provides thin backward-compatible wrappers: forecastHeadcount,
//   generateBreedingPlan, optimizeCyclesAgainstFeed, planButchering,
//   evaluateCarcassYield, simulateScenario, getDashboard, syncWithAnimalAgent,
//   plus a BreedingAndButcheringAgent class.
// -----------------------------------------------------------------------------

import { emit } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

import budget from "@/reasoner/budget.json";
import { canInvokeReasoner } from "@/reasoner/gating";
import { evaluateConfidence } from "@/reasoner/confidence";
import { selectAnimalsContext } from "@/reasoner/selectors";
import { applyFreshnessRules } from "@/reasoner/freshness";
import { getMemo, setMemo } from "@/reasoner/cache/memo";
import { buildAnimalsMemoKey } from "@/reasoner/cache/keys";
import { resolveMode } from "@/reasoner/modes/map";
import { validateModeOutput } from "@/reasoner/modes/validate";
import { getSystemPrompt } from "@/reasoner/prompts/system";
import { buildAnimalsPrompt } from "@/reasoner/prompts/templates";
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

const SHIM_SOURCE = "agents/shims/breedingAndButchering";
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
 * Enforce budget constraints using budget.json for animals / breeding.
 *
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {{ ok: boolean, reason?: string }}
 */
function enforceBudget(req, debug) {
  const domainBudget =
    (budget &&
      (budget.animals ||
        budget.breeding ||
        budget["animals.breeding"])) ||
    {};
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
 * Map legacy/agent commands to Reasoner intents.
 *
 * @param {string} command
 * @returns {string}
 */
function mapCommandToIntent(command) {
  if (!command) return "animals.breeding.forecastHeadcount";

  const cmd = String(command).trim().toLowerCase();

  const lookup = {
    forecastheadcount: "animals.breeding.forecastHeadcount",
    "forecast-headcount": "animals.breeding.forecastHeadcount",

    generatebreedingplan: "animals.breeding.generatePlan",
    "generate-breeding-plan": "animals.breeding.generatePlan",

    optimizecyclesagainstfeed: "animals.breeding.optimizeAgainstFeed",
    "optimize-cycles-against-feed": "animals.breeding.optimizeAgainstFeed",

    planbutchering: "animals.butchering.plan",
    "plan-butchering": "animals.butchering.plan",

    evaluatecarcassyield: "animals.butchering.evaluateYield",
    "evaluate-carcass-yield": "animals.butchering.evaluateYield",

    simulatscenario: "animals.breeding.simulateScenario", // guard typo
    simulatescenario: "animals.breeding.simulateScenario",
    "simulate-scenario": "animals.breeding.simulateScenario",

    getdashboard: "animals.breeding.dashboard",
    "get-dashboard": "animals.breeding.dashboard",

    syncwithanimalagent: "animals.breeding.syncWithAnimalAgent",
    "sync-with-animal-agent": "animals.breeding.syncWithAnimalAgent",
  };

  return lookup[cmd] || cmd;
}

/**
 * Resolve Reasoner mode for this animals/breeding/butchering request.
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
    }) || "animals.breeding.generic"
  );
}

/**
 * Compose sessions from a breeding/butchering output, if drafts are present.
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
    domain: "animals",
    drafts,
    source: {
      type: normalizedData.sourceType || "animalTask",
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

  const packets = HubPacketFormatter.fromBreedingAndButcheringPlan({
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
      origin: "breedingAndButchering",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main Breeding & Butchering shim entry point.
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

    const intent = req.intent || "animals.breeding.forecastHeadcount";
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
    // -------------------------------------------------
    const context = await selectAnimalsContext({
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

      // Return ok:true but indicate guard block; caller can show "guarded" state.
      return buildShimResponse(
        true,
        "animals.breeding.guarded.noop",
        {
          guards: guardsResult,
          note: "Breeding/butchering operation blocked by guard conditions.",
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
    const memoKey = buildAnimalsMemoKey({
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
    // 11. Compose sessions from breeding/butchering output
    // -------------------------------------------------
    const sessions = await maybeComposeSessions(
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // SessionRunner will emit session.* events when these sessions are executed.

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
    domain: "animals",
    intent,
    input: payload || {},
    runtime,
  });
}

// Individual wrappers roughly mirroring original commands:

export async function forecastHeadcount(options = {}, runtime = {}) {
  return handleCommand("forecastHeadcount", options, runtime);
}

export async function generateBreedingPlan(options = {}, runtime = {}) {
  return handleCommand("generateBreedingPlan", options, runtime);
}

export async function optimizeCyclesAgainstFeed(options = {}, runtime = {}) {
  return handleCommand("optimizeCyclesAgainstFeed", options, runtime);
}

export async function planButchering(options = {}, runtime = {}) {
  return handleCommand("planButchering", options, runtime);
}

export async function evaluateCarcassYield(options = {}, runtime = {}) {
  return handleCommand("evaluateCarcassYield", options, runtime);
}

export async function simulateScenario(options = {}, runtime = {}) {
  return handleCommand("simulateScenario", options, runtime);
}

export async function getDashboard(options = {}, runtime = {}) {
  return handleCommand("getDashboard", options, runtime);
}

export async function syncWithAnimalAgent(options = {}, runtime = {}) {
  return handleCommand("syncWithAnimalAgent", options, runtime);
}

/* ------------------------------------------------------------------
 * Class facade for registry compatibility
 * ------------------------------------------------------------------ */

export class BreedingAndButcheringAgent {
  /**
   * @param {Object} [opts]
   */
  constructor(opts = {}) {
    this.name = "breedingAndButcheringAgent";
    this.version = "2.0.0-shim";
    this.opts = opts;
  }

  /**
   * Legacy entry: (command, payload) → ShimResponse
   * Mirrors old handleCommand interface but routes to the shim.
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

    if (c === "forecastheadcount" || c === "forecast-headcount") {
      return forecastHeadcount(normalized, rt);
    }
    if (c === "generatebreedingplan" || c === "generate-breeding-plan") {
      return generateBreedingPlan(normalized, rt);
    }
    if (c === "optimizecyclesagainstfeed" || c === "optimize-cycles-against-feed") {
      return optimizeCyclesAgainstFeed(normalized, rt);
    }
    if (c === "planbutchering" || c === "plan-butchering") {
      return planButchering(normalized, rt);
    }
    if (c === "evaluatecarcassyield" || c === "evaluate-carcass-yield") {
      return evaluateCarcassYield(normalized, rt);
    }
    if (c === "simulatescenario" || c === "simulate-scenario") {
      return simulateScenario(normalized, rt);
    }
    if (c === "getdashboard" || c === "get-dashboard") {
      return getDashboard(normalized, rt);
    }
    if (c === "syncwithanimalagent" || c === "sync-with-animal-agent") {
      return syncWithAnimalAgent(normalized, rt);
    }

    // Fallback: generic handler
    return handleCommand(command, normalized, rt);
  }
}

/**
 * Factory for registries that prefer an instance.
 *
 * @param {Object} opts
 * @returns {BreedingAndButcheringAgent}
 */
export function createAgent(opts) {
  return new BreedingAndButcheringAgent(opts);
}

export default {
  invokeShim,
  handleCommand,
  forecastHeadcount,
  generateBreedingPlan,
  optimizeCyclesAgainstFeed,
  planButchering,
  evaluateCarcassYield,
  simulateScenario,
  getDashboard,
  syncWithAnimalAgent,
  BreedingAndButcheringAgent,
  createAgent,
};
