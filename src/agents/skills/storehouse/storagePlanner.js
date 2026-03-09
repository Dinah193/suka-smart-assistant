/**
 * src/agents/skills/storehouse/storagePlanner.js
 *
 * How this fits:
 * - This skill helps SSA decide:
 *   • HOW something should be stored (zone, temp, light, humidity, shelf life),
 *   • WHERE it should go in the storehouse (pantry shelf, fridge, freezer, root cellar, barn, etc.).
 *
 * - Intended consumers:
 *   • Import pipeline: when new items are added (garden harvest, bulk buys, butchered animals),
 *     call suggestStorageProfile to attach storage metadata.
 *   • Storehouse / Inventory UI: call planStorageForBatch to generate a storage plan
 *     and then create a "storehouse" session with steps like "Move 5 lbs carrots to Root Cellar".
 *   • Preservation domain: combine with inventory.shortageDetect to decide which items to can,
 *     freeze, or otherwise preserve.
 *
 * - This module is READ-ONLY regarding storehouse locations: it reads from Dexie if available,
 *   but does not mutate locations or inventory.
 *
 * Events emitted:
 *   - storehouse.storage.profile.suggested
 *   - storehouse.storage.plan.generated
 *   - storehouse.storage.plan.failed
 *
 * Extension points:
 *   - registerStorageRule(pattern, rule)
 *       pattern: RegExp matching item name or tags
 *       rule: { zone, tempRangeF, humidity, light, container, shelfLifeDays, notes, domains? }
 *   - registerLocationScorer(fn)
 *       fn(item, profile, location) => number (higher is better)
 *
 * NOTE: SessionRunner & swap modals:
 *   - The output of planStorageForBatch is primed for a "swap / confirm" modal in the
 *     storehouse UI where users can confirm or tweak suggested locations while a
 *     storehouse session runs in the background.
 */

import { emit } from "@/services/events/eventBus";

/* -------------------------- Storage rule registry -------------------------- */

/**
 * @typedef {Object} StorageRule
 * @property {"ambient"|"cool"|"cold"|"frozen"|"cellar"|"outdoor"|"garage"|"barn"|"cleaning"} zone
 * @property {[number, number]} [tempRangeF]       // [min, max] °F
 * @property {string} [humidity]                  // "low"|"moderate"|"high"
 * @property {string} [light]                     // "dark"|"indirect"|"ok"
 * @property {string} [container]                 // "airtight"|"paper-bag"|"crate"|"jar"|"bag"
 * @property {number} [shelfLifeDays]            // expected shelf life under ideal conditions
 * @property {string} [notes]
 * @property {string[]} [domains]                // restrict to domains, e.g. ["garden","storehouse"]
 */

/**
 * @typedef {Object} StorageProfile
 * @property {"ambient"|"cool"|"cold"|"frozen"|"cellar"|"outdoor"|"garage"|"barn"|"cleaning"} zone
 * @property {[number, number]|null} tempRangeF
 * @property {string|null} humidity
 * @property {string|null} light
 * @property {string|null} container
 * @property {number|null} shelfLifeDays
 * @property {string|null} label
 * @property {string|null} notes
 */

/** @type {Array<{ pattern:RegExp, rule:StorageRule }>} */
const STORAGE_RULES = [];

/**
 * Optional custom location scorer:
 * (item, profile, location) => score:number
 */
let customLocationScorer = null;

/**
 * Register a storage rule.
 * Example:
 *   registerStorageRule(/carrot/i, {
 *     zone: "cellar",
 *     tempRangeF: [32, 40],
 *     humidity: "high",
 *     light: "dark",
 *     container: "crate",
 *     shelfLifeDays: 120,
 *     notes: "Store unwashed, in sand or sawdust",
 *   });
 *
 * @param {RegExp} pattern
 * @param {StorageRule} rule
 */
export function registerStorageRule(pattern, rule) {
  if (!(pattern instanceof RegExp)) return;
  if (!rule || typeof rule !== "object") return;
  STORAGE_RULES.push({ pattern, rule });
}

/**
 * Register a location scorer.
 * Signature:
 *   (item, profile, location) => number
 *
 * @param {(item:any, profile:StorageProfile, location:any) => number} fn
 */
export function registerLocationScorer(fn) {
  if (typeof fn === "function") {
    customLocationScorer = fn;
  }
}

/* Seed some baseline rules (can be overridden or extended elsewhere) */
registerStorageRule(/potato(es)?|onion(s)?|root\s+veg/i, {
  zone: "cellar",
  tempRangeF: [35, 45],
  humidity: "high",
  light: "dark",
  container: "crate",
  shelfLifeDays: 120,
  notes:
    "Store unwashed in breathable containers; keep dark to avoid sprouting.",
});

registerStorageRule(/carrot(s)?|beet(s)?|parsnip(s)?/i, {
  zone: "cellar",
  tempRangeF: [32, 40],
  humidity: "high",
  light: "dark",
  container: "crate",
  shelfLifeDays: 90,
  notes: "Best packed in sand or sawdust with good humidity.",
});

registerStorageRule(/leafy\s+green(s)?|lettuce|spinach|kale/i, {
  zone: "cold",
  tempRangeF: [34, 40],
  humidity: "high",
  light: "indirect",
  container: "bag",
  shelfLifeDays: 7,
  notes: "Store in fridge with high humidity; eat or preserve quickly.",
});

registerStorageRule(/apple(s)?|pear(s)?/i, {
  zone: "cool",
  tempRangeF: [30, 40],
  humidity: "high",
  light: "dark",
  container: "crate",
  shelfLifeDays: 90,
  notes: "Separate from ethylene-sensitive produce.",
});

registerStorageRule(/flour|rice|bean(s)?|lentil(s)?|grain(s)?|oat(s)?/i, {
  zone: "ambient",
  tempRangeF: [50, 70],
  humidity: "low",
  light: "ok",
  container: "airtight",
  shelfLifeDays: 365,
  notes: "Store in airtight buckets or jars; consider mylar + O2 absorbers.",
});

registerStorageRule(/sugar|salt|baking\s+soda|baking\s+powder/i, {
  zone: "ambient",
  tempRangeF: [50, 75],
  humidity: "low",
  light: "ok",
  container: "airtight",
  shelfLifeDays: 365,
  notes: "Keep moisture away; clumping is the enemy.",
});

registerStorageRule(/chicken|beef|lamb|goat|pork|meat/i, {
  zone: "frozen",
  tempRangeF: [0, 10],
  humidity: "low",
  light: "ok",
  container: "airtight",
  shelfLifeDays: 365,
  notes: "Use vacuum bags or double-wrap to prevent freezer burn.",
});

registerStorageRule(/cleaner|bleach|detergent|ammonia|disinfectant/i, {
  zone: "cleaning",
  tempRangeF: [50, 80],
  humidity: "moderate",
  light: "ok",
  container: "original",
  shelfLifeDays: 730,
  notes: "Store away from children and food; never mix chemicals.",
});

/* ---------------------------- Soft DB locations ---------------------------- */

let _dbPromise = null;

/**
 * Try to import Dexie DB from a few common locations.
 * @returns {Promise<any|null>}
 */
async function getDb() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    const candidates = ["@/services/db", "@/db", "@/data/db"];

    for (const path of candidates) {
      try {
        const mod = await import(/* @vite-ignore */ path);
        const db = mod?.default || mod?.db || mod;
        if (db && typeof db === "object") return db;
      } catch {
        // keep trying
      }
    }

    console.warn(
      "[storehouse.storagePlanner] Dexie DB not found; returning null"
    );
    return null;
  })();

  return _dbPromise;
}

/**
 * Try to get storehouse "locations" table.
 * We don't enforce a strict shape here, but we expect something like:
 * {
 *   id: string,
 *   name: string,
 *   zone?: "ambient"|"cool"|"cold"|"frozen"|"cellar"|"outdoor"|"garage"|"barn"|"cleaning",
 *   capacityUnits?: number,
 *   usedUnits?: number,
 *   tags?: string[],
 *   notes?: string
 * }
 *
 * @returns {Promise<any|null>}
 */
async function getLocationsTable() {
  const db = await getDb();
  if (!db) return null;

  const candidates = [db.storehouseLocations, db.locations, db.storageZones];
  for (const t of candidates) {
    if (t && typeof t.where === "function") return t;
  }

  if (Array.isArray(db.tables)) {
    const loc = db.tables.find((t) =>
      /location|storehouse|zone/i.test(t.name || "")
    );
    if (loc) return loc;
  }

  console.warn(
    "[storehouse.storagePlanner] No locations-like table found on DB"
  );
  return null;
}

/* ----------------------------- Public API ---------------------------------- */

/**
 * Suggest a storage profile for a single item.
 *
 * @param {any} item - inventory row or imported item descriptor
 * @param {{ domain?:string }} [ctx]
 * @returns {StorageProfile}
 */
export function suggestStorageProfile(item, ctx = {}) {
  const domain = ctx.domain || item?.domain || "storehouse";
  const name = cleanSpace(item?.name || item?.label || "");
  const tags = (item?.tags || []).map(norm);
  const now = new Date().toISOString();

  let matchedRule = null;

  for (const { pattern, rule } of STORAGE_RULES) {
    if (!pattern.test(name)) continue;
    if (rule.domains && rule.domains.length && !rule.domains.includes(domain)) {
      continue;
    }
    matchedRule = rule;
    break;
  }

  const profile = buildProfileFromRule(name, matchedRule, tags);

  emitSafe("storehouse.storage.profile.suggested", {
    itemId: item?.id || null,
    name,
    domain,
    zone: profile.zone,
    ts: now,
  });

  return profile;
}

/**
 * Plan storage locations for a batch of items.
 *
 * - For each item:
 *   1) compute StorageProfile via suggestStorageProfile,
 *   2) choose the best location (if DB table exists),
 *   3) return assignments ready to become Session steps.
 *
 * @param {any[]} items
 * @param {{
 *   domain?: string,
 *   maxPerItem?: number,        // future: split across multiple locations
 *   useLocationCapacity?: boolean,
 * }} [options]
 * @returns {Promise<{
 *   assignments: Array<{
 *     item:any,
 *     profile:StorageProfile,
 *     location:any|null,
 *     score:number,
 *   }>,
 *   unassigned: Array<{
 *     item:any,
 *     profile:StorageProfile,
 *     reason:string,
 *   }>
 * }>}
 */
export async function planStorageForBatch(items = [], options = {}) {
  const domain = options.domain || "storehouse";
  const useCapacity = options.useLocationCapacity !== false; // default true

  const table = await getLocationsTable();
  let locations = [];

  if (table) {
    try {
      locations = await table.toArray();
    } catch (err) {
      console.warn(
        "[storehouse.storagePlanner] Failed to read locations table:",
        err
      );
      locations = [];
    }
  }

  const assignments = [];
  const unassigned = [];

  for (const item of items) {
    if (!item) continue;

    const profile = suggestStorageProfile(item, { domain });

    if (!locations.length) {
      // No locations defined in DB: treat as unassigned with generic profile
      unassigned.push({
        item,
        profile,
        reason: "NO_LOCATIONS_DEFINED",
      });
      continue;
    }

    const best = chooseBestLocation(item, profile, locations, { useCapacity });
    if (!best) {
      unassigned.push({
        item,
        profile,
        reason: "NO_MATCHING_LOCATION",
      });
    } else {
      assignments.push({
        item,
        profile,
        location: best.location,
        score: best.score,
      });
    }
  }

  const now = new Date().toISOString();

  if (assignments.length || unassigned.length) {
    emitSafe("storehouse.storage.plan.generated", {
      ts: now,
      domain,
      assignments: assignments.length,
      unassigned: unassigned.length,
    });
  } else {
    emitSafe("storehouse.storage.plan.failed", {
      ts: now,
      domain,
      reason: "NO_ITEMS",
    });
  }

  return { assignments, unassigned };
}

/**
 * Convenience helper:
 * - plan storage for a batch,
 * - then map assignments into "session-friendly" step descriptors
 *   compatible with the Session object contract.
 *
 * @param {any[]} items
 * @param {{ domain?:string }} [options]
 * @returns {Promise<Array<{
 *   title:string,
 *   desc:string,
 *   durationSec:number,
 *   blockers:string[],
 *   metadata:any
 * }>>}
 */
export async function planStorageStepsForBatch(items = [], options = {}) {
  const { assignments } = await planStorageForBatch(items, options);

  return assignments.map(({ item, profile, location }) => {
    const name = item?.name || item?.label || "Item";
    const qty = item?.quantity ?? item?.qty ?? null;
    const unit = item?.unit || null;

    const qtyLabel = qty != null ? `${qty}${unit ? " " + unit : ""}` : "";

    const locName =
      location?.name || location?.label || profile.label || profile.zone;

    return {
      title: `Move ${name} to ${locName}`,
      desc: [
        qtyLabel ? `Amount: ${qtyLabel}.` : "",
        `Storage zone: ${profile.zone}.`,
        profile.notes ? `Notes: ${profile.notes}` : "",
        location?.notes ? `Location notes: ${location.notes}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      durationSec: estimateMoveTimeSec(qty),
      blockers: ["inventory", "equipment"], // e.g. requires containers, shelf space
      metadata: {
        storageProfile: profile,
        locationId: location?.id || null,
        locationName: locName,
        itemId: item?.id || null,
        type: "storehouseMove",
      },
    };
  });
}

/* ---------------------------- Location scoring ----------------------------- */

/**
 * Choose the "best" storage location for an item + profile.
 *
 * @param {any} item
 * @param {StorageProfile} profile
 * @param {any[]} locations
 * @param {{ useCapacity:boolean }} options
 * @returns {{location:any, score:number}|null}
 */
function chooseBestLocation(item, profile, locations, options) {
  let best = null;

  for (const loc of locations) {
    const score = scoreLocation(item, profile, loc, options);
    if (score <= 0) continue;

    if (!best || score > best.score) {
      best = { location: loc, score };
    }
  }

  return best;
}

/**
 * Score a location; higher score is better.
 * Factors:
 *   - zone match (exact vs partial),
 *   - basic capacity (if available),
 *   - optional customLocationScorer override/add-on.
 *
 * @param {any} item
 * @param {StorageProfile} profile
 * @param {any} location
 * @param {{ useCapacity:boolean }} options
 * @returns {number}
 */
function scoreLocation(item, profile, location, options) {
  const zone = profile.zone;
  const locZone = (location?.zone || "ambient").toLowerCase();

  let score = 0;

  // Zone matching
  if (locZone === zone) {
    score += 50;
  } else if (isZoneCompatible(zone, locZone)) {
    score += 20;
  } else {
    // incompatible zone
    return 0;
  }

  // Capacity (if provided)
  if (options.useCapacity) {
    const cap = Number(location?.capacityUnits || 0);
    const used = Number(location?.usedUnits || 0);
    if (cap > 0) {
      const free = cap - used;
      if (free <= 0) {
        score -= 10; // full
      } else {
        score += Math.min(30, (free / cap) * 30);
      }
    }
  }

  // Tag affinity e.g. location.tags: ["root-cellar","veg"] etc.
  const itemTags = (item?.tags || []).map(norm);
  const locTags = (location?.tags || []).map(norm);

  if (itemTags.length && locTags.length) {
    const overlap = itemTags.filter((t) => locTags.includes(t)).length;
    score += overlap * 5;
  }

  // Custom scorer extension point
  if (customLocationScorer) {
    try {
      const extra = Number(customLocationScorer(item, profile, location) || 0);
      score += extra;
    } catch (err) {
      console.warn(
        "[storehouse.storagePlanner] customLocationScorer error:",
        err
      );
    }
  }

  return score;
}

/**
 * Very simple compatibility rules between zones:
 * E.g., an "ambient" item can be stored in "cool" or "cold" but not "frozen" by default.
 *
 * @param {string} preferred
 * @param {string} locZone
 * @returns {boolean}
 */
function isZoneCompatible(preferred, locZone) {
  const p = (preferred || "").toLowerCase();
  const z = (locZone || "").toLowerCase();

  if (p === z) return true;

  if (p === "ambient") {
    return z === "cool" || z === "cold";
  }
  if (p === "cool") {
    return z === "cold" || z === "cellar";
  }
  if (p === "cellar") {
    return z === "cool";
  }
  if (p === "frozen") {
    return z === "frozen";
  }
  if (p === "cleaning") {
    return z === "cleaning" || z === "garage" || z === "outdoor";
  }
  return false;
}

/* ------------------------------- Rule helper ------------------------------- */

/**
 * Build a StorageProfile from a matched rule and basic signals.
 *
 * @param {string} name
 * @param {StorageRule|null} rule
 * @param {string[]} tags
 * @returns {StorageProfile}
 */
function buildProfileFromRule(name, rule, tags) {
  if (!rule) {
    // Generic fallback
    const zone = tags.includes("frozen")
      ? "frozen"
      : tags.includes("refrigerated")
      ? "cold"
      : tags.includes("cleaning")
      ? "cleaning"
      : "ambient";

    return {
      zone,
      tempRangeF: null,
      humidity: null,
      light: null,
      container: null,
      shelfLifeDays: null,
      label: friendlyLabelForZone(zone),
      notes: null,
    };
  }

  const zone = rule.zone || "ambient";
  const label = friendlyLabelForZone(zone);

  return {
    zone,
    tempRangeF: rule.tempRangeF || null,
    humidity: rule.humidity || null,
    light: rule.light || null,
    container: rule.container || null,
    shelfLifeDays: Number.isFinite(rule.shelfLifeDays)
      ? rule.shelfLifeDays
      : null,
    label,
    notes: rule.notes || null,
  };
}

/* --------------------------------- Events ---------------------------------- */

function emitSafe(type, data) {
  try {
    emit?.({
      type,
      ts: new Date().toISOString(),
      source: "storehouse.storagePlanner",
      data,
    });
  } catch {
    // ignore
  }
}

/* --------------------------------- Utils ----------------------------------- */

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim();
}
function cleanSpace(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function friendlyLabelForZone(zone) {
  const z = (zone || "").toLowerCase();
  switch (z) {
    case "ambient":
      return "Pantry / Room-Temp Storage";
    case "cool":
      return "Cool Storage";
    case "cold":
      return "Refrigerator";
    case "frozen":
      return "Freezer";
    case "cellar":
      return "Root Cellar / Cold Room";
    case "outdoor":
      return "Outdoor Storage";
    case "garage":
      return "Garage / Utility Storage";
    case "barn":
      return "Barn / Animal Feed Storage";
    case "cleaning":
      return "Cleaning Closet / Chemical Storage";
    default:
      return "General Storage";
  }
}

/**
 * Crude estimate of move time in seconds based on quantity.
 * Used to build Session steps from storage plans.
 *
 * @param {number|null} qty
 * @returns {number}
 */
function estimateMoveTimeSec(qty) {
  const base = 60; // 1 min per item
  if (!Number.isFinite(qty) || qty <= 0) return base;
  return base + Math.min(600, qty * 10); // up to +10 minutes
}

/* --------------------------------- Export ---------------------------------- */

export default {
  suggestStorageProfile,
  planStorageForBatch,
  planStorageStepsForBatch,
  registerStorageRule,
  registerLocationScorer,
};
