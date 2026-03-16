/* eslint-disable no-console */
// PlanStorageRouter.js — domain-aware storage facade for plans (ES2015-safe)
// - Multi-backend (Dexie -> localStorage -> memory)
// - User-scoped favorites (per-user, per-domain)
// - Contract-aware validation (if Ajv & contracts are available)
// - Event-driven orchestration: emits plan.* and favorite.* events
// - Optimistic versions (etag), soft-delete, import/export, migration hooks

(function () {
  // ------------------------------ Safe Imports ------------------------------
  var logger = console;

  // Event bus (defensive import)
  var eventBus = {
    emit: function () {},
    on: function () {},
    off: function () {},
  };
  try {
    var eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  // Automation runtime (optional) for downstream syncs/NBAs
  var automation = null;
  try {
    automation = require("@/services/automation/runtime").automation || null;
  } catch (_e) {}

  // Ajv validator (optional)
  var Ajv = null;
  try {
    Ajv = require("ajv");
  } catch (_e) {}

  // Dexie (optional)
  var Dexie = null;
  try {
    Dexie = require("dexie");
  } catch (_e) {}

  // Utilities
  var cryptoRandom = function () {
    // Node or browser-safe pseudo random id (fallback)
    var s4 = function () {
      return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .slice(1);
    };
    return (
      s4() +
      s4() +
      "-" +
      s4() +
      "-" +
      s4() +
      "-" +
      s4() +
      "-" +
      s4() +
      s4() +
      s4()
    );
  };

  var nowEpoch = function () {
    return Date.now();
  };
  var isStr = function (v) {
    return typeof v === "string";
  };
  var isObj = function (v) {
    return v && typeof v === "object" && !Array.isArray(v);
  };
  var clamp = function (n, a, b) {
    return Math.max(a, Math.min(b, n));
  };

  // ----------------------------- Contracts (optional) -----------------------------
  // We’ll try to load contracts & register validators per domain/type.
  var contractRegistry = {};
  var ajvInstance = null;

  function tryRegisterContract(domainKey, contractPath) {
    if (!Ajv) return;
    try {
      var schema = require(contractPath);
      if (!ajvInstance) {
        ajvInstance = new Ajv({ allErrors: true, strict: false });
      }
      contractRegistry[domainKey] = ajvInstance.compile(schema);
    } catch (_e) {
      // Contract missing is OK; we operate permissively.
    }
  }

  // Known plan contracts (extend freely)
  // NB: Paths must exist in your repo to activate; otherwise gracefully skipped.
  tryRegisterContract("cleaning", "@/data/contracts/cleanplan.contract.json");
  tryRegisterContract("garden", "@/data/contracts/gardenplan.contract.json");
  tryRegisterContract("meals", "@/data/contracts/mealplan.contract.json"); // if you add it
  tryRegisterContract("animals", "@/data/contracts/animalplan.contract.json"); // if you add it

  function validatePlan(plan) {
    if (!isObj(plan)) return { ok: false, errors: ["Plan must be an object"] };
    var domain = plan.domain || (plan.meta && plan.meta.domain);
    if (domain && contractRegistry[domain]) {
      var valid = contractRegistry[domain](plan);
      if (!valid) {
        return {
          ok: false,
          errors: (contractRegistry[domain].errors || []).map(function (e) {
            return (
              (e.instancePath || e.schemaPath) + " " + (e.message || "invalid")
            );
          }),
        };
      }
    }
    return { ok: true, errors: [] };
  }

  // --------------------------- Storage Adapters ---------------------------
  // Shape: adapter = { name, init(), get(key), set(key, val), del(key), keys(prefix), bulkGet(keys), bulkSet(entries), ready }
  // Namespaces: "plans:*" and "favorites:*"
  function MemoryAdapter() {
    var map = new Map();
    return {
      name: "memory",
      ready: false,
      init: function () {
        this.ready = true;
        return Promise.resolve();
      },
      get: function (key) {
        return Promise.resolve(map.get(key));
      },
      set: function (key, val) {
        map.set(key, val);
        return Promise.resolve();
      },
      del: function (key) {
        map.delete(key);
        return Promise.resolve();
      },
      keys: function (prefix) {
        var out = [];
        map.forEach(function (_v, k) {
          if (!prefix || k.indexOf(prefix) === 0) out.push(k);
        });
        return Promise.resolve(out);
      },
      bulkGet: function (keys) {
        return Promise.resolve(
          keys.map(function (k) {
            return map.get(k);
          })
        );
      },
      bulkSet: function (entries) {
        entries.forEach(function (e) {
          map.set(e.key, e.value);
        });
        return Promise.resolve();
      },
    };
  }

  function LocalStorageAdapter() {
    var hasLS = false;
    try {
      hasLS = typeof window !== "undefined" && !!window.localStorage;
    } catch (_e) {}
    return {
      name: "localStorage",
      ready: false,
      init: function () {
        this.ready = hasLS;
        return Promise.resolve();
      },
      get: function (key) {
        if (!hasLS) return Promise.resolve(undefined);
        var raw = window.localStorage.getItem(key);
        if (raw == null) return Promise.resolve(undefined);
        try {
          return Promise.resolve(JSON.parse(raw));
        } catch (_e) {
          return Promise.resolve(undefined);
        }
      },
      set: function (key, val) {
        if (!hasLS) return Promise.resolve();
        try {
          window.localStorage.setItem(key, JSON.stringify(val));
        } catch (_e) {}
        return Promise.resolve();
      },
      del: function (key) {
        if (!hasLS) return Promise.resolve();
        try {
          window.localStorage.removeItem(key);
        } catch (_e) {}
        return Promise.resolve();
      },
      keys: function (prefix) {
        if (!hasLS) return Promise.resolve([]);
        var out = [];
        for (var i = 0; i < window.localStorage.length; i++) {
          var k = window.localStorage.key(i);
          if (!prefix || (k && k.indexOf(prefix) === 0)) out.push(k);
        }
        return Promise.resolve(out);
      },
      bulkGet: function (keys) {
        var self = this;
        return Promise.all(
          keys.map(function (k) {
            return self.get(k);
          })
        );
      },
      bulkSet: function (entries) {
        var self = this;
        return Promise.all(
          entries.map(function (e) {
            return self.set(e.key, e.value);
          })
        ).then(function () {});
      },
    };
  }

  function DexieAdapter(dbName) {
    var db = null;
    return {
      name: "dexie",
      ready: false,
      init: function () {
        if (!Dexie) {
          this.ready = false;
          return Promise.resolve();
        }
        db = new Dexie(dbName || "suka_smart_assistant");
        db.version(1).stores({
          kv: "&key", // simple key-value store
        });
        this.ready = true;
        return db.open().then(function () {});
      },
      get: function (key) {
        if (!this.ready) return Promise.resolve(undefined);
        return db.kv.get(key).then(function (row) {
          return row ? row.value : undefined;
        });
      },
      set: function (key, val) {
        if (!this.ready) return Promise.resolve();
        return db.kv.put({ key: key, value: val }).then(function () {});
      },
      del: function (key) {
        if (!this.ready) return Promise.resolve();
        return db.kv.delete(key).then(function () {});
      },
      keys: function (prefix) {
        if (!this.ready) return Promise.resolve([]);
        // Dexie doesn’t index prefixes for us; we’ll scan.
        return db.kv.toArray().then(function (rows) {
          var out = [];
          rows.forEach(function (r) {
            if (!prefix || r.key.indexOf(prefix) === 0) out.push(r.key);
          });
          return out;
        });
      },
      bulkGet: function (keys) {
        if (!this.ready)
          return Promise.resolve(
            keys.map(function () {
              return undefined;
            })
          );
        return Promise.all(
          keys.map(function (k) {
            return db.kv.get(k).then(function (r) {
              return r ? r.value : undefined;
            });
          })
        );
      },
      bulkSet: function (entries) {
        if (!this.ready) return Promise.resolve();
        return db
          .transaction("rw", db.kv, function () {
            entries.forEach(function (e) {
              db.kv.put({ key: e.key, value: e.value });
            });
          })
          .then(function () {});
      },
    };
  }

  function chooseAdapter() {
    var dx = DexieAdapter();
    return dx.init().then(function () {
      if (dx.ready) return dx;
      var ls = LocalStorageAdapter();
      return ls.init().then(function () {
        if (ls.ready) return ls;
        var mem = MemoryAdapter();
        return mem.init().then(function () {
          return mem;
        });
      });
    });
  }

  // --------------------------- PlanStorageRouter ---------------------------
  function PlanStorageRouter(opts) {
    opts = opts || {};
    this.userId = opts.userId || null; // null is allowed; user-scoped calls must provide explicit userId if so.
    this.namespace = opts.namespace || "plans";
    this.eventBus = opts.eventBus || eventBus;
    this.automation = opts.automation || automation;
    this.adapter = null;
    this.ready = false;

    // Versioning / migrations
    this.xVersion = "1.2.0"; // bump when storage shape changes

    // knobs
    this.maxList = clamp(opts.maxList || 500, 50, 5000);
  }

  PlanStorageRouter.prototype.init = function () {
    var self = this;
    if (self.ready && self.adapter) return Promise.resolve(self);
    return chooseAdapter()
      .then(function (adapter) {
        self.adapter = adapter;
        self.ready = true;
        return self._ensureIndexes();
      })
      .then(function () {
        return self;
      });
  };

  // Placeholder for future index-building in Dexie; no-op for kv
  PlanStorageRouter.prototype._ensureIndexes = function () {
    return Promise.resolve();
  };

  // ------------------------------- Keying --------------------------------
  PlanStorageRouter.prototype._keyPlan = function (scope, planId) {
    // scope: "global" or "user:<id>"
    return this.namespace + ":" + scope + ":" + planId;
  };
  PlanStorageRouter.prototype._keyFav = function (userId) {
    return "favorites:user:" + userId;
  };
  PlanStorageRouter.prototype._keyAllPrefix = function (scope) {
    return this.namespace + ":" + scope + ":";
  };

  PlanStorageRouter.prototype._resolveScope = function (scope, userId) {
    if (scope === "global") return "global";
    var uid = userId || this.userId;
    return uid ? "user:" + uid : "global";
  };

  // ---------------------------- Normalization ----------------------------
  PlanStorageRouter.prototype._normalize = function (plan) {
    var clone = JSON.parse(JSON.stringify(plan || {}));
    if (!clone.id) clone.id = (clone.kind || "plan") + ":" + cryptoRandom();
    if (!clone.meta) clone.meta = {};
    if (!clone.meta.createdAt) clone.meta.createdAt = nowEpoch();
    clone.meta.updatedAt = nowEpoch();
    if (!clone.meta.version) clone.meta.version = 1;
    if (!clone.domain && clone.meta.domain) clone.domain = clone.meta.domain; // accept either
    if (!clone.domain) clone.domain = "general";
    if (!clone.title) clone.title = "Untitled Plan";
    return clone;
  };

  // ------------------------------ Favorites ------------------------------
  PlanStorageRouter.prototype._loadFavorites = function (userId) {
    var self = this;
    if (!userId) return Promise.resolve({ byId: {} });
    return self.adapter.get(self._keyFav(userId)).then(function (val) {
      if (val && isObj(val) && val.byId) return val;
      return { byId: {} };
    });
  };

  PlanStorageRouter.prototype._saveFavorites = function (userId, favObj) {
    var self = this;
    if (!userId) return Promise.resolve();
    return self.adapter.set(self._keyFav(userId), favObj);
  };

  PlanStorageRouter.prototype.toggleFavorite = function (opts) {
    // opts: { planId, favorite?:bool, userId, domain? }
    var self = this;
    opts = opts || {};
    var uid = opts.userId || self.userId;
    if (!uid)
      return Promise.reject(new Error("toggleFavorite requires a userId"));
    var domain = opts.domain || null;
    var planId = opts.planId;
    if (!planId)
      return Promise.reject(new Error("toggleFavorite requires planId"));

    return self._loadFavorites(uid).then(function (fav) {
      var existing = !!fav.byId[planId];
      var shouldFav =
        typeof opts.favorite === "boolean" ? opts.favorite : !existing;
      if (shouldFav) {
        fav.byId[planId] = { at: nowEpoch(), domain: domain || undefined };
      } else {
        delete fav.byId[planId];
      }
      return self._saveFavorites(uid, fav).then(function () {
        self.eventBus.emit("favorite.updated", {
          planId: planId,
          userId: uid,
          favorite: shouldFav,
          domain: domain || undefined,
        });
        return { planId: planId, favorite: shouldFav };
      });
    });
  };

  PlanStorageRouter.prototype.listFavorites = function (opts) {
    // opts: { userId, domain?, limit? }
    var self = this;
    opts = opts || {};
    var uid = opts.userId || self.userId;
    if (!uid) return Promise.resolve([]);
    var domain = opts.domain || null;
    var limit = clamp(opts.limit || self.maxList, 1, self.maxList);

    return self._loadFavorites(uid).then(function (fav) {
      var ids = Object.keys(fav.byId || {});
      if (domain) {
        ids = ids.filter(function (id) {
          return fav.byId[id] && fav.byId[id].domain === domain;
        });
      }
      ids = ids.slice(0, limit);
      var keys = ids
        .map(function (id) {
          return self._keyPlan("global", id);
        }) // favorites can point to global…
        .concat(
          ids.map(function (id) {
            return self._keyPlan("user:" + uid, id);
          })
        ); // …or user scope; we’ll resolve.
      return self.adapter.bulkGet(keys).then(function (values) {
        // Prefer user-scoped copy over global if both found
        var out = {};
        values.forEach(function (val) {
          if (!val || !val.id) return;
          var existing = out[val.id];
          if (
            !existing ||
            (existing.scope === "global" &&
              val.scope &&
              val.scope.indexOf("user:") === 0)
          ) {
            out[val.id] = val;
          }
        });
        return Object.keys(out).map(function (k) {
          return out[k];
        });
      });
    });
  };

  // ------------------------------ CRUD Plans ------------------------------
  PlanStorageRouter.prototype.savePlan = function (plan, opts) {
    // opts: { scope?: "global"|"user", userId?, overwrite?:bool, favorite?:bool }
    var self = this;
    opts = opts || {};
    var scope = self._resolveScope(opts.scope, opts.userId);
    var normalized = self._normalize(plan);

    // optimistic version bump
    normalized.meta.version = (normalized.meta.version || 0) + 1;
    normalized.scope = scope; // store scope for easier list merges

    var val = validatePlan(normalized);
    if (!val.ok) {
      var err = new Error("Plan validation failed: " + val.errors.join("; "));
      err.details = val.errors;
      return Promise.reject(err);
    }

    var key = self._keyPlan(scope, normalized.id);

    return self.adapter
      .get(key)
      .then(function (existing) {
        if (existing && existing.meta && normalized.meta && !opts.overwrite) {
          // If caller didn't pass overwrite, ensure we aren't clobbering a newer version
          var inVer = (normalized.meta && normalized.meta.version) || 0;
          var exVer = (existing.meta && existing.meta.version) || 0;
          if (inVer <= exVer) {
            normalized.meta.version = exVer + 1; // auto-bump to avoid stale writes
          }
        }
        return self.adapter.set(key, normalized).then(function () {
          if (opts.favorite === true && (opts.userId || self.userId)) {
            return self
              .toggleFavorite({
                planId: normalized.id,
                favorite: true,
                userId: opts.userId || self.userId,
                domain: normalized.domain,
              })
              .then(function () {
                return normalized;
              });
          }
          return normalized;
        });
      })
      .then(function (saved) {
        // Emit orchestration events (domain-aware)
        self.eventBus.emit("plan.saved", {
          id: saved.id,
          domain: saved.domain,
          scope: scope,
          userId: opts.userId || self.userId || undefined,
          version: saved.meta.version,
          at: nowEpoch(),
        });

        // Example: nudge automation runtime (if present)
        if (self.automation && self.automation.emit) {
          try {
            self.automation.emit("plan.saved", {
              id: saved.id,
              domain: saved.domain,
              scope: scope,
              meta: saved.meta,
            });
          } catch (_e) {}
        }

        return saved;
      });
  };

  PlanStorageRouter.prototype.getPlan = function (planId, opts) {
    // opts: { scope?: "global"|"user", userId? } — if scope not provided, we prefer user copy then global
    var self = this;
    opts = opts || {};
    var scope = opts.scope ? self._resolveScope(opts.scope, opts.userId) : null;
    if (scope) {
      return self.adapter.get(self._keyPlan(scope, planId));
    }
    // Try user then global
    var userScope = self._resolveScope("user", opts.userId);
    return self.adapter
      .get(self._keyPlan(userScope, planId))
      .then(function (val) {
        if (val) return val;
        return self.adapter.get(self._keyPlan("global", planId));
      });
  };

  PlanStorageRouter.prototype.listPlans = function (opts) {
    // opts: { scope?: "global"|"user"|"all", userId?, domain?, favoritesOnly?, limit?, includeDeleted? }
    var self = this;
    opts = opts || {};
    var domain = opts.domain || null;
    var includeDeleted = !!opts.includeDeleted;
    var limit = clamp(opts.limit || self.maxList, 1, self.maxList);

    var scopes = [];
    if (opts.scope === "global") scopes = ["global"];
    else if (opts.scope === "user")
      scopes = [self._resolveScope("user", opts.userId)];
    else scopes = [self._resolveScope("user", opts.userId), "global"]; // "all" or undefined

    var prefixKeys = scopes.map(function (sc) {
      return self._keyAllPrefix(sc);
    });

    return Promise.all(
      prefixKeys.map(function (prefix) {
        return self.adapter.keys(prefix);
      })
    ).then(function (allKeyLists) {
      var keys = [];
      allKeyLists.forEach(function (arr) {
        keys = keys.concat(arr);
      });
      // Limit here to cut bulkGet size
      keys = keys.slice(0, limit * 2);
      return self.adapter.bulkGet(keys).then(function (values) {
        var out = values.filter(function (v) {
          if (!v || !v.id) return false;
          if (!includeDeleted && v.meta && v.meta.deletedAt) return false;
          if (domain && v.domain !== domain) return false;
          return true;
        });

        // If favoritesOnly, intersect with favorites
        if (opts.favoritesOnly) {
          var uid = opts.userId || self.userId;
          if (!uid) return [];
          return self._loadFavorites(uid).then(function (fav) {
            var set = fav.byId || {};
            var favd = out.filter(function (p) {
              return !!set[p.id];
            });
            return favd.slice(0, limit);
          });
        }

        // Newest first by updatedAt
        out.sort(function (a, b) {
          var au = (a.meta && a.meta.updatedAt) || 0;
          var bu = (b.meta && b.meta.updatedAt) || 0;
          return bu - au;
        });

        return out.slice(0, limit);
      });
    });
  };

  PlanStorageRouter.prototype.deletePlan = function (planId, opts) {
    // Soft-delete by default
    // opts: { scope?, userId?, hard?:bool }
    var self = this;
    opts = opts || {};
    var scope = self._resolveScope(opts.scope, opts.userId);
    var key = self._keyPlan(scope, planId);
    if (opts.hard) {
      return self.adapter.del(key).then(function () {
        self.eventBus.emit("plan.deleted", {
          id: planId,
          scope: scope,
          domain: opts.domain,
        });
      });
    }
    return self.adapter.get(key).then(function (val) {
      if (!val) return;
      val.meta = val.meta || {};
      val.meta.deletedAt = nowEpoch();
      val.meta.version = (val.meta.version || 0) + 1;
      return self.adapter.set(key, val).then(function () {
        self.eventBus.emit("plan.deleted", {
          id: planId,
          scope: scope,
          domain: val.domain,
          soft: true,
        });
      });
    });
  };

  PlanStorageRouter.prototype.restorePlan = function (planId, opts) {
    var self = this;
    opts = opts || {};
    var scope = self._resolveScope(opts.scope, opts.userId);
    var key = self._keyPlan(scope, planId);
    return self.adapter.get(key).then(function (val) {
      if (!val) return;
      if (val.meta) delete val.meta.deletedAt;
      val.meta.version = (val.meta.version || 0) + 1;
      return self.adapter.set(key, val).then(function () {
        self.eventBus.emit("plan.restored", {
          id: planId,
          scope: scope,
          domain: val.domain,
        });
        return val;
      });
    });
  };

  // ----------------------------- Import/Export -----------------------------
  PlanStorageRouter.prototype.exportPlans = function (opts) {
    // opts: { scope?, userId?, domain?, includeDeleted? }
    var self = this;
    return self
      .listPlans({
        scope: opts && opts.scope,
        userId: opts && opts.userId,
        domain: opts && opts.domain,
        includeDeleted: opts && opts.includeDeleted,
        limit: self.maxList,
      })
      .then(function (plans) {
        return {
          xVersion: self.xVersion,
          exportedAt: nowEpoch(),
          count: plans.length,
          items: plans,
        };
      });
  };

  PlanStorageRouter.prototype.importPlans = function (payload, opts) {
    // payload: { xVersion, items: [] }
    // opts: { scope?, userId?, overwrite? }
    var self = this;
    opts = opts || {};
    if (!payload || !Array.isArray(payload.items))
      return Promise.reject(new Error("Invalid import payload"));
    var scope = self._resolveScope(opts.scope, opts.userId);
    var entries = [];
    var okCount = 0;

    payload.items.forEach(function (plan) {
      var normalized = self._normalize(plan);
      normalized.scope = scope;
      var val = validatePlan(normalized);
      if (val.ok) {
        normalized.meta.version = (normalized.meta.version || 0) + 1;
        entries.push({
          key: self._keyPlan(scope, normalized.id),
          value: normalized,
        });
        okCount++;
      } else {
        logger.warn(
          "[PlanStorageRouter] import validation failed for",
          plan && plan.id,
          val.errors
        );
      }
    });

    return self.adapter.bulkSet(entries).then(function () {
      self.eventBus.emit("plan.imported", { count: okCount, scope: scope });
      return { imported: okCount };
    });
  };

  // ------------------------------- Migrations ------------------------------
  PlanStorageRouter.prototype.migrate = function (handler) {
    // handler receives each plan, returns possibly mutated plan
    var self = this;
    if (typeof handler !== "function") return Promise.resolve({ migrated: 0 });
    return self
      .listPlans({ scope: "all", limit: self.maxList, includeDeleted: true })
      .then(function (plans) {
        var mutated = [];
        plans.forEach(function (p) {
          var np = handler(p);
          if (np && np !== p) {
            np.meta = np.meta || {};
            np.meta.version = (np.meta.version || 0) + 1;
            mutated.push({
              key: self._keyPlan(np.scope || "global", np.id),
              value: np,
            });
          }
        });
        if (!mutated.length) return { migrated: 0 };
        return self.adapter.bulkSet(mutated).then(function () {
          self.eventBus.emit("plan.migrated", {
            count: mutated.length,
            at: nowEpoch(),
          });
          return { migrated: mutated.length };
        });
      });
  };

  // ---------------------------- Session Bridging ----------------------------
  // Convenience hook: when a plan is saved with future-dated schedule, emit domain-aware draft/requests.
  // This aligns with the “shared orchestration updates” and optional domain field you asked for.
  PlanStorageRouter.prototype.afterSaveOrchestrate = function (plan) {
    var self = this;
    if (!plan || !plan.domain) return;
    try {
      // Example triggers — adjust to your agents:
      // • mealplan.draft.requested (params.domain)
      // • grocerylist.requested (domain)
      // • prep.tasks.requested (params.domain)
      // These are *signals*; listeners decide if/when to act.
      var domain = plan.domain;

      self.eventBus.emit("mealplan.draft.requested", {
        id: plan.id,
        params: { domain: domain === "meals" ? "meals" : undefined },
      });
      self.eventBus.emit("grocerylist.requested", {
        planId: plan.id,
        domain: domain === "meals" ? "meals" : undefined,
      });
      self.eventBus.emit("prep.tasks.requested", {
        planId: plan.id,
        params: { domain: domain },
      });

      if (self.automation && self.automation.emit) {
        self.automation.emit("planner.conflict.detected", {
          // This is a sample; real detection occurs elsewhere.
          kind: "time",
          domain: domain,
          planId: plan.id,
          at: nowEpoch(),
          tentative: true,
        });
      }
    } catch (_e) {}
  };

  // --------------------------- Factory / Export ---------------------------
  function createPlanStorageRouter(opts) {
    var r = new PlanStorageRouter(opts);
    return r.init();
  }

  // CommonJS + ESM friendly export
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      PlanStorageRouter: PlanStorageRouter,
      createPlanStorageRouter: createPlanStorageRouter,
    };
  } else {
    // @ts-ignore
    window.PlanStorageRouter = PlanStorageRouter;
    // @ts-ignore
    window.createPlanStorageRouter = createPlanStorageRouter;
  }
})();
