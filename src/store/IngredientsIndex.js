// C:\Users\larho\suka-smart-assistant\src\store\IngredientsIndex.js
/**
 * IngredientsIndex (dynamic, resilient, household-aware)
 * ------------------------------------------------------
 * A lightweight knowledge index for culinary ingredients that:
 *  - Normalizes names → canonical keys (aliases, pluralization, forms)
 *  - Tracks categories, tags (e.g., "produce", "dairy", "kosher"), allergens
 *  - Converts units via shared/units.js (best-effort)
 *  - Generates inventory reservation lines from recipe ingredients
 *  - Suggests substitutes using shared/rules.js (best-effort)
 *  - Learns from:
 *      • DexieDB supplies/pantry (keys, units)
 *      • Recent recipes / consolidations
 *  - Fuzzy search for quick “did you mean?”
 *
 * The index lives in-memory with optional persistence to Dexie userMeta.
 *
 * Canonical entry shape:
 * {
 *   key: 'onion.yellow',                     // canonical key
 *   name: 'Yellow Onion',                    // friendly
 *   aliases: ['yellow onions','onions, yellow','onion (yellow)', 'onion'],
 *   baseUnit: 'g',                           // preferred base for conversion
 *   density: { gPerMl: 0.8 },                // optional for volume→mass
 *   perItemAvg: { g: 110 },                  // avg per piece for "1 onion"
 *   category: 'produce',
 *   forms: ['whole','chopped','sliced'],
 *   allergens: [],                           // e.g., ['dairy','gluten','nut','soy','egg','fish','shellfish','sesame']
 *   tags: ['vegetable', 'aromatic'],
 *   perishabilityDays: 30,                   // heuristic for planning
 * }
 */

import { v4 as uuidv4 } from "uuid";

/* ---------------------------------------------
   Dynamic imports (soft dependencies)
----------------------------------------------*/
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try {
      // @vite-ignore
      const mod = await import(p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}

async function DB() {
  return await safeImportMany(["@/db/index.js", "@/db", "../db", "../../db"]);
}
async function Units() {
  return await safeImportMany(["@/shared/units.js", "@/shared/units"]);
}
async function Rules() {
  return await safeImportMany(["@/shared/rules.js", "@/shared/rules"]);
}
async function Ontology() {
  return await safeImportMany(["@/shared/ontology.js", "@/shared/ontology"]);
}

function nowISO() { return new Date().toISOString(); }

/* ---------------------------------------------
   Local persistence (Dexie + localStorage)
----------------------------------------------*/
const LSK = "suka.ingredientsIndex.v2";
async function saveSnapshot(payload) {
  const db = await DB();
  try { await db?.userMeta?.put?.({ key: LSK, value: payload, updatedAt: nowISO() }); } catch {}
  try { localStorage.setItem(LSK, JSON.stringify(payload)); } catch {}
}
async function loadSnapshot() {
  const db = await DB();
  try {
    const doc = await db?.userMeta?.get?.({ key: LSK });
    if (doc?.value) return doc.value;
  } catch {}
  try {
    const raw = localStorage.getItem(LSK);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/* ---------------------------------------------
   Internal state
----------------------------------------------*/
const _byKey     = new Map();   // key -> entry
const _aliasIdx  = new Map();   // lower alias -> key
const _usage     = new Map();   // key -> { count, lastISO }
let _loadedOnce  = false;

/* ---------------------------------------------
   Seed data (minimal core so it works offline)
----------------------------------------------*/
const CORE = [
  {
    key: "salt.kosher",
    name: "Kosher Salt",
    aliases: ["salt", "kosher salt", "salt (kosher)"],
    baseUnit: "g",
    density: { gPerMl: 1.2 },
    category: "pantry",
    forms: ["fine", "coarse"],
    allergens: [],
    tags: ["seasoning","parve","kosher"],
    perishabilityDays: 3650,
  },
  {
    key: "onion.yellow",
    name: "Yellow Onion",
    aliases: ["onion", "onions", "yellow onions", "onion (yellow)"],
    baseUnit: "g",
    perItemAvg: { g: 110 },
    category: "produce",
    forms: ["whole","diced","sliced"],
    allergens: [],
    tags: ["vegetable","aromatic"],
    perishabilityDays: 30,
  },
  {
    key: "garlic.clove",
    name: "Garlic Clove",
    aliases: ["garlic", "clove garlic", "garlic clove", "garlic cloves"],
    baseUnit: "g",
    perItemAvg: { g: 3 },
    category: "produce",
    forms: ["whole","minced"],
    allergens: [],
    tags: ["vegetable","aromatic"],
    perishabilityDays: 20,
  },
  {
    key: "flour.allpurpose",
    name: "All-Purpose Flour",
    aliases: ["ap flour", "flour", "all purpose flour", "a/p flour"],
    baseUnit: "g",
    density: { gPerMl: 0.53 }, // ~125g per cup
    category: "baking",
    forms: ["sifted","unsifted"],
    allergens: ["gluten"],
    tags: ["baking"],
    perishabilityDays: 365,
  },
  {
    key: "egg.chicken",
    name: "Egg (Chicken)",
    aliases: ["egg", "eggs", "chicken egg"],
    baseUnit: "count",
    perItemAvg: { g: 50 },
    category: "dairy", // dietary grouping; not actual dairy for kosher
    forms: ["whole","beaten"],
    allergens: ["egg"],
    tags: ["protein","parve"],
    perishabilityDays: 21,
  },
];

/* ---------------------------------------------
   Basic helpers
----------------------------------------------*/
function toKeyish(str = "") {
  return String(str).toLowerCase().trim().replace(/\s+/g, " ").replace(/[^\w\s.-]/g, "").replace(/\s/g, ".");
}
function ensureEntryShape(e) {
  const merged = {
    key: e.key,
    name: e.name || e.key,
    aliases: Array.from(new Set([...(e.aliases || []), e.name, e.key])).filter(Boolean),
    baseUnit: e.baseUnit || "g",
    density: e.density || null,
    perItemAvg: e.perItemAvg || null,
    category: e.category || "general",
    forms: e.forms || [],
    allergens: e.allergens || [],
    tags: e.tags || [],
    perishabilityDays: Number(e.perishabilityDays ?? 0) || 0,
    updatedAtISO: nowISO(),
  };
  return merged;
}
function indexEntry(entry) {
  _byKey.set(entry.key, entry);
  for (const a of entry.aliases || []) {
    _aliasIdx.set(String(a || "").toLowerCase(), entry.key);
  }
}

/* ---------------------------------------------
   Public API
----------------------------------------------*/
const IngredientsIndex = {
  /** Initialize the index; loads snapshot → Dexie → core seeds. */
  async init({ preloadDexie = true } = {}) {
    if (_loadedOnce) return true;

    // 1) snapshot
    try {
      const snap = await loadSnapshot();
      if (snap?.entries) {
        for (const e of snap.entries) indexEntry(ensureEntryShape(e));
      }
    } catch {}

    // 2) Dexie (supplies/pantry) to enrich keys/aliases
    if (preloadDexie) {
      try {
        const db = await DB();
        const supplies = (await db?.supplies?.toArray?.()) || [];
        const pantry = (await db?.pantry?.toArray?.()) || [];
        for (const s of [...supplies, ...pantry]) {
          const key = toKeyish(s.key || s.name);
          const entry = ensureEntryShape({
            key,
            name: s.name || key,
            aliases: [s.key, s.name, s.alias, ...(s.aliases || [])].filter(Boolean),
            baseUnit: s.unit || s.baseUnit || "g",
            tags: ["dexie"],
            category: s.category || "general",
          });
          if (!_byKey.has(entry.key)) indexEntry(entry);
        }
      } catch {}
    }

    // 3) core seeds last (don’t override Dexie/ snapshot specifics)
    for (const e of CORE) {
      if (!_byKey.has(e.key)) indexEntry(ensureEntryShape(e));
    }

    _loadedOnce = true;
    await this.persist();
    return true;
  },

  /** Persist index to storage. */
  async persist() {
    const entries = Array.from(_byKey.values());
    await saveSnapshot({ entries });
  },

  /** Resolve any user-facing name → canonical key. */
  resolveKey(name) {
    if (!name) return null;
    const raw = String(name).trim();
    const lower = raw.toLowerCase();
    if (_byKey.has(raw)) return raw;
    if (_aliasIdx.has(lower)) return _aliasIdx.get(lower);
    // tolerate plurals (very basic)
    if (lower.endsWith("es") && _aliasIdx.has(lower.slice(0, -2))) return _aliasIdx.get(lower.slice(0, -2));
    if (lower.endsWith("s") && _aliasIdx.has(lower.slice(0, -1))) return _aliasIdx.get(lower.slice(0, -1));
    // tolerate comma form: "onions, yellow" → "yellow onions"
    if (lower.includes(",")) {
      const flipped = lower.split(",").map(s => s.trim()).reverse().join(" ");
      if (_aliasIdx.has(flipped)) return _aliasIdx.get(flipped);
    }
    // fallback: keyish
    const k = toKeyish(raw);
    return _byKey.has(k) ? k : null;
  },

  /** Get entry or null. */
  get(keyOrName) {
    const key = _byKey.has(keyOrName) ? keyOrName : this.resolveKey(keyOrName);
    return key ? _byKey.get(key) || null : null;
  },

  /** Upsert a new entry + aliases. */
  async upsertEntry(entry) {
    if (!entry) return null;
    const key = toKeyish(entry.key || entry.name);
    if (!key) return null;
    const prev = _byKey.get(key) || {};
    const merged = ensureEntryShape({ ...prev, ...entry, key });
    indexEntry(merged);
    await this.persist();
    return merged;
  },

  /** Attach aliases to an existing key. */
  async upsertAliases(key, aliases = []) {
    const e = this.get(key);
    if (!e) return false;
    const nextAliases = Array.from(new Set([...(e.aliases || []), ...aliases])).filter(Boolean);
    const merged = { ...e, aliases: nextAliases, updatedAtISO: nowISO() };
    indexEntry(merged);
    await this.persist();
    return true;
  },

  /**
   * Normalize a loose ingredient line into:
   * { key, name, qty, unit, form?, note?, original?, source? }
   * Supports:
   *  - qty as number or string '1 1/2'
   *  - unit synonyms via shared/units.js
   *  - '1 onion' → convert to grams if perItemAvg is known (unit = 'g')
   */
  async normalize(ing = {}) {
    const UnitsMod = await Units();
    const qtyNum = parseQuantity(ing.qty ?? ing.quantity ?? ing.amount);
    const unitRaw = ing.unit || ing.u || null;
    const nameRaw = ing.key || ing.name || ing.item || "";
    const key = this.resolveKey(nameRaw) || toKeyish(nameRaw);
    const entry = this.get(key);

    // normalize unit
    const unit = UnitsMod?.normalizeUnit?.(unitRaw) || unitRaw;

    // piece→mass conversion if possible
    let qty = Number(qtyNum ?? 0) || 0;
    let outUnit = unit || (entry?.baseUnit || "g");

    if ((!unit || /count|pcs?|piece|clove|egg|whole|item/i.test(unit)) && entry?.perItemAvg?.g && (entry.baseUnit === "g")) {
      const count = qty || 1;
      qty = count * Number(entry.perItemAvg.g);
      outUnit = "g";
    }

    // if we have volume units and density for g/ml, convert to base
    if (UnitsMod && entry?.density?.gPerMl && unit && UnitsMod.isVolume?.(unit) && entry.baseUnit === "g") {
      const ml = UnitsMod.toMilliliters?.(qty, unit);
      if (ml != null) {
        qty = ml * Number(entry.density.gPerMl);
        outUnit = "g";
      }
    }

    // convert to entry.baseUnit where possible
    if (UnitsMod && unit && entry?.baseUnit && unit !== entry.baseUnit) {
      const converted = UnitsMod.convertSafe?.(qty, unit, entry.baseUnit);
      if (converted != null) {
        qty = converted;
        outUnit = entry.baseUnit;
      }
    }

    // usage tracking
    if (entry?.key) {
      const u = _usage.get(entry.key) || { count: 0, lastISO: null };
      u.count += 1; u.lastISO = nowISO();
      _usage.set(entry.key, u);
    }

    return {
      key: entry?.key || key,
      name: entry?.name || nameRaw,
      qty: roundSmart(qty),
      unit: outUnit || unit || entry?.baseUnit || null,
      form: ing.form || null,
      note: ing.note || null,
      original: { ...ing },
      source: ing.source || "unknown",
    };
  },

  /**
   * Make inventory reservation lines from a list of loose or normalized ingredients.
   * lines => [{ key, qty, unit, reason, meta }]
   */
  async toInventoryLines(ingredients = [], { scale = 1, reason = "recipes" } = {}) {
    const out = [];
    for (const ing of ingredients) {
      const norm = ing && ing.key ? ing : await this.normalize(ing);
      const q = Number(norm.qty || 0) * Number(scale || 1);
      if (!norm.key || !(q > 0)) continue;
      out.push({
        key: norm.key,
        qty: roundSmart(q),
        unit: norm.unit || "g",
        reason,
        meta: { form: norm.form || null, source: norm.source || "unknown" },
      });
    }
    return out;
  },

  /** Suggest simple substitutes using shared/rules if present; otherwise heuristic by category/tags */
  async suggestSubstitutes(keyOrName, { max = 5 } = {}) {
    const entry = this.get(keyOrName);
    if (!entry) return [];
    try {
      const rules = await Rules();
      if (rules?.substitutionsFor) {
        const subs = await rules.substitutionsFor(entry.key);
        return (subs || []).slice(0, max);
      }
    } catch {}
    // fallback: find neighbors in same category with overlapping tags
    const sameCat = Array.from(_byKey.values()).filter(e => e.category === entry.category && e.key !== entry.key);
    const scored = sameCat.map(e => [e, jaccard(entry.tags || [], e.tags || [])])
                          .filter(([,score]) => score > 0)
                          .sort((a,b) => b[1]-a[1])
                          .slice(0, max)
                          .map(([e]) => ({ key: e.key, name: e.name }));
    return scored;
  },

  /** Fuzzy find by name/alias; returns [{ key, name, score }] */
  search(query, { limit = 8 } = {}) {
    if (!query) return [];
    const q = String(query).toLowerCase().trim();
    const results = [];
    for (const e of _byKey.values()) {
      const hay = new Set([e.key, e.name, ...(e.aliases || [])].map(s => String(s).toLowerCase()));
      let best = 0;
      for (const h of hay) {
        const s = fuzzyScore(h, q);
        if (s > best) best = s;
      }
      if (best > 0.35) results.push({ key: e.key, name: e.name, score: best });
    }
    return results.sort((a,b) => b.score - a.score).slice(0, limit);
  },

  /** Learn aliases from recent recipes / consolidations. */
  async learnFromRecipes(recipes = []) {
    let learned = 0;
    for (const r of recipes || []) {
      for (const ing of r.ingredients || []) {
        const name = ing.key || ing.name || ing.item;
        if (!name) continue;
        const key = this.resolveKey(name) || toKeyish(name);
        const display = titleCase(String(name));
        if (!_byKey.has(key)) {
          indexEntry(ensureEntryShape({
            key,
            name: display,
            aliases: [name],
            baseUnit: ing.unit || "g",
            category: guessCategoryFromName(name),
            tags: ["learned"],
          }));
          learned++;
        } else {
          const e = _byKey.get(key);
          const alias = String(name).toLowerCase();
          if (alias && !e.aliases.map(a => a.toLowerCase()).includes(alias)) {
            e.aliases.push(name);
            indexEntry(e);
            learned++;
          }
        }
      }
    }
    if (learned) await this.persist();
    return learned;
  },

  /** Export light snapshot (for debugging or sync). */
  snapshot() {
    return {
      entries: Array.from(_byKey.values()),
      aliasCount: _aliasIdx.size,
      usage: Array.from(_usage.entries()),
      updatedAtISO: nowISO(),
    };
  },
};

/* ---------------------------------------------
   Utility functions (parsing, scoring, etc.)
----------------------------------------------*/
function parseQuantity(val) {
  if (val == null) return null;
  if (typeof val === "number") return val;
  const s = String(val).trim();
  if (!s) return null;

  // "1 1/2" or "1-1/2"
  const mix = s.match(/^(\d+)[-\s]+(\d+)\/(\d+)$/);
  if (mix) {
    const whole = Number(mix[1] || 0);
    const num = Number(mix[2] || 0);
    const den = Number(mix[3] || 1);
    return whole + (den ? num / den : 0);
  }
  // "3/4"
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    const num = Number(frac[1] || 0);
    const den = Number(frac[2] || 1);
    return den ? num / den : num;
  }
  // "1.25"
  const f = Number(s);
  return Number.isFinite(f) ? f : null;
}

function roundSmart(n) {
  if (!Number.isFinite(n)) return n;
  if (Math.abs(n) >= 10) return Math.round(n * 10) / 10;     // 1 decimal
  if (Math.abs(n) >= 1)  return Math.round(n * 100) / 100;   // 2 decimals
  return Math.round(n * 1000) / 1000;                        // 3 decimals
}

function jaccard(a = [], b = []) {
  const A = new Set(a.map(String));
  const B = new Set(b.map(String));
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter++;
  return inter / (A.size + B.size - inter);
}

function fuzzyScore(hay, needle) {
  if (hay === needle) return 1;
  if (hay.includes(needle)) return Math.min(0.95, needle.length / hay.length + 0.25);
  // cheap subsequence score
  let i = 0; let j = 0; let match = 0;
  while (i < hay.length && j < needle.length) {
    if (hay[i] === needle[j]) { match++; j++; }
    i++;
  }
  return Math.max(0, Math.min(0.8, match / Math.max(1, needle.length)));
}

function titleCase(s = "") {
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
}

function guessCategoryFromName(name = "") {
  const n = String(name).toLowerCase();
  if (/flour|sugar|yeast|baking|vanilla/.test(n)) return "baking";
  if (/milk|cheese|butter|yogurt/.test(n)) return "dairy";
  if (/chicken|beef|pork|lamb|turkey|fish|salmon|tuna/.test(n)) return "protein";
  if (/onion|garlic|pepper|tomato|carrot|lettuce|kale|cabbage|bean|potato|basil|cilantro/.test(n)) return "produce";
  if (/salt|peppercorn|cumin|paprika|oregano|turmeric|spice/.test(n)) return "seasoning";
  if (/rice|pasta|grain|quinoa|oats/.test(n)) return "grains";
  return "general";
}

/* ---------------------------------------------
   Auto-init (non-blocking)
----------------------------------------------*/
IngredientsIndex.init?.({ preloadDexie: true }).catch(() => {});

/* ---------------------------------------------
   Export
----------------------------------------------*/
export default IngredientsIndex;
