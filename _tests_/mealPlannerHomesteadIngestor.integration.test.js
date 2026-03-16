// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { eventBus } from "../src/services/events/eventBus";
import { emitHomesteadMealPlanGenerated } from "../src/services/planners/mealPlannerBridge.js";
import {
  useHomesteadPlannerStore,
  initializeHomesteadMealPlanIngestor,
} from "../src/store/homesteadPlannerStore.js";

describe("meal planner homestead ingestor e2e", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // no-op
    }
    useHomesteadPlannerStore.getState().reset();
    initializeHomesteadMealPlanIngestor();
  });

  it("consumes generated meal plan contract via event bus and stores ingested payload", () => {
    const normalizedPlan = {
      title: "Homestead Week",
      summary: "Produce-forward plan",
      meals: [{ name: "Breakfast" }, { name: "Dinner" }],
      shoppingList: [{ name: "Tomatoes", qty: 6, unit: "lb" }],
      prepTasks: [{ title: "Can tomatoes" }],
      budget: { estimate: 75 },
      macros: { calories: 2100 },
    };

    const out = emitHomesteadMealPlanGenerated({
      normalizedPlan,
      meta: {
        templateId: "homestead-weekly",
        cuisines: ["Southern"],
        presets: ["batch-cook"],
        duration: "7d",
        saveAsDraft: false,
      },
      eventBusEmit: eventBus.emit.bind(eventBus),
    });

    expect(out.ok).toBe(true);

    const s = useHomesteadPlannerStore.getState();
    expect(s.ingest.lastMealPlanContract).toBeTruthy();
    expect(s.ingest.lastMealPlanContract.contractVersion).toBe(
      "homestead.mealplan.v1"
    );
    expect(s.ingest.lastMealPlanContract.plan.mealCount).toBe(2);
    expect(s.ingest.lastMealPlanContract.plan.shoppingCount).toBe(1);
    expect(s.ingest.lastIngestedAt).toBeTruthy();

    expect(s.ingest.lastEstimateInputs).toBeTruthy();
    expect(s.ingest.lastEstimateInputs.contractVersion).toBe(
      "planner.estimate-inputs.v1"
    );
    expect(s.ingest.lastEstimateInputs.animal.mealCount).toBe(2);
  });
});
