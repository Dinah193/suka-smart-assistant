/* eslint-disable no-console */
// src/features/scan-compare-trust/stores/usePriceBook.js
// Seen prices per store/UPC/size (time-series) with per-unit normalization, trends, favorites,
// export/import, and event-driven orchestration hooks.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* -------------------------------- safe deps -------------------------------- */
let eventBus = { emit(){}, on(){}, off(){} };
try { const eb = require("@/services/eventBus"); eventBus = (eb?.default||eb?.eventBus||eb)||eventBus; } catch (_e) {}

let DexieDB = null;
try { DexieDB = require("@/db")?.default || require("@/db"); } catch (_e) {}

let useQuietHours = () => ({ enabled:false });
try { useQuietHours = require("@/hooks/useQuietHours")?.default || useQuietHours; } catch (_e) {}

let useAuth = () => ({ user: null });
try { useAuth = require("@/hooks/useAuth")?.default || useAuth; } catch (_e) {}

let toast = null;
try { toast = (require("@/components/toast")?.toast) || null; } catch (_e) {}

let nanoid = (len=8) => Math.random().toString(36).slice(2, 2+len);
try { nanoid = require("nanoid").nanoid || nanoid; } catch (_e) {}

const nowISO = () => new Date().toISOString();
const days = (d) => d * 24 * 60 * 60 * 1000;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toStr = (v) => (v == null ? "" : String(v)).trim();
const num = (v) => (v == null ? null : Number(v));

/* ------------------------------ local mirrors ------------------------------ */
const LS_KEY_ROWS = "priceBook:rows:v1";
const LS_KEY_FAVS = "priceBook:favs:v1";

const memRows = new Map(); // id -> row
const memFavs = new Map(); // key -> true

function lsGet(key, fb) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

/* ---------------------------- unit normalization --------------------------- */
/**
 * Normalize to a canonical unit so we can compare per-unit prices:
 * - weight: grams (g)
 * - volume (liquid): milliliters (ml)
 * - count: each (ea)
 */
const U = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
  ml: 1,
  l: 1000,
  floz: 29.5735,
  ea: 1,
};

function canonicalUnit(unitRaw) {
  const u = String(unitRaw||"").toLowerCase();
  if (["g","gram","grams"].includes(u)) return "g";
  if (["kg","kilogram","kilograms"].includes(u)) return "kg";
  if (["oz","ounce","ounces"].includes(u)) return "oz";
  if (["lb","lbs","pound","pounds"].includes(u)) return "lb";
  if (["ml","milliliter","milliliters"].includes(u)) return "ml";
  if (["l","liter","litre","liters","litres"].includes(u)) return "l";
  if (["floz","fl oz","fluid ounce","fluid ounces"].includes(u)) return "floz";
  if (["ea","each","count","ct","pcs","piece"].includes(u)) return "ea";
  return "ea"; // safe fallback
}

function toCanonicalQuantity(qty, unit) {
  const u = canonicalUnit(unit);
  const q = Number(qty) || 1;
  const factor = U[u] || 1;
  // Map weight to grams, liquids to ml, count stays ea.
  if (["g","kg","oz","lb"].includes(u)) return { amount: q * (U[u] / U.g), unit: "g" };
  if (["ml","l","floz"].includes(u))     return { amount: q * (U[u] / U.ml), unit: "ml" };
  return { amount: q, unit: "ea" };
}

function perUnit(price, qty, unit) {
  const { amount, unit: u } = toCanonicalQuantity(qty, unit);
  const amt = amount || 1;
  if (!Number.isFinite(price) || !Number.isFinite(amt) || amt <= 0) return { ppu: null, unit: u };
  return { ppu: price / amt, unit: u };
}

/* ------------------------------- dexie helpers ----------------------------- */
// Optional tables we’ll use if present:
// - DexieDB.priceBook: { id, upc, store, sizeQty, sizeUnit, price, currency, observedISO, promo?, source?, sessionId?, notes? }
//   Compound indexes suggested: [upc+store], [upc], [store], observedISO
// - DexieDB.favorites: used for watchlists (type="price.watch")
// - DexieDB.priceStats (optional materialized stats) – not required.

async function dbAddRow(row) {
  if (!DexieDB?.priceBook) return null;
  try { await DexieDB.priceBook.put(row); return row.id; } catch { return null; }
}

async function dbGetRowsBy({ upc, store }, limit=1000) {
  if (!DexieDB?.priceBook) return null;
  try {
    if (upc && store && DexieDB.priceBook.schema.indexes?.includes("[upc+store]")) {
      return await DexieDB.priceBook.where("[upc+store]").equals([upc, store]).reverse().limit(limit).toArray();
    }
    if (upc) {
      return await DexieDB.priceBook.where("upc").equals(upc).reverse().limit(limit).toArray();
    }
    if (store) {
      return await DexieDB.priceBook.where("store").equals(store).reverse().limit(limit).toArray();
    }
    return await DexieDB.priceBook.orderBy("observedISO").reverse().limit(limit).toArray();
  } catch { return null; }
}

async function dbGetRowsAll(limit=3000) {
  if (!DexieDB?.priceBook) return null;
  try { return await DexieDB.priceBook.orderBy("observedISO").reverse().limit(limit).toArray(); } catch { return null; }
}

/* -------------------------------- favorites -------------------------------- */
function favKey({ upc, store }) { return `${toStr(upc)}::${toStr(store)}`; }

async function addFavoriteWatch(userId, query, payload) {
  // Persist in Dexie.favorites if available; mirror to LS
  const key = favKey(query);
  memFavs.set(key, true);
  const ls = new Set(lsGet(LS_KEY_FAVS, []));
  ls.add(key); lsSet(LS_KEY_FAVS, Array.from(ls));
  if (DexieDB?.favorites) {
    try {
      await DexieDB.favorites.put({
        userId: userId || "anon",
        type: "price.watch",
        key,
        payload,
        createdAt: Date.now(),
      });
    } catch {}
  }
  return key;
}

async function removeFavoriteWatch(userId, query) {
  const key = favKey(query);
  memFavs.delete(key);
  const arr = lsGet(LS_KEY_FAVS, []).filter(k => k !== key);
  lsSet(LS_KEY_FAVS, arr);
  if (DexieDB?.favorites) {
    try {
      const row = await DexieDB.favorites.where({ userId: userId || "anon", type: "price.watch", key }).first();
      if (row?.id) await DexieDB.favorites.delete(row.id);
    } catch {}
  }
  return key;
}

function isFavoritedWatch(query) {
  const key = favKey(query);
  if (memFavs.has(key)) return true;
  const arr = lsGet(LS_KEY_FAVS, []);
  return arr.includes(key);
}

/* ----------------------------- time-series stats --------------------------- */
function rollingLinearTrend(points) {
  // points: [{t:number, y:number}]
  if (!points?.length) return { slope: null, r2: null };
  const n = points.length;
  if (n < 2) return { slope: 0, r2: 1 };

  const sumX = points.reduce((s,p)=>s+p.t,0);
  const sumY = points.reduce((s,p)=>s+p.y,0);
  const sumXY = points.reduce((s,p)=>s+p.t*p.y,0);
  const sumXX = points.reduce((s,p)=>s+p.t*p.t,0);

  const denom = (n*sumXX - sumX*sumX) || 1e-6;
  const slope = (n*sumXY - sumX*sumY) / denom;

  // R^2 (goodness of fit)
  const meanY = sumY / n;
  const ssTot = points.reduce((s,p)=>s+Math.pow(p.y-meanY,2),0) || 1e-6;
  const intercept = (sumY - slope*sumX) / n;
  const ssRes = points.reduce((s,p)=>s+Math.pow(p.y-(slope*p.t+intercept),2),0);
  const r2 = clamp(1 - (ssRes/ssTot), 0, 1);

  return { slope, r2 };
}

function seriesStats(rows) {
  if (!rows?.length) return null;
  const sorted = [...rows].sort((a,b)=>Date.parse(a.observedISO)-Date.parse(b.observedISO));
  const latest = sorted[sorted.length-1];

  // Per-unit stats
  const normalized = sorted
    .map(r => {
      const conv = perUnit(r.price, r.sizeQty, r.sizeUnit);
      return { ...r, ppu: conv.ppu, ppuUnit: conv.unit };
    })
    .filter(r => Number.isFinite(r.ppu));

  const minPPU = normalized.reduce((m,r)=> r.ppu < m.ppu ? r : m, normalized[0]);
  const maxPPU = normalized.reduce((m,r)=> r.ppu > m.ppu ? r : m, normalized[0]);
  const avgPPU = normalized.reduce((s,r)=>s+r.ppu, 0) / normalized.length;

  // 52-week low detection (approx 365 days)
  const cutoff = Date.now() - days(365);
  const lastYear = normalized.filter(r => Date.parse(r.observedISO) >= cutoff);
  const low52 = lastYear.length ? lastYear.reduce((m,r)=> r.ppu < m.ppu ? r : m, lastYear[0]) : minPPU;

  // Trend (linear regression) over per-unit values
  const pts = normalized.map(r => ({ t: Date.parse(r.observedISO)/days(1), y: r.ppu }));
  const { slope, r2 } = rollingLinearTrend(pts); // slope units: currency per canonical unit per day

  // Volatility: std dev of per-unit
  const mean = avgPPU;
  const variance = normalized.reduce((s,r)=>s+Math.pow(r.ppu-mean,2),0) / normalized.length || 0;
  const volatility = Math.sqrt(variance);

  return {
    count: rows.length,
    latest,
    minPPU,
    maxPPU,
    avgPPU,
    ppuUnit: minPPU?.ppuUnit || "ea",
    low52,
    trend: { slope, r2 },
    volatility,
    normalized,
  };
}

/* --------------------------- record & orchestration ------------------------ */
function toRow(obs) {
  // observation fields: { upc, store, price, currency="USD", sizeQty, sizeUnit, promo?, source?, sessionId?, notes? }
  return {
    id: obs.id || `${obs.upc || "unknown"}-${obs.store || "any"}-${Date.now()}-${nanoid(4)}`,
    upc: toStr(obs.upc),
    store: toStr(obs.store),
    price: Number(obs.price),
    currency: obs.currency || "USD",
    sizeQty: Number(obs.sizeQty) || 1,
    sizeUnit: obs.sizeUnit || "ea",
    promo: !!obs.promo,
    source: obs.source || "manual",
    sessionId: obs.sessionId || null,
    observedISO: obs.observedISO || nowISO(),
    notes: obs.notes || null,
  };
}

/* ----------------------------- hook definition ----------------------------- */
/**
 * usePriceBook(query?, opts?)
 * query: { upc?, store? }  (both optional; omit to aggregate all)
 * opts: {
 *   limit=1200, ttlMs=30_000, debounceMs=120,
 *   emitNBA=true, nbaThresholdPct=0.85 (<= 85% of 52w avg triggers hint)
 * }
 *
 * returns {
 *   status, error,
 *   series, stats, latest, bestByStore, perUnitFor(row), refresh,
 *   record(observation), bulkRecord(list),
 *   favoriteWatch(), unfavoriteWatch(), isFavorited,
 *   exportAll(), importAll(payload)
 * }
 */
export default function usePriceBook(query = {}, opts = {}) {
  const {
    limit = 1200,
    ttlMs = 30000,
    debounceMs = 120,
    emitNBA = true,
    nbaThresholdPct = 0.85, // trigger when current ppu <= 85% of trailing avg
  } = opts;

  const { user } = useAuth();
  const { enabled: quietHours } = useQuietHours();

  const stable = useMemo(() => ({
    upc: toStr(query?.upc) || null,
    store: toStr(query?.store) || null,
  }), [query?.upc, query?.store]);

  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [series, setSeries] = useState([]);       // narrowed view
  const [stats, setStats] = useState(null);       // computed stats for current view
  const [isFavorited, setIsFavorited] = useState(false);
  const cacheRef = useRef({ when: 0, rows: [] });
  const debRef = useRef(null);

  // Bootstrap LS mirror into memRows
  useEffect(() => {
    const lsRows = lsGet(LS_KEY_ROWS, []);
    lsRows.forEach(r => memRows.set(r.id, r));
    const favs = lsGet(LS_KEY_FAVS, []);
    favs.forEach(k => memFavs.set(k, true));
  }, []);

  const loadSeries = useCallback(async (reason = "auto") => {
    // cache gate
    const fresh = (Date.now() - cacheRef.current.when) < ttlMs;
    if (fresh && cacheRef.current.rows?.length) {
      const narrowed = narrowRows(cacheRef.current.rows, stable, limit);
      setSeries(narrowed);
      setStats(seriesStats(narrowed));
      setStatus("ok"); setError(null);
      eventBus.emit("pricebook:cache:hit", { reason, query: stable, count: narrowed.length });
      return;
    }

    setStatus("loading"); setError(null);
    eventBus.emit("pricebook:load:start", { reason, query: stable });

    try {
      let rows = await dbGetRowsAll(limit);
      if (!rows) {
        // Dexie not present or empty → use LS mirror
        rows = Array.from(memRows.values()).sort((a,b)=>Date.parse(b.observedISO)-Date.parse(a.observedISO)).slice(0, limit);
      }
      cacheRef.current = { when: Date.now(), rows };
      const narrowed = narrowRows(rows, stable, limit);
      setSeries(narrowed);
      setStats(seriesStats(narrowed));
      setStatus("ok"); setError(null);
      eventBus.emit("pricebook:load:success", { reason, query: stable, count: narrowed.length });
    } catch (e) {
      setStatus("error"); setError(e);
      eventBus.emit("pricebook:load:error", { reason, query: stable, error: String(e) });
    }
  }, [stable, limit, ttlMs]);

  // Debounced recompute on query change
  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => loadSeries("debounced"), clamp(debounceMs, 0, 2000));
    return () => { if (debRef.current) clearTimeout(debRef.current); };
  }, [loadSeries, debounceMs]);

  // Listen to scan pipeline results → record observed price if provided
  useEffect(() => {
    const onProcessed = async ({ id, result }) => {
      // Expect result like { upc, store, price, sizeQty, sizeUnit, currency, promo, sessionId }
      if (!result?.price || !result?.upc) return;
      await record(result, { source: "scan-pipeline" });
    };
    eventBus.on?.("scanqueue:item:success", onProcessed);
    return () => eventBus.off?.("scanqueue:item:success", onProcessed);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => loadSeries("manual"), [loadSeries]);

  /* ------------------------------- recorders -------------------------------- */
  const persistRow = useCallback(async (row) => {
    memRows.set(row.id, row);
    // LS
    const ls = Array.from(memRows.values()).sort((a,b)=>Date.parse(b.observedISO)-Date.parse(a.observedISO));
    lsSet(LS_KEY_ROWS, ls);
    // IDB (optional)
    if (DexieDB?.priceBook) await dbAddRow(row);
    // invalidate cache (but keep rows consistent)
    cacheRef.current.when = 0;
  }, []);

  const record = useCallback(async (observation, overrides = {}) => {
    const row = toRow({ ...observation, ...overrides });
    if (!Number.isFinite(row.price) || !row.upc) return null;

    await persistRow(row);

    eventBus.emit("pricebook:recorded", { row });

    // Compute per-unit & NBA hint
    try {
      const viewRows = narrowRows(Array.from(memRows.values()), { upc: row.upc, store: row.store }, 9999);
      const viewStats = seriesStats(viewRows);
      if (emitNBA && viewStats?.avgPPU) {
        const { ppu } = perUnit(row.price, row.sizeQty, row.sizeUnit);
        if (Number.isFinite(ppu) && ppu <= (viewStats.avgPPU * nbaThresholdPct)) {
          eventBus.emit("nba:hint", {
            domain: "shopping",
            kind: "price-dip",
            upc: row.upc,
            store: row.store,
            message: `Great price for ${row.upc} at ${row.store}: ${row.price.toFixed(2)} ${row.currency}.`,
            score: 70,
          });
          if (!quietHours && toast) toast("Price looks great vs. usual.");
        }
        // 52-week low shout
        if (viewStats?.low52 && Math.abs(ppu - viewStats.low52.ppu) < 1e-6) {
          eventBus.emit("nba:hint", {
            domain: "shopping",
            kind: "52w-low",
            upc: row.upc,
            store: row.store,
            message: `52-week low for ${row.upc} at ${row.store}.`,
            score: 80,
          });
          if (!quietHours && toast) toast("52-week low!");
        }
      }
    } catch (_e) {}

    return row.id;
  }, [persistRow, emitNBA, nbaThresholdPct, quietHours]);

  const bulkRecord = useCallback(async (list = []) => {
    const ids = [];
    for (const obs of list) {
      const id = await record(obs);
      if (id) ids.push(id);
    }
    return ids;
  }, [record]);

  /* --------------------------------- views ---------------------------------- */
  const latest = useMemo(() => (series?.length ? series[0] : null), [series]);

  const bestByStore = useMemo(() => {
    // For the current UPC, find best (lowest) per-unit by store (last 90 days)
    if (!series?.length) return [];
    const cutoff = Date.now() - days(90);
    const rows = series.filter(r => Date.parse(r.observedISO) >= cutoff);
    const by = new Map();
    for (const r of rows) {
      const { ppu } = perUnit(r.price, r.sizeQty, r.sizeUnit);
      if (!Number.isFinite(ppu)) continue;
      const k = r.store;
      const prev = by.get(k);
      if (!prev || ppu < prev.ppu) by.set(k, { store: r.store, price: r.price, currency: r.currency, sizeQty: r.sizeQty, sizeUnit: r.sizeUnit, ppu });
    }
    return Array.from(by.values()).sort((a,b)=>a.ppu-b.ppu);
  }, [series]);

  const perUnitFor = useCallback((row) => perUnit(row?.price, row?.sizeQty, row?.sizeUnit), []);

  /* -------------------------------- favorites -------------------------------- */
  const favoriteWatch = useCallback(async () => {
    const payload = { query: stable, createdAt: Date.now() };
    await addFavoriteWatch(user?.id, stable, payload);
    setIsFavorited(true);
    if (!quietHours && toast) toast("Added to watched prices.");
  }, [stable, user?.id, quietHours]);

  const unfavoriteWatch = useCallback(async () => {
    await removeFavoriteWatch(user?.id, stable);
    setIsFavorited(false);
    if (!quietHours && toast) toast("Removed from watched prices.");
  }, [stable, user?.id, quietHours]);

  useEffect(() => { setIsFavorited(isFavoritedWatch(stable)); }, [stable]);

  /* ------------------------------- export/import ---------------------------- */
  const exportAll = useCallback(() => {
    const rows = Array.from(memRows.values()).sort((a,b)=>Date.parse(b.observedISO)-Date.parse(a.observedISO));
    return { version: 1, exportedAt: nowISO(), rows };
  }, []);

  const importAll = useCallback(async (payload) => {
    if (!payload?.rows) return 0;
    let count = 0;
    for (const r of payload.rows) {
      const row = toRow(r);
      await persistRow(row);
      count++;
    }
    cacheRef.current.when = 0;
    await loadSeries("import");
    return count;
  }, [persistRow, loadSeries]);

  return {
    status, error,
    series, stats, latest, bestByStore, perUnitFor,
    refresh,
    record, bulkRecord,
    favoriteWatch, unfavoriteWatch, isFavorited,
    exportAll, importAll,
  };
}

/* -------------------------------- utilities -------------------------------- */
function narrowRows(allRows, query, limit) {
  let rows = allRows;
  if (query?.upc) rows = rows.filter(r => toStr(r.upc) === toStr(query.upc));
  if (query?.store) rows = rows.filter(r => toStr(r.store) === toStr(query.store));
  return rows.sort((a,b)=>Date.parse(b.observedISO)-Date.parse(a.observedISO)).slice(0, limit);
}

/* --------------------------- public imperative API -------------------------- */
/** Use in non-React orchestration to record a price event quickly. */
export async function priceBookRecord(observation) {
  const row = toRow(observation);
  memRows.set(row.id, row);
  const ls = Array.from(memRows.values()).sort((a,b)=>Date.parse(b.observedISO)-Date.parse(a.observedISO));
  lsSet(LS_KEY_ROWS, ls);
  if (DexieDB?.priceBook) await dbAddRow(row);
  eventBus.emit("pricebook:recorded", { row });
  return row.id;
}

/** Quick getter for current 52w low per UPC/store. */
export function get52WeekLow(upc, store) {
  const rows = Array.from(memRows.values()).filter(r => (!upc || r.upc===upc) && (!store || r.store===store));
  const cutoff = Date.now() - days(365);
  const lastYear = rows
    .filter(r => Date.parse(r.observedISO) >= cutoff)
    .map(r => ({ ...r, ...perUnit(r.price, r.sizeQty, r.sizeUnit) }))
    .filter(r => Number.isFinite(r.ppu));
  if (!lastYear.length) return null;
  return lastYear.reduce((m,r)=> r.ppu < m.ppu ? r : m, lastYear[0]);
}
