// File: src/services/notifications/ReminderManager.js
/**
 * ReminderManager
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Browser-safe notification + reminder scheduling helper for SSA.
 *  - Used by planning/scheduleSessionAlerts.js (and any session planners).
 *
 * Goals
 *  - Never crash builds (no Node imports).
 *  - Degrade gracefully if Notifications or Service Workers are unavailable.
 *  - Support:
 *      • requestPermission()
 *      • scheduleReminder({ id, title, body, atISO, data, tag })
 *      • cancelReminder(id)
 *      • cancelAll()
 *      • list()
 *      • isReady()
 *
 * Notes
 *  - In pure browser mode (no SW), reminders use setTimeout while the tab is alive.
 *  - If your app registers a Service Worker, this manager will also attempt
 *    to forward scheduling to the SW via postMessage (optional).
 */

const SOURCE = "notifications.ReminderManager";

const state = {
  enabled: true,
  scheduled: new Map(), // id -> { id, at, timerId, payload, via, createdAt }
  sw: null,
  swReady: false,
  swInitPromise: null,
  pendingSW: false,
};

function nowMs() {
  return Date.now();
}

function toMsFromISO(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

function isBrowser() {
  return typeof window !== "undefined";
}

function canNotify() {
  return isBrowser() && "Notification" in window;
}

function hasSW() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.serviceWorker &&
    typeof navigator.serviceWorker.getRegistration === "function"
  );
}

function canTimeout() {
  return isBrowser() && typeof window.setTimeout === "function";
}

async function initServiceWorkerBridge() {
  try {
    if (!hasSW()) return false;
    // Dedup concurrent init calls (avoids repeated getRegistration spam)
    if (state.swInitPromise) return state.swInitPromise;

    state.swInitPromise = (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) {
          state.sw = null;
          state.swReady = false;
          return false;
        }
        state.sw = reg;
        state.swReady = !!reg.active;
        return state.swReady;
      } catch {
        state.sw = null;
        state.swReady = false;
        return false;
      } finally {
        // Allow re-init later if registration changes
        state.swInitPromise = null;
      }
    })();

    return await state.swInitPromise;
  } catch {
    state.swInitPromise = null;
    return false;
  }
}

async function requestPermission() {
  try {
    if (!canNotify()) return "unsupported";
    if (Notification.permission === "granted") return "granted";
    if (Notification.permission === "denied") return "denied";
    const res = await Notification.requestPermission();
    return res;
  } catch {
    return "error";
  }
}

function showNotification(payload) {
  try {
    if (!canNotify()) return false;
    if (Notification.permission !== "granted") return false;

    const title = payload?.title || "Reminder";
    const options = {
      body: payload?.body || "",
      tag: payload?.tag || payload?.id || undefined,
      data: payload?.data || {},
      silent: !!payload?.silent,
      requireInteraction: !!payload?.requireInteraction,
    };

    // If SW is available, prefer SW notifications (better UX)
    // Note: showNotification exists on ServiceWorkerRegistration
    if (
      hasSW() &&
      state.sw &&
      typeof state.sw.showNotification === "function"
    ) {
      state.sw.showNotification(title, options);
      return true;
    }

    // Fallback: page notification
    // eslint-disable-next-line no-new
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

function scheduleWithTimeout(id, atMs, payload) {
  const delay = Math.max(0, atMs - nowMs());

  const timerId = window.setTimeout(() => {
    // Fire
    showNotification(payload);

    // Cleanup
    const rec = state.scheduled.get(id);
    if (rec) state.scheduled.delete(id);
  }, delay);

  return timerId;
}

async function postToServiceWorker(msg) {
  try {
    if (!hasSW()) return false;

    // Avoid stampede during init
    if (!state.sw && !state.pendingSW) {
      state.pendingSW = true;
      await initServiceWorkerBridge();
      state.pendingSW = false;
    }

    const reg = state.sw || (await navigator.serviceWorker.getRegistration());
    const active = reg?.active;
    if (!active) return false;

    active.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

function buildPayload(input) {
  return {
    id: input.id,
    title: input.title || "Reminder",
    body: input.body || "",
    atISO: input.atISO,
    tag: input.tag,
    data: input.data || {},
    silent: !!input.silent,
    requireInteraction: !!input.requireInteraction,
    source: SOURCE,
  };
}

/**
 * @param {object} input
 * @param {string} input.id unique reminder id
 * @param {string} input.title notification title
 * @param {string} [input.body]
 * @param {string} input.atISO ISO timestamp for reminder
 * @param {object} [input.data]
 * @param {string} [input.tag]
 * @param {boolean} [input.silent]
 * @param {boolean} [input.requireInteraction]
 * @returns {Promise<{ ok: boolean, reason?: string, via?: "serviceWorker"|"timeout"|"none" }>}
 */
async function scheduleReminder(input) {
  try {
    if (!state.enabled) return { ok: false, reason: "disabled" };
    if (!input || typeof input !== "object")
      return { ok: false, reason: "bad_input" };
    if (!input.id) return { ok: false, reason: "missing_id" };
    if (!input.atISO) return { ok: false, reason: "missing_atISO" };

    const atMs = toMsFromISO(input.atISO);
    if (!Number.isFinite(atMs)) return { ok: false, reason: "bad_atISO" };

    // If reminder is far in the past, refuse (but don't crash)
    // (Allows small clock drift; still lets immediate fire via timeout if desired)
    if (atMs < nowMs() - 60_000) {
      return { ok: false, reason: "atISO_in_past" };
    }

    // Cancel existing reminder with same id
    cancelReminder(input.id);

    const payload = buildPayload(input);

    // Try SW bridge (optional). If SW handles it, we still keep a local entry for UI list.
    await initServiceWorkerBridge();
    const swScheduled = await postToServiceWorker({
      type: "SSA_REMINDER_SCHEDULE",
      payload,
    });

    let timerId = null;
    let via = "none";

    if (swScheduled) {
      via = "serviceWorker";
    } else if (canTimeout()) {
      timerId = scheduleWithTimeout(input.id, atMs, payload);
      via = "timeout";
    } else {
      via = "none";
    }

    state.scheduled.set(input.id, {
      id: input.id,
      at: atMs,
      timerId,
      payload,
      via,
      createdAt: nowMs(),
    });

    return { ok: true, via };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/**
 * @param {string} id
 * @returns {boolean}
 */
function cancelReminder(id) {
  if (!id) return false;
  const rec = state.scheduled.get(id);
  if (!rec) return false;

  try {
    if (rec.timerId != null && isBrowser()) {
      window.clearTimeout(rec.timerId);
    }
  } catch {
    // ignore
  }

  // Inform SW if it was used (best-effort)
  postToServiceWorker({ type: "SSA_REMINDER_CANCEL", id }).catch(() => {});

  state.scheduled.delete(id);
  return true;
}

function cancelAll() {
  const ids = Array.from(state.scheduled.keys());
  for (const id of ids) cancelReminder(id);
  return ids.length;
}

function list() {
  return Array.from(state.scheduled.values())
    .sort((a, b) => a.at - b.at)
    .map((r) => ({
      id: r.id,
      atISO: new Date(r.at).toISOString(),
      via: r.via,
      title: r.payload?.title,
      body: r.payload?.body,
      data: r.payload?.data,
      tag: r.payload?.tag,
    }));
}

function isReady() {
  return {
    enabled: state.enabled,
    notificationSupported: canNotify(),
    permission: canNotify() ? Notification.permission : "unsupported",
    canTimeout: canTimeout(),
    serviceWorkerAvailable: hasSW(),
    serviceWorkerReady: !!state.swReady,
  };
}

function setEnabled(next) {
  state.enabled = !!next;
  if (!state.enabled) cancelAll();
  return state.enabled;
}

const ReminderManager = {
  requestPermission,
  scheduleReminder,
  cancelReminder,
  cancelAll,
  list,
  isReady,
  setEnabled,
};

export default ReminderManager;
export {
  requestPermission,
  scheduleReminder,
  cancelReminder,
  cancelAll,
  list,
  isReady,
  setEnabled,
};
