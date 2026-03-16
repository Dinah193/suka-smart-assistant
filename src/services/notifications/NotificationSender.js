// File: C:\Users\larho\suka-smart-assistant\src\services\notifications\NotificationSender.js
/**
 * NotificationSender (SSA)
 * -----------------------------------------------------------------------------
 * Browser-safe notification sending facade.
 *
 * WHY:
 *  - Several modules (planning/session alerts, receipts, escalations) need to "send"
 *    notifications. In a browser-only app, we can't actually send SMS/Email directly
 *    unless there's a backend provider.
 *  - This module provides:
 *      • sendSMS(phone, message, options?)
 *      • sendEmail(email, subject, body, options?)
 *      • sendPush(title, body, options?)   (browser Notification API)
 *      • sendInApp(userId, payload, options?) (DashboardLog / notifications inbox)
 *      • registerProvider(provider)  (optional runtime injection)
 *
 * PROVIDERS:
 *  - You may inject a provider at runtime (recommended):
 *      registerProvider({
 *        sms: async ({ to, message, ... }) => {},
 *        email: async ({ to, subject, body, ... }) => {},
 *        push: async ({ title, body, ... }) => {},
 *        inApp: async ({ userId, payload, ... }) => {},
 *      })
 *
 * FALLBACKS:
 *  - If no provider is registered, sendSMS/sendEmail will:
 *      • log via logger (if available)
 *      • create an in-app notification (DashboardLog) when possible
 *      • return a structured result { ok:false, reason:"no_provider" }
 *  - sendPush uses Notification API if available; otherwise returns no_provider.
 *
 * SAFETY:
 *  - Never import Node modules.
 *  - Never throw for missing providers unless options.throwOnFailure === true.
 */

let logger = null;
try {
  const mod = await import("@/utils/logger.js");
  logger = mod?.default ?? mod ?? null;
} catch {
  logger = null;
}

let DashboardLog = null;
try {
  const mod = await import("@/services/dashboard/DashboardLog.js");
  DashboardLog = mod?.default ?? mod ?? null;
} catch {
  DashboardLog = null;
}

let eventBus = null;
try {
  const mod = await import("@/services/events/eventBus");
  eventBus = mod?.default ?? mod ?? null;
} catch {
  eventBus = null;
}

let autoBus = null;
try {
  const mod = await import("@/services/automation/eventBus.js");
  autoBus = mod?.default ?? mod ?? null;
} catch {
  autoBus = null;
}

const SOURCE = "services.notifications.NotificationSender";

/* -----------------------------------------------------------------------------
 * Provider registry (runtime injection)
 * -------------------------------------------------------------------------- */

const providerState = {
  provider: null, // { sms, email, push, inApp }
  meta: {
    registeredAt: null,
    name: null,
    version: null,
  },
};

export function registerProvider(provider, meta = {}) {
  providerState.provider = provider || null;
  providerState.meta = {
    registeredAt: provider ? new Date().toISOString() : null,
    name: meta?.name || meta?.providerName || null,
    version: meta?.version || null,
  };

  try {
    eventBus?.emit?.("notifications.provider.changed", {
      provider: !!provider,
      meta: providerState.meta,
    });
  } catch {}
  try {
    autoBus?.emit?.("notifications.provider.changed", {
      provider: !!provider,
      meta: providerState.meta,
    });
  } catch {}

  return { ok: true, provider: !!provider, meta: providerState.meta };
}

export function getProviderInfo() {
  return {
    hasProvider: !!providerState.provider,
    meta: { ...providerState.meta },
  };
}

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function safeObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}
function isFn(fn) {
  return typeof fn === "function";
}
function normalizePhone(phone) {
  const p = String(phone || "").trim();
  if (!p) return "";
  // keep digits + leading + only
  const cleaned = p.replace(/[^\d+]/g, "");
  return cleaned;
}
function normalizeEmail(email) {
  return String(email || "").trim();
}
function clampLen(str, max = 1600) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {}
  try {
    autoBus?.emit?.(name, payload);
  } catch {}
}

async function logInApp(message, options = {}) {
  const opts = safeObj(options);
  try {
    if (DashboardLog?.log) {
      await DashboardLog.log({
        category: opts.category || "Notification",
        icon: opts.icon || "🔔",
        message,
        time: opts.time || new Date().toISOString(),
        meta: safeObj(opts.meta),
      });
      return { ok: true, via: "DashboardLog" };
    }
  } catch {
    // ignore
  }
  return { ok: false, via: "none" };
}

function maybeThrow(opts, result) {
  if (opts?.throwOnFailure && !result?.ok) {
    const e = new Error(result?.reason || "notification_failed");
    e.result = result;
    throw e;
  }
  return result;
}

/* -----------------------------------------------------------------------------
 * Public senders
 * -------------------------------------------------------------------------- */

/**
 * Send SMS (requires provider).
 * @param {string} phone
 * @param {string} message
 * @param {object} [options]
 * @param {string} [options.userId]
 * @param {string} [options.tag]
 * @param {object} [options.meta]
 * @param {boolean} [options.fallbackInApp=true]
 * @param {boolean} [options.throwOnFailure=false]
 */
export async function sendSMS(phone, message, options = {}) {
  const opts = safeObj(options);
  const to = normalizePhone(phone);
  const body = clampLen(message, 1800);

  const base = {
    channel: "sms",
    to,
    message: body,
    tag: opts.tag || null,
    userId: opts.userId || null,
    meta: safeObj(opts.meta),
    source: SOURCE,
    at: new Date().toISOString(),
  };

  if (!to) {
    const res = { ok: false, reason: "no_phone", ...base };
    return maybeThrow(opts, res);
  }

  const p = providerState.provider;

  // Primary: provider.sms
  if (p && isFn(p.sms)) {
    try {
      const out = await p.sms({ to, message: body, ...opts, meta: base.meta });
      const res = {
        ok: true,
        provider: providerState.meta,
        result: out ?? null,
        ...base,
      };
      emit("notifications.sent", res);
      return res;
    } catch (err) {
      const reason = String(err?.message || err || "sms_failed");
      try {
        logger?.warn?.("sendSMS failed", { reason, to }, { source: SOURCE });
      } catch {}
      const res = { ok: false, reason, ...base };
      emit("notifications.failed", res);

      // Fallback: in-app log
      if (opts.fallbackInApp !== false) {
        await logInApp(`SMS not sent (${reason}) → ${to}\n${body}`, {
          category: "SMS (failed)",
          icon: "📵",
          meta: { ...base, reason },
        });
      }
      return maybeThrow(opts, res);
    }
  }

  // No provider: fallback
  if (opts.fallbackInApp !== false) {
    await logInApp(`SMS queued (no provider) → ${to}\n${body}`, {
      category: "SMS (queued)",
      icon: "📩",
      meta: base,
    });
  }
  const res = { ok: false, reason: "no_provider", ...base };
  emit("notifications.no_provider", res);
  return maybeThrow(opts, res);
}

/**
 * Send Email (requires provider).
 * @param {string} email
 * @param {string} subject
 * @param {string} body
 * @param {object} [options]
 * @param {string} [options.userId]
 * @param {string} [options.tag]
 * @param {object} [options.meta]
 * @param {boolean} [options.fallbackInApp=true]
 * @param {boolean} [options.throwOnFailure=false]
 */
export async function sendEmail(email, subject, body, options = {}) {
  const opts = safeObj(options);
  const to = normalizeEmail(email);
  const subj = clampLen(subject, 180);
  const msg = clampLen(body, 12000);

  const base = {
    channel: "email",
    to,
    subject: subj,
    body: msg,
    tag: opts.tag || null,
    userId: opts.userId || null,
    meta: safeObj(opts.meta),
    source: SOURCE,
    at: new Date().toISOString(),
  };

  if (!to) {
    const res = { ok: false, reason: "no_email", ...base };
    return maybeThrow(opts, res);
  }

  const p = providerState.provider;

  if (p && isFn(p.email)) {
    try {
      const out = await p.email({
        to,
        subject: subj,
        body: msg,
        ...opts,
        meta: base.meta,
      });
      const res = {
        ok: true,
        provider: providerState.meta,
        result: out ?? null,
        ...base,
      };
      emit("notifications.sent", res);
      return res;
    } catch (err) {
      const reason = String(err?.message || err || "email_failed");
      try {
        logger?.warn?.("sendEmail failed", { reason, to }, { source: SOURCE });
      } catch {}
      const res = { ok: false, reason, ...base };
      emit("notifications.failed", res);

      if (opts.fallbackInApp !== false) {
        await logInApp(`Email not sent (${reason}) → ${to}\nSubject: ${subj}`, {
          category: "Email (failed)",
          icon: "📪",
          meta: { ...base, reason },
        });
      }
      return maybeThrow(opts, res);
    }
  }

  if (opts.fallbackInApp !== false) {
    await logInApp(`Email queued (no provider) → ${to}\nSubject: ${subj}`, {
      category: "Email (queued)",
      icon: "✉️",
      meta: base,
    });
  }
  const res = { ok: false, reason: "no_provider", ...base };
  emit("notifications.no_provider", res);
  return maybeThrow(opts, res);
}

/**
 * Send browser push (Notification API) if permitted.
 * @param {string} title
 * @param {string} body
 * @param {object} [options]
 * @param {string} [options.icon]
 * @param {string} [options.tag]
 * @param {object} [options.data]
 * @param {boolean} [options.requestPermission=true]
 * @param {boolean} [options.throwOnFailure=false]
 */
export async function sendPush(title, body, options = {}) {
  const opts = safeObj(options);
  const t = clampLen(title, 120);
  const b = clampLen(body, 2000);

  const base = {
    channel: "push",
    title: t,
    body: b,
    tag: opts.tag || null,
    data: safeObj(opts.data),
    source: SOURCE,
    at: new Date().toISOString(),
  };

  // Provider override (optional)
  const p = providerState.provider;
  if (p && isFn(p.push)) {
    try {
      const out = await p.push({ title: t, body: b, ...opts, meta: base.data });
      const res = {
        ok: true,
        provider: providerState.meta,
        result: out ?? null,
        ...base,
      };
      emit("notifications.sent", res);
      return res;
    } catch (err) {
      const reason = String(err?.message || err || "push_failed");
      const res = { ok: false, reason, ...base };
      emit("notifications.failed", res);
      return maybeThrow(opts, res);
    }
  }

  // Browser notification
  if (typeof Notification === "undefined") {
    const res = { ok: false, reason: "no_notification_api", ...base };
    emit("notifications.failed", res);
    return maybeThrow(opts, res);
  }

  try {
    if (
      Notification.permission === "default" &&
      opts.requestPermission !== false
    ) {
      await Notification.requestPermission();
    }
    if (Notification.permission !== "granted") {
      const res = { ok: false, reason: "permission_denied", ...base };
      emit("notifications.failed", res);
      return maybeThrow(opts, res);
    }

    // Some browsers may throw if called without user interaction
    new Notification(t, {
      body: b,
      icon: opts.icon || "/icons/alert-icon.png",
      tag: opts.tag || undefined,
      data: opts.data || undefined,
    });

    const res = { ok: true, provider: "browser", ...base };
    emit("notifications.sent", res);
    return res;
  } catch (err) {
    const reason = String(err?.message || err || "push_failed");
    const res = { ok: false, reason, ...base };
    emit("notifications.failed", res);
    return maybeThrow(opts, res);
  }
}

/**
 * Create an in-app notification (DashboardLog).
 * @param {string} userId
 * @param {object} payload - { title?, message, category?, icon?, meta? }
 * @param {object} [options]
 */
export async function sendInApp(userId, payload, options = {}) {
  const opts = safeObj(options);
  const pld = safeObj(payload);

  const message = String(pld.message || pld.body || pld.text || "").trim();
  const title = String(pld.title || "").trim();
  const composed = title ? `${title}\n${message}` : message;

  const base = {
    channel: "inApp",
    userId: userId || null,
    payload: pld,
    source: SOURCE,
    at: new Date().toISOString(),
  };

  const p = providerState.provider;
  if (p && isFn(p.inApp)) {
    try {
      const out = await p.inApp({ userId, payload: pld, ...opts });
      const res = {
        ok: true,
        provider: providerState.meta,
        result: out ?? null,
        ...base,
      };
      emit("notifications.sent", res);
      return res;
    } catch (err) {
      const reason = String(err?.message || err || "inapp_failed");
      const res = { ok: false, reason, ...base };
      emit("notifications.failed", res);
      // fall through to DashboardLog
    }
  }

  const res2 = await logInApp(composed, {
    category: pld.category || "Notification",
    icon: pld.icon || "🔔",
    time: pld.time || new Date().toISOString(),
    meta: { ...safeObj(pld.meta), userId: userId || null },
  });

  const res = {
    ok: res2.ok,
    provider: res2.via,
    ...base,
  };

  emit(res.ok ? "notifications.sent" : "notifications.failed", res);
  return res;
}

/**
 * Convenience: send using a channel hint.
 * @param {"sms"|"email"|"push"|"inApp"} channel
 * @param {object} args - varies by channel
 * @param {object} [options]
 */
export async function send(channel, args, options = {}) {
  const ch = String(channel || "").toLowerCase();
  const a = safeObj(args);
  switch (ch) {
    case "sms":
      return sendSMS(a.to || a.phone, a.message || a.body, {
        ...options,
        ...safeObj(a.options),
      });
    case "email":
      return sendEmail(
        a.to || a.email,
        a.subject || "Notification",
        a.body || a.message,
        { ...options, ...safeObj(a.options) }
      );
    case "push":
      return sendPush(a.title || "Notification", a.body || a.message, {
        ...options,
        ...safeObj(a.options),
      });
    case "inapp":
      return sendInApp(a.userId || a.toUserId, a.payload || a, {
        ...options,
        ...safeObj(a.options),
      });
    default:
      return {
        ok: false,
        reason: "unknown_channel",
        channel: ch,
        source: SOURCE,
        at: new Date().toISOString(),
      };
  }
}

/* -----------------------------------------------------------------------------
 * Default export
 * -------------------------------------------------------------------------- */

const NotificationSender = {
  registerProvider,
  getProviderInfo,
  sendSMS,
  sendEmail,
  sendPush,
  sendInApp,
  send,
};

export default NotificationSender;
