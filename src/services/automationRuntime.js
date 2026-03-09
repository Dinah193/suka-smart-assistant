// File: src/services/automationRuntime.js
/**
 * AutomationRuntime (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Browser-safe automation/task scheduler for SSA (no Node APIs).
 *  - Runs "automations" (recurring rules + conditional checks) and emits events.
 *  - Persists to storage (Dexie if injected, otherwise localStorage).
 *  - Integrates with ReminderManager for user-facing notifications (optional).
 *
 * Design goals
 *  - Production-safe: never crash the app if optional deps aren't available.
 *  - Deterministic: computes nextRunAt, supports pause/enable/disable.
 *  - Extensible: supports rule-based triggers and custom handlers.
 *
 * Common SSA usage patterns
 *  - Session alerts (prep/clean/cook sessions)
 *  - Daily/weekly rhythms (meal planning cadence)
 *  - Background checks (inventory low, receipts pending, etc.)
 *
 * Event topics emitted (if bus exists)
 *  - automation.runtime.started
 *  - automation.runtime.stopped
 *  - automation.registered
 *  - automation.updated
 *  - automation.removed
 *  - automation.fired
 *  - automation.skipped
 *  - automation.error
 *
 * Notes
 *  - This runtime is NOT a service worker. It only runs while the page is alive.
 *  - For “true background” you’d pair this with a SW or OS scheduling.
 */

import ReminderManager from "@/services/notifications/ReminderManager";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

const SOURCE = "services.automationRuntime";

const DEFAULT_STORAGE_KEY = "ssa.automationRuntime.v1";
const DEFAULT_TICK_MS = 15_000; // 15s: responsive without being noisy
const MIN_CHECK_INTERVAL_MS = 5_000;

function nowMs() {
  return Date.now();
}

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function safeJsonStringify(obj, fallback = "null") {
  try {
    return JSON.stringify(obj);
  } catch {
    return fallback;
  }
}

function asISO(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Very small "bus" adapter:
 *  - If you inject your SSA eventBus with .emit(topic, payload), we use it.
 *  - Otherwise we use a local EventTarget (subscribe via .on/.off).
 */
function createLocalBus() {
  const et = new EventTarget();
  return {
    emit(topic, payload) {
      try {
        et.dispatchEvent(new CustomEvent(topic, { detail: payload }));
      } catch {
        // ignore
      }
    },
    on(topic, fn) {
      try {
        et.addEventListener(topic, fn);
      } catch {
        // ignore
      }
    },
    off(topic, fn) {
      try {
        et.removeEventListener(topic, fn);
      } catch {
        // ignore
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Scheduling: Supported Trigger Shapes                                       */
/* -------------------------------------------------------------------------- */
/**
 * Trigger types supported:
 *
 * 1) Once:
 *    { kind: "once", atISO: "2026-01-03T12:00:00.000Z" }
 *
 * 2) Interval:
 *    { kind: "interval", everyMs: 3600000, jitterMs?: 60000, startAtISO?: ISO }
 *
 * 3) Weekly simple:
 *    { kind: "weekly", days: [0..6], at: "HH:MM", timezone?: "America/Chicago" }
 *
 * 4) Daily simple:
 *    { kind: "daily", at: "HH:MM", timezone?: "America/Chicago" }
 *
 * 5) RRULE (minimal subset):
 *    { kind: "rrule", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0" }
 *
 * 6) Manual:
 *    { kind: "manual" }  // never auto-fires; only runNow()
 *
 * Conditional checks:
 *  - automation.condition(context) => boolean | Promise<boolean>
 */

function parseHHMM(hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  return { hh, mm };
}

/**
 * Compute local wall-clock fields for a timestamp in a target IANA timezone.
 * Uses Intl.DateTimeFormat (browser-safe).
 */
function getZonedParts(ms, timeZone) {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = dtf.formatToParts(new Date(ms));
  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }

  // weekday short: Sun/Mon/...
  const wd = out.weekday;
  const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    wd
  );

  return {
    tz,
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    dayIndex: dayIndex >= 0 ? dayIndex : null,
  };
}

/**
 * Convert a zoned "YYYY-MM-DD HH:MM:SS" into a UTC timestamp (ms).
 * We do this by asking Intl for offsets indirectly via Date parsing loops.
 *
 * Strategy:
 *  - Create a "fake" Date in UTC for that wall time.
 *  - Then find the real UTC time that formats to the same wall time in tz.
 *
 * This is accurate enough for scheduling daily/weekly alarms.
 */
function zonedWallTimeToUtcMs(
  { year, month, day, hour, minute, second },
  timeZone
) {
  // Start with "as if UTC"
  const guess = Date.UTC(year, month - 1, day, hour, minute, second || 0);

  // Refine: find delta between desired wall time and wall time at guess in tz
  const parts = getZonedParts(guess, timeZone);
  const wallAtGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0
  );
  const desiredWall = Date.UTC(year, month - 1, day, hour, minute, second || 0);

  const delta = desiredWall - wallAtGuess;
  return guess + delta;
}

function parseRRule(rrule) {
  if (typeof rrule !== "string" || !rrule.trim()) return null;
  // Minimal key=value;key=value parser
  const out = {};
  const chunks = rrule.trim().split(";");
  for (const c of chunks) {
    const [k, v] = c.split("=");
    if (!k || !v) continue;
    out[k.trim().toUpperCase()] = v.trim();
  }
  if (!out.FREQ) return null;

  // We support FREQ=DAILY|WEEKLY and BYHOUR/BYMINUTE/BYSECOND and BYDAY for WEEKLY.
  const freq = out.FREQ.toUpperCase();
  if (!["DAILY", "WEEKLY"].includes(freq)) return null;

  const byHour = out.BYHOUR != null ? Number(out.BYHOUR) : null;
  const byMinute = out.BYMINUTE != null ? Number(out.BYMINUTE) : null;
  const bySecond = out.BYSECOND != null ? Number(out.BYSECOND) : 0;

  const byDay =
    out.BYDAY != null
      ? out.BYDAY.split(",").map((d) => d.trim().toUpperCase())
      : null;

  return {
    freq,
    byHour: Number.isFinite(byHour) ? clamp(byHour, 0, 23) : null,
    byMinute: Number.isFinite(byMinute) ? clamp(byMinute, 0, 59) : null,
    bySecond: Number.isFinite(bySecond) ? clamp(bySecond, 0, 59) : 0,
    byDay,
  };
}

function weekdayTokenToIndex(tok) {
  const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  return map[tok] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Quiet Hours / Sabbath Guards                                               */
/* -------------------------------------------------------------------------- */
/**
 * quietHours:
 *  - { start: "HH:MM", end: "HH:MM", timezone?: "America/Chicago" }
 *  - If start=end => disabled
 *  - Range can wrap over midnight.
 *
 * sabbath:
 *  - { enabled: true, day: 6 }  // 6=Saturday
 *  - OR { enabled: true, days: [5,6] } // e.g. Fri+Sat
 */
function isInQuietHours(ms, quietHours) {
  if (!quietHours) return false;
  const { start, end, timezone } = quietHours;
  const a = parseHHMM(start);
  const b = parseHHMM(end);
  if (!a || !b) return false;
  if (a.hh === b.hh && a.mm === b.mm) return false;

  const parts = getZonedParts(ms, timezone);
  const cur = parts.hour * 60 + parts.minute;
  const s = a.hh * 60 + a.mm;
  const e = b.hh * 60 + b.mm;

  if (s < e) return cur >= s && cur < e; // same-day window
  // wraps midnight
  return cur >= s || cur < e;
}

function isInSabbath(ms, sabbath, timezone) {
  if (!sabbath || !sabbath.enabled) return false;
  const parts = getZonedParts(ms, timezone);
  const di = parts.dayIndex;
  if (di == null) return false;
  const days = Array.isArray(sabbath.days)
    ? sabbath.days
    : isFiniteNumber(sabbath.day)
    ? [sabbath.day]
    : [];
  return days.includes(di);
}

/* -------------------------------------------------------------------------- */
/* Storage Adapters                                                           */
/* -------------------------------------------------------------------------- */

function createLocalStorageAdapter(storageKey = DEFAULT_STORAGE_KEY) {
  return {
    kind: "localStorage",
    async loadAll() {
      const raw = localStorage.getItem(storageKey);
      const parsed = safeJsonParse(raw, null);
      if (!parsed || typeof parsed !== "object") return [];
      const list = Array.isArray(parsed.items) ? parsed.items : [];
      return list;
    },
    async saveAll(items) {
      const payload = { v: 1, savedAtISO: new Date().toISOString(), items };
      localStorage.setItem(
        storageKey,
        safeJsonStringify(payload, '{"v":1,"items":[]}')
      );
    },
  };
}

/**
 * Dexie adapter contract (inject this if you have it):
 *  - { kind:"dexie", loadAll: async()=>[], saveAll: async(items)=>void }
 *
 * If you want to persist per-item, you can still do it via saveAll inside.
 */

/* -------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* -------------------------------------------------------------------------- */

function defaultId(prefix = "auto") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

/**
 * @typedef {Object} AutomationDefinition
 * @property {string} id
 * @property {string} name
 * @property {boolean=} enabled
 * @property {Object} trigger
 * @property {number=} priority
 * @property {string=} group
 * @property {Object=} meta
 * @property {function(any): (boolean|Promise<boolean>)=} condition
 * @property {function(any): (any|Promise<any>)=} handler
 * @property {Object=} notification
 * @property {string=} notification.title
 * @property {string=} notification.body
 * @property {string=} notification.tag
 */

export class AutomationRuntime {
  /**
   * @param {Object} opts
   * @param {any=} opts.bus SSA eventBus-like instance (must support emit(topic,payload))
   * @param {any=} opts.storage Storage adapter; defaults to localStorage
   * @param {string=} opts.timezone IANA timezone (defaults to browser tz)
   * @param {Object=} opts.quietHours Quiet hours window
   * @param {Object=} opts.sabbath Sabbath guard
   * @param {number=} opts.tickMs Scheduler tick interval
   */
  constructor(opts = {}) {
    this._bus =
      opts.bus && typeof opts.bus.emit === "function"
        ? opts.bus
        : createLocalBus();
    this._storage =
      opts.storage || createLocalStorageAdapter(DEFAULT_STORAGE_KEY);
    this._timezone =
      opts.timezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "UTC";

    this._quietHours = opts.quietHours || null;
    this._sabbath = opts.sabbath || null;

    this._tickMs = clamp(
      isFiniteNumber(opts.tickMs) ? opts.tickMs : DEFAULT_TICK_MS,
      MIN_CHECK_INTERVAL_MS,
      120_000
    );

    this._items = new Map(); // id -> automation record
    this._timer = null;
    this._hydrated = false;
    this._running = false;

    this._inflight = new Set(); // ids currently executing
    this._lastTickAt = 0;

    // Optional hooks
    this._contextProvider = null; // () => any
  }

  /* ------------------------------ lifecycle -------------------------------- */

  /**
   * Hydrate from storage once.
   */
  async hydrate() {
    if (this._hydrated) return;
    const list = await this._storage.loadAll();
    for (const rec of list) {
      const normalized = this._normalizeRecord(rec);
      if (normalized) this._items.set(normalized.id, normalized);
    }
    this._hydrated = true;
  }

  /**
   * Start the scheduler.
   */
  async start() {
    await this.hydrate();
    if (this._running) return;

    this._running = true;
    this._bus.emit("automation.runtime.started", {
      source: SOURCE,
      atISO: new Date().toISOString(),
      tickMs: this._tickMs,
      timezone: this._timezone,
    });

    this._timer = window.setInterval(() => {
      this._tick().catch((err) => {
        this._bus.emit("automation.error", {
          source: SOURCE,
          stage: "tick",
          error: String(err?.message || err),
        });
      });
    }, this._tickMs);

    // run an immediate tick so “due now” fires quickly
    await this._tick();
  }

  /**
   * Stop scheduler.
   */
  stop() {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = null;
    this._running = false;

    this._bus.emit("automation.runtime.stopped", {
      source: SOURCE,
      atISO: new Date().toISOString(),
    });
  }

  isRunning() {
    return !!this._running;
  }

  /* ------------------------------ config ----------------------------------- */

  setTimezone(tz) {
    if (typeof tz === "string" && tz.trim()) this._timezone = tz.trim();
  }

  setQuietHours(quietHours) {
    this._quietHours = quietHours || null;
  }

  setSabbath(sabbath) {
    this._sabbath = sabbath || null;
  }

  /**
   * Provide shared context on each evaluation:
   *  - householdId, user prefs, feature flags, etc.
   * @param {function():any} fn
   */
  setContextProvider(fn) {
    this._contextProvider = typeof fn === "function" ? fn : null;
  }

  /* ------------------------------ CRUD ------------------------------------- */

  /**
   * Register (or replace) an automation.
   * @param {Partial<AutomationDefinition> & {name:string, trigger:Object}} def
   * @returns {Promise<string>} id
   */
  async register(def) {
    await this.hydrate();

    const id = (def && def.id) || defaultId("auto");
    const existing = this._items.get(id);

    const record = this._normalizeRecord({
      id,
      name: String(def?.name || existing?.name || "Automation"),
      enabled: def?.enabled ?? existing?.enabled ?? true,
      trigger: def?.trigger || existing?.trigger || { kind: "manual" },
      priority: isFiniteNumber(def?.priority)
        ? def.priority
        : existing?.priority ?? 0,
      group: def?.group || existing?.group || null,
      meta: def?.meta || existing?.meta || {},
      notification: def?.notification || existing?.notification || null,
      // functions cannot be persisted; store them in memory only
      _fn: {
        condition:
          typeof def?.condition === "function"
            ? def.condition
            : existing?._fn?.condition,
        handler:
          typeof def?.handler === "function"
            ? def.handler
            : existing?._fn?.handler,
      },
      state: {
        createdAtISO: existing?.state?.createdAtISO || new Date().toISOString(),
        updatedAtISO: new Date().toISOString(),
        lastRunAtISO: existing?.state?.lastRunAtISO || null,
        lastResult: existing?.state?.lastResult || null,
        lastError: existing?.state?.lastError || null,
        runs: existing?.state?.runs ?? 0,
        skips: existing?.state?.skips ?? 0,
      },
      schedule: {
        nextRunAtMs: null, // computed
      },
    });

    record.schedule.nextRunAtMs =
      this._computeNextRunAtMs(record, nowMs()) ?? record.schedule.nextRunAtMs;

    this._items.set(id, record);
    await this._persist();

    this._bus.emit("automation.registered", {
      source: SOURCE,
      id,
      name: record.name,
      enabled: record.enabled,
      trigger: record.trigger,
      nextRunAtISO: record.schedule.nextRunAtMs
        ? asISO(record.schedule.nextRunAtMs)
        : null,
    });

    return id;
  }

  /**
   * Update persisted fields (not functions). For functions, call register() again with condition/handler.
   */
  async update(id, patch = {}) {
    await this.hydrate();
    const cur = this._items.get(id);
    if (!cur) return false;

    const next = this._normalizeRecord({
      ...cur,
      name: patch.name != null ? String(patch.name) : cur.name,
      enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
      trigger: patch.trigger || cur.trigger,
      priority: isFiniteNumber(patch.priority) ? patch.priority : cur.priority,
      group: patch.group !== undefined ? patch.group : cur.group,
      meta: patch.meta !== undefined ? patch.meta : cur.meta,
      notification:
        patch.notification !== undefined
          ? patch.notification
          : cur.notification,
      state: {
        ...cur.state,
        updatedAtISO: new Date().toISOString(),
      },
    });

    next.schedule.nextRunAtMs = this._computeNextRunAtMs(next, nowMs());

    this._items.set(id, next);
    await this._persist();

    this._bus.emit("automation.updated", {
      source: SOURCE,
      id,
      enabled: next.enabled,
      nextRunAtISO: next.schedule.nextRunAtMs
        ? asISO(next.schedule.nextRunAtMs)
        : null,
    });

    return true;
  }

  async remove(id) {
    await this.hydrate();
    const existed = this._items.delete(id);
    if (!existed) return false;
    await this._persist();
    this._bus.emit("automation.removed", { source: SOURCE, id });
    return true;
  }

  async enable(id, isEnabled = true) {
    return this.update(id, { enabled: !!isEnabled });
  }

  list() {
    const out = [];
    for (const rec of this._items.values()) {
      out.push(this._publicView(rec));
    }
    // stable order: enabled first, then next run, then priority desc
    out.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const ar = a.nextRunAtMs ?? Number.POSITIVE_INFINITY;
      const br = b.nextRunAtMs ?? Number.POSITIVE_INFINITY;
      if (ar !== br) return ar - br;
      return (b.priority || 0) - (a.priority || 0);
    });
    return out;
  }

  get(id) {
    const rec = this._items.get(id);
    return rec ? this._publicView(rec) : null;
  }

  /* ------------------------------ execution -------------------------------- */

  /**
   * Force-run an automation immediately (ignores schedule, but respects enabled if you want).
   * @param {string} id
   * @param {Object=} opts
   * @param {boolean=} opts.ignoreEnabled
   * @param {boolean=} opts.ignoreGuards
   * @param {any=} opts.context
   */
  async runNow(id, opts = {}) {
    await this.hydrate();
    const rec = this._items.get(id);
    if (!rec) return { ok: false, error: "NOT_FOUND" };

    if (!opts.ignoreEnabled && !rec.enabled) {
      return { ok: false, error: "DISABLED" };
    }

    const context =
      opts.context ??
      (this._contextProvider ? this._contextProvider() : null) ??
      {};

    return this._execute(rec, {
      reason: "manual",
      now: nowMs(),
      ignoreGuards: !!opts.ignoreGuards,
      context,
    });
  }

  /* ------------------------------ internals -------------------------------- */

  _publicView(rec) {
    return {
      id: rec.id,
      name: rec.name,
      enabled: !!rec.enabled,
      trigger: rec.trigger,
      priority: rec.priority || 0,
      group: rec.group || null,
      meta: rec.meta || {},
      notification: rec.notification || null,
      nextRunAtMs: rec.schedule?.nextRunAtMs ?? null,
      nextRunAtISO: rec.schedule?.nextRunAtMs
        ? asISO(rec.schedule.nextRunAtMs)
        : null,
      state: { ...(rec.state || {}) },
    };
  }

  _normalizeRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id =
      typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;
    if (!id) return null;

    const trigger =
      raw.trigger && typeof raw.trigger === "object"
        ? raw.trigger
        : { kind: "manual" };
    const name =
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : "Automation";

    // _fn holds live (non-persisted) functions
    const _fn = raw._fn && typeof raw._fn === "object" ? raw._fn : {};

    return {
      id,
      name,
      enabled: raw.enabled !== false, // default true
      trigger,
      priority: isFiniteNumber(raw.priority) ? raw.priority : 0,
      group: raw.group ?? null,
      meta: raw.meta && typeof raw.meta === "object" ? raw.meta : {},
      notification:
        raw.notification && typeof raw.notification === "object"
          ? raw.notification
          : null,
      _fn: {
        condition:
          typeof _fn.condition === "function" ? _fn.condition : undefined,
        handler: typeof _fn.handler === "function" ? _fn.handler : undefined,
      },
      state: {
        createdAtISO: raw.state?.createdAtISO || new Date().toISOString(),
        updatedAtISO: raw.state?.updatedAtISO || new Date().toISOString(),
        lastRunAtISO: raw.state?.lastRunAtISO || null,
        lastResult: raw.state?.lastResult || null,
        lastError: raw.state?.lastError || null,
        runs: isFiniteNumber(raw.state?.runs) ? raw.state.runs : 0,
        skips: isFiniteNumber(raw.state?.skips) ? raw.state.skips : 0,
      },
      schedule: {
        nextRunAtMs: isFiniteNumber(raw.schedule?.nextRunAtMs)
          ? raw.schedule.nextRunAtMs
          : null,
      },
    };
  }

  async _persist() {
    const items = [];
    for (const rec of this._items.values()) {
      // strip functions for persistence
      const { _fn, ...persistable } = rec;
      items.push(persistable);
    }
    await this._storage.saveAll(items);
  }

  async _tick() {
    if (!this._running) return;

    const t = nowMs();
    // Avoid re-entrancy if a tick runs long
    if (t - this._lastTickAt < Math.floor(this._tickMs / 2)) return;
    this._lastTickAt = t;

    // Respect global guards for scheduled triggers
    const inQuiet = isInQuietHours(t, this._quietHours);
    const inSabbath = isInSabbath(t, this._sabbath, this._timezone);

    const contextBase =
      (this._contextProvider ? this._contextProvider() : null) || {};

    const due = [];
    for (const rec of this._items.values()) {
      if (!rec.enabled) continue;
      if (this._inflight.has(rec.id)) continue;

      const next = rec.schedule?.nextRunAtMs;
      if (!isFiniteNumber(next)) {
        rec.schedule.nextRunAtMs = this._computeNextRunAtMs(rec, t);
      }
      if (
        isFiniteNumber(rec.schedule.nextRunAtMs) &&
        rec.schedule.nextRunAtMs <= t
      ) {
        due.push(rec);
      }
    }

    if (!due.length) return;

    // Prioritize: higher priority first, then oldest nextRunAt
    due.sort((a, b) => {
      const pa = a.priority || 0;
      const pb = b.priority || 0;
      if (pa !== pb) return pb - pa;
      return (a.schedule?.nextRunAtMs || 0) - (b.schedule?.nextRunAtMs || 0);
    });

    for (const rec of due) {
      // If in quiet hours/sabbath, we skip firing but keep schedule moving forward.
      if (inQuiet || inSabbath) {
        rec.state.skips = (rec.state.skips || 0) + 1;
        rec.state.lastError = null;
        rec.state.lastResult = inQuiet ? "SKIP_QUIET_HOURS" : "SKIP_SABBATH";
        rec.state.updatedAtISO = new Date().toISOString();

        rec.schedule.nextRunAtMs = this._computeNextRunAtMs(rec, t + 1000);

        this._bus.emit("automation.skipped", {
          source: SOURCE,
          id: rec.id,
          name: rec.name,
          reason: inQuiet ? "quietHours" : "sabbath",
          atISO: new Date().toISOString(),
          nextRunAtISO: rec.schedule.nextRunAtMs
            ? asISO(rec.schedule.nextRunAtMs)
            : null,
        });

        continue;
      }

      // Execute (await sequentially to avoid stampedes)
      await this._execute(rec, {
        reason: "scheduled",
        now: t,
        ignoreGuards: false,
        context: contextBase,
      });
    }

    await this._persist();
  }

  async _execute(rec, { reason, now, ignoreGuards, context }) {
    this._inflight.add(rec.id);

    const startedAtMs = nowMs();
    const payloadBase = {
      source: SOURCE,
      id: rec.id,
      name: rec.name,
      reason,
      startedAtISO: asISO(startedAtMs),
    };

    try {
      // Condition gate
      const condFn = rec._fn?.condition;
      if (condFn) {
        let ok = false;
        try {
          ok = await condFn({ ...context, automation: this._publicView(rec) });
        } catch (e) {
          ok = false;
          this._bus.emit("automation.error", {
            ...payloadBase,
            stage: "condition",
            error: String(e?.message || e),
          });
        }
        if (!ok) {
          rec.state.skips = (rec.state.skips || 0) + 1;
          rec.state.lastResult = "CONDITION_FALSE";
          rec.state.lastError = null;
          rec.state.updatedAtISO = new Date().toISOString();

          // Move schedule forward so we don't hammer
          if (reason !== "manual") {
            rec.schedule.nextRunAtMs = this._computeNextRunAtMs(
              rec,
              startedAtMs + 1000
            );
          }

          this._bus.emit("automation.skipped", {
            ...payloadBase,
            reason: "condition",
            finishedAtISO: asISO(nowMs()),
            nextRunAtISO: rec.schedule.nextRunAtMs
              ? asISO(rec.schedule.nextRunAtMs)
              : null,
          });

          return { ok: true, skipped: true, reason: "condition" };
        }
      }

      // Handler
      const handlerFn = rec._fn?.handler;
      let result = null;

      if (handlerFn) {
        result = await handlerFn({
          ...context,
          automation: this._publicView(rec),
        });
      } else {
        // If no handler, we still "fire" (useful for pure notification automations)
        result = { ok: true, note: "NO_HANDLER" };
      }

      rec.state.runs = (rec.state.runs || 0) + 1;
      rec.state.lastRunAtISO = asISO(startedAtMs);
      rec.state.lastResult = result ?? "OK";
      rec.state.lastError = null;
      rec.state.updatedAtISO = new Date().toISOString();

      // Notification (optional)
      await this._maybeNotify(rec, result);

      // Reschedule if needed
      if (reason !== "manual") {
        rec.schedule.nextRunAtMs = this._computeNextRunAtMs(
          rec,
          startedAtMs + 1000
        );
      }

      this._bus.emit("automation.fired", {
        ...payloadBase,
        finishedAtISO: asISO(nowMs()),
        durationMs: nowMs() - startedAtMs,
        result,
        nextRunAtISO: rec.schedule.nextRunAtMs
          ? asISO(rec.schedule.nextRunAtMs)
          : null,
      });

      return { ok: true, result };
    } catch (err) {
      rec.state.runs = (rec.state.runs || 0) + 1;
      rec.state.lastRunAtISO = asISO(startedAtMs);
      rec.state.lastResult = null;
      rec.state.lastError = String(err?.message || err);
      rec.state.updatedAtISO = new Date().toISOString();

      // Try to move schedule forward so we don't get stuck firing repeatedly
      if (reason !== "manual") {
        rec.schedule.nextRunAtMs = this._computeNextRunAtMs(
          rec,
          startedAtMs + 30_000
        );
      }

      this._bus.emit("automation.error", {
        ...payloadBase,
        stage: "handler",
        error: String(err?.message || err),
        finishedAtISO: asISO(nowMs()),
        nextRunAtISO: rec.schedule.nextRunAtMs
          ? asISO(rec.schedule.nextRunAtMs)
          : null,
      });

      return { ok: false, error: String(err?.message || err) };
    } finally {
      this._inflight.delete(rec.id);
      // Persist after each execution for durability
      try {
        await this._persist();
      } catch {
        // ignore persistence failures
      }
    }
  }

  async _maybeNotify(rec, result) {
    const n = rec.notification;
    if (!n || typeof n !== "object") return;

    const title =
      typeof n.title === "string" && n.title.trim() ? n.title.trim() : rec.name;
    let body = "";
    if (typeof n.body === "string") body = n.body;
    else if (result && typeof result === "object")
      body = safeJsonStringify(result, "");
    else if (typeof result === "string") body = result;

    // Respect quiet hours/sabbath for notifications too (unless caller bypassed by custom handler)
    const t = nowMs();
    if (isInQuietHours(t, this._quietHours)) return;
    if (isInSabbath(t, this._sabbath, this._timezone)) return;

    try {
      if (ReminderManager?.isReady?.() === false) {
        // requestPermission is safe even if denied; it just resolves
        await ReminderManager.requestPermission?.();
      }
      // schedule "now" as immediate notification (ReminderManager uses setTimeout)
      await ReminderManager.scheduleReminder?.({
        id: `auto_notify_${rec.id}_${Date.now()}`,
        title,
        body,
        atISO: new Date(Date.now() + 250).toISOString(),
        tag: n.tag || `automation:${rec.id}`,
        data: { automationId: rec.id, automationName: rec.name, result },
      });
    } catch {
      // notification is optional; ignore failures
    }
  }

  _computeNextRunAtMs(rec, fromMs) {
    const trig = rec.trigger || { kind: "manual" };
    const kind = String(trig.kind || "manual");

    // Manual never schedules itself
    if (kind === "manual") return null;

    // Once
    if (kind === "once") {
      const atISO = trig.atISO;
      const atMs = Date.parse(atISO);
      if (!Number.isFinite(atMs)) return null;
      // If already passed, never schedule again
      if (atMs <= fromMs) return null;
      return atMs;
    }

    // Interval
    if (kind === "interval") {
      const everyMs = Number(trig.everyMs);
      if (!Number.isFinite(everyMs) || everyMs <= 0) return null;

      const jitterMs = Number.isFinite(Number(trig.jitterMs))
        ? Number(trig.jitterMs)
        : 0;
      const jitter = jitterMs
        ? Math.floor((Math.random() * 2 - 1) * jitterMs)
        : 0;

      const startAtMs = trig.startAtISO ? Date.parse(trig.startAtISO) : null;
      const base = Number.isFinite(startAtMs)
        ? Math.max(startAtMs, fromMs)
        : fromMs;

      return base + everyMs + jitter;
    }

    // Daily
    if (kind === "daily") {
      const tz = trig.timezone || this._timezone;
      const at = parseHHMM(trig.at);
      if (!at) return null;

      const parts = getZonedParts(fromMs, tz);

      // candidate today at HH:MM:00
      const todayUtc = zonedWallTimeToUtcMs(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: at.hh,
          minute: at.mm,
          second: 0,
        },
        tz
      );

      if (todayUtc > fromMs) return todayUtc;

      // tomorrow
      const tomorrow = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0)
      );
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tParts = getZonedParts(tomorrow.getTime(), tz);

      return zonedWallTimeToUtcMs(
        {
          year: tParts.year,
          month: tParts.month,
          day: tParts.day,
          hour: at.hh,
          minute: at.mm,
          second: 0,
        },
        tz
      );
    }

    // Weekly
    if (kind === "weekly") {
      const tz = trig.timezone || this._timezone;
      const at = parseHHMM(trig.at);
      const days = Array.isArray(trig.days) ? trig.days : null;
      if (!at || !days || !days.length) return null;

      const fromParts = getZonedParts(fromMs, tz);
      if (fromParts.dayIndex == null) return null;

      // Check next 7 days, find earliest candidate > fromMs
      let best = null;

      for (let add = 0; add < 8; add++) {
        const probe = new Date(
          Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day, 12, 0, 0)
        );
        probe.setUTCDate(probe.getUTCDate() + add);
        const p = getZonedParts(probe.getTime(), tz);

        if (!days.includes(p.dayIndex)) continue;

        const cand = zonedWallTimeToUtcMs(
          {
            year: p.year,
            month: p.month,
            day: p.day,
            hour: at.hh,
            minute: at.mm,
            second: 0,
          },
          tz
        );

        if (cand > fromMs && (best == null || cand < best)) best = cand;
      }

      return best;
    }

    // RRULE (minimal)
    if (kind === "rrule") {
      const tz = trig.timezone || this._timezone;
      const parsed = parseRRule(trig.rrule);
      if (!parsed) return null;

      const hh = parsed.byHour ?? 0;
      const mm = parsed.byMinute ?? 0;
      const ss = parsed.bySecond ?? 0;

      if (parsed.freq === "DAILY") {
        // Next daily at specified hh:mm:ss in tz
        const parts = getZonedParts(fromMs, tz);
        const todayUtc = zonedWallTimeToUtcMs(
          {
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hour: hh,
            minute: mm,
            second: ss,
          },
          tz
        );
        if (todayUtc > fromMs) return todayUtc;

        const tomorrow = new Date(
          Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0)
        );
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        const tParts = getZonedParts(tomorrow.getTime(), tz);

        return zonedWallTimeToUtcMs(
          {
            year: tParts.year,
            month: tParts.month,
            day: tParts.day,
            hour: hh,
            minute: mm,
            second: ss,
          },
          tz
        );
      }

      if (parsed.freq === "WEEKLY") {
        const tokens = Array.isArray(parsed.byDay) ? parsed.byDay : [];
        const days = tokens.map(weekdayTokenToIndex).filter((x) => x != null);
        if (!days.length) return null;

        const parts = getZonedParts(fromMs, tz);
        if (parts.dayIndex == null) return null;

        let best = null;
        for (let add = 0; add < 8; add++) {
          const probe = new Date(
            Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0)
          );
          probe.setUTCDate(probe.getUTCDate() + add);
          const p = getZonedParts(probe.getTime(), tz);

          if (!days.includes(p.dayIndex)) continue;

          const cand = zonedWallTimeToUtcMs(
            {
              year: p.year,
              month: p.month,
              day: p.day,
              hour: hh,
              minute: mm,
              second: ss,
            },
            tz
          );
          if (cand > fromMs && (best == null || cand < best)) best = cand;
        }
        return best;
      }
    }

    // Unknown kind => do not schedule
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Factory + default singleton                                                */
/* -------------------------------------------------------------------------- */

export function createAutomationRuntime(opts = {}) {
  return new AutomationRuntime(opts);
}

/**
 * Default singleton runtime (localStorage + local bus).
 * If you want SSA eventBus/Dexie, create your own runtime instance and export it
 * elsewhere (e.g., src/services/automation/runtime.js).
 */
export const automationRuntime = new AutomationRuntime();

/**
 * Convenience re-export name some files may expect.
 * (Many SSA files use: import { automation } from "@/services/automation/runtime";)
 */
export const automation = automationRuntime;

/* -------------------------------------------------------------------------- */
/* Compatibility exports (Build fix)                                          */
/* -------------------------------------------------------------------------- */
/**
 * router.jsx expects:
 *   import { initAutomationRuntime, handleEvent } from "@/services/automationRuntime";
 *
 * We provide thin wrappers around the singleton, staying browser-safe and
 * backward-compatible with any prior usage of automationRuntime/automation.
 */

/**
 * Initialize + start the singleton runtime (idempotent).
 * @param {Object=} opts
 * @param {any=} opts.bus
 * @param {any=} opts.storage
 * @param {string=} opts.timezone
 * @param {Object=} opts.quietHours
 * @param {Object=} opts.sabbath
 * @param {number=} opts.tickMs
 * @param {function():any=} opts.contextProvider
 * @returns {Promise<AutomationRuntime>}
 */
export async function initAutomationRuntime(opts = {}) {
  try {
    if (opts && typeof opts === "object") {
      if (opts.bus && typeof opts.bus.emit === "function") {
        automationRuntime._bus = opts.bus; // intentional: allow injection
      }
      if (opts.storage) automationRuntime._storage = opts.storage;
      if (opts.timezone) automationRuntime.setTimezone(opts.timezone);
      if (opts.quietHours) automationRuntime.setQuietHours(opts.quietHours);
      if (opts.sabbath) automationRuntime.setSabbath(opts.sabbath);
      if (typeof opts.contextProvider === "function") {
        automationRuntime.setContextProvider(opts.contextProvider);
      }
      if (isFiniteNumber(opts.tickMs)) {
        automationRuntime._tickMs = clamp(
          opts.tickMs,
          MIN_CHECK_INTERVAL_MS,
          120_000
        );
      }
    }

    if (!automationRuntime.isRunning()) {
      await automationRuntime.start();
    } else {
      // ensure at least hydrated
      await automationRuntime.hydrate();
    }

    return automationRuntime;
  } catch {
    // Never crash app; return runtime in whatever state it is.
    return automationRuntime;
  }
}

/**
 * Generic event hook for an “automation runtime” entry point.
 * If you later implement event-driven triggers, you can route them here.
 * For now, we opportunistically tick once (fast) and optionally run a named automation.
 *
 * @param {any} event - any envelope/object; kept generic for SSA eventBus piping
 * @param {Object=} opts
 * @param {string=} opts.runId - if provided, run this automation immediately
 * @param {any=} opts.context - optional execution context
 * @returns {Promise<any>}
 */
export async function handleEvent(event, opts = {}) {
  try {
    // Ensure runtime is ready
    await initAutomationRuntime();

    // If caller wants a specific automation to run, do it.
    if (opts && typeof opts.runId === "string" && opts.runId.trim()) {
      return await automationRuntime.runNow(opts.runId.trim(), {
        ignoreEnabled: true,
        ignoreGuards: false,
        context: opts.context || { event },
      });
    }

    // Otherwise, do a single tick pass if running (safe no-op if stopped).
    if (automationRuntime.isRunning()) {
      await automationRuntime._tick();
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export default automationRuntime;
