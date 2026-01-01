// C:\Users\larho\suka-smart-assistant\src\services\planningGraph\planningGraphIndex.js

/**
 * Planning Graph Index
 *
 * How this fits:
 * - Takes a loaded Planning Graph JSON (via planningGraphLoader) and builds
 *   efficient in-memory indexes:
 *   • nodeById
 *   • edgesFrom (outgoing adjacency list)
 *   • edgesTo   (incoming adjacency list)
 *   • nodesByType
 *   • nodesByDomain
 *   • nodesByTag
 *
 * - Exposes helpers to:
 *   • quickly look up nodes/edges by id and relationship,
 *   • compute neighbors (successors/predecessors),
 *   • load + index a graph in one call, with caching.
 *
 * - Emits events:
 *   • planningGraph.index.built
 *   • planningGraph.index.cache.hit
 */

import eventBus from "@/services/eventBus";
import { loadPlanningGraph } from "@/services/planningGraph/planningGraphLoader";

/**
 * @typedef {Object} PlanningGraphNode
 * @property {string} id
 * @property {string} [type]
 * @property {string} [label]
 * @property {string} [domain]
 * @property {string[]} [tags]
 * @property {any} [data]   // plus any other fields from the JSON
 */

/**
 * @typedef {Object} PlanningGraphEdge
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {string} [type]
 * @property {string} [label]
 * @property {number} [weight]
 * @property {any} [conditions]
 */

/**
 * @typedef {Object} PlanningGraphIndex
 * @property {string} id
 * @property {string} version
 * @property {import("./planningGraphLoader").LoadedPlanningGraph["meta"]} meta
 * @property {PlanningGraphNode[]} nodes
 * @property {PlanningGraphEdge[]} edges
 * @property {Map<string, PlanningGraphNode>} nodeById
 * @property {Map<string, PlanningGraphEdge[]>} edgesFrom
 * @property {Map<string, PlanningGraphEdge[]>} edgesTo
 * @property {Map<string, PlanningGraphNode[]>} nodesByType
 * @property {Map<string, PlanningGraphNode[]>} nodesByDomain
 * @property {Map<string, PlanningGraphNode[]>} nodesByTag
 */

/**
 * @typedef {Object} IndexedGraphCacheKey
 * @property {string} id
 * @property {string} version
 */

/**
 * @typedef {Object} GetIndexedOptions
 * @property {string} [version]
 * @property {string} [minVersion]
 * @property {boolean} [preferLatest]
 */

/** ------------------------------------------------------------------------
 *  Internal cache
 * --------------------------------------------------------------------- */

/** @type {Map<string, PlanningGraphIndex>} */
const INDEX_CACHE = new Map();

/**
 * Build a stable cache key for a graph + version.
 *
 * @param {string} id
 * @param {string} version
 * @returns {string}
 */
function makeCacheKey(id, version) {
  return `${id}::${version}`;
}

/** ------------------------------------------------------------------------
 *  Index builder
 * --------------------------------------------------------------------- */

/**
 * Build in-memory indexes for a loaded Planning Graph.
 *
 * @param {import("./planningGraphLoader").LoadedPlanningGraph} loaded
 * @returns {PlanningGraphIndex}
 */
export function buildPlanningGraphIndex(loaded) {
  if (!loaded || typeof loaded !== "object") {
    throw new Error("[planningGraphIndex] loaded graph is required");
  }

  const { id, version, meta, data } = loaded;

  const rawNodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const rawEdges = Array.isArray(data?.edges) ? data.edges : [];

  /** @type {PlanningGraphNode[]} */
  const nodes = rawNodes.map(safeNormalizeNode);

  /** @type {PlanningGraphEdge[]} */
  const edges = rawEdges.map((edge, idx) =>
    safeNormalizeEdge(edge, idx, nodes)
  );

  /** @type {Map<string, PlanningGraphNode>} */
  const nodeById = new Map();
  /** @type {Map<string, PlanningGraphEdge[]>} */
  const edgesFrom = new Map();
  /** @type {Map<string, PlanningGraphEdge[]>} */
  const edgesTo = new Map();
  /** @type {Map<string, PlanningGraphNode[]>} */
  const nodesByType = new Map();
  /** @type {Map<string, PlanningGraphNode[]>} */
  const nodesByDomain = new Map();
  /** @type {Map<string, PlanningGraphNode[]>} */
  const nodesByTag = new Map();

  // Populate node indexes
  for (const node of nodes) {
    if (!node.id) continue;

    nodeById.set(node.id, node);

    if (node.type) {
      pushToMultiMap(nodesByType, node.type, node);
    }

    if (node.domain) {
      pushToMultiMap(nodesByDomain, node.domain, node);
    }

    if (Array.isArray(node.tags)) {
      for (const tag of node.tags) {
        if (!tag) continue;
        pushToMultiMap(nodesByTag, String(tag), node);
      }
    }
  }

  // Populate edge indexes
  for (const edge of edges) {
    if (!edge.id || !edge.from || !edge.to) continue;

    pushToMultiMap(edgesFrom, edge.from, edge);
    pushToMultiMap(edgesTo, edge.to, edge);
  }

  /** @type {PlanningGraphIndex} */
  const index = {
    id,
    version,
    meta,
    nodes,
    edges,
    nodeById,
    edgesFrom,
    edgesTo,
    nodesByType,
    nodesByDomain,
    nodesByTag,
  };

  // Cache & emit event
  const cacheKey = makeCacheKey(id, version);
  INDEX_CACHE.set(cacheKey, index);

  emitIndexBuilt(index);

  return index;
}

/**
 * Normalize an arbitrary node entry into a PlanningGraphNode.
 *
 * @param {any} raw
 * @returns {PlanningGraphNode}
 */
function safeNormalizeNode(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      id: "",
      type: "",
      label: "",
      domain: "",
      tags: [],
      data: {},
    };
  }

  const tags =
    Array.isArray(raw.tags) && raw.tags.length
      ? raw.tags.map((t) => String(t))
      : [];

  return {
    id: String(raw.id || ""),
    type: raw.type ? String(raw.type) : undefined,
    label: raw.label ? String(raw.label) : undefined,
    domain: raw.domain ? String(raw.domain) : undefined,
    tags,
    // keep all other fields under data for future extensions
    data: { ...raw },
  };
}

/**
 * Normalize an edge entry into a PlanningGraphEdge, attaching a synthetic id
 * if necessary.
 *
 * @param {any} raw
 * @param {number} idx
 * @param {PlanningGraphNode[]} allNodes
 * @returns {PlanningGraphEdge}
 */
function safeNormalizeEdge(raw, idx, allNodes) {
  if (!raw || typeof raw !== "object") {
    return {
      id: `auto-edge-${idx}`,
      from: "",
      to: "",
    };
  }

  const from = raw.from ? String(raw.from) : "";
  const to = raw.to ? String(raw.to) : "";

  const id =
    raw.id && typeof raw.id === "string"
      ? raw.id
      : `edge:${from || "?"}->${to || "?"}#${idx}`;

  const weight =
    typeof raw.weight === "number" ? raw.weight : undefined;

  const edge = {
    id,
    from,
    to,
    type: raw.type ? String(raw.type) : undefined,
    label: raw.label ? String(raw.label) : undefined,
    weight,
    conditions: raw.conditions,
  };

  // Optional sanity: warn if from/to do not exist in nodes
  if (from && !allNodes.some((n) => n.id === from)) {
    // eslint-disable-next-line no-console
    console.warn(
      "[planningGraphIndex] Edge 'from' node not found:",
      edge,
      "nodes may be incomplete"
    );
  }

  if (to && !allNodes.some((n) => n.id === to)) {
    // eslint-disable-next-line no-console
    console.warn(
      "[planningGraphIndex] Edge 'to' node not found:",
      edge,
      "nodes may be incomplete"
    );
  }

  return edge;
}

/**
 * Push a value into a multi-map (string -> array).
 *
 * @template T
 * @param {Map<string, T[]>} map
 * @param {string} key
 * @param {T} value
 */
function pushToMultiMap(map, key, value) {
  const arr = map.get(key);
  if (arr) {
    arr.push(value);
  } else {
    map.set(key, [value]);
  }
}

/** ------------------------------------------------------------------------
 *  Cache-aware loader
 * --------------------------------------------------------------------- */

/**
 * Load + index a Planning Graph by id (using planningGraphLoader),
 * reusing a cached index if available.
 *
 * @param {string} graphId
 * @param {GetIndexedOptions} [options]
 * @returns {Promise<PlanningGraphIndex>}
 */
export async function getIndexedPlanningGraph(graphId, options = {}) {
  const loaded = await loadPlanningGraph(graphId, options);
  const cacheKey = makeCacheKey(loaded.id, loaded.version);

  const cached = INDEX_CACHE.get(cacheKey);
  if (cached) {
    emitCacheHit(cached);
    return cached;
  }

  return buildPlanningGraphIndex(loaded);
}

/**
 * Clear the entire index cache, or just one graphId.
 *
 * @param {string} [graphId]
 */
export function clearPlanningGraphIndexCache(graphId) {
  if (!graphId) {
    INDEX_CACHE.clear();
    return;
  }

  const keys = Array.from(INDEX_CACHE.keys());
  for (const key of keys) {
    if (key.startsWith(`${graphId}::`)) {
      INDEX_CACHE.delete(key);
    }
  }
}

/** ------------------------------------------------------------------------
 *  Lookup helpers
 * --------------------------------------------------------------------- */

/**
 * Get a node by id from an existing index.
 *
 * @param {PlanningGraphIndex} index
 * @param {string} nodeId
 * @returns {PlanningGraphNode | undefined}
 */
export function getNodeById(index, nodeId) {
  if (!index || !nodeId) return undefined;
  return index.nodeById.get(nodeId);
}

/**
 * Get all outgoing edges from a node.
 *
 * @param {PlanningGraphIndex} index
 * @param {string} nodeId
 * @returns {PlanningGraphEdge[]}
 */
export function getOutgoingEdges(index, nodeId) {
  if (!index || !nodeId) return [];
  return index.edgesFrom.get(nodeId) || [];
}

/**
 * Get all incoming edges to a node.
 *
 * @param {PlanningGraphIndex} index
 * @param {string} nodeId
 * @returns {PlanningGraphEdge[]}
 */
export function getIncomingEdges(index, nodeId) {
  if (!index || !nodeId) return [];
  return index.edgesTo.get(nodeId) || [];
}

/**
 * Get successors (neighbor nodes reachable via outgoing edges).
 *
 * @param {PlanningGraphIndex} index
 * @param {string} nodeId
 * @returns {PlanningGraphNode[]}
 */
export function getSuccessors(index, nodeId) {
  const edges = getOutgoingEdges(index, nodeId);
  const out = [];
  for (const e of edges) {
    const node = index.nodeById.get(e.to);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Get predecessors (neighbor nodes that point to this node).
 *
 * @param {PlanningGraphIndex} index
 * @param {string} nodeId
 * @returns {PlanningGraphNode[]}
 */
export function getPredecessors(index, nodeId) {
  const edges = getIncomingEdges(index, nodeId);
  const out = [];
  for (const e of edges) {
    const node = index.nodeById.get(e.from);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Find nodes by type.
 *
 * @param {PlanningGraphIndex} index
 * @param {string} type
 * @returns {PlanningGraphNode[]}
 */
export function getNodesByType(index, type) {
  if (!index || !type) return [];
  return index.nodesByType.get(type) || [];
}

/**
 * Find nodes by domain.
 *
 * @param {PlanningGraphIndex} index
 * @param {string} domain
 * @returns {PlanningGraphNode[]}
 */
export function getNodesByDomain(index, domain) {
  if (!index || !domain) return [];
  return index.nodesByDomain.get(domain) || [];
}

/**
 * Find nodes by tag.
 *
 * @param {PlanningGraphIndex} index
 * @param {string} tag
 * @returns {PlanningGraphNode[]}
 */
export function getNodesByTag(index, tag) {
  if (!index || !tag) return [];
  return index.nodesByTag.get(tag) || [];
}

/** ------------------------------------------------------------------------
 *  Events
 * --------------------------------------------------------------------- */

/**
 * Emit an event when an index is built.
 *
 * @param {PlanningGraphIndex} index
 */
function emitIndexBuilt(index) {
  safeEmit({
    type: "planningGraph.index.built",
    source: "planningGraph.index",
    data: {
      id: index.id,
      version: index.version,
      nodeCount: index.nodes.length,
      edgeCount: index.edges.length,
    },
  });
}

/**
 * Emit an event when a cached index is reused.
 *
 * @param {PlanningGraphIndex} index
 */
function emitCacheHit(index) {
  safeEmit({
    type: "planningGraph.index.cache.hit",
    source: "planningGraph.index",
    data: {
      id: index.id,
      version: index.version,
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
    source: payload.source || "planningGraph.index",
    data: payload.data,
  };

  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(envelope);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[planningGraphIndex] safeEmit failed", envelope, err);
  }
}

export default {
  buildPlanningGraphIndex,
  getIndexedPlanningGraph,
  clearPlanningGraphIndexCache,
  getNodeById,
  getOutgoingEdges,
  getIncomingEdges,
  getSuccessors,
  getPredecessors,
  getNodesByType,
  getNodesByDomain,
  getNodesByTag,
};
