/* eslint-disable no-console */
// src/features/scan-compare-trust/automation/handlers/onScanItemRequested.js
// Handler: Kick off resolve pipeline for Scan • Compare • Trust
// Orchestration order: resolve → safety → pricing → coupons → attribution → learn → complete
// Design goals:
// - Event-driven, idempotent, DI-friendly, safe fallbacks, cancellation, timeouts
// - Barcode or Image (OCR) input; supports multi-store compare using user prefs
// - Honors Sabbath guard & quiet hours (will defer if configured)
// - Supports saving/reusing "favorite scan sessions" and scheduled runs
// - Emits canonical events (see events.catalog.js) with stable payload contracts
//
// Expected deps (all optional; safe no-ops if not provided):
// - eventBus        : { emit(evt, payload), once(evt, fn), off(evt, fn) }
// - config          : { get(path, fb), sabbathGuard?{enabled,start,end}, quietHours?{start,end} }
// - analytics       : { track(evt, payload) }
// - productResolver : { resolveByBarcode(gtin, ctx), resolveByText(text, ctx), hydrateMeta(product, ctx) }
// - safetyService   : { evaluate(product, ctx) }           // recalls, harmful ingredients, allergens
// - pricingService  : { quote(product, stores[], ctx) }    // StoreCatalogAdapters.js powered
// - couponService   : { find(product, stores[], ctx) }     // CouponService.js (+ opt-ins/loyalty)
// - cycleAnalyzer   : { learn(record, ctx), predict(sku, storeId, ctx) } // CycleAnalyzer.js
// - ocrService      : { extractTextFromImage(fileOrBlob, ctx) } // tesseract worker wrapper
// - favorites       : { saveSession(sessionObj), getSessionById(id) }     // user favorites
// - schedules       : { expandSchedule(scheduleId), rememberLastRun(meta) } // optional
// - dexie           : { scans?:Table, products?:Table }     // persistence (optional)
// - clock           : { now(): Date }                       // testable clock
// - uid             : { rid(): string, sid(): string }      // id gens (request/session)
//
// Input payload (from "scan:item:requested"):
// {
//   requestId?, householdId?, userId?,
//   input: { type: 'barcode'|'image'|'text', value: string|Blob },
//   context?: { stores?: string[], storeHints?: string[], location?, device? },
//   scheduleId?, sessionTemplateId?, favoriteSessionName?, // for saving/re-using
//   flags?: { hydrate?: boolean, compareAllPreferred?: boolean, allowPartial?: boolean, deferIfGuarded?: boolean }
// }

export default function createOnScanItemRequested(deps = {}) {
  // --- Safe DI defaults -------------------------------------------------------
  const eventBus        = deps.eventBus        || { emit: () => {}, once: () => {}, off: () => {} };
  const config          = deps.config          || { get: () => undefined, sabbathGuard: {}, quietHours: {} };
  const analytics       = deps.analytics       || { track: () => {} };
  const productResolver = deps.productResolver || { resolveByBarcode: async () => null, resolveByText: async () => null, hydrateMeta: async (p)=>p };
  const safetyService   = deps.safetyService   || { evaluate: async () => ({ ok: true, findings: [] }) };
  const pricingService  = deps.pricingService  || { quote: async () => ({ quotes: [], hints: [] }) };
  const couponService   = deps.couponService   || { find: async () => ({ coupons: [], stacking: [], rulesVersion: '0' }) };
  const cycleAnalyzer   = deps.cycleAnalyzer   || { learn: async () => {}, predict: () => null };
  const ocrService      = deps.ocrService      || { extractTextFromImage: async () => '' };
  const favorites       = deps.favorites       || { saveSession: async () => {}, getSessionById: async () => null };
  const schedules       = deps.schedules       || { expandSchedule: async () => null, rememberLastRun: async () => {} };
  const dexie           = deps.dexie           || {};
  const clock           = deps.clock           || { now: () => new Date() };
  const uid             = deps.uid             || { rid: () => cryptoRandomId(), sid: () => cryptoRandomId() };

  // Small helper to generate IDs if none provided in DI
  function cryptoRandomId() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
      return 'rid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    } catch {
      return 'rid_' + Math.random().toString(36).slice(2);
    }
  }

  // --- Guards ----------------------------------------------------------------
  function isWithinRange(now, startHHMM = '23:59', endHHMM = '00:00') {
    const [sh, sm] = startHHMM.split(':').map(Number);
    const [eh, em] = endHHMM.split(':').map(Number);
    const start = new Date(now); start.setHours(sh ?? 0, sm ?? 0, 0, 0);
    const end   = new Date(now); end.setHours(eh ?? 0, em ?? 0, 0, 0);
    // Handles overnight windows (e.g., 22:00–06:00)
    return start <= end ? (now >= start && now <= end) : (now >= start || now <= end);
  }

  function sabbathGuardActive(now) {
    const sg = config.sabbathGuard || config.get?.('sabbathGuard', {});
    if (!sg?.enabled) return false;
    const start = sg.start || 'Friday 18:00';
    const end   = sg.end   || 'Saturday 20:00';
    // Simple approximation: block from Friday 18:00 to Saturday 20:00 local
    const day = now.getDay(); // 0=Sun…6=Sat
    const hours = now.getHours();
    if (day === 5 && hours >= 18) return true;     // Fri eve
    if (day === 6 && hours <= 20) return true;     // Sat until 20:00
    return false;
  }

  function quietHoursActive(now) {
    const qh = config.quietHours || config.get?.('quietHours', {});
    if (!qh?.start || !qh?.end) return false;
    return isWithinRange(now, qh.start, qh.end);
  }

  // --- Core handler -----------------------------------------------------------
  return async function onScanItemRequested(payload = {}, options = {}) {
    const startedAt = clock.now();
    const requestId = payload.requestId || uid.rid();
    const sessionId = uid.sid();

    const {
      input,
      context = {},
      flags = {},
      userId,
      householdId,
      scheduleId,
      sessionTemplateId,
      favoriteSessionName
    } = payload;

    // Default flags
    const effectiveFlags = {
      hydrate: true,
      compareAllPreferred: true,
      allowPartial: true,
      deferIfGuarded: true,
      ...flags,
    };

    // Emit initial event
    eventBus.emit('scan:item:requested', {
      requestId, sessionId, userId, householdId,
      atISO: startedAt.toISOString(),
      inputMeta: { type: input?.type, hasValue: !!input?.value, size: input?.value?.size },
      context,
      flags: effectiveFlags,
    });
    analytics.track('scan_item_requested', { requestId, sessionId, inputType: input?.type, stores: context?.stores });

    // Guards — optionally defer
    const now = startedAt;
    const guarded = sabbathGuardActive(now) || quietHoursActive(now);
    if (guarded && effectiveFlags.deferIfGuarded) {
      eventBus.emit('scan:item:deferred', {
        requestId, sessionId, reason: sabbathGuardActive(now) ? 'sabbathGuard' : 'quietHours',
        atISO: now.toISOString(),
      });
      analytics.track('scan_item_deferred', { requestId, guard: sabbathGuardActive(now) ? 'sabbath' : 'quietHours' });
      return { ok: true, deferred: true, requestId, sessionId };
    }

    // Build run context
    const userPrefs = await loadUserPrefsSafe(config, userId, householdId);
    const preferredStores = resolveStoreList(context, userPrefs, effectiveFlags);
    const abortController = new AbortController();
    const timeoutMs = config.get?.('scanCompareTrust.timeouts.request', 25000) ?? 25000;
    const timeoutHandle = setTimeout(() => abortController.abort('timeout'), timeoutMs);

    // If schedule or template provided, expand them (non-blocking best-effort)
    let scheduleMeta = null;
    if (scheduleId) {
      try { scheduleMeta = await schedules.expandSchedule(scheduleId); } catch {}
    }
    let templateMeta = null;
    if (sessionTemplateId) {
      try { templateMeta = await favorites.getSessionById(sessionTemplateId); } catch {}
    }

    // Persist a "pending scan" row (optional)
    if (dexie?.scans?.add) {
      try {
        await dexie.scans.add({
          id: requestId,
          sessionId,
          userId, householdId,
          status: 'pending',
          inputType: input?.type,
          requestedAt: startedAt.toISOString(),
          preferredStores,
        });
      } catch (e) { /* no-op */ }
    }

    try {
      // 1) Resolve product (barcode / image OCR / free text)
      const resolveStart = clock.now();
      const { product, resolveInfo } = await resolveProduct(input, { productResolver, ocrService, signal: abortController.signal, userPrefs, preferredStores });
      if (!product) throw new Error('RESOLVE_NOT_FOUND');

      const hydrated = effectiveFlags.hydrate
        ? await safeHydrate(productResolver, product, { signal: abortController.signal })
        : product;

      eventBus.emit('scan:item:resolved', {
        requestId, sessionId,
        product: pickSafeProductShape(hydrated),
        resolveInfo,
        durationMs: clock.now() - resolveStart,
      });
      analytics.track('scan_item_resolved', { requestId, sku: hydrated?.sku, gtin: hydrated?.gtin });

      // 2) Safety evaluation (recalls, harmful ingredients, allergens, user avoid lists)
      const safetyStart = clock.now();
      const safety = await safetyService.evaluate(hydrated, {
        signal: abortController.signal,
        userPrefs,
        context: { stores: preferredStores, location: context.location }
      });
      eventBus.emit('product:safety:evaluated', {
        requestId, sessionId,
        productId: hydrated?.id || hydrated?.gtin || hydrated?.sku,
        safety,
        durationMs: clock.now() - safetyStart,
      });

      // 3) Pricing (multi-store compare per user prefs/hints)
      const pricingStart = clock.now();
      const pricing = await pricingService.quote(hydrated, preferredStores, {
        signal: abortController.signal,
        userPrefs,
        context,
      });
      eventBus.emit('pricing:quoted', {
        requestId, sessionId,
        productId: hydrated?.id || hydrated?.gtin || hydrated?.sku,
        pricing,
        durationMs: clock.now() - pricingStart,
      });

      // 4) Coupons (stacking rules, loyalty IDs, digital clip links)
      const couponsStart = clock.now();
      const coupons = await couponService.find(hydrated, preferredStores, {
        signal: abortController.signal,
        userPrefs,
        context,
      });
      eventBus.emit('coupons:found', {
        requestId, sessionId,
        productId: hydrated?.id || hydrated?.gtin || hydrated?.sku,
        coupons,
        durationMs: clock.now() - couponsStart,
      });

      // 5) Attribution block for UI (SourceAttribution.jsx)
      const attribution = buildAttribution(resolveInfo, safety, pricing, coupons);

      // 6) Learn discount cadence (CycleAnalyzer)
      await learnCycles(cycleAnalyzer, hydrated, pricing, coupons, { userPrefs, context });

      // 7) Trust score + NBA (lightweight heuristic here; your NBA engine can replace)
      const trust = computeTrustScore({ safety, pricing, coupons });
      const nba   = nextBestActions({ safety, pricing, coupons, userPrefs, product: hydrated });

      // Persist success (optional)
      if (dexie?.scans?.update) {
        try {
          await dexie.scans.update(requestId, {
            status: 'completed',
            completedAt: clock.now().toISOString(),
            product: pickSafeProductShape(hydrated),
            safety, pricing, coupons, trust, nba, attribution
          });
        } catch {}
      }
      if (dexie?.products?.put && hydrated) {
        try {
          await dexie.products.put({ ...hydrated, updatedAt: clock.now().toISOString() });
        } catch {}
      }

      // Save favorite session (optional)
      if (favoriteSessionName) {
        try {
          await favorites.saveSession({
            name: favoriteSessionName,
            kind: 'scanPipeline',
            template: {
              stores: preferredStores,
              flags: effectiveFlags,
              scheduleId: scheduleId || null,
            },
            savedAt: clock.now().toISOString(),
            userId, householdId,
          });
          eventBus.emit('favorites:session:saved', {
            requestId, sessionId, name: favoriteSessionName, type: 'scanPipeline'
          });
        } catch (e) {
          console.warn('favorites.saveSession failed', e);
        }
      }

      // Remember last run (for scheduler recap/“Run Again” CTA)
      try { await schedules.rememberLastRun({ type: 'scan', requestId, sessionId, userId, scheduleId, atISO: clock.now().toISOString() }); } catch {}

      // Final completion
      const result = {
        ok: true, deferred: false, requestId, sessionId,
        product: pickSafeProductShape(hydrated),
        safety, pricing, coupons, attribution, trust, nba,
        stores: preferredStores,
      };

      eventBus.emit('scan:item:completed', result);
      analytics.track('scan_item_completed', { requestId, sessionId, trustScore: trust.score });
      clearTimeout(timeoutHandle);
      return result;

    } catch (err) {
      const error = normalizeError(err);
      console.error('[onScanItemRequested] failed', error);

      if (dexie?.scans?.update) {
        try {
          await dexie.scans.update(requestId, {
            status: 'failed',
            failedAt: clock.now().toISOString(),
            error: { code: error.code, message: error.message }
          });
        } catch {}
      }

      const failPayload = { ok: false, deferred: false, requestId, sessionId, error };
      eventBus.emit('scan:item:failed', failPayload);
      analytics.track('scan_item_failed', { requestId, code: error.code });
      clearTimeout(timeoutHandle);

      if (effectiveFlags.allowPartial && error.partial) {
        // Return whatever we managed to gather
        const partial = { ...failPayload, ...error.partial };
        eventBus.emit('scan:item:partial', partial);
        return partial;
      }
      return failPayload;
    }
  };

  // --- Helpers ----------------------------------------------------------------

  async function loadUserPrefsSafe(config, userId, householdId) {
    try {
      // Prefer a dedicated prefs store if available (e.g., useCouponPrefs.js)
      const prefs = await config.get?.('userPrefs.loader')?.(userId, householdId);
      if (prefs) return prefs;
    } catch {}
    // Fallback to static config
    return {
      stores: config.get?.('scanCompareTrust.defaultStores', []) ?? [],
      couponOptIns: {},
      loyalty: {},
      avoidIngredients: [],
      dietTags: [],
    };
  }

  function resolveStoreList(context, userPrefs, flags) {
    const hints  = context?.storeHints || [];
    const manual = context?.stores || [];
    const preferred = Array.isArray(userPrefs?.stores) ? userPrefs.stores : [];
    const base = flags.compareAllPreferred ? [...new Set([...manual, ...hints, ...preferred])] : [...new Set([...manual, ...hints])];
    // Limit & order if config provides a sorter
    return base.slice(0, 6);
  }

  async function resolveProduct(input, { productResolver, ocrService, signal, userPrefs, preferredStores }) {
    if (!input?.type) throw new Error('INVALID_INPUT');
    let product = null;
    let resolveInfo = { path: input.type, raw: null };

    if (input.type === 'barcode') {
      product = await productResolver.resolveByBarcode(String(input.value), { signal, userPrefs, stores: preferredStores });
      resolveInfo.raw = { gtin: String(input.value) };
    } else if (input.type === 'image') {
      const text = await ocrService.extractTextFromImage(input.value, { signal });
      resolveInfo.raw = { ocr: text?.slice?.(0, 500) || '' };
      product = await productResolver.resolveByText(text, { signal, userPrefs, stores: preferredStores });
    } else if (input.type === 'text') {
      product = await productResolver.resolveByText(String(input.value), { signal, userPrefs, stores: preferredStores });
      resolveInfo.raw = { query: String(input.value) };
    } else {
      throw new Error('UNSUPPORTED_INPUT');
    }

    return { product, resolveInfo };
  }

  async function safeHydrate(resolver, product, ctx) {
    try {
      return await resolver.hydrateMeta(product, ctx);
    } catch {
      return product;
    }
  }

  function pickSafeProductShape(p) {
    if (!p) return null;
    const {
      id, sku, gtin, upc, brand, name, size, unit, images,
      category, subcategory, nutrition, ingredients, tags, meta
    } = p;
    return {
      id, sku, gtin, upc, brand, name, size, unit, images,
      category, subcategory,
      nutrition, ingredients,
      tags, meta: meta ? { ...meta, // strip heavy internals if present
        providers: Array.isArray(meta.providers) ? meta.providers.map(x => ({ id: x.id, name: x.name })) : undefined
      } : undefined
    };
  }

  function buildAttribution(resolveInfo, safety, pricing, coupons) {
    const sources = [];
    if (resolveInfo?.raw) sources.push({ type: 'resolver', details: { path: resolveInfo.path } });
    if (Array.isArray(safety?.findings)) sources.push({ type: 'safety', count: safety.findings.length });
    if (Array.isArray(pricing?.quotes)) sources.push({ type: 'pricing', count: pricing.quotes.length });
    if (Array.isArray(coupons?.coupons)) sources.push({ type: 'coupons', count: coupons.coupons.length });
    return { sources, rulesVersion: coupons?.rulesVersion, hints: pricing?.hints || [] };
  }

  async function learnCycles(analyzer, product, pricing, coupons, ctx) {
    try {
      const records = [];
      (pricing?.quotes || []).forEach(q => {
        records.push({
          type: 'price',
          storeId: q.storeId,
          sku: product?.sku || product?.gtin,
          unitPrice: q.unitPrice,
          promo: q.promo ?? false,
          capturedAtISO: new Date().toISOString(),
        });
      });
      (coupons?.coupons || []).forEach(c => {
        records.push({
          type: 'coupon',
          storeId: c.storeId,
          sku: product?.sku || product?.gtin,
          value: c.value,
          category: c.category,
          expiresISO: c.expiresISO,
          capturedAtISO: new Date().toISOString(),
        });
      });
      for (const r of records) { // sequential for simplicity; analyzer can batch
        // eslint-disable-next-line no-await-in-loop
        await analyzer.learn(r, ctx);
      }
    } catch (e) {
      console.warn('cycleAnalyzer.learn failed', e);
    }
  }

  function computeTrustScore({ safety, pricing, coupons }) {
    let score = 100;
    // Safety deductions
    if (safety?.findings?.length) {
      for (const f of safety.findings) {
        if (f.severity === 'high') score -= 40;
        else if (f.severity === 'medium') score -= 20;
        else score -= 5;
      }
    }
    // Price sanity: if no quotes, small deduction
    if (!pricing?.quotes?.length) score -= 10;
    // Coupons available can boost perceived value (cap boost)
    const boost = Math.min((coupons?.coupons?.length || 0) * 2, 10);
    score = Math.max(0, Math.min(100, score + boost));
    return { score, rationale: { safetyCount: safety?.findings?.length || 0, quotes: pricing?.quotes?.length || 0, coupons: coupons?.coupons?.length || 0 } };
  }

  function nextBestActions({ safety, pricing, coupons, userPrefs, product }) {
    const actions = [];
    if (safety?.findings?.some(f => f.severity === 'high')) {
      actions.push({ type: 'avoid', label: 'Avoid – safety concern', priority: 'urgent' });
    } else if (pricing?.quotes?.length) {
      // pick best price
      const best = [...pricing.quotes].sort((a, b) => (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity))[0];
      if (best) {
        const hasCoupon = (coupons?.coupons || []).some(c => c.storeId === best.storeId);
        actions.push({
          type: 'buy',
          label: `Best price at ${best.storeName || best.storeId}`,
          meta: { storeId: best.storeId, couponAvailable: hasCoupon },
          priority: 'high'
        });
      }
    }
    if ((coupons?.coupons || []).length) {
      actions.push({ type: 'clip_coupons', label: 'Clip available coupons', priority: 'high' });
    }
    // Prediction hint
    try {
      const storeId = pricing?.quotes?.[0]?.storeId;
      const pred = storeId ? deps.cycleAnalyzer?.predict?.(product?.sku || product?.gtin, storeId, {}) : null;
      if (pred?.nextExpectedISO) {
        actions.push({ type: 'wait_for_sale', label: 'Sale predicted soon', meta: pred, priority: 'medium' });
      }
    } catch {}
    return actions;
  }

  function normalizeError(err) {
    if (err?.name === 'AbortError' || err === 'timeout') {
      return { code: 'TIMEOUT', message: 'Request timed out', cause: err };
    }
    if (err?.message === 'RESOLVE_NOT_FOUND') {
      return { code: 'RESOLVE_NOT_FOUND', message: 'No matching product found' };
    }
    if (err?.message === 'UNSUPPORTED_INPUT') {
      return { code: 'UNSUPPORTED_INPUT', message: 'Unsupported scan input type' };
    }
    if (err?.message === 'INVALID_INPUT') {
      return { code: 'INVALID_INPUT', message: 'Invalid scan input' };
    }
    return { code: 'UNKNOWN', message: err?.message || String(err) };
  }
}
