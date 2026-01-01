/* eslint-disable no-console */
// src/engines/planning/onMealplanDraftRequested.js
//
// onMealplanDraftRequested — generate a draft meal plan using placement rules
// ---------------------------------------------------------------------------
// Key features wired in (all optional via DI):
// - planTemplates.selectTemplate(ctx) to choose a weekly/biweekly/monthly shell
// - placementRules.place(recipes, slots, ctx) → slot assignments + conflicts
// - recipeNormalizer.normalizeAll(recipes, ctx) → units/servings standardization
// - recipeDeduper.withVersionPicker(recipes, ctx) → de-dup with version logic
// - taggingAutoClassifier.infer(recipe) → cuisine/course/effort/appliance tags
// - scheduleHelpers.buildReminders(assignments, ctx) → defrost/marinate/preheat
// - prepConsolidationEngine.suggest(assignments, ctx) → batch prep + timers
// - estimateEngine.estimate(assignments, ctx) → rough cost by supplier profiles
// - groceryEngine.diff(assignments, inventory, opts) → list w/ groups + subs
// - Sabbath guard: avoid placing or scheduling work in guard windows
//
// The function is defensive against missing services. It emits:
// - "mealplan.draft.generated" with the full draft payload
// - "nba.suggest" with Next Best Actions when conflicts or gaps exist
//
// Usage:
//   onMealplanDraftRequested(payload, { bus, engines, stores, helpers, log })

/**
 * @typedef {Object} DraftPayload
 * @property {string|Date} startDate
 * @property {string|Date} endDate
 * @property {string} [timezone]            // default from settings
 * @property {Array<string>} [collections]  // boards/lists to pull recipes from
 * @property {Array<string>} [pinnedIds]    // must-include recipe ids
 * @property {Array<string>} [excludeIds]   // must-exclude recipe ids
 * @property {Object} [constraints]         // dietary, budget, maxPrep, appliance availability, macros, etc.
 * @property {Object} [rhythm]              // which meals on which days (e.g., { mon: ['dinner'], tue:['lunch','dinner'] })
 * @property {boolean} [honorInventory]     // consider pantry/storehouse
 * @property {boolean} [honorGarden]        // prefer garden/animal sources first
 * @property {boolean} [honorSabbathGuard]  // avoid certain windows (Fri sundown–Sat sundown)
 * @property {Object}  [options]            // UI toggles: includeHave, allowSubstitutions, collapseDuplicates, storeId, aisleGroups, etc.
 */

/**
 * Main handler — safe to call even if engines/stores are partially unavailable.
 * @param {DraftPayload} payload
 * @param {Object} deps
 * @param {Object} deps.bus                     // eventBus with publish()
 * @param {Object} deps.engines                 // injected engines (optional)
 * @param {Object} deps.stores                  // injected stores (optional)
 * @param {Object} deps.helpers                 // injected helpers (optional)
 * @param {Function} [deps.log]                 // logger
 * @returns {Promise<Object>}                   // returns the draft (also emitted)
 */
export async function onMealplanDraftRequested(payload = {}, deps = {}) {
  const {
    bus,
    engines = {},
    stores = {},
    helpers = {},
    log = defaultLog,
  } = deps;

  const {
    recipeNormalizer,
    recipeDeduper,
    taggingAutoClassifier,
    planTemplates,
    placementRules,
    scheduleHelpers,
    prepConsolidationEngine,
    estimateEngine,
    groceryEngine,
  } = engines;

  const {
    recipesStore,
    inventoryStore,
    userStore,
    scheduleStore,
    supplierStore,
  } = stores;

  const {
    time = timeUtilFallback,
    uuid = uuidFallback,
  } = helpers;

  try {
    // 1) Normalize inputs + build context -----------------------------------
    const now = new Date();
    const tz = payload.timezone || userStore?.getTimezone?.() || 'America/New_York';

    const start = time.coerceDate(payload.startDate) || time.startOfWeek(now, tz);
    const end = time.coerceDate(payload.endDate) || time.addDays(start, 6); // default 1 week
    const days = time.enumerateDays(start, end, tz);

    const settings = userStore?.getSettings?.() || {};
    const sabbathGuard = payload.honorSabbathGuard ?? settings?.sabbathGuard ?? true;
    const includeHave = payload?.options?.includeHave ?? false;

    const ctx = {
      tz,
      start,
      end,
      days,
      timestamp: now.toISOString(),
      user: userStore?.getProfile?.() || {},
      settings,
      constraints: payload.constraints || {},
      rhythm: payload.rhythm || settings?.mealRhythm || defaultRhythm(days),
      sabbathGuard,
      honorInventory: payload.honorInventory ?? true,
      honorGarden: payload.honorGarden ?? true,
      options: {
        allowSubstitutions: payload?.options?.allowSubstitutions ?? true,
        collapseDuplicates: payload?.options?.collapseDuplicates ?? true,
        aisleGroups: payload?.options?.aisleGroups ?? true,
        storeId: payload?.options?.storeId || supplierStore?.getDefaultStoreId?.(),
        includeHave,
      },
      sources: {
        collections: payload.collections || [],
        pinnedIds: payload.pinnedIds || [],
        excludeIds: payload.excludeIds || [],
      },
      // Expose DI stores in ctx for rule engines that need them:
      stores,
      helpers,
    };

    // 2) Gather candidate recipes -------------------------------------------
    let candidates = [];
    if (recipesStore?.getByCollections) {
      const fromCollections = await recipesStore.getByCollections(ctx.sources.collections);
      candidates.push(...(fromCollections || []));
    } else {
      // fallback: everything
      candidates.push(...(await (recipesStore?.getAll?.() || [])));
    }

    // Inject pinned ones first, if any
    if (ctx.sources.pinnedIds?.length && recipesStore?.getByIds) {
      const pinned = await recipesStore.getByIds(ctx.sources.pinnedIds);
      candidates = mergeUniqueById(pinned || [], candidates);
    }

    // Drop excludes
    if (ctx.sources.excludeIds?.length) {
      const excludeSet = new Set(ctx.sources.excludeIds);
      candidates = candidates.filter(r => !excludeSet.has(r.id));
    }

    // 3) Enrich candidates (normalize + infer tags + de-dup/versions) --------
    if (recipeNormalizer?.normalizeAll) {
      candidates = await recipeNormalizer.normalizeAll(candidates, ctx).catch(e => {
        log('recipeNormalizer error', e);
        return candidates;
      });
    }
    if (taggingAutoClassifier?.infer) {
      candidates = candidates.map(r => {
        try {
          const inferred = taggingAutoClassifier.infer(r, ctx) || {};
          return { ...r, tags: mergeUniqueStrings(r.tags || [], inferred.tags || []) };
        } catch (e) {
          log('taggingAutoClassifier error', e);
          return r;
        }
      });
    }
    if (recipeDeduper?.withVersionPicker) {
      candidates = recipeDeduper.withVersionPicker(candidates, ctx).list || candidates;
    }

    // 4) Choose a template shell --------------------------------------------
    let template = null;
    if (planTemplates?.selectTemplate) {
      template = planTemplates.selectTemplate(ctx) || null;
    }
    if (!template) {
      template = fallbackTemplate(ctx); // M/B/D for each day present in ctx.rhythm
    }

    // 5) Apply placement rules ----------------------------------------------
    let placement = { assignments: [], conflicts: [], unfilledSlots: [] };
    if (placementRules?.place) {
      placement = await placementRules.place(candidates, template.slots, ctx).catch(e => {
        log('placementRules error', e);
        return placement;
      });
    } else {
      // naive fallback: fill in order
      placement = naivePlacement(candidates, template.slots, ctx);
    }

    // 6) Sabbath guard (optional hard block) ---------------------------------
    if (ctx.sabbathGuard && scheduleHelpers?.guardWindows) {
      const guardWindows = scheduleHelpers.guardWindows(ctx.start, ctx.end, ctx.tz);
      placement.assignments = placement.assignments.filter(a => !fallsWithinAny(a.slotTime, guardWindows));
      // Mark removed as conflicts to be transparent
      // (You can also auto-shift to adjacent windows if your scheduleHelpers supports it)
    }

    // 7) Build reminders (defrost/marinade/preheat/soak) ---------------------
    let reminders = [];
    if (scheduleHelpers?.buildReminders) {
      reminders = scheduleHelpers.buildReminders(placement.assignments, ctx).filter(Boolean);
    }

    // 8) Prep consolidation suggestions (batching + timers) ------------------
    let prepBatches = [];
    if (prepConsolidationEngine?.suggest) {
      prepBatches = await prepConsolidationEngine.suggest(placement.assignments, ctx).catch(e => {
        log('prepConsolidationEngine error', e);
        return [];
      });
    }

    // 9) Inventory-aware grocery diff ---------------------------------------
    const inventory = ctx.honorInventory
      ? (await inventoryStore?.getPantrySnapshot?.()) || { items: [] }
      : { items: [] };

    let grocery = { items: [], summary: {}, meta: {} };
    if (groceryEngine?.diff) {
      const diffOpts = {
        collapseDuplicates: ctx.options.collapseDuplicates,
        allowSubstitutions: ctx.options.allowSubstitutions,
        includeHave: ctx.options.includeHave,
        aisleGroups: ctx.options.aisleGroups,
        storeId: ctx.options.storeId,
        preferGarden: ctx.honorGarden,
      };
      grocery = await groceryEngine.diff(placement.assignments, inventory, diffOpts).catch(e => {
        log('groceryEngine diff error', e);
        return grocery;
      });
    }

    // 10) Cost estimate ------------------------------------------------------
    let estimate = { total: 0, byDay: {}, byRecipe: {}, currency: 'USD' };
    if (estimateEngine?.estimate) {
      const supplierProfiles = await supplierStore?.getSupplierProfiles?.();
      estimate = await estimateEngine.estimate(placement.assignments, { ...ctx, supplierProfiles }).catch(e => {
        log('estimateEngine error', e);
        return estimate;
      });
    }

    // 11) Conflicts → NBA suggestions ---------------------------------------
    const actions = buildNbaSuggestions(placement, ctx);

    // 12) Compose draft ------------------------------------------------------
    const draft = {
      id: uuid(),
      kind: 'mealplan.draft',
      createdAt: now.toISOString(),
      range: { start: start.toISOString(), end: end.toISOString(), tz },
      template: { id: template.id, label: template.label, slots: template.slots },
      rhythm: ctx.rhythm,
      constraints: ctx.constraints,
      options: ctx.options,
      assignments: placement.assignments,
      conflicts: placement.conflicts,
      unfilledSlots: placement.unfilledSlots || [],
      reminders,
      prepBatches,
      grocery,
      estimate,
      analytics: {
        candidateCount: candidates.length,
        assignedCount: placement.assignments.length,
        conflictCount: placement.conflicts.length,
      },
      sources: ctx.sources,
      meta: {
        sabbathGuard: ctx.sabbathGuard,
        honorInventory: ctx.honorInventory,
        honorGarden: ctx.honorGarden,
        generator: 'onMealplanDraftRequested.v1',
      },
    };

    // 13) Persist draft to schedule store (optional) -------------------------
    if (scheduleStore?.saveDraft) {
      await scheduleStore.saveDraft(draft).catch(e => log('scheduleStore.saveDraft error', e));
    }

    // 14) Emit events --------------------------------------------------------
    safePublish(bus, 'mealplan.draft.generated', { draft });
    if (actions?.length) {
      safePublish(bus, 'nba.suggest', {
        scope: 'mealplan',
        relatedId: draft.id,
        actions,
        priority: 'high',
      });
    }

    return draft;
  } catch (err) {
    log('onMealplanDraftRequested fatal error', err);
    safePublish(bus, 'mealplan.draft.failed', {
      error: serializeError(err),
      payload,
    });
    // A minimal, empty-but-valid draft object so UI doesn’t crash:
    return {
      id: uuidFallback(),
      kind: 'mealplan.draft',
      createdAt: new Date().toISOString(),
      range: {},
      template: { id: 'fallback', label: 'Fallback', slots: [] },
      rhythm: {},
      constraints: {},
      options: {},
      assignments: [],
      conflicts: [{ kind: 'fatal', message: 'Draft generation failed' }],
      reminders: [],
      prepBatches: [],
      grocery: { items: [], summary: {}, meta: {} },
      estimate: { total: 0, byDay: {}, byRecipe: {}, currency: 'USD' },
      analytics: { candidateCount: 0, assignedCount: 0, conflictCount: 1 },
      sources: {},
      meta: { generator: 'onMealplanDraftRequested.v1', error: true },
    };
  }
}

// --------------------------- helpers (internal) ------------------------------

function defaultLog(...args) {
  // eslint-disable-next-line no-console
  console.log('[onMealplanDraftRequested]', ...args);
}

const timeUtilFallback = {
  coerceDate(input) {
    if (!input) return null;
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  },
  startOfWeek(d) {
    const date = new Date(d);
    const day = date.getDay(); // 0: Sun
    const diff = (day === 0 ? -6 : 1) - day; // make Monday the first day
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  },
  addDays(d, n) {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
  },
  enumerateDays(start, end) {
    const days = [];
    const cur = new Date(start);
    const last = new Date(end);
    cur.setHours(0, 0, 0, 0);
    last.setHours(0, 0, 0, 0);
    while (cur <= last) {
      days.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  },
};

function uuidFallback() {
  // RFC4122-ish fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = (c === 'x') ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function mergeUniqueById(a = [], b = []) {
  const seen = new Set(a.map(x => x.id));
  const out = [...a];
  for (const item of b) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

function mergeUniqueStrings(a = [], b = []) {
  const set = new Set([...(a || []), ...(b || [])].filter(Boolean));
  return Array.from(set);
}

function fallbackTemplate(ctx) {
  // Build slots from rhythm (e.g., for each day: ['breakfast','lunch','dinner'])
  const slots = [];
  const label = 'Auto (rhythm)';
  const id = 'auto-rhythm';
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  (ctx.days || []).forEach(d => {
    const dayKey = dayNames[d.getDay()];
    const meals = ctx.rhythm?.[dayKey] || ['dinner'];
    meals.forEach(meal => {
      slots.push({
        id: `${dayKey}-${meal}`,
        day: d.toISOString().slice(0, 10),
        meal, // breakfast | lunch | dinner | snack
        constraints: ctx.constraints || {},
      });
    });
  });
  return { id, label, slots };
}

function naivePlacement(candidates, slots, ctx) {
  const assignments = [];
  const conflicts = [];
  const unfilledSlots = [];
  let i = 0;

  for (const slot of slots) {
    // skip candidates that violate simple constraints if available
    let pick = null;
    while (i < candidates.length && !pick) {
      const cand = candidates[i++];
      if (violatesSimpleConstraints(cand, slot.constraints)) continue;
      pick = cand;
    }
    if (pick) {
      assignments.push({
        slotId: slot.id,
        slotTime: computeSlotDateTime(slot.day, slot.meal, ctx?.tz),
        recipe: pick,
      });
    } else {
      unfilledSlots.push(slot);
    }
  }

  if (unfilledSlots.length) {
    conflicts.push({
      kind: 'unfilled',
      count: unfilledSlots.length,
      message: 'Some slots could not be filled by naive placement.',
    });
  }

  return { assignments, conflicts, unfilledSlots };
}

function violatesSimpleConstraints(recipe, constraints = {}) {
  if (!recipe) return true;
  if (!constraints) return false;
  // Example checks (expand as needed)
  if (constraints.maxPrepMinutes && recipe.totalPrepMinutes > constraints.maxPrepMinutes) return true;
  if (constraints.dietary?.length) {
    const tags = new Set(recipe.tags || []);
    for (const rule of constraints.dietary) {
      if (rule.startsWith('without:')) {
        const t = rule.replace('without:', '').trim();
        if (tags.has(t)) return true;
      }
      if (rule.startsWith('with:')) {
        const t = rule.replace('with:', '').trim();
        if (!tags.has(t)) return true;
      }
    }
  }
  return false;
}

function computeSlotDateTime(dayISO, meal, tz) {
  // Simple defaults; your scheduleHelpers can override if present.
  const date = new Date(`${dayISO}T00:00:00`);
  const map = { breakfast: 8, lunch: 12, dinner: 18, snack: 15 };
  date.setHours(map[meal] ?? 18, 0, 0, 0);
  return date.toISOString(); // keep ISO; UI can render in tz
}

function fallsWithinAny(isoDate, windows = []) {
  if (!isoDate || !windows?.length) return false;
  const t = new Date(isoDate).getTime();
  return windows.some(w => {
    const s = new Date(w.start).getTime();
    const e = new Date(w.end).getTime();
    return t >= s && t <= e;
  });
}

function buildNbaSuggestions(placement, ctx) {
  const actions = [];
  if ((placement.conflicts || []).length) {
    actions.push({
      id: 'resolve-conflicts',
      label: 'Resolve plan conflicts',
      cta: 'Open Conflict Resolver',
      route: '/MealPlanning/Resolve',
      payload: { range: { start: ctx.start, end: ctx.end } },
    });
  }
  if ((placement.unfilledSlots || []).length) {
    actions.push({
      id: 'auto-fill-unfilled',
      label: 'Auto-fill remaining slots',
      cta: 'Auto-Fill',
      event: 'mealplan.autofill.requested',
      payload: { strategy: 'diversity-first' },
    });
  }
  actions.push({
    id: 'optimize-prep',
    label: 'Batch prep to save time',
    cta: 'Open Prep Consolidation',
    route: '/MealPlanning/Prep',
  });
  actions.push({
    id: 'review-grocery',
    label: 'Review grocery list & substitutions',
    cta: 'Open Grocery Panel',
    route: '/MealPlanning/GroceryList',
  });
  return actions;
}

function safePublish(bus, topic, message) {
  try {
    bus?.publish?.(topic, message);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[onMealplanDraftRequested] bus.publish error', topic, e);
  }
}

function serializeError(err) {
  if (!err) return { message: 'Unknown error' };
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack || '',
  };
}

function defaultRhythm(days = []) {
  // default: dinner only every day
  const out = { sun: ['dinner'], mon: ['dinner'], tue: ['dinner'], wed: ['dinner'], thu: ['dinner'], fri: ['dinner'], sat: ['dinner'] };
  return out;
}

export default onMealplanDraftRequested;
