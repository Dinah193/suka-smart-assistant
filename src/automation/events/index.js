/* eslint-disable no-console */
// src/automation/events/index.js — unified event hub (ES2015-safe, browser/node friendly)

(function () {
  // ----------------------------- Safe Imports -----------------------------
  // Prefer named exports, fall back to default, fall back to {}.
  function prefer(mod, ...keys) {
    if (!mod) return {};
    var picked = {};
    keys.forEach(function (k) {
      if (mod[k]) picked[k] = mod[k];
      else if (mod.default && mod.default[k]) picked[k] = mod.default[k];
    });
    // If no specific keys requested, return default-or-mod
    if (!keys.length) return mod.default || mod;
    return picked;
  }

  var _automation = {};
  try {
    _automation = prefer(require("@/services/automation/runtime"));
  } catch (e) {}

  var _nba = {};
  try {
    _nba = prefer(require("@/services/nba/orchestrator"), "refresh", "queueImpulse", "onEvent");
  } catch (e) {}

  var _stability = {};
  try {
    _stability = prefer(require("@/services/stability/score"), "updateSignalsFromEvent");
  } catch (e) {}

  var _milestones = {};
  try {
    _milestones = prefer(require("@/services/milestones/evaluator"), "evaluate");
  } catch (e) {}

  var _reminders = {};
  try {
    _reminders = prefer(require("@/managers/ReminderManager"), "schedule", "cancelByCorrelation");
  } catch (e) {}

  var _inventory = {};
  try {
    _inventory = prefer(require("@/managers/InventoryMonitor"), "onEventSync");
  } catch (e) {}

  var _storage = {};
  try {
    _storage = prefer(require("@/services/storage"), "saveEventTrace", "getEventTrace");
  } catch (e) {}

  var _env = (typeof process !== "undefined" && process.env) ? process.env : {};
  var DEV = !!(_env.NODE_ENV ? _env.NODE_ENV.includes("dev") : true);

  // ----------------------------- Utilities -----------------------------
  var _uid = 0;
  function uid(prefix) { _uid++; return (prefix || "evt") + ":" + Date.now().toString(36) + ":" + _uid.toString(36); }

  function nowIso() { try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); } }

  function shallowMerge(a, b) {
    var out = {}; var k;
    for (k in a || {}) out[k] = a[k];
    for (k in b || {}) out[k] = b[k];
    return out;
  }

  function toArray(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }

  // Topic helpers: "a.b.c" → parent patterns: "a.b.*", "a.*", "*"
  function topicParents(topic) {
    if (!topic) return ["*"];
    var parts = topic.split(".");
    var parents = ["*"];
    if (parts.length > 1) {
      var i;
      for (i = parts.length - 1; i > 0; i--) {
        parents.push(parts.slice(0, i).join(".") + ".*");
      }
    }
    parents.push(topic.replace(/\.[^.]+$/, ".*")); // immediate parent pattern
    return Array.from(new Set(parents));
  }

  function matchTopic(pattern, topic) {
    if (pattern === "*" || pattern === topic) return true;
    // support simple wildcard segment matching: "a.*" or "a.b.*"
    var p = pattern.split(".");
    var t = topic.split(".");
    var i;
    for (i = 0; i < p.length; i++) {
      if (p[i] === "*") return true;
      if (t[i] !== p[i]) return false;
    }
    return p.length === t.length;
  }

  // ----------------------------- Minimal Schema Registry (Optional) -----------------------------
  // Tries to load JSON Schemas if they exist; validates required props only (no AJV dependency).
  var SchemaRegistry = (function () {
    var schemas = {};
    function register(id, schema) { if (id && schema) schemas[id] = schema; }
    function get(id) { return schemas[id]; }
    function tryLoad(path, id) {
      try {
        var sch = require(path);
        register(id || (sch.$id || sch.title || path), sch.default || sch);
      } catch (e) { /* noop */ }
    }
    // Attempt to load common contracts if available
    tryLoad("@/data/contracts/mealplan.contract.json", "urn:suka:contracts:mealplan");
    tryLoad("@/data/contracts/cleanplan.contract.json", "urn:suka:contracts:cleanplan");
    tryLoad("@/data/contracts/gardenplan.contract.json", "urn:suka:contracts:gardenplan");
    tryLoad("@/data/contracts/animalplan.contract.json", "urn:suka:contracts:animalplan");
    tryLoad("@/data/contracts/grocerylist.contract.json", "urn:suka:contracts:grocerylist");

    // very light validator: checks required props (top-level only)
    function validate(id, obj) {
      var sch = get(id);
      if (!sch || !sch.required) return { ok: true };
      var missing = [];
      sch.required.forEach(function (k) {
        if (!(k in (obj || {}))) missing.push(k);
      });
      if (missing.length) return { ok: false, reason: "Missing required: " + missing.join(", ") };
      return { ok: true };
    }

    return { register: register, get: get, validate: validate };
  })();

  // ----------------------------- Event Hub Core -----------------------------
  var _listeners = new Map(); // pattern -> Set(fn)
  var _middleware = [];       // fn(envelope, next)
  var _replay = [];           // last N events for late subscribers
  var _maxReplay = 150;

  function addListener(pattern, fn) {
    if (!_listeners.has(pattern)) _listeners.set(pattern, new Set());
    _listeners.get(pattern).add(fn);
  }

  function removeListener(pattern, fn) {
    if (!_listeners.has(pattern)) return;
    _listeners.get(pattern).delete(fn);
    if (_listeners.get(pattern).size === 0) _listeners.delete(pattern);
  }

  function removeAllListeners(pattern) {
    if (pattern) _listeners.delete(pattern);
    else _listeners.clear();
  }

  function walkListeners(topic) {
    var calls = [];
    _listeners.forEach(function (set, pattern) {
      if (matchTopic(pattern, topic)) {
        set.forEach(function (fn) { calls.push({ pattern: pattern, fn: fn }); });
      }
    });
    return calls;
  }

  function use(mw) { if (typeof mw === "function") _middleware.push(mw); }

  function runMiddleware(envelope, handlers) {
    var idx = -1;
    function next(current) {
      idx++;
      if (idx < _middleware.length) return _middleware[idx](current, next);
      // terminal: dispatch to handlers
      return Promise.resolve().then(function () {
        return Promise.all(handlers.map(function (h) {
          try { return h.fn(current); }
          catch (e) {
            if (DEV) console.error("[events] handler error", h.pattern, current.topic, e);
            return undefined;
          }
        }));
      });
    }
    return next(envelope);
  }

  function normalizeEnvelope(topic, payload, meta) {
    var envelope = shallowMerge({
      eventId: uid("evt"),
      topic: topic,
      ts: nowIso(),
      payload: payload || {},
      // meta:
      version: 1,
      schema: meta && meta.schema,       // e.g., "urn:suka:contracts:mealplan"
      sessionId: meta && meta.sessionId,
      correlationId: (meta && meta.correlationId) || uid("corr"),
      source: (meta && meta.source) || "ui",
      actor: meta && meta.actor,         // { id, name, role }
      priority: (meta && meta.priority) || "normal", // "low" | "normal" | "high"
      tags: toArray(meta && meta.tags),
    }, meta || {});
    return envelope;
  }

  var _seen = new Set();
  function dedupe(envelope) {
    var key = envelope.eventId || (envelope.topic + "|" + JSON.stringify(envelope.payload || {}));
    if (_seen.has(key)) return true;
    _seen.add(key);
    if (_seen.size > 10000) {
      // simple GC
      _seen = new Set(Array.from(_seen).slice(5000));
    }
    return false;
  }

  function recordReplay(envelope) {
    _replay.push(envelope);
    if (_replay.length > _maxReplay) _replay.shift();
    if (_storage.saveEventTrace) {
      try { _storage.saveEventTrace(envelope); } catch (e) {}
    }
  }

  // Public: emit (sync -> async pipeline)
  function emit(topic, payload, meta) {
    var envelope = normalizeEnvelope(topic, payload, meta);
    if (dedupe(envelope)) return Promise.resolve(envelope); // drop duplicate

    // Optional validation if schema provided
    if (envelope.schema) {
      var res = SchemaRegistry.validate(envelope.schema, envelope.payload);
      if (!res.ok && DEV) console.warn("[events] schema check failed:", envelope.schema, res.reason, envelope);
    }

    var handlers = walkListeners(topic);
    // Include parent topic patterns to allow shared orchestration to react
    topicParents(topic).forEach(function (p) {
      walkListeners(p).forEach(function (h) { handlers.push(h); });
    });

    // Core interceptors (early): Stability & Milestones & NBA hooks
    var coreInterceptors = [
      function (env, next) {
        try { if (_stability.updateSignalsFromEvent) _stability.updateSignalsFromEvent(env); } catch (e) {}
        return next(env);
      },
      function (env, next) {
        try { if (_milestones.evaluate) _milestones.evaluate(env); } catch (e) {}
        return next(env);
      },
      function (env, next) {
        try {
          if (_nba.onEvent) _nba.onEvent(env);
          else if (_nba.refresh) _nba.refresh({ reason: "event", topic: env.topic, correlationId: env.correlationId });
        } catch (e) {}
        return next(env);
      },
      function (env, next) {
        // Inventory sync hook (optional)
        try { if (_inventory.onEventSync) _inventory.onEventSync(env); } catch (e) {}
        return next(env);
      },
    ];

    // Compose: core interceptors run before user middleware
    var original = _middleware.slice();
    _middleware = coreInterceptors.concat(original);

    if (DEV) {
      try { console.debug("[events] →", topic, envelope); } catch (e) {}
    }

    recordReplay(envelope);

    return runMiddleware(envelope, handlers).then(function (out) {
      _middleware = original; // restore
      return out;
    });
  }

  // Convenience: fire-and-forget
  function emitSync(topic, payload, meta) {
    emit(topic, payload, meta);
  }

  function on(pattern, fn) { addListener(pattern, fn); return function off() { removeListener(pattern, fn); }; }
  function once(pattern, fn) {
    var off = on(pattern, function handler(env) { try { fn(env); } finally { off(); } });
    return off;
  }
  function onMany(patterns, fn) {
    patterns = toArray(patterns);
    var offs = patterns.map(function (p) { return on(p, fn); });
    return function offAll() { offs.forEach(function (o) { try { o(); } catch (e) {} }); };
  }
  function off(pattern, fn) { removeListener(pattern, fn); }
  function offAll(pattern) { removeAllListeners(pattern); }

  function replay(pattern, limit) {
    var n = Math.max(1, Math.min(limit || 50, _replay.length));
    var recent = _replay.slice(-n);
    if (!pattern) return recent;
    return recent.filter(function (e) { return matchTopic(pattern, e.topic); });
  }

  // ----------------------------- Shared Orchestration Wires -----------------------------
  // These wires connect common topics to reminders/schedulers/NBA without creating tight coupling.
  function registerDefaultWires() {
    // Session lifecycle → scheduler windowing & pause-aware reminders
    onMany(["session.started", "session.resumed"], function (env) {
      // Allow runtime to seed time-based nudges relative to now
      try { if (_automation.seedSessionTimers) _automation.seedSessionTimers(env); } catch (e) {}
    });

    on("session.paused", function (env) {
      // Pause-aware tasks: marinating, proofing, chilling, curing, etc.
      try { if (_automation.pauseDeferrables) _automation.pauseDeferrables(env); } catch (e) {}
      try { if (_reminders.cancelByCorrelation) _reminders.cancelByCorrelation(env.correlationId); } catch (e) {}
      try { if (_nba.queueImpulse) _nba.queueImpulse({ kind: "resume_hint", topic: env.topic, when: "+15m" }); } catch (e) {}
    });

    on("session.ended", function (env) {
      try { if (_automation.finalizeSessionArtifacts) _automation.finalizeSessionArtifacts(env); } catch (e) {}
    });

    // Plans → Grocery / Inventory / Prep reminders (meals)
    onMany([
      "mealplan.draft.requested",
      "mealplan.draft.updated",
      "mealplan.confirmed",
      "grocerylist.generated",
      "cooking.batch.started",
      "cooking.batch.completed"
    ], function (env) {
      try { if (_automation.routeMealEvent) _automation.routeMealEvent(env); } catch (e) {}
      try { if (_reminders.schedule) _reminders.schedule({ fromEvent: env }); } catch (e) {}
    });

    // Cleaning plans
    onMany([
      "cleanplan.draft.requested",
      "cleanplan.confirmed",
      "cleaning.task.completed"
    ], function (env) {
      try { if (_automation.routeCleanEvent) _automation.routeCleanEvent(env); } catch (e) {}
      try { if (_reminders.schedule) _reminders.schedule({ fromEvent: env }); } catch (e) {}
    });

    // Garden plans
    onMany([
      "gardenplan.draft.requested",
      "gardenplan.confirmed",
      "garden.task.completed",
      "harvest.logged"
    ], function (env) {
      try { if (_automation.routeGardenEvent) _automation.routeGardenEvent(env); } catch (e) {}
      try { if (_reminders.schedule) _reminders.schedule({ fromEvent: env }); } catch (e) {}
    });

    // Animal care / butchery
    onMany([
      "animalplan.draft.requested",
      "animal.care.completed",
      "butchery.batch.completed",
      "coldstorage.updated"
    ], function (env) {
      try { if (_automation.routeAnimalEvent) _automation.routeAnimalEvent(env); } catch (e) {}
      try { if (_reminders.schedule) _reminders.schedule({ fromEvent: env }); } catch (e) {}
    });

    // NBA refresh on key state changes
    onMany([
      "nba.updated",
      "inventory.updated",
      "inventory.low",
      "inventory.restocked",
      "stability.score.changed",
      "milestone.achieved"
    ], function (env) {
      try { if (_nba.refresh) _nba.refresh({ reason: "event", topic: env.topic }); } catch (e) {}
    });
  }

  // ----------------------------- Event Names (Canonical) -----------------------------
  // Centralized constants for discoverability & autocomplete.
  var Events = Object.freeze({
    ANY: "*",

    // Session
    SESSION_STARTED: "session.started",
    SESSION_PAUSED: "session.paused",
    SESSION_RESUMED: "session.resumed",
    SESSION_ENDED: "session.ended",

    // Meals
    MEALPLAN_DRAFT_REQUESTED: "mealplan.draft.requested",
    MEALPLAN_DRAFT_UPDATED: "mealplan.draft.updated",
    MEALPLAN_CONFIRMED: "mealplan.confirmed",
    GROCERYLIST_GENERATED: "grocerylist.generated",
    COOKING_BATCH_STARTED: "cooking.batch.started",
    COOKING_BATCH_COMPLETED: "cooking.batch.completed",

    // Cleaning
    CLEANPLAN_DRAFT_REQUESTED: "cleanplan.draft.requested",
    CLEANPLAN_CONFIRMED: "cleanplan.confirmed",
    CLEANING_TASK_COMPLETED: "cleaning.task.completed",

    // Garden
    GARDENPLAN_DRAFT_REQUESTED: "gardenplan.draft.requested",
    GARDENPLAN_CONFIRMED: "gardenplan.confirmed",
    GARDEN_TASK_COMPLETED: "garden.task.completed",
    HARVEST_LOGGED: "harvest.logged",

    // Animals / Butchery
    ANIMALPLAN_DRAFT_REQUESTED: "animalplan.draft.requested",
    ANIMAL_CARE_COMPLETED: "animal.care.completed",
    BUTCHERY_BATCH_COMPLETED: "butchery.batch.completed",
    COLDSTORAGE_UPDATED: "coldstorage.updated",

    // Cross-cutting
    NBA_UPDATED: "nba.updated",
    INVENTORY_UPDATED: "inventory.updated",
    INVENTORY_LOW: "inventory.low",
    INVENTORY_RESTOCKED: "inventory.restocked",
    STABILITY_CHANGED: "stability.score.changed",
    MILESTONE_ACHIEVED: "milestone.achieved",
  });

  // ----------------------------- Public API -----------------------------
  var api = {
    // listeners
    on: on,
    once: once,
    onMany: onMany,
    off: off,
    offAll: offAll,
    use: use,
    // emitters
    emit: emit,
    emitSync: emitSync,
    // diagnostics
    replay: replay,
    // constants
    Events: Events,
    // schemas (optional)
    SchemaRegistry: SchemaRegistry,
    // wiring
    registerDefaultWires: registerDefaultWires,
  };

  // Auto-register shared orchestration wires once per load
  try { registerDefaultWires(); } catch (e) {}

  // CommonJS + ESM friendly export
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    module.exports.default = api;
  } else {
    // attach to window for browser fallback
    try { window.SukaEvents = api; } catch (e) {}
  }
})();
