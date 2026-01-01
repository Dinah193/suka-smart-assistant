// C:\Users\larho\suka-smart-assistant\src\features\planning\useNextSteps.js

/**
 * useNextSteps
 * ------------
 * How this fits SSA:
 * - The Planning Graph links calculators, planners, and tools across domains.
 * - After a user finishes a node (e.g., Macro Calculator, Storehouse Goal),
 *   we want to surface *actionable next steps*:
 *     • Which downstream nodes are relevant?
 *     • Which sessions (cooking / cleaning / garden / animals / preservation / storehouse)
 *       can be launched *now* as a follow-up?
 * - This hook:
 *     • Looks at the outbound edges from a node in the Planning Graph.
 *     • Evaluates any simple conditions defined on those edges against the `result`
 *       (e.g. caloriesTooLow → suggest Storehouse Planner, etc.).
 *     • Scores and ranks the candidate “Next Steps”.
 *     • Optionally matches recommended sessions for each neighbor node so
 *       domain pages can drive the SessionRunner “Now” CTA.
 *
 * Notes:
 * - This hook is synchronous and read-only. It does *not* mutate Dexie or emit events.
 * - Higher-level orchestration (guards, SessionRunner, Hub export) happens elsewhere.
 * - Extension points:
 *   • Add more condition operators in `evaluateConditions`.
 *   • Enrich scoring logic in `scoreCandidate`.
 *   • Teach the graph about more `edge.relation` flavors and `node.kind` types.
 */

/* eslint-disable no-console */

import { useMemo } from "react";
import { usePlanningGraph } from "./usePlanningGraph";

/**
 * @typedef {Object} PlanningNode
 * @property {string} id
 * @property {string} domain              // "cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"
 * @property {string} [kind]              // "calculator"|"planner"|"sessionTemplate"|...
 * @property {string} [title]
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {Object.<string, any>} [meta]
 */

/**
 * @typedef {Object} PlanningEdgeCondition
 * @property {string} path                // dot-path into result (e.g. "macros.protein.gPerDay")
 * @property {"gt"|"gte"|"lt"|"lte"|"eq"|"neq"|"exists"|"in"|"notIn"} op
 * @property {any} [value]
 */

/**
 * @typedef {Object} PlanningEdge
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {string} [relation]          // "feedsInto"|"requires"|"suggests"|...
 * @property {number} [weight]
 * @property {{
 *   phase?: string,
 *   score?: number,
 *   priority?: number,
 *   label?: string,
 *   conditions?: PlanningEdgeCondition[]
 *   [key: string]: any
 * }} [meta]
 */

/**
 * Minimal session shape for recommendation purposes.
 * This avoids importing deep Session types and keeps the hook decoupled.
 *
 * @typedef {Object} SessionLike
 * @property {string} id
 * @property {string} domain
 * @property {string} title
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @property {{ type: string, refId: (string|null) }} [source]
 * @property {string} [createdAt]         // ISO string
 */

/**
 * @typedef {Object} NextStepsOptions
 * @property {string} [nodeId]            // Preferred: either nodeId or node
 * @property {PlanningNode} [node]
 * @property {any} [result]               // Output of the completed node/calculator
 * @property {SessionLike[]} [sessions]   // Optional: candidate sessions (from Dexie)
 * @property {string} [domainOverride]    // Optional: override domain when selecting sessions
 * @property {number} [limit]             // Max number of recommendations (default: 5)
 */

/**
 * @typedef {Object} NextStepRecommendation
 * @property {string} id
 * @property {"node"|"session"} type
 * @property {PlanningNode|null} node
 * @property {PlanningEdge|null} viaEdge
 * @property {number} score
 * @property {string[]} reasons
 * @property {SessionLike|null} primarySession
 * @property {SessionLike[]} sessions
 */

/**
 * Get value at a dotted path from an object (e.g. "macros.protein.gPerDay").
 * Safe: returns undefined if path cannot be fully resolved.
 *
 * @param {any} obj
 * @param {string} path
 * @returns {any}
 */
function getValueAtPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split(".");
  let cursor = obj;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    if (!(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * Evaluate a single condition against the result.
 *
 * @param {PlanningEdgeCondition} cond
 * @param {any} result
 * @returns {boolean}
 */
function evaluateCondition(cond, result) {
  if (!cond || !cond.path || !cond.op) return false;
  const val = getValueAtPath(result, cond.path);

  switch (cond.op) {
    case "exists":
      return val !== undefined && val !== null;
    case "gt":
      return typeof val === "number" && typeof cond.value === "number" && val > cond.value;
    case "gte":
      return typeof val === "number" && typeof cond.value === "number" && val >= cond.value;
    case "lt":
      return typeof val === "number" && typeof cond.value === "number" && val < cond.value;
    case "lte":
      return typeof val === "number" && typeof cond.value === "number" && val <= cond.value;
    case "eq":
      return val === cond.value;
    case "neq":
      return val !== cond.value;
    case "in":
      return Array.isArray(cond.value) && cond.value.includes(val);
    case "notIn":
      return Array.isArray(cond.value) && !cond.value.includes(val);
    default:
      return false;
  }
}

/**
 * Evaluate all edge conditions (if any) against the result.
 *
 * @param {PlanningEdge} edge
 * @param {any} result
 * @returns {{ ok: boolean, matched: number, total: number }}
 */
function evaluateConditions(edge, result) {
  const conds = edge?.meta?.conditions;
  if (!Array.isArray(conds) || !conds.length) {
    return { ok: true, matched: 0, total: 0 }; // No conditions means "always ok"
  }

  let matched = 0;
  for (const cond of conds) {
    if (evaluateCondition(cond, result)) matched += 1;
  }
  const total = conds.length;
  return { ok: matched === total, matched, total };
}

/**
 * Heuristic scoring for a candidate next step.
 *
 * @param {PlanningNode} fromNode
 * @param {PlanningNode} toNode
 * @param {PlanningEdge} edge
 * @param {{ ok: boolean, matched: number, total: number }} condEval
 * @returns {number}
 */
function scoreCandidate(fromNode, toNode, edge, condEval) {
  if (!fromNode || !toNode || !edge) return 0;
  if (!condEval.ok) return 0;

  let score = 0;

  // Base on explicit metadata if provided.
  if (typeof edge.meta?.score === "number") score += edge.meta.score;
  if (typeof edge.meta?.priority === "number") score += edge.meta.priority * 10;
  if (typeof edge.weight === "number") score += edge.weight;

  // Favor "feedsInto" relations over generic ones.
  if (edge.relation === "feedsInto") score += 20;
  else if (edge.relation === "suggests") score += 10;
  else if (edge.relation === "requires") score += 15;

  // Reward having conditions that all pass.
  if (condEval.total > 0) {
    score += 5 + condEval.matched * 2;
  }

  // Light boost when domains differ (cross-domain flow, e.g. from calculator to planner).
  if (fromNode.domain !== toNode.domain) {
    score += 5;
  }

  // Small boost for sessionTemplate kind.
  if (toNode.kind === "sessionTemplate") {
    score += 8;
  }

  return score;
}

/**
 * Filter sessions for a domain and sort by createdAt asc (then id).
 *
 * @param {string} domain
 * @param {SessionLike[]|undefined} sessions
 * @returns {SessionLike[]}
 */
function getRunnableSessionsForDomain(domain, sessions) {
  if (!domain || !Array.isArray(sessions)) return [];
  const runnableStatuses = new Set(["pending", "paused"]);

  const subset = sessions.filter(
    (s) =>
      s &&
      s.domain === domain &&
      s.status &&
      runnableStatuses.has(s.status)
  );

  return subset.sort((a, b) => {
    const aCreated = a.createdAt ? Date.parse(a.createdAt) || 0 : 0;
    const bCreated = b.createdAt ? Date.parse(b.createdAt) || 0 : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    if (a.id && b.id && a.id !== b.id) return a.id.localeCompare(b.id);
    return 0;
  });
}

/**
 * React hook: compute recommended "Next Steps" given a Planning Graph node
 * and its result. This is the planning-layer helper that domain pages can
 * use to power "Next Actions" panels and SessionRunner "Now" CTAs.
 *
 * Example:
 *   const { node, recommendations, debug } = useNextSteps({
 *     nodeId: "node.macroCalculator",
 *     result: macroResult,
 *     sessions: allSessionsFromDexie,
 *     limit: 4,
 *   });
 *
 *   // Use `recommendations` to show:
 *   // - Next planners / calculators
 *   // - Launch buttons for the primarySession of each recommendation
 *
 * @param {NextStepsOptions} options
 * @returns {{
 *   node: PlanningNode | null,
 *   hasGraph: boolean,
 *   recommendations: NextStepRecommendation[],
 *   debug: {
 *     evaluatedEdges: {
 *       edgeId: string,
 *       toNodeId: string|null,
 *       condEval: { ok: boolean, matched: number, total: number },
 *       rawScore: number
 *     }[],
 *     filters: {
 *       limit: number,
 *       domainOverride: string | null
 *     }
 *   }
 * }}
 */
export function useNextSteps(options) {
  const {
    nodeId: rawNodeId,
    node: rawNode,
    result,
    sessions,
    domainOverride,
    limit = 5,
  } = options || {};

  const {
    graph,
    getNodeById,
    getOutboundNeighbors,
  } = usePlanningGraph();

  return useMemo(() => {
    const hasGraph = !!graph && Array.isArray(graph.nodes) && graph.nodes.length > 0;

    /** @type {PlanningNode|null} */
    let node = null;

    if (rawNode && typeof rawNode.id === "string") {
      node = rawNode;
    } else if (rawNodeId) {
      node = getNodeById(rawNodeId) || null;
    }

    if (!hasGraph || !node) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[useNextSteps] No graph or node available for recommendations.", {
          hasGraph,
          nodeId: rawNodeId,
        });
      }
      return {
        node,
        hasGraph,
        recommendations: [],
        debug: {
          evaluatedEdges: [],
          filters: { limit, domainOverride: domainOverride || null },
        },
      };
    }

    const { edges: outboundEdges, nodes: neighborNodes } =
      getOutboundNeighbors(node.id);

    if (!Array.isArray(outboundEdges) || !outboundEdges.length) {
      return {
        node,
        hasGraph,
        recommendations: [],
        debug: {
          evaluatedEdges: [],
          filters: { limit, domainOverride: domainOverride || null },
        },
      };
    }

    const neighborIndex = Object.create(null);
    for (const n of neighborNodes) {
      if (!n || !n.id) continue;
      neighborIndex[n.id] = n;
    }

    /** @type {NextStepRecommendation[]} */
    const recommendations = [];
    /** @type {any[]} */
    const evaluatedEdges = [];

    for (const edge of outboundEdges) {
      if (!edge || !edge.id) continue;
      const toNode = neighborIndex[edge.to] || null;
      if (!toNode) {
        evaluatedEdges.push({
          edgeId: edge.id,
          toNodeId: null,
          condEval: { ok: false, matched: 0, total: 0 },
          rawScore: 0,
        });
        continue;
      }

      const condEval = evaluateConditions(edge, result);
      const rawScore = scoreCandidate(node, toNode, edge, condEval);

      evaluatedEdges.push({
        edgeId: edge.id,
        toNodeId: toNode.id,
        condEval,
        rawScore,
      });

      if (!condEval.ok || rawScore <= 0) continue;

      // Determine which domain we should use when suggesting sessions.
      const effectiveDomain = domainOverride || toNode.domain || node.domain;
      const candidateSessions = getRunnableSessionsForDomain(
        effectiveDomain,
        sessions
      );

      /** @type {SessionLike|null} */
      const primarySession = candidateSessions.length ? candidateSessions[0] : null;

      /** @type {NextStepRecommendation} */
      const rec = {
        id: `nextStep:${node.id}→${toNode.id}:${edge.id}`,
        type: primarySession ? "session" : "node",
        node: toNode,
        viaEdge: edge,
        score: rawScore,
        reasons: buildReasons(node, toNode, edge, condEval, primarySession),
        primarySession,
        sessions: candidateSessions,
      };

      recommendations.push(rec);
    }

    // Sort recommendations by score desc, then by node title.
    recommendations.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aTitle = a.node?.title || "";
      const bTitle = b.node?.title || "";
      return aTitle.localeCompare(bTitle);
    });

    const limitedRecs = Number.isFinite(limit) && limit > 0
      ? recommendations.slice(0, limit)
      : recommendations;

    return {
      node,
      hasGraph,
      recommendations: limitedRecs,
      debug: {
        evaluatedEdges,
        filters: {
          limit,
          domainOverride: domainOverride || null,
        },
      },
    };
  }, [
    graph,
    getNodeById,
    getOutboundNeighbors,
    rawNodeId,
    rawNode,
    result,
    sessions,
    domainOverride,
    limit,
  ]);
}

/**
 * Build human-readable reasons for a recommendation.
 *
 * @param {PlanningNode} fromNode
 * @param {PlanningNode} toNode
 * @param {PlanningEdge} edge
 * @param {{ ok: boolean, matched: number, total: number }} condEval
 * @param {SessionLike|null} primarySession
 * @returns {string[]}
 */
function buildReasons(fromNode, toNode, edge, condEval, primarySession) {
  const reasons = [];

  if (edge.meta?.label) {
    reasons.push(edge.meta.label);
  } else {
    if (edge.relation === "feedsInto") {
      reasons.push(`${toNode.title || toNode.id} builds on your latest ${fromNode.title || fromNode.id} result.`);
    } else if (edge.relation === "requires") {
      reasons.push(`${toNode.title || toNode.id} is a recommended follow-up step.`);
    } else if (edge.relation === "suggests") {
      reasons.push(`${toNode.title || toNode.id} is a suggested next action.`);
    } else {
      reasons.push(`Next: ${toNode.title || toNode.id}.`);
    }
  }

  if (condEval.total > 0 && condEval.ok) {
    reasons.push(`All ${condEval.total} conditions for this next step are satisfied.`);
  }

  if (primarySession) {
    reasons.push(`You have a runnable session ready: "${primarySession.title}".`);
  }

  return reasons;
}
