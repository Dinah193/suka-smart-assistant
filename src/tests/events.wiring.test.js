// __tests__/events.wiring.test.js
// events.wiring.test.js — end-to-end event emissions & handlers
// -----------------------------------------------------------------------------
// This suite verifies the event bus wiring across the planning stack:
//  • mealplan.draft.requested  → onMealplanDraftRequested
//      ↳ emits mealplan.draft.generated + nba.suggest
//      ↳ orchestrator fans out to grocery.list.requested
//  • grocery.list.requested    → onGroceryListRequested
//      ↳ emits grocery.list.generated + nba.suggest
//  • prep.tasks.requested      → onPrepTasksRequested
//      ↳ emits prep.tasks.generated + batch.session.created + nba.suggest
//
// The tests use a tiny async event bus and minimal handler shims so they run
// paste-and-go. Replace the shims with your production handlers to validate
// your real wiring:
//
//   import { onMealplanDraftRequested } from '../onMealplanDraftRequested';
//   import { onGroceryListRequested } from '../onGroceryListRequested';
//   import { onPrepTasksRequested }    from '../onPrepTasksRequested';
//
// Paste path suggestion:
//   src/engines/planning/__tests__/events.wiring.test.js
//
// Prereqs: Jest (ESM or CJS ok).

import { jest } from '@jest/globals';

// -----------------------------------------------------------------------------
// Async Event Bus (test-local)
// -----------------------------------------------------------------------------
function createBus() {
  const subs = new Map();
  const history = [];
  return {
    async publish(topic, payload) {
      history.push({ topic, payload });
      const fns = subs.get(topic) || [];
      // Await all handlers (supports async handlers)
      await Promise.all(fns.map(fn => fn(payload)));
    },
    subscribe(topic, handler) {
      const list = subs.get(topic) || [];
      list.push(handler);
      subs.set(topic, list);
      return () => {
        const current = subs.get(topic) || [];
        subs.set(topic, current.filter(h => h !== handler));
      };
    },
    get _subs() { return subs; },
    get _history() { return history; },
  };
}

// -----------------------------------------------------------------------------
// Deps (stores/engines) shared by tests
// -----------------------------------------------------------------------------
const TIMEZONE = 'America/New_York';

function mondayAt(hh = 18) {
  const d = new Date('2025-10-20T00:00:00.000Z');
  d.setUTCHours(hh, 0, 0, 0);
  return d.toISOString();
}

function makeAssignment({ slotId, whenISO, recipe }) {
  const start = new Date(whenISO);
  const end = new Date(start); end.setMinutes(end.getMinutes() + (recipe.totalPrepMinutes || 45));
  return { slotId, slotTime: start.toISOString(), endTime: end.toISOString(), recipe };
}

const RECIPES = {
  roast: { id: 'r1', name: 'Roast Chicken', totalPrepMinutes: 60, primaryAppliance: 'oven', ingredients: [{ name: 'chicken', qty: 2, unit: 'lb' }, { name: 'onion', qty: 1, unit: '' }] },
  curry: { id: 'r2', name: 'Coconut Curry', totalPrepMinutes: 40, primaryAppliance: 'stovetop', ingredients: [{ name: 'coconut milk', qty: 1, unit: 'can' }, { name: 'rice', qty: 12, unit: 'oz' }] },
  omelet:{ id: 'r3', name: 'Herb Omelet', totalPrepMinutes: 10, primaryAppliance: 'stovetop', ingredients: [{ name: 'eggs', qty: 3, unit: 'count' }, { name: 'herb mix', qty: 1, unit: 'bunch' }] },
};

function deps() {
  const scheduleStore = {
    async getAssignmentsInRange() {
      return [
        makeAssignment({ slotId: 'mon-breakfast', whenISO: mondayAt(8),  recipe: RECIPES.omelet }),
        makeAssignment({ slotId: 'mon-dinner',    whenISO: mondayAt(18), recipe: RECIPES.curry }),
      ];
    },
    async saveDraft(draft) { return draft; },
  };
  const recipesStore = { async getByIds(ids) { return ids.map(id => RECIPES[id]); } };
  const inventoryStore = {
    async getPantrySnapshot() {
      return { items: [{ name: 'rice', qty: 16, unit: 'oz' }, { name: 'eggs', qty: 12, unit: 'count' }, { name: 'onion', qty: 1, unit: '' }] };
    },
  };
  const gardenStore = { async getProjectedHarvest() { return { items: [{ name: 'herb mix', qty: 1, unit: 'bunch' }] }; } };
  const animalStore = { async getProjectedButchery() { return { items: [] }; } };
  const supplierStore = { getDefaultStoreId: () => 'store:default', getSupplierProfiles: async () => [{ id: 'store:default' }] };
  const userStore = { getTimezone: () => TIMEZONE, getSettings: () => ({ sabbathGuard: true }), getProfile: () => ({ id: 'user-1' }) };

  const unitConverter = {
    toBase({ qty, unit, name }) {
      const u = String(unit || '').toLowerCase();
      if (u === 'lb') return { qty: (qty || 0) * 16 };
      if (u === 'can' && /coconut milk/i.test(name || '')) return { qty: 13.5 };
      return { qty: qty || 0 };
    },
  };
  const aisleTaxonomy = {
    map(name) {
      const n = String(name || '').toLowerCase();
      if (/egg/.test(n)) return 'Dairy';
      if (/herb|onion/.test(n)) return 'Produce';
      if (/rice|coconut/.test(n)) return 'Dry Goods';
      return 'General';
    },
  };
  const substitutionEngine = {
    async findAlternates(line) {
      if (/coconut milk/i.test(line.name)) return ['evaporated milk', 'oat milk'];
      return [];
    },
  };
  const estimateEngine = {
    async estimateLines(lines) { return { total: lines.reduce((a, l) => a + (l.needBaseQty || 0) * 0.1, 0), currency: 'USD' }; },
    async estimateTasks(tasks) { return { totalMinutes: tasks.reduce((a, t) => a + (t.estMinutes || 0), 0) }; },
  };
  const scheduleHelpers = {
    guardWindows(start, end) {
      // Fri 6pm → Sat 6pm guard (not exercised heavily in this suite)
      return [];
    },
    buildTimers(tasks) {
      return tasks.map(t => t.estMinutes > 0 ? { ...t, timer: { durationSec: t.estMinutes * 60 } } : t);
    },
  };
  const time = {
    coerceDate: (x) => (x ? new Date(x) : null),
    startOfWeek: (d) => {
      const n = new Date(d);
      const day = n.getUTCDay(); // 0 Sun
      const diff = (day + 6) % 7;
      n.setUTCDate(n.getUTCDate() - diff);
      n.setUTCHours(0, 0, 0, 0);
      return n;
    },
    addDays: (d, n) => { const t = new Date(d); t.setUTCDate(t.getUTCDate() + n); return t; },
    addMinutes: (d, m) => { const t = new Date(d); t.setUTCMinutes(t.getUTCMinutes() + m); return t; },
  };
  const uuid = (() => { let i = 0; return (p = 'id-') => `${p}${++i}`; })();

  return {
    engines: { unitConverter, aisleTaxonomy, substitutionEngine, estimateEngine, scheduleHelpers },
    stores: { scheduleStore, recipesStore, inventoryStore, gardenStore, animalStore, supplierStore, userStore },
    helpers: { time, uuid },
    log: () => {},
  };
}

// -----------------------------------------------------------------------------
// Handler wiring (replace the three shims with your production handlers)
// -----------------------------------------------------------------------------
const onMealplanDraftRequested = _shim_onMealplanDraftRequested;
const onGroceryListRequested = _shim_onGroceryListRequested;
const onPrepTasksRequested = _shim_onPrepTasksRequested;

// Orchestrator: subscribes to events and routes to handlers
function wireEvents(bus, baseDeps) {
  // mealplan.draft.requested → generate draft
  bus.subscribe('mealplan.draft.requested', async (payload) => {
    await onMealplanDraftRequested(payload, { bus, ...baseDeps });
  });

  // When a draft is generated, fan out to grocery list for the same range
  bus.subscribe('mealplan.draft.generated', async ({ draft }) => {
    await bus.publish('grocery.list.requested', {
      startDate: draft.range.start,
      endDate: draft.range.end,
      options: { storeId: draft?.options?.storeId || baseDeps?.stores?.supplierStore?.getDefaultStoreId?.() },
    });
  });

  // grocery.list.requested → build list
  bus.subscribe('grocery.list.requested', async (payload) => {
    await onGroceryListRequested(payload, { bus, ...baseDeps });
  });

  // prep.tasks.requested → create batch session
  bus.subscribe('prep.tasks.requested', async (payload) => {
    await onPrepTasksRequested(payload, { bus, ...baseDeps });
  });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
describe('Events wiring — end-to-end emissions & handlers', () => {
  test('mealplan draft request → draft generated → grocery list requested → grocery list generated', async () => {
    const bus = createBus();
    const d = deps();
    wireEvents(bus, d);

    // Collect key events for assertions
    const seen = { draft: null, grocery: null, nba: [] };
    bus.subscribe('mealplan.draft.generated', ({ draft }) => { seen.draft = draft; });
    bus.subscribe('grocery.list.generated', ({ list, summary, meta }) => { seen.grocery = { list, summary, meta }; });
    bus.subscribe('nba.suggest', (payload) => { seen.nba.push(payload); });

    // Kick off the chain
    await bus.publish('mealplan.draft.requested', {
      startDate: '2025-10-20',
      endDate: '2025-10-26',
      options: { includeHave: false, storeId: 'store:default' },
    });

    // Assertions: Draft exists
    expect(seen.draft).toBeTruthy();
    expect(seen.draft.assignments.length).toBeGreaterThan(0);
    expect(seen.draft.range.start).toMatch(/2025-10-20/);

    // Grocery list should be auto-generated via fan-out
    expect(seen.grocery).toBeTruthy();
    expect(Array.isArray(seen.grocery.list)).toBe(true);
    // Only shortages by default in our options
    expect(seen.grocery.list.every(l => l.status === 'short')).toBe(true);

    // NBA suggestions should have been emitted at least once in the chain
    expect(seen.nba.length).toBeGreaterThan(0);
    expect(seen.nba.some(n => n.scope === 'mealplan' || n.scope === 'grocery')).toBe(true);
  });

  test('standalone grocery.list.requested emits grocery.list.generated + nba.suggest', async () => {
    const bus = createBus();
    const d = deps();
    wireEvents(bus, d);

    const seen = { grocery: null, nba: null };
    bus.subscribe('grocery.list.generated', (p) => { seen.grocery = p; });
    bus.subscribe('nba.suggest', (p) => { if (p.scope === 'grocery') seen.nba = p; });

    await bus.publish('grocery.list.requested', {
      startDate: '2025-10-20',
      endDate: '2025-10-20',
      options: { includeHave: true, storeId: 'store:default' },
    });

    expect(seen.grocery).toBeTruthy();
    expect(seen.grocery.summary.lines).toBeGreaterThan(0);
    expect(seen.nba).toBeTruthy(); // Next Best Actions prompt present
  });

  test('prep.tasks.requested → emits prep.tasks.generated + batch.session.created + nba.suggest', async () => {
    const bus = createBus();
    const d = deps();
    wireEvents(bus, d);

    const seen = { prep: null, batch: null, nba: null };
    bus.subscribe('prep.tasks.generated', (p) => { seen.prep = p; });
    bus.subscribe('batch.session.created', (p) => { seen.batch = p; });
    bus.subscribe('nba.suggest', (p) => { if (p.scope === 'prep') seen.nba = p; });

    await bus.publish('prep.tasks.requested', {
      startDate: '2025-10-20T13:00:00.000Z',
      endDate: '2025-10-20T16:00:00.000Z',
      options: { maxSessionMinutes: 120, createLabels: true },
    });

    expect(seen.prep).toBeTruthy();
    expect(seen.prep.session.kind).toBe('prep');
    expect(Array.isArray(seen.prep.tasks)).toBe(true);
    expect(seen.batch).toBeTruthy();
    expect(seen.nba).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// Minimal handler shims (replace with your real implementations if present)
// -----------------------------------------------------------------------------

// Shim: onMealplanDraftRequested — builds a naive draft from scheduleStore
export async function _shim_onMealplanDraftRequested(payload, depsCtx) {
  const { bus, stores, helpers } = depsCtx;
  const { scheduleStore, userStore, supplierStore } = stores;
  const { time, uuid } = helpers;

  const tz = userStore?.getTimezone?.() || TIMEZONE;
  const start = time.coerceDate(payload.startDate) || time.startOfWeek(new Date());
  const end = time.coerceDate(payload.endDate) || time.addDays(start, 6);

  const assignments = await scheduleStore.getAssignmentsInRange(start, end);

  const draft = {
    id: uuid('draft-'),
    kind: 'mealplan.draft',
    createdAt: new Date().toISOString(),
    range: { start: start.toISOString(), end: end.toISOString(), tz },
    options: { storeId: payload?.options?.storeId || supplierStore?.getDefaultStoreId?.() },
    assignments,
    conflicts: [],
    analytics: { assignedCount: assignments.length },
  };

  await bus.publish('mealplan.draft.generated', { draft });
  await bus.publish('nba.suggest', {
    scope: 'mealplan',
    actions: [{ id: 'review-grocery', label: 'Review grocery list', cta: 'Open Grocery', route: '/MealPlanning/GroceryList' }],
    priority: 'high',
  });

  return draft;
}

// Shim: onGroceryListRequested — builds a tiny grocery list (HAVE/SHORT + aisles)
export async function _shim_onGroceryListRequested(payload, depsCtx) {
  const { bus, engines, stores, helpers } = depsCtx;
  const { unitConverter, aisleTaxonomy, substitutionEngine, estimateEngine } = engines;
  const { scheduleStore, inventoryStore, gardenStore, supplierStore, userStore } = stores;
  const { time } = helpers;

  const tz = userStore?.getTimezone?.() || TIMEZONE;
  const start = time.coerceDate(payload.startDate) || time.startOfWeek(new Date());
  const end = time.coerceDate(payload.endDate) || time.addDays(start, 6);
  const opts = {
    includeHave: payload?.options?.includeHave ?? false,
    storeId: payload?.options?.storeId || supplierStore?.getDefaultStoreId?.(),
  };

  const assigns = await scheduleStore.getAssignmentsInRange(start, end);
  const raw = [];
  for (const a of assigns) for (const ing of a.recipe?.ingredients || []) raw.push({ name: ing.name.toLowerCase(), qty: +ing.qty || 0, unit: (ing.unit || '').toLowerCase() });

  const key = (l) => [l.name, l.unit || ''].join('|');
  const toBase = (l) => unitConverter?.toBase?.({ qty: l.qty, unit: l.unit, name: l.name })?.qty ?? l.qty;
  const agg = new Map();
  for (const l of raw) {
    const k = key(l); const b = toBase(l);
    const prev = agg.get(k);
    agg.set(k, prev ? { ...prev, baseQty: prev.baseQty + b } : { ...l, baseQty: b });
  }
  let lines = Array.from(agg.values());

  const pantry = await inventoryStore.getPantrySnapshot();
  const haveMap = new Map((pantry.items || []).map(i => [key({ name: (i.name || '').toLowerCase(), unit: (i.unit || '').toLowerCase() }), unitConverter?.toBase?.({ qty: i.qty, unit: i.unit, name: i.name })?.qty ?? i.qty]));
  lines = lines.map(l => {
    const have = haveMap.get(key(l)) || 0;
    const need = Math.max(0, (l.baseQty || 0) - have);
    return {
      ...l,
      needBaseQty: need,
      status: need > 0 ? 'short' : 'have',
      aisle: aisleTaxonomy?.map?.(l.name, { storeId: opts.storeId }) || 'General',
    };
  });

  // simple garden fulfillment
  const garden = await gardenStore.getProjectedHarvest(start, end);
  const gmap = new Map((garden.items || []).map(i => [key({ name: (i.name || '').toLowerCase(), unit: (i.unit || '').toLowerCase() }), unitConverter?.toBase?.({ qty: i.qty, unit: i.unit, name: i.name })?.qty ?? i.qty]));
  lines = lines.map(l => {
    if (l.status === 'have') return l;
    const g = gmap.get(key(l)) || 0;
    const need = Math.max(0, (l.needBaseQty || 0) - g);
    return { ...l, needBaseQty: need, status: need > 0 ? 'short' : 'have' };
  });

  // substitutions (only for shorts)
  lines = await Promise.all(lines.map(async l => {
    if (l.status !== 'short') return { ...l, substitutions: [] };
    const alts = await (substitutionEngine?.findAlternates?.(l, {}) || []);
    return { ...l, substitutions: (alts || []).slice(0, 4) };
  }));

  // filter
  const visible = opts.includeHave ? lines : lines.filter(l => l.status === 'short');

  // estimate
  const estimate = await (estimateEngine?.estimateLines?.(visible, { tz, storeId: opts.storeId }) || { total: 0, currency: 'USD' });
  const summary = {
    lines: visible.length,
    shortLines: visible.filter(l => l.status === 'short').length,
    haveLines: visible.filter(l => l.status === 'have').length,
    estimatedTotal: estimate.total || 0,
    currency: estimate.currency || 'USD',
  };
  const meta = { range: { start: start.toISOString(), end: end.toISOString(), tz }, storeId: opts.storeId };

  await bus.publish('grocery.list.generated', { list: visible, summary, meta });
  await bus.publish('nba.suggest', {
    scope: 'grocery',
    actions: [{ id: 'schedule-pickup', label: 'Schedule pickup/delivery', cta: 'Choose Store', route: '/MealPlanning/GroceryList' }],
  });

  return { list: visible, summary, meta };
}

// Shim: onPrepTasksRequested — generates minimal batch session with timers
export async function _shim_onPrepTasksRequested(payload, depsCtx) {
  const { bus, stores, engines, helpers } = depsCtx;
  const { scheduleStore, userStore } = stores;
  const { scheduleHelpers } = engines;
  const { time, uuid } = helpers;

  const tz = userStore?.getTimezone?.() || TIMEZONE;
  const start = time.coerceDate(payload.startDate) || new Date();
  const end = time.coerceDate(payload.endDate) || time.addMinutes(start, payload?.options?.maxSessionMinutes || 120);

  const assigns = await scheduleStore.getAssignmentsInRange(start, end);
  let tasks = assigns.map((a, i) => ({
    id: uuid('task-'),
    title: `Prep for ${a.recipe.name}`,
    estMinutes: a.recipe.totalPrepMinutes || 15,
    recipeIds: [a.recipe.id],
  }));

  if (payload?.options?.autoTimers !== false && scheduleHelpers?.buildTimers) {
    tasks = scheduleHelpers.buildTimers(tasks, { tz });
  }

  const session = {
    id: uuid('batch-'),
    label: `Prep • ${new Date(start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`,
    kind: 'prep',
    tz,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    stats: { tasks: tasks.length, totalMinutes: tasks.reduce((a, t) => a + (t.estMinutes || 0), 0) },
  };

  await bus.publish('prep.tasks.generated', { session, tasks, meta: { tz, start: start.toISOString(), end: end.toISOString() } });
  await bus.publish('batch.session.created', { session });
  await bus.publish('nba.suggest', {
    scope: 'prep',
    actions: [{ id: 'start-batch-now', label: 'Start batch session', cta: 'Open Batch Runner', route: '/MealPlanning/BatchRunner' }],
  });

  return { session, tasks };
}

// Re-export shims under expected names for imports above
export { _shim_onMealplanDraftRequested as onMealplanDraftRequested };
export { _shim_onGroceryListRequested as onGroceryListRequested };
export { _shim_onPrepTasksRequested as onPrepTasksRequested };
