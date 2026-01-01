// src/utils/gardenTaskNormalizer.js
/**
 * Garden calendar → normalized tasks
 *
 * Accepts:
 *  - Buffer/Uint8Array/ArrayBuffer (ICS)
 *  - string (ICS, JSON, CSV, NDJSON, or free text)
 *  - Array<object> (already JSON events/tasks)
 *
 * Returns array of tasks:
 * [{
 *   id, domain:"garden", kind, cropName, bedName, targetDate,
 *   durationMin?, effort?, priority?, tags[], notes?, source, frostSafe?, requiresPrep?, conflicts?
 * }]
 *
 * Goals:
 *  - Work with/without ICS libs (graceful fallbacks)
 *  - Parse titles like "Sow: Carrot @ Bed A (15m)" or "Transplant tomatoes → Bed B"
 *  - Respect frost window hints (tags) and estimate defaults
 *  - Expand simple RRULEs within a bounded window
 *  - Keep schema compatible with TaskCard/Decider/Planner
 */

/* ------------------------------ Optional imports ------------------------------ */
let ical = null;          // e.g., 'ical.js' style ICS parser
try { ical = require("ical"); } catch (_) {}
let ical2json = null;     // e.g., 'ics-to-json' style helper
try { ical2json = require("ics-to-json"); } catch (_) {}

/* --------------------------------- Utilities --------------------------------- */
const UID = () => Math.random().toString(36).slice(2, 10);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const stableHash = (obj) => {
  const s = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h.toString(36);
};

const toDate = (v, tz) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string") {
    // If tz provided and string is date-only, keep as local date at 9am by default.
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(v + "T09:00:00"); // 9 AM local default
      return d;
    }
    const d = new Date(v);
    return isNaN(+d) ? null : d;
  }
  return null;
};

const isCSV = (s) => /[,;\t]/.test(s) && /\n/.test(s);
const isNDJSON = (s) => /^\s*{/.test((s || "").trim()) && (s || "").trim().split(/\r?\n/).length > 1;

/* -------------------------------- Lexicons -------------------------------- */
const KIND_PATTERNS = [
  ["sow", /sow(ing)?|seed(ing)?\b/i],
  ["transplant", /transplant|pot[- ]?up|plant out/i],
  ["prune", /prune|deadhead|pinch/i],
  ["harvest", /harvest|pick\b|cut\b/i],
  ["seed-saving", /seed[- ]?saving|save seed|collect seed/i],
  ["water", /water(ing)?\b/i],
  ["weed", /weed(ing)?\b/i],
  ["fertilize", /fertili[sz]e|feed\b/i],
  ["trellis", /trellis|stake|tie up/i],
  ["thin", /\bthin(ning)?\b/i],
  ["harden-off", /harden[- ]?off/i],
];

const PRIORITY_MARKERS = [
  ["high", /\b(high|urgent|critical|asap)\b|!{2,}/i],
  ["medium", /\b(medium|normal)\b/i],
  ["low", /\b(low|nice to have|later)\b/i],
];

const DURATION_RE = /(\b\d{1,3})\s*(min|mins|minutes|m|hours?|hrs?|h)\b/i;

const DEFAULT_KIND_DURATION = {
  sow: 15, transplant: 25, prune: 20, harvest: 20, "seed-saving": 15,
  water: 10, weed: 20, fertilize: 12, trellis: 20, thin: 10, "harden-off": 5, misc: 12
};

const DEFAULT_KIND_EFFORT = {
  sow: 2, transplant: 3, prune: 3, harvest: 2, "seed-saving": 2,
  water: 1, weed: 3, fertilize: 2, trellis: 3, thin: 1, "harden-off": 1, misc: 2
};

/* ----------------------------- Field extractors ----------------------------- */
function parseMinutes(text) {
  const m = (text || "").match(DURATION_RE);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (["min", "mins", "minutes", "m"].includes(unit)) return n;
  if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) return n * 60;
  return null;
}

function parsePriority(text) {
  for (const [p, re] of PRIORITY_MARKERS) if (re.test(text || "")) return p;
  return null;
}

function classifyKind(text) {
  for (const [kind, re] of KIND_PATTERNS) if (re.test(text || "")) return kind;
  // fallbacks
  if (/plant\b|set out\b/i.test(text || "")) return "transplant";
  if (/cut|pick up/i.test(text || "")) return "harvest";
  return "misc";
}

// "Sow: Carrot @ Bed A (15m)" → { cropName:"Carrot", bedName:"Bed A" }
// "Transplant tomatoes → Bed B"
// "Prune blueberries - North Row"
function extractCropBed(text) {
  const out = { cropName: null, bedName: null };
  const t = (text || "");
  // bed via "@ Bed X" or "→ Bed X"
  const bedAt = t.match(/@\s*([^()|•\-–—]+)$/); // tail piece after '@'
  if (bedAt) out.bedName = bedAt[1].trim();
  const bedArrow = t.match(/→\s*([^()|•\-–—]+)$/);
  if (!out.bedName && bedArrow) out.bedName = bedArrow[1].trim();
  // bed after dash
  if (!out.bedName) {
    const dash = t.match(/-\s*([^()]+)$/);
    if (dash && !/\bmin|hrs?\b/i.test(dash[1])) out.bedName = dash[1].trim();
  }
  // crop: after "Sow:"/"Transplant:" or before '@'
  const cropColon = t.match(/^(?:\w[\w -]+:)\s*([^@()\n]+?)(?:\s+[@→-]|$)/i);
  if (cropColon) out.cropName = cropColon[1].trim();
  if (!out.cropName) {
    // before '@' or arrow
    const beforeMarker = t.split(/[@→-]/)[0].replace(/^(sow|transplant|prune|harvest|seed[- ]?saving|water|weed|fertili[sz]e|trellis|thin|harden[- ]?off)[: ]?/i, "");
    if (beforeMarker && beforeMarker.trim().length) out.cropName = beforeMarker.trim();
  }
  // clean crop strings like "(15m)" leftover
  out.cropName = (out.cropName || "").replace(/\(.*?\)$/g, "").trim() || null;
  return out;
}

function parseTags(text, location, description) {
  const tags = new Set();
  const src = [text, location, description].filter(Boolean).join(" ").toLowerCase();
  if (/post-?frost|after frost|last frost\s*\+/.test(src)) tags.add("post-frost");
  if (/pre-?frost|before frost|last frost\s*-/.test(src)) tags.add("pre-frost");
  if (/indoor|tray|cell|module/.test(src)) tags.add("indoor");
  if (/direct sow|direct-sow/.test(src)) tags.add("direct-sow");
  if (/perennial/.test(src)) tags.add("perennial");
  if (/succession/.test(src)) tags.add("succession");
  if (/seed saving|save seed/.test(src)) tags.add("seed-saving");
  if (/trellis|stake/.test(src)) tags.add("trellis");
  if (/deep clean|sanitize/.test(src)) tags.add("sanitize");
  return Array.from(tags);
}

/* ------------------------------ CSV / NDJSON -------------------------------- */
function parseCSV(text) {
  const rows = [];
  let cur = "", row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (q && text[i + 1] === '"') { cur += '"'; i++; } else { q = !q; } }
    else if (c === "," && !q) { row.push(cur); cur = ""; }
    else if ((c === "\n" || c === "\r") && !q) { if (cur.length || row.length) { row.push(cur); rows.push(row); } cur=""; row=[]; if (c==="\r" && text[i+1]==="\n") i++; }
    else { cur += c; }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const body = rows.slice(1);
  return body
    .filter((r) => r.some((c) => String(c || "").trim()))
    .map((r) => {
      const obj = {};
      header.forEach((h, i) => (obj[h] = r[i]));
      return obj;
    });
}

function parseNDJSON(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

/* ------------------------------- ICS parsing -------------------------------- */
/**
 * We try in order:
 * 1) 'ical' package (Node)
 * 2) 'ics-to-json'
 * 3) Tiny fallback that reads DTSTART/DTEND/SUMMARY/DESCRIPTION/LOCATION lines only
 */
function parseICS(text) {
  // 1) ical
  if (ical?.parseICS) {
    try {
      const data = ical.parseICS(text);
      const events = Object.values(data).filter((v) => v.type === "VEVENT");
      return events.map((e) => ({
        start: e.start ? new Date(e.start) : null,
        end: e.end ? new Date(e.end) : null,
        summary: e.summary || "",
        description: e.description || "",
        location: e.location || "",
        rrule: e.rrule || null,
        allDay: !!e.datetype && e.datetype === "date",
      }));
    } catch (_) {}
  }

  // 2) ics-to-json
  if (ical2json) {
    try {
      const arr = ical2json(text);
      return (arr || []).map((e) => ({
        start: toDate(e.startDate || e.start),
        end: toDate(e.endDate || e.end),
        summary: e.title || e.summary || "",
        description: e.description || "",
        location: e.location || "",
        rrule: e.rrule || null,
        allDay: !!e.allDay,
      }));
    } catch (_) {}
  }

  // 3) minimal fallback
  const lines = text.replace(/\r/g, "").split("\n");
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { out.push({ ...cur }); cur = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "BEGIN:VEVENT") cur = { start: null, end: null, summary: "", description: "", location: "", rrule: null, allDay: false };
    else if (line === "END:VEVENT") flush();
    else if (cur) {
      const [k, ...rest] = line.split(":");
      const v = rest.join(":");
      if (k.startsWith("DTSTART")) cur.start = parseICSTime(v);
      else if (k.startsWith("DTEND")) cur.end = parseICSTime(v);
      else if (k.startsWith("SUMMARY")) cur.summary = (v || "").trim();
      else if (k.startsWith("DESCRIPTION")) cur.description = (v || "").replace(/\\n/g, "\n").trim();
      else if (k.startsWith("LOCATION")) cur.location = (v || "").trim();
      else if (k.startsWith("RRULE")) cur.rrule = v.trim();
    }
  }
  return out;
}

function parseICSTime(s) {
  if (!s) return null;
  // 20250115T090000Z or 20250115
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return null;
  const [_, Y, M, D, h, mi, se] = m;
  if (h == null) return new Date(`${Y}-${M}-${D}T09:00:00`);
  return new Date(Date.UTC(+Y, +M - 1, +D, +h, +mi, +se || 0));
}

/* ---------------------------- Recurrence expansion ---------------------------- */
/**
 * Very minimal RRULE expander:
 *  - Supports FREQ=DAILY|WEEKLY|MONTHLY and INTERVAL (defaults 1)
 *  - Bounds by options.expandBetween {start,end} (Date)
 *  - Stops after 500 occurrences to avoid runaway
 */
function expandRecurrence(baseEvent, rrule, bounds) {
  const out = [];
  const freq = (rrule.match(/FREQ=(DAILY|WEEKLY|MONTHLY)/i) || [])[1];
  if (!freq) return out;
  const interval = Number((rrule.match(/INTERVAL=(\d+)/i) || [])[1] || 1);
  const untilStr = (rrule.match(/UNTIL=([0-9TZ]+)/i) || [])[1] || null;
  const until = untilStr ? parseICSTime(untilStr) : null;

  let cursor = new Date(baseEvent.start);
  let count = 0;
  const endBound = bounds?.end ? new Date(bounds.end) : new Date(Date.now() + 90 * 86400000);

  while (count < 500) {
    cursor = stepFreq(cursor, freq, interval);
    if (until && cursor > until) break;
    if (cursor > endBound) break;
    const ev = {
      ...baseEvent,
      start: new Date(cursor),
      end: baseEvent.end ? new Date(cursor.getTime() + (baseEvent.end - baseEvent.start)) : null,
    };
    out.push(ev);
    count++;
  }
  return out;
}

function stepFreq(d, freq, interval) {
  const dt = new Date(d);
  if (freq === "DAILY") dt.setDate(dt.getDate() + interval);
  else if (freq === "WEEKLY") dt.setDate(dt.getDate() + 7 * interval);
  else if (freq === "MONTHLY") dt.setMonth(dt.getMonth() + interval);
  return dt;
}

/* ------------------------------- Normalization ------------------------------- */
function normalizeEventToTask(evt, options, source) {
  const tz = options?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const title = evt.summary || evt.title || evt.name || "";
  const description = evt.description || evt.notes || "";
  const location = evt.location || "";

  const kind = (evt.kind && String(evt.kind).toLowerCase()) || classifyKind(`${title} ${description}`);
  const { cropName, bedName } = {
    cropName: evt.cropName || evt.crop || null,
    bedName: evt.bedName || evt.bed || null,
    ...(!evt.cropName && !evt.crop ? extractCropBed(title) : {}),
  };

  const start = toDate(evt.start || evt.date || evt.when, tz);
  const end = toDate(evt.end, tz);
  const durationMin =
    Number.isFinite(evt.durationMin) ? evt.durationMin :
    Number.isFinite(evt.minutes) ? evt.minutes :
    (end && start ? Math.max(1, Math.round((end - start) / 60000)) : parseMinutes(title) || parseMinutes(description) || DEFAULT_KIND_DURATION[kind] || 12);

  const effort = Number.isFinite(evt.effort) ? evt.effort : DEFAULT_KIND_EFFORT[kind] || 2;
  const priority = evt.priority || parsePriority(`${title} ${description}`) || null;
  const tags = Array.from(new Set([...(evt.tags || []), ...parseTags(title, location, description)]));

  const frostSafe = /frost[- ]?safe|hardy/.test(`${title} ${description}`.toLowerCase());
  const requiresPrep = /(soak|pre[- ]?sprout|steriliz|mix|tray)/i.test(`${title} ${description}`);

  const base = {
    domain: "garden",
    kind,
    cropName: (cropName || "").trim() || "Unknown crop",
    bedName: (bedName || "").trim() || "Unassigned",
    targetDate: start || null,
    durationMin,
    effort,
    priority,
    tags,
    notes: description || "",
    frostSafe,
    requiresPrep,
    source,
  };

  const id = evt.id || stableHash({ title, start: start?.toISOString?.(), kind, cropName: base.cropName, bedName: base.bedName });
  return { id, ...base };
}

/* ----------------------------------- Main ----------------------------------- */
/**
 * normalizeGardenCalendar(input, options?)
 * input:
 *  - { buffer, filename }      // ICS bytes (Buffer|Uint8Array|ArrayBuffer)
 *  - string                    // ICS / JSON / CSV / NDJSON / free text
 *  - Array<object>             // already JSON
 * options:
 *  - tz?: string               // IANA tz; defaults to user tz
 *  - expandBetween?: { start: Date, end: Date }  // recurrence bound; default: today..+90d
 *  - sourceMeta?: object
 */
async function normalizeGardenCalendar(input, options = {}) {
  const bounds = options.expandBetween || { start: new Date(), end: new Date(Date.now() + 90 * 86400000) };
  let source = { type: "unknown", ref: null, ...(options.sourceMeta || {}) };
  let events = [];

  // A) Buffer-like (assume ICS calendar)
  if (input && (input.buffer || input instanceof Uint8Array || input instanceof ArrayBuffer)) {
    const buffer = input.buffer || input;
    const text = bufferToString(buffer);
    source = { ...source, type: "ics", ref: input.filename || "calendar.ics" };
    events = parseICS(text);
  }

  // B) string → detect ICS/JSON/NDJSON/CSV/text
  if (!events.length && (typeof input === "string" || input?.text)) {
    const s = typeof input === "string" ? input : input.text;
    // ICS signature
    if (/BEGIN:VCALENDAR/.test(s) || /BEGIN:VEVENT/.test(s)) {
      source = { ...source, type: "ics", ref: source.ref || null };
      events = parseICS(s);
    } else {
      // JSON first
      try {
        const obj = JSON.parse(s);
        if (Array.isArray(obj)) {
          events = obj;
          source = { ...source, type: "json" };
        } else if (obj && typeof obj === "object" && (obj.events || obj.items)) {
          events = obj.events || obj.items;
          source = { ...source, type: "json" };
        }
      } catch (_) {
        if (isNDJSON(s)) {
          events = parseNDJSON(s);
          source = { ...source, type: "ndjson" };
        } else if (isCSV(s)) {
          // expected headers: date,start,end,title,kind,crop,bed,minutes,notes,tags
          const arr = parseCSV(s);
          events = arr.map((o) => ({
            start: o.date || o.start || o.when,
            end: o.end || null,
            summary: o.title || o.summary || "",
            description: o.notes || o.description || "",
            location: o.location || "",
            kind: o.kind,
            cropName: o.crop || o.cropname,
            bedName: o.bed || o.bedname || o.plot,
            minutes: Number(o.minutes || o.durationmin || o.duration),
            tags: (o.tags || "").split(/[|,;]/).map((t) => t.trim()).filter(Boolean),
          }));
          source = { ...source, type: "csv" };
        } else {
          // Plain text: try lines like "2025-03-12 Sow: Carrot @ Bed A (15m)"
          const lines = s.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
          events = lines.map((l) => {
            const m = l.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\s+(.+)$/);
            const when = m ? (m[1] + (m[2] ? `T${m[2]}` : "")) : null;
            const title = m ? m[3] : l;
            return { start: when, summary: title };
          });
          source = { ...source, type: "text" };
        }
      }
    }
  }

  // C) already structured
  if (!events.length && Array.isArray(input)) {
    events = input;
    source = { ...source, type: "json" };
  }

  if (!events.length) return [];

  // Expand recurrences (bounded)
  const expanded = [];
  for (const e of events) {
    expanded.push(e);
    if (e.rrule && e.start) {
      const clones = expandRecurrence(
        { ...e, start: toDate(e.start), end: toDate(e.end) },
        typeof e.rrule === "string" ? e.rrule : String(e.rrule),
        bounds
      );
      expanded.push(...clones);
    }
  }

  // Normalize → tasks
  const tasks = expanded.map((evt) => normalizeEventToTask(evt, options, source));
  const uniq = dedupe(tasks);

  // Lightweight post-pass: ensure kind/crop tags present
  const finalized = uniq.map((t) => {
    const tags = new Set(t.tags || []);
    tags.add(t.kind);
    if (t.cropName && t.cropName !== "Unknown crop") tags.add(t.cropName.toLowerCase());
    if (t.bedName && t.bedName !== "Unassigned") tags.add(t.bedName.toLowerCase());
    return { ...t, tags: Array.from(tags) };
  });

  return finalized;
}

/* --------------------------------- Helpers --------------------------------- */
function bufferToString(buf) {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(buf)) return buf.toString("utf8");
  if (buf instanceof Uint8Array) return new TextDecoder("utf-8").decode(buf);
  if (buf instanceof ArrayBuffer) return new TextDecoder("utf-8").decode(new Uint8Array(buf));
  return String(buf || "");
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.id || stableHash(it);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...it, id: key });
  }
  return out;
}

/* ---------------------------------- Exports ---------------------------------- */
module.exports = {
  normalizeGardenCalendar,
  // internals for tests/tuning
  __internal: {
    parseICS,
    parseICSTime,
    expandRecurrence,
    normalizeEventToTask,
    parseCSV,
    parseNDJSON,
    parseMinutes,
    parsePriority,
    classifyKind,
    extractCropBed,
  },
};

/* ---------------------------------- Usage ------------------------------------
import { normalizeGardenCalendar } from "@/utils/gardenTaskNormalizer";

// A) ICS buffer (upload or fs)
const tasks = await normalizeGardenCalendar({ buffer: icsBytes, filename: "garden.ics" }, {
  tz: "America/New_York",
  expandBetween: { start: new Date(), end: new Date(Date.now() + 60*86400000) }
});

// B) Google/Apple ICS string
const tasks2 = await normalizeGardenCalendar(icsText);

// C) CSV
const csv = "date,title,kind,crop,bed,minutes\n2025-03-12,Sow: Carrot @ Bed A,sow,Carrot,Bed A,15\n";
const tasks3 = await normalizeGardenCalendar(csv);

// D) Free text
const txt = `
2025-04-01 Transplant: Tomatoes → Bed B (30m)
2025-04-03 Prune blueberries - North Row
`;
const tasks4 = await normalizeGardenCalendar(txt);

// E) JSON events
const events = [{ start:"2025-05-10T09:00", summary:"Harvest: Lettuce @ Bed C (20m)" }];
const tasks5 = await normalizeGardenCalendar(events);

// → returns normalized task objects ready for Decider/Planner/Reminders.
------------------------------------------------------------------------------- */
