/* eslint-disable no-console */
// LocalDexieAdapter.js — IndexedDB/Dexie KV adapter (ES2015-safe)
// Shape: { name, ready, init(), get(key), set(key,val), del(key), keys(prefix), bulkGet(keys), bulkSet(entries) }
// Notes:
// - Uses a simple KV table with primary key '&key' (indexed) so .where('key').startsWith(prefix) is fast
// - Emits plan.saved & nba.signal for plan keys (plans:<scope>:<id>) to keep orchestration in sync
// - Defensive imports: runs no-op if Dexie is missing; caller will fall back to other adapters

(function () {
  var logger = console;

  /* --------------------------- Defensive imports --------------------------- */
  var Dexie = null;
  try { Dexie = require("dexie"); } catch (_e) {}

  var eventBus = { emit: function(){}, on: function(){}, off: function(){} };
  try {
    var eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  var automation = null;
  try {
    var rt = require("@/services/automation/runtime");
    automation = (rt && (rt.automation || rt.default)) || null;
  } catch (_e) {}

  var clamp = function(n,a,b){ return Math.max(a, Math.min(b, n)); };
  var now = function(){ return Date.now(); };
  var isStr = function (v){ return typeof v === "string"; };

  /* ------------------------------- Adapter --------------------------------- */
  function LocalDexieAdapter(options) {
    options = options || {};
    this.name = "dexie";
    this.ready = false;

    this._dbName = options.dbName || "suka_smart_assistant";
    this._kvTable = options.table || "kv";
    this._metaTable = "meta";

    this._db = null;
    this._version = clamp(options.version || 1, 1, 99);
  }

  LocalDexieAdapter.prototype._open = async function() {
    if (!Dexie) { this.ready = false; return; }

    // Create DB and schema
    var db = new Dexie(this._dbName);
    // v1 schema: simple KV table with primary key on 'key'
    db.version(1).stores({
      kv: "&key",         // key -> value
      meta: "&name"       // simple metadata store (e.g., migrations)
    });

    // Future schema bumps go here:
    // db.version(2).stores({ ... }).upgrade(tx => { ... });

    this._db = db;
    await db.open();
    this.ready = true;
  };

  LocalDexieAdapter.prototype.init = async function() {
    try {
      await this._open();
      if (!this.ready) return;

      // Optionally record adapter meta
      try {
        await this._db[this._metaTable].put({ name: "adapter", value: { kind: "LocalDexieAdapter", at: now() } });
      } catch (_e) {}

      // No outbox needed locally; just ready to serve
      return;
    } catch (e) {
      logger.warn("[LocalDexieAdapter] init failed; falling back", e);
      this.ready = false;
      return;
    }
  };

  /* -------------------------------- Primitives ----------------------------- */
  LocalDexieAdapter.prototype.get = async function(key) {
    if (!this.ready || !this._db) return undefined;
    try {
      var row = await this._db[this._kvTable].get(key);
      return row ? row.value : undefined;
    } catch (_e) {
      return undefined;
    }
  };

  LocalDexieAdapter.prototype.set = async function(key, value) {
    if (!this.ready || !this._db) return;
    try {
      await this._db[this._kvTable].put({ key: key, value: value });

      // Domain-aware orchestration nudges for plan writes
      // keys look like: plans:<scope>:<id>
      if (isStr(key) && key.indexOf("plans:") === 0 && value && value.id) {
        try {
          eventBus.emit("plan.saved", {
            id: value.id,
            domain: value.domain,
            scope: value.scope,
            userId: (value.meta && value.meta.createdBy) || undefined,
            version: value.meta && value.meta.version,
            at: now()
          });
          automation && automation.emit && automation.emit("nba.signal", {
            kind: "plan.saved",
            domain: value.domain,
            planId: value.id,
            userId: (value.meta && value.meta.createdBy) || undefined,
            ts: now()
          });
        } catch (_e) {}
      }

      return;
    } catch (_e) {
      // Dexie writes rarely fail offline; if they do, we can't store locally.
      return;
    }
  };

  LocalDexieAdapter.prototype.del = async function(key) {
    if (!this.ready || !this._db) return;
    try {
      await this._db[this._kvTable].delete(key);
      return;
    } catch (_e) {
      return;
    }
  };

  LocalDexieAdapter.prototype.keys = async function(prefix) {
    if (!this.ready || !this._db) return [];
    try {
      if (!prefix) {
        // Enumerate all keys (avoid toArray for giant stores; but acceptable here)
        var rows = await this._db[this._kvTable].toCollection().primaryKeys();
        return rows || [];
      }
      // Primary key is indexed; startsWith is efficient
      var keys = await this._db[this._kvTable]
        .where("key")
        .startsWith(prefix)
        .primaryKeys();
      return keys || [];
    } catch (_e) {
      return [];
    }
  };

  LocalDexieAdapter.prototype.bulkGet = async function(keys) {
    if (!this.ready || !this._db) return (keys || []).map(function(){ return undefined; });
    try {
      var table = this._db[this._kvTable];
      var found = await table.bulkGet(keys || []);
      // bulkGet returns array of rows in the same order
      return (found || []).map(function(row){ return row ? row.value : undefined; });
    } catch (_e) {
      return (keys || []).map(function(){ return undefined; });
    }
  };

  LocalDexieAdapter.prototype.bulkSet = async function(entries) {
    if (!this.ready || !this._db) return;
    if (!Array.isArray(entries) || !entries.length) return;
    var db = this._db;
    try {
      await db.transaction("rw", db[this._kvTable], async function () {
        // We could use bulkPut directly, but we also want to emit orchestration for plan rows
        // so we iterate (still inside a single tx).
        for (var i=0;i<entries.length;i++){
          var e = entries[i];
          if (!e || !isStr(e.key)) continue;
          await db.kv.put({ key: e.key, value: e.value });
        }
      });

      // Emit plan.saved for plan items (outside tx to avoid blocking)
      try {
        for (var j=0;j<entries.length;j++){
          var ent = entries[j];
          if (ent && isStr(ent.key) && ent.key.indexOf("plans:") === 0 && ent.value && ent.value.id) {
            eventBus.emit("plan.saved", {
              id: ent.value.id,
              domain: ent.value.domain,
              scope: ent.value.scope,
              userId: (ent.value.meta && ent.value.meta.createdBy) || undefined,
              version: ent.value.meta && ent.value.meta.version,
              at: now()
            });
            automation && automation.emit && automation.emit("nba.signal", {
              kind: "plan.saved",
              domain: ent.value.domain,
              planId: ent.value.id,
              userId: (ent.value.meta && ent.value.meta.createdBy) || undefined,
              ts: now()
            });
          }
        }
      } catch (_e) {}

      return;
    } catch (e) {
      logger.warn("[LocalDexieAdapter] bulkSet failed", e);
      return;
    }
  };

  /* ------------------------------ Factory/export --------------------------- */
  function createLocalDexieAdapter(options) {
    return new LocalDexieAdapter(options || {});
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      LocalDexieAdapter: LocalDexieAdapter,
      createLocalDexieAdapter: createLocalDexieAdapter
    };
  } else {
    // @ts-ignore
    window.LocalDexieAdapter = LocalDexieAdapter;
    // @ts-ignore
    window.createLocalDexieAdapter = createLocalDexieAdapter;
  }
})();
