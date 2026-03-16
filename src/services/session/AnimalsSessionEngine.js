// C:\Users\larho\suka-smart-assistant\src\services\session\AnimalsSessionEngine.js
//
// AnimalsSessionEngine
// --------------------
// High-level engine for creating **animal care** sessions in SSA.
//
// Role in the pipeline
// --------------------
// imports → intelligence → automation → (optional) hub export
//
// • imports:
//   - Feed schedules, milking routines, butchery plans, and how-to videos
//     are imported & normalized elsewhere.
//   - A UI (Animal Care tab / Homestead Planner) or automation runtime
//     passes an “animal plan” or “task pack” into this engine.
//
// • intelligence (THIS FILE):
//   - Converts an animal plan into a normalized Session object that follows
//     the shared session contract.
//   - Runs guards (inventory, quiet hours, sabbath, weather) and stores
//     their outputs on the session so automation & UI can surface
//     blockers (no feed, storm incoming, quiet hours, etc.).
//
// • automation:
//   - SessionRunner / RelativeScheduler execute these sessions in real time.
//   - Downstream runtime logic may emit events like `animals.fed`,
//     `animals.milked`, `animals.processed`, `inventory.updated`, etc.
//
// • optional hub export:
//   - Generated sessions are real household data; we emit a
//     `session.generated` event and, if `familyFundMode` is enabled,
//     export a compact payload to the Family Fund Hub.
//

import eventBus from "@services/events/eventBus";
import featureFlags from "@/config/featureFlags";
import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

// Dexie instance (adjust import path if your db helper lives elsewhere)
import db from "../db";

// Adapter & guards
import fromAnimalAdapter from "./adapters/fromAnimal";
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
 * Lightweight session id generator for animal sessions.
 * Example: "sess_animals_mbdv1q_1k2l3m"
 * @returns {string}
 */
function createSessionId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `sess_animals_${ts}_${rnd}`;
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
        `[AnimalsSessionEngine] Guard "${name}" failed; continuing without it`,
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
    source: "AnimalsSessionEngine",
    data,
  });
}

/**
 * Optional Hub export for a generated animals session.
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
      ? formatter("animals", session)
      : { domain: "animals", session };

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
 * Request shape used to generate an animal-care session.
 *
 * @typedef {Object} AnimalsSessionRequest
 * @property {string} [householdId]      - Optional household id, defaults to "primary".
 * @property {string} [title]            - Optional session title.
 * @property {string|Date} [windowStart] - Earliest time this session should run.
 * @property {string|Date} [windowEnd]   - Latest time this session should run.
 * @property {any} [plan]                - Animal plan / herd routine / draft object.
 * @property {any} [context]             - Extra context for adapter & guards
 *                                         (barn zones, herd names, species, etc.).
 */

/**
 * Generate an animal-care session from a high-level plan.
 *
 * This is what the Animal Care page’s “Generate Session” button should call.
 *
 * Steps:
 *  1. Validate request & normalize the time window.
 *  2. Use fromAnimalAdapter to derive steps & metadata.
 *  3. Apply the shared Session contract and animal-specific metadata.
 *  4. Run guards (inventory, quiet hours, sabbath, weather).
 *  5. Persist to Dexie.
 *  6. Emit events + optional Hub export.
 *
 * @param {AnimalsSessionRequest} req
 * @returns {Promise<Session>}
 */
export async function generateAnimalsSessionFromPlan(req) {
  if (!req || typeof req !== "object") {
    throw new Error("[AnimalsSessionEngine] Request object is required.");
  }

  const householdId = req.householdId || "primary";
  const windowStartIso = normalizeDateish(req.windowStart);
  const windowEndIso = normalizeDateish(req.windowEnd);

  if (!windowStartIso || !windowEndIso) {
    throw new Error(
      "[AnimalsSessionEngine] Both windowStart and windowEnd are required."
    );
  }

  emitEvent("session.generation.started", {
    domain: "animals",
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
  });

  // STEP 1: adapt the animal plan into a preliminary session skeleton.
  let adaptedSession;
  try {
    if (typeof fromAnimalAdapter !== "function") {
      throw new Error(
        "fromAnimal adapter is not a function. Ensure ./adapters/fromAnimal exports a default function."
      );
    }

    adaptedSession = await fromAnimalAdapter(req.plan || {}, {
      householdId,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      context: req.context || {},
    });
  } catch (err) {
    emitEvent("session.generation.error", {
      domain: "animals",
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
    domain: "animals",
    title:
      (adaptedSession && adaptedSession.title) ||
      req.title ||
      "Animal Care Session",
    source: (adaptedSession && adaptedSession.source) || {
      type: "animalTask",
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
    // Animal-specific metadata hooks:
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    herd: adaptedSession && adaptedSession.herd ? adaptedSession.herd : null, // e.g. "Dairy Goats", "Layer Hens"
    barnZones:
      adaptedSession && adaptedSession.barnZones
        ? adaptedSession.barnZones
        : null,
    speciesSummary:
      adaptedSession && adaptedSession.speciesSummary
        ? adaptedSession.speciesSummary
        : null, // e.g. { goats: 12, sheep: 8 }
    guards: {},
  };

  // Defensive: ensure at least one step exists so SessionRunner
  // always has something to display.
  if (!session.steps.length) {
    session.steps.push({
      id: `${session.id}-fallback`,
      title: "Review animal-care plan",
      desc: "No detailed animal-care tasks were generated. Review your plan and add feeding, watering, milking, grooming, and checks.",
      durationSec: 900,
      blockers: [],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: "Fallback step created by AnimalsSessionEngine.",
      },
    });
  }

  // STEP 3: run guards (inventory, quiet hours, sabbath, weather).
  const guardCtx = {
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    herd: session.herd,
    barnZones: session.barnZones,
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
          "[AnimalsSessionEngine] Failed to persist session to Dexie.",
          err
        );
      }
    }
  } else if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn(
      "[AnimalsSessionEngine] db.sessions is not available. Session will not be persisted."
    );
  }

  // STEP 5: emit event + optional hub export.
  emitEvent("session.generated", { session });
  void exportToHubIfEnabled(session);

  return session;
}

/**
 * Convenience alias with a shorter name.
 *
 * @param {AnimalsSessionRequest} req
 * @returns {Promise<Session>}
 */
export async function generateAnimalsSession(req) {
  return generateAnimalsSessionFromPlan(req);
}

export default {
  generateAnimalsSessionFromPlan,
  generateAnimalsSession,
};
