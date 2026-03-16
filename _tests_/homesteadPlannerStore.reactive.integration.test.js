// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { eventBus } from "../src/services/events/eventBus";
import {
  initializePlannerGapsIngestor,
  useHomesteadPlannerStore,
} from "../src/store/homesteadPlannerStore.js";

describe("homestead planner reactive contracts", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // no-op
    }

    useHomesteadPlannerStore.getState().reset();
    initializePlannerGapsIngestor();
  });

  it("consumes planner.gaps.updated and stores last planner gaps snapshot", () => {
    eventBus.emit("planner.gaps.updated", {
      source: "test",
      plannerGaps: {
        contractVersion: "planner.gaps.v1",
        summary: {
          totalGaps: 3,
          hardGapCount: 2,
          escalationRequired: true,
        },
        gaps: [
          {
            name: "Tomatoes",
            unit: "lb",
            missingQty: 4,
            severity: "hard",
          },
        ],
      },
    });

    const s = useHomesteadPlannerStore.getState();

    expect(s.ingest.lastPlannerGaps).toBeTruthy();
    expect(s.ingest.lastPlannerGaps.contractVersion).toBe("planner.gaps.v1");
    expect(s.ingest.lastPlannerGaps.summary.hardGapCount).toBe(2);
    expect(s.ingest.lastIngestedAt).toBeTruthy();
  });

});
