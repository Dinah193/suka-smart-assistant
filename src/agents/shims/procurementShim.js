// C:\Users\larho\suka-smart-assistant\src\agents\shims\procurementShim.js

/**
 * Procurement Shim
 * -----------------------------------------------------------------------------
 * Thin bridge between SSA core (context, cache, budget, gating) and the
 * Reasoner for procurement / storehouse planning.
 *
 * Responsibilities:
 *  - Accept a ShimRequest (domain, intent, input, runtime)
 *  - Enforce gating + budget + freshness
 *  - Pull context via selectors
 *  - Choose a Reasoner mode via modes/map.js
 *  - Build prompts using mode config + system/templates
 *  - Call Reasoner in a controlled way
 *  - Validate output using mode-specific schema
 *  - Normalize into a ShimResponse
 *  - Emit SSA events via eventBus
 *
 * It replaces the old procurementAgent “brainy” behavior but does NOT:
 *  - Own UI logic
 *  - Own timers, loops, or session runners
 *  - Directly mutate storehouse or inventory
 *  - Subscribe to runtime events (that belongs to automation runtime)
 */

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} intent  // e.g. "procurement.buildPurchaseList"
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

import { emit as emitBus } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

/**
 * IMPORTANT:
 * These are NOT shim-local files; they live under src/agents/runtime/reasoner/
 * and src/agents/* (context, policies, modes).
 */
import budgetConfig from "@/agents/policies/budget.json" assert { type: "json" };
import { isReasonerCallAllowed } from "@/agents/runtime/reasoner/gating.js";
import {
  enforceBudgetForMode,
  evaluateConfidence,
} from "@/agents/runtime/reasoner/confidence.js"; // includes token/time budgeting
import { selectProcurementContext } from "@/agents/context/selectors.js";
import { applyFreshnessRules } from "@/agents/runtime/reasoner/freshness.js";
import {
  getCachedResult,
  setCachedResult,
} from "@/agents/runtime/reasoner/cache/memo.js";
import { makeProcurementCacheKey } from "@/agents/runtime/reasoner/cache/keys.js";
import { getModeConfig } from "@/agents/modes/map.js";
import { validateModeOutput } from "@/agents/modes/validate.js";
import { invokeReasoner } from "@/agents/runtime/reasoner/index.js";

let HubPacketFormatter;
let FamilyFundConnector;

// Hub helpers are optional; guard them so shim never crashes if missing
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter").default;
  // eslint-disable-next-line global-require, import/no-unresolved
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector").default;
} catch {
  // optional, ignore
}

const SHIM_SOURCE = "agents/shims/procurement";
const VALID_DOMAINS = [
  "cooking",
  "cleaning",
  "garden",
  "animals",
  "preservation",
  "storehouse",
];

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function isoNow() {
  return new Date().toISOString();
}

/**
 * Emit a standardized SSA event.
 * @param {string} type
 * @param {Object} data
 */
function emitEvent(type, data) {
  try {
    emitBus({
      type,
      ts: isoNow(),
      source: SHIM_SOURCE,
      data,
    });
  } catch {
    // never crash the shim because of event bus
  }
}

/**
 * Build a consistent debug entry.
 * @param {string} stage
 * @param {Object} info
 */
function debugEntry(stage, info) {
  return { ts: isoNow(), stage, ...info };
}

/**
 * Build messages for the Reasoner from mode config + request + context.
 * This respects system.md + templates.md indirectly via modeConfig.
 *
 * @param {Object} params
 * @param {Object} params.modeConfig
 * @param {string} params.mode
 * @param {string} params.intent
 * @param {Object} params.input
 * @param {Object} params.context
 * @returns {Array<{role: "system"|"user", content: string}>}
 */
function buildPromptForMode({ modeConfig, mode, intent, input, context }) {
  const systemPrompt =
    modeConfig?.prompts?.system ||
    "You are the procurement and frugality planner for a Torah-aligned household storehouse. Return ONLY JSON.";
  const template = modeConfig?.prompts?.template;

  // If there is a template function/string, use it; otherwise, simple JSON payload
  let userContent;
  if (typeof template === "function") {
    userContent = template({ intent, input, context, mode });
  } else if (typeof template === "string") {
    // crude interpolation; the real implementation can be more robust
    userContent = template
      .replace("{{intent}}", intent)
      .replace("{{payload}}", JSON.stringify({ input, context, mode }));
  } else {
    userContent = JSON.stringify({
      intent,
      mode,
      input,
      context,
      task: "procurement-planning",
    });
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

/**
 * Normalize Reasoner result into a ShimResponse.data payload.
 * Keeps intent-specific branches small and explicit.
 *
 * @param {string} intent
 * @param {Object} normalized
 * @param {Object} context
 */
function normalizeResult(intent, normalized, context) {
  const baseContext = {
    household: context?.household || null,
    inventorySummary: context?.inventorySummary || null,
  };

  if (intent === "procurement.buildPurchaseList") {
    return {
      type: "purchaseList",
      purchaseList: normalized.purchaseList || normalized.items || [],
      summary: normalized.summary || {},
      context: baseContext,
    };
  }

  if (intent === "procurement.suggestHomeProduction") {
    return {
      type: "diySuggestions",
      recommendations: normalized.recommendations || [],
      options: normalized.options || {},
      context: baseContext,
    };
  }

  if (intent === "procurement.makeOrBuyPlan") {
    return {
      type: "makeOrBuyPlan",
      purchase: normalized.purchase || {},
      diy: normalized.diy || {},
      context: baseContext,
    };
  }

  // Generic fallback
  return {
    type: "genericProcurement",
    result: normalized,
    context: baseContext,
  };
}

/**
 * Optional: local deterministic fallback if Reasoner fails hard.
 * This is intentionally tiny compared to the old agent and only covers
 * the common "no gaps" / trivial-case behavior.
 *
 * @param {string} intent
 * @param {Object} input
 */
function localFallback(intent, input) {
  if (intent === "procurement.buildPurchaseList") {
    const gaps = Array.isArray(input?.gaps) ? input.gaps : [];
    if (!gaps.length) {
      return {
        type: "purchaseList",
        purchaseList: [],
        summary: {
          message: "No storehouse gaps detected. Your storehouse appears full.",
        },
      };
    }
  }

  // otherwise just reflect the input for debugging
  return {
    type: "fallback",
    echo: input || {},
  };
}

/* -------------------------------------------------------------------------- */
/* Main Shim Export                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Main entrypoint for the Procurement shim.
 *
 * Example use:
 *  const res = await invokeShim({
 *    domain: "storehouse",
 *    intent: "procurement.buildPurchaseList",
 *    input: { gaps, budgetLimit, household },
 *    runtime: { requestId, approximateTokens: 1500, exportToHub: false }
 *  });
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const debug = [];
  const warnings = [];
  let mode = "";

  try {
    const domain = req?.domain || "storehouse";
    const intent = req?.intent || "procurement.buildPurchaseList";
    const input = req?.input || {};
    const runtime = req?.runtime || {};

    debug.push(debugEntry("request.received", { domain, intent }));

    // Basic validation -------------------------------------------------------
    if (!VALID_DOMAINS.includes(domain)) {
      warnings.push({
        type: "domain.unsupported",
        message: `Unsupported domain "${domain}" for procurement shim.`,
      });
      return {
        ok: false,
        mode,
        data: {
          error: "Unsupported domain for procurement shim",
          domain,
        },
        warnings,
        debug,
      };
    }

    // Gating (when we are not allowed to call Reasoner) ----------------------
    const gatingDecision = isReasonerCallAllowed({
      domain,
      intent,
      runtime,
      input,
    });
    debug.push(debugEntry("gating.checked", gatingDecision));

    if (!gatingDecision.allowed) {
      warnings.push({
        type: "gating.blocked",
        reason: gatingDecision.reason || "not-allowed",
      });

      // Return a local fallback rather than crashing
      const fallback = localFallback(intent, input);
      return {
        ok: false,
        mode,
        data: {
          error: "Reasoner call not allowed by gating rules.",
          reason: gatingDecision.reason,
          fallback,
        },
        warnings,
        debug,
      };
    }

    // Select mode via modes/map.js ------------------------------------------
    const modeConfig = getModeConfig({ domain, intent, runtime, input });
    mode = modeConfig?.id || modeConfig?.name || "procurement.plan.v1";

    debug.push(debugEntry("mode.selected", { mode, model: modeConfig?.model }));

    // Budget enforcement (tokens/time) --------------------------------------
    const budgetDecision = enforceBudgetForMode({
      mode,
      domain,
      intent,
      runtime,
      budgetConfig,
    });
    debug.push(debugEntry("budget.checked", budgetDecision));

    if (!budgetDecision.ok) {
      warnings.push({
        type: "budget.exceeded",
        reason: budgetDecision.reason || "limit-exceeded",
      });
      const fallback = localFallback(intent, input);
      return {
        ok: false,
        mode,
        data: {
          error: "Budget constraints prevent Reasoner call.",
          reason: budgetDecision.reason,
          fallback,
        },
        warnings,
        debug,
      };
    }

    // Pull context from Dexie / SSA selectors --------------------------------
    const context = await selectProcurementContext({
      domain,
      intent,
      input,
      runtime,
    });
    debug.push(debugEntry("context.selected", { hasContext: !!context }));

    // Freshness rules (decide cache / re-compute) ----------------------------
    const freshnessDecision = applyFreshnessRules({
      mode,
      domain,
      intent,
      input,
      context,
      runtime,
    });
    debug.push(debugEntry("freshness.applied", freshnessDecision));

    // Cache layer ------------------------------------------------------------
    const cacheKey = makeProcurementCacheKey({
      mode,
      domain,
      intent,
      input,
      context,
    });

    if (!freshnessDecision.skipCacheRead) {
      const cached = await getCachedResult(cacheKey);
      if (cached) {
        emitEvent("reasoner.cache.hit", {
          mode,
          domain,
          intent,
          cacheKey,
        });
        debug.push(debugEntry("cache.hit", { cacheKey }));
        return {
          ok: true,
          mode,
          data: cached.data,
          warnings: [...warnings, ...(cached.warnings || [])],
          debug,
        };
      }
      emitEvent("reasoner.cache.miss", {
        mode,
        domain,
        intent,
        cacheKey,
      });
      debug.push(debugEntry("cache.miss", { cacheKey }));
    }

    // Prompt construction ----------------------------------------------------
    const messages = buildPromptForMode({
      modeConfig,
      mode,
      intent,
      input,
      context,
    });
    debug.push(debugEntry("prompt.built", { messagesCount: messages.length }));

    // Emit invoked event -----------------------------------------------------
    emitEvent("reasoner.invoked", {
      mode,
      domain,
      intent,
      runtime,
    });

    // Reasoner call ----------------------------------------------------------
    const rawResult = await invokeReasoner({
      mode,
      model: modeConfig?.model,
      messages,
      options: {
        temperature: modeConfig?.temperature ?? 0.2,
        maxTokens: modeConfig?.maxTokens ?? 2048,
        responseFormat: "json",
        runtime,
      },
    });

    emitEvent("reasoner.result.raw", {
      mode,
      domain,
      intent,
    });
    debug.push(debugEntry("reasoner.returned", { hasResult: !!rawResult }));

    // Schema validation ------------------------------------------------------
    const validation = await validateModeOutput(mode, rawResult);
    debug.push(
      debugEntry("schema.validated", {
        valid: validation.valid,
        errors: validation.errors || null,
      })
    );

    if (!validation.valid) {
      emitEvent("reasoner.validation.failed", {
        mode,
        domain,
        intent,
        errors: validation.errors,
      });
      warnings.push({
        type: "schema.invalid",
        errors: validation.errors,
      });

      // Fallback again to tiny local behavior
      const fallback = localFallback(intent, input);
      return {
        ok: false,
        mode,
        data: {
          error: "Reasoner output failed schema validation.",
          errors: validation.errors,
          fallback,
        },
        warnings,
        debug,
      };
    }

    emitEvent("reasoner.validation.ok", {
      mode,
      domain,
      intent,
    });

    const normalized = validation.normalized || rawResult;

    // Confidence evaluation --------------------------------------------------
    const confidence = evaluateConfidence({
      mode,
      domain,
      intent,
      result: normalized,
      raw: rawResult,
    });
    debug.push(debugEntry("confidence.evaluated", confidence));

    if (confidence.level === "low") {
      warnings.push({
        type: "confidence.low",
        score: confidence.score,
        message: confidence.message,
      });
    }

    // Normalize into shim data ----------------------------------------------
    const data = normalizeResult(intent, normalized, context);

    // Cache write (if allowed) ----------------------------------------------
    if (!freshnessDecision.skipCacheWrite) {
      await setCachedResult(cacheKey, {
        mode,
        domain,
        intent,
        data,
        warnings,
        ts: isoNow(),
      });
      debug.push(debugEntry("cache.write", { cacheKey }));
    }

    // Optional Hub export ----------------------------------------------------
    if (
      familyFundMode &&
      runtime.exportToHub &&
      HubPacketFormatter &&
      FamilyFundConnector
    ) {
      try {
        const packet = HubPacketFormatter.fromProcurementPlan({
          domain,
          intent,
          mode,
          data,
          context,
        });
        await FamilyFundConnector.send(packet);
        emitEvent("session.exported", {
          mode,
          domain,
          intent,
          hubPacketType: packet?.type || "procurementPlan",
        });
        debug.push(
          debugEntry("hub.exported", {
            packetType: packet?.type || "procurementPlan",
          })
        );
      } catch (err) {
        warnings.push({
          type: "hub.export.failed",
          message: err?.message || String(err),
        });
        debug.push(
          debugEntry("hub.export.error", {
            error: err?.message || String(err),
          })
        );
      }
    }

    // Final success response -------------------------------------------------
    emitEvent("shim.procurement.completed", {
      mode,
      domain,
      intent,
      ok: true,
    });

    return {
      ok: true,
      mode,
      data,
      warnings,
      debug,
    };
  } catch (err) {
    // Global catch – never throw out of the shim
    debug.push(
      debugEntry("shim.error", {
        error: err?.message || String(err),
        stack: err?.stack || null,
      })
    );
    emitEvent("shim.procurement.error", {
      mode,
      error: err?.message || String(err),
    });
    return {
      ok: false,
      mode,
      data: {
        error: err?.message || String(err),
      },
      warnings,
      debug,
    };
  }
}

export default {
  invokeShim,
};
