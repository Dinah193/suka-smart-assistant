/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\homesteadPlanner\inventory.repo.js
//
// SSA • Homestead Planner Inventory Repository (Read/Write Adapter)
// -----------------------------------------------------------------------------
// Purpose
//  - Provides a planner-friendly API over SSA inventory/storehouse tables.
//  - Normalizes and summarizes inventory availability for provisioning/garden/
//    animals/preservation planning.
//  - Supports plan-scoped "reservations" so planner targets can be staged without
//    immediately decrementing household inventory.
//
// Design goals
//  - Browser-safe (Vite) — no Node imports
//  - Dexie-backed; tolerant of missing table names (fallback/degenerate modes)
//  - Deterministic normalization (units, keys, lots)
//  - Emit eventBus signals so dashboards/automation can react
//
// Expected (typical) SSA tables (your db.js may differ):
//  - inventoryItems / inventory: items with qty + unit + tags + locations
//  - inventoryLots: lot-level items (expiry, batch, location)
//  - storehouseItems / storehouse: pantry/freezer/rootcellar placement metadata
//  - pantry/freezer/rootCellar (sometimes separate, sometimes unified)
//  - shoppingListItems (optional)
//  - homesteadPlannerReservations (recommended, plan-scoped reservations)
//
// This repo auto-detects which tables exist and adapts.
// For best results, add:
//  - homesteadPlannerReservations: "&id, householdId, planId, status, updatedAt, createdAt"
//
// Terminology
//  - "Item key" is a normalized string identifier (componentKey, ingredientKey,
//    cropKey, speciesKey, etc.). This repo stores keys as strings.
//  - Reservations are non-destructive holds for a plan. You can "commit" a
//    reservation to apply reductions (optional; only if your inventory model
//    supports safe decrementing).
//
// -----------------------------------------------------------------------------
// Usage
//  import { homesteadPlannerInventoryRepo as hpInv } from "@/services/repos/homesteadPlanner/inventory.repo";
//  const summary = await hpInv.getAvailabilitySummary({ householdId, keys: ["rice", "chicken"] });
//  await hpInv.upsertReservation({ householdId, planId, lines: [{ key:"rice", qty: 10, unit:"lb" }] });
//
// -----------------------------------------------------------------------------

const DEFAULT_SOURCE = "services/repos/homesteadPlanner/inventory.repo";

/** Event names (keep stable) */
export const HP_INVENTORY_EVENTS = Object.freeze({
  SNAPSHOT_UPDATED: "homesteadPlanner.inventory.snapshot.updated",
  RESERVATION_UPSERTED: "homesteadPlanner.inventory.reservation.upserted",
  RESERVATION_STATUS: "homesteadPlanner.inventory.reservation.status",
  RESERVATION_DELETED: "homesteadPlanner.inventory.reservation.deleted",
});

/** Candidate table names (ordered) */
const INVENTORY_TABLE_CANDIDATES = Object.freeze([
  "inventoryItems",
  "inventory",
  "storeInventory",
  "items",
]);

const LOTS_TABLE_CANDIDATES = Object.freeze([
  "inventoryLots",
  "lots",
  "itemLots",
]);

const STOREHOUSE_TABLE_CANDIDATES = Object.freeze([
  "storehouseItems",
  "storehouse",
  "pantryItems",
  "freezerItems",
  "rootCellarItems",
]);

const RESERVATIONS_TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerReservations",
  "plannerReservations",
  "reservations",
]);

const KV_TABLE_CANDIDATES = Object.freeze(["kv", "settings", "appSettings"]);

/** Reservation status values */
const RES_STATUS = Object.freeze([
  "draft",
  "active",
  "committed",
  "cancelled",
  "archived",
]);

/** Helpers */
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function jclone(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeStr(v) {
  return v == null ? null : String(v).trim() || null;
}

function normalizeKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w:.-]/g, "");
}

function clampEnum(val, allowed, fallback) {
  return allowed.includes(val) ? val : fallback;
}

function clampNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Basic unit normalization
 * - We do NOT attempt full unit conversion (that belongs to a unit engine).
 * - We keep qty+unit but can aggregate if units match.
 */
function normalizeUnit(u) {
  const s = String(u || "")
    .trim()
    .toLowerCase();
  if (!s) return "count";
  // common aliases
  const map = {
    ct: "count",
    ea: "count",
    each: "count",
    pcs: "count",
    piece: "count",
    pieces: "count",
    lb: "lb",
    lbs: "lb",
    pound: "lb",
    pounds: "lb",
    oz: "oz",
    floz: "floz",
    g: "g",
    gram: "g",
    grams: "g",
    kg: "kg",
    l: "l",
    liter: "l",
    liters: "l",
    ml: "ml",
    gallon: "gal",
    gallons: "gal",
    gal: "gal",
    qt: "qt",
    qts: "qt",
    pint: "pt",
    pints: "pt",
    pt: "pt",
  };
  return map[s] || s;
}

function safeSumByUnit(lines) {
  // returns { unit -> totalQty }
  const out = {};
  for (const ln of lines) {
    const u = normalizeUnit(ln.unit);
    const q = clampNum(ln.qty);
    out[u] = (out[u] || 0) + q;
  }
  return out;
}

function hasTable(db, name) {
  try {
    if (!db || !db.tables) return false;
    return db.tables.some((t) => t && t.name === name);
  } catch {
    return false;
  }
}

function pickFirstExistingTable(db, candidates) {
  for (const n of candidates) if (hasTable(db, n)) return n;
  return null;
}

function emit(bus, evt, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(evt, payload);
    else if (typeof bus.publish === "function") bus.publish(evt, payload);
  } catch (e) {
    console.warn(`[HP inventory] event emit failed: ${evt}`, e);
  }
}

/** Lazy-load db and eventBus (path-tolerant) */
async function getDbAndBus() {
  let db = null;
  let eventBus = null;

  try {
    const mod = await import("@/services/db");
    db = mod.db || mod.default || null;
  } catch {
    try {
      const mod = await import("../../db");
      db = mod.db || mod.default || null;
    } catch {
      // ignore
    }
  }

  try {
    const mod = await import("@/services/events/eventBus");
    eventBus = mod.eventBus || mod.default || null;
  } catch {
    try {
      const mod = await import("../../events/eventBus");
      eventBus = mod.eventBus || mod.default || null;
    } catch {
      // ignore
    }
  }

  return { db, eventBus };
}

/** Build a stable reservation id */
export function makeHomesteadPlannerReservationId({
  householdId,
  planId,
} = {}) {
  const hid = String(householdId || "").trim();
  const pid = String(planId || "").trim();
  if (!hid) throw new Error("householdId is required");
  if (!pid) throw new Error("planId is required");
  return `${hid}::${pid}`;
}

/** Reservation record defaults */
export function getReservationDefaults() {
  return {
    schemaVersion: 1,
    status: "draft", // draft|active|committed|cancelled|archived
    notes: "",
    // lines: [{ key, qty, unit, lotId?, location?, meta? }]
    lines: [],
    // optional computed info
    computed: {
      totalsByKey: {}, // key -> { unit -> qty }
    },
  };
}

export function sanitizeReservation(rec) {
  const d = getReservationDefaults();
  const merged = isObj(rec) ? { ...d, ...rec } : { ...d };

  merged.status = clampEnum(
    String(merged.status || "").trim(),
    RES_STATUS,
    "draft"
  );
  merged.notes =
    typeof merged.notes === "string"
      ? merged.notes
      : String(merged.notes ?? "");

  const lines = Array.isArray(merged.lines) ? merged.lines : [];
  merged.lines = lines
    .map((ln) => {
      if (!isObj(ln)) return null;
      const key = normalizeKey(ln.key);
      if (!key) return null;
      const qty = clampNum(ln.qty);
      const unit = normalizeUnit(ln.unit);
      const lotId = normalizeStr(ln.lotId);
      const location = normalizeStr(ln.location);
      const meta = isObj(ln.meta) ? ln.meta : undefined;
      return {
        key,
        qty,
        unit,
        ...(lotId ? { lotId } : {}),
        ...(location ? { location } : {}),
        ...(meta ? { meta } : {}),
      };
    })
    .filter(Boolean);

  // computed totals by key/unit
  const totalsByKey = {};
  for (const ln of merged.lines) {
    const k = ln.key;
    const u = normalizeUnit(ln.unit);
    if (!totalsByKey[k]) totalsByKey[k] = {};
    totalsByKey[k][u] = (totalsByKey[k][u] || 0) + clampNum(ln.qty);
  }
  merged.computed = { ...(merged.computed || {}), totalsByKey };

  if (!Number.isFinite(Number(merged.schemaVersion))) merged.schemaVersion = 1;

  return merged;
}

/** Normalize an inventory row into a common shape */
function normalizeInventoryRow(row) {
  if (!isObj(row)) return null;

  // Try to locate best key field
  const key =
    normalizeKey(
      row.key ??
        row.itemKey ??
        row.componentKey ??
        row.ingredientKey ??
        row.sku ??
        row.name ??
        row.title
    ) || null;

  if (!key) return null;

  const qty = clampNum(
    row.qty ?? row.quantity ?? row.onHand ?? row.amount ?? 0
  );
  const unit = normalizeUnit(row.unit ?? row.uom ?? row.measure ?? "count");

  const householdId = normalizeStr(row.householdId);
  const location = normalizeStr(
    row.location ?? row.bin ?? row.zone ?? row.storage ?? row.place
  );
  const category = normalizeStr(row.category ?? row.type ?? row.group);
  const tags = Array.isArray(row.tags) ? row.tags.map(String) : [];

  // Optional fields used by planning:
  const expiresAt = normalizeStr(
    row.expiresAt ?? row.expiryISO ?? row.expiry ?? row.bestBy
  );
  const lotId = normalizeStr(row.lotId ?? row.lot ?? row.batchId);
  const updatedAt = normalizeStr(row.updatedAt) || normalizeStr(row.modifiedAt);
  const createdAt = normalizeStr(row.createdAt);

  return {
    id: row.id ?? row.pk ?? row._id ?? undefined,
    key,
    qty,
    unit,
    householdId,
    location,
    category,
    tags,
    expiresAt,
    lotId,
    createdAt,
    updatedAt,
    raw: row, // keep raw for debugging/advanced UI
  };
}

/** Determine if a normalized inventory row is in a "storehouse area" */
function classifyStorageArea(row) {
  const loc = String(row.location || "").toLowerCase();
  const cat = String(row.category || "").toLowerCase();
  const tags = (row.tags || []).map((t) => String(t).toLowerCase());

  const has = (s) => loc.includes(s) || cat.includes(s) || tags.includes(s);
  if (has("freezer")) return "freezer";
  if (has("root") || has("cellar") || has("root_cellar")) return "root_cellar";
  if (has("pantry")) return "pantry";
  if (has("fridge") || has("refrigerator")) return "fridge";
  return "unknown";
}

/**
 * Repo factory
 *   const repo = createHomesteadPlannerInventoryRepo({ db, eventBus })
 */
export function createHomesteadPlannerInventoryRepo(deps = {}) {
  const injectedDb = deps.db || null;
  const injectedBus = deps.eventBus || null;

  async function resolve() {
    if (injectedDb || injectedBus)
      return { db: injectedDb, eventBus: injectedBus };
    return getDbAndBus();
  }

  async function resolveStorage(db) {
    const inv = pickFirstExistingTable(db, INVENTORY_TABLE_CANDIDATES);
    const lots = pickFirstExistingTable(db, LOTS_TABLE_CANDIDATES);
    const storehouse = pickFirstExistingTable(db, STOREHOUSE_TABLE_CANDIDATES);
    const reservations = pickFirstExistingTable(
      db,
      RESERVATIONS_TABLE_CANDIDATES
    );
    const kv = pickFirstExistingTable(db, KV_TABLE_CANDIDATES);
    return { inv, lots, storehouse, reservations, kv };
  }

  // ---------------------------------------------------------------------------
  // Reads: inventory snapshots & queries
  // ---------------------------------------------------------------------------

  /**
   * Get all inventory items for a household, normalized.
   * Options allow filtering by keys and/or storage area.
   */
  async function listInventory({
    householdId,
    keys = null, // array of keys
    area = null, // pantry|freezer|root_cellar|fridge|unknown
    includeRaw = false,
    limit = null,
  } = {}) {
    const { db } = await resolve();
    if (!db) return [];

    const { inv, storehouse } = await resolveStorage(db);
    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");

    const keySet =
      Array.isArray(keys) && keys.length
        ? new Set(keys.map(normalizeKey).filter(Boolean))
        : null;

    const results = [];

    // Prefer inventory table (most complete)
    if (inv) {
      let rows = [];
      try {
        const t = db.table(inv);

        // If table indexed on householdId, use where().equals()
        // otherwise fallback to scan.
        if (
          t.schema &&
          t.schema.idxByName &&
          t.schema.idxByName["householdId"]
        ) {
          rows = await t.where("householdId").equals(hid).toArray();
        } else {
          rows = await t.toArray();
          rows = rows.filter((r) => String(r.householdId || "").trim() === hid);
        }
      } catch (e) {
        console.warn("[HP inventory] listInventory(inv) failed", e);
        rows = [];
      }

      for (const r of rows) {
        const n = normalizeInventoryRow(r);
        if (!n) continue;
        if (keySet && !keySet.has(n.key)) continue;
        const storageArea = classifyStorageArea(n);
        if (area && storageArea !== area) continue;
        const out = includeRaw
          ? { ...n, storageArea }
          : { ...n, storageArea, raw: undefined };
        results.push(out);
        if (limit && results.length >= limit) break;
      }

      return results;
    }

    // Fallback: storehouse-only table (if exists)
    if (storehouse) {
      let rows = [];
      try {
        const t = db.table(storehouse);
        if (
          t.schema &&
          t.schema.idxByName &&
          t.schema.idxByName["householdId"]
        ) {
          rows = await t.where("householdId").equals(hid).toArray();
        } else {
          rows = await t.toArray();
          rows = rows.filter((r) => String(r.householdId || "").trim() === hid);
        }
      } catch (e) {
        console.warn("[HP inventory] listInventory(storehouse) failed", e);
        rows = [];
      }

      for (const r of rows) {
        const n = normalizeInventoryRow(r);
        if (!n) continue;
        if (keySet && !keySet.has(n.key)) continue;
        const storageArea = classifyStorageArea(n);
        if (area && storageArea !== area) continue;
        const out = includeRaw
          ? { ...n, storageArea }
          : { ...n, storageArea, raw: undefined };
        results.push(out);
        if (limit && results.length >= limit) break;
      }

      return results;
    }

    return [];
  }

  /**
   * Get availability summary for specific keys.
   * Returns:
   *  {
   *    byKey: { key: { onHandByUnit, byArea: { pantry|freezer|... }, lots: [...] } },
   *    totals: { unit -> qty }, // across all keys (only if units match)
   *  }
   */
  async function getAvailabilitySummary({
    householdId,
    keys = [],
    includeLots = false,
    includeItems = false,
  } = {}) {
    const { db } = await resolve();
    if (!db) {
      return { byKey: {}, totals: {} };
    }

    const wantKeys = Array.isArray(keys)
      ? keys.map(normalizeKey).filter(Boolean)
      : [];
    const keySet = new Set(wantKeys);

    const items = await listInventory({
      householdId,
      keys: wantKeys,
      includeRaw: includeLots, // raw might contain lot fields
    });

    const byKey = {};
    for (const it of items) {
      const k = it.key;
      if (!keySet.has(k)) continue;

      if (!byKey[k]) {
        byKey[k] = {
          key: k,
          onHandByUnit: {},
          byArea: {},
          lots: [],
          items: [],
        };
      }

      const u = normalizeUnit(it.unit);
      byKey[k].onHandByUnit[u] =
        (byKey[k].onHandByUnit[u] || 0) + clampNum(it.qty);

      const a = it.storageArea || "unknown";
      if (!byKey[k].byArea[a]) byKey[k].byArea[a] = {};
      byKey[k].byArea[a][u] = (byKey[k].byArea[a][u] || 0) + clampNum(it.qty);

      if (includeLots) {
        // Create a lightweight lot view even if it came from unified items
        byKey[k].lots.push({
          lotId: it.lotId || null,
          qty: it.qty,
          unit: u,
          location: it.location || null,
          storageArea: a,
          expiresAt: it.expiresAt || null,
        });
      }

      if (includeItems) {
        byKey[k].items.push(it);
      }
    }

    // Totals across keys only if you want a simple unit aggregation:
    // we aggregate per-unit totals (units not converted)
    const totals = {};
    for (const k of Object.keys(byKey)) {
      for (const [u, q] of Object.entries(byKey[k].onHandByUnit)) {
        totals[u] = (totals[u] || 0) + clampNum(q);
      }
    }

    return { byKey, totals };
  }

  /**
   * Returns inventory "coverage" for required lines:
   *  required: [{ key, qty, unit }]
   * Output:
   *  { lines: [{ key, requiredByUnit, availableByUnit, shortByUnit, ok }], ok }
   */
  async function checkCoverage({ householdId, required = [] } = {}) {
    const reqLines = Array.isArray(required) ? required : [];
    const keys = reqLines.map((r) => normalizeKey(r.key)).filter(Boolean);

    const summary = await getAvailabilitySummary({ householdId, keys });
    const outLines = [];

    for (const r of reqLines) {
      const key = normalizeKey(r.key);
      if (!key) continue;

      const unit = normalizeUnit(r.unit);
      const reqQty = clampNum(r.qty);

      const avail = summary.byKey[key]?.onHandByUnit?.[unit] || 0;
      const short = Math.max(0, reqQty - avail);

      outLines.push({
        key,
        unit,
        requiredQty: reqQty,
        availableQty: avail,
        shortQty: short,
        ok: short <= 0,
      });
    }

    const ok = outLines.every((l) => l.ok);
    return { ok, lines: outLines };
  }

  // ---------------------------------------------------------------------------
  // Reservations: plan-scoped holds against inventory
  // ---------------------------------------------------------------------------

  async function resolveReservationsStorage(db) {
    const { reservations, kv } = await resolveStorage(db);
    return { reservations, kv };
  }

  /**
   * Get a reservation record for (householdId, planId).
   */
  async function getReservation({ householdId, planId } = {}) {
    const { db } = await resolve();
    if (!db) return null;

    const { reservations, kv } = await resolveReservationsStorage(db);
    const id = makeHomesteadPlannerReservationId({ householdId, planId });

    if (reservations) {
      const rec = await db.table(reservations).get(id);
      if (!rec) return null;
      return sanitizeReservation(
        rec.reservation || rec.value || rec.data || rec
      );
    }

    if (kv) {
      const key = `homesteadPlanner.reservation.${id}`;
      const row =
        (await db.table(kv).get(key)) ||
        (await db.table(kv).get(`hpRes:${id}`)) ||
        null;
      if (!row) return null;
      return sanitizeReservation(row.value || row.val || row.data || null);
    }

    return null;
  }

  /**
   * Upsert reservation lines for a plan.
   * - Merges with existing unless replace=true
   * - Computes totalsByKey
   */
  async function upsertReservation({
    householdId,
    planId,
    patch = {}, // can include { lines, status, notes }
    replace = false,
    source = DEFAULT_SOURCE,
    reason = "reservation_upsert",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    const hid = String(householdId || "").trim();
    const pid = String(planId || "").trim();
    if (!hid) throw new Error("householdId is required");
    if (!pid) throw new Error("planId is required");

    const id = makeHomesteadPlannerReservationId({
      householdId: hid,
      planId: pid,
    });
    const at = nowISO();

    // compute next record
    const existing = !replace
      ? await getReservation({ householdId: hid, planId: pid })
      : null;
    const base = existing || getReservationDefaults();

    const merged = replace
      ? { ...base, ...patch }
      : { ...base, ...existing, ...patch };
    const next = sanitizeReservation(merged);

    if (!db) {
      if (emitEvents) {
        emit(eventBus, HP_INVENTORY_EVENTS.RESERVATION_UPSERTED, {
          householdId: hid,
          planId: pid,
          id,
          updatedAt: at,
          source,
          reason,
          reservation: jclone(next),
          persistence: "none",
        });
      }
      return next;
    }

    const { reservations, kv } = await resolveReservationsStorage(db);

    if (reservations) {
      const t = db.table(reservations);
      const record = {
        id,
        householdId: hid,
        planId: pid,
        status: next.status,
        reservation: jclone(next),
        schemaVersion: Number(next.schemaVersion) || 1,
        source,
        reason,
        createdAt: at,
        updatedAt: at,
      };

      await db.transaction("rw", t, async () => {
        const prev = await t.get(id);
        if (prev && prev.createdAt) record.createdAt = prev.createdAt;
        await t.put(record);
      });

      if (emitEvents) {
        emit(eventBus, HP_INVENTORY_EVENTS.RESERVATION_UPSERTED, {
          householdId: hid,
          planId: pid,
          id,
          updatedAt: at,
          status: next.status,
          source,
          reason,
          reservation: jclone(next),
          persistence: "table",
          table: reservations,
        });
      }

      return next;
    }

    if (kv) {
      const t = db.table(kv);
      const keyA = `homesteadPlanner.reservation.${id}`;
      const keyB = `hpRes:${id}`;

      await db.transaction("rw", t, async () => {
        const existingA = await t.get(keyA);
        const existingB = existingA ? null : await t.get(keyB);
        const keyToUse = existingB ? keyB : keyA;

        const baseRow = existingB || existingA || { key: keyToUse };
        const out = {
          ...baseRow,
          key: baseRow.key ?? keyToUse,
          id: baseRow.id ?? baseRow.key ?? keyToUse,
          value: jclone(next),
          status: next.status,
          updatedAt: at,
          source,
          reason,
        };
        await t.put(out);
      });

      if (emitEvents) {
        emit(eventBus, HP_INVENTORY_EVENTS.RESERVATION_UPSERTED, {
          householdId: hid,
          planId: pid,
          id,
          updatedAt: at,
          status: next.status,
          source,
          reason,
          reservation: jclone(next),
          persistence: "kv",
          table: kv,
        });
      }

      return next;
    }

    if (emitEvents) {
      emit(eventBus, HP_INVENTORY_EVENTS.RESERVATION_UPSERTED, {
        householdId: hid,
        planId: pid,
        id,
        updatedAt: at,
        status: next.status,
        source,
        reason,
        reservation: jclone(next),
        persistence: "none",
      });
    }

    return next;
  }

  /**
   * Set reservation status only.
   */
  async function setReservationStatus({
    householdId,
    planId,
    status,
    source = DEFAULT_SOURCE,
    reason = "reservation_status",
    emitEvents = true,
  } = {}) {
    const nextStatus = clampEnum(
      String(status || "").trim(),
      RES_STATUS,
      "draft"
    );
    const next = await upsertReservation({
      householdId,
      planId,
      patch: { status: nextStatus },
      replace: false,
      source,
      reason,
      emitEvents,
    });

    const { eventBus } = await resolve();
    if (emitEvents) {
      emit(eventBus, HP_INVENTORY_EVENTS.RESERVATION_STATUS, {
        householdId: String(householdId),
        planId: String(planId),
        id: makeHomesteadPlannerReservationId({ householdId, planId }),
        status: nextStatus,
        updatedAt: nowISO(),
        source,
        reason,
      });
    }

    return next;
  }

  /**
   * Delete reservation for (householdId, planId).
   */
  async function deleteReservation({
    householdId,
    planId,
    source = DEFAULT_SOURCE,
    reason = "reservation_delete",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    const hid = String(householdId || "").trim();
    const pid = String(planId || "").trim();
    if (!hid) throw new Error("householdId is required");
    if (!pid) throw new Error("planId is required");

    if (!db) return true;

    const { reservations, kv } = await resolveReservationsStorage(db);
    const id = makeHomesteadPlannerReservationId({
      householdId: hid,
      planId: pid,
    });
    const at = nowISO();

    if (reservations) {
      await db.table(reservations).delete(id);
      if (emitEvents) {
        emit(eventBus, HP_INVENTORY_EVENTS.RESERVATION_DELETED, {
          householdId: hid,
          planId: pid,
          id,
          updatedAt: at,
          source,
          reason,
          persistence: "table",
          table: reservations,
        });
      }
      return true;
    }

    if (kv) {
      const t = db.table(kv);
      await t.delete(`homesteadPlanner.reservation.${id}`);
      await t.delete(`hpRes:${id}`);
      if (emitEvents) {
        emit(eventBus, HP_INVENTORY_EVENTS.RESERVATION_DELETED, {
          householdId: hid,
          planId: pid,
          id,
          updatedAt: at,
          source,
          reason,
          persistence: "kv",
          table: kv,
        });
      }
      return true;
    }

    return false;
  }

  /**
   * Compute effective availability after subtracting active reservation holds
   * for a plan.
   *
   * requiredKeys: optional array of keys to limit compute
   * Returns:
   *  {
   *    byKey: { key: { onHandByUnit, reservedByUnit, availableAfterReserveByUnit } }
   *  }
   */
  async function getEffectiveAvailability({
    householdId,
    planId,
    keys = null,
  } = {}) {
    const hid = String(householdId || "").trim();
    const pid = String(planId || "").trim();
    if (!hid) throw new Error("householdId is required");
    if (!pid) throw new Error("planId is required");

    const res = await getReservation({ householdId: hid, planId: pid });
    const active =
      res && (res.status === "active" || res.status === "draft") ? res : null;

    const wantKeys =
      Array.isArray(keys) && keys.length
        ? keys.map(normalizeKey).filter(Boolean)
        : null;

    // If keys not provided, derive from reservation lines (if any)
    const keysToFetch =
      wantKeys ||
      (active ? Array.from(new Set(active.lines.map((l) => l.key))) : []);

    const summary = await getAvailabilitySummary({
      householdId: hid,
      keys: keysToFetch,
    });
    const byKey = {};

    for (const k of keysToFetch) {
      const onHandByUnit = { ...(summary.byKey[k]?.onHandByUnit || {}) };
      const reservedByUnit = {};
      const availableAfterReserveByUnit = { ...onHandByUnit };

      if (active) {
        const lines = active.lines.filter((l) => l.key === k);
        const sums = safeSumByUnit(lines);
        for (const [u, q] of Object.entries(sums)) {
          reservedByUnit[u] = (reservedByUnit[u] || 0) + q;
          availableAfterReserveByUnit[u] = Math.max(
            0,
            (availableAfterReserveByUnit[u] || 0) - q
          );
        }
      }

      byKey[k] = {
        key: k,
        onHandByUnit,
        reservedByUnit,
        availableAfterReserveByUnit,
      };
    }

    return { byKey };
  }

  /**
   * (Optional) Commit reservation:
   *  - Marks reservation as committed
   *  - Attempts to decrement inventory quantities if inventory table appears to
   *    support direct qty updates.
   *
   * IMPORTANT:
   *  - Inventory decrement rules vary by your SSA model. This function uses a
   *    conservative approach:
   *     • It looks for a single matching row per key+unit (best-effort)
   *     • It will not go below 0
   *  - If your model uses lots, you should extend this to decrement lots.
   */
  async function commitReservation({
    householdId,
    planId,
    source = DEFAULT_SOURCE,
    reason = "reservation_commit",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    const hid = String(householdId || "").trim();
    const pid = String(planId || "").trim();
    if (!hid) throw new Error("householdId is required");
    if (!pid) throw new Error("planId is required");

    const reservation = await getReservation({ householdId: hid, planId: pid });
    if (!reservation) throw new Error("No reservation found to commit");

    // Mark committed first (so UI reflects state even if decrement is partial)
    await setReservationStatus({
      householdId: hid,
      planId: pid,
      status: "committed",
      source,
      reason,
      emitEvents,
    });

    if (!db)
      return { ok: true, committed: true, decremented: false, details: [] };

    const { inv } = await resolveStorage(db);
    if (!inv) {
      return {
        ok: true,
        committed: true,
        decremented: false,
        details: [{ warning: "No inventory table found." }],
      };
    }

    const t = db.table(inv);

    // Attempt decrement in a single transaction
    const details = [];
    await db.transaction("rw", t, async () => {
      for (const ln of reservation.lines) {
        const key = ln.key;
        const unit = normalizeUnit(ln.unit);
        const qty = clampNum(ln.qty);
        if (!key || qty <= 0) continue;

        // Best-effort find: householdId + key + unit
        // Try different column names commonly used in SSA inventory models.
        // If indexes exist, use them; else scan.
        let rows = [];
        try {
          const all = await t.toArray();
          rows = all.filter((r) => {
            const rh = String(r.householdId || "").trim() === hid;
            const rk =
              normalizeKey(
                r.key ??
                  r.itemKey ??
                  r.componentKey ??
                  r.ingredientKey ??
                  r.sku ??
                  r.name ??
                  r.title
              ) === key;
            const ru =
              normalizeUnit(r.unit ?? r.uom ?? r.measure ?? "count") === unit;
            return rh && rk && ru;
          });
        } catch {
          rows = [];
        }

        if (!rows.length) {
          details.push({
            key,
            unit,
            qty,
            ok: false,
            reason: "no_matching_inventory_row",
          });
          continue;
        }

        // Pick the row with the highest qty to decrement
        const best = rows
          .map((r) => ({
            r,
            n: clampNum(r.qty ?? r.quantity ?? r.onHand ?? r.amount ?? 0),
          }))
          .sort((a, b) => b.n - a.n)[0];

        const currentQty = best.n;
        const newQty = Math.max(0, currentQty - qty);

        // Determine which field to write back
        const field =
          "qty" in best.r
            ? "qty"
            : "quantity" in best.r
            ? "quantity"
            : "onHand" in best.r
            ? "onHand"
            : "amount" in best.r
            ? "amount"
            : null;

        if (!field) {
          details.push({ key, unit, qty, ok: false, reason: "no_qty_field" });
          continue;
        }

        // Update record
        const idField =
          best.r.id != null
            ? "id"
            : best.r.pk != null
            ? "pk"
            : best.r._id != null
            ? "_id"
            : null;
        const pk = idField
          ? best.r[idField]
          : best.r.id ?? best.r.pk ?? best.r._id;

        // Dexie update by primary key if possible; else put whole row
        try {
          if (pk != null) {
            await t.update(pk, { [field]: newQty, updatedAt: nowISO() });
          } else {
            await t.put({ ...best.r, [field]: newQty, updatedAt: nowISO() });
          }
          details.push({
            key,
            unit,
            qty,
            ok: true,
            from: currentQty,
            to: newQty,
          });
        } catch (e) {
          details.push({
            key,
            unit,
            qty,
            ok: false,
            reason: "update_failed",
            error: String(e?.message || e),
          });
        }
      }
    });

    if (emitEvents) {
      emit(eventBus, HP_INVENTORY_EVENTS.SNAPSHOT_UPDATED, {
        householdId: hid,
        planId: pid,
        source,
        reason,
        updatedAt: nowISO(),
        committedReservationId: makeHomesteadPlannerReservationId({
          householdId: hid,
          planId: pid,
        }),
        decremented: true,
        details: jclone(details),
      });
    }

    const ok = details.every((d) => d.ok !== false); // allow warnings
    return { ok, committed: true, decremented: true, details };
  }

  // ---------------------------------------------------------------------------
  // Convenience helpers for planner integration
  // ---------------------------------------------------------------------------

  /**
   * Build a "planner snapshot" for a set of required lines:
   *  required: [{ key, qty, unit }]
   *  - availability
   *  - coverage
   *  - effective availability after reservation
   */
  async function buildPlannerSnapshot({
    householdId,
    planId = null,
    required = [],
  } = {}) {
    const req = Array.isArray(required) ? required : [];
    const keys = req.map((r) => normalizeKey(r.key)).filter(Boolean);

    const availability = await getAvailabilitySummary({
      householdId,
      keys,
      includeLots: true,
    });
    const coverage = await checkCoverage({ householdId, required: req });

    let effective = null;
    if (planId) {
      effective = await getEffectiveAvailability({ householdId, planId, keys });
    }

    return { availability, coverage, effective };
  }

  return Object.freeze({
    // ids
    makeReservationId: makeHomesteadPlannerReservationId,

    // inventory reads
    listInventory,
    getAvailabilitySummary,
    checkCoverage,
    getEffectiveAvailability,
    buildPlannerSnapshot,

    // reservations
    getReservation,
    upsertReservation,
    setReservationStatus,
    deleteReservation,
    commitReservation,
  });
}

/** Default singleton repo (auto-resolves db/eventBus). */
export const homesteadPlannerInventoryRepo =
  createHomesteadPlannerInventoryRepo();

/* -----------------------------------------------------------------------------
Example usage
------------------------------------------------------------------------------
import { homesteadPlannerInventoryRepo as hpInv } from "@/services/repos/homesteadPlanner/inventory.repo";

const planId = "plan_2026_01_10_001";

// Inventory availability for key set
const summary = await hpInv.getAvailabilitySummary({
  householdId,
  keys: ["rice", "chicken", "salt", "onion"],
  includeLots: true,
});

// Stage reservations for a plan (holds)
await hpInv.upsertReservation({
  householdId,
  planId,
  patch: {
    status: "active",
    lines: [
      { key: "rice", qty: 10, unit: "lb" },
      { key: "chicken", qty: 6, unit: "lb" },
    ],
  },
  source: "pages/homesteadplanner/targets",
  reason: "reserve_for_plan",
});

// Effective availability after holds
const eff = await hpInv.getEffectiveAvailability({
  householdId,
  planId,
  keys: ["rice", "chicken"],
});

// Optional: commit reservation (decrement inventory if possible)
const committed = await hpInv.commitReservation({ householdId, planId });

----------------------------------------------------------------------------- */
