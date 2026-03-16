// C:\Users\larho\suka-smart-assistant\src\services\storageService.js
// Suka Smart Assistant – Offline-first Storage Service
// -----------------------------------------------------------------------------
// PURPOSE
// - Unified, defensive storage layer for SSA so your import pipeline, engines,
//   and automation runtime can all read/write data the same way – even offline.
// - Wraps Dexie (preferred, structured, indexed) and falls back to localForage
//   or window.localStorage when Dexie is not present.
// - Emits SSA-format events for observability: { type, ts, source, data }.
// - Detects when you're writing HOUSEHOLD-CHANGING domains (inventory/*,
//   storehouse/*, garden/*, animal/*, preservation/*) and forwards those writes
//   to the Hub via dataGateway.exportIfEnabled(...), but ONLY if familyFundMode=true.
// - Designed to be safe in browser-only environments (no Node-only APIs).
//
// HOW IT FITS
// imports → intelligence → automation → (optional) hub export
// - imports: scraperService / ImportService will persist normalized payloads here
// - intelligence: engines (meal, cleaning, garden, animal, storehouse) can read/write
// - automation: RelativeScheduler, NBA nudges can persist schedules/favorites
// - (optional) hub export: when a write clearly affects household data, we ship it out
//
// NOTES
// - We keep the API small and boring: init, get, set, remove, list, clearDomain,
//   bulkSet, exportStore, importStore.
// - “Domains” here are logical: "inventory", "storehouse", "garden", "cleaning", etc.
// - You can extend DOMAIN_EXPORT_RULES below to support new SSA domains.
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

const isBrowser = typeof window !== "undefined";

// ------------------------------ Defensive imports ----------------------------
let Dexie = null;
try {
  // eslint-disable-next-line global-require
  Dexie = require("dexie");
} catch (_e) {
  // ok – we will fall back
}

let localforage = null;
try {
  // eslint-disable-next-line global-require
  localforage = require("localforage");
} catch (_e) {
  // ok – we will fall back
}

let eventBus = { emit() {}, on() {}, off() {} };
try {
  // eslint-disable-next-line global-require
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line global-require
  const ff = require("@/config/featureFlags.json");
  featureFlags = ff || featureFlags;
} catch (_e) {}

let dataGateway = null;
try {
  // eslint-disable-next-line global-require
  // we only need exportIfEnabled
  const dg = require("@/services/dataGateway");
  dataGateway = dg.dataGateway || dg;
} catch (_e) {
  // optional
}

// ------------------------------ Constants ------------------------------------
const DB_NAME = "suka-smart-assistant";
const DB_VERSION = 1;

// We will create logical tables if Dexie is available
const DEXIE_SCHEMA = {
  imports: "++id, type, url, createdAt", // normalized imports
  sessions: "++id, domain, sessionId, createdAt", // generated sessions
  inventory: "++id, key, updatedAt", // inventory entries
  storehouse: "++id, key, updatedAt", // pantry / storehouse
  settings: "key", // app/user prefs
  cache: "key", // misc
};

// Domains that – when written – should ALSO be piped to Hub (if enabled)
const DOMAIN_EXPORT_RULES = [
  "inventory",
  "storehouse",
  "garden",
  "harvest",
  "animal",
  "butchery",
  "preservation",
  // you can add "construction", "logistics", "susu" later
];

// ------------------------------ Helpers --------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function emitSSA(type, data = {}, source = "storageService") {
  const evt = { type, ts: nowIso(), source, data };
  try {
    eventBus.emit(type, evt);
  } catch (_e) {}
  if (isBrowser) {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail: evt }));
    } catch (_e) {}
    try {
      const bus = window.__suka?.eventBus;
      if (bus?.emit) bus.emit(type, evt);
    } catch (_e) {}
  }
  return evt;
}

function isHouseholdDomain(domain) {
  if (!domain) return false;
  return DOMAIN_EXPORT_RULES.includes(domain);
}

async function exportToHubIfEnabled(domain, action, payload) {
  if (!isHouseholdDomain(domain)) return;
  if (!dataGateway || typeof dataGateway.exportIfEnabled !== "function") return;
  // fire-and-forget
  try {
    await dataGateway.exportIfEnabled(domain, action, payload, {
      source: "storageService",
      storedAt: nowIso(),
    });
  } catch (_e) {
    // must fail silently
  }
}

// ------------------------------ Dexie setup ----------------------------------
let dexieDb = null;

function initDexie() {
  if (!Dexie) return null;
  const db = new Dexie(DB_NAME);
  db.version(DB_VERSION).stores(DEXIE_SCHEMA);
  return db;
}

// ------------------------------ Fallback storage -----------------------------
// For environments with no Dexie AND no localforage → use localStorage
const localStorageStore = {
  async getItem(key) {
    if (!isBrowser) return null;
    const raw = window.localStorage.getItem(key);
    try {
      return JSON.parse(raw);
    } catch (_e) {
      return raw;
    }
  },
  async setItem(key, value) {
    if (!isBrowser) return;
    const val = typeof value === "string" ? value : JSON.stringify(value);
    window.localStorage.setItem(key, val);
  },
  async removeItem(key) {
    if (!isBrowser) return;
    window.localStorage.removeItem(key);
  },
  async keys() {
    if (!isBrowser) return [];
    return Object.keys(window.localStorage);
  },
  async clear() {
    if (!isBrowser) return;
    window.localStorage.clear();
  },
};

// ------------------------------ Core Service ---------------------------------
export const storageService = {
  /**
   * initialize storage – should be called at app start
   */
  init() {
    // Dexie first
    if (Dexie) {
      dexieDb = initDexie();
      emitSSA("storage.init", { engine: "dexie", dbName: DB_NAME });
      return { engine: "dexie", db: dexieDb };
    }

    // localforage next
    if (localforage) {
      localforage.config({
        name: DB_NAME,
        storeName: "suka_store",
      });
      emitSSA("storage.init", { engine: "localforage", dbName: DB_NAME });
      return { engine: "localforage" };
    }

    // final fallback
    emitSSA("storage.init", { engine: "localStorage", dbName: DB_NAME });
    return { engine: "localStorage" };
  },

  /**
   * generic set
   * @param {string} domain e.g. "inventory", "storehouse", "garden", "imports"
   * @param {string} key unique id or name within domain
   * @param {any} value
   */
  async set(domain, key, value) {
    if (!domain || !key) return;

    // Dexie structured
    if (dexieDb) {
      const table = dexieDb[domain] || dexieDb.cache;
      const payload = {
        key,
        value,
        domain,
        updatedAt: nowIso(),
      };
      await table.put(payload);
      emitSSA("storage.write", {
        domain,
        key,
        size: value ? JSON.stringify(value).length : 0,
      });

      // export if householdy
      await exportToHubIfEnabled(domain, "updated", { key, value });
      return;
    }

    // localforage
    if (localforage) {
      const fullKey = `${domain}:${key}`;
      await localforage.setItem(fullKey, value);
      emitSSA("storage.write", { domain, key });
      await exportToHubIfEnabled(domain, "updated", { key, value });
      return;
    }

    // localStorage
    const fullKey = `${domain}:${key}`;
    await localStorageStore.setItem(fullKey, value);
    emitSSA("storage.write", { domain, key });
    await exportToHubIfEnabled(domain, "updated", { key, value });
  },

  /**
   * generic get
   */
  async get(domain, key) {
    if (!domain || !key) return null;

    if (dexieDb) {
      const table = dexieDb[domain] || dexieDb.cache;
      const found = await table.where("key").equals(key).first();
      emitSSA("storage.read", { domain, key, hit: !!found });
      return found ? found.value : null;
    }

    if (localforage) {
      const fullKey = `${domain}:${key}`;
      const val = await localforage.getItem(fullKey);
      emitSSA("storage.read", { domain, key, hit: val != null });
      return val;
    }

    const fullKey = `${domain}:${key}`;
    const val = await localStorageStore.getItem(fullKey);
    emitSSA("storage.read", { domain, key, hit: val != null });
    return val;
  },

  /**
   * delete
   */
  async remove(domain, key) {
    if (!domain || !key) return;

    if (dexieDb) {
      const table = dexieDb[domain] || dexieDb.cache;
      const found = await table.where("key").equals(key).first();
      if (found?.id) {
        await table.delete(found.id);
      }
      emitSSA("storage.delete", { domain, key });
      // household deletion → send as "removed"
      await exportToHubIfEnabled(domain, "removed", { key });
      return;
    }

    if (localforage) {
      const fullKey = `${domain}:${key}`;
      await localforage.removeItem(fullKey);
      emitSSA("storage.delete", { domain, key });
      await exportToHubIfEnabled(domain, "removed", { key });
      return;
    }

    const fullKey = `${domain}:${key}`;
    await localStorageStore.removeItem(fullKey);
    emitSSA("storage.delete", { domain, key });
    await exportToHubIfEnabled(domain, "removed", { key });
  },

  /**
   * list all items in a domain (Dexie only).
   * For localforage/localStorage we filter by prefix.
   */
  async list(domain) {
    if (!domain) return [];

    if (dexieDb) {
      const table = dexieDb[domain] || dexieDb.cache;
      const all = await table.toArray();
      emitSSA("storage.list", { domain, count: all.length });
      return all.map((x) => ({
        key: x.key,
        value: x.value,
        updatedAt: x.updatedAt,
      }));
    }

    if (localforage) {
      const out = [];
      await localforage.iterate((val, k) => {
        if (k.startsWith(`${domain}:`)) {
          out.push({ key: k.slice(domain.length + 1), value: val });
        }
      });
      emitSSA("storage.list", { domain, count: out.length });
      return out;
    }

    // localStorage
    const keys = await localStorageStore.keys();
    const out = [];
    for (const k of keys) {
      if (k.startsWith(`${domain}:`)) {
        const val = await localStorageStore.getItem(k);
        out.push({ key: k.slice(domain.length + 1), value: val });
      }
    }
    emitSSA("storage.list", { domain, count: out.length });
    return out;
  },

  /**
   * bulk set – good for sync from import pipeline
   * items: [{ key, value }]
   */
  async bulkSet(domain, items = []) {
    if (!domain || !Array.isArray(items) || items.length === 0) return;

    if (dexieDb) {
      const table = dexieDb[domain] || dexieDb.cache;
      const toPut = items.map((it) => ({
        key: it.key,
        value: it.value,
        domain,
        updatedAt: nowIso(),
      }));
      await table.bulkPut(toPut);
      emitSSA("storage.write.bulk", { domain, count: items.length });
      // export household data (single combined payload)
      if (isHouseholdDomain(domain)) {
        await exportToHubIfEnabled(domain, "bulkUpdated", { items });
      }
      return;
    }

    // fallbacks – just loop
    for (const it of items) {
      // eslint-disable-next-line no-await-in-loop
      await this.set(domain, it.key, it.value);
    }
  },

  /**
   * clear an entire domain
   */
  async clearDomain(domain) {
    if (!domain) return;

    if (dexieDb) {
      const table = dexieDb[domain] || dexieDb.cache;
      await table.clear();
      emitSSA("storage.clear", { domain });
      // clear is still a household-affecting op
      await exportToHubIfEnabled(domain, "cleared", { domain });
      return;
    }

    if (localforage) {
      // localforage can't clear by prefix → iterate
      const removals = [];
      await localforage.iterate((val, k) => {
        if (k.startsWith(`${domain}:`)) {
          removals.push(k);
        }
      });
      // eslint-disable-next-line no-restricted-syntax
      for (const k of removals) {
        // eslint-disable-next-line no-await-in-loop
        await localforage.removeItem(k);
      }
      emitSSA("storage.clear", { domain, count: removals.length });
      await exportToHubIfEnabled(domain, "cleared", { domain });
      return;
    }

    // localStorage
    const keys = await localStorageStore.keys();
    const removals = keys.filter((k) => k.startsWith(`${domain}:`));
    // eslint-disable-next-line no-restricted-syntax
    for (const k of removals) {
      // eslint-disable-next-line no-await-in-loop
      await localStorageStore.removeItem(k);
    }
    emitSSA("storage.clear", { domain, count: removals.length });
    await exportToHubIfEnabled(domain, "cleared", { domain });
  },

  /**
   * export entire storage (for backup / debug / migration)
   * NOTE: this can be large
   */
  async exportStore() {
    const snapshot = {
      exportedAt: nowIso(),
      engine: dexieDb ? "dexie" : localforage ? "localforage" : "localStorage",
      data: {},
    };

    if (dexieDb) {
      const domains = Object.keys(DEXIE_SCHEMA);
      // eslint-disable-next-line no-restricted-syntax
      for (const d of domains) {
        // eslint-disable-next-line no-await-in-loop
        const all = await dexieDb[d].toArray();
        snapshot.data[d] = all;
      }
    } else if (localforage) {
      const all = {};
      await localforage.iterate((val, k) => {
        all[k] = val;
      });
      snapshot.data.localforage = all;
    } else {
      const all = {};
      const keys = await localStorageStore.keys();
      // eslint-disable-next-line no-restricted-syntax
      for (const k of keys) {
        // eslint-disable-next-line no-await-in-loop
        all[k] = await localStorageStore.getItem(k);
      }
      snapshot.data.localStorage = all;
    }

    emitSSA("storage.exported", { size: JSON.stringify(snapshot).length });
    return snapshot;
  },

  /**
   * import entire storage (from exportStore)
   * Good for offline → online sync or for first-time device setup
   */
  async importStore(snapshot = {}) {
    if (!snapshot || typeof snapshot !== "object") return;

    // Dexie target
    if (dexieDb && snapshot.data) {
      const domains = Object.keys(snapshot.data);
      // eslint-disable-next-line no-restricted-syntax
      for (const d of domains) {
        const arr = snapshot.data[d];
        if (!Array.isArray(arr)) continue;
        // eslint-disable-next-line no-await-in-loop
        await this.bulkSet(
          d,
          arr.map((x) => ({ key: x.key, value: x.value }))
        );
      }
    } else {
      // fallback – import as localStorage prefixes
      if (snapshot.data?.localforage) {
        // eslint-disable-next-line no-restricted-syntax
        for (const [k, v] of Object.entries(snapshot.data.localforage)) {
          // eslint-disable-next-line no-await-in-loop
          await localStorageStore.setItem(k, v);
        }
      }
      if (snapshot.data?.localStorage) {
        // eslint-disable-next-line no-restricted-syntax
        for (const [k, v] of Object.entries(snapshot.data.localStorage)) {
          // eslint-disable-next-line no-await-in-loop
          await localStorageStore.setItem(k, v);
        }
      }
    }

    emitSSA("storage.imported", { domains: Object.keys(snapshot.data || {}) });
  },
};

// auto-init in browser so early imports can write
if (isBrowser) {
  try {
    storageService.init();
  } catch (_e) {
    // ignore, will lazily init on first call
  }
}
