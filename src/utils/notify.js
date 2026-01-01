// C:\Users\larho\suka-smart-assistant\src\utils\notify.js
/**
 * utils/notify.js — Visibility-aware Web Notifications with audio-beep fallback
 *
 * Where this fits in SSA:
 * - SSA's pipeline is imports → intelligence → automation → (optional) hub export.
 * - This utility lives in the "automation / execution UX" layer to surface events
 *   (e.g., timers done, inventory shortage, harvest reminders) without mutating data.
 * - It emits standardized telemetry on the shared eventBus: { type, ts, source, data }.
 *
 * Design goals:
 * - Single, reusable notifier with:
 *    • Visibility awareness: show Notification when tab is hidden; otherwise rely on beep.
 *    • Graceful fallback when Notifications API is unsupported/denied → beep only.
 *    • Tiny WebAudio beep (no MP3 asset) with user-toggle and safe failure in locked contexts.
 *    • Defensive permission request flow (never throws on Safari/HTTP/denied).
 *    • Lightweight rate-limit to prevent spam bursts.
 * - No household data changes are performed here, so no hub export is invoked.
 */

let eventBus = {
  emit: (...a) => console.debug("[notify:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */
const nowISO = () => new Date().toISOString();

function emit(type, data = {}) {
  eventBus.emit({
    type,
    ts: nowISO(),
    source: "utils.notify",
    data,
  });
}

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
const hasNotification = isBrowser && "Notification" in window;

/* -------------------------------------------------------------------------- */
/* Simple rate limiter to prevent spam bursts                                 */
/* -------------------------------------------------------------------------- */
const RATE_WINDOW_MS = 2500; // allow one "visible" or "hidden" notification per 2.5s
let lastHiddenNotifyAt = 0;
let lastVisibleNotifyAt = 0;

function withinRateWindow(kind /* 'hidden' | 'visible' */) {
  const t = Date.now();
  if (kind === "hidden") {
    if (t - lastHiddenNotifyAt < RATE_WINDOW_MS) return true;
    lastHiddenNotifyAt = t;
    return false;
  } else {
    if (t - lastVisibleNotifyAt < RATE_WINDOW_MS) return true;
    lastVisibleNotifyAt = t;
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Defaults & toggles                                                         */
/* -------------------------------------------------------------------------- */
const defaults = {
  icon: "/icons/icon-192.png", // safe default; can be changed at runtime
  badge: "/icons/badge-72.png",
  notificationEnabled: true,
  audioEnabled: true,
  requireInteraction: false,
};

export function setDefaultIcon(iconUrl, badgeUrl) {
  if (typeof iconUrl === "string" && iconUrl) defaults.icon = iconUrl;
  if (typeof badgeUrl === "string" && badgeUrl) defaults.badge = badgeUrl;
}

export function setNotificationEnabled(on) {
  defaults.notificationEnabled = !!on;
  emit("notify.prefs.changed", { notificationEnabled: defaults.notificationEnabled });
}

export function setAudioEnabled(on) {
  defaults.audioEnabled = !!on;
  emit("notify.prefs.changed", { audioEnabled: defaults.audioEnabled });
}

/* -------------------------------------------------------------------------- */
/* Permission helpers                                                         */
/* -------------------------------------------------------------------------- */
export function isNotificationSupported() {
  return hasNotification;
}

export function getNotificationPermission() {
  if (!hasNotification) return "unsupported";
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

/**
 * Ask user for permission if appropriate, but never throw.
 * Returns: 'granted' | 'denied' | 'default' | 'unsupported'
 */
export async function ensureNotificationPermission() {
  if (!hasNotification) return "unsupported";
  try {
    if (Notification.permission === "granted") return "granted";
    if (Notification.permission === "denied") return "denied";
    const res = await Notification.requestPermission();
    emit("notify.permission.requested", { result: res });
    return res;
  } catch (err) {
    emit("notify.error", { stage: "permission", message: err?.message || String(err) });
    return "default";
  }
}

/* -------------------------------------------------------------------------- */
/* WebAudio beep fallback                                                     */
/* -------------------------------------------------------------------------- */
let audioCtx = null;

/**
 * Play a short confirmation beep.
 * Options: { durationMs=220, frequency=880, volume=0.05, type='sine' }
 */
export async function beep(opts = {}) {
  if (!isBrowser || !defaults.audioEnabled) return false;
  const {
    durationMs = 220,
    frequency = 880,
    volume = 0.05,
    type = "sine",
  } = opts;

  try {
    if (!window.AudioContext && !window.webkitAudioContext) {
      emit("notify.audio.unsupported");
      return false;
    }
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    // Some browsers require a user gesture; catch and no-op if blocked
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.value = volume;

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    // quick attack/decay envelope to avoid clicks
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);

    osc.start(now);
    osc.stop(now + durationMs / 1000);

    emit("notify.audio.beep", { durationMs, frequency });
    return true;
  } catch (err) {
    emit("notify.error", { stage: "beep", message: err?.message || String(err) });
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Core notification API                                                      */
/* -------------------------------------------------------------------------- */
/**
 * Low-level: attempt a system Notification (does not consider visibility).
 * Returns the Notification instance or null.
 */
export async function notifyRaw(options = {}) {
  if (!defaults.notificationEnabled || !hasNotification) {
    emit("notify.raw.skipped", { reason: "disabled_or_unsupported", options });
    return null;
  }

  const {
    title = "Suka Smart Assistant",
    body = "",
    tag,
    icon = defaults.icon,
    badge = defaults.badge,
    data,
    requireInteraction = defaults.requireInteraction,
    renotify = true,
    silent = false,
    lang,
    dir,
  } = options || {};

  try {
    const perm = await ensureNotificationPermission();
    if (perm !== "granted") {
      emit("notify.raw.denied", { permission: perm, title });
      return null;
    }
    const n = new Notification(title, {
      body,
      icon,
      badge,
      tag,
      data,
      requireInteraction,
      renotify,
      silent,
      lang,
      dir,
    });

    n.onclick = () => {
      emit("notify.click", { title, tag });
      try {
        // Try to focus the window if user clicks
        window?.focus?.();
        n.close?.();
      } catch {}
    };
    n.onclose = () => emit("notify.close", { title, tag });
    n.onerror = () => emit("notify.error", { stage: "notification.onerror", title, tag });

    emit("notify.raw.sent", { title, tag, requireInteraction });
    return n;
  } catch (err) {
    emit("notify.error", { stage: "notifyRaw", message: err?.message || String(err) });
    return null;
  }
}

/**
 * Visibility-aware high-level notify:
 * - When document.hidden → try system Notification; play beep if requested/needed.
 * - When visible → avoid system popover spam; prefer beep and emit event (UI toasts can subscribe).
 *
 * opts: {
 *   title, body, tag, icon, data,
 *   preferBeep=true,     // still tries Notification if hidden
 *   forceSystem=false,   // force system notification regardless of visibility
 *   requireInteraction, renotify, silent
 * }
 */
export async function notify(opts = {}) {
  if (!isBrowser) return { notified: false, reason: "not_browser" };

  const preferBeep = opts.preferBeep !== false; // default true
  const hidden = document.hidden === true;

  // Rate limit per visibility channel
  if (withinRateWindow(hidden ? "hidden" : "visible")) {
    emit("notify.skipped.ratelimit", { hidden, tag: opts?.tag });
    return { notified: false, reason: "rate_limited" };
  }

  let usedSystem = false;
  let usedBeep = false;

  if (hidden || opts.forceSystem) {
    const n = await notifyRaw(opts);
    usedSystem = !!n;
    // Some platforms respect "silent". If silent AND preferBeep, still add a quiet beep for feedback.
    if (preferBeep && (!n || opts.silent === true)) {
      usedBeep = (await beep()) || usedBeep;
    }
  } else {
    // Visible tab: default to beep + emit event; UI layer can show an in-app toast.
    if (preferBeep) usedBeep = (await beep()) || usedBeep;
    emit("notify.visible.toast", {
      title: opts.title,
      body: opts.body,
      tag: opts.tag,
    });
  }

  emit("notify.done", {
    channel: hidden ? "system" : "visible",
    usedSystem,
    usedBeep,
    tag: opts?.tag,
    title: opts?.title,
  });

  return { notified: usedSystem || usedBeep, usedSystem, usedBeep };
}

/* -------------------------------------------------------------------------- */
/* Status subscription (optional)                                             */
/* -------------------------------------------------------------------------- */
export function onNotifyStatus(cb) {
  if (typeof cb !== "function") return () => {};
  const handler = (evt) => {
    if (!evt || typeof evt !== "object") return;
    if (
      String(evt.type || "").startsWith("notify.") ||
      String(evt.type || "").startsWith("timer.") // often related to notifications
    ) {
      cb(evt);
    }
  };
  const off = eventBus.on(handler);
  return typeof off === "function" ? off : () => {};
}

/* -------------------------------------------------------------------------- */
/* Auto-wiring to common SSA events (opt-in via emitted payloads)             */
/* -------------------------------------------------------------------------- *
 * These are safe defaults. Any SSA module can emit standardized events below
 * to get a user-visible notification + beep without duplicating code here.
 * - timer.completed: MultiTimerPanel, Batch sessions, etc.
 * - inventory.shortage.detected: Inventory engine found shortage
 * - preservation.completed: long-running task finished
 * - garden.harvest.logged: success feedback
 * Extend as needed; this module remains data-agnostic.
 * -------------------------------------------------------------------------- */
try {
  eventBus.on(async (evt) => {
    if (!evt || typeof evt !== "object") return;

    // Cooking/cleaning/garden timers
    if (evt.type === "timer.completed") {
      const label = evt?.data?.label || "Timer";
      await notify({
        title: `${label} done`,
        body: evt?.data?.note || "Time's up.",
        tag: `timer:${evt?.data?.id || label}`,
        preferBeep: true,
      });
      return;
    }

    // Inventory shortage (actionable)
    if (evt.type === "inventory.shortage.detected") {
      await notify({
        title: "Inventory shortage",
        body: evt?.data?.summary || "One or more items fell below threshold.",
        tag: "inventory:shortage",
        preferBeep: true,
        forceSystem: true, // nudge even if visible
      });
      return;
    }

    if (evt.type === "preservation.completed") {
      await notify({
        title: "Preservation complete",
        body: evt?.data?.batchName || "A preservation run has finished.",
        tag: "preservation:completed",
        preferBeep: true,
      });
      return;
    }

    if (evt.type === "garden.harvest.logged") {
      await notify({
        title: "Harvest logged",
        body: evt?.data?.crop ? `Added: ${evt.data.crop}` : "Garden harvest recorded.",
        tag: "garden:harvest",
        preferBeep: true,
      });
      return;
    }
  });
} catch {}

/* -------------------------------------------------------------------------- */
/* Tiny convenience helpers for common call sites                             */
/* -------------------------------------------------------------------------- */
export async function notifyInfo(body, tag = "info") {
  return notify({ title: "Suka", body, tag, preferBeep: true });
}

export async function notifyWarning(body, tag = "warn") {
  return notify({
    title: "Suka — Warning",
    body,
    tag,
    preferBeep: true,
    forceSystem: document.hidden, // system if hidden; otherwise toast+beep
  });
}

export async function notifyCritical(body, tag = "critical") {
  // Always try system + beep for critical alerts
  return notify({
    title: "Suka — Attention Needed",
    body,
    tag,
    preferBeep: true,
    forceSystem: true,
    requireInteraction: true,
    silent: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Notes for integrators                                                      */
/* -------------------------------------------------------------------------- *
 * - In visible contexts, show in-app toasts by subscribing to "notify.visible.toast"
 *   on the eventBus. This keeps OS popovers minimal while giving users feedback.
 * - Respect user toggles via setNotificationEnabled() and setAudioEnabled().
 * - For long-running sessions, pair with utils/awake.keepAwake(true/false).
 */
