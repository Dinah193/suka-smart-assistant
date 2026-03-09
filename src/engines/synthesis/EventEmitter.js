/**
 * @file C:\Users\larho\suka-smart-assistant\src\engines\synthesis\EventEmitter.js
 *
 * Synthesis EventEmitter — small façade around the shared eventBus to ensure
 * all synthesis-related events are emitted with a consistent envelope and
 * optional Hub export for household mutations.
 *
 * PIPELINE FIT
 * imports → normalize → intelligence → synthesis → validator/dedup/lead-time
 * → **EventEmitter (this file)** → automation runtime → (optional) hub export
 *
 * WHY THIS EXISTS
 * - Guarantees the event payload shape: { type, ts, source, data }
 * - Namespaces synthesis events and documents their semantics
 * - Adds guardrails: input validation, size caps, best-effort (never throw)
 * - Calls exportToHubIfEnabled() when the event represents a **household mutation**
 *   (e.g., sessions committed / status changed).
 */

import { emit as emitEventBus } from "@/services/events/eventBus";

const SOURCE = "engines.synthesis.EventEmitter";

// ───────────────────────────────────────────────────────────────────────────────
// Event catalogue (add new ones here as the engine grows)

export const EventTypes = Object.freeze({
  // Synthesis lifecycle
  PREP_SYNTHESIZED: "prep.synthesized",
  SYNTHESIS_COMPLETED: "synthesis.completed",
  SYNTHESIS_ERROR: "synthesis.error",

  // Rule / lead-time / dedup / preference signals
  RULES_LOADED: "synthesis.rules.loaded",
  LEADTIME_COMPLETED: "synthesis.leadtime.completed",
  DEDUP_COMPLETED: "synthesis.dedup.completed",
  PREFS_RESOLVED: "prefs.resolved",

  // Validation & sessions
  VALIDATION_COVERAGE: "synthesis.validation.coverage",
  SESSION_VALIDATION_FAILED: "session.validation.failed",
  SESSION_VALIDATION_PASSED: "session.validation.passed",
  SESSION_BUILD_COMPLETE: "session.build.complete", // status change → hub export candidate
  SESSIONS_COMMITTED: "sessions.committed", // status change → hub export candidate
});

// Household-mutation events (trigger optional hub export).
const MUTATION_TYPES = new Set([
  EventTypes.SESSION_BUILD_COMPLETE,
  EventTypes.SESSIONS_COMMITTED,
]);

// ───────────────────────────────────────────────────────────────────────────────
// Public, typed helpers

/**
 * Fire when readiness steps & session suggestions are produced.
 * @param {{ planId?: string, stepsCount: number, sessionsCount: number, diagnostics?: any[] }} data
 */
export async function emitPrepSynthesized(data) {
  return emit(EventTypes.PREP_SYNTHESIZED, sanitize(data));
}

/**
 * Fire granular coverage metrics during validation.
 * @param {{ planId?: string, score: number, missingCount?: number }} data
 */
export async function emitValidationCoverage(data) {
  return emit(EventTypes.VALIDATION_COVERAGE, sanitize(data));
}

/**
 * Fire when validation fails hard (<100%).
 * @param {{ planId?: string, coverage: any, blockers: string[], suggestions?: string[] }} data
 */
export async function emitSessionValidationFailed(data) {
  return emit(EventTypes.SESSION_VALIDATION_FAILED, sanitize(data));
}

/**
 * Fire when validation passes (100%).
 * @param {{ planId?: string, count?: number }} data
 */
export async function emitSessionValidationPassed(data) {
  return emit(EventTypes.SESSION_VALIDATION_PASSED, sanitize(data));
}

/**
 * Fire after sessions have been committed (persisted) by the synthesis stack.
 * This is a household data mutation and may be exported to the Family Fund Hub.
 * @param {{ planId?: string, sessions: any[] }} data
 */
export async function emitSessionsCommitted(data) {
  const payload = await emit(EventTypes.SESSIONS_COMMITTED, sanitize(data));
  await exportToHubIfEnabled(payload);
  return payload;
}

/**
 * Fire after session build is marked complete/ready (status mutation).
 * @param {{ planId?: string, count?: number }} data
 */
export async function emitSessionBuildComplete(data) {
  const payload = await emit(EventTypes.SESSION_BUILD_COMPLETE, sanitize(data));
  await exportToHubIfEnabled(payload);
  return payload;
}

/**
 * Fire when rules are loaded or changed (useful for hot-reload / diagnostics).
 * @param {{ version: string, domains: string[], ruleCount: number }} data
 */
export async function emitRulesLoaded(data) {
  return emit(EventTypes.RULES_LOADED, sanitize(data));
}

/**
 * Fire after lead-time pass completes (summary only; detailed events handled upstream).
 * @param {{ total: number, avgAdjustmentPct?: number }} data
 */
export async function emitLeadtimeCompleted(data) {
  return emit(EventTypes.LEADTIME_COMPLETED, sanitize(data));
}

/**
 * Fire after deduplication finishes.
 * @param {{ steps: number, sessions: number, merges: number }} data
 */
export async function emitDedupCompleted(data) {
  return emit(EventTypes.DEDUP_COMPLETED, sanitize(data));
}

/**
 * Generic emitter (advanced): use typed helpers above whenever possible.
 * @param {string} type
 * @param {object} data
 */
export async function emitEvent(type, data) {
  const payload = await emit(String(type || "").trim(), sanitize(data));
  if (MUTATION_TYPES.has(type)) await exportToHubIfEnabled(payload);
  return payload;
}

// ───────────────────────────────────────────────────────────────────────────────
// Core emit implementation

/**
 * Internal emit that guarantees shape, timestamps, and safety.
 * @param {string} type
 * @param {any} data
 * @returns {Promise<{ type:string, ts:string, source:string, data:any }>}
 */
async function emit(type, data) {
  const evt = makeEnvelope(type, data);
  if (!evt) return null;

  try {
    eventBus.emit("automation.event", evt);
  } catch {
    // Never throw from telemetry
  }
  return evt;
}

function makeEnvelope(type, data) {
  if (!type || typeof type !== "string") return null;
  const clean = capKeys(capSize(safeClone(data), 100_000), 128); // ~100KB cap, 128 keys per level
  return {
    type,
    ts: new Date().toISOString(),
    source: SOURCE,
    data: clean,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Optional Hub export (best-effort, silent on failures)

async function exportToHubIfEnabled(payload) {
  try {
    if (!payload || !MUTATION_TYPES.has(payload.type)) return;

    const flagsMod = await softImport("src/config/featureFlags.json");
    const featureFlags = flagsMod?.default || flagsMod || {};
    if (!featureFlags.familyFundMode) return;

    const Formatter = await softImport(
      "src/services/hub/HubPacketFormatter.js"
    );
    const Connector = await softImport(
      "src/services/hub/FamilyFundConnector.js"
    );
    if (!Formatter || !Connector) return;

    const format =
      Formatter.format || (Formatter.default && Formatter.default.format);
    const send =
      Connector.send || (Connector.default && Connector.default.send);

    if (typeof format !== "function" || typeof send !== "function") return;

    const packet = await format(payload);
    if (!packet) return;

    await send(packet); // swallow errors
  } catch {
    // Intentional no-op
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Tiny util belt (defensive sanitizers)

function sanitize(obj) {
  // remove undefined, keep nulls; shallow by default
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function safeClone(v) {
  try {
    if (!v || typeof v !== "object") return v;
    return JSON.parse(JSON.stringify(v));
  } catch {
    return { note: "non-serializable payload" };
  }
}

function capSize(v, maxBytes) {
  try {
    const s = JSON.stringify(v);
    if (s.length <= maxBytes) return v;
    return {
      truncated: true,
      approxBytes: s.length,
      note: "payload too large",
    };
  } catch {
    return v;
  }
}

function capKeys(v, maxKeys) {
  if (!v || typeof v !== "object") return v;
  const keys = Object.keys(v);
  if (keys.length <= maxKeys) return v;
  const out = {};
  for (let i = 0; i < maxKeys; i += 1) out[keys[i]] = v[keys[i]];
  out.__truncatedKeys = keys.length - maxKeys;
  return out;
}

async function softImport(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.default || mod;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Default export

export default {
  EventTypes,
  emitEvent,
  emitPrepSynthesized,
  emitValidationCoverage,
  emitSessionValidationFailed,
  emitSessionValidationPassed,
  emitSessionsCommitted,
  emitSessionBuildComplete,
  emitRulesLoaded,
  emitLeadtimeCompleted,
  emitDedupCompleted,
};
