// __tests__/grocery.builder.test.js
// grocery.builder.test.js — aisle grouping, shortages, substitutions
// ---------------------------------------------------------------------------
// This suite validates the Grocery List builder behavior used by GroceryListPanel:
// • Groups by aisle (store-aware taxonomy) with a defensive fallback
// • Marks HAVE vs SHORT using pantry snapshot, then applies garden/animal fulfillment
// • Aggregates duplicates across recipes (unit-safe) and respects includeHave toggle
// • Proposes up to 4 substitutions per SHORT line (when engine is available)
// • Sorts SHORT first → aisle → name
// • Stays resilient when engines/stores are partially missing
//
// The file ships with a minimal SUT shim (`buildGroceryList`) at the bottom so it
// runs paste-and-go. Replace that shim with your production module:
//   import { buildGroceryList } from '../groceryBuilder';
//
// Paste path suggestion:
//   src/engines/planning/__tests__/grocery.builder.test.js
//
// Prereqs: Jest (ESM or CJS ok). No DOM required.

import { jest } from '@jest/globals';

// ------------------------------- Test Mocks ----------------------------------

const TIMEZONE = 'America/New_York';

const unitConverterMock = {
  toBase({ qty, unit, name }) {
    const u = String(unit || '').toLowerCase();
    if (u === 'lb') return { qty: (qty || 0) * 16 }; // → oz
    if (u === 'can' && /coconut milk/.test((name || '').toLowerCase())) return { qty: 13.5 };
    if (u === 'count' || u === '' || u === null) return { qty: qty || 0 };
    return { qty: qty || 0 };
  },
};

const aisleTaxonomyMock = {
  map(name, { storeId } = {}) {
    const n = String(name || '').toLowerCase();
    if (/milk|yogurt|cheese/.test(n)) return 'Dairy';
    if (/egg/.test(n)) return 'Dairy';               // eggs commonly placed with dairy
    if (/onion|carrot|lettuce|herb|tomato/.test(n)) return 'Produce';
    if (/chicken|lamb|beef|pork|sausage/.test(n)) return 'Meat';
    if (/rice|flour|pasta|oats|sugar|spice|garam/.test(n)) return 'Dry Goods';
    if (/coconut milk/.test(n)) return 'International';
    if (/soap|detergent|foil|wrap|towel/.test(n)) return 'Household';
    return 'General';
  },
};

const substitutionEngineMock = {
  async findAlternates(line, ctx) {
    // super-naive alternates for tests
    const n = line.name.toLowerCase();
    if (n.includes('coconut milk')) return ['evaporated milk', 'heavy cream', 'almond milk', 'oat milk', 'soy milk']; // >4 to test clamp
    if (n.includes('lamb')) return ['beef chuck', 'turkey thigh'];
    return [];
  },
};

const estimateEngineMock = {
  async estimateLines(lines, ctx) {
    const total = lines.reduce((a, l) => a + (l.needBaseQty || 0) * 0.1, 0);
    return { total: Number(total.toFixed(2)), currency: 'USD', byAisle: {} };
  },
};

function makeInventoryStoreMock() {
  return {
    async getPantrySnapshot() {
      return {
        items: [
          { name: 'eggs', qty: 12, unit: 'count' },
          { name: 'onion', qty: 2, unit: '' },
          { name: 'rice', qty: 16, unit: 'oz' },
        ],
      };
    },
  };
}

const gardenStoreMock = {
  async getProjectedHarvest(start, end) {
    return {
      items: [
        { name: 'onion', qty: 1, unit: '' },   // extra onion from garden
        { name: 'carrot', qty: 5, unit: 'count' },
        { name: 'herb mix', qty: 1, unit: 'bunch' },
      ],
    };
  },
};

const animalStoreMock = {
  async getProjectedButchery(start, end) {
    return { items: [{ name: 'lamb', qty: 48, unit: 'oz' }] };
  },
};

const supplierStoreMock = {
  getSupplierProfiles: async () => [{ id: 'store:default', name: 'Local Market' }],
  getDefaultStoreId: () => 'store:default',
};

const userStoreMock = {
  getTimezone: () => TIMEZONE,
  getSettings: () => ({ sabbathGuard: true }),
  getProfile: () => ({ id: 'user-1', name: 'Rhonda' }),
};

// ------------------------------ Fixtures -------------------------------------

function makeAssignment({ slotId, whenISO, recipe }) {
  return {
    slotId,
    slotTime: whenISO,
    recipe,
  };
}

const RECIPES = {
  curry: {
    id: 'r1',
    name: 'Coconut Chicken Curry',
    ingredients: [
      { name: 'chicken', qty: 1, unit: 'lb' },        // 16 oz
      { name: 'onion', qty: 1, unit: '' },            // pantry+garden will cover this
      { name: 'coconut milk', qty: 1, unit: 'can' },  // 13.5 base
      { name: 'rice', qty: 8, unit: 'oz' },           // pantry has 16 oz
    ],
  },
  omelet: {
    id: 'r2',
    name: 'Herb Omelet',
    ingredients: [
      { name: 'eggs', qty: 3, unit: 'count' },        // pantry 12
      { name: 'herb mix', qty: 1, unit: 'bunch' },    // garden 1 bunch
      { name: 'onion', qty: 0.5, unit: '' },          // pantry+garden
    ],
  },
  lambStew: {
    id: 'r3',
    name: 'Lamb Stew',
    ingredients: [
      { name: 'lamb', qty: 24, unit: 'oz' },          // animal 48 oz
      { name: 'carrot', qty: 4, unit: 'count' },      // garden 5
      { name: 'onion', qty: 1, unit: '' },
    ],
  },
};

function mondayAt(hh = 18) {
  const d = new Date('2025-10-20T00:00:00.000Z'); // Mon
  d.setHours(hh, 0, 0, 0);
  return d.toISOString();
}

// --------------------------- SUT Import / Shim -------------------------------
// Replace next line with: import { buildGroceryList } from '../groceryBuilder';
import { buildGroceryList } from './_shim.groceryBuilder';

// ------------------------------- Test Setup ----------------------------------

function deps(overrides = {}) {
  return {
    bus: { publish: jest.fn() },
    engines: {
      unitConverter: unitConverterMock,
      aisleTaxonomy: aisleTaxonomyMock,
      substitutionEngine: substitutionEngineMock,
      estimateEngine: estimateEngineMock,
      ...(overrides.engines || {}),
    },
    stores: {
      scheduleStore: {
        async getAssignmentsInRange(start, end) {
          // default assignments: curry dinner + omelet breakfast
          return [
            makeAssignment({ slotId: 'mon-breakfast', whenISO: mondayAt(8), recipe: RECIPES.omelet }),
            makeAssignment({ slotId: 'mon-dinner', whenISO: mondayAt(18), recipe: RECIPES.curry }),
          ];
        },
      },
      recipesStore: { async getByIds(ids) { return ids.map(id => RECIPES[id]); } },
      inventoryStore: makeInventoryStoreMock(),
      gardenStore: gardenStoreMock,
      animalStore: animalStoreMock,
      supplierStore: supplierStoreMock,
      userStore: userStoreMock,
      ...(overrides.stores || {}),
    },
    helpers: {
      uuid: (() => { let i = 0; return (p = 'id-') => `${p}${++i}`; })(),
      time: {
        coerceDate: (x) => x ? new Date(x) : null,
        startOfWeek: (d) => {
          const n = new Date(d);
          const day = n.getUTCDay(); // 0 Sun
          const diff = (day + 6) % 7; // back to Monday
          n.setUTCDate(n.getUTCDate() - diff);
          n.setUTCHours(0, 0, 0, 0);
          return n;
        },
        addDays: (d, n) => { const t = new Date(d); t.setUTCDate(t.getUTCDate() + n); return t; },
      },
    },
    log: () => {},
  };
}

// --------------------------------- Tests -------------------------------------

describe('Grocery Builder — aisle grouping, shortages, substitutions', () => {
  test('groups items by aisle and marks shortages; hides HAVE when includeHave=false', async () => {
    const res = await buildGroceryList(
      {
        startDate: '2025-10-20',
        endDate: '2025-10-26',
        options: {
          aisleGroups: true,
          includeHave: false,            // only show shortages
          collapseDuplicates: true,
          allowSubstitutions: true,
          storeId: 'store:default',
          preferGarden: true,
          preferAnimal: true,
        },
      },
      deps()
    );

    // All lines are shortages only (have items filtered out)
    expect(res.list.every(l => l.status === 'short')).toBe(true);

    // Aisle mapping checks
    const byAisle = groupBy(res.list, l => l.aisle);
    expect(Object.keys(byAisle)).toEqual(expect.arrayContaining(['Meat', 'International', 'Dry Goods', 'Produce', 'Dairy']));

    // Specific items:
    const coconut = res.list.find(l => /coconut milk/i.test(l.name));
    expect(coconut.aisle).toBe('International');
    expect((coconut.substitutions || []).length).toBeLessThanOrEqual(4); // clamped

    // Rice should be HAVE in pantry (16 oz) but curry needs 8 oz → with includeHave=false it won't be visible
    const riceLine = res.list.find(l => /rice/i.test(l.name));
    expect(riceLine).toBeUndefined();

    // Onion should be covered by pantry+garden and thus not appear (includeHave=false)
    const onionLine = res.list.find(l => /onion/i.test(l.name));
    expect(onionLine).toBeUndefined();

    // Ensure list sorted: SHORT first already true, then aisle then name
    const sortedCopy = [...res.list].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'short' ? -1 : 1;
      if ((a.aisle || '') !== (b.aisle || '')) return (a.aisle || '').localeCompare(b.aisle || '');
      return a.name.localeCompare(b.name);
    });
    expect(res.list.map(x => x.name)).toEqual(sortedCopy.map(x => x.name));
  });

  test('prefer garden/animal reduces shortages and adds fulfillment badges', async () => {
    // Add lamb stew to the plan to leverage animal + garden coverage
    const d = deps({
      stores: {
        scheduleStore: {
          async getAssignmentsInRange() {
            return [
              makeAssignment({ slotId: 'mon-dinner', whenISO: mondayAt(18), recipe: RECIPES.lambStew }),
            ];
          },
        },
      },
    });

    const res = await buildGroceryList(
      {
        startDate: '2025-10-20',
        endDate: '2025-10-20',
        options: {
          includeHave: true,             // keep HAVE lines so we can inspect badges
          preferGarden: true,
          preferAnimal: true,
        },
      },
      d
    );

    const lamb = res.list.find(l => /lamb/i.test(l.name));
    expect(lamb).toBeTruthy();
    // Animal store covers 48 oz; recipe needs 24 oz → should show HAVE
    expect(lamb.status).toBe('have');
    expect(new Set(lamb.badges)).toContain('FULFILLED_BY_ANIMAL');

    const carrot = res.list.find(l => /carrot/i.test(l.name));
    // Garden covers 5 count; need 4 → HAVE with badge
    expect(carrot.status).toBe('have');
    expect(new Set(carrot.badges)).toContain('FULFILLED_BY_GARDEN');
  });

  test('duplicate aggregation and base-unit conversion across recipes', async () => {
    // Plan with curry + another rice dish to test aggregation
    const d = deps({
      stores: {
        scheduleStore: {
          async getAssignmentsInRange() {
            return [
              makeAssignment({ slotId: 'mon-dinner', whenISO: mondayAt(18), recipe: RECIPES.curry }),
              makeAssignment({
                slotId: 'mon-lunch',
                whenISO: mondayAt(12),
                recipe: {
                  id: 'r4',
                  name: 'Fried Rice',
                  ingredients: [{ name: 'rice', qty: 1, unit: 'lb' }], // 16 oz more
                },
              }),
            ];
          },
        },
      },
    });

    const res = await buildGroceryList(
      {
        startDate: '2025-10-20',
        endDate: '2025-10-20',
        options: {
          collapseDuplicates: true,
          includeHave: false,          // show only shortage lines
        },
      },
      d
    );

    const rice = res.list.find(l => l.name.toLowerCase() === 'rice');
    // Need: curry 8 oz + fried rice 16 oz = 24 oz ; Pantry has 16 oz → SHORT 8 oz
    expect(rice).toBeTruthy();
    expect(rice.status).toBe('short');
    // After base conversion & aggregation, remaining need should be > 0 but not more than 8
    expect(rice.needBaseQty).toBeGreaterThan(0);
    expect(rice.needBaseQty).toBeLessThanOrEqual(8);
  });

  test('defensive behavior when engines are missing: still returns coherent list', async () => {
    const d = deps({
      engines: {
        unitConverter: null,
        aisleTaxonomy: null,
        substitutionEngine: null,
        estimateEngine: null,
      },
    });

    const res = await buildGroceryList(
      {
        startDate: '2025-10-20',
        endDate: '2025-10-20',
        options: { includeHave: true },
      },
      d
    );

    // Should not crash; produce a list with generic aisles and no substitutions
    expect(Array.isArray(res.list)).toBe(true);
    const any = res.list[0];
    expect(any).toHaveProperty('name');
    expect(any).toHaveProperty('status');
    expect(any).toHaveProperty('aisle');                 // "General" fallback
    expect(any.substitutions || []).toEqual([]);
    expect(res.summary).toHaveProperty('lines');
  });
});

// --------------------------------- Helpers -----------------------------------

function groupBy(arr, fn) {
  return arr.reduce((m, x) => {
    const k = fn(x);
    m[k] = m[k] || [];
    m[k].push(x);
    return m;
  }, {});
}

// ----------------------------- Minimal SUT Shim ------------------------------
// Swap this for your real implementation in ../groceryBuilder

export async function buildGroceryList(payload = {}, deps) {
  const {
    bus,
    engines = {},
    stores = {},
    helpers = {},
    log = () => {},
  } = deps;

  const {
    unitConverter,
    aisleTaxonomy,
    substitutionEngine,
    estimateEngine,
  } = engines;

  const {
    scheduleStore,
    recipesStore,
    inventoryStore,
    gardenStore,
    animalStore,
    supplierStore,
    userStore,
  } = stores;

  const time = helpers.time || {};
  const tz = userStore?.getTimezone?.() || TIMEZONE;

  const start = time.coerceDate?.(payload.startDate) || time.startOfWeek?.(new Date()) || new Date();
  const end = time.coerceDate?.(payload.endDate) || time.addDays?.(start, 6) || start;

  const opts = {
    includeHave: payload?.options?.includeHave ?? false,
    collapseDuplicates: payload?.options?.collapseDuplicates ?? true,
    allowSubstitutions: payload?.options?.allowSubstitutions ?? true,
    aisleGroups: payload?.options?.aisleGroups ?? true,
    storeId: payload?.options?.storeId || supplierStore?.getDefaultStoreId?.(),
    preferGarden: payload?.options?.preferGarden ?? true,
    preferAnimal: payload?.options?.preferAnimal ?? true,
  };

  // 1) Load assignments
  const assignments = await (scheduleStore?.getAssignmentsInRange?.(start, end) || Promise.resolve([]));

  // 2) Collect raw ingredient lines
  const raw = [];
  for (const a of assignments) {
    for (const ing of a.recipe?.ingredients || []) {
      const name = String(ing.name || '').trim().toLowerCase();
      if (!name) continue;
      raw.push({
        name,
        qty: Number(ing.qty || 0),
        unit: (ing.unit || '').toLowerCase() || null,
        form: ing.form || null,
        brand: ing.brand || null,
        recipeId: a.recipe?.id,
        slotId: a.slotId,
      });
    }
  }

  // 3) Aggregate duplicates (base-unit aware)
  const keyOf = (l) => [l.name, l.form || '', l.brand || '', l.unit || ''].join('|');
  const toBase = (l) => {
    try {
      return unitConverter?.toBase?.({ qty: l.qty, unit: l.unit, name: l.name })?.qty ?? l.qty;
    } catch { return l.qty; }
  };
  const map = new Map();
  for (const l of raw) {
    const k = keyOf(l);
    const base = toBase(l);
    if (map.has(k)) {
      const prev = map.get(k);
      map.set(k, { ...prev, qty: prev.qty + l.qty, baseQty: (prev.baseQty || 0) + (base || 0) });
    } else {
      map.set(k, { ...l, baseQty: base });
    }
  }
  let lines = Array.from(map.values());

  // 4) Apply pantry snapshot (HAVE/SHORT)
  const pantry = await (inventoryStore?.getPantrySnapshot?.() || { items: [] });
  const haveMap = new Map((pantry.items || []).map((i) => {
    const k = [String(i.name || '').toLowerCase(), i.form || '', i.brand || '', (i.unit || '').toLowerCase()].join('|');
    const base = (() => {
      try { return unitConverter?.toBase?.({ qty: i.qty, unit: i.unit, name: i.name })?.qty ?? i.qty; }
      catch { return i.qty; }
    })();
    return [k, base];
  }));

  lines = lines.map(l => {
    const have = haveMap.get(keyOf(l)) || 0;
    const need = Math.max(0, (l.baseQty || 0) - have);
    return {
      ...l,
      haveBaseQty: have,
      needBaseQty: need,
      status: need > 0 ? 'short' : 'have',
      badges: need > 0 ? ['SHORT'] : ['HAVE'],
    };
  });

  // 5) Garden/animal fulfillment
  async function applyHomestead(tag, supply) {
    const smap = new Map((supply.items || []).map(s => {
      const k = [String(s.name || '').toLowerCase(), s.form || '', s.brand || '', (s.unit || '').toLowerCase()].join('|');
      const base = (() => {
        try { return unitConverter?.toBase?.({ qty: s.qty, unit: s.unit, name: s.name })?.qty ?? s.qty; }
        catch { return s.qty; }
      })();
      return [k, base];
    }));
    lines = lines.map(l => {
      if (l.status === 'have') return l;
      const avail = smap.get(keyOf(l)) || 0;
      if (!avail) return l;
      const remaining = Math.max(0, (l.needBaseQty || 0) - avail);
      const badges = new Set(l.badges || []);
      badges.add(remaining === 0 ? `FULFILLED_BY_${tag.toUpperCase()}` : `PARTIAL_${tag.toUpperCase()}`);
      return { ...l, needBaseQty: remaining, status: remaining > 0 ? 'short' : 'have', badges: Array.from(badges), homestead: { ...(l.homestead || {}), [tag]: Math.min(l.needBaseQty || 0, avail) } };
    });
  }

  if (opts.preferGarden) {
    const harvest = await (gardenStore?.getProjectedHarvest?.(start, end).catch(() => ({ items: [] })));
    await applyHomestead('garden', harvest || { items: [] });
  }
  if (opts.preferAnimal) {
    const butchery = await (animalStore?.getProjectedButchery?.(start, end).catch(() => ({ items: [] })));
    await applyHomestead('animal', butchery || { items: [] });
  }

  // 6) Substitutions
  if (opts.allowSubstitutions && substitutionEngine?.findAlternates) {
    lines = await Promise.all(lines.map(async (l) => {
      if (l.status !== 'short') return { ...l, substitutions: [] };
      try {
        const alts = await substitutionEngine.findAlternates(l, { tz, storeId: opts.storeId });
        return { ...l, substitutions: (alts || []).slice(0, 4) };
      } catch { return { ...l, substitutions: [] }; }
    }));
  } else {
    lines = lines.map(l => ({ ...l, substitutions: [] }));
  }

  // 7) Aisle mapping
  lines = lines.map(l => ({
    ...l,
    aisle: (opts.aisleGroups && aisleTaxonomy?.map) ? (aisleTaxonomy.map(l.name, { storeId: opts.storeId }) || 'General') : 'General',
  }));

  // 8) Filter visibility (includeHave)
  let visible = opts.includeHave ? lines : lines.filter(l => l.status === 'short');

  // 9) Sort: SHORT first → aisle → name
  visible = visible.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'short' ? -1 : 1;
    if ((a.aisle || '') !== (b.aisle || '')) return (a.aisle || '').localeCompare(b.aisle || '');
    return (a.name || '').localeCompare(b.name || '');
  });

  // 10) Estimate
  const estimate = estimateEngine ? await estimateEngine.estimateLines(visible, { tz, storeId: opts.storeId }) : { total: 0, currency: 'USD', byAisle: {} };

  const summary = {
    lines: visible.length,
    shortLines: visible.filter(l => l.status === 'short').length,
    haveLines: visible.filter(l => l.status === 'have').length,
    byAisle: visible.reduce((m, l) => ((m[l.aisle] = (m[l.aisle] || 0) + 1), m), {}),
    estimatedTotal: estimate.total || 0,
    currency: estimate.currency || 'USD',
  };

  const meta = {
    range: { start: start.toISOString(), end: end.toISOString(), tz },
    storeId: opts.storeId,
    generator: 'groceryBuilder.testShim.v1',
  };

  // emit event (optional)
  try { bus?.publish?.('grocery.list.generated', { list: visible, summary, meta }); } catch {}

  return { list: visible, summary, meta };
}
