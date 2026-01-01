// C:\Users\larho\suka-smart-assistant\src\features\planning\helpers\edgeSelectors.js
// =============================================================================
// Planning Graph — Edge Selector Utilities
// -----------------------------------------------------------------------------
// Purpose:
//   Small, pure utilities for working with implicit "edges" in the Planning Graph.
//   Edges are inferred from node.feedsInto / node.dependsOn relationships.
//
//   These helpers make it easy to:
//     • Derive a flat edge list from nodes
//     • Query outgoing / incoming edges for a node
//     • Get neighbors (by id or by node object)
//     • Build domain-scoped edge slices for visualizations and planners
//
// How this fits into SSA:
//   The Planning Graph links calculators, planners, and session generators across
//   domains (cooking, cleaning, garden, animals, preservation, storehouse, etc.).
//   These edge utilities support:
//     • Visual graph components (network diagrams)
//     • Orchestration logic (what should run before/after what)
//     • "Next best tool" suggestions, session chaining, and analytics.
//
// Design:
//   • Pure, side-effect-free functions
//   • Defensive against malformed nodes and missing fields
//   • Edge-centric: works mainly with { from, to } records
//   • Uses buildAdjacency from nodeSelectors for fast neighbor lookups
// =============================================================================

import { buildAdjacency } from "./nodeSelectors";

/**
 * @typedef {Object} PlanningNode
 * @property {string} id
 * @property {string} title
 * @property {string} domain
 * @property {string} [nodeType]
 * @property {string[]} [tags]
 * @property {string[]} [feedsInto]
 * @property {string[]} [dependsOn]
 * @property {Object}  [meta]
 */

/**
 * @typedef {Object} PlanningEdge
 * @property {string} from           // Source node id
 * @property {string} to             // Target node id
 * @property {string} [kind]         // Optional: "feedsInto" | "dependsOn" | string
 * @property {string} [domain]       // Optional: domain of the "from" node (for convenience)
 * @property {Object} [meta]         // Optional metadata for visualizations, weights, etc.
 */

/**
 * Internal helper: coerce unknown input into a safe array of PlanningNode.
 * @param {PlanningNode[] | null | undefined} nodes
 * @returns {PlanningNode[]}
 */
function asNodeArray(nodes) {
  if (!nodes) return [];
  if (Array.isArray(nodes)) return nodes.filter(Boolean);
  return [];
}

/**
 * Internal helper: ensure we compare ids as strings.
 * @param {string | number | null | undefined} v
 * @returns {string}
 */
function normalizeId(v) {
  return v == null ? "" : String(v);
}

/**
 * Internal helper: normalize to lowercase string for case-insensitive compares.
 * @param {string | null | undefined} v
 * @returns {string}
 */
function normalizeLower(v) {
  return typeof v === "string" ? v.toLowerCase() : "";
}

/**
 * Build a flat list of edges from node.feedsInto and/or node.dependsOn.
 * By default, only "feedsInto" edges are output, since those represent
 * forward flow in the Planning Graph.
 *
 * @param {PlanningNode[]} nodes
 * @param {{ includeDependsOn?: boolean }} [options]
 * @returns {PlanningEdge[]}
 */
export function getAllEdges(nodes, options = {}) {
  const list = asNodeArray(nodes);
  const includeDependsOn = options.includeDependsOn === true;

  const byId = new Map();
  for (const node of list) {
    const id = normalizeId(node.id);
    if (!id) continue;
    byId.set(id, node);
  }

  /** @type {PlanningEdge[]} */
  const edges = [];

  // feedsInto edges
  for (const node of list) {
    const fromId = normalizeId(node.id);
    if (!fromId) continue;
    const domain = normalizeLower(node.domain) || undefined;
    const feeds = Array.isArray(node.feedsInto) ? node.feedsInto : [];
    for (const rawTarget of feeds) {
      const toId = normalizeId(rawTarget);
      if (!toId || !byId.has(toId)) continue;
      edges.push({
        from: fromId,
        to: toId,
        kind: "feedsInto",
        domain,
      });
    }
  }

  if (includeDependsOn) {
    // dependsOn edges (dependency direction: dep -> node)
    for (const node of list) {
      const toId = normalizeId(node.id);
      if (!toId) continue;
      const domain = normalizeLower(node.domain) || undefined;
      const deps = Array.isArray(node.dependsOn) ? node.dependsOn : [];
      for (const rawDep of deps) {
        const fromId = normalizeId(rawDep);
        if (!fromId || !byId.has(fromId)) continue;
        edges.push({
          from: fromId,
          to: toId,
          kind: "dependsOn",
          domain,
        });
      }
    }
  }

  return edges;
}

/**
 * Filter edges originating from a given node id.
 * @param {PlanningEdge[]} edges
 * @param {string} fromId
 * @returns {PlanningEdge[]}
 */
export function getEdgesFrom(edges, fromId) {
  const id = normalizeId(fromId);
  if (!id) return [];
  const list = Array.isArray(edges) ? edges : [];
  return list.filter((e) => normalizeId(e.from) === id);
}

/**
 * Filter edges terminating at a given node id.
 * @param {PlanningEdge[]} edges
 * @param {string} toId
 * @returns {PlanningEdge[]}
 */
export function getEdgesTo(edges, toId) {
  const id = normalizeId(toId);
  if (!id) return [];
  const list = Array.isArray(edges) ? edges : [];
  return list.filter((e) => normalizeId(e.to) === id);
}

/**
 * Filter edges between a specific pair of nodes.
 * @param {PlanningEdge[]} edges
 * @param {string} fromId
 * @param {string} toId
 * @returns {PlanningEdge[]}
 */
export function getEdgesBetween(edges, fromId, toId) {
  const fromNorm = normalizeId(fromId);
  const toNorm = normalizeId(toId);
  if (!fromNorm || !toNorm) return [];
  const list = Array.isArray(edges) ? edges : [];
  return list.filter(
    (e) => normalizeId(e.from) === fromNorm && normalizeId(e.to) === toNorm
  );
}

/**
 * Get all edges whose domain matches (case-insensitive).
 * Note: domain is derived from the "from" node when using getAllEdges.
 * @param {PlanningEdge[]} edges
 * @param {string} domain
 * @returns {PlanningEdge[]}
 */
export function getEdgesByDomain(edges, domain) {
  const domainLc = normalizeLower(domain);
  if (!domainLc) return [];
  const list = Array.isArray(edges) ? edges : [];
  return list.filter((e) => normalizeLower(e.domain || "") === domainLc);
}

/**
 * Convenience: build edges for a specific domain from nodes.
 * Internally uses getAllEdges + domain filter.
 * @param {PlanningNode[]} nodes
 * @param {string} domain
 * @param {{ includeDependsOn?: boolean }} [options]
 * @returns {PlanningEdge[]}
 */
export function getDomainEdges(nodes, domain, options = {}) {
  const allEdges = getAllEdges(nodes, options);
  return getEdgesByDomain(allEdges, domain);
}

/**
 * Get neighbor node ids for a given node:
 *   • outgoing: nodes it points to
 *   • incoming: nodes that point to it
 *
 * This uses buildAdjacency from nodeSelectors for efficient lookups.
 *
 * @param {PlanningNode[]} nodes
 * @param {string} id
 * @returns {{ outbound: string[], inbound: string[] }}
 */
export function getNeighborIds(nodes, id) {
  const { edgesOut, edgesIn } = buildAdjacency(nodes);
  const nodeId = normalizeId(id);
  if (!nodeId) {
    return { outbound: [], inbound: [] };
  }

  const outSet = edgesOut.get(nodeId) || new Set();
  const inSet = edgesIn.get(nodeId) || new Set();

  return {
    outbound: Array.from(outSet),
    inbound: Array.from(inSet),
  };
}

/**
 * Get neighbor node objects for a given node:
 *   • outbound: node objects it points to
 *   • inbound: node objects that point to it
 *
 * @param {PlanningNode[]} nodes
 * @param {string} id
 * @returns {{ outbound: PlanningNode[], inbound: PlanningNode[] }}
 */
export function getNeighbors(nodes, id) {
  const list = asNodeArray(nodes);
  const { byId, edgesOut, edgesIn } = buildAdjacency(list);
  const nodeId = normalizeId(id);
  if (!nodeId || !byId.has(nodeId)) {
    return { outbound: [], inbound: [] };
  }

  /** @type {PlanningNode[]} */
  const outbound = [];
  /** @type {PlanningNode[]} */
  const inbound = [];

  const outSet = edgesOut.get(nodeId) || new Set();
  for (const toId of outSet) {
    const n = byId.get(toId);
    if (n) outbound.push(n);
  }

  const inSet = edgesIn.get(nodeId) || new Set();
  for (const fromId of inSet) {
    const n = byId.get(fromId);
    if (n) inbound.push(n);
  }

  return { outbound, inbound };
}

/**
 * Build a map of node id -> outgoing edges.
 * @param {PlanningEdge[]} edges
 * @returns {Map<string, PlanningEdge[]>}
 */
export function buildOutgoingEdgeMap(edges) {
  const list = Array.isArray(edges) ? edges : [];
  /** @type {Map<string, PlanningEdge[]>} */
  const map = new Map();
  for (const e of list) {
    const fromId = normalizeId(e.from);
    if (!fromId) continue;
    if (!map.has(fromId)) map.set(fromId, []);
    map.get(fromId).push(e);
  }
  return map;
}

/**
 * Build a map of node id -> incoming edges.
 * @param {PlanningEdge[]} edges
 * @returns {Map<string, PlanningEdge[]>}
 */
export function buildIncomingEdgeMap(edges) {
  const list = Array.isArray(edges) ? edges : [];
  /** @type {Map<string, PlanningEdge[]>} */
  const map = new Map();
  for (const e of list) {
    const toId = normalizeId(e.to);
    if (!toId) continue;
    if (!map.has(toId)) map.set(toId, []);
    map.get(toId).push(e);
  }
  return map;
}

/**
 * Group edges by domain.
 * Note: "domain" is usually derived from the "from" node.
 * @param {PlanningEdge[]} edges
 * @returns {Record<string, PlanningEdge[]>}
 */
export function groupEdgesByDomain(edges) {
  const list = Array.isArray(edges) ? edges : [];
  /** @type {Record<string, PlanningEdge[]>} */
  const grouped = {};
  for (const e of list) {
    const domainKey = normalizeLower(e.domain || "") || "unknown";
    if (!grouped[domainKey]) grouped[domainKey] = [];
    grouped[domainKey].push(e);
  }
  return grouped;
}

/**
 * Convenience: get a lightweight graph slice for a domain (nodes + edges).
 * The nodes must be provided separately; this function only filters edges.
 *
 * @param {PlanningNode[]} nodes
 * @param {string} domain
 * @param {{ includeDependsOn?: boolean }} [options]
 * @returns {{ nodes: PlanningNode[], edges: PlanningEdge[] }}
 */
export function getDomainSlice(nodes, domain, options = {}) {
  const allNodes = asNodeArray(nodes);
  const domainLc = normalizeLower(domain);

  const sliceNodes = allNodes.filter(
    (n) => normalizeLower(n.domain) === domainLc
  );
  const sliceNodeIds = new Set(
    sliceNodes.map((n) => normalizeId(n.id)).filter(Boolean)
  );

  const allEdges = getAllEdges(allNodes, options);
  const sliceEdges = allEdges.filter(
    (e) => sliceNodeIds.has(normalizeId(e.from)) && sliceNodeIds.has(normalizeId(e.to))
  );

  return { nodes: sliceNodes, edges: sliceEdges };
}

/**
 * Default export for convenience when importing all helpers at once.
 */
const edgeSelectors = {
  getAllEdges,
  getEdgesFrom,
  getEdgesTo,
  getEdgesBetween,
  getEdgesByDomain,
  getDomainEdges,
  getNeighborIds,
  getNeighbors,
  buildOutgoingEdgeMap,
  buildIncomingEdgeMap,
  groupEdgesByDomain,
  getDomainSlice,
};

export default edgeSelectors;
