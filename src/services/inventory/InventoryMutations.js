// File: C:\Users\larho\suka-smart-assistant\src\services\inventory\InventoryMutations.js
/**
 * InventoryMutations (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Production-ready mutation layer for inventory records.
 *  - Browser-safe (no Node imports), Vite-friendly.
 *  - Works with or without Dexie:
 *      • If Dexie exists and has tables, we persist there.
 *      • Otherwise we fall back to localStorage (and in-memory).
 *
 * Key capabilities
 *  - upsertItem(item)
 *  - putMany(items)
 *  - removeItem(id)
 *  - adjustQty(id, delta, meta)
 *  - setQty(id, qty, meta)
 *  - consume(id, qty, meta)          (delta negative)
 *  - restock(id, qty, meta)          (delta positive)
 *  - transfer({fromId,toId,qty,...})  (consume + restock with linked txn)
 *  - bumpExpiry(id, expiryISO, meta)
 *  - setLocation(id, location, meta)
 *  - mergeDuplicates({keepId, removeIds})
 *  - commitReceiptLines(lines, options)
 *
 * Events (best effort)
 *  - inventory.changed  { type, ids, at, meta }
 *  - inventory.txn      { txn, at }
 *
 * Notes
 *  - This module is deliberately tolerant about your schema. It will write
 *    whatever fields are provided, and add common normalized fields.
 *  - Recommended inventory record shape (not required):
 *      {
 *        id, name, canonicalName, brand, upc,
 *        qty, unit, unitSize, packSize,
 *        category, tags,
 *        location: { area, bin, shelf, note },
 *        cost: { last, avg, currency },
 *        expiryISO,
 *        createdAtISO, updatedAtISO,
 *        source, meta
 *      }
 */

const SOURCE = "services.inventory.InventoryMutations";
const LS_KEY = "ssa.inventory.v1";
const LS_TXN_KEY = "ssa.inventory.txns.v1";

/* -----------------------------------------------------------------------------
 * Safe optional deps (lazy)
 * -------------------------------------------------------------------------- */

let _depsPromise = null;
async function getDeps() {
  if (_depsPromise) return _depsPromise;

  _depsPromise = (async () => {
    let db = null;
    let bus = null;
    let logger = null;

    // db (Dexie) optional
    try {
      const mod = await import("../db.js").catch(() => null);
      db = mod?.db || mod?.default || mod || null;
    } catch {
      db = null;
    }

    // event bus optional
    try {
      const mod = await import("../automation/eventBus.js").catch(() => null);
      bus =
        mod?.eventBus ||
        mod?.bus ||
        mod?.default?.eventBus ||
        mod?.default ||
        null;
    } catch {
      bus = null;
    }

    // logger optional
    try {
      const mod = await import("../../utils/logger.js").catch(() => null);
      logger = mod?.default || mod?.logger || mod || null;
    } catch {
      logger = null;
    }

    return { db, bus, logger };
  })();

  return _depsPromise;
}

function emit(bus, event, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(event, payload);
    else if (typeof bus.publish === "function") bus.publish(event, payload);
  } catch {
    /* no-op */
  }
}

function log(logger, level, ...args) {
  try {
    const fn =
      (level === "error" && logger?.error) ||
      (level === "warn" && logger?.warn) ||
      (level === "info" && logger?.info) ||
      logger?.log;
    if (typeof fn === "function") fn(...args);
  } catch {
    /* no-op */
  }
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);
const nowISO = () => new Date().toISOString();

const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

function stableId(prefix = "inv") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function toNumber(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(n, min, max) {
  const x = toNumber(n, min);
  return Math.max(min, Math.min(max, x));
}

function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function normalizeLocation(loc) {
  const x = safeObj(loc);
  return {
    area: x.area ? String(x.area) : "",
    bin: x.bin ? String(x.bin) : "",
    shelf: x.shelf ? String(x.shelf) : "",
    note: x.note ? String(x.note) : "",
    meta: safeObj(x.meta),
  };
}

function normalizeItem(item, { keepId = true } = {}) {
  const x = safeObj(item);
  const id = keepId ? String(x.id || "") : "";
  const finalId = id || String(x.id || stableId("inv"));

  const name = x.name ? String(x.name) : x.title ? String(x.title) : "";
  const canonicalName = x.canonicalName ? String(x.canonicalName) : name;

  const qty =
    x.qty == null
      ? x.quantity == null
        ? 0
        : toNumber(x.quantity, 0)
      : toNumber(x.qty, 0);

  const unit = x.unit ? String(x.unit) : x.uom ? String(x.uom) : "each";

  const tags = safeArr(x.tags).map(String);
  const category = x.category ? String(x.category) : "";

  const createdAtISO = x.createdAtISO
    ? String(x.createdAtISO)
    : x.createdAt
    ? String(x.createdAt)
    : nowISO();

  const updatedAtISO = nowISO();

  const location = x.location
    ? normalizeLocation(x.location)
    : normalizeLocation(x.storage || x.loc);

  const upc = x.upc ? String(x.upc) : x.barcode ? String(x.barcode) : "";
  const brand = x.brand ? String(x.brand) : "";
  const expiryISO = x.expiryISO
    ? String(x.expiryISO)
    : x.expiry
    ? String(x.expiry)
    : "";

  const cost = isObj(x.cost)
    ? {
        last: toNumber(x.cost.last, undefined),
        avg: toNumber(x.cost.avg, undefined),
        currency: x.cost.currency ? String(x.cost.currency) : "USD",
      }
    : safeObj(x.cost);

  return {
    ...safeObj(x),
    id: finalId,
    name,
    canonicalName,
    brand,
    upc,
    qty,
    unit,
    unitSize:
      x.unitSize != null ? toNumber(x.unitSize, x.unitSize) : x.unitSize,
    packSize:
      x.packSize != null ? toNumber(x.packSize, x.packSize) : x.packSize,
    category,
    tags,
    location,
    expiryISO,
    cost,
    createdAtISO,
    updatedAtISO,
    source: x.source || SOURCE,
    meta: safeObj(x.meta),
  };
}

function normalizeTxn(txn) {
  const x = safeObj(txn);
  const id = String(x.id || stableId("txn"));
  return {
    id,
    type: x.type ? String(x.type) : "adjust",
    itemId: x.itemId ? String(x.itemId) : "",
    delta: toNumber(x.delta, 0),
    qtyBefore:
      x.qtyBefore == null ? undefined : toNumber(x.qtyBefore, undefined),
    qtyAfter: x.qtyAfter == null ? undefined : toNumber(x.qtyAfter, undefined),
    reason: x.reason ? String(x.reason) : "",
    ref: safeObj(x.ref), // { sessionId, receiptId, lineId, transferId, ... }
    atISO: x.atISO ? String(x.atISO) : nowISO(),
    actor: safeObj(x.actor), // { userId, name }
    meta: safeObj(x.meta),
    source: x.source || SOURCE,
  };
}

/* -----------------------------------------------------------------------------
 * Persistence (Dexie or localStorage)
 * -------------------------------------------------------------------------- */

const _mem = {
  hydrated: false,
  items: new Map(), // id -> item
  txns: [], // newest last
};

function loadLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return safeArr(parsed.items || parsed);
  } catch {
    return [];
  }
}

function saveLS(items) {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        v: 1,
        savedAtISO: nowISO(),
        items: safeArr(items),
      })
    );
    return true;
  } catch {
    return false;
  }
}

function loadTxnLS() {
  try {
    const raw = localStorage.getItem(LS_TXN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return safeArr(parsed.txns || parsed);
  } catch {
    return [];
  }
}

function saveTxnLS(txns) {
  try {
    localStorage.setItem(
      LS_TXN_KEY,
      JSON.stringify({
        v: 1,
        savedAtISO: nowISO(),
        txns: safeArr(txns).slice(-2000), // cap
      })
    );
    return true;
  } catch {
    return false;
  }
}

async function getTable(db, name) {
  try {
    if (!db) return null;
    if (db[name]) return db[name];
    if (typeof db.table === "function") return db.table(name);
    return null;
  } catch {
    return null;
  }
}

async function hydrateIfNeeded() {
  if (_mem.hydrated) return;

  const { db, logger } = await getDeps();

  // Dexie first
  try {
    const inv = await getTable(db, "inventory");
    if (inv && typeof inv.toArray === "function") {
      const all = await inv.toArray();
      _mem.items = new Map(
        safeArr(all).map((it) => [
          String(it.id),
          normalizeItem(it, { keepId: true }),
        ])
      );

      const tx = await getTable(db, "inventory_txns");
      if (tx && typeof tx.toArray === "function") {
        const allTx = await tx.toArray();
        _mem.txns = safeArr(allTx).map(normalizeTxn);
      } else {
        _mem.txns = [];
      }

      _mem.hydrated = true;
      return;
    }
  } catch (e) {
    log(
      logger,
      "warn",
      `[${SOURCE}] Dexie hydrate failed; falling back to localStorage`,
      e
    );
  }

  // localStorage fallback
  const items = loadLS().map((it) => normalizeItem(it, { keepId: true }));
  _mem.items = new Map(items.map((it) => [it.id, it]));
  _mem.txns = loadTxnLS().map(normalizeTxn);
  _mem.hydrated = true;
}

async function persistItemsBestEffort() {
  const { db, logger } = await getDeps();
  const items = Array.from(_mem.items.values());

  // Dexie path
  try {
    const inv = await getTable(db, "inventory");
    if (inv && typeof inv.bulkPut === "function") {
      await inv.bulkPut(items);
      return { ok: true, source: "dexie" };
    }
  } catch (e) {
    log(
      logger,
      "warn",
      `[${SOURCE}] Dexie persistItems failed; falling back to localStorage`,
      e
    );
  }

  const ok = saveLS(items);
  return { ok, source: ok ? "localStorage" : "memory" };
}

async function persistTxnsBestEffort() {
  const { db, logger } = await getDeps();
  const txns = safeArr(_mem.txns).slice(-2000);

  // Dexie path
  try {
    const t = await getTable(db, "inventory_txns");
    if (t && typeof t.bulkPut === "function") {
      await t.bulkPut(txns);
      return { ok: true, source: "dexie" };
    }
  } catch (e) {
    log(
      logger,
      "warn",
      `[${SOURCE}] Dexie persistTxns failed; falling back to localStorage`,
      e
    );
  }

  const ok = saveTxnLS(txns);
  return { ok, source: ok ? "localStorage" : "memory" };
}

/* -----------------------------------------------------------------------------
 * Internal helpers
 * -------------------------------------------------------------------------- */

function getItemOrThrow(id) {
  const k = String(id || "");
  if (!k) throw new Error(`[${SOURCE}] Missing inventory id`);
  const it = _mem.items.get(k);
  if (!it) throw new Error(`[${SOURCE}] Inventory item not found: ${k}`);
  return it;
}

function pushTxn(bus, txn) {
  const t = normalizeTxn(txn);
  _mem.txns.push(t);
  // cap in memory
  if (_mem.txns.length > 2500) _mem.txns = _mem.txns.slice(-2000);
  emit(bus, "inventory.txn", { txn: t, at: t.atISO });
  return t;
}

function changed(bus, type, ids, meta) {
  emit(bus, "inventory.changed", {
    type,
    ids: safeArr(ids).map(String),
    at: nowISO(),
    meta: safeObj(meta),
  });
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

async function upsertItem(item, { meta } = {}) {
  await hydrateIfNeeded();
  const { bus } = await getDeps();

  const incoming = normalizeItem(item, { keepId: true });
  const existing = _mem.items.get(incoming.id);

  const next = existing
    ? (() => {
        const merged = deepMerge(existing, incoming);
        merged.createdAtISO = existing.createdAtISO || incoming.createdAtISO;
        merged.updatedAtISO = nowISO();
        // ensure qty numeric
        merged.qty = toNumber(merged.qty, 0);
        return merged;
      })()
    : incoming;

  _mem.items.set(next.id, next);

  changed(bus, existing ? "upsert" : "create", [next.id], meta);
  await persistItemsBestEffort();
  return next;
}

async function putMany(items, { meta } = {}) {
  await hydrateIfNeeded();
  const { bus } = await getDeps();

  const ids = [];
  for (const it of safeArr(items)) {
    const normalized = normalizeItem(it, { keepId: true });
    const existing = _mem.items.get(normalized.id);
    const next = existing ? deepMerge(existing, normalized) : normalized;
    next.createdAtISO = existing?.createdAtISO || next.createdAtISO;
    next.updatedAtISO = nowISO();
    next.qty = toNumber(next.qty, 0);
    _mem.items.set(next.id, next);
    ids.push(next.id);
  }

  changed(bus, "putMany", ids, meta);
  await persistItemsBestEffort();
  return ids;
}

async function removeItem(id, { meta } = {}) {
  await hydrateIfNeeded();
  const { bus } = await getDeps();

  const k = String(id || "");
  if (!k) return false;

  const existed = _mem.items.has(k);
  if (!existed) return false;

  _mem.items.delete(k);
  changed(bus, "remove", [k], meta);

  await persistItemsBestEffort();
  return true;
}

async function adjustQty(
  id,
  delta,
  { reason = "adjust", ref, actor, meta } = {}
) {
  await hydrateIfNeeded();
  const { bus } = await getDeps();

  const it = getItemOrThrow(id);
  const d = toNumber(delta, 0);
  const before = toNumber(it.qty, 0);
  const after = before + d;

  // allow negative quantities? default: clamp at 0 unless explicitly allowed by meta
  const allowNegative = !!safeObj(meta).allowNegative;
  const finalAfter = allowNegative ? after : Math.max(0, after);

  const next = {
    ...it,
    qty: finalAfter,
    updatedAtISO: nowISO(),
  };
  _mem.items.set(next.id, next);

  const txn = pushTxn(bus, {
    type: "adjust",
    itemId: next.id,
    delta: d,
    qtyBefore: before,
    qtyAfter: finalAfter,
    reason,
    ref: safeObj(ref),
    actor: safeObj(actor),
    meta: safeObj(meta),
  });

  changed(bus, "adjustQty", [next.id], {
    reason,
    ref,
    actor,
    meta,
    txnId: txn.id,
  });
  await persistItemsBestEffort();
  await persistTxnsBestEffort();

  return { item: next, txn };
}

async function setQty(id, qty, { reason = "setQty", ref, actor, meta } = {}) {
  await hydrateIfNeeded();
  const { bus } = await getDeps();

  const it = getItemOrThrow(id);
  const before = toNumber(it.qty, 0);
  const target = toNumber(qty, 0);
  const allowNegative = !!safeObj(meta).allowNegative;
  const final = allowNegative ? target : Math.max(0, target);
  const delta = final - before;

  const next = { ...it, qty: final, updatedAtISO: nowISO() };
  _mem.items.set(next.id, next);

  const txn = pushTxn(bus, {
    type: "set",
    itemId: next.id,
    delta,
    qtyBefore: before,
    qtyAfter: final,
    reason,
    ref: safeObj(ref),
    actor: safeObj(actor),
    meta: safeObj(meta),
  });

  changed(bus, "setQty", [next.id], {
    reason,
    ref,
    actor,
    meta,
    txnId: txn.id,
  });
  await persistItemsBestEffort();
  await persistTxnsBestEffort();

  return { item: next, txn };
}

async function consume(id, qty, opts = {}) {
  const q = toNumber(qty, 0);
  return adjustQty(id, -Math.abs(q), {
    ...opts,
    reason: opts.reason || "consume",
  });
}

async function restock(id, qty, opts = {}) {
  const q = toNumber(qty, 0);
  return adjustQty(id, Math.abs(q), {
    ...opts,
    reason: opts.reason || "restock",
  });
}

async function bumpExpiry(
  id,
  expiryISO,
  { reason = "expiry", ref, actor, meta } = {}
) {
  await hydrateIfNeeded();
  const { bus } = await getDeps();

  const it = getItemOrThrow(id);
  const next = {
    ...it,
    expiryISO: expiryISO ? String(expiryISO) : "",
    updatedAtISO: nowISO(),
  };
  _mem.items.set(next.id, next);

  const txn = pushTxn(bus, {
    type: "expiry",
    itemId: next.id,
    delta: 0,
    qtyBefore: toNumber(it.qty, 0),
    qtyAfter: toNumber(next.qty, 0),
    reason,
    ref: safeObj(ref),
    actor: safeObj(actor),
    meta: { ...safeObj(meta), expiryISO: next.expiryISO },
  });

  changed(bus, "bumpExpiry", [next.id], { ref, actor, meta, txnId: txn.id });
  await persistItemsBestEffort();
  await persistTxnsBestEffort();

  return { item: next, txn };
}

async function setLocation(
  id,
  location,
  { reason = "location", ref, actor, meta } = {}
) {
  await hydrateIfNeeded();
  const { bus } = await getDeps();

  const it = getItemOrThrow(id);
  const next = {
    ...it,
    location: normalizeLocation(location),
    updatedAtISO: nowISO(),
  };
  _mem.items.set(next.id, next);

  const txn = pushTxn(bus, {
    type: "location",
    itemId: next.id,
    delta: 0,
    qtyBefore: toNumber(it.qty, 0),
    qtyAfter: toNumber(next.qty, 0),
    reason,
    ref: safeObj(ref),
    actor: safeObj(actor),
    meta: { ...safeObj(meta), location: next.location },
  });

  changed(bus, "setLocation", [next.id], { ref, actor, meta, txnId: txn.id });
  await persistItemsBestEffort();
  await persistTxnsBestEffort();

  return { item: next, txn };
}

async function transfer({
  fromId,
  toId,
  qty,
  reason = "transfer",
  ref,
  actor,
  meta,
} = {}) {
  await hydrateIfNeeded();
  const { bus } = await getDeps();

  const q = Math.abs(toNumber(qty, 0));
  if (!fromId || !toId)
    throw new Error(`[${SOURCE}] transfer requires fromId and toId`);
  if (!q)
    return {
      ok: true,
      transferId: null,
      from: getItemOrThrow(fromId),
      to: getItemOrThrow(toId),
      txns: [],
    };

  const transferId = stableId("xfer");

  const consumeRes = await consume(fromId, q, {
    reason,
    ref: { ...safeObj(ref), transferId },
    actor,
    meta: safeObj(meta),
  });

  const restockRes = await restock(toId, q, {
    reason,
    ref: { ...safeObj(ref), transferId },
    actor,
    meta: safeObj(meta),
  });

  changed(bus, "transfer", [String(fromId), String(toId)], {
    transferId,
    ref,
    actor,
    meta,
  });
  return {
    ok: true,
    transferId,
    from: consumeRes.item,
    to: restockRes.item,
    txns: [consumeRes.txn, restockRes.txn],
  };
}

/**
 * Merge duplicates by moving quantities and optionally consolidating fields.
 * - keepId stays
 * - removeIds consumed into keepId then deleted
 */
async function mergeDuplicates({
  keepId,
  removeIds = [],
  strategy = "sumQty",
  meta,
} = {}) {
  await hydrateIfNeeded();
  const { bus } = await getDeps();

  const keep = getItemOrThrow(keepId);
  const ids = safeArr(removeIds)
    .map(String)
    .filter(Boolean)
    .filter((id) => id !== String(keepId));
  if (!ids.length) return { ok: true, keep, removed: [], mergedQty: 0 };

  let mergedQty = 0;
  let merged = { ...keep };

  for (const rid of ids) {
    const other = _mem.items.get(rid);
    if (!other) continue;

    const oq = toNumber(other.qty, 0);
    if (strategy === "sumQty") {
      mergedQty += oq;
      merged.qty = toNumber(merged.qty, 0) + oq;
    }

    // Light field merge: prefer keep's fields; fill blanks from other
    merged = {
      ...merged,
      brand: merged.brand || other.brand,
      upc: merged.upc || other.upc,
      canonicalName: merged.canonicalName || other.canonicalName,
      category: merged.category || other.category,
      tags: Array.from(
        new Set([...safeArr(merged.tags), ...safeArr(other.tags)])
      ),
      meta: deepMerge(safeObj(other.meta), safeObj(merged.meta)), // keep wins
    };

    _mem.items.delete(rid);
  }

  merged.updatedAtISO = nowISO();
  _mem.items.set(String(keepId), merged);

  // txn note
  pushTxn(bus, {
    type: "merge",
    itemId: String(keepId),
    delta: mergedQty,
    qtyBefore: toNumber(keep.qty, 0),
    qtyAfter: toNumber(merged.qty, 0),
    reason: "mergeDuplicates",
    ref: { keepId: String(keepId), removeIds: ids },
    meta: safeObj(meta),
  });

  changed(bus, "mergeDuplicates", [String(keepId), ...ids], meta);

  await persistItemsBestEffort();
  await persistTxnsBestEffort();

  return { ok: true, keep: merged, removed: ids, mergedQty };
}

/**
 * Commit receipt lines (shopping mode) into inventory.
 * lines: [{ name, qty, unit, upc, brand, price, store, purchasedAtISO, ... }]
 * options:
 *  - match: "upc"|"name"|"upcOrName" (default)
 *  - createIfMissing: true
 *  - receiptId: string
 *  - location: default location object
 */
async function commitReceiptLines(lines, options = {}) {
  await hydrateIfNeeded();
  const { bus } = await getDeps();

  const opts = {
    match: "upcOrName",
    createIfMissing: true,
    receiptId: options.receiptId ? String(options.receiptId) : stableId("rcpt"),
    location: options.location || null,
    actor: options.actor || null,
    purchasedAtISO: options.purchasedAtISO || nowISO(),
    meta: safeObj(options.meta),
  };

  const all = Array.from(_mem.items.values());
  const updates = [];
  const created = [];
  const txns = [];

  function findMatch(line) {
    const upc = line?.upc
      ? String(line.upc)
      : line?.barcode
      ? String(line.barcode)
      : "";
    const name = line?.name
      ? String(line.name)
      : line?.title
      ? String(line.title)
      : "";
    const cname = keyOf(name);

    if (opts.match === "upc" && upc)
      return all.find((i) => String(i.upc || "") === upc) || null;
    if (opts.match === "name")
      return (
        all.find((i) => keyOf(i.canonicalName || i.name) === cname) || null
      );

    // upcOrName
    if (upc) {
      const hit = all.find((i) => String(i.upc || "") === upc);
      if (hit) return hit;
    }
    if (name) {
      const hit = all.find((i) => keyOf(i.canonicalName || i.name) === cname);
      if (hit) return hit;
    }
    return null;
  }

  for (const raw of safeArr(lines)) {
    const line = safeObj(raw);
    const qty = Math.abs(toNumber(line.qty ?? line.quantity ?? 1, 1));
    const unit = line.unit
      ? String(line.unit)
      : line.uom
      ? String(line.uom)
      : "each";

    const match = findMatch(line);

    if (match) {
      const before = toNumber(match.qty, 0);
      const after = before + qty;

      const next = {
        ...match,
        name: match.name || String(line.name || line.title || match.name || ""),
        canonicalName:
          match.canonicalName ||
          String(line.name || line.title || match.canonicalName || ""),
        brand: match.brand || (line.brand ? String(line.brand) : ""),
        upc:
          match.upc ||
          (line.upc
            ? String(line.upc)
            : line.barcode
            ? String(line.barcode)
            : ""),
        unit: match.unit || unit,
        qty: after,
        location: opts.location
          ? normalizeLocation(opts.location)
          : match.location,
        cost: (() => {
          const price = toNumber(
            line.price ?? line.unitPrice ?? line.cost,
            undefined
          );
          if (!Number.isFinite(price)) return match.cost || {};
          const existingCost = safeObj(match.cost);
          return {
            ...existingCost,
            last: price,
            currency: existingCost.currency || "USD",
          };
        })(),
        updatedAtISO: nowISO(),
        meta: deepMerge(safeObj(match.meta), {
          lastReceipt: {
            receiptId: opts.receiptId,
            purchasedAtISO: opts.purchasedAtISO,
            store: line.store || line.vendor || "",
          },
        }),
      };

      _mem.items.set(next.id, next);
      updates.push(next.id);

      txns.push(
        pushTxn(bus, {
          type: "receipt",
          itemId: next.id,
          delta: qty,
          qtyBefore: before,
          qtyAfter: after,
          reason: "receipt_commit",
          ref: {
            receiptId: opts.receiptId,
            lineId: line.lineId || line.id || null,
            store: line.store || line.vendor || null,
          },
          actor: safeObj(opts.actor),
          meta: deepMerge(opts.meta, {
            unit,
            qty,
            price: line.price ?? line.unitPrice ?? null,
          }),
        })
      );
    } else if (opts.createIfMissing) {
      const createdItem = normalizeItem(
        {
          id: stableId("inv"),
          name: String(line.name || line.title || "Item"),
          canonicalName: String(line.name || line.title || "Item"),
          brand: line.brand ? String(line.brand) : "",
          upc: line.upc
            ? String(line.upc)
            : line.barcode
            ? String(line.barcode)
            : "",
          qty,
          unit,
          location: opts.location
            ? normalizeLocation(opts.location)
            : normalizeLocation(line.location),
          cost: (() => {
            const price = toNumber(
              line.price ?? line.unitPrice ?? line.cost,
              undefined
            );
            if (!Number.isFinite(price)) return {};
            return { last: price, currency: "USD" };
          })(),
          category: line.category ? String(line.category) : "",
          tags: safeArr(line.tags),
          meta: deepMerge(opts.meta, {
            createdFromReceipt: true,
            lastReceipt: {
              receiptId: opts.receiptId,
              purchasedAtISO: opts.purchasedAtISO,
              store: line.store || line.vendor || "",
            },
          }),
        },
        { keepId: true }
      );

      _mem.items.set(createdItem.id, createdItem);
      created.push(createdItem.id);

      txns.push(
        pushTxn(bus, {
          type: "receipt_create",
          itemId: createdItem.id,
          delta: qty,
          qtyBefore: 0,
          qtyAfter: qty,
          reason: "receipt_commit_create",
          ref: {
            receiptId: opts.receiptId,
            lineId: line.lineId || line.id || null,
            store: line.store || line.vendor || null,
          },
          actor: safeObj(opts.actor),
          meta: deepMerge(opts.meta, {
            unit,
            qty,
            price: line.price ?? line.unitPrice ?? null,
          }),
        })
      );
    }
  }

  changed(bus, "commitReceiptLines", [...updates, ...created], {
    receiptId: opts.receiptId,
    updated: updates.length,
    created: created.length,
  });

  await persistItemsBestEffort();
  await persistTxnsBestEffort();

  return {
    ok: true,
    receiptId: opts.receiptId,
    updatedIds: updates,
    createdIds: created,
    txns,
  };
}

/* -----------------------------------------------------------------------------
 * Exports
 * -------------------------------------------------------------------------- */

const InventoryMutations = {
  // CRUD
  upsertItem,
  putMany,
  removeItem,

  // qty operations
  adjustQty,
  setQty,
  consume,
  restock,

  // attribute operations
  bumpExpiry,
  setLocation,

  // compound
  transfer,
  mergeDuplicates,
  commitReceiptLines,

  // utilities (for diagnostics)
  async _hydrate() {
    await hydrateIfNeeded();
    return {
      hydrated: _mem.hydrated,
      count: _mem.items.size,
      txnCount: _mem.txns.length,
    };
  },
  async _dump() {
    await hydrateIfNeeded();
    return {
      items: Array.from(_mem.items.values()),
      txns: safeArr(_mem.txns),
    };
  },
};

export default InventoryMutations;
export {
  InventoryMutations,
  upsertItem,
  putMany,
  removeItem,
  adjustQty,
  setQty,
  consume,
  restock,
  bumpExpiry,
  setLocation,
  transfer,
  mergeDuplicates,
  commitReceiptLines,
};
