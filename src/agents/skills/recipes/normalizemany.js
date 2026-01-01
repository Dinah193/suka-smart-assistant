/**
 * src/agents/skills/recipes/normalizemany.js
 *
 * How this fits:
 * - Called by ImportRouter/Scan→Compare→Trust pipeline to normalize many recipes
 *   into a consistent contract that downstream cooking skills (composeSession,
 *   scaleAndYield, substitutions, cues) can consume.
 * - Returns { items:[{ ok, recipe, sessionSteps?, warnings, errors }], stats }
 * - Emits `import.parsed` (success) or `import.parse.failed` (error) per item.
 *
 * Inputs accepted per item (very forgiving):
 * {
 *   id?: string,
 *   url?: string,
 *   site?: string,                    // host hint; e.g., "allrecipes.com"
 *   title?: string,
 *   author?: string,
 *   description?: string,
 *   image?: string,
 *   yield?: string|number,            // "12 cookies" or 12
 *   totalTime?: string|number,        // "PT40M", "40 min", 2400
 *   prepTime?: string|number,
 *   cookTime?: string|number,
 *   ingredients?: Array<string|{text:string,qty?:number,unit?:string,name?:string,notes?:string}>,
 *   steps?: Array<string|{title?:string,desc?:string,durationSec?:number}>,
 *   nutrition?: Record<string,any>,
 *   equipment?: string[],
 *   meta?: Record<string,any>,
 *   raw?: any                         // site-specific raw JSON-LD or scraper blob
 * }
 *
 * Canonical recipe (output, subset):
 * {
 *   id, title, source:{ url, site, type:"recipe", refId? }, author, description, image,
 *   yield: { amount:number|null, unit:string|null, text?:string },
 *   time:  { totalSec:number|null, prepSec:number|null, cookSec:number|null },
 *   sections: [
 *     { title:"Main", ingredients:[{ name, qty, unit, original, notes, grams?:number, ml?:number, group?:string }] }
 *   ],
 *   steps: [{ id, title, desc, durationSec, equipment:[], metadata:{ tempTargetF?:number, donenessCue?:string, cueNotes?:string } }],
 *   equipment: string[],
 *   tags: string[],
 *   createdAt, updatedAt
 * }
 *
 * Extension points:
 * - registerSiteAdapter(host, fn)      // custom massage of raw inputs per site
 * - registerIngredientAlias(from,to)   // "bicarb" -> "baking soda"
 * - registerUnitAlias(from,to)         // "tsp." -> "tsp"
 * - registerUomConverter(unit, fn)     // custom unit→g/ml
 * - setDefaults({ inferDurations, enableSessionScaffold })
 *
 * Safety/quality:
 * - Defensive parsing (fractions, unicode, ranges "1–2", "1-2").
 * - ISO8601 duration (PTxxHxxMxxS) support.
 * - Detects °F/°C and bakes a tempTargetF in step metadata.
 * - Extracts timers from text (e.g., "bake 12–15 min" → durationSec≈13.5m).
 * - Soft-imports cues/substitutions/scaleAndYield; never hard-depends.
 * - Emits eventBus analytics (no-op if bus missing).
 */

import { emit } from "@/services/eventBus"; // safe optional; guarded below

/* ------------------------------- Defaults ---------------------------------- */

const DEFAULTS = {
  inferDurations: true,
  enableSessionScaffold: true,
  defaultStepDurationSec: 60, // when we have no better guess
};

export function setDefaults(partial = {}) {
  Object.assign(DEFAULTS, pickDefined(partial));
}

/* ------------------------------- Registries -------------------------------- */

const SITE_ADAPTERS = new Map(); // host -> (item) => item'

/** Register a site-specific pre-normalization adapter */
export function registerSiteAdapter(host, fn) {
  const key = (host || "").toLowerCase().trim();
  if (!key || typeof fn !== "function") return;
  SITE_ADAPTERS.set(key, fn);
}

const ING_ALIASES = new Map(); // "bicarb" -> "baking soda"
export function registerIngredientAlias(from, to) {
  const f = norm(from), t = cleanSpace(to);
  if (f && t) ING_ALIASES.set(f, t);
}

const UNIT_ALIASES = new Map(); // "tsp." -> "tsp"
export function registerUnitAlias(from, to) {
  const f = norm(from), t = norm(to);
  if (f && t) UNIT_ALIASES.set(f, t);
}

/** Unit converters (liquid density/solid grams). fn({qty, unit, name}) -> { grams?, ml? } */
const UOM_CONVERTERS = new Map();
export function registerUomConverter(unit, fn) {
  const key = norm(unit);
  if (key && typeof fn === "function") UOM_CONVERTERS.set(key, fn);
}

/* Built-in unit aliases */
registerUnitAlias("tsp.", "tsp");
registerUnitAlias("teaspoon", "tsp");
registerUnitAlias("teaspoons", "tsp");
registerUnitAlias("tbsp.", "tbsp");
registerUnitAlias("tablespoon", "tbsp");
registerUnitAlias("tablespoons", "tbsp");
registerUnitAlias("ounce", "oz");
registerUnitAlias("ounces", "oz");
registerUnitAlias("pound", "lb");
registerUnitAlias("pounds", "lb");
registerUnitAlias("grams", "g");
registerUnitAlias("milliliter", "ml");
registerUnitAlias("milliliters", "ml");
registerUnitAlias("liters", "l");

/* Minimal density heuristics by ingredient keyword (very rough; callers can override via registerUomConverter) */
registerUomConverter("cup", ({ name, qty }) => {
  const n = norm(name);
  const ml =
    n.includes("flour") ? 120 * qty :
    n.includes("sugar") && n.includes("brown") ? 220 * qty :
    n.includes("sugar") ? 200 * qty :
    n.includes("butter") ? 227 * qty :      // 1 cup ≈ 227 g butter
    240 * qty;                              // default liquid cup ml
  return n.includes("water") || n.includes("milk") || n.includes("broth")
    ? { ml }
    : { grams: ml }; // treat as g when not obviously liquid
});

registerUomConverter("tbsp", ({ qty }) => ({ ml: 15 * qty }));
registerUomConverter("tsp", ({ qty }) => ({ ml: 5 * qty }));
registerUomConverter("oz", ({ name, qty }) => {
  // if liquid-y, map to ml; else grams
  const n = norm(name);
  const mlLikely = /water|milk|oil|broth|stock|vinegar|sauce/.test(n);
  return mlLikely ? { ml: 29.5735 * qty } : { grams: 28.3495 * qty };
});
registerUomConverter("lb", ({ qty }) => ({ grams: 453.592 * qty }));
registerUomConverter("g", ({ qty }) => ({ grams: qty }));
registerUomConverter("kg", ({ qty }) => ({ grams: 1000 * qty }));
registerUomConverter("ml", ({ qty }) => ({ ml: qty }));
registerUomConverter("l", ({ qty }) => ({ ml: qty * 1000 }));

/* ------------------------------- Public API -------------------------------- */

/**
 * Normalize many recipe payloads into canonical recipes (+ optional session step scaffold)
 * @param {Array<any>} items
 * @param {{ inferDurations?:boolean, enableSessionScaffold?:boolean, nowIso?:string }} [options]
 * @returns {{
 *   items: Array<{ ok:boolean, id?:string, recipe?:any, sessionSteps?:any[], warnings:string[], errors:string[] }>,
 *   stats: { total:number, ok:number, failed:number }
 * }}
 */
export async function normalizeMany(items = [], options = {}) {
  const opts = { ...DEFAULTS, ...pickDefined(options) };
  const out = [];
  let ok = 0, failed = 0;

  // Optional helpers (soft imports to avoid hard coupling)
  const cues = await softImport("@/agents/skills/cooking/cues");                // { inferDonenessCue? }
  const scaleAndYield = await softImport("@/agents/skills/cooking/scaleAndYield"); // not required here
  const substitutions = await softImport("@/agents/skills/cooking/substitutions"); // local fallback table

  for (const raw of items) {
    const res = { ok: false, warnings: [], errors: [] };
    try {
      const primed = applySiteAdapter(raw);
      const canon = normalizeOne(primed, { inferDurations: opts.inferDurations });

      // Optional: attach default cues per step (probe temp/color/timer)
      if (opts.enableSessionScaffold && Array.isArray(canon.steps)) {
        const steps = canon.steps.map((s, idx) => {
          const step = { ...s };
          if (!step.metadata) step.metadata = {};
          // infer temperature cues from text if available
          const tempF = extractTempF(`${step.title || ""} ${step.desc || ""}`);
          if (Number.isFinite(tempF)) {
            step.metadata.tempTargetF = tempF;
            step.metadata.cueNotes = joinCue(step.metadata.cueNotes, `Target ~${Math.round(tempF)}°F`);
          }
          // infer generic doneness cue if missing
          if (!step.metadata.donenessCue && cues?.inferDonenessCue) {
            const guess = safeCall(cues.inferDonenessCue, step.desc || step.title || "");
            if (guess) step.metadata.donenessCue = guess;
          }
          // sanity duration
          if (!Number.isFinite(step.durationSec) || step.durationSec < 0) {
            step.durationSec = DEFAULTS.defaultStepDurationSec;
          }
          // blockers heuristics (equipment/inventory are checked by runner; we annotate)
          step.blockers = Array.from(new Set([...(step.blockers || []), "equipment"]));
          step.id = step.id || `step-${pad2(idx + 1)}`;
          return step;
        });
        canon.steps = steps;
      }

      // suggest substitutions list for inventory pane (non-binding)
      const subTips = [];
      if (Array.isArray(canon.sections?.[0]?.ingredients) && substitutions?.suggestSubstitutions) {
        for (const ing of canon.sections[0].ingredients) {
          const sug = safeCall(substitutions.suggestSubstitutions, ing.name);
          if (Array.isArray(sug) && sug.length) subTips.push({ for: ing.name, options: sug.slice(0, 3) });
        }
      }
      if (subTips.length) {
        canon.meta = canon.meta || {};
        canon.meta.substitutionTips = subTips;
      }

      res.ok = true;
      res.id = canon.id;
      res.recipe = canon;

      // Emit success event
      try {
        emit?.({
          type: "import.parsed",
          ts: new Date().toISOString(),
          source: "recipes.normalizemany",
          data: { id: canon.id, site: canon?.source?.site || null, title: canon.title, ok: true },
        });
      } catch {}

      ok++;
    } catch (err) {
      failed++;
      const id = raw?.id || raw?.url || `unknown-${failed}`;
      res.errors.push(err?.message || "Unknown normalization error");
      // Emit failure event
      try {
        emit?.({
          type: "import.parse.failed",
          ts: new Date().toISOString(),
          source: "recipes.normalizemany",
          data: { id, site: raw?.site || null, title: raw?.title || null, ok: false, reason: String(res.errors[0]) },
        });
      } catch {}
    }
    out.push(res);
  }

  return {
    items: out,
    stats: { total: items.length, ok, failed },
  };
}

/**
 * Normalize a single recipe payload
 * @param {any} item
 * @param {{ inferDurations?:boolean }} [options]
 */
export function normalizeOne(item, options = {}) {
  const inferTime = !!options.inferDurations;
  if (!item || typeof item !== "object") throw new Error("Invalid recipe payload");

  const nowIso = new Date().toISOString();
  const id = String(item.id || item.url || randomId());

  const title = cleanTitle(item.title || item.name || "Untitled Recipe");
  const site = (item.site || hostFromUrl(item.url)).toLowerCase() || null;
  const author = cleanSpace(item.author || (item.raw?.author && (item.raw.author.name || item.raw.author)) || "");
  const image = item.image || firstImage(item.raw) || null;
  const description = cleanSpace(item.description || item.raw?.description || "");

  const yieldObj = parseYield(item.yield);
  const time = {
    totalSec: parseDuration(item.totalTime),
    prepSec: parseDuration(item.prepTime),
    cookSec: parseDuration(item.cookTime),
  };

  // Ingredients
  const ingLines = []
    .concat(item.ingredients || [])
    .concat(extractLDIngredients(item.raw))
    .filter(Boolean);

  const ingredients = ingLines.map((row) => normalizeIngredientRow(row));

  // Steps
  const rawSteps = []
    .concat(item.steps || [])
    .concat(extractLDSteps(item.raw))
    .filter(Boolean);

  let steps = rawSteps.map((raw, idx) => normalizeStep(raw, idx, { inferTime }));

  // Equipment/tags
  const equipment = dedupeStrings([...(item.equipment || []), ...inferEquipment(steps)]);
  const tags = dedupeStrings(toArray(item.tags || item.keywords));

  // If no durations at all, amortize totalSec or apply defaults
  if (steps.length && steps.every((s) => !Number.isFinite(s.durationSec) || s.durationSec <= 0)) {
    const usableTotal = time.totalSec && time.totalSec > 0 ? time.totalSec : (time.cookSec || 0) + (time.prepSec || 0);
    if (usableTotal > 0) {
      const per = Math.max(DEFAULTS.defaultStepDurationSec, Math.floor(usableTotal / steps.length));
      steps = steps.map((s) => ({ ...s, durationSec: per }));
    } else if (inferTime) {
      steps = steps.map((s) => ({ ...s, durationSec: DEFAULTS.defaultStepDurationSec }));
    }
  }

  return {
    id,
    title,
    source: { type: "recipe", url: item.url || null, site, refId: item.id || null },
    author: author || null,
    description: description || null,
    image,
    yield: yieldObj,
    time,
    sections: [{ title: "Main", ingredients }],
    steps,
    equipment,
    tags,
    createdAt: nowIso,
    updatedAt: nowIso,
    meta: item.meta || {},
  };
}

/* ----------------------------- Site Adapters ------------------------------- */

function applySiteAdapter(item) {
  const host = (item?.site || hostFromUrl(item?.url) || "").toLowerCase().trim();
  const fn = host && SITE_ADAPTERS.get(host);
  if (!fn) return item;
  try {
    const patched = fn(item);
    return patched || item;
  } catch {
    return item;
  }
}

/* ---------------------------- Ingredient parsing --------------------------- */

function normalizeIngredientRow(row) {
  // Accepts string or structured
  const original = typeof row === "string" ? row : row?.text || "";
  const txt = cleanSpace(original || "");
  const parsed = parseIngredientString(txt);

  const nameRaw = cleanSpace(row?.name || parsed.name || txt);
  const name = ING_ALIASES.get(norm(nameRaw)) || nameRaw;

  const unit = normalizeUnit(row?.unit || parsed.unit);
  const qty = Number.isFinite(row?.qty) ? row.qty : parsed.qty;

  // unit conversion heuristics → grams/ml
  const vol = tryConvert(unit, qty, name);

  return {
    name,
    qty: Number.isFinite(qty) ? round(qty, 3) : null,
    unit: unit || null,
    original: original || (name ? `${qty || ""} ${unit || ""} ${name}`.trim() : null),
    notes: row?.notes || parsed.notes || null,
    grams: vol.grams || null,
    ml: vol.ml || null,
    group: row?.group || null,
  };
}

function parseIngredientString(s) {
  // Examples:
  // "1 1/2 cups all-purpose flour"
  // "2–3 tbsp olive oil"
  // "¼ tsp kosher salt"
  // "3 large eggs"
  const out = { qty: null, unit: null, name: "", notes: "" };
  const t = normalizeFractions(s).replace(/\s+/g, " ").trim();

  // Extract qty (supports ranges; use average)
  const qtyMatch = t.match(/^([0-9]+(?:\s+[0-9\/¼½¾⅓⅔⅛⅜⅝⅞])?|[0-9]*\s*[¼½¾⅓⅔⅛⅜⅝⅞]|[0-9]+(?:\.[0-9]+)?)(?:\s*[-–]\s*([0-9]+(?:\.[0-9]+)?))?\b/);
  let qty = null;
  let rest = t;
  if (qtyMatch) {
    const a = toNumber(qtyMatch[1]);
    const b = toNumber(qtyMatch[2]);
    qty = b ? (a + b) / 2 : a;
    rest = t.slice(qtyMatch[0].length).trim();
  }

  // Unit next
  const unitMatch = rest.match(/^(cups?|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|lb|pounds?|g|grams?|kg|ml|milliliters?|l|liters?)\b\.?/i);
  let unit = unitMatch ? unitMatch[0] : null;
  if (unit) rest = rest.slice(unit.length).trim();

  // Anything in parentheses considered notes
  const notesMatch = rest.match(/\(([^)]+)\)/);
  const notes = notesMatch ? notesMatch[1].trim() : "";
  const name = cleanSpace(rest.replace(/\([^)]+\)/g, ""));

  return { qty, unit, name, notes };
}

function normalizeUnit(u) {
  if (!u) return null;
  const key = (u || "").toLowerCase().replace(/\.$/, "");
  return UNIT_ALIASES.get(key) || key;
}

function tryConvert(unit, qty, name) {
  if (!unit || !Number.isFinite(qty)) return { grams: null, ml: null };
  const fn = UOM_CONVERTERS.get(norm(unit));
  if (fn) {
    try {
      const res = fn({ qty, unit, name });
      return { grams: Number(res?.grams) || null, ml: Number(res?.ml) || null };
    } catch { /* ignore */ }
  }
  return { grams: null, ml: null };
}

/* ------------------------------- Step parsing ------------------------------ */

function normalizeStep(raw, idx, { inferTime }) {
  const title = typeof raw === "string" ? deriveStepTitle(raw) : raw?.title || deriveStepTitle(raw?.desc || "");
  const desc = typeof raw === "string" ? raw : raw?.desc || raw?.instruction || "";
  const dur = Number.isFinite(raw?.durationSec) ? raw.durationSec : (inferTime ? extractDurationSec(desc) : null);
  const tempF = extractTempF(`${title} ${desc}`);
  const meta = {};
  if (Number.isFinite(tempF)) meta.tempTargetF = tempF;

  return {
    id: raw?.id || `step-${pad2(idx + 1)}`,
    title: title || `Step ${idx + 1}`,
    desc: cleanSpace(desc),
    durationSec: Number.isFinite(dur) ? dur : null,
    equipment: [],
    metadata: meta,
  };
}

function deriveStepTitle(s) {
  const low = (s || "").toLowerCase();
  if (low.includes("preheat")) return "Preheat";
  if (low.includes("mix")) return "Mix";
  if (low.includes("whisk")) return "Whisk";
  if (low.includes("marinate")) return "Marinate";
  if (low.includes("rest")) return "Rest";
  if (low.includes("knead")) return "Knead";
  if (low.includes("bake")) return "Bake";
  if (low.includes("roast")) return "Roast";
  if (low.includes("simmer")) return "Simmer";
  if (low.includes("boil")) return "Boil";
  if (low.includes("sear")) return "Sear";
  if (low.includes("grill")) return "Grill";
  if (low.includes("fry")) return "Fry";
  return capitalize((s || "").split(".")[0].slice(0, 60)) || "Step";
}

/* --------------------------- Time/Temp extraction -------------------------- */

function parseDuration(v) {
  if (v == null) return null;
  if (typeof v === "number" && isFinite(v)) return Math.max(0, Math.round(v));

  // ISO8601 duration "PT1H20M15S"
  const iso = String(v).trim();
  if (/^P(T.*)$/i.test(iso)) {
    try {
      const m = iso.match(/P(T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/i);
      const h = parseInt(m?.[2] || "0", 10);
      const mi = parseInt(m?.[3] || "0", 10);
      const s = parseInt(m?.[4] || "0", 10);
      return h * 3600 + mi * 60 + s;
    } catch {}
  }

  // "1 hr 20 min", "40 minutes", "1h 10m", "1–2 hours"
  const t = normalizeFractions(iso.toLowerCase());
  const nums = t.match(/(\d+(?:\.\d+)?)/g);
  if (nums) {
    let sec = 0;
    if (t.includes("hour")) sec += (toNumber(nums[0]) || 0) * 3600, nums.shift();
    if (t.includes("min")) sec += (toNumber(nums[0]) || 0) * 60, nums.shift();
    if (t.includes("sec")) sec += (toNumber(nums[0]) || 0), nums.shift();
    if (sec > 0) return sec;
    // plain minutes fallback
    return Math.round((toNumber(nums[0]) || 0) * 60);
  }
  return null;
}

function extractDurationSec(s) {
  // Scan for "12–15 min", "10-12 minutes", "about 45 min", "2 hrs"
  const t = (s || "").toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/);
  if (!m) return null;
  const a = toNumber(m[1]);
  const b = toNumber(m[2]);
  const avg = b ? (a + b) / 2 : a;
  const unit = m[3][0];
  if (unit === "h") return Math.round(avg * 3600);
  if (unit === "m") return Math.round(avg * 60);
  if (unit === "s") return Math.round(avg);
  // words
  if (m[3].startsWith("h")) return Math.round(avg * 3600);
  if (m[3].startsWith("m")) return Math.round(avg * 60);
  return Math.round(avg * 60);
}

function extractTempF(s) {
  const t = (s || "").toLowerCase();
  // "350°F", "180 C", "190C", "Gas Mark 5" (ignore gas mark for now)
  const f = t.match(/(\d{2,3})\s*°?\s*f\b/);
  if (f) return clampInt(parseInt(f[1], 10), 90, 650);

  const c = t.match(/(\d{2,3})\s*°?\s*c\b/);
  if (c) {
    const cNum = clampInt(parseInt(c[1], 10), 30, 350);
    return Math.round(cNum * 9 / 5 + 32);
  }
  return null;
}

/* ----------------------------- Equipment guess ----------------------------- */

function inferEquipment(steps) {
  const found = new Set();
  for (const s of steps) {
    const t = `${s.title || ""} ${s.desc || ""}`.toLowerCase();
    if (/oven|preheat/.test(t)) found.add("oven");
    if (/skillet|pan|frypan|frying pan/.test(t)) found.add("skillet");
    if (/saucepan|pot|stockpot/.test(t)) found.add("saucepan");
    if (/mixer|stand mixer|hand mixer|whisk/.test(t)) found.add("mixer/whisk");
    if (/sheet pan|baking sheet|tray/.test(t)) found.add("sheet pan");
    if (/thermometer|probe/.test(t)) found.add("probe thermometer");
    if (/grill|griddle/.test(t)) found.add("grill");
    if (/instant pot|pressure cooker/.test(t)) found.add("pressure cooker");
  }
  return Array.from(found);
}

/* ------------------------------ JSON-LD helpers ---------------------------- */

function extractLDIngredients(raw) {
  // Pull from JSON-LD if present
  try {
    const ld = Array.isArray(raw) ? raw : [raw];
    for (const blob of ld) {
      const g = blob?.["@graph"] || (Array.isArray(blob) ? blob : null);
      const cand = g ? g.find((n) => (n?.["@type"] || n?.type) === "Recipe") : blob;
      const list = cand?.recipeIngredient || cand?.ingredients;
      if (Array.isArray(list)) return list;
    }
  } catch {}
  return [];
}

function extractLDSteps(raw) {
  try {
    const ld = Array.isArray(raw) ? raw : [raw];
    for (const blob of ld) {
      const g = blob?.["@graph"] || (Array.isArray(blob) ? blob : null);
      const cand = g ? g.find((n) => (n?.["@type"] || n?.type) === "Recipe") : blob;
      const inst = cand?.recipeInstructions;
      if (Array.isArray(inst)) {
        return inst.map((x) => (typeof x === "string" ? { desc: x } : { title: x?.name, desc: x?.text || x?.description || "" }));
      }
    }
  } catch {}
  return [];
}

function firstImage(raw) {
  try {
    const ld = Array.isArray(raw) ? raw : [raw];
    for (const blob of ld) {
      const g = blob?.["@graph"] || (Array.isArray(blob) ? blob : null);
      const cand = g ? g.find((n) => (n?.["@type"] || n?.type) === "Recipe") : blob;
      const img = cand?.image;
      if (typeof img === "string") return img;
      if (img?.url) return img.url;
      if (Array.isArray(img) && img.length) return img[0]?.url || img[0];
    }
  } catch {}
  return null;
}

/* --------------------------------- Utils ----------------------------------- */

function hostFromUrl(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

function randomId() { return Math.random().toString(36).slice(2, 10); }

function pickDefined(o) {
  const out = {};
  for (const k of Object.keys(o || {})) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function cleanSpace(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function cleanTitle(s) { return capitalize(cleanSpace(s)); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function norm(s) { return String(s || "").toLowerCase().trim(); }
function pad2(n) { return String(n).padStart(2, "0"); }
function dedupeStrings(arr) {
  const set = new Set();
  for (const a of arr || []) {
    const v = cleanSpace(String(a || ""));
    if (v) set.add(v);
  }
  return Array.from(set);
}

function toNumber(s) {
  if (!s) return NaN;
  const t = String(s).trim();
  if (/^\d+\s+\d+\/\d+$/.test(t)) {
    const [i, f] = t.split(/\s+/);
    const [n, d] = f.split("/").map(Number);
    return Number(i) + (n / d);
  }
  if (/^\d+\/\d+$/.test(t)) {
    const [n, d] = t.split("/").map(Number);
    return n / d;
  }
  return Number(t);
}

function normalizeFractions(s) {
  if (!s) return s;
  return String(s)
    .replace(/½/g, " 1/2")
    .replace(/¼/g, " 1/4")
    .replace(/¾/g, " 3/4")
    .replace(/⅓/g, " 1/3")
    .replace(/⅔/g, " 2/3")
    .replace(/⅛/g, " 1/8")
    .replace(/⅜/g, " 3/8")
    .replace(/⅝/g, " 5/8")
    .replace(/⅞/g, " 7/8")
    .replace(/[–—]/g, "-");
}

function parseYield(v) {
  if (v == null) return { amount: null, unit: null };
  if (typeof v === "number") return { amount: v, unit: "servings" };
  const s = String(v);
  const m = s.match(/(\d+(?:\.\d+)?)/);
  const amount = m ? toNumber(m[1]) : null;
  let unit = null;
  if (/serv/i.test(s)) unit = "servings";
  else if (/cookies|biscuits|pieces|pcs/i.test(s)) unit = "each";
  else if (/loaves|loaf/i.test(s)) unit = "loaf";
  return { amount, unit, text: s.trim() };
}

function joinCue(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  return `${prev} ${next}`.trim();
}

function clampInt(n, min, max) { const v = Math.round(Number(n) || 0); return Math.min(Math.max(v, min), max); }
function round(n, p = 2) { const f = Math.pow(10, p); return Math.round((Number(n) || 0) * f) / f; }

async function softImport(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.default || mod;
  } catch { return null; }
}

function safeCall(fn, ...args) {
  try { return fn?.(...args); } catch { return null; }
}

/* --------------------------------- Export ---------------------------------- */

export default {
  normalizeMany,
  normalizeOne,
  registerSiteAdapter,
  registerIngredientAlias,
  registerUnitAlias,
  registerUomConverter,
  setDefaults,
};
