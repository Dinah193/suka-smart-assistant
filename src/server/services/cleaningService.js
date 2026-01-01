// C:\Users\larho\suka-smart-assistant\src\server\services\cleaningService.js
//
// Suka Smart Assistant — Cleaning Service
//
// Provider-agnostic helpers used by /api/cleaning routes, agents, and n8n workflows.
// - Local JSON persistence (always available; great for dev/offline)
// - Optional calendar scheduling via calendarService (Google/MS Graph supported there)
//
// Exports (summary):
//   - generateRoutine(input)                      -> routine (not yet saved)
//   - estimateEffort(routine)                     -> { minutesTotal, kcalEstimate, sessions }
//   - getHomemadeCleanerRecipes()                 -> recipe catalog for supply UI
//   - suggestSupplies(routine)                    -> consolidated shopping & DIY list
//   - saveRoutine(routine, meta)                  -> { id, ...routine }
//   - getRoutine(id)                              -> routine
//   - listRoutines()                              -> [routines]
//   - deleteRoutine(id)                           -> void
//   - createDeepCleanSession(input)               -> session (persisted)
//   - updateSessionProgress(sessionId, updates)   -> session
//   - listDeepCleanSessions()                     -> [sessions]
//   - scheduleRoutineOnCalendar(opts)             -> events[] (using calendarService)
//   - buildN8nPayload(routineOrSession, opts)     -> compact payload for automations
//
// Notes & assumptions pulled from project chats:
//   • Onboarding requires minimal inputs (room counts, occupants); system infers cadence & minutes.
//   • Hebrew Day 7 (Sabbath) is default “skip” for scheduling; users can choose Saturday instead.
//   • Deep Clean Sessions are timeboxed, timer-friendly (integrates with DeepCleanSession.jsx).
//   • Visible draft structure returned for UI preview & editing before saving.
//   • Supply suggestions prefer homemade cleaners (Tier 2) with fallback to store-bought.
//
// -----------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// Optional calendar bridge (kept lazy-required to avoid circular deps in tests)
let calendarService = null;
async function getCalendarService() {
  if (!calendarService) {
    // Path relative to current file; adjust if your structure differs
    const mod = await import("./calendarService.js").catch(() => null);
    calendarService = mod ? mod.default || mod : null;
  }
  return calendarService;
}

// ---------- Local JSON store -------------------------------------------------

const DATA_DIR = path.resolve(process.cwd(), "data", "cleaning");
const ROUTINES_FILE = path.join(DATA_DIR, "routines.json");
const SESSIONS_FILE = path.join(DATA_DIR, "deepCleanSessions.json");

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const f of [ROUTINES_FILE, SESSIONS_FILE]) {
    try {
      await fs.access(f);
    } catch {
      await fs.writeFile(f, JSON.stringify([], null, 2), "utf-8");
    }
  }
}

async function readJson(file) {
  await ensureStore();
  const raw = await fs.readFile(file, "utf-8");
  return JSON.parse(raw || "[]");
}

async function writeJson(file, data) {
  await ensureStore();
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

// ---------- Domain constants -------------------------------------------------

const DEFAULT_CADENCE = {
  daily: ["Dishes", "Counters & Sinks", "Tidy Surfaces", "Spot Sweep"],
  weekly: ["Vacuum/Mop Floors", "Dust", "Bathroom Reset", "Bedding Change"],
  monthly: ["Baseboards", "Vents", "Windows (room rotation)", "Fridge Cleanout"],
  seasonal: ["Oven Deep Clean", "Curtains/Blinds", "Pantry Audit", "Garage/Entry"],
};

const DEFAULT_ROOM_TEMPLATES = {
  kitchen: {
    daily: ["Dishes", "Counters & Sinks", "Stovetop Wipe", "Spot Sweep"],
    weekly: ["Mop", "Appliance Face Wipe", "Microfiber Fridge & Stainless"],
    monthly: ["Fridge Shelves", "Backsplash Detail", "Cabinet Faces (zones)"],
    seasonal: ["Oven Deep Clean", "Range Hood Filter", "Pantry Audit"],
    minutesPerPass: { daily: 15, weekly: 30, monthly: 40, seasonal: 60 },
    supplies: ["allPurpose", "degreaser", "glass", "microfiber", "bakingSoda"],
  },
  bathroom: {
    daily: ["Sink & Mirror", "Toilet Quick", "Shower Squeegee", "Spot Mop"],
    weekly: ["Full Toilet", "Tub/Shower Scrub", "Floor Mop", "Trash"],
    monthly: ["Grout Refresh", "Cabinet Wipe", "Vent Dust"],
    seasonal: ["Showerhead Descale", "Curtain/Liner Wash", "Caulk Check"],
    minutesPerPass: { daily: 10, weekly: 25, monthly: 35, seasonal: 45 },
    supplies: ["bathCleaner", "glass", "bleachAlt", "microfiber"],
  },
  bedroom: {
    daily: ["Tidy Surfaces", "Clothes to Hamper", "Quick Dust High-Touch"],
    weekly: ["Vacuum/Mop", "Bedding Change", "Dust"],
    monthly: ["Under Bed", "Window Wipe", "Closet Tidy"],
    seasonal: ["Mattress Rotate", "Curtains", "Declutter Pass"],
    minutesPerPass: { daily: 5, weekly: 20, monthly: 25, seasonal: 30 },
    supplies: ["allPurpose", "glass", "microfiber"],
  },
  living: {
    daily: ["Tidy Surfaces", "Couch Cushions Fluff", "Spot Sweep"],
    weekly: ["Vacuum/Mop", "Dust Media/TV", "Trash"],
    monthly: ["Window Wipe", "Baseboards", "Lamp Shades"],
    seasonal: ["Curtains", "Furniture Move & Vacuum", "Bookshelf Declutter"],
    minutesPerPass: { daily: 7, weekly: 20, monthly: 25, seasonal: 35 },
    supplies: ["allPurpose", "glass", "dustingSpray", "microfiber"],
  },
  laundry: {
    daily: ["Load/Rotate (if needed)", "Surface Tidy"],
    weekly: ["Lint Trap Deep", "Wipe Tops", "Floor Mop"],
    monthly: ["Washer Gasket Clean", "Drain Filter", "Hoses Check"],
    seasonal: ["Dryer Vent", "Supply Audit (detergent, vinegar, borax)"],
    minutesPerPass: { daily: 5, weekly: 15, monthly: 20, seasonal: 30 },
    supplies: ["allPurpose", "descaler", "microfiber"],
  },
  entry: {
    daily: ["Shoes/Coats Tidy", "Spot Sweep"],
    weekly: ["Mop", "Dust Surfaces"],
    monthly: ["Door/Handle Detail", "Baseboards"],
    seasonal: ["Declutter Hooks/Bins", "Mat/Catchall Deep"],
    minutesPerPass: { daily: 3, weekly: 10, monthly: 12, seasonal: 15 },
    supplies: ["allPurpose", "microfiber"],
  },
};

const SUPPLY_RECIPES = {
  allPurpose: {
    name: "All-Purpose Cleaner (DIY)",
    diy: true,
    recipe: [
      "2 cups water",
      "1/2 cup white vinegar",
      "1 tsp castile soap",
      "Optional: 10–15 drops essential oil",
    ],
  },
  degreaser: {
    name: "Kitchen Degreaser (DIY)",
    diy: true,
    recipe: ["1 cup warm water", "1 tbsp baking soda", "1 tsp castile soap"],
  },
  glass: {
    name: "Glass & Mirror Spray (DIY)",
    diy: true,
    recipe: ["1 cup water", "1 cup white vinegar"],
  },
  bleachAlt: {
    name: "Bleach Alternative (DIY)",
    diy: true,
    recipe: ["1 cup water", "1/2 cup hydrogen peroxide (3%)", "1 tbsp lemon juice"],
  },
  dustingSpray: {
    name: "Dusting Spray (DIY)",
    diy: true,
    recipe: ["1 cup water", "1/4 cup white vinegar", "2 tbsp olive oil"],
  },
  descaler: {
    name: "Mineral Descaler (DIY)",
    diy: true,
    recipe: ["Equal parts white vinegar & water; soak or spray, then rinse"],
  },
  microfiber: { name: "Microfiber Cloths", diy: false },
  bakingSoda: { name: "Baking Soda", diy: false },
  bathCleaner: { name: "Bathroom Cleaner (DIY)", diy: true, recipe: ["1 cup water", "2 tbsp castile soap", "1 tbsp baking soda"] },
};

// ---------- Utility helpers --------------------------------------------------

function uid() {
  return crypto.randomUUID();
}

function todayISO() {
  return new Date().toISOString();
}

function coalesce(a, b) {
  return typeof a === "undefined" ? b : a;
}

function hebrewDayIsSabbathSkip(isoDate, opts) {
  // Default behavior per project chats: skip Hebrew Day 7 by default.
  // This simple stub uses Gregorian Saturday unless you wire in your Hebrew calendar core.
  // If users select Saturday instead, same outcome in most locales.
  const defaultSkip = coalesce(opts?.skipSabbath, true);
  const useSaturday = coalesce(opts?.sabbathIsSaturday, false);
  if (!defaultSkip) return false;

  const d = new Date(isoDate);
  const day = d.getUTCDay(); // 0=Sun ... 6=Sat
  // If we don't have the Hebrew day integration here, Saturday ~= Sabbath for scheduling skip.
  return useSaturday ? day === 6 : day === 6; // placeholder until Hebrew day injected
}

function minutesForRoom(roomKey, cadenceKey) {
  const tpl = DEFAULT_ROOM_TEMPLATES[roomKey];
  return tpl?.minutesPerPass?.[cadenceKey] || 10;
}

function kcalFromMinutes(minutes, intensity = "moderate") {
  // Rough estimate for “house cleaning” kcal burned per minute.
  // Source-agnostic heuristic (adjust in UI if needed):
  const perMin = intensity === "light" ? 3 : intensity === "vigorous" ? 6 : 4.5;
  return Math.round(minutes * perMin);
}

// ---------- Core generation --------------------------------------------------

/**
 * generateRoutine
 * Low-input generator that converts counts & context into a full routine “visible draft”.
 */
export function generateRoutine(input) {
  const {
    homeName = "My Home",
    sqft = 1200,
    occupants = 2,
    pets = 0,
    rooms = {
      kitchen: 1,
      bathroom: 1,
      bedroom: 2,
      living: 1,
      laundry: 1,
      entry: 1,
    },
    preferences = {
      // Scheduling behavior
      startWeekday: "Mon", // Mon/Sun
      skipSabbath: true, // default true per chats
      sabbathIsSaturday: false, // Hebrew Day 7 ~= Saturday for default scheduling
      // Intuition / density
      weeklyFlooringSplit: ["kitchen", "bathroom", "living", "entry"],
      monthlyWindowRotation: ["bedroom", "living", "kitchen", "bathroom"],
      // Family participation & prompts
      showTimers: true,
      showVoiceCues: true,
    },
    notes = "",
  } = input || {};

  // Scale some frequencies by household complexity
  const trafficFactor = Math.min(1.6, 1 + (occupants - 1) * 0.12 + pets * 0.08);
  const sqFactor = Math.min(1.5, Math.max(0.8, sqft / 1500));

  const sections = [];

  Object.entries(rooms).forEach(([roomKey, count]) => {
    if (!DEFAULT_ROOM_TEMPLATES[roomKey] || count <= 0) return;

    const tpl = DEFAULT_ROOM_TEMPLATES[roomKey];
    const roomName = roomKey[0].toUpperCase() + roomKey.slice(1);

    // Build tasks per cadence bucket
    const cadences = ["daily", "weekly", "monthly", "seasonal"];
    const cadenceSections = cadences.map((cKey) => {
      const baseTasks = tpl[cKey] || [];
      const scaledMinutes = Math.ceil(
        minutesForRoom(roomKey, cKey) * count * trafficFactor * sqFactor
      );

      return {
        cadence: cKey,
        tasks: baseTasks.map((t) => ({ title: t, estMinutes: Math.max(2, Math.round((scaledMinutes / baseTasks.length) || 2)) })),
        estMinutesTotal: scaledMinutes,
      };
    });

    sections.push({
      roomKey,
      roomName,
      count,
      supplies: (tpl.supplies || []).map((s) => SUPPLY_RECIPES[s]?.name || s),
      cadences: cadenceSections,
    });
  });

  const routine = {
    id: uid(),
    type: "CLEANING_ROUTINE",
    homeName,
    createdAt: todayISO(),
    updatedAt: todayISO(),
    meta: { sqft, occupants, pets, preferences, notes },
    sections,
    // Draft schedule suggestion (frontends may render this into week view)
    scheduleHints: {
      startWeekday: preferences.startWeekday,
      skipSabbath: preferences.skipSabbath,
      sabbathIsSaturday: preferences.sabbathIsSaturday,
      weeklyFlooringSplit: preferences.weeklyFlooringSplit,
      monthlyWindowRotation: preferences.monthlyWindowRotation,
    },
    // Frontend UX toggles
    ui: {
      showTimers: preferences.showTimers,
      showVoiceCues: preferences.showVoiceCues,
    },
  };

  // Attach an effort estimate up-front
  routine.estimates = estimateEffort(routine);
  return routine;
}

export function estimateEffort(routine) {
  const sessions = [];
  let minutesTotal = 0;

  routine.sections.forEach((sec) => {
    sec.cadences.forEach((c) => {
      minutesTotal += c.estMinutesTotal || 0;
      sessions.push({
        roomKey: sec.roomKey,
        cadence: c.cadence,
        estMinutes: c.estMinutesTotal || 0,
      });
    });
  });

  return {
    minutesTotal,
    kcalEstimate: kcalFromMinutes(minutesTotal, "moderate"),
    sessions,
  };
}

export function getHomemadeCleanerRecipes() {
  return Object.entries(SUPPLY_RECIPES).map(([key, val]) => ({
    key,
    ...val,
  }));
}

export function suggestSupplies(routine) {
  const aggregate = new Map(); // key -> { name, diy, recipe, count }

  routine.sections.forEach((sec) => {
    (sec.supplies || []).forEach((name) => {
      // Reverse-lookup by recipe name
      const match = Object.values(SUPPLY_RECIPES).find((r) => r.name === name);
      const key = match ? match.name : name;
      const prev = aggregate.get(key) || { name: key, diy: !!match?.diy, recipe: match?.recipe, count: 0 };
      prev.count += sec.count || 1;
      aggregate.set(key, prev);
    });
  });

  // Sort DIY first (since Tier 2 emphasizes homemade supplies)
  const list = Array.from(aggregate.values()).sort((a, b) => {
    if (a.diy && !b.diy) return -1;
    if (!a.diy && b.diy) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    supplies: list,
    recommendedContainers: [
      "16 oz spray bottles (glass preferred)",
      "1–2 gallon vinegar",
      "Bulk baking soda",
      "Castile soap",
      "Microfiber 12-pack",
      "Label set + marker",
    ],
  };
}

// ---------- Persistence (Local JSON) -----------------------------------------

export async function saveRoutine(routine, meta = {}) {
  const all = await readJson(ROUTINES_FILE);
  const id = routine.id || uid();
  const payload = {
    ...routine,
    id,
    updatedAt: todayISO(),
    savedMeta: meta,
  };
  const idx = all.findIndex((r) => r.id === id);
  if (idx >= 0) all[idx] = payload;
  else all.push(payload);
  await writeJson(ROUTINES_FILE, all);
  return payload;
}

export async function getRoutine(id) {
  const all = await readJson(ROUTINES_FILE);
  return all.find((r) => r.id === id) || null;
}

export async function listRoutines() {
  const all = await readJson(ROUTINES_FILE);
  // Sort by updated desc
  return all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function deleteRoutine(id) {
  const all = await readJson(ROUTINES_FILE);
  const next = all.filter((r) => r.id !== id);
  await writeJson(ROUTINES_FILE, next);
}

// ---------- Deep Clean Sessions ----------------------------------------------

/**
 * createDeepCleanSession
 * Timeboxed session intended for the DeepClean UI:
 * - Areas/Tasks are explicit and timer-friendly.
 * - Supports “assignToRole” placeholders (ties into WorkerSession flow on client).
 */
export async function createDeepCleanSession(input) {
  const {
    title = "Deep Clean Session",
    homeName = "My Home",
    targetAreas = [
      { roomKey: "kitchen", tasks: ["Oven Deep Clean", "Range Hood Filter"] },
      { roomKey: "bathroom", tasks: ["Grout Refresh", "Showerhead Descale"] },
    ],
    durationMinutes = 90,
    breakMinutes = 10,
    timersEnabled = true,
    assignToRole = null, // e.g., "Teen Helper", "Adult 1"
    notes = "",
  } = input || {};

  const session = {
    id: uid(),
    type: "DEEP_CLEAN_SESSION",
    title,
    homeName,
    createdAt: todayISO(),
    updatedAt: todayISO(),
    targetAreas,
    config: {
      durationMinutes,
      breakMinutes,
      timersEnabled,
      assignToRole,
    },
    progress: {
      startedAt: null,
      endedAt: null,
      tasksCompleted: [],
      lastEventAt: null,
    },
    notes,
  };

  const all = await readJson(SESSIONS_FILE);
  all.push(session);
  await writeJson(SESSIONS_FILE, all);
  return session;
}

export async function updateSessionProgress(sessionId, updates = {}) {
  const all = await readJson(SESSIONS_FILE);
  const idx = all.findIndex((s) => s.id === sessionId);
  if (idx < 0) throw new Error("Session not found");

  const now = todayISO();
  const prev = all[idx];
  const next = {
    ...prev,
    progress: {
      ...prev.progress,
      ...updates,
      lastEventAt: now,
    },
    updatedAt: now,
  };

  all[idx] = next;
  await writeJson(SESSIONS_FILE, all);
  return next;
}

export async function listDeepCleanSessions() {
  const all = await readJson(SESSIONS_FILE);
  return all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

// ---------- Calendar scheduling ----------------------------------------------

/**
 * scheduleRoutineOnCalendar
 * Maps a routine’s cadence buckets into calendar events.
 * - Skips the Sabbath by default (configurable).
 * - Creates lightweight recurring events (weekly/monthly) where possible.
 */
export async function scheduleRoutineOnCalendar(opts) {
  const {
    routineId,
    provider = "local", // "google" | "microsoft" | "local"
    calendarId = "primary",
    startDate = new Date().toISOString().slice(0, 10), // YYYY-MM-DD
    timezone = "America/New_York",
    skipSabbath = true,
    sabbathIsSaturday = false,
    eventTitlePrefix = "Clean •",
  } = opts || {};

  const routine = await getRoutine(routineId);
  if (!routine) throw new Error("Routine not found");

  const cal = await getCalendarService();
  if (!cal || !cal.createEventsBatch) {
    // Fallback: return a dry-run event list so the UI can show a preview.
    return buildCalendarEventsPreview(routine, {
      startDate,
      timezone,
      skipSabbath,
      sabbathIsSaturday,
      eventTitlePrefix,
    });
  }

  const events = buildCalendarEventsPreview(routine, {
    startDate,
    timezone,
    skipSabbath,
    sabbathIsSaturday,
    eventTitlePrefix,
  });

  // Actually create them via calendarService (batch)
  const created = await cal.createEventsBatch({
    provider,
    calendarId,
    events,
  });

  return created;
}

function buildCalendarEventsPreview(routine, cfg) {
  const {
    startDate,
    timezone,
    skipSabbath,
    sabbathIsSaturday,
    eventTitlePrefix,
  } = cfg;

  // Very lightweight recurrences and spreads.
  // For this preview, we generate rule-like hints; calendarService can interpret.
  const events = [];

  routine.sections.forEach((sec) => {
    sec.cadences.forEach((c) => {
      const title = `${eventTitlePrefix} ${sec.roomName} (${c.cadence})`;
      const durationMins = Math.max(15, Math.round((c.estMinutesTotal || 20) / 1.25));

      // Build a recurrence hint (interpreted downstream by calendarService)
      let rrule = null;
      if (c.cadence === "daily") rrule = { freq: "DAILY" };
      else if (c.cadence === "weekly") rrule = { freq: "WEEKLY" };
      else if (c.cadence === "monthly") rrule = { freq: "MONTHLY" };
      else if (c.cadence === "seasonal") rrule = { freq: "MONTHLY", interval: 3 };

      events.push({
        title,
        description: `Auto-generated by Suka • Home: ${routine.homeName}\nRoom: ${sec.roomName}\nCadence: ${c.cadence}`,
        start: startDate,
        durationMinutes: durationMins,
        timezone,
        recurrence: rrule,
        meta: {
          routineId: routine.id,
          roomKey: sec.roomKey,
          cadence: c.cadence,
          skipSabbath,
          sabbathIsSaturday,
        },
      });
    });
  });

  // Optionally filter events falling on Sabbath for the first occurrence
  const filtered = events.filter((ev) => {
    if (!ev.start || !ev.meta?.skipSabbath) return true;
    return !hebrewDayIsSabbathSkip(ev.start, {
      skipSabbath: ev.meta.skipSabbath,
      sabbathIsSaturday: ev.meta.sabbathIsSaturday,
    });
  });

  return filtered;
}

// ---------- n8n / automation payloads ----------------------------------------

export function buildN8nPayload(routineOrSession, opts = {}) {
  const base = {
    type: routineOrSession?.type || "UNKNOWN",
    id: routineOrSession?.id,
    homeName: routineOrSession?.homeName,
    title: routineOrSession?.title || routineOrSession?.meta?.title || null,
    createdAt: routineOrSession?.createdAt,
    updatedAt: routineOrSession?.updatedAt,
  };

  if (routineOrSession.type === "CLEANING_ROUTINE") {
    return {
      ...base,
      estimates: routineOrSession.estimates,
      scheduleHints: routineOrSession.scheduleHints,
      sections: routineOrSession.sections.map((s) => ({
        roomKey: s.roomKey,
        roomName: s.roomName,
        cadences: s.cadences.map((c) => ({
          cadence: c.cadence,
          estMinutesTotal: c.estMinutesTotal,
          tasks: c.tasks.map((t) => t.title),
        })),
      })),
      supplies: suggestSupplies(routineOrSession).supplies,
      options: opts,
    };
  }

  if (routineOrSession.type === "DEEP_CLEAN_SESSION") {
    return {
      ...base,
      config: routineOrSession.config,
      progress: routineOrSession.progress,
      targetAreas: routineOrSession.targetAreas,
      options: opts,
    };
  }

  return { ...base, options: opts };
}

// ---------- Default export (grouped API) -------------------------------------

const CleaningService = {
  generateRoutine,
  estimateEffort,
  getHomemadeCleanerRecipes,
  suggestSupplies,
  saveRoutine,
  getRoutine,
  listRoutines,
  deleteRoutine,
  createDeepCleanSession,
  updateSessionProgress,
  listDeepCleanSessions,
  scheduleRoutineOnCalendar,
  buildN8nPayload,
};

export default CleaningService;
