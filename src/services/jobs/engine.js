// C:\Users\larho\suka-smart-assistant\src\services\jobs\engine.js
/* eslint-disable no-console */

/**
 * Suka Smart Assistant — Jobs Engine
 * -------------------------------------------------------------------
 * PURPOSE
 * A small, production-ready job runner for step-by-step tasks that:
 *  1) Enforces clear IA with a registry (ids, labels, paths, categories).
 *  2) Guides intuitive flows (ordered steps + progress + next-best-action).
 *  3) Emits consistent UI glue (cards, toasts, empty states, undo patterns).
 *  4) Reacts to system events (recipes/inventory/calendar/preferences).
 *
 * EXPORTS
 *   initJobsEngine(options?)
 *   registerJob(definition)
 *   runJob(jobId, ctx?)
 *   getJob(jobId)
 *   getJobsByCategory(category)
 *   on(event, handler) / off(event, handler) / emit(event, payload)
 *   getJobRuntimeState(jobRunId)
 *   undo(jobRunId)  // single-level or step-scoped undo
 *   suggestNextBestAction(jobRunId)
 *
 * JOB DEFINITION SHAPE
 *   {
 *     id: "meal.plan",
 *     label: "Plan Meals",
 *     category: "meals",
 *     path: "/tier2/household/meals/plan",  // IA hint for router/nav
 *     description: "Create a 7-day meal plan using pantry + preferences.",
 *     guards: [async (ctx) => ({ok: true})], // e.g., Sabbath guard
 *     emptyState: (ctx) => ({
 *       title: "No recipes yet",
 *       description: "Scan or add recipes to start planning meals.",
 *       actions: [{label: "Open Recipe Vault", action: {type: "nav", to: "/tier2/household/meals#recipe-vault"}}]
 *     }),
 *     steps: [
 *       {
 *         id: "collect-context",
 *         label: "Collect context",
 *         run: async (ctx, io) => {
 *           // ... fetch prefs, pantry, calendar, etc.
 *           io.progress({at: 0.15, message: "Gathering preferences & pantry"});
 *           const data = await io.fetchContext(["prefs","pantry","calendar"]);
 *           // Return undo handler + next best action suggestion
 *           return {
 *             data,
 *             undo: async () => {}, // no-op
 *             nextBestAction: {label: "Review suggestions", action: {type: "ui", event: "ui.panel.open", payload: {panel: "mealSuggestions"}}}
 *           };
 *         }
 *       },
 *       {
 *         id: "generate-plan",
 *         label: "Generate plan",
 *         run: async (ctx, io) => {
 *           io.progress({at: 0.55, message: "Composing a balanced 7-day plan"});
 *           const plan = await io.agents.mealPlan(ctx);
 *           io.emit("mealplan.created", {plan});
 *           // Show toast with Undo
 *           io.toast.success("7-day meal plan created", {undo: true});
 *           return {
 *             data: {plan},
 *             undo: async () => io.emit("mealplan.revert", {planId: plan.id}),
 *             nextBestAction: {label: "Send to Calendar", action: {type: "dispatch", event: "calendar.queueAdd", payload: {items: plan.events}}}
 *           };
 *         }
 *       },
 *       {
 *         id: "sync-calendar",
 *         label: "Sync to calendar",
 *         optional: true,
 *         run: async (ctx, io) => {
 *           io.progress({at: 0.85, message: "Syncing to calendar"});
 *           const res = await io.calendar.sync(ctx.plan?.events || []);
 *           io.emit("calendar.synced", res);
 *           io.toast.success("Meals added to calendar", {undo: true});
 *           return {
 *             data: res,
 *             undo: async () => io.calendar.remove(res.eventIds),
 *             nextBestAction: {label: "Create grocery list", action: {type: "dispatch", event: "inventory.createGroceryList", payload: {planId: ctx.plan?.id}}}
 *           };
 *         }
 *       }
 *     ]
 *   }
 */

let _engine = null;

// Optional integrations (fail-safe imports)
let getTIP = null;
try {
  // Sabbath guard / Torah profile integration is optional, don't hard-fail if absent
  // eslint-disable-next-line import/no-unresolved
  ({ getTIP } = require("@/services/integration/torahProfileHooks.js"));
} catch (_) {
  getTIP = null;
}

// Optional automation runtime glue (progress, etc.)
let automation = null;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ automation } = require("@/services/automation/runtime"));
} catch (_) {
  automation = null;
}

/** Minimal event bus (scoped to the engine). */
function createBus() {
  const handlers = new Map(); // event -> Set(fns)
  return {
    on(evt, fn) {
      if (!handlers.has(evt)) handlers.set(evt, new Set());
      handlers.get(evt).add(fn);
      return () => handlers.get(evt)?.delete(fn);
    },
    off(evt, fn) {
      handlers.get(evt)?.delete(fn);
    },
    emit(evt, payload) {
      handlers.get(evt)?.forEach((fn) => {
        try { fn(payload); } catch (e) { console.error(`[jobs.bus] handler error for ${evt}`, e); }
      });
    }
  };
}

/** Storage shim (localStorage if available, in-memory fallback). */
function createStorage(namespace = "suka.jobs") {
  const mem = new Map();
  const hasLS = typeof localStorage !== "undefined";
  const key = (k) => `${namespace}:${k}`;
  return {
    get(k, fallback = null) {
      try {
        if (hasLS) {
          const raw = localStorage.getItem(key(k));
          return raw ? JSON.parse(raw) : fallback;
        }
      } catch {}
      return mem.has(k) ? mem.get(k) : fallback;
    },
    set(k, v) {
      try {
        if (hasLS) {
          localStorage.setItem(key(k), JSON.stringify(v));
          return;
        }
      } catch {}
      mem.set(k, v);
    },
    remove(k) {
      try {
        if (hasLS) {
          localStorage.removeItem(key(k));
          return;
        }
      } catch {}
      mem.delete(k);
    }
  };
}

/** Guard: prevent job on Sabbath if configured in Torah profile. */
async function sabbathGuard(ctx = {}) {
  if (!getTIP) return { ok: true };
  try {
    const tip = await getTIP();
    if (tip?.sabbath?.guardActions === true) {
      const now = new Date();
      const dow = now.getDay(); // 0=Sun, 6=Sat
      const isSabbath = dow === 6; // Saturday guard (customize if needed by locale)
      if (isSabbath && !ctx?.allowSabbathOverride) {
        return {
          ok: false,
          reason: "Action paused for Sabbath",
          recommend: { label: "Resume after Sabbath", action: { type: "defer", hours: 24 } }
        };
      }
    }
  } catch (e) {
    console.warn("[jobs.guard] sabbathGuard failed softly", e);
  }
  return { ok: true };
}

/** Engine factory */
function createEngine() {
  const bus = createBus();
  const store = createStorage();
  const registry = new Map(); // jobId -> jobDefinition
  const runs = new Map();     // jobRunId -> runtime state

  // Event glue aliases for UI consistency
  const UI = {
    toast: {
      success(message, opts = {}) { bus.emit("ui.toast", { kind: "success", message, ...opts }); },
      info(message, opts = {}) { bus.emit("ui.toast", { kind: "info", message, ...opts }); },
      warn(message, opts = {}) { bus.emit("ui.toast", { kind: "warning", message, ...opts }); },
      error(message, opts = {}) { bus.emit("ui.toast", { kind: "error", message, ...opts }); }
    },
    emptyState(payload) { bus.emit("ui.empty-state.show", payload); },
    card(payload) { bus.emit("ui.card.show", payload); },
    progress(payload) {
      bus.emit("ui.progress", payload);
      if (automation?.emitProgress) automation.emitProgress(payload);
    },
    nextBestAction(payload) { bus.emit("ui.nba.suggest", payload); }
  };

  function on(evt, fn) { return bus.on(evt, fn); }
  function off(evt, fn) { return bus.off(evt, fn); }
  function emit(evt, payload) { return bus.emit(evt, payload); }

  function id(prefix = "jobrun") {
    return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  }

  function getJob(jobId) { return registry.get(jobId) || null; }
  function getJobsByCategory(category) {
    return [...registry.values()].filter(j => j.category === category);
  }

  function registerJob(def) {
    if (!def?.id) throw new Error("Job definition requires an id");
    if (!Array.isArray(def.steps) || def.steps.length === 0) {
      throw new Error(`Job ${def.id} requires at least one step`);
    }
    // Attach default guard set (Sabbath) unless explicitly disabled
    if (!def.guards) def.guards = [];
    if (def.enableSabbathGuard !== false) def.guards.push(sabbathGuard);

    registry.set(def.id, def);
    bus.emit("jobs.registered", { id: def.id, path: def.path, category: def.category, label: def.label });
    return def.id;
  }

  function getJobRuntimeState(jobRunId) {
    return runs.get(jobRunId) || null;
  }

  async function runJob(jobId, ctx = {}) {
    const job = registry.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    // Guards first
    for (const guard of (job.guards || [])) {
      const g = await guard(ctx);
      if (!g?.ok) {
        UI.toast.warn(g.reason || "Action is currently not allowed");
        if (g.recommend) UI.nextBestAction(g.recommend);
        return { ok: false, guard: g };
      }
    }

    // Empty state check (optional)
    if (typeof job.emptyState === "function") {
      const es = await job.emptyState(ctx);
      if (es && es.show === true) {
        UI.emptyState({
          title: es.title || "Nothing here yet",
          description: es.description || "Add content to begin.",
          actions: es.actions || []
        });
        return { ok: false, reason: "empty-state" };
      }
    }

    const jobRunId = id(job.id);
    const runtime = {
      id: jobRunId,
      jobId,
      status: "running",
      stepIndex: 0,
      ctx: { ...ctx },
      history: [] // for undo
    };
    runs.set(jobRunId, runtime);
    bus.emit("jobs.run.started", { jobRunId, jobId });

    // Engine-level IO helpers passed to steps
    const io = {
      emit,
      toast: UI.toast,
      progress: ({ at = 0, message = "" } = {}) => UI.progress({ jobRunId, at, message, jobId }),
      agents: {
        // Stubs to be wired into your agent layer
        mealPlan: async (ctx2) => {
          emit("agent.mealPlan.requested", { ctx: ctx2 });
          // Your real agent call here
          return { id: id("plan"), events: ctx2?.draftEvents || [], summary: "Auto-generated meal plan" };
        }
      },
      calendar: {
        sync: async (events) => {
          emit("calendar.sync.requested", { events });
          // Wire to gcal or your calendar service
          return { ok: true, eventIds: events?.map(() => id("evt")) || [] };
        },
        remove: async (eventIds) => emit("calendar.remove.requested", { eventIds })
      },
      fetchContext: async (keys) => {
        // Replace with real stores/selectors; emit glue for UI loading states
        emit("context.fetch.requested", { keys });
        return { keys, resolvedAt: Date.now() };
      }
    };

    try {
      const total = job.steps.length;
      for (let i = 0; i < total; i++) {
        runtime.stepIndex = i;
        const step = job.steps[i];
        const stepLabel = step.label || step.id || `Step ${i + 1}`;
        UI.progress({ jobRunId, at: i / total, message: `Running: ${stepLabel}`, jobId });

        const res = await step.run(runtime.ctx, io);
        // Merge any step data into ctx for next steps
        if (res?.data) Object.assign(runtime.ctx, res.data);

        // Push undo handler
        if (typeof res?.undo === "function") {
          runtime.history.push({ stepId: step.id, undo: res.undo });
          store.set(`${jobRunId}:history`, runtime.history.map(h => h.stepId));
        } else {
          runtime.history.push({ stepId: step.id, undo: async () => {} });
        }

        // Emit “next best action” (NBA) suggestion immediately after step success
        if (res?.nextBestAction) UI.nextBestAction({ jobRunId, fromStep: step.id, ...res.nextBestAction });

        // Emit a consistent event that a step completed
        bus.emit("jobs.step.completed", { jobRunId, jobId, stepId: step.id, label: stepLabel });
      }

      runtime.status = "succeeded";
      UI.progress({ jobRunId, at: 1, message: "Done", jobId });
      bus.emit("jobs.run.succeeded", { jobRunId, jobId, ctx: runtime.ctx });

      // Offer a final NBA tying to the most common next action for this job
      if (typeof suggestNextBestAction === "function") {
        const nba = suggestNextBestAction(jobRunId);
        if (nba) UI.nextBestAction(nba);
      }

      return { ok: true, jobRunId, ctx: runtime.ctx };
    } catch (err) {
      runtime.status = "failed";
      bus.emit("jobs.run.failed", { jobRunId, jobId, error: err?.message || String(err) });
      UI.toast.error(`Job failed: ${job.label || job.id}`);
      return { ok: false, error: err };
    }
  }

  /** Undo the most recent reversible step in a job run. */
  async function undo(jobRunId) {
    const runtime = runs.get(jobRunId);
    if (!runtime) throw new Error("Unknown job run");
    const last = runtime.history.pop();
    if (!last) return { ok: false, reason: "nothing-to-undo" };

    try {
      await last.undo();
      bus.emit("jobs.undo.performed", { jobRunId, stepId: last.stepId });
      return { ok: true, stepId: last.stepId };
    } catch (e) {
      bus.emit("jobs.undo.failed", { jobRunId, stepId: last.stepId, error: e?.message || String(e) });
      return { ok: false, error: e };
    }
  }

  /** Suggest a generic NBA if the job doesn't emit its own. */
  function suggestNextBestAction(jobRunId) {
    const runtime = runs.get(jobRunId);
    if (!runtime) return null;
    const job = registry.get(runtime.jobId);
    if (!job) return null;

    // Heuristics per category (extend as needed)
    const map = {
      meals: { label: "Open Meal View", action: { type: "nav", to: "/tier2/household/meals/view" } },
      inventory: { label: "Generate Grocery List", action: { type: "dispatch", event: "inventory.createGroceryList" } },
      calendar: { label: "Share Schedule", action: { type: "dispatch", event: "calendar.share" } }
    };
    const fallback = { label: "Back to Dashboard", action: { type: "nav", to: "/dashboard" } };
    return { jobRunId, ...(map[job?.category] || fallback) };
  }

  /**
   * Built-in event glue
   * Reacts to domain events to auto-refresh UI and recompute badges/filters
   */
  const teardownFns = [
    on("recipe.consolidated", () => {
      bus.emit("ui.badges.refresh", { scope: "meals" });
      bus.emit("ui.filters.refresh", { scope: "meals" });
    }),
    on("inventory.updated", () => {
      bus.emit("ui.badges.refresh", { scope: "inventory" });
      bus.emit("ui.filters.refresh", { scope: "inventory" });
    }),
    on("calendar.synced", () => {
      bus.emit("ui.badges.refresh", { scope: "calendar" });
      bus.emit("ui.filters.refresh", { scope: "calendar" });
    }),
    on("preferences.changed", () => {
      bus.emit("ui.badges.refresh", { scope: "global" });
      bus.emit("ui.filters.refresh", { scope: "global" });
    })
  ];

  /** Public API */
  return {
    on, off, emit,
    registerJob,
    runJob,
    getJob,
    getJobsByCategory,
    getJobRuntimeState,
    undo,
    suggestNextBestAction,
    destroy() { teardownFns.forEach((fn) => typeof fn === "function" && fn()); }
  };
}

/** Singleton initializer */
function initJobsEngine() {
  if (_engine) return _engine;

  _engine = createEngine();

  // ------------------------------
  // Register helpful baseline jobs
  // ------------------------------

  // Meals: plan meals (example job)
  _engine.registerJob({
    id: "meal.plan",
    label: "Plan Meals",
    category: "meals",
    path: "/tier2/household/meals/plan",
    description: "Create a 7-day plan from pantry and preferences.",
    emptyState: () => {
      // Example condition: show empty state if no recipes yet (stubbed)
      const noRecipes = false; // replace with real selector
      return noRecipes
        ? {
            show: true,
            title: "You haven't added any recipes yet",
            description: "Scan or add recipes to get personalized meal plans.",
            actions: [
              { label: "Open Recipe Vault", action: { type: "nav", to: "/tier2/household/meals#recipe-vault" } },
              { label: "Scan a Recipe", action: { type: "dispatch", event: "recipes.scan.open" } }
            ]
          }
        : null;
    },
    steps: [
      {
        id: "collect-context",
        label: "Collect context",
        run: async (ctx, io) => {
          io.progress({ at: 0.15, message: "Gathering preferences & pantry" });
          const data = await io.fetchContext(["prefs", "pantry", "calendar"]);
          return {
            data,
            undo: async () => {},
            nextBestAction: { label: "Review suggestions", action: { type: "ui", event: "ui.panel.open", payload: { panel: "mealSuggestions" } } }
          };
        }
      },
      {
        id: "generate-plan",
        label: "Generate plan",
        run: async (ctx, io) => {
          io.progress({ at: 0.55, message: "Composing a balanced 7-day plan" });
          const plan = await io.agents.mealPlan(ctx);
          io.emit("mealplan.created", { plan });
          io.toast.success("7-day meal plan created", { undo: true });
          return {
            data: { plan },
            undo: async () => io.emit("mealplan.revert", { planId: plan.id }),
            nextBestAction: { label: "Send to Calendar", action: { type: "dispatch", event: "calendar.queueAdd", payload: { items: plan.events } } }
          };
        }
      },
      {
        id: "sync-calendar",
        label: "Sync to calendar",
        optional: true,
        run: async (ctx, io) => {
          io.progress({ at: 0.9, message: "Syncing meals to calendar" });
          const res = await io.calendar.sync(ctx.plan?.events || []);
          io.emit("calendar.synced", res);
          io.toast.success("Meals added to calendar", { undo: true });
          return {
            data: res,
            undo: async () => io.calendar.remove(res.eventIds),
            nextBestAction: { label: "Create Grocery List", action: { type: "dispatch", event: "inventory.createGroceryList", payload: { planId: ctx.plan?.id } } }
          };
        }
      }
    ]
  });

  // Inventory: reconcile (example job)
  _engine.registerJob({
    id: "inventory.reconcile",
    label: "Reconcile Storehouse",
    category: "inventory",
    path: "/tier2/household/inventory/reconcile",
    description: "Audit pantry/freezer/root cellar and update quantities.",
    steps: [
      {
        id: "scan-deltas",
        label: "Scan differences",
        run: async (_ctx, io) => {
          io.progress({ at: 0.3, message: "Scanning for changes" });
          // ... scan logic
          io.emit("inventory.deltas.ready", { count: 12 });
          io.toast.info("12 items need updates");
          return {
            undo: async () => {},
            nextBestAction: { label: "Review changes", action: { type: "ui", event: "ui.table.open", payload: { table: "inventoryDeltas" } } }
          };
        }
      },
      {
        id: "apply-updates",
        label: "Apply updates",
        run: async (_ctx, io) => {
          io.progress({ at: 0.8, message: "Applying updates" });
          io.emit("inventory.updated", { at: Date.now() });
          io.toast.success("Inventory updated", { undo: true });
          return {
            undo: async () => io.emit("inventory.rollback", {}),
            nextBestAction: { label: "Plan Meals Using Pantry", action: { type: "nav", to: "/tier2/household/meals/plan" } }
          };
        }
      }
    ]
  });

  // Calendar: sync tasks (example job)
  _engine.registerJob({
    id: "calendar.sync",
    label: "Sync Tasks",
    category: "calendar",
    path: "/calendar/sync",
    description: "Sync tasks and events across modules.",
    steps: [
      {
        id: "collect",
        label: "Collect pending",
        run: async (_ctx, io) => {
          io.progress({ at: 0.25, message: "Collecting pending items" });
          const pending = [{ id: "ev1" }, { id: "ev2" }];
          return {
            data: { pending },
            undo: async () => {},
            nextBestAction: { label: "Review pending", action: { type: "ui", event: "ui.list.open", payload: { list: "pendingCalendarItems" } } }
          };
        }
      },
      {
        id: "push",
        label: "Push to calendar",
        run: async (ctx, io) => {
          io.progress({ at: 0.7, message: "Pushing to calendar" });
          const res = await io.calendar.sync(ctx.pending || []);
          io.emit("calendar.synced", res);
          io.toast.success("Calendar updated", { undo: true });
          return {
            data: res,
            undo: async () => io.calendar.remove(res.eventIds),
            nextBestAction: { label: "Share Schedule", action: { type: "dispatch", event: "calendar.share" } }
          };
        }
      }
    ]
  });

  return _engine;
}

/* ---------------------- Public API surface ---------------------- */
function getEngineOrInit() {
  return _engine || initJobsEngine();
}

module.exports = {
  initJobsEngine,
  registerJob: (...args) => getEngineOrInit().registerJob(...args),
  runJob: (...args) => getEngineOrInit().runJob(...args),
  getJob: (...args) => getEngineOrInit().getJob(...args),
  getJobsByCategory: (...args) => getEngineOrInit().getJobsByCategory(...args),
  on: (...args) => getEngineOrInit().on(...args),
  off: (...args) => getEngineOrInit().off(...args),
  emit: (...args) => getEngineOrInit().emit(...args),
  getJobRuntimeState: (...args) => getEngineOrInit().getJobRuntimeState(...args),
  undo: (...args) => getEngineOrInit().undo(...args),
  suggestNextBestAction: (...args) => getEngineOrInit().suggestNextBestAction(...args)
};
