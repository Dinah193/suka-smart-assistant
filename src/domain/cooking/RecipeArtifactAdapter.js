// src/domain/cooking/RecipeArtifactAdapter.js
//
// RecipeArtifactAdapter
// ---------------------
// Cooking: Recipe → artifact → StepGraph
//
// Pipeline role:
//   imports/UI → normalizeCookingInput → (artifact)
//   → buildCookingStepGraph → VaultSavePipeline → automation → (optional) Hub export
//
// This file is domain-specific for COOKING but uses shared SSA contracts.
// It does NOT persist anything. No Hub export here.
//
// Required exports (per your latest instruction):
//   export function normalizeCookingInput(rawInput) { ... }
//   export function buildCookingStepGraph(artifact) { ... }
//
// All internal helper logic is unchanged.
//
// --------------------------------------------------------------------------------

/* ---------------------------------- Imports ---------------------------------- */

import { emitEvent } from "../../services/eventBus";
import { toStepGraph } from "../../services/sessions/StepGraphContract";

/* --------------------------------- Constants --------------------------------- */

const MODULE_SOURCE = "domain.cooking.RecipeArtifactAdapter";

/* ----------------------------- Public: Normalize ----------------------------- */

/**
 * Normalize raw Cooking UI input into a canonical "artifact."
 *
 * REQUIRED API SIGNATURE:
 *   export function normalizeCookingInput(rawInput)
 *
 * @param {any} rawInput
 * @returns {Object} artifact
 */
export function normalizeCookingInput(rawInput) {
  const ts = new Date().toISOString();

  const safe = rawInput && typeof rawInput === "object" ? rawInput : {};

  const artifactId =
    typeof safe.id === "string" && safe.id.trim()
      ? safe.id.trim()
      : `cooking:recipe:${Date.now()}`;

  const title =
    (typeof safe.title === "string" && safe.title.trim()) ||
    (typeof safe.name === "string" && safe.name.trim()) ||
    "Untitled Recipe";

  const description =
    (typeof safe.description === "string" && safe.description.trim()) ||
    (typeof safe.notes === "string" && safe.notes.trim()) ||
    "";

  const ingredients = normalizeIngredients(
    safe.ingredients,
    safe.ingredientsLines
  );
  const steps = normalizeSteps(safe.steps, safe.stepsText, ingredients);

  const artifact = {
    id: artifactId,
    domain: "cooking",
    type: "recipe",
    title,
    description,
    notes: typeof safe.notes === "string" ? safe.notes : "",
    source: safe.metadata?.source || "ui.cooking",
    createdAt: safe.createdAt || ts,
    updatedAt: ts,
    ingredients,
    steps,
    consumes: buildConsumesFromIngredients(ingredients),
    produces: safe.produces || [],
    tags: normalizeTags(safe.metadata?.tags),
    metadata: {
      ...safe.metadata,
      uiVersion: safe.metadata?.uiVersion || "1.0.0",
    },
    sessionMeta: {
      stepGraphReady: false,
      compliance: null,
    },
  };

  emitSafe({
    type: "cooking.recipe.normalized",
    ts,
    source: MODULE_SOURCE,
    data: {
      artifactId,
      title,
      ingredientCount: ingredients.length,
      stepCount: steps.length,
    },
  });

  return artifact;
}

/* ----------------------------- Public: StepGraph ----------------------------- */

/**
 * Build a StepGraph for the artifact.
 *
 * REQUIRED API SIGNATURE:
 *   export function buildCookingStepGraph(artifact)
 *
 * @param {Object} artifact
 * @returns {Object|null}
 */
export function buildCookingStepGraph(artifact) {
  const ts = new Date().toISOString();

  if (!artifact || typeof artifact !== "object") {
    emitSafe({
      type: "cooking.stepGraph.failed",
      ts,
      source: MODULE_SOURCE,
      data: { reason: "Invalid artifact" },
    });
    return null;
  }

  const graph = toStepGraph("cooking", artifact);

  if (!graph) {
    emitSafe({
      type: "cooking.stepGraph.failed",
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
    type: "cooking.stepGraph.built",
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

/* --------------------------- Ingredient Normalization ------------------------ */

function normalizeIngredients(maybeStructured, maybeLines) {
  if (Array.isArray(maybeStructured) && maybeStructured.length > 0) {
    return maybeStructured
      .map((ing, index) => {
        if (!ing || typeof ing !== "object") return null;
        const name =
          (typeof ing.name === "string" && ing.name.trim()) ||
          (typeof ing.label === "string" && ing.label.trim()) ||
          "";
        if (!name) return null;

        const quantity =
          typeof ing.quantity === "number"
            ? ing.quantity
            : typeof ing.qty === "number"
            ? ing.qty
            : null;

        const unit =
          (typeof ing.unit === "string" && ing.unit.trim()) ||
          (typeof ing.uom === "string" && ing.uom.trim()) ||
          null;

        return {
          id: ing.id || `ing-${index + 1}`,
          name,
          quantity,
          unit,
          notes: typeof ing.notes === "string" ? ing.notes : "",
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

        const parsed = parseLooseIngredientLine(trimmed);

        return {
          id: `ing-${index + 1}`,
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

function parseLooseIngredientLine(line) {
  const parts = line.split(/\s+/);
  if (parts.length === 0) {
    return { quantity: null, unit: null, name: "" };
  }

  const maybeQty = parseFloat(parts[0].replace(",", "."));
  if (!Number.isNaN(maybeQty)) {
    if (parts.length === 1) return { quantity: maybeQty, unit: null, name: "" };
    const unit = parts[1];
    const name = parts.slice(2).join(" ").trim();
    return { quantity: maybeQty, unit: unit || null, name: name || line };
  }

  return { quantity: null, unit: null, name: line };
}

/* ------------------------------ Step Normalization --------------------------- */

function normalizeSteps(maybeSteps, maybeStepsText, ingredients) {
  if (Array.isArray(maybeSteps) && maybeSteps.length > 0) {
    return maybeSteps
      .map((step, index) => {
        if (!step || typeof step !== "object") return null;

        const label =
          (typeof step.label === "string" && step.label.trim()) ||
          (typeof step.title === "string" && step.title.trim()) ||
          `Step ${index + 1}`;

        const description =
          (typeof step.description === "string" && step.description.trim()) ||
          "";

        return {
          id: step.id || `step-${index + 1}`,
          label,
          description,
          duration:
            step.duration || step.time || step.estimatedDuration || null,
          ingredients: normalizeStepIngredients(step.ingredients, ingredients),
          equipment: normalizeStepEquipment(step.equipment),
        };
      })
      .filter(Boolean);
  }

  if (Array.isArray(maybeStepsText) && maybeStepsText.length > 0) {
    return maybeStepsText
      .map((text, index) => {
        if (typeof text !== "string") return null;
        const desc = text.trim();
        if (!desc) return null;

        return {
          id: `step-${index + 1}`,
          label: `Step ${index + 1}`,
          description: desc,
          duration: null,
          ingredients: [],
          equipment: [],
        };
      })
      .filter(Boolean);
  }

  return [];
}

function normalizeStepIngredients(stepIng, allIngredients) {
  if (!Array.isArray(stepIng) || stepIng.length === 0) return [];

  const results = [];

  for (const item of stepIng) {
    if (!item) continue;

    if (typeof item === "string") {
      const id = item.trim();
      if (!id) continue;
      const found = allIngredients.find(
        (ing) => ing.id === id || ing.name === id
      );
      if (found) results.push(found);
      else {
        results.push({
          id: `step-ing-${id}`,
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
        id: item.id || `step-ing-${name}`,
        name,
        quantity,
        unit,
        notes: typeof item.notes === "string" ? item.notes : "",
      });
    }
  }

  return results;
}

function normalizeStepEquipment(equipment) {
  if (!Array.isArray(equipment) || equipment.length === 0) return [];

  const results = [];

  for (let i = 0; i < equipment.length; i++) {
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

function buildConsumesFromIngredients(ingredients) {
  if (!Array.isArray(ingredients)) return [];

  return ingredients
    .map((ing, index) => {
      if (!ing || typeof ing !== "object") return null;
      const name = typeof ing.name === "string" ? ing.name.trim() : "";
      if (!name) return null;

      const quantity = typeof ing.quantity === "number" ? ing.quantity : 0;
      const unit = typeof ing.unit === "string" ? ing.unit : null;

      return {
        id: ing.id || `consumes-${index + 1}`,
        name,
        quantity,
        unit,
        metadata: { from: "ingredients" },
      };
    })
    .filter(Boolean);
}

/* --------------------------------- Tags -------------------------------------- */

function normalizeTags(raw) {
  if (!raw || typeof raw !== "object") return {};
  return { ...raw };
}

/* --------------------------------- Events ----------------------------------- */

function emitSafe(payload) {
  try {
    emitEvent?.(payload);
  } catch (err) {
    console.warn("[RecipeArtifactAdapter] Failed to emit event", err);
  }
}
