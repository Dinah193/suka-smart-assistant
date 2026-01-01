// src/services/automation/events.map.js
// Canonical constants & helpers for SSA "play.*" events used by the automation runtime
// and overlays during active sessions.
//
// How this fits the pipeline:
// imports → intelligence → automation → (optional) hub export
// • These constants are consumed by controllers (Planner/Risk/Gatekeeper) and UI/overlays.
// • The helper emitters produce SSA-standard envelopes: { type, ts, source, data } (ISO ts).
// • When events imply household mutation (e.g., play.completed → meal.executed), we optionally
//   export to the Hub (SVFFH) if familyFundMode is enabled, while SSA remains the source of truth.
//
// Forward-thinking:
// • Single source of truth for play.* names to avoid drift between services.
// • `MUTATING_PLAY_TYPES` is explicit and easy to extend as new domains (preservation, animal)
//   or new actions arrive.
// • `emitPlay()` is defensive and idempotent in shape; safe to call from RTC/WS pathways.

let eventBus = {
  emit: (...a) => console.debug("[events.map:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch { /* optional: eventBus may not be wired in unit tests */ }

// Feature flags (familyFundMode gate)
let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags.json");
} catch { /* optional */ }

// Optional Hub export shims
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/integrations/HubPacketFormatter");
  FamilyFundConnector = require("@/integrations/FamilyFundConnector");
} catch { /* optional */ }

const SRC = "services.automation.events.map";

/* ------------------------- Canonical play.* constants ------------------------- */
// Session lifecycle
const PLAY_STARTED         = "play.started";
const PLAY_STEP_CHANGED    = "play.step.changed";
const PLAY_PAUSED          = "play.paused";
const PLAY_RESUMED         = "play.resumed";
const PLAY_COMPLETED       = "play.completed";
const PLAY_CANCELED        = "play.canceled";
const PLAY_FAILED          = "play.failed";
const PLAY_PLAN_UPDATED    = "play.plan.updated";     // replan during execution
const PLAY_SESSION_UPDATED = "play.session.updated";  // non-step field updates (notes, title, etc.)

// Timing / timers
const PLAY_TIMER_STARTED   = "play.timer.started";
const PLAY_TIMER_TICK      = "play.timer.tick";
const PLAY_TIMER_PAUSED    = "play.timer.paused";
const PLAY_TIMER_RESUMED   = "play.timer.resumed";
const PLAY_TIMER_COMPLETED = "play.timer.completed";

// Devices / resources
const PLAY_DEVICE_BUSY     = "play.device.busy";
const PLAY_DEVICE_RELEASED = "play.device.released";

// Risk / status
const PLAY_RISK_GREEN      = "play.risk.green";
const PLAY_RISK_AMBER      = "play.risk.amber";
const PLAY_RISK_RED        = "play.risk.red";

// Convenience collections
const ALL_PLAY_EVENTS = [
  PLAY_STARTED, PLAY_STEP_CHANGED, PLAY_PAUSED, PLAY_RESUMED,
  PLAY_COMPLETED, PLAY_CANCELED, PLAY_FAILED,
  PLAY_PLAN_UPDATED, PLAY_SESSION_UPDATED,
  PLAY_TIMER_STARTED, PLAY_TIMER_TICK, PLAY_TIMER_PAUSED, PLAY_TIMER_RESUMED, PLAY_TIMER_COMPLETED,
  PLAY_DEVICE_BUSY, PLAY_DEVICE_RELEASED,
  PLAY_RISK_GREEN, PLAY_RISK_AMBER, PLAY_RISK_RED,
];

const PLAY_EVENT_SET = new Set(ALL_PLAY_EVENTS);

// Events that imply **household mutation** (potential Hub export)
// - These typically correspond to session lifecycle transitions or plan mutations
//   that lead to inventory/storehouse updates (e.g., after meal execution).
const MUTATING_PLAY_TYPES = new Set([
  PLAY_STARTED,
  PLAY_STEP_CHANGED,     // step transitions may drive device usage & ingredient consumption timing
  PLAY_COMPLETED,        // often followed by meal.executed, preservation.completed, etc.
  PLAY_CANCELED,
  PLAY_FAILED,
  PLAY_PLAN_UPDATED,     // dynamic replan impacts schedule/consumption
  PLAY_SESSION_UPDATED,  // structural session field change during play
]);

/* --------------------------------- Helpers --------------------------------- */

/**
 * Check if a string is a canonical play.* event.
 * @param {string} type
 * @returns {boolean}
 */
function isPlayEvent(type) {
  return PLAY_EVENT_SET.has(String(type || ""));
}

/**
 * Build an SSA-standard envelope: { type, ts, source, data }
 * - Defensive: returns null if type invalid.
 * - Ensures ISO timestamp and immutable data clone.
 *
 * @param {string} type - one of play.* constants
 * @param {object} data - optional data payload (will be shallow-cloned)
 * @returns {object|null}
 */
function buildPlayEnvelope(type, data = {}) {
  if (!isPlayEvent(type)) return null;
  const payloadData = (data && typeof data === "object") ? { ...data } : (data ?? {});
  return { type, ts: nowIso(), source: SRC, data: payloadData };
}

/**
 * Emit a play.* event to the shared eventBus with proper envelope.
 * - If the event is in MUTATING_PLAY_TYPES, and familyFundMode is true, we also
 *   attempt a best-effort Hub export (silent on failure).
 *
 * @param {string} type - one of play.* constants
 * @param {object} data - payload (e.g., { roomId, sessionId, stepId, eta, ... })
 * @returns {boolean} true if emitted, false otherwise
 */
function emitPlay(type, data = {}) {
  const envelope = buildPlayEnvelope(type, data);
  if (!envelope) return false;

  try {
    eventBus.emit(envelope);
  } catch (err) {
    console.warn("[events.map] eventBus.emit failed", err);
    return false;
  }

  if (MUTATING_PLAY_TYPES.has(type)) {
    exportToHubIfEnabled({ via: "events.map", message: envelope });
  }
  return true;
}

/* ------------------------------- Internals -------------------------------- */

function nowIso() { return new Date().toISOString(); }

async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch (err) {
    // Hub is auxiliary; fail silently by design
    console.warn("[events.map] Hub export failed silently:", err?.message || err);
  }
}

/* --------------------------------- Exports -------------------------------- */
module.exports = {
  // Event constants
  PLAY_STARTED,
  PLAY_STEP_CHANGED,
  PLAY_PAUSED,
  PLAY_RESUMED,
  PLAY_COMPLETED,
  PLAY_CANCELED,
  PLAY_FAILED,
  PLAY_PLAN_UPDATED,
  PLAY_SESSION_UPDATED,
  PLAY_TIMER_STARTED,
  PLAY_TIMER_TICK,
  PLAY_TIMER_PAUSED,
  PLAY_TIMER_RESUMED,
  PLAY_TIMER_COMPLETED,
  PLAY_DEVICE_BUSY,
  PLAY_DEVICE_RELEASED,
  PLAY_RISK_GREEN,
  PLAY_RISK_AMBER,
  PLAY_RISK_RED,

  // Collections / guards
  ALL_PLAY_EVENTS,
  PLAY_EVENT_SET,
  MUTATING_PLAY_TYPES,
  isPlayEvent,

  // Envelope/emit helpers
  buildPlayEnvelope,
  emitPlay,

  // For tests
  __internals: {
    nowIso,
    exportToHubIfEnabled,
  },
};



// -----------------------------------------------------------------------------
// Import pipeline canonical events (L0→L3→Session)
// -----------------------------------------------------------------------------
export const IMPORT_CREATED = "import.created";
export const IMPORT_PARSED = "import.parsed";
export const IMPORT_MAPPED = "import.mapped";
export const BLUEPRINT_CREATED = "blueprint.created";
export const SESSION_CREATED_FROM_IMPORT = "session.created.fromImport";

export const IMPORT_EVENT_TYPES = Object.freeze([
  IMPORT_CREATED,
  IMPORT_PARSED,
  IMPORT_MAPPED,
  BLUEPRINT_CREATED,
  SESSION_CREATED_FROM_IMPORT,
]);

export function isImportEvent(type) {
  return IMPORT_EVENT_TYPES.includes(type);
}
