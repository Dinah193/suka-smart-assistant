// src/services/planning/generateCleaningSession.js

import DexieDB from "../../db";
import { v4 as uuidv4 } from "uuid";

/**
 * Generate a structured cleaning session from a saved plan.
 * Backward-compatible signature: generateCleaningSession(cleaningPlanId)
 *
 * New (optional) opts:
 *  - userId?: string
 *  - prefs?: Partial<Preferences>   // fallback to defaults if not provided
 *  - targetMinutes?: number         // timebox; trims tail tasks & inserts breaks
 *  - insertBreaks?: boolean         // default true when targetMinutes >= 45
 *  - pomodoroMinutes?: number       // default 25 focus / 5 break
 *  - dirtiness?: 0.5..2             // global multiplier; 1 = normal, 1.5 = messy
 *  - startAt?: Date | string        // used for suggested schedule
 *  - avoidQuietHours?: boolean      // defaults from prefs.notifications.quietHours.enabled
 */
const generateCleaningSession = async (cleaningPlanId, opts = {}) => {
  const plan = await DexieDB.cleaningPlans.get(cleaningPlanId);
  if (!plan) throw new Error("Cleaning plan not found.");

  const {
    userId = "global",
    prefs = null,
    targetMinutes = null,
    insertBreaks = undefined,
    pomodoroMinutes = 25,
    dirtiness = plan.dirtiness || 1, // 0.5..2
    startAt = new Date(),
    avoidQuietHours = undefined,
  } = opts || {};

  // Resolve preferences (graceful fallbacks; Dexie optional)
  const P = await resolvePreferences(prefs, userId);

  // Flatten tasks by zones (plan supports { zone, tasks[] } blocks)
  const allTasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const flatTasks = allTasks.flatMap((zoneBlock) =>
    (zoneBlock.tasks || []).map((task) => ({
      ...task,
      zone: zoneBlock.zone || "General",
      category: task.category || inferCategory(task.description),
    }))
  );

  // Build per-zone multiplier from prefs.cleaning.rooms { living:1, kitchen:1, bathroom:1, bedroom:2 }
  const zoneMult = deriveZoneMultipliers(P);

  // Parse, score, and estimate each task
  const parsed = flatTasks.map((task, index) => {
    const base = estimateTimeFromText(task.description);
    const zMult = zoneMult[task.zone?.toLowerCase?.()] ?? 1;
    const dirtMult = clamp(dirtiness, 0.5, 2);
    const toolPenalty = toolSetupPenalty(task.description);
    const minutes = Math.round(
      (task.estimatedMinutes ?? base) * zMult * dirtMult + toolPenalty
    );

    return {
      id: `task-${uuidv4()}`,
      step: index + 1, // temporary; we’ll re-order
      zone: task.zone || "General",
      category: task.category || inferCategory(task.description),
      description: task.description || "Unnamed Task",
      estimatedMinutes: minutes,
      priority: scorePriority(task),
      wetWork: isWetWork(task.description),
      canSoak: /soak|degreas|pre[-\s]?treat|descale|bake soda/i.test(task.description || ""),
      requiresDryTime: /dry time|air dry|ventilate/i.test(task.description || ""),
      supplies: inferSupplies(task.description),
    };
  });

  // Sort with practical heuristics:
  //  1) High priority first
  //  2) Wet work early so it can soak while you do dry tasks
  //  3) High-impact rooms earlier (kitchen, bathroom)
  //  4) Short tasks get sprinkled to keep momentum
  const ordered = orderTasks(parsed);

  // Interleave soak/dry to utilize idle time
  const interleaved = interleaveSoakWork(ordered);

  // If timeboxing, trim to target and add breaks
  const withBreaks = applyTimeboxingAndBreaks(
    interleaved,
    targetMinutes,
    insertBreaks ?? (targetMinutes ? targetMinutes >= 45 : false),
    pomodoroMinutes
  );

  // Renumber steps after ordering
  withBreaks.forEach((t, i) => (t.step = i + 1));

  // Build per-zone & per-category summaries
  const { zoneSummary, categorySummary } = summarize(withBreaks);

  // Unique supplies list (sorted by zone-friendly grouping)
  const supplies = buildSuppliesList(withBreaks);

  // Suggested schedule honoring quiet hours (if requested)
  const schedule = suggestSchedule(withBreaks, startAt, P, avoidQuietHours);

  const totalMinutes = withBreaks.reduce((sum, t) => sum + (t.type === "break" ? t.minutes : t.estimatedMinutes), 0);

  const session = {
    sessionId: `cleaning-session-${Date.now()}`,
    planId: plan.id,
    planTitle: plan.title,
    userId,
    generatedAt: new Date().toISOString(),
    estimatedTotalMinutes: totalMinutes,
    tasks: withBreaks,
    supplies,
    zoneSummary,
    categorySummary,
    schedule,
    meta: {
      dirtiness: clamp(dirtiness, 0.5, 2),
      timeboxed: Boolean(targetMinutes),
      preferencesVersion: P?._meta?.schemaVersion || 1,
    },
  };

  // Fire a lightweight client signal for automations/huds
  safeEmitPlanned(session);

  return session;
};

/* ───────────────────────────── Preference helpers ─────────────────────────── */

async function resolvePreferences(prefs, userId) {
  if (prefs && typeof prefs === "object") return withCleaningDefaults(prefs);
  // Try Dexie (if you keep preferences locally). Otherwise return defaults.
  try {
    const row = await DexieDB.preferences?.get?.(userId);
    if (row?.preferences) return withCleaningDefaults(row.preferences);
  } catch (_) {}
  return withCleaningDefaults(DEFAULT_PREFS);
}

function withCleaningDefaults(p) {
  const base = {
    ui: { locale: "en-US" },
    notifications: {
      quietHours: { enabled: true, start: "21:00", end: "07:00" },
    },
    cleaning: {
      rooms: { living: 1, kitchen: 1, bathroom: 1, bedroom: 1 },
      weekly: {},
      deepClean: { cadenceWeeks: 12 },
    },
  };
  return deepMerge(base, p || {});
}

function deriveZoneMultipliers(prefs) {
  const r = (prefs?.cleaning?.rooms) || {};
  // Each extra instance adds ~15% more time for that zone
  const mult = {};
  for (const [zone, count] of Object.entries(r)) {
    const c = Number(count || 1);
    mult[zone.toLowerCase()] = 1 + Math.max(0, c - 1) * 0.15;
  }
  return mult;
}

/* ───────────────────────────── Estimation helpers ─────────────────────────── */

function estimateTimeFromText(text = "") {
  const s = String(text).toLowerCase();
  if (/deep\s*clean|oven|grout|descale|shower|baseboard|fridge/.test(s)) return 18;
  if (/scrub|mop|steam|toilet|stovetop|sticky|grease|soap scum/.test(s)) return 14;
  if (/wipe|dust|sweep|mirror|counter|sink|spot clean/.test(s)) return 6;
  if (/tidy|organize|declutter|arrange|fold|sort/.test(s)) return 10;
  if (/trash|bin|take out|liners?/.test(s)) return 4;
  return 8; // fallback
}

function toolSetupPenalty(text = "") {
  const s = String(text).toLowerCase();
  let penalty = 0;
  if (/steam|carpet extractor|shampooer|pressure washer/.test(s)) penalty += 6;
  if (/vacuum/.test(s)) penalty += 2;
  if (/ladder|ceiling fan/.test(s)) penalty += 3;
  return penalty;
}

function scorePriority(task) {
  const s = String(task.description || "").toLowerCase();
  let score = 0;
  // High-impact room boost
  if (/(kitchen|bath|toilet|shower|sink)/.test(s) || /(Kitchen|Bathroom)/.test(task.zone || "")) score += 20;
  // Safety / hygiene
  if (/(mold|spill|bio|raw meat|odor)/.test(s)) score += 30;
  // Quick wins get a small bump to keep momentum
  if ((task.estimatedMinutes ?? 0) <= 6) score += 5;
  // Wet work early to allow soak
  if (isWetWork(task.description)) score += 10;
  return score;
}

function isWetWork(text = "") {
  return /(mop|soak|spray|degreas|descale|rinse|wash|sanitize|scrub)/i.test(text);
}

function inferCategory(desc = "") {
  const s = String(desc).toLowerCase();
  if (/dust|wipe|polish|declutter/.test(s)) return "surfaces";
  if (/vacuum|sweep|mop|carpet|floor/.test(s)) return "floors";
  if (/toilet|sink|shower|tub|mirror|soap scum/.test(s)) return "bathroom";
  if (/fridge|oven|stovetop|counter|dish/.test(s)) return "kitchen";
  if (/trash|bin|liner/.test(s)) return "trash";
  return "general";
}

function inferSupplies(desc = "") {
  const s = String(desc).toLowerCase();
  const out = new Set();
  if (/dust|wipe|counter|surface|mirror|glass/.test(s)) out.add("microfiber cloths");
  if (/spray|degreas|disinfect|sanitize/.test(s)) out.add("all-purpose cleaner");
  if (/mop|floor/.test(s)) out.add("mop & bucket");
  if (/vacuum|carpet/.test(s)) out.add("vacuum");
  if (/toilet|grout|shower|tub/.test(s)) out.add("scrub brush");
  if (/oven|stovetop|grease/.test(s)) out.add("degreaser");
  if (/glove|bleach|disinfect/.test(s)) out.add("gloves");
  if (/trash|liner/.test(s)) out.add("trash bags");
  return Array.from(out);
}

/* ───────────────────────────── Ordering & flow ───────────────────────────── */

function orderTasks(tasks) {
  // Sort by (priority desc) then by (zone score) then by (short-first mild bias)
  const zoneWeight = (z) => {
    const s = String(z || "").toLowerCase();
    if (/kitchen/.test(s)) return 3;
    if (/bath/.test(s)) return 3;
    if (/living|entry|hall/.test(s)) return 2;
    return 1;
  };
  return tasks
    .slice()
    .sort((a, b) => {
      const aKey = (b.priority - a.priority) ||
        (zoneWeight(b.zone) - zoneWeight(a.zone)) ||
        ((a.estimatedMinutes ?? 0) - (b.estimatedMinutes ?? 0)) * 0.1;
      return aKey;
    });
}

function interleaveSoakWork(ordered) {
  const out = [];
  let soakQueue = [];
  for (const t of ordered) {
    if (t.canSoak) {
      // Start soak, push a follow-up “finish scrub/rinse” task auto-added if not present
      out.push(t);
      soakQueue.push({
        ...t,
        id: `followup-${uuidv4()}`,
        description: `${t.description} — rinse/finish`,
        canSoak: false,
        wetWork: true,
        estimatedMinutes: Math.max(4, Math.round((t.estimatedMinutes || 6) * 0.4)),
        priority: t.priority - 5,
      });
      continue;
    }
    out.push(t);
    // After a couple of regular tasks, place a pending soak follow-up if any
    if (soakQueue.length && out.length % 3 === 0) {
      out.push(soakQueue.shift());
    }
  }
  // Flush any remaining follow-ups at the end
  out.push(...soakQueue);
  return out;
}

/* ───────────────────────────── Timeboxing & breaks ───────────────────────── */

function applyTimeboxingAndBreaks(list, targetMinutes, wantBreaks, pomodoroMinutes) {
  const tasks = [];
  let acc = 0;
  const focus = clamp(Number(pomodoroMinutes || 25), 15, 50);
  const breakLen = Math.round(Math.max(5, Math.min(10, focus / 5))); // 5–10 min
  let sinceBreak = 0;

  for (const t of list) {
    const dur = t.estimatedMinutes || 0;
    if (targetMinutes && acc + dur > targetMinutes) break;
    tasks.push(t);
    acc += dur;
    sinceBreak += dur;

    if (wantBreaks && sinceBreak >= focus) {
      tasks.push({
        id: `break-${uuidv4()}`,
        type: "break",
        description: "Short break — hydrate / reset tools",
        minutes: breakLen,
      });
      acc += breakLen;
      sinceBreak = 0;
    }
  }
  return tasks;
}

/* ───────────────────────────── Summaries & supplies ──────────────────────── */

function summarize(tasks) {
  const zoneSummary = {};
  const categorySummary = {};
  for (const t of tasks) {
    if (t.type === "break") continue;
    zoneSummary[t.zone] = (zoneSummary[t.zone] || 0) + (t.estimatedMinutes || 0);
    categorySummary[t.category] = (categorySummary[t.category] || 0) + (t.estimatedMinutes || 0);
  }
  // to arrays for charts
  return {
    zoneSummary: Object.entries(zoneSummary)
      .map(([zone, minutes]) => ({ zone, minutes }))
      .sort((a, b) => b.minutes - a.minutes),
    categorySummary: Object.entries(categorySummary)
      .map(([category, minutes]) => ({ category, minutes }))
      .sort((a, b) => b.minutes - a.minutes),
  };
}

function buildSuppliesList(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (t.type === "break") continue;
    for (const s of t.supplies || []) {
      map.set(s, (map.get(s) || 0) + 1);
    }
  }
  return Array.from(map.entries())
    .map(([name, hits]) => ({ name, hits }))
    .sort((a, b) => b.hits - a.hits);
}

/* ───────────────────────────── Scheduling (quiet hours aware) ───────────── */

function suggestSchedule(tasks, startAt, prefs, avoidQuietHours) {
  const quiet = prefs?.notifications?.quietHours || { enabled: false };
  const honorQuiet = avoidQuietHours ?? Boolean(quiet.enabled);

  let cursor = new Date(startAt);
  const timeline = [];

  for (const t of tasks) {
    const minutes = t.type === "break" ? t.minutes : t.estimatedMinutes || 0;

    if (honorQuiet && isInQuietHours(cursor, quiet)) {
      cursor = shiftToQuietEnd(cursor, quiet);
    }

    const start = new Date(cursor);
    const end = new Date(cursor.getTime() + minutes * 60_000);

    timeline.push({
      taskId: t.id,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      type: t.type || "task",
      description: t.description,
    });

    cursor = end;
  }

  return {
    startsAt: timeline[0]?.startISO || new Date(startAt).toISOString(),
    endsAt: timeline.at(-1)?.endISO || new Date(startAt).toISOString(),
    blocks: timeline,
  };
}

function isInQuietHours(date, quiet) {
  // quiet: { enabled, start:'21:00', end:'07:00' }
  if (!quiet?.enabled) return false;
  const d = new Date(date);
  const [qsH, qsM] = String(quiet.start || "21:00").split(":").map(Number);
  const [qeH, qeM] = String(quiet.end || "07:00").split(":").map(Number);

  const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
  const start = new Date(dayStart); start.setHours(qsH, qsM || 0, 0, 0);
  const end = new Date(dayStart);
  // If quiet end is in the morning, add a day
  if (qeH < qsH || (qeH === qsH && (qeM || 0) < (qsM || 0))) {
    end.setDate(end.getDate() + 1);
  }
  end.setHours(qeH, qeM || 0, 0, 0);

  return d >= start && d < end;
}

function shiftToQuietEnd(date, quiet) {
  const d = new Date(date);
  const [qeH, qeM] = String(quiet.end || "07:00").split(":").map(Number);
  const end = new Date(d);
  // if currently before end time, move to that time today; else tomorrow
  if (d.getHours() < qeH || (d.getHours() === qeH && d.getMinutes() < (qeM || 0))) {
    end.setHours(qeH, qeM || 0, 0, 0);
  } else {
    end.setDate(end.getDate() + 1);
    end.setHours(qeH, qeM || 0, 0, 0);
  }
  return end;
}

/* ───────────────────────────── Utilities ─────────────────────────────────── */

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function deepMerge(target, source) {
  if (!source) return target || {};
  const out = Array.isArray(target) ? target.slice() : { ...(target || {}) };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function safeEmitPlanned(session) {
  try {
    // Bridge to the intuition bus wired in automation/bootstrap.js
    if (typeof window !== "undefined" && window?.dispatchEvent) {
      window.dispatchEvent(new CustomEvent("session:cleaning:planned", { detail: { session } }));
    }
  } catch (_) {}
}

const DEFAULT_PREFS = {
  ui: { locale: "en-US" },
  notifications: { quietHours: { enabled: true, start: "21:00", end: "07:00" } },
  cleaning: {
    rooms: { living: 1, kitchen: 1, bathroom: 1, bedroom: 1 },
    weekly: {},
    deepClean: { cadenceWeeks: 12 },
  },
};

export default generateCleaningSession;
