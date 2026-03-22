import { describe, expect, it, vi } from "vitest";

const {
  orchestrateMealPlanFanout,
} = require("../src/server/services/planners/MealPlannerOrchestrationService.js");

describe("meal planner backend orchestration", () => {
  it("builds and persists backend fanout contracts for cross-planner updates", async () => {
    const persistContracts = vi.fn(async ({ contracts }) => ({
      queuedCount: contracts.length,
      queuedContracts: contracts.map((item, idx) => ({
        eventType: item.eventType,
        id: `evt-${idx + 1}`,
        status: "pending",
      })),
    }));

    const syncProjection = vi.fn(async ({ contracts }) => ({
      ok: true,
      processedContracts: contracts.length,
      contract: {
        planner: "meal",
        updateType: "meal.fanout",
      },
    }));

    const result = await orchestrateMealPlanFanout({
      mealPayload: {
        id: "meal-plan-1",
        householdId: "home-pr1",
        plannerOutput: {
          meals: [{ title: "Stew" }],
          shoppingList: [
            { name: "Tomatoes", qty: 4, unit: "lb" },
            { name: "Chicken", qty: 3, unit: "lb" },
          ],
          prepTasks: [{ title: "Can tomatoes" }],
          budget: { estimate: 120 },
          macros: { calories: 2200 },
        },
      },
      mealSaveResult: {
        id: "meal-plan-1",
        householdId: "home-pr1",
      },
      persistContracts,
      syncProjection,
    });

    expect(result.ok).toBe(true);
    expect(result.householdId).toBe("home-pr1");
    expect(result.summary.contractsCount).toBe(4);
    expect(result.summary.hardGapCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.storehouseNeedsCount).toBeGreaterThanOrEqual(1);

    const eventTypes = result.contracts.map((x) => x.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "planner.estimateInputs.updated",
        "planner.gaps.updated",
        "storehouse.planner.ingest.requested",
        "homestead.planner.mealPlan.generated",
      ])
    );

    expect(persistContracts).toHaveBeenCalledTimes(1);
    expect(syncProjection).toHaveBeenCalledTimes(1);
    expect(result.durable.queuedCount).toBe(4);
    expect(result.projectionSync.ok).toBe(true);
  });
});
