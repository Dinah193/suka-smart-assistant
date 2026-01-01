/* eslint-disable no-console */
/**
 * orchestrator.flow.spec.js
 * Integration: start → pause → unpause → end (happy path)
 *
 * What this covers
 * - Session lifecycle emits (created/started/paused/resumed/completed)
 * - RelativeScheduler anchor wiring (created/paused/resumed/ended)
 * - Favorites-first metadata carried into session creation
 * - Due reminder flow happens only while session is active (no emits after end)
 * - Minimal orchestration glue you can later swap for your real orchestrator
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

// ----------------------------- Fixtures & Mocks -----------------------------

// Deterministic base: Mon Oct 27, 2025 09:00:00 America/Chicago
const BASE = Date.UTC(2025, 9, 27, 14, 0, 0);

const emissions = [];
const notifications = [];

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

T?.mock?.("@/stores/scheduler/prefs", () => {
  return {
    __esModule: true,
    getSchedulerPrefs: () => ({
      user: { locale: "en-US", timeZone: "America/Chicago" },
      quietHours: { enabled: false, start: "22:00", end: "06:00" },
      sabbathGuard: { enabled: false },
      safety: { softLeadMs: 120000, hardGraceMs: 60000, cooldownMs: 1, minTickMs: 5000 },
    }),
    default: { getSchedulerPrefs: () => ({
      user: { locale: "en-US", timeZone: "America/Chicago" },
      quietHours: { enabled: false, start: "22:00", end: "06:00" },
      sabbathGuard: { enabled: false },
      safety: { softLeadMs: 120000, hardGraceMs: 60000, cooldownMs: 1, minTickMs: 5000 },
    })},
  };
});

// ------------------------------- Imports ------------------------------------

let relativeScheduler;
let generateRepeats; // (not strictly needed here, but available if you expand test)

beforeEach(async () => {
  emissions.length = 0;
  notifications.length = 0;

  // Fake timers + fixed system time
  if (isVitest) {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
  } else {
    jest.useFakeTimers().setSystemTime(new Date(BASE));
  }

  const mod = await import("@/services/session/RelativeScheduler");
  relativeScheduler = mod.relativeScheduler || (mod.default && mod.default.relativeScheduler) || mod;
  generateRepeats = mod.generateRepeats;

  // keep scheduler fast
  relativeScheduler._stop?.();
  relativeScheduler.init?.({ tickMs: 25, autostart: true });
  relativeScheduler._resetAll?.();
});

afterEach(async () => {
  relativeScheduler?._stop?.();
  if (isVitest) {
    const { vi } = await import("vitest");
    vi.useRealTimers();
  } else {
    jest.useRealTimers();
  }
});

// Helpers
async function advance(ms) {
  if (isVitest) {
    const { vi } = await import("vitest");
    await vi.advanceTimersByTimeAsync(ms);
  } else {
    await jest.advanceTimersByTime(ms);
  }
}

function find(evt) { return emissions.filter(e => e.evt === evt); }
function last(evt) { const arr = find(evt); return arr[arr.length-1]; }

// -------------------------- Minimal Orchestrator -----------------------------

/**
 * Tiny orchestrator stub used for the integration test.
 * Wire-in points:
 *  - Emits session lifecycle events
 *  - Generates an anchor via RelativeScheduler on start
 *  - Schedules a couple of steps to prove reminders occur only when active
 */
function createOrchestrator() {
  const sessions = new Map(); // id -> { anchorId, domain, favoriteId? }
  const uid = () => `t${Math.random().toString(36).slice(2, 7)}`;

  return {
    startSession({ id = uid(), domain = "cooking", title = "Session", favoriteId, schedulePlan } = {}) {
      // 1) announce creation
      const created = {
        id, domain, title,
        items: [],
        createdAt: Date.now(),
        source: { favoriteId },
      };
      // eventBus is mocked; require inline to avoid hoist mismatch in Node ESM
      const bus = (require("@/services/eventBus").default);
      bus.emit("session:created", created);

      // 2) create anchor
      const anchorId = `anchor:${id}`;
      const anchor = relativeScheduler.createAnchor({
        anchorId,
        sessionId: id,
        domain,
        startedAt: Date.now(),
        meta: { createdAt: Date.now(), labels: ["session", domain] },
      });

      // 3) schedule some items (inclusive 0ms then +30s)
      const plan = schedulePlan || [
        { title: "Warm pan", offsetMs: 0, suspendable: true, kind: "reminder" },
        { title: "Add oil", offsetMs: 30_000, suspendable: true, kind: "reminder" },
      ];
      relativeScheduler.schedule(anchor.anchorId, plan);

      // 4) session started
      bus.emit("session:started", { id, startedAt: Date.now() });

      sessions.set(id, { anchorId, domain, favoriteId });
      return { id, anchorId };
    },

    pauseSession(id, reason = "user") {
      const sess = sessions.get(id);
      if (!sess) return;
      const bus = (require("@/services/eventBus").default);
      bus.emit("session:paused", { id, reason, pausedAt: Date.now(), anchorId: sess.anchorId });
    },

    resumeSession(id) {
      const sess = sessions.get(id);
      if (!sess) return;
      const bus = (require("@/services/eventBus").default);
      bus.emit("session:resumed", { id, resumedAt: Date.now(), anchorId: sess.anchorId });
    },

    completeSession(id) {
      const sess = sessions.get(id);
      if (!sess) return;
      const bus = (require("@/services/eventBus").default);
      // end anchor first
      bus.emit("session:ended", { id, endedAt: Date.now(), anchorId: sess.anchorId });
      // then mark completed
      bus.emit("session:completed", { id, completedAt: Date.now() });
    },
  };
}

// --------------------------------- Test -------------------------------------

describe("Integration • Orchestrator happy path", () => {
  it("start → pause → unpause → end (favorites honored; reminders only while active)", async () => {
    const orch = createOrchestrator();

    // START from a user favorite
    const favId = "fav_cook_morning_001";
    const { id: sessionId, anchorId } = orch.startSession({
      id: "S-1001",
      domain: "cooking",
      title: "Morning cook",
      favoriteId: favId,
    });

    // created + started + anchor created
    expect(find("session:created").length).toBe(1);
    expect(find("session:started").length).toBe(1);
    const anchorCreated = last("relative.schedule.anchor.created");
    expect(anchorCreated).toBeTruthy();
    expect(anchorCreated.payload?.sessionId || anchorCreated.sessionId).toBe(sessionId);

    // A due item at t=0 should trigger quickly
    await advance(60);
    const dueBeforePause = find("relative.reminder.due");
    expect(dueBeforePause.some(e => /Warm pan/i.test(JSON.stringify(e.payload || e)))).toBe(true);

    // PAUSE
    orch.pauseSession(sessionId, "user");
    await advance(25);
    const pausedEvt = last("relative.schedule.anchor.paused");
    expect(pausedEvt).toBeTruthy();
    expect(pausedEvt.payload?.anchorId || pausedEvt.anchorId).toBe(anchorId);

    // While paused, the +30s item should NOT fire (advance >30s)
    await advance(35_000);
    const dueDuringPause = find("relative.reminder.due").filter(e => /Add oil/i.test(JSON.stringify(e.payload || e)));
    expect(dueDuringPause.length).toBe(0);

    // RESUME
    orch.resumeSession(sessionId);
    await advance(25);
    const resumedEvt = last("relative.schedule.anchor.resumed");
    expect(resumedEvt).toBeTruthy();
    expect(resumedEvt.payload?.anchorId || resumedEvt.anchorId).toBe(anchorId);

    // After resume, the delayed item should fire
    await advance(60);
    const dueAfterResume = find("relative.reminder.due").filter(e => /Add oil/i.test(JSON.stringify(e.payload || e)));
    expect(dueAfterResume.length).toBeGreaterThan(0);

    // END (and mark completed)
    orch.completeSession(sessionId);
    await advance(25);
    const endEvt = last("relative.schedule.anchor.ended");
    const completedEvt = last("session:completed");
    expect(endEvt).toBeTruthy();
    expect(completedEvt).toBeTruthy();

    // Ensure no further reminders after end even if we advance a bunch
    const dueCountBefore = find("relative.reminder.due").length;
    await advance(60_000);
    const dueCountAfter = find("relative.reminder.due").length;
    expect(dueCountAfter).toBe(dueCountBefore);

    // Favorites-first assertion: session:created included favorite source
    const created = last("session:created");
    const payload = created.payload || created;
    expect((payload.source && payload.source.favoriteId) || payload.favoriteId).toBe(favId);
  });
});
