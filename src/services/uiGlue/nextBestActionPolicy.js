// C:\Users\larho\suka-smart-assistant\src\services\uiGlue\nextBestActionPolicy.js
/* eslint-disable no-console */

/**
 * Suka Smart Assistant — Next Best Action (NBA) Policy
 * -----------------------------------------------------------------------------
 * PURPOSE
 * A small, production-ready policy engine that suggests a single, contextual
 * “Next Best Action” after a job step or success. It:
 *   1) Encodes clear IA with category-aware actions that deep-link to routes.
 *   2) Supports intuitive flows with per-step hints and undo-friendly patterns.
 *   3) Keeps design consistent by emitting standardized action objects:
 *        { label, action: { type: "nav"|"dispatch"|"ui"|"defer", to?, event?, payload? } }
 *   4) Wires event-driven glue: listens to recipes/inventory/calendar updates
 *      and refreshes NBA suggestions; mirrors toasts and empty states.
 *
 * EXPORTS
 *   initNextBestActionPolicy(options?)  -> policy API (singleton)
 *   getNextBestActionPolicy()           -> returns the singleton
 *   destroyNextBestActionPolicy()       -> unregister listeners
 *
 * POLICY API
 *   - evaluate({ jobId, category, stepId, ctx, status }) -> suggestion|null
 *   - emit(suggestion) // bridges to UI glue via CustomEvent("ui.nba.suggest")
 *   - registerRule(matchFn, suggestFn, priority=10) // extend/override rules
 *   - fromJobCategory(category, ctx?) // helper
 *   - wireJobsEngine(engine) // auto-emit NBA on success/step-complete
 *
 * NOTES
 *   - Safe soft-imports of Jobs Engine and UI Glue (no hard failure).
 *   - Rules are deterministic and side-effect free. Emission is separate.
 */

// --------------------------- Soft imports -----------------------------------
let Jobs = null;
try {
  // eslint-disable-next-line import/no-unresolved
  Jobs = require("@/services/jobs/engine.js");
} catch (_) {
  Jobs = null;
}

let Glue = null;
try {
  // eslint-disable-next-line import/no-unresolved
  Glue = require("@/services/uiGlue/eventGlue.js");
} catch (_) {
  Glue = null;
}

// --------------------------- Module state -----------------------------------
let _policy = null;
let _teardowns = [];

// --------------------------- Utils ------------------------------------------
function bindWindow(evt, detail) {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(evt, { detail }));
  } catch (e) {
    console.warn("[nba.policy] window dispatch failed", e?.message || e);
  }
}

function isNonEmptyArray(x) {
  return Array.isArray(x) && x.length > 0;
}

function toLabelCount(items, singular = "item") {
  if (!Array.isArray(items)) return null;
  const n = items.length;
  return n === 1 ? `1 ${singular}` : `${n} ${singular}s`;
}

// --------------------------- Default rules ----------------------------------
/**
 * A rule is { match({jobId,category,stepId,status,ctx}) -> boolean,
 *             suggest({jobId,category,stepId,status,ctx}) -> suggestion }
 * Suggestions follow the app-wide shape:
 *   { label, action: { type, to?, event?, payload? }, jobRunId?, fromStep?, meta? }
 */

function defaultRules() {
  const rules = [];

  // 1) After meal planning, offer to sync to calendar
  rules.push({
    priority: 100,
    match: ({ category, status, ctx }) =>
      category === "meals" && status === "succeeded" && isNonEmptyArray(ctx?.plan?.events),
    suggest: ({ ctx }) => ({
      label: "Send to Calendar",
      action: { type: "dispatch", event: "calendar.queueAdd", payload: { items: ctx.plan.events } },
      meta: { icon: "Calendar", hint: toLabelCount(ctx.plan.events, "event") }
    })
  });

  // 2) After calendar sync, suggest grocery list if a plan is present
  rules.push({
    priority: 95,
    match: ({ category, status, ctx }) =>
      category === "meals" && status === "succeeded" && ctx?.plan?.id && isNonEmptyArray(ctx?.plan?.events),
    suggest: ({ ctx }) => ({
      label: "Create Grocery List",
      action: { type: "dispatch", event: "inventory.createGroceryList", payload: { planId: ctx.plan.id } },
      meta: { icon: "ShoppingCart" }
    })
  });

  // 3) After inventory reconcile, propose meal planning that uses pantry
  rules.push({
    priority: 90,
    match: ({ category, status }) =>
      category === "inventory" && status === "succeeded",
    suggest: () => ({
      label: "Plan Meals Using Pantry",
      action: { type: "nav", to: "/tier2/household/meals/plan" },
      meta: { icon: "Utensils" }
    })
  });

  // 4) After calendar sync, offer to share or open calendar view
  rules.push({
    priority: 85,
    match: ({ category, status }) =>
      category === "calendar" && status === "succeeded",
    suggest: () => ({
      label: "Share Schedule",
      action: { type: "dispatch", event: "calendar.share" },
      meta: { icon: "Share" }
    })
  });

  // 5) Empty state helpers (if a job surfaced an empty-state gate)
  rules.push({
    priority: 80,
    match: ({ status, ctx }) =>
      status === "empty-state" || ctx?.__emptyState === true,
    suggest: () => ({
      label: "Add Data to Start",
      action: { type: "ui", event: "ui.panel.open", payload: { panel: "dataOnboarding" } },
      meta: { icon: "PlusCircle" }
    })
  });

  // 6) Fallback per-category openers
  rules.push({
    priority: 10,
    match: ({ category }) => category === "meals",
    suggest: () => ({
      label: "Open Meal Planner",
      action: { type: "nav", to: "/tier2/household/meals/plan" },
      meta: { icon: "Utensils" }
    })
  });
  rules.push({
    priority: 10,
    match: ({ category }) => category === "inventory",
    suggest: () => ({
      label: "Open Inventory",
      action: { type: "nav", to: "/tier2/household/inventory/reconcile" },
      meta: { icon: "Boxes" }
    })
  });
  rules.push({
    priority: 10,
    match: ({ category }) => category === "calendar",
    suggest: () => ({
      label: "Open Calendar",
      action: { type: "nav", to: "/calendar" },
      meta: { icon: "Calendar" }
    })
  });
  rules.push({
    priority: 1,
    match: () => true,
    suggest: () => ({
      label: "Back to Dashboard",
      action: { type: "nav", to: "/dashboard" },
      meta: { icon: "Home" }
    })
  });

  return rules;
}

// --------------------------- Factory ----------------------------------------
function createPolicy(options = {}) {
  const {
    autoWireJobs = true,
    emitOnEvaluate = false, // if true, emit suggestion when evaluate() is called
    debug = false
  } = options;

  const rules = defaultRules();
  const glue = Glue?.getEventGlue ? Glue.getEventGlue() : null;

  function log(...args) {
    if (debug && (process?.env?.NODE_ENV !== "test")) {
      console.log("[nba.policy]", ...args);
    }
  }

  function sortRules() {
    rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }
  sortRules();

  function registerRule(matchFn, suggestFn, priority = 10) {
    rules.push({ match: matchFn, suggest: suggestFn, priority });
    sortRules();
    return () => {
      const idx = rules.findIndex((r) => r.match === matchFn && r.suggest === suggestFn);
      if (idx >= 0) rules.splice(idx, 1);
    };
  }

  function evaluate({ jobId, category, stepId, ctx = {}, status = "succeeded", jobRunId } = {}) {
    for (const r of rules) {
      try {
        if (r.match({ jobId, category, stepId, ctx, status })) {
          const suggestion = r.suggest({ jobId, category, stepId, ctx, status, jobRunId });
          const enriched = { jobRunId, fromStep: stepId, ...suggestion };
          if (emitOnEvaluate) emit(enriched);
          log("selected", enriched);
          return enriched;
        }
      } catch (e) {
        console.warn("[nba.policy] rule error", e?.message || e);
      }
    }
    return null;
  }

  function fromJobCategory(category, ctx) {
    return evaluate({ category, ctx, status: "succeeded" });
  }

  function emit(suggestion) {
    if (!suggestion) return;
    if (glue?.nba) {
      glue.nba(suggestion); // standardized path through UI glue; triggers CustomEvent too
    } else {
      bindWindow("ui.nba.suggest", suggestion);
    }
  }

  // Auto-wire Jobs Engine to propose NBA on success / step completion
  function wireJobsEngine(engine) {
    if (!engine?.on) return () => {};
    const offs = [];
    const add = (evt, fn) => { const off = engine.on(evt, fn); offs.push(off); return off; };

    // After each step success, allow step-specific NBA to surface quickly
    add("jobs.step.completed", ({ jobRunId, jobId, stepId }) => {
      try {
        const job = engine.getJob?.(jobId) || {};
        const rt = engine.getJobRuntimeState?.(jobRunId) || {};
        const s = evaluate({ jobId, category: job.category || "other", stepId, ctx: rt.ctx || {}, status: "running", jobRunId });
        if (s) emit(s);
      } catch (e) {
        console.warn("[nba.policy] step.completed wiring error", e?.message || e);
      }
    });

    // After a run succeeds, emit a single, high-confidence NBA
    add("jobs.run.succeeded", ({ jobRunId, jobId, ctx }) => {
      try {
        const job = engine.getJob?.(jobId) || {};
        const s = evaluate({ jobId, category: job.category || "other", stepId: "final", ctx, status: "succeeded", jobRunId });
        if (s) emit(s);
      } catch (e) {
        console.warn("[nba.policy] run.succeeded wiring error", e?.message || e);
      }
    });

    // Domain changes can shift what makes sense next → optionally nudge
    const reeval = (scope) => () => {
      try {
        const catMap = { meals: "meals", inventory: "inventory", calendar: "calendar", global: "other" };
        const s = fromJobCategory(catMap[scope] || "other");
        if (s) emit({ ...s, meta: { ...s.meta, reason: "domain-update" } });
      } catch (e) {
        console.warn("[nba.policy] domain re-eval error", e?.message || e);
      }
    };
    add("recipe.consolidated", reeval("meals"));
    add("inventory.updated", reeval("inventory"));
    add("calendar.synced", reeval("calendar"));
    add("preferences.changed", reeval("global"));

    return () => offs.forEach((off) => typeof off === "function" && off());
  }

  // Optionally auto-wire to the engine singleton
  if (autoWireJobs && Jobs?.initJobsEngine) {
    try {
      const engine = Jobs.initJobsEngine();
      const off = wireJobsEngine(engine);
      _teardowns.push(off);
    } catch (e) {
      console.warn("[nba.policy] auto-wire skipped", e?.message || e);
    }
  }

  return {
    evaluate,
    emit,
    registerRule,
    fromJobCategory,
    wireJobsEngine
  };
}

// --------------------------- Public API -------------------------------------
function initNextBestActionPolicy(options = {}) {
  if (_policy) return _policy;
  _policy = createPolicy(options);
  return _policy;
}

function getNextBestActionPolicy() {
  return _policy || initNextBestActionPolicy();
}

function destroyNextBestActionPolicy() {
  try {
    _teardowns.forEach((fn) => typeof fn === "function" && fn());
    _teardowns = [];
  } catch {}
  _policy = null;
}

// --------------------------- Exports ----------------------------------------
module.exports = {
  initNextBestActionPolicy,
  getNextBestActionPolicy,
  destroyNextBestActionPolicy
};
