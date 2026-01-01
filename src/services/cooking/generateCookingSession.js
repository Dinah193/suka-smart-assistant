// src/services/cooking/generateCookingSession.js
// ============================================================================
// Cooking Session Generator
// ----------------------------------------------------------------------------
// Purpose:
//   Turn the user's current Meal Plan + Recipe Packs (and fallbacks like
//   favorites / recent recipes) into a *single* runnable Cooking Session
//   object that matches the SessionRunner contract.
//
// How this fits:
//   - Called from the Cooking page “Generate Session / Now” CTA **or**
//     from automation/event handlers listening to `mealplan.draft.requested`.
//   - Returns a rich Session object with normalized steps that SessionRunner
//     can immediately execute.
//   - Never fails silently: if no recipes are available, it returns an
//     explicit EMPTY result with guidance instead of `null`.
//
// Integration notes:
//   - This file is intentionally *data-source agnostic*.
//   - Wire it to your real stores by passing `deps` (see `getDataSources`).
//   - It’s safe to call even before MealPlan/Recipe features are complete;
//     in that case it will return an EMPTY result instead of throwing.
// ============================================================================

/**
 * @typedef {Object} GenerateCookingSessionOptions
 * @property {string|Date} windowStart   - Inclusive start of the cooking window.
 * @property {string|Date} windowEnd     - Inclusive end of the cooking window.
 * @property {string} [title]            - Session title; defaults to "Cooking Session".
 * @property {string} [preset]           - User-selected preset (e.g. "Balanced").
 * @property {string[]} [selectedPackIds]- Recipe Pack IDs to prioritize.
 * @property {string[]} [tags]           - Preferred tags (Breakfast, Dinner, etc.).
 * @property {Object} [constraints]      - Dietary/household constraints.
 * @property {Object} [finishes]         - Finish preferences (doneness, crispness, etc.).
 * @property {Object} [packsAndRhythm]   - Pack count / rhythm hints.
 */

/**
 * @typedef {Object} GenerateCookingSessionDeps
 * @property {function({windowStart: string, windowEnd: string}): Promise<Array<Object>>} [getMealPlanRecipesBetween]
 *   Async function that returns recipes for the given date window from the Meal Plan.
 * @property {function(string[]): Promise<Array<Object>>} [getRecipesForPacks]
 *   Async function that returns recipes belonging to the given Recipe Pack IDs.
 * @property {function(): Promise<Array<Object>>} [getFavoriteRecipes]
 *   Async function that returns user-pinned favorite recipes.
 * @property {function({limit?: number}): Promise<Array<Object>>} [getRecentRecipes]
 *   Async function that returns recently-cooked or recently-viewed recipes.
 */

/**
 * @typedef {Object} GenerateCookingSessionResult
 * @property {"ok"|"empty"|"error"} status
 * @property {Object} [session]                  - Present when status === "ok".
 * @property {string} [reason]                   - Machine-friendly reason when not "ok".
 * @property {string} [message]                  - Human-friendly message.
 * @property {Array<{type: "route"|"action", label: string, to?: string, actionId?: string}>} [suggestions]
 *   Suggested next actions to help the user get to a runnable state.
 */

/**
 * Generate a Cooking Session object ready for SessionRunner.
 *
 * @param {GenerateCookingSessionOptions} options
 * @param {GenerateCookingSessionDeps} [deps]
 * @returns {Promise<GenerateCookingSessionResult>}
 */
export async function generateCookingSession(options = {}, deps = {}) {
  // ---------------------------- Defensive checks -----------------------------

  const now = new Date();
  const windowStartISO = normalizeDateToISO(options.windowStart || now);
  const windowEndISO = normalizeDateToISO(options.windowEnd || now);
  const title =
    options.title && String(options.title).trim().length
      ? String(options.title).trim()
      : "Cooking Session";

  // Merge data sources (real deps from caller or safe stubs)
  const sources = getDataSources(deps);

  // ---------------------- 1) Collect candidate recipes ----------------------

  /** @type {Object[]} */
  let candidates = [];

  try {
    // 1a) Meal Plan window (highest priority)
    const mealPlanRecipes = await sources.getMealPlanRecipesBetween({
      windowStart: windowStartISO,
      windowEnd: windowEndISO,
    });

    if (Array.isArray(mealPlanRecipes) && mealPlanRecipes.length) {
      candidates.push(...mealPlanRecipes);
    }

    // 1b) Recipe Packs (next priority)
    if (
      Array.isArray(options.selectedPackIds) &&
      options.selectedPackIds.length
    ) {
      const packRecipes = await sources.getRecipesForPacks(
        options.selectedPackIds
      );
      if (Array.isArray(packRecipes) && packRecipes.length) {
        candidates.push(...packRecipes);
      }
    }

    // 1c) Fallback: favorites + recent, if we still have nothing
    if (!candidates.length) {
      const [favorites, recent] = await Promise.all([
        sources.getFavoriteRecipes(),
        sources.getRecentRecipes({ limit: 20 }),
      ]);

      if (Array.isArray(favorites) && favorites.length) {
        candidates.push(...favorites);
      }
      if (Array.isArray(recent) && recent.length) {
        candidates.push(...recent);
      }
    }
  } catch (err) {
    console.error("[Cooking] generateCookingSession data-source error", err);
    return {
      status: "error",
      reason: "DATA_SOURCE_ERROR",
      message:
        "Something went wrong while reading your meal plan and recipes. Please try again or open the Meal Planner.",
      suggestions: [
        { type: "route", label: "Open Meal Planner", to: "/meal-planner" },
        { type: "route", label: "Open Recipe Vault", to: "/recipes" },
      ],
    };
  }

  // De-dupe by recipe.id if available
  candidates = dedupeRecipes(candidates);

  // --------------------- 2) Handle empty / no recipes -----------------------

  if (!candidates.length) {
    console.warn(
      "[Cooking] generateCookingSession → no recipes found for window",
      windowStartISO,
      windowEndISO
    );

    return {
      status: "empty",
      reason: "NO_RECIPES_AVAILABLE",
      message:
        "I couldn't find any recipes for this window yet. Start by adding a Meal Plan, selecting Recipe Packs, or saving a few favorites.",
      suggestions: [
        { type: "route", label: "Open Meal Planner", to: "/meal-planner" },
        { type: "route", label: "Open Recipe Vault", to: "/recipes" },
        { type: "route", label: "Scan a recipe", to: "/recipes/scan" },
      ],
    };
  }

  // Optionally: filter by tags / constraints here if you want
  const filtered = applyFilters(candidates, {
    tags: options.tags,
    constraints: options.constraints,
  });

  if (!filtered.length) {
    return {
      status: "empty",
      reason: "FILTERS_TOO_STRICT",
      message:
        "Your current tags or constraints are too strict for the available recipes. Try loosening them or expanding your Meal Plan.",
      suggestions: [
        { type: "route", label: "Adjust Cooking Filters", to: "/cooking" },
        { type: "route", label: "Open Meal Planner", to: "/meal-planner" },
      ],
    };
  }

  // ---------------------- 3) Build Session object ---------------------------

  const createdAtISO = new Date().toISOString();

  const steps = filtered.map((recipe, index) =>
    normalizeRecipeToStep(recipe, index)
  );

  const session = {
    id: buildSessionId("cooking", createdAtISO),
    domain: "cooking",
    title,
    source: {
      type: inferPrimarySourceType(candidates),
      refId: inferPrimarySourceRefId(candidates),
    },
    steps,
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false,
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: {
      skippedSteps: [],
      adjustments: [],
    },
    createdAt: createdAtISO,
    updatedAt: createdAtISO,

    // Helpful context for SessionRunner / UI (non-contract but useful)
    windowStart: windowStartISO,
    windowEnd: windowEndISO,
    preset: options.preset || null,
  };

  return {
    status: "ok",
    session,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize a Date or date-like value to an ISO string.
 * Falls back to "now" if the value is invalid.
 *
 * @param {string|Date|undefined|null} value
 * @returns {string}
 */
function normalizeDateToISO(value) {
  if (!value) return new Date().toISOString();

  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  console.warn(
    "[Cooking] Invalid date passed to generateCookingSession:",
    value
  );
  return new Date().toISOString();
}

/**
 * Build a predictable session id.
 *
 * @param {string} domain
 * @param {string} createdAtISO
 * @returns {string}
 */
function buildSessionId(domain, createdAtISO) {
  return `${domain}-${createdAtISO}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * De-duplicate recipes by `id` when present.
 *
 * @param {Object[]} recipes
 * @returns {Object[]}
 */
function dedupeRecipes(recipes) {
  const seen = new Set();
  const result = [];

  for (const r of recipes) {
    const key = r && r.id ? String(r.id) : null;
    if (!key) {
      result.push(r);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }

  return result;
}

/**
 * Apply tag / constraint filtering to candidate recipes.
 *
 * @param {Object[]} recipes
 * @param {{tags?: string[], constraints?: Object}} filters
 * @returns {Object[]}
 */
function applyFilters(recipes, filters) {
  const { tags, constraints } = filters || {};
  let output = recipes;

  if (Array.isArray(tags) && tags.length) {
    const lowered = tags.map((t) => String(t).toLowerCase());
    output = output.filter((r) => {
      const rt = (r.tags || []).map((t) => String(t).toLowerCase());
      return lowered.some((t) => rt.includes(t));
    });
  }

  // Example constraint handling; extend as needed
  if (
    constraints &&
    constraints.dietary &&
    Array.isArray(constraints.dietary)
  ) {
    const blocked = constraints.dietary.map((c) => String(c).toLowerCase());

    output = output.filter((r) => {
      const rd = (r.dietaryFlags || []).map((c) => String(c).toLowerCase());
      return !blocked.some((flag) => rd.includes(flag));
    });
  }

  return output;
}

/**
 * Normalize a recipe-like object into a Session step.
 *
 * This is intentionally defensive: if fields are missing, we provide
 * reasonable defaults so the SessionRunner never crashes.
 *
 * @param {Object} recipe
 * @param {number} index
 * @returns {Object}
 */
function normalizeRecipeToStep(recipe, index) {
  const id = recipe?.id ? String(recipe.id) : `step-${index}`;
  const title = recipe?.title || recipe?.name || `Step ${index + 1}`;

  const desc =
    recipe?.shortDescription ||
    (Array.isArray(recipe?.steps)
      ? recipe.steps.join("\n")
      : recipe?.instructions || "");

  const durationSec = inferDurationSec(recipe);

  // Basic metadata, extend as your schema grows
  const tempTargetF = recipe?.targetTempF || recipe?.ovenTempF || null;

  const cue = recipe?.donenessCue || "timer";

  return {
    id,
    title,
    desc,
    durationSec,
    blockers: inferBlockersForRecipe(recipe),
    metadata: {
      tempTargetF: typeof tempTargetF === "number" ? tempTargetF : 0,
      donenessCue: cue,
      cueNotes: recipe?.donenessNotes || "",
    },
  };
}

/**
 * Infer duration in seconds from typical recipe fields.
 *
 * @param {Object} recipe
 * @returns {number}
 */
function inferDurationSec(recipe) {
  const minutes =
    recipe?.totalTimeMinutes ??
    recipe?.cookTimeMinutes ??
    recipe?.timeMinutes ??
    0;

  const parsed = Number(minutes);
  if (!isNaN(parsed) && parsed > 0) {
    return parsed * 60;
  }

  // Safe default: 15 minutes if nothing is specified
  return 15 * 60;
}

/**
 * Infer blockers (inventory, weather, quiet hours, etc.) from the recipe.
 * For now this is very conservative; extend as guards come online.
 *
 * @param {Object} recipe
 * @returns {Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment">}
 */
function inferBlockersForRecipe(recipe) {
  const blockers = [];

  if (recipe?.requiresOutdoorGrill || recipe?.isOutdoor) {
    blockers.push("weather");
  }
  if (recipe?.requiresSpecialEquipment) {
    blockers.push("equipment");
  }
  if (recipe?.isFryerHeavy || recipe?.isNoisy) {
    blockers.push("quietHours");
  }
  // Inventory and sabbath are better enforced by global guards,
  // but we include them if the recipe explicitly flags them:
  if (recipe?.requiresRareIngredients) {
    blockers.push("inventory");
  }
  if (recipe?.avoidOnSabbath) {
    blockers.push("sabbath");
  }

  return blockers;
}

/**
 * Guess the primary source type based on where recipes came from.
 *
 * @param {Object[]} candidates
 * @returns {"recipe"|"cleaningPlan"|"gardenPlan"|"animalTask"|"import"|"manual"}
 */
function inferPrimarySourceType(candidates) {
  // For now, all cooking sessions are built from recipes.
  // If you later support "cooking plans" as a separate entity, update this.
  if (!candidates || !candidates.length) return "manual";
  return "recipe";
}

/**
 * Guess a primary reference id for analytics (e.g., a Meal Plan id or Pack id).
 * For now we just use the first recipe's id if available.
 *
 * @param {Object[]} candidates
 * @returns {string|null}
 */
function inferPrimarySourceRefId(candidates) {
  if (!candidates || !candidates.length) return null;
  const first = candidates[0];
  return first && first.id ? String(first.id) : null;
}

/**
 * Resolve data-source helpers, falling back to stubs that return empty arrays.
 * This keeps the generator safe even before real stores are wired up.
 *
 * @param {GenerateCookingSessionDeps} deps
 */
function getDataSources(deps) {
  const noopRecipes = async () => {
    // You can remove this log once your real data sources are wired.
    console.debug(
      "[Cooking] generateCookingSession using stub data-source; wire your MealPlan/Recipe stores via deps."
    );
    return [];
  };

  return {
    getMealPlanRecipesBetween: deps.getMealPlanRecipesBetween || noopRecipes,
    getRecipesForPacks: deps.getRecipesForPacks || (async () => []),
    getFavoriteRecipes: deps.getFavoriteRecipes || (async () => []),
    getRecentRecipes: deps.getRecentRecipes || (async () => []),
  };
}

export default generateCookingSession;
