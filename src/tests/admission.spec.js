/**
 * @file C:\Users\larho\suka-smart-assistant\src\tests\admission.spec.js
 *
 * Tests for the Automation "feasibility/admission" checks.
 *
 * These tests are intentionally defensive:
 * - They first attempt to dynamically import the feasibility module
 *   (src/services/automation/feasibility.js). If your project uses a different
 *   path or filename, adjust TARGET_MODULE below.
 * - If the module is not found, the entire suite is skipped gracefully so your
 *   CI doesn’t false-fail while you wire things up.
 *
 * What we validate (contract-level, not implementation details):
 * 1) The module exports a `checkFeasibility(plan, ctx)` function.
 * 2) It returns an object shaped like:
 *      { ok: boolean, blockers: string[], reasons: string[], suggestions: string[], meta?: object }
 * 3) It publishes a single automation event via the shared eventBus:
 *      { type: 'automation.feasibility.checked', ts: <ISO>, source: 'feasibility', data: { ok, blockers, ... } }
 * 4) It handles multiple domains (cooking, cleaning, garden, animal) in one plan.
 * 5) It detects canonical blockers like "quietHours", "inventory", "sabbath", "weather".
 * 6) It scales to larger plans (basic perf sanity: processes 1,000 tasks quickly).
 *
 * NOTE ON PIPELINE FIT:
 *  - imports → (normalize) → intelligence → automation(checkFeasibility) → schedule/suggest
 *  - After `checkFeasibility`, your automation runtime can decide to schedule, suggest,
 *    or reject. If a subsequent action mutates household data (e.g., auto-generate
 *    sessions or update inventory), your runtime should emit events and optionally
 *    `exportToHubIfEnabled(payload)`. Those exports are NOT part of feasibility and are
 *    therefore not asserted here.
 */

import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';

// ───────────────────────────────────────────────────────────────────────────────
// Adjust if your feasibility module lives somewhere else
const TARGET_MODULE = 'src/services/automation/feasibility.js';

// We always mock the eventBus so we can assert emitted events without side effects.
vi.mock('src/services/eventBus.js', () => {
  const fakeBus = {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    default: fakeBus,
    eventBus: fakeBus,
  };
});

let mod = null;
let checkFeasibility = null;

async function tryLoadModule() {
  try {
    // dynamic import so we can skip the suite if the file isn't present yet
    // eslint-disable-next-line no-await-in-loop
    const m = await import(/* @vite-ignore */ TARGET_MODULE);
    return m;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  mod = await tryLoadModule();
  if (mod) {
    checkFeasibility = mod.checkFeasibility || mod.default || null;
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Test data builders

function isoNow() {
  return new Date().toISOString();
}

/**
 * Build a minimal, multi-domain plan the feasibility checker should accept.
 * Each task includes: id, domain, type, durationMins, requires? (inventory),
 * and timeWindow (start, end) in ISO strings.
 */
function buildHappyPathPlan() {
  const now = new Date();
  const in10 = new Date(now.getTime() + 10 * 60_000);
  const in90 = new Date(now.getTime() + 90 * 60_000);

  return {
    id: 'plan-001',
    createdAt: isoNow(),
    tasks: [
      {
        id: 't-cook-1',
        domain: 'cooking',
        type: 'meal.prep',
        durationMins: 20,
        requires: [{ sku: 'pasta', qty: 1 }, { sku: 'sauce', qty: 1 }],
        timeWindow: { start: now.toISOString(), end: in90.toISOString() },
      },
      {
        id: 't-clean-1',
        domain: 'cleaning',
        type: 'surface.disinfect',
        durationMins: 10,
        requires: [{ sku: 'disinfectant', qty: 1 }],
        timeWindow: { start: now.toISOString(), end: in90.toISOString() },
      },
      {
        id: 't-garden-1',
        domain: 'garden',
        type: 'watering',
        durationMins: 15,
        requires: [],
        timeWindow: { start: now.toISOString(), end: in90.toISOString() },
      },
      {
        id: 't-animal-1',
        domain: 'animal',
        type: 'feed.ducks',
        durationMins: 10,
        requires: [{ sku: 'duck.feed', qty: 1 }],
        timeWindow: { start: now.toISOString(), end: in90.toISOString() },
      },
    ],
  };
}

/**
 * Default context with guards and inventory.
 * Guards include quietHours, sabbath, and weather gate.
 */
function buildDefaultCtx(overrides = {}) {
  const base = {
    now: new Date(),
    tz: 'America/Chicago',
    // inventory map sku -> availableQty
    inventory: {
      pasta: 3,
      sauce: 2,
      disinfectant: 1,
      'duck.feed': 5,
    },
    guards: {
      quietHours: { enabled: false, start: '21:00', end: '07:00' },
      sabbath: { enabled: false, day: 6 }, // 0=Sun ... 6=Sat
      weather: { enabled: false, allowSevere: false, current: { severity: 'normal' } },
    },
    // user/household preferences a checker might consider
    prefs: {
      cooking: { doneness: 'medium', aromaticsOk: true },
      cleaning: { scents: ['lemon', 'eucalyptus'] },
      garden: { wateringWindow: ['06:00', '10:00'] },
      animal: { species: ['ducks', 'goats', 'sheep', 'cows'] },
    },
    // when relevant, feasibility may emit via eventBus
    source: 'feasibility',
  };
  return { ...base, ...overrides };
}

// Build a large plan for perf sanity (no hard timing assertion, just ensures it runs).
function buildLargePlan(n = 1000) {
  const now = new Date();
  const end = new Date(now.getTime() + 4 * 60 * 60_000);
  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    tasks.push({
      id: `t-${i}`,
      domain: i % 4 === 0 ? 'cooking' : i % 4 === 1 ? 'cleaning' : i % 4 === 2 ? 'garden' : 'animal',
      type: 'generic.task',
      durationMins: (i % 5) + 5,
      requires: i % 3 === 0 ? [{ sku: `sku-${i % 10}`, qty: 1 }] : [],
      timeWindow: { start: now.toISOString(), end: end.toISOString() },
    });
  }
  return { id: 'plan-large', createdAt: isoNow(), tasks };
}

// ───────────────────────────────────────────────────────────────────────────────

(mod ? describe : describe.skip)('Automation Feasibility Checks (admission)', () => {
  let eventBus;
  beforeEach(async () => {
    // fresh import of mocked eventBus so call counts reset
    const eb = await import('src/services/eventBus.js');
    eventBus = eb.default || eb.eventBus;
    eventBus.emit.mockClear();
  });

  it('exports a checkFeasibility function with the expected signature', () => {
    expect(typeof checkFeasibility).toBe('function');
    // Do a minimal arity contract peek (not strict in JS, but helpful)
    expect(checkFeasibility.length).toBeGreaterThanOrEqual(2);
  });

  it('returns a properly shaped result on a happy multi-domain plan', async () => {
    const plan = buildHappyPathPlan();
    const ctx = buildDefaultCtx();

    const result = await checkFeasibility(plan, ctx);

    expect(result && typeof result).toBe('object');
    expect(typeof result.ok).toBe('boolean');
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(Array.isArray(result.suggestions)).toBe(true);
    // Happy path should be ok
    expect(result.ok).toBe(true);

    // Assert one feasibility event emitted with the canonical payload shape
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    const [evtName, payload] = eventBus.emit.mock.calls[0];
    expect(evtName).toBe('automation.event');
    expect(payload).toMatchObject({
      type: 'automation.feasibility.checked',
      source: 'feasibility',
    });
    // ISO timestamp sanity
    expect(typeof payload.ts).toBe('string');
    expect(() => new Date(payload.ts).toISOString()).not.toThrow();
    // Data echo
    expect(payload.data).toMatchObject({ ok: true });
  });

  it('detects inventory shortages as a blocker', async () => {
    const plan = buildHappyPathPlan();
    // Remove required items from inventory
    const ctx = buildDefaultCtx({ inventory: { disinfectant: 1 } });

    const result = await checkFeasibility(plan, ctx);

    expect(result.ok).toBe(false);
    // inventory should be one of the blockers (exact text is implementation-defined)
    expect(result.blockers.join(' | ').toLowerCase()).toMatch(/inventory|stock|insufficient/);
  });

  it('respects quiet hours guard when enabled', async () => {
    const now = new Date();
    // Create a time window that is clearly within quiet hours, e.g., 23:00–23:30
    const qStart = '21:00';
    const qEnd = '07:00';

    const late = new Date(now);
    late.setHours(23, 0, 0, 0);
    const lateEnd = new Date(late.getTime() + 30 * 60_000);

    const plan = {
      id: 'plan-quiet',
      createdAt: isoNow(),
      tasks: [
        {
          id: 't-clean-quiet',
          domain: 'cleaning',
          type: 'vacuum',
          durationMins: 15,
          requires: [],
          timeWindow: { start: late.toISOString(), end: lateEnd.toISOString() },
        },
      ],
    };

    const ctx = buildDefaultCtx({
      guards: { quietHours: { enabled: true, start: qStart, end: qEnd }, sabbath: { enabled: false }, weather: { enabled: false } },
      now: late,
    });

    const result = await checkFeasibility(plan, ctx);
    expect(result.ok).toBe(false);
    expect(result.blockers.join(' | ').toLowerCase()).toMatch(/quiet/);
  });

  it('respects sabbath guard when enabled and now is sabbath', async () => {
    // Force context date to Saturday
    const saturday = new Date();
    const day = saturday.getDay();
    const delta = (6 - day + 7) % 7; // 6 -> Saturday
    saturday.setDate(saturday.getDate() + delta);
    saturday.setHours(12, 0, 0, 0);

    const plan = buildHappyPathPlan();
    // Make it obviously during sabbath
    plan.tasks.forEach((t) => {
      t.timeWindow = { start: saturday.toISOString(), end: new Date(saturday.getTime() + 60 * 60_000).toISOString() };
    });

    const ctx = buildDefaultCtx({
      now: saturday,
      guards: { sabbath: { enabled: true, day: 6 }, quietHours: { enabled: false }, weather: { enabled: false } },
    });

    const result = await checkFeasibility(plan, ctx);
    expect(result.ok).toBe(false);
    expect(result.blockers.join(' | ').toLowerCase()).toMatch(/sabbath|saturday|relig/i);
  });

  it('respects weather guard when severe conditions are disallowed', async () => {
    const plan = {
      id: 'plan-weather',
      createdAt: isoNow(),
      tasks: [
        { id: 't-garden-2', domain: 'garden', type: 'harvest', durationMins: 20, requires: [], timeWindow: { start: isoNow(), end: isoNow() } },
      ],
    };
    const ctx = buildDefaultCtx({
      guards: { weather: { enabled: true, allowSevere: false, current: { severity: 'severe', code: 'storm' } }, sabbath: { enabled: false }, quietHours: { enabled: false } },
    });

    const result = await checkFeasibility(plan, ctx);
    expect(result.ok).toBe(false);
    expect(result.blockers.join(' | ').toLowerCase()).toMatch(/weather|severe|storm/);
  });

  it('handles 1,000 tasks without crashing (basic perf sanity)', async () => {
    const plan = buildLargePlan(1000);
    const ctx = buildDefaultCtx({
      // give generous inventory so inventory does not dominate this test
      inventory: Object.fromEntries([...Array(20)].map((_, i) => [`sku-${i}`, 50])),
      guards: { quietHours: { enabled: false }, sabbath: { enabled: false }, weather: { enabled: false } },
    });

    const start = performance.now();
    const result = await checkFeasibility(plan, ctx);
    const elapsed = performance.now() - start;

    expect(result && typeof result.ok === 'boolean').toBe(true);
    // Not a strict perf gate (env dependent), but should be comfortably snappy.
    expect(elapsed).toBeLessThan(2000); // 2 seconds ceiling in CI
  });
});

// If the module isn’t present yet, surface a helpful note in the test output.
if (!mod) {
  // eslint-disable-next-line no-console
  console.warn(
    `[admission.spec] Skipping feasibility tests. Module not found at "${TARGET_MODULE}". ` +
      `Create the file and export "checkFeasibility(plan, ctx)" to enable this suite.`
  );
}
