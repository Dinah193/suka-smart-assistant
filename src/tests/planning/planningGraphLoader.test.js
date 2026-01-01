// C:\Users\larho\suka-smart-assistant\src\tests\planning\planningGraphLoader.test.js
// -----------------------------------------------------------------------------
// Tests for loading and parsing Planning Graph JSON configs
//
// HOW THIS FITS
// --------------
// These tests define the invariants for the Planning Graph loader used by SSA's
// Planning Graph layer. The Planning Graph coordinates calculators, planners,
// and session generators across domains (cooking, cleaning, garden, animals,
// preservation, storehouse, calendar, stability, etc.).
//
// The loader should:
//   * Accept a raw JSON config object (e.g. imported from .json files).
//   * Normalize nodes and edges into a consistent in-memory graph shape.
//   * Build indexes for fast lookup (nodesById, incoming/outgoing edges).
//   * Detect invalid references (edges referring to unknown nodes) and throw.
//   * Identify roots (no incoming edges) and leaves (no outgoing edges).
//   * Be deterministic (same input → same output).
//
// ASSUMED PUBLIC API
// ------------------
// Adjust the import path if your implementation lives elsewhere.
//
//   import { loadPlanningGraphFromConfig } from
//     "@/services/planning/planningGraphLoader.js";
//
// The loader returns a "PlanningGraph" object:
//
//   {
//     version: number,
//     nodes: Array<{
//       id: string,
//       type: string,             // e.g. "calculator" | "planner" | "session"
//       label: string,
//       domain?: string | null,   // e.g. "storehouse" | "calendar" | "stability"
//       meta?: Record<string, any>
//     }>,
//     edges: Array<{
//       from: string,
//       to: string,
//       kind: string              // e.g. "feedsInto" | "dependsOn"
//     }>,
//     index: {
//       nodesById: Record<string, any>,
//       incoming: Record<string, Array<{ from: string, to: string, kind: string }>>,
//       outgoing: Record<string, Array<{ from: string, to: string, kind: string }>>
//     },
//     roots: string[],            // node ids with no incoming edges
//     leaves: string[]            // node ids with no outgoing edges
//   }
//
// The specific scoring and runtime wiring of the Planning Graph is handled
// elsewhere (calculators, SessionRunner, etc.). These tests only care about
// parsing and normalization.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { loadPlanningGraphFromConfig } from "@/services/planning/planningGraphLoader.js";

// -----------------------------------------------------------------------------
// Helper: sample minimal but realistic Planning Graph config
// -----------------------------------------------------------------------------

const SAMPLE_CONFIG = {
  version: 1,
  nodes: [
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
      id: "garden-yield",
      type: "calculator",
      label: "Garden Yield Calculator",
      domain: "garden"
    },
    {
      id: "stability-score",
      type: "calculator",
      label: "Household Stability Score",
      domain: "stability"
    }
  ],
  edges: [
    {
      from: "storehouse-goals",
      to: "meal-planner",
      kind: "feedsInto"
    },
    {
      from: "garden-yield",
      to: "storehouse-goals",
      kind: "feedsInto"
    },
    {
      from: "storehouse-goals",
      to: "stability-score",
      kind: "feedsInto"
    }
  ]
};

// -----------------------------------------------------------------------------
// Common shape assertions
// -----------------------------------------------------------------------------

/**
 * Basic shape & range checks for a PlanningGraph.
 * @param {any} graph
 */
function expectPlanningGraphShape(graph) {
  expect(graph).toBeTruthy();
  expect(typeof graph).toBe("object");

  // version
  expect(graph).toHaveProperty("version");
  expect(typeof graph.version).toBe("number");

  // nodes
  expect(Array.isArray(graph.nodes)).toBe(true);
  expect(graph.nodes.length).toBeGreaterThan(0);

  graph.nodes.forEach((node) => {
    expect(typeof node.id).toBe("string");
    expect(node.id.length).toBeGreaterThan(0);
    expect(typeof node.type).toBe("string");
    expect(node.type.length).toBeGreaterThan(0);
    expect(typeof node.label).toBe("string");
    expect(node.label.length).toBeGreaterThan(0);
    if (node.domain != null) {
      expect(typeof node.domain).toBe("string");
    }
  });

  // edges
  expect(Array.isArray(graph.edges)).toBe(true);
  graph.edges.forEach((edge) => {
    expect(typeof edge.from).toBe("string");
    expect(typeof edge.to).toBe("string");
    expect(edge.from.length).toBeGreaterThan(0);
    expect(edge.to.length).toBeGreaterThan(0);
    expect(typeof edge.kind).toBe("string");
    expect(edge.kind.length).toBeGreaterThan(0);
  });

  // index
  expect(graph).toHaveProperty("index");
  expect(typeof graph.index).toBe("object");

  const { index } = graph;
  expect(index).toHaveProperty("nodesById");
  expect(typeof index.nodesById).toBe("object");
  expect(index).toHaveProperty("incoming");
  expect(typeof index.incoming).toBe("object");
  expect(index).toHaveProperty("outgoing");
  expect(typeof index.outgoing).toBe("object");

  // roots & leaves
  expect(Array.isArray(graph.roots)).toBe(true);
  expect(Array.isArray(graph.leaves)).toBe(true);
}

// -----------------------------------------------------------------------------
// 1) Happy path: basic config → normalized graph
// -----------------------------------------------------------------------------

describe("planningGraphLoader – basic loading/normalization", () => {
  it("loads a valid config into a well-shaped PlanningGraph", () => {
    const graph = loadPlanningGraphFromConfig(SAMPLE_CONFIG);

    expectPlanningGraphShape(graph);

    // Version should be preserved from config
    expect(graph.version).toBe(1);

    // Node ids should be indexable
    expect(Object.keys(graph.index.nodesById).length).toBe(
      SAMPLE_CONFIG.nodes.length
    );

    SAMPLE_CONFIG.nodes.forEach((n) => {
      expect(graph.index.nodesById[n.id]).toBeTruthy();
      expect(graph.index.nodesById[n.id].label).toBe(n.label);
    });

    // Edges should be present and mapped to outgoing/incoming indices
    SAMPLE_CONFIG.edges.forEach((e) => {
      const out = graph.index.outgoing[e.from] || [];
      const incoming = graph.index.incoming[e.to] || [];

      expect(out.some((edge) => edge.to === e.to && edge.kind === e.kind)).toBe(
        true
      );
      expect(
        incoming.some((edge) => edge.from === e.from && edge.kind === e.kind)
      ).toBe(true);
    });
  });

  it("identifies roots and leaves from edge structure", () => {
    const graph = loadPlanningGraphFromConfig(SAMPLE_CONFIG);

    expectPlanningGraphShape(graph);

    // In SAMPLE_CONFIG:
    //   garden-yield      → storehouse-goals
    //   storehouse-goals  → meal-planner, stability-score
    // So:
    //   roots: garden-yield (no incoming)
    //   leaves: meal-planner, stability-score (no outgoing)

    const sortedRoots = [...graph.roots].sort();
    const sortedLeaves = [...graph.leaves].sort();

    expect(sortedRoots).toEqual(["garden-yield"]);
    expect(sortedLeaves).toEqual(["meal-planner", "stability-score"].sort());
  });
});

// -----------------------------------------------------------------------------
// 2) Invalid configs – unknown node references etc.
// -----------------------------------------------------------------------------

describe("planningGraphLoader – invalid configs", () => {
  it("throws when an edge references a non-existent node id", () => {
    const BAD_CONFIG = {
      version: 1,
      nodes: [
        {
          id: "a",
          type: "calculator",
          label: "A"
        }
      ],
      edges: [
        {
          from: "a",
          to: "missing-node",
          kind: "feedsInto"
        }
      ]
    };

    expect(() => loadPlanningGraphFromConfig(BAD_CONFIG)).toThrowError();
  });

  it("throws for missing or malformed nodes list", () => {
    const NO_NODES_CONFIG = {
      version: 1,
      edges: []
    };

    expect(() => loadPlanningGraphFromConfig(NO_NODES_CONFIG)).toThrowError();

    const NON_ARRAY_NODES_CONFIG = {
      version: 1,
      nodes: {},
      edges: []
    };

    expect(() =>
      loadPlanningGraphFromConfig(NON_ARRAY_NODES_CONFIG)
    ).toThrowError();
  });
});

// -----------------------------------------------------------------------------
// 3) Determinism – same input → same output
// -----------------------------------------------------------------------------

describe("planningGraphLoader – determinism", () => {
  it("returns identical graphs for identical configs", () => {
    const config = SAMPLE_CONFIG;

    const graph1 = loadPlanningGraphFromConfig(config);
    const graph2 = loadPlanningGraphFromConfig(config);

    expectPlanningGraphShape(graph1);
    expectPlanningGraphShape(graph2);

    // Compare basic invariants; exact deep equality isn't strictly required,
    // but key structures should match.
    expect(graph1.version).toBe(graph2.version);
    expect(graph1.nodes.length).toBe(graph2.nodes.length);
    expect(graph1.edges.length).toBe(graph2.edges.length);

    const ids1 = graph1.nodes.map((n) => n.id).sort();
    const ids2 = graph2.nodes.map((n) => n.id).sort();
    expect(ids1).toEqual(ids2);

    const edges1 = graph1.edges
      .map((e) => `${e.from}->${e.to}:${e.kind}`)
      .sort();
    const edges2 = graph2.edges
      .map((e) => `${e.from}->${e.to}:${e.kind}`)
      .sort();
    expect(edges1).toEqual(edges2);

    const roots1 = [...graph1.roots].sort();
    const roots2 = [...graph2.roots].sort();
    const leaves1 = [...graph1.leaves].sort();
    const leaves2 = [...graph2.leaves].sort();
    expect(roots1).toEqual(roots2);
    expect(leaves1).toEqual(leaves2);
  });
});

// -----------------------------------------------------------------------------
// 4) Optional fields – edges inferred from node metadata if desired
// -----------------------------------------------------------------------------

describe("planningGraphLoader – optional inference from node definitions", () => {
  it("can infer edges from node 'feedsInto' arrays when edges are omitted", () => {
    const CONFIG_WITH_FEEDS_INTO = {
      version: 2,
      nodes: [
        {
          id: "seed-viability",
          type: "calculator",
          label: "Seed Viability",
          domain: "garden",
          // This field is *optional* for the loader implementation, but if
          // supported, it should be converted into edges internally.
          feedsInto: ["garden-yield"]
        },
        {
          id: "garden-yield",
          type: "calculator",
          label: "Garden Yield Calculator",
          domain: "garden"
        }
      ]
      // Note: no explicit edges[] array.
    };

    const graph = loadPlanningGraphFromConfig(CONFIG_WITH_FEEDS_INTO);
    expectPlanningGraphShape(graph);

    // We expect at least one edge from seed-viability to garden-yield
    const outgoingSeed = graph.index.outgoing["seed-viability"] || [];
    const incomingYield = graph.index.incoming["garden-yield"] || [];

    const hasSeedToYield = outgoingSeed.some(
      (e) => e.to === "garden-yield"
    );
    const hasYieldFromSeed = incomingYield.some(
      (e) => e.from === "seed-viability"
    );

    expect(hasSeedToYield || hasYieldFromSeed).toBe(true);

    // Version should be preserved
    expect(graph.version).toBe(2);
  });
});
