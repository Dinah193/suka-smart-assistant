/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/CycleAnalyzer.js
// Learns discount cadence per store/brand/sku and predicts next windows.
// Style: ES2015-safe, defensive DI, event-driven, persistence-optional (Dexie).

/**
 * createCycleAnalyzer(deps)
 * -----------------------------------------------------------------------------
 * Deps are optional; safe no-ops by default:
 *  - clock:       { now(): Date }
 *  - eventBus:    { emit(evt, payload):void }
 *  - analytics:   { track(evt, payload):void }
 *  - db:          Dexie-like with table('coupon_cycles') & table('coupon_events')
 *  - prefs:       { get(path, fb), sabbathGuard?, quietHours? }
 *  - favorites:   { getWatchlist(): Promise<WatchKey[]>, upsertWatch(key,obj) }
 *  - sourceAttribution: { attach(meta):string[] }  // returns provider IDs
 *
 * Inputs (observations):
 *  {
 *    ts: ISO|string|number,
 *    storeId, storeName?,
 *    brandId, brandName?,
 *    sku?, upc?,
 *    listPrice?, price?, discountPct?, // if missing, compute when possible
 *    couponId?, couponType?, stackable?, loyaltyRequired?,
 *    provider?: "storeAPI|scrape|receipt|user",
 *    meta?: {}
 *  }
 *
 * Public API:
 *  - recordObservation(obs)
 *  - learnFromEvents(key?)                  -> Promise<ModelRow|void>
 *  - predictNextWindows(key, now?)         -> DealWindow[]
 *  - batchPredict(keys, now?)              -> Map<keyStr, DealWindow[]>
 *  - shouldDelayPurchase(priceInfo, key?)  -> {recommendation, rationale, horizon}
 *  - getBestByStoreBrand(storeId, brandId) -> {windows, stats}
 *  - getDealCalendar(key, horizonDays)     -> {key, windows, updatedAt}
 *  - upsertWatch(key, opts)                -> persists user watch (favorites)
 *
 * Emits:
 *  - 'coupon:cycle:updated'   { key, stats, windows }
 *  - 'coupon:deal:predicted'  { key, window, confidence }
 *  - 'coupon:watch:window'    { key, window, isUserFavorite }
 */

export function createCycleAnalyzer(deps = {}) {
  const clock = deps.clock || { now: () => new Date() };
  const eventBus = deps.eventBus || { emit: () => {} };
  const analytics = deps.analytics || { track: () => {} };
  const db = deps.db || null; // optional Dexie
  const prefs = deps.prefs || {
    get: () => undefined,
    sabbathGuard: { enabled: false, start: "Friday 17:00", end: "Saturday 21:00" },
    quietHours: { start: 21, end: 7 },
  };
  const favorites = deps.favorites || {
    getWatchlist: async () => [],
    upsertWatch: async () => {},
  };
  const sourceAttribution = deps.sourceAttribution || { attach: () => [] };

  // In-memory caches (mirror persisted rows)
  // keyStr => { events: [ts...], cadenceDays[], stats, windows }
  const cycles = new Map();

  // ---------- Utilities ------------------------------------------------------

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const asDate = (ts) => (ts instanceof Date ? ts : new Date(ts));
  const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
  const dayDiff = (a, b) => Math.abs((asDate(a) - asDate(b)) / (1000 * 60 * 60 * 24));

  const hashKey = (key) => {
    const { storeId = "na", brandId = "na", sku = "na" } = key || {};
    return `${storeId}::${brandId}::${sku}`;
  };

  function normalizeObservation(obs) {
    const o = { ...obs };
    if (!o.ts) o.ts = iso(clock.now());
    if (o.listPrice != null && o.price != null && o.discountPct == null) {
      const dp = ((o.listPrice - o.price) / o.listPrice) * 100;
      o.discountPct = Math.round(dp * 10) / 10;
    }
    return o;
  }

  function withinQuietHours(now = clock.now()) {
    const qh = (prefs.quietHours && (prefs.quietHours.value || prefs.quietHours)) || { start: 21, end: 7 };
    const hour = asDate(now).getHours();
    if (qh.start < qh.end) {
      return hour >= qh.start && hour < qh.end; // e.g., 21 -> 7 same-day (rare)
    }
    // Overnight window (typical 21-7)
    return hour >= qh.start || hour < qh.end;
  }

  function sabbathActive(now = clock.now()) {
    const guard = prefs.sabbathGuard?.enabled ? prefs.sabbathGuard : { enabled: false };
    if (!guard.enabled) return false;
    // simple heuristic: Friday evening to Saturday evening block
    const day = asDate(now).getDay(); // 0=Sun..6=Sat
    return day === 5 || day === 6; // Fri/Sat (approximation; schedule UI can refine)
  }

  function scheduleAllowed(now = clock.now()) {
    return !withinQuietHours(now) && !sabbathActive(now);
  }

  // Robust median & MAD
  function median(arr) {
    if (!arr?.length) return undefined;
    const a = [...arr].sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
    }
  function mean(arr) {
    if (!arr?.length) return undefined;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }
  function stdev(arr) {
    if (!arr?.length) return undefined;
    const m = mean(arr);
    const v = mean(arr.map((x) => (x - m) ** 2));
    return Math.sqrt(v);
  }

  function toDealWindow(fromDate, cycleDays, jitterDays) {
    // Center on expected start; widen with jitter & min window
    const minWidth = clamp(Math.round(Math.max(2, cycleDays * 0.15)), 2, 10);
    const half = Math.round(Math.max(minWidth, jitterDays || 0));
    const start = new Date(asDate(fromDate));
    const end = new Date(asDate(fromDate));
    start.setDate(start.getDate() - half);
    end.setDate(end.getDate() + half);
    return { startISO: iso(start), endISO: iso(end) };
  }

  function computeCadenceStats(eventsISO) {
    if (!eventsISO || eventsISO.length < 3) return null;
    const sorted = [...eventsISO].sort();
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(dayDiff(sorted[i], sorted[i - 1]));
    }
    if (!gaps.length) return null;
    const m = median(gaps);
    const mu = mean(gaps);
    const sd = stdev(gaps);
    // Confidence grows with sample size and decreases with variance.
    const support = gaps.length;
    const variancePenalty = clamp(sd / (m || 1), 0, 3); // 0..3
    const raw = clamp((support / 6) * (1 - variancePenalty / 3), 0, 1);
    const confidence = Math.round(raw * 100) / 100;

    return {
      gapsDays: gaps,
      medianDays: Math.round(m * 10) / 10,
      meanDays: Math.round(mu * 10) / 10,
      stdevDays: Math.round(sd * 10) / 10,
      support,
      confidence,
      updatedAt: iso(clock.now()),
    };
  }

  async function persistCycleRow(key, row) {
    if (!db?.table) return;
    try {
      const table = db.table('coupon_cycles');
      await table.put({
        key: hashKey(key),
        storeId: key.storeId,
        brandId: key.brandId,
        sku: key.sku || null,
        stats: row.stats,
        windows: row.windows,
        eventsCount: row.events.length,
        eventsTailISO: row.events.slice(-10), // keep last few for quick UI
        updatedAt: iso(clock.now()),
      });
    } catch (e) {
      console.warn('[CycleAnalyzer] persistCycleRow failed', e);
    }
  }

  async function persistEvent(obs, keyStr) {
    if (!db?.table) return;
    try {
      const table = db.table('coupon_events');
      await table.add({
        key: keyStr,
        ts: iso(obs.ts),
        storeId: obs.storeId,
        brandId: obs.brandId,
        sku: obs.sku || null,
        discountPct: obs.discountPct ?? null,
        couponId: obs.couponId ?? null,
        stackable: !!obs.stackable,
        loyaltyRequired: !!obs.loyaltyRequired,
        provider: obs.provider || 'unknown',
        meta: obs.meta || {},
        createdAt: iso(clock.now()),
      });
    } catch (e) {
      console.warn('[CycleAnalyzer] persistEvent failed', e);
    }
  }

  function shouldCountAsDeal(obs) {
    // Tunable thresholds; could be made brand/store configurable via prefs
    const pct = Number(obs.discountPct || 0);
    if (pct >= 10) return true; // ≥10% off is a "deal event" starter
    if (obs.couponId) return true;
    // Loyalty price with smaller pct still counts as a signal
    if (obs.loyaltyRequired && pct >= 5) return true;
    return false;
  }

  function ensureRow(key) {
    const keyStr = hashKey(key);
    if (!cycles.has(keyStr)) {
      cycles.set(keyStr, { key, events: [], stats: null, windows: [], lastLearnAt: null });
    }
    return cycles.get(keyStr);
  }

  // ---------- Core: Recording & Learning ------------------------------------

  async function recordObservation(observation) {
    const obs = normalizeObservation(observation);
    const key = { storeId: obs.storeId, brandId: obs.brandId, sku: obs.sku };
    const row = ensureRow(key);
    const keyStr = hashKey(key);

    // Always attribute sources for UI "SourceAttribution"
    const sources = sourceAttribution.attach(obs.meta || {});

    if (shouldCountAsDeal(obs)) {
      row.events.push(iso(obs.ts));
      await persistEvent(obs, keyStr);
      // Re-learn (debounced approach could be added; here small & fast)
      await learnFromEvents(key);
      eventBus.emit('coupon:cycle:updated', { key, stats: row.stats, windows: row.windows, sources });
      analytics.track('coupon_cycle_event_recorded', { key: keyStr, discountPct: obs.discountPct ?? null });
    }
    return { key, counted: shouldCountAsDeal(obs) };
  }

  async function learnFromEvents(key) {
    const row = ensureRow(key);
    if (row.events.length < 3) {
      row.stats = null;
      row.windows = [];
      row.lastLearnAt = iso(clock.now());
      if (db?.table) await persistCycleRow(key, row);
      return row;
    }

    // Compute cadence from event gaps
    const stats = computeCadenceStats(row.events);
    row.stats = stats;

    // Predict next 1-3 windows using both median & mean as anchors
    row.windows = [];
    if (stats?.medianDays) {
      const last = row.events[row.events.length - 1];
      const nextCenter = new Date(asDate(last));
      nextCenter.setDate(nextCenter.getDate() + Math.round(stats.medianDays));
      const jitter = Math.max(2, Math.round((stats.stdevDays || 0) * 0.75));
      const w1 = toDealWindow(nextCenter, stats.medianDays, jitter);
      row.windows.push({ ...w1, anchor: 'median', confidence: stats.confidence });
    }
    if (stats?.meanDays && Math.abs(stats.meanDays - stats.medianDays) >= 2) {
      const last = row.events[row.events.length - 1];
      const nextCenter2 = new Date(asDate(last));
      nextCenter2.setDate(nextCenter2.getDate() + Math.round(stats.meanDays));
      const jitter2 = Math.max(2, Math.round((stats.stdevDays || 0)));
      const w2 = toDealWindow(nextCenter2, stats.meanDays, jitter2);
      row.windows.push({ ...w2, anchor: 'mean', confidence: clamp(stats.confidence * 0.95, 0, 1) });
    }

    row.lastLearnAt = iso(clock.now());
    if (db?.table) await persistCycleRow(key, row);
    return row;
  }

  // ---------- Prediction & Advice -------------------------------------------

  function predictNextWindows(key, now = clock.now()) {
    const row = ensureRow(key);
    if (!row.stats || !row.windows?.length) return [];
    // Filter out windows that are entirely in the past
    const n = asDate(now);
    return row.windows.filter((w) => asDate(w.endISO) >= n);
  }

  function batchPredict(keys, now = clock.now()) {
    const out = new Map();
    keys.forEach((k) => {
      out.set(hashKey(k), predictNextWindows(k, now));
    });
    return out;
  }

  function currentInWindow(w, now = clock.now()) {
    const d = asDate(now);
    return asDate(w.startISO) <= d && d <= asDate(w.endISO);
  }

  /**
   * Simple purchase timing heuristic:
   *  - If we're within (or close to) a predicted window and current price >= typical discount,
   *    suggest "buy soon".
   *  - If a strong window is 7–14 days away and current discount < typical,
   *    suggest "wait" up to the window start.
   */
  function shouldDelayPurchase(priceInfo, key) {
    const now = clock.now();
    const windows = predictNextWindows(key, now);
    if (!windows.length) {
      return {
        recommendation: 'buy_away', // no known cadence
        rationale: 'No discount cadence detected yet.',
        horizon: null,
      };
    }
    const typicalPct = (ensureRow(key).stats?.medianDays && priceInfo.typicalDiscountPct) || 12; // fallback 12%
    const curPct = Number(priceInfo.discountPct ?? 0);

    // Is there a window now?
    const active = windows.find((w) => currentInWindow(w, now));
    if (active) {
      if (curPct >= typicalPct * 0.8) {
        return {
          recommendation: 'buy_now',
          rationale: `Active window & discount ${curPct}% is near typical ${typicalPct}%`,
          horizon: { untilISO: active.endISO },
        };
      }
      return {
        recommendation: 'buy_soon',
        rationale: 'Active window; price may drop further but risk of missing end.',
        horizon: { untilISO: active.endISO },
      };
    }

    // Nearest upcoming window
    const nearest = [...windows].sort((a, b) => asDate(a.startISO) - asDate(b.startISO))[0];
    const daysUntil = Math.ceil(dayDiff(nearest.startISO, now));

    if (daysUntil <= 3 && curPct < typicalPct * 0.8) {
      return {
        recommendation: 'wait',
        rationale: `Window in ${daysUntil} days; current discount ${curPct}% < typical ${typicalPct}%`,
        horizon: { fromISO: iso(now), untilISO: nearest.startISO },
      };
    }

    if (daysUntil <= 14 && curPct < typicalPct * 0.5) {
      return {
        recommendation: 'wait_if_flexible',
        rationale: `Window in ${daysUntil} days and current discount is weak.`,
        horizon: { fromISO: iso(now), untilISO: nearest.startISO },
      };
    }

    return {
      recommendation: 'buy_away',
      rationale: 'No near-term strong window or current discount acceptable.',
      horizon: { nextWindowStartISO: nearest.startISO },
    };
  }

  function getBestByStoreBrand(storeId, brandId) {
    const rows = [];
    for (const [, row] of cycles) {
      if (row.key.storeId === storeId && row.key.brandId === brandId) {
        rows.push(row);
      }
    }
    rows.sort((a, b) => (b.stats?.confidence || 0) - (a.stats?.confidence || 0));
    const top = rows[0];
    return top
      ? { windows: top.windows, stats: top.stats, key: top.key }
      : { windows: [], stats: null, key: { storeId, brandId } };
  }

  function getDealCalendar(key, horizonDays = 90) {
    const now = clock.now();
    const windows = predictNextWindows(key, now)
      .filter((w) => dayDiff(w.startISO, now) <= horizonDays);
    return { key, windows, updatedAt: iso(now) };
  }

  // ---------- Favorites / Watchlists (user-owned sessions & schedules) ------

  async function upsertWatch(key, opts = {}) {
    // opts: { notes?, notify?:boolean, minPct?:number, channels?:['toast','sms','email'] }
    const watch = {
      key,
      notes: opts.notes || '',
      notify: opts.notify !== false,
      minPct: opts.minPct ?? 10,
      channels: opts.channels || ['toast'],
      updatedAt: iso(clock.now()),
    };
    await favorites.upsertWatch(key, watch);
    analytics.track('coupon_watch_upserted', { key: hashKey(key), channels: watch.channels });
    return watch;
  }

  async function notifyWatchesIfNeeded(now = clock.now()) {
    if (!scheduleAllowed(now)) return; // Respect quiet hours & Sabbath guard
    const watchlist = await favorites.getWatchlist();
    for (const key of watchlist || []) {
      const windows = predictNextWindows(key, now);
      if (!windows.length) continue;
      const soon = windows.find((w) => {
        const days = Math.ceil(dayDiff(w.startISO, now));
        return days <= 3; // 3-day pre-window heads-up
      });
      if (soon) {
        eventBus.emit('coupon:watch:window', {
          key,
          window: soon,
          isUserFavorite: true,
        });
        analytics.track('coupon_watch_window', { key: hashKey(key), startISO: soon.startISO });
      }
    }
  }

  // ---------- Orchestrator Glue (SourceAttribution, ProductResolver, Coupons) -

  function attachAttribution(meta) {
    try {
      return sourceAttribution.attach(meta || {});
    } catch {
      return [];
    }
  }

  function onScanResultResolved(scanPayload) {
    // Called by the orchestration chain (useProductScan -> ProductResolver -> Pricing -> Coupons)
    // scanPayload is expected to carry store/brand/sku & price deltas
    if (!scanPayload) return;
    const obs = {
      ts: scanPayload.ts || iso(clock.now()),
      storeId: scanPayload.storeId,
      brandId: scanPayload.brandId,
      sku: scanPayload.sku,
      listPrice: scanPayload.listPrice,
      price: scanPayload.price,
      discountPct: scanPayload.discountPct,
      couponId: scanPayload.couponId,
      couponType: scanPayload.couponType,
      stackable: scanPayload.stackable,
      loyaltyRequired: scanPayload.loyaltyRequired,
      provider: scanPayload.provider || 'resolver',
      meta: scanPayload.meta || {},
    };
    attachAttribution(obs.meta);
    // Fire & forget (no await to keep UI snappy)
    recordObservation(obs).catch(() => {});
  }

  // ---------- Public API -----------------------------------------------------

  return {
    recordObservation,
    learnFromEvents,
    predictNextWindows,
    batchPredict,
    shouldDelayPurchase,
    getBestByStoreBrand,
    getDealCalendar,
    upsertWatch,
    notifyWatchesIfNeeded,
    onScanResultResolved,
    // expose internals (read-only copies) for UI/Debug panels
    _debugSnapshot() {
      const out = [];
      for (const [k, v] of cycles) {
        out.push({ key: k, stats: v.stats, windows: v.windows, eventsTail: v.events.slice(-5) });
      }
      return out;
    },
  };
}

/* -----------------------------------------------------------------------------
USAGE NOTES (no imports here; just guidance):

// 1) Wire into your orchestrator (src/hooks/useProductScan.js)
const analyzer = createCycleAnalyzer({ clock, eventBus, analytics, db, prefs, favorites, sourceAttribution });
eventBus.on('pricing:resolved', (payload) => analyzer.onScanResultResolved(payload));

// 2) Respect “favorite sessions/schedules”
//    When user stars a store/brand/sku, call:
await analyzer.upsertWatch({ storeId, brandId, sku }, { notify: true, channels: ['toast','email'] });

// 3) Notifications (quiet hours + Sabbath guard honored):
setInterval(() => analyzer.notifyWatchesIfNeeded(), 15 * 60 * 1000);

// 4) UI panels (SourceAttribution.jsx) can show analyzer._debugSnapshot() for transparency.

// 5) Dexie schema (suggested):
// db.version(1).stores({
//   coupon_cycles: 'key, storeId, brandId, sku, updatedAt',
//   coupon_events: '++id, key, ts, storeId, brandId, sku'
// });

----------------------------------------------------------------------------- */
