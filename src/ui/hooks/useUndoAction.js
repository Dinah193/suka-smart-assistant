/* eslint-disable react/prop-types */
/**
 * Suka Smart Assistant — useUndoAction
 *
 * Why this exists
 * - Give every feature an easy, consistent undo/redo path.
 * - Support optimistic updates (do → render → maybe revert).
 * - Batch related changes, add confirmations, and emit nudges.
 * - Persist across page reloads and cap memory growth.
 *
 * Integrations
 * - Event bus (on/emit) from "@/services/automation/runtime".
 * - Next best action nudges via "ui.nudge".
 * - Global empty state banners & IA hooks for an "Undo Center".
 *
 * Usage
 *  import {
 *    useUndoAction,
 *    registerUndoGlue,
 *    registerUndoIA,
 *    createUndoable,        // helper
 *    withOptimisticState,   // helper
 *  } from "@/ui/hooks/useUndoAction";
 *
 *  const undo = useUndoAction();
 *  await undo.perform({
 *    label: "Remove item from inventory",
 *    do: async () => {/* mutate backend & local state *-/},
 *    undo: async () => {/* reverse backend & local state *-/},
 *    confirm: { kind: "danger", message: "Remove item permanently?" },
 *    nudge: { message: "Item removed.", actions: [{label:"Undo", href:"action://ui.undo"}] }
 *  });
 *
 *  // UI affordances:
 *  <Button onClick={undo.undo} disabled={!undo.canUndo}>Undo</Button>
 *  <Button onClick={undo.redo} disabled={!undo.canRedo}>Redo</Button>
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { on, emit } from "@/services/automation/runtime";

/* ----------------------------------------------------------------------------
 * Storage & Limits
 * ------------------------------------------------------------------------- */

const STORAGE_KEY = "suka.undo.v1";
const MAX_HISTORY = 200;
const REDO_WINDOW_MS = 10 * 60 * 1000; // 10 minutes to redo after undo

function load() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { done: [], undone: [] };
    const parsed = JSON.parse(raw);
    parsed.done ??= [];
    parsed.undone ??= [];
    return parsed;
  } catch {
    return { done: [], undone: [] };
  }
}
function save(state) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

/* ----------------------------------------------------------------------------
 * Types & helpers
 * ------------------------------------------------------------------------- */
/**
 * @typedef {Object} UndoEntry
 * @property {string} id           // uid
 * @property {string} label        // "Remove item"
 * @property {number} at           // timestamp
 * @property {function():Promise<any>|function():any} do
 * @property {function():Promise<any>|function():any} undo
 * @property {('queued'|'done'|'undone'|'failed')} state
 * @property {Object=} meta        // arbitrary info (e.g., record ids, deltas)
 * @property {{kind?:'info'|'success'|'warning'|'danger', message?:string}=} confirm
 * @property {{message?:string, actions?:{label:string, href:string}[]}=} nudge
 * @property {string=} batchId     // group/batch identifier
 */

const uid = () => (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)) + "-" + Date.now();

const noop = async () => {};
const asPromise = (fn) => Promise.resolve().then(fn);

/* ----------------------------------------------------------------------------
 * Global state (module-local, shared across hook instances)
 * ------------------------------------------------------------------------- */

const store = {
  done: load().done,   // stack top is last command
  undone: load().undone,
};

function pushDone(entry) {
  store.done.push(entry);
  if (store.done.length > MAX_HISTORY) store.done.shift();
  // whenever new done is added, redo stack is cleared
  store.undone = [];
  save(store);
  emit("ui.undo.changed", snapshot());
}
function pushUndone(entry) {
  store.undone.push(entry);
  if (store.undone.length > MAX_HISTORY) store.undone.shift();
  save(store);
  emit("ui.undo.changed", snapshot());
}
function popDone() {
  const x = store.done.pop();
  save(store);
  emit("ui.undo.changed", snapshot());
  return x;
}
function popUndone() {
  const x = store.undone.pop();
  save(store);
  emit("ui.undo.changed", snapshot());
  return x;
}
function snapshot() {
  return {
    done: [...store.done],
    undone: [...store.undone],
    canUndo: store.done.length > 0,
    canRedo: store.undone.length > 0 && Date.now() - (store.undone.at || Date.now()) <= REDO_WINDOW_MS,
    last: store.done[store.done.length - 1] || null,
  };
}

/* ----------------------------------------------------------------------------
 * Core engine
 * ------------------------------------------------------------------------- */

async function execute(entry, direction /* 'do' | 'undo' */) {
  const fn = direction === "undo" ? entry.undo || noop : entry.do || noop;
  try {
    await asPromise(fn);
    entry.state = direction === "undo" ? "undone" : "done";
    return { ok: true };
  } catch (e) {
    entry.state = "failed";
    emit("ui.toast", { kind: "error", title: "Action failed", description: e?.message || String(e) });
    return { ok: false, error: e };
  }
}

/* ----------------------------------------------------------------------------
 * React hook
 * ------------------------------------------------------------------------- */

export function useUndoAction() {
  const [snap, setSnap] = useState(snapshot());
  const pendingRef = useRef(false);

  useEffect(() => {
    // Subscribe to store mutation events
    return on("ui.undo.changed", () => setSnap(snapshot()));
  }, []);

  // Global keyboard shortcuts (Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z or Ctrl+Y)
  useEffect(() => {
    const h = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  async function perform({
    label,
    do: doFn,
    undo: undoFn,
    meta,
    confirm,
    nudge,
    batchId,
    nextAfterSuccess = [], // [{label, href}]
  }) {
    if (pendingRef.current) return;
    pendingRef.current = true;

    // Optional confirm pattern ( UI will usually show a modal; here we surface toast hint )
    if (confirm?.kind === "danger" && confirm?.message) {
      emit("ui.toast", { kind: "warning", title: confirm.message });
    }

    /** @type {UndoEntry} */
    const entry = {
      id: uid(),
      label: label || "Change",
      at: Date.now(),
      do: doFn || noop,
      undo: undoFn || noop,
      state: "queued",
      meta,
      confirm,
      nudge,
      batchId,
    };

    // Try 'do'
    const res = await execute(entry, "do");
    if (!res.ok) {
      pendingRef.current = false;
      return { ok: false, error: res.error };
    }

    // Push history & emit nudge
    pushDone(entry);

    emit("ui.nudge", {
      at: Date.now(),
      message: entry.nudge?.message || `${entry.label} completed.`,
      actions: entry.nudge?.actions?.length
        ? entry.nudge.actions
        : [{ label: "Undo", href: "action://ui.undo" }, ...nextAfterSuccess],
      source: "undo.perform",
    });

    pendingRef.current = false;
    return { ok: true, id: entry.id };
  }

  async function batch(label, steps = [], { nudge, confirm, meta } = {}) {
    // Steps: array of { do, undo, label?, meta? }
    const id = uid();
    const entry = {
      id,
      label: label || `Batch (${steps.length})`,
      at: Date.now(),
      do: async () => {
        for (const s of steps) await asPromise(s.do || noop);
      },
      undo: async () => {
        for (const s of [...steps].reverse()) await asPromise(s.undo || noop);
      },
      state: "queued",
      batchId: id,
      meta,
      confirm,
      nudge,
    };
    return perform(entry);
  }

  async function undo() {
    if (!snap.canUndo) return { ok: true };
    const entry = popDone();
    if (!entry) return { ok: true };
    const res = await execute(entry, "undo");
    if (res.ok) {
      pushUndone({ ...entry, at: Date.now() });
      emit("ui.nudge", {
        at: Date.now(),
        message: `Undid: ${entry.label}`,
        actions: [{ label: "Redo", href: "action://ui.redo" }],
        source: "undo.undo",
      });
    }
    return res;
  }

  async function redo() {
    if (!snap.canRedo) return { ok: true };
    const entry = popUndone();
    if (!entry) return { ok: true };
    const res = await execute(entry, "do");
    if (res.ok) {
      pushDone({ ...entry, at: Date.now() });
      emit("ui.nudge", {
        at: Date.now(),
        message: `Redid: ${entry.label}`,
        actions: [{ label: "Undo", href: "action://ui.undo" }],
        source: "undo.redo",
      });
    }
    return res;
  }

  function clear() {
    const prev = { done: [...store.done], undone: [...store.undone] };
    store.done = [];
    store.undone = [];
    save(store);
    emit("ui.undo.changed", snapshot());
    // Provide undo of the clear itself
    pushDone({
      id: uid(),
      label: "Clear undo history",
      at: Date.now(),
      do: async () => {},
      undo: async () => {
        store.done = prev.done;
        store.undone = prev.undone;
        save(store);
        emit("ui.undo.changed", snapshot());
      },
      state: "done",
    });
  }

  /* Allow other modules to trigger undo/redo via event bus */
  useEffect(() => {
    const unsub1 = on("ui.undo.request", () => undo());
    const unsub2 = on("ui.redo.request", () => redo());
    const unsub3 = on("ui.action://ui.undo", () => undo()); // optional protocol
    const unsub4 = on("ui.action://ui.redo", () => redo());
    return () => {
      unsub1 && unsub1();
      unsub2 && unsub2();
      unsub3 && unsub3();
      unsub4 && unsub4();
    };
  }, []);

  const api = useMemo(
    () => ({
      history: snap.done,
      undone: snap.undone,
      canUndo: snap.canUndo,
      canRedo: snap.canRedo,
      last: snap.last,
      perform,
      batch,
      undo,
      redo,
      clear,
      emptyState: {
        title: "No actions to undo",
        description: "Try planning meals, updating inventory, or adjusting your calendar. Any change will be undoable here.",
        actions: [
          { label: "Open Meal Planner", href: "/tier2/household/meals" },
          { label: "Review Inventory", href: "/tier2/household/inventory" },
          { label: "Open Calendar", href: "/calendar" },
        ],
      },
    }),
    [snap]
  );

  return api;
}

/* ----------------------------------------------------------------------------
 * Helpers for feature code
 * ------------------------------------------------------------------------- */

/**
 * Create an undoable wrapper with a single call.
 * @param {Object} cfg
 * @param {string} cfg.label
 * @param {Function} cfg.mutate   // perform mutation (server + local)
 * @param {Function} cfg.revert   // revert mutation (server + local)
 * @param {Object=} cfg.meta
 * @param {Object=} cfg.confirm
 * @param {Object=} cfg.nudge
 */
export function createUndoable({ label, mutate, revert, meta, confirm, nudge }) {
  return {
    label,
    do: mutate,
    undo: revert,
    meta,
    confirm,
    nudge,
  };
}

/**
 * Wrap a setState call to produce an optimistic undo pair.
 * @param {(draft:any)=>any} apply   // how to apply the change
 * @param {(draft:any)=>any} revert  // how to revert the change
 * @param {function(Function):void} setState // React setState
 */
export function withOptimisticState(apply, revert, setState) {
  return {
    do: () => setState((prev) => apply(structuredClone(prev))),
    undo: () => setState((prev) => revert(structuredClone(prev))),
  };
}

/* ----------------------------------------------------------------------------
 * Event-driven glue (recipes/inventory/calendar → add default undo entries)
 * ------------------------------------------------------------------------- */
/**
 * We can't magically undo remote changes from events alone, but we can:
 * - Offer "soft undo" suggestions (open source page, revert template, etc.)
 * - Register handlers where your domain modules pass revert closures.
 *
 * Domain modules can emit:
 *  emit("undo.register", { label, do, undo, meta })
 */
let _glueBooted = false;
export function registerUndoGlue() {
  if (_glueBooted) return;
  _glueBooted = true;

  // Domain modules can push real undo entries:
  on("undo.register", async (entry) => {
    // auto-perform completed action so it's in history and undoable immediately
    const api = useUndoActionSingleton();
    await api.perform(entry);
  });

  // Friendly "soft undo" suggestions for common flows:
  on("mealplan.created", () => {
    emit("ui.nudge", {
      at: Date.now(),
      message: "Meal plan created.",
      actions: [{ label: "Undo (remove plan)", href: "action://ui.undo" }, { label: "Add to Calendar", href: "/export?format=ics" }],
      source: "undo.glue",
    });
  });

  on("inventory.updated", (evt) => {
    const low = evt?.payload?.lowStockCount || 0;
    emit("ui.nudge", {
      at: Date.now(),
      message: low > 0 ? `Inventory updated. ${low} items low.` : "Inventory updated.",
      actions: [{ label: "Undo last change", href: "action://ui.undo" }, { label: "Shopping List", href: "/tier2/household/meals#shopping" }],
      source: "undo.glue",
    });
  });

  on("calendar.events.updated", () => {
    emit("ui.nudge", {
      at: Date.now(),
      message: "Calendar updated.",
      actions: [{ label: "Undo", href: "action://ui.undo" }, { label: "Share with Family", href: "/family" }],
      source: "undo.glue",
    });
  });
}

/* ----------------------------------------------------------------------------
 * IA hooks (optional Undo Center route/nav)
 * ------------------------------------------------------------------------- */
let _iaRegistered = false;
export function registerUndoIA() {
  if (_iaRegistered) return;
  _iaRegistered = true;

  emit("shell.routes.register", {
    base: "/activity/undo",
    children: [{ path: "", element: "UndoCenter" }],
  });

  emit("shell.nav.register", {
    section: "Tools",
    items: [{ to: "/activity/undo", label: "Undo Center", icon: "rotate-ccw" }],
  });
}

/* ----------------------------------------------------------------------------
 * Singleton so glue can perform() w/o a mounted component
 * ------------------------------------------------------------------------- */
let _singleton;
function useUndoActionSingleton() {
  if (_singleton) return _singleton;
  // Minimal instance: reuses the same store and engine
  _singleton = {
    perform: async (entry) =>
      new Promise((resolve) => {
        // Fire a temporary event so any mounted hook can run perform
        emit("ui.undo.__perform.request", entry);
        resolve({ ok: true });
      }),
  };
  return _singleton;
}

// Bridge: if a real hook instance is mounted, let it execute perform requests
let _bridgeBound = false;
export function bindUndoPerformBridge() {
  if (_bridgeBound) return;
  _bridgeBound = true;
  on("ui.undo.__perform.request", async (entry) => {
    // Create a temporary headless performer
    const e = {
      label: entry.label,
      do: entry.do || noop,
      undo: entry.undo || noop,
      meta: entry.meta,
      confirm: entry.confirm,
      nudge: entry.nudge,
    };
    // Execute and push to history stacks
    const res = await execute(e, "do");
    if (res.ok) pushDone(e);
  });
}

/* ----------------------------------------------------------------------------
 * Boot helper (optional)
 * ------------------------------------------------------------------------- */
/**
 * Call this once at app startup if you want:
 * - Undo event glue
 * - IA registration
 * - Bridge for background perform() calls from modules
 */
export function bootstrapUndo() {
  registerUndoGlue();
  registerUndoIA();
  bindUndoPerformBridge();

  if (store.done.length === 0) {
    emit("ui.undo.empty", {
      message: "No actions to undo yet.",
      actions: [
        { label: "Open Meal Planner", href: "/tier2/household/meals" },
        { label: "Review Inventory", href: "/tier2/household/inventory" },
        { label: "Open Calendar", href: "/calendar" },
      ],
    });
  }
}
