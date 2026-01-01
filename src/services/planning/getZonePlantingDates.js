// C:\Users\larho\suka-smart-assistant\src\services\planning\getZonePlantingDates.js
/**
 * getZonePlantingDates (Global, Climate-aware, Irrigation/Market-enabled)
 * -----------------------------------------------------------------------
 * ✅ Works worldwide (hemispheres, tropics, monsoon/bimodal rains, elevation)
 * ✅ Supports African countries & wet/dry climates via rainfall windows/providers
 * ✅ Irrigation-aware planning for cisterns/wells with simple water budgeting
 * ✅ Market alignment (market days + optional price provider → profit estimate)
 * ✅ Season-extension gear, pacing, and harvest-target alignment
 * ✅ Optional Calendar stubs (seed, harden, transplant, harvest, successions, irrigation)
 *
 * LEGACY COMPAT:
 *   - If called as getZonePlantingDates(zone, crops) with no options,
 *     returns { [crop]: { start, end } } primary window map.
 */

const dayjs = require("dayjs");

const VERSION = "2025-09-15.global.irrigation.market";

/* ───────────────────── Coarse US frost medians (legacy fallback) ───────────────────── */
const ZONE_FROST_TABLE = {
  3:  { last: "05-20", first: "09-08" },
  4:  { last: "05-10", first: "09-25" },
  5:  { last: "04-30", first: "10-10" },
  6:  { last: "04-15", first: "10-25" },
  7:  { last: "04-01", first: "11-05" },
  8:  { last: "03-20", first: "11-15" },
  9:  { last: "02-20", first: "12-10" },
  10: { last: "02-01", first: "12-31" }, // effectively frost-free late
};
// Subzone nudges (days)
const SUBZONE_ADJUST = { a: { last: +7, first: -7 }, b: { last: -7, first: +7 } };

/* ───────────────────── Crop defaults (coarse, overridable) ───────────────────── */
const CROPS = {
  tomato:   { name: "Tomato",   method: "transplant", warm: true,  dtm: 70, harvestSpan: 56, indoorLeadWeeks: 6,  transplantRelToLast: +7,  sowRelToLast: null, fallOffsetToFirst: 95  },
  pepper:   { name: "Pepper",   method: "transplant", warm: true,  dtm: 75, harvestSpan: 56, indoorLeadWeeks: 8,  transplantRelToLast: +14, sowRelToLast: null, fallOffsetToFirst: 110 },
  eggplant: { name: "Eggplant", method: "transplant", warm: true,  dtm: 80, harvestSpan: 56, indoorLeadWeeks: 8,  transplantRelToLast: +14, sowRelToLast: null, fallOffsetToFirst: 110 },
  cucumber: { name: "Cucumber", method: "direct_sow", warm: true,  dtm: 55, harvestSpan: 35, indoorLeadWeeks: 0,  transplantRelToLast: null, sowRelToLast: +7,  fallOffsetToFirst: 70  },
  zucchini: { name: "Zucchini", method: "direct_sow", warm: true,  dtm: 55, harvestSpan: 45, indoorLeadWeeks: 0,  transplantRelToLast: null, sowRelToLast: +7,  fallOffsetToFirst: 70  },
  bean:     { name: "Green Bean",method:"direct_sow",warm: true,  dtm: 55, harvestSpan: 35, indoorLeadWeeks: 0,  transplantRelToLast: null, sowRelToLast: +7,  fallOffsetToFirst: 70  },
  corn:     { name: "Sweet Corn",method:"direct_sow",warm: true,  dtm: 75, harvestSpan: 21, indoorLeadWeeks: 0,  transplantRelToLast: null, sowRelToLast: +10, fallOffsetToFirst: 85  },
  lettuce:  { name: "Lettuce",  method: "direct_sow", warm: false, dtm: 45, harvestSpan: 14, indoorLeadWeeks: 0,  transplantRelToLast: null, sowRelToLast: -14, fallOffsetToFirst: 45  },
  spinach:  { name: "Spinach",  method: "direct_sow", warm: false, dtm: 40, harvestSpan: 14, indoorLeadWeeks: 0,  transplantRelToLast: null, sowRelToLast: -28, fallOffsetToFirst: 50  },
  kale:     { name: "Kale",     method: "transplant", warm: false, dtm: 60, harvestSpan: 60, indoorLeadWeeks: 4,  transplantRelToLast: -14, sowRelToLast: null, fallOffsetToFirst: 70  },
  carrot:   { name: "Carrot",   method: "direct_sow", warm: false, dtm: 70, harvestSpan: 10, indoorLeadWeeks: 0,  transplantRelToLast: null, sowRelToLast: -14, fallOffsetToFirst: 75  },
  onion:    { name: "Onion (bulb)",method:"transplant",warm:false, dtm:100, harvestSpan: 14, indoorLeadWeeks: 8,  transplantRelToLast: -21, sowRelToLast: null, fallOffsetToFirst:120  },
  potato:   { name: "Potato",   method: "direct_sow", warm: false, dtm: 95, harvestSpan: 21, indoorLeadWeeks: 0,  transplantRelToLast: null, sowRelToLast: -14, fallOffsetToFirst:100  },
};

/* ───────────────────── Water, yield & market heuristics ───────────────────── */
// Rough defaults; refine per locale/variety as needed.
const WATER_NEED_L_PER_M2_PER_WEEK = {
  tomato: 25, pepper: 22, eggplant: 22,
  cucumber: 20, zucchini: 20, bean: 18, corn: 22,
  lettuce: 12, spinach: 10, kale: 12, carrot: 10, onion: 12, potato: 18
};

const YIELD_KG_PER_M2 = {
  tomato: 3.5, pepper: 2.2, eggplant: 2.5,
  cucumber: 2.8, zucchini: 3.0, bean: 1.4, corn: 1.6,
  lettuce: 1.2, spinach: 0.9, kale: 1.0, carrot: 3.0, onion: 4.0, potato: 5.0
};

/* ────────────────────────── Defaults / helpers ────────────────────────── */
const DEFAULT_OPTIONS = {
  includeFall: true,
  successionEveryDays: 14,
  successions: 0,                 // number of extra sowings
  indoorLeadWeeksBias: 0,         // +/- weeks
  transplantHardenDays: 7,
  seasonPaddingDays: 0,           // widen/contract windows globally
  frost: null,                    // { lastSpring, firstFall, percentile }
  heat: null,                     // { firstHighHeat, thresholdF }
  soil: null,                     // { minSoilTempC, consecutiveDays }
  photoperiod: null,              // { minHours, maxHours }
  gdd: null,                      // { baseC, target, upperCapC }
  rainfall: null,                 // { hasMonsoon, rainyStart, rainyEnd, windows: [{start,end,label}] }
  source: "global_normals",
  pacing: "normal",               // aggressive | normal | conservative
  seasonExtension: { rowCover: false, lowTunnel: false, coldFrame: false, greenhouse: false, heatMatIndoors: false },
  includeCalendarStubs: false,
  includeCompanionNotes: true,
  harvestTargets: [],             // [{start,end,label}]
  overrides: {},                  // per-crop overrides
  location: null,                 // { lat, lon, elevationM, tz, country }
  climateProviders: null,         // hooks (see .d.ts)
  irrigation: {
    enabled: false,
    source: "cistern",            // 'cistern' | 'well' | 'both'
    areaM2: 20,                   // total planned area (cap)
    capacityL: 1000,              // stored water
    dailyRechargeL: 50,           // well/roof capture per day
    distributionEfficiency: 0.8,  // 0..1
    costPerM3: 0                  // USD/m³, 0 if not priced
  },
  market: {
    align: false,
    daysOfWeek: [2,5],            // Tue/Fri by default; 0=Sun..6=Sat
    priceProvider: null,          // async (cropKey, {start,end}) => { avgPricePerKg }
    baseFarmgatePriceUSD: {},     // { cropKey: price }
    costs: { seedUSDPerM2: 0.1, fertUSDPerM2: 0.2, laborUSDPerM2: 0.0 }
  }
};

function parseUSDA(zone) {
  const z = String(zone || "").toLowerCase().trim();
  const m = z.match(/^(\d{1,2})([ab])?$/);
  if (!m) return null;
  const num = Math.min(Math.max(parseInt(m[1], 10), 3), 10);
  const sub = m[2] || null;
  return { num, sub };
}
function frostFromUSDA(zone, year) {
  const parsed = parseUSDA(zone);
  if (!parsed) return null;
  const base = ZONE_FROST_TABLE[parsed.num];
  if (!base) return null;
  let last = dayjs(`${year}-${base.last}`);
  let first = dayjs(`${year}-${base.first}`);
  const adj = parsed.sub ? SUBZONE_ADJUST[parsed.sub] : null;
  if (adj) { last = last.add(adj.last, "day"); first = first.add(adj.first, "day"); }
  if (!first.isAfter(last)) first = first.add(1, "year");
  return { last, first, source: "usda_zone_table" };
}

function clampToSeason(date, frost, padDays = 0) {
  const start = frost.last.subtract(padDays, "day");
  const end = frost.first.add(padDays, "day");
  if (dayjs(date).isBefore(start)) return start;
  if (dayjs(date).isAfter(end)) return end;
  return dayjs(date);
}
function ensureCropSpec(spec, overrides = {}) {
  if (typeof spec === "string") {
    const key = spec.toLowerCase();
    return { key, ...(CROPS[key] || { name: spec, method: "direct_sow", warm: true, dtm: 60, harvestSpan: 21, sowRelToLast: +7 }) , ...(overrides[key]||{}) };
  }
  if (spec && typeof spec === "object") {
    const base = CROPS[(spec.key || "").toLowerCase()] || {};
    const key = (spec.key || Object.keys(CROPS).find(k => CROPS[k] === base) || (spec.name || "crop")).toLowerCase();
    return { ...base, ...spec, ...(overrides[key]||{}), key };
  }
  throw new Error("Invalid crop spec");
}

/* ───────────────────── Companion notes (light hints) ───────────────────── */
const COMPANIONS = {
  tomato: { avoid: ["onion"], prefer: ["basil","marigold"] },
  onion:  { avoid: ["bean","pea"], prefer: ["carrot","beet"] },
  carrot: { avoid: ["dill"], prefer: ["onion","lettuce"] },
  bean:   { avoid: ["onion"], prefer: ["corn"] },
  corn:   { avoid: [], prefer: ["bean","squash"] },
};
function companionNotesFor(key) {
  const c = COMPANIONS[key] || null;
  if (!c) return [];
  const out = [];
  if (c.prefer?.length) out.push(`Companions: ${c.prefer.join(", ")}`);
  if (c.avoid?.length) out.push(`Avoid near: ${c.avoid.join(", ")}`);
  return out;
}

/* ─────────────────── Confidence based on options/gear ─────────────────── */
function confidenceFor(crop, opts, season) {
  let score = 0;
  if (!crop.warm && (season === "spring" || season === "fall")) score += 1;
  if (crop.warm && season === "spring") score += -1;
  if (crop.method === "transplant") score += 0.5;
  const gear = opts.seasonExtension || {};
  if (gear.rowCover) score += 0.3;
  if (gear.lowTunnel) score += 0.4;
  if (gear.coldFrame) score += 0.5;
  if (gear.greenhouse) score += 0.8;
  if (opts.pacing === "conservative") score += 0.3;
  if (opts.pacing === "aggressive") score -= 0.3;
  return score >= 0.9 ? "high" : score >= 0.2 ? "medium" : "low";
}

/* ─────────────── Season extension ↔ buffer adjustments ─────────────── */
function computeBuffers(opts) {
  let early = 0, late = 0;
  const gear = opts.seasonExtension || {};
  const pad = Number(opts.seasonPaddingDays || 0);
  early -= pad; late += pad;
  if (gear.rowCover)  { early += 4;  late += 2; }
  if (gear.lowTunnel) { early += 6;  late += 4; }
  if (gear.coldFrame) { early += 8;  late += 6; }
  if (gear.greenhouse) { early += 21; late += 14; }
  if (opts.pacing === "conservative") { early -= 4; late += 4; }
  if (opts.pacing === "aggressive")   { early += 4; late -= 4; }
  return { early, late };
}

/* ───────────────────── Global climate resolution ─────────────────────
   Tries (in order):
   1) Explicit overrides (opts.frost.*)
   2) climateProviders.frostFor(lat,lon,...)   ← works worldwide (incl. Africa)
   3) USDA fallback if zone looks like "6b"
   4) If still nothing, treat as frost-light (tropics/coastal) and drive by rainfall windows
*/
async function resolveClimate({ zone, year, opts }) {
  const diagnostics = { usedProviders: [], dataGaps: [] };
  const warnings = [];
  let frost = null;
  let rainfallWindows = normalizeRainWindows(opts?.rainfall);
  const loc = opts?.location || null;

  if (opts?.frost?.lastSpring && opts?.frost?.firstFall) {
    frost = { last: dayjs(opts.frost.lastSpring), first: dayjs(opts.frost.firstFall) };
    diagnostics.usedProviders.push("user_frost_overrides");
  } else if (opts?.frost?.lastSpring || opts?.frost?.firstFall) {
    diagnostics.usedProviders.push("user_frost_overrides");
  }

  if (!frost && loc && opts?.climateProviders?.frostFor) {
    try {
      const fr = await opts.climateProviders.frostFor(loc.lat, loc.lon, loc.elevationM, loc.country);
      if (fr?.lastSpring && fr?.firstFall) {
        frost = { last: dayjs(fr.lastSpring), first: dayjs(fr.firstFall) };
        diagnostics.usedProviders.push("provider_specific");
      }
    } catch { warnings.push("frostFor provider failed; using fallbacks."); }
  }

  if (!frost) {
    const usda = frostFromUSDA(zone, year);
    if (usda) {
      frost = { last: usda.last, first: usda.first };
      diagnostics.usedProviders.push(usda.source);
    }
  }

  if (!frost) {
    const start = dayjs(`${year}-01-15`);
    frost = { last: start, first: start.add(11, "month") };
    diagnostics.dataGaps.push("frost");
  }

  if ((!rainfallWindows || rainfallWindows.length === 0) && loc && opts?.climateProviders) {
    const cc = (loc.country || "").toUpperCase();
    const regionHook = pickAfricaRegionHook(cc, opts.climateProviders);
    if (regionHook) {
      try {
        const r = await regionHook(cc, loc.lat, loc.lon);
        const w = normalizeRainWindows(r?.rainfall || r?.windows || r);
        if (w?.length) {
          rainfallWindows = w;
          diagnostics.usedProviders.push("provider_specific");
        }
      } catch { warnings.push("regional rainfall provider failed; using defaults."); }
    }
  }

  return { frost, rainfallWindows, diagnostics, warnings, hemisphere: hemis(loc?.lat) };
}

function hemis(lat) { return (typeof lat === "number" && lat < 0) ? "S" : "N"; }
function pickAfricaRegionHook(cc, providers) {
  const EAST = ["KE","TZ","UG","ET","SO","RW","BI","SS","DJ","ER"];
  const WEST = ["NG","GH","SN","BF","ML","NE","GM","SL","LR","BJ","TG","CI","GN","MR","CV"];
  const SOUTH = ["ZA","BW","NA","ZW","ZM","LS","SZ","MW","AO","MZ"];
  const NORTH = ["MA","DZ","TN","LY","EG","EH"];
  const CENTRAL = ["CM","CG","CD","CF","GA","GQ"];
  if (EAST.includes(cc) && providers.africaEastNormals) return providers.africaEastNormals;
  if (WEST.includes(cc) && providers.africaWestNormals) return providers.africaWestNormals;
  if (SOUTH.includes(cc) && providers.africaSouthNormals) return providers.africaSouthNormals;
  if (NORTH.includes(cc) && providers.africaNorthNormals) return providers.africaNorthNormals;
  if (CENTRAL.includes(cc) && providers.africaCentralNormals) return providers.africaCentralNormals;
  return null;
}
function normalizeRainWindows(rainfall) {
  if (!rainfall) return null;
  if (Array.isArray(rainfall.windows) && rainfall.windows.length) {
    return rainfall.windows.map(w => ({ start: dayjs(w.start), end: dayjs(w.end), label: w.label || "rainy" }));
  }
  if (rainfall.rainyStart && rainfall.rainyEnd) {
    return [{ start: dayjs(rainfall.rainyStart), end: dayjs(rainfall.rainyEnd), label: "rainy" }];
  }
  return null;
}

/* ─────────────────── Soil temp adjustments (optional) ─────────────────── */
async function adjustForSoilTemp(dateISO, opts) {
  const target = dayjs(dateISO);
  const soil = opts?.soil || null;
  const loc = opts?.location || null;
  if (!soil || !soil.minSoilTempC || !loc || !opts?.climateProviders?.soilFor) return dayjs(dateISO);
  let d = target;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await opts.climateProviders.soilFor(loc.lat, loc.lon, d.format("YYYY-MM-DD"));
      if (res?.avgSoilTempC >= soil.minSoilTempC) return d;
    } catch {/* ignore */}
    d = d.add(7, "day");
  }
  return d;
}

/* ─────────────────── Spring / Fall builders (frost-driven) ─────────────────── */
async function buildSpringPlan(c, frost, opts, buffers, climate) {
  const harden = Math.max(0, opts.transplantHardenDays || 0);

  if (c.method === "transplant") {
    let transplant = clampToSeason(frost.last.add((c.transplantRelToLast ?? +7) + buffers.early, "day"), frost, 0);
    const hardenStart = transplant.subtract(harden, "day");
    const sowIndoor = hardenStart.subtract(((c.indoorLeadWeeks || 0) + (opts.indoorLeadWeeksBias || 0)) * 7, "day");
    transplant = await adjustForSoilTemp(transplant.toISOString(), opts);
    const firstHarvest = transplant.add(c.dtm || 60, "day");
    const lastHarvest = firstHarvest.add((c.harvestSpan || 30) + buffers.late, "day");
    return {
      startIndoors: { start: sowIndoor.toISOString(), end: sowIndoor.add(7,"day").toISOString() },
      transplantOut: { start: transplant.toISOString(), end: transplant.add(7,"day").toISOString() },
      hardenStart: hardenStart.toISOString(),
      expectedHarvest: { start: firstHarvest.toISOString(), end: lastHarvest.toISOString() },
      notes: buildNotes(c, "spring", climate),
    };
  } else {
    let sowOutdoor = clampToSeason(frost.last.add((c.sowRelToLast ?? 0) + buffers.early, "day"), frost, 0);
    sowOutdoor = await adjustForSoilTemp(sowOutdoor.toISOString(), opts);
    const emergence = sowOutdoor.add(7, "day");
    const firstHarvest = emergence.add(c.dtm || 50, "day");
    const lastHarvest = firstHarvest.add((c.harvestSpan || 21) + buffers.late, "day");
    return {
      directSow: { start: sowOutdoor.toISOString(), end: sowOutdoor.add(10,"day").toISOString() },
      expectedHarvest: { start: firstHarvest.toISOString(), end: lastHarvest.toISOString() },
      notes: buildNotes(c, "spring", climate),
    };
  }
}
async function buildFallPlan(c, frost, opts, buffers, climate) {
  if (!opts.includeFall) return null;
  const offset = c.fallOffsetToFirst ?? ((c.dtm || 60) + 30);

  if (c.method === "transplant") {
    let transplant = clampToSeason(frost.first.subtract(offset - buffers.early, "day"), frost, 0);
    const hardenStart = transplant.subtract(Math.max(0, opts.transplantHardenDays || 0), "day");
    const sowIndoor = hardenStart.subtract(((c.indoorLeadWeeks || 0) + (opts.indoorLeadWeeksBias || 0)) * 7, "day");
    transplant = await adjustForSoilTemp(transplant.toISOString(), opts);
    const firstHarvest = transplant.add(c.dtm || 60, "day");
    const lastHarvest = dayjs.min(firstHarvest.add((c.harvestSpan || 30) + buffers.late, "day"), frost.first);
    return {
      startIndoors: { start: sowIndoor.toISOString(), end: sowIndoor.add(7,"day").toISOString() },
      transplantOut: { start: transplant.toISOString(), end: transplant.add(7,"day").toISOString() },
      hardenStart: hardenStart.toISOString(),
      expectedHarvest: { start: firstHarvest.toISOString(), end: lastHarvest.toISOString() },
      notes: buildNotes(c, "fall", climate),
    };
  } else {
    let sowOutdoor = clampToSeason(frost.first.subtract(offset - buffers.early, "day"), frost, 0);
    sowOutdoor = await adjustForSoilTemp(sowOutdoor.toISOString(), opts);
    const emergence = sowOutdoor.add(7, "day");
    const firstHarvest = emergence.add(c.dtm || 50, "day");
    const lastHarvest = dayjs.min(firstHarvest.add((c.harvestSpan || 21) + buffers.late, "day"), frost.first);
    return {
      directSow: { start: sowOutdoor.toISOString(), end: sowOutdoor.add(10,"day").toISOString() },
      expectedHarvest: { start: firstHarvest.toISOString(), end: lastHarvest.toISOString() },
      notes: buildNotes(c, "fall", climate),
    };
  }
}

/* ─────────── Tropical/monsoon builder (rainfall-driven, frost-light) ─────────── */
function pickRainWindow(rainfallWindows, preferenceLabel) {
  if (!rainfallWindows?.length) return null;
  if (preferenceLabel) {
    const found = rainfallWindows.find(w => (w.label || "").toLowerCase().includes(preferenceLabel.toLowerCase()));
    if (found) return found;
  }
  return rainfallWindows.slice().sort((a,b) => (b.end.diff(b.start) - a.end.diff(a.start)))[0];
}
async function buildRainDrivenPlan(c, rainfallWindows, opts, buffers, hemisphere) {
  const primary = pickRainWindow(rainfallWindows, hemisphere === "S" ? "main" : "long");
  if (!primary) return { spring: undefined, fall: undefined };

  const isWarm = !!c.warm;
  const sowStart = isWarm ? primary.start.add(buffers.early, "day")
                          : primary.start.add(14 + buffers.early, "day");
  const sowEnd = sowStart.add(10, "day");
  const emergence = sowStart.add(7, "day");
  const firstHarvest = emergence.add(c.dtm || 50, "day");
  const lastHarvest = firstHarvest.add((c.harvestSpan || 21) + buffers.late, "day");

  const springLike = hemisphere === "S" ? "fall" : "spring";
  const fallLike   = hemisphere === "S" ? "spring" : "fall";

  const springPlan = (c.method === "transplant")
    ? {
        startIndoors: { start: sowStart.subtract((c.indoorLeadWeeks || 0) * 7, "day").toISOString(), end: sowStart.toISOString() },
        transplantOut: { start: sowStart.add(7,"day").toISOString(), end: sowStart.add(14,"day").toISOString() },
        hardenStart: sowStart.toISOString(),
        expectedHarvest: { start: firstHarvest.toISOString(), end: lastHarvest.toISOString() },
        notes: buildNotes(c, springLike, { climateMode: "rain" })
      }
    : {
        directSow: { start: sowStart.toISOString(), end: sowEnd.toISOString() },
        expectedHarvest: { start: firstHarvest.toISOString(), end: lastHarvest.toISOString() },
        notes: buildNotes(c, springLike, { climateMode: "rain" })
      };

  const second = rainfallWindows.find(w => w !== primary);
  const fallPlan = second ? (c.method === "transplant"
    ? {
        startIndoors: { start: second.start.subtract((c.indoorLeadWeeks || 0) * 7, "day").toISOString(), end: second.start.toISOString() },
        transplantOut: { start: second.start.add(7,"day").toISOString(), end: second.start.add(14,"day").toISOString() },
        hardenStart: second.start.toISOString(),
        expectedHarvest: {
          start: second.start.add((c.dtm || 60) + 7, "day").toISOString(),
          end: second.start.add((c.dtm || 60) + 7 + (c.harvestSpan || 30), "day").toISOString()
        },
        notes: buildNotes(c, fallLike, { climateMode: "rain" })
      }
    : {
        directSow: { start: second.start.toISOString(), end: second.start.add(10,"day").toISOString() },
        expectedHarvest: {
          start: second.start.add((c.dtm || 50) + 7, "day").toISOString(),
          end: second.start.add((c.dtm || 50) + 7 + (c.harvestSpan || 21), "day").toISOString()
        },
        notes: buildNotes(c, fallLike, { climateMode: "rain" })
      }) : undefined;

  return {
    spring: hemisphere === "S" ? fallPlan || springPlan : springPlan,
    fall:   hemisphere === "S" ? springPlan : (fallPlan || undefined)
  };
}

/* ───────────── Helper: notes with simple climate context hints ───────────── */
function buildNotes(c, season, climate) {
  const notes = [];
  if (climate?.climateMode === "rain") {
    notes.push("Rain-season aligned schedule.");
  } else {
    if (c.warm && season === "spring") notes.push("Frost-sensitive; ensure warm soil.");
    if (!c.warm && season === "spring") notes.push("Cool-season tolerant; row cover helps early growth.");
    if (!c.warm && season === "fall") notes.push("Prefers cooler temps; excellent for fall.");
  }
  if (c.method === "transplant") notes.push("Start indoors; harden off before transplant.");
  else notes.push("Direct sow in prepared bed.");
  return notes;
}

/* ───────────── Harvest-target alignment (Meals / Feasts) ───────────── */
function alignHarvestTargets(cropKey, schedule, targets = []) {
  const hits = [];
  const spans = [];
  ["spring","fall"].forEach(season => {
    const block = schedule[season];
    if (!block?.expectedHarvest) return;
    spans.push({ season, start: dayjs(block.expectedHarvest.start), end: dayjs(block.expectedHarvest.end) });
    (block.successions || []).forEach((s) => {
      if (s.expectedHarvest) spans.push({ season, start: dayjs(s.expectedHarvest.start), end: dayjs(s.expectedHarvest.end) });
    });
  });
  for (const t of targets || []) {
    const ts = dayjs(t.start), te = dayjs(t.end);
    for (const sp of spans) {
      const overlapStart = dayjs.max(ts, sp.start);
      const overlapEnd = dayjs.min(te, sp.end);
      if (overlapEnd.isAfter(overlapStart)) {
        hits.push({ crop: cropKey, targetLabel: t.label, start: overlapStart.format("YYYY-MM-DD"), end: overlapEnd.format("YYYY-MM-DD") });
      }
    }
  }
  return hits;
}

/* ───────────── Calendar stubs (optional) ───────────── */
function calendarStubsForCrop(key, name, sched, provider="local") {
  const events = [];
  const addRange = (title, range, meta={}) => {
    if (!range?.start) return;
    const start = dayjs(range.start).hour(9).toISOString();
    const end = range.end ? dayjs(range.end).hour(17).toISOString() : dayjs(range.start).hour(17).toISOString();
    events.push({
      id: `${title}_${key}_${dayjs(range.start).format("YYYYMMDD")}`,
      title: `${title}: ${name}`,
      start, end,
      description: `${title} window for ${name}`,
      location: "Garden",
      meta: { cropKey: key, ...meta },
    });
  };

  for (const season of ["spring","fall"]) {
    const blk = sched[season];
    if (!blk) continue;
    addRange("Direct sow", blk.directSow, { season, kind:"direct_sow" });
    addRange("Start indoors", blk.startIndoors, { season, kind:"seed_start" });
    if (blk.hardenStart) {
      const hs = dayjs(blk.hardenStart).toISOString();
      events.push({
        id: `Harden_${key}_${dayjs(hs).format("YYYYMMDD")}`,
        title: `Harden-off start: ${name}`,
        start: hs,
        end: dayjs(hs).add(2,"day").toISOString(),
        description: "Begin hardening off seedlings",
        location: "Garden",
        meta: { cropKey: key, season, kind:"harden_off" },
      });
    }
    addRange("Transplant out", blk.transplantOut, { season, kind:"transplant" });
    addRange("Harvest window", blk.expectedHarvest, { season, kind:"harvest_window" });

    if (blk.successions?.length) {
      blk.successions.forEach((s, idx) => {
        addRange(`Succession ${idx+1} — Direct sow`, s.directSow, { season, succession: idx+1, kind:"direct_sow" });
        addRange(`Succession ${idx+1} — Start indoors`, s.startIndoors, { season, succession: idx+1, kind:"seed_start" });
        addRange(`Succession ${idx+1} — Transplant out`, s.transplantOut, { season, succession: idx+1, kind:"transplant" });
        addRange(`Succession ${idx+1} — Harvest`, s.expectedHarvest, { season, succession: idx+1, kind:"harvest_window" });
      });
    }
  }
  return { provider, events };
}

/* ───────────── Irrigation helpers & market alignment ───────────── */
function weeklyWaterNeedL(cropKey, climateIsDry) {
  const base = WATER_NEED_L_PER_M2_PER_WEEK[cropKey] ?? 15;
  return Math.max(6, Math.round(base * (climateIsDry ? 1.15 : 0.8)));
}
function computeCropAreaCap(cropKey, opts, weeks, climateIsDry) {
  if (!opts?.irrigation?.enabled) return null;
  const perWeekPerM2 = weeklyWaterNeedL(cropKey, climateIsDry);
  const { distributionEfficiency=0.8 } = opts.irrigation;
  const effNeed = perWeekPerM2 * weeks / distributionEfficiency; // L per m² over the season
  const { areaM2=20, capacityL=0, dailyRechargeL=0 } = opts.irrigation;
  const effAvail = (capacityL + dailyRechargeL * 7 * weeks);
  const capByWater = Math.floor(effAvail / Math.max(1, effNeed));
  return Math.max(0, Math.min(areaM2, capByWater));
}
async function priceFor(cropKey, range, opts) {
  if (opts?.market?.priceProvider) {
    try {
      const data = await opts.market.priceProvider(cropKey, range);
      if (data?.avgPricePerKg) return data.avgPricePerKg;
    } catch {/* ignore */}
  }
  return opts?.market?.baseFarmgatePriceUSD?.[cropKey] ?? 0.5;
}
function costFor(cropKey, areaM2, opts) {
  const c = opts?.market?.costs || {};
  const perM2 = (c.seedUSDPerM2 ?? 0.1) + (c.fertUSDPerM2 ?? 0.2) + (c.laborUSDPerM2 ?? 0);
  const waterUSD = (() => {
    if (!opts?.irrigation?.enabled) return 0;
    const priceM3 = opts.irrigation.costPerM3 ?? 0;
    if (!priceM3) return 0;
    const m3 = (0.18 * areaM2); // approx season 0.18 m³/m²
    return m3 * priceM3;
  })();
  return perM2 * areaM2 + waterUSD;
}
function alignToMarketDays(dateISO, marketDays) {
  if (!Array.isArray(marketDays) || !marketDays.length) return dayjs(dateISO);
  let d = dayjs(dateISO);
  for (let i=0;i<3;i++) { if (marketDays.includes(d.day())) return d; d = d.add(1,"day"); }
  for (let i=0;i<7;i++) { if (marketDays.includes(d.day())) return d; d = d.add(1,"day"); }
  return dayjs(dateISO);
}
function irrigationEventsForCrop(key, name, sched, opts) {
  if (!opts?.irrigation?.enabled) return [];
  const events = [];
  const wkly = (startISO, weeks, litersPerM2) => {
    const area = sched?.meta?.areaCapM2 ?? opts.irrigation.areaM2 ?? 20;
    const liters = Math.round(area * litersPerM2);
    let d = dayjs(startISO).hour(7).minute(0);
    for (let i=0;i<weeks;i++) {
      events.push({
        id: `Irrigate_${key}_${d.format("YYYYMMDD")}`,
        title: `Irrigate: ${name} (~${liters} L)`,
        start: d.toISOString(),
        end: d.add(1,"hour").toISOString(),
        description: `Weekly irrigation for ${name}; est. ${liters} L`,
        location: "Field",
        meta: { cropKey: key, kind: "irrigate", liters, areaM2: area }
      });
      d = d.add(7, "day");
    }
  };
  for (const season of ["spring","fall"]) {
    const blk = sched[season];
    if (!blk?.expectedHarvest) continue;
    const weeks = Math.max(1, dayjs(blk.expectedHarvest.end).diff(dayjs(blk.expectedHarvest.start), "week", true));
    const litersPerM2 = sched?.meta?.weeklyWaterLPerM2 ?? 20;
    const anchor = blk.directSow?.start || blk.transplantOut?.start || dayjs(blk.expectedHarvest.start).subtract(4, "week").toISOString();
    wkly(anchor, Math.ceil(weeks), litersPerM2);
  }
  return events;
}

/* ─────────────────────── Minimal legacy map ─────────────────────── */
function minimalPrimaryWindowMap(schedulesRecord) {
  const out = {};
  for (const [key, sched] of Object.entries(schedulesRecord)) {
    let range = null;
    if (sched.spring?.transplantOut) range = sched.spring.transplantOut;
    else if (sched.spring?.directSow) range = sched.spring.directSow;
    else if (sched.fall?.transplantOut) range = sched.fall.transplantOut;
    else if (sched.fall?.directSow) range = sched.fall.directSow;
    if (range) out[key] = { start: range.start.slice(0,10), end: range.end.slice(0,10) };
  }
  return out;
}

/* ─────────────────────────── Public API ─────────────────────────── */
/**
 * Preferred signature:
 *   getZonePlantingDates({ zone, year, crops, options })
 *
 * Legacy signature (minimal result):
 *   getZonePlantingDates(zone, crops)
 */
async function getZonePlantingDates(arg1, arg2, arg3) {
  if (typeof arg1 === "string") {
    const zone = arg1;
    const crops = Array.isArray(arg2) ? arg2 : null;
    const options = (arg3 && typeof arg3 === "object") ? arg3 : {};
    const rich = await _getZonePlantingDatesRich({ zone, year: dayjs().year(), crops, options });
    if (!arg3) return minimalPrimaryWindowMap(rich.schedules);
    return rich;
  }

  const { zone = "8a", year = dayjs().year(), crops = null, options = {} } = arg1 || {};
  return _getZonePlantingDatesRich({ zone, year, crops, options });
}

async function _getZonePlantingDatesRich({ zone = "8a", year = dayjs().year(), crops = null, options = {} }) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const warnings = [];

  const { frost, rainfallWindows, diagnostics, warnings: climateWarns, hemisphere } =
    await resolveClimate({ zone, year, opts });
  warnings.push(...climateWarns);

  const buffers = computeBuffers(opts);

  const list = Array.isArray(crops) && crops.length
    ? crops.map(c => ensureCropSpec(c, opts.overrides))
    : Object.entries(CROPS).map(([key, val]) => ensureCropSpec({ key, ...val }, opts.overrides));

  const schedules = {};
  const linksHarvestAligned = [];

  const rainMode = !!(rainfallWindows && rainfallWindows.length);
  const climateIsDry = !rainMode;

  for (const c of list) {
    let spring, fall, irrigated = false;

    if (rainMode && (!opts.frost || diagnostics.dataGaps.includes("frost"))) {
      const rf = await buildRainDrivenPlan(c, rainfallWindows, opts, buffers, hemisphere);
      spring = rf.spring;
      fall   = rf.fall;
    } else {
      spring = await buildSpringPlan(c, frost, opts, buffers, { climateMode: "frost", hemisphere });
      fall   = await buildFallPlan(c, frost, opts, buffers, { climateMode: "frost", hemisphere });
    }

    // If no rain-driven or frost-driven window (true dry-season) but irrigation is enabled, build irrigated plan:
    if (!spring && !fall && opts?.irrigation?.enabled) {
      const start = dayjs().add(7, "day");
      const end = start.add(10, "day");
      const firstHarvest = start.add((c.dtm || 60) + 7, "day");
      const lastHarvest  = firstHarvest.add((c.harvestSpan || 21) + buffers.late, "day");
      spring = {
        ...(c.method === "transplant"
          ? {
              startIndoors: { start: start.subtract((c.indoorLeadWeeks || 0) * 7, "day").toISOString(), end: start.toISOString() },
              transplantOut: { start: start.add(7,"day").toISOString(), end: start.add(14,"day").toISOString() },
              hardenStart: start.toISOString(),
            }
          : { directSow: { start: start.toISOString(), end: end.toISOString() } }
        ),
        expectedHarvest: { start: firstHarvest.toISOString(), end: lastHarvest.toISOString() },
        notes: ["Irrigated dry-season planting."]
      };
      irrigated = true;
    }

    const schedule = {
      crop: c.name || c.key,
      method: (c.method === "direct" ? "direct_sow" : c.method) || "direct_sow",
      spring: spring ? { ...spring, successions: [] } : undefined,
      fall:   fall   ? { ...fall,   successions: [] } : undefined,
      meta: {
        zone: formatZone(zone),
        zoneDetail: parseUSDA(zone) ? { system: "USDA", code: formatZone(zone) } : null,
        season: [spring && "spring", fall && "fall"].filter(Boolean),
        daysToMaturity: c.dtm,
        indoorLeadTimeDays: (c.indoorLeadWeeks || 0) * 7,
        buffers: { early: buffers.early, late: buffers.late },
        confidence: confidenceFor(c, opts, spring ? "spring" : "fall"),
        source: opts.source || (rainMode ? "global_normals" : "usda_zone_table"),
        notes: [],
        companionNotes: opts.includeCompanionNotes ? companionNotesFor(c.key) : [],
        rainfall: rainfallWindows
          ? rainfallWindows.map(w => ({ start: w.start.format("YYYY-MM-DD"), end: w.end.format("YYYY-MM-DD"), label: w.label }))
          : undefined,
        irrigated: irrigated || undefined
      },
    };

    // Successions
    const succCount = Number(c.successions ?? opts.successions) || 0;
    const interval  = Number(c.successionIntervalDays ?? opts.successionEveryDays ?? 14) || 14;
    if (succCount > 0 && schedule.spring) { schedule.spring.successions = []; addSuccessionsInto(schedule.spring.successions, schedule.spring, succCount, interval); }
    if (succCount > 0 && schedule.fall)   { schedule.fall.successions = [];   addSuccessionsInto(schedule.fall.successions, schedule.fall,   succCount, interval); }

    // Water budget: area cap & weekly water need
    const harvestSpanWeeks = (() => {
      const blk = schedule.spring?.expectedHarvest || schedule.fall?.expectedHarvest;
      if (!blk) return 6;
      const weeks = Math.max(1, dayjs(blk.end).diff(dayjs(blk.start), "week", true));
      return Math.ceil(weeks);
    })();
    const areaCap = computeCropAreaCap(c.key, opts, harvestSpanWeeks, climateIsDry);
    if (areaCap != null) {
      schedule.meta.areaCapM2 = areaCap;
      schedule.meta.weeklyWaterLPerM2 = weeklyWaterNeedL(c.key, climateIsDry);
    }

    // Market alignment & profit score (optional)
    if (opts?.market?.align) {
      for (const season of ["spring","fall"]) {
        const blk = schedule[season];
        if (!blk?.expectedHarvest) continue;
        const aligned = alignToMarketDays(blk.expectedHarvest.start, opts.market.daysOfWeek || []);
        blk.expectedHarvest.start = aligned.toISOString();

        const price = await priceFor(c.key, { start: blk.expectedHarvest.start, end: blk.expectedHarvest.end }, opts);
        const areaM2 = areaCap ?? (opts?.irrigation?.areaM2 ?? 20);
        const yieldKg = (YIELD_KG_PER_M2[c.key] ?? 1.2) * areaM2;
        const revenue = price * yieldKg;
        const cost = costFor(c.key, areaM2, opts);
        blk.profitUSD = Math.round((revenue - cost) * 100) / 100;
      }
    }

    // Harvest ↔ meal target alignment
    const hits = alignHarvestTargets(c.key, schedule, opts.harvestTargets);
    if (hits.length) linksHarvestAligned.push(...hits);

    schedules[c.key] = schedule;
  }

  // Calendar stubs
  let calendar = { provider: "local", events: [] };
  if (opts.includeCalendarStubs) {
    for (const [key, sched] of Object.entries(schedules)) {
      const cal = calendarStubsForCrop(key, sched.crop, sched, "local");
      calendar.events.push(...cal.events);
      // irrigation reminders (if enabled)
      calendar.events.push(...irrigationEventsForCrop(key, sched.crop, { ...sched, meta: sched.meta }, opts));
    }
  }

  const rich = {
    schedules,
    links: linksHarvestAligned.length ? { harvestAlignedWindows: linksHarvestAligned } : undefined,
    calendar: opts.includeCalendarStubs ? calendar : undefined,
    warnings,
    diagnostics: {
      hemisphere,
      usedProviders: diagnostics.usedProviders,
      usedOverrides: Object.keys(opts.overrides || {}),
      dataGaps: diagnostics.dataGaps
    },
    version: VERSION,
    zone: formatZone(zone),
    year,
    frost: { last: frost.last.format("YYYY-MM-DD"), first: frost.first.format("YYYY-MM-DD") },
  };

  return rich;
}

function formatZone(zone) {
  const parsed = parseUSDA(zone);
  if (parsed) return parsed.sub ? `${parsed.num}${parsed.sub}` : String(parsed.num);
  return String(zone);
}

function addSuccessionsInto(list, basePlan, count, intervalDays) {
  const copies = [];
  for (let i = 1; i <= count; i++) {
    const off = intervalDays * i;
    const clone = JSON.parse(JSON.stringify(basePlan));
    for (const k of ["directSow","startIndoors","transplantOut","expectedHarvest"]) {
      if (clone[k]?.start) clone[k].start = dayjs(clone[k].start).add(off, "day").toISOString();
      if (clone[k]?.end)   clone[k].end   = dayjs(clone[k].end).add(off, "day").toISOString();
    }
    if (clone.hardenStart) clone.hardenStart = dayjs(clone.hardenStart).add(off,"day").toISOString();
    clone.notes = [...(clone.notes||[]), `Succession #${i}`];
    copies.push(clone);
  }
  list.push(...copies);
}

// Convenience export (USDA-only frost)
function getFrostDates(zone, year) {
  const f = frostFromUSDA(zone, year);
  if (!f) return { last: null, first: null };
  return { last: f.last.format("YYYY-MM-DD"), first: f.first.format("YYYY-MM-DD") };
}

module.exports = {
  getZonePlantingDates,
  getFrostDates,
  tables: { ZONE_FROST_TABLE, SUBZONE_ADJUST, CROPS, WATER_NEED_L_PER_M2_PER_WEEK, YIELD_KG_PER_M2 },
};
