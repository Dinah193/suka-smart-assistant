/* eslint-disable no-console */
// src/hooks/useQuietMode.js
// Reads SettingsStore quiet hours + Sabbath and exposes a guard-aware API.
// - isQuietNow / reason / window / nextChangeAt / shouldFreeze / canResume
// - guardify(fn) to wrap actions
// - saveScheduleOutsideQuietHours(...) to persist a user's own schedule at the next allowed time
//   (uses useSchedules hook when available, otherwise localStorage fallback) and adds to calendar.
//
// Works even if optional modules (stores, calendar, eventBus) are missing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ---------------------------------- Stubs ---------------------------------- */
const isBrowser = typeof window !== "undefined";

let eventBus = { emit() {}, on() {}, off() {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch {}

let pausePolicies = {
  constants: { REASON_USER: "user", REASON_SAFETY: "safety", REASON_SABBATH: "sabbath" },
  shouldFreeze: () => false,
  canContinue: () => true,
};
try {
  const mod = require("@/services/session/policies/pausePolicies");
  pausePolicies = (mod && (mod.default || mod)) || pausePolicies;
} catch {}

let useSettingsStore = () => ({
  quietHours: { start: "21:00", end: "06:30", enabled: false },
  sabbath: { enabled: false, from: "Friday 18:00", to: "Saturday 19:30" },
  rhythms: { preferMorning: true },
});
try {
  const mod = require("@/stores/settingsStore");
  useSettingsStore = (mod && (mod.default || mod.useSettingsStore)) || useSettingsStore;
} catch {}

let calendarSync = { addEvents: async () => ({ ok: true }) };
try {
  const mod = require("@/services/calendar/calendarSync");
  calendarSync = (mod && (mod.default || mod)) || calendarSync;
} catch {}

let useSchedules = () => ({ list: () => [], save: async () => ({ ok: true }) });
try {
  const mod = require("@/hooks/useSchedules");
  useSchedules = (mod && (mod.default || mod.useSchedules)) || useSchedules;
} catch {}

/* --------------------------- LocalStorage fallback -------------------------- */
const schedKey = (domain) => `${domain || "session"}:schedules`;
const localSchedAPI = (domain) => ({
  list: () => {
    if (!isBrowser) return [];
    try { return JSON.parse(localStorage.getItem(schedKey(domain)) || "[]"); } catch { return []; }
  },
  save: async (s) => {
    if (!isBrowser) return { ok: false };
    const all = localSchedAPI(domain).list();
    const next = [...all.filter((x) => x.id !== s.id), { ...s, updatedAt: Date.now() }];
    localStorage.setItem(schedKey(domain), JSON.stringify(next));
    return { ok: true };
  },
});

/* -------------------------------- Utilities -------------------------------- */
const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date();

const DAY_TO_IDX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
function parseHHMM(s = "00:00") {
  const [h, m] = (s || "").split(":").map((x) => parseInt(x, 10));
  return [(isNaN(h) ? 0 : h), (isNaN(m) ? 0 : m)];
}
function setTime(date, h, m) {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}
function parseDayTime(str) {
  // "Friday 18:00" or "Saturday 19:30"
  if (!str) return null;
  const [dayRaw, timeRaw] = String(str).split(/\s+/);
  const day = DAY_TO_IDX[(dayRaw || "").toLowerCase()];
  if (day == null) return null;
  const [h, m] = parseHHMM(timeRaw || "00:00");
  return { day, h, m };
}
function isWithinRange(nowDate, startDate, endDate) {
  return nowDate.getTime() >= startDate.getTime() && nowDate.getTime() <= endDate.getTime();
}
function nextWeekday(date, weekdayIndex) {
  const d = new Date(date);
  const diff = (7 + weekdayIndex - d.getDay()) % 7;
  if (diff === 0) d.setDate(d.getDate() + 7);
  else d.setDate(d.getDate() + diff);
  return d;
}

/* ----------------------------- Core computations ---------------------------- */
function computeQuietWindow(nowDate, quiet) {
  // Handles overnight spans (e.g., 21:00 → 06:30)
  if (!quiet?.enabled) return null;
  const [sh, sm] = parseHHMM(quiet.start || "22:00");
  const [eh, em] = parseHHMM(quiet.end || "06:00");

  const start = setTime(nowDate, sh, sm);
  const end = setTime(nowDate, eh, em);

  if (sh < eh || (sh === eh && sm < em)) {
    // Same-day window
    if (isWithinRange(nowDate, start, end)) return { start, end, reason: "quietHours" };
    // Next window times:
    const nextStart = start > nowDate ? start : new Date(start.getTime() + 24 * 3600 * 1000);
    const nextEnd = setTime(nextStart, eh, em);
    return { start: nextStart, end: nextEnd, reason: "quietHours" };
  } else {
    // Overnight window
    const endNext = end <= start ? new Date(end.getTime() + 24 * 3600 * 1000) : end;
    const inNow = nowDate >= start || nowDate <= end; // crosses midnight
    if (inNow) {
      const realEnd = nowDate >= start ? endNext : end;
      const realStart = nowDate >= start ? start : new Date(start.getTime() - 24 * 3600 * 1000);
      return { start: realStart, end: realEnd, reason: "quietHours" };
    }
    // Next occurrence
    const nextStart = start > nowDate ? start : new Date(start.getTime() + 24 * 3600 * 1000);
    const nextEnd = new Date(nextStart.getTime() + ((endNext - start + 24 * 3600 * 1000) % (24 * 3600 * 1000)));
    return { start: nextStart, end: nextEnd, reason: "quietHours" };
  }
}

function computeSabbathWindow(nowDate, sabbath) {
  if (!sabbath?.enabled) return null;
  const from = parseDayTime(sabbath.from || "Friday 18:00");
  const to = parseDayTime(sabbath.to || "Saturday 19:30");
  if (!from || !to) return null;

  // Resolve current or next Sabbath span
  // Find the most recent Sabbath start
  let start = setTime(nowDate, from.h, from.m);
  while (start.getDay() !== from.day) start.setDate(start.getDate() - 1);
  // If start is in future this week, step back one week
  if (start > nowDate) start.setDate(start.getDate() - 7);

  // End is next occurrence of "to"
  let end = new Date(start);
  while (end.getDay() !== to.day) end.setDate(end.getDate() + 1);
  end = setTime(end, to.h, to.m);
  if (end <= start) end.setDate(end.getDate() + 7);

  const inside = isWithinRange(nowDate, start, end);
  if (inside) return { start, end, reason: "sabbath" };

  // If not inside, compute next upcoming Sabbath span (for nextChangeAt)
  const nextStart = nextWeekday(nowDate, from.day);
  const realNextStart = setTime(nextStart, from.h, from.m);
  let nextEnd = new Date(realNextStart);
  while (nextEnd.getDay() !== to.day) nextEnd.setDate(nextEnd.getDate() + 1);
  nextEnd = setTime(nextEnd, to.h, to.m);

  return { start: realNextStart, end: nextEnd, reason: "sabbath" };
}

function nextChange(nowDate, activeWin) {
  if (!activeWin) return null;
  return nowDate <= activeWin.start ? activeWin.start
       : nowDate < activeWin.end ? activeWin.end
       : activeWin.start; // already past; fallback
}

/* ---------------------------------- Hook ----------------------------------- */
export function useQuietMode({ domain = "system" } = {}) {
  const { quietHours, sabbath, rhythms } = useSettingsStore();

  const [state, setState] = useState(() => {
    const n = now();
    const sab = computeSabbathWindow(n, sabbath);
    const qh = computeQuietWindow(n, quietHours);
    const sabActive = sab && isWithinRange(n, sab.start, sab.end);
    const qhActive = qh && isWithinRange(n, qh.start, qh.end);
    const active = sabActive ? sab : qhActive ? qh : null;

    return {
      isQuietNow: !!active,
      reason: active?.reason || null,
      window: active ? { from: active.start, to: active.end } : null,
      nextChangeAt: nextChange(n, active || sab || qh),
    };
  });

  // Minute-tick recompute so UI stays fresh
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const n = now();
        const sab = computeSabbathWindow(n, sabbath);
        const qh = computeQuietWindow(n, quietHours);
        const sabActive = sab && isWithinRange(n, sab.start, sab.end);
        const qhActive = qh && isWithinRange(n, qh.start, qh.end);
        const active = sabActive ? sab : qhActive ? qh : null;

        setState((prev) => {
          const next = {
            isQuietNow: !!active,
            reason: active?.reason || null,
            window: active ? { from: active.start, to: active.end } : null,
            nextChangeAt: nextChange(n, active || sab || qh),
          };
          // Light change detection
          if (
            prev.isQuietNow !== next.isQuietNow ||
            prev.reason !== next.reason ||
            (prev.window?.from?.getTime?.() || 0) !== (next.window?.from?.getTime?.() || 0) ||
            (prev.window?.to?.getTime?.() || 0) !== (next.window?.to?.getTime?.() || 0) ||
            (prev.nextChangeAt?.getTime?.() || 0) !== (next.nextChangeAt?.getTime?.() || 0)
          ) {
            return next;
          }
          return prev;
        });
      } catch (e) {
        console.warn("useQuietMode tick error:", e?.message || e);
      }
    }, 60 * 1000);

    return () => clearInterval(t);
  }, [quietHours, sabbath]);

  const shouldFreeze = useCallback(() => {
    try {
      return !!pausePolicies.shouldFreeze?.({
        domain,
        quietHours,
        sabbath,
        rhythms,
        now: new Date(),
      });
    } catch { return state.isQuietNow; }
  }, [domain, quietHours, sabbath, rhythms, state.isQuietNow]);

  const canResume = useCallback(() => {
    try {
      return !!pausePolicies.canContinue?.({
        domain,
        quietHours,
        sabbath,
        now: new Date(),
      });
    } catch { return !state.isQuietNow; }
  }, [domain, quietHours, sabbath, state.isQuietNow]);

  const guardBadge = useMemo(() => {
    if (!state.isQuietNow) return null;
    return state.reason === "sabbath" ? "Sabbath guard" : "Quiet hours";
  }, [state.isQuietNow, state.reason]);

  // Simple blocking helper
  const blockIfNeeded = useCallback(
    (actionName = "action") => {
      const frozen = shouldFreeze();
      if (!frozen) return { blocked: false };
      const reason =
        state.reason === "sabbath"
          ? "Paused by household guard (Sabbath/Quiet Hours)."
          : "Paused by quiet hours.";
      eventBus.emit("guard:block", { domain, action: actionName, reason, at: new Date().toISOString() });
      return { blocked: true, reason };
    },
    [domain, shouldFreeze, state.reason]
  );

  // Wrap any function; if guard is active, emit a pause and no-op
  const guardify = useCallback(
    (fn, { sessionId, reason = pausePolicies.constants?.REASON_SABBATH || "guard" } = {}) =>
      (...args) => {
        const frozen = shouldFreeze();
        if (frozen) {
          eventBus.emit("session:paused", { sessionId, domain, reason });
          return;
        }
        return fn?.(...args);
      },
    [domain, shouldFreeze]
  );

  // Compute the next allowed datetime after current guard window
  const nextAllowedAt = useCallback(
    (fallbackHour = 8) => {
      if (!state.isQuietNow || !state.window?.to) {
        const d = new Date();
        // snap to rhythm if desired (morning default)
        if (rhythms?.preferMorning) {
          d.setHours(fallbackHour, 0, 0, 0);
          if (d < new Date()) d.setDate(d.getDate() + 1);
        }
        return d;
      }
      const d = new Date(state.window.to);
      if (rhythms?.preferMorning) {
        d.setHours(fallbackHour, 0, 0, 0);
        if (d < state.window.to) d.setDate(d.getDate() + 1);
      }
      return d;
    },
    [rhythms?.preferMorning, state.isQuietNow, state.window?.to]
  );

  /* ---------------- Save user's schedules outside quiet hours (with RRULE) ---------------- */
  const saveScheduleOutsideQuietHours = useCallback(
    async ({ domain: dmn = domain, title = "Session Schedule", templateId, steps = [], rrule = "FREQ=WEEKLY;BYDAY=MO", firstRunAt }) => {
      const schedHook = (() => {
        try { const h = useSchedules(); if (h && typeof h.list === "function") return h; } catch {}
        return localSchedAPI(dmn);
      })();

      const base = firstRunAt ? new Date(firstRunAt) : nextAllowedAt( rhythms?.preferMorning ? 8 : new Date().getHours() + 1 );
      const sched = {
        id: `sched-${uid()}`,
        domain: dmn,
        title,
        sessionTemplate: { templateId, steps },
        rrule,
        firstRunAt: base.toISOString(),
      };

      const res = await (schedHook.save?.(sched) || Promise.resolve({ ok: false }));
      if (res?.ok) {
        eventBus.emit("schedules:changed", { domain: dmn });
        try {
          await calendarSync.addEvents?.({
            domain: dmn,
            title: sched.title,
            rrule: sched.rrule,
            firstRunAt: sched.firstRunAt,
            meta: { sessionTemplateId: sched.id, source: "useQuietMode" },
          });
        } catch {}
      }
      return res;
    },
    [calendarSync, domain, nextAllowedAt, rhythms?.preferMorning]
  );

  return {
    // Guard state
    isQuietNow: state.isQuietNow,
    reason: state.reason, // "sabbath" | "quietHours" | null
    window: state.window, // { from: Date, to: Date } | null
    nextChangeAt: state.nextChangeAt, // Date | null
    guardBadge,

    // Guard helpers
    shouldFreeze,
    canResume,
    blockIfNeeded,
    guardify,
    nextAllowedAt,

    // Persistence helper (user-owned schedules; hook or localStorage)
    saveScheduleOutsideQuietHours,
  };
}

export default useQuietMode;
