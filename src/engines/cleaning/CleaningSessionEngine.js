/* eslint-disable no-console */
// src/engines/cleaning/CleaningSessionEngine.js
// CleaningSessionEngine
// -----------------------------------------------------------------------------
// Builds, consolidates, schedules, and persists cleaning sessions.
// Domains covered: daily reset, room turns, laundry, dishes, floors,
// sanitizing, deep clean rotations, post-session cleanup from Cooking/Animals/Garden.
//
// Highlights
// - Draft → Consolidate → Guard → Schedule → Persist → Emit
// - Per-task scheduledFor + sequence ordering
// - One-time or recurring (RRULE via local automation runtime)
// - User-owned favorites & plan templates
// - Reverse: generate cleaning from Cooking/Animals/Garden sessions
// - NBA (Next Best Action) hints + voice-friendly summaries
// - Cross-domain orchestration (Calendar, Inventory, Meals, Animals, Garden)
//
// Soft integrations (safe imports so file never crashes):
// - DexieDB "@/db" (expects sessions, plans, favorites tables if present)
// - Local automation runtime "@/services/automation/runtime"
// - Guards "@/services/session/guards" (sabbath, quiet-hours, weather, noise)
// - CalendarWriter "@/services/calendar/CalendarWriter"
// - Event catalog "@/features/scan-compare-trust/automation/events.catalog.js"
// - Optional SessionRunner "@/services/session/SessionRunner"

import EventEmitter from "eventemitter3";

/* --------------------------------- utils ---------------------------------- */
const isBrowser = typeof window !== "undefined";
const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const nowIso = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const minutes = (n) => n * 60 * 1000;

async function safeImport(path) {
  try {
    const mod = await import(path);
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

function humanList(items, conj = "and") {
  const a = (items || []).filter(Boolean);
  if (a.length <= 1) return a[0] ?? "";
  if (a.length === 2) return `${a[0]} ${conj} ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, ${conj} ${a.at(-1)}`;
}

/* ---------------------------- events (with fallbacks) ---------------------------- */
let EVT = {
  CLEANING_ENGINE_READY: "cleaning.engine.ready",
  CLEANING_SESSION_DRAFT: "cleaning.session.draft",
  CLEANING_SESSION_SCHEDULED: "cleaning.session.scheduled",
  CLEANING_SESSION_BLOCKED: "cleaning.session.blocked",
  CLEANING_SESSION_RUN_START: "cleaning.session.run.start",
  CLEANING_SESSION_RUN_FINISH: "cleaning.session.run.finish",
  CLEANING_FAVORITE_SAVED: "cleaning.favorite.saved",
  CLEANING_PLAN_SAVED: "cleaning.plan.saved",
  CLEANING_PLAN_FROM_ADJACENT: "cleaning.plan.fromAdjacent",
  // cross-domain nudges
  CALENDAR_SUGGEST_ADD: "calendar.suggest.add",
  INVENTORY_RESERVE_SUGGEST: "inventory.reserve.suggest",
  MEALS_NEEDS_UPDATE: "meals.needs.update",
  ANIMALS_SESSION_SUGGEST: "animals.session.suggest",
  GARDEN_SESSION_SUGGEST: "garden.session.suggest",
};
(async () => {
  const cat = await safeImport("@/features/scan-compare-trust/automation/events.catalog.js");
  if (cat?.EVENTS) EVT = { ...EVT, ...cat.EVENTS };
})();

const emitGlobal = (type, detail = {}) => {
  try {
    if (isBrowser) {
      window.dispatchEvent(new CustomEvent(type, { detail }));
      const bus = window.__suka?.eventBus;
      if (bus?.emit) bus.emit(type, detail);
    }
  } catch (err) {
    console.warn("[CleaningSessionEngine] emitGlobal warn:", err);
  }
};

/* ---------------------------- tiny task knowledge --------------------------- */
// lightweight task library for common cleaning activities
const TASKS = {
  dailyReset: [
    { type: "surfaces-wipe", title: "Wipe counters & handles", est: 8, noisy: false },
    { type: "dishes", title: "Load / run / empty dishwasher", est: 12, noisy: false },
    { type: "trash", title: "Empty trash & replace liners", est: 6, noisy: false },
    { type: "floors-spot", title: "Spot sweep high-traffic floors", est: 10, noisy: false },
  ],
  laundry: [
    { type: "laundry-wash", title: "Laundry: wash", est: 5, noisy: true },
    { type: "laundry-dry", title: "Laundry: dry", est: 5, noisy: true },
    { type: "laundry-fold", title: "Laundry: fold & put away", est: 12, noisy: false },
  ],
  bathroomsQuick: [
    { type: "toilet-sanitize", title: "Sanitize toilet(s)", est: 6, noisy: false },
    { type: "sink-mirror", title: "Wipe sink(s) & mirror(s)", est: 6, noisy: false },
    { type: "shower-spot", title: "Spot clean shower/tub", est: 8, noisy: false },
  ],
  floorsDeep: [
    { type: "vacuum", title: "Vacuum carpets/rugs", est: 18, noisy: true },
    { type: "mop", title: "Mop hard floors", est: 16, noisy: true },
  ],
  kitchenDeep: [
    { type: "appliance-wipe", title: "Exterior wipe: fridge/stove", est: 8, noisy: false },
    { type: "microwave-degrease", title: "Microwave: steam & wipe", est: 6, noisy: false },
    { type: "stove-degrease", title: "Stovetop: degrease", est: 10, noisy: false },
  ],
};

// supplies that may need restocking when these tasks appear
const SUPPLY_HINTS = {
  "surfaces-wipe": ["All-purpose spray", "Microfiber cloths"],
  dishes: ["Dish soap", "Rinse aid"],
  trash: ["Trash liners"],
  "vacuum": ["Vacuum bags/filter"],
  "mop": ["Floor cleaner", "Mop pads"],
  "toilet-sanitize": ["Toilet cleaner", "Disinfectant"],
  "laundry-wash": ["Detergent"],
};

/* ------------------------------ defaults & presets ------------------------------ */
const DEFAULTS = {
  domain: "cleaning",
  sessionTitle: "House Cleaning",
  quietHours: { start: 21, end: 7 }, // 9pm–7am default
  sabbathGuard: true,
  consolidation: true,
  nbaHints: true,
  defaultDurationMin: 60,
  // RRULE helpers for quick UX choices
  recurrencePresets: {
    DAILY_MORNING_RESET: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0",
    DAILY_EVENING_RESET: "FREQ=DAILY;BYHOUR=19;BYMINUTE=0;BYSECOND=0",
    WEEKLY_FLOORS: "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0;BYSECOND=0",
    WEEKLY_BATHROOMS: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=14;BYMINUTE=0;BYSECOND=0",
    BIWEEKLY_KITCHEN_DEEP: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=18;BYMINUTE=0;BYSECOND=0",
  },
};

export default class CleaningSessionEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
    this.ctx = {
      DexieDB: null,
      Automation: null,
      Guards: null,
      CalendarWriter: null,
      Stores: {}, // sessions, plans, favorites
    };
    this._init();
  }

  async _init() {
    this.ctx.DexieDB = await safeImport("@/db");
    this.ctx.Automation = await safeImport("@/services/automation/runtime");
    this.ctx.Guards = await safeImport("@/services/session/guards");
    this.ctx.CalendarWriter = await safeImport("@/services/calendar/CalendarWriter");

    try {
      const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
      this.ctx.Stores.sessions = db?.sessions;
      this.ctx.Stores.plans = db?.plans;
      this.ctx.Stores.favorites = db?.favorites;
    } catch (err) {
      console.warn("[CleaningSessionEngine] Dexie stores missing or not bound.", err);
    }

    this.emit("ready");
    emitGlobal(EVT.CLEANING_ENGINE_READY, { at: nowIso() });
  }

  /* ------------------------------------------------------------------------ */
  /* Session building                                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * buildDraftSession
   * @param {Object} input
   *  - date: ISO string (defaults to now)
   *  - recurring: { rrule?: string } optional
   *  - rooms: array of room codes or names
   *  - focuses: array of focus keys (e.g., 'dailyReset','bathroomsQuick','floorsDeep','kitchenDeep','laundry')
   *  - adjacency: { source: 'cooking'|'animals'|'garden', hints?: {...} }  // reverse-generation nudges
   *  - notes: string
   */
  async buildDraftSession(input = {}) {
    const id = genId();
    const startedAt = nowIso();
    const {
      date = startedAt,
      recurring = null,
      rooms = ["Kitchen", "Living Room"],
      focuses = ["dailyReset"],
      adjacency = null,
      notes = "",
    } = input;

    const baseTasks = this._expandFocusesIntoTasks(focuses, rooms);
    const adjacencyTasks = await this._adjacencyToTasks(adjacency);
    const tasks = [...baseTasks, ...adjacencyTasks];

    const consolidated = this.opts.consolidation ? this.consolidateTasks(tasks) : tasks;
    const stamped = this._stampTaskSchedule(consolidated, date);

    const session = {
      id,
      domain: this.opts.domain,
      title: this._buildTitle({ focuses, rooms, adjacency }),
      status: "draft",
      createdAt: startedAt,
      scheduledFor: date,
      recurring, // { rrule } | null
      rooms,
      focuses,
      adjacency,
      notes,
      tasks: stamped,
      estMinutes: stamped.reduce((a, t) => a + (t.estMinutes || 0), 0),
      meta: {
        version: 2,
        fromAdjacency: Boolean(adjacency),
      },
    };

    this.emit("draft", session);
    emitGlobal(EVT.CLEANING_SESSION_DRAFT, { session });

    // Cross-domain nudges (inventory + others)
    this._emitCrossDomainHints({ session });

    return session;
  }

  _buildTitle({ focuses = [], rooms = [], adjacency }) {
    const core = focuses.length ? focuses.join(" • ") : "Cleaning";
    const roomTxt = rooms.length ? ` — ${humanList(rooms)}` : "";
    const adj = adjacency?.source ? ` (from ${adjacency.source})` : "";
    return `${core}${roomTxt}${adj}`;
  }

  _expandFocusesIntoTasks(focuses = [], rooms = []) {
    const tasks = [];
    const roomHint = (t) => (rooms?.length ? `${t.title} — ${rooms[0]}` : t.title);

    for (const f of focuses) {
      const lib = TASKS[f] || [];
      for (const t of lib) {
        tasks.push(
          this._task({
            type: t.type,
            title: roomHint(t),
            estMinutes: t.est,
            room: rooms[0] || null,
            noisy: !!t.noisy,
          })
        );
      }
    }

    // If multiple rooms, add small per-room “touch” items
    if (rooms.length > 1 && focuses.includes("dailyReset")) {
      for (const r of rooms.slice(1)) {
        tasks.push(
          this._task({
            type: "room-touch",
            title: `Room touch reset — ${r}`,
            estMinutes: 5,
            room: r,
            noisy: false,
          })
        );
      }
    }
    return tasks;
  }

  async _adjacencyToTasks(adjacency) {
    if (!adjacency?.source) return [];
    const src = adjacency.source.toLowerCase();
    const tasks = [];

    if (src === "cooking") {
      tasks.push(
        this._task({ type: "range-degrease", title: "Degrease stovetop & backsplash", estMinutes: 8 }),
        this._task({ type: "sink-sanitize", title: "Sanitize sink & faucet", estMinutes: 5 }),
        this._task({ type: "dishes", title: "Dishes: finish cycle & put away", estMinutes: 10 })
      );
    }

    if (src === "animals") {
      tasks.push(
        this._task({ type: "boot-tray", title: "Disinfect boot tray / mud room", estMinutes: 5 }),
        this._task({ type: "tools-sanitize", title: "Sanitize buckets / tools staging", estMinutes: 8 })
      );
    }

    if (src === "garden") {
      tasks.push(
        this._task({ type: "entry-sweep", title: "Sweep entry & shake mats", estMinutes: 6 }),
        this._task({ type: "sink-sanitize", title: "Sink & counter sanitize (post produce)", estMinutes: 6 })
      );
    }

    // honor optional hints (e.g., greaseLevel, guestsComing)
    const hints = adjacency?.hints || {};
    if (hints.greaseLevel === "high") {
      tasks.push(this._task({ type: "hood-filter", title: "Range hood filter: quick wash", estMinutes: 6 }));
    }
    if (hints.guestsComing) {
      tasks.push(this._task({ type: "guest-bath", title: "Guest bath quick turn", estMinutes: 8 }));
    }
    return tasks;
  }

  _task({
    type = "general",
    title = "Task",
    estMinutes = 5,
    room = null,
    priority = "normal",
    noisy = false,
  }) {
    return {
      id: genId(),
      type,
      title,
      estMinutes,
      room,
      priority,
      noisy,
      done: false,
      scheduledFor: null, // set later
      sequence: null, // set later
    };
  }

  consolidateTasks(tasks = []) {
    const key = (t) => [t.room || "home", t.type].join("|");
    const map = new Map();
    for (const t of tasks) {
      const k = key(t);
      if (!map.has(k)) {
        map.set(k, { ...t, mergedCount: 1 });
      } else {
        const cur = map.get(k);
        cur.estMinutes = clamp((cur.estMinutes || 0) + (t.estMinutes || 0), 1, 240);
        cur.mergedCount += 1;
        cur.title = this._mergeTitles(cur.title, t.title);
        map.set(k, cur);
      }
    }
    return [...map.values()];
  }

  _mergeTitles(a = "", b = "") {
    const parts = Array.from(new Set([a, b].join(" | ").split("|").map((s) => s.trim()).filter(Boolean)));
    const merged = parts.slice(0, 3).join(" | ");
    return merged.length > 120 ? `${merged.slice(0, 117)}...` : merged;
  }

  _stampTaskSchedule(tasks, dateISO) {
    return tasks
      .map((t, i) => ({
        ...t,
        scheduledFor: dateISO,
        sequence: i + 1,
      }))
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  }

  /* ------------------------------------------------------------------------ */
  /* Guards + Scheduling                                                      */
  /* ------------------------------------------------------------------------ */

  async guardSession(session) {
    const reasons = [];
    let ok = true;

    // quiet hours + noise guard
    if (this.opts.quietHours) {
      const date = new Date(session.scheduledFor || Date.now());
      const h = date.getHours();
      const { start, end } = this.opts.quietHours;
      const isQuiet = start > end ? h >= start || h < end : h >= start && h < end;
      const hasNoisy = session.tasks?.some((t) => t.noisy);
      if (isQuiet && hasNoisy) {
        ok = false;
        reasons.push("quiet-hours-noisy");
      }
    }

    // sabbath guard
    if (this.opts.sabbathGuard && this.ctx.Guards?.isSabbath) {
      try {
        if (await this.ctx.Guards.isSabbath(new Date(session.scheduledFor))) {
          ok = false;
          reasons.push("sabbath");
        }
      } catch {
        /* ignore */
      }
    }

    // inclement weather rarely blocks indoor, but can block outdoor tasks (porch/garage)
    if (this.ctx.Guards?.isInclementWeather && session.tasks?.length) {
      try {
        const outdoorish = session.tasks.some((t) =>
          /(entry-sweep|porch|garage|mats|carpet-beat)/i.test(t.type)
        );
        if (outdoorish) {
          const inclement = await this.ctx.Guards.isInclementWeather(session.location);
          if (inclement) {
            ok = false;
            reasons.push("weather");
          }
        }
      } catch {
        /* ignore */
      }
    }

    return { ok, reasons };
  }

  async scheduleSession(session, { writeToCalendar = false } = {}) {
    // Ensure per-task dates & updated totals
    const draft =
      (session?.tasks?.length && session.tasks[0]?.scheduledFor)
        ? { ...session }
        : { ...session, tasks: this._stampTaskSchedule(session.tasks || [], session.scheduledFor) };
    draft.estMinutes = (draft.tasks || []).reduce((a, t) => a + (t.estMinutes || 0), 0);

    // Persist
    const persisted = await this._persistSession({ ...draft, status: "scheduled" });

    // Guards
    const guard = await this.guardSession(persisted);
    if (!guard.ok) {
      this.emit("guard.blocked", { session: persisted, reasons: guard.reasons });
      emitGlobal(EVT.CLEANING_SESSION_BLOCKED, { session: persisted, reasons: guard.reasons });
      return { session: persisted, jobId: null, blocked: true, reasons: guard.reasons };
    }

    // Automation runtime
    let jobId = null;
    if (this.ctx.Automation?.createJob) {
      try {
        const runPrompt = {
          type: "cleaning.session.run",
          sessionId: persisted.id,
          title: persisted.title,
          domain: persisted.domain,
        };
        if (persisted.recurring?.rrule) {
          jobId = await this.ctx.Automation.createJob({
            title: `Cleaning • ${persisted.title}`,
            prompt: runPrompt,
            schedule: {
              rrule: persisted.recurring.rrule,
              tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          });
        } else {
          jobId = await this.ctx.Automation.createJob({
            title: `Cleaning • ${persisted.title}`,
            prompt: runPrompt,
            startsAt: persisted.scheduledFor,
          });
        }
      } catch (err) {
        console.warn("[CleaningSessionEngine] automation createJob failed:", err);
      }
    }

    // Calendar write (optional)
    if (writeToCalendar && this.ctx.CalendarWriter?.createEvent) {
      try {
        await this.ctx.CalendarWriter.createEvent({
          title: `Cleaning: ${persisted.title}`,
          start: persisted.scheduledFor,
          durationMin: Math.max(15, persisted.estMinutes || 60),
          notes: this.toSpeechBrief(persisted),
          tags: ["cleaning", "session"],
        });
        emitGlobal(EVT.CALENDAR_SUGGEST_ADD, {
          title: `Cleaning: ${persisted.title}`,
          at: persisted.scheduledFor,
        });
      } catch (err) {
        console.warn("[CleaningSessionEngine] calendar write failed:", err);
      }
    }

    this.emit("scheduled", { session: persisted, jobId });
    emitGlobal(EVT.CLEANING_SESSION_SCHEDULED, { session: persisted, jobId });

    return { session: persisted, jobId, blocked: false, reasons: [] };
  }

  /* ------------------------------------------------------------------------ */
  /* Persistence + Favorites                                                  */
  /* ------------------------------------------------------------------------ */

  async _persistSession(session) {
    const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
    if (db?.sessions?.put) {
      await db.sessions.put(session);
    }
    return session;
  }

  async saveAsFavoriteSession(session, label = "") {
    const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
    const fav = {
      id: genId(),
      type: "session",
      domain: this.opts.domain,
      createdAt: nowIso(),
      label: label || session.title,
      payload: session,
      userOwned: true,
    };
    if (db?.favorites?.put) await db.favorites.put(fav);
    this.emit("favorite.saved", fav);
    emitGlobal(EVT.CLEANING_FAVORITE_SAVED, { favorite: fav });
    return fav;
  }

  async savePlanTemplate(plan, label = "") {
    const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
    const doc = {
      id: genId(),
      type: "plan-template",
      domain: this.opts.domain,
      createdAt: nowIso(),
      label: label || plan?.title || "Cleaning Plan",
      payload: plan,
      userOwned: true,
    };
    if (db?.plans?.put) await db.plans.put(doc);
    this.emit("plan.saved", doc);
    emitGlobal(EVT.CLEANING_PLAN_SAVED, { plan: doc });
    return doc;
  }

  /* ------------------------------------------------------------------------ */
  /* Reverse: Generate from adjacency                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * generateFromAdjacent
   * Build a lightweight plan from another domain's session (cooking, animals, garden).
   * @param {Object} opts
   *  - source: 'cooking'|'animals'|'garden'
   *  - hints?: object (e.g., { greaseLevel: 'low'|'medium'|'high', guestsComing: true })
   */
  async generateFromAdjacent({ source, hints = {}, rooms = ["Kitchen"] } = {}) {
    const tasks = await this._adjacencyToTasks({ source, hints });
    const stamped = this._stampTaskSchedule(tasks, nowIso());
    const plan = {
      id: genId(),
      domain: this.opts.domain,
      title: `Cleaning from ${source}`,
      createdAt: nowIso(),
      rooms,
      tasks: stamped,
      meta: { source, hints },
    };

    this.emit("plan.generated.fromAdjacent", plan);
    emitGlobal(EVT.CLEANING_PLAN_FROM_ADJACENT, { plan });

    // Inventory nudge if supplies implied
    this._emitInventoryHints(tasks);

    // Suggest linked sessions in animals/garden when relevant
    if (source === "animals") {
      emitGlobal(EVT.ANIMALS_SESSION_SUGGEST, {
        reason: "Post-animals cleanup suggests follow-up staging",
        scheduledFor: nowIso(),
      });
    }
    if (source === "garden") {
      emitGlobal(EVT.GARDEN_SESSION_SUGGEST, {
        reason: "After-garden cleanup suggests tool return & hose drain",
        scheduledFor: nowIso(),
      });
    }

    return plan;
  }

  /* ------------------------------------------------------------------------ */
  /* Hints + Voice                                                            */
  /* ------------------------------------------------------------------------ */

  _emitCrossDomainHints({ session }) {
    // Inventory: propose reserving/adding cleaning supplies
    this._emitInventoryHints(session.tasks || []);

    // Meals: after kitchen deep or cooking adjacency, hint that kitchen is “ready”
    const kitchenish = (session.focuses || []).includes("kitchenDeep") ||
      (session.adjacency?.source === "cooking");
    if (kitchenish) {
      emitGlobal(EVT.MEALS_NEEDS_UPDATE, {
        source: "cleaning.session",
        note: "Kitchen reset—ready for batch or meal prep.",
      });
    }
  }

  _emitInventoryHints(tasks) {
    const needed = new Set();
    for (const t of tasks) {
      const hints = SUPPLY_HINTS[t.type];
      if (hints) hints.forEach((h) => needed.add(h));
    }
    if (needed.size) {
      emitGlobal(EVT.INVENTORY_RESERVE_SUGGEST, {
        domain: "cleaning",
        items: Array.from(needed),
        reason: "Upcoming cleaning session supplies check",
      });
    }
  }

  toSpeechBrief(session) {
    const rooms = Array.from(new Set((session.tasks || []).map((t) => t.room))).filter(Boolean);
    const majors = (session.tasks || [])
      .sort((a, b) => (b.estMinutes || 0) - (a.estMinutes || 0))
      .slice(0, 3)
      .map((t) => t.title);

    return [
      `${session.title} scheduled.`,
      rooms.length ? `Rooms: ${humanList(rooms)}.` : "",
      majors.length ? `Top tasks: ${humanList(majors)}.` : "",
      `About ${Math.round((session.estMinutes || 60) / 5) * 5} minutes.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  nextBestAction(session) {
    const hasFloors = session.tasks?.some((t) => /mop|vacuum|floors-spot/.test(t.type));
    if (hasFloors) {
      return {
        label: "Stage floors workflow",
        actions: ["Pick up items", "Move lightweight furniture", "Fill mop bucket / charge vac"],
      };
    }
    const hasBathrooms = session.tasks?.some((t) => /toilet|sink|shower/.test(t.type));
    if (hasBathrooms) {
      return {
        label: "Stage bathroom supplies",
        actions: ["Gloves & brushes out", "Open vent/fan", "Set disinfectant dwell timer"],
      };
    }
    return {
      label: "Start daily reset",
      actions: ["Clear counters", "Start dishwasher", "Line up trash bags"],
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Runner                                                                   */
  /* ------------------------------------------------------------------------ */

  async runSession(sessionId) {
    const Runner = await safeImport("@/services/session/SessionRunner");
    if (Runner?.run) {
      return Runner.run({ domain: this.opts.domain, sessionId });
    }
    // fallback simulation
    this.emit("run.start", { sessionId });
    emitGlobal(EVT.CLEANING_SESSION_RUN_START, { sessionId });
    await new Promise((r) => setTimeout(r, minutes(0.2)));
    this.emit("run.finish", { sessionId });
    emitGlobal(EVT.CLEANING_SESSION_RUN_FINISH, { sessionId });
    return { ok: true };
  }

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                  */
  /* ------------------------------------------------------------------------ */

  buildRecurring(presetKey) {
    const rrule = this.opts.recurrencePresets?.[presetKey];
    return rrule ? { rrule } : null;
  }
}

/* -------------------------------------------------------------------------- */
/* Example usage (commented for discoverability)                              */
/* -------------------------------------------------------------------------- */
/*
const engine = new CleaningSessionEngine();

// 1) Draft a daily reset focusing Kitchen + Living Room
const draft = await engine.buildDraftSession({
  date: new Date().toISOString(),
  rooms: ["Kitchen", "Living Room"],
  focuses: ["dailyReset", "laundry"],
  adjacency: { source: "cooking", hints: { greaseLevel: "high" } },
});

// 2) Schedule one-time + write to calendar
const scheduled = await engine.scheduleSession(draft, { writeToCalendar: true });

// 3) Save as a user-owned favorite
await engine.saveAsFavoriteSession(scheduled.session, "Daily Kitchen Reset");

// 4) Build a recurring preset (weekly bathrooms)
const recurring = engine.buildRecurring("WEEKLY_BATHROOMS");

// 5) Generate a plan from Animals adjacency
const plan = await engine.generateFromAdjacent({ source: "animals", rooms: ["Mud Room"] });

// 6) Next Best Action
const nba = engine.nextBestAction(scheduled.session);
*/
