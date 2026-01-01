// src/features/recipes/onRecipeImported.js
/**
 * Recipe Import Pipeline
 * ----------------------
 * Listens to: recipe.imported.normalized
 * Does:
 *  1) Tagging/classification kickoff  -> emits recipe.tagging.completed
 *  2) Inventory linking (ingredients) -> emits inventory.linked (per link)
 *  3) NBA nudges (Plan this week? Generate groceries? Make freezer portion?) -> via nudge service + emits decider.invoked
 *
 * Notes:
 * - All services are DI'd; defaults fall back to no-ops for safe runtime.
 * - Emits use central contracts/events (validates payloads).
 * - Tiny backoff + timeouts to avoid UI stalls.
 */

import { onEvent, emitEvent } from "@/contracts/events";

// -------------------------------
// Safe DI fallbacks (no-ops)
// -------------------------------
const defaultServices = {
  tagger: {
    // classify(recipe) -> { tags:[], classifiers:{course,cuisine,effort,...}, confidence:number, durationMs:number }
    classify: async () => ({ tags: [], classifiers: {}, confidence: 0.0, durationMs: 0 })
  },
  inventoryMapper: {
    // linkIngredients(recipe) -> [{ itemId, linkType, linkId, source? }, ...]
    linkIngredients: async () => []
  },
  vault: {
    // fetch minimal recipe snapshot if needed
    getRecipe: async (id) => ({ id })
  },
  nudge: {
    // push(cards[]) ; each card: { id, kind, title, body, cta:{label,action}, meta? }
    push: async () => {}
  },
  clock: () => new Date(),
  logger: {
    info: (...a) => console.info("[onRecipeImported]", ...a),
    warn: (...a) => console.warn("[onRecipeImported]", ...a),
    error: (...a) => console.error("[onRecipeImported]", ...a)
  }
};

// -------------------------------
// Small helpers (retry, timeout)
// -------------------------------
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(promise, ms, label = "op") {
  let to;
  const timeout = new Promise((_, rej) => {
    to = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    const res = await Promise.race([promise, timeout]);
    clearTimeout(to);
    return res;
  } finally {
    clearTimeout(to);
  }
}

async function withRetry(fn, { tries = 2, backoff = 250, label = "op" } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await delay(backoff * (i + 1));
    }
  }
  lastErr.message = `[${label}] ${lastErr.message}`;
  throw lastErr;
}

// -------------------------------
// NBA card builders
// -------------------------------
function buildNudges({ recipe, classifiers = {}, tags = [], sabbathNearby, sourceType }) {
  const cards = [];
  const idBase = recipe.id || `rec_${Math.random().toString(36).slice(2)}`;

  const effort = classifiers.effort || "moderate";
  const course = classifiers.course || "dinner";
  const cuisine = classifiers.cuisine || "mediterranean";
  const isFreezerFriendly = tags.includes("freezer-meal") || tags.includes("sauce-base") || tags.includes("stew-forward");
  const isNoCookFriendly = ["salad", "sandwich", "beverage", "dip", "dressing"].includes(course) || tags.includes("no-cook");

  // 1) Plan this week?
  cards.push({
    id: `${idBase}_plan`,
    kind: "plan-suggestion",
    title: "Plan this recipe for this week?",
    body: `Add ${recipe.title || "this recipe"} to your weekly plan. ${effort === "very-easy" || effort === "easy" ? "It’s a quick win." : ""}`,
    cta: {
      label: "Open Meal Planner",
      action: {
        type: "emit",
        name: "decider.invoked",
        payload: {
          requestId: `dec_${idBase}`,
          source: "vault",
          context: { suggest: { recipeId: recipe.id, course, cuisine, effort } },
          candidates: [{ id: recipe.id }]
        }
      }
    },
    meta: { sourceType }
  });

  // 2) Generate groceries
  cards.push({
    id: `${idBase}_groceries`,
    kind: "grocery-suggestion",
    title: "Need ingredients?",
    body: "We can add missing items to your next grocery list and suggest substitutions.",
    cta: {
      label: "Create Grocery Draft",
      action: {
        type: "emit",
        name: "grocerylist.requested",
        payload: { requestId: `req_gl_${idBase}`, options: { collapseDuplicates: true, allowSubstitutions: true } }
      }
    }
  });

  // 3) Batch-friendly anchor (freezer)
  if (isFreezerFriendly) {
    cards.push({
      id: `${idBase}_batch`,
      kind: "batch-suggestion",
      title: "Make extra for later?",
      body: "Batch once, eat twice. We’ll set aside portions and label them.",
      cta: {
        label: "Queue Batch Session",
        action: {
          type: "navigate",
          to: "/batch/planner",
          params: { recipeId: recipe.id, preset: "make-extra" }
        }
      }
    });
  }

  // 4) Sabbath guard tilt (no-cook / reheat)
  if (sabbathNearby && (isNoCookFriendly || isFreezerFriendly)) {
    cards.push({
      id: `${idBase}_sabbath`,
      kind: "sabbath-suggestion",
      title: "Sabbath is near — prefer no-cook?",
      body: isNoCookFriendly
        ? "This looks no-cook friendly; we can slot it for Friday."
        : "Make a freezer-friendly portion now for easy reheat on Friday.",
      cta: {
        label: isNoCookFriendly ? "Schedule Friday (No-Cook)" : "Make Freezer Portion",
        action: isNoCookFriendly
          ? {
              type: "emit",
              name: "mealplan.draft.requested",
              payload: { requestId: `req_plan_${idBase}`, days: 1, params: { targetDay: "Friday", preferNoCook: true } }
            }
          : {
              type: "navigate",
              to: "/batch/planner",
              params: { recipeId: recipe.id, preset: "freezer-portion" }
            }
      }
    });
  }

  return cards;
}

// -------------------------------
// Sabbath proximity (simple heuristic)
// -------------------------------
function isSabbathWithin({ clock }) {
  const now = clock();
  // Heuristic: if today is Thu or Fri, we consider it "near"
  const day = now.getDay(); // 0 Sun ... 5 Fri ... 6 Sat
  return day === 4 || day === 5;
}

// -------------------------------
// Main registration
// -------------------------------
/**
 * Register the onRecipeImported listeners.
 * @param {{
 *   services?: Partial<typeof defaultServices>,
 *   config?: { taggingTimeoutMs?:number, mapperTimeoutMs?:number, enableNudges?:boolean }
 * }} opts
 * @returns {() => void} disposer
 */
export function registerOnRecipeImported(opts = {}) {
  const services = { ...defaultServices, ...(opts.services || {}) };
  const config = {
    taggingTimeoutMs: 4000,
    mapperTimeoutMs: 3500,
    enableNudges: true,
    ...(opts.config || {})
  };
  const { logger } = services;

  // 1) When a recipe is normalized, kick off tagging and mapping in parallel.
  const off1 = onEvent("recipe.imported.normalized", async (payload) => {
    const { requestId, recipe, sourceType } = payload || {};
    if (!recipe?.id) return;

    logger.info("normalized → start tagging & mapping", { recipeId: recipe.id, sourceType });

    // Tagging
    const taggingPromise = withRetry(
      () =>
        withTimeout(
          services.tagger.classify(recipe),
          config.taggingTimeoutMs,
          "tagger.classify"
        ),
      { tries: 2, backoff: 250, label: "tagger" }
    );

    // Inventory mapping
    const mappingPromise = withRetry(
      () =>
        withTimeout(
          services.inventoryMapper.linkIngredients(recipe),
          config.mapperTimeoutMs,
          "inventoryMapper.linkIngredients"
        ),
      { tries: 2, backoff: 250, label: "inventoryMapper" }
    );

    let tagging = { tags: [], classifiers: {}, confidence: 0, durationMs: 0 };
    let links = [];

    try {
      [tagging, links] = await Promise.allSettled([taggingPromise, mappingPromise]).then((results) => {
        const t = results[0].status === "fulfilled" ? results[0].value : tagging;
        const l = results[1].status === "fulfilled" ? results[1].value : [];
        return [t, l];
      });
    } catch (e) {
      logger.warn("Parallel ops had errors", e);
    }

    // Emit recipe.tagging.completed
    try {
      emitEvent("recipe.tagging.completed", {
        recipeId: recipe.id,
        tags: tagging.tags || [],
        classifiers: tagging.classifiers || {},
        confidence: typeof tagging.confidence === "number" ? tagging.confidence : undefined,
        durationMs: typeof tagging.durationMs === "number" ? tagging.durationMs : undefined
      });
    } catch (e) {
      logger.error("emit recipe.tagging.completed failed", e);
    }

    // Emit inventory.linked (per link)
    if (Array.isArray(links)) {
      for (const link of links) {
        if (!link?.itemId || !link?.linkType || !link?.linkId) continue;
        try {
          emitEvent("inventory.linked", {
            itemId: link.itemId,
            linkType: link.linkType,
            linkId: link.linkId,
            source: link.source || "import"
          });
        } catch (e) {
          logger.warn("emit inventory.linked failed for", link, e);
        }
      }
    }

    // NBA nudges
    if (config.enableNudges) {
      const sabbathNearby = isSabbathWithin({ clock: services.clock });
      const cards = buildNudges({
        recipe,
        classifiers: tagging.classifiers || {},
        tags: tagging.tags || [],
        sabbathNearby,
        sourceType
      });

      try {
        await services.nudge.push(cards);
      } catch (e) {
        logger.warn("nudge.push failed", e);
      }
    }
  });

  // 2) If someone imports and *then* classifier runs out-of-band, still nudge.
  const off2 = onEvent("recipe.tagging.completed", async (payload) => {
    const { recipeId, tags = [], classifiers = {} } = payload || {};
    if (!recipeId) return;

    // fetch minimal title if we can
    let recipe = { id: recipeId };
    try {
      recipe = await withTimeout(services.vault.getRecipe(recipeId), 2000, "vault.getRecipe");
    } catch {}

    const sabbathNearby = isSabbathWithin({ clock: services.clock });
    const cards = buildNudges({ recipe, classifiers, tags, sabbathNearby, sourceType: "post-tagging" });

    try {
      await services.nudge.push(cards);
    } catch (e) {
      services.logger?.warn?.("nudge.push (post-tagging) failed", e);
    }
  });

  return () => {
    try { off1?.(); } catch {}
    try { off2?.(); } catch {}
  };
}

export default { registerOnRecipeImported };
