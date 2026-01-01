// C:\Users\larho\suka-smart-assistant\src\features\planning\usePlanningGraph.js

/**
 * usePlanningGraph
 * -----------------
 * How this fits SSA:
 * - The "Planning Graph" is the web of meaning behind SSA: nodes are planners,
 *   calculators, and tools; edges describe how outputs of one node feed into
 *   another (e.g., Macro Calculator → Storehouse Planner → Batch Cooking).
 * - Domain pages (cooking, cleaning, garden, animals, preservation, storehouse)
 *   can use this hook to:
 *     • Discover which calculators/planners belong to a domain.
 *     • Find upstream/downstream dependencies (neighbors).
 *     • Power "Now" buttons by understanding what a session depends on.
 * - This file is read-only: it provides query utilities on top of an
 *   in-memory Planning Graph store. Another part of SSA should call
 *   `setPlanningGraphData()` at startup (after loading from Dexie / JSON).
 *
 * Design:
 * - Small internal store + `useSyncExternalStore` for React-safe subscriptions.
 * - Normalizes nodes/edges and builds indices and adjacency maps.
 * - Pure query helpers (no side-effects, no eventBus/Hubs here).
 */

/* eslint-disable no-console */

import { useMemo, useSyncExternalStore } from "react";

/**
 * @typedef {Object} PlanningNode
 * @property {string} id                    Unique node id (e.g. "node.macroCalculator")
 * @property {string} domain                One of: "cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"
 * @property {string} [kind]                Node kind (e.g. "calculator"|"planner"|"sessionTemplate")
 * @property {string} [title]               Human-readable name
 * @property {string} [description]         Optional description for UI/tooltips
 * @property {string[]} [tags]              Tag hints (e.g. ["protein","storehouse"])
 * @property {Object.<string, any>} [meta]  Arbitrary metadata (config, schema refs, etc.)
 */

/**
 * @typedef {Object} PlanningEdge
 * @property {string} id                    Unique edge id (e.g. "edge.macro→storehouse")
 * @property {string} from                  Source node id
 * @property {string} to                    Target node id
 * @property {string} [relation]            Relation kind (e.g. "feedsInto"|"requires"|"suggests")
 * @property {number} [weight]              Optional weight/strength
 * @property {Object.<string, any>} [meta]  Arbitrary metadata (e.g. "phase":"planning")
 */

/**
 * @typedef {Object} RawPlanningGraph
 * @property {PlanningNode[]} [nodes]
 * @property {PlanningEdge[]} [edges]
 * @property {string[]} [domains]
 */

/**
 * @typedef {Object} NormalizedPlanningGraph
 * @property {PlanningNode[]} nodes
 * @property {PlanningEdge[]} edges
 * @property {string[]} domains
 * @property {Record<string, PlanningNode>} nodeIndex
 * @property {Record<string, PlanningEdge[]>} adjacencyOut
 * @property {Record<string, PlanningEdge[]>} adjacencyIn
 */

/** @type {NormalisedEmptyGraphFactory} */
const createEmptyGraph = () => ({
  nodes: [],
  edges: [],
  domains: [],
  nodeIndex: Object.create(null),
  adjacencyOut: Object.create(null),
  adjacencyIn: Object.create(null),
});

/**
 * @callback NormalisedEmptyGraphFactory
 * @returns {NormalizedPlanningGraph}
 */

/** @type {NormalizedPlanningGraph} */
let graphState = createEmptyGraph();

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Subscribe function for useSyncExternalStore.
 * @param {() => void} listener
 * @returns {() => void}
 */
function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Snapshot getter for useSyncExternalStore (client).
 * @returns {NormalizedPlanningGraph}
 */
function getSnapshot() {
  return graphState;
}

/**
 * Snapshot getter for useSyncExternalStore (server / SSR).
 * We just reuse the current snapshot.
 * @returns {NormalizedPlanningGraph}
 */
function getServerSnapshot() {
  return graphState;
}

/**
 * Normalize raw graph data into an indexed, adjacency-rich representation.
 *
 * @param {RawPlanningGraph | null | undefined} raw
 * @returns {NormalizedPlanningGraph}
 */
function normalizeGraph(raw) {
  if (!raw || typeof raw !== "object") {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[PlanningGraph] normalizeGraph called with invalid value, using empty graph.");
    }
    return createEmptyGraph();
  }

  const nodes = Array.isArray(raw.nodes) ? raw.nodes.filter(Boolean) : [];
  const edges = Array.isArray(raw.edges) ? raw.edges.filter(Boolean) : [];

  /** @type {Record<string, PlanningNode>} */
  const nodeIndex = Object.create(null);

  /** @type {Record<string, PlanningEdge[]>} */
  const adjacencyOut = Object.create(null);
  /** @type {Record<string, PlanningEdge[]>} */
  const adjacencyIn = Object.create(null);

  /** @type {Set<string>} */
  const domainSet = new Set(Array.isArray(raw.domains) ? raw.domains : []);

  // Index nodes + collect domains
  for (const node of nodes) {
    if (!node || typeof node.id !== "string") continue;
    nodeIndex[node.id] = node;
    if (node.domain && typeof node.domain === "string") {
      domainSet.add(node.domain);
    }
  }

  // Build adjacency maps, but only keep edges between known nodes
  const filteredEdges = [];
  for (const edge of edges) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    if (!nodeIndex[edge.from] || !nodeIndex[edge.to]) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[PlanningGraph] Dropping edge with missing nodes:", edge);
      }
      continue;
    }
    filteredEdges.push(edge);

    if (!adjacencyOut[edge.from]) adjacencyOut[edge.from] = [];
    if (!adjacencyIn[edge.to]) adjacencyIn[edge.to] = [];
    adjacencyOut[edge.from].push(edge);
    adjacencyIn[edge.to].push(edge);
  }

  return {
    nodes,
    edges: filteredEdges,
    domains: Array.from(domainSet).sort(),
    nodeIndex,
    adjacencyOut,
    adjacencyIn,
  };
}

/**
 * External API: set the Planning Graph data.
 *
 * Call this once SSA has loaded the Planning Graph from Dexie, a JSON file,
 * or a remote source. You can call it again if the graph changes; all
 * subscribers (hooks) will re-render.
 *
 * @param {RawPlanningGraph | null | undefined} raw
 */
export function setPlanningGraphData(raw) {
  const next = normalizeGraph(raw);
  graphState = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      // Defensive: never let a bad listener break others.
      // eslint-disable-next-line no-console
      console.error("[PlanningGraph] Listener error:", err);
    }
  }
}

/**
 * External API: get a snapshot of the current Planning Graph
 * without subscribing to changes. Useful in non-React modules.
 *
 * @returns {NormalizedPlanningGraph}
 */
export function getPlanningGraphSnapshot() {
  return graphState;
}

/**
 * Helper: get node by id from a given graph snapshot.
 *
 * @param {NormalizedPlanningGraph} graph
 * @param {string} nodeId
 * @returns {PlanningNode | null}
 */
function getNodeFromGraph(graph, nodeId) {
  if (!graph || !graph.nodeIndex || typeof nodeId !== "string") return null;
  return graph.nodeIndex[nodeId] || null;
}

/**
 * Helper: get neighbor nodes for a given node id.
 *
 * @param {NormalizedPlanningGraph} graph
 * @param {string} nodeId
 * @param {"in"|"out"|"both"} direction
 * @returns {{ edges: PlanningEdge[], nodes: PlanningNode[] }}
 */
function getNeighborsFromGraph(graph, nodeId, direction = "both") {
  if (!graph || typeof nodeId !== "string" || !nodeId) {
    return { edges: [], nodes: [] };
  }

  const seenEdges = new Set();
  const neighborEdges = [];

  const pushEdges = (edges) => {
    if (!Array.isArray(edges)) return;
    for (const e of edges) {
      if (!e || !e.id) continue;
      if (seenEdges.has(e.id)) continue;
      seenEdges.add(e.id);
      neighborEdges.push(e);
    }
  };

  if (direction === "out" || direction === "both") {
    pushEdges(graph.adjacencyOut[nodeId]);
  }
  if (direction === "in" || direction === "both") {
    pushEdges(graph.adjacencyIn[nodeId]);
  }

  const neighborNodes = [];
  const seenNodes = new Set();

  for (const edge of neighborEdges) {
    const otherId =
      edge.from === nodeId ? edge.to :
      edge.to === nodeId ? edge.from :
      null;

    if (!otherId) continue;
    if (seenNodes.has(otherId)) continue;

    const node = graph.nodeIndex[otherId];
    if (node) {
      seenNodes.add(otherId);
      neighborNodes.push(node);
    }
  }

  return { edges: neighborEdges, nodes: neighborNodes };
}

/**
 * Helper: find nodes belonging to a specific domain.
 *
 * @param {NormalizedPlanningGraph} graph
 * @param {string} domain
 * @returns {PlanningNode[]}
 */
function getDomainNodesFromGraph(graph, domain) {
  if (!graph || !Array.isArray(graph.nodes) || !domain) return [];
  return graph.nodes.filter((n) => n && n.domain === domain);
}

/**
 * Helper: return a small domain-specific subgraph.
 *
 * @param {NormalizedPlanningGraph} graph
 * @param {string} domain
 * @returns {{ nodes: PlanningNode[], edges: PlanningEdge[] }}
 */
function getDomainSubgraph(graph, domain) {
  const domainNodes = getDomainNodesFromGraph(graph, domain);
  if (!domainNodes.length) return { nodes: [], edges: [] };

  const nodeIds = new Set(domainNodes.map((n) => n.id));
  const edges = graph.edges.filter(
    (e) => nodeIds.has(e.from) || nodeIds.has(e.to)
  );
  return { nodes: domainNodes, edges };
}

/**
 * Helper: naive "next runnable sessions for domain" finder.
 * This is intentionally simple and domain-agnostic; more elaborate
 * logic (guards, inventory, etc.) should live near SessionRunner.
 *
 * @param {string} domain
 * @param {Array<import("@/features/sessions/types").Session>|Array<any>} allSessions
 * @returns {any[]} Filtered & sorted sessions
 */
function findNextRunnableSessionsForDomain(domain, allSessions) {
  if (!Array.isArray(allSessions) || !domain) return [];
  const runnableStatuses = new Set(["pending", "paused"]);

  const subset = allSessions.filter(
    (s) =>
      s &&
      s.domain === domain &&
      s.status &&
      runnableStatuses.has(s.status)
  );

  // Sort by createdAt ascending, fallback to id for stability
  return subset.sort((a, b) => {
    const aCreated = a.createdAt ? Date.parse(a.createdAt) || 0 : 0;
    const bCreated = b.createdAt ? Date.parse(b.createdAt) || 0 : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    if (a.id && b.id && a.id !== b.id) return a.id.localeCompare(b.id);
    return 0;
  });
}

/**
 * React hook: subscribe to the Planning Graph and expose
 * rich query helpers for nodes, edges, neighbors, and domains.
 *
 * Example:
 *   const {
 *     graph,
 *     listDomains,
 *     listNodes,
 *     listEdges,
 *     getNodeById,
 *     getNeighbors,
 *     getInboundNeighbors,
 *     getOutboundNeighbors,
 *     getDomainNodes,
 *     getDomainSubgraph,
 *     getNextRunnableSessionsForDomain,
 *   } = usePlanningGraph();
 *
 * @returns {{
 *   graph: NormalizedPlanningGraph,
 *   listDomains: () => string[],
 *   listNodes: () => PlanningNode[],
 *   listEdges: () => PlanningEdge[],
 *   getNodeById: (id: string) => PlanningNode | null,
 *   getNeighbors: (id: string, direction?: "in"|"out"|"both") => { edges: PlanningEdge[], nodes: PlanningNode[] },
 *   getInboundNeighbors: (id: string) => { edges: PlanningEdge[], nodes: PlanningNode[] },
 *   getOutboundNeighbors: (id: string) => { edges: PlanningEdge[], nodes: PlanningNode[] },
 *   getDomainNodes: (domain: string) => PlanningNode[],
 *   getDomainSubgraph: (domain: string) => { nodes: PlanningNode[], edges: PlanningEdge[] },
 *   getNextRunnableSessionsForDomain: (domain: string, sessions: any[]) => any[],
 * }}
 */
export function usePlanningGraph() {
  const graph = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Memoize helpers so callers always get stable function identities.
  const helpers = useMemo(() => {
    /**
     * List domains known to the Planning Graph.
     * @returns {string[]}
     */
    const listDomains = () => graph.domains.slice();

    /**
     * List all nodes.
     * @returns {PlanningNode[]}
     */
    const listNodes = () => graph.nodes.slice();

    /**
     * List all edges.
     * @returns {PlanningEdge[]}
     */
    const listEdges = () => graph.edges.slice();

    /**
     * Get node by id.
     * @param {string} id
     * @returns {PlanningNode | null}
     */
    const getNodeById = (id) => getNodeFromGraph(graph, id);

    /**
     * Get neighbors (in + out) for a given node.
     * @param {string} id
     * @param {"in"|"out"|"both"} [direction="both"]
     * @returns {{ edges: PlanningEdge[], nodes: PlanningNode[] }}
     */
    const getNeighbors = (id, direction = "both") =>
      getNeighborsFromGraph(graph, id, direction);

    /**
     * Inbound neighbors only (dependencies feeding into this node).
     * @param {string} id
     * @returns {{ edges: PlanningEdge[], nodes: PlanningNode[] }}
     */
    const getInboundNeighbors = (id) =>
      getNeighborsFromGraph(graph, id, "in");

    /**
     * Outbound neighbors only (nodes this one feeds into).
     * @param {string} id
     * @returns {{ edges: PlanningEdge[], nodes: PlanningNode[] }}
     */
    const getOutboundNeighbors = (id) =>
      getNeighborsFromGraph(graph, id, "out");

    /**
     * Get all nodes belonging to a domain.
     * @param {string} domain
     * @returns {PlanningNode[]}
     */
    const getDomainNodes = (domain) =>
      getDomainNodesFromGraph(graph, domain);

    /**
     * Get the subgraph for a given domain.
     * @param {string} domain
     * @returns {{ nodes: PlanningNode[], edges: PlanningEdge[] }}
     */
    const getDomainSubgraph = (domain) =>
      getDomainSubgraph(graph, domain);

    /**
     * Given a domain and a list of sessions, return the ordered list
     * of "next runnable" sessions. This is intentionally simple and
     * can be combined with guard logic near SessionRunner.
     *
     * @param {string} domain
     * @param {any[]} sessions
     * @returns {any[]}
     */
    const getNextRunnableSessionsForDomain = (domain, sessions) =>
      findNextRunnableSessionsForDomain(domain, sessions);

    return {
      graph,
      listDomains,
      listNodes,
      listEdges,
      getNodeById,
      getNeighbors,
      getInboundNeighbors,
      getOutboundNeighbors,
      getDomainNodes,
      getDomainSubgraph,
      getNextRunnableSessionsForDomain,
    };
  }, [graph]);

  return helpers;
}
