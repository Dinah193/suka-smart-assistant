// File: C:\Users\larho\suka-smart-assistant\src\services\imports\ImportCacheService.js
/**
 * ImportCacheService
 * -----------------------------------------------------------------------------
 * SSA Import Cache Service (browser-safe, Dexie-backed, offline-first)
 *
 * Purpose
 *  - Provide a unified cache for "import/ingest" flows across SSA:
 *      • file uploads (csv/json/txt/pdf text extract)
 *      • scanner outputs (receipt OCR text, barcode payloads)
 *      • copied/pasted raw text blobs
 *      • external scrapes normalized into raw artifacts
 *
 * Why this exists
 *  - You often need to:
 *      1) store raw artifacts (L0)
 *      2) store parsed candidates (L1)
 *      3) re-run parsing, mapping, blueprint building without re-importing
 *
 * This module focuses on L0/L1 caching support in a single place:
 *  - Put/get raw "artifact" payloads with a stable fingerprint
 *  - Put/get "parsed candidates" keyed to artifact + parser version
 *  - Maintain lightweight indexes for dashboards and KPIs
 *
 * Key features
 *  - Browser-safe (NO Node imports)
 *  - Works even if your Dexie schema differs (best-effort table resolution)
 *  - Fallback to localStorage if Dexie tables are missing/unavailable
 *  - TTL + eviction
 *  - Deterministic fingerprints (stable across reloads)
 *  - Idempotent upserts
 *
 * Recommended Dexie tables (if you have them)
 *  - artifacts         (L0 raw uploads)
 *  - parsed_candidates (L1 extracted fields)
 *  - parse_cache       (optional: fingerprint -> parse output per parser version)
 *
 * If absent, ImportCacheService will fallback to a single localStorage namespace.
 */

import db from "@/services/db";

/* -----------------------------------------------------------------------------
 * Optional eventBus
 * -------------------------------------------------------------------------- */

let eventBus = null;
try {
  eventBus = (await import("@/services/events/eventBus")).default ?? null;
} catch {
  eventBus = null;
}

const SOURCE = "imports.ImportCacheService";

/* -----------------------------------------------------------------------------
 * Defaults / knobs
 * -------------------------------------------------------------------------- */

const DEFAULTS = Object.freeze({
  // localStorage
  lsNamespace: "ssa.importCache.v1",
  lsMaxEntries: 400,

  // TTL (ms)
  defaultTTLms: 14 * 24 * 60 * 60 * 1000, // 14 days
  shortTTLms: 2 * 24 * 60 * 60 * 1000, // 2 days (for volatile imports)

  // payload clamps
  maxTextLen: 250_000, // avoid blowing up storage
  maxJsonLen: 250_000,

  // versioning
  schemaVersion: 1,
});

/* -----------------------------------------------------------------------------
 * Table resolution helpers
 * -------------------------------------------------------------------------- */

const TABLE_CANDIDATES = {
  artifacts: [
    "artifacts",
    "artifact",
    "uploads",
    "raw_artifacts",
    "rawUploads",
  ],
  parsed: [
    "parsed_candidates",
    "parsedCandidates",
    "candidates",
    "parsed",
    "ingest_candidates",
  ],
  parseCache: ["parse_cache", "parseCache", "parser_cache", "parserCache"],
};

function resolveTable(name) {
  const candidates = TABLE_CANDIDATES[name] || [name];
  for (const k of candidates) {
    const t = db?.[k];
    if (t && typeof t.toCollection === "function") return t;
  }
  try {
    const tables = db?.tables || [];
    const exact = tables.find((t) =>
      candidates.some(
        (c) => String(t?.name || "").toLowerCase() === String(c).toLowerCase()
      )
    );
    if (exact) return exact;

    // fuzzy matching
    const pattern =
      name === "artifacts"
        ? /artifact|upload|raw/i
        : name === "parsed"
        ? /parsed|candidate|ingest/i
        : /cache|parse/i;

    const fuzzy = tables.find((t) => pattern.test(String(t?.name || "")));
    return fuzzy || null;
  } catch {
    return null;
  }
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
}

function nowMs() {
  return Date.now();
}

function safeObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function clampStr(s, max) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  return str.slice(0, max) + `…(truncated ${str.length - max})`;
}

function tryJsonStringify(x) {
  try {
    return JSON.stringify(x);
  } catch {
    return null;
  }
}

function normalizeKind(kind) {
  const k = String(kind || "unknown")
    .toLowerCase()
    .trim();
  return k || "unknown";
}

function normalizeSource(source) {
  const s = String(source || "unknown")
    .toLowerCase()
    .trim();
  return s || "unknown";
}

function normalizeMime(mime) {
  const m = String(mime || "").trim();
  return m || null;
}

/**
 * Deterministic-ish hash (fast) for browser (NOT crypto).
 *  - Suitable for fingerprints; not for security.
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV-1a prime: 16777619
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

function stableStringify(obj) {
  const seen = new WeakSet();
  const stringify = (x) => {
    if (x == null) return "null";
    if (typeof x !== "object") return JSON.stringify(x);

    if (seen.has(x)) return '"[Circular]"';
    seen.add(x);

    if (Array.isArray(x)) return `[${x.map((v) => stringify(v)).join(",")}]`;

    const keys = Object.keys(x).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stringify(x[k])}`)
      .join(",")}}`;
  };
  return stringify(obj);
}

function buildFingerprint(input) {
  const payload = safeObject(input);
  const basis = stableStringify({
    kind: normalizeKind(payload.kind),
    source: normalizeSource(payload.source),
    mime: normalizeMime(payload.mime),
    name: payload.name || null,
    size: payload.size || null,
    text: payload.text ? payload.text.slice(0, 40_000) : null, // include partial for speed
    json: payload.json ? stableStringify(payload.json).slice(0, 40_000) : null,
    // optionally allow external correlation keys
    externalId: payload.externalId || null,
    upc: payload.upc || null,
    store: payload.store || null,
    tsBucket: payload.tsBucket || null,
  });

  return `ic_${fnv1a(basis)}_${fnv1a(String(basis.length))}`;
}

/* -----------------------------------------------------------------------------
 * localStorage fallback layer
 * -------------------------------------------------------------------------- */

function lsKey(sub) {
  return `${DEFAULTS.lsNamespace}:${sub}`;
}

function lsRead(sub) {
  try {
    const raw = localStorage.getItem(lsKey(sub));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function lsWrite(sub, value) {
  try {
    localStorage.setItem(lsKey(sub), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function lsDel(sub) {
  try {
    localStorage.removeItem(lsKey(sub));
    return true;
  } catch {
    return false;
  }
}

function lsIndexRead() {
  return lsRead("index") || { v: DEFAULTS.schemaVersion, items: [] };
}

function lsIndexWrite(index) {
  return lsWrite("index", index);
}

function lsUpsertIndex(meta) {
  const idx = lsIndexRead();
  const items = safeArray(idx.items);

  const next = items.filter((x) => x?.fingerprint !== meta.fingerprint);
  next.unshift(meta);

  // trim
  const trimmed = next.slice(0, DEFAULTS.lsMaxEntries);
  const out = { ...idx, v: DEFAULTS.schemaVersion, items: trimmed };
  lsIndexWrite(out);
}

function lsEvictExpired(now = nowMs()) {
  const idx = lsIndexRead();
  const items = safeArray(idx.items);
  const keep = [];

  for (const it of items) {
    const exp = Number(it?.expiresAt || 0);
    if (exp && exp < now) {
      // delete payloads
      lsDel(`artifact:${it.fingerprint}`);
      lsDel(`parsed:${it.fingerprint}`);
      lsDel(`parsecache:${it.fingerprint}`);
      continue;
    }
    keep.push(it);
  }

  if (keep.length !== items.length) {
    lsIndexWrite({ ...idx, items: keep });
  }
}

/* -----------------------------------------------------------------------------
 * Service core
 * -------------------------------------------------------------------------- */

async function dexieUpsert(table, row) {
  try {
    await table.put(row);
    return true;
  } catch {
    return false;
  }
}

async function dexieGet(table, id) {
  try {
    return await table.get(id);
  } catch {
    return null;
  }
}

async function dexieDelete(table, id) {
  try {
    await table.delete(id);
    return true;
  } catch {
    return false;
  }
}

function normalizeArtifactInput(input) {
  const x = safeObject(input);

  const kind = normalizeKind(x.kind);
  const source = normalizeSource(x.source);

  const text =
    x.text != null ? clampStr(String(x.text), DEFAULTS.maxTextLen) : null;

  // json payload clamp
  let json = null;
  if (x.json != null) {
    const s = tryJsonStringify(x.json);
    if (s) {
      if (s.length <= DEFAULTS.maxJsonLen) json = x.json;
      else {
        // store as truncated string instead of object
        json = { __truncated: true, __text: clampStr(s, DEFAULTS.maxJsonLen) };
      }
    } else {
      json = { __unstringifiable: true };
    }
  }

  const mime = normalizeMime(x.mime);
  const name = x.name ? String(x.name) : null;
  const size = Number.isFinite(Number(x.size)) ? Number(x.size) : null;

  const createdAt = x.createdAt ? Number(x.createdAt) : nowMs();
  const ttlMs = Number.isFinite(Number(x.ttlMs))
    ? Number(x.ttlMs)
    : DEFAULTS.defaultTTLms;
  const expiresAt = createdAt + Math.max(1, ttlMs);

  const meta = safeObject(x.meta);

  return {
    kind,
    source,
    mime,
    name,
    size,
    text,
    json,
    meta,
    createdAt,
    updatedAt: nowMs(),
    ttlMs,
    expiresAt,
    externalId: x.externalId || null,
    // common commerce keys
    upc: x.upc || null,
    store: x.store || null,
    tsBucket: x.tsBucket || null,
  };
}

function normalizeParsedInput(input) {
  const x = safeObject(input);
  const createdAt = x.createdAt ? Number(x.createdAt) : nowMs();
  const ttlMs = Number.isFinite(Number(x.ttlMs))
    ? Number(x.ttlMs)
    : DEFAULTS.defaultTTLms;
  const expiresAt = createdAt + Math.max(1, ttlMs);

  return {
    parserId: x.parserId ? String(x.parserId) : "unknown",
    parserVersion: x.parserVersion ? String(x.parserVersion) : "1",
    candidates: safeArray(x.candidates),
    summary: x.summary ? String(x.summary) : null,
    meta: safeObject(x.meta),
    createdAt,
    updatedAt: nowMs(),
    ttlMs,
    expiresAt,
  };
}

function normalizeParseCacheInput(input) {
  const x = safeObject(input);
  const createdAt = x.createdAt ? Number(x.createdAt) : nowMs();
  const ttlMs = Number.isFinite(Number(x.ttlMs))
    ? Number(x.ttlMs)
    : DEFAULTS.defaultTTLms;
  const expiresAt = createdAt + Math.max(1, ttlMs);

  return {
    parserId: x.parserId ? String(x.parserId) : "unknown",
    parserVersion: x.parserVersion ? String(x.parserVersion) : "1",
    output: safeObject(x.output),
    createdAt,
    updatedAt: nowMs(),
    ttlMs,
    expiresAt,
  };
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

const ImportCacheService = {
  /**
   * Put an artifact into cache and return the full stored record.
   * @param {object} input - { kind, source, text?, json?, mime?, name?, size?, ttlMs?, meta?, externalId?, upc?, store? }
   */
  async putArtifact(input) {
    const artifact = normalizeArtifactInput(input);
    const fingerprint = buildFingerprint({
      ...artifact,
      text: artifact.text,
      json: artifact.json,
    });
    const record = {
      id: fingerprint,
      fingerprint,
      ...artifact,
    };

    // Attempt Dexie artifacts table
    const tArtifacts = resolveTable("artifacts");
    let persisted = false;

    if (tArtifacts) {
      persisted = await dexieUpsert(tArtifacts, record);
    }

    if (!persisted) {
      // localStorage fallback
      lsEvictExpired();
      lsWrite(`artifact:${fingerprint}`, record);
      // store empty placeholders for other layers (optional)
      lsUpsertIndex({
        fingerprint,
        kind: record.kind,
        source: record.source,
        name: record.name,
        mime: record.mime,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        expiresAt: record.expiresAt,
      });
    }

    emit("import.cache.artifact.put", {
      fingerprint,
      persisted: !!persisted,
      kind: record.kind,
      source: record.source,
    });
    return record;
  },

  /**
   * Get an artifact by fingerprint.
   */
  async getArtifact(fingerprint) {
    if (!fingerprint) return null;

    // Dexie
    const tArtifacts = resolveTable("artifacts");
    if (tArtifacts) {
      const row = await dexieGet(tArtifacts, fingerprint);
      if (row) return row;
    }

    // localStorage
    lsEvictExpired();
    return lsRead(`artifact:${fingerprint}`);
  },

  /**
   * Delete an artifact (and any related cached parsed data).
   */
  async deleteArtifact(fingerprint) {
    if (!fingerprint) return false;

    let ok = false;
    const tArtifacts = resolveTable("artifacts");
    const tParsed = resolveTable("parsed");
    const tParseCache = resolveTable("parseCache");

    if (tArtifacts) ok = (await dexieDelete(tArtifacts, fingerprint)) || ok;
    if (tParsed) ok = (await dexieDelete(tParsed, fingerprint)) || ok;
    if (tParseCache) ok = (await dexieDelete(tParseCache, fingerprint)) || ok;

    // localStorage fallback cleanup
    lsDel(`artifact:${fingerprint}`);
    lsDel(`parsed:${fingerprint}`);
    lsDel(`parsecache:${fingerprint}`);

    // remove from index
    const idx = lsIndexRead();
    const items = safeArray(idx.items).filter(
      (x) => x?.fingerprint !== fingerprint
    );
    lsIndexWrite({ ...idx, items });

    emit("import.cache.artifact.deleted", { fingerprint });
    return ok || true;
  },

  /**
   * Put parsed candidates for an artifact.
   * @param {string} fingerprint
   * @param {object} parsed - { parserId, parserVersion, candidates, summary, ttlMs, meta }
   */
  async putParsedCandidates(fingerprint, parsed) {
    if (!fingerprint)
      throw new Error("putParsedCandidates requires fingerprint");
    const payload = normalizeParsedInput(parsed);
    const record = {
      id: fingerprint,
      fingerprint,
      ...payload,
    };

    const tParsed = resolveTable("parsed");
    let persisted = false;
    if (tParsed) persisted = await dexieUpsert(tParsed, record);

    if (!persisted) {
      lsEvictExpired();
      lsWrite(`parsed:${fingerprint}`, record);
      // index update (keep meta)
      const art = await this.getArtifact(fingerprint);
      lsUpsertIndex({
        fingerprint,
        kind: art?.kind || "unknown",
        source: art?.source || "unknown",
        name: art?.name || null,
        mime: art?.mime || null,
        createdAt: art?.createdAt || record.createdAt,
        updatedAt: nowMs(),
        expiresAt: Math.min(
          art?.expiresAt || record.expiresAt,
          record.expiresAt
        ),
      });
    }

    emit("import.cache.parsed.put", {
      fingerprint,
      persisted: !!persisted,
      parserId: record.parserId,
      parserVersion: record.parserVersion,
      candidatesCount: safeArray(record.candidates).length,
    });

    return record;
  },

  /**
   * Get parsed candidates for an artifact.
   * @param {string} fingerprint
   * @param {object} [opts]
   * @param {string} [opts.parserId] - if provided, must match
   * @param {string} [opts.parserVersion] - if provided, must match
   */
  async getParsedCandidates(fingerprint, opts = {}) {
    if (!fingerprint) return null;

    const wantParserId = opts.parserId ? String(opts.parserId) : null;
    const wantParserVer = opts.parserVersion
      ? String(opts.parserVersion)
      : null;

    const tParsed = resolveTable("parsed");
    let row = null;

    if (tParsed) row = await dexieGet(tParsed, fingerprint);
    if (!row) {
      lsEvictExpired();
      row = lsRead(`parsed:${fingerprint}`);
    }
    if (!row) return null;

    if (wantParserId && String(row.parserId) !== wantParserId) return null;
    if (wantParserVer && String(row.parserVersion) !== wantParserVer)
      return null;

    // TTL check
    if (row.expiresAt && Number(row.expiresAt) < nowMs()) return null;

    return row;
  },

  /**
   * Put parse cache output (optional) keyed by fingerprint + parserId + parserVersion.
   * Note: Stored under parse_cache table if exists, else localStorage.
   */
  async putParseCache(fingerprint, cache) {
    if (!fingerprint) throw new Error("putParseCache requires fingerprint");
    const payload = normalizeParseCacheInput(cache);

    // Compose a compound id so multiple parser versions can coexist.
    const cacheId = `${fingerprint}::${payload.parserId}::${payload.parserVersion}`;
    const record = { id: cacheId, fingerprint, ...payload };

    const t = resolveTable("parseCache");
    let persisted = false;
    if (t) persisted = await dexieUpsert(t, record);

    if (!persisted) {
      lsEvictExpired();
      const existing = lsRead(`parsecache:${fingerprint}`) || {};
      const next = { ...existing, [cacheId]: record };
      lsWrite(`parsecache:${fingerprint}`, next);
    }

    emit("import.cache.parseCache.put", {
      fingerprint,
      persisted: !!persisted,
      parserId: payload.parserId,
      parserVersion: payload.parserVersion,
    });

    return record;
  },

  /**
   * Get parse cache output for fingerprint + parserId + parserVersion.
   */
  async getParseCache(fingerprint, opts = {}) {
    if (!fingerprint) return null;
    const parserId = opts.parserId ? String(opts.parserId) : "unknown";
    const parserVersion = opts.parserVersion ? String(opts.parserVersion) : "1";
    const cacheId = `${fingerprint}::${parserId}::${parserVersion}`;

    const t = resolveTable("parseCache");
    if (t) {
      const row = await dexieGet(t, cacheId);
      if (row && (!row.expiresAt || Number(row.expiresAt) >= nowMs()))
        return row;
    }

    lsEvictExpired();
    const bucket = lsRead(`parsecache:${fingerprint}`);
    const row = bucket ? bucket[cacheId] : null;
    if (!row) return null;
    if (row.expiresAt && Number(row.expiresAt) < nowMs()) return null;
    return row;
  },

  /**
   * List cached import entries for dashboards.
   * - If Dexie tables exist, this will best-effort list artifacts.
   * - Otherwise uses localStorage index.
   */
  async listIndex(opts = {}) {
    const limit = Number.isFinite(Number(opts.limit))
      ? Number(opts.limit)
      : 100;
    const includeExpired = !!opts.includeExpired;

    const tArtifacts = resolveTable("artifacts");
    if (tArtifacts) {
      try {
        const rows = await tArtifacts.toArray();
        const now = nowMs();
        const filtered = rows
          .filter((r) =>
            includeExpired ? true : !r.expiresAt || Number(r.expiresAt) >= now
          )
          .sort(
            (a, b) =>
              Number(b.updatedAt || b.createdAt || 0) -
              Number(a.updatedAt || a.createdAt || 0)
          )
          .slice(0, Math.max(0, limit))
          .map((r) => ({
            fingerprint: r.fingerprint || r.id,
            kind: r.kind,
            source: r.source,
            name: r.name || null,
            mime: r.mime || null,
            createdAt: r.createdAt || null,
            updatedAt: r.updatedAt || null,
            expiresAt: r.expiresAt || null,
          }));
        return filtered;
      } catch {
        // fall back to localStorage index
      }
    }

    lsEvictExpired();
    const idx = lsIndexRead();
    const now = nowMs();
    const out = safeArray(idx.items)
      .filter((it) =>
        includeExpired ? true : !it.expiresAt || Number(it.expiresAt) >= now
      )
      .slice(0, Math.max(0, limit));

    return out;
  },

  /**
   * KPIs:
   *  - total cached artifacts
   *  - expired count
   *  - by kind/source
   */
  async kpis() {
    const now = nowMs();
    const index = await this.listIndex({ limit: 999999, includeExpired: true });

    const byKind = {};
    const bySource = {};
    let expired = 0;

    for (const it of index) {
      const k = normalizeKind(it.kind);
      const s = normalizeSource(it.source);
      byKind[k] = (byKind[k] || 0) + 1;
      bySource[s] = (bySource[s] || 0) + 1;
      if (it.expiresAt && Number(it.expiresAt) < now) expired++;
    }

    return {
      generatedAt: now,
      total: index.length,
      expired,
      byKind,
      bySource,
      backend: {
        artifacts: !!resolveTable("artifacts"),
        parsed: !!resolveTable("parsed"),
        parseCache: !!resolveTable("parseCache"),
        localStorage: true,
      },
    };
  },

  /**
   * Evict expired entries now (Dexie best-effort + localStorage).
   */
  async evictExpired() {
    const now = nowMs();

    // localStorage
    lsEvictExpired(now);

    // Dexie best-effort eviction
    const tArtifacts = resolveTable("artifacts");
    const tParsed = resolveTable("parsed");
    const tParseCache = resolveTable("parseCache");

    let removed = 0;

    async function clearExpired(table) {
      if (!table) return 0;
      try {
        // if there's an index on expiresAt, where() may work;
        // otherwise fallback to scan and delete.
        const rows = await table.toArray();
        const expired = rows.filter(
          (r) => r?.expiresAt && Number(r.expiresAt) < now
        );
        for (const r of expired) {
          await table.delete(r.id ?? r.fingerprint);
        }
        return expired.length;
      } catch {
        return 0;
      }
    }

    removed += await clearExpired(tArtifacts);
    removed += await clearExpired(tParsed);

    if (tParseCache) {
      try {
        const rows = await tParseCache.toArray();
        const expired = rows.filter(
          (r) => r?.expiresAt && Number(r.expiresAt) < now
        );
        for (const r of expired) {
          await tParseCache.delete(r.id);
        }
        removed += expired.length;
      } catch {
        // ignore
      }
    }

    emit("import.cache.evictExpired", { removed });
    return { removed };
  },

  /**
   * Debug: returns which storage backends are available.
   */
  backend() {
    return {
      artifactsTable: resolveTable("artifacts")?.name ?? null,
      parsedTable: resolveTable("parsed")?.name ?? null,
      parseCacheTable: resolveTable("parseCache")?.name ?? null,
      localStorageNamespace: DEFAULTS.lsNamespace,
      version: DEFAULTS.schemaVersion,
    };
  },
};

export default ImportCacheService;
