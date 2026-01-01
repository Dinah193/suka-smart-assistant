// src/managers/RecipeManager.js
/* eslint-disable no-console */

import DexieDB from "../db";
import Recipe from "../models/Recipe";
import parseRecipeSteps from "../services/planning/parseRecipeSteps";

/**
 * RecipeManager
 * -----------------------------------------------------------------------------
 * Backward compatible:
 *   - save(recipe, { overrides })
 *   - getById(id)
 *   - getAll()
 *   - delete(id)
 *
 * Enhancements:
 *   - save(recipe, { overrides, source, merge=true, strategy="smart" })
 *   - saveOrMerge(recipe, opts)  // alias that defaults to merge
 *   - mergeWithExisting(existing, incoming, { strategy })
 *   - upsertAttribution(id, attribution)
 *   - listAttributions(id)
 *   - getBySourceURL(url)
 *   - search(q, opts?), getByTag(tag), getByIngredient(name)
 *   - scaleRecipe(recipeOrId, factor)
 *   - planPrepTimeline(recipeOrId, { startISO? })
 *   - suggestSubstitutions(recipeOrId)
 *   - linkInventoryHints(recipeOrId)
 *   - toggleFavorite(id, flag?), rate(id, stars), recent(limit)
 *   - exportAll(), importMany(payload, { merge })
 */

const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString());
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* --------------------------------- Guards ---------------------------------- */

const safeArr = (v) => (Array.isArray(v) ? v : []);
const safeStr = (v) => (v == null ? "" : String(v));
const safeNum = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);
const hasWindow = () => typeof window !== "undefined";

/* ------------------------------- Optional deps ----------------------------- */

let eventBus = { emit: () => {}, on: () => {} };
try {
  // eslint-disable-next-line global-require
  const m = require("@/services/eventBus");
  eventBus = m?.default || m || eventBus;
} catch {}

let tierSync = null;
try {
  // eslint-disable-next-line global-require
  const m = require("@/services/sync/tierSync");
  tierSync = m?.default || m || null;
} catch {}

let recipeNormalizer = null;
try {
  // eslint-disable-next-line global-require
  const m = require("@/engines/normalization/recipeNormalizer");
  recipeNormalizer = m?.default || m || null;
} catch {}

let recipeDeduper = null; // your existing deduper (can consult Version Picker)
try {
  // eslint-disable-next-line global-require
  const m = require("@/engines/normalization/recipeDeduper");
  recipeDeduper = m?.default || m || null;
} catch {}

let versionPicker = null; // when multiple versions exist, pick or map canonical
try {
  // eslint-disable-next-line global-require
  const m = require("@/engines/normalization/VersionPicker");
  versionPicker = m?.default || m || null;
} catch {}

let IngredientLinker = null; // for aisle hints / linkage in previews
try {
  // eslint-disable-next-line global-require
  const m = require("@/engines/linkers/IngredientLinker");
  IngredientLinker = m?.default || m || null;
} catch {}

/* ----------------------------- Lightweight NLP ----------------------------- */

function tokenize(str) {
  return safeStr(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function buildKeywords(recipe) {
  const parts = [
    recipe.title,
    recipe.description,
    ...(recipe.tags || []),
    ...safeArr(recipe.ingredients).map((i) => i.name || i.ingredient || ""),
    ...safeArr(recipe.steps).map((s) => s.description || s.label || ""),
    recipe?.source?.url || "",
    recipe?.source?.author || "",
  ];
  return Array.from(new Set(parts.flatMap(tokenize)));
}

const ALLERGEN_MAP = {
  gluten: ["wheat", "flour", "bread", "pasta", "barley", "rye", "spelt"],
  dairy: ["milk", "butter", "cheese", "yogurt", "cream", "whey"],
  egg: ["egg", "eggs"],
  soy: ["soy", "soybean", "soy sauce", "tofu", "edamame", "miso"],
  nut: ["almond", "walnut", "pecan", "cashew", "peanut", "hazelnut", "pistachio"],
  shellfish: ["shrimp", "prawn", "lobster", "crab", "scallop"],
  fish: ["salmon", "tuna", "cod", "trout", "anchovy", "sardine"],
  sesame: ["sesame", "tahini", "gomashio"],
};

function detectAllergens(recipe) {
  const words = new Set(
    [
      ...safeArr(recipe.ingredients).map((i) => safeStr(i.name || i.ingredient).toLowerCase()),
      safeStr(recipe.title).toLowerCase(),
      safeStr(recipe.description).toLowerCase(),
    ]
      .join(" ")
      .split(/\s|,|;|\/|\(|\)/g)
      .map((w) => w.trim())
  );

  const flags = {};
  for (const [k, list] of Object.entries(ALLERGEN_MAP)) {
    flags[k] = list.some((term) => words.has(term) || safeStr([...words].join(" ")).includes(term));
  }
  return flags;
}

/* -------------------------- Nutrition (very rough) ------------------------- */

function estimateNutrition(recipe) {
  if (recipe.nutrition && (recipe.nutrition.kcal || recipe.nutrition.calories)) {
    return recipe.nutrition;
  }
  const ingsText = safeArr(recipe.ingredients).map((i) => safeStr(i.name || i.ingredient).toLowerCase()).join(" ");
  let kcal = 250;
  if (/fried|cheese|cream|butter/i.test(ingsText)) kcal += 150;
  if (/salad|leaf|vegetable|broccoli|lettuce|spinach/i.test(ingsText)) kcal -= 50;
  if (/beef|pork|chicken|egg|tofu|bean/i.test(ingsText)) kcal += 50;
  kcal = clamp(kcal, 80, 900);
  return { kcal, proteinG: /beef|pork|chicken|egg|tofu|bean/i.test(ingsText) ? 20 : 8, carbsG: 24, fatG: 12 };
}

/* ------------------------------ Attribution -------------------------------- */

/**
 * Build normalized source attribution.
 * Supports: manual entry, collector UI, bulk import, web clipper, scanner, scraper, API.
 */
function normalizeAttribution(source) {
  if (!source) return null;
  const nowISO = iso();
  const out = {
    type: source.type || "manual",              // 'manual' | 'clipper' | 'import' | 'scanner' | 'scraper' | 'api'
    url: source.url || null,                    // canonical URL if any
    collectedVia: source.collectedVia || null,  // e.g., 'RecipeVault', 'BulkUrlGrid', 'Scanner', 'API'
    importedFrom: source.importedFrom || null,  // e.g., 'Paprika', 'Pinterest', 'AllRecipes'
    scrapedAt: source.scrapedAt || nowISO,
    author: source.author || null,
    authorUrl: source.authorUrl || null,
    license: source.license || null,
    checksum: source.checksum || null,          // optional content checksum/fingerprint
    notes: source.notes || null,
    tool: source.tool || null,                  // which tool captured this (for analytics)
  };
  return out;
}

function fingerprintRecipe(r) {
  // Stable-ish fingerprint used for merge detection
  const title = safeStr(r.title).toLowerCase().trim();
  const domain = safeStr(r?.source?.url).toLowerCase().replace(/^https?:\/\//, "").split("/")[0] || "";
  const ing = safeArr(r.ingredients)
    .map((i) => safeStr(i.name || i.ingredient).toLowerCase().trim())
    .sort()
    .slice(0, 8)
    .join("|");
  return [title, domain, ing].filter(Boolean).join("::");
}

/* ------------------------------- Index writer ------------------------------ */

async function writeRecipeIndex(id, payload) {
  try {
    if (DexieDB.recipeIndex) {
      await DexieDB.recipeIndex.put({ id, ...payload });
    }
  } catch { /* noop */ }
}

/* ------------------------------ Deep Links/UX ------------------------------ */

function deepLinkFor(recipe) {
  return { panel: "Recipes", tab: "Details", id: recipe.id };
}

function toastFor(recipe) {
  return `📖 Saved — ${recipe.title}`;
}

function speakFor(recipe) {
  return `Recipe saved: ${recipe.title}.`;
}

/* ------------------------------ Merge Helpers ------------------------------ */

function mergeArraysUnique(a = [], b = [], key = (x) => JSON.stringify(x)) {
  const seen = new Set(a.map(key));
  const out = [...a];
  for (const item of b) {
    const k = key(item);
    if (!seen.has(k)) { seen.add(k); out.push(item); }
  }
  return out;
}

// Prefer non-empty fields; strategy: 'existing' | 'new' | 'smart'
function fieldMerge(existingVal, incomingVal, strategy = "smart") {
  if (strategy === "existing") return existingVal ?? incomingVal;
  if (strategy === "new") return incomingVal ?? existingVal;

  // smart strategy: prefer incoming when existing is empty or clearly worse
  const empty = (v) => v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);
  if (empty(existingVal) && !empty(incomingVal)) return incomingVal;
  return existingVal ?? incomingVal;
}

function normalizeForSave(recipe) {
  // Hook into recipeNormalizer if available for units/servings standardization.
  if (recipeNormalizer?.normalizeRecipe) {
    try { return recipeNormalizer.normalizeRecipe(recipe); } catch (e) { console.warn("[RecipeManager] normalizeRecipe failed", e); }
  }
  return recipe;
}

/* --------------------------------- Manager --------------------------------- */

const RecipeManager = {
  /**
   * Save / Update with optional merge & source attribution.
   * @param {Recipe|Object} recipe
   * @param {Object} options
   *   - overrides?: { steps }
   *   - source?: { type, url, collectedVia, importedFrom, scrapedAt, author, license, checksum, notes, tool }
   *   - merge?: boolean = true
   *   - strategy?: "smart" | "existing" | "new"
   * @returns {Promise<Recipe>}
   */
  async save(recipe, { overrides = null, source = null, merge = true, strategy = "smart" } = {}) {
    if (!(recipe instanceof Recipe)) {
      recipe = new Recipe(recipe);
    }

    // normalize & validate
    recipe = normalizeForSave(recipe);
    const errors = recipe.validate();
    if (errors.length) throw new Error("Validation failed: " + errors.join(" | "));

    // parse steps
    const parsedSteps = parseRecipeSteps(recipe.instructions || []);
    const stepsToUse = overrides?.steps || parsedSteps;
    recipe.steps = stepsToUse;
    recipe.prepSteps = stepsToUse.map(({ description, estimatedTime }) => ({
      label: description,
      minutes: estimatedTime,
    }));

    // defaults
    recipe.yield = recipe.yield || { servings: Number(recipe.servings || 4), unit: "servings" };
    recipe.servings = recipe.yield?.servings ?? recipe.servings ?? 4;

    // enrich
    recipe.keywords = buildKeywords(recipe);
    recipe.allergens = detectAllergens(recipe);
    recipe.nutrition = estimateNutrition(recipe);
    recipe.updatedAt = new Date();
    recipe.updatedAtISO = iso(recipe.updatedAt);
    recipe.deepLink = recipe.deepLink || deepLinkFor(recipe);

    // attach attribution (preserve trail)
    if (source) {
      const attr = normalizeAttribution(source);
      const trail = safeArr(recipe.attributions);
      recipe.attributions = [...trail, attr];
      // also expose a single 'source' snapshot for quick UI
      recipe.source = {
        ...(recipe.source || {}),
        url: attr.url || recipe.source?.url || null,
        type: attr.type || recipe.source?.type || "manual",
        author: attr.author || recipe.source?.author || null,
        license: attr.license || recipe.source?.license || null,
        importedFrom: attr.importedFrom || recipe.source?.importedFrom || null,
        collectedVia: attr.collectedVia || recipe.source?.collectedVia || null,
        scrapedAt: attr.scrapedAt || recipe.source?.scrapedAt || recipe.updatedAtISO,
      };
    } else {
      recipe.attributions = safeArr(recipe.attributions);
      recipe.source = recipe.source || null;
    }

    // compute fingerprint for dedupe/merge
    recipe.fingerprint = recipe.fingerprint || fingerprintRecipe(recipe);

    // Optionally merge with an existing record
    let existing = null;
    if (merge) {
      existing = await this._findMergeCandidate(recipe);
      if (existing) {
        const merged = this.mergeWithExisting(existing, recipe, { strategy });
        // carry forward updated timestamps & keywords post-merge
        merged.updatedAt = new Date();
        merged.updatedAtISO = iso(merged.updatedAt);
        merged.keywords = buildKeywords(merged);
        merged.allergens = detectAllergens(merged);
        merged.nutrition = estimateNutrition(merged);
        merged.fingerprint = merged.fingerprint || fingerprintRecipe(merged);

        await DexieDB.recipes.put(merged);
        await writeRecipeIndex(merged.id, {
          title: merged.title,
          keywords: merged.keywords,
          tags: merged.tags || [],
          allergens: merged.allergens || {},
          updatedAtISO: merged.updatedAtISO,
          sourceUrl: merged?.source?.url || null,
        });

        // live events
        safeEmit("recipes:merged", { id: merged.id, source: merged?.source?.url || null });
        try {
          const s = hasWindow() ? window.__SUKA_SOCKET__ : null;
          if (s?.connected) s.emit("RECIPES:UPDATED", { id: merged.id, at: merged.updatedAtISO });
        } catch {}

        merged.toast = `🔀 Merged — ${merged.title}`;
        merged.speak = `Recipe merged: ${merged.title}.`;
        return new Recipe(merged);
      }
    }

    // no merge → save incoming
    await DexieDB.recipes.put(recipe);
    await writeRecipeIndex(recipe.id, {
      title: recipe.title,
      keywords: recipe.keywords,
      tags: recipe.tags || [],
      allergens: recipe.allergens || {},
      updatedAtISO: recipe.updatedAtISO,
      sourceUrl: recipe?.source?.url || null,
    });

    // live events
    safeEmit("recipes:saved", { id: recipe.id, source: recipe?.source?.url || null });
    try {
      const s = hasWindow() ? window.__SUKA_SOCKET__ : null;
      if (s?.connected) s.emit("RECIPES:UPDATED", { id: recipe.id, at: recipe.updatedAtISO });
    } catch {}

    recipe.toast = toastFor(recipe);
    recipe.speak = speakFor(recipe);
    return recipe;
  },

  /** Alias that defaults to { merge: true } */
  async saveOrMerge(recipe, opts = {}) {
    return this.save(recipe, { merge: true, strategy: "smart", ...opts });
  },

  /** Attempt to find an existing record to merge with. */
  async _findMergeCandidate(incoming) {
    // 1) direct id
    if (incoming?.id) {
      const byId = await DexieDB.recipes.get(incoming.id);
      if (byId) return byId;
    }
    // 2) by source URL
    if (incoming?.source?.url) {
      const byUrl = await this.getBySourceURL(incoming.source.url);
      if (byUrl) return byUrl;
    }
    // 3) by fingerprint
    if (incoming?.fingerprint) {
      try {
        const all = await DexieDB.recipes.where("fingerprint").equals(incoming.fingerprint).toArray();
        if (all?.length) return all[0];
      } catch { /* index may not exist; fall through */ }
      const all = await DexieDB.recipes.toArray();
      const found = all.find((r) => r.fingerprint === incoming.fingerprint);
      if (found) return found;
    }
    // 4) versionPicker / deduper (best-effort fuzzy)
    try {
      if (versionPicker?.findMatch) {
        const m = await versionPicker.findMatch(incoming, await DexieDB.recipes.toArray());
        if (m) return m;
      }
    } catch {}
    try {
      if (recipeDeduper?.findDuplicate) {
        const m = await recipeDeduper.findDuplicate(incoming, await DexieDB.recipes.toArray());
        if (m) return m;
      }
    } catch {}
    return null;
  },

  /**
   * Merge strategy for two recipes.
   * - Arrays are de-duped.
   * - Steps keep incoming time improvements but preserve existing IDs where possible.
   * - Attributions are appended (unique by (type|url|checksum|author)).
   */
  mergeWithExisting(existing, incoming, { strategy = "smart" } = {}) {
    const merged = { ...existing };

    // Primitive / simple fields
    merged.title = fieldMerge(existing.title, incoming.title, strategy);
    merged.description = fieldMerge(existing.description, incoming.description, strategy);
    merged.category = fieldMerge(existing.category, incoming.category, strategy);
    merged.cuisine = fieldMerge(existing.cuisine, incoming.cuisine, strategy);
    merged.thumbnail = fieldMerge(existing.thumbnail, incoming.thumbnail, strategy);

    // Yield / servings
    const exServ = existing?.yield?.servings ?? existing?.servings;
    const inServ = incoming?.yield?.servings ?? incoming?.servings;
    const finalServ = safeNum(fieldMerge(exServ, inServ, strategy), exServ || inServ || 4);
    merged.servings = finalServ;
    merged.yield = { ...(existing.yield || {}), ...(incoming.yield || {}), servings: finalServ };

    // Arrays: ingredients / tags
    merged.ingredients = mergeArraysUnique(
      safeArr(existing.ingredients),
      safeArr(incoming.ingredients),
      (x) => `${safeStr(x.name || x.ingredient).toLowerCase()}|${safeStr(x.unit)}|${safeStr(x.form)}|${safeStr(x.note)}`
    );

    merged.tags = Array.from(new Set([...(existing.tags || []), ...(incoming.tags || [])]));

    // Steps (preserve existing IDs where label matches; otherwise append)
    const exSteps = safeArr(existing.steps);
    const inSteps = safeArr(incoming.steps);
    const exByLabel = new Map(exSteps.map((s) => [safeStr(s.description || s.label).toLowerCase(), s]));
    const mergedSteps = [];
    for (const s of inSteps) {
      const key = safeStr(s.description || s.label).toLowerCase();
      const prev = exByLabel.get(key);
      if (prev) {
        mergedSteps.push({
          ...prev,
          ...s,
          estimatedTime: safeNum(fieldMerge(prev.estimatedTime, s.estimatedTime, "smart"), s.estimatedTime || prev.estimatedTime || 5),
        });
      } else {
        mergedSteps.push(s);
      }
    }
    // also keep any extra previous steps that new didn’t mention
    const inLabels = new Set(inSteps.map((s) => safeStr(s.description || s.label).toLowerCase()));
    for (const s of exSteps) {
      const key = safeStr(s.description || s.label).toLowerCase();
      if (!inLabels.has(key)) mergedSteps.push(s);
    }
    merged.steps = mergedSteps;

    // Prep steps cache
    merged.prepSteps = mergedSteps.map(({ description, estimatedTime }) => ({
      label: description,
      minutes: safeNum(estimatedTime, 5),
    }));

    // Source snapshot and attribution trail
    const exTrail = safeArr(existing.attributions);
    const inTrail = safeArr(incoming.attributions);
    const uniqueKey = (a) => `${a.type || ""}|${a.url || ""}|${a.checksum || ""}|${a.author || ""}`;
    merged.attributions = mergeArraysUnique(exTrail, inTrail, uniqueKey);

    merged.source = {
      ...(existing.source || {}),
      ...(incoming.source || {}),
      url: fieldMerge(existing?.source?.url, incoming?.source?.url, "smart"),
      type: fieldMerge(existing?.source?.type, incoming?.source?.type, "smart"),
      author: fieldMerge(existing?.source?.author, incoming?.source?.author, "smart"),
      license: fieldMerge(existing?.source?.license, incoming?.source?.license, "smart"),
      importedFrom: fieldMerge(existing?.source?.importedFrom, incoming?.source?.importedFrom, "smart"),
      collectedVia: fieldMerge(existing?.source?.collectedVia, incoming?.source?.collectedVia, "smart"),
      scrapedAt: fieldMerge(existing?.source?.scrapedAt, incoming?.source?.scrapedAt, "new"),
    };

    // Derived
    merged.keywords = buildKeywords(merged);
    merged.allergens = detectAllergens(merged);
    merged.nutrition = estimateNutrition(merged);

    // Fingerprint: keep existing unless missing
    merged.fingerprint = existing.fingerprint || incoming.fingerprint || fingerprintRecipe(merged);

    return merged;
  },

  /** Add another attribution entry to a saved recipe. */
  async upsertAttribution(id, attributionLike) {
    const r = await DexieDB.recipes.get(id);
    if (!r) return 0;
    const attr = normalizeAttribution(attributionLike);
    const list = safeArr(r.attributions);
    const key = (a) => `${a.type || ""}|${a.url || ""}|${a.checksum || ""}|${a.author || ""}`;
    const exists = new Set(list.map(key));
    if (!exists.has(key(attr))) list.push(attr);
    r.attributions = list;
    r.source = r.source || { url: attr.url || null, type: attr.type || "manual" };
    if (!r.source.url && attr.url) r.source.url = attr.url;
    r.updatedAt = new Date();
    r.updatedAtISO = iso(r.updatedAt);
    await DexieDB.recipes.put(r);
    await writeRecipeIndex(r.id, {
      title: r.title,
      keywords: buildKeywords(r),
      tags: r.tags || [],
      allergens: r.allergens || {},
      updatedAtISO: r.updatedAtISO,
      sourceUrl: r?.source?.url || null,
    });
    safeEmit("recipes:attribution", { id: r.id, url: attr.url || null });
    return 1;
  },

  async listAttributions(id) {
    const r = await DexieDB.recipes.get(id);
    return r ? safeArr(r.attributions) : [];
  },

  /** Fetch a recipe by ID. */
  async getById(id) {
    const data = await DexieDB.recipes.get(id);
    return data ? new Recipe(data) : null;
  },

  /** Retrieve all recipes. */
  async getAll() {
    const all = await DexieDB.recipes.toArray();
    return all.map((r) => new Recipe(r));
  },

  /** Delete a recipe (and index row). */
  async delete(id) {
    try { if (DexieDB.recipeIndex) await DexieDB.recipeIndex.delete(id); } catch {}
    return DexieDB.recipes.delete(id);
  },

  /** Text + tag + allergen aware search (prefers index). */
  async search(q, { tagsAny = [], excludeAllergens = [], limit = 50 } = {}) {
    const needle = safeStr(q).toLowerCase().trim();
    try {
      if (DexieDB.recipeIndex) {
        const ix = await DexieDB.recipeIndex.toArray();
        const hits = ix.filter((row) => {
          const textMatch = !needle ||
            row.title?.toLowerCase().includes(needle) ||
            safeArr(row.keywords).some((k) => k.includes(needle)) ||
            (row.sourceUrl || "").toLowerCase().includes(needle);
          const tagMatch = !tagsAny.length || safeArr(row.tags).some((t) => tagsAny.includes(t));
          const allergenOK = !excludeAllergens.length || excludeAllergens.every((a) => !row.allergens?.[a]);
          return textMatch && tagMatch && allergenOK;
        });
        const ids = hits.slice(0, limit).map((h) => h.id);
        const recs = await DexieDB.recipes.bulkGet(ids);
        return recs.filter(Boolean).map((r) => new Recipe(r));
      }
    } catch {}
    // fallback
    const all = await DexieDB.recipes.toArray();
    const filtered = all.filter((r) => {
      const text =
        r.title?.toLowerCase().includes(needle) ||
        safeArr(r.keywords).some((k) => k.includes(needle)) ||
        safeStr(r.description).toLowerCase().includes(needle) ||
        safeStr(r?.source?.url).toLowerCase().includes(needle);
      const tag = !tagsAny.length || safeArr(r.tags).some((t) => tagsAny.includes(t));
      const allergens = excludeAllergens.length
        ? excludeAllergens.every((a) => !(r.allergens && r.allergens[a]))
        : true;
      return (!needle || text) && tag && allergens;
    });
    return filtered.slice(0, limit).map((r) => new Recipe(r));
  },

  async getByTag(tag) {
    if (!tag) return [];
    try {
      if (DexieDB.recipeIndex?.where) {
        // Dexie multiEntry index recommended for 'tags'
        const ix = await DexieDB.recipeIndex.where("tags").equals(tag).toArray();
        const ids = ix.map((r) => r.id);
        const recs = await DexieDB.recipes.bulkGet(ids);
        return recs.filter(Boolean).map((r) => new Recipe(r));
      }
    } catch {}
    const all = await DexieDB.recipes.toArray();
    return all.filter((r) => safeArr(r.tags).includes(tag)).map((r) => new Recipe(r));
  },

  async getByIngredient(name) {
    if (!name) return [];
    const n = safeStr(name).toLowerCase();
    const all = await DexieDB.recipes.toArray();
    return all
      .filter((r) => safeArr(r.ingredients).some((i) => safeStr(i.name || i.ingredient).toLowerCase().includes(n)))
      .map((r) => new Recipe(r));
  },

  /** Quick fetch by source URL for dedupe/merge. */
  async getBySourceURL(url) {
    const u = safeStr(url).trim();
    if (!u) return null;
    try {
      if (DexieDB.recipeIndex?.where) {
        const ix = await DexieDB.recipeIndex.where("sourceUrl").equals(u).toArray();
        if (ix?.length) {
          const rec = await DexieDB.recipes.get(ix[0].id);
          return rec ? new Recipe(rec) : null;
        }
      }
    } catch {}
    // fallback full scan
    const all = await DexieDB.recipes.toArray();
    const found = all.find((r) => safeStr(r?.source?.url).trim() === u);
    return found ? new Recipe(found) : null;
  },

  /** Return a new, scaled copy (not persisted unless saved). */
  async scaleRecipe(recipeOrId, factor = 1) {
    const base = typeof recipeOrId === "string" ? await this.getById(recipeOrId) : recipeOrId;
    if (!base) return null;
    const clone = new Recipe(JSON.parse(JSON.stringify(base)));
    clone.id = clone.id; // preserve id unless you want to duplicate elsewhere
    clone.servings = Math.max(1, Math.round((clone.servings || clone.yield?.servings || 4) * factor));
    clone.yield = { ...(clone.yield || {}), servings: clone.servings };
    clone.ingredients = safeArr(clone.ingredients).map((i) => {
      const qty = Number(i.quantity ?? i.qty ?? 0);
      if (!Number.isFinite(qty)) return i;
      return { ...i, quantity: +(qty * factor).toFixed(2) };
    });
    clone.steps = safeArr(clone.steps).map((s) => ({
      ...s,
      estimatedTime: Math.round((s.estimatedTime || 0) * (factor > 1 ? 1.1 : 1)),
    }));
    clone.updatedAt = new Date();
    return clone;
  },

  /** Build a single-stream prep timeline for today. */
  async planPrepTimeline(recipeOrId, { startISO = iso() } = {}) {
    const r = typeof recipeOrId === "string" ? await this.getById(recipeOrId) : recipeOrId;
    if (!r) return [];
    const steps = safeArr(r.steps).length ? r.steps : parseRecipeSteps(r.instructions || []);
    const start = new Date(startISO);
    const out = [];
    let cursor = new Date(start);
    for (const s of steps) {
      const dur = Math.max(1, Number(s.estimatedTime || s.minutes || 5));
      const begin = new Date(cursor);
      const end = new Date(begin.getTime() + dur * 60000);
      out.push({
        id: `${r.id}:${s.id || s.label || Math.random().toString(36).slice(2)}`,
        title: `🍳 ${r.title} — ${s.description || s.label || "Step"}`,
        start: begin.toISOString(),
        end: end.toISOString(),
        metadata: { recipeId: r.id, kind: s.kind || "prep" },
      });
      cursor = end;
    }
    return out;
  },

  /** Simple substitution hints. */
  async suggestSubstitutions(recipeOrId) {
    const r = typeof recipeOrId === "string" ? await this.getById(recipeOrId) : recipeOrId;
    if (!r) return [];
    const list = [];
    const text = safeArr(r.ingredients).map((i) => safeStr(i.name || i.ingredient).toLowerCase()).join(" ");
    if (/buttermilk/.test(text)) list.push({ need: "buttermilk", try: "milk + vinegar/lemon (1c + 1 Tbsp)" });
    if (/egg/.test(text)) list.push({ need: "egg", try: "ground flax + water (1 Tbsp + 3 Tbsp)" });
    if (/soy sauce|tamari/.test(text)) list.push({ need: "soy sauce", try: "coconut aminos" });
    if (/cream/.test(text)) list.push({ need: "heavy cream", try: "evaporated milk or milk + butter" });
    if (/butter/.test(text)) list.push({ need: "butter", try: "ghee or coconut oil (baking)" });
    return list;
  },

  /** Lightweight inventory linkage (best-effort). */
  async linkInventoryHints(recipeOrId) {
    const r = typeof recipeOrId === "string" ? await this.getById(recipeOrId) : recipeOrId;
    if (!r) return [];
    const supplies = await (DexieDB.supplies?.toArray?.() ?? []);
    const map = new Map(supplies.map((s) => [safeStr(s.name).toLowerCase(), s]));
    const rows = safeArr(r.ingredients).map((i) => {
      const key = safeStr(i.name || i.ingredient).toLowerCase();
      const match = map.get(key) || supplies.find((s) => key.includes(safeStr(s.name).toLowerCase()));
      return {
        ingredient: i,
        supplyId: match?.id || null,
        low: match ? (match.quantity ?? 0) <= (match.threshold ?? -Infinity) : false,
        location: match?.location || null,
      };
    });

    // optional: aisle hint via IngredientLinker
    try {
      const tags = r.tags || [];
      const aisleHint = IngredientLinker?.mapAisleHint?.(tags, r.title || "") || null;
      return rows.map((row) => ({ ...row, aisleHint }));
    } catch {
      return rows;
    }
  },

  async toggleFavorite(id, flag) {
    const r = await DexieDB.recipes.get(id);
    if (!r) return 0;
    r.favorite = typeof flag === "boolean" ? flag : !r.favorite;
    r.updatedAt = new Date();
    await DexieDB.recipes.put(r);
    safeEmit("recipes:favorited", { id, favorite: r.favorite });
    return r.favorite ? 1 : 0;
  },

  async rate(id, stars = 5) {
    const s = clamp(Math.round(stars), 1, 5);
    const r = await DexieDB.recipes.get(id);
    if (!r) return 0;
    r.rating = s;
    r.updatedAt = new Date();
    await DexieDB.recipes.put(r);
    safeEmit("recipes:rated", { id, rating: s });
    return s;
  },

  async recent(limit = 20) {
    const all = await DexieDB.recipes.toArray();
    return all
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, limit)
      .map((r) => new Recipe(r));
  },

  async exportAll() {
    const recs = await DexieDB.recipes.toArray();
    return { exportedAt: iso(), count: recs.length, recipes: recs };
  },

  async importMany(payload, { merge = true, strategy = "smart", source = { type: "import", importedFrom: "json" } } = {}) {
    const list = Array.isArray(payload?.recipes) ? payload.recipes : [];
    if (!merge) {
      try { await DexieDB.recipes.clear(); } catch {}
      try { if (DexieDB.recipeIndex) await DexieDB.recipeIndex.clear(); } catch {}
    }
    for (const r of list) {
      // run the full save pipeline to normalize + attribute + index
      // eslint-disable-next-line no-await-in-loop
      await this.save(r, { merge, strategy, source });
    }
    safeEmit("recipes:imported", { count: list.length });
    return list.length;
  },
};

/* --------------------------------- Emitters -------------------------------- */

function safeEmit(evt, payload) {
  try {
    eventBus?.emit?.(evt, payload);
  } catch (e) {
    console.warn(`[RecipeManager] event emit failed "${evt}"`, e);
  }
  // optional tier sync (non-blocking)
  try {
    tierSync?.publish?.(`recipes.${evt}`, payload);
  } catch {}
}

export default RecipeManager;
