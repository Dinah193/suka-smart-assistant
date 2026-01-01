// C:\Users\larho\suka-smart-assistant\src\store\SessionStore.js
/* eslint-disable no-console */
/**
 * SessionStore — unified store for live Prep/Exec sessions across domains
 *
 * NEW: Includes a scheduler snapshot ("itemRuntime") so the UI & engines can
 *      render/adjust per-step runtime metadata (plannedStart, withholds, deps, etc.)
 *
 * Goals
 *  • Orchestration-ready: start/resume/pause/end, step nav, timers, guards.
 *  • Domain-aware: accepts plans honoring urn:suka:contracts:* (meal/garden/animals/cleaning…)
 *  • Favorite-able: users can adopt/save plan variants (emits <domain>.plan.favorite.requested).
 *  • Resilient: works w/ or w/o Zustand + Dexie; persists to IndexedDB or localStorage.
 *  • Event-driven: plays nicely with automation runtime + Calendar Sync.
 *
 * Key Events (+ domain option):
 *  - session.started / session.paused / session.resumed / session.ended
 *  - session.step.changed / session.step.completed / session.step.failed
 *  - schedule.event.write.requested
 *  - planner.conflict.detected (kind: time|appliance|weather|biohazard)
 *  - inventory.shortage.detected (emitted by guards)
 *  - <domain>.plan.favorite.requested
 *  - session.scheduler.snapshot.updated (payload: { sessionId, version, items })
 *  - session.itemRuntime.updated         (payload: { sessionId, stepId, runtime })
 */

(function () {
  /* ------------------------------- Safe Imports ------------------------------ */
  var eventBus = { emit: function(){}, on: function(){}, off: function(){} };
  try {
    var eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  var automation = { on: function(){}, emit: function(){} };
  try { automation = require("@/services/automation/runtime").automation || automation; } catch (_e) {}

  var execEngine = null;
  try { execEngine = require("@/engines/session/sessionExecutionEngine"); } catch (_e) {}

  var pausePolicies = { canRunNow: function(){ return true; } };
  try { pausePolicies = require("@/services/session/policies/pausePolicies"); } catch (_e) {}

  // PPE, weather, withhold windows, etc. (optional)
  var scheduleHelpers = null;
  try { scheduleHelpers = require("@/services/session/scheduleHelpers"); } catch (_e) {}

  // Useful shared parser (optional)
  var offsetParser = { parse: function(){ return { ms: 0 }; } };
  try { offsetParser = require("@/services/session/utils/offsetParser"); } catch (_e) {}

  var Dexie = null;
  try { Dexie = require("dexie"); } catch (_e) {}

  var createZustand = null;
  try { createZustand = require("zustand").create; } catch (_e) {}

  var isBrowser = typeof window !== "undefined";
  var now = function () { return Date.now(); };
  var clamp = function (n, a, b) { return Math.max(a, Math.min(b, n)); };
  var uid = function () { return Math.random().toString(36).slice(2, 10); };

  /* ------------------------------ Persistence DB ---------------------------- */
  var db = null;
  if (Dexie) {
    try {
      db = new Dexie("SukaSessionsDB");
      db.version(1).stores({
        sessions: "++id, sessionId, domain, status, startedAt",
        snapshots: "++id, sessionId, createdAt"
      });
    } catch (e) {
      console.warn("[SessionStore] Dexie init failed, fallback to localStorage", e);
      db = null;
    }
  }

  var LS_KEYS = {
    current: "suka:session:current",
    history: "suka:session:history"
  };

  function lsGet(key, fallback) {
    if (!isBrowser) return fallback;
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (_e) { return fallback; }
  }
  function lsSet(key, value) {
    if (!isBrowser) return;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_e) {}
  }

  /* --------------------------------- Helpers -------------------------------- */
  function domainFromPlan(plan) {
    return (plan && plan.meta && plan.meta.domain) || (plan && plan.params && plan.params.domain) || "general";
  }

  function requestFavorite(plan, opts) {
    var domain = domainFromPlan(plan);
    var payload = {
      domain,
      plan,
      options: Object.assign({ source: "SessionStore" }, opts || {}),
      favoriteKey: plan?.meta?.defaultFavoriteKey || (domain + ":" + (plan.slug || plan.type || "plan"))
    };
    eventBus.emit(domain + ".plan.favorite.requested", payload);
    return payload;
  }

  function requestCalendarWrite(plan) {
    if (!plan?.schedule?.calendar?.write) return;
    eventBus.emit("schedule.event.write.requested", {
      domain: domainFromPlan(plan),
      planId: plan.$id,
      title: plan.schedule?.calendar?.title || plan.meta?.title || "Household Session",
      recurrence: plan.schedule?.recurrence || null,
      startTimeLocal: plan.schedule?.startTimeLocal || null
    });
  }

  function capHistory(history, cap) {
    if (!Array.isArray(history)) return [];
    return history.slice(-cap);
  }

  function nextStepIndex(steps, activeId) {
    var idx = steps.findIndex(function (s) { return s.id === activeId; });
    if (idx < 0) return 0;
    return clamp(idx + 1, 0, steps.length - 1);
  }

  function makeDefaultItemRuntimeFromSteps(steps, plan, domain) {
    var startBase = (plan?.schedule?.startTimeLocal ? plan.schedule.startTimeLocal : null);
    var startBaseMs = 0;
    if (startBase && offsetParser && offsetParser.parse) {
      // Best-effort parse "HH:mm" into ms from midnight if parser supports it; fallback to 0
      try { startBaseMs = offsetParser.parse(startBase).ms || 0; } catch (_e) {}
    }

    var items = {};
    var rolling = startBaseMs;
    steps.forEach(function (s, idx) {
      var dur = s.durationMs || 0;
      var plannedStartMs = (typeof s.startOffset === "number" ? s.startOffset : rolling);
      var plannedEndMs = plannedStartMs + dur;
      rolling = plannedEndMs + 0; // sequential by default (engines may later parallelize)

      // Optional withhold window computation
      var withholds = [];
      try {
        if (scheduleHelpers && scheduleHelpers.computeWithholds) {
          withholds = scheduleHelpers.computeWithholds({ domain, plan, step: s }) || [];
        }
      } catch (_e) {}

      items[s.id] = {
        stepId: s.id,
        idx,
        status: "pending",        // pending | running | done | skipped | failed
        assignedTo: null,         // e.g. "householder", "helper", "child-1"
        appliance: s.appliance || null,
        zone: s.zone || null,
        plannedStartMs,
        plannedEndMs,
        slackMs: 0,               // computed by scheduler (0 default)
        depsOf: [],               // ids that depend on this step
        dependsOn: s.dependsOn || [], // ids this step depends on
        withholds,                // [{ reason, fromMs, toMs }]
        notes: ""
      };
    });

    return {
      version: 1,
      generatedAt: now(),
      items
    };
  }

  /* ----------------------------- Store Definition --------------------------- */
  var DEFAULT_STATE = {
    ready: true,
    status: "idle", // idle | running | paused | completed | canceled
    sessionId: null,
    domain: null,
    plan: null,
    steps: [],
    activeStepId: null,
    startedAt: null,
    pausedAt: null,
    elapsedMs: 0,
    withhold: null,     // { reason, until } when pausePolicies suggests waiting
    timers: {},         // stepId -> { startedAt, durationMs, remainingMs }

    /**
     * itemRuntime — scheduler snapshot keyed by stepId
     * Shape:
     *  {
     *    version: 1,
     *    generatedAt: <ts>,
     *    items: {
     *      [stepId]: {
     *        stepId, idx, status, assignedTo, appliance, zone,
     *        plannedStartMs, plannedEndMs, slackMs,
     *        dependsOn: [stepId], depsOf: [stepId],
     *        withholds: [{ reason, fromMs, toMs }],
     *        notes: ""
     *      }
     *    }
     *  }
     */
    itemRuntime: { version: 1, generatedAt: 0, items: {} },

    history: [] // capped array of { sessionId, domain, status, startedAt, endedAt, planMeta }
  };

  // Minimal store impl fallback if Zustand not present
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

      /* ------------------------------ Lifecycle ------------------------------ */
      hydrate: async function () {
        if (db) {
          try {
            var latest = await db.sessions.orderBy("id").last();
            if (latest && latest.sessionId) {
              var snap = await db.snapshots.where("sessionId").equals(latest.sessionId).last();
              if (snap && snap.data) {
                set(Object.assign({}, snap.data, { ready: true }));
                return;
              }
            }
          } catch (e) {
            console.warn("[SessionStore] Dexie hydrate error", e);
          }
        }
        var ls = lsGet(LS_KEYS.current, null);
        if (ls) set(Object.assign({}, ls, { ready: true }));
      },

      startWithPlan: async function (plan, options) {
        options = options || {};
        var domain = domainFromPlan(plan);
        var sessionId = domain + ":" + (plan.$id || plan.slug || plan.type || uid()) + ":" + uid();
        var steps = Array.isArray(plan.steps) ? plan.steps.slice() : [];
        var activeStepId = steps[0]?.id || null;

        // Build initial scheduler snapshot (itemRuntime)
        var itemRuntime = makeDefaultItemRuntimeFromSteps(steps, plan, domain);

        var payload = {
          status: "running",
          sessionId, domain, plan, steps, activeStepId,
          startedAt: now(), pausedAt: null, elapsedMs: 0,
          withhold: null, timers: Object.create(null),
          itemRuntime
        };

        // schedule/withhold checks
        try {
          if (pausePolicies && !pausePolicies.canRunNow({ domain, plan })) {
            payload.status = "paused";
            payload.withhold = { reason: "policy", until: null };
          }
        } catch (_e) {}

        set(payload);

        // Persist session shell
        if (db) {
          try { await db.sessions.add({ sessionId, domain, status: payload.status, startedAt: payload.startedAt }); }
          catch (e) { console.warn("[SessionStore] Dexie add session failed", e); }
        } else {
          lsSet(LS_KEYS.current, get());
        }

        // Emit events
        eventBus.emit("session.started", { sessionId, domain, planId: plan.$id, planTitle: plan?.meta?.title });
        eventBus.emit("session.scheduler.snapshot.updated", {
          sessionId, version: itemRuntime.version, items: itemRuntime.items
        });
        requestCalendarWrite(plan);
        eventBus.emit("prep.tasks.requested", { domain, planId: plan.$id, params: { domain } });

        if (options.autoFavorite) requestFavorite(plan, { reason: "autoFavorite:session.start" });

        if (execEngine && execEngine.attach) {
          try { execEngine.attach({ sessionId, getState: get, setState: set, eventBus }); }
          catch (e) { console.warn("[SessionStore] execEngine.attach failed", e); }
        }
      },

      /* -------------------------------- Controls ------------------------------ */
      pause: function (reason) {
        var s = get();
        if (s.status !== "running") return;
        set({ status: "paused", pausedAt: now(), withhold: reason ? { reason } : s.withhold });
        eventBus.emit("session.paused", { sessionId: s.sessionId, domain: s.domain, reason: reason || "manual" });
        if (!db) lsSet(LS_KEYS.current, get());
      },

      resume: function () {
        var s = get();
        if (s.status !== "paused") return;
        if (pausePolicies && !pausePolicies.canRunNow({ domain: s.domain, plan: s.plan })) {
          set({ withhold: { reason: "policy", until: null } });
          eventBus.emit("planner.conflict.detected", { kind: "weather|withhold", domain: s.domain, sessionId: s.sessionId });
          return;
        }
        set({ status: "running", pausedAt: null, withhold: null });
        eventBus.emit("session.resumed", { sessionId: s.sessionId, domain: s.domain });
        if (!db) lsSet(LS_KEYS.current, get());
      },

      end: async function (finalStatus, meta) {
        var s = get();
        var status = finalStatus || (s.status === "paused" ? "canceled" : "completed");
        var endedAt = now();
        var hist = capHistory([].concat(s.history || [], [{
          sessionId: s.sessionId,
          domain: s.domain,
          status,
          startedAt: s.startedAt,
          endedAt,
          planMeta: { title: s.plan?.meta?.title, slug: s.plan?.slug, type: s.plan?.type }
        }]), 50);

        set(Object.assign({}, DEFAULT_STATE, { ready: true, history: hist }));

        if (db) {
          try {
            await db.sessions.where("sessionId").equals(s.sessionId).modify({ status });
            await db.snapshots.add({ sessionId: s.sessionId, createdAt: endedAt, data: s });
          } catch (e) { console.warn("[SessionStore] Dexie end session failed", e); }
        } else {
          lsSet(LS_KEYS.history, hist);
          lsSet(LS_KEYS.current, null);
        }

        eventBus.emit("session.ended", { sessionId: s.sessionId, domain: s.domain, status, meta: meta || {} });
      },

      /* --------------------------- Step Navigation --------------------------- */
      goToStep: function (stepId) {
        var s = get();
        if (!s.steps.length) return;
        var step = s.steps.find(function (x) { return x.id === stepId; });
        if (!step) return;
        set({ activeStepId: stepId });
        eventBus.emit("session.step.changed", { sessionId: s.sessionId, domain: s.domain, stepId });
        if (!db) lsSet(LS_KEYS.current, get());
      },

      nextStep: function () {
        var s = get();
        if (!s.steps.length) return;
        var idx = nextStepIndex(s.steps, s.activeStepId);
        var next = s.steps[idx] || s.steps[s.steps.length - 1];
        if (!next) return;
        set({ activeStepId: next.id });
        eventBus.emit("session.step.changed", { sessionId: s.sessionId, domain: s.domain, stepId: next.id });
        if (!db) lsSet(LS_KEYS.current, get());
      },

      completeActiveStep: function (notes) {
        var s = get();
        if (!s.activeStepId) return;

        // Mark itemRuntime status → done
        var rt = s.itemRuntime || { version: 1, generatedAt: now(), items: {} };
        var item = rt.items[s.activeStepId] || null;
        if (item) { item.status = "done"; item.notes = notes || item.notes || ""; }
        set({ itemRuntime: rt });

        eventBus.emit("session.step.completed", {
          sessionId: s.sessionId, domain: s.domain, stepId: s.activeStepId, notes: notes || null
        });
        eventBus.emit("session.itemRuntime.updated", { sessionId: s.sessionId, stepId: s.activeStepId, runtime: item });

        var idx = nextStepIndex(s.steps, s.activeStepId);
        var atEnd = (idx >= s.steps.length - 1);
        if (atEnd) {
          _store.getState().end("completed", { autoFrom: "completeActiveStep" });
        } else {
          _store.getState().nextStep();
        }
      },

      failActiveStep: function (reason) {
        var s = get();
        if (!s.activeStepId) return;

        // Mark itemRuntime status → failed
        var rt = s.itemRuntime || { version: 1, generatedAt: now(), items: {} };
        var item = rt.items[s.activeStepId] || null;
        if (item) { item.status = "failed"; item.notes = (item.notes ? item.notes + " " : "") + (reason || ""); }
        set({ itemRuntime: rt });

        eventBus.emit("session.step.failed", { sessionId: s.sessionId, domain: s.domain, stepId: s.activeStepId, reason: reason || "unknown" });
        eventBus.emit("session.itemRuntime.updated", { sessionId: s.sessionId, stepId: s.activeStepId, runtime: item });
      },

      /* --------------------------------- Timers -------------------------------- */
      startTimerForStep: function (stepId, durationMs) {
        var s = get();
        var timers = Object.assign({}, s.timers);
        timers[stepId] = { startedAt: now(), durationMs: durationMs || 0, remainingMs: durationMs || 0 };

        // Mark runtime status → running, set planned times if missing
        var rt = s.itemRuntime || { version: 1, generatedAt: now(), items: {} };
        var it = rt.items[stepId] || (rt.items[stepId] = { stepId, status: "pending", plannedStartMs: 0, plannedEndMs: 0, dependsOn: [], depsOf: [], withholds: [] });
        it.status = "running";
        if (!it.plannedStartMs) it.plannedStartMs = 0;
        if (!it.plannedEndMs && durationMs) it.plannedEndMs = it.plannedStartMs + durationMs;

        set({ timers, itemRuntime: rt });
        eventBus.emit("session.itemRuntime.updated", { sessionId: s.sessionId, stepId, runtime: it });
      },

      tick: function () {
        var s = get();
        if (s.status !== "running") return;
        set({ elapsedMs: (s.elapsedMs || 0) + 1000 });

        var timers = Object.assign({}, s.timers);
        Object.keys(timers).forEach(function (k) {
          var t = timers[k];
          if (!t || !t.durationMs) return;
          var passed = now() - (t.startedAt || now());
          var rem = clamp(t.durationMs - passed, 0, t.durationMs);
          timers[k] = Object.assign({}, t, { remainingMs: rem });
          if (rem === 0) {
            eventBus.emit("timer.completed", { sessionId: s.sessionId, domain: s.domain, stepId: k });

            // Mark itemRuntime → done if timer drove completion
            var rt = s.itemRuntime || { version: 1, generatedAt: now(), items: {} };
            var item = rt.items[k];
            if (item && item.status === "running") {
              item.status = "done";
              set({ itemRuntime: rt });
              eventBus.emit("session.itemRuntime.updated", { sessionId: s.sessionId, stepId: k, runtime: item });
            }
          }
        });
        set({ timers });
      },

      /* ----------------------- Scheduler Snapshot API ------------------------ */
      /**
       * Replace/merge a full scheduler snapshot built by a planning engine
       * e.g., PrepSessionOrchestrator → plan schedule (parallelization, deps, slack, withholds)
       */
      setSchedulerSnapshot: function (snapshot, opts) {
        var s = get();
        var merged = snapshot || { version: 1, generatedAt: now(), items: {} };

        // if opts.merge === true, merge into current
        if (opts && opts.merge && s.itemRuntime && s.itemRuntime.items) {
          var base = JSON.parse(JSON.stringify(s.itemRuntime));
          base.version = (snapshot.version || base.version || 1);
          base.generatedAt = snapshot.generatedAt || now();
          base.items = base.items || {};
          Object.keys(snapshot.items || {}).forEach(function (id) {
            base.items[id] = Object.assign({}, base.items[id] || {}, snapshot.items[id]);
          });
          merged = base;
        }

        set({ itemRuntime: merged });
        eventBus.emit("session.scheduler.snapshot.updated", { sessionId: s.sessionId, version: merged.version, items: merged.items });
        if (!db) lsSet(LS_KEYS.current, get());
        return merged;
      },

      /**
       * Patch a single step's runtime record.
       * Example: upsertItemRuntime(stepId, { assignedTo: 'helper', slackMs: 120000 })
       */
      upsertItemRuntime: function (stepId, patch) {
        var s = get();
        var rt = s.itemRuntime || { version: 1, generatedAt: now(), items: {} };
        var current = rt.items[stepId] || { stepId, status: "pending", dependsOn: [], depsOf: [], withholds: [], plannedStartMs: 0, plannedEndMs: 0, slackMs: 0, notes: "" };
        var next = Object.assign({}, current, patch || {});
        rt.items[stepId] = next;
        rt.generatedAt = now();
        set({ itemRuntime: rt });
        eventBus.emit("session.itemRuntime.updated", { sessionId: s.sessionId, stepId, runtime: next });
        if (!db) lsSet(LS_KEYS.current, get());
        return next;
      },

      /** Read-only accessor for a step's runtime entry */
      getItemRuntime: function (stepId) {
        var s = get();
        return (s.itemRuntime && s.itemRuntime.items && s.itemRuntime.items[stepId]) || null;
      },

      /** Clear runtime (used when re-planning a session mid-flight) */
      clearItemRuntime: function () {
        var s = get();
        var blank = { version: 1, generatedAt: now(), items: {} };
        set({ itemRuntime: blank });
        eventBus.emit("session.scheduler.snapshot.updated", { sessionId: s.sessionId, version: blank.version, items: blank.items });
        if (!db) lsSet(LS_KEYS.current, get());
      },

      /** Export a JSON-safe snapshot for persistence or download */
      exportRuntimeSnapshot: function () {
        var s = get();
        return JSON.parse(JSON.stringify(s.itemRuntime || { version: 1, generatedAt: now(), items: {} }));
      },

      /* ---------------------------- Favorites/Export -------------------------- */
      requestFavorite: function () {
        var s = get();
        if (!s.plan) return;
        return requestFavorite(s.plan, { reason: "manual:session.favorite" });
      },

      /* --------------------------------- Utils -------------------------------- */
      saveSnapshot: async function () {
        var s = get();
        if (db) {
          try { await db.snapshots.add({ sessionId: s.sessionId, createdAt: now(), data: s }); }
          catch (e) { console.warn("[SessionStore] Dexie snapshot failed", e); }
        } else {
          lsSet(LS_KEYS.current, s);
        }
      },

      loadHistory: function () {
        if (db) return db.sessions.orderBy("id").reverse().toArray();
        return Promise.resolve(lsGet(LS_KEYS.history, []));
      }
    });
  }

  // Build the store (Zustand if available)
  if (createZustand) {
    _store = createZustand(function (set, get) { return baseCreate(set, get); });
  } else {
    var simple = makeSimpleStore(DEFAULT_STATE);
    var api = baseCreate(simple.setState, simple.getState);
    simple.setState(api); // seed actions
    _store = simple;
  }

  /* ---------------------------- Background ticker ---------------------------- */
  if (isBrowser && !window.__SUKA_SESSION_TICKER__) {
    window.__SUKA_SESSION_TICKER__ = setInterval(function () {
      try {
        var s = _store.getState();
        if (s.status !== "running") return;
        if (pausePolicies && !pausePolicies.canRunNow({ domain: s.domain, plan: s.plan })) {
          _store.getState().pause("policy");
          return;
        }
        _store.getState().tick();
      } catch (_e) {}
    }, 1000);
  }

  /* ------------------------------- Public API -------------------------------- */
  var SessionStore = {
    useSessionStore: function () {
      if (createZustand) return _store;
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

  try { SessionStore.getState().hydrate?.(); } catch (_e) {}

  if (typeof module !== "undefined" && module.exports) module.exports = SessionStore;
  else if (typeof window !== "undefined") window.SessionStore = SessionStore;
})();
