// File: src/services/imports/UploadIngestService.js
/**
 * UploadIngestService (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Unified ingest pipeline for user uploads (files / blobs / URLs) into SSA's
 *    Layer Spine:
 *      L0: artifacts            (raw uploads + metadata)
 *      L1: parsed_candidates    (extracted fields / candidate facts)
 *      L1.5: parse_cache        (optional fingerprints to skip repeat work)
 *
 *  - Routes artifacts to parsers via ImportRouter (best-effort).
 *
 * Design Goals
 *  - Browser-safe (no Node imports).
 *  - Dexie-optional: uses db tables if they exist; otherwise uses local fallback.
 *  - Idempotent: fingerprints + cache to avoid re-ingesting the same file.
 *  - Progressive: supports progress callbacks and AbortController.
 *  - Tolerant of evolving schemas: probes for table existence and writes only
 *    safe, common fields.
 *
 * Expected Optional Modules
 *  - db:         "@/services/db" exporting { db } (Dexie)
 *  - eventBus:   "@/services/events/eventBus" exporting { eventBus }
 *  - ImportRouter:"@/services/imports/ImportRouter" exporting routeArtifact()
 *
 * -----------------------------------------------------------------------------
 * Public API
 *  - ingestFile(file, options)
 *  - ingestFiles(files, options)
 *  - ingestBlob(blob, options)
 *  - ingestFromUrl(url, options)  (best-effort fetch)
 *  - routeAndParse(artifact, options) (explicit parse pass)
 *
 * Notes
 *  - We DO store blobs in Dexie artifacts when possible.
 *  - If no Dexie artifacts table exists, we store metadata to localStorage and
 *    keep blobs in an in-memory map for the lifetime of the tab.
 *  - PDF/image parsing is NOT performed here (no heavy libs). We store the raw
 *    artifact and let downstream parsers handle it (or mark as "needsParser").
 */

const SOURCE = "imports.UploadIngestService";
const LS_KEY = "SSA.UploadIngestService.v1";
const MAX_TEXT_PREVIEW_BYTES = 300_000; // ~300KB
const DEFAULT_TIMEOUT_MS = 45_000;

/* -------------------------------- Utilities -------------------------------- */

function nowISO() {
  return new Date().toISOString();
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeParseJSON(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function stableUnique(arr) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    if (v == null) continue;
    const s = String(v);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function createId(prefix = "art") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function normalizeISO(maybeISO) {
  if (!maybeISO) return undefined;
  const d = new Date(maybeISO);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function guessMimeFromName(name) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".json")) return "application/json";
  if (n.endsWith(".csv")) return "text/csv";
  if (n.endsWith(".tsv")) return "text/tab-separated-values";
  if (n.endsWith(".txt")) return "text/plain";
  if (n.endsWith(".md")) return "text/markdown";
  if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
  if (n.endsWith(".xml")) return "application/xml";
  if (n.endsWith(".yaml") || n.endsWith(".yml")) return "text/yaml";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".heic")) return "image/heic";
  if (n.endsWith(".zip")) return "application/zip";
  return "";
}

function classifyKind(mime, name) {
  const m = String(mime || "").toLowerCase();
  const n = String(name || "").toLowerCase();

  if (m.includes("pdf") || n.endsWith(".pdf")) return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.includes("json") || n.endsWith(".json")) return "json";
  if (m.includes("csv") || n.endsWith(".csv")) return "csv";
  if (m.includes("tab-separated") || n.endsWith(".tsv")) return "tsv";
  if (m.startsWith("text/")) return "text";
  if (m.includes("zip") || n.endsWith(".zip")) return "zip";
  return "binary";
}

function canPreviewAsText(kind) {
  return kind === "text" || kind === "json" || kind === "csv" || kind === "tsv";
}

function loadLS() {
  if (typeof window === "undefined")
    return { artifactsMetaById: {}, order: [] };
  const raw = window.localStorage?.getItem?.(LS_KEY);
  const parsed = raw ? safeParseJSON(raw, null) : null;
  if (!parsed || !isObject(parsed)) return { artifactsMetaById: {}, order: [] };
  return {
    artifactsMetaById: isObject(parsed.artifactsMetaById)
      ? parsed.artifactsMetaById
      : {},
    order: Array.isArray(parsed.order) ? parsed.order : [],
  };
}

function saveLS(next) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem?.(LS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function textDecoder() {
  try {
    return new TextDecoder("utf-8", { fatal: false });
  } catch {
    return null;
  }
}

/* ----------------------------- Crypto Fingerprint ---------------------------- */

async function sha256Hex(arrayBuffer) {
  // Uses WebCrypto if available; otherwise produces a weaker fallback fingerprint.
  try {
    if (
      typeof crypto !== "undefined" &&
      crypto.subtle &&
      typeof crypto.subtle.digest === "function"
    ) {
      const hash = await crypto.subtle.digest("SHA-256", arrayBuffer);
      const bytes = new Uint8Array(hash);
      let hex = "";
      for (const b of bytes) hex += b.toString(16).padStart(2, "0");
      return hex;
    }
  } catch {
    // fall through
  }

  // Fallback: non-cryptographic fingerprint (still useful for dedupe in-session)
  const bytes = new Uint8Array(arrayBuffer);
  let a = 2166136261; // FNV-like
  for (let i = 0; i < bytes.length; i++) {
    a ^= bytes[i];
    a += (a << 1) + (a << 4) + (a << 7) + (a << 8) + (a << 24);
  }
  return `weak_${(a >>> 0).toString(16)}`;
}

async function fingerprintBlob(
  blob,
  { maxBytesForHash = 10_000_000, signal } = {}
) {
  // Hash full blob up to maxBytesForHash; if larger, hash a sample.
  const size = blob?.size || 0;
  const sliceSize = Math.min(size, maxBytesForHash);

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const slice = blob.slice(0, sliceSize);
  const buf = await slice.arrayBuffer();

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const hex = await sha256Hex(buf);
  const suffix =
    size > sliceSize ? `_partial_${sliceSize}_${size}` : `_full_${size}`;
  return `${hex}${suffix}`;
}

/* ----------------------------- Optional Integrations ------------------------- */

let _dbPromise = null;
async function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    try {
      const mod = await import(/* @vite-ignore */ "@/services/db");
      return mod?.db || mod?.default || null;
    } catch {
      return null;
    }
  })();
  return _dbPromise;
}

let _eventBusPromise = null;
async function getEventBus() {
  if (_eventBusPromise) return _eventBusPromise;
  _eventBusPromise = (async () => {
    try {
      const mod = await import(/* @vite-ignore */ "@/services/events/eventBus");
      return mod?.eventBus || mod?.default || null;
    } catch {
      return null;
    }
  })();
  return _eventBusPromise;
}

async function emit(type, payload) {
  try {
    const eb = await getEventBus();
    if (!eb) return;
    if (typeof eb.emit === "function") eb.emit(type, payload);
    else if (typeof eb.publish === "function") eb.publish(type, payload);
  } catch {
    // ignore
  }
}

let _routerPromise = null;
async function getRouter() {
  if (_routerPromise) return _routerPromise;
  _routerPromise = (async () => {
    try {
      const mod = await import(
        /* @vite-ignore */ "@/services/imports/ImportRouter"
      );
      // expected: routeArtifact(artifact, opts)
      return mod || null;
    } catch {
      return null;
    }
  })();
  return _routerPromise;
}

function hasTable(db, name) {
  try {
    return !!db && !!db[name] && typeof db[name].toArray === "function";
  } catch {
    return false;
  }
}

async function dbPut(db, tableName, row) {
  try {
    if (!hasTable(db, tableName)) return false;
    const t = db[tableName];
    if (typeof t.put === "function") {
      await t.put(row);
      return true;
    }
    if (typeof t.add === "function") {
      await t.add(row);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function dbGetById(db, tableName, id) {
  try {
    if (!hasTable(db, tableName)) return null;
    const t = db[tableName];
    if (typeof t.get === "function") return (await t.get(id)) || null;
    return null;
  } catch {
    return null;
  }
}

async function dbFindByFingerprint(db, tableName, fingerprint) {
  // Best-effort: if table supports where('fingerprint').equals(...)
  try {
    if (!hasTable(db, tableName) || !fingerprint) return null;
    const t = db[tableName];
    if (typeof t.where === "function") {
      // Works if an index exists; if not, Dexie may throw.
      const rows = await t
        .where("fingerprint")
        .equals(String(fingerprint))
        .limit(1)
        .toArray();
      return rows?.[0] || null;
    }
  } catch {
    // ignore
  }
  return null;
}

/* -------------------------- In-Memory Blob Fallback -------------------------- */

// If no Dexie artifacts table exists, we cannot persist blobs in localStorage.
// We keep them in memory (lifetime of the tab) and store metadata in LS.
const _blobByArtifactId = new Map(); // id -> Blob

function storeBlobInMemory(id, blob) {
  try {
    if (!id || !blob) return;
    _blobByArtifactId.set(String(id), blob);
  } catch {
    // ignore
  }
}

function getBlobFromMemory(id) {
  try {
    return _blobByArtifactId.get(String(id)) || null;
  } catch {
    return null;
  }
}

/* ------------------------------ Text Preview -------------------------------- */

async function extractTextPreview(
  blob,
  kind,
  { signal, maxBytes = MAX_TEXT_PREVIEW_BYTES } = {}
) {
  if (!blob || !canPreviewAsText(kind))
    return { textPreview: null, parseHint: null };

  const size = blob.size || 0;
  const slice = blob.slice(0, Math.min(size, maxBytes));
  const buf = await slice.arrayBuffer();

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const dec = textDecoder();
  if (!dec) return { textPreview: null, parseHint: null };

  let text = dec.decode(new Uint8Array(buf));
  // If JSON, attempt pretty-shortening to avoid huge strings
  if (kind === "json") {
    const trimmed = text.trim();
    const maybe = trimmed.startsWith("{") || trimmed.startsWith("[");
    if (maybe) {
      try {
        const obj = JSON.parse(trimmed);
        text = JSON.stringify(obj, null, 2);
      } catch {
        // keep raw
      }
    }
  }

  const parseHint =
    kind === "csv" || kind === "tsv"
      ? { delimiter: kind === "tsv" ? "\t" : ",", hasHeader: true }
      : null;

  return { textPreview: text, parseHint };
}

/* ------------------------------ Parse Cache --------------------------------- */

async function getParseCacheHit(db, fingerprint) {
  // Optional table: parse_cache
  if (!db || !hasTable(db, "parse_cache") || !fingerprint) return null;
  try {
    const t = db.parse_cache;
    if (typeof t.where === "function") {
      const rows = await t
        .where("fingerprint")
        .equals(String(fingerprint))
        .limit(1)
        .toArray();
      return rows?.[0] || null;
    }
  } catch {
    // ignore
  }
  return null;
}

async function putParseCache(db, entry) {
  if (!db || !hasTable(db, "parse_cache") || !entry) return false;
  try {
    const row = {
      id: entry.id || createId("pc"),
      fingerprint: String(entry.fingerprint),
      artifactId: entry.artifactId ? String(entry.artifactId) : undefined,
      status: String(entry.status || "ok"), // ok|error|skipped
      parserKey: entry.parserKey ? String(entry.parserKey) : undefined,
      summary: entry.summary ? String(entry.summary) : undefined,
      createdAt: normalizeISO(entry.createdAt) || nowISO(),
      updatedAt: nowISO(),
      meta: isObject(entry.meta) ? { ...entry.meta } : undefined,
    };
    return await dbPut(db, "parse_cache", row);
  } catch {
    return false;
  }
}

/* ------------------------------ Artifact Model ------------------------------- */

/**
 * Canonical artifact record (we store)
 * {
 *  id,
 *  name,
 *  mime,
 *  kind,
 *  size,
 *  lastModified?,
 *  source: "upload"|"url"|"blob",
 *  fingerprint,           // sha256-ish
 *  createdAt,
 *  updatedAt,
 *  blob?: Blob,           // only if stored in Dexie
 *  textPreview?: string,  // only for small-ish text-like files
 *  parseHint?: any,
 *  status: "new"|"parsed"|"error"|"skipped",
 *  links?: { ... },
 *  meta?: { ... }
 * }
 */
function buildArtifactBase({
  id,
  name,
  mime,
  kind,
  size,
  lastModified,
  source,
  fingerprint,
  textPreview,
  parseHint,
  status,
  links,
  meta,
}) {
  const createdAt = nowISO();
  return {
    id: id || createId("art"),
    name: name != null ? String(name) : "upload",
    mime: mime != null ? String(mime) : "",
    kind: kind != null ? String(kind) : "binary",
    size: Number.isFinite(Number(size)) ? Number(size) : 0,
    lastModified: lastModified != null ? Number(lastModified) : undefined,
    source: source || "upload",
    fingerprint: String(fingerprint || ""),
    createdAt,
    updatedAt: createdAt,
    textPreview: textPreview != null ? String(textPreview) : undefined,
    parseHint: parseHint != null ? parseHint : undefined,
    status: status || "new",
    links: isObject(links) ? { ...links } : undefined,
    meta: isObject(meta) ? { ...meta } : undefined,
  };
}

/* --------------------------- Core Ingest Operations -------------------------- */

async function persistArtifact(artifact, blob, { db } = {}) {
  // Prefer Dexie artifacts table
  if (db && hasTable(db, "artifacts")) {
    const row = { ...artifact };
    // Store raw blob when possible (Dexie supports Blob)
    if (blob) row.blob = blob;
    const ok = await dbPut(db, "artifacts", row);
    return { persisted: ok, storage: "dexie", artifact: row };
  }

  // Fallback: store metadata to localStorage, blob to memory
  const ls = loadLS();
  const meta = { ...artifact };
  // do not store large preview/meta if huge
  if (meta.textPreview && meta.textPreview.length > 2_000_000) {
    meta.textPreview = meta.textPreview.slice(0, 2_000_000);
  }

  const next = {
    artifactsMetaById: { ...(ls.artifactsMetaById || {}), [meta.id]: meta },
    order: stableUnique([meta.id, ...(ls.order || [])]),
  };
  saveLS(next);

  if (blob) storeBlobInMemory(meta.id, blob);

  return { persisted: true, storage: "local+memory", artifact: meta };
}

async function findExistingArtifactByFingerprint({ db, fingerprint }) {
  if (!fingerprint) return null;

  // Dexie lookup
  if (db && hasTable(db, "artifacts")) {
    const found = await dbFindByFingerprint(db, "artifacts", fingerprint);
    if (found) return found;
  }

  // LocalStorage lookup
  const ls = loadLS();
  const map = ls.artifactsMetaById || {};
  for (const id of Object.keys(map)) {
    if (map[id]?.fingerprint === fingerprint) return map[id];
  }
  return null;
}

/* ---------------------------- Router + Parsing ------------------------------- */

async function routeArtifact(artifact, { db, signal, onProgress } = {}) {
  const router = await getRouter();
  const fn =
    router?.routeArtifact ||
    router?.default?.routeArtifact ||
    router?.default ||
    null;

  if (typeof fn !== "function") {
    return {
      routed: false,
      parsed: false,
      message: "ImportRouter.routeArtifact not available",
      outputs: null,
    };
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  onProgress?.({ phase: "parse.started", artifactId: artifact.id });

  await emit("imports.parse.started", {
    source: SOURCE,
    at: nowISO(),
    artifactId: artifact.id,
    kind: artifact.kind,
    mime: artifact.mime,
  });

  const outputs = await fn(artifact, {
    db,
    signal,
    onProgress,
    source: SOURCE,
  });

  onProgress?.({ phase: "parse.completed", artifactId: artifact.id });

  await emit("imports.parse.completed", {
    source: SOURCE,
    at: nowISO(),
    artifactId: artifact.id,
    ok: true,
  });

  return { routed: true, parsed: true, outputs, message: "ok" };
}

/* --------------------------------- Service ---------------------------------- */

const UploadIngestService = {
  /**
   * Ingest a File (from <input type="file"> or drag-drop).
   */
  async ingestFile(file, options = {}) {
    const {
      signal,
      onProgress,
      route = true,
      idempotent = true,
      useParseCache = true,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      links,
      meta,
    } = options || {};

    if (!file) throw new Error("ingestFile: missing file");

    const db = await getDB();

    const name = file.name || "upload";
    const mime = file.type || guessMimeFromName(name);
    const kind = classifyKind(mime, name);
    const size = file.size || 0;
    const lastModified = file.lastModified || undefined;

    const controller = signal ? null : new AbortController(); // internal timeout only if no external signal
    const combinedSignal = signal || controller?.signal;

    let timeout = null;
    if (!signal && timeoutMs && Number.isFinite(Number(timeoutMs))) {
      timeout = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          // ignore
        }
      }, Math.max(1000, Math.trunc(timeoutMs)));
    }

    try {
      onProgress?.({ phase: "ingest.started", name, size, kind, mime });

      await emit("imports.ingest.started", {
        source: SOURCE,
        at: nowISO(),
        name,
        size,
        kind,
        mime,
      });

      // Fingerprint for idempotency / cache
      const fingerprint = await fingerprintBlob(file, {
        signal: combinedSignal,
      });

      // Parse-cache skip (if available)
      if (db && useParseCache) {
        const hit = await getParseCacheHit(db, fingerprint);
        if (hit && hit.status === "ok" && hit.artifactId) {
          const existing = await dbGetById(db, "artifacts", hit.artifactId);
          if (existing) {
            onProgress?.({
              phase: "ingest.skipped",
              reason: "parse_cache_hit",
              artifactId: existing.id,
            });
            return {
              artifact: existing,
              persisted: true,
              storage: "dexie",
              skipped: true,
              parseCacheHit: hit,
            };
          }
        }
      }

      // Idempotent check: existing artifact by fingerprint
      if (idempotent) {
        const existing = await findExistingArtifactByFingerprint({
          db,
          fingerprint,
        });
        if (existing) {
          onProgress?.({
            phase: "ingest.skipped",
            reason: "fingerprint_exists",
            artifactId: existing.id,
          });
          return {
            artifact: existing,
            persisted: true,
            storage: db && hasTable(db, "artifacts") ? "dexie" : "local+memory",
            skipped: true,
            parseCacheHit: null,
          };
        }
      }

      // Light text preview for text-like files
      let textPreview = null;
      let parseHint = null;
      try {
        if (canPreviewAsText(kind)) {
          const res = await extractTextPreview(file, kind, {
            signal: combinedSignal,
          });
          textPreview = res.textPreview;
          parseHint = res.parseHint;
        }
      } catch {
        // ignore preview errors
      }

      const artifact = buildArtifactBase({
        name,
        mime,
        kind,
        size,
        lastModified,
        source: "upload",
        fingerprint,
        textPreview,
        parseHint,
        status: "new",
        links,
        meta,
      });

      const persisted = await persistArtifact(artifact, file, { db });

      onProgress?.({
        phase: "artifact.created",
        artifactId: persisted.artifact.id,
        storage: persisted.storage,
      });

      await emit("imports.artifact.created", {
        source: SOURCE,
        at: nowISO(),
        artifactId: persisted.artifact.id,
        fingerprint,
        kind,
        mime,
        size,
        storage: persisted.storage,
      });

      let parseResult = null;

      if (route) {
        // Route to parsers
        parseResult = await UploadIngestService.routeAndParse(
          persisted.artifact,
          {
            db,
            signal: combinedSignal,
            onProgress,
            useParseCache,
          }
        );

        // Update artifact status
        const statusPatch = {
          ...persisted.artifact,
          status: parseResult?.ok
            ? "parsed"
            : parseResult?.skipped
            ? "skipped"
            : "error",
          updatedAt: nowISO(),
        };
        await persistArtifact(
          statusPatch,
          persisted.storage === "dexie" ? file : null,
          { db }
        );

        if (db && useParseCache && fingerprint) {
          await putParseCache(db, {
            fingerprint,
            artifactId: statusPatch.id,
            status: parseResult?.ok
              ? "ok"
              : parseResult?.skipped
              ? "skipped"
              : "error",
            parserKey: parseResult?.parserKey,
            summary: parseResult?.summary,
            meta: { kind, mime },
          });
        }
      }

      onProgress?.({
        phase: "ingest.completed",
        artifactId: persisted.artifact.id,
      });

      await emit("imports.ingest.completed", {
        source: SOURCE,
        at: nowISO(),
        artifactId: persisted.artifact.id,
        ok: true,
        parsed: !!parseResult?.ok,
      });

      return {
        artifact: persisted.artifact,
        persisted: persisted.persisted,
        storage: persisted.storage,
        skipped: false,
        parseResult,
      };
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? "aborted"
          : String(e?.message || e || "ingest failed");

      onProgress?.({ phase: "ingest.error", error: msg });

      await emit("imports.ingest.error", {
        source: SOURCE,
        at: nowISO(),
        ok: false,
        error: msg,
      });

      throw e;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  },

  /**
   * Ingest multiple files with simple sequencing (keeps UI responsive and easier
   * to reason about). If you want parallel ingest, call ingestFile yourself.
   */
  async ingestFiles(files, options = {}) {
    const list = Array.isArray(files)
      ? files
      : files && typeof files.length === "number"
      ? Array.from(files)
      : [];

    const results = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const res = await UploadIngestService.ingestFile(f, {
        ...options,
        meta: {
          ...(options.meta || {}),
          batchIndex: i,
          batchTotal: list.length,
        },
        onProgress: (p) => {
          options.onProgress?.({
            ...p,
            batchIndex: i,
            batchTotal: list.length,
          });
        },
      });
      results.push(res);
    }
    return results;
  },

  /**
   * Ingest a raw Blob (e.g., from camera capture).
   */
  async ingestBlob(blob, options = {}) {
    if (!blob) throw new Error("ingestBlob: missing blob");
    const {
      name = "blob",
      mime = blob.type || guessMimeFromName(name),
      route = true,
      signal,
      onProgress,
      idempotent = true,
      useParseCache = true,
      links,
      meta,
    } = options || {};

    // Wrap into File if possible to keep parity
    let file = null;
    try {
      file = new File([blob], name, { type: mime, lastModified: Date.now() });
    } catch {
      // If File constructor unavailable, fallback to a minimal shim
      file = blob;
      file.name = name;
      file.type = mime;
      file.size = blob.size;
      file.lastModified = Date.now();
    }

    return UploadIngestService.ingestFile(file, {
      route,
      signal,
      onProgress,
      idempotent,
      useParseCache,
      links,
      meta,
    });
  },

  /**
   * Ingest from URL (best-effort). Subject to CORS.
   */
  async ingestFromUrl(url, options = {}) {
    const {
      signal,
      onProgress,
      route = true,
      idempotent = true,
      useParseCache = true,
      links,
      meta,
      fetchInit,
      name,
    } = options || {};

    if (!url) throw new Error("ingestFromUrl: missing url");

    onProgress?.({ phase: "fetch.started", url });

    await emit("imports.fetch.started", {
      source: SOURCE,
      at: nowISO(),
      url: String(url),
    });

    const res = await fetch(String(url), { ...(fetchInit || {}), signal });
    if (!res.ok) {
      const err = `fetch failed: ${res.status} ${res.statusText}`;
      onProgress?.({ phase: "fetch.error", url, error: err });
      await emit("imports.fetch.error", {
        source: SOURCE,
        at: nowISO(),
        url: String(url),
        error: err,
      });
      throw new Error(err);
    }

    const blob = await res.blob();
    const contentType = res.headers.get("content-type") || blob.type || "";
    const resolvedName =
      name ||
      (() => {
        try {
          const u = new URL(String(url));
          const last = u.pathname.split("/").filter(Boolean).pop();
          return last || "download";
        } catch {
          return "download";
        }
      })();

    onProgress?.({ phase: "fetch.completed", url, size: blob.size });

    await emit("imports.fetch.completed", {
      source: SOURCE,
      at: nowISO(),
      url: String(url),
      size: blob.size,
      mime: contentType,
    });

    return UploadIngestService.ingestBlob(blob, {
      name: resolvedName,
      mime: contentType,
      route,
      signal,
      onProgress,
      idempotent,
      useParseCache,
      links: { ...(links || {}), sourceUrl: String(url) },
      meta: { ...(meta || {}), sourceUrl: String(url) },
    });
  },

  /**
   * Explicit router + parser pass for an existing artifact record.
   * - If your ImportRouter writes L1/L2/L3 layers, this triggers that flow.
   * - Uses parse_cache if requested (Dexie-only).
   */
  async routeAndParse(artifact, options = {}) {
    const {
      db: providedDB,
      signal,
      onProgress,
      useParseCache = true,
    } = options || {};

    const db = providedDB || (await getDB());

    if (!artifact?.id) {
      return { ok: false, skipped: true, reason: "missing_artifact" };
    }

    const fingerprint = artifact.fingerprint
      ? String(artifact.fingerprint)
      : "";

    // Parse-cache shortcut
    if (db && useParseCache && fingerprint) {
      const hit = await getParseCacheHit(db, fingerprint);
      if (hit && hit.status === "ok" && hit.artifactId === artifact.id) {
        return {
          ok: true,
          skipped: true,
          reason: "parse_cache_hit",
          parseCacheHit: hit,
          parserKey: hit.parserKey,
          summary: hit.summary,
        };
      }
    }

    try {
      const routed = await routeArtifact(artifact, { db, signal, onProgress });
      // Support routers that return richer status info
      const ok = routed?.parsed !== false;

      // If router returns a key/summary, forward it
      const parserKey =
        routed?.outputs?.parserKey ||
        routed?.outputs?.meta?.parserKey ||
        routed?.outputs?.parser ||
        undefined;

      const summary =
        routed?.outputs?.summary ||
        routed?.outputs?.meta?.summary ||
        routed?.outputs?.message ||
        undefined;

      return {
        ok,
        skipped: false,
        outputs: routed.outputs,
        parserKey,
        summary,
      };
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? "aborted"
          : String(e?.message || e || "parse failed");
      return { ok: false, skipped: false, error: msg };
    }
  },

  /**
   * Retrieve an artifact record by id (Dexie preferred; LS fallback).
   */
  async getArtifactById(id) {
    if (!id) return null;
    const db = await getDB();

    if (db && hasTable(db, "artifacts")) {
      const row = await dbGetById(db, "artifacts", String(id));
      return row || null;
    }

    const ls = loadLS();
    return ls.artifactsMetaById?.[String(id)] || null;
  },

  /**
   * Retrieve a blob for an artifact.
   * - Dexie artifacts.blob preferred
   * - otherwise memory fallback if available (same tab)
   */
  async getArtifactBlob(id) {
    if (!id) return null;
    const db = await getDB();

    if (db && hasTable(db, "artifacts")) {
      const row = await dbGetById(db, "artifacts", String(id));
      return row?.blob || null;
    }

    return getBlobFromMemory(id);
  },

  /**
   * Lightweight list of ingested artifacts (metadata only).
   * - Dexie: returns artifacts without blobs (we strip them)
   * - LS: returns stored metadata
   */
  async listArtifacts({ limit = 200 } = {}) {
    const db = await getDB();
    const lim = Math.max(1, Math.min(2000, Math.trunc(Number(limit) || 200)));

    if (db && hasTable(db, "artifacts")) {
      try {
        const rows = await db.artifacts.toArray();
        return (Array.isArray(rows) ? rows : [])
          .map((r) => {
            if (!r) return null;
            const { blob, ...rest } = r;
            return rest;
          })
          .sort(
            (a, b) =>
              new Date(b.createdAt || 0).getTime() -
              new Date(a.createdAt || 0).getTime()
          )
          .slice(0, lim);
      } catch {
        // fall back
      }
    }

    const ls = loadLS();
    const ids = (ls.order || []).slice(0, lim);
    return ids.map((id) => ls.artifactsMetaById?.[id]).filter(Boolean);
  },
};

export default UploadIngestService;
