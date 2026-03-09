// File: C:\Users\larho\suka-smart-assistant\src\services\StorehouseService.js
/**
 * StorehouseService (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Single, browser-safe service for “storehouse” operations:
 *      • pantry/freezer/cold-room/root-cellar inventory views
 *      • par-levels (min/max/targets) + refill suggestions
 *      • consumption + replenishment math (best-effort without heavy AI)
 *      • “reserve for holy days / events” allocations
 *      • export summaries (for hub sync, shopping list generator, etc.)
 *
 * Principles
 *  - Offline-first: uses Dexie db if available; falls back to localStorage.
 *  - Non-breaking: no Node imports. Safe in Vite browser build.
 *  - Flexible: adapts to whatever tables exist:
 *      - inventory_items, inventory, items, pantry_items, etc.
 *    If none exist, uses internal KV store.
 *  - Event-driven: emits minimal events if eventBus exists.
 *
 * Expected integration (recommended, not required)
 *  - src/services/db.js exports { db } (Dexie)
 *  - src/services/events/eventBus (or src/services/automation/eventBus.js) exports emit/on
 *  - inventorySelectors can read the storehouse projections
 *
 * Data model (normalized in this service)
 *  - StorehouseItem:
 *      {
 *        id, name, category, location, unit,
 *        qty, qtyReserved, qtyAvailable,
 *        par: { min, target, max },
 *        updatedAt,
 *        meta: { ... }
 *      }
 */

const SOURCE = "services.StorehouseService";

/* -----------------------------------------------------------------------------
 * Optional deps (safe)
 * -------------------------------------------------------------------------- */

let db = null;
try {
  // Your project often uses src/services/db.js
  // eslint-disable-next-line import/no-unresolved
  const mod = await import("./db.js").catch(() => null);
  db = mod?.db || mod?.default?.db || mod?.default || null;
} catch {
  db = null;
}

let bus = null;
try {
  // Prefer the “real” bus if present
  const mod =
    (await import("./events/eventBus.js").catch(() => null)) ||
    (await import("./automation/eventBus.js").catch(() => null));
  bus = mod?.eventBus || mod?.default || mod || null;
} catch {
  bus = null;
}

/* -----------------------------------------------------------------------------
 * Small utils
 * -------------------------------------------------------------------------- */

const nowISO = () => new Date().toISOString();
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

function sumQty(items) {
  return safeArr(items).reduce((acc, it) => acc + (Number(it?.qty) || 0), 0);
}

function coalesce(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function tryEmit(event, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(event, payload);
    else if (typeof bus.publish === "function") bus.publish(event, payload);
  } catch {
    /* no-op */
  }
}

/* -----------------------------------------------------------------------------
 * Minimal KV fallback store (localStorage)
 * -------------------------------------------------------------------------- */

const LS_KEY = "ssa.storehouse.v1";

function lsRead() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { items: {}, reservations: {} };
    const parsed = JSON.parse(raw);
    return {
      items: safeObj(parsed.items),
      reservations: safeObj(parsed.reservations),
    };
  } catch {
    return { items: {}, reservations: {} };
  }
}

function lsWrite(next) {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        items: safeObj(next?.items),
        reservations: safeObj(next?.reservations),
      })
    );
    return true;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Table discovery (Dexie)
 * -------------------------------------------------------------------------- */

const TABLE_CANDIDATES = {
  // inventory items / stock
  inventory: [
    "inventory_items",
    "inventoryItems",
    "inventory",
    "items",
    "storehouse_items",
    "pantry_items",
  ],
  // par levels / preferences
  par: ["par_levels", "storehouse_par", "inventory_par", "pars"],
  // reservations / allocations
  reservations: ["reservations", "storehouse_reservations", "allocations"],
};

function resolveTable(nameList) {
  if (!db || !db.tables) return null;
  const tables = safeArr(db.tables);
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const n of nameList) {
    if (byName.has(n)) return byName.get(n);
  }
  return null;
}

const TABLES = {
  inventory: resolveTable(TABLE_CANDIDATES.inventory),
  par: resolveTable(TABLE_CANDIDATES.par),
  reservations: resolveTable(TABLE_CANDIDATES.reservations),
};

/* -----------------------------------------------------------------------------
 * Normalization
 * -------------------------------------------------------------------------- */

/**
 * Normalize a raw record from any likely inventory table into StorehouseItem.
 */
function normalizeItem(raw) {
  const r = safeObj(raw);
  const id = String(
    coalesce(r.id, r.itemId, r.sku, r.key, r._id, keyOf(r.name))
  );
  const name = String(coalesce(r.name, r.title, r.label, "Unnamed item"));
  const category = String(coalesce(r.category, r.type, r.group, "misc"));
  const location = String(
    coalesce(
      r.location,
      r.storageLocation,
      r.storage,
      r.zone,
      r.bin,
      r.room,
      "pantry"
    )
  );
  const unit = String(coalesce(r.unit, r.uom, r.measure, "each"));
  const qty = Number(coalesce(r.qty, r.quantity, r.onHand, r.count, 0)) || 0;

  const parObj = safeObj(coalesce(r.par, r.parLevel, r.pars));
  const par = {
    min: Number(coalesce(parObj.min, r.parMin, r.min, 0)) || 0,
    target: Number(coalesce(parObj.target, r.parTarget, r.target, 0)) || 0,
    max: Number(coalesce(parObj.max, r.parMax, r.max, 0)) || 0,
  };

  const updatedAt = String(
    coalesce(r.updatedAt, r.updated_at, r.lastUpdated, nowISO())
  );
  const meta = safeObj(coalesce(r.meta, r.metadata, {}));

  // qtyReserved/available computed later via reservation map
  return {
    id,
    name,
    category,
    location,
    unit,
    qty,
    par,
    updatedAt,
    meta,
  };
}

/* -----------------------------------------------------------------------------
 * Reservation model
 * -------------------------------------------------------------------------- */
/**
 * Reservation:
 *  { id, itemId, qty, reason, startsAt, endsAt, scope, createdAt }
 *
 * scope examples:
 *  - { type:"event", id:"passover_2026" }
 *  - { type:"household", id:"primary" }
 */

function normalizeReservation(raw) {
  const r = safeObj(raw);
  const id = String(coalesce(r.id, r._id, uid("res")));
  const itemId = String(
    coalesce(r.itemId, r.item_id, r.inventoryId, r.inventory_id, r.sku, "")
  );
  const qty = Number(coalesce(r.qty, r.quantity, 0)) || 0;
  const reason = String(coalesce(r.reason, r.note, r.title, "Reserved"));
  const startsAt = r.startsAt ? String(r.startsAt) : null;
  const endsAt = r.endsAt ? String(r.endsAt) : null;
  const scope = safeObj(coalesce(r.scope, {}));
  const createdAt = String(coalesce(r.createdAt, r.created_at, nowISO()));
  return { id, itemId, qty, reason, startsAt, endsAt, scope, createdAt };
}

function uid(prefix = "sh") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function reservationIsActive(res, at = new Date()) {
  const t = at instanceof Date ? at : new Date(at);
  const s = res?.startsAt ? new Date(res.startsAt) : null;
  const e = res?.endsAt ? new Date(res.endsAt) : null;
  if (s && t < s) return false;
  if (e && t > e) return false;
  return true;
}

/* -----------------------------------------------------------------------------
 * Core read paths
 * -------------------------------------------------------------------------- */

async function readAllInventoryRaw() {
  if (TABLES.inventory) {
    try {
      // Dexie Table: toArray
      if (typeof TABLES.inventory.toArray === "function") {
        return await TABLES.inventory.toArray();
      }
      // Fallback: iterate
      if (typeof TABLES.inventory.each === "function") {
        const rows = [];
        await TABLES.inventory.each((x) => rows.push(x));
        return rows;
      }
    } catch {
      // fall through to LS
    }
  }

  // localStorage fallback
  const snap = lsRead();
  return Object.values(safeObj(snap.items));
}

async function readAllParsRaw() {
  if (TABLES.par) {
    try {
      if (typeof TABLES.par.toArray === "function")
        return await TABLES.par.toArray();
    } catch {
      /* ignore */
    }
  }
  return []; // pars can be embedded on items in LS snapshot
}

async function readAllReservationsRaw() {
  if (TABLES.reservations) {
    try {
      if (typeof TABLES.reservations.toArray === "function")
        return await TABLES.reservations.toArray();
    } catch {
      /* ignore */
    }
  }
  const snap = lsRead();
  return Object.values(safeObj(snap.reservations));
}

function mergeParsIntoItems(items, pars) {
  if (!safeArr(pars).length) return items;
  const parByItemId = new Map();
  for (const p of pars) {
    const pp = safeObj(p);
    const itemId = String(
      coalesce(
        pp.itemId,
        pp.item_id,
        pp.inventoryId,
        pp.inventory_id,
        pp.id,
        ""
      )
    );
    if (!itemId) continue;
    parByItemId.set(itemId, {
      min: Number(coalesce(pp.min, pp.parMin, 0)) || 0,
      target: Number(coalesce(pp.target, pp.parTarget, 0)) || 0,
      max: Number(coalesce(pp.max, pp.parMax, 0)) || 0,
    });
  }
  return items.map((it) => {
    const par = parByItemId.get(it.id);
    if (!par) return it;
    return { ...it, par: { ...it.par, ...par } };
  });
}

function applyReservations(items, reservations, at = new Date()) {
  const resActive = safeArr(reservations)
    .map(normalizeReservation)
    .filter((r) => r.itemId && reservationIsActive(r, at));

  const reservedByItem = new Map();
  for (const r of resActive) {
    const prev = reservedByItem.get(r.itemId) || 0;
    reservedByItem.set(r.itemId, prev + (Number(r.qty) || 0));
  }

  const enriched = items.map((it) => {
    const qtyReserved = Number(reservedByItem.get(it.id) || 0) || 0;
    const qtyAvailable = Math.max(0, (Number(it.qty) || 0) - qtyReserved);
    return { ...it, qtyReserved, qtyAvailable };
  });

  return { items: enriched, reservations: resActive, reservedByItem };
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

const StorehouseService = {
  /**
   * Returns full storehouse snapshot (normalized + enriched).
   * options:
   *  - at: Date | ISO string (reservation active point)
   *  - includeReservations: boolean (default true)
   */
  async getSnapshot(options = {}) {
    const opts = safeObj(options);
    const at = opts.at ? new Date(opts.at) : new Date();
    const includeReservations = opts.includeReservations !== false;

    const rawInv = await readAllInventoryRaw();
    const items0 = safeArr(rawInv).map(normalizeItem);

    const pars = await readAllParsRaw();
    const items1 = mergeParsIntoItems(items0, pars);

    if (!includeReservations) {
      return {
        source: SOURCE,
        at: at.toISOString(),
        items: items1.map((it) => ({
          ...it,
          qtyReserved: 0,
          qtyAvailable: it.qty,
        })),
        reservations: [],
        stats: StorehouseService.computeStats(items1),
      };
    }

    const rawRes = await readAllReservationsRaw();
    const { items, reservations } = applyReservations(items1, rawRes, at);

    return {
      source: SOURCE,
      at: at.toISOString(),
      items,
      reservations,
      stats: StorehouseService.computeStats(items),
    };
  },

  /**
   * Compute simple stats for dashboards/KPIs.
   */
  computeStats(items) {
    const list = safeArr(items);
    const totalSku = list.length;
    const totalQty = list.reduce((a, it) => a + (Number(it.qty) || 0), 0);
    const totalReserved = list.reduce(
      (a, it) => a + (Number(it.qtyReserved) || 0),
      0
    );
    const totalAvailable = list.reduce(
      (a, it) => a + (Number(it.qtyAvailable) || 0),
      0
    );

    const byLocation = {};
    for (const it of list) {
      const k = keyOf(it.location || "unknown");
      byLocation[k] = byLocation[k] || {
        location: it.location || "unknown",
        sku: 0,
        qty: 0,
      };
      byLocation[k].sku += 1;
      byLocation[k].qty += Number(it.qty) || 0;
    }

    const lowCount = list.filter((it) => {
      const min = Number(it?.par?.min) || 0;
      if (min <= 0) return false;
      return (Number(it.qtyAvailable) || 0) < min;
    }).length;

    return {
      totalSku,
      totalQty,
      totalReserved,
      totalAvailable,
      lowCount,
      byLocation: Object.values(byLocation),
    };
  },

  /**
   * Returns items filtered by location/category/search.
   * options:
   *  - location, category, q, includeZero (default true)
   */
  async list(options = {}) {
    const opts = safeObj(options);
    const snap = await StorehouseService.getSnapshot({
      includeReservations: true,
    });
    let items = safeArr(snap.items);

    if (opts.location) {
      const loc = keyOf(opts.location);
      items = items.filter((it) => keyOf(it.location) === loc);
    }
    if (opts.category) {
      const cat = keyOf(opts.category);
      items = items.filter((it) => keyOf(it.category) === cat);
    }
    if (opts.q) {
      const q = String(opts.q).trim().toLowerCase();
      items = items.filter((it) =>
        String(it.name || "")
          .toLowerCase()
          .includes(q)
      );
    }
    if (opts.includeZero === false) {
      items = items.filter((it) => (Number(it.qty) || 0) > 0);
    }

    return items;
  },

  /**
   * Get a single item (by id) from snapshot.
   */
  async getItem(itemId) {
    const id = String(itemId || "");
    if (!id) return null;
    const snap = await StorehouseService.getSnapshot({
      includeReservations: true,
    });
    return safeArr(snap.items).find((it) => String(it.id) === id) || null;
  },

  /**
   * Upsert an item quantity (increment/decrement or set).
   *
   * payload:
   *  { id, name?, category?, location?, unit?, qtyDelta?, qtySet?, meta?, par? }
   */
  async upsertItem(payload) {
    const p = safeObj(payload);
    const id = String(coalesce(p.id, p.itemId, p.sku, ""));
    if (!id) throw new Error("StorehouseService.upsertItem: missing id");

    // Read current
    const current = await StorehouseService.getItem(id);
    const base =
      current ||
      normalizeItem({
        id,
        name: p.name,
        category: p.category,
        location: p.location,
        unit: p.unit,
        qty: 0,
      });

    const qtyDelta = Number(p.qtyDelta);
    const hasDelta = Number.isFinite(qtyDelta);
    const qtySet = Number(p.qtySet);
    const hasSet = Number.isFinite(qtySet);

    let nextQty = Number(base.qty) || 0;
    if (hasSet) nextQty = qtySet;
    if (hasDelta) nextQty = nextQty + qtyDelta;
    nextQty = Math.max(0, nextQty);

    const next = {
      ...base,
      name: coalesce(p.name, base.name),
      category: coalesce(p.category, base.category),
      location: coalesce(p.location, base.location),
      unit: coalesce(p.unit, base.unit),
      qty: nextQty,
      par: { ...safeObj(base.par), ...safeObj(p.par) },
      meta: { ...safeObj(base.meta), ...safeObj(p.meta) },
      updatedAt: nowISO(),
    };

    // Persist
    const persisted = await persistItem(next);

    tryEmit("storehouse.item.upserted", {
      id: next.id,
      item: persisted,
      source: SOURCE,
    });
    return persisted;
  },

  /**
   * Delete an item by id.
   */
  async deleteItem(itemId) {
    const id = String(itemId || "");
    if (!id) return false;

    let ok = false;

    if (TABLES.inventory) {
      try {
        if (typeof TABLES.inventory.delete === "function") {
          await TABLES.inventory.delete(id);
          ok = true;
        }
      } catch {
        ok = false;
      }
    }

    if (!ok) {
      const snap = lsRead();
      const items = safeObj(snap.items);
      if (items[id]) {
        delete items[id];
        ok = lsWrite({ ...snap, items });
      }
    }

    if (ok) tryEmit("storehouse.item.deleted", { id, source: SOURCE });
    return ok;
  },

  /**
   * Set par levels for an item.
   * payload: { itemId, min?, target?, max? }
   */
  async setParLevel(payload) {
    const p = safeObj(payload);
    const itemId = String(coalesce(p.itemId, p.id, ""));
    if (!itemId)
      throw new Error("StorehouseService.setParLevel: missing itemId");

    const par = {
      min: Number(coalesce(p.min, 0)) || 0,
      target: Number(coalesce(p.target, 0)) || 0,
      max: Number(coalesce(p.max, 0)) || 0,
    };

    // If you have a par table, store there; else embed into item record.
    if (TABLES.par) {
      try {
        if (typeof TABLES.par.put === "function") {
          await TABLES.par.put({ itemId, ...par, updatedAt: nowISO() });
          tryEmit("storehouse.par.updated", { itemId, par, source: SOURCE });
          return par;
        }
      } catch {
        /* fall through */
      }
    }

    const item = await StorehouseService.getItem(itemId);
    if (!item) throw new Error("StorehouseService.setParLevel: item not found");
    await StorehouseService.upsertItem({ id: itemId, par });
    tryEmit("storehouse.par.updated", { itemId, par, source: SOURCE });
    return par;
  },

  /**
   * Create a reservation (allocation) against an item.
   * payload: { itemId, qty, reason?, startsAt?, endsAt?, scope? }
   */
  async reserve(payload) {
    const p = safeObj(payload);
    const itemId = String(coalesce(p.itemId, p.id, ""));
    const qty = Number(p.qty) || 0;
    if (!itemId) throw new Error("StorehouseService.reserve: missing itemId");
    if (!(qty > 0))
      throw new Error("StorehouseService.reserve: qty must be > 0");

    const res = normalizeReservation({
      id: p.reservationId || uid("res"),
      itemId,
      qty,
      reason: p.reason || "Reserved",
      startsAt: p.startsAt || null,
      endsAt: p.endsAt || null,
      scope: p.scope || null,
      createdAt: nowISO(),
    });

    // Persist reservation
    const saved = await persistReservation(res);

    tryEmit("storehouse.reservation.created", {
      reservation: saved,
      source: SOURCE,
    });
    return saved;
  },

  /**
   * Cancel a reservation by id.
   */
  async cancelReservation(reservationId) {
    const rid = String(reservationId || "");
    if (!rid) return false;

    let ok = false;

    if (TABLES.reservations) {
      try {
        if (typeof TABLES.reservations.delete === "function") {
          await TABLES.reservations.delete(rid);
          ok = true;
        }
      } catch {
        ok = false;
      }
    }

    if (!ok) {
      const snap = lsRead();
      const reservations = safeObj(snap.reservations);
      if (reservations[rid]) {
        delete reservations[rid];
        ok = lsWrite({ ...snap, reservations });
      }
    }

    if (ok)
      tryEmit("storehouse.reservation.canceled", {
        reservationId: rid,
        source: SOURCE,
      });
    return ok;
  },

  /**
   * Suggest refills based on par min/target/max and available qty.
   * options:
   *  - mode: "min" | "target" (default "target")
   *  - location?, category?
   *  - limit (default 50)
   */
  async getRefillSuggestions(options = {}) {
    const opts = safeObj(options);
    const mode = String(opts.mode || "target");
    const limit = clamp(Number(opts.limit) || 50, 1, 500);

    let items = await StorehouseService.list({
      location: opts.location,
      category: opts.category,
      includeZero: true,
    });

    const sugg = items
      .map((it) => {
        const par = safeObj(it.par);
        const min = Number(par.min) || 0;
        const target = Number(par.target) || 0;
        const max = Number(par.max) || 0;

        const available = Number(it.qtyAvailable ?? it.qty) || 0;
        const desired = mode === "min" ? min : target > 0 ? target : min;

        if (!(desired > 0)) return null;
        if (available >= desired) return null;

        const needed = desired - available;
        const cap = max > 0 ? Math.max(0, max - available) : needed;

        return {
          itemId: it.id,
          name: it.name,
          category: it.category,
          location: it.location,
          unit: it.unit,
          qtyAvailable: available,
          par: { min, target, max },
          needed: needed,
          suggestedBuyQty: mode === "target" ? Math.min(needed, cap) : needed,
          reason: mode === "min" ? "Below par min" : "Below par target",
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.needed - a.needed)
      .slice(0, limit);

    return sugg;
  },

  /**
   * Produce a shopping-list-ready structure from refill suggestions.
   * This is intentionally simple; your ShoppingListGenerator can enrich it.
   */
  async buildRefillShoppingList(options = {}) {
    const suggestions = await StorehouseService.getRefillSuggestions(options);
    const grouped = {};

    for (const s of suggestions) {
      const cat = keyOf(s.category || "misc");
      grouped[cat] = grouped[cat] || {
        category: s.category || "misc",
        items: [],
      };
      grouped[cat].items.push({
        itemId: s.itemId,
        name: s.name,
        qty: s.suggestedBuyQty,
        unit: s.unit,
        location: s.location,
        reason: s.reason,
      });
    }

    return {
      source: SOURCE,
      createdAt: nowISO(),
      mode: options?.mode || "target",
      groups: Object.values(grouped),
      totals: {
        sku: suggestions.length,
        qty: suggestions.reduce(
          (a, s) => a + (Number(s.suggestedBuyQty) || 0),
          0
        ),
      },
      raw: suggestions,
    };
  },

  /**
   * Export snapshot into a hub-friendly packet (minimal; your HubPacketFormatter can wrap).
   */
  async exportPacket(options = {}) {
    const snap = await StorehouseService.getSnapshot({
      includeReservations: true,
      ...safeObj(options),
    });
    return {
      type: "storehouse.snapshot",
      source: SOURCE,
      createdAt: nowISO(),
      at: snap.at,
      stats: snap.stats,
      items: snap.items,
      reservations: snap.reservations,
    };
  },

  /**
   * Health check / capability probe.
   */
  capabilities() {
    return {
      source: SOURCE,
      hasDexieDb: !!db,
      tables: {
        inventory: !!TABLES.inventory && TABLES.inventory.name,
        par: !!TABLES.par && TABLES.par.name,
        reservations: !!TABLES.reservations && TABLES.reservations.name,
      },
      fallback: "localStorage",
      events: !!bus,
    };
  },
};

export default StorehouseService;
export { StorehouseService };

/* -----------------------------------------------------------------------------
 * Persistence helpers
 * -------------------------------------------------------------------------- */

async function persistItem(item) {
  // Prefer Dexie table if available
  if (TABLES.inventory) {
    try {
      if (typeof TABLES.inventory.put === "function") {
        await TABLES.inventory.put(item);
        return item;
      }
      if (typeof TABLES.inventory.update === "function" && item?.id) {
        await TABLES.inventory.update(item.id, item);
        return item;
      }
    } catch {
      // fall through to LS
    }
  }

  const snap = lsRead();
  const items = safeObj(snap.items);
  items[item.id] = item;
  lsWrite({ ...snap, items });
  return item;
}

async function persistReservation(res) {
  if (TABLES.reservations) {
    try {
      if (typeof TABLES.reservations.put === "function") {
        await TABLES.reservations.put(res);
        return res;
      }
    } catch {
      /* fall through */
    }
  }

  const snap = lsRead();
  const reservations = safeObj(snap.reservations);
  reservations[res.id] = res;
  lsWrite({ ...snap, reservations });
  return res;
}
