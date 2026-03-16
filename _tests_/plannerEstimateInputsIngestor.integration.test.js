// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { eventBus } from "../src/services/events/eventBus";
import {
  useHomesteadPlannerStore,
  initializePlannerEstimateInputsIngestor,
} from "../src/store/homesteadPlannerStore.js";

describe("planner estimate-inputs consumer", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // no-op
    }
    useHomesteadPlannerStore.getState().reset();
    initializePlannerEstimateInputsIngestor();
  });

  it("consumes planner.estimateInputs.updated and stores estimate inputs + normalized plan", () => {
    const estimateInputs = {
      contractVersion: "planner.estimate-inputs.v1",
      source: "meal-planner",
      sessionId: "session-123",
      horizonMonths: 3,
      animal: {
        mealCount: 4,
        proteinDemandByType: { poultry: 6, fish: 2 },
      },
      garden: {
        mealCount: 4,
        produceDemand: [{ name: "Tomatoes", qty: 8, unit: "lb" }],
      },
      preservation: {
        prepTaskCount: 1,
        tasks: [{ id: "pres-1", produce: "tomato", method: "can", quantity: 2 }],
      },
    };

    const normalizedPlan = {
      title: "Readiness Plan",
      summary: "Bridge payload",
      meals: [{ title: "Soup Night" }],
      shoppingList: [{ name: "Tomatoes", qty: 8, unit: "lb" }],
      prepTasks: [{ title: "Can tomatoes" }],
    };

    eventBus.emit("planner.estimateInputs.updated", {
      source: "test",
      estimateInputs,
      normalizedPlan,
    });

    const s = useHomesteadPlannerStore.getState();
    expect(s.ingest.lastEstimateInputs).toBeTruthy();
    expect(s.ingest.lastEstimateInputs.contractVersion).toBe(
      "planner.estimate-inputs.v1"
    );
    expect(s.ingest.lastEstimateInputs.animal.mealCount).toBe(4);

    expect(s.ingest.lastGeneratedPlan).toBeTruthy();
    expect(s.ingest.lastGeneratedPlan.title).toBe("Readiness Plan");
    expect(Array.isArray(s.ingest.lastGeneratedPlan.shoppingList)).toBe(true);
    expect(s.ingest.lastIngestedAt).toBeTruthy();
  });
});
