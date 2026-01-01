/* eslint-disable no-console */
// cycles.schema.js — Dexie DB for Learned Cycle Insights (Scan • Compare • Trust)
// Style: versioned, defensive, event-friendly. JS + JSDoc for DX.
//
// Integrates with:
//  - pricebook.schema: price_observations, pricebook_items, source_attributions
//  - coupons.schema: coupons, redemptions (for promo windows)
//  - CycleAnalyzer.js service & events.catalog (cycle.* events)
//  - useCouponPrefs (per-user store prefs) & Scheduler (user/system schedules)
//  - Favorites (sessions/schedules) via "watchlists" (user tracked targets)

import Dexie from 'dexie';

export class CyclesDB extends Dexie {
  /** @type {Dexie.Table} */ discount_cycles;   // learned model per (store + key)
  /** @type {Dexie.Table} */ cycle_events;      // observed promo windows per key
  /** @type {Dexie.Table} */ cycle_models;      // calc snapshots for audit/debug
  /** @type {Dexie.Table} */ watchlists;        // user watch targets & alerts
  /** @type {Dexie.Table} */ attributions;      // optional source links for UI

  /**
   * @param {Object} [opts]
   * @param {string} [opts.name]
   * @param {{emit?:Function}} [opts.eventBus]
   */
  constructor(opts = {}) {
    super(opts.name || 'SUKA_CYCLES_DB');
    this._eventBus = opts.eventBus?.emit ? opts.eventBus : { emit: () => {} };

    // v1 — Core structures
    this.version(1).stores({
      // One row per (storeId + key) key ~ upc|brand|category
      discount_cycles:
        '++id, storeId, keyType, keyValue, ' +
        // preferred summary stats
        'cycleDays, cycleDaysLo, cycleDaysHi, ' +      // robust estimates (median ± IQR/2)
        'confidence, strength, lastStart, lastEnd, nextEarliest, nextLatest, ' +
        'samples, seasonality, tags, updatedAt, ' +
        // common lookups
        '[storeId+keyType+keyValue], [storeId+cycleDays], [keyType+keyValue]',

      // Each promotion window observed (derived from price_observations/coupons)
      cycle_events:
        '++id, storeId, keyType, keyValue, upc, brand, category, ' +
        'startISO, endISO, ' +
        'kind, // price_drop|coupon|circular|manager_special' +
        'depth, // discount depth percentage (0..1) if known' +
        'source, ' +
        'tags, ' +
        '[storeId+keyType+keyValue], [storeId+startISO], [keyType+keyValue+startISO]',

      // Model snapshots & parameters for transparency/audit
      cycle_models:
        '++id, cycleId, calcAt, method, // robust|ewma|hybrid ' +
        'medianDays, iqrDays, ewmaDays, sigma, sampleCount, notes, params',

      // User watch targets (users can save/favorite what they care about)
      watchlists:
        '++id, userId, householdId, storeId, keyType, keyValue, ' +
        'rule, // soon|window_open|window_close|overdue|any ' +
        'advanceDays, // notify X days before earliest' +
        'active, visibility, tags, createdAt, updatedAt, ' +
        '[userId+storeId+keyType+keyValue], [userId+active], [storeId+keyType+keyValue]',

      // Optional attribution records for UI badges
      attributions:
        '++id, entityType, entityId, sourceName, sourceType, weight, updatedAt, tags',
    });

    // v2 — Soft delete, anomaly flags, jitter windows
    this.version(2).stores({
      discount_cycles:
        '++id, storeId, keyType, keyValue, ' +
        'cycleDays, cycleDaysLo, cycleDaysHi, confidence, strength, ' +
        'lastStart, lastEnd, nextEarliest, nextLatest, jitterDays, ' +
        'samples, anomalies, seasonality, tags, updatedAt, deleted, ' +
        '[storeId+keyType+keyValue], [storeId+cycleDays], [keyType+keyValue]',
      cycle_events:
        '++id, storeId, keyType, keyValue, upc, brand, category, startISO, endISO, ' +
        'kind, depth, source, tags, deleted, ' +
        '[storeId+keyType+keyValue], [storeId+startISO], [keyType+keyValue+startISO]',
      attributions:
        '++id, entityType, entityId, sourceName, sourceType, weight, updatedAt, tags, deleted',
    }).upgrade(async (tx) => {
      await tx.table('discount_cycles').toCollection().modify(r => {
        r.deleted ??= false;
        r.jitterDays ??= 4;     // default ±4 day wiggle room
        r.anomalies ??= [];
      });
      await tx.table('cycle_events').toCollection().modify(r => { r.deleted ??= false; });
      await tx.table('attributions').toCollection().modify(r => { r.deleted ??= false; });
    });

    // v3 — Expand watchlists with schedule hooks and lastNotified
    this.version(3).stores({
      watchlists:
        '++id, userId, householdId, storeId, keyType, keyValue, rule, advanceDays, active, ' +
        'visibility, tags, createdAt, updatedAt, lastNotifiedISO, scheduleId, sessionId, ' +
        '[userId+storeId+keyType+keyValue], [userId+active], [storeId+keyType+keyValue]',
    });

    // Wire handles
    this.discount_cycles = this.table('discount_cycles');
    this.cycle_events = this.table('cycle_events');
    this.cycle_models = this.table('cycle_models');
    this.watchlists = this.table('watchlists');
    this.attributions = this.table('attributions');

    // Signals
    this.on('ready', () => {
      this._eventBus.emit?.('db.ready', { db: 'SUKA_CYCLES_DB' });
      return true;
    });
  }

  // ---------------- Helpers for CycleAnalyzer orchestration ----------------

  /**
   * Record an observed promotion window (start/end + metadata).
   * This is the primary feed for learning cycles.
   * @returns {Promise<number>} event id
   */
  async recordPromotionWindow({
    storeId, keyType, keyValue, upc = null, brand = null, category = null,
    startISO, endISO, kind = 'price_drop', depth = null, source = 'unknown', tags = [],
  }) {
    if (!storeId || !keyType || !keyValue || !startISO) return null;
    const end = endISO || startISO;

    const id = await this.cycle_events.add({
      storeId, keyType, keyValue, upc, brand, category,
      startISO, endISO: end,
      kind, depth, source, tags, deleted: false,
    });

    // Update/learn the model
    await this._learnCycleFromEvents(storeId, keyType, keyValue);

    this._eventBus.emit?.('cycle.event.recorded', { storeId, keyType, keyValue, eventId: id });
    return id;
  }

  /**
   * Recompute the cycle model for a (store,key) using robust statistics + EWMA.
   * Emits cycle.updated and cycle.prediction.changed when applicable.
   */
  async _learnCycleFromEvents(storeId, keyType, keyValue) {
    const events = await this.cycle_events
      .where('[storeId+keyType+keyValue]')
      .equals([storeId, keyType, keyValue])
      .filter(e => !e.deleted)
      .sortBy('startISO');

    if (events.length < 2) {
      // create stub cycle entry if missing
      await this._ensureCycleRow({ storeId, keyType, keyValue, samples: events.length });
      return;
    }

    // Calculate inter-arrival distances in days between starts
    const starts = events.map(e => new Date(e.startISO)).sort((a,b)=>a-b);
    const gaps = [];
    for (let i=1;i<starts.length;i++){
      gaps.push(daysBetween(starts[i-1], starts[i]));
    }

    // Robust stats
    const medianDays = median(gaps);
    const iqr = iqrDays(gaps);
    const lo  = Math.max(1, Math.round(medianDays - iqr/2));
    const hi  = Math.round(medianDays + iqr/2);

    // EWMA blend (smoother responsiveness)
    const ewmaDays = ewma(gaps, 0.35); // α=0.35 default
    const hybrid = Math.round((medianDays*0.6) + (ewmaDays*0.4));

    // Confidence/strength heuristic
    const sampleCount = gaps.length;
    const dispersion = iqr / (medianDays || 1);
    const confidence = clamp01( 0.2 + 0.6 * sigmoid(sampleCount/6) + 0.2 * (1 - clamp01(dispersion)) );
    const strength = clamp01( 0.5 * sigmoid(sampleCount/8) + 0.5 * (1 - clamp01(dispersion)) );

    // Last window & next prediction
    const last = events[events.length - 1];
    const jitter = Math.max(2, Math.round(Math.min(7, Math.max(4, Math.floor(hybrid*0.15))))); // 15% up to 7
    const nextEarliest = iso(addDays(new Date(last.startISO), hybrid - jitter));
    const nextLatest   = iso(addDays(new Date(last.startISO), hybrid + jitter));

    // Write/Upsert cycle row
    const cycle = await this._ensureCycleRow({
      storeId, keyType, keyValue,
      cycleDays: hybrid,
      cycleDaysLo: lo,
      cycleDaysHi: hi,
      confidence,
      strength,
      lastStart: last.startISO,
      lastEnd: last.endISO || last.startISO,
      nextEarliest,
      nextLatest,
      jitterDays: jitter,
      samples: sampleCount,
      anomalies: detectAnomalies(gaps, medianDays, iqr),
      seasonality: null, // placeholder; can be filled by higher-order analyzer
      updatedAt: iso(new Date()),
    });

    // Persist calculation snapshot (debug/audit)
    await this.cycle_models.add({
      cycleId: cycle.id,
      calcAt: iso(new Date()),
      method: 'hybrid',
      medianDays,
      iqrDays: iqr,
      ewmaDays,
      sigma: stdev(gaps),
      sampleCount,
      notes: 'median+IQR blended with EWMA',
      params: { alpha: 0.35, dispersion },
    });

    this._eventBus.emit?.('cycle.updated', {
      storeId, keyType, keyValue,
      cycleDays: hybrid, lo, hi, confidence, strength,
      nextEarliest, nextLatest,
      samples: sampleCount,
    });
  }

  /**
   * Ensure a cycle row exists and optionally update it. Returns the row.
   */
  async _ensureCycleRow(patch) {
    const { storeId, keyType, keyValue } = patch;
    let row = await this.discount_cycles.where('[storeId+keyType+keyValue]').equals([storeId, keyType, keyValue]).first();
    if (!row) {
      const id = await this.discount_cycles.add({
        storeId, keyType, keyValue,
        cycleDays: patch.cycleDays ?? null,
        cycleDaysLo: patch.cycleDaysLo ?? null,
        cycleDaysHi: patch.cycleDaysHi ?? null,
        confidence: patch.confidence ?? 0,
        strength: patch.strength ?? 0,
        lastStart: patch.lastStart ?? null,
        lastEnd: patch.lastEnd ?? null,
        nextEarliest: patch.nextEarliest ?? null,
        nextLatest: patch.nextLatest ?? null,
        jitterDays: patch.jitterDays ?? 4,
        samples: patch.samples ?? 0,
        anomalies: patch.anomalies ?? [],
        seasonality: patch.seasonality ?? null,
        tags: patch.tags ?? [],
        updatedAt: patch.updatedAt ?? iso(new Date()),
        deleted: false,
      });
      row = await this.discount_cycles.get(id);
    } else if (patch) {
      const before = { nextEarliest: row.nextEarliest, nextLatest: row.nextLatest };
      await this.discount_cycles.update(row.id, { ...row, ...patch, updatedAt: iso(new Date()) });
      row = await this.discount_cycles.get(row.id);
      if (before.nextEarliest !== row.nextEarliest || before.nextLatest !== row.nextLatest) {
        this._eventBus.emit?.('cycle.prediction.changed', {
          storeId, keyType, keyValue, nextEarliest: row.nextEarliest, nextLatest: row.nextLatest
        });
      }
    }
    return row;
  }

  /**
   * Predict the next window for a given key (with graceful fallbacks).
   */
  async predictNextWindow({ storeId, keyType, keyValue }) {
    const cycle = await this.discount_cycles.where('[storeId+keyType+keyValue]').equals([storeId, keyType, keyValue]).first();
    if (!cycle || !cycle.cycleDays) return { ok: false, reason: 'insufficient_data' };
    return {
      ok: true,
      window: { earliest: cycle.nextEarliest, latest: cycle.nextLatest },
      confidence: cycle.confidence,
      strength: cycle.strength,
      jitterDays: cycle.jitterDays,
      samples: cycle.samples,
    };
  }

  /**
   * Add attribution badges for transparency (UI SourceAttribution component).
   */
  async addAttributions(entityType, entityId, attributions = []) {
    if (!entityType || !entityId || !Array.isArray(attributions) || !attributions.length) return [];
    const ts = iso(new Date());
    const rows = attributions.map(a => ({
      entityType,
      entityId,
      sourceName: a.sourceName ?? 'unknown',
      sourceType: a.sourceType ?? 'provider',
      weight: numOr(a.weight, 1),
      updatedAt: ts,
      tags: a.tags ?? [],
      deleted: false,
    }));
    return this.attributions.bulkAdd(rows);
  }

  // ---------------- Watchlists (user favorites & alerts) ----------------

  /**
   * Create/update a watch target for notifications & dashboards.
   * Users can "favorite" cycle keys they care about; linked schedules/sessions optional.
   */
  async upsertWatch({
    userId, householdId = null, storeId, keyType, keyValue,
    rule = 'soon', advanceDays = 3, active = true,
    visibility = 'private', tags = [], scheduleId = null, sessionId = null,
  }) {
    if (!userId || !storeId || !keyType || !keyValue) return null;
    const prior = await this.watchlists.where('[userId+storeId+keyType+keyValue]').equals([userId, storeId, keyType, keyValue]).first();
    const now = iso(new Date());
    const payload = {
      userId, householdId, storeId, keyType, keyValue,
      rule, advanceDays, active, visibility, tags,
      scheduleId, sessionId,
      updatedAt: now,
      createdAt: prior?.createdAt ?? now,
      lastNotifiedISO: prior?.lastNotifiedISO ?? null,
    };
    let id;
    if (prior) {
      await this.watchlists.update(prior.id, payload);
      id = prior.id;
    } else {
      id = await this.watchlists.add(payload);
    }
    this._eventBus.emit?.('cycle.watch.updated', { userId, storeId, keyType, keyValue, id, active });
    return id;
  }

  /**
   * Evaluate watch rules and return hits (no side effects unless markNotified=true).
   * rule: soon|window_open|window_close|overdue|any
   */
  async evaluateWatches({ userId = null, storeId = null, markNotified = false, now = new Date() } = {}) {
    const filters = [];
    if (userId) filters.push(r => r.userId === userId);
    if (storeId) filters.push(r => r.storeId === storeId);

    const watches = await this.watchlists.filter(r => r.active && (!filters.length || filters.every(f => f(r)))).toArray();
    const nowISO = iso(now);
    const hits = [];

    for (const w of watches) {
      const cyc = await this.discount_cycles.where('[storeId+keyType+keyValue]').equals([w.storeId, w.keyType, w.keyValue]).first();
      if (!cyc || !cyc.nextEarliest) continue;

      const earliest = new Date(cyc.nextEarliest);
      const latest = cyc.nextLatest ? new Date(cyc.nextLatest) : earliest;
      const leadDate = addDays(earliest, -1 * (w.advanceDays ?? 0));

      const isSoon   = now >= leadDate && now <= latest;
      const openNow  = now >= earliest && now <= latest;
      const closing  = daysBetween(now, latest) <= 1 && now <= latest && now >= earliest;
      const overdue  = now > latest;

      const map = { soon: isSoon, window_open: openNow, window_close: closing, overdue, any: (isSoon || openNow || closing || overdue) };
      if (map[w.rule]) {
        hits.push({ watch: w, cycle: cyc, now: nowISO });
        if (markNotified) {
          await this.watchlists.update(w.id, { lastNotifiedISO: nowISO });
        }
        this._eventBus.emit?.('cycle.watch.hit', {
          userId: w.userId, storeId: w.storeId, keyType: w.keyType, keyValue: w.keyValue,
          rule: w.rule, nextEarliest: cyc.nextEarliest, nextLatest: cyc.nextLatest
        });
      }
    }
    return hits;
  }

  // ---------------- Convenience ingestors ----------------

  /**
   * Conveniences to derive promo windows from raw rows (merge contiguous price-drops).
   * Pass in normalized observations sorted by date for a specific (store, key).
   */
  async deriveWindowsFromObservations({ storeId, keyType, keyValue, observations = [], source = 'price_observation' }) {
    if (!observations?.length) return [];
    // Simple merge: treat consecutive days with promoPrice/price reduction as a single window.
    const windows = [];
    let cur = null;
    for (const o of observations) {
      const start = new Date(o.dateObserved || o.startISO || o.ts || o.updatedAt || o.createdAt);
      const isPromo = promoFlag(o);
      if (isPromo) {
        if (!cur) {
          cur = { startISO: iso(start), endISO: iso(start), depth: estDepth(o), kind: 'price_drop' };
        } else {
          // extend if contiguous (<=1 days gap)
          const prev = new Date(cur.endISO);
          if (daysBetween(prev, start) <= 1) {
            cur.endISO = iso(start);
            cur.depth = Math.max(cur.depth, estDepth(o) ?? 0);
          } else {
            windows.push(cur);
            cur = { startISO: iso(start), endISO: iso(start), depth: estDepth(o), kind: 'price_drop' };
          }
        }
      }
    }
    if (cur) windows.push(cur);

    // Persist windows
    const ids = [];
    for (const w of windows) {
      const id = await this.recordPromotionWindow({
        storeId, keyType, keyValue,
        upc: keyType === 'upc' ? keyValue : null,
        brand: keyType === 'brand' ? keyValue : null,
        category: keyType === 'category' ? keyValue : null,
        startISO: w.startISO, endISO: w.endISO, kind: w.kind, depth: w.depth, source
      });
      ids.push(id);
    }
    return ids;
  }
}

// ---------------- Utilities ----------------

const iso = (v) => (v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null));
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const numOr = (v, fb) => (v == null || Number.isNaN(Number(v)) ? fb : Number(v));

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function daysBetween(a, b) { return Math.round((b - a) / (1000*60*60*24)); }

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x,y)=>x-y);
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
}
function quantile(arr, q) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x,y)=>x-y);
  const pos = (a.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return a[base + 1] !== undefined ? a[base] + rest * (a[base + 1] - a[base]) : a[base];
}
function iqrDays(arr){ return Math.max(0, quantile(arr, 0.75) - quantile(arr, 0.25)); }
function stdev(arr) {
  if (!arr.length) return 0;
  const mean = arr.reduce((s,x)=>s+x,0)/arr.length;
  const varc = arr.reduce((s,x)=>s+(x-mean)*(x-mean),0)/arr.length;
  return Math.sqrt(varc);
}
function ewma(arr, alpha = 0.3) {
  if (!arr.length) return 0;
  let s = arr[0];
  for (let i=1;i<arr.length;i++){ s = alpha*arr[i] + (1-alpha)*s; }
  return s;
}
function sigmoid(x){ return 1 / (1 + Math.exp(-x)); }

function detectAnomalies(gaps, med, iqr) {
  const hi = med + 1.5 * (iqr || 1);
  const lo = Math.max(0, med - 1.5 * (iqr || 1));
  const out = [];
  for (let i=0;i<gaps.length;i++){
    if (gaps[i] > hi || gaps[i] < lo) out.push({ idx: i, value: gaps[i], type: 'gap_outlier' });
  }
  return out;
}
function promoFlag(o){
  // If promoPrice exists and < regularPrice/price, count as promo
  const p = Number(o.promoPrice ?? o.price ?? NaN);
  const r = Number(o.regularPrice ?? o.price ?? NaN);
  return Number.isFinite(p) && Number.isFinite(r) && p < r;
}
function estDepth(o){
  const p = Number(o.promoPrice ?? o.price ?? NaN);
  const r = Number(o.regularPrice ?? o.price ?? NaN);
  if (!Number.isFinite(p) || !Number.isFinite(r) || r <= 0) return null;
  return clamp01((r - p) / r);
}

// ---------------- Singletons ----------------

export const cyclesDB = new CyclesDB();
export const createCyclesDB = (opts) => new CyclesDB(opts);
