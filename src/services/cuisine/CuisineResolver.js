// FILE: src/services/cuisine/CuisineResolver.js
// Deterministic CuisineResolver
// - Picks meals based on a fixed rhythm + constraints
// - Uses Spice/Flavor matrix & Technique overlaps for variety without true randomness
// - Emits explainable metadata (traceability)

import { loadCuisineCatalogs } from "./CuisineCatalogLoader";
import { getCuisinePrefs } from "./CuisinePreferenceService";
import {
  createDeterministicRng,
  getRotationState,
  scoreDish,
  advanceRotationState,
} from "./CuisineRotationEngine";

let eventBus = { emit: () => {} };
try {
  eventBus = require("@/services/events/eventBus");
} catch {
  try {
    eventBus = require("@/services/events/eventBus").eventBus || eventBus;
  } catch {}
}

function isoDate(d) {
  const dt = new Date(d);
  return isNaN(dt) ? "" : dt.toISOString().slice(0, 10);
}

function unique(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function matchesDiet(dish, dietMode) {
  if (!dish) return false;
  if (dietMode === "vegetarian") return dish.primaryProtein === "vegetarian";
  if (dietMode === "carnivore")
    return dish.primaryProtein && dish.primaryProtein !== "vegetarian";
  return true;
}

function filterByPrefs(dishes, prefs) {
  const disliked = (prefs?.dislikedIngredients || [])
    .map((s) => String(s).toLowerCase())
    .filter(Boolean);
  const preferredProteins = unique(prefs?.preferredProteins).map(String);
  const diet = prefs?.dietMode || "normal";
  return (dishes || []).filter((d) => {
    if (!d?.torahSafe) return false;
    if (!matchesDiet(d, diet)) return false;

    const name = String(d?.name || "").toLowerCase();
    if (disliked.some((x) => x && name.includes(x))) return false;

    // If user has preferred proteins, downrank non-matching by keeping but marking later.
    if (
      preferredProteins.length &&
      d.primaryProtein &&
      d.primaryProtein !== "vegetarian"
    ) {
      return true;
    }
    return true;
  });
}

function buildFixedRhythm({ dates, prefs }) {
  // A non-AI fixed rhythm (deterministic), with “random-like” variety handled by rotation engine.
  // - Example: Mon: stew, Tue: grill, Wed: leftovers/soup, Thu: roast, Fri: fish/light, Sat: holy-day suitable, Sun: prep/pot
  // This returns desired technique family & mealType hints for each date.
  const out = {};
  const allowSoupDinner = prefs?.allowSoupDinner !== false;
  for (const d of dates) {
    const day = new Date(d).getDay(); // 0 Sun .. 6 Sat
    let desire = {
      mealType: "dinner",
      techniqueHint: null,
      tagsAny: [],
      tagsAvoid: [],
    };

    if (day === 1) desire.techniqueHint = "stew"; // Mon
    if (day === 2) desire.techniqueHint = "grill"; // Tue
    if (day === 3) desire.techniqueHint = allowSoupDinner ? "stew" : "pan-sear"; // Wed
    if (day === 4) desire.techniqueHint = "roast"; // Thu
    if (day === 5) desire.techniqueHint = "fish"; // Fri
    if (day === 6) {
      desire.techniqueHint = "holyDay";
      desire.tagsAny.push("holyDay");
    } // Sat
    if (day === 0) {
      desire.techniqueHint = "prep";
      desire.tagsAny.push("preservationFriendly");
    } // Sun

    if (prefs?.dietMode === "keto") desire.tagsAvoid.push("highStarch");
    if (prefs?.dietMode === "carnivore") {
      desire.tagsAvoid.push("vegHeavy", "legume", "grain", "highStarch");
    }
    if (prefs?.dietMode === "vegetarian") desire.tagsAny.push("vegHeavy");

    out[isoDate(d)] = desire;
  }
  return out;
}

function applyRhythmFilter(dishes, desire) {
  if (!desire) return dishes;
  const any = new Set((desire.tagsAny || []).filter(Boolean));
  const avoid = new Set((desire.tagsAvoid || []).filter(Boolean));

  let filtered = dishes;

  // Avoid tags
  if (avoid.size)
    filtered = filtered.filter((d) => {
      const tags = new Set((d?.tags || []).filter(Boolean));
      for (const a of avoid) if (tags.has(a)) return false;
      return true;
    });

  // If tagsAny specified, prefer those but don't hard-exclude (handled by scoring boost)
  return filtered;
}

function scoreBoostByRhythm(dish, desire) {
  if (!dish || !desire) return 0;
  const tags = new Set((dish.tags || []).filter(Boolean));
  let boost = 0;

  for (const t of desire.tagsAny || []) if (tags.has(t)) boost += 1.5;

  if (desire.techniqueHint === "fish" && dish.primaryProtein === "fish")
    boost += 3;
  const tech0 = Array.isArray(dish.techniques) ? dish.techniques[0] : "";
  if (
    desire.techniqueHint &&
    desire.techniqueHint !== "holyDay" &&
    desire.techniqueHint !== "prep"
  ) {
    if (tech0 === desire.techniqueHint) boost += 2;
  }
  if (desire.techniqueHint === "holyDay" && dish.holyDaySuitable) boost += 2;
  if (desire.techniqueHint === "prep" && tags.has("preservationFriendly"))
    boost += 2;

  return boost;
}

export async function resolveCuisineMeals({
  householdId = "default",
  cuisineKey = "aai",
  dates = [],
  mealType = "dinner",
  pinned = {}, // isoDate -> dishKey (manual override)
  tryNew = false, // “try something new”
  emitEvents = true,
} = {}) {
  const catalogs = await loadCuisineCatalogs({ cuisineKey });
  const prefs = await getCuisinePrefs({ householdId });

  const dishCatalog = catalogs?.dishCatalog?.dishes || [];
  const allDishes = filterByPrefs(
    dishCatalog.filter((d) => d.mealType === mealType),
    prefs
  );

  const rhythm = buildFixedRhythm({ dates, prefs });

  const weekIndex = (() => {
    const first = dates?.[0] || new Date();
    // re-use rotation engine’s weekIndex logic via state
    return null;
  })();

  const results = [];
  let state = await getRotationState({
    householdId,
    cuisineKey,
    date: dates?.[0] || new Date(),
  });
  const rng = createDeterministicRng({
    householdId,
    cuisineKey,
    weekIndex: state.weekIndex,
    salt: mealType,
  });

  for (const d of dates) {
    const iso = isoDate(d);
    const desire = rhythm[iso];

    // Pinned override: honor it if exists
    const pinnedDishKey = pinned?.[iso];
    if (pinnedDishKey) {
      const pinnedDish = dishCatalog.find((x) => x.key === pinnedDishKey);
      if (pinnedDish) {
        results.push({
          date: iso,
          dishKey: pinnedDish.key,
          dishName: pinnedDish.name,
          dish: pinnedDish,
          explain: {
            mode: "pinned",
            reason: "User pinned this meal to this day.",
            constraints: { dietMode: prefs.dietMode },
          },
        });
        state = await advanceRotationState({
          householdId,
          cuisineKey,
          date: d,
          chosen: {
            dishKey: pinnedDish.key,
            primaryProtein: pinnedDish.primaryProtein,
            technique: Array.isArray(pinnedDish.techniques)
              ? pinnedDish.techniques[0]
              : null,
            spiceProfile: Array.isArray(pinnedDish.spiceProfiles)
              ? pinnedDish.spiceProfiles[0]
              : null,
            cooldownDays:
              catalogs?.profile?.defaults?.rotation?.cooldownDays || 7,
          },
        });
        continue;
      }
    }

    // Candidate pool
    const candidates = applyRhythmFilter(allDishes, desire);

    // If tryNew: focus on dishes not served recently
    let pool = candidates;
    if (tryNew) {
      const servedKeys = new Set(Object.keys(state?.lastServedMap || {}));
      const unseen = pool.filter((x) => !servedKeys.has(x.key));
      if (unseen.length >= 5) pool = unseen;
    }

    // Score all candidates
    let best = null;
    let bestScore = -Infinity;
    const scored = [];
    for (const dish of pool) {
      const base = scoreDish({
        dish,
        prefs,
        state,
        rng,
        enforce: {
          rotateProteins: true,
          rotateTechniques: true,
          rotateSpice: true,
          avoidSameProteinConsecutive: true,
        },
      });
      const boost = scoreBoostByRhythm(dish, desire);
      const s = base + boost;
      scored.push({ key: dish.key, score: s });
      if (s > bestScore) {
        bestScore = s;
        best = dish;
      }
    }

    if (!best) {
      results.push({
        date: iso,
        dishKey: null,
        dishName: "No matching dish found",
        dish: null,
        explain: {
          mode: "empty",
          reason: "No dish matched constraints.",
          constraints: { dietMode: prefs.dietMode },
        },
      });
      continue;
    }

    const spiceProfile = Array.isArray(best.spiceProfiles)
      ? best.spiceProfiles[0]
      : null;
    const technique = Array.isArray(best.techniques)
      ? best.techniques[0]
      : null;

    const picked = {
      date: iso,
      dishKey: best.key,
      dishName: best.name,
      dish: best,
      explain: {
        mode: tryNew ? "tryNew" : "rotation",
        reason:
          "Deterministic rotation selection using household rhythm + constraints.",
        rhythm: desire,
        constraints: {
          dietMode: prefs.dietMode,
          dislikedIngredients: prefs.dislikedIngredients,
          preferredProteins: prefs.preferredProteins,
        },
        rotation: {
          weekIndex: state.weekIndex,
          proteinLast: state.proteinLast,
          techniqueLast: state.techniqueLast,
          spiceLast: state.spiceLast,
          cooldownHits: Number(state?.cooldownMap?.[best.key] || 0),
        },
        topCandidates: scored.sort((a, b) => b.score - a.score).slice(0, 8),
        selected: { technique, spiceProfile },
      },
    };

    results.push(picked);

    state = await advanceRotationState({
      householdId,
      cuisineKey,
      date: d,
      chosen: {
        dishKey: best.key,
        primaryProtein: best.primaryProtein,
        technique,
        spiceProfile,
        cooldownDays: catalogs?.profile?.defaults?.rotation?.cooldownDays || 7,
      },
    });
  }

  if (emitEvents) {
    try {
      eventBus?.emit?.("cuisine.rotation.advanced", {
        householdId,
        cuisineKey,
        results,
      });
      eventBus?.emit?.("mealplan.generated", {
        householdId,
        cuisineKey,
        mealType,
        results,
      });
    } catch {}
  }

  return {
    cuisineKey,
    householdId,
    prefs,
    results,
    catalogsMeta: { errors: catalogs.errors, warnings: catalogs.warnings },
  };
}
