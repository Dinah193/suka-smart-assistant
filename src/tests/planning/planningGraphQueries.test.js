// C:\Users\larho\suka-smart-assistant\src\tests\planning\planningGraphQueries.test.js
// -----------------------------------------------------------------------------
// Tests for Planning Graph query helpers
//
// HOW THIS FITS
// --------------
// The Planning Graph coordinates calculators, planners, and session generators
// across SSA domains (cooking, cleaning, garden, animals, preservation,
// storehouse, calendar, stability, etc.). The query helpers provide fast,
// reusable ways to:
//
//   * Look up nodes by id.
//   * Ask "what feeds into this?" or "what does this feed into?".
//   * Walk ancestors/descendants across multiple hops.
//   * Ask domain-scoped questions (e.g. all garden nodes).
//   * Find a shortest path between two nodes for visualization or dependency
//     resolution before creating/running sessions.
//
// These tests define the contract for the helpers exported from:
//   "@/services/planning/planningGraphQueries.js"
//
// ASSUMED PUBLIC API
// ------------------
//
//   import {
//     getNodeById,
//     getIncomingEdges,
//     getOutgoingEdges,
//     getAncestors,
//     getDescendants,
//     findShortestPath,
//     getDomainNodes
//   } from "@/services/planning/planningGraphQueries.js";
//
// All helpers accept a normalized PlanningGraph produced by
// loadPlanningGraphFromConfig (see planningGraphLoader.test.js):
//
//   {
//     version: number,
//     nodes: Array<{ id, type, label, domain?, meta? }>
//     edges: Array<{ from, to, kind }>
//     index: {
//       nodesById: Record<string, Node>,
//       incoming: Record<string, Edge[]>,
//       outgoing: Record<string, Edge[]>
//     },
//     roots: string[],
//     leaves: string[]
//   }
//
// The helpers must be pure and must NOT mutate the graph.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { loadPlanningGraphFromConfig } from "@/services/planning/planningGraphLoader.js";
import {
  getNodeById,
  getIncomingEdges,
  getOutgoingEdges,
  getAncestors,
  getDescendants,
  findShortestPath,
  getDomainNodes
} from "@/services/planning/planningGraphQueries.js";

// -----------------------------------------------------------------------------
// Shared fixture: acyclic multi-domain graph
// -----------------------------------------------------------------------------
//
// Structure (arrows are edges .kind = "feedsInto"):
//
//   seed-viability (garden, calculator)  →  garden-yield (garden, calculator)
//   garden-yield                         →  storehouse-goals (storehouse, calculator)
//   storehouse-goals                     →  meal-planner (cooking, planner)
//   storehouse-goals                     →  stability-score (stability, calculator)
//   calendar-feasts (calendar, calculator) → stability-score
//
// Roots: seed-viability, calendar-feasts
// Leaves: meal-planner, stability-score
//
// This is consistent with the broader Planning Graph you've been building
// (seed viability → yield → storehouse → meals/stability, with calendar inputs).

const ACYCLIC_CONFIG = {
  version: 1,
  nodes: [
    {
      id: "seed-viability",
      type: "calculator",
      label: "Seed Viability",
      domain: "garden"
    },
    {
      id: "garden-yield",
      type: "calculator",
      label: "Garden Yield Calculator",
      domain: "garden"
    },
    {
      id: "storehouse-goals",
      type: "calculator",
      label: "Storehouse Goals",
      domain: "storehouse"
    },
    {
      id: "meal-planner",
      type: "planner",
      label: "Meal Planner",
      domain: "cooking"
    },
    {
      id: "stability-score",
      type: "calculator",
      label: "Household Stability Score",
      domain: "stability"
    },
    {
      id: "calendar-feasts",
      type: "calculator",
      label: "Feast Day Alignment",
      domain: "calendar"
    }
  ],
  edges: [
    { from: "seed-viability", to: "garden-yield", kind: "feedsInto" },
    { from: "garden-yield", to: "storehouse-goals", kind: "feedsInto" },
    { from: "storehouse-goals", to: "meal-planner", kind: "feedsInto" },
    { from: "storehouse-goals", to: "stability-score", kind: "feedsInto" },
    { from: "calendar-feasts", to: "stability-score", kind: "feedsInto" }
  ]
};

function buildAcyclicGraph() {
  return loadPlanningGraphFromConfig(ACYCLIC_CONFIG);
}

// -----------------------------------------------------------------------------
// 1) Basic node and edge queries
// -----------------------------------------------------------------------------

describe("planningGraphQueries – basic node/edge queries", () => {
  it("getNodeById returns the node or null for unknown ids", () => {
    const graph = buildAcyclicGraph();

    const node = getNodeById(graph, "storehouse-goals");
    expect(node).toBeTruthy();
    expect(node.id).toBe("storehouse-goals");
    expect(node.domain).toBe("storehouse");

    const missing = getNodeById(graph, "does-not-exist");
    expect(missing).toBeNull();
  });

  it("getOutgoingEdges returns all edges originating from the node", () => {
    const graph = buildAcyclicGraph();

    const outStorehouse = getOutgoingEdges(graph, "storehouse-goals");
    expect(Array.isArray(outStorehouse)).toBe(true);

    const toIds = outStorehouse.map((e) => e.to).sort();
    expect(toIds).toEqual(["meal-planner", "stability-score"].sort());

    // Node with no outgoing edges is fine, should return empty array
    const outMeal = getOutgoingEdges(graph, "meal-planner");
    expect(Array.isArray(outMeal)).toBe(true);
    expect(outMeal.length).toBe(0);
  });

  it("getIncomingEdges returns all edges arriving at the node", () => {
    const graph = buildAcyclicGraph();

    const inStorehouse = getIncomingEdges(graph, "storehouse-goals");
    expect(Array.isArray(inStorehouse)).toBe(true);
    expect(inStorehouse.length).toBe(1);
    expect(inStorehouse[0].from).toBe("garden-yield");

    const inStability = getIncomingEdges(graph, "stability-score");
    const fromIds = inStability.map((e) => e.from).sort();
    expect(fromIds).toEqual(["calendar-feasts", "storehouse-goals"].sort());

    // Node with no incoming edges is fine, should return empty array
    const inSeed = getIncomingEdges(graph, "seed-viability");
    expect(Array.isArray(inSeed)).toBe(true);
    expect(inSeed.length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// 2) Ancestors & descendants
// -----------------------------------------------------------------------------

describe("planningGraphQueries – ancestors/descendants", () => {
  it("getAncestors returns all upstream node ids (multi-hop, deduped)", () => {
    const graph = buildAcyclicGraph();

    // meal-planner should have ancestors: storehouse-goals, garden-yield, seed-viability
    const ancestorsMeal = getAncestors(graph, "meal-planner");
    const sortedMeal = [...ancestorsMeal].sort();
    expect(sortedMeal).toEqual(
      ["storehouse-goals", "garden-yield", "seed-viability"].sort()
    );

    // stability-score should have ancestors from both calendar and storehouse chains
    const ancestorsStability = getAncestors(graph, "stability-score");
    const sortedStability = [...ancestorsStability].sort();
    expect(sortedStability).toEqual(
      [
        "storehouse-goals",
        "garden-yield",
        "seed-viability",
        "calendar-feasts"
      ].sort()
    );

    // root node should have no ancestors
    const ancestorsSeed = getAncestors(graph, "seed-viability");
    expect(Array.isArray(ancestorsSeed)).toBe(true);
    expect(ancestorsSeed.length).toBe(0);
  });

  it("getDescendants returns all downstream node ids (multi-hop, deduped)", () => {
    const graph = buildAcyclicGraph();

    // seed-viability should reach garden-yield, storehouse-goals, meal-planner, stability-score
    const descendantsSeed = getDescendants(graph, "seed-viability");
    const sortedSeed = [...descendantsSeed].sort();
    expect(sortedSeed).toEqual(
      [
        "garden-yield",
        "storehouse-goals",
        "meal-planner",
        "stability-score"
      ].sort()
    );

    // calendar-feasts should reach stability-score only
    const descendantsCalendar = getDescendants(graph, "calendar-feasts");
    expect(descendantsCalendar).toEqual(["stability-score"]);

    // leaf node should have no descendants
    const descendantsMeal = getDescendants(graph, "meal-planner");
    expect(Array.isArray(descendantsMeal)).toBe(true);
    expect(descendantsMeal.length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// 3) Shortest path queries
// -----------------------------------------------------------------------------

describe("planningGraphQueries – findShortestPath", () => {
  it("finds a shortest path in straightforward chains", () => {
    const graph = buildAcyclicGraph();

    const pathSeedToMeal = findShortestPath(
      graph,
      "seed-viability",
      "meal-planner"
    );

    // Should include both endpoints and all intermediate nodes
    expect(pathSeedToMeal).toEqual([
      "seed-viability",
      "garden-yield",
      "storehouse-goals",
      "meal-planner"
    ]);

    const pathGardenToStability = findShortestPath(
      graph,
      "garden-yield",
      "stability-score"
    );
    expect(pathGardenToStability).toEqual([
      "garden-yield",
      "storehouse-goals",
      "stability-score"
    ]);
  });

  it("returns null when no path exists", () => {
    const graph = buildAcyclicGraph();

    // No path from meal-planner back upstream; graph is directed.
    const pathMealToSeed = findShortestPath(
      graph,
      "meal-planner",
      "seed-viability"
    );
    expect(pathMealToSeed).toBeNull();

    // Unknown node ids should also result in null (defensive behavior)
    const pathUnknown = findShortestPath(graph, "does-not-exist", "meal-planner");
    expect(pathUnknown).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 4) Domain-scoped queries
// -----------------------------------------------------------------------------

describe("planningGraphQueries – domain helpers", () => {
  it("getDomainNodes returns all nodes for a given domain", () => {
    const graph = buildAcyclicGraph();

    const gardenNodes = getDomainNodes(graph, "garden");
    const gardenIds = gardenNodes.map((n) => n.id).sort();
    expect(gardenIds).toEqual(["seed-viability", "garden-yield"].sort());

    const storehouseNodes = getDomainNodes(graph, "storehouse");
    const storehouseIds = storehouseNodes.map((n) => n.id);
    expect(storehouseIds).toEqual(["storehouse-goals"]);

    const unknownDomainNodes = getDomainNodes(graph, "non-existent-domain");
    expect(Array.isArray(unknownDomainNodes)).toBe(true);
    expect(unknownDomainNodes.length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// 5) Cycles: ancestors/descendants must NOT infinite-loop
// -----------------------------------------------------------------------------

describe("planningGraphQueries – cycle safety", () => {
  const CYCLIC_CONFIG = {
    version: 1,
    nodes: [
      { id: "x", type: "calculator", label: "X", domain: "test" },
      { id: "y", type: "calculator", label: "Y", domain: "test" },
      { id: "z", type: "calculator", label: "Z", domain: "test" }
    ],
    edges: [
      { from: "x", to: "y", kind: "feedsInto" },
      { from: "y", to: "z", kind: "feedsInto" },
      { from: "z", to: "x", kind: "feedsInto" } // cycle x → y → z → x
    ]
  };

  function buildCyclicGraph() {
    return loadPlanningGraphFromConfig(CYCLIC_CONFIG);
  }

  it("getAncestors returns a finite, deduped set even when cycles exist", () => {
    const graph = buildCyclicGraph();

    const ancestorsX = getAncestors(graph, "x").sort();
    const ancestorsY = getAncestors(graph, "y").sort();
    const ancestorsZ = getAncestors(graph, "z").sort();

    // In a 3-cycle, each node's ancestors should be the other two nodes,
    // but the implementation is free to include all reachable upstream nodes
    // once; the key invariant is: finite + deduped + does not include self.
    expect(ancestorsX).toEqual(["y", "z"].sort());
    expect(ancestorsY).toEqual(["x", "z"].sort());
    expect(ancestorsZ).toEqual(["x", "y"].sort());
  });

  it("getDescendants returns a finite, deduped set even when cycles exist", () => {
    const graph = buildCyclicGraph();

    const descendantsX = getDescendants(graph, "x").sort();
    const descendantsY = getDescendants(graph, "y").sort();
    const descendantsZ = getDescendants(graph, "z").sort();

    // Symmetric to ancestors in this simple cycle.
    expect(descendantsX).toEqual(["y", "z"].sort());
    expect(descendantsY).toEqual(["x", "z"].sort());
    expect(descendantsZ).toEqual(["x", "y"].sort());
  });

  it("findShortestPath in a cycle returns a valid, non-infinite path", () => {
    const graph = buildCyclicGraph();

    const pathXtoZ = findShortestPath(graph, "x", "z");
    // The shortest path should be x → y → z in this orientation.
    expect(pathXtoZ).toEqual(["x", "y", "z"]);

    // And we should still be able to go the other way (x ← z) via the cycle.
    const pathZtoX = findShortestPath(graph, "z", "x");
    expect(pathZtoX).toEqual(["z", "x"]);
  });
});
