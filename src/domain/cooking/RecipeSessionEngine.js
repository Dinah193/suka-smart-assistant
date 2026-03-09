// src/domain/cooking/RecipeSessionEngine.js
//
// RecipeSessionEngine
// -------------------
// Cooking: Recipe Artifact → Session (StepGraph-backed).
//
// Pipeline role:
//   imports/UI → RecipeArtifactAdapter.normalizeCookingInput (artifact)
//   → buildCookingStepGraph (StepGraph)
//   → RecipeSessionEngine.createCookingSession (session)
//   → SessionRunner / automation runtime → (optional) Hub export
//
// This engine lives in the *intelligence* layer:
// - It does NOT scrape imports.
// - It does NOT render UI.
// - It turns a cooking artifact into a session-ready object that the shared
//   SessionRunner can play (multi-timer, task-by-task guidance).
//
// Household data note:
//   Generated sessions are part of household state. When we *persist* a
//   session, we:
//     - emit cooking.session.saved & automation.session.generated
//     - optionally export a small packet to the Hub when familyFundMode=true.
//
// Storage note:
//   Storage is abstracted via a simple adapter:
//     globalThis.SSA_SESSION_STORE_ADAPTER = { saveSession(session) => Promise<result> }
//   This keeps domain logic decoupled from Dexie/DB specifics.

/* ---------------------------------- Imports ---------------------------------- */

import { emitEvent } from "../../services/events/eventBus";
import { featureFlags } from "../../config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

import {
  normalizeCookingInput,
  buildCookingStepGraph,
} from "./RecipeArtifactAdapter";

/* --------------------------------- Constants --------------------------------- */

const MODULE_SOURCE = "domain.cooking.RecipeSessionEngine";

const SESSION_VERSION = 1;

/**
 * Status vocabulary (minimum viable):
 *   planned  - created and scheduled in the near future
 *   ready    - created and ready to play now
 *   running  - SessionRunner is actively guiding it
 *   done     - completed
 *   cancelled- cancelled / abandoned
 */
const SESSION_STATUS = Object.freeze({
  PLANNED: "planned",
  READY: "ready",
  RUNNING: "running",
  DONE: "done",
  CANCELLED: "cancelled",
});

/* ------------------------------ Public API ----------------------------------- */

/**
 * Create a cooking session from either a raw Cooking UI input or a normalized
 * artifact. Optionally persist via session-store adapter.
 *
 * Typical usage from VaultSavePipeline:
 *
 *   const { session, persistedResult } = await createCookingSession({
 *     householdId,
 *     artifact,       // normalized cooking artifact from Vault
 *     sessionOptions: { scheduledFor: someDate }
 *   });
 *
 * Or from UI:
 *
 *   const { session } = await createCookingSession({
 *     householdId,
 *     rawInput: uiFormState,
 *     options: { persist: false } // let caller persist later
 *   });
 *
 * @param {Object} params
 * @param {string|null|undefined} params.householdId
 * @param {Object} [params.artifact]       - normalized cooking artifact (optional)
 * @param {Object} [params.rawInput]       - raw Cooking UI input (optional)
 * @param {Object} [params.sessionOptions] - { scheduledFor?: string|Date, label?: string }
 * @param {Object} [params.options]
 * @param {boolean} [params.options.persist=true] - whether to persist session
 *
 * @returns {Promise<{
 *   session: any|null,
 *   artifact: any|null,
 *   stepGraph: any|null,
 *   persistedResult: any|null,
 *   error?: string
 * }>}
 */
export async function createCookingSession({
  householdId,
  artifact,
  rawInput,
  sessionOptions = {},
  options = {},
}) {
  const ts = new Date().toISOString();
  const persist = options.persist !== false; // default true

  // 1) Ensure we have an artifact
  let cookingArtifact = artifact;

  try {
    if (!cookingArtifact) {
      if (!rawInput || typeof rawInput !== "object") {
        const error =
          "createCookingSession requires either a normalized artifact or rawInput from Cooking UI.";
        logFailure("cooking.session.prepare.failed", ts, {
          householdId: householdId || "default",
          reason: error,
        });
        return {
          session: null,
          artifact: null,
          stepGraph: null,
          persistedResult: null,
          error,
        };
      }

      cookingArtifact = normalizeCookingInput(rawInput);
    }

    // 2) Build StepGraph
    const stepGraph = buildCookingStepGraph(cookingArtifact);
    if (!stepGraph) {
      const error = "Failed to build StepGraph for cooking artifact.";
      logFailure("cooking.session.prepare.failed", ts, {
        householdId: householdId || "default",
        artifactId: cookingArtifact.id || null,
        reason: error,
      });

      return {
        session: null,
        artifact: cookingArtifact,
        stepGraph: null,
        persistedResult: null,
        error,
      };
    }

    // 3) Prepare session object
    const status = inferInitialStatus(sessionOptions);
    const session = buildSessionFromArtifact({
      householdId,
      artifact: cookingArtifact,
      stepGraph,
      status,
      sessionOptions,
    });

    emitSafe({
      type: "cooking.session.prepared",
      ts: session.createdAt,
      source: MODULE_SOURCE,
      data: {
        householdId: session.householdId,
        sessionId: session.id,
        artifactId: session.artifactId,
        status: session.status,
        nodeCount: Array.isArray(stepGraph.nodes) ? stepGraph.nodes.length : 0,
      },
    });

    // 4) Optional persistence
    let persistedResult = null;
    if (persist) {
      persistedResult = await persistSession(session);

      emitSafe({
        type: "cooking.session.saved",
        ts: new Date().toISOString(),
        source: MODULE_SOURCE,
        data: {
          householdId: session.householdId,
          sessionId: session.id,
          artifactId: session.artifactId,
          status: session.status,
        },
      });

      // Automation runtime can listen for this to auto-schedule/suggest.
      emitSafe({
        type: "automation.session.generated",
        ts: new Date().toISOString(),
        source: MODULE_SOURCE,
        data: {
          householdId: session.householdId,
          sessionId: session.id,
          domain: session.domain,
          type: session.type,
          status: session.status,
          scheduledFor: session.scheduledFor,
        },
      });

      // Household data changed → optionally export to Hub.
      exportToHubIfEnabled({
        householdId: session.householdId,
        domain: session.domain,
        sessionId: session.id,
        artifactId: session.artifactId,
        status: session.status,
        scheduledFor: session.scheduledFor,
      });
    }

    return {
      session,
      artifact: cookingArtifact,
      stepGraph,
      persistedResult,
    };
  } catch (err) {
    const message =
      err && typeof err.message === "string"
        ? err.message
        : "Unknown error in createCookingSession";

    if (typeof console !== "undefined") {
      console.error("[RecipeSessionEngine] createCookingSession failed", err);
    }

    logFailure("cooking.session.prepare.failed", ts, {
      householdId: householdId || "default",
      artifactId: cookingArtifact?.id || null,
      reason: message,
    });

    return {
      session: null,
      artifact: cookingArtifact || null,
      stepGraph: null,
      persistedResult: null,
      error: message,
    };
  }
}

/* --------------------------- Session Construction ---------------------------- */

/**
 * Build a session object from artifact + StepGraph.
 *
 * @param {Object} params
 * @param {string|null|undefined} params.householdId
 * @param {Object} params.artifact
 * @param {Object} params.stepGraph
 * @param {string} params.status
 * @param {Object} params.sessionOptions
 */
function buildSessionFromArtifact({
  householdId,
  artifact,
  stepGraph,
  status,
  sessionOptions,
}) {
  const now = new Date().toISOString();
  const hId = normalizeHouseholdId(householdId);

  const sessionId =
    sessionOptions.sessionId ||
    artifact.sessionMeta?.sessionId ||
    `session:cooking:${Date.now()}`;

  const scheduledFor = normalizeScheduledFor(sessionOptions.scheduledFor);

  return {
    id: sessionId,
    version: SESSION_VERSION,
    domain: "cooking",
    type: "cooking.session",
    householdId: hId,
    artifactId: artifact.id,
    status,
    createdAt: now,
    updatedAt: now,
    scheduledFor,
    // Graph + progress
    stepGraph,
    progress: {
      currentNodeId: null,
      completedNodeIds: [],
      timers: {}, // per-node timer state (SessionRunner will fill)
    },
    // Shallow metadata for showing in UI / analytics
    metadata: {
      title: artifact.title || "Untitled Recipe",
      description: artifact.description || "",
      tags: artifact.tags || {},
      source: artifact.source || "ui.cooking",
      estimatedDurationSeconds: estimateDurationFromGraph(stepGraph),
    },
  };
}

/**
 * Infer initial session status from options:
 * - If scheduledFor is in the future → planned
 * - If scheduledFor is near-now or missing → ready
 */
function inferInitialStatus(sessionOptions) {
  const date = normalizeScheduledFor(sessionOptions?.scheduledFor);
  if (!date) return SESSION_STATUS.READY;

  try {
    const ts = new Date(date).getTime();
    const now = Date.now();
    if (Number.isNaN(ts)) return SESSION_STATUS.READY;

    // If scheduled more than 5 minutes in the future, treat as planned.
    if (ts - now > 5 * 60 * 1000) {
      return SESSION_STATUS.PLANNED;
    }
    return SESSION_STATUS.READY;
  } catch {
    return SESSION_STATUS.READY;
  }
}

/**
 * Normalize householdId (allows null/undefined → "default").
 *
 * @param {string|null|undefined} householdId
 */
function normalizeHouseholdId(householdId) {
  if (!householdId || typeof householdId !== "string") return "default";
  const trimmed = householdId.trim();
  return trimmed || "default";
}

/**
 * Normalize scheduledFor into ISO string or null.
 *
 * @param {string|Date|null|undefined} value
 * @returns {string|null}
 */
function normalizeScheduledFor(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
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
 * Estimate total session duration from the StepGraph:
 * 1) If graph.timers exists with explicit durations, sum them.
 * 2) Else, fall back to summing node.durationSeconds if present.
 *
 * @param {Object} graph
 * @returns {number|null}
 */
function estimateDurationFromGraph(graph) {
  if (!graph || typeof graph !== "object") return null;

  // 1) timers with explicit durationSeconds
  if (Array.isArray(graph.timers) && graph.timers.length > 0) {
    let sum = 0;
    for (const t of graph.timers) {
      const d = toNumberSeconds(t?.durationSeconds);
      if (d != null) sum += d;
    }
    if (sum > 0) return sum;
  }

  // 2) nodes with durationSeconds
  if (Array.isArray(graph.nodes) && graph.nodes.length > 0) {
    let sum = 0;
    for (const node of graph.nodes) {
      const d = toNumberSeconds(node?.durationSeconds || node?.duration);
      if (d != null) sum += d;
    }
    if (sum > 0) return sum;
  }

  return null;
}

/**
 * Convert any numeric-ish input into a number of seconds, or null if invalid.
 *
 * @param {any} value
 * @returns {number|null}
 */
function toNumberSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Basic support for ISO-like durations "PT5M", "PT30S"
    const isoMatch = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(trimmed);
    if (isoMatch) {
      const hours = isoMatch[1] ? parseInt(isoMatch[1], 10) : 0;
      const minutes = isoMatch[2] ? parseInt(isoMatch[2], 10) : 0;
      const seconds = isoMatch[3] ? parseInt(isoMatch[3], 10) : 0;
      return hours * 3600 + minutes * 60 + seconds;
    }

    const num = parseFloat(trimmed);
    if (!Number.isNaN(num)) return num;
  }

  // object { minutes, seconds } etc.
  if (value && typeof value === "object") {
    const minutes = typeof value.minutes === "number" ? value.minutes : 0;
    const seconds = typeof value.seconds === "number" ? value.seconds : 0;
    const total = minutes * 60 + seconds;
    return total > 0 ? total : null;
  }

  return null;
}

/* ---------------------------- Persistence Adapter ---------------------------- */

/**
 * Persist a session using an external adapter, if present.
 *
 * Adapter contract:
 *   globalThis.SSA_SESSION_STORE_ADAPTER = {
 *     saveSession: async (session) => ({ id, key, ... })
 *   }
 *
 * @param {Object} session
 * @returns {Promise<any|null>}
 */
async function persistSession(session) {
  const adapter = getSessionStoreAdapter();
  if (!adapter || typeof adapter.saveSession !== "function") {
    // No adapter is not a runtime error; we just treat session as in-memory only.
    return null;
  }

  try {
    return await adapter.saveSession(session);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[RecipeSessionEngine] persistSession failed", err);
    }

    emitSafe({
      type: "cooking.session.save.failed",
      ts: new Date().toISOString(),
      source: MODULE_SOURCE,
      data: {
        householdId: session.householdId,
        sessionId: session.id,
        artifactId: session.artifactId,
        reason:
          (err && typeof err.message === "string" && err.message) ||
          "Adapter saveSession threw an error",
      },
    });

    return null;
  }
}

/**
 * Resolve the session store adapter from global scope.
 */
function getSessionStoreAdapter() {
  if (
    typeof globalThis !== "undefined" &&
    globalThis.SSA_SESSION_STORE_ADAPTER &&
    typeof globalThis.SSA_SESSION_STORE_ADAPTER === "object"
  ) {
    return globalThis.SSA_SESSION_STORE_ADAPTER;
  }
  return null;
}

/* --------------------------------- Events ----------------------------------- */

function emitSafe(payload) {
  if (typeof emitEvent !== "function") return;

  try {
    emitEvent(payload);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[RecipeSessionEngine] Failed to emit event", err);
    }
  }
}

function logFailure(type, ts, data) {
  emitSafe({
    type,
    ts,
    source: MODULE_SOURCE,
    data,
  });
}

/* -------------------------- Optional Hub Export ------------------------------ */

/**
 * Optional Hub export helper.
 * Only runs when featureFlags.familyFundMode is true.
 *
 * @param {{ householdId: string, domain: string, sessionId: string, artifactId: string, status: string, scheduledFor: string|null }} payload
 */
function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;

    const packet =
      typeof HubPacketFormatter?.format === "function"
        ? HubPacketFormatter.format("cooking.session.saved", payload)
        : payload; // conservative fallback

    if (!packet) return;

    if (typeof FamilyFundConnector?.send === "function") {
      FamilyFundConnector.send(packet);
    }
  } catch (err) {
    // Fail silently; Hub export must not break core SSA.
    if (typeof console !== "undefined") {
      console.warn("[RecipeSessionEngine] exportToHubIfEnabled failed", err);
    }
  }
}
