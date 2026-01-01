// C:\Users\larho\suka-smart-assistant\src\utils\ics.js
/**
 * utils/ics.js — Generate .ics files for “Add to calendar”
 *
 * Where this fits in SSA:
 * - SSA pipeline: imports → intelligence → automation → (optional) hub export.
 * - This module lives in the “execution UX” layer to let users add scheduled
 *   sessions (cooking, cleaning, garden, animal, preservation) to their calendar.
 * - It does NOT mutate household data, so no hub export is invoked here.
 * - All operations emit standardized telemetry to the shared eventBus with
 *   payloads of shape { type, ts, source, data }.
 *
 * Features:
 * - RFC 5545–compliant VCALENDAR/VEVENT builder (UTF-8, CRLF, folded lines).
 * - UTC or local time with TZID (caller’s choice).
 * - Supports: SUMMARY, DESCRIPTION, LOCATION, URL, CATEGORIES, ATTENDEE/ORGANIZER,
 *   RRULE, EXDATE, STATUS, VALARM (popup/audio), DURATION / DTEND handling.
 * - Multi-event support: build one calendar with many VEVENTs.
 * - Browser helpers to trigger a download or create an object URL.
 *
 * Forward-thinking extension points:
 * - Domain-aware converters (e.g., session → event): see `eventFromSession()`.
 * - Add domain-specific categories like "SSA;Cooking" or "SSA;Garden".
 * - Hook into automation to auto-offer “Add to calendar” after a plan is approved.
 */

let eventBus = {
  emit: (...a) => console.debug("[ics:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

/* -------------------------------------------------------------------------- */
/* Event helpers                                                              */
/* -------------------------------------------------------------------------- */
const nowISO = () => new Date().toISOString();
function emit(type, data = {}) {
  try {
    eventBus.emit({ type, ts: nowISO(), source: "utils.ics", data });
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* RFC 5545 helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Escape text per RFC 5545 §3.3.11 (commas, semicolons, backslashes, CRLF).
 */
function icsEscapeText(value = "") {
  const s = String(value ?? "");
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r(?!\n)/g, "") // strip stray CR
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Fold long lines to 75 octets (approx chars) with CRLF + single space continuation.
 * We approximate by characters (safe for BMP, fine for most i18n).
 */
function foldLine(line) {
  const MAX = 75;
  if (line.length <= MAX) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i + MAX);
    out += (i === 0 ? "" : "\r\n ") + chunk;
    i += MAX;
  }
  return out;
}

/**
 * Build an ICS content line with optional params: line("DTSTART", "20250101T170000Z", {TZID:"America/Chicago"})
 */
function line(prop, value, params) {
  const p =
    params && typeof params === "object"
      ? ";" +
        Object.entries(params)
          .filter(([_, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(";")
      : "";
  const v = value == null ? "" : String(value);
  return foldLine(`${prop}${p}:${v}`);
}

/* -------------------------------------------------------------------------- */
/* Date formatting                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Format JavaScript Date into ICS DATE or DATE-TIME.
 * opts: { allDay=false, asUTC=true, tzid }:
 *  - allDay=true → YYYYMMDD (DTEND will be exclusive next-day)
 *  - asUTC=true (default) → Zulu “YYYYMMDDTHHMMSSZ”
 *  - asUTC=false + tzid → floating with TZID param (e.g., America/Chicago)
 */
function fmtICSDate(date, { allDay = false, asUTC = true } = {}) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return null;
  if (allDay) {
    return (
      date.getUTCFullYear().toString().padStart(4, "0") +
      (date.getUTCMonth() + 1).toString().padStart(2, "0") +
      date.getUTCDate().toString().padStart(2, "0")
    );
  }
  if (asUTC) {
    const y = date.getUTCFullYear().toString().padStart(4, "0");
    const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
    const d = date.getUTCDate().toString().padStart(2, "0");
    const H = date.getUTCHours().toString().padStart(2, "0");
    const M = date.getUTCMinutes().toString().padStart(2, "0");
    const S = date.getUTCSeconds().toString().padStart(2, "0");
    return `${y}${m}${d}T${H}${M}${S}Z`;
  }
  // Floating (local machine time) — not recommended; better provide TZID outside
  const y = date.getFullYear().toString().padStart(4, "0");
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const d = date.getDate().toString().padStart(2, "0");
  const H = date.getHours().toString().padStart(2, "0");
  const M = date.getMinutes().toString().padStart(2, "0");
  const S = date.getSeconds().toString().padStart(2, "0");
  return `${y}${m}${d}T${H}${M}${S}`;
}

/**
 * Normalize date inputs (Date | number | string) to Date.
 */
function toDate(x) {
  if (x instanceof Date) return x;
  if (typeof x === "number") return new Date(x);
  if (typeof x === "string") {
    const d = new Date(x);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* UID + DTSTAMP                                                              */
/* -------------------------------------------------------------------------- */
function genUID(seed = "") {
  const rand = Math.random().toString(36).slice(2);
  const base = `${Date.now().toString(36)}-${rand}`;
  const host = (isBrowser && window?.location?.host) || "suka.local";
  return `${base}@${host}${seed ? "-" + String(seed).slice(0, 16) : ""}`;
}

function dtstampUTC() {
  return fmtICSDate(new Date(), { allDay: false, asUTC: true });
}

/* -------------------------------------------------------------------------- */
/* VEVENT builder                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a single VEVENT.
 * input = {
 *   start, end, durationMs, allDay,
 *   summary, description, location, url,
 *   categories: string | string[],
 *   organizer: { name, email },
 *   attendees: [{ name, email, role, partstat, rsvp }],
 *   rrule: "FREQ=DAILY;COUNT=5",
 *   exdate: [Date|string|number, ...],
 *   alarm: { triggerMinutes: 10, action: 'DISPLAY'|'AUDIO', description },
 *   status: "CONFIRMED"|"TENTATIVE"|"CANCELLED",
 *   tzid, useUTC=true
 * }
 */
export function buildVEvent(input = {}) {
  const errors = [];
  const allDay = !!input.allDay;
  const useUTC = input.useUTC !== false; // default true
  const tzid = !useUTC && input.tzid ? String(input.tzid) : undefined;

  const start = toDate(input.start);
  const end = toDate(input.end);
  const durationMs = Number.isFinite(input.durationMs) ? input.durationMs : null;

  if (!start) errors.push("Invalid or missing 'start' date.");
  if (!end && !durationMs && !allDay) {
    errors.push("Provide 'end' or 'durationMs' (or set allDay=true).");
  }
  if (errors.length) {
    emit("ics.error", { stage: "buildVEvent.validate", errors });
    return { ok: false, errors };
  }

  const uid = input.uid || genUID(input.summary || "event");
  const dtstamp = dtstampUTC();

  // Dates
  const params = allDay ? { VALUE: "DATE" } : tzid ? { TZID: tzid } : undefined;
  const dtStart = fmtICSDate(start, { allDay, asUTC: useUTC && !tzid });
  let dtEnd = null;

  if (allDay) {
    // All-day DTEND is exclusive next day
    const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1));
    dtEnd = fmtICSDate(next, { allDay: true });
  } else if (end) {
    dtEnd = fmtICSDate(end, { allDay: false, asUTC: useUTC && !tzid });
  }

  const out = [];
  out.push("BEGIN:VEVENT");
  out.push(line("UID", uid));
  out.push(line("DTSTAMP", dtstamp));
  out.push(line("DTSTART", dtStart, params));
  if (dtEnd) {
    out.push(line("DTEND", dtEnd, params));
  } else if (durationMs && !allDay) {
    // DURATION in ISO 8601: PT#H#M#S
    const d = msToISODuration(durationMs);
    out.push(line("DURATION", d));
  }

  if (input.summary) out.push(line("SUMMARY", icsEscapeText(input.summary)));
  if (input.description) out.push(line("DESCRIPTION", icsEscapeText(input.description)));
  if (input.location) out.push(line("LOCATION", icsEscapeText(input.location)));
  if (input.url) out.push(line("URL", String(input.url)));
  if (input.status) out.push(line("STATUS", String(input.status).toUpperCase()));

  // Categories
  if (Array.isArray(input.categories) && input.categories.length) {
    out.push(line("CATEGORIES", input.categories.map(icsEscapeText).join(",")));
  } else if (typeof input.categories === "string" && input.categories) {
    out.push(line("CATEGORIES", icsEscapeText(input.categories)));
  }

  // Organizer
  if (input.organizer?.email) {
    const cn = input.organizer.name ? { CN: icsEscapeText(input.organizer.name) } : undefined;
    out.push(line("ORGANIZER", `mailto:${String(input.organizer.email)}`, cn));
  }

  // Attendees
  if (Array.isArray(input.attendees)) {
    for (const a of input.attendees) {
      if (!a?.email) continue;
      const p = {
        CN: a?.name ? icsEscapeText(a.name) : undefined,
        ROLE: a?.role ? String(a.role).toUpperCase() : undefined,
        PARTSTAT: a?.partstat ? String(a.partstat).toUpperCase() : undefined,
        RSVP: a?.rsvp != null ? String(!!a.rsvp).toUpperCase() : undefined,
      };
      out.push(line("ATTENDEE", `mailto:${String(a.email)}`, p));
    }
  }

  // RRULE
  if (input.rrule) {
    out.push(line("RRULE", String(input.rrule)));
  }

  // EXDATE
  if (Array.isArray(input.exdate) && input.exdate.length) {
    const exVals = input.exdate
      .map(toDate)
      .filter(Boolean)
      .map((d) => fmtICSDate(d, { allDay, asUTC: useUTC && !tzid }))
      .join(",");
    if (exVals) out.push(line("EXDATE", exVals, params));
  }

  // VALARM
  if (input.alarm) {
    const trigMin = Number.isFinite(input.alarm.triggerMinutes) ? input.alarm.triggerMinutes : 10;
    const action = (input.alarm.action || "DISPLAY").toUpperCase(); // DISPLAY|AUDIO
    out.push("BEGIN:VALARM");
    out.push(line("TRIGGER", `-PT${Math.max(0, Math.floor(trigMin))}M`));
    out.push(line("ACTION", action));
    if (action === "DISPLAY") {
      out.push(line("DESCRIPTION", icsEscapeText(input.alarm.description || "Reminder")));
    }
    out.push("END:VALARM");
  }

  out.push("END:VEVENT");

  return { ok: true, vevent: out.join("\r\n"), uid };
}

/* -------------------------------------------------------------------------- */
/* VCALENDAR builder                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build a VCALENDAR wrapping one or more VEVENT contents.
 * options: { prodId, calName, method='PUBLISH'|'REQUEST', timezoneVtimezoneBlock }
 */
export function buildVCalendar(vevents = [], options = {}) {
  if (!Array.isArray(vevents) || vevents.length === 0) {
    emit("ics.error", { stage: "buildVCalendar.validate", reason: "no_vevents" });
    return { ok: false, error: "No VEVENTs provided." };
  }

  const prodId = options.prodId || "-//Suka Smart Assistant//EN";
  const method = options.method || "PUBLISH";
  const calName = options.calName ? icsEscapeText(options.calName) : "Suka Smart Assistant";
  const tzBlock = options.timezoneVtimezoneBlock ? String(options.timezoneVtimezoneBlock) : "";

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    line("PRODID", prodId),
    line("METHOD", method),
    line("X-WR-CALNAME", calName),
  ];
  if (tzBlock) lines.push(tzBlock.trim());

  for (const v of vevents) {
    lines.push(v.endsWith("\r\n") ? v.trim() : v);
  }
  lines.push("END:VCALENDAR");

  const ics = lines.join("\r\n") + "\r\n";
  emit("ics.calendar.built", { events: vevents.length, bytes: ics.length });
  return { ok: true, ics };
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                            */
/* -------------------------------------------------------------------------- */

export function makeICSBlob(icsString) {
  const blob = new Blob([icsString], { type: "text/calendar;charset=utf-8" });
  emit("ics.blob.created", { bytes: icsString.length });
  return blob;
}

export function makeObjectURL(icsString) {
  if (!isBrowser) return null;
  const url = URL.createObjectURL(makeICSBlob(icsString));
  emit("ics.url.created", { url });
  return url;
}

/**
 * Trigger a download in the browser. Returns { ok, url? }.
 */
export function downloadICS(icsString, filename = "suka-event.ics") {
  if (!isBrowser) return { ok: false, error: "not_browser" };
  try {
    const url = makeObjectURL(icsString);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    emit("ics.download.triggered", { filename });
    return { ok: true, url };
  } catch (err) {
    emit("ics.error", { stage: "download", message: err?.message || String(err) });
    return { ok: false, error: err?.message || "download_failed" };
  }
}

/* -------------------------------------------------------------------------- */
/* Domain convenience: session → VEVENT                                        */
/* -------------------------------------------------------------------------- */
/**
 * Convert a SSA session object into a calendar-friendly VEVENT.
 * session = {
 *   id, domain: 'cooking'|'cleaning'|'garden'|'animal'|'preservation',
 *   title, notes, location, url,
 *   start, end, durationMs,
 *   alarmMinutesBefore,
 *   tzid, useUTC,
 * }
 */
export function eventFromSession(session = {}) {
  const domain = String(session.domain || "general");
  const categories = ["SSA", domain.charAt(0).toUpperCase() + domain.slice(1)];
  const alarm =
    Number.isFinite(session.alarmMinutesBefore) && session.alarmMinutesBefore >= 0
      ? { triggerMinutes: session.alarmMinutesBefore, action: "DISPLAY", description: session.title || "Reminder" }
      : undefined;

  return buildVEvent({
    start: session.start,
    end: session.end,
    durationMs: session.durationMs,
    allDay: !!session.allDay,
    summary: prefixTitle(domain, session.title || "Scheduled Session"),
    description: session.notes || "",
    location: session.location || "",
    url: session.url || "",
    categories,
    status: "CONFIRMED",
    alarm,
    tzid: session.tzid,
    useUTC: session.useUTC !== false, // default true
    uid: session.uid || genUID(session.id || domain),
  });
}

function prefixTitle(domain, title) {
  const map = {
    cooking: "Cooking",
    cleaning: "Cleaning",
    garden: "Garden",
    animal: "Animal",
    preservation: "Preservation",
    general: "Session",
  };
  const prefix = map[domain] || "Session";
  return `${prefix}: ${title}`;
}

/* -------------------------------------------------------------------------- */
/* Turn ms into ISO 8601 DURATION (approx, hours/minutes/seconds only)        */
/* -------------------------------------------------------------------------- */
function msToISODuration(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  s -= minutes * 60;
  const seconds = s;
  const parts = ["P", "T"];
  if (hours) parts.push(`${hours}H`);
  if (minutes) parts.push(`${minutes}M`);
  if (seconds || (!hours && !minutes)) parts.push(`${seconds}S`);
  return parts.join("");
}

/* -------------------------------------------------------------------------- */
/* High-level convenience: session → .ics download                            */
/* -------------------------------------------------------------------------- */
export function downloadICSForSession(session, filename) {
  const ev = eventFromSession(session);
  if (!ev.ok) return { ok: false, error: ev.errors?.join("; ") || "build_event_failed" };
  const cal = buildVCalendar([ev.vevent], { calName: "Suka Sessions" });
  if (!cal.ok) return { ok: false, error: cal.error || "build_calendar_failed" };
  const fn =
    filename ||
    `suka-${String(session.domain || "session")}-${(session?.id || "event").toString().slice(0, 12)}.ics`;
  return downloadICS(cal.ics, fn);
}

/* -------------------------------------------------------------------------- */
/* Optional: share sheet helper (if supported)                                */
/* -------------------------------------------------------------------------- */
export async function shareICS(icsString, filename = "suka-event.ics") {
  if (!isBrowser || !navigator?.share || !navigator?.canShare) {
    return { ok: false, error: "web_share_unsupported" };
  }
  try {
    const file = new File([icsString], filename, { type: "text/calendar" });
    if (!navigator.canShare({ files: [file] })) {
      return { ok: false, error: "web_share_cannot_share_file" };
    }
    await navigator.share({ files: [file], title: "Add to Calendar", text: "Suka Smart Assistant" });
    emit("ics.share.shared", { filename });
    return { ok: true };
  } catch (err) {
    emit("ics.error", { stage: "share", message: err?.message || String(err) });
    return { ok: false, error: err?.message || "share_failed" };
  }
}

/* -------------------------------------------------------------------------- */
/* Example extension: build recurring cleaning run (every week)               */
/* -------------------------------------------------------------------------- */
export function buildWeeklyRun({ start, weeks = 6, title = "Weekly Run", domain = "cleaning", tzid, useUTC }) {
  const ev = buildVEvent({
    start,
    durationMs: 60 * 60 * 1000,
    summary: prefixTitle(domain, title),
    categories: ["SSA", "Cleaning"],
    rrule: `FREQ=WEEKLY;COUNT=${Math.max(1, Math.floor(weeks))}`,
    tzid,
    useUTC,
    alarm: { triggerMinutes: 10, action: "DISPLAY", description: "Upcoming cleaning run" },
  });
  if (!ev.ok) return { ok: false, error: ev.errors?.join("; ") || "build_event_failed" };

  const cal = buildVCalendar([ev.vevent], { calName: "Suka – Weekly Runs" });
  if (!cal.ok) return { ok: false, error: cal.error || "build_calendar_failed" };
  return { ok: true, ics: cal.ics };
}

/* -------------------------------------------------------------------------- */
/* Auto-wire: if any engine emits session.scheduled, offer ICS generation     */
/* -------------------------------------------------------------------------- *
 * Expected payload:
 * { type: "session.scheduled", data: { session: {...}, offerICS: true } }
 * We won’t auto-download to avoid surprise; we only emit a toast signal that a UI
 * can catch and show an “Add to calendar” button (which then calls downloadICSForSession()).
 * -------------------------------------------------------------------------- */
try {
  eventBus.on((evt) => {
    if (!evt || typeof evt !== "object") return;
    if (evt.type === "session.scheduled" && evt?.data?.offerICS) {
      emit("ics.offer", {
        sessionId: evt?.data?.session?.id,
        domain: evt?.data?.session?.domain,
      });
    }
  });
} catch {}
