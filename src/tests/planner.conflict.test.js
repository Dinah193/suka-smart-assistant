// __tests__/planner.conflict.test.js
// planner.conflict.test.js — detect oven/time conflicts; resolve via Decider
// ---------------------------------------------------------------------------
// This suite verifies that the planner can:
// 1) Detect overlapping single-capacity resource usage (e.g., OVEN)
// 2) Respect Sabbath guard windows when proposing schedule shifts
// 3) Resolve conflicts by either (a) shifting to an open window or (b) swapping
//    in an alternate candidate via the Decider (favoring non-OVEN options)
// 4) Emit NBA suggestions to guide the UI
//
// DI-friendly mocks are used; a minimal SUT shim is provided at the bottom
// (detectConflicts/resolveConflicts). Replace the shim import with your real
// implementation once wired in.
//
// Paste path suggestion:
//   src/engines/planning/__tests__/planner.conflict.test.js
//
// Prereqs: Jest (ESM ok). No DOM required.

import { jest } from '@jest/globals';

// ------------------------------ SUT import ----------------------------------
// Replace this with your real module once implemented:
//   import { detectConflicts, resolveConflicts } from '../plannerConflicts';
import { detectConflicts, resolveConflicts } from './_shim.plannerConflicts';

// ------------------------------- Test Mocks ---------------------------------

const TIMEZONE = 'America/New_York';

// Simple guard: Fri 6:00 PM → Sat 6:00 PM
const scheduleHelpersMock = {
  guardWindows(start, end, tz) {
    // Compute the Friday of the range and build 6pm Fri → 6pm Sat window
    const s = new Date(start);
    const e = new Date(end);
    const days = [];
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      days.push(new Date(d));
    }
    const fri = days.find((d) => d.getDay() === 5);
    if (!fri) return [];
    const guardStart = new Date(fri);
    guardStart.setHours(18, 0, 0, 0);
    const guardEnd = new Date(fri);
    guardEnd.setDate(guardEnd.getDate() + 1);
    guardEnd.setHours(18, 0, 0, 0);
    return [{ start: guardStart.toISOString(), end: guardEnd.toISOString(), tz }];
  },
  // Find open windows (very naive): returns two-hour blocks outside guard
  computeFreeWindows(range, taken, tz) {
    const result = [];
    const dayStart = new Date(range.start);
    const dayEnd = new Date(range.end);
    const guard = scheduleHelpersMock.guardWindows(range.start, range.end, tz)[0];
    for (let t = new Date(dayStart); t < dayEnd; t.setHours(t.getHours() + 2)) {
      const blockStart = new Date(t);
      const blockEnd = new Date(t); blockEnd.setHours(blockEnd.getHours() + 2);
      const isoS = blockStart.toISOString(), isoE = blockEnd.toISOString();
      if (overlaps({ start: isoS, end: isoE }, guard)) continue;
      const clash = taken.some(w => overlaps({ start: isoS, end: isoE }, w));
      if (!clash) result.push({ start: isoS, end: isoE });
    }
    return result;
  },
};

// Minimal decider: prefer non-oven, shorter time, lower cost
const deciderMock = {
  async scoreCandidates(recipes, ctx) {
    const scored = recipes.map(r => {
      const oven = requiresOven(r) ? 1 : 0;
      const time = Number(r.totalPrepMinutes || 0);
      const cost = Number(r.meta?.mockCost || 0);
      // Simple score: penalize oven hard, then time, then cost
      const score = -2 * oven - 0.01 * time - 0.001 * cost;
      return { id: r.id, recipe: r, score };
    });
    const ranked = [...scored].sort((a, b) => b.score - a.score);
    return { ranked };
  },
};

// Stores/engines DI container
function deps() {
  return {
    bus: createMockBus(),
    engines: {
      scheduleHelpers: scheduleHelpersMock,
      decider: deciderMock,
    },
    stores: {
      userStore: {
        getTimezone: () => TIMEZONE,
        getSettings: () => ({ sabbathGuard: true }),
      },
      recipesStore: {
        getAlternatesFor(slot) {
          // Provide alternates for resolving conflicts
          return [
            recipe('r4', 'Stovetop Chili', 35, 'stovetop', { mockCost: 9 }),
            recipe('r5', 'One-Pot Rice & Eggs', 20, 'stovetop', { mockCost: 4 }),
          ];
        },
      },
    },
    helpers: { uuid: uuidMock() },
    log: () => {},
  };
}

function createMockBus() {
  return { publish: jest.fn() };
}

function uuidMock() {
  let i = 0;
  return (prefix = 'id-') => `${prefix}${++i}`;
}

// ------------------------------ Fixtures ------------------------------------

function recipe(id, name, minutes, appliance = 'oven', meta = {}) {
  return {
    id, name,
    totalPrepMinutes: minutes,
    // Plan will look for "primaryAppliance" on recipe or step
    primaryAppliance: appliance,
    steps: [{ title: 'Cook', minutes, appliance }],
    meta,
  };
}

function assignment(slotId, dayISO, meal, recipe) {
  // Default slot times: breakfast 08:00, lunch 12:00, dinner 18:00
  const h = meal === 'breakfast' ? 8 : meal === 'lunch' ? 12 : 18;
  const start = new Date(`${dayISO}T${String(h).padStart(2, '0')}:00:00.000Z`);
  const end = new Date(start); end.setMinutes(end.getMinutes() + (recipe.totalPrepMinutes || 45));
  return {
    slotId,
    slotTime: start.toISOString(),
    endTime: end.toISOString(),
    dayISO,
    meal,
    recipe,
  };
}

function day(offsetFromMonday = 0) {
  // Fixed week starting Monday 2025-10-20 (Mon)
  const base = new Date('2025-10-20T00:00:00.000Z');
  base.setDate(base.getDate() + offsetFromMonday);
  return base.toISOString().slice(0, 10);
}

function requiresOven(r) {
  return (r.primaryAppliance || r.steps?.[0]?.appliance) === 'oven';
}

function overlaps(a, b) {
  if (!a || !b) return false;
  const s1 = +new Date(a.start), e1 = +new Date(a.end);
  const s2 = +new Date(b.start), e2 = +new Date(b.end);
  return s1 < e2 && s2 < e1;
}

// --------------------------------- Tests ------------------------------------

describe('Planner Conflicts — detect & resolve oven/time overlaps', () => {
  test('detects overlapping OVEN usage at the same time', async () => {
    const D = day(0); // Monday
    const a1 = assignment('mon-dinner', D, 'dinner', recipe('r1', 'Roast Chicken', 60, 'oven', { mockCost: 12 }));
    const a2 = assignment('mon-dinner-2', D, 'dinner', recipe('r2', 'Lasagna', 75, 'oven', { mockCost: 14 }));

    const ctx = {
      tz: TIMEZONE,
      range: { start: `${D}T00:00:00.000Z`, end: `${D}T23:59:59.999Z` },
      capacities: { oven: 1 }, // single oven
      options: { honorSabbathGuard: true },
    };

    const { conflicts } = await detectConflicts([a1, a2], deps(), ctx);

    expect(conflicts.length).toBe(1);
    const c = conflicts[0];
    expect(c.kind).toBe('appliance');
    expect(c.appliance).toBe('oven');
    expect(c.assignments.map(a => a.recipe.name)).toEqual(expect.arrayContaining(['Roast Chicken', 'Lasagna']));
  });

  test('resolves by shifting one to an open window outside Sabbath guard', async () => {
    // Friday dinner (falls into guard at/after 6pm)
    const D = day(4); // Friday
    const a1 = assignment('fri-dinner', D, 'dinner', recipe('r1', 'Roast Chicken', 60, 'oven', { mockCost: 12 }));
    const a2 = assignment('fri-dinner-2', D, 'dinner', recipe('r2', 'Lasagna', 75, 'oven', { mockCost: 14 }));

    const ctx = {
      tz: TIMEZONE,
      range: { start: `${D}T00:00:00.000Z`, end: `${D}T23:59:59.999Z` },
      capacities: { oven: 1 },
      options: { honorSabbathGuard: true },
    };

    const { conflicts } = await detectConflicts([a1, a2], deps(), ctx);
    expect(conflicts.length).toBe(1);

    const { plan: resolved, actions } = await resolveConflicts([a1, a2], conflicts, deps(), ctx);

    // Should still have two assignments
    expect(resolved.length).toBe(2);
    // No longer overlapping (one shifted earlier than guard)
    const windows = resolved.map(a => ({ start: a.slotTime, end: a.endTime }));
    expect(overlaps(windows[0], windows[1])).toBe(false);

    // NBA suggests to review adjusted times
    const bus = deps().bus; // not the actual bus used above; just verify structure via actions
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.some(a => a.id === 'review-adjustments')).toBe(true);
  });

  test('if no open window exists, resolves by swapping to a non-OVEN alternate via Decider', async () => {
    const D = day(1); // Tuesday
    // Take the whole day with oven blocks so shifting fails:
    // Lunch & Dinner both oven; we will add a fake "all-day taken" in ctx to simulate no free windows.
    const a1 = assignment('tue-lunch', D, 'lunch', recipe('r1', 'Baked Fish', 60, 'oven', { mockCost: 10 }));
    const a2 = assignment('tue-dinner', D, 'dinner', recipe('r2', 'Sheet Pan Veg', 70, 'oven', { mockCost: 8 }));

    const ctx = {
      tz: TIMEZONE,
      range: { start: `${D}T00:00:00.000Z`, end: `${D}T23:59:59.999Z` },
      capacities: { oven: 1 },
      options: { honorSabbathGuard: false },
      // Inject a "taken all day" by shadowing computeFreeWindows during resolution call
    };

    const _deps = deps();
    const spy = jest.spyOn(_deps.engines.scheduleHelpers, 'computeFreeWindows').mockReturnValue([]);

    const { conflicts } = await detectConflicts([a1, a2], _deps, ctx);
    expect(conflicts.length).toBe(1);

    const { plan: resolved } = await resolveConflicts([a1, a2], conflicts, _deps, ctx);

    // Still two assignments, but one should now be non-oven due to swap
    expect(resolved.length).toBe(2);
    const ovens = resolved.filter(a => requiresOven(a.recipe));
    expect(ovens.length).toBe(1); // one swapped to non-oven

    spy.mockRestore();
  });

  test('edge case: three overlapping oven items → resolve to <=1 concurrent using mix of shift & swap', async () => {
    const D = day(2); // Wednesday
    const base = `${D}T18:00:00.000Z`;
    const a = (id, mins) => ({
      slotId: `wed-dinner-${id}`,
      slotTime: base,
      endTime: new Date(new Date(base).getTime() + mins * 60000).toISOString(),
      dayISO: D,
      meal: 'dinner',
      recipe: recipe(`r${id}`, `Oven Dish ${id}`, mins, 'oven', { mockCost: 10 + id }),
    });

    const a1 = a(1, 45);
    const a2 = a(2, 50);
    const a3 = a(3, 40);

    const ctx = {
      tz: TIMEZONE,
      range: { start: `${D}T00:00:00.000Z`, end: `${D}T23:59:59.999Z` },
      capacities: { oven: 1 },
      options: { honorSabbathGuard: false },
    };

    const { conflicts } = await detectConflicts([a1, a2, a3], deps(), ctx);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);

    const { plan: resolved } = await resolveConflicts([a1, a2, a3], conflicts, deps(), ctx);

    // Validate no overlap among any oven tasks
    const ovens = resolved.filter(a => requiresOven(a.recipe));
    for (let i = 0; i < ovens.length; i++) {
      for (let j = i + 1; j < ovens.length; j++) {
        const W1 = { start: ovens[i].slotTime, end: ovens[i].endTime };
        const W2 = { start: ovens[j].slotTime, end: ovens[j].endTime };
        expect(overlaps(W1, W2)).toBe(false);
      }
    }
    // At least one swap to non-oven OR shift must have occurred
    const nonOvenCount = resolved.filter(a => !requiresOven(a.recipe)).length;
    expect(nonOvenCount + ovens.length).toBe(3);
    expect(nonOvenCount >= 1 || ovens.length === 1).toBe(true);
  });
});

// ----------------------------- Test-local SUT --------------------------------
// Minimal detectConflicts/resolveConflicts to satisfy tests (paste-and-run).
// Replace with your real engine and delete this shim in production.

export async function detectConflicts(assignments, deps, ctx) {
  const cap = ctx.capacities?.oven ?? 1;
  if (cap > 1) return { conflicts: [] };

  // Map each assignment to an oven window if its recipe needs the oven
  const ovenWindows = assignments
    .filter(a => requiresOven(a.recipe))
    .map(a => ({
      slotId: a.slotId,
      appliance: 'oven',
      start: a.slotTime,
      end: a.endTime,
      assignment: a,
    }));

  const conflicts = [];
  for (let i = 0; i < ovenWindows.length; i++) {
    for (let j = i + 1; j < ovenWindows.length; j++) {
      if (overlaps(ovenWindows[i], ovenWindows[j])) {
        const already = conflicts.find(c =>
          c.kind === 'appliance' &&
          c.appliance === 'oven' &&
          c.assignments.some(x => x.slotId === ovenWindows[i].assignment.slotId) &&
          c.assignments.some(x => x.slotId === ovenWindows[j].assignment.slotId)
        );
        if (!already) {
          conflicts.push({
            id: `conf-${i}-${j}`,
            kind: 'appliance',
            appliance: 'oven',
            range: ctx.range,
            assignments: [ovenWindows[i].assignment, ovenWindows[j].assignment],
          });
        }
      }
    }
  }
  return { conflicts };
}

export async function resolveConflicts(assignments, conflicts, deps, ctx) {
  const bus = deps.bus;
  const helpers = deps.helpers || {};
  const scheduleHelpers = deps.engines?.scheduleHelpers;
  const decider = deps.engines?.decider;
  const recipesStore = deps.stores?.recipesStore;
  const tz = ctx.tz || TIMEZONE;

  let plan = [...assignments];
  const actions = [];

  for (const c of conflicts) {
    // Take conflicting set sorted by duration desc (keep longest, move others)
    const sorted = [...c.assignments].sort((a, b) =>
      (+new Date(b.endTime) - +new Date(b.slotTime)) - (+new Date(a.endTime) - +new Date(a.slotTime))
    );
    const keeper = sorted.shift(); // keep longest in place
    const keepWindow = { start: keeper.slotTime, end: keeper.endTime };

    // Build "taken" windows from current plan (excluding keeper's window for the moved one)
    const taken = plan
      .filter(a => a.slotId !== keeper.slotId && requiresOven(a.recipe))
      .map(a => ({ start: a.slotTime, end: a.endTime }));

    for (const move of sorted) {
      // Try shifting to a free two-hour window on same day
      let shifted = null;
      if (scheduleHelpers?.computeFreeWindows) {
        const free = scheduleHelpers.computeFreeWindows(ctx.range, [...taken, keepWindow], tz);
        shifted = pickWindowOfDuration(free, move);
      }

      if (shifted) {
        // Apply shift
        plan = plan.map(a => a.slotId === move.slotId
          ? { ...a, slotTime: shifted.start, endTime: shifted.end }
          : a
        );
        // Update taken after placing
        taken.push({ start: shifted.start, end: shifted.end });
        actions.push({
          id: 'review-adjustments',
          label: 'Review time adjustments',
          cta: 'Open Planner',
          route: '/MealPlanning',
        });
        safePublish(bus, 'planner.conflict.resolved.shifted', { slotId: move.slotId, to: shifted });
      } else {
        // No free window → ask Decider for alternates that avoid oven
        const candidates = (await recipesStore?.getAlternatesFor?.(move)) || [];
        const { ranked = [] } = (await decider?.scoreCandidates?.(candidates, { tz })) || {};
        const pick = ranked.find(x => !requiresOven(x.recipe)) || ranked[0];

        if (pick) {
          plan = plan.map(a => a.slotId === move.slotId
            ? { ...a, recipe: pick.recipe }
            : a
          );
          actions.push({
            id: 'swap-alternative',
            label: `Swap to ${pick.recipe.name}`,
            cta: 'Review Swap',
            route: '/MealPlanning',
          });
          safePublish(bus, 'planner.conflict.resolved.swapped', {
            slotId: move.slotId,
            oldRecipeId: move.recipe.id,
            newRecipeId: pick.recipe.id,
          });
          // Update taken only if the replacement still uses oven
          if (requiresOven(pick.recipe)) {
            taken.push({ start: move.slotTime, end: move.endTime });
          }
        } else {
          // Last resort: keep as-is and mark unresolved (should not happen in tests)
          safePublish(bus, 'planner.conflict.unresolved', { slotId: move.slotId });
        }
      }
    }
  }

  // Emit NBA suggestions bundle
  if (actions.length) {
    safePublish(bus, 'nba.suggest', {
      scope: 'planner',
      actions,
      priority: 'high',
    });
  }

  // Final safety: assert no overlaps remain for oven
  const ovens = plan.filter(a => requiresOven(a.recipe));
  for (let i = 0; i < ovens.length; i++) {
    for (let j = i + 1; j < ovens.length; j++) {
      const W1 = { start: ovens[i].slotTime, end: ovens[i].endTime };
      const W2 = { start: ovens[j].slotTime, end: ovens[j].endTime };
      if (overlaps(W1, W2)) {
        // If overlap persists, try swapping one quickly (non-oven) using decider:
        const alt = (await deps.stores.recipesStore.getAlternatesFor(ovens[j])) || [];
        const { ranked = [] } = (await decider.scoreCandidates(alt, { tz })) || {};
        const pick = ranked.find(x => !requiresOven(x.recipe)) || ranked[0];
        if (pick) {
          plan = plan.map(a => a.slotId === ovens[j].slotId ? { ...a, recipe: pick.recipe } : a);
        }
      }
    }
  }

  return { plan, actions };
}

function pickWindowOfDuration(freeWindows, assignment) {
  const needMin = Math.max(15, Math.ceil((+new Date(assignment.endTime) - +new Date(assignment.slotTime)) / 60000));
  for (const w of freeWindows) {
    const diffMin = Math.ceil((+new Date(w.end) - +new Date(w.start)) / 60000);
    if (diffMin >= needMin) {
      // Return a window with exact duration from start
      const start = new Date(w.start);
      const end = new Date(start); end.setMinutes(end.getMinutes() + needMin);
      return { start: start.toISOString(), end: end.toISOString() };
    }
  }
  return null;
}

function safePublish(bus, topic, payload) {
  try { bus?.publish?.(topic, payload); } catch {}
}

export default { detectConflicts, resolveConflicts };
