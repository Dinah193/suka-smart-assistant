// src/agents/shims/gardeningShim.js

/**
 * Gardening Shim (Cuisine-Aware)
 * ---------------------------------
 * Lightweight, Reasoner-centric shim that:
 * - Accepts gardening intents (estimate plan, generate tasks, etc.)
 * - Pulls context (beds, crops, frost, meal/cuisine signals) via selectors
 * - Adds cuisine-aware signals (cuisineProfile + mealPrefs + demand weights)
 * - Picks a Reasoner mode, builds prompts, enforces budget/gating/freshness
 * - Validates Reasoner output against schemas
 * - Normalizes into SSA-standard structured data
 * - Emits events for observability and (optionally) Hub export
 *
 * NOTE: This shim does NOT:
 * - Contain UI, timers, or loops
 * - Maintain global mutable state
 * - Directly manipulate Dexie stores (SessionRunner/skills handle that)
 */

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} intent                 // e.g. "garden.estimatePlan", "garden.generatePlan"
 * @property {Object} input                  // gardening-specific input payload
 * @property {Object} [runtime]              // runtime controls (budget overrides, cache, exportToHub, etc.)
 */

/**
 * @typedef {Object} ShimResponse
 * @property {boolean} ok
 * @property {string} mode                   // Reasoner mode used
 * @property {Object} data                   // normalized payload
 * @property {Array<Object>} [warnings]
 * @property {Array<Object>} [debug]
 */

import dayjs from "dayjs";
import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

// Reasoner runtime support
import { enforceBudget } from "@/reasoner/budget";
import { isGated } from "@/reasoner/gating";
import { checkConfidence } from "@/reasoner/confidence";
import { applyFreshnessRules } from "@/reasoner/freshness";
import { getCachedResponse, setCachedResponse } from "@/reasoner/cache/memo";
import { gardenShimKey } from "@/reasoner/cache/keys";
import { selectModeForIntent } from "@/reasoner/modes/map";
import { validateResponse } from "@/reasoner/modes/validate";
import { buildSystemPrompt } from "@/reasoner/prompts/system";
import { buildTemplatePrompt } from "@/reasoner/prompts/templates";
import { callReasoner } from "@/reasoner/core";

// Context selectors
import { selectGardenContext } from "@/services/selectors/gardenSelectors";

// Hub export (optional)
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

const isoNow = () => dayjs().toISOString();

/**
 * Normalize/alias intents coming from legacy callers.
 * @param {string} rawIntent
 * @returns {string}
 */
function normalizeIntent(rawIntent) {
  const intent = String(rawIntent || "")
    .trim()
    .toLowerCase();

  const map = {
    // legacy command aliases → canonical intents
    estimate: "garden.estimatePlan",
    estimateplan: "garden.estimatePlan",
    "garden.estimateplan": "garden.estimatePlan",

    plan: "garden.generatePlan",
    generate: "garden.generatePlan",
    generategardenplan: "garden.generatePlan",
    gardenplan: "garden.generatePlan",

    calendar: "garden.buildPlantingCalendar",
    planting: "garden.buildPlantingCalendar",

    beds: "garden.planBedsAndRotation",
    rotation: "garden.planBedsAndRotation",

    harvest: "garden.logHarvest",
    log: "garden.logHarvest",

    preserve: "garden.preservationPlanner",
    preservation: "garden.preservationPlanner",

    dashboard: "garden.getSeasonDashboard",

    storehouse: "garden.syncWithStorehouse",
    meal: "garden.syncWithMealPlanner",
    meals: "garden.syncWithMealPlanner",

    collab: "garden.buildCollaborativePlan",
    collaborative: "garden.buildCollaborativePlan",
  };

  if (map[intent]) return map[intent];

  // If already namespaced "garden.*", keep it
  if (intent.startsWith("garden.")) return intent;

  // Default: prefix with garden.
  return `garden.${intent}`;
}

/**
 * Cuisine-aware signal builder.
 * Combines:
 *  - Explicit cuisineProfile from input
 *  - mealPrefs (include/exclude crops, modes)
 *  - mealDemandWeights (crop demand scores)
 *  - any meal/cuisine info discovered via selectors
 *
 * @param {Object} input
 * @param {Object} context
 * @returns {{ cuisineProfile: Object, demandWeights: Object, notes: string[] }}
 */
function buildCuisineSignals(input = {}, context = {}) {
  const notes = [];

  const explicitProfile = input.cuisineProfile || {};
  const mealPrefs = input.mealPrefs || {};
  const mealDemandWeights = input.mealDemandWeights || {};

  const fromContext = context.mealDemandSignals || {};
  const contextProfile = fromContext.cuisineProfile || {};
  const contextWeights = fromContext.demandWeights || {};

  // Merge cuisine profiles (explicit overrides context)
  const cuisineProfile = {
    regionalCuisine:
      explicitProfile.regionalCuisine || contextProfile.regionalCuisine || null,
    preferredDishes:
      explicitProfile.preferredDishes || contextProfile.preferredDishes || [],
    weeklyMealPatterns:
      explicitProfile.weeklyMealPatterns ||
      contextProfile.weeklyMealPatterns ||
      [],
    spiceProfile:
      explicitProfile.spiceProfile || contextProfile.spiceProfile || [],
    heatPreference:
      explicitProfile.heatPreference || contextProfile.heatPreference || null,
    exclusions: explicitProfile.exclusions || contextProfile.exclusions || [],
  };

  if (cuisineProfile.regionalCuisine) {
    notes.push(`Cuisine: ${cuisineProfile.regionalCuisine}`);
  }
  if (cuisineProfile.preferredDishes?.length) {
    notes.push(
      `Preferred dishes: ${cuisineProfile.preferredDishes.join(", ")}`
    );
  }

  // Merge demand weights (additive, explicit overrides ties)
  const demandWeights = { ...contextWeights };
  for (const [k, v] of Object.entries(mealDemandWeights)) {
    demandWeights[k.toLowerCase()] = Number.isFinite(v) ? v : 0;
  }

  // If mealPrefs specify include/exclude, log them for Reasoner explanation/debugging
  if (Array.isArray(mealPrefs.includeCrops) && mealPrefs.includeCrops.length) {
    notes.push(`Include crops: ${mealPrefs.includeCrops.join(", ")}`);
  }
  if (Array.isArray(mealPrefs.excludeCrops) && mealPrefs.excludeCrops.length) {
    notes.push(`Exclude crops: ${mealPrefs.excludeCrops.join(", ")}`);
  }
  if (mealPrefs.mode) {
    notes.push(`Diet mode: ${mealPrefs.mode}`);
  }

  return { cuisineProfile, demandWeights, notes };
}

/**
 * Normalize Reasoner raw output into SSA garden payload.
 * This assumes the schema already validated the structure.
 *
 * @param {string} intent
 * @param {any} raw
 * @param {Object} cuisineSignals
 * @returns {{ data: Object, warnings: Object[], debug: Object[] }}
 */
function normalizeGardenOutput(intent, raw, cuisineSignals) {
  const warnings = [];
  const debug = [];

  if (!raw || typeof raw !== "object") {
    return {
      data: {
        summary: "Reasoner returned empty result.",
        calendarEvents: [],
        gardenUpdates: [],
        storehouseUpdates: [],
        mealPlanningHooks: [],
        cuisineTrace: cuisineSignals,
      },
      warnings: [
        {
          type: "emptyResult",
          message: "Reasoner returned no structured payload.",
        },
      ],
      debug,
    };
  }

  // Schema for garden.* modes should ensure these arrays exist (or are empty)
  const summary =
    raw.summary ||
    (intent === "garden.estimatePlan"
      ? "Garden estimate created."
      : intent === "garden.generatePlan"
      ? "Garden plan generated."
      : "Garden output ready.");

  const data = {
    summary,
    recommendations: Array.isArray(raw.recommendations)
      ? raw.recommendations
      : [],
    calendarEvents: Array.isArray(raw.calendarEvents) ? raw.calendarEvents : [],
    gardenUpdates: Array.isArray(raw.gardenUpdates) ? raw.gardenUpdates : [],
    storehouseUpdates: Array.isArray(raw.storehouseUpdates)
      ? raw.storehouseUpdates
      : [],
    mealPlanningHooks: Array.isArray(raw.mealPlanningHooks)
      ? raw.mealPlanningHooks
      : [],
    // Explicitly expose cuisine inputs so UI/plans can show “why” allocations were made
    cuisineTrace: cuisineSignals,
  };

  debug.push({
    type: "gardenShim.normalize",
    ts: isoNow(),
    intent,
    rawKeys: Object.keys(raw || {}),
  });

  return { data, warnings, debug };
}

/**
 * Main gardening shim entrypoint.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const startedAt = isoNow();

  // Defensive defaults
  const warnings = [];
  const debug = [];

  try {
    if (!req || typeof req !== "object") {
      return {
        ok: false,
        mode: "none",
        data: {},
        warnings: [{ type: "badRequest", message: "ShimRequest is required." }],
        debug,
      };
    }

    const domain = req.domain || "garden";
    const intent = normalizeIntent(req.intent || "");
    const input = req.input || {};
    const runtime = req.runtime || {};

    if (domain !== "garden") {
      return {
        ok: false,
        mode: "none",
        data: {},
        warnings: [
          {
            type: "badDomain",
            message: `Gardening shim only supports domain="garden", received "${domain}".`,
          },
        ],
        debug,
      };
    }

    // Emit "invoked" early for observability
    emit({
      type: "reasoner.invoked",
      ts: startedAt,
      source: "agents/shims/gardening",
      data: { intent, domain, runtime },
    });

    // Gating
    if (isGated({ domain, intent, runtime })) {
      warnings.push({
        type: "gated",
        message: `Reasoner calls gated for intent "${intent}".`,
      });
      emit({
        type: "reasoner.gated",
        ts: isoNow(),
        source: "agents/shims/gardening",
        data: { intent, domain },
      });
      return {
        ok: false,
        mode: "none",
        data: {},
        warnings,
        debug,
      };
    }

    // Mode selection
    const mode =
      selectModeForIntent({ domain, intent, input }) ||
      "garden.estimatePlan.v1";

    // Budget enforcement
    const budgetInfo = enforceBudget({ domain, intent, mode, runtime });
    if (!budgetInfo.ok) {
      warnings.push({
        type: "budgetExceeded",
        message: budgetInfo.message || "Budget exceeded for gardening shim.",
      });
      emit({
        type: "reasoner.budgetExceeded",
        ts: isoNow(),
        source: "agents/shims/gardening",
        data: { intent, domain, mode, budgetInfo },
      });
      return {
        ok: false,
        mode,
        data: {},
        warnings,
        debug,
      };
    }

    // Gather context (beds, frost, rotation history, storehouse snapshot, meal signals, etc.)
    const context = await selectGardenContext({ input, runtime, intent });
    debug.push({
      type: "context.loaded",
      ts: isoNow(),
      keys: Object.keys(context || {}),
    });

    // Build cuisine-aware signals
    const cuisineSignals = buildCuisineSignals(input, context);
    debug.push({
      type: "cuisineSignals",
      ts: isoNow(),
      cuisineProfile: cuisineSignals.cuisineProfile,
      demandWeightKeys: Object.keys(cuisineSignals.demandWeights || {}),
      notes: cuisineSignals.notes,
    });

    // Apply freshness rules (e.g. how old can context/weather/meal stats be?)
    const { context: freshContext, freshnessWarnings } = applyFreshnessRules({
      domain,
      intent,
      mode,
      context,
    });
    if (freshnessWarnings?.length) {
      warnings.push(...freshnessWarnings);
    }

    // Compose Reasoner input payload
    const reasonerPayload = {
      task: intent,
      domain,
      mode,
      // Raw user input (location, beds, crops, planGoals, rotationRules, etc.)
      input,
      // Contextual intelligence (frost dates, bed history, storehouse snapshot, etc.)
      context: freshContext,
      // Cuisine-aware preferences/signals
      cuisineProfile: cuisineSignals.cuisineProfile,
      mealPrefs: input.mealPrefs || {},
      demandWeights: cuisineSignals.demandWeights,
      cuisineNotes: cuisineSignals.notes,
      // Meta for explanation
      meta: {
        requestedAt: startedAt,
        familyFundMode: !!familyFundMode,
      },
    };

    // Cache key & lookup (memoization)
    const cacheKey = gardenShimKey({ intent, mode, payload: reasonerPayload });
    const cached = await getCachedResponse(cacheKey);
    if (cached) {
      emit({
        type: "reasoner.cachedHit",
        ts: isoNow(),
        source: "agents/shims/gardening",
        data: { intent, mode, cacheKey },
      });

      const {
        data,
        warnings: w2,
        debug: d2,
      } = normalizeGardenOutput(intent, cached, cuisineSignals);
      if (w2?.length) warnings.push(...w2);
      if (d2?.length) debug.push(...d2);

      return {
        ok: true,
        mode,
        data,
        warnings,
        debug,
      };
    }

    emit({
      type: "reasoner.cachedMiss",
      ts: isoNow(),
      source: "agents/shims/gardening",
      data: { intent, mode, cacheKey },
    });

    // Build prompts
    const systemPrompt = buildSystemPrompt({
      domain: "garden",
      mode,
      extra: {
        // Hard requirement: Reasoner must use cuisine signals in its planning logic,
        // not just ignore them.
        cuisineInstruction:
          "When selecting crops, allocating area, scheduling successions, and proposing preservation methods, " +
          "you MUST account for the household cuisineProfile, mealPrefs, and demandWeights. " +
          "Prioritize crops and timings that support the most common dishes, feast-day meals, and cultural cooking patterns. " +
          "Explain major allocation decisions in terms of cuisine when helpful.",
      },
    });

    const userPrompt = buildTemplatePrompt({
      domain: "garden",
      mode,
      intent,
      payload: reasonerPayload,
    });

    // Reasoner call
    const rawResult = await callReasoner({
      mode,
      systemPrompt,
      userPrompt,
      budget: budgetInfo,
      runtime,
    });

    // Confidence check
    const confidence = checkConfidence({
      domain,
      intent,
      mode,
      raw: rawResult,
    });
    if (!confidence.ok) {
      warnings.push({
        type: "lowConfidence",
        message:
          confidence.message ||
          "Reasoner confidence below threshold for gardening intent.",
      });
      emit({
        type: "reasoner.lowConfidence",
        ts: isoNow(),
        source: "agents/shims/gardening",
        data: { intent, mode, confidence },
      });
    }

    // Schema validation
    const validation = validateResponse({
      domain,
      intent,
      mode,
      raw: rawResult,
    });
    if (!validation.ok) {
      warnings.push({
        type: "invalidSchema",
        message:
          validation.message || "Reasoner output failed schema validation.",
        details: validation.errors || [],
      });

      emit({
        type: "reasoner.invalidSchema",
        ts: isoNow(),
        source: "agents/shims/gardening",
        data: { intent, mode, errors: validation.errors || [] },
      });

      return {
        ok: false,
        mode,
        data: {},
        warnings,
        debug,
      };
    }

    emit({
      type: "reasoner.validated",
      ts: isoNow(),
      source: "agents/shims/gardening",
      data: { intent, mode },
    });

    // Normalize shape into SSA garden structure
    const {
      data,
      warnings: w3,
      debug: d3,
    } = normalizeGardenOutput(intent, rawResult, cuisineSignals);
    if (w3?.length) warnings.push(...w3);
    if (d3?.length) debug.push(...d3);

    // Cache successful normalized result
    await setCachedResponse(cacheKey, rawResult);

    // Domain-level events
    emit({
      type:
        intent === "garden.estimatePlan"
          ? "garden.estimate.created"
          : intent === "garden.generatePlan"
          ? "garden.plan.generated"
          : "garden.output.ready",
      ts: isoNow(),
      source: "agents/shims/gardening",
      data: {
        intent,
        mode,
        summary: data.summary,
        cuisineProfile: cuisineSignals.cuisineProfile,
      },
    });

    // Optional Hub export (e.g. share garden plan/yield expectation with Family Fund hub)
    if (familyFundMode && runtime?.exportToHub) {
      try {
        const packet = HubPacketFormatter.formatGardenPlan({
          intent,
          mode,
          data,
          cuisineProfile: cuisineSignals.cuisineProfile,
          startedAt,
        });
        await FamilyFundConnector.export(packet);

        emit({
          type: "session.exported",
          ts: isoNow(),
          source: "agents/shims/gardening",
          data: { intent, mode, packetType: "gardenPlan" },
        });
      } catch (e) {
        warnings.push({
          type: "hubExportFailed",
          message:
            e?.message || "Failed to export garden plan to Family Fund Hub.",
        });
      }
    }

    // Final response
    return {
      ok: true,
      mode,
      data,
      warnings,
      debug,
    };
  } catch (err) {
    const message = err?.message || String(err);
    const stack = err?.stack || null;

    emit({
      type: "reasoner.error",
      ts: isoNow(),
      source: "agents/shims/gardening",
      data: { message, stack },
    });

    return {
      ok: false,
      mode: "none",
      data: {},
      warnings: [
        {
          type: "shimError",
          message,
        },
      ],
      debug: [
        ...debug,
        {
          type: "exception",
          ts: isoNow(),
          message,
          stack,
        },
      ],
    };
  }
}
