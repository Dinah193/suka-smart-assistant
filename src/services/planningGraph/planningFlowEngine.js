// C:\Users\larho\suka-smart-assistant\src\services\planningGraph\planningFlowEngine.js

/**
 * Planning Flow Engine
 *
 * How this fits:
 * - The Planning Graph (nodes + edges) describes *what* exists in SSA:
 *   calculators, session templates, storehouse goals, garden plans, etc.
 * - "Planning Flows" describe *how to walk* that graph in a meaningful order
 *   to help the user progress toward a goal (e.g. “Stabilize Storehouse”,
 *   “Winter Garden Prep”, “30-Day Meal Stability Plan”).
 *
 * This engine:
 * - Executes a flow definition step-by-step with rich events:
 *   • planningFlow.started
 *   • planningFlow.step.started
 *   • planningFlow.step.completed
 *   • planningFlow.step.error
 *   • planningFlow.completed
 *   • planningFlow.aborted
 *
 * - Integrates with:
 *   • calculatorRunner for calculator-type steps,
 *   • Planning Graph indexes for node lookups,
 *   • SSA eventBus for analytics/automation listeners.
 *
 * Extension points:
 * - Add new step kinds in `executeFlowStep` (e.g. "sessionTemplate",
 *   "note", "decision", "hubExport", etc.).
 * - Attach domain-specific logic (cooking, garden, animals, storehouse)
 *   by inspecting `node.domain` or `step.meta`.
 */

import eventBus from "@/services/events/eventBus";
import {
  getIndexedPlanningGraph,
  getNodeById,
} from "@/services/planningGraph/planningGraphIndex";
import { runCalculator } from "@/services/calculators/calculatorRunner";

/**
 * @typedef {"calculator" | "sessionTemplate" | "note" | "noop"} PlanningFlowStepKind
 */

/**
 * @typedef {Object} PlanningFlowStep
 * @property {string} id                     - stable step id (for analytics/resume)
 * @property {PlanningFlowStepKind} kind     - what this step does
 * @property {string} [label]                - human label
 * @property {string} [nodeId]               - Planning Graph node id this step is anchored to
 * @property {string} [calculatorId]         - when kind === "calculator"
 * @property {any} [calculatorInput]         - base input for calculator (will be merged with context)
 * @property {any} [meta]                    - arbitrary extra config (domain-specific)
 */

/**
 * @typedef {Object} PlanningFlowDefinition
 * @property {string} id
 * @property {string} label
 * @property {string} [graphId]              - default Planning Graph id this flow is built on
 * @property {string} [description]
 * @property {PlanningFlowStep[]} steps
 */

/**
 * @typedef {Object} PlanningFlowContext
 * @property {string} [householdId]
 * @property {string} [userId]
 * @property {Record<string, any>} [vars]    - arbitrary variables available to steps
 */

/**
 * @typedef {Object} PlanningFlowRunOptions
 * @property {string} [graphId]                      - override flow.graphId
 * @property {AbortSignal} [signal]                  - optional cancellation
 * @property {PlanningFlowContext} [context]         - execution context
 * @property {(payload: FlowStepLifecyclePayload) => void} [onStepLifecycle]
 *           Optional callback fired on step start/complete/error; receives same
 *           payload that is emitted onto eventBus.
 */

/**
 * @typedef {"started" | "completed" | "error"} FlowStepLifecyclePhase
 */

/**
 * @typedef {Object} FlowStepLifecyclePayload
 * @property {FlowStepResult["flowId"]} flowId
 * @property {FlowStepResult["flowLabel"]} flowLabel
 * @property {FlowStepResult["stepId"]} stepId
 * @property {FlowStepResult["stepKind"]} stepKind
 * @property {FlowStepResult["stepIndex"]} stepIndex
 * @property {FlowStepLifecyclePhase} phase
 * @property {FlowStepResult["status"]} [status]
 * @property {FlowStepResult["error"]} [error]
 * @property {any} [data]
 */

/**
 * @typedef {"ok" | "skipped" | "error" | "cancelled"} FlowStepStatus
 */

/**
 * @typedef {Object} FlowStepResult
 * @property {string} flowId
 * @property {string} flowLabel
 * @property {string} stepId
 * @property {PlanningFlowStepKind} stepKind
 * @property {number} stepIndex
 * @property {FlowStepStatus} status
 * @property {any} [data]
 * @property {Error | null} [error]
 */

/**
 * @typedef {Object} PlanningFlowRunResult
 * @property {string} flowId
 * @property {string} flowLabel
 * @property {"completed" | "aborted" | "error"} status
 * @property {FlowStepResult[]} steps
 * @property {number} startedAt
 * @property {number} finishedAt
 * @property {number} durationMs
 */

/** ------------------------------------------------------------------------
 *  Public API
 * --------------------------------------------------------------------- */

/**
 * Execute a Planning Flow definition step-by-step.
 *
 * IMPORTANT:
 * - Does not itself schedule or start SessionRunner; for sessionTemplate
 *   steps it emits events that other subsystems (automation runtime)
 *   can listen to and convert into runnable sessions.
 *
 * @param {PlanningFlowDefinition} flowDef
 * @param {PlanningFlowRunOptions} [options]
 * @returns {Promise<PlanningFlowRunResult>}
 */
export async function runPlanningFlow(flowDef, options = {}) {
  if (!flowDef || typeof flowDef !== "object") {
    throw new Error("[planningFlowEngine] flowDef is required");
  }
  if (!Array.isArray(flowDef.steps) || flowDef.steps.length === 0) {
    throw new Error(
      "[planningFlowEngine] flowDef.steps must be a non-empty array"
    );
  }

  const { signal, context = {}, onStepLifecycle } = options;
  const graphId = options.graphId || flowDef.graphId || "default";

  const startedAt = Date.now();
  /** @type {FlowStepResult[]} */
  const stepResults = [];

  emitFlowEvent("planningFlow.started", {
    flowId: flowDef.id,
    label: flowDef.label,
    graphId,
    stepCount: flowDef.steps.length,
  });

  let index = null;
  try {
    // Load + index the graph once if we have a graphId
    if (graphId) {
      index = await getIndexedPlanningGraph(graphId);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[planningFlowEngine] Failed to load Planning Graph index",
      err
    );
  }

  for (let i = 0; i < flowDef.steps.length; i++) {
    const step = flowDef.steps[i];

    // Respect cancellation
    if (signal?.aborted) {
      const cancelledResult = buildStepResult(
        flowDef,
        step,
        i,
        "cancelled",
        null,
        null
      );
      stepResults.push(cancelledResult);

      emitFlowEvent("planningFlow.aborted", {
        flowId: flowDef.id,
        label: flowDef.label,
        reason: "signal.aborted",
      });

      const finishedAt = Date.now();
      return {
        flowId: flowDef.id,
        flowLabel: flowDef.label,
        status: "aborted",
        steps: stepResults,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    }

    // Lifecycle: started
    const startedPayload = {
      flowId: flowDef.id,
      flowLabel: flowDef.label,
      stepId: step.id,
      stepKind: step.kind,
      stepIndex: i,
      phase: "started",
    };
    emitStepLifecycle(startedPayload, onStepLifecycle);

    try {
      const { status, data } = await executeFlowStep({
        flowDef,
        step,
        stepIndex: i,
        graphIndex: index,
        context,
      });

      const result = buildStepResult(flowDef, step, i, status, data, null);
      stepResults.push(result);

      const completedPayload = {
        flowId: flowDef.id,
        flowLabel: flowDef.label,
        stepId: step.id,
        stepKind: step.kind,
        stepIndex: i,
        phase: "completed",
        status,
        data,
      };
      emitStepLifecycle(completedPayload, onStepLifecycle);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const result = buildStepResult(flowDef, step, i, "error", null, error);
      stepResults.push(result);

      const errorPayload = {
        flowId: flowDef.id,
        flowLabel: flowDef.label,
        stepId: step.id,
        stepKind: step.kind,
        stepIndex: i,
        phase: "error",
        status: "error",
        error: {
          message: error.message,
          name: error.name,
        },
      };
      emitStepLifecycle(errorPayload, onStepLifecycle);

      emitFlowEvent("planningFlow.error", {
        flowId: flowDef.id,
        label: flowDef.label,
        stepId: step.id,
        error: {
          message: error.message,
          name: error.name,
        },
      });

      const finishedAt = Date.now();
      return {
        flowId: flowDef.id,
        flowLabel: flowDef.label,
        status: "error",
        steps: stepResults,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    }
  }

  const finishedAt = Date.now();

  emitFlowEvent("planningFlow.completed", {
    flowId: flowDef.id,
    label: flowDef.label,
    stepCount: flowDef.steps.length,
    durationMs: finishedAt - startedAt,
  });

  return {
    flowId: flowDef.id,
    flowLabel: flowDef.label,
    status: "completed",
    steps: stepResults,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
  };
}

/** ------------------------------------------------------------------------
 *  Core step execution
 * --------------------------------------------------------------------- */

/**
 * Execute a single flow step.
 *
 * NOTE:
 * - This is the primary extension point for adding new step kinds.
 *
 * @param {Object} params
 * @param {PlanningFlowDefinition} params.flowDef
 * @param {PlanningFlowStep} params.step
 * @param {number} params.stepIndex
 * @param {import("./planningGraphIndex").PlanningGraphIndex | null} params.graphIndex
 * @param {PlanningFlowContext} params.context
 * @returns {Promise<{ status: FlowStepStatus, data?: any }>}
 */
async function executeFlowStep({
  flowDef,
  step,
  stepIndex,
  graphIndex,
  context,
}) {
  const kind = step.kind || "noop";

  // Attach node (if available) for domain-aware logic
  const node =
    step.nodeId && graphIndex ? getNodeById(graphIndex, step.nodeId) : null;

  switch (kind) {
    case "calculator":
      return executeCalculatorStep({ flowDef, step, stepIndex, node, context });

    case "sessionTemplate":
      return executeSessionTemplateStep({
        flowDef,
        step,
        stepIndex,
        node,
        context,
      });

    case "note":
      return executeNoteStep({ flowDef, step, stepIndex, node, context });

    case "noop":
    default:
      // Safe default: do nothing, but do not error.
      return {
        status: "skipped",
        data: {
          reason: "unsupportedStepKind",
          kind,
        },
      };
  }
}

/**
 * Calculator step:
 * - Uses calculatorRunner to execute a named calculator.
 * - Merges step.calculatorInput with context.vars (context takes precedence).
 *
 * @param {Object} params
 * @param {PlanningFlowDefinition} params.flowDef
 * @param {PlanningFlowStep} params.step
 * @param {number} params.stepIndex
 * @param {import("./planningGraphIndex").PlanningGraphNode | null} params.node
 * @param {PlanningFlowContext} params.context
 * @returns {Promise<{ status: FlowStepStatus, data?: any }>}
 */
async function executeCalculatorStep({
  flowDef,
  step,
  stepIndex,
  node,
  context,
}) {
  if (!step.calculatorId) {
    return {
      status: "skipped",
      data: {
        reason: "missingCalculatorId",
      },
    };
  }

  const baseInput =
    step.calculatorInput && typeof step.calculatorInput === "object"
      ? step.calculatorInput
      : {};

  const mergedInput = {
    ...baseInput,
    ...(context.vars || {}),
  };

  const calcContext = {
    flowId: flowDef.id,
    flowLabel: flowDef.label,
    stepId: step.id,
    stepIndex,
    node,
    context,
  };

  const result = await runCalculator(step.calculatorId, mergedInput, {
    context: calcContext,
  });

  return {
    status: "ok",
    data: {
      calculatorId: step.calculatorId,
      input: mergedInput,
      result,
    },
  };
}

/**
 * Session template step:
 * - Does NOT directly launch SessionRunner.
 * - Emits an event for the automation runtime to pick up and turn into
 *   a domain session (cooking, cleaning, garden, animals, etc.).
 *
 * @param {Object} params
 * @param {PlanningFlowDefinition} params.flowDef
 * @param {PlanningFlowStep} params.step
 * @param {number} params.stepIndex
 * @param {import("./planningGraphIndex").PlanningGraphNode | null} params.node
 * @param {PlanningFlowContext} params.context
 * @returns {Promise<{ status: FlowStepStatus, data?: any }>}
 */
async function executeSessionTemplateStep({
  flowDef,
  step,
  stepIndex,
  node,
  context,
}) {
  const payload = {
    flowId: flowDef.id,
    flowLabel: flowDef.label,
    stepId: step.id,
    stepIndex,
    nodeId: step.nodeId || node?.id || null,
    nodeDomain: node?.domain || null,
    nodeType: node?.type || null,
    nodeLabel: node?.label || null,
    meta: step.meta || {},
    context,
  };

  safeEmit({
    type: "planningFlow.sessionTemplate.ready",
    source: "planningFlow.engine",
    data: payload,
  });

  return {
    status: "ok",
    data: {
      emittedEvent: "planningFlow.sessionTemplate.ready",
      payload,
    },
  };
}

/**
 * Note step:
 * - Used for simple informational / guidance steps.
 * - No side effects beyond event emission.
 *
 * @param {Object} params
 * @param {PlanningFlowDefinition} params.flowDef
 * @param {PlanningFlowStep} params.step
 * @param {number} params.stepIndex
 * @param {import("./planningGraphIndex").PlanningGraphNode | null} params.node
 * @param {PlanningFlowContext} params.context
 * @returns {Promise<{ status: FlowStepStatus, data?: any }>}
 */
async function executeNoteStep({ flowDef, step, stepIndex, node, context }) {
  const data = {
    flowId: flowDef.id,
    flowLabel: flowDef.label,
    stepId: step.id,
    stepIndex,
    nodeId: step.nodeId || node?.id || null,
    label: step.label || node?.label || null,
    note: step.meta?.note || null,
    context,
  };

  safeEmit({
    type: "planningFlow.note",
    source: "planningFlow.engine",
    data,
  });

  return {
    status: "ok",
    data,
  };
}

/** ------------------------------------------------------------------------
 *  Helpers
 * --------------------------------------------------------------------- */

/**
 * Build a normalized FlowStepResult object.
 *
 * @param {PlanningFlowDefinition} flowDef
 * @param {PlanningFlowStep} step
 * @param {number} stepIndex
 * @param {FlowStepStatus} status
 * @param {any} data
 * @param {Error | null} error
 * @returns {FlowStepResult}
 */
function buildStepResult(flowDef, step, stepIndex, status, data, error) {
  return {
    flowId: flowDef.id,
    flowLabel: flowDef.label,
    stepId: step.id,
    stepKind: step.kind || "noop",
    stepIndex,
    status,
    data,
    error: error || null,
  };
}

/**
 * Internal helper: emit flow-level events.
 *
 * @param {string} eventType
 * @param {any} data
 */
function emitFlowEvent(eventType, data) {
  safeEmit({
    type: eventType,
    source: "planningFlow.engine",
    data,
  });
}

/**
 * Internal helper: emit step lifecycle + call optional callback.
 *
 * @param {FlowStepLifecyclePayload} payload
 * @param {(payload: FlowStepLifecyclePayload) => void | undefined} cb
 */
function emitStepLifecycle(payload, cb) {
  safeEmit({
    type: "planningFlow.step.lifecycle",
    source: "planningFlow.engine",
    data: payload,
  });

  if (typeof cb === "function") {
    try {
      cb(payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[planningFlowEngine] onStepLifecycle callback failed", err);
    }
  }
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
    source: payload.source || "planningFlow.engine",
    data: payload.data,
  };

  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(envelope);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[planningFlowEngine] safeEmit failed", envelope, err);
  }
}

export default {
  runPlanningFlow,
};
