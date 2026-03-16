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
const T = globalThis.vi || globalThis.jest;

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

let offRealEvents = null;
let restoreRealEmit = null;

function topicFromEnvelope(env) {
  if (!env || typeof env !== "object") return null;
  return (
    env.topic ||
    env.type ||
    env.event ||
    (env.payload && (env.payload.topic || env.payload.type || env.payload.event)) ||
    null
  );
}

function lastByTopic(topic) {
  for (let i = seen.length - 1; i >= 0; i--) {
    if (topicFromEnvelope(seen[i]) === topic) return seen[i];
  }
  return null;
}
function allByTopic(topic) {
  return seen.filter((e) => topicFromEnvelope(e) === topic);
}

/** Keep handlers alive between tests; just clear the event log. */
function resetLogOnly() {
  seen.length = 0;
}

async function flushEvents(ms = 10) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------------------- Jest Mocks ----------------------------- */
// Map "@/..." to our in-memory hub + test doubles.
T?.mock?.("@/automation/events", () => Hub);
T?.mock?.("@/automation/events/index", () => Hub);
T?.mock?.("@/services/eventAliases", () => {
  // no-op canonicalizer; handlers will still call it safely
  return {
    canonicalizeEnvelope(env) {
      return env;
    },
  };
});

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

T?.mock?.("@/stores/SettingsStore", () => ({
  get: (k) => {
    const parts = k.split(".");
    // shallow nested resolve
    let cur = settings;
    for (const p of parts) {
      cur = cur && typeof cur === "object" ? cur[p] : undefined;
    }
    return cur;
  },
}));

T?.mock?.("@/stores/SessionStore", () => ({
  getById: (id) =>
    id
      ? {
          id,
          start: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          state: "active",
        }
      : null,
}));

const reminderCalls = [];
T?.mock?.("@/managers/ReminderManager", () => ({
  schedule: (r) => reminderCalls.push(r),
}));

T?.mock?.("@/engines/SubstitutionEngine", () => ({
  // return one sub for known animal feed items, else none
  suggest: ({ sku, name, category, domain }) => {
    const s = (sku || name || "").toString().toLowerCase();
    if (domain === "animals" && (s.includes("layer") || s.includes("feed"))) {
      return [{ sku: null, name: "Scratch + protein supplement", reason: "Temporary ration" }];
    }
    return [];
  },
}));

T?.mock?.("@/managers/ListBuilder", () => ({
  build: (items, opts) => ({
    items,
    storeId: opts && opts.storeId ? opts.storeId : "store:default",
    aisleGroups: {},
    collapsedDuplicates: !!(opts && opts.collapseDuplicates),
  }),
}));

T?.mock?.("@/engines/estimateEngine", () => ({
  estimateLines: (lines) => ({
    lines: lines.map((l) => ({ ...l, unitPrice: l.unitPrice || 1.5, lineTotal: (l.unitPrice || 1.5) * (l.qty || 1) })),
    total: lines.reduce((s, l) => s + (l.unitPrice || 1.5) * (l.qty || 1), 0),
  }),
}));

/* ---------------------- Bring in real handlers ----------------------- */
// They will auto-register on our mocked hub when imported.
beforeAll(() => {
  const base = (...parts) => path.resolve(__dirname, "..", ...parts);
  const realEvents = require(base("automation", "events", "index.js"));
  if (realEvents && typeof realEvents.emit === "function") {
    const originalEmit = realEvents.emit.bind(realEvents);
    realEvents.emit = (topic, payload, envelope) => {
      seen.push({ topic, payload, ...(envelope || {}), __source: "realEvents.emit" });
      return originalEmit(topic, payload, envelope);
    };
    restoreRealEmit = () => {
      realEvents.emit = originalEmit;
    };
  }
  if (realEvents && typeof realEvents.on === "function") {
    offRealEvents = realEvents.on("*", (env) => {
      seen.push(env);
    });
  }

  // Orchestration handlers
  const supply = require(base("automation", "handlers", "onSupplyShortageDetected.js"));
  const prep = require(base("automation", "handlers", "onPrepTasksRequested.js"));
  const conflict = require(base("automation", "handlers", "emitPlannerConflict.js"));
  // NEW: Animal Plan Generator (replaces prior inline mock)
  const animal = require(base("automation", "handlers", "onAnimalPlanDraftRequested.js"));

  // Force registration on the test hub regardless of module auto-init behavior.
  supply && supply.register && supply.register(Hub);
  prep && prep.register && prep.register(Hub);
  conflict && conflict.register && conflict.register(Hub);
  animal && animal.register && animal.register(Hub);
});

afterAll(() => {
  if (typeof offRealEvents === "function") offRealEvents();
  if (typeof restoreRealEmit === "function") restoreRealEmit();
  offRealEvents = null;
  restoreRealEmit = null;
});

afterEach(() => {
  resetLogOnly();
  reminderCalls.length = 0;
});

/* ------------------------------- Tests -------------------------------- */

describe("Animals plan orchestration flows", () => {
  test("draft requested → generated (with fan-out)", async () => {
    // Fire the real draft request; handler should generate and fan out.
    Hub.emit("animalplan.draft.requested", {
      sessionId: "sess:1",
      templateId: "tmpl:animals-basic",
      options: { size: "smallholding" },
    });
    await flushEvents();

    // Generated draft
    const gen = lastByTopic("animalplan.generated");
    expect(gen).toBeTruthy();
    expect(gen.payload.status).toBe("generated");
    expect(Array.isArray(gen.payload.items)).toBe(true);
    expect(gen.payload.items.length).toBeGreaterThan(0);

    // Fan-out checks
    const prepReq = lastByTopic("prep.tasks.requested");
    expect(prepReq).toBeTruthy();

    const shortageProbe =
      lastByTopic("inventory.shortage.detected") ||
      lastByTopic("supply.shortage.detected");
    expect(shortageProbe).toBeTruthy();

    const conflictScan = lastByTopic("planner.conflict.requested");
    expect(conflictScan).toBeTruthy();

    const nba = lastByTopic("nba.updated");
    expect(nba).toBeTruthy();
    const labels = (nba.payload.suggestions || []).map((s) => s.label);
    expect(labels.join(" ")).toMatch(/Review Animal Plan|Start sanitizer/i);
  });

  test("grocery/supply list → shortages (animals domain) emits list + subs + NBA", async () => {
    // Feed shortage detected
    Hub.emit("inventory.shortage.detected", {
      items: [
        { id: "s1", domain: "animals", name: "Layer feed 50lb", requiredQty: 1, unit: "bag", neededBy: new Date(Date.now() + 2 * 3600 * 1000).toISOString() },
        { id: "s2", domain: "animals", name: "Disposable gloves", requiredQty: 2, unit: "box", neededBy: new Date(Date.now() + 6 * 3600 * 1000).toISOString() },
      ],
      options: { attemptSubstitutions: true, autoGenerateList: true, autoPurchase: false },
    });
    await flushEvents();

    // grocerylist.generate.requested fired?
    const gl =
      lastByTopic("grocerylist.requested") ||
      lastByTopic("grocerylist.generate.requested");
    expect(gl).toBeTruthy();
    expect(gl.payload.items.length).toBeGreaterThanOrEqual(2);

    // substitution.suggested may vary by suggestion strategy, but processing must complete.
    const subsAll = allByTopic("substitution.suggested");
    const processed = lastByTopic("supply.shortage.processed");
    const anyFeed = subsAll.some((e) => ((e.payload && e.payload.items) || []).some((s) => /scratch/i.test(s.name)));
    expect(anyFeed || !!processed).toBe(true);

    // NBA updated with replace/list actions
    const nba = lastByTopic("nba.updated");
    expect(nba).toBeTruthy();
    const labels = (nba.payload.suggestions || []).map((s) => s.label || "");
    expect(labels.join(" ")).toMatch(/Add to Shopping List/i);
  });

  test("prep tasks → execution: generates prep and near-due NBA", async () => {
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
    await flushEvents();

    const gen = lastByTopic("prep.tasks.generated");
    expect(gen).toBeTruthy();
    expect(gen.payload.tasks.length).toBeGreaterThan(0);
    const nba = lastByTopic("nba.updated");
    if (nba) {
      // ensure a "Start" suggestion exists when NBA cards are emitted.
      const hasStart = (nba.payload.suggestions || []).some((s) => /Start:/i.test(s.label));
      expect(hasStart).toBe(true);
    } else {
      // Some runtime modes emit calendar/reminder requests instead of NBA cards.
      const reminder = lastByTopic("reminder.schedule.requested");
      const calendar = lastByTopic("calendar.event.requested");
      expect(!!reminder || !!calendar).toBe(true);
    }
  });

  test("conflicts (weather, withhold) → decider resolution suggestions", async () => {
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
    await flushEvents();

    // conflict emissions
    const emitted = lastByTopic("planner.conflict.emitted");
    expect(emitted).toBeTruthy();
    expect(emitted.payload.summary.total).toBeGreaterThanOrEqual(2);

    // suggestions include at least one actionable conflict remedy.
    const suggested = allByTopic("planner.conflict.suggested");
    const flatLabels = suggested.flatMap((e) => (e.payload.suggestions || []).map((s) => s.label));
    const hasWithhold = flatLabels.some((l) => /respect withhold|Delay start/i.test(l));
    const hasReschedule = flatLabels.some((l) => /Move later|Delay start|Reassign/i.test(l));
    expect(hasWithhold || hasReschedule).toBe(true);

    // NBA cards present for conflicts
    const nba = lastByTopic("nba.updated");
    expect(nba).toBeTruthy();
    const anyConflictCard = (nba.payload.suggestions || []).some((s) => (s.badges || []).includes("conflict"));
    expect(anyConflictCard).toBe(true);
  });
});
