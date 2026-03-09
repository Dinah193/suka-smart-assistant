// src/domain/garden/GardenArtifactAdapter.js
//
// GardenArtifactAdapter
// ---------------------
// Garden: Plan → artifact → StepGraph
//
// Pipeline role:
//   imports/UI → normalizeGardenInput → (artifact)
//   → buildGardenStepGraph (StepGraph) → VaultSavePipeline
//   → Compliance (DomainClassifier + ComplianceEngine)
//   → GardenSessionEngine / SessionRunner → (optional) Hub export
//
// This file is *domain-specific* for GARDEN but uses shared SSA contracts:
//   - StepGraphContract for a session-ready graph (unified for all domains).
//   - eventBus for observability.
//
// It does NOT persist anything and does NOT export to the Hub directly.
// Saving + Hub export are handled by VaultSavePipeline and SessionEngines.
//
// Normalized artifact (simplified):
//   {
//     id,
//     domain: "garden",
//     type: "plan",
//     title,
//     description,
//     notes,
//     location,
//     zone,
//     seasons: ["spring", "summer", ...],
//     beds: [ { id, name, areaSqFt, notes } ],
//     plantings: [
//       {
//         id,
//         cropName,
//         variety,
//         bedId,
//         row,
//         position,
//         startDate,
//         endDate,
//         daysToMaturity,
//         successionGroup,
//         expectedYield,
//         seedSource
//       },
//     ],
//     tasks: [
//       {
//         id,
//         label,
//         description,
//         type, // "sow" | "transplant" | "water" | "weed" | "harvest" | ...
//         duration,
//         targetBedIds: [...],
//         targetPlantingIds: [...],
//         dueDate,
//         windowStart,
//         windowEnd,
//         materials: [{ id, name, quantity, unit, notes }],
//         equipment: [{ id, name }],
//         tags: { ... },
//       },
//     ],
//     consumes: [ ... ], // seeds & amendments (used later to link to inventory)
//     produces: [ ... ], // planned harvests (for storehouse projection)
//     tags: { ... },
//     metadata: { ... },
//     sessionMeta: { stepGraphReady: false, compliance: null },
//   }

import { emitEvent } from "../../services/events/eventBus";
import { toStepGraph } from "../../services/session/StepGraphContract";

const MODULE_SOURCE = "domain.garden.GardenArtifactAdapter";

/* --------------------------------- Typedefs ---------------------------------- */
/**
 * @typedef {Object} GardenBedInput
 * @property {string} [id]
 * @property {string} [name]
 * @property {number} [areaSqFt]
 * @property {string} [notes]
 */

/**
 * @typedef {Object} GardenPlantingInput
 * @property {string} [id]
 * @property {string} [cropName]
 * @property {string} [variety]
 * @property {string} [bedId]
 * @property {string|number} [row]
 * @property {string|number} [position]
 * @property {string|Date} [startDate]
 * @property {string|Date} [endDate]
 * @property {number} [daysToMaturity]
 * @property {string} [successionGroup]
 * @property {string|number} [expectedYield]
 * @property {string} [seedSource]
 */

/**
 * @typedef {Object} GardenMaterialInput
 * @property {string} name
 * @property {number} [quantity]
 * @property {string} [unit]
 * @property {string} [notes]
 */

/**
 * @typedef {Object} GardenTaskInput
 * @property {string} [id]
 * @property {string} [label]
 * @property {string} [description]
 * @property {string} [type]
 * @property {number|Object|string} [duration]
 * @property {string[]|GardenBedInput[]} [targetBeds]
 * @property {string[]|GardenPlantingInput[]} [targetPlantings]
 * @property {string|Date} [dueDate]
 * @property {string|Date} [windowStart]
 * @property {string|Date} [windowEnd]
 * @property {GardenMaterialInput[]} [materials]
 * @property {Array<{ name: string }|string>} [equipment]
 * @property {Object} [tags]
 */

/**
 * @typedef {Object} GardenRawInput
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [notes]
 * @property {string} [location]
 * @property {string} [zone]       // e.g. USDA zone or climate zone
 * @property {string[]|string} [seasons]
 * @property {GardenBedInput[]} [beds]
 * @property {GardenPlantingInput[]} [plantings]
 * @property {GardenTaskInput[]} [tasks]
 * @property {string[]} [tasksText] // basic text tasks
 * @property {GardenMaterialInput[]} [materials]
 * @property {string[]} [materialsLines]
 * @property {Object} [metadata]
 */

/* ----------------------------- Public: Normalize ----------------------------- */

/**
 * Normalize raw Garden UI input into a canonical "artifact" that:
 *   - is domain-aware ("garden"),
 *   - has structured beds, plantings, and tasks,
 *   - has sessionMeta scaffolded for StepGraph + compliance,
 *   - is safe to pass to StepGraphContract.toStepGraph("garden", artifact).
 *
 * @param {GardenRawInput|any} rawInput
 * @returns {Object} artifact
 */
export function normalizeGardenInput(rawInput) {
  const ts = new Date().toISOString();
  const safe = rawInput && typeof rawInput === "object" ? rawInput : {};

  const artifactId =
    typeof safe.id === "string" && safe.id.trim()
      ? safe.id.trim()
      : `garden:plan:${Date.now()}`;

  const title =
    (typeof safe.title === "string" && safe.title.trim()) ||
    (typeof safe.name === "string" && safe.name.trim()) ||
    "Untitled Garden Plan";

  const description =
    (typeof safe.description === "string" && safe.description.trim()) ||
    (typeof safe.notes === "string" && safe.notes.trim()) ||
    "";

  const location =
    (typeof safe.location === "string" && safe.location.trim()) ||
    "unspecified";

  const zone =
    (typeof safe.zone === "string" && safe.zone.trim()) ||
    (typeof safe.metadata?.climateZone === "string" &&
      safe.metadata.climateZone.trim()) ||
    "unknown";

  const seasons = normalizeSeasons(safe.seasons);

  const beds = normalizeBeds(safe.beds);
  const plantings = normalizePlantings(safe.plantings, beds);
  const globalMaterials = normalizeMaterials(
    safe.materials,
    safe.materialsLines
  );
  const tasks = normalizeGardenTasks(
    safe.tasks,
    safe.tasksText,
    plantings,
    beds,
    globalMaterials
  );

  const consumes = buildConsumesFromPlantingsAndMaterials(
    plantings,
    tasks,
    globalMaterials
  );
  const produces = buildProducesFromPlantings(plantings);

  /** @type {Object} */
  const artifact = {
    id: artifactId,
    domain: "garden",
    type: "plan",
    title,
    description,
    notes: typeof safe.notes === "string" ? safe.notes : "",
    location,
    zone,
    seasons,
    beds,
    plantings,
    tasks,
    // Expose global materials (amendments, sprays, etc.) for Vault/analytics
    materials: globalMaterials,
    consumes,
    produces,
    tags: normalizeTags(safe.metadata?.tags),
    metadata: {
      ...safe.metadata,
      uiVersion: safe.metadata?.uiVersion || "1.0.0",
      source: safe.metadata?.source || "ui.garden",
    },
    sessionMeta: {
      stepGraphReady: false,
      compliance: null,
    },
  };

  emitSafe({
    type: "garden.plan.normalized",
    ts,
    source: MODULE_SOURCE,
    data: {
      artifactId,
      title,
      location,
      zone,
      seasonCount: artifact.seasons.length,
      bedCount: beds.length,
      plantingCount: plantings.length,
      taskCount: tasks.length,
    },
  });

  return artifact;
}

/* ----------------------------- Public: StepGraph ----------------------------- */

/**
 * Build a StepGraph for the given garden artifact.
 * Thin wrapper around StepGraphContract.toStepGraph("garden", artifact),
 * with validation + event emission.
 *
 * @param {Object} artifact - result of normalizeGardenInput
 * @returns {Object|null} StepGraph or null on failure
 */
export function buildGardenStepGraph(artifact) {
  const ts = new Date().toISOString();

  if (!artifact || typeof artifact !== "object") {
    emitSafe({
      type: "garden.stepGraph.failed",
      ts,
      source: MODULE_SOURCE,
      data: {
        reason: "Invalid artifact",
      },
    });
    return null;
  }

  const graph = toStepGraph("garden", artifact);

  if (!graph) {
    emitSafe({
      type: "garden.stepGraph.failed",
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
    type: "garden.stepGraph.built",
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

/* ------------------------------- Seasons ------------------------------------- */

/**
 * Normalize seasons into an array of lower-cased strings:
 *   "Spring, Fall" → ["spring", "fall"]
 *
 * @param {string[]|string|undefined} raw
 * @returns {string[]}
 */
function normalizeSeasons(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,;/]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

/* ------------------------------- Beds ---------------------------------------- */

/**
 * Normalize garden beds into a consistent structure.
 *
 * @param {GardenBedInput[]|any[]} maybeBeds
 * @returns {GardenBedInput[]}
 */
function normalizeBeds(maybeBeds) {
  if (!Array.isArray(maybeBeds) || maybeBeds.length === 0) return [];

  return maybeBeds
    .map((bed, index) => {
      if (!bed || typeof bed !== "object") return null;

      const name =
        (typeof bed.name === "string" && bed.name.trim()) ||
        (typeof bed.label === "string" && bed.label.trim()) ||
        `Bed ${index + 1}`;

      const area =
        typeof bed.areaSqFt === "number"
          ? bed.areaSqFt
          : typeof bed.area === "number"
          ? bed.area
          : null;

      return {
        id: bed.id || `bed-${index + 1}`,
        name,
        areaSqFt: area,
        notes: typeof bed.notes === "string" ? bed.notes : "",
      };
    })
    .filter(Boolean);
}

/* ------------------------------ Plantings ------------------------------------ */

/**
 * Normalize plantings into a consistent structure and ensure references to beds
 * are sane.
 *
 * @param {GardenPlantingInput[]|any[]} maybePlantings
 * @param {GardenBedInput[]} beds
 * @returns {GardenPlantingInput[]}
 */
function normalizePlantings(maybePlantings, beds) {
  if (!Array.isArray(maybePlantings) || maybePlantings.length === 0) return [];

  const bedIds = new Set(beds.map((b) => b.id));

  return maybePlantings
    .map((p, index) => {
      if (!p || typeof p !== "object") return null;

      const cropName =
        (typeof p.cropName === "string" && p.cropName.trim()) ||
        (typeof p.crop === "string" && p.crop.trim()) ||
        "";

      if (!cropName) return null;

      const variety =
        (typeof p.variety === "string" && p.variety.trim()) ||
        (typeof p.cultivar === "string" && p.cultivar.trim()) ||
        "";

      const bedId =
        typeof p.bedId === "string" && p.bedId.trim() ? p.bedId.trim() : null;

      const safeBedId = bedId && bedIds.has(bedId) ? bedId : null;

      return {
        id: p.id || `planting-${index + 1}`,
        cropName,
        variety,
        bedId: safeBedId,
        row: p.row ?? null,
        position: p.position ?? null,
        startDate: normalizeDateOrNull(p.startDate),
        endDate: normalizeDateOrNull(p.endDate),
        daysToMaturity:
          typeof p.daysToMaturity === "number" ? p.daysToMaturity : null,
        successionGroup:
          typeof p.successionGroup === "string" && p.successionGroup.trim()
            ? p.successionGroup.trim()
            : null,
        expectedYield: p.expectedYield ?? null,
        seedSource:
          typeof p.seedSource === "string" && p.seedSource.trim()
            ? p.seedSource.trim()
            : null,
      };
    })
    .filter(Boolean);
}

/* --------------------------- Materials (Global) ------------------------------ */

/**
 * Normalize garden materials (amendments, sprays, etc.) from either:
 *   - structured `materials` array
 *   - simple `materialsLines` ("1 cup bone meal")
 *
 * @param {any[]} maybeStructured
 * @param {string[]|undefined} maybeLines
 * @returns {GardenMaterialInput[]}
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

  return { quantity: null, unit: null, name: line };
}

/* ------------------------------ Tasks ---------------------------------------- */

/**
 * Normalize garden tasks from either:
 *   - structured `tasks` array
 *   - `tasksText` array
 *
 * @param {GardenTaskInput[]|any[]} maybeTasks
 * @param {string[]|undefined} maybeTasksText
 * @param {GardenPlantingInput[]} plantings
 * @param {GardenBedInput[]} beds
 * @param {GardenMaterialInput[]} globalMaterials
 * @returns {GardenTaskInput[]}
 */
function normalizeGardenTasks(
  maybeTasks,
  maybeTasksText,
  plantings,
  beds,
  globalMaterials
) {
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

        const type =
          (typeof task.type === "string" && task.type.trim()) || "unspecified";

        const targets = normalizeTaskTargets(
          task.targetBeds,
          task.targetPlantings,
          beds,
          plantings
        );

        return {
          id: task.id || `task-${index + 1}`,
          label,
          description,
          type,
          duration:
            task.duration || task.time || task.estimatedDuration || null,
          targetBedIds: targets.bedIds,
          targetPlantingIds: targets.plantingIds,
          dueDate: normalizeDateOrNull(task.dueDate),
          windowStart: normalizeDateOrNull(task.windowStart),
          windowEnd: normalizeDateOrNull(task.windowEnd),
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
          type: "unspecified",
          duration: null,
          targetBedIds: [],
          targetPlantingIds: [],
          dueDate: null,
          windowStart: null,
          windowEnd: null,
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
 * Normalize task targets (beds & plantings) into ID arrays.
 *
 * @param {any[]} targetBeds
 * @param {any[]} targetPlantings
 * @param {GardenBedInput[]} beds
 * @param {GardenPlantingInput[]} plantings
 * @returns {{ bedIds: string[], plantingIds: string[] }}
 */
function normalizeTaskTargets(targetBeds, targetPlantings, beds, plantings) {
  const bedIds = new Set();
  const plantingIds = new Set();

  const bedLookupByName = new Map(
    beds.map((b) => [b.name.toLowerCase(), b.id])
  );
  const bedIdsSet = new Set(beds.map((b) => b.id));

  const plantingLookupByName = new Map(
    plantings.map((p) => [p.cropName.toLowerCase(), p.id])
  );
  const plantingIdsSet = new Set(plantings.map((p) => p.id));

  if (Array.isArray(targetBeds)) {
    for (const tb of targetBeds) {
      if (!tb) continue;

      if (typeof tb === "string") {
        const s = tb.trim();
        if (!s) continue;
        if (bedIdsSet.has(s)) {
          bedIds.add(s);
        } else {
          const byName = bedLookupByName.get(s.toLowerCase());
          if (byName) bedIds.add(byName);
        }
      } else if (typeof tb === "object") {
        const id = (typeof tb.id === "string" && tb.id.trim()) || null;
        if (id && bedIdsSet.has(id)) {
          bedIds.add(id);
        } else {
          const name =
            (typeof tb.name === "string" && tb.name.trim()) ||
            (typeof tb.label === "string" && tb.label.trim()) ||
            null;
          if (name) {
            const byName = bedLookupByName.get(name.toLowerCase());
            if (byName) bedIds.add(byName);
          }
        }
      }
    }
  }

  if (Array.isArray(targetPlantings)) {
    for (const tp of targetPlantings) {
      if (!tp) continue;

      if (typeof tp === "string") {
        const s = tp.trim();
        if (!s) continue;
        if (plantingIdsSet.has(s)) {
          plantingIds.add(s);
        } else {
          const byName = plantingLookupByName.get(s.toLowerCase());
          if (byName) plantingIds.add(byName);
        }
      } else if (typeof tp === "object") {
        const id = (typeof tp.id === "string" && tp.id.trim()) || null;
        if (id && plantingIdsSet.has(id)) {
          plantingIds.add(id);
        } else {
          const name =
            (typeof tp.cropName === "string" && tp.cropName.trim()) ||
            (typeof tp.name === "string" && tp.name.trim()) ||
            null;
          if (name) {
            const byName = plantingLookupByName.get(name.toLowerCase());
            if (byName) plantingIds.add(byName);
          }
        }
      }
    }
  }

  return {
    bedIds: Array.from(bedIds),
    plantingIds: Array.from(plantingIds),
  };
}

/**
 * Normalize per-task materials, referencing global materials where possible.
 *
 * @param {any[]} taskMaterials
 * @param {GardenMaterialInput[]} globalMaterials
 * @returns {GardenMaterialInput[]}
 */
function normalizeTaskMaterials(taskMaterials, globalMaterials) {
  if (!Array.isArray(taskMaterials) || taskMaterials.length === 0) return [];

  const results = [];

  for (const item of taskMaterials) {
    if (!item) continue;

    if (typeof item === "string") {
      const idOrName = item.trim();
      if (!idOrName) continue;

      const found =
        globalMaterials.find((m) => m.id === idOrName || m.name === idOrName) ||
        null;
      if (found) {
        results.push(found);
      } else {
        results.push({
          id: `task-mat-${idOrName}`,
          name: idOrName,
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
 *   equipment: ["hoe", "trowel"] or [{ name: "Wheelbarrow" }, ...]
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

/* -------------------------- Consumes & Produces ------------------------------ */

/**
 * Build a "consumes" array from plantings (seeds) and materials (amendments).
 * This is used later to link to inventory/storehouse.
 *
 * @param {GardenPlantingInput[]} plantings
 * @param {GardenTaskInput[]} tasks
 * @param {GardenMaterialInput[]} globalMaterials
 * @returns {Array<{ id: string, name: string, quantity: number, unit: string|null, metadata: any }>}
 */
function buildConsumesFromPlantingsAndMaterials(
  plantings,
  tasks,
  globalMaterials
) {
  const consumes = [];

  // Seeds / starts from plantings
  if (Array.isArray(plantings)) {
    for (let i = 0; i < plantings.length; i += 1) {
      const p = plantings[i];
      if (!p || typeof p !== "object") continue;

      const cropName = typeof p.cropName === "string" ? p.cropName.trim() : "";
      if (!cropName) continue;

      const label = p.variety ? `${cropName} (${p.variety})` : cropName;

      consumes.push({
        id: p.id || `seed-${i + 1}`,
        name: label,
        quantity: 0, // later replaced when user specifies exact seed count/weight
        unit: null,
        metadata: {
          from: "planting",
          cropName: p.cropName,
          variety: p.variety,
          bedId: p.bedId || null,
          daysToMaturity: p.daysToMaturity || null,
        },
      });
    }
  }

  // Global materials
  if (Array.isArray(globalMaterials)) {
    for (let i = 0; i < globalMaterials.length; i += 1) {
      const m = globalMaterials[i];
      if (!m || typeof m !== "object") continue;

      const name = typeof m.name === "string" ? m.name.trim() : "";
      if (!name) continue;

      const quantity = typeof m.quantity === "number" ? m.quantity : 0;
      const unit = typeof m.unit === "string" ? m.unit : null;

      consumes.push({
        id: m.id || `material-consume-${i + 1}`,
        name,
        quantity,
        unit,
        metadata: { from: "materials" },
      });
    }
  }

  // Task-specific materials (for tasks that use extra amendments)
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (!task || !Array.isArray(task.materials)) continue;

      for (const mat of task.materials) {
        if (!mat || typeof mat !== "object") continue;
        const name = typeof mat.name === "string" ? mat.name.trim() : "";
        if (!name) continue;

        const quantity = typeof mat.quantity === "number" ? mat.quantity : 0;
        const unit = typeof mat.unit === "string" ? mat.unit : null;

        consumes.push({
          id: mat.id || `task-material-consume-${name}`,
          name,
          quantity,
          unit,
          metadata: {
            from: "task",
            taskId: task.id,
          },
        });
      }
    }
  }

  return consumes;
}

/**
 * Build "produces" list from plantings: expected harvest items.
 *
 * @param {GardenPlantingInput[]} plantings
 * @returns {Array<{ id: string, name: string, expectedYield: any, metadata: any }>}
 */
function buildProducesFromPlantings(plantings) {
  if (!Array.isArray(plantings) || plantings.length === 0) return [];

  return plantings
    .map((p) => {
      if (!p || typeof p !== "object") return null;
      const cropName = typeof p.cropName === "string" ? p.cropName.trim() : "";
      if (!cropName) return null;

      const label = p.variety ? `${cropName} (${p.variety})` : cropName;

      return {
        id: `produce-${p.id || label}`,
        name: label,
        expectedYield: p.expectedYield ?? null,
        metadata: {
          plantingId: p.id || null,
          bedId: p.bedId || null,
          daysToMaturity: p.daysToMaturity || null,
        },
      };
    })
    .filter(Boolean);
}

/* ------------------------------ Utilities ------------------------------------ */

/**
 * Normalize a date-like value to ISO 8601 string or null.
 *
 * @param {string|Date|null|undefined} value
 * @returns {string|null}
 */
function normalizeDateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    if (Number.isNaN(t)) return null;
    return value.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const dt = new Date(trimmed);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString();
  }
  return null;
}

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
      console.warn("[GardenArtifactAdapter] Failed to emit event", err);
    }
  }
}
