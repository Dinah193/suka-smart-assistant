// src/agents/shims/importSessionShim.js
// -----------------------------------------------------------------------------
// importSessionShim
// -----------------------------------------------------------------------------
// Deterministic orchestrator shim to drive:
// - import.parse (L0 -> L1/L2)
// - session.generate.fromImport (L2 -> L3 -> session)
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import { db } from "@/services/db";
import { emit } from "@/services/events/eventBus";

import { routeArtifact } from "@/services/ingest/ImportRouter";
import { buildBlueprintFromImport } from "@/services/session/SessionBlueprintBuilder";
import { resolvePreferences } from "@/services/prefs/PreferenceResolver";

function nowIso() {
  return new Date().toISOString();
}

function str(x) {
  return String(x || "").trim();
}

async function createSessionFromBlueprint({ blueprint, blueprintId, prefsPatch, preferencesApplied }) {
  if (!db?.sessions) throw new Error("Dexie db.sessions table not available.");

  const createdAt = nowIso();

  // Minimal runnable session object (SessionRunner expects a shape with steps)
  const session = {
    domain: blueprint.domain,
    status: "planned",
    startedAt: null,
    updatedAt: createdAt,
    plannedFor: createdAt,
    originImportId: blueprint.artifactId || null,
    blueprintId: blueprintId || null,
    methodKey: blueprint.methodKey || blueprint.blueprintKey || null,
    steps: Array.isArray(blueprint.steps) ? blueprint.steps : [],
    timers: Array.isArray(blueprint.timers) ? blueprint.timers : [],
    meta: {
      artifactId: blueprint.artifactId || null,
      candidateId: blueprint.candidateId || null,
      methodMapId: blueprint.methodMapId || null,
      preferencesApplied: preferencesApplied || [],
      preferencesPatch: prefsPatch || {},
      methodAudit: blueprint.methodAudit || {},
    },
  };

  const sessionId = await db.sessions.add(session);

  // back-link the blueprint to the session
  try {
    await db.blueprints.update(blueprintId, { sessionId, updatedAt: nowIso(), status: "session_created" });
  } catch (e) {}

  emit("session.created.fromImport", {
    sessionId,
    blueprintId,
    domain: blueprint.domain,
    methodKey: session.methodKey,
    artifactId: blueprint.artifactId,
    ts: createdAt,
  });

  return { ok: true, sessionId, session };
}

export async function invokeImportSessionShim(req = {}) {
  const intent = str(req.intent);
  const payload = req.payload || {};

  if (intent === "import.parse") {
    const artifactId = payload.artifactId;
    if (!artifactId) return { ok: false, error: "import.parse missing artifactId" };

    const artifact = await db.artifacts.get(artifactId);
    if (!artifact) return { ok: false, error: "Artifact not found", artifactId };

    const result = await routeArtifact(artifact, { forceDomain: payload.forceDomain });
    return { ok: true, ...result };
  }

  if (intent === "session.generate.fromImport") {
    const artifactId = payload.artifactId;
    const candidateId = payload.candidateId;
    const methodMapId = payload.methodMapId;
    const householdId = payload.householdId || null;
    const userId = payload.userId || null;

    // Build blueprint
    const bp = await buildBlueprintFromImport({
      artifactId,
      candidateId,
      methodMapId,
      methodKey: payload.methodKey,
      householdId,
      userId,
      minConfidence: payload.minConfidence ?? 0.25,
    });

    if (!bp?.ok) return { ok: false, error: bp?.error || "Blueprint build failed", details: bp };

    const blueprint = bp.blueprint;

    // Preferences patch (deterministic)
    const { patch, preferencesApplied } = resolvePreferences({
      safety: payload.safety || {},
      household: payload.householdRules || payload.household || {},
      user: payload.userPrefs || payload.user || {},
      context: payload.context || {},
      methodDefaults: blueprint?.constraints?.defaults || blueprint?.defaults || {},
    });

    // Apply patch to blueprint (steps/meta only; do not mutate stored blueprint)
    const patchedBlueprint = {
      ...blueprint,
      steps: (blueprint.steps || []).map((s) => ({
        ...s,
        meta: { ...(s.meta || {}), ...(patch?.stepMetaPatch || {}) },
      })),
      constraints: { ...(blueprint.constraints || {}), ...(patch?.constraintsPatch || {}) },
    };

    const created = await createSessionFromBlueprint({
      blueprint: patchedBlueprint,
      blueprintId: bp.blueprintId,
      prefsPatch: patch,
      preferencesApplied,
    });

    return created;
  }

  return { ok: false, error: `importSessionShim: unknown intent '${intent}'` };
}

export default { invokeImportSessionShim };
