// src/agents/shims/gardenEstimateShim.js

/* eslint-disable no-console */

/**
 * Garden Estimate Shim
 *
 * This shim replaces the old `gardenEstimateAgent` file.
 *
 * Responsibilities:
 * - Accept a ShimRequest for the garden domain (estimate / generate plan)
 * - Resolve the correct Reasoner mode via modes/map.js
 * - Enforce gating + budget + freshness + memoization
 * - Build a Reasoner prompt + call Reasoner
 * - Validate output against the garden modes’ schemas
 * - Normalize into the legacy “envelope” shape that the UI/flows already expect
 * - Emit diagnostic events via the event bus
 *
 * It does NOT:
 * - Do frost, spacing, or preservation math locally
 * - Touch UI, DOM, timers, or global mutable state
 */

import { emit as emitEvent } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

import { getModeForIntent } from "@/reasoner/modes/map"; // (domain, intent) -> mode string
import { runReasoner } from "@/reasoner/runtime/reasoner"; // core Reasoner entrypoint
import { checkBudget } from "@/reasoner/runtime/budget";
import { canInvokeReasoner } from "@/reasoner/runtime/gating";
import { applyConfidenceRules } from "@/reasoner/runtime/confidence";
import { applyFreshnessRules } from "@/reasoner/runtime/freshness";

import { getDomainContext } from "@/db/selectors"; // pulls Dexie context for domain
import { getCached, setCached } from "@/reasoner/cache/memo";
import { buildCacheKey } from "@/reasoner/cache/keys";

import { validateModeOutput } from "@/reasoner/modes/validator"; // schema-based
import { buildPromptForMode } from "@/reasoner/prompts/builder";

import { HubPacketFormatter } from "@/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/hub/FamilyFundConnector";

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} intent  // e.g. "estimatePlan" | "generateGardenPlan"
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
 * Main public entrypoint for the Garden Estimate shim.
 *
 * Intents supported (mirroring old agent):
 *  - "estimate" | "estimatePlan" | "estimate_plan"
 *  - "generate" | "generateGardenPlan" | "generate_garden_plan"
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
        `gardenEstimateShim only supports domain "garden", got "${domain}"`,
        null,
        { ts, domain, intent }
      );
    }
    if (!intent || typeof intent !== "string") {
      return buildShimError("Missing intent in ShimRequest", null, { ts, domain });
    }

    const normalizedIntent = normalizeIntent(intent);

    // --------------------------------------------------
    // 1) Resolve mode
    // --------------------------------------------------
    const mode =
      getModeForIntent?.(domain, normalizedIntent) ||
      // Fallback mapping if modes/map.js doesn’t have explicit entries yet
      fallbackGardenMode(normalizedIntent);

    if (!mode) {
      return buildShimError("Unable to resolve Reasoner mode for garden shim", null, {
        ts,
        domain,
        intent: normalizedIntent,
      });
    }

    debug.push({ ts, stage: "mode_resolved", mode, intent: normalizedIntent });

    // Emit: reasoner.invoked
    emitEvent({
      type: "reasoner.invoked",
      ts,
      source: "agents/shims/garden",
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
        source: "agents/shims/garden",
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
        source: "agents/shims/garden",
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
    // 3) Dexie context + freshness adjustments
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
        source: "agents/shims/garden",
        data: { mode, cacheKey },
      });

      const normalizedFromCache = normalizeGardenEnvelope(cached, normalizedIntent);
      return {
        ok: true,
        mode,
        data: normalizedFromCache,
        warnings,
        debug,
      };
    }

    emitEvent({
      type: "reasoner.cachedMiss",
      ts: new Date().toISOString(),
      source: "agents/shims/garden",
      data: { mode, cacheKey },
    });
    debug.push({ stage: "cache_miss", cacheKey });

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
    // 7) Schema validation + confidence
    // --------------------------------------------------
    const validation = await validateModeOutput(mode, rawResult);
    if (!validation?.valid) {
      warnings.push({ code: "invalid_schema", errors: validation?.errors || [] });
      debug.push({ stage: "invalid_schema", errors: validation?.errors || [] });

      emitEvent({
        type: "reasoner.invalidSchema",
        ts: new Date().toISOString(),
        source: "agents/shims/garden",
        data: { mode, errors: validation?.errors || [] },
      });

      return {
        ok: false,
        mode,
        data: { reason: "invalid_schema", errors: validation?.errors || [] },
        warnings,
        debug,
      };
    }

    emitEvent({
      type: "reasoner.validated",
      ts: new Date().toISOString(),
      source: "agents/shims/garden",
      data: { mode },
    });

    const confidenceInfo = await applyConfidenceRules({ mode, result: validation.normalized, runtime });
    if (confidenceInfo?.warnings?.length) {
      warnings.push(...confidenceInfo.warnings);
      debug.push({ stage: "confidence_warnings", confidenceWarnings: confidenceInfo.warnings });
    }

    // --------------------------------------------------
    // 8) Normalize into legacy garden envelope shape
    // --------------------------------------------------
    const normalized = normalizeGardenEnvelope(validation.normalized, normalizedIntent);

    // --------------------------------------------------
    // 9) Cache store (idempotent)
    // --------------------------------------------------
    try {
      await setCached(cacheKey, normalized, { mode, ttlSec: runtime?.ttlSec });
      debug.push({ stage: "cache_stored" });
    } catch (e) {
      warnings.push({ code: "cache_store_failed", message: String(e?.message || e) });
      console.warn("[gardenEstimateShim] cache store failed", e);
    }

    // --------------------------------------------------
    // 10) Optional Hub export (if enabled + familyFundMode)
    // --------------------------------------------------
    if (familyFundMode && runtime?.exportToHub) {
      try {
        const packet = HubPacketFormatter.formatGardenEstimate({
          mode,
          intent: normalizedIntent,
          envelope: normalized,
          context,
        });
        await FamilyFundConnector.exportPacket(packet);
        emitEvent({
          type: "session.exported",
          ts: new Date().toISOString(),
          source: "agents/shims/garden",
          data: { mode, intent: normalizedIntent },
        });
        debug.push({ stage: "hub_exported" });
      } catch (e) {
        warnings.push({ code: "hub_export_failed", message: String(e?.message || e) });
        console.warn("[gardenEstimateShim] Hub export failed", e);
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
    console.warn("[gardenEstimateShim] fatal error", err);
    return buildShimError("gardenEstimateShim error", err, { ts, debug, warnings });
  }
}

/* ------------------------------------------------------------------ */
/* Legacy-style helpers (optional compatibility layer)                */
/* ------------------------------------------------------------------ */

/**
 * Tiny compatibility wrapper so old code that did:
 *   handle("estimatePlan", payload)
 * or:
 *   handle("generateGardenPlan", payload)
 * can be pointed at this shim with minimal refactor.
 *
 * @param {string} command
 * @param {Object} payload
 * @returns {Promise<ShimResponse>}
 */
export async function handle(command, payload = {}) {
  return invokeShim({
    domain: "garden",
    intent: command,
    input: payload,
  });
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                   */
/* ------------------------------------------------------------------ */

function normalizeIntent(intent) {
  const c = String(intent || "").toLowerCase().trim();

  if (["estimate", "estimateplan", "estimate_plan", "estimateplan()"].includes(c)) {
    return "estimatePlan";
  }
  if (
    ["generate", "generateplan", "generate_garden_plan", "generategardenplan", "generategardenplan()"].includes(
      c
    )
  ) {
    return "generateGardenPlan";
  }
  return intent;
}

/**
 * Fallback mode names if modes/map.js doesn’t yet have explicit entries.
 * You can align these with whatever you configure in modes/schemas.md.
 */
function fallbackGardenMode(normalizedIntent) {
  switch (normalizedIntent) {
    case "estimatePlan":
      return "garden.estimate.plan";
    case "generateGardenPlan":
      return "garden.plan.generate";
    default:
      return null;
  }
}

/**
 * Normalize Reasoner output into the envelope shape that the old
 * gardenEstimateAgent returned:
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
 */
function normalizeGardenEnvelope(raw, normalizedIntent) {
  // If Reasoner already returned an envelope-shaped object, just ensure
  // the core fields exist and pass it through.
  if (raw && typeof raw === "object") {
    const out = {
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
    return out;
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
    logs: [{ msg: "Non-object Reasoner output normalized by shim", value: raw }],
  };
}

function defaultSummaryForIntent(normalizedIntent) {
  if (normalizedIntent === "estimatePlan") return "Garden estimate plan generated.";
  if (normalizedIntent === "generateGardenPlan") return "Garden workflow plan generated.";
  return "Garden shim result.";
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
  console.warn("[gardenEstimateShim]", message, err || "");
  return {
    ok: false,
    mode: "garden.unknown",
    data: {
      summary: message,
      error: err ? String(err?.message || err) : undefined,
      ...extra,
    },
    warnings: [{ code: "shim_error", message }],
    debug: [{ ts, stage: "error", message }],
  };
}
