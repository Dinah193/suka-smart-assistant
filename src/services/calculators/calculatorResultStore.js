// C:\Users\larho\suka-smart-assistant\src\services\calculators\calculatorResultStore.js

/**
 * Calculator Result Store
 *
 * How this fits:
 * - Central helper for persisting calculator runs so you can:
 *   • Pre-fill forms with last-used values.
 *   • Feed results into the Planning Graph and dashboards.
 *   • Rebuild Sessions later from stored calculator output.
 *
 * Storage strategy:
 * - Prefers Dexie (via your shared db instance).
 * - Falls back to an in-memory Map for environments where Dexie
 *   isn't available yet (safe for unit tests / early wiring).
 *
 * Suggested Dexie store (configure in your db setup file):
 *
 *   db.version(N).stores({
 *     calculatorResults: "id, calculatorId, createdAt, updatedAt",
 *     // ...other stores
 *   });
 *
 * Record shape (normalized):
 *
 *   {
 *     id: string;              // "calcRes-<timestamp>-<rand>"
 *     calculatorId: string;    // registry ID (e.g. "health.macro")
 *     input: any;              // calculator input payload
 *     result: any;             // calculator output payload
 *     context?: { ... };       // CalculatorRunContext (userId, householdId, etc.)
 *     tags?: string[];         // free-form tags (e.g. ["seed-viability", "spring-planting"])
 *     label?: string;          // optional human label (e.g. "Spring 2026 seed plan")
 *     meta?: { [k: string]: any }; // extra metadata
 *     createdAt: string;       // ISO
 *     updatedAt: string;       // ISO
 *   }
 */

import eventBus from "@/services/eventBus";

// Defensive Dexie import – if your db is located elsewhere,
// update this path once and keep the rest of this file intact.
let db = null;
try {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const maybeDb = require("@/services/db").default || require("@/services/db");
  db = maybeDb || null;
} catch (_) {
  // Swallow; we'll fall back to in-memory storage.
}

// In-memory fallback store (non-persistent, useful for testing/wiring).
/** @type {Map<string, any>} */
const memoryStore = new Map();

/** ------------------------------------------------------------------------
 *  Public API
 * --------------------------------------------------------------------- */

/**
 * Save a calculator result.
 *
 * - Generates an ID if none is provided.
 * - Writes to Dexie when available, otherwise to an in-memory Map.
 * - Emits `calculator.result.saved` event on success.
 *
 * @param {string} calculatorId
 * @param {{
 *   input: any,
 *   result: any,
 *   context?: import("./calculatorRunner").CalculatorRunContext,
 *   tags?: string[],
 *   label?: string,
 *   meta?: Record<string, any>,
 *   id?: string,
 * }} payload
 * @returns {Promise<StoredCalculatorResult>}
 */
export async function saveCalculatorResult(calculatorId, payload) {
  if (!calculatorId || typeof calculatorId !== "string") {
    throw new Error("[calculatorResultStore] calculatorId is required");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("[calculatorResultStore] payload is required");
  }

  const nowIso = new Date().toISOString();
  const id = payload.id || makeResultId(calculatorId);

  /** @type {StoredCalculatorResult} */
  const record = {
    id,
    calculatorId,
    input:
      "input" in payload
        ? payload.input
        : null,
    result:
      "result" in payload
        ? payload.result
        : null,
    context: payload.context || undefined,
    tags: Array.isArray(payload.tags) ? payload.tags.slice(0) : undefined,
    label:
      typeof payload.label === "string" && payload.label.trim()
        ? payload.label.trim()
        : undefined,
    meta: payload.meta && typeof payload.meta === "object" ? payload.meta : undefined,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (db && db.calculatorResults) {
    await db.calculatorResults.put(record);
  } else {
    memoryStore.set(record.id, record);
  }

  emitResultSaved(record);

  return record;
}

/**
 * Load a calculator result by ID.
 *
 * @param {string} id
 * @returns {Promise<StoredCalculatorResult|null>}
 */
export async function getCalculatorResult(id) {
  if (!id || typeof id !== "string") return null;

  if (db && db.calculatorResults) {
    const record = await db.calculatorResults.get(id);
    return record || null;
  }

  return memoryStore.get(id) || null;
}

/**
 * List calculator results, optionally filtered by calculatorId or tags.
 *
 * @param {{
 *   calculatorId?: string,
 *   tag?: string,
 *   limit?: number,
 *   sortDirection?: "asc"|"desc",
 * }} [opts]
 * @returns {Promise<StoredCalculatorResult[]>}
 */
export async function listCalculatorResults(opts = {}) {
  const { calculatorId, tag, limit, sortDirection = "desc" } = opts;
  const max =
    typeof limit === "number" && limit > 0 ? limit : undefined;

  /** @type {StoredCalculatorResult[]} */
  let records = [];

  if (db && db.calculatorResults) {
    if (calculatorId) {
      records = await db.calculatorResults
        .where("calculatorId")
        .equals(calculatorId)
        .toArray();
    } else {
      records = await db.calculatorResults.toArray();
    }
  } else {
    memoryStore.forEach((value) => {
      if (calculatorId && value.calculatorId !== calculatorId) return;
      records.push(value);
    });
  }

  if (tag) {
    records = records.filter((r) => Array.isArray(r.tags) && r.tags.includes(tag));
  }

  records.sort((a, b) => {
    const aTs = a.updatedAt || a.createdAt || "";
    const bTs = b.updatedAt || b.createdAt || "";
    if (sortDirection === "asc") {
      return aTs.localeCompare(bTs);
    }
    return bTs.localeCompare(aTs);
  });

  if (max) {
    records = records.slice(0, max);
  }

  return records;
}

/**
 * Delete a calculator result by ID.
 *
 * - Emits `calculator.result.deleted` event if the record existed.
 *
 * @param {string} id
 * @returns {Promise<boolean>} true if a record was deleted
 */
export async function deleteCalculatorResult(id) {
  if (!id || typeof id !== "string") return false;

  let existed = false;
  let record = null;

  if (db && db.calculatorResults) {
    record = await db.calculatorResults.get(id);
    existed = !!record;
    if (existed) {
      await db.calculatorResults.delete(id);
    }
  } else {
    record = memoryStore.get(id) || null;
    existed = memoryStore.delete(id);
  }

  if (existed && record) {
    emitResultDeleted(record);
  }

  return existed;
}

/**
 * Clear all stored results for a given calculator.
 *
 * - Emits `calculator.result.clearedForCalculator` event.
 *
 * @param {string} calculatorId
 * @returns {Promise<number>} number of deleted records
 */
export async function clearCalculatorResultsForCalculator(calculatorId) {
  if (!calculatorId || typeof calculatorId !== "string") return 0;

  let deletedCount = 0;

  if (db && db.calculatorResults) {
    const records = await db.calculatorResults
      .where("calculatorId")
      .equals(calculatorId)
      .toArray();

    deletedCount = records.length;

    if (deletedCount > 0) {
      const ids = records.map((r) => r.id);
      await db.calculatorResults.bulkDelete(ids);
    }
  } else {
    const toDelete = [];
    memoryStore.forEach((value, key) => {
      if (value.calculatorId === calculatorId) {
        toDelete.push(key);
      }
    });
    toDelete.forEach((key) => memoryStore.delete(key));
    deletedCount = toDelete.length;
  }

  emitResultsClearedForCalculator(calculatorId, deletedCount);

  return deletedCount;
}

/**
 * Convenience helper: get the most recent stored result for a calculator.
 *
 * Useful for “resume last plan” or “reapply last settings” flows.
 *
 * @param {string} calculatorId
 * @returns {Promise<StoredCalculatorResult|null>}
 */
export async function getMostRecentCalculatorResult(calculatorId) {
  if (!calculatorId || typeof calculatorId !== "string") return null;

  const list = await listCalculatorResults({
    calculatorId,
    limit: 1,
    sortDirection: "desc",
  });

  return list[0] || null;
}

/** ------------------------------------------------------------------------
 *  Event helpers
 * --------------------------------------------------------------------- */

/**
 * @param {StoredCalculatorResult} record
 */
function emitResultSaved(record) {
  safeEmitEvent({
    type: "calculator.result.saved",
    ts: new Date().toISOString(),
    source: "calculator.resultStore",
    data: {
      id: record.id,
      calculatorId: record.calculatorId,
      tags: record.tags,
      label: record.label,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  });
}

/**
 * @param {StoredCalculatorResult} record
 */
function emitResultDeleted(record) {
  safeEmitEvent({
    type: "calculator.result.deleted",
    ts: new Date().toISOString(),
    source: "calculator.resultStore",
    data: {
      id: record.id,
      calculatorId: record.calculatorId,
    },
  });
}

/**
 * @param {string} calculatorId
 * @param {number} deletedCount
 */
function emitResultsClearedForCalculator(calculatorId, deletedCount) {
  safeEmitEvent({
    type: "calculator.result.clearedForCalculator",
    ts: new Date().toISOString(),
    source: "calculator.resultStore",
    data: {
      calculatorId,
      deletedCount,
    },
  });
}

/**
 * @param {{ type: string, ts: string, source: string, data?: any }} payload
 */
function safeEmitEvent(payload) {
  try {
    if (!payload || !payload.type) return;
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(payload);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[calculatorResultStore] safeEmitEvent failed", payload, err);
  }
}

/** ------------------------------------------------------------------------
 *  Utils & types
 * --------------------------------------------------------------------- */

/**
 * Make a reasonably unique ID for a calculator result.
 *
 * @param {string} calculatorId
 * @returns {string}
 */
function makeResultId(calculatorId) {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e9)
    .toString(36)
    .padStart(5, "0");
  const safeId = calculatorId.replace(/[^a-zA-Z0-9]+/g, "-");
  return `calcRes-${safeId}-${ts}-${rand}`;
}

/**
 * @typedef {Object} StoredCalculatorResult
 * @property {string} id
 * @property {string} calculatorId
 * @property {any} input
 * @property {any} result
 * @property {import("./calculatorRunner").CalculatorRunContext} [context]
 * @property {string[]} [tags]
 * @property {string} [label]
 * @property {Record<string, any>} [meta]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export default {
  saveCalculatorResult,
  getCalculatorResult,
  listCalculatorResults,
  deleteCalculatorResult,
  clearCalculatorResultsForCalculator,
  getMostRecentCalculatorResult,
};
