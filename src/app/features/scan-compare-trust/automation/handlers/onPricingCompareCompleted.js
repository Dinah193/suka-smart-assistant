/* eslint-disable no-console */
// src/features/scan-compare-trust/automation/handlers/onPricingCompareCompleted.js
// Purpose: After pricing quotes settle, compute candidates, update Pricebook,
// emit NBA nudges/toasts, and persist for UI (Scan • Compare • Trust).

// Upstream typical payload (from 'pricing:quoted' or fan-out aggregate):
// {
//   requestId, sessionId, userId?, householdId?,
//   product,                            // safe shape (id/sku/gtin/name/brand/...)
//   pricing: { quotes:[{ storeId, storeName, unitPrice, promo?, size?, unit?, aisle?, url?, pickupEligible?, deliveryEligible?, currency? }], hints?[] },
//   coupons?: { coupons:[{ storeId, value, type:'amount'|'percent', stackable?, requiresLoyalty?, expiresISO? }], rulesVersion },
//   stores?: string[],
//   meta?: { favoriteSessionName?, scheduleId?, templateId? },
//   flags?: { allowPartial?: boolean, enableToasts?: boolean }
// }

export default function createOnPricingCompareCompleted(deps = {}) {
  // ---- DI defaults (all optional; safe no-ops) -------------------------------
  const eventBus      = deps.eventBus      || { emit: () => {} };
  const config        = deps.config        || { get: () => undefined, sabbathGuard: {}, quietHours: {} };
  const analytics     = deps.analytics     || { track: () => {} };
  const dexie         = deps.dexie         || {}; // { pricebook?:Table, candidates?:Table, inbox?:Table, scans?:Table }
  const cycleAnalyzer = deps.cycleAnalyzer || { learn: async () => {}, predict: () => null };
  const nba           = deps.nba           || { queue: async () => {}, preferInbox: () => false };
  const favorites     = deps.favorites     || { saveSession: async () => {}, getSessionById: async () => null };
  const uid           = deps.uid           || { rid: () => cryptoId() };
  const clock         = deps.clock         || { now: () => new Date() };

  return async function onPricingCompareCompleted(payload = {}) {
    const now = clock.now();

    const {
      requestId = uid.rid(),
      sessionId = uid.rid(),
      userId,
      householdId,
      product,
      pricing,
      coupons = { coupons: [], rulesVersion: '0' },
      stores = [],
      meta = {},
      flags = {}
    } = payload;

    if (!product || !pricing || !Array.isArray(pricing.quotes)) {
      const error = { code: 'NO_PRICING', message: 'Missing product or pricing quotes' };
      eventBus.emit('pricing:compare:skipped', { requestId, sessionId, error });
      return { ok: false, requestId, sessionId, error };
    }

    // Preferences (for loyalty / store order / thresholds)
    const prefs = await loadUserPrefsSafe(config, userId, householdId);

    // 1) Normalize & enrich quotes with effective price after coupons/loyalty
    const enriched = enrichQuotesWithCoupons(pricing.quotes, coupons.coupons, prefs);

    // 2) Rank candidates (best → worst) with transparent rationale
    const ranked = rankCandidates(enriched, prefs);

    // 3) Persist to Pricebook (per store) and Candidates (top N)
    await persistPricebook(dexie, product, enriched, now);
    const topN = ranked.slice(0, Math.max(1, Math.min(6, config.get?.('scanCompareTrust.candidates.max', 5) ?? 5)));
    await persistCandidates(dexie, requestId, sessionId, product, topN, now);

    // 4) Learn discount cadence
    try { await learnCycles(cycleAnalyzer, product, enriched, coupons.coupons); } catch (e) { console.warn('cycleAnalyzer.learn failed', e); }

    // 5) Predict next sale window (for NBA “wait for sale”)
    const bestStoreId = topN[0]?.storeId;
    const pred = bestStoreId ? safePredict(cycleAnalyzer, product, bestStoreId) : null;

    // 6) Build NBA suggestions
    const nudge = buildPricingNudge({ requestId, sessionId, product, topN, pred });

    try { await nba.queue(nudge); } catch {}

    // 7) Deliver toast/inbox (respect Quiet Hours / Sabbath)
    const guarded = sabbathGuardActive(config, now) || quietHoursActive(config, now) || nba.preferInbox();
    const enableToasts = flags.enableToasts ?? true;
    if (enableToasts) {
      if (guarded) {
        await toInbox(dexie, eventBus, makeInboxItem(nudge, now));
      } else {
        // Best-price toast + optional “wait for sale” hint
        eventBus.emit('ui:toast:show', makeBestPriceToast(nudge, pred));
      }
    }

    // 8) Save favorite session (pricing-only) when asked
    if (meta.favoriteSessionName) {
      try {
        await favorites.saveSession({
          name: meta.favoriteSessionName,
          kind: 'scanPricingOnly',
          template: { stores: stores.length ? stores : prefs.stores, flags: { pricingOnly: true }, scheduleId: meta.scheduleId || null },
          savedAt: now.toISOString(),
          userId, householdId,
        });
        eventBus.emit('favorites:session:saved', { requestId, sessionId, name: meta.favoriteSessionName, type: 'scanPricingOnly' });
      } catch (e) { console.warn('favorites.saveSession failed', e); }
    }

    // 9) Update scan row (optional) & emit final events
    if (dexie?.scans?.update && payload.requestId) {
      try {
        await dexie.scans.update(payload.requestId, {
          pricingCandidates: topN,
          pricebookUpdatedAt: now.toISOString(),
        });
      } catch {}
    }

    const result = {
      ok: true,
      requestId, sessionId,
      product: pickSafeProductShape(product),
      candidates: topN,
      storesUsed: stores.length ? stores : prefs.stores,
      prediction: pred ? { nextExpectedISO: pred.nextExpectedISO, confidence: pred.confidence } : null
    };

    eventBus.emit('compare:candidates:updated', { requestId, sessionId, productId: product?.id || product?.gtin || product?.sku, candidates: topN });
    eventBus.emit('pricebook:upserted', { requestId, sessionId, productId: product?.id || product?.gtin || product?.sku, count: enriched.length });
    eventBus.emit('pricing:compare:completed', result);
    analytics.track('pricing_compare_completed', {
      requestId, sessionId,
      bestUnitPrice: topN[0]?.effectiveUnitPrice ?? null,
      storeId: topN[0]?.storeId ?? null,
      candidates: topN.length
    });

    return result;
  };

  // ---------------- helpers ----------------

  function cryptoId() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch {}
    return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  async function loadUserPrefsSafe(config, userId, householdId) {
    try {
      const loader = config.get?.('userPrefs.loader');
      if (loader) {
        const p = await loader(userId, householdId);
        if (p) return p;
      }
    } catch {}
    return {
      stores: config.get?.('scanCompareTrust.defaultStores', []) ?? [],
      loyalty: {},             // { [storeId]: { cardId, status } }
      couponOptIns: {},        // per provider
      priceSensitivity: 'normal', // 'thrifty'|'normal'|'time_saver'
      deliveryBias: 'neutral', // 'prefer_pickup'|'prefer_delivery'|'neutral'
    };
  }

  function enrichQuotesWithCoupons(quotes, coupons, prefs) {
    const byStoreCoupons = (coupons || []).reduce((acc, c) => {
      const arr = acc[c.storeId] || (acc[c.storeId] = []);
      arr.push(c);
      return acc;
    }, {});

    return quotes.map(q => {
      const cList = byStoreCoupons[q.storeId] || [];
      const { effectiveUnitPrice, appliedCoupons } = applyCoupons(q.unitPrice, cList);
      const loyaltyReq = cList.some(c => c.requiresLoyalty);
      const loyaltyOk = !loyaltyReq || !!prefs.loyalty?.[q.storeId];

      return {
        ...q,
        currency: q.currency || 'USD',
        appliedCoupons,
        effectiveUnitPrice: loyaltyOk ? effectiveUnitPrice : q.unitPrice, // if loyalty missing, keep base price
        loyaltyRequired: loyaltyReq,
        loyaltySatisfied: loyaltyOk,
      };
    });
  }

  function applyCoupons(basePrice, coupons) {
    let price = Number(basePrice ?? Infinity);
    const applied = [];
    // Simple stacking: apply best percent first, then best amount
    const percents = coupons.filter(c => c.type === 'percent');
    const amounts  = coupons.filter(c => c.type === 'amount');
    if (percents.length) {
      const bestPct = Math.max(...percents.map(c => Number(c.value || 0)));
      if (Number.isFinite(bestPct) && bestPct > 0) {
        price = price * (1 - bestPct / 100);
        applied.push({ type: 'percent', value: bestPct });
      }
    }
    if (amounts.length) {
      const bestAmt = Math.max(...amounts.map(c => Number(c.value || 0)));
      if (Number.isFinite(bestAmt) && bestAmt > 0) {
        price = Math.max(0, price - bestAmt);
        applied.push({ type: 'amount', value: bestAmt });
      }
    }
    return { effectiveUnitPrice: round2(price), appliedCoupons: applied };
  }

  function rankCandidates(quotes, prefs) {
    const bias = prefs.deliveryBias || 'neutral';
    const sensitivity = prefs.priceSensitivity || 'normal';

    // Build composite score (lower is better)
    return quotes
      .map(q => {
        const base = q.effectiveUnitPrice ?? q.unitPrice ?? Infinity;
        // Delivery/pickup bias
        let biasPenalty = 0;
        if (bias === 'prefer_pickup' && !q.pickupEligible) biasPenalty += 0.15;
        if (bias === 'prefer_delivery' && !q.deliveryEligible) biasPenalty += 0.15;

        // Promo boost (prefer items on promo slightly)
        const promoBoost = q.promo ? -0.05 : 0;

        // Loyalty not satisfied → penalize slightly (user may still link)
        const loyaltyPenalty = q.loyaltyRequired && !q.loyaltySatisfied ? 0.05 : 0;

        // Sensitivity tweaks
        const sensPenalty = sensitivity === 'thrifty' ? -0.03 : (sensitivity === 'time_saver' ? 0.04 : 0);

        const score = base * (1 + biasPenalty + loyaltyPenalty + sensPenalty + promoBoost);
        return { ...q, score, rationale: { base, biasPenalty, promoBoost, loyaltyPenalty, sensPenalty } };
      })
      .sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity));
  }

  async function persistPricebook(dexie, product, quotes, now) {
    if (!dexie?.pricebook?.bulkPut) return;
    try {
      const sku = product?.sku || product?.gtin || product?.id || product?.upc;
      const rows = quotes.map(q => ({
        id: `${sku}:${q.storeId}`,
        sku,
        storeId: q.storeId,
        storeName: q.storeName,
        unitPrice: q.unitPrice,
        effectiveUnitPrice: q.effectiveUnitPrice,
        promo: !!q.promo,
        currency: q.currency || 'USD',
        aisle: q.aisle || null,
        url: q.url || null,
        pickupEligible: !!q.pickupEligible,
        deliveryEligible: !!q.deliveryEligible,
        appliedCoupons: q.appliedCoupons || [],
        updatedAt: now.toISOString(),
      }));
      await dexie.pricebook.bulkPut(rows);
    } catch (e) {
      console.warn('pricebook.bulkPut failed', e);
    }
  }

  async function persistCandidates(dexie, requestId, sessionId, product, candidates, now) {
    if (!dexie?.candidates?.add) return;
    try {
      await dexie.candidates.add({
        id: `${requestId}`,
        sessionId,
        product: pickSafeProductShape(product),
        candidates: candidates.map(c => pickCandidateShape(c)),
        createdAt: now.toISOString(),
      });
    } catch (e) {
      // try update if exists
      try {
        if (dexie?.candidates?.update) {
          await dexie.candidates.update(requestId, {
            candidates: candidates.map(c => pickCandidateShape(c)),
            updatedAt: now.toISOString(),
          });
        }
      } catch (e2) {
        console.warn('candidates persist failed', e2);
      }
    }
  }

  async function learnCycles(analyzer, product, quotes, coupons) {
    const sku = product?.sku || product?.gtin || product?.id;
    if (!sku) return;
    const nowISO = new Date().toISOString();
    const records = [];
    (quotes || []).forEach(q => {
      records.push({
        type: 'price',
        storeId: q.storeId,
        sku,
        unitPrice: q.unitPrice,
        promo: !!q.promo,
        effectiveUnitPrice: q.effectiveUnitPrice,
        capturedAtISO: nowISO,
      });
    });
    (coupons || []).forEach(c => {
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
    for (const r of records) { // sequential; analyzer may handle batching
      // eslint-disable-next-line no-await-in-loop
      await analyzer.learn(r, {});
    }
  }

  function safePredict(analyzer, product, storeId) {
    try {
      return analyzer.predict?.(product?.sku || product?.gtin, storeId, {}) || null;
    } catch { return null; }
  }

  function buildPricingNudge({ requestId, sessionId, product, topN, pred }) {
    const best = topN[0];
    const actions = [
      { id: 'cart:add', label: `Add from ${best?.storeName || best?.storeId || 'store'}` },
      { id: 'coupons:clip', label: 'Clip available coupons' }
    ];
    if (pred?.nextExpectedISO) {
      actions.push({ id: 'deal:watch', label: 'Watch for sale' });
    }
    return {
      id: `nudge_price_${requestId}`,
      channel: 'scan-compare-trust',
      productId: product?.id || product?.gtin || product?.sku,
      severity: 'info',
      intents: actions,
      meta: {
        requestId, sessionId,
        best: pickCandidateShape(best),
        count: topN.length,
        prediction: pred ? { nextExpectedISO: pred.nextExpectedISO, confidence: pred.confidence } : null
      }
    };
  }

  function makeBestPriceToast(nudge, pred) {
    const storeName = nudge.meta.best.storeName || nudge.meta.best.storeId || 'Best store';
    const price = nudge.meta.best.effectiveUnitPrice ?? nudge.meta.best.unitPrice;
    const msg = pred?.nextExpectedISO
      ? `Best price ${fmtCurrency(price)} at ${storeName}. Sale may return around ${new Date(pred.nextExpectedISO).toLocaleDateString()}.`
      : `Best price ${fmtCurrency(price)} at ${storeName}.`;
    return {
      id: `toast_${nudge.id}`,
      kind: 'toast',
      tone: 'success',
      title: 'Best Price Found',
      message: msg,
      actions: [
        { id: 'cart:add', label: 'Add to cart', primary: true },
        { id: 'coupons:clip', label: 'Clip coupons' },
        ...(pred?.nextExpectedISO ? [{ id: 'deal:watch', label: 'Watch sale' }] : [])
      ],
      meta: nudge.meta
    };
  }

  function makeInboxItem(nudge, now) {
    const best = nudge.meta.best;
    return {
      id: `inbox_${nudge.id}`,
      type: 'pricing',
      title: 'Best Price Available',
      body: `Best price ${fmtCurrency(best.effectiveUnitPrice ?? best.unitPrice)} at ${best.storeName || best.storeId}.`,
      createdAt: now.toISOString(),
      cta: [
        { id: 'cart:add', label: 'Add to cart' },
        { id: 'coupons:clip', label: 'Clip coupons' },
        ...(nudge.meta.prediction ? [{ id: 'deal:watch', label: 'Watch sale' }] : [])
      ],
      meta: nudge.meta
    };
  }

  async function toInbox(dexie, eventBus, item) {
    if (dexie?.inbox?.add) {
      try { await dexie.inbox.add(item); } catch {}
    }
    eventBus.emit('inbox:notification:added', item);
  }

  function sabbathGuardActive(cfg, now) {
    const sg = cfg.sabbathGuard || cfg.get?.('sabbathGuard', {});
    if (!sg?.enabled) return false;
    const day = now.getDay(); // 5=Fri, 6=Sat
    const hr  = now.getHours();
    return (day === 5 && hr >= 18) || (day === 6 && hr <= 20);
  }

  function quietHoursActive(cfg, now) {
    const qh = cfg.quietHours || cfg.get?.('quietHours', {});
    if (!qh?.start || !qh?.end) return false;
    return isWithinRange(now, qh.start, qh.end);
  }

  function isWithinRange(now, startHHMM, endHHMM) {
    const [sh, sm] = (startHHMM || '23:59').split(':').map(Number);
    const [eh, em] = (endHHMM   || '00:00').split(':').map(Number);
    const s = new Date(now); s.setHours(sh ?? 0, sm ?? 0, 0, 0);
    const e = new Date(now); e.setHours(eh ?? 0, em ?? 0, 0, 0);
    return s <= e ? now >= s && now <= e : (now >= s || now <= e);
  }

  function pickSafeProductShape(p) {
    if (!p) return null;
    const { id, sku, gtin, upc, brand, name, size, unit, images, category, subcategory, tags, meta } = p;
    return {
      id, sku, gtin, upc, brand, name, size, unit, images, category, subcategory, tags,
      meta: meta ? {
        ...meta,
        providers: Array.isArray(meta.providers) ? meta.providers.map(x => ({ id: x.id, name: x.name })) : undefined
      } : undefined
    };
  }

  function pickCandidateShape(c) {
    if (!c) return null;
    const { storeId, storeName, unitPrice, effectiveUnitPrice, promo, url, pickupEligible, deliveryEligible, currency, rationale } = c;
    return { storeId, storeName, unitPrice, effectiveUnitPrice, promo, url, pickupEligible, deliveryEligible, currency, rationale };
  }

  function fmtCurrency(n) {
    if (n == null || !Number.isFinite(Number(n))) return '';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(n)); }
    catch { return `$${Number(n).toFixed(2)}`; }
  }

  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
}
