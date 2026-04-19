import { describe, expect, it } from "vitest";

const {
  computeLaunchMetrics,
  evaluateLaunchGates,
} = require("../src/server/contracts/launchMetricsContract.js");

describe("launch metrics gate contract", () => {
  it("computes seven launch metrics and evaluates thresholds", () => {
    const snapshot = computeLaunchMetrics({
      cohort: "alpha",
      timeWindow: {
        from: "2026-04-01T00:00:00.000Z",
        to: "2026-04-30T00:00:00.000Z",
      },
      householdState: {
        tasks: [
          { createdAt: "2026-04-05T10:00:00.000Z", status: "completed", owner: "owner-1" },
        ],
        approvals: [
          {
            createdAt: "2026-04-06T10:00:00.000Z",
            decidedAt: "2026-04-06T18:00:00.000Z",
            requestedBy: "owner-1",
          },
        ],
        memberships: [
          { householdId: "owner-1", cohort: "alpha", lastActiveAt: "2026-04-07T00:00:00.000Z" },
        ],
        projectSpaces: [
          {
            cohort: "alpha",
            contributions: [{ author: "owner-1", createdAt: "2026-04-07T00:00:00.000Z" }],
            disputes: [],
          },
        ],
      },
    });

    expect(Object.keys(snapshot.metrics).sort()).toEqual(
      [
        "activationRate",
        "collaborationDepth",
        "medianResolutionHours",
        "participationRate",
        "retentionWeek2",
        "retentionWeek4",
        "taskCompletionRate",
        "weeklyActiveHouseholdsRate",
      ].sort(),
    );

    const gate = evaluateLaunchGates(snapshot.metrics);
    expect(typeof gate.pass).toBe("boolean");
    expect(Array.isArray(gate.failures)).toBe(true);
  });

  it("flags failures when metrics are below thresholds", () => {
    const metrics = {
      activationRate: 0.1,
      weeklyActiveHouseholdsRate: 0.2,
      taskCompletionRate: 0.25,
      collaborationDepth: 0.5,
      participationRate: 0.2,
      medianResolutionHours: 72,
      retentionWeek2: 0,
      retentionWeek4: 0,
    };

    const gate = evaluateLaunchGates(metrics);
    expect(gate.pass).toBe(false);
    expect(gate.failures.length).toBeGreaterThan(0);
    expect(gate.failures.some((item) => item.key === "medianResolutionHours")).toBe(true);
    expect(gate.failures.some((item) => item.key === "activationRate")).toBe(true);
  });
});
