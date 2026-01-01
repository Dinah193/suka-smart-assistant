// src/models/Timer.js

/**
 * Timer
 * -----------------------------------------------------------------------------
 * A resilient, drift-resistant timer for Suka:
 *  - Modes: countdown (default) & stopwatch
 *  - Sequences: intervals (e.g., HIIT 30/10 x 8) and chained steps (e.g., proof → bake)
 *  - Sabbath & quiet-hour aware scheduling (nudge start to allowed time)
 *  - Snooze / repeat cycles with limit
 *  - Links to tasks/recipes/locations for UI context
 *  - Accurate resume across reloads (no setInterval dependency; uses wall clock)
 *  - Emits “events” via a lightweight callback bus (optional)
 *
 * Notes:
 *  - No timers run here; UI/manager polls getRemaining() to render.
 *  - Time values stored as ms (internally) except public inputs that accept seconds for convenience.
 */

const safeUUID = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const MS = {
  sec: 1000,
  min: 60_000,
  hr: 3_600_000,
};

function inQuietHours(d, quietHours) {
  const { start = 21, end = 7 } = quietHours || { start: 21, end: 7 };
  const h = d.getHours();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}
function isSabbath(date, { avoidSabbath = false, saturdayAsSabbath = false } = {}) {
  if (!avoidSabbath) return false;
  // Approximate Hebrew day 7 as Saturday-avoid; your calendar engine can refine upstream.
  return saturdayAsSabbath ? date.getDay() === 6 : date.getDay() === 6;
}
function nudgeToAllowed(date, { avoidSabbath = false, saturdayAsSabbath = false, quietHours = { start: 21, end: 7 }, defaultHour = 9 } = {}) {
  let d = new Date(date);
  let guard = 0;
  while ((isSabbath(d, { avoidSabbath, saturdayAsSabbath }) || inQuietHours(d, quietHours)) && guard < 14) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, defaultHour, 0, 0, 0);
    guard++;
  }
  return d;
}

class Timer {
  /**
   * @param {{
   *  id?: string,
   *  label?: string,
   *  duration?: number,            // seconds (countdown). Ignored in stopwatch mode.
   *  category?: string,            // "cooking" | "cleaning" | "training" | ...
   *  mode?: "countdown"|"stopwatch",
   *  createdAt?: string,
   *  startTime?: number|null,      // epoch ms when started/resumed (null if not running)
   *  endTime?: number|null,        // epoch ms target end for countdown or last stop for stopwatch
   *  status?: "idle"|"running"|"paused"|"completed",
   *  repeat?: boolean,             // back-compat (use repeatCount for limit)
   *  repeatCount?: number|null,    // number of repeats (null=infinite when repeat=true)
   *  audioCue?: boolean,           // simple flag for UI
   *  vibrate?: boolean,
   *  linked?: { type?: "task"|"recipe"|"location", refId?: string } | null,
   *  scheduleAt?: string|null,     // ISO start suggestion (will be nudged to allowed)
   *  quietHours?: { start:number, end:number },
   *  avoidSabbath?: boolean,
   *  saturdayAsSabbath?: boolean,
   *  defaultStartHour?: number,
   *  sequence?: Array<{ id?:string, label?:string, seconds:number, color?:string }>, // interval steps
   *  currentIndex?: number,        // index in sequence
   *  accumulatedPausedMs?: number, // total paused time in current run
   *  laps?: Array<{ at:number, elapsedMs:number, note?:string }>,
   *  notes?: string
   * }} opts
   */
  constructor({
    id = safeUUID(),
    label = "Unnamed Timer",
    duration = 0,
    category = "general",
    mode = "countdown",
    createdAt = new Date().toISOString(),
    startTime = null,
    endTime = null,
    status = "idle",
    repeat = false,
    repeatCount = null,
    audioCue = true,
    vibrate = false,
    linked = null,
    scheduleAt = null,
    quietHours = { start: 21, end: 7 },
    avoidSabbath = false,
    saturdayAsSabbath = false,
    defaultStartHour = 9,
    sequence = null,
    currentIndex = 0,
    accumulatedPausedMs = 0,
    laps = [],
    notes = ""
  } = {}) {
    this.id = id;
    this.label = label;
    this.duration = Number(duration || 0); // seconds, for public API/back-compat
    this.category = category;
    this.mode = mode === "stopwatch" ? "stopwatch" : "countdown";

    this.createdAt = createdAt;
    this.startTime = startTime; // ms
    this.endTime = endTime;     // ms
    this.status = status;

    this.repeat = !!repeat;
    this.repeatCount = repeat ? (repeatCount ?? null) : null;

    this.audioCue = !!audioCue;
    this.vibrate = !!vibrate;

    this.linked = linked; // {type,refId}
    this.scheduleAt = scheduleAt;
    this.quietHours = quietHours || { start: 21, end: 7 };
    this.avoidSabbath = !!avoidSabbath;
    this.saturdayAsSabbath = !!saturdayAsSabbath;
    this.defaultStartHour = Number.isFinite(defaultStartHour) ? defaultStartHour : 9;

    // Sequence / intervals (if provided, overrides duration during run)
    this.sequence = Array.isArray(sequence) && sequence.length
      ? sequence.map((s) => ({
          id: s.id || safeUUID(),
          label: s.label || "Interval",
          seconds: Math.max(1, Math.floor(Number(s.seconds || 1))),
          color: s.color || null
        }))
      : null;
    this.currentIndex = this.sequence ? clamp(Number(currentIndex || 0), 0, this.sequence.length - 1) : 0;

    this.accumulatedPausedMs = Number(accumulatedPausedMs || 0);
    this.laps = Array.isArray(laps) ? laps : [];
    this.notes = notes;

    // Event callbacks (not serialized)
    this._listeners = { tick: new Set(), complete: new Set(), change: new Set() };
  }

  /* ------------------------------- Basic ops ------------------------------- */

  /**
   * Start the timer now (or scheduleAt if idle with schedule).
   * Respects Sabbath/quiet-hours by nudging the start time forward.
   */
  start() {
    const now = Date.now();
    let planned = this.scheduleAt ? new Date(this.scheduleAt) : new Date(now);
    planned = nudgeToAllowed(planned, {
      avoidSabbath: this.avoidSabbath,
      saturdayAsSabbath: this.saturdayAsSabbath,
      quietHours: this.quietHours,
      defaultHour: this.defaultStartHour
    });

    this.startTime = planned.getTime();
    this.accumulatedPausedMs = 0;

    if (this.mode === "countdown") {
      const seconds = this._activeSeconds();
      this.endTime = this.startTime + seconds * MS.sec;
    } else {
      // stopwatch has no predetermined end
      this.endTime = null;
    }

    this.status = planned.getTime() <= now ? "running" : "idle"; // if nudged to future, keep idle until scheduler triggers
    this._emit("change");
  }

  /** Pause preserves remaining time by accumulating paused ms. */
  pause() {
    if (this.status !== "running" || !this.startTime) return;
    const now = Date.now();
    // How long have we been running in this leg?
    const legMs = now - this.startTime;
    this.accumulatedPausedMs += legMs;
    this.status = "paused";
    this._emit("change");
  }

  /** Resume from pause; recalculates endTime based on remaining seconds. */
  resume() {
    if (this.status !== "paused") return;
    const now = Date.now();
    this.startTime = now;
    if (this.mode === "countdown") {
      const remaining = this.getRemainingSeconds();
      this.endTime = now + Math.max(0, remaining) * MS.sec;
    }
    this.status = "running";
    this._emit("change");
  }

  /** Mark completed. If repeating/sequenced, advance accordingly. */
  complete() {
    this.status = "completed";
    this.endTime = Date.now();
    this._emit("complete");

    // Handle repeats or sequence advance
    if (this.sequence) {
      if (this.currentIndex < this.sequence.length - 1) {
        this.currentIndex += 1;
        this._autoAdvanceOrRepeat();
        return;
      }
      // reached end of sequence → repeat?
      if (this.repeat) {
        if (this.repeatCount == null || this.repeatCount > 0) {
          if (this.repeatCount != null) this.repeatCount -= 1;
          this.currentIndex = 0;
          this._autoAdvanceOrRepeat();
          return;
        }
      }
      // otherwise fully complete
      return;
    }

    if (this.repeat) {
      if (this.repeatCount == null || this.repeatCount > 0) {
        if (this.repeatCount != null) this.repeatCount -= 1;
        this.reset(false); // keep label & config
        this.start();
        return;
      }
    }
  }

  /** Reset to idle; optionally clear laps. */
  reset(clearLaps = true) {
    this.status = "idle";
    this.startTime = null;
    this.endTime = null;
    this.accumulatedPausedMs = 0;
    if (clearLaps) this.laps = [];
    // keep repeat/sequence/config
    this._emit("change");
  }

  /** Snooze: push endTime forward by N seconds (countdown only). */
  snooze(seconds = 60) {
    if (this.mode !== "countdown") return;
    const s = Math.max(1, Math.floor(Number(seconds || 60)));
    const now = Date.now();
    if (this.status === "running" && this.endTime) {
      this.endTime += s * MS.sec;
    } else if (this.status === "paused") {
      // add to remaining duration logic via accumulated ms
      const remain = this.getRemainingSeconds() + s;
      this.duration = remain; // store new remaining as duration basis
      this._rebasePaused();
    } else if (this.status === "idle") {
      // schedule a future start
      this.scheduleAt = new Date(now + s * MS.sec).toISOString();
    }
    this._emit("change");
  }

  /** Stopwatch: record a lap. */
  lap(note = "") {
    if (this.mode !== "stopwatch") return;
    const elapsed = this.getElapsedMs();
    this.laps.push({ at: Date.now(), elapsedMs: elapsed, note });
    this._emit("change");
  }

  /* ------------------------------- Readouts -------------------------------- */

  /**
   * Remaining seconds (integer) for countdown; 0 if complete. For stopwatch, returns elapsed seconds.
   * Does not mutate state; derived from wall clock.
   */
  getRemainingSeconds() {
    if (this.mode === "stopwatch") {
      return Math.floor(this.getElapsedMs() / MS.sec);
    }
    if (this.status === "completed") return 0;

    // If running: compute from endTime
    if (this.status === "running" && this.endTime) {
      const ms = this.endTime - Date.now();
      return Math.max(0, Math.floor(ms / MS.sec));
    }

    // If paused or idle: compute based on configured remaining "basis"
    const basis = this._activeSeconds();
    // If we have paused time accumulated but haven't resumed, remaining is basis minus elapsed of the leg
    if (this.status === "paused" && this.startTime) {
      const leg = Date.now() - this.startTime; // time before pause call
      const consumed = Math.floor((this.accumulatedPausedMs + leg) / MS.sec);
      return Math.max(0, basis - consumed);
    }
    return Math.max(0, basis);
  }

  /** Human-friendly mm:ss (or hh:mm:ss) string for UI. */
  getRemainingLabel() {
    const sec = this.getRemainingSeconds();
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return h > 0
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  /** Milliseconds elapsed for stopwatch (or time consumed in current countdown run). */
  getElapsedMs() {
    if (!this.startTime) return 0;
    if (this.status === "paused") {
      return this.accumulatedPausedMs;
    }
    if (this.status === "running") {
      return this.accumulatedPausedMs + (Date.now() - this.startTime);
    }
    if (this.status === "completed") {
      if (this.mode === "stopwatch") {
        // endTime stores last stop time; elapsed is endTime - initial start with pauses accounted for
        return this.accumulatedPausedMs; // finalized by pause/resume accounting
      }
      // countdown: duration basis minus remaining (which should be 0)
      const secs = this._activeSeconds();
      return secs * MS.sec;
    }
    return 0;
  }

  /** Whether timer logically completed (remaining 0 in countdown, or status completed). */
  isCompleted() {
    if (this.mode === "countdown") return this.getRemainingSeconds() <= 0 || this.status === "completed";
    return this.status === "completed";
  }

  /** Current sequence segment (if any). */
  getActiveSegment() {
    if (!this.sequence) return null;
    return this.sequence[this.currentIndex] || null;
  }

  /* ----------------------------- Advanced flows ---------------------------- */

  /** Chain/interval helper: moves to next segment or repeats according to settings. */
  _autoAdvanceOrRepeat() {
    // prepare next segment start
    this.status = "idle";
    this.startTime = null;
    this.endTime = null;
    this.accumulatedPausedMs = 0;
    this.start(); // will compute new end based on currentIndex
  }

  /** Determine the "active seconds" basis: segment seconds or duration. */
  _activeSeconds() {
    if (this.sequence) {
      const seg = this.getActiveSegment();
      return seg ? seg.seconds : Math.max(0, Math.floor(this.duration || 0));
    }
    return Math.max(0, Math.floor(this.duration || 0));
  }

  /** When paused, rebase the countdown basis to the displayed remaining time. */
  _rebasePaused() {
    if (this.status !== "paused") return;
    // Reset accumulated and leg start so resume uses new duration basis.
    this.accumulatedPausedMs = 0;
    this.startTime = Date.now();
    if (this.mode === "countdown") {
      this.endTime = this.startTime + this.duration * MS.sec;
    }
  }

  /* --------------------------------- Events -------------------------------- */

  on(event, cb) {
    if (!this._listeners[event]) this._listeners[event] = new Set();
    this._listeners[event].add(cb);
    return () => this._listeners[event].delete(cb);
  }
  off(event, cb) {
    this._listeners[event]?.delete(cb);
  }
  _emit(event, payload) {
    for (const cb of this._listeners[event] || []) {
      try { cb(payload ?? this); } catch (e) { /* no-op */ }
    }
  }

  /* ------------------------------- Utilities ------------------------------- */

  /** Soft safety: if endTime < now while status running, auto-complete. Call from your render loop. */
  enforceCompletion() {
    if (this.mode === "countdown" && this.status === "running" && this.endTime && Date.now() >= this.endTime) {
      this.complete();
      return true;
    }
    return false;
  }

  /** For UI: compact metadata line */
  metaLabel() {
    const seg = this.getActiveSegment();
    const base = seg ? `${this.label} — ${seg.label}` : this.label;
    if (this.mode === "stopwatch") return `${base} · stopwatch`;
    const secs = this._activeSeconds();
    const mins = Math.round(secs / 60);
    return `${base} · ${mins} min`;
  }

  /* -------------------------------- Storage -------------------------------- */

  toJSON() {
    return {
      id: this.id,
      label: this.label,
      duration: this.duration,
      category: this.category,
      mode: this.mode,
      createdAt: this.createdAt,
      startTime: this.startTime,
      endTime: this.endTime,
      status: this.status,
      repeat: this.repeat,
      repeatCount: this.repeatCount,
      audioCue: this.audioCue,
      vibrate: this.vibrate,
      linked: this.linked,
      scheduleAt: this.scheduleAt,
      quietHours: this.quietHours,
      avoidSabbath: this.avoidSabbath,
      saturdayAsSabbath: this.saturdayAsSabbath,
      defaultStartHour: this.defaultStartHour,
      sequence: this.sequence,
      currentIndex: this.currentIndex,
      accumulatedPausedMs: this.accumulatedPausedMs,
      laps: this.laps,
      notes: this.notes
    };
  }

  static fromJSON(json = {}) {
    return new Timer(json);
  }
}

export default Timer;
