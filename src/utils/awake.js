// C:\Users\larho\suka-smart-assistant\src\utils\awake.js
/**
 * utils/awake.js — Programmatic screen Wake Lock for hands-busy SSA sessions
 *
 * Where this fits in SSA:
 * - SSA's pipeline is imports → intelligence → automation → (optional) hub export.
 * - While this module does not transform household data, it supports the "automation" and
 *   "execution" layers by preventing the screen from sleeping during session play
 *   (cooking timers, cleaning runs, garden/animal tasks, preservation cycles).
 *
 * Design goals:
 * - Single, reusable AwakeManager with reference counting so multiple features can request
 *   keepAwake(true) without stepping on each other. The lock only releases when all callers release.
 * - Uses the official Screen Wake Lock API when available (navigator.wakeLock).
 * - Graceful fallback: if Wake Lock is unavailable, we no-op but still emit telemetry so
 *   callers can adapt UI (e.g., show "Keep screen on not supported on this device").
 * - Defensive and efficient: idempotent enable/disable, auto-reacquire on visibility changes,
 *   emits standardized eventBus payloads { type, ts, source, data }.
 */

let eventBus = {
  emit: (...a) => console.debug("[awake:eventBus.emit]", ...a),
  on: () => () => {},
};

try {
  // Soft import to avoid hard coupling during early boot
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

/** Utility: ISO timestamp */
const nowISO = () => new Date().toISOString();

/** Standardized telemetry emit */
function emit(type, data = {}) {
  eventBus.emit({
    type,
    ts: nowISO(),
    source: "utils.awake",
    data,
  });
}

/**
 * AwakeManager
 * Manages a single WakeLockSentinel instance, with ref counting and automatic re-acquisition
 * on page visibility changes (as spec requires locks to be released when page is hidden).
 */
class AwakeManager {
  /** @type {WakeLockSentinel|null} */
  #sentinel = null;

  /** number of active enable() calls (feature-level reference count) */
  #refs = 0;

  /** whether we attempted to enable at least once (used for re-acquire on visibility) */
  #shouldBeAwake = false;

  /** whether wake lock API seems supported */
  #supported = typeof navigator !== "undefined" && !!navigator.wakeLock;

  /** bound visibility handler */
  #onVisibilityChange = null;

  constructor() {
    this.#onVisibilityChange = this.#handleVisibilityChange.bind(this);

    // Wire up visibility listener to re-acquire when tab becomes visible again.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.#onVisibilityChange, { passive: true });
    }
  }

  /**
   * Enable or disable the wake lock. Multiple enable(true) calls stack,
   * and require an equal number of enable(false) calls to fully release.
   * @param {boolean} on
   * @param {object} [meta] optional caller/context metadata
   */
  async enable(on, meta = {}) {
    // Normalize boolean param
    on = !!on;

    if (on) {
      this.#shouldBeAwake = true;
      this.#refs = Math.max(0, this.#refs) + 1;
      // Only actually request a lock on the first ref
      if (this.#refs === 1) {
        await this.#acquire(meta);
      } else {
        emit("ui.keepAwake.ref.incremented", {
          refs: this.#refs,
          supported: this.#supported,
          ...meta,
        });
      }
    } else {
      // Disable path
      this.#refs = Math.max(0, this.#refs - 1);
      if (this.#refs === 0) {
        this.#shouldBeAwake = false;
        await this.#release(meta);
      } else {
        emit("ui.keepAwake.ref.decremented", {
          refs: this.#refs,
          supported: this.#supported,
          ...meta,
        });
      }
    }
  }

  /**
   * Returns whether we currently hold an active wake lock sentinel.
   */
  isAwake() {
    return !!this.#sentinel;
  }

  /**
   * Returns whether the platform supports navigator.wakeLock
   */
  isSupported() {
    return this.#supported;
  }

  /**
   * Force release all references and the lock (emergency breaker)
   */
  async releaseAll(meta = {}) {
    this.#refs = 0;
    this.#shouldBeAwake = false;
    await this.#release(meta);
  }

  /**
   * Add a listener to be notified when lock is acquired or released.
   * The callback receives { awake: boolean, supported: boolean, refs: number }.
   * Returns an unsubscribe function.
   */
  onStatusChange(cb) {
    if (typeof cb !== "function") return () => {};
    const handler = (evt) => {
      if (!evt || typeof evt !== "object") return;
      if (
        evt.type === "ui.keepAwake.enabled" ||
        evt.type === "ui.keepAwake.disabled" ||
        evt.type === "ui.keepAwake.error"
      ) {
        cb({
          awake: this.isAwake(),
          supported: this.isSupported(),
          refs: this.#refs,
          event: evt,
        });
      }
    };
    const off = eventBus.on(handler);
    return typeof off === "function" ? off : () => {};
  }

  /** Internal: request the wake lock */
  async #acquire(meta = {}) {
    if (!this.#supported) {
      emit("ui.keepAwake.unsupported", { ...meta });
      return;
    }
    try {
      // Request a screen wake lock
      this.#sentinel = await navigator.wakeLock.request("screen");

      // If the UA releases it (e.g., system policy), listen and try to re-acquire if we still want it
      this.#sentinel.addEventListener?.("release", async () => {
        emit("ui.keepAwake.released.byAgent", {
          reason: "agent_release",
          refs: this.#refs,
          ...meta,
        });
        this.#sentinel = null;
        if (this.#shouldBeAwake && this.#refs > 0 && !document.hidden) {
          // Attempt re-acquire
          try {
            this.#sentinel = await navigator.wakeLock.request("screen");
            emit("ui.keepAwake.reacquired", { refs: this.#refs, ...meta });
          } catch (err) {
            emit("ui.keepAwake.error", {
              stage: "reacquire_after_agent_release",
              message: err?.message || String(err),
              refs: this.#refs,
              ...meta,
            });
          }
        }
      });

      emit("ui.keepAwake.enabled", {
        supported: true,
        refs: this.#refs,
        ...meta,
      });
    } catch (err) {
      this.#sentinel = null;
      emit("ui.keepAwake.error", {
        stage: "acquire",
        message: err?.message || String(err),
        supported: this.#supported,
        refs: this.#refs,
        ...meta,
      });
    }
  }

  /** Internal: release the wake lock */
  async #release(meta = {}) {
    if (!this.#sentinel) {
      emit("ui.keepAwake.disabled", { supported: this.#supported, refs: this.#refs, ...meta });
      return;
    }
    try {
      await this.#sentinel.release?.();
      this.#sentinel = null;
      emit("ui.keepAwake.disabled", { supported: this.#supported, refs: this.#refs, ...meta });
    } catch (err) {
      emit("ui.keepAwake.error", {
        stage: "release",
        message: err?.message || String(err),
        supported: this.#supported,
        refs: this.#refs,
        ...meta,
      });
      // Ensure we drop our local handle even if release throws
      this.#sentinel = null;
    }
  }

  /** Internal: handle tab visibility changes to re-acquire the lock if needed */
  async #handleVisibilityChange() {
    try {
      if (document.hidden) return; // Locks are dropped in background; we'll reacquire on visible
      if (this.#shouldBeAwake && this.#refs > 0 && !this.#sentinel) {
        await this.#acquire({ reason: "visibilitychange" });
      }
    } catch (err) {
      emit("ui.keepAwake.error", {
        stage: "visibilitychange",
        message: err?.message || String(err),
      });
    }
  }

  /** Cleanup listeners (optional; usually not needed for app lifetime singleton) */
  destroy() {
    if (typeof document !== "undefined" && this.#onVisibilityChange) {
      document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    }
  }
}

// Singleton instance used app-wide
const manager = new AwakeManager();

/**
 * Public API — programmatic keepAwake(true/false)
 * Usage:
 *   import { keepAwake, isAwake, isWakeLockSupported, releaseAllAwake, onAwakeStatus } from "@/utils/awake";
 *   await keepAwake(true, { caller: "CookingSessionPlayer" });
 *   // ... later
 *   await keepAwake(false, { caller: "CookingSessionPlayer" });
 */

/**
 * Enable/disable the wake lock with reference counting.
 * @param {boolean} on
 * @param {object} [meta] optional metadata (e.g., { caller: "ModuleName", sessionId })
 */
export async function keepAwake(on, meta = {}) {
  // Fail-fast if running outside a browser (SSR/Node)
  if (typeof window === "undefined" || typeof document === "undefined") {
    emit("ui.keepAwake.error", {
      stage: "environment",
      message: "Not a browser environment",
      on,
      ...meta,
    });
    return;
  }
  return manager.enable(on, meta);
}

/** Returns true if a wake lock is currently held */
export function isAwake() {
  return manager.isAwake();
}

/** Returns true if navigator.wakeLock is supported by the UA */
export function isWakeLockSupported() {
  return manager.isSupported();
}

/** Emergency breaker: drop all refs and release the lock */
export async function releaseAllAwake(meta = {}) {
  return manager.releaseAll(meta);
}

/**
 * Subscribe to awake status changes.
 * @param {(status: {awake:boolean, supported:boolean, refs:number, event:any}) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onAwakeStatus(cb) {
  return manager.onStatusChange(cb);
}

/* ------------------------------ Event wiring --------------------------------
 * Optional convenience: listen for session lifecycle events to auto-manage wake lock.
 * You can emit the following from session players:
 *   { type: "session.play.start", ts, source, data: { domain, sessionId, keepAwake: true } }
 *   { type: "session.play.stop",  ts, source, data: { domain, sessionId } }
 * This stays resilient if eventBus is not yet wired (no-ops).
 * --------------------------------------------------------------------------- */

try {
  eventBus.on((evt) => {
    if (!evt || typeof evt !== "object") return;

    // Start of a hands-busy session
    if (evt.type === "session.play.start" && evt?.data?.keepAwake) {
      keepAwake(true, {
        caller: `session:${evt?.data?.domain || "unknown"}`,
        sessionId: evt?.data?.sessionId,
      });
    }

    // End of a hands-busy session
    if (evt.type === "session.play.stop") {
      keepAwake(false, {
        caller: `session:${evt?.data?.domain || "unknown"}`,
        sessionId: evt?.data?.sessionId,
      });
    }
  });
} catch {}
