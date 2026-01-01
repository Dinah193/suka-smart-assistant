// C:\Users\larho\suka-smart-assistant\src\services\uiGlue\eventGlue.js
/* eslint-disable no-console */

/**
 * Suka Smart Assistant — UI Event Glue
 * ---------------------------------------------------------------------------
 * PURPOSE
 *  Central, production-ready bridge between domain/services and UI widgets.
 *  - Clear IA: well-named, organized events + helpers for nav, panels, toasts.
 *  - Intuitive flows: progress, step guidance, undo-first patterns, NBA.
 *  - Consistent design: one place to define toast kinds, confirm patterns.
 *  - Event-driven glue: refresh badges/filters when recipes/inventory/calendar change.
 *
 * EXPORTS
 *   initEventGlue(opts?) -> API
 *   getEventGlue()       -> singleton API after init
 *   destroyEventGlue()   -> remove listeners
 *
 * UI EVENTS (CustomEvent.detail payloads)
 *   ui.toast            { kind: "success"|"info"|"warning"|"error", message, undo?: true, meta? }
 *   ui.nba.suggest      { label, action }
 *   ui.progress         { jobId, jobRunId, at:0..1, message }
 *   ui.empty-state.show { title, description, actions:[{label, action}], icon? }
 *   ui.badges.refresh   { scope: "meals"|"inventory"|"calendar"|"global" }
 *   ui.filters.refresh  { scope: same as above }
 *   ui.confirm.request  { title, message, intent, resolveToken }
 *   ui.undo.request     { runId, stepId }  // requested by user from a toast/UI
 *
 * HOSTS
 *   registerToastHost(fn)      // fn({kind,message,undo?,meta?})
 *   registerNBAHost(fn)        // fn({label,action})
 *   registerProgressHost(fn)   // fn({jobId,jobRunId,at,message})
 *   registerConfirmHost(fn)    // async fn({title,message,intent}) => boolean
 *
 * USAGE
 *   const glue = initEventGlue();
 *   glue.toast.success("Saved", { undo: true });
 *   glue.nba({ label:"Open Planner", action:{type:"nav", to:"/meals/plan"} });
 *   glue.progress({ jobId, jobRunId, at:0.4, message:"Collecting pantry" });
 *   glue.badges.refresh("meals"); glue.filters.refresh("meals");
 *   glue.emptyState({ title, description, actions: [...] });
 *
 *   // Wire a Jobs Engine (optional; engine can also emit directly):
 *   glue.wireJobsEngine(engine);
 */

// -------------------------- Module State ------------------------------------
let _glue = null;
let _teardowns = [];

// Soft import engine for convenience-wiring (optional)
let Jobs = null;
try {
  // eslint-disable-next-line import/no-unresolved
  Jobs = require("@/services/jobs/engine.js");
} catch (_) {
  Jobs = null;
}

// -------------------------- Tiny Event Bus ----------------------------------
function createBus() {
  const map = new Map(); // evt -> Set(fns)
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => map.get(evt)?.delete(fn);
    },
    emit(evt, payload) {
      map.get(evt)?.forEach((fn) => {
        try { fn(payload); } catch (e) { console.error("[uiGlue.bus] handler error", evt, e); }
      });
    }
  };
}

// -------------------------- DOM Bridge Helpers ------------------------------
function bindWindow(evt, detail) {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(evt, { detail }));
    }
  } catch (e) {
    console.warn("[uiGlue] window dispatch failed", evt, e?.message || e);
  }
}

function classNames(...xs) { return xs.filter(Boolean).join(" "); }

// -------------------------- Glue Factory ------------------------------------
function createEventGlue(opts = {}) {
  const {
    debug = false,
    attachWindowListeners = true,    // listen & re-broadcast helpful events
    preferUndoOverConfirm = true,    // UX default: fewer confirms, more undo
    undoWindowMs = 30_000            // default undo window where applicable
  } = opts;

  const bus = createBus();

  // ---- Hosts (UI frameworks can register renderers) ----
  let toastHost = null;      // fn({kind,message,undo?,meta?})
  let nbaHost = null;        // fn({label,action})
  let progressHost = null;   // fn({jobId,jobRunId,at,message})
  let confirmHost = null;    // async fn({title,message,intent}) => boolean

  // ---- Core Emissions -------------------------------------------------------
  const toast = {
    success(message, meta = {}) { emitToast({ kind: "success", message, ...meta }); },
    info(message, meta = {}) { emitToast({ kind: "info", message, ...meta }); },
    warn(message, meta = {}) { emitToast({ kind: "warning", message, ...meta }); },
    error(message, meta = {}) { emitToast({ kind: "error", message, ...meta }); }
  };

  function emitToast(payload) {
    if (debug) console.log("[uiGlue] toast", payload);
    toastHost?.(payload);
    bindWindow("ui.toast", payload);
    bus.emit("ui.toast", payload);
  }

  function nba(suggestion) {
    if (!suggestion) return;
    if (debug) console.log("[uiGlue] nba.suggest", suggestion);
    nbaHost?.(suggestion);
    bindWindow("ui.nba.suggest", suggestion);
    bus.emit("ui.nba.suggest", suggestion);
  }

  function progress(p) {
    if (!p) return;
    if (debug) console.log("[uiGlue] progress", p);
    progressHost?.(p);
    bindWindow("ui.progress", p);
    bus.emit("ui.progress", p);
  }

  function emptyState(payload) {
    if (!payload) return;
    if (debug) console.log("[uiGlue] empty-state.show", payload);
    bindWindow("ui.empty-state.show", payload);
    bus.emit("ui.empty-state.show", payload);
  }

  const badges = {
    refresh(scope = "global") {
      const d = { scope };
      if (debug) console.log("[uiGlue] badges.refresh", d);
      bindWindow("ui.badges.refresh", d);
      bus.emit("ui.badges.refresh", d);
    }
  };

  const filters = {
    refresh(scope = "global") {
      const d = { scope };
      if (debug) console.log("[uiGlue] filters.refresh", d);
      bindWindow("ui.filters.refresh", d);
      bus.emit("ui.filters.refresh", d);
    }
  };

  // ---- Confirm & Undo Patterns ---------------------------------------------
  /**
   * confirmOrUndo:
   *  - If preferUndoOverConfirm = true, run action immediately, show toast with Undo (if provided).
   *  - Else, request confirmation via host or native confirm.
   */
  async function confirmOrUndo({
    title = "Are you sure?",
    message = "This may change your data.",
    intent = "default",
    run,
    onUndo,
    undoLabel = "Undo",
    undoMs = undoWindowMs
  }) {
    if (preferUndoOverConfirm && typeof onUndo === "function") {
      // Perform action now and expose Undo
      let undone = false;
      try {
        const res = await run?.();
        emitToast({
          kind: "success",
          message: title === "Are you sure?" ? "Done" : title,
          undo: true,
          meta: { undoLabel, timeoutMs: undoMs }
        });

        // Listen for a global undo request
        const abort = listenUndo(async () => {
          if (undone) return;
          undone = true;
          try { await onUndo?.(res); } catch (e) { console.warn("[uiGlue] undo failed", e); }
        }, undoMs);

        return { ok: true, res, undo: abort };
      } catch (e) {
        emitToast({ kind: "error", message: e?.message || "Action failed" });
        return { ok: false, error: e };
      }
    }

    // Confirm path
    let allowed = true;
    if (confirmHost) {
      try { allowed = await confirmHost({ title, message, intent }); } catch { allowed = false; }
    } else if (typeof window !== "undefined" && window.confirm) {
      allowed = window.confirm(`${title}\n\n${message}`);
    }
    if (!allowed) return { ok: false, reason: "cancelled" };

    try {
      const res = await run?.();
      emitToast({ kind: "success", message: title === "Are you sure?" ? "Done" : title });
      return { ok: true, res };
    } catch (e) {
      emitToast({ kind: "error", message: e?.message || "Action failed" });
      return { ok: false, error: e };
    }
  }

  function listenUndo(handler, windowMs) {
    let done = false;
    const on = (evt) => {
      if (done) return;
      done = true;
      try { handler?.(evt?.detail); } catch (e) { console.warn("[uiGlue] undo handler error", e); }
      cleanup();
    };
    const timeout = setTimeout(() => {
      if (!done) cleanup();
    }, Math.max(1000, windowMs || undoWindowMs));

    const cleanup = () => {
      try { window.removeEventListener("ui.undo.request", on); } catch {}
      clearTimeout(timeout);
    };

    try { window.addEventListener("ui.undo.request", on); } catch {}
    return cleanup;
  }

  // ---- Action dispatcher (nav/dispatch/ui/defer) ---------------------------
  function dispatchAction(action) {
    if (!action) return;
    const { type } = action;
    if (type === "nav") {
      const to = action.to || "/";
      try {
        if (to.startsWith("http")) window.location.href = to;
        else window.location.hash = `#${to}`;
      } catch (e) { console.warn("[uiGlue] nav failed", e); }
    } else if (type === "dispatch") {
      try { bindWindow(action.event || "suka.dispatch", action.payload || {}); } catch {}
    } else if (type === "ui") {
      try { bindWindow(action.event || "suka.ui", action.payload || {}); } catch {}
    } else if (type === "defer") {
      emitToast({ kind: "info", message: "Scheduled to resume later." });
    }
  }

  // ---- Jobs Engine wiring (optional convenience) ---------------------------
  function wireJobsEngine(engine) {
    if (!engine?.on) return () => {};
    const offs = [];
    const add = (evt, fn) => { const off = engine.on(evt, fn); offs.push(off); return off; };

    add("ui.toast", (p) => emitToast(p));
    add("ui.nba.suggest", (s) => nba(s));
    add("ui.progress", (p) => progress(p));

    // Domain events → badge/filter refresh
    add("recipe.consolidated", () => { badges.refresh("meals"); filters.refresh("meals"); });
    add("inventory.updated",   () => { badges.refresh("inventory"); filters.refresh("inventory"); });
    add("calendar.synced",     () => { badges.refresh("calendar"); filters.refresh("calendar"); });
    add("preferences.changed", () => { badges.refresh("global"); });

    // High-level outcomes (redundant with step toasts but safe)
    add("jobs.run.succeeded", ({ jobRunId }) => {
      // Prefer a single NBA suggestion per run
      if (engine.suggestNextBestAction) {
        const suggestion = engine.suggestNextBestAction(jobRunId);
        if (suggestion) nba(suggestion);
      }
    });

    return () => offs.forEach((off) => typeof off === "function" && off());
  }

  // ---- Window listeners (optional) -----------------------------------------
  if (attachWindowListeners && typeof window !== "undefined") {
    const onNBA = (e) => nbaHost?.(e.detail);
    const onToast = (e) => toastHost?.(e.detail);
    const onProgress = (e) => progressHost?.(e.detail);

    window.addEventListener("ui.nba.suggest", onNBA);
    window.addEventListener("ui.toast", onToast);
    window.addEventListener("ui.progress", onProgress);

    _teardowns.push(() => {
      try {
        window.removeEventListener("ui.nba.suggest", onNBA);
        window.removeEventListener("ui.toast", onToast);
        window.removeEventListener("ui.progress", onProgress);
      } catch {}
    });
  }

  // ---- Public API -----------------------------------------------------------
  return {
    // Hosts
    registerToastHost(fn) { toastHost = fn; },
    registerNBAHost(fn) { nbaHost = fn; },
    registerProgressHost(fn) { progressHost = fn; },
    registerConfirmHost(fn) { confirmHost = fn; },

    // Emits
    toast,
    nba,
    progress,
    emptyState,
    badges,
    filters,

    // Patterns
    confirmOrUndo,
    listenUndo,

    // Actions
    dispatchAction,

    // Engine
    wireJobsEngine,

    // Low-level bus (optional)
    on: (...args) => bus.on(...args),
    emit: (...args) => bus.emit(...args)
  };
}

// -------------------------- Singleton Helpers -------------------------------
function initEventGlue(opts = {}) {
  if (_glue) return _glue;
  _glue = createEventGlue(opts);

  // If Jobs service is present, wire it for convenience
  try {
    if (Jobs?.initJobsEngine) {
      const engine = Jobs.initJobsEngine();
      const off = _glue.wireJobsEngine(engine);
      _teardowns.push(off);
    }
  } catch (e) {
    console.warn("[uiGlue] engine wiring skipped", e?.message || e);
  }

  return _glue;
}

function getEventGlue() {
  return _glue || initEventGlue();
}

function destroyEventGlue() {
  try {
    _teardowns.forEach((fn) => typeof fn === "function" && fn());
    _teardowns = [];
  } catch {}
  _glue = null;
}

// -------------------------- Exports -----------------------------------------
module.exports = {
  initEventGlue,
  getEventGlue,
  destroyEventGlue
};
