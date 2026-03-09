// File: C:\Users\larho\suka-smart-assistant\src\services\gardening\HarvestSessionService.js
/**
 * HarvestSessionService
 * -----------------------------------------------------------------------------
 * SSA Gardening — Harvest Sessions (offline-first, Dexie-backed, event-driven)
 *
 * Purpose
 *  - Record harvest events (what was harvested, how much, where it went)
 *  - Optionally sync harvest into:
 *      • Inventory / Storehouse (inventory items + quantities + locations)
 *      • Calendar / Schedule (log entry, task completions)
 *      • Savings / Value tracking (optional, depends on your modules)
 *
 * Design constraints
 *  - Browser-safe (no Node imports)
 *  - Works even if some tables/services are missing (soft integration)
 *  - Emits eventBus events for UI + automations
 *  - Uses logger (best-effort) + DashboardLog (best-effort)
 *
 * Expected (soft) DB tables
 *  - harvest_sessions      (optional)  // session record + summary
 *  - harvest_entries       (optional)  // line-items per session
 *  - garden_harvest_log    (optional)  // legacy/fallback log table
 *
 * If tables are missing, this service still functions in memory and via
 * "calendar + dashboard" logging, but persistence requires at least one table.
 */

import db from "@/services/db";
import logger, { createLogger } from "@/utils/logger";

/* -----------------------------------------------------------------------------
 * Optional dependencies (soft; never crash builds)
 * -------------------------------------------------------------------------- */

let eventBus = null;
try {
  const mod = await import("@/services/events/eventBus");
  eventBus = mod?.default ?? mod ?? null;
} catch {
  eventBus = null;
}

let DashboardLog = null;
try {
  const mod = await import("@/services/dashboard/DashboardLog.js");
  DashboardLog = mod?.default ?? mod ?? null;
} catch {
  DashboardLog = null;
}

let CalendarManager = null;
try {
  const mod = await import("@/services/calendar/CalendarManager");
  CalendarManager = mod?.default ?? mod ?? null;
} catch {
  CalendarManager = null;
}

// Inventory sync (optional)
let InventorySessionService = null;
try {
  const mod = await import("@/services/inventory/InventorySessionService");
  InventorySessionService = mod?.default ?? mod ?? null;
} catch {
  InventorySessionService = null;
}

// Some projects put inventory helpers here
let InventoryMutations = null;
try {
  const mod = await import("@/services/inventory/InventoryMutations");
  InventoryMutations = mod?.default ?? mod ?? null;
} catch {
  InventoryMutations = null;
}

// Savings sync (optional)
let SavingsService = null;
try {
  const mod = await import("@/services/savings/SavingsService");
  SavingsService = mod?.default ?? mod ?? null;
} catch {
  SavingsService = null;
}

/* -----------------------------------------------------------------------------
 * Local logger
 * -------------------------------------------------------------------------- */

const log = createLogger("services.gardening.HarvestSessionService");

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

const SOURCE = "gardening.HarvestSessionService";

function nowMs() {
  return Date.now();
}

function safeObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function clamp(n, a, b) {
  const v = Number(n);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}

function asNumber(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function normalizeUnit(u) {
  const s = String(u || "")
    .trim()
    .toLowerCase();
  if (!s) return "count";
  // normalize a few common
  if (s === "lb" || s === "lbs") return "lb";
  if (s === "pound" || s === "pounds") return "lb";
  if (s === "kg" || s === "kilogram" || s === "kilograms") return "kg";
  if (s === "g" || s === "gram" || s === "grams") return "g";
  if (s === "oz" || s === "ounce" || s === "ounces") return "oz";
  if (s === "ct" || s === "count") return "count";
  if (s === "bunch" || s === "bunches") return "bunch";
  return s;
}

function genId(prefix = "harvest") {
  return `${prefix}_${nowMs().toString(16)}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
}

function bestEffortToISO(d) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    if (!Number.isFinite(dt.getTime())) return new Date().toISOString();
    return dt.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/* -----------------------------------------------------------------------------
 * DB table resolution
 * -------------------------------------------------------------------------- */

const TABLE_CANDIDATES = {
  sessions: [
    "harvest_sessions",
    "harvestSessions",
    "garden_harvest_sessions",
    "gardenHarvestSessions",
  ],
  entries: [
    "harvest_entries",
    "harvestEntries",
    "garden_harvest_entries",
    "gardenHarvestEntries",
  ],
  log: ["garden_harvest_log", "gardenHarvestLog", "harvest_log", "harvestLog"],
};

function resolveTable(type) {
  const candidates = TABLE_CANDIDATES[type] || [type];
  for (const name of candidates) {
    const t = db?.[name];
    if (t && typeof t.put === "function" && typeof t.get === "function")
      return t;
  }
  try {
    const tables = db?.tables || [];
    for (const t of tables) {
      const n = String(t?.name || "").toLowerCase();
      if (candidates.some((c) => n === String(c).toLowerCase())) return t;
    }
    // fuzzy fallback
    const pattern =
      type === "sessions"
        ? /harvest.*session/i
        : type === "entries"
        ? /harvest.*(entry|line)/i
        : /harvest.*log/i;

    return tables.find((t) => pattern.test(String(t?.name || ""))) || null;
  } catch {
    return null;
  }
}

async function dbPut(table, row) {
  try {
    await table.put(row);
    return true;
  } catch {
    return false;
  }
}

async function dbBulkPut(table, rows) {
  try {
    if (!rows?.length) return true;
    if (typeof table.bulkPut === "function") {
      await table.bulkPut(rows);
      return true;
    }
    // fallback loop
    for (const r of rows) await table.put(r);
    return true;
  } catch {
    return false;
  }
}

async function dbGet(table, key) {
  try {
    return await table.get(key);
  } catch {
    return null;
  }
}

async function dbDelete(table, key) {
  try {
    await table.delete(key);
    return true;
  } catch {
    return false;
  }
}

async function dbQueryBy(table, field, value) {
  try {
    if (!table) return [];
    if (typeof table.where === "function") {
      return await table.where(field).equals(value).toArray();
    }
    // no indexed query available
    const all = await table.toArray();
    return all.filter((r) => r?.[field] === value);
  } catch {
    return [];
  }
}

/* -----------------------------------------------------------------------------
 * Core normalization
 * -------------------------------------------------------------------------- */

/**
 * A harvest session is a container with multiple entries:
 *  - entries are the harvested items/quantities (line items)
 */
function normalizeSessionInput(input) {
  const s = safeObject(input);

  const sessionId = s.sessionId || s.id || genId("harvestSession");
  const householdId = s.householdId || null;
  const gardenId = s.gardenId || null;

  const startedAt = s.startedAt
    ? bestEffortToISO(s.startedAt)
    : bestEffortToISO(new Date());
  const endedAt = s.endedAt ? bestEffortToISO(s.endedAt) : null;

  const createdAt = s.createdAt ? asNumber(s.createdAt, nowMs()) : nowMs();
  const updatedAt = nowMs();

  const notes = s.notes ? String(s.notes) : null;

  const meta = safeObject(s.meta);

  return {
    id: sessionId,
    sessionId,
    householdId,
    gardenId,
    startedAt,
    endedAt,
    status: s.status || "draft", // draft|completed|void
    notes,
    meta,
    createdAt,
    updatedAt,
  };
}

function normalizeEntryInput(entry, session) {
  const e = safeObject(entry);
  const s = safeObject(session);

  const entryId = e.entryId || e.id || genId("harvestEntry");

  const cropId = e.cropId || e.plantId || null;
  const cropName = e.cropName || e.name || e.label || null;

  const quantity = asNumber(e.quantity, 0);
  const unit = normalizeUnit(e.unit || "count");

  const bedId = e.bedId || e.plotId || null;
  const location = e.location || e.storageLocation || null; // where the harvest went
  const grade = e.grade || null; // A/B/C etc
  const condition = e.condition || null; // ripe, green, damaged

  const harvestedAt = e.harvestedAt
    ? bestEffortToISO(e.harvestedAt)
    : s.startedAt;

  const meta = safeObject(e.meta);

  return {
    id: entryId,
    entryId,
    sessionId: s.sessionId || s.id,
    householdId: s.householdId || null,
    gardenId: s.gardenId || null,

    cropId,
    cropName,

    quantity: clamp(quantity, 0, 1e9),
    unit,

    bedId,
    location,
    grade,
    condition,

    harvestedAt,

    // mapping to inventory (optional)
    inventoryItemId: e.inventoryItemId || null,
    inventorySku: e.inventorySku || null,
    inventoryName: e.inventoryName || cropName || null,

    // value (optional)
    estimatedValue: Number.isFinite(Number(e.estimatedValue))
      ? Number(e.estimatedValue)
      : null,
    currency: e.currency ? String(e.currency) : null,

    meta,
    createdAt: e.createdAt ? asNumber(e.createdAt, nowMs()) : nowMs(),
    updatedAt: nowMs(),
  };
}

/* -----------------------------------------------------------------------------
 * Inventory sync helpers (optional)
 * -------------------------------------------------------------------------- */

async function syncEntryToInventory(entry, options = {}) {
  const e = safeObject(entry);
  const o = safeObject(options);

  if (o.inventorySync === false)
    return { ok: true, skipped: true, reason: "disabled" };

  // If no inventory service exists, we skip gracefully.
  if (!InventorySessionService && !InventoryMutations) {
    return { ok: true, skipped: true, reason: "no_inventory_service" };
  }

  // Build a normalized "inventory add" intent.
  const qty = asNumber(e.quantity, 0);
  if (qty <= 0) return { ok: true, skipped: true, reason: "zero_quantity" };

  const payload = {
    householdId: e.householdId || o.householdId || null,
    source: "garden.harvest",
    sourceRef: { sessionId: e.sessionId, entryId: e.entryId },
    // Item identity
    itemId: e.inventoryItemId || null,
    sku: e.inventorySku || null,
    name: e.inventoryName || e.cropName || "Harvest Item",
    // Quantity
    quantity: qty,
    unit: e.unit || "count",
    // Location
    location: e.location || o.defaultLocation || null,
    // Meta
    meta: {
      cropId: e.cropId || null,
      bedId: e.bedId || null,
      harvestedAt: e.harvestedAt || null,
      grade: e.grade || null,
      condition: e.condition || null,
      ...safeObject(e.meta),
    },
  };

  // Try common method signatures:
  try {
    if (InventorySessionService?.addStock) {
      const res = await InventorySessionService.addStock(payload);
      return {
        ok: true,
        method: "InventorySessionService.addStock",
        result: res,
      };
    }
  } catch (err) {
    return {
      ok: false,
      method: "InventorySessionService.addStock",
      error: String(err?.message || err),
    };
  }

  try {
    if (InventorySessionService?.upsertStock) {
      const res = await InventorySessionService.upsertStock(payload);
      return {
        ok: true,
        method: "InventorySessionService.upsertStock",
        result: res,
      };
    }
  } catch (err) {
    return {
      ok: false,
      method: "InventorySessionService.upsertStock",
      error: String(err?.message || err),
    };
  }

  try {
    if (InventoryMutations?.commitAdd) {
      const res = await InventoryMutations.commitAdd(payload);
      return { ok: true, method: "InventoryMutations.commitAdd", result: res };
    }
  } catch (err) {
    return {
      ok: false,
      method: "InventoryMutations.commitAdd",
      error: String(err?.message || err),
    };
  }

  // If nothing matched, we skip (no hard fail).
  return { ok: true, skipped: true, reason: "no_compatible_inventory_method" };
}

/* -----------------------------------------------------------------------------
 * Calendar + Dashboard logging (optional)
 * -------------------------------------------------------------------------- */

async function logToCalendar(session, entries, options = {}) {
  const s = safeObject(session);
  const o = safeObject(options);
  if (o.calendarLog === false) return { ok: true, skipped: true };

  if (!CalendarManager?.logEvent)
    return { ok: true, skipped: true, reason: "no_calendar_manager" };

  try {
    const title = `Harvest: ${safeArray(entries)
      .map((e) => e.cropName || e.inventoryName)
      .filter(Boolean)
      .slice(0, 3)
      .join(", ")}${entries.length > 3 ? "…" : ""}`;

    const totalLine = summarizeTotals(entries);

    const notes = [
      `Session: ${s.sessionId || s.id}`,
      totalLine ? `Totals: ${totalLine}` : null,
      s.notes ? `Notes: ${s.notes}` : null,
    ]
      .filter(Boolean)
      .join(" • ");

    const res = await CalendarManager.logEvent({
      title,
      start: s.startedAt,
      end: s.endedAt || null,
      category: "garden.harvest",
      notes,
      meta: {
        sessionId: s.sessionId || s.id,
        householdId: s.householdId || null,
      },
    });

    return { ok: true, result: res };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function logToDashboard(session, entries, options = {}) {
  const s = safeObject(session);
  const o = safeObject(options);
  if (o.dashboardLog === false) return { ok: true, skipped: true };

  if (!DashboardLog)
    return { ok: true, skipped: true, reason: "no_dashboard_log" };

  try {
    const totals = summarizeTotals(entries);
    const msg = totals
      ? `Harvest logged — ${totals}`
      : `Harvest logged — ${entries.length} item${
          entries.length === 1 ? "" : "s"
        }`;

    if (typeof DashboardLog.log === "function") {
      await DashboardLog.log({
        category: "Garden",
        icon: "🌿",
        message: msg,
        time: new Date(s.startedAt || Date.now()),
        meta: { sessionId: s.sessionId || s.id, entriesCount: entries.length },
      });
    } else if (typeof DashboardLog.info === "function") {
      await DashboardLog.info(msg, {
        sessionId: s.sessionId || s.id,
        entriesCount: entries.length,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/* -----------------------------------------------------------------------------
 * Savings sync (optional)
 * -------------------------------------------------------------------------- */

async function syncToSavings(session, entries, options = {}) {
  const s = safeObject(session);
  const o = safeObject(options);
  if (o.savingsSync === false) return { ok: true, skipped: true };

  if (!SavingsService?.recordHarvestValue)
    return { ok: true, skipped: true, reason: "no_savings_service" };

  try {
    const total = safeArray(entries).reduce(
      (sum, e) => sum + (Number(e.estimatedValue) || 0),
      0
    );
    if (!total) return { ok: true, skipped: true, reason: "no_value" };

    const res = await SavingsService.recordHarvestValue({
      householdId: s.householdId || null,
      sessionId: s.sessionId || s.id,
      totalValue: total,
      currency: entries.find((e) => e.currency)?.currency || "USD",
      atISO: s.startedAt,
      meta: { entriesCount: entries.length },
    });

    return { ok: true, result: res };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/* -----------------------------------------------------------------------------
 * Summaries
 * -------------------------------------------------------------------------- */

function summarizeTotals(entries) {
  const rows = safeArray(entries);
  if (!rows.length) return null;

  // group by unit for a compact summary
  const byUnit = {};
  for (const e of rows) {
    const u = normalizeUnit(e.unit || "count");
    byUnit[u] = (byUnit[u] || 0) + asNumber(e.quantity, 0);
  }

  const parts = Object.keys(byUnit)
    .sort()
    .map((u) => `${Math.round(byUnit[u] * 1000) / 1000} ${u}`);

  return parts.join(", ");
}

/* -----------------------------------------------------------------------------
 * Service API
 * -------------------------------------------------------------------------- */

const HarvestSessionService = {
  /**
   * Create a new harvest session (draft) and optionally persist it.
   * @param {object} sessionInput
   * @param {object} [options]
   * @param {boolean} [options.persist=true]
   */
  async createSession(sessionInput, options = {}) {
    const o = safeObject(options);
    const persist = o.persist !== false;

    const session = normalizeSessionInput(sessionInput);

    const tSessions = resolveTable("sessions");
    const tLog = resolveTable("log");

    let stored = false;

    if (persist && tSessions) {
      stored = await dbPut(tSessions, session);
    } else if (persist && tLog) {
      // store a minimal session marker in a log table
      stored = await dbPut(tLog, {
        id: session.sessionId,
        type: "harvest.session",
        ...pick(session, [
          "sessionId",
          "householdId",
          "gardenId",
          "startedAt",
          "endedAt",
          "status",
          "notes",
          "meta",
        ]),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    }

    emit("garden.harvest.session.created", {
      sessionId: session.sessionId,
      stored,
    });
    log.info(
      "Harvest session created",
      { sessionId: session.sessionId, stored },
      { source: SOURCE }
    );

    return { session, stored };
  },

  /**
   * Add entries to a harvest session (draft or completed).
   * @param {string} sessionId
   * @param {array} entriesInput
   * @param {object} [options]
   * @param {boolean} [options.persist=true]
   */
  async addEntries(sessionId, entriesInput, options = {}) {
    const o = safeObject(options);
    const persist = o.persist !== false;

    if (!sessionId) throw new Error("addEntries requires sessionId");

    // Load session if possible; otherwise create a minimal container
    const tSessions = resolveTable("sessions");
    let session = null;
    if (tSessions) session = await dbGet(tSessions, sessionId);

    if (!session) {
      session = normalizeSessionInput({
        sessionId,
        status: "draft",
        startedAt: bestEffortToISO(new Date()),
      });
    }

    const entries = safeArray(entriesInput).map((e) =>
      normalizeEntryInput(e, session)
    );

    const tEntries = resolveTable("entries");
    const tLog = resolveTable("log");

    let stored = false;

    if (persist && tEntries) {
      stored = await dbBulkPut(tEntries, entries);
    } else if (persist && tLog) {
      // fallback: append each entry as log record
      const rows = entries.map((e) => ({
        id: e.entryId,
        type: "harvest.entry",
        sessionId: e.sessionId,
        householdId: e.householdId,
        gardenId: e.gardenId,
        cropId: e.cropId,
        cropName: e.cropName,
        quantity: e.quantity,
        unit: e.unit,
        bedId: e.bedId,
        location: e.location,
        harvestedAt: e.harvestedAt,
        inventoryItemId: e.inventoryItemId,
        inventorySku: e.inventorySku,
        inventoryName: e.inventoryName,
        estimatedValue: e.estimatedValue,
        currency: e.currency,
        meta: e.meta,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      }));
      stored = await dbBulkPut(tLog, rows);
    }

    // Update session updatedAt
    if (persist && tSessions) {
      await dbPut(tSessions, { ...session, updatedAt: nowMs() });
    }

    emit("garden.harvest.entries.added", {
      sessionId,
      entriesCount: entries.length,
      stored,
    });
    log.info(
      "Harvest entries added",
      { sessionId, entriesCount: entries.length, stored },
      { source: SOURCE }
    );

    return { session, entries, stored };
  },

  /**
   * Complete a harvest session:
   *  - persist session status completed
   *  - optional inventory sync
   *  - optional calendar + dashboard logging
   *
   * @param {string} sessionId
   * @param {object} [options]
   * @param {boolean} [options.inventorySync=true]
   * @param {boolean} [options.calendarLog=true]
   * @param {boolean} [options.dashboardLog=true]
   * @param {boolean} [options.savingsSync=false]
   * @param {string}  [options.defaultLocation]
   */
  async completeSession(sessionId, options = {}) {
    const o = safeObject(options);
    if (!sessionId) throw new Error("completeSession requires sessionId");

    const tSessions = resolveTable("sessions");
    const tEntries = resolveTable("entries");
    const tLog = resolveTable("log");

    let session = null;
    if (tSessions) session = await dbGet(tSessions, sessionId);
    if (!session && tLog) {
      // try log table as a session marker
      const maybe = await dbGet(tLog, sessionId);
      if (maybe?.type === "harvest.session")
        session = normalizeSessionInput(maybe);
    }
    if (!session) {
      // If session is missing, still allow completion based on entries
      session = normalizeSessionInput({
        sessionId,
        status: "draft",
        startedAt: bestEffortToISO(new Date()),
      });
    }

    let entries = [];
    if (tEntries) {
      entries = await dbQueryBy(tEntries, "sessionId", sessionId);
    } else if (tLog) {
      const all = await tLog.toArray().catch(() => []);
      entries = all.filter(
        (r) => r?.type === "harvest.entry" && r?.sessionId === sessionId
      );
    }

    // Mark completed
    const completed = {
      ...session,
      status: "completed",
      endedAt: session.endedAt || bestEffortToISO(new Date()),
      updatedAt: nowMs(),
    };

    let stored = false;
    if (tSessions) {
      stored = await dbPut(tSessions, completed);
    } else if (tLog) {
      stored = await dbPut(tLog, {
        id: completed.sessionId,
        type: "harvest.session",
        ...pick(completed, [
          "sessionId",
          "householdId",
          "gardenId",
          "startedAt",
          "endedAt",
          "status",
          "notes",
          "meta",
        ]),
        createdAt: completed.createdAt,
        updatedAt: completed.updatedAt,
      });
    }

    // Inventory sync (best-effort)
    const inventoryResults = [];
    if (o.inventorySync !== false) {
      for (const e of entries) {
        const res = await syncEntryToInventory(e, {
          inventorySync: true,
          householdId: completed.householdId,
          defaultLocation: o.defaultLocation,
        });
        inventoryResults.push({ entryId: e.entryId, ...res });
      }
    }

    // Calendar / dashboard / savings
    const calRes = await logToCalendar(completed, entries, {
      calendarLog: o.calendarLog !== false,
    });
    const dashRes = await logToDashboard(completed, entries, {
      dashboardLog: o.dashboardLog !== false,
    });
    const savingsRes = await syncToSavings(completed, entries, {
      savingsSync: !!o.savingsSync,
    });

    emit("garden.harvest.session.completed", {
      sessionId,
      stored,
      entriesCount: entries.length,
      inventorySync: o.inventorySync !== false,
    });

    log.info(
      "Harvest session completed",
      {
        sessionId,
        stored,
        entriesCount: entries.length,
        inventorySynced: inventoryResults.filter((r) => r.ok && !r.skipped)
          .length,
      },
      { source: SOURCE }
    );

    return {
      session: completed,
      entries,
      stored,
      totals: summarizeTotals(entries),
      inventory: {
        attempted: o.inventorySync !== false,
        results: inventoryResults,
        ok: inventoryResults.every((r) => r.ok),
      },
      calendar: calRes,
      dashboard: dashRes,
      savings: savingsRes,
    };
  },

  /**
   * Get a harvest session + its entries.
   */
  async getSession(sessionId) {
    if (!sessionId) return null;

    const tSessions = resolveTable("sessions");
    const tEntries = resolveTable("entries");
    const tLog = resolveTable("log");

    let session = null;
    if (tSessions) session = await dbGet(tSessions, sessionId);
    if (!session && tLog) {
      const maybe = await dbGet(tLog, sessionId);
      if (maybe?.type === "harvest.session")
        session = normalizeSessionInput(maybe);
    }
    if (!session) return null;

    let entries = [];
    if (tEntries) entries = await dbQueryBy(tEntries, "sessionId", sessionId);
    else if (tLog) {
      const all = await tLog.toArray().catch(() => []);
      entries = all.filter(
        (r) => r?.type === "harvest.entry" && r?.sessionId === sessionId
      );
    }

    return { session, entries, totals: summarizeTotals(entries) };
  },

  /**
   * List sessions (most recent first).
   * @param {object} [filters]
   * @param {string} [filters.householdId]
   * @param {string} [filters.gardenId]
   * @param {string} [filters.status] - draft|completed|void
   * @param {number} [filters.limit=50]
   */
  async listSessions(filters = {}) {
    const f = safeObject(filters);
    const limit = Number.isFinite(Number(f.limit))
      ? clamp(Number(f.limit), 1, 500)
      : 50;

    const tSessions = resolveTable("sessions");
    const tLog = resolveTable("log");

    let rows = [];
    if (tSessions) {
      rows = await tSessions.toArray().catch(() => []);
    } else if (tLog) {
      const all = await tLog.toArray().catch(() => []);
      rows = all.filter((r) => r?.type === "harvest.session");
    }

    if (f.householdId)
      rows = rows.filter((r) => r?.householdId === f.householdId);
    if (f.gardenId) rows = rows.filter((r) => r?.gardenId === f.gardenId);
    if (f.status)
      rows = rows.filter((r) => String(r?.status || "") === String(f.status));

    rows.sort((a, b) => {
      const at = new Date(a?.startedAt || 0).getTime();
      const bt = new Date(b?.startedAt || 0).getTime();
      return bt - at;
    });

    return rows.slice(0, limit).map((r) => normalizeSessionInput(r));
  },

  /**
   * Delete a session (and its entries).
   * @param {string} sessionId
   */
  async deleteSession(sessionId) {
    if (!sessionId) return { ok: false, reason: "no_sessionId" };

    const tSessions = resolveTable("sessions");
    const tEntries = resolveTable("entries");
    const tLog = resolveTable("log");

    let ok = false;

    // Delete entries first
    try {
      if (tEntries) {
        const entries = await dbQueryBy(tEntries, "sessionId", sessionId);
        for (const e of entries) await dbDelete(tEntries, e.id ?? e.entryId);
        ok = true;
      } else if (tLog) {
        const all = await tLog.toArray().catch(() => []);
        const entries = all.filter(
          (r) => r?.type === "harvest.entry" && r?.sessionId === sessionId
        );
        for (const e of entries) await dbDelete(tLog, e.id);
        ok = true;
      }
    } catch {
      // ignore
    }

    // Delete session record
    if (tSessions) ok = (await dbDelete(tSessions, sessionId)) || ok;
    else if (tLog) ok = (await dbDelete(tLog, sessionId)) || ok;

    emit("garden.harvest.session.deleted", { sessionId, ok });
    log.warn("Harvest session deleted", { sessionId, ok }, { source: SOURCE });

    return { ok };
  },
};

export default HarvestSessionService;
