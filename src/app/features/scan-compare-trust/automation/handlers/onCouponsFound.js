/* eslint-disable no-console */
// src/features/scan-compare-trust/automation/handlers/onCouponsFound.js
// Purpose: Attach coupons to UI, compute insights, nudge with NBA, persist ledger,
// respect Quiet Hours/Sabbath, support favorite sessions & schedules.
//
// Upstream event (from fan-out or couponsService):
// 'coupons:found' payload = {
//   requestId, sessionId, userId?, householdId?,
//   product, // safe product shape (id/sku/gtin/name/brand...)
//   coupons: [{ id, storeId, storeName?, type:'amount'|'percent'|'bogo'|'bxgy', value, minSpend?, stackable?, requiresLoyalty?, clipUrl?, expiresISO?, brand?, code? }, ...],
//   rulesVersion?: string,
//   stores?: string[],
//   context?: { location?, device? },
//   meta?: { favoriteSessionName?, scheduleId?, templateId? },
//   flags?: { enableToasts?: boolean, allowPartial?: boolean }
// }

export default function createOnCouponsFound(deps = {}) {
  // ---- DI defaults (all optional, safe no-ops) -------------------------------
  const eventBus      = deps.eventBus      || { emit: () => {} };
  const config        = deps.config        || { get: () => undefined, sabbathGuard: {}, quietHours: {} };
  const analytics     = deps.analytics     || { track: () => {} };
  const dexie         = deps.dexie         || {}; // { couponsLedger?:Table, inbox?:Table, scans?:Table }
  const nba           = deps.nba           || { queue: async () => {}, preferInbox: () => false };
  const cycleAnalyzer = deps.cycleAnalyzer || { learn: async () => {}, predict: () => null };
  const favorites     = deps.favorites     || { saveSession: async () => {}, getSessionById: async () => null };
  const uid           = deps.uid           || { rid: () => cryptoId() };
  const clock         = deps.clock         || { now: () => new Date() };
  const cache         = deps.cache         || createTTLCache({ ttlMs: 2 * 60 * 1000 }); // de-dupe window

  return async function onCouponsFound(payload = {}) {
    const now = clock.now();

    const {
      requestId = uid.rid(),
      sessionId = uid.rid(),
      userId, householdId,
      product,
      coupons: couponList = [],
      rulesVersion = '0',
      stores = [],
      context = {},
      meta = {},
      flags = {}
    } = payload;

    // Normalize list
    const coupons = Array.isArray(couponList) ? couponList : [];
    if (!product) {
      const error = { code: 'NO_PRODUCT', message: 'onCouponsFound called without product' };
      eventBus.emit('coupons:attach:skipped', { requestId, sessionId, error });
      return { ok: false, requestId, sessionId, error };
    }

    // De-dupe signature per product + coupon IDs snapshot
    const sig = signature(product, coupons);
    if (cache.get(sig)) {
      eventBus.emit('coupons:attach:deduped', { requestId, sessionId, signature: sig });
      return { ok: true, requestId, sessionId, deduped: true, count: coupons.length };
    }
    cache.set(sig, true);

    const prefs = await loadUserPrefsSafe(config, userId, householdId);

    // 1) Compute insights (expiring soon, highest value, stackability, loyalty, thresholds)
    const insights = buildInsights(product, coupons, prefs, now);

    // 2) Persist to Coupons Ledger (Dexie)
    await persistCouponsLedger(dexie, product, coupons, rulesVersion, now);

    // 3) Learn coupon cadence for predictions
    try { await learnCycles(cycleAnalyzer, product, coupons); } catch (e) { console.warn('cycleAnalyzer.learn(coupons) failed', e); }

    // 4) Build NBA nudge (clip/stack/watch)
    const prediction = safePredict(cycleAnalyzer, product, insights.best?.storeId);
    const nudge = buildCouponsNudge({ requestId, sessionId, product, insights, prediction });

    try { await nba.queue(nudge); } catch {}

    // 5) Attach to UI (ScanSheet & SourceAttribution listeners)
    eventBus.emit('coupons:insights:updated', {
      requestId, sessionId,
      productId: idOf(product),
      insights,
      rulesVersion,
      count: coupons.length,
    });
    eventBus.emit('ui:coupons:attach', {
      requestId, sessionId,
      product: pickSafeProductShape(product),
      coupons: coupons.map(pickCouponShape),
      insights,
      rulesVersion
    });

    // 6) Toast or Inbox (Quiet Hours / Sabbath / Do Not Disturb)
    const enableToasts = flags.enableToasts ?? true;
    const guarded = sabbathGuardActive(config, now) || quietHoursActive(config, now) || nba.preferInbox();
    if (enableToasts) {
      if (guarded) {
        await toInbox(dexie, eventBus, makeInboxItem(nudge, now));
      } else {
        // Prefer a single concise toast with “Clip all” + “Stack w/ sale”
        eventBus.emit('ui:toast:show', makeCouponsToast(nudge));
      }
    }

    // 7) Save favorite coupon session (user-owned)
    if (meta.favoriteSessionName) {
      try {
        await favorites.saveSession({
          name: meta.favoriteSessionName,
          kind: 'scanCouponsOnly',
          template: { stores: stores.length ? stores : prefs.stores, flags: { couponsOnly: true }, scheduleId: meta.scheduleId || null },
          savedAt: now.toISOString(),
          userId, householdId,
        });
        eventBus.emit('favorites:session:saved', { requestId, sessionId, name: meta.favoriteSessionName, type: 'scanCouponsOnly' });
      } catch (e) { console.warn('favorites.saveSession failed', e); }
    }

    // 8) Update scan record (optional)
    if (dexie?.scans?.update && payload.requestId) {
      try {
        await dexie.scans.update(payload.requestId, {
          couponsAttachedAt: now.toISOString(),
          couponInsights: insights,
        });
      } catch {}
    }

    const result = {
      ok: true,
      requestId, sessionId,
      product: pickSafeProductShape(product),
      coupons: coupons.map(pickCouponShape),
      insights,
      prediction: prediction ? { nextExpectedISO: prediction.nextExpectedISO, confidence: prediction.confidence } : null
    };

    eventBus.emit('coupons:attach:completed', result);
    analytics.track('coupons_attach_completed', {
      requestId, sessionId,
      productId: idOf(product),
      count: coupons.length,
      bestStore: insights.best?.storeId || null,
      expiringSoon: insights.expiringSoon.length
    });

    return result;
  };

  // ---------------- helpers ----------------

  function cryptoId() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch {}
    return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function createTTLCache({ ttlMs } = { ttlMs: 120000 }) {
    const map = new Map();
    return {
      get(k) {
        const r = map.get(k); if (!r) return null;
        if (Date.now() > r.exp) { map.delete(k); return null; }
        return r.val;
      },
      set(k, v) { map.set(k, { val: v, exp: Date.now() + ttlMs }); }
    };
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
      couponOptIns: {},        // keyed by provider
      priceSensitivity: 'normal',
      deliveryBias: 'neutral',
      alertThreshold: 'medium'
    };
  }

  function idOf(p) { return p?.id || p?.gtin || p?.sku || p?.upc || 'unknown'; }

  function signature(product, coupons) {
    const ids = (coupons || []).map(c => c.id || `${c.storeId}:${c.type}:${c.value}:${c.expiresISO || ''}`).sort().join(',');
    return `couponattach:${idOf(product)}:${ids}`;
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

  function pickCouponShape(c) {
    if (!c) return null;
    const { id, storeId, storeName, type, value, minSpend, stackable, requiresLoyalty, clipUrl, expiresISO, brand, code } = c;
    return { id, storeId, storeName, type, value, minSpend, stackable, requiresLoyalty, clipUrl, expiresISO, brand, code };
  }

  function buildInsights(product, coupons, prefs, now) {
    const expiringSoon = [];
    const needsLoyalty = [];
    const highValue = [];
    const bogo = [];
    const stackable = [];
    let best = null;

    const soonDays = Number(config.get?.('scanCompareTrust.coupons.expiringSoonDays', 5) ?? 5);

    for (const c of coupons) {
      // Expiring soon
      if (c.expiresISO) {
        const days = daysUntil(now, c.expiresISO);
        if (Number.isFinite(days) && days <= soonDays) expiringSoon.push({ ...c, daysLeft: Math.max(0, Math.ceil(days)) });
      }
      if (c.requiresLoyalty) needsLoyalty.push(c);
      if (c.type === 'percent' && Number(c.value) >= 20) highValue.push(c);
      if (c.type === 'amount' && Number(c.value) >= 2) highValue.push(c);
      if (c.type === 'bogo' || c.type === 'bxgy') bogo.push(c);
      if (c.stackable) stackable.push(c);

      // Track "best" by raw value heuristic
      const eff = approximateValue(c);
      if (!best || eff > best.effectiveValue) best = { ...c, effectiveValue: eff };
    }

    const suggestions = [];
    if (expiringSoon.length) suggestions.push({ kind: 'expiringSoon', title: 'Coupons expiring soon', count: expiringSoon.length });
    if (highValue.length)   suggestions.push({ kind: 'highValue',    title: 'High value coupon available', count: highValue.length });
    if (bogo.length)        suggestions.push({ kind: 'bogo',         title: 'BOGO/Buy-X-Get-Y offer', count: bogo.length });
    if (stackable.length)   suggestions.push({ kind: 'stack',        title: 'Stackable with sale/codes', count: stackable.length });
    if (needsLoyalty.length) suggestions.push({ kind: 'loyalty',     title: 'Requires loyalty account', count: needsLoyalty.length });

    return {
      best, expiringSoon, needsLoyalty, highValue, bogo, stackable,
      suggestions,
      storeGroups: groupByStore(coupons),
    };
  }

  function groupByStore(coupons) {
    return (coupons || []).reduce((acc, c) => {
      (acc[c.storeId] || (acc[c.storeId] = [])).push(pickCouponShape(c));
      return acc;
    }, {});
  }

  function approximateValue(c) {
    // Quick heuristic to compare coupons without item price context.
    if (c.type === 'percent') return Number(c.value) / 100;
    if (c.type === 'amount')  return Number(c.value);
    if (c.type === 'bogo' || c.type === 'bxgy') return 0.5; // assume 50% effective when used
    return 0;
  }

  function daysUntil(now, iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return Infinity;
    return (t - now.getTime()) / (1000 * 60 * 60 * 24);
  }

  async function persistCouponsLedger(dexie, product, coupons, rulesVersion, now) {
    if (!dexie?.couponsLedger?.bulkPut) return;
    try {
      const sku = idOf(product);
      const rows = (coupons || []).map(c => ({
        id: `${sku}:${c.storeId}:${c.id || `${c.type}:${c.value}:${c.expiresISO || ''}`}`,
        sku,
        storeId: c.storeId,
        storeName: c.storeName || null,
        type: c.type,
        value: c.value,
        minSpend: c.minSpend || null,
        stackable: !!c.stackable,
        requiresLoyalty: !!c.requiresLoyalty,
        clipUrl: c.clipUrl || null,
        expiresISO: c.expiresISO || null,
        brand: c.brand || null,
        code: c.code || null,
        rulesVersion,
        capturedAt: now.toISOString(),
      }));
      await dexie.couponsLedger.bulkPut(rows);
    } catch (e) {
      console.warn('couponsLedger.bulkPut failed', e);
    }
  }

  async function learnCycles(analyzer, product, coupons) {
    const sku = idOf(product);
    const nowISO = new Date().toISOString();
    for (const c of (coupons || [])) {
      // eslint-disable-next-line no-await-in-loop
      await analyzer.learn({
        type: 'coupon',
        storeId: c.storeId,
        sku,
        value: c.value,
        category: c.type,
        expiresISO: c.expiresISO,
        capturedAtISO: nowISO,
      }, {});
    }
  }

  function safePredict(analyzer, product, storeId) {
    const key = idOf(product);
    if (!storeId || !analyzer?.predict) return null;
    try { return analyzer.predict(key, storeId, {}); } catch { return null; }
  }

  function buildCouponsNudge({ requestId, sessionId, product, insights, prediction }) {
    const intents = [];
    if (insights.best) intents.push({ id: 'coupons:clip', label: 'Clip best coupon', primary: true });
    if (insights.stackable.length) intents.push({ id: 'deal:stack', label: 'Stack with sale' });
    if (prediction?.nextExpectedISO) intents.push({ id: 'deal:watch', label: 'Watch for better coupon' });
    if (insights.needsLoyalty.length) intents.push({ id: 'loyalty:link', label: 'Link loyalty account' });

    return {
      id: `nudge_coupons_${requestId}`,
      channel: 'scan-compare-trust',
      productId: idOf(product),
      severity: 'info',
      intents,
      meta: {
        requestId, sessionId,
        best: insights.best ? pickCouponShape(insights.best) : null,
        counts: {
          total: insights.storeGroups ? Object.values(insights.storeGroups).flat().length : 0,
          expiringSoon: insights.expiringSoon.length,
          stackable: insights.stackable.length
        },
        prediction: prediction ? { nextExpectedISO: prediction.nextExpectedISO, confidence: prediction.confidence } : null
      }
    };
  }

  function makeCouponsToast(nudge) {
    const best = nudge.meta.best;
    const title = best?.storeName ? `Coupons at ${best.storeName}` : 'Coupons available';
    const msgParts = [];
    if (best) {
      msgParts.push(best.type === 'percent' ? `${best.value}% off` :
                    best.type === 'amount'  ? `$${Number(best.value).toFixed(2)} off` :
                    'Special offer');
      if (best.expiresISO) {
        msgParts.push(`expires ${new Date(best.expiresISO).toLocaleDateString()}`);
      }
    }
    if (nudge.meta.prediction?.nextExpectedISO) {
      msgParts.push(`better offer may return ~${new Date(nudge.meta.prediction.nextExpectedISO).toLocaleDateString()}`);
    }

    return {
      id: `toast_${nudge.id}`,
      kind: 'toast',
      tone: 'info',
      title,
      message: msgParts.join(' • ') || 'You have clip-ready coupons.',
      actions: [
        ...(best ? [{ id: 'coupons:clip', label: 'Clip best', primary: true }] : []),
        { id: 'deal:stack', label: 'Stack with sale' },
        ...(nudge.meta.prediction ? [{ id: 'deal:watch', label: 'Watch deal' }] : []),
        { id: 'loyalty:link', label: 'Link loyalty' }
      ],
      meta: nudge.meta
    };
  }

  function makeInboxItem(nudge, now) {
    const best = nudge.meta.best;
    return {
      id: `inbox_${nudge.id}`,
      type: 'coupons',
      title: best?.storeName ? `Coupons at ${best.storeName}` : 'Coupons available',
      body: best
        ? (best.type === 'percent'
            ? `${best.value}% off${best.expiresISO ? ` • expires ${new Date(best.expiresISO).toLocaleDateString()}` : ''}`
            : best.type === 'amount'
              ? `$${Number(best.value).toFixed(2)} off${best.expiresISO ? ` • expires ${new Date(best.expiresISO).toLocaleDateString()}` : ''}`
              : `Offer available${best.expiresISO ? ` • expires ${new Date(best.expiresISO).toLocaleDateString()}` : ''}`)
        : 'Clip-ready coupons found.',
      createdAt: now.toISOString(),
      cta: [
        ...(best ? [{ id: 'coupons:clip', label: 'Clip best' }] : []),
        { id: 'deal:stack', label: 'Stack with sale' },
        ...(nudge.meta.prediction ? [{ id: 'deal:watch', label: 'Watch deal' }] : []),
        { id: 'loyalty:link', label: 'Link loyalty' },
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
}
