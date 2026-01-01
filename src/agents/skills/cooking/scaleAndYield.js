/**
 * src/agents/skills/cooking/scaleAndYield.js
 *
 * How this fits:
 * - Used by import normalizers, session composers, and the SessionRunner tips pane to:
 *   • scale a recipe to target servings/weight/volume or pan size,
 *   • adjust ingredient amounts with domain-aware rules (e.g., leaveners scale sublinearly),
 *   • predict timing changes via yield curves (batches, surface area, heat transfer),
 *   • compute & stamp yield metadata back onto the recipe.
 *
 * Contracts touched:
 * - Input "recipe-like" object (title, ingredients[], instructions[], meta.servings?).
 * - Output scaled recipe (same shape) with meta.yield: { servings, totalWeightG?, totalVolumeMl? },
 *   meta.scale: { factor, method, notes }, and per-instruction timing adjustments.
 *
 * Extension points:
 * - registerYieldCurve(name, fn)
 * - registerIngredientRule({ match, apply })
 * - registerDensity(name, gPerMl)  (for weight/volume conversion when unit missing)
 * - setFormatters({ qtyFormatter }) to control rounding/printing behavior
 *
 * Defensive notes:
 * - Non-numeric or "to taste" quantities are preserved with an additive note when scaled.
 * - Ranges like "1–2" are scaled by their endpoints and preserved as ranges.
 * - Unknown units are passed through unchanged; numeric portions still scaled.
 */

import { emit } from "@/services/eventBus"; // Optional analytics; errors are swallowed if absent

/* --------------------------------- Types ---------------------------------- */
/**
 * @typedef {Object} Ingredient
 * @property {string} name
 * @property {number|string} [qty]       // 2, 0.5, "to taste", "1-2"
 * @property {string} [unit]             // "g","ml","cup","tbsp","tsp","oz","lb","l","kg","each",...
 * @property {string} [id]
 * @property {Record<string,any>} [meta] // free form
 */

/**
 * @typedef {Object} RecipeLike
 * @property {string} id
 * @property {string} title
 * @property {Ingredient[]} [ingredients]
 * @property {Array<{ text: string, durationSec?: number, tempF?: number }>} [instructions]
 * @property {{ servings?: number, pan?: { shape?: "round"|"rect", width?: number, length?: number, diameter?: number, height?: number, unit?: "in"|"cm" }, yield?: Record<string,any>, scale?: Record<string,any>}} [meta]
 */

/**
 * @typedef {Object} ScaleOptions
 * @property {number} [toServings]
 * @property {number} [fromServings]   // fallback if recipe.meta.servings missing
 * @property {{targetWeightG?: number, targetVolumeMl?: number}} [toYield]
 * @property {{ shape?: "round"|"rect", width?: number, length?: number, diameter?: number, height?: number, unit?: "in"|"cm" }} [toPan]
 * @property {number} [limitDecimals]   // default 2
 * @property {boolean} [adjustTiming]   // default true
 * @property {boolean} [adjustSeasoning]// default true (use ingredient rules)
 * @property {boolean} [preserveTextQty]// default true (append notes instead of mutating strings)
 * @property {string}  [notePrefix]     // default "~"
 */

/* ------------------------------- Constants -------------------------------- */

const DEFAULTS = {
  limitDecimals: 2,
  adjustTiming: true,
  adjustSeasoning: true,
  preserveTextQty: true,
  notePrefix: "~",
};

const UNIT = {
  // mass
  g: { type: "mass", toBase: 1 },
  kg: { type: "mass", toBase: 1000 },
  oz: { type: "mass", toBase: 28.3495 },
  lb: { type: "mass", toBase: 453.592 },

  // volume (metric)
  ml: { type: "vol", toBase: 1 },
  l: { type: "vol", toBase: 1000 },

  // volume (US customary)
  tsp: { type: "vol", toBase: 4.92892 },
  tbsp: { type: "vol", toBase: 14.7868 },
  cup: { type: "vol", toBase: 236.588 },
  pt: { type: "vol", toBase: 473.176 },
  qt: { type: "vol", toBase: 946.353 },
  gal: { type: "vol", toBase: 3785.41 },

  // piece-like
  each: { type: "count", toBase: 1 },
};

/** Lightweight canonicalization for unit strings */
function canonUnit(u) {
  if (!u) return "";
  const t = String(u).toLowerCase().trim();
  if (t === "tablespoon") return "tbsp";
  if (t === "teaspoon") return "tsp";
  if (t === "pound") return "lb";
  if (t === "pounds") return "lb";
  if (t === "ounce" || t === "ounces") return "oz";
  if (t === "liter" || t === "litre") return "l";
  if (t === "milliliter" || t === "millilitre") return "ml";
  if (t === "pcs" || t === "piece" || t === "pieces") return "each";
  return t;
}

/* -------------------------- Density Knowledge Base ------------------------ */
/**
 * DENSITIES store approximate g/ml to convert mass<->volume when recipe lacks explicit unit conversions.
 * Provide household-friendly defaults; callers can override per brand/household.
 */
const DENSITIES = new Map([
  ["water", 1.0],
  ["milk", 1.03],
  ["butter, melted", 0.91],
  ["honey", 1.42],
  ["maple syrup", 1.32],
  ["olive oil", 0.91],
  ["all-purpose flour", 0.53], // sifted cup ~125g → 125/236.6 ≈ 0.53 g/ml
  ["granulated sugar", 0.85],  // 200g/236ml ≈ 0.85
  ["brown sugar (packed)", 1.1],
  ["cocoa powder", 0.5],
  ["salt (kosher)", 0.6],
  ["salt (table)", 1.2],
]);

export function registerDensity(name, gPerMl) {
  if (!name || !Number.isFinite(gPerMl) || gPerMl <= 0) return;
  DENSITIES.set(name.toLowerCase(), gPerMl);
}

/* ---------------------------- Yield Curve Engine -------------------------- */
/**
 * Yield curves map scaleFactor → adjustment.
 * Built-ins:
 *  - "time.batch": simmer/stew time scales ~ s^0.25..0.35 (added mass → slower heat penetration)
 *  - "time.bake": internal set for loaves/cakes ~ s^0.20 with pan geometry blending
 *  - "seasoning.default": seasonings scale ~ s^0.85 (avoid overseasoning at larger batch)
 *  - "aromatics.default": onion/garlic/chile ~ s^0.90
 *  - "leavener.default": baking powder/soda/yeast ~ s^0.75 with clamping
 */

const YIELD_CURVES = new Map();

/** Public: register or override a yield curve */
export function registerYieldCurve(name, fn) {
  if (typeof fn === "function") YIELD_CURVES.set(String(name), fn);
}

/** Evaluate a curve or return default 1:1 */
function evalCurve(name, scale) {
  const fn = YIELD_CURVES.get(name);
  if (typeof fn !== "function") return scale; // identity by default
  try {
    const v = Number(fn(scale));
    return Number.isFinite(v) && v > 0 ? v : scale;
  } catch {
    return scale;
  }
}

/* Built-in curves */
registerYieldCurve("time.batch", (s) => Math.pow(s, 0.30));     // stew/soup
registerYieldCurve("time.bake", (s) => Math.pow(s, 0.20));      // loaf/cake interior set
registerYieldCurve("seasoning.default", (s) => Math.pow(s, 0.85));
registerYieldCurve("aromatics.default", (s) => Math.pow(s, 0.90));
registerYieldCurve("leavener.default", (s) => clamp(Math.pow(s, 0.75), 0.5, 1.75));

/* ---------------------------- Ingredient Rules ---------------------------- */
/**
 * Ingredient rules customize per-ingredient scaling beyond the raw scale factor.
 * Rule: { match(ingredient): boolean, apply({ qty, unit, scale, recipe, ingredient }): { qty, notes? } }
 */
const ING_RULES = [];

/** Public: add a rule */
export function registerIngredientRule(rule) {
  if (rule && typeof rule.match === "function" && typeof rule.apply === "function") {
    ING_RULES.push(rule);
  }
}

/* Built-in rules */

const leavenerRx = /\b(baking\s*(powder|soda)|yeast|bicarbonate)\b/i;
registerIngredientRule({
  match: (ing) => leavenerRx.test(ing.name),
  apply: ({ qty, scale }) => ({ qty: qty * evalCurve("leavener.default", scale), notes: "Adjusted leavener for scale" }),
});

const saltRx = /\b(salt|kosher salt|sea salt|table salt)\b/i;
registerIngredientRule({
  match: (ing) => saltRx.test(ing.name),
  apply: ({ qty, scale }) => ({ qty: qty * evalCurve("seasoning.default", scale), notes: "Seasoning scales sublinearly" }),
});

const aromaticsRx = /\b(garlic|onion|shallot|scallion|ginger|chile|chili|pepper)\b/i;
registerIngredientRule({
  match: (ing) => aromaticsRx.test(ing.name),
  apply: ({ qty, scale }) => ({ qty: qty * evalCurve("aromatics.default", scale), notes: "Aromatics scale gently" }),
});

/* --------------------------- Pan Geometry Helpers ------------------------- */

function panArea(pan = {}) {
  // Returns cm^2
  const unit = pan.unit === "in" ? "in" : "cm";
  const toCm = unit === "in" ? 2.54 : 1;
  if (pan.shape === "round" && Number.isFinite(pan.diameter)) {
    const r = (pan.diameter * toCm) / 2;
    return Math.PI * r * r;
  }
  if (pan.shape === "rect" && Number.isFinite(pan.width) && Number.isFinite(pan.length)) {
    return (pan.width * toCm) * (pan.length * toCm);
  }
  return NaN;
}

function panDepth(pan = {}) {
  const unit = pan.unit === "in" ? "in" : "cm";
  const toCm = unit === "in" ? 2.54 : 1;
  if (Number.isFinite(pan.height)) return pan.height * toCm;
  return NaN;
}

/**
 * Calculate a pan-based scale factor blending surface area and volume.
 * If target pan is shallower but larger area, baking time may decrease even for larger batch.
 */
function panScaleFactor(fromPan, toPan) {
  const a0 = panArea(fromPan);
  const a1 = panArea(toPan);
  const d0 = panDepth(fromPan);
  const d1 = panDepth(toPan);
  if (!isFinite(a0) || !isFinite(a1)) return NaN;
  const areaScale = a1 / a0;
  if (!isFinite(d0) || !isFinite(d1)) return areaScale; // fallback: surface area only
  const volScale = (a1 * d1) / (a0 * d0);
  // Blend area vs volume by weight, bias to volume (0.7) because batter height matters
  return 0.7 * volScale + 0.3 * areaScale;
}

/* --------------------------- Quantity Conversions -------------------------- */

function toBase(qty, unit) {
  const u = UNIT[canonUnit(unit)];
  if (!u || !Number.isFinite(qty)) return { qty, unit };
  return { qty: qty * u.toBase, unitType: u.type };
}

function fromBase(qtyBase, toUnit) {
  const u = UNIT[canonUnit(toUnit)];
  if (!u || !Number.isFinite(qtyBase)) return { qty: qtyBase, unit: toUnit };
  return { qty: qtyBase / u.toBase, unit: toUnit };
}

function tryMassVolBridge(qty, fromUnit, toUnit, ingName) {
  // If types mismatch (mass vs vol), try density bridge if available.
  const uFrom = UNIT[canonUnit(fromUnit)];
  const uTo = UNIT[canonUnit(toUnit)];
  if (!uFrom || !uTo || !Number.isFinite(qty)) return { qty, unit: fromUnit };
  if (uFrom.type === uTo.type) return { qty, unit: fromUnit };

  const dens = lookupDensity(ingName);
  if (!dens) return { qty, unit: fromUnit };
  if (uFrom.type === "mass" && uTo.type === "vol") {
    // mass(g base) → volume(ml base)
    const g = toBase(qty, fromUnit).qty;
    const ml = gToMl(g, dens);
    return fromBase(ml, toUnit);
  }
  if (uFrom.type === "vol" && uTo.type === "mass") {
    const ml = toBase(qty, fromUnit).qty;
    const g = mlToG(ml, dens);
    return fromBase(g, toUnit);
  }
  return { qty, unit: fromUnit };
}

function lookupDensity(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  // exact
  if (DENSITIES.has(n)) return DENSITIES.get(n);
  // try head tokens (e.g., "all-purpose flour (sifted)")
  const k = [...DENSITIES.keys()].find((k) => n.includes(k));
  return k ? DENSITIES.get(k) : null;
}

function gToMl(g, dens) { return g / dens; }
function mlToG(ml, dens) { return ml * dens; }

/* --------------------------- Scale Factor Compute -------------------------- */

/**
 * Compute the primary scale factor.
 * Priority: toYield (weight/volume) > toPan > toServings
 */
export function computeScaleFactor(recipe, options = {}) {
  const meta = recipe?.meta || {};
  const fromServings = Number.isFinite(meta.servings) ? meta.servings : (Number.isFinite(options.fromServings) ? options.fromServings : NaN);
  const toServings = Number.isFinite(options.toServings) ? options.toServings : NaN;

  // Yield-based scaling
  if (options.toYield?.targetWeightG || options.toYield?.targetVolumeMl) {
    const current = estimateRecipeYield(recipe);
    if (options.toYield.targetWeightG && current.totalWeightG) {
      const s = options.toYield.targetWeightG / current.totalWeightG;
      if (isFinite(s) && s > 0) return { factor: s, method: "yield.weight" };
    }
    if (options.toYield.targetVolumeMl && current.totalVolumeMl) {
      const s = options.toYield.targetVolumeMl / current.totalVolumeMl;
      if (isFinite(s) && s > 0) return { factor: s, method: "yield.volume" };
    }
  }

  // Pan-based scaling (bakes)
  if (options.toPan && meta.pan) {
    const s = panScaleFactor(meta.pan, options.toPan);
    if (isFinite(s) && s > 0) return { factor: s, method: "pan" };
  }

  // Servings
  if (isFinite(fromServings) && isFinite(toServings) && fromServings > 0) {
    return { factor: toServings / fromServings, method: "servings" };
  }

  return { factor: 1, method: "identity" };
}

/* ------------------------------ Public Scaling ---------------------------- */

/**
 * Scale a recipe with yield-aware adjustments.
 * - Scales ingredient quantities.
 * - Adjusts instruction durations with yield curves where sensible.
 * - Returns a deep-cloned scaled recipe with meta.scale & meta.yield updated.
 * @param {RecipeLike} recipe
 * @param {ScaleOptions} options
 */
export function scaleRecipe(recipe, options = {}) {
  const opts = { ...DEFAULTS, ...sanitize(options) };
  const { factor, method } = computeScaleFactor(recipe, opts);

  const out = clone(recipe);
  out.meta = out.meta || {};
  out.meta.scale = { factor, method, notes: [] };

  // Ingredients
  if (Array.isArray(out.ingredients)) {
    out.ingredients = out.ingredients.map((ing) =>
      scaleIngredient(ing, factor, {
        adjustSeasoning: opts.adjustSeasoning,
        limitDecimals: opts.limitDecimals,
        preserveTextQty: opts.preserveTextQty,
        notePrefix: opts.notePrefix,
        metaNotes: out.meta.scale.notes,
      })
    );
  }

  // Instructions timing
  if (opts.adjustTiming && Array.isArray(out.instructions)) {
    out.instructions = out.instructions.map((ins) => scaleInstruction(ins, factor, recipe));
  }

  // Yield recompute
  const est = estimateRecipeYield(out);
  out.meta.yield = {
    servings: opts.toServings ?? recipe?.meta?.servings ?? undefined,
    totalWeightG: est.totalWeightG || undefined,
    totalVolumeMl: est.totalVolumeMl || undefined,
  };

  // Collect non-empty notes
  out.meta.scale.notes = out.meta.scale.notes.filter(Boolean);

  // Emit optional analytics (safe/no-op if eventBus not wired)
  try {
    emit?.({
      type: "recipe.scaled",
      ts: new Date().toISOString(),
      source: "cooking.scaleAndYield",
      data: { id: recipe?.id, factor, method }
    });
  } catch {}

  return out;
}

/* -------------------------- Ingredient Scaling Core ----------------------- */

function scaleIngredient(ing, factor, ctx) {
  const node = clone(ing || {});
  // Parse qty if string
  const parsed = parseQty(node.qty);
  let note = "";

  if (parsed.kind === "range") {
    const lo = applyRules(node, parsed.min, factor, ctx);
    const hi = applyRules(node, parsed.max, factor, ctx);
    node.qty = `${fmt(lo.qty, ctx.limitDecimals)}–${fmt(hi.qty, ctx.limitDecimals)}`;
    if (lo.notes || hi.notes) note = [lo.notes, hi.notes].filter(Boolean).join("; ");
  } else if (parsed.kind === "numeric") {
    const res = applyRules(node, parsed.value, factor, ctx);
    node.qty = fmt(res.qty, ctx.limitDecimals);
    if (res.notes) note = res.notes;
  } else {
    // Non-numeric (e.g., "to taste") — preserve and append scale hint
    if (ctx.preserveTextQty) {
      note = `Scale by ×${round(factor, 2)} (${node.qty})`;
    } else {
      // try leave qty untouched
      note = `Consider scaling ×${round(factor, 2)}`;
    }
  }

  if (note) {
    node.meta = node.meta || {};
    node.meta.scaleNote = ctx.notePrefix + " " + note;
    ctx.metaNotes?.push(`${node.name}: ${note}`);
  }

  return node;
}

function applyRules(ing, qty, factor, ctx) {
  const u = canonUnit(ing.unit);
  let scaledQty = qty * factor;
  let ruleNote = "";

  if (ctx.adjustSeasoning) {
    for (const rule of ING_RULES) {
      if (safeCall(rule.match, ing)) {
        const res = safeCall(rule.apply, { qty: scaledQty, unit: u, scale: factor, recipe: null, ingredient: ing }) || {};
        if (Number.isFinite(res.qty)) scaledQty = res.qty;
        if (res.notes) ruleNote = res.notes;
      }
    }
  }

  return { qty: scaledQty, notes: ruleNote };
}

/* -------------------------- Instruction Time Scaling ---------------------- */

function scaleInstruction(ins, factor, recipe) {
  const node = clone(ins || {});
  if (!Number.isFinite(node.durationSec)) return node;

  // Heuristics: decide which curve to apply
  const t = (node.text || "").toLowerCase();
  let curve = null;

  if (/\b(bake|loaf|cake|bread|brownie|roast)\b/.test(t) || recipe?.meta?.pan) {
    curve = "time.bake";
  } else if (/\b(stew|soup|simmer|braise|sauce|stock)\b/.test(t)) {
    curve = "time.batch";
  }

  if (!curve) {
    // Light touch: tiny batches scale almost linearly for short operations (mix, whisk)
    const adj = 0.05 * (factor - 1); // +/-5% per ×1.0
    node.durationSec = clampInt(Math.round(node.durationSec * (1 + adj)), 5, 8 * 3600);
    return node;
  }

  const timeScale = evalCurve(curve, factor);
  node.durationSec = clampInt(Math.round(node.durationSec * timeScale), 5, 8 * 3600);
  node.meta = node.meta || {};
  node.meta = { ...node.meta, scaledByCurve: curve, scaleFactor: factor, timeScale };
  return node;
}

/* ------------------------------ Yield Estimate ---------------------------- */

/**
 * Estimate total weight (g) and volume (ml) based on ingredients and units.
 * Uses density bridge where possible; otherwise approximates or skips.
 */
export function estimateRecipeYield(recipe) {
  let totalG = 0;
  let totalMl = 0;

  for (const ing of recipe?.ingredients || []) {
    const { qty, unit } = normalizeQtyUnit(ing);
    if (!Number.isFinite(qty)) continue;

    const cu = canonUnit(unit);
    const u = UNIT[cu];

    if (!u) {
      // Unknown unit → attempt to interpret by density (assume volume if liquid-like keywords)
      const dens = lookupDensity(ing.name);
      if (!dens) continue;
      // treat as mass by default with density mapping via ml<->g
      totalG += qty; // assume qty already in grams if author wrote "g" but unit missing
      continue;
    }

    if (u.type === "mass") {
      totalG += toBase(qty, cu).qty;
    } else if (u.type === "vol") {
      totalMl += toBase(qty, cu).qty;
    } else if (u.type === "count") {
      // crude estimate: try density if available with default piece volumes (skip otherwise)
      continue;
    }
  }

  // If we have only one of (g/ml), try to translate with an average stew density ~1.02 g/ml
  if (totalG === 0 && totalMl > 0) {
    const stewDens = 1.02;
    totalG = mlToG(totalMl, stewDens);
  } else if (totalMl === 0 && totalG > 0) {
    const stewDens = 1.02;
    totalMl = gToMl(totalG, stewDens);
  }

  return {
    totalWeightG: Math.round(totalG),
    totalVolumeMl: Math.round(totalMl),
  };
}

/* ------------------------------- Utilities -------------------------------- */

function normalizeQtyUnit(ing) {
  const parsed = parseQty(ing?.qty);
  const qty = parsed.kind === "numeric" ? parsed.value : NaN;
  const unit = canonUnit(ing?.unit);
  return { qty, unit };
}

function parseQty(q) {
  if (q == null || q === "") return { kind: "none" };
  if (typeof q === "number" && isFinite(q)) return { kind: "numeric", value: q };
  const s = String(q).trim();

  // range "1-2" or "1–2"
  const m = s.match(/^(\d*\.?\d+)\s*(?:-|–|—|to)\s*(\d*\.?\d+)\s*$/i);
  if (m) return { kind: "range", min: parseFloat(m[1]), max: parseFloat(m[2]) };

  // vulgar fraction "1 1/2"
  const f = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (f) return { kind: "numeric", value: parseInt(f[1], 10) + parseInt(f[2], 10) / parseInt(f[3], 10) };

  // simple fraction "3/4"
  const sf = s.match(/^(\d+)\/(\d+)$/);
  if (sf) return { kind: "numeric", value: parseInt(sf[1], 10) / parseInt(sf[2], 10) };

  // numeric token
  const n = parseFloat(s);
  if (isFinite(n)) return { kind: "numeric", value: n };

  // text ("to taste", "pinch", etc.)
  return { kind: "text", value: s };
}

function fmt(n, places = 2) {
  return Number(n.toFixed(places)).toString();
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}
function clampInt(n, min, max) {
  const v = Math.round(Number(n) || 0);
  return Math.min(Math.max(v, min), max);
}

function round(n, places = 2) {
  const p = Math.pow(10, places);
  return Math.round(n * p) / p;
}

function sanitize(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function clone(v) {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

/* --------------------------- Formatter Extension -------------------------- */

let FORMATTERS = {
  qtyFormatter: (n, places) => fmt(n, places),
};

/** Optional: allow UI to set a custom formatter (e.g., 1.333 → "1⅓") */
export function setFormatters(fns = {}) {
  FORMATTERS = { ...FORMATTERS, ...sanitize(fns) };
}

/* ------------------------------- Snapshots -------------------------------- */

export function snapshotYieldCurves() {
  return Array.from(YIELD_CURVES.keys());
}

/* --------------------------------- Export --------------------------------- */

export default {
  // main
  scaleRecipe,
  computeScaleFactor,
  estimateRecipeYield,
  // extension
  registerYieldCurve,
  registerIngredientRule,
  registerDensity,
  setFormatters,
  snapshotYieldCurves,
};
