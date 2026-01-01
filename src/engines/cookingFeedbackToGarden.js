// File: src/engines/cookingFeedbackToGarden.js
// Purpose: Listen to cooking/runtime and inventory events and translate them into
//          garden demand signals (what to plant more/less of, when to harvest, etc.).
// Pipeline fit: imports (recipes) → intelligence (technique + ingredient usage) → automation
//               (sessions + inventory deltas) → FEEDBACK LOOP (this file) → garden planning
//               → (optional) hub export via Family Fund if featureFlags.familyFundMode.
//
// Contracts used here (assumed to exist in repo):
// - src/services/eventBus.js               : simple pub/sub with .on(event, handler) and .emit(payload)
// - src/services/dataGateway.js            : get(key), set(key, value), merge(key, partial), transact(fn)
// - src/config/featureFlags.js             : { familyFundMode: boolean }
// - HubPacketFormatter, FamilyFundConnector: used in exportToHubIfEnabled(payload)
//
// Events consumed (examples; extensible):
// - meal.executed                          : { data: { id, startedAtISO, completedAtISO, portions, ingredients:[{ name, qty, unit, tags? }], cuisineTags? } }
// - cook.step.completed                    : { data: { techniqueId, ingredientClass, actualTimeMin, actualCoreC } }
// - inventory.updated                      : { data: { diffs: [{ sku, name, delta, unit, domain }], reason } }
//
// Events emitted (canonical shape { type, ts, source, data }):
// - garden.demand.incremented              : when usage maps to a plant signal
// - garden.cuisine.signal                  : cuisine usage → variety/herb suggestions
// - garden.plan.suggestion                 : aggregated suggestions ready for planner
//
// Defensive coding: all handlers bail early if payloads are malformed.

import eventBus from '../services/eventBus.js';
import dataGateway from '../services/dataGateway.js';
import featureFlags from '../config/featureFlags.js';

let HubPacketFormatter; // lazy-required to avoid node resolution in tests if not present
let FamilyFundConnector;

// ----- Configuration / Extension Points ---------------------------------------------------------

/** Map grocery/ingredient tokens to garden crops (normalized). Extend freely. */
const ingredientToPlantMap = Object.freeze({
  // Common
  tomato: 'tomato',
  tomatoes: 'tomato',
  onion: 'onion_bulb',
  onions: 'onion_bulb',
  scallion: 'green_onion',
  scallions: 'green_onion',
  garlic: 'garlic',
  potato: 'potato',
  potatoes: 'potato',
  cilantro: 'cilantro_coriander_leaf',
  parsley: 'parsley',
  basil: 'basil_sweet',
  oregano: 'oregano',
  thyme: 'thyme',
  rosemary: 'rosemary',
  spinach: 'spinach',
  kale: 'kale',
  chard: 'chard',

  // Global/non-USA-forward plants (broadening cuisine planning)
  okra: 'okra',
  'bitter melon': 'bitter_melon',
  karela: 'bitter_melon',
  'yardlong bean': 'yardlong_bean',
  'snake bean': 'yardlong_bean',
  'long bean': 'yardlong_bean',
  tomatillo: 'tomatillo',
  epazote: 'epazote',
  'thai basil': 'basil_thai',
  lemongrass: 'lemongrass',
  shiso: 'perilla_shiso',
  perilla: 'perilla_shiso',
  culantro: 'culantro_recao',
  callaloo: 'amaranth_leaf',
  amaranth: 'amaranth_leaf',
  'cassava leaf': 'cassava_leaf',
  'cassava leaves': 'cassava_leaf',
  moringa: 'moringa_leaf',
  'pigeon peas': 'pigeon_pea',
  'pigeon pea': 'pigeon_pea',
  'scotch bonnet': 'capsicum_scotch_bonnet',
  'bird’s eye chili': 'capsicum_birds_eye',
  'bird eye chili': 'capsicum_birds_eye',
  'thai chili': 'capsicum_birds_eye',
  taro: 'taro_root',
  'taro leaf': 'taro_leaf',
  'taro leaves': 'taro_leaf',
  'bottle gourd': 'calabash_bottle_gourd',
  'lauki': 'calabash_bottle_gourd',
  'ridged gourd': 'ridge_gourd_turai',
  'ridge gourd': 'ridge_gourd_turai',
  'malabar spinach': 'malabar_spinach',
  'coriander seed': 'coriander_seed',
  'fenugreek leaf': 'methi_leaf',
  methi: 'methi_leaf',
  'fenugreek seed': 'fenugreek_seed',
  'mustard greens': 'mustard_greens',
  'chinese chives': 'garlic_chives',
  'garlic chives': 'garlic_chives',
  'thai eggplant': 'eggplant_thai',
  'african eggplant': 'eggplant_african_garden',
});

/** Cuisine → anchor plants/herbs to nudge garden planning. */
const cuisineAnchors = Object.freeze({
  Mexican: ['tomatillo', 'cilantro_coriander_leaf', 'capsicum_birds_eye', 'epazote'],
  Peruvian: ['aji_amarillo (seed-start)', 'cilantro_coriander_leaf', 'red_onion'],
  Indian: ['methi_leaf', 'coriander_seed', 'basil_thai', 'ridge_gourd_turai', 'bottle_gourd'],
  Pakistani: ['coriander_seed', 'methi_leaf', 'green_chili_generic'],
  Chinese: ['garlic_chives', 'yardlong_bean', 'pak_choi', 'perilla_shiso'],
  Vietnamese: ['thai_basil', 'lemongrass', 'perilla_shiso'],
  WestAfrican: ['okra', 'amaranth_leaf', 'capsicum_scotch_bonnet'],
  Caribbean: ['culantro_recao', 'scotch_bonnet', 'callaloo (amaranth_leaf)'],
  Maghreb: ['cilantro_coriander_leaf', 'parsley', 'eggplant'],
  Japanese: ['perilla_shiso', 'scallion', 'daikon (add in garden tables if missing)'],
});

/** Units normalization (very light; domain can be expanded later) */
const UNIT_WEIGHTS = Object.freeze({
  gram: 1, g: 1,
  kg: 1000,
  ounce: 28.3495, oz: 28.3495,
  lb: 453.592,
  piece: null, pcs: null, unit: null, bunch: null // unknown weight; handled specially
});

// ----- Helpers -----------------------------------------------------------------------------------

function tsISO() { return new Date().toISOString(); }
function payload(source, type, data) { return { type, ts: tsISO(), source, data }; }

function normalizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Convert ingredient to plant key if possible; returns null if not mappable. */
function mapIngredientToPlant(ingredientName) {
  const key = normalizeName(ingredientName);
  if (!key) return null;
  if (ingredientToPlantMap[key]) return ingredientToPlantMap[key];

  // Heuristics
  if (key.endsWith(' leaves')) return ingredientToPlantMap[key] || key.replace(' leaves', '_leaf');
  if (key.endsWith(' leaf')) return ingredientToPlantMap[key] || key.replace(' leaf', '_leaf');
  if (key.includes('pepper')) return 'capsicum_generic';

  return null;
}

/** Normalize qty to grams if possible; return { grams: number|null, approx: boolean } */
function toGrams(qty, unit) {
  if (qty == null) return { grams: null, approx: true };
  if (!unit) return { grams: null, approx: true };
  const u = normalizeName(unit);
  const factor = UNIT_WEIGHTS[u];
  if (!factor) return { grams: null, approx: true };
  return { grams: qty * factor, approx: false };
}

/** Persist demand signal; schema kept simple: { plantId: { totalGrams, events[], lastUsedISO } } */
async function recordDemand(plantId, grams, context) {
  if (!plantId) return;
  await dataGateway.transact(async (tx) => {
    const key = `gardenDemand:${plantId}`;
    const current = (await tx.get(key)) || { plantId, totalGrams: 0, events: [], lastUsedISO: null };
    const next = {
      ...current,
      totalGrams: current.totalGrams + (Number.isFinite(grams) ? grams : 0),
      lastUsedISO: tsISO(),
      events: current.events.slice(-19).concat({
        at: tsISO(),
        grams: Number.isFinite(grams) ? grams : null,
        ctx: context
      }),
    };
    await tx.set(key, next);
  });
}

/** Simple rolling window aggregator; returns usage sum over N days */
async function getUsageSumDays(plantId, days = 30) {
  const key = `gardenDemand:${plantId}`;
  const rec = await dataGateway.get(key);
  if (!rec || !Array.isArray(rec.events)) return 0;
  const cutoff = Date.now() - days * 86400000;
  return rec.events
    .filter(e => Date.parse(e.at) >= cutoff)
    .reduce((sum, e) => sum + (Number.isFinite(e.grams) ? e.grams : 0), 0);
}

/** Optional export to Hub (Family Fund) — best-effort, silent on failure. */
async function exportToHubIfEnabled(eventPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    HubPacketFormatter ||= (await import('../services/hub/HubPacketFormatter.js')).default;
    FamilyFundConnector ||= (await import('../services/hub/FamilyFundConnector.js')).default;
    const packet = HubPacketFormatter.format(eventPayload);
    await FamilyFundConnector.send(packet);
  } catch (_err) {
    // fail silent by requirement
  }
}

// ----- Core Engine -------------------------------------------------------------------------------

const SOURCE = 'cooking.feedback.garden';

/**
 * Handle meal.executed → increment demand for mapped plants
 */
async function onMealExecuted(evt) {
  if (!evt || !evt.data || !Array.isArray(evt.data.ingredients)) return;

  const cuisineTags = Array.isArray(evt.data.cuisineTags) ? evt.data.cuisineTags : [];
  const portions = Number.isFinite(evt.data.portions) ? evt.data.portions : null;

  for (const ing of evt.data.ingredients) {
    if (!ing || !ing.name) continue;
    const plantId = mapIngredientToPlant(ing.name);
    if (!plantId) continue;

    const { grams } = toGrams(ing.qty, ing.unit);
    const context = {
      mealId: evt.data.id || null,
      portions,
      src: 'meal.executed',
      raw: { name: ing.name, qty: ing.qty ?? null, unit: ing.unit ?? null }
    };

    await recordDemand(plantId, grams ?? 0, context);

    const incPayload = payload(SOURCE, 'garden.demand.incremented', {
      plantId,
      grams: grams ?? null,
      approx: grams == null,
      mealId: evt.data.id || null
    });

    eventBus.emit(incPayload);
    exportToHubIfEnabled(incPayload); // best-effort
  }

  // Cuisine anchors → suggest plants/herbs if used recently
  if (cuisineTags.length) {
    const suggestions = new Set();
    for (const tag of cuisineTags) {
      const anchors = cuisineAnchors[tag] || [];
      anchors.forEach(a => suggestions.add(a));
    }
    if (suggestions.size) {
      const sigPayload = payload(SOURCE, 'garden.cuisine.signal', {
        cuisines: cuisineTags,
        suggestedPlants: Array.from(suggestions)
      });
      eventBus.emit(sigPayload);
      exportToHubIfEnabled(sigPayload);
    }
  }

  // After processing the meal, run quick aggregation for top plants to produce planning hints
  await maybeEmitPlanSuggestion();
}

/**
 * Handle inventory.updated → if fresh produce hits shortage and maps to a plant, bump demand.
 * This captures cases where we *wanted* more herb/veg but ran out.
 */
async function onInventoryUpdated(evt) {
  const diffs = evt?.data?.diffs;
  if (!Array.isArray(diffs)) return;

  for (const d of diffs) {
    if (!d?.name || typeof d.delta !== 'number') continue;
    // focus on produce-like domains or negative deltas
    if (d.delta >= 0) continue;

    const plantId = mapIngredientToPlant(d.name);
    if (!plantId) continue;

    // Negative delta indicates consumption. We use a symbolic gram bump if unit unknown.
    const grams = d.unit ? toGrams(Math.abs(d.delta), d.unit).grams : 50; // heuristic
    await recordDemand(plantId, Number.isFinite(grams) ? grams : 50, {
      src: 'inventory.updated',
      reason: evt.data.reason || null,
      raw: d
    });

    const incPayload = payload(SOURCE, 'garden.demand.incremented', {
      plantId,
      grams: Number.isFinite(grams) ? grams : null,
      approx: !Number.isFinite(grams)
    });
    eventBus.emit(incPayload);
    exportToHubIfEnabled(incPayload);
  }

  await maybeEmitPlanSuggestion();
}

/**
 * Aggregation rule: if a plant’s 30-day demand exceeds thresholds, suggest an action.
 * Thresholds are intentionally low to start and can be tuned via data store later.
 */
async function maybeEmitPlanSuggestion() {
  const candidatePlants = Object.values(ingredientToPlantMap)
    .filter((v, i, a) => a.indexOf(v) === i); // unique

  const suggestions = [];

  for (const p of candidatePlants) {
    const sum30 = await getUsageSumDays(p, 30);
    // Heuristic thresholds (grams/month); leaf herbs need less mass than fruits
    const isLeaf = /leaf|basil|cilantro|parsley|chives|mint|shiso|epazote|culantro|methi/.test(p);
    const floor = isLeaf ? 60 : 400; // ~1–2 bunches vs ~4 tomatoes
    if (sum30 >= floor) {
      suggestions.push({
        plantId: p,
        window: 'next_cycle',
        reason: `usage_30d≈${Math.round(sum30)}g ≥ ${floor}g`,
        actions: isLeaf
          ? ['succession_sow_every_2_weeks', 'increase_container_count_by_1']
          : ['start_seedlings_now', 'stagger_transplants_every_2_weeks']
      });
    }
  }

  if (suggestions.length) {
    const planPayload = payload(SOURCE, 'garden.plan.suggestion', {
      suggestions,
      hint: 'Feed to GardenPlanning engine to merge with zone/bed capacity.'
    });
    eventBus.emit(planPayload);
    exportToHubIfEnabled(planPayload);
  }
}

// ----- Public API -------------------------------------------------------------------------------

/**
 * Initialize the feedback engine and bind event listeners.
 * @param {object} [opts] optional configuration overrides
 * @param {string[]} [opts.consume] event types to consume
 */
function init(opts = {}) {
  const consume = new Set(
    (opts.consume && Array.isArray(opts.consume) && opts.consume.length)
      ? opts.consume
      : ['meal.executed', 'inventory.updated'] // default
  );

  if (consume.has('meal.executed')) {
    eventBus.on('meal.executed', onMealExecuted);
  }
  if (consume.has('inventory.updated')) {
    eventBus.on('inventory.updated', onInventoryUpdated);
  }

  // Emit self-ready signal for observability
  eventBus.emit(payload(SOURCE, 'engine.ready', { engine: 'cookingFeedbackToGarden', consume: Array.from(consume) }));

  return {
    /** For tests: direct injection hooks */
    _mapIngredientToPlant: mapIngredientToPlant,
    _toGrams: toGrams,
    _maybeEmitPlanSuggestion: maybeEmitPlanSuggestion
  };
}

export default {
  init
};
