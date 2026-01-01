// __tests__/decider.scoring.test.js
// decider.scoring.test.js — on-hand / time / budget / diet scoring + reasons
// ---------------------------------------------------------------------------
// This suite verifies a decider scoring engine that:
// • Rewards on-hand (pantry + projected garden/animal) coverage
// • Penalizes time over a maxPrep cap (and rewards quick recipes)
// • Penalizes cost above budget (and rewards frugal picks)
// • Enforces diet constraints (with: / without: tag rules)
// • Returns a transparent reasons[] list per recipe, suitable for UI tooltips
//
// The tests use DI-friendly mocks and a minimal SUT shim so they run standalone.
// If you already have a decider, replace the SUT shim with your implementation.
//
// Paste path suggestion:
//   src/engines/planning/__tests__/decider.scoring.test.js
//
// Prereqs: Jest (supports ESM or CJS as configured in your repo). We use no DOM.

import { jest } from '@jest/globals';

// ------------------------------- SUT import ---------------------------------
// If you have an actual engine, import it here instead and delete the shim below.
// Example: import { scoreCandidates } from '../deciderScoring';
import { scoreCandidates } from './_shim.deciderScoring'; // <-- test-local shim (defined at bottom)

// ------------------------------- Test Mocks ---------------------------------

const unitConverterMock = {
  toBase({ qty, unit, name }) {
    // Very naive base conversion just to support the test signals
    const u = String(unit || '').toLowerCase();
    if (u === 'lb') return { qty: (qty || 0) * 16 }; // oz
    if (u === 'can') return { qty: 12 };             // arbitrary
    return { qty: qty || 0 };
  },
};

const inventoryStoreMock = {
  getPantrySnapshot: async () => ({
    items: [
      { name: 'eggs', qty: 12, unit: 'count' },
      { name: 'onion', qty: 2, unit: '' },
      { name: 'rice', qty: 32, unit: 'oz' },
    ],
  }),
};

const gardenStoreMock = {
  getProjectedHarvest: async () => ({
    items: [
      { name: 'carrot', qty: 10, unit: 'count' },
      { name: 'parsley', qty: 1, unit: 'bunch' },
    ],
  }),
};

const animalStoreMock = {
  getProjectedButchery: async () => ({
    items: [
      { name: 'lamb', qty: 48, unit: 'oz' },
    ],
  }),
};

const estimateEngineMock = {
  // Estimate entire recipe cost
  async estimateRecipe(recipe, ctx) {
    // Cheapness knob via tag or explicit field for tests
    if (recipe.meta?.mockCost != null) {
      return { total: recipe.meta.mockCost, currency: 'USD' };
    }
    // Rule-of-thumb price: 0.25 per ingredient oz + 2 base
    const sum = (recipe.ingredients || []).reduce((a, ing) => a + (ing.qty ? Number(ing.qty) : 0), 0);
    return { total: 2 + 0.25 * sum, currency: 'USD' };
  },
};

const recipeNormalizerMock = {
  async normalizeAll(items) {
    return items.map((r) => ({
      ...r,
      ingredients: (r.ingredients || []).map((ing) => {
        if (String(ing.unit).toLowerCase() === 'lb') {
          return { ...ing, qty: (ing.qty || 0) * 16, unit: 'oz' };
        }
        return ing;
      }),
    }));
  },
};

const taggingAutoClassifierMock = {
  infer(recipe) {
    // Just echo existing tags; in real engine, infer from text
    return { tags: recipe.tags || [] };
  },
};

const userStoreMock = {
  getTimezone: () => 'America/New_York',
  getSettings: () => ({ sabbathGuard: true }),
  getProfile: () => ({ id: 'user-1', name: 'Rhonda' }),
};

// ---------------------------- Fixtures (Recipes) ----------------------------

/**
 * rQuickEggs — fast, cheap, mostly on-hand, breakfast, dairy-free/gluten-free friendly
 */
const rQuickEggs = {
  id: 'r1',
  name: 'Quick Scrambled Eggs & Rice',
  tags: ['breakfast', 'protein:egg'],
  totalPrepMinutes: 10,
  ingredients: [
    { name: 'eggs', qty: 4, unit: 'count' },
    { name: 'rice', qty: 8, unit: 'oz' },
    { name: 'onion', qty: 0.25, unit: '' },
  ],
  meta: { mockCost: 3.5 },
};

/**
 * rLambStew — long prep, medium cost, heavy garden/animal coverage (lamb, carrots, onion)
 */
const rLambStew = {
  id: 'r2',
  name: 'Slow Lamb Stew with Carrots',
  tags: ['dinner', 'protein:lamb', 'stew'],
  totalPrepMinutes: 95,
  ingredients: [
    { name: 'lamb', qty: 24, unit: 'oz' },
    { name: 'carrot', qty: 4, unit: 'count' },
    { name: 'onion', qty: 1, unit: '' },
    { name: 'tomato paste', qty: 1, unit: 'can' },
  ],
  meta: { mockCost: 14.0 },
};

/**
 * rCurry — medium prep, coconut dairy-like (we’ll treat as "dairy" tag for test), pricier
 */
const rCurry = {
  id: 'r3',
  name: 'Creamy Coconut Chicken Curry',
  tags: ['dinner', 'indian', 'protein:chicken', 'dairy'], // treat "dairy" to test diet exclusion
  totalPrepMinutes: 40,
  ingredients: [
    { name: 'chicken', qty: 1, unit: 'lb' },      // → 16 oz
    { name: 'onion', qty: 1, unit: '' },
    { name: 'coconut milk', qty: 1, unit: 'can' },
    { name: 'rice', qty: 8, unit: 'oz' },
  ],
  meta: { mockCost: 18.0 },
};

// ------------------------------- Shared Ctx ----------------------------------

function baseCtx(overrides = {}) {
  return {
    tz: 'America/New_York',
    constraints: {
      // default loose caps; tests override per scenario
      maxPrepMinutes: 60,
      budget: 20,
      dietary: [], // e.g., ["with:protein:lamb", "without:dairy"]
    },
    weights: {
      onHand: 0.4,
      time: 0.3,
      budget: 0.2,
      diet: 0.1,
    },
    options: {
      preferGarden: true,
      preferAnimal: true,
      includeHave: true,
    },
    stores: {
      inventoryStore: inventoryStoreMock,
      gardenStore: gardenStoreMock,
      animalStore: animalStoreMock,
      userStore: userStoreMock,
    },
    engines: {
      estimateEngine: estimateEngineMock,
      unitConverter: unitConverterMock,
      recipeNormalizer: recipeNormalizerMock,
      taggingAutoClassifier: taggingAutoClassifierMock,
    },
    ...overrides,
  };
}

// --------------------------------- Tests ------------------------------------

describe('Decider Scoring — on-hand / time / budget / diet with reasons', () => {
  test('rewards on-hand coverage and fast prep; penalizes long prep', async () => {
    const ctx = baseCtx({ constraints: { maxPrepMinutes: 30, budget: 25, dietary: [] } });
    const { ranked } = await scoreCandidates([rQuickEggs, rLambStew], ctx);

    // Quick eggs should outrank slow stew due to time cap + similar cost
    expect(ranked[0].id).toBe('r1');
    expect(ranked[1].id).toBe('r2');

    // Reasons: quick eggs should show on-hand and time positives
    const eggs = ranked.find((r) => r.id === 'r1');
    expect(eggs.reasons.some((x) => x.kind === 'onhand' && x.impact > 0)).toBe(true);
    expect(eggs.reasons.some((x) => x.kind === 'time' && x.impact > 0)).toBe(true);

    // Stew should have a negative time reason for exceeding cap
    const stew = ranked.find((r) => r.id === 'r2');
    const timeReason = stew.reasons.find((x) => x.kind === 'time');
    expect(timeReason).toBeTruthy();
    expect(timeReason.impact).toBeLessThan(0);
    expect(timeReason.details.overByMinutes).toBeGreaterThan(0);
  });

  test('diet rules: without:dairy excludes curry, with:protein:lamb rewards lamb stew', async () => {
    const ctx = baseCtx({
      constraints: {
        maxPrepMinutes: 120,
        budget: 25,
        dietary: ['without:dairy', 'with:protein:lamb'],
      },
    });

    const { scored } = await scoreCandidates([rLambStew, rCurry], ctx);

    const lamb = scored.find((s) => s.id === 'r2');
    const curry = scored.find((s) => s.id === 'r3');

    // Lamb stew should have positive diet impact for "with:protein:lamb"
    const lambDiet = lamb.reasons.find((r) => r.kind === 'diet');
    expect(lambDiet && lambDiet.impact).toBeGreaterThan(0);

    // Curry should have negative diet impact for "without:dairy"
    const curryDiet = curry.reasons.find((r) => r.kind === 'diet');
    expect(curryDiet && curryDiet.impact).toBeLessThan(0);
    expect(curryDiet.details.violations).toContain('dairy');
  });

  test('budget: penalize over-budget items; reward frugal dishes', async () => {
    const ctx = baseCtx({
      constraints: { maxPrepMinutes: 60, budget: 10, dietary: [] },
    });

    const { ranked } = await scoreCandidates([rQuickEggs, rCurry], ctx);

    expect(ranked[0].id).toBe('r1'); // eggs are cheaper
    const curry = ranked.find((x) => x.id === 'r3');
    const budgetReason = curry.reasons.find((r) => r.kind === 'budget');
    expect(budgetReason && budgetReason.impact).toBeLessThan(0);
    expect(budgetReason.details.overBy).toBeGreaterThan(0);
  });

  test('on-hand coverage: garden/animal fulfillment counts before budget/time', async () => {
    const ctx = baseCtx({ constraints: { maxPrepMinutes: 120, budget: 25, dietary: [] } });

    const { scored } = await scoreCandidates([rLambStew], ctx);
    const lamb = scored[0];

    const onhand = lamb.reasons.find((r) => r.kind === 'onhand');
    // Lamb + carrots + onion are covered across animal/garden/inventory mocks
    expect(onhand).toBeTruthy();
    expect(onhand.details.coveragePct).toBeGreaterThan(0.6); // >60% covered
    expect(onhand.impact).toBeGreaterThan(0);
  });

  test('composite: ranking explains weights & reason impacts', async () => {
    const ctx = baseCtx({
      weights: { onHand: 0.4, time: 0.3, budget: 0.2, diet: 0.1 },
      constraints: { maxPrepMinutes: 30, budget: 15, dietary: ['without:dairy'] },
    });

    const { ranked } = await scoreCandidates([rQuickEggs, rLambStew, rCurry], ctx);

    // With dairy excluded and tight time/budget, Quick Eggs should win
    expect(ranked[0].id).toBe('r1');

    // Ensure every result has an audit trail of reasons with signed impacts
    for (const r of ranked) {
      expect(Array.isArray(r.reasons)).toBe(true);
      expect(r.reasons.length).toBeGreaterThan(0);
      // sum of weighted impacts should be close to final score (tolerate rounding)
      const approx = r.reasons.reduce((a, b) => a + (b.weightedImpact || 0), 0);
      expect(Math.abs((r.score || 0) - approx)).toBeLessThan(0.001);
    }
  });
});

// ----------------------------- SUT (Test Shim) -------------------------------
// Minimal implementation of scoreCandidates(recipes, ctx) to satisfy tests.
// Replace with your real engine if present.

export async function scoreCandidates(recipes, ctx) {
  const {
    stores: { inventoryStore, gardenStore, animalStore },
    engines: { estimateEngine, unitConverter, recipeNormalizer, taggingAutoClassifier },
    weights,
    constraints,
    options,
  } = ctx;

  const norm = recipeNormalizer?.normalizeAll
    ? await recipeNormalizer.normalizeAll(recipes, ctx)
    : recipes;

  // Build supply maps (pantry + garden + animal)
  const pantry = (await inventoryStore.getPantrySnapshot()) || { items: [] };
  const harvest = options?.preferGarden && (await gardenStore.getProjectedHarvest()) || { items: [] };
  const butchery = options?.preferAnimal && (await animalStore.getProjectedButchery()) || { items: [] };
  const supplyKey = (i) => [i.name?.toLowerCase() || '', i.unit?.toLowerCase() || ''].join('|');

  const mkMap = (arr) => {
    const m = new Map();
    for (const i of arr) {
      const key = supplyKey(i);
      const base = unitConverter?.toBase?.({ qty: i.qty, unit: i.unit, name: i.name })?.qty ?? (i.qty || 0);
      m.set(key, (m.get(key) || 0) + base);
    }
    return m;
  };

  const pantryMap = mkMap(pantry.items || []);
  const harvestMap = mkMap(harvest.items || []);
  const animalMap  = mkMap(butchery.items || []);

  const scored = [];
  for (const recipe of norm) {
    const tags = new Set([...(recipe.tags || []), ...(taggingAutoClassifier?.infer(recipe, ctx)?.tags || [])].map(String));
    const mins = Number(recipe.totalPrepMinutes || 0);

    // --- On-hand coverage ---------------------------------------------------
    let need = 0;
    let have = 0;
    for (const ing of (recipe.ingredients || [])) {
      const key = supplyKey(ing);
      const baseNeed = unitConverter?.toBase?.({ qty: ing.qty, unit: ing.unit, name: ing.name })?.qty ?? (ing.qty || 0);
      need += baseNeed;
      const pantryHave = pantryMap.get(key) || 0;
      const harvestHave = harvestMap.get(key) || 0;
      const animalHave  = animalMap.get(key)  || 0;
      const cov = Math.min(baseNeed, pantryHave + harvestHave + animalHave);
      have += cov;
    }
    const coveragePct = need > 0 ? have / need : 1;
    const onhandImpact = scale(coveragePct, 0, 1, 0, 1); // 0..1
    const onhand = reason('onhand', onhandImpact, weights.onHand, { coveragePct });

    // --- Time impact --------------------------------------------------------
    const maxPrep = Number(constraints?.maxPrepMinutes ?? 60);
    let timeImpact = 0;
    let overByMinutes = 0;
    if (mins <= maxPrep) {
      // Reward quickness: 1 when 0 min, ~0 when near cap
      timeImpact = 1 - clamp(mins / Math.max(1, maxPrep), 0, 1);
    } else {
      overByMinutes = mins - maxPrep;
      // Linear penalty, capped at -1
      timeImpact = -clamp(overByMinutes / Math.max(1, maxPrep), 0, 1);
    }
    const time = reason('time', timeImpact, weights.time, { minutes: mins, overByMinutes });

    // --- Budget impact ------------------------------------------------------
    const budget = Number(constraints?.budget ?? Infinity);
    const est = await estimateEngine.estimateRecipe(recipe, ctx);
    const cost = Number(est?.total ?? 0);
    let budgetImpact = 0;
    let overBy = 0;
    if (isFinite(budget)) {
      if (cost <= budget) {
        // Reward frugality: 1 when free, ~0 near budget
        budgetImpact = 1 - clamp(cost / Math.max(1, budget), 0, 1);
      } else {
        overBy = cost - budget;
        budgetImpact = -clamp(overBy / Math.max(1, budget), 0, 1);
      }
    }
    const budgetR = reason('budget', budgetImpact, weights.budget, { cost, budget, overBy });

    // --- Diet impact --------------------------------------------------------
    const rules = (constraints?.dietary || []).map(String);
    let dietImpact = 0;
    const violations = [];
    const satisfies = [];

    for (const rule of rules) {
      if (rule.startsWith('without:')) {
        const tag = rule.replace('without:', '').trim().toLowerCase();
        if (tags.has(tag)) violations.push(tag);
      } else if (rule.startsWith('with:')) {
        const tag = rule.replace('with:', '').trim().toLowerCase();
        if (tags.has(tag)) satisfies.push(tag);
        else violations.push('missing:' + tag);
      }
    }
    // Score: +0.5 per satisfied (cap 1), -1 if any violation (cap -1)
    if (violations.length) dietImpact = -1;
    else dietImpact = Math.min(1, satisfies.length * 0.5);

    const diet = reason('diet', dietImpact, weights.diet, { rules, violations, satisfies, tags: Array.from(tags) });

    const reasons = [onhand, time, budgetR, diet];
    const score = reasons.reduce((a, r) => a + r.weightedImpact, 0);

    scored.push({
      id: recipe.id,
      name: recipe.name,
      score,
      reasons,
      meta: { cost, minutes: mins, coveragePct },
    });
  }

  const ranked = [...scored].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { scored, ranked };
}

// --------------------------- SUT helpers (shim) ------------------------------

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function scale(x, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin;
  const t = (x - inMin) / (inMax - inMin);
  return outMin + t * (outMax - outMin);
}

function reason(kind, impact, weight, details = {}) {
  const weightedImpact = (Number(weight) || 0) * (Number(impact) || 0);
  return { kind, impact: Number(impact) || 0, weight: Number(weight) || 0, weightedImpact, details };
}

// ----------------------------- Local shim export -----------------------------
// If you have a real module, remove this line and the import at the top.
export default { scoreCandidates };
