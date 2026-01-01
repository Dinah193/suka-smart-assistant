// C:\Users\larho\suka-smart-assistant\src\store\CleaningStore.js
/* eslint-disable no-console */
/**
 * CleaningStore (dynamic, agent- & Sabbath-aware)
 * -----------------------------------------------
 * Central state + utilities for household cleaning.
 *
 * Coordinates:
 *  - Zones & routines (presets, cadence, intensity)
 *  - Sessions & logs (start/finish, per-task items)
 *  - Supplies awareness (thresholds, restock, age)
 *  - Overdue detection and “quick reset” helpers
 *  - Sabbath/quiet-hours behavior (gentle nudges vs. heavy tasks)
 *  - Soft integrations: DexieDB, cleaningAgent, inventoryAgent, n8n, sockets
 *  - Emits domain events compatible with the household orchestrator
 *
 * Homepage/KPIs (4):
 *  - kpi.todayTasksCount() -> “Today’s cleaning tasks”
 *  - kpi.listTodayTasks() -> list for drill-in navigation
 *  - kpi.overdueZonesCount() / listOverdueZones() -> optional badge/list
 *  - kpi.activeSessionsCount() -> show “in progress” dot
 *
 * Public API (summary)
 *  init()
 *  listZones({ active? })
 *  upsertZone(zone)
 *  markZoneCleaned(id, { whenISO? })
 *  getRoutine(id) / upsertRoutine(doc) / buildRoutine(opts)
 *  startSession({ title?, preset? }) / finishSession(sessionId, summary?)
 *  recordTask({ sessionId?, zone, title, estMin?, supplyKey?, notes? })
 *  getOverdueZones({ graceDays?, limit? })
 *  detectTriggers()
 *  computeSupplyNeeds({ preferMissingOnly? })
 *  reserveSupplies(lines)
 *  suggestQuickWins({ max? })
 *  todaysReminders({ now? })
 *  progressForToday()
 *  buildSessionDraft() / approveDraft(id)        // NEW: visible draft flow
 *  kpi.*
 */

import { v4 as uuidv4 } from "uuid";

/* -------------------- Safe dynamic import helpers -------------------- */
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try {
      // Vite cannot analyze a variable path; explicitly ignore on purpose.
      // eslint-disable-next-line no-await-in-loop
      const mod = await import(/* @vite-ignore */ p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}

function safeNowISO() { return new Date().toISOString(); }
function toISODate(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x.toISOString(); }

/* -------------------- Optional socket (no require) -------------------- */
async function safeGetSocket() {
  try {
    const mod = await safeImportMany([
      "@/server/services/socket.js",
      "@/server/services/socket/index.js",
      "@/services/socket.js",
    ]);
    return mod?.socket || mod?.getSocket?.() || null;
  } catch { return null; }
}
async function broadcast(event, payload) {
  try { window.dispatchEvent?.(new CustomEvent(event, { detail: payload })); } catch {}
  try { (await safeGetSocket())?.emit?.(event, payload); } catch {}
}

let EVENTS = {};
(async () => {
  const ont = await safeImportMany(["@/shared/ontology.js", "@/shared/ontology"]);
  EVENTS = ont?.EVENTS || {};
})();

/* -------------------- Settings & Sabbath helpers -------------------- */
async function loadSettings() {
  const Settings = await safeImportMany(["@/store/SettingsStore.js", "@/store/SettingsStore"]);
  const get = async (k, d) => { try { const v = await Settings?.get?.(k); return v ?? d; } catch { return d; } };
  return {
    quietHours: await get("quietHours", { start: 21, end: 7 }),
    sabbathAvoid: await get("sabbath.avoidSaturday", true),
    profileKey: await get("profile.key", "standard-home"),
    cleaning: {
      overdueDays: await get("cleaning.overdueDays", 7),
      supplyOverdueDays: await get("cleaning.supplyOverdueDays", 14),
      defaultRoutineIntensity: await get("cleaning.defaultIntensity", "standard"),
    },
  };
}

// Sabbath window (prefer ontology.sabbath if present)
async function isSabbath(now = new Date()) {
  try {
    const ont = await safeImportMany(["@/shared/ontology.js", "@/shared/ontology"]);
    const win = ont?.sabbath?.(now);
    if (win?.startISO && win?.endISO) {
      return now >= new Date(win.startISO) && now < new Date(win.endISO);
    }
  } catch {}
  // Fallback Fri 18:00 → Sat 18:00
  const day = now.getDay();
  const fri18 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((5 - day + 7) % 7), 18, 0, 0, 0);
  const sat18 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((6 - day + 7) % 7), 18, 0, 0, 0);
  return now >= fri18 && now < sat18;
}
function inQuietHours(now, settings) {
  const q = settings?.quietHours || { start: 21, end: 7 };
  const h = now.getHours();
  if ((q.start ?? 21) < (q.end ?? 7)) return h >= (q.start ?? 21) && h < (q.end ?? 7);
  return h >= (q.start ?? 21) || h < (q.end ?? 7);
}

/* -------------------- Dexie & Agents -------------------- */
async function DB() {
  return await safeImportMany(["@/db/index.js", "@/db", "../db", "../../db"]);
}
async function cleaningAgent() {
  return await safeImportMany(["@/agents/cleaningAgent.js", "@/agents/cleaningAgent"]);
}
async function inventoryAgent() {
  return await safeImportMany(["@/agents/inventoryAgent.js", "@/agents/inventoryAgent"]);
}

/* -------------------- n8n notifications (optional) -------------------- */
async function notifyN8n(event, payload) {
  const n8n = await safeImportMany(["@/services/n8nClient.js", "@/services/n8nClient"]);
  try {
    if (typeof n8n?.runWorkflowByName === "function") {
      await n8n.runWorkflowByName("Suka: Cleaning Event", { event, payload }, {
        idempotencyKey: `${event}:${payload?.sessionId || ""}:${payload?.atISO || ""}`,
      });
    } else {
      await n8n?.runWorkflow?.("cleaning-event", { event, payload }, { waitForFinish: false });
    }
  } catch {}
}

/* -------------------- Utilities -------------------- */
function daysBetween(a, b) { return Math.abs((a.getTime() - b.getTime()) / 86400000); }
function parseTimeToToday(timeHHMM, base = new Date()) {
  const [hh, mm] = String(timeHHMM || "10:00").split(":").map(Number);
  const d = new Date(base);
  d.setHours(hh || 0, mm || 0, 0, 0);
  return d;
}

const DEFAULT_ZONES = [
  { id: "Kitchen", name: "Kitchen", priority: 10, cadenceDays: 2, tags: ["high-visibility"], active: true },
  { id: "Bath", name: "Bathrooms", priority: 10, cadenceDays: 2, tags: ["sanitization"], active: true },
  { id: "Entry", name: "Entryway", priority: 7, cadenceDays: 3, tags: ["traffic"], active: true },
  { id: "Living", name: "Living Room", priority: 6, cadenceDays: 4, tags: [], active: true },
];

/* -------------------- Strategy system (Vite-safe) -------------------- */
// Discover strategy modules (lazy). Drop files in /src/services/cleaning/strategies/*.js to extend.
const STRATEGY_MODULES = import.meta.glob(
  ["/src/services/cleaning/strategies/*.js", "/src/services/cleaning/strategies/*.mjs"],
  { eager: false }
);

function listStrategies() {
  return Object.keys(STRATEGY_MODULES).map((full) => {
    const name = full.split("/").pop().replace(/\.(mjs|js)$/i, "");
    return { name, path: full };
  });
}

async function loadStrategy(name = "default") {
  const entry = listStrategies().find((s) => s.name === name);
  if (entry) {
    try {
      const mod = await STRATEGY_MODULES[entry.path]();
      return mod?.default || mod;
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[CleaningStore] failed to load strategy:", name, e);
    }
  }
  return DefaultCleaningStrategy;
}

const DefaultCleaningStrategy = {
  key: "default",
  label: "Balanced (default)",
  plan({ zones = [], constraints = {}, prefs = {} }) {
    const priority = ["kitchen", "bath", "entry", "bed", "living", "other"];
    const ordered = [...zones].sort((a, b) => {
      const ai = priority.findIndex((k) => (a.slug || a.name || "").toLowerCase().includes(k));
      const bi = priority.findIndex((k) => (b.slug || b.name || "").toLowerCase().includes(k));
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const tasks = ordered.map((z) => ({
      zoneId: z.id,
      zone: z.name,
      durationMin: z.estimateMin ?? 20,
      supplies: z.supplyHints || [],
      window: constraints?.sabbath
        ? "Outside Sabbath window"
        : (prefs?.timeWindow || "Anytime"),
      agents: z.agents || [],
    }));

    return { tasks };
  },
};

const SabbathAwareStrategy = {
  key: "sabbathAware",
  label: "Sabbath Aware",
  plan({ zones = [], constraints = {}, prefs = {} }) {
    const base = DefaultCleaningStrategy.plan({ zones, constraints, prefs });
    base.tasks = base.tasks.map((t) => {
      const heavy = /kitchen|bath|deep|mop|scrub/i.test(`${t.zone} ${t.agents?.join(" ")}`);
      return heavy ? { ...t, window: "Outside Sabbath window" } : t;
    });
    return base;
  },
};

/* -------------------- Cleaning Store -------------------- */
const CleaningStore = {
  /* ---------- Boot ---------- */
  async init() {
    const db = await DB();
    try {
      const zones = await db?.zones?.toArray?.();
      if (!zones || zones.length === 0) {
        for (const z of DEFAULT_ZONES) {
          await db?.zones?.put?.({ ...z, lastCleanedISO: null, createdAtISO: safeNowISO(), updatedAtISO: safeNowISO() });
        }
      }
    } catch {}
    // Publish available strategies (for UI dropdowns)
    try { window.__cleaningStrategies = listStrategies().map((s) => s.name); } catch {}
    await broadcast("cleaning:init", { at: safeNowISO() });
    return true;
  },

  /* ---------- Zones ---------- */
  async listZones({ active = true } = {}) {
    const db = await DB();
    try {
      let list = await db?.zones?.toArray?.();
      list = Array.isArray(list) ? list : [];
      if (active != null) list = list.filter((z) => !!z.active === !!active);
      return list.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    } catch { return []; }
  },

  async upsertZone(zone) {
    const db = await DB();
    const doc = {
      id: zone.id || zone.name || uuidv4(),
      name: zone.name || zone.id || "Zone",
      priority: Number(zone.priority ?? 5),
      cadenceDays: Number(zone.cadenceDays ?? 7),
      tags: Array.isArray(zone.tags) ? zone.tags : [],
      active: zone.active !== false,
      meta: zone.meta || {},
      updatedAtISO: safeNowISO(),
    };
    if (!zone.id) doc.createdAtISO = doc.updatedAtISO;
    try {
      await db?.zones?.put?.(doc);
      await broadcast("cleaning:zones:changed", { op: "upsert", id: doc.id });
      return doc;
    } catch { return null; }
  },

  async markZoneCleaned(id, { whenISO = safeNowISO() } = {}) {
    const db = await DB();
    try {
      const z = await db?.zones?.get?.(id);
      if (!z) return false;
      z.lastCleanedISO = whenISO;
      z.updatedAtISO = safeNowISO();
      await db?.zones?.put?.(z);
      await broadcast("cleaning:zones:changed", { op: "markCleaned", id });
      return true;
    } catch { return false; }
  },

  /* ---------- Routines ---------- */
  async getRoutine(id) {
    const db = await DB();
    try { return await db?.cleaningRoutines?.get?.(id); } catch { return null; }
  },

  async upsertRoutine(doc) {
    const db = await DB();
    const id = doc.id || uuidv4();
    const cleaned = {
      id,
      name: doc.name || "Routine",
      rooms: doc.rooms || doc.zones || ["Kitchen", "Bath", "Entry", "Living"],
      durationMin: Number(doc.durationMin ?? 30),
      intensity: doc.intensity || "standard",
      presetKey: doc.presetKey || null,
      active: doc.active !== false,
      tasks: Array.isArray(doc.tasks) ? doc.tasks.map((t, i) => ({
        id: t.id || `task_${i}`,
        zone: t.zone || "General",
        title: t.title || t.text || `Task ${i + 1}`,
        estMin: Number(t.estMin ?? 5),
        category: t.category || "cleaning",
        supplyKey: t.supplyKey || null,
      })) : [],
      updatedAtISO: safeNowISO(),
    };
    if (!doc.id) cleaned.createdAtISO = cleaned.updatedAtISO;
    try {
      await db?.cleaningRoutines?.put?.(cleaned);
      await broadcast("cleaning:routines:changed", { op: "upsert", id });
      return cleaned;
    } catch { return null; }
  },

  /**
   * Build routine from agent or settings (fallback template).
   * opts: { rooms?, duration?, intensity?, preset? }
   */
  async buildRoutine(opts = {}) {
    const settings = await loadSettings();
    const agent = await cleaningAgent();
    const ctx = {}; // hook household context if available
    try {
      const res = await agent?.estimatePlan?.(ctx, {
        preset: opts.preset || (settings.profileKey === "agrarian-offgrid" ? "deep" : "standard"),
        rooms: opts.rooms || DEFAULT_ZONES.map((z) => z.id),
        duration: Number(opts.duration ?? 30),
        intensity: opts.intensity || settings.cleaning.defaultRoutineIntensity,
      });
      if (res?.suggestions?.length) {
        const tasks = res.suggestions.map((s, i) => ({
          id: s.id || `task_${i}`,
          zone: s.zone || s.area || "General",
          title: s.title || s.text || `Task ${i + 1}`,
          estMin: Number(s.estMin ?? 5),
          category: s.category || "cleaning",
          supplyKey: s.supplyKey || null,
        }));
        return this.upsertRoutine({
          name: "Agent Routine",
          rooms: Array.from(new Set(tasks.map((t) => t.zone))),
          durationMin: Number(opts.duration ?? 30),
          intensity: opts.intensity || settings.cleaning.defaultRoutineIntensity,
          tasks,
          presetKey: opts.preset || null,
          active: true,
        });
      }
    } catch {}
    // Fallback quick routine
    return this.upsertRoutine({
      name: "Quick Reset 10",
      rooms: ["Kitchen"],
      durationMin: 10,
      intensity: "light",
      tasks: [
        { zone: "Kitchen", title: "Clear & wipe counters", estMin: 3 },
        { zone: "Kitchen", title: "Load/empty dishwasher or sink", estMin: 4 },
        { zone: "Kitchen", title: "Sweep visible crumbs", estMin: 3 },
      ],
      presetKey: "kitchen-reset-10min",
      active: true,
    });
  },

  /* ---------- Sessions & Logs ---------- */
  async startSession({ title = "Cleaning Session", preset = null } = {}) {
    const db = await DB();
    const settings = await loadSettings();
    const sabbath = settings.sabbathAvoid !== false && (await isSabbath(new Date()));
    const session = {
      id: uuidv4(),
      title: sabbath ? `${title} (gentle)` : title,
      startedAtISO: safeNowISO(),
      status: "active",
      preset,
      tasks: [],
      notes: [],
      meta: { sabbath, source: "CleaningStore" },
    };
    try {
      await db?.cleaningLogs?.put?.({ id: session.id, atISO: session.startedAtISO, notes: "", tasks: [], meta: { type: "session:start" } });
    } catch {}
    await broadcast(EVENTS?.SESSION?.STARTED?.CLEANING || "SESSION.STARTED.CLEANING", { sessionId: session.id, at: session.startedAtISO, sabbath });
    notifyN8n("session.start", { sessionId: session.id, sabbath }).catch(() => {});
    return session;
  },

  async finishSession(sessionId, summary = "") {
    const db = await DB();
    const atISO = safeNowISO();
    try {
      await db?.cleaningLogs?.put?.({ id: `finish_${sessionId}`, sessionId, atISO, notes: summary, tasks: [], meta: { type: "session:finish" } });
    } catch {}
    await broadcast(EVENTS?.SESSION?.FINISHED?.CLEANING || "SESSION.FINISHED.CLEANING", { sessionId, at: atISO, summary });
    notifyN8n("session.finish", { sessionId, summary }).catch(() => {});
    return true;
  },

  async recordTask({ sessionId = null, zone = "General", title, estMin = 5, supplyKey = null, notes = "" }) {
    const db = await DB();
    const item = { id: uuidv4(), zone, title: title || "Task", estMin, supplyKey, notes, doneAtISO: safeNowISO() };
    try {
      await db?.cleaningLogs?.put?.({ id: item.id, sessionId, zone, atISO: item.doneAtISO, tasks: [{ title }], notes, meta: { type: "task" } });
      // Mark zone cleaned if it matches a known zone
      const z = await db?.zones?.get?.(zone);
      if (z) {
        z.lastCleanedISO = item.doneAtISO;
        z.updatedAtISO = safeNowISO();
        await db?.zones?.put?.(z);
      }
    } catch {}
    await broadcast("cleaning:task:recorded", { sessionId, zone, title, at: item.doneAtISO });
    return item;
  },

  /* ---------- Overdue & Triggers ---------- */
  async getOverdueZones({ graceDays, limit = 5 } = {}) {
    const db = await DB();
    const settings = await loadSettings();
    const maxDays = Number(graceDays ?? settings.cleaning.overdueDays ?? 7);
    try {
      const zones = await db?.zones?.toArray?.();
      const now = new Date();
      const scored = (zones || [])
        .filter((z) => z.active !== false)
        .map((z) => {
          const last = z.lastCleanedISO ? new Date(z.lastCleanedISO) : new Date(0);
          const days = daysBetween(now, last);
          const cadence = Number(z.cadenceDays || 7);
          const overdue = days - cadence;
          const score = (z.priority || 1) * (overdue > 0 ? overdue : 0);
          return { ...z, daysSince: Math.floor(days), overdueBy: Math.max(0, Math.floor(overdue)), score };
        })
        .filter((x) => x.overdueBy >= maxDays || x.overdueBy > 0)
        .sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    } catch { return []; }
  },

  async detectTriggers() {
    try {
      const mod = await safeImportMany([
        "@/services/triggers/detectCleaningTriggers.js",
        "@/services/triggers/detectCleaningTriggers",
      ]);
      const res = await mod?.default?.();
      return res || { restockNeeded: [], overdueSupplies: [], zonesDue: [] };
    } catch {
      return { restockNeeded: [], overdueSupplies: [], zonesDue: [] };
    }
  },

  /* ---------- Supplies ---------- */
  async computeSupplyNeeds({ preferMissingOnly = false } = {}) {
    const db = await DB();
    const settings = await loadSettings();
    try {
      const supplies = await db?.supplies?.toArray?.();
      const out = [];
      for (const s of supplies || []) {
        if (s.category !== "cleaning") continue;
        const below = Number(s.quantity ?? 0) <= Number(s.threshold ?? 0);
        const last = s.lastUpdated ? new Date(s.lastUpdated) : new Date(0);
        const old = daysBetween(new Date(), last) > Number(settings.cleaning.supplyOverdueDays ?? 14);
        if (below || old || !preferMissingOnly) {
          out.push({
            key: s.key || s.name,
            name: s.name,
            qty: Math.max(1, Number(s.restockQty ?? s.threshold ?? 1) - Number(s.quantity ?? 0)),
            unit: s.unit || null,
            reason: below ? "below-threshold" : old ? "stale" : "planned",
          });
        }
      }
      return out;
    } catch { return []; }
  },

  async reserveSupplies(lines = []) {
    const inv = await inventoryAgent();
    try {
      if (!lines?.length) return { ok: false, reason: "empty" };
      await inv?.handleCommand?.("reserveItems", { lines: lines.map((l) => ({ key: l.key || l.name, qty: l.qty, unit: l.unit, reason: l.reason || "cleaning" })) });
      await broadcast("inventory:delta", { at: safeNowISO(), reason: "cleaning:reserve", lines });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  /* ---------- Suggestions & Reminders ---------- */
  async suggestQuickWins({ max = 6 } = {}) {
    try {
      const agent = await cleaningAgent();
      const ctx = {};
      const res = await agent?.estimatePlan?.(ctx, { preset: "high-visibility-rooms" });
      if (Array.isArray(res?.suggestions) && res.suggestions.length) {
        return res.suggestions.slice(0, max).map((s, i) => ({
          id: s.id || `q_${i}`,
          zone: s.zone || s.area || "General",
          title: s.title || s.text || `Task ${i + 1}`,
          estMin: Number(s.estMin ?? 5),
          category: "cleaning",
        }));
      }
    } catch {}
    // Fallback: build from overdue zones
    const overdue = await this.getOverdueZones({ graceDays: 0, limit: max });
    return overdue.map((z, i) => ([
      { id: `overdue_${z.id}_${i}`, zone: z.id, title: `Tidy ${z.name} (${Math.min(10, 5 + (z.overdueBy || 1))}m)`, estMin: Math.min(10, 5 + (z.overdueBy || 1)), category: "cleaning" },
    ][0]));
  },

  async todaysReminders({ now = new Date() } = {}) {
    const settings = await loadSettings();
    const sabbath = settings.sabbathAvoid !== false && (await isSabbath(now));
    const quiet = inQuietHours(now, settings);

    const reminders = [];
    if (!sabbath) {
      reminders.push({
        atISO: parseTimeToToday("09:00", now).toISOString(),
        label: "Quick kitchen reset",
        type: "reset",
        preset: "kitchen-reset-10min",
        gentle: quiet,
      });
    }
    reminders.push({
      atISO: parseTimeToToday("15:00", now).toISOString(),
      label: "Bathroom tidy & wipe handles",
      type: "tidy",
      preset: "high-visibility-rooms",
      gentle: sabbath || quiet,
    });

    try {
      const trig = await this.detectTriggers();
      if ((trig?.zonesDue || []).length) {
        reminders.push({
          atISO: parseTimeToToday("18:30", now).toISOString(),
          label: `Overdue zones: ${trig.zonesDue.slice(0,3).join(", ")}`,
          type: "overdue",
          zones: trig.zonesDue,
          gentle: sabbath || quiet,
        });
      }
    } catch {}

    return reminders.sort((a, b) => new Date(a.atISO) - new Date(b.atISO));
  },

  async progressForToday() {
    const db = await DB();
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(); end.setHours(23,59,59,999);
    try {
      const all = await db?.cleaningLogs?.toArray?.();
      const today = (all || []).filter((l) => {
        const t = new Date(l.atISO || l.doneAtISO || l.createdAtISO || 0);
        return t >= start && t <= end && (l.meta?.type === "task");
      });
      return { tasks: today.length };
    } catch { return { tasks: 0 }; }
  },

  /* ---------- KPI helpers for homepage (4) ---------- */
  kpi: {
    async todayTasksCount() {
      const p = await CleaningStore.progressForToday();
      return p.tasks || 0;
    },
    async listTodayTasks() {
      const db = await DB();
      const start = new Date(); start.setHours(0,0,0,0);
      const end = new Date(); end.setHours(23,59,59,999);
      try {
        const all = await db?.cleaningLogs?.toArray?.();
        return (all || []).filter((l) => {
          const t = new Date(l.atISO || l.doneAtISO || l.createdAtISO || 0);
          return t >= start && t <= end && (l.meta?.type === "task");
        }).map((l) => ({
          id: l.id,
          atISO: l.atISO,
          zone: l.zone || "General",
          title: l.tasks?.[0]?.title || l.notes || "Task",
        }));
      } catch { return []; }
    },
    async overdueZonesCount() {
      const list = await CleaningStore.getOverdueZones({ graceDays: 0, limit: 999 });
      return list.length;
    },
    async listOverdueZones({ limit = 10 } = {}) {
      return await CleaningStore.getOverdueZones({ graceDays: 0, limit });
    },
    async activeSessionsCount() {
      const db = await DB();
      try {
        const logs = await db?.cleaningLogs?.toArray?.();
        const todayStr = toISODate(new Date()).slice(0, 10);
        const starts = new Set((logs || []).filter(l =>
          l.meta?.type === "session:start" && String(l.atISO).startsWith(todayStr)
        ).map(l => l.id));
        const finishes = new Set((logs || []).filter(l =>
          l.meta?.type === "session:finish" && String(l.atISO).startsWith(todayStr)
        ).map(l => l.sessionId));
        let active = 0;
        starts.forEach(id => { if (!finishes.has(id)) active += 1; });
        return active;
      } catch { return 0; }
    },
  },

  /* ---------- Drafts (visible before approval) ---------- */
  async buildSessionDraft() {
    const settings = await loadSettings();
    const db = await DB();
    const zones = await db?.zones?.toArray?.() || [];
    const constraints = {
      sabbath: settings.sabbathAvoid !== false && (await isSabbath(new Date())),
    };
    const prefs = { timeWindow: "Anytime", strategy: constraints.sabbath ? "sabbathAware" : "default" };
    const strategy = await loadStrategy(prefs.strategy);
    const plan = strategy.plan({ zones, constraints, prefs });

    const draft = {
      id: `draft_${Date.now().toString(36)}`,
      type: "cleaning-session",
      title: `Cleaning Session (${zones.length} zones)`,
      status: "pending",
      createdAt: safeNowISO(),
      payload: {
        items: plan.tasks,
        constraints,
        prefs,
      },
      meta: {
        source: "CleaningStore",
        strategy: strategy.key || prefs.strategy,
      },
    };

    // Emit to automation so the SessionDraftDetail modal can open.
    try {
      const bus = await safeImportMany(["@/services/events/eventBus.js", "@/services/events/eventBus"]);
      (bus?.emit || broadcast)("automation/draft/ready", { draft });
    } catch {
      await broadcast("automation/draft/ready", { draft });
    }

    return draft;
  },

  async approveDraft(draftId) {
    // We don’t store all drafts here; approval is event-based.
    try {
      const bus = await safeImportMany(["@/services/events/eventBus.js", "@/services/events/eventBus"]);
      (bus?.emit || broadcast)("automation/draft/approve", { id: draftId });
    } catch {
      await broadcast("automation/draft/approve", { id: draftId });
    }
    return true;
  },

  /* ---------- High-level flows ---------- */
  async startQuickReset() {
    const preset = await this.buildRoutine({ preset: "kitchen-reset-10min" });
    const session = await this.startSession({ title: "Quick Reset", preset: preset?.presetKey || "kitchen-reset-10min" });
    await broadcast("automation/nudge", {
      title: "Quick kitchen reset started",
      message: "10 minutes to clear counters, dishes, and sweep crumbs.",
      actions: [{ id: "start-reset", label: "Start 10-min timer" }],
      priority: 0.8,
      next: EVENTS?.SESSION?.STARTED?.CLEANING || "SESSION.STARTED.CLEANING",
    });
    return session;
  },
};

/* -------------------- Intent wiring (ergonomics) -------------------- */
if (typeof window !== "undefined") {
  const onIntent = async (e) => {
    const { intent, ...detail } = e?.detail || {};
    if (!intent) return;
    try {
      switch (intent) {
        case "cleaning/session/start": {
          await CleaningStore.startSession({ title: detail?.title, preset: detail?.preset });
          break;
        }
        case "cleaning/session/finish": {
          if (detail?.id) await CleaningStore.finishSession(detail.id, detail?.summary || "");
          break;
        }
        case "cleaning/task/record": {
          await CleaningStore.recordTask({
            sessionId: detail?.sessionId || null,
            zone: detail?.zone || "General",
            title: detail?.title,
            estMin: detail?.estMin,
            supplyKey: detail?.supplyKey,
            notes: detail?.notes,
          });
          break;
        }
        case "cleaning/quickReset": {
          await CleaningStore.startQuickReset();
          break;
        }
        case "cleaning/routine/build": {
          await CleaningStore.buildRoutine({
            preset: detail?.preset,
            rooms: detail?.rooms,
            duration: detail?.duration,
            intensity: detail?.intensity,
          });
          break;
        }
        case "cleaning/capacity/reserveSupplies": {
          if (Array.isArray(detail?.lines) && detail.lines.length) {
            await CleaningStore.reserveSupplies(detail.lines);
          }
          break;
        }
        case "cleaning/draft/build": {
          await CleaningStore.buildSessionDraft();
          break;
        }
        case "cleaning/draft/approve": {
          await CleaningStore.approveDraft(detail?.id);
          break;
        }
        default:
          break;
      }
    } catch {}
  };
  try {
    window.removeEventListener("automation:intent", onIntent);
    window.addEventListener("automation:intent", onIntent);
  } catch {}
}

/* -------------------- Export -------------------- */
export default CleaningStore;

export const Cleaning = {
  init: () => CleaningStore.init(),
  listZones: (opts) => CleaningStore.listZones(opts),
  upsertZone: (z) => CleaningStore.upsertZone(z),
  markZoneCleaned: (id, opts) => CleaningStore.markZoneCleaned(id, opts),
  getRoutine: (id) => CleaningStore.getRoutine(id),
  upsertRoutine: (doc) => CleaningStore.upsertRoutine(doc),
  buildRoutine: (opts) => CleaningStore.buildRoutine(opts),
  startSession: (opts) => CleaningStore.startSession(opts),
  finishSession: (id, s) => CleaningStore.finishSession(id, s),
  recordTask: (opts) => CleaningStore.recordTask(opts),
  getOverdueZones: (opts) => CleaningStore.getOverdueZones(opts),
  detectTriggers: () => CleaningStore.detectTriggers(),
  computeSupplyNeeds: (opts) => CleaningStore.computeSupplyNeeds(opts),
  reserveSupplies: (lines) => CleaningStore.reserveSupplies(lines),
  suggestQuickWins: (opts) => CleaningStore.suggestQuickWins(opts),
  todaysReminders: (opts) => CleaningStore.todaysReminders(opts),
  progressForToday: () => CleaningStore.progressForToday(),
  // Draft helpers
  buildSessionDraft: () => CleaningStore.buildSessionDraft(),
  approveDraft: (id) => CleaningStore.approveDraft(id),
  // KPI shortcuts for homepage
  kpiTodayTasksCount: () => CleaningStore.kpi.todayTasksCount(),
  kpiListTodayTasks: () => CleaningStore.kpi.listTodayTasks(),
  kpiOverdueZonesCount: () => CleaningStore.kpi.overdueZonesCount(),
  kpiListOverdueZones: (o) => CleaningStore.kpi.listOverdueZones(o),
  kpiActiveSessionsCount: () => CleaningStore.kpi.activeSessionsCount(),
};
