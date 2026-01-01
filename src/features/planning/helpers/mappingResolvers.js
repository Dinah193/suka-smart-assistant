// C:\Users\larho\suka-smart-assistant\src\features\planning\helpers\mappingResolvers.js
// =============================================================================
// Planning Graph — Mapping Resolvers (Next Steps)
// -----------------------------------------------------------------------------
// Purpose:
//   Take multiple "mapping" sources and resolve them into a clean,
//   prioritized list of "Next Steps" for a given node or session.
//
//   Sources merged:
//     • Global mappings (per-domain / per-type rules, etc.)
//     • Node-specific mappings (per-node overrides & custom next steps)
//     • (Optionally) Graph-based neighbors (feedsInto edges)
//
// How this fits into SSA:
//   The Planning Graph powers calculators, planners, and session generators
//   across domains (cooking, cleaning, garden, animals, preservation, storehouse).
//   When a user finishes with a tool (node), the system should be able to say:
//
//     "Next, you might want to run X, Y, or Z."
//
//   These "Next Steps" can:
//     • feed Session creation shims
//     • populate "Now" CTA dropdowns
//     • inform Recommendation panels
//     • help orchestrate multi-step planning flows
//
// Design:
//   • Pure, defensive logic — safe to call from UI or session shims.
//   • No side effects: callers decide how to display or execute "Next Steps".
//   • Opinionated but extensible shape for mapping configs.
//   • Works with existing PlanningNode definitions and nodeSelectors helpers.
//
// -----------------------------------------------------------------------------
// Data Shapes (JSDoc, loosely typed JS):
// -----------------------------------------------------------------------------
//
// 1) PlanningNode (seen in nodeSelectors.js):
//    {
//      id: string,
//      title: string,
//      domain: string,
//      nodeType?: string,
//      tags?: string[],
//      feedsInto?: string[],
//      dependsOn?: string[],
//      meta?: {
//        // Node-specific next step mappings (optional)
//        nextSteps?: NodeSpecificNextStep[],
//        nextStepOverrides?: NodeSpecificNextStep[],
//        // ...other node metadata
//      }
//    }
//
// 2) NodeSpecificNextStep:
//    {
//      targetId: string,        // PlanningNode id
//      label?: string,          // Display label override
//      reason?: string,         // Why this is recommended
//      priority?: number,       // Higher = more important (default 0)
//      tags?: string[],         // UI hints or categorization
//      // Extra flags that orchestration can use
//      autoStartSession?: boolean,
//      domainOverride?: string, // override domain if needed
//    }
//
// 3) GlobalMappings:
//    Global configuration object that can live in config files or Dexie.
//    The exact source is up to you; this module only cares about shape.
//
//    {
//      defaults?: GlobalMappingRule[],
//      byDomain?: Record<string, GlobalMappingRule[]>,
//      byNodeType?: Record<string, GlobalMappingRule[]>,
//      // Future extension: byTag, byIdPrefix, etc.
//    }
//
//    GlobalMappingRule:
//    {
//      id?: string,
//      from?: {
//        id?: string,            // exact node id match
//        idPrefix?: string,      // match node.id startsWith
//        domain?: string,
//        nodeType?: string,
//        tagsAny?: string[],
//        tagsAll?: string[],
//      },
//      to: {
//        targetId: string,       // PlanningNode id
//        label?: string,
//        reason?: string,
//        priority?: number,
//        tags?: string[],
//        autoStartSession?: boolean,
//        domainOverride?: string,
//      }
//    }
//
// 4) ResolvedNextStep (result of this module):
//    {
//      sourceNodeId: string,
//      targetId: string,
//      label: string,
//      reason?: string,
//      priority: number,
//      tags: string[],
//      origin: "node-specific" | "global" | "graph",
//      autoStartSession?: boolean,
//      domain: string,           // resolved domain for the target, or fallback
//    }
//
// =============================================================================

import { findNodeById, getOutboundNeighbors } from "./nodeSelectors";

/**
 * @typedef {import("./nodeSelectors").PlanningNode} PlanningNode
 */

/**
 * @typedef {Object} NodeSpecificNextStep
 * @property {string} targetId
 * @property {string} [label]
 * @property {string} [reason]
 * @property {number} [priority]
 * @property {string[]} [tags]
 * @property {boolean} [autoStartSession]
 * @property {string} [domainOverride]
 */

/**
 * @typedef {Object} GlobalMappingFrom
 * @property {string} [id]
 * @property {string} [idPrefix]
 * @property {string} [domain]
 * @property {string} [nodeType]
 * @property {string[]} [tagsAny]
 * @property {string[]} [tagsAll]
 */

/**
 * @typedef {Object} GlobalMappingTo
 * @property {string} targetId
 * @property {string} [label]
 * @property {string} [reason]
 * @property {number} [priority]
 * @property {string[]} [tags]
 * @property {boolean} [autoStartSession]
 * @property {string} [domainOverride]
 */

/**
 * @typedef {Object} GlobalMappingRule
 * @property {string} [id]
 * @property {GlobalMappingFrom} [from]
 * @property {GlobalMappingTo} to
 */

/**
 * @typedef {Object} GlobalMappings
 * @property {GlobalMappingRule[]} [defaults]
 * @property {Record<string, GlobalMappingRule[]>} [byDomain]
 * @property {Record<string, GlobalMappingRule[]>} [byNodeType]
 */

/**
 * @typedef {Object} ResolvedNextStep
 * @property {string} sourceNodeId
 * @property {string} targetId
 * @property {string} label
 * @property {string} [reason]
 * @property {number} priority
 * @property {string[]} tags
 * @property {"node-specific" | "global" | "graph"} origin
 * @property {boolean} [autoStartSession]
 * @property {string} domain
 */

// -----------------------------------------------------------------------------
// Small internal helpers
// -----------------------------------------------------------------------------

/**
 * @param {string | null | undefined} v
 * @returns {string}
 */
function normalizeLower(v) {
  return typeof v === "string" ? v.toLowerCase() : "";
}

/**
 * @param {any} v
 * @returns {string}
 */
function normalizeId(v) {
  return v == null ? "" : String(v);
}

/**
 * @param {PlanningNode[] | null | undefined} nodes
 * @returns {PlanningNode[]}
 */
function asNodeArray(nodes) {
  if (!nodes) return [];
  if (Array.isArray(nodes)) return nodes.filter(Boolean);
  return [];
}

/**
 * Safe tags normalization.
 * @param {string[] | null | undefined} tags
 * @returns {string[]}
 */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => t).filter(Boolean);
}

/**
 * @param {string[] | null | undefined} tags
 * @returns {Set<string>}
 */
function toLowerTagSet(tags) {
  const set = new Set();
  if (!Array.isArray(tags)) return set;
  for (const t of tags) {
    const v = normalizeLower(t);
    if (v) set.add(v);
  }
  return set;
}

// -----------------------------------------------------------------------------
// Global mapping matcher
// -----------------------------------------------------------------------------

/**
 * Test if a given PlanningNode matches the "from" clause of a GlobalMappingRule.
 * All provided constraints must pass. tagsAny and tagsAll are handled separately.
 *
 * @param {PlanningNode} node
 * @param {GlobalMappingFrom | undefined} from
 * @returns {boolean}
 */
function doesNodeMatchFrom(node, from) {
  if (!from) return true; // no constraints -> match everything

  const idNorm = normalizeId(node.id);
  const domainNorm = normalizeLower(node.domain);
  const typeNorm = normalizeLower(node.nodeType || "");
  const tagSet = toLowerTagSet(node.tags || []);

  if (from.id && normalizeId(from.id) !== idNorm) return false;

  if (from.idPrefix && !idNorm.startsWith(String(from.idPrefix))) {
    return false;
  }

  if (from.domain && normalizeLower(from.domain) !== domainNorm) {
    return false;
  }

  if (from.nodeType && normalizeLower(from.nodeType) !== typeNorm) {
    return false;
  }

  if (Array.isArray(from.tagsAll) && from.tagsAll.length > 0) {
    for (const required of from.tagsAll) {
      const r = normalizeLower(required);
      if (!r || !tagSet.has(r)) return false;
    }
  }

  if (Array.isArray(from.tagsAny) && from.tagsAny.length > 0) {
    let found = false;
    for (const candidate of from.tagsAny) {
      const c = normalizeLower(candidate);
      if (c && tagSet.has(c)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }

  return true;
}

/**
 * Collect all GlobalMappingRule entries that might apply to a node.
 *
 * @param {PlanningNode} node
 * @param {GlobalMappings | null | undefined} globalMappings
 * @returns {GlobalMappingRule[]}
 */
function getCandidateGlobalMappings(node, globalMappings) {
  if (!globalMappings) return [];

  const { defaults, byDomain, byNodeType } = globalMappings;

  /** @type {GlobalMappingRule[]} */
  const rules = [];

  if (Array.isArray(defaults)) {
    rules.push(...defaults);
  }

  const domainKey = normalizeLower(node.domain);
  if (byDomain && byDomain[domainKey]) {
    rules.push(...byDomain[domainKey]);
  }

  const typeKey = normalizeLower(node.nodeType || "");
  if (typeKey && byNodeType && byNodeType[typeKey]) {
    rules.push(...byNodeType[typeKey]);
  }

  return rules.filter(Boolean);
}

// -----------------------------------------------------------------------------
// Node-specific + Global mapping -> ResolvedNextStep
// -----------------------------------------------------------------------------

/**
 * Convert a NodeSpecificNextStep into a ResolvedNextStep (pre-dedup, pre-rank).
 *
 * @param {PlanningNode} sourceNode
 * @param {NodeSpecificNextStep} ns
 * @param {PlanningNode[] | null | undefined} allNodes
 * @returns {ResolvedNextStep | null}
 */
function toResolvedFromNodeSpecific(sourceNode, ns, allNodes) {
  if (!ns || !ns.targetId) return null;

  const sourceId = normalizeId(sourceNode.id);
  const targetId = normalizeId(ns.targetId);
  if (!sourceId || !targetId) return null;

  const nodes = asNodeArray(allNodes);
  const target = findNodeById(nodes, targetId);

  const domain =
    ns.domainOverride ||
    (target ? target.domain : sourceNode.domain) ||
    "unknown";

  const label =
    ns.label ||
    (target && target.title) ||
    `Next: ${targetId}`;

  return {
    sourceNodeId: sourceId,
    targetId,
    label,
    reason: ns.reason,
    priority: typeof ns.priority === "number" ? ns.priority : 0,
    tags: normalizeTags(ns.tags),
    origin: "node-specific",
    autoStartSession: ns.autoStartSession,
    domain,
  };
}

/**
 * Convert a GlobalMappingRule into a ResolvedNextStep IF it matches the node.
 *
 * @param {PlanningNode} sourceNode
 * @param {GlobalMappingRule} rule
 * @param {PlanningNode[] | null | undefined} allNodes
 * @returns {ResolvedNextStep | null}
 */
function toResolvedFromGlobalRule(sourceNode, rule, allNodes) {
  if (!rule || !rule.to || !rule.to.targetId) return null;
  if (!doesNodeMatchFrom(sourceNode, rule.from)) return null;

  const sourceId = normalizeId(sourceNode.id);
  const targetId = normalizeId(rule.to.targetId);
  if (!sourceId || !targetId) return null;

  const nodes = asNodeArray(allNodes);
  const target = findNodeById(nodes, targetId);

  const domain =
    rule.to.domainOverride ||
    (target ? target.domain : sourceNode.domain) ||
    "unknown";

  const label =
    rule.to.label ||
    (target && target.title) ||
    `Next: ${targetId}`;

  const priority =
    typeof rule.to.priority === "number" ? rule.to.priority : 0;

  return {
    sourceNodeId: sourceId,
    targetId,
    label,
    reason: rule.to.reason,
    priority,
    tags: normalizeTags(rule.to.tags),
    origin: "global",
    autoStartSession: rule.to.autoStartSession,
    domain,
  };
}

/**
 * Convert graph neighbors (feedsInto) into ResolvedNextStep suggestions.
 *
 * @param {PlanningNode} sourceNode
 * @param {PlanningNode[]} allNodes
 * @returns {ResolvedNextStep[]}
 */
function toResolvedFromGraphNeighbors(sourceNode, allNodes) {
  const nodes = asNodeArray(allNodes);
  const neighbors = getOutboundNeighbors(nodes, sourceNode.id);
  if (!neighbors.length) return [];

  const sourceId = normalizeId(sourceNode.id);

  return neighbors.map((target) => {
    const targetId = normalizeId(target.id);
    return {
      sourceNodeId: sourceId,
      targetId,
      label: target.title || `Next: ${targetId}`,
      reason: "Follows from Planning Graph connection",
      priority: 0,
      tags: ["graph-linked"],
      origin: "graph",
      autoStartSession: false,
      domain: target.domain || sourceNode.domain || "unknown",
    };
  });
}

// -----------------------------------------------------------------------------
// Public: collection & merge logic
// -----------------------------------------------------------------------------

/**
 * Collect node-specific next steps from node.meta.nextSteps / node.meta.nextStepOverrides.
 * If nextStepOverrides is present and non-empty, it replaces meta.nextSteps.
 *
 * @param {PlanningNode} node
 * @param {PlanningNode[]} allNodes
 * @returns {ResolvedNextStep[]}
 */
export function collectNodeSpecificNextSteps(node, allNodes) {
  const meta = (node && node.meta) || {};
  /** @type {NodeSpecificNextStep[]} */
  const overrides = Array.isArray(meta.nextStepOverrides)
    ? meta.nextStepOverrides
    : [];
  /** @type {NodeSpecificNextStep[]} */
  const base = Array.isArray(meta.nextSteps) ? meta.nextSteps : [];

  const list = overrides.length ? overrides : base;
  if (!list.length) return [];

  const result = [];
  for (const ns of list) {
    const resolved = toResolvedFromNodeSpecific(node, ns, allNodes);
    if (resolved) result.push(resolved);
  }
  return result;
}

/**
 * Collect global mapping-based next steps for a node.
 *
 * @param {PlanningNode} node
 * @param {PlanningNode[]} allNodes
 * @param {GlobalMappings | null | undefined} globalMappings
 * @returns {ResolvedNextStep[]}
 */
export function collectGlobalNextSteps(node, allNodes, globalMappings) {
  if (!globalMappings) return [];

  const candidates = getCandidateGlobalMappings(node, globalMappings);
  if (!candidates.length) return [];

  const result = [];
  for (const rule of candidates) {
    const resolved = toResolvedFromGlobalRule(node, rule, allNodes);
    if (resolved) result.push(resolved);
  }
  return result;
}

/**
 * Collect graph-based next steps (neighbor nodes via feedsInto).
 *
 * @param {PlanningNode} node
 * @param {PlanningNode[]} allNodes
 * @returns {ResolvedNextStep[]}
 */
export function collectGraphNextSteps(node, allNodes) {
  if (!node || !node.id) return [];
  return toResolvedFromGraphNeighbors(node, allNodes);
}

/**
 * Merge and rank next steps from node-specific, global, and graph sources.
 * Priority rules:
 *    1. Node-specific overrides everything for the same targetId.
 *    2. Global mapping beats graph for same targetId.
 *    3. Higher priority numeric value wins.
 *    4. As a tie-breaker, node-specific > global > graph.
 *
 * @param {ResolvedNextStep[]} nodeSpecific
 * @param {ResolvedNextStep[]} global
 * @param {ResolvedNextStep[]} graph
 * @param {{ maxResults?: number }} [options]
 * @returns {ResolvedNextStep[]}
 */
export function mergeAndRankNextSteps(
  nodeSpecific,
  global,
  graph,
  options = {}
) {
  const maxResults =
    typeof options.maxResults === "number" && options.maxResults > 0
      ? options.maxResults
      : undefined;

  /** @type {Map<string, ResolvedNextStep>} */
  const byTargetId = new Map();

  const insert = (step) => {
    if (!step || !step.targetId) return;
    const key = normalizeId(step.targetId);
    const existing = byTargetId.get(key);
    if (!existing) {
      byTargetId.set(key, step);
      return;
    }

    // Ranking logic for conflict resolution
    const originRank = (origin) => {
      switch (origin) {
        case "node-specific":
          return 3;
        case "global":
          return 2;
        case "graph":
          return 1;
        default:
          return 0;
      }
    };

    const existingOriginRank = originRank(existing.origin);
    const newOriginRank = originRank(step.origin);

    if (newOriginRank > existingOriginRank) {
      byTargetId.set(key, step);
      return;
    }

    if (newOriginRank === existingOriginRank) {
      // tie-break on priority
      if (step.priority > existing.priority) {
        byTargetId.set(key, step);
      }
    }
  };

  nodeSpecific.forEach(insert);
  global.forEach(insert);
  graph.forEach(insert);

  const merged = Array.from(byTargetId.values());

  merged.sort((a, b) => {
    // Primary: priority desc
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }

    // Secondary: origin rank desc
    const originRank = (origin) => {
      switch (origin) {
        case "node-specific":
          return 3;
        case "global":
          return 2;
        case "graph":
          return 1;
        default:
          return 0;
      }
    };
    const oa = originRank(a.origin);
    const ob = originRank(b.origin);
    if (ob !== oa) return ob - oa;

    // Tertiary: label asc for stability
    return (a.label || "").localeCompare(b.label || "");
  });

  if (typeof maxResults === "number") {
    return merged.slice(0, maxResults);
  }
  return merged;
}

/**
 * Resolve "Next Steps" for a node in one call.
 *
 * This is the main entry-point you'll likely use from orchestration and UI.
 *
 * @param {PlanningNode | null | undefined} node
 * @param {{
 *   allNodes: PlanningNode[],
 *   globalMappings?: GlobalMappings | null,
 *   includeGraph?: boolean,
 *   maxResults?: number
 * }} options
 * @returns {ResolvedNextStep[]}
 */
export function resolveNextSteps(node, options) {
  if (!node || !node.id) return [];

  const {
    allNodes,
    globalMappings = null,
    includeGraph = true,
    maxResults,
  } = options || {};

  const nodes = asNodeArray(allNodes);

  const nodeSpecific = collectNodeSpecificNextSteps(node, nodes);
  const global = collectGlobalNextSteps(node, nodes, globalMappings);
  const graph = includeGraph ? collectGraphNextSteps(node, nodes) : [];

  return mergeAndRankNextSteps(nodeSpecific, global, graph, { maxResults });
}

// -----------------------------------------------------------------------------
// Optional convenience: resolve by node id
// -----------------------------------------------------------------------------

/**
 * Resolve "Next Steps" when you only have a nodeId.
 *
 * @param {string} nodeId
 * @param {{
 *   allNodes: PlanningNode[],
 *   globalMappings?: GlobalMappings | null,
 *   includeGraph?: boolean,
 *   maxResults?: number
 * }} options
 * @returns {ResolvedNextStep[]}
 */
export function resolveNextStepsByNodeId(nodeId, options) {
  const nodes = asNodeArray(options && options.allNodes);
  const node = findNodeById(nodes, nodeId);
  if (!node) return [];
  return resolveNextSteps(node, options);
}

// -----------------------------------------------------------------------------
// Default export for convenience
// -----------------------------------------------------------------------------

const mappingResolvers = {
  collectNodeSpecificNextSteps,
  collectGlobalNextSteps,
  collectGraphNextSteps,
  mergeAndRankNextSteps,
  resolveNextSteps,
  resolveNextStepsByNodeId,
};

export default mappingResolvers;
