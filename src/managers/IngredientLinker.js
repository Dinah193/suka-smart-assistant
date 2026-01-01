// src/engines/linkers/IngredientLinker.js
/* eslint-disable no-console */
/**
 * IngredientLinker
 * -----------------
 * Purpose: map an ingredient → (inventory | garden | animal | bulk), with primary + fallback candidates
 * Style: dynamic, defensive, event-driven, context-aware
 *
 * Key features:
 * - Normalizes names/units (defensive if recipeNormalizer is unavailable)
 * - Uses explicit overrides from ingredientSourceMap when present
 * - Merges signals from inventory, garden harvest windows, animal yield, and bulk suppliers
 * - Confidence scoring with clear rationale trail
 * - Offers primary selection + ranked fallbacks (candidates[])
 * - Emits events (ingredient:linked) when a mapping is made
 * - Tier-aware (household/community) via optional tierSync
 * - Sabbath guard support via context flags (won’t schedule actions if sabbathGuard === true)
 * - Pluggable tag inference via taggingAutoClassifier (if available)
 *
 * Return shape example:
 * {
 *   name: "lamb shoulder",
 *   normalized: { name: "lamb shoulder", qty: 2, unit: "lb" },
 *   primary: { sourceType: "animal", sourceId: "sheep", confidence: 0.86, rationale: ["animal-match","inventory-low"], actions: [...] },
 *   candidates: [
 *     { sourceType: "inventory", sourceId: "inv_123", confidence: 0.78, rationale: ["inventory-sku","qty-available"] },
 *     { sourceType: "bulk", supplier: "Butcher Co-op", confidence: 0.64, rationale: ["bulk-default"] }
 *   ],
 *   tags: ["meat","butchery","protein"],
 *   meta: { aisleHint: "Butchery", store: "Default" }
 * }
 */

/* ------------------------------- Optional deps ------------------------------- */
let eventBus = { emit: () => {}, on: () => {} };
try {
  const mod = require("@/services/eventBus");
  eventBus = mod?.default || mod || eventBus;
} catch (_) {}

let tierSync = null;
try {
  const mod = require("@/services/sync/tierSync");
  tierSync = mod?.default || mod || null;
} catch (_) {}

let recipeNormalizer = null;
try {
  const mod = require("@/engines/normalization/recipeNormalizer");
  recipeNormalizer = mod?.default || mod || null;
} catch (_) {}

let classifier = null;
try {
  const mod = require("@/engines/classifiers/taggingAutoClassifier");
  classifier = mod?.default || mod || null;
} catch (_) {}

let INGREDIENT_SOURCES = null;
try {
  const mod = require("@/app/utils/ingredientSourceMap");
  INGREDIENT_SOURCES = (mod?.INGREDIENT_SOURCES || null);
} catch (_) {}

let inventoryApi = null;
try {
  const mod = require("@/services/inventory/api");
  inventoryApi = mod?.default || mod || null;
} catch (_) {}

let gardenApi = null;
try {
  const mod = require("@/services/garden/api");
  gardenApi = mod?.default || mod || null;
} catch (_) {}

let animalApi = null;
try {
  const mod = require("@/services/animals/api");
  animalApi = mod?.default || mod || null;
} catch (_) {}

let suppliersApi = null;
try {
  const mod = require("@/services/suppliers/api");
  suppliersApi = mod?.default || mod || null;
} catch (_) {}

/* ------------------------------- Utilities ---------------------------------- */

/** Basic singularization for common plurals */
function singularize(name = "") {
  if (!name) return "";
  const lower = name.toLowerCase().trim();
  // quick handles; can be extended
  if (lower.endsWith("ies")) return lower.slice(0, -3) + "y";
  if (lower.endsWith("sses")) return lower.slice(0, -2);
  if (lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

function normalizeWhitespace(s = "") {
  return s.replace(/\s+/g, " ").trim();
}

/** Try to normalize with recipeNormalizer; fall back gracefully */
function normalizeIngredient(raw) {
  const base = {
    name: typeof raw === "string" ? raw : raw?.name || "",
    qty: raw?.qty ?? raw?.quantity ?? null,
    unit: raw?.unit ?? raw?.units ?? null,
    notes: raw?.notes ?? null,
    meta: raw?.meta ?? {},
  };
  if (recipeNormalizer?.normalize) {
    try {
      const norm = recipeNormalizer.normalize(raw);
      return {
        name: norm?.name || singularize(base.name),
        qty: norm?.qty ?? base.qty,
        unit: norm?.unit ?? base.unit,
        notes: norm?.notes ?? base.notes,
        meta: norm?.meta ?? base.meta,
      };
    } catch (e) {
      console.warn("[IngredientLinker] recipeNormalizer.normalize failed:", e);
    }
  }
  return {
    name: singularize(normalizeWhitespace(base.name)),
    qty: base.qty,
    unit: base.unit,
    notes: base.notes,
    meta: base.meta,
  };
}

/** Simple similarity (Jaro-Winkler-like light) */
function similarity(a = "", b = "") {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  if (!a || !b) return 0;
  const setA = new Set(a.split(" "));
  const setB = new Set(b.split(" "));
  const inter = [...setA].filter(t => setB.has(t));
  return inter.length / Math.max(setA.size, setB.size);
}

/** Score helpers produce numeric weights and rationale tags */
const Weights = {
  explicitMap: 0.55,
  inventorySku: 0.45,
  inventoryAvail: 0.2,
  nameSimStrong: 0.3,
  nameSimWeak: 0.15,
  gardenInSeason: 0.35,
  gardenPlanned: 0.25,
  animalMatch: 0.5,
  bulkDefault: 0.2,
  pantryLow: -0.05,
  inventoryLow: -0.1,
};

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

/* ------------------------------- Core logic --------------------------------- */

/**
 * Build candidate(s) from inventory matches
 */
function inventoryCandidates(normName, neededQty, ctx) {
  if (!inventoryApi?.findItems) return [];
  try {
    const found = inventoryApi.findItems({ query: normName });
    return (found || []).map(item => {
      const sim = similarity(normName, singularize(item?.name || ""));
      let score = 0;
      const rationale = [];
      if (item?.sku) {
        score += Weights.inventorySku;
        rationale.push("inventory-sku");
      }
      if (item?.qty > 0) {
        score += Weights.inventoryAvail;
        rationale.push("qty-available");
      } else {
        score += Weights.inventoryLow;
        rationale.push("inventory-low");
      }
      if (sim >= 0.66) {
        score += Weights.nameSimStrong;
        rationale.push("name-sim-strong");
      } else if (sim >= 0.4) {
        score += Weights.nameSimWeak;
        rationale.push("name-sim-weak");
      }
      // pantry awareness: if user wants to preserve pantry, slightly penalize
      if (ctx?.pantryGuard === true) {
        score += Weights.pantryLow;
        rationale.push("pantry-guard");
      }
      return {
        sourceType: "inventory",
        sourceId: item?.id || item?.sku || null,
        confidence: clamp01(score),
        rationale,
        item,
        fulfill: () => ({
          type: "inventory:reserve",
          disabled: ctx?.sabbathGuard === true,
          data: { itemId: item?.id || item?.sku, qty: neededQty ?? null, unit: ctx?.unit || null },
        }),
      };
    }).sort((a, b) => b.confidence - a.confidence);
  } catch (e) {
    console.warn("[IngredientLinker] inventoryCandidates error:", e);
    return [];
  }
}

/**
 * Build candidate(s) from garden matches
 */
function gardenCandidates(normName, ctx) {
  if (!gardenApi?.searchCrops) return [];
  try {
    const crops = gardenApi.searchCrops({ query: normName });
    return (crops || []).map(crop => {
      const sim = similarity(normName, singularize(crop?.name || crop?.crop || ""));
      const inSeason = crop?.inSeason === true || crop?.harvestWindow?.includes(ctx?.targetDateRange?.label);
      const planned = crop?.planned === true || crop?.beds?.length > 0;
      let score = 0;
      const rationale = [];
      if (sim >= 0.66) {
        score += Weights.nameSimStrong;
        rationale.push("name-sim-strong");
      } else if (sim >= 0.4) {
        score += Weights.nameSimWeak;
        rationale.push("name-sim-weak");
      }
      if (inSeason) {
        score += Weights.gardenInSeason;
        rationale.push("garden-in-season");
      }
      if (planned) {
        score += Weights.gardenPlanned;
        rationale.push("garden-planned");
      }
      return {
        sourceType: "garden",
        sourceId: crop?.id || crop?.slug || crop?.crop || null,
        confidence: clamp01(score),
        rationale,
        crop,
        fulfill: () => ({
          type: "garden:allocateHarvest",
          disabled: ctx?.sabbathGuard === true,
          data: { cropId: crop?.id, estimateQty: ctx?.estimateQty ?? null },
        }),
      };
    }).sort((a, b) => b.confidence - a.confidence);
  } catch (e) {
    console.warn("[IngredientLinker] gardenCandidates error:", e);
    return [];
  }
}

/**
 * Build candidate(s) from animal matches
 */
function animalCandidates(normName, ctx) {
  if (!animalApi?.search) return [];
  try {
    const results = animalApi.search({ query: normName });
    return (results || []).map(an => {
      const labels = [an?.animal, an?.breed, ...(an?.tags || [])].filter(Boolean).join(" ");
      const sim = similarity(normName, singularize(labels));
      let score = 0;
      const rationale = [];
      if (sim >= 0.5) {
        score += Weights.animalMatch;
        rationale.push("animal-match");
      }
      // (Optional) penalize if zero projected yield
      if (an?.projectedYield && an?.projectedYield <= 0) {
        score += Weights.inventoryLow;
        rationale.push("yield-low");
      }
      return {
        sourceType: "animal",
        sourceId: an?.id || an?.animal || null,
        confidence: clamp01(score),
        rationale,
        animal: an,
        fulfill: () => ({
          type: "animal:reserveCut",
          disabled: ctx?.sabbathGuard === true,
          data: { animalId: an?.id, cutHint: normName, qty: ctx?.neededQty ?? null },
        }),
      };
    }).sort((a, b) => b.confidence - a.confidence);
  } catch (e) {
    console.warn("[IngredientLinker] animalCandidates error:", e);
    return [];
  }
}

/**
 * Build candidate(s) from bulk suppliers
 */
function bulkCandidates(normName, ctx) {
  if (!suppliersApi?.search) {
    // default fallback if suppliers API not present
    return [{
      sourceType: "bulk",
      supplier: "Default Supplier",
      confidence: clamp01(Weights.bulkDefault),
      rationale: ["bulk-default"],
      fulfill: () => ({
        type: "bulk:order",
        disabled: ctx?.sabbathGuard === true,
        data: { item: normName, qty: ctx?.neededQty ?? null },
      }),
    }];
  }
  try {
    const items = suppliersApi.search({ query: normName, category: "food" });
    if (!items?.length) {
      return [{
        sourceType: "bulk",
        supplier: "Default Supplier",
        confidence: clamp01(Weights.bulkDefault),
        rationale: ["bulk-default"],
        fulfill: () => ({
          type: "bulk:order",
          disabled: ctx?.sabbathGuard === true,
          data: { item: normName, qty: ctx?.neededQty ?? null },
        }),
      }];
    }
    return items.map(s => {
      const sim = similarity(normName, singularize(s?.name || ""));
      const score = clamp01((sim >= 0.66 ? Weights.nameSimStrong : sim >= 0.4 ? Weights.nameSimWeak : 0) + Weights.bulkDefault);
      const rationale = ["bulk-default", sim >= 0.66 ? "name-sim-strong" : sim >= 0.4 ? "name-sim-weak" : "name-sim-low"];
      return {
        sourceType: "bulk",
        sourceId: s?.id || null,
        supplier: s?.supplier || s?.vendor || "Supplier",
        confidence: score,
        rationale,
        supplierItem: s,
        fulfill: () => ({
          type: "bulk:order",
          disabled: ctx?.sabbathGuard === true,
          data: { supplierItemId: s?.id, qty: ctx?.neededQty ?? null },
        }),
      };
    }).sort((a, b) => b.confidence - a.confidence);
  } catch (e) {
    console.warn("[IngredientLinker] bulkCandidates error:", e);
    return [{
      sourceType: "bulk",
      supplier: "Default Supplier",
      confidence: clamp01(Weights.bulkDefault),
      rationale: ["bulk-default"],
      fulfill: () => ({
        type: "bulk:order",
        disabled: ctx?.sabbathGuard === true,
        data: { item: normName, qty: ctx?.neededQty ?? null },
      }),
    }];
  }
}

/**
 * Apply explicit overrides from INGREDIENT_SOURCES when available
 */
function explicitMapCandidate(normName, ctx) {
  if (!INGREDIENT_SOURCES) return null;
  const entry = INGREDIENT_SOURCES[normName] || INGREDIENT_SOURCES[singularize(normName)];
  if (!entry) return null;

  const rationale = ["explicit-map"];
  let base = { sourceType: entry.source, confidence: Weights.explicitMap, rationale };

  if (entry.source === "garden") {
    base = {
      ...base,
      sourceId: entry.crop || null,
      fulfill: () => ({
        type: "garden:allocateHarvest",
        disabled: ctx?.sabbathGuard === true,
        data: { cropId: entry.crop, estimateQty: ctx?.estimateQty ?? null },
      }),
    };
  } else if (entry.source === "animal") {
    base = {
      ...base,
      sourceId: entry.animal || null,
      fulfill: () => ({
        type: "animal:reserveCut",
        disabled: ctx?.sabbathGuard === true,
        data: { animalId: entry.animal, cutHint: normName, qty: ctx?.neededQty ?? null },
      }),
    };
  } else if (entry.source === "bulk") {
    base = {
      ...base,
      supplier: entry.supplier || "Default Supplier",
      fulfill: () => ({
        type: "bulk:order",
        disabled: ctx?.sabbathGuard === true,
        data: { supplier: entry.supplier, item: normName, qty: ctx?.neededQty ?? null },
      }),
    };
  } else if (entry.source === "inventory") {
    base = {
      ...base,
      sourceId: entry.itemId || null,
      fulfill: () => ({
        type: "inventory:reserve",
        disabled: ctx?.sabbathGuard === true,
        data: { itemId: entry.itemId, qty: ctx?.neededQty ?? null },
      }),
    };
  }

  return { ...base, confidence: clamp01(base.confidence) };
}

/**
 * Optional tag inference for richer metadata
 */
function inferTags(normName) {
  if (!classifier?.infer) return [];
  try {
    const tags = classifier.infer(normName);
    return Array.isArray(tags) ? tags.slice(0, 6) : [];
  } catch {
    return [];
  }
}

/**
 * Main: link a single ingredient
 * @param {*} ingredient { name, qty, unit, ... } or string
 * @param {*} context {
 *   targetDateRange?: { start: Date, end: Date, label: string }
 *   sabbathGuard?: boolean, pantryGuard?: boolean, store?: string,
 *   estimateQty?: number, neededQty?: number, unit?: string
 * }
 */
async function linkIngredient(ingredient, context = {}) {
  const normalized = normalizeIngredient(ingredient);
  const normName = normalized.name;

  // primary candidate from explicit map (if any)
  const exp = explicitMapCandidate(normName, context);
  const inv = inventoryCandidates(normName, normalized.qty, context);
  const grd = gardenCandidates(normName, context);
  const anl = animalCandidates(normName, context);
  const blk = bulkCandidates(normName, context);

  // Assemble all candidates
  const combined = [
    ...(exp ? [exp] : []),
    ...inv,
    ...grd,
    ...anl,
    ...blk,
  ];

  // Deduplicate by (sourceType + sourceId + supplier)
  const unique = [];
  const seen = new Set();
  for (const c of combined) {
    const key = `${c.sourceType}|${c.sourceId || ""}|${c.supplier || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  // Rank by confidence, then prefer non-bulk if tied
  unique.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const rank = { inventory: 3, garden: 2, animal: 2, bulk: 1 };
    return (rank[b.sourceType] || 0) - (rank[a.sourceType] || 0);
  });

  const primary = unique[0] || null;
  const candidates = unique.slice(1);

  const tags = inferTags(normName);

  const result = {
    name: typeof ingredient === "string" ? ingredient : (ingredient?.name || ingredient),
    normalized,
    primary,
    candidates,
    tags,
    meta: {
      aisleHint: mapAisleHint(tags, normName),
      store: context?.store || "Default",
    },
  };

  // Emit event for analytics / NBA hooks
  safeEmit("ingredient:linked", {
    ingredient: result.name,
    normalized,
    chosen: primary ? { type: primary.sourceType, id: primary.sourceId || primary.supplier } : null,
    confidence: primary?.confidence ?? 0,
    hasFallbacks: candidates.length > 0,
  });

  // sync upward (optional, non-blocking)
  safeTierSync("ingredient.linked", result);

  return result;
}

/**
 * Link a batch of ingredients.
 */
async function linkBatch(ingredients = [], context = {}) {
  const out = [];
  for (const ing of ingredients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const linked = await linkIngredient(ing, context);
      out.push(linked);
    } catch (e) {
      console.warn("[IngredientLinker] linkBatch item failed:", e);
      out.push({
        name: typeof ing === "string" ? ing : ing?.name,
        error: true,
        message: String(e?.message || e),
      });
    }
  }
  return out;
}

/* ------------------------------- Helpers ------------------------------------ */

function safeEmit(evt, payload) {
  try {
    eventBus?.emit?.(evt, payload);
  } catch (e) {
    console.warn(`[IngredientLinker] eventBus.emit("${evt}") failed`, e);
  }
}

function safeTierSync(type, payload) {
  try {
    tierSync?.publish?.(type, payload);
  } catch (_) {
    // ignore
  }
}

function mapAisleHint(tags = [], name = "") {
  const key = `${tags.join(",")} ${name}`.toLowerCase();
  if (key.includes("meat") || key.includes("lamb") || key.includes("beef") || key.includes("poultry")) return "Butchery";
  if (key.includes("produce") || key.includes("lettuce") || key.includes("greens") || key.includes("apple")) return "Produce";
  if (key.includes("grain") || key.includes("rice") || key.includes("flour") || key.includes("oat")) return "Grains";
  if (key.includes("spice") || key.includes("curry") || key.includes("masala")) return "Spices";
  if (key.includes("dairy") || key.includes("milk") || key.includes("cheese") || key.includes("yogurt")) return "Dairy";
  return "General";
}

/* ------------------------------- Exports ------------------------------------ */

module.exports = {
  linkIngredient,
  linkBatch,
  _internals: {
    normalizeIngredient,
    inventoryCandidates,
    gardenCandidates,
    animalCandidates,
    bulkCandidates,
    explicitMapCandidate,
    mapAisleHint,
    similarity,
    singularize,
  },
};
