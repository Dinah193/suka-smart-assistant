// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { eventBus } from "../src/services/events/eventBus";
import {
  initializeStorehousePlannerIngestors,
  useStorehousePlannerStore,
} from "../src/store/StorehousePlannerStore.js";

describe("planner -> storehouse ingestors", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // no-op
    }

    useStorehousePlannerStore.setState({
      storehouseNeeds: [],
      preservationQueue: [],
      plannerSignals: {
        lastReadiness: null,
        lastReadinessAt: null,
      },
    });

    initializeStorehousePlannerIngestors();
  });

  it("consumes planner.estimateInputs.updated and upserts garden/feed/preservation", () => {
    eventBus.emit("planner.estimateInputs.updated", {
      source: "test",
      estimateInputs: {
        contractVersion: "planner.estimate-inputs.v1",
        garden: {
          produceDemand: [{ name: "Tomatoes", qty: 8, unit: "lb" }],
        },
        animal: {
          proteinDemandByType: { poultry: 6 },
        },
        preservation: {
          tasks: [{ id: "pres-1", produce: "tomato", method: "can", quantity: 2 }],
        },
      },
    });

    const s = useStorehousePlannerStore.getState();
    const needs = Array.isArray(s.storehouseNeeds) ? s.storehouseNeeds : [];

    expect(needs.some((n) => n.category === "garden-input" && n.name === "Tomatoes")).toBe(
      true
    );
    expect(needs.some((n) => n.category === "animal-feed" && /feed ration/i.test(n.name))).toBe(
      true
    );
    expect(Array.isArray(s.preservationQueue)).toBe(true);
    expect(s.preservationQueue.length).toBeGreaterThan(0);
  });

  it("consumes planner.readiness.updated and escalates planner-related priorities", () => {
    useStorehousePlannerStore.getState().upsertNeeds([
      {
        id: "need-1",
        name: "Tomatoes",
        qty: 4,
        unit: "lb",
        category: "garden-input",
        priority: 3,
        source: "planner-estimate",
      },
    ]);

    eventBus.emit("planner.readiness.updated", {
      source: "test",
      readiness: {
        score: 20,
        status: "Needs prep",
      },
    });

    const s = useStorehousePlannerStore.getState();
    expect(s.plannerSignals?.lastReadiness?.score).toBe(20);

    const tomatoNeed = (s.storehouseNeeds || []).find((n) => n.name === "Tomatoes");
    expect(tomatoNeed).toBeTruthy();
    expect(tomatoNeed.priority).toBe(1);
    expect(String(tomatoNeed.notes || "")).toContain("Priority escalated");
  });
});
