// src/domain/cleaning/CleaningArtifactAdapter.js
//
// CleaningArtifactAdapter
// ------------------------
// Cleaning: Routine → artifact → StepGraph
//
// Pipeline role:
//   imports/UI → normalizeCleaningInput → (artifact)
//   → buildCleaningStepGraph (StepGraph) → VaultSavePipeline
//   → Compliance (DomainClassifier + ComplianceEngine)
//   → SessionEngine / SessionRunner → (optional) Hub export
//
// This file is *domain-specific* for CLEANING but uses shared SSA contracts:
//   - StepGraphContract for a session-ready graph (unified for all domains).
//   - eventBus for observability.
//
// It does NOT persist anything and does NOT export to the Hub directly.
//
// Normalized artifact shape (simplified):
//   {
//     id,
//     domain: "cleaning",
//     type: "routine",
//     title,
//     description,
//     notes,
//     area: "kitchen" | "bathroom" | ...,
//     frequency: "daily" | "weekly" | "monthly" | custom string,
//     tasks: [
//       {
//         id,
//         label,
//         description,
//         duration,              // seconds | { minutes, seconds } | "PT5M"
//         materials: [{ id, name, quantity, unit, notes }],
//         equipment: [{ id, name }],
//         tags: { ... }
//       },
//     ],
//     consumes: [ { id, name, quantity, unit, metadata } ],
//     produces: [],            // e.g. "clean kitchen", etc. (future use)
//     tags: { ... },
//     metadata: { source, uiVersion, ... },
//     sessionMeta: { stepGraphReady: false, compliance: null },
//   }

import { emitEvent } from "../../services/events/eventBus";
import { toStepGraph } from "../../services/session/StepGraphContract";

const MODULE_SOURCE = "domain.cleaning.CleaningArtifactAdapter";

/* --------------------------------- Typedefs ---------------------------------- */
/**
 * @typedef {Object} CleaningMaterialInput
 * @property {string} name
 * @property {number} [quantity]
 * @property {string} [unit]
 * @property {string} [notes]
 */

/**
 * @typedef {Object} CleaningTaskInput
 * @property {string} [id]
 * @property {string} [label]
 * @property {string} [description]
 * @property {number|Object|string} [duration]  // seconds, { minutes }, or "PT5M"
 * @property {CleaningMaterialInput[]} [materials]
 * @property {Array<{ name: string }|string>} [equipment]
 * @property {Object} [tags]
 */

/**
 * @typedef {Object} CleaningRawInput
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [notes]
 * @property {string} [area]        // e.g., "kitchen", "bathroom", "whole-house"
 * @property {string} [frequency]   // e.g., "daily", "weekly", cron-like, etc.
 * @property {CleaningTaskInput[]} [tasks]
 * @property {string[]} [tasksText] // simple text-only tasks, one per line
 * @property {CleaningMaterialInput[]} [materials]       // global materials
 * @property {string[]} [materialsLines]                 // "2 tbsp bleach"
 * @property {Object} [metadata]
 */

/* ----------------------------- Public: Normalize ----------------------------- */

/**
 * Normalize raw Cleaning UI input into a canonical "artifact" that:
 *   - is domain-aware ("cleaning"),
 *   - has structured tasks, materials, and equipment,
 *   - has sessionMeta scaffolded for StepGraph + compliance,
 *   - is safe to pass to StepGraphContract.toStepGraph("cleaning", artifact).
 *
 * @param {CleaningRawInput|any} rawInput
 * @returns {Object} artifact
 */
export function normalizeCleaningInput(rawInput) {
  const ts = new Date().toISOString();
  const safe = rawInput && typeof rawInput === "object" ? rawInput : {};

  const artifactId =
    typeof safe.id === "string" && safe.id.trim()
      ? safe.id.trim()
      : `cleaning:routine:${Date.now()}`;

  const title =
    (typeof safe.title === "string" && safe.title.trim()) ||
    (typeof safe.name === "string" && safe.name.trim()) ||
    "Untitled Cleaning Routine";

  const description =
    (typeof safe.description === "string" && safe.description.trim()) ||
    (typeof safe.notes === "string" && safe.notes.trim()) ||
    "";

  const area =
    (typeof safe.area === "string" && safe.area.trim()) || "unspecified";

  const frequency =
    (typeof safe.frequency === "string" && safe.frequency.trim()) ||
    "unscheduled";

  const globalMaterials = normalizeMaterials(
    safe.materials,
    safe.materialsLines
  );

  const tasks = normalizeTasks(safe.tasks, safe.tasksText, globalMaterials);

  /** @type {Object} */
  const artifact = {
    id: artifactId,
    domain: "cleaning",
    type: "routine",
    title,
    description,
    notes: typeof safe.notes === "string" ? safe.notes : "",
    area,
    frequency,
    createdAt: safe.createdAt || ts,
    updatedAt: ts,
    tasks,
    // Optional: global materials list (for UI / analytics)
    materials: globalMaterials,
    // Inventory interaction in "consumes" array.
    consumes: buildConsumesFromMaterials(globalMaterials),
    produces: safe.produces || [],
    tags: normalizeTags(safe.metadata?.tags),
    metadata: {
      ...safe.metadata,
      uiVersion: safe.metadata?.uiVersion || "1.0.0",
      source: safe.metadata?.source || "ui.cleaning",
    },
    // Will be updated by VaultSavePipeline / ComplianceEngine / SessionEngine
    sessionMeta: {
      stepGraphReady: false,
      compliance: null,
    },
  };

  emitSafe({
    type: "cleaning.routine.normalized",
    ts,
    source: MODULE_SOURCE,
    data: {
      artifactId,
      title,
      area,
      frequency,
      taskCount: tasks.length,
      materialCount: globalMaterials.length,
    },
  });

  return artifact;
}

/* ----------------------------- Public: StepGraph ----------------------------- */

/**
 * Build a StepGraph for the given cleaning artifact.
 * Thin wrapper around StepGraphContract.toStepGraph("cleaning", artifact),
 * with validation + event emission.
 *
 * @param {Object} artifact - result of normalizeCleaningInput
 * @returns {Object|null} StepGraph or null on failure
 */
export function buildCleaningStepGraph(artifact) {
  const ts = new Date().toISOString();

  if (!artifact || typeof artifact !== "object") {
    emitSafe({
      type: "cleaning.stepGraph.failed",
      ts,
      source: MODULE_SOURCE,
      data: {
        reason: "Invalid artifact",
      },
    });
    return null;
  }

  const graph = toStepGraph("cleaning", artifact);

  if (!graph) {
    emitSafe({
      type: "cleaning.stepGraph.failed",
      ts,
      source: MODULE_SOURCE,
      data: {
        artifactId: artifact.id || null,
        title: artifact.title || null,
        reason: "toStepGraph returned null",
      },
    });
    return null;
  }

  emitSafe({
    type: "cleaning.stepGraph.built",
    ts,
    source: MODULE_SOURCE,
    data: {
      artifactId: artifact.id || null,
      title: artifact.title || null,
      nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
      edgeCount: Array.isArray(graph.edges) ? graph.edges.length : 0,
      timerCount: Array.isArray(graph.timers) ? graph.timers.length : 0,
    },
  });

  return graph;
}

/* --------------------------- Material Normalization -------------------------- */

/**
 * Normalize cleaning materials coming from either:
 *   - structured `materials` array
 *   - simple `materialsLines` array of strings ("2 tbsp bleach")
 *
 * @param {any[]} maybeStructured
 * @param {string[]|undefined} maybeLines
 * @returns {CleaningMaterialInput[]}
 */
function normalizeMaterials(maybeStructured, maybeLines) {
  if (Array.isArray(maybeStructured) && maybeStructured.length > 0) {
    return maybeStructured
      .map((mat, index) => {
        if (!mat || typeof mat !== "object") return null;

        const name =
          (typeof mat.name === "string" && mat.name.trim()) ||
          (typeof mat.label === "string" && mat.label.trim()) ||
          "";
        if (!name) return null;

        const quantity =
          typeof mat.quantity === "number"
            ? mat.quantity
            : typeof mat.qty === "number"
            ? mat.qty
            : null;

        const unit =
          (typeof mat.unit === "string" && mat.unit.trim()) ||
          (typeof mat.uom === "string" && mat.uom.trim()) ||
          null;

        return {
          id: mat.id || `material-${index + 1}`,
          name,
          quantity,
          unit,
          notes: typeof mat.notes === "string" ? mat.notes : "",
        };
      })
      .filter(Boolean);
  }

  if (Array.isArray(maybeLines) && maybeLines.length > 0) {
    return maybeLines
      .map((line, index) => {
        if (typeof line !== "string") return null;
        const trimmed = line.trim();
        if (!trimmed) return null;

        const parsed = parseLooseMaterialLine(trimmed);

        return {
          id: `material-${index + 1}`,
          name: parsed.name,
          quantity: parsed.quantity,
          unit: parsed.unit,
          notes: "",
        };
      })
      .filter(Boolean);
  }

  return [];
}

/**
 * Very simple material line parser.
 * Attempts to parse things like:
 *   "2 capfuls bleach"  → { quantity: 2, unit: "capfuls", name: "bleach" }
 *   "1 bottle vinegar"  → { quantity: 1, unit: "bottle", name: "vinegar" }
 *   "bleach"            → { quantity: null, unit: null, name: "bleach" }
 *
 * @param {string} line
 * @returns {{ quantity: number|null, unit: string|null, name: string }}
 */
function parseLooseMaterialLine(line) {
  const parts = line.split(/\s+/);
  if (parts.length === 0) {
    return { quantity: null, unit: null, name: "" };
  }

  const maybeQty = parseFloat(parts[0].replace(",", "."));
  if (!Number.isNaN(maybeQty)) {
    if (parts.length === 1) {
      return { quantity: maybeQty, unit: null, name: "" };
    }
    const unit = parts[1];
    const name = parts.slice(2).join(" ").trim();
    return { quantity: maybeQty, unit: unit || null, name: name || line };
  }

  // no numeric quantity at start → treat entire line as name
  return { quantity: null, unit: null, name: line };
}

/* ------------------------------ Task Normalization --------------------------- */

/**
 * Normalize tasks coming from:
 *   - `tasks` array with objects
 *   - `tasksText` array of strings
 *
 * The shape we want aligns with StepGraphContract expectations:
 *   artifact.tasks = [
 *     {
 *       id, label, description, duration,
 *       materials: [...],
 *       equipment: [...],
 *       tags: { ... }
 *     }
 *   ]
 *
 * @param {any[]} maybeTasks
 * @param {string[]|undefined} maybeTasksText
 * @param {CleaningMaterialInput[]} globalMaterials
 * @returns {CleaningTaskInput[]}
 */
function normalizeTasks(maybeTasks, maybeTasksText, globalMaterials) {
  if (Array.isArray(maybeTasks) && maybeTasks.length > 0) {
    return maybeTasks
      .map((task, index) => {
        if (!task || typeof task !== "object") return null;

        const label =
          (typeof task.label === "string" && task.label.trim()) ||
          (typeof task.title === "string" && task.title.trim()) ||
          `Task ${index + 1}`;

        const description =
          (typeof task.description === "string" && task.description.trim()) ||
          "";

        return {
          id: task.id || `task-${index + 1}`,
          label,
          description,
          duration:
            task.duration || task.time || task.estimatedDuration || null,
          materials: normalizeTaskMaterials(task.materials, globalMaterials),
          equipment: normalizeTaskEquipment(task.equipment),
          tags: normalizeTags(task.tags),
        };
      })
      .filter(Boolean);
  }

  if (Array.isArray(maybeTasksText) && maybeTasksText.length > 0) {
    return maybeTasksText
      .map((text, index) => {
        if (typeof text !== "string") return null;
        const desc = text.trim();
        if (!desc) return null;

        return {
          id: `task-${index + 1}`,
          label: `Task ${index + 1}`,
          description: desc,
          duration: null,
          materials: [],
          equipment: [],
          tags: {},
        };
      })
      .filter(Boolean);
  }

  return [];
}

/**
 * Map any per-task material references to a normalized array of minimal
 * material objects compatible with StepGraphContract expectations.
 *
 * @param {any[]} taskMaterials
 * @param {CleaningMaterialInput[]} globalMaterials
 * @returns {CleaningMaterialInput[]}
 */
function normalizeTaskMaterials(taskMaterials, globalMaterials) {
  if (!Array.isArray(taskMaterials) || taskMaterials.length === 0) return [];

  const results = [];

  for (const item of taskMaterials) {
    if (!item) continue;

    // direct reference to material ID or name
    if (typeof item === "string") {
      const id = item.trim();
      if (!id) continue;

      const found = globalMaterials.find(
        (mat) => mat.id === id || mat.name === id
      );
      if (found) {
        results.push(found);
      } else {
        results.push({
          id: `task-mat-${id}`,
          name: id,
          quantity: null,
          unit: null,
          notes: "",
        });
      }
      continue;
    }

    if (typeof item === "object") {
      const name =
        (typeof item.name === "string" && item.name.trim()) ||
        (typeof item.label === "string" && item.label.trim()) ||
        "";
      if (!name) continue;

      const quantity =
        typeof item.quantity === "number"
          ? item.quantity
          : typeof item.qty === "number"
          ? item.qty
          : null;
      const unit =
        (typeof item.unit === "string" && item.unit.trim()) ||
        (typeof item.uom === "string" && item.uom.trim()) ||
        null;

      results.push({
        id: item.id || `task-mat-${name}`,
        name,
        quantity,
        unit,
        notes: typeof item.notes === "string" ? item.notes : "",
      });
    }
  }

  return results;
}

/**
 * Normalize per-task equipment:
 *   equipment: ["mop", "bucket"] or [{ name: "Vacuum" }, ...]
 *
 * @param {any[]} equipment
 * @returns {Array<{ id: string, name: string }>}
 */
function normalizeTaskEquipment(equipment) {
  if (!Array.isArray(equipment) || equipment.length === 0) return [];

  const results = [];

  for (let i = 0; i < equipment.length; i += 1) {
    const item = equipment[i];
    if (!item) continue;

    if (typeof item === "string") {
      const name = item.trim();
      if (!name) continue;
      results.push({ id: `equipment-${i + 1}`, name });
      continue;
    }

    if (typeof item === "object") {
      const name =
        (typeof item.name === "string" && item.name.trim()) ||
        (typeof item.label === "string" && item.label.trim()) ||
        "";
      if (!name) continue;
      results.push({
        id: item.id || `equipment-${i + 1}`,
        name,
      });
    }
  }

  return results;
}

/* --------------------------- Inventory Consumes Map -------------------------- */

/**
 * Build a simple "consumes" array from materials, suitable for
 * StepGraphContract / Vault to later map into inventory/storehouse.
 *
 * @param {CleaningMaterialInput[]} materials
 * @returns {Array<{ id: string, name: string, quantity: number, unit: string|null, metadata: any }>}
 */
function buildConsumesFromMaterials(materials) {
  if (!Array.isArray(materials)) return [];

  return materials
    .map((mat, index) => {
      if (!mat || typeof mat !== "object") return null;
      const name = typeof mat.name === "string" ? mat.name.trim() : "";
      if (!name) return null;

      const quantity = typeof mat.quantity === "number" ? mat.quantity : 0;
      const unit = typeof mat.unit === "string" ? mat.unit : null;

      return {
        id: mat.id || `consumes-${index + 1}`,
        name,
        quantity,
        unit,
        metadata: { from: "materials" },
      };
    })
    .filter(Boolean);
}

/* --------------------------------- Tags -------------------------------------- */

/**
 * Normalize tags into a flat object.
 *
 * @param {any} rawTags
 * @returns {Object}
 */
function normalizeTags(rawTags) {
  if (!rawTags || typeof rawTags !== "object") return {};
  return { ...rawTags };
}

/* --------------------------------- Events ----------------------------------- */

/**
 * Safe wrapper for eventBus emit.
 *
 * @param {{ type: string, ts: string, source: string, data: any }} payload
 */
function emitSafe(payload) {
  if (typeof emitEvent !== "function") return;

  try {
    emitEvent(payload);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[CleaningArtifactAdapter] Failed to emit event", err);
    }
  }
}
