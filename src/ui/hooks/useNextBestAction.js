/* eslint-disable react/prop-types */
/**
 * Suka Smart Assistant — useNextBestAction
 *
 * What this gives you
 * - Event-driven "next best action" queue (meal plan, inventory, calendar, batch, export)
 * - React hook to read/manipulate the queue: complete, skip, snooze, undo
 * - Persistence (localStorage) + de-duplication + cool-down to avoid spam
 * - Empty-state guidance and IA hooks (optional route/nav registration)
 * - Emits `ui.nudge` and `ui.toast` for consistent design system feedback
 *
 * Use:
 *  import { useNextBestAction, registerNextBestActionGlue, registerNextBestActionIA } from "@/ui/hooks/useNextBestAction";
 *  // during app boot:
 *  registerNextBestActionGlue();
 *  registerNextBestActionIA(); // optional, adds /suggestions UI entry for your shell
 *
 *  // in a component:
 *  const { next, queue, complete, skip, snooze, undo, enqueue } = useNextBestAction();
 *  // render InlineToastAction or custom banner using `next`
 */

import { useEffect, useMemo, useState } from "react";
import { on, emit } from "@/services/automation/runtime";

/* ----------------------------------------------------------------------------
 * Types (JSDoc)
 * ------------------------------------------------------------------------- */
/**
 * @typedef {Object} ActionLink
 * @property {string} label
 * @property {string} href
 *
 * @typedef {Object} NBAItem
 * @property {string} id
 * @property {number} at
 * @property {string} source      // e.g., "mealplan.created"
 * @property {string} message
 * @property {ActionLink[]} actions
 * @property {number=} snoozeUntil
 * @property {('queued'|'done'|'skipped')} state
 */

/* ----------------------------------------------------------------------------
 * Persistence & Store
 * ------------------------------------------------------------------------- */

const STORAGE_KEY = "suka.nba.queue.v1";
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per-source cooldown to prevent spam
const MAX_QUEUE = 50;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      cooldown: parsed.cooldown || {}, // source -> ts
    };
  } catch {
    return { queue: [], history: [], cooldown: {} };
  }
}
function save(store) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ queue: store.queue, history: store.history.slice(-100), cooldown: store.cooldown })
  );
}

/** Global store (module-local). */
const store = load();

/** Undo stack of inverse operations */
const UNDO = [];

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function uid() {
  return (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)) + "-" + Date.now();
}
function now() {
  return Date.now();
}
function dedupeKey(item) {
  // Prevent duplicates by message + first action href + source
  const firstHref = item.actions?.[0]?.href || "";
  return `${item.source}|${item.message}|${firstHref}`;
}

/* ----------------------------------------------------------------------------
 * Public enqueue API
 * ------------------------------------------------------------------------- */

/**
 * Enqueue a new suggestion if not on cooldown and not a duplicate.
 * @param {Partial<NBAItem>} item
 * @returns {NBAItem|undefined}
 */
export function enqueueNextAction(item) {
  const ts = now();
  const payload = {
    id: item.id || uid(),
    at: item.at || ts,
    source: item.source || "ui",
    message: item.message || "Try this next?",
    actions: item.actions || [],
    state: "queued",
  };

  // Cooldown per source
  const last = store.cooldown[payload.source] || 0;
  if (ts - last < COOLDOWN_MS) return; // still cooling down

  // De-dupe within the queue
  const key = dedupeKey(payload);
  if (store.queue.some((q) => dedupeKey(q) === key && q.state === "queued")) return;

  // Enforce size
  if (store.queue.length >= MAX_QUEUE) store.queue.shift();

  store.queue.push(payload);
  store.cooldown[payload.source] = ts;
  store.history.push({ ts, op: "enqueue", item: payload });
  save(store);

  UNDO.push(() => {
    store.queue = store.queue.filter((q) => q.id !== payload.id);
    store.history.push({ ts: now(), op: "undo.enqueue", id: payload.id });
    save(store);
    emit("ui.nba.changed", getSnapshot());
  });

  emit("ui.nba.changed", getSnapshot());
  emit("ui.nudge", payload); // also emit so global listeners can show a toast/banner
  return payload;
}

/* ----------------------------------------------------------------------------
 * Core operations: complete / skip / snooze / undo
 * ------------------------------------------------------------------------- */

function opComplete(id) {
  const i = store.queue.findIndex((q) => q.id === id);
  if (i === -1) return;
  const prev = { ...store.queue[i] };
  store.queue[i].state = "done";
  store.history.push({ ts: now(), op: "complete", id });
  save(store);
  UNDO.push(() => {
    store.queue[i] = prev;
    store.history.push({ ts: now(), op: "undo.complete", id });
    save(store);
    emit("ui.nba.changed", getSnapshot());
  });
  emit("ui.nba.changed", getSnapshot());
}
function opSkip(id) {
  const i = store.queue.findIndex((q) => q.id === id);
  if (i === -1) return;
  const prev = { ...store.queue[i] };
  store.queue[i].state = "skipped";
  store.history.push({ ts: now(), op: "skip", id });
  save(store);
  UNDO.push(() => {
    store.queue[i] = prev;
    store.history.push({ ts: now(), op: "undo.skip", id });
    save(store);
    emit("ui.nba.changed", getSnapshot());
  });
  emit("ui.nba.changed", getSnapshot());
}
function opSnooze(id, ms = 60 * 60 * 1000) {
  const i = store.queue.findIndex((q) => q.id === id);
  if (i === -1) return;
  const prev = { ...store.queue[i] };
  store.queue[i].snoozeUntil = now() + Math.max(5 * 60 * 1000, ms); // min 5m
  store.history.push({ ts: now(), op: "snooze", id, ms });
  save(store);
  UNDO.push(() => {
    store.queue[i] = prev;
    store.history.push({ ts: now(), op: "undo.snooze", id });
    save(store);
    emit("ui.nba.changed", getSnapshot());
  });
  emit("ui.nba.changed", getSnapshot());
}
function opUndo() {
  const fn = UNDO.pop();
  if (fn) fn();
}

/* ----------------------------------------------------------------------------
 * Snapshot & selectors
 * ------------------------------------------------------------------------- */

function getSnapshot() {
  const visible = store.queue
    .filter((q) => q.state === "queued" && (!q.snoozeUntil || q.snoozeUntil <= now()))
    .sort((a, b) => (a.at || 0) - (b.at || 0));
  return {
    queue: [...store.queue],
    visible,
    next: visible[0] || null,
    history: [...store.history],
  };
}

/* ----------------------------------------------------------------------------
 * React hook
 * ------------------------------------------------------------------------- */

export function useNextBestAction() {
  const [snap, setSnap] = useState(getSnapshot());

  useEffect(() => {
    // subscribe to store changes
    return on("ui.nba.changed", (s) => setSnap(getSnapshot()));
  }, []);

  // Also keep this hook hot by listening for global nudges (optional)
  useEffect(() => {
    return on("ui.nudge", (n) => {
      // Only enqueue if it's a "next action" style nudge with actions
      if (n && Array.isArray(n.actions) && n.actions.length) {
        enqueueNextAction({
          source: n.source || "ui",
          message: n.message,
          actions: n.actions,
          at: n.at || now(),
        });
      }
    });
  }, []);

  const api = useMemo(
    () => ({
      next: snap.next,
      queue: snap.queue,
      visible: snap.visible,
      history: snap.history,
      complete: (id) => opComplete(id || snap.next?.id),
      skip: (id) => opSkip(id || snap.next?.id),
      snooze: (id, ms) => opSnooze(id || snap.next?.id, ms),
      undo: opUndo,
      enqueue: enqueueNextAction,
      clearAll: () => {
        const prev = { ...store };
        store.queue = [];
        store.history.push({ ts: now(), op: "clear" });
        save(store);
        UNDO.push(() => {
          Object.assign(store, prev);
          store.history.push({ ts: now(), op: "undo.clear" });
          save(store);
          emit("ui.nba.changed", getSnapshot());
        });
        emit("ui.nba.changed", getSnapshot());
      },
      emptyState: {
        title: "You’re all caught up",
        description: "As you plan meals, update inventory, and edit your calendar, helpful suggestions will appear here.",
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
 * Event-driven glue (map domain events → suggestions)
 * ------------------------------------------------------------------------- */

let _glueBooted = false;
/**
 * Call once during app startup.
 * Translates domain events into practical next actions.
 */
export function registerNextBestActionGlue() {
  if (_glueBooted) return;
  _glueBooted = true;

  on("mealplan.created", () => {
    enqueueNextAction({
      source: "mealplan.created",
      message: "Meal plan created. Add to calendar or share it?",
      actions: [
        { label: "Create Calendar (.ics)", href: "/export?format=ics" },
        { label: "Share with Family", href: "/family" },
        { label: "Start Batch Session", href: "/tier2/household/meals#batch" },
      ],
    });
  });

  on("inventory.updated", (evt) => {
    const low = evt?.payload?.lowStockCount || 0;
    if (low > 0) {
      enqueueNextAction({
        source: "inventory.updated",
        message: `Low stock flagged (${low}). Generate shopping list?`,
        actions: [{ label: "Shopping List", href: "/tier2/household/meals#shopping" }],
      });
    } else {
      enqueueNextAction({
        source: "inventory.updated",
        message: "Inventory updated. Link items to recipes to reduce waste?",
        actions: [{ label: "Open Meal Planner", href: "/tier2/household/meals" }],
      });
    }
  });

  on("batch.completed", () => {
    enqueueNextAction({
      source: "batch.completed",
      message: "Batch completed. Print labels and update storehouse?",
      actions: [
        { label: "Print Labels", href: "/export?format=labels" },
        { label: "Update Storehouse", href: "/tier2/household/inventory" },
        { label: "Share with Community", href: "/community" },
      ],
    });
  });

  on("calendar.events.updated", () => {
    enqueueNextAction({
      source: "calendar.events.updated",
      message: "Calendar updated. Share tasks and owners with family?",
      actions: [
        { label: "Open Family Board", href: "/family/board" },
        { label: "Send Summary", href: "/family" },
      ],
    });
  });

  on("export.completed", (evt) => {
    const t = evt?.payload?.type || "file";
    enqueueNextAction({
      source: "export.completed",
      message: `Exported ${t}. Share or file it?`,
      actions: [
        { label: "Share to Family", href: "/family" },
        { label: "Share to Community", href: "/community" },
        { label: "Open Exports Folder", href: "/files/exports" },
      ],
    });
  });

  // Global undo trigger
  on("ui.nba.undo", () => opUndo());
}

/* ----------------------------------------------------------------------------
 * IA registration (optional)
 * ------------------------------------------------------------------------- */

let _iaRegistered = false;
/**
 * Register a Suggestions Center with your shell’s dynamic router/nav,
 * so users can review/clear history and manage snoozes.
 */
export function registerNextBestActionIA() {
  if (_iaRegistered) return;
  _iaRegistered = true;

  emit("shell.routes.register", {
    base: "/suggestions",
    children: [
      { path: "", element: "SuggestionsOverview" },
      { path: "history", element: "SuggestionsHistory" },
    ],
  });

  emit("shell.nav.register", {
    section: "Tools",
    items: [{ to: "/suggestions", label: "Suggestions", icon: "lightbulb" }],
  });
}

/* ----------------------------------------------------------------------------
 * Convenience: simple action helpers for UI wiring
 * ------------------------------------------------------------------------- */

export function useNextActionBanner() {
  const { next, complete, skip, snooze } = useNextBestAction();
  if (!next) return null;
  return {
    title: "Next best action",
    message: next.message,
    actions: next.actions,
    onDone: () => complete(next.id),
    onSkip: () => skip(next.id),
    onSnooze: (ms) => snooze(next.id, ms),
  };
}

/* ----------------------------------------------------------------------------
 * Boot note:
 * - Call registerNextBestActionGlue() during app startup.
 * - Your UI can render InlineToastAction using the `next` item from useNextBestAction().
 * - For consistency with the rest of the system, this module emits:
 *   - "ui.nba.changed" with getSnapshot()
 *   - "ui.nudge" for immediate surfaces
 *   - "ui.toast" for error/info
 * ------------------------------------------------------------------------- */
