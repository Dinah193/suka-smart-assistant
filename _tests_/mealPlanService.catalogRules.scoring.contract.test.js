import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

function baseOpts(overrides = {}) {
  return {
    inventory: { items: [] },
    preferTags: [],
    avoidTags: [],
    diet: { keto: false, vegetarian: false, hairGrowthFocus: false },
    macrosTarget: { kcal: 600, protein: 30, fat: 20, carbs: 40 },
    season: null,
    pantryFirst: false,
    budgetPerDayUSD: null,
    catalogPreferences: {
      enableCatalogBoosts: true,
      sourceBoost: 1,
      preferredDomains: [],
      preferredCatalogIds: [],
      cuisineAffinity: [],
    },
    catalogRuleSignals: {
      recipeSourceDomains: [],
      ruleSourceDomains: [],
      hasEstimatorRules: false,
      hasSeasonalityRules: false,
      hasCuisineRules: false,
    },
    ...overrides,
  };
}

function runScore(recipe, opts) {
  const servicePath = path
    .resolve(__dirname, "../src/server/services/mealPlanService.js")
    .replace(/\\/g, "/");

  const script = `
    const recipe = ${JSON.stringify(recipe)};
    const opts = ${JSON.stringify(opts)};
    import('file:///${servicePath}').then(async (mod) => {
      const fn = mod.scoreRecipe || mod.default?.scoreRecipe;
      if (typeof fn !== 'function') {
        console.error('missing_scoreRecipe_export');
        process.exit(2);
      }
      const score = await fn(recipe, {
        ...opts,
        catalogRuleSignals: {
          ...opts.catalogRuleSignals,
          recipeSourceDomains: new Set(Array.isArray(opts.catalogRuleSignals?.recipeSourceDomains) ? opts.catalogRuleSignals.recipeSourceDomains : []),
          ruleSourceDomains: new Set(Array.isArray(opts.catalogRuleSignals?.ruleSourceDomains) ? opts.catalogRuleSignals.ruleSourceDomains : []),
        },
      });
      process.stdout.write(String(score));
    }).catch((e) => {
      console.error(String(e?.stack || e));
      process.exit(1);
    });
  `;

  const out = spawnSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
  });

  if (out.status !== 0) {
    throw new Error(`score_subprocess_failed:${out.stderr || out.stdout || out.status}`);
  }

  return Number(out.stdout.trim());
}

describe("mealPlanService catalog rule-source scoring contract", () => {
  it("penalizes allergen conflicts using shared allergen dictionaries", async () => {
    const recipe = {
      id: "r-allergen",
      tags: ["catalog:soups"],
      ingredients: [{ name: "butter", qty: 1, unit: "tbsp" }],
      nutrition: { kcal: 550, protein: 25, fat: 30, carbs: 20 },
      servings: 2,
    };

    const withoutAvoid = runScore(
      recipe,
      baseOpts({ avoidTags: [] }),
    );

    const withAvoid = runScore(
      recipe,
      baseOpts({ avoidTags: ["allergen:allergen_milk"] }),
    );

    expect(withAvoid).toBeLessThan(withoutAvoid);
  });

  it("increases seasonal and recipe-domain boosts when rule sources are enabled", async () => {
    const recipe = {
      id: "r-season-soup",
      source: "catalog",
      catalogDomain: "soups",
      tags: ["soup", "catalog:soups"],
      ingredients: [{ name: "lentils", qty: 200, unit: "g" }],
      nutrition: { kcal: 580, protein: 28, fat: 18, carbs: 60 },
      servings: 4,
    };

    const weakRules = runScore(
      recipe,
      baseOpts({
        season: "Fall",
        catalogRuleSignals: {
          recipeSourceDomains: [],
          ruleSourceDomains: [],
          hasEstimatorRules: false,
          hasSeasonalityRules: false,
          hasCuisineRules: false,
        },
      }),
    );

    const strongRules = runScore(
      recipe,
      baseOpts({
        season: "Fall",
        catalogRuleSignals: {
          recipeSourceDomains: ["soups"],
          ruleSourceDomains: ["farm-to-table", "homestead"],
          hasEstimatorRules: false,
          hasSeasonalityRules: true,
          hasCuisineRules: false,
        },
      }),
    );

    expect(strongRules).toBeGreaterThan(weakRules);
  });
});
