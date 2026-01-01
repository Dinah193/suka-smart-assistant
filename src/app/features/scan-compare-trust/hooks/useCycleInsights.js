/* eslint-disable no-console */
// src/hooks/useCycleInsights.js
// Discount-cycle insights from local history (offline-first, event-driven, defensive).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Safe imports ------------------------------ */
let DexieDB = null;
try { DexieDB = require("@/db")?.default || require("@/db"); } catch (_e) {}

let eventBus = { emit(){}, on(){}, off(){} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb?.default || eb?.eventBus || eb) || eventBus;
} catch (_e) {}

let useQuietHours = () => ({ enabled:false });
try { useQuietHours = require("@/hooks/useQuietHours")?.default || useQuietHours; } catch (_e) {}

let useAuth = () => ({ user: null });
try { useAuth = require("@/hooks/useAuth")?.default || useAuth; } catch (_e) {}

let toast = null;
try { toast = (require("@/components/toast")?.toast) || null; } catch (_e) {}

/* --------------------------------- Utils ---------------------------------- */
const hours = (h) => h * 60 * 60 * 1000;
const days  = (d) => d * 24 * 60 * 60 * 1000;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toStr = (v) => (v == null ? "" : String(v)).trim();
const nowISO = () => new Date().toISOString();

const stableKey = (q) => {
  const j = JSON.stringify({ store: toStr(q.store), brand: toStr(q.brand), category: toStr(q.category) });
  return `cycle:insights:${j}`;
};

const memoryCache = new Map(); // key -> { when, payload }

/* ------------------------------- Math helpers ------------------------------ */
function median(arr) {
  if (!arr?.length) return null;
  const a = [...arr].sort((x,y)=>x-y);
  const mid = Math.floor(a.length/2);
  return a.length % 2 ? a[mid] : (a[mid-1]+a[mid])/2;
}
function quantile(arr, q) {
  if (!arr?.length) return null;
  const a = [...arr].sort((x,y)=>x-y);
  const pos = (a.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (a[base + 1] !== undefined) return a[base] + rest * (a[base + 1] - a[base]);
  return a[base];
}
function mean(arr) {
  if (!arr?.length) return null;
  return arr.reduce((s,x)=>s+x,0)/arr.length;
}
function stddev(arr) {
  if (!arr?.length) return null;
  const m = mean(arr);
  const v = mean(arr.map(x => (x-m)*(x-m)));
  return Math.sqrt(v);
}

/* ------------------------------ Time features ------------------------------ */
function weekOfMonth(d) {
  const dt = new Date(d);
  const first = new Date(dt.getFullYear(), dt.getMonth(), 1);
  return Math.ceil((dt.getDate() + first.getDay()) / 7); // 1..5
}
function weekdayIndex(d) { return new Date(d).getDay(); } // 0=Sun..6=Sat
function monthIndex(d) { return new Date(d).getMonth(); } // 0..11

/* --------------------------- Pure analysis engine -------------------------- */
/**
 * analyzeCouponHistory(historyRows, opts)
 * historyRows: [{ endISO, startISO?, type, value:{kind,amount}, store, brand, category }]
 */
export function analyzeCouponHistory(historyRows, opts = {}) {
  const {
    recencyBias = 0.15,      // 0..1 extra weight to most recent third
    requireMinSamples = 6,   // minimum windows to attempt cadence prediction
    lookbackDays = 540,      // ~18 months
    now = Date.now(),
  } = opts;

  if (!Array.isArray(historyRows) || !historyRows.length) {
    return { samples: 0, status: "insufficient", tips: ["No local history yet. Scan/compare to learn cycles."] };
  }

  // Filter lookback & clean
  const cutoff = now - days(lookbackDays);
  const rows = historyRows
    .map(r => ({ ...r, tEnd: Date.parse(r.endISO || r.startISO || 0) }))
    .filter(r => Number.isFinite(r.tEnd) && r.tEnd >= cutoff)
    .sort((a,b) => a.tEnd - b.tEnd);

  const samples = rows.length;
  if (samples < 2) {
    return { samples, status: "insufficient", tips: ["Need more than one observed window to infer cadence."] };
  }

  // Compute gaps between windows (end-to-end)
  const gaps = [];
  for (let i=1;i<rows.length;i++) gaps.push(rows[i].tEnd - rows[i-1].tEnd);

  // Recency weighting
  const third = Math.max(1, Math.floor(gaps.length / 3));
  const weights = gaps.map((_, i) => {
    const isRecent = i >= gaps.length - third;
    return isRecent ? (1 + recencyBias) : 1;
  });
  const weightedMedian = median(gaps.flatMap((g,i) => Array(Math.max(1, Math.round(weights[i]))).fill(g)));

  // Dispersion → confidence
  const q1 = quantile(gaps, 0.25);
  const q3 = quantile(gaps, 0.75);
  const iqr = (q3 ?? 0) - (q1 ?? 0);
  const jitterRatio = iqr && weightedMedian ? clamp(iqr/weightedMedian, 0, 2) : 1;
  let cadenceConfidence = Math.round(92 - jitterRatio * 50);
  cadenceConfidence = clamp(cadenceConfidence, 10, 95);

  // Next window guess
  const lastEnd = rows[rows.length - 1].tEnd;
  const nextStart = new Date(lastEnd + weightedMedian * 0.6);
  const nextEnd   = new Date(lastEnd + weightedMedian * 1.1);

  // Value stats (separate percent & amount)
  const percents = rows
    .map(r => r?.value?.kind === "percent" ? Number(r.value.amount) : null)
    .filter(x => Number.isFinite(x));
  const amounts = rows
    .map(r => r?.value?.kind === "amount" ? Number(r.value.amount) : null)
    .filter(x => Number.isFinite(x));
  const avgPercent = percents.length ? Math.round(mean(percents)) : null;
  const avgAmount  = amounts.length ? Math.round(mean(amounts))  : null;

  // Temporal heatmaps
  const weekdayHeat = Array(7).fill(0);
  const monthHeat   = Array(12).fill(0);
  const womHeat     = Array(6).fill(0); // week-of-month 0..5 (ignore 0)
  rows.forEach(r => {
    const w = weekdayIndex(r.tEnd);
    const m = monthIndex(r.tEnd);
    const wm = weekOfMonth(r.tEnd);
    weekdayHeat[w] += 1;
    monthHeat[m]   += 1;
    womHeat[wm]    += 1;
  });

  const bestWeekday = weekdayHeat.indexOf(Math.max(...weekdayHeat));
  const bestMonth   = monthHeat.indexOf(Math.max(...monthHeat));
  const bestWOM     = womHeat.indexOf(Math.max(...womHeat));

  // Suggestive tips
  const tips = [];
  if (avgPercent) tips.push(`Typical discount is around ${avgPercent}% off.`);
  if (avgAmount)  tips.push(`Typical savings is about $${avgAmount} off.`);
  tips.push(`Deals tend to cluster on ${weekdayName(bestWeekday)}s; strongest in ${monthName(bestMonth)}${bestWOM>0?` (week ${bestWOM})`:""}.`);

  const cadenceDays = Math.round(weightedMedian / days(1));

  const status = samples >= requireMinSamples ? "ok" : "low-sample";
  return {
    status,
    samples,
    cadenceDays,
    cadenceConfidence,
    avgPercent,
    avgAmount,
    weekdayHeat,
    monthHeat,
    bestWeekday,
    bestMonth,
    bestWeekOfMonth: bestWOM,
    nextWindow: {
      expectedStartISO: nextStart.toISOString(),
      expectedEndISO: nextEnd.toISOString(),
      confidence: cadenceConfidence,
    },
    tips,
  };
}

function weekdayName(i){
  return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][i] ?? "Unknown";
}
function monthName(i){
  return ["January","February","March","April","May","June","July","August","September","October","November","December"][i] ?? "Unknown";
}

/* ----------------------------- Dexie accessors ----------------------------- */
/** Reads local couponHistory table for a (store, brand[, category]) tuple. */
async function readHistory({ store, brand, category }, limit = 200) {
  if (!DexieDB?.couponHistory) return [];
  try {
    // Prefer compound index if available; fall back to a simple where/filter.
    if (DexieDB.couponHistory.schema.indexes?.includes("[store+brand+category]")) {
      return await DexieDB.couponHistory
        .where("[store+brand+category]")
        .equals([store || "", brand || "", category || ""])
        .reverse()
        .limit(limit)
        .toArray();
    }
    if (DexieDB.couponHistory.schema.indexes?.includes("[store+brand]")) {
      return await DexieDB.couponHistory
        .where("[store+brand]")
        .equals([store || "", brand || ""])
        .reverse()
        .limit(limit)
        .toArray();
    }
    // Fallback scan (small datasets only)
    const all = await DexieDB.couponHistory.toArray();
    return all
      .filter(r =>
        (toStr(r.store) === toStr(store)) &&
        (toStr(r.brand) === toStr(brand)) &&
        (!category || toStr(r.category) === toStr(category))
      )
      .sort((a,b) => (Date.parse(b.endISO || 0) - Date.parse(a.endISO || 0)))
      .slice(0, limit);
  } catch { return []; }
}

/* ------------------------------- Favorites API ----------------------------- */
async function addInsightFavorite(userId, key, payload) {
  if (!DexieDB?.favorites) return;
  try {
    await DexieDB.favorites.put({
      userId: userId || "anon",
      type: "insight.cycle",
      key,
      payload,
      createdAt: Date.now(),
    });
  } catch {}
}

async function removeInsightFavorite(userId, key) {
  if (!DexieDB?.favorites) return;
  try {
    const row = await DexieDB.favorites.where({ userId: userId || "anon", type: "insight.cycle", key }).first();
    if (row?.id) await DexieDB.favorites.delete(row.id);
  } catch {}
}

async function getInsightFavorite(userId, key) {
  if (!DexieDB?.favorites) return null;
  try {
    return await DexieDB.favorites.where({ userId: userId || "anon", type: "insight.cycle", key }).first();
  } catch { return null; }
}

/* ---------------------------------- Cache ---------------------------------- */
function lsGet(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } }
function lsSet(key, val){ try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
async function cacheGet(key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  const ls = lsGet(key);
  if (ls) { memoryCache.set(key, ls); return ls; }
  return null;
}
async function cacheSet(key, payload) {
  memoryCache.set(key, payload);
  lsSet(key, payload);
}

/* ---------------------------------- Hook ---------------------------------- */
/**
 * useCycleInsights({ store, brand, category }, opts)
 * -> { status, error, insights, refresh, favorite, unfavorite, isFavorited }
 */
export default function useCycleInsights(query, opts = {}) {
  const {
    ttlMs = hours(6),
    debounceMs = 120,
    lookbackDays = 540,
    requireMinSamples = 6,
    recencyBias = 0.15,
    forceFresh = false,
    limitHistory = 220,
    emitSchedulerHint = true,
  } = opts;

  const { user } = useAuth();
  const { enabled: quietHours } = useQuietHours();

  const stable = useMemo(() => ({
    store: toStr(query?.store),
    brand: toStr(query?.brand),
    category: toStr(query?.category),
  }), [query?.store, query?.brand, query?.category]);

  const key = useMemo(() => stableKey(stable), [stable]);
  const [status, setStatus] = useState("idle"); // idle|loading|ok|low-sample|insufficient|error
  const [error, setError] = useState(null);
  const [insights, setInsights] = useState(null);
  const [isFavorited, setIsFavorited] = useState(false);

  const debRef = useRef(null);

  const favorite = useCallback(async () => {
    await addInsightFavorite(user?.id, key, { ...insights, query: stable });
    setIsFavorited(true);
    if (!quietHours && toast) toast("Saved insights to favorites.");
  }, [user?.id, insights, key, stable, quietHours]);

  const unfavorite = useCallback(async () => {
    await removeInsightFavorite(user?.id, key);
    setIsFavorited(false);
    if (!quietHours && toast) toast("Removed insights from favorites.");
  }, [user?.id, key, quietHours]);

  const loadFavoriteState = useCallback(async () => {
    const row = await getInsightFavorite(user?.id, key);
    setIsFavorited(!!row);
  }, [user?.id, key]);

  const compute = useCallback(async (reason = "auto") => {
    // cache gate
    const cached = await cacheGet(key);
    const fresh = cached && (Date.now() - (cached.when || 0) < ttlMs) && !forceFresh;
    if (fresh) {
      setInsights(cached.payload);
      setStatus(cached.payload?.status || "ok");
      setError(null);
      eventBus.emit("cycle:insights:cache:hit", { key, query: stable, reason });
      return;
    }

    setStatus("loading"); setError(null);
    eventBus.emit("cycle:insights:calc:start", { key, query: stable, reason });

    try {
      const historyRows = await readHistory(stable, limitHistory);
      const payload = analyzeCouponHistory(historyRows, {
        lookbackDays,
        requireMinSamples,
        recencyBias,
        now: Date.now(),
      });

      setInsights(payload);
      setStatus(payload.status || "ok");
      await cacheSet(key, { when: Date.now(), payload });

      eventBus.emit("cycle:insights:calc:success", { key, query: stable, payload, reason });

      // Hint the scheduler/CTA engine when a window is near
      if (emitSchedulerHint && payload?.nextWindow?.expectedStartISO) {
        const startT = Date.parse(payload.nextWindow.expectedStartISO);
        const soon = startT - Date.now() < days(10); // 10-day horizon
        if (soon) {
          eventBus.emit("nba:hint", {
            domain: "shopping",
            kind: "coupon-window",
            query: stable,
            window: payload.nextWindow,
            message: `Upcoming ${stable.brand || "brand"} window at ${stable.store || "store"} expected soon.`,
            score: clamp(50 + (payload.cadenceConfidence || 0)/2, 50, 90),
          });
        }
      }
    } catch (e) {
      setStatus("error"); setError(e);
      eventBus.emit("cycle:insights:calc:error", { key, query: stable, error: String(e) });
    }
  }, [key, stable, ttlMs, forceFresh, lookbackDays, requireMinSamples, recencyBias, limitHistory, emitSchedulerHint]);

  // Debounced compute on key change
  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => compute("debounced"), clamp(debounceMs, 0, 2000));
    return () => { if (debRef.current) clearTimeout(debRef.current); };
  }, [key, compute, debounceMs]);

  // Live-learn: recompute when new coupons land
  useEffect(() => {
    const onSuccess = (payload) => {
      // Only recompute if this event relates to our store/brand/context (best-effort)
      if (!payload?.query) return compute("event");
      const sameStore = !stable.store || toStr(payload.query.store) === stable.store;
      const sameBrand = !stable.brand || toStr(payload.query.brand) === stable.brand;
      if (sameStore && sameBrand) compute("event");
    };
    eventBus.on?.("coupons:fetch:success", onSuccess);
    return () => eventBus.off?.("coupons:fetch:success", onSuccess);
  }, [compute, stable.store, stable.brand]);

  // Favorite flag
  useEffect(() => { loadFavoriteState(); }, [loadFavoriteState]);

  const refresh = useCallback(() => compute("manual"), [compute]);

  return {
    status,
    error,
    insights,        // see analyzeCouponHistory return shape
    refresh,
    favorite,
    unfavorite,
    isFavorited,
  };
}

/* ------------------------------- Dev helpers ------------------------------- */
/**
 * Optional: merge external history arrays (e.g., imported receipts) into the
 * format this analyzer expects.
 */
export function adaptExternalHistory(rows = []) {
  // Provide a consistent projection; you can enrich as needed.
  return rows.map(r => ({
    store: r.store || "",
    brand: r.brand || "",
    category: r.category || "",
    startISO: r.startISO || null,
    endISO: r.endISO || null,
    type: r.type || "percent",
    value: r.value || null,
  }));
}
