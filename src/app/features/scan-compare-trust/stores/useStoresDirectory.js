/* eslint-disable no-console */
// src/features/scan-compare-trust/stores/useStoresDirectory.js
// User-declared stores (name, zip, adapter) + loyalty, favorites, schedules, export/import,
// and adapter registry resolution for Scan • Compare • Trust orchestration.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* -------------------------------- safe deps -------------------------------- */
let eventBus = { emit(){}, on(){}, off(){} };
try { const eb = require("@/services/eventBus"); eventBus = (eb?.default||eb?.eventBus||eb)||eventBus; } catch (_e) {}

let DexieDB = null;
try { DexieDB = require("@/db")?.default || require("@/db"); } catch (_e) {}

let useQuietHours = () => ({ enabled:false });
try { useQuietHours = require("@/hooks/useQuietHours")?.default || useQuietHours; } catch (_e) {}

let useAuth = () => ({ user: null, householdId: null });
try { useAuth = require("@/hooks/useAuth")?.default || useAuth; } catch (_e) {}

let toast = null;
try { toast = (require("@/components/toast")?.toast) || null; } catch (_e) {}

let nanoid = (len=6) => Math.random().toString(36).slice(2, 2+len);
try { nanoid = require("nanoid").nanoid || nanoid; } catch (_e) {}

const nowISO = () => new Date().toISOString();
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const toStr = (v)=> (v==null?"":String(v)).trim();
const US_ZIP_RX = /^\d{5}(?:-\d{4})?$/;

/* --------------------------------- storage --------------------------------- */
const LS_DIR = "storesDirectory:rows:v1";
const LS_ADR = "storesDirectory:adapters:v1";

const memRows = new Map(); // id -> storeRow
const memAdapters = new Map(); // key -> adapterMeta

function lsGet(key, fb) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

/* ----------------------------- Dexie (optional) ---------------------------- */
// Suggested tables (optional):
// - DexieDB.storesDirectory: { id, ownerKey, name, zip, adapterKey, favorite, primary, loyalty: { number?, alt? }, schedule:[], meta:{}, createdISO, updatedISO }
//   indexes: [ownerKey], [ownerKey+adapterKey], [ownerKey+zip]
// - DexieDB.kv (space="stores:adapters") for adapter registry overrides

async function dbPutStore(row) {
  if (!DexieDB?.storesDirectory) return null;
  try { await DexieDB.storesDirectory.put(row); return row.id; } catch { return null; }
}
async function dbDeleteStore(id) {
  if (!DexieDB?.storesDirectory) return;
  try { await DexieDB.storesDirectory.delete(id); } catch {}
}
async function dbListStores(ownerKey, limit=500) {
  if (!DexieDB?.storesDirectory) return null;
  try {
    return await DexieDB.storesDirectory.where("ownerKey").equals(ownerKey).reverse().limit(limit).toArray();
  } catch { return null; }
}
async function dbSaveAdapter(key, meta) {
  if (!DexieDB?.kv) return;
  try { await DexieDB.kv.put({ space:"stores:adapters", key, value: meta, updatedAt: Date.now() }); } catch {}
}
async function dbLoadAdapter(key) {
  if (!DexieDB?.kv) return null;
  try { return await DexieDB.kv.get({ space:"stores:adapters", key }); } catch { return null; }
}

/* ------------------------------ adapter registry --------------------------- */
/**
 * Each adapter describes how pricing/coupons/inventory are fetched for that store brand.
 * Only metadata lives here; your pipeline will look up the adapterKey and route calls.
 */
const DEFAULT_ADAPTERS = {
  "generic": { key:"generic", name:"Generic Retailer", features:["pricing","coupons"], version:1 },
  "samsclub": { key:"samsclub", name:"Sam's Club", features:["pricing","coupons","loyalty"], version:1 },
  "costco": { key:"costco", name:"Costco", features:["pricing","coupons","loyalty"], version:1 },
  "walmart": { key:"walmart", name:"Walmart", features:["pricing","coupons"], version:1 },
  "target": { key:"target", name:"Target", features:["pricing","coupons"], version:1 },
};

function bootstrapAdapters() {
  // Merge DB/LS overrides over defaults
  const ls = lsGet(LS_ADR, {});
  const merged = { ...DEFAULT_ADAPTERS, ...ls };
  Object.entries(merged).forEach(([k, v]) => memAdapters.set(k, v));
}

function listAdapters() {
  return Array.from(memAdapters.values()).sort((a,b)=>a.name.localeCompare(b.name));
}

async function registerAdapter(meta) {
  if (!meta?.key) return false;
  const norm = { key: String(meta.key), name: meta.name || meta.key, features: meta.features || [], version: meta.version || 1 };
  memAdapters.set(norm.key, norm);
  const ls = Object.fromEntries(memAdapters.entries());
  lsSet(LS_ADR, ls);
  await dbSaveAdapter(norm.key, norm);
  eventBus.emit("stores:adapter:registered", { adapter: norm });
  return true;
}

async function loadAdapter(key) {
  if (memAdapters.has(key)) return memAdapters.get(key);
  const db = await dbLoadAdapter(key);
  if (db?.value) {
    memAdapters.set(key, db.value);
    return db.value;
  }
  if (DEFAULT_ADAPTERS[key]) return DEFAULT_ADAPTERS[key];
  return null;
}

/* -------------------------------- row shape -------------------------------- */
function makeRow({ ownerKey, name, zip, adapterKey="generic", loyalty={}, favorite=false, primary=false, schedule=[], meta={} }) {
  const id = `store-${Date.now()}-${nanoid(4)}`;
  return {
    id,
    ownerKey,
    name: toStr(name),
    zip: toStr(zip),
    adapterKey: toStr(adapterKey) || "generic",
    favorite: !!favorite,
    primary: !!primary,
    loyalty: {
      number: toStr(loyalty?.number) || null,
      alt: toStr(loyalty?.alt) || null,
    },
    schedule: Array.isArray(schedule) ? schedule.slice(0, 12) : [],
    meta,
    createdISO: nowISO(),
    updatedISO: nowISO(),
  };
}

function validateRow(row) {
  const errs = [];
  if (!row.name) errs.push("Store name is required.");
  if (row.zip && !US_ZIP_RX.test(row.zip)) errs.push("ZIP should be US 5-digit or 5+4.");
  return errs;
}

/* -------------------------- schedule window helpers ------------------------ */
/**
 * schedule item shape:
 * { id, label, byweekday:[0..6], start:"09:00", end:"11:30", cadence:"WEEKLY"|"BIWEEKLY"|"MONTHLY" }
 */
function makeWindow({ label="Weekly run", byweekday=[6], start="09:00", end="11:30", cadence="WEEKLY" }) {
  return { id: `win-${Date.now()}-${nanoid(3)}`, label, byweekday, start, end, cadence };
}

/* ----------------------------------- hook ---------------------------------- */
/**
 * useStoresDirectory({ scope="household"|"user" })
 * returns {
 *   status, error, stores, adapters,
 *   addStore(payload), updateStore(id, patch), removeStore(id),
 *   markFavorite(id, flag), setPrimary(id),
 *   addSchedule(id, win), updateSchedule(id, winId, patch), removeSchedule(id, winId),
 *   resolveAdapter(adapterKey), listAdapters(),
 *   exportDirectory(), importDirectory(payload),
 *   suggestSessionTemplate(id)   // emits an event with a prefilled shopping session template
 * }
 */
export default function useStoresDirectory(opts = {}) {
  const { scope = "household" } = opts;
  const { user, householdId } = useAuth();
  const { enabled: quietHours } = useQuietHours();

  const ownerKey = useMemo(() => scope === "user" ? `user:${user?.id || "anon"}` : `house:${householdId || "default"}`, [scope, user?.id, householdId]);

  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [stores, setStores] = useState(() => {
    const ls = lsGet(LS_DIR, []);
    ls.forEach(r => memRows.set(r.id, r));
    return ls.filter(r => r.ownerKey === ownerKey);
  });

  // Bootstrap adapters
  useEffect(() => { bootstrapAdapters(); }, []);

  // Hydrate from Dexie (if present)
  useEffect(() => {
    (async () => {
      setStatus("loading"); setError(null);
      try {
        const rows = (await dbListStores(ownerKey)) ?? lsGet(LS_DIR, []);
        // Merge: prefer most recent updatedISO for duplicates by id
        const map = new Map();
        for (const r of rows) {
          const prev = map.get(r.id);
          if (!prev || Date.parse(prev.updatedISO||0) < Date.parse(r.updatedISO||0)) map.set(r.id, r);
        }
        // Also load LS into memRows for global export/import parity
        const lsAll = lsGet(LS_DIR, []);
        for (const r of lsAll) {
          const prev = map.get(r.id);
          if (!prev || Date.parse(prev.updatedISO||0) < Date.parse(r.updatedISO||0)) map.set(r.id, r);
        }
        const merged = Array.from(map.values());
        merged.forEach(r => memRows.set(r.id, r));
        lsSet(LS_DIR, merged);
        setStores(merged.filter(r => r.ownerKey === ownerKey).sort(sorter));
        setStatus("ok");
        eventBus.emit("stores:loaded", { ownerKey, count: merged.length });
      } catch (e) {
        setStatus("error"); setError(e);
      }
    })();
  }, [ownerKey]);

  const persistSnapshot = useCallback(async (row) => {
    memRows.set(row.id, row);
    const all = Array.from(memRows.values()).sort(sorter);
    lsSet(LS_DIR, all);
    if (DexieDB?.storesDirectory) await dbPutStore(row);
  }, []);

  const addStore = useCallback(async (payload) => {
    const row = makeRow({ ownerKey, ...payload });
    const errs = validateRow(row);
    if (errs.length) {
      const msg = errs.join(" ");
      if (!quietHours && toast) toast(msg);
      throw new Error(msg);
    }
    await persistSnapshot(row);
    setStores(prev => [row, ...prev].sort(sorter));
    eventBus.emit("stores:added", { ownerKey, id: row.id, name: row.name, adapterKey: row.adapterKey });
    if (!quietHours && toast) toast("Store added.");
    return row.id;
  }, [ownerKey, persistSnapshot, quietHours]);

  const updateStore = useCallback(async (id, patch={}) => {
    const cur = memRows.get(id);
    if (!cur) return false;
    const next = { ...cur, ...patch, updatedISO: nowISO() };
    const errs = validateRow(next);
    if (errs.length) {
      const msg = errs.join(" ");
      if (!quietHours && toast) toast(msg);
      return false;
    }
    await persistSnapshot(next);
    setStores(prev => prev.map(s => s.id===id ? next : s).sort(sorter));
    eventBus.emit("stores:updated", { id, patch });
    if (!quietHours && toast) toast("Store updated.");
    return true;
  }, [quietHours, persistSnapshot]);

  const removeStore = useCallback(async (id) => {
    const cur = memRows.get(id);
    if (!cur) return;
    memRows.delete(id);
    const all = Array.from(memRows.values()).sort(sorter);
    lsSet(LS_DIR, all);
    if (DexieDB?.storesDirectory) await dbDeleteStore(id);
    setStores(prev => prev.filter(s => s.id!==id));
    eventBus.emit("stores:removed", { id });
    if (!quietHours && toast) toast("Store removed.");
  }, [quietHours]);

  const markFavorite = useCallback(async (id, flag=true) => {
    const cur = memRows.get(id);
    if (!cur) return false;
    return updateStore(id, { favorite: !!flag });
  }, [updateStore]);

  const setPrimary = useCallback(async (id) => {
    // Unset others for this ownerKey
    const cur = memRows.get(id);
    if (!cur) return false;
    const updated = [];
    for (const row of memRows.values()) {
      if (row.ownerKey !== ownerKey) continue;
      const isTarget = row.id === id;
      const next = isTarget ? { ...row, primary: true, updatedISO: nowISO() } : { ...row, primary: false, updatedISO: row.updatedISO };
      memRows.set(row.id, next);
      if (DexieDB?.storesDirectory) await dbPutStore(next);
      updated.push(next);
    }
    const all = Array.from(memRows.values()).sort(sorter);
    lsSet(LS_DIR, all);
    setStores(updated.filter(r => r.ownerKey===ownerKey).sort(sorter));
    eventBus.emit("stores:primary:set", { id });
    if (!quietHours && toast) toast("Primary store set.");
    return true;
  }, [ownerKey, quietHours]);

  /* ---------------------------- schedule management ---------------------------- */
  const addSchedule = useCallback(async (id, win) => {
    const cur = memRows.get(id);
    if (!cur) return false;
    const window = win?.id ? win : makeWindow(win || {});
    const next = { ...cur, schedule: [...(cur.schedule||[]), window], updatedISO: nowISO() };
    await persistSnapshot(next);
    setStores(prev => prev.map(s => s.id===id?next:s));
    eventBus.emit("stores:schedule:added", { id, win: window });
    if (!quietHours && toast) toast("Shopping window added.");
    return window.id;
  }, [quietHours, persistSnapshot]);

  const updateSchedule = useCallback(async (id, winId, patch={}) => {
    const cur = memRows.get(id); if (!cur) return false;
    const nextWins = (cur.schedule||[]).map(w => w.id===winId ? ({ ...w, ...patch }) : w);
    const next = { ...cur, schedule: nextWins, updatedISO: nowISO() };
    await persistSnapshot(next);
    setStores(prev => prev.map(s => s.id===id?next:s));
    eventBus.emit("stores:schedule:updated", { id, winId, patch });
    if (!quietHours && toast) toast("Shopping window updated.");
    return true;
  }, [quietHours, persistSnapshot]);

  const removeSchedule = useCallback(async (id, winId) => {
    const cur = memRows.get(id); if (!cur) return false;
    const next = { ...cur, schedule: (cur.schedule||[]).filter(w => w.id!==winId), updatedISO: nowISO() };
    await persistSnapshot(next);
    setStores(prev => prev.map(s => s.id===id?next:s));
    eventBus.emit("stores:schedule:removed", { id, winId });
    if (!quietHours && toast) toast("Shopping window removed.");
    return true;
  }, [quietHours, persistSnapshot]);

  /* ----------------------------- adapter utilities ---------------------------- */
  const resolveAdapter = useCallback(async (adapterKey) => {
    return await loadAdapter(adapterKey || "generic");
  }, []);

  /* ------------------------------ export/import ------------------------------ */
  const exportDirectory = useCallback(() => {
    const all = Array.from(memRows.values()).sort(sorter);
    const mine = all.filter(r => r.ownerKey === ownerKey);
    return {
      version: 1,
      exportedAt: nowISO(),
      ownerKey,
      stores: mine,
      adapters: Object.fromEntries(memAdapters.entries()),
    };
  }, [ownerKey]);

  const importDirectory = useCallback(async (payload) => {
    if (!payload?.stores) return 0;
    // Merge adapters first
    if (payload.adapters) {
      for (const [k, v] of Object.entries(payload.adapters)) {
        await registerAdapter(v);
      }
    }
    // Merge rows by newest updatedISO
    const mine = payload.stores.filter(r => r.ownerKey === ownerKey);
    for (const r of mine) {
      const prev = memRows.get(r.id);
      if (!prev || Date.parse(prev.updatedISO||0) < Date.parse(r.updatedISO||0)) {
        memRows.set(r.id, r);
        if (DexieDB?.storesDirectory) await dbPutStore(r);
      }
    }
    const all = Array.from(memRows.values()).sort(sorter);
    lsSet(LS_DIR, all);
    setStores(all.filter(r => r.ownerKey===ownerKey).sort(sorter));
    eventBus.emit("stores:imported", { ownerKey, count: mine.length });
    if (!quietHours && toast) toast("Imported stores.");
    return mine.length;
  }, [ownerKey, quietHours]);

  /* ------------------------- session template suggestion ------------------------- */
  const suggestSessionTemplate = useCallback((id) => {
    const s = memRows.get(id); if (!s) return false;
    // Emit a scheduler-friendly template proposal the SessionRunner/TemplatePicker can pick up.
    const tmpl = {
      id: `tmpl-${id}-${Date.now()}`,
      domain: "shopping",
      label: `Shopping — ${s.name}`,
      storeId: s.id,
      adapterKey: s.adapterKey,
      zip: s.zip,
      schedule: s.schedule || [],
      preferences: {
        loyalty: s.loyalty?.number || null,
        safetyProfile: null,       // orchestration can fill from useSafetyPrefs favorite
        priceWatch: [],            // orchestration can seed from usePriceBook favorites
      },
      createdISO: nowISO(),
    };
    eventBus.emit("session:template:proposed", { template: tmpl });
    if (!quietHours && toast) toast("Shopping template ready in planner.");
    return true;
  }, [quietHours]);

  return {
    status, error,
    stores,
    adapters: listAdapters(),
    addStore, updateStore, removeStore,
    markFavorite, setPrimary,
    addSchedule, updateSchedule, removeSchedule,
    resolveAdapter, listAdapters,
    exportDirectory, importDirectory,
    suggestSessionTemplate,
  };
}

/* -------------------------------- utilities -------------------------------- */
function sorter(a,b) {
  // Primary + favorite first; then updated desc; then name asc
  if (a.primary !== b.primary) return a.primary ? -1 : 1;
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
  const t = Date.parse(b.updatedISO||0) - Date.parse(a.updatedISO||0);
  if (t !== 0) return t;
  return a.name.localeCompare(b.name);
}

/* ------------------------------- named exports ------------------------------ */
// Lightweight imperative helpers for non-React orchestration.

export function makeShoppingWindow(p){ return makeWindow(p || {}); }

export async function registerStoreAdapter(meta) {
  return await registerAdapter(meta);
}
