// C:\Users\larho\suka-smart-assistant\src\engines\nutritionScorer.js

/**
 * nutritionScorer
 * ---------------
 * Purpose:
 *  - Turn meals/sessions into quantified nutrition intelligence (macros + micronutrients).
 *  - Detect likely deficiencies or excesses vs. household targets (RDA/AI, user goals).
 *  - Suggest adjustments: simple swaps, add-on sides, or supplements (extension points).
 *  - Emit normalized events for automation & UI; optionally export summaries to the Hub.
 *
 * How it fits the pipeline (imports → intelligence → automation → (optional) hub export):
 *   - imports: meals/sessions arrive via importers or other engines (mealToCooking, etc.).
 *   - intelligence: this engine computes nutrition totals & scores against targets.
 *   - automation: emits nutrition.scored, nutrition.deficiency.detected, and
 *                 can emit automation.schedule.request for quick fixes (optional).
 *   - hub export: sends anonymized summaries if featureFlags.familyFundMode is enabled.
 *
 * Notes:
 *  - The engine is defensive: all external deps are soft-imported and optional.
 *  - No persistent writes here by default (analysis-only). If you enable autoFix,
 *    it can emit session suggestions (e.g., "Add Side Salad")—those change household
 *    data downstream (session store), so exportToHubIfEnabled is called accordingly.
 */

//// Soft/defensive dynamic import /////////////////////////////////////////////

async function softImport(path) {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

//// Dependencies //////////////////////////////////////////////////////////////

let eventBus; // required
let featureFlags = { familyFundMode: false, nutrition: { autoFix: false } };

let NutritionDB; // optional; expects lookups for ingredient/recipe nutrition
// Expected minimal API if present:
//   - getByIngredientName(name) -> { macros:{calories,protein,carbs,fat}, micros:{...}, per:"100g"| "unit", unitGrams?: number }
//   - getByRecipeId(id)         -> { macros:{...}, micros:{...}, servings?: number }

let RecipeStore; // optional (for ingredient list if not on meal/session)
let HouseholdPrefs; // optional (targets, allergies, diet, household members)
let UnitConverter; // optional (normalize units → grams, ml, etc.)
let SubstitutionLibrary; // optional (nutrient-driven swaps & side ideas)
let InventoryService; // optional (to check availability for fix suggestions)

let HubPacketFormatter; // optional
let FamilyFundConnector; // optional

//// Utilities /////////////////////////////////////////////////////////////////

const nowISO = () => new Date().toISOString();

function safeId(prefix = "nutr") {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function emit(type, source, data) {
  if (!eventBus?.emit) return;
  eventBus.emit({ type, ts: nowISO(), source, data });
}

function sanitize(x) {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return undefined;
  }
}
function safeError(err) {
  return { name: err?.name || "Error", message: err?.message || String(err) };
}
function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}
function round1(x) {
  return Math.round((Number(x) || 0) * 10) / 10;
}
function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const pkt = HubPacketFormatter?.format?.(payload, {
      stream: "nutritionScorer",
    });
    if (!pkt) return;
    await FamilyFundConnector?.send?.(pkt);
  } catch {
    // silent by design
  }
}

//// Engine state //////////////////////////////////////////////////////////////

const state = {
  initialized: false,
  processing: false,
  queue: [],
  config: {
    // scoring weights
    weights: {
      macroBalance: 0.35, // closeness to macro targets (P/C/F split)
      microCoverage: 0.45, // % of key vitamins/minerals covered
      excessPenalty: 0.2, // sodium/added-sugar/sat-fat penalties
    },
    // Which micros to emphasize (extend freely)
    coreMicros: [
      "fiber",
      "vitaminA",
      "vitaminC",
      "vitaminD",
      "vitaminE",
      "vitaminK",
      "thiamin",
      "riboflavin",
      "niacin",
      "vitaminB6",
      "folate",
      "vitaminB12",
      "choline",
      "calcium",
      "iron",
      "magnesium",
      "phosphorus",
      "potassium",
      "zinc",
    ],
    // thresholds
    deficiencyThresholdPct: 0.35, // <35% of target counts as a deficiency (per meal or per-day bucket)
    excess: {
      sodiumMg: 900, // per meal: >900mg flagged (tunable)
      addedSugarG: 20, // per meal: >20g flagged
      satFatG: 10, // per meal: >10g flagged
    },
    assumeServings: 1, // fallback servings if unknown
    normalizePer: "serving", // compute totals per serving unless otherwise specified
    suggestFixes: true, // propose swaps/sides/supplements as suggestions
    autoFixSchedule: false, // if true, emit automation.schedule.request for fixes
    lookaheadMinutes: 120, // scheduling window for auto-fix suggestions
  },
};

//// Targets & RDAs ////////////////////////////////////////////////////////////

/**
 * Resolve macro & micro targets from HouseholdPrefs; fallback to generic adult values.
 * Returns { macros:{calories,protein,carbs,fat}, micros:{nutrient -> dailyTarget}, per:"day" }
 */
function getTargets() {
  const prefs =
    (HouseholdPrefs?.get?.() || HouseholdPrefs?.getCached?.()) ?? {};
  const t = prefs?.nutritionTargets || {};

  // Very light defaults (illustrative; real app should use age/sex/activity-aware targets)
  const defaults = {
    macros: { calories: 2000, protein: 75, carbs: 250, fat: 70 },
    micros: {
      fiber: 28,
      vitaminA: 900,
      vitaminC: 90,
      vitaminD: 15,
      vitaminE: 15,
      vitaminK: 120,
      thiamin: 1.2,
      riboflavin: 1.3,
      niacin: 16,
      vitaminB6: 1.7,
      folate: 400,
      vitaminB12: 2.4,
      choline: 550,
      calcium: 1300,
      iron: 18,
      magnesium: 400,
      phosphorus: 700,
      potassium: 3400,
      zinc: 11,
    },
    per: "day",
  };

  return {
    macros: { ...defaults.macros, ...(t.macros || {}) },
    micros: { ...defaults.micros, ...(t.micros || {}) },
    per: "day",
  };
}

//// Normalization helpers /////////////////////////////////////////////////////

function gramsOf(item) {
  // If UnitConverter present, use it. Otherwise, best-effort heuristics.
  if (UnitConverter?.toGrams) {
    try {
      return UnitConverter.toGrams(item.qty, item.unit, item.name);
    } catch {
      /* noop */
    }
  }
  // Heuristic fallback: treat "g" as grams; "kg"→*1000; "lb"→*453.6; "oz"→28.35; "cup"→ ~240g; "tbsp"→ 14g
  const qty = Number(item.qty || 0);
  const unit = (item.unit || "").toLowerCase();
  if (!qty) return 0;
  const map = {
    g: 1,
    gram: 1,
    grams: 1,
    kg: 1000,
    oz: 28.35,
    lb: 453.6,
    cup: 240,
    tbsp: 14,
    tsp: 5,
    ml: 1,
  };
  return (map[unit] || 1) * qty;
}

function normalizePerServing(total, servings) {
  const s = Number(servings || state.config.assumeServings);
  if (!s || s <= 0) return total;
  const out = { macros: {}, micros: {} };
  for (const k of Object.keys(total.macros))
    out.macros[k] = (total.macros[k] || 0) / s;
  for (const k of Object.keys(total.micros))
    out.micros[k] = (total.micros[k] || 0) / s;
  return out;
}

//// Nutrition math ////////////////////////////////////////////////////////////

/**
 * Compute nutrition totals for a meal/session:
 * - Prefer recipe-level nutrition if available.
 * - Otherwise sum ingredient nutrition from NutritionDB (per 100g or per unit).
 */
async function computeNutritionForMealOrSession(item) {
  // Accept shapes:
  //  meal:   { id, recipeId?, title, ingredients?[], servings?, ... }
  //  session:{ id, domain:"cooking", meta.recipeId?, session.tasks?, meta.ingredients? }
  const recipeId = item?.recipeId || item?.meta?.recipeId || null;

  // 1) Try recipe-level nutrition
  if (recipeId && NutritionDB?.getByRecipeId) {
    try {
      const n = await NutritionDB.getByRecipeId(recipeId);
      if (n?.macros && n?.micros) {
        const servings =
          n?.servings || item?.servings || state.config.assumeServings;
        const totals =
          state.config.normalizePer === "serving"
            ? normalizePerServing(n, servings)
            : n;
        return { totals, servings, source: "recipe" };
      }
    } catch {
      /* noop */
    }
  }

  // 2) Sum ingredients (from item or fetched via RecipeStore)
  const ingredients =
    item?.ingredients ||
    item?.projectedIngredients ||
    (await tryGetRecipeIngredients(recipeId)) ||
    [];

  const totals = {
    macros: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    micros: {},
  };
  for (const ing of ingredients) {
    const name = (ing?.name || "").toLowerCase().trim();
    if (!name) continue;

    const grams = gramsOf(ing);
    const dbRow = await lookupIngredientNutrition(name);
    if (!dbRow) continue;

    // Normalize factor: per 100g or per unit
    let factor = 1;
    if (dbRow.per === "100g") {
      factor = grams > 0 ? grams / 100 : 0;
    } else if (dbRow.per === "unit") {
      // If unitGrams exists, estimate units consumed → factor
      const unitG = Number(dbRow.unitGrams || 0);
      factor = unitG > 0 ? grams / unitG : Number(ing.qty || 1);
    }

    // Sum macros
    for (const mk of ["calories", "protein", "carbs", "fat"]) {
      totals.macros[mk] =
        (totals.macros[mk] || 0) + Number(dbRow.macros?.[mk] || 0) * factor;
    }
    // Sum micros
    for (const key of Object.keys(dbRow.micros || {})) {
      totals.micros[key] =
        (totals.micros[key] || 0) + Number(dbRow.micros[key] || 0) * factor;
    }
  }

  const servings = item?.servings || state.config.assumeServings;
  const normalized =
    state.config.normalizePer === "serving"
      ? normalizePerServing(totals, servings)
      : totals;

  return { totals: normalized, servings, source: "ingredients" };
}

async function lookupIngredientNutrition(name) {
  if (!NutritionDB?.getByIngredientName) return null;
  try {
    return await NutritionDB.getByIngredientName(name);
  } catch {
    return null;
  }
}

async function tryGetRecipeIngredients(recipeId) {
  if (!recipeId || !RecipeStore?.getById) return null;
  try {
    const r = await RecipeStore.getById(recipeId);
    return r?.ingredients || null;
  } catch {
    return null;
  }
}

//// Scoring & detection ///////////////////////////////////////////////////////

function scoreNutrition(totals, targets) {
  const W = state.config.weights;

  // Macro balance: compare P/C/F vs targets (percent distance)
  const t = targets.macros;
  const m = totals.macros;
  const macroScore =
    1 -
    avg([
      relDiff(m.protein, t.protein),
      relDiff(m.carbs, t.carbs),
      relDiff(m.fat, t.fat),
    ]); // 1 = perfect match, 0 = far off

  // Micro coverage: average clamp of nutrient / daily target for coreMicros
  const microRatios = state.config.coreMicros.map((k) => {
    const got = Number(totals.micros?.[k] || 0);
    const need = Number(targets.micros?.[k] || 0);
    if (!need) return 1; // if no target, treat as covered
    return clamp01(got / need);
  });
  const microCoverage = avg(microRatios);

  // Excess penalty: sodium / added sugar / sat fat
  const sodium = Number(totals?.micros?.sodium || 0); // mg
  const addedSugar = Number(totals?.micros?.addedSugar || 0); // g
  const satFat = Number(totals?.micros?.satFat || 0); // g

  const sodiumPenalty =
    sodium > state.config.excess.sodiumMg
      ? penaltyCurve(sodium, state.config.excess.sodiumMg)
      : 0;
  const sugarPenalty =
    addedSugar > state.config.excess.addedSugarG
      ? penaltyCurve(addedSugar, state.config.excess.addedSugarG)
      : 0;
  const satFatPenalty =
    satFat > state.config.excess.satFatG
      ? penaltyCurve(satFat, state.config.excess.satFatG)
      : 0;

  const excessPenalty = clamp01(
    (sodiumPenalty + sugarPenalty + satFatPenalty) / 3
  );

  // Weighted final score
  const score =
    W.macroBalance * clamp01(macroScore) +
    W.microCoverage * clamp01(microCoverage) +
    W.excessPenalty * clamp01(1 - excessPenalty);

  return {
    score: round2(score),
    details: {
      macroScore: round2(macroScore),
      microCoverage: round2(microCoverage),
      excessPenalty: round2(excessPenalty),
      sodium,
      addedSugar,
      satFat,
    },
  };
}

function relDiff(value, target) {
  const v = Number(value || 0),
    t = Number(target || 0);
  if (t <= 0) return 0;
  return Math.min(1, Math.abs(v - t) / t);
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + (Number(b) || 0), 0) / arr.length;
}

function penaltyCurve(actual, threshold) {
  // Simple curve: starts at 0, rises toward 1 as actual grows 2x threshold
  const ratio = actual / threshold;
  if (ratio <= 1) return 0;
  const capped = Math.min(2, ratio);
  return (capped - 1) / 1; // 1 at 2x threshold
}

/**
 * Detect deficiencies (< threshold of target) for configured micros.
 * Returns array of { nutrient, pct, needed, unit }
 */
function detectDeficiencies(totals, targets) {
  const out = [];
  for (const key of state.config.coreMicros) {
    const got = Number(totals.micros?.[key] || 0);
    const need = Number(targets.micros?.[key] || 0);
    if (!need) continue;
    const pct = clamp01(got / need);
    if (pct < state.config.deficiencyThresholdPct) {
      out.push({
        nutrient: key,
        pct: round2(pct),
        needed: round2(Math.max(0, need - got)),
        unit: nutrientUnit(key),
      });
    }
  }
  return out;
}

function nutrientUnit(k) {
  // Basic mapping; extend with NutritionDB metadata when available
  const mg = [
    "calcium",
    "iron",
    "magnesium",
    "phosphorus",
    "potassium",
    "sodium",
    "zinc",
    "vitaminC",
    "vitaminE",
    "niacin",
  ];
  const mcg = ["vitaminA", "vitaminD", "vitaminK", "folate", "vitaminB12"];
  const g = [
    "fiber",
    "addedSugar",
    "satFat",
    "carbs",
    "protein",
    "fat",
    "choline",
  ];
  if (mg.includes(k)) return "mg";
  if (mcg.includes(k)) return "mcg";
  if (g.includes(k)) return "g";
  return "mg";
}

//// Suggestions (swaps/sides/supplements) /////////////////////////////////////

async function buildFixSuggestions(defs, item, totals) {
  if (!state.config.suggestFixes) return [];

  const suggestions = [];
  for (const d of defs) {
    // Consult SubstitutionLibrary if available; otherwise provide generic placeholders
    let ideas = [];
    if (SubstitutionLibrary?.suggestForNutrient) {
      try {
        ideas = await SubstitutionLibrary.suggestForNutrient(d.nutrient, {
          allergies: HouseholdPrefs?.get?.()?.allergies || [],
          diet: HouseholdPrefs?.get?.()?.diet || null,
          needed: d.needed,
        });
      } catch {
        /* noop */
      }
    } else {
      ideas = genericIdeasFor(d.nutrient);
    }

    // Build suggestion objects
    ideas.slice(0, 3).forEach((idea) => {
      suggestions.push({
        id: safeId("fix"),
        kind: idea.kind, // "swap" | "side" | "supplement"
        title: idea.title,
        nutrient: d.nutrient,
        estBoost: idea.estBoost || null,
        session: idea.session || null, // optional session payload
      });
    });
  }

  // Optionally check availability for "side" suggestions
  if (InventoryService?.checkAvailability) {
    const sideTasks = suggestions.filter(
      (s) => s.kind === "side" && s.session?.ingredients
    );
    for (const s of sideTasks) {
      try {
        const avail = await InventoryService.checkAvailability(
          s.session.ingredients
        );
        s.inventory = { shortages: sanitize(avail?.shortages || []) };
      } catch {
        s.inventory = { shortages: [] };
      }
    }
  }

  return suggestions;
}

function genericIdeasFor(nutrient) {
  // Minimal, domain-agnostic starter list; replace with real library later.
  switch (nutrient) {
    case "fiber":
      return [
        {
          kind: "side",
          title: "Add Side Salad (mixed greens + beans)",
          estBoost: { fiber: 6 },
          session: quickSideSession("Side Salad", [
            { name: "mixed greens", qty: 2, unit: "cup" },
            { name: "kidney beans", qty: 0.5, unit: "cup" },
            { name: "olive oil", qty: 1, unit: "tbsp" },
          ]),
        },
        {
          kind: "swap",
          title: "Swap white rice → brown rice",
          estBoost: { fiber: 3 },
        },
        {
          kind: "side",
          title: "Add Apple",
          estBoost: { fiber: 4 },
          session: quickSideSession("Slice Apple", [
            { name: "apple", qty: 1, unit: "unit" },
          ]),
        },
      ];
    case "vitaminD":
      return [
        {
          kind: "side",
          title: "Add Fortified Milk (1 cup)",
          estBoost: { vitaminD: 2.5 },
        },
        {
          kind: "supplement",
          title: "Vitamin D3 softgel (1000 IU)",
          estBoost: { vitaminD: 25 },
        },
      ];
    case "iron":
      return [
        {
          kind: "side",
          title: "Add Lentils (½ cup cooked)",
          estBoost: { iron: 3 },
        },
        {
          kind: "swap",
          title: "Swap iceberg → spinach",
          estBoost: { iron: 2 },
        },
      ];
    default:
      return [
        { kind: "supplement", title: `Add multivitamin targeting ${nutrient}` },
      ];
  }
}

function quickSideSession(title, ingredients) {
  const from = new Date();
  const to = new Date(Date.now() + state.config.lookaheadMinutes * 60 * 1000);
  return {
    id: safeId("session"),
    title,
    domain: "cooking",
    source: "engines/nutritionScorer",
    createdAt: nowISO(),
    schedule: {
      suggestedAt: nowISO(),
      window: { from: from.toISOString(), to: to.toISOString() },
    },
    meta: { type: "side_addition", ingredients },
    session: {
      anchors: [{ type: "meal", label: "any", weight: 0.6 }],
      tasks: [
        {
          id: safeId("task"),
          type: "prep",
          title: "Gather ingredients",
          estimatedMinutes: 3,
        },
        { id: safeId("task"), type: "cook", title, estimatedMinutes: 7 },
      ],
    },
    ingredients, // convenience for InventoryService.checkAvailability
  };
}

//// Core processing ////////////////////////////////////////////////////////////

async function processItem(item) {
  if (!item || typeof item !== "object") {
    emit("engine.warning", "engines/nutritionScorer", {
      message: "Invalid item.",
      preview: sanitize(item),
    });
    return;
  }

  const targets = getTargets();
  const { totals, servings, source } = await computeNutritionForMealOrSession(
    item
  );

  // Score + detect issues
  const scoring = scoreNutrition(totals, targets);
  const deficiencies = detectDeficiencies(totals, targets);
  const excess = detectExcessFlags(totals);

  // Emit nutrition.scored for UI/analytics
  emit("nutrition.scored", "engines/nutritionScorer", {
    subject: summarizeSubject(item),
    totals: sanitize(totals),
    servings,
    score: scoring.score,
    details: scoring.details,
    source,
  });

  // Emit per-nutrient deficiency events
  for (const d of deficiencies) {
    emit("nutrition.deficiency.detected", "engines/nutritionScorer", {
      subject: summarizeSubject(item),
      nutrient: d.nutrient,
      pct: d.pct,
      needed: d.needed,
      unit: d.unit,
    });
  }

  // Emit excess warnings if any
  if (excess.flags.length) {
    emit("nutrition.excess.detected", "engines/nutritionScorer", {
      subject: summarizeSubject(item),
      flags: excess.flags, // e.g., [{type:"sodium", value: 1250, unit:"mg"}]
    });
  }

  // Build fixes
  const fixes = await buildFixSuggestions(deficiencies, item, totals);

  if (fixes.length) {
    emit("nutrition.fix.suggested", "engines/nutritionScorer", {
      subject: summarizeSubject(item),
      fixes: sanitize(fixes),
    });

    // Optionally auto-schedule simple sides/supplements
    if (featureFlags?.nutrition?.autoFix && state.config.autoFixSchedule) {
      const scheduleables = fixes.filter((f) => f.session);
      scheduleables.forEach((f) => {
        emit("automation.schedule.request", "engines/nutritionScorer", {
          domain: f.session.domain,
          reason: "nutrition_fix",
          sessionId: f.session.id,
          preferredWindow: f.session.schedule.window,
          priority: "medium",
        });
      });

      if (scheduleables.length) {
        exportToHubIfEnabled({
          domain: "nutrition",
          action: "fixes_scheduled",
          payload: {
            subjectId: item?.id || null,
            count: scheduleables.length,
            nutrients: deficiencies.map((d) => d.nutrient),
          },
        });
      }
    } else {
      // Suggestions only → optional hub summary
      exportToHubIfEnabled({
        domain: "nutrition",
        action: "fixes_suggested",
        payload: {
          subjectId: item?.id || null,
          count: fixes.length,
          nutrients: deficiencies.map((d) => d.nutrient),
        },
      });
    }
  } else {
    exportToHubIfEnabled({
      domain: "nutrition",
      action: "scored",
      payload: {
        subjectId: item?.id || null,
        score: scoring.score,
        flaggedExcess: excess.flags.map((f) => f.type),
      },
    });
  }
}

function detectExcessFlags(totals) {
  const flags = [];
  const sodium = Number(totals?.micros?.sodium || 0);
  if (sodium > state.config.excess.sodiumMg)
    flags.push({ type: "sodium", value: round1(sodium), unit: "mg" });
  const addedSugar = Number(totals?.micros?.addedSugar || 0);
  if (addedSugar > state.config.excess.addedSugarG)
    flags.push({ type: "addedSugar", value: round1(addedSugar), unit: "g" });
  const satFat = Number(totals?.micros?.satFat || 0);
  if (satFat > state.config.excess.satFatG)
    flags.push({ type: "satFat", value: round1(satFat), unit: "g" });
  return { flags };
}

function summarizeSubject(item) {
  return {
    id: item?.id || null,
    kind:
      item?.domain === "cooking"
        ? "session"
        : item?.recipeId || item?.ingredients
        ? "meal"
        : "unknown",
    title: item?.title || null,
    recipeId: item?.recipeId || item?.meta?.recipeId || null,
  };
}

//// Queue / worker ////////////////////////////////////////////////////////////

function enqueue(itemOrArray) {
  state.queue.push(itemOrArray);
  Promise.resolve().then(drainQueue);
}

async function drainQueue() {
  if (state.processing) return;
  state.processing = true;
  try {
    while (state.queue.length) {
      const next = state.queue.shift();
      if (Array.isArray(next)) {
        // eslint-disable-next-line no-await-in-loop
        for (const it of next) await processItem(it);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await processItem(next);
      }
    }
  } finally {
    state.processing = false;
  }
}

//// Public API ////////////////////////////////////////////////////////////////

/**
 * start(config?)
 *  - Loads dependencies
 *  - Subscribes to:
 *      • "meal.planned"                 { data: meal }
 *      • "cooking.session.created"      { data: { session } }
 *      • "import.parsed" (meals/recipes)
 *      • "meal.executed" (future: log actuals)
 *  - Emits "engine.started"
 */
export async function start(config = {}) {
  if (state.initialized) return;

  state.config = { ...state.config, ...config };

  const [evb, ff, nutrdb, rec, prefs, units, subs, inv, hubFmt, hubConn] =
    await Promise.all([
      softImport("../services/events/eventBus.js"),
      softImport("@/config/featureFlags.json"),
      softImport("../nutrition/NutritionDB.js"),
      softImport("../stores/RecipeStore.js"),
      softImport("../services/HouseholdPrefs.js"),
      softImport("../services/UnitConverter.js"),
      softImport("../libraries/SubstitutionLibrary.js"),
      softImport("../domain/inventory/InventoryService.js"),
      softImport("@/services/hub/HubPacketFormatter.js"),
      softImport("@/services/hub/FamilyFundConnector.js"),
    ]);

  eventBus = evb?.default || evb || eventBus;
  featureFlags = ff?.default || ff || featureFlags;
  NutritionDB = nutrdb?.default || nutrdb || NutritionDB;
  RecipeStore = rec?.default || rec || RecipeStore;
  HouseholdPrefs = prefs?.default || prefs || HouseholdPrefs;
  UnitConverter = units?.default || units || UnitConverter;
  SubstitutionLibrary = subs?.default || subs || SubstitutionLibrary;
  InventoryService = inv?.default || inv || InventoryService;
  HubPacketFormatter = hubFmt?.default || hubFmt || HubPacketFormatter;
  FamilyFundConnector = hubConn?.default || hubConn || FamilyFundConnector;

  if (!eventBus?.on || !eventBus?.emit) {
    throw new Error(
      "nutritionScorer requires a functional eventBus with on/emit."
    );
  }

  // Event: a meal is planned → score it
  eventBus.on("meal.planned", (evt) => {
    const meal = evt?.data;
    if (!meal) return;
    enqueue(meal);
  });

  // Event: a cooking session was created → score it
  eventBus.on("cooking.session.created", (evt) => {
    const session = evt?.data?.session || evt?.data;
    if (!session) return;
    enqueue(session);
  });

  // Event: importer parsed meals/recipes → score batch
  eventBus.on("import.parsed", (evt) => {
    const d = evt?.data;
    if (d?.domain === "meals" && Array.isArray(d?.items)) {
      enqueue(d.items);
    }
    // Optional: recipe-only imports could be scored if sample servings provided
  });

  // Future: when a meal is executed, log actuals for analytics
  // eventBus.on("meal.executed", (evt) => { ... emit nutrition.actual.logged ... });

  state.initialized = true;

  emit("engine.started", "engines/nutritionScorer", {
    config: sanitize(state.config),
    degraded: {
      nutritionDB: !NutritionDB,
      recipeStore: !RecipeStore,
      prefs: !HouseholdPrefs,
      unitConverter: !UnitConverter,
      substitutionLib: !SubstitutionLibrary,
      inventory: !InventoryService,
    },
  });
}

/**
 * score(itemOrArray)
 *  - Manual trigger to score one or more items (meals or sessions).
 */
export async function score(itemOrArray) {
  if (!state.initialized) await start();
  enqueue(itemOrArray);
  return { enqueued: true };
}

export default { start, score };
