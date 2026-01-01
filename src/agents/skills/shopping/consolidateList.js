/**
 * src/agents/skills/shopping/consolidateList.js
 *
 * How this fits:
 * - Combines:
 *    • ingredient needs (from recipes / meal plans / preservation sessions)
 *    • supply needs (from cleaning routines, storehouse shortages)
 *   into ONE shopping plan that SSA can:
 *    • show in a swap/confirm modal,
 *    • convert to a "Shopping / Errand Run" Session for SessionRunner.
 *
 * Responsibilities:
 *  - Merge “needs” from multiple domains by normalized key (name + unit).
 *  - Adjust by current inventory (if inventory.lookup skill is available).
 *  - Group by domain, store, and category to support UX and route planning.
 *  - Emit shopping.list.consolidated.* events for automation and analytics.
 *
 * This file does NOT implement UI.
 * The swap/confirm modal should:
 *  - Take the consolidated plan,
 *  - Allow toggling items on/off, editing quantities / stores,
 *  - Then build a shopping Session via buildShoppingSteps(plan,...)
 *  - SessionRunner will keep running in the background across navigation.
 */

import { emit } from "@/services/eventBus";

/* -------------------------------------------------------------------------- */
/*                    Optional inventory.lookup skill hook                    */
/* -------------------------------------------------------------------------- */

let _inventoryLookupModPromise = null;

/**
 * Soft import of inventory/lookup skill, if present.
 * Expected shape:
 *   default or named:
 *     - fastInventoryLookup
 *     - lookupMany
 *
 * @returns {Promise<any|null>}
 */
async function getInventoryLookup() {
  if (_inventoryLookupModPromise) return _inventoryLookupModPromise;

  _inventoryLookupModPromise = (async () => {
    const candidates = [
      "@/agents/skills/inventory/lookup",
      "@/agents/skills/inventory/Lookup",
    ];

    for (const path of candidates) {
      try {
        const mod = await import(/* @vite-ignore */ path);
        return mod?.default || mod;
      } catch {
        // keep trying
      }
    }

    console.warn("[shopping.consolidateList] inventory.lookup not found; proceeding without on-hand adjustments.");
    return null;
  })();

  return _inventoryLookupModPromise;
}

/* -------------------------------------------------------------------------- */
/*                              Types (JSDoc only)                            */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} NeedItem
 * @property {string} id                 - unique-ish id from upstream (recipe step, cleaning routine, etc.)
 * @property {string} name               - human-friendly name (e.g. "All-purpose flour", "Glass cleaner")
 * @property {number} quantity           - quantity required (pre-merge)
 * @property {string} unit               - unit (e.g. "g", "kg", "lb", "cup", "bottle", "pack")
 * @property {string} [domain]           - "cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"
 * @property {string} [category]         - "produce"|"meat"|"dairy"|"pantry"|"cleaning"|"paper"|"other"
 * @property {string} [storeHint]        - suggested store (e.g. "Walmart", "Costco", "LocalButcher")
 * @property {string} [note]             - freeform note
 * @property {string[]} [tags]           - arbitrary labels ("organic", "bulk", "couponCandidate")
 * @property {any} [meta]                - domain-specific metadata
 */

/**
 * @typedef {Object} ConsolidatedItem
 * @property {string} id                  - generated consolidated id
 * @property {string} name
 * @property {number} totalNeededQty      - total needed before inventory
 * @property {number} onHandQty           - from inventory, if lookup available
 * @property {number} toBuyQty            - max(totalNeededQty - onHandQty, 0)
 * @property {string} unit
 * @property {string[]} domains           - merged domains contributing to this item
 * @property {string} category
 * @property {string[]} storeHints        - merged store hints
 * @property {string[]} tags              - merged tags
 * @property {NeedItem[]} sources         - raw needs that rolled into this line
 * @property {string[]} reasons           - human-readable reasons / usage notes
 */

/**
 * @typedef {Object} ShoppingPlan
 * @property {ConsolidatedItem[]} items
 * @property {{
 *   byStore: Record<string, ConsolidatedItem[]>,
 *   byCategory: Record<string, ConsolidatedItem[]>,
 *   byDomain: Record<string, ConsolidatedItem[]>,
 * }} groups
 * @property {any} [meta]
 */

/* -------------------------------------------------------------------------- */
/*                               Public API                                   */
/* -------------------------------------------------------------------------- */

/**
 * Consolidate ingredient and supply needs into an inventory-aware shopping plan.
 *
 * @param {NeedItem[]} ingredientNeeds
 * @param {NeedItem[]} supplyNeeds
 * @param {{
 *   normalizeUnits?: boolean,
 *   ignoreZeroOrNegative?: boolean,
 *   inventoryAware?: boolean,
 *   domainFilter?: string[],        // limit to certain domains
 *   maxItems?: number,              // trim after consolidation
 * }} [options]
 * @returns {Promise<ShoppingPlan>}
 */
export async function consolidateShoppingList(
  ingredientNeeds = [],
  supplyNeeds = [],
  options = {}
) {
  const {
    normalizeUnits = true,
    ignoreZeroOrNegative = true,
    inventoryAware = true,
    domainFilter,
    maxItems,
  } = options;

  try {
    const allNeeds = [
      ...(Array.isArray(ingredientNeeds) ? ingredientNeeds : []),
      ...(Array.isArray(supplyNeeds) ? supplyNeeds : []),
    ].filter(Boolean);

    if (!allNeeds.length) {
      emitSafe("shopping.list.consolidated.empty", {
        ingredientCount: ingredientNeeds.length || 0,
        supplyCount: supplyNeeds.length || 0,
      });

      return {
        items: [],
        groups: { byStore: {}, byCategory: {}, byDomain: {} },
        meta: { sourceCounts: { ingredient: ingredientNeeds.length || 0, supply: supplyNeeds.length || 0 } },
      };
    }

    // Optional domain filter
    const filteredNeeds = domainFilter && domainFilter.length
      ? allNeeds.filter((n) => !n.domain || domainFilter.includes(n.domain))
      : allNeeds;

    // Normalize & consolidate
    const normalizedNeeds = normalizeUnits
      ? filteredNeeds.map(normalizeNeedItem)
      : filteredNeeds.map(safeNeedCopy);

    const consolidatedMap = new Map(); // key -> ConsolidatedItem

    for (const need of normalizedNeeds) {
      if (!need || !need.name) continue;

      const qty = safeNumber(need.quantity);
      if (ignoreZeroOrNegative && qty <= 0) continue;

      const key = makeConsolidationKey(need);
      let existing = consolidatedMap.get(key);

      if (!existing) {
        existing = {
          id: makeId("shopitem"),
          name: need.name,
          totalNeededQty: 0,
          onHandQty: 0,
          toBuyQty: 0,
          unit: need.unit || "",
          domains: [],
          category: need.category || inferCategoryFromName(need),
          storeHints: [],
          tags: [],
          sources: [],
          reasons: [],
        };
        consolidatedMap.set(key, existing);
      }

      existing.totalNeededQty += qty;
      existing.sources.push(need);

      if (need.domain && !existing.domains.includes(need.domain)) {
        existing.domains.push(need.domain);
      }

      if (need.storeHint && !existing.storeHints.includes(need.storeHint)) {
        existing.storeHints.push(need.storeHint);
      }

      if (Array.isArray(need.tags)) {
        for (const tag of need.tags) {
          if (!existing.tags.includes(tag)) {
            existing.tags.push(tag);
          }
        }
      }

      if (need.note) {
        existing.reasons.push(need.note);
      }
    }

    let consolidatedItems = Array.from(consolidatedMap.values());

    // Optional inventory-aware adjustment
    if (inventoryAware && consolidatedItems.length) {
      consolidatedItems = await applyInventoryAdjustments(consolidatedItems);
    } else {
      // fallback: toBuyQty = totalNeededQty
      for (const item of consolidatedItems) {
        item.onHandQty = item.onHandQty || 0;
        item.toBuyQty = Math.max(0, item.totalNeededQty - item.onHandQty);
      }
    }

    // Filter out items where toBuyQty <= 0
    consolidatedItems = consolidatedItems.filter((item) => item.toBuyQty > 0);

    // Optional item cap
    if (typeof maxItems === "number" && maxItems > 0 && consolidatedItems.length > maxItems) {
      consolidatedItems = consolidatedItems.slice(0, maxItems);
    }

    const groups = groupItems(consolidatedItems);

    const plan = {
      items: consolidatedItems,
      groups,
      meta: {
        createdAt: new Date().toISOString(),
        inventoryAware: !!inventoryAware,
        sourceCounts: {
          ingredient: ingredientNeeds.length || 0,
          supply: supplyNeeds.length || 0,
        },
      },
    };

    emitSafe("shopping.list.consolidated.completed", {
      totalNeeds: allNeeds.length,
      consolidatedCount: consolidatedItems.length,
      inventoryAware: !!inventoryAware,
    });

    return plan;
  } catch (err) {
    console.warn("[shopping.consolidateList] consolidation failed:", err);
    emitSafe("shopping.list.consolidated.failed", {
      error: String(err),
    });

    return {
      items: [],
      groups: { byStore: {}, byCategory: {}, byDomain: {} },
      meta: { error: String(err) },
    };
  }
}

/**
 * Build Session-ready steps from a ShoppingPlan.
 * Each step is a high-level chunk (usually by store).
 *
 * @param {ShoppingPlan} plan
 * @param {{
 *   chunkBy?: "store"|"category"|"domain"|"all",
 *   defaultDurationSec?: number,
 *   domainHint?: "shopping"|"storehouse"|"preservation",
 * }} [options]
 * @returns {Array<{
 *   id:string,
 *   title:string,
 *   desc:string,
 *   durationSec:number,
 *   blockers:string[],
 *   metadata:any
 * }>}
 */
export function buildShoppingSteps(plan, options = {}) {
  const {
    chunkBy = "store",
    defaultDurationSec = 300,
    domainHint = "shopping",
  } = options;

  if (!plan || !Array.isArray(plan.items)) return [];

  const steps = [];

  if (chunkBy === "all") {
    // Single mega-step
    const summary = summarizeItems(plan.items);
    steps.push({
      id: makeId("shopstep"),
      title: "Complete Shopping Run",
      desc: summary,
      durationSec: defaultDurationSec * Math.max(1, Math.ceil(plan.items.length / 10)),
      blockers: ["inventory", "weather", "quietHours", "sabbath"],
      metadata: {
        type: "shoppingRun",
        domainHint,
        chunkBy: "all",
        itemCount: plan.items.length,
        items: plan.items,
      },
    });
  } else if (chunkBy === "store") {
    const entries = Object.entries(plan.groups.byStore);
    if (!entries.length) {
      // fallback to "all"
      return buildShoppingSteps(plan, { ...options, chunkBy: "all" });
    }

    for (const [store, items] of entries) {
      const label = store === "_default" ? "General" : store;
      const summary = summarizeItems(items);

      steps.push({
        id: makeId("shopstep"),
        title: `Shop at ${label}`,
        desc: summary,
        durationSec: defaultDurationSec * Math.max(1, Math.ceil(items.length / 10)),
        blockers: ["inventory", "weather", "quietHours", "sabbath"],
        metadata: {
          type: "shoppingStoreChunk",
          domainHint,
          store: label,
          itemCount: items.length,
          items,
        },
      });
    }
  } else if (chunkBy === "category") {
    const entries = Object.entries(plan.groups.byCategory);
    for (const [category, items] of entries) {
      const label = category || "Misc";
      const summary = summarizeItems(items);

      steps.push({
        id: makeId("shopstep"),
        title: `Shopping: ${label}`,
        desc: summary,
        durationSec: defaultDurationSec * Math.max(1, Math.ceil(items.length / 10)),
        blockers: ["inventory", "weather", "quietHours", "sabbath"],
        metadata: {
          type: "shoppingCategoryChunk",
          domainHint,
          category: label,
          itemCount: items.length,
          items,
        },
      });
    }
  } else if (chunkBy === "domain") {
    const entries = Object.entries(plan.groups.byDomain);
    for (const [domain, items] of entries) {
      const label = domain || "General";
      const summary = summarizeItems(items);

      steps.push({
        id: makeId("shopstep"),
        title: `Shopping for ${label}`,
        desc: summary,
        durationSec: defaultDurationSec * Math.max(1, Math.ceil(items.length / 10)),
        blockers: ["inventory", "weather", "quietHours", "sabbath"],
        metadata: {
          type: "shoppingDomainChunk",
          domainHint,
          logicalDomain: label,
          itemCount: items.length,
          items,
        },
      });
    }
  }

  emitSafe("shopping.list.steps.prepared", {
    count: steps.length,
    chunkBy,
  });

  return steps;
}

/**
 * Helper used by the domain page CTA:
 *   - consolidate lists
 *   - build steps
 *   - back to caller to wrap in a Session object and run.
 *
 * @param {NeedItem[]} ingredientNeeds
 * @param {NeedItem[]} supplyNeeds
 * @param {any} consolidateOptions
 * @param {any} stepOptions
 * @returns {Promise<{ plan:ShoppingPlan, steps:any[] }>}
 */
export async function consolidateAndBuildShoppingSession(
  ingredientNeeds,
  supplyNeeds,
  consolidateOptions = {},
  stepOptions = {}
) {
  const plan = await consolidateShoppingList(ingredientNeeds, supplyNeeds, consolidateOptions);
  const steps = buildShoppingSteps(plan, stepOptions);
  return { plan, steps };
}

/* -------------------------------------------------------------------------- */
/*                         Inventory adjustment helpers                       */
/* -------------------------------------------------------------------------- */

/**
 * Try to apply inventory on-hand quantities to consolidated items.
 *
 * @param {ConsolidatedItem[]} items
 * @returns {Promise<ConsolidatedItem[]>}
 */
async function applyInventoryAdjustments(items) {
  const lookupMod = await getInventoryLookup();
  if (!lookupMod) {
    // No inventory lookup, just set toBuy = totalNeed
    for (const item of items) {
      item.onHandQty = 0;
      item.toBuyQty = Math.max(0, item.totalNeededQty);
    }
    return items;
  }

  const lookupFn =
    lookupMod.lookupMany ||
    lookupMod.fastInventoryLookup ||
    lookupMod.default ||
    null;

  if (typeof lookupFn !== "function") {
    console.warn("[shopping.consolidateList] inventory lookup module missing lookupMany/fastInventoryLookup.");
    for (const item of items) {
      item.onHandQty = 0;
      item.toBuyQty = Math.max(0, item.totalNeededQty);
    }
    return items;
  }

  try {
    // Build query payload from consolidated items
    const queries = items.map((item) => ({
      name: item.name,
      unit: item.unit,
      category: item.category,
    }));

    const lookupResult = await lookupFn(queries);
    const byNameUnit = Array.isArray(lookupResult)
      ? indexByNameAndUnit(lookupResult)
      : {};

    for (const item of items) {
      const key = makeNameUnitKey(item.name, item.unit);
      const inv = byNameUnit[key];

      const onHand = safeNumber(inv?.quantity ?? inv?.qty ?? 0);
      item.onHandQty = onHand;
      item.toBuyQty = Math.max(0, item.totalNeededQty - onHand);

      if (onHand > 0) {
        item.reasons.push(`Inventory: ${onHand} ${item.unit || ""} on hand`);
      } else {
        item.reasons.push("Inventory: none on hand");
      }
    }
  } catch (err) {
    console.warn("[shopping.consolidateList] inventory-aware adjustment failed:", err);
    for (const item of items) {
      item.onHandQty = item.onHandQty || 0;
      item.toBuyQty = Math.max(0, item.totalNeededQty - item.onHandQty);
    }
  }

  return items;
}

/* -------------------------------------------------------------------------- */
/*                        Normalization & grouping helpers                    */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a NeedItem (mostly for units & name).
 * NOTE: This is intentionally light; full unit conversion should live
 *       in a dedicated units utility if you already have one in SSA.
 *
 * @param {NeedItem} need
 * @returns {NeedItem}
 */
function normalizeNeedItem(need) {
  const copy = safeNeedCopy(need);
  copy.name = titleCase(String(copy.name || "").trim());
  copy.unit = normalizeUnitToken(copy.unit || "");
  copy.quantity = safeNumber(copy.quantity);

  return copy;
}

/**
 * Shallow copy with safe defaults.
 * @param {NeedItem} need
 * @returns {NeedItem}
 */
function safeNeedCopy(need) {
  return {
    id: String(need.id || makeId("need")),
    name: String(need.name || "").trim(),
    quantity: safeNumber(need.quantity),
    unit: need.unit || "",
    domain: need.domain || "",
    category: need.category || "",
    storeHint: need.storeHint || "",
    note: need.note || "",
    tags: Array.isArray(need.tags) ? [...need.tags] : [],
    meta: need.meta ?? null,
  };
}

/**
 * Create a consolidation key from name + unit (and possibly category).
 * @param {NeedItem} need
 * @returns {string}
 */
function makeConsolidationKey(need) {
  const name = String(need.name || "").toLowerCase().trim();
  const unit = String(need.unit || "").toLowerCase().trim();
  const category = String(need.category || "").toLowerCase().trim();
  return `${name}::${unit}::${category}`;
}

/**
 * Infer category from name when missing.
 * @param {NeedItem} need
 * @returns {string}
 */
function inferCategoryFromName(need) {
  const n = String(need.name || "").toLowerCase();

  if (/lettuce|spinach|greens|apple|banana|tomato|onion|carrot|pepper|fruit|vegetable/.test(n)) {
    return "produce";
  }
  if (/beef|chicken|pork|lamb|goat|duck|turkey|sausage|fish/.test(n)) {
    return "meat";
  }
  if (/milk|cream|cheese|yogurt|butter/.test(n)) {
    return "dairy";
  }
  if (/flour|rice|beans|pasta|grain|cornmeal|oat/.test(n)) {
    return "pantry";
  }
  if (/cleaner|detergent|bleach|soap|sanitizer|disinfectant/.test(n)) {
    return "cleaning";
  }
  if (/paper towel|toilet paper|tissue|napkin/.test(n)) {
    return "paper";
  }
  return "other";
}

/**
 * Simple unit normalization, intentionally conservative.
 *
 * @param {string} unit
 * @returns {string}
 */
function normalizeUnitToken(unit) {
  const u = String(unit || "").toLowerCase().trim();

  if (!u) return "";

  if (["g", "gram", "grams"].includes(u)) return "g";
  if (["kg", "kilogram", "kilograms"].includes(u)) return "kg";
  if (["lb", "lbs", "pound", "pounds"].includes(u)) return "lb";
  if (["oz", "ounce", "ounces"].includes(u)) return "oz";

  if (["cup", "cups"].includes(u)) return "cup";
  if (["tbsp", "tablespoon", "tablespoons"].includes(u)) return "tbsp";
  if (["tsp", "teaspoon", "teaspoons"].includes(u)) return "tsp";

  if (["bottle", "bottles"].includes(u)) return "bottle";
  if (["pack", "packs", "package"].includes(u)) return "pack";

  return u; // fallback: keep as-is
}

/**
 * Build store/category/domain groupings.
 *
 * @param {ConsolidatedItem[]} items
 */
function groupItems(items) {
  /** @type {Record<string, ConsolidatedItem[]>} */
  const byStore = {};
  /** @type {Record<string, ConsolidatedItem[]>} */
  const byCategory = {};
  /** @type {Record<string, ConsolidatedItem[]>} */
  const byDomain = {};

  for (const item of items) {
    const stores = item.storeHints && item.storeHints.length ? item.storeHints : ["_default"];
    for (const store of stores) {
      const key = store || "_default";
      if (!byStore[key]) byStore[key] = [];
      byStore[key].push(item);
    }

    const categoryKey = item.category || "other";
    if (!byCategory[categoryKey]) byCategory[categoryKey] = [];
    byCategory[categoryKey].push(item);

    const domains = item.domains && item.domains.length ? item.domains : ["general"];
    for (const d of domains) {
      const dk = d || "general";
      if (!byDomain[dk]) byDomain[dk] = [];
      byDomain[dk].push(item);
    }
  }

  return { byStore, byCategory, byDomain };
}

/**
 * Summarize items list for step description.
 *
 * @param {ConsolidatedItem[]} items
 * @returns {string}
 */
function summarizeItems(items) {
  if (!items || !items.length) return "No items to purchase.";

  // Show up to 6 items by name, with "and X more" for the rest.
  const names = items.map((i) => i.name);
  const preview = names.slice(0, 6).join(", ");
  const remaining = Math.max(0, names.length - 6);

  let summary = `Items: ${preview}`;
  if (remaining > 0) {
    summary += `, and ${remaining} more.`;
  }

  return summary;
}

/* -------------------------------------------------------------------------- */
/*                                   Events                                   */
/* -------------------------------------------------------------------------- */

function emitSafe(type, data) {
  try {
    emit?.({
      type,
      ts: new Date().toISOString(),
      source: "shopping.consolidateList",
      data,
    });
  } catch {
    // ignore
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Utils                                    */
/* -------------------------------------------------------------------------- */

/**
 * Robust numeric coercion.
 * @param {any} v
 * @returns {number}
 */
function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Generate id; prefer crypto.randomUUID if present.
 * @param {string} prefix
 * @returns {string}
 */
function makeId(prefix = "id") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

/**
 * Index inventory lookup results by name+unit key.
 *
 * Expected inventory row shape:
 *  { name, quantity, unit, ... }
 *
 * @param {any[]} rows
 */
function indexByNameAndUnit(rows) {
  const map = {};
  for (const row of rows || []) {
    const key = makeNameUnitKey(row.name, row.unit);
    if (!map[key]) map[key] = row;
  }
  return map;
}

/**
 * Key from name+unit for inventory map.
 * @param {string} name
 * @param {string} unit
 * @returns {string}
 */
function makeNameUnitKey(name, unit) {
  return `${String(name || "").toLowerCase().trim()}::${String(unit || "").toLowerCase().trim()}`;
}

/**
 * Title-case helper (for nicer display / more stable keys).
 * @param {string} s
 * @returns {string}
 */
function titleCase(s) {
  return s
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/* -------------------------------------------------------------------------- */
/*                               Default export                               */
/* -------------------------------------------------------------------------- */

export default {
  consolidateShoppingList,
  buildShoppingSteps,
  consolidateAndBuildShoppingSession,
};
