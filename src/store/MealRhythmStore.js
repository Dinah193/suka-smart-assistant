// src/store/MealRhythmStore.js
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";

/**
 * PURPOSE
 * A lighter, more intuitive Meal Rhythm engine:
 *  - Minimal inputs (choose a pattern + window + # meals/snacks)
 *  - One-click presets
 *  - Optional rules layer for power users
 *  - Clean APIs for day/weekly templates & batch-cook suggestions
 *
 * Slots produced by generators:
 * [{ id, slotId, label, type: "meal"|"snack"|"fast", start:"HH:mm", end:"HH:mm", dietTag?, sabbath? }]
 */

/* -------------------------------- Versioning ------------------------------ */
const VERSION = 3;
const LS_KEY = "suka.mealrhythm.v" + VERSION;

/* -------------------------------- Utilities ------------------------------- */
const ISO = (d) => {
  if (!d) return "";
  const x = typeof d === "string" && d.length <= 10 ? new Date(d + "T00:00:00") : new Date(d);
  if (Number.isNaN(x.getTime())) return "";
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};
const toMin = (hhmm) => {
  if (!/^\d{2}:\d{2}$/.test(hhmm || "")) return null;
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
};
const toHHMM = (mins) => {
  const m = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
const isArr = Array.isArray;
const uniq = (a) => Array.from(new Set((a || []).filter(Boolean)));
const lower = (s) => String(s || "").toLowerCase();
const now = () => Date.now();

function safeDispatch(name, detail) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    /* SSR / tests */
  }
}

/* ----------------------- Sabbath helpers (day-level) ---------------------- */
function isHebrewDay7(isoDate) {
  // At day granularity: treat Saturday as Sabbath
  const dow = new Date(isoDate + "T00:00:00").getDay(); // 6 = Sat
  return dow === 6;
}

/* ------------------------------ Calendars --------------------------------- */
export const GREG_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
export const CREATION_KEYS = ["day_one", "day_two", "day_three", "day_four", "day_five", "day_six", "sabbath"];
export const HEBREW_KEYS = ["yom_rishon", "yom_sheni", "yom_shelishi", "yom_revi_i", "yom_chamishi", "yom_shishi", "shabbat"];
const POS = {
  gregorian: GREG_KEYS,
  creation: CREATION_KEYS,
  hebrew: HEBREW_KEYS,
};
function detectCalendar(map = {}) {
  const has = (ks) => ks.some((k) => Array.isArray(map[k]));
  if (has(HEBREW_KEYS)) return "hebrew";
  if (has(CREATION_KEYS)) return "creation";
  if (has(GREG_KEYS)) return "gregorian";
  return "gregorian";
}
function normalizeWeekMap(map = {}, calendar = "gregorian") {
  const out = {};
  (POS[calendar] || GREG_KEYS).forEach((k) => (out[k] = Array.isArray(map[k]) ? [...map[k]] : []));
  return out;
}

/* -------------------------------- Presets --------------------------------- */
/**
 * Rules are still supported for power users, but we expose friendlier "Quick"
 * configs for most users. Presets below align to popular patterns.
 */
const RULE_PRESETS = {
  "3MAD_PLUS_SNACK": () => [
    {
      id: uuidv4(),
      name: "3 Meals + Snack (Daily)",
      priority: 10,
      enabled: true,
      match: { weekday: true, weekend: true },
      slots: [
        { slotId: "breakfast", label: "Breakfast", kind: "meal", timeHint: "07:30" },
        { slotId: "lunch", label: "Lunch", kind: "meal", timeHint: "12:30" },
        { slotId: "dinner", label: "Dinner", kind: "meal", timeHint: "18:30" },
        { slotId: "snack", label: "Snack", kind: "snack", timeHint: "15:30" },
      ],
    },
  ],
  "2MAD": () => [
    {
      id: uuidv4(),
      name: "2MAD (Daily)",
      priority: 10,
      enabled: true,
      match: { weekday: true, weekend: true },
      slots: [
        { slotId: "midday", label: "Midday Meal", kind: "meal", timeHint: "12:30" },
        { slotId: "evening", label: "Evening Meal", kind: "meal", timeHint: "18:30" },
      ],
    },
  ],
  "OMAD_WEEKDAYS_FREE_WEEKENDS": () => [
    {
      id: uuidv4(),
      name: "OMAD Weekdays",
      priority: 20,
      enabled: true,
      match: { daysOfWeek: [1, 2, 3, 4, 5] },
      ifWindowDaily: { start: "16:00", end: "19:00" },
      slots: [{ slotId: "omad", label: "OMAD", kind: "meal", timeHint: "17:00" }],
    },
    {
      id: uuidv4(),
      name: "Unrestricted Weekends",
      priority: 30,
      enabled: true,
      match: { daysOfWeek: [0, 6] },
      slots: [
        { slotId: "breakfast", label: "Breakfast", kind: "meal", timeHint: "09:00" },
        { slotId: "lunch", label: "Lunch", kind: "meal", timeHint: "13:00" },
        { slotId: "dinner", label: "Dinner", kind: "meal", timeHint: "19:00" },
      ],
    },
  ],
  "IF_16_8": () => [
    {
      id: uuidv4(),
      name: "Intermittent Fasting 16:8",
      priority: 40,
      enabled: true,
      match: { weekday: true, weekend: true },
      ifWindowDaily: { start: "12:00", end: "20:00" },
      slots: [
        { slotId: "meal1", label: "First Meal", kind: "meal", timeHint: "12:30" },
        { slotId: "meal2", label: "Second Meal", kind: "meal", timeHint: "18:30" },
      ],
      dayMacroTarget: { kcal: 1800 },
    },
  ],
  "IF_18_6": () => [
    {
      id: uuidv4(),
      name: "Intermittent Fasting 18:6",
      priority: 41,
      enabled: true,
      match: { weekday: true, weekend: true },
      ifWindowDaily: { start: "13:00", end: "19:00" },
      slots: [
        { slotId: "meal1", label: "First Meal", kind: "meal", timeHint: "13:30" },
        { slotId: "meal2", label: "Second Meal", kind: "meal", timeHint: "18:00" },
      ],
    },
  ],
  "IF_20_4": () => [
    {
      id: uuidv4(),
      name: "Warrior 20:4",
      priority: 42,
      enabled: true,
      match: { weekday: true, weekend: true },
      ifWindowDaily: { start: "16:00", end: "20:00" },
      slots: [{ slotId: "meal1", label: "Window Meal", kind: "meal", timeHint: "17:00" }],
    },
  ],
  "OMAD_DAILY_IF": () => [
    {
      id: uuidv4(),
      name: "OMAD (Daily IF Window)",
      priority: 43,
      enabled: true,
      match: { weekday: true, weekend: true },
      ifWindowDaily: { start: "16:00", end: "19:00" },
      slots: [{ slotId: "omad", label: "OMAD", kind: "meal", timeHint: "17:00" }],
    },
  ],
  "WEEKLY_36H_FAST": () => [
    {
      id: uuidv4(),
      name: "36-Hour Fast (Weekly, starts Sun 20:00)",
      priority: 70,
      enabled: true,
      match: { weekday: true, weekend: true },
      multiDayFast: {
        startISODateTime: new Date().toISOString().slice(0, 10) + "T20:00:00",
        durationHours: 36,
        repeat: "weekly",
      },
      slots: [], // generator marks fasting blocks
    },
  ],
};

/* -------------------------- Power-user rule engine ------------------------ */
/**
 * Rule shape (stored in .rules):
 * {
 *   id: string,
 *   name: string,
 *   priority: number,
 *   enabled: boolean,
 *   match?: { weekday?: boolean, weekend?: boolean, daysOfWeek?: number[] }, // 0..6
 *   ifWindowDaily?: { start: "HH:mm", end: "HH:mm" },
 *   multiDayFast?: { startISODateTime: string, durationHours: number, repeat?: "none"|"weekly"|"biweekly"|"monthly" },
 *   slots?: Array<{ slotId, label, kind: "meal"|"snack", timeHint: "HH:mm" }>,
 *   dayMacroTarget?: { kcal?: number }
 * }
 */
function matchesDay(rule, date) {
  if (!rule?.enabled) return false;
  const dow = date.getDay(); // 0..6
  const m = rule.match || {};
  if (isArr(m.daysOfWeek) && m.daysOfWeek.length) return m.daysOfWeek.includes(dow);
  const isWeekend = dow === 0 || dow === 6;
  const isWeekday = !isWeekend;
  if (isWeekend && m.weekend) return true;
  if (isWeekday && m.weekday) return true;
  if (!("weekday" in m) && !("weekend" in m) && !("daysOfWeek" in m)) return true;
  return false;
}

function expandMultiDayFast(rule, dateIso) {
  // returns array of [startMin,endMin] within *this day*
  const out = [];
  if (!rule?.multiDayFast) return out;
  const cfg = rule.multiDayFast;
  const start = new Date(cfg.startISODateTime);
  if (Number.isNaN(start)) return out;

  const dayStart = new Date(dateIso + "T00:00:00");
  const dayEnd = new Date(dateIso + "T23:59:59");

  const occurrences = [];
  const pushOcc = (dt) => occurrences.push(new Date(dt));

  if (!cfg.repeat || cfg.repeat === "none") {
    pushOcc(start);
  } else {
    const copy = new Date(start);
    // generate a small window of occurrences around target day
    while (copy <= dayEnd) {
      if (copy >= new Date(dayStart.getTime() - 8 * 86400000)) pushOcc(copy);
      if (cfg.repeat === "weekly") copy.setDate(copy.getDate() + 7);
      else if (cfg.repeat === "biweekly") copy.setDate(copy.getDate() + 14);
      else if (cfg.repeat === "monthly") copy.setMonth(copy.getMonth() + 1);
      else break;
    }
  }

  const durMs = Math.round((cfg.durationHours || 0) * 3600000);
  for (const occ of occurrences) {
    const occEnd = new Date(occ.getTime() + durMs);
    const startClamp = Math.max(occ.getTime(), dayStart.getTime());
    const endClamp = Math.min(occEnd.getTime(), dayEnd.getTime());
    if (endClamp > startClamp) {
      const minsStart = Math.round((startClamp - dayStart.getTime()) / 60000);
      const minsEnd = Math.round((endClamp - dayStart.getTime()) / 60000);
      out.push([minsStart, minsEnd]);
    }
  }
  return out;
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const res = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = res[res.length - 1];
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else res.push(cur.slice());
  }
  return res;
}
function complementIntervals(blocks, dayStart = 0, dayEnd = 1440) {
  if (!blocks.length) return [[dayStart, dayEnd]];
  const merged = mergeIntervals(blocks);
  const gaps = [];
  let cursor = dayStart;
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < dayEnd) gaps.push([cursor, dayEnd]);
  return gaps;
}

/* ----------------------------- Quick Config ------------------------------- */
/**
 * A single, simple object users can tweak without touching rules:
 * quick = {
 *   pattern: "3MAD" | "2MAD" | "IF_16_8" | "IF_18_6" | "IF_20_4" | "OMAD" | "CUSTOM",
 *   weekdayWindow: { start:"HH:mm", end:"HH:mm" }   // used for IF patterns
 *   weekendWindow: { start:"HH:mm", end:"HH:mm" }   // optional
 *   mealsPerDay: 2|3 (ignored for OMAD),
 *   snacksPerDay: 0|1|2,
 *   preferTimes: { breakfast:"07:30", lunch:"12:30", dinner:"18:30", snack:"15:30" } // defaults
 *   relaxedWeekends: boolean                       // if true, use weekendWindow or 3MAD weekend
 * }
 */
const DEFAULT_QUICK = {
  pattern: "IF_16_8",
  weekdayWindow: { start: "12:00", end: "20:00" },
  weekendWindow: { start: "11:00", end: "19:00" },
  mealsPerDay: 2,
  snacksPerDay: 0,
  preferTimes: { breakfast: "07:30", lunch: "12:30", dinner: "18:30", snack: "15:30" },
  relaxedWeekends: true,
};

function composeRulesFromQuick(q = DEFAULT_QUICK) {
  const quick = { ...DEFAULT_QUICK, ...(q || {}) };
  const rules = [];
  const addRule = (r) => rules.push({ id: uuidv4(), priority: 20, enabled: true, ...r });

  if (quick.pattern === "3MAD") {
    addRule({
      name: "3MAD (Daily)",
      match: { weekday: true, weekend: true },
      slots: [
        { slotId: "breakfast", label: "Breakfast", kind: "meal", timeHint: quick?.preferTimes?.breakfast || "07:30" },
        { slotId: "lunch", label: "Lunch", kind: "meal", timeHint: quick?.preferTimes?.lunch || "12:30" },
        { slotId: "dinner", label: "Dinner", kind: "meal", timeHint: quick?.preferTimes?.dinner || "18:30" },
      ],
    });
    if (quick.snacksPerDay > 0) {
      for (let i = 0; i < clamp(quick.snacksPerDay, 1, 2); i++) {
        addRule({
          name: `Snack ${i + 1}`,
          match: { weekday: true, weekend: true },
          slots: [{ slotId: `snack${i + 1}`, label: "Snack", kind: "snack", timeHint: quick?.preferTimes?.snack || "15:30" }],
        });
      }
    }
  } else if (quick.pattern === "2MAD") {
    addRule({
      name: "2MAD (Daily)",
      match: { weekday: true, weekend: true },
      slots: [
        { slotId: "midday", label: "Midday Meal", kind: "meal", timeHint: quick?.preferTimes?.lunch || "12:30" },
        { slotId: "evening", label: "Evening Meal", kind: "meal", timeHint: quick?.preferTimes?.dinner || "18:30" },
      ],
    });
  } else if (quick.pattern === "OMAD") {
    addRule({
      name: "OMAD (Daily)",
      match: { weekday: true, weekend: true },
      ifWindowDaily: { start: "16:00", end: "19:00" },
      slots: [{ slotId: "omad", label: "OMAD", kind: "meal", timeHint: "17:00" }],
    });
  } else if (quick.pattern?.startsWith("IF_")) {
    // IF patterns with weekday/weekend windows
    const weekday = quick.weekdayWindow || { start: "12:00", end: "20:00" };
    addRule({
      name: quick.pattern.replace("_", " "),
      match: { daysOfWeek: [1, 2, 3, 4, 5] },
      ifWindowDaily: weekday,
      slots:
        quick.mealsPerDay === 3
          ? [
              { slotId: "meal1", label: "Meal 1", kind: "meal", timeHint: toHHMM((toMin(weekday.start) ?? 720) + 15) },
              { slotId: "meal2", label: "Meal 2", kind: "meal", timeHint: toHHMM((toMin(weekday.start) ?? 720) + 180) },
              { slotId: "meal3", label: "Meal 3", kind: "meal", timeHint: toHHMM((toMin(weekday.end) ?? 1200) - 60) },
            ]
          : [
              { slotId: "meal1", label: "Meal 1", kind: "meal", timeHint: toHHMM((toMin(weekday.start) ?? 720) + 15) },
              { slotId: "meal2", label: "Meal 2", kind: "meal", timeHint: toHHMM((toMin(weekday.end) ?? 1200) - 60) },
            ],
    });

    if (quick.relaxedWeekends) {
      const wend = quick.weekendWindow || weekday;
      addRule({
        name: "Relaxed Weekend",
        match: { daysOfWeek: [0, 6] },
        ifWindowDaily: wend,
        slots:
          quick.mealsPerDay === 3
            ? [
                { slotId: "meal1w", label: "Meal 1", kind: "meal", timeHint: toHHMM((toMin(wend.start) ?? 720) + 15) },
                { slotId: "meal2w", label: "Meal 2", kind: "meal", timeHint: toHHMM((toMin(wend.start) ?? 720) + 180) },
                { slotId: "meal3w", label: "Meal 3", kind: "meal", timeHint: toHHMM((toMin(wend.end) ?? 1200) - 45) },
              ]
            : [
                { slotId: "meal1w", label: "Meal 1", kind: "meal", timeHint: toHHMM((toMin(wend.start) ?? 720) + 15) },
                { slotId: "meal2w", label: "Meal 2", kind: "meal", timeHint: toHHMM((toMin(wend.end) ?? 1200) - 60) },
              ],
      });
    }
  } else {
    // CUSTOM: leave as-is, UI will add rules manually
  }

  // Optional snacks layer for IF / 2MAD (if asked)
  if (quick.snacksPerDay > 0 && quick.pattern !== "3MAD" && quick.pattern !== "OMAD") {
    const times = ["15:30", "17:00"];
    for (let i = 0; i < clamp(quick.snacksPerDay, 1, 2); i++) {
      rules.push({
        id: uuidv4(),
        name: `Snack ${i + 1}`,
        priority: 30,
        enabled: true,
        match: { weekday: true, weekend: true },
        slots: [{ slotId: `snack${i + 1}`, label: "Snack", kind: "snack", timeHint: quick?.preferTimes?.snack || times[i] }],
      });
    }
  }

  return rules;
}

/* ---------------------------- Store Definition ---------------------------- */
export const useMealRhythmStore = create(
  persist(
    (set, get) => ({
      // Simple config (what most users will touch)
      quick: { ...DEFAULT_QUICK },

      // Rules (for advanced users / agents)
      rules: [],

      // Timezone hint (UI-level; actual wall time conversion is done elsewhere)
      timezone: "America/Chicago",

      // Diet preferences per DOW (0..6) + default
      dietByDow: {
        default: "unrestricted",
        1: "keto",
        2: "keto",
        3: "keto",
        4: "keto",
        5: "keto",
        6: "unrestricted",
        0: "unrestricted",
      },

      // Per-date overrides: { "YYYY-MM-DD": { dietTag, slotsOverride?: Slot[] } }
      overrides: {},

      // Sabbath awareness
      sabbath: {
        enabled: true,
        dayRule: "hebrew_day7", // "hebrew_day7" | "saturday"
        trimDinnerAfterSunset: true, // flag only; UI/Calendar supplies exact sunset if needed
        labelTag: "sabbath",
      },

      /* --------------------------- High-level actions -------------------- */
      applyPreset: (key) => {
        // Preset replaces rules; quick stays as-is (so users can switch back)
        const factory = RULE_PRESETS[key];
        if (!factory) return;
        set({ rules: factory() });
        safeDispatch("meal-rhythm:changed", { via: "preset", key });
      },

      applyQuick: (nextQuick) => {
        const quick = { ...get().quick, ...(nextQuick || {}) };
        const rules = composeRulesFromQuick(quick);
        set({ quick, rules });
        safeDispatch("meal-rhythm:changed", { via: "quick", quick });
      },

      resetQuickTo: (patternKey = "IF_16_8") => {
        const base = { ...DEFAULT_QUICK, pattern: patternKey };
        const rules = composeRulesFromQuick(base);
        set({ quick: base, rules });
        safeDispatch("meal-rhythm:changed", { via: "quickReset", quick: base });
      },

      // Fine-grained rule CRUD (kept for advanced users/agents)
      addRule: (rule) => set((s) => ({ rules: [...s.rules, { ...rule, id: rule.id || uuidv4(), enabled: rule.enabled ?? true }] })),
      updateRule: (id, updates) => set((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, ...updates } : r)) })),
      removeRule: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id) })),
      reorder: (orderedIds) =>
        set((s) => {
          const map = new Map(s.rules.map((r) => [r.id, r]));
          return { rules: orderedIds.map((id) => map.get(id)).filter(Boolean) };
        }),
      clearAllRules: () => set({ rules: [] }),

      setTimezone: (tz) => set({ timezone: tz || "America/Chicago" }),
      setDietByDow: (next) => set((s) => ({ dietByDow: { ...s.dietByDow, ...(next || {}) } })),
      setOverrideForDate: (iso, ov) =>
        set((s) => ({ overrides: { ...s.overrides, [ISO(iso)]: { ...(s.overrides[ISO(iso)] || {}), ...(ov || {}) } } })),
      clearOverrideForDate: (iso) =>
        set((s) => {
          const k = ISO(iso);
          const o = { ...(s.overrides || {}) };
          delete o[k];
          return { overrides: o };
        }),
      setSabbath: (next) => set((s) => ({ sabbath: { ...s.sabbath, ...(next || {}) } })),

      /* ---------------------------- Generators --------------------------- */

      /**
       * Returns slots for a given date (pure compute; does not mutate):
       * - Applies matched rules, IF windows, multi-day fasts
       * - Adds FAST slots for gaps
       * - Applies diet tags, Sabbath flag, and per-date overrides
       */
      generateDayTemplate: (dateIso) => {
        const iso = ISO(dateIso);
        if (!iso) return [];
        const st = get();
        const date = new Date(iso + "T00:00:00");
        const dow = date.getDay();

        // 1) collect matched rules by priority
        const matched = (st.rules || [])
          .filter((r) => matchesDay(r, date))
          .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

        // 2) fasting blocks from multi-day fasts
        const fastingBlocks = matched.flatMap((r) => expandMultiDayFast(r, iso)).filter((x) => x && x.length === 2);

        // 3) last in priority wins for ifWindowDaily
        let ifWin = null;
        matched.forEach((r) => {
          if (r.ifWindowDaily) ifWin = r.ifWindowDaily;
        });

        // 4) build meal/snack slots from rules (dedupe by slotId)
        const slots = [];
        const seen = new Set();
        matched.forEach((r) => {
          (r.slots || []).forEach((slt) => {
            if (!slt?.slotId || seen.has(slt.slotId)) return;
            seen.add(slt.slotId);
            const dur = slt.kind === "snack" ? 15 : 45;
            const start = slt.timeHint || "12:00";
            const end = toHHMM((toMin(start) ?? 720) + dur);
            slots.push({
              id: `${slt.slotId}-${iso}`,
              slotId: slt.slotId,
              label: slt.label || (slt.kind === "snack" ? "Snack" : "Meal"),
              type: slt.kind === "snack" ? "snack" : "meal",
              start,
              end,
            });
          });
        });

        // 5) snap to IF window if present + add fast gaps
        if (ifWin && toMin(ifWin.start) != null && toMin(ifWin.end) != null) {
          const sMin = toMin(ifWin.start);
          const eMin = toMin(ifWin.end);
          slots.forEach((sl) => {
            let stMin = Math.min(Math.max(toMin(sl.start) ?? sMin, sMin), eMin);
            let enMin = Math.min(Math.max(toMin(sl.end) ?? eMin, sMin), eMin);
            if (enMin <= stMin) enMin = Math.min(stMin + (sl.type === "snack" ? 15 : 30), eMin);
            sl.start = toHHMM(stMin);
            sl.end = toHHMM(enMin);
          });
          fastingBlocks.push([0, sMin], [eMin, 1440]);
        }

        // 6) FAST slots for gaps
        const mergedFasts = mergeIntervals(fastingBlocks);
        const fastSlots = mergedFasts.map(([s, e], i) => ({
          id: `FAST-${i}-${iso}`,
          slotId: `FAST_${i}`,
          label: "Fast",
          type: "fast",
          start: toHHMM(s),
          end: toHHMM(e),
        }));

        // 7) diet tags
        const baseDiet = Object.prototype.hasOwnProperty.call(st.dietByDow, dow) ? st.dietByDow[dow] : st.dietByDow.default || "unrestricted";
        const ov = (st.overrides || {})[iso] || {};
        const dietTag = ov.dietTag || baseDiet;

        // 8) sabbath flags
        let finalSlots = [...fastSlots, ...slots].sort((a, b) => (toMin(a.start) ?? 0) - (toMin(b.start) ?? 0));
        if (st.sabbath?.enabled) {
          const saturday = st.sabbath.dayRule === "saturday" ? dow === 6 : isHebrewDay7(iso);
          if (saturday) {
            finalSlots = finalSlots.map((sl) => ({
              ...sl,
              dietTag: sl.dietTag || (sl.type === "fast" ? "fasting" : dietTag),
              sabbath: true,
            }));
          }
        }

        // 9) per-date overrides for slots
        if (ov.slotsOverride && Array.isArray(ov.slotsOverride) && ov.slotsOverride.length) {
          finalSlots = ov.slotsOverride.map((o, i) => ({
            id: `${o.slotId || "S"}-${iso}-${i}`,
            slotId: o.slotId || `S${i}`,
            label: o.label || "Meal",
            type: o.type || "meal",
            start: o.start || "12:00",
            end: o.end || "12:45",
            dietTag: o.dietTag || dietTag,
          }));
        } else {
          finalSlots = finalSlots.map((s) => ({ ...s, dietTag: s.dietTag || dietTag }));
        }

        // Let agents react (e.g., attach cuisine/recipes from RecipeStore)
        safeDispatch("agents:meal_day_template", { date: iso, slots: finalSlots });

        return finalSlots;
      },

      /** Convenience: feeding (non-fast) slots only */
      generateFeedingSlots: (dateIso) => get().generateDayTemplate(dateIso).filter((s) => s.type === "meal" || s.type === "snack"),

      /** 7-day map of templates starting from weekStartIso (Mon recommended) */
      generateWeekTemplates: (weekStartIso) => {
        const start = new Date(ISO(weekStartIso) + "T00:00:00");
        const out = {};
        for (let i = 0; i < 7; i++) {
          const d = new Date(start);
          d.setDate(start.getDate() + i);
          const iso = ISO(d);
          out[iso] = get().generateDayTemplate(iso);
        }
        safeDispatch("agents:meal_week_proposed", out);
        return out;
      },

      /** Return merged feeding windows (time ranges where eating is allowed) for a given date */
      computeFeedingWindows: (dateIso) => {
        const iso = ISO(dateIso);
        if (!iso) return [[0, 1440]];
        const st = get();
        const date = new Date(iso + "T00:00:00");
        const matched = (st.rules || []).filter((r) => matchesDay(r, date));
        let ifWin = null;
        matched.forEach((r) => {
          if (r.ifWindowDaily) ifWin = r.ifWindowDaily;
        });
        const fasts = matched.flatMap((r) => expandMultiDayFast(r, iso));
        if (ifWin && toMin(ifWin.start) != null && toMin(ifWin.end) != null) {
          fasts.push([0, toMin(ifWin.start)], [toMin(ifWin.end), 1440]);
        }
        const gaps = complementIntervals(fasts);
        return gaps; // [[startMin,endMin], ...]
      },

      /** Heuristic: suggest 1–2 batch-cooking windows for the week (Sun/Wed defaults) */
      suggestBatchCookingWindows: (weekStartIso, durationMin = 120) => {
        const startIso = ISO(weekStartIso);
        if (!startIso) return [];
        const start = new Date(startIso + "T00:00:00");

        const pickWindow = (iso, targetStartMin) => {
          const wins = get().computeFeedingWindows(iso);
          // choose the first window that can fit duration and starts after targetStartMin
          const candidates = wins
            .map(([s, e]) => [Math.max(s, targetStartMin), e])
            .filter(([s, e]) => e - s >= durationMin);
          const [s, e] = candidates[0] || wins.find(([s0, e0]) => e0 - s0 >= durationMin) || [540, 780]; // 9–13 as fallback
          return { date: iso, start: toHHMM(s), end: toHHMM(s + durationMin) };
        };

        // Sunday afternoon + Wednesday evening by default
        const sun = new Date(start);
        sun.setDate(start.getDate()); // weekStart day
        const wed = new Date(start);
        wed.setDate(start.getDate() + 3);

        const slots = [
          pickWindow(ISO(sun), 900), // 15:00
          pickWindow(ISO(wed), 1080), // 18:00
        ];
        safeDispatch("agents:batch_windows_suggested", { weekStart: startIso, slots });
        return slots;
      },

      /* --------------------------------- I/O -------------------------------- */
      exportJson: () => {
        const s = get();
        return JSON.stringify(
          {
            quick: s.quick,
            rules: s.rules,
            timezone: s.timezone,
            dietByDow: s.dietByDow,
            overrides: s.overrides,
            sabbath: s.sabbath,
          },
          null,
          2
        );
      },
      importJson: (json) => {
        try {
          const obj = typeof json === "string" ? JSON.parse(json) : json;
          const quick = { ...DEFAULT_QUICK, ...(obj?.quick || {}) };
          const rules = Array.isArray(obj?.rules) ? obj.rules : composeRulesFromQuick(quick);
          const timezone = obj?.timezone || "America/Chicago";
          const dietByDow = { ...(obj?.dietByDow || {}) };
          const overrides = { ...(obj?.overrides || {}) };
          const sabbath = { ...(obj?.sabbath || {}) };
          set({ quick, rules, timezone, dietByDow, overrides, sabbath });
          safeDispatch("meal-rhythm:changed", { via: "import" });
        } catch {
          /* ignore invalid */
        }
      },
    }),
    {
      name: LS_KEY,
      version: VERSION,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, ver) => {
        if (!persisted) return persisted;

        // v1/v2 -> v3: introduce quick config; if no rules, compose from default quick
        if (ver < 3) {
          const quick = { ...DEFAULT_QUICK, ...(persisted.quick || {}) };
          const rules = Array.isArray(persisted.rules) && persisted.rules.length ? persisted.rules : composeRulesFromQuick(quick);

          // Ensure sabbath & diet defaults exist
          persisted.sabbath = persisted.sabbath || {
            enabled: true,
            dayRule: "hebrew_day7",
            trimDinnerAfterSunset: true,
            labelTag: "sabbath",
          };
          persisted.dietByDow =
            persisted.dietByDow || {
              default: "unrestricted",
              1: "keto",
              2: "keto",
              3: "keto",
              4: "keto",
              5: "keto",
              6: "unrestricted",
              0: "unrestricted",
            };

          persisted.quick = quick;
          persisted.rules = rules;
        }
        return persisted;
      },
      partialize: (s) => ({
        quick: s.quick,
        rules: s.rules,
        timezone: s.timezone,
        dietByDow: s.dietByDow,
        overrides: s.overrides,
        sabbath: s.sabbath,
      }),
    }
  )
);

export default useMealRhythmStore;

/* -------------------------------- Hooks (UI) ------------------------------ */
export const useMealRhythm = (selector) =>
  useMealRhythmStore(
    (s) =>
      selector
        ? selector(s)
        : {
            quick: s.quick,
            rules: s.rules,
            timezone: s.timezone,
            dietByDow: s.dietByDow,
            overrides: s.overrides,
            sabbath: s.sabbath,
          }
  );

export const useMealRhythmActions = () =>
  useMealRhythmStore((s) => ({
    applyPreset: s.applyPreset,
    applyQuick: s.applyQuick,
    resetQuickTo: s.resetQuickTo,
    addRule: s.addRule,
    updateRule: s.updateRule,
    removeRule: s.removeRule,
    reorder: s.reorder,
    clearAllRules: s.clearAllRules,
    setTimezone: s.setTimezone,
    setDietByDow: s.setDietByDow,
    setOverrideForDate: s.setOverrideForDate,
    clearOverrideForDate: s.clearOverrideForDate,
    setSabbath: s.setSabbath,
    generateDayTemplate: s.generateDayTemplate,
    generateFeedingSlots: s.generateFeedingSlots,
    generateWeekTemplates: s.generateWeekTemplates,
    computeFeedingWindows: s.computeFeedingWindows,
    suggestBatchCookingWindows: s.suggestBatchCookingWindows,
    exportJson: s.exportJson,
    importJson: s.importJson,
  }));
