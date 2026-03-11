import { describe, it, expect, vi } from "vitest";
import {
  forwardProvisionToStorehousePlanner,
  emitHomesteadMealPlanGenerated,
  emitPlannerGapsUpdated,
} from "../src/services/planners/mealPlannerBridge.js";

describe("meal planner direct bridge", () => {
  it("forwards shopping payload to storehouse planner input and emits ingest contract", () => {
    const emit = vi.fn();
    const upsertNeeds = vi.fn();

    const payload = {
      sessionId: "session-1",
      seasonContext: { seasonKey: "spring" },
      items: [
        {
          name: "Tomatoes",
          unit: "lb",
          neededQty: 6,
          onHandQty: 2,
          shortfallQty: 4,
          recipeIds: ["r1"],
          recipeTitles: ["Pasta Night"],
        },
      ],
    };

    const result = forwardProvisionToStorehousePlanner({
      payload,
      eventBusEmit: emit,
      upsertNeeds,
    });

    expect(result.ok).toBe(true);
    expect(result.forwardedCount).toBe(1);
    expect(upsertNeeds).toHaveBeenCalledTimes(1);
    expect(upsertNeeds.mock.calls[0][0][0]).toMatchObject({
      name: "Tomatoes",
      qty: 4,
      unit: "lb",
      category: "meal-planner",
      source: "meal-planner",
    });

    expect(emit).toHaveBeenCalledWith(
      "storehouse.planner.ingest.requested",
      expect.objectContaining({
        contractVersion: "storehouse.ingest.v1",
        source: "meal-planner",
        sessionId: "session-1",
        count: 1,
      })
    );
    expect(emit).toHaveBeenCalledWith(
      "storehouse.planner.ingest.completed",
      expect.objectContaining({
        contractVersion: "storehouse.ingest.v1",
        source: "meal-planner",
        sessionId: "session-1",
        forwarded: true,
      })
    );
  });

  it("emits explicit homestead consumption contract from generated meal plan", () => {
    const emit = vi.fn();

    const normalizedPlan = {
      title: "Week Plan",
      summary: "Balanced meals",
      meals: [{ name: "Breakfast" }, { name: "Dinner" }],
      shoppingList: [{ name: "Eggs" }, { name: "Spinach" }],
      prepTasks: [{ title: "Chop veggies" }],
      budget: { estimate: 42 },
      macros: { calories: 2000 },
    };

    const result = emitHomesteadMealPlanGenerated({
      normalizedPlan,
      meta: {
        templateId: "family-weekly",
        cuisines: ["Mediterranean"],
        presets: ["high-protein"],
        duration: "7d",
        saveAsDraft: false,
      },
      eventBusEmit: emit,
    });

    expect(result.ok).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "homestead.planner.mealPlan.generated",
      expect.objectContaining({
        contractVersion: "homestead.mealplan.v1",
        source: "meal-planner",
        plan: expect.objectContaining({
          mealCount: 2,
          shoppingCount: 2,
          prepTaskCount: 1,
        }),
        routing: expect.objectContaining({
          templateId: "family-weekly",
          cuisines: ["Mediterranean"],
          presets: ["high-protein"],
          duration: "7d",
          saveAsDraft: false,
        }),
      })
    );
  });

  it("emits planner.gaps.updated with hard-gap summary and community-first sourcing", () => {
    const emit = vi.fn();

    const normalizedPlan = {
      title: "Week Plan",
      meals: [{ name: "Lunch" }, { name: "Dinner" }],
      shoppingList: [{ name: "Tomatoes", qty: 4, unit: "lb" }],
      prepTasks: [{ title: "Can tomatoes" }],
    };

    const estimateInputs = {
      contractVersion: "planner.estimate-inputs.v1",
      animal: {
        mealCount: 2,
        proteinDemandByType: { poultry: 1 },
      },
      garden: {
        mealCount: 2,
        produceDemand: [{ name: "Tomatoes", qty: 4, unit: "lb" }],
      },
      preservation: {
        prepTaskCount: 1,
        tasks: [{ id: "pres-1", produce: "tomato", method: "can", quantity: 2 }],
      },
    };

    const result = emitPlannerGapsUpdated({
      estimateInputs,
      normalizedPlan,
      meta: { sessionId: "session-1" },
      eventBusEmit: emit,
    });

    expect(result.ok).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe("planner.gaps.updated");

    const payload = emit.mock.calls[0][1] || {};
    expect(payload.source).toBe("mealplanner:onGenerate");
    expect(payload.plannerGaps).toBeTruthy();
    expect(payload.plannerGaps.summary.hardGapCount).toBeGreaterThan(0);

    const firstGap = (payload.plannerGaps.gaps || [])[0] || {};
    const sourcing = Array.isArray(firstGap.recommendedSourcing)
      ? firstGap.recommendedSourcing
      : [];

    expect(sourcing.length).toBeGreaterThanOrEqual(2);
    expect(sourcing[0].sourceTier).toBe("community-marketplace");
    expect(sourcing[1].sourceTier).toBe("outside-sources");
  });
});
