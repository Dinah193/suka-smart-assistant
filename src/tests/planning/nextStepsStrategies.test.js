// C:\Users\larho\suka-smart-assistant\src\tests\planning\nextStepsStrategies.test.js
// -----------------------------------------------------------------------------
// Tests for Next Steps strategies and recommendations
//
// HOW THIS FITS
// --------------
// "Next Steps" is the user-facing layer on top of the Planning Graph + calculators.
// It looks at candidate actions (storehouse refills, garden prep, animal care,
// cleaning, preservation sessions, etc.) and applies strategy-specific rules to
// decide what should be promoted as the *next best actions*.
//
// In the SSA context, these recommendations will:
//   * Feed "Do This Now" CTAs on dashboards and domain pages.
//   * Drive which sessions are suggested as the next runnable SessionRunner flows.
//   * Reflect household stability priorities (stability-first modes, etc.).
//
// ASSUMED PUBLIC API
// ------------------
// The planning next-steps module is assumed to live at:
//
//   "@/services/planning/nextStepsStrategies.js"
//
// and exports:
//
//   export const NEXT_STEPS_STRATEGIES = {
//     BALANCED: "balanced",
//     STABILITY_FIRST: "stabilityFirst",
//     STOREHOUSE_FIRST: "storehouseFirst",
//   };
//
//   /**
//    * @typedef {Object} NextStepCandidate
//    * @property {string} id
//    * @property {string} domain  // e.g. "storehouse"|"garden"|"animals"|"cleaning"|"preservation"|"cooking"
//    * @property {"low"|"medium"|"high"} priority
//    * @property {number} stabilityImpact // 0..1 (how much this helps stability)
//    * @property {boolean} isBlocked       // true if blocked by guards (inventory/weather/etc.)
//    * @property {boolean} isSessionReady  // true if we can launch a SessionRunner now
//    */
//
//   /**
//    * @typedef {Object} NextStepRecommendation
//    * @property {string} id
//    * @property {string} domain
//    * @property {number} score
//    * @property {string[]} reasons
//    * @property {string} strategyId
//    */
//
//   /**
//    * Get ranked next step recommendations.
//    *
//    * @param {Object} params
//    * @param {NextStepCandidate[]} params.candidates
//    * @param {string} [params.strategyId]  // one of NEXT_STEPS_STRATEGIES, default BALANCED
//    * @param {number} [params.max]        // default 5
//    * @returns {NextStepRecommendation[]}
//    */
//   export function getNextSteps({ candidates, strategyId, max });
//
// ENGINE RULES (that these tests lock in)
// ---------------------------------------
// - All strategies must ignore candidates where isBlocked === true.
// - All strategies must be deterministic: ties are broken by candidate.id ASC.
// - BALANCED:
//     * Scores based on priority > stabilityImpact > sessionReady.
//     * Expected ordering for typical household use, "general suggestions" mode.
// - STABILITY_FIRST:
//     * Scores primarily by stabilityImpact, with priority secondary.
//     * Used for "stability dashboard → what will move the needle most?".
// - STOREHOUSE_FIRST:
//     * Like BALANCED but gives a strong boost to domain === "storehouse".
//     * Used when planning refills / preservation ahead of time.
//
// The tests below define the observable contract. Implement
// nextStepsStrategies.js to satisfy them and integrate with your dashboards.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  NEXT_STEPS_STRATEGIES,
  getNextSteps
} from "@/services/planning/nextStepsStrategies.js";

/**
 * Small helper to build candidates quickly.
 * @param {Partial<import("@/services/planning/nextStepsStrategies.js").NextStepCandidate> & { id:string }} override
 */
function candidate(override) {
  return {
    id: override.id,
    domain: override.domain || "storehouse",
    priority: override.priority || "medium",
    stabilityImpact: typeof override.stabilityImpact === "number" ? override.stabilityImpact : 0.5,
    isBlocked: override.isBlocked ?? false,
    isSessionReady: override.isSessionReady ?? true
  };
}

// -----------------------------------------------------------------------------
// 1) BALANCED strategy – priority + stability + session-ready weighting
// -----------------------------------------------------------------------------

describe("nextStepsStrategies – BALANCED strategy", () => {
  it("ranks high-priority, high-impact, session-ready candidates highest", () => {
    const candidates = [
      candidate({
        id: "lowImpact-cleaning",
        domain: "cleaning",
        priority: "low",
        stabilityImpact: 0.2,
        isSessionReady: true
      }),
      candidate({
        id: "medImpact-garden",
        domain: "garden",
        priority: "medium",
        stabilityImpact: 0.6,
        isSessionReady: true
      }),
      candidate({
        id: "highImpact-animals",
        domain: "animals",
        priority: "high",
        stabilityImpact: 0.9,
        isSessionReady: true
      }),
      candidate({
        id: "highImpact-not-ready",
        domain: "storehouse",
        priority: "high",
        stabilityImpact: 0.95,
        isSessionReady: false
      })
    ];

    const recs = getNextSteps({
      candidates,
      strategyId: NEXT_STEPS_STRATEGIES.BALANCED,
      max: 10
    });

    const ids = recs.map((r) => r.id);

    // Under BALANCED we expect:
    //   1) highImpact-animals  (high priority + high impact + session-ready)
    //   2) highImpact-not-ready (slightly higher impact but not session-ready)
    //   3) medImpact-garden
    //   4) lowImpact-cleaning
    expect(ids[0]).toBe("highImpact-animals");
    expect(ids[1]).toBe("highImpact-not-ready");
    expect(ids[2]).toBe("medImpact-garden");
    expect(ids[3]).toBe("lowImpact-cleaning");

    // All returned objects must include basic recommendation properties.
    recs.forEach((rec) => {
      expect(typeof rec.score).toBe("number");
      expect(Array.isArray(rec.reasons)).toBe(true);
      expect(rec.strategyId).toBe(NEXT_STEPS_STRATEGIES.BALANCED);
    });
  });

  it("excludes blocked candidates from results", () => {
    const candidates = [
      candidate({
        id: "blocked-storehouse",
        domain: "storehouse",
        priority: "high",
        stabilityImpact: 0.9,
        isBlocked: true,
        isSessionReady: true
      }),
      candidate({
        id: "ok-garden",
        domain: "garden",
        priority: "medium",
        stabilityImpact: 0.5,
        isBlocked: false,
        isSessionReady: true
      })
    ];

    const recs = getNextSteps({
      candidates,
      strategyId: NEXT_STEPS_STRATEGIES.BALANCED
    });

    const ids = recs.map((r) => r.id);

    expect(ids).toContain("ok-garden");
    expect(ids).not.toContain("blocked-storehouse");
  });

  it("returns an empty array when no usable candidates exist", () => {
    const candidates = [
      candidate({
        id: "only-blocked",
        isBlocked: true
      })
    ];

    const recs = getNextSteps({
      candidates,
      strategyId: NEXT_STEPS_STRATEGIES.BALANCED
    });

    expect(recs).toEqual([]);
  });

  it("limits results to the provided max value", () => {
    const candidates = [
      candidate({ id: "a", priority: "high", stabilityImpact: 0.8 }),
      candidate({ id: "b", priority: "high", stabilityImpact: 0.7 }),
      candidate({ id: "c", priority: "medium", stabilityImpact: 0.7 }),
      candidate({ id: "d", priority: "low", stabilityImpact: 0.4 })
    ];

    const recs = getNextSteps({
      candidates,
      strategyId: NEXT_STEPS_STRATEGIES.BALANCED,
      max: 2
    });

    expect(recs.length).toBe(2);
    const ids = recs.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("is deterministic when scores tie (stable sort by id ascending)", () => {
    const candidates = [
      candidate({ id: "z-task", stabilityImpact: 0.5, priority: "medium" }),
      candidate({ id: "a-task", stabilityImpact: 0.5, priority: "medium" }),
      candidate({ id: "m-task", stabilityImpact: 0.5, priority: "medium" })
    ];

    const recs = getNextSteps({
      candidates,
      strategyId: NEXT_STEPS_STRATEGIES.BALANCED,
      max: 10
    });

    const ids = recs.map((r) => r.id);
    expect(ids).toEqual(["a-task", "m-task", "z-task"]);
  });
});

// -----------------------------------------------------------------------------
// 2) STABILITY_FIRST – heavy weight on stabilityImpact
// -----------------------------------------------------------------------------

describe("nextStepsStrategies – STABILITY_FIRST strategy", () => {
  it("prioritizes high stabilityImpact even over priority differences", () => {
    const candidates = [
      candidate({
        id: "rent-equivalent",
        domain: "storehouse",
        priority: "medium",
        stabilityImpact: 0.95
      }),
      candidate({
        id: "deep-clean-livingroom",
        domain: "cleaning",
        priority: "high",
        stabilityImpact: 0.4
      }),
      candidate({
        id: "garden-weeding",
        domain: "garden",
        priority: "medium",
        stabilityImpact: 0.6
      })
    ];

    const recs = getNextSteps({
      candidates,
      strategyId: NEXT_STEPS_STRATEGIES.STABILITY_FIRST,
      max: 10
    });

    const ids = recs.map((r) => r.id);

    // Under STABILITY_FIRST, rent-equivalent (0.95 impact) should outrank
    // the high-priority but low-impact cleaning task.
    expect(ids[0]).toBe("rent-equivalent");
    expect(ids.indexOf("rent-equivalent")).toBeLessThan(ids.indexOf("deep-clean-livingroom"));
  });

  it("still respects priority when stabilityImpact is similar", () => {
    const candidates = [
      candidate({
        id: "medium-priority-high-impact",
        priority: "medium",
        stabilityImpact: 0.8
      }),
      candidate({
        id: "high-priority-slightly-lower-impact",
        priority: "high",
        stabilityImpact: 0.75
      })
    ];

    const recs = getNextSteps({
      candidates,
      strategyId: NEXT_STEPS_STRATEGIES.STABILITY_FIRST
    });

    const ids = recs.map((r) => r.id);

    // With fairly close stability impacts, the high-priority task should win.
    expect(ids[0]).toBe("high-priority-slightly-lower-impact");
  });
});

// -----------------------------------------------------------------------------
// 3) STOREHOUSE_FIRST – boosts storehouse domain tasks
// -----------------------------------------------------------------------------

describe("nextStepsStrategies – STOREHOUSE_FIRST strategy", () => {
  it("boosts storehouse-related candidates over similar non-storehouse tasks", () => {
    const candidates = [
      candidate({
        id: "storehouse-topup",
        domain: "storehouse",
        priority: "medium",
        stabilityImpact: 0.6
      }),
      candidate({
        id: "garden-planting",
        domain: "garden",
        priority: "medium",
        stabilityImpact: 0.6
      }),
      candidate({
        id: "animals-feeding",
        domain: "animals",
        priority: "medium",
        stabilityImpact: 0.6
      })
    ];

    const recs = getNextSteps({
      candidates,
      strategyId: NEXT_STEPS_STRATEGIES.STOREHOUSE_FIRST,
      max: 10
    });

    const ids = recs.map((r) => r.id);

    // storehouse-topup must be top-ranked due to domain boost.
    expect(ids[0]).toBe("storehouse-topup");
  });

  it("still respects priority inside the boosted domain", () => {
    const candidates = [
      candidate({
        id: "storehouse-low-priority",
        domain: "storehouse",
        priority: "low",
        stabilityImpact: 0.8
      }),
      candidate({
        id: "storehouse-high-priority",
        domain: "storehouse",
        priority: "high",
        stabilityImpact: 0.8
      }),
      candidate({
        id: "non-storehouse-high-priority",
        domain: "garden",
        priority: "high",
        stabilityImpact: 0.8
      })
    ];

    const recs = getNextSteps({
      candidates,
      strategyId: NEXT_STEPS_STRATEGIES.STOREHOUSE_FIRST
    });

    const ids = recs.map((r) => r.id);

    // Within the storehouse domain, high priority should still rank first.
    expect(ids[0]).toBe("storehouse-high-priority");

    // The low-priority storehouse task may still rank above the non-storehouse
    // counterpart due to domain boost. We enforce that by at least checking
    // it appears before the non-storehouse id.
    expect(ids.indexOf("storehouse-low-priority")).toBeLessThan(
      ids.indexOf("non-storehouse-high-priority")
    );
  });
});
