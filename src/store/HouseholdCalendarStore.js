/**
 * HouseholdCalendarStore (dynamic, agent- & Sabbath-aware)
 * --------------------------------------------------------
 * Unified calendar state for the Suka Smart Assistant.
 *
 * Goals & features:
 * - Single source of truth for household events across domains
 *   (meals/cooking, cleaning, gardening, animal care, inventory, faith/sabbath, misc)
 * - Soft integrations (DexieDB, agents, triggers, orchestrator, sockets)
 * - Sabbath/quiet-hours awareness (mark/gate non-essential events)
 * - Minimal recurrence support (DAILY/WEEKLY) + expansion helpers
 * - Import from domain contexts (e.g., loadCalendarContext, sessions)
 * - iCalendar (.ics) export (best-effort) for sharing/sync
 *
 * Event shape (normalized):
 * {
 *   id: string,
 *   title: string,
 *   startISO: string,    // inclusive
 *   endISO?: string,     // exclusive
 *   allDay?: boolean,
 *   source?: 'cooking'|'cleaning'|'gardening'|'animals'|'inventory'|'faith'|'general',
 *   color?: string,      // hex or css var
 *   tags?: string[],
 *   meta?: any,
 *   rrule?: { freq:'DAILY'|'WEEKLY', interval?: number, byweekday?: number[], count?: number, untilISO?: string },
 *   gentle?: boolean,    // hint for Sabbath/quiet-hours
 *   essential?: boolean, // should not be suppressed on Sabbath
 *   createdAtISO: string,
 *   updatedAtISO: string,
 * }
 */

import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";

/* ---------------------------------------------
   Safe dynamic imports & env shims
----------------------------------------------*/
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try {
      // Vite cannot statically analyze a variable import; ignore on purpose.
      // eslint-disable-next-line no-undef
      const mod = await import(/* @vite-ignore */ p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}

function safeNowISO() {
  return new Date().toISOString();
}
function clampEnd(startISO, endISO) {
  const s = new Date(startISO);
  const e = endISO ? new Date(endISO) : new Date(s.getTime() + 60 * 60 * 1000);
  return e.toISOString();
}

/** fire-and-forget broadcast (window + optional socket) */
function broadcast(event, payload) {
  try {
    window.dispatchEvent?.(new CustomEvent(event, { detail: payload }));
  } catch {}
  // try socket asynchronously; don't block UI
  (async () => {
    try {
      const sockMod = await safeImportMany([
        "@/server/services/socket.js",
        "@/server/services/socket",
      ]);
      const s = sockMod?.socket || sockMod?.getSocket?.();
      s?.emit?.(event, payload);
    } catch {}
  })();
}

/* ---------------------------------------------
   Settings / Sabbath / Quiet-hours
----------------------------------------------*/
async function loadSettings() {
  const Settings = await safeImportMany([
    "@/store/SettingsStore.js",
    "@/store/SettingsStore",
  ]);
  const get = async (k, d) => {
    try {
      const v = await Settings?.get?.(k);
      return v ?? d;
    } catch {
      return d;
    }
  };
  return {
    profileKey: await get("profile.key", "standard-home"),
    sabbathAvoid: await get("sabbath.avoidSaturday", true),
    quietHours: await get("quietHours", { start: 21, end: 7 }),
  };
}

async function isSabbath(now = new Date()) {
  try {
    const ont = await safeImportMany([
      "@/shared/ontology.js",
      "@/shared/ontology",
    ]);
    const win = ont?.sabbath?.(now);
    if (win?.startISO && win?.endISO)
      return now >= new Date(win.startISO) && now < new Date(win.endISO);
  } catch {}
  // Fallback (Fri 18:00 → Sat 18:00)
  const day = now.getDay();
  const fri18 = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + ((5 - day + 7) % 7),
    18,
    0,
    0,
    0
  );
  const sat18 = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + ((6 - day + 7) % 7),
    18,
    0,
    0,
    0
  );
  return now >= fri18 && now < sat18;
}

function getSabbathActiveFlag(whenISO, sabbathAvoid) {
  if (sabbathAvoid === false) return false;
  const d = new Date(whenISO);
  const day = d.getDay();
  const fri18 = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + ((5 - day + 7) % 7),
    18,
    0,
    0,
    0
  );
  const sat18 = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + ((6 - day + 7) % 7),
    18,
    0,
    0,
    0
  );
  return d >= fri18 && d < sat18;
}

function inQuietHours(now, settings) {
  const q = settings?.quietHours || { start: 21, end: 7 };
  const h = now.getHours();
  if (q.start < q.end) return h >= q.start && h < q.end;
  return h >= q.start || h < q.end;
}

/* ---------------------------------------------
   Persistence (Dexie + localStorage)
----------------------------------------------*/
const LSK = "suka.calendar.events.v2";
async function DB() {
  return await safeImportMany(["@/db/index.js", "@/db", "../db", "../../db"]);
}

async function loadPersisted() {
  const db = await DB();
  try {
    const doc = await db?.userMeta?.get?.({ key: LSK });
    if (doc?.value) return doc.value;
  } catch {}
  try {
    const raw = localStorage.getItem(LSK);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function savePersisted(events, meta) {
  const db = await DB();
  const snap = { events, meta, savedAtISO: safeNowISO() };
  try {
    await db?.userMeta?.put?.({
      key: LSK,
      value: snap,
      updatedAt: safeNowISO(),
    });
  } catch {}
  try {
    localStorage.setItem(LSK, JSON.stringify(snap));
  } catch {}
}

/* ---------------------------------------------
   Colors & Sources
----------------------------------------------*/
const SOURCE_COLOR = {
  cooking: "#f97316", // orange-500
  cleaning: "#22c55e", // green-500
  gardening: "#84cc16", // lime-500
  animals: "#06b6d4", // cyan-500
  inventory: "#a855f7", // purple-500
  faith: "#f59e0b", // amber-500
  general: "#64748b", // slate-500
};

function normalizeEvent(e) {
  const id = e.id || uuidv4();
  const title = String(e.title || "Untitled");
  const startISO = e.startISO || e.date || safeNowISO();
  const endISO = clampEnd(startISO, e.endISO);
  const source = e.source || "general";
  const color = e.color || SOURCE_COLOR[source] || SOURCE_COLOR.general;
  const tags = Array.isArray(e.tags) ? e.tags : [];
  const allDay = !!e.allDay;
  const essential = e.essential === true;
  const gentle = e.gentle === true;
  const rrule = e.rrule && typeof e.rrule === "object" ? e.rrule : null;
  return {
    id,
    title,
    startISO,
    endISO,
    source,
    color,
    tags,
    allDay,
    essential,
    gentle,
    rrule,
    meta: e.meta || {},
    createdAtISO: e.createdAtISO || safeNowISO(),
    updatedAtISO: safeNowISO(),
  };
}

/* ---------------------------------------------
   Recurrence expansion (minimal)
----------------------------------------------*/
function expandRecurrence(ev, rangeStartISO, rangeEndISO, cap = 200) {
  if (!ev.rrule) return [ev];
  const out = [];
  const start = new Date(rangeStartISO);
  const end = new Date(rangeEndISO);
  const baseStart = new Date(ev.startISO);
  const baseEnd = new Date(ev.endISO);
  const until = ev.rrule.untilISO ? new Date(ev.rrule.untilISO) : null;
  const freq = String(ev.rrule.freq || "DAILY").toUpperCase();
  const interval = Number(ev.rrule.interval || 1);
  let count = Number(ev.rrule.count || cap);
  let curStart = new Date(baseStart);

  function pushIfInRange(s) {
    const e = new Date(s.getTime() + (baseEnd - baseStart));
    if (e < start || s > end) return;
    out.push({
      ...ev,
      id: `${ev.id}_${s.toISOString()}`,
      startISO: s.toISOString(),
      endISO: e.toISOString(),
    });
  }

  while (count-- > 0) {
    if (until && curStart > until) break;
    pushIfInRange(curStart);
    if (freq === "WEEKLY")
      curStart = new Date(curStart.getTime() + interval * 7 * 86400000);
    else curStart = new Date(curStart.getTime() + interval * 86400000);
    if (out.length >= cap) break;
  }
  return out;
}

/* ---------------------------------------------
   iCalendar export (best-effort)
----------------------------------------------*/
function toICSDate(dtISO, allDay = false) {
  const dt = new Date(dtISO);
  const pad = (n) => String(n).padStart(2, "0");
  const y = dt.getUTCFullYear();
  const m = pad(dt.getUTCMonth() + 1);
  const d = pad(dt.getUTCDate());
  if (allDay) return `${y}${m}${d}`;
  const hh = pad(dt.getUTCHours()),
    mm = pad(dt.getUTCMinutes()),
    ss = pad(dt.getUTCSeconds());
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

function buildICS(events = []) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Suka Smart Assistant//Household Calendar//EN",
  ];
  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.id}@suka.local`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${toICSDate(ev.startISO, true)}`);
      const endAll = new Date(new Date(ev.startISO).getTime() + 86400000);
      lines.push(
        `DTEND;VALUE=DATE:${toICSDate(ev.endISO || endAll.toISOString(), true)}`
      );
    } else {
      lines.push(`DTSTART:${toICSDate(ev.startISO)}`);
      lines.push(`DTEND:${toICSDate(ev.endISO)}`);
    }
    lines.push(`SUMMARY:${ev.title}`);
    if (ev.rrule?.freq) {
      const parts = [`FREQ=${ev.rrule.freq}`];
      if (ev.rrule.interval) parts.push(`INTERVAL=${ev.rrule.interval}`);
      if (ev.rrule.count) parts.push(`COUNT=${ev.rrule.count}`);
      if (ev.rrule.untilISO)
        parts.push(`UNTIL=${toICSDate(ev.rrule.untilISO)}`);
      lines.push(`RRULE:${parts.join(";")}`);
    }
    lines.push("END:VEVENT");
    lines.push("END:VCALENDAR");
  }
  return lines.join("\r\n");
}

/* ---------------------------------------------
   Domain imports (best-effort)
----------------------------------------------*/
async function importFromTriggers() {
  try {
    const mod = await safeImportMany([
      "@/services/triggers/loadCalendarContext.js",
      "@/services/triggers/loadCalendarContext",
    ]);
    const ctx = await mod?.default?.();
    const toEvents = [];
    for (const e of [
      ...(ctx?.pastEvents || []),
      ...(ctx?.upcomingEvents || []),
    ]) {
      toEvents.push({
        id: e.id,
        title: `${e.type?.toUpperCase?.() || e.role}: ${
          e.status || "scheduled"
        }`,
        startISO: e.date,
        endISO: new Date(
          new Date(e.date).getTime() + 60 * 60 * 1000
        ).toISOString(),
        source: e.type || "general",
        color: SOURCE_COLOR[e.type] || undefined,
        tags: ["imported"],
        meta: { role: e.role, tasks: e.tasks || [] },
        essential: /animals|cooking/i.test(e.type),
        gentle: false,
      });
    }
    return toEvents;
  } catch {
    return [];
  }
}

async function importSessions() {
  // Cooking sessions from cookingBus (active/recent)
  try {
    const bus = await safeImportMany([
      "@/services/cookingBus.js",
      "@/services/cookingBus",
    ]);
    const sessions = (await bus?.listSessions?.({ status: "active" })) || [];
    return sessions.map((s) => ({
      id: `cook_${s.id}`,
      title: s.title || "Cooking Session",
      startISO: s.dateISO || s.createdAt || safeNowISO(),
      endISO: new Date(
        new Date(s.dateISO || s.createdAt || Date.now()).getTime() +
          2 * 60 * 60 * 1000
      ).toISOString(),
      source: "cooking",
      color: SOURCE_COLOR.cooking,
      tags: ["session"],
      meta: {
        batch: !!s.batch,
        recipes: (s.recipes || []).map((r) => r.title),
      },
      essential: true,
      gentle: false,
    }));
  } catch {
    return [];
  }
}

/* ---------------------------------------------
   Store
----------------------------------------------*/
export const useHouseholdCalendar = create((set, get) => ({
  events: [], // normalized events
  meta: {
    lastUpdatedISO: null,
    profileKey: "standard-home",
    sabbathAvoid: true,
  },

  /* ---------- lifecycle ---------- */
  hydrate: async () => {
    const settings = await loadSettings();
    const snap = await loadPersisted();
    if (snap?.events) {
      set({
        events: snap.events,
        meta: {
          ...get().meta,
          ...(snap.meta || {}),
          profileKey: settings.profileKey,
          sabbathAvoid: settings.sabbathAvoid,
        },
      });
    } else {
      set({
        meta: {
          ...get().meta,
          profileKey: settings.profileKey,
          sabbathAvoid: settings.sabbathAvoid,
        },
      });
    }
  },

  importDomainEvents: async () => {
    const [fromTriggers, fromSessions] = await Promise.all([
      importFromTriggers(),
      importSessions(),
    ]);
    const merged = [
      ...get().events,
      ...fromTriggers.map(normalizeEvent),
      ...fromSessions.map(normalizeEvent),
    ];
    set({
      events: dedupeById(merged),
      meta: { ...get().meta, lastUpdatedISO: safeNowISO() },
    });
    savePersisted(get().events, get().meta).catch(() => {});
    broadcast("calendar:imported", {
      added: fromTriggers.length + fromSessions.length,
    });
  },

  /* ---------- CRUD ---------- */
  addEvent: (event) => {
    const ev = normalizeEvent(event);
    set((state) => ({
      events: dedupeById([...state.events, ev]),
      meta: { ...get().meta, lastUpdatedISO: safeNowISO() },
    }));
    savePersisted(get().events, get().meta).catch(() => {});
    broadcast("calendar:added", { id: ev.id, source: ev.source });
    return ev;
  },

  updateEvent: (id, updates) => {
    const uid = String(id);
    const updatedAt = safeNowISO();
    set((state) => ({
      events: state.events.map((e) =>
        e.id === uid
          ? normalizeEvent({
              ...e,
              ...updates,
              id: e.id,
              createdAtISO: e.createdAtISO,
              updatedAtISO: updatedAt,
            })
          : e
      ),
      meta: { ...get().meta, lastUpdatedISO: updatedAt },
    }));
    savePersisted(get().events, get().meta).catch(() => {});
    broadcast("calendar:updated", { id: uid });
  },

  removeEvent: (id) => {
    const uid = String(id);
    set((state) => ({
      events: state.events.filter((e) => e.id !== uid),
      meta: { ...get().meta, lastUpdatedISO: safeNowISO() },
    }));
    savePersisted(get().events, get().meta).catch(() => {});
    broadcast("calendar:removed", { id: uid });
  },

  /* ---------- querying ---------- */
  getEventsBySource: (source) =>
    get().events.filter((e) => e.source === source),

  getEventsInRange: ({
    startISO,
    endISO,
    expandRecurrences = true,
    respectSabbath = true,
  }) => {
    const settings = get().meta;
    const sISO =
      startISO || new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const eISO =
      endISO || new Date(new Date().setHours(23, 59, 59, 999)).toISOString();

    const intersects = (e) =>
      !(
        new Date(e.endISO) < new Date(sISO) ||
        new Date(e.startISO) > new Date(eISO)
      );
    const base = get().events.filter(intersects);

    const expanded = expandRecurrences
      ? base.flatMap((e) => expandRecurrence(e, sISO, eISO))
      : base;

    if (!respectSabbath) return expanded;

    return expanded.filter((e) => {
      const sab = getSabbathActiveFlag(e.startISO, settings.sabbathAvoid);
      if (sab && !e.essential) return false; // gate non-essential during Sabbath
      return true;
    });
  },

  getEventsOnDate: (dateISO) => {
    const d = new Date(dateISO || new Date());
    const startISO = new Date(d.setHours(0, 0, 0, 0)).toISOString();
    const endISO = new Date(
      new Date(startISO).setHours(23, 59, 59, 999)
    ).toISOString();
    return get().getEventsInRange({ startISO, endISO });
  },

  upcomingWithin: ({ hours = 24, now = new Date(), respectSabbath = true }) => {
    const startISO = now.toISOString();
    const endISO = new Date(now.getTime() + hours * 3600 * 1000).toISOString();
    return get().getEventsInRange({ startISO, endISO, respectSabbath });
  },

  /* ---------- helpers ---------- */
  upsertMany: (events = []) => {
    const normalized = events.map(normalizeEvent);
    set((state) => ({
      events: dedupeById([...state.events, ...normalized]),
      meta: { ...get().meta, lastUpdatedISO: safeNowISO() },
    }));
    savePersisted(get().events, get().meta).catch(() => {});
  },

  exportICS: ({ rangeStartISO, rangeEndISO } = {}) => {
    const events = get().getEventsInRange({
      startISO:
        rangeStartISO ||
        new Date(new Date().setDate(new Date().getDate() - 7)).toISOString(),
      endISO:
        rangeEndISO ||
        new Date(new Date().setDate(new Date().getDate() + 30)).toISOString(),
      expandRecurrences: true,
      respectSabbath: false, // export everything
    });
    return buildICS(events);
  },

  /* ---------- convenience: domain event builders ---------- */
  scheduleMeal: ({
    title = "Meal",
    whenISO,
    durationMin = 60,
    essential = true,
  } = {}) => {
    const startISO = whenISO || safeNowISO();
    const endISO = new Date(
      new Date(startISO).getTime() + durationMin * 60000
    ).toISOString();
    return get().addEvent({
      title,
      startISO,
      endISO,
      source: "cooking",
      essential,
    });
  },

  scheduleCleaning: async ({
    title = "Cleaning",
    whenISO,
    durationMin = 45,
    gentleIfSabbath = true,
  } = {}) => {
    const settings = await loadSettings();
    const sabbath =
      settings.sabbathAvoid !== false &&
      (await isSabbath(new Date(whenISO || Date.now())));
    const startISO = whenISO || safeNowISO();
    const endISO = new Date(
      new Date(startISO).getTime() + durationMin * 60000
    ).toISOString();
    return get().addEvent({
      title: sabbath && gentleIfSabbath ? `${title} (gentle)` : title,
      startISO,
      endISO,
      source: "cleaning",
      essential: false,
      gentle: sabbath && gentleIfSabbath,
    });
  },

  scheduleHarvestWindow: ({ crop, windowStartISO, windowEndISO }) => {
    return get().addEvent({
      title: `Harvest: ${crop}`,
      startISO: windowStartISO,
      endISO: windowEndISO,
      source: "gardening",
      essential: true,
      tags: ["harvest-window"],
    });
  },
}));

/* ---------------------------------------------
   Private helpers
----------------------------------------------*/
function dedupeById(arr = []) {
  const seen = new Map();
  for (const e of arr) {
    if (
      !seen.has(e.id) ||
      new Date(e.updatedAtISO || 0) > new Date(seen.get(e.id).updatedAtISO || 0)
    ) {
      seen.set(e.id, e);
    }
  }
  return Array.from(seen.values()).sort(
    (a, b) => new Date(a.startISO) - new Date(b.startISO)
  );
}

/* ---------------------------------------------
   Auto-hydrate & auto-import (best-effort)
----------------------------------------------*/
useHouseholdCalendar.getState().hydrate?.();
useHouseholdCalendar.getState().importDomainEvents?.();

/* -------------------------------------------------------------------------- */
/* ✅ Named export required by src/ai/context/index.js                         */
/* -------------------------------------------------------------------------- */
export const HouseholdCalendarStore = useHouseholdCalendar;
