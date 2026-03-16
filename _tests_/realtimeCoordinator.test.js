import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCoordinator } = require("../src/server/services/realtimeCoordinator.js");
const {
  createInMemoryEventLogStore,
} = require("../src/server/services/realtimeEventLogStore.js");
const { createGraphProjector } = require("../src/server/services/realtimeGraphProjector.js");
const coordinatorModulePath = require.resolve("../src/server/services/realtimeCoordinator.js");
const eventLogStoreModulePath = require.resolve("../src/server/services/realtimeEventLogStore.js");

function makeHarness(factory = createCoordinator) {
  const listeners = new Map();
  const emits = [];

  const eventBus = {
    on(event, handler) {
      const arr = listeners.get(event) || [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    off(event, handler) {
      const arr = listeners.get(event) || [];
      listeners.set(
        event,
        arr.filter((h) => h !== handler)
      );
    },
    emit(event, payload) {
      const arr = listeners.get(event) || [];
      for (const h of arr) h(payload);
    },
  };

  const namespaceEmit = vi.fn((ns, event, payload, room) => {
    emits.push({ ns, event, payload, room });
  });

  const coordinator = factory({ eventBus, namespaceEmit });
  return { eventBus, namespaceEmit, emits, coordinator };
}

function makeHarnessWithStore(store) {
  return makeHarness((args) =>
    createCoordinator({
      ...args,
      eventLogStore: store,
      flags: {
        appendLogEnabled: true,
        replayOnBootEnabled: false,
      },
    })
  );
}

function withEnv(overrides = {}, fn) {
  const prev = new Map();
  for (const [k, v] of Object.entries(overrides)) {
    prev.set(k, process.env[k]);
    if (typeof v === "undefined" || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }

  try {
    return fn();
  } finally {
    for (const [k, v] of prev.entries()) {
      if (typeof v === "undefined") delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function loadIsolatedCoordinator({ eventStoreExports }) {
  const prevCoordinator = require.cache[coordinatorModulePath];
  const prevEventStore = require.cache[eventLogStoreModulePath];

  if (eventStoreExports) {
    require.cache[eventLogStoreModulePath] = {
      id: eventLogStoreModulePath,
      filename: eventLogStoreModulePath,
      loaded: true,
      exports: eventStoreExports,
    };
  }

  delete require.cache[coordinatorModulePath];
  const isolated = require(coordinatorModulePath);
  const out = isolated.createCoordinator;

  delete require.cache[coordinatorModulePath];
  if (prevCoordinator) require.cache[coordinatorModulePath] = prevCoordinator;
  else delete require.cache[coordinatorModulePath];

  if (prevEventStore) require.cache[eventLogStoreModulePath] = prevEventStore;
  else delete require.cache[eventLogStoreModulePath];

  return out;
}

describe("realtimeCoordinator", () => {
  let harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges repeated suggestions for same signal subject", () => {
    const first = harness.coordinator.ingest(
      {
        type: "inventoryShortage",
        payload: { sku: "eggs", name: "Eggs", qty: 2 },
      },
      {
        sourceModule: "tests.realtime",
        scope: "household",
        scopeId: "home-1",
      }
    );

    expect(first.createdSuggestions.length).toBe(2);
    expect(first.mergedSuggestions.length).toBe(0);

    const second = harness.coordinator.ingest(
      {
        type: "inventoryShortage",
        payload: { sku: "eggs", name: "Eggs", qty: 1 },
      },
      {
        sourceModule: "tests.realtime",
        scope: "household",
        scopeId: "home-1",
      }
    );

    expect(second.createdSuggestions.length).toBe(0);
    expect(second.mergedSuggestions.length).toBe(2);

    const pending = harness.coordinator.listSuggestions({
      scope: "household",
      scopeId: "home-1",
    });

    expect(pending.length).toBe(2);
    expect(pending.every((x) => Number(x.repeatCount) >= 2)).toBe(true);
  });

  it("assigns, unassigns, and consumes suggestions", () => {
    harness.coordinator.ingest(
      {
        type: "inventoryAdded",
        payload: { sku: "flour", name: "Flour", qty: 20 },
      },
      {
        sourceModule: "tests.realtime",
        scope: "household",
        scopeId: "home-2",
      }
    );

    const [item] = harness.coordinator.listSuggestions({
      scope: "household",
      scopeId: "home-2",
    });

    const assigned = harness.coordinator.assignSuggestion({
      scope: "household",
      scopeId: "home-2",
      suggestionId: item.id,
      assignedToUserId: "u123",
      assignedRole: "cook",
      assignedBy: "lead-1",
    });

    expect(assigned.assignedToUserId).toBe("u123");
    expect(assigned.assignedRole).toBe("cook");
    expect(Boolean(assigned.assignmentTs)).toBe(true);

    const unassigned = harness.coordinator.assignSuggestion({
      scope: "household",
      scopeId: "home-2",
      suggestionId: item.id,
      assignedToUserId: null,
      assignedRole: null,
      assignedBy: "lead-1",
    });

    expect(unassigned.assignedToUserId).toBe(null);
    expect(unassigned.assignedRole).toBe(null);

    const consumed = harness.coordinator.consumeSuggestion({
      scope: "household",
      scopeId: "home-2",
      suggestionId: item.id,
      userId: "u123",
    });

    expect(Boolean(consumed.consumedAt)).toBe(true);
    expect(consumed.consumedBy).toBe("u123");

    const pending = harness.coordinator.listSuggestions({
      scope: "household",
      scopeId: "home-2",
      includeConsumed: false,
    });

    expect(pending.some((x) => x.id === item.id)).toBe(false);
  });

  it("generates report summaries with assigned/unassigned counts", () => {
    harness.coordinator.ingest(
      {
        type: "inventoryAdded",
        payload: { sku: "tomato", name: "Tomato", qty: 10 },
      },
      {
        sourceModule: "tests.realtime",
        scope: "household",
        scopeId: "home-3",
      }
    );

    const [first, second] = harness.coordinator.listSuggestions({
      scope: "household",
      scopeId: "home-3",
    });

    harness.coordinator.assignSuggestion({
      scope: "household",
      scopeId: "home-3",
      suggestionId: first.id,
      assignedToUserId: "u987",
      assignedRole: null,
      assignedBy: "lead-2",
    });

    harness.coordinator.consumeSuggestion({
      scope: "household",
      scopeId: "home-3",
      suggestionId: second.id,
      userId: "u987",
    });

    harness.coordinator.generateReports();
    const report = harness.coordinator.getLatestReport({
      scope: "household",
      scopeId: "home-3",
    });

    expect(report).toBeTruthy();
    expect(report.summary.pendingSuggestions).toBe(1);
    expect(report.summary.completedSuggestions).toBe(1);
    expect(report.summary.assignedPending).toBe(1);
    expect(report.summary.unassignedPending).toBe(0);
    expect(report.signalBreakdown.inventoryAdded).toBeGreaterThanOrEqual(1);
  });

  it("rejects malformed signals and tracks invalid ingest count", () => {
    const out = harness.coordinator.ingest(null, {
      sourceModule: "tests.realtime",
      scope: "household",
      scopeId: "home-invalid",
    });

    expect(out.ok).toBe(false);
    expect(out.error).toBe("invalid_event");

    const state = harness.coordinator.getState();
    expect(state.ingest.droppedInvalid).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates repeated eventId values", () => {
    const first = harness.coordinator.ingest(
      {
        eventId: "evt-dup-1",
        correlationId: "corr-dup-1",
        type: "inventoryShortage",
        event: "inventory:shortage",
        payload: { sku: "salt", qty: 1 },
      },
      {
        sourceModule: "tests.realtime",
        scope: "household",
        scopeId: "home-dup",
      }
    );

    const second = harness.coordinator.ingest(
      {
        eventId: "evt-dup-1",
        correlationId: "corr-dup-2",
        type: "inventoryShortage",
        event: "inventory:shortage",
        payload: { sku: "salt", qty: 1 },
      },
      {
        sourceModule: "tests.realtime",
        scope: "household",
        scopeId: "home-dup",
      }
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toBe("duplicate_event");

    const state = harness.coordinator.getState();
    expect(state.ingest.accepted).toBeGreaterThanOrEqual(1);
    expect(state.ingest.droppedDuplicate).toBeGreaterThanOrEqual(1);
  });

  it("accepts same payload when eventId differs", () => {
    const first = harness.coordinator.ingest(
      {
        eventId: "evt-unique-1",
        correlationId: "corr-unique",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "beans", qty: 3 },
      },
      {
        sourceModule: "tests.realtime",
        scope: "household",
        scopeId: "home-unique",
      }
    );

    const second = harness.coordinator.ingest(
      {
        eventId: "evt-unique-2",
        correlationId: "corr-unique",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "beans", qty: 3 },
      },
      {
        sourceModule: "tests.realtime",
        scope: "household",
        scopeId: "home-unique",
      }
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("accepts canonical envelope and preserves eventId/correlationId", () => {
    const out = harness.coordinator.ingest(
      {
        eventId: "evt-preserve-1",
        correlationId: "corr-preserve-1",
        causationId: "cause-preserve-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        version: "v1",
        actorId: "u-preserve",
        sourceModule: "tests.realtime",
        payload: { sku: "oats", qty: 4 },
      },
      {
        sourceModule: "tests.realtime",
      }
    );

    expect(out.ok).toBe(true);
    expect(out.signal.eventId).toBe("evt-preserve-1");
    expect(out.signal.correlationId).toBe("corr-preserve-1");
    expect(out.signal.causationId).toBe("cause-preserve-1");
  });

  it("normalizes missing scope to household/default", () => {
    const out = harness.coordinator.ingest(
      {
        eventId: "evt-scope-default-1",
        correlationId: "corr-scope-default-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "lentils", qty: 2 },
      },
      {
        sourceModule: "tests.realtime",
      }
    );

    expect(out.ok).toBe(true);
    expect(out.signal.scope).toBe("household");
    expect(out.signal.scopeId).toBe("default");

    const householdItems = harness.coordinator.listSuggestions({
      scope: "household",
      scopeId: "default",
    });
    expect(householdItems.length).toBeGreaterThan(0);
  });

  it("routes family-scoped signal to family queue only", () => {
    const out = harness.coordinator.ingest(
      {
        eventId: "evt-family-1",
        correlationId: "corr-family-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        scope: "family",
        scopeId: "fam-1",
        payload: { sku: "apples", qty: 3, familyId: "fam-1" },
      },
      {
        sourceModule: "tests.realtime",
      }
    );

    expect(out.ok).toBe(true);

    const familyItems = harness.coordinator.listSuggestions({
      scope: "family",
      scopeId: "fam-1",
    });
    const householdItems = harness.coordinator.listSuggestions({
      scope: "household",
      scopeId: "fam-1",
    });

    expect(familyItems.length).toBeGreaterThan(0);
    expect(householdItems.length).toBe(0);
  });

  it("records validation failure reason in audit history", () => {
    const out = harness.coordinator.ingest(null, {
      sourceModule: "tests.realtime",
    });

    expect(out.ok).toBe(false);
    const audit = harness.coordinator.getAuditHistory({ limit: 20 });
    const invalidAudit = audit.find((a) => a.type === "signal.invalid");
    expect(invalidAudit).toBeTruthy();
    expect(invalidAudit?.data?.reason).toBe("signal_not_object");
  });

  it("tracks exact droppedInvalid and droppedDuplicate totals", () => {
    const invalid = harness.coordinator.ingest(null, {
      sourceModule: "tests.realtime",
    });
    expect(invalid.ok).toBe(false);

    const first = harness.coordinator.ingest(
      {
        eventId: "evt-counter-1",
        correlationId: "corr-counter-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "rice", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-counter" }
    );
    const duplicate = harness.coordinator.ingest(
      {
        eventId: "evt-counter-1",
        correlationId: "corr-counter-2",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "rice", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-counter" }
    );

    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(false);

    const state = harness.coordinator.getState();
    expect(state.ingest.droppedInvalid).toBe(1);
    expect(state.ingest.droppedDuplicate).toBe(1);
    expect(state.ingest.accepted).toBe(1);
  });

  it("rejects missing strict envelope fields when strict mode is enabled", () => {
    const prevStrict = process.env.SSA_REALTIME_STRICT_ENVELOPE;
    process.env.SSA_REALTIME_STRICT_ENVELOPE = "true";
    delete require.cache[coordinatorModulePath];
    const { createCoordinator: createStrictCoordinator } = require(coordinatorModulePath);

    const strictHarness = makeHarness(createStrictCoordinator);
    const out = strictHarness.coordinator.ingest(
      {
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "oil", qty: 1 },
      },
      { sourceModule: "tests.realtime" }
    );

    expect(out.ok).toBe(false);
    expect(out.error).toBe("invalid_event");
    expect(out.reason).toBe("missing_event_id");

    if (typeof prevStrict === "undefined") delete process.env.SSA_REALTIME_STRICT_ENVELOPE;
    else process.env.SSA_REALTIME_STRICT_ENVELOPE = prevStrict;
    delete require.cache[coordinatorModulePath];
    require(coordinatorModulePath);
  });

  it("uses in-memory event log fallback when fallback flag is enabled", () => {
    const memoryStore = createInMemoryEventLogStore();
    const isolatedCreateCoordinator = withEnv(
      {
        SSA_REALTIME_APPEND_LOG_ENABLED: "true",
        SSA_REALTIME_EVENTLOG_FALLBACK_MEMORY: "true",
      },
      () =>
        loadIsolatedCoordinator({
          eventStoreExports: {
            createFileEventLogStore() {
              throw new Error("disk_unavailable");
            },
            createInMemoryEventLogStore() {
              return memoryStore;
            },
          },
        })
    );

    const h = makeHarness(isolatedCreateCoordinator);
    expect(h.coordinator.shouldAppendSignals()).toBe(true);

    const appended = h.coordinator.appendSignal(
      {
        eventId: "evt-fallback-on-1",
        correlationId: "corr-fallback-on-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "fallback-on", qty: 1 },
      },
      { sourceModule: "tests.realtime" }
    );

    expect(appended.ok).toBe(true);
    expect(memoryStore.readAll().length).toBeGreaterThanOrEqual(1);
  });

  it("disables append path when fallback flag is disabled and file store init fails", () => {
    const isolatedCreateCoordinator = withEnv(
      {
        SSA_REALTIME_APPEND_LOG_ENABLED: "true",
        SSA_REALTIME_EVENTLOG_FALLBACK_MEMORY: "false",
      },
      () =>
        loadIsolatedCoordinator({
          eventStoreExports: {
            createFileEventLogStore() {
              throw new Error("disk_unavailable");
            },
            createInMemoryEventLogStore() {
              return createInMemoryEventLogStore();
            },
          },
        })
    );

    const h = makeHarness(isolatedCreateCoordinator);
    expect(h.coordinator.shouldAppendSignals()).toBe(false);

    const appended = h.coordinator.appendSignal(
      {
        eventId: "evt-fallback-off-1",
        correlationId: "corr-fallback-off-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "fallback-off", qty: 1 },
      },
      { sourceModule: "tests.realtime" }
    );

    expect(appended.ok).toBe(true);
    expect(appended.skipped).toBe(true);
  });

  it("honors graph max retries tuning flag for both low and high retry settings", async () => {
    vi.useFakeTimers();
    const storeLow = createInMemoryEventLogStore();
    const lowRetryCoordinatorFactory = withEnv(
      {
        SSA_REALTIME_APPEND_LOG_ENABLED: "true",
        SSA_GRAPH_PROJECTION_ENABLED: "true",
        SSA_GRAPH_MAX_RETRIES: "0",
        SSA_GRAPH_RETRY_DELAY_MS: "1",
        SSA_NEO4J_AVAILABLE: "false",
      },
      () =>
        loadIsolatedCoordinator({
          eventStoreExports: {
            createFileEventLogStore() {
              return storeLow;
            },
            createInMemoryEventLogStore,
          },
        })
    );
    const low = makeHarness(lowRetryCoordinatorFactory);
    low.coordinator.ingest(
      {
        eventId: "evt-retry-low-1",
        correlationId: "corr-retry-low-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "retry-low", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-retry-low" }
    );
    await vi.runAllTimersAsync();
    const lowDiag = low.coordinator.getDiagnostics({ scope: "household", scopeId: "home-retry-low" });
    expect(lowDiag.graphProjection?.state?.retries).toBe(0);
    expect(lowDiag.graphProjection?.state?.deadLettered).toBeGreaterThanOrEqual(1);

    const storeHigh = createInMemoryEventLogStore();
    const highRetryCoordinatorFactory = withEnv(
      {
        SSA_REALTIME_APPEND_LOG_ENABLED: "true",
        SSA_GRAPH_PROJECTION_ENABLED: "true",
        SSA_GRAPH_MAX_RETRIES: "2",
        SSA_GRAPH_RETRY_DELAY_MS: "1",
        SSA_NEO4J_AVAILABLE: "false",
      },
      () =>
        loadIsolatedCoordinator({
          eventStoreExports: {
            createFileEventLogStore() {
              return storeHigh;
            },
            createInMemoryEventLogStore,
          },
        })
    );
    const high = makeHarness(highRetryCoordinatorFactory);
    high.coordinator.ingest(
      {
        eventId: "evt-retry-high-1",
        correlationId: "corr-retry-high-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "retry-high", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-retry-high" }
    );
    await vi.runAllTimersAsync();
    const highDiag = high.coordinator.getDiagnostics({ scope: "household", scopeId: "home-retry-high" });
    expect(highDiag.graphProjection?.state?.retries).toBeGreaterThanOrEqual(1);
  });

  it("replay rebuilds suggestion queue from persisted events in order", () => {
    const store = createInMemoryEventLogStore();
    const h1 = makeHarnessWithStore(store);

    h1.coordinator.ingest(
      {
        eventId: "evt-replay-order-1",
        correlationId: "corr-replay-order-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "rice", qty: 10 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-r1" }
    );

    h1.coordinator.ingest(
      {
        eventId: "evt-replay-order-2",
        correlationId: "corr-replay-order-2",
        type: "inventoryShortage",
        event: "inventory:shortage",
        payload: { sku: "eggs", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-r1" }
    );

    const expected = h1.coordinator
      .listSuggestions({ scope: "household", scopeId: "home-r1", includeConsumed: true })
      .map((x) => `${x.target}:${x.action}`);

    const h2 = makeHarnessWithStore(store);
    const replay = h2.coordinator.replayFromEventLog();
    expect(replay.ok).toBe(true);

    const actual = h2.coordinator
      .listSuggestions({ scope: "household", scopeId: "home-r1", includeConsumed: true })
      .map((x) => `${x.target}:${x.action}`);

    expect(actual).toEqual(expected);
  });

  it("replay is idempotent when same event batch is applied twice", () => {
    const store = createInMemoryEventLogStore();
    const h1 = makeHarnessWithStore(store);

    h1.coordinator.ingest(
      {
        eventId: "evt-replay-idem-1",
        correlationId: "corr-replay-idem-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "beans", qty: 5 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-r2" }
    );

    const h2 = makeHarnessWithStore(store);
    const firstReplay = h2.coordinator.replayFromEventLog();
    const firstCount = h2.coordinator.listSuggestions({ scope: "household", scopeId: "home-r2" }).length;
    const secondReplay = h2.coordinator.replayFromEventLog();
    const secondCount = h2.coordinator.listSuggestions({ scope: "household", scopeId: "home-r2" }).length;

    expect(firstReplay.replayed).toBeGreaterThan(0);
    expect(secondReplay.replayed).toBe(0);
    expect(secondCount).toBe(firstCount);
  });

  it("replays from event log on boot when replayOnBootEnabled is true", () => {
    const store = createInMemoryEventLogStore();
    store.append({
      kind: "signal.ingest",
      payload: {
        signal: {
          eventId: "evt-boot-replay-1",
          correlationId: "corr-boot-replay-1",
          type: "inventoryAdded",
          event: "inventory:delta",
          payload: { sku: "boot-rice", qty: 2 },
        },
        context: {
          sourceModule: "tests.realtime",
          scope: "household",
          scopeId: "home-boot-replay",
        },
      },
    });

    const h = makeHarness((args) =>
      createCoordinator({
        ...args,
        eventLogStore: store,
        flags: {
          appendLogEnabled: true,
          replayOnBootEnabled: true,
        },
      })
    );

    const beforeStart = h.coordinator.listSuggestions({
      scope: "household",
      scopeId: "home-boot-replay",
    });
    expect(beforeStart.length).toBe(0);

    h.coordinator.start();
    const afterStart = h.coordinator.listSuggestions({
      scope: "household",
      scopeId: "home-boot-replay",
    });

    expect(afterStart.length).toBeGreaterThan(0);
    h.coordinator.stop();
  });

  it("replay preserves consumed and assigned suggestion state transitions", () => {
    const store = createInMemoryEventLogStore();
    const h1 = makeHarnessWithStore(store);

    h1.coordinator.ingest(
      {
        eventId: "evt-replay-state-1",
        correlationId: "corr-replay-state-1",
        type: "inventoryShortage",
        event: "inventory:shortage",
        payload: { sku: "milk", qty: 0 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-r3" }
    );

    const [a, b] = h1.coordinator.listSuggestions({
      scope: "household",
      scopeId: "home-r3",
      includeConsumed: true,
    });

    h1.coordinator.assignSuggestion({
      scope: "household",
      scopeId: "home-r3",
      suggestionId: a.id,
      assignedToUserId: "u-replay",
      assignedRole: "cook",
      assignedBy: "lead-replay",
    });
    h1.coordinator.consumeSuggestion({
      scope: "household",
      scopeId: "home-r3",
      suggestionId: b.id,
      userId: "u-replay",
    });

    const h2 = makeHarnessWithStore(store);
    h2.coordinator.replayFromEventLog();
    const items = h2.coordinator.listSuggestions({
      scope: "household",
      scopeId: "home-r3",
      includeConsumed: true,
    });

    expect(items.some((x) => x.assignedToUserId === "u-replay")).toBe(true);
    expect(items.some((x) => Boolean(x.consumedAt))).toBe(true);
  });

  it("replay restores latest report summary fields correctly", () => {
    const store = createInMemoryEventLogStore();
    const h1 = makeHarnessWithStore(store);

    h1.coordinator.ingest(
      {
        eventId: "evt-replay-report-1",
        correlationId: "corr-replay-report-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "flour", qty: 8 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-r4" }
    );
    h1.coordinator.generateReports();

    const h2 = makeHarnessWithStore(store);
    h2.coordinator.replayFromEventLog();
    h2.coordinator.generateReports();
    const report = h2.coordinator.getLatestReport({ scope: "household", scopeId: "home-r4" });

    expect(report).toBeTruthy();
    expect(report.summary.signals24h).toBeGreaterThanOrEqual(1);
    expect(report.summary.pendingSuggestions).toBeGreaterThanOrEqual(1);
  });

  it("out-of-order replay produces deterministic priority ordering", () => {
    const store = createInMemoryEventLogStore();
    store.append({
      kind: "signal.ingest",
      payload: {
        signal: {
          eventId: "evt-order-low-1",
          correlationId: "corr-order-low-1",
          type: "inventoryAdded",
          event: "inventory:delta",
          payload: { sku: "salt", qty: 2 },
        },
        context: { sourceModule: "tests.realtime", scope: "household", scopeId: "home-r5" },
      },
    });
    store.append({
      kind: "signal.ingest",
      payload: {
        signal: {
          eventId: "evt-order-high-1",
          correlationId: "corr-order-high-1",
          type: "inventoryShortage",
          event: "inventory:shortage",
          payload: { sku: "eggs", qty: 0 },
        },
        context: { sourceModule: "tests.realtime", scope: "household", scopeId: "home-r5" },
      },
    });

    const h = makeHarnessWithStore(store);
    h.coordinator.replayFromEventLog();
    const list = h.coordinator.listSuggestions({ scope: "household", scopeId: "home-r5" });

    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(Number(list[0].priorityScore)).toBeGreaterThanOrEqual(Number(list[list.length - 1].priorityScore));
  });

  it("expired suggestions remain pruned after replay", () => {
    vi.useFakeTimers();
    const prevTtl = process.env.SSA_SUGGESTION_TTL_MS;
    process.env.SSA_SUGGESTION_TTL_MS = "5";
    delete require.cache[coordinatorModulePath];
    const { createCoordinator: createShortTtlCoordinator } = require(coordinatorModulePath);
    const store = createInMemoryEventLogStore();

    const shortHarness = makeHarness((args) =>
      createShortTtlCoordinator({
        ...args,
        eventLogStore: store,
        flags: { appendLogEnabled: true, replayOnBootEnabled: false },
      })
    );

    shortHarness.coordinator.ingest(
      {
        eventId: "evt-expire-1",
        correlationId: "corr-expire-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "spinach", qty: 2 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-r6" }
    );

    const replayHarness = makeHarness((args) =>
      createShortTtlCoordinator({
        ...args,
        eventLogStore: store,
        flags: { appendLogEnabled: true, replayOnBootEnabled: false },
      })
    );
    replayHarness.coordinator.replayFromEventLog();
    vi.advanceTimersByTime(20);
    const list = replayHarness.coordinator.listSuggestions({ scope: "household", scopeId: "home-r6" });
    expect(list.length).toBe(0);

    if (typeof prevTtl === "undefined") delete process.env.SSA_SUGGESTION_TTL_MS;
    else process.env.SSA_SUGGESTION_TTL_MS = prevTtl;
    delete require.cache[coordinatorModulePath];
    require(coordinatorModulePath);
    vi.useRealTimers();
  });

  it("signal history cap is enforced during replay", () => {
    const store = createInMemoryEventLogStore();
    for (let i = 0; i < 5010; i += 1) {
      store.append({
        kind: "signal.ingest",
        payload: {
          signal: {
            eventId: `evt-cap-${i}`,
            correlationId: `corr-cap-${i}`,
            type: "inventoryAdded",
            event: "inventory:delta",
            payload: { sku: "grain", qty: 1 },
          },
          context: { sourceModule: "tests.realtime", scope: "household", scopeId: "home-cap" },
        },
      });
    }

    const h = makeHarnessWithStore(store);
    h.coordinator.replayFromEventLog();
    const history = h.coordinator.getSignalHistory({ limit: 6000 });
    expect(history.length).toBeLessThanOrEqual(5000);
  }, 15000);

  it("projector updates queueDepth metric after each ingest", () => {
    harness.coordinator.ingest(
      {
        eventId: "evt-depth-1",
        correlationId: "corr-depth-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "depth-a", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-depth" }
    );

    const d1 = harness.coordinator.getDiagnostics({ scope: "household", scopeId: "home-depth" });
    expect(d1.projection.readiness[0].queueDepth).toBeGreaterThan(0);

    harness.coordinator.ingest(
      {
        eventId: "evt-depth-2",
        correlationId: "corr-depth-2",
        type: "inventoryShortage",
        event: "inventory:shortage",
        payload: { sku: "depth-b", qty: 0 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-depth" }
    );

    const d2 = harness.coordinator.getDiagnostics({ scope: "household", scopeId: "home-depth" });
    expect(d2.projection.readiness[0].queueDepth).toBeGreaterThanOrEqual(d1.projection.readiness[0].queueDepth);
  });

  it("projector increments highPriorityPending for priority >= 80", () => {
    harness.coordinator.ingest(
      {
        eventId: "evt-high-1",
        correlationId: "corr-high-1",
        type: "inventoryShortage",
        event: "inventory:shortage",
        payload: { sku: "high-priority", qty: 0 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-high" }
    );

    const diag = harness.coordinator.getDiagnostics({ scope: "household", scopeId: "home-high" });
    expect(diag.projection.readiness[0].highPriorityPending).toBeGreaterThanOrEqual(1);
  });

  it("assignSuggestion decreases unassignedPending and increases assignedPending", () => {
    harness.coordinator.ingest(
      {
        eventId: "evt-assign-1",
        correlationId: "corr-assign-1",
        type: "inventoryShortage",
        event: "inventory:shortage",
        payload: { sku: "assign-me", qty: 0 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-assign" }
    );

    const before = harness.coordinator.getDiagnostics({ scope: "household", scopeId: "home-assign" });
    const [item] = harness.coordinator.listSuggestions({ scope: "household", scopeId: "home-assign" });
    harness.coordinator.assignSuggestion({
      scope: "household",
      scopeId: "home-assign",
      suggestionId: item.id,
      assignedToUserId: "u-assign",
      assignedRole: "cook",
      assignedBy: "lead-assign",
    });

    const after = harness.coordinator.getDiagnostics({ scope: "household", scopeId: "home-assign" });
    expect(after.projection.readiness[0].assignedPending).toBeGreaterThan(before.projection.readiness[0].assignedPending);
    expect(after.projection.readiness[0].unassignedPending).toBeLessThan(before.projection.readiness[0].unassignedPending);
  });

  it("consumeSuggestion decreases pendingSuggestions and increases completedSuggestions", () => {
    harness.coordinator.ingest(
      {
        eventId: "evt-consume-1",
        correlationId: "corr-consume-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "consume-me", qty: 3 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-consume" }
    );

    const [item] = harness.coordinator.listSuggestions({ scope: "household", scopeId: "home-consume" });
    const before = harness.coordinator.getDiagnostics({ scope: "household", scopeId: "home-consume" });
    harness.coordinator.consumeSuggestion({
      scope: "household",
      scopeId: "home-consume",
      suggestionId: item.id,
      userId: "u-consume",
    });
    const after = harness.coordinator.getDiagnostics({ scope: "household", scopeId: "home-consume" });

    expect(after.projection.readiness[0].pendingSuggestions).toBeLessThan(before.projection.readiness[0].pendingSuggestions);
    expect(after.projection.readiness[0].completedSuggestions).toBeGreaterThan(before.projection.readiness[0].completedSuggestions);
  });

  it("report generation includes signals24h and signalBreakdown accuracy", () => {
    harness.coordinator.ingest(
      {
        eventId: "evt-report-acc-1",
        correlationId: "corr-report-acc-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "r-a", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-report-acc" }
    );
    harness.coordinator.ingest(
      {
        eventId: "evt-report-acc-2",
        correlationId: "corr-report-acc-2",
        type: "inventoryShortage",
        event: "inventory:shortage",
        payload: { sku: "r-b", qty: 0 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-report-acc" }
    );

    harness.coordinator.generateReports();
    const report = harness.coordinator.getLatestReport({ scope: "household", scopeId: "home-report-acc" });
    expect(report.summary.signals24h).toBeGreaterThanOrEqual(2);
    expect((report.signalBreakdown.inventoryAdded || 0) + (report.signalBreakdown.inventoryShortage || 0)).toBeGreaterThanOrEqual(2);
  });

  it("latency metric recorded for ingest-to-queue-update path", () => {
    harness.coordinator.ingest(
      {
        eventId: "evt-lat-1",
        correlationId: "corr-lat-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "lat", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-lat" }
    );

    const diag = harness.coordinator.getDiagnostics({ scope: "household", scopeId: "home-lat" });
    expect(diag.projection.latency.count).toBeGreaterThanOrEqual(1);
    expect(diag.projection.latency.last).toBeGreaterThanOrEqual(0);
  });

  it("projector handles burst ingest without duplicate queue items", () => {
    for (let i = 0; i < 20; i += 1) {
      harness.coordinator.ingest(
        {
          eventId: `evt-burst-${i}`,
          correlationId: `corr-burst-${i}`,
          type: "inventoryShortage",
          event: "inventory:shortage",
          payload: { sku: "burst-eggs", qty: i % 2 },
        },
        { sourceModule: "tests.realtime", scope: "household", scopeId: "home-burst" }
      );
    }

    const items = harness.coordinator.listSuggestions({ scope: "household", scopeId: "home-burst" });
    const ids = new Set(items.map((x) => x.id));
    expect(ids.size).toBe(items.length);
  });

  it("keeps realtime ingest working when graph projector is unavailable", async () => {
    vi.useFakeTimers();
    const store = createInMemoryEventLogStore();
    const graph = createGraphProjector({
      enabled: true,
      maxRetries: 1,
      retryDelayMs: 1,
      processEvent: async () => {
        throw new Error("neo4j_down");
      },
    });

    const h = makeHarness((args) =>
      createCoordinator({
        ...args,
        eventLogStore: store,
        graphProjector: graph,
        flags: {
          appendLogEnabled: true,
          replayOnBootEnabled: false,
          graphProjectionEnabled: true,
        },
      })
    );

    const out = h.coordinator.ingest(
      {
        eventId: "evt-graph-down-1",
        correlationId: "corr-graph-down-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "graph-safe", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-graph-down" }
    );

    expect(out.ok).toBe(true);
    await vi.runAllTimersAsync();
    const diag = h.coordinator.getDiagnostics({ scope: "household", scopeId: "home-graph-down" });
    expect(diag.graphProjection?.state?.failed).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it("graph projector retries and increments dead-letter counter", async () => {
    vi.useFakeTimers();
    const store = createInMemoryEventLogStore();
    const graph = createGraphProjector({
      enabled: true,
      maxRetries: 1,
      retryDelayMs: 1,
      processEvent: async () => {
        throw new Error("graph_fail");
      },
    });

    const h = makeHarness((args) =>
      createCoordinator({
        ...args,
        eventLogStore: store,
        graphProjector: graph,
        flags: {
          appendLogEnabled: true,
          replayOnBootEnabled: false,
          graphProjectionEnabled: true,
        },
      })
    );

    h.coordinator.ingest(
      {
        eventId: "evt-graph-retry-1",
        correlationId: "corr-graph-retry-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "graph-retry", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-graph-retry" }
    );

    await vi.runAllTimersAsync();
    const diag = h.coordinator.getDiagnostics({ scope: "household", scopeId: "home-graph-retry" });
    expect(diag.graphProjection?.state?.retries).toBeGreaterThanOrEqual(1);
    expect(diag.graphProjection?.state?.deadLettered).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it("adds optional graph field to report without mutating base summary", async () => {
    vi.useFakeTimers();
    const store = createInMemoryEventLogStore();
    const graph = createGraphProjector({
      enabled: true,
      processEvent: async () => ({ ok: true }),
      retryDelayMs: 1,
    });

    const h = makeHarness((args) =>
      createCoordinator({
        ...args,
        eventLogStore: store,
        graphProjector: graph,
        flags: {
          appendLogEnabled: true,
          replayOnBootEnabled: false,
          graphProjectionEnabled: true,
        },
      })
    );

    h.coordinator.ingest(
      {
        eventId: "evt-graph-report-1",
        correlationId: "corr-graph-report-1",
        type: "inventoryShortage",
        event: "inventory:shortage",
        payload: { sku: "graph-report", qty: 0 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-graph-report" }
    );

    await vi.runAllTimersAsync();
    h.coordinator.generateReports();
    const report = h.coordinator.getLatestReport({ scope: "household", scopeId: "home-graph-report" });

    expect(report.summary).toBeTruthy();
    expect(typeof report.summary.pendingSuggestions).toBe("number");
    expect(report.graph || null).toBeTruthy();
    expect(typeof report.graph.projectedEvents).toBe("number");
    vi.useRealTimers();
  });

  it("coordinator behavior is unchanged when graph projector is disabled", () => {
    const h = makeHarness((args) =>
      createCoordinator({
        ...args,
        flags: {
          appendLogEnabled: false,
          replayOnBootEnabled: false,
          graphProjectionEnabled: false,
        },
      })
    );

    const out = h.coordinator.ingest(
      {
        eventId: "evt-graph-off-1",
        correlationId: "corr-graph-off-1",
        type: "inventoryAdded",
        event: "inventory:delta",
        payload: { sku: "graph-off", qty: 1 },
      },
      { sourceModule: "tests.realtime", scope: "household", scopeId: "home-graph-off" }
    );

    expect(out.ok).toBe(true);
    h.coordinator.generateReports();
    const report = h.coordinator.getLatestReport({ scope: "household", scopeId: "home-graph-off" });
    expect(report).toBeTruthy();
    expect(report.graph || null).toBe(null);
  });
});
