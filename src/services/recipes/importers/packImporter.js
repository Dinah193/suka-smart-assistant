// src/services/recipes/importers/packImporter.js
//
// Import a recipe "pack" (collection) into a normalized structure your app can use.
// Optional: applyRhythm -> attach meta.preferredDays based on the pack's flavor(s)
// by intersecting with Vision.weeklyFlavorRhythm. Non-breaking if absent.
//
// Example:
//   import { importRecipePack } from "./packImporter";
//   const { pack: normalizedPack, recipes } = importRecipePack(rawPack, {
//     vision,               // { weeklyFlavorRhythm, ... } (optional but needed for applyRhythm)
//     applyRhythm: true,    // default false
//   });

/* -------------------------------- Calendars -------------------------------- */
const CAL_GREG = "gregorian";
const CAL_HEB = "hebrew";
const CAL_CRE = "creation";

const GREG_KEYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const HEB_KEYS  = ["yom_rishon","yom_sheni","yom_shelishi","yom_revi_i","yom_chamishi","yom_shishi","shabbat"];
const CRE_KEYS  = ["day_one","day_two","day_three","day_four","day_five","day_six","sabbath"];

const POS = {
  [CAL_GREG]: GREG_KEYS, // Mon..Sun
  [CAL_HEB]:  HEB_KEYS,  // Sun..Sat
  [CAL_CRE]:  CRE_KEYS,  // Day One..Sabbath
};

function detectCalendar(map = {}) {
  const has = (ks) => ks.some((k) => Array.isArray(map?.[k]));
  if (has(HEB_KEYS)) return CAL_HEB;
  if (has(CRE_KEYS)) return CAL_CRE;
  return CAL_GREG;
}

function normalizeTo(calendar, src = {}) {
  const out = {};
  POS[calendar].forEach((k) => { out[k] = Array.isArray(src[k]) ? [...src[k]] : []; });
  return out;
}

function convertCalendar(srcMap = {}, srcCal, dstCal) {
  if (srcCal === dstCal) return normalizeTo(dstCal, srcMap);
  const out = {};
  const srcKeys = POS[srcCal];
  const dstKeys = POS[dstCal];
  for (let i = 0; i < 7; i++) {
    const sk = srcKeys[i];
    const dk = dstKeys[i];
    out[dk] = Array.isArray(srcMap[sk]) ? [...srcMap[sk]] : [];
  }
  return out;
}

/* ------------------------------ Flavor helpers ----------------------------- */
function toSetLower(arr) {
  const s = new Set();
  (arr || []).forEach((v) => {
    const t = String(v || "").trim().toLowerCase();
    if (t) s.add(t);
  });
  return s;
}

/** Accepts a pack or recipe-like object and extracts any flavor tags present. */
function extractFlavors(entity) {
  const out = new Set();

  // flavor_profile: string | string[]
  const fp = entity?.flavor_profile;
  if (typeof fp === "string" && fp.trim()) out.add(fp.trim());
  if (Array.isArray(fp)) fp.filter(Boolean).forEach((t) => out.add(String(t).trim()));

  // tags: ["flavor:Caribbean", ...]
  const tags = Array.isArray(entity?.tags) ? entity.tags : [];
  tags.forEach((t) => {
    const m = String(t).match(/^flavor\s*:\s*(.+)$/i);
    if (m && m[1]) out.add(m[1].trim());
  });

  return Array.from(out);
}

/** Build rhythm maps (Mon..Sun) and a set of all flavors present across the week. */
function computeRhythm(vision = {}) {
  const r = vision?.weeklyFlavorRhythm || {};
  const srcCal = detectCalendar(r);
  const normSrc = normalizeTo(srcCal, r);
  const gregMap = srcCal === CAL_GREG ? normSrc : convertCalendar(normSrc, srcCal, CAL_GREG);
  const allFlavors = new Set();
  Object.values(gregMap).forEach((arr) => (arr || []).forEach((f) => {
    const t = String(f || "").trim();
    if (t) allFlavors.add(t);
  }));
  return { gregMap, weeklyFlavorSet: allFlavors };
}

/** Which Mon..Sun keys match any of the given flavors? */
function matchingDaysForFlavors(flavors = [], gregMap = {}) {
  if (!flavors.length) return [];
  const fset = toSetLower(flavors);
  const days = [];
  GREG_KEYS.forEach((dk) => {
    const dayFlavors = toSetLower(gregMap[dk] || []);
    // intersection?
    for (const f of fset) {
      if (dayFlavors.has(f)) { days.push(dk); break; }
    }
  });
  return days;
}

/* ---------------------------- Normalization helpers ------------------------ */
function shallowClone(o) {
  return o && typeof o === "object" ? { ...o } : o;
}

function normalizeRecipe(raw) {
  const r = shallowClone(raw) || {};
  const title = r.title || r.name || "Recipe";
  return {
    id: r.id || r.slug || `${title.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    description: r.description || r.summary || "",
    ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
    steps: Array.isArray(r.steps) ? r.steps : r.directions || [],
    tags: Array.isArray(r.tags) ? r.tags : [],
    flavor_profile: r.flavor_profile, // keep as-is; could be string or array
    images: Array.isArray(r.images) ? r.images : (r.image ? [r.image] : []),
    meta: { ...(r.meta || {}) },
    source: r.source || "pack",
  };
}

function normalizePack(rawPack) {
  const p = shallowClone(rawPack) || {};
  const title = p.title || p.name || "Recipe Pack";
  const items = Array.isArray(p.items) ? p.items : Array.isArray(p.recipes) ? p.recipes : [];
  return {
    id: p.id || p.slug || `${title.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 6)}`,
    title,
    description: p.description || p.summary || "",
    tags: Array.isArray(p.tags) ? p.tags : [],
    flavor_profile: p.flavor_profile, // string | string[]
    items,
    meta: { ...(p.meta || {}) },
    link: p.link,
  };
}

/* --------------------------------- Importer -------------------------------- */
/**
 * Import a recipe pack/collection.
 * @param {Object} rawPack
 * @param {Object} opts
 * @param {Object} [opts.vision]                 Vision options; uses weeklyFlavorRhythm
 * @param {boolean} [opts.applyRhythm=false]     If true, attach meta.preferredDays to each imported recipe based on the PACK's flavors
 * @returns {{ pack: Object, recipes: Array<Object> }}
 */
export function importRecipePack(rawPack, opts = {}) {
  const { vision = null, applyRhythm = false } = opts;

  const pack = normalizePack(rawPack);
  const packFlavors = extractFlavors(pack); // <- pack-level only (as requested)

  // Normalize recipes
  const recipes = (pack.items || []).map((it) => {
    const rec = normalizeRecipe(it);

    // Optionally attach preferredDays based on PACK flavor alignment with rhythm
    if (applyRhythm && vision && vision.weeklyFlavorRhythm) {
      const { gregMap } = computeRhythm(vision);
      const days = matchingDaysForFlavors(packFlavors, gregMap);
      if (days.length) {
        rec.meta = { ...(rec.meta || {}), preferredDays: days };
        // Also expose a human hint tag (non-blocking)
        const hintTag = `matches:${days.join("/")}`;
        const tags = Array.isArray(rec.tags) ? rec.tags.slice() : [];
        if (!tags.includes(hintTag)) tags.push(hintTag);
        rec.tags = tags;
      }
    }

    return rec;
  });

  // Keep the normalized pack, but do not duplicate heavy items array
  const packOut = { ...pack, items: recipes.map((r) => r.id) };

  return { pack: packOut, recipes };
}

/* ----------------------------- Default export ------------------------------ */
export default {
  importRecipePack,
};
