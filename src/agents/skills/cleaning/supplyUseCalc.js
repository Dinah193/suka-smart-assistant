/**
 * src/agents/skills/cleaning/supplyUseCalc.js
 *
 * How this fits:
 * - Called by cleaning planners/runners to:
 *   • estimate supply usage for a Routine (per step/zone/plan),
 *   • project next 30/60/90 day consumption,
 *   • compute reorder thresholds: reorderPoint, safetyStock, daysUntilStockout, recommendedQty.
 * - Results can be shown in the SessionRunner "Inventory Notes" pane and used by
 *   the automation runtime to raise `inventory.shortage.detected` or to pre-build
 *   shopping lists / storehouse orders.
 *
 * Events (optional, safe no-ops if eventBus not wired):
 * - supply.usage.estimated
 * - supply.reorder.recommended
 *
 * Contracts touched:
 * - Consumes CleaningPlan-like or Session-like data (zones->tasks or steps with metadata.supplies).
 * - Integrates with Storehouse via caller-provided lookups:
 *     options.inventoryGet(supplyName) -> { qty:number, unit:string, lot?:string, min?:number, max?:number }
 *     options.priceGet(supplyName)     -> { unitPrice:number, currency:string, unit:string }
 *
 * Extension points:
 * - registerSupplyProfile(name, profile)
 * - mapTaskTypeSupply(taskType, mapping)
 * - registerUsageCurve(name, fn)  // allow non-linear scaling by soil level, dilution, nozzle, etc.
 * - setDefaults({ horizonDays, serviceLevel, leadTimeDays, safetyDays })
 */

import { emit } from "@/services/eventBus"; // optional analytics; swallow if missing

/* -------------------------------- Defaults -------------------------------- */

const DEFAULTS = {
  horizonDays: 30,
  serviceLevel: 0.9,   // for safety stock heuristic
  leadTimeDays: 5,     // supplier lead time baseline
  safetyDays: 7,       // additive safety days if no variance data
};

export function setDefaults(partial = {}) {
  Object.assign(DEFAULTS, sanitize(partial));
}

/* --------------------------- Canon + Unit Helpers -------------------------- */

const UNIT = {
  ml: 1,
  l: 1000,
  g: 1,        // treat as ml when density≈1; profiles may override density
  kg: 1000,    // same note as above
  oz: 29.5735,
  fl_oz: 29.5735,
  gal: 3785.41,
  each: 1,     // for counts (e.g., trash bags)
};

function canonUnit(u) {
  const s = String(u || "").toLowerCase().trim();
  if (s === "liter" || s === "litre") return "l";
  if (s === "ounce" || s === "oz") return "oz";
  if (s === "fluid ounce" || s === "fl oz" || s === "floz") return "fl_oz";
  if (s === "gallon" || s === "gallons") return "gal";
  if (s === "piece" || s === "pcs" || s === "count") return "each";
  return s;
}

function toMl(qty, unit, density) {
  const u = canonUnit(unit);
  if (u in UNIT) {
    if (u === "g" || u === "kg") {
      // mass→ml bridge; default density ≈1 unless profile supplies one
      const dens = Number.isFinite(density) && density > 0 ? density : 1.0;
      const g = qty * (u === "kg" ? 1000 : 1);
      return g / dens;
    }
    return qty * (UNIT[u] || 1);
  }
  // unknown unit → assume ml-ish
  return qty;
}

function fromMl(ml, toUnit) {
  const u = canonUnit(toUnit);
  const f = UNIT[u] || 1;
  return { qty: ml / f, unit: u || "ml" };
}

/* --------------------------- Supply Profiles DB ---------------------------- */
/**
 * Profile:
 * {
 *   unit: "ml"|"each",
 *   defaultUse: {               // per "action" baseline, before curves
 *     perTaskType: { [type]: { qty: number, unit: string } }, // overrides by task.type
 *     generic?: { qty:number, unit:string }
 *   },
 *   dilution?: number,          // e.g., 0.1 → 1:9 concentrate; usage scales by 1/dilution
 *   density?: number,           // g/ml (for mass unit bridging)
 *   isCountBased?: boolean,     // e.g., trash bags
 *   min?: number, max?: number, // default min/max if inventory lacks
 * }
 */
const SUPPLY_PROFILES = new Map();

/** Register or override a supply profile */
export function registerSupplyProfile(name, profile) {
  const key = safeKey(name);
  if (!key || !profile) return;
  const merged = mergeDeep(SUPPLY_PROFILES.get(key) || {}, profile);
  SUPPLY_PROFILES.set(key, merged);
}

/** Quick lookup */
function getProfile(name) {
  return SUPPLY_PROFILES.get(safeKey(name));
}

/* --------- Built-ins: common household cleaning supplies (editable) -------- */

registerSupplyProfile("glass cleaner", {
  unit: "ml",
  defaultUse: { generic: { qty: 10, unit: "ml" }, perTaskType: { windows: { qty: 12, unit: "ml" }, wipe: { qty: 8, unit: "ml" } } },
  density: 1.0,
  min: 200, max: 1500,
});

registerSupplyProfile("all-purpose cleaner", {
  unit: "ml",
  defaultUse: { generic: { qty: 15, unit: "ml" }, perTaskType: { wipe: { qty: 15, unit: "ml" }, scrub: { qty: 25, unit: "ml" } } },
  density: 1.0,
  min: 250, max: 3000,
});

registerSupplyProfile("disinfectant", {
  unit: "ml",
  defaultUse: { generic: { qty: 20, unit: "ml" }, perTaskType: { disinfect: { qty: 25, unit: "ml" }, sanitize: { qty: 20, unit: "ml" } } },
  density: 1.0,
  min: 250, max: 2000,
});

registerSupplyProfile("degreaser", {
  unit: "ml",
  defaultUse: { generic: { qty: 20, unit: "ml" }, perTaskType: { scrub: { qty: 30, unit: "ml" } } },
  density: 1.02,
  min: 200, max: 1500,
});

registerSupplyProfile("dish soap", {
  unit: "ml",
  defaultUse: { generic: { qty: 8, unit: "ml" }, perTaskType: { wash: { qty: 10, unit: "ml" } } },
  density: 1.03,
  min: 150, max: 1000,
});

registerSupplyProfile("laundry detergent", {
  unit: "ml",
  defaultUse: { perTaskType: { laundry: { qty: 80, unit: "ml" } } },
  density: 1.04,
  min: 500, max: 4000,
});

registerSupplyProfile("bleach", {
  unit: "ml",
  defaultUse: { perTaskType: { sanitize: { qty: 15, unit: "ml" }, disinfect: { qty: 20, unit: "ml" } } },
  density: 1.2,
  min: 250, max: 2000,
});

registerSupplyProfile("floor cleaner", {
  unit: "ml",
  defaultUse: { perTaskType: { mop: { qty: 25, unit: "ml" }, "steam-mop": { qty: 5, unit: "ml" } }, generic: { qty: 20, unit: "ml" } },
  density: 1.0,
  min: 200, max: 2000,
});

registerSupplyProfile("toilet bowl cleaner", {
  unit: "ml",
  defaultUse: { generic: { qty: 30, unit: "ml" } },
  density: 1.1,
  min: 250, max: 1000,
});

registerSupplyProfile("trash bags", {
  unit: "each",
  defaultUse: { perTaskType: { trash: { qty: 1, unit: "each" } }, generic: { qty: 1, unit: "each" } },
  isCountBased: true,
  min: 5, max: 40,
});

/* ----------------------- Task Type → Supply Mappings ----------------------- */
/**
 * Mapping record example:
 * "windows" => [{ name:"glass cleaner", curve:"spray.default" }]
 */
const TASK_SUPPLY_MAP = new Map();

export function mapTaskTypeSupply(taskType, supplies) {
  const key = String(taskType || "").toLowerCase();
  if (!key) return;
  TASK_SUPPLY_MAP.set(key, Array.isArray(supplies) ? supplies : []);
}

/* Built-ins */
mapTaskTypeSupply("windows", [{ name: "glass cleaner", curve: "spray.default" }, { name: "microfiber cloth", curve: "wipe.default" }]);
mapTaskTypeSupply("wipe", [{ name: "all-purpose cleaner", curve: "spray.default" }]);
mapTaskTypeSupply("scrub", [{ name: "degreaser", curve: "spray.heavy" }]);
mapTaskTypeSupply("sanitize", [{ name: "disinfectant", curve: "spray.default" }]);
mapTaskTypeSupply("disinfect", [{ name: "disinfectant", curve: "spray.heavy" }]);
mapTaskTypeSupply("mop", [{ name: "floor cleaner", curve: "bucket.default" }]);
mapTaskTypeSupply("steam-mop", [{ name: "floor cleaner", curve: "steam.micro" }]);
mapTaskTypeSupply("laundry", [{ name: "laundry detergent", curve: "dose.default" }]);
mapTaskTypeSupply("trash", [{ name: "trash bags", curve: "count.one" }]);

/* ----------------------------- Usage Curves -------------------------------- */
/**
 * Curves receive ({ baseMl, task, profile }) and return ml (or each for isCountBased).
 * Use to scale for soilLevel, nozzle choice, dilution, etc.
 */
const USAGE_CURVES = new Map();

export function registerUsageCurve(name, fn) {
  if (typeof fn === "function") USAGE_CURVES.set(String(name), fn);
}

function evalCurve(name, input) {
  const fn = USAGE_CURVES.get(name);
  if (!fn) return input.baseMl;
  try {
    const v = fn(input);
    return Number.isFinite(v) ? v : input.baseMl;
  } catch {
    return input.baseMl;
  }
}

/* Built-in curves */
registerUsageCurve("spray.default", ({ baseMl, task }) => {
  // soil: low(0.9), medium(1.0), high(1.25)
  const mul = task.soilLevel === "high" ? 1.25 : task.soilLevel === "low" ? 0.9 : 1.0;
  return baseMl * mul;
});
registerUsageCurve("spray.heavy", ({ baseMl, task }) => baseMl * (task.soilLevel === "high" ? 1.6 : 1.2));
registerUsageCurve("bucket.default", ({ baseMl, task }) => baseMl * (task.soilLevel === "high" ? 1.3 : 1.0));
registerUsageCurve("steam.micro", ({ baseMl }) => Math.max(3, baseMl * 0.35)); // very small reservoir
registerUsageCurve("dose.default", ({ baseMl }) => baseMl);
registerUsageCurve("count.one", ({ baseMl }) => baseMl);

/* ----------------------------- Public API ---------------------------------- */

/**
 * Estimate supply usage for a CleaningPlan-like structure.
 * @param {Object} plan   CleaningPlan-like { zones:[{tasks:[...]}] }
 * @param {Object} options
 * @param {(name:string)=>({qty:number,unit:string,min?:number,max?:number}|null)} [options.inventoryGet]
 * @param {(name:string)=>({unitPrice:number,currency:string,unit:string}|null)} [options.priceGet]
 * @returns {{
 *   totals: Record<string,{ ml:number, each:number, cost?:number, currency?:string }>,
 *   perTask: Array<{ zoneId:string, taskId:string, supplies:Array<{ name:string, ml?:number, each?:number }> }>,
 *   notes: string[]
 * }}
 */
export function estimatePlanConsumption(plan, options = {}) {
  const totals = {}; // name → { ml, each, cost?, currency? }
  const perTask = [];
  const notes = [];

  for (const zone of plan?.zones || []) {
    for (const task of zone?.tasks || []) {
      const out = { zoneId: zone.id, taskId: task.id, supplies: [] };
      const mappings = TASK_SUPPLY_MAP.get(String(task.type || "").toLowerCase()) || [];
      const explicitSupplies = Array.isArray(task.supplies) ? task.supplies : [];

      // Combine mapped supplies with explicit ones (explicit gets no curve by default)
      const merged = [
        ...mappings.map((m) => ({ name: m.name, curve: m.curve })),
        ...explicitSupplies.map((n) => ({ name: n, curve: undefined })),
      ];

      for (const item of merged) {
        const prof = getProfile(item.name) || inferProfileFromName(item.name);
        const base = baseUsageForTask(task, prof);
        const baseMl = prof.isCountBased ? base.each : base.ml;
        const curveName = item.curve || (prof.isCountBased ? "count.one" : "spray.default");
        const used = evalCurve(curveName, { baseMl, task, profile: prof });
        const usedMl = prof.isCountBased ? 0 : used;
        const usedEach = prof.isCountBased ? Math.round(Math.max(1, used)) : 0;

        // Totals
        if (!totals[item.name]) totals[item.name] = { ml: 0, each: 0 };
        totals[item.name].ml += usedMl;
        totals[item.name].each += usedEach;

        // Cost (if unit matches profile.unit)
        const price = safeCall(options.priceGet, item.name);
        if (price && Number.isFinite(price.unitPrice)) {
          const useQty = prof.isCountBased ? usedEach : fromMl(usedMl, price.unit).qty;
          const lineCost = (useQty / 1) * price.unitPrice;
          totals[item.name].cost = (totals[item.name].cost || 0) + lineCost;
          totals[item.name].currency = price.currency || totals[item.name].currency || "USD";
        }

        out.supplies.push({ name: item.name, ml: usedMl || undefined, each: usedEach || undefined });
      }

      perTask.push(out);
    }
  }

  // Emit analytics (safe)
  try {
    emit?.({
      type: "supply.usage.estimated",
      ts: new Date().toISOString(),
      source: "cleaning.supplyUseCalc",
      data: {
        planId: plan?.id || null,
        items: Object.keys(totals).length,
      },
    });
  } catch {}

  return { totals, perTask, notes };
}

/**
 * Compute reorder thresholds and recommendations for a named supply.
 * @param {string} name supply name
 * @param {{
 *   dailyUseMl?:number, dailyUseEach?:number,
 *   currentQty:number, unit:string, onOrder?:number, backorder?:number,
 *   leadTimeDays?:number, safetyDays?:number, serviceLevel?:number,
 *   min?:number, max?:number, roundTo?:number
 * }} opts
 * @returns {{
 *   reorderPoint:number, // in the same unit as input unit
 *   recommendedQty:number,
 *   daysUntilStockout:number,
 *   projectedRunoutDate:string,
 *   safetyStock:number,
 *   unit:string
 * }}
 */
export function computeReorderRecommendation(name, opts = {}) {
  const prof = getProfile(name) || {};
  const unit = canonUnit(opts.unit || prof.unit || "ml");

  // Convert daily use to ml/each (consistent internal calc)
  const useMl = Number(opts.dailyUseMl) || 0;
  const useEach = Number(opts.dailyUseEach) || 0;
  const isCount = unit === "each" || prof.isCountBased;

  const lead = Math.max(0, Number(opts.leadTimeDays ?? DEFAULTS.leadTimeDays));
  const safetyDays = Math.max(0, Number(opts.safetyDays ?? DEFAULTS.safetyDays));

  // Safety stock (very simple heuristic when variance is unknown)
  const safetyStock = (isCount ? useEach : useMl) * safetyDays;

  // Reorder point (ROP) = demand during lead time + safety stock
  const demandLT = (isCount ? useEach : useMl) * lead;
  const ropInternal = demandLT + safetyStock;

  // Convert ROP to the desired unit (if needed)
  const ropOut = isCount ? ropInternal : fromMl(ropInternal, unit).qty;

  // Recommended order qty: top up to max, else EOQ-ish fallback (2 weeks of use)
  const min = Number.isFinite(opts.min) ? opts.min : prof.min || (isCount ? 5 : 250);
  const max = Number.isFinite(opts.max) ? opts.max : prof.max || (isCount ? 40 : 2000);
  const roundTo = Number.isFinite(opts.roundTo) ? Math.max(1, opts.roundTo) : (isCount ? 1 : 50);

  const current = Number(opts.currentQty) || 0;
  const onOrder = Number(opts.onOrder) || 0;
  const backorder = Number(opts.backorder) || 0;
  const available = Math.max(0, current + onOrder - backorder);

  const targetFill = Math.max(min, max);
  const needed = clampNum(targetFill - available, 0, Number.MAX_SAFE_INTEGER);

  // EOQ-ish: if not topping to max, suggest 14 days of use (rounded)
  const fourteenDays = (isCount ? useEach : useMl) * 14;
  const fallbackQty = isCount ? fourteenDays : fromMl(fourteenDays, unit).qty;

  const recommended = roundUp(Math.max(needed, fallbackQty), roundTo);

  // Days until stockout
  const dailyUseOut = isCount ? useEach : fromMl(useMl, unit).qty;
  const daysUntil = dailyUseOut > 0 ? Math.floor(available / dailyUseOut) : Infinity;
  const runoutDate = new Date(Date.now() + (daysUntil * 24 * 3600 * 1000)).toISOString();

  const result = {
    reorderPoint: roundUp(ropOut, roundTo),
    recommendedQty: recommended,
    daysUntilStockout: isFinite(daysUntil) ? daysUntil : 9999,
    projectedRunoutDate: runoutDate,
    safetyStock: isCount ? safetyStock : fromMl(safetyStock, unit).qty,
    unit,
  };

  // Emit analytics (safe)
  try {
    emit?.({
      type: "supply.reorder.recommended",
      ts: new Date().toISOString(),
      source: "cleaning.supplyUseCalc",
      data: { name, unit, reorderPoint: result.reorderPoint, recommendedQty: result.recommendedQty },
    });
  } catch {}

  return result;
}

/**
 * Convenience: compute reorder recs for all totals (from estimatePlanConsumption)
 * using horizonDays projection.
 * @param {Record<string,{ml:number,each:number}>} totals
 * @param {{ horizonDays?:number, inventoryGet?:(n:string)=>({qty:number,unit:string,min?:number,max?:number}|null) }} options
 */
export function recommendForTotals(totals, options = {}) {
  const horizon = Math.max(1, Number(options.horizonDays ?? DEFAULTS.horizonDays));
  const out = {};
  for (const [name, t] of Object.entries(totals || {})) {
    const prof = getProfile(name) || {};
    const inv = safeCall(options.inventoryGet, name) || {};
    const isCount = prof.isCountBased || false;

    const dailyMl = (t.ml || 0) / horizon;
    const dailyEach = (t.each || 0) / horizon;

    out[name] = computeReorderRecommendation(name, {
      dailyUseMl: isCount ? 0 : dailyMl,
      dailyUseEach: isCount ? dailyEach : 0,
      currentQty: inv.qty || 0,
      unit: inv.unit || (isCount ? "each" : prof.unit || "ml"),
      min: inv.min ?? prof.min,
      max: inv.max ?? prof.max,
    });
  }
  return out;
}

/* ------------------------------- Internals -------------------------------- */

function baseUsageForTask(task, profile = {}) {
  // Determine base qty from profile per task.type or generic, then apply dilution
  const t = String(task?.type || "").toLowerCase();
  const per = profile?.defaultUse?.perTaskType || {};
  const generic = profile?.defaultUse?.generic || null;

  const spec = per[t] || generic || { qty: profile.isCountBased ? 1 : 10, unit: profile.isCountBased ? "each" : (profile.unit || "ml") };

  if (profile.isCountBased) {
    return { each: clampInt(spec.qty, 0, 1000), ml: 0 };
    }
  // Liquid math
  let ml = toMl(spec.qty, spec.unit, profile.density);
  // Dilution: if concentrate at 0.1, actual ready-to-use ml becomes base * (1 / 0.1) = ×10
  if (Number.isFinite(profile.dilution) && profile.dilution > 0 && profile.dilution < 1) {
    ml = ml * (1 / profile.dilution);
  }
  return { ml: clampNum(ml, 0, 100000), each: 0 };
}

function inferProfileFromName(name) {
  // Fallback lightweight profile if user uses a one-off supply name
  return {
    unit: "ml",
    defaultUse: { generic: { qty: 10, unit: "ml" } },
    density: 1.0,
    min: 200,
    max: 1500,
    isCountBased: false,
  };
}

/* ------------------------------ Small Utils -------------------------------- */

function safeKey(s) {
  return String(s || "").trim().toLowerCase();
}

function sanitize(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function safeCall(fn, ...args) {
  try { return fn?.(...args); } catch { return null; }
}

function mergeDeep(base, patch) {
  if (!base || typeof base !== "object") return clone(patch);
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    const bv = base[k];
    if (pv && typeof pv === "object" && !Array.isArray(pv)) out[k] = mergeDeep(bv || {}, pv);
    else out[k] = clone(pv);
  }
  return out;
}

function clone(v) {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

function clampNum(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n) || 0);
  return Math.min(Math.max(v, min), max);
}

function roundUp(n, step = 1) {
  if (!Number.isFinite(n) || step <= 0) return 0;
  return Math.ceil(n / step) * step;
}

/* --------------------------------- Export ---------------------------------- */

export default {
  // Estimation
  estimatePlanConsumption,
  recommendForTotals,
  // Reorder math
  computeReorderRecommendation,
  // Registries / knobs
  registerSupplyProfile,
  mapTaskTypeSupply,
  registerUsageCurve,
  setDefaults,
};
