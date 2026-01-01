/* eslint-disable no-console */
// CouponService.js — One API: active coupons + stacking rules + application
// ESM-friendly. Dependency-light. Safe fallbacks for all adapters.
// Orchestration slot: resolve → safety → pricing → **coupons** → re-compare

/**
 * Normalized Coupon shape
 * ---------------------------------------------------------------------------
 * {
 *   id: string,
 *   source: "store"|"manufacturer"|"club"|"card"|"category"|"bundle",
 *   storeId?: string,                 // when store-specific
 *   label: string,                    // for UI
 *   type: "percent"|"amount"|"bogo"|"threshold"|"bundle",
 *   value?: number,                   // % or $ amount (major units)
 *   buyQty?: number,                  // for BOGO/BxGy
 *   getQty?: number,                  // for BOGO/BxGy
 *   threshold?: { amount:number, currency:"USD" }, // min spend (optional)
 *   appliesTo: {
 *     skus?: string[],                // explicit SKU list
 *     categories?: string[],          // category match
 *     brands?: string[],              // brand match
 *   },
 *   constraints?: {
 *     startISO?: string,
 *     endISO?: string,
 *     perOrderLimit?: number,         // max uses per order
 *     perItemLimit?: number,          // max uses per single SKU
 *     memberTier?: "member"|"plus"|"any"|"none",
 *     zipWhitelist?: string[],        // optional
 *     stackGroup?: string,            // coupons with same stackGroup may conflict
 *     exclusive?: boolean,            // true = cannot stack with any other
 *     once?: boolean,                 // one-time coupon
 *   },
 *   stacking?: {
 *     priority?: number,              // higher runs first
 *     combinableWith?: string[],      // allowed stackGroups
 *   },
 *   metadata?: any
 * }
 *
 * Offer (from pricing layer) should contain:
 * { id, title, store:{id,loyaltyTier}, price:{amount,currency}, category, metadata:{brand, sku}, _normalized? }
 */

export function createCouponService(deps = {}) {
  const {
    fetcher = safeFetch(),            // (url, opts) => Response
    eventBus = safeBus(),             // { emit, on? }
    analytics = safeAnalytics(),
    prefs = safePrefs(),
    config = { get: (_p, fb) => fb },
    clock = { now: () => Date.now() },
  } = deps;

  const NS = "scanCompareTrust.coupons";
  const CACHE_KEY = `${NS}.cache.v1`;
  const PROFILE_KEY = `${NS}.profile.v1`;
  const FAVORITES_KEY = `${NS}.favorites.v1`;

  // Runtime state
  let providers = new Map(); // name -> provider impl
  let cache = hydrateCache();
  let profile = hydrateProfile();
  let favorites = hydrateFavorites();

  return {
    // Provider lifecycle
    registerProvider,
    listProviders,
    hasProvider,

    // Fetch & normalize
    getActiveCoupons,        // by stores or providerNames (cached)
    refreshActiveCoupons,    // bypass cache
    invalidateCacheKey,
    clearCache,

    // Rule engine
    applyCouponsToOffers,    // returns {offers:[...adjusted], couponsApplied:[...]}
    applyAndRecompare,       // if PriceComparator is available
    estimateBasketSavings,   // quick savings estimate before UI ranking

    // Profile & Favorites (saved sessions/schedules)
    getActiveProfile,
    setActiveProfile,
    exportProfile,
    importProfile,
    listFavoriteSessions,
    saveFavoriteSession,
    deleteFavoriteSession,
    runFavoriteSession,

    // Utilities
    getVersion,
  };

  function getVersion() { return "1.4.0"; }

  // ---------------------------------------------------------------------------
  // Providers
  // ---------------------------------------------------------------------------

  /**
   * Provider shape
   * {
   *   name: "sams-club",
   *   displayName: "Sam's Club",
   *   ttlMs?: number,
   *   concurrency?: number,
   *   fetchActiveCoupons: async ({ zipcode, storeIds }) => NormalizedCoupon[]
   * }
   */
  function registerProvider(provider) {
    if (!provider?.name) throw new Error("Coupon provider must have a name.");
    const p = materializeProvider(provider);
    providers.set(p.name, p);
    eventBus.emit("coupons:provider:registered", { name: p.name, ts: clock.now() });
  }
  function listProviders() {
    return Array.from(providers.values()).map((p) => ({
      name: p.name,
      displayName: p.displayName,
      ttlMs: p.ttlMs,
      concurrency: p.concurrency,
    }));
  }
  function hasProvider(name) { return providers.has(name); }

  // ---------------------------------------------------------------------------
  // Fetch & Cache
  // ---------------------------------------------------------------------------

  async function getActiveCoupons({ providerNames, storeIds, zipcode } = {}) {
    const names = resolveProviderTargets(providerNames);
    const key = cacheKey(names, storeIds, zipcode || profile.zipcode);
    const now = clock.now();

    const hit = cache[key];
    if (hit && now - hit.ts < hit.ttlMs) {
      eventBus.emit("coupons:cache:hit", { key, count: hit.data.length, ts: now });
      return hit.data;
    }
    return refreshActiveCoupons({ providerNames: names, storeIds, zipcode });
  }

  async function refreshActiveCoupons({ providerNames, storeIds, zipcode } = {}) {
    const names = resolveProviderTargets(providerNames);
    const z = zipcode || profile.zipcode;
    const tasks = names.map((name) => callProvider(name, { zipcode: z, storeIds }));
    const results = (await Promise.allSettled(tasks))
      .flatMap((s) => (s.status === "fulfilled" ? s.value : []));

    const all = dedupeCoupons(flatten(results));
    const ttlMs = Math.min(...names.map((n) => providers.get(n)?.ttlMs || 5 * 60 * 1000));
    const key = cacheKey(names, storeIds, z);

    cache[key] = { ts: clock.now(), data: all, ttlMs };
    persistCache(cache);

    eventBus.emit("coupons:resolved", { sources: names, count: all.length, ts: clock.now() });
    analytics.track?.("coupons_resolved", { count: all.length, sources: names.length });

    return all;
  }

  function invalidateCacheKey({ providerNames, storeIds, zipcode }) {
    delete cache[cacheKey(resolveProviderTargets(providerNames), storeIds, zipcode || profile.zipcode)];
    persistCache(cache);
  }
  function clearCache() {
    cache = {};
    persistCache(cache);
    eventBus.emit("coupons:cache:cleared", { ts: clock.now() });
  }

  async function callProvider(name, ctx) {
    const p = providers.get(name);
    if (!p) return [];
    try {
      const res = await p.fetchActiveCoupons({ fetcher, eventBus, config, ...ctx });
      return (res || []).map(materializeCoupon);
    } catch (e) {
      eventBus.emit("coupons:provider:error", { name, error: toErr(e), ts: clock.now() });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Rule Engine — stacking & application
  // ---------------------------------------------------------------------------

  /**
   * Applies coupons onto offers, honoring stacking rules.
   * @param {Array<Offer>} offers
   * @param {Array<Coupon>} coupons optional (if omitted, it resolves active)
   * @param {Object} opts { zipcode?, storeIds? }
   * @returns {Object} { offers:[{...offer, _coupon:{applied[], savings, finalPrice}}], couponsApplied:[...] }
   */
  async function applyCouponsToOffers(offers = [], coupons = null, opts = {}) {
    const list = coupons || await getActiveCoupons({
      providerNames: profile.providerNames,
      storeIds: opts.storeIds || profile.storeIds,
      zipcode: opts.zipcode || profile.zipcode,
    });

    // Filter by eligibility per offer
    const perOfferApplicable = offers.map((offer) => {
      const appl = list.filter((c) => isEligible(c, offer, profile));
      const plan = planStacking(appl);
      const { finalPrice, lines, totalSavings } = applyBestStack(offer, plan);
      return {
        ...offer,
        _coupon: {
          applied: lines,
          savings: totalSavings,
          finalPrice,
        },
      };
    });

    const couponsApplied = flatten(perOfferApplicable.map((o) => o._coupon.applied.map((l) => l.coupon)));
    eventBus.emit("coupons:applied", {
      offerCount: offers.length,
      couponUses: couponsApplied.length,
      ts: clock.now(),
    });

    return { offers: perOfferApplicable, couponsApplied };
  }

  /**
   * Convenience: apply coupons then re-compare with PriceComparator (if available).
   * Returns ranked structure or plain offers if comparator missing.
   */
  async function applyAndRecompare(offers = [], coupons = null, opts = {}) {
    const adjusted = await applyCouponsToOffers(offers, coupons, opts);
    try {
      const { getPriceComparatorSingleton } = await lazyImport("@/features/scan-compare-trust/services/pricing/PriceComparator");
      const comparator = getPriceComparatorSingleton?.({ eventBus, prefs, config });
      if (!comparator?.compareOffers) return adjusted;
      const recomputedOffers = adjusted.offers.map((o) => {
        const eff = {
          amount: Number(o._coupon?.finalPrice ?? o.price.amount),
          currency: o.price.currency || "USD",
          includesTax: o.price.includesTax,
          taxRate: o.price.taxRate,
        };
        return { ...o, price: eff };
      });
      return comparator.compareOffers(recomputedOffers, { strategy: comparator.getActiveProfile?.()?.strategy || "auto" });
    } catch {
      return adjusted;
    }
  }

  /**
   * Estimate savings across the basket (for header badges)
   */
  function estimateBasketSavings(offers = [], coupons = []) {
    const { offers: adjusted } = {
      offers: offers.map((o) => applyBestStack(o, planStacking(coupons.filter((c) => isEligible(c, o, profile))))),
    };
    const raw = offers.reduce((sum, o) => sum + Number(o.price?.amount || 0), 0);
    const after = adjusted.reduce((sum, res) => sum + Number(res.finalPrice ?? 0), 0);
    return { raw, after, savings: Math.max(0, raw - after) };
  }

  // -------------------- Eligibility & Stacking Engine -------------------------

  function isEligible(coupon, offer, prof) {
    // time window
    const now = clock.now();
    if (coupon.constraints?.startISO && now < Date.parse(coupon.constraints.startISO)) return false;
    if (coupon.constraints?.endISO && now > Date.parse(coupon.constraints.endISO)) return false;

    // store / tier
    if (coupon.storeId && offer.store?.id && coupon.storeId !== offer.store.id) return false;
    const tierReq = coupon.constraints?.memberTier;
    if (tierReq && tierReq !== "any") {
      const t = offer.store?.loyaltyTier || "none";
      if (tierReq === "member" && !(t === "member" || t === "plus")) return false;
      if (tierReq === "plus" && t !== "plus") return false;
    }

    // geography
    if (coupon.constraints?.zipWhitelist?.length) {
      const zip = prof.zipcode || "";
      if (!coupon.constraints.zipWhitelist.includes(zip)) return false;
    }

    // product match
    const sku = offer.metadata?.sku || offer.id;
    const brand = offer.metadata?.brand || "";
    const cat = offer.category || "";

    const ap = coupon.appliesTo || {};
    if (ap.skus?.length && !ap.skus.includes(sku)) return false;
    if (ap.brands?.length && brand && !ap.brands.includes(brand)) return false;
    if (ap.categories?.length && cat && !ap.categories.includes(cat)) return false;

    return true;
  }

  function planStacking(applicableCoupons = []) {
    // Partition by exclusivity and stack groups
    const exclusive = [];
    const stackables = [];
    for (const c of applicableCoupons) {
      if (c.constraints?.exclusive) exclusive.push(c);
      else stackables.push(c);
    }
    // Sort by stacking priority (desc)
    exclusive.sort(byPriorityDESC);
    stackables.sort(byPriorityDESC);

    // Build stack plan candidates:
    // 1) Each exclusive alone
    // 2) Stackables grouped by stackGroup allowing combinableWith
    const candidates = [];
    for (const ex of exclusive) candidates.push([ex]);

    // Greedy build stack respecting groups & combinableWith
    const groupBuckets = new Map();
    for (const c of stackables) {
      const g = c.constraints?.stackGroup || "__default";
      const arr = groupBuckets.get(g) || [];
      arr.push(c);
      groupBuckets.set(g, arr);
    }
    // naive: pick top 1 from each group if mutually allowed
    const groups = Array.from(groupBuckets.values()).map((arr) => arr.slice(0, 1)); // best of each group
    let base = flatten(groups);
    // filter conflicts by combinableWith
    base = base.filter((c, idx, arr) =>
      arr.every((other) => c === other || canCombine(c, other))
    );
    if (base.length) candidates.push(base);

    // Also consider top-2 combos within same group if allowed
    for (const [, arr] of groupBuckets) {
      if (arr.length >= 2) {
        const pair = arr.slice(0, 2);
        if (pair.every((a) => pair.every((b) => a === b || canCombine(a, b)))) {
          candidates.push(pair);
        }
      }
    }

    // Order candidates by summed priority desc as a heuristic
    candidates.sort((a, b) => sumPriority(b) - sumPriority(a));
    return candidates;
  }

  function applyBestStack(offer, stackCandidates) {
    // Evaluate each stack and choose best savings
    let best = { finalPrice: Number(offer.price?.amount || 0), lines: [], totalSavings: 0 };
    for (const candidate of stackCandidates) {
      const res = applyStackOnce(offer, candidate);
      if (res.totalSavings > best.totalSavings) best = res;
    }
    return best;
  }

  function applyStackOnce(offer, stack) {
    const currency = offer.price?.currency || "USD";
    let running = Number(offer.price?.amount || 0);
    const lines = [];
    let usesById = Object.create(null);

    // sort by priority desc (high first)
    const ordered = stack.slice().sort(byPriorityDESC);
    for (const c of ordered) {
      // limits
      if (c.constraints?.perItemLimit && (usesById[c.id] || 0) >= c.constraints.perItemLimit) continue;

      const before = running;
      const { after, savings, description } = applySingleCoupon(c, running, offer);
      if (savings > 0 && after >= 0) {
        running = after;
        lines.push({
          coupon: c,
          description,
          savings,
          currency,
          before,
          after,
        });
        usesById[c.id] = (usesById[c.id] || 0) + 1;
      }
    }
    const totalSavings = Math.max(0, Number(offer.price?.amount || 0) - running);
    return { finalPrice: round2(running), lines, totalSavings: round2(totalSavings) };
  }

  function applySingleCoupon(c, current, offer) {
    const currency = offer.price?.currency || "USD";
    let savings = 0;
    let after = current;

    // threshold gate (if any)
    if (c.threshold?.amount && current < c.threshold.amount) {
      return { after, savings: 0, description: "Threshold not met" };
    }

    switch (c.type) {
      case "amount": {
        savings = Math.min(current, Number(c.value || 0));
        after = current - savings;
        return { after, savings: round2(savings), description: `-$${Number(c.value).toFixed(2)}` };
      }
      case "percent": {
        savings = current * (Number(c.value || 0) / 100);
        after = current - savings;
        return { after: round2(after), savings: round2(savings), description: `-${c.value}%` };
      }
      case "bogo": {
        // Basic BxGy on same SKU: this is a per-offer (single unit) approximation unless quantity known
        const buy = Number(c.buyQty || 1);
        const get = Number(c.getQty || 1);
        if (buy > 0 && get > 0) {
          const unit = current; // single item context; real cart calc should pass qty
          // Approx: pay for buy units and get "get" units free across (buy+get) bundle
          const bundleSize = buy + get;
          const effectivePerBundle = unit * buy; // naive: assume one item price == current
          const perItem = effectivePerBundle / bundleSize;
          savings = unit - perItem;
          after = unit - savings;
          return { after: round2(after), savings: round2(savings), description: `BOGO ${buy}+${get}` };
        }
        return { after, savings: 0, description: "Invalid BOGO" };
      }
      case "threshold": {
        // $X off when reaching threshold (handled above); apply amount
        savings = Math.min(current, Number(c.value || 0));
        after = current - savings;
        return { after: round2(after), savings: round2(savings), description: `Threshold -$${Number(c.value).toFixed(2)}` };
      }
      case "bundle": {
        // For true bundles pass in a synthetic offer with bundle price as current
        savings = Math.min(current, Number(c.value || 0));
        after = current - savings;
        return { after: round2(after), savings: round2(savings), description: `Bundle -$${Number(c.value).toFixed(2)}` };
      }
      default:
        return { after, savings: 0, description: "Unknown coupon" };
    }
  }

  function canCombine(a, b) {
    if (a.constraints?.exclusive || b.constraints?.exclusive) return false;
    const ag = a.constraints?.stackGroup;
    const bg = b.constraints?.stackGroup;
    if (!ag || !bg) return true;
    const allow = (list, g) => Array.isArray(list) ? list.includes(g) : true;
    // symmetric
    return allow(a.stacking?.combinableWith, bg) && allow(b.stacking?.combinableWith, ag);
  }

  function byPriorityDESC(a, b) {
    const pa = Number(a.stacking?.priority ?? 0);
    const pb = Number(b.stacking?.priority ?? 0);
    return pb - pa;
  }

  // ---------------------------------------------------------------------------
  // Profile & Favorites
  // ---------------------------------------------------------------------------

  /**
   * Profile: user coupon environment (providers, stores, zipcode, cadence)
   * { id, label, providerNames:string[], storeIds:string[], zipcode:string, refreshCadence:"off"|"daily"|"weekly" }
   */
  function getActiveProfile() { return profile; }
  function setActiveProfile(p) {
    profile = materializeProfile(p);
    persistProfile(profile);
    eventBus.emit("coupons:profile:activated", { profileId: profile.id, ts: clock.now() });
  }
  function exportProfile() { return JSON.parse(JSON.stringify(profile)); }
  function importProfile(p) {
    profile = materializeProfile(p);
    persistProfile(profile);
    eventBus.emit("coupons:profile:imported", { profileId: profile.id, ts: clock.now() });
    return true;
  }

  /**
   * Favorite session: save a reusable “coupon fetch & apply” preset (aligns with saved sessions)
   * { id, label, providerNames, storeIds, zipcode }
   */
  function listFavoriteSessions() { return favorites.slice(); }
  function saveFavoriteSession({ label, providerNames, storeIds, zipcode }) {
    const id = `couponfav:${Date.now()}`;
    const entry = {
      id,
      label: label || "My Coupon Session",
      providerNames: resolveProviderTargets(providerNames),
      storeIds: storeIds?.length ? storeIds : profile.storeIds,
      zipcode: zipcode || profile.zipcode,
    };
    favorites.push(entry);
    persistFavorites(favorites);
    eventBus.emit("coupons:favorites:saved", { id, ts: clock.now() });
    return id;
  }
  function deleteFavoriteSession(id) {
    const before = favorites.length;
    favorites = favorites.filter((f) => f.id !== id);
    if (favorites.length !== before) {
      persistFavorites(favorites);
      eventBus.emit("coupons:favorites:deleted", { id, ts: clock.now() });
      return true;
    }
    return false;
  }
  async function runFavoriteSession(id, offers = [], opts = {}) {
    const fav = favorites.find((f) => f.id === id);
    if (!fav) throw new Error("Favorite session not found");
    const active = await getActiveCoupons({
      providerNames: fav.providerNames,
      storeIds: fav.storeIds,
      zipcode: fav.zipcode,
    });
    return applyCouponsToOffers(offers, active, { zipcode: fav.zipcode, storeIds: fav.storeIds, ...opts });
  }

  // ---------------------------------------------------------------------------
  // Helpers, Materials, Persistence
  // ---------------------------------------------------------------------------

  function resolveProviderTargets(names) {
    if (Array.isArray(names) && names.length) return names;
    // default to all registered providers or configured defaults
    const cfg = config.get?.("coupons.defaultProviders", null);
    if (Array.isArray(cfg) && cfg.length) return cfg;
    return Array.from(providers.keys());
  }

  function cacheKey(providerNames, storeIds, zipcode) {
    return `${providerNames.sort().join(",")}::${(storeIds || []).join(",")}::${zipcode || ""}`;
    }

  function materializeProvider(p) {
    return {
      name: p.name,
      displayName: p.displayName || capitalize(p.name),
      ttlMs: Number(p.ttlMs || 15 * 60 * 1000), // coupons can live longer than prices
      concurrency: Number(p.concurrency || 2),
      fetchActiveCoupons: p.fetchActiveCoupons || (async () => []),
    };
  }

  function materializeCoupon(c) {
    return {
      id: String(c.id || Math.random().toString(36).slice(2)),
      source: c.source || "store",
      storeId: c.storeId,
      label: c.label || "Coupon",
      type: c.type || "amount",
      value: Number(c.value || 0),
      buyQty: c.buyQty != null ? Number(c.buyQty) : undefined,
      getQty: c.getQty != null ? Number(c.getQty) : undefined,
      threshold: c.threshold ? { amount: Number(c.threshold.amount || 0), currency: c.threshold.currency || "USD" } : undefined,
      appliesTo: {
        skus: c.appliesTo?.skus || [],
        categories: c.appliesTo?.categories || [],
        brands: c.appliesTo?.brands || [],
      },
      constraints: {
        startISO: c.constraints?.startISO,
        endISO: c.constraints?.endISO,
        perOrderLimit: c.constraints?.perOrderLimit != null ? Number(c.constraints.perOrderLimit) : undefined,
        perItemLimit: c.constraints?.perItemLimit != null ? Number(c.constraints.perItemLimit) : undefined,
        memberTier: c.constraints?.memberTier || "any",
        zipWhitelist: c.constraints?.zipWhitelist || [],
        stackGroup: c.constraints?.stackGroup,
        exclusive: !!c.constraints?.exclusive,
        once: !!c.constraints?.once,
      },
      stacking: {
        priority: Number(c.stacking?.priority || 0),
        combinableWith: c.stacking?.combinableWith || [],
      },
      metadata: c.metadata,
    };
  }

  function materializeProfile(p) {
    const provs = resolveProviderTargets(p?.providerNames);
    return {
      id: p?.id || `coupons:profile:${Date.now()}`,
      label: p?.label || "Household Coupons",
      providerNames: provs,
      storeIds: p?.storeIds || [],
      zipcode: p?.zipcode || "",
      refreshCadence: p?.refreshCadence || "off", // "off"|"daily"|"weekly"
    };
  }

  function hydrateCache() { return prefs.get(CACHE_KEY) || {}; }
  function persistCache(c) { try { prefs.set(CACHE_KEY, c); } catch (e) {} }

  function hydrateProfile() {
    const stored = prefs.get(PROFILE_KEY);
    if (stored) return materializeProfile(stored);
    const p = materializeProfile({});
    persistProfile(p);
    return p;
  }
  function persistProfile(p) { try { prefs.set(PROFILE_KEY, p); } catch (e) {} }

  function hydrateFavorites() { return prefs.get(FAVORITES_KEY) || []; }
  function persistFavorites(arr) { try { prefs.set(FAVORITES_KEY, arr); } catch (e) {} }

  // small utils
  function flatten(arr) { return [].concat(...arr); }
  function dedupeCoupons(list) {
    const seen = new Set(); const out = [];
    for (const c of list) {
      const key = `${c.storeId || "_"}::${c.id}`;
      if (!seen.has(key)) { seen.add(key); out.push(c); }
    }
    return out;
  }
  function sumPriority(arr) { return arr.reduce((s, c) => s + Number(c.stacking?.priority || 0), 0); }
  function toErr(e) { return { message: String(e?.message || e), status: e?.status || null }; }
  function capitalize(s) { return String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1); }
  function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }

  async function lazyImport(path) {
    try { return await import(/* @vite-ignore */ path); } catch { return {}; }
  }

  // safe adapters
  function safeFetch() { return (url, opts) => fetch(url, opts); }
  function safeBus() { return { emit: () => {}, on: () => () => {} }; }
  function safeAnalytics() { return { track: () => {} }; }
  function safePrefs() {
    let mem = {};
    let ok = false;
    try { localStorage.setItem("__coupon_probe", "1"); localStorage.removeItem("__coupon_probe"); ok = true; } catch {}
    return {
      get(k) { if (ok) { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; } return mem[k] || null; },
      set(k, v) { if (ok) localStorage.setItem(k, JSON.stringify(v)); else mem[k] = v; },
    };
  }
}

// --------- Singleton convenience ---------------------------------------------
let __couponServiceSingleton;
export function getCouponServiceSingleton(deps) {
  if (!__couponServiceSingleton) __couponServiceSingleton = createCouponService(deps);
  return __couponServiceSingleton;
}

/* -------------------------------------------------------------------------- */
/* Example provider templates (replace endpoints with your proxy/services)     */
/* -------------------------------------------------------------------------- */

export const ExampleStoreCouponsProvider = {
  name: "example-store",
  displayName: "Example Store",
  ttlMs: 30 * 60 * 1000,
  async fetchActiveCoupons({ fetcher, zipcode }) {
    const res = await fetcher(`/api/coupons/example?zip=${encodeURIComponent(zipcode || "")}`, { method: "GET" });
    if (!res.ok) return [];
    const data = await res.json();
    // map upstream → normalized
    return (data.coupons || []).map((x) => ({
      id: x.id,
      source: x.source || "store",
      storeId: x.storeId,
      label: x.title,
      type: x.kind,                 // "percent"|"amount"|...
      value: x.value,
      appliesTo: { skus: x.skus, categories: x.categories, brands: x.brands },
      constraints: {
        startISO: x.start,
        endISO: x.end,
        exclusive: !!x.exclusive,
        stackGroup: x.stackGroup,
        perItemLimit: x.perItemLimit,
        memberTier: x.memberTier || "any",
      },
      stacking: { priority: x.priority || 0, combinableWith: x.combinableWith || [] },
    }));
  },
};

export const ManufacturerCouponsProvider = {
  name: "mfr",
  displayName: "Manufacturer",
  ttlMs: 24 * 60 * 60 * 1000,
  async fetchActiveCoupons({ fetcher }) {
    const res = await fetcher(`/api/coupons/mfr`, { method: "GET" });
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).map((x) => ({
      id: x.id, source: "manufacturer", label: x.label, type: x.type, value: x.value,
      appliesTo: { brands: x.brands, skus: x.skus, categories: x.categories },
      constraints: { exclusive: !!x.exclusive, stackGroup: x.stackGroup, endISO: x.endISO },
      stacking: { priority: Number(x.priority || 0), combinableWith: x.combinableWith || [] },
    }));
  },
};
