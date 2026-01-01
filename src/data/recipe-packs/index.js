// src/data/recipe-packs/index.js
// Dynamic recipe-pack registry + rhythm-aware recommendations.
// Works with Vite (import.meta.glob). No manual list needed.
// Now supports nested folders: ./*.json AND ./**/*.json

/* -------------------------------- Calendars -------------------------------- */
const CAL_GREG = "gregorian";
const CAL_HEB = "hebrew";
const CAL_CRE = "creation";

const GREG_KEYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const HEB_KEYS  = ["yom_rishon","yom_sheni","yom_shelishi","yom_revi_i","yom_chamishi","yom_shishi","shabbat"];
const CRE_KEYS  = ["day_one","day_two","day_three","day_four","day_five","day_six","sabbath"];
const POS = { [CAL_GREG]: GREG_KEYS, [CAL_HEB]: HEB_KEYS, [CAL_CRE]: CRE_KEYS };

const SHORT = { monday:"Mon", tuesday:"Tue", wednesday:"Wed", thursday:"Thu", friday:"Fri", saturday:"Sat", sunday:"Sun" };

/* ----------------------------- Rhythm utilities ---------------------------- */
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
function computeRhythmMaps(vision = {}) {
  const r = vision?.weeklyFlavorRhythm || {};
  const srcCal = detectCalendar(r);
  const norm = normalizeTo(srcCal, r);
  const greg = srcCal === CAL_GREG ? norm : convertCalendar(norm, srcCal, CAL_GREG);
  const weekSet = new Set();
  Object.values(greg).forEach((arr) => (arr || []).forEach((f) => {
    const t = String(f||"").trim();
    if (t) weekSet.add(t.toLowerCase());
  }));
  return { gregMap: greg, weekSet };
}

/* ------------------------------- Flavor helpers ---------------------------- */
function extractPackFlavors(entity) {
  const out = new Set();
  const fp = entity?.flavor_profile;
  if (typeof fp === "string" && fp.trim()) out.add(fp.trim());
  if (Array.isArray(fp)) fp.filter(Boolean).forEach((t) => out.add(String(t).trim()));
  const tags = Array.isArray(entity?.tags) ? entity.tags : [];
  tags.forEach((t) => {
    const m = String(t).match(/^flavor\s*:\s*(.+)$/i);
    if (m && m[1]) out.add(m[1].trim());
  });
  // pull nested item flavors (packs often define per-recipe flavors)
  const items = Array.isArray(entity?.items) ? entity.items : Array.isArray(entity?.recipes) ? entity.recipes : [];
  items.forEach((it) => extractPackFlavors(it).forEach((f) => out.add(f)));
  return Array.from(out);
}
function matchingDaysForPack(pack, gregMap) {
  const pf = new Set(extractPackFlavors(pack).map((s) => String(s).trim().toLowerCase()));
  const days = [];
  GREG_KEYS.forEach((dk) => {
    const dayFlavors = (gregMap[dk] || []).map((s) => String(s).trim().toLowerCase());
    if (dayFlavors.some((f) => pf.has(f))) days.push(dk);
  });
  return days;
}
function formatMatchesHint(days) {
  if (!days?.length) return "";
  const parts = days.map((k) => SHORT[k] || k);
  const cap = 3;
  return parts.length <= cap ? `Matches ${parts.join("/")}` : `Matches ${parts.slice(0, cap).join("/")} +${parts.length - cap}`;
}

/* ------------------------------ Vite pack glob ----------------------------- */
// Eager=false => lazy split chunks; default JSON parsing.
// Support root and nested subfolders (e.g., ./soul/*.json)
const PACK_MODULES = import.meta.glob("./*.json");
const PACK_MODULES_NESTED = import.meta.glob("./**/*.json");
const ALL_MODULES = { ...PACK_MODULES, ...PACK_MODULES_NESTED };

/* --------------------------------- Caching --------------------------------- */
const _packCache = new Map();      // id -> normalized pack object (raw or enriched)
const _manifestCache = new Map();  // file -> manifest (lightweight)
const _fileById = new Map();       // id -> file path for quick lookup

/* ------------------------------- Normalization ----------------------------- */
function fileKeyToId(fileName, json) {
  return json?.id || fileName.replace(/^\.\/|\.json$/g, "").replace(/^data\/recipe-packs\//, "");
}
function toManifest(fileName, json) {
  const id = fileKeyToId(fileName, json);
  const title = json?.title || id;
  const description = json?.description || "";
  const tags = Array.isArray(json?.tags) ? json.tags : [];
  const flavors = extractPackFlavors(json);
  const count = Array.isArray(json?.items) ? json.items.length : Array.isArray(json?.recipes) ? json.recipes.length : 0;
  return { id, file: fileName, title, description, tags, flavors, count };
}

/* ------------------------------ Internal utils ----------------------------- */
async function _loadJsonFromModule(loader) {
  const mod = await loader();
  return mod?.default || mod; // Vite parses JSON as default export
}
function _manifestFromCacheOr(json, file) {
  let m = _manifestCache.get(file);
  if (!m) {
    m = toManifest(file, json);
    _manifestCache.set(file, m);
    _fileById.set(m.id, file);
    if (json?.id) _packCache.set(json.id, json); // prime cache by id
  }
  return m;
}

/* --------------------------------- Public API ------------------------------ */
/**
 * Load a pack JSON by id (id is the pack's "id" or its filename w/o .json, nested ok).
 * Options:
 *  - vision?: Vision options (to compute rhythm hints)
 *  - applyRhythm?: boolean (default false) — if true, uses importer to attach meta.preferredDays
 */
export async function getPack(id, { vision = null, applyRhythm = false } = {}) {
  if (!id) throw new Error("getPack: id required");
  // Try cache by id
  if (_packCache.has(id)) return _packCache.get(id);

  const entries = Object.entries(ALL_MODULES);

  // Resolve by file key (filename or nested path sans .json)
  let modLoader = null, fileKey = null;
  for (const [file, loader] of entries) {
    const keyId = file.replace(/^\.\/|\.json$/g, "");
    if (keyId === id) { modLoader = loader; fileKey = file; break; }
  }

  let json;
  if (modLoader) {
    json = await _loadJsonFromModule(modLoader);
  } else {
    // scan for matching json.id
    for (const [file, loader] of entries) {
      const data = await _loadJsonFromModule(loader);
      const jid = fileKeyToId(file, data);
      if (jid === id) { json = data; fileKey = file; break; }
    }
  }
  if (!json) throw new Error(`Recipe pack not found: ${id}`);

  // Optionally enrich via importer (meta.preferredDays)
  let enriched = json;
  if (applyRhythm) {
    try {
      const importerMod = await import("@/services/recipes/importers/packImporter.js");
      const importer = importerMod?.default?.importRecipePack ? importerMod.default : importerMod;
      const importRecipePack = importer?.importRecipePack || importerMod?.importRecipePack;
      if (typeof importRecipePack === "function") {
        const res = importRecipePack(json, { vision, applyRhythm: true });
        // Keep raw json (for manifests) but expose enriched recipes + a normalized pack
        enriched = { ...json, items: res.recipes, _normalizedPack: res.pack, _raw: json };
      }
    } catch (e) {
      console.warn("[recipe-packs] applyRhythm failed; returning raw pack. Cause:", e);
    }
  }

  const cacheKey = json?.id || id;
  _packCache.set(cacheKey, enriched);
  if (fileKey) {
    _manifestFromCacheOr(json, fileKey); // ensures _fileById mapping
  }
  return enriched;
}

/**
 * Return lightweight manifests for all packs.
 * If `vision` provided, include rhythm `matchesHint` (e.g., “Matches Wed/Thu”) and mark rhythmActive.
 */
export async function listPacks({ vision = null } = {}) {
  const entries = Object.entries(ALL_MODULES);
  const { gregMap, weekSet } = vision ? computeRhythmMaps(vision) : { gregMap: null, weekSet: null };

  const out = [];
  for (const [file, loader] of entries) {
    const json = await _loadJsonFromModule(loader);
    const manifest = _manifestFromCacheOr(json, file);

    let matchesHint = "";
    if (gregMap && manifest.flavors?.length) {
      const days = matchingDaysForPack(json, gregMap); // pack-level data is most reliable
      matchesHint = formatMatchesHint(days);
    }

    out.push({ ...manifest, matchesHint, rhythmActive: Boolean(weekSet && weekSet.size) });
  }
  // Title asc default
  return out.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
}

/**
 * Recommend packs — rhythm-aware (boost packs whose flavors appear anywhere in weeklyFlavorRhythm),
 * with simple text matching and optional popularity/rating fields on packs.
 */
export async function recommendPacks({ vision = null, query = "", limit = 12 } = {}) {
  const manifests = await listPacks({ vision });
  const lc = (s) => String(s || "").toLowerCase();
  const q = lc(query);

  const { weekSet } = vision ? computeRhythmMaps(vision) : { weekSet: new Set() };

  const scored = manifests.map((m) => {
    // rhythm score: intersection between pack flavors and weekly set
    const flavors = (m.flavors || []).map((f) => lc(f));
    const rhythmHits = flavors.filter((f) => weekSet.has(f));
    const rhythmScore = rhythmHits.length ? 3 + Math.min(2, rhythmHits.length - 1) : 0; // 3..5

    // text relevance
    const hay = lc(`${m.title} ${m.description} ${(m.tags || []).join(" ")}`);
    const textScore = q ? (hay.includes(q) ? 2 : 0) : 0;

    // popularity (optional future field)
    const pop = Number(m.popularity || m.rating || 0);
    const popScore = isFinite(pop) ? Math.min(2, pop / 2.5) : 0;

    return { ...m, _score: rhythmScore + textScore + popScore };
  });

  scored.sort((a, b) => b._score - a._score || (a.title || "").localeCompare(b.title || ""));
  return scored.slice(0, limit).map(({ _score, ...m }) => m);
}

/**
 * Convenience: preload all packs into the cache (use sparingly).
 * Great for offline/first-run warmup or static export flows.
 */
export async function preloadAll({ vision = null, applyRhythm = false } = {}) {
  const manifests = await listPacks({ vision });
  for (const m of manifests) {
    try { await getPack(m.id, { vision, applyRhythm }); } catch { /* ignore */ }
  }
}

/* ------------------------------- Extra helpers ----------------------------- */
/** Fast lookup if you only need a single manifest by id (no JSON load). */
export async function getManifestById(id) {
  // Ensure manifests are warmed
  if (!_fileById.has(id)) await listPacks();
  const file = _fileById.get(id);
  if (!file) return null;
  return _manifestCache.get(file) || null;
}
/** Clear in-memory caches (useful in dev hot-reloads or tests). */
export function clearPackCaches() {
  _packCache.clear();
  _manifestCache.clear();
  _fileById.clear();
}

/* ---------------------------------- Default -------------------------------- */
export default {
  getPack,
  listPacks,
  recommendPacks,
  preloadAll,
  getManifestById,
  clearPackCaches,

  // Expose a few helpers for other modules/components
  computeRhythmMaps,
  matchingDaysForPack,
  extractPackFlavors,
  formatMatchesHint,
};
