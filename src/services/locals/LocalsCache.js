// src/services/locals/LocalsCache.js
// -----------------------------------------------------------------------------
// LocalsCache
// -----------------------------------------------------------------------------
// Cache: placeId -> store profile
// - Dexie-first (if a locals_places table exists)
// - localStorage fallback (so it works before schema lands)
// - TTL + stale-while-revalidate helpers
// -----------------------------------------------------------------------------

function now() {
  return Date.now();
}
function safeStr(x) {
  return String(x || "").trim();
}
function safeJsonParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function getDexieTable(db, name) {
  if (!db) return null;
  try {
    if (typeof db.table === "function") {
      const t = db.table(name);
      if (t) return t;
    }
  } catch {}
  try {
    if (db[name]) return db[name];
  } catch {}
  return null;
}

async function lazyImportDb(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.db || mod?.default || mod || null;
  } catch {
    return null;
  }
}

class LocalFallback {
  constructor(storageKey) {
    this.storageKey = storageKey;
  }
  _read() {
    if (typeof localStorage === "undefined") return { places: {} };
    return safeJsonParse(localStorage.getItem(this.storageKey), { places: {} });
  }
  _write(data) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(this.storageKey, JSON.stringify(data));
  }

  async get(placeId) {
    const db = this._read();
    return db.places?.[String(placeId)] || null;
  }
  async put(placeId, value) {
    const db = this._read();
    db.places[String(placeId)] = value;
    this._write(db);
    return value;
  }
  async bulkPut(map) {
    const db = this._read();
    for (const [k, v] of Object.entries(map || {})) {
      db.places[String(k)] = v;
    }
    this._write(db);
  }
  async delete(placeId) {
    const db = this._read();
    delete db.places[String(placeId)];
    this._write(db);
  }
  async list() {
    const db = this._read();
    return Object.values(db.places || {});
  }
}

export default class LocalsCache {
  constructor(opts = {}) {
    this.db = opts.db || null;
    this.dbImportPath = opts.dbImportPath || "@/services/db";

    this.tableName = opts.tableName || "locals_places";
    this.storageKey = opts.storageKey || "suka:locals:places:v1";

    this.ttlMs = Number.isFinite(opts.ttlMs)
      ? opts.ttlMs
      : 7 * 24 * 60 * 60 * 1000; // 7 days
    this.staleMs = Number.isFinite(opts.staleMs)
      ? opts.staleMs
      : 24 * 60 * 60 * 1000; // 1 day

    this._ready = false;
    this._table = null;
    this._local = new LocalFallback(this.storageKey);
  }

  async init({ force = false } = {}) {
    if (this._ready && !force) return true;
    if (!this.db) this.db = await lazyImportDb(this.dbImportPath);
    this._table = getDexieTable(this.db, this.tableName);
    this._ready = true;
    return true;
  }

  /**
   * Value shape recommended:
   * { placeId, profile: {...}, updatedAt, expiresAt }
   */
  async get(placeId) {
    await this.init();
    const pid = safeStr(placeId);
    if (!pid) return null;

    // Dexie
    if (this._table?.get) {
      try {
        return await this._table.get(pid);
      } catch {}
    }

    // Local fallback
    return this._local.get(pid);
  }

  async put(placeId, profile) {
    await this.init();
    const pid = safeStr(placeId);
    if (!pid) return null;

    const row = {
      placeId: pid,
      profile: profile && typeof profile === "object" ? profile : null,
      updatedAt: now(),
      expiresAt: now() + this.ttlMs,
    };

    if (this._table?.put) {
      try {
        await this._table.put(row);
        return row;
      } catch {}
    }

    await this._local.put(pid, row);
    return row;
  }

  /**
   * stale-while-revalidate helper:
   * - returns cached value (even if stale) + tells you if you should refresh
   */
  async getWithStaleness(placeId) {
    const row = await this.get(placeId);
    if (!row) return { row: null, isStale: true, isExpired: true };

    const t = now();
    const updatedAt = Number(row.updatedAt || 0);
    const expiresAt = Number(row.expiresAt || 0);

    const isExpired = expiresAt > 0 ? t > expiresAt : false;
    const isStale = updatedAt > 0 ? t - updatedAt > this.staleMs : true;

    return { row, isStale, isExpired };
  }

  async delete(placeId) {
    await this.init();
    const pid = safeStr(placeId);
    if (!pid) return;

    if (this._table?.delete) {
      try {
        await this._table.delete(pid);
        return;
      } catch {}
    }
    await this._local.delete(pid);
  }

  async list() {
    await this.init();
    if (this._table?.toArray) {
      try {
        return await this._table.toArray();
      } catch {}
    }
    return this._local.list();
  }
}
