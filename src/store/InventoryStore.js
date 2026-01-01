// C:\Users\larho\suka-smart-assistant\src\store\InventoryStore.js
/**
 * InventoryStore (v3) — dynamic, resilient, household-aware
 * ----------------------------------------------------------
 * Unified inventory for pantry, cleaning, garden preservation & animal care.
 *
 * NEW IN v3
 * - Lots with expiries & cost: FIFO issue, reserve/commit lot-aware
 * - Undo/Redo (local, non-persisted)
 * - Substitutions & normalization via IngredientsIndex (optional)
 * - Price history & vendor hints; smarter restock planning
 * - Unit-safe convert/scale on all flows
 * - Event taps for orchestrators/automations; Dexie import/merge
 */

import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { v4 as uuidv4 } from "uuid";

/* ---------------------------------------------
   Safe dynamic imports & shims
----------------------------------------------*/
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try {
      // @vite-ignore
      const mod = await import(p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}
async function DB() { return await safeImportMany(["@/db/index.js", "@/db", "../db", "../../db"]); }
async function Units() { return await safeImportMany(["@/shared/units.js", "@/shared/units"]); }
async function IngredientsIndex() { return await safeImportMany(["@/store/IngredientsIndex.js", "@/store/IngredientsIndex"]); }
async function n8nClient() { return await safeImportMany(["@/services/n8nClient.js", "@/services/n8nClient"]); }
async function Ontology() { return await safeImportMany(["@/shared/ontology.js", "@/shared/ontology"]); }

function nowISO() { return new Date().toISOString(); }
function titleCase(s = "") { return s.replace(/\b\w/g, (m) => m.toUpperCase()); }
function toKeyish(str = "") { return String(str).toLowerCase().trim().replace(/[^\w\s.-]/g, "").replace(/\s+/g, "."); }
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function safeGetSocket() {
  try {
    // eslint-disable-next-line import/no-unresolved
    const sock = require("@/server/services/socket");
    return sock?.socket || sock?.getSocket?.() || null;
  } catch { return null; }
}
function broadcast(event, payload, ns) {
  try { window.dispatchEvent?.(new CustomEvent(event, { detail: payload })); } catch {}
  try { safeGetSocket()?.emit?.(event, payload); } catch {}
}

/* ---------------------------------------------
   Events (shared with orchestrator if present)
----------------------------------------------*/
let EVENTS = {
  INVENTORY: {
    SURPLUS: "INVENTORY.SURPLUS.DETECTED",
    LOW: "INVENTORY.LOW.DETECTED",
    RESERVED: "INVENTORY.RESERVED",
    DEDUCTED: "INVENTORY.DEDUCTED",
    UPDATED: "INVENTORY.UPDATED",
  },
};
(async () => {
  const ont = await Ontology();
  if (ont?.EVENTS) EVENTS = ont.EVENTS;
})();

/* ---------------------------------------------
   Persistence (Dexie + localStorage)
----------------------------------------------*/
const SNAP_KEY = "suka.inventoryStore.v3";
async function saveSnapshot(snap) {
  const db = await DB();
  try { await db?.userMeta?.put?.({ key: SNAP_KEY, value: snap, updatedAt: nowISO() }); } catch {}
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); } catch {}
}
async function loadSnapshot() {
  const db = await DB();
  try {
    const doc = await db?.userMeta?.get?.({ key: SNAP_KEY });
    if (doc?.value) return doc.value;
  } catch {}
  try { const raw = localStorage.getItem(SNAP_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/* ---------------------------------------------
   Normalization & math
----------------------------------------------*/
// Lot: { lotId, qty, unit, expiresISO?, costPerUnit?, vendor?, source?, addedISO, reserved? }
function normalizeLot(l = {}, baseUnit = "g") {
  return {
    lotId: l.lotId || uuidv4(),
    qty: Math.max(0, Number(l.qty ?? 0)),
    unit: l.unit || baseUnit || "g",
    expiresISO: l.expiresISO || null,
    costPerUnit: Number.isFinite(l.costPerUnit) ? Number(l.costPerUnit) : null,
    vendor: l.vendor || null,
    source: l.source || null,
    addedISO: l.addedISO || nowISO(),
    reserved: Math.max(0, Number(l.reserved ?? 0)),
  };
}

// Item (aggregate over lots)
function normalizeItem(i) {
  const key = toKeyish(i.key || i.name);
  const lots = Array.isArray(i.lots) ? i.lots.map((l) => normalizeLot(l, i.unit || "g")) : [];
  // Support legacy quantity/reserved on item: fold into one lot
  const legacyQty = Number(i.quantity ?? 0);
  const legacyRes = Number(i.reserved ?? 0);
  if (legacyQty || legacyRes) {
    lots.push(normalizeLot({ qty: legacyQty, reserved: legacyRes, unit: i.unit || "g" }, i.unit || "g"));
  }
  lots.sort((a, b) => new Date(a.expiresISO || "2999-12-31") - new Date(b.expiresISO || "2999-12-31"));

  return {
    key,
    name: i.name || titleCase(key.replace(/\./g, " ")),
    unit: i.unit || "g", // base unit for display/convert
    threshold: Math.max(0, Number(i.threshold ?? 0)),
    category: i.category || "pantry",
    perishDays: i.perishDays != null ? Number(i.perishDays) : null,
    location: i.location || "kitchen", // shelf/bin hints
    barcode: i.barcode || null,
    bins: Array.isArray(i.bins) ? i.bins : [],

    lots,

    // derived aggregates (kept for quick reads; recomputed on write)
    quantity: lots.reduce((a, l) => a + l.qty, 0),
    reserved: lots.reduce((a, l) => a + l.reserved, 0),

    priceHistory: Array.isArray(i.priceHistory) ? i.priceHistory : [], // [{atISO, vendor, unitCost}]
    updatedAtISO: i.updatedAtISO || nowISO(),
    meta: i.meta || {},
  };
}

function roundSmart(n) {
  if (!Number.isFinite(n)) return n;
  if (Math.abs(n) >= 10) return Math.round(n * 10) / 10;
  if (Math.abs(n) >= 1) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}
const cmpAvail = (item) => Math.max(0, (item.quantity || 0) - (item.reserved || 0));
const isLow = (item) => item.threshold > 0 && cmpAvail(item) <= item.threshold;

/** Convert qty u1 → u2 using Units module if available. */
async function convertQty(q, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return q;
  const UnitsMod = await Units();
  const fn = UnitsMod?.convertSafe || UnitsMod?.convert;
  if (typeof fn !== "function") return q;
  const out = fn(q, fromUnit, toUnit);
  return Number.isFinite(out) ? out : q;
}

/* ---------------------------------------------
   Internal helpers
----------------------------------------------*/
function recomputeAggregates(item) {
  const quantity = item.lots.reduce((a, l) => a + l.qty, 0);
  const reserved = item.lots.reduce((a, l) => a + l.reserved, 0);
  return { ...item, quantity, reserved, updatedAtISO: nowISO() };
}

function getKeyCandidate(keyOrName, items) {
  if (!keyOrName) return null;
  const s = String(keyOrName);
  if (items[s]) return s;
  const keyish = toKeyish(s);
  if (items[keyish]) return keyish;
  const match = Object.keys(items).find((k) => items[k].name?.toLowerCase() === s.toLowerCase());
  return match || keyish || null;
}

/* ---------------------------------------------
   Store
----------------------------------------------*/
export const useInventoryStore = create((set, get) => ({
  items: /** @type {Record<string, ReturnType<typeof normalizeItem>>} */ ({}),
  holds: /** @type {Record<string, { id: string, lines: any[], createdAtISO: string, reason?: string }>} */ ({}),
  meta:  { lastUpdatedISO: null, hydrated: false, version: 3 },

  /* undo/redo (not persisted) */
  _history: [],
  _future: [],
  _pushHistory: (snap) => {
    const hist = get()._history.slice(-49);
    hist.push(snap);
    set({ _history: hist, _future: [] });
  },

  /* ---------- lifecycle ---------- */
  hydrate: async () => {
    // load v3 or migrate v2 snapshot
    const snap = await loadSnapshot();
    if (snap?.items) {
      const next = {};
      for (const k of Object.keys(snap.items)) next[k] = normalizeItem(snap.items[k]);
      set({ items: next, holds: snap.holds || {}, meta: { lastUpdatedISO: snap.updatedAtISO || nowISO(), hydrated: true, version: 3 } });
    } else {
      set({ meta: { lastUpdatedISO: nowISO(), hydrated: true, version: 3 } });
    }

    // Import from Dexie supplies/pantry as a best-effort merge
    try {
      const db = await DB();
      const supplies = await db?.supplies?.toArray?.() || [];
      const pantry = await db?.pantry?.toArray?.() || [];
      const next = { ...get().items };
      for (const s of [...supplies, ...pantry]) {
        const key = toKeyish(s.key || s.name);
        const prev = next[key] || {};
        next[key] = normalizeItem({
          ...prev,
          key,
          name: s.name || prev.name,
          unit: s.unit || prev.unit || "g",
          threshold: s.threshold ?? prev.threshold ?? 0,
          category: s.category || prev.category || "pantry",
          perishDays: s.perishDays ?? prev.perishDays ?? null,
          lots: [
            ...(prev.lots || []),
            normalizeLot({ qty: Number(s.quantity ?? 0), unit: s.unit || prev.unit || "g", source: "dexie", addedISO: s.updatedAt || nowISO() }, s.unit || "g"),
          ].filter((l) => l.qty > 0),
          priceHistory: prev.priceHistory || [],
          meta: { ...prev.meta, dexie: true },
        });
      }
      set({ items: next });
      await get().persist();
    } catch {}

    broadcast("inventory:hydrated", { at: nowISO(), version: 3 });
  },

  persist: async () => {
    await saveSnapshot({ items: get().items, holds: get().holds, updatedAtISO: nowISO() });
  },

  /* ---------- CRUD (lot-aware) ---------- */
  upsertItem: async (item) => {
    if (!item) return null;
    const n = normalizeItem(item);
    const prev = get().items;
    get()._pushHistory({ items: prev, holds: get().holds });
    set({ items: { ...prev, [n.key]: n }, meta: { ...get().meta, lastUpdatedISO: nowISO() } });
    await get().persist();
    broadcast(EVENTS.INVENTORY.UPDATED, { key: n.key });
    return n;
  },

  addLot: async (keyOrName, lot = {}) => {
    const key = getKeyCandidate(keyOrName, get().items);
    if (!key) return null;
    const prev = get().items[key] || normalizeItem({ key, name: key });
    const lotN = normalizeLot(lot, prev.unit);
    const next = recomputeAggregates({ ...prev, lots: [...prev.lots, lotN].sort((a,b)=> new Date(a.expiresISO||"2999")-new Date(b.expiresISO||"2999")) });
    get()._pushHistory({ items: get().items, holds: get().holds });
    set((s) => ({ items: { ...s.items, [key]: next }, meta: { ...s.meta, lastUpdatedISO: nowISO() } }));
    await get().persist();
    broadcast(EVENTS.INVENTORY.UPDATED, { key, lotId: lotN.lotId, action: "addLot" });
    return lotN;
  },

  adjustQuantity: async (keyOrName, delta, { unit = null, reason = "manual", expiresISO = null, costPerUnit = null, vendor = null } = {}) => {
    // Positive delta → add lot; negative delta → consume from FIFO lots
    const key = getKeyCandidate(keyOrName, get().items);
    const baseUnit = (get().items[key]?.unit) || "g";
    let adj = Number(delta || 0);
    if (unit) adj = await convertQty(adj, unit, baseUnit);

    if (!key) return null;
    const prev = get().items[key] || normalizeItem({ key, name: key, unit: baseUnit });

    get()._pushHistory({ items: get().items, holds: get().holds });

    if (adj > 0) {
      // Add as a lot so we preserve expiry & pricing
      const lot = normalizeLot({ qty: adj, unit: baseUnit, expiresISO, costPerUnit, vendor, source: reason }, baseUnit);
      const next = recomputeAggregates({ ...prev, lots: [...prev.lots, lot].sort((a,b)=> new Date(a.expiresISO||"2999")-new Date(b.expiresISO||"2999")) });
      // optional price track
      if (Number.isFinite(costPerUnit)) {
        next.priceHistory = [...(next.priceHistory||[]), { atISO: nowISO(), vendor: vendor || null, unitCost: Number(costPerUnit) }];
      }
      set((s) => ({ items: { ...s.items, [key]: next }, meta: { ...s.meta, lastUpdatedISO: nowISO() } }));
      await get().persist();
      broadcast("inventory:delta", { lines: [{ key, qty: roundSmart(adj), unit: baseUnit, reason }], at: nowISO() });
      if (next.quantity > (next.threshold || 0) * 3) broadcast(EVENTS.INVENTORY.SURPLUS, { key, quantity: next.quantity, unit: baseUnit });
      if (isLow(next)) broadcast(EVENTS.INVENTORY.LOW, { key, available: cmpAvail(next), threshold: next.threshold });
      return next;
    } else if (adj < 0) {
      // Consume from earliest-expiring lots first
      let take = Math.abs(adj);
      const lots = prev.lots.map((l) => ({ ...l })); // clone
      for (const l of lots) {
        const avail = Math.max(0, l.qty - l.reserved);
        if (avail <= 0) continue;
        const use = Math.min(avail, take);
        l.qty = roundSmart(l.qty - use);
        take = roundSmart(take - use);
        if (take <= 0) break;
      }
      const filtered = lots.filter((l) => l.qty > 0 || l.reserved > 0);
      const next = recomputeAggregates({ ...prev, lots: filtered });
      set((s) => ({ items: { ...s.items, [key]: next }, meta: { ...s.meta, lastUpdatedISO: nowISO() } }));
      await get().persist();
      broadcast("inventory:delta", { lines: [{ key, qty: roundSmart(adj), unit: baseUnit, reason }], at: nowISO() });
      if (isLow(next)) broadcast(EVENTS.INVENTORY.LOW, { key, available: cmpAvail(next), threshold: next.threshold });
      return next;
    }
    return prev;
  },

  setThreshold: async (keyOrName, threshold) => {
    const key = getKeyCandidate(keyOrName, get().items);
    if (!key) return false;
    const cur = get().items[key];
    const next = { ...cur, threshold: Math.max(0, Number(threshold || 0)), updatedAtISO: nowISO() };
    get()._pushHistory({ items: get().items, holds: get().holds });
    set((s) => ({ items: { ...s.items, [key]: next } }));
    await get().persist();
    if (isLow(next)) broadcast(EVENTS.INVENTORY.LOW, { key, available: cmpAvail(next), threshold: next.threshold });
    return true;
  },

  setLocation: async (keyOrName, location, bins = []) => {
    const key = getKeyCandidate(keyOrName, get().items);
    if (!key) return false;
    const cur = get().items[key] || normalizeItem({ key, name: key });
    const next = { ...cur, location: location || cur.location, bins: Array.isArray(bins) ? bins : cur.bins, updatedAtISO: nowISO() };
    get()._pushHistory({ items: get().items, holds: get().holds });
    set((s) => ({ items: { ...s.items, [key]: next } }));
    await get().persist();
    broadcast(EVENTS.INVENTORY.UPDATED, { key, action: "setLocation" });
    return true;
  },

  /* ---------- Reservations (lot & unit aware) ---------- */
  reserveItems: async ({ lines = [], reason = "reserve" } = {}) => {
    // lines: [{ key|name, qty, unit?, reason?, meta? }]
    if (!Array.isArray(lines) || !lines.length) return { ok: false, reason: "empty" };
    const holdId = uuidv4();
    const items = { ...get().items };
    const applied = [];

    for (const raw of lines) {
      const key = getKeyCandidate(raw.key || raw.name, items) || toKeyish(raw.key || raw.name);
      const cur = items[key] || normalizeItem({ key, name: key });
      const baseUnit = cur.unit || "g";
      let q = Number(raw.qty || 0);
      let u = raw.unit || baseUnit;
      q = await convertQty(q, u, baseUnit);

      // Reserve FIFO by earliest-expiring lot
      let need = q;
      const nextLots = cur.lots.map((l) => ({ ...l }));
      for (const l of nextLots) {
        const avail = Math.max(0, l.qty - l.reserved);
        if (avail <= 0) continue;
        const take = Math.min(avail, need);
        l.reserved = roundSmart(l.reserved + take);
        need = roundSmart(need - take);
        applied.push({ key, lotId: l.lotId, qty: take, unit: baseUnit, reason: raw.reason || reason, meta: raw.meta || {} });
        if (need <= 0) break;
      }
      items[key] = recomputeAggregates({ ...cur, lots: nextLots });
    }

    set((s) => ({ items, holds: { ...s.holds, [holdId]: { id: holdId, lines: applied, reason, createdAtISO: nowISO() } } }));
    await get().persist();

    broadcast(EVENTS.INVENTORY.RESERVED, { id: holdId, lines: applied });
    return { ok: true, id: holdId, lines: applied };
  },

  releaseHold: async (holdId) => {
    const hold = get().holds[holdId];
    if (!hold) return { ok: false, reason: "not_found" };

    const items = { ...get().items };
    for (const l of hold.lines) {
      const cur = items[l.key];
      if (!cur) continue;
      const lots = cur.lots.map((x) => x.lotId === l.lotId ? { ...x, reserved: Math.max(0, roundSmart(x.reserved - l.qty)) } : x);
      items[l.key] = recomputeAggregates({ ...cur, lots });
    }
    const holds = { ...get().holds }; delete holds[holdId];
    get()._pushHistory({ items: get().items, holds: get().holds });
    set({ items, holds });
    await get().persist();
    broadcast("inventory:hold:released", { id: holdId });
    return { ok: true };
  },

  commitHold: async (holdId, { reason = "deduct" } = {}) => {
    const hold = get().holds[holdId];
    if (!hold) return { ok: false, reason: "not_found" };

    const items = { ...get().items };
    for (const l of hold.lines) {
      const cur = items[l.key] || normalizeItem({ key: l.key, name: l.key, unit: l.unit });
      const lots = cur.lots.map((x) => {
        if (x.lotId !== l.lotId) return x;
        const nextReserved = Math.max(0, roundSmart(x.reserved - l.qty));
        const nextQty = Math.max(0, roundSmart(x.qty - l.qty));
        return { ...x, reserved: nextReserved, qty: nextQty };
      }).filter((x) => x.qty > 0 || x.reserved > 0);
      items[l.key] = recomputeAggregates({ ...cur, lots });
    }
    const holds = { ...get().holds }; delete holds[holdId];

    get()._pushHistory({ items: get().items, holds: get().holds });
    set({ items, holds });
    await get().persist();

    broadcast(EVENTS.INVENTORY.DEDUCTED, { id: holdId, lines: hold.lines, reason });

    // Optional Dexie write-through (best effort)
    try {
      const db = await DB();
      for (const l of hold.lines) {
        const cur = items[l.key];
        const rec = await db?.supplies?.get?.({ key: l.key }) || await db?.pantry?.get?.({ key: l.key });
        if (rec) {
          rec.quantity = cur.quantity;
          rec.updatedAt = nowISO();
          if (rec.id) await db?.supplies?.put?.(rec).catch(() => {});
        }
      }
    } catch {}

    return { ok: true, lines: hold.lines };
  },

  /* ---------- Recipe/Import helpers ---------- */
  /** Generate reservation lines from ingredients via IngredientsIndex (w/ substitutions). */
  reserveForIngredients: async (ingredients = [], { scale = 1, reason = "recipes", allowSubs = true } = {}) => {
    const idx = await IngredientsIndex();
    const lines = await idx?.toInventoryLines?.(ingredients, { scale, reason, allowSubs }) || [];
    return await get().reserveItems({ lines, reason });
  },

  reserveForRecipe: async (recipe, { scale = 1, reason = "recipe" } = {}) => {
    if (!recipe?.ingredients?.length) return { ok: false, reason: "no_ingredients" };
    return await get().reserveForIngredients(recipe.ingredients, { scale, reason });
  },

  /* ---------- Surplus / Low detection & restock ---------- */
  detectSurplusLow: () => {
    const low = [];
    const surplus = [];
    for (const k of Object.keys(get().items)) {
      const it = get().items[k];
      if (isLow(it)) low.push({ key: k, name: it.name, available: cmpAvail(it), threshold: it.threshold, unit: it.unit });
      if (it.threshold > 0 && it.quantity > it.threshold * 3) {
        surplus.push({ key: k, name: it.name, quantity: it.quantity, unit: it.unit });
      }
    }
    if (low.length) broadcast(EVENTS.INVENTORY.LOW, { items: low });
    if (surplus.length) broadcast(EVENTS.INVENTORY.SURPLUS, { items: surplus });
    return { low, surplus };
  },

  /** Smarter restock: propose pack sizes & vendors using priceHistory. */
  suggestRestockList: ({ cap = 40 } = {}) => {
    const out = [];
    for (const k of Object.keys(get().items)) {
      const it = get().items[k];
      if (!isLow(it)) continue;
      const need = Math.max(0, (it.threshold || 0) * 2 - cmpAvail(it)); // aim to 2x threshold
      if (need <= 0) continue;

      // Find best vendor (lowest recent unitCost)
      const cheapest = (it.priceHistory || [])
        .slice().sort((a, b) => (a.unitCost ?? 1e9) - (b.unitCost ?? 1e9))[0];

      // Heuristic pack suggestion: round to sensible pack sizes (e.g., 250g, 500g, 1kg / 6, 12, 24)
      const unit = it.unit || "g";
      let pack = need;
      if (unit === "g" || unit === "ml") {
        const steps = [250, 500, 1000, 2000, 5000];
        pack = steps.find((s) => s >= need) || Math.ceil(need / 5000) * 5000;
      } else {
        const steps = [1, 6, 12, 24];
        pack = steps.find((s) => s >= need) || Math.ceil(need / 24) * 24;
      }

      out.push({
        key: k, name: it.name, qty: roundSmart(pack), unit,
        reason: "low", vendor: cheapest?.vendor || null, estUnitCost: cheapest?.unitCost || null
      });
    }
    // sort by severity (lowest availability first)
    out.sort((a, b) => (a.qty || 0) - (b.qty || 0));
    return out.slice(0, cap);
  },

  /* ---------- Audits ---------- */
  auditSnapshot: () => {
    const items = get().items;
    const totals = Object.values(items).reduce((acc, it) => {
      const cat = it.category || "general";
      acc[cat] = acc[cat] || { count: 0, low: 0, soonExpiring: 0 };
      acc[cat].count += 1;
      if (isLow(it)) acc[cat].low += 1;
      const soon = it.lots.some((l) => l.expiresISO && (new Date(l.expiresISO) - Date.now()) <= 1000 * 60 * 60 * 24 * 7);
      if (soon) acc[cat].soonExpiring += 1;
      return acc;
    }, {});
    return { totals, timestamp: nowISO() };
  },

  /* ---------- Selectors ---------- */
  getByCategory: (category) =>
    Object.values(get().items).filter((i) => i.category === category),

  search: (query) => {
    const q = String(query || "").toLowerCase();
    if (!q) return [];
    const results = [];
    for (const it of Object.values(get().items)) {
      const hay = [it.key, it.name, it.location, ...(it.meta?.aliases || [])].map((x) => String(x).toLowerCase());
      if (hay.some((h) => h.includes(q))) results.push(it);
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  },

  /* ---------- n8n utilities (optional) ---------- */
  exportToN8n: async ({ workflowName = "Suka: Inventory Snapshot" } = {}) => {
    try {
      const n8n = await n8nClient();
      const payload = { items: get().items, at: nowISO() };
      if (typeof n8n?.runWorkflowByName === "function") {
        return await n8n.runWorkflowByName(workflowName, payload, { waitForFinish: false });
      }
      return await n8n?.runWorkflow?.("inventory-snapshot", payload, { waitForFinish: false });
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  /* ---------- Undo / Redo ---------- */
  undo: async () => {
    const hist = get()._history.slice();
    if (!hist.length) return;
    const snap = hist.pop();
    const curr = { items: get().items, holds: get().holds };
    const future = get()._future.slice();
    future.push(curr);
    set({ items: snap.items, holds: snap.holds, _history: hist, _future: future });
    await get().persist();
    broadcast("inventory:undo", {});
  },

  redo: async () => {
    const future = get()._future.slice();
    if (!future.length) return;
    const next = future.pop();
    const hist = get()._history.slice();
    hist.push({ items: get().items, holds: get().holds });
    set({ items: next.items, holds: next.holds, _history: hist, _future: future });
    await get().persist();
    broadcast("inventory:redo", {});
  },
}));

/* ---------------------------------------------
   Selector helpers (optional, ergonomic)
----------------------------------------------*/
export const useInventoryItems = () =>
  useInventoryStore((s) => s.items, shallow);

export const useInventoryActions = () =>
  useInventoryStore(
    (s) => ({
      hydrate: s.hydrate,
      persist: s.persist,
      // CRUD
      upsertItem: s.upsertItem,
      addLot: s.addLot,
      adjustQuantity: s.adjustQuantity,
      setThreshold: s.setThreshold,
      setLocation: s.setLocation,
      // reservations
      reserveItems: s.reserveItems,
      releaseHold: s.releaseHold,
      commitHold: s.commitHold,
      reserveForIngredients: s.reserveForIngredients,
      reserveForRecipe: s.reserveForRecipe,
      // insights
      detectSurplusLow: s.detectSurplusLow,
      suggestRestockList: s.suggestRestockList,
      auditSnapshot: s.auditSnapshot,
      getByCategory: s.getByCategory,
      search: s.search,
      // n8n
      exportToN8n: s.exportToN8n,
      // undo/redo
      undo: s.undo,
      redo: s.redo,
    }),
    shallow
  );

/* ---------------------------------------------
   Auto-hydrate on import (non-blocking)
----------------------------------------------*/
useInventoryStore.getState().hydrate?.();
