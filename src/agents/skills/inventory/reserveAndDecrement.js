/**
 * src/agents/skills/inventory/reserveAndDecrement.js
 *
 * How this fits:
 * - Used by SSA agents (cooking, cleaning, garden, animals, preservation) when
 *   a Session is about to run and needs to "lock in" inventory usage.
 *
 * - Pattern:
 *   1) reserveAndDecrement(instructions, ctx)  → decrements quantities in Dexie
 *      and returns a rollbackToken.
 *   2) If the session is aborted or fails before "point of no return",
 *      call rollbackDecrement(rollbackToken).
 *   3) If everything succeeded and you want analytics only, you can ignore
 *      the token or call finalizeReservation(...) to mark as completed.
 *
 * - This module does NOT try to be clever about partial concurrent updates.
 *   It uses a Dexie transaction and a simple compare-before-rollback check
 *   to avoid clobbering unrelated changes.
 *
 * - Events emitted:
 *   • inventory.reserve.requested
 *   • inventory.reserve.applied
 *   • inventory.reserve.failed
 *   • inventory.rollback.applied
 *   • inventory.rollback.failed
 *
 * Assumed inventory shape (minimal):
 * {
 *   id: string,
 *   name: string,
 *   quantity: number,
 *   unit?: string,
 *   sku?: string,
 *   domain?: "cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse",
 *   minThreshold?: number,
 *   updatedAt?: string
 * }
 *
 * Instruction shape:
 * {
 *   inventoryId?: string,  // preferred
 *   sku?: string,
 *   name?: string,         // last-resort fuzzy name
 *   qty: number,
 *   unit?: string,
 *   domain?: string,
 *   reason?: string,
 *   sessionId?: string
 * }
 */

import { emit } from "@/services/events/eventBus";
import InventoryLookup from "@/agents/skills/inventory/lookup";

/* ------------------------------- Soft DB load ------------------------------- */

let _dbPromise = null;

/**
 * Try to import your Dexie DB from a few common locations.
 * Adjust/add paths here to match your actual project.
 * @returns {Promise<any|null>}
 */
async function getDb() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    const candidates = ["@/services/db", "@/db", "@/data/db"];

    for (const path of candidates) {
      try {
        const mod = await import(/* @vite-ignore */ path);
        const db = mod?.default || mod?.db || mod;
        if (db && typeof db === "object") return db;
      } catch {
        // keep trying
      }
    }

    console.warn(
      "[inventory.reserveAndDecrement] Dexie DB not found; returning null"
    );
    return null;
  })();

  return _dbPromise;
}

/**
 * Try to get an inventory-like table from the DB.
 * Supports a few expected table names.
 * @returns {Promise<any|null>}
 */
async function getInventoryTable() {
  const db = await getDb();
  if (!db) return null;

  const candidates = [db.inventory, db.storehouse, db.storehouseItems];
  for (const t of candidates) {
    if (t && typeof t.where === "function") return t;
  }

  if (Array.isArray(db.tables)) {
    const inv = db.tables.find((t) =>
      /inventory|storehouse/i.test(t.name || "")
    );
    if (inv) return inv;
  }

  console.warn(
    "[inventory.reserveAndDecrement] No inventory-like table found on DB"
  );
  return null;
}

/* ------------------------------ Public API --------------------------------- */

/**
 * Reserve and decrement inventory quantities in a single transaction.
 *
 * - Validates availability for all instructions first.
 * - If any item is insufficient, NOTHING is decremented and a failure result
 *   is returned.
 * - If all pass, it decrements quantities and returns a rollbackToken.
 *
 * @param {Array<{
 *   inventoryId?: string,
 *   sku?: string,
 *   name?: string,
 *   qty: number,
 *   unit?: string,
 *   domain?: string,
 *   reason?: string,
 *   sessionId?: string
 * }>} instructions
 * @param {{ allowZero?: boolean }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   failures?: Array<{ instruction:any, cause:string }>,
 *   applied?: Array<{ id:string, beforeQty:number, afterQty:number }>,
 *   rollbackToken?: {
 *     id: string,
 *     ts: string,
 *     items: Array<{ id:string, beforeQty:number, afterQty:number }>,
 *     sessionId?: string,
 *     reason?: string
 *   }
 * }>}
 */
export async function reserveAndDecrement(instructions = [], options = {}) {
  const allowZero = options.allowZero === true;

  if (!Array.isArray(instructions) || !instructions.length) {
    return { ok: false, reason: "NO_INSTRUCTIONS" };
  }

  emitSafe("inventory.reserve.requested", {
    count: instructions.length,
  });

  const table = await getInventoryTable();
  if (!table) {
    return { ok: false, reason: "NO_DB" };
  }

  // 1) Resolve instructions → matched inventory items
  const resolved = await resolveInstructions(instructions);
  const failures = resolved
    .filter((r) => !r.item)
    .map((r) => ({
      instruction: r.instruction,
      cause: "NOT_FOUND",
    }));

  if (failures.length) {
    emitSafe("inventory.reserve.failed", {
      reason: "NOT_FOUND",
      failures,
    });
    return { ok: false, reason: "NOT_FOUND", failures };
  }

  // 2) Check availability for all items
  const insufficient = [];
  for (const { instruction, item } of resolved) {
    const need = Number(instruction.qty || 0);
    const have = Number(item.quantity || 0);

    if (!Number.isFinite(need) || need <= 0) {
      insufficient.push({ instruction, cause: "INVALID_QTY" });
      continue;
    }

    if (!allowZero && have <= 0) {
      insufficient.push({ instruction, cause: "ZERO_STOCK" });
      continue;
    }

    if (have < need) {
      insufficient.push({
        instruction,
        cause: "INSUFFICIENT_STOCK",
        have,
        need,
      });
    }
  }

  if (insufficient.length) {
    emitSafe("inventory.reserve.failed", {
      reason: "INSUFFICIENT_STOCK",
      failures: insufficient,
    });
    return { ok: false, reason: "INSUFFICIENT_STOCK", failures: insufficient };
  }

  // 3) Apply decrements in a Dexie transaction
  const db = await getDb();
  if (!db || typeof db.transaction !== "function") {
    return { ok: false, reason: "NO_DB_TRANSACTION" };
  }

  const applied = [];
  const now = new Date().toISOString();
  const rollbackId = randomId();
  const sessionId = instructions[0]?.sessionId || undefined;
  const reason = instructions[0]?.reason || undefined;

  try {
    await db.transaction("rw", table, async () => {
      for (const { instruction, item } of resolved) {
        const id = item.id;
        const need = Number(instruction.qty || 0);
        const beforeQty = Number(item.quantity || 0);
        const afterQty = beforeQty - need;

        await table.update(id, {
          quantity: afterQty,
          updatedAt: now,
        });

        applied.push({ id, beforeQty, afterQty });
      }
    });
  } catch (err) {
    console.warn("[inventory.reserveAndDecrement] transaction error:", err);
    emitSafe("inventory.reserve.failed", {
      reason: "TX_ERROR",
      error: String(err?.message || err),
    });
    return { ok: false, reason: "TX_ERROR" };
  }

  const rollbackToken = {
    id: rollbackId,
    ts: now,
    items: applied.map((c) => ({
      id: c.id,
      beforeQty: c.beforeQty,
      afterQty: c.afterQty,
    })),
    sessionId,
    reason,
  };

  emitSafe("inventory.reserve.applied", {
    tokenId: rollbackId,
    sessionId,
    count: applied.length,
  });

  return {
    ok: true,
    applied,
    rollbackToken,
  };
}

/**
 * Roll back a previous decrement using the rollbackToken returned from
 * reserveAndDecrement.
 *
 * - Safe by design: it will only reset quantities where the current quantity
 *   still matches the "afterQty" from the token, to avoid clobbering unrelated
 *   updates made after the reservation.
 *
 * - Returns counts of restored and skipped items.
 *
 * @param {{
 *   id:string,
 *   ts:string,
 *   items:Array<{ id:string, beforeQty:number, afterQty:number }>,
 *   sessionId?:string,
 *   reason?:string
 * }} token
 * @returns {Promise<{ ok:boolean, restored:number, skipped:number, reason?:string }>}
 */
export async function rollbackDecrement(token) {
  if (!token || !Array.isArray(token.items) || !token.items.length) {
    return { ok: false, restored: 0, skipped: 0, reason: "INVALID_TOKEN" };
  }

  const table = await getInventoryTable();
  const db = await getDb();
  if (!table || !db || typeof db.transaction !== "function") {
    return { ok: false, restored: 0, skipped: 0, reason: "NO_DB" };
  }

  let restored = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  try {
    await db.transaction("rw", table, async () => {
      const ids = token.items.map((x) => x.id);
      const current = await table.bulkGet(ids);
      const currentById = new Map();
      for (let i = 0; i < ids.length; i++) {
        if (current[i]) currentById.set(ids[i], current[i]);
      }

      for (const entry of token.items) {
        const row = currentById.get(entry.id);
        if (!row) {
          skipped++;
          continue;
        }

        const currentQty = Number(row.quantity || 0);

        // Only rollback if the quantity hasn't changed since reservation
        if (currentQty === Number(entry.afterQty)) {
          await table.update(entry.id, {
            quantity: entry.beforeQty,
            updatedAt: now,
          });
          restored++;
        } else {
          skipped++;
        }
      }
    });
  } catch (err) {
    console.warn("[inventory.reserveAndDecrement] rollback TX error:", err);
    emitSafe("inventory.rollback.failed", {
      tokenId: token.id,
      sessionId: token.sessionId,
      error: String(err?.message || err),
    });
    return { ok: false, restored, skipped, reason: "TX_ERROR" };
  }

  emitSafe("inventory.rollback.applied", {
    tokenId: token.id,
    sessionId: token.sessionId,
    restored,
    skipped,
  });

  return { ok: true, restored, skipped };
}

/**
 * Optional helper to emit analytics when a reservation is "finalized"
 * (e.g., cooking session completed successfully and you no longer intend
 * to roll back).
 *
 * This does not modify inventory. It only emits an event and can be used
 * by a future analytics or Hub export layer.
 *
 * @param {{
 *   id:string,
 *   ts:string,
 *   items:Array<{ id:string, beforeQty:number, afterQty:number }>,
 *   sessionId?:string,
 *   reason?:string
 * }} token
 */
export async function finalizeReservation(token) {
  if (!token || !Array.isArray(token.items)) return;
  emitSafe("inventory.reserve.finalized", {
    tokenId: token.id,
    sessionId: token.sessionId,
    count: token.items.length,
  });
}

/* -------------------------- Instruction resolution ------------------------- */

/**
 * Internal: resolve instructions → concrete inventory items using the inventory
 * lookup skill (by id, sku, then name).
 *
 * @param {Array<any>} instructions
 * @returns {Promise<Array<{ instruction:any, item:any|null }>>}
 */
async function resolveInstructions(instructions) {
  const out = [];
  for (const inst of instructions) {
    if (!inst || typeof inst !== "object") continue;

    let item = null;

    if (inst.inventoryId) {
      item = await InventoryLookup.lookupById(inst.inventoryId);
    }

    if (!item && inst.sku) {
      item = await InventoryLookup.lookupBySku(inst.sku);
    }

    if (!item && inst.name) {
      const matches = await InventoryLookup.lookupByName(inst.name, {
        domain: inst.domain,
        limit: 1,
      });
      item = matches[0] || null;
    }

    out.push({ instruction: inst, item: item || null });
  }
  return out;
}

/* --------------------------------- Events ---------------------------------- */

function emitSafe(type, data) {
  try {
    emit?.({
      type,
      ts: new Date().toISOString(),
      source: "inventory.reserveAndDecrement",
      data,
    });
  } catch {
    // ignore
  }
}

/* --------------------------------- Utils ----------------------------------- */

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

/* --------------------------------- Export ---------------------------------- */

export default {
  reserveAndDecrement,
  rollbackDecrement,
  finalizeReservation,
};
