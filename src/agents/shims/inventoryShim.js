// C:\Users\larho\suka-smart-assistant\src\agents\shims\inventoryAgent.js

/**
 * Inventory Shim
 * --------------
 * Shim around the Reasoner for:
 *  - Inventory analysis (restock, preserve, DIY hints, etc.)
 *  - FEFO-aware lot picking (badge-aware)
 *  - Lot create/update planning
 *  - Batch ops + undo planning
 *
 * It replaces the old inventoryAgent by:
 *  - Accepting inventory-related intents (analyze, createLot, updateLot, applyOps, undo, pickLotsFEFO)
 *  - Pulling inventory context from selectors
 *  - Providing Torah badge / shellfish / FEFO semantics as *hints* to the Reasoner,
 *    instead of directly mutating inventory
 *  - Selecting a Reasoner mode, building prompts, enforcing budget/gating
 *  - Validating Reasoner output against schemas
 *  - Normalizing into SSA inventory payloads
 *  - Emitting standard Reasoner events and optional Hub export
 *
 * This shim does NOT:
 *  - Touch UI / DOM
 *  - Show toasts or call Glue / emitProgress
 *  - Directly update Dexie or managers (no addInventoryItem/updateInventoryItem here)
 *  - Manage timers or sessions (SessionRunner/skills handle that)
 */

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} intent                 // e.g. "inventory.analyze", "inventory.createLot"
 * @property {Object} input                  // inventory-specific input payload
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
import { inventoryShimKey } from '@/services/reasoner/cache/keys';
import { selectModeForIntent } from '@/services/reasoner/modes/map';
import { validateResponse } from '@/services/reasoner/validate';
import { buildSystemPrompt } from '@/services/reasoner/prompts/system';
import { buildTemplatePrompt } from '@/services/reasoner/prompts/templates';
import { callReasoner } from '@/services/reasoner/core';

// Context selectors
import { selectInventoryContext } from '@/services/selectors/inventorySelectors';

// Hub export (optional)
import { HubPacketFormatter } from '@/services/hub/HubPacketFormatter';
import { FamilyFundConnector } from '@/services/hub/FamilyFundConnector';

const isoNow = () => dayjs().toISOString();
const lower = (s) => (s == null ? '' : String(s).toLowerCase().trim());

/* ---------------------------------------------------------------------------
 * Inventory & Torah / allergy hints (fed into Reasoner as structured hints)
 * ------------------------------------------------------------------------ */

/**
 * Shellfish identification keys for Torah / allergy-aware badge logic.
 */
const SHELLFISH_KEYS = [
  'shrimp',
  'prawn',
  'crab',
  'lobster',
  'clam',
  'oyster',
  'scallop',
  'mussel',
  'shellfish',
];

/**
 * Basic FEFO guidance to help Reasoner design correct pick lots strategies.
 */
const FEFO_HINTS = {
  description:
    'Use FEFO: First-Expiry-First-Out. Among badge-compliant lots, prioritize the earliest expiryISO date.',
  defaultExpiryFallback: '2100-01-01T00:00:00.000Z',
  fields: ['lot', 'qty', 'unit', 'expiryISO', 'tags'],
};

/**
 * Torah badge / allergy policies (high-level guidance, not implementation).
 */
const TORAH_BADGE_POLICY = {
  coreBadge: 'Torah-aligned (household profile)',
  shellfishBadge: 'Shellfish',
  description:
    'When household shellfishAllowed=false, lots or items with Shellfish badge should be excluded from suggestions or FEFO picks. When shellfishAllowed=true, they may be included, but still clearly tagged.',
};

/**
 * Normalize/alias intents coming from legacy callers.
 * - Old commands: analyze, createLot, updateLot, applyOps, undo, pickLotsFEFO
 * - New canonical intents: inventory.analyze, inventory.createLot, etc.
 *
 * @param {string} rawIntentOrCommand
 * @returns {string}
 */
function normalizeIntent(rawIntentOrCommand) {
  const s = lower(rawIntentOrCommand || '');

  const map = {
    analyze: 'inventory.analyze',
    analyse: 'inventory.analyze',
    audit: 'inventory.analyze',
    review: 'inventory.analyze',
    'scan-receipts': 'inventory.analyze',
    plan: 'inventory.analyze',

    createlot: 'inventory.createLot',
    'inventory.createlot': 'inventory.createLot',

    updatelot: 'inventory.updateLot',
    'inventory.updatelot': 'inventory.updateLot',

    applyops: 'inventory.applyOps',
    'inventory.applyops': 'inventory.applyOps',

    undo: 'inventory.undo',
    'inventory.undo': 'inventory.undo',

    pickfefo: 'inventory.pickLotsFEFO',
    picklotsfefo: 'inventory.pickLotsFEFO',
    'inventory.picklotsfefo': 'inventory.pickLotsFEFO',
  };

  if (map[s]) return map[s];

  if (s.startsWith('inventory.')) return s;
  return `inventory.${s}`;
}

/**
 * Build structured inventory-related hints to pass into the Reasoner.
 * These are *hints*, not deterministic behavior.
 *
 * @returns {{
 *   shellfishKeys: string[],
 *   fefo: Object,
 *   torahBadgePolicy: Object
 * }}
 */
function buildInventoryHints() {
  return {
    shellfishKeys: SHELLFISH_KEYS,
    fefo: FEFO_HINTS,
    torahBadgePolicy: TORAH_BADGE_POLICY,
  };
}

/**
 * Normalize Reasoner raw output into SSA inventory payload.
 * Handles multiple intents:
 *  - inventory.analyze
 *  - inventory.createLot
 *  - inventory.updateLot
 *  - inventory.applyOps
 *  - inventory.undo
 *  - inventory.pickLotsFEFO
 *
 * Assumes schema validation has already passed.
 *
 * @param {string} intent
 * @param {any} raw
 * @returns {{ data: Object, warnings: Object[], debug: Object[] }}
 */
function normalizeInventoryOutput(intent, raw) {
  const warnings = [];
  const debug = [];

  if (!raw || typeof raw !== 'object') {
    return {
      data: {
        summary: 'Reasoner returned empty result.',
        message: '',
        warnings: [],
        actions: [],
        nextBestAction: null,
        data: {},
      },
      warnings: [
        {
          type: 'emptyResult',
          message: 'Reasoner returned no structured payload for inventory intent.',
        },
      ],
      debug,
    };
  }

  const baseSummary =
    raw.summary ||
    (intent === 'inventory.analyze'
      ? 'Inventory analyzed.'
      : intent === 'inventory.createLot'
      ? 'Lot creation plan generated.'
      : intent === 'inventory.updateLot'
      ? 'Lot update plan generated.'
      : intent === 'inventory.applyOps'
      ? 'Batch inventory operations planned.'
      : intent === 'inventory.undo'
      ? 'Undo plan generated.'
      : intent === 'inventory.pickLotsFEFO'
      ? 'FEFO pick suggestion generated.'
      : 'Inventory output ready.');

  const message = typeof raw.message === 'string' ? raw.message : '';
  const actions = Array.isArray(raw.actions) ? raw.actions : [];
  const nextBestAction =
    raw.nextBestAction && typeof raw.nextBestAction === 'object' ? raw.nextBestAction : null;
  const extraWarnings = Array.isArray(raw.warnings) ? raw.warnings : [];
  const extraData = raw.data && typeof raw.data === 'object' ? raw.data : {};

  if (raw.nextBestAction && typeof raw.nextBestAction !== 'object') {
    warnings.push({
      type: 'invalidNextBestAction',
      message:
        'nextBestAction must be an object or null; Reasoner returned a non-object, dropping it.',
    });
  }

  // For analyze, ensure we surface key lists with stable defaults
  const normalizedData =
    intent === 'inventory.analyze'
      ? {
          summary: baseSummary,
          message,
          restockItems: Array.isArray(extraData.restockItems)
            ? extraData.restockItems
            : Array.isArray(raw.restockItems)
            ? raw.restockItems
            : [],
          preservationTriggers: Array.isArray(extraData.preservationTriggers)
            ? extraData.preservationTriggers
            : Array.isArray(raw.preservationTriggers)
            ? raw.preservationTriggers
            : [],
          expansionSuggestions: Array.isArray(extraData.expansionSuggestions)
            ? extraData.expansionSuggestions
            : Array.isArray(raw.expansionSuggestions)
            ? raw.expansionSuggestions
            : [],
          smartSourcing: Array.isArray(extraData.smartSourcing)
            ? extraData.smartSourcing
            : Array.isArray(raw.smartSourcing)
            ? raw.smartSourcing
            : [],
          actions,
          nextBestAction,
          warnings: extraWarnings,
        }
      : {
          summary: baseSummary,
          message,
          actions,
          nextBestAction,
          warnings: extraWarnings,
          // For mutation/FEFO intents, keep Reasoner data mostly intact
          ...extraData,
        };

  const data = normalizedData;

  debug.push({
    type: 'inventoryShim.normalize',
    ts: isoNow(),
    intent,
    rawKeys: Object.keys(raw || {}),
  });

  return { data, warnings, debug };
}

/**
 * Main Inventory Shim entrypoint.
 *
 * Note: Inventory lives under the "storehouse" domain in SSA.
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

    // Domain for inventory is "storehouse"
    const domain = req.domain || 'storehouse';
    const intent = normalizeIntent(req.intent || '');
    const input = req.input || {};
    const runtime = req.runtime || {};

    if (domain !== 'storehouse') {
      return {
        ok: false,
        mode: 'none',
        data: {},
        warnings: [
          {
            type: 'badDomain',
            message: `Inventory shim only supports domain="storehouse", received "${domain}".`,
          },
        ],
        debug,
      };
    }

    // Emit early invocation event
    emit({
      type: 'reasoner.invoked',
      ts: startedAt,
      source: 'agents/shims/inventory',
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
        source: 'agents/shims/inventory',
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

    // Mode selection (e.g. inventory.analyze.v1, inventory.applyOps.v1, etc.)
    const mode =
      selectModeForIntent({
        domain,
        intent,
        input,
      }) || 'inventory.analyze.v1';

    // Budget enforcement
    const budgetInfo = enforceBudget({ domain, intent, mode, runtime });
    if (!budgetInfo.ok) {
      warnings.push({
        type: 'budgetExceeded',
        message: budgetInfo.message || 'Budget exceeded for inventory shim.',
      });

      emit({
        type: 'reasoner.budgetExceeded',
        ts: isoNow(),
        source: 'agents/shims/inventory',
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

    // Pull context (inventory, receipts, profiles, garden/animal signals, etc.)
    const context = await selectInventoryContext({ input, runtime, intent });

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

    // Build inventory hints
    const inventoryHints = buildInventoryHints();

    // Compose Reasoner payload
    const reasonerPayload = {
      task: intent,
      domain,
      mode,
      input,
      context: freshContext,
      hints: {
        inventory: inventoryHints,
      },
      meta: {
        requestedAt: startedAt,
        familyFundMode: !!familyFundMode,
      },
    };

    // Cache key + lookup
    const cacheKey = inventoryShimKey({ intent, mode, payload: reasonerPayload });
    const cached = await getCachedResponse(cacheKey);
    if (cached) {
      emit({
        type: 'reasoner.cachedHit',
        ts: isoNow(),
        source: 'agents/shims/inventory',
        data: { intent, mode, cacheKey },
      });

      const { data, warnings: w2, debug: d2 } = normalizeInventoryOutput(intent, cached);
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
      source: 'agents/shims/inventory',
      data: { intent, mode, cacheKey },
    });

    // Build prompts
    const systemPrompt = buildSystemPrompt({
      domain: 'storehouse',
      mode,
      extra: {
        inventoryInstruction:
          'You are an inventory planner. Use shellfishKeys, fefo, and torahBadgePolicy hints ' +
          'to propose Torah-aware, allergy-safe inventory suggestions. ' +
          'For FEFO, when suggesting lots to pick, prioritize earlier expiryISO dates among lots ' +
          'that satisfy household badge requirements. When designing createLot/updateLot/applyOps/undo ' +
          'plans, output structured actions rather than natural language only.',
      },
    });

    const userPrompt = buildTemplatePrompt({
      domain: 'storehouse',
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
        message: confidence.message || 'Reasoner confidence below threshold for inventory intent.',
      });

      emit({
        type: 'reasoner.lowConfidence',
        ts: isoNow(),
        source: 'agents/shims/inventory',
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
        source: 'agents/shims/inventory',
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
      source: 'agents/shims/inventory',
      data: { intent, mode },
    });

    // Normalize into SSA inventory payload
    const { data, warnings: w3, debug: d3 } = normalizeInventoryOutput(intent, rawResult);
    if (w3?.length) warnings.push(...w3);
    if (d3?.length) debug.push(...d3);

    // Cache the successful raw result
    await setCachedResponse(cacheKey, rawResult);

    // Emit domain-level event
    const domainEventType =
      intent === 'inventory.analyze'
        ? 'inventory.analyzed'
        : intent === 'inventory.createLot'
        ? 'inventory.lot.create.planned'
        : intent === 'inventory.updateLot'
        ? 'inventory.lot.update.planned'
        : intent === 'inventory.applyOps'
        ? 'inventory.ops.planned'
        : intent === 'inventory.undo'
        ? 'inventory.undo.planned'
        : intent === 'inventory.pickLotsFEFO'
        ? 'inventory.fefo.pick.suggested'
        : 'inventory.output.ready';

    emit({
      type: domainEventType,
      ts: isoNow(),
      source: 'agents/shims/inventory',
      data: {
        intent,
        mode,
        summary: data.summary,
      },
    });

    // Optional Hub export (primarily for analyze + large ops plans)
    if (
      familyFundMode &&
      runtime?.exportToHub &&
      (intent === 'inventory.analyze' || intent === 'inventory.applyOps')
    ) {
      try {
        const packet = HubPacketFormatter.formatInventory({
          intent,
          mode,
          data,
          startedAt,
        });

        await FamilyFundConnector.export(packet);

        emit({
          type: 'session.exported',
          ts: isoNow(),
          source: 'agents/shims/inventory',
          data: { intent, mode, packetType: 'inventory' },
        });
      } catch (e) {
        warnings.push({
          type: 'hubExportFailed',
          message: e?.message || 'Failed to export inventory data to Family Fund Hub.',
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
      source: 'agents/shims/inventory',
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
 * ---------------------------------------------------------------------------
 * These keep the old API surface roughly intact for any modules that still call:
 *   handleInventoryCommand("analyze", payload)
 *   handleInventoryCommand("createLot", payload)
 *   handleInventoryCommand("updateLot", payload)
 *   handleInventoryCommand("applyOps", payload)
 *   handleInventoryCommand("undo", payload)
 *   handleInventoryCommand("pickFEFO", payload)
 *
 * Each wrapper simply forwards into invokeShim() with the right intent.
 */

/**
 * Legacy-style router for old calls.
 * @param {string|Object} command
 * @param {Object} payload
 * @returns {Promise<ShimResponse>}
 */
export async function handleInventoryCommand(command, payload = {}) {
  // Backwards-compatible: allow object form { command, payload }
  let cmd = command;
  if (typeof command === 'object' && command) {
    if (command.payload && !Object.keys(payload || {}).length) {
      // eslint-disable-next-line no-param-reassign
      payload = command.payload;
    }
    cmd = command.command || command.type || 'analyze';
  }

  const normalized = normalizeIntent(cmd || '');
  return invokeShim({
    domain: 'storehouse',
    intent: normalized,
    input: payload,
    runtime: payload?.runtime || {},
  });
}

/**
 * Thin compatibility wrappers mirroring old top-level methods.
 * These always return ShimResponse and do not mutate inventory directly.
 */

export async function analyze(input = {}) {
  return invokeShim({
    domain: 'storehouse',
    intent: 'inventory.analyze',
    input,
    runtime: input.runtime || {},
  });
}

export async function createLot(input = {}) {
  return invokeShim({
    domain: 'storehouse',
    intent: 'inventory.createLot',
    input,
    runtime: input.runtime || {},
  });
}

export async function updateLot(input = {}) {
  return invokeShim({
    domain: 'storehouse',
    intent: 'inventory.updateLot',
    input,
    runtime: input.runtime || {},
  });
}

export async function applyOps(input = {}) {
  return invokeShim({
    domain: 'storehouse',
    intent: 'inventory.applyOps',
    input,
    runtime: input.runtime || {},
  });
}

export async function undo(input = {}) {
  return invokeShim({
    domain: 'storehouse',
    intent: 'inventory.undo',
    input,
    runtime: input.runtime || {},
  });
}

export async function pickLotsFEFO(input = {}) {
  return invokeShim({
    domain: 'storehouse',
    intent: 'inventory.pickLotsFEFO',
    input,
    runtime: input.runtime || {},
  });
}
