/* eslint-disable no-console */
// src/features/scan-compare-trust/stores/useScanQueue.js
// Offline Scan Queue (image + metadata) with auto-sync, retries, and favorites.
//
// Fits Scan • Compare • Trust pipeline:
//   enqueue -> orchestrator(processor) => resolve → safety → pricing → coupons
//
// Notes
// - Dexie optional. If available, we store blobs in IDB; otherwise we base64 them.
// - Emits eventBus events so ScanSheet/SourceAttribution and orchestration can react.
// - Auto-syncs on connectivity restore and periodic heartbeat.
// - Supports "favorite session" flag so users can save & re-run later.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* -------------------------------- safe deps -------------------------------- */
let eventBus = { emit(){}, on(){}, off(){} };
try { const eb = require("@/services/eventBus"); eventBus = (eb?.default||eb?.eventBus||eb)||eventBus; } catch (_e) {}

let DexieDB = null;
try { DexieDB = require("@/db")?.default || require("@/db"); } catch (_e) {}

let useQuietHours = () => ({ enabled:false });
try { useQuietHours = require("@/hooks/useQuietHours")?.default || useQuietHours; } catch (_e) {}

let toast = null;
try { toast = (require("@/components/toast")?.toast) || null; } catch (_e) {}

let nanoid = (len=8) => Math.random().toString(36).slice(2, 2+len);
try { nanoid = require("nanoid").nanoid || nanoid; } catch (_e) {}

/* --------------------------------- helpers --------------------------------- */
const nowISO = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isOnline = () => (typeof navigator !== "undefined" ? navigator.onLine : true);
const KB = 1024; const MB = KB * KB;

async function blobToBase64(blob) {
  if (!blob) return null;
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onloadend = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
async function base64ToBlob(dataUrl) {
  if (!dataUrl) return null;
  const [meta, b64] = dataUrl.split(",");
  const mime = (meta.match(/data:(.*);base64/)||[])[1] || "application/octet-stream";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* ------------------------------- local cache -------------------------------- */
const mem = new Map(); // id->item snapshot (for quick reads)
const LS_KEY = "scanQueue:v1";

function lsLoad() {
  try { const v = localStorage.getItem(LS_KEY); return v ? JSON.parse(v) : []; } catch { return []; }
}
function lsSave(rows) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(rows)); } catch {}
}

/* ------------------------------ Dexie helpers ------------------------------ */
// Expected (optional) tables:
// - DexieDB.scanQueue: { id, status, retryCount, sessionId, favoriteSession, createdISO, updatedISO, meta{}, imageRef{type:"idb"|"base64", key}, lastError? }
// - DexieDB.scanBlobs:  { id, blob }
// - DexieDB.scanResults:{ id, queueId, result, createdAt }

async function idbPutQueue(row) {
  if (!DexieDB?.scanQueue) return null;
  try { await DexieDB.scanQueue.put(row); return row.id; } catch { return null; }
}
async function idbGetQueueAll(limit=500) {
  if (!DexieDB?.scanQueue) return null;
  try { return await DexieDB.scanQueue.orderBy("createdISO").reverse().limit(limit).toArray(); } catch { return null; }
}
async function idbDeleteQueue(id) {
  if (!DexieDB?.scanQueue) return;
  try { await DexieDB.scanQueue.delete(id); } catch {}
}
async function idbPutBlob(id, blob) {
  if (!DexieDB?.scanBlobs) return false;
  try { await DexieDB.scanBlobs.put({ id, blob }); return true; } catch { return false; }
}
async function idbGetBlob(id) {
  if (!DexieDB?.scanBlobs) return null;
  try { const row = await DexieDB.scanBlobs.get(id); return row?.blob || null; } catch { return null; }
}
async function idbDelBlob(id) {
  if (!DexieDB?.scanBlobs) return;
  try { await DexieDB.scanBlobs.delete(id); } catch {}
}
async function idbPutResult(queueId, result) {
  if (!DexieDB?.scanResults) return;
  try { await DexieDB.scanResults.put({ id: `${queueId}`, queueId, result, createdAt: Date.now() }); } catch {}
}

/* -------------------------- queue item definition -------------------------- */
// status: queued | processing | success | error | canceled
function createQueueRow({ image, meta, sessionId, favoriteSession }) {
  const id = `${Date.now()}-${nanoid(6)}`;
  return {
    id,
    status: "queued",
    retryCount: 0,
    sessionId: sessionId || null,
    favoriteSession: !!favoriteSession,
    createdISO: nowISO(),
    updatedISO: nowISO(),
    meta: {
      // suggested metadata fields, fill what you have; all optional
      upc: meta?.upc || null,
      store: meta?.store || null,
      brand: meta?.brand || null,
      category: meta?.category || null,
      capture: meta?.capture || "camera", // camera|upload|zxing
      geohash: meta?.geohash || null,
      notes: meta?.notes || null,
      // hash can help dedupe
      fingerprint: meta?.fingerprint || null,
      // link scans into a "session" the user can favorite/save
      sessionLabel: meta?.sessionLabel || null,
    },
    imageRef: { type: "ephemeral", key: null }, // will be filled by persistImage()
    lastError: null,
  };
}

/* ----------------------------- persistence core ---------------------------- */
async function persistImage(row, image) {
  // Prefer Dexie blob if available, else base64 in LS (watch sizes).
  if (DexieDB?.scanBlobs && image instanceof Blob) {
    const ok = await idbPutBlob(row.id, image);
    if (ok) {
      row.imageRef = { type: "idb", key: row.id };
      return row;
    }
  }
  // fallback to base64 (avoid huge images)
  try {
    let dataUrl = typeof image === "string" && image.startsWith("data:")
      ? image
      : await blobToBase64(image);
    if (!dataUrl) throw new Error("image to base64 failed");
    // soft limit ~2.5MB for base64 strings in LS
    if (dataUrl.length > 2.5 * MB) {
      // attempt a last-ditch compression via canvas (optional; omitted for dep-light)
      // as a safe fallback, keep a stub and mark as not persisted fully
      row.imageRef = { type: "base64", key: dataUrl.slice(0, 256*KB) }; // cap
    } else {
      row.imageRef = { type: "base64", key: dataUrl };
    }
    return row;
  } catch (e) {
    row.imageRef = { type: "none", key: null };
    row.lastError = String(e);
    return row;
  }
}

async function materializeImage(imageRef) {
  if (!imageRef) return null;
  if (imageRef.type === "idb") return await idbGetBlob(imageRef.key);
  if (imageRef.type === "base64") return await base64ToBlob(imageRef.key);
  return null;
}

/* ------------------------------ orchestrator ------------------------------- */
// External processor is the Scan → Compare → Trust pipeline. We inject it.
let globalProcessor = null; // (row, blob) => Promise<{ ok, result }>

export function setScanProcessor(fn) {
  globalProcessor = typeof fn === "function" ? fn : null;
}

/* ------------------------------ Reactive hook ------------------------------ */
/**
 * useScanQueue(opts)
 * opts: {
 *   maxRetries=3, backoffMs=1500..9000, heartbeatMs=30000,
 *   autoSync=true, concurrency=1
 * }
 *
 * returns {
 *   items, pendingCount, syncing, enqueue, updateMeta, remove, purge,
 *   markFavoriteSession, unmarkFavoriteSession,
 *   syncNow, exportQueue, importQueue, getImageBlob
 * }
 */
export default function useScanQueue(opts = {}) {
  const {
    maxRetries = 3,
    backoffMin = 1500,
    backoffMax = 9000,
    heartbeatMs = 30000,
    autoSync = true,
    concurrency = 1,
  } = opts;

  const { enabled: quietHours } = useQuietHours();
  const [items, setItems] = useState(() => bootstrapLoad());
  const [syncing, setSyncing] = useState(false);

  // keep mem in sync
  useEffect(() => { for (const it of items) mem.set(it.id, it); }, [items]);

  // online/visibility triggers
  useEffect(() => {
    const go = () => autoSync && trySync("online");
    const vis = () => autoSync && !document.hidden && trySync("visible");
    window.addEventListener?.("online", go);
    document.addEventListener?.("visibilitychange", vis);
    return () => {
      window.removeEventListener?.("online", go);
      document.removeEventListener?.("visibilitychange", vis);
    };
  }, [autoSync]);

  // periodic heartbeat
  useEffect(() => {
    if (!autoSync) return;
    const t = setInterval(() => trySync("heartbeat"), clamp(heartbeatMs, 5000, 120000));
    return () => clearInterval(t);
  }, [autoSync, heartbeatMs]);

  const pendingCount = useMemo(() => items.filter(x => x.status === "queued" || x.status === "error").length, [items]);

  /** enqueue(image: Blob|File|dataURL|string, meta: object, {sessionId, favoriteSession}) */
  const enqueue = useCallback(async (image, meta = {}, extras = {}) => {
    const row = createQueueRow({ image, meta, sessionId: extras.sessionId, favoriteSession: extras.favoriteSession });
    const saved = await persistImage(row, image);
    saved.updatedISO = nowISO();

    // write to IDB if present
    if (DexieDB?.scanQueue) await idbPutQueue(saved);

    // sync LS shadow for quick reloads
    const updated = [saved, ...items];
    setItems(updated);
    lsSave(updated);

    eventBus.emit("scanqueue:enqueue", { id: saved.id, meta: saved.meta, sessionId: saved.sessionId });
    if (!quietHours && toast) toast("Added to scan queue.");
    return saved.id;
  }, [items, quietHours]);

  const updateMeta = useCallback(async (id, patch = {}) => {
    const next = items.map(it => it.id === id ? ({ ...it, meta: { ...it.meta, ...patch }, updatedISO: nowISO() }) : it);
    setItems(next); lsSave(next);
    const it = next.find(x => x.id === id);
    if (DexieDB?.scanQueue && it) await idbPutQueue(it);
    eventBus.emit("scanqueue:item:updated", { id, meta: patch });
  }, [items]);

  const remove = useCallback(async (id) => {
    const it = items.find(x => x.id === id);
    if (!it) return;
    const next = items.filter(x => x.id !== id);
    setItems(next); lsSave(next);
    if (DexieDB?.scanQueue) await idbDeleteQueue(id);
    if (it?.imageRef?.type === "idb") await idbDelBlob(it.imageRef.key);
    eventBus.emit("scanqueue:item:removed", { id });
  }, [items]);

  const purge = useCallback(async (onlySucceeded=false) => {
    let rows = items;
    if (onlySucceeded) rows = rows.filter(x => x.status !== "success");
    // delete removed ones from storage
    const keep = new Set(rows.map(r => r.id));
    const prev = items;
    for (const it of prev) {
      if (!keep.has(it.id)) {
        if (DexieDB?.scanQueue) await idbDeleteQueue(it.id);
        if (it?.imageRef?.type === "idb") await idbDelBlob(it.imageRef.key);
      }
    }
    setItems(rows); lsSave(rows);
    eventBus.emit("scanqueue:purge", { onlySucceeded });
  }, [items]);

  const markFavoriteSession = useCallback(async (sessionId, flag=true) => {
    const next = items.map(it => it.sessionId === sessionId ? ({ ...it, favoriteSession: !!flag, updatedISO: nowISO() }) : it);
    setItems(next); lsSave(next);
    if (DexieDB?.scanQueue) {
      for (const it of next.filter(i => i.sessionId === sessionId)) await idbPutQueue(it);
    }
    eventBus.emit("scanqueue:session:favorite", { sessionId, favorite: !!flag });
    if (!quietHours && toast) toast(flag ? "Session saved to favorites." : "Session removed from favorites.");
  }, [items, quietHours]);

  const unmarkFavoriteSession = useCallback(async (sessionId) => markFavoriteSession(sessionId, false), [markFavoriteSession]);

  const getImageBlob = useCallback(async (id) => {
    const it = items.find(x => x.id === id);
    if (!it) return null;
    return await materializeImage(it.imageRef);
  }, [items]);

  const syncNow = useCallback(() => trySync("manual"), []);

  /* ------------------------------ sync engine ------------------------------ */
  const inflight = useRef(0);
  const trySync = useCallback(async (reason) => {
    if (!globalProcessor) return;            // nothing to do yet
    if (!isOnline()) return;                 // stay quiet offline
    if (syncing) return;                     // avoid parallel sync waves

    setSyncing(true);
    eventBus.emit("scanqueue:sync:start", { reason });

    try {
      // Work list: queued + retryable errors
      const work = items
        .filter(x => (x.status === "queued") || (x.status === "error" && x.retryCount < maxRetries))
        .sort((a,b) => (Date.parse(a.createdISO) - Date.parse(b.createdISO))); // FIFO

      if (!work.length) {
        setSyncing(false);
        eventBus.emit("scanqueue:sync:noop", { reason });
        return;
      }

      let idx = 0;
      const nextState = new Map(items.map(i => [i.id, { ...i }]));

      const runOne = async (row) => {
        const local = nextState.get(row.id);
        if (!local) return;

        local.status = "processing";
        local.updatedISO = nowISO();
        eventBus.emit("scanqueue:item:processing", { id: local.id });

        // persist status change
        await persistRow(local);

        const blob = await materializeImage(local.imageRef);
        try {
          const out = await globalProcessor(local, blob);
          if (out?.ok) {
            local.status = "success";
            local.retryCount = 0;
            local.lastError = null;
            local.updatedISO = nowISO();
            await persistRow(local);
            await idbPutResult(local.id, out.result);
            eventBus.emit("scanqueue:item:success", { id: local.id, result: out.result });

            // optional toasts
            if (!quietHours && toast) toast("Scan processed.");
          } else {
            throw new Error(out?.error || "processor returned !ok");
          }
        } catch (e) {
          local.status = "error";
          local.retryCount = (local.retryCount || 0) + 1;
          local.lastError = String(e);
          local.updatedISO = nowISO();
          await persistRow(local);
          eventBus.emit("scanqueue:item:error", { id: local.id, error: local.lastError });

          // backoff
          const wait = clamp(Math.round(backoffMin * Math.pow(1.6, local.retryCount)), backoffMin, backoffMax);
          await sleep(wait);
        }
      };

      const workers = Array.from({ length: clamp(concurrency, 1, 3) }, async () => {
        while (idx < work.length) {
          // pick next
          const pos = idx++;
          const row = work[pos];
          inflight.current++;
          try { await runOne(row); } finally { inflight.current--; }
        }
      });

      await Promise.all(workers);

      // Commit in-memory snapshot -> React state
      const merged = items.map(it => nextState.get(it.id) || it);
      setItems(merged);
      lsSave(merged);

      const remaining = merged.filter(x => x.status !== "success").length;
      if (remaining === 0) eventBus.emit("scanqueue:drain", {});
      eventBus.emit("scanqueue:sync:done", { reason, remaining });
    } finally {
      setSyncing(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, syncing, maxRetries, backoffMin, backoffMax, concurrency, quietHours]);

  // respond when new processor attaches
  useEffect(() => {
    const onAttach = () => autoSync && trySync("processor-attached");
    eventBus.on?.("scanqueue:processor:attached", onAttach);
    return () => eventBus.off?.("scanqueue:processor:attached", onAttach);
  }, [autoSync, trySync]);

  return {
    items,
    pendingCount,
    syncing,
    enqueue,
    updateMeta,
    remove,
    purge,
    markFavoriteSession,
    unmarkFavoriteSession,
    syncNow,
    exportQueue: () => exportQueue(items),
    importQueue: async (payload) => {
      const merged = await importQueue(payload, items);
      setItems(merged); lsSave(merged);
      return merged.length;
    },
    getImageBlob,
  };
}

/* ----------------------------- private helpers ----------------------------- */
function bootstrapLoad() {
  // Prefer IDB snapshot; else LS
  if (DexieDB?.scanQueue) {
    // We’ll opportunistically hydrate from IDB on first tick
    idbGetQueueAll().then(rows => {
      if (rows && rows.length) {
        // merge into state via event (hook instance will have setItems closure)
        eventBus.emit("scanqueue:bootstrap", { rows });
      }
    });
  }
  // initial LS shadow (fast paint)
  const ls = lsLoad() || [];
  return ls;
}

async function persistRow(row) {
  if (DexieDB?.scanQueue) await idbPutQueue(row);
  // keep LS mirror small & current
  const snapshot = Array.from(mem.values());
  const idx = snapshot.findIndex(x => x.id === row.id);
  if (idx >= 0) snapshot[idx] = row; else snapshot.unshift(row);
  lsSave(snapshot);
}

/* hydrate state if IDB returns rows after mount */
(function subscribeBootstrapOnce(){
  let applied = false;
  eventBus.on?.("scanqueue:bootstrap", ({ rows }) => {
    if (applied) return;
    applied = true;
    try {
      // reconcile LS + IDB: prefer newest updatedISO per id
      const ls = lsLoad() || [];
      const map = new Map();
      for (const r of [...ls, ...rows]) {
        const prev = map.get(r.id);
        if (!prev || Date.parse(r.updatedISO||0) < Date.parse(r.updatedISO||0)) {
          map.set(r.id, r);
        }
      }
      const merged = Array.from(map.values()).sort((a,b)=>Date.parse(b.createdISO)-Date.parse(a.createdISO));
      lsSave(merged);
      eventBus.emit("scanqueue:bootstrap:applied", { count: merged.length });
    } catch (e) {
      console.warn("scanqueue bootstrap merge error", e);
    }
  });
})();

/* ------------------------- export / import utilities ------------------------ */
// Exports queue metadata + base64 images (if idb blobs exist, we include a base64)
async function exportQueue(rows = []) {
  const out = [];
  for (const r of rows) {
    let imageBase64 = null;
    try {
      const blob = await materializeImage(r.imageRef);
      imageBase64 = blob ? await blobToBase64(blob) : null;
    } catch { imageBase64 = null; }
    out.push({
      ...r,
      imageRef: { type: "export", key: null },
      imageBase64,
    });
  }
  const payload = { version: 1, exportedAt: nowISO(), rows: out };
  return payload;
}

async function importQueue(payload, existing = []) {
  if (!payload?.rows) return existing;
  const incoming = [];
  for (const r of payload.rows) {
    const clone = { ...r, imageRef: { type: "none", key: null } };
    // restore image
    if (r.imageBase64) {
      const blob = await base64ToBlob(r.imageBase64);
      if (blob && DexieDB?.scanBlobs) {
        await idbPutBlob(r.id, blob);
        clone.imageRef = { type: "idb", key: r.id };
      } else {
        clone.imageRef = { type: "base64", key: r.imageBase64 };
      }
    }
    // persist queue row
    await persistRow(clone);
    if (DexieDB?.scanQueue) await idbPutQueue(clone);
    incoming.push(clone);
  }
  // merge with existing by newest updatedISO
  const byId = new Map();
  for (const r of [...existing, ...incoming]) {
    const prev = byId.get(r.id);
    if (!prev || Date.parse(prev.updatedISO||0) < Date.parse(r.updatedISO||0)) byId.set(r.id, r);
  }
  const merged = Array.from(byId.values()).sort((a,b)=>Date.parse(b.createdISO)-Date.parse(a.createdISO));
  return merged;
}

/* ------------------------------- public events ------------------------------ */
// Processor integrators should call setScanProcessor(fn) and then:
export function announceProcessorAttached() {
  eventBus.emit("scanqueue:processor:attached", {});
}
