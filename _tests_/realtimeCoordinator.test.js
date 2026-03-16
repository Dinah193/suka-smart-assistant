import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCoordinator } = require("../src/server/services/realtimeCoordinator.js");

function makeHarness() {
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

  const coordinator = createCoordinator({ eventBus, namespaceEmit });
  return { eventBus, namespaceEmit, emits, coordinator };
}

describe("realtimeCoordinator", () => {
  let harness;

  beforeEach(() => {
    harness = makeHarness();
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
});
