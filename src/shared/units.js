// C:\Users\larho\suka-smart-assistant\src\shared\units.js
/**
 * Suka Units (dynamic, cooking/cleaning aware)
 * --------------------------------------------
 * A small, dependency-free measurement toolkit shared across agents/services.
 *
 * Goals:
 * - Consistent normalization & conversion across metric ↔ imperial
 * - Parse human inputs ("1 1/2 cups", "½ tsp", "2h 15m", "200°F", "3.5kg")
 * - Pretty formatting (fractions, pluralization, compact units)
 * - Density-aware mass↔volume conversion for ingredients/supplies (optional)
 * - Smart unit selection based on user preference + magnitude
 * - Cleaning helpers (bleach dilution, % solutions), kitchen helpers (hydration%)
 * - Dynamic overlays via window.__SUKA_UNITS__ or ./units.local.js
 *
 * Export (CJS + ESM default):
 *   getRegistry(), refreshRegistry()
 *   normalizeUnit(u), sameUnit(a,b)
 *   convert(value, from, to)
 *   convertSmart(value, from, to, { densityKgPerL, ingredientKey })
 *   bestUnit(value, unit, { system?, thresholds? })
 *   parseQuantity(str)
 *   formatQuantity(value, unit, opts?)
 *   parseDuration(str), formatDuration(ms)
 *   convertTemp(value, from, to)
 *   bleachDilution({ targetPpm, stockPercent, makeVolume, unit })
 *   solutionFromRatio({ solute, solvent, ratio })
 *   hydrationPercent({ flourG, waterG })
 *   scaleQuantity({ value, unit }, factor, opts?)
 *   sumQuantities(list, { toUnit?, system? })
 */

const isBrowser = typeof window !== "undefined";
const FRACTIONS = [
  { s: "⅛", v: 1/8 }, { s: "¼", v: 1/4 }, { s: "⅓", v: 1/3 }, { s: "½", v: 1/2 },
  { s: "⅔", v: 2/3 }, { s: "¾", v: 3/4 }
];

// Base registry (can be overlayed)
const BASE = {
  version: "2025.09.08",
  // Base scalar units in SI
  units: {
    // time (ms)
    ms:   { kind: "time",   toBase: 1,           fromBase: 1,           aliases: ["millisecond","msec"],       system: "si" },
    s:    { kind: "time",   toBase: 1000,        fromBase: 1/1000,      aliases: ["sec","second"],             system: "si" },
    min:  { kind: "time",   toBase: 60_000,      fromBase: 1/60_000,    aliases: ["m","minute"],               system: "si" },
    h:    { kind: "time",   toBase: 3_600_000,   fromBase: 1/3_600_000, aliases: ["hr","hour"],                system: "si" },
    day:  { kind: "time",   toBase: 86_400_000,  fromBase: 1/86_400_000,aliases: ["d"],                         system: "si" },

    // mass (g)
    g:    { kind: "mass",   toBase: 1,           fromBase: 1,           aliases: ["gram"],                     system: "si" },
    kg:   { kind: "mass",   toBase: 1000,        fromBase: 1/1000,      aliases: ["kilogram"],                 system: "si" },
    mg:   { kind: "mass",   toBase: 0.001,       fromBase: 1000,        aliases: ["milligram"],                system: "si" },
    lb:   { kind: "mass",   toBase: 453.59237,   fromBase: 1/453.59237, aliases: ["pound","lbs"],              system: "us" },
    oz:   { kind: "mass",   toBase: 28.349523125,fromBase: 1/28.349523125,aliases: ["ounce"],                  system: "us" },

    // volume (mL)
    ml:   { kind: "volume", toBase: 1,           fromBase: 1,           aliases: ["milliliter","millilitre"],  system: "si" },
    l:    { kind: "volume", toBase: 1000,        fromBase: 1/1000,      aliases: ["liter","litre"],            system: "si" },
    tsp:  { kind: "volume", toBase: 5,           fromBase: 1/5,         aliases: ["teaspoon","tsp."],          system: "us" },
    tbsp: { kind: "volume", toBase: 15,          fromBase: 1/15,        aliases: ["tablespoon","tbsp."],       system: "us" },
    floz: { kind: "volume", toBase: 29.5735295625,fromBase: 1/29.5735295625,aliases: ["fl-oz","fluid-ounce"],  system: "us" },
    cup:  { kind: "volume", toBase: 240,         fromBase: 1/240,       aliases: ["c","cups"],                 system: "us" },
    pint: { kind: "volume", toBase: 473.176473,  fromBase: 1/473.176473,aliases: ["pt"],                        system: "us" },
    quart:{ kind: "volume", toBase: 946.352946,  fromBase: 1/946.352946,aliases: ["qt"],                        system: "us" },
    gal:  { kind: "volume", toBase: 3785.411784, fromBase: 1/3785.411784,aliases:["gallon"],                   system: "us" },

    // length (mm)
    mm:   { kind: "length", toBase: 1,           fromBase: 1,           aliases: ["millimeter","millimetre"],  system: "si" },
    cm:   { kind: "length", toBase: 10,          fromBase: 0.1,         aliases: ["centimeter","centimetre"],  system: "si" },
    m:    { kind: "length", toBase: 1000,        fromBase: 1/1000,      aliases: ["meter","metre"],            system: "si" },
    in:   { kind: "length", toBase: 25.4,        fromBase: 1/25.4,      aliases: ["inch","\""],                system: "us" },
    ft:   { kind: "length", toBase: 304.8,       fromBase: 1/304.8,     aliases: ["foot","feet","'"],          system: "us" },
  },

  // temperature handled separately (affine transform)
  temperature: { C: { aliases: ["°c","celsius"] }, F: { aliases: ["°f","fahrenheit"] }, K: { aliases: ["kelvin"] } },

  // Friendly thresholds for bestUnit selection by system
  thresholds: {
    mass:   { si: [{u:"mg",max:1},{u:"g",max:1000},{u:"kg",max:Infinity}],
              us: [{u:"oz",max:32},{u:"lb",max:Infinity}] },
    volume: { si: [{u:"ml",max:1000},{u:"l",max:Infinity}],
              us: [{u:"tsp",max:15},{u:"tbsp",max:90},{u:"cup",max:960},{u:"quart",max:3800},{u:"gal",max:Infinity}] },
    length: { si: [{u:"mm",max:100},{u:"cm",max:1000},{u:"m",max:Infinity}],
              us: [{u:"in",max:36},{u:"ft",max:Infinity}] },
    time:   { si: [{u:"s",max:90},{u:"min",max:90*60_000},{u:"h",max:36*3_600_000},{u:"day",max:Infinity}],
              us: [{u:"s",max:90},{u:"min",max:90*60_000},{u:"h",max:36*3_600_000},{u:"day",max:Infinity}] },
  },

  // Ingredient densities (kg/L) for smart mass↔volume (editable/overlayable)
  densities: {
    water:          1.0,      // 1 kg/L
    milk:           1.03,
    olive_oil:      0.91,
    sugar_gran:     0.85,     // granulated sugar
    sugar_brown:    0.72,
    flour_ap:       0.53,
    flour_bread:    0.58,
    salt_kosher:    0.72,
    salt_table:     1.2,
    rice_white:     0.85,
    rice_brown:     0.80,
    honey:          1.42,
    vinegar:        1.01,
    bleach_6pct:    1.08,
  },

  // Unit aliases & symbols (normalized token → canonical unit)
  aliases: {
    // volumes
    tsp: ["t","tsp","tsp.","teaspoon","teaspoons","⅕ tbsp"],
    tbsp:["T","tbsp","tbsp.","tablespoon","tablespoons"],
    cup: ["c","cup","cups"],
    floz:["fl-oz","fl oz","fluid ounce","fluid ounces","oz fl","ozfl"],
    pint:["pt","pint","pints"],
    quart:["qt","quart","quarts"],
    gal: ["gallon","gallons"],

    // mass
    g:   ["g","gram","grams","gr"],
    kg:  ["kg","kilogram","kilograms"],
    mg:  ["mg","milligram","milligrams"],
    oz:  ["oz","ounce","ounces"],
    lb:  ["lb","lbs","pound","pounds"],

    // length
    mm:  ["mm","millimeter","millimetre","millimeters","millimetres"],
    cm:  ["cm","centimeter","centimetre","centimeters","centimetres"],
    m:   ["m","meter","metre","meters","metres"],
    in:  ["in","inch","inches","\""],
    ft:  ["ft","foot","feet","'"],

    // time
    ms:  ["ms","millisecond","milliseconds","msec"],
    s:   ["s","sec","second","seconds"],
    min: ["m","min","mins","minute","minutes"],
    h:   ["h","hr","hrs","hour","hours"],
    day: ["d","day","days"],
  },

  // Preferred system fallback (overridden by settings if available)
  defaultSystem: "us",
};

let _reg = null;

/* ---------------------------------------------
 * Dynamic overlay loader
 * -------------------------------------------*/
function mergeDeep(target, source) {
  if (!source || typeof source !== "object") return target;
  const out = Array.isArray(target) ? target.slice() : { ...target };
  for (const [k,v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = mergeDeep(target?.[k] || {}, v);
    } else if (Array.isArray(v)) {
      out[k] = Array.from(new Set([...(target?.[k] || []), ...v]));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function _loadOverlay() {
  let overlay = {};
  // Browser global
  if (isBrowser && window.__SUKA_UNITS__) overlay = mergeDeep(overlay, window.__SUKA_UNITS__);
  // Optional local file
  try {
    // eslint-disable-next-line global-require
    const local = require("./units.local.js");
    overlay = mergeDeep(overlay, local?.default || local);
  } catch {}
  // Settings store (for preferred system)
  try {
    const Settings = require("@/store/SettingsStore");
    const sys = Settings?.get?.("units.system");
    if (sys) overlay.defaultSystem = sys;
    const dens = Settings?.get?.("units.densities");
    if (dens && typeof dens === "object") overlay.densities = { ...(overlay.densities||{}), ...dens };
  } catch {}
  return overlay;
}

function getRegistry() {
  if (_reg) return _reg;
  _reg = mergeDeep(BASE, _loadOverlay());
  // Build reverse alias index
  const rev = new Map();
  const add = (key, canon) => { rev.set(key.toLowerCase(), canon); };
  for (const [canon, arr] of Object.entries(_reg.aliases)) {
    add(canon, canon);
    (arr||[]).forEach(a => add(String(a), canon));
  }
  // also add unit names + aliases from units table
  for (const [canon, def] of Object.entries(_reg.units)) {
    add(canon, canon);
    (def.aliases||[]).forEach(a => add(String(a), canon));
  }
  // temperature aliases
  for (const [canon, def] of Object.entries(_reg.temperature)) {
    add(canon, canon);
    (def.aliases||[]).forEach(a => add(String(a), canon));
  }
  _reg._aliasIndex = rev;
  return _reg;
}

function refreshRegistry() {
  _reg = null;
  return getRegistry();
}

/* ---------------------------------------------
 * Normalization & basic conversion
 * -------------------------------------------*/
function normalizeUnit(u) {
  if (!u && u !== 0) return null;
  const reg = getRegistry();
  const key = String(u).trim().toLowerCase();
  return reg._aliasIndex.get(key) || null;
}
function sameUnit(a,b) {
  const na = normalizeUnit(a), nb = normalizeUnit(b);
  return na && nb && na === nb;
}

function _ensureCompatible(from, to) {
  const reg = getRegistry();
  const A = reg.units[from], B = reg.units[to];
  if (!A || !B) return false;
  return A.kind === B.kind;
}

function convert(value, from, to) {
  if (value == null) return null;
  const val = Number(value);
  const F = normalizeUnit(from);
  const T = normalizeUnit(to);
  const reg = getRegistry();
  if (!F || !T) return null;
  if (F === T) return val;
  const uF = reg.units[F], uT = reg.units[T];
  if (!uF || !uT) return null;
  if (uF.kind !== uT.kind) return null;
  const base = val * uF.toBase;
  return base * uT.fromBase;
}

/**
 * convertSmart: allow mass↔volume with density (kg/L) when kind differs.
 * opts: { densityKgPerL?, ingredientKey? }
 * If ingredientKey is given and density not provided, will look up in registry.densities
 */
function convertSmart(value, from, to, opts = {}) {
  const F = normalizeUnit(from), T = normalizeUnit(to);
  if (!F || !T) return null;
  const reg = getRegistry();
  const uF = reg.units[F], uT = reg.units[T];
  if (!uF && !uT) return null;

  // Same-kind: regular convert
  if (uF && uT && uF.kind === uT.kind) return convert(value, F, T);

  // Mass↔Volume using density (kg/L)
  const wantMass = uT && uT.kind === "mass";
  const wantVol  = uT && uT.kind === "volume";
  const haveMass = uF && uF.kind === "mass";
  const haveVol  = uF && uF.kind === "volume";

  if ((haveMass && wantVol) || (haveVol && wantMass)) {
    let rho = Number(opts.densityKgPerL);
    if (!rho && opts.ingredientKey) {
      const key = String(opts.ingredientKey).replace(/\s+/g,"_").toLowerCase();
      rho = reg.densities[key];
    }
    if (!rho) return null;

    if (haveMass && wantVol) {
      // mass(g) -> L via kg/L
      const g = convert(value, F, "g");
      if (g == null) return null;
      const L = (g/1000) / rho; // kg / (kg/L) = L
      return convert(L, "l", T);
    }
    if (haveVol && wantMass) {
      const ml = convert(value, F, "ml");
      if (ml == null) return null;
      const kg = (ml/1000) * rho;
      const g  = kg * 1000;
      return convert(g, "g", T);
    }
  }

  return null;
}

/* ---------------------------------------------
 * Best unit selection
 * -------------------------------------------*/
function preferredSystem() {
  const reg = getRegistry();
  // Settings override handled in overlay; use defaultSystem here.
  return reg.defaultSystem === "si" ? "si" : "us";
}

/**
 * Pick a human-friendly unit for value in a given unit.
 * Returns { value, unit }
 */
function bestUnit(value, unit, { system, thresholds } = {}) {
  const reg = getRegistry();
  const sys = system || preferredSystem();
  const U = normalizeUnit(unit);
  if (!U) return { value, unit };

  const def = reg.units[U];
  if (!def) return { value, unit };

  const table = (thresholds && thresholds[def.kind]) || reg.thresholds[def.kind]?.[sys];
  if (!table) return { value, unit };

  // Convert to base (g/ml/mm/ms), then walk thresholds converting to candidate, pick first with base<=max
  const baseVal = value * def.toBase;
  for (const step of table) {
    const cand = reg.units[step.u];
    if (!cand) continue;
    if (baseVal <= step.max) {
      return { value: baseVal * cand.fromBase, unit: step.u };
    }
  }
  // fallback: last entry
  const last = table[table.length - 1];
  const cand = reg.units[last.u];
  return { value: baseVal * cand.fromBase, unit: last.u };
}

/* ---------------------------------------------
 * Parsing & formatting
 * -------------------------------------------*/
function _parseNumber(str) {
  if (str == null) return NaN;
  const s = String(str).trim();
  // Handle unicode vulgar fractions & mixed numbers
  // "1 1/2", "½", "2½"
  const fracMap = Object.fromEntries(FRACTIONS.map(f => [f.s, f.v]));
  let total = 0;
  // Extract leading integer
  const m = s.match(/^(\d+)\s*/);
  let rest = s;
  if (m) {
    total += Number(m[1]);
    rest = s.slice(m[0].length);
  }
  // Unicode fraction
  for (const f of FRACTIONS) {
    if (rest.startsWith(f.s)) {
      total += f.v;
      rest = rest.slice(f.s.length);
      return { n: total, rest: rest.trim() };
    }
  }
  // ascii fraction a/b
  const m2 = rest.match(/^(\d+)\s*\/\s*(\d+)(.*)$/);
  if (m2) {
    total += Number(m2[1]) / Number(m2[2] || 1);
    rest = (m2[3] || "").trim();
    return { n: total, rest };
  }
  // decimal
  const m3 = rest.match(/^(\d+(\.\d+)?)(.*)$/);
  if (m3) {
    total += Number(m3[1]);
    rest = (m3[3] || "").trim();
    return { n: total, rest };
  }
  // Only unicode fraction
  if (!m) {
    for (const f of FRACTIONS) {
      if (s.startsWith(f.s)) {
        return { n: f.v, rest: s.slice(f.s.length).trim() };
      }
    }
  }
  return { n: NaN, rest: s };
}

/**
 * parseQuantity("1 1/2 cups") -> { value: 1.5, unit: "cup" }
 * Also handles temperatures like "200 F" and durations like "1h 20m" via dedicated functions.
 */
function parseQuantity(str) {
  if (!str) return { value: NaN, unit: null };
  let s = String(str).trim();
  // strip commas
  s = s.replace(/,/g, "");
  const { n, rest } = _parseNumber(s);
  if (!isFinite(n)) return { value: NaN, unit: null };
  // Next token(s) is unit
  const unitToken = rest.toLowerCase().replace(/^[\s\-]+/, "").split(/\s+/)[0] || "";
  const u = normalizeUnit(unitToken);
  return { value: n, unit: u };
}

function _toFraction(value, maxDen = 8) {
  // Return { whole, num, den } using small denominators (2,3,4,8)
  const whole = Math.trunc(value);
  let frac = Math.round((value - whole) * maxDen);
  let den = maxDen;
  // simplify
  function gcd(a,b){ return b ? gcd(b, a % b) : a; }
  const g = gcd(frac, den) || 1;
  frac/=g; den/=g;
  if (frac === 0) return { whole, num: 0, den: 1 };
  // map to nice fractions
  const CANDS = [2,3,4,8];
  let best = { num: frac, den };
  let bestErr = Math.abs(frac/den - (value - whole));
  for (const d of CANDS) {
    const n = Math.round((value - whole) * d);
    const err = Math.abs(n/d - (value - whole));
    if (err < bestErr + 1e-6) { best = { num: n, den: d }; bestErr = err; }
  }
  return { whole, num: best.num, den: best.den };
}

function _plural(u, v) {
  const s = String(u);
  if (v === 1) return s;
  if (s === "tsp") return "tsp";
  if (s === "tbsp") return "tbsp";
  if (s === "floz") return "floz";
  if (s === "oz") return "oz";
  if (s === "lb") return "lb";
  if (s === "ft") return "ft";
  if (s === "in") return "in";
  if (s === "g") return "g";
  if (s === "kg") return "kg";
  if (s === "ml") return "ml";
  if (s === "l") return "l";
  if (s === "cup") return v === 1 ? "cup" : "cups";
  if (s === "pint") return v === 1 ? "pint" : "pints";
  if (s === "quart") return v === 1 ? "quart" : "quarts";
  if (s === "gal") return v === 1 ? "gal" : "gal";
  return s;
}

/**
 * formatQuantity(1.5,"cup") -> "1 1/2 cups"
 */
function formatQuantity(value, unit, opts = {}) {
  if (value == null || !isFinite(value)) return "";
  const u = normalizeUnit(unit) || unit || "";
  const system = opts.system || preferredSystem();

  // Optionally pick best unit
  const chosen = opts.best ? bestUnit(value, u, { system }) : { value, unit: u };
  const v = chosen.value;
  const uu = chosen.unit;

  // Fractions for cooking-friendly units
  const fractionalUnits = new Set(["tsp","tbsp","cup"]);
  if (fractionalUnits.has(uu) && !opts.decimals) {
    const { whole, num, den } = _toFraction(v);
    const parts = [];
    if (whole) parts.push(String(whole));
    if (num) {
      const uni = FRACTIONS.find(f => Math.abs(f.v - (num/den)) < 1e-6);
      parts.push(uni ? uni.s : `${num}/${den}`);
    }
    const text = parts.length ? parts.join(" ") : "0";
    return `${text} ${_plural(uu, v)}`.trim();
    }

  // Otherwise decimal formatting
  const decimals = Number.isFinite(opts.decimals) ? opts.decimals : (Math.abs(v) < 1 ? 2 : 1);
  const text = v.toFixed(decimals).replace(/\.0+$/,"").replace(/(\.\d*?)0+$/,"$1");
  return `${text} ${_plural(uu, v)}`.trim();
}

/* ---------------------------------------------
 * Time / Temp
 * -------------------------------------------*/
function parseDuration(str) {
  if (!str) return 0;
  const s = String(str).toLowerCase();
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|day|days)/g;
  let m;
  while ((m = re.exec(s))) {
    const n = parseFloat(m[1]);
    const u = m[2];
    if (/^ms/.test(u)) ms += n;
    else if (/^s|sec/.test(u)) ms += n * 1000;
    else if (/^m|min/.test(u)) ms += n * 60_000;
    else if (/^h|hr/.test(u)) ms += n * 3_600_000;
    else if (/^d|day/.test(u)) ms += n * 86_400_000;
  }
  return ms;
}

function formatDuration(ms, { compact = true } = {}) {
  if (!ms || ms < 1000) return compact ? `${Math.round(ms)}ms` : `${Math.round(ms)} ms`;
  const s = Math.round(ms/1000);
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const sec = s%60;
  const parts = [];
  if (h) parts.push(`${h}${compact?"h":" hr"}`);
  if (m) parts.push(`${m}${compact?"m":" min"}`);
  if (!h && sec) parts.push(`${sec}${compact?"s":" sec"}`);
  return parts.join(compact ? " " : " ");
}

function convertTemp(value, from, to) {
  const F = (String(from||"").trim().toUpperCase());
  const T = (String(to||"").trim().toUpperCase());
  let C;
  if (F === "C") C = value;
  else if (F === "F") C = (value - 32) * 5/9;
  else if (F === "K") C = value - 273.15;
  else return null;

  if (T === "C") return C;
  if (T === "F") return (C * 9/5) + 32;
  if (T === "K") return C + 273.15;
  return null;
}

/* ---------------------------------------------
 * Cleaning & Kitchen helpers
 * -------------------------------------------*/
/**
 * Bleach dilution calculator
 * targetPpm (free available chlorine), stockPercent (e.g., 6 for 6% NaOCl),
 * makeVolume (number), unit ("ml"|"l"|"cup"|"gal"...)
 * Returns { stockVolume:{value,unit}, waterVolume:{value,unit}, total:{value,unit} }
 *
 * Formula: ppm = mg/L. 1% = 10,000 ppm. Needed stock ratio = targetPpm / (stockPercent*10,000)
 */
function bleachDilution({ targetPpm, stockPercent, makeVolume, unit = "l" }) {
  const ratio = Number(targetPpm) / (Number(stockPercent) * 10_000);
  if (!isFinite(ratio) || ratio <= 0) return null;
  const stockVol = makeVolume * ratio;
  const waterVol = makeVolume - stockVol;
  return {
    stockVolume: { value: stockVol, unit },
    waterVolume: { value: waterVol, unit },
    total: { value: makeVolume, unit }
  };
}

/**
 * solutionFromRatio: simple solver given solute:solvent ratio and target total volume.
 * ratio: e.g., 1:9 for vinegar cleaning solution -> {solute, solvent, total}
 */
function solutionFromRatio({ solute = 1, solvent = 9, total = 1000, unit = "ml" }) {
  const parts = solute + solvent;
  const soluteVol = total * (solute/parts);
  const solventVol = total - soluteVol;
  return {
    solute: { value: soluteVol, unit },
    solvent: { value: solventVol, unit },
    total: { value: total, unit }
  };
}

function hydrationPercent({ flourG, waterG }) {
  const f = Number(flourG), w = Number(waterG);
  if (!isFinite(f) || f <= 0) return null;
  return Math.round((w / f) * 100);
}

/* ---------------------------------------------
 * Quantity utilities (scale/sum)
 * -------------------------------------------*/
function scaleQuantity(q, factor, opts = {}) {
  if (!q) return q;
  const { value, unit } = q;
  const v = Number(value) * Number(factor);
  if (!isFinite(v)) return { value: NaN, unit };
  if (opts.best) {
    const b = bestUnit(v, unit, { system: opts.system });
    return b;
  }
  return { value: v, unit };
}

/**
 * sumQuantities([{value,unit},...], { toUnit?, system? })
 * If toUnit not provided, pick best unit in chosen system.
 */
function sumQuantities(list = [], { toUnit, system } = {}) {
  if (!Array.isArray(list) || !list.length) return { value: 0, unit: toUnit || null };
  const first = list.find(q => q && q.unit);
  if (!first && toUnit) {
    const total = list.reduce((a,b)=>a + Number(b?.value||0), 0);
    return { value: total, unit: toUnit };
  }
  const baseUnit = toUnit || normalizeUnit(first.unit);
  const reg = getRegistry();
  const k = reg.units[baseUnit]?.kind;

  // If kinds mismatch, bail
  for (const q of list) {
    const n = normalizeUnit(q.unit);
    if (!n) continue;
    const kind = reg.units[n]?.kind;
    if (k && kind && kind !== k) {
      // try smart via density only if requested explicitly — keep simple here
      return null;
    }
  }

  const total = list.reduce((sum,q)=>{
    if (!q) return sum;
    const n = Number(q.value) || 0;
    const cu = normalizeUnit(q.unit) || baseUnit;
    const v = convert(n, cu, baseUnit);
    return sum + (v || 0);
  }, 0);

  // Optionally re-pick best unit
  const sys = system || preferredSystem();
  const best = bestUnit(total, baseUnit, { system: sys });
  return best;
}

/* ---------------------------------------------
 * Public API
 * -------------------------------------------*/
module.exports = {
  // registry
  getRegistry,
  refreshRegistry,

  // normalization / conversion
  normalizeUnit,
  sameUnit,
  convert,
  convertSmart,
  bestUnit,

  // parse/format
  parseQuantity,
  formatQuantity,

  // time & temp
  parseDuration,
  formatDuration,
  convertTemp,

  // helpers
  bleachDilution,
  solutionFromRatio,
  hydrationPercent,

  // quantities
  scaleQuantity,
  sumQuantities,
};

module.exports.default = module.exports;
