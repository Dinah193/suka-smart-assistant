// src/services/scheduling/sessionScheduler.js
/* eslint-disable no-console */

/**
 * SessionScheduler
 * -----------------------------------------------------------------------------
 * Shared time + recurrence logic for ALL session engines.
 *
 * Responsibilities:
 *  - Keep a registry of scheduled sessions (user + system)
 *  - Normalize schedule definitions (one place)
 *  - Emit automation-compatible events so your in-app runtime can run them
 *  - Support "reverse" runs: when the schedule fires, it can call
 *      engine.createFromReverse(...) instead of engine.createFromSource(...)
 *  - Respect quiet hours (non-blocking but signaled)
 *  - Persist schedules to Dexie (preferred) or localStorage (fallback)
 *
 * This sits *under* engines like:
 *  - InventorySessionEngine
 *  - MealPlanEngine
 *  - GardenQueueManager
 *  - AnimalQueueManager
 *  - CleaningPlanManager
 *
 * and *alongside*:
 *  - src/services/automation/runtime.js
 */

import DexieDB from "@/db";

const isBrowser = typeof window !== "undefined";
const nowISO = () => new Date().toISOString();
const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/* -------------------------------------------------------------------------- */
/* event bridge                                                               */
/* -------------------------------------------------------------------------- */
const emitGlobal = (type, detail = {}) => {
  if (isBrowser) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
    try {
      const bus = window.__suka?.eventBus;
      if (bus?.emit) bus.emit(type, detail);
    } catch {
      /* noop */
    }
  }
};

/* -------------------------------------------------------------------------- */
/* quiet / sabbath guard (soft)                                              */
/* -------------------------------------------------------------------------- */
const respectQuietHours = () => {
  try {
    const globalConfig = isBrowser ? window.__suka?.config ?? {} : {};
    const quiet = globalConfig.quietHours || {};
    if (!quiet.enabled) return true;

    const hour = new Date().getHours();
    const start = quiet.start ?? 21;
    const end = quiet.end ?? 7;
    const within =
      start < end ? hour >= start && hour < end : hour >= start || hour < end;

    if (within) {
      emitGlobal("suka:quiet-hours:blocked", {
        reason: "session-scheduler",
      });
    }
    return !within;
  } catch (err) {
    console.warn("[SessionScheduler] quiet-hours check failed", err);
    return true;
  }
};

/* -------------------------------------------------------------------------- */
/* normalization                                                              */
/* -------------------------------------------------------------------------- */
/**
 * We support a simple JSON schedule shape:
 *
 * {
 *   "id": "...",                         // optional
 *   "label": "My inventory run",
 *   "domain": "inventory",
 *   "sessionId": "inv_sess_...",
 *   "userOwned": true,
 *   "mode": "source" | "reverse",        // how to run when time comes
 *   "engineHint": "inventory",           // which engine to ask
 *   "startAt": "2025-10-30T18:00:00.000Z",
 *   "timeOfDay": "18:00",                // local
 *   "tz": "America/Chicago",
 *   "recurrence": {
 *     "freq": "DAILY" | "WEEKLY" | "MONTHLY",
 *     "interval": 1,                     // every 1 day, every 2 weeks, etc.
 *     "byDay": ["MO","WE"],              // for WEEKLY
 *     "byMonthDay": [1,15],              // for MONTHLY
 *   },
 *   "meta": {}
 * }
 */
const normalizeSchedule = (def = {}) => {
  const id = def.id || `sched_${genId()}`;
  const now = new Date();
  const todayISO = now.toISOString();
  // default start today
  return {
    id,
    label: def.label || "Scheduled session",
    domain: def.domain || "session",
    sessionId: def.sessionId || null,
    userOwned: def.userOwned ?? true,
    mode: def.mode || "source", // or "reverse"
    engineHint: def.engineHint || def.domain || "session",
    startAt: def.startAt || todayISO,
    timeOfDay: def.timeOfDay || null,
    tz: def.tz || (isBrowser ? Intl.DateTimeFormat().resolvedOptions().timeZone : "America/Chicago"),
    recurrence: {
      freq: (def.recurrence && def.recurrence.freq) || "DAILY",
      interval: (def.recurrence && def.recurrence.interval) || 1,
      byDay: (def.recurrence && def.recurrence.byDay) || null,
      byMonthDay: (def.recurrence && def.recurrence.byMonthDay) || null,
    },
    meta: {
      ...(def.meta || {}),
    },
    createdAt: def.createdAt || nowISO(),
    updatedAt: nowISO(),
  };
};

/* -------------------------------------------------------------------------- */
/* next-run calculator                                                        */
/* -------------------------------------------------------------------------- */
/**
 * Given a normalized schedule, compute the next time it should run.
 * This is intentionally simple and JS-only; engines / runtime can override.
 */
const computeNextRun = (sched) => {
  const now = new Date();
  const base = new Date(sched.startAt || now.toISOString());
  let candidate = base;

  const { freq, interval, byDay, byMonthDay } = sched.recurrence || {};

  // apply timeOfDay if present
  if (sched.timeOfDay) {
    const [hh, mm] = sched.timeOfDay.split(":").map((n) => parseInt(n, 10));
    candidate.setHours(hh, mm || 0, 0, 0);
  }

  // if candidate is in the past, advance according to freq
  while (candidate <= now) {
    if (freq === "DAILY") {
      candidate.setDate(candidate.getDate() + (interval || 1));
    } else if (freq === "WEEKLY") {
      // weekly can have byDay
      if (Array.isArray(byDay) && byDay.length) {
        // step by 1 day until we hit a target weekday
        const targetWeekdays = byDay.map(dayToIdx);
        let advanced = false;
        for (let i = 0; i < 7; i += 1) {
          candidate.setDate(candidate.getDate() + 1);
          const wd = candidate.getDay();
          if (targetWeekdays.includes(wd)) {
            advanced = true;
            break;
          }
        }
        if (!advanced) {
          candidate.setDate(candidate.getDate() + 7 * (interval || 1));
        }
      } else {
        candidate.setDate(candidate.getDate() + 7 * (interval || 1));
      }
    } else if (freq === "MONTHLY") {
      if (Array.isArray(byMonthDay) && byMonthDay.length) {
        // move to next month and pick first matching day
        candidate.setMonth(candidate.getMonth() + (interval || 1), 1);
        candidate.setDate(byMonthDay[0]);
      } else {
        candidate.setMonth(candidate.getMonth() + (interval || 1));
      }
    } else {
      // default daily
      candidate.setDate(candidate.getDate() + (interval || 1));
    }
  }

  return candidate.toISOString();
};

const dayToIdx = (abbr) => {
  switch (abbr) {
    case "SU":
      return 0;
    case "MO":
      return 1;
    case "TU":
      return 2;
    case "WE":
      return 3;
    case "TH":
      return 4;
    case "FR":
      return 5;
    case "SA":
      return 6;
    default:
      return 0;
  }
};

/* -------------------------------------------------------------------------- */
/* main class                                                                 */
/* -------------------------------------------------------------------------- */
export class SessionScheduler {
  constructor(opts = {}) {
    this.tableName = opts.tableName || "sessionSchedules";
    this.allowLocalStorageFallback = opts.allowLocalStorageFallback ?? true;
    this.table = this._getTable(this.tableName);

    // listen for automation-like events coming from engines
    if (isBrowser) {
      window.addEventListener(
        "automation:schedule:register",
        (ev) => this._onAutomationRegister(ev.detail)
      );
    }
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: register (primary entry point)                                   */
  /* ------------------------------------------------------------------------ */
  async register(scheduleDef) {
    const normalized = normalizeSchedule(scheduleDef);
    await this._persist(normalized);
    emitGlobal("scheduling:registered", { schedule: normalized });
    return normalized;
  }

  /**
   * Alias used by engines (so you can do engine.scheduleSession → emits automation:schedule:register)
   */
  async _onAutomationRegister(payload = {}) {
    // payload = { id, kind, schedule, payload: session }
    if (!payload?.schedule) return;
    const scheduleDef = {
      id: payload.id || undefined,
      label: payload.payload?.label || `${payload.kind} schedule`,
      domain: payload.kind?.replace("-session", "") || "session",
      sessionId: payload.payload?.id || null,
      userOwned: payload.payload?.ownedByUser ?? true,
      engineHint: payload.kind?.replace("-session", "") || "session",
      ...payload.schedule,
      meta: {
        ...(payload.schedule?.meta || {}),
        fromEngine: payload.kind,
      },
    };
    await this.register(scheduleDef);
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: runDue (to be called by your automation runtime tick)            */
  /* ------------------------------------------------------------------------ */
  /**
   * runDue(now = new Date())
   *  - find all schedules
   *  - for each, check if it's due
   *  - if due → emit domain run event
   */
  async runDue(now = new Date()) {
    const all = await this.list();
    const tsNow = now.getTime();

    for (const sched of all) {
      const nextRunIso = computeNextRun(sched);
      const nextRunTs = new Date(nextRunIso).getTime();

      // if next run is within the last X mins or right now, we execute
      if (Math.abs(nextRunTs - tsNow) < 60_000) {
        await this._executeSchedule(sched);
        // bump updatedAt so next computeNextRun will move forward
        sched.startAt = nextRunIso;
        sched.updatedAt = nowISO();
        await this._persist(sched);
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: list / get / delete                                              */
  /* ------------------------------------------------------------------------ */
  async list() {
    if (this.table) return this.table.toArray();
    if (this.allowLocalStorageFallback && isBrowser) {
      const prev = JSON.parse(
        localStorage.getItem("suka:session-schedules") || "[]"
      );
      return prev;
    }
    return [];
  }

  async get(id) {
    if (!id) return null;
    if (this.table) return this.table.get(id);
    if (this.allowLocalStorageFallback && isBrowser) {
      const prev = JSON.parse(
        localStorage.getItem("suka:session-schedules") || "[]"
      );
      return prev.find((s) => s.id === id) || null;
    }
    return null;
  }

  async remove(id) {
    if (!id) return;
    if (this.table) {
      await this.table.delete(id);
    } else if (this.allowLocalStorageFallback && isBrowser) {
      const prev = JSON.parse(
        localStorage.getItem("suka:session-schedules") || "[]"
      );
      const next = prev.filter((s) => s.id !== id);
      localStorage.setItem("suka:session-schedules", JSON.stringify(next));
    }
    emitGlobal("scheduling:removed", { id });
  }

  /* ------------------------------------------------------------------------ */
  /* INTERNAL: execute a schedule                                             */
  /* ------------------------------------------------------------------------ */
  async _executeSchedule(sched) {
    const ok = respectQuietHours();
    const payload = {
      schedule: sched,
      runAt: nowISO(),
    };

    // mode decides what we emit
    if (sched.mode === "reverse") {
      // tell domain engines to create from reverse
      emitGlobal(`${sched.domain}:session:run:reverse`, payload);
    } else {
      // standard “run this session”
      emitGlobal(`${sched.domain}:session:run`, payload);
    }

    // also tell the automation runtime (if it wants to log it)
    emitGlobal("automation:run:session", {
      ...payload,
      domain: sched.domain,
      sessionId: sched.sessionId,
    });

    // and tell UIs to refresh
    this._emitLinkedDomainRefresh(sched.domain);

    if (!ok) {
      emitGlobal("scheduling:executed:during-quiet-hours", { schedule: sched });
    }
  }

  _emitLinkedDomainRefresh(domain) {
    // same pattern as in SessionEngineCore
    emitGlobal("meals:needs-refresh", {
      reason: `${domain}-schedule-executed`,
    });
    emitGlobal("garden:needs-refresh", {
      reason: `${domain}-schedule-executed`,
    });
    emitGlobal("animals:needs-refresh", {
      reason: `${domain}-schedule-executed`,
    });
    emitGlobal("cleaning:needs-refresh", {
      reason: `${domain}-schedule-executed`,
    });
    emitGlobal("inventory:needs-refresh", {
      reason: `${domain}-schedule-executed`,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* INTERNAL: persistence                                                    */
  /* ------------------------------------------------------------------------ */
  _getTable(name) {
    try {
      return DexieDB?.[name] ?? null;
    } catch (err) {
      console.warn("[SessionScheduler] Dexie table not available:", name, err);
      return null;
    }
  }

  async _persist(schedule) {
    if (this.table) {
      await this.table.put(schedule);
    } else if (this.allowLocalStorageFallback && isBrowser) {
      const prev = JSON.parse(
        localStorage.getItem("suka:session-schedules") || "[]"
      );
      const idx = prev.findIndex((s) => s.id === schedule.id);
      if (idx > -1) prev[idx] = schedule;
      else prev.push(schedule);
      localStorage.setItem("suka:session-schedules", JSON.stringify(prev));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* singleton                                                                  */
/* -------------------------------------------------------------------------- */
let __sessionScheduler;
export const getSessionScheduler = (opts = {}) => {
  if (!__sessionScheduler) {
    __sessionScheduler = new SessionScheduler(opts);
  }
  return __sessionScheduler;
};
