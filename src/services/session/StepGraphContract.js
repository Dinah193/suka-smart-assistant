// src/services/sessions/StepGraphContract.js
//
// StepGraphContract
// ------------------
// This file defines the *single* canonical structure for a “session-ready”
// artifact in Suka Smart Assistant (SSA).
//
// Pipeline role:
//   imports → intelligence → StepGraph → automation(SessionRunner) → (optional) Hub export
//
// - Domain engines (cooking, cleaning, garden, animals, preservation, storehouse)
//   must convert their normalized artifacts (recipes, routines, plans) into a
//   unified StepGraph via `toStepGraph(domain, artifact)`.
// - SessionRunner consumes StepGraphs, *not* raw arrays, so multi-timers,
//   dependencies, and inventory effects are always available in one place.
// - This module is intentionally domain-agnostic and forward-thinking. It
//   normalizes common shapes but leaves extension points for future domains.

/* ---------------------------------- Imports ---------------------------------- */

import { emitEvent } from "../eventBus";

/**
 * Safe wrapper around the shared event bus.
 * The event bus is responsible for broadcasting household events like:
 * - session.stepGraph.created
 * - session.stepGraph.invalid
 */
function safeEmit(payload) {
  if (typeof emitEvent === "function") {
    try {
      emitEvent(payload);
    } catch (err) {
      // Fail silently in production; log more in dev.
      if (typeof console !== "undefined") {
        console.warn("[StepGraphContract] Failed to emit event", err);
      }
    }
  }
}

/* --------------------------------- Typedefs ---------------------------------- */
/**
 * @typedef {Object} Duration
 * @property {number} seconds - Total duration in seconds (normalized).
 */

/**
 * @typedef {Object} IngredientLike
 * @property {string} id
 * @property {string} name
 * @property {number|null} [quantity]
 * @property {string|null} [unit]
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} MaterialLike
 * @property {string} id
 * @property {string} name
 * @property {number|null} [quantity]
 * @property {string|null} [unit]
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} EquipmentLike
 * @property {string} id
 * @property {string} name
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} StepNodeBehavior
 * @property {boolean} [isBlocking]    - If true, downstream steps should not start until complete.
 * @property {boolean} [canParallel]   - If true, runner can overlap with other non-blocking steps.
 * @property {string}  [phase]         - Optional phase name ("prep", "cook", "cleanup", "planting", etc.).
 */

/**
 * @typedef {Object} StepNode
 * @property {string} id
 * @property {string} domain           - e.g. "cooking", "cleaning", "garden", "animals", "preservation", "storehouse"
 * @property {string} kind             - e.g. "prep", "action", "wait", "move", "measurement"
 * @property {string} label
 * @property {string} [description]
 * @property {Duration|null} [duration]
 * @property {IngredientLike[]} [ingredients]
 * @property {MaterialLike[]} [materials]
 * @property {EquipmentLike[]} [equipment]
 * @property {StepNodeBehavior} [behavior]
 * @property {Object} [metadata]       - Domain-specific extras (temperature, location, safety notes, etc.)
 */

/**
 * @typedef {Object} StepEdge
 * @property {string} from             - Source node ID.
 * @property {string} to               - Target node ID.
 * @property {string} [kind]           - e.g. "sequential", "dependency", "optional", "loop".
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} StepTimer
 * @property {string} id
 * @property {string} label
 * @property {Duration} duration
 * @property {string[]} nodeIds        - Nodes primarily associated with this timer.
 * @property {string} [kind]           - e.g. "countdown", "hold", "rest", "bake", "soak".
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} InventoryDeltaItem
 * @property {string} id
 * @property {string} name
 * @property {number} quantity
 * @property {string} [unit]
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} StepGraphInventory
 * @property {InventoryDeltaItem[]} [consumes]  - Things taken from storehouse/inventory.
 * @property {InventoryDeltaItem[]} [produces]  - Things produced (jars, meals, preserved goods, etc.).
 */

/**
 * @typedef {Object} StepGraphMetadata
 * @property {string} [artifactId]     - Original domain artifact ID.
 * @property {string} [title]
 * @property {string} [source]         - e.g. "import.recipe", "user.routine", "auto.generated".
 * @property {string} [createdAt]      - ISO date string.
 * @property {string} [updatedAt]      - ISO date string.
 * @property {Object} [tags]           - Arbitrary tags, e.g. { season: "spring", skillLevel: "beginner" }.
 * @property {Object} [extra]          - Domain-specific extras (meal plan references, bed location, etc.).
 */

/**
 * @typedef {Object} StepGraph
 * @property {number} version
 * @property {string} domain
 * @property {StepNode[]} nodes
 * @property {StepEdge[]} edges
 * @property {StepTimer[]} timers
 * @property {StepGraphInventory} inventory
 * @property {StepGraphMetadata} metadata
 */

/* --------------------------------- Constants --------------------------------- */

export const STEP_GRAPH_VERSION = 1;

/** Supported domain identifiers (forward-compatible: add new domains here). */
export const SUPPORTED_DOMAINS = Object.freeze([
  "cooking",
  "cleaning",
  "garden",
  "animals",
  "preservation",
  "storehouse",
]);

/* ---------------------------- Public Entry Point ----------------------------- */

/**
 * Convert a normalized domain artifact into a unified StepGraph.
 *
 * @param {string} domain  - Domain identifier (e.g. "cooking", "cleaning").
 * @param {Object} artifact - Normalized domain artifact (recipe, routine, plan, etc.).
 * @returns {StepGraph|null} - A valid StepGraph or null on validation failure.
 */
export function toStepGraph(domain, artifact) {
  const ts = new Date().toISOString();

  if (!domain || typeof domain !== "string") {
    reportInvalid("Invalid or missing domain", {
      domain,
      artifactSummary: summarizeArtifact(artifact),
    });
    return null;
  }

  if (!SUPPORTED_DOMAINS.includes(domain)) {
    // Allow forward-compatibility but emit a warning/event.
    if (typeof console !== "undefined") {
      console.warn(
        `[StepGraphContract] Domain "${domain}" is not in SUPPORTED_DOMAINS. Proceeding anyway for forward-compatibility.`
      );
    }
  }

  if (!artifact || typeof artifact !== "object") {
    reportInvalid("Artifact must be a non-null object", { domain, artifact });
    return null;
  }

  const graph = normalizeArtifactToStepGraph(domain, artifact);

  if (!isValidStepGraph(graph)) {
    reportInvalid("StepGraph validation failed", {
      domain,
      graphSummary: summarizeGraph(graph),
    });
    return null;
  }

  // Emit a standard event so analytics/automation can react.
  safeEmit({
    type: "session.stepGraph.created",
    ts,
    source: "services.sessions.StepGraphContract.toStepGraph",
    data: {
      domain,
      version: graph.version,
      artifactId: graph?.metadata?.artifactId || artifact.id || null,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      timerCount: graph.timers.length,
    },
  });

  return graph;
}

/* ---------------------------- Normalization Core ----------------------------- */

/**
 * Normalize a domain artifact into a StepGraph.
 * This function handles common patterns but is intentionally conservative:
 * - Domain engines should still curate their artifact shapes.
 * - This provides reasonable defaults for "steps", "nodes", or "tasks".
 *
 * @param {string} domain
 * @param {Object} artifact
 * @returns {StepGraph}
 */
function normalizeArtifactToStepGraph(domain, artifact) {
  const nodes = normalizeNodes(domain, artifact);
  const edges = normalizeEdges(nodes, artifact);
  const timers = normalizeTimers(nodes, artifact);
  const inventory = normalizeInventory(artifact);
  const metadata = normalizeMetadata(artifact, domain);

  return {
    version: STEP_GRAPH_VERSION,
    domain,
    nodes,
    edges,
    timers,
    inventory,
    metadata,
  };
}

/**
 * Normalize artifact steps/tasks into StepNode objects.
 *
 * Expected shapes (examples):
 * - artifact.steps: [{ id, label, duration, ingredients, equipment, ... }]
 * - artifact.nodes: same as above
 * - artifact.tasks: same as above
 *
 * @param {string} domain
 * @param {Object} artifact
 * @returns {StepNode[]}
 */
function normalizeNodes(domain, artifact) {
  const rawSteps =
    Array.isArray(artifact.steps) && artifact.steps.length
      ? artifact.steps
      : Array.isArray(artifact.nodes) && artifact.nodes.length
      ? artifact.nodes
      : Array.isArray(artifact.tasks) && artifact.tasks.length
      ? artifact.tasks
      : [];

  return rawSteps.map((step, index) => {
    const id = String(step.id || `step-${index + 1}`);
    const label =
      step.label ||
      step.name ||
      step.title ||
      (typeof step.description === "string"
        ? truncate(step.description, 80)
        : `Step ${index + 1}`);

    const duration = normalizeDuration(
      step.duration ||
        step.time ||
        step.estimatedDuration ||
        step.timerDuration ||
        null
    );

    const ingredients = normalizeLineItems(
      step.ingredients || [],
      "ingredient"
    );
    const materials = normalizeLineItems(
      step.materials || step.supplies || [],
      "material"
    );
    const equipment = normalizeEquipment(step.equipment || step.tools || []);

    /** @type {StepNodeBehavior} */
    const behavior = {
      isBlocking: typeof step.isBlocking === "boolean" ? step.isBlocking : true,
      canParallel:
        typeof step.canParallel === "boolean" ? step.canParallel : false,
      phase: step.phase || step.stage || inferPhaseFromDomain(domain, step),
    };

    return {
      id,
      domain,
      kind: step.kind || inferKindFromDomain(domain, step),
      label,
      description: step.description || "",
      duration,
      ingredients,
      materials,
      equipment,
      behavior,
      metadata: {
        temperature: step.temperature || step.temp || null,
        location: step.location || step.station || null,
        safety: step.safety || null,
        raw: step, // keep raw reference for debugging/introspection
      },
    };
  });
}

/**
 * Normalize edges. Prefer explicit artifact.edges; otherwise build
 * a simple sequential chain (step-1 → step-2 → step-3, etc.).
 *
 * @param {StepNode[]} nodes
 * @param {Object} artifact
 * @returns {StepEdge[]}
 */
function normalizeEdges(nodes, artifact) {
  const edges = [];

  if (Array.isArray(artifact.edges) && artifact.edges.length) {
    for (const edge of artifact.edges) {
      if (!edge) continue;
      if (!edge.from || !edge.to) continue;

      edges.push({
        from: String(edge.from),
        to: String(edge.to),
        kind: edge.kind || "dependency",
        metadata: edge.metadata || {},
      });
    }
    return edges;
  }

  // Fallback: sequential chain.
  for (let i = 0; i < nodes.length - 1; i++) {
    const from = nodes[i].id;
    const to = nodes[i + 1].id;
    edges.push({
      from,
      to,
      kind: "sequential",
      metadata: {},
    });
  }

  return edges;
}

/**
 * Normalize timers. Timers can come from:
 * - artifact.timers (explicit domain timers)
 * - any node with a duration (auto-generated implicit timers)
 *
 * @param {StepNode[]} nodes
 * @param {Object} artifact
 * @returns {StepTimer[]}
 */
function normalizeTimers(nodes, artifact) {
  const timers = [];
  const seenIds = new Set();

  // 1) Explicit timers on artifact
  if (Array.isArray(artifact.timers)) {
    for (const t of artifact.timers) {
      if (!t) continue;
      const duration = normalizeDuration(t.duration || t.time || t.length);
      if (!duration) continue;

      const id = String(t.id || `timer-${timers.length + 1}`);

      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const nodeIds = Array.isArray(t.nodeIds)
        ? t.nodeIds.map(String)
        : typeof t.nodeId === "string"
        ? [t.nodeId]
        : [];

      timers.push({
        id,
        label: t.label || t.name || `Timer ${timers.length + 1}`,
        duration,
        nodeIds,
        kind: t.kind || "countdown",
        metadata: t.metadata || {},
      });
    }
  }

  // 2) Implicit timers from node durations
  for (const node of nodes) {
    if (!node.duration || node.duration.seconds <= 0) continue;

    const id = `timer-node-${node.id}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    timers.push({
      id,
      label: node.label,
      duration: node.duration,
      nodeIds: [node.id],
      kind: "countdown",
      metadata: { inferredFromNode: true },
    });
  }

  return timers;
}

/**
 * Normalize inventory effects from artifact-level information.
 *
 * Expected shapes (examples):
 * - artifact.inventory.consumes / artifact.inventory.produces
 * - artifact.consumes / artifact.produces
 *
 * @param {Object} artifact
 * @returns {StepGraphInventory}
 */
function normalizeInventory(artifact) {
  const inv = artifact.inventory || {};

  const rawConsumes =
    Array.isArray(inv.consumes) && inv.consumes.length
      ? inv.consumes
      : Array.isArray(artifact.consumes)
      ? artifact.consumes
      : [];

  const rawProduces =
    Array.isArray(inv.produces) && inv.produces.length
      ? inv.produces
      : Array.isArray(artifact.produces)
      ? artifact.produces
      : [];

  return {
    consumes: normalizeInventoryItems(rawConsumes),
    produces: normalizeInventoryItems(rawProduces),
  };
}

/**
 * Normalize metadata for the graph.
 *
 * @param {Object} artifact
 * @param {string} domain
 * @returns {StepGraphMetadata}
 */
function normalizeMetadata(artifact, domain) {
  const now = new Date().toISOString();

  return {
    artifactId: artifact.id || artifact.artifactId || null,
    title: artifact.title || artifact.name || artifact.label || null,
    source: artifact.source || "domain.artifact",
    createdAt: artifact.createdAt || artifact.created_at || now,
    updatedAt: artifact.updatedAt || artifact.updated_at || now,
    tags: artifact.tags || {},
    extra: {
      domain,
      origin: artifact.origin || null,
      // Keep a shallow snapshot of the artifact header for debugging.
      header: {
        id: artifact.id || null,
        type: artifact.type || null,
        variant: artifact.variant || null,
      },
    },
  };
}

/* ------------------------------ Helper Functions ----------------------------- */

/**
 * Normalize various duration shapes into { seconds }.
 * Accepts:
 * - number (interpreted as seconds by default; or millis if > 100000)
 * - { seconds }, { minutes }, { hours }
 * - ISO-like strings "PT5M", "PT1H30M"
 *
 * @param {any} value
 * @returns {Duration|null}
 */
function normalizeDuration(value) {
  if (value == null) return null;

  // numeric: assume seconds (unless clearly milliseconds)
  if (typeof value === "number" && !Number.isNaN(value)) {
    const seconds =
      value > 100000 ? Math.round(value / 1000) : Math.round(value);
    if (seconds <= 0) return null;
    return { seconds };
  }

  if (typeof value === "object") {
    const seconds =
      (value.seconds || value.sec || 0) +
      60 * (value.minutes || value.min || 0) +
      3600 * (value.hours || value.hr || 0);

    if (seconds <= 0) return null;
    return { seconds };
  }

  if (typeof value === "string") {
    const parsed = parseISODuration(value);
    if (parsed && parsed.seconds > 0) return parsed;
  }

  return null;
}

/**
 * Parse very simple ISO-like durations such as "PT5M", "PT1H30M".
 *
 * @param {string} str
 * @returns {Duration|null}
 */
function parseISODuration(str) {
  if (!str || typeof str !== "string") return null;
  if (!/^P(T.*)?/.test(str.toUpperCase())) return null;

  const match = str.toUpperCase().match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;

  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);

  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  if (totalSeconds <= 0) return null;

  return { seconds: totalSeconds };
}

/**
 * Normalize ingredient/material-like items.
 *
 * @param {any[]} items
 * @param {"ingredient"|"material"} kind
 * @returns {(IngredientLike|MaterialLike)[]}
 */
function normalizeLineItems(items, kind) {
  const result = [];
  if (!Array.isArray(items)) return result;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item) continue;

    const id = String(item.id || `${kind}-${index + 1}`);
    const name = item.name || item.label || item.title;
    if (!name) continue;

    result.push({
      id,
      name,
      quantity:
        typeof item.quantity === "number"
          ? item.quantity
          : typeof item.qty === "number"
          ? item.qty
          : null,
      unit: item.unit || item.uom || null,
      metadata: item.metadata || { raw: item },
    });
  }

  return result;
}

/**
 * Normalize equipment/tools.
 *
 * @param {any[]} items
 * @returns {EquipmentLike[]}
 */
function normalizeEquipment(items) {
  const result = [];
  if (!Array.isArray(items)) return result;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item) continue;

    const id = String(item.id || `equipment-${index + 1}`);
    const name = item.name || item.label || item.title;
    if (!name) continue;

    result.push({
      id,
      name,
      metadata: item.metadata || { raw: item },
    });
  }

  return result;
}

/**
 * Normalize inventory items.
 *
 * @param {any[]} items
 * @returns {InventoryDeltaItem[]}
 */
function normalizeInventoryItems(items) {
  const result = [];
  if (!Array.isArray(items)) return result;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item) continue;

    const id = String(item.id || `inv-${index + 1}`);
    const name = item.name || item.label || item.title;
    if (!name) continue;

    const quantity = typeof item.quantity === "number" ? item.quantity : 0;
    if (!Number.isFinite(quantity)) continue;

    result.push({
      id,
      name,
      quantity,
      unit: item.unit || item.uom || null,
      metadata: item.metadata || { raw: item },
    });
  }

  return result;
}

/**
 * Infer a generic kind for a step when the domain didn't provide one.
 *
 * @param {string} domain
 * @param {Object} step
 * @returns {string}
 */
function inferKindFromDomain(domain, step) {
  const lowerDesc = (
    step.description ||
    step.label ||
    step.name ||
    ""
  ).toLowerCase();

  if (/preheat|prep|chop|mix|marinat/.test(lowerDesc)) return "prep";
  if (/bake|cook|roast|fry|saute|boil/.test(lowerDesc)) return "action";
  if (/rest|wait|proof|rise|soak|ferment/.test(lowerDesc)) return "wait";
  if (/clean|wash|sanitize|wipe/.test(lowerDesc)) return "action";
  if (/plant|sow|water|harvest|weed/.test(lowerDesc)) return "action";

  // Domain-specific fallbacks
  switch (domain) {
    case "cooking":
      return "action";
    case "cleaning":
      return "action";
    case "garden":
      return "action";
    case "animals":
      return "action";
    case "preservation":
      return "action";
    case "storehouse":
      return "action";
    default:
      return "action";
  }
}

/**
 * Infer a generic phase based on domain and step.
 *
 * @param {string} domain
 * @param {Object} step
 * @returns {string}
 */
function inferPhaseFromDomain(domain, step) {
  const lowerDesc = (
    step.description ||
    step.label ||
    step.name ||
    ""
  ).toLowerCase();

  if (/prep|chop|measure|preheat|setup|set up/.test(lowerDesc)) return "prep";
  if (/cook|bake|roast|fry|boil|simmer/.test(lowerDesc)) return "execution";
  if (/clean|wash|wipe|sanitize|put away|store/.test(lowerDesc))
    return "cleanup";
  if (/harvest|plant|weed|mulch|water/.test(lowerDesc)) return "fieldwork";
  if (/slaughter|butcher|cut|package/.test(lowerDesc)) return "processing";
  if (/can|jar|seal|smoke|cure|freeze|dehydrate|ferment/.test(lowerDesc))
    return "preservation";

  switch (domain) {
    case "cooking":
      return "execution";
    case "cleaning":
      return "execution";
    case "garden":
      return "fieldwork";
    case "animals":
      return "processing";
    case "preservation":
      return "preservation";
    case "storehouse":
      return "execution";
    default:
      return "execution";
  }
}

/**
 * Truncate a string to a given length with ellipsis.
 *
 * @param {string} str
 * @param {number} maxLength
 * @returns {string}
 */
function truncate(str, maxLength) {
  if (typeof str !== "string") return "";
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 1)}…`;
}

/* ---------------------------- Validation & Events ---------------------------- */

/**
 * Validate a StepGraph structure.
 *
 * @param {any} graph
 * @returns {boolean}
 */
export function isValidStepGraph(graph) {
  if (!graph || typeof graph !== "object") return false;
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) return false;
  if (!Array.isArray(graph.edges)) return false;
  if (!Array.isArray(graph.timers)) return false;

  const ids = new Set(graph.nodes.map((n) => n.id));

  // Basic node sanity
  for (const node of graph.nodes) {
    if (!node || typeof node !== "object") return false;
    if (!node.id || !node.label) return false;
  }

  // All edges must reference valid nodes
  for (const edge of graph.edges) {
    if (!edge || !edge.from || !edge.to) return false;
    if (!ids.has(edge.from) || !ids.has(edge.to)) return false;
  }

  // Timers must have positive durations
  for (const timer of graph.timers) {
    if (!timer || !timer.duration || typeof timer.duration.seconds !== "number")
      return false;
    if (timer.duration.seconds <= 0) return false;
  }

  return true;
}

/**
 * Emit an invalid graph event for observability.
 *
 * @param {string} reason
 * @param {Object} context
 */
function reportInvalid(reason, context) {
  const ts = new Date().toISOString();

  if (typeof console !== "undefined") {
    console.warn("[StepGraphContract] Invalid StepGraph:", reason, context);
  }

  safeEmit({
    type: "session.stepGraph.invalid",
    ts,
    source: "services.sessions.StepGraphContract",
    data: {
      reason,
      context,
    },
  });
}

/* ------------------------------- Introspection ------------------------------- */

/**
 * Provide a compact summary of an artifact for logging/events.
 *
 * @param {any} artifact
 * @returns {Object}
 */
function summarizeArtifact(artifact) {
  if (!artifact || typeof artifact !== "object")
    return { type: typeof artifact };
  return {
    id: artifact.id || artifact.artifactId || null,
    type: artifact.type || null,
    title: artifact.title || artifact.name || artifact.label || null,
    hasSteps: Array.isArray(artifact.steps),
    hasNodes: Array.isArray(artifact.nodes),
    hasTasks: Array.isArray(artifact.tasks),
  };
}

/**
 * Provide a compact summary of a graph for logging/events.
 *
 * @param {any} graph
 * @returns {Object}
 */
function summarizeGraph(graph) {
  if (!graph || typeof graph !== "object") return { type: typeof graph };
  return {
    domain: graph.domain || null,
    version: graph.version || null,
    nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
    edgeCount: Array.isArray(graph.edges) ? graph.edges.length : 0,
    timerCount: Array.isArray(graph.timers) ? graph.timers.length : 0,
  };
}
