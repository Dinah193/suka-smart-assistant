/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\agents\shims\sababShim.js

/**
 * Sabab Shim — Rotisserie Feast Architect (SSA Reasoner Shim)
 * -----------------------------------------------------------------------------
 * This shim replaces the old sababAgent. It:
 *  - Enforces SSA runtime rules (budget, gating, confidence, freshness).
 *  - Calls the Reasoner using Sabab-specific modes.
 *  - Focuses on ROTISSERIE meat with layered spices & herbs (not skewers).
 *  - Surfaces cuisine preferences and nutrient information alongside plans.
 *  - Produces normalized JSON for automation (no UI, no DOM).
 *
 * Supported intents (examples):
 *  - "sabab.buildKebab"    → build rotisserie meat spec + alternatives.
 *  - "sabab.assembleMenu"  → menu with sides, sauces, breads, cart.
 *  - "sabab.planFeast"     → feast plan (shopping, schedule, cook profile).
 *  - "sabab.shareBundle"   → monetization bundle & economics.
 *
 * All flows return a ShimResponse:
 *  {
 *    ok: boolean,
 *    mode: string,
 *    data: {...normalized Sabab data...},
 *    warnings?: Array<Object>,
 *    debug?: Array<Object>
 *  }
 */

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

// -----------------------------------------------------------------------------
// Imports — SSA Runtime + Event Bus + Hub
// (Adjust paths to match your project aliases as needed.)
// -----------------------------------------------------------------------------

import { emit as emitEvent } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

import { HubPacketFormatter } from "@/services/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/FamilyFundConnector";

// Runtime enforcement & helpers
import { checkBudget } from "@/agents/runtime/budget";
import { isReasonerAllowed } from "@/agents/runtime/gating";
import { applyConfidenceRules } from "@/agents/runtime/confidence";
import { applyFreshnessRules } from "@/agents/runtime/freshness";

// Context selectors (Dexie-backed)
import {
  getHouseholdContextForSabab,
  getNutritionProfile,
  getCuisinePreferences,
  getDiasporaPreferences,
} from "@/agents/runtime/selectors";

// Cache layer
import {
  getMemoized,
  setMemoized,
} from "@/agents/runtime/cache/memo";
import {
  makeSababCacheKey,
} from "@/agents/runtime/cache/keys";

// Mode mapping + Reasoner + schema validator
import {
  resolveSababMode, // (req: ShimRequest) => { mode: string, schemaId: string }
} from "@/agents/shims/sabab/modes/map";

import {
  callReasoner,
} from "@/agents/runtime/reasonerDriver";

import {
  validateModeOutput,
} from "@/agents/runtime/schemaValidator";

// (Optional) session composition & guards if you later wire Sabab → sessions.
// Keeping imports commented so you can enable when ready.
/*
import {
  composeSessionFromSababFeast,
} from "@/skills/sessions/compose";

import {
  evaluateGuardsForSession,
} from "@/skills/sessions/guardsEvaluate";

import {
  saveSessionCheckpoint,
} from "@/services/db/sessions";
*/

// -----------------------------------------------------------------------------
// Constants & small utilities
// -----------------------------------------------------------------------------

const SHIM_SOURCE = "agents/shims/sabab";

const nowISO = () => new Date().toISOString();

/**
 * Build a basic ShimResponse object.
 * @param {Object} params
 * @param {boolean} params.ok
 * @param {string} params.mode
 * @param {Object} params.data
 * @param {Array<Object>} [params.warnings]
 * @param {Array<Object>} [params.debug]
 * @returns {ShimResponse}
 */
function buildShimResponse({ ok, mode, data, warnings = [], debug = [] }) {
  return {
    ok,
    mode,
    data,
    warnings,
    debug,
  };
}

/**
 * Emit a reasoner-related event via eventBus.
 * @param {string} type
 * @param {Object} data
 */
function emitReasonerEvent(type, data) {
  try {
    emitEvent({
      type,
      ts: nowISO(),
      source: SHIM_SOURCE,
      data,
    });
  } catch (err) {
    // Never crash shim if event bus fails
    console.warn("[sababShim] event emit failed:", err?.message || err);
  }
}

// -----------------------------------------------------------------------------
// Prompt Builder — rotisserie + Torah + cuisine + nutrition aware
// -----------------------------------------------------------------------------

/**
 * Build Reasoner prompts + payload for a given mode.
 * This is where we hard-bake the rotisserie + layered spices/herbs behavior.
 *
 * @param {ShimRequest} req
 * @param {string} mode
 * @param {Object} context
 * @returns {{ systemPrompt: string, userPrompt: string, payload: Object }}
 */
function buildPromptForMode(req, mode, context) {
  const { intent, input } = req;

  const torahProfile = context?.torahProfile || {};
  const cuisinePreferences =
    context?.cuisinePreferences ||
    input?.cuisinePreferences ||
    {};
  const nutritionProfile =
    context?.nutritionProfile ||
    input?.nutritionProfile ||
    {};
  const diasporaPreferences =
    context?.diasporaPreferences ||
    input?.diasporaPreferences ||
    {};
  const coalition = input?.coalition || null;

  // Rotisserie-first system prompt
  const systemPrompt =
    // Allow modes map to override, but default to rotisserie architect
    (context?.modeConfig && context.modeConfig.prompts && context.modeConfig.prompts.system) ||
    "You are the Sabab Rotisserie Architect for African American Israelites. " +
      "Sababs are meat cooked on a rotisserie (vertical or horizontal spit) " +
      "with layered spices and herbs applied to the meat as it turns. Your " +
      "primary job is to design HOW the meat is seasoned, layered, and cooked " +
      "on the rotisserie: spice/herb layering order, marination, basting, " +
      "heat zones, rotation timing, internal temperature targets, and visual/texture " +
      "doneness cues. The default serving style is sliced rotisserie meat piled " +
      "or layered with fresh vegetables, herbs, and sauces (platter, bowl, or wrap) — " +
      "not skewers. Skewers are only a minor fallback if a rotisserie is truly " +
      "unavailable. For every plan, specify: rotisserie setup (vertical/horizontal, " +
      "weights, balance), spice/herb layering strategy, fat management, rotation schedule, " +
      "and how to assemble the final layers of meat + veg + sauces. Respect Torah " +
      "dietary rules (no prohibited species unless explicitly allowed in the profile), " +
      "household cuisine preferences, and basic nutrition targets. " +
      "Return ONLY JSON that the SSA automation runtime can consume.";

  // User prompt describes the task in a structured way
  const userPrompt = JSON.stringify(
    {
      task: "sabab-rotisserie-feast-planning",
      intent,
      mode,
      input,
      context: {
        householdId: context?.householdId || null,
        torahProfile,
        cuisinePreferences,
        nutritionProfile,
        diasporaPreferences,
        coalition,
        inventorySummary: context?.inventorySummary || null,
        calendarSummary: context?.calendarSummary || null,
        cookIntent: {
          primaryMethod: "rotisserie_spit",
          allowFallbacks: ["oven_roasting", "grill_rotisserie_attachment"],
          focus: [
            "layered_spices",
            "layered_herbs",
            "basting_fat_management",
            "rotation_schedule",
            "internal_temp_and_texture_cues",
          ],
          presentationStyle:
            "sliced_rotisserie_meat_layered_with_veg_and_sauces",
        },
      },
    },
    null,
    2
  );

  const payload = {
    intent,
    mode,
    input,
    context: {
      householdId: context?.householdId || null,
      torahProfile,
      cuisinePreferences,
      nutritionProfile,
      diasporaPreferences,
      coalition,
      inventorySummary: context?.inventorySummary || null,
      calendarSummary: context?.calendarSummary || null,
      cookIntent: {
        primaryMethod: "rotisserie_spit",
        allowFallbacks: ["oven_roasting", "grill_rotisserie_attachment"],
        focus: [
          "layered_spices",
          "layered_herbs",
          "basting_fat_management",
          "rotation_schedule",
          "internal_temp_and_texture_cues",
        ],
        presentationStyle:
          "sliced_rotisserie_meat_layered_with_veg_and_sauces",
      },
    },
    task: "sabab-rotisserie-feast-planning",
  };

  return { systemPrompt, userPrompt, payload };
}

// -----------------------------------------------------------------------------
// Result Normalizer — rotisserie-focused, cuisine + nutrition-aware
// -----------------------------------------------------------------------------

/**
 * Normalize Reasoner output into Sabab-aware, rotisserie-first structure.
 *
 * @param {string} intent
 * @param {Object} raw
 * @param {Object} context
 * @returns {Object}
 */
function normalizeResult(intent, raw, context) {
  const normalized = raw || {};

  const cuisinePreferences =
    normalized.cuisinePreferences ||
    context?.cuisinePreferences ||
    {};
  const nutritionSummary =
    normalized.nutritionSummary ||
    normalized.nutrition ||
    context?.nutritionProfile ||
    {};

  const baseContext = {
    household: context?.household || null,
    torahProfile: context?.torahProfile || {},
    cuisinePreferences,
    nutritionSummary,
  };

  const menu = normalized.menu || {};
  const cart = normalized.cart || [];
  const feast = normalized.feast || normalized.feastPlan || {};
  const kebabSpec = normalized.kebab || normalized.spec || {};
  const kebabAlternatives = normalized.alternatives || [];
  const bundle = normalized.bundle || null;
  const diasporaPaths = normalized.diasporaPaths || [];

  // Rotisserie-focused cook profile
  const cookProfile = normalized.cookProfile || {
    primaryMethod:
      normalized.primaryMethod ||
      (normalized.cookIntent && normalized.cookIntent.primaryMethod) ||
      "rotisserie_spit",
    rotisserie: {
      orientation:
        normalized.rotisserie?.orientation || "vertical_or_horizontal_spit",
      burnerLayout:
        normalized.rotisserie?.burnerLayout || "indirect_heat_around_spit",
      rotationSpeedRpm:
        normalized.rotisserie?.rotationSpeedRpm || 3, // reasonable default
      preheatMinutes: normalized.rotisserie?.preheatMinutes || 15,
      targetInternalTempF:
        normalized.rotisserie?.targetInternalTempF || [150, 165],
      bastingIntervalMin:
        normalized.rotisserie?.bastingIntervalMin || 15,
      spiceHerbLayers:
        normalized.rotisserie?.spiceHerbLayers || [
          {
            layer: 1,
            type: "base_rub",
            description:
              "Salt + base spices rubbed directly on meat before mounting.",
          },
          {
            layer: 2,
            type: "herb_coating",
            description:
              "Herb mix pressed onto exterior after first 15–20 minutes of rotation.",
          },
          {
            layer: 3,
            type: "finishing_oil_or_glaze",
            description:
              "Light oil or glaze brushed on in last 10–15 minutes for shine and aroma.",
          },
        ],
      donenessCues:
        normalized.rotisserie?.donenessCues || [
          "deeply browned edges",
          "rendered fat dripping but not burning",
          "juices run clear when sliced",
        ],
    },
    altMethods:
      normalized.altMethods || [
        {
          method: "oven_roasting",
          notes:
            "Use a wire rack over a tray, flip once, and baste frequently to mimic rotisserie.",
        },
      ],
  };

  // Plate/platter presentation
  const presentation = normalized.presentation || {
    style:
      normalized.presentationStyle ||
      "sliced_rotisserie_meat_layered_with_veg_and_sauces",
    layeringOrder:
      normalized.layeringOrder || [
        "base_bread_or_grains",
        "sauced_veg",
        "sliced_rotisserie_meat",
        "fresh_herbs_and_crunch",
        "finishing_sauce_or_oil",
      ],
    notes:
      normalized.presentationNotes || [
        "Slice meat thinly off the spit, catching outer crisp edges.",
        "Alternate layers of meat and fresh veg for temperature and texture contrast.",
        "Add fresh herbs and finishing sauce right before serving.",
      ],
  };

  if (intent === "sabab.buildKebab") {
    return {
      type: "sabab.buildKebab",
      kebabSpec,
      alternatives: kebabAlternatives,
      diasporaPaths,
      cuisinePreferences,
      nutritionSummary,
      cookProfile,
      presentation,
      context: baseContext,
    };
  }

  if (intent === "sabab.assembleMenu") {
    return {
      type: "sabab.assembleMenu",
      menu,
      cart,
      diasporaPaths,
      cuisinePreferences,
      nutritionSummary,
      cookProfile,
      presentation,
      context: baseContext,
    };
  }

  if (intent === "sabab.planFeast") {
    const schedule =
      feast.schedule || normalized.schedule || [];

    return {
      type: "sabab.planFeast",
      menu,
      cart,
      feast,
      schedule,
      diasporaPaths,
      cuisinePreferences,
      nutritionSummary,
      cookProfile,
      presentation,
      context: baseContext,
    };
  }

  if (intent === "sabab.shareBundle") {
    return {
      type: "sabab.shareBundle",
      bundle,
      menu,
      cart,
      diasporaPaths,
      cuisinePreferences,
      nutritionSummary,
      cookProfile,
      presentation,
      context: baseContext,
    };
  }

  // Generic fallback
  return {
    type: "sabab.generic",
    result: normalized,
    diasporaPaths,
    cuisinePreferences,
    nutritionSummary,
    cookProfile,
    presentation,
    context: baseContext,
  };
}

// -----------------------------------------------------------------------------
// Main Shim Entry — invokeShim
// -----------------------------------------------------------------------------

/**
 * Invoke Sabab Shim.
 * - Enforces budget & gating.
 * - Uses selectors to build context (incl. cuisine & nutrition).
 * - Applies freshness & memoization.
 * - Calls Reasoner, validates, normalizes.
 * - Optionally exports to Hub when familyFundMode is on.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const debug = [];
  const warnings = [];

  if (!req || typeof req !== "object") {
    return buildShimResponse({
      ok: false,
      mode: "sabab.none",
      data: { error: "Missing ShimRequest" },
      warnings: [{ code: "bad_request", message: "Request object is required." }],
      debug,
    });
  }

  const { domain, intent, input = {}, runtime = {} } = req;

  if (!domain || !intent) {
    return buildShimResponse({
      ok: false,
      mode: "sabab.none",
      data: { error: "Missing domain or intent" },
      warnings: [{ code: "bad_request", message: "domain and intent are required." }],
      debug,
    });
  }

  // Resolve mode via modes/map.js (with defensive fallback)
  let modeInfo = null;
  try {
    modeInfo = resolveSababMode
      ? resolveSababMode(req)
      : null;
  } catch (err) {
    debug.push({
      stage: "resolveMode",
      error: err?.message || String(err),
    });
  }

  const fallbackModeMap = {
    "sabab.buildKebab": "sabab.buildKebab.v1",
    "sabab.assembleMenu": "sabab.assembleMenu.v1",
    "sabab.planFeast": "sabab.planFeast.v1",
    "sabab.shareBundle": "sabab.shareBundle.v1",
  };

  const mode =
    modeInfo?.mode ||
    fallbackModeMap[intent] ||
    "sabab.generic.v1";

  const schemaId =
    modeInfo?.schemaId ||
    `sabab.${mode}.delta.schema.json`;

  debug.push({ stage: "modeSelected", mode, schemaId, intent, domain });

  // Gating: check if Reasoner is allowed for this call
  const gating = await isReasonerAllowed({
    domain,
    intent,
    mode,
    runtime,
  });

  if (!gating?.ok) {
    warnings.push({
      code: "gating_blocked",
      message: gating?.reason || "Reasoner call not allowed for this request.",
    });

    return buildShimResponse({
      ok: false,
      mode,
      data: { gating },
      warnings,
      debug,
    });
  }

  // Budget enforcement
  const budget = await checkBudget({
    domain,
    intent,
    mode,
    runtime,
  });

  if (!budget?.ok) {
    warnings.push({
      code: "budget_exceeded",
      message: budget?.reason || "Budget exceeded for this request.",
    });

    return buildShimResponse({
      ok: false,
      mode,
      data: { budget },
      warnings,
      debug,
    });
  }

  // Pull Dexie-backed context via selectors
  let context = {};
  try {
    const [householdCtx, nutrition, cuisine, diaspora] = await Promise.all([
      getHouseholdContextForSabab(domain),
      getNutritionProfile(domain),
      getCuisinePreferences(domain),
      getDiasporaPreferences(domain),
    ]);

    context = {
      ...householdCtx,
      nutritionProfile: nutrition || {},
      cuisinePreferences: cuisine || {},
      diasporaPreferences: diaspora || {},
    };

    debug.push({ stage: "contextLoaded", contextKeys: Object.keys(context) });
  } catch (err) {
    warnings.push({
      code: "context_error",
      message: "Failed to load full Sabab context; proceeding with partial context.",
    });
    debug.push({
      stage: "contextError",
      error: err?.message || String(err),
    });
  }

  // Freshness + memo cache
  const cacheKey = makeSababCacheKey({
    domain,
    intent,
    mode,
    input,
    contextHash: context?.hash || null,
  });

  try {
    const cached = await getMemoized(cacheKey);
    if (cached) {
      const freshness = applyFreshnessRules({
        domain,
        intent,
        mode,
        cachedAt: cached.ts,
      });

      if (freshness?.useCache) {
        emitReasonerEvent("reasoner.cachedHit", {
          domain,
          intent,
          mode,
          cacheKey,
        });

        debug.push({
          stage: "cacheHit",
          ts: cached.ts,
          freshness,
        });

        // Cached result assumed already normalized and validated
        return buildShimResponse({
          ok: true,
          mode,
          data: cached.data,
          warnings,
          debug,
        });
      }

      debug.push({
        stage: "cacheStale",
        ts: cached.ts,
        freshness,
      });
    } else {
      emitReasonerEvent("reasoner.cachedMiss", {
        domain,
        intent,
        mode,
        cacheKey,
      });
      debug.push({ stage: "cacheMiss", cacheKey });
    }
  } catch (err) {
    debug.push({
      stage: "cacheError",
      error: err?.message || String(err),
    });
  }

  // Build prompt & Reasoner payload
  const { systemPrompt, userPrompt, payload } = buildPromptForMode(
    req,
    mode,
    context
  );

  emitReasonerEvent("reasoner.invoked", {
    domain,
    intent,
    mode,
    cacheKey,
  });

  // Call Reasoner
  let rawResult;
  try {
    rawResult = await callReasoner({
      mode,
      systemPrompt,
      userPrompt,
      payload,
      runtime,
    });

    debug.push({
      stage: "reasonerReturned",
      hasResult: !!rawResult,
    });
  } catch (err) {
    warnings.push({
      code: "reasoner_error",
      message: err?.message || "Reasoner call failed.",
    });

    return buildShimResponse({
      ok: false,
      mode,
      data: { error: "Reasoner call failed", detail: err?.message || String(err) },
      warnings,
      debug,
    });
  }

  // Schema validation
  const validation = validateModeOutput(schemaId, rawResult);
  if (!validation?.ok) {
    emitReasonerEvent("reasoner.invalidSchema", {
      domain,
      intent,
      mode,
      schemaId,
      errors: validation?.errors || [],
    });

    warnings.push({
      code: "invalid_schema",
      message:
        "Reasoner output did not match schema; see debug for validation errors.",
    });

    debug.push({
      stage: "schemaValidationFailed",
      schemaId,
      errors: validation?.errors || [],
    });

    // Still attempt to normalize so the UI has *something* usable.
  } else {
    emitReasonerEvent("reasoner.validated", {
      domain,
      intent,
      mode,
      schemaId,
    });

    debug.push({
      stage: "schemaValidationPassed",
      schemaId,
    });
  }

  // Normalize result into Sabab rotisserie structure
  const normalized = normalizeResult(intent, rawResult, context);

  // Confidence rules
  const confidence = applyConfidenceRules({
    domain,
    intent,
    mode,
    output: normalized,
  });

  if (!confidence?.ok) {
    warnings.push({
      code: "low_confidence",
      message:
        confidence?.reason ||
        "Output confidence below preferred threshold; review before committing.",
    });

    debug.push({
      stage: "confidenceLow",
      score: confidence?.score,
      details: confidence,
    });
  } else {
    debug.push({
      stage: "confidenceOk",
      score: confidence?.score,
    });
  }

  // Memoize normalized result
  try {
    await setMemoized(cacheKey, {
      ts: nowISO(),
      mode,
      data: normalized,
    });
  } catch (err) {
    debug.push({
      stage: "cacheSetError",
      error: err?.message || String(err),
    });
  }

  // Optional: Hub export when familyFundMode is on
  if (familyFundMode && runtime?.exportToHub) {
    try {
      const packet = HubPacketFormatter.format({
        domain,
        source: SHIM_SOURCE,
        kind: "sabab",
        payload: normalized,
      });

      await FamilyFundConnector.send(packet);

      emitReasonerEvent("session.exported", {
        domain,
        intent,
        mode,
        hub: { sent: true },
      });

      debug.push({
        stage: "hubExported",
        packetSummary: {
          kind: packet.kind,
          size: JSON.stringify(packet).length,
        },
      });
    } catch (err) {
      warnings.push({
        code: "hub_export_failed",
        message: err?.message || "Failed to export Sabab result to Hub.",
      });
      debug.push({
        stage: "hubExportError",
        error: err?.message || String(err),
      });
    }
  }

  // (Optional) Session creation for feast planning can be added later using
  // composeSessionFromSababFeast + evaluateGuardsForSession + saveSessionCheckpoint.
  // For now, this shim only plans & normalizes; SessionRunner handles execution.

  return buildShimResponse({
    ok: true,
    mode,
    data: normalized,
    warnings,
    debug,
  });
}

// -----------------------------------------------------------------------------
// Legacy compatibility wrapper (if you want old sababAgent.handleCommand-style)
// -----------------------------------------------------------------------------

/**
 * Optional small wrapper to keep a similar API to the old sababAgent
 * while the rest of the app is being migrated.
 *
 * Example usage:
 *   await invokeSababCommand("planFeast", { guests: 12, ... })
 *
 * @param {string} command
 * @param {Object} payload
 * @returns {Promise<ShimResponse>}
 */
export async function invokeSababCommand(command, payload = {}) {
  const cmd = String(command || "").toLowerCase().trim();
  const map = {
    buildkebab: "sabab.buildKebab",
    kebab: "sabab.buildKebab",
    menu: "sabab.assembleMenu",
    assemblemenu: "sabab.assembleMenu",
    feast: "sabab.planFeast",
    planfeast: "sabab.planFeast",
    share: "sabab.shareBundle",
    sharebundle: "sabab.shareBundle",
  };

  const intent = map[cmd] || "sabab.assembleMenu";

  return invokeShim({
    domain: "cooking",
    intent,
    input: payload || {},
    runtime: payload.runtime || {},
  });
}

export default {
  name: "sababShim",
  invokeShim,
  invokeSababCommand,
};
