/* eslint-disable no-console */
// src/hooks/useCouponLookup.js
// Query active coupons by store/brand/category/UPC with cycle prediction + favorites.
// Style: dependency-light, defensive DI, event-driven, offline-first.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Safe imports ------------------------------ */
let eventBus = { emit(){}, on(){}, off(){} };
try { 
  const eb = require("@/services/eventBus");
  eventBus = (eb?.default || eb?.eventBus || eb) || eventBus;
} catch (_e) {}

let DexieDB = null;
try { DexieDB = require("@/db")?.default || require("@/db"); } catch (_e) {}

let useQuietHours = () => ({ enabled:false });
try { useQuietHours = require("@/hooks/useQuietHours")?.default || useQuietHours; } catch (_e) {}

let useAuth = () => ({ user: null });
try { useAuth = require("@/hooks/useAuth")?.default || useAuth; } catch (_e) {}

let toast = null;
try { toast = (require("@/components/toast")?.toast) || null; } catch (_e) {}

/* --------------------------------- Utils ---------------------------------- */
const nowISO = () => new Date().toISOString();
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const toStr = (v) => (v == null ? "" : String(v)).trim();

const stableKey = (q) => {
  const j = JSON.stringify({
    store: toStr(q.store),
    brand: toStr(q.brand),
    category: toStr(q.category),
    upc: toStr(q.upc),
    geohash: toStr(q.geohash),
  });
  return `coupon:query:${j}`;
};

const hours = (h) => h * 60 * 60 * 1000;

/* ----------------------------- Normalizer/Score ---------------------------- */
const normalizeCoupon = (raw) => {
  if (!raw) return null;
  // Minimal mapping with safe defaults:
  const c = {
    id: raw.id || `${raw.source || "local"}:${raw.code || raw.url || raw.title || Math.random().toString(36).slice(2)}`,
    title: raw.title || raw.headline || "",
    description: raw.description || raw.details || "",
    brand: raw.brand || raw.merchant || "",
    storeCode: raw.storeCode || raw.store || "",
    category: raw.category || "",
    type: raw.type || inferType(raw),
    value: normalizeValue(raw),
    minSpend: raw.minSpend ?? null,
    promoCode: raw.promoCode || raw.code || null,
    startISO: raw.startISO || raw.start || raw.startDate || null,
    endISO: raw.endISO || raw.end || raw.endDate || null,
    url: raw.url || raw.link || null,
    inStore: !!(raw.inStore ?? true),
    online: !!(raw.online ?? true),
    stackable: !!raw.stackable,
    membershipRequired: !!raw.membershipRequired,
    source: raw.source || "unknown",
    terms: raw.terms || null,
    image: raw.image || null,
    lastCheckedISO: nowISO(),
  };
  return c;
};

function inferType(raw) {
  const t = `${raw.type || ""}`.toLowerCase();
  const title = `${raw.title || raw.headline || ""}`.toLowerCase();
  const desc = `${raw.description || raw.details || ""}`.toLowerCase();
  const s = `${t} ${title} ${desc}`;
  if (/\b(bogo|buy\s*one\s*get\s*one)\b/.test(s)) return "bogo";
  if (/%/.test(s) || /\bpercent\b/.test(s)) return "percent";
  if (/\$\s*\d|off\s*\$\d/.test(s)) return "amount";
  if (/\bfree shipping\b/.test(s)) return "shipping";
  return "other";
}

function normalizeValue(raw) {
  const s = `${raw.title || ""} ${raw.description || ""}`.toLowerCase();
  // Extract % off
  const pct = s.match(/(\d{1,2})\s?%/);
  if (pct) return { kind: "percent", amount: Number(pct[1]) };
  // Extract $ amount off
  const amt = s.match(/\$?\s?(\d{1,3})(?:\.\d{2})?\s?(?:off|save)/);
  if (amt) return { kind: "amount", amount: Number(amt[1]) };
  // Fallback from structured
  if (raw.value) return raw.value;
  return null;
}

function scoreCoupon(c, prefs) {
  // Basic scoring that favors soonest-expiring, higher value, matches:
  let score = 0;
  const now = Date.now();
  const end = c.endISO ? Date.parse(c.endISO) : now + hours(48);
  const timeFactor = clamp(1 - (end - now) / hours(240), 0, 1); // closer to exp = higher
  score += timeFactor * 40;

  if (c.value?.kind === "percent") score += clamp(c.value.amount, 0, 60);
  if (c.value?.kind === "amount")  score += clamp(c.value.amount / 2, 0, 60);

  if (prefs?.preferredTypes?.includes(c.type)) score += 10;
  if (prefs?.preferredStores?.includes(c.storeCode)) score += 6;
  if (prefs?.preferredBrands?.includes(c.brand)) score += 6;

  if (c.stackable) score += 5;
  if (c.membershipRequired && !prefs?.memberships?.includes(c.storeCode)) score -= 8;

  return Math.round(score);
}

/* --------------------------- Provider Adapters ----------------------------- */
/** Each provider returns normalized-ish raw objects; we normalize + merge. */
async function provider_A(query, signal) {
  // Placeholder adapter; replace endpoint/integration as needed.
  // Example: your own coupon microservice or partner API
  void signal; // unused placeholder
  const { store, brand, category, upc, geohash } = query;
  // Simulate different fields from a provider:
  return [
    {
      id: `A-${store}-${brand}-${Date.now()}`,
      title: `${brand || "Any"} % off this week`,
      description: `Save 15% on ${brand || "select"} items.`,
      brand,
      storeCode: store,
      category,
      type: "percent",
      startISO: new Date(Date.now() - hours(24)).toISOString(),
      endISO: new Date(Date.now() + hours(96)).toISOString(),
      source: "providerA",
      url: null,
      inStore: true,
      online: true,
      geohash,
      upc,
      stackable: false,
    },
  ];
}

async function provider_B(query, signal) {
  void signal;
  const { store, brand } = query;
  return [
    {
      id: `B-${store}-${brand}-${Math.random().toString(36).slice(2)}`,
      headline: `BOGO ${brand || "mix & match"}`,
      details: `Buy one get one 50% off ${brand || "select brands"}.`,
      brand,
      storeCode: store,
      type: "bogo",
      startDate: new Date(Date.now() - hours(12)).toISOString(),
      endDate: new Date(Date.now() + hours(72)).toISOString(),
      source: "providerB",
      code: null,
      inStore: true,
      online: false,
      stackable: true,
    },
  ];
}

const PROVIDERS = [provider_A, provider_B];

/* ------------------------------ Cache Layer ------------------------------- */
const memoryCache = new Map(); // key -> { when, data }

async function idbGet(table, key) {
  if (!DexieDB?.kv) return null;
  try { return await DexieDB.kv.get({ space: "coupon", key }); } catch { return null; }
}
async function idbSet(table, key, val) {
  if (!DexieDB?.kv) return;
  try { await DexieDB.kv.put({ space: "coupon", key, value: val, updatedAt: Date.now() }); } catch {}
}

function lsGet(key) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

async function cacheGet(key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  const idbVal = await idbGet("coupon", key);
  if (idbVal) { memoryCache.set(key, idbVal); return idbVal; }
  const lsVal = lsGet(key);
  if (lsVal) { memoryCache.set(key, lsVal); return lsVal; }
  return null;
}
async function cacheSet(key, val) {
  memoryCache.set(key, val);
  await idbSet("coupon", key, val);
  lsSet(key, val);
}

/* -------------------------- History/Cycle Tracking ------------------------ */
// Store history of observed windows to predict cycles
async function pushHistory(entry) {
  if (!DexieDB?.couponHistory) return; // optional table
  try { await DexieDB.couponHistory.add(entry); } catch {}
}

async function readHistory({ store, brand }, limit = 24) {
  if (!DexieDB?.couponHistory) return [];
  try {
    const rows = await DexieDB.couponHistory
      .where("[store+brand]")
      .equals([store || "", brand || ""])
      .reverse()
      .limit(limit)
      .toArray();
    return rows || [];
  } catch { return []; }
}

/** Predict next likely window based on median cadence of past windows. */
function predictNextWindowFromHistory(history) {
  if (!history?.length) return null;
  // Use end dates to detect cadence
  const ends = history
    .map(h => Date.parse(h.endISO))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (ends.length < 3) return null;

  const gaps = [];
  for (let i = 1; i < ends.length; i++) gaps.push(ends[i] - ends[i-1]);
  gaps.sort((a,b)=>a-b);
  const median = gaps[Math.floor(gaps.length/2)];
  const lastEnd = ends[ends.length - 1];
  const nextStart = new Date(lastEnd + median * 0.6); // allow pre-window
  const nextEnd = new Date(lastEnd + median * 1.1);

  // Confidence grows with consistency (IQR tightness)
  const q1 = gaps[Math.floor(gaps.length*0.25)];
  const q3 = gaps[Math.floor(gaps.length*0.75)];
  const spread = Math.max(1, q3 - q1);
  const conf = clamp(Math.round(90 - (spread / (median || 1)) * 50), 10, 95);

  return {
    expectedStartISO: nextStart.toISOString(),
    expectedEndISO: nextEnd.toISOString(),
    cadenceDays: Math.round(median / (1000*60*60*24)),
    confidence: conf,
  };
}

/* ---------------------------- Favorites (Dexie) --------------------------- */
async function getFavorites(userId) {
  if (!DexieDB?.favorites) return [];
  try {
    return await DexieDB.favorites
      .where("[userId+type]")
      .equals([userId || "anon", "coupon"])
      .toArray();
  } catch { return []; }
}

async function addFavorite(userId, coupon) {
  if (!DexieDB?.favorites) return;
  try {
    await DexieDB.favorites.put({
      userId: userId || "anon",
      type: "coupon",
      key: coupon.id,
      payload: coupon,
      createdAt: Date.now(),
    });
  } catch {}
}

async function removeFavorite(userId, couponId) {
  if (!DexieDB?.favorites) return;
  try {
    const idx = await DexieDB.favorites
      .where({ userId: userId || "anon", type: "coupon", key: couponId })
      .first();
    if (idx?.id) await DexieDB.favorites.delete(idx.id);
  } catch {}
}

/* ----------------------------- In-flight guard ---------------------------- */
const inflight = new Map(); // key -> { abortCtrl, promise }

/* ---------------------------------- Hook ---------------------------------- */
/**
 * useCouponLookup
 * @param {Object} query { store, brand, category, upc, geohash }
 * @param {Object} opts  { ttlMs, debounceMs, limit, includePredictions, forceFresh }
 */
export default function useCouponLookup(query, opts = {}) {
  const {
    ttlMs = hours(6),
    debounceMs = 120,
    limit = 50,
    includePredictions = true,
    forceFresh = false,
  } = opts;

  const { user } = useAuth();
  const { enabled: quietHours } = useQuietHours();

  const stable = useMemo(() => ({
    store: toStr(query?.store),
    brand: toStr(query?.brand),
    category: toStr(query?.category),
    upc: toStr(query?.upc),
    geohash: toStr(query?.geohash),
  }), [query?.store, query?.brand, query?.category, query?.upc, query?.geohash]);

  const key = useMemo(() => stableKey(stable), [stable]);
  const [status, setStatus] = useState("idle"); // idle | loading | success | empty | error
  const [error, setError] = useState(null);
  const [coupons, setCoupons] = useState([]);
  const [predicted, setPredicted] = useState(null);
  const [favorites, setFavorites] = useState([]);

  const debTimer = useRef(null);

  const loadFavorites = useCallback(async () => {
    const favs = await getFavorites(user?.id);
    setFavorites(favs.map(f => f.payload));
  }, [user?.id]);

  const bookmark = useCallback(async (coupon) => {
    await addFavorite(user?.id, coupon);
    setFavorites((prev) => {
      const exists = prev.some(p => p.id === coupon.id);
      return exists ? prev : [coupon, ...prev];
    });
    if (!quietHours && toast) toast("Saved to favorites.");
  }, [user?.id, quietHours]);

  const unbookmark = useCallback(async (couponId) => {
    await removeFavorite(user?.id, couponId);
    setFavorites((prev) => prev.filter(p => p.id !== couponId));
    if (!quietHours && toast) toast("Removed from favorites.");
  }, [user?.id, quietHours]);

  const fetchCoupons = useCallback(async (reason = "auto") => {
    const cached = await cacheGet(key);
    const freshEnough = cached && (Date.now() - (cached.updatedAt || 0) < ttlMs);

    if (freshEnough && !forceFresh) {
      setCoupons(cached.data || []);
      setStatus((cached.data?.length ? "success" : "empty"));
      setError(null);
      // predictions from cache (if any)
      setPredicted(cached.predicted || null);
      eventBus.emit("coupons:cache:hit", { key, query: stable, reason });
      return;
    }

    // Dedupe concurrent fetches
    if (inflight.has(key)) {
      eventBus.emit("coupons:fetch:coalesced", { key, reason });
      try {
        const result = await inflight.get(key).promise;
        setCoupons(result.data);
        setPredicted(result.predicted || null);
        setStatus(result.data.length ? "success" : "empty");
        setError(null);
      } catch (e) {
        setStatus("error"); setError(e);
      }
      return;
    }

    setStatus("loading"); setError(null);
    eventBus.emit("coupons:fetch:start", { key, query: stable, reason });

    const abortCtrl = new AbortController();
    const p = (async () => {
      try {
        // Fan out to providers
        const results = await Promise.allSettled(
          PROVIDERS.map(fn => fn(stable, abortCtrl.signal))
        );
        const raws = results.flatMap(r => r.status === "fulfilled" ? (r.value || []) : []);
        const normalized = raws.map(normalizeCoupon).filter(Boolean);

        // De-dupe by id + (store+brand+type+value)
        const seen = new Set();
        const merged = [];
        for (const c of normalized) {
          const sig = `${c.id}::${c.storeCode}::${c.brand}::${c.type}::${c.value?.kind || ""}:${c.value?.amount || ""}`;
          if (!seen.has(sig)) { seen.add(sig); merged.push(c); }
        }

        // Score & sort
        const prefs = await getUserCouponPrefs(user);
        const scored = merged
          .map(c => ({ ...c, score: scoreCoupon(c, prefs) }))
          .sort((a,b) => b.score - a.score)
          .slice(0, limit);

        // Write history windows for prediction
        for (const c of scored) {
          if (c.endISO) {
            pushHistory({
              store: c.storeCode || "",
              brand: c.brand || "",
              type: c.type || "",
              endISO: c.endISO,
              value: c.value,
              ts: Date.now(),
              source: c.source,
            });
          }
        }

        // Predict cycles
        let predictedWindow = null;
        if (includePredictions && (stable.store || stable.brand)) {
          const hist = await readHistory({ store: stable.store, brand: stable.brand });
          predictedWindow = predictNextWindowFromHistory(hist);
        }

        const payload = {
          updatedAt: Date.now(),
          data: scored,
          predicted: predictedWindow,
        };

        await cacheSet(key, payload);

        // Events
        eventBus.emit("coupons:fetch:success", {
          key, query: stable, count: scored.length, predicted: !!predictedWindow
        });

        return payload;
      } catch (e) {
        eventBus.emit("coupons:fetch:error", { key, query: stable, error: String(e) });
        throw e;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, { abortCtrl, promise: p });

    try {
      const res = await p;
      setCoupons(res.data);
      setPredicted(res.predicted || null);
      setStatus(res.data.length ? "success" : "empty");
      setError(null);
    } catch (e) {
      setStatus("error");
      setError(e);
    }
  }, [key, stable, ttlMs, limit, includePredictions, forceFresh, user]);

  // Debounced auto-fetch on query change
  useEffect(() => {
    if (debTimer.current) clearTimeout(debTimer.current);
    debTimer.current = setTimeout(() => { fetchCoupons("debounced"); }, clamp(opts.debounceMs ?? 120, 0, 2000));
    return () => { if (debTimer.current) clearTimeout(debTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // initial favorites
  useEffect(() => { loadFavorites(); }, [loadFavorites]);

  const refresh = useCallback(() => fetchCoupons("manual"), [fetchCoupons]);

  return {
    status, error, coupons, predicted,
    refresh,
    favorites,
    bookmark, unbookmark,
  };
}

/* ---------------------------- User Prefs (safe) --------------------------- */
async function getUserCouponPrefs(user) {
  // Pull from Dexie profile if available; fall back to a simple object
  try {
    if (DexieDB?.profiles && user?.id) {
      const profile = await DexieDB.profiles.get(user.id);
      return {
        preferredTypes: profile?.couponPrefs?.types || ["percent", "amount", "bogo"],
        preferredStores: profile?.couponPrefs?.stores || [],
        preferredBrands: profile?.couponPrefs?.brands || [],
        memberships: profile?.memberships || [], // e.g., ["sams", "costco"]
      };
    }
  } catch {}
  return {
    preferredTypes: ["percent", "amount", "bogo"],
    preferredStores: [],
    preferredBrands: [],
    memberships: [],
  };
}

/* ----------------------------- Public helpers ----------------------------- */
/** Pure function for external cycle prediction if you have history array. */
export function predictCouponCycle(historyRows) {
  return predictNextWindowFromHistory(historyRows);
}

/** Imperative API for orchestration layer (non-React usage). */
export async function queryCouponsOnce(query, options = {}) {
  const tempKey = stableKey({
    store: toStr(query?.store),
    brand: toStr(query?.brand),
    category: toStr(query?.category),
    upc: toStr(query?.upc),
    geohash: toStr(query?.geohash),
  });

  const cached = await cacheGet(tempKey);
  const ttlMs = options.ttlMs ?? hours(6);
  const freshEnough = cached && (Date.now() - (cached.updatedAt || 0) < ttlMs);
  if (freshEnough && !options.forceFresh) return cached;

  if (inflight.has(tempKey)) return inflight.get(tempKey).promise;

  const abortCtrl = new AbortController();
  const promise = (async () => {
    try {
      const results = await Promise.allSettled(
        PROVIDERS.map(fn => fn(query, abortCtrl.signal))
      );
      const raws = results.flatMap(r => r.status === "fulfilled" ? (r.value || []) : []);
      const normalized = raws.map(normalizeCoupon).filter(Boolean);

      const seen = new Set();
      const merged = [];
      for (const c of normalized) {
        const sig = `${c.id}::${c.storeCode}::${c.brand}::${c.type}::${c.value?.kind || ""}:${c.value?.amount || ""}`;
        if (!seen.has(sig)) { seen.add(sig); merged.push(c); }
      }
      const payload = { updatedAt: Date.now(), data: merged };
      await cacheSet(tempKey, payload);
      return payload;
    } finally {
      inflight.delete(tempKey);
    }
  })();

  inflight.set(tempKey, { abortCtrl, promise });
  return promise;
}
