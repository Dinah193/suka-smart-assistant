// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMealPlannerSavePayload,
  persistMealPlannerGeneration,
  resolveMealPlannerIdentity,
} from "../src/pages/mealplanner/mealPlannerPersistence";

describe("meal planner offline draft and retry guarantees", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // no-op
    }
    window.__suka = {
      profile: {
        userId: "chef-retry-1",
        homeId: "retry-home-1",
      },
    };
  });

  it("resolves deterministic identity from window profile", () => {
    const who = resolveMealPlannerIdentity();
    expect(who.userId).toBe("chef-retry-1");
    expect(who.householdId).toBe("retry-home-1");
  });

  it("builds canonical payload shape for planner persistence", () => {
    const payload = buildMealPlannerSavePayload({
      normalizedPlan: {
        title: "Retry Safe Plan",
        meals: [{ title: "Stew" }],
        shoppingList: [{ name: "Beans" }],
      },
      duration: "7-day",
      templateId: "resilience-week",
      cuisines: ["Caribbean"],
      presets: ["budget"],
      horizonMonths: 2,
    });

    expect(payload.householdId).toBe("retry-home-1");
    expect(payload.userId).toBe("chef-retry-1");
    expect(Array.isArray(payload.plannerOutput.meals)).toBe(true);
    expect(payload.plannerOutput.context.templateId).toBe("resilience-week");
    expect(payload.plannerOutput.context.horizonMonths).toBe(2);
  });

  it("skips save in draft mode and does not call save function", async () => {
    const saveFn = vi.fn(async () => ({ ok: true }));
    const out = await persistMealPlannerGeneration({
      normalizedPlan: { meals: [{ title: "Soup" }] },
      saveAsDraft: true,
      saveFn,
    });

    expect(out.ok).toBe(false);
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe("draft_mode");
    expect(saveFn).not.toHaveBeenCalled();
  });

  it("reports persistence error envelope when save function throws", async () => {
    const saveFn = vi.fn(async () => {
      throw new Error("network-down");
    });

    const out = await persistMealPlannerGeneration({
      normalizedPlan: { meals: [{ title: "Fallback Stew" }] },
      saveFn,
    });

    expect(out.ok).toBe(false);
    expect(out.skipped).toBe(false);
    expect(out.payload.householdId).toBe("retry-home-1");
    expect(out.error).toBeTruthy();
  });

  it("returns success envelope when save function succeeds", async () => {
    const saveFn = vi.fn(async () => ({ ok: true, id: "meal-1" }));

    const out = await persistMealPlannerGeneration({
      normalizedPlan: { meals: [{ title: "Success Curry" }] },
      saveFn,
    });

    expect(out.ok).toBe(true);
    expect(out.skipped).toBe(false);
    expect(out.response.id).toBe("meal-1");
  });

  it("skips when normalized plan has no meals", async () => {
    const saveFn = vi.fn(async () => ({ ok: true }));
    const out = await persistMealPlannerGeneration({
      normalizedPlan: { meals: [] },
      saveFn,
    });

    expect(out.ok).toBe(false);
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe("missing_meals");
    expect(saveFn).not.toHaveBeenCalled();
  });
});
