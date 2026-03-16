import { beforeEach, describe, expect, it, vi } from "vitest";

const { listCatalogRecipeCandidatesMock } = vi.hoisted(() => ({
  listCatalogRecipeCandidatesMock: vi.fn(),
}));

vi.mock("@/services/catalogs/catalogRecipeLibrary.js", () => ({
  listCatalogRecipeCandidates: listCatalogRecipeCandidatesMock,
}));

vi.mock("../src/services/catalogs/catalogRecipeLibrary.js", () => ({
  listCatalogRecipeCandidates: listCatalogRecipeCandidatesMock,
}));

describe("catalogResolver dictionary normalization contract", () => {
  beforeEach(() => {
    listCatalogRecipeCandidatesMock.mockReset();
  });

  it("normalizes ingredient aliases/units and preserves catalog metadata", async () => {
    listCatalogRecipeCandidatesMock.mockResolvedValueOnce([
      {
        id: "catalog.test.1",
        title: "Dictionary Test Recipe",
        tags: ["weeknight", "catalog:cuisines/italian"],
        ingredients: [
          { name: "All-Purpose Flour", qty: 2, unit: "tbsp" },
          { name: "butter", qty: 1, unit: "tbsp" },
        ],
        source: "catalogLibrary",
        catalogDomain: "cuisines",
        raw: {
          meta: { id: "cuisines.italian.dictionary.test" },
          instructions: ["Finely chop onion and simmer for 10 minutes."],
        },
      },
    ]);

    const mod = await import("../src/services/catalogs/catalogResolver.js");
    const out = await mod.listResolvedCatalogRecipes({
      domains: ["cuisines"],
      ids: ["catalog.test.1"],
      limit: 5,
    });

    expect(listCatalogRecipeCandidatesMock).toHaveBeenCalledTimes(1);

    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(1);

    const recipe = out[0];
    expect(recipe.source).toBe("catalog");
    expect(recipe.origin).toBe("catalog");
    expect(recipe.catalogDomain).toBe("cuisines");
    expect(recipe.catalogId).toBe("cuisines.italian.dictionary.test");
    expect(recipe.catalogTags).toContain("catalog:cuisines/italian");

    const flour = recipe.ingredients.find((x) => String(x.name).toLowerCase().includes("flour"));
    expect(flour.canonicalIngredientId).toBe("flour_wheat_ap");
    expect(flour.canonicalUnitId).toBe("vol_tbsp");
    expect(flour.normalizedName).toBe("all purpose flour");

    const butter = recipe.ingredients.find((x) => String(x.name).toLowerCase().includes("butter"));
    expect(butter.normalizedName).toBe("butter");
    expect(butter.canonicalUnitId).toBe("vol_tbsp");

    expect(recipe.tags).toContain("weeknight");
  });

  it("exposes shared dictionaries through facade", async () => {
    const mod = await import("../src/services/catalogs/catalogResolver.js");
    const dicts = await mod.getCatalogResolverDictionaries();

    expect(dicts.aliases["all purpose flour"]).toBe("flour_wheat_ap");
    expect(dicts.units.map.tbsp).toBe("vol_tbsp");
    expect(Array.isArray(dicts.techniques.techniques)).toBe(true);
    expect(dicts.techniques.techniques.length).toBeGreaterThan(0);
    expect(dicts.allergens.termMap.milk).toContain("allergen_milk");

    expect(Array.isArray(dicts.allergens.ingredientTriggers)).toBe(true);
    expect(
      dicts.allergens.ingredientTriggers.some(
        (x) => x?.allergenId === "allergen_milk" && Array.isArray(x.tokens) && x.tokens.includes("butter")
      )
    ).toBe(true);

    expect(
      dicts.techniques.techniques.some(
        (x) => x?.id === "heat_simmer" && Array.isArray(x.aliases) && x.aliases.includes("simmer")
      )
    ).toBe(true);
  });
});
