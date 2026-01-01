/* eslint-disable no-console */
/**
 * animal.plan.flow.test.js — End-to-end-ish orchestration tests for Animals domain
 *
 * Covers:
 *  • draft requested → generated
 *  • grocery/supply list → shortages
 *  • prep tasks → execution
 *  • conflicts (weather, withhold) → decider resolution
 */

const path = require("path");

/* ------------------------ In-memory Events Hub ------------------------ */
const listeners = {};
const seen = []; // envelope log for assertions

const Events = {
  NBA_UPDATED: "nba.updated",
};

const Hub = {
  Events,
  on(topic, fn) {
    (listeners[topic] = listeners[topic] || []).push(fn);
  },
  offAll() {
    Object.keys(listeners).forEach((k) => (listeners[k] = []));
  },
  emit(topic, payload, envelope = {}) {
    const env = {
      topic,
      payload,
      ...envelope,
    };
    seen.push(env);
    const fns = listeners[topic] || [];
    fns.forEach((fn) => fn(env));
  },
};

function lastByTopic(topic) {
  for (let i = seen.length - 1; i >= 0; i--) {
    if (seen[i].topic === topic) return seen[i];
  }
  return null;
}
function allByTopic(topic) {
  return seen.filter((e) => e.topic === topic);
}

/** Keep handlers alive between tests; just clear the event log. */
function resetLogOnly() {
  seen.length = 0;
}

/* ---------------------------- Jest Mocks ----------------------------- */
// Map "@/..." to our in-memory hub + test doubles.
jest.mock("@/automation/events", () => Hub, { virtual: true });
jest.mock("@/services/eventAliases", () => {
  // no-op canonicalizer; handlers will still call it safely
  return {
    canonicalizeEnvelope(env) {
      return env;
    },
  };
}, { virtual: true });

const settings = {
  sabbathGuard: false,
  defaultStoreId: "store:default",
  preferredVendor: "vendor:main",
  "prep.preheatCoalesceWindowMin": 10,
  "prep.liquidCoalesceWindowMin": 20,
  "prep.marinadeCoalesceWindowMin": 30,
  "prep.immediateWindowMin": 10,
  notifications: { channelsDefault: ["toast"] },
  budget: { sessionCap: 0 },
};

jest.mock("@/stores/SettingsStore", () => ({
  get: (k) => {
    const parts = k.split(".");
    // shallow nested resolve
    let cur = settings;
    for (const p of parts) {
      cur = cur && typeof cur === "object" ? cur[p] : undefined;
    }
    return cur;
  },
}), { virtual: true });

jest.mock("@/stores/SessionStore", () => ({
  getById: (id) =>
    id
      ? {
          id,
          start: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          state: "active",
        }
      : null,
}), { virtual: true });

const reminderCalls = [];
jest.mock("@/managers/ReminderManager", () => ({
  schedule: (r) => reminderCalls.push(r),
}), { virtual: true });

jest.mock("@/engines/SubstitutionEngine", () => ({
  // return one sub for known animal feed items, else none
  suggest: ({ sku, name, category, domain }) => {
    const s = (sku || name || "").toString().toLowerCase();
    if (domain === "animals" && (s.includes("layer") || s.includes("feed"))) {
      return [{ sku: null, name: "Scratch + protein supplement", reason: "Temporary ration" }];
    }
    return [];
  },
}), { virtual: true });

jest.mock("@/managers/ListBuilder", () => ({
  build: (items, opts) => ({
    items,
    storeId: opts && opts.storeId ? opts.storeId : "store:default",
    aisleGroups: {},
    collapsedDuplicates: !!(opts && opts.collapseDuplicates),
  }),
}), { virtual: true });

jest.mock("@/engines/estimateEngine", () => ({
  estimateLines: (lines) => ({
    lines: lines.map((l) => ({ ...l, unitPrice: l.unitPrice || 1.5, lineTotal: (l.unitPrice || 1.5) * (l.qty || 1) })),
    total: lines.reduce((s, l) => s + (l.unitPrice || 1.5) * (l.qty || 1), 0),
  }),
}), { virtual: true });

/* ---------------------- Bring in real handlers ----------------------- */
// They will auto-register on our mocked hub when imported.
beforeAll(() => {
  const base = (...parts) => path.resolve(__dirname, "..", ...parts);
  // Orchestration handlers
  require(base("automation", "handlers", "onSupplyShortageDetected.js"));
  require(base("automation", "handlers", "onPrepTasksRequested.js"));
  require(base("automation", "handlers", "emitPlannerConflict.js"));
  // NEW: Animal Plan Generator (replaces prior inline mock)
  require(base("automation", "handlers", "onAnimalPlanDraftRequested.js"));
});

afterEach(() => {
  resetLogOnly();
  reminderCalls.length = 0;
});

/* ------------------------------- Tests -------------------------------- */

describe("Animals plan orchestration flows", () => {
  test("draft requested → generated (with fan-out)", () => {
    // Fire the real draft request; handler should generate and fan out.
    Hub.emit("animalplan.draft.requested", {
      sessionId: "sess:1",
      templateId: "tmpl:animals-basic",
      options: { size: "smallholding" },
    });

    // Generated draft
    const gen = lastByTopic("animalplan.generated");
    expect(gen).toBeTruthy();
    expect(gen.payload.status).toBe("generated");
    expect(Array.isArray(gen.payload.items)).toBe(true);
    expect(gen.payload.items.length).toBeGreaterThan(0);

    // Fan-out checks
    const prepReq = lastByTopic("prep.tasks.requested");
    expect(prepReq).toBeTruthy();

    const shortageProbe = lastByTopic("supply.shortage.detected");
    expect(shortageProbe).toBeTruthy();

    const conflictScan = lastByTopic("planner.conflict.requested");
    expect(conflictScan).toBeTruthy();

    const nba = lastByTopic("nba.updated");
    expect(nba).toBeTruthy();
    const labels = (nba.payload.suggestions || []).map((s) => s.label);
    expect(labels.join(" ")).toMatch(/Review Animal Plan|Start sanitizer/i);
  });

  test("grocery/supply list → shortages (animals domain) emits list + subs + NBA", () => {
    // Feed shortage detected
    Hub.emit("supply.shortage.detected", {
      items: [
        { id: "s1", domain: "animals", name: "Layer feed 50lb", requiredQty: 1, unit: "bag", neededBy: new Date(Date.now() + 2 * 3600 * 1000).toISOString() },
        { id: "s2", domain: "animals", name: "Disposable gloves", requiredQty: 2, unit: "box", neededBy: new Date(Date.now() + 6 * 3600 * 1000).toISOString() },
      ],
      options: { attemptSubstitutions: true, autoGenerateList: true, autoPurchase: false },
    });

    // grocerylist.generate.requested fired?
    const gl = lastByTopic("grocerylist.generate.requested");
    expect(gl).toBeTruthy();
    expect(gl.payload.items.length).toBeGreaterThanOrEqual(2);

    // substitution.suggested for the feed?
    const subsAll = allByTopic("substitution.suggested");
    const anyFeed = subsAll.some((e) => ((e.payload && e.payload.items) || []).some((s) => /scratch/i.test(s.name)));
    expect(anyFeed).toBe(true);

    // NBA updated with replace/list actions
    const nba = lastByTopic("nba.updated");
    expect(nba).toBeTruthy();
    const labels = (nba.payload.suggestions || []).map((s) => s.label || "");
    expect(labels.join(" ")).toMatch(/Add to Shopping List/i);
  });

  test("prep tasks → execution: generates prep and near-due NBA", () => {
    const neededBy = new Date(Date.now() + 8 * 60 * 1000).toISOString(); // ~8 min out to trigger NBA immediate window (10 min)

    Hub.emit("prep.tasks.requested", {
      sessionId: "sess:2",
      planId: "plan:butch-001",
      source: "animals",
      items: [
        {
          id: "a1",
          title: "Butchery batch A",
          domain: "animals",
          neededBy,
          leadTimes: {
            sanitizeMinutes: 5,
            defrostHours: 0,
            preheatMinutes: 0,
          },
          resources: { ppe: ["gloves"] },
          constraints: { chillChain: { maxMinutesOut: 25 } },
          meta: {}
        },
      ],
      options: {},
    });

    const gen = lastByTopic("prep.tasks.generated");
    expect(gen).toBeTruthy();
    expect(gen.payload.tasks.length).toBeGreaterThan(0);
    const nba = lastByTopic("nba.updated");
    expect(nba).toBeTruthy();
    // ensure a "Start" suggestion exists
    const hasStart = (nba.payload.suggestions || []).some((s) => /Start:/i.test(s.label));
    expect(hasStart).toBe(true);
  });

  test("conflicts (weather, withhold) → decider resolution suggestions", () => {
    const start = Date.now() + 5 * 60 * 1000;
    const items = [
      {
        id: "g1",
        title: "Outdoor slaughter station setup",
        domain: "animals",
        scheduledAt: start,
        estimatedMs: 60 * 60 * 1000,
        resources: { zone: "butchery-table", personIds: ["u:1"] },
        meta: { requires: "dry", weather: "rain" }, // triggers weather.blocker
      },
      {
        id: "g2",
        title: "Chill chain staging",
        domain: "animals",
        scheduledAt: start + 5 * 60 * 1000,
        estimatedMs: 60 * 60 * 1000,
        resources: { zone: "butchery-table", personIds: ["u:1"] },
        meta: { constraints: { withholdMinutes: 45 } }, // early start against withhold
        constraints: { withholdMinutes: 45 },
      },
    ];

    Hub.emit("planner.conflict.requested", {
      sessionId: "sess:3",
      planId: "plan:butch-002",
      options: { source: "animals", sabbathGuard: false },
      items,
    });

    // conflict emissions
    const emitted = lastByTopic("planner.conflict.emitted");
    expect(emitted).toBeTruthy();
    expect(emitted.payload.summary.total).toBeGreaterThanOrEqual(2);

    // suggestions include weather + withhold remedies
    const suggested = allByTopic("planner.conflict.suggested");
    const flatLabels = suggested.flatMap((e) => (e.payload.suggestions || []).map((s) => s.label));
    const hasWeather = flatLabels.some((l) => /Reschedule to dry window/i.test(l));
    const hasWithhold = flatLabels.some((l) => /respect withhold|Delay start/i.test(l));
    expect(hasWeather).toBe(true);
    expect(hasWithhold).toBe(true);

    // NBA cards present for conflicts
    const nba = lastByTopic("nba.updated");
    expect(nba).toBeTruthy();
    const anyConflictCard = (nba.payload.suggestions || []).some((s) => (s.badges || []).includes("conflict"));
    expect(anyConflictCard).toBe(true);
  });
});
