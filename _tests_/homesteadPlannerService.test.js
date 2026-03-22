// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHomesteadSavePayload,
  loadHomesteadPlannerPlan,
  mergeSnapshotIntoPlan,
  saveHomesteadPlannerPlan,
} from "../src/pages/homesteadplanner/HomesteadPlannerService";

describe("HomesteadPlannerService", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // no-op
    }

    window.__suka = {
      profile: {
        userId: "homestead-user",
        homeId: "home-42",
      },
    };

    global.fetch = vi.fn();
  });

  it("builds backend payload from homestead plan", () => {
    const payload = buildHomesteadSavePayload({
      id: "plan-1",
      season: "spring",
      garden: {
        beds: 10,
        tasks: [{ id: "garden-task-1", title: "Transplant seedlings" }],
      },
      animals: {
        estimatedTotal: 12,
      },
      outputs: [
        {
          id: "out-1",
          outputType: "produce",
          outputName: "Tomatoes",
          qty: 20,
          unit: "lb",
          preservationReady: true,
        },
      ],
    });

    expect(payload.householdId).toBe("home-42");
    expect(payload.planId).toBe("plan-1");
    expect(payload.seasonKey).toBe("spring-season");
    expect(payload.gardenPlan.tasks.length).toBe(1);
    expect(payload.outputs.length).toBe(1);
    expect(payload.changeReason).toBe("homestead_plan_upsert_ui");
  });

  it("normalizes snapshot into planner shape", () => {
    const merged = mergeSnapshotIntoPlan(
      {
        planId: "remote-plan-2",
        seasonKey: "fall-season",
        gardenTasks: [{ id: "g-1", title: "Plant garlic" }],
        animalPlan: { estimatedTotal: 4 },
        outputs: [{ id: "o-1", outputType: "animal", outputName: "Eggs", qty: 24, unit: "dozen" }],
      },
      {
        id: "local-plan",
        season: "summer",
        garden: { beds: 4 },
        animals: { estimatedTotal: 1 },
      }
    );

    expect(merged.id).toBe("remote-plan-2");
    expect(merged.season).toBe("fall");
    expect(merged.garden.tasks.length).toBe(1);
    expect(merged.animals.estimatedTotal).toBe(4);
    expect(Array.isArray(merged.outputs)).toBe(true);
  });

  it("loads homestead snapshot via backend API", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        planId: "remote-plan-3",
        seasonKey: "winter-season",
        gardenTasks: [],
        animalPlan: {},
        outputs: [],
      }),
    });

    const out = await loadHomesteadPlannerPlan({
      fallbackPlan: {
        id: "fallback",
        season: "spring",
      },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("/api/planners/homestead?householdId=");
    expect(out.snapshot.planId).toBe("remote-plan-3");
    expect(out.plan.id).toBe("remote-plan-3");
  });

  it("saves homestead plan via backend API", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, saved: { planId: "plan-7" } }),
    });

    const out = await saveHomesteadPlannerPlan({
      id: "plan-7",
      season: "summer",
      garden: { tasks: [] },
      animals: {},
      outputs: [],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("/api/planners/homestead");
    expect(options.method).toBe("POST");
    expect(out.payload.planId).toBe("plan-7");
  });
});
