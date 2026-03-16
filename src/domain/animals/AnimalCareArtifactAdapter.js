// src/domain/animals/AnimalCareArtifactAdapter.js
//
// AnimalCareArtifactAdapter
// -------------------------
// Animal Care: Protocol → artifact → StepGraph
//
// Pipeline role:
//   imports/UI → normalizeAnimalCareInput → (artifact)
//   → buildAnimalCareStepGraph (StepGraph) → VaultSavePipeline
//   → Compliance (DomainClassifier + ComplianceEngine)
//   → AnimalSessionEngine / SessionRunner → (optional) Hub export
//
// This file is *domain-specific* for ANIMALS but uses shared SSA contracts:
//   - StepGraphContract for a session-ready graph (unified for all domains).
//   - eventBus for observability.
//
// It does NOT persist anything and does NOT export to the Hub directly.
// Saving + Hub export are handled by VaultSavePipeline and SessionEngines.
//
// Normalized artifact (simplified):
//   {
//     id,
//     domain: "animals",
//     type: "careProtocol",
//     title,
//     description,
//     notes,
//     protocolType: "dailyCare" | "medication" | "butchery" | "breeding" | ...,
//     species: "goat" | "chicken" | "cow" | ...,
//     breed,
//     ageGroup,     // "kid", "adult", "layer", "broiler", etc.
//     purpose,      // "meat", "milk", "eggs", "breeding", etc.
//
//     animals: [ { id, tag, name, group, notes } ],
//
//     procedures: [
//       {
//         id,
//         label,
//         description,
//         kind,          // "check", "dose", "move", "slaughter", etc.
//         duration,
//         materials: [{ id, name, quantity, unit, notes }],
//         equipment: [{ id, name }],
//         targetAnimalIds: [ ... ],
//         preconditions: [ ... ],
//         expectedOutcomes: [ ... ],
//         tags: { ... },
//       },
//     ],
//
//     triggers: [
//       {
//         id,
//         type,          // "time", "symptom", "event"
//         expression,    // "every day at 7:00", "coughing", "after kidding"
//         windowStart,
//         windowEnd,
//       },
//     ],
//
//     schedule: {
//       frequency,      // "daily", "weekly", cron-like, etc.
//       windowStart,
//       windowEnd,
//     },
//
//     materials: [ ... ],  // global drugs/feeds/consumables
//     consumes: [ ... ],   // what this protocol consumes (feeds/drugs/etc.)
//     produces: [ ... ],   // optional outcomes (milk, eggs, carcass, etc.)
//     tags: { ... },
//     metadata: { ... },
//     sessionMeta: { stepGraphReady: false, compliance: null },
//   }

import { emitEvent } from "../../services/events/eventBus";
import { toStepGraph } from "../../services/session/StepGraphContract";

const MODULE_SOURCE = "domain.animals.AnimalCareArtifactAdapter";

/* --------------------------------- Typedefs ---------------------------------- */
/**
 * @typedef {Object} AnimalInput
 * @property {string} [id]
 * @property {string} [tag]
 * @property {string} [name]
 * @property {string} [group] // e.g., "does", "bucks", "kids", "flock A"
 * @property {string} [notes]
 */

/**
 * @typedef {Object} AnimalMaterialInput
 * @property {string} name
 * @property {number} [quantity]
 * @property {string} [unit]
 * @property {string} [notes]
 */

/**
 * @typedef {Object} AnimalProcedureInput
 * @property {string} [id]
 * @property {string} [label]
 * @property {string} [description]
 * @property {string} [kind] // "dose", "check", "move", "slaughter", etc.
 * @property {number|Object|string} [duration]
 * @property {string[]|AnimalInput[]} [targetAnimals]
 * @property {AnimalMaterialInput[]} [materials]
 * @property {Array<{ name: string }|string>} [equipment]
 * @property {string[]|Array<{ description: string }>} [preconditions]
 * @property {string[]|Array<{ description: string }>} [expectedOutcomes]
 * @property {Object} [tags]
 */

/**
 * @typedef {Object} AnimalTriggerInput
 * @property {string} [id]
 * @property {string} [type] // "time" | "symptom" | "event"
 * @property {string} [expression]
 * @property {string|Date} [windowStart]
 * @property {string|Date} [windowEnd]
 */

/**
 * @typedef {Object} AnimalScheduleInput
 * @property {string} [frequency]   // "daily", "weekly", cron-like
 * @property {string|Date} [windowStart]
 * @property {string|Date} [windowEnd]
 */

/**
 * @typedef {Object} AnimalCareRawInput
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [notes]
 * @property {string} [protocolType]   // "dailyCare", "medication", "butchery", "breeding", ...
 * @property {string} [species]        // "goat", "chicken", "cow", etc.
 * @property {string} [breed]
 * @property {string} [ageGroup]
 * @property {string} [purpose]
 * @property {AnimalInput[]} [animals]
 * @property {AnimalProcedureInput[]} [procedures]
 * @property {string[]} [proceduresText]
 * @property {AnimalMaterialInput[]} [materials]
 * @property {string[]} [materialsLines]
 * @property {AnimalTriggerInput[]} [triggers]
 * @property {AnimalScheduleInput} [schedule]
 * @property {Object} [metadata]
 */

/* ----------------------------- Public: Normalize ----------------------------- */

/**
 * Normalize raw Animal Care UI input into a canonical "artifact" that:
 *   - is domain-aware ("animals"),
 *   - has structured animals, procedures, materials, schedule/triggers,
 *   - has sessionMeta scaffolded for StepGraph + compliance,
 *   - is safe to pass to StepGraphContract.toStepGraph("animals", artifact).
 *
 * @param {AnimalCareRawInput|any} rawInput
 * @returns {Object} artifact
 */
export function normalizeAnimalCareInput(rawInput) {
  const ts = new Date().toISOString();
  const safe = rawInput && typeof rawInput === "object" ? rawInput : {};

  const artifactId =
    typeof safe.id === "string" && safe.id.trim()
      ? safe.id.trim()
      : `animals:protocol:${Date.now()}`;

  const title =
    (typeof safe.title === "string" && safe.title.trim()) ||
    (typeof safe.name === "string" && safe.name.trim()) ||
    "Untitled Animal Care Protocol";

  const description =
    (typeof safe.description === "string" && safe.description.trim()) ||
    (typeof safe.notes === "string" && safe.notes.trim()) ||
    "";

  const protocolType =
    (typeof safe.protocolType === "string" && safe.protocolType.trim()) ||
    "unspecified";

  const species =
    (typeof safe.species === "string" && safe.species.trim()) || "unspecified";

  const breed = (typeof safe.breed === "string" && safe.breed.trim()) || null;

  const ageGroup =
    (typeof safe.ageGroup === "string" && safe.ageGroup.trim()) || null;

  const purpose =
    (typeof safe.purpose === "string" && safe.purpose.trim()) || null;

  const animals = normalizeAnimals(safe.animals);
  const globalMaterials = normalizeMaterials(
    safe.materials,
    safe.materialsLines
  );
  const procedures = normalizeProcedures(
    safe.procedures,
    safe.proceduresText,
    animals,
    globalMaterials
  );
  const triggers = normalizeTriggers(safe.triggers);
  const schedule = normalizeSchedule(safe.schedule);

  const consumes = buildConsumesFromMaterialsAndProcedures(
    globalMaterials,
    procedures
  );
  const produces = buildProducesFromProtocol(procedures, species, purpose);

  /** @type {Object} */
  const artifact = {
    id: artifactId,
    domain: "animals",
    type: "careProtocol",
    title,
    description,
    notes: typeof safe.notes === "string" ? safe.notes : "",
    protocolType,
    species,
    breed,
    ageGroup,
    purpose,
    animals,
    procedures,
    triggers,
    schedule,
    materials: globalMaterials,
    consumes,
    produces,
    tags: normalizeTags(safe.metadata?.tags),
    metadata: {
      ...safe.metadata,
      uiVersion: safe.metadata?.uiVersion || "1.0.0",
      source: safe.metadata?.source || "ui.animals",
    },
    sessionMeta: {
      stepGraphReady: false,
      compliance: null,
    },
  };

  emitSafe({
    type: "animals.protocol.normalized",
    ts,
    source: MODULE_SOURCE,
    data: {
      artifactId,
      title,
      protocolType,
      species,
      animalCount: animals.length,
      procedureCount: procedures.length,
      triggerCount: triggers.length,
    },
  });

  return artifact;
}

/* ----------------------------- Public: StepGraph ----------------------------- */

/**
 * Build a StepGraph for the given animal care artifact.
 * Thin wrapper around StepGraphContract.toStepGraph("animals", artifact),
 * with validation + event emission.
 *
 * @param {Object} artifact - result of normalizeAnimalCareInput
 * @returns {Object|null} StepGraph or null on failure
 */
export function buildAnimalCareStepGraph(artifact) {
  const ts = new Date().toISOString();

  if (!artifact || typeof artifact !== "object") {
    emitSafe({
      type: "animals.stepGraph.failed",
      ts,
      source: MODULE_SOURCE,
      data: {
        reason: "Invalid artifact",
      },
    });
    return null;
  }

  const graph = toStepGraph("animals", artifact);

  if (!graph) {
    emitSafe({
      type: "animals.stepGraph.failed",
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
    type: "animals.stepGraph.built",
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

/* ------------------------------ Animals -------------------------------------- */

/**
 * Normalize animals into a consistent structure.
 *
 * @param {AnimalInput[]|any[]} maybeAnimals
 * @returns {AnimalInput[]}
 */
function normalizeAnimals(maybeAnimals) {
  if (!Array.isArray(maybeAnimals) || maybeAnimals.length === 0) return [];

  return maybeAnimals
    .map((animal, index) => {
      if (!animal || typeof animal !== "object") return null;

      const tag =
        (typeof animal.tag === "string" && animal.tag.trim()) ||
        (typeof animal.earTag === "string" && animal.earTag.trim()) ||
        null;

      const name =
        (typeof animal.name === "string" && animal.name.trim()) || null;

      const group =
        (typeof animal.group === "string" && animal.group.trim()) ||
        (typeof animal.herd === "string" && animal.herd.trim()) ||
        null;

      if (!tag && !name && !group) {
        // nothing to identify this animal/group
        return null;
      }

      return {
        id: animal.id || `animal-${index + 1}`,
        tag,
        name,
        group,
        notes: typeof animal.notes === "string" ? animal.notes : "",
      };
    })
    .filter(Boolean);
}

/* ----------------------------- Materials (Global) ---------------------------- */

/**
 * Normalize materials (feeds, drugs, supplies) from either:
 *   - structured `materials` array
 *   - simple `materialsLines` ("5 ml ivermectin", "1 scoop feed")
 *
 * @param {any[]} maybeStructured
 * @param {string[]|undefined} maybeLines
 * @returns {AnimalMaterialInput[]}
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
 * Very simple material line parser: "5 ml ivermectin"
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

/* ------------------------------ Procedures ----------------------------------- */

/**
 * Normalize procedures from either structured objects or text-only list.
 *
 * @param {AnimalProcedureInput[]|any[]} maybeProcedures
 * @param {string[]|undefined} maybeProceduresText
 * @param {AnimalInput[]} animals
 * @param {AnimalMaterialInput[]} globalMaterials
 * @returns {AnimalProcedureInput[]}
 */
function normalizeProcedures(
  maybeProcedures,
  maybeProceduresText,
  animals,
  globalMaterials
) {
  if (Array.isArray(maybeProcedures) && maybeProcedures.length > 0) {
    return maybeProcedures
      .map((proc, index) => {
        if (!proc || typeof proc !== "object") return null;

        const label =
          (typeof proc.label === "string" && proc.label.trim()) ||
          (typeof proc.title === "string" && proc.title.trim()) ||
          `Step ${index + 1}`;

        const description =
          (typeof proc.description === "string" && proc.description.trim()) ||
          "";

        const kind =
          (typeof proc.kind === "string" && proc.kind.trim()) || "unspecified";

        const targets = normalizeProcedureTargets(proc.targetAnimals, animals);

        return {
          id: proc.id || `procedure-${index + 1}`,
          label,
          description,
          kind,
          duration:
            proc.duration || proc.time || proc.estimatedDuration || null,
          targetAnimalIds: targets.animalIds,
          materials: normalizeProcedureMaterials(
            proc.materials,
            globalMaterials
          ),
          equipment: normalizeProcedureEquipment(proc.equipment),
          preconditions: normalizeConditions(proc.preconditions),
          expectedOutcomes: normalizeConditions(proc.expectedOutcomes),
          tags: normalizeTags(proc.tags),
        };
      })
      .filter(Boolean);
  }

  if (Array.isArray(maybeProceduresText) && maybeProceduresText.length > 0) {
    return maybeProceduresText
      .map((text, index) => {
        if (typeof text !== "string") return null;
        const desc = text.trim();
        if (!desc) return null;

        return {
          id: `procedure-${index + 1}`,
          label: `Step ${index + 1}`,
          description: desc,
          kind: "unspecified",
          duration: null,
          targetAnimalIds: [],
          materials: [],
          equipment: [],
          preconditions: [],
          expectedOutcomes: [],
          tags: {},
        };
      })
      .filter(Boolean);
  }

  return [];
}

/**
 * Normalize which animals a procedure targets, into ID arrays.
 *
 * @param {any[]} targetAnimals
 * @param {AnimalInput[]} animals
 * @returns {{ animalIds: string[] }}
 */
function normalizeProcedureTargets(targetAnimals, animals) {
  const animalIds = new Set();

  const byId = new Set(animals.map((a) => a.id));
  const byTag = new Map(
    animals.filter((a) => a.tag).map((a) => [a.tag.toLowerCase(), a.id])
  );
  const byGroup = new Map(
    animals.filter((a) => a.group).map((a) => [a.group.toLowerCase(), a.id])
  );

  if (Array.isArray(targetAnimals)) {
    for (const t of targetAnimals) {
      if (!t) continue;

      if (typeof t === "string") {
        const s = t.trim();
        if (!s) continue;
        // direct ID
        if (byId.has(s)) {
          animalIds.add(s);
          continue;
        }
        // tag
        const byTagId = byTag.get(s.toLowerCase());
        if (byTagId) {
          animalIds.add(byTagId);
          continue;
        }
        // group (may map to multiple animals)
        const groupId = byGroup.get(s.toLowerCase());
        if (groupId) {
          animalIds.add(groupId);
          continue;
        }
      } else if (typeof t === "object") {
        const id = (typeof t.id === "string" && t.id.trim()) || null;
        if (id && byId.has(id)) {
          animalIds.add(id);
          continue;
        }
        const tag = (typeof t.tag === "string" && t.tag.trim()) || null;
        if (tag) {
          const byTagId = byTag.get(tag.toLowerCase());
          if (byTagId) {
            animalIds.add(byTagId);
            continue;
          }
        }
        const group = (typeof t.group === "string" && t.group.trim()) || null;
        if (group) {
          const groupId = byGroup.get(group.toLowerCase());
          if (groupId) {
            animalIds.add(groupId);
            continue;
          }
        }
      }
    }
  }

  return { animalIds: Array.from(animalIds) };
}

/**
 * Normalize per-procedure materials, referencing global materials when possible.
 *
 * @param {any[]} procMaterials
 * @param {AnimalMaterialInput[]} globalMaterials
 * @returns {AnimalMaterialInput[]}
 */
function normalizeProcedureMaterials(procMaterials, globalMaterials) {
  if (!Array.isArray(procMaterials) || procMaterials.length === 0) return [];

  const results = [];

  for (const item of procMaterials) {
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
          id: `proc-mat-${idOrName}`,
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
        id: item.id || `proc-mat-${name}`,
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
 * Normalize per-procedure equipment.
 *
 * @param {any[]} equipment
 * @returns {Array<{ id: string, name: string }>}
 */
function normalizeProcedureEquipment(equipment) {
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

/**
 * Normalize preconditions / expected outcomes arrays into
 *   [ { description: string } ].
 *
 * @param {string[]|Array<{ description: string }>|undefined} raw
 * @returns {Array<{ description: string }>}
 */
function normalizeConditions(raw) {
  if (!Array.isArray(raw)) return [];

  const results = [];

  for (const item of raw) {
    if (!item) continue;
    if (typeof item === "string") {
      const d = item.trim();
      if (d) results.push({ description: d });
    } else if (typeof item === "object") {
      const d =
        (typeof item.description === "string" && item.description.trim()) || "";
      if (d) results.push({ description: d });
    }
  }

  return results;
}

/* ------------------------------ Triggers & Schedule -------------------------- */

/**
 * Normalize triggers into a consistent structure.
 *
 * @param {AnimalTriggerInput[]|any[]} maybeTriggers
 * @returns {AnimalTriggerInput[]}
 */
function normalizeTriggers(maybeTriggers) {
  if (!Array.isArray(maybeTriggers) || maybeTriggers.length === 0) return [];

  return maybeTriggers
    .map((t, index) => {
      if (!t || typeof t !== "object") return null;

      const type =
        (typeof t.type === "string" && t.type.trim()) || "unspecified";

      const expression =
        (typeof t.expression === "string" && t.expression.trim()) || "";

      if (!expression) {
        // Without an expression, it's not useful as a trigger.
        return null;
      }

      return {
        id: t.id || `trigger-${index + 1}`,
        type,
        expression,
        windowStart: normalizeDateOrNull(t.windowStart),
        windowEnd: normalizeDateOrNull(t.windowEnd),
      };
    })
    .filter(Boolean);
}

/**
 * Normalize schedule (frequency + optional window).
 *
 * @param {AnimalScheduleInput|any} raw
 * @returns {{ frequency: string|null, windowStart: string|null, windowEnd: string|null }}
 */
function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      frequency: null,
      windowStart: null,
      windowEnd: null,
    };
  }

  const frequency =
    (typeof raw.frequency === "string" && raw.frequency.trim()) || null;

  return {
    frequency,
    windowStart: normalizeDateOrNull(raw.windowStart),
    windowEnd: normalizeDateOrNull(raw.windowEnd),
  };
}

/* -------------------------- Consumes & Produces ------------------------------ */

/**
 * Build a "consumes" array from global materials and procedure materials.
 * Used later to link to inventory/storehouse (feed, drugs, supplies).
 *
 * @param {AnimalMaterialInput[]} globalMaterials
 * @param {AnimalProcedureInput[]} procedures
 * @returns {Array<{ id: string, name: string, quantity: number, unit: string|null, metadata: any }>}
 */
function buildConsumesFromMaterialsAndProcedures(globalMaterials, procedures) {
  const consumes = [];

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

  if (Array.isArray(procedures)) {
    for (const proc of procedures) {
      if (!proc || !Array.isArray(proc.materials)) continue;

      for (const mat of proc.materials) {
        if (!mat || typeof mat !== "object") continue;
        const name = typeof mat.name === "string" ? mat.name.trim() : "";
        if (!name) continue;

        const quantity = typeof mat.quantity === "number" ? mat.quantity : 0;
        const unit = typeof mat.unit === "string" ? mat.unit : null;

        consumes.push({
          id: mat.id || `proc-material-consume-${name}`,
          name,
          quantity,
          unit,
          metadata: {
            from: "procedure",
            procedureId: proc.id,
          },
        });
      }
    }
  }

  return consumes;
}

/**
 * Build "produces" list from the protocol.
 * For now this is heuristic:
 *   - If protocolType includes "butchery" → produce a carcass/meat item.
 *   - If purpose includes "milk"/"eggs" and protocol ensures production,
 *     we can represent expected outputs (future extension).
 *
 * @param {AnimalProcedureInput[]} procedures
 * @param {string} species
 * @param {string|null} purpose
 * @returns {Array<{ id: string, name: string, expectedYield: any, metadata: any }>}
 */
function buildProducesFromProtocol(procedures, species, purpose) {
  const produces = [];

  const protoButchery =
    Array.isArray(procedures) &&
    procedures.some(
      (p) =>
        typeof p?.kind === "string" &&
        p.kind.toLowerCase().includes("slaughter")
    );

  if (protoButchery) {
    const baseName = (species && species.toLowerCase()) || "animal";

    produces.push({
      id: `produce-carcass-${Date.now()}`,
      name: `${baseName} carcass`,
      expectedYield: null, // yield estimator can fill later
      metadata: {
        type: "carcass",
        species,
      },
    });
  }

  // Future: add milk/egg products based on purpose/protocolType

  return produces;
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
      console.warn("[AnimalCareArtifactAdapter] Failed to emit event", err);
    }
  }
}
