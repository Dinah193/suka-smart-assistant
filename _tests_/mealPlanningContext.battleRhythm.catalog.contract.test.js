import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/store/PreferencesStore", () => ({
  usePreferencesStore: {
    getState: () => ({
      nutrition: {
        macroPatterns: [
          { id: "balanced", label: "Balanced", protein: 30, carbs: 40, fat: 30 },
        ],
        activeMacroPatternId: "balanced",
      },
      cooking: {
        battleRhythm: {
          enabled: true,
          substitutions: [
            {
              match: "butter",
              replaceWith: "ghee",
              ratio: 1,
              priority: 80,
            },
          ],
          seasoning: {
            saltFactor: 0.5,
            sugarFactor: 0.8,
          },
          timing: {
            weeknightTimeFactor: 0.5,
            weekendTimeFactor: 1,
            quickNightMaxMins: 45,
          },
        },
      },
      foodTargets: { calories: 2000, protein: 120, carbs: 220, fat: 70 },
    }),
  },
}));

vi.mock("@/services/catalogs/catalogRecipeLibrary.js", () => ({
  listCatalogRecipeCandidates: vi.fn(async () => [
    {
      id: "catalog.test.recipe",
      title: "Catalog Test Recipe",
      tags: ["catalog:test"],
      ingredients: [
        { name: "butter", qty: 20, unit: "g" },
        { name: "salt", qty: 4, unit: "g" },
      ],
      macros: null,
      source: "catalogLibrary",
      origin: "catalog",
      raw: {
        id: "catalog.test.recipe",
        title: "Catalog Test Recipe",
        ingredients: [
          { name: "butter", qty: 20, unit: "g" },
          { name: "salt", qty: 4, unit: "g" },
        ],
        time: { totalMins: 60 },
      },
    },
  ]),
}));

import { selectMealPlanningContext } from "../src/services/selectors/mealPlanningSelectors.js";

describe("mealPlanningSelectors battle rhythm + catalog contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes catalog recipes in recipePool and applies battle rhythm transforms", async () => {
    const ctx = await selectMealPlanningContext({
      input: {
        includeUserSavedRecipes: false,
        includeImportedWebRecipes: false,
        includeAppRecipeLibrary: false,
        includeCatalogRecipes: true,
        includeBattleRhythmPreview: true,
        battleRhythmPreviewSource: "catalog",
        battleRhythmPreviewLimit: 3,
      },
      runtime: {},
      startDay: "2026-03-10",
      endDay: "2026-03-10",
    });

    expect(ctx.recipeSources.counts.catalogLibrary).toBe(1);
    expect(ctx.recipeSources.counts.totalPool).toBe(1);

    const [recipe] = ctx.recipeSources.recipePool;
    expect(recipe).toBeTruthy();
    expect(recipe.source).toBe("catalog");
    expect(recipe.tags).toContain("battle-rhythm-applied");
    expect(recipe.battleRhythm.applied).toBe(true);

    const saltLine = recipe.ingredients.find((x) => String(x.name || x.label).toLowerCase().includes("salt"));
    expect(saltLine.qty).toBeCloseTo(2, 4);

    expect(ctx.battleRhythm.enabled).toBe(true);
    expect(ctx.battleRhythm.transformed).toBe(1);
    expect(ctx.battleRhythm.preview).toBeDefined();
    expect(ctx.battleRhythm.preview.enabled).toBe(true);
    expect(ctx.battleRhythm.preview.source).toBe("catalog");
    expect(Array.isArray(ctx.battleRhythm.preview.items)).toBe(true);
    expect(ctx.battleRhythm.preview.items.length).toBe(1);

    const preview = ctx.battleRhythm.preview.items[0];
    expect(preview.original).toBeDefined();
    expect(preview.variant).toBeDefined();
    expect(preview.trace).toBeDefined();
  });
});
