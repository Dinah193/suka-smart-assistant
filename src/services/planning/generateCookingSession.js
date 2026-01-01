// C:\Users\larho\suka-smart-assistant\src\services\planning\generateCookingSession.js
// ----------------------------------------------------------------------------
// Suka Smart Assistant — Batch Cooking Session Generator (Dynamic)
// ----------------------------------------------------------------------------
// What it does (in one pass):
// - Loads recipes, applies per-recipe scaling, and normalizes steps
// - Auto-merges common PREP steps across recipes (e.g., "chop onions")
// - Builds a dependency graph and simple resource-aware schedule (oven/burners/etc.)
// - Emits multi-timer definitions, voice-alert moments, and a clean, editable step list
// - Produces prep checklists, grocery deltas, inventory sync payloads, and label stubs
// - Surfaces nutrition/macros rollups (if NutritionService is available)
// - Resilient to missing optional services; degrades gracefully
//
// Return shape is designed for your BatchSessionPlanner, MultiTimerPanel,
// Prep Checklist Generator, Label Printer, and InventorySyncModal.
//
// Notes:
// - Keep everything JS (no TS).
// - Avoids heavy libs; simple heuristics for resource scheduling.
// - If a service is not present in your project yet, this file won’t crash;
//   it’ll skip those enrichments and annotate `meta.warnings`.
//
// ----------------------------------------------------------------------------

import { v4 as uuidv4 } from "uuid";
import RecipeManager from "../../managers/RecipeManager";

// Optional (best-effort) services. If absent, we soft-fallback.
let InventoryService, UnitConverter, NutritionService, PreferencesService;
try { InventoryService = require("../../features/inventory/services/InventoryService").default; } catch {}
try { UnitConverter = require("../../lib/unitConverter").default; } catch {}
try { NutritionService = require("../../features/nutrition/services/nutritionLookupService").default; } catch {}
try { PreferencesService = require("../../services/preferences/PreferencesService").default; } catch {}

/**
 * Heuristic action tags that qualify as "prep" and can be merged.
 */
const PREP_ACTIONS = new Set([
  "wash","rinse","peel","chop","dice","slice","mince","julienne",
  "grate","shred","measure","mix dry","mix wet","brine","marinate"
]);

/**
 * Simple resource model defaults (can be overridden by options)
 */
const defaultResources = () => ({
  oven: 1,           // number of ovens available
  burners: 4,        // stove top capacity
  mixers: 1,
  airfryers: 0,
  sousvide: 0,
  idleSlackPct: 0.1, // buffer added to times to reduce over-scheduling
});

/**
 * Normalize a single recipe step to our internal "work item" model.
 */
function normalizeStep(recipe, step, idx) {
  const id = `work-${uuidv4()}`;
  const est = Number(step.estimatedTime || step.minutes || 0) || 0;

  // Infer simple tags/actions if not provided
  const action = (step.action || step.type || guessAction(step.description)).toLowerCase();
  const phase = (step.phase || guessPhase(action));

  // Equipment/resource hints
  const equipment = step.equipment || step.tools || recipe.tools || [];
  const usesOven = includesAny(equipment, ["oven","roaster"]);
  const usesBurner = includesAny(equipment, ["pan","pot","skillet","saucepan","wok","stockpot","griddle"]);
  const usesMixer = includesAny(equipment, ["mixer","stand mixer","hand mixer"]);

  const resources = {};
  if (usesOven) resources.oven = 1;
  if (usesBurner) resources.burners = 1;
  if (usesMixer) resources.mixers = 1;

  const wait = Number(step.wait || step.rest || step.cool || 0) || 0;
  const parallelizable = step.parallelizable ?? (phase !== "COOK"); // assume prep can overlap by default

  return {
    id,
    recipeId: recipe.id,
    recipeName: recipe.name,
    ix: idx,
    phase,                // PREP | COOK | FINISH | COOL | PRESERVE
    action,
    description: step.description || step.text || "",
    ingredients: step.ingredients || [], // [{name, qty, unit}]
    estimatedMinutes: est,
    waitMinutes: wait,
    temperature: step.temperature || step.temp || null,
    resources,           // requested resources
    canParallelize: !!parallelizable,
    dependsOn: (step.dependsOn || []).slice(), // array of work ids (filled later if provided)
    allergens: (recipe.allergens || []).slice(),
    dietTags: (recipe.dietTags || []).slice(),
  };
}

function guessAction(desc="") {
  const d = desc.toLowerCase();
  if (d.includes("preheat")) return "preheat";
  if (d.includes("boil") || d.includes("simmer")) return "boil";
  if (d.includes("bake") || d.includes("roast")) return "bake";
  if (d.includes("sear") || d.includes("saute") || d.includes("sauté")) return "sear";
  if (d.includes("mix") || d.includes("combine")) return "mix";
  if (d.includes("chop") || d.includes("dice") || d.includes("slice") || d.includes("mince")) return "chop";
  if (d.includes("marinat")) return "marinate";
  if (d.includes("cool") || d.includes("rest")) return "rest";
  if (d.includes("label") || d.includes("jar") || d.includes("pack")) return "pack";
  return "step";
}

function guessPhase(action) {
  if (["preheat","wash","rinse","peel","chop","dice","slice","mince","mix","marinate","brine"].some(a => action.includes(a))) return "PREP";
  if (["bake","roast","sear","saute","sauté","boil","simmer","pressure cook","airfry"].some(a => action.includes(a))) return "COOK";
  if (["rest","cool"].some(a => action.includes(a))) return "COOL";
  if (["pack","label","jar","vac seal","freeze","can","dehydrate","cure"].some(a => action.includes(a))) return "PRESERVE";
  return "FINISH";
}

function includesAny(list, keys) {
  const L = (list || []).map(s => String(s).toLowerCase());
  return keys.some(k => L.includes(k));
}

/**
 * Merge similar PREP steps across multiple recipes (e.g., "chop onions")
 * Heuristic bucket key: action + normalized ingredient name(s).
 */
function mergePrepSteps(workItems) {
  const buckets = new Map();

  for (const w of workItems) {
    if (w.phase !== "PREP") continue;
    const ingredientKey = (w.ingredients || [])
      .map(i => (i.name || "").trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join("|");

    const key = `${w.action}::${ingredientKey || "misc"}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        id: `prep-${uuidv4()}`,
        phase: "PREP",
        action: w.action,
        description: humanizeMergedDescription(w.action, ingredientKey),
        items: [],
        ingredients: [],
        estimatedMinutes: 0,
        canParallelize: true,
        resources: {},
        dependsOn: [],
        recipes: new Set(),
        allergens: new Set(),
        dietTags: new Set(),
      });
    }
    const b = buckets.get(key);
    b.items.push(w);
    (w.ingredients || []).forEach(ing => b.ingredients.push(ing));
    b.estimatedMinutes += Math.max(1, Math.round((w.estimatedMinutes || 1) * 0.7)); // slight efficiency gain
    b.recipes.add(w.recipeName);
    (w.allergens || []).forEach(a => b.allergens.add(a));
    (w.dietTags || []).forEach(t => b.dietTags.add(t));
  }

  // Build merged objects
  const merged = [];
  buckets.forEach(b => {
    merged.push({
      id: b.id,
      recipeId: "merged",
      recipeName: `Merged Prep (${Array.from(b.recipes).length} recipes)`,
      ix: -1,
      phase: b.phase,
      action: b.action,
      description: b.description,
      ingredients: aggregateIngredients(b.ingredients),
      estimatedMinutes: b.estimatedMinutes,
      waitMinutes: 0,
      temperature: null,
      resources: b.resources,
      canParallelize: b.canParallelize,
      dependsOn: b.dependsOn,
      mergedOf: b.items.map(i => i.id),
      allergens: Array.from(b.allergens),
      dietTags: Array.from(b.dietTags),
    });
  });

  // Remove originals that got merged
  const mergedIds = new Set(merged.flatMap(m => m.mergedOf || []));
  const survivors = workItems.filter(w => w.phase !== "PREP" || !mergedIds.has(w.id));
  return [...merged, ...survivors];
}

function humanizeMergedDescription(action, ingredientKey) {
  const pretty = ingredientKey
    ? ingredientKey.split("|").map(s => capitalize(s)).join(", ")
    : "assorted items";
  return `${capitalize(action)}: ${pretty}`;
}

function capitalize(s="") { return s.charAt(0).toUpperCase() + s.slice(1); }

/**
 * Aggregate ingredients: sum like items & convert units if possible.
 */
function aggregateIngredients(ings) {
  const map = new Map(); // key: lower(name) -> {name, qty, unit}
  for (const ing of (ings || [])) {
    const name = (ing.name || "").trim().toLowerCase();
    if (!name) continue;
    const key = name + "::" + (ing.unit || "");
    const prev = map.get(key) || { name: ing.name, qty: 0, unit: ing.unit || "" };
    const qty = Number(ing.qty || ing.quantity || 0) || 0;

    // Optional unit converter
    if (UnitConverter && prev.unit && ing.unit && ing.unit !== prev.unit) {
      try {
        const converted = UnitConverter.convert(qty, ing.unit, prev.unit);
        prev.qty += converted;
      } catch {
        // fallback: keep separate key to avoid bad math
        map.set(`${name}::${ing.unit}`, { name: ing.name, qty, unit: ing.unit || "" });
        continue;
      }
    } else {
      prev.qty += qty;
    }
    map.set(key, prev);
  }
  return Array.from(map.values());
}

/**
 * Very simple resource-aware scheduler.
 * Produces absolute minute offsets from a start time.
 */
function scheduleWork(items, resources, pacing = "normal") {
  // sort by phase priority -> PREP, COOK, FINISH, COOL, PRESERVE
  const phaseOrder = { PREP:0, COOK:1, FINISH:2, COOL:3, PRESERVE:4 };
  const sorted = items.slice().sort((a,b) => {
    const pa = phaseOrder[a.phase] ?? 9;
    const pb = phaseOrder[b.phase] ?? 9;
    if (pa !== pb) return pa - pb;
    // keep merged prep earlier
    if (a.recipeId === "merged" && b.recipeId !== "merged") return -1;
    if (b.recipeId === "merged" && a.recipeId !== "merged") return 1;
    return (a.ix ?? 0) - (b.ix ?? 0);
  });

  const capacity = { ...defaultResources(), ...resources };
  const timeCursor = 0;
  const now = 0;
  const usage = { oven:0, burners:0, mixers:0, airfryers:0, sousvide:0 };
  const schedule = [];
  const idToFinish = new Map();
  const finished = new Set();

  // Build quick dependency map (string ids only)
  const depsMap = new Map(items.map(i => [i.id, (i.dependsOn || []).slice()]));

  const paceMultiplier = pacing === "aggressive" ? 0.9 : pacing === "leisurely" ? 1.2 : 1.0;
  const slack = Math.max(0, Math.round((capacity.idleSlackPct || 0) * 10)) / 10;

  // naive loop: iterate until all scheduled
  const queue = sorted.slice();
  let minute = now;
  let safety = 0;

  while (queue.length && safety < 100000) {
    safety++;

    // Free up resources for finished tasks
    for (const sc of schedule) {
      if (!sc.activeFreed && sc.endMinute <= minute) {
        // release
        Object.keys(sc.resourcesUsed || {}).forEach(k => { usage[k] -= sc.resourcesUsed[k]; });
        sc.activeFreed = true;
        finished.add(sc.id);
        idToFinish.set(sc.id, sc.endMinute);
      }
    }

    let progressed = false;

    for (let i = 0; i < queue.length; i++) {
      const w = queue[i];
      const deps = depsMap.get(w.id) || [];
      const depsDone = deps.every(d => finished.has(d));

      if (!depsDone) continue;

      // resource check
      const needs = w.resources || {};
      const canRun = Object.keys(needs).every(k => (usage[k] || 0) + (needs[k] || 0) <= (capacity[k] || 0));

      if (!canRun && !w.canParallelize) continue;
      if (!canRun && w.canParallelize) {
        // if parallelizable and no hard resource, allow queueing anyway (prep table work)
      }

      const dur = Math.max(1, Math.round((w.estimatedMinutes || 1) * paceMultiplier * (1 + slack)));
      const wait = Math.max(0, Math.round((w.waitMinutes || 0)));

      // allocate
      const used = {};
      Object.keys(needs).forEach(k => {
        used[k] = needs[k];
        usage[k] = (usage[k] || 0) + (needs[k] || 0);
      });

      const startMinute = minute;
      const endMinute = startMinute + dur;
      const coolEndMinute = endMinute + wait;

      schedule.push({
        ...w,
        startMinute,
        endMinute,
        coolEndMinute,
        resourcesUsed: used,
      });

      queue.splice(i,1);
      progressed = true;
      // If task is non-parallel (rare with PREP), break to advance time
      if (!w.canParallelize) break;
      i--;
    }

    if (!progressed) {
      // no tasks could start at this minute; advance
      minute++;
    }
  }

  // timers: one per scheduled item + special timers for rests/cools
  const timers = [];
  for (const sc of schedule) {
    if (sc.estimatedMinutes > 0) {
      timers.push({
        id: `timer-${uuidv4()}`,
        label: `${capitalize(sc.action)} — ${sc.recipeName === "Merged Prep" ? "Merged Prep" : sc.recipeName}`,
        forWorkId: sc.id,
        durationMinutes: sc.estimatedMinutes,
        startsAtMinute: sc.startMinute,
        voiceCue: `Start ${sc.action} for ${sc.recipeName}`,
      });
    }
    if (sc.waitMinutes > 0) {
      timers.push({
        id: `timer-${uuidv4()}`,
        label: `Rest/Cool — ${sc.recipeName}`,
        forWorkId: sc.id,
        durationMinutes: sc.waitMinutes,
        startsAtMinute: sc.endMinute,
        voiceCue: `Begin resting/cooling for ${sc.recipeName}`,
      });
    }
  }

  return { schedule, timers };
}

/**
 * Compute grocery deltas vs. inventory snapshot (if available).
 */
async function computeInventoryDelta(allIngredients = []) {
  if (!InventoryService) {
    return { missing: aggregateIngredients(allIngredients), toReserve: [], notes: ["InventoryService unavailable"] };
  }
  try {
    const flat = aggregateIngredients(allIngredients);
    const missing = [];
    const toReserve = [];
    for (const ing of flat) {
      const have = await InventoryService.lookup(ing.name);
      const haveQty = have?.qty ?? 0;
      if (haveQty < (ing.qty || 0)) {
        missing.push({ ...ing, needed: (ing.qty || 0) - haveQty });
      } else {
        toReserve.push({ name: ing.name, qty: ing.qty, unit: ing.unit });
      }
    }
    return { missing, toReserve, notes: [] };
  } catch (e) {
    return { missing: aggregateIngredients(allIngredients), toReserve: [], notes: [`InventoryService error: ${String(e.message || e)}`] };
  }
}

/**
 * Nutrition/macros rollup (best-effort).
 */
async function computeNutrition(loadedRecipes = []) {
  if (!NutritionService) return { totals: null, perRecipe: [], notes: ["NutritionService unavailable"] };
  try {
    const perRecipe = [];
    let totals = { calories:0, protein:0, fat:0, carbs:0, fiber:0, sugar:0 };
    for (const r of loadedRecipes) {
      const n = await NutritionService.estimateRecipe(r); // expect {calories, protein, fat, carbs, ...}
      perRecipe.push({ recipeId: r.id, recipeName: r.name, ...n });
      Object.keys(totals).forEach(k => { totals[k] += Number(n?.[k] || 0); });
    }
    return { totals, perRecipe, notes: [] };
  } catch (e) {
    return { totals: null, perRecipe: [], notes: [`NutritionService error: ${String(e.message || e)}`] };
  }
}

/**
 * Label stubs for Label Printer (jars, trays, vacuum bags, etc.)
 */
function buildLabelStubs(loadedRecipes = [], options = {}) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0,10);
  return loadedRecipes.map(r => ({
    id: `label-${uuidv4()}`,
    recipeId: r.id,
    name: r.name,
    producedOn: dateStr,
    shelfLife: r.shelfLife || options.defaultShelfLife || null,
    notes: r.labelNotes || "",
    servings: r.scaledServings || r.servings || null,
    allergens: r.allergens || [],
    dietTags: r.dietTags || [],
  }));
}

/**
 * Build a clean, user-facing step list (flattened) for the planner UI.
 */
function buildVisibleSteps(schedule = []) {
  // convert minutes to “+HH:MM” offsets for friendly UI
  const toHHMM = (mins) => {
    const sign = mins < 0 ? "-" : "+";
    const m = Math.abs(mins);
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, "0");
    return `${sign}${h}:${mm}`;
  };

  return schedule.map((s, index) => ({
    id: s.id,
    order: index + 1,
    phase: s.phase,
    action: s.action,
    recipeName: s.recipeName,
    description: s.description,
    startOffset: toHHMM(s.startMinute),
    durationMin: s.estimatedMinutes,
    waitMin: s.waitMinutes || 0,
    temperature: s.temperature,
    ingredients: s.ingredients || [],
    resources: s.resourcesUsed || s.resources || {},
    mergedOf: s.mergedOf || null,
    allergens: s.allergens || [],
    dietTags: s.dietTags || [],
  }));
}

/**
 * Public API
 *
 * @param {string[]} recipeIds - selected recipe ids
 * @param {object} options
 *    - startTime: Date (anchor for UI; offsets still in minutes)
 *    - scale: { [recipeId]: number }  // multiplier relative to recipe.servings
 *    - resources: { oven, burners, mixers, airfryers, sousvide, idleSlackPct }
 *    - pacing: "aggressive" | "normal" | "leisurely"
 *    - voiceAlerts: boolean
 *    - generateLabels: boolean
 *    - respectPrefs: boolean (Sabbath windows, feast-day restrictions, etc.)
 */
const generateCookingSession = async (recipeIds = [], options = {}) => {
  if (!Array.isArray(recipeIds) || !recipeIds.length) throw new Error("No recipes selected.");

  const warnings = [];
  const opts = {
    startTime: options.startTime || new Date(),
    scale: options.scale || {},
    resources: options.resources || {},
    pacing: options.pacing || "normal",
    voiceAlerts: options.voiceAlerts ?? true,
    generateLabels: options.generateLabels ?? true,
    respectPrefs: options.respectPrefs ?? true,
  };

  // 1) Load recipes
  const loadedRecipes = await Promise.all(
    recipeIds.map(async (id) => {
      const r = await RecipeManager.getById(id);
      if (!r) throw new Error(`Recipe not found: ${id}`);
      return r;
    })
  );

  // 2) Apply scaling (per recipe)
  for (const r of loadedRecipes) {
    const mul = Number(opts.scale[r.id] || 1);
    if (mul !== 1 && r.ingredients?.length) {
      for (const ing of r.ingredients) {
        const q = Number(ing.qty || ing.quantity || 0) || 0;
        if (q) ing.qty = +(q * mul).toFixed(3);
      }
    }
    if (mul !== 1) {
      r.scaledServings = Math.round((r.servings || 1) * mul);
    }
  }

  // 3) Normalize steps for each recipe
  let workItems = [];
  for (const r of loadedRecipes) {
    const baseSteps = (Array.isArray(r.steps) && r.steps.length)
      ? r.steps
      : (typeof r.parseInstructions === "function" ? r.parseInstructions() : []);

    if (!Array.isArray(baseSteps) || !baseSteps.length) {
      warnings.push(`Recipe "${r.name}" has no steps; skipping.`);
      continue;
    }

    const normalized = baseSteps.map((s, idx) => normalizeStep(r, s, idx));
    workItems.push(...normalized);
  }

  if (!workItems.length) throw new Error("No usable steps from selected recipes.");

  // 4) Merge PREP steps across recipes (heuristic)
  workItems = mergePrepSteps(workItems);

  // 5) Respect preferences (Sabbath/Feast) as annotations (non-blocking placeholder)
  if (opts.respectPrefs && PreferencesService) {
    try {
      // Example: mark steps that should not be scheduled within quiet windows
      const quiet = await PreferencesService.getQuietWindows(); // [{start, end, reason}]
      if (quiet?.length) {
        workItems = workItems.map(w => ({ ...w, quietWindows: quiet }));
      }
    } catch {
      warnings.push("PreferencesService unavailable or failed; skipping quiet windows.");
    }
  }

  // 6) Build schedule & timers
  const { schedule, timers } = scheduleWork(workItems, opts.resources, opts.pacing);

  // 7) Compose prep checklist and grocery deltas
  const allIngredients = [];
  for (const w of workItems) (w.ingredients || []).forEach(i => allIngredients.push(i));
  const prepChecklist = aggregateIngredients(allIngredients);
  const inventoryDelta = await computeInventoryDelta(allIngredients);

  // 8) Nutrition/macros (best-effort)
  const nutrition = await computeNutrition(loadedRecipes);

  // 9) Label stubs (for Label Printer)
  const labels = opts.generateLabels ? buildLabelStubs(loadedRecipes, { defaultShelfLife: "3-5 days refrigerated" }) : [];

  // 10) Build visible steps for UI
  const visibleSteps = buildVisibleSteps(schedule);

  // 11) Session metadata
  const sessionId = `cooking-session-${Date.now()}-${uuidv4()}`;

  return {
    sessionId,
    createdAt: new Date().toISOString(),
    startTime: opts.startTime,
    recipeIds,
    recipeSummaries: loadedRecipes.map(r => ({
      id: r.id,
      name: r.name,
      servings: r.scaledServings || r.servings || null,
      allergens: r.allergens || [],
      dietTags: r.dietTags || [],
    })),

    // For MultiTimerPanel & voice alerts
    timers,                     // [{id,label,forWorkId,durationMinutes,startsAtMinute,voiceCue}]

    // For Session Planner visible draft
    steps: visibleSteps,        // flattened, ordered, human-friendly

    // For Prep Checklist Generator & Grocery List Generator
    prepChecklist,              // aggregated ingredients (quantified)
    inventoryDelta,             // { missing:[{name,needed,unit}], toReserve:[], notes:[] }

    // For InventorySyncModal
    inventorySyncPayload: {
      reserve: inventoryDelta.toReserve || [],
      deductOnComplete: loadedRecipes.map(r => ({
        recipeId: r.id,
        name: r.name,
        ingredients: r.ingredients || [],
      })),
    },

    // For Label Printer
    labels,                     // label stubs per recipe

    // For Nutrition cards
    nutrition,                  // { totals, perRecipe, notes }

    // For advanced UIs (Gantt, station maps, etc.)
    raw: {
      schedule,                 // detailed schedule with start/end/cool minutes
      workItems,                // normalized & merged items
    },

    // UX hints
    uiHints: {
      showVoiceToggle: true,
      suggestBatchStations: true,    // (prep table, stove, oven, packing)
      colorByPhase: true,
      callouts: [
        "Merged PREP steps added to reduce duplicate chopping/mixing.",
        "Timers include rest/cool periods to avoid missed downtimes.",
      ],
    },

    meta: {
      resources: { ...defaultResources(), ...(options.resources || {}) },
      pacing: opts.pacing,
      warnings,
      version: "2025-09-07.a",
    },
  };
};

export default generateCookingSession;
