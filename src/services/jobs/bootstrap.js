// C:\Users\larho\suka-smart-assistant\src\services\jobs\bootstrap.js
/* eslint-disable no-console */

/**
 * Suka Smart Assistant — Jobs Bootstrap
 * -------------------------------------------------------------------
 * PURPOSE
 *  Initialize and wire the Jobs Engine with:
 *   1) Clear IA: register core jobs + optional manifests with ids, labels, paths, categories.
 *   2) Intuitive flows: step-by-step jobs emit progress, toast, Undo, and suggest Next Best Action (NBA).
 *   3) Consistent design: UI glue events (toasts, empty states, NBA) mirrored throughout the app.
 *   4) Event-driven updates: listen to recipe.consolidated, inventory.updated, calendar.synced,
 *      preferences.changed and refresh badges/filters without forcing page reloads.
 *
 * EXPORTS
 *   bootstrapJobs(opts?)  -> { engine, destroy }
 *   getEngine()           -> engine singleton (after bootstrap)
 *
 * SAFE IMPORTS (soft-fail):
 *   - engine.js (required)
 *   - torahProfileHooks (optional sabbath guard context)
 *   - automation/runtime (optional progress mirroring)
 */

// ------------------------- Soft Imports -------------------------------------
let JobsEngine = null;
try {
  // eslint-disable-next-line import/no-unresolved
  JobsEngine = require("./engine.js");
} catch (e) {
  console.error("[jobs.bootstrap] Missing engine.js. Ensure src/services/jobs/engine.js exists.");
  throw e;
}

let getTIP = null;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ getTIP } = require("@/services/integration/torahProfileHooks.js"));
} catch (_) {
  getTIP = null;
}

let automation = null;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ automation } = require("@/services/automation/runtime"));
} catch (_) {
  automation = null;
}

// ------------------------- Module State -------------------------------------
let _bootstrapped = false;
let _teardowns = [];
let _engine = null;

// ------------------------- Defaults & Helpers -------------------------------
const DEFAULT_OPTS = {
  registerBaseJobs: true,
  includeExamples: true, // toggles demo jobs below; safe to set false in prod
  manifests: [],         // optional array of job definitions to auto-register
  enableDomainGlue: true,
  enableUIBridge: true,
  log: true
};

const cat = {
  MEALS: "meals",
  INV: "inventory",
  CAL: "calendar",
  OTHER: "other"
};

function log(...args) {
  if (process?.env?.NODE_ENV !== "test") console.log("[jobs.bootstrap]", ...args);
}

function on(engine, evt, fn) {
  const off = engine.on(evt, fn);
  _teardowns.push(off);
  return off;
}

function bindWindow(evt, detail) {
  // bridge to global UI (toasts, NBA, refreshers)
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(evt, { detail }));
    }
  } catch (_) {}
}

// ------------------------- Base Jobs ----------------------------------------
/**
 * These are light-weight wrappers. Your real domain logic should live
 * in agents/services. Steps return {undo,nextBestAction} for Undo+NBA.
 */
function registerBaseJobs(engine) {
  // -------- Meals: Plan -> Calendar -> Grocery List -------------------------
  engine.registerJob({
    id: "meals.plan-week",
    label: "Plan Meals (7 Days)",
    category: cat.MEALS,
    path: "/tier2/household/meals/plan",
    description: "Generate a balanced 7-day plan from pantry + preferences, then sync.",
    steps: [
      {
        id: "collect",
        label: "Collect context",
        async run(ctx, io) {
          io.progress({ at: 0.15, message: "Collecting prefs, pantry, calendar" });
          const data = await io.fetchContext(["prefs", "pantry", "calendar"]);
          return {
            data,
            undo: async () => {}, // informational step
            nextBestAction: { label: "Review Suggestions", action: { type: "ui", event: "ui.panel.open", payload: { panel: "mealSuggestions" } } }
          };
        }
      },
      {
        id: "compose",
        label: "Compose plan",
        async run(ctx, io) {
          io.progress({ at: 0.55, message: "Composing a 7-day meal plan" });
          const plan = await io.agents.mealPlan(ctx);
          io.emit("mealplan.created", { plan });
          io.toast.success("7-day meal plan created", { undo: true });
          return {
            data: { plan },
            undo: async () => io.emit("mealplan.revert", { planId: plan.id }),
            nextBestAction: { label: "Sync to Calendar", action: { type: "dispatch", event: "calendar.queueAdd", payload: { items: plan.events } } }
          };
        }
      },
      {
        id: "sync",
        label: "Sync to calendar",
        optional: true,
        async run(ctx, io) {
          io.progress({ at: 0.85, message: "Syncing meals to calendar" });
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

  // -------- Inventory: Reconcile -------------------------------------------
  engine.registerJob({
    id: "inventory.reconcile",
    label: "Reconcile Storehouse",
    category: cat.INV,
    path: "/tier2/household/inventory/reconcile",
    description: "Audit pantry/freezer/root cellar and update quantities.",
    steps: [
      {
        id: "scan",
        label: "Scan differences",
        async run(_ctx, io) {
          io.progress({ at: 0.3, message: "Scanning for changes" });
          io.emit("inventory.deltas.ready", { count: 12 });
          io.toast.info("12 items need updates");
          return {
            undo: async () => {},
            nextBestAction: { label: "Review Deltas", action: { type: "ui", event: "ui.table.open", payload: { table: "inventoryDeltas" } } }
          };
        }
      },
      {
        id: "apply",
        label: "Apply updates",
        async run(_ctx, io) {
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

  // -------- Calendar: Sync Tasks -------------------------------------------
  engine.registerJob({
    id: "calendar.sync",
    label: "Sync Tasks",
    category: cat.CAL,
    path: "/calendar/sync",
    description: "Collect pending items and push them to your calendar.",
    steps: [
      {
        id: "collect",
        label: "Collect pending",
        async run(_ctx, io) {
          io.progress({ at: 0.25, message: "Collecting pending items" });
          const pending = [{ id: "ev1" }, { id: "ev2" }];
          return {
            data: { pending },
            undo: async () => {},
            nextBestAction: { label: "Review Pending", action: { type: "ui", event: "ui.list.open", payload: { list: "pendingCalendarItems" } } }
          };
        }
      },
      {
        id: "push",
        label: "Push to calendar",
        async run(ctx, io) {
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
}

// ------------------------- Optional Example Jobs ----------------------------
function registerExampleJobs(engine) {
  // This job demonstrates empty state gates
  engine.registerJob({
    id: "meals.quick-start",
    label: "Quick Start (Meals)",
    category: cat.MEALS,
    path: "/tier2/household/meals/plan",
    description: "Show how empty states guide the user to add recipes.",
    emptyState: () => {
      const recipesExist = false; // replace with real selector
      return recipesExist
        ? null
        : {
            show: true,
            title: "No recipes yet",
            description: "Scan or add recipes to get personalized plans.",
            actions: [
              { label: "Open Recipe Vault", action: { type: "nav", to: "/tier2/household/meals#recipe-vault" } },
              { label: "Scan a Recipe", action: { type: "dispatch", event: "recipes.scan.open" } }
            ]
          };
    },
    steps: [
      {
        id: "info",
        label: "Show guidance",
        async run(_ctx, io) {
          io.toast.info("Add recipes to proceed.");
          return { undo: async () => {} };
        }
      }
    ]
  });
}

// ------------------------- Glue (UI + Domain) -------------------------------
function wireUIBridge(engine) {
  // Mirror engine progress into automation (if present) and global UI.
  on(engine, "ui.progress", ({ jobId, at, message }) => {
    automation?.emitProgress?.({ jobId, at, message });
    // Optional: set page title for subtle feedback handled in Tasks routes.
  });

  // Bridge NBA + Toasts to window for global components (Snackbars, NBA panel).
  on(engine, "ui.nba.suggest", (detail) => bindWindow("ui.nba.suggest", detail));
  on(engine, "ui.toast", (detail) => bindWindow("ui.toast", detail));

  // High-level run state toasts (engine already fires toasts in steps; this is additive)
  on(engine, "jobs.run.succeeded", ({ jobId }) => bindWindow("ui.toast", { kind: "success", message: `${jobId} completed` }));
  on(engine, "jobs.run.failed", ({ jobId, error }) => bindWindow("ui.toast", { kind: "error", message: `${jobId} failed: ${error || "Unknown error"}` }));
  on(engine, "jobs.undo.performed", () => bindWindow("ui.toast", { kind: "warning", message: "Last step undone" }));
}

function wireDomainGlue(engine) {
  // When domain data changes, ask UI to refresh subtle widgets (badges, filters).
  const refresh = (scope) => () => {
    bindWindow("ui.badges.refresh", { scope });
    bindWindow("ui.filters.refresh", { scope });
  };

  on(engine, "recipe.consolidated", refresh("meals"));
  on(engine, "inventory.updated", refresh("inventory"));
  on(engine, "calendar.synced", refresh("calendar"));
  on(engine, "preferences.changed", refresh("global"));
}

// ------------------------- Bootstrap ----------------------------------------
/**
 * bootstrapJobs(opts)
 *   - Registers base jobs & manifests
 *   - Wires UI + domain glue
 *   - Respects Torah profile (Sabbath guard shown in UI; actual guard lives in engine)
 */
async function bootstrapJobs(opts = {}) {
  if (_bootstrapped) return { engine: _engine, destroy };

  const cfg = { ...DEFAULT_OPTS, ...opts };
  _engine = JobsEngine.initJobsEngine();

  if (cfg.log) log("Initializing Jobs Engine…");

  // Optionally surface Torah profile info (no crash on failure)
  if (getTIP) {
    try {
      const tip = await getTIP();
      if (cfg.log) log("Torah profile loaded:", !!tip);
    } catch (e) {
      if (cfg.log) log("Torah profile load failed softly:", e?.message || e);
    }
  }

  // Register core jobs
  if (cfg.registerBaseJobs) registerBaseJobs(_engine);
  if (cfg.includeExamples) registerExampleJobs(_engine);

  // Register external manifests (array of valid engine job defs)
  if (Array.isArray(cfg.manifests)) {
    for (const def of cfg.manifests) {
      try {
        _engine.registerJob(def);
        if (cfg.log) log("Registered manifest job:", def.id);
      } catch (e) {
        console.error("[jobs.bootstrap] Failed to register manifest job:", def?.id, e);
      }
    }
  }

  // Glue
  if (cfg.enableUIBridge) wireUIBridge(_engine);
  if (cfg.enableDomainGlue) wireDomainGlue(_engine);

  _bootstrapped = true;
  if (cfg.log) log("Jobs Engine ready.");

  return { engine: _engine, destroy };
}

// ------------------------- Destroy / Teardown -------------------------------
function destroy() {
  try {
    _teardowns.forEach((fn) => typeof fn === "function" && fn());
    _teardowns = [];
    _bootstrapped = false;
    if (_engine?.destroy) _engine.destroy();
  } catch (e) {
    console.warn("[jobs.bootstrap] destroy warning:", e?.message || e);
  }
}

// ------------------------- Public API ---------------------------------------
function getEngine() {
  return _engine || JobsEngine.initJobsEngine();
}

module.exports = {
  bootstrapJobs,
  getEngine,
  destroy
};
