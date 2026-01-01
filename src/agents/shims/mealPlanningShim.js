// C:\Users\larho\suka-smart-assistant\src\agents\shims\mealPlanningShim.js

/**
 * Meal Planning Shim
 * ------------------
 * SSA-compliant shim that replaces the old mealPlanningAgent.
 *
 * Responsibilities:
 *  - Normalize incoming intents (list bundles, create-from-bundle, generate plan,
 *    crop demand weights, coalition sharing, meal trains, publishing, get current plan).
 *  - Select a Reasoner mode via modes/map.js.
 *  - Enforce gating & budget rules.
 *  - Load meal-planning context via selectors.
 *  - Apply freshness rules.
 *  - Optionally use cache.
 *  - Build prompts using system + templates.
 *  - Call the Reasoner core.
 *  - Validate Reasoner output against schemas.
 *  - Normalize the result into a stable Meal Planning payload.
 *  - Emit SSA Reasoner + domain events.
 *  - Optionally export to Hub when familyFundMode is enabled.
 *
 * This shim does NOT:
 *  - Own any UI logic, DOM access, Jobs engine, or Toast/NBA glue.
 *  - Directly call LLMs (uses Reasoner core instead).
 *  - Persist plans or inventory itself (that’s handled by other modules).
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

import { emit } from '@/services/eventBus';
import { familyFundMode } from '@/services/featureFlags';

// Reasoner runtime support
import { enforceBudget } from '@/services/reasoner/budget';
import { isGated } from '@/services/reasoner/gating';
import { checkConfidence } from '@/services/reasoner/confidence';
import { applyFreshnessRules } from '@/services/reasoner/freshness';
import { getCachedResponse, setCachedResponse } from '@/services/reasoner/cache/memo';
import { mealPlanningShimKey } from '@/services/reasoner/cache/keys';
import { selectModeForIntent } from '@/services/reasoner/modes/map';
import { validateResponse } from '@/services/reasoner/validate';
import { buildSystemPrompt } from '@/services/reasoner/prompts/system';
import { buildTemplatePrompt } from '@/services/reasoner/prompts/templates';
import { callReasoner } from '@/services/reasoner/core';

// Context selectors
import { selectMealPlanningContext } from '@/services/selectors/mealPlanningSelectors';

// Guards – use wrappers, no inline guard logic here
import { evaluateGuards } from '@/services/guards/guardsEvaluate';

// Hub export (optional)
import { HubPacketFormatter } from '@/services/hub/HubPacketFormatter';
import { FamilyFundConnector } from '@/services/hub/FamilyFundConnector';

const isoNow = () => new Date().toISOString();
const lower = (s) => (s == null ? '' : String(s).toLowerCase().trim());

/* ---------------------------------------------------------------------------
 * Intent normalization
 * ------------------------------------------------------------------------ */

/**
 * Normalize/alias intents coming from legacy callers.
 *
 * Old commands:
 *  - listBundles, bundles
 *  - createPlanFromBundle, create
 *  - getCropDemandWeights, weights
 *  - generatePlan, plan, generate
 *  - sharePlanToCoalition, coalitionshare
 *  - createMealTrain, mealtrain
 *  - publishPlanPreset, publish
 *  - getCurrentPlan, current
 *
 * Canonical intents:
 *  - mealPlanning.listBundles
 *  - mealPlanning.createFromBundle
 *  - mealPlanning.cropDemandWeights
 *  - mealPlanning.generatePlan
 *  - mealPlanning.shareToCoalition
 *  - mealPlanning.createMealTrain
 *  - mealPlanning.publishPreset
 *  - mealPlanning.getCurrentPlan
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeIntent(raw) {
  const s = lower(raw || '');

  const map = {
    listbundles: 'mealPlanning.listBundles',
    bundles: 'mealPlanning.listBundles',

    createplanfrombundle: 'mealPlanning.createFromBundle',
    create_plan_from_bundle: 'mealPlanning.createFromBundle',
    create: 'mealPlanning.createFromBundle',

    getcropdemandweights: 'mealPlanning.cropDemandWeights',
    get_crop_demand_weights: 'mealPlanning.cropDemandWeights',
    weights: 'mealPlanning.cropDemandWeights',

    generateplan: 'mealPlanning.generatePlan',
    generate: 'mealPlanning.generatePlan',
    plan: 'mealPlanning.generatePlan',

    shareplan_to_coalition: 'mealPlanning.shareToCoalition',
    sharecoalition: 'mealPlanning.shareToCoalition',
    coalitionshare: 'mealPlanning.shareToCoalition',

    mealtrain: 'mealPlanning.createMealTrain',
    createmealtrain: 'mealPlanning.createMealTrain',

    publishplanpreset: 'mealPlanning.publishPreset',
    publishplan: 'mealPlanning.publishPreset',
    publish: 'mealPlanning.publishPreset',

    getcurrentplan: 'mealPlanning.getCurrentPlan',
    current: 'mealPlanning.getCurrentPlan',
    get: 'mealPlanning.getCurrentPlan',
  };

  if (map[s]) return map[s];
  if (s.startsWith('mealplanning.')) return s;
  return `mealPlanning.${s}`;
}

/* ---------------------------------------------------------------------------
 * Normalization helpers
 * ------------------------------------------------------------------------ */

/**
 * Extract a top-level or nested property from Reasoner result with fallbacks.
 *
 * @param {any} raw
 * @param {string} key
 * @returns {any}
 */
function pick(raw, key) {
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw[key] !== undefined) return raw[key];
  if (raw.data && typeof raw.data === 'object' && raw.data[key] !== undefined) {
    return raw.data[key];
  }
  return undefined;
}

/**
 * Build a safe summary.
 *
 * @param {any} raw
 * @param {string} defaultSummary
 * @returns {string}
 */
function buildSummary(raw, defaultSummary) {
  if (raw && typeof raw.summary === 'string' && raw.summary.trim().length) {
    return raw.summary.trim();
  }
  if (raw && raw.data && typeof raw.data.summary === 'string' && raw.data.summary.trim().length) {
    return raw.data.summary.trim();
  }
  return defaultSummary;
}

/**
 * Normalize Reasoner raw output into SSA Meal Planning payload.
 *
 * Handles:
 *  - mealPlanning.listBundles
 *  - mealPlanning.createFromBundle
 *  - mealPlanning.generatePlan
 *  - mealPlanning.cropDemandWeights
 *  - mealPlanning.shareToCoalition
 *  - mealPlanning.createMealTrain
 *  - mealPlanning.publishPreset
 *  - mealPlanning.getCurrentPlan
 *
 * Assumes schema validation already passed.
 *
 * @param {string} intent
 * @param {any} raw
 * @returns {{ data: Object, warnings: Object[], debug: Object[] }}
 */
function normalizeMealPlanningOutput(intent, raw) {
  const warnings = [];
  const debug = [];

  if (!raw || typeof raw !== 'object') {
    return {
      data: {
        summary: 'Reasoner returned empty result for meal planning intent.',
        mealPlan: null,
        calendarEvents: [],
      },
      warnings: [
        {
          type: 'emptyResult',
          message: 'Reasoner returned no structured payload for meal planning intent.',
        },
      ],
      debug,
    };
  }

  const summary = buildSummary(
    raw,
    intent.startsWith('mealPlanning.')
      ? `Meal planning result for "${intent}".`
      : 'Meal planning result.',
  );

  /* ------------------------ listBundles ------------------------ */
  if (intent === 'mealPlanning.listBundles') {
    const bundles = Array.isArray(pick(raw, 'bundles')) ? pick(raw, 'bundles') : [];
    const mealPlanningUpdates =
      Array.isArray(pick(raw, 'mealPlanningUpdates')) ? pick(raw, 'mealPlanningUpdates') : [];

    const data = {
      summary,
      bundles,
      mealPlanningUpdates,
    };

    debug.push({
      type: 'mealPlanningShim.normalize.listBundles',
      ts: isoNow(),
      bundleCount: bundles.length,
      hasUpdates: mealPlanningUpdates.length > 0,
      rawKeys: Object.keys(raw || {}),
    });

    return { data, warnings, debug };
  }

  /* --------------------- createFromBundle ---------------------- */
  if (intent === 'mealPlanning.createFromBundle') {
    const mealPlan = pick(raw, 'mealPlan') || null;
    const calendarEvents = Array.isArray(pick(raw, 'calendarEvents')) ? pick(raw, 'calendarEvents') : [];
    const shoppingList = Array.isArray(pick(raw, 'shoppingList')) ? pick(raw, 'shoppingList') : [];
    const inventoryUpdates =
      Array.isArray(pick(raw, 'inventoryUpdates')) ? pick(raw, 'inventoryUpdates') : [];
    const mealPlanningUpdates =
      Array.isArray(pick(raw, 'mealPlanningUpdates')) ? pick(raw, 'mealPlanningUpdates') : [];
    const gardenUpdates =
      Array.isArray(pick(raw, 'gardenUpdates')) ? pick(raw, 'gardenUpdates') : [];

    const data = {
      summary,
      mealPlan,
      calendarEvents,
      shoppingList,
      inventoryUpdates,
      mealPlanningUpdates,
      gardenUpdates,
    };

    debug.push({
      type: 'mealPlanningShim.normalize.createFromBundle',
      ts: isoNow(),
      hasPlan: !!mealPlan,
      eventCount: calendarEvents.length,
      shoppingCount: shoppingList.length,
      inventoryCount: inventoryUpdates.length,
      rawKeys: Object.keys(raw || {}),
    });

    return { data, warnings, debug };
  }

  /* ----------------------- generatePlan ------------------------ */
  if (intent === 'mealPlanning.generatePlan') {
    const mealPlan = pick(raw, 'mealPlan') || pick(raw, 'plan') || null;
    const calendarEvents =
      Array.isArray(pick(raw, 'calendarEvents')) ? pick(raw, 'calendarEvents') : [];
    const inventoryUpdates =
      Array.isArray(pick(raw, 'inventoryUpdates')) ? pick(raw, 'inventoryUpdates') : [];
    const mealPlanningUpdates =
      Array.isArray(pick(raw, 'mealPlanningUpdates')) ? pick(raw, 'mealPlanningUpdates') : [];
    const nutritionFlags = Array.isArray(pick(raw, 'nutritionFlags'))
      ? pick(raw, 'nutritionFlags')
      : Array.isArray(pick(raw, '_nutritionFlags'))
      ? pick(raw, '_nutritionFlags')
      : [];
    const macroSummary = pick(raw, 'macroSummary') || pick(raw, '_macroSummary') || null;
    const draftId = pick(raw, 'draftId') || null;
    const persisted = !!pick(raw, 'persisted');

    const data = {
      summary,
      mealPlan,
      calendarEvents,
      inventoryUpdates,
      mealPlanningUpdates,
      nutritionFlags,
      macroSummary,
      draftId,
      persisted,
    };

    debug.push({
      type: 'mealPlanningShim.normalize.generatePlan',
      ts: isoNow(),
      hasPlan: !!mealPlan,
      eventCount: calendarEvents.length,
      inventoryCount: inventoryUpdates.length,
      nutritionFlagsCount: nutritionFlags.length,
      hasMacroSummary: !!macroSummary,
      draftId,
      persisted,
      rawKeys: Object.keys(raw || {}),
    });

    return { data, warnings, debug };
  }

  /* ------------------- cropDemandWeights ----------------------- */
  if (intent === 'mealPlanning.cropDemandWeights') {
    const weights = pick(raw, 'weights') || {};
    const gardenUpdates =
      Array.isArray(pick(raw, 'gardenUpdates')) ? pick(raw, 'gardenUpdates') : [];

    const data = {
      summary,
      weights,
      gardenUpdates,
    };

    debug.push({
      type: 'mealPlanningShim.normalize.cropDemandWeights',
      ts: isoNow(),
      cropCount: Object.keys(weights || {}).length,
      hasUpdates: gardenUpdates.length > 0,
      rawKeys: Object.keys(raw || {}),
    });

    return { data, warnings, debug };
  }

  /* --------------------- shareToCoalition ----------------------- */
  if (intent === 'mealPlanning.shareToCoalition') {
    const mealPlan = pick(raw, 'mealPlan') || null;
    const coalition = pick(raw, 'coalition') || null;

    const data = {
      summary,
      mealPlan,
      coalition,
    };

    debug.push({
      type: 'mealPlanningShim.normalize.shareToCoalition',
      ts: isoNow(),
      hasPlan: !!mealPlan,
      hasCoalition: !!coalition,
      rawKeys: Object.keys(raw || {}),
    });

    return { data, warnings, debug };
  }

  /* ---------------------- createMealTrain ----------------------- */
  if (intent === 'mealPlanning.createMealTrain') {
    const calendarEvents =
      Array.isArray(pick(raw, 'calendarEvents')) ? pick(raw, 'calendarEvents') : [];
    const coalition = pick(raw, 'coalition') || null;

    const data = {
      summary,
      calendarEvents,
      coalition,
    };

    debug.push({
      type: 'mealPlanningShim.normalize.createMealTrain',
      ts: isoNow(),
      eventCount: calendarEvents.length,
      hasCoalition: !!coalition,
      rawKeys: Object.keys(raw || {}),
    });

    return { data, warnings, debug };
  }

  /* ------------------------ publishPreset ------------------------ */
  if (intent === 'mealPlanning.publishPreset') {
    const mealPlan = pick(raw, 'mealPlan') || null;
    const marketplace = pick(raw, 'marketplace') || null;

    const data = {
      summary,
      mealPlan,
      marketplace,
    };

    debug.push({
      type: 'mealPlanningShim.normalize.publishPreset',
      ts: isoNow(),
      hasPlan: !!mealPlan,
      hasMarketplaceMeta: !!marketplace,
      rawKeys: Object.keys(raw || {}),
    });

    return { data, warnings, debug };
  }

  /* ------------------------ getCurrentPlan ----------------------- */
  if (intent === 'mealPlanning.getCurrentPlan') {
    const mealPlan = pick(raw, 'mealPlan') || pick(raw, 'plan') || null;

    const data = {
      summary,
      mealPlan,
    };

    debug.push({
      type: 'mealPlanningShim.normalize.getCurrentPlan',
      ts: isoNow(),
      hasPlan: !!mealPlan,
      rawKeys: Object.keys(raw || {}),
    });

    return { data, warnings, debug };
  }

  /* -------------------------- fallback --------------------------- */
  const data = {
    summary,
    raw,
  };

  debug.push({
    type: 'mealPlanningShim.normalize.fallback',
    ts: isoNow(),
    intent,
    rawKeys: Object.keys(raw || {}),
  });

  return { data, warnings, debug };
}

/* ---------------------------------------------------------------------------
 * Main shim entrypoint
 * ------------------------------------------------------------------------ */

/**
 * Main Meal Planning Shim entrypoint.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const startedAt = isoNow();
  const warnings = [];
  const debug = [];

  try {
    if (!req || typeof req !== 'object') {
      return {
        ok: false,
        mode: 'none',
        data: {},
        warnings: [
          {
            type: 'badRequest',
            message: 'ShimRequest is required and must be an object.',
          },
        ],
        debug,
      };
    }

    const domain = req.domain || 'cooking';
    const intent = normalizeIntent(req.intent || '');
    const input = req.input || {};
    const runtime = req.runtime || {};

    if (domain !== 'cooking') {
      return {
        ok: false,
        mode: 'none',
        data: {},
        warnings: [
          {
            type: 'badDomain',
            message: `Meal Planning Shim only supports domain="cooking", received "${domain}".`,
          },
        ],
        debug,
      };
    }

    // Initial invocation event
    emit({
      type: 'reasoner.invoked',
      ts: startedAt,
      source: 'agents/shims/mealPlanning',
      data: { intent, domain, runtime },
    });

    // Gating
    if (isGated({ domain, intent, runtime })) {
      warnings.push({
        type: 'gated',
        message: `Reasoner calls gated for intent "${intent}".`,
      });

      emit({
        type: 'reasoner.gated',
        ts: isoNow(),
        source: 'agents/shims/mealPlanning',
        data: { intent, domain },
      });

      return {
        ok: false,
        mode: 'none',
        data: {},
        warnings,
        debug,
      };
    }

    // Mode selection
    const mode =
      selectModeForIntent({
        domain,
        intent,
        input,
      }) || 'mealPlanning.generatePlan.v1';

    // Budget enforcement
    const budgetInfo = enforceBudget({ domain, intent, mode, runtime });
    if (!budgetInfo.ok) {
      warnings.push({
        type: 'budgetExceeded',
        message: budgetInfo.message || 'Budget exceeded for Meal Planning Shim.',
      });

      emit({
        type: 'reasoner.budgetExceeded',
        ts: isoNow(),
        source: 'agents/shims/mealPlanning',
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

    // Load context (recipes, inventory, bundles, user prefs, coalitions, etc.)
    const context = await selectMealPlanningContext({ intent, input, runtime });

    debug.push({
      type: 'context.loaded',
      ts: isoNow(),
      keys: Object.keys(context || {}),
    });

    // Freshness rules
    const { context: freshContext, freshnessWarnings } = applyFreshnessRules({
      domain,
      intent,
      mode,
      context,
    });
    if (freshnessWarnings?.length) warnings.push(...freshnessWarnings);

    // Compose Reasoner payload
    const reasonerPayload = {
      task: intent,
      domain,
      mode,
      input,
      context: freshContext,
      meta: {
        requestedAt: startedAt,
        familyFundMode: !!familyFundMode,
      },
    };

    // Cache lookup
    const cacheKey = mealPlanningShimKey({ intent, mode, payload: reasonerPayload });
    const cached = await getCachedResponse(cacheKey);
    if (cached) {
      emit({
        type: 'reasoner.cachedHit',
        ts: isoNow(),
        source: 'agents/shims/mealPlanning',
        data: { intent, mode, cacheKey },
      });

      const { data, warnings: w2, debug: d2 } = normalizeMealPlanningOutput(intent, cached);
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
      type: 'reasoner.cachedMiss',
      ts: isoNow(),
      source: 'agents/shims/mealPlanning',
      data: { intent, mode, cacheKey },
    });

    // Build prompts
    const systemPrompt = buildSystemPrompt({
      domain: 'cooking',
      mode,
      extra: {
        mealPlanningInstruction:
          'You are the Suka Smart Assistant Meal Planning engine. ' +
          'Use recipes, inventory, user preferences, bundles, coalition data, and past plans ' +
          'to build structured meal plans and related analytics. ' +
          'Respect dietary restrictions, budget hints, and family size. ' +
          'Return STRICT JSON matching the schema for the selected mode (see modes/schemas).',
      },
    });

    const userPrompt = buildTemplatePrompt({
      domain: 'cooking',
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
        type: 'lowConfidence',
        message:
          confidence.message ||
          'Reasoner confidence below threshold for meal planning intent.',
      });

      emit({
        type: 'reasoner.lowConfidence',
        ts: isoNow(),
        source: 'agents/shims/mealPlanning',
        data: { intent, mode, confidence },
      });
    }

    // Schema validation
    const validation = validateResponse({ domain, intent, mode, raw: rawResult });
    if (!validation.ok) {
      warnings.push({
        type: 'invalidSchema',
        message: validation.message || 'Reasoner output failed schema validation.',
        details: validation.errors || [],
      });

      emit({
        type: 'reasoner.invalidSchema',
        ts: isoNow(),
        source: 'agents/shims/mealPlanning',
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
      type: 'reasoner.validated',
      ts: isoNow(),
      source: 'agents/shims/mealPlanning',
      data: { intent, mode },
    });

    // Guard evaluation (e.g., Sabbath / quiet hours / inventory / weather / battery)
    const guarded = evaluateGuards({
      domain,
      intent,
      mode,
      output: rawResult,
      context: freshContext,
    });

    // Normalize into SSA Meal Planning payload
    const { data, warnings: w3, debug: d3 } = normalizeMealPlanningOutput(intent, guarded);
    if (w3?.length) warnings.push(...w3);
    if (d3?.length) debug.push(...d3);

    // Cache raw result (pre-normalization or post-guards – here we cache pre-normalized guarded)
    await setCachedResponse(cacheKey, guarded);

    // Domain-level event
    let domainEventType = 'mealPlanning.output.ready';
    if (intent === 'mealPlanning.listBundles') domainEventType = 'mealPlanning.bundles.listed';
    if (intent === 'mealPlanning.createFromBundle') domainEventType = 'mealPlanning.plan.createdFromBundle';
    if (intent === 'mealPlanning.generatePlan') domainEventType = 'mealPlanning.plan.generated';
    if (intent === 'mealPlanning.cropDemandWeights') domainEventType = 'mealPlanning.cropDemandWeights.computed';
    if (intent === 'mealPlanning.shareToCoalition') domainEventType = 'mealPlanning.coalition.shared';
    if (intent === 'mealPlanning.createMealTrain') domainEventType = 'mealPlanning.mealTrain.created';
    if (intent === 'mealPlanning.publishPreset') domainEventType = 'mealPlanning.plan.published';
    if (intent === 'mealPlanning.getCurrentPlan') domainEventType = 'mealPlanning.currentPlan.loaded';

    emit({
      type: domainEventType,
      ts: isoNow(),
      source: 'agents/shims/mealPlanning',
      data: {
        intent,
        mode,
        summary: data.summary,
      },
    });

    // Optional Hub export for generated plans & bundle plans
    const isExportableIntent =
      intent === 'mealPlanning.generatePlan' ||
      intent === 'mealPlanning.createFromBundle';

    if (familyFundMode && runtime?.exportToHub && isExportableIntent) {
      try {
        const packet = HubPacketFormatter.formatMealPlanning({
          intent,
          mode,
          data,
          startedAt,
        });

        await FamilyFundConnector.export(packet);

        emit({
          type: 'session.exported',
          ts: isoNow(),
          source: 'agents/shims/mealPlanning',
          data: { intent, mode, packetType: 'mealPlanning' },
        });
      } catch (e) {
        warnings.push({
          type: 'hubExportFailed',
          message: e?.message || 'Failed to export meal planning data to Family Fund Hub.',
        });
      }
    }

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
      type: 'reasoner.error',
      ts: isoNow(),
      source: 'agents/shims/mealPlanning',
      data: { message, stack },
    });

    return {
      ok: false,
      mode: 'none',
      data: {},
      warnings: [
        {
          type: 'shimError',
          message,
        },
      ],
      debug: [
        ...debug,
        {
          type: 'exception',
          ts: isoNow(),
          message,
          stack,
        },
      ],
    };
  }
}

/* ---------------------------------------------------------------------------
 * Legacy-compatible wrappers
 * ------------------------------------------------------------------------ */

/**
 * Legacy-style command router.
 *
 * Examples:
 *   handleCommand("listBundles")
 *   handleCommand("generatePlan", payload)
 *   handleCommand({ command: "createPlanFromBundle", payload })
 *
 * Always returns a ShimResponse.
 *
 * @param {string|Object} command
 * @param {Object} [payload]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}) {
  let cmdStr = command;

  if (typeof command === 'object' && command) {
    if (command.payload && !Object.keys(payload || {}).length) {
      // eslint-disable-next-line no-param-reassign
      payload = command.payload;
    }
    cmdStr = command.command || command.type || 'generatePlan';
  }

  const normalizedIntent = normalizeIntent(cmdStr || '');

  return invokeShim({
    domain: 'cooking',
    intent: normalizedIntent,
    input: payload,
    runtime: payload.runtime || {},
  });
}

/**
 * The following helpers mirror the original top-level functions but
 * now route everything through the shim/Reasoner pipeline.
 * Each returns a ShimResponse.
 */

export async function listBundles(input = {}) {
  return invokeShim({
    domain: 'cooking',
    intent: 'mealPlanning.listBundles',
    input,
    runtime: input.runtime || {},
  });
}

export async function createPlanFromBundle(input = {}) {
  return invokeShim({
    domain: 'cooking',
    intent: 'mealPlanning.createFromBundle',
    input,
    runtime: input.runtime || {},
  });
}

export async function getCropDemandWeights(input = {}) {
  return invokeShim({
    domain: 'cooking',
    intent: 'mealPlanning.cropDemandWeights',
    input,
    runtime: input.runtime || {},
  });
}

export async function generateMealPlan(input = {}) {
  return invokeShim({
    domain: 'cooking',
    intent: 'mealPlanning.generatePlan',
    input,
    runtime: input.runtime || {},
  });
}

export async function sharePlanToCoalition(input = {}) {
  return invokeShim({
    domain: 'cooking',
    intent: 'mealPlanning.shareToCoalition',
    input,
    runtime: input.runtime || {},
  });
}

export async function createMealTrain(input = {}) {
  return invokeShim({
    domain: 'cooking',
    intent: 'mealPlanning.createMealTrain',
    input,
    runtime: input.runtime || {},
  });
}

export async function publishPlanPreset(input = {}) {
  return invokeShim({
    domain: 'cooking',
    intent: 'mealPlanning.publishPreset',
    input,
    runtime: input.runtime || {},
  });
}

export async function getCurrentPlan(input = {}) {
  return invokeShim({
    domain: 'cooking',
    intent: 'mealPlanning.getCurrentPlan',
    input,
    runtime: input.runtime || {},
  });
}

/**
 * Default export (for compatibility with `default { ... }` agent style).
 */
const mealPlanningShim = {
  invokeShim,
  handleCommand,
  listBundles,
  createPlanFromBundle,
  getCropDemandWeights,
  generateMealPlan,
  sharePlanToCoalition,
  createMealTrain,
  publishPlanPreset,
  getCurrentPlan,
};

export default mealPlanningShim;
