/* eslint-disable no-restricted-globals, no-console */
// src/features/scan-compare-trust/services/workers/ocr.worker.js
// Web Worker: Tesseract OCR + Pricebook Series Indexer + Cycle Learning hooks
// Style: DI-friendly, progressive updates, favorites/schedules aware, guard-aware.

const state = {
  inited: false,
  jobs: new Map(), // jobId -> { status, queue:[], results:[], meta:{} }
  timezone: 'America/New_York',
  thresholds: { priceDropPct: 12.5, minFramesForCycle: 3 },
  config: { quietHours: { enabled: false }, sabbathGuard: { enabled: false } },

  // OCR
  ocrEngineFactory: null,    // async (opts)=>{ ocr(blob) -> { text, words? }, close() }
  ocrOpts: {
    kind: 'tesseract',
    corePath: null,   // e.g., '/vendor/tesseract-core.wasm.js'
    workerPath: null, // e.g., '/vendor/tesseract-worker.min.js'
    langPath: null,   // e.g., '/vendor/lang-data'
    langs: ['eng'],
    psm: 6,           // Assume a block of text (receipts/labels)
    oem: 1,
  },

  // Cross-worker: optional
  cyclePort: null,           // MessagePort to cycle.worker (if provided)
  cycleChannelName: null,    // BroadcastChannel name (alt path)
};

postMessage({ type: 'READY' });

self.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  try {
    switch (msg.type) {
      case 'INIT':          return handleInit(msg);
      case 'PRELOAD_LANGS': return handlePreloadLangs(msg);
      case 'INDEX_SERIES':  return handleIndexSeries(msg);
      case 'INGEST_FRAME':  return handleIngestFrame(msg);
      case 'CANCEL':        return handleCancel(msg);
      case 'RESUME':        return handleResume(msg);
      case 'HEALTH':        return postMessage({ type: 'HEALTH_OK' });
      case 'ATTACH_CYCLE_PORT': return handleAttachCyclePort(msg);
      case 'ATTACH_CYCLE_CHANNEL': return handleAttachCycleChannel(msg);
      default:
        return postMessage({ type: 'ERROR', message: `Unknown message type: ${msg.type}` });
    }
  } catch (e) {
    postMessage({ type: 'ERROR', jobId: msg.jobId, message: e?.message || String(e) });
  }
});

/* -------------------------------- INIT ----------------------------------- */

async function handleInit(msg) {
  const { ocr, config, thresholds, timezone, tesseract, cyclePort } = msg;

  if (config) state.config = deepMerge(state.config, config);
  if (thresholds) state.thresholds = deepMerge(state.thresholds, thresholds);
  if (timezone) state.timezone = timezone;

  // Optional cycle worker connectivity
  if (cyclePort && typeof cyclePort.postMessage === 'function') {
    state.cyclePort = cyclePort;
  }
  if (msg.cycleChannelName) {
    state.cycleChannelName = msg.cycleChannelName;
  }

  // OCR engine selection
  if (ocr?.create && typeof ocr.create === 'function') {
    state.ocrEngineFactory = ocr.create;
  } else {
    // Configure Tesseract options if provided
    if (tesseract) state.ocrOpts = { ...state.ocrOpts, ...tesseract };
    state.ocrEngineFactory = createTesseractEngineFactory(state.ocrOpts);
  }

  state.inited = true;
  postMessage({ type: 'INIT_OK', ok: true });
}

/** Optional: warm-load languages before first job */
async function handlePreloadLangs(msg) {
  ensureInit();
  if (state.ocrOpts.kind !== 'tesseract') return postMessage({ type:'PRELOAD_OK', ok:true });
  try {
    const engine = await state.ocrEngineFactory({ preloadOnly: true, langs: msg.langs || state.ocrOpts.langs });
    await engine.close?.();
    postMessage({ type:'PRELOAD_OK', ok:true, langs: msg.langs || state.ocrOpts.langs });
  } catch (e) {
    postMessage({ type:'ERROR', message: 'PRELOAD_LANGS failed', details: e?.message || String(e) });
  }
}

/* -------------------------- TESSERACT FACTORY ----------------------------- */

function createTesseractEngineFactory(defaults) {
  let Tesseract = null; // module cache across engine instances

  async function loadTesseractPaths(opts) {
    const { corePath, workerPath } = opts;
    // Load via importScripts once (browser Worker context)
    if (typeof importScripts === 'function') {
      if (workerPath) try { importScripts(workerPath); } catch {}
      if (!Tesseract && self.Tesseract) Tesseract = self.Tesseract;
    }
    // If not present, try dynamic import (bundler may inline)
    if (!Tesseract && typeof importScripts !== 'function') {
      try {
        // eslint-disable-next-line no-undef
        Tesseract = await import(/* @vite-ignore */ opts.modulePath || 'tesseract.js');
      } catch {}
    }
    if (!Tesseract && !self.Tesseract) {
      throw new Error('[ocr.worker] Tesseract not available. Provide workerPath/modulePath.');
    }
    if (!Tesseract && self.Tesseract) Tesseract = self.Tesseract;
    return Tesseract;
  }

  return async function createEngine(runtimeOpts = {}) {
    const opts = { ...defaults, ...runtimeOpts };
    await loadTesseractPaths(opts);

    const worker = await Tesseract.createWorker({
      corePath: opts.corePath || undefined,
      workerPath: opts.workerPath || undefined,
      langPath: opts.langPath || undefined,
      logger: (m) => {
        // stream Tesseract progress to UI
        if (m?.progress != null) {
          postMessage({ type:'OCR_PROGRESS', progress: m.progress, status: m.status });
        }
      },
    });

    // Load & initialize languages
    const langs = Array.isArray(opts.langs) ? opts.langs.join('+') : (opts.langs || 'eng');
    await worker.loadLanguage(langs);
    await worker.initialize(langs, opts.oem ?? 1);
    if (opts.psm != null) await worker.setParameters({ tessedit_pageseg_mode: String(opts.psm) });

    return {
      async ocr(input) {
        // Preprocess → ImageData (grayscale/contrast/threshold/orientation)
        const img = await ensureImageData(input, { scale: 1.5, threshold: 0.15, contrast: 1.1 });
        const res = await worker.recognize(img);
        const text = res?.data?.text || '';
        const words = (res?.data?.words || []).map(w => ({
          text: w.text, conf: w.conf, bbox: w.bbox, baseline: w.baseline
        }));
        return { text, words };
      },
      async close() {
        try { await worker.terminate(); } catch {}
      },
    };
  };
}

/* --------------------------- SERIES INDEXING ------------------------------ */

async function handleIndexSeries(msg) {
  ensureInit();
  if (guardNow()) { postMessage({ type: 'GUARD_BLOCKED', reason: guardReason() }); return; }

  const { jobId, seriesId, frames = [], meta = {} } = msg;
  const job = ensureJob(jobId, { seriesId, meta });

  // favorites/schedules intents
  if (truthy(meta.favor)) {
    postMessage({ type:'SESSION_FAVOR_PROMPT', domain:'scan', payload: buildSessionPayloadFromMeta(meta) });
  }
  if (meta.schedule) {
    postMessage({ type:'SCHEDULE_APPLY', domain:'scan', templateKey:String(meta.schedule),
      context:{ payload: buildSessionPayloadFromMeta(meta), origin:'ocr.worker' } });
  }

  const engine = await state.ocrEngineFactory({ jobId, seriesId });
  try {
    const total = frames.length;
    let done = 0;
    postMessage({ type:'PROGRESS', jobId, seriesId, step:'start', done, total, meta });

    for (const frame of frames) {
      if (isCanceled(jobId)) break;
      await yieldIfNeeded();

      const started = performance.now();

      // Optional auto-rotate + crop prices region (light heuristic)
      const prepared = await preprocessFrame(frame, { autoRotate: true, cropTall: true });

      const { text } = await engine.ocr(prepared);
      const parsed = parsePricebookText(text, { tsISO: frame.tsISO, storeId: meta.storeId });
      job.results.push(...parsed.items);

      done += 1;
      postMessage({
        type:'FRAME_DONE',
        jobId, seriesId,
        frameId: frame.id ?? done,
        textLen: text?.length || 0,
        itemsCount: parsed.items.length,
        ms: Math.round(performance.now() - started),
      });

      if (done % 3 === 0 || done === total) {
        postMessage({ type:'PROGRESS', jobId, seriesId, step:'ocr', done, total, meta });
      }
    }

    // Emit series
    const { items, stats } = normalizeAndSummarize(job.results, { windowHint: meta.windowHint, storeId: meta.storeId });
    postMessage({ type:'SERIES_INDEXED', jobId, seriesId, items, stats });

    // Lightweight internal cycle hints (still emit here for existing listeners)
    const hints = learnCycles(items, { priceDropPct: state.thresholds.priceDropPct, timezone: state.timezone });
    postMessage({ type:'CYCLES_LEARNED', jobId, seriesId, hints });

    // If an external cycle worker is attached, forward for consolidated learning
    forwardCyclesToCycleWorker({ jobId, seriesId, items });

  } catch (e) {
    postMessage({ type:'ERROR', jobId, message: e?.message || String(e) });
  } finally {
    await safeClose(engine);
    setJobStatus(jobId, 'finished');
  }
}

async function handleIngestFrame(msg) {
  ensureInit();
  const { jobId, seriesId, frame, meta = {} } = msg;
  const job = ensureJob(jobId, { seriesId, meta });
  if (job.status === 'canceled') return;

  const engine = await state.ocrEngineFactory({ jobId, seriesId });
  try {
    const started = performance.now();
    const prepared = await preprocessFrame(frame, { autoRotate: true, cropTall: true });
    const { text } = await engine.ocr(prepared);
    const parsed = parsePricebookText(text, { tsISO: frame.tsISO, storeId: meta.storeId });
    job.results.push(...parsed.items);

    postMessage({
      type:'FRAME_DONE',
      jobId, seriesId,
      frameId: frame.id ?? (job.queue.length + 1),
      textLen: text?.length || 0,
      itemsCount: parsed.items.length,
      ms: Math.round(performance.now() - started),
    });
  } catch (e) {
    postMessage({ type:'ERROR', jobId, message: e?.message || String(e) });
  } finally {
    await safeClose(engine);
  }
}

/* ------------------------------ CYCLE PIPING ------------------------------ */

function handleAttachCyclePort(msg) {
  const { port } = msg;
  // MessageChannel port from host; the host must transfer it with postMessage(..., [port])
  if (port && typeof port.postMessage === 'function') {
    state.cyclePort = port;
    postMessage({ type:'CYCLE_PORT_OK' });
  } else {
    postMessage({ type:'ERROR', message:'ATTACH_CYCLE_PORT: invalid port' });
  }
}
function handleAttachCycleChannel(msg) {
  const { name } = msg;
  if (typeof name === 'string' && name.length) {
    state.cycleChannelName = name;
    postMessage({ type:'CYCLE_CHANNEL_OK', name });
  } else {
    postMessage({ type:'ERROR', message:'ATTACH_CYCLE_CHANNEL: invalid channel name' });
  }
}

function forwardCyclesToCycleWorker({ jobId, seriesId, items }) {
  if ((!state.cyclePort && !state.cycleChannelName) || !items?.length) return;
  const payload = {
    type:'UPSERT_ITEMS',
    jobId: `ocr-forward:${jobId || 'job'}`,
    seriesId,
    items: items.map(it => ({
      key: it.key, upc: it.upc, brand: it.brand, name: it.name,
      category: it.category, storeId: it.storeId,
      dateISO: it.dateISO, price: it.price, unitPrice: it.unitPrice?.amount ?? it.unitPrice,
      source:'ocr'
    })),
    meta: { source:'ocr' },
  };
  try {
    if (state.cyclePort) state.cyclePort.postMessage(payload);
    else if (state.cycleChannelName) {
      const bc = new BroadcastChannel(state.cycleChannelName);
      bc.postMessage(payload);
      bc.close();
    }
  } catch {}
}

/* --------------------------- OCR UTILITIES -------------------------------- */

async function preprocessFrame(frame, opts = {}) {
  // Pull a Blob for uniform handling, then to ImageBitmap → OffscreenCanvas
  const blob = await coerceToBlobOrImage(frame);
  const bmp = await createImageBitmap(blob);

  // Resize & enhance for better OCR (scale up slightly)
  const scale = opts.scale || 1.25;
  const W = Math.max(32, Math.floor(bmp.width * scale));
  const H = Math.max(32, Math.floor(bmp.height * scale));
  const off = new OffscreenCanvas(W, H);
  const ctx = off.getContext('2d');

  // Draw & grayscale
  ctx.drawImage(bmp, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H);
  const data = img.data;
  const contrast = opts.contrast ?? 1.08;
  const threshold = opts.threshold ?? 0.12;

  for (let i = 0; i < data.length; i += 4) {
    // luma
    let v = 0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2];
    // simple contrast (around 128)
    v = (v - 128) * contrast + 128;
    // soft threshold to fight glare
    v = v < (255 * threshold) ? 0 : v;
    data[i] = data[i+1] = data[i+2] = v;
  }
  ctx.putImageData(img, 0, 0);

  // Optional rough auto-rotate (portrait receipts)
  if (opts.autoRotate && H > W * 1.2) {
    const rot = new OffscreenCanvas(H, W);
    const rctx = rot.getContext('2d');
    rctx.translate(H / 2, W / 2);
    rctx.rotate(-Math.PI / 2);
    rctx.drawImage(off, -W / 2, -H / 2);
    return await rot.convertToBlob({ type: 'image/png', quality: 0.92 });
  }

  // Optional crop for tall images (preserve middle band)
  if (opts.cropTall && H > W * 1.5) {
    const ch = Math.floor(H * 0.7);
    const cy = Math.floor((H - ch) / 2);
    const crop = new OffscreenCanvas(W, ch);
    crop.getContext('2d').drawImage(off, 0, cy, W, ch, 0, 0, W, ch);
    return await crop.convertToBlob({ type: 'image/png', quality: 0.92 });
  }

  return await off.convertToBlob({ type: 'image/png', quality: 0.92 });
}

async function ensureImageData(input, pre = {}) {
  // Ensure ImageData for tesseract to avoid repeated decode
  const blob = input instanceof Blob ? input : await coerceToBlobOrImage({ blob: input });
  const bmp = await createImageBitmap(blob);
  const scale = pre.scale || 1.0;
  const W = Math.max(16, Math.floor(bmp.width * scale));
  const H = Math.max(16, Math.floor(bmp.height * scale));
  const off = new OffscreenCanvas(W, H);
  const ctx = off.getContext('2d');
  ctx.drawImage(bmp, 0, 0, W, H);
  return ctx.getImageData(0, 0, W, H);
}

async function coerceToBlobOrImage(frame) {
  if (frame.blob) return frame.blob;
  if (frame.arrayBuffer) return new Blob([frame.arrayBuffer]);
  if (frame.imageBitmap) {
    const off = new OffscreenCanvas(frame.imageBitmap.width, frame.imageBitmap.height);
    off.getContext('2d').drawImage(frame.imageBitmap, 0, 0);
    return await off.convertToBlob({ type: 'image/png', quality: 0.92 });
  }
  if (frame.url) { const res = await fetch(frame.url); return await res.blob(); }
  return new Blob();
}

/* ------------------------- PARSING & NORMALIZE ---------------------------- */

function parsePricebookText(text, { tsISO, storeId }) {
  const lines = (text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const items = [];
  const priceRe = /\$?\b(\d{1,3}(?:[.,]\d{2})?)\b/;
  const upcRe = /\b(\d{8,14})\b/;
  const sizeRe = /\b(\d+(?:\.\d+)?\s?(?:oz|ct|lb|lbs|gal|g|kg|pk|pack))\b/i;
  const dateRe = /\b(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\b/;

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const priceMatch = L.match(priceRe);
    if (!priceMatch) continue;

    const ctxWin = [lines[i - 1] || '', L, lines[i + 1] || ''].join(' • ');
    const upc = (ctxWin.match(upcRe) || [])[1] || null;
    const size = (ctxWin.match(sizeRe) || [])[1] || null;
    const rawDate = (ctxWin.match(dateRe) || [])[1] || null;

    const beforePrice = L.split(priceMatch[0])[0].trim();
    const { brand, name } = splitBrandName(beforePrice);

    const price = normalizePrice(priceMatch[1]);
    const unitPrice = extractUnitPrice(ctxWin);
    const dateISO = toISO(rawDate) || tsISO || nowISO();

    items.push({
      key: buildKey({ upc, brand, name }),
      upc, brand, name, size,
      price, unitPrice,
      dateISO,
      storeId: storeId || null,
      source: 'ocr',
    });
  }

  return { items };
}

function splitBrandName(s) {
  if (!s) return { brand: null, name: null };
  const tokens = s.split(/\s+/);
  if (tokens.length === 1) return { brand: null, name: s };
  const brand = /^[A-Z][A-Za-z0-9'’\-]+$/.test(tokens[0]) ? tokens[0] : null;
  const name = brand ? tokens.slice(1).join(' ') : s;
  return { brand, name };
}
function normalizePrice(p) { const s = String(p).replace(',', '.').replace('$', ''); const n = Number(s); return isFinite(n) ? Number(n.toFixed(2)) : null; }
function extractUnitPrice(s) { const m = s.match(/\$?\s?(\d+(?:\.\d{1,3})?)\s?\/\s?([a-z]{1,4})\b/i); return m ? { amount: Number(m[1]), per: m[2].toLowerCase() } : null; }
function buildKey({ upc, brand, name }) {
  if (upc) return `upc:${upc}`;
  const b = (brand || 'unknown').toLowerCase().replace(/\W+/g, '-').slice(0, 24);
  const n = (name || 'item').toLowerCase().replace(/\W+/g, '-').slice(0, 36);
  return `bn:${b}:${n}`;
}
function normalizeAndSummarize(items, { windowHint, storeId }) {
  const dedup = new Map();
  for (const it of items) {
    const k = `${it.key}|${(it.dateISO || '').slice(0,10)}`;
    if (!dedup.has(k)) dedup.set(k, it);
  }
  const collapsed = Array.from(dedup.values());
  return {
    items: collapsed,
    stats: {
      count: collapsed.length,
      window: inferWindow(collapsed, windowHint),
      storeId: storeId || null,
    }
  };
}
function inferWindow(items, hint) {
  if (hint?.startISO && hint?.endISO) return hint;
  if (!items.length) return { startISO: null, endISO: null };
  const dates = items.map(i => i.dateISO).filter(Boolean).sort();
  return { startISO: dates[0] || null, endISO: dates[dates.length - 1] || null };
}

/* --------------------------- CYCLE LEARNING ------------------------------- */

function learnCycles(items, { priceDropPct }) {
  const byKey = new Map();
  for (const it of items) {
    if (!byKey.has(it.key)) byKey.set(it.key, []);
    byKey.get(it.key).push(it);
  }
  const hints = [];
  for (const [key, arr] of byKey.entries()) {
    arr.sort((a,b)=> cmpISO(a.dateISO, b.dateISO));
    const points = [];
    for (let i=0;i<arr.length;i++){
      const p = arr[i].price; if (p == null) continue;
      const prevs = arr.slice(Math.max(0,i-2), i).map(x=>x.price).filter(isNum);
      if (!prevs.length) continue;
      const baseline = median(prevs);
      const dropPct = baseline>0 ? ((baseline - p)/baseline)*100 : 0;
      if (dropPct >= priceDropPct) points.push({ atISO: arr[i].dateISO });
    }
    if (points.length < state.thresholds.minFramesForCycle) continue;
    const gaps = [];
    for (let i=1;i<points.length;i++) gaps.push(daysBetween(points[i-1].atISO, points[i].atISO));
    const likelyCycleDays = roundToInt(robustCentral(gaps));
    const confidence = clamp01(points.length/(points.length+2));
    const lastPromo = points[points.length-1].atISO;
    hints.push({
      key, likelyCycleDays, confidence: Number(confidence.toFixed(2)),
      nextExpectedStartISO: addDaysISO(lastPromo, likelyCycleDays),
      window: { startISO: arr[0].dateISO, endISO: arr[arr.length-1].dateISO },
    });
  }
  return hints;
}

/* ------------------------------- GUARDS ---------------------------------- */

function guardNow() {
  if (state.config.sabbathGuard?.enabled) return true;
  if (state.config.quietHours?.enabled) return true;
  return false;
}
function guardReason() {
  if (state.config.sabbathGuard?.enabled) return 'sabbath';
  if (state.config.quietHours?.enabled) return 'quiet-hours';
  return 'guarded';
}

/* -------------------------------- JOBS ----------------------------------- */

function ensureJob(jobId, init = {}) {
  if (!state.jobs.has(jobId)) {
    state.jobs.set(jobId, {
      status: 'running',
      queue: [],
      results: [],
      meta: init.meta || {},
      seriesId: init.seriesId || null,
    });
  }
  return state.jobs.get(jobId);
}
function setJobStatus(jobId, st) { const j = state.jobs.get(jobId); if (j) j.status = st; }
function isCanceled(jobId) { return state.jobs.get(jobId)?.status === 'canceled'; }

/* ---------------------------- FAVORITES/SCHEDULE -------------------------- */

function buildSessionPayloadFromMeta(meta) {
  return {
    barcode: null,
    queryText: 'OCR series',
    storeFilter: meta.storeId || null,
    userZip: meta.zip || null,
    initialTab: 'compare',
    providerHints: {
      preferStores: meta.preferStores?.length ? meta.preferStores : (meta.storeId ? [meta.storeId] : undefined),
      zip: meta.zip || undefined,
    },
    _deeplink: { source: 'ocr.worker', at: nowISO() },
  };
}

/* -------------------------------- HELPERS -------------------------------- */

function ensureInit() { if (!state.inited) throw new Error('Worker not initialized. Send INIT first.'); }
function deepMerge(a, b){ const out={...a}; for (const k in b){ if (b[k] && typeof b[k]==='object' && !Array.isArray(b[k])) out[k]=deepMerge(a[k]||{}, b[k]); else out[k]=b[k]; } return out; }
function nowISO(){ return new Date().toISOString(); }
function toISO(s){ if (!s) return null; const d = new Date(s); return isFinite(d) ? d.toISOString() : null; }
function cmpISO(a,b){ return (a||'').localeCompare(b||''); }
function isNum(n){ return typeof n==='number' && isFinite(n); }
function median(arr){ const a=arr.slice().sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function robustCentral(arr){ const a=arr.slice().sort((x,y)=>x-y); const n=a.length; if(!n) return 0; const s=Math.floor(n*0.2), e=Math.ceil(n*0.8); const mid=a.slice(s,e); return median(mid.length?mid:a); }
function daysBetween(aISO,bISO){ const A=new Date(aISO).getTime(), B=new Date(bISO).getTime(); return Math.max(1, Math.round((B-A)/86400000)); }
function addDaysISO(aISO, days){ const t=new Date(aISO).getTime()+days*86400000; return new Date(t).toISOString().slice(0,10); }
function roundToInt(n){ return Math.max(1, Math.round(n||0)); }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function truthy(v){ return ['1','true','yes',true,1].includes(String(v).toLowerCase()); }
function yieldIfNeeded(){ return new Promise(r=>setTimeout(r,0)); }
async function safeClose(engine){ try { await engine?.close?.(); } catch {} }
