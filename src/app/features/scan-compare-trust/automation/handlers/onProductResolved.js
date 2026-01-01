/* eslint-disable no-console */
// src/features/scan-compare-trust/automation/handlers/onProductResolved.js
// Fan-out after product resolution: safety • pricing • coupons (parallel)
// Emits canonical events, aggregates results, learns cycles, computes trust+NBA.
//
// Expected upstream event: 'scan:item:resolved' OR direct call with payload:
// {
//   requestId, sessionId, userId?, householdId?,
//   product,                     // minimal-safe product shape
//   context?: { stores?: string[], storeHints?: string[], location?, device? },
//   flags?: { allowPartial?: boolean },
//   meta?: { favoriteSessionName?, scheduleId?, templateId? } // optional passthrough
// }

export default function createOnProductResolved(deps = {}) {
  // --- DI defaults ------------------------------------------------------------
  const eventBus        = deps.eventBus        || { emit: () => {}, once: () => {}, off: () => {} };
  const config          = deps.config          || { get: () => undefined };
  const analytics       = deps.analytics       || { track: () => {} };
  const safetyService   = deps.safetyService   || { evaluate: async () => ({ ok: true, findings: [] }) };
  const pricingService  = deps.pricingService  || { quote:   async () => ({ quotes: [], hints: [] }) };
  const couponService   = deps.couponService   || { find:    async () => ({ coupons: [], stacking: [], rulesVersion: '0' }) };
  const cycleAnalyzer   = deps.cycleAnalyzer   || { learn: async () => {}, predict: () => null };
  const favorites       = deps.favorites       || { saveSession: async () => {}, getSessionById: async () => null };
  const schedules       = deps.schedules       || { rememberLastRun: async () => {} };
  const dexie           = deps.dexie           || {};
  const clock           = deps.clock           || { now: () => new Date() };
  const cache           = deps.cache           || createTTLCache();
  const uid             = deps.uid             || { rid: () => cryptoRandomId() };

  const DEFAULT_TIMEOUT_MS = config.get?.('scanCompareTrust.timeouts.fanout', 20000) ?? 20000;

  // --- Handler ----------------------------------------------------------------
  return async function onProductResolved(payload = {}) {
    const startedAt = clock.now();
    const requestId = payload.requestId || uid.rid();
    const sessionId = payload.sessionId || uid.rid();

    const {
      product,
      context = {},
      flags = {},
      userId,
      householdId,
      meta = {}
    } = payload;

    const allowPartial = flags.allowPartial ?? true;

    // Defensive product check
    if (!product) {
      const error = { code: 'NO_PRODUCT', message: 'onProductResolved called without product' };
      eventBus.emit('scan:item:failed', { ok: false, requestId, sessionId, error });
      return { ok: false, requestId, sessionId, error };
    }

    // Resolve store list (prefer explicit → hints → userPrefs)
    const userPrefs = await loadUserPrefsSafe(config, userId, householdId);
    const stores = resolveStoreList(context, userPrefs);

    // Dedup key across inflight/TTL cache
    const cacheKey = buildCacheKey(product, stores);
    const cached = cache.get(cacheKey);
    if (cached) {
      eventBus.emit('fanout:cache:hit', { requestId, sessionId, cacheKey });
      analytics.track('fanout_cache_hit', { requestId, sessionId });
      // Still emit a completed event so downstream UI can react
      eventBus.emit('scan:fanout:completed', { requestId, sessionId, ...cached, cached: true });
      return { ok: true, requestId, sessionId, ...cached, cached: true };
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort('timeout'), DEFAULT_TIMEOUT_MS);

    // Per-branch timers for metrics
    const t0 = clock.now();

    // Launch branches in parallel (settled so we can allow partials)
    const safetyP  = timed('safety',  () => safetyService.evaluate(product, { signal: abortController.signal, userPrefs, context }),  eventBus, requestId, sessionId, clock);
    const pricingP = timed('pricing', () => pricingService.quote(product, stores, { signal: abortController.signal, userPrefs, context }), eventBus, requestId, sessionId, clock);
    const couponsP = timed('coupons', () => couponService.find(product, stores, { signal: abortController.signal, userPrefs, context }),  eventBus, requestId, sessionId, clock);

    // As results settle, emit stage events
    const [safetyRes, pricingRes, couponsRes] = await Promise.allSettled([safetyP, pricingP, couponsP]);

    clearTimeout(timeoutId);

    // Normalize branch outputs
    const safety  = safetyRes.status  === 'fulfilled' ? safetyRes.value  : null;
    const pricing = pricingRes.status === 'fulfilled' ? pricingRes.value : null;
    const coupons = couponsRes.status === 'fulfilled' ? couponsRes.value : null;

    // Emit per-branch results (so UI can stream in)
    eventBus.emit('product:safety:evaluated', {
      requestId, sessionId, productId: product?.id || product?.gtin || product?.sku,
      safety, error: safety ? null : extractErr(safetyRes)
    });
    eventBus.emit('pricing:quoted', {
      requestId, sessionId, productId: product?.id || product?.gtin || product?.sku,
      pricing, stores, error: pricing ? null : extractErr(pricingRes)
    });
    eventBus.emit('coupons:found', {
      requestId, sessionId, productId: product?.id || product?.gtin || product?.sku,
      coupons, error: coupons ? null : extractErr(couponsRes)
    });

    // If nothing landed and partials not allowed → fail
    if (!safety && !pricing && !coupons && !allowPartial) {
      const error = normalizeError(safetyRes?.reason || pricingRes?.reason || couponsRes?.reason);
      analytics.track('fanout_failed', { requestId, sessionId, code: error.code });
      eventBus.emit('scan:item:failed', { ok: false, requestId, sessionId, error });
      return { ok: false, requestId, sessionId, error };
    }

    // Attribution + learning
    const attribution = buildAttribution({ safety, pricing, coupons });
    try { await learnCycles(cycleAnalyzer, product, pricing, coupons); } catch (e) { console.warn('cycle.learn failed', e); }

    // Trust + NBA
    const trust = computeTrustScore({ safety, pricing, coupons });
    const nba   = nextBestActions({ safety, pricing, coupons, userPrefs, product });

    // Persist to Dexie if available (append to scan row if present)
    if (dexie?.scans?.where && requestId) {
      try {
        const hit = await dexie.scans.where('id').equals(requestId).first();
        if (hit?.id) {
          await dexie.scans.update(hit.id, {
            product, safety, pricing, coupons, attribution, trust, nba,
            fanoutCompletedAt: clock.now().toISOString(),
          });
        }
      } catch {}
    }

    // Save cache (TTL)
    const aggregate = {
      product: pickSafeProductShape(product),
      safety, pricing, coupons, attribution, trust, nba, stores,
      durationMs: clock.now() - t0,
    };
    cache.set(cacheKey, aggregate);

    // Remember run (scheduler recap)
    try { await schedules.rememberLastRun({ type: 'scan-fanout', requestId, sessionId, userId, scheduleId: meta.scheduleId || null, atISO: clock.now().toISOString() }); } catch {}

    // Optionally save favorite session template when asked
    if (meta.favoriteSessionName) {
      try {
        await favorites.saveSession({
          name: meta.favoriteSessionName,
          kind: 'scanPipeline',
          template: { stores, flags: { allowPartial }, scheduleId: meta.scheduleId || null },
          savedAt: clock.now().toISOString(),
          userId, householdId,
        });
        eventBus.emit('favorites:session:saved', { requestId, sessionId, name: meta.favoriteSessionName, type: 'scanPipeline' });
      } catch (e) { console.warn('favorites.saveSession failed', e); }
    }

    // Final aggregate event
    const result = { ok: true, requestId, sessionId, ...aggregate };
    eventBus.emit('scan:fanout:completed', result);
    analytics.track('fanout_completed', { requestId, sessionId, trustScore: trust.score, quotes: pricing?.quotes?.length || 0 });
    return result;
  };

  // --- Helpers ----------------------------------------------------------------

  function cryptoRandomId() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch {}
    return 'rid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function extractErr(settled) {
    if (settled?.status === 'rejected') {
      const e = settled.reason;
      return { code: e?.code || 'BRANCH_ERROR', message: e?.message || String(e) };
    }
    return null;
  }

  function normalizeError(err) {
    if (err?.name === 'AbortError' || err === 'timeout') {
      return { code: 'TIMEOUT', message: 'Fan-out timed out' };
    }
    return { code: err?.code || 'UNKNOWN', message: err?.message || String(err) };
  }

  async function loadUserPrefsSafe(config, userId, householdId) {
    try {
      const prefs = await config.get?.('userPrefs.loader')?.(userId, householdId);
      if (prefs) return prefs;
    } catch {}
    return {
      stores: config.get?.('scanCompareTrust.defaultStores', []) ?? [],
      couponOptIns: {},
      loyalty: {},
      avoidIngredients: [],
      dietTags: [],
    };
  }

  function resolveStoreList(context, userPrefs) {
    const manual  = Array.isArray(context?.stores) ? context.stores : [];
    const hints   = Array.isArray(context?.storeHints) ? context.storeHints : [];
    const pref    = Array.isArray(userPrefs?.stores) ? userPrefs.stores : [];
    const merged  = [...new Set([...manual, ...hints, ...pref])];
    const limit   = Math.max(1, Math.min(6, config.get?.('scanCompareTrust.maxStores', 6) ?? 6));
    return merged.slice(0, limit);
  }

  function buildCacheKey(product, stores) {
    const key = product?.sku || product?.gtin || product?.id || product?.upc || 'unknown';
    return `fanout:${key}:${stores.sort().join('|')}`;
  }

  function buildAttribution({ safety, pricing, coupons }) {
    const sources = [];
    if (safety)  sources.push({ type: 'safety',  count: safety.findings?.length || 0 });
    if (pricing) sources.push({ type: 'pricing', count: pricing.quotes?.length || 0 });
    if (coupons) sources.push({ type: 'coupons', count: coupons.coupons?.length || 0, rulesVersion: coupons.rulesVersion });
    return { sources };
  }

  async function learnCycles(analyzer, product, pricing, coupons) {
    const sku = product?.sku || product?.gtin || product?.id;
    if (!sku) return;
    const nowISO = new Date().toISOString();
    const records = [];
    (pricing?.quotes || []).forEach(q => {
      records.push({
        type: 'price',
        storeId: q.storeId,
        sku,
        unitPrice: q.unitPrice,
        promo: !!q.promo,
        capturedAtISO: nowISO,
      });
    });
    (coupons?.coupons || []).forEach(c => {
      records.push({
        type: 'coupon',
        storeId: c.storeId,
        sku,
        value: c.value,
        category: c.category,
        expiresISO: c.expiresISO,
        capturedAtISO: nowISO,
      });
    });
    for (const r of records) { // sequential to keep analyzer simple
      // eslint-disable-next-line no-await-in-loop
      await analyzer.learn(r, {});
    }
  }

  function computeTrustScore({ safety, pricing, coupons }) {
    let score = 100;
    if (safety?.findings?.length) {
      for (const f of safety.findings) {
        if (f.severity === 'high') score -= 40;
        else if (f.severity === 'medium') score -= 20;
        else score -= 5;
      }
    }
    if (!pricing?.quotes?.length) score -= 10;
    const couponBoost = Math.min((coupons?.coupons?.length || 0) * 2, 10);
    score = Math.max(0, Math.min(100, score + couponBoost));
    return {
      score,
      rationale: {
        safetyCount: safety?.findings?.length || 0,
        quotes: pricing?.quotes?.length || 0,
        coupons: coupons?.coupons?.length || 0,
      }
    };
  }

  function nextBestActions({ safety, pricing, coupons, userPrefs, product }) {
    const actions = [];
    if (safety?.findings?.some(f => f.severity === 'high')) {
      actions.push({ type: 'avoid', label: 'Avoid – serious safety concern', priority: 'urgent' });
    }
    const quotes = pricing?.quotes || [];
    if (quotes.length) {
      const best = [...quotes].sort((a, b) => (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity))[0];
      if (best) {
        const hasCoupon = (coupons?.coupons || []).some(c => c.storeId === best.storeId);
        actions.push({
          type: 'buy',
          label: `Best price at ${best.storeName || best.storeId}`,
          meta: { storeId: best.storeId, couponAvailable: hasCoupon, unitPrice: best.unitPrice },
          priority: 'high'
        });
      }
    }
    if ((coupons?.coupons || []).length) {
      actions.push({ type: 'clip_coupons', label: 'Clip available coupons', priority: 'high' });
    }
    // Predictive hint
    try {
      const bestStore = quotes[0]?.storeId;
      const pred = bestStore ? cycleAnalyzer?.predict?.(product?.sku || product?.gtin, bestStore, {}) : null;
      if (pred?.nextExpectedISO) {
        actions.push({ type: 'wait_for_sale', label: 'Sale predicted soon', meta: pred, priority: 'medium' });
      }
    } catch {}
    return actions;
  }

  function pickSafeProductShape(p) {
    if (!p) return null;
    const {
      id, sku, gtin, upc, brand, name, size, unit, images,
      category, subcategory, nutrition, ingredients, tags, meta
    } = p;
    return {
      id, sku, gtin, upc, brand, name, size, unit, images,
      category, subcategory, nutrition, ingredients, tags,
      meta: meta ? {
        ...meta,
        providers: Array.isArray(meta.providers) ? meta.providers.map(x => ({ id: x.id, name: x.name })) : undefined
      } : undefined
    };
  }

  function createTTLCache({ ttlMs } = { ttlMs: 5 * 60 * 1000 }) {
    const map = new Map();
    return {
      get(key) {
        const row = map.get(key);
        if (!row) return null;
        if (Date.now() > row.exp) { map.delete(key); return null; }
        return row.val;
      },
      set(key, val) {
        map.set(key, { val, exp: Date.now() + ttlMs });
      }
    };
  }

  async function timed(label, fn, eventBus, requestId, sessionId, clock) {
    const start = clock.now();
    try {
      const val = await fn();
      eventBus.emit(`fanout:${label}:completed`, { requestId, sessionId, durationMs: clock.now() - start });
      return val;
    } catch (e) {
      eventBus.emit(`fanout:${label}:failed`, { requestId, sessionId, durationMs: clock.now() - start, error: { message: e?.message || String(e) } });
      throw e;
    }
  }
}
