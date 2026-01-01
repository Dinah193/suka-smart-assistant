// C:\Users\larho\suka-smart-assistant\src\store\TemplateStore.js
/* eslint-disable no-console */
/**
 * TemplateStore — user-editable task/session templates across domains
 *
 * What it does
 *  • Holds both "system" (shipped) and "user" (editable) templates for sessions/plans.
 *  • Domain-aware (meals, garden, animals, cleaning, etc.) with tags, versions, and revisions.
 *  • Lets users adopt a template into a runnable plan and save it as a favorite (events).
 *  • Search, filter, import/export JSON, publish/archive, soft-delete, and override system templates.
 *  • Works with or without Zustand + Dexie; persists to IndexedDB or localStorage.
 *
 * Plays nicely with…
 *  • SavePlanButton / FavoritePicker (emits <domain>.plan.favorite.requested).
 *  • SessionStore.startWithPlan (produces a plan object conforming to contracts).
 *  • calendarSync.js (emits schedule.event.write.requested when adopting templates with schedules).
 *  • automation/runtime & eventBus (all actions are event-driven).
 *
 * Key events (payloads are domain-aware where applicable)
 *  - template.saved / template.updated / template.deleted / template.published / template.archived
 *  - template.import.requested / template.export.requested
 *  - template.override.applied             (user template shadowing a system template)
 *  - session.adopt.requested               (adopt template → create plan shell)
 *  - <domain>.plan.favorite.requested      (trigger Save modal / cloud export flow)
 *  - schedule.event.write.requested        (Calendar write hint for adopted items)
 */

(function () {
  /* -------------------------------- Safe imports ------------------------------- */
  var eventBus = { emit: function(){}, on: function(){}, off: function(){} };
  try {
    var eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  var automation = { on: function(){}, emit: function(){} };
  try { automation = require("@/services/automation/runtime").automation || automation; } catch (_e) {}

  var pausePolicies = { canRunNow: function(){ return true; } };
  try { pausePolicies = require("@/services/session/policies/pausePolicies"); } catch (_e) {}

  var offsetParser = { parse: function(){ return { ms: 0 }; } };
  try { offsetParser = require("@/services/session/utils/offsetParser"); } catch (_e) {}

  var scheduleHelpers = null;
  try { scheduleHelpers = require("@/services/session/scheduleHelpers"); } catch (_e) {}

  // Optional JSON schema validator
  var Ajv = null;
  try { Ajv = require("ajv"); } catch (_e) {}

  // Optional Zustand
  var createZustand = null;
  try { createZustand = require("zustand").create; } catch (_e) {}

  // Optional Dexie (IndexedDB)
  var Dexie = null;
  try { Dexie = require("dexie"); } catch (_e) {}

  // Optional shared template libraries (will prefer user templates first)
  var GardenPlanTemplates = null;
  try { GardenPlanTemplates = require("@/libraries/GardenPlanTemplates"); } catch (_e) {}
  var AnimalPlanTemplates = null;
  try { AnimalPlanTemplates = require("@/libraries/AnimalPlanTemplates"); } catch (_e) {}

  var isBrowser = typeof window !== "undefined";
  var now = function () { return Date.now(); };
  var uid = function () { return Math.random().toString(36).slice(2, 10); };

  /* ------------------------------- Persistence ------------------------------- */
  var db = null;
  if (Dexie) {
    try {
      db = new Dexie("SukaTemplatesDB");
      db.version(1).stores({
        templates: "++id, templateId, domain, kind, owner, status, updatedAt",
        revisions: "++id, templateId, createdAt"
      });
    } catch (e) {
      console.warn("[TemplateStore] Dexie init failed, using localStorage", e);
      db = null;
    }
  }
  var LS_KEYS = {
    templates: "suka:templates:user",     // array of user templates
    overrides: "suka:templates:overrides" // array of {systemKey, templateId}
  };
  function lsGet(key, fallback) {
    if (!isBrowser) return fallback;
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (_e) { return fallback; }
  }
  function lsSet(key, value) {
    if (!isBrowser) return;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_e) {}
  }

  /* --------------------------------- Helpers --------------------------------- */
  function domainFromTemplate(t) {
    return (t && (t.domain || t.meta?.domain || t.params?.domain)) || "general";
  }
  function safeClone(x) { return JSON.parse(JSON.stringify(x)); }

  // ID strategy: "<domain>:<kind>:<slug>"
  function makeTemplateId(t) {
    var d = domainFromTemplate(t);
    var kind = t.kind || t.type || "session";
    var slug = (t.slug || (t.meta && t.meta.slug) || (t.title || t.meta?.title || "template")).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    return (d + ":" + kind + ":" + slug);
  }

  // Build a runnable plan from a template (very lightweight)
  function templateToPlan(tpl, options) {
    var domain = domainFromTemplate(tpl);
    var title = tpl.title || tpl.meta?.title || "Household Plan";
    var recurrence = tpl.schedule?.recurrence || null;
    var startTimeLocal = tpl.schedule?.startTimeLocal || null;

    // Steps normalization
    var steps = (tpl.steps || []).map(function (s, i) {
      var durationMs = s.durationMs || (s.minutes ? s.minutes * 60 * 1000 : 0);
      var startOffset = (typeof s.startOffset === "number")
        ? s.startOffset
        : (s.startOffset || (i === 0 ? 0 : (tpl.steps[i - 1].durationMs || 0)));
      return Object.assign(
        {
          id: s.id || ("step-" + (i + 1)),
          title: s.title || ("Step " + (i + 1)),
          description: s.description || "",
          durationMs: durationMs,
          startOffset: startOffset
        },
        s
      );
    });

    var $id = "plan:" + makeTemplateId(tpl) + ":" + uid();

    var plan = {
      "$id": $id,
      "$schema": tpl.$schema || "urn:suka:contracts:workplan",
      type: tpl.type || tpl.kind || "workplan",
      slug: tpl.slug || makeTemplateId(tpl),
      meta: Object.assign({
        title,
        subtitle: tpl.subtitle || tpl.meta?.subtitle || "",
        domain,
        version: tpl.version || tpl.meta?.version || "1.0.0",
        favoriteable: true,
        exportable: true,
        defaultFavoriteKey: (domain + ":" + (tpl.slug || tpl.kind || "template")),
        icon: tpl.icon || "clipboard-list",
        tags: tpl.tags || tpl.meta?.tags || []
      }, tpl.meta || {}),
      params: Object.assign({ domain }, tpl.params || {}),
      inventory: safeClone(tpl.inventory || { required: [] }),
      schedule: recurrence || startTimeLocal ? {
        recurrence, startTimeLocal,
        calendar: Object.assign({ write: true, title }, tpl.schedule?.calendar || {})
      } : undefined,
      steps
    };

    // Calendar hint
    if (plan.schedule?.calendar?.write) {
      eventBus.emit("schedule.event.write.requested", {
        domain,
        planId: plan.$id,
        title: plan.schedule.calendar.title || plan.meta.title,
        recurrence: plan.schedule.recurrence || null,
        startTimeLocal: plan.schedule.startTimeLocal || null
      });
    }

    return plan;
  }

  // Emit favorite adoption for a plan
  function requestFavorite(plan, opts) {
    var domain = (plan?.meta?.domain) || "general";
    var payload = {
      domain,
      plan,
      options: Object.assign({ source: "TemplateStore" }, opts || {}),
      favoriteKey: plan?.meta?.defaultFavoriteKey || (domain + ":" + (plan.slug || plan.type || "plan"))
    };
    eventBus.emit(domain + ".plan.favorite.requested", payload);
    return payload;
  }

  /* ------------------------------ System Templates --------------------------- */
  // Lightweight in-file samples; real apps can replace/extend via libraries.
  var SYSTEM_TEMPLATES = [
    {
      owner: "system",
      status: "published",
      domain: "garden",
      kind: "wateringCycle",
      slug: "timed-drip",
      title: "Daily Drip Watering — Zone Schedule",
      icon: "sprout",
      tags: ["watering", "drip", "zones", "morning"],
      version: "1.0.0",
      schedule: { recurrence: "RRULE:FREQ=DAILY;BYHOUR=6;BYMINUTE=0;BYSECOND=0", startTimeLocal: "06:00",
        calendar: { write: true, title: "Garden — Watering (Timed Drip)" } },
      steps: [
        { id: "front-beds",  title: "Water Front Beds", minutes: 20, startOffset: 0, appliance: "irrigation", zone: "front-beds" },
        { id: "kitchen-herb",title: "Water Kitchen Herb", minutes: 12, startOffset: 25*60*1000, appliance: "irrigation", zone: "kitchen-herb" },
        { id: "rear-rows",   title: "Water Rear Rows", minutes: 25, startOffset: (25+12+5)*60*1000, appliance: "irrigation", zone: "rear-rows" }
      ],
      inventory: {
        required: [
          { sku: "irrigation.emitter.2gph", label: "Drip Emitters 2 GPH", unit: "ea", min: 12 }
        ]
      },
      meta: { domain: "garden", favoriteable: true, exportable: true }
    },
    {
      owner: "system",
      status: "published",
      domain: "cooking",
      kind: "roast",
      slug: "roast-lamb-family",
      title: "Roast Lamb — Family Dinner",
      icon: "beef",
      tags: ["dinner", "holiday", "lamb"],
      version: "1.0.0",
      schedule: { startTimeLocal: "16:00", calendar: { write: true, title: "Dinner — Roast Lamb Prep" } },
      steps: [
        { id: "prep", title: "Prep Rub & Score Fat", minutes: 15 },
        { id: "marinate", title: "Marinate", minutes: 60 },
        { id: "roast", title: "Roast", minutes: 75 },
        { id: "rest", title: "Rest Meat", minutes: 15 }
      ],
      meta: { domain: "cooking", favoriteable: true, exportable: true }
    }
  ];

  // Also expose optional library templates (if available) as system templates
  function collectSystemTemplates() {
    var lib = [];

    if (GardenPlanTemplates && GardenPlanTemplates.templates) {
      try {
        Object.keys(GardenPlanTemplates.templates).forEach(function (key) {
          lib.push({
            owner: "system",
            status: "published",
            domain: "garden",
            kind: key.split(":")[0] || "garden-plan",
            slug: key.split(":")[1] || key,
            title: "Garden Template — " + key,
            meta: { domain: "garden", favoriteable: true, exportable: true },
            _resolver: { library: "GardenPlanTemplates", key }
          });
        });
      } catch (_e) {}
    }

    if (AnimalPlanTemplates && AnimalPlanTemplates.templates) {
      try {
        Object.keys(AnimalPlanTemplates.templates).forEach(function (key) {
          lib.push({
            owner: "system",
            status: "published",
            domain: "animals",
            kind: key.split(":")[0] || "animal-plan",
            slug: key.split(":")[1] || key,
            title: "Animal Template — " + key,
            meta: { domain: "animals", favoriteable: true, exportable: true },
            _resolver: { library: "AnimalPlanTemplates", key }
          });
        });
      } catch (_e) {}
    }

    return SYSTEM_TEMPLATES.concat(lib);
  }

  /* ------------------------------ Store blueprint ---------------------------- */
  var DEFAULT_STATE = {
    ready: true,
    index: [],     // array of template summaries { templateId, title, domain, kind, status, owner, updatedAt, tags }
    cache: {},     // templateId -> full template
    searchQuery: "",
    filters: { domain: null, tags: [], owner: null, status: "published|draft|archived|null" },
    lastSyncAt: 0
  };

  function summarize(t) {
    return {
      templateId: t.templateId || makeTemplateId(t),
      title: t.title || t.meta?.title || t.slug || "Template",
      domain: domainFromTemplate(t),
      kind: t.kind || t.type || "session",
      status: t.status || "draft",
      owner: t.owner || "user",
      tags: t.tags || t.meta?.tags || [],
      updatedAt: t.updatedAt || now(),
      version: t.version || t.meta?.version || "1.0.0"
    };
  }

  // Minimal store fallback (no Zustand)
  function makeSimpleStore(initial) {
    var state = Object.assign({}, initial);
    var subs = new Set();
    function set(partial) {
      var prev = state;
      state = Object.assign({}, state, (typeof partial === "function" ? partial(prev) : partial));
      subs.forEach(function (fn) { try { fn(state, prev); } catch (_e) {} });
    }
    function get() { return state; }
    function subscribe(fn) { subs.add(fn); return function () { subs.delete(fn); }; }
    return { getState: get, setState: set, subscribe: subscribe };
  }

  var _store = null;

  function baseCreate(set, get) {
    return Object.assign({}, DEFAULT_STATE, {

      /* ------------------------------- Hydration ----------------------------- */
      hydrate: async function () {
        var systemItems = collectSystemTemplates();
        var sysIndex = systemItems.map(function (t) {
          t.templateId = t.templateId || makeTemplateId(t);
          t.owner = "system";
          t.status = t.status || "published";
          return summarize(t);
        });

        var userIndex = [];
        var cache = {};
        if (db) {
          try {
            var items = await db.templates.toArray();
            userIndex = items.map(summarize);
            // cache user templates
            for (var i = 0; i < items.length; i++) {
              var row = items[i];
              cache[row.templateId] = row;
            }
          } catch (e) { console.warn("[TemplateStore] Dexie hydrate error", e); }
        } else {
          var ls = lsGet(LS_KEYS.templates, []);
          userIndex = ls.map(summarize);
          ls.forEach(function (t) { cache[t.templateId || makeTemplateId(t)] = t; });
        }

        // add base system templates into cache for quick access (lightweight)
        systemItems.forEach(function (t) {
          cache[t.templateId || makeTemplateId(t)] = t;
        });

        set({
          index: sysIndex.concat(userIndex),
          cache,
          lastSyncAt: now(),
          ready: true
        });
      },

      /* -------------------------------- Queries ------------------------------ */
      list: function (opts) {
        var s = get();
        var q = (opts && opts.search) ? (opts.search + "").toLowerCase() : (s.searchQuery || "").toLowerCase();
        var domain = (opts && opts.domain) || s.filters.domain;
        var tags = (opts && opts.tags) || s.filters.tags || [];
        var owner = (opts && opts.owner) || s.filters.owner;

        return s.index.filter(function (i) {
          var ok = true;
          if (q) {
            ok = ok && ((i.title || "").toLowerCase().indexOf(q) >= 0 || (i.templateId || "").toLowerCase().indexOf(q) >= 0);
          }
          if (domain) ok = ok && (i.domain === domain);
          if (owner) ok = ok && (i.owner === owner);
          if (tags.length) {
            ok = ok && tags.every(function (t) { return (i.tags || []).includes(t); });
          }
          return ok;
        });
      },

      get: function (templateId) {
        var s = get();
        return s.cache[templateId] || null;
      },

      /* ------------------------------- Upserts ------------------------------- */
      upsert: async function (template, { publish } = {}) {
        var t = safeClone(template);
        t.owner = t.owner || "user";
        t.status = publish ? "published" : (t.status || "draft");
        t.updatedAt = now();
        t.templateId = t.templateId || makeTemplateId(t);

        // Validate with Ajv if available and validator provided on template.meta.$schema
        if (Ajv && t.$schema) {
          try {
            var ajv = new Ajv({ allErrors: true });
            var validate = ajv.compile({ $ref: t.$schema }); // assumes external schemas are registered elsewhere
            if (!validate(t)) {
              console.warn("[TemplateStore] Schema validation failed:", validate.errors);
            }
          } catch (_e) {}
        }

        // Persist
        if (db) {
          try {
            var found = await db.templates.where("templateId").equals(t.templateId).first();
            if (found) {
              await db.templates.where("templateId").equals(t.templateId).modify(Object.assign({}, found, t));
            } else {
              await db.templates.add(t);
            }
            await db.revisions.add({ templateId: t.templateId, createdAt: now(), data: t });
          } catch (e) {
            console.warn("[TemplateStore] Dexie upsert failed, falling back to LS", e);
          }
        } else {
          var ls = lsGet(LS_KEYS.templates, []);
          var idx = ls.findIndex(function (x) { return (x.templateId || makeTemplateId(x)) === t.templateId; });
          if (idx >= 0) ls[idx] = t; else ls.push(t);
          lsSet(LS_KEYS.templates, ls);
        }

        // Update store index + cache
        var s = get();
        var index = s.index.filter(function (i) { return i.templateId !== t.templateId; });
        index.push(summarize(t));
        var cache = Object.assign({}, s.cache, { [t.templateId]: t });

        set({ index, cache, lastSyncAt: now() });

        // Events
        eventBus.emit(found ? "template.updated" : "template.saved", { templateId: t.templateId, domain: domainFromTemplate(t), owner: t.owner, status: t.status });

        if (publish) {
          eventBus.emit("template.published", { templateId: t.templateId, domain: domainFromTemplate(t) });
        }

        return t;
      },

      remove: async function (templateId) {
        if (!templateId) return false;

        if (db) {
          try { await db.templates.where("templateId").equals(templateId).delete(); }
          catch (e) { console.warn("[TemplateStore] Dexie delete failed", e); }
        } else {
          var ls = lsGet(LS_KEYS.templates, []);
          ls = ls.filter(function (x) { return (x.templateId || makeTemplateId(x)) !== templateId; });
          lsSet(LS_KEYS.templates, ls);
        }

        var s = get();
        var index = s.index.filter(function (i) { return i.templateId !== templateId; });
        var cache = Object.assign({}, s.cache);
        delete cache[templateId];
        set({ index, cache, lastSyncAt: now() });

        eventBus.emit("template.deleted", { templateId });
        return true;
      },

      archive: async function (templateId) {
        var s = get();
        var t = s.cache[templateId];
        if (!t) return null;
        t.status = "archived";
        return await _store.getState().upsert(t);
      },

      publish: async function (templateId) {
        var s = get();
        var t = s.cache[templateId];
        if (!t) return null;
        t.status = "published";
        return await _store.getState().upsert(t, { publish: true });
      },

      /* ------------------------------ Overrides ------------------------------ */
      applyOverride: function (systemKey, userTemplateId) {
        // When user wants to shadow a system template with their version
        var overrides = lsGet(LS_KEYS.overrides, []);
        var existing = overrides.find(function (o) { return o.systemKey === systemKey; });
        if (existing) existing.templateId = userTemplateId;
        else overrides.push({ systemKey, templateId: userTemplateId, appliedAt: now() });
        lsSet(LS_KEYS.overrides, overrides);
        eventBus.emit("template.override.applied", { systemKey, templateId: userTemplateId });
        return overrides;
      },

      resolveSystemOrOverride: function (systemKey) {
        // Try override first
        var overrides = lsGet(LS_KEYS.overrides, []);
        var o = overrides.find(function (x) { return x.systemKey === systemKey; });
        if (o) {
          return _store.getState().get(o.templateId);
        }
        // else return a system template (from cache)
        var s = get();
        var match = Object.values(s.cache).find(function (t) {
          return t.owner === "system" && (t.slug === systemKey || t.templateId === systemKey);
        });
        return match || null;
      },

      /* --------------------------- Adopt → Plan & Favorite -------------------- */
      adoptAsPlan: function (templateId, options) {
        var s = get();
        var tpl = s.cache[templateId];
        if (!tpl) return null;

        // If pointing to library template, resolve real template obj
        if (tpl._resolver && tpl._resolver.library && tpl._resolver.key) {
          try {
            var resolved = null;
            if (tpl._resolver.library === "GardenPlanTemplates" && GardenPlanTemplates?.get) {
              resolved = GardenPlanTemplates.get(tpl._resolver.key, options || {});
            } else if (tpl._resolver.library === "AnimalPlanTemplates" && AnimalPlanTemplates?.get) {
              resolved = AnimalPlanTemplates.get(tpl._resolver.key, options || {});
            }
            if (resolved) tpl = Object.assign({}, tpl, resolved);
          } catch (_e) {}
        }

        var plan = templateToPlan(tpl, options || {});
        eventBus.emit("session.adopt.requested", { templateId, domain: domainFromTemplate(tpl), planId: plan.$id });

        if (options && options.autoFavorite) {
          requestFavorite(plan, { reason: "autoFavorite:template.adopt" });
        }
        return plan;
      },

      requestFavoriteForTemplate: function (templateId, opts) {
        var plan = _store.getState().adoptAsPlan(templateId, { autoFavorite: false });
        if (!plan) return null;
        return requestFavorite(plan, Object.assign({ reason: "manual:template.favorite" }, opts || {}));
      },

      /* ----------------------------- Import / Export -------------------------- */
      importTemplates: async function (templatesArray, { publish } = {}) {
        if (!Array.isArray(templatesArray)) return [];
        var results = [];
        for (var i = 0; i < templatesArray.length; i++) {
          // ensure unique id per import
          var t = safeClone(templatesArray[i]);
          t.owner = "user";
          t.templateId = t.templateId || makeTemplateId(t) + ":" + uid();
          results.push(await _store.getState().upsert(t, { publish }));
        }
        eventBus.emit("template.import.requested", { count: results.length });
        return results;
      },

      exportTemplates: function (templateIds) {
        var s = get();
        var arr = (templateIds && templateIds.length ? templateIds : s.index.map(function (i) { return i.templateId; }))
          .map(function (id) { return s.cache[id]; })
          .filter(Boolean)
          .map(safeClone);

        var payload = { kind: "templates.export", createdAt: now(), items: arr };
        eventBus.emit("template.export.requested", payload);
        return payload;
      },

      /* --------------------------------- Search -------------------------------- */
      setSearch: function (query) {
        var s = get();
        set({ searchQuery: String(query || ""), lastSyncAt: now() });
        return _store.getState().list({ search: s.searchQuery });
      },

      setFilters: function (filters) {
        var f = Object.assign({}, DEFAULT_STATE.filters, filters || {});
        set({ filters: f, lastSyncAt: now() });
        return f;
      }
    });
  }

  /* -------------------------------- Build store ------------------------------ */
  if (createZustand) {
    _store = createZustand(function (set, get) { return baseCreate(set, get); });
  } else {
    var simple = makeSimpleStore(DEFAULT_STATE);
    var api = baseCreate(simple.setState, simple.getState);
    simple.setState(api);
    _store = simple;
  }

  // Eager hydrate
  try { _store.getState().hydrate?.(); } catch (_e) {}

  /* --------------------------------- Exports --------------------------------- */
  var TemplateStore = {
    useTemplateStore: function () {
      if (createZustand) return _store; // React hook usage: const list = TemplateStore.useTemplateStore()(s=>s.list())
      // Non-React usage: facade
      return {
        getState: _store.getState,
        setState: _store.setState,
        subscribe: _store.subscribe
      };
    },
    getState: _store.getState,
    setState: _store.setState,
    subscribe: _store.subscribe
  };

  if (typeof module !== "undefined" && module.exports) module.exports = TemplateStore;
  else if (typeof window !== "undefined") window.TemplateStore = TemplateStore;
})();
