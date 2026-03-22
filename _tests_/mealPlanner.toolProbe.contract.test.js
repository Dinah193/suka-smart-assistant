import { describe, expect, it } from "vitest";

import {
  buildMealPlannerProbeText,
  normalizeMealPlannerTool,
  resolveToolFromSearch,
} from "../src/pages/mealplanner/toolProbe";

describe("meal planner probe contract", () => {
  const knownToolIds = new Set([
    "dashboard",
    "cycle",
    "prep",
    "forecast",
    "procurement",
    "scale",
    "seed",
    "calendar",
    "pantry-saver",
    "feast-day",
    "hair-growth",
    "seasonal-garden",
    "drafts",
  ]);

  it("normalizes known aliases to stable tool ids", () => {
    expect(normalizeMealPlannerTool("batch", knownToolIds)).toBe("cycle");
    expect(normalizeMealPlannerTool("batches", knownToolIds)).toBe("cycle");
    expect(normalizeMealPlannerTool("batch-collab", knownToolIds)).toBe("cycle");
    expect(normalizeMealPlannerTool("collaboration", knownToolIds)).toBe("prep");
    expect(normalizeMealPlannerTool("planner", knownToolIds)).toBe("dashboard");
    expect(normalizeMealPlannerTool("unknown-tool", knownToolIds)).toBe("");
  });

  it("resolves tool from tool/tab/focus query in priority order", () => {
    expect(resolveToolFromSearch("?tool=batch", knownToolIds)).toBe("cycle");
    expect(resolveToolFromSearch("?tab=collaboration", knownToolIds)).toBe("prep");
    expect(resolveToolFromSearch("?focus=planner", knownToolIds)).toBe("dashboard");
    expect(resolveToolFromSearch("?x=1", knownToolIds)).toBe("");
  });

  it("builds stable probe text with meal planner and prep/batch keywords", () => {
    const text = buildMealPlannerProbeText("cycle");
    expect(text).toContain("Meal Planner Ready");
    expect(text).toContain("Active tool: cycle");
    expect(text).toContain("prep batch cycle");
  });
});
