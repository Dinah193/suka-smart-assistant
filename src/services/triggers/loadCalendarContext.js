// C:\Users\larho\suka-smart-assistant\src\services\triggers\loadCalendarContext.js
//
// Loads relevant calendar data to provide context to planning and scheduling.
// - Merges events from Dexie workerSessions + optional calendar adapters
// - Past window (default: 7 days), future window (default: 14 days)
// - Sabbath-aware: returns next Sabbath start/end (avoid by default)
// - Optional feast/observance injection (Hebrew + interfaith if available)
// - Classifies events (cleaning, cooking, gardening, animal, general)
// - Computes conflicts and free blocks for quick planning
// - Global-ready: no US-only assumptions; respects user timezone & regional weekends
// - Optional dayTags map & fasting/feeding windows (if your Meal Rhythm is configured)

import DexieDB from "../../db";

/* ---------------------------------------
   Safe dynamic imports
----------------------------------------*/
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try { return await import(/* @vite-ignore */ p); } catch {}
  }
  return {};
}

/* ---------------------------------------
   Utils
----------------------------------------*/
const toDate = (x) => {
  if (!x) return null;
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d;
};

const iso = (d) => (d instanceof Date ? d.toISOString() : null);

function clampRange(start, end) {
  const s = toDate(start);
  const e = toDate(end);
  if (!s || !e) return null;
  if (e <= s) return null;
  return { start: s, end: e };
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function minutesBetween(a, b) {
  return Math.max(0, Math.round((b - a) / 60000));
}

function startOfDay(d, hour = 0) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
}

/* ---------------------------------------
   Regional weekend & quiet hours
   - Weekend pattern can vary (Sat-Sun, Fri-Sat, Sun only, etc.)
   - Quiet hours let us exclude late-night scheduling in free block calc
----------------------------------------*/
function resolveWeekendPattern(settings = {}) {
  // Options: 'SatSun' (default), 'FriSat', 'SunOnly', 'FriOnly', 'None'
  const pat = (settings?.calendar?.weekendPattern || "").toLowerCase();
  switch (pat) {
    case "frisat": return new Set([5, 6]); // Fri=5, Sat=6
    case "sunonly": return new Set([0]);
    case "frionly": return new Set([5]);
    case "none": return new Set([]);
    default: return new Set([6, 0]); // Sat & Sun
  }
}

function resolveQuietHours(settings = {}) {
  const q = settings?.calendar?.quietHours || {};
  const start = Number.isFinite(q.startHour) ? q.startHour : 22; // 22:00
  const end   = Number.isFinite(q.endHour)   ? q.endHour   : 7;  // 07:00
  return { startHour: start, endHour: end };
}

/* ---------------------------------------
   Sabbath helpers (Saturday avoidance by default)
   If you have precise sunset logic, we’ll try to use it.
----------------------------------------*/
async function computeSabbathWindow(now, settings) {
  const avoidSaturday = settings?.sabbath?.avoidSaturday !== false; // default true
  const sabbathOnSaturday = true; // project policy: treat Saturday as Sabbath for avoidance
  const locMod = await safeImportMany(["@/utils/timeUtils.js", "@/utils/timeUtils"]);
  const getSunset = locMod?.getSunset; // optional (date, coords?) => Date

  const base = new Date(now);
  // 0=Sun ... 5=Fri, 6=Sat
  const dow = base.getDay();
  const daysToFriday = (5 - dow + 7) % 7;
  const daysToSaturday = (6 - dow + 7) % 7;

  const friday = new Date(base.getFullYear(), base.getMonth(), base.getDate() + daysToFriday, 18, 0, 0, 0);
  const saturday = new Date(base.getFullYear(), base.getMonth(), base.getDate() + daysToSaturday, 18, 0, 0, 0);

  // Approx sunset times (fallback 18:00 if no util)
  const start = typeof getSunset === "function" ? getSunset(friday) || friday : friday;
  const end = typeof getSunset === "function" ? getSunset(saturday) || saturday : saturday;

  return {
    avoid: avoidSaturday && sabbathOnSaturday,
    nextStartISO: iso(start),
    nextEndISO: iso(end),
  };
}

/* ---------------------------------------
   Feast / observance days (optional; multi-faith)
   If your calendar exposes helpers, we’ll include them. Otherwise returns [].
----------------------------------------*/
async function getFeastDays(start, end, settings) {
  const out = [];

  // Hebrew feasts (if present)
  try {
    const heb = await safeImportMany([
      "@/services/calendar/HebrewFeastService.js",
      "@/services/calendar/HebrewFeastService",
      "@/hebrew-calendar/FeastService.js",
    ]);
    if (typeof heb?.getFeastDaysInRange === "function") {
      const method = settings?.hebrewCalendar?.method || "full-moon"; // aligns with your project preference
      const rows = await heb.getFeastDaysInRange(start, end, { method });
      out.push(...(rows || []));
    }
  } catch {}

  // Interfaith / public observances (if present) — e.g., Christian, Islamic, civic holidays
  try {
    const inter = await safeImportMany([
      "@/services/calendar/InterfaithObservanceService.js",
      "@/services/calendar/InterfaithObservanceService",
    ]);
    if (typeof inter?.getObservancesInRange === "function") {
      const rows = await inter.getObservancesInRange(start, end, {
        region: settings?.locale?.region || "global",
        includeCivic: settings?.calendar?.includeCivicHolidays === true,
      });
      out.push(...(rows || []));
    }
  } catch {}

  return out;
}

/* ---------------------------------------
   Meal Rhythm hooks (optional)
   - If available, derive dayTags (e.g., 'fast') and feeding/fasting windows.
   - Used by planning to avoid conflicts or align prep.
----------------------------------------*/
async function getRhythmContextByDay(start, end) {
  try {
    const cadence = await safeImportMany([
      "@/utils/rhythmCadence.js",
      "@/utils/rhythmCadence",
    ]);
    const rhythmStoreMod = await safeImportMany([
      "@/store/MealRhythmStore.js",
      "@/store/MealRhythmStore",
    ]);
    const rules = rhythmStoreMod?.useMealRhythmStore?.getState?.().rules || [];
    const out = {};

    for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      const windows = [];
      let tags = [];

      // Compose daily windows from rules that match this date (if cadence utils expose it)
      if (typeof cadence?.composeDailyFeedingWindows === "function") {
        for (const r of (rules || []).filter(r => r?.enabled && r.ifWindowDaily)) {
          const arr = cadence.composeDailyFeedingWindows(ymd, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", r.ifWindowDaily) || [];
          windows.push(...arr.map(w => ({ startISO: w.start.toISO?.() || w.startISO || null, endISO: w.end.toISO?.() || w.endISO || null })));
        }
      }
      // Simple tag if any window was composed; if you track multi-day fasts, tag fast on those days
      if (windows.length === 0 && rules.some(r => r?.multiDayFast)) {
        // If cadence exposes isWithinAnyBlock, use it; otherwise leave tags empty
        if (typeof cadence?.buildFastingBlocksInRange === "function" && typeof cadence?.isWithinAnyBlock === "function") {
          const blocks = cadence.buildFastingBlocksInRange(ymd, ymd, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", rules.find(r => r.multiDayFast)?.multiDayFast);
          const midday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
          if (cadence.isWithinAnyBlock?.(midday, blocks)) tags.push("fast");
        }
      }

      out[ymd] = { windows, tags };
    }
    return out;
  } catch {
    return {};
  }
}

/* ---------------------------------------
   Classification
----------------------------------------*/
function classifyEvent(e) {
  const role = String(e.role || e.category || e.title || "").toLowerCase();
  if (/\bclean|tidy|bathroom|laundry|mop|wipe|scrub/.test(role)) return "cleaning";
  if (/\bcook|meal|batch|bake|prep|kitchen/.test(role)) return "cooking";
  if (/\bgarden|plant|harvest|sow|weed|irrigat/.test(role)) return "gardening";
  if (/\banimal|farm|butcher|milk|hoof|feed|coop|pen|kennel/.test(role)) return "animal";

  const tasks = JSON.stringify(e.tasks || []).toLowerCase();
  if (/\bplant|harvest|weed|mulch|prune|seed/.test(tasks)) return "gardening";
  if (/\bbutcher|milk|deworm|hoof|shear/.test(tasks)) return "animal";
  if (/\bwipe|scrub|sanitize|declutter|dust|vacuum/.test(tasks)) return "cleaning";
  if (/\bbake|batch|marinate|chop|prep|soak/.test(tasks)) return "cooking";

  return "general";
}

/* ---------------------------------------
   Normalize event shapes
----------------------------------------*/
function normalizeEvent(e) {
  // Accept workerSessions-like or calendar adapter events
  const start = toDate(e.start || e.date || e.startTime || e.when);
  const end = toDate(e.end || e.endTime) || (start ? new Date(start.getTime() + (e.durationMin || 60) * 60000) : null);

  const range = start && end ? clampRange(start, end) : null;

  const out = {
    id: e.id || e._id || e.uid || `${(e.source || "local")}:${(e.uid || Math.random().toString(36).slice(2))}`,
    source: e.source || "local",
    title: e.title || e.summary || e.role || "Event",
    role: e.role || e.category || "",
    type: e.type || "event",
    tasks: e.tasks || [],
    status: e.status || "pending",
    allDay: !!e.allDay,
    startISO: range ? iso(range.start) : (start ? iso(start) : null),
    endISO: range ? iso(range.end) : (end ? iso(end) : null),
    meta: e.meta || {},
  };

  out.category = classifyEvent(out);
  return out;
}

/* ---------------------------------------
   Fetch from Dexie in range
----------------------------------------*/
async function fetchDexieEvents(startISO, endISO) {
  const arr = await DexieDB.workerSessions
    ?.where?.("date")
    ?.between?.(startISO, endISO, true, true)
    ?.toArray?.();

  return (arr || []).map((ev) =>
    normalizeEvent({
      id: ev.id,
      source: "dexie",
      title: ev.title || ev.role,
      role: ev.role,
      date: ev.date,
      end: ev.end,
      tasks: ev.tasks,
      status: ev.status,
      allDay: ev.allDay,
      meta: ev.meta,
    })
  );
}

/* ---------------------------------------
   Fetch from adapters (Google/Outlook/local)
----------------------------------------*/
async function fetchAdapterEvents(start, end, settings) {
  // Try unified calendarService first
  const svc = await safeImportMany([
    "@/server/services/calendarService.js",
    "@/server/services/calendarService",
  ]);

  const events = [];
  if (typeof svc?.listProviders === "function" && typeof svc?.listRange === "function") {
    try {
      const providers = await svc.listProviders();
      for (const p of providers || []) {
        const res = await svc.listRange?.({
          provider: p.id,
          calendarId: p.primaryCalendarId || "primary",
          start,
          end,
        });
        (res?.events || []).forEach((raw) => {
          events.push(
            normalizeEvent({
              ...raw,
              source: p.id || raw.source || "adapter",
            })
          );
        });
      }
    } catch {}
  } else {
    // Fallback: CalendarSyncModule if present
    const sync = await safeImportMany([
      "@/services/calendar/CalendarSyncModule.js",
      "@/services/calendar/CalendarSyncModule",
    ]);
    if (typeof sync?.default?.listRange === "function") {
      try {
        const res = await sync.default.listRange({ start, end, settings });
        (res?.events || []).forEach((raw) => events.push(normalizeEvent({ ...raw, source: "sync" })));
      } catch {}
    }
  }

  return events;
}

/* ---------------------------------------
   Conflicts & Free blocks
----------------------------------------*/
function computeConflicts(events) {
  const conflicts = [];
  const sorted = events
    .filter((e) => e.startISO && e.endISO && !e.allDay)
    .sort((a, b) => new Date(a.startISO) - new Date(b.startISO));

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = { start: new Date(sorted[i].startISO), end: new Date(sorted[i].endISO) };
      const b = { start: new Date(sorted[j].startISO), end: new Date(sorted[j].endISO) };
      if (overlaps(a, b)) {
        conflicts.push([sorted[i], sorted[j]]);
      } else if (b.start >= a.end) {
        break;
      }
    }
  }
  return conflicts;
}

function subtractBusyFromDay(dayStart, dayEnd, busyRanges) {
  // busyRanges: [{start:Date,end:Date}]
  const free = [];
  let cursor = new Date(dayStart);

  const dayBusy = busyRanges
    .filter((r) => overlaps({ start: dayStart, end: dayEnd }, r))
    .sort((a, b) => a.start - b.start);

  for (const b of dayBusy) {
    if (b.start > cursor) {
      free.push({ start: new Date(cursor), end: new Date(Math.min(b.start, dayEnd)) });
    }
    cursor = new Date(Math.max(cursor, b.end));
    if (cursor >= dayEnd) break;
  }

  if (cursor < dayEnd) free.push({ start: cursor, end: dayEnd });
  return free.filter((r) => r.end > r.start);
}

function computeFreeBlocks(events, start, end, opts = {}, settings = {}) {
  // Base daylight/work window
  let workStartHour = Number.isFinite(opts.workStartHour) ? opts.workStartHour : 8;
  let workEndHour   = Number.isFinite(opts.workEndHour)   ? opts.workEndHour   : 20;
  const minBlockMin = Number.isFinite(opts.minBlockMin)   ? opts.minBlockMin   : 30;

  // Quiet hours override (global readiness)
  const quiet = resolveQuietHours(settings);
  // Ensure free-block window honors quiet hours (no free blocks during quiet)
  workStartHour = Math.max(workStartHour, quiet.endHour);
  if (quiet.startHour < quiet.endHour) {
    // e.g., daytime quiet (rare) — keep given workEndHour
    workEndHour = Math.min(workEndHour, quiet.startHour);
  }

  // Build busy ranges list
  const allBusy = events
    .filter((e) => e.startISO && e.endISO)
    .map((e) => ({ start: new Date(e.startISO), end: new Date(e.endISO) }));

  const free = [];
  const weekend = resolveWeekendPattern(settings);

  // Iterate by day
  for (let d = new Date(start); d < end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    // If region weekend is configured and user prefers to avoid weekends for scheduling,
    // you can optionally skip weekend days for free-block offering by setting a flag:
    const avoidWeekend = settings?.calendar?.avoidWeekend === true;
    if (avoidWeekend && weekend.has(d.getDay())) continue;

    const ds = startOfDay(d, workStartHour);
    const de = startOfDay(d, workEndHour);
    const blocks = subtractBusyFromDay(ds, de, allBusy);
    blocks.forEach((b) => {
      if (minutesBetween(b.start, b.end) >= minBlockMin) {
        free.push({ startISO: iso(b.start), endISO: iso(b.end), minutes: minutesBetween(b.start, b.end) });
      }
    });
  }
  return free;
}

/* ---------------------------------------
   Day tags (fast, feast, travel, busy) builder
   - Combines rhythm tags, feast/observance markers, and heavy-busy days.
----------------------------------------*/
function buildDayTagsMap({ start, end, events = [], feastDays = [], rhythmByDay = {} }) {
  const out = {};
  const bump = (ymd, tag) => {
    out[ymd] = out[ymd] || new Set();
    out[ymd].add(tag);
  };

  const heavyThresholdMin = 8 * 60; // 8h busy → 'busy' tag
  const dayBusyMinutes = {};

  // Aggregate busy minutes per-day
  for (const e of events) {
    const s = toDate(e.startISO), f = toDate(e.endISO);
    if (!s || !f) continue;
    const d = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    dayBusyMinutes[ymd] = (dayBusyMinutes[ymd] || 0) + minutesBetween(s, f);
  }

  Object.entries(dayBusyMinutes).forEach(([ymd, mins]) => {
    if (mins >= heavyThresholdMin) bump(ymd, "busy");
  });

  // Feast / observance → 'feast' tag (lightly)
  for (const fd of feastDays || []) {
    const d = toDate(fd?.date || fd?.start || fd?.startISO);
    if (!d) continue;
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    bump(ymd, "feast");
    if (/fast/i.test(fd?.kind || fd?.name || "")) bump(ymd, "fast");
  }

  // Rhythm-based tags/windows
  for (const [ymd, rec] of Object.entries(rhythmByDay || {})) {
    (rec.tags || []).forEach(t => bump(ymd, t));
  }

  // Convert sets to arrays
  const finalMap = {};
  for (const [k, v] of Object.entries(out)) finalMap[k] = Array.from(v);
  return finalMap;
}

/* ---------------------------------------
   Main API
----------------------------------------*/
/**
 * @param {Object} options
 * @param {number} [options.lookbackDays=7]
 * @param {number} [options.lookaheadDays=14]
 * @param {boolean} [options.includeFeasts=true]
 * @param {boolean} [options.avoidSabbath=true]
 * @param {Object}  [options.freeBlockPrefs]  e.g., { workStartHour:8, workEndHour:20, minBlockMin:30 }
 * @param {boolean} [options.includeRhythmTags=true]
 * @returns {Promise<{
 *   nowISO: string,
 *   window: { startISO: string, endISO: string },
 *   pastEvents: any[],
 *   upcomingEvents: any[],
 *   conflicts: any[],
 *   freeBlocks: { startISO: string, endISO: string, minutes: number }[],
 *   sabbath: { avoid: boolean, nextStartISO: string|null, nextEndISO: string|null },
 *   feastDays: any[],
 *   dayTags?: Record<string, string[]>,
 *   rhythm?: Record<string, { windows: {startISO?:string, endISO?:string}[], tags: string[] }>,
 * }>}
 */
const loadCalendarContext = async (options = {}) => {
  const lookbackDays = Number(options.lookbackDays ?? 7);
  const lookaheadDays = Number(options.lookaheadDays ?? 14);

  // Pull settings if available (to honor sabbath, locale, calendar behaviors)
  let settings = {};
  try {
    const SettingsStore = await safeImportMany(["@/store/SettingsStore.js", "@/store/SettingsStore"]);
    settings = (await SettingsStore?.get?.()) || {};
  } catch {}

  const tz =
    options.tz ||
    settings?.timezone ||
    (typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone) ||
    "UTC";

  const now = new Date();
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);

  // 1) Dexie events
  const dexieEvents = await fetchDexieEvents(iso(start), iso(end));

  // 2) Adapter events (Google/Outlook/local sync)
  const adapterEvents = await fetchAdapterEvents(start, end, settings);

  // 3) Merge + de-dupe by (source,id,startISO||title) and normalize
  const all = [...dexieEvents, ...adapterEvents];
  const seen = new Set();
  const merged = [];
  for (const e of all) {
    const key = `${e.source}|${e.id}|${e.startISO || e.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }

  // 4) Split past vs upcoming
  const pastEvents = [];
  const upcomingEvents = [];
  merged.forEach((e) => {
    const s = toDate(e.startISO) || toDate(e.endISO) || now;
    if (s < now) pastEvents.push(e);
    else upcomingEvents.push(e);
  });

  // 5) Sabbath window
  const sabbath = await computeSabbathWindow(now, settings);

  // 6) Optional feast/observance injection
  let feastDays = [];
  if (options.includeFeasts !== false) {
    try {
      feastDays = await getFeastDays(start, end, settings);
    } catch {}
  }

  // 7) Optional meal rhythm context (day tags & IF windows)
  let rhythmByDay = {};
  if (options.includeRhythmTags !== false) {
    rhythmByDay = await getRhythmContextByDay(start, end);
  }

  // 8) Conflicts & free blocks (exclude Sabbath block if avoid=true)
  let scheduleEvents = [...upcomingEvents];
  if (sabbath.avoid && sabbath.nextStartISO && sabbath.nextEndISO) {
    scheduleEvents.push({
      id: "sabbath-block",
      source: "system",
      title: "Sabbath / Rest",
      category: "sabbath",
      startISO: sabbath.nextStartISO,
      endISO: sabbath.nextEndISO,
      allDay: false,
    });
  }

  // Add rhythm feeding windows as soft-busy if you want to AVOID scheduling outside feeding (optional):
  if (settings?.mealRhythm?.treatFeedingAsBusy === true) {
    for (const rec of Object.values(rhythmByDay)) {
      for (const w of rec?.windows || []) {
        if (w.startISO && w.endISO) {
          scheduleEvents.push({
            id: `feeding-${w.startISO}`,
            source: "rhythm",
            title: "Feeding window",
            category: "meal",
            startISO: w.startISO,
            endISO: w.endISO,
            allDay: false,
          });
        }
      }
    }
  }

  const conflicts = computeConflicts(scheduleEvents);
  const freeBlocks = computeFreeBlocks(scheduleEvents, now, end, options.freeBlockPrefs || {}, settings);

  // 9) Day tags map (fast/feast/busy, etc.)
  const dayTags = buildDayTagsMap({
    start, end, events: scheduleEvents, feastDays, rhythmByDay
  });

  return {
    nowISO: iso(now),
    window: { startISO: iso(start), endISO: iso(end) },
    pastEvents,
    upcomingEvents,
    conflicts,      // array of [eventA, eventB]
    freeBlocks,     // blocks with startISO, endISO, minutes
    sabbath,        // { avoid, nextStartISO, nextEndISO }
    feastDays,      // optional array from services
    dayTags,        // { 'YYYY-MM-DD': ['feast','busy','fast', ...], ... }
    rhythm: rhythmByDay, // windows + tags per day (if available)
    tz,
  };
};

export default loadCalendarContext;
