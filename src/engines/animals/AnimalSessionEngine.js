/* eslint-disable no-console */
// src/engines/animals/AnimalSessionEngine.js
// AnimalSessionEngine
// -----------------------------------------------------------------------------
// Builds, consolidates, schedules, and persists animal-care sessions
// (feeding, watering, bedding, cleaning, breeding, health, processing).
//
// Highlights
// - Draft → Consolidate → Guard → Schedule → Persist → Emit events
// - One-time or recurring sessions (RRULE support via automation runtime)
// - User-favoriteable plans & sessions
// - Reverse direction: "Generate Animal Plan from Recipes"
// - Meat yield estimates & breed suggestions by basic geo/zone heuristics
// - Voice-friendly summaries + NBA (Next Best Action) hints
// - Per-task scheduledFor + sequence numbers (fixes: "tasks didn’t carry date")
// - Shared orchestration: emits cross-domain events for Meals, Cleaning, Inventory, Calendar
//
// Integrations (soft/optional):
// - DexieDB (local DB) at "@/db"
// - Local automation runtime at "@/services/automation/runtime"
// - Optional weather & quiet-hours/Sabbath guards at "@/services/session/guards"
// - Event catalog (names/contracts) at features/scan-compare-trust/automation/events.catalog.js
//
// All imports are "soft" (safeImport) so the file won't crash if modules are absent.

import EventEmitter from "eventemitter3";

/* ------------------------------- soft imports ------------------------------- */
async function safeImport(path) {
  try {
    const mod = await import(path);
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

/* attempt to load event catalog; fall back to sane defaults */
let EVT = {
  ANIMALS_ENGINE_READY: "animals.engine.ready",
  ANIMALS_SESSION_DRAFT: "animals.session.draft",
  ANIMALS_SESSION_BLOCKED: "animals.session.blocked",
  ANIMALS_SESSION_SCHEDULED: "animals.session.scheduled",
  ANIMALS_SESSION_RUN_START: "animals.session.run.start",
  ANIMALS_SESSION_RUN_FINISH: "animals.session.run.finish",
  ANIMALS_FAVORITE_SAVED: "animals.favorite.saved",
  ANIMALS_PLAN_SAVED: "animals.plan.saved",
  ANIMALS_PLAN_FROM_RECIPES: "animals.plan.fromRecipes",
  // cross-domain nudges
  MEALS_NEEDS_UPDATE: "meals.needs.update",
  INVENTORY_RESERVE_SUGGEST: "inventory.reserve.suggest",
  CLEANING_SESSION_SUGGEST: "cleaning.session.suggest",
  CALENDAR_SUGGEST_ADD: "calendar.suggest.add",
};
(async () => {
  const cat = await safeImport(
    "@/features/scan-compare-trust/automation/events.catalog.js"
  );
  if (cat?.EVENTS) EVT = { ...EVT, ...cat.EVENTS };
})();

const isBrowser = typeof window !== "undefined";
const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const nowIso = () => new Date().toISOString();

/* ------------------------------- event wiring ------------------------------- */
const emitGlobal = (type, detail = {}) => {
  try {
    if (isBrowser) {
      window.dispatchEvent(new CustomEvent(type, { detail }));
      const bus = window.__suka?.eventBus;
      if (bus?.emit) bus.emit(type, detail);
    }
  } catch (err) {
    console.warn("[AnimalSessionEngine] emitGlobal warn:", err);
  }
};

/* ------------------------------ tiny utilities ------------------------------ */
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const minutes = (n) => n * 60 * 1000;

function humanList(items, conj = "and") {
  const a = (items || []).filter(Boolean);
  if (a.length <= 1) return a[0] ?? "";
  if (a.length === 2) return `${a[0]} ${conj} ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, ${conj} ${a.at(-1)}`;
}

/* -------------------------- lightweight knowledge -------------------------- */
/** Minimal breed library (extend in /data later) */
const BREED_LIBRARY = {
  chicken: {
    dualPurpose: ["Rhode Island Red", "Plymouth Rock", "Orpington"],
    meat: ["Cornish Cross", "Red Ranger"],
    egg: ["Leghorn", "Australorp"],
  },
  goat: {
    dairy: ["Saanen", "Nubian", "Alpine"],
    meat: ["Boer", "Kiko"],
  },
  sheep: {
    meat: ["Dorper", "Katahdin", "Suffolk"],
    wool: ["Merino", "Romney"],
    dualPurpose: ["Finnsheep"],
  },
  cattle: {
    beef: ["Angus", "Hereford", "Charolais"],
    dualPurpose: ["Dexter"],
    dairy: ["Jersey", "Holstein"],
  },
};

/** Zone-to-bucket mapping (very coarse starter heuristic) */
function zoneBucket(zone = 7) {
  const z = Number(zone);
  if (z <= 4) return "cold";
  if (z >= 9) return "hot";
  return "temperate";
}

/** Suggest breeds based on species, climate bucket, and goal */
function suggestBreeds({ species, goal = "dualPurpose", zone = 7 }) {
  const lib = BREED_LIBRARY[species] || {};
  const bucket = zoneBucket(zone);
  let picks = lib[goal] || Object.values(lib).flat();
  if (!picks?.length) return [];
  if (bucket === "cold") {
    picks = picks
      .filter((b) =>
        /orping|rock|austral|romney|merino|hereford|dexter|alpine|saanen/i.test(b)
      )
      .concat(picks)
      .slice(0, 6);
  } else if (bucket === "hot") {
    picks = picks
      .filter((b) =>
        /leghorn|nubian|boer|katahdin|dorper|kiko|charolais/i.test(b)
      )
      .concat(picks)
      .slice(0, 6);
  } else {
    picks = picks.slice(0, 6);
  }
  return Array.from(new Set(picks));
}

/** Very rough meat yield estimates (customize later or wire to YieldService) */
function estimateMeatYield({ species, liveWeightLbs = 0, headcount = 1 }) {
  const tables = {
    cattle: { dress: 0.62, retail: 0.65 },
    sheep: { dress: 0.50, retail: 0.70 },
    goat: { dress: 0.50, retail: 0.65 },
    chicken: { dress: 0.72, retail: 0.80 },
  };
  const t = tables[species] ?? { dress: 0.6, retail: 0.66 };
  const carcass = liveWeightLbs * t.dress;
  const retail = carcass * t.retail;
  return {
    carcassWeightLbs: carcass * headcount,
    retailYieldLbs: retail * headcount,
    assumptions: t,
  };
}

/** Map recipe product types to required animal outputs */
function inferAnimalNeedsFromRecipes(recipes = []) {
  const need = {
    eggsDozen: 0,
    milkGallons: 0,
    chickenCount: 0,
    beefLbs: 0,
    lambLbs: 0,
    goatLbs: 0,
  };
  for (const r of recipes) {
    const ingredients = (r?.ingredients || []).map((x) => String(x).toLowerCase());
    const str = ingredients.join(" | ");
    if (/(^|[^a-z])egg(s)?($|[^a-z])/.test(str)) need.eggsDozen += 1;
    if (/milk/.test(str)) need.milkGallons += 0.5;
    if (/cheese|yogurt|kefir/.test(str)) need.milkGallons += 0.25;
    if (/chicken/.test(str)) need.chickenCount += 0.25; // 1 chicken ≈ 4 portions
    if (/\bbeef|\bsteak|\bground beef|\broast\b/.test(str)) need.beefLbs += 2;
    if (/\blamb\b/.test(str)) need.lambLbs += 1.5;
    if (/\bgoat\b/.test(str)) need.goatLbs += 1.5;
  }
  need.eggsDozen = Math.ceil(need.eggsDozen);
  need.milkGallons = Math.ceil(need.milkGallons * 10) / 10;
  need.chickenCount = Math.ceil(need.chickenCount);
  need.beefLbs = Math.ceil(need.beefLbs);
  need.lambLbs = Math.ceil(need.lambLbs);
  need.goatLbs = Math.ceil(need.goatLbs);
  return need;
}

/* ------------------------------ default config ----------------------------- */
const DEFAULTS = {
  domain: "animals",
  sessionTitle: "Animal Care",
  quietHours: { start: 21, end: 6 }, // 9pm–6am local
  sabbathGuard: true,
  defaultDurationMin: 60,
  consolidation: true,
  nbaHints: true,
  // default recurrence templates (UX helpers)
  recurrencePresets: {
    DAILY_MORNING: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0;BYSECOND=0",
    DAILY_EVENING: "FREQ=DAILY;BYHOUR=18;BYMINUTE=0;BYSECOND=0",
    WEEKLY_MON_WED_FRI: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=7;BYMINUTE=0;BYSECOND=0",
  },
};

/* ------------------------------ main engine -------------------------------- */
export default class AnimalSessionEngine extends EventEmitter {
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
      console.warn("[AnimalSessionEngine] Dexie stores missing or not bound.", err);
    }

    this.emit("ready");
    emitGlobal(EVT.ANIMALS_ENGINE_READY, { at: nowIso() });
  }

  /* ------------------------------------------------------------------------ */
  /* Session building                                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * buildDraftSession
   * @param {Object} input
   *  - date: ISO string (optional; defaults to now)
   *  - recurring: { rrule?: string } (optional)
   *  - zone: USDA zone or temp bucket number
   *  - location: { lat, lon } optional
   *  - animals: array of { id?, species, count, ageClass?, housing?, tags?[] }
   *  - goals: { meat?, eggs?, milk?, breeding? }
   *  - fromRecipes: array of recipe objects to infer animal needs (reverse)
   *  - notes: string
   */
  async buildDraftSession(input = {}) {
    const id = genId();
    const startedAt = nowIso();
    const {
      date = startedAt,
      recurring = null,
      zone = 7,
      location = null,
      animals = [],
      goals = {},
      fromRecipes = [],
      notes = "",
    } = input;

    const tasks = [];

    // Reverse direction: infer needs from recipes and add planning tasks
    const inferred = inferAnimalNeedsFromRecipes(fromRecipes);

    // Baseline routine tasks per species
    for (const a of animals) {
      const species = a.species?.toLowerCase();
      if (!species) continue;

      // feeding & watering
      tasks.push(
        this._task({
          species,
          type: "feeding",
          title: `Feed ${species}${a.count ? ` (${a.count})` : ""}`,
          locationHint: a.housing,
          estMinutes: clamp((a.count || 10) * 0.8, 5, 45),
        }),
        this._task({
          species,
          type: "watering",
          title: `Water ${species}${a.count ? ` (${a.count})` : ""}`,
          locationHint: a.housing,
          estMinutes: clamp((a.count || 10) * 0.5, 3, 30),
        })
      );

      // housing cleanup cadence (light daily)
      tasks.push(
        this._task({
          species,
          type: "bedding-spot",
          title: `Spot clean bedding (${species})`,
          locationHint: a.housing,
          estMinutes: clamp((a.count || 10) * 0.4, 5, 25),
        })
      );

      // egg collection if chickens/ducks (extensible)
      if (/(chicken|duck)/.test(species)) {
        tasks.push(
          this._task({
            species,
            type: "collection-eggs",
            title: `Collect eggs (${species})`,
            locationHint: a.housing,
            estMinutes: clamp((a.count || 12) * 0.25, 3, 18),
          })
        );
      }

      // health/breeding periodic placeholders (SessionRunner can expand by calendar)
      if (a.tags?.includes("breeding") || goals?.breeding) {
        tasks.push(
          this._task({
            species,
            type: "breeding-check",
            title: `Breeding status check (${species})`,
            locationHint: a.housing,
            estMinutes: 8,
          })
        );
      }
    }

    // Recipe-driven planning add-ons
    if (fromRecipes?.length) {
      const recipeHints = [];
      if (inferred.eggsDozen) {
        recipeHints.push(`${inferred.eggsDozen} dozen eggs`);
        tasks.push(
          this._task({
            species: "chicken",
            type: "capacity-check",
            title: `Verify laying capacity for ${inferred.eggsDozen} dozen eggs`,
            estMinutes: 6,
          })
        );
      }
      if (inferred.milkGallons) {
        recipeHints.push(`${inferred.milkGallons} gal milk`);
        tasks.push(
          this._task({
            species: "goat",
            type: "milk-plan",
            title: `Confirm milk plan (~${inferred.milkGallons} gal)`,
            estMinutes: 6,
          })
        );
      }
      if (inferred.chickenCount) {
        recipeHints.push(`${inferred.chickenCount} chickens`);
        tasks.push(
          this._task({
            species: "chicken",
            type: "processing-plan",
            title: `Processing plan for ${inferred.chickenCount} chicken(s)`,
            estMinutes: clamp(inferred.chickenCount * 10, 10, 120),
          })
        );
      }
      if (inferred.beefLbs) {
        recipeHints.push(`${inferred.beefLbs} lbs beef`);
        tasks.push(
          this._task({
            species: "cattle",
            type: "butchery-plan",
            title: `Beef cut availability check (~${inferred.beefLbs} lbs)`,
            estMinutes: 8,
          })
        );
      }
      if (inferred.lambLbs) {
        recipeHints.push(`${inferred.lambLbs} lbs lamb`);
        tasks.push(
          this._task({
            species: "sheep",
            type: "butchery-plan",
            title: `Lamb cut availability check (~${inferred.lambLbs} lbs)`,
            estMinutes: 8,
          })
        );
      }
      if (inferred.goatLbs) {
        recipeHints.push(`${inferred.goatLbs} lbs goat`);
        tasks.push(
          this._task({
            species: "goat",
            type: "butchery-plan",
            title: `Goat cut availability check (~${inferred.goatLbs} lbs)`,
            estMinutes: 8,
          })
        );
      }

      if (recipeHints.length) {
        tasks.unshift(
          this._task({
            species: "mixed",
            type: "recipe-alignment",
            title: `Align animal outputs with recipes: ${humanList(recipeHints)}`,
            estMinutes: clamp(recipeHints.length * 3, 5, 25),
            priority: "high",
          })
        );
      }
    }

    // Consolidate similar tasks and stamp per-task date + sequence
    const consolidated = this.opts.consolidation ? this.consolidateTasks(tasks) : tasks;
    const stamped = this._stampTaskSchedule(consolidated, date);

    const session = {
      id,
      domain: this.opts.domain,
      title: this.opts.sessionTitle,
      status: "draft",
      createdAt: startedAt,
      scheduledFor: date,
      recurring, // { rrule?: "FREQ=WEEKLY;BYDAY=MO" } or null
      animals,
      goals,
      zone,
      location,
      notes,
      tasks: stamped,
      estMinutes: stamped.reduce((a, t) => a + (t.estMinutes || 0), 0),
      meta: {
        version: 2,
        fromRecipesCount: fromRecipes?.length || 0,
      },
    };

    this.emit("draft", session);
    emitGlobal(EVT.ANIMALS_SESSION_DRAFT, { session });

    // cross-domain orchestration nudges
    this._emitCrossDomainHints({ session, inferred, fromRecipes });

    return session;
  }

  /**
   * consolidateTasks
   * Group tasks by (locationHint, type, species) and merge time
   */
  consolidateTasks(tasks = []) {
    const key = (t) => [t.locationHint || "yard", t.type, t.species || "mixed"].join("|");
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
    const parts = Array.from(
      new Set(
        [a, b]
          .join(" | ")
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
    const merged = parts.slice(0, 3).join(" | ");
    return merged.length > 120 ? `${merged.slice(0, 117)}...` : merged;
  }

  _task({
    species = "mixed",
    type = "general",
    title = "Task",
    estMinutes = 5,
    locationHint = null,
    priority = "normal",
  }) {
    return {
      id: genId(),
      species,
      type,
      title,
      estMinutes,
      locationHint,
      priority,
      done: false,
      scheduledFor: null, // set later
      sequence: null, // set later
    };
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

  /**
   * guardSession
   * Applies Sabbath/quiet-hours/weather/inventory guards if available.
   * Returns { ok, reasons[] }
   */
  async guardSession(session) {
    const reasons = [];
    let ok = true;

    // quiet hours
    if (this.opts.quietHours) {
      const date = new Date(session.scheduledFor || Date.now());
      const h = date.getHours();
      const { start, end } = this.opts.quietHours;
      const isQuiet = start > end ? h >= start || h < end : h >= start && h < end;
      if (isQuiet) {
        ok = false;
        reasons.push("quiet-hours");
      }
    }

    // sabbath guard (if service present)
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

    // weather guard (if service present & session outdoors)
    if (this.ctx.Guards?.isInclementWeather && session.tasks?.length) {
      try {
        const outdoorish = session.tasks.some((t) =>
          /(watering|bedding|clean|collection|feeding|breeding)/.test(t.type)
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

  /**
   * scheduleSession
   * Writes a one-time or recurring job to the local automation runtime.
   * Returns the automation job id (if available) and persisted session id.
   */
  async scheduleSession(session, { writeToCalendar = false } = {}) {
    // Ensure per-task dates exist & recalc estMinutes after any external edits
    const draft =
      (session?.tasks?.length && session.tasks[0]?.scheduledFor)
        ? { ...session }
        : { ...session, tasks: this._stampTaskSchedule(session.tasks || [], session.scheduledFor) };
    draft.estMinutes = (draft.tasks || []).reduce((a, t) => a + (t.estMinutes || 0), 0);

    // Persist draft → scheduled
    const persisted = await this._persistSession({ ...draft, status: "scheduled" });

    // Guards
    const guard = await this.guardSession(persisted);
    if (!guard.ok) {
      this.emit("guard.blocked", { session: persisted, reasons: guard.reasons });
      emitGlobal(EVT.ANIMALS_SESSION_BLOCKED, { session: persisted, reasons: guard.reasons });
      return { session: persisted, jobId: null, blocked: true, reasons: guard.reasons };
    }

    // Automation runtime
    let jobId = null;
    if (this.ctx.Automation?.createJob) {
      try {
        const runPrompt = {
          type: "animals.session.run",
          sessionId: persisted.id,
          title: persisted.title,
          domain: persisted.domain,
        };

        if (persisted.recurring?.rrule) {
          jobId = await this.ctx.Automation.createJob({
            title: `Animals • ${persisted.title}`,
            prompt: runPrompt,
            schedule: {
              rrule: persisted.recurring.rrule,
              tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          });
        } else {
          jobId = await this.ctx.Automation.createJob({
            title: `Animals • ${persisted.title}`,
            prompt: runPrompt,
            startsAt: persisted.scheduledFor,
          });
        }
      } catch (err) {
        console.warn("[AnimalSessionEngine] automation createJob failed:", err);
      }
    }

    // Optional calendar write
    if (writeToCalendar && this.ctx.CalendarWriter?.createEvent) {
      try {
        await this.ctx.CalendarWriter.createEvent({
          title: `Animals: ${persisted.title}`,
          start: persisted.scheduledFor,
          durationMin: Math.max(15, persisted.estMinutes || 60),
          notes: this.toSpeechBrief(persisted),
          tags: ["animals", "session"],
        });
        emitGlobal(EVT.CALENDAR_SUGGEST_ADD, {
          title: `Animals: ${persisted.title}`,
          at: persisted.scheduledFor,
        });
      } catch (err) {
        console.warn("[AnimalSessionEngine] calendar write failed:", err);
      }
    }

    this.emit("scheduled", { session: persisted, jobId });
    emitGlobal(EVT.ANIMALS_SESSION_SCHEDULED, { session: persisted, jobId });

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
      userOwned: true, // ensure user-owned favorites are distinct from "system"
    };
    if (db?.favorites?.put) await db.favorites.put(fav);
    this.emit("favorite.saved", fav);
    emitGlobal(EVT.ANIMALS_FAVORITE_SAVED, { favorite: fav });
    return fav;
  }

  async savePlanTemplate(plan, label = "") {
    const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
    const doc = {
      id: genId(),
      type: "plan-template",
      domain: this.opts.domain,
      createdAt: nowIso(),
      label: label || plan?.title || "Animal Plan",
      payload: plan,
      userOwned: true,
    };
    if (db?.plans?.put) await db.plans.put(doc);
    this.emit("plan.saved", doc);
    emitGlobal(EVT.ANIMALS_PLAN_SAVED, { plan: doc });
    return doc;
  }

  /* ------------------------------------------------------------------------ */
  /* Breed suggestions + Meat estimates                                       */
  /* ------------------------------------------------------------------------ */

  suggestBreedsForLocation({ species, goal = "dualPurpose", zone = 7 }) {
    return suggestBreeds({ species, goal, zone });
  }

  estimateMeat({ species, liveWeightLbs = 0, headcount = 1 }) {
    return estimateMeatYield({ species, liveWeightLbs, headcount });
  }

  /* ------------------------------------------------------------------------ */
  /* Reverse: Generate Animal Plan from Recipes                               */
  /* ------------------------------------------------------------------------ */

  /**
   * generateFromRecipes
   * Returns a lightweight "plan" object with actionable tasks derived from recipes.
   */
  async generateFromRecipes(recipes = [], { zone = 7 } = {}) {
    const inferred = inferAnimalNeedsFromRecipes(recipes);
    const tasks = [];

    if (inferred.eggsDozen)
      tasks.push(
        this._task({
          species: "chicken",
          type: "capacity-check",
          title: `Ensure laying capacity for ${inferred.eggsDozen} dozen eggs`,
          estMinutes: 6,
        })
      );

    if (inferred.milkGallons)
      tasks.push(
        this._task({
          species: "goat",
          type: "milk-plan",
          title: `Stage milk production for ~${inferred.milkGallons} gal`,
          estMinutes: 6,
        })
      );

    if (inferred.chickenCount)
      tasks.push(
        this._task({
          species: "chicken",
          type: "processing-plan",
          title: `Plan processing for ${inferred.chickenCount} chicken(s)`,
          estMinutes: clamp(inferred.chickenCount * 10, 10, 120),
        })
      );

    if (inferred.beefLbs)
      tasks.push(
        this._task({
          species: "cattle",
          type: "butchery-plan",
          title: `Confirm beef cuts for ~${inferred.beefLbs} lbs`,
          estMinutes: 8,
        })
      );

    if (inferred.lambLbs)
      tasks.push(
        this._task({
          species: "sheep",
          type: "butchery-plan",
          title: `Confirm lamb cuts for ~${inferred.lambLbs} lbs`,
          estMinutes: 8,
        })
      );

    if (inferred.goatLbs)
      tasks.push(
        this._task({
          species: "goat",
          type: "butchery-plan",
          title: `Confirm goat cuts for ~${inferred.goatLbs} lbs`,
          estMinutes: 8,
        })
      );

    const plan = {
      id: genId(),
      domain: this.opts.domain,
      title: "Animal Plan from Recipes",
      createdAt: nowIso(),
      zone,
      tasks,
      meta: { recipes: recipes.length, inferred },
    };

    this.emit("plan.generated.fromRecipes", plan);
    emitGlobal(EVT.ANIMALS_PLAN_FROM_RECIPES, { plan });

    // nudges for other domains
    emitGlobal(EVT.MEALS_NEEDS_UPDATE, { inferred, source: "animals.generateFromRecipes" });
    if (inferred.beefLbs || inferred.lambLbs || inferred.goatLbs || inferred.chickenCount) {
      emitGlobal(EVT.INVENTORY_RESERVE_SUGGEST, { inferred, domain: "animals" });
    }

    return plan;
  }

  /* ------------------------------------------------------------------------ */
  /* Voice + NBA                                                              */
  /* ------------------------------------------------------------------------ */

  toSpeechBrief(session) {
    const species = Array.from(new Set(session.tasks?.map((t) => t.species))).filter(Boolean);
    const majors = session.tasks
      ?.sort((a, b) => (b.estMinutes || 0) - (a.estMinutes || 0))
      ?.slice(0, 3)
      ?.map((t) => t.title);

    return [
      `${session.title} scheduled.`,
      species.length ? `Species: ${humanList(species)}.` : "",
      majors?.length ? `Top tasks: ${humanList(majors)}.` : "",
      `Total time about ${Math.round((session.estMinutes || 60) / 5) * 5} minutes.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  nextBestAction(session) {
    const hasProcessing = session.tasks?.some((t) => /processing|butchery/.test(t.type));
    if (hasProcessing) {
      return {
        label: "Stage sanitize & chilling setup",
        actions: [
          "Sanitize knives, cones, tables",
          "Prep ice & chill water",
          "Set up waste/feather collection",
        ],
      };
    }
    return {
      label: "Stage feed & water",
      actions: ["Fill buckets", "Prime hoses", "Prep mineral mix"],
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Session run hooks (hand-off to a runner if present)                      */
  /* ------------------------------------------------------------------------ */

  async runSession(sessionId) {
    const Runner = await safeImport("@/services/session/SessionRunner");
    if (Runner?.run) {
      return Runner.run({ domain: this.opts.domain, sessionId });
    }
    // Fallback: emit start/finish with simple delay to simulate progress
    this.emit("run.start", { sessionId });
    emitGlobal(EVT.ANIMALS_SESSION_RUN_START, { sessionId });

    await new Promise((r) => setTimeout(r, minutes(0.2))); // ~12s sim
    this.emit("run.finish", { sessionId });
    emitGlobal(EVT.ANIMALS_SESSION_RUN_FINISH, { sessionId });
    return { ok: true };
  }

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                  */
  /* ------------------------------------------------------------------------ */

  buildRecurring(presetKey) {
    const rrule = this.opts.recurrencePresets?.[presetKey];
    return rrule ? { rrule } : null;
  }

  _emitCrossDomainHints({ session, inferred, fromRecipes }) {
    // suggest a quick corral clean when feeding/watering present
    const hasCleaningAdjacency = session.tasks?.some((t) =>
      /(feeding|watering|bedding)/.test(t.type)
    );
    if (hasCleaningAdjacency) {
      emitGlobal(EVT.CLEANING_SESSION_SUGGEST, {
        domain: "cleaning",
        reason: "Animal session adjacency",
        suggestedTasks: ["Sweep corridor", "Disinfect buckets", "Rake run"],
        scheduledFor: session.scheduledFor,
      });
    }

    // Notify meals/inventory if recipes drove this session
    if (fromRecipes?.length) {
      emitGlobal(EVT.MEALS_NEEDS_UPDATE, {
        inferred,
        source: "animals.session.buildDraftSession",
        recipesCount: fromRecipes.length,
      });
      emitGlobal(EVT.INVENTORY_RESERVE_SUGGEST, {
        inferred,
        source: "animals.session.buildDraftSession",
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Example usage (keep commented in file for discoverability)                 */
/* -------------------------------------------------------------------------- */
/*
const engine = new AnimalSessionEngine();

// 1) Draft
const draft = await engine.buildDraftSession({
  date: new Date().toISOString(),
  zone: 8,
  animals: [
    { species: "chicken", count: 24, housing: "Layer Coop A", tags: ["breeding"] },
    { species: "goat", count: 6, housing: "Goat Barn 1" },
  ],
  goals: { eggs: true, milk: true },
  fromRecipes: [
    { title: "French Toast", ingredients: ["eggs", "milk", "bread"] },
    { title: "Lamb Stew", ingredients: ["lamb", "potatoes", "carrots"] },
  ],
});

// 2) Schedule (one-time)
const result = await engine.scheduleSession(draft, { writeToCalendar: true });

// 3) Favorite (user-owned)
await engine.saveAsFavoriteSession(result.session, "Morning Animal Routine");

// 4) Recurring (preset)
const recurring = engine.buildRecurring("DAILY_MORNING");

// 5) Suggest breeds
engine.suggestBreedsForLocation({ species: "chicken", goal: "dualPurpose", zone: 8 });

// 6) Estimate meat
engine.estimateMeat({ species: "sheep", liveWeightLbs: 110, headcount: 3 });

// 7) Reverse: plan from recipes
await engine.generateFromRecipes([{ title: "Cheesecake", ingredients: ["eggs", "milk", "cheese"] }]);
*/
