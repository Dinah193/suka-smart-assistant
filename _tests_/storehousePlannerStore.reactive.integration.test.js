// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { eventBus } from "../src/services/events/eventBus";
import {
  initializeStorehousePlannerIngestors,
  useStorehousePlannerStore,
} from "../src/store/StorehousePlannerStore.js";

describe("storehouse planner reactive contracts", () => {
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
        lastPlannerGaps: null,
        lastPlannerGapsAt: null,
      },
    });

    initializeStorehousePlannerIngestors();
  });

  it("consumes planner.gaps.updated and upserts hard-gap needs", () => {
    eventBus.emit("planner.gaps.updated", {
      source: "test",
      plannerGaps: {
        contractVersion: "planner.gaps.v1",
        summary: {
          totalGaps: 2,
          hardGapCount: 1,
        },
        gaps: [
          {
            name: "Tomatoes",
            unit: "lb",
            missingQty: 6,
            severity: "hard",
            recommendedSourcing: [
              { sourceTier: "community-marketplace", priority: 1 },
              { sourceTier: "outside-sources", priority: 2 },
            ],
          },
          {
            name: "Salt",
            unit: "oz",
            missingQty: 1,
            severity: "soft",
          },
        ],
      },
    });

    const s = useStorehousePlannerStore.getState();

    expect(s.plannerSignals?.lastPlannerGaps).toBeTruthy();
    expect(s.plannerSignals?.lastPlannerGaps?.summary?.hardGapCount).toBe(1);
    expect(s.plannerSignals?.lastPlannerGapsAt).toBeTruthy();

    const hardNeeds = (s.storehouseNeeds || []).filter(
      (n) => n.category === "hard-gap"
    );
    expect(hardNeeds.length).toBe(1);
    expect(hardNeeds[0].name).toBe("Tomatoes");
    expect(hardNeeds[0].priority).toBe(1);
    expect(hardNeeds[0].tags).toContain("planner-gap");
    expect(hardNeeds[0].tags).toContain("source-tier:community-marketplace");
  });

});
