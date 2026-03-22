// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMealPlannerSavePayload,
  persistMealPlannerGeneration,
} from "../src/pages/mealplanner/mealPlannerPersistence";

describe("mealPlannerPersistence", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // no-op
    }
    window.__suka = {
      profile: {
        userId: "chef-1",
        homeId: "home-77",
      },
    };
  });

  it("builds planner save payload with planner context", () => {
    const payload = buildMealPlannerSavePayload({
      normalizedPlan: {
        title: "Weekly Plan",
        meals: [{ title: "Soup" }],
        shoppingList: [{ name: "Tomato", qty: 3, unit: "lb" }],
        prepTasks: [{ title: "Chop veg" }],
      },
      duration: "7-day",
      templateId: "balanced-week",
      cuisines: ["Caribbean"],
      presets: ["prep-focused"],
      horizonMonths: 3,
      plannerGaps: { summary: { totalGaps: 1 } },
      estimateInputs: { contractVersion: "planner.estimate-inputs.v1" },
      currentPlanId: "meal-123",
    });

    expect(payload.id).toBe("meal-123");
    expect(payload.householdId).toBe("home-77");
    expect(payload.userId).toBe("chef-1");
    expect(Array.isArray(payload.plannerOutput.meals)).toBe(true);
    expect(payload.plannerOutput.context.duration).toBe("7-day");
    expect(payload.plannerOutput.context.templateId).toBe("balanced-week");
    expect(payload.plannerOutput.context.cuisines).toEqual(["Caribbean"]);
    expect(payload.plannerOutput.context.presets).toEqual(["prep-focused"]);
    expect(payload.plannerOutput.context.horizonMonths).toBe(3);
  });

  it("persists generated non-draft plans via planner API save", async () => {
    const saveFn = vi.fn(async (body) => ({ ok: true, id: body.id }));

    const out = await persistMealPlannerGeneration({
      normalizedPlan: {
        title: "Weekly Plan",
        meals: [{ title: "Soup" }],
        shoppingList: [],
        prepTasks: [],
      },
      saveAsDraft: false,
      templateId: "balanced-week",
      cuisines: ["Caribbean"],
      presets: ["prep-focused"],
      saveFn,
    });

    expect(out.ok).toBe(true);
    expect(out.skipped).toBe(false);
    expect(saveFn).toHaveBeenCalledTimes(1);
    const [savedPayload] = saveFn.mock.calls[0];
    expect(savedPayload.householdId).toBe("home-77");
    expect(savedPayload.userId).toBe("chef-1");
    expect(savedPayload.changeReason).toBe("meal_planner_generate");
  });

  it("skips persistence in draft mode", async () => {
    const saveFn = vi.fn(async () => ({ ok: true }));

    const out = await persistMealPlannerGeneration({
      normalizedPlan: {
        meals: [{ title: "Soup" }],
      },
      saveAsDraft: true,
      saveFn,
    });

    expect(out.ok).toBe(false);
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe("draft_mode");
    expect(saveFn).not.toHaveBeenCalled();
  });

  it("returns non-throwing failure metadata when save call fails", async () => {
    const saveFn = vi.fn(async () => {
      throw new Error("network-down");
    });

    const out = await persistMealPlannerGeneration({
      normalizedPlan: {
        meals: [{ title: "Soup" }],
      },
      saveAsDraft: false,
      saveFn,
    });

    expect(out.ok).toBe(false);
    expect(out.skipped).toBe(false);
    expect(String(out.error?.message || out.error)).toContain("network-down");
  });
});
