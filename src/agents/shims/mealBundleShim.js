// C:\Users\larho\suka-smart-assistant\src\agents\shims\mealBundleShim.js

/**
 * Meal Bundle Shim
 * ----------------
 * Shim around the Reasoner for:
 *  - Weekly/monthly meal bundles (breakfast / lunch / dinner / snacks)
 *  - Archetype selection (Torah, dairy-free, vegetarian, low-carb, keto)
 *  - Leftovers scheduling and tag-based slot rules
 *
 * It replaces the old mealBundleAgent by:
 *  - Accepting cooking-related intents (mealBundle.listArchetypes, mealBundle.generate)
 *  - Pulling cooking context (recipes, inventory, prefs) from selectors
 *  - Providing archetypes + slot rules as *hints* to the Reasoner (no hard-coded planning)
 *  - Selecting a Reasoner mode, building prompts, enforcing budget/gating
 *  - Validating Reasoner output against schemas
 *  - Normalizing into SSA meal-bundle payloads
 *  - Emitting standard Reasoner events and optional Hub export
 *
 * This shim does NOT:
 *  - Touch UI / DOM
 *  - Show toasts or call Glue
 *  - Directly mutate inventory or session DB
 *  - Manage timers or SessionRunner
 */

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} intent                 // e.g. "mealBundle.generate"
 * @property {Object} input                  // meal-bundle-specific input payload
 * @property {Object} [runtime]              // budget overrides, cache, exportToHub, etc.
 */

/**
 * @typedef {Object} ShimResponse
 * @property {boolean} ok
 * @property {string} mode                   // Reasoner mode used
 * @property {Object} data                   // normalized payload
 * @property {Array<Object>} [warnings]
 * @property {Array<Object>} [debug]
 */

import dayjs from 'dayjs';
import { emit } from '@/services/eventBus';
import { familyFundMode } from '@/services/featureFlags';

// Reasoner runtime support
import { enforceBudget } from '@/services/reasoner/budget';
import { isGated } from '@/services/reasoner/gating';
import { checkConfidence } from '@/services/reasoner/confidence';
import { applyFreshnessRules } from '@/services/reasoner/freshness';
import { getCachedResponse, setCachedResponse } from '@/services/reasoner/cache/memo';
import { mealBundleShimKey } from '@/services/reasoner/cache/keys';
import { selectModeForIntent } from '@/services/reasoner/modes/map';
import { validateResponse } from '@/services/reasoner/validate';
import { buildSystemPrompt } from '@/services/reasoner/prompts/system';
import { buildTemplatePrompt } from '@/services/reasoner/prompts/templates';
import { callReasoner } from '@/services/reasoner/core';

// Context selectors
import { selectCookingContext } from '@/services/selectors/cookingSelectors';

// Hub export (optional)
import { HubPacketFormatter } from '@/services/hub/HubPacketFormatter';
import { FamilyFundConnector } from '@/services/hub/FamilyFundConnector';

const isoNow = () => dayjs().toISOString();
const lower = (s) => (s == null ? '' : String(s).toLowerCase().trim());
const uid = () => Math.random().toString(36).slice(2);

/* ---------------------------------------------------------------------------
 * Archetypes (dietary patterns) – provided as hints, not hard-coded behavior
 * ------------------------------------------------------------------------ */

const ARCHETYPES = [
  {
    key: 'torah',
    label: 'Torah-compliant (Israelite home)',
    description:
      'Fresh bread weekly; lamb/goat/organ meats present; legumes & leafy greens frequent; one leftovers day.',
    leftoversDay: 6, // 0=Mon … 6=Sun
    rules: {
      breakfast: {
        includeTags: ['bread', 'grain', 'porridge', 'egg'],
        avoidTags: ['pork'],
      },
      lunch: {
        includeTags: ['legume', 'lentil', 'pea', 'bean', 'salad', 'greens'],
        avoidTags: ['pork', 'shellfish'],
      },
      dinner: {
        includeTags: ['lamb', 'goat', 'fish', 'chicken', 'greens', 'organ-meat'],
        avoidTags: ['pork', 'shellfish'],
      },
      snacks: {
        includeTags: ['fruit', 'nut', 'olive', 'seed'],
        avoidTags: [],
      },
    },
  },
  {
    key: 'dairyfree',
    label: 'Dairy-Free',
    description: 'No dairy in any slot; weekly leftovers.',
    leftoversDay: 6,
    rules: {
      breakfast: {
        includeTags: ['breakfast', 'oats', 'egg', 'smoothie'],
        avoidTags: ['dairy'],
      },
      lunch: {
        includeTags: ['soup', 'salad', 'wrap', 'bowl'],
        avoidTags: ['dairy'],
      },
      dinner: {
        includeTags: ['chicken', 'turkey', 'beef', 'fish', 'stew'],
        avoidTags: ['dairy'],
      },
      snacks: {
        includeTags: ['fruit', 'nut', 'seed'],
        avoidTags: ['dairy'],
      },
    },
  },
  {
    key: 'vegetarian',
    label: 'Vegetarian',
    description: 'Meatless meals; weekly leftovers.',
    leftoversDay: 6,
    rules: {
      breakfast: {
        includeTags: ['breakfast', 'oats', 'egg', 'pancake'],
        avoidTags: ['meat', 'fish'],
      },
      lunch: {
        includeTags: ['salad', 'soup', 'grain', 'pasta', 'wrap'],
        avoidTags: ['meat', 'fish'],
      },
      dinner: {
        includeTags: ['curry', 'stir-fry', 'pasta', 'legume'],
        avoidTags: ['meat', 'fish'],
      },
      snacks: {
        includeTags: ['fruit', 'nut', 'yogurt', 'veg'],
        avoidTags: [],
      },
    },
  },
  {
    key: 'lowcarb',
    label: 'Low-Carb / Low Sugar',
    description: 'Lower carbs and sugar across all slots; weekly leftovers.',
    leftoversDay: 6,
    rules: {
      breakfast: {
        includeTags: ['egg', 'greens', 'protein'],
        avoidTags: ['sugar', 'grain'],
      },
      lunch: {
        includeTags: ['salad', 'bowl', 'protein'],
        avoidTags: ['sugar', 'grain'],
      },
      dinner: {
        includeTags: ['protein', 'steak', 'chicken', 'fish'],
        avoidTags: ['sugar', 'grain'],
      },
      snacks: {
        includeTags: ['nut', 'cheese', 'olive'],
        avoidTags: ['sugar'],
      },
    },
  },
  {
    key: 'keto',
    label: 'Keto',
    description: 'Very low carb/high fat; weekly leftovers.',
    leftoversDay: 6,
    rules: {
      breakfast: {
        includeTags: ['egg', 'bacon', 'avocado', 'keto'],
        avoidTags: ['sugar', 'grain'],
      },
      lunch: {
        includeTags: ['bowl', 'salad', 'burger-bowl', 'keto'],
        avoidTags: ['sugar', 'grain'],
      },
      dinner: {
        includeTags: ['keto', 'fatty-fish', 'lamb', 'butter-sauce'],
        avoidTags: ['sugar', 'grain'],
      },
      snacks: {
        includeTags: ['nut', 'cheese', 'olive', 'pork-rind'],
        avoidTags: ['sugar'],
      },
    },
  },
];

/**
 * Public helper (legacy-compatible): list archetypes.
 */
export function listArchetypes() {
  return ARCHETYPES.map(({ key, label, description }) => ({ key, label, description }));
}

/* ---------------------------------------------------------------------------
 * Intent normalization
 * ------------------------------------------------------------------------ */

/**
 * Normalize/alias intents coming from legacy callers.
 * - Old commands: list, archetypes, generate, bundle, generateBundle
 * - New canonical intents: mealBundle.listArchetypes, mealBundle.generate
 *
 * @param {string} rawIntentOrCommand
 * @returns {string}
 */
function normalizeIntent(rawIntentOrCommand) {
  const s = lower(rawIntentOrCommand || '');

  const map = {
    list: 'mealBundle.listArchetypes',
    archetypes: 'mealBundle.listArchetypes',
    'mealbundle.listarchetypes': 'mealBundle.listArchetypes',

    generate: 'mealBundle.generate',
    bundle: 'mealBundle.generate',
    generatebundle: 'mealBundle.generate',
    'mealbundle.generate': 'mealBundle.generate',
  };

  if (map[s]) return map[s];

  if (s.startsWith('mealbundle.')) return s;
  return `mealBundle.${s}`;
}

/* ---------------------------------------------------------------------------
 * Hints and helpers
 * ------------------------------------------------------------------------ */

/**
 * Build structured meal-bundle hints to pass into the Reasoner.
 * These are *hints*, not deterministic behavior. The Reasoner is free
 * to deviate but should explain why when it does.
 *
 * @returns {{ archetypes: Array, defaultSlots: string[] }}
 */
function buildMealBundleHints() {
  return {
    archetypes: ARCHETYPES,
    defaultSlots: ['breakfast', 'lunch', 'dinner', 'snacks'],
  };
}

/**
 * Fallback helper: if Reasoner returns only a "seed" (bundleKey + days),
 * we can deterministically derive calendar events and a simple "plan"
 * to remain compatible with the old agent’s shape.
 *
 * @param {{ bundleKey: string, start: string, days: Array<{date:string,leftovers?:boolean,meals:any[]}> }} seed
 * @returns {{ events: Array, plan: Array }}
 */
function toEventsFromSeed(seed) {
  const events = [];
  const plan = [];

  if (!seed || !Array.isArray(seed.days)) {
    return { events, plan };
  }

  for (const day of seed.days) {
    const date = day.date;
    const dayPlan = {
      date,
      leftovers: !!day.leftovers,
      meals: [],
    };

    for (const m of day.meals || []) {
      const id = uid();
      events.push({
        id,
        title: m.title,
        start: date,
        allDay: true,
        extendedProps: {
          meal: m.time, // 'breakfast' | 'lunch' | 'dinner' | 'snacks'
          leftovers: !!day.leftovers,
          recipeId: m.recipeId || null,
        },
      });
      dayPlan.meals.push({
        id,
        time: m.time,
        title: m.title,
        recipeId: m.recipeId || null,
      });
    }

    plan.push(dayPlan);
  }

  return { events, plan };
}

/* ---------------------------------------------------------------------------
 * Normalization
 * ------------------------------------------------------------------------ */

/**
 * Normalize Reasoner raw output into SSA meal-bundle payload.
 * Handles:
 *  - mealBundle.listArchetypes
 *  - mealBundle.generate
 *
 * Assumes schema validation has already passed.
 *
 * @param {string} intent
 * @param {any} raw
 * @returns {{ data: Object, warnings: Object[], debug: Object[] }}
 */
function normalizeMealBundleOutput(intent, raw) {
  const warnings = [];
  const debug = [];

  if (!raw || typeof raw !== 'object') {
    return {
      data: {
        summary: 'Reasoner returned empty result.',
        archetypes: [],
        seed: null,
        events: [],
        plan: [],
      },
      warnings: [
        {
          type: 'emptyResult',
          message: 'Reasoner returned no structured payload for meal bundle intent.',
        },
      ],
      debug,
    };
  }

  const baseSummary =
    raw.summary ||
    (intent === 'mealBundle.listArchetypes'
      ? 'Meal bundle archetypes listed.'
      : intent === 'mealBundle.generate'
      ? 'Meal bundle generated.'
      : 'Meal bundle output ready.');

  // LIST ARCHETYPES
  if (intent === 'mealBundle.listArchetypes') {
    const archetypesFromModel = Array.isArray(raw.archetypes) ? raw.archetypes : null;
    const archList = archetypesFromModel && archetypesFromModel.length
      ? archetypesFromModel
      : listArchetypes();

    const data = {
      summary: baseSummary,
      archetypes: archList,
    };

    debug.push({
      type: 'mealBundleShim.normalize.list',
      ts: isoNow(),
      rawKeys: Object.keys(raw || {}),
      archetypeCount: archList.length,
    });

    return { data, warnings, debug };
  }

  // GENERATE BUNDLE
  if (intent === 'mealBundle.generate') {
    const archetype =
      raw.archetype && typeof raw.archetype === 'object'
        ? raw.archetype
        : raw.data?.archetype && typeof raw.data.archetype === 'object'
        ? raw.data.archetype
        : null;

    const seed =
      raw.seed && typeof raw.seed === 'object'
        ? raw.seed
        : raw.data?.seed && typeof raw.data.seed === 'object'
        ? raw.data.seed
        : null;

    let events =
      Array.isArray(raw.events) && raw.events.length
        ? raw.events
        : Array.isArray(raw.data?.events) && raw.data.events.length
        ? raw.data.events
        : [];

    let plan =
      Array.isArray(raw.plan) && raw.plan.length
        ? raw.plan
        : Array.isArray(raw.data?.plan) && raw.data.plan.length
        ? raw.data.plan
        : [];

    // If the Reasoner only returned a seed, derive events/plan to keep compatibility.
    if ((!events.length || !plan.length) && seed && Array.isArray(seed.days)) {
      const derived = toEventsFromSeed(seed);
      if (!events.length) events = derived.events;
      if (!plan.length) plan = derived.plan;
    }

    const nextBestAction =
      raw.nextBestAction && typeof raw.nextBestAction === 'object'
        ? raw.nextBestAction
        : null;

    if (raw.nextBestAction && typeof raw.nextBestAction !== 'object') {
      warnings.push({
        type: 'invalidNextBestAction',
        message:
          'nextBestAction must be an object or null; Reasoner returned a non-object, dropping it.',
      });
    }

    const data = {
      summary: baseSummary,
      archetype,
      seed,
      events,
      plan,
      nextBestAction,
    };

    debug.push({
      type: 'mealBundleShim.normalize.generate',
      ts: isoNow(),
      rawKeys: Object.keys(raw || {}),
      hasSeed: !!seed,
      eventCount: events.length,
      planDays: plan.length,
    });

    return { data, warnings, debug };
  }

  // Fallback for unknown intents
  const data = {
    summary: baseSummary,
    raw,
  };

  debug.push({
    type: 'mealBundleShim.normalize.fallback',
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
 * Main Meal Bundle Shim entrypoint.
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
          { type: 'badRequest', message: 'ShimRequest is required and must be an object.' },
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
            message: `Meal bundle shim only supports domain="cooking", received "${domain}".`,
          },
        ],
        debug,
      };
    }

    // Emit early invocation event
    emit({
      type: 'reasoner.invoked',
      ts: startedAt,
      source: 'agents/shims/mealBundle',
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
        source: 'agents/shims/mealBundle',
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

    // Mode selection (e.g. mealBundle.generate.v1, mealBundle.listArchetypes.v1)
    const mode =
      selectModeForIntent({
        domain,
        intent,
        input,
      }) || 'mealBundle.generate.v1';

    // Budget enforcement
    const budgetInfo = enforceBudget({ domain, intent, mode, runtime });
    if (!budgetInfo.ok) {
      warnings.push({
        type: 'budgetExceeded',
        message: budgetInfo.message || 'Budget exceeded for meal bundle shim.',
      });

      emit({
        type: 'reasoner.budgetExceeded',
        ts: isoNow(),
        source: 'agents/shims/mealBundle',
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

    // Pull context (recipes, inventory, dietary prefs, calendar, etc.)
    const context = await selectCookingContext({ input, runtime, intent });

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

    // Build meal bundle hints
    const mealBundleHints = buildMealBundleHints();

    // Compose Reasoner payload
    const reasonerPayload = {
      task: intent,
      domain,
      mode,
      input,
      context: freshContext,
      hints: {
        mealBundle: mealBundleHints,
      },
      meta: {
        requestedAt: startedAt,
        familyFundMode: !!familyFundMode,
      },
    };

    // Cache key + lookup
    const cacheKey = mealBundleShimKey({ intent, mode, payload: reasonerPayload });
    const cached = await getCachedResponse(cacheKey);
    if (cached) {
      emit({
        type: 'reasoner.cachedHit',
        ts: isoNow(),
        source: 'agents/shims/mealBundle',
        data: { intent, mode, cacheKey },
      });

      const { data, warnings: w2, debug: d2 } = normalizeMealBundleOutput(intent, cached);
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
      source: 'agents/shims/mealBundle',
      data: { intent, mode, cacheKey },
    });

    // Build prompts
    const systemPrompt = buildSystemPrompt({
      domain: 'cooking',
      mode,
      extra: {
        mealBundleInstruction:
          'You are a household meal planner. Use the archetype hints (dietary rules, leftoversDay, slot rules) ' +
          'and cooking context (recipes, tags, inventory, preferences) to generate a structured meal bundle. ' +
          'Keep dates and slots stable, respect user avoidTags, and prefer recipe IDs when available. ' +
          'If you only output a seed (bundleKey/start/days), ensure days include {date,leftovers,meals[{time,title,recipeId?}]}.',
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
        message: confidence.message || 'Reasoner confidence below threshold for meal bundle intent.',
      });

      emit({
        type: 'reasoner.lowConfidence',
        ts: isoNow(),
        source: 'agents/shims/mealBundle',
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
        source: 'agents/shims/mealBundle',
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
      source: 'agents/shims/mealBundle',
      data: { intent, mode },
    });

    // Normalize into SSA meal-bundle payload
    const { data, warnings: w3, debug: d3 } = normalizeMealBundleOutput(intent, rawResult);
    if (w3?.length) warnings.push(...w3);
    if (d3?.length) debug.push(...d3);

    // Cache the successful raw result
    await setCachedResponse(cacheKey, rawResult);

    // Emit domain-level event
    const domainEventType =
      intent === 'mealBundle.listArchetypes'
        ? 'mealBundle.archetypes.listed'
        : intent === 'mealBundle.generate'
        ? 'mealBundle.generated'
        : 'mealBundle.output.ready';

    emit({
      type: domainEventType,
      ts: isoNow(),
      source: 'agents/shims/mealBundle',
      data: {
        intent,
        mode,
        summary: data.summary,
      },
    });

    // Optional Hub export (primarily for bundles)
    if (familyFundMode && runtime?.exportToHub && intent === 'mealBundle.generate') {
      try {
        const packet = HubPacketFormatter.formatMealBundle({
          intent,
          mode,
          data,
          startedAt,
        });

        await FamilyFundConnector.export(packet);

        emit({
          type: 'session.exported',
          ts: isoNow(),
          source: 'agents/shims/mealBundle',
          data: { intent, mode, packetType: 'mealBundle' },
        });
      } catch (e) {
        warnings.push({
          type: 'hubExportFailed',
          message: e?.message || 'Failed to export meal bundle to Family Fund Hub.',
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
      source: 'agents/shims/mealBundle',
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
 * Optional legacy compatibility wrappers
 * ------------------------------------------------------------------------ */

/**
 * Legacy-style router for old calls:
 *   handleCommand("list")
 *   handleCommand("archetypes")
 *   handleCommand("generate", payload)
 *   handleCommand("bundle", payload)
 *
 * @param {string|Object} command
 * @param {Object} payload
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}) {
  let cmd = command;

  // Backwards-compatible: allow object form { command, payload }
  if (typeof command === 'object' && command) {
    if (command.payload && !Object.keys(payload || {}).length) {
      // eslint-disable-next-line no-param-reassign
      payload = command.payload;
    }
    cmd = command.command || command.type || 'list';
  }

  const normalized = normalizeIntent(cmd || '');
  return invokeShim({
    domain: 'cooking',
    intent: normalized,
    input: payload,
    runtime: payload?.runtime || {},
  });
}

/**
 * Thin compatibility wrappers mirroring old top-level methods.
 * These always return ShimResponse.
 */

export async function generateBundle(input = {}) {
  return invokeShim({
    domain: 'cooking',
    intent: 'mealBundle.generate',
    input,
    runtime: input.runtime || {},
  });
}

export async function list(input = {}) {
  // Keep a "list" wrapper for older call sites
  return invokeShim({
    domain: 'cooking',
    intent: 'mealBundle.listArchetypes',
    input,
    runtime: input.runtime || {},
  });
}

// Preserve familiar name for callers that used listArchetypes()
export async function listArchetypesShim(input = {}) {
  return invokeShim({
    domain: 'cooking',
    intent: 'mealBundle.listArchetypes',
    input,
    runtime: input.runtime || {},
  });
}

// Optional default export to keep import style compatible with old agent
const mealBundleShim = {
  listArchetypes,
  generateBundle,
  handleCommand,
};

export default mealBundleShim;
