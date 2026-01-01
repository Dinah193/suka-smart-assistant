/* eslint-disable no-console */
// utils/units.js — canonical units, parsing, conversions, unit pricing
// Style: small, dependency-light, safe-by-default; JSDoc for DX.
// Families: mass, volume, length, count (ea/ct), area (limited), time (for schedules)

const UNIT = {
  // Mass (base: g)
  g: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  oz: 'oz', ounce: 'oz', ounces: 'oz',

  // Volume (base: ml)
  ml: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', liter: 'l', liters: 'l',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  floz: 'floz', 'fl oz': 'floz', 'fl-oz': 'floz', 'fl.oz': 'floz',
  cup: 'cup', cups: 'cup',
  pt: 'pt', pint: 'pt', pints: 'pt',
  qt: 'qt', quart: 'qt', quarts: 'qt',
  gal: 'gal', gallon: 'gal', gallons: 'gal',

  // Length (base: m)
  mm: 'mm', millimeter: 'mm', millimeters: 'mm',
  cm: 'cm', centimeter: 'cm', centimeters: 'cm',
  m: 'm', meter: 'm', meters: 'm',
  in: 'in', inch: 'in', inches: 'in',
  ft: 'ft', foot: 'ft', feet: 'ft',

  // Count / items
  ea: 'ea', each: 'ea',
  ct: 'ea', count: 'ea', pk: 'ea', pack: 'ea', packs: 'ea', piece: 'ea', pieces: 'ea', pc: 'ea', pcs: 'ea',

  // Area (limited; base: m2)
  'in2': 'in2', sqin: 'in2', 'sq in': 'in2', 'square inch': 'in2',
  'ft2': 'ft2', sqft: 'ft2', 'sq ft': 'ft2', 'square foot': 'ft2',
  'm2': 'm2', sqm: 'm2', 'sq m': 'm2', 'square meter': 'm2',
};

const FAMILY = {
  MASS: 'mass',
  VOLUME: 'volume',
  LENGTH: 'length',
  COUNT: 'count',
  AREA: 'area',
};

const UNIT_FAMILY = {
  // Mass
  g: FAMILY.MASS, kg: FAMILY.MASS, lb: FAMILY.MASS, oz: FAMILY.MASS,
  // Volume
  ml: FAMILY.VOLUME, l: FAMILY.VOLUME, tsp: FAMILY.VOLUME, tbsp: FAMILY.VOLUME, floz: FAMILY.VOLUME,
  cup: FAMILY.VOLUME, pt: FAMILY.VOLUME, qt: FAMILY.VOLUME, gal: FAMILY.VOLUME,
  // Length
  mm: FAMILY.LENGTH, cm: FAMILY.LENGTH, m: FAMILY.LENGTH, in: FAMILY.LENGTH, ft: FAMILY.LENGTH,
  // Count
  ea: FAMILY.COUNT,
  // Area
  in2: FAMILY.AREA, ft2: FAMILY.AREA, m2: FAMILY.AREA,
};

// Base units per family (for factors table below)
const BASE = {
  [FAMILY.MASS]: 'g',
  [FAMILY.VOLUME]: 'ml',
  [FAMILY.LENGTH]: 'm',
  [FAMILY.COUNT]: 'ea',
  [FAMILY.AREA]: 'm2',
};

// Factors to base units
const FACTOR_TO_BASE = {
  // MASS → g
  g: 1,
  kg: 1000,
  lb: 453.59237,
  oz: 28.349523125,

  // VOLUME → ml (US customary)
  ml: 1,
  l: 1000,
  tsp: 4.92892159375,      // US teaspoon
  tbsp: 14.78676478125,    // US tablespoon
  floz: 29.5735295625,     // US fluid ounce
  cup: 236.5882365,
  pt: 473.176473,
  qt: 946.352946,
  gal: 3785.411784,

  // LENGTH → m
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,

  // COUNT → ea
  ea: 1,

  // AREA → m2
  in2: 0.00064516,
  ft2: 0.09290304,
  m2: 1,
};

// Pretty symbols (for formatting)
const SYMBOL = {
  g: 'g', kg: 'kg', lb: 'lb', oz: 'oz',
  ml: 'mL', l: 'L', tsp: 'tsp', tbsp: 'Tbsp', floz: 'fl oz',
  cup: 'cup', pt: 'pt', qt: 'qt', gal: 'gal',
  mm: 'mm', cm: 'cm', m: 'm', in: 'in', ft: 'ft',
  ea: 'ea',
  in2: 'in²', ft2: 'ft²', m2: 'm²',
};

// Common density map for cross-family conversion (g per ml)
// (Approximate; callers can override via options.density or provide per-item density)
const DENSITY_G_PER_ML = {
  water: 1.0,
  milk: 1.03,
  'olive oil': 0.91,
  honey: 1.42,
  'white sugar': 0.85,
  'brown sugar': 0.93,
  flour: 0.52, // all-purpose, sifted
  rice: 0.85,  // uncooked
};

/** Normalize free-form unit label to canonical form (e.g., "OZ.", "ounces" → "oz"). */
export function normalizeUnit(u) {
  if (!u) return null;
  const s = String(u).trim().toLowerCase()
    .replace(/per\s+/g, '')         // strip "per"
    .replace(/[^a-z0-9. ]+/g, ' ')  // remove symbols
    .replace(/\s+/g, ' ')           // collapse
    .trim();
  // Special cases
  if (s === 'ct' || s === 'count') return 'ea';
  if (s === 'dozen' || s === 'dz') return 'ea'; // keep as each; caller may multiply quantity by 12
  // Try direct lookup
  if (UNIT[s]) return UNIT[s];
  // Handle dot/period variants
  const dotless = s.replace(/\./g, '');
  if (UNIT[dotless]) return UNIT[dotless];
  // Try stripping plural 's'
  if (UNIT[s.replace(/s$/, '')]) return UNIT[s.replace(/s$/, '')];
  // Common alternates
  const map = { 'fluid ounce': 'floz', 'fluid ounces': 'floz', 'fl oz': 'floz', 'fl-oz': 'floz' };
  if (map[s]) return map[s];
  return null;
}

/** Get family for a canonical unit. */
export function getFamily(unit) {
  const u = normalizeUnit(unit) || unit;
  return UNIT_FAMILY[u] || null;
}

/** True if units are in the same family (or convertible across mass/volume with density provided). */
export function isCommensurate(fromUnit, toUnit, { allowDensityBridge = false } = {}) {
  const fFam = getFamily(fromUnit);
  const tFam = getFamily(toUnit);
  if (!fFam || !tFam) return false;
  if (fFam === tFam) return true;
  if (allowDensityBridge && ((fFam === FAMILY.MASS && tFam === FAMILY.VOLUME) || (fFam === FAMILY.VOLUME && tFam === FAMILY.MASS))) {
    return true;
  }
  return false;
}

/** Convert a quantity to its base unit for its family. Returns { value, unit }. */
export function toBase(value, unit) {
  const u = normalizeUnit(unit);
  if (!u || FACTOR_TO_BASE[u] == null) throw new Error(`Unknown unit: ${unit}`);
  const fam = getFamily(u);
  const base = BASE[fam];
  return { value: Number(value) * FACTOR_TO_BASE[u], unit: base };
}

/**
 * Convert between units. Cross-family mass↔volume requires density (g/mL).
 * options: { density, densityKey } — density overrides DENSITY_G_PER_ML, else defaults to water when bridging.
 */
export function convert(value, fromUnit, toUnit, options = {}) {
  const fu = normalizeUnit(fromUnit);
  const tu = normalizeUnit(toUnit);
  if (!fu || !tu) throw new Error(`Unknown unit(s): ${fromUnit} → ${toUnit}`);

  const fFam = getFamily(fu);
  const tFam = getFamily(tu);

  if (fFam === tFam) {
    const baseFrom = FACTOR_TO_BASE[fu];
    const baseTo = FACTOR_TO_BASE[tu];
    if (baseFrom == null || baseTo == null) throw new Error(`No factor for ${fu} or ${tu}`);
    // value_in_base / baseTo = value_in_target
    return (Number(value) * baseFrom) / baseTo;
  }

  // Bridge MASS ↔ VOLUME using density (g/mL)
  const density = resolveDensity(options);
  if (density == null) {
    throw new Error(`Cannot convert ${fromUnit} ↔ ${toUnit} without density (g/mL).`);
  }

  if (fFam === FAMILY.MASS && tFam === FAMILY.VOLUME) {
    // mass (g) → volume (mL) : m(g) / density(g/mL) → mL
    const gVal = convert(value, fu, 'g'); // recurse within-family
    const mlVal = gVal / density;
    return convert(mlVal, 'ml', tu);
  }
  if (fFam === FAMILY.VOLUME && tFam === FAMILY.MASS) {
    // volume (mL) → mass (g) : v(mL) * density(g/mL) → g
    const mlVal = convert(value, fu, 'ml');
    const gVal = mlVal * density;
    return convert(gVal, 'g', tu);
  }

  throw new Error(`Incompatible unit families: ${fromUnit} → ${toUnit}`);
}

function resolveDensity({ density, densityKey } = {}) {
  if (Number.isFinite(density)) return Number(density);
  if (densityKey && DENSITY_G_PER_ML[densityKey?.toLowerCase?.()]) {
    return DENSITY_G_PER_ML[densityKey.toLowerCase()];
  }
  // Safe default when bridging: water
  return 1.0;
}

/** Choose a human-friendly display unit for a value+unit. */
export function chooseDisplayUnit(value, unit, { domain = 'grocery' } = {}) {
  const u = normalizeUnit(unit);
  const fam = getFamily(u);
  if (!fam) return { value, unit };

  const v = Number(value);

  if (fam === FAMILY.MASS) {
    if (v >= 1000 && u !== 'kg') return { value: +(convert(v, u, 'kg').toFixed(2)), unit: 'kg' };
    if (v < 100 && (u === 'kg' || u === 'g')) {
      const ozVal = convert(v, u, 'oz');
      if (ozVal >= 1 && ozVal < 32) return { value: +ozVal.toFixed(2), unit: 'oz' };
    }
    return { value: +(convert(v, u, 'g').toFixed(0)), unit: 'g' };
  }

  if (fam === FAMILY.VOLUME) {
    if (v >= 1000 && u !== 'l') return { value: +(convert(v, u, 'l').toFixed(2)), unit: 'l' };
    const cupVal = convert(v, u, 'cup');
    if (cupVal >= 1 && cupVal < 8) return { value: +cupVal.toFixed(2), unit: 'cup' };
    return { value: +(convert(v, u, 'ml').toFixed(0)), unit: 'ml' };
  }

  if (fam === FAMILY.LENGTH) {
    const mVal = convert(v, u, 'm');
    if (mVal >= 1) return { value: +mVal.toFixed(2), unit: 'm' };
    const inVal = convert(v, u, 'in');
    if (inVal >= 1 && inVal < 48) return { value: +inVal.toFixed(2), unit: 'in' };
    return { value: +mVal.toFixed(3), unit: 'm' };
  }

  if (fam === FAMILY.AREA) {
    const m2Val = convert(v, u, 'm2');
    if (m2Val >= 1) return { value: +m2Val.toFixed(2), unit: 'm2' };
    const ft2Val = convert(v, u, 'ft2');
    if (ft2Val >= 1 && ft2Val < 2000) return { value: +ft2Val.toFixed(1), unit: 'ft2' };
    return { value: +m2Val.toFixed(3), unit: 'm2' };
  }

  return { value: v, unit: 'ea' };
}

/** Format quantity with a nice symbol and trimmed decimals. */
export function formatQuantity(value, unit) {
  const u = normalizeUnit(unit) || unit;
  const sym = SYMBOL[u] || u || '';
  const v = Number(value);
  const s = Math.abs(v) >= 100 ? v.toFixed(0)
          : Math.abs(v) >= 10  ? v.toFixed(1)
          : Math.abs(v) >= 1   ? v.toFixed(2)
          : v.toFixed(3);
  return `${trimZeros(s)} ${sym}`.trim();
}
const trimZeros = (s) => s.replace(/(\.\d*?[1-9])0+$/,'$1').replace(/\.0+$/,'');

/**
 * Parse common package descriptors:
 *  "16 oz", "1.5 lb", "2 x 16 oz", "2x16oz", "4-pack (12 fl oz)", "12 ct"
 * Returns:
 *  { count, qty, unit, totalQty, totalUnit, raw }
 * - count defaults to 1
 * - "ct"/"ea" will set unit 'ea' and interpret qty accordingly
 */
export function parsePackageSize(s) {
  if (!s) return null;
  const raw = String(s).trim();

  // Examples:
  // 2 x 16 oz
  let m = raw.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z. ]+)$/i);
  if (m) {
    const count = Number(m[1]);
    const qty = Number(m[2]);
    const unit = normalizeUnit(m[3]);
    if (!unit) return null;
    const totalQty = qty * count;
    return { count, qty, unit, totalQty, totalUnit: unit, raw };
  }

  // 4-pack (12 fl oz)
  m = raw.match(/^(\d+)\s*(?:pack|pk)?\s*\(\s*(\d+(?:\.\d+)?)\s*([a-zA-Z. ]+)\s*\)$/i);
  if (m) {
    const count = Number(m[1]);
    const qty = Number(m[2]);
    const unit = normalizeUnit(m[3]);
    if (!unit) return null;
    return { count, qty, unit, totalQty: qty * count, totalUnit: unit, raw };
  }

  // 2x16oz (no spaces)
  m = raw.match(/^(\d+)[x×](\d+(?:\.\d+)?)([a-zA-Z.]+)$/i);
  if (m) {
    const count = Number(m[1]);
    const qty = Number(m[2]);
    const unit = normalizeUnit(m[3]);
    if (!unit) return null;
    return { count, qty, unit, totalQty: qty * count, totalUnit: unit, raw };
  }

  // 12 ct / 12 count
  m = raw.match(/^(\d+(?:\.\d+)?)\s*(?:ct|count|ea)$/i);
  if (m) {
    const count = Number(m[1]);
    return { count, qty: 1, unit: 'ea', totalQty: count, totalUnit: 'ea', raw };
  }

  // Simple "16 oz" or "1.5 lb"
  m = raw.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z. ]+)$/i);
  if (m) {
    const qty = Number(m[1]);
    const unit = normalizeUnit(m[2]);
    if (!unit) return null;
    return { count: 1, qty, unit, totalQty: qty, totalUnit: unit, raw };
  }

  return null;
}

/**
 * Compute unit price.
 * Inputs:
 *  - price (number)
 *  - qty (number) & unit (string) OR package string (e.g., "2x16oz")
 *  - targetUnit (optional; default wise for family)
 *  - options: { density, densityKey, per: 1|100|1000 } to compute per-100g, etc.
 */
export function unitPrice({
  price,
  qty = null,
  unit = null,
  packageDescriptor = null,
  targetUnit = null,
  options = {},
}) {
  if (price == null) return null;

  let totalQty, totalUnit;

  if (packageDescriptor) {
    const parsed = parsePackageSize(packageDescriptor);
    if (!parsed) return null;
    totalQty = parsed.totalQty;
    totalUnit = parsed.totalUnit;
  } else {
    if (qty == null || !unit) return null;
    totalQty = Number(qty);
    totalUnit = normalizeUnit(unit);
  }

  if (totalQty <= 0) return null;

  const fam = getFamily(totalUnit);
  // Choose default target per-family
  if (!targetUnit) {
    targetUnit = fam === FAMILY.MASS   ? 'g'
               : fam === FAMILY.VOLUME ? 'ml'
               : fam === FAMILY.LENGTH ? 'm'
               : fam === FAMILY.AREA   ? 'm2'
               : 'ea';
  }

  // Convert quantity into target unit
  let qtyInTarget;
  try {
    qtyInTarget = convert(totalQty, totalUnit, targetUnit, options);
  } catch (e) {
    // Attempt mass↔volume bridge with density fallback
    if ((fam === FAMILY.MASS || fam === FAMILY.VOLUME) &&
        (getFamily(targetUnit) === FAMILY.MASS || getFamily(targetUnit) === FAMILY.VOLUME)) {
      qtyInTarget = convert(totalQty, totalUnit, targetUnit, { density: resolveDensity(options) });
    } else {
      return null;
    }
  }

  if (!Number.isFinite(qtyInTarget) || qtyInTarget <= 0) return null;

  // Per (1|100|1000) convenience (e.g., per 100g labeling)
  const per = Number(options.per || 1);
  const denom = qtyInTarget / per;
  return price / denom;
}

/** Compare two items by normalized price per targetUnit (ascending). */
export function compareUnitPrices(a, b, { targetUnit = null, options = {} } = {}) {
  const pa = unitPrice({ ...a, targetUnit, options });
  const pb = unitPrice({ ...b, targetUnit, options });
  if (pa == null && pb == null) return 0;
  if (pa == null) return 1;
  if (pb == null) return -1;
  return pa - pb;
}

/** Parse “$1.99 / lb”, “2.49 per 100 g”, returns { price, unit, per } */
export function parsePricePerTag(s) {
  if (!s) return null;
  const raw = String(s).trim().toLowerCase();
  // $1.99 / lb
  let m = raw.match(/([$€£]?)(\d+(?:\.\d+)?)\s*(?:\/|per)\s*(\d+)?\s*([a-zA-Z. ]+)/);
  if (!m) return null;
  const price = Number(m[2]);
  const perNum = m[3] ? Number(m[3]) : 1;
  const unit = normalizeUnit(m[4]);
  if (!unit) return null;
  return { price, unit, per: perNum };
}

/** Human readable “$X.XX / unit” (optionally per 100g style). */
export function formatUnitPrice(value, unit, { currency = 'USD', per = 1 } = {}) {
  if (value == null) return '–';
  const sym = (currency === 'USD' ? '$' : '');
  const priceStr = `${sym}${Number(value).toFixed(2)}`;
  const u = SYMBOL[normalizeUnit(unit) || unit] || unit || '';
  return per && per !== 1 ? `${priceStr} / ${per} ${u}` : `${priceStr} / ${u}`;
}

/** Expose density map for UI hints; allow override injection upstream. */
export function getKnownDensities() {
  return { ...DENSITY_G_PER_ML };
}

/** Simple helper to multiply count units like “dozen” upstream if needed. */
export function multiplyCount(qty, maybeDozen = false) {
  if (!maybeDozen) return qty;
  return Number(qty) * 12;
}

/** Quick boolean check for unit support. */
export function isUnitKnown(u) {
  const n = normalizeUnit(u);
  return !!(n && UNIT_FAMILY[n]);
}

/** Export families (useful for validators / schemas) */
export const UnitFamily = { ...FAMILY };

/** Suggest the best target unit per family for price normalization. */
export function defaultTargetUnitFor(unit) {
  const fam = getFamily(unit);
  switch (fam) {
    case FAMILY.MASS: return 'g';
    case FAMILY.VOLUME: return 'ml';
    case FAMILY.LENGTH: return 'm';
    case FAMILY.AREA: return 'm2';
    case FAMILY.COUNT:
    default: return 'ea';
  }
}

/** Safe divide helper for internal math. */
export function safeDivide(n, d) {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

// ---------- Integration helpers for your pipeline ----------

/**
 * Glue for PricebookDB.addObservation: compute and attach unitPrice if possible.
 * Returns { unitPrice, normalizedUnit } or { unitPrice: null } if unknown.
 */
export function computeObservationUnitPrice({ price, qty, unit, packageSize, options = {} }) {
  let descriptor = null;
  if (packageSize && typeof packageSize === 'string') {
    descriptor = packageSize;
  }
  const normalizedUnit = normalizeUnit(unit) || (descriptor ? (parsePackageSize(descriptor)?.totalUnit || null) : null);
  const up = unitPrice({
    price,
    qty: qty ?? (parsePackageSize(descriptor || '')?.totalQty || null),
    unit: normalizedUnit,
    packageDescriptor: descriptor,
    targetUnit: defaultTargetUnitFor(normalizedUnit || 'ea'),
    options,
  });
  return { unitPrice: up, normalizedUnit };
}

/**
 * Glue for compare tables: returns a normalized “per X” tuple for UI chips.
 * Prefer per 100g/100ml when values are small to match well-executed grocer UIs.
 */
export function normalizedPriceChip({ price, qty, unit, packageDescriptor, densityKey }) {
  const nUnit = normalizeUnit(unit) || (parsePackageSize(packageDescriptor || '')?.totalUnit || null);
  if (!nUnit) return { value: null, unit: null, per: 1, label: '–' };

  const fam = getFamily(nUnit);
  const per = (fam === FAMILY.MASS || fam === FAMILY.VOLUME) ? 100 : 1;
  const targetUnit = fam === FAMILY.MASS ? 'g'
                    : fam === FAMILY.VOLUME ? 'ml'
                    : fam === FAMILY.LENGTH ? 'm'
                    : fam === FAMILY.AREA ? 'm2'
                    : 'ea';

  const value = unitPrice({
    price, qty, unit: nUnit, packageDescriptor, targetUnit, options: { per, densityKey }
  });
  return {
    value,
    unit: targetUnit,
    per,
    label: value == null ? '–' : formatUnitPrice(value, targetUnit, { per }),
  };
}

export default {
  normalizeUnit,
  getFamily,
  isCommensurate,
  toBase,
  convert,
  chooseDisplayUnit,
  formatQuantity,
  parsePackageSize,
  unitPrice,
  compareUnitPrices,
  parsePricePerTag,
  formatUnitPrice,
  getKnownDensities,
  multiplyCount,
  isUnitKnown,
  UnitFamily,
  defaultTargetUnitFor,
  safeDivide,
  computeObservationUnitPrice,
  normalizedPriceChip,
};
