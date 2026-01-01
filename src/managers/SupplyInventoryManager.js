// src/managers/SupplyInventoryManager.js

import Dexie from "dexie";
import SupplyInventory from "../models/SupplyInventory";

/* -----------------------------------------------------------------------------
 * DB setup (v1 -> v2)
 * -------------------------------------------------------------------------- */
const db = new Dexie("SukaInventoryDB");

// v1 (original)
db.version(1).stores({
  supplies: "id, name, category, quantity, threshold, location, tags",
});

// v2: richer indexes + usage logs for forecasting
db.version(2).stores({
  supplies:
    "id, name, category, location, autoRestock, vendor, sku, tags, quantity, threshold, lastUpdated",
  usageLogs: "++id, supplyId, atISO, delta, reason",
}).upgrade(async (tx) => {
  // Backfill missing fields on existing supplies
  const table = tx.table("supplies");
  const all = await table.toArray();
  await Promise.all(
    all.map((s) =>
      table.put({
        ...s,
        unit: s.unit || "",
        autoRestock: s.autoRestock ?? false,
        lastUpdated: s.lastUpdated || new Date(),
        meta: s.meta || {},
      })
    )
  );
});

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */
const hasWindow = () => typeof window !== "undefined";
const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString());
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toNum = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const safeArr = (v) => (Array.isArray(v) ? v : []);
const hasAnyTag = (item, tags) => safeArr(item?.tags).some((t) => tags.includes(t));

function emitUpdated(topic = "INVENTORY:SUPPLIES_UPDATED", payload = {}) {
  try {
    const s = hasWindow() ? window.__SUKA_SOCKET__ : null;
    if (s?.connected) s.emit(topic, { at: iso(), ...payload });
  } catch { /* noop */ }
}

/* -----------------------------------------------------------------------------
 * Daily-use estimation & restock helpers
 * -------------------------------------------------------------------------- */

/** Estimate average daily usage from last N days of usage logs. */
async function estimateDailyUse(supplyId, { windowDays = 30 } = {}) {
  try {
    const sinceISO = iso(new Date(Date.now() - windowDays * 86400000));
    const rows = await db.usageLogs
      .where("supplyId")
      .equals(supplyId)
      .toArray();

    const recent = rows.filter((r) => r.atISO >= sinceISO);
    // We log negative deltas for consumption; use absolute consumption
    const consumed = recent
      .filter((r) => (r.delta ?? 0) < 0)
      .reduce((s, r) => s + Math.abs(r.delta), 0);

    const days = Math.max(1, windowDays);
    const perDay = consumed / days;

    if (Number.isFinite(perDay) && perDay > 0) return perDay;
  } catch { /* fall through */ }

  // Heuristic fallback by tags/category
  const item = await db.supplies.get(supplyId);
  if (!item) return 0.05;
  if (hasAnyTag(item, ["animal-feed", "feed"])) return 1;     // 1 unit/day
  if (hasAnyTag(item, ["cleaning", "soap"])) return 0.1;
  if (hasAnyTag(item, ["pantry", "staple"])) return 0.2;
  return 0.05;
}

function priorityFromStock(qty, threshold) {
  const th = toNum(threshold, 0);
  const q = toNum(qty, 0);
  const ratio = th > 0 ? q / th : 1;

  let score =
    ratio <= 0.1 ? 95 :
    ratio <= 0.25 ? 75 :
    ratio <= 0.5 ? 50 :
    20;

  let label = "low";
  if (score >= 90) label = "urgent";
  else if (score >= 60) label = "high";
  else if (score >= 30) label = "medium";

  return { label, score, ratio };
}

async function suggestRestock(item, { daysCover = 14 } = {}) {
  const daily = await estimateDailyUse(item.id);
  const needToThreshold = Math.max(0, toNum(item.threshold) - toNum(item.quantity));
  const cover = Math.ceil(daily * daysCover);
  const target = Math.max(needToThreshold, Math.ceil(toNum(item.threshold) * 1.5), cover);
  return {
    suggestedQty: Math.max(1, target),
    unit: item.unit || "",
    dailyUse: daily,
  };
}

function runoutDate(qty, dailyUse) {
  if (!dailyUse || dailyUse <= 0) return null;
  const daysLeft = qty / dailyUse;
  return iso(new Date(Date.now() + daysLeft * 86400000));
}

/* -----------------------------------------------------------------------------
 * Core Manager (backward compatible + new helpers)
 * -------------------------------------------------------------------------- */
const SupplyInventoryManager = {
  // Add new supply
  async addSupply(supplyData) {
    const item = new SupplyInventory(supplyData);
    // normalize basics
    item.quantity = toNum(item.quantity, 0);
    item.threshold = toNum(item.threshold, 0);
    item.tags = safeArr(item.tags);
    item.lastUpdated = new Date();
    await db.supplies.put(item);
    emitUpdated();
    return item;
  },

  // Bulk upsert (new)
  async bulkUpsert(list = []) {
    const normalized = list.map((raw) => {
      const item = new SupplyInventory(raw);
      item.quantity = toNum(item.quantity, 0);
      item.threshold = toNum(item.threshold, 0);
      item.tags = safeArr(item.tags);
      item.lastUpdated = new Date();
      return item;
    });
    await db.supplies.bulkPut(normalized);
    emitUpdated();
    return normalized.length;
  },

  // Get all supplies
  async getAllSupplies() {
    return await db.supplies.toArray();
  },

  // Get single supply by ID
  async getSupplyById(id) {
    return await db.supplies.get(id);
  },

  // Loose lookup (new): by name (case/space-insensitive)
  async findByNameLoose(name) {
    if (!name) return null;
    const needle = String(name).trim().toLowerCase().replace(/\s+/g, " ");
    const all = await db.supplies.toArray();
    return (
      all.find(
        (s) =>
          (s.name || "").toLowerCase().replace(/\s+/g, " ") === needle ||
          (s.alias || "").toLowerCase().replace(/\s+/g, " ") === needle
      ) || null
    );
  },

  // Update quantity (absolute amount) + usage log
  async updateQuantity(id, amount, { reason = "adjust" } = {}) {
    const item = await db.supplies.get(id);
    if (item) {
      const prev = toNum(item.quantity, 0);
      const nextVal = toNum(amount, prev);
      const delta = nextVal - prev;
      item.quantity = nextVal;
      item.lastUpdated = new Date();
      await db.supplies.put(item);
      if (delta !== 0) {
        await db.usageLogs.add({
          supplyId: id,
          delta, // positive = added, negative = consumed
          atISO: iso(),
          reason,
        });
      }
      emitUpdated();
    }
    return item;
  },

  // Decrease quantity (consumption) + log
  async decreaseSupply(id, amount = 1, { reason = "consume" } = {}) {
    const item = await db.supplies.get(id);
    if (item) {
      const prev = toNum(item.quantity, 0);
      const dec = Math.max(0, toNum(amount, 1));
      const nextVal = Math.max(0, prev - dec);
      item.quantity = nextVal;
      item.lastUpdated = new Date();
      await db.supplies.put(item);
      await db.usageLogs.add({ supplyId: id, delta: -dec, atISO: iso(), reason });
      emitUpdated();
    }
    return item;
  },

  // Increase quantity (restock/produce) + log
  async increaseSupply(id, amount = 1, { reason = "restock" } = {}) {
    const item = await db.supplies.get(id);
    if (item) {
      const inc = Math.max(0, toNum(amount, 1));
      item.quantity = toNum(item.quantity, 0) + inc;
      item.lastUpdated = new Date();
      await db.supplies.put(item);
      await db.usageLogs.add({ supplyId: id, delta: inc, atISO: iso(), reason });
      emitUpdated();
    }
    return item;
  },

  // Remove supply
  async removeSupply(id) {
    await db.supplies.delete(id);
    emitUpdated();
    return true;
  },

  // Clear all inventory (use cautiously!)
  async clearAll() {
    await db.supplies.clear();
    await db.usageLogs.clear();
    emitUpdated();
    return true;
  },

  // Filter supplies by tag or category
  async filterSupplies({ tag = "", category = "", tagsAny = [] } = {}) {
    let results = await db.supplies.toArray();
    if (tag) results = results.filter((s) => safeArr(s.tags).includes(tag));
    if (tagsAny?.length) results = results.filter((s) => safeArr(s.tags).some((t) => tagsAny.includes(t)));
    if (category) results = results.filter((s) => s.category === category);
    return results;
  },

  // Backup to localStorage (optional fallback)
  async backupToLocal() {
    const supplies = await db.supplies.toArray();
    const usage = await db.usageLogs.toArray();
    localStorage.setItem("suka_supplies_backup", JSON.stringify({ supplies, usage, at: iso() }));
    return true;
  },

  // Restore from localStorage  ✅ fixed signature
  async restoreFromLocal() {
    const raw = localStorage.getItem("suka_supplies_backup");
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    const supplies = parsed?.supplies || [];
    const usage = parsed?.usage || [];
    await db.transaction("rw", db.supplies, db.usageLogs, async () => {
      await db.supplies.clear();
      await db.usageLogs.clear();
      if (supplies.length) await db.supplies.bulkPut(supplies);
      if (usage.length) await db.usageLogs.bulkPut(usage);
    });
    emitUpdated();
    return supplies.length;
  },

  /* -------------------------- NEW: insights & queues ------------------------ */

  /** Low-stock scan with priority, run-out forecast, and suggestedQty. */
  async scanLowStock() {
    const all = await db.supplies.toArray();
    const lows = all.filter((it) => toNum(it.quantity) <= toNum(it.threshold));
    const out = [];
    for (const item of lows) {
      const { label, score, ratio } = priorityFromStock(item.quantity, item.threshold);
      const { suggestedQty, unit, dailyUse } = await suggestRestock(item);
      out.push({
        ...item,
        priority: label,
        priorityScore: score,
        ratio,
        suggestedQty,
        suggestedUnit: unit,
        estDailyUse: dailyUse,
        runoutISO: runoutDate(toNum(item.quantity), dailyUse),
      });
    }
    // sort by priority desc, earliest runout first
    out.sort((a, b) => {
      if ((b.priorityScore || 0) !== (a.priorityScore || 0))
        return (b.priorityScore || 0) - (a.priorityScore || 0);
      const ad = a.runoutISO ? new Date(a.runoutISO) : new Date(8640000000000000);
      const bd = b.runoutISO ? new Date(b.runoutISO) : new Date(8640000000000000);
      return ad - bd;
    });
    return out;
  },

  /** Reorder lines ready for PO/CSV. */
  async suggestReorderLines() {
    const lows = await this.scanLowStock();
    return lows.map((x) => ({
      sku: x.sku || x.id,
      name: x.name,
      qty: x.suggestedQty,
      unit: x.suggestedUnit || x.unit || "",
      vendor: x.vendor || "",
      notes: x.location ? `For ${x.location}` : "",
    }));
  },

  /** Forecast for a single item. */
  async getUsageForecast(id) {
    const item = await db.supplies.get(id);
    if (!item) return null;
    const daily = await estimateDailyUse(id);
    return {
      id,
      name: item.name,
      estDailyUse: daily,
      runoutISO: runoutDate(toNum(item.quantity), daily),
      daysLeft: daily > 0 ? +(toNum(item.quantity) / daily).toFixed(1) : null,
    };
  },

  /** Toggle autoRestock flag or set true/false explicitly. */
  async markAutoRestock(id, flag = true) {
    const item = await db.supplies.get(id);
    if (!item) return 0;
    item.autoRestock = !!flag;
    item.lastUpdated = new Date();
    await db.supplies.put(item);
    emitUpdated();
    return 1;
  },

  /** Smart threshold: set to N days of cover from current daily use. */
  async setThresholdSmart(id, daysCover = 14) {
    const item = await db.supplies.get(id);
    if (!item) return 0;
    const daily = await estimateDailyUse(id);
    const next = Math.ceil(daily * daysCover);
    item.threshold = next;
    item.lastUpdated = new Date();
    await db.supplies.put(item);
    emitUpdated();
    return next;
  },

  /** CSV export (supplies only) */
  async exportCSV() {
    const rows = await db.supplies.toArray();
    const header = [
      "id","name","quantity","unit","threshold","category","location","tags","vendor","sku","autoRestock","lastUpdatedISO"
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push([
        r.id,
        JSON.stringify(r.name ?? ""),
        r.quantity ?? 0,
        JSON.stringify(r.unit ?? ""),
        r.threshold ?? 0,
        JSON.stringify(r.category ?? ""),
        JSON.stringify(r.location ?? ""),
        JSON.stringify((r.tags || []).join("|")),
        JSON.stringify(r.vendor ?? ""),
        JSON.stringify(r.sku ?? ""),
        r.autoRestock ? 1 : 0,
        iso(r.lastUpdated || new Date())
      ].join(","));
    }
    return lines.join("\n");
  },

  /** CSV import (naive); returns count imported/updated */
  async importCSV(text) {
    if (!text) return 0;
    const [head, ...rows] = text.split(/\r?\n/).filter(Boolean);
    const cols = head.split(",");
    const idx = (k) => cols.indexOf(k);
    const parsed = rows.map((line) => {
      const c = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g).map((v) => v.replace(/^"|"$/g, ""));
      const tags = (c[idx("tags")] || "").split("|").filter(Boolean);
      return new SupplyInventory({
        id: c[idx("id")] || undefined,
        name: c[idx("name")] || "",
        quantity: toNum(c[idx("quantity")], 0),
        unit: c[idx("unit")] || "",
        threshold: toNum(c[idx("threshold")], 0),
        category: c[idx("category")] || "general",
        location: c[idx("location")] || "",
        tags,
        vendor: c[idx("vendor")] || "",
        sku: c[idx("sku")] || "",
        autoRestock: c[idx("autoRestock")] === "1",
        lastUpdated: new Date(c[idx("lastUpdatedISO")] || Date.now()),
      });
    });
    await db.supplies.bulkPut(parsed);
    emitUpdated();
    return parsed.length;
  },
};

export default SupplyInventoryManager;

/* ------------------------------------------------------------------
   Adapters expected by agents (kept & enhanced)
   ------------------------------------------------------------------ */

/** Return full inventory array. */
export async function getInventory() {
  try {
    return await SupplyInventoryManager.getAllSupplies();
  } catch (e) {
    console.warn("[SupplyInventoryManager] getInventory failed:", e);
    return [];
  }
}

/** Add a new inventory item; flexible shape. */
export async function addInventoryItem(item = {}) {
  try {
    const data = {
      name: item.name,
      quantity: toNum(item.quantity, 0),
      unit: item.unit || "",
      category: item.category || "general",
      threshold: toNum(item.threshold, 0),
      location: item.location || "",
      tags: safeArr(item.tags),
      vendor: item.vendor || "",
      sku: item.sku || "",
      autoRestock: !!item.autoRestock,
      lastUpdated: new Date(),
      meta: item.meta || {},
    };
    return await SupplyInventoryManager.addSupply(data);
  } catch (e) {
    console.warn("[SupplyInventoryManager] addInventoryItem fallback used:", e);
    return null;
  }
}

/**
 * Update an item by id or name (case-insensitive). Merges patch.
 */
export async function updateInventoryItem(idOrName, patch = {}) {
  try {
    let item = await SupplyInventoryManager.getSupplyById(idOrName);

    if (!item && typeof idOrName === "string") {
      const found = await SupplyInventoryManager.findByNameLoose(idOrName);
      if (found) item = found;
    }

    if (!item) {
      console.warn("[SupplyInventoryManager] updateInventoryItem: item not found", idOrName);
      return null;
    }

    const next = {
      ...item,
      ...patch,
      tags: patch.tags ? safeArr(patch.tags) : item.tags,
      quantity: patch.quantity != null ? toNum(patch.quantity, item.quantity) : item.quantity,
      threshold: patch.threshold != null ? toNum(patch.threshold, item.threshold) : item.threshold,
      lastUpdated: new Date(),
    };
    await db.supplies.put(next);

    // If quantity changed, log usage delta
    const delta = toNum(next.quantity) - toNum(item.quantity);
    if (delta !== 0) {
      await db.usageLogs.add({
        supplyId: next.id,
        delta,
        atISO: iso(),
        reason: delta > 0 ? "adjust-up" : "adjust-down",
      });
    }

    emitUpdated();
    return next;
  } catch (e) {
    console.warn("[SupplyInventoryManager] updateInventoryItem fallback used:", e);
    return null;
  }
}

/** Convenience: consume an amount from an item by id or name. */
export async function consumeInventoryItem(idOrName, amount = 1, reason = "consume") {
  let item = await SupplyInventoryManager.getSupplyById(idOrName);
  if (!item && typeof idOrName === "string") {
    item = await SupplyInventoryManager.findByNameLoose(idOrName);
  }
  if (!item) return null;
  return SupplyInventoryManager.decreaseSupply(item.id, amount, { reason });
}

/** Convenience: produce/add an amount to an item by id or name. */
export async function produceInventoryItem(idOrName, amount = 1, reason = "restock") {
  let item = await SupplyInventoryManager.getSupplyById(idOrName);
  if (!item && typeof idOrName === "string") {
    item = await SupplyInventoryManager.findByNameLoose(idOrName);
  }
  if (!item) return null;
  return SupplyInventoryManager.increaseSupply(item.id, amount, { reason });
}
