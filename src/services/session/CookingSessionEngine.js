// C:\Users\larho\suka-smart-assistant\src\services\session\CookingSessionEngine.js
//
// CookingSessionEngine
// --------------------
// High-level engine for creating **cooking** sessions in SSA.
//
// Role in the pipeline
// --------------------
// imports → intelligence → automation → (optional) hub export
//
// • imports:
//   - Recipes, meal plans, packs, etc. are imported & normalized elsewhere.
//   - A UI or automation layer passes a *draft* or *plan* into this engine.
//
// • intelligence (THIS FILE):
//   - Turns a cooking draft/plan into a normalized **Session object** that
//     follows the shared session contract.
//   - Applies guards (inventory, quiet hours, sabbath, weather) and stores
//     their findings on the session for the UI / automation runtime.
//
// • automation:
//   - SessionRunner + RelativeScheduler pick up these sessions by ID
//     and execute them in real time.
//
// • optional hub export:
//   - Because a generated session is **real household data**,
//     we emit a session.generated event and (optionally) export a
//     compact payload to the Family Fund Hub when `familyFundMode` is on.
//

import eventBus from "../events/eventBus";
// ✅ fixed: featureFlags live at src/config/featureFlags.json
import featureFlags from "@/config/featureFlags.json";
// ✅ fixed: hub modules live at src/services/hub/*
import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

// NOTE: adjust this import if your Dexie instance lives elsewhere
import db from "../db";

// Adapters & guards live in this folder, but we treat their API
// defensively so you can evolve them without breaking this engine.
import fromCookingAdapter from "./adapters/fromCooking";
import * as inventoryGuard from "./guards/inventoryGuard";
import * as quietHoursGuard from "./guards/quietHoursGuard";
import * as sabbathGuard from "./guards/sabbathGuard";
import * as weatherGuard from "./guards/weatherGuard";

/**
 * @typedef {import("./contracts").Session} Session
 * If you don't have a `contracts.js` with a Session typedef yet,
 * you can either add it or remove this line and let JSDoc be looser.
 */

/**
 * Return an ISO-8601 timestamp string for "now".
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Lightweight, dependency-free session id generator.
 * Example: "sess_mbdv1q_1k2l3m"
 * @returns {string}
 */
function createSessionId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `sess_${ts}_${rnd}`;
}

/**
 * Normalize a dateish value to ISO yyyy-mm-dd or full ISO if given.
 * @param {string|Date|null|undefined} value
 * @returns {string|null}
 */
function normalizeDateish(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    // If it already looks like an ISO string, keep it.
    if (value.includes("T")) return value;
    // Otherwise treat as yyyy-mm-dd (or browser-parsable) and convert.
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  return null;
}

/**
 * Best-effort runner for a guard module. We accept either:
 *   - exported function `run(session, ctx)`
 *   - default export `function(session, ctx)`
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
        `[CookingSessionEngine] Guard "${name}" failed; continuing without it`,
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
    source: "CookingSessionEngine",
    data,
  });
}

/**
 * Export a session to the Hub if familyFundMode is enabled.
 *
 * Follows the standard pattern:
 *   1. checks featureFlags.familyFundMode
 *   2. uses HubPacketFormatter + FamilyFundConnector
 *   3. fails silently if anything goes wrong
 *
 * @param {Session} session
 */
async function exportToHubIfEnabled(session) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    // Prefer modern formatter names if present, but keep backward compatibility.
    const formatter =
      typeof HubPacketFormatter.fromSessionSummary === "function"
        ? HubPacketFormatter.fromSessionSummary
        : typeof HubPacketFormatter.fromSessionResult === "function"
        ? HubPacketFormatter.fromSessionResult
        : typeof HubPacketFormatter.formatSession === "function"
        ? HubPacketFormatter.formatSession
        : typeof HubPacketFormatter.format === "function"
        ? HubPacketFormatter.format
        : null;

    // Minimal, hub-safe payload (avoid dumping full objects if formatter expects compact)
    const payload = {
      kind: "sessionGenerated",
      domain: "cooking",
      sessionId: session?.id || null,
      title: session?.title || null,
      createdAt: session?.createdAt || nowIso(),
      householdId: session?.householdId || null,
      windowStart: session?.windowStart || null,
      windowEnd: session?.windowEnd || null,
      steps: Array.isArray(session?.steps)
        ? session.steps.map((s) => ({
            id: s?.id,
            title: s?.title,
            durationSec: s?.durationSec,
            blockers: Array.isArray(s?.blockers) ? s.blockers : [],
          }))
        : [],
      meta: session?.guards ? { guards: session.guards } : {},
      source: "CookingSessionEngine",
    };

    const packet = formatter
      ? formatter(payload) // formatter decides final packet shape
      : payload;

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
    // Do not throw – Hub export is best-effort only.
  }
}

/**
 * Shape of the high-level request used by the UI / automation to generate a session.
 *
 * @typedef {Object} CookingSessionRequest
 * @property {string} [householdId]   - Optional household id; may default to "primary".
 * @property {string} [title]         - Optional session title.
 * @property {string|Date} [windowStart] - Earliest time this session should run.
 * @property {string|Date} [windowEnd]   - Latest time this session should run.
 * @property {any} [plan]             - Meal plan / recipe pack / draft object.
 * @property {any} [context]          - Extra context for the adapter (inventory, preferences, etc.).
 */

/**
 * Core: generate a cooking session from a high-level request.
 *
 * This is what your "Generate Session" button on the /cooking page
 * should call.
 *
 * Example:
 *   const session = await generateCookingSessionFromDraft({
 *     householdId: "primary",
 *     title: "Cooking Session",
 *     windowStart: "2025-12-05",
 *     windowEnd: "2025-12-12",
 *     plan: mealPlannerDraft,
 *     context: { tags: ["Balanced"] }
 *   });
 *
 * @param {CookingSessionRequest} req
 * @returns {Promise<Session>}
 */
export async function generateCookingSessionFromDraft(req) {
  if (!req || typeof req !== "object") {
    throw new Error("[CookingSessionEngine] Request object is required.");
  }

  const householdId = req.householdId || "primary";
  const windowStartIso = normalizeDateish(req.windowStart);
  const windowEndIso = normalizeDateish(req.windowEnd);

  if (!windowStartIso || !windowEndIso) {
    throw new Error(
      "[CookingSessionEngine] Both windowStart and windowEnd are required."
    );
  }

  // Emit a "generation started" telemetry event (no household data yet).
  emitEvent("session.generation.started", {
    domain: "cooking",
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
  });

  // STEP 1: Use the cooking adapter to convert the meal plan / draft
  //         into a preliminary session skeleton (steps, metadata, etc.).
  let adaptedSession;
  try {
    if (typeof fromCookingAdapter !== "function") {
      throw new Error(
        "fromCooking adapter is not a function. Ensure ./adapters/fromCooking exports a default function."
      );
    }

    adaptedSession = await fromCookingAdapter(req.plan || {}, {
      householdId,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      context: req.context || {},
    });
  } catch (err) {
    emitEvent("session.generation.error", {
      domain: "cooking",
      error: String(err && err.message ? err.message : err),
    });
    throw err;
  }

  // STEP 2: Apply contract defaults & generate a full Session object.
  const createdAt = nowIso();
  /** @type {Session} */
  const session = {
    id:
      adaptedSession && adaptedSession.id
        ? adaptedSession.id
        : createSessionId(),
    domain: "cooking",
    title:
      (adaptedSession && adaptedSession.title) ||
      req.title ||
      "Cooking Session",
    source: (adaptedSession && adaptedSession.source) || {
      type: "manual",
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
    // Non-contract but useful metadata for cooking:
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    // placeholder for guard results
    guards: {},
  };

  // Defensive: tolerate missing/invalid steps with a visible marker.
  if (!session.steps.length) {
    session.steps.push({
      id: `${session.id}-fallback`,
      title: "Review cooking plan",
      desc: "No detailed steps were generated. Review your plan and add steps.",
      durationSec: 300,
      blockers: [],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: "Fallback step created by CookingSessionEngine.",
      },
    });
  }

  // STEP 3: Run guards (inventory / quiet hours / sabbath / weather).
  // We store the outputs on `session.guards` so the UI and automation
  // runtime can react appropriately (warnings, blockers, etc.).
  const guardCtx = {
    householdId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    // additional context can be added later (location, weather source, etc.)
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

  // STEP 4: Persist to Dexie (sessions store).
  if (db && db.sessions && typeof db.sessions.put === "function") {
    try {
      await db.sessions.put(session);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.error(
          "[CookingSessionEngine] Failed to persist session to Dexie.",
          err
        );
      }
      // We still return the in-memory session so UI is not blocked.
    }
  } else if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn(
      "[CookingSessionEngine] db.sessions is not available. Session will not be persisted."
    );
  }

  // STEP 5: Emit event + optional Hub export.
  emitEvent("session.generated", { session });
  void exportToHubIfEnabled(session);

  return session;
}

/**
 * Convenience alias for callers that don't care about the "draft" wording.
 *
 * @param {CookingSessionRequest} req
 * @returns {Promise<Session>}
 */
export async function generateCookingSession(req) {
  return generateCookingSessionFromDraft(req);
}

export default {
  generateCookingSessionFromDraft,
  generateCookingSession,
};
