/**
 * src/agents/skills/recipes/mergeIngredients.js
 *
 * How this fits:
 * - Downstream of recipes.normalizemany:
 *   • Takes canonical ingredient rows (with qty/unit/grams/ml) from one or more recipes.
 *   • Consolidates duplicates ("granulated sugar" vs "sugar") into merged lines.
 *   • Normalizes units toward a canonical representation (g, ml, each, or fallback unit).
 *   • Output is ideal for:
 *     - "Mise en place"/Prep checklist,
 *     - Shopping list generation,
 *     - Storehouse & inventory checks.
 *
 * - SessionRunner:
 *   • You can use merged ingredients for the session "inventory notes" pane,
 *     showing total needed across a multi-recipe cooking session.
 *
 * Design:
 * - Ingredient input shape (expected from recipes.normalizemany):
 *   {
 *     name: string,
 *     qty: number|null,
 *     unit: string|null,
 *     original?: string|null,
 *     notes?: string|null,
 *     grams?: number|null,
 *     ml?: number|null,
 *     group?: string|null
 *   }
 *
 * - Merged row shape (output):
 *   {
 *     name: string,
 *     displayName: string,    // nice-case version of name
 *     qty: number|null,       // in canonicalUnit, if not null
 *     unit: string|null,      // canonicalUnit (g/ml/each/or original)
 *     grams: number|null,     // if canonical mass
 *     ml: number|null,        // if canonical volume
 *     sourceUnits: Set<string>,      // units encountered
 *     sourceNames: Set<string>,      // variations of name encountered
 *     sourceLines: number,           // how many rows merged
 *     notes: string|null,
 *     groups: Set<string>            // ingredient groups encountered
 *   }
 *
 * Extension points:
 * - registerIngredientMergeAlias(from, to)
 * - registerCountUnit(unit)
 * - registerPreferredUnitForIngredient(name, { mode: "mass"|"volume"|"count"|"none", unit?: string })
 *
 * Safety:
 * - Defensive input checks; returns [] on bad input.
 * - Never throws on bad ingredient rows; skips or degrades gracefully.
 * - Aggregates mass by grams where possible, volume by ml where possible, count by "each".
 * - Falls back to per-unit aggregation (e.g., "tbsp" totals) if no grams/ml.
 */

import { emit } from "@/services/events/eventBus"; // safe optional; guarded below

/* --------------------------- Registry / Preferences ------------------------ */

/** name alias: "granulated sugar" -> "sugar" */
const NAME_ALIASES = new Map();
/** count units: "clove", "cloves", "egg", "eggs", "each", "" etc. */
const COUNT_UNITS = new Set([
  "each",
  "item",
  "clove",
  "cloves",
  "egg",
  "eggs",
  "piece",
  "pieces",
  "pcs",
]);

/**
 * per-name preference:
 * { mode: "mass"|"volume"|"count"|"none", unit?:string }
 */
const NAME_PREFERENCES = new Map();

/**
 * Register an alias for ingredient names to unify merging.
 * e.g. registerIngredientMergeAlias("granulated sugar", "sugar");
 * @param {string} from
 * @param {string} to
 */
export function registerIngredientMergeAlias(from, to) {
  const f = norm(from);
  const t = cleanSpace(to);
  if (!f || !t) return;
  NAME_ALIASES.set(f, t);
}

/**
 * Register a unit as "count" (e.g., cloves, eggs).
 * @param {string} unit
 */
export function registerCountUnit(unit) {
  const u = norm(unit);
  if (!u) return;
  COUNT_UNITS.add(u);
}

/**
 * Register preferred aggregation mode/unit for an ingredient.
 * mode:
 *  - "mass"   → aggregate in grams.
 *  - "volume" → aggregate in ml.
 *  - "count"  → aggregate as "each".
 *  - "none"   → don't convert; just group by name+unit.
 * Optionally provide a display unit (e.g. "g", "ml", "each", "tbsp").
 * @param {string} ingredientName
 * @param {{ mode:"mass"|"volume"|"count"|"none", unit?:string }} pref
 */
export function registerPreferredUnitForIngredient(ingredientName, pref) {
  if (!ingredientName || !pref || !pref.mode) return;
  NAME_PREFERENCES.set(norm(ingredientName), { ...pref });
}

/* Seed some simple defaults */
registerIngredientMergeAlias("granulated sugar", "sugar");
registerIngredientMergeAlias("caster sugar", "sugar");
registerIngredientMergeAlias("brown sugar", "brown sugar");
registerIngredientMergeAlias("all-purpose flour", "flour");
registerIngredientMergeAlias("plain flour", "flour");

registerCountUnit("each");
registerCountUnit("");
registerCountUnit("clove");
registerCountUnit("cloves");
registerCountUnit("egg");
registerCountUnit("eggs");

/* ------------------------------- Public API -------------------------------- */

/**
 * Merge and normalize ingredients into canonical units.
 *
 * @param {Array<any>} ingredients
 * @param {{
 *   defaultMode?: "mass"|"volume"|"count"|"auto";   // default aggregation mode
 *   emitEvent?: boolean;                            // default true
 * }} [options]
 * @returns {Array<{
 *   name:string,
 *   displayName:string,
 *   qty:number|null,
 *   unit:string|null,
 *   grams:number|null,
 *   ml:number|null,
 *   sourceUnits:Set<string>,
 *   sourceNames:Set<string>,
 *   sourceLines:number,
 *   notes:string|null,
 *   groups:Set<string>
 * }>}
 */
export function mergeIngredients(ingredients = [], options = {}) {
  if (!Array.isArray(ingredients) || !ingredients.length) return [];

  const defaultMode = options.defaultMode || "auto";
  const emitEvent = options.emitEvent !== false;

  /** @type {Map<string, any>} */
  const bucket = new Map();

  for (const row of ingredients) {
    if (!row || typeof row !== "object") continue;

    const rawName = cleanSpace(row.name || row.original || "");
    if (!rawName) continue;
    const baseName = normalizeIngredientName(rawName);

    const pref = NAME_PREFERENCES.get(norm(baseName));
    const mode = pickMode(pref?.mode, row, defaultMode);

    const unitRaw = norm(row.unit || "");
    const isCountUnit = COUNT_UNITS.has(unitRaw);

    const grams =
      typeof row.grams === "number" && isFinite(row.grams) ? row.grams : null;
    const ml = typeof row.ml === "number" && isFinite(row.ml) ? row.ml : null;
    const qty =
      typeof row.qty === "number" && isFinite(row.qty) ? row.qty : null;
    const group = row.group ? cleanSpace(row.group) : null;
    const notes = row.notes ? cleanSpace(row.notes) : "";

    // Determine aggregation key + numeric basis
    const { key, numericValue, numericUnit, numericMode } =
      selectAggregationKey({
        mode,
        baseName,
        grams,
        ml,
        qty,
        unitRaw,
        isCountUnit,
      });

    if (!key || numericValue == null) {
      // can't aggregate meaningfully; bucket by name+unit as-is
      const fallbackKey = `${baseName}__${unitRaw || "unit-none"}`;
      mergeIntoBucket(bucket, fallbackKey, {
        baseName,
        rawName,
        numericValue: qty,
        numericMode: "none",
        numericUnit: unitRaw || null,
        notes,
        group,
      });
      continue;
    }

    mergeIntoBucket(bucket, key, {
      baseName,
      rawName,
      numericValue,
      numericMode,
      numericUnit,
      grams,
      ml,
      notes,
      group,
    });
  }

  /** @type {Array<any>} */
  const result = [];

  for (const [, node] of bucket) {
    const {
      baseName,
      total,
      mode,
      unit,
      grams,
      ml,
      sourceNames,
      sourceUnits,
      sourceLines,
      notes,
      groups,
    } = node;

    // Choose display unit/value from canonical totals
    let qty = null;
    let outUnit = null;
    let outGrams = null;
    let outMl = null;

    if (mode === "mass") {
      outGrams = total;
      qty = round(total, 1);
      outUnit = node.prefUnit || "g";
    } else if (mode === "volume") {
      outMl = total;
      qty = round(total, 1);
      outUnit = node.prefUnit || "ml";
    } else if (mode === "count") {
      qty = round(total, 2);
      outUnit = node.prefUnit || "each";
    } else {
      // "none": just keep summed qty in the unit encountered
      qty = round(total, 3);
      outUnit = unit || null;
    }

    result.push({
      name: baseName,
      displayName: toTitle(baseName),
      qty,
      unit: outUnit,
      grams: outGrams,
      ml: outMl,
      sourceUnits,
      sourceNames,
      sourceLines,
      notes: notes || null,
      groups,
    });
  }

  // Emit analytics
  if (emitEvent) {
    try {
      emit?.({
        type: "recipes.ingredients.merged",
        ts: new Date().toISOString(),
        source: "recipes.mergeIngredients",
        data: {
          inCount: ingredients.length,
          outCount: result.length,
        },
      });
    } catch {
      // ignore
    }
  }

  // sort by name for stability
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/**
 * Project already-merged ingredients into a specific unit layout.
 * e.g., convert mass (grams) into kg or lb for shopping list display.
 *
 * NOTE: This is presentation-level only; does not re-aggregate.
 *
 * @param {Array<any>} merged
 * @param {{
 *   massUnit?: "g"|"kg"|"lb",
 *   volumeUnit?: "ml"|"l",
 *   countUnit?: string
 * }} [prefs]
 * @returns {Array<any>}
 */
export function projectMergedToUnits(merged = [], prefs = {}) {
  const massUnit = prefs.massUnit || "g";
  const volumeUnit = prefs.volumeUnit || "ml";
  const countUnit = prefs.countUnit || "each";

  return (merged || []).map((row) => {
    const r = { ...row };
    if (typeof r.grams === "number" && isFinite(r.grams) && r.grams > 0) {
      if (massUnit === "kg") {
        r.qty = round(r.grams / 1000, 2);
        r.unit = "kg";
      } else if (massUnit === "lb") {
        r.qty = round(r.grams / 453.592, 2);
        r.unit = "lb";
      } else {
        r.qty = round(r.grams, 1);
        r.unit = "g";
      }
    } else if (typeof r.ml === "number" && isFinite(r.ml) && r.ml > 0) {
      if (volumeUnit === "l") {
        r.qty = round(r.ml / 1000, 2);
        r.unit = "l";
      } else {
        r.qty = round(r.ml, 1);
        r.unit = "ml";
      }
    } else if (r.unit === "each" || COUNT_UNITS.has(norm(r.unit || ""))) {
      r.unit = countUnit;
      r.qty = r.qty != null ? round(r.qty, 2) : r.qty;
    }
    return r;
  });
}

/* ---------------------------- Internal Helpers ----------------------------- */

function normalizeIngredientName(name) {
  const base = cleanSpace(name).toLowerCase();
  const alias = NAME_ALIASES.get(norm(base));
  const stripped = base
    .replace(
      /\b(finely|coarsely|minced|chopped|diced|sliced|softened|melted|room temperature|cold|warm)\b/gi,
      ""
    )
    .trim();
  const finalName = alias || stripped || base;
  return finalName.replace(/\s+/g, " ");
}

/**
 * Pick aggregation mode given preference + row.
 * @param {"mass"|"volume"|"count"|"none"} prefMode
 * @param {any} row
 * @param {"mass"|"volume"|"count"|"auto"} defaultMode
 */
function pickMode(prefMode, row, defaultMode) {
  if (prefMode) return prefMode;

  if (
    defaultMode === "mass" ||
    defaultMode === "volume" ||
    defaultMode === "count"
  ) {
    return defaultMode;
  }

  // auto: infer from data
  const hasGrams = typeof row.grams === "number" && isFinite(row.grams);
  const hasMl = typeof row.ml === "number" && isFinite(row.ml);
  const unitRaw = norm(row.unit || "");
  const isCountUnit = COUNT_UNITS.has(unitRaw);

  if (hasGrams) return "mass";
  if (hasMl) return "volume";
  if (isCountUnit) return "count";
  return "none";
}

/**
 * Decide how to aggregate a single row:
 * - key → bucket key
 * - numericValue → the numeric sum to add
 * - numericUnit → canonical unit (g/ml/each/or original)
 * - numericMode → "mass"|"volume"|"count"|"none"
 */
function selectAggregationKey({
  mode,
  baseName,
  grams,
  ml,
  qty,
  unitRaw,
  isCountUnit,
}) {
  let key = null;
  let numericValue = null;
  let numericUnit = null;
  let numericMode = mode;

  if (mode === "mass") {
    if (grams == null && qty != null) {
      // no grams; we can't reliably convert; fallback
      numericMode = "none";
    } else {
      numericValue = grams;
      numericUnit = "g";
      key = `${baseName}__mass`;
    }
  }

  if (!key && mode === "volume") {
    if (ml == null && qty != null) {
      numericMode = "none";
    } else {
      numericValue = ml;
      numericUnit = "ml";
      key = `${baseName}__volume`;
    }
  }

  if (!key && mode === "count") {
    if (!Number.isFinite(qty)) {
      numericValue = 0;
    } else {
      numericValue = qty;
    }
    numericUnit = "each";
    key = `${baseName}__count`;
  }

  if (!key && mode === "none") {
    // group by name+unit as-is
    if (!Number.isFinite(qty)) {
      return {
        key: null,
        numericValue: null,
        numericUnit: null,
        numericMode: "none",
      };
    }
    const unitKey = unitRaw || (isCountUnit ? "each" : "");
    numericValue = qty;
    numericUnit = unitKey || null;
    key = `${baseName}__${unitKey || "unit-none"}`;
  }

  return { key, numericValue, numericUnit, numericMode };
}

/**
 * Merge an ingredient row into the aggregation bucket.
 */
function mergeIntoBucket(bucket, key, payload) {
  if (!key) return;
  const cur = bucket.get(key);
  const total = Number(payload.numericValue || 0);

  if (!cur) {
    const groups = new Set();
    const sourceNames = new Set();
    const sourceUnits = new Set();
    if (payload.group) groups.add(payload.group);
    sourceNames.add(payload.rawName);
    if (payload.numericUnit) sourceUnits.add(payload.numericUnit);
    const pref = NAME_PREFERENCES.get(norm(payload.baseName));

    bucket.set(key, {
      baseName: payload.baseName,
      total,
      mode: payload.numericMode,
      unit: payload.numericUnit,
      grams: payload.numericMode === "mass" ? payload.numericValue : null,
      ml: payload.numericMode === "volume" ? payload.numericValue : null,
      sourceLines: 1,
      sourceNames,
      sourceUnits,
      notes: payload.notes || "",
      groups,
      prefUnit: pref?.unit || null,
    });
  } else {
    cur.total += total;
    if (payload.numericMode === "mass" && payload.grams != null) {
      cur.grams = (cur.grams || 0) + payload.grams;
    } else if (payload.numericMode === "volume" && payload.ml != null) {
      cur.ml = (cur.ml || 0) + payload.ml;
    }
    cur.sourceLines += 1;
    cur.sourceNames.add(payload.rawName);
    if (payload.numericUnit) cur.sourceUnits.add(payload.numericUnit);
    if (payload.group) cur.groups.add(payload.group);
    if (payload.notes) {
      cur.notes = cur.notes
        ? `${cur.notes} ${payload.notes}`.trim()
        : payload.notes;
    }
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
  mergeIngredients,
  projectMergedToUnits,
  registerIngredientMergeAlias,
  registerCountUnit,
  registerPreferredUnitForIngredient,
};
