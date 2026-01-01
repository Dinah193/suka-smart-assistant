/**
 * src/services/notifications.js
 * -----------------------------------------------------------------------------
 * Notifications Service (singleton)
 *
 * Purpose:
 * - Centralize Notifications API + Service Worker usage for SSA sessions.
 * - Provide "ongoing session" notifications with Pause/Next/Resume actions.
 * - Emit standard event envelopes via eventBus, and optionally mirror to Hub.
 *
 * How it fits:
 * - SessionRunner calls `notify.sessionStarted(...)` to create a persistent
 *   notification. The service updates/replaces the notification on each step,
 *   and closes it on completion/abort. Actions clicked in the notification are
 *   relayed back to the app via `navigator.serviceWorker.onmessage`, and the
 *   service re-emits them on `eventBus` so the runner can respond.
 *
 * Events emitted (payload: { type, ts, source, data }):
 * - device.notification.permission.requested
 * - device.notification.permission.granted
 * - device.notification.permission.denied
 * - device.notification.show
 * - device.notification.update
 * - device.notification.close
 * - device.notification.action (data.action: "pause"|"resume"|"next"|"open")
 * - device.notification.error
 *
 * Defensive behavior:
 * - SSR-safe (checks window, navigator).
 * - If Notifications or SW unsupported, functions resolve gracefully (no-ops).
 * - Uses a stable `tag` to replace ongoing notifications instead of piling up.
 *
 * Hub mirroring:
 * - When `featureFlags.familyFundMode === true`, events are formatted and
 *   attempted to be sent to the Hub helpers (silent if unavailable/offline).
 *
 * Integration tips:
 * - Call `await notifications.registerServiceWorker()` at app bootstrap (e.g., in App.jsx).
 * - In SessionRunner:
 *    await notifications.sessionStarted(session);
 *    await notifications.sessionStepChanged(session, session.steps[i], { paused: false });
 *    await notifications.sessionPaused(session);
 *    await notifications.sessionResumed(session);
 *    await notifications.sessionCompleted(session);
 *    await notifications.sessionAborted(session);
 * -----------------------------------------------------------------------------
 */

import eventBus from "@/services/eventBus";
import { featureFlags } from "@/services/featureFlags";

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // Soft dynamic imports to avoid hard coupling
  // eslint-disable-next-line no-unused-vars
  (async () => {
    try {
      const m1 = await import("@/services/hub/HubPacketFormatter");
      const m2 = await import("@/services/hub/FamilyFundConnector");
      HubPacketFormatter = m1?.default || null;
      FamilyFundConnector = m2?.default || null;
    } catch {
      /* no-op */
    }
  })();
} catch {
  /* no-op */
}

const SOURCE = "services.notifications";
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

function notifSupported() {
  try {
    return typeof window !== "undefined" &&
           "Notification" in window &&
           typeof Notification.requestPermission === "function";
  } catch {
    return false;
  }
}

function swSupported() {
  try {
    return typeof navigator !== "undefined" && "serviceWorker" in navigator;
  } catch {
    return false;
  }
}

function toSessionTag(sessionId) {
  return `ssa-session-${String(sessionId || "unknown")}`;
}

async function getRegistration() {
  if (!swSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg || null;
  } catch {
    return null;
  }
}

async function show(reg, title, options) {
  if (!reg) return false;
  try {
    await reg.showNotification(title, options);
    return true;
  } catch (err) {
    emit("device.notification.error", { phase: "show", message: String(err?.message || err) });
    return false;
  }
}

function buildOngoingOptions({ tag, body, icon, badge, actions = [], paused = false, stepIdx = 0, totalSteps = 0 }) {
  const requireInteraction = true; // keep it visible until user interacts (desktop)
  const silent = false; // let OS play default sound if any
  /** @type {NotificationAction[]} */
  const defaultActions = paused
    ? [{ action: "resume", title: "Resume" }]
    : [{ action: "pause", title: "Pause" }];
  const nextAction = { action: "next", title: "Next" };

  // Append default actions if not provided by caller
  const merged = actions.length ? actions : [...defaultActions, nextAction];

  const data = {
    kind: "ssa.ongoing.session",
    stepIdx,
    totalSteps,
    // additional fields can be added here and will be echoed in SW click events
  };

  return {
    body,
    tag,
    renotify: true, // replacing should re-notify
    requireInteraction,
    silent,
    icon: icon || "/icons/ssa-192.png",
    badge: badge || "/icons/ssa-badge-72.png",
    actions: merged,
    data,
  };
}

class NotificationsService {
  constructor() {
    this._permission = notifSupported() ? Notification.permission : "denied";
    this._wireSwMessageBridge();
  }

  /* ------------------------------- Bootstrap ------------------------------- */

  async registerServiceWorker(path = "/sw.js") {
    if (!swSupported()) return null;
    try {
      const reg = await navigator.serviceWorker.register(path, { scope: "/" });
      // Optionally trigger update check in the background:
      reg.update?.();
      return reg;
    } catch (err) {
      emit("device.notification.error", { phase: "register", message: String(err?.message || err) });
      return null;
    }
  }

  async ensurePermission() {
    if (!notifSupported()) {
      emit("device.notification.error", { phase: "permission", message: "Notifications unsupported" });
      return "denied";
    }
    emit("device.notification.permission.requested", {});
    const result = await Notification.requestPermission();
    this._permission = result;
    const evtType =
      result === "granted" ? "device.notification.permission.granted" :
      result === "denied"  ? "device.notification.permission.denied" :
                             "device.notification.permission.requested"; // "default"
    const p = emit(evtType, { result });
    exportToHubIfEnabled(p);
    return result;
    }

  /* --------------------------------- Simple -------------------------------- */

  async simple(title, body, options = {}) {
    if (!notifSupported() || !swSupported()) return false;
    if ((await this.ensurePermission()) !== "granted") return false;
    const reg = await getRegistration();
    if (!reg) return false;
    const tag = options.tag || `ssa-simple-${Date.now()}`;
    const ok = await show(reg, title, {
      body,
      tag,
      icon: options.icon || "/icons/ssa-192.png",
      badge: options.badge || "/icons/ssa-badge-72.png",
      data: options.data || {},
    });
    if (ok) {
      const p = emit("device.notification.show", { tag, title });
      exportToHubIfEnabled(p);
    }
    return ok;
  }

  /* -------------------------- Ongoing Session API -------------------------- */

  async sessionStarted(session) {
    return this._ongoingUpdate(session, { paused: false, reason: "started" });
  }

  async sessionStepChanged(session, step, { paused = false } = {}) {
    return this._ongoingUpdate(session, { paused, step, reason: "step.changed" });
  }

  async sessionPaused(session) {
    return this._ongoingUpdate(session, { paused: true, reason: "paused" });
  }

  async sessionResumed(session) {
    return this._ongoingUpdate(session, { paused: false, reason: "resumed" });
  }

  async sessionCompleted(session) {
    const tag = toSessionTag(session?.id);
    const title = `✅ ${session?.title || "Session"} completed`;
    const body = `All steps done. Tap to review.`;
    return this._finalNote(tag, title, body);
  }

  async sessionAborted(session) {
    const tag = toSessionTag(session?.id);
    const title = `⛔ ${session?.title || "Session"} aborted`;
    const body = `Session stopped. Tap to review or restart.`;
    return this._finalNote(tag, title, body);
  }

  async closeOngoing(sessionId) {
    // No direct close API from page; re-show with empty body & close-on-click OR
    // send a directive to SW to close existing notifications by tag.
    try {
      const reg = await getRegistration();
      if (!reg) return false;
      reg.active?.postMessage?.({ type: "SSA_NOTIFICATIONS_CLOSE", tag: toSessionTag(sessionId) });
      const p = emit("device.notification.close", { tag: toSessionTag(sessionId) });
      exportToHubIfEnabled(p);
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------- Internals ------------------------------- */

  async _ongoingUpdate(session, { paused, step, reason }) {
    if (!notifSupported() || !swSupported()) return false;
    if ((await this.ensurePermission()) !== "granted") return false;

    const reg = await getRegistration();
    if (!reg) return false;

    const tag = toSessionTag(session?.id);
    const currentIdx = Number(session?.progress?.currentStepIndex) || 0;
    const total = (Array.isArray(session?.steps) && session.steps.length) || 0;

    const stepTitle =
      step?.title ||
      (Array.isArray(session?.steps) && session.steps[currentIdx]?.title) ||
      "Current step";

    const title = paused
      ? `⏸️ ${session?.title || "Session"}`
      : `▶️ ${session?.title || "Session"}`;

    const body = paused
      ? `Paused at step ${currentIdx + 1}/${total}: ${stepTitle}`
      : `Step ${currentIdx + 1}/${total}: ${stepTitle}`;

    const options = buildOngoingOptions({
      tag,
      body,
      paused,
      stepIdx: currentIdx,
      totalSteps: total,
    });

    const ok = await show(reg, title, options);

    const evtType = reason === "step.changed" ? "device.notification.update" : "device.notification.show";
    const p = emit(evtType, { tag, title, paused, stepIdx: currentIdx, totalSteps: total, reason });
    exportToHubIfEnabled(p);

    return ok;
  }

  async _finalNote(tag, title, body) {
    if (!notifSupported() || !swSupported()) return false;
    if ((await this.ensurePermission()) !== "granted") return false;

    const reg = await getRegistration();
    if (!reg) return false;

    const ok = await show(reg, title, {
      body,
      tag,
      renotify: true,
      requireInteraction: false, // allow auto-dismiss by the OS
      silent: false,
      icon: "/icons/ssa-192.png",
      badge: "/icons/ssa-badge-72.png",
      actions: [{ action: "open", title: "Open" }],
      data: { kind: "ssa.final.session" },
    });

    const p = emit("device.notification.update", { tag, title, reason: "final" });
    exportToHubIfEnabled(p);

    return ok;
  }

  _wireSwMessageBridge() {
    if (!swSupported()) return;
    try {
      navigator.serviceWorker.addEventListener("message", (event) => {
        const msg = event?.data || {};
        if (!msg || !msg.type) return;

        if (msg.type === "SSA_NOTIFICATION_ACTION") {
          const payload = emit("device.notification.action", {
            action: msg.action,
            tag: msg.tag,
            stepIdx: msg.stepIdx,
            totalSteps: msg.totalSteps,
          });
          exportToHubIfEnabled(payload);
        }
      });
    } catch {
      /* no-op */
    }
  }
}

const notifications = new NotificationsService();
export default notifications;
