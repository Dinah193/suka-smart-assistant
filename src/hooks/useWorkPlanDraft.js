/* eslint-disable no-console */
/**
 * useWorkPlanDraft.js — universal draft manager for domain work plans (ES2015-safe)
 *
 * Goals:
 * - Create/apply/update a plan draft for any domain: "meals" | "cleaning" | "animals" | "garden" | "custom"
 * - Defensive imports against missing services; never crash the app
 * - Event-driven: emit canonical events (draft.created, draft.updated, draft.published, etc.)
 * - Undo/redo stack and patch-level updates
 * - NBA (Next Best Action) helper derived from timers, dependencies, blockers, inventory, and readiness
 * - Integrations (best-effort): ReminderManager, InventoryMonitor, scheduleHelpers, estimateEngine, automation runtime
 * - Timers & pre-steps (defrost/marinate/proof/preheat, withhold times, weather holds)
 * - Conflict detection: overlaps, resource locks, PPE requirements, appliance collisions
 * - Cost estimation hooks (detergent/feed/seed/consumables)
 * - Persistence: Dexie (if present) or localStorage fallback; session-safe recovery
 * - Works in React and also usable as a non-React module via createDraftManager()
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ----------------------------- Safe Imports -----------------------------
let eventBus = { on: function(){}, off: function(){}, emit: function(){} };
try {
  // eventBus should expose: on(event, fn), off(event, fn), emit(event, payload)
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
} catch (e) {}

let automation = { schedule: async () => {}, cancel: async () => {}, invoke: async () => ({}) };
try {
  const a = require("@/services/automation/runtime");
  automation = (a && (a.automation || a.default || a)) || automation;
} catch (e) {}

let ReminderManager = { create: () => {}, cancel: () => {}, list: () => [] };
try {
  const r = require("@/managers/ReminderManager");
  ReminderManager = (r && (r.default || r)) || ReminderManager;
} catch (e) {}

let InventoryMonitor = { check: () => ({ ok: true, missing: [] }), reserve: () => {}, release: () => {} };
try {
  const i = require("@/managers/InventoryMonitor");
  InventoryMonitor = (i && (i.default || i)) || InventoryMonitor;
} catch (e) {}

let scheduleHelpers = {
  planPreSteps: () => ({ reminders: [], holds: [] }),
  computeWithholds: () => ({ withholds: [] }),
  weatherHolds: () => ({ holds: [] }),
  // legacy signatures kept for backward compatibility
};
try {
  const s = require("@/utils/scheduleHelpers");
  scheduleHelpers = (s && (s.default || s)) || scheduleHelpers;
} catch (e) {}

let estimateEngine = {
  estimate: () => ({ currency: "USD", subtotal: 0, lines: [] }),
};
try {
  const ee = require("@/engines/estimateEngine");
  estimateEngine = (ee && (ee.default || ee)) || estimateEngine;
} catch (e) {}

let stabilityScore = { evaluate: () => ({ score: 0.7, signals: [] }) };
try {
  const ss = require("@/engines/stabilityScore");
  stabilityScore = (ss && (ss.default || ss)) || stabilityScore;
} catch (e) {}

let DexieDB = null;
try {
  // Optional Dexie DB that exposes drafts table with put/get/delete
  const db = require("@/data/db");
  DexieDB = db && (db.default || db);
} catch (e) {}

// ----------------------------- Utilities -----------------------------
const nowIso = () => new Date().toISOString();
const uid = (pfx = "draft") =>
  pfx + ":" + Math.random().toString(36).slice(2) + ":" + Date.now();

const safeJSON = {
  parse: (s, fallback) => {
    try { return JSON.parse(s); } catch { return fallback; }
  },
  stringify: (o) => {
    try { return JSON.stringify(o); } catch { return "{}"; }
  }
};

const idle = (fn) => {
  if (typeof window !== "undefined" && window.requestIdleCallback) {
    return window.requestIdleCallback(fn, { timeout: 500 });
  }
  return setTimeout(fn, 0);
};

// ----------------------------- Defaults & Shapes -----------------------------
/**
 * Draft shape (domain-agnostic):
 * {
 *   id, domain, title, createdAt, updatedAt, sessionId,
 *   meta: { author, notes, tags:[], flags:[] },
 *   timeline: { startAt, endAt, timezone, holds:[], reminders:[] },
 *   tasks: [
 *     {
 *       id, title, kind, status: "pending"|"ready"|"active"|"paused"|"done"|"blocked",
 *       estMinutes, actualMinutes, ppe:[], resources:[], appliances:[],
 *       deps: [taskId], window: { earliest, latest }, scheduledAt,
 *       timers: { startAt, endAt, alarms:[] },
 *       inventory: { items:[{ sku, name, qty, unit }], reserveOnStart:true },
 *       costHints: { category, supplierProfileId, overrides:{} },
 *       notes, flags:[]
 *     }
 *   ],
 *   conflicts: [], // computed
 *   cost: { currency, subtotal, lines:[] },
 *   score: { stability: 0, signals: [] },
 *   nba: { id, label, reason, taskId },
 *   history: { past:[], future:[] } // undo/redo stacks (store patches)
 * }
 */

const DEFAULT_DOMAIN_META = {
  meals: { ppeDefaults: ["apron", "gloves"], resourceLocks: ["stove","oven","sink"] },
  cleaning: { ppeDefaults: ["gloves", "mask"], resourceLocks: ["sink","washer","dryer"] },
  animals: { ppeDefaults: ["gloves","apron","face shield"], resourceLocks: ["butcher-table","scalder","chiller"] },
  garden: { ppeDefaults: ["gloves","boots"], resourceLocks: ["hose","spigot","shed"] },
  custom: { ppeDefaults: [], resourceLocks: [] }
};

function createEmptyDraft(domain = "custom", seed = {}) {
  const meta = DEFAULT_DOMAIN_META[domain] || DEFAULT_DOMAIN_META.custom;
  return {
    id: seed.id || uid("workplan"),
    domain,
    title: seed.title || (domain.charAt(0).toUpperCase() + domain.slice(1)) + " Plan",
    createdAt: seed.createdAt || nowIso(),
    updatedAt: nowIso(),
    sessionId: seed.sessionId || null,
    meta: { author: seed.author || null, notes: "", tags: [], flags: [] },
    timeline: {
      startAt: seed.startAt || null,
      endAt: seed.endAt || null,
      timezone: seed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      holds: [],
      reminders: []
    },
    tasks: [],
    conflicts: [],
    cost: { currency: "USD", subtotal: 0, lines: [] },
    score: { stability: 0, signals: [] },
    nba: { id: null, label: null, reason: null, taskId: null },
    history: { past: [], future: [] },
    _meta: meta
  };
}

// ----------------------------- Conflict Detection -----------------------------
function detectConflicts(draft) {
  const conflicts = [];

  // Overlapping appliance/resource usage across active/scheduled tasks
  const usage = Object.create(null);
  draft.tasks.forEach((t) => {
    const at = t.scheduledAt || t.timers?.startAt;
    const end = t.timers?.endAt;
    const span = { start: at ? new Date(at).getTime() : null, end: end ? new Date(end).getTime() : null };

    const resources = (t.appliances || []).concat(t.resources || []);
    resources.forEach((r) => {
      usage[r] = usage[r] || [];
      usage[r].push({ taskId: t.id, span });
    });
  });

  Object.keys(usage).forEach((r) => {
    const spans = usage[r].filter(s => s.span.start != null && s.span.end != null);
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        const a = spans[i].span, b = spans[j].span;
        if (a.start < b.end && b.start < a.end) {
          conflicts.push({
            type: "resource-overlap",
            resource: r,
            tasks: [spans[i].taskId, spans[j].taskId],
            message: `Overlap on ${r} between ${spans[i].taskId} and ${spans[j].taskId}`
          });
        }
      }
    }
  });

  // PPE compliance check
  draft.tasks.forEach((t) => {
    const req = (t.ppe || []);
    const missing = req.filter(Boolean).filter(p => p && p.startsWith("!"));
    if (missing.length) {
      conflicts.push({
        type: "ppe-missing",
        taskId: t.id,
        message: `PPE missing: ${missing.join(", ")}`
      });
    }
  });

  return conflicts;
}

// ----------------------------- NBA (Next Best Action) -----------------------------
function computeNBA(draft) {
  // Simple heuristic:
  // 1) any "blocked" -> suggest resolving dependencies
  // 2) any "ready" with earliest window satisfied -> do earliest
  // 3) any "pending" where pre-steps (defrost/marinate/etc.) need scheduling -> schedule now
  // 4) else pick the soonest scheduled "pending"

  const now = Date.now();
  const blocked = draft.tasks.find(t => t.status === "blocked");
  if (blocked) {
    return {
      id: "resolve-blocker",
      label: "Resolve dependencies",
      reason: "A task is blocked",
      taskId: blocked.id
    };
  }

  const ready = draft.tasks
    .filter(t => t.status === "ready")
    .filter(t => !t.window?.earliest || new Date(t.window.earliest).getTime() <= now)
    .sort((a, b) => {
      const ae = a.window?.earliest ? new Date(a.window.earliest).getTime() : 0;
      const be = b.window?.earliest ? new Date(b.window.earliest).getTime() : 0;
      return ae - be;
    });

  if (ready[0]) {
    return {
      id: "start-ready-task",
      label: "Start the next ready task",
      reason: "A task is ready and within its window",
      taskId: ready[0].id
    };
  }

  const needsPreSteps = draft.tasks.find(t => (t.flags || []).some(f => /defrost|marinate|proof|preheat/i.test(f)));
  if (needsPreSteps) {
    return {
      id: "schedule-presteps",
      label: "Schedule pre-steps",
      reason: "Some tasks require pre-steps",
      taskId: needsPreSteps.id
    };
  }

  const soonest = draft.tasks
    .filter(t => t.status === "pending" && t.scheduledAt)
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

  if (soonest[0]) {
    return {
      id: "prepare-soonest",
      label: "Prepare for upcoming task",
      reason: "A task is coming up soon",
      taskId: soonest[0].id
    };
  }

  return { id: null, label: null, reason: null, taskId: null };
}

// ----------------------------- Pre-steps & Holds -----------------------------
function computePreStepsAndHolds(draft) {
  const pre = scheduleHelpers.planPreSteps
    ? scheduleHelpers.planPreSteps(draft)
    : { reminders: [], holds: [] };

  const withholds = scheduleHelpers.computeWithholds
    ? scheduleHelpers.computeWithholds(draft)
    : { withholds: [] };

  const weather = scheduleHelpers.weatherHolds
    ? scheduleHelpers.weatherHolds(draft)
    : { holds: [] };

  return {
    reminders: (pre.reminders || []).concat([]),
    holds: (pre.holds || []).concat(weather.holds || []),
    withholds: withholds.withholds || []
  };
}

// ----------------------------- Persistence -----------------------------
const LS_KEY = "suka:workplan:drafts";

async function persistDraft(draft) {
  // Dexie if available
  if (DexieDB && DexieDB.drafts && DexieDB.drafts.put) {
    try { await DexieDB.drafts.put(draft); return; } catch (e) { console.warn("Dexie put failed", e); }
  }
  // localStorage fallback
  try {
    const all = safeJSON.parse(localStorage.getItem(LS_KEY), {});
    all[draft.id] = draft;
    localStorage.setItem(LS_KEY, safeJSON.stringify(all));
  } catch (e) {}
}

async function loadDraft(id) {
  if (!id) return null;
  if (DexieDB && DexieDB.drafts && DexieDB.drafts.get) {
    try { const d = await DexieDB.drafts.get(id); if (d) return d; } catch (e) { console.warn("Dexie get failed", e); }
  }
  try {
    const all = safeJSON.parse(localStorage.getItem(LS_KEY), {});
    return all[id] || null;
  } catch (e) { return null; }
}

async function deleteDraft(id) {
  if (!id) return;
  if (DexieDB && DexieDB.drafts && DexieDB.drafts.delete) {
    try { await DexieDB.drafts.delete(id); } catch (e) { console.warn("Dexie delete failed", e); }
  }
  try {
    const all = safeJSON.parse(localStorage.getItem(LS_KEY), {});
    delete all[id];
    localStorage.setItem(LS_KEY, safeJSON.stringify(all));
  } catch (e) {}
}

// ----------------------------- Patch & History -----------------------------
function applyPatch(draft, patch) {
  // shallow merge for top-level, special handling for tasks array
  const next = { ...draft, ...patch, updatedAt: nowIso() };
  if (patch.tasks) {
    next.tasks = patch.tasks.map(t => ({ ...t }));
  }
  return next;
}

function pushHistory(draft) {
  const copy = JSON.parse(JSON.stringify(draft));
  // Avoid recursive history growth
  copy.history = { past: [], future: [] };
  return copy;
}

// ----------------------------- Public API (Hook) -----------------------------
export function useWorkPlanDraft() {
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const recompute = useCallback((base) => {
    const conflicts = detectConflicts(base);
    const pre = computePreStepsAndHolds(base);
    const cost = estimateEngine.estimate ? estimateEngine.estimate(base) : base.cost;
    const score = stabilityScore.evaluate ? stabilityScore.evaluate(base) : base.score;
    const nba = computeNBA(base);
    const timeline = {
      ...base.timeline,
      holds: pre.holds,
      reminders: pre.reminders
    };
    return { ...base, conflicts, cost, score: { stability: score.score || 0, signals: score.signals || [] }, nba, timeline };
  }, []);

  const startDraft = useCallback(async (domain = "custom", seed = {}) => {
    setLoading(true);
    const d = createEmptyDraft(domain, seed);
    const next = recompute(d);
    eventBus.emit("workplan.draft.created", { draft: next });
    await persistDraft(next);
    if (mounted.current) setDraft(next);
    setLoading(false);
    return next;
  }, [recompute]);

  const loadExisting = useCallback(async (id) => {
    setLoading(true);
    const existing = await loadDraft(id);
    const next = existing ? recompute(existing) : null;
    if (next) eventBus.emit("workplan.draft.loaded", { draft: next });
    if (mounted.current) setDraft(next);
    setLoading(false);
    return next;
  }, [recompute]);

  const patchDraft = useCallback(async (patch, meta = { label: "update" }) => {
    if (!draft) return null;
    const prevSnap = pushHistory(draft);
    let next = applyPatch(draft, patch);
    next.history = { past: [...draft.history.past, prevSnap], future: [] };
    next = recompute(next);
    eventBus.emit("workplan.draft.updated", { draft: next, meta });
    await persistDraft(next);
    if (mounted.current) setDraft(next);
    return next;
  }, [draft, recompute]);

  const undo = useCallback(async () => {
    if (!draft || !draft.history.past.length) return draft;
    const prev = draft.history.past[draft.history.past.length - 1];
    const future = pushHistory(draft);
    let next = { ...prev, history: { past: draft.history.past.slice(0, -1), future: [future, ...draft.history.future] } };
    next = recompute(next);
    eventBus.emit("workplan.draft.undo", { draft: next });
    await persistDraft(next);
    if (mounted.current) setDraft(next);
    return next;
  }, [draft, recompute]);

  const redo = useCallback(async () => {
    if (!draft || !draft.history.future.length) return draft;
    const head = draft.history.future[0];
    const past = pushHistory(draft);
    let next = { ...head, history: { past: [...draft.history.past, past], future: draft.history.future.slice(1) } };
    next = recompute(next);
    eventBus.emit("workplan.draft.redo", { draft: next });
    await persistDraft(next);
    if (mounted.current) setDraft(next);
    return next;
  }, [draft, recompute]);

  // ---------------- Task Helpers ----------------
  const addTask = useCallback(async (task) => {
    if (!draft) return null;
    const t = {
      id: task.id || uid("task"),
      title: task.title || "Untitled Task",
      kind: task.kind || "general",
      status: task.status || "pending",
      estMinutes: task.estMinutes || 15,
      actualMinutes: task.actualMinutes || 0,
      ppe: task.ppe || draft._meta.ppeDefaults || [],
      resources: task.resources || [],
      appliances: task.appliances || [],
      deps: task.deps || [],
      window: task.window || { earliest: null, latest: null },
      scheduledAt: task.scheduledAt || null,
      timers: task.timers || { startAt: null, endAt: null, alarms: [] },
      inventory: task.inventory || { items: [], reserveOnStart: true },
      costHints: task.costHints || { category: null, supplierProfileId: null, overrides: {} },
      notes: task.notes || "",
      flags: task.flags || []
    };
    return patchDraft({ tasks: [...draft.tasks, t] }, { label: "add-task", id: t.id });
  }, [draft, patchDraft]);

  const updateTask = useCallback(async (taskId, patch) => {
    if (!draft) return null;
    const tasks = draft.tasks.map(t => (t.id === taskId ? { ...t, ...patch } : t));
    return patchDraft({ tasks }, { label: "update-task", id: taskId });
  }, [draft, patchDraft]);

  const removeTask = useCallback(async (taskId) => {
    if (!draft) return null;
    const tasks = draft.tasks.filter(t => t.id !== taskId);
    return patchDraft({ tasks }, { label: "remove-task", id: taskId });
  }, [draft, patchDraft]);

  const addDependency = useCallback(async (taskId, depId) => {
    if (!draft) return null;
    const tasks = draft.tasks.map(t => {
      if (t.id === taskId) {
        const deps = Array.from(new Set([...(t.deps || []), depId]));
        return { ...t, deps };
      }
      return t;
    });
    return patchDraft({ tasks }, { label: "add-dependency", id: taskId });
  }, [draft, patchDraft]);

  // ---------------- Scheduling / Reminders ----------------
  const schedulePreSteps = useCallback(async () => {
    if (!draft) return draft;
    const { reminders, holds, withholds } = computePreStepsAndHolds(draft);

    // create reminders via ReminderManager (best-effort)
    reminders.forEach((r) => {
      try {
        ReminderManager.create(r);
      } catch (e) {}
    });

    // record holds/withholds onto timeline
    return patchDraft({
      timeline: {
        ...draft.timeline,
        holds: holds,
        reminders: reminders
      },
      meta: {
        ...draft.meta,
        flags: Array.from(new Set([...(draft.meta.flags || []), ...(withholds.length ? ["has-withholds"] : [])]))
      }
    }, { label: "schedule-presteps" });
  }, [draft, patchDraft]);

  const setTaskTimer = useCallback(async (taskId, startAt, endAt) => {
    if (!draft) return null;
    const tasks = draft.tasks.map(t => (t.id === taskId ? {
      ...t,
      timers: { ...(t.timers || {}), startAt, endAt }
    } : t));
    return patchDraft({ tasks }, { label: "set-task-timer", id: taskId });
  }, [draft, patchDraft]);

  // ---------------- Inventory ----------------
  const verifyInventory = useCallback(async () => {
    if (!draft) return { ok: true, missing: [] };
    const response = InventoryMonitor.check ? InventoryMonitor.check(draft) : { ok: true, missing: [] };
    if (!response.ok && response.missing?.length) {
      // tag draft for UI attention
      await patchDraft({ meta: { ...draft.meta, flags: Array.from(new Set([...(draft.meta.flags||[]), "inventory-missing"])) } }, { label: "inventory-missing" });
    }
    return response;
  }, [draft, patchDraft]);

  const reserveOnStart = useCallback(async (taskId) => {
    if (!draft) return;
    const t = draft.tasks.find(x => x.id === taskId);
    if (t && t.inventory?.reserveOnStart && InventoryMonitor.reserve) {
      try { InventoryMonitor.reserve({ task: t, draftId: draft.id }); } catch (e) {}
    }
  }, [draft]);

  // ---------------- Templates ----------------
  const applyTemplate = useCallback(async (template) => {
    // template: { title?, tasks:[], timeline?, meta? }
    if (!draft) return null;
    const next = {
      title: template.title || draft.title,
      tasks: [...draft.tasks, ...(template.tasks || [])],
      timeline: { ...draft.timeline, ...(template.timeline || {}) },
      meta: { ...draft.meta, ...(template.meta || {}) }
    };
    return patchDraft(next, { label: "apply-template" });
  }, [draft, patchDraft]);

  // ---------------- Cost Estimation ----------------
  const estimateCosts = useCallback(async () => {
    if (!draft) return null;
    const cost = estimateEngine.estimate ? estimateEngine.estimate(draft) : draft.cost;
    return patchDraft({ cost }, { label: "estimate-costs" });
  }, [draft, patchDraft]);

  // ---------------- Publish / Persist ----------------
  const save = useCallback(async () => {
    if (!draft) return null;
    await persistDraft(draft);
    eventBus.emit("workplan.draft.saved", { draft });
    return draft;
  }, [draft]);

  const publish = useCallback(async (opts = { finalize: true, background: false }) => {
    if (!draft) return null;

    // schedule via automation runtime (best-effort)
    let automationResult = null;
    try {
      automationResult = await automation.schedule({ type: "workplan.publish", payload: { draft, opts } });
    } catch (e) { automationResult = null; }

    // emit and persist
    eventBus.emit("workplan.draft.published", { draft, result: automationResult });
    if (opts.finalize) {
      // move to immutable state if you keep a published store elsewhere; here we simply tag & persist
      const next = await patchDraft({ meta: { ...draft.meta, flags: Array.from(new Set([...(draft.meta.flags||[]), "published"])) } }, { label: "publish" });
      return next;
    }
    return draft;
  }, [draft, patchDraft]);

  const discard = useCallback(async () => {
    if (!draft) return;
    await deleteDraft(draft.id);
    eventBus.emit("workplan.draft.discarded", { id: draft.id });
    if (mounted.current) setDraft(null);
  }, [draft]);

  // ---------------- NBA Orchestrations ----------------
  const getNBA = useCallback(() => draft?.nba || { id: null }, [draft]);

  const actOnNBA = useCallback(async () => {
    if (!draft || !draft.nba?.id) return;
    const { id, taskId } = draft.nba;

    if (id === "resolve-blocker") {
      // mark deps as priority or surface ConflictResolverBar UI
      eventBus.emit("ui.conflictResolver.open", { draftId: draft.id, taskId });
    } else if (id === "start-ready-task") {
      await updateTask(taskId, { status: "active" });
      idle(() => reserveOnStart(taskId));
    } else if (id === "schedule-presteps") {
      await schedulePreSteps();
    } else if (id === "prepare-soonest") {
      // open HUD or modal to preview upcoming steps
      eventBus.emit("ui.sessionHUD.focusTask", { draftId: draft.id, taskId });
    }
  }, [draft, reserveOnStart, schedulePreSteps, updateTask]);

  // ---------------- Auto-save & Coalescing ----------------
  useEffect(() => {
    if (!draft) return;
    const handle = idle(() => persistDraft(draft));
    return () => { try { if (typeof window !== "undefined" && window.cancelIdleCallback) window.cancelIdleCallback(handle); else clearTimeout(handle); } catch(e) {} };
  }, [draft]);

  // ---------------- Event Listeners (optional) ----------------
  useEffect(() => {
    const onSessionPause = (e) => {
      const { sessionId } = e || {};
      if (!draft || !sessionId || draft.sessionId !== sessionId) return;
      // Convert active timers into reminders if needed (marinating/proofing/etc.)
      schedulePreSteps();
    };
    const onInventoryUpdated = async () => {
      // Re-verify inventory and update NBA/conflicts
      await verifyInventory();
      if (draft) await patchDraft({}, { label: "recompute" });
    };

    eventBus.on && eventBus.on("session.paused", onSessionPause);
    eventBus.on && eventBus.on("inventory.updated", onInventoryUpdated);
    return () => {
      eventBus.off && eventBus.off("session.paused", onSessionPause);
      eventBus.off && eventBus.off("inventory.updated", onInventoryUpdated);
    };
  }, [draft, schedulePreSteps, verifyInventory, patchDraft]);

  // ---------------- Derived ----------------
  const activeTasks = useMemo(
    () => (draft ? draft.tasks.filter(t => t.status === "active") : []),
    [draft]
  );
  const pendingTasks = useMemo(
    () => (draft ? draft.tasks.filter(t => t.status === "pending" || t.status === "ready") : []),
    [draft]
  );

  return {
    draft, loading,

    // lifecycle
    startDraft,
    loadExisting,
    save,
    publish,
    discard,

    // edit
    patchDraft,
    addTask,
    updateTask,
    removeTask,
    addDependency,

    // schedule
    schedulePreSteps,
    setTaskTimer,

    // inventory
    verifyInventory,
    reserveOnStart,

    // templates & costs
    applyTemplate,
    estimateCosts,

    // undo/redo
    undo,
    redo,

    // nba
    getNBA,
    actOnNBA,

    // derived
    activeTasks,
    pendingTasks,
  };
}

// ----------------------------- Non-React Factory (Optional) -----------------------------
/**
 * A plain JS manager if you need to manipulate drafts outside React (e.g., engines).
 * Returns a subset of the same API. Internally keeps its own state and emits events.
 */
export function createDraftManager(initial = null) {
  let state = initial || createEmptyDraft("custom", {});
  const listeners = new Set();

  const emit = (next) => {
    state = next;
    listeners.forEach((fn) => fn(state));
    idle(() => persistDraft(state));
  };

  const recompute = (base) => {
    const conflicts = detectConflicts(base);
    const pre = computePreStepsAndHolds(base);
    const cost = estimateEngine.estimate ? estimateEngine.estimate(base) : base.cost;
    const score = stabilityScore.evaluate ? stabilityScore.evaluate(base) : base.score;
    const nba = computeNBA(base);
    const timeline = { ...base.timeline, holds: pre.holds, reminders: pre.reminders };
    return { ...base, conflicts, cost, score: { stability: score.score || 0, signals: score.signals || [] }, nba, timeline };
  };

  return {
    get() { return state; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async startDraft(domain = "custom", seed = {}) {
      const d = createEmptyDraft(domain, seed);
      const next = recompute(d);
      eventBus.emit("workplan.draft.created", { draft: next });
      await persistDraft(next);
      emit(next);
      return next;
    },
    async patch(patch, meta = { label: "update" }) {
      const prevSnap = pushHistory(state);
      let next = applyPatch(state, patch);
      next.history = { past: [...state.history.past, prevSnap], future: [] };
      next = recompute(next);
      eventBus.emit("workplan.draft.updated", { draft: next, meta });
      await persistDraft(next);
      emit(next);
      return next;
    },
    async applyTemplate(template) {
      const next = {
        title: template.title || state.title,
        tasks: [...state.tasks, ...(template.tasks || [])],
        timeline: { ...state.timeline, ...(template.timeline || {}) },
        meta: { ...state.meta, ...(template.meta || {}) }
      };
      return this.patch(next, { label: "apply-template" });
    },
    async estimateCosts() {
      const cost = estimateEngine.estimate ? estimateEngine.estimate(state) : state.cost;
      return this.patch({ cost }, { label: "estimate-costs" });
    },
    async publish(opts = { finalize: true }) {
      let automationResult = null;
      try { automationResult = await automation.schedule({ type: "workplan.publish", payload: { draft: state, opts } }); } catch (e) {}
      eventBus.emit("workplan.draft.published", { draft: state, result: automationResult });
      if (opts.finalize) {
        return this.patch({ meta: { ...state.meta, flags: Array.from(new Set([...(state.meta.flags||[]), "published"])) } }, { label: "publish" });
      }
      return state;
    }
  };
}
