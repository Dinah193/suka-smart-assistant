/* eslint-disable no-console */
// utils/unitConversion.js — module-aware unit & recipe utilities for Suka
// - Mass/Volume/Length/Area/Temperature conversions
// - Volume↔Weight by density (ingredient-aware; extensible registry)
// - Kitchen fraction parsing ("1 1/2", "¾", "½") + tolerant unit aliases
// - Cleaning dilutions (v/v %, w/v %, ppm, ratio) with solver
// - Garden application rates (lb/1000 sq ft ↔ g/m²), seed spacing helpers
// - Animals feed rates (lb/head/day ↔ kg/animal/day)
// - Baker's % helpers (hydration, prefer grams)
// - Event hooks + "favorite preset" saver (PlanStorageRouter/useFavoritePlans/localStorage)
// - ESM/CJS friendly, browser-safe, defensive

const isBrowser = typeof window !== "undefined";
const toISO = (ts) => new Date(ts || Date.now()).toISOString();

const safeJSON = {
  parse: (s, f = null) => {
    try {
      return JSON.parse(s);
    } catch {
      return f;
    }
  },
  stringify: (o) => {
    try {
      return JSON.stringify(o);
    } catch {
      return "{}";
    }
  },
};

/* --------------------------- defensive dependencies ------------------------ */
let eventBus = { on() {}, off() {}, emit() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let PlanStorageRouter = null;
try {
  PlanStorageRouter = require("@/services/plans/PlanStorageRouter").default;
} catch (_e) {}

let useFavoritePlans = null;
try {
  useFavoritePlans = require("@/hooks/useFavoritePlans").default;
} catch (_e) {}

/* --------------------------------- aliases --------------------------------- */
const FRACTIONS = {
  "¼": 0.25,
  "½": 0.5,
  "¾": 0.75,
  "⅐": 1 / 7,
  "⅑": 1 / 9,
  "⅒": 0.1,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅕": 0.2,
  "⅖": 0.4,
  "⅗": 0.6,
  "⅘": 0.8,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
};
const MASS = {
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilogram: 1000,
  kilograms: 1000,
  mg: 0.001,
  milligram: 0.001,
  milligrams: 0.001,
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
  pounds: 453.59237,
  oz: 28.349523125,
  ounce: 28.349523125,
  ounces: 28.349523125,
};
const VOLUME = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  l: 1000,
  liter: 1000,
  liters: 1000,
  tsp: 4.92892159375,
  teaspoon: 4.92892159375,
  teaspoons: 4.92892159375,
  tbsp: 14.78676478125,
  tablespoon: 14.78676478125,
  tablespoons: 14.78676478125,
  "fl-oz": 29.5735295625,
  floz: 29.5735295625,
  "fl oz": 29.5735295625,
  cup: 236.5882365,
  cups: 236.5882365,
  pt: 473.176473,
  pint: 473.176473,
  pints: 473.176473,
  qt: 946.352946,
  quart: 946.352946,
  quarts: 946.352946,
  gal: 3785.411784,
  gallon: 3785.411784,
  gallons: 3785.411784,
};
const LENGTH = {
  mm: 1,
  millimeter: 1,
  millimeters: 1,
  cm: 10,
  centimeter: 10,
  centimeters: 10,
  m: 1000,
  meter: 1000,
  meters: 1000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  '"': 25.4,
  ft: 304.8,
  foot: 304.8,
  feet: 304.8,
  "'": 304.8,
  yd: 914.4,
  yard: 914.4,
  yards: 914.4,
};
const AREA = {
  m2: 1,
  sqm: 1,
  "sq m": 1,
  "square meter": 1,
  "square meters": 1,
  cm2: 1 / 10000,
  "sq cm": 1 / 10000,
  mm2: 1 / 1e6,
  "sq mm": 1 / 1e6,
  ft2: 0.09290304,
  sqft: 0.09290304,
  "sq ft": 0.09290304,
  "square foot": 0.09290304,
  "square feet": 0.09290304,
  yd2: 0.83612736,
  sqyd: 0.83612736,
  "sq yd": 0.83612736,
  acre: 4046.8564224,
  acres: 4046.8564224,
  hectare: 10000,
  hectares: 10000,
  ha: 10000,
}; // all to m²

/* -------------------------- ingredient density store ----------------------- */
// grams per milliliter (g/mL). Water = 1.00. Values are approximate.
const density = new Map(
  Object.entries({
    water: 1.0,
    milk: 1.035,
    oil: 0.92,
    olive_oil: 0.918,
    butter_melted: 0.911,
    honey: 1.42,
    maple_syrup: 1.32,
    sugar_granulated: 0.845, // ~200 g/cup
    sugar_brown_packed: 0.96, // ~220 g/cup
    flour_ap: 0.53, // ~125 g/cup
    flour_ww: 0.56, // ~133 g/cup
    salt_kosher: 0.72, // varies by brand
    salt_fine: 1.2,
    cocoa_powder: 0.5,
    oats_rolled: 0.4,
    rice_dry: 0.85,
  })
);

function registerDensity(name, gramsPerMl) {
  try {
    density.set(String(name).toLowerCase(), Number(gramsPerMl));
  } catch (_e) {}
  return true;
}
function getDensity(name, fallback = 1.0) {
  if (!name) return fallback;
  const key = String(name).toLowerCase().replace(/\s+/g, "_");
  return density.get(key) ?? fallback;
}

/* ------------------------------ parsing helpers ---------------------------- */
function parseNumberLike(input) {
  if (typeof input === "number") return input;
  let s = String(input || "").trim();
  // replace unicode fractions
  s = s.replace(/[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (m) => FRACTIONS[m]);
  // mixed numbers "1 1/2"
  const mixed = s.match(/^(-?\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const whole = parseFloat(mixed[1]);
    const num = parseFloat(mixed[2]);
    const den = parseFloat(mixed[3] || 1);
    return whole + (den ? num / den : 0);
  }
  // simple fraction "3/4"
  const frac = s.match(/^(-?\d+)\/(\d+)$/);
  if (frac) return parseFloat(frac[1]) / parseFloat(frac[2] || 1);
  // numeric
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function normalizeUnit(u) {
  if (!u) return null;
  const s = String(u).trim().toLowerCase().replace(/\./g, "");
  if (MASS[s] != null) return { kind: "mass", unit: s };
  if (VOLUME[s] != null) return { kind: "volume", unit: s };
  if (LENGTH[s] != null) return { kind: "length", unit: s };
  if (AREA[s] != null) return { kind: "area", unit: s };
  if (["c", "°c", "degc", "celcius", "celsius"].includes(s))
    return { kind: "temp", unit: "C" };
  if (["f", "°f", "degf", "fahrenheit"].includes(s))
    return { kind: "temp", unit: "F" };
  if (["k", "kelvin"].includes(s)) return { kind: "temp", unit: "K" };
  // common kitchen shorthands
  if (["t", "tsp."].includes(s)) return { kind: "volume", unit: "tsp" };
  if (["T", "tbsp.", "tbs"].map((x) => x.toLowerCase()).includes(s))
    return { kind: "volume", unit: "tbsp" };
  if (["fl oz", "floz"].includes(s)) return { kind: "volume", unit: "fl-oz" };
  return null;
}

/* ---------------------------- core conversions ----------------------------- */
function convertMass(value, from, to) {
  const v = parseNumberLike(value);
  const a = MASS[from];
  const b = MASS[to];
  if (a == null || b == null) throw new Error("Unsupported mass unit");
  return (v * a) / b;
}

function convertVolume(value, from, to) {
  const v = parseNumberLike(value);
  const a = VOLUME[from];
  const b = VOLUME[to];
  if (a == null || b == null) throw new Error("Unsupported volume unit");
  return (v * a) / b;
}

function convertLength(value, from, to) {
  const v = parseNumberLike(value);
  const a = LENGTH[from];
  const b = LENGTH[to];
  if (a == null || b == null) throw new Error("Unsupported length unit");
  return (v * a) / b;
}

function convertArea(value, from, to) {
  const v = parseNumberLike(value);
  const a = AREA[from];
  const b = AREA[to];
  if (a == null || b == null) throw new Error("Unsupported area unit");
  // Here AREA maps → m² factors. To convert: v*from_m2 / to_m2
  const inM2 = v * a;
  return inM2 / b;
}

function convertTemp(value, from, to) {
  const v = parseNumberLike(value);
  const f = from.toUpperCase(),
    t = to.toUpperCase();
  let c;
  if (f === "C") c = v;
  else if (f === "F") c = ((v - 32) * 5) / 9;
  else if (f === "K") c = v - 273.15;
  else throw new Error("Unsupported temperature unit");
  if (t === "C") return c;
  if (t === "F") return (c * 9) / 5 + 32;
  if (t === "K") return c + 273.15;
  throw new Error("Unsupported temperature unit");
}

/* ------------------------- volume ↔ weight by density ---------------------- */
function volumeMlToGrams(ml, ingredientName) {
  const d = getDensity(ingredientName, 1.0);
  return parseNumberLike(ml) * d;
}
function gramsToVolumeMl(g, ingredientName) {
  const d = getDensity(ingredientName, 1.0);
  if (d === 0) return 0;
  return parseNumberLike(g) / d;
}

/* ------------------------------ public convert ----------------------------- */
/**
 * convert(value, fromUnit, toUnit, opts?)
 * - Cross-kind conversions handled for volume<->mass using density in opts.ingredient
 * - Emits "convert.completed" or "convert.failed"
 */
function convert(value, fromUnit, toUnit, opts = {}) {
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!from || !to) {
    emitFail("Unsupported unit", { value, fromUnit, toUnit });
    return { ok: false, error: "unsupported-unit" };
  }

  try {
    let result;
    if (from.kind === to.kind) {
      if (from.kind === "mass") result = convertMass(value, from.unit, to.unit);
      else if (from.kind === "volume")
        result = convertVolume(value, from.unit, to.unit);
      else if (from.kind === "length")
        result = convertLength(value, from.unit, to.unit);
      else if (from.kind === "area")
        result = convertArea(value, from.unit, to.unit);
      else if (from.kind === "temp")
        result = convertTemp(value, from.unit, to.unit);
    } else if (
      (from.kind === "volume" && to.kind === "mass") ||
      (from.kind === "mass" && to.kind === "volume")
    ) {
      // volume ↔ mass using density
      const ing = opts.ingredient || "water";
      if (from.kind === "volume") {
        const ml = convertVolume(value, from.unit, "ml");
        const g = volumeMlToGrams(ml, ing);
        result = convertMass(g, "g", to.unit);
      } else {
        const g = convertMass(value, from.unit, "g");
        const ml = gramsToVolumeMl(g, ing);
        result = convertVolume(ml, "ml", to.unit);
      }
    } else {
      throw new Error("incompatible-units");
    }

    const payload = {
      value: parseNumberLike(value),
      from: from.unit,
      to: to.unit,
      kindFrom: from.kind,
      kindTo: to.kind,
      ingredient: opts.ingredient || null,
      result,
      tsISO: toISO(),
      module: opts.module || null,
    };
    eventBus.emit?.("convert.completed", payload);
    return { ok: true, ...payload };
  } catch (e) {
    emitFail(e?.message || "convert-failed", { value, fromUnit, toUnit, opts });
    return { ok: false, error: e?.message || "convert-failed" };
  }
}

function emitFail(message, meta) {
  eventBus.emit?.("convert.failed", { message, meta, tsISO: toISO() });
}

/* ------------------------------ best-fit helpers --------------------------- */
function toBestMass(grams) {
  const g = Math.abs(grams);
  if (g >= 1000) return { value: grams / 1000, unit: "kg" };
  if (g >= 28) return { value: grams / 28.349523125, unit: "oz" };
  return { value: grams, unit: "g" };
}
function toBestVolume(ml) {
  const m = Math.abs(ml);
  if (m >= 1000) return { value: ml / 1000, unit: "l" };
  if (m >= 236.5) return { value: ml / 236.5882365, unit: "cup" };
  if (m >= 14.7) return { value: ml / 14.78676478125, unit: "tbsp" };
  if (m >= 4.93) return { value: ml / 4.92892159375, unit: "tsp" };
  return { value: ml, unit: "ml" };
}
function roundSmart(n, places = 2) {
  const p = Math.pow(10, places);
  return Math.round((Number(n) + Number.EPSILON) * p) / p;
}

/* ------------------------------ baker's math ------------------------------- */
function bakersHydration({
  flour_g,
  water_g,
  starter_water_g = 0,
  starter_flour_g = 0,
}) {
  const totalFlour = flour_g + starter_flour_g;
  const totalWater = water_g + starter_water_g;
  if (!totalFlour) return 0;
  return (totalWater / totalFlour) * 100;
}
function bakersScaleByHydration({
  flour_g,
  water_g,
  targetHydrationPct,
  keepFlour = true,
}) {
  const current = bakersHydration({ flour_g, water_g });
  if (keepFlour) {
    const targetWater = (targetHydrationPct / 100) * flour_g;
    return {
      flour_g,
      water_g: targetWater,
      delta_water_g: targetWater - water_g,
      hydrationPct: targetHydrationPct,
      currentPct: current,
    };
  }
  // keep water, adjust flour
  const targetFlour = water_g / (targetHydrationPct / 100);
  return {
    flour_g: targetFlour,
    water_g,
    delta_flour_g: targetFlour - flour_g,
    hydrationPct: targetHydrationPct,
    currentPct: current,
  };
}

/* ------------------------------ cleaning math ------------------------------ */
// Percent/ppm/ratio helpers (v/v by default)
function percentToRatio(percent) {
  return 1 / (percent / 100);
} // e.g., 2% → 50:1
function ratioToPercent(ratio) {
  return 100 / ratio;
} // 50:1 → 2%
function percentToPPM(percent) {
  return percent * 10000;
} // 1% = 10,000 ppm
function ppmToPercent(ppm) {
  return ppm / 10000;
}

function dilutionSolve({
  stockPercent,
  targetPercent,
  finalVolume,
  finalUnit = "ml",
}) {
  // C1 V1 = C2 V2  (simple v/v)
  const C1 = parseNumberLike(stockPercent);
  const C2 = parseNumberLike(targetPercent);
  if (C1 <= 0 || C2 <= 0 || C1 <= C2) throw new Error("Invalid concentrations");
  const V2 = convertVolume(
    parseNumberLike(finalVolume),
    normalizeUnit(finalUnit)?.unit || "ml",
    "ml"
  ); // → mL
  const V1_ml = (C2 / C1) * V2;
  const diluent_ml = Math.max(0, V2 - V1_ml);
  return {
    stock_ml: V1_ml,
    diluent_ml,
    final_ml: V2,
    stockBest: toBestVolume(V1_ml),
    diluentBest: toBestVolume(diluent_ml),
  };
}

/* ------------------------------- garden math ------------------------------- */
// Convert application rate between lb/1000 sq ft and g/m²
function rate_lb_per_1000sqft_to_g_per_m2(rate) {
  // 1 lb / 1000 ft² = 0.04882 kg / 92.903 m² ≈ 0.525 g/m²
  const lb = parseNumberLike(rate);
  return (lb * 0.4882) / 0.92903; // ≈ 0.525 (kept explicit for clarity)
}
function rate_g_per_m2_to_lb_per_1000sqft(rate) {
  const gpm2 = parseNumberLike(rate);
  return (gpm2 * 0.92903) / 0.4882;
}

function seedSpacing({ in_row, between_rows, unit = "in" }) {
  // Returns plants per m² approx: (m / spacing_m) * (m / row_m)
  const sIn = convertLength(
    parseNumberLike(in_row),
    normalizeUnit(unit)?.unit || "in",
    "cm"
  ); // → cm
  const sRow = convertLength(
    parseNumberLike(between_rows),
    normalizeUnit(unit)?.unit || "in",
    "cm"
  );
  const per_m2 = (100 / sIn) * (100 / sRow);
  return { per_m2, per_ft2: per_m2 / 10.7639 };
}

/* -------------------------------- animals math ----------------------------- */
function feedRate_convert({ value, from = "lb/hd/d", to = "kg/animal/day" }) {
  // supports "lb/hd/d", "kg/animal/day", "g/animal/day"
  const v = parseNumberLike(value);
  const map = {
    "lb/hd/d": (v) => v * 0.45359237, // → kg/animal/day
    "kg/animal/day": (v) => v,
    "g/animal/day": (v) => v / 1000,
  };
  const toMap = {
    "lb/hd/d": (vkg) => vkg / 0.45359237,
    "kg/animal/day": (vkg) => vkg,
    "g/animal/day": (vkg) => vkg * 1000,
  };
  if (!map[from] || !toMap[to]) throw new Error("Unsupported feed rate unit");
  const asKg = map[from](v);
  return toMap[to](asKg);
}

/* --------------------------- favorites & orchestration --------------------- */
async function saveFavoriteConversionPreset(meta, target = "local") {
  // Save a "Favorite Plan" that encapsulates a useful preset (e.g., 1:50 glass cleaner, or “All-purpose flour → grams”)
  const payload = {
    planId:
      meta.planId || `unit-preset:${meta.slug || meta.title || Date.now()}`,
    domain: meta.module || "meals",
    source: "UnitConversion",
    target,
    meta: {
      title: meta.title || "Conversion Preset",
      description: meta.description || "",
      preset: meta.preset || {},
      createdISO: toISO(),
    },
  };

  try {
    if (PlanStorageRouter?.savePlanFavorite) {
      await PlanStorageRouter.savePlanFavorite(payload);
      eventBus.emit?.("toast", {
        kind: "success",
        message: "Saved favorite preset",
        tsISO: toISO(),
      });
      return { ok: true, via: "PlanStorageRouter" };
    }
  } catch (_e) {}

  try {
    if (typeof useFavoritePlans === "function") {
      const st = useFavoritePlans.getState?.();
      st?.addFavorite?.({
        id: payload.planId,
        domain: payload.domain,
        title: payload.meta.title,
        meta: payload.meta,
      });
      eventBus.emit?.("toast", {
        kind: "success",
        message: "Saved favorite preset",
        tsISO: toISO(),
      });
      return { ok: true, via: "useFavoritePlans" };
    }
  } catch (_e) {}

  try {
    if (isBrowser) {
      const key = "suka:favorites:plans";
      const prev = safeJSON.parse(localStorage.getItem(key), []);
      prev.push({
        id: payload.planId,
        domain: payload.domain,
        title: payload.meta.title,
        meta: payload.meta,
      });
      localStorage.setItem(key, safeJSON.stringify(prev));
      eventBus.emit?.("toast", {
        kind: "success",
        message: "Saved favorite preset",
        tsISO: toISO(),
      });
      return { ok: true, via: "localStorage" };
    }
  } catch (_e) {}

  eventBus.emit?.("toast", {
    kind: "error",
    message: "Could not save preset",
    tsISO: toISO(),
  });
  return { ok: false };
}

/* ----------------------------------- API ----------------------------------- */
const api = {
  // Parsing & normalization
  parseNumberLike,
  normalizeUnit,

  // Core conversions
  convert,
  convertMass,
  convertVolume,
  convertLength,
  convertArea,
  convertTemp,

  // Best-fit display helpers
  toBestMass,
  toBestVolume,
  roundSmart,

  // Density registry
  registerDensity,
  getDensity,
  volumeMlToGrams,
  gramsToVolumeMl,

  // Baker's %
  bakersHydration,
  bakersScaleByHydration,

  // Cleaning/dilution helpers
  percentToRatio,
  ratioToPercent,
  percentToPPM,
  ppmToPercent,
  dilutionSolve,

  // Garden helpers
  rate_lb_per_1000sqft_to_g_per_m2,
  rate_g_per_m2_to_lb_per_1000sqft,
  seedSpacing,

  // Animals helpers
  feedRate_convert,

  // Favorites
  saveFavoriteConversionPreset,
};

export default api;

// CJS interop
if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
