// C:\Users\larho\suka-smart-assistant\src\services\session\CleaningSessionEngine.js
//
// CleaningSessionEngine
// ---------------------
// High-level engine for creating **cleaning** sessions in SSA.
//
// Role in the pipeline
// --------------------
// imports → intelligence → automation → (optional) hub export
//
// • imports:
//   - Cleaning checklists, how-to articles, and room/zone templates are
//     scraped & normalized elsewhere.
//   - A UI (Cleaning tab / Homestead Planner) or automation runtime passes a
//     “cleaning plan” or “room pack” into this engine.
//
// • intelligence (THIS FILE):
//   - Converts a cleaning plan into a normalized Session object that follows
//     the shared session contract.
//   - Runs guards (inventory, quiet hours, sabbath, weather – for line
//     drying, outdoor work, etc.) and stores their results for the UI &
//     automation runtime.
//
// • automation:
//   - SessionRunner / RelativeScheduler execute these sessions in real time,
//     emitting events such as `cleaning.completed` and `inventory.updated`
//     (e.g., when consumables are used).
//
// • optional hub export:
//   - Generated sessions are real household data; we emit a
//     `session.generated` event and, if `familyFundMode` is enabled,
//     export a compact payload to the Family Fund Hub.
//

import eventBus from "../eventBus";
import featureFlags from "../featureFlags";
import HubPacketFormatter from "../hub/HubPacketFormatter";
import FamilyFundConnector from "../hub/FamilyFundConnector";

// Dexie instance (adjust import path if needed for your project)
import db from "../db";

// Adapter & guards
import fromCleaningAdapter from "./adapters/fromCleaning";
import * as inventoryGuard from "./guards/inventoryGuard";
import * as quietHoursGuard from "./guards/quietHoursGuard";
import * as sabbathGuard from "./guards/sabbathGuard";
import * as weatherGuard from "./guards/weatherGuard";

/**
 * @typedef {import("./contracts").Session} Session
 */

/**
 * @returns {string} ISO timestamp for "now".
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Lightweight session id generator for cleaning sessions.
 * Example: "sess_cleaning_mbdv1q_1k2l3m"
 * @returns {string}
 */
function createSessionId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `sess_cleaning_${ts}_${rnd}`;
}

/**
 * Normalize a dateish value to an ISO string.
 *
 * @param {string|Date|null|undefined} value
 * @returns {string|null}
 */
function normalizeDateish(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    if (value.includes("T")) return value;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  return null;
}

/**
 * Best-effort guard runner that tolerates missing exports / failures.
 *
 * @param {any} guardModule
 * @param {string} name
 * @param {Session} session
 * @param {object} ctx
 * @returns {Promise<any|null>}
 */
async function runGuard(guardModule, name, session, ctx) {
  if (!guardModule) return null;

  const candidate =
    typeof guardModule.run === "function"
      ? guardModule.run
      : typeof guardModule.default === "function"
      ? guardModule.default
      : null;

  if (!candidate) return null;

  try {
    return await candidate(session, ctx);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        `[CleaningSessionEngine] Guard "${name}" failed; continuing without it`,
        err
      );
    }
    return null;
  }
}

/**
 * Emit a structured event on the shared eventBus.
 *
 * @param {string} type
 * @param {any} data
 */
function emitEvent(type, data) {
  if (!eventBus || typeof eventBus.emit !== "function") return;
  eventBus.emit({
    type,
    ts: nowIso(),
    source: "CleaningSessionEngine",
    data,
  });
}

/**
 * Optional Hub export for a generated cleaning session.
 *
 * @param {Session} session
 */
async function exportToHubIfEnabled(session) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const formatter =
      typeof HubPacketFormatter.formatSession === "function"
        ? HubPacketFormatter.formatSession
        : HubPacketFormatter.format;

    const packet = formatter
      ? formatter("cleaning", session)
      : { domain: "cleaning", session };

    const sender =
      typeof FamilyFundConnector.send === "function"
        ? FamilyFundConnector.send
        : typeof FamilyFundConnector.dispatch === "function"
        ? FamilyFundConnector.dispatch
        : null;

    if (!sender) return;

    await sender(packet);

    emitEvent("session.exported", { id: session.id, domain: session.domain });
  } catch {
    // Best-effort only; never break generation on Hub issues.
  }
}

/**
 * Request shape used to generate a cleaning session.
 *
 * @typedef {Object} CleaningSessionRequest
 * @property {string} [householdId]     - Optional household id; defaults to "primary".
 * @property {string} [title]           - Optional session title.
 * @property {string|Date} [windowStart]- Earliest time this session should run.
 * @property {string|Date} [windowEnd]  - Latest time this session should run.
 * @property {any} [plan]               - Cleaning plan / room pack / draft object.
 * @property {any} [context]            - Extra context for adapter & guards (zones, pets, etc.).
 */

/**
 * Generate a cleaning session from a high-level plan.
 *
 * This is what the Cleaning page’s “Generate Session” button should call.
 *
 * Steps:
 *  1. Validate request & normalize time window.
 *  2. Use fromCleaningAdapter to derive steps & metadata.
 *  3. Apply the shared Session contract & cleaning-specific metadata.
 *  4. Run guards (inventory, quiet hours, sabbath, weather).
 *  5. Persist to Dexie.
 *  6. Emit events + optional Hub export.
 *
 * @param {CleaningSessionRequest} req
 * @returns {Promise<Session>}
 */
export async function generateCleaningSessionFromPlan(req) {
  if (!req || typeof req !== "object") {
    throw new Error("[CleaningSessionEngine] Request object is required.");
  }

  const householdId = req.householdId || "primary";
  const windowStartIso = normalizeDateish(req.windowStart);
  const windowEndIso = normalizeDateish(req.windowEnd);

  if (!windowStartIso || !windowEndIso) {
    throw new Error(
      "[CleaningSessionEngine] Both windowStart and windowEnd are required."
    );
  }

  emitEvent("session.generation.started", {
    domain: "cleaning",
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
  });

  // STEP 1: adapt the cleaning plan into a preliminary session skeleton.
  let adaptedSession;
  try {
    if (typeof fromCleaningAdapter !== "function") {
      throw new Error(
        "fromCleaning adapter is not a function. Ensure ./adapters/fromCleaning exports a default function."
      );
    }

    adaptedSession = await fromCleaningAdapter(req.plan || {}, {
      householdId,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      context: req.context || {},
    });
  } catch (err) {
    emitEvent("session.generation.error", {
      domain: "cleaning",
      error: String(err && err.message ? err.message : err),
    });
    throw err;
  }

  // STEP 2: apply contract defaults and build a full Session object.
  const createdAt = nowIso();
  /** @type {Session} */
  const session = {
    id:
      adaptedSession && adaptedSession.id
        ? adaptedSession.id
        : createSessionId(),
    domain: "cleaning",
    title:
      (adaptedSession && adaptedSession.title) ||
      req.title ||
      "Cleaning Session",
    source: (adaptedSession && adaptedSession.source) || {
      type: "cleaningPlan",
      refId: null,
    },
    steps: Array.isArray(adaptedSession && adaptedSession.steps)
      ? adaptedSession.steps
      : [],
    prefs: {
      voiceGuidance:
        adaptedSession && adaptedSession.prefs
          ? !!adaptedSession.prefs.voiceGuidance
          : true,
      haptic:
        adaptedSession && adaptedSession.prefs
          ? !!adaptedSession.prefs.haptic
          : true,
      autoAdvance:
        adaptedSession && adaptedSession.prefs
          ? !!adaptedSession.prefs.autoAdvance
          : false,
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: {
      skippedSteps: [],
      adjustments: [],
    },
    createdAt,
    updatedAt: createdAt,
    // Cleaning-specific metadata hooks:
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    zones: adaptedSession && adaptedSession.zones ? adaptedSession.zones : null, // e.g. ["Kitchen", "Living Room"]
    intensity:
      adaptedSession && adaptedSession.intensity
        ? adaptedSession.intensity
        : "standard", // "light" | "standard" | "deep"
    guards: {},
  };

  // Ensure at least one step exists so SessionRunner always has something
  // to display, even if the adapter failed to produce granular tasks.
  if (!session.steps.length) {
    session.steps.push({
      id: `${session.id}-fallback`,
      title: "Review cleaning plan",
      desc: "No detailed cleaning tasks were generated. Review your plan and add rooms/zones.",
      durationSec: 900,
      blockers: [],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: "Fallback step created by CleaningSessionEngine.",
      },
    });
  }

  // STEP 3: run guards (inventory, quiet hours, sabbath, weather).
  const guardCtx = {
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    zones: session.zones,
    intensity: session.intensity,
  };

  session.guards.inventory = await runGuard(
    inventoryGuard,
    "inventory",
    session,
    guardCtx
  );
  session.guards.quietHours = await runGuard(
    quietHoursGuard,
    "quietHours",
    session,
    guardCtx
  );
  session.guards.sabbath = await runGuard(
    sabbathGuard,
    "sabbath",
    session,
    guardCtx
  );
  session.guards.weather = await runGuard(
    weatherGuard,
    "weather",
    session,
    guardCtx
  );

  // STEP 4: persist to Dexie sessions store.
  if (db && db.sessions && typeof db.sessions.put === "function") {
    try {
      await db.sessions.put(session);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.error(
          "[CleaningSessionEngine] Failed to persist session to Dexie.",
          err
        );
      }
    }
  } else if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn(
      "[CleaningSessionEngine] db.sessions is not available. Session will not be persisted."
    );
  }

  // STEP 5: emit event + optional Hub export.
  emitEvent("session.generated", { session });
  void exportToHubIfEnabled(session);

  return session;
}

/**
 * Convenience alias with a slightly shorter name.
 *
 * @param {CleaningSessionRequest} req
 * @returns {Promise<Session>}
 */
export async function generateCleaningSession(req) {
  return generateCleaningSessionFromPlan(req);
}

export default {
  generateCleaningSessionFromPlan,
  generateCleaningSession,
};
