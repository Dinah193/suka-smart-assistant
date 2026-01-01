// C:\Users\larho\suka-smart-assistant\src\features\planning\helpers\nodeSelectors.js
// =============================================================================
// Planning Graph — Node Selector Utilities
// -----------------------------------------------------------------------------
// Purpose:
//   Small, pure utilities for working with the Planning Graph "nodes" collection.
//   These helpers make it easy to:
//
//   • Find nodes by id, domain, type, tags, and relationships
//   • Build domain-specific slices of the graph
//   • Navigate dependencies (feedsInto / dependsOn)
//   • Compute execution order and reachable subgraphs
//
// How this fits into SSA:
//   The Planning Graph powers calculators, planners, and session-generators
//   (cooking, cleaning, garden, animals, preservation, storehouse, etc.).
//   These selectors are used by:
//     • UI: to show which tools are available for a domain
//     • Session shims: to find which calculators/planners to run
//     • Analytics & "Planning Graph" visualizations
//
// Design:
//   • Pure functions, no side effects
//   • No hard dependency on a specific nodes registry or schema
//   • Defensive against malformed nodes and missing fields
//   • Ready for extension: new domains, node types, relationships
// =============================================================================

/**
 * @typedef {Object} PlanningNode
 * @property {string} id                     Unique node id (e.g., "storehouse.meals.calculator")
 * @property {string} title                  Human-readable label
 * @property {string} domain                 e.g. "cooking" | "cleaning" | "garden" | "animals" | "preservation" | "storehouse" | string
 * @property {string} [nodeType]             e.g. "calculator" | "planner" | "import" | "session-template" | "insight"
 * @property {string[]} [tags]               Free-form tags (e.g., ["macros","nutrition","planning-graph"])
 * @property {string[]} [feedsInto]          Node ids this node feeds into
 * @property {string[]} [dependsOn]          Node ids this node depends on
 * @property {Object}  [meta]                Arbitrary additional metadata
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
 * Find the first node that matches a predicate.
 * @param {PlanningNode[]} nodes
 * @param {(node: PlanningNode) => boolean} predicate
 * @returns {PlanningNode | null}
 */
export function findNode(nodes, predicate) {
  const list = asNodeArray(nodes);
  for (let i = 0; i < list.length; i += 1) {
    const n = list[i];
    try {
      if (predicate(n)) return n;
    } catch {
      // ignore bad predicate errors and move on
    }
  }
  return null;
}

/**
 * Find a node by its id.
 * @param {PlanningNode[]} nodes
 * @param {string} id
 * @returns {PlanningNode | null}
 */
export function findNodeById(nodes, id) {
  const targetId = normalizeId(id);
  if (!targetId) return null;
  return findNode(nodes, (n) => normalizeId(n.id) === targetId);
}

/**
 * Filter nodes by domain.
 * @param {PlanningNode[]} nodes
 * @param {string} domain
 * @returns {PlanningNode[]}
 */
export function findNodesByDomain(nodes, domain) {
  const domainLc = normalizeLower(domain);
  if (!domainLc) return [];
  return asNodeArray(nodes).filter(
    (n) => normalizeLower(n.domain) === domainLc
  );
}

/**
 * Filter nodes by multiple domains.
 * @param {PlanningNode[]} nodes
 * @param {string[]} domains
 * @returns {PlanningNode[]}
 */
export function findNodesByDomains(nodes, domains) {
  const domainSet = new Set(
    (domains || []).map((d) => normalizeLower(d)).filter(Boolean)
  );
  if (!domainSet.size) return [];
  return asNodeArray(nodes).filter((n) =>
    domainSet.has(normalizeLower(n.domain))
  );
}

/**
 * Filter nodes by nodeType.
 * (nodeType is intentionally loose to support new types.)
 * @param {PlanningNode[]} nodes
 * @param {string} nodeType
 * @returns {PlanningNode[]}
 */
export function findNodesByType(nodes, nodeType) {
  const typeLc = normalizeLower(nodeType);
  if (!typeLc) return [];
  return asNodeArray(nodes).filter(
    (n) => normalizeLower(n.nodeType || "") === typeLc
  );
}

/**
 * Filter nodes by a single tag (case-insensitive).
 * @param {PlanningNode[]} nodes
 * @param {string} tag
 * @returns {PlanningNode[]}
 */
export function findNodesByTag(nodes, tag) {
  const tagLc = normalizeLower(tag);
  if (!tagLc) return [];
  return asNodeArray(nodes).filter((n) => {
    if (!Array.isArray(n.tags)) return false;
    return n.tags.some((t) => normalizeLower(t) === tagLc);
  });
}

/**
 * Filter nodes that match ANY or ALL of the given tags.
 * @param {PlanningNode[]} nodes
 * @param {string[]} tags
 * @param {{ mode?: "any" | "all" }} [options]
 * @returns {PlanningNode[]}
 */
export function findNodesByTags(nodes, tags, options = {}) {
  const list = asNodeArray(nodes);
  const incoming = Array.isArray(tags) ? tags : [];
  const mode = options.mode === "all" ? "all" : "any";

  const tagSet = new Set(incoming.map((t) => normalizeLower(t)).filter(Boolean));
  if (!tagSet.size) return [];

  return list.filter((n) => {
    if (!Array.isArray(n.tags) || !n.tags.length) return false;
    const nodeTagSet = new Set(
      n.tags.map((t) => normalizeLower(t)).filter(Boolean)
    );

    if (mode === "all") {
      for (const required of tagSet) {
        if (!nodeTagSet.has(required)) return false;
      }
      return true;
    }

    // "any" mode
    for (const candidate of nodeTagSet) {
      if (tagSet.has(candidate)) return true;
    }
    return false;
  });
}

/**
 * Return nodes that have no dependsOn (graph "roots").
 * Optionally filter by domain.
 * @param {PlanningNode[]} nodes
 * @param {{ domain?: string }} [options]
 * @returns {PlanningNode[]}
 */
export function getRootNodes(nodes, options = {}) {
  let list = asNodeArray(nodes);
  if (options.domain) {
    list = findNodesByDomain(list, options.domain);
  }
  return list.filter((n) => !Array.isArray(n.dependsOn) || n.dependsOn.length === 0);
}

/**
 * Return nodes that have no feedsInto (graph "leaves").
 * Optionally filter by domain.
 * @param {PlanningNode[]} nodes
 * @param {{ domain?: string }} [options]
 * @returns {PlanningNode[]}
 */
export function getLeafNodes(nodes, options = {}) {
  let list = asNodeArray(nodes);
  if (options.domain) {
    list = findNodesByDomain(list, options.domain);
  }
  return list.filter((n) => !Array.isArray(n.feedsInto) || n.feedsInto.length === 0);
}

/**
 * Build an adjacency map for fast graph operations.
 * @param {PlanningNode[]} nodes
 * @returns {{ byId: Map<string, PlanningNode>, edgesOut: Map<string, Set<string>>, edgesIn: Map<string, Set<string>> }}
 */
export function buildAdjacency(nodes) {
  const list = asNodeArray(nodes);
  const byId = new Map();
  const edgesOut = new Map();
  const edgesIn = new Map();

  for (const node of list) {
    const id = normalizeId(node.id);
    if (!id) continue;
    byId.set(id, node);
    if (!edgesOut.has(id)) edgesOut.set(id, new Set());
    if (!edgesIn.has(id)) edgesIn.set(id, new Set());
  }

  for (const node of list) {
    const fromId = normalizeId(node.id);
    if (!fromId) continue;

    const edges = Array.isArray(node.feedsInto) ? node.feedsInto : [];
    for (const targetRaw of edges) {
      const toId = normalizeId(targetRaw);
      if (!toId || !byId.has(toId)) continue;
      edgesOut.get(fromId).add(toId);
      edgesIn.get(toId).add(fromId);
    }
  }

  return { byId, edgesOut, edgesIn };
}

/**
 * Get all nodes that the given node id feeds into (immediate outbound neighbors).
 * @param {PlanningNode[]} nodes
 * @param {string} startId
 * @returns {PlanningNode[]}
 */
export function getOutboundNeighbors(nodes, startId) {
  const { byId, edgesOut } = buildAdjacency(nodes);
  const id = normalizeId(startId);
  if (!id || !byId.has(id)) return [];
  const outSet = edgesOut.get(id) || new Set();
  const result = [];
  for (const targetId of outSet) {
    const node = byId.get(targetId);
    if (node) result.push(node);
  }
  return result;
}

/**
 * Get all nodes that feed into the given node id (immediate inbound neighbors).
 * @param {PlanningNode[]} nodes
 * @param {string} targetId
 * @returns {PlanningNode[]}
 */
export function getInboundNeighbors(nodes, targetId) {
  const { byId, edgesIn } = buildAdjacency(nodes);
  const id = normalizeId(targetId);
  if (!id || !byId.has(id)) return [];
  const inSet = edgesIn.get(id) || new Set();
  const result = [];
  for (const fromId of inSet) {
    const node = byId.get(fromId);
    if (node) result.push(node);
  }
  return result;
}

/**
 * Get all nodes reachable from a starting node id following feedsInto edges.
 * @param {PlanningNode[]} nodes
 * @param {string} startId
 * @param {{ includeStart?: boolean }} [options]
 * @returns {PlanningNode[]}
 */
export function getReachableNodes(nodes, startId, options = {}) {
  const { byId, edgesOut } = buildAdjacency(nodes);
  const id = normalizeId(startId);
  if (!id || !byId.has(id)) return [];

  const includeStart = options.includeStart === true;
  const visited = new Set();
  const queue = [id];
  const result = [];

  if (!includeStart) {
    // we still start BFS from id, but we don't add it to result
    visited.add(id);
  }

  while (queue.length) {
    const currentId = queue.shift();
    if (!currentId) continue;

    const node = byId.get(currentId);
    if (node && (includeStart || currentId !== id)) {
      result.push(node);
    }

    const neighbors = edgesOut.get(currentId) || new Set();
    for (const neighborId of neighbors) {
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }
  }

  return result;
}

/**
 * Topologically sort nodes based on dependsOn.
 * This gives a safe "execution order" where dependencies appear before dependents.
 * If cycles exist, nodes in cycles are placed at the end in arbitrary order.
 * @param {PlanningNode[]} nodes
 * @returns {PlanningNode[]}
 */
export function getExecutionOrder(nodes) {
  const list = asNodeArray(nodes);
  if (!list.length) return [];

  // Build in-degree (dependsOn) graph
  const byId = new Map();
  const dependsOnMap = new Map(); // id -> Set of dependencies
  const dependentsMap = new Map(); // id -> Set of dependents

  for (const node of list) {
    const id = normalizeId(node.id);
    if (!id) continue;

    byId.set(id, node);
    if (!dependsOnMap.has(id)) dependsOnMap.set(id, new Set());
    if (!dependentsMap.has(id)) dependentsMap.set(id, new Set());
  }

  for (const node of list) {
    const id = normalizeId(node.id);
    if (!id) continue;
    const deps = Array.isArray(node.dependsOn) ? node.dependsOn : [];
    const depSet = dependsOnMap.get(id);
    for (const depRaw of deps) {
      const depId = normalizeId(depRaw);
      if (!depId || !byId.has(depId)) continue;
      depSet.add(depId);
      dependentsMap.get(depId).add(id);
    }
  }

  const noDepsQueue = [];
  for (const [id, depSet] of dependsOnMap.entries()) {
    if (!depSet.size) {
      noDepsQueue.push(id);
    }
  }

  const ordered = [];
  const removedDepsFor = new Set();

  while (noDepsQueue.length) {
    const currentId = noDepsQueue.shift();
    const node = byId.get(currentId);
    if (node) ordered.push(node);

    const dependents = dependentsMap.get(currentId) || new Set();
    for (const depId of dependents) {
      if (!dependsOnMap.has(depId)) continue;
      const depSet = dependsOnMap.get(depId);
      depSet.delete(currentId);
      removedDepsFor.add(depId);
      if (depSet.size === 0) {
        noDepsQueue.push(depId);
      }
    }
  }

  // If any nodes still have dependencies, graph likely contains cycles.
  // Append them at the end in arbitrary but stable order.
  for (const node of list) {
    if (!ordered.includes(node)) {
      ordered.push(node);
    }
  }

  return ordered;
}

/**
 * Group nodes by domain.
 * @param {PlanningNode[]} nodes
 * @returns {Record<string, PlanningNode[]>}
 */
export function groupNodesByDomain(nodes) {
  const grouped = {};
  for (const node of asNodeArray(nodes)) {
    const domainKey = normalizeLower(node.domain) || "unknown";
    if (!grouped[domainKey]) grouped[domainKey] = [];
    grouped[domainKey].push(node);
  }
  return grouped;
}

/**
 * Build a simple "domain graph" slice — nodes + their outbound connections — for a domain.
 * Useful for domain-specific Planning Graph visualizations.
 * @param {PlanningNode[]} nodes
 * @param {string} domain
 * @returns {{ nodes: PlanningNode[], edges: { from: string, to: string }[] }}
 */
export function getDomainGraph(nodes, domain) {
  const all = asNodeArray(nodes);
  const domainNodes = findNodesByDomain(all, domain);
  const domainIds = new Set(domainNodes.map((n) => normalizeId(n.id)).filter(Boolean));

  const edges = [];
  for (const node of domainNodes) {
    const fromId = normalizeId(node.id);
    if (!fromId) continue;

    const targets = Array.isArray(node.feedsInto) ? node.feedsInto : [];
    for (const t of targets) {
      const toId = normalizeId(t);
      if (!toId || !domainIds.has(toId)) continue;
      edges.push({ from: fromId, to: toId });
    }
  }

  return { nodes: domainNodes, edges };
}

/**
 * Convenience: get all calculator-type nodes for a domain.
 * Assumes node.nodeType === "calculator" (case-insensitive).
 * @param {PlanningNode[]} nodes
 * @param {string} domain
 * @returns {PlanningNode[]}
 */
export function getDomainCalculators(nodes, domain) {
  const domainNodes = findNodesByDomain(nodes, domain);
  return findNodesByType(domainNodes, "calculator");
}

/**
 * Convenience: get all planner-type nodes for a domain.
 * Assumes node.nodeType === "planner" (case-insensitive).
 * @param {PlanningNode[]} nodes
 * @param {string} domain
 * @returns {PlanningNode[]}
 */
export function getDomainPlanners(nodes, domain) {
  const domainNodes = findNodesByDomain(nodes, domain);
  return findNodesByType(domainNodes, "planner");
}

/**
 * Convenience: get all nodes whose id starts with a given prefix.
 * Useful when ids are namespaced like "storehouse.meals", "storehouse.macroCalculator", etc.
 * @param {PlanningNode[]} nodes
 * @param {string} idPrefix
 * @returns {PlanningNode[]}
 */
export function findNodesByIdPrefix(nodes, idPrefix) {
  const prefix = String(idPrefix || "");
  if (!prefix) return [];
  return asNodeArray(nodes).filter((n) =>
    normalizeId(n.id).startsWith(prefix)
  );
}

/**
 * Convenience: safely pick a node by domain + nodeType + optional tag.
 * First match wins. Designed for "default node" selection.
 * @param {PlanningNode[]} nodes
 * @param {{ domain?: string, nodeType?: string, tag?: string }} criteria
 * @returns {PlanningNode | null}
 */
export function pickNode(nodes, criteria = {}) {
  let list = asNodeArray(nodes);

  if (criteria.domain) {
    list = findNodesByDomain(list, criteria.domain);
  }
  if (criteria.nodeType) {
    list = findNodesByType(list, criteria.nodeType);
  }
  if (criteria.tag) {
    list = findNodesByTag(list, criteria.tag);
  }

  return list.length ? list[0] : null;
}

/**
 * Default export for convenience when importing all helpers at once.
 */
const nodeSelectors = {
  asNodeArray,
  findNode,
  findNodeById,
  findNodesByDomain,
  findNodesByDomains,
  findNodesByType,
  findNodesByTag,
  findNodesByTags,
  getRootNodes,
  getLeafNodes,
  buildAdjacency,
  getOutboundNeighbors,
  getInboundNeighbors,
  getReachableNodes,
  getExecutionOrder,
  groupNodesByDomain,
  getDomainGraph,
  getDomainCalculators,
  getDomainPlanners,
  findNodesByIdPrefix,
  pickNode,
};

export default nodeSelectors;
