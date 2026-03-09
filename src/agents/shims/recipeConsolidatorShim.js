// C:\Users\larho\suka-smart-assistant\src\agents\shims\recipeConsolidatorShim.js

/**
 * Recipe Consolidator Shim
 * -----------------------------------------------------------------------------
 * Thin bridge between SSA core (context, cache, budget, gating) and the
 * Reasoner for recipe consolidation, cuisine-aware planning, and basic
 * nutrition summaries.
 *
 * Responsibilities:
 *  - Accept a ShimRequest (domain, intent, input, runtime)
 *  - Enforce gating + budget + freshness
 *  - Pull context via selectors (including cuisine preferences & nutrition info)
 *  - Choose a Reasoner mode via modes/map.js
 *  - Build prompts using mode config + system/templates
 *  - Call Reasoner in a controlled way
 *  - Validate output using mode-specific schema
 *  - Normalize into a ShimResponse
 *  - Emit SSA events via eventBus (reasoner.* + shim.* + optional session.exported)
 *
 * It replaces the old recipeConsolidatorAgent "brainy" logic (preview/apply/run,
 * shellfish policy, diffing, tools/task extraction, UI glue) with a clean shim
 * that delegates to Reasoner + skills.
 */

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} intent  // e.g. "recipes.consolidate.preview"
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
 * NOTE on JSON import:
 * Vite supports JSON imports; keep assert for environments that honor it.
 */
import budgetConfig from "@/agents/policies/budget.json" assert { type: "json" };

/**
 * IMPORTANT:
 * These are NOT shim-local files; they live under src/agents/runtime/reasoner/
 * and src/agents/modes/.
 */
import { isReasonerCallAllowed } from "@/agents/runtime/reasoner/gating.js";
import {
  enforceBudgetForMode,
  evaluateConfidence,
} from "@/agents/runtime/reasoner/confidence.js";
import { selectRecipeConsolidatorContext } from "@/agents/context/selectors.js";
import { applyFreshnessRules } from "@/agents/runtime/reasoner/freshness.js";
import {
  getCachedResult,
  setCachedResult,
} from "@/agents/runtime/reasoner/cache/memo.js";
import { makeRecipeConsolidatorCacheKey } from "@/agents/runtime/reasoner/cache/keys.js";
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

const SHIM_SOURCE = "agents/shims/recipes";
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
 * Build a prompt for the Reasoner based on mode config + request + context.
 * This is where cuisine preferences and nutrition information are braided
 * into the user payload so the Reasoner can respect them.
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
    "You are a Torah-aligned recipe consolidator and nutrition-aware meal planner. " +
      "You must respect household dietary rules (e.g., shellfish, pork) and cuisine preferences, " +
      "and return ONLY JSON that the UI/runtime can safely consume.";

  const template = modeConfig?.prompts?.template;

  // Pull key contextual bits we care about for this shim
  const cuisinePreferences = context?.cuisinePreferences || {};
  const nutritionProfile = context?.nutritionProfile || {};
  const shellfishAllowed = !!context?.dietary?.allowShellfish;

  // The Reasoner gets a compact but expressive payload
  const payload = {
    intent,
    mode,
    input,
    context: {
      householdId: context?.householdId || null,
      cuisinePreferences,
      nutritionProfile,
      dietary: {
        ...context?.dietary,
        shellfishAllowed,
      },
      // Optionally: recent sessions, storehouse status, etc.
      inventorySummary: context?.inventorySummary || null,
      calendarSummary: context?.calendarSummary || null,
    },
    task: "recipe-consolidation",
  };

  let userContent;
  if (typeof template === "function") {
    userContent = template(payload);
  } else if (typeof template === "string") {
    userContent = template.replace("{{payload}}", JSON.stringify(payload));
  } else {
    userContent = JSON.stringify(payload);
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

/**
 * Normalize Reasoner result into a ShimResponse.data payload.
 * This is where we guarantee that cuisine preferences and nutrition
 * summaries surface in a predictable shape.
 *
 * @param {string} intent
 * @param {Object} normalized
 * @param {Object} context
 */
function normalizeResult(intent, normalized, context) {
  const cuisinePreferences =
    normalized.cuisinePreferences || context?.cuisinePreferences || {};
  const nutritionSummary =
    normalized.nutritionSummary ||
    normalized.nutrition ||
    context?.nutritionProfile ||
    {};

  const baseContext = {
    household: context?.household || null,
    cuisinePreferences,
    nutritionSummary,
  };

  if (intent === "recipes.consolidate.preview") {
    return {
      type: "recipes.consolidation.preview",
      diff: normalized.diff || {
        create: [],
        update: [],
        skip: [],
        totalIncoming: 0,
      },
      shellfishAllowed:
        typeof normalized.shellfishAllowed === "boolean"
          ? normalized.shellfishAllowed
          : !!context?.dietary?.allowShellfish,
      toolsSummary: normalized.toolsSummary || null,
      timeline: normalized.timeline || null,
      cuisinePreferences,
      nutritionSummary,
      context: baseContext,
    };
  }

  if (intent === "recipes.consolidate.apply") {
    return {
      type: "recipes.consolidation.apply",
      appliedCount: normalized.appliedCount ?? 0,
      meta: normalized.meta || {},
      cuisinePreferences,
      nutritionSummary,
      context: baseContext,
    };
  }

  if (intent === "recipes.consolidate.run") {
    return {
      type: "recipes.consolidation.run",
      diff: normalized.diff || {},
      appliedCount: normalized.appliedCount ?? 0,
      meta: normalized.meta || {},
      cuisinePreferences,
      nutritionSummary,
      context: baseContext,
    };
  }

  // Generic fallback
  return {
    type: "recipes.consolidation.generic",
    result: normalized,
    cuisinePreferences,
    nutritionSummary,
    context: baseContext,
  };
}

/**
 * Tiny deterministic fallback if Reasoner cannot be used.
 * This does NOT try to replicate the old agent’s full behavior; it only
 * produces a safe, minimal echo for debugging and graceful UX.
 *
 * @param {string} intent
 * @param {Object} input
 * @param {Object} context
 */
function localFallback(intent, input, context) {
  const cuisinePreferences = context?.cuisinePreferences || {};
  const nutritionSummary = context?.nutritionProfile || {};

  if (intent === "recipes.consolidate.preview") {
    const sources = Array.isArray(input?.sources) ? input.sources : [];
    return {
      type: "recipes.consolidation.preview.fallback",
      diff: {
        create: sources,
        update: [],
        skip: [],
        totalIncoming: sources.length,
      },
      cuisinePreferences,
      nutritionSummary,
      note: "Reasoner unavailable; this is a shallow echo of sources.",
    };
  }

  return {
    type: "recipes.consolidation.fallback",
    echo: input || {},
    cuisinePreferences,
    nutritionSummary,
  };
}

/* -------------------------------------------------------------------------- */
/* Main Shim Export                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Main entrypoint for the Recipe Consolidator shim.
 *
 * Example use:
 *  const res = await invokeShim({
 *    domain: "cooking",
 *    intent: "recipes.consolidate.preview",
 *    input: { sources, options },
 *    runtime: { requestId, approximateTokens: 1600, exportToHub: false }
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
    const domain = req?.domain || "cooking";
    const intent = req?.intent || "recipes.consolidate.preview";
    const input = req?.input || {};
    const runtime = req?.runtime || {};

    debug.push(debugEntry("request.received", { domain, intent }));

    // Basic validation -------------------------------------------------------
    if (!VALID_DOMAINS.includes(domain)) {
      warnings.push({
        type: "domain.unsupported",
        message: `Unsupported domain "${domain}" for recipe consolidator shim.`,
      });
      return {
        ok: false,
        mode,
        data: {
          error: "Unsupported domain for recipe consolidator shim",
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

      const contextLite = { cuisinePreferences: {}, nutritionProfile: {} };
      const fallback = localFallback(intent, input, contextLite);
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
    mode = modeConfig?.id || modeConfig?.name || "recipes.consolidation.v1";

    debug.push(
      debugEntry("mode.selected", {
        mode,
        model: modeConfig?.model,
      })
    );

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
      const contextLite = { cuisinePreferences: {}, nutritionProfile: {} };
      const fallback = localFallback(intent, input, contextLite);
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
    const context = await selectRecipeConsolidatorContext({
      domain,
      intent,
      input,
      runtime,
    });
    debug.push(
      debugEntry("context.selected", {
        hasContext: !!context,
        hasCuisinePreferences: !!context?.cuisinePreferences,
        hasNutritionProfile: !!context?.nutritionProfile,
      })
    );

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
    const cacheKey = makeRecipeConsolidatorCacheKey({
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
    debug.push(
      debugEntry("prompt.built", {
        messagesCount: messages.length,
      })
    );

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
        temperature: modeConfig?.temperature ?? 0.15,
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
    debug.push(
      debugEntry("reasoner.returned", {
        hasResult: !!rawResult,
      })
    );

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

      const fallback = localFallback(intent, input, context || {});
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
    const data = normalizeResult(intent, normalized, context || {});

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

    // Optional Hub export (treated like session.exported for consistency) ----
    if (
      familyFundMode &&
      runtime.exportToHub &&
      HubPacketFormatter &&
      FamilyFundConnector
    ) {
      try {
        const packet = HubPacketFormatter.fromRecipeConsolidation({
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
          hubPacketType: packet?.type || "recipes.consolidation",
        });
        debug.push(
          debugEntry("hub.exported", {
            packetType: packet?.type || "recipes.consolidation",
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
    emitEvent("shim.recipes.completed", {
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
    emitEvent("shim.recipes.error", {
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
