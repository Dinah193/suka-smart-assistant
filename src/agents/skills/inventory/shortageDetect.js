/**
 * src/agents/skills/inventory/shortageDetect.js
 *
 * How this fits:
 * - This skill scans inventory for low-stock items and produces:
 *   • structured "shortage" rows (what's low, how low, where stored),
 *   • restock suggestions (how much to buy / restock),
 *   • basic "can be preserved at home" hints (canning, freezing, dehydrating, fermenting).
 *
 * - Intended consumers:
 *   • Storehouse dashboard: restock panel ("Now" CTA for preservation / shopping sessions).
 *   • Cooking sessions: show when key ingredients are close to running out.
 *   • Preservation domain: auto-suggest "batch preservation" sessions for perishable surpluses.
 *
 * - SessionRunner:
 *   • These suggestions can be transformed into:
 *     - a "preservation" session (e.g., can tomatoes, dehydrate herbs),
 *     - or a "shopping" / "restock" task session.
 *
 * Events emitted:
 *   - inventory.shortage.detected
 *   - inventory.restock.suggestions
 *
 * Extension points:
 *   - registerPreservationRule(pattern, methods)
 *       e.g. /tomato/ → ["can", "freeze"]
 *   - registerShortagePolicy(fn)
 *       custom logic for computing recommended restock quantities.
 */

import { emit } from "@/services/events/eventBus";
import InventoryLookup from "@/agents/skills/inventory/lookup";

/* ------------------------- Preservation rule registry ---------------------- */

/**
 * A simple, extensible registry that maps name patterns → possible
 * home preservation methods.
 *
 * Each rule:
 *  {
 *    pattern: RegExp,
 *    methods: string[] // ["can", "freeze", "dehydrate", "ferment", ...]
 *  }
 */
const PRESERVATION_RULES = [];

/**
 * Optional custom shortage policy:
 * (item, shortageInfo, context) => { recommendedQty:number, notes?:string }
 */
let customShortagePolicy = null;

/**
 * Register a preservation rule.
 * Example:
 *   registerPreservationRule(/tomato/i, ["can", "dehydrate"]);
 *   registerPreservationRule(/basil|herb/i, ["dehydrate", "freeze"]);
 *
 * @param {RegExp} pattern
 * @param {string[]} methods
 */
export function registerPreservationRule(pattern, methods) {
  if (!(pattern instanceof RegExp)) return;
  const list = Array.isArray(methods) ? methods.filter(Boolean) : [];
  if (!list.length) return;
  PRESERVATION_RULES.push({ pattern, methods: list });
}

/**
 * Register a custom shortage policy.
 * Signature:
 *   (item, shortageInfo, context) => {
 *      recommendedQty?: number,
 *      notes?: string
 *   }
 *
 * @param {(item:any, shortageInfo:any, context:any) => {recommendedQty?:number, notes?:string}} fn
 */
export function registerShortagePolicy(fn) {
  if (typeof fn === "function") {
    customShortagePolicy = fn;
  }
}

/* Seed some basic rules */
registerPreservationRule(/tomato(es)?/i, ["can", "freeze"]);
registerPreservationRule(/pepper(s)?/i, ["dehydrate", "freeze"]);
registerPreservationRule(/basil|oregano|thyme|herb/i, ["dehydrate", "freeze"]);
registerPreservationRule(/onion(s)?/i, ["dehydrate"]);
registerPreservationRule(/apple(s)?/i, ["dehydrate", "can"]);
registerPreservationRule(/cabbage/i, ["ferment"]);
registerPreservationRule(/chicken|beef|lamb|goat|pork/i, ["freeze", "can"]);
registerPreservationRule(/milk/i, ["freeze", "ferment"]);
registerPreservationRule(/yogurt/i, ["freeze"]);

/* ----------------------------- Public API ---------------------------------- */

/**
 * Detect low-stock inventory items using the underlying lookup skill.
 *
 * @param {{
 *   domain?: string,
 *   location?: string,
 *   tags?: string[],
 *   limit?: number,
 *   allowZero?: boolean
 * }} [options]
 * @returns {Promise<Array<{
 *   item:any,
 *   shortage:number,         // positive number indicating "needed to reach minThreshold"
 *   minThreshold:number,
 *   currentQty:number,
 *   unit:string|null,
 *   domain:string|null,
 *   location:string|null
 * }>>}
 */
export async function detectShortages(options = {}) {
  const {
    domain,
    location,
    tags = [],
    limit = 500,
    allowZero = false,
  } = options;

  const rows = await InventoryLookup.searchInventory({
    domain,
    location,
    tags,
    lowStockOnly: true,
    limit,
  });

  const shortages = [];

  for (const row of rows) {
    if (!row) continue;
    const min = Number(row.minThreshold || 0);
    const qty = Number(row.quantity || 0);
    if (!allowZero && qty <= 0 && min <= 0) continue;

    const shortage = Math.max(min - qty, 0);
    if (shortage <= 0 && !allowZero) continue;

    shortages.push({
      item: row,
      shortage,
      minThreshold: min,
      currentQty: qty,
      unit: row.unit || null,
      domain: row.domain || null,
      location: row.location || null,
    });
  }

  emitSafe("inventory.shortage.detected", {
    count: shortages.length,
    domain: domain || null,
    location: location || null,
  });

  return shortages;
}

/**
 * Turn shortages into concrete restock suggestions, including home-preservation hints.
 *
 * @param {Array<{
 *   item:any,
 *   shortage:number,
 *   minThreshold:number,
 *   currentQty:number,
 *   unit:string|null,
 *   domain:string|null,
 *   location:string|null
 * }>} shortages
 * @param {{
 *   upcomingUsage?: Record<string, number>,  // per item.id → additional qty to cover
 *   safetyFactor?: number,                   // e.g. 0.25 → +25%
 *   allowPreservationHints?: boolean,
 *   preservationDomain?: string,            // default "preservation"
 *   reason?: string,
 * }} [context]
 * @returns {Array<{
 *   item:any,
 *   action:"buy"|"preserve"|"either",
 *   recommendedQty:number,
 *   unit:string|null,
 *   shortage:number,
 *   currentQty:number,
 *   minThreshold:number,
 *   canPreserveAtHome:boolean,
 *   preservationMethods:string[],
 *   preservationNotes?:string|null,
 *   reason?:string|null
 * }>}
 */
export function createRestockSuggestions(shortages = [], context = {}) {
  const {
    upcomingUsage = {},
    safetyFactor = 0.2,
    allowPreservationHints = true,
    preservationDomain = "preservation",
    reason,
  } = context;

  const out = [];

  for (const s of shortages) {
    if (!s || !s.item) continue;
    const item = s.item;
    const id = item.id;

    const baseShortage = Number(s.shortage || 0);
    const extraUsage = Number(upcomingUsage[id] || 0);
    const effectiveShortage = Math.max(baseShortage + extraUsage, 0);

    // Base recommended quantity with a simple safety factor
    let recommendedQty =
      effectiveShortage > 0
        ? effectiveShortage * (1 + Math.max(safetyFactor, 0))
        : 0;

    // Allow custom policy to override
    let policyNotes = null;
    if (customShortagePolicy) {
      try {
        const policyRes = customShortagePolicy(item, s, context) || {};
        if (
          typeof policyRes.recommendedQty === "number" &&
          policyRes.recommendedQty > 0
        ) {
          recommendedQty = policyRes.recommendedQty;
        }
        if (policyRes.notes) {
          policyNotes = String(policyRes.notes);
        }
      } catch (err) {
        console.warn(
          "[inventory.shortageDetect] customShortagePolicy error:",
          err
        );
      }
    }

    const { preservable, methods, notes } = allowPreservationHints
      ? classifyPreservable(item, preservationDomain)
      : { preservable: false, methods: [], notes: null };

    const action = chooseAction(item, preservable);

    out.push({
      item,
      action, // "buy" | "preserve" | "either"
      recommendedQty: round(recommendedQty, 2),
      unit: s.unit || item.unit || null,
      shortage: baseShortage,
      currentQty: s.currentQty,
      minThreshold: s.minThreshold,
      canPreserveAtHome: preservable,
      preservationMethods: methods,
      preservationNotes: notes || policyNotes || null,
      reason: reason || null,
    });
  }

  emitSafe("inventory.restock.suggestions", {
    count: out.length,
    preservationEnabled: !!allowPreservationHints,
  });

  return out;
}

/**
 * Convenience helper:
 * - Detect shortages using `detectShortages`,
 * - Then immediately produce restock suggestions.
 *
 * @param {any} detectOptions  // passed to detectShortages
 * @param {any} suggestionContext  // passed to createRestockSuggestions
 * @returns {Promise<{ shortages:any[], suggestions:any[] }>}
 */
export async function detectShortagesWithSuggestions(
  detectOptions = {},
  suggestionContext = {}
) {
  const shortages = await detectShortages(detectOptions);
  const suggestions = createRestockSuggestions(shortages, suggestionContext);
  return { shortages, suggestions };
}

/* -------------------------- Preservation helpers --------------------------- */

/**
 * Determine if an inventory item is likely preservable at home and how.
 *
 * Very simple heuristic:
 *  - Matches PRESERVATION_RULES by name / tags.
 *  - Domain hint: cooking/garden/animals → more likely to be preservable.
 *
 * @param {any} item
 * @param {string} preservationDomain
 * @returns {{ preservable:boolean, methods:string[], notes:string|null }}
 */
function classifyPreservable(item, preservationDomain) {
  if (!item) {
    return { preservable: false, methods: [], notes: null };
  }

  const name = cleanSpace(item.name || item.label || "");
  const tags = (item.tags || []).map(norm);
  const domain = item.domain || null;

  const matchedMethods = new Set();

  for (const rule of PRESERVATION_RULES) {
    if (rule.pattern.test(name)) {
      for (const m of rule.methods) matchedMethods.add(m);
    }
  }

  // Tag hints
  if (tags.includes("perishable") || tags.includes("fresh")) {
    matchedMethods.add("freeze");
  }
  if (tags.includes("herb")) {
    matchedMethods.add("dehydrate");
  }

  // Domain hints
  if (domain === "garden") {
    matchedMethods.add("can");
    matchedMethods.add("dehydrate");
  }
  if (domain === "animals") {
    matchedMethods.add("freeze");
  }

  const methods = Array.from(matchedMethods);
  if (!methods.length) {
    return { preservable: false, methods: [], notes: null };
  }

  const pretty = methods.map((m) => toTitle(m)).join(", ");

  const notes = `You can likely preserve this at home via: ${pretty}. Use the "${preservationDomain}" tools to plan a batch.`;

  return {
    preservable: true,
    methods,
    notes,
  };
}

/**
 * Decide the "primary" suggested action.
 * Right now:
 *  - if preservable → "either" (household can choose),
 *  - else → "buy".
 *
 * Later, you could extend with:
 *  - pricebook comparisons,
 *  - garden planting suggestions,
 *  - seasonal overrides.
 *
 * @param {any} item
 * @param {boolean} preservable
 * @returns {"buy"|"preserve"|"either"}
 */
function chooseAction(item, preservable) {
  if (!item) return "buy";
  if (preservable) return "either";
  return "buy";
}

/* --------------------------------- Events ---------------------------------- */

function emitSafe(type, data) {
  try {
    emit?.({
      type,
      ts: new Date().toISOString(),
      source: "inventory.shortageDetect",
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
function toTitle(s) {
  const str = cleanSpace(s);
  if (!str) return str;
  return str
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
function round(n, p = 2) {
  const v = Number(n);
  if (!isFinite(v)) return v;
  const f = Math.pow(10, p);
  return Math.round(v * f) / f;
}

/* --------------------------------- Export ---------------------------------- */

export default {
  detectShortages,
  createRestockSuggestions,
  detectShortagesWithSuggestions,
  registerPreservationRule,
  registerShortagePolicy,
};
