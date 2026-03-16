/* eslint-disable no-console */
/**
 * useProductScan — Orchestration hook for Scan • Compare • Trust
 * ---------------------------------------------------------------------------------
 * Pipeline (progressive, cancellable):
 *   1) resolve():  UPC/barcode or image -> canonical product { upc, name, brand, ... }
 *   2) safety():   recalls, allergens, harmful flags, clean labels
 *   3) pricing():  offers across stores (normalized pack math left to UI)
 *   4) coupons():  active coupons for selected store + naive matching
 *
 * Public API:
 *   state:
 *     - subject        (canonical product { upc, name, brand, category, image, ... })
 *     - safety         ({ recalls[], allergensDetected[], harmfulIngredients[], clean[] })
 *     - offers         (Array<Offer>)
 *     - coupons        (Array<Coupon>)
 *     - sources        (Array<SourceLike>) // provenance for SourceAttribution
 *     - store          (current store object or null)
 *     - status         ({ phase:'idle|resolving|safety|pricing|coupons|done|error', progress:0..1 })
 *     - loading        ({ resolve:boolean, safety:boolean, pricing:boolean, coupons:boolean })
 *     - error          (last error string/null)
 *     - timestamps     ({ resolvedAt?, safetyAt?, pricingAt?, couponsAt? })
 *
 *   actions:
 *     - scanUPC(upc:string)
 *     - scanImage(fileOrBlob:Blob|File)
 *     - resolveManual(payload:{ upc?, name?, brand?, ...})
 *     - selectStore(store:{ id|slug|name })
 *     - refreshSafety()
 *     - refreshPricing()
 *     - refreshCoupons()
 *     - startPriceWatch()        // favorite schedule
 *     - saveDealRunSession()     // favorite session
 *     - reset()
 *
 * Notes:
 *  - Defensive optional deps (services/hooks) so the hook works offline or partially
 *  - Emits eventBus signals at each stage, integrates analytics (optional)
 *  - Debounced resolver, cancelable stages via AbortController
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* --------------------------- Optional dependencies --------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let analytics = { track: () => {} };
try {
  const a = require("@/services/analytics");
  analytics = (a && (a.default || a.analytics || a)) || analytics;
} catch (_e) {}

let productResolver = null; // .fromUPC(upc, {signal}) .fromImage(blob,{signal}) .fromManual(obj)
try {
  productResolver = require("@/services/scan/productResolver").default;
} catch (_e) {}

let safetyService = null; // .lookup({ upc, name, brand }, {signal})
try {
  safetyService = require("@/services/safety/safetyService").default;
} catch (_e) {}

let pricingService = null; // .offers({ upc, brand, category, store }, {signal})
try {
  pricingService = require("@/services/pricing/pricingService").default;
} catch (_e) {}

let couponService = null; // .listActiveForStore(storeId) .match({ coupons, offers })
try {
  couponService = require("@/services/coupons/couponService").default;
} catch (_e) {}

let priceCycle = null; // .getHint({ upc, store }) or .getPattern(...)
try {
  priceCycle = require("@/services/pricing/priceCycle").default;
} catch (_e) {}

let useFavoriteSessions = null;
let useFavoriteSchedules = null;
try {
  ({ useFavoriteSessions } = require("@/hooks/useFavoriteSessions"));
} catch (_e) {}
try {
  ({ useFavoriteSchedules } = require("@/hooks/useFavoriteSchedules"));
} catch (_e) {}

/* --------------------------------- Small utils -------------------------------- */
const CURRENCY = "USD";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizeStoreId = (store) =>
  store?.id ||
  store?.slug ||
  (store?.name ? store.name.toLowerCase().replace(/\s+/g, "-") : null);

const uniqueBy = (arr, keyFn) => {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
};

function matchCouponsToOffers(coupons = [], offers = [], store) {
  const sname = (store?.name || "").toLowerCase();
  return coupons.map((c) => {
    const appliesTo = (offers || []).filter((o) => {
      if (o?.store && String(o.store).toLowerCase() !== sname) return false;
      if (Array.isArray(c.upcs) && c.upcs.includes(o.upc)) return true;
      if (
        Array.isArray(c.brands) &&
        c.brands
          .map((b) => String(b).toLowerCase())
          .includes(String(o.brand || "").toLowerCase())
      )
        return true;
      if (
        Array.isArray(c.categories) &&
        c.categories
          .map((b) => String(b).toLowerCase())
          .includes(String(o.category || "").toLowerCase())
      )
        return true;
      return false;
    });
    return { ...c, appliesToCount: appliesTo.length };
  });
}

/* ------------------------------ In-memory caches ------------------------------ */
const _resolveCache = new Map(); // upc -> subject
const _safetyCache = new Map(); // upc -> safety
const _offersCache = new Map(); // cache key -> offers
const _couponCache = new Map(); // storeId -> coupons

/* ------------------------------------ Hook ------------------------------------ */
export default function useProductScan(initialStore = null) {
  /* ----------------------------- state & controllers ---------------------------- */
  const [subject, setSubject] = useState(null);
  const [safety, setSafety] = useState(null);
  const [offers, setOffers] = useState([]);
  const [coupons, setCoupons] = useState([]);
  const [sources, setSources] = useState([]);
  const [store, setStore] = useState(initialStore);

  const [status, setStatus] = useState({ phase: "idle", progress: 0 });
  const [loading, setLoading] = useState({
    resolve: false,
    safety: false,
    pricing: false,
    coupons: false,
  });
  const [error, setError] = useState(null);
  const [timestamps, setTimestamps] = useState({});

  const favSessions = useFavoriteSessions ? useFavoriteSessions() : null;
  const favSchedules = useFavoriteSchedules ? useFavoriteSchedules() : null;

  const abortRef = useRef({
    resolve: null,
    safety: null,
    pricing: null,
    coupons: null,
  });
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      // abort any in-flight
      Object.values(abortRef.current || {}).forEach((c) => c?.abort?.());
    },
    []
  );

  /* --------------------------------- internals --------------------------------- */
  const setPhase = (phase, progress) => {
    setStatus({ phase, progress });
    eventBus.emit("scan:phase", {
      phase,
      progress,
      upc: subject?.upc,
      source: "useProductScan",
    });
  };

  const appendSource = (src) =>
    setSources((prev) =>
      uniqueBy([...prev, src], (s) => s.id || s.name || JSON.stringify(s))
    );

  const selectStore = useCallback((s) => {
    setStore(s);
    eventBus.emit("store:selected", { store: s, source: "useProductScan" });
    analytics.track("store_selected", { store: normalizeStoreId(s) });
  }, []);

  /* ----------------------------------- stages ----------------------------------- */

  async function stageResolveFromUPC(upc) {
    if (!upc) throw new Error("No UPC provided.");
    setLoading((x) => ({ ...x, resolve: true }));
    setPhase("resolving", 0.15);
    setError(null);

    const cached = _resolveCache.get(upc);
    if (cached) {
      setSubject(cached);
      appendSource({
        id: `resolver-cache:${upc}`,
        name: "Resolver Cache",
        type: "meta",
        fetchedISO: new Date().toISOString(),
        credibility: 0.8,
        weight: 0.2,
        notes: "Loaded from in-memory cache",
      });
      setLoading((x) => ({ ...x, resolve: false }));
      setTimestamps((t) => ({ ...t, resolvedAt: Date.now() }));
      eventBus.emit("scan:resolved", {
        upc,
        subject: cached,
        cached: true,
        source: "useProductScan",
      });
      analytics.track("scan_resolve_cache_hit", { upc });
      return cached;
    }

    const ctrl = new AbortController();
    abortRef.current.resolve = ctrl;

    try {
      const resolved = productResolver?.fromUPC
        ? await productResolver.fromUPC(upc, { signal: ctrl.signal })
        : { upc, name: `Item ${upc}`, brand: "", category: "", image: null };

      if (!mounted.current) return null;

      _resolveCache.set(upc, resolved);
      setSubject(resolved);
      appendSource({
        id: `resolver:${upc}`,
        name: "Product Resolver",
        type: "meta",
        fetchedISO: new Date().toISOString(),
        credibility: 0.9,
        weight: 0.4,
      });
      setLoading((x) => ({ ...x, resolve: false }));
      setTimestamps((t) => ({ ...t, resolvedAt: Date.now() }));
      setPhase("safety", 0.3);
      eventBus.emit("scan:resolved", {
        upc,
        subject: resolved,
        cached: false,
        source: "useProductScan",
      });
      analytics.track("scan_resolved", { upc });
      return resolved;
    } catch (e) {
      if (e?.name === "AbortError") return null;
      console.error(e);
      setError("Could not resolve product.");
      setLoading((x) => ({ ...x, resolve: false }));
      setPhase("error", 1);
      throw e;
    }
  }

  async function stageResolveFromImage(blobOrFile) {
    if (!blobOrFile) throw new Error("No image provided.");
    setLoading((x) => ({ ...x, resolve: true }));
    setPhase("resolving", 0.15);
    setError(null);

    const ctrl = new AbortController();
    abortRef.current.resolve = ctrl;

    try {
      const resolved = productResolver?.fromImage
        ? await productResolver.fromImage(blobOrFile, { signal: ctrl.signal })
        : null;

      if (!mounted.current) return null;
      if (!resolved) throw new Error("No product resolved from image.");

      if (resolved?.upc) _resolveCache.set(resolved.upc, resolved);
      setSubject(resolved);
      appendSource({
        id: `resolver:image:${resolved?.upc || Date.now()}`,
        name: "Product Resolver (Image)",
        type: "meta",
        fetchedISO: new Date().toISOString(),
        credibility: 0.85,
        weight: 0.4,
      });
      setLoading((x) => ({ ...x, resolve: false }));
      setTimestamps((t) => ({ ...t, resolvedAt: Date.now() }));
      setPhase("safety", 0.3);
      eventBus.emit("scan:resolved", {
        upc: resolved?.upc,
        subject: resolved,
        source: "useProductScan",
      });
      analytics.track("scan_resolved_image", { upc: resolved?.upc || null });
      return resolved;
    } catch (e) {
      if (e?.name === "AbortError") return null;
      console.error(e);
      setError("Could not resolve from image.");
      setLoading((x) => ({ ...x, resolve: false }));
      setPhase("error", 1);
      throw e;
    }
  }

  async function stageSafety(subj) {
    if (!subj) return null;
    setLoading((x) => ({ ...x, safety: true }));
    setPhase("safety", 0.45);

    const cacheKey =
      subj.upc || JSON.stringify({ n: subj.name, b: subj.brand });
    const cached = _safetyCache.get(cacheKey);
    if (cached) {
      setSafety(cached);
      appendSource({
        id: `safety-cache:${cacheKey}`,
        name: "Safety Cache",
        type: "safety",
        fetchedISO: new Date().toISOString(),
        credibility: 0.8,
        weight: 0.3,
      });
      setLoading((x) => ({ ...x, safety: false }));
      setTimestamps((t) => ({ ...t, safetyAt: Date.now() }));
      eventBus.emit("safety:updated", {
        upc: subj.upc,
        cached: true,
        safety: cached,
        source: "useProductScan",
      });
      analytics.track("safety_cache_hit", { upc: subj.upc || null });
      return cached;
    }

    const ctrl = new AbortController();
    abortRef.current.safety = ctrl;
    try {
      const res = safetyService?.lookup
        ? await safetyService.lookup(
            { upc: subj.upc, name: subj.name, brand: subj.brand },
            { signal: ctrl.signal }
          )
        : {
            recalls: [],
            allergensDetected: [],
            harmfulIngredients: [],
            clean: [],
          };

      if (!mounted.current) return null;

      _safetyCache.set(cacheKey, res);
      setSafety(res);
      appendSource({
        id: `safety:${cacheKey}`,
        name: "Safety Service",
        type: "safety",
        fetchedISO: new Date().toISOString(),
        credibility: 0.95,
        weight: 0.6,
      });
      setLoading((x) => ({ ...x, safety: false }));
      setTimestamps((t) => ({ ...t, safetyAt: Date.now() }));
      setPhase("pricing", 0.6);
      eventBus.emit("safety:updated", {
        upc: subj.upc,
        cached: false,
        safety: res,
        source: "useProductScan",
      });
      analytics.track("safety_loaded", { upc: subj.upc || null });
      return res;
    } catch (e) {
      if (e?.name === "AbortError") return null;
      console.error(e);
      setLoading((x) => ({ ...x, safety: false }));
      setError("Safety lookup failed.");
      setPhase("pricing", 0.6); // continue pipeline even if safety fails
      return null;
    }
  }

  async function stagePricing(subj, currentStore) {
    if (!subj) return [];
    setLoading((x) => ({ ...x, pricing: true }));
    setPhase("pricing", 0.75);

    const key = JSON.stringify({
      upc: subj.upc,
      brand: subj.brand,
      cat: subj.category,
      store: normalizeStoreId(currentStore),
    });
    const cached = _offersCache.get(key);
    if (cached) {
      setOffers(cached);
      appendSource({
        id: `pricing-cache:${key}`,
        name: "Pricing Cache",
        type: "price",
        fetchedISO: new Date().toISOString(),
        credibility: 0.8,
        weight: 0.3,
      });
      setLoading((x) => ({ ...x, pricing: false }));
      setTimestamps((t) => ({ ...t, pricingAt: Date.now() }));
      eventBus.emit("offers:updated", {
        upc: subj.upc,
        offers: cached,
        cached: true,
        source: "useProductScan",
      });
      analytics.track("pricing_cache_hit", { upc: subj.upc || null });
      return cached;
    }

    const ctrl = new AbortController();
    abortRef.current.pricing = ctrl;
    try {
      const res = pricingService?.offers
        ? await pricingService.offers(
            {
              upc: subj.upc,
              brand: subj.brand,
              category: subj.category,
              store: currentStore,
            },
            { signal: ctrl.signal }
          )
        : [];

      if (!mounted.current) return [];

      _offersCache.set(key, res);
      setOffers(res);
      appendSource({
        id: `pricing:${key}`,
        name: "Pricing Service",
        type: "price",
        fetchedISO: new Date().toISOString(),
        credibility: 0.9,
        weight: 0.6,
      });
      setLoading((x) => ({ ...x, pricing: false }));
      setTimestamps((t) => ({ ...t, pricingAt: Date.now() }));
      setPhase("coupons", 0.88);
      eventBus.emit("offers:updated", {
        upc: subj.upc,
        offers: res,
        cached: false,
        source: "useProductScan",
      });
      analytics.track("pricing_loaded", {
        upc: subj.upc || null,
        count: res.length,
      });
      return res;
    } catch (e) {
      if (e?.name === "AbortError") return [];
      console.error(e);
      setLoading((x) => ({ ...x, pricing: false }));
      setError("Pricing lookup failed.");
      setPhase("coupons", 0.88);
      return [];
    }
  }

  async function stageCoupons(currentStore, currentOffers) {
    setLoading((x) => ({ ...x, coupons: true }));
    setPhase("coupons", 0.93);

    const storeId = normalizeStoreId(currentStore);
    if (!storeId) {
      setCoupons([]);
      setLoading((x) => ({ ...x, coupons: false }));
      setTimestamps((t) => ({ ...t, couponsAt: Date.now() }));
      setPhase("done", 1);
      return [];
    }

    const cached = _couponCache.get(storeId);
    if (cached) {
      const matched = matchCouponsToOffers(cached, currentOffers, currentStore);
      setCoupons(matched);
      appendSource({
        id: `coupons-cache:${storeId}`,
        name: "Coupon Cache",
        type: "coupon",
        fetchedISO: new Date().toISOString(),
        credibility: 0.75,
        weight: 0.25,
      });
      setLoading((x) => ({ ...x, coupons: false }));
      setTimestamps((t) => ({ ...t, couponsAt: Date.now() }));
      setPhase("done", 1);
      eventBus.emit("coupons:updated", {
        storeId,
        count: matched.length,
        cached: true,
        source: "useProductScan",
      });
      analytics.track("coupons_cache_hit", { storeId });
      return matched;
    }

    const ctrl = new AbortController();
    abortRef.current.coupons = ctrl;
    try {
      const list = couponService?.listActiveForStore
        ? await couponService.listActiveForStore(storeId, {
            signal: ctrl.signal,
          })
        : [];

      if (!mounted.current) return [];

      _couponCache.set(storeId, list);
      const matched = couponService?.match
        ? couponService.match({
            coupons: list,
            offers: currentOffers,
            store: currentStore,
          })
        : matchCouponsToOffers(list, currentOffers, currentStore);

      setCoupons(matched);
      appendSource({
        id: `coupons:${storeId}`,
        name: "Coupon Service",
        type: "coupon",
        fetchedISO: new Date().toISOString(),
        credibility: 0.85,
        weight: 0.4,
      });
      setLoading((x) => ({ ...x, coupons: false }));
      setTimestamps((t) => ({ ...t, couponsAt: Date.now() }));
      setPhase("done", 1);
      eventBus.emit("coupons:updated", {
        storeId,
        count: matched.length,
        cached: false,
        source: "useProductScan",
      });
      analytics.track("coupons_loaded", { storeId, count: matched.length });
      return matched;
    } catch (e) {
      if (e?.name === "AbortError") return [];
      console.error(e);
      setLoading((x) => ({ ...x, coupons: false }));
      setError("Coupons lookup failed.");
      setPhase("done", 1);
      return [];
    }
  }

  /* ----------------------------------- API ----------------------------------- */

  const scanUPC = useCallback(
    async (upc) => {
      // cancel running stages
      Object.values(abortRef.current || {}).forEach((c) => c?.abort?.());
      setSources([]);
      setSafety(null);
      setOffers([]);
      setCoupons([]);
      setError(null);
      setTimestamps({});
      setPhase("resolving", 0.1);

      try {
        const subj = await stageResolveFromUPC(upc);
        if (!subj) return;
        await sleep(0); // yield
        await stageSafety(subj);
        await sleep(0);
        const offs = await stagePricing(subj, store);
        await sleep(0);
        await stageCoupons(store, offs);
      } catch (_e) {
        // already handled
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [store]
  );

  const scanImage = useCallback(
    async (blobOrFile) => {
      Object.values(abortRef.current || {}).forEach((c) => c?.abort?.());
      setSources([]);
      setSafety(null);
      setOffers([]);
      setCoupons([]);
      setError(null);
      setTimestamps({});
      setPhase("resolving", 0.1);

      try {
        const subj = await stageResolveFromImage(blobOrFile);
        if (!subj) return;
        await stageSafety(subj);
        const offs = await stagePricing(subj, store);
        await stageCoupons(store, offs);
      } catch (_e) {}
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [store]
  );

  const resolveManual = useCallback(
    async (payload) => {
      Object.values(abortRef.current || {}).forEach((c) => c?.abort?.());
      setSources([]);
      setSafety(null);
      setOffers([]);
      setCoupons([]);
      setError(null);
      setTimestamps({});
      setPhase("resolving", 0.1);

      try {
        const subj = productResolver?.fromManual
          ? await productResolver.fromManual(payload)
          : payload;
        if (!subj) throw new Error("Manual resolve failed.");
        if (subj?.upc) _resolveCache.set(subj.upc, subj);
        setSubject(subj);
        appendSource({
          id: `resolver:manual:${subj?.upc || Date.now()}`,
          name: "Manual",
          type: "meta",
          fetchedISO: new Date().toISOString(),
          credibility: 0.7,
          weight: 0.3,
        });
        setTimestamps((t) => ({ ...t, resolvedAt: Date.now() }));
        setPhase("safety", 0.3);
        analytics.track("scan_resolved_manual", { upc: subj?.upc || null });
        await stageSafety(subj);
        const offs = await stagePricing(subj, store);
        await stageCoupons(store, offs);
      } catch (e) {
        console.error(e);
        setError("Manual resolution failed.");
        setPhase("error", 1);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [store]
  );

  const refreshSafety = useCallback(async () => {
    if (!subject) return null;
    // bypass cache by deleting
    const key =
      subject.upc || JSON.stringify({ n: subject.name, b: subject.brand });
    _safetyCache.delete(key);
    return stageSafety(subject);
  }, [subject]);

  const refreshPricing = useCallback(async () => {
    if (!subject) return [];
    const key = JSON.stringify({
      upc: subject.upc,
      brand: subject.brand,
      cat: subject.category,
      store: normalizeStoreId(store),
    });
    _offersCache.delete(key);
    return stagePricing(subject, store);
  }, [subject, store]);

  const refreshCoupons = useCallback(async () => {
    const storeId = normalizeStoreId(store);
    if (!storeId) return [];
    _couponCache.delete(storeId);
    return stageCoupons(store, offers);
  }, [store, offers]);

  /* ------------------------------ Favorites helpers ------------------------------ */
  const startPriceWatch = useCallback(async () => {
    if (!subject) return;
    const hint = priceCycle?.getHint
      ? priceCycle.getHint({ upc: subject.upc, store: normalizeStoreId(store) })
      : null;
    const payload = {
      label: `Watch price — ${
        store?.name || normalizeStoreId(store) || "Store"
      }: ${subject.name || subject.upc}`,
      when: hint?.rrule || "next_discount_window",
      meta: {
        upc: subject.upc,
        store: normalizeStoreId(store),
        domain: "pricing",
      },
      createdAt: Date.now(),
      source: "useProductScan",
    };
    try {
      if (favSchedules?.add) await favSchedules.add(payload);
      else eventBus.emit("favorites:schedule:add", payload);
      analytics.track("scan_price_watch_saved", { upc: subject.upc });
      eventBus.emit("ui:toast", {
        type: "success",
        message: "We’ll watch this price for you.",
      });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", {
        type: "error",
        message: "Could not create price watch.",
      });
    }
  }, [subject, store, favSchedules]);

  const saveDealRunSession = useCallback(async () => {
    if (!subject) return;
    const payload = {
      type: "deal_run",
      label: `Deal Run — ${
        store?.name || normalizeStoreId(store) || "Store"
      }: ${subject.name || subject.upc}`,
      items: (offers || []).map((o) => ({
        upc: o.upc,
        name: o.name,
        store: o.store,
        price: o.price,
        currency: CURRENCY,
      })),
      createdAt: Date.now(),
      source: "useProductScan",
    };
    try {
      if (favSessions?.add) await favSessions.add(payload);
      else eventBus.emit("favorites:session:add", payload);
      analytics.track("scan_deal_run_saved", {
        upc: subject.upc,
        count: offers?.length || 0,
      });
      eventBus.emit("ui:toast", {
        type: "success",
        message: "Saved a Deal Run to favorites.",
      });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", {
        type: "error",
        message: "Could not save Deal Run.",
      });
    }
  }, [subject, store, offers, favSessions]);

  /* ------------------------------------- reset ------------------------------------- */
  const reset = useCallback(() => {
    Object.values(abortRef.current || {}).forEach((c) => c?.abort?.());
    setSubject(null);
    setSafety(null);
    setOffers([]);
    setCoupons([]);
    setSources([]);
    setError(null);
    setStatus({ phase: "idle", progress: 0 });
    setTimestamps({});
  }, []);

  /* -------------------------------- Derived flags -------------------------------- */
  const isBusy =
    loading.resolve || loading.safety || loading.pricing || loading.coupons;

  /* ---------------------------------- Return API --------------------------------- */
  return {
    /* state */
    subject,
    safety,
    offers,
    coupons,
    sources,
    store,
    status,
    loading,
    error,
    timestamps,
    isBusy,

    /* actions */
    scanUPC,
    scanImage,
    resolveManual,
    selectStore,
    refreshSafety,
    refreshPricing,
    refreshCoupons,
    startPriceWatch,
    saveDealRunSession,
    reset,
  };
}
