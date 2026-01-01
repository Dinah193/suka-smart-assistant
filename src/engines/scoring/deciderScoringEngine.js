/* eslint-disable no-console */

/**
 * Decider Scoring Engine (multi-domain)
 * -------------------------------------------------
 * Domains supported:
 *  - meals (recipes): onHandPct, timeFit, budgetFit, dietMatch     (existing)
 *  - garden (tasks):  seasonFit, frostFit, bedFit, effortFit
 *  - cleaning (tasks/SOPs): supplyOnHand, timeFit, ppeCompliance, dwellCoverage
 *  - animal-care (SOPs): equipOnHand, roleCoverage, safetyCompliance, timeFit
 *
 * Output (all domains):
 *  {
 *    id, score, domain, signals: {...domainSignals},
 *    weights, reasons: string[], nextBestActions: string[]
 *  }
 *
 * Notes:
 *  - Defensive imports let engine run even if certain managers aren’t loaded.
 *  - Weights are tunable per-domain via Settings/automation, auto-normalized.
 *  - Emits small hints to eventBus/NBA when helpful (optional).
 */

// ----------------------------- Defensive deps --------------------------------
let eventBus = { emit: () => {} };
try {
  // @ts-ignore
  eventBus = require("@/services/eventBus").eventBus || eventBus;
} catch {}

let automation = null;
try {
  // @ts-ignore
  automation = require("@/services/automation/runtime").automation || null;
} catch {}

let InventoryMonitor = null;
try {
  // @ts-ignore
  InventoryMonitor = require("@/managers/InventoryMonitor").default || null;
} catch {}

let PersonalFoodStandards = null;
try {
  // @ts-ignore
  PersonalFoodStandards = require("@/components/tier1/components/PersonalFoodStandardsForm").API || null;
} catch {}

let priceBook = null;
try {
  // @ts-ignore (optional)
  priceBook = require("@/data/priceBook").default || null;
} catch {}

let units = null;
try {
  // @ts-ignore
  units = require("@/engines/normalization/units").units || null;
} catch {}

let scheduleHelpers = null;
try {
  // @ts-ignore
  scheduleHelpers = require("@/engines/scheduleHelpers").default || require("@/engines/scheduleHelpers") || null;
} catch {}

let useSettingsStore = null;
try {
  // @ts-ignore
  useSettingsStore = require("@/stores/settingsStore").useSettingsStore || null;
} catch {}

let logger = console;

// ----------------------------- Defaults/Weights ------------------------------
/** Global clamp */
const CLAMP = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));

/** Per-domain default weights (auto-normalized on load) */
const DEFAULT_WEIGHTS = {
  meals:   { onHandPct: 0.38, timeFit: 0.22, budgetFit: 0.20, dietMatch: 0.20 },
  garden:  { seasonFit: 0.35, frostFit: 0.25, bedFit: 0.20, effortFit: 0.20 },
  cleaning:{ supplyOnHand: 0.35, timeFit: 0.20, ppeCompliance: 0.25, dwellCoverage: 0.20 },
  "animal-care": { equipOnHand: 0.35, roleCoverage: 0.20, safetyCompliance: 0.25, timeFit: 0.20 },
};

/**
 * Load weights for a domain from automation runtime or defaults.
 */
function loadWeights(domain = "meals") {
  const key = `decider.weights.${domain}`;
  try {
    const w = automation?.get?.(key);
    const base = DEFAULT_WEIGHTS[domain] || DEFAULT_WEIGHTS.meals;
    const merged = w && typeof w === "object" ? { ...base, ...w } : base;
    const sum = Object.values(merged).reduce((a, b) => a + b, 0) || 1;
    Object.keys(merged).forEach((k) => (merged[k] = merged[k] / sum));
    return merged;
  } catch (e) {
    logger.warn("[decider] failed to load weights", domain, e);
    const base = DEFAULT_WEIGHTS[domain] || DEFAULT_WEIGHTS.meals;
    const sum = Object.values(base).reduce((a, b) => a + b, 0) || 1;
    Object.keys(base).forEach((k) => (base[k] = base[k] / sum));
    return base;
  }
}

// ------------------------------ Helpers (shared) ------------------------------
function normName(s) {
  return (s || "").toLowerCase().trim();
}
function toBaseQuantity(qty, unitName) {
  if (!qty || isNaN(qty)) return 0;
  if (!units) return Number(qty);
  try { return units.toBase(qty, unitName || "count"); } catch { return Number(qty); }
}
function getNow() { return Date.now ? new Date() : new Date(); }

// ------------------------------ Meals scorers --------------------------------
function estimateItemCost(ing) {
  if (typeof ing?.cost === "number") return Math.max(ing.cost, 0);
  const key = normName(ing?.name);
  const pb = priceBook?.[key];
  if (pb?.pricePerUnit && ing?.quantity) {
    const qty = toBaseQuantity(ing.quantity, ing.unit);
    return Math.max(qty * Number(pb.pricePerUnit), 0);
  }
  if (ing?.quantity) {
    const qty = toBaseQuantity(ing.quantity, ing.unit);
    const band = ing.category === "meat" ? 3 : ing.category === "produce" ? 0.7 : 1.2;
    return Math.max(qty * band, 0);
  }
  return 0.5;
}
function costPerServing(recipe) {
  const servings = Number(recipe.servings || recipe.yield || 1) || 1;
  const total = Array.isArray(recipe.ingredients)
    ? recipe.ingredients.reduce((acc, ing) => acc + estimateItemCost(ing), 0)
    : Number(recipe.costEstimate || 0);
  return total / servings;
}
function getDietProfile(context = {}) {
  if (context.dietProfile) return context.dietProfile;
  try { const pfs = PersonalFoodStandards?.get?.(); if (pfs) return pfs; } catch {}
  const fromRuntime = automation?.get?.("diet.profile");
  if (fromRuntime) return fromRuntime;
  return { allowTags: [], avoidTags: [], macros: null };
}
function getSubstitutionsMap() {
  const fromRuntime = automation?.get?.("ingredients.substitutions");
  return fromRuntime || {
    "scallion": ["green onion"],
    "green onion": ["scallion"],
    "yogurt": ["kefir", "buttermilk"],
    "buttermilk": ["yogurt", "kefir"],
    "soy sauce": ["tamari", "coconut aminos"],
    "coconut aminos": ["soy sauce", "tamari"],
  };
}
function computeOnHandPct(recipe, context = {}) {
  const reasons = [];
  const substitutions = getSubstitutionsMap();
  const inv = context.inventory || InventoryMonitor?.getSnapshot?.() || {};
  const has = (name) => {
    const key = normName(name);
    if (key in inv && Number(inv[key]?.quantity || inv[key]) > 0) return key;
    const subs = substitutions[key] || [];
    for (const alt of subs) {
      const altKey = normName(alt);
      if (altKey in inv && Number(inv[altKey]?.quantity || inv[altKey]) > 0) return altKey;
    }
    return null;
  };
  const ings = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  if (ings.length === 0) {
    reasons.push("No ingredients listed; treating as fully on-hand.");
    return { value: 1, reasons };
  }
  let have = 0;
  for (const ing of ings) {
    const foundKey = has(ing.name);
    if (!foundKey) { reasons.push(`Missing: ${ing.name}`); continue; }
    const required = toBaseQuantity(ing.quantity, ing.unit);
    const available = Number(inv[foundKey]?.quantity || inv[foundKey] || 0);
    if (required && available) {
      if (available >= required) have += 1;
      else { have += CLAMP(available / required, 0, 1); reasons.push(`Partial on-hand for ${ing.name} (${available}/${required})`); }
    } else { have += 1; }
  }
  const value = CLAMP(have / ings.length, 0, 1);
  if (value === 1) reasons.push("All ingredients on-hand (allowing valid substitutions).");
  return { value, reasons };
}
function computeTimeFit(recipe, context = {}) {
  const reasons = [];
  const slot = Number(context.timeWindowMinutes || context.timeWindow || 0);
  const total = Number(
    recipe.totalTimeMinutes ||
    recipe.totalMinutes ||
    recipe.time?.total ||
    (Number(recipe.time?.prep || 0) + Number(recipe.time?.cook || 0)) ||
    0
  );
  if (!total) {
    reasons.push("No total time provided; neutral time fit (0.6).");
    return { value: 0.6, reasons };
  }
  if (!slot) {
    reasons.push(`No time window; heuristic time fit for total=${total}m.`);
    const v = total <= 20 ? 0.95 : total <= 40 ? 0.8 : total <= 60 ? 0.65 : total <= 90 ? 0.5 : 0.3;
    return { value: v, reasons };
  }
  if (total <= slot) {
    const margin = slot - total;
    const bonus = CLAMP(margin / Math.max(30, slot), 0, 0.2);
    reasons.push(`Fits window (${total}m ≤ ${slot}m).`);
    return { value: CLAMP(0.9 + bonus, 0, 1), reasons };
  }
  const overflow = total - slot;
  const penalty = CLAMP(overflow / Math.max(30, total), 0, 0.85);
  const value = CLAMP(0.9 - penalty, 0, 0.9);
  reasons.push(`Exceeds window by ${overflow}m.`);
  return { value, reasons };
}
function computeBudgetFit(recipe, context = {}) {
  const reasons = [];
  const budget = Number(context.budgetPerServing || context.budget || 0);
  const cps = Number(recipe.costPerServing || costPerServing(recipe));
  if (!cps && !budget) { reasons.push("No budget/cost; neutral (0.6)."); return { value: 0.6, reasons }; }
  if (!budget) {
    reasons.push(`No budget; heuristic for $${cps.toFixed(2)}/serv.`);
    const v = cps <= 2 ? 0.95 : cps <= 4 ? 0.8 : cps <= 7 ? 0.65 : cps <= 10 ? 0.45 : 0.25;
    return { value: v, reasons };
  }
  if (cps <= budget) {
    const margin = budget - cps;
    const bonus = CLAMP(margin / Math.max(1.5, budget), 0, 0.25);
    reasons.push(`At/under budget: $${cps.toFixed(2)} ≤ $${budget.toFixed(2)}/serv.`);
    return { value: CLAMP(0.9 + bonus, 0, 1), reasons };
  }
  const over = cps - budget;
  const penalty = CLAMP(over / Math.max(1.5, budget), 0, 0.9);
  const value = CLAMP(0.9 - penalty, 0, 0.85);
  reasons.push(`Over by $${over.toFixed(2)}/serv.`);
  return { value, reasons };
}
function computeDietMatch(recipe, context = {}) {
  const reasons = [];
  const profile = getDietProfile(context);
  const allow = (profile.allowTags || []).map(normName);
  const avoid = (profile.avoidTags || []).map(normName);
  const rTags = (recipe.tags || []).map(normName);
  const hasAvoid = avoid.some(tag => rTags.includes(tag));
  if (hasAvoid) reasons.push("Contains avoided tag(s).");
  const allowBonus = allow.length ? allow.filter(tag => rTags.includes(tag)).length : 0;
  if (allowBonus > 0) reasons.push(`Matches preferred tag(s): +${allowBonus}`);
  const avoidIngs = (profile.avoidIngredients || []).map(normName);
  const recipeIngNames = (recipe.ingredients || []).map(i => normName(i.name));
  const ingConflict = avoidIngs.some(a => recipeIngNames.includes(a));
  if (ingConflict) reasons.push("Contains avoided ingredient(s).");
  let macroScore = 0.5;
  if (profile.macros && recipe.nutrition) {
    const tgt = profile.macros, n = recipe.nutrition;
    let dims = 0, sum = 0;
    for (const k of ["kcal","protein","fat","carbs"]) {
      if (typeof n[k] === "number" && typeof (tgt[k]?.target ?? tgt[k]) === "number") {
        const target = Number(tgt[k]?.target ?? tgt[k]);
        const tol = Number(tgt[k]?.tolerance ?? (k==="protein"?12:18));
        const d = Math.abs(n[k] - target);
        const v = CLAMP(1 - d / (tol || 1), 0, 1);
        sum += v; dims += 1;
      }
    }
    if (dims > 0) { macroScore = CLAMP(sum / dims, 0, 1); reasons.push(`Macro alignment ~${Math.round(macroScore*100)}%.`); }
  }
  let v = macroScore;
  if (hasAvoid || ingConflict) v *= 0.4;
  v = CLAMP(v + Math.min(allowBonus * 0.05, 0.15), 0, 1);
  if (v >= 0.9) reasons.push("Excellent diet fit.");
  if (v <= 0.4 && (hasAvoid || ingConflict)) reasons.push("Fails diet rules; consider swaps.");
  return { value: v, reasons };
}

// ------------------------------ Garden scorers -------------------------------
/**
 * Signals:
 *  - seasonFit:  alignment of task targetDate to seasonality (heuristic + scheduleHelpers)
 *  - frostFit:   respects frost window per settings/filters
 *  - bedFit:     bed availability (no conflicts) within nearby window
 *  - effortFit:  maps task effort/duration to user time window (like meals)
 */
function gardenSeasonFit(task, context = {}) {
  const reasons = [];
  const settings = useSettingsStore ? useSettingsStore() : null;
  const lastFrost = settings?.garden?.frost?.last ? new Date(settings.garden.frost.last) : null;
  const firstFrost = settings?.garden?.frost?.first ? new Date(settings.garden.frost.first) : null;
  const d = task.targetDate ? new Date(task.targetDate) : getNow();
  if (!lastFrost && !firstFrost) {
    reasons.push("No frost dates; neutral season fit (0.6).");
    return { value: 0.6, reasons };
  }
  // simple heuristic: sow/transplant prefer after last frost; harvest any
  const kind = (task.kind || "").toLowerCase();
  let v = 0.7;
  if (lastFrost && (kind === "sow" || kind === "transplant" || kind === "thin" || kind === "trellis")) {
    const daysAfter = Math.floor((d - lastFrost) / 86400000);
    v = CLAMP((daysAfter + 7) / 60, 0, 1); // within ~2 months ramps to 1
    reasons.push(`Days after last frost: ${daysAfter}.`);
  }
  if (firstFrost && kind === "seed-saving") {
    const daysBefore = Math.floor((firstFrost - d) / 86400000);
    v = CLAMP((daysBefore + 7) / 45, 0, 1);
    reasons.push(`Days before first frost: ${daysBefore}.`);
  }
  return { value: v, reasons };
}

function gardenFrostFit(task, context = {}) {
  const reasons = [];
  const settings = useSettingsStore ? useSettingsStore() : null;
  const lastFrost = settings?.garden?.frost?.last ? new Date(settings.garden.frost.last) : null;
  if (!lastFrost) {
    reasons.push("No last frost; neutral (0.6).");
    return { value: 0.6, reasons };
  }
  const mode = context.frostMode || context.filters?.mode || "after-last";
  const a = Number(context.filters?.daysA ?? 0);
  const b = Number(context.filters?.daysB ?? 21);
  const d = task.targetDate ? new Date(task.targetDate) : getNow();
  const diff = Math.floor((d - lastFrost) / 86400000);
  let ok = true;
  if (mode === "after-last") ok = diff >= a;
  else if (mode === "before-last") ok = diff <= a;
  else if (mode === "between") ok = diff >= a && diff <= b;
  const value = ok ? 0.95 : 0.3;
  reasons.push(ok ? "Within frost window." : "Outside frost window.");
  return { value, reasons };
}

function gardenBedFit(task, context = {}) {
  const reasons = [];
  // If scheduleHelpers provides a quick check, use it
  try {
    const busy = scheduleHelpers?.isBedBusy?.({
      bedId: task.bedId || task.bedName || task.bed,
      at: task.targetDate,
      minutes: task.durationMin || 30,
    });
    if (typeof busy === "boolean") {
      if (!busy) { reasons.push("Bed free in requested window."); return { value: 0.95, reasons }; }
      reasons.push("Bed busy; trying next window.");
      const next = scheduleHelpers?.nextWindow?.({ scope: "garden", bedId: task.bedId || task.bedName, minutes: task.durationMin || 30, from: task.targetDate ? new Date(task.targetDate) : getNow() });
      if (next) reasons.push(`Next free: ${new Date(next).toLocaleString()}.`);
      return { value: 0.45, reasons };
    }
  } catch {}
  reasons.push("No bed availability data; neutral (0.6).");
  return { value: 0.6, reasons };
}

function gardenEffortFit(task, context = {}) {
  const total = Number(task.durationMin || task.minutes || 0);
  return computeTimeFit({ totalTimeMinutes: total }, { timeWindowMinutes: context.timeWindowMinutes || context.timeWindow });
}

// ------------------------------ Cleaning scorers -----------------------------
/**
 * From roomProcedureNormalizer/checklistNormalizer shapes.
 */
function cleaningSupplyOnHand(item, context = {}) {
  const reasons = [];
  const inv = context.inventory || InventoryMonitor?.getSnapshot?.() || {};
  const needs = new Set();
  // derive needs from chemicals/tools or tags
  (item.chemicals || []).forEach(c => needs.add(normName(c.name)));
  (item.tools || []).forEach(t => needs.add(normName(t)));
  (item.tags || []).forEach(t => { if (/quat|bleach|glass-cleaner/.test(t)) needs.add(normName(t)); });

  if (!needs.size) { reasons.push("No specific supplies listed; neutral (0.7)."); return { value: 0.7, reasons }; }

  let have = 0;
  needs.forEach(n => {
    if (inv[n] && Number(inv[n]?.quantity || inv[n]) > 0) have += 1;
  });
  const v = CLAMP(have / needs.size, 0, 1);
  if (v < 1) reasons.push(`Missing ${needs.size - have} supplies.`);
  else reasons.push("All supplies on-hand.");
  return { value: v, reasons };
}

function cleaningPPECompliance(item) {
  const reasons = [];
  const required = new Set(item.ppe || []);
  if (!required.size) { reasons.push("No PPE required; full compliance."); return { value: 1, reasons }; }
  // Assume availability is responsibility gate; if present, full
  reasons.push("PPE listed; verify before start.");
  return { value: 0.9, reasons };
}

function cleaningDwellCoverage(item) {
  const reasons = [];
  // If any step with dwellSec and product, good coverage
  const steps = item.steps || [];
  const hasDwell = steps.some(s => Number(s.dwellSec || s.timer?.durationSec));
  const value = hasDwell ? 0.95 : 0.55;
  reasons.push(hasDwell ? "Dwell timers present in steps." : "No dwell timing; add timers for disinfectants.");
  return { value, reasons };
}

function cleaningTimeFit(item, context = {}) {
  const minutes =
    Number(item.durationMin) ||
    (Array.isArray(item.steps) ? item.steps.reduce((a, s) => a + Number(s.durationMin || 0), 0) : 0) ||
    0;
  return computeTimeFit({ totalTimeMinutes: minutes }, { timeWindowMinutes: context.timeWindowMinutes || context.timeWindow });
}

// ---------------------------- Animal-care scorers ----------------------------
function animalEquipOnHand(proc, context = {}) {
  const reasons = [];
  const inv = context.inventory || InventoryMonitor?.getSnapshot?.() || {};
  const needs = new Set([...(proc.equipment || []), ...(proc.ppe || [])].map(normName));
  if (!needs.size) { reasons.push("No equipment listed; neutral (0.7)."); return { value: 0.7, reasons }; }
  let have = 0;
  needs.forEach(n => { if (inv[n] && Number(inv[n]?.quantity || inv[n]) > 0) have += 1; });
  const v = CLAMP(have / needs.size, 0, 1);
  reasons.push(v === 1 ? "All equipment/PPE on-hand." : `Missing ${needs.size - have} item(s).`);
  return { value: v, reasons };
}
function animalRoleCoverage(proc) {
  const reasons = [];
  const roles = new Set(proc.roles || []);
  const stepRoles = new Set((proc.steps || []).map(s => s.role).filter(Boolean));
  const missing = [...stepRoles].filter(r => !roles.has(r));
  if (missing.length) { reasons.push(`Role(s) not assigned: ${missing.join(", ")}.`); return { value: 0.55, reasons }; }
  reasons.push("Roles aligned with steps.");
  return { value: 0.95, reasons };
}
function animalSafetyCompliance(proc) {
  const reasons = [];
  const hazards = proc.hazards || [];
  const hasSharps = hazards.some(h => /sharps/.test(h.code || h.description || ""));
  const hasBio = hazards.some(h => /bio|zoon/.test(h.code || h.description || ""));
  let v = 0.8;
  if (hasSharps || hasBio) v = 0.9;
  if ((proc.preChecks || []).some(c => /PPE|sanitize|disinfect/i.test(c.text || c))) v = Math.min(1, v + 0.05);
  reasons.push("Safety controls present (PPE/controls).");
  return { value: v, reasons };
}
function animalTimeFit(proc, context = {}) {
  const minutes =
    Number(proc.durationMin) ||
    (Array.isArray(proc.steps) ? proc.steps.reduce((a, s) => a + Number(s.durationMin || 0), 0) : 0) ||
    0;
  return computeTimeFit({ totalTimeMinutes: minutes }, { timeWindowMinutes: context.timeWindowMinutes || context.timeWindow });
}

// ------------------------------ Aggregation ----------------------------------
function aggregateScore(parts, weights) {
  const keys = Object.keys(weights);
  const score = CLAMP(keys.reduce((acc, k) => acc + (parts[k]?.value || 0) * (weights[k] || 0), 0), 0, 1);
  const reasons = keys.flatMap(k => (parts[k]?.reasons || []).map(r => `${k}: ${r}`));
  const nextBestActions = [];

  // simple NBAs across domains
  for (const k of keys) {
    const v = parts[k]?.value ?? 1;
    if (v < 0.7) {
      if (k === "supplyOnHand" || k === "equipOnHand" || k === "onHandPct") nextBestActions.push("Open: Inventory to review missing items.");
      if (k === "timeFit" || k === "effortFit") nextBestActions.push("Try: Reschedule or split into smaller slots.");
      if (k === "frostFit") nextBestActions.push("Adjust: Move to frost-safe date.");
      if (k === "ppeCompliance") nextBestActions.push("Check: PPE list before starting.");
      if (k === "dwellCoverage") nextBestActions.push("Add: Dwell timers to steps.");
      if (k === "safetyCompliance") nextBestActions.push("Review: Hazards & controls.");
    }
  }

  return { score, reasons, nextBestActions };
}

// ------------------------------ Routing layer --------------------------------
function inferDomain(item) {
  if (item?.domain) return String(item.domain).toLowerCase();
  if (item?.ingredients || item?.servings || item?.nutrition) return "meals";
  if ((item?.kind && /sow|transplant|harvest|prune|weed|water|fertiliz|trellis|thin|seed/i.test(item.kind)) || item?.bedName || item?.cropName) return "garden";
  if (item?.chemicals || item?.roomType || item?.ppe && !item?.species) return "cleaning";
  if (item?.species || (item?.roles && item?.hazards)) return "animal-care";
  return "meals";
}

// ------------------------------ Public API -----------------------------------
/**
 * Score a single candidate (any domain).
 * @param {object} item - normalized object (recipe, garden task, cleaning SOP/task, animal-care SOP)
 * @param {object} context - domain-specific params (see below)
 *
 * Context examples:
 *  - meals: { inventory, timeWindowMinutes, budgetPerServing, dietProfile }
 *  - garden: { timeWindowMinutes, filters:{ mode, daysA, daysB } }
 *  - cleaning: { inventory, timeWindowMinutes }
 *  - animal-care: { inventory, timeWindowMinutes }
 */
function scoreItem(item, context = {}) {
  if (!item) {
    const weights = loadWeights("meals");
    return {
      id: null, domain: "unknown", score: 0,
      signals: {}, weights, reasons: ["No item provided."], nextBestActions: [],
    };
  }

  const domain = inferDomain(item);
  const weights = loadWeights(domain);
  let parts = {};
  let id = item.id || item.slug || item._id || item.title || item.name || null;

  if (domain === "meals") {
    const onHandPct = computeOnHandPct(item, context);
    const timeFit   = computeTimeFit(item, context);
    const budgetFit = computeBudgetFit(item, context);
    const dietMatch = computeDietMatch(item, context);
    parts = { onHandPct, timeFit, budgetFit, dietMatch };
  } else if (domain === "garden") {
    const seasonFit = gardenSeasonFit(item, context);
    const frostFit  = gardenFrostFit(item, context);
    const bedFit    = gardenBedFit(item, context);
    const effortFit = gardenEffortFit(item, context);
    parts = { seasonFit, frostFit, bedFit, effortFit };
    id = id || `${item.kind || "task"}:${item.cropName || "crop"}:${item.bedName || "bed"}`;
  } else if (domain === "cleaning") {
    const supplyOnHand  = cleaningSupplyOnHand(item, context);
    const timeFit       = cleaningTimeFit(item, context);
    const ppeCompliance = cleaningPPECompliance(item, context);
    const dwellCoverage = cleaningDwellCoverage(item, context);
    parts = { supplyOnHand, timeFit, ppeCompliance, dwellCoverage };
    id = id || item.title || "cleaning-procedure";
  } else if (domain === "animal-care") {
    const equipOnHand      = animalEquipOnHand(item, context);
    const roleCoverage     = animalRoleCoverage(item, context);
    const safetyCompliance = animalSafetyCompliance(item, context);
    const timeFit          = animalTimeFit(item, context);
    parts = { equipOnHand, roleCoverage, safetyCompliance, timeFit };
    id = id || item.title || "animal-procedure";
  }

  const agg = aggregateScore(parts, weights);
  const signals = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.value]));

  const result = {
    id, domain, score: agg.score, signals, weights,
    reasons: agg.reasons, nextBestActions: agg.nextBestActions,
  };

  try { eventBus.emit?.("decider:scored", { id, domain, score: result.score, signals: result.signals }); } catch {}

  // Small domain-specific hints
  try {
    if (domain === "garden" && signals.frostFit < 0.7) {
      eventBus.emit?.("nba:hint", { type: "GARDEN_FROST_ADJUST", taskId: id });
    }
    if (domain === "cleaning" && signals.dwellCoverage < 0.7) {
      eventBus.emit?.("nba:hint", { type: "CLEANING_ADD_DWELL_TIMERS", id });
    }
    if (domain === "animal-care" && signals.roleCoverage < 0.7) {
      eventBus.emit?.("nba:hint", { type: "ANIMAL_ASSIGN_ROLES", id });
    }
    if (domain === "meals") {
      if (result.score >= 0.82 && (signals.onHandPct ?? 1) < 0.7) {
        eventBus.emit?.("nba:hint", { type: "SHOPPING_MICRO", recipeId: id, reason: "High score but missing items." });
      }
    }
  } catch {}

  return result;
}

/**
 * Backward-compat wrapper for recipes (meals).
 */
function scoreRecipe(recipe, context = {}) {
  return scoreItem({ ...recipe, domain: "meals" }, context);
}

/**
 * Score a list of candidates (mixed domains OK) and return sorted results (desc).
 * @param {Array<object>} candidates
 * @param {object} context
 * @param {number} [limit] optional top-N
 */
function scoreCandidates(candidates = [], context = {}, limit = undefined) {
  const results = candidates.map((it) => scoreItem(it, context));
  results.sort((a, b) => b.score - a.score);
  return typeof limit === "number" ? results.slice(0, limit) : results;
}

/**
 * Update weights for a domain at runtime (persist via automation if available).
 */
function setWeights(next = {}, domain = "meals") {
  const base = DEFAULT_WEIGHTS[domain] || DEFAULT_WEIGHTS.meals;
  const merged = { ...base, ...next };
  const sum = Object.values(merged).reduce((a, b) => a + b, 0) || 1;
  Object.keys(merged).forEach((k) => (merged[k] = merged[k] / sum));
  try {
    automation?.set?.(`decider.weights.${domain}`, merged);
    eventBus.emit?.("decider:weightsUpdated", { domain, weights: merged });
  } catch {}
  return merged;
}

// ------------------------------ Module Exports -------------------------------
module.exports = {
  // multi-domain
  scoreItem,
  scoreCandidates,
  setWeights,
  // legacy meals API (kept for compatibility)
  scoreRecipe,
  // internals
  _internals: {
    // meals
    computeOnHandPct,
    computeTimeFit,
    computeBudgetFit,
    computeDietMatch,
    // garden
    gardenSeasonFit,
    gardenFrostFit,
    gardenBedFit,
    gardenEffortFit,
    // cleaning
    cleaningSupplyOnHand,
    cleaningPPECompliance,
    cleaningDwellCoverage,
    cleaningTimeFit,
    // animal-care
    animalEquipOnHand,
    animalRoleCoverage,
    animalSafetyCompliance,
    animalTimeFit,
    // system
    loadWeights,
    inferDomain,
  },
};
