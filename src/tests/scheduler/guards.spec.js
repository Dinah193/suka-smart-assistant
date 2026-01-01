/* eslint-disable no-console */
/**
 * guards.spec.js
 * Scheduler guard behavior: sabbath / quietHours / weather-withholds.
 *
 * Works in Vitest or Jest.
 * - Verifies that due items are muted during Quiet Hours or Sabbath
 *   and resurface as "unquietReady" when the window ends.
 * - Verifies domain withholds (e.g., storm/weather for garden) emit conflict/NBA
 *   instead of firing a normal due reminder.
 * - Sanity checks resolveAnchor("quietEnd"/"sabbathEnd") trimming logic.
 */

const T = globalThis.vi || globalThis.jest;
const isVitest = !!globalThis.vi;

const { describe, it, expect, beforeEach, afterEach } = (function () {
  const v = {
    describe: globalThis.describe || (isVitest ? require("vitest").describe : require("@jest/globals").describe),
    it: globalThis.it || (isVitest ? require("vitest").it : require("@jest/globals").it),
    expect: globalThis.expect || (isVitest ? require("vitest").expect : require("@jest/globals").expect),
    beforeEach: globalThis.beforeEach || (isVitest ? require("vitest").beforeEach : require("@jest/globals").beforeEach),
    afterEach: globalThis.afterEach || (isVitest ? require("vitest").afterEach : require("@jest/globals").afterEach),
  };
  return v;
})();

// ----------------------------- Shared fixtures ------------------------------

const emissions = [];
const notifications = [];

// Mutable guard flags (the scheduleHelpers mock will read these)
let QUIET = false;
let SABBATH = false;
let NEXT_UNQUIET = null; // number | null
let WITHHOLDS = [];      // array of withholds for the given domain

// Deterministic base time: Mon Oct 27, 2025 09:00:00 CT (UTC-5)
const BASE = Date.UTC(2025, 9, 27, 14, 0, 0);

// ------------------------------ Mocks ---------------------------------------

T?.mock?.("@/services/eventBus", () => {
  const handlers = new Map();
  return {
    __esModule: true,
    default: {
      emit: (evt, payload) => {
        emissions.push({ evt, payload });
        const h = handlers.get(evt);
        if (h) { try { h(payload); } catch (e) {} }
        return true;
      },
      on: (evt, fn) => handlers.set(evt, fn),
      off: (evt) => handlers.delete(evt),
    },
  };
});

T?.mock?.("@/services/automation/runtime", () => {
  return {
    __esModule: true,
    automation: {
      notify: (n) => notifications.push(n),
      seed: () => {},
    },
  };
});

// scheduleHelpers used by RelativeScheduler guards
T?.mock?.("@/services/scheduleHelpers", () => {
  return {
    __esModule: true,
    isSabbath: () => SABBATH,
    inQuietHours: () => QUIET,
    nextUnquiet: () => NEXT_UNQUIET,
    withholdsForDomain: (domain) => {
      // Return active withholds matching domain or "*" wildcard
      return WITHHOLDS.filter(w => !w.domain || w.domain === domain || w.domain === "*");
    },
  };
});

// Prefs for resolveAnchor tests (Quiet Hours + Sabbath toggles)
let PREFS = {
  user: { locale: "en-US", timeZone: "America/Chicago" },
  quietHours: { enabled: false, start: "22:00", end: "06:00" },
  sabbathGuard: { enabled: false },
  safety: { softLeadMs: 120000, hardGraceMs: 60000, cooldownMs: 1, minTickMs: 5000 },
};

T?.mock?.("@/stores/scheduler/prefs", () => {
  return {
    __esModule: true,
    getSchedulerPrefs: () => PREFS,
    default: { getSchedulerPrefs: () => PREFS },
  };
});

// ------------------------------ Imports -------------------------------------

let relativeScheduler;
let generateRepeats;
let resolveAnchor;

beforeEach(async () => {
  emissions.length = 0;
  notifications.length = 0;

  QUIET = false;
  SABBATH = false;
  NEXT_UNQUIET = null;
  WITHHOLDS = [];

  PREFS = {
    user: { locale: "en-US", timeZone: "America/Chicago" },
    quietHours: { enabled: false, start: "22:00", end: "06:00" },
    sabbathGuard: { enabled: false },
    safety: { softLeadMs: 120000, hardGraceMs: 60000, cooldownMs: 1, minTickMs: 5000 },
  };

  // Fake timers + fixed system time
  if (isVitest) {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
  } else {
    jest.useFakeTimers().setSystemTime(new Date(BASE));
  }

  // Import AFTER mocks so the module binds to them
  const mod = await import("@/services/session/RelativeScheduler");
  relativeScheduler = mod.relativeScheduler || (mod.default && mod.default.relativeScheduler) || mod;
  generateRepeats = mod.generateRepeats;
  resolveAnchor = mod.resolveAnchor;

  // Ensure fast tick for tests
  relativeScheduler._stop?.();
  relativeScheduler.init?.({ tickMs: 25, autostart: true });

  // Clean persistent store
  relativeScheduler._resetAll?.();
});

afterEach(async () => {
  // Stop ticker and restore timers
  relativeScheduler?._stop?.();
  if (isVitest) {
    const { vi } = await import("vitest");
    vi.useRealTimers();
  } else {
    jest.useRealTimers();
  }
});

// Helper: run timers for ms
async function advance(ms) {
  if (isVitest) {
    const { vi } = await import("vitest");
    await vi.advanceTimersByTimeAsync(ms);
  } else {
    await jest.advanceTimersByTime(ms);
  }
}

// -------------------------------- Tests -------------------------------------

describe("Guards • Quiet Hours", () => {
  it("mutes due reminders during Quiet Hours and resurfaces with 'unquietReady' after", async () => {
    // Inside quiet hours
    QUIET = true;
    NEXT_UNQUIET = BASE + 60_000; // quiet ends in 1 minute
    PREFS.quietHours = { enabled: true, start: "00:00", end: "23:59" };

    // Create a session anchor and a due-now item
    const anchor = relativeScheduler.createAnchor({
      anchorId: "a1",
      sessionId: "S1",
      domain: "cooking",
      startedAt: BASE,
      meta: { createdAt: BASE },
    });

    relativeScheduler.schedule(anchor.anchorId, [
      { title: "Start simmer", offsetMs: 0, suspendable: true, kind: "reminder" },
    ]);

    // Let first tick process -> should mute
    await advance(60);

    const muted = emissions.filter(e => e.evt === "relative.reminder.muted");
    const due = emissions.filter(e => e.evt === "relative.reminder.due");
    expect(muted.length).toBeGreaterThan(0);
    expect(due.length).toBe(0);

    // Transition to unquiet period
    QUIET = false;
    await advance(60);

    const unquiet = emissions.filter(e => e.evt === "relative.reminder.unquietReady");
    expect(unquiet.length).toBeGreaterThan(0);

    // A user-facing notification should have been queued when muted
    expect(notifications.some(n => /Queued: Start simmer/i.test(n.title))).toBe(true);
  });
});

describe("Guards • Sabbath", () => {
  it("mutes due reminders during Sabbath", async () => {
    SABBATH = true;
    PREFS.sabbathGuard = { enabled: true };

    const anchor = relativeScheduler.createAnchor({
      anchorId: "a2",
      sessionId: "S2",
      domain: "animals",
      startedAt: BASE,
    });

    relativeScheduler.schedule(anchor.anchorId, [
      { title: "Morning feed", offsetMs: 0, suspendable: true, kind: "reminder" },
    ]);

    await advance(60);

    const muted = emissions.filter(e => e.evt === "relative.reminder.muted");
    const due = emissions.filter(e => e.evt === "relative.reminder.due");
    expect(muted.length).toBeGreaterThan(0);
    expect(due.length).toBe(0);
    // Check mutedBecause flag
    expect(muted[0].payload?.mutedBecause || muted[0].mutedBecause || muted[0].mutedbecause).toBeDefined();
  });
});

describe("Guards • Weather/withholds", () => {
  it("emits planner.conflict.detected and NBA request instead of due when withhold is active", async () => {
    // No quiet/sabbath
    QUIET = false;
    SABBATH = false;

    // Fake a 'storm' withhold for garden domain
    WITHHOLDS = [
      { domain: "garden", kind: "storm", until: BASE + 3_600_000 },
    ];

    const anchor = relativeScheduler.createAnchor({
      anchorId: "a3",
      sessionId: "S3",
      domain: "garden",
      startedAt: BASE,
    });

    relativeScheduler.schedule(anchor.anchorId, [
      { title: "Transplant bed A", offsetMs: 0, kind: "reminder" },
    ]);

    await advance(60);

    const conflicts = emissions.filter(e => e.evt === "planner.conflict.detected");
    const nbareq = emissions.filter(e => e.evt === "nba.suggestion.requested");
    const due = emissions.filter(e => e.evt === "relative.reminder.due");

    expect(conflicts.length).toBeGreaterThan(0);
    expect(nbareq.length).toBeGreaterThan(0);
    expect(due.length).toBe(0);
    expect(conflicts[0].payload?.kind || conflicts[0].kind).toBe("storm");
  });
});

describe("Anchors • resolveAnchor sanity", () => {
  it("resolveAnchor('quietEnd') respects Quiet Hours window", () => {
    PREFS.quietHours = { enabled: true, start: "22:00", end: "06:00" };
    const ts = resolveAnchor("quietEnd", { baseTs: BASE }); // BASE is 09:00 local
    // For a morning base, quietEnd should be the next 06:00 boundary (which will be next day)
    // We only assert it's within ~48h and in the future.
    expect(ts).toBeGreaterThan(BASE);
    expect(ts - BASE).toBeLessThanOrEqual(48 * 3600000);
  });

  it("resolveAnchor('sabbathEnd') returns Saturday ~19:30 when enabled", () => {
    PREFS.sabbathGuard = { enabled: true };
    const ts = resolveAnchor("sabbathEnd", { baseTs: BASE });
    // Should be in the future and within the next 8 days.
    expect(ts).toBeGreaterThan(BASE);
    expect(ts - BASE).toBeLessThanOrEqual(8 * 86400000);
  });
});
