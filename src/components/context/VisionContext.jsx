// C:\Users\larho\suka-smart-assistant\src\components\context\VisionContext.jsx
// Centralized context for camera/vision pipelines: live scan, single image, batch queue.
// Routes normalized results to Importers / Inventory / Grocery / Mapping.
// ES2015-safe, dependency-light, and DI-friendly.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * DI contracts (all optional, safe no-ops if absent):
 * deps = {
 *   eventBus: { emit(evt,payload), on?(evt,cb), off?(evt,cb) },
 *   analytics: { track(evt,payload) },
 *   storage: { get(key), set(key,val) },
 *   settings: { get(path, fb) }, // expects sabbath guard, locale, piiMasking
 *   // Vision engines (synchronous or async; we call defensively):
 *   vision: {
 *     preprocess?(blob|url, opts): Promise<Blob|String>, // deskew/denoise/binarize
 *     barcode?: { decode(image): Promise<Array<{ symbology, text }>> },
 *     ocr?: { extract(image, opts?): Promise<{ text, blocks?:[], words?:[] }> },
 *     detect?: { labels(image): Promise<Array<{ name, score }>> }, // produce/leaf hints
 *     classify?: {
 *       product?(image): Promise<{ upc?:string, brand?:string, name?:string }>,
 *       leaf?(image): Promise<{ crop?:string, confidence?:number }>
 *     },
 *     careIcons?: { decode(image): Promise<Array<{ icon, meaning }>> }
 *   },
 *   // Routers/Stores:
 *   recipeImporter?: { importOne(url, opts?): Promise<any> },
 *   inventory?: {
 *     findByUPC?(upc): Promise<{ id, name, baseUnit, aisle }|null>,
 *     upsertFromLabel?(parsed): Promise<{ id, name }>,
 *     addItems?(items: Array<{name, qty, unit}>): void
 *   },
 *   grocery?: { addItems?(items): void },
 *   mapper?: { // quick entry to mapping flow
 *     suggestAll?(ingredients): any
 *   },
 *   // Utilities:
 *   urlDetect?: { firstUrl?(text): string|null },
 *   redact?: { pii?(text): string } // used when PII masking enabled
 * }
 */

const VisionContext = createContext(null);

function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Light PII guard
function applyMasking(text, enabled, redact) {
  if (!enabled || !text) return text;
  try { return (redact && redact.pii) ? redact.pii(text) : text.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "██@██.██"); } catch (_e) { return text; }
}

// Modes this context supports
const MODES = Object.freeze([
  "barcode",          // product UPC/EAN
  "recipe-page",      // capture a page → URL detect → importer
  "ocr-ingredients",  // scan ingredient lists → mapping
  "receipt",          // scan receipt → grocery/add items
  "pantry-label",     // OCR + classification to create SKU quickly
  "produce",          // produce/leaf hints (garden harvest)
  "cleaning-label",   // pull dwell time / safety from cleaning products
  "laundry-care"      // decode care icons
]);

// Result shape (normalized, superset)
function makeResult(partial) {
  return Object.assign({
    id: "vis-" + Math.random().toString(36).slice(2, 10),
    mode: "barcode",
    createdAtISO: new Date().toISOString(),
    status: "ok", // "ok" | "empty" | "error"
    insights: {}, // domain-specific goodies
    text: "",
    url: null,
    upc: null,
    items: [], // parsed items (for grocery/inventory)
    warnings: [],
    raw: {}
  }, partial || {});
}

export function VisionProvider({ children, deps = {} }) {
  const eventBus = deps.eventBus || { emit: function () {}, on: null, off: null };
  const analytics = deps.analytics || { track: function () {} };
  const storage = deps.storage || { get: function () { return null; }, set: function () {} };
  const settings = deps.settings || { get: function (_p, fb) { return fb; } };

  // Camera/live state
  const [mode, setMode] = useState("recipe-page");
  const [permission, setPermission] = useState("unknown"); // "unknown" | "granted" | "denied"
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  // Work queue supports batch scans or frames from live camera
  const [queue, setQueue] = useState([]); // [{ id, source: Blob|String|HTMLCanvas, mode }]
  const [results, setResults] = useState([]); // normalized makeResult()
  const [lastError, setLastError] = useState(null);

  // Live video refs (if you host a <video> and <canvas> in UI)
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const liveLoopRef = useRef(null);
  const streamRef = useRef(null);

  // ---------- camera controls -------------------------------------------------

  const requestPermission = useCallback(async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("MEDIA_UNAVAILABLE");
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      streamRef.current = s;
      setPermission("granted");
      return true;
    } catch (e) {
      setPermission("denied");
      setLastError(String(e && e.message) || "CAMERA_ERROR");
      return false;
    }
  }, []);

  const attachVideo = useCallback(async (videoEl) => {
    if (!videoEl) return false;
    if (streamRef.current) {
      videoEl.srcObject = streamRef.current;
      await videoEl.play().catch(function () {});
      return true;
    }
    return false;
  }, []);

  const startLive = useCallback(async (videoEl, modeName) => {
    if (modeName && MODES.indexOf(modeName) >= 0) setMode(modeName);
    setRunning(true);
    const ok = permission === "granted" || (await requestPermission());
    if (!ok) { setRunning(false); return false; }
    const attached = await attachVideo(videoEl || videoRef.current);
    if (!attached) { setRunning(false); return false; }

    // lightweight frame loop (1 fps for OCR/labels, 4+ for barcode)
    liveLoopRef.current = true;
    (async function loop() {
      while (liveLoopRef.current) {
        try {
          const fps = (mode === "barcode") ? 4 : 1;
          await captureFrameToQueue();
          await sleep(1000 / fps);
        } catch (_e) { /* ignore */ }
      }
    })();
    analytics.track("vision/live_start", { mode });
    return true;
  }, [attachVideo, permission, requestPermission, analytics, mode]);

  const stopLive = useCallback(() => {
    liveLoopRef.current = false;
    setRunning(false);
    analytics.track("vision/live_stop", {});
    return true;
  }, [analytics]);

  const captureFrameToQueue = useCallback(() => {
    try {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c || v.readyState < 2) return false;
      const w = v.videoWidth, h = v.videoHeight;
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(v, 0, 0, w, h);
      c.toBlob((blob) => {
        if (!blob) return;
        setQueue((q) => q.concat([{ id: "job-" + Math.random().toString(36).slice(2, 9), source: blob, mode }]));
      }, "image/jpeg", 0.85);
      return true;
    } catch (_e) { return false; }
  }, [mode]);

  // ---------- ingestion (files, urls, clipboard) -----------------------------

  const addImage = useCallback((blobOrUrl, modeName) => {
    const m = modeName && MODES.indexOf(modeName) >= 0 ? modeName : mode;
    setQueue((q) => q.concat([{ id: "job-" + Math.random().toString(36).slice(2, 9), source: blobOrUrl, mode: m }]));
    return true;
  }, [mode]);

  const addMany = useCallback((list, modeName) => {
    const m = modeName && MODES.indexOf(modeName) >= 0 ? modeName : mode;
    const jobs = (list || []).map((src) => ({ id: "job-" + Math.random().toString(36).slice(2, 9), source: src, mode: m }));
    setQueue((q) => q.concat(jobs));
    return jobs.length;
  }, [mode]);

  // ---------- pipeline runner -------------------------------------------------

  const preprocess = useCallback(async (img) => {
    try { return deps.vision && deps.vision.preprocess ? await deps.vision.preprocess(img, { denoise: true, deskew: true }) : img; }
    catch (_e) { return img; }
  }, [deps.vision]);

  const runBarcode = useCallback(async (img) => {
    try {
      if (!deps.vision || !deps.vision.barcode || !deps.vision.barcode.decode) return null;
      const hits = await deps.vision.barcode.decode(img);
      if (!hits || !hits.length) return null;
      return hits[0].text || null;
    } catch (_e) { return null; }
  }, [deps.vision]);

  const runOCR = useCallback(async (img, opts = {}) => {
    try {
      if (!deps.vision || !deps.vision.ocr || !deps.vision.ocr.extract) return { text: "" };
      return await deps.vision.ocr.extract(img, opts);
    } catch (_e) { return { text: "" }; }
  }, [deps.vision]);

  const runLabels = useCallback(async (img) => {
    try {
      if (!deps.vision || !deps.vision.detect || !deps.vision.detect.labels) return [];
      return await deps.vision.detect.labels(img);
    } catch (_e) { return []; }
  }, [deps.vision]);

  const runCareIcons = useCallback(async (img) => {
    try {
      if (!deps.vision || !deps.vision.careIcons || !deps.vision.careIcons.decode) return [];
      return await deps.vision.careIcons.decode(img);
    } catch (_e) { return []; }
  }, [deps.vision]);

  // Domain routers -------------------------------------------------------------

  async function handleRecipePage(ocrRes) {
    const piiMask = settings.get && settings.get("privacy.piiMasking", true);
    const text = applyMasking(ocrRes.text || "", piiMask, deps.redact);
    let url = null;
    try { url = deps.urlDetect && deps.urlDetect.firstUrl ? deps.urlDetect.firstUrl(text) : null; } catch (_e) {}
    if (url && deps.recipeImporter && deps.recipeImporter.importOne) {
      try {
        eventBus.emit("recipe:import:requested", { url, source: "vision" });
        const state = await deps.recipeImporter.importOne(url, { autoSave: true });
        eventBus.emit("recipe:import:done", { url, state });
        analytics.track("vision/recipe_import_url", { ok: true });
        return makeResult({ mode: "recipe-page", status: "ok", url, text, insights: { detectedUrl: true }, raw: ocrRes });
      } catch (e) {
        analytics.track("vision/recipe_import_url", { ok: false });
        return makeResult({ mode: "recipe-page", status: "error", url, text, warnings: [String(e && e.message || e)], raw: ocrRes });
      }
    }
    return makeResult({ mode: "recipe-page", status: url ? "ok" : "empty", url: url || null, text, raw: ocrRes });
  }

  async function handleIngredientsOCR(ocrRes) {
    const piiMask = settings.get && settings.get("privacy.piiMasking", true);
    const text = applyMasking(ocrRes.text || "", piiMask, deps.redact);
    // naive split; your mapper DI can do better tokenization
    const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const ingredients = lines
      .filter((ln) => !/^nutrition facts|^contains[:]/i.test(ln))
      .map((ln) => ({ name: ln }));
    try {
      if (deps.mapper && deps.mapper.suggestAll && ingredients.length) {
        deps.mapper.suggestAll(ingredients);
        eventBus.emit("ingredient:mapping:prompt", { count: ingredients.length, source: "vision" });
      }
    } catch (_e) {}
    return makeResult({ mode: "ocr-ingredients", status: ingredients.length ? "ok" : "empty", text, insights: { count: ingredients.length }, raw: ocrRes });
  }

  async function handleReceipt(ocrRes) {
    const piiMask = settings.get && settings.get("privacy.piiMasking", true);
    const text = applyMasking(ocrRes.text || "", piiMask, deps.redact);
    // crude line item parse: words + quantities
    const items = text
      .split(/\n+/)
      .map((ln) => ln.replace(/[^A-Za-z0-9 .-]/g, "").trim())
      .filter((ln) => ln && /\b[A-Za-z]/.test(ln))
      .slice(0, 40) // keep sane
      .map((name) => ({ name, qty: 1, unit: "" }));
    try {
      if (deps.grocery && deps.grocery.addItems && items.length) deps.grocery.addItems(items);
      eventBus.emit("grocery:receipt:parsed", { count: items.length, source: "vision" });
    } catch (_e) {}
    return makeResult({ mode: "receipt", status: items.length ? "ok" : "empty", text, items, raw: ocrRes });
  }

  async function handleBarcode(img) {
    const upc = await runBarcode(img);
    if (!upc) return makeResult({ mode: "barcode", status: "empty" });
    let sku = null;
    try { sku = deps.inventory && deps.inventory.findByUPC ? await deps.inventory.findByUPC(upc) : null; } catch (_e) {}
    if (sku) {
      eventBus.emit("inventory:barcode:match", { upc, sku });
      return makeResult({ mode: "barcode", status: "ok", upc, insights: { sku }, raw: { upc } });
    }
    // fallback: try product classify or prompt quick-create
    let prod = null;
    try { prod = deps.vision && deps.vision.classify && deps.vision.classify.product ? await deps.vision.classify.product(img) : null; } catch (_e) {}
    return makeResult({ mode: "barcode", status: "ok", upc, insights: { suggested: prod }, raw: { upc, prod } });
  }

  async function handlePantryLabel(img) {
    const ocr = await runOCR(img, { hint: "label" });
    const labels = await runLabels(img);
    const text = ocr.text || "";
    let created = null;
    try {
      if (deps.inventory && deps.inventory.upsertFromLabel) {
        created = await deps.inventory.upsertFromLabel({
          text,
          labels,
        });
        eventBus.emit("inventory:label:upsert", { id: created && created.id });
      }
    } catch (_e) {}
    return makeResult({ mode: "pantry-label", status: "ok", text, insights: { labels, created }, raw: { ocr, labels } });
  }

  async function handleProduce(img) {
    // Garden/produce hint: try classifier.leaf first
    let leaf = null, labels = [];
    try { leaf = deps.vision && deps.vision.classify && deps.vision.classify.leaf ? await deps.vision.classify.leaf(img) : null; } catch (_e) {}
    try { labels = await runLabels(img); } catch (_e) {}
    return makeResult({ mode: "produce", status: (leaf || labels.length) ? "ok" : "empty", insights: { leaf, labels }, raw: { leaf, labels } });
  }

  async function handleCleaningLabel(img) {
    const ocr = await runOCR(img, { hint: "safety" });
    const text = ocr.text || "";
    // naive extraction of dwell and hazards
    const dwellM = (function () {
      const m = text.match(/dwell(?:\s*time)?\s*[:\-]?\s*(\d{1,3})\s*(min|minutes)?/i);
      return m ? Number(m[1]) : null;
    })();
    const hazards = [];
    if (/bleach/i.test(text)) hazards.push("bleach");
    if (/ammonia/i.test(text)) hazards.push("ammonia");
    if (/acid/i.test(text)) hazards.push("acid");
    eventBus.emit("cleaning:label:parsed", { dwellM, hazards });
    return makeResult({ mode: "cleaning-label", status: "ok", text, insights: { dwellM, hazards }, raw: ocr });
  }

  async function handleLaundryCare(img) {
    const icons = await runCareIcons(img);
    return makeResult({ mode: "laundry-care", status: icons.length ? "ok" : "empty", insights: { icons }, raw: { icons } });
  }

  // ---------- main worker: process next job ----------------------------------

  const processNext = useCallback(async () => {
    if (busy) return false;
    setBusy(true);
    let job = null;
    try {
      job = queue[0];
      if (!job) { setBusy(false); return false; }
      // shift queue
      setQueue((q) => q.slice(1));
      const pre = await preprocess(job.source);
      let res = null;

      switch (job.mode) {
        case "barcode":          res = await handleBarcode(pre); break;
        case "recipe-page":      res = await handleRecipePage(await runOCR(pre, { hint: "url" })); break;
        case "ocr-ingredients":  res = await handleIngredientsOCR(await runOCR(pre, { hint: "ingredients" })); break;
        case "receipt":          res = await handleReceipt(await runOCR(pre, { hint: "receipt" })); break;
        case "pantry-label":     res = await handlePantryLabel(pre); break;
        case "produce":          res = await handleProduce(pre); break;
        case "cleaning-label":   res = await handleCleaningLabel(pre); break;
        case "laundry-care":     res = await handleLaundryCare(pre); break;
        default:                 res = makeResult({ mode: job.mode, status: "error", warnings: ["Unknown mode"] });
      }

      setResults((r) => [res].concat(r).slice(0, 100));
      // Emit to orchestration / nudges
      try {
        eventBus.emit("vision:result", { mode: res.mode, status: res.status, id: res.id, insights: res.insights });
        analytics.track("vision/result", { mode: res.mode, status: res.status });
      } catch (_e) {}
    } catch (e) {
      setLastError(String(e && e.message) || "PROCESS_ERROR");
    } finally {
      setBusy(false);
    }
    return true;
  }, [
    busy,
    queue,
    preprocess,
    handleBarcode,
    handleRecipePage,
    runOCR,
    handleIngredientsOCR,
    handleReceipt,
    handlePantryLabel,
    handleProduce,
    handleCleaningLabel,
    handleLaundryCare,
    eventBus,
    analytics
  ]);

  // Auto-run when queue has items
  useEffect(() => {
    if (!queue.length || busy) return;
    processNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, busy]);

  // ---------- persistence (last mode + small cache of results) ----------------

  useEffect(() => {
    try { storage.set("suka:vision:lastMode", mode); } catch (_e) {}
  }, [mode, storage]);
  useEffect(() => {
    const save = debounce((arr) => {
      try { storage.set("suka:vision:lastResults", JSON.stringify(arr.slice(0, 10))); } catch (_e) {}
    }, 800);
    save(results);
  }, [results, storage]);

  useEffect(() => {
    // rehydrate last mode/results
    try {
      const m = storage.get("suka:vision:lastMode");
      if (m && MODES.indexOf(m) >= 0) setMode(m);
      const raw = storage.get("suka:vision:lastResults");
      if (raw) setResults(() => {
        try { return JSON.parse(raw) || []; } catch (_e) { return []; }
      });
    } catch (_e) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- convenience actions for UI -------------------------------------

  const clearResults = useCallback(() => setResults([]), []);
  const clearQueue = useCallback(() => setQueue([]), []);

  const reroute = useCallback((res, target) => {
    // Allows a user to tap a result card and send it somewhere else (inspired by well-executed apps).
    try {
      if (!res) return false;
      switch (target) {
        case "grocery":
          if (deps.grocery && deps.grocery.addItems && res.items && res.items.length) {
            deps.grocery.addItems(res.items);
            eventBus.emit("grocery:items:added", { count: res.items.length, source: "vision" });
            return true;
          }
          break;
        case "mapper":
          if (deps.mapper && deps.mapper.suggestAll && res.text) {
            const lines = res.text.split(/\n+/).map((s) => s.trim()).filter(Boolean).map((name) => ({ name }));
            deps.mapper.suggestAll(lines);
            eventBus.emit("ingredient:mapping:prompt", { count: lines.length, source: "vision" });
            return true;
          }
          break;
        case "inventory":
          if (deps.inventory && deps.inventory.addItems && res.items && res.items.length) {
            deps.inventory.addItems(res.items);
            eventBus.emit("inventory:items:added", { count: res.items.length, source: "vision" });
            return true;
          }
          break;
        default:
          eventBus.emit("ui:action", { action: "vision:reroute", to: target, res });
          return true;
      }
    } catch (_e) {}
    return false;
  }, [deps.grocery, deps.mapper, deps.inventory, eventBus]);

  // ---------- context value ---------------------------------------------------

  const value = useMemo(() => ({
    // camera refs — wire these to your Vision UI component
    videoRef,
    canvasRef,
    // settings / state
    mode, setMode,
    running, permission, busy,
    queue, results, lastError,
    // camera/live
    requestPermission,
    attachVideo,
    startLive,
    stopLive,
    captureFrameToQueue,
    // ingestion
    addImage,
    addMany,
    clearQueue,
    // results
    clearResults,
    reroute,
  }), [
    mode, running, permission, busy, queue, results, lastError,
    requestPermission, attachVideo, startLive, stopLive,
    captureFrameToQueue, addImage, addMany, clearQueue, clearResults, reroute
  ]);

  return <VisionContext.Provider value={value}>{children}</VisionContext.Provider>;
}

export function useVision() {
  const ctx = useContext(VisionContext);
  if (!ctx) throw new Error("useVision must be used within a VisionProvider");
  return ctx;
}
