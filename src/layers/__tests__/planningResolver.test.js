/**
 * File: src/layers/__tests__/planningResolver.test.js
 * Requirements:
 *  - Determinism tests (same input, same output)
 *  - Ambiguity tests (meal vs storehouse wording)
 */

import { describe, it, expect } from "vitest";
import PlanningResolver from "../resolvers/PlanningResolver.js";

describe("PlanningResolver", () => {
  it("is deterministic for the same input", () => {
    const r = new PlanningResolver();

    const intentCandidates = [
      { domain: "planning", tokens: ["plan week", "batch cook"], confidence: 0.8 },
      { domain: "meals", tokens: ["meal prep"], confidence: 0.7 },
    ];
    const context = { inventorySnapshotAvailable: true, quietHours: { enabled: false } };

    const a = r.resolve(intentCandidates, context);
    const b = r.resolve(intentCandidates, context);

    expect(a).toEqual(b);
  });

  it("handles ambiguity: 'preserve' + pantry terms bias toward preservation-first vs storehouse", () => {
    const r = new PlanningResolver();

    const candidates = [
      { domain: "planning", tokens: ["preserve", "pantry", "surplus"], confidence: 0.8 },
    ];
    const context = { inventorySnapshotAvailable: true };

    const out = r.resolve(candidates, context);
    const top = out.ranked[0];

    // We accept either preservation-first meals or storehouse restock as top,
    // but preservation-first should be in top 3 for this ambiguity blend.
    const topIds = out.ranked.slice(0, 3).map((x) => x.id);
    expect(topIds).toContain("pat.meals.preservation_first");
    expect(top).toBeTruthy();
  });

  it("routes storehouse wording: 'pantry reset' should boost storehouse patterns", () => {
    const r = new PlanningResolver();

    const candidates = [
      { domain: "planning", tokens: ["pantry reset", "restock", "fifo"], confidence: 0.9 },
    ];
    const context = { inventorySnapshotAvailable: true };

    const out = r.resolve(candidates, context);
    const topIds = out.ranked.slice(0, 2).map((x) => x.id);

    expect(topIds).toContain("pat.storehouse.weekly_restock");
  });
});
