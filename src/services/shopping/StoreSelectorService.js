// src/services/shopping/StoreSelectorService.js
// -----------------------------------------------------------------------------
// StoreSelectorService
// -----------------------------------------------------------------------------
// Responsibilities:
// - Search stores (provider-pluggable; can wire Google Places/Local inventory later)
// - Normalize chain vs specific location (Walmart vs Walmart #1234)
// - Cache store entities locally (Dexie if available; localStorage fallback)
// - Manage "store sets" (selected stores list) + compute stable storeSetKey
//
// Emits:
// - "shopping:stores.updated" { selected, storeSetKey }
// - "shopping:store.selected" { store }
// - "shopping:store.removed" { storeId }
// -----------------------------------------------------------------------------
//
// Normalized store shape:
// {
//   id: "place:ChIJ..." OR "chain:walmart",
//   kind: "location"|"chain",
//   name: "Walmart Supercenter",
//   chain: { key: "walmart", name: "Walmart" },
//   placeId, address, lat, lon,
//   region: { city, state, country },
//   tags: ["grocery","pharmacy"],
//   source: "providerName",
//   updatedAt
// }
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

function now() {
  return Date.now();
}
function safeStr(x) {
  return String(x || "").trim();
}
function normKey(x) {
  return safeStr(x)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_:-]/g, "");
}
function stableHash(str) {
  // Small stable hash for storeSetKey (deterministic, not crypto)
  const s = String(str || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function getEventBusFromGlobals() {
  if (typeof window === "undefined") return null;
  return window.__SUKA_EVENT_BUS__ || null;
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
  try {
    const tables = Array.isArray(db.tables) ? db.tables : [];
    const found = tables.find((t) => t?.name === name);
    if (found && typeof db.table === "function") return db.table(name);
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

/* ------------------------------ Default Provider ------------------------------ */
/**
 * Provider interface:
 * - searchStores({ query, near, limit, signal }) -> [rawStore...]
 *
 * This default provider is "empty" but safe. You can replace it later with:
 * - Google Places provider
 * - Your own cached catalog provider
 * - A "known chains" provider
 */
const DefaultStoreProvider = {
  async searchStores({ query, limit = 10 }) {
    const q = safeStr(query);
    if (!q) return [];
    // Very small builtin chain matches so UI isn't dead.
    const known = [
      { chainKey: "walmart", name: "Walmart", kind: "chain" },
      { chainKey: "target", name: "Target", kind: "chain" },
      { chainKey: "kroger", name: "Kroger", kind: "chain" },
      { chainKey: "aldi", name: "ALDI", kind: "chain" },
      { chainKey: "costco", name: "Costco", kind: "chain" },
      { chainKey: "sams_club", name: "Sam's Club", kind: "chain" },
      { chainKey: "whole_foods", name: "Whole Foods", kind: "chain" },
      { chainKey: "publix", name: "Publix", kind: "chain" },
      { chainKey: "h_e_b", name: "H-E-B", kind: "chain" },
    ];
    const hits = known.filter((x) =>
      x.name.toLowerCase().includes(q.toLowerCase())
    );
    return hits.slice(0, limit);
  },
};

class LocalStoreCache {
  constructor(storageKey) {
    this.storageKey = storageKey;
  }
  _read() {
    if (typeof localStorage === "undefined")
      return { entities: {}, selected: [] };
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : { entities: {}, selected: [] };
    } catch {
      return { entities: {}, selected: [] };
    }
  }
  _write(data) {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch {}
  }

  getSelected() {
    const db = this._read();
    return Array.isArray(db.selected) ? db.selected : [];
  }
  setSelected(selectedIds) {
    const db = this._read();
    db.selected = Array.isArray(selectedIds) ? selectedIds : [];
    this._write(db);
  }

  getEntity(id) {
    const db = this._read();
    return db.entities?.[String(id)] || null;
  }
  putEntity(entity) {
    const db = this._read();
    db.entities[String(entity.id)] = entity;
    this._write(db);
    return entity;
  }
  listEntities() {
    const db = this._read();
    return Object.values(db.entities || {});
  }
}

export default class StoreSelectorService {
  constructor(opts = {}) {
    const gBus = getEventBusFromGlobals();
    this.eventBus = opts.eventBus ||
      gBus || { emit: () => {}, on: () => {}, off: () => {} };

    this.db = opts.db || null;
    this.dbImportPath = opts.dbImportPath || "@/services/db";

    this.provider = opts.provider || DefaultStoreProvider;

    // Optional Dexie tables (use if exist)
    this.storeTableName = opts.storeTable || "shopping_stores";
    this.storeSetTableName = opts.storeSetTable || "shopping_store_sets";

    this.local = new LocalStoreCache(
      opts.storageKey || "suka:shopping:stores:v1"
    );

    this._ready = false;
    this._tables = { stores: null, sets: null };
  }

  async init({ force = false } = {}) {
    if (this._ready && !force) return true;
    if (!this.db) this.db = await lazyImportDb(this.dbImportPath);
    this._tables.stores = getDexieTable(this.db, this.storeTableName);
    this._tables.sets = getDexieTable(this.db, this.storeSetTableName);
    this._ready = true;
    return true;
  }

  async searchStores(query, { near = null, limit = 10, signal } = {}) {
    await this.init();
    const raw = await this.provider.searchStores({
      query,
      near,
      limit,
      signal,
    });
    const list = Array.isArray(raw) ? raw : [];
    return list.map((r) => this.normalizeStore(r)).filter(Boolean);
  }

  normalizeStore(raw) {
    if (!raw) return null;

    // If provider returns chain items
    if (raw.kind === "chain" || raw.chainKey) {
      const chainKey = normKey(raw.chainKey || raw.key || raw.name);
      const name = raw.name || chainKey;
      return {
        id: `chain:${chainKey}`,
        kind: "chain",
        name,
        chain: { key: chainKey, name },
        placeId: null,
        address: null,
        lat: null,
        lon: null,
        region: raw.region || null,
        tags: raw.tags || [],
        source: raw.source || "builtin",
        updatedAt: now(),
      };
    }

    // Else treat as location
    const placeId = safeStr(raw.placeId || raw.place_id || raw.id);
    const chainName = safeStr(
      raw.chainName || raw.chain || raw.brand || raw.brandName
    );
    const chainKey = chainName ? normKey(chainName) : null;

    const id = placeId
      ? `place:${placeId}`
      : `loc:${stableHash(JSON.stringify(raw))}`;

    return {
      id,
      kind: "location",
      name: raw.name || chainName || "Store",
      chain: chainKey ? { key: chainKey, name: chainName || chainKey } : null,
      placeId: placeId || null,
      address: raw.address || raw.vicinity || raw.formatted_address || null,
      lat:
        typeof raw.lat === "number"
          ? raw.lat
          : raw.geometry?.location?.lat ?? null,
      lon:
        typeof raw.lon === "number"
          ? raw.lon
          : raw.geometry?.location?.lng ?? null,
      region: raw.region || null,
      tags: raw.tags || [],
      source: raw.source || "provider",
      updatedAt: now(),
    };
  }

  /**
   * Select a store (chain or location) into the active selection set.
   * Stores entity in cache (Dexie if available; local fallback).
   */
  async selectStore(store) {
    await this.init();
    const s = this.normalizeStore(store);
    if (!s?.id) return null;

    await this._putStoreEntity(s);

    const selected = await this.getSelectedStores();
    if (!selected.some((x) => String(x.id) === String(s.id))) {
      const next = [s, ...selected];
      await this._setSelectedStoreIds(next.map((x) => x.id));
      const storeSetKey = await this.computeStoreSetKey(next);
      this.eventBus.emit?.("shopping:store.selected", { store: s });
      this.eventBus.emit?.("shopping:stores.updated", {
        selected: next,
        storeSetKey,
      });
      return { selected: next, storeSetKey };
    }

    const storeSetKey = await this.computeStoreSetKey(selected);
    return { selected, storeSetKey };
  }

  async removeStore(storeId) {
    await this.init();
    const id = safeStr(storeId);
    const selected = await this.getSelectedStores();
    const next = selected.filter((x) => String(x.id) !== String(id));
    await this._setSelectedStoreIds(next.map((x) => x.id));
    const storeSetKey = await this.computeStoreSetKey(next);
    this.eventBus.emit?.("shopping:store.removed", { storeId: id });
    this.eventBus.emit?.("shopping:stores.updated", {
      selected: next,
      storeSetKey,
    });
    return { selected: next, storeSetKey };
  }

  async clearSelectedStores() {
    await this.init();
    await this._setSelectedStoreIds([]);
    const storeSetKey = await this.computeStoreSetKey([]);
    this.eventBus.emit?.("shopping:stores.updated", {
      selected: [],
      storeSetKey,
    });
    return { selected: [], storeSetKey };
  }

  async getSelectedStores() {
    await this.init();

    // If Dexie "sets" table exists, prefer it; otherwise use local selection list.
    const ids = await this._getSelectedStoreIds();
    const entities = [];
    for (const id of ids) {
      const s = await this._getStoreEntity(id);
      if (s) entities.push(s);
    }
    return entities;
  }

  /**
   * Compute stable storeSetKey:
   * - For a location store: use id "place:..." or "loc:..."
   * - For a chain store: use "chain:..."
   * - Sort ids so selection order doesn't change key
   */
  async computeStoreSetKey(stores) {
    const list = Array.isArray(stores) ? stores : [];
    const ids = list
      .map((s) => safeStr(s?.id))
      .filter(Boolean)
      .sort();
    const base = ids.join("|");
    return base ? `ss:${stableHash(base)}` : `ss:${stableHash("empty")}`;
  }

  /**
   * Normalize "chain vs specific location":
   * - If user selected a specific location, prefer that
   * - If only chain exists, use chain representation
   *
   * Returns:
   * { currentStore, stores } where stores is the selected set
   */
  async normalizeSelection({ preferLocation = true } = {}) {
    const selected = await this.getSelectedStores();
    if (!selected.length)
      return {
        currentStore: null,
        stores: [],
        storeSetKey: await this.computeStoreSetKey([]),
      };

    let currentStore = selected[0];
    if (preferLocation) {
      const loc = selected.find((s) => s.kind === "location");
      if (loc) currentStore = loc;
    }

    const storeSetKey = await this.computeStoreSetKey(selected);
    return { currentStore, stores: selected, storeSetKey };
  }

  /* ------------------------------ Persistence helpers ------------------------------ */

  async _putStoreEntity(store) {
    const t = this._tables.stores;
    if (t?.put) {
      try {
        await t.put(store);
        return store;
      } catch {}
    }
    return this.local.putEntity(store);
  }

  async _getStoreEntity(id) {
    const key = safeStr(id);
    if (!key) return null;

    const t = this._tables.stores;
    if (t?.get) {
      try {
        const hit = await t.get(String(key));
        if (hit) return hit;
      } catch {}
    }
    return this.local.getEntity(key);
  }

  async _getSelectedStoreIds() {
    // Dexie sets table shape (if present):
    // { id: "default", selectedIds: ["chain:walmart", "place:..."], updatedAt }
    const t = this._tables.sets;
    if (t?.get) {
      try {
        const row = await t.get("default");
        const ids = Array.isArray(row?.selectedIds) ? row.selectedIds : [];
        if (ids.length) return ids;
      } catch {}
    }
    return this.local.getSelected();
  }

  async _setSelectedStoreIds(ids) {
    const nextIds = Array.isArray(ids) ? ids : [];
    const t = this._tables.sets;
    if (t?.put) {
      try {
        await t.put({ id: "default", selectedIds: nextIds, updatedAt: now() });
      } catch {
        // fallthrough
      }
    }
    this.local.setSelected(nextIds);
  }
}
