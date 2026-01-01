/* eslint-disable no-console */
/**
 * Suka Smart Assistant — Analytics Bootstrap
 *
 * What this does:
 *  - Wires event listeners (recipes/inventory/calendar/exports/sharing/etc.)
 *  - Maintains a lightweight in-memory analytics store (counters + recent events)
 *  - Issues user-facing “next best action” nudges after key events
 *  - Supports UNDO (revert last analytics mutation)
 *  - Registers IA hooks: announces routes & nav entries to your shell
 *
 * Assumptions:
 *  - Event bus helpers: on(type, handler), emit(type, payload)
 *  - Your shell consumes `shell.routes.register` and `shell.nav.register` emissions
 *  - UI uses Tailwind/DaisyUI classes: btn, card, alert, etc. (nudges carry plain data)
 *
 * You can replace this store with a persisted one later (e.g., localforage/IndexedDB).
 */

import { on, emit } from "@/services/automation/runtime";

/* ------------------------------------------------------------------ */
/* Internal store + undo                                               */
/* ------------------------------------------------------------------ */

const state = {
  version: 1,
  totals: {
    mealPlans: 0,
    recipesChanged: 0,
    batchesStarted: 0,
    batchesCompleted: 0,
    inventoryUpdates: 0,
    calendarSyncs: 0,
    calendarEventsUpdated: 0,
    exportsCompleted: 0,
    communityShares: 0,
    familyShares: 0,
    labelsPrinted: 0,
  },
  // Keep a short rolling log for the Analytics Center UI.
  recent: [], // [{ts, type, meta}]
};

const UNDO_STACK = [];

/** Create an immutable snapshot for undo */
function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

/** Safe mutate with undo support */
function mutate(mutator, meta = { reason: "unknown" }) {
  const prev = snapshot();
  mutator(state);
  // cap recent log length
  if (state.recent.length > 200) state.recent.splice(0, state.recent.length - 200);
  UNDO_STACK.push(() => {
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, prev);
    emit("analytics.changed", { state, meta: { reason: "undo" } });
  });
  emit("analytics.changed", { state, meta });
}

/** Public undo trigger (also listens to an event below) */
function undo() {
  const last = UNDO_STACK.pop();
  if (last) last();
}

/* ------------------------------------------------------------------ */
/* Utility: push recent line                                           */
/* ------------------------------------------------------------------ */
function pushRecent(type, meta = {}) {
  state.recent.push({ ts: Date.now(), type, meta });
}

/* ------------------------------------------------------------------ */
/* Next Best Action engine                                             */
/* ------------------------------------------------------------------ */

/**
 * Emit a small suggestion card the UI can render as an alert with actions.
 * Consumers (e.g., History pages) are already listening to “...Suggestion” in your other modules,
 * we’ll align with that pattern: `analytics.nudge`.
 */
function suggest(message, actions = [], source = "analytics") {
  emit("analytics.nudge", {
    at: Date.now(),
    message,
    actions, // [{label, href}]
    source,
  });
}

/* ------------------------------------------------------------------ */
/* IA registration (routes + nav)                                      */
/* ------------------------------------------------------------------ */

/**
 * Inform the shell/router there’s an Analytics Center.
 * The shell can listen for this and register routes dynamically.
 * If you already register routes statically, keep this; it’s no-op in that case.
 */
function registerIA() {
  emit("shell.routes.register", {
    base: "/analytics",
    children: [
      { path: "", element: "AnalyticsOverview" }, // your app can map this token → real component
      { path: "events", element: "AnalyticsEvents" },
      { path: "insights", element: "AnalyticsInsights" },
    ],
  });

  emit("shell.nav.register", {
    section: "Tools",
    items: [
      { to: "/analytics", label: "Analytics", icon: "activity" },
      { to: "/analytics/events", label: "Events", icon: "list" },
      { to: "/analytics/insights", label: "Insights", icon: "sparkles" },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Derivers: micro-insights + nudges                                   */
/* ------------------------------------------------------------------ */

function afterMealPlanCreated(payload) {
  // Ex: nudge user to export ICS or share with family/community
  suggest("Meal plan created. Add to calendar or share with family?", [
    { label: "Create Calendar (.ics)", href: "/export?format=ics" },
    { label: "Share to Family", href: "/family" },
    { label: "Batch Cooking Session", href: "/tier2/household/meals#batch" },
  ], "mealplan.created");
}

function afterBatchCompleted(payload) {
  // Encourage labels & storehouse updates
  suggest("Batch completed. Print labels and update storehouse?", [
    { label: "Print Labels", href: "/export?format=labels" },
    { label: "Update Storehouse", href: "/tier2/household/inventory" },
    { label: "Share with Community", href: "/community" },
  ], "batch.completed");
}

function afterInventoryUpdated(payload) {
  if (payload?.lowStockCount > 0) {
    suggest(`Low stock flagged (${payload.lowStockCount}). Generate shopping list?`, [
      { label: "Shopping List", href: "/tier2/household/meals#shopping" },
      { label: "Link to Meal Plan", href: "/tier2/household/meals" },
    ], "inventory.updated");
  }
}

function afterCalendarEventsUpdated(payload) {
  suggest("Calendar updated. Share tasks and roles to align family?", [
    { label: "Share to Family Board", href: "/family/board" },
    { label: "Send Summary", href: "/family" },
  ], "calendar.events.updated");
}

function afterExportCompleted(payload) {
  const t = payload?.type || "file";
  suggest(`Exported ${t}. Do you want to share or file it?`, [
    { label: "Share to Family", href: "/family" },
    { label: "Share to Community", href: "/community" },
    { label: "Open Exports Folder", href: "/files/exports" },
  ], "export.completed");
}

/* ------------------------------------------------------------------ */
/* Event listeners (recipes, inventory, calendar, etc.)                */
/* ------------------------------------------------------------------ */

function registerListeners() {
  // — Core cooking/meal planning —
  on("mealplan.created", (evt) => {
    mutate((s) => {
      s.totals.mealPlans += 1;
      pushRecent(evt.type, { title: evt?.payload?.title });
    }, { reason: "mealplan.created" });
    afterMealPlanCreated(evt?.payload);
  });

  on("recipes.updated", (evt) => {
    mutate((s) => {
      s.totals.recipesChanged += 1;
      pushRecent(evt.type, { count: evt?.payload?.count });
    }, { reason: "recipes.updated" });
  });

  on("batch.started", (evt) => {
    mutate((s) => {
      s.totals.batchesStarted += 1;
      pushRecent(evt.type, { sessionId: evt?.payload?.id });
    }, { reason: "batch.started" });
  });

  on("batch.completed", (evt) => {
    mutate((s) => {
      s.totals.batchesCompleted += 1;
      pushRecent(evt.type, { sessionId: evt?.payload?.id });
    }, { reason: "batch.completed" });
    afterBatchCompleted(evt?.payload);
  });

  // — Inventory & storehouse —
  on("inventory.updated", (evt) => {
    mutate((s) => {
      s.totals.inventoryUpdates += 1;
      pushRecent(evt.type, {
        delta: evt?.payload?.delta,
        lowStockCount: evt?.payload?.lowStockCount || 0,
      });
    }, { reason: "inventory.updated" });
    afterInventoryUpdated(evt?.payload);
  });

  on("storehouse.updated", (evt) => {
    mutate((s) => {
      pushRecent(evt.type, { note: "storehouse delta recorded" });
    }, { reason: "storehouse.updated" });
  });

  // — Calendar —
  on("calendar.synced", (evt) => {
    mutate((s) => {
      s.totals.calendarSyncs += 1;
      pushRecent(evt.type, { provider: evt?.payload?.provider });
    }, { reason: "calendar.synced" });
  });

  on("calendar.events.updated", (evt) => {
    mutate((s) => {
      s.totals.calendarEventsUpdated += 1;
      pushRecent(evt.type, { count: evt?.payload?.count });
    }, { reason: "calendar.events.updated" });
    afterCalendarEventsUpdated(evt?.payload);
  });

  // — Exports —
  on("export.completed", (evt) => {
    mutate((s) => {
      s.totals.exportsCompleted += 1;
      pushRecent(evt.type, {
        type: evt?.payload?.type,
        sizeBytes: evt?.payload?.sizeBytes,
      });
    }, { reason: "export.completed" });
    afterExportCompleted(evt?.payload);
  });

  // — Sharing —
  on("community.share.completed", (evt) => {
    mutate((s) => {
      s.totals.communityShares += 1;
      pushRecent(evt.type, { channelId: evt?.payload?.channelId });
    }, { reason: "community.share.completed" });
  });

  on("family.share.completed", (evt) => {
    mutate((s) => {
      s.totals.familyShares += 1;
      pushRecent(evt.type, { channelId: evt?.payload?.channelId });
    }, { reason: "family.share.completed" });
  });

  // — Labels (often after batches/curing) —
  on("labels.printed", (evt) => {
    mutate((s) => {
      s.totals.labelsPrinted += 1;
      pushRecent(evt.type, { count: evt?.payload?.count });
    }, { reason: "labels.printed" });
  });

  // — Garden / Animals / Chores (for completeness, they still feed insights) —
  on("garden.plan.updated", (evt) => {
    mutate((s) => {
      pushRecent(evt.type, { beds: evt?.payload?.beds });
    }, { reason: "garden.plan.updated" });
  });

  on("animals.plan.updated", (evt) => {
    mutate((s) => {
      pushRecent(evt.type, { herd: evt?.payload?.herdSize });
    }, { reason: "animals.plan.updated" });
  });

  on("chores.routines.updated", (evt) => {
    mutate((s) => {
      pushRecent(evt.type, { routines: evt?.payload?.count });
    }, { reason: "chores.routines.updated" });
  });

  // — Undo support (global trigger) —
  on("analytics.undo", () => undo());
}

/* ------------------------------------------------------------------ */
/* Public API (exported)                                              */
/* ------------------------------------------------------------------ */

/**
 * Boot the Analytics Service. Call once during app startup.
 * Safe to call multiple times; it guards repeated IA registration with a flag.
 */
let _booted = false;
export function bootstrapAnalytics() {
  if (_booted) return;
  _booted = true;

  registerIA();
  registerListeners();

  // If truly empty, emit a friendly empty-state signal so the AnalyticsOverview page
  // can show a welcome card with “how to get started”.
  const isEmpty =
    state.totals.mealPlans === 0 &&
    state.totals.recipesChanged === 0 &&
    state.totals.inventoryUpdates === 0 &&
    state.totals.calendarSyncs === 0 &&
    state.totals.exportsCompleted === 0 &&
    state.totals.communityShares === 0 &&
    state.totals.familyShares === 0;

  if (isEmpty) {
    emit("analytics.empty", {
      message:
        "No activity yet. Start by planning meals, updating inventory, or syncing your calendar.",
      actions: [
        { label: "Open Meal Planner", href: "/tier2/household/meals" },
        { label: "Review Inventory", href: "/tier2/household/inventory" },
        { label: "Open Calendar", href: "/calendar" },
      ],
    });
  }

  // Announce first state so any listeners can render immediately
  emit("analytics.changed", { state: snapshot(), meta: { reason: "boot" } });

  // Health log
  if (import.meta?.env?.DEV) {
    console.debug("[analytics] booted");
  }
}

/* ------------------------------------------------------------------ */
/* Optional getters (if you want direct reads in widgets)              */
/* ------------------------------------------------------------------ */

export function getAnalyticsState() {
  return snapshot();
}

export function analyticsUndo() {
  undo();
}

/* ------------------------------------------------------------------ */
/* Notes for UI implementers (consistent design system)                */
/* ------------------------------------------------------------------ */
/**
 * - Listen for:
 *     - "analytics.changed": payload.state has { totals, recent }
 *     - "analytics.nudge": { message, actions: [{label, href}], source }
 *     - "analytics.empty": { message, actions }
 *
 * - Render:
 *     - Overview: show cards with totals (btn/btn-outline to drill into “events/insights”)
 *     - Events: list `recent` as a table (time, type, meta) with filters + “Undo” button
 *       -> On “Undo”, emit("analytics.undo")
 *     - Insights: simple heuristics (e.g., “3 batches this week; 0 labels printed”)
 *       -> Provide “Next best actions” buttons styled with .btn classes
 *
 * - Confirmation states:
 *     - When a user clicks a suggested action, your page can show a toast/alert like:
 *       .alert .alert-info or .alert-success after success.
 */
