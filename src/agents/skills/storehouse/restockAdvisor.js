/**
 * src/agents/skills/storehouse/restockAdvisor.js
 *
 * How this fits:
 * - This skill answers: "What should we restock next, and how urgent is it?"
 * - It:
 *   • reads inventory (via Dexie, soft-wired),
 *   • optionally consults shortageDetect (if present),
 *   • scores items by restock priority (critical / soon / opportunistic),
 *   • emits storehouse.restock.* events for automation/analytics,
 *   • returns recommendations ready to be turned into Session steps.
 *
 * Intended consumers:
 *   - Storehouse page:
 *       • "Restock Now" CTA → use scanAndBuildRestock to get priority items
 *         and open a swap/confirm modal while a shopping/preservation
 *         SessionRunner runs in the background.
 *   - Automation runtime:
 *       • scheduled job (daily/weekly) → analyzeRestockNeeds → suggest tasks.
 *
 * Events emitted:
 *   - storehouse.restock.analysis.completed
 *   - storehouse.restock.analysis.failed
 *   - storehouse.restock.steps.prepared
 *
 * SessionRunner:
 *   - Steps from buildRestockSteps() follow the Session step contract:
 *       { id, title, desc, durationSec, blockers, metadata }
 *   - Domain usually "storehouse" or "preservation" (for bulk staples).
 *
 * Extension points:
 *   - registerPriorityRule(pattern, fn)
 *       pattern: RegExp matching item name/tags
 *       fn(item, ctx) => numeric delta to priorityScore
 *         ctx: { currentQty, targetQty, neededQty, baseScore }
 */

import { emit } from "@/services/eventBus";

/* -------------------------------------------------------------------------- */
/*                         Optional shortageDetect hook                       */
/* -------------------------------------------------------------------------- */

let _shortageDetectModPromise = null;

/**
 * Soft import of inventory/shortageDetect, if present.
 * @returns {Promise<any|null>}
 */
async function getShortageDetect() {
  if (_shortageDetectModPromise) return _shortageDetectModPromise;

  _shortageDetectModPromise = (async () => {
    const candidates = [
      "@/agents/skills/inventory/shortageDetect",
      "@/agents/skills/inventory/shortagedetect",
    ];

    for (const path of candidates) {
      try {
        const mod = await import(/* @vite-ignore */ path);
        return mod?.default || mod;
      } catch {
        // keep trying
      }
    }

    return null;
  })();

  return _shortageDetectModPromise;
}

/* -------------------------------------------------------------------------- */
/*                              Dexie DB soft import                          */
/* -------------------------------------------------------------------------- */

let _dbPromise = null;

/**
 * Try to import Dexie DB from common paths.
 * @returns {Promise<any|null>}
 */
async function getDb() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    const candidates = [
      "@/services/db",
      "@/db",
      "@/data/db",
    ];

    for (const path of candidates) {
      try {
        const mod = await import(/* @vite-ignore */ path);
        const db = mod?.default || mod?.db || mod;
        if (db && typeof db === "object") return db;
      } catch {
        // keep trying
      }
    }

    console.warn("[storehouse.restockAdvisor] Dexie DB not found.");
    return null;
  })();

  return _dbPromise;
}

/**
 * Try to locate the main inventory table.
 *
 * Expected columns (loosely):
 *   id: string
 *   name: string
 *   quantity: number
 *   unit: string
 *   domain?: string
 *   location?: string
 *   minQty?: number
 *   targetQty?: number
 *   dailyUseRate?: number  // units per day
 *   lastUsedAt?: string    // ISO
 *   category?: string      // pantry / produce / meat / cleaning / etc.
 *
 * @returns {Promise<any|null>}
 */
async function getInventoryTable() {
  const db = await getDb();
  if (!db) return null;

  const candidates = [db.inventory, db.storehouseItems, db.items];
  for (const t of candidates) {
    if (t && typeof t.where === "function") return t;
  }

  if (Array.isArray(db.tables)) {
    const table = db.tables.find((t) =>
      /inventory|storehouse|items?/i.test(t.name || "")
    );
    if (table) return table;
  }

  console.warn("[storehouse.restockAdvisor] No inventory-like table found.");
  return null;
}

/* -------------------------------------------------------------------------- */
/*                          Priority rules registry                           */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} RestockRecommendation
 * @property {any} item
 * @property {number} currentQty
 * @property {number} targetQty
 * @property {number} neededQty
 * @property {number} priorityScore
 * @property {"critical"|"soon"|"opportunistic"|"skip"} priorityBand
 * @property {string[]} reasons
 */

/** @type {Array<{ pattern:RegExp, rule:(item:any, ctx:{
 *   currentQty:number,
 *   targetQty:number,
 *   neededQty:number,
 *   baseScore:number
 * }) => number }>} */
const PRIORITY_RULES = [];

/**
 * Register a restock priority rule.
 *
 * Example:
 *   registerPriorityRule(/flour|rice|beans/i, (item, ctx) => {
 *     // pantry staples get a bump
 *     return 10;
 *   });
 *
 * @param {RegExp} pattern
 * @param {(item:any, ctx:{ currentQty:number, targetQty:number, neededQty:number, baseScore:number }) => number} rule
 */
export function registerPriorityRule(pattern, rule) {
  if (!(pattern instanceof RegExp)) return;
  if (typeof rule !== "function") return;
  PRIORITY_RULES.push({ pattern, rule });
}

/* Seed: simple staples priority bump */
registerPriorityRule(/flour|rice|bean(s)?|lentil(s)?|oil|salt|sugar|yeast/i, () => 15);

/* -------------------------------------------------------------------------- */
/*                               Public API                                   */
/* -------------------------------------------------------------------------- */

/**
 * Analyze restock needs based on inventory.
 *
 * @param {{
 *   domain?: string,             // filter inventory by domain
 *   location?: string,           // filter by location/zone
 *   daysAhead?: number,          // coverage window; default 7 days
 *   includeZeroOnly?: boolean,   // if true, only items with zero stock are considered
 *   includeCleaning?: boolean,   // whether to include cleaning / non-food items
 *   consultShortageDetect?: boolean, // if true, call shortageDetect for extra hints
 *   limit?: number,              // max items to process
 * }} [options]
 *
 * @returns {Promise<{
 *   recommendations: RestockRecommendation[],
 *   scanned: number
 * }>}
 */
export async function analyzeRestockNeeds(options = {}) {
  const {
    domain,
    location,
    daysAhead = 7,
    includeZeroOnly = false,
    includeCleaning = true,
    consultShortageDetect = true,
    limit,
  } = options;

  const invTable = await getInventoryTable();
  if (!invTable) {
    emitAnalysisFailed("NO_INVENTORY_TABLE");
    return { recommendations: [], scanned: 0 };
  }

  let rows = [];
  try {
    if (domain && typeof invTable.where === "function") {
      rows = await invTable.where("domain").equals(domain).toArray();
    } else {
      rows = await invTable.toArray();
    }

    if (location) {
      rows = rows.filter((r) => (r.location || r.zone) === location);
    }

    if (typeof limit === "number" && limit > 0 && rows.length > limit) {
      rows = rows.slice(0, limit);
    }
  } catch (err) {
    console.warn("[storehouse.restockAdvisor] error reading inventory:", err);
    emitAnalysisFailed("DB_ERROR", String(err));
    return { recommendations: [], scanned: 0 };
  }

  // Optionally consult shortageDetect for explicit shortage hints
  let shortageHintsById = {};
  if (consultShortageDetect) {
    try {
      const shortageDetect = await getShortageDetect();
      if (shortageDetect && typeof shortageDetect.detectShortages === "function") {
        const res = await shortageDetect.detectShortages(rows, { domain });
        if (res && Array.isArray(res.shortages)) {
          shortageHintsById = res.shortages.reduce((acc, s) => {
            if (s.item && s.item.id) {
              acc[s.item.id] = s;
            }
            return acc;
          }, {});
        }
      }
    } catch (err) {
      console.warn("[storehouse.restockAdvisor] shortageDetect consult failed:", err);
    }
  }

  /** @type {RestockRecommendation[]} */
  const recommendations = [];

  for (const item of rows) {
    if (!item) continue;

    // Basic cleaning / non-food filtering
    if (!includeCleaning && isCleaningCategory(item)) {
      continue;
    }

    const rec = scoreItemRestockNeed(item, {
      daysAhead,
      includeZeroOnly,
      shortageHint: shortageHintsById[item.id] || null,
    });

    if (!rec || rec.priorityBand === "skip" || rec.neededQty <= 0) {
      continue;
    }

    recommendations.push(rec);
  }

  // Sort highest priority first
  recommendations.sort((a, b) => b.priorityScore - a.priorityScore);

  emitSafe("storehouse.restock.analysis.completed", {
    scanned: rows.length,
    recommended: recommendations.length,
    domain: domain || null,
    location: location || null,
    daysAhead,
  });

  return { recommendations, scanned: rows.length };
}

/**
 * Build Session-ready steps from restock recommendations.
 *
 * @param {RestockRecommendation[]} recommendations
 * @param {{
 *   defaultDurationSec?: number,
 *   domainHint?: "storehouse"|"preservation"|"shopping",
 *   labelPrefix?: string,
 * }} [options]
 *
 * @returns {Array<{
 *   id:string,
 *   title:string,
 *   desc:string,
 *   durationSec:number,
 *   blockers:string[],
 *   metadata:any
 * }>}
 */
export function buildRestockSteps(recommendations = [], options = {}) {
  const {
    defaultDurationSec = 120,
    domainHint = "shopping",
    labelPrefix = "Restock",
  } = options;

  const steps = recommendations.map((rec) => {
    const { item, neededQty, currentQty, targetQty, priorityBand, priorityScore, reasons } = rec;
    const name = item?.name || item?.label || "Item";
    const unit = item?.unit || "";
    const qtyLabel = neededQty > 0 ? `${neededQty} ${unit}`.trim() : "Check on-hand stock";

    const title = `${labelPrefix} ${name}`;
    const descParts = [
      `Needed: ${qtyLabel}.`,
      `Current: ${currentQty} ${unit}`.trim(),
      `Target: ${targetQty} ${unit}`.trim(),
      `Priority: ${priorityBand} (score ${priorityScore}).`,
      reasons.length ? `Reasons: ${reasons.join("; ")}` : "",
    ];

    return {
      id: makeId(),
      title,
      desc: descParts.filter(Boolean).join(" "),
      durationSec: defaultDurationSec,
      blockers: ["inventory", "quietHours", "weather"], // may involve driving / ordering / bulk handling
      metadata: {
        type: "restock",
        domainHint,
        itemId: item?.id || null,
        name,
        neededQty,
        currentQty,
        targetQty,
        unit,
        priorityBand,
        priorityScore,
        reasons,
      },
    };
  });

  emitSafe("storehouse.restock.steps.prepared", {
    count: steps.length,
    domainHint,
  });

  return steps;
}

/**
 * Convenience helper:
 *   - analyze restock needs
 *   - then build session-ready steps.
 *
 * @param {any} analysisOptions
 * @param {any} stepOptions
 * @returns {Promise<{ recommendations:RestockRecommendation[], steps:any[], scanned:number }>}
 */
export async function scanAndBuildRestock(analysisOptions = {}, stepOptions = {}) {
  const { recommendations, scanned } = await analyzeRestockNeeds(analysisOptions);
  const steps = buildRestockSteps(recommendations, stepOptions);
  return { recommendations, steps, scanned };
}

/* -------------------------------------------------------------------------- */
/*                          Item scoring + helpers                            */
/* -------------------------------------------------------------------------- */

/**
 * Score a single item's restock need.
 *
 * @param {any} item
 * @param {{
 *   daysAhead:number,
 *   includeZeroOnly:boolean,
 *   shortageHint:any|null
 * }} ctx
 * @returns {RestockRecommendation|null}
 */
function scoreItemRestockNeed(item, ctx) {
  const { daysAhead, includeZeroOnly, shortageHint } = ctx;

  const name = String(item.name || item.label || "").trim();
  const unit = item.unit || "";
  const currentQty = safeNumber(item.quantity ?? item.qty ?? 0) || 0;
  const category = (item.category || "").toLowerCase();

  // Items explicitly marked non-stock or one-off purchases can be skipped
  if (item.noRestock === true || item.nonStock === true) {
    return null;
  }

  // Base coverage assumptions
  const dailyUseRate = inferDailyUseRate(item, category);
  const coverageDays = dailyUseRate > 0 ? currentQty / dailyUseRate : Infinity;

  // Targets
  const targetCoverageDays = inferTargetCoverageDays(item, category);
  const targetQtyFromCoverage = Number.isFinite(dailyUseRate)
    ? dailyUseRate * targetCoverageDays
    : currentQty; // fallback

  const minQty = safeNumber(item.minQty);
  const targetQty = Math.max(
    safeNumber(item.targetQty) || 0,
    targetQtyFromCoverage,
    minQty || 0
  );

  const neededQty = Math.max(0, Math.ceil(targetQty - currentQty));

  if (includeZeroOnly && currentQty > 0) {
    return null;
  }

  // If nothing needed, bail early
  if (neededQty <= 0) {
    return null;
  }

  const reasons = [];
  let baseScore = 0;

  // Reason 1: below min / target
  if (minQty != null && currentQty < minQty) {
    baseScore += 30;
    reasons.push(`Below minimum stock (${currentQty} < ${minQty} ${unit})`);
  } else if (currentQty < targetQty) {
    baseScore += 10;
    reasons.push(`Below target stock (${currentQty} < ${targetQty} ${unit})`);
  }

  // Reason 2: coverage vs daysAhead
  if (Number.isFinite(coverageDays)) {
    if (coverageDays < 0.5) {
      baseScore += 40;
      reasons.push("Almost no coverage left");
    } else if (coverageDays < 1) {
      baseScore += 30;
      reasons.push("Less than 1 day of coverage");
    } else if (coverageDays < daysAhead) {
      baseScore += 15;
      reasons.push(`Coverage (${coverageDays.toFixed(1)} days) is less than planning window (${daysAhead} days)`);
    }
  }

  // Reason 3: perishability (we want enough but not absurd quantity)
  const perishabilityFactor = inferPerishabilityFactor(item, category);
  if (perishabilityFactor > 1) {
    baseScore += perishabilityFactor * 5;
    reasons.push("High-impact staple / frequently used");
  }

  // Reason 4: shortage hint from shortageDetect (if available)
  if (shortageHint && shortageHint.severity) {
    const sev = shortageHint.severity; // e.g. "critical"|"warning" etc.
    if (sev === "critical") {
      baseScore += 40;
      reasons.push("ShortageDetect: critical shortage");
    } else if (sev === "warning") {
      baseScore += 20;
      reasons.push("ShortageDetect: low stock warning");
    } else {
      baseScore += 10;
      reasons.push("ShortageDetect: suggested restock");
    }
  }

  // Apply custom PRIORITY_RULES
  const ctxForRules = { currentQty, targetQty, neededQty, baseScore };
  for (const { pattern, rule } of PRIORITY_RULES) {
    if (pattern.test(name)) {
      try {
        const delta = Number(rule(item, ctxForRules) || 0);
        if (delta !== 0) {
          baseScore += delta;
          reasons.push(`Rule matched ${pattern.toString()} (Δ${delta})`);
        }
      } catch (err) {
        console.warn("[storehouse.restockAdvisor] priority rule error:", err);
      }
    }
  }

  // Priority band
  const priorityBand = classifyPriorityBand(baseScore);

  // If band is "skip" (very low score), ignore it
  if (priorityBand === "skip") {
    return null;
  }

  return {
    item,
    currentQty,
    targetQty,
    neededQty,
    priorityScore: baseScore,
    priorityBand,
    reasons,
  };
}

/**
 * Classify priority band from score.
 *
 * @param {number} score
 * @returns {"critical"|"soon"|"opportunistic"|"skip"}
 */
function classifyPriorityBand(score) {
  if (score >= 60) return "critical";
  if (score >= 35) return "soon";
  if (score >= 15) return "opportunistic";
  return "skip";
}

/**
 * Infer daily use rate if not explicitly stored, based on category
 * or guess from usage hints.
 *
 * @param {any} item
 * @param {string} category
 * @returns {number}
 */
function inferDailyUseRate(item, category) {
  if (Number.isFinite(item.dailyUseRate) && item.dailyUseRate > 0) {
    return item.dailyUseRate;
  }

  const cat = category || "";
  if (/flour|rice|beans|grain|oat|pasta/i.test(item.name || "")) {
    return 0.5; // 0.5 unit/day (e.g. 1 lb every 2 days)
  }
  if (/oil|salt|sugar|yeast/i.test(item.name || "")) {
    return 0.1; // slower usage
  }
  if (/milk|cream|fresh|produce|lettuce|greens/i.test(item.name || "")) {
    return 1; // daily use, but less bulk storage
  }
  if (/cleaner|detergent|bleach|soap/i.test(item.name || "")) {
    return 0.05; // small daily fraction
  }

  // Fallback: very small usage to avoid absurd "no coverage" on stable items
  return 0.1;
}

/**
 * Estimate a target coverage window (days) based on category.
 *
 * @param {any} item
 * @param {string} category
 * @returns {number}
 */
function inferTargetCoverageDays(item, category) {
  const cat = category || "";

  if (/flour|rice|beans|grain|oat|pasta|staple/i.test(item.name || "")) {
    return 60; // 2 months
  }
  if (/canned|jarred|dehydrated|freeze-dried/i.test(item.name || "")) {
    return 90;
  }
  if (/cleaner|detergent|bleach|soap/i.test(item.name || cat)) {
    return 30;
  }
  if (/produce|fresh|greens|lettuce|milk|cream|yogurt/i.test(item.name || "")) {
    return 7;
  }

  return 30; // default 1 month
}

/**
 * Perishability factor: high for staples you really want,
 * but also consider shelf-stable vs fresh.
 *
 * @param {any} item
 * @param {string} category
 * @returns {number}
 */
function inferPerishabilityFactor(item, category) {
  const name = String(item.name || "").toLowerCase();

  // high impact staples
  if (/flour|rice|beans|grain|cornmeal|oat/i.test(name)) return 3;
  if (/salt|sugar|oil|yeast/i.test(name)) return 2.5;

  // cleaning supplies (important but not food)
  if (/cleaner|detergent|bleach|soap/i.test(name || category)) return 2;

  // fresh items (important but we don't want huge surplus)
  if (/produce|lettuce|greens|milk|cream|yogurt|cheese/i.test(name)) return 1.5;

  return 1;
}

/**
 * Rough check if this is a cleaning / non-food item.
 * @param {any} item
 * @returns {boolean}
 */
function isCleaningCategory(item) {
  const name = String(item.name || item.label || "").toLowerCase();
  const cat = String(item.category || "").toLowerCase();

  return (
    /cleaner|detergent|bleach|ammonia|disinfectant|soap|sanitizer/i.test(name) ||
    /cleaning|laundry|household/i.test(cat)
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Events                                   */
/* -------------------------------------------------------------------------- */

function emitAnalysisFailed(reason, error) {
  emitSafe("storehouse.restock.analysis.failed", {
    reason,
    error: error || null,
  });
}

function emitSafe(type, data) {
  try {
    emit?.({
      type,
      ts: new Date().toISOString(),
      source: "storehouse.restockAdvisor",
      data,
    });
  } catch {
    // ignore
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Utils                                    */
/* -------------------------------------------------------------------------- */

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Simple ID generator, prefers crypto.randomUUID.
 * @returns {string}
 */
function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `restock_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

/* -------------------------------------------------------------------------- */
/*                               Default export                               */
/* -------------------------------------------------------------------------- */

export default {
  analyzeRestockNeeds,
  buildRestockSteps,
  scanAndBuildRestock,
  registerPriorityRule,
};
