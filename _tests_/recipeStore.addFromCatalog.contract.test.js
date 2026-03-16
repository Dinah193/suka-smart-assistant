import { beforeAll, beforeEach, describe, expect, it } from "vitest";

function createLocalStorageMock() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
  };
}

async function loadStore() {
  if (!globalThis.localStorage) {
    globalThis.localStorage = createLocalStorageMock();
  }
  return import("../src/store/RecipeStore.js");
}

describe("RecipeStore addFromCatalog contract", () => {
  let storeMod;

  beforeAll(async () => {
    storeMod = await loadStore();
  });

  beforeEach(() => {
    storeMod.resetRecipes();
  });

  it("maps catalog metadata into origin/meta.catalog and tags", () => {
    const added = storeMod.addFromCatalog({
      id: "catalog.recipe.1",
      title: "Catalog Chicken Bowl",
      tags: ["weeknight"],
      catalogId: "catalog.recipe.1",
      catalogDomain: "cuisines",
      catalogTags: ["catalog:cuisines/mediterranean"],
      sourceUrl: "https://example.test/recipe/1",
      ingredients: [{ name: "chicken thighs", qty: 1, unit: "lb" }],
      macros: { protein: 40, carbs: 30, fat: 20 },
      raw: {
        meta: { id: "raw.catalog.recipe.1", name: "Raw Catalog Name" },
      },
    });

    expect(added).toBeTruthy();
    expect(added.id).toBe("catalog.recipe.1");
    expect(added.name).toBe("Catalog Chicken Bowl");
    expect(added.origin).toBe("catalog");
    expect(added.tags).toContain("catalog-import");
    expect(added.tags).toContain("weeknight");
    expect(added.meta.catalog.catalogId).toBe("catalog.recipe.1");
    expect(added.meta.catalog.catalogDomain).toBe("cuisines");
    expect(added.meta.catalog.catalogTags).toContain("catalog:cuisines/mediterranean");
    expect(added.sourceUrl).toBe("https://example.test/recipe/1");
    expect(added.nutrition.protein).toBe(40);

    const all = storeMod.getRecipes();
    expect(all.length).toBe(1);
    expect(all[0].meta.catalog.catalogId).toBe("catalog.recipe.1");
  });

  it("falls back metadata from raw recipe and upserts by id", () => {
    storeMod.addFromCatalog({
      id: "catalog.recipe.2",
      title: "First Title",
      tags: ["batch"],
      raw: {
        id: "raw-id-2",
        meta: { id: "raw-meta-id-2" },
        ingredients: [{ name: "salt", qty: 2, unit: "g" }],
      },
    });

    storeMod.addFromCatalog({
      id: "catalog.recipe.2",
      title: "Updated Title",
      tags: ["quick"],
      raw: {
        id: "raw-id-2",
        meta: { id: "raw-meta-id-2" },
        ingredients: [{ name: "pepper", qty: 1, unit: "g" }],
      },
    });

    const all = storeMod.getRecipes();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe("catalog.recipe.2");
    expect(all[0].name).toBe("Updated Title");
    expect(all[0].origin).toBe("catalog");
    expect(all[0].meta.catalog.catalogId).toBe("raw-meta-id-2");
    expect(all[0].meta.catalog.catalogDomain).toBe(null);
    expect(Array.isArray(all[0].meta.catalog.catalogTags)).toBe(true);
  });
});
