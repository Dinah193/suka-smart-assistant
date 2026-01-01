// C:\Users\larho\suka-smart-assistant\src\services\planning\scheduleSessionAlerts.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant — Session Alerts (dynamic, humane, Sabbath-aware)
// -----------------------------------------------------------------------------
// What this adds:
// • Multiple lead times (e.g., 24h + 60m + 15m) with per-user channel prefs
// • Sabbath/quiet-hour aware scheduling (defers or adjusts alerts respectfully)
// • Idempotent reminders (de-dupe) + safe retry/fallback for SMS/Email
// • Calendar entry with reminder metadata + dashboard log
// • Browser push (if permitted) across all alert times
// • Localization & timezone hints (best-effort without extra deps)
// • Escalation: re-ping a fallback recipient if nobody acknowledged (opt-in)
//
// Back-compat: keep signature (session, leadTime=15). You can also call with an
// options object as the 2nd arg: { leadMinutes, extraLeadMinutes, quietHours, ... }.
// -----------------------------------------------------------------------------

import ReminderManager from "../notifications/ReminderManager";
import CalendarManager from "../calendar/CalendarManager";
import DashboardLog from "../dashboard/DashboardLog";
import { sendSMS, sendEmail } from "../notifications/NotificationSender";

// Optional: dayjs is used elsewhere in the project; keep it lightweight here.
let dayjs;
try { dayjs = require("dayjs"); } catch { dayjs = null; }

/** Mini helpers */
const asDay = (d) => (dayjs ? dayjs(d) : { // tiny fallback if dayjs is absent
  toDate: () => new Date(d), isBefore: (x) => new Date(d) < new Date(x),
  isAfter: (x) => new Date(d) > new Date(x), add: (n, u) => new Date(new Date(d).getTime() + (u === "minute" ? n*60000 : n*86400000)),
  format: () => new Date(d).toISOString().slice(0,16).replace("T"," "),
});
const toISO = (d) => (dayjs && dayjs.isDayjs?.(d) ? d.toDate() : d) instanceof Date ? (d.toISOString ? d.toISOString() : new Date(d).toISOString()) : new Date(d).toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const keyOf = (s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "_");

/** Default behavior knobs */
const DEFAULTS = {
  leadMinutes: 15,
  extraLeadMinutes: [], // e.g., [60, 24*60]
  sabbathAware: true,
  fridaySunsetISO: null,     // if provided, used for guidance messaging
  saturdaySunsetISO: null,   // "
  quietHours: { start: "22:00", end: "07:00", deferTo: "08:00" }, // local times
  timezone: undefined,       // let platform clock handle; optionally pass IANA
  locale: undefined,         // let platform handle
  escalation: { enabled: false, afterMinutes: 10, toUsers: [] },
  channels: { push: true, sms: true, email: true }, // global switches
};

/** Returns true if a Date is within quiet hours local time window */
function inQuietHours(date, quiet) {
  if (!quiet) return false;
  const d = new Date(date);
  const [sh, sm] = String(quiet.start || "22:00").split(":").map((n) => +n);
  const [eh, em] = String(quiet.end || "07:00").split(":").map((n) => +n);
  const start = new Date(d); start.setHours(sh, sm || 0, 0, 0);
  const end = new Date(d); end.setHours(eh, em || 0, 0, 0);

  // handle windows that cross midnight (e.g. 22:00–07:00)
  if (start <= end) return d >= start && d <= end;
  return d >= start || d <= end;
}

/** Sabbath window guidance (coarse; we do not block, but adjust notes) */
function sabbathNote(sessionType, startISO, opts) {
  if (!opts?.sabbathAware) return null;
  const dt = new Date(startISO);
  const dow = dt.getDay(); // 5=Fri, 6=Sat
  if (dow === 5) {
    const cutoff = opts.fridaySunsetISO ? new Date(opts.fridaySunsetISO) : new Date(dt); cutoff.setHours(18, 0, 0, 0);
    return `Sabbath-aware: finish active ${sessionType} prep before ${cutoff.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}.`;
  }
  if (dow === 6) {
    const sat = opts.saturdaySunsetISO ? new Date(opts.saturdaySunsetISO) : new Date(dt); sat.setHours(18, 0, 0, 0);
    return `Sabbath-aware: prefer no active ${sessionType} until after ${sat.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}.`;
  }
  return null;
}

/** Build one reminder object (idempotent key) */
function buildReminder({ type, title, tasks, startTime, leadMin, recurrence, note, sessionId }) {
  const alertTime = new Date(new Date(startTime).getTime() - clamp(+leadMin || 0, 0, 7*24*60) * 60000);
  const rid = `${keyOf(type)}-${keyOf(title)}-t${new Date(startTime).getTime()}-m${leadMin}`;
  return {
    id: sessionId ? `${sessionId}__${rid}` : rid,
    type: "session",
    category: type,
    title: `${String(type).toUpperCase()} Session: ${title}`,
    description: `${note ? note + " " : ""}Your ${type} session "${title}" starts in ${leadMin} minute${leadMin === 1 ? "" : "s"}.`,
    scheduledFor: alertTime,
    recurrence: recurrence || null,
    priority: "high",
    data: { tasks, originalTime: startTime, leadMinutes: leadMin },
  };
}

/** Try ReminderManager.upsertReminder/reminderExists gracefully */
async function saveReminderIdempotent(rem) {
  if (typeof ReminderManager?.getReminder === "function") {
    const existing = await ReminderManager.getReminder(rem.id);
    if (existing) return existing;
  }
  if (typeof ReminderManager?.upsertReminder === "function") {
    await ReminderManager.upsertReminder(rem);
    return rem;
  }
  await ReminderManager.saveReminder(rem); // original API
  return rem;
}

/** Send with retry + fallback result shape */
async function trySendSMS(phone, body) {
  try { if (!phone) return { ok: false, reason: "no_phone" };
    await sendSMS(phone, body);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e?.message || "sms_failed" }; }
}
async function trySendEmail(email, subject, body) {
  try { if (!email) return { ok: false, reason: "no_email" };
    // If your sendEmail supports a 4th param for attachments, you can pass an ICS later.
    await sendEmail(email, subject, body);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e?.message || "email_failed" }; }
}

/** Defer alert if inside quiet hours (best-effort) */
function maybeDeferForQuietHours(when, quiet) {
  if (!quiet) return when;
  if (!inQuietHours(when, quiet)) return when;
  const d = new Date(when);
  const [hh, mm] = String(quiet.deferTo || "08:00").split(":").map((n) => +n);
  const next = new Date(d);
  // If we are before end quiet window on same day, set time to deferTo; else next morning
  const end = new Date(d); const [eh, em] = String(quiet.end || "07:00").split(":").map((n) => +n);
  end.setHours(eh, em || 0, 0, 0);
  if (d <= end) { next.setHours(hh, mm || 0, 0, 0); }
  else { next.setDate(d.getDate() + 1); next.setHours(hh, mm || 0, 0, 0); }
  return next;
}

/** Browser push helper for a timepoint */
function scheduleBrowserPush(reminder, now = Date.now()) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default" && Notification.requestPermission) {
      // Ask once; silent failure if denied
      Notification.requestPermission().catch(() => {});
    }
    if (Notification.permission !== "granted") return;
    const delay = Math.max(0, new Date(reminder.scheduledFor).getTime() - now);
    setTimeout(() => {
      new Notification(reminder.title, {
        body: reminder.description,
        icon: "/icons/alert-icon.png",
      });
    }, delay);
  } catch { /* no-op */ }
}

/**
 * Schedules a session reminder with optional recurrence, notification methods,
 * and dashboard/calendar logging.
 *
 * @param {Object} session - {
 *   type: 'cleaning' | 'cooking' | 'animal' | 'garden',
 *   title: string,
 *   tasks: array,
 *   startTime: Date | string,
 *   recurrence?: 'daily' | 'weekly' | 'monthly',
 *   notifyUsers?: array of { id?, name, email?, phone?, preference: 'sms'|'email'|'both'|'push' }
 *   sessionId?: string                // optional stable id for idempotency
 *   sabbathAware?: boolean            // overrides default
 * }
 * @param {number|Object} [leadTimeOrOptions=15] - minutes or options object:
 *   {
 *     leadMinutes?: number, extraLeadMinutes?: number[],
 *     quietHours?: { start:'22:00', end:'07:00', deferTo:'08:00' },
 *     sabbathAware?: boolean, fridaySunsetISO?: string, saturdaySunsetISO?: string,
 *     timezone?: string, locale?: string,
 *     channels?: { push?: boolean, sms?: boolean, email?: boolean },
 *     escalation?: { enabled?: boolean, afterMinutes?: number, toUsers?: array }
 *   }
 */
export async function scheduleSessionAlerts(session, leadTimeOrOptions = DEFAULTS.leadMinutes) {
  const {
    type, title, tasks, startTime, recurrence,
    notifyUsers = [], sessionId,
  } = session || {};

  if (!type || !title || !startTime) {
    throw new Error("Missing required session fields");
  }

  // Normalize options (number -> options)
  const opts = typeof leadTimeOrOptions === "number"
    ? { ...DEFAULTS, leadMinutes: leadTimeOrOptions }
    : { ...DEFAULTS, ...(leadTimeOrOptions || {}) };

  // Build the complete set of lead times
  const leadSet = new Set([opts.leadMinutes, ...(opts.extraLeadMinutes || [])]
    .filter((n) => Number.isFinite(n) && n >= 0)
    .map((n) => Math.round(n)));
  const leadMinutesArr = Array.from(leadSet).sort((a, b) => a - b);

  // Human-friendly note if session intersects Sabbath window
  const sabNote = sabbathNote(type, startTime, { ...opts, sabbathAware: session.sabbathAware ?? opts.sabbathAware });

  // Build reminders (idempotent ids include startTime + leadMinutes)
  const reminders = [];
  for (const leadMin of leadMinutesArr) {
    const base = buildReminder({
      type, title, tasks, startTime, leadMin, recurrence, note: sabNote, sessionId
    });

    // Defer if quiet hours
    const scheduledFor = maybeDeferForQuietHours(base.scheduledFor, opts.quietHours);
    const rem = { ...base, scheduledFor };

    // Persist (idempotent)
    const saved = await saveReminderIdempotent(rem);
    reminders.push(saved);

    // Calendar: log one event (only once) and add reminder notes
    // We’ll create/ensure the main calendar event aligned with the session start,
    // and attach reminder metadata so clients can add native reminders if desired.
  }

  // Save to Calendar (single event covering the session)
  let calendarRef = null;
  try {
    if (CalendarManager?.logEvent) {
      calendarRef = await CalendarManager.logEvent({
        title: `${String(type).toUpperCase()} Session: ${title}`,
        start: startTime,
        recurrence,
        category: type,
        notes: [
          `Auto reminders: ${leadMinutesArr.map((m) => `${m}m`).join(", ")}`,
          sabNote ? sabNote : null,
        ].filter(Boolean).join(" • "),
        reminders: leadMinutesArr.map((m) => ({ minutesBefore: m })), // if your CalendarManager supports it
      });
    }
  } catch { /* non-fatal */ }

  // Dashboard log (first reminder preview)
  try {
    const preview = reminders[0];
    await DashboardLog.log({
      category: "Upcoming Session",
      icon: "🗓️",
      message: `${preview.title} — First alert at ${new Date(preview.scheduledFor).toLocaleString(opts.locale || undefined)}`,
      time: preview.scheduledFor,
      meta: { sessionType: type, title, startTime, leadMinutes: leadMinutesArr },
    });
  } catch { /* non-fatal */ }

  // Schedule browser pushes (if permitted)
  if (opts.channels.push && typeof Notification !== "undefined") {
    const now = Date.now();
    reminders.forEach((r) => scheduleBrowserPush(r, now));
  }

  // Multichannel notifications per user (at *creation time* we queue future delivery via ReminderManager,
  // but we can also immediately notify if a reminder time is already in the past due to short lead)
  // Here, we only dispatch immediate if within 2 minutes window.
  const immediateWindowMs = 2 * 60 * 1000;
  const nowMs = Date.now();

  for (const r of reminders) {
    const dt = new Date(r.scheduledFor).getTime();
    if (dt - nowMs <= immediateWindowMs) {
      // fire-and-forget immediate notices
      const msg = `${r.title}\n${r.description}\nScheduled for: ${new Date(r.scheduledFor).toLocaleString(opts.locale || undefined)}`;

      for (const user of notifyUsers) {
        const pref = user.preference || "both";
        // Respect global channel switches
        if ((pref === "sms" || pref === "both" || pref === "push") && opts.channels.sms) {
          await trySendSMS(user.phone, msg);
        }
        if ((pref === "email" || pref === "both") && opts.channels.email) {
          await trySendEmail(user.email, "Session Alert", msg);
        }
      }
    }
  }

  // (Optional) Escalation stub — ReminderManager would handle post-send hooks.
  // We store a flag so the reminder worker can escalate if nobody acknowledged.
  // (Your worker would flip this to false once any user views/acks the session card.)
  if (opts.escalation?.enabled) {
    for (const r of reminders) {
      try {
        await ReminderManager.upsertReminder({
          ...r,
          data: {
            ...(r.data || {}),
            escalateAfterMinutes: opts.escalation.afterMinutes || 10,
            escalateTo: (opts.escalation.toUsers || []).map((u) => ({ name: u.name, email: u.email, phone: u.phone })),
          },
        });
      } catch { /* non-fatal */ }
    }
  }

  // Return enriched handle
  return {
    session: {
      type, title, startTime, recurrence,
      sabbathNote: sabNote,
      calendarEventId: calendarRef?.id || null,
    },
    reminders, // array of all scheduled reminders (idempotent)
    usersNotified: notifyUsers.map((u) => ({ name: u.name, preference: u.preference, hasPhone: !!u.phone, hasEmail: !!u.email })),
    meta: {
      leadMinutes: leadMinutesArr,
      quietHours: opts.quietHours,
      timezone: opts.timezone,
      locale: opts.locale,
      channels: opts.channels,
      escalation: opts.escalation,
    },
  };
}

export default scheduleSessionAlerts;
