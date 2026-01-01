/**
 * src/agents/skills/storehouse/spoilageTracker.js
 *
 * How this fits:
 * - Runs over inventory to:
 *   • detect items that are expired or expiring soon,
 *   • optionally log spoilage events into a Dexie table,
 *   • generate "use now / preserve now" steps for sessions
 *     (cooking, preservation, or storehouse clean-up).
 *
 * Intended consumers:
 *   - Storehouse dashboard:
 *       • "Use Now" CTA → pulls expiringSoon items → builds a cooking/preservation session.
 *       • "Spoilage Report" → runs scan and shows expired items.
 *   - Automation runtime:
 *       • on regular interval, call scanForSpoilage and trigger suggestions.
 *
 * Events emitted:
 *   - storehouse.spoilage.scan.completed
 *   - storehouse.spoilage.scan.failed
 *   - storehouse.spoilage.logged
 *   - storehouse.spoilage.steps.prepared
 *
 * SessionRunner:
 *   - Steps returned by buildUseNowSteps() follow the generic step contract and can
 *     be wrapped into a "cooking", "preservation", or "storehouse" session.
 *   - The UI can present a swap/priority modal (e.g., reorder which items to use first)
 *     while the SessionRunner continues in the background, thanks to the app-wide
 *     modal root + wake-lock/notifications handled elsewhere.
 */

import { emit } from "@/services/eventBus";

/* -------------------------------------------------------------------------- */
/*                              Dexie DB soft import                          */
/* -------------------------------------------------------------------------- */

let _dbPromise = null;

/**
 * Try to import Dexie DB from common paths.
 * @returns {Promise<any|null>}
 */
async function getDb() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    const candidates = [
      "@/services/db",
      "@/db",
      "@/data/db",
    ];

    for (const path of candidates) {
      try {
        const mod = await import(/* @vite-ignore */ path);
        const db = mod?.default || mod?.db || mod;
        if (db && typeof db === "object") return db;
      } catch {
        // keep trying
      }
    }

    console.warn("[storehouse.spoilageTracker] Dexie DB not found; spoilage logging disabled.");
    return null;
  })();

  return _dbPromise;
}

/**
 * Try to locate the main inventory table.
 * We expect something like:
 *   - db.inventory
 *   - db.storehouseItems
 *   - or any table whose name matches /inventory|storehouse/i
 *
 * @returns {Promise<any|null>}
 */
async function getInventoryTable() {
  const db = await getDb();
  if (!db) return null;

  const candidates = [db.inventory, db.storehouseItems, db.items];
  for (const t of candidates) {
    if (t && typeof t.where === "function") return t;
  }

  if (Array.isArray(db.tables)) {
    const table = db.tables.find((t) =>
      /inventory|storehouse|items?/i.test(t.name || "")
    );
    if (table) return table;
  }

  console.warn("[storehouse.spoilageTracker] No inventory-like table found.");
  return null;
}

/**
 * Try to locate a spoilage events table.
 * Suggested schema (loose contract):
 *   {
 *     id: string,
 *     itemId: string|null,
 *     name: string,
 *     quantity: number|null,
 *     unit: string|null,
 *     expiryDate: string|null, // ISO
 *     detectedAt: string,      // ISO
 *     domain: string|null,
 *     location: string|null,
 *     reason: string,          // e.g. "EXPIRED", "DAMAGED", "OFF_ODOR"
 *     notes: string|null
 *   }
 *
 * @returns {Promise<any|null>}
 */
async function getSpoilageEventsTable() {
  const db = await getDb();
  if (!db) return null;

  const candidates = [db.spoilageEvents, db.storehouseSpoilage];
  for (const t of candidates) {
    if (t && typeof t.add === "function") return t;
  }

  if (Array.isArray(db.tables)) {
    const table = db.tables.find((t) =>
      /spoilage|waste|loss/i.test(t.name || "")
    );
    if (table && typeof table.add === "function") return table;
  }

  console.warn("[storehouse.spoilageTracker] No spoilage events table found; logging disabled.");
  return null;
}

/* -------------------------------------------------------------------------- */
/*                               Public API                                   */
/* -------------------------------------------------------------------------- */

/**
 * Scan inventory for items that are expired or expiring soon.
 *
 * @param {{
 *   domain?: string,
 *   location?: string,
 *   daysSoon?: number,      // default 7
 *   now?: Date|string,      // override "now" (for tests)
 *   includeNoExpiry?: boolean, // track items with no expiry separately
 *   limit?: number,         // max items to scan (default: all)
 * }} [options]
 *
 * @returns {Promise<{
 *   expired: any[],
 *   expiringSoon: any[],
 *   ok: any[],
 *   withoutExpiry: any[],
 *   scanned: number
 * }>}
 */
export async function scanForSpoilage(options = {}) {
  const {
    domain,
    location,
    daysSoon = 7,
    now = new Date(),
    includeNoExpiry = true,
    limit,
  } = options;

  const nowDate = typeof now === "string" ? new Date(now) : now;
  const invTable = await getInventoryTable();

  if (!invTable) {
    emitSafe("storehouse.spoilage.scan.failed", {
      reason: "NO_INVENTORY_TABLE",
    });
    return {
      expired: [],
      expiringSoon: [],
      ok: [],
      withoutExpiry: [],
      scanned: 0,
    };
  }

  let rows = [];
  try {
    if (domain || location) {
      // Simple filter by domain/location using Dexie .where if possible,
      // otherwise we fallback to .toArray() and filter in JS.
      if (domain && typeof invTable.where === "function") {
        rows = await invTable.where("domain").equals(domain).toArray();
      } else {
        rows = await invTable.toArray();
      }

      if (location) {
        rows = rows.filter((r) => (r.location || r.zone) === location);
      }
    } else {
      rows = await invTable.toArray();
    }

    if (typeof limit === "number" && limit > 0 && rows.length > limit) {
      rows = rows.slice(0, limit);
    }
  } catch (err) {
    console.warn("[storehouse.spoilageTracker] error reading inventory:", err);
    emitSafe("storehouse.spoilage.scan.failed", {
      reason: "DB_ERROR",
      error: String(err),
    });
    return {
      expired: [],
      expiringSoon: [],
      ok: [],
      withoutExpiry: [],
      scanned: 0,
    };
  }

  /** @type {any[]} */ const expired = [];
  /** @type {any[]} */ const expiringSoon = [];
  /** @type {any[]} */ const ok = [];
  /** @type {any[]} */ const withoutExpiry = [];

  for (const item of rows) {
    const expiry = getExpiryDate(item);
    if (!expiry) {
      if (includeNoExpiry) withoutExpiry.push(item);
      continue;
    }

    const daysUntil = diffInDays(expiry, nowDate);

    if (daysUntil < 0) {
      expired.push(item);
    } else if (daysUntil <= daysSoon) {
      expiringSoon.push(item);
    } else {
      ok.push(item);
    }
  }

  emitSafe("storehouse.spoilage.scan.completed", {
    scanned: rows.length,
    expired: expired.length,
    expiringSoon: expiringSoon.length,
    ok: ok.length,
    withoutExpiry: withoutExpiry.length,
    domain: domain || null,
    location: location || null,
  });

  return {
    expired,
    expiringSoon,
    ok,
    withoutExpiry,
    scanned: rows.length,
  };
}

/**
 * Log spoilage events for items you’ve decided are spoiled.
 * NOTE: This does NOT decrement inventory; that should be handled by a
 * separate mutation path (e.g., inventory.reserveAndDecrement).
 *
 * @param {any[]} items
 * @param {{
 *   reason?: string,     // "EXPIRED" | "DAMAGED" | "OFF_ODOR" | ...
 *   notes?: string,
 *   now?: Date|string
 * }} [options]
 * @returns {Promise<number>} number of successfully logged events
 */
export async function logSpoilageEvents(items = [], options = {}) {
  const { reason = "EXPIRED", notes, now = new Date() } = options;
  const nowIso = (typeof now === "string" ? new Date(now) : now).toISOString();

  const table = await getSpoilageEventsTable();
  if (!table) {
    // Logging disabled; still emit event for analytics.
    emitSafe("storehouse.spoilage.logged", {
      count: 0,
      reason,
      notes: notes || null,
      loggingEnabled: false,
    });
    return 0;
  }

  let count = 0;

  for (const item of items) {
    if (!item) continue;
    const expiryDate = getExpiryDate(item);
    const row = {
      id: makeId(),
      itemId: item.id || null,
      name: String(item.name || item.label || "Unknown item"),
      quantity: safeNumber(item.quantity ?? item.qty),
      unit: item.unit || null,
      expiryDate: expiryDate ? expiryDate.toISOString() : null,
      detectedAt: nowIso,
      domain: item.domain || null,
      location: item.location || item.zone || null,
      reason,
      notes: notes || null,
    };

    try {
      await table.add(row);
      count += 1;
    } catch (err) {
      console.warn("[storehouse.spoilageTracker] failed to log spoilage row:", err, row);
    }
  }

  emitSafe("storehouse.spoilage.logged", {
    count,
    reason,
    notes: notes || null,
    loggingEnabled: true,
  });

  return count;
}

/**
 * Build "use now / preserve now" steps for expiringSoon items.
 * These steps are compatible with the Session step contract and can
 * be plugged into a "cooking", "preservation", or "storehouse" session.
 *
 * @param {any[]} expiringItems
 * @param {{
 *   now?: Date|string,
 *   defaultDurationSec?: number,
 *   domainHint?: "cooking"|"preservation"|"storehouse",
 *   labelPrefix?: string,
 * }} [options]
 *
 * @returns {Array<{
 *   id: string,
 *   title: string,
 *   desc: string,
 *   durationSec: number,
 *   blockers: string[],
 *   metadata: {
 *     type: "useOrPreserve",
 *     domainHint: string|null,
 *     expiresInDays: number|null,
 *     expiryDate: string|null,
 *     itemId: string|null,
 *     quantity: number|null,
 *     unit: string|null,
 *     notes?: string|null
 *   }
 * }>}
 */
export function buildUseNowSteps(expiringItems = [], options = {}) {
  const {
    now = new Date(),
    defaultDurationSec = 300, // 5 minutes per "decision / action" step
    domainHint = "cooking",
    labelPrefix = "Use or preserve",
  } = options;

  const nowDate = typeof now === "string" ? new Date(now) : now;
  const steps = [];

  for (const item of expiringItems) {
    if (!item) continue;

    const expiry = getExpiryDate(item);
    const expiresInDays = expiry ? diffInDays(expiry, nowDate) : null;

    const name = item.name || item.label || "Item";
    const qty = item.quantity ?? item.qty ?? null;
    const unit = item.unit || null;

    const qtyLabel =
      qty != null ? `${qty}${unit ? " " + unit : ""}` : null;

    const expiryLabel = expiry
      ? `Expires in ${expiresInDays != null ? `${expiresInDays} day(s)` : "soon"} (on ${expiry.toLocaleDateString()}).`
      : "No expiry date recorded (treat as priority item).";

    const title = `${labelPrefix} ${name}`;
    const descParts = [
      qtyLabel ? `Amount: ${qtyLabel}.` : "",
      expiryLabel,
    ];

    const desc = descParts.filter(Boolean).join(" ");

    steps.push({
      id: makeId(),
      title,
      desc,
      durationSec: defaultDurationSec,
      blockers: ["inventory", "quietHours"], // e.g. may require kitchen time / noise
      metadata: {
        type: "useOrPreserve",
        domainHint: domainHint || null,
        expiresInDays,
        expiryDate: expiry ? expiry.toISOString() : null,
        itemId: item.id || null,
        quantity: safeNumber(qty),
        unit,
        notes: item.notes || null,
      },
    });
  }

  emitSafe("storehouse.spoilage.steps.prepared", {
    count: steps.length,
    domainHint: domainHint || null,
  });

  return steps;
}

/**
 * Convenience helper:
 * - Run scanForSpoilage,
 * - Return expiringSoon items and corresponding "use now" steps.
 *
 * @param {any} scanOptions
 * @param {any} stepOptions
 * @returns {Promise<{ expiringSoon:any[], steps:any[], scanResult:any }>}
 */
export async function scanAndBuildUseNow(scanOptions = {}, stepOptions = {}) {
  const scanResult = await scanForSpoilage(scanOptions);
  const steps = buildUseNowSteps(scanResult.expiringSoon, stepOptions);
  return {
    expiringSoon: scanResult.expiringSoon,
    steps,
    scanResult,
  };
}

/* -------------------------------------------------------------------------- */
/*                               Helpers                                      */
/* -------------------------------------------------------------------------- */

/**
 * Try to read an expiry date from an inventory item.
 *
 * Recognized fields (in order):
 *   - expiryDate
 *   - expiresAt
 *   - bestBy
 *   - bestBefore
 *   - useBy
 *   - spoilsAt
 *   - preserveUntil
 *
 * @param {any} item
 * @returns {Date|null}
 */
function getExpiryDate(item) {
  if (!item || typeof item !== "object") return null;
  const fields = [
    "expiryDate",
    "expiresAt",
    "bestBy",
    "bestBefore",
    "useBy",
    "spoilsAt",
    "preserveUntil",
  ];

  for (const key of fields) {
    const raw = item[key];
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

/**
 * Difference in whole days between dateB and dateA:
 *   diffInDays(expiry, now) = (expiry - now) / 1 day
 *
 * @param {Date} dateB
 * @param {Date} dateA
 * @returns {number}
 */
function diffInDays(dateB, dateA) {
  const msPerDay = 1000 * 60 * 60 * 24;
  const diff = dateB.getTime() - dateA.getTime();
  return Math.floor(diff / msPerDay);
}

/**
 * Simple ID generator, prefers crypto.randomUUID.
 * @returns {string}
 */
function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `spoilage_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* -------------------------------------------------------------------------- */
/*                               Events                                       */
/* -------------------------------------------------------------------------- */

function emitSafe(type, data) {
  try {
    emit?.({
      type,
      ts: new Date().toISOString(),
      source: "storehouse.spoilageTracker",
      data,
    });
  } catch {
    // ignore
  }
}

/* -------------------------------------------------------------------------- */
/*                               Default export                               */
/* -------------------------------------------------------------------------- */

export default {
  scanForSpoilage,
  logSpoilageEvents,
  buildUseNowSteps,
  scanAndBuildUseNow,
};
