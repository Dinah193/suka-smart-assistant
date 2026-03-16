// C:\Users\larho\suka-smart-assistant\src\services\SessionsRepo.js
//
// SessionsRepo
// ------------
// Central data-access layer for **Session** objects in SSA.
//
// Role in the pipeline
// --------------------
// imports → intelligence → automation → (optional) hub export
//
// • imports:
//   - Import routers and domain engines (Cooking/Garden/Animals/Cleaning/
//     Preservation) eventually create Session objects.
//   - They call SessionsRepo to persist and query those sessions.
//
// • intelligence:
//   - SessionEngines build normalized Session objects that follow the shared
//     contract; SessionsRepo does NOT invent steps or logic – it just stores,
//     retrieves, and updates them in Dexie.
//
// • automation:
//   - The automation runtime, SessionRunner, RelativeScheduler, and NBAToolbar
//     query SessionsRepo for pending/running/completed sessions.
//   - When SessionsRepo mutates a session (create/update/status change), it
//     emits events like `session.saved` and `session.status.changed` so other
//     modules can react.
//
// • optional hub export:
//   - Because sessions are first-class “household data,” this file also
//     optionally exports mutations to the Family Fund Hub via
//     HubPacketFormatter + FamilyFundConnector when `familyFundMode` is true.
//

import eventBus from "./events/eventBus";
import featureFlags from "@/config/featureFlags.json";
import HubPacketFormatter from "./hub/HubPacketFormatter";
import FamilyFundConnector from "./hub/FamilyFundConnector";
import db from "./db";

/**
 * @typedef {import("./session/contracts").Session} Session
 */

function nowIso() {
  return new Date().toISOString();
}

/**
 * Emit a structured event.
 *
 * @param {string} type
 * @param {any} data
 */
function emit(type, data) {
  if (!eventBus || typeof eventBus.emit !== "function") return;

  eventBus.emit({
    type,
    ts: nowIso(),
    source: "SessionsRepo",
    data,
  });
}

/**
 * Optional Hub export. Best effort, never throws outward.
 *
 * @param {Session} session
 * @param {string} reason    - e.g. "created" | "updated" | "status.changed" | "deleted"
 */
async function exportToHubIfEnabled(session, reason) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const formatter =
      typeof HubPacketFormatter.formatSession === "function"
        ? HubPacketFormatter.formatSession
        : HubPacketFormatter.format;

    const packet = formatter
      ? formatter("session", { session, reason })
      : { domain: "session", reason, session };

    const sender =
      typeof FamilyFundConnector.send === "function"
        ? FamilyFundConnector.send
        : typeof FamilyFundConnector.dispatch === "function"
        ? FamilyFundConnector.dispatch
        : null;

    if (!sender) return;

    await sender(packet);

    emit("session.exported", {
      id: session.id,
      domain: session.domain,
      reason,
    });
  } catch {
    // Swallow hub errors – SSA remains primary source of truth.
  }
}

/**
 * Defensive helper to ensure db.sessions exists.
 */
function requireSessionsStore() {
  if (!db || !db.sessions) {
    throw new Error(
      "[SessionsRepo] db.sessions store is not available. Check migrations and db setup."
    );
  }
}

/**
 * Upsert a session (create or update).
 *
 * NOTE: The SessionEngines are primarily responsible for building the
 * correct contract shape; this repository only persists it.
 *
 * @param {Session} session
 * @returns {Promise<Session>}
 */
export async function saveSession(session) {
  if (!session || typeof session !== "object") {
    throw new Error("[SessionsRepo] session object is required.");
  }
  if (!session.id) {
    throw new Error("[SessionsRepo] session.id is required.");
  }

  requireSessionsStore();

  const now = nowIso();
  const existing = await db.sessions.get(session.id);

  const toSave = {
    ...existing,
    ...session,
    updatedAt: now,
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
  };

  await db.sessions.put(toSave);

  emit("session.saved", {
    id: toSave.id,
    domain: toSave.domain,
    status: toSave.status,
    isNew: !existing,
  });

  // Also emit a more generic "updated" event for listeners that don't care
  // about new vs existing.
  emit("session.updated", {
    id: toSave.id,
    domain: toSave.domain,
    status: toSave.status,
  });

  void exportToHubIfEnabled(toSave, existing ? "updated" : "created");

  return toSave;
}

/**
 * Convenience alias for clarity.
 * @param {Session} session
 * @returns {Promise<Session>}
 */
export async function upsertSession(session) {
  return saveSession(session);
}

/**
 * Fetch a single session by id.
 *
 * @param {string} id
 * @returns {Promise<Session|null>}
 */
export async function getSessionById(id) {
  if (!id) return null;
  requireSessionsStore();
  return db.sessions.get(id);
}

/**
 * Delete a session by id.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteSession(id) {
  if (!id) return;
  requireSessionsStore();

  const existing = await db.sessions.get(id);
  await db.sessions.delete(id);

  emit("session.deleted", { id });

  if (existing) {
    void exportToHubIfEnabled(existing, "deleted");
  }
}

/**
 * List sessions with optional filters.
 *
 * @param {{ domain?: string, status?: string, from?: string|Date, to?: string|Date }} [filter]
 * @returns {Promise<Session[]>}
 */
export async function listSessions(filter = {}) {
  requireSessionsStore();

  let collection = db.sessions.toCollection();

  if (filter.domain) {
    const domain = filter.domain;
    collection = collection.filter((s) => s.domain === domain);
  }

  if (filter.status) {
    const status = filter.status;
    collection = collection.filter((s) => s.status === status);
  }

  if (filter.from || filter.to) {
    const fromMs = filter.from ? new Date(filter.from).getTime() : null;
    const toMs = filter.to ? new Date(filter.to).getTime() : null;

    collection = collection.filter((s) => {
      const createdMs = s && s.createdAt ? new Date(s.createdAt).getTime() : 0;
      if (Number.isNaN(createdMs)) return false;
      if (fromMs != null && createdMs < fromMs) return false;
      if (toMs != null && createdMs > toMs) return false;
      return true;
    });
  }

  return collection.toArray();
}

/**
 * List sessions that are `pending` for a domain (or all domains).
 *
 * @param {string} [domain]
 * @returns {Promise<Session[]>}
 */
export async function listPendingSessions(domain) {
  return listSessions({
    domain: domain || undefined,
    status: "pending",
  });
}

/**
 * List sessions currently `running` for a domain (or all domains).
 *
 * @param {string} [domain]
 * @returns {Promise<Session[]>}
 */
export async function listRunningSessions(domain) {
  return listSessions({
    domain: domain || undefined,
    status: "running",
  });
}

/**
 * Update only the status and progress fields of a session, with
 * automatic event emissions and optional hub export.
 *
 * @param {string} id
 * @param {{ status?: string, progress?: any }} patch
 * @returns {Promise<Session|null>}
 */
export async function updateSessionStatus(id, patch) {
  if (!id) throw new Error("[SessionsRepo] id is required.");
  if (!patch || typeof patch !== "object") {
    throw new Error("[SessionsRepo] patch object is required.");
  }

  requireSessionsStore();

  const current = await db.sessions.get(id);
  if (!current) return null;

  const prevStatus = current.status;
  const updated = {
    ...current,
    ...patch,
    progress: {
      ...(current.progress || {}),
      ...(patch.progress || {}),
    },
    updatedAt: nowIso(),
  };

  await db.sessions.put(updated);

  emit("session.updated", {
    id: updated.id,
    domain: updated.domain,
    status: updated.status,
  });

  if (prevStatus !== updated.status) {
    emit("session.status.changed", {
      id: updated.id,
      domain: updated.domain,
      from: prevStatus,
      to: updated.status,
    });

    // Mirror high-level lifecycle events for downstream analytics & automation.
    if (updated.status === "completed") {
      emit("session.completed", {
        id: updated.id,
        domain: updated.domain,
      });
    } else if (updated.status === "aborted") {
      emit("session.aborted", {
        id: updated.id,
        domain: updated.domain,
      });
    }
  }

  void exportToHubIfEnabled(updated, "status.changed");

  return updated;
}

/**
 * Clear all sessions — mainly for tests / dev tools.
 *
 * @returns {Promise<void>}
 */
export async function clearAllSessions() {
  requireSessionsStore();
  await db.sessions.clear();
  emit("session.store.cleared", {});
}

// Default export is a simple facade object for convenience.
const SessionsRepo = {
  saveSession,
  upsertSession,
  getSessionById,
  deleteSession,
  listSessions,
  listPendingSessions,
  listRunningSessions,
  updateSessionStatus,
  clearAllSessions,
};

export default SessionsRepo;
