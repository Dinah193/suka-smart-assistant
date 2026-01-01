// C:\Users\larho\suka-smart-assistant\src\services\session\GardenSessionEngine.js
//
// GardenSessionEngine
// -------------------
// High-level engine for creating **garden** sessions in SSA.
//
// Role in the pipeline
// --------------------
// imports → intelligence → automation → (optional) hub export
//
// • imports:
//   - Seed catalogs, garden layouts, crop plans, and how-to videos are
//     scraped & normalized elsewhere.
//   - A UI (Homestead Planner / Garden tab) or automation runtime passes a
//     "garden plan" into this engine.
//
// • intelligence (THIS FILE):
//   - Converts a garden plan into a normalized Session object that follows
//     the shared session contract.
//   - Attaches guard results (inventory, quiet hours, sabbath, weather)
//     so automation & UI can respond to blockers.
//
// • automation:
//   - SessionRunner / RelativeScheduler execute these sessions in real time,
//     emitting events like `garden.harvest.logged` from runtime logic.
//
// • optional hub export:
//   - Generated sessions are real household data; we emit a
//     `session.generated` event and (optionally) send a compact payload
//     to the Family Fund Hub when `familyFundMode` is true.
//

import eventBus from "../eventBus";
import featureFlags from "../featureFlags";
import HubPacketFormatter from "../hub/HubPacketFormatter";
import FamilyFundConnector from "../hub/FamilyFundConnector";

// Dexie instance (adjust path if your db helper lives elsewhere)
import db from "../db";

// Adapter & guards
import fromGardenAdapter from "./adapters/fromGarden";
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
 * Lightweight session id generator for garden sessions.
 * Example: "sess_garden_mbdv1q_1k2l3m"
 * @returns {string}
 */
function createSessionId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `sess_garden_${ts}_${rnd}`;
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
        `[GardenSessionEngine] Guard "${name}" failed; continuing without it`,
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
    source: "GardenSessionEngine",
    data,
  });
}

/**
 * Optional Hub export for a generated garden session.
 *
 * Follows the standard pattern:
 *  1. checks featureFlags.familyFundMode
 *  2. uses HubPacketFormatter + FamilyFundConnector
 *  3. fails silently on error
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
      ? formatter("garden", session)
      : { domain: "garden", session };

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
 * Request shape used to generate a garden session.
 *
 * @typedef {Object} GardenSessionRequest
 * @property {string} [householdId]   - Optional household id, defaults to "primary".
 * @property {string} [title]         - Optional session title.
 * @property {string|Date} [windowStart] - Earliest time this session should run.
 * @property {string|Date} [windowEnd]   - Latest time this session should run.
 * @property {any} [plan]             - Garden plan / crop map / draft object.
 * @property {any} [context]          - Extra context for adapter & guards (season, zone, etc.).
 */

/**
 * Generate a garden session from a high-level plan.
 *
 * This is what the Garden / Homestead Planner "Generate Session" button
 * should call. It:
 *   • uses fromGardenAdapter to derive steps & metadata,
 *   • applies the shared Session contract,
 *   • runs guards (inventory, quietHours, sabbath, weather),
 *   • persists to Dexie,
 *   • emits events and optional Hub export.
 *
 * @param {GardenSessionRequest} req
 * @returns {Promise<Session>}
 */
export async function generateGardenSessionFromPlan(req) {
  if (!req || typeof req !== "object") {
    throw new Error("[GardenSessionEngine] Request object is required.");
  }

  const householdId = req.householdId || "primary";
  const windowStartIso = normalizeDateish(req.windowStart);
  const windowEndIso = normalizeDateish(req.windowEnd);

  if (!windowStartIso || !windowEndIso) {
    throw new Error(
      "[GardenSessionEngine] Both windowStart and windowEnd are required."
    );
  }

  emitEvent("session.generation.started", {
    domain: "garden",
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
  });

  // STEP 1: adapt the garden plan into a preliminary session skeleton.
  let adaptedSession;
  try {
    if (typeof fromGardenAdapter !== "function") {
      throw new Error(
        "fromGarden adapter is not a function. Ensure ./adapters/fromGarden exports a default function."
      );
    }

    adaptedSession = await fromGardenAdapter(req.plan || {}, {
      householdId,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      context: req.context || {},
    });
  } catch (err) {
    emitEvent("session.generation.error", {
      domain: "garden",
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
    domain: "garden",
    title:
      (adaptedSession && adaptedSession.title) || req.title || "Garden Session",
    source: (adaptedSession && adaptedSession.source) || {
      type: "gardenPlan",
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
    // Garden-specific metadata hooks:
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    season:
      adaptedSession && adaptedSession.season ? adaptedSession.season : null,
    zone: adaptedSession && adaptedSession.zone ? adaptedSession.zone : null,
    cropSummary:
      adaptedSession && adaptedSession.cropSummary
        ? adaptedSession.cropSummary
        : null,
    guards: {},
  };

  // Defensive: ensure at least one step exists so SessionRunner
  // always has something to show.
  if (!session.steps.length) {
    session.steps.push({
      id: `${session.id}-fallback`,
      title: "Review garden plan",
      desc: "No detailed garden tasks were generated. Review your plan and add tasks (bed prep, planting, watering, weeding).",
      durationSec: 900,
      blockers: [],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: "Fallback step created by GardenSessionEngine.",
      },
    });
  }

  // STEP 3: run guards (inventory, quiet hours, sabbath, weather).
  const guardCtx = {
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    season: session.season,
    zone: session.zone,
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
          "[GardenSessionEngine] Failed to persist session to Dexie.",
          err
        );
      }
    }
  } else if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn(
      "[GardenSessionEngine] db.sessions is not available. Session will not be persisted."
    );
  }

  // STEP 5: emit event + optional hub export.
  emitEvent("session.generated", { session });
  void exportToHubIfEnabled(session);

  return session;
}

/**
 * Convenience alias so callers can use the simpler name.
 *
 * @param {GardenSessionRequest} req
 * @returns {Promise<Session>}
 */
export async function generateGardenSession(req) {
  return generateGardenSessionFromPlan(req);
}

export default {
  generateGardenSessionFromPlan,
  generateGardenSession,
};
