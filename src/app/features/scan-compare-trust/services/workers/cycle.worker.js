/* eslint-disable no-restricted-globals, no-console */
// src/features/scan-compare-trust/services/workers/cycle.worker.js
// Background Cycle Learning (pricebook series)
// Input: time series points { key, upc?, brand?, name?, category?, storeId?, dateISO, price, unitPrice? }
// Output: cadence hints per key/brand/category/store + anomalies + next window
//
// Style: dependency-light, DI-friendly, guard-aware, cooperative yielding.
// Works alongside ocr.worker.js and store adapters; can run periodically or on-demand.

/**
 * Messaging contract (postMessage to worker):
 * - INIT:          { type:'INIT', config?:{ quietHours?, sabbathGuard? }, thresholds?:{priceDropPct, minPoints, minPromos}, persist?:{enabled:boolean}, timezone?:string }
 * - UPSERT_ITEMS:  { type:'UPSERT_ITEMS', jobId, seriesId, items:[{...}], meta?:{favor?:boolean, schedule?:string, source?:'ocr'|'adapter'|'manual'} }
 * - INGEST_SERIES: { type:'INGEST_SERIES', jobId, seriesId, items:[{...}], meta?:{ same as above } } // alias to UPSERT_ITEMS
 * - OBSERVE_OFFERS:{ type:'OBSERVE_OFFERS', jobId, seriesId, offers:[{brand, category, startISO, endISO, storeId?}], meta? } // adapter hints
 * - COMPUTE:       { type:'COMPUTE', jobId, seriesId, scope?:'all'|'store'|'brand'|'key', filter?:{storeId?, brand?, key?} }
 * - CANCEL:        { type:'CANCEL', jobId }
 * - HEALTH:        { type:'HEALTH' }
 *
 * Worker emits (postMessage from worker):
 * - READY, INIT_OK
 * - UPSERT_OK:       { jobId, seriesId, count }
 * - OFFERS_OK:       { jobId, seriesId, count }
 * - CYCLES_LEARNED:  { jobId, seriesId, hints:[{...}], stats:{keys, points, promos} }
 * - ANOMALIES:       { jobId, seriesId, items:[{key,dateISO,price,deltaPct,kind}] }
 * - SESSION_FAVOR_PROMPT: { domain:'scan', payload }
 * - SCHEDULE_APPLY:  { domain:'scan', templateKey, context }
 * - GUARD_BLOCKED:   { reason }
 * - HEALTH_OK | ERROR
 */

const state = {
  inited: false,
  tz: 'America/New_York',
  thresholds: {
    priceDropPct: 12.5,   // % drop vs rolling baseline to tag promo points
    minPoints: 8,         // min observations to even try a cycle
    minPromos: 3,         // min detected promo points to accept cycle
    maxGapDays: 120,      // ignore ancient gaps beyond this
  },
  guards: { quietHours: { enabled: false }, sabbathGuard: { enabled: false } },
  persist: { enabled: false },
  // in-memory series store (optionally mirrored to IDB)
  series: new Map(), // seriesId -> { items: Map<key, Item[]>, offers: Offer[] }
  jobs: new Map(),   // jobId -> { status }
  // optional DI
  db: null,          // { saveSeries(seriesId, snapshot), loadSeries(seriesId) }
};

postMessage({ type: 'READY' });

self.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  try {
    switch (msg.type) {
      case 'INIT':         return handleInit(msg);
      case 'UPSERT_ITEMS':
      case 'INGEST_SERIES':return handleUpsert(msg);
      case 'OBSERVE_OFFERS':return handleOffers(msg);
      case 'COMPUTE':      return handleCompute(msg);
      case 'CANCEL':       return setJobStatus(msg.jobId, 'canceled');
      case 'HEALTH':       return postMessage({ type: 'HEALTH_OK' });
      default:
        return postMessage({ type: 'ERROR', message: `Unknown type: ${msg.type}` });
    }
  } catch (e) {
    postMessage({ type: 'ERROR', jobId: msg.jobId, message: e?.message || String(e) });
  }
});

/* -------------------------------- INIT ----------------------------------- */

async function handleInit(msg) {
  const { config, thresholds, timezone, persist, db } = msg;
  if (config) state.guards = deepMerge(state.guards, config);
  if (thresholds) state.thresholds = deepMerge(state.thresholds, thresholds);
  if (timezone) state.tz = timezone;
  if (persist) state.persist = { ...state.persist, ...persist };
  if (db && typeof db.saveSeries === 'function' && typeof db.loadSeries === 'function') {
    state.db = db;
  }
  state.inited = true;
  postMessage({ type: 'INIT_OK', ok: true });
}

/* --------------------------- UPSERT / INGEST ------------------------------ */

async function handleUpsert(msg) {
  ensureInit();
  if (guardNow()) return postMessage({ type: 'GUARD_BLOCKED', reason: guardReason() });

  const { jobId, seriesId, items = [], meta = {} } = msg;
  ensureSeries(seriesId);

  // Bubble user intents (favorites/schedules) like other workers
  if (truthy(meta.favor)) {
    postMessage({ type: 'SESSION_FAVOR_PROMPT', domain: 'scan', payload: buildSessionPayload(meta) });
  }
  if (meta.schedule) {
    postMessage({ type: 'SCHEDULE_APPLY', domain: 'scan', templateKey: String(meta.schedule),
      context: { payload: buildSessionPayload(meta), origin: 'cycle.worker' } });
  }

  const series = state.series.get(seriesId);
  let count = 0;
  for (const it of items) {
    const norm = normalizeItem(it);
    if (!norm.key || !norm.dateISO) continue;
    const arr = ensureArray(series.items, norm.key);
    upsertPoint(arr, norm);
    count++;
    if (count % 200 === 0) await yieldIfNeeded();
  }

  if (state.persist.enabled) await maybePersist(seriesId);

  postMessage({ type: 'UPSERT_OK', jobId, seriesId, count });
}

async function handleOffers(msg) {
  ensureInit();
  const { jobId, seriesId, offers = [] } = msg;
  ensureSeries(seriesId);
  const series = state.series.get(seriesId);
  let count = 0;

  for (const o of offers) {
    const ok = normalizeOffer(o);
    if (!ok) continue;
    series.offers.push(ok);
    count++;
  }
  if (state.persist.enabled) await maybePersist(seriesId);
  postMessage({ type: 'OFFERS_OK', jobId, seriesId, count });
}

/* ------------------------------- COMPUTE ---------------------------------- */

async function handleCompute(msg) {
  ensureInit();
  if (guardNow()) return postMessage({ type: 'GUARD_BLOCKED', reason: guardReason() });

  const { jobId, seriesId, scope = 'all', filter = {} } = msg;
  const series = state.series.get(seriesId);
  if (!series) return postMessage({ type: 'ERROR', jobId, message: `Series not found: ${seriesId}` });

  const hints = [];
  const anomalies = [];
  let keysCount = 0, pointsCount = 0, promoCount = 0;

  const keys = Array.from(series.items.keys());
  for (const key of keys) {
    const arr = series.items.get(key) || [];
    // Scope filtering (store/brand/key)
    if (filter.key && key !== filter.key) continue;
    if (filter.storeId && !arr.some(p => p.storeId === filter.storeId)) continue;
    if (filter.brand && !arr.some(p => (p.brand || '').toLowerCase() === filter.brand.toLowerCase())) continue;

    if (arr.length < state.thresholds.minPoints) continue;

    // Sort & trim ancient gaps
    arr.sort((a, b) => a.dateISO.localeCompare(b.dateISO));
    const trimmed = trimByGap(arr, state.thresholds.maxGapDays);
    if (trimmed.length < state.thresholds.minPoints) continue;

    keysCount++;
    pointsCount += trimmed.length;

    // Compute baseline & promo markers
    const baseline = rollingMedian(trimmed.map(p => p.price));
    const markers = promoMarkers(trimmed, baseline, state.thresholds.priceDropPct);
    promoCount += markers.filter(m => m.isPromo).length;

    // Cycle detection via robust gap centrality + autocorr assist
    const cycle = detectCycle(trimmed, markers);
    if (cycle && cycle.promos >= state.thresholds.minPromos) {
      // Offer-aware nudge: adjust expected window using observed offer windows if aligned
      const offerAdj = adjustByOffers(cycle, series.offers, {
        brand: trimmed[0].brand,
        category: trimmed[0].category,
        storeId: trimmed[0].storeId,
      });

      hints.push({
        key,
        upc: trimmed[0].upc || null,
        brand: trimmed[0].brand || null,
        name: trimmed[0].name || null,
        category: trimmed[0].category || null,
        storeId: trimmed[0].storeId || null,
        likelyCycleDays: cycle.days,
        confidence: Number(cycle.confidence.toFixed(2)),
        promos: cycle.promos,
        lastPromoISO: cycle.lastPromoISO,
        nextExpectedStartISO: offerAdj.nextStartISO,
        window: { startISO: trimmed[0].dateISO, endISO: trimmed[trimmed.length - 1].dateISO },
        seasonality: cycle.seasonality, // weekday/woMonth density
        _meta: { method: cycle.method, offersAligned: offerAdj.aligned },
      });
    }

    // Anomaly detection: sharp increase vs baseline
    anomalies.push(...spikeUps(trimmed, baseline, 18)); // >18% up from baseline
    if (keysCount % 20 === 0) await yieldIfNeeded();
  }

  postMessage({
    type: 'CYCLES_LEARNED',
    jobId,
    seriesId,
    hints,
    stats: { keys: keysCount, points: pointsCount, promos: promoCount },
  });

  if (anomalies.length) {
    postMessage({ type: 'ANOMALIES', jobId, seriesId, items: anomalies });
  }
}

/* ------------------------------ ALGORITHM -------------------------------- */

function normalizeItem(it) {
  const dateISO = toISO(it.dateISO) || toISO(it.tsISO);
  const key = it.key || (it.upc ? `upc:${it.upc}` : buildKey(it.brand, it.name));
  return {
    key,
    upc: it.upc || null,
    brand: it.brand || null,
    name: it.name || null,
    category: it.category || null,
    storeId: it.storeId || null,
    price: safeNum(it.price),
    unitPrice: safeNum(it.unitPrice?.amount ?? it.unitPrice),
    dateISO,
    source: it.source || 'unknown',
  };
}
function normalizeOffer(o) {
  const startISO = toISO(o.startISO || o.start);
  const endISO = toISO(o.endISO || o.end);
  if (!startISO || !endISO) return null;
  return {
    brand: o.brand || null,
    category: o.category || null,
    storeId: o.storeId || null,
    startISO, endISO,
  };
}
function upsertPoint(arr, p) {
  // replace if same day to keep last price
  const k = p.dateISO.slice(0,10);
  const idx = arr.findIndex(x => x.dateISO.slice(0,10) === k);
  if (idx >= 0) arr[idx] = p; else arr.push(p);
}

function trimByGap(arr, maxGapDays) {
  if (!arr.length) return arr;
  const last = arr[arr.length - 1];
  const startIdx = arr.findIndex(a => daysBetween(a.dateISO, last.dateISO) <= maxGapDays);
  return startIdx <= 0 ? arr : arr.slice(startIdx);
}

function rollingMedian(values, win = 2) {
  // for each index, median of previous N points (excluding self)
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - win);
    const chunk = values.slice(start, i).filter(isNum);
    out[i] = chunk.length ? median(chunk) : values[i];
  }
  return out;
}

function promoMarkers(points, baseline, dropPct) {
  // mark promo if price is lower than baseline by >= dropPct
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const base = baseline[i] ?? p.price;
    const delta = base > 0 ? ((base - p.price) / base) * 100 : 0;
    const isPromo = delta >= dropPct;
    out.push({ idx: i, atISO: p.dateISO, isPromo, dropPct: delta });
  }
  return out;
}

function detectCycle(points, markers) {
  const promos = markers.filter(m => m.isPromo);
  if (promos.length < 1) return null;

  // Gaps between promo points
  const gaps = [];
  for (let i = 1; i < promos.length; i++) {
    gaps.push(daysBetween(promos[i - 1].atISO, promos[i].atISO));
  }
  if (!gaps.length) return null;

  const central = robustCentral(gaps);
  // Simple periodic sanity: require gaps roughly cluster (IQR check)
  const iqr = interquartileRange(gaps);
  const clustered = iqr <= Math.max(6, central * 0.35); // tightness threshold
  const methodPrimary = 'gap-centrality';

  // Lightweight autocorr on promo indicator series to confirm period
  const indicator = markers.map(m => (m.isPromo ? 1 : 0));
  const lag = clampInt(Math.round(central), 1, 120);
  const r = autocorr(indicator, lag);
  const confidence = clamp01((promos.length / (promos.length + 2)) * (clustered ? 1.0 : 0.7) * (0.6 + 0.4 * clamp01(r)));

  const lastPromoISO = promos[promos.length - 1].atISO;
  const seasonality = seasonalityProfile(promos.map(p => p.atISO));

  return {
    days: Math.max(1, Math.round(central)),
    promos: promos.length,
    lastPromoISO,
    method: methodPrimary,
    confidence,
    seasonality,
  };
}

function adjustByOffers(cycle, offers, context) {
  // If we observed official offer windows for this brand/category/store, align the next start to nearest cycle multiple.
  const relevant = offers.filter(o => 
    (!context.brand || (!o.brand || eqCi(o.brand, context.brand)) ) &&
    (!context.category || (!o.category || eqCi(o.category, context.category))) &&
    (!context.storeId || (o.storeId === context.storeId))
  );
  if (!relevant.length) {
    return { nextStartISO: addDaysISO(cycle.lastPromoISO, cycle.days), aligned: false };
  }
  // Pick most recent observed window end
  relevant.sort((a,b) => a.endISO.localeCompare(b.endISO));
  const latest = relevant[relevant.length - 1];
  const guess = addDaysISO(latest.startISO, cycle.days);
  return { nextStartISO: guess, aligned: true };
}

function spikeUps(points, baseline, upPct = 18) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const base = baseline[i] ?? points[i].price;
    if (!isNum(base) || !isNum(points[i].price)) continue;
    const deltaPct = base > 0 ? ((points[i].price - base) / base) * 100 : 0;
    if (deltaPct >= upPct) {
      out.push({
        key: points[i].key,
        dateISO: points[i].dateISO,
        price: points[i].price,
        deltaPct: Number(deltaPct.toFixed(2)),
        kind: 'price_spike',
      });
    }
  }
  return out;
}

/* ------------------------------- STATE ----------------------------------- */

function ensureSeries(seriesId) {
  if (!state.series.has(seriesId)) {
    state.series.set(seriesId, { items: new Map(), offers: [] });
  }
}
function ensureArray(map, key) {
  if (!map.has(key)) map.set(key, []);
  return map.get(key);
}
function setJobStatus(jobId, st) {
  if (!jobId) return;
  const j = state.jobs.get(jobId) || { status: 'running' };
  j.status = st;
  state.jobs.set(jobId, j);
}

/* --------------------------- FAVORITES/SCHEDULE --------------------------- */

function buildSessionPayload(meta) {
  return {
    barcode: null,
    queryText: 'Cycle learning session',
    storeFilter: meta.storeId || null,
    userZip: meta.zip || null,
    initialTab: 'compare',
    providerHints: {
      preferStores: meta.preferStores?.length ? meta.preferStores : (meta.storeId ? [meta.storeId] : undefined),
      zip: meta.zip || undefined,
    },
    _deeplink: { source: 'cycle.worker', at: new Date().toISOString() },
  };
}

/* ------------------------------- PERSIST --------------------------------- */

async function maybePersist(seriesId) {
  if (!state.db) return;
  const snapshot = serializeSeries(state.series.get(seriesId));
  await state.db.saveSeries(seriesId, snapshot);
}
function serializeSeries(s) {
  return {
    items: Array.from(s.items.entries()), // [key, Item[]][]
    offers: s.offers,
  };
}

/* --------------------------------- UTIL ---------------------------------- */

function guardNow() {
  if (state.guards.sabbathGuard?.enabled) return true;
  if (state.guards.quietHours?.enabled) return true;
  return false;
}
function guardReason() {
  if (state.guards.sabbathGuard?.enabled) return 'sabbath';
  if (state.guards.quietHours?.enabled) return 'quiet-hours';
  return 'guarded';
}
function ensureInit() {
  if (!state.inited) throw new Error('Worker not initialized. Send INIT first.');
}
function truthy(v) { return ['1','true','yes',true,1].includes(String(v).toLowerCase()); }
function yieldIfNeeded() { return new Promise((r) => setTimeout(r, 0)); }
function deepMerge(a, b) {
  const out = { ...a };
  for (const k in b) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) out[k] = deepMerge(a[k] || {}, b[k]);
    else out[k] = b[k];
  }
  return out;
}
function toISO(s) {
  if (!s) return null;
  const d = new Date(s);
  return isFinite(d) ? d.toISOString() : null;
}
function addDaysISO(aISO, days) {
  const t = new Date(aISO).getTime() + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function daysBetween(aISO, bISO) {
  const A = new Date(aISO).getTime();
  const B = new Date(bISO).getTime();
  return Math.max(1, Math.round((B - A) / 86400000));
}
function eqCi(a, b) { return String(a||'').toLowerCase() === String(b||'').toLowerCase(); }
function isNum(n) { return typeof n === 'number' && isFinite(n); }
function median(arr) {
  const a = arr.filter(isNum).slice().sort((x,y)=>x-y);
  const m = Math.floor(a.length/2);
  return a.length ? (a.length%2 ? a[m] : (a[m-1]+a[m])/2) : 0;
}
function robustCentral(arr) {
  const a = arr.slice().sort((x,y)=>x-y);
  if (!a.length) return 0;
  const start = Math.floor(a.length * 0.2);
  const end = Math.ceil(a.length * 0.8);
  const mid = a.slice(start, end);
  return median(mid.length ? mid : a);
}
function interquartileRange(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x,y)=>x-y);
  const q1 = a[Math.floor(a.length * 0.25)];
  const q3 = a[Math.floor(a.length * 0.75)];
  return q3 - q1;
}
function autocorr(signal, lag) {
  // naive normalized autocorrelation at lag
  if (!signal.length || lag <= 0 || lag >= signal.length) return 0;
  const n = signal.length - lag;
  let mu1 = 0, mu2 = 0;
  for (let i=0;i<n;i++){ mu1 += signal[i]; mu2 += signal[i+lag]; }
  mu1/=n; mu2/=n;
  let num=0, den1=0, den2=0;
  for (let i=0;i<n;i++){
    const a = signal[i]-mu1, b = signal[i+lag]-mu2;
    num += a*b; den1 += a*a; den2 += b*b;
  }
  const den = Math.sqrt(den1*den2) || 1;
  return num/den;
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function clampInt(n, lo, hi){ return Math.max(lo, Math.min(hi, n|0)); }
function buildKey(brand, name) {
  const b = String(brand||'unknown').toLowerCase().replace(/\W+/g,'-').slice(0,24);
  const n = String(name||'item').toLowerCase().replace(/\W+/g,'-').slice(0,36);
  return `bn:${b}:${n}`;
}
function safeNum(n) {
  const x = typeof n === 'object' && n?.amount != null ? n.amount : n;
  const v = Number(x);
  return isFinite(v) ? Number(v.toFixed(2)) : null;
}
