// src/utils/barnProcedureNormalizer.js
/**
 * Barn Procedure (Animal Care) SOP → normalized structure
 *
 * Accepts:
 *  - Buffer/Uint8Array/ArrayBuffer (PDF)
 *  - string (raw text, JSON, CSV, NDJSON)
 *  - Array<object> (already structured items)
 *
 * Returns:
 * {
 *   id, domain:"animal-care", title, species[], scope?, frequency?,
 *   roles[], equipment[], ppe[], hazards:[{code, description, severity, controls[]}],
 *   preChecks:[{id,text}], steps:[{id,order,text,role?,durationMin?,requires?,produces?,check?,record?}],
 *   postChecks:[{id,text}], emergency:[{id,scenario,actions[]}],
 *   records?:[{name,retention?,where?}], signOff?:{required, role?}, source
 * }
 *
 * Design goals:
 *  - Works with/without PDF libs
 *  - Understand common SOP section headers
 *  - Extract actionable steps & safety quickly
 *  - Provide defaults + heuristics (roles, durations, hazards, PPE)
 *  - Dedupe & stable ids for planner/automation wiring
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

/* ------------------------------- Domain Lexicon ------------------------------- */
const SPECIES_MAP = {
  cattle: ["cow","cattle","calf","bovine"],
  goats: ["goat","kid","caprine"],
  sheep: ["sheep","lamb","ovine"],
  pigs: ["pig","swine","hog","porcine"],
  horses: ["horse","equine","foal","pony"],
  poultry: ["chicken","hen","rooster","poultry","turkey","duck","quail"],
  rabbits: ["rabbit","bunny","lagomorph"],
};

const ROLE_HINTS = [
  ["handler", /\b(handler|attendant|tech|tech-?assistant)\b/i],
  ["lead", /\b(lead|supervisor|manager|veterinarian|vet)\b/i],
  ["vet", /\b(vet|veterinarian)\b/i],
  ["safety", /\b(safety|biosecurity)\b/i],
];

const PPE_TERMS = [
  "gloves","nitrile","latex","mask","respirator","n95","face shield","goggles","apron","gown","coveralls","boots","boot covers","hearing protection","ear plugs","eye protection"
];

const EQUIP_HINTS = [
  "syringe","needle","thermometer","halter","lead rope","chute","scale","disinfectant","iodine","clippers","sharps container","hoof trimmer","bandage","twine","bucket","feeder","waterer","heat lamp","incubator"
];

const HAZARDS = [
  { code:"kick-bite", re:/kick|bite|butt|strike/i, severity:"warn", controls:["handler present","maintain safe distance","use restraint"] },
  { code:"zoonosis", re:/zoon(os|otic)|salmonella|campylobacter|ringworm|brucella|Q fever|influenza/i, severity:"warn", controls:["gloves","hand hygiene","eye protection"] },
  { code:"sharps", re:/needle|syringe|sharps?/i, severity:"warn", controls:["sharps container","no recap","gloves"] },
  { code:"chemical", re:/disinfectant|bleach|iodine|chemical|detergent/i, severity:"info", controls:["ventilation","gloves","eye protection"] },
  { code:"heat-stress", re:/heat lamp|heat stress|overheat/i, severity:"info", controls:["monitor temp","distance guard"] },
  { code:"crush", re:/chute|gate|crush|pinch/i, severity:"danger", controls:["lockout","two-person rule","clear path"] },
  { code:"biosecurity", re:/biosecurity|quarantine|footbath|boot covers/i, severity:"info", controls:["boot covers","disinfect footwear","animal isolation"] },
];

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
  // 2) pdfjs-dist (Node/browser)
  if (pdfjs?.getDocument) {
    try {
      const doc = await pdfjs.getDocument({ data: buffer }).promise;
      let text = "";
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        text += content.items.map((it) => (typeof it.str === "string" ? it.str : "")).join(" ") + "\n";
      }
      if (text.trim()) return text;
    } catch (_) {}
  }
  return null;
}

/* -------------------------------- Section split ------------------------------- */
/**
 * Detect common SOP section headers and bucket lines accordingly.
 * Recognizes: Title, Purpose, Scope, Species, Materials/Equipment, PPE, Safety, Preparation/Pre-checks,
 * Procedure/Steps, Post-care/Aftercare, Emergency, Records, Frequency, Sign-off/Approval
 */
function splitIntoSections(text) {
  const lines = linesOf(text);
  const sections = {};
  let current = "body";
  const push = (k, v) => {
    sections[k] = sections[k] || [];
    sections[k].push(v);
  };

  const headerRE = /^(purpose|scope|species|materials|equipment|ppe|personal protective equipment|safety|hazards|preparation|pre-checks?|procedure|steps?|post[- ]?(care|checks?)|aftercare|emergency|contingency|records?|documentation|frequency|sign[- ]?off|approval|title)\s*[:\-]?$/i;

  for (const raw of lines) {
    const l = raw.trim();
    // isolate header-only lines
    const hdr = l.match(headerRE);
    if (hdr) { current = hdr[1].toLowerCase(); sections[current] = sections[current] || []; continue; }

    // inline headers like "PPE: gloves, goggles"
    const colon = l.match(/^(purpose|scope|species|materials|equipment|ppe|safety|hazards|preparation|procedure|steps?|post[- ]?(care|checks?)|aftercare|emergency|records?|frequency|sign[- ]?off|approval)\s*:\s*(.+)$/i);
    if (colon) { current = colon[1].toLowerCase(); push(current, colon[2].trim()); continue; }

    push(current, l);
  }
  return sections;
}

/* ------------------------------- Parsers / heuristics ------------------------------- */
function parseSpecies(textChunks) {
  const src = (textChunks || []).join(" ");
  const low = L(src);
  const found = new Set();
  for (const [k, arr] of Object.entries(SPECIES_MAP)) {
    if (arr.some((w) => low.includes(w))) found.add(k);
  }
  return Array.from(found);
}

function parseList(chunks) {
  const out = [];
  (chunks || []).forEach((ln) => {
    if (isBullet(ln)) out.push(stripBullet(ln));
    else if (/;|,/.test(ln) && !/\.\s*$/.test(ln)) ln.split(/[,;]+/).forEach((p) => out.push(p.trim()));
    else if (/\s[-–]\s/.test(ln)) out.push(ln.split(/\s[-–]\s/)[0].trim());
    else if (ln.length <= 120) out.push(ln);
  });
  return out.filter(Boolean);
}

function parsePPE(chunks) {
  const txt = (chunks || []).join(" ").toLowerCase();
  const ppe = new Set();
  PPE_TERMS.forEach((p) => { if (txt.includes(p)) ppe.add(p); });
  return Array.from(ppe);
}

function parseEquipment(chunks) {
  const txt = (chunks || []).join(" ").toLowerCase();
  const out = new Set();
  EQUIP_HINTS.forEach((w) => { if (txt.includes(w)) out.add(w); });
  // capture “use X” patterns
  (chunks || []).forEach((ln) => {
    const m = ln.match(/use\s+([a-z0-9 \-\/]+?)(?:\s+to|\s*,|\s*\.|$)/i);
    if (m && m[1]) out.add(m[1].trim().toLowerCase());
  });
  return Array.from(out);
}

function parseHazards(chunks) {
  const text = (chunks || []).join(" ");
  const list = [];
  for (const h of HAZARDS) {
    if (h.re.test(text)) {
      list.push({ code: h.code, description: labelize(h.code), severity: h.severity, controls: h.controls.slice() });
    }
  }
  // catch-all hints
  if (/PPE|protective/i.test(text) && !list.some((x) => x.code === "biosecurity")) {
    list.push({ code: "ppe-required", description: "PPE required", severity: "info", controls: ["follow PPE list"] });
  }
  return dedupeBy(list, (x) => x.code);
}

function labelize(code) {
  return code.replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function parseChecks(chunks) {
  // returns array of strings
  return parseList(chunks);
}

function imperativeScore(line) {
  // prefer “Do/Check/Apply/Place/Restrain/Record/Disinfect” style
  return /^[A-Z]?[A-Z]?[a-z]+\b/.test(line) && /^[A-Za-z]/.test(line) && /^(apply|administer|check|record|place|restrain|clean|disinfect|inspect|prepare|mix|measure|weigh|move|load|unload|open|close|turn|monitor|attach|remove|sanitize|label|store|dispose)\b/i.test(line) ? 2 : 0;
}

function roleFromLine(line) {
  for (const [role, re] of ROLE_HINTS) {
    if (re.test(line)) return role;
  }
  if (/vet|rx|prescription/i.test(line)) return "vet";
  if (/two-?person|assist/i.test(line)) return "handler";
  return null;
}

function requiresFromLine(line) {
  const req = [];
  if (/disinfect|sanitize|clean/i.test(line)) req.push("sanitation");
  if (/restrain|halter|chute|lead rope/i.test(line)) req.push("restraint");
  if (/mix|measure|dose|ml|mg|cc/i.test(line)) req.push("dosage");
  if (/PPE|gloves|goggles|mask|boots|coveralls/i.test(line)) req.push("ppe");
  return req.length ? req : null;
}

function producesFromLine(line) {
  const out = [];
  if (/record|log|document/i.test(line)) out.push("record");
  if (/label|tag|mark/i.test(line)) out.push("label");
  if (/dispose|sharps|container/i.test(line)) out.push("waste");
  return out.length ? out : null;
}

function normalizeStep(text, idx) {
  const dur = parseMinutes(text);
  const role = roleFromLine(text);
  const step = {
    id: stableHash({ text, idx }),
    order: idx + 1,
    text: text.replace(/^\d+\.\s+/, "").trim(),
    role: role || undefined,
    durationMin: dur || undefined,
    requires: requiresFromLine(text) || undefined,
    produces: producesFromLine(text) || undefined,
    check: /check|verify|confirm/i.test(text) || undefined,
    record: /record|log|document/i.test(text) ? "logbook/ELR" : undefined,
  };
  return step;
}

function parseSteps(chunks) {
  const out = [];
  const flat = (chunks || []).slice();

  // gather numbered and bulleted lines first
  const candidates = [];
  for (const ln of flat) {
    if (isBullet(ln)) candidates.push(stripBullet(ln));
    else if (/^\d+\)/.test(ln)) candidates.push(ln.replace(/^\d+\)\s*/, ""));
    else if (/^\d+\.\s+/.test(ln)) candidates.push(ln.replace(/^\d+\.\s*/, ""));
    else if (imperativeScore(ln) > 0 && ln.length < 240) candidates.push(ln);
  }

  // fallback: split “Procedure:” paragraphs by ";", "." if needed
  if (!candidates.length) {
    flat.forEach((ln) => {
      if (/\.\s+/.test(ln)) ln.split(/\.\s+/).forEach((s) => s && candidates.push(s));
    });
  }

  candidates.forEach((t, i) => out.push(normalizeStep(t, i)));
  return out;
}

function guessTitle(sections) {
  const titleLines = (sections.title || []).concat((sections.body || []).slice(0, 2));
  const head = (titleLines.find((l) => /^[A-Z0-9].{4,}/.test(l)) || "Barn Procedure").trim();
  return head.replace(/^(title\s*:\s*)/i, "").trim();
}

function parseFrequency(chunks) {
  const txt = (chunks || []).join(" ").toLowerCase();
  if (/\bdaily|every day\b/.test(txt)) return "daily";
  if (/\bweekly|every week\b/.test(txt)) return "weekly";
  if (/\bmonthly|every month\b/.test(txt)) return "monthly";
  if (/as needed|prn|prn\./i.test(txt)) return "as-needed";
  const m = txt.match(/every\s+(\d{1,2})\s*(day|days|week|weeks|month|months)/i);
  if (m) return m[2].startsWith("day") ? `every-${m[1]}d` : m[2].startsWith("week") ? `every-${m[1]}w` : `every-${m[1]}mo`;
  return null;
}

function parseRoles(allChunks) {
  const text = (allChunks || []).join(" ");
  const roles = new Set();
  ROLE_HINTS.forEach(([r, re]) => { if (re.test(text)) roles.add(r); });
  if (/two-?person|assistant/i.test(text)) roles.add("handler");
  return Array.from(roles);
}

/* ------------------------------ CSV / NDJSON / JSON ------------------------------ */
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
 * normalizeBarnProcedure(input, options?)
 * input:
 *  - { buffer, mimeType, filename }  // for PDFs
 *  - { text }                        // raw text
 *  - string                          // text/JSON/CSV/NDJSON
 *  - Array<object>                   // already JSON
 * options:
 *  - pdfTextExtractor?: async (buffer) => string
 *  - sourceMeta?: object
 */
async function normalizeBarnProcedure(input, options = {}) {
  let source = { type: "unknown", ref: null, ...(options.sourceMeta || {}) };
  let sections = null;

  // A) PDF buffer
  if (input && (input.buffer || input instanceof Uint8Array || input instanceof ArrayBuffer)) {
    const buffer = input.buffer || input;
    source = { ...source, type: "pdf", ref: input.filename || "upload.pdf" };
    const text = await extractTextFromPDF(buffer, options);
    if (text) sections = splitIntoSections(text);
  }

  // B) Plain string
  if (!sections && (typeof input === "string" || input?.text)) {
    const raw = typeof input === "string" ? input : input.text;
    source = { ...source, type: source.type === "unknown" ? "text" : source.type, ref: source.ref };

    // Try JSON first
    try {
      const obj = JSON.parse(raw);
      if (Array.isArray(obj)) {
        // Array of step lines or structured items
        const steps = Array.isArray(obj) && typeof obj[0] === "string"
          ? obj.map((t) => ({ text: t }))
          : obj;
        return finalizeFromStructured({ steps }, source);
      } else if (obj && typeof obj === "object") {
        return finalizeFromStructured(obj, source);
      }
    } catch (_) {
      // NDJSON
      if (isNDJSON(raw)) {
        const arr = parseNDJSON(raw);
        return finalizeFromStructured({ steps: arr }, source);
      }
      // CSV
      if (isCSV(raw)) {
        const arr = parseCSV(raw);
        return finalizeFromStructured({ steps: arr }, source);
      }
      // Raw text → sections
      sections = splitIntoSections(raw);
    }
  }

  // C) Already structured array/object
  if (!sections && Array.isArray(input)) {
    return finalizeFromStructured({ steps: input }, source);
  }
  if (!sections && input && typeof input === "object" && (input.steps || input.title)) {
    return finalizeFromStructured(input, source);
  }

  // D) Fallback
  if (!sections) return null;

  // Build normalized object from sections
  const title = guessTitle(sections);
  const species = parseSpecies(sections.species || sections.scope || sections.body);
  const equipment = parseEquipment((sections.materials || []).concat(sections.equipment || []));
  const ppe = parsePPE(sections.ppe || sections.safety || []);
  const hazards = parseHazards((sections.hazards || []).concat(sections.safety || []));
  const frequency = parseFrequency(sections.frequency || sections.scope || []);
  const roles = parseRoles(Object.values(sections).flat());

  const preChecks = parseChecks(sections.preparation || sections["pre-checks"] || []);
  const postChecks = parseChecks(sections.post || sections.aftercare || sections["post care"] || sections["post-checks"] || []);
  const steps = parseSteps(sections.procedure || sections.steps || sections.body || []);
  const emergency = buildEmergency(sections.emergency || []);
  const records = parseRecords(sections.records || sections.documentation || sections["record keeping"] || []);
  const signOff = parseSignoff(sections["sign-off"] || sections.approval || []);

  const base = {
    domain: "animal-care",
    title,
    species,
    scope: (sections.scope || [])[0] || undefined,
    frequency: frequency || undefined,
    roles,
    equipment,
    ppe,
    hazards,
    preChecks: preChecks.map((t) => ({ id: stableHash({ t, k:"pre" }), text: t })),
    steps,
    postChecks: postChecks.map((t) => ({ id: stableHash({ t, k:"post" }), text: t })),
    emergency,
    records,
    signOff,
    source,
  };

  const id = stableHash({ title, species, steps: steps.length, ppe: ppe.join("|") });
  return { id, ...base };
}

/* ------------------------------- Structured path ------------------------------- */
function finalizeFromStructured(obj, source) {
  // obj may include title, species, ppe, hazards, steps (strings or objects)
  const title = obj.title || "Barn Procedure";
  const species = Array.isArray(obj.species) ? obj.species : parseSpecies([JSON.stringify(obj)]);
  const ppe = Array.isArray(obj.ppe) ? obj.ppe : [];
  const hazards = Array.isArray(obj.hazards) ? obj.hazards : [];
  const roles = Array.isArray(obj.roles) ? obj.roles : parseRoles([JSON.stringify(obj)]);

  let steps = [];
  if (Array.isArray(obj.steps)) {
    steps = obj.steps.map((s, i) => {
      if (typeof s === "string") return normalizeStep(s, i);
      const t = s.text || s.title || "";
      const merged = normalizeStep(t, i);
      return {
        ...merged,
        role: s.role || merged.role,
        durationMin: Number.isFinite(s.durationMin) ? s.durationMin : merged.durationMin,
        requires: s.requires || merged.requires,
        produces: s.produces || merged.produces,
        check: s.check ?? merged.check,
        record: s.record || merged.record,
      };
    });
  }

  const preChecks = (obj.preChecks || []).map((t) => typeof t === "string" ? { id: stableHash({ t, k:"pre" }), text: t } : t);
  const postChecks = (obj.postChecks || []).map((t) => typeof t === "string" ? { id: stableHash({ t, k:"post" }), text: t } : t);

  const base = {
    domain: "animal-care",
    title,
    species,
    scope: obj.scope || undefined,
    frequency: obj.frequency || undefined,
    roles,
    equipment: Array.isArray(obj.equipment) ? obj.equipment : [],
    ppe,
    hazards: hazards.map(hNorm),
    preChecks,
    steps,
    postChecks,
    emergency: (obj.emergency || []).map(eNorm),
    records: (obj.records || []).map(rNorm),
    signOff: obj.signOff ? sNorm(obj.signOff) : undefined,
    source: { type: obj.source?.type || "json", ref: obj.source?.ref || null, ...source },
  };
  const id = obj.id || stableHash({ title, species, n: steps.length, p: ppe.join("|") });
  return { id, ...base };
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
function eNorm(e) {
  if (typeof e === "string") return { id: stableHash({ e }), scenario: e, actions: [] };
  return { id: e.id || stableHash(e), scenario: e.scenario || e.title || "Emergency", actions: e.actions || [] };
}
function rNorm(r) {
  if (typeof r === "string") return { name: r };
  return { name: r.name || r.title || "Record", retention: r.retention || undefined, where: r.where || r.location || undefined };
}
function sNorm(s) {
  return { required: !!(s.required ?? true), role: s.role || "lead" };
}

/* --------------------------------- Emergency --------------------------------- */
function buildEmergency(chunks) {
  const list = [];
  const items = parseList(chunks);
  // group actions by scenario keyword
  items.forEach((t) => {
    let sc = "General";
    if (/bleeding|injur|fracture|wound/i.test(t)) sc = "Injury";
    if (/escape|loose animal|runaway/i.test(t)) sc = "Animal Escape";
    if (/fire|smoke|heat lamp/i.test(t)) sc = "Fire";
    if (/exposure|chemical|disinfectant|bleach/i.test(t)) sc = "Chemical Exposure";
    const id = stableHash({ sc, t });
    const hit = list.find((x) => x.scenario === sc);
    if (hit) hit.actions.push(t);
    else list.push({ id, scenario: sc, actions: [t] });
  });
  return list;
}

/* ---------------------------------- Helpers ---------------------------------- */
function dedupeBy(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const it of arr || []) { const k = keyFn(it); if (seen.has(k)) continue; seen.add(k); out.push(it); }
  return out;
}

/* ---------------------------------- Export ---------------------------------- */
module.exports = {
  normalizeBarnProcedure: normalizeBarnProcedure,
  // exposed internals for tests / tuning
  __internal: {
    extractTextFromPDF,
    splitIntoSections,
    parseSpecies,
    parseList,
    parsePPE,
    parseEquipment,
    parseHazards,
    parseChecks,
    parseSteps,
    parseFrequency,
    parseRoles,
    normalizeStep,
    buildEmergency,
  },
};

/* ----------------------------------- Notes -----------------------------------
Usage examples:

import { normalizeBarnProcedure } from "@/utils/barnProcedureNormalizer";

// A) PDF buffer (Node or browser ArrayBuffer/Uint8Array)
const proc = await normalizeBarnProcedure({ buffer: pdfBytes, filename: "calf-disbudding-sop.pdf" });

// B) Raw text
const proc2 = await normalizeBarnProcedure(`
TITLE: Calf Feeding SOP
Scope: Dairy calves < 60 days
Species: calf, bovine
PPE: gloves, boots, coveralls
Safety: Kick risk; Sharps container for needles; Biosecurity boot bath
Equipment: bottles, nipples, thermometer, scale
Preparation:
- Disinfect bottles and nipples
- Warm milk replacer to 38°C (10 min)
Procedure:
1. Restrain calf in pen with handler
2. Check ID tag; record weight
3. Prepare bottle; verify temperature (38°C)
4. Feed 2L slowly; monitor swallowing
5. Dispose needles in sharps container
Post-care:
- Clean feeding equipment
- Record intake and any issues
Emergency:
- Choking: remove bottle, clear airway, call lead
Records: feed log (retain 1 year)
Frequency: 2x daily
Sign-off: Lead required
`);

// C) JSON / steps array
const proc3 = await normalizeBarnProcedure(JSON.stringify([
  "Don gloves and boot covers",
  "Restrain goat in stanchion",
  "Trim overgrown hoof wall (15 min)",
  "Disinfect tools; record in log"
]));

// Returns a single normalized procedure object ready to be rendered or split
// into tasks (pre-checks → prep tasks, steps → actionable tasks, postChecks → cleanup).
------------------------------------------------------------------------------- */
