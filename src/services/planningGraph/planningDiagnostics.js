// C:\Users\larho\suka-smart-assistant\src\services\planningGraph\planningDiagnostics.js

/**
 * Planning Graph Diagnostics
 *
 * How this fits:
 * - The Planning Graph is the “map” SSA uses to connect calculators,
 *   sessions, storehouse goals, garden plans, stability flows, etc.
 * - This module provides tools to validate graph integrity so that
 *   automation and SessionRunner flows don’t blow up at runtime.
 *
 * Responsibilities:
 * - Load + index a Planning Graph by id.
 * - Run a set of integrity checks:
 *   • duplicate node ids
 *   • edges pointing to non-existent nodes
 *   • duplicate edges
 *   • isolated nodes (no in/out edges)
 *   • unknown domains (optionally)
 * - Return a diagnostics result object.
 * - Emit diagnostics events onto the SSA eventBus:
 *   • planningGraph.diagnostics.started
 *   • planningGraph.diagnostics.issue
 *   • planningGraph.diagnostics.completed
 *
 * Extension points:
 * - Add more checks in `runPlanningDiagnostics`:
 *   • unexpected edge types
 *   • required subgraphs (e.g., stability baseline nodes)
 *   • cycles for specific edge types that should be DAGs.
 */

import eventBus from "@/services/eventBus";
import { getIndexedPlanningGraph } from "@/services/planningGraph/planningGraphIndex";

/**
 * @typedef {"info" | "warning" | "error"} DiagnosticSeverity
 */

/**
 * @typedef {Object} PlanningGraphDiagnosticIssue
 * @property {string} id                     - stable issue id (per check type)
 * @property {DiagnosticSeverity} severity
 * @property {string} type                   - category key (e.g. "duplicateNodeId")
 * @property {string} message                - human-readable summary
 * @property {string} [nodeId]
 * @property {string} [edgeId]
 * @property {any} [data]
 */

/**
 * @typedef {Object} PlanningGraphDiagnosticsSummary
 * @property {number} errorCount
 * @property {number} warningCount
 * @property {number} infoCount
 * @property {boolean} hasErrors
 */

/**
 * @typedef {Object} PlanningGraphDiagnosticsResult
 * @property {string} graphId
 * @property {string} version
 * @property {number} ts                     - timestamp (ms)
 * @property {PlanningGraphDiagnosticIssue[]} issues
 * @property {PlanningGraphDiagnosticsSummary} summary
 */

/**
 * @typedef {Object} PlanningGraphDiagnosticsOptions
 * @property {boolean} [emitEvents=true]     - whether to emit diagnostics.* events
 * @property {string[]} [allowedDomains]     - allowed node.domain values; if omitted,
 *                                             domain check is skipped.
 */

/** ------------------------------------------------------------------------
 *  Public API
 * --------------------------------------------------------------------- */

/**
 * Run all configured diagnostics on a Planning Graph.
 *
 * @param {string} graphId
 * @param {PlanningGraphDiagnosticsOptions} [options]
 * @returns {Promise<PlanningGraphDiagnosticsResult>}
 */
export async function runPlanningDiagnostics(graphId, options = {}) {
  if (!graphId) {
    throw new Error("[planningDiagnostics] graphId is required");
  }

  const emitEvents = options.emitEvents !== false;
  const allowedDomains = Array.isArray(options.allowedDomains)
    ? options.allowedDomains
    : null;

  if (emitEvents) {
    safeEmit({
      type: "planningGraph.diagnostics.started",
      source: "planningGraph.diagnostics",
      data: { graphId },
    });
  }

  const index = await getIndexedPlanningGraph(graphId);
  /** @type {PlanningGraphDiagnosticIssue[]} */
  let issues = [];

  issues = issues.concat(
    checkDuplicateNodeIds(index),
    checkEdgesReferenceExistingNodes(index),
    checkDuplicateEdges(index),
    checkIsolatedNodes(index),
    allowedDomains ? checkUnknownDomains(index, allowedDomains) : []
  );

  const summary = summarizeIssues(issues);
  const result = /** @type {PlanningGraphDiagnosticsResult} */ ({
    graphId: index.id,
    version: index.version,
    ts: Date.now(),
    issues,
    summary,
  });

  if (emitEvents) {
    for (const issue of issues) {
      safeEmit({
        type: "planningGraph.diagnostics.issue",
        source: "planningGraph.diagnostics",
        data: {
          graphId: index.id,
          version: index.version,
          issue,
        },
      });
    }

    safeEmit({
      type: "planningGraph.diagnostics.completed",
      source: "planningGraph.diagnostics",
      data: {
        graphId: index.id,
        version: index.version,
        summary,
        issueCount: issues.length,
      },
    });
  }

  return result;
}

/** ------------------------------------------------------------------------
 *  Individual checks
 * --------------------------------------------------------------------- */

/**
 * Check for duplicate node IDs in the raw nodes list.
 *
 * @param {import("./planningGraphIndex").PlanningGraphIndex} index
 * @returns {PlanningGraphDiagnosticIssue[]}
 */
function checkDuplicateNodeIds(index) {
  /** @type {PlanningGraphDiagnosticIssue[]} */
  const issues = [];
  const seen = new Map();

  for (const node of index.nodes || []) {
    if (!node || !node.id) continue;

    if (seen.has(node.id)) {
      const first = seen.get(node.id);
      issues.push({
        id: `duplicateNodeId:${node.id}`,
        severity: "error",
        type: "duplicateNodeId",
        message: `Duplicate node id "${node.id}" found.`,
        nodeId: node.id,
        data: {
          firstIndex: first.index,
          duplicateIndex: node.__index ?? null,
        },
      });
    } else {
      seen.set(node.id, { index: node.__index ?? null });
    }
  }

  return issues;
}

/**
 * Check that every edge's from/to nodes exist.
 *
 * @param {import("./planningGraphIndex").PlanningGraphIndex} index
 * @returns {PlanningGraphDiagnosticIssue[]}
 */
function checkEdgesReferenceExistingNodes(index) {
  /** @type {PlanningGraphDiagnosticIssue[]} */
  const issues = [];
  const nodeById = index.nodeById || new Map();

  for (const edge of index.edges || []) {
    if (!edge) continue;
    const edgeId = edge.id || `${edge.from}→${edge.to}:${edge.type || "edge"}`;
    const missing = [];

    if (!edge.from || !nodeById.has(edge.from)) {
      missing.push("from");
    }
    if (!edge.to || !nodeById.has(edge.to)) {
      missing.push("to");
    }

    if (missing.length > 0) {
      issues.push({
        id: `danglingEdge:${edgeId}`,
        severity: "error",
        type: "danglingEdge",
        message: `Edge "${edgeId}" references missing node(s): ${missing.join(
          ", "
        )}.`,
        edgeId,
        data: {
          from: edge.from,
          to: edge.to,
          type: edge.type || null,
          missing,
        },
      });
    }
  }

  return issues;
}

/**
 * Check for duplicate edges (same from/to/type).
 *
 * @param {import("./planningGraphIndex").PlanningGraphIndex} index
 * @returns {PlanningGraphDiagnosticIssue[]}
 */
function checkDuplicateEdges(index) {
  /** @type {PlanningGraphDiagnosticIssue[]} */
  const issues = [];
  const seen = new Map();

  for (const edge of index.edges || []) {
    if (!edge) continue;
    const type = edge.type || "edge";
    const key = `${edge.from || ""}→${edge.to || ""}:${type}`;

    if (seen.has(key)) {
      const first = seen.get(key);
      const edgeId = edge.id || key;
      issues.push({
        id: `duplicateEdge:${key}`,
        severity: "warning",
        type: "duplicateEdge",
        message: `Duplicate edge "${key}" detected.`,
        edgeId,
        data: {
          firstEdgeId: first.id,
          duplicateEdgeId: edge.id || null,
          from: edge.from,
          to: edge.to,
          type,
        },
      });
    } else {
      seen.set(key, {
        id: edge.id || key,
      });
    }
  }

  return issues;
}

/**
 * Check for isolated nodes (no incoming and no outgoing edges).
 *
 * These are often harmless but can indicate incomplete wiring
 * to the rest of the Planning Graph.
 *
 * @param {import("./planningGraphIndex").PlanningGraphIndex} index
 * @returns {PlanningGraphDiagnosticIssue[]}
 */
function checkIsolatedNodes(index) {
  /** @type {PlanningGraphDiagnosticIssue[]} */
  const issues = [];

  const edgesFrom = index.edgesFrom || new Map();
  const edgesTo = index.edgesTo || new Map();

  for (const node of index.nodes || []) {
    if (!node || !node.id) continue;

    const hasOut = (edgesFrom.get(node.id) || []).length > 0;
    const hasIn = (edgesTo.get(node.id) || []).length > 0;

    if (!hasOut && !hasIn) {
      issues.push({
        id: `isolatedNode:${node.id}`,
        severity: "info",
        type: "isolatedNode",
        message: `Node "${node.id}" has no incoming or outgoing edges.`,
        nodeId: node.id,
        data: {
          domain: node.domain || null,
          type: node.type || null,
          label: node.label || null,
        },
      });
    }
  }

  return issues;
}

/**
 * Check that node.domain values are in the allowed set.
 *
 * @param {import("./planningGraphIndex").PlanningGraphIndex} index
 * @param {string[]} allowedDomains
 * @returns {PlanningGraphDiagnosticIssue[]}
 */
function checkUnknownDomains(index, allowedDomains) {
  /** @type {PlanningGraphDiagnosticIssue[]} */
  const issues = [];

  const allowed = new Set(
    allowedDomains.map((d) => String(d || "").trim()).filter(Boolean)
  );

  if (allowed.size === 0) return issues;

  for (const node of index.nodes || []) {
    if (!node || !node.id) continue;
    if (!node.domain) continue;

    const domain = String(node.domain).trim();
    if (!allowed.has(domain)) {
      issues.push({
        id: `unknownDomain:${node.id}`,
        severity: "warning",
        type: "unknownDomain",
        message: `Node "${node.id}" uses unknown domain "${domain}".`,
        nodeId: node.id,
        data: {
          domain,
          allowedDomains: Array.from(allowed),
        },
      });
    }
  }

  return issues;
}

/** ------------------------------------------------------------------------
 *  Summary + events
 * --------------------------------------------------------------------- */

/**
 * Summarize diagnostic issues.
 *
 * @param {PlanningGraphDiagnosticIssue[]} issues
 * @returns {PlanningGraphDiagnosticsSummary}
 */
function summarizeIssues(issues) {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const issue of issues || []) {
    switch (issue.severity) {
      case "error":
        errorCount += 1;
        break;
      case "warning":
        warningCount += 1;
        break;
      case "info":
      default:
        infoCount += 1;
        break;
    }
  }

  return {
    errorCount,
    warningCount,
    infoCount,
    hasErrors: errorCount > 0,
  };
}

/**
 * Core safe emitter respecting SSA's event envelope.
 *
 * @param {{ type: string, source?: string, data?: any }} payload
 */
function safeEmit(payload) {
  if (!payload || !payload.type) return;

  const envelope = {
    type: payload.type,
    ts: new Date().toISOString(),
    source: payload.source || "planningGraph.diagnostics",
    data: payload.data,
  };

  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(envelope);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[planningDiagnostics] safeEmit failed", envelope, err);
  }
}

export default {
  runPlanningDiagnostics,
};
