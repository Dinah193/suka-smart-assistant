// File: src/services/meals/MealSuggestionService.js
/**
 * MealSuggestionService
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Deterministic (non-AI) meal suggestion engine for SSA.
 *  - Produces “feels-random” suggestions using seeded rotation + constraints.
 *  - Designed to support your “fixed calendar rhythm” approach:
 *      • fixed proteins / anchors
 *      • balanced sides (veg/grain/bread/sauce) from catalogs
 *      • respects household/user preferences (keto/carnivore/veg/OMAD windows)
 *      • supports soup & sandwich lunch and soup dinners without overwhelm
 *
 * Design principles
 *  - Browser-safe (no node imports)
 *  - Pure functions where possible
 *  - Works even if some catalogs/stores aren’t wired yet (graceful defaults)
 *  - Emits optional events via eventBus if present
 *
 * Integration points (optional)
 *  - MealPrefsStore (prefs)
 *  - Inventory (availability)
 *  - Recipe/Meal catalogs (candidates)
 *  - Nutrition layer (macro targets)
 *  - Sabbath/quiet hours logic (guards)
 *
 * Public API
 *  - suggestDay({ dateISO, profile, prefs, catalogs, history, inventory, seedKey })
 *  - suggestWeek({ weekStartISO, days=7, ... })
 *  - scoreMeal(meal, ctx)
 *  - chooseAnchorsForDay(ctx)
 *  - setConfig(partial)
 *
 * Data expectations (flexible)
 *  - catalogs.recipes: array of recipe-like objects:
 *      { id, name/title, tags[], cuisine?, mealTypes[], proteins[], dietary[],
 *        timeMinutes?, difficulty?, equipment?, soup?, sandwich?, leftoversFriendly?,
 *        macros? { calories, protein, carbs, fat }, ingredients[] }
 *  - history: array of events: { dateISO, mealType, recipeId, protein, tags[] }
 *  - inventory: optional structure; can include ingredient availability, freezer, etc.
 *
 * Output shape
 *  {
 *    dateISO,
 *    suggestions: {
 *      breakfast: [Candidate],
 *      lunch: [Candidate],
 *      dinner: [Candidate],
 *      snacks: [Candidate]
 *    },
 *    chosen: { breakfast, lunch, dinner },
 *    meta: { seed, guards, notes, debug? }
 *  }
 */

const SOURCE = "meals.MealSuggestionService";

/* --------------------------------- defaults -------------------------------- */
const DEFAULT_CONFIG = Object.freeze({
  maxCandidatesPerSlot: 10,
  maxReturnedPerSlot: 5,
  historyWindowDays: 28,
  penaltyRepeatRecipe: 35,
  penaltyRepeatProtein: 22,
  penaltyRepeatTag: 8,
  bonusLeftovers: 8,
  bonusFastWeeknight: 6,
  bonusSoupWhenCold: 0, // hook for weather later
  bonusSandwichLunch: 6,
  bonusSoupLunch: 6,
  bonusSoupDinner: 5,

  // If a user says “make it feel random”, we still keep deterministic seed,
  // but add jitter in scoring (seeded) so ties resolve differently.
  scoreJitter: 3,

  // Default meal slot weights (higher = more important)
  slotWeights: {
    breakfast: 1.0,
    lunch: 1.0,
    dinner: 1.2,
    snacks: 0.4,
  },

  // Default “fixed rhythm” anchors (can be overridden by prefs/profile)
  // These are *types* not recipes; selection later chooses actual recipes.
  fixedRhythm: {
    breakfast: {
      default: ["eggs", "waffles", "sausage", "bacon"],
    },
    lunch: {
      default: ["soup", "sandwich", "leftovers"],
    },
    dinner: {
      default: ["protein+veg", "soup", "stew"],
    },
  },

  // Meal type fallbacks
  mealTypes: ["breakfast", "lunch", "dinner", "snack"],

  // Minimal dietary modes the engine understands (extend later)
  dietModes: ["balanced", "keto", "carnivore", "vegetarian", "omad"],

  // A simple “weekday” classifier for bonusFastWeeknight
  weekdayFastThresholdMinutes: 45,

  // Debug flag (can be toggled per call)
  debug: false,
});

let CONFIG = { ...DEFAULT_CONFIG };

/* ----------------------------- optional event bus --------------------------- */
async function tryGetEventBus() {
  try {
    const mod = await import(/* @vite-ignore */ "@/services/events/eventBus");
    return mod?.eventBus || mod?.default || null;
  } catch {
    return null;
  }
}
async function emit(evt, payload) {
  const bus = await tryGetEventBus();
  if (!bus) return;
  try {
    if (typeof bus.emit === "function") bus.emit(evt, payload);
    else if (typeof bus.publish === "function") bus.publish(evt, payload);
  } catch {
    // never crash
  }
}

/* ---------------------------------- utils ---------------------------------- */
function isObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}
function safeStr(v, fallback = "") {
  if (v == null) return fallback;
  return String(v);
}
function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}
function uniq(arr) {
  const out = [];
  const s = new Set();
  for (const x of arr) {
    const k = safeStr(x);
    if (!k) continue;
    if (s.has(k)) continue;
    s.add(k);
    out.push(x);
  }
  return out;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function toISODateOnly(date) {
  const d = typeof date === "string" ? new Date(date) : date;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  // ISO date only
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    .toISOString()
    .slice(0, 10);
}
function addDaysISO(dateISO, deltaDays) {
  const d = new Date(dateISO);
  const t = d.getTime();
  if (Number.isNaN(t)) return dateISO;
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString();
}
function daysBetweenISO(aISO, bISO) {
  const a = new Date(aISO);
  const b = new Date(bISO);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const ms = 24 * 60 * 60 * 1000;
  return Math.round((b.getTime() - a.getTime()) / ms);
}
function isWeekend(dateISO) {
  const d = new Date(dateISO);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getDay(); // 0 Sun .. 6 Sat
  return day === 0 || day === 6;
}
function isWeekday(dateISO) {
  return !isWeekend(dateISO);
}

/* ------------------------------- seeded random ------------------------------ */
/**
 * Deterministic PRNG with string seed. Uses xmur3 + mulberry32.
 * - Good enough for “feels random” but reproducible.
 */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seedStr) {
  const seed = xmur3(seedStr)();
  const rand = mulberry32(seed);
  return { seed, rand };
}
function jitter(rng, amount) {
  if (!amount) return 0;
  return (rng.rand() * 2 - 1) * amount;
}

/* ----------------------------- normalization -------------------------------- */
function normalizeRecipe(raw) {
  const id = safeStr(raw?.id || raw?._id || raw?.key || "");
  const title = safeStr(raw?.name || raw?.title || raw?.label || id);
  const tags = uniq(asArray(raw?.tags).map((t) => safeStr(t).toLowerCase()));
  const cuisine = safeStr(raw?.cuisine || "").toLowerCase();
  const mealTypes = uniq(
    asArray(raw?.mealTypes || raw?.mealType).map((t) =>
      safeStr(t).toLowerCase()
    )
  );
  const proteins = uniq(
    asArray(raw?.proteins || raw?.protein).map((p) => safeStr(p).toLowerCase())
  );
  const dietary = uniq(
    asArray(raw?.dietary || raw?.diets).map((d) => safeStr(d).toLowerCase())
  );

  const timeMinutes =
    typeof raw?.timeMinutes === "number"
      ? raw.timeMinutes
      : typeof raw?.minutes === "number"
      ? raw.minutes
      : null;

  const soup = !!raw?.soup || tags.includes("soup");
  const sandwich = !!raw?.sandwich || tags.includes("sandwich");
  const leftoversFriendly =
    raw?.leftoversFriendly != null
      ? !!raw.leftoversFriendly
      : tags.includes("leftovers") || tags.includes("meal-prep");

  const macros = isObject(raw?.macros) ? raw.macros : null;

  return {
    ...raw,
    id,
    title,
    tags,
    cuisine,
    mealTypes,
    proteins,
    dietary,
    timeMinutes,
    soup,
    sandwich,
    leftoversFriendly,
    macros,
  };
}

/* ------------------------------ constraints --------------------------------- */
function getDietMode(ctx) {
  const mode = safeStr(
    ctx?.prefs?.dietMode || ctx?.profile?.dietMode || "balanced"
  ).toLowerCase();
  return CONFIG.dietModes.includes(mode) ? mode : "balanced";
}

function mealTypeAllowedByDiet(meal, dietMode) {
  // Minimal heuristics, extend with your Nutrition layer later.
  const d = dietMode;

  const tags = meal.tags || [];
  const dietary = meal.dietary || [];

  if (d === "carnivore") {
    // Must be meat/animal-based; allow eggs/dairy; no grains/veg
    if (tags.includes("vegetarian") || tags.includes("vegan")) return false;
    if (dietary.includes("vegetarian") || dietary.includes("vegan"))
      return false;

    // If recipe declares "carbs" or "grain" explicitly, downrank hard or reject.
    if (
      tags.includes("grain") ||
      tags.includes("bread") ||
      tags.includes("pasta")
    )
      return false;

    return true;
  }

  if (d === "vegetarian") {
    if (tags.includes("meat") || tags.includes("pork") || tags.includes("beef"))
      return false;
    if (dietary.includes("contains-meat") || dietary.includes("meat"))
      return false;
    // allow eggs/dairy unless marked vegan-only
    return true;
  }

  if (d === "keto") {
    // Avoid high-carb flags; keep if keto tag, or low-carb indicators
    if (
      tags.includes("high-carb") ||
      tags.includes("pasta") ||
      tags.includes("rice")
    )
      return false;
    return true;
  }

  if (d === "omad") {
    // OMAD means one meal a day; the caller will select only one slot.
    // Still allow all meals; selection logic will place it.
    return true;
  }

  // balanced/default
  return true;
}

function matchesAllergens(meal, avoidAllergens) {
  const avoid = asArray(avoidAllergens).map((a) => safeStr(a).toLowerCase());
  if (!avoid.length) return true;

  const allergens = asArray(meal?.allergens).map((a) =>
    safeStr(a).toLowerCase()
  );
  if (!allergens.length) return true;

  for (const a of avoid) {
    if (allergens.includes(a)) return false;
  }
  return true;
}

function matchesEquipment(meal, availableEquipment) {
  const req = asArray(meal?.equipment).map((e) => safeStr(e).toLowerCase());
  if (!req.length) return true;

  const avail = asArray(availableEquipment).map((e) =>
    safeStr(e).toLowerCase()
  );
  if (!avail.length) return false;

  return req.every((r) => avail.includes(r));
}

function matchesTimeWindow(meal, maxMinutes) {
  if (!maxMinutes) return true;
  const m = meal?.timeMinutes;
  if (typeof m !== "number") return true; // unknown time: allow
  return m <= maxMinutes;
}

function matchesMealSlot(meal, slot) {
  // If mealTypes is absent, allow.
  const types = asArray(meal?.mealTypes).map((t) => safeStr(t).toLowerCase());
  if (!types.length) return true;
  return types.includes(slot);
}

function matchesCuisine(meal, allowedCuisines) {
  const allowed = asArray(allowedCuisines).map((c) => safeStr(c).toLowerCase());
  if (!allowed.length) return true;
  if (!meal?.cuisine) return false;
  return allowed.includes(meal.cuisine);
}

/* ------------------------------ history model -------------------------------- */
function buildHistoryIndex(history, nowISO, windowDays) {
  const list = Array.isArray(history) ? history : [];
  const minISO = addDaysISO(
    nowISO,
    -Math.abs(windowDays || CONFIG.historyWindowDays)
  );
  const idx = {
    recentRecipeCounts: new Map(),
    recentProteinCounts: new Map(),
    recentTagCounts: new Map(),
    recentBySlot: new Map(), // slot -> array of recipeIds
  };

  for (const h of list) {
    const dateISO = safeStr(h?.dateISO || h?.date || "");
    if (!dateISO) continue;
    if (new Date(dateISO) < new Date(minISO)) continue;

    const recipeId = safeStr(h?.recipeId || h?.id || "");
    const slot = safeStr(h?.mealType || h?.slot || "").toLowerCase();

    if (recipeId) {
      idx.recentRecipeCounts.set(
        recipeId,
        (idx.recentRecipeCounts.get(recipeId) || 0) + 1
      );
      if (slot) {
        if (!idx.recentBySlot.has(slot)) idx.recentBySlot.set(slot, []);
        idx.recentBySlot.get(slot).push(recipeId);
      }
    }

    const protein = safeStr(h?.protein || "").toLowerCase();
    if (protein) {
      idx.recentProteinCounts.set(
        protein,
        (idx.recentProteinCounts.get(protein) || 0) + 1
      );
    }

    const tags = asArray(h?.tags).map((t) => safeStr(t).toLowerCase());
    for (const t of tags) {
      if (!t) continue;
      idx.recentTagCounts.set(t, (idx.recentTagCounts.get(t) || 0) + 1);
    }
  }

  return idx;
}

/* ------------------------------ anchors/rhythm ------------------------------ */
/**
 * “Fixed rhythm” in SSA terms:
 *  - Some meals have *anchor constraints* (e.g., dinner protein fixed per day)
 *  - We then choose actual recipes that satisfy the anchor and maximize variety.
 *
 * This method returns anchor hints for each slot.
 */
function chooseAnchorsForDay(ctx) {
  const dietMode = getDietMode(ctx);

  const prefs = ctx?.prefs || {};
  const profile = ctx?.profile || {};

  const rhythm = isObject(prefs?.fixedRhythm)
    ? prefs.fixedRhythm
    : isObject(profile?.fixedRhythm)
    ? profile.fixedRhythm
    : CONFIG.fixedRhythm;

  // User may specify fixed proteins by weekday
  // Example: prefs.fixedProteinsByWeekday = { "mon":"chicken", "tue":"beef", ... }
  const dateISO = ctx?.dateISO || nowISO();
  const d = new Date(dateISO);
  const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()];

  const fixedProtein =
    safeStr(prefs?.fixedProteinsByWeekday?.[weekday] || "").toLowerCase() ||
    safeStr(profile?.fixedProteinsByWeekday?.[weekday] || "").toLowerCase();

  const anchors = {
    breakfast: {
      wants: asArray(rhythm?.breakfast?.default || []).map((x) =>
        safeStr(x).toLowerCase()
      ),
    },
    lunch: {
      wants: asArray(rhythm?.lunch?.default || []).map((x) =>
        safeStr(x).toLowerCase()
      ),
    },
    dinner: {
      wants: asArray(rhythm?.dinner?.default || []).map((x) =>
        safeStr(x).toLowerCase()
      ),
      fixedProtein: fixedProtein || "",
    },
  };

  // Diet-mode overlays (keep it simple and deterministic)
  if (dietMode === "carnivore") {
    anchors.breakfast.wants = uniq(["eggs", "sausage", "bacon"]);
    anchors.lunch.wants = uniq(["leftovers", "protein"]);
    anchors.dinner.wants = uniq(["protein"]);
  }
  if (dietMode === "keto") {
    anchors.lunch.wants = uniq(["soup", "leftovers", "salad"]);
    anchors.dinner.wants = uniq(["protein+veg", "soup"]);
  }
  if (dietMode === "vegetarian") {
    anchors.dinner.fixedProtein = ""; // ignore protein anchors
    anchors.dinner.wants = uniq(["veg+protein", "soup", "stew"]);
  }

  return anchors;
}

function nowISO() {
  return new Date().toISOString();
}

/* ------------------------------- candidate pool ----------------------------- */
function getCatalogRecipes(catalogs) {
  const list = asArray(
    catalogs?.recipes || catalogs?.meals || catalogs?.recipeCatalog
  );
  return list
    .map((r) => (isObject(r) ? normalizeRecipe(r) : null))
    .filter(Boolean)
    .filter((r) => r.id || r.title);
}

function buildSlotConstraints(ctx, slot, anchors) {
  const prefs = ctx?.prefs || {};
  const profile = ctx?.profile || {};
  const dietMode = getDietMode(ctx);

  // Basic constraints
  const avoidAllergens = prefs?.avoidAllergens || profile?.avoidAllergens || [];
  const cuisines = prefs?.allowedCuisines || profile?.allowedCuisines || [];
  const equipment = prefs?.equipment || profile?.equipment || [];

  // Time limit per slot (optional)
  const maxMinutes =
    (prefs?.maxMinutesBySlot && prefs.maxMinutesBySlot[slot]) ||
    (profile?.maxMinutesBySlot && profile.maxMinutesBySlot[slot]) ||
    null;

  // “Soup & sandwich lunch option” toggle
  const lunchStyle = safeStr(
    prefs?.lunchStyle || profile?.lunchStyle || ""
  ).toLowerCase();
  // e.g. "soup-and-sandwich", "soup-only", "sandwich-only", "leftovers"
  const dinnerStyle = safeStr(
    prefs?.dinnerStyle || profile?.dinnerStyle || ""
  ).toLowerCase();

  const wants = new Set(asArray(anchors?.[slot]?.wants || []));

  if (slot === "lunch") {
    if (lunchStyle === "soup-and-sandwich") {
      wants.add("soup");
      wants.add("sandwich");
      wants.add("leftovers");
    } else if (lunchStyle === "soup-only") {
      wants.add("soup");
    } else if (lunchStyle === "sandwich-only") {
      wants.add("sandwich");
    } else if (lunchStyle === "leftovers") {
      wants.add("leftovers");
    }
  }

  if (slot === "dinner") {
    if (dinnerStyle === "soup") wants.add("soup");
    if (dinnerStyle === "stew") wants.add("stew");
  }

  return {
    dietMode,
    avoidAllergens,
    cuisines,
    equipment,
    maxMinutes,
    wants: Array.from(wants),
    fixedProtein: safeStr(anchors?.dinner?.fixedProtein || ""),
  };
}

function recipeMatchesWants(meal, wants, slotConstraints) {
  if (!wants || !wants.length) return true;

  const tags = meal.tags || [];
  const title = (meal.title || "").toLowerCase();
  const proteins = meal.proteins || [];
  const fixedProtein = slotConstraints?.fixedProtein;

  // If fixed protein is specified for dinner, require it.
  if (fixedProtein && proteins.length) {
    if (!proteins.includes(fixedProtein)) return false;
  }

  // Simple want logic:
  // - "soup" requires meal.soup or tag
  // - "sandwich" requires meal.sandwich or tag
  // - "leftovers" uses leftoversFriendly
  // - "protein" requires proteins present
  // - "protein+veg" is a tag hint; if absent, still allow (scored bonus instead)
  for (const w of wants) {
    if (w === "soup") {
      if (!meal.soup) return false;
    } else if (w === "sandwich") {
      if (!meal.sandwich) return false;
    } else if (w === "leftovers") {
      if (!meal.leftoversFriendly) return false;
    } else if (w === "eggs") {
      if (!tags.includes("eggs") && !title.includes("egg")) return false;
    } else if (w === "waffles") {
      if (!tags.includes("waffle") && !title.includes("waffle")) return false;
    } else if (w === "sausage") {
      if (!tags.includes("sausage") && !title.includes("sausage")) return false;
    } else if (w === "bacon") {
      if (!tags.includes("bacon") && !title.includes("bacon")) return false;
    } else if (w === "protein") {
      if (!proteins.length && !tags.includes("protein")) return false;
    } else {
      // Unknown wants: treat as soft (do not reject)
      // Example: "protein+veg", "stew"
    }
  }

  return true;
}

function filterCandidatesForSlot(recipes, ctx, slot, slotConstraints) {
  const dietMode = slotConstraints.dietMode;
  const avoidAllergens = slotConstraints.avoidAllergens;
  const cuisines = slotConstraints.cuisines;
  const equipment = slotConstraints.equipment;
  const maxMinutes = slotConstraints.maxMinutes;
  const wants = slotConstraints.wants;

  const out = [];
  for (const meal of recipes) {
    if (!matchesMealSlot(meal, slot)) continue;
    if (!mealTypeAllowedByDiet(meal, dietMode)) continue;
    if (!matchesAllergens(meal, avoidAllergens)) continue;
    if (!matchesCuisine(meal, cuisines)) continue;
    if (!matchesEquipment(meal, equipment)) continue;
    if (!matchesTimeWindow(meal, maxMinutes)) continue;
    if (!recipeMatchesWants(meal, wants, slotConstraints)) continue;
    out.push(meal);
  }

  return out;
}

/* ----------------------------------- scoring -------------------------------- */
function scoreMeal(meal, ctx) {
  const { slot, rng, historyIdx, slotConstraints } = ctx;

  let score = 100;

  // Repetition penalties
  const recipeCount = historyIdx?.recentRecipeCounts?.get(meal.id) || 0;
  if (recipeCount) score -= recipeCount * CONFIG.penaltyRepeatRecipe;

  // Protein repetition (if declared)
  const proteins = asArray(meal.proteins);
  for (const p of proteins) {
    const c = historyIdx?.recentProteinCounts?.get(p) || 0;
    if (c) score -= c * CONFIG.penaltyRepeatProtein;
  }

  // Tag repetition
  for (const t of asArray(meal.tags)) {
    const c = historyIdx?.recentTagCounts?.get(t) || 0;
    if (c) score -= c * CONFIG.penaltyRepeatTag;
  }

  // Slot preference bonuses (soup/sandwich/leftovers)
  if (meal.leftoversFriendly) score += CONFIG.bonusLeftovers;

  if (slot === "lunch") {
    if (meal.sandwich) score += CONFIG.bonusSandwichLunch;
    if (meal.soup) score += CONFIG.bonusSoupLunch;
  }
  if (slot === "dinner") {
    if (meal.soup) score += CONFIG.bonusSoupDinner;
  }

  // Weeknight speed bonus
  if (slot === "dinner" && isWeekday(ctx.dateISO)) {
    const m = meal.timeMinutes;
    if (typeof m === "number" && m <= CONFIG.weekdayFastThresholdMinutes) {
      score += CONFIG.bonusFastWeeknight;
    }
  }

  // Soft matching of wants (if wants includes things we didn't hard-reject)
  const wants = asArray(slotConstraints?.wants);
  for (const w of wants) {
    if (w === "protein+veg") {
      if (
        asArray(meal.tags).includes("protein+veg") ||
        asArray(meal.tags).includes("balanced-plate")
      ) {
        score += 6;
      }
    } else if (w === "stew") {
      if (
        asArray(meal.tags).includes("stew") ||
        (meal.title || "").toLowerCase().includes("stew")
      ) {
        score += 5;
      }
    } else if (w === "veg+protein") {
      if (asArray(meal.tags).includes("veg+protein")) score += 6;
    }
  }

  // Seeded jitter so ties resolve "randomly" but deterministically
  score += jitter(rng, CONFIG.scoreJitter);

  // Clamp
  score = clamp(score, -999, 999);

  return score;
}

function pickTopN(scored, n) {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  return sorted.slice(0, n);
}

function chooseOne(scored, rng) {
  // Weighted roulette among top candidates
  const top = pickTopN(
    scored,
    Math.min(scored.length, CONFIG.maxCandidatesPerSlot)
  );
  if (!top.length) return null;

  // Convert scores into positive weights
  const weights = top.map((x) => Math.max(1, x.score + 50));
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = rng.rand() * sum;

  for (let i = 0; i < top.length; i++) {
    r -= weights[i];
    if (r <= 0) return top[i];
  }
  return top[top.length - 1];
}

/* -------------------------------- public API -------------------------------- */
function setConfig(partial) {
  if (!isObject(partial)) return CONFIG;
  CONFIG = { ...CONFIG, ...partial };
  return CONFIG;
}

/**
 * Build per-day suggestions and choose a plan for the day.
 */
async function suggestDay({
  dateISO,
  profile = {},
  prefs = {},
  catalogs = {},
  history = [],
  inventory = {},
  seedKey = "",
  debug = CONFIG.debug,
} = {}) {
  const date = dateISO ? new Date(dateISO) : new Date();
  const dateISOFull = date.toISOString();
  const dayKey = toISODateOnly(dateISOFull) || dateISOFull.slice(0, 10);

  // Seed: stable per household + date + kind
  const householdId = safeStr(
    prefs?.householdId || profile?.householdId || "default"
  );
  const seed = `${householdId}|${
    seedKey || "meal-suggest"
  }|${dayKey}|${getDietMode({ prefs, profile })}`;
  const rng = makeRng(seed);

  const recipes = getCatalogRecipes(catalogs);

  const anchors = chooseAnchorsForDay({ dateISO: dateISOFull, prefs, profile });

  const historyIdx = buildHistoryIndex(
    history,
    dateISOFull,
    CONFIG.historyWindowDays
  );

  const dietMode = getDietMode({ prefs, profile });

  // OMAD: choose only one primary meal (dinner by default)
  const omadPrimarySlot = safeStr(
    prefs?.omadPrimarySlot || "dinner"
  ).toLowerCase();

  const slots = ["breakfast", "lunch", "dinner"];

  const suggestions = {
    breakfast: [],
    lunch: [],
    dinner: [],
    snacks: [],
  };

  const chosen = {
    breakfast: null,
    lunch: null,
    dinner: null,
  };

  const notes = [];
  const guards = { dietMode };

  // If no recipes, fail gracefully
  if (!recipes.length) {
    notes.push(
      "No recipes available in catalogs.recipes; returning empty suggestions."
    );
    const payload = {
      dateISO: dateISOFull,
      suggestions,
      chosen,
      meta: { seed, guards, notes, debug: debug ? { recipes: 0 } : undefined },
    };
    await emit("meals.suggested", { source: SOURCE, ...payload });
    return payload;
  }

  for (const slot of slots) {
    if (dietMode === "omad" && slot !== omadPrimarySlot) {
      suggestions[slot] = [];
      chosen[slot] = null;
      continue;
    }

    const slotConstraints = buildSlotConstraints(
      { dateISO: dateISOFull, prefs, profile, catalogs, history, inventory },
      slot,
      anchors
    );

    const pool = filterCandidatesForSlot(
      recipes,
      { prefs, profile },
      slot,
      slotConstraints
    );

    // If we hard-filtered too much, loosen wants constraint (but keep diet/allergen).
    let relaxedPool = pool;
    if (!relaxedPool.length && slotConstraints.wants?.length) {
      const relaxed = { ...slotConstraints, wants: [] };
      relaxedPool = filterCandidatesForSlot(
        recipes,
        { prefs, profile },
        slot,
        relaxed
      );
      if (relaxedPool.length)
        notes.push(`Relaxed wants for ${slot} due to empty pool.`);
    }

    const scored = relaxedPool.map((meal) => ({
      meal,
      score: scoreMeal(meal, {
        slot,
        dateISO: dateISOFull,
        rng,
        historyIdx,
        slotConstraints,
      }),
    }));

    // Top suggestions list
    const top = pickTopN(scored, CONFIG.maxReturnedPerSlot).map((x) => ({
      id: x.meal.id,
      title: x.meal.title,
      score: Math.round(x.score * 10) / 10,
      cuisine: x.meal.cuisine || "",
      tags: x.meal.tags || [],
      proteins: x.meal.proteins || [],
      soup: !!x.meal.soup,
      sandwich: !!x.meal.sandwich,
      leftoversFriendly: !!x.meal.leftoversFriendly,
      timeMinutes: x.meal.timeMinutes ?? null,
      recipe: x.meal, // keep full object for now; you can strip later if desired
    }));

    suggestions[slot] = top;

    const chosenPick = chooseOne(scored, rng);
    chosen[slot] = chosenPick
      ? {
          id: chosenPick.meal.id,
          title: chosenPick.meal.title,
          score: Math.round(chosenPick.score * 10) / 10,
          cuisine: chosenPick.meal.cuisine || "",
          tags: chosenPick.meal.tags || [],
          proteins: chosenPick.meal.proteins || [],
          soup: !!chosenPick.meal.soup,
          sandwich: !!chosenPick.meal.sandwich,
          leftoversFriendly: !!chosenPick.meal.leftoversFriendly,
          timeMinutes: chosenPick.meal.timeMinutes ?? null,
          recipe: chosenPick.meal,
        }
      : null;

    // Add mild “overwhelm” guard note: if lunch and dinner both soup repeatedly, warn
    if (slot === "dinner" && chosen.dinner?.soup && chosen.lunch?.soup) {
      notes.push(
        "Both lunch and dinner selected soup today; consider sandwich/leftovers for lunch if desired."
      );
    }
  }

  // snacks: optional; simple: pick 1–2 high-score leftovers-friendly or quick
  // Keep it quiet by default unless prefs request snacks
  const snackPref = prefs?.includeSnacks ?? false;
  if (snackPref && dietMode !== "omad") {
    const snackSlot = "snacks";
    const slotConstraints = buildSlotConstraints(
      { dateISO: dateISOFull, prefs, profile, catalogs, history, inventory },
      "snack",
      anchors
    );
    const pool = filterCandidatesForSlot(
      recipes,
      { prefs, profile },
      "snack",
      slotConstraints
    );
    const scored = pool.map((meal) => ({
      meal,
      score: scoreMeal(meal, {
        slot: snackSlot,
        dateISO: dateISOFull,
        rng,
        historyIdx,
        slotConstraints,
      }),
    }));
    suggestions.snacks = pickTopN(scored, 3).map((x) => ({
      id: x.meal.id,
      title: x.meal.title,
      score: Math.round(x.score * 10) / 10,
      tags: x.meal.tags || [],
      timeMinutes: x.meal.timeMinutes ?? null,
      recipe: x.meal,
    }));
  }

  const payload = {
    dateISO: dateISOFull,
    suggestions,
    chosen,
    meta: {
      seed,
      guards,
      notes,
      debug: debug
        ? {
            recipeCount: recipes.length,
            historyWindowDays: CONFIG.historyWindowDays,
            anchors,
          }
        : undefined,
    },
  };

  await emit("meals.suggested", { source: SOURCE, ...payload });
  return payload;
}

/**
 * Suggest a week starting on weekStartISO (date or datetime).
 */
async function suggestWeek({
  weekStartISO,
  days = 7,
  profile = {},
  prefs = {},
  catalogs = {},
  history = [],
  inventory = {},
  seedKey = "",
  debug = CONFIG.debug,
} = {}) {
  const start = weekStartISO ? new Date(weekStartISO) : new Date();
  const out = [];
  const startISO = start.toISOString();

  for (let i = 0; i < (days || 7); i++) {
    const dayISO = addDaysISO(startISO, i);
    // Carry forward history by appending chosen items so we avoid repeats within week
    const dayResult = await suggestDay({
      dateISO: dayISO,
      profile,
      prefs,
      catalogs,
      history,
      inventory,
      seedKey: seedKey || "week",
      debug,
    });

    out.push(dayResult);

    // augment history with chosen picks (soft history)
    const chosen = dayResult?.chosen || {};
    for (const slot of ["breakfast", "lunch", "dinner"]) {
      const c = chosen[slot];
      if (!c?.id) continue;
      history = Array.isArray(history) ? history.slice() : [];
      history.push({
        dateISO: dayResult.dateISO,
        mealType: slot,
        recipeId: c.id,
        protein: asArray(c.proteins)[0] || "",
        tags: c.tags || [],
      });
    }
  }

  await emit("meals.week_suggested", {
    source: SOURCE,
    weekStartISO: startISO,
    days,
    count: out.length,
  });

  return out;
}

/* ----------------------------------------------------------------------------
 * ✅ COMPAT EXPORT: suggestMealsFromIntelligence
 * ----------------------------------------------------------------------------
 * MealPlanner.jsx imports:
 *   import { suggestMealsFromIntelligence } from "../../services/meals/MealSuggestionService";
 *
 * This is a deterministic “intelligence” wrapper that delegates to suggestDay /
 * suggestWeek depending on inputs. It keeps the file browser-safe and avoids
 * introducing any AI dependency.
 *
 * Supported calling patterns:
 *   - suggestMealsFromIntelligence({ dateISO, ... })  -> suggestDay(...)
 *   - suggestMealsFromIntelligence({ weekStartISO, days, ... }) -> suggestWeek(...)
 *   - suggestMealsFromIntelligence({ range: { startISO, days }, ... }) -> suggestWeek(...)
 *
 * Always returns a consistent object:
 *   { mode: "day"|"week", result }
 */
async function suggestMealsFromIntelligence(params = {}) {
  const p = isObject(params) ? params : {};

  // Support a { range: { startISO, days } } pattern
  const range = isObject(p.range) ? p.range : null;
  const rangeStart = range
    ? safeStr(range.startISO || range.weekStartISO || "")
    : "";
  const rangeDays =
    range && typeof range.days === "number" ? range.days : undefined;

  // Preferred: explicit weekStartISO
  const weekStartISO = safeStr(p.weekStartISO || rangeStart || "");
  const days =
    typeof p.days === "number"
      ? p.days
      : typeof rangeDays === "number"
      ? rangeDays
      : undefined;

  if (weekStartISO) {
    const result = await suggestWeek({
      weekStartISO,
      days: typeof days === "number" ? days : 7,
      profile: p.profile || {},
      prefs: p.prefs || {},
      catalogs: p.catalogs || {},
      history: p.history || [],
      inventory: p.inventory || {},
      seedKey: p.seedKey || "intelligence-week",
      debug: p.debug ?? CONFIG.debug,
    });
    return { mode: "week", result };
  }

  // Otherwise treat as day
  const dateISO = safeStr(p.dateISO || p.date || nowISO());
  const result = await suggestDay({
    dateISO,
    profile: p.profile || {},
    prefs: p.prefs || {},
    catalogs: p.catalogs || {},
    history: p.history || [],
    inventory: p.inventory || {},
    seedKey: p.seedKey || "intelligence-day",
    debug: p.debug ?? CONFIG.debug,
  });
  return { mode: "day", result };
}

/* ------------------------------- helper exports ----------------------------- */
const MealSuggestionService = {
  SOURCE,
  setConfig,
  normalizeRecipe,
  buildHistoryIndex,
  chooseAnchorsForDay,
  scoreMeal,
  suggestDay,
  suggestWeek,

  // compat
  suggestMealsFromIntelligence,
};

export default MealSuggestionService;
export {
  setConfig,
  normalizeRecipe,
  buildHistoryIndex,
  chooseAnchorsForDay,
  scoreMeal,
  suggestDay,
  suggestWeek,
  suggestMealsFromIntelligence,
};
