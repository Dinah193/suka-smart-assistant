/* eslint-disable no-console */
// src/engines/gardening/GardenSessionEngine.js
// GardenSessionEngine
// -----------------------------------------------------------------------------
// Builds, consolidates, schedules, and persists garden sessions
// (bed prep, sow, transplant, water, weed, mulch, trellis, fertilize, harvest,
// preserve handoff). Supports reverse generation from seeds/recipes/inventory.
//
// Highlights
// - Draft → Consolidate → Guard → Schedule → Persist → Emit
// - Per-task scheduledFor + sequence ordering
// - One-time or recurring (RRULE via local automation runtime)
// - User-owned favorites & plan templates (distinct from system presets)
// - Reverse generation: from Seeds on hand, from Recipes/Meal goals, from Inventory overflow
// - NBA hints + voice brief
// - Cross-domain orchestration (Calendar, Inventory, Meals, Animals, Cleaning, Scan•Compare•Trust)
//
// Soft integrations (safe imports; file never crashes if absent):
// - DexieDB "@/db" (sessions, plans, favorites)
// - Local automation runtime "@/services/automation/runtime"
// - Guards "@/services/session/guards" (sabbath, weather, frost windows, quiet hours)
// - CalendarWriter "@/services/calendar/CalendarWriter"
// - Event catalog "@/features/scan-compare-trust/automation/events.catalog.js"
// - Optional Zone/Season helpers "@/services/garden/SeasonService"

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

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

/* ---------------------------- events (with fallbacks) ---------------------------- */
let EVT = {
  GARDEN_ENGINE_READY: "garden.engine.ready",
  GARDEN_SESSION_DRAFT: "garden.session.draft",
  GARDEN_SESSION_SCHEDULED: "garden.session.scheduled",
  GARDEN_SESSION_BLOCKED: "garden.session.blocked",
  GARDEN_SESSION_RUN_START: "garden.session.run.start",
  GARDEN_SESSION_RUN_FINISH: "garden.session.run.finish",
  GARDEN_FAVORITE_SAVED: "garden.favorite.saved",
  GARDEN_PLAN_SAVED: "garden.plan.saved",
  GARDEN_PLAN_FROM_SEEDS: "garden.plan.fromSeeds",
  GARDEN_PLAN_FROM_RECIPES: "garden.plan.fromRecipes",
  GARDEN_PLAN_FROM_INVENTORY: "garden.plan.fromInventory",
  // cross-domain nudges
  CALENDAR_SUGGEST_ADD: "calendar.suggest.add",
  INVENTORY_RESERVE_SUGGEST: "inventory.reserve.suggest",
  INVENTORY_ADD_HARVEST_SUGGEST: "inventory.harvest.add.suggest",
  MEALS_NEEDS_UPDATE: "meals.needs.update",
  ANIMALS_SESSION_SUGGEST: "animals.session.suggest",
  CLEANING_SESSION_SUGGEST: "cleaning.session.suggest",
  SCT_PRICE_NUDGE: "scancomparetrust.price.nudge",
  SCT_COUPON_NUDGE: "scancomparetrust.coupon.nudge",
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
    console.warn("[GardenSessionEngine] emitGlobal warn:", err);
  }
};

/* ------------------------------ domain knowledge ------------------------------ */
// Minimal crop library (extend/replace with SeasonService later)
const CROPS = {
  tomato: { dttm: 70, spring: true, fall: true, frostTender: true, spacingIn: 18 },
  pepper: { dttm: 75, spring: true, fall: true, frostTender: true, spacingIn: 16 },
  squash: { dttm: 55, spring: true, fall: false, frostTender: true, spacingIn: 24 },
  cucumber: { dttm: 55, spring: true, fall: true, frostTender: true, spacingIn: 10 },
  lettuce: { dttm: 35, spring: true, fall: true, frostTender: false, spacingIn: 8 },
  kale: { dttm: 50, spring: true, fall: true, frostTender: false, spacingIn: 12 },
  bean: { dttm: 50, spring: true, fall: true, frostTender: true, spacingIn: 6 },
  okra: { dttm: 60, spring: true, fall: false, frostTender: true, spacingIn: 12 },
  corn: { dttm: 75, spring: true, fall: false, frostTender: true, spacingIn: 8 },
  herb: { dttm: 30, spring: true, fall: true, frostTender: false, spacingIn: 8 },
};

function guessCropKey(name = "") {
  const n = (name || "").toLowerCase();
  if (/tomat/.test(n)) return "tomato";
  if (/pepper|chili|chilli/.test(n)) return "pepper";
  if (/squash|zucchini|pumpkin/.test(n)) return "squash";
  if (/cucum/.test(n)) return "cucumber";
  if (/lettuc|greens|salad/.test(n)) return "lettuce";
  if (/kale|collard/.test(n)) return "kale";
  if (/bean|peas?/.test(n)) return "bean";
  if (/okra/.test(n)) return "okra";
  if (/corn|maize/.test(n)) return "corn";
  if (/basil|oregano|parsley|herb/.test(n)) return "herb";
  return null;
}

/* ------------------------------ defaults & presets ------------------------------ */
const DEFAULTS = {
  domain: "garden",
  sessionTitle: "Garden Work",
  quietHours: null, // garden often daytime only; leave null
  sabbathGuard: true,
  consolidation: true,
  nbaHints: true,
  defaultDurationMin: 60,
  // RRULE helpers
  recurrencePresets: {
    DAILY_WATER: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0;BYSECOND=0",
    WEEKLY_WEED: "FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0;BYSECOND=0",
    WEEKLY_HARVEST: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
  },
};

export default class GardenSessionEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
    this.ctx = {
      DexieDB: null,
      Automation: null,
      Guards: null,
      CalendarWriter: null,
      SeasonService: null, // optional: last/first frost, zone, planting windows
      Stores: {}, // sessions, plans, favorites
    };
    this._init();
  }

  async _init() {
    this.ctx.DexieDB = await safeImport("@/db");
    this.ctx.Automation = await safeImport("@/services/automation/runtime");
    this.ctx.Guards = await safeImport("@/services/session/guards");
    this.ctx.CalendarWriter = await safeImport("@/services/calendar/CalendarWriter");
    this.ctx.SeasonService = await safeImport("@/services/garden/SeasonService");

    try {
      const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
      this.ctx.Stores.sessions = db?.sessions;
      this.ctx.Stores.plans = db?.plans;
      this.ctx.Stores.favorites = db?.favorites;
    } catch (err) {
      console.warn("[GardenSessionEngine] Dexie stores missing or not bound.", err);
    }

    this.emit("ready");
    emitGlobal(EVT.GARDEN_ENGINE_READY, { at: nowIso() });
  }

  /* ------------------------------------------------------------------------ */
  /* Session building                                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * buildDraftSession
   * @param {Object} input
   *  - date: ISO string (defaults to now)
   *  - recurring: { rrule?: string } optional
   *  - zone?: number (USDA)
   *  - beds?: [{ id?, label, lengthFt?, widthFt? }]
   *  - crops?: [{ name, count?, bedId?, action?: 'sow'|'transplant'|'harvest'|'maintain' }]
   *  - focuses?: ('bedPrep'|'sow'|'transplant'|'water'|'weed'|'mulch'|'trellis'|'fertilize'|'harvest')[]
   *  - adjacency?: { source: 'seeds'|'recipes'|'inventory', data?: any }
   *  - notes?: string
   */
  async buildDraftSession(input = {}) {
    const id = genId();
    const startedAt = nowIso();
    const {
      date = startedAt,
      recurring = null,
      zone = 7,
      beds = [{ label: "Bed A", lengthFt: 8, widthFt: 3 }],
      crops = [],
      focuses = ["bedPrep", "sow", "water"],
      adjacency = null,
      notes = "",
      location = null,
    } = input;

    // Expand focuses + crops into atomic tasks
    const baseTasks = this._expandFocusesIntoTasks({ focuses, beds, crops, zone });
    // Reverse/adjacency tasks
    const adjTasks = await this._adjacencyToTasks(adjacency, { zone, beds });

    const tasks = [...baseTasks, ...adjTasks];

    // Consolidate similar tasks and stamp each with schedule + sequence
    const consolidated = this.opts.consolidation ? this.consolidateTasks(tasks) : tasks;
    const stamped = this._stampTaskSchedule(consolidated, date);

    const session = {
      id,
      domain: this.opts.domain,
      title: this._buildTitle({ focuses, beds, crops, adjacency }),
      status: "draft",
      createdAt: startedAt,
      scheduledFor: date,
      recurring, // { rrule } | null
      zone,
      location,
      beds,
      crops,
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

    // Emit + nudges
    this.emit("draft", session);
    emitGlobal(EVT.GARDEN_SESSION_DRAFT, { session });
    this._emitCrossDomainHints({ session });

    return session;
  }

  _buildTitle({ focuses = [], beds = [], crops = [], adjacency }) {
    const core = focuses.length ? focuses.join(" • ") : "Garden Work";
    const bedTxt = beds?.length ? ` — ${beds.slice(0, 2).map((b) => b.label).join(" • ")}${beds.length > 2 ? ` +${beds.length - 2}` : ""}` : "";
    const cropTxt = crops?.length ? ` • ${crops.slice(0, 2).map((c) => c.name).join(" / ")}${crops.length > 2 ? ` +${crops.length - 2}` : ""}` : "";
    const adj = adjacency?.source ? ` (from ${adjacency.source})` : "";
    return `${core}${bedTxt}${cropTxt}${adj}`;
  }

  _task({
    type = "general",
    title = "Task",
    estMinutes = 5,
    bed = null,
    crop = null,
    priority = "normal",
    noisy = false,
    weatherSensitive = true,
    leadMin = 0,
  }) {
    return {
      id: genId(),
      type,
      title,
      estMinutes,
      bed,
      crop,
      priority,
      noisy,
      weatherSensitive,
      leadMin,
      done: false,
      scheduledFor: null, // set later
      sequence: null, // set later
    };
  }

  _expandFocusesIntoTasks({ focuses = [], beds = [], crops = [], zone = 7 }) {
    const tasks = [];

    const pickBed = (i) => beds[i % Math.max(1, beds.length)]?.label || "Bed";
    const estByArea = (b) => {
      const area = Math.max(1, (b?.lengthFt || 8) * (b?.widthFt || 3));
      return clamp(Math.round(area / 6), 5, 45);
    };

    // bed prep
    if (focuses.includes("bedPrep")) {
      beds.forEach((b, i) => {
        tasks.push(
          this._task({
            type: "bed-prep",
            title: `Bed prep — ${pickBed(i)} (rake, amend, level)`,
            estMinutes: estByArea(b),
            bed: b.label,
          })
        );
      });
    }

    // sow / transplant tasks (guided by provided crops)
    for (const c of crops) {
      const key = guessCropKey(c.name) || "herb";
      const info = CROPS[key] || { dttm: 45, spacingIn: 10, frostTender: false };
      const action = c.action || "sow";
      const bed = c.bedId ? (beds.find((b) => b.id === c.bedId)?.label || "Bed") : beds[0]?.label;

      if (action === "sow") {
        tasks.push(
          this._task({
            type: "sow",
            title: `Sow ${c.name} — ${bed} (${info.spacingIn}″ spacing)`,
            estMinutes: clamp((c.count || 20) * 0.4, 5, 30),
            bed,
            crop: c.name,
            weatherSensitive: true,
          })
        );
      } else if (action === "transplant") {
        tasks.push(
          this._task({
            type: "transplant",
            title: `Transplant ${c.name} — ${bed} (${info.spacingIn}″ spacing)`,
            estMinutes: clamp((c.count || 10) * 1, 8, 45),
            bed,
            crop: c.name,
            weatherSensitive: true,
          })
        );
      } else if (action === "harvest") {
        tasks.push(
          this._task({
            type: "harvest",
            title: `Harvest ${c.name} — ${bed}`,
            estMinutes: clamp((c.count || 10) * 0.6, 5, 35),
            bed,
            crop: c.name,
            weatherSensitive: false,
          })
        );
      } else if (action === "maintain") {
        tasks.push(
          this._task({
            type: "weed",
            title: `Weed & side-dress ${c.name} — ${bed}`,
            estMinutes: clamp((c.count || 10) * 0.5, 5, 25),
            bed,
            crop: c.name,
          })
        );
      }
    }

    // generic focuses
    if (focuses.includes("water")) {
      beds.forEach((b, i) =>
        tasks.push(
          this._task({
            type: "water",
            title: `Water deeply — ${pickBed(i)}`,
            estMinutes: clamp(estByArea(b), 8, 30),
            bed: b.label,
          })
        )
      );
    }
    if (focuses.includes("weed")) {
      beds.forEach((b, i) =>
        tasks.push(
          this._task({
            type: "weed",
            title: `Weed — ${pickBed(i)}`,
            estMinutes: clamp(estByArea(b), 8, 25),
            bed: b.label,
          })
        )
      );
    }
    if (focuses.includes("mulch")) {
      beds.forEach((b, i) =>
        tasks.push(
          this._task({
            type: "mulch",
            title: `Mulch — ${pickBed(i)}`,
            estMinutes: clamp(estByArea(b), 8, 30),
            bed: b.label,
          })
        )
      );
    }
    if (focuses.includes("trellis")) {
      const trellisCrops = crops.filter((c) => /tomat|cucum|bean|pea/i.test(c.name || ""));
      trellisCrops.forEach((c) =>
        tasks.push(
          this._task({
            type: "trellis",
            title: `Set trellis — ${c.name} (${c.bedId ? c.bedId : beds[0]?.label || "Bed"})`,
            estMinutes: clamp((c.count || 6) * 1.5, 8, 35),
            bed: c.bedId ? c.bedId : beds[0]?.label,
            crop: c.name,
          })
        )
      );
    }
    if (focuses.includes("fertilize")) {
      beds.forEach((b, i) =>
        tasks.push(
          this._task({
            type: "fertilize",
            title: `Fertilize — ${pickBed(i)}`,
            estMinutes: clamp(estByArea(b) * 0.6, 6, 20),
            bed: b.label,
          })
        )
      );
    }

    return tasks;
  }

  async _adjacencyToTasks(adjacency, { zone, beds }) {
    if (!adjacency?.source) return [];
    const src = adjacency.source.toLowerCase();
    const tasks = [];

    if (src === "seeds") {
      // data: [{ name, count, sowWhen?: 'now'|'spring'|'fall' }]
      for (const pkt of adjacency.data || []) {
        const key = guessCropKey(pkt.name) || "herb";
        const info = CROPS[key] || { spacingIn: 10 };
        const bed = beds[0]?.label || "Bed";
        tasks.push(
          this._task({
            type: "sow",
            title: `Sow from seed — ${pkt.name} (${info.spacingIn}″) — ${bed}`,
            estMinutes: clamp((pkt.count || 20) * 0.4, 5, 30),
            bed,
            crop: pkt.name,
          })
        );
      }
      // suggest irrigation check when sowing by seeds
      tasks.push(this._task({ type: "irrigation-check", title: "Check drip/soaker lines", estMinutes: 8, weatherSensitive: false }));
    }

    if (src === "recipes") {
      // data: [{ title, ingredients[] }]
      const wants = this._ingredientsToGardenNeeds(adjacency.data || []);
      for (const w of wants) {
        const bed = beds[0]?.label || "Bed";
        tasks.push(
          this._task({
            type: "plan",
            title: `Plan ${w} succession — ${bed}`,
            estMinutes: 6,
            bed,
            crop: w,
            weatherSensitive: false,
          })
        );
      }
    }

    if (src === "inventory") {
      // data: overflow items to preserve → harvest now + preserve handoff
      for (const item of adjacency.data || []) {
        if (/(tomato|cucumber|pepper|bean|greens|zucchini)/i.test(item.name || "")) {
          tasks.push(this._task({ type: "harvest", title: `Pick ripe ${item.name} (overflow)`, estMinutes: 8, weatherSensitive: true, crop: item.name }));
          tasks.push(this._task({ type: "wash-trim", title: `Wash/trim ${item.name} for preserving`, estMinutes: 10, weatherSensitive: false, crop: item.name }));
        }
      }
    }

    return tasks;
  }

  _ingredientsToGardenNeeds(recipes = []) {
    const s = recipes.flatMap((r) => (r.ingredients || []).map((x) => String(x).toLowerCase())).join(" | ");
    const wants = [];
    if (/tomato/.test(s)) wants.push("tomato");
    if (/pepper|chili|chilli/.test(s)) wants.push("pepper");
    if (/cucumber/.test(s)) wants.push("cucumber");
    if (/lettuce|greens/.test(s)) wants.push("lettuce");
    if (/bean/.test(s)) wants.push("bean");
    if (/herb|basil|oregano|parsley/.test(s)) wants.push("herb");
    return uniq(wants);
  }

  consolidateTasks(tasks = []) {
    const key = (t) => [t.bed || "garden", t.type].join("|");
    const map = new Map();
    for (const t of tasks) {
      const k = key(t);
      if (!map.has(k)) {
        map.set(k, { ...t, mergedCount: 1, crops: t.crop ? [t.crop] : [] });
      } else {
        const cur = map.get(k);
        cur.estMinutes = clamp((cur.estMinutes || 0) + (t.estMinutes || 0), 1, 240);
        cur.mergedCount += 1;
        if (t.crop) cur.crops = uniq([...(cur.crops || []), t.crop]);
        cur.title = this._mergeTitles(cur.title, t.title);
        cur.leadMin = Math.max(cur.leadMin || 0, t.leadMin || 0);
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

    // sabbath guard
    if (this.opts.sabbathGuard && this.ctx.Guards?.isSabbath) {
      try {
        if (await this.ctx.Guards.isSabbath(new Date(session.scheduledFor))) {
          ok = false;
          reasons.push("sabbath");
        }
      } catch { /* ignore */ }
    }

    // weather guard for outdoor tasks
    if (this.ctx.Guards?.isInclementWeather && session.tasks?.length) {
      try {
        const outdoorish = session.tasks.some((t) => t.weatherSensitive !== false);
        if (outdoorish) {
          const inclement = await this.ctx.Guards.isInclementWeather(session.location);
          if (inclement) {
            ok = false;
            reasons.push("weather");
          }
        }
      } catch { /* ignore */ }
    }

    // frost/season sanity: if SeasonService exposes isBadPlantingWindow
    if (this.ctx.SeasonService?.isBadPlantingWindow && session.tasks?.length) {
      try {
        const risky = await this.ctx.SeasonService.isBadPlantingWindow({
          date: session.scheduledFor,
          zone: session.zone,
          tasks: session.tasks.map((t) => ({ type: t.type, crop: t.crop })),
        });
        if (risky) {
          ok = false;
          reasons.push("planting-window");
        }
      } catch { /* ignore */ }
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
      emitGlobal(EVT.GARDEN_SESSION_BLOCKED, { session: persisted, reasons: guard.reasons });
      return { session: persisted, jobId: null, blocked: true, reasons: guard.reasons };
    }

    // Automation runtime
    let jobId = null;
    if (this.ctx.Automation?.createJob) {
      try {
        const runPrompt = {
          type: "garden.session.run",
          sessionId: persisted.id,
          title: persisted.title,
          domain: persisted.domain,
        };
        if (persisted.recurring?.rrule) {
          jobId = await this.ctx.Automation.createJob({
            title: `Garden • ${persisted.title}`,
            prompt: runPrompt,
            schedule: {
              rrule: persisted.recurring.rrule,
              tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          });
        } else {
          jobId = await this.ctx.Automation.createJob({
            title: `Garden • ${persisted.title}`,
            prompt: runPrompt,
            startsAt: persisted.scheduledFor,
          });
        }
      } catch (err) {
        console.warn("[GardenSessionEngine] automation createJob failed:", err);
      }
    }

    // Calendar write (optional)
    if (writeToCalendar && this.ctx.CalendarWriter?.createEvent) {
      try {
        await this.ctx.CalendarWriter.createEvent({
          title: `Garden: ${persisted.title}`,
          start: persisted.scheduledFor,
          durationMin: Math.max(15, persisted.estMinutes || 60),
          notes: this.toSpeechBrief(persisted),
          tags: ["garden", "session"],
        });
        emitGlobal(EVT.CALENDAR_SUGGEST_ADD, {
          title: `Garden: ${persisted.title}`,
          at: persisted.scheduledFor,
        });
      } catch (err) {
        console.warn("[GardenSessionEngine] calendar write failed:", err);
      }
    }

    this.emit("scheduled", { session: persisted, jobId });
    emitGlobal(EVT.GARDEN_SESSION_SCHEDULED, { session: persisted, jobId });

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
    emitGlobal(EVT.GARDEN_FAVORITE_SAVED, { favorite: fav });
    return fav;
  }

  async savePlanTemplate(plan, label = "") {
    const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
    const doc = {
      id: genId(),
      type: "plan-template",
      domain: this.opts.domain,
      createdAt: nowIso(),
      label: label || plan?.title || "Garden Plan",
      payload: plan,
      userOwned: true,
    };
    if (db?.plans?.put) await db.plans.put(doc);
    this.emit("plan.saved", doc);
    emitGlobal(EVT.GARDEN_PLAN_SAVED, { plan: doc });
    return doc;
  }

  /* ------------------------------------------------------------------------ */
  /* Reverse generation                                                       */
  /* ------------------------------------------------------------------------ */

  /**
   * generateFromSeeds
   * @param {Object} opts
   *  - seedPackets: [{ name, count?, notes? }]
   *  - zone?: number
   *  - beds?: [...]
   */
  async generateFromSeeds({ seedPackets = [], zone = 7, beds = [{ label: "Bed A" }] } = {}) {
    const tasks = [];
    for (const pkt of seedPackets) {
      const key = guessCropKey(pkt.name) || "herb";
      const info = CROPS[key] || { spacingIn: 10 };
      const bed = beds[0]?.label || "Bed";
      tasks.push(
        this._task({
          type: "sow",
          title: `Sow from seed — ${pkt.name} (${info.spacingIn}″) — ${bed}`,
          estMinutes: clamp((pkt.count || 20) * 0.4, 5, 30),
          bed,
          crop: pkt.name,
        })
      );
    }
    // irrigation + mulch suggestion to protect germination
    tasks.push(
      this._task({ type: "irrigation-check", title: "Check drip/soaker lines", estMinutes: 8, weatherSensitive: false }),
      this._task({ type: "mulch", title: "Mulch thinly over rows", estMinutes: 10 })
    );

    const stamped = this._stampTaskSchedule(tasks, nowIso());
    const plan = {
      id: genId(),
      domain: this.opts.domain,
      title: "Garden Plan from Seeds",
      createdAt: nowIso(),
      zone,
      beds,
      tasks: stamped,
      meta: { seedCount: seedPackets.length },
    };

    emitGlobal(EVT.GARDEN_PLAN_FROM_SEEDS, { plan });

    // SCT nudges for tools/soil/irrigation parts
    const items = ["soaker hose", "drip emitters", "compost", "starter mix"];
    emitGlobal(EVT.SCT_PRICE_NUDGE, { items, source: "garden.plan.seeds" });
    emitGlobal(EVT.SCT_COUPON_NUDGE, { items, source: "garden.plan.seeds" });

    return plan;
  }

  /**
   * generateFromRecipes
   * Creates a succession/harvest-oriented plan based on meal goals.
   * @param {Object} opts
   *  - recipes: [{ title, ingredients[] }]
   */
  async generateFromRecipes({ recipes = [], zone = 7, beds = [{ label: "Bed A" }] } = {}) {
    const wants = this._ingredientsToGardenNeeds(recipes);
    const tasks = [];
    for (const w of wants) {
      const bed = beds[0]?.label || "Bed";
      tasks.push(
        this._task({
          type: "plan",
          title: `Plan succession for ${w} — ${bed}`,
          estMinutes: 6,
          bed,
          crop: w,
          weatherSensitive: false,
        })
      );
      tasks.push(this._task({ type: "sow", title: `Sow ${w} — ${bed}`, estMinutes: 8, bed, crop: w }));
      tasks.push(this._task({ type: "harvest", title: `Harvest window for ${w} (set reminders)`, estMinutes: 3, bed, crop: w, weatherSensitive: false }));
    }

    const stamped = this._stampTaskSchedule(tasks, nowIso());
    const plan = {
      id: genId(),
      domain: this.opts.domain,
      title: "Garden Plan from Recipes",
      createdAt: nowIso(),
      zone,
      beds,
      tasks: stamped,
      meta: { recipes: recipes.length, crops: wants },
    };

    emitGlobal(EVT.GARDEN_PLAN_FROM_RECIPES, { plan });
    emitGlobal(EVT.MEALS_NEEDS_UPDATE, { source: "garden.plan.recipes", crops: wants });

    return plan;
  }

  /**
   * generateFromInventoryOverflow
   * Suggest pick/trim + preserving handoff when pantry/freezer is full or produce peaking.
   * @param {Object} opts
   *  - items: [{ name, qty?, unit? }]
   */
  async generateFromInventoryOverflow({ items = [] } = {}) {
    const tasks = [];
    for (const it of items) {
      if (/(tomato|cucumber|pepper|bean|greens|zucchini)/i.test(it.name || "")) {
        tasks.push(this._task({ type: "harvest", title: `Pick ripe ${it.name}`, estMinutes: 8, crop: it.name }));
        tasks.push(this._task({ type: "wash-trim", title: `Wash/trim ${it.name} for canning/pickling`, estMinutes: 10, crop: it.name, weatherSensitive: false }));
      }
    }

    const stamped = this._stampTaskSchedule(tasks, nowIso());
    const plan = {
      id: genId(),
      domain: this.opts.domain,
      title: "Garden Plan from Inventory Overflow",
      createdAt: nowIso(),
      tasks: stamped,
      meta: { items },
    };

    emitGlobal(EVT.GARDEN_PLAN_FROM_INVENTORY, { plan });
    // inventory add-harvest suggestion
    if (tasks.some((t) => t.type === "harvest")) {
      emitGlobal(EVT.INVENTORY_ADD_HARVEST_SUGGEST, {
        domain: "garden",
        items: uniq(items.map((i) => i.name)),
        reason: "Harvest incoming; add to storehouse",
      });
    }
    return plan;
  }

  /* ------------------------------------------------------------------------ */
  /* Voice + NBA                                                              */
  /* ------------------------------------------------------------------------ */

  toSpeechBrief(session) {
    const beds = Array.from(new Set((session.tasks || []).map((t) => t.bed))).filter(Boolean);
    const majors = (session.tasks || [])
      .sort((a, b) => (b.estMinutes || 0) - (a.estMinutes || 0))
      .slice(0, 3)
      .map((t) => t.title);

    return [
      `${session.title} scheduled.`,
      beds.length ? `Beds: ${humanList(beds)}.` : "",
      majors.length ? `Top tasks: ${humanList(majors)}.` : "",
      `About ${Math.round((session.estMinutes || 60) / 5) * 5} minutes.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  nextBestAction(session) {
    const hasSow = session.tasks?.some((t) => t.type === "sow");
    const hasTransplant = session.tasks?.some((t) => t.type === "transplant");
    const hasHarvest = session.tasks?.some((t) => t.type === "harvest");

    if (hasSow) {
      return {
        label: "Stage sowing",
        actions: ["Lay out rows", "Pre-wet rows", "Label markers", "Set light mulch"],
      };
    }
    if (hasTransplant) {
      return {
        label: "Stage transplanting",
        actions: ["Harden off trays", "Pre-dig holes", "Dilute starter fertilizer"],
      };
    }
    if (hasHarvest) {
      return {
        label: "Stage harvest",
        actions: ["Sanitize bins", "Chill rinse water", "Prep labels for storage"],
      };
    }
    return {
      label: "Prep garden workflow",
      actions: ["Grab tools", "Check irrigation", "Bring compost & mulch"],
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
    emitGlobal(EVT.GARDEN_SESSION_RUN_START, { sessionId });
    await new Promise((r) => setTimeout(r, minutes(0.2)));
    this.emit("run.finish", { sessionId });
    emitGlobal(EVT.GARDEN_SESSION_RUN_FINISH, { sessionId });
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
