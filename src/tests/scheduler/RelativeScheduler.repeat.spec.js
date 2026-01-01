/* eslint-disable no-console */
/**
 * RelativeScheduler.repeat.spec.js
 * Contract tests for repeatEvery & untilAnchor.
 *
 * Works in Vitest or Jest.
 *
 * What we assert:
 *  1) ISO-8601 durations (PT15M, PT1H, P1D) + shorthand (+20m) are parsed.
 *  2) repeatEvery generates occurrences from base startAt (inclusive) forward.
 *  3) untilAnchor trims the series at resolved anchors:
 *       - "endOfDay" (local to prefs.timeZone)
 *       - "sabbathEnd" (if sabbath guard enabled; Sat ~19:30 local)
 *       - explicit timestamp (ms)
 *  4) Guard windows are respected: Quiet Hours/Sabbath windows can be skipped or trimmed.
 *  5) Favorites: overrides (repeatEvery) are honored.
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
let PREFS = {
  user: { locale: "en-US", timeZone: "America/Chicago" },
  quietHours: { enabled: false, start: "22:00", end: "06:00" },
  sabbathGuard: { enabled: false },
};

// Deterministic base time: Mon Oct 27, 2025 09:00:00 CT (UTC-5)
const BASE = Date.UTC(2025, 9, 27, 14, 0, 0); // store as UTC; prefs tz is America/Chicago

// ------------------------------ Mocks ---------------------------------------

T?.mock?.("@/services/eventBus", () => {
  const handlers = new Map();
  return {
    __esModule: true,
    default: {
      emit: (evt, payload) => {
        emissions.push({ evt, payload });
        handlers.get(evt)?.(payload);
        return true;
      },
      on: (evt, fn) => handlers.set(evt, fn),
      off: (evt) => handlers.delete(evt),
    },
  };
});

T?.mock?.("@/stores/scheduler/prefs", () => {
  return {
    __esModule: true,
    getSchedulerPrefs: () => ({
      ...PREFS,
      safety: { softLeadMs: 120000, hardGraceMs: 60000, cooldownMs: 1, minTickMs: 5000 },
    }),
    default: { getSchedulerPrefs: () => ({
      ...PREFS,
      safety: { softLeadMs: 120000, hardGraceMs: 60000, cooldownMs: 1, minTickMs: 5000 },
    })},
  };
});

// Offset parser: emulate your shared util (+20m / PT1H / P1D)
T?.mock?.("@/services/session/utils/offsetParser", () => {
  const toMs = (s) => {
    if (typeof s === "number") return s;
    if (!s) return 0;
    // Shorthand: +20m, +2h, +1d
    const sh = /^\+?(\d+)\s*([smhd])$/i.exec(s);
    if (sh) {
      const n = parseInt(sh[1], 10);
      const u = sh[2].toLowerCase();
      return u === "s" ? n * 1000
        : u === "m" ? n * 60000
        : u === "h" ? n * 3600000
        : n * 86400000;
    }
    // ISO durations: PT15M, PT1H, P1D
    const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(s);
    if (iso) {
      const d = parseInt(iso[1] || "0", 10);
      const h = parseInt(iso[2] || "0", 10);
      const m = parseInt(iso[3] || "0", 10);
      const sec = parseInt(iso[4] || "0", 10);
      return d * 86400000 + h * 3600000 + m * 60000 + sec * 1000;
    }
    return Number(s) || 0;
  };
  return {
    __esModule: true,
    toMs,
    default: { toMs },
  };
});

// ------------------------------ Imports -------------------------------------

let RelativeScheduler;

beforeEach(async () => {
  emissions.length = 0;
  PREFS = {
    user: { locale: "en-US", timeZone: "America/Chicago" },
    quietHours: { enabled: false, start: "22:00", end: "06:00" },
    sabbathGuard: { enabled: false },
  };

  // Dynamically import AFTER mocks, so the scheduler uses mocked deps.
  // Contract: module exports generateRepeats(input, nowMs?)
  //   input: { startAt, repeatEvery, count?, untilTs?, untilAnchor?, guards?, favorite? }
  //   returns: { occurrences:number[], meta:{ trimmedBy?: "endOfDay"|"sabbathEnd"|"untilTs", skippedByGuards?:boolean } }
  RelativeScheduler = await import("@/services/session/RelativeScheduler");
});

afterEach(() => {
  // no-op
});

// Utility: end of local day (America/Chicago) for ts
function endOfLocalDay(ts, tz = "America/Chicago") {
  // crude but deterministic: compute local date by offset guessing
  const d = new Date(ts);
  // Construct end-of-day 23:59:59.999 in local tz by using that tz's components if your impl supports it.
  // For tests, we accept scheduler's version as authoritative; here we just sanity check ordering.
  return ts + (23 - d.getUTCHours()) * 3600000; // rough upper bound; contract asserts <= end, not exact equality
}

// -------------------------------- Tests -------------------------------------

describe("RelativeScheduler • repeatEvery & untilAnchor", () => {
  it("generates 4 occurrences for PT15M with count=4 from startAt (inclusive)", async () => {
    // Given
    const startAt = BASE; // 09:00 local CT
    const { generateRepeats } = RelativeScheduler;
    const res = generateRepeats({
      startAt,
      repeatEvery: "PT15M",
      count: 4,
    }, BASE);

    expect(Array.isArray(res.occurrences)).toBe(true);
    expect(res.occurrences.length).toBe(4);
    expect(res.occurrences[0]).toBe(startAt);
    expect(res.occurrences[1] - res.occurrences[0]).toBe(15 * 60000);
    expect(res.occurrences[3] - res.occurrences[2]).toBe(15 * 60000);
    expect(res.meta?.trimmedBy).toBeUndefined();
  });

  it("respects shorthand +20m and trims by untilTs", async () => {
    const { generateRepeats } = RelativeScheduler;
    const startAt = BASE;
    const untilTs = BASE + 45 * 60000 + 1; // just past 45 min mark
    const res = generateRepeats({
      startAt,
      repeatEvery: "+20m",
      untilTs,
    }, BASE);

    // Should include 09:00, 09:20, 09:40; 10:00 would exceed untilTs
    expect(res.occurrences).toEqual([BASE, BASE + 20 * 60000, BASE + 40 * 60000]);
    expect(res.meta?.trimmedBy).toBe("untilTs");
  });

  it("repeatEvery=PT1H untilAnchor=endOfDay trims at end of local day", async () => {
    const { generateRepeats, resolveAnchor } = RelativeScheduler;
    const startAt = BASE; // 09:00 local
    const endAnchorTs = resolveAnchor("endOfDay", { baseTs: startAt }); // let impl decide exact EOD

    const res = generateRepeats({
      startAt,
      repeatEvery: "PT1H",
      untilAnchor: "endOfDay",
    }, BASE);

    expect(res.occurrences[0]).toBe(startAt);
    // All occurrences <= end-of-day anchor
    expect(res.occurrences.every(ts => ts <= endAnchorTs)).toBe(true);
    // Should produce hourly ticks up to day end
    for (let i = 1; i < res.occurrences.length; i++) {
      expect(res.occurrences[i] - res.occurrences[i - 1]).toBe(3600000);
    }
    expect(res.meta?.trimmedBy).toBe("endOfDay");
  });

  it("repeatEvery=P1D with untilAnchor=sabbathEnd stops at Sabbath end when Sabbath guard enabled", async () => {
    PREFS.sabbathGuard = { enabled: true };

    const { generateRepeats, resolveAnchor } = RelativeScheduler;

    // Simulate a series that starts Friday at 09:00 local; produce occurrences until Sabbath end
    // Our BASE is Monday; so adjust: set startAt to the recent Friday (relative value is fine for contract)
    const fridayStart = BASE - 3 * 86400000; // prior Friday 09:00
    const sabEndTs = resolveAnchor("sabbathEnd", { baseTs: fridayStart });

    const res = generateRepeats({
      startAt: fridayStart,
      repeatEvery: "P1D",
      untilAnchor: "sabbathEnd",
      guards: { sabbathGuard: PREFS.sabbathGuard },
    }, fridayStart);

    // Occurrences should not go past sabbathEnd anchor
    expect(res.occurrences.every(ts => ts <= sabEndTs)).toBe(true);
    // Daily cadence
    for (let i = 1; i < res.occurrences.length; i++) {
      expect(res.occurrences[i] - res.occurrences[i - 1]).toBe(86400000);
    }
    expect(res.meta?.trimmedBy).toBe("sabbathEnd");
  });

  it("Quiet Hours anchor works: untilAnchor=quietEnd trims at the end of the current quiet window", async () => {
    PREFS.quietHours = { enabled: true, start: "22:00", end: "06:00" };

    const { generateRepeats, resolveAnchor } = RelativeScheduler;
    const startAt = BASE; // morning; anchor resolution should find next quietEnd boundary
    const qEndTs = resolveAnchor("quietEnd", { baseTs: startAt });

    const res = generateRepeats({
      startAt,
      repeatEvery: "PT30M",
      untilAnchor: "quietEnd",
      guards: { quietHours: PREFS.quietHours },
    }, BASE);

    expect(res.occurrences.length).toBeGreaterThan(0);
    expect(res.occurrences[res.occurrences.length - 1] <= qEndTs).toBe(true);
    expect(res.meta?.trimmedBy).toBe("quietEnd");
  });

  it("Favorite overrides: per-favorite repeatEvery supersedes input.repeatEvery", async () => {
    const { generateRepeats } = RelativeScheduler;
    const startAt = BASE;
    const res = generateRepeats({
      startAt,
      repeatEvery: "PT1H", // will be overridden
      favorite: {
        isFavorite: true,
        overrides: { repeatEvery: "PT10M" },
      },
      count: 3,
    }, BASE);

    // Expect 10-minute cadence due to override
    expect(res.occurrences).toEqual([startAt, startAt + 600000, startAt + 1200000]);
  });

  it("Explicit untilTs takes precedence over untilAnchor when both provided", async () => {
    const { generateRepeats, resolveAnchor } = RelativeScheduler;
    const startAt = BASE;
    const anchorTs = resolveAnchor("endOfDay", { baseTs: startAt });
    const untilTs = startAt + 75 * 60000; // 1h15m

    const res = generateRepeats({
      startAt,
      repeatEvery: "PT30M",
      untilTs,                 // precedence
      untilAnchor: "endOfDay", // ignored due to untilTs
    }, BASE);

    expect(res.occurrences).toEqual([startAt, startAt + 1800000, startAt + 3600000]);
    expect(res.meta?.trimmedBy).toBe("untilTs");
    // Sanity: untilTs earlier than anchor
    expect(untilTs < anchorTs).toBe(true);
  });
});
