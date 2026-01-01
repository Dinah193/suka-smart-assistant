// C:\Users\larho\suka-smart-assistant\src\services\planningGraph\planningGraphQueries.js

/**
 * Planning Graph Queries
 *
 * How this fits:
 * - High-level query utilities for the Planning Graph, built on top of the
 *   in-memory indexes from planningGraphIndex.js.
 *
 * Responsibilities:
 * - Provide async helpers that:
 *   • load + index a graph by id,
 *   • answer “neighbor” questions,
 *   • search by domain/type/tag,
 *   • compute basic paths (shortest path, simple walks).
 *
 * - Emit events so Stability, analytics, and automation can track:
 *   • which queries are used and how often,
 *   • how dense particular domains or subgraphs are.
 *
 * NOTE:
 * - These utilities are read-only & pure with respect to the graph data.
 * - They do not mutate the graph or the index.
 */

import eventBus from "@/services/eventBus";
import {
  getIndexedPlanningGraph,
  getSuccessors,
  getPredecessors,
  getNodesByDomain,
  getNodesByType,
  getNodesByTag,
} from "@/services/planningGraph/planningGraphIndex";

/**
 * @typedef {"out" | "in" | "both"} NeighborDirection
 */

/**
 * @typedef {Object} NeighborQueryOptions
 * @property {NeighborDirection} [direction="out"]  - edge direction
 * @property {boolean} [includeEdges=false]         - whether to return edges as well
 */

/**
 * @typedef {Object} NeighborQueryResult
 * @property {string} graphId
 * @property {string} version
 * @property {string} nodeId
 * @property {NeighborDirection} direction
 * @property {import("./planningGraphIndex").PlanningGraphNode[]} neighbors
 * @property {import("./planningGraphIndex").PlanningGraphEdge[]} [edgesOut]
 * @property {import("./planningGraphIndex").PlanningGraphEdge[]} [edgesIn]
 */

/**
 * @typedef {Object} PathQueryOptions
 * @property {number} [maxDepth=32]   - safety cap on BFS depth
 * @property {boolean} [includeVisited=false] - include BFS frontier/visited info
 */

/**
 * @typedef {Object} PathQueryResult
 * @property {string} graphId
 * @property {string} version
 * @property {string} fromId
 * @property {string} toId
 * @property {string[]} path           - ordered list of node ids from -> to (empty if none)
 * @property {number} hops             - path length in edges (0 if same node, -1 if none)
 * @property {number} [visitedCount]   - number of visited nodes (if includeVisited)
 */

/**
 * @typedef {Object} DomainQueryResult
 * @property {string} graphId
 * @property {string} version
 * @property {string} domain
 * @property {import("./planningGraphIndex").PlanningGraphNode[]} nodes
 */

/**
 * @typedef {Object} TypeQueryResult
 * @property {string} graphId
 * @property {string} version
 * @property {string} type
 * @property {import("./planningGraphIndex").PlanningGraphNode[]} nodes
 */

/**
 * @typedef {Object} TagQueryResult
 * @property {string} graphId
 * @property {string} version
 * @property {string} tag
 * @property {import("./planningGraphIndex").PlanningGraphNode[]} nodes
 */

/** ------------------------------------------------------------------------
 *  Neighbor Queries
 * --------------------------------------------------------------------- */

/**
 * Get neighbors for a node in a given graph, automatically loading + indexing
 * the graph via planningGraphIndex.
 *
 * @param {string} graphId
 * @param {string} nodeId
 * @param {NeighborQueryOptions} [options]
 * @returns {Promise<NeighborQueryResult>}
 */
export async function getNeighborsForNode(graphId, nodeId, options = {}) {
  const direction = options.direction || "out";
  const includeEdges = Boolean(options.includeEdges);

  const index = await getIndexedPlanningGraph(graphId);
  const neighbors = [];
  /** @type {import("./planningGraphIndex").PlanningGraphEdge[]} */
  const edgesOut = [];
  /** @type {import("./planningGraphIndex").PlanningGraphEdge[]} */
  const edgesIn = [];

  if (direction === "out" || direction === "both") {
    const succ = getSuccessors(index, nodeId);
    neighbors.push(...succ);
    if (includeEdges) {
      const outEdges = index.edgesFrom.get(nodeId) || [];
      edgesOut.push(...outEdges);
    }
  }

  if (direction === "in" || direction === "both") {
    const pred = getPredecessors(index, nodeId);
    neighbors.push(...pred);
    if (includeEdges) {
      const inEdges = index.edgesTo.get(nodeId) || [];
      edgesIn.push(...inEdges);
    }
  }

  const uniqueNeighbors = dedupeNodes(neighbors);

  /** @type {NeighborQueryResult} */
  const result = {
    graphId: index.id,
    version: index.version,
    nodeId,
    direction,
    neighbors: uniqueNeighbors,
  };

  if (includeEdges) {
    if (edgesOut.length) result.edgesOut = edgesOut;
    if (edgesIn.length) result.edgesIn = edgesIn;
  }

  emitQueryExecuted("neighbors", {
    graphId: index.id,
    version: index.version,
    nodeId,
    direction,
    neighborCount: uniqueNeighbors.length,
  });

  return result;
}

/** ------------------------------------------------------------------------
 *  Path queries
 * --------------------------------------------------------------------- */

/**
 * Find the shortest path (by edge count) between two nodes in a graph.
 * Uses BFS on outgoing edges only (directed edges).
 *
 * @param {string} graphId
 * @param {string} fromId
 * @param {string} toId
 * @param {PathQueryOptions} [options]
 * @returns {Promise<PathQueryResult>}
 */
export async function findShortestPath(graphId, fromId, toId, options = {}) {
  const index = await getIndexedPlanningGraph(graphId);
  const { path, hops, visitedCount } = findShortestPathInIndex(
    index,
    fromId,
    toId,
    options
  );

  /** @type {PathQueryResult} */
  const result = {
    graphId: index.id,
    version: index.version,
    fromId,
    toId,
    path,
    hops,
  };

  if (options.includeVisited) {
    result.visitedCount = visitedCount;
  }

  emitQueryExecuted("path.shortest", {
    graphId: index.id,
    version: index.version,
    fromId,
    toId,
    hops,
    visitedCount,
  });

  return result;
}

/**
 * Pure function that runs BFS on an existing index to find the shortest path.
 *
 * @param {import("./planningGraphIndex").PlanningGraphIndex} index
 * @param {string} fromId
 * @param {string} toId
 * @param {PathQueryOptions} [options]
 * @returns {{ path: string[], hops: number, visitedCount: number }}
 */
export function findShortestPathInIndex(index, fromId, toId, options = {}) {
  const maxDepth = typeof options.maxDepth === "number" ? options.maxDepth : 32;

  if (!index || !fromId || !toId) {
    return { path: [], hops: -1, visitedCount: 0 };
  }

  if (fromId === toId) {
    return { path: [fromId], hops: 0, visitedCount: 1 };
  }

  const visited = new Set();
  /** @type {Array<{ id: string, path: string[] }>} */
  const queue = [{ id: fromId, path: [fromId] }];
  visited.add(fromId);

  let visitedCount = 1;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const depth = current.path.length - 1;
    if (depth >= maxDepth) continue;

    const neighbors = getSuccessors(index, current.id) || [];
    for (const n of neighbors) {
      const nId = n.id;
      if (!nId || visited.has(nId)) continue;

      visited.add(nId);
      visitedCount += 1;

      const nextPath = current.path.concat(nId);

      if (nId === toId) {
        return { path: nextPath, hops: nextPath.length - 1, visitedCount };
      }

      queue.push({ id: nId, path: nextPath });
    }
  }

  return { path: [], hops: -1, visitedCount };
}

/** ------------------------------------------------------------------------
 *  Domain / Type / Tag Queries
 * --------------------------------------------------------------------- */

/**
 * Get all nodes within a given domain for a graphId (e.g., "cooking", "garden").
 *
 * @param {string} graphId
 * @param {string} domain
 * @returns {Promise<DomainQueryResult>}
 */
export async function getNodesForDomain(graphId, domain) {
  const index = await getIndexedPlanningGraph(graphId);
  const nodes = getNodesByDomain(index, domain);

  /** @type {DomainQueryResult} */
  const result = {
    graphId: index.id,
    version: index.version,
    domain,
    nodes,
  };

  emitQueryExecuted("nodes.byDomain", {
    graphId: index.id,
    version: index.version,
    domain,
    count: nodes.length,
  });

  return result;
}

/**
 * Get all nodes of a given type (e.g., "calculator", "sessionTemplate").
 *
 * @param {string} graphId
 * @param {string} type
 * @returns {Promise<TypeQueryResult>}
 */
export async function getNodesForType(graphId, type) {
  const index = await getIndexedPlanningGraph(graphId);
  const nodes = getNodesByType(index, type);

  /** @type {TypeQueryResult} */
  const result = {
    graphId: index.id,
    version: index.version,
    type,
    nodes,
  };

  emitQueryExecuted("nodes.byType", {
    graphId: index.id,
    version: index.version,
    type,
    count: nodes.length,
  });

  return result;
}

/**
 * Get all nodes carrying a particular tag (e.g., "macro", "seed", "stability").
 *
 * @param {string} graphId
 * @param {string} tag
 * @returns {Promise<TagQueryResult>}
 */
export async function getNodesForTag(graphId, tag) {
  const index = await getIndexedPlanningGraph(graphId);
  const nodes = getNodesByTag(index, tag);

  /** @type {TagQueryResult} */
  const result = {
    graphId: index.id,
    version: index.version,
    tag,
    nodes,
  };

  emitQueryExecuted("nodes.byTag", {
    graphId: index.id,
    version: index.version,
    tag,
    count: nodes.length,
  });

  return result;
}

/** ------------------------------------------------------------------------
 *  Utility helpers
 * --------------------------------------------------------------------- */

/**
 * Deduplicate nodes by id.
 *
 * @param {import("./planningGraphIndex").PlanningGraphNode[]} nodes
 * @returns {import("./planningGraphIndex").PlanningGraphNode[]}
 */
function dedupeNodes(nodes) {
  const seen = new Set();
  const out = [];

  for (const n of nodes) {
    if (!n || !n.id) continue;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }

  return out;
}

/** ------------------------------------------------------------------------
 *  Events
 * --------------------------------------------------------------------- */

/**
 * Emit a standardized query event for analytics/automation.
 *
 * @param {string} queryType
 * @param {any} data
 */
function emitQueryExecuted(queryType, data) {
  safeEmit({
    type: "planningGraph.query.executed",
    source: "planningGraph.queries",
    data: {
      queryType,
      ...data,
    },
  });
}

/**
 * Core safe emitter respecting SSA's event envelope.
 *
 * @param {{ type: string, source: string, data?: any }} payload
 */
function safeEmit(payload) {
  if (!payload || !payload.type) return;

  const envelope = {
    type: payload.type,
    ts: new Date().toISOString(),
    source: payload.source || "planningGraph.queries",
    data: payload.data,
  };

  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(envelope);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[planningGraphQueries] safeEmit failed", envelope, err);
  }
}

export default {
  getNeighborsForNode,
  findShortestPath,
  findShortestPathInIndex,
  getNodesForDomain,
  getNodesForType,
  getNodesForTag,
};
