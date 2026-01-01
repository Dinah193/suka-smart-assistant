// src/agents/shims/gardenHarvestShim.js

/* eslint-disable no-console */

/**
 * gardenHarvestShim
 *
 * This shim replaces the old `gardenHarvestAgent` file.
 *
 * Responsibilities:
 * - Accept a ShimRequest for the garden domain (harvest-related intents)
 * - Resolve the correct Reasoner mode via modes/map.js
 * - Enforce gating + budget + freshness + memoization
 * - Build a Reasoner prompt + call Reasoner
 * - Validate output against the mode schema
 * - Normalize into the legacy “envelope” shape used by gardenHarvestAgent:
 *   {
 *     ok, timestamp, summary, recommendations[],
 *     calendarEvents[], gardenUpdates[], storehouseUpdates[],
 *     mealPlanningHooks[], logs[]
 *   }
 * - Emit diagnostic events via the event bus
 *
 * It does NOT:
 * - Compute harvest windows, macros, or preservation logic locally
 * - Call other agents directly (inventory / mealPlanning)
 * - Touch UI, DOM, timers, or global mutable state
 */

import { emit as emitEvent } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

import { getModeForIntent } from "@/reasoner/modes/map"; // (domain, intent) -> mode string
import { runReasoner } from "@/reasoner/runtime/reasoner";
import { checkBudget } from "@/reasoner/runtime/budget";
import { canInvokeReasoner } from "@/reasoner/runtime/gating";
import { applyConfidenceRules } from "@/reasoner/runtime/confidence";
import { applyFreshnessRules } from "@/reasoner/runtime/freshness";

import { getDomainContext } from "@/db/selectors";
import { getCached, setCached } from "@/reasoner/cache/memo";
import { buildCacheKey } from "@/reasoner/cache/keys";

import { validateModeOutput } from "@/reasoner/modes/validator";
import { buildPromptForMode } from "@/reasoner/prompts/builder";

import { HubPacketFormatter } from "@/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/hub/FamilyFundConnector";

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

/**
 * Main entrypoint for the Garden Harvest shim.
 *
 * Supported intents (plus aliases):
 *  - "predictHarvestWindows"        (forecast / predict / windows)
 *  - "triggerPreservationPlanning"  (plan_preserve / preserve / preservation)
 *  - "logHarvest"                   (log)
 *  - "linkToRecipes"                (link / recipes)
 *  - "syncWithInventoryAndMeals"    (sync)
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const ts = new Date().toISOString();
  const debug = [];
  const warnings = [];

  try {
    // --------------------------------------------------
    // 0) Basic request validation
    // --------------------------------------------------
    if (!req || typeof req !== "object") {
      return buildShimError("Invalid shim request", null, { ts });
    }

    const { domain, intent, input = {}, runtime = {} } = req;

    if (domain !== "garden") {
      return buildShimError(
        `gardenHarvestShim only supports domain "garden", got "${domain}"`,
        null,
        { ts, domain, intent }
      );
    }

    if (!intent || typeof intent !== "string") {
      return buildShimError("Missing intent in ShimRequest", null, { ts, domain });
    }

    const normalizedIntent = normalizeIntent(intent);
    debug.push({ ts, stage: "intent_normalized", intent, normalizedIntent });

    // --------------------------------------------------
    // 1) Resolve mode
    // --------------------------------------------------
    const mode =
      getModeForIntent?.(domain, normalizedIntent) ||
      fallbackGardenHarvestMode(normalizedIntent);

    if (!mode) {
      return buildShimError("Unable to resolve Reasoner mode for garden harvest shim", null, {
        ts,
        domain,
        intent: normalizedIntent,
      });
    }

    debug.push({ stage: "mode_resolved", mode, intent: normalizedIntent });

    emitEvent({
      type: "reasoner.invoked",
      ts,
      source: "agents/shims/gardenHarvest",
      data: { domain, intent: normalizedIntent, mode },
    });

    // --------------------------------------------------
    // 2) Gating + Budget checks
    // --------------------------------------------------
    const gate = await canInvokeReasoner({ domain, intent: normalizedIntent, mode, runtime });
    if (!gate?.allowed) {
      warnings.push({ code: "gated", reason: gate?.reason || "blocked_by_policy" });

      emitEvent({
        type: "reasoner.gated",
        ts: new Date().toISOString(),
        source: "agents/shims/gardenHarvest",
        data: { domain, intent: normalizedIntent, mode, reason: gate?.reason },
      });

      return {
        ok: false,
        mode,
        data: { reason: "gated", gate },
        warnings,
        debug,
      };
    }

    const budgetStatus = await checkBudget({ mode, runtime });
    if (!budgetStatus?.allowed) {
      warnings.push({ code: "budget_exceeded", details: budgetStatus });

      emitEvent({
        type: "reasoner.budget_exceeded",
        ts: new Date().toISOString(),
        source: "agents/shims/gardenHarvest",
        data: { domain, intent: normalizedIntent, mode, budgetStatus },
      });

      return {
        ok: false,
        mode,
        data: { reason: "budget_exceeded", budgetStatus },
        warnings,
        debug,
      };
    }

    debug.push({ stage: "gating_budget_ok" });

    // --------------------------------------------------
    // 3) Dexie context + freshness rules
    // --------------------------------------------------
    const context = (await getDomainContext("garden")) || {};
    debug.push({ stage: "context_loaded", contextKeys: Object.keys(context || {}) });

    const { input: freshInput, freshnessWarnings } =
      (await applyFreshnessRules(mode, input, context)) || { input, freshnessWarnings: [] };

    if (freshnessWarnings?.length) {
      warnings.push(...freshnessWarnings);
      debug.push({ stage: "freshness_warnings", freshnessWarnings });
    }

    // --------------------------------------------------
    // 4) Cache lookup
    // --------------------------------------------------
    const cacheKey = buildCacheKey({ mode, input: freshInput, context });
    const cached = await getCached(cacheKey);

    if (cached) {
      debug.push({ stage: "cache_hit", cacheKey });

      emitEvent({
        type: "reasoner.cachedHit",
        ts: new Date().toISOString(),
        source: "agents/shims/gardenHarvest",
        data: { mode, cacheKey },
      });

      const normalizedFromCache = normalizeHarvestEnvelope(cached, normalizedIntent);
      return {
        ok: true,
        mode,
        data: normalizedFromCache,
        warnings,
        debug,
      };
    }

    debug.push({ stage: "cache_miss", cacheKey });

    emitEvent({
      type: "reasoner.cachedMiss",
      ts: new Date().toISOString(),
      source: "agents/shims/gardenHarvest",
      data: { mode, cacheKey },
    });

    // --------------------------------------------------
    // 5) Prompt build
    // --------------------------------------------------
    const prompt = await buildPromptForMode({
      mode,
      input: freshInput,
      context,
      runtime,
    });

    debug.push({ stage: "prompt_built" });

    // --------------------------------------------------
    // 6) Reasoner call
    // --------------------------------------------------
    const rawResult = await runReasoner({
      mode,
      prompt,
      input: freshInput,
      context,
      runtime,
    });

    debug.push({ stage: "reasoner_result_received" });

    // --------------------------------------------------
    // 7) Schema validation + confidence rules
    // --------------------------------------------------
    const validation = await validateModeOutput(mode, rawResult);

    if (!validation?.valid) {
      const errors = validation?.errors || [];
      warnings.push({ code: "invalid_schema", errors });
      debug.push({ stage: "invalid_schema", errors });

      emitEvent({
        type: "reasoner.invalidSchema",
        ts: new Date().toISOString(),
        source: "agents/shims/gardenHarvest",
        data: { mode, errors },
      });

      return {
        ok: false,
        mode,
        data: { reason: "invalid_schema", errors },
        warnings,
        debug,
      };
    }

    emitEvent({
      type: "reasoner.validated",
      ts: new Date().toISOString(),
      source: "agents/shims/gardenHarvest",
      data: { mode },
    });

    const confidenceInfo = await applyConfidenceRules({
      mode,
      result: validation.normalized,
      runtime,
    });

    if (confidenceInfo?.warnings?.length) {
      warnings.push(...confidenceInfo.warnings);
      debug.push({
        stage: "confidence_warnings",
        confidenceWarnings: confidenceInfo.warnings,
      });
    }

    // --------------------------------------------------
    // 8) Normalize into legacy harvest envelope
    // --------------------------------------------------
    const normalized = normalizeHarvestEnvelope(validation.normalized, normalizedIntent);

    // --------------------------------------------------
    // 9) Cache store (idempotent)
    // --------------------------------------------------
    try {
      await setCached(cacheKey, normalized, { mode, ttlSec: runtime?.ttlSec });
      debug.push({ stage: "cache_stored" });
    } catch (e) {
      warnings.push({ code: "cache_store_failed", message: String(e?.message || e) });
      console.warn("[gardenHarvestShim] cache store failed", e);
    }

    // --------------------------------------------------
    // 10) Optional Hub export (if enabled)
    // --------------------------------------------------
    if (familyFundMode && runtime?.exportToHub) {
      try {
        const packet = HubPacketFormatter.formatGardenHarvest({
          mode,
          intent: normalizedIntent,
          envelope: normalized,
          context,
        });

        await FamilyFundConnector.exportPacket(packet);

        emitEvent({
          type: "session.exported",
          ts: new Date().toISOString(),
          source: "agents/shims/gardenHarvest",
          data: { mode, intent: normalizedIntent },
        });

        debug.push({ stage: "hub_exported" });
      } catch (e) {
        warnings.push({ code: "hub_export_failed", message: String(e?.message || e) });
        console.warn("[gardenHarvestShim] Hub export failed", e);
      }
    }

    return {
      ok: true,
      mode,
      data: normalized,
      warnings,
      debug,
    };
  } catch (err) {
    console.warn("[gardenHarvestShim] fatal error", err);
    return buildShimError("gardenHarvestShim error", err, { ts, debug, warnings });
  }
}

/* ------------------------------------------------------------------ */
/* Compatibility wrappers                                             */
/* ------------------------------------------------------------------ */

/**
 * Compatibility wrapper for legacy code that previously called:
 *   handleHarvestCommand("predictHarvestWindows", payload)
 *   handleHarvestCommand("logHarvest", payload)
 * etc.
 *
 * It returns ONLY the legacy envelope (result.data), not the full ShimResponse.
 *
 * @param {string|Object} command
 * @param {Object} [payload]
 * @returns {Promise<Object>} legacy envelope
 */
export async function handleHarvestCommand(command, payload = {}) {
  // Preserve old pattern where callers sometimes pass { command, payload }
  let cmdStr = typeof command === "string" ? command : (command?.command || command?.type || "");
  if (typeof command === "object" && command?.payload && !Object.keys(payload || {}).length) {
    payload = command.payload;
  }

  const res = await invokeShim({
    domain: "garden",
    intent: cmdStr,
    input: payload,
  });

  return res.data;
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Normalize all the old command aliases into a stable intent string.
 *
 * Old mapping (from GardenHarvestAgent.handleCommand):
 *  forecast/predict/windows             -> predictHarvestWindows
 *  plan_preserve/preserve/preservation  -> triggerPreservationPlanning
 *  log                                  -> logHarvest
 *  link/recipes                         -> linkToRecipes
 *  sync                                 -> syncWithInventoryAndMeals
 *
 * @param {string} intent
 * @returns {string}
 */
function normalizeIntent(intent) {
  const c = String(intent || "").toLowerCase().trim();

  const map = {
    forecast: "predictHarvestWindows",
    predict: "predictHarvestWindows",
    windows: "predictHarvestWindows",

    plan_preserve: "triggerPreservationPlanning",
    preserve: "triggerPreservationPlanning",
    preservation: "triggerPreservationPlanning",

    log: "logHarvest",

    link: "linkToRecipes",
    recipes: "linkToRecipes",

    sync: "syncWithInventoryAndMeals",
  };

  return map[c] || intent;
}

/**
 * Fallback mode mapping if modes/map.js doesn’t yet have harvest entries.
 * Align these with your modes/schemas.md configuration.
 *
 * @param {string} normalizedIntent
 * @returns {string|null}
 */
function fallbackGardenHarvestMode(normalizedIntent) {
  switch (normalizedIntent) {
    case "predictHarvestWindows":
      return "garden.harvest.windows";
    case "triggerPreservationPlanning":
      return "garden.harvest.preservation";
    case "logHarvest":
      return "garden.harvest.log";
    case "linkToRecipes":
      return "garden.harvest.recipes";
    case "syncWithInventoryAndMeals":
      return "garden.harvest.sync";
    default:
      return null;
  }
}

/**
 * Normalize Reasoner output for harvest modes into the legacy envelope shape:
 *
 * {
 *   ok: true,
 *   timestamp,
 *   summary,
 *   recommendations: [],
 *   calendarEvents: [],
 *   gardenUpdates: [],
 *   storehouseUpdates: [],
 *   mealPlanningHooks: [],
 *   logs: []
 * }
 *
 * @param {any} raw
 * @param {string} normalizedIntent
 * @returns {Object}
 */
function normalizeHarvestEnvelope(raw, normalizedIntent) {
  if (raw && typeof raw === "object") {
    return {
      ok: raw.ok !== false,
      timestamp: raw.timestamp || new Date().toISOString(),
      summary: raw.summary || defaultSummaryForIntent(normalizedIntent),
      recommendations: Array.isArray(raw.recommendations) ? raw.recommendations : [],
      calendarEvents: Array.isArray(raw.calendarEvents) ? raw.calendarEvents : [],
      gardenUpdates: Array.isArray(raw.gardenUpdates) ? raw.gardenUpdates : [],
      storehouseUpdates: Array.isArray(raw.storehouseUpdates) ? raw.storehouseUpdates : [],
      mealPlanningHooks: Array.isArray(raw.mealPlanningHooks) ? raw.mealPlanningHooks : [],
      logs: Array.isArray(raw.logs) ? raw.logs : [],
    };
  }

  // Defensive fallback if Reasoner returns a primitive or unexpected type
  return {
    ok: true,
    timestamp: new Date().toISOString(),
    summary: defaultSummaryForIntent(normalizedIntent),
    recommendations: [],
    calendarEvents: [],
    gardenUpdates: [],
    storehouseUpdates: [],
    mealPlanningHooks: [],
    logs: [{ msg: "Non-object Reasoner output normalized by gardenHarvestShim", value: raw }],
  };
}

function defaultSummaryForIntent(normalizedIntent) {
  switch (normalizedIntent) {
    case "predictHarvestWindows":
      return "Predicted harvest windows.";
    case "triggerPreservationPlanning":
      return "Preservation planning for forecasted harvests.";
    case "logHarvest":
      return "Harvest logged and made available for planning.";
    case "linkToRecipes":
      return "Recipe suggestions linked to upcoming harvests.";
    case "syncWithInventoryAndMeals":
      return "Harvests synced to inventory and meal planning.";
    default:
      return "Garden harvest shim result.";
  }
}

/**
 * Build an error-style ShimResponse.
 *
 * @param {string} message
 * @param {Error|any} err
 * @param {Object} extra
 * @returns {ShimResponse}
 */
function buildShimError(message, err, extra = {}) {
  const ts = new Date().toISOString();
  console.warn("[gardenHarvestShim]", message, err || "");
  return {
    ok: false,
    mode: "garden.harvest.unknown",
    data: {
      summary: message,
      error: err ? String(err?.message || err) : undefined,
      ...extra,
    },
    warnings: [{ code: "shim_error", message }],
    debug: [{ ts, stage: "error", message }],
  };
}
