// src/utils/checklistNormalizer.js
/**
 * Cleaning checklist → normalized tasks
 * - Accepts: Buffer/Uint8Array (PDF), string text, JSON/NDJSON/CSV
 * - Output: [{ id, domain, kind, title, room, dueDate?, frequency?, durationMin?, effort?, priority?, tags[], notes?, source }]
 *
 * Design goals:
 *  - Be resilient (works with or without PDF libs)
 *  - Map common checklist patterns (bullets, numbered lines, tables)
 *  - Infer kind, room, frequency, duration, priority
 *  - Dedupe via stable hash
 *  - No hard deps: attempts pdf-parse, then pdfjs-dist; falls back to plain text
 */

 /* ------------------------------ Optional imports ------------------------------ */
let pdfParse = null;
try { pdfParse = require("pdf-parse"); } catch (_) {}
let pdfjs = null;
try { pdfjs = require("pdfjs-dist"); } catch (_) {}
// If you're bundling in the browser, you can inject a custom PDF text extractor via options.pdfTextExtractor

/* --------------------------------- Utilities --------------------------------- */
const UID = () => Math.random().toString(36).slice(2, 10);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toDate = (d) => {
  if (!d) return null;
  if (d instanceof Date) return d;
  const x = new Date(d);
  return isNaN(+x) ? null : x;
};
const stableHash = (obj) => {
  const s = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(36);
};

const L = (s) => (s || "").toLowerCase();
const isCSV = (s) => /[,;\t]/.test(s) && /\n/.test(s);
const isNDJSON = (s) => /^\s*{/.test(s.trim()) && s.trim().split(/\r?\n/).length > 1;

/* ------------------------------- Domain Lexicon ------------------------------- */
const ROOM_SYNONYMS = {
  kitchen: ["kitchen", "galley"],
  bathroom: ["bathroom", "bath", "wc", "toilet", "restroom"],
  bedroom: ["bedroom", "master", "guest room", "kid room", "nursery"],
  living: ["living room", "lounge", "family room", "den"],
  dining: ["dining", "dining room"],
  hallway: ["hall", "hallway", "entry", "foyer"],
  office: ["office", "study"],
  laundry: ["laundry", "utility room"],
  garage: ["garage"],
  patio: ["patio", "deck", "balcony", "porch"],
};

const KIND_PATTERNS = [
  ["vacuum", /vacuum|hoover|carpet/i],
  ["mop", /mop|mopping|swab|hard floor/i],
  ["dust", /dust|dusting|wipe shelves|wipe surfaces|microfiber/i],
  ["wipe-counters", /counter|worktop|backsplash/i],
  ["glass-mirrors", /mirror|glass|window(?! well)|shower door/i],
  ["toilet", /toilet|wc|commode/i],
  ["sink", /sink|basin/i],
  ["shower-tub", /shower|tub|bath(?!room)/i],
  ["trash", /trash|garbage|rubbish|bin|waste/i],
  ["recycle", /recycle|recycling/i],
  ["laundry", /laundry|wash clothes|fold/i],
  ["bed-linen", /change sheets|linen|bedding/i],
  ["appliances", /fridge|freezer|oven|stove|microwave|dishwasher/i],
  ["disinfect", /sanitize|disinfect|bleach/i],
  ["tidy", /tidy|pick up|declutter|organize/i],
  ["sweep", /sweep|broom/i],
  ["spot-clean", /spot clean|stain|spills?/i],
];

const FREQ_PATTERNS = [
  ["daily", /\b(daily|every day|q?d|qd)\b/i],
  ["weekly", /\b(weekly|every week|q?w|qw)\b/i],
  ["biweekly", /\b(bi-?weekly|every\s*2\s*weeks)\b/i],
  ["monthly", /\b(monthly|every month)\b/i],
  ["quarterly", /\b(quarterly|every 3 months)\b/i],
  ["yearly", /\b(yearly|annually|every year)\b/i],
  ["weekend", /\b(weekend|saturdays?|sundays?)\b/i],
  ["weekday", /\b(weekday|monday|tuesday|wednesday|thursday|friday)s?\b/i],
];

const PRIORITY_MARKERS = [
  ["high", /\b(high|urgent|critical)\b|!{2,}/i],
  ["medium", /\b(medium|normal)\b/i],
  ["low", /\b(low|nice to have|later)\b/i],
];

const DURATION_RE = /(\b\d{1,3})\s*(min|mins|minutes|m|hours?|hrs?|h)\b/i;

/* ------------------------------- PDF extraction ------------------------------- */
async function extractTextFromPDF(buffer, options = {}) {
  if (options.pdfTextExtractor) return options.pdfTextExtractor(buffer);

  // 1) pdf-parse (Node)
  if (pdfParse) {
    try {
      const res = await pdfParse(buffer);
      if (res?.text?.trim()) return res.text;
    } catch (_) {}
  }

  // 2) pdfjs-dist (browser/node) - best effort text join
  if (pdfjs?.getDocument) {
    try {
      const doc = await pdfjs.getDocument({ data: buffer }).promise;
      let text = "";
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        text +=
          content.items
            .map((it) => (typeof it.str === "string" ? it.str : ""))
            .join(" ") + "\n";
      }
      if (text.trim()) return text;
    } catch (_) {}
  }

  // 3) give up
  return null;
}

/* --------------------------------- Parsers --------------------------------- */
function splitLines(text) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\u2022/g, "•")) // normalize dots
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isBullet(line) {
  return /^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line);
}

function stripBullet(line) {
  return line.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim();
}

function parseDuration(line) {
  const m = line.match(DURATION_RE);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (["min", "mins", "minutes", "m"].includes(unit)) return n;
  if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) return n * 60;
  return null;
}

function parseFrequency(line) {
  for (const [label, re] of FREQ_PATTERNS) {
    if (re.test(line)) return label;
  }
  // “every N days/weeks”
  const m = line.match(/\bevery\s+(\d{1,2})\s*(day|days|week|weeks|month|months)\b/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    return unit.startsWith("day") ? `every-${n}d` : unit.startsWith("week") ? `every-${n}w` : `every-${n}mo`;
  }
  return null;
}

function parsePriority(line) {
  for (const [p, re] of PRIORITY_MARKERS) {
    if (re.test(line)) return p;
  }
  if (/\!{2,}/.test(line)) return "high";
  return null;
}

function classifyKind(line) {
  for (const [kind, re] of KIND_PATTERNS) {
    if (re.test(line)) return kind;
  }
  // verb-based fallback
  if (/wipe|clean/i.test(line) && /counter|surface|table/i.test(line)) return "wipe-counters";
  if (/window|mirror/i.test(line)) return "glass-mirrors";
  if (/sheet|bed/i.test(line)) return "bed-linen";
  return "misc";
}

function inferRoom(line) {
  const low = L(line);
  for (const [room, keys] of Object.entries(ROOM_SYNONYMS)) {
    if (keys.some((kw) => low.includes(kw))) return room;
  }
  // quick hints
  if (/carpet|rug/.test(low)) return "living";
  if (/stove|oven|fridge|sink/.test(low)) return "kitchen";
  return null;
}

function parseTags(line) {
  const tags = [];
  if (/pet/i.test(line)) tags.push("pet");
  if (/allergy|dust/i.test(line)) tags.push("allergy");
  if (/eco|green/i.test(line)) tags.push("eco");
  if (/deep clean/i.test(line)) tags.push("deep");
  if (/guest/i.test(line)) tags.push("guest");
  return tags;
}

function estimateDuration(kind, line) {
  const ex = parseDuration(line);
  if (ex) return ex;
  // heuristics (tunable)
  const map = {
    vacuum: 15, mop: 15, sweep: 10, dust: 12, "wipe-counters": 8, "glass-mirrors": 8,
    toilet: 8, sink: 6, "shower-tub": 15, trash: 5, recycle: 5, laundry: 45, "bed-linen": 12,
    appliances: 20, disinfect: 10, tidy: 10, "spot-clean": 6, misc: 10
  };
  return map[kind] || 10;
}

function estimateEffort(kind) {
  const map = { vacuum: 3, mop: 3, dust: 2, toilet: 3, "shower-tub": 4, laundry: 2, appliances: 3, disinfect: 2, tidy: 2 };
  return clamp(map[kind] || 3, 1, 5);
}

function normalizeTask(raw, source) {
  const title = raw.title || raw.task || raw.name || raw.text || "";
  const line = `${title} ${raw.notes || ""}`.trim();
  const kind = (raw.kind && String(raw.kind)) || classifyKind(line);
  const room = raw.room || inferRoom(line);
  const durationMin = Number.isFinite(raw.durationMin) ? raw.durationMin : estimateDuration(kind, line);
  const effort = Number.isFinite(raw.effort) ? raw.effort : estimateEffort(kind);
  const frequency = raw.frequency || parseFrequency(line) || null;
  const priority = raw.priority || parsePriority(line) || null;
  const tags = Array.from(new Set([...(raw.tags || []), ...parseTags(line)]));
  const dueDate =
    raw.dueDate ||
    (/\btoday\b/i.test(line) ? new Date() :
     /\btomorrow\b/i.test(line) ? new Date(Date.now() + 86400000) : null);

  const base = {
    domain: "cleaning",
    kind,
    title: title || "Untitled task",
    room,
    frequency,
    durationMin,
    effort,
    priority,
    tags,
    notes: raw.notes || "",
    dueDate: dueDate ? new Date(dueDate) : null,
    source,
  };
  const id = raw.id || stableHash(base);
  return { id, ...base };
}

/* ------------------------------- Text ingestion ------------------------------- */
function parseTextToLines(text) {
  const lines = splitLines(text);
  const items = [];

  for (const line of lines) {
    if (!line) continue;

    if (isBullet(line)) {
      items.push({ title: stripBullet(line) });
      continue;
    }

    // table-ish rows separated by " - " or " : "
    if (/\s[-–:]\s/.test(line)) {
      const [left, right] = line.split(/\s[-–:]\s/, 2);
      items.push({ title: left.trim(), notes: right.trim() });
      continue;
    }

    // fallback: treat as standalone if short-ish
    if (line.length <= 140 || /^[A-Z][a-z]+/.test(line)) {
      items.push({ title: line });
    }
  }

  return items;
}

/* ------------------------------- CSV / NDJSON -------------------------------- */
function parseCSV(text) {
  // tiny CSV tolerant to quotes
  const rows = [];
  let cur = "", row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (q && text[i + 1] === '"') { cur += '"'; i++; } else { q = !q; }
    } else if (c === "," && !q) { row.push(cur); cur = ""; }
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
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/* ----------------------------------- Main ----------------------------------- */
/**
 * normalizeChecklist(input, options?)
 * input:
 *  - { buffer, mimeType, filename }  // for PDFs (buffer: Buffer|Uint8Array|ArrayBuffer)
 *  - { text }                        // for raw text
 *  - string                          // raw text
 *  - Array<object>                   // already JSON items
 * options:
 *  - pdfTextExtractor?: async (buffer) => string
 *  - sourceMeta?: object
 */
async function normalizeChecklist(input, options = {}) {
  let source = { type: "unknown", ref: null, ...(options.sourceMeta || {}) };
  let candidates = [];

  // Buffer-like → PDF
  if (input && (input.buffer || input instanceof Uint8Array || input instanceof ArrayBuffer)) {
    const buffer = input.buffer || input;
    source = { ...source, type: "pdf", ref: input.filename || "upload.pdf" };

    const text = await extractTextFromPDF(buffer, options);
    if (text) {
      candidates = parseTextToLines(text);
    }
  }

  // Plain string → detect JSON/NDJSON/CSV/text
  if (!candidates.length && (typeof input === "string" || input?.text)) {
    const text = typeof input === "string" ? input : input.text;
    source = { ...source, type: source.type === "unknown" ? "text" : source.type, ref: source.ref };

    // Try JSON first
    try {
      const obj = JSON.parse(text);
      if (Array.isArray(obj)) {
        candidates = obj.map((o) => ({
          title: o.title || o.task || o.name || "",
          kind: o.kind,
          room: o.room,
          notes: o.notes || "",
          durationMin: Number(o.durationMin),
          effort: Number(o.effort),
          frequency: o.frequency,
          priority: o.priority,
          tags: o.tags,
          dueDate: o.dueDate,
          id: o.id,
        }));
      }
    } catch (_) {
      if (isNDJSON(text)) {
        const arr = parseNDJSON(text);
        candidates = arr.map((o) => ({ title: o.title || o.task || o.name || "", ...o }));
      } else if (isCSV(text)) {
        const arr = parseCSV(text);
        candidates = arr.map((o) => ({
          title: o.title || o.task || o.name || o.text || "", // common headers
          kind: o.kind, room: o.room, frequency: o.frequency, notes: o.notes,
          durationMin: Number(o.durationmin || o.duration || o.minutes),
          effort: Number(o.effort),
          priority: o.priority,
          tags: (o.tags || "").split(/[|,;]/).map((t) => t.trim()).filter(Boolean),
          dueDate: o.duedate || o.date || null,
        }));
      } else {
        candidates = parseTextToLines(text);
      }
    }
  }

  // Array of objects
  if (!candidates.length && Array.isArray(input)) {
    candidates = input.map((o) => ({ title: o.title || o.task || o.name || "", ...o }));
    source = { ...source, type: "json" };
  }

  // Fallback
  if (!candidates.length) return [];

  // Normalize + dedupe
  const normalized = candidates
    .map((c) => normalizeTask(c, source))
  ;
  const uniq = dedupe(normalized);

  // Lightweight post-processing: auto-insert room tag, ensure kind tag
  const finalized = uniq.map((t) => {
    const tags = new Set(t.tags || []);
    if (t.room) tags.add(t.room);
    tags.add(t.kind);
    return { ...t, tags: Array.from(tags) };
  });

  return finalized;
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

/* --------------------------------- Exports --------------------------------- */
module.exports = {
  normalizeChecklist,
  // exposed for tests/tuning
  __internal: {
    extractTextFromPDF,
    parseTextToLines,
    parseCSV,
    parseNDJSON,
    normalizeTask,
    classifyKind,
    inferRoom,
    parseFrequency,
    parseDuration,
    estimateDuration,
  },
};

/* --------------------------------- Usage ------------------------------------
import { normalizeChecklist } from "@/utils/checklistNormalizer";

// A) From PDF buffer (Node/browser with arrayBuffer)
const tasks = await normalizeChecklist({ buffer: fs.readFileSync("cleaning-checklist.pdf"), filename: "cleaning-checklist.pdf" });

// B) From pasted text
const tasks2 = await normalizeChecklist(`• Vacuum living room (weekly, 15 min)
- Mop kitchen & hallway (biweekly)
1. Clean toilet & sink (bathroom) - use disinfectant
Take out trash (daily) !!`);

// C) From CSV
const csv = "title,room,frequency,durationMin\nVacuum living room,living,weekly,15\n";
const tasks3 = await normalizeChecklist(csv);

// D) From NDJSON
const nd = '{"title":"Wipe counters","room":"kitchen","frequency":"daily"}\n{"title":"Clean mirrors","room":"bathroom"}';
const tasks4 = await normalizeChecklist(nd);

// Returns array of normalized task objects ready for planner/reminders.
------------------------------------------------------------------------------- */
