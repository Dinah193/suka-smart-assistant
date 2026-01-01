// src/utils/roomProcedureNormalizer.js
/**
 * Room Cleaning SOP → normalized structure
 *
 * Accepts:
 *  - Buffer/Uint8Array/ArrayBuffer (PDF)
 *  - string (raw text, JSON, CSV, NDJSON)
 *  - Array<object> (already structured)
 *
 * Returns:
 * {
 *   id, domain:"cleaning", title, roomType?, zones[], surfaces[],
 *   ppe[], colorCodes:[{color,use}], chemicals:[{name,dilution?,dwellSec?,epaReg?,notes?}],
 *   tools:[], hazards:[{code,description,severity,controls[]}],
 *   preChecks:[{id,text}], steps:[{id,order,text,role?,surface?,product?,dilution?,dwellSec?,timer?,check?,record?}],
 *   postChecks:[{id,text}], quality:[{id,text}], waste:[{id,text}], signage:[{id,text}],
 *   frequency?, records?:[{name,retention?,where?}], signOff?:{required, role?}, source
 * }
 */

/* ------------------------------ Optional imports ------------------------------ */
let pdfParse = null;
try { pdfParse = require("pdf-parse"); } catch (_) {}
let pdfjs = null;
try { pdfjs = require("pdfjs-dist"); } catch (_) {}

/* --------------------------------- Utilities --------------------------------- */
const UID = () => Math.random().toString(36).slice(2, 10);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const stableHash = (obj) => {
  const s = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h.toString(36);
};
const L = (s) => (s || "").toLowerCase();
const linesOf = (text) =>
  (text || "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\u2022/g, "•")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

const isBullet = (l) => /^[-*•]\s+/.test(l) || /^\d+\.\s+/.test(l);
const stripBullet = (l) => l.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim();

const MIN_RE = /(\b\d{1,3})\s*(min|mins|minutes|m|hours?|hrs?|h)\b/i;
const parseMinutes = (text) => {
  const m = (text || "").match(MIN_RE);
  if (!m) return null;
  const n = Number(m[1]); const unit = m[2].toLowerCase();
  if (["min","mins","minutes","m"].includes(unit)) return n;
  if (["h","hr","hrs","hour","hours"].includes(unit)) return n * 60;
  return null;
};

const SEC_RE = /(\b\d{1,4})\s*(sec|secs|seconds|s)\b/i;
const parseSeconds = (text) => {
  const m = (text || "").match(SEC_RE);
  if (!m) return null;
  return Number(m[1]);
};

/* ------------------------------- Domain Lexicon ------------------------------- */
const ROOM_TYPES = {
  bathroom: [/bathroom|restroom|toilet|wc/i],
  kitchen: [/kitchen|galley/i],
  bedroom: [/bedroom|guest room|nursery/i],
  living: [/living room|lounge|family room|den/i],
  hallway: [/hall|hallway|foyer|entry/i],
  dining: [/dining/i],
  office: [/office|study/i],
  laundry: [/laundry|utility room/i],
}

const ZONE_HINTS = [
  ["high-touch", /high[- ]?touch|touchpoint|handle|switch|rail/i],
  ["wet", /sink|shower|tub|toilet|urinal/i],
  ["prep", /counter|worktop|food prep/i],
  ["floor", /\bfloor|mop|sweep|vacuum/i],
  ["trash", /trash|garbage|bin|liner/i],
  ["linen", /linen|sheet|towel|bed/i],
  ["glass", /mirror|glass|window/i],
];

const SURFACE_HINTS = [
  "counter","sink","faucet","handle","doorknob","light switch","toilet seat","toilet handle","urinal",
  "mirror","glass","stainless","appliance","microwave","stove","oven","fridge","tile","grout",
  "desk","table","chair","rail","banister","shower wall","tub","floor","baseboard"
];

const PPE_TERMS = [
  "gloves","nitrile","latex","mask","respirator","n95","face shield","goggles","apron","gown","coveralls","boots","boot covers",
  "eye protection","hearing protection","hair net"
];

const COLOR_CODES = [
  ["red", /(red)\s*(cloth|microfiber|bucket|zone|bath|toilet)/i],
  ["yellow", /(yellow)\s*(cloth|microfiber|general|restroom)/i],
  ["blue", /(blue)\s*(glass|mirror|cloth|microfiber)/i],
  ["green", /(green)\s*(kitchen|food|prep|cloth|microfiber)/i],
];

const CHEM_HINTS = [
  // name, regex
  ["quat", /\bquat|quaternary/i],
  ["bleach", /bleach|sodium hypochlorite|NaOCl/i],
  ["hydrogen-peroxide", /hydrogen peroxide|peroxide|H2O2/i],
  ["alcohol", /isopropyl|ethanol|alcohol/i],
  ["ammonia", /ammonia/i],
  ["neutral-cleaner", /neutral cleaner|ph[- ]?neutral/i],
  ["glass-cleaner", /glass cleaner|ammonia-free/i],
];

const DILUTION_RE = /(\b\d{1,3})\s*[:/]\s*(\d{1,4})\b|\b(\d{2,4})\s*ppm\b/i; // 1:256 or 500 ppm
const EPA_RE = /\bEPA\s*(?:Reg\.?|Registration)\s*(?:No\.?|#)?:?\s*([0-9\-]+)/i;

const HAZARDS = [
  { code:"biohazard", re:/biohazard|bodily fluid|blood|vomit|feces/i, severity:"danger", controls:["PPE","isolate area","use biohazard kit","dispose as regulated waste"] },
  { code:"chemical", re:/bleach|disinfectant|chemical|detergent|peroxide|ammonia|quat/i, severity:"warn", controls:["ventilation","gloves","eye protection","never mix chemicals"] },
  { code:"slip-fall", re:/wet floor|spill|slippery/i, severity:"warn", controls:["caution sign","control access","dry floor thoroughly"] },
  { code:"sharps", re:/sharps|needle|glass shard/i, severity:"warn", controls:["use tools","sharps container","do not compact by hand"] },
  { code:"electric", re:/electric|outlet|cord|appliance/i, severity:"info", controls:["unplug","inspect cables","dry hands"] },
];

/* ------------------------------- PDF extraction ------------------------------- */
async function extractTextFromPDF(buffer, options = {}) {
  if (options.pdfTextExtractor) return options.pdfTextExtractor(buffer);

  if (pdfParse) {
    try { const r = await pdfParse(buffer); if (r?.text?.trim()) return r.text; } catch (_) {}
  }
  if (pdfjs?.getDocument) {
    try {
      const doc = await pdfjs.getDocument({ data: buffer }).promise;
      let t = "";
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        t += content.items.map((it) => (typeof it.str === "string" ? it.str : "")).join(" ") + "\n";
      }
      if (t.trim()) return t;
    } catch (_) {}
  }
  return null;
}

/* -------------------------------- Section split ------------------------------- */
/**
 * Recognizes: Title, Room, Purpose, Scope, Zones, Surfaces, PPE, Color Coding,
 * Chemicals/Products, Dilution, Dwell Time, Safety/Hazards, Preparation/Pre-checks,
 * Procedure/Steps, Quality, Waste, Signage, Post-care/Aftercare, Records, Frequency, Sign-off
 */
function splitIntoSections(text) {
  const lines = linesOf(text);
  const sections = {};
  let current = "body";
  const push = (k, v) => { sections[k] = sections[k] || []; sections[k].push(v); };

  const headerRE = /^(title|room|purpose|scope|zones?|surfaces?|ppe|color(?:\s*coding)?|chemicals?|products?|dilution|dwell\s*time|safety|hazards?|preparation|pre[-\s]?checks?|procedure|steps?|quality|inspection|waste|signage|post[-\s]?(care|checks?)|aftercare|records?|frequency|sign[-\s]?off|approval)\s*[:\-]?$/i;

  for (const raw of lines) {
    const l = raw.trim();
    const hdr = l.match(headerRE);
    if (hdr) { current = hdr[1].toLowerCase(); sections[current] = sections[current] || []; continue; }

    const colon = l.match(/^(room|ppe|color(?:\s*coding)?|chemicals?|products?|dilution|dwell\s*time|safety|hazards?|preparation|procedure|steps?|quality|waste|signage|post[-\s]?(care|checks?)|aftercare|records?|frequency|sign[-\s]?off|approval)\s*:\s*(.+)$/i);
    if (colon) { current = colon[1].toLowerCase(); push(current, colon[2].trim()); continue; }

    push(current, l);
  }
  return sections;
}

/* ------------------------------- Parsers / heuristics ------------------------------- */
function guessTitle(sections) {
  const head = (sections.title || [])[0] || (sections.body || [])[0] || "Room Cleaning Procedure";
  return head.replace(/^(title\s*:\s*)/i, "").trim();
}

function parseRoomType(chunks) {
  const text = (chunks || []).join(" ");
  for (const [type, arr] of Object.entries(ROOM_TYPES)) if (arr.some((re) => re.test(text))) return type;
  // Fallback: simple hints
  if (/toilet|urinal|mirror/.test(text)) return "bathroom";
  if (/counter|stove|fridge/.test(text)) return "kitchen";
  return null;
}

function parseZones(chunks) {
  const text = (chunks || []).join(" ");
  const out = new Set();
  ZONE_HINTS.forEach(([z, re]) => { if (re.test(text)) out.add(z); });
  // Look for “top-to-bottom”, “clean to dirty”
  if (/top[- ]?to[- ]?bottom/i.test(text)) out.add("top-to-bottom");
  if (/clean\s+to\s+dirty/i.test(text)) out.add("clean-to-dirty");
  return Array.from(out);
}

function parseSurfaces(chunks) {
  const text = (chunks || []).join(" ").toLowerCase();
  const out = new Set();
  SURFACE_HINTS.forEach((s) => { if (text.includes(s)) out.add(s); });
  // Capture “touch points” enumeration
  (chunks || []).forEach((ln) => {
    if (/handle|switch|knob|rail|ipad|remote/i.test(ln)) out.add("high-touch");
  });
  return Array.from(out);
}

function parsePPE(chunks) {
  const txt = (chunks || []).join(" ").toLowerCase();
  const ppe = new Set();
  PPE_TERMS.forEach((p) => { if (txt.includes(p)) ppe.add(p); });
  return Array.from(ppe);
}

function parseColorCodes(chunks) {
  const list = [];
  (chunks || []).forEach((ln) => {
    for (const [color, re] of COLOR_CODES) {
      if (re.test(ln)) {
        // attempt to extract a brief use phrase
        const m = ln.match(new RegExp(`${color}\\s*(?:cloth|microfiber|bucket|zone)?\\s*(?:for|\\-|\\:)?\\s*(.+)$`, "i"));
        list.push({ color, use: (m && m[1] ? m[1].trim() : undefined) });
      }
    }
  });
  return dedupeBy(list, (x) => x.color + ":" + (x.use || ""));
}

function parseChemicals(chunks) {
  const text = (chunks || []).join("\n");
  const lines = parseList(chunks);
  const list = [];

  const pushChem = (name, line) => {
    const d = parseDilution(line);
    const dwell = parseDwell(line);
    const epa = parseEPA(line);
    list.push({ name, dilution: d || undefined, dwellSec: dwell || undefined, epaReg: epa || undefined, notes: line.length <= 180 ? undefined : line });
  };

  // Explicit “Product: …”
  lines.forEach((ln) => {
    const m = ln.match(/^([A-Za-z0-9 \-_/]+?)\s*(?:\(|\-|:|$)/);
    if (m && m[1]) pushChem(m[1].trim(), ln);
  });

  // Hints (Quat, Bleach, etc.)
  CHEM_HINTS.forEach(([label, re]) => {
    if (re.test(text)) pushChem(label, label);
  });

  return dedupeBy(list, (x) => x.name + ":" + (x.dilution || "") + ":" + (x.dwellSec || ""));
}

function parseDilution(line) {
  const m = (line || "").match(DILUTION_RE);
  if (!m) return null;
  if (m[3]) return `${m[3]} ppm`;
  return `${m[1]}:${m[2]}`;
}
function parseEPA(line) {
  const m = (line || "").match(EPA_RE);
  return m ? m[1] : null;
}
function parseDwell(lineOrChunks) {
  const s = Array.isArray(lineOrChunks) ? (lineOrChunks || []).join(" ") : (lineOrChunks || "");
  // look for “dwell X min/sec” or “contact time X”
  const sec = parseSeconds(s);
  const min = parseMinutes(s);
  if (sec) return sec;
  if (min) return min * 60;
  const m = s.match(/(contact|dwell)\s*time\s*:?[\s\-]*(\d{1,3})\s*(min|mins|minutes|m|sec|secs|seconds|s)/i);
  if (m) {
    const n = Number(m[2]);
    return /sec|s/i.test(m[3]) ? n : n * 60;
  }
  return null;
}

function parseHazards(chunks) {
  const text = (chunks || []).join(" ");
  const list = [];
  HAZARDS.forEach((h) => {
    const re = h.re || h[1];
    if (re.test(text)) list.push({ code: h.code || h[0], description: labelize(h.code || h[0]), severity: h.severity || "info", controls: h.controls || [] });
  });
  // generic “PPE required” if PPE exists
  if (parsePPE(chunks).length && !list.some((x) => x.code === "ppe-required")) {
    list.push({ code: "ppe-required", description: "PPE required", severity: "info", controls: ["follow PPE list"] });
  }
  return dedupeBy(list, (x) => x.code);
}

function parseList(chunks) {
  const out = [];
  (chunks || []).forEach((ln) => {
    if (isBullet(ln)) out.push(stripBullet(ln));
    else if (/;|,/.test(ln) && !/\.\s*$/.test(ln)) ln.split(/[,;]+/).forEach((p) => out.push(p.trim()));
    else if (/\s[-–]\s/.test(ln)) out.push(ln.split(/\s[-–]\s/)[0].trim());
    else if (ln.length <= 160) out.push(ln);
  });
  return out.filter(Boolean);
}

function labelize(code) {
  return String(code || "Item").replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function roleFromLine(line) {
  if (/supervisor|lead/i.test(line)) return "lead";
  if (/inspector|quality/i.test(line)) return "quality";
  if (/assistant|runner/i.test(line)) return "assistant";
  return "cleaner";
}

function surfaceFromLine(line) {
  for (const s of SURFACE_HINTS) if (new RegExp(`\\b${s}\\b`, "i").test(line)) return s;
  if (/high[- ]?touch|handle|switch/i.test(line)) return "high-touch";
  return undefined;
}

function productFromLine(line, chemicals) {
  const low = L(line);
  for (const c of chemicals || []) {
    const n = L(c.name);
    if (!n) continue;
    if (low.includes(n)) return c.name;
  }
  // generic: glass cleaner, bleach, quat etc.
  for (const [label] of CHEM_HINTS) if (low.includes(label)) return label;
  if (/glass/i.test(low)) return "glass-cleaner";
  return undefined;
}

function normalizeStep(text, idx, chemicals = []) {
  const durMin = parseMinutes(text);
  const dwellSec = parseDwell(text);
  const product = productFromLine(text, chemicals);
  const dilution = parseDilution(text);
  const step = {
    id: stableHash({ text, idx }),
    order: idx + 1,
    text: text.replace(/^\d+[\.\)]\s*/, "").trim(),
    role: roleFromLine(text),
    surface: surfaceFromLine(text),
    product: product || undefined,
    dilution: dilution || undefined,
    dwellSec: dwellSec || undefined,
    timer: dwellSec ? { durationSec: dwellSec } : undefined,
    check: /check|verify|confirm|inspect|ensure/i.test(text) || undefined,
    record: /record|log|document/i.test(text) ? "cleaning log" : undefined,
    durationMin: durMin || undefined,
  };
  return step;
}

function parseSteps(chunks, chemicals) {
  const out = [];
  const flat = (chunks || []).slice();

  const candidates = [];
  for (const ln of flat) {
    if (isBullet(ln)) candidates.push(stripBullet(ln));
    else if (/^\d+[\.\)]\s+/.test(ln)) candidates.push(ln.replace(/^\d+[\.\)]\s+/, ""));
    else if (/^(dust|wipe|spray|apply|rinse|mop|vacuum|disinfect|sanitize|change|empty|replace|inspect|check|post|set|place)\b/i.test(ln) && ln.length < 240) {
      candidates.push(ln);
    }
  }
  if (!candidates.length) {
    flat.forEach((ln) => {
      if (/\.\s+/.test(ln)) ln.split(/\.\s+/).forEach((s) => s && candidates.push(s));
    });
  }
  candidates.forEach((t, i) => out.push(normalizeStep(t, i, chemicals)));
  return out;
}

function parseFrequency(chunks) {
  const txt = (chunks || []).join(" ").toLowerCase();
  if (/\bdaily|every day\b/.test(txt)) return "daily";
  if (/\bweekly|every week\b/.test(txt)) return "weekly";
  if (/\bbi-?weekly|every 2 weeks\b/.test(txt)) return "biweekly";
  if (/\bmonthly|every month\b/.test(txt)) return "monthly";
  if (/as needed|prn/i.test(txt)) return "as-needed";
  const m = txt.match(/every\s+(\d{1,2})\s*(day|days|week|weeks|month|months)/i);
  if (m) return m[2].startsWith("day") ? `every-${m[1]}d` : m[2].startsWith("week") ? `every-${m[1]}w` : `every-${m[1]}mo`;
  return null;
}

function parseRecords(chunks) {
  const arr = parseList(chunks);
  return arr.map((r) => (typeof r === "string" ? { name: r } : r));
}

function parseSignoff(chunks) {
  const txt = (chunks || []).join(" ").toLowerCase();
  const required = /sign[- ]?off|required|approval/i.test(txt);
  let role = "lead";
  if (/supervisor|lead/i.test(txt)) role = "lead";
  else if (/manager/i.test(txt)) role = "manager";
  else if (/inspector|quality/i.test(txt)) role = "quality";
  return required ? { required, role } : undefined;
}

/* --------------------------------- CSV / NDJSON -------------------------------- */
const isCSV = (s) => /[,;\t]/.test(s) && /\n/.test(s);
const isNDJSON = (s) => /^\s*{/.test((s || "").trim()) && (s || "").trim().split(/\r?\n/).length > 1;

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

/* ----------------------------------- Main ----------------------------------- */
/**
 * normalizeRoomProcedure(input, options?)
 * input:
 *  - { buffer, mimeType, filename }  // PDFs
 *  - { text }                        // raw text
 *  - string                          // text/JSON/CSV/NDJSON
 *  - Array<object>                   // already JSON
 * options:
 *  - pdfTextExtractor?: async (buffer) => string
 *  - sourceMeta?: object
 */
async function normalizeRoomProcedure(input, options = {}) {
  let source = { type: "unknown", ref: null, ...(options.sourceMeta || {}) };
  let sections = null;

  // A) PDF buffer
  if (input && (input.buffer || input instanceof Uint8Array || input instanceof ArrayBuffer)) {
    const buffer = input.buffer || input;
    source = { ...source, type: "pdf", ref: input.filename || "upload.pdf" };
    const text = await extractTextFromPDF(buffer, options);
    if (text) sections = splitIntoSections(text);
  }

  // B) Plain string → JSON/NDJSON/CSV/Text
  if (!sections && (typeof input === "string" || input?.text)) {
    const raw = typeof input === "string" ? input : input.text;
    source = { ...source, type: source.type === "unknown" ? "text" : source.type, ref: source.ref };

    try {
      const obj = JSON.parse(raw);
      if (Array.isArray(obj)) return finalizeFromStructured({ steps: obj }, source);
      if (obj && typeof obj === "object") return finalizeFromStructured(obj, source);
    } catch (_) {
      if (isNDJSON(raw)) return finalizeFromStructured({ steps: parseNDJSON(raw) }, source);
      if (isCSV(raw)) return finalizeFromStructured({ steps: parseCSV(raw) }, source);
      sections = splitIntoSections(raw);
    }
  }

  // C) Already structured
  if (!sections && Array.isArray(input)) return finalizeFromStructured({ steps: input }, source);
  if (!sections && input && typeof input === "object" && (input.steps || input.title)) {
    return finalizeFromStructured(input, source);
  }

  // D) Fallback
  if (!sections) return null;

  const title = guessTitle(sections);
  const roomType = parseRoomType((sections.room || []).concat(sections.scope || [])) || undefined;
  const zones = parseZones((sections.zones || []).concat(sections.procedure || []));
  const surfaces = parseSurfaces((sections.surfaces || []).concat(sections.procedure || []));
  const ppe = parsePPE(sections.ppe || sections.safety || []);
  const colorCodes = parseColorCodes(sections.color || sections["color coding"] || []);
  const chemicals = parseChemicals((sections.chemicals || []).concat(sections.products || []));
  const hazards = parseHazards((sections.hazards || []).concat(sections.safety || []));
  const frequency = parseFrequency(sections.frequency || sections.scope || []);
  const preChecks = parseList(sections.preparation || sections["pre-checks"] || []);
  const postChecks = parseList(sections.post || sections.aftercare || sections["post-checks"] || []);
  const quality = parseList(sections.quality || sections.inspection || []);
  const waste = parseList(sections.waste || []);
  const signage = parseList(sections.signage || []);
  const records = parseRecords(sections.records || []);
  const signOff = parseSignoff(sections["sign-off"] || sections.approval || []);

  const tools = dedupeBy(
    parseList(sections.tools || sections.equipment || sections.products || [])
      .concat(guessToolsFromSteps(sections.procedure || [])),
    (x) => L(x)
  );

  const steps = parseSteps(sections.procedure || sections.steps || sections.body || [], chemicals);

  const base = {
    domain: "cleaning",
    title,
    roomType,
    zones,
    surfaces,
    ppe,
    colorCodes,
    chemicals,
    tools,
    hazards,
    preChecks: preChecks.map((t) => ({ id: stableHash({ t, k:"pre" }), text: t })),
    steps,
    postChecks: postChecks.map((t) => ({ id: stableHash({ t, k:"post" }), text: t })),
    quality: quality.map((t) => ({ id: stableHash({ t, k:"quality" }), text: t })),
    waste: waste.map((t) => ({ id: stableHash({ t, k:"waste" }), text: t })),
    signage: signage.map((t) => ({ id: stableHash({ t, k:"signage" }), text: t })),
    frequency: frequency || undefined,
    records,
    signOff,
    source,
  };

  const id = stableHash({ title, roomType: roomType || "any", n: steps.length, ppe: ppe.join("|") });
  return { id, ...base };
}

/* ------------------------------- Structured path ------------------------------- */
function finalizeFromStructured(obj, source) {
  const title = obj.title || "Room Cleaning Procedure";
  const chemicalsNorm = (obj.chemicals || []).map(cNorm);
  const steps = (obj.steps || []).map((s, i) => {
    if (typeof s === "string") return normalizeStep(s, i, chemicalsNorm);
    const base = normalizeStep(s.text || s.title || "", i, chemicalsNorm);
    return {
      ...base,
      role: s.role || base.role,
      surface: s.surface || base.surface,
      product: s.product || base.product,
      dilution: s.dilution || base.dilution,
      dwellSec: Number.isFinite(s.dwellSec) ? s.dwellSec : base.dwellSec,
      timer: s.timer || base.timer,
      check: s.check ?? base.check,
      record: s.record || base.record,
      durationMin: Number.isFinite(s.durationMin) ? s.durationMin : base.durationMin,
    };
  });

  const base = {
    domain: "cleaning",
    title,
    roomType: obj.roomType || undefined,
    zones: Array.isArray(obj.zones) ? obj.zones : [],
    surfaces: Array.isArray(obj.surfaces) ? obj.surfaces : [],
    ppe: Array.isArray(obj.ppe) ? obj.ppe : [],
    colorCodes: (obj.colorCodes || []).map(ccNorm),
    chemicals: chemicalsNorm,
    tools: Array.isArray(obj.tools) ? obj.tools : [],
    hazards: (obj.hazards || []).map(hNorm),
    preChecks: (obj.preChecks || []).map(tNorm("pre")),
    steps,
    postChecks: (obj.postChecks || []).map(tNorm("post")),
    quality: (obj.quality || []).map(tNorm("quality")),
    waste: (obj.waste || []).map(tNorm("waste")),
    signage: (obj.signage || []).map(tNorm("signage")),
    frequency: obj.frequency || undefined,
    records: (obj.records || []).map(rNorm),
    signOff: obj.signOff ? sNorm(obj.signOff) : undefined,
    source: { type: obj.source?.type || "json", ref: obj.source?.ref || null, ...source },
  };
  const id = obj.id || stableHash({ title, n: steps.length, room: base.roomType || "any" });
  return { id, ...base };
}

function cNorm(c) {
  if (typeof c === "string") return { name: c };
  return {
    name: c.name || c.product || "Cleaner",
    dilution: c.dilution || parseDilution(c.notes || "") || undefined,
    dwellSec: Number.isFinite(c.dwellSec) ? c.dwellSec : parseDwell(c.notes || "") || undefined,
    epaReg: c.epaReg || parseEPA(c.notes || "") || undefined,
    notes: c.notes || undefined,
  };
}
function ccNorm(x) {
  if (typeof x === "string") return { color: x, use: undefined };
  return { color: x.color || "color", use: x.use || undefined };
}
function hNorm(h) {
  if (typeof h === "string") return { code: h, description: labelize(h), severity: "info", controls: [] };
  return {
    code: h.code || (h.description ? h.description.toLowerCase().replace(/\s+/g,"-") : "hazard"),
    description: h.description || labelize(h.code || "Hazard"),
    severity: h.severity || "info",
    controls: Array.isArray(h.controls) ? h.controls : [],
  };
}
function rNorm(r) {
  if (typeof r === "string") return { name: r };
  return { name: r.name || r.title || "Record", retention: r.retention || undefined, where: r.where || r.location || undefined };
}
function sNorm(s) {
  return { required: !!(s.required ?? true), role: s.role || "lead" };
}
function tNorm(k) {
  return (t) => (typeof t === "string" ? { id: stableHash({ t, k }), text: t } : t);
}

/* ---------------------------------- Helpers ---------------------------------- */
function dedupeBy(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const it of arr || []) { const k = keyFn(it); if (seen.has(k)) continue; seen.add(k); out.push(it); }
  return out;
}

function guessToolsFromSteps(chunks) {
  const text = (chunks || []).join(" ").toLowerCase();
  const tools = [];
  if (/mop|bucket/.test(text)) tools.push("mop & bucket");
  if (/vacuum|hoover/.test(text)) tools.push("vacuum");
  if (/microfiber|cloth/.test(text)) tools.push("microfiber cloth");
  if (/squeegee/.test(text)) tools.push("squeegee");
  if (/duster|extendable/.test(text)) tools.push("duster");
  if (/scraper|razor/.test(text)) tools.push("scraper");
  if (/brush|grout/.test(text)) tools.push("brush");
  if (/sign|wet floor/.test(text)) tools.push("caution sign");
  return tools;
}

/* ---------------------------------- Export ---------------------------------- */
module.exports = {
  normalizeRoomProcedure,
  // internals for tests / tuning
  __internal: {
    extractTextFromPDF,
    splitIntoSections,
    parseRoomType,
    parseZones,
    parseSurfaces,
    parsePPE,
    parseColorCodes,
    parseChemicals,
    parseDilution,
    parseEPA,
    parseDwell,
    parseHazards,
    parseList,
    parseSteps,
    parseFrequency,
    normalizeStep,
  },
};

/* ----------------------------------- Usage -----------------------------------
import { normalizeRoomProcedure } from "@/utils/roomProcedureNormalizer";

// A) From PDF buffer
const sop = await normalizeRoomProcedure({ buffer: pdfBytes, filename: "bathroom-sop.pdf" });

// B) Raw text
const sop2 = await normalizeRoomProcedure(`
TITLE: Bathroom Cleaning SOP
Room: Bathroom
PPE: gloves, goggles
Color coding: red cloth for toilet, yellow for restroom general, blue for glass
Chemicals:
- Quat disinfectant 1:256 (dwell 10 min) EPA Reg No. 12345-67
- Glass cleaner (ammonia-free)
Preparation:
- Display wet floor sign
- Remove trash liner; replace after
Procedure:
1. High dust from top to bottom
2. Spray quat on high-touch points; allow 10 min dwell
3. Clean mirrors with blue cloth and glass cleaner
4. Clean sink & faucet; wipe dry
5. Toilet: apply quat inside/outside; brush bowl; dwell 10 min
6. Mop floor from clean to dirty; exit room
Quality:
- No residue on glass; faucet streak-free; floor dry
Waste:
- Tie liner; dispose
Signage:
- Remove wet floor sign when dry
Frequency: daily
Sign-off: Supervisor required
`);

// C) Structured JSON
const sop3 = await normalizeRoomProcedure({
  title: "Kitchen - Nightly Clean",
  roomType: "kitchen",
  ppe: ["gloves","apron"],
  chemicals: [{ name:"Quat", dilution:"1:256", dwellSec:600, epaReg:"12345-67" }],
  steps: [
    "Clear and sanitize prep counters (dwell 10 min)",
    { text:"Mop floor with neutral cleaner (15 min)", product:"neutral-cleaner", dilution:"1:128" },
  ],
  quality:["Counters dry","No streaks on stainless"],
  frequency:"daily"
});

// → returns a single normalized procedure object your UI can render into steps, timers, and safety checks
------------------------------------------------------------------------------- */
