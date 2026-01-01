/**
 * src/services/wakelock.js
 * -----------------------------------------------------------------------------
 * Wake Lock Service (singleton)
 *
 * Purpose:
 * - Provide a safe, centralized way to keep the screen awake during sessions.
 * - Emits standard event envelopes via eventBus.
 * - Optionally mirrors engagement to the Hub when familyFundMode is enabled.
 *
 * How it fits:
 * - Used by SessionRunner and the useWakeLock() hook. Keeps a single
 *   WakeLockSentinel in memory and automatically re-acquires on visibility
 *   changes while the caller still "wants" the lock.
 *
 * Events (via eventBus.emit({ type, ts, source, data })):
 * - device.wakelock.requested
 * - device.wakelock.acquired
 * - device.wakelock.released
 * - device.wakelock.deferred
 * - device.wakelock.unsupported
 * - device.wakelock.error      (data.phase: "request"|"release")
 *
 * API:
 *   wakelock.supported(): boolean
 *   wakelock.state(): { active, requesting, wanted, reason, error }
 *   wakelock.want(reason?: string): void          // mark desire; does not acquire
 *   wakelock.acquire(reason?: string, { hubSync } = {}): Promise<boolean>
 *   wakelock.release({ hubSync } = {}): Promise<boolean>
 *   wakelock.toggle({ hubSync } = {}): Promise<boolean>
 *
 * Notes:
 * - Safe in SSR (guards typeof window/navigator).
 * - If the page is hidden, acquisition is deferred (emits device.wakelock.deferred).
 * - When the browser force-releases (e.g., OS locks), we update state and emit released.
 * -----------------------------------------------------------------------------
 */

import eventBus from "@/services/eventBus";
import { featureFlags } from "@/services/featureFlags";

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // Soft imports: optional Hub
  HubPacketFormatter = (await import("@/services/hub/HubPacketFormatter")).default;
  FamilyFundConnector = (await import("@/services/hub/FamilyFundConnector")).default;
  // eslint-disable-next-line no-empty
} catch {}

const SOURCE = "services.wakelock";
const isoNow = () => new Date().toISOString();

function emit(type, data = {}) {
  const payload = { type, ts: isoNow(), source: SOURCE, data };
  try {
    eventBus?.emit?.(payload);
  } catch {
    // no-op
  }
  return payload;
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // silent by design
  }
}

function navSupported() {
  try {
    return typeof navigator !== "undefined" && !!navigator.wakeLock?.request;
  } catch {
    return false;
  }
}

class WakeLockService {
  constructor() {
    /** @type {WakeLockSentinel|null} */
    this._sentinel = null;
    this._wanted = false;
    this._active = false;
    this._requesting = false;
    this._reason = "session";
    this._error = null;
    this._hubSync = false;

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this._onVisibilityChange, false);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this._onBeforeUnload, { capture: true });
    }
  }

  supported() {
    return navSupported();
  }

  state() {
    return {
      active: this._active,
      requesting: this._requesting,
      wanted: this._wanted,
      reason: this._reason,
      error: this._error,
    };
  }

  want(reason) {
    if (typeof reason === "string" && reason.trim()) {
      this._reason = reason.trim();
    }
    this._wanted = true;
  }

  async acquire(reason, opts = {}) {
    if (typeof reason === "string" && reason.trim()) {
      this._reason = reason.trim();
    }
    this._hubSync = !!opts.hubSync;

    this._error = null;
    this._wanted = true;

    if (!this.supported()) {
      this._error = new Error("Wake Lock API not supported");
      const p = emit("device.wakelock.unsupported", {});
      if (this._hubSync) exportToHubIfEnabled(p);
      return false;
    }

    // Already have it?
    if (this._sentinel && this._active) return true;

    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      // Can't acquire while hidden. We'll try again when visible if still wanted.
      const p = emit("device.wakelock.deferred", { visibility: "hidden", reason: this._reason });
      if (this._hubSync) exportToHubIfEnabled(p);
      return false;
    }

    try {
      this._requesting = true;
      const pre = emit("device.wakelock.requested", { reason: this._reason });
      if (this._hubSync) exportToHubIfEnabled(pre);

      const s = await navigator.wakeLock.request("screen");
      this._attachSentinel(s);
      this._active = true;
      this._requesting = false;

      const ok = emit("device.wakelock.acquired", { reason: this._reason });
      if (this._hubSync) exportToHubIfEnabled(ok);
      return true;
    } catch (err) {
      this._requesting = false;
      this._active = false;
      this._error = err;
      const e = emit("device.wakelock.error", {
        phase: "request",
        name: err?.name,
        message: String(err?.message || err),
        reason: this._reason,
      });
      if (this._hubSync) exportToHubIfEnabled(e);
      return false;
    }
  }

  async release(opts = {}) {
    this._hubSync = !!opts.hubSync;

    this._wanted = false;
    this._requesting = false;
    this._error = null;

    if (!this.supported()) {
      this._active = false;
      this._detachSentinel();
      return true;
    }
    if (!this._sentinel) {
      this._active = false;
      return true;
    }

    try {
      await this._sentinel.release?.();
      // 'release' event also fires; we still clean up immediately
    } catch (err) {
      this._error = err;
      emit("device.wakelock.error", {
        phase: "release",
        name: err?.name,
        message: String(err?.message || err),
        reason: this._reason,
      });
    } finally {
      this._detachSentinel();
      this._active = false;
      const p = emit("device.wakelock.released", { reason: this._reason });
      if (this._hubSync) exportToHubIfEnabled(p);
    }
    return true;
  }

  async toggle(opts = {}) {
    if (this._active && this._sentinel) {
      return this.release(opts);
    }
    return this.acquire(undefined, opts);
  }

  /* ------------------------------ Internals ------------------------------- */

  _attachSentinel(sentinel) {
    this._detachSentinel();
    this._sentinel = sentinel;
    this._sentinel?.addEventListener?.("release", this._onForcedRelease, false);
  }

  _detachSentinel() {
    try {
      this._sentinel?.removeEventListener?.("release", this._onForcedRelease, false);
      // eslint-disable-next-line no-empty
    } catch {}
    this._sentinel = null;
  }

  _onForcedRelease = () => {
    // Browser/OS released our lock.
    this._active = false;
    this._detachSentinel();
    const p = emit("device.wakelock.released", { reason: this._reason, forced: true });
    if (this._hubSync) exportToHubIfEnabled(p);
  };

  _onVisibilityChange = async () => {
    if (!this.supported()) return;
    if (typeof document === "undefined") return;

    if (document.visibilityState === "visible" && this._wanted && !this._sentinel) {
      // Try reacquire silently; if it fails, emit error and leave wanted=true so
      // another visibility change (or manual request) can try again.
      await this.acquire(this._reason, { hubSync: this._hubSync });
    }
  };

  _onBeforeUnload = () => {
    // Best-effort release to be nice to the platform; ignore errors.
    try {
      this._sentinel?.release?.();
      // eslint-disable-next-line no-empty
    } catch {}
    this._detachSentinel();
    this._active = false;
    this._wanted = false;
  };
}

const wakelock = new WakeLockService();
export default wakelock;
