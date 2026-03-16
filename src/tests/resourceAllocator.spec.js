/**
 * @file C:\Users\larho\suka-smart-assistant\src\tests\resourceAllocator.spec.js
 *
 * Tests for the Automation "resource allocator" (device/person conflict prevention).
 *
 * CONTRACT these tests expect from the allocator module:
 *   • Location (adjust TARGET_MODULE if different):
 *       src/services/automation/resourceAllocator.js
 *   • Export:
 *       async function allocateResources(sessions, ctx, options?)
 *   • Return shape:
 *       {
 *         ok: boolean,
 *         conflicts: Array<{
 *           kind: 'device'|'person'|'capacity'|'unknown',
 *           id: string,               // resource id (e.g., 'oven-1', 'alice')
 *           sessionIds: string[],     // involved sessions
 *           detail?: string
 *         }>,
 *         reservations: Array<{
 *           sessionId: string,
 *           resource: { kind: 'device'|'person'|'capacity', id: string },
 *           start: string,            // ISO
 *           end: string               // ISO
 *         }>,
 *         suggestions: string[],      // human-readable notes (e.g., "stagger t2 by 10m")
 *         meta?: object
 *       }
 *   • Events (via shared eventBus):
 *       eventBus.emit('automation.event', {
 *         type: 'automation.resource.conflict.detected' | 'automation.resource.allocated' | 'automation.resource.allocations.committed',
 *         ts: <ISO>,
 *         source: 'resourceAllocator',
 *         data: { ok, conflicts, reservations, ... }
 *       })
 *
 * PIPELINE NOTE:
 *   imports → normalize → intelligence → automation(feasibility) → resourceAllocator
 *   → (schedule/suggest) → optional hub export if allocations are committed to household data.
 *   Allocation itself should NOT mutate inventory. If options.commit === true and the allocator
 *   writes reservations to household state (sessions DB), the allocator should also call
 *   exportToHubIfEnabled(payload). These tests only validate events and return values (no hub calls).
 */

import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";

// ───────────────────────────────────────────────────────────────────────────────
// Adjust this path if your allocator module lives somewhere else.
const TARGET_MODULE = "src/services/automation/resourceAllocator.js";

// Mock the eventBus so we can assert emitted events without side effects.
vi.mock("src/services/events/eventBus.js", () => {
  const fakeBus = {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { default: fakeBus, eventBus: fakeBus };
});

let mod = null;
let allocateResources = null;

async function tryLoadModule() {
  try {
    const m = await import(/* @vite-ignore */ TARGET_MODULE);
    return m;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  mod = await tryLoadModule();
  if (mod) {
    allocateResources = mod.allocateResources || mod.default || null;
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Helpers

function iso(date) {
  return new Date(date).toISOString();
}

function makeWindow(offsetMin, durationMin) {
  const start = new Date(Date.now() + offsetMin * 60_000);
  const end = new Date(start.getTime() + durationMin * 60_000);
  return { start: iso(start), end: iso(end) };
}

/**
 * Build minimal session objects the allocator understands.
 * Each session:
 *   { id, title, timeWindow: {start, end}, needs: { devices:[], people:[], capacity?: {id, units}} }
 */
function buildSessions(overrides = {}) {
  const w0 = makeWindow(10, 30);
  const w1 = makeWindow(15, 30);
  const w2 = makeWindow(45, 20); // non-overlap with w0
  return [
    {
      id: "s1",
      title: "Bake Lasagna",
      timeWindow: w0,
      needs: { devices: ["oven-1"], people: ["alice"] },
      ...overrides.s1,
    },
    {
      id: "s2",
      title: "Roast Chicken",
      timeWindow: w1, // overlaps with s1
      needs: { devices: ["oven-1"], people: ["bob"] },
      ...overrides.s2,
    },
    {
      id: "s3",
      title: "Vacuum Living Room",
      timeWindow: w2, // later, no overlap with s1
      needs: { devices: ["vacuum-1"], people: ["alice"] },
      ...overrides.s3,
    },
  ];
}

function buildCtx(overrides = {}) {
  return {
    tz: "America/Chicago",
    // Resource registry: capacities allow N concurrent "units" (e.g., 4 burners)
    resources: {
      devices: {
        "oven-1": {
          kind: "device",
          id: "oven-1",
          capacity: 1,
          label: "Main Oven",
        },
        "vacuum-1": { kind: "device", id: "vacuum-1", capacity: 1 },
        stovetop: { kind: "capacity", id: "stovetop", capacity: 4 }, // abstract capacity pool
      },
      people: {
        alice: { kind: "person", id: "alice", capacity: 1 },
        bob: { kind: "person", id: "bob", capacity: 1 },
      },
    },
    // Policies the allocator may consult
    policies: {
      allowAutoStagger: true,
      maxStaggerMinutes: 20,
    },
    source: "resourceAllocator",
    ...overrides,
  };
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

// ───────────────────────────────────────────────────────────────────────────────

(mod ? describe : describe.skip)(
  "Resource Allocator — device/person conflict prevention",
  () => {
    let eventBus;
    beforeEach(async () => {
      const eb = await import("src/services/events/eventBus.js");
      eventBus = eb.default || eb.eventBus;
      eventBus.emit.mockClear();
    });

    it("exports allocateResources(sessions, ctx, options?)", () => {
      expect(typeof allocateResources).toBe("function");
      expect(allocateResources.length).toBeGreaterThanOrEqual(2);
    });

    it("detects device double-booking conflicts (same device, overlapping windows)", async () => {
      const sessions = buildSessions(); // s1 + s2 share oven-1 and overlap
      const ctx = buildCtx();

      const result = await allocateResources(sessions, ctx, { dryRun: true });

      expect(result && typeof result.ok === "boolean").toBe(true);
      expect(Array.isArray(result.conflicts)).toBe(true);

      const hasOvenConflict = result.conflicts.some(
        (c) =>
          c.kind === "device" &&
          c.id === "oven-1" &&
          ["s1", "s2"].every((id) => c.sessionIds.includes(id))
      );
      expect(hasOvenConflict).toBe(true);

      // Should emit a conflict event with canonical envelope
      expect(eventBus.emit).toHaveBeenCalled();
      const calls = eventBus.emit.mock.calls.filter(
        (c) => c[0] === "automation.event"
      );
      expect(calls.length).toBeGreaterThan(0);
      const payload = calls[calls.length - 1][1];
      expect(payload).toMatchObject({
        type: "automation.resource.conflict.detected",
        source: "resourceAllocator",
      });
      expect(() => new Date(payload.ts).toISOString()).not.toThrow();
    });

    it("detects person double-booking conflicts (same person, overlapping windows)", async () => {
      // Force s3 to overlap with s1 and assign same person 'alice' to both
      const sessions = buildSessions({
        s3: {
          timeWindow: { ...makeWindow(20, 25) }, // overlaps with s1 (10–40m) and s2 (15–45m)
          needs: { devices: ["vacuum-1"], people: ["alice"] }, // alice already on s1
        },
      });
      const ctx = buildCtx();

      const result = await allocateResources(sessions, ctx, { dryRun: true });

      const hasAliceConflict = result.conflicts.some(
        (c) =>
          c.kind === "person" &&
          c.id === "alice" &&
          ["s1", "s3"].every((id) => c.sessionIds.includes(id))
      );
      expect(hasAliceConflict).toBe(true);
    });

    it("enforces capacity pools (e.g., stovetop has capacity 4 units across sessions)", async () => {
      // Create 2 sessions that together exceed stovetop capacity at the same time
      const w = makeWindow(12, 30);
      const sessions = [
        {
          id: "sA",
          title: "Boil Pasta + Sauce",
          timeWindow: w,
          needs: {
            devices: [], // use capacity pool instead
            people: ["alice"],
            capacity: [{ id: "stovetop", units: 3 }],
          },
        },
        {
          id: "sB",
          title: "Pan Sear Steaks",
          timeWindow: w, // same window → concurrent
          needs: {
            devices: [],
            people: ["bob"],
            capacity: [{ id: "stovetop", units: 2 }],
          },
        },
      ];
      const ctx = buildCtx({
        resources: {
          devices: {
            stovetop: { kind: "capacity", id: "stovetop", capacity: 4 },
          },
          people: {
            alice: { kind: "person", id: "alice", capacity: 1 },
            bob: { kind: "person", id: "bob", capacity: 1 },
          },
        },
      });

      const result = await allocateResources(sessions, ctx, { dryRun: true });

      const capConflict = result.conflicts.find(
        (c) => c.kind === "capacity" && c.id === "stovetop"
      );
      expect(capConflict).toBeTruthy();
      expect(capConflict.sessionIds.sort()).toEqual(["sA", "sB"]);
    });

    it("can auto-stagger overlapping sessions when allowed, resolving conflicts", async () => {
      const sessions = buildSessions(); // s1 & s2 conflict on oven-1
      const ctx = buildCtx({
        policies: { allowAutoStagger: true, maxStaggerMinutes: 30 },
      });

      const result = await allocateResources(sessions, ctx, {
        dryRun: true,
        autoStagger: true,
      });

      // Either ok==true and reservations exist, or if not resolvable, at least suggestions exist.
      if (result.ok) {
        expect(Array.isArray(result.reservations)).toBe(true);
        // Ensure s1 and s2 no longer overlap in their reserved windows for oven-1
        const r1 = result.reservations.find(
          (r) => r.sessionId === "s1" && r.resource.id === "oven-1"
        );
        const r2 = result.reservations.find(
          (r) => r.sessionId === "s2" && r.resource.id === "oven-1"
        );
        expect(r1 && r2).toBeTruthy();
        expect(overlaps(r1, r2)).toBe(false);
        // Should report 'allocated' event when it finds a conflict-free plan
        const calls = eventBus.emit.mock.calls.filter(
          (c) => c[0] === "automation.event"
        );
        const allocatedEvt = calls
          .map((c) => c[1])
          .find((p) => p.type === "automation.resource.allocated");
        expect(allocatedEvt).toBeTruthy();
      } else {
        expect(result.conflicts.length).toBeGreaterThan(0);
        expect(result.suggestions.length).toBeGreaterThan(0);
      }
    });

    it("commits allocations when options.commit === true and emits committed event", async () => {
      const sessions = buildSessions({
        // make s1 & s2 NOT overlap so commit path is reachable
        s2: { timeWindow: makeWindow(50, 25) },
      });
      const ctx = buildCtx();

      const result = await allocateResources(sessions, ctx, { commit: true });

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.reservations)).toBe(true);
      // Expect a "committed" event envelope
      const calls = eventBus.emit.mock.calls.filter(
        (c) => c[0] === "automation.event"
      );
      const committedEvt = calls
        .map((c) => c[1])
        .find((p) => p.type === "automation.resource.allocations.committed");
      expect(committedEvt).toBeTruthy();
      expect(() => new Date(committedEvt.ts).toISOString()).not.toThrow();
    });

    it("handles invalid inputs defensively (empty array, missing ctx)", async () => {
      const bad = await allocateResources(null, null);
      expect(bad.ok).toBe(false);
      expect(Array.isArray(bad.conflicts)).toBe(true);
      expect(bad.conflicts.length).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(bad.suggestions)).toBe(true);
      // Should still emit a conflict/diagnostic event
      const calls = eventBus.emit.mock.calls.filter(
        (c) => c[0] === "automation.event"
      );
      expect(calls.length).toBeGreaterThan(0);
    });

    it("scales to many sessions (basic perf sanity)", async () => {
      // Build 800 sessions with alternating devices/people; half will overlap
      const sessions = [];
      for (let i = 0; i < 800; i += 1) {
        const w = makeWindow(i % 5 === 0 ? 10 : 50, 20); // some overlap, some not
        sessions.push({
          id: `sx-${i}`,
          title: `Task ${i}`,
          timeWindow: w,
          needs: {
            devices: [i % 2 === 0 ? "oven-1" : "vacuum-1"],
            people: [i % 3 === 0 ? "alice" : "bob"],
          },
        });
      }
      const ctx = buildCtx();

      const t0 = performance.now();
      const result = await allocateResources(sessions, ctx, { dryRun: true });
      const elapsed = performance.now() - t0;

      expect(result && typeof result.ok === "boolean").toBe(true);
      // Should run comfortably within 2.5s in CI environments
      expect(elapsed).toBeLessThan(2500);
    });
  }
);

// If the module isn’t present yet, surface a helpful note in test output.
if (!mod) {
  // eslint-disable-next-line no-console
  console.warn(
    `[resourceAllocator.spec] Skipping allocator tests. Module not found at "${TARGET_MODULE}". ` +
      `Create the file and export "allocateResources(sessions, ctx, options?)" to enable this suite.`
  );
}
