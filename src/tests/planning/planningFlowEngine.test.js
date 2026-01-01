// C:\Users\larho\suka-smart-assistant\src\tests\planning\planningFlowEngine.test.js
// -----------------------------------------------------------------------------
// Tests for the Planning Flow Engine
//
// HOW THIS FITS
// --------------
// The Planning Flow Engine is responsible for executing Planning Graph nodes
// in a dependency-aware order. It is the "orchestrator" that ensures:
//
//   * Upstream calculators (e.g. Seed Viability, Garden Yield, Storehouse Goals)
//     run before downstream planners (Meal Planner, Stability Score, etc.).
//   * Branches are respected (a node that depends on multiple parents only
//     executes once *all* parents have completed).
//   * No infinite loops when cycles slip into the graph.
//   * Reasonable behavior when given invalid start nodes.
//
// In the SSA context this engine will be used to:
//   * Pre-compute data before building sessions.
//   * Drive domain "flows" (e.g., garden → storehouse → meals) that then
//     surface as runnable SessionRunner sessions.
//
// ASSUMED PUBLIC API
// ------------------
// planningFlowEngine is expected to export:
//
//   import { executePlanningFlow } from "@/services/planning/planningFlowEngine.js";
//
//   /**
//    * @typedef {Object} PlanningFlowResult
//    * @property {string[]} executionOrder  // ordered node ids actually executed
//    * @property {Record<string, any>} results // per-node return values
//    * @property {Record<string, Error>} errors // per-node errors, if any
//    * @property {string[]} skipped        // nodes skipped due to errors/guards
//    */
//
//   /**
//    * @typedef {Object} PlanningFlowOptions
//    * @property {string} startId  // node id to start the flow from
//    * @property {(node: any, ctx: any) => any|Promise<any>} executor
//    * @property {any} [context]
//    */
//
//   /**
//    * @param {PlanningGraph} graph
//    * @param {PlanningFlowOptions} options
//    * @returns {Promise<PlanningFlowResult>}
//    */
//   async function executePlanningFlow(graph, options) { ... }
//
// Where PlanningGraph is the normalized structure returned by:
//   loadPlanningGraphFromConfig(config) from "@/services/planning/planningGraphLoader.js"
//
// The engine MUST:
//   * Execute nodes only once.
//   * Respect topological order based on directed edges.
//   * Avoid infinite loops, even if cycles exist.
//   * Resolve a Promise and not throw for normal control flow errors.
//
// These tests define that contract; implementation should be adapted to pass them.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { loadPlanningGraphFromConfig } from "@/services/planning/planningGraphLoader.js";
import { executePlanningFlow } from "@/services/planning/planningFlowEngine.js";

// -----------------------------------------------------------------------------
// Helpers – small test graphs
// -----------------------------------------------------------------------------

// Simple linear chain: A → B → C
const LINEAR_CONFIG = {
  version: 1,
  nodes: [
    { id: "A", type: "calculator", label: "A", domain: "test" },
    { id: "B", type: "calculator", label: "B", domain: "test" },
    { id: "C", type: "planner", label: "C", domain: "test" }
  ],
  edges: [
    { from: "A", to: "B", kind: "feedsInto" },
    { from: "B", to: "C", kind: "feedsInto" }
  ]
};

// Branching + join:
//
//    A ---> B ----\
//           \      → D
//            C ---/
//
const BRANCH_CONFIG = {
  version: 1,
  nodes: [
    { id: "A", type: "calculator", label: "A", domain: "test" },
    { id: "B", type: "calculator", label: "B", domain: "test" },
    { id: "C", type: "calculator", label: "C", domain: "test" },
    { id: "D", type: "planner", label: "D", domain: "test" }
  ],
  edges: [
    { from: "A", to: "B", kind: "feedsInto" },
    { from: "A", to: "C", kind: "feedsInto" },
    { from: "B", to: "D", kind: "feedsInto" },
    { from: "C", to: "D", kind: "feedsInto" }
  ]
};

// Cyclic graph to ensure we don't infinite loop:
//   X → Y → Z → X
const CYCLIC_CONFIG = {
  version: 1,
  nodes: [
    { id: "X", type: "calculator", label: "X", domain: "test" },
    { id: "Y", type: "calculator", label: "Y", domain: "test" },
    { id: "Z", type: "calculator", label: "Z", domain: "test" }
  ],
  edges: [
    { from: "X", to: "Y", kind: "feedsInto" },
    { from: "Y", to: "Z", kind: "feedsInto" },
    { from: "Z", to: "X", kind: "feedsInto" }
  ]
};

function buildLinearGraph() {
  return loadPlanningGraphFromConfig(LINEAR_CONFIG);
}

function buildBranchGraph() {
  return loadPlanningGraphFromConfig(BRANCH_CONFIG);
}

function buildCyclicGraph() {
  return loadPlanningGraphFromConfig(CYCLIC_CONFIG);
}

// -----------------------------------------------------------------------------
// 1) Linear flow should execute in strict dependency order
// -----------------------------------------------------------------------------

describe("planningFlowEngine – linear flows", () => {
  it("executes nodes in strict topological order for a simple chain", async () => {
    const graph = buildLinearGraph();
    const callOrder = [];

    const executor = async (node, ctx) => {
      // Record execution order
      callOrder.push(node.id);
      // Produce a simple result that depends on context, just to prove it's passed.
      return `${node.id}-${ctx.trace}`;
    };

    const result = await executePlanningFlow(graph, {
      startId: "A",
      executor,
      context: { trace: "ok" }
    });

    // Expected deterministic execution order: A → B → C
    expect(callOrder).toEqual(["A", "B", "C"]);

    // Engine should report the same order
    expect(result.executionOrder).toEqual(["A", "B", "C"]);

    // Results should be keyed by node id and reflect executor output
    expect(result.results).toMatchObject({
      A: "A-ok",
      B: "B-ok",
      C: "C-ok"
    });

    // No errors, no skipped nodes in the happy path
    expect(result.errors).toEqual({});
    expect(result.skipped).toEqual([]);
  });

  it("returns an empty result when startId does not exist", async () => {
    const graph = buildLinearGraph();
    const callOrder = [];

    const result = await executePlanningFlow(graph, {
      startId: "UNKNOWN",
      executor: (node) => {
        callOrder.push(node.id);
        return node.id;
      }
    });

    expect(callOrder).toEqual([]);
    expect(result.executionOrder).toEqual([]);
    expect(result.results).toEqual({});
    expect(result.errors).toEqual({});
    expect(result.skipped).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// 2) Branching + join: D must not run until both B and C have executed
// -----------------------------------------------------------------------------

describe("planningFlowEngine – branching and joins", () => {
  it("ensures join nodes execute only after all prerequisites are completed", async () => {
    const graph = buildBranchGraph();
    const callOrder = [];

    const executor = async (node) => {
      callOrder.push(node.id);
      return node.id.toLowerCase();
    };

    const result = await executePlanningFlow(graph, {
      startId: "A",
      executor
    });

    // A must always execute first
    expect(callOrder[0]).toBe("A");

    // D must execute after both B and C, regardless of B/C internal ordering.
    const idxA = callOrder.indexOf("A");
    const idxB = callOrder.indexOf("B");
    const idxC = callOrder.indexOf("C");
    const idxD = callOrder.indexOf("D");

    expect(idxA).toBe(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxA);
    expect(idxD).toBeGreaterThan(idxB);
    expect(idxD).toBeGreaterThan(idxC);

    // Non-determinism between B and C is allowed, but D is always last.
    expect(idxD).toBe(callOrder.length - 1);

    // Execution order in result should match actual calls.
    expect(result.executionOrder).toEqual(callOrder);

    // All results should exist and be lowercased ids.
    expect(result.results).toMatchObject({
      A: "a",
      B: "b",
      C: "c",
      D: "d"
    });
  });

  it("can start in the middle of a branch (e.g. at B) without executing upstream", async () => {
    const graph = buildBranchGraph();
    const callOrder = [];

    const executor = async (node) => {
      callOrder.push(node.id);
      return node.id;
    };

    const result = await executePlanningFlow(graph, {
      startId: "B",
      executor
    });

    // Should only walk reachable nodes from B: B → D (requires C? depends on design)
    // For this contract we define: engine only enforces dependencies that are
    // upstream of startId; when starting at B, we assume its prerequisites are
    // already satisfied or provided by context.
    expect(callOrder).toEqual(["B", "D"]);
    expect(result.executionOrder).toEqual(["B", "D"]);

    expect(Object.keys(result.results).sort()).toEqual(["B", "D"].sort());
  });
});

// -----------------------------------------------------------------------------
// 3) Error handling & skipping behavior
// -----------------------------------------------------------------------------

describe("planningFlowEngine – error handling and skipped nodes", () => {
  it("records errors and skips downstream dependents when an upstream node fails", async () => {
    const graph = buildBranchGraph();
    const callOrder = [];

    const executor = async (node) => {
      callOrder.push(node.id);
      if (node.id === "C") {
        // Simulate calculator failure (e.g., missing input data)
        throw new Error("C failed");
      }
      return node.id;
    };

    const result = await executePlanningFlow(graph, {
      startId: "A",
      executor
    });

    // A and B and C should be attempted; D should be skipped because one
    // of its prerequisites (C) failed.
    expect(callOrder).toEqual(["A", "B", "C"]);

    // Engine must record that D was not executed.
    expect(result.executionOrder).toEqual(["A", "B", "C"]);

    expect(result.results).toMatchObject({
      A: "A",
      B: "B"
      // No C result due to error
    });

    expect(Object.keys(result.errors)).toEqual(["C"]);
    expect(result.errors.C).toBeInstanceOf(Error);
    expect(result.errors.C.message).toBe("C failed");

    // D should be in the skipped list because it depends (directly or indirectly)
    // on a node that errored.
    expect(result.skipped).toContain("D");
  });
});

// -----------------------------------------------------------------------------
// 4) Cycle safety – engine must not infinite loop and must execute each node once
// -----------------------------------------------------------------------------

describe("planningFlowEngine – cycle safety", () => {
  it("handles cycles without infinite loops, executing each reachable node once", async () => {
    const graph = buildCyclicGraph();
    const callOrder = [];

    const executor = async (node) => {
      callOrder.push(node.id);
      return node.id;
    };

    const result = await executePlanningFlow(graph, {
      startId: "X",
      executor
    });

    // From X in a 3-cycle, the engine should visit Y and Z once each
    // and then stop, not looping forever.
    // Acceptable orders: ["X","Y","Z"], ["X","Z","Y"], etc.,
    // as long as:
    //   * X is first
    //   * each node appears exactly once
    expect(callOrder[0]).toBe("X");
    const sortedUnique = [...new Set(callOrder)].sort();
    expect(sortedUnique).toEqual(["X", "Y", "Z"].sort());
    expect(callOrder.length).toBe(3);

    // Result should reflect the same execution order.
    expect(result.executionOrder).toEqual(callOrder);

    // All nodes should have results.
    expect(Object.keys(result.results).sort()).toEqual(["X", "Y", "Z"].sort());

    // No errors or skipped nodes in this simple cycle case.
    expect(result.errors).toEqual({});
    expect(result.skipped).toEqual([]);
  });
});
