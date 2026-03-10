import { describe, it, expect, vi } from "vitest";
import {
  forwardProvisionToStorehousePlanner,
  emitHomesteadMealPlanGenerated,
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
});
