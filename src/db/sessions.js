// src/db/sessions.js
/**
 * sessionsDb adapter
 *
 * WHY THIS EXISTS:
 * - Some shims import "@/db/sessions".
 * - Your actual Dexie instance lives under src/services/db.js (SSA convention).
 * - This adapter keeps shim imports stable without duplicating DB logic.
 *
 * EXPECTATION:
 * - src/services/db.js exports either:
 *    A) a default export "db", OR
 *    B) a named export { db }
 *
 * If your db export is different, adjust the import in this file only.
 */

import dbDefault, { db as dbNamed } from "@/services/db";

const db = dbNamed || dbDefault;

// Defensive check to fail loudly if db isn’t wired.
function assertSessionsTable() {
  if (!db)
    throw new Error(
      "[sessionsDb] Dexie db not found (check src/services/db.js exports)."
    );
  if (!db.sessions) {
    throw new Error(
      "[sessionsDb] db.sessions table not found. Ensure Dexie schema defines a 'sessions' table."
    );
  }
}

/**
 * Minimal Sessions table wrapper used by shims.
 * Keep API stable: upsert(), get(), remove(), listRecent()
 */
export const sessionsDb = {
  /**
   * Insert or update a session by id.
   * @param {Object} session
   */
  async upsert(session) {
    assertSessionsTable();
    if (!session || typeof session !== "object") {
      throw new Error("[sessionsDb.upsert] session must be an object");
    }
    if (!session.id) {
      throw new Error("[sessionsDb.upsert] session.id is required");
    }
    await db.sessions.put(session);
    return session;
  },

  /**
   * Get a session by id.
   * @param {string} id
   */
  async get(id) {
    assertSessionsTable();
    return db.sessions.get(id);
  },

  /**
   * Delete a session by id.
   * @param {string} id
   */
  async remove(id) {
    assertSessionsTable();
    await db.sessions.delete(id);
    return true;
  },

  /**
   * List most recent sessions (best-effort ordering).
   * If your table indexes differ, this still works via toArray() fallback.
   * @param {number} [limit=50]
   */
  async listRecent(limit = 50) {
    assertSessionsTable();

    // Prefer common timestamp fields if indexed
    const candidates = ["updatedAt", "ts", "createdAt", "startedAt"];

    for (const key of candidates) {
      try {
        // Dexie only allows orderBy on indexed props.
        const rows = await db.sessions
          .orderBy(key)
          .reverse()
          .limit(limit)
          .toArray();
        return rows;
      } catch {
        // ignore and try next
      }
    }

    // Fallback: no ordering guarantee
    const all = await db.sessions.toArray();
    return all.slice(-limit).reverse();
  },
};

export default sessionsDb;
