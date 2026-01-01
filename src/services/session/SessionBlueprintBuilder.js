// src/services/session/SessionBlueprintBuilder.js
// -----------------------------------------------------------------------------
// SessionBlueprintBuilder (L3)
// -----------------------------------------------------------------------------
// Builds a runnable "blueprint" from:
// - method maps (L2)
// - parsed candidates (L1)
// - LayerResolver method definition (fixed + overrides)
// Stores into db.blueprints and emits blueprint.created
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import { db } from "@/services/db";
import { emit } from "@/services/events/eventBus";
import LayerResolver from "@/services/layers/LayerResolver";

function nowIso() {
  return new Date().toISOString();
}

function str(x) {
  return String(x || "").trim();
}

function pickTopMethod(methodMaps = [], { minConfidence = 0.25 } = {}) {
  const ranked = (methodMaps || [])
    .filter((m) => m && typeof m.confidence === "number")
    .sort((a, b) => b.confidence - a.confidence);

  const top = ranked[0];
  if (!top) return null;
  if (top.confidence < minConfidence) return null;
  return top;
}

function buildStepsFromPattern(pattern, entities = {}) {
  const rawSteps = Array.isArray(pattern?.steps) ? pattern.steps : [];
  const steps = rawSteps.map((s, i) => {
    const id = s.id || `step_${i + 1}`;
    return {
      id,
      title: s.title || s.name || `Step ${i + 1}`,
      body: s.body || s.text || "",
      checklist: Array.isArray(s.checklist) ? s.checklist : [],
      timers: Array.isArray(s.timers) ? s.timers : [],
      cues: Array.isArray(s.cues) ? s.cues : [],
      meta: { ...(s.meta || {}), source: "catalogPattern" },
    };
  });

  // Flatten timers for convenience
  const timers = [];
  for (const step of steps) {
    for (const t of step.timers || []) {
      timers.push({
        stepId: step.id,
        label: t.label || t.name || "Timer",
        seconds: t.seconds || t.durationSeconds || null,
        meta: t.meta || {},
      });
    }
  }

  return { steps, timers };
}

export async function buildBlueprintFromImport({
  artifactId,
  candidateId,
  methodMapId,
  methodKey, // optional direct
  householdId,
  userId,
  minConfidence = 0.25,
} = {}) {
  if (!db?.blueprints) throw new Error("Dexie db.blueprints table not available.");

  const artifact = artifactId ? await db.artifacts.get(artifactId) : null;
  const candidate = candidateId ? await db.parsed_candidates.get(candidateId) : null;

  let chosenMethodMap = null;
  if (methodMapId) {
    chosenMethodMap = await db.method_maps.get(methodMapId);
  } else if (artifactId && candidateId) {
    const maps = await db.method_maps
      .where("[candidateId+methodKey]")
      .between([candidateId, ""], [candidateId, "\uffff"])
      .toArray();
    chosenMethodMap = pickTopMethod(maps, { minConfidence });
  }

  const mk = str(methodKey || chosenMethodMap?.methodKey);
  if (!mk) {
    return { ok: false, error: "No methodKey/methodMap found above confidence threshold." };
  }

  const dom = str(chosenMethodMap?.domain || artifact?.domain || candidate?.domain || "unknown");

  const resolved = await LayerResolver.resolveMethod({
    methodKey: mk,
    domain: dom,
    householdId,
    userId,
  });

  if (!resolved?.ok) {
    return { ok: false, error: resolved?.error || "LayerResolver failed", resolved };
  }

  // Build blueprint from resolved definition.
  // If source is catalog pattern, resolved.resolved is the pattern object.
  const methodDef = resolved.resolved || {};
  const entities = candidate?.entities || {};

  const { steps, timers } = buildStepsFromPattern(methodDef, entities);

  const createdAt = nowIso();
  const blueprint = {
    domain: dom,
    blueprintKey: mk,
    createdAt,
    updatedAt: createdAt,
    artifactId: artifact?.id || artifactId || null,
    candidateId: candidate?.id || candidateId || null,
    methodMapId: chosenMethodMap?.id || methodMapId || null,
    sessionId: null,
    status: "created",
    methodKey: mk,
    methodAudit: resolved.audit || {},
    resources: methodDef.resources || methodDef.requiredResources || [],
    tools: methodDef.tools || methodDef.requiredTools || [],
    constraints: methodDef.constraints || {},
    steps,
    timers,
    signals: methodDef.signals || methodDef.cues || [],
    entities,
  };

  const blueprintId = await db.blueprints.add(blueprint);

  emit("blueprint.created", {
    blueprintId,
    domain: dom,
    methodKey: mk,
    artifactId: blueprint.artifactId,
    candidateId: blueprint.candidateId,
    methodMapId: blueprint.methodMapId,
    ts: createdAt,
  });

  return { ok: true, blueprintId, blueprint };
}

export default { buildBlueprintFromImport };
