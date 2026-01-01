/**
 * File: src/layers/__tests__/layerAssets.test.js
 * Purpose: Load all catalogs/lexicons and validate schemas. Fails build if any asset breaks.
 *
 * Runner: Vitest recommended.
 * - If you use Jest, the syntax is similar; adjust imports accordingly.
 */

import { describe, it, expect } from "vitest";

import LayerAssetLoader from "../loaders/LayerAssetLoader.js";

async function getAjv() {
  try {
    const mod = await import("ajv");
    const Ajv = mod.default || mod.Ajv || mod;
    return Ajv;
  } catch (e) {
    throw new Error(
      "Missing dependency: ajv. Install it (npm i ajv) to enable schema validation tests."
    );
  }
}

describe("Layer assets", () => {
  it("loads all layer assets and validates JSON against schemas", async () => {
    const Ajv = await getAjv();
    const ajv = new Ajv({ allErrors: true, strict: false });

    const loader = new LayerAssetLoader({ devHotReload: false });
    const assets = await loader.ensureLoaded();

    // Schemas should be retrievable from loader; if your loader stores differently, adapt here.
    const lexSchema = assets?.schemas?.lexicon;
    const catSchema = assets?.schemas?.catalog;

    expect(lexSchema).toBeTruthy();
    expect(catSchema).toBeTruthy();

    const validateLex = ajv.compile(lexSchema);
    const validateCat = ajv.compile(catSchema);

    const lexicons = assets?.lexicons || {};
    const catalogs = assets?.catalogs || {};

    // Validate all lexicons
    for (const [name, lex] of Object.entries(lexicons)) {
      const ok = validateLex(lex);
      if (!ok) {
        const err = JSON.stringify(validateLex.errors, null, 2);
        throw new Error(`Lexicon schema invalid: ${name}\n${err}`);
      }
    }

    // Validate all catalog patterns + indexes
    for (const [key, cat] of Object.entries(catalogs)) {
      // catalogs may include indexes and patterns; validate if it looks like a catalog object
      const ok = validateCat(cat);
      if (!ok) {
        const err = JSON.stringify(validateCat.errors, null, 2);
        throw new Error(`Catalog schema invalid: ${key}\n${err}`);
      }
    }
  });
});
