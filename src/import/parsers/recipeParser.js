// C:\Users\larho\suka-smart-assistant\src\import\parsers\recipeParser.js
// Parses recipe websites and schema.org recipes (shim + normalizeMany friendly)
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// ImportService.importPayload(...) → ImportRouter.routeImport(...) →
//   **recipeParser.parse(...)** → ImportNormalizer.normalizeImport("recipe", ...) →
//   automation.runtime → (optional) Hub
//
// WHAT THIS PARSER DOES
// - Accepts either:
//    1. a URL to a recipe page
//    2. an HTML string that contains a <script type="application/ld+json"> with "@type": "Recipe"
//    3. a JSON object from a bookmarklet/share that already has schema.org-style fields
//
// - Produces a canonical shape for the normalizer / session engines:
//
//   {
//     type: "recipeImport",
//     domain: "recipe",
//     title: "Best Banana Bread",
//     sourceUrl: "https://...",
//     ingredients: [{ name: "2 cups flour" }, ...],
//     steps: [{ text: "Preheat oven to 350°F" }, ...],
//     yields: "12 slices",
//     time: { prep: "PT15M", cook: "PT45M", total: "PT1H" },
//     cuisine: "American",
//     tags: ["dessert", "banana"],
//     images: ["https://..."],
//     nutrition: { ...schema.org NutritionInformation... }
//   }
//
// - Events: emits "import.parsed.raw" via eventBus, safe to run in a worker/shim.
// -----------------------------------------------------------------------------
//
// SHIM / BACKGROUND FRIENDLY
// - No direct DOM access; works on strings/JSON only.
// - Can be run from a Web Worker or background task.
// - `parseMany` helper wraps single-result parse into an array for normalizeMany.js.
//
// IMPORTANT
// - This parser only SHAPES data; it does NOT update inventory/storehouse itself.
//   Hub export happens later (after normalization / domain engines).
// -----------------------------------------------------------------------------

import eventBus from "../../services/events/eventBus";
import scraperService from "../../services/scraperService.js";

// recognized recipe-ish types
const RECIPE_TYPES = [
  "Recipe",
  "schema:Recipe",
  "FoodRecipe",
  "HowTo",
  "HowToStep",
  "HowToSection",
];

/**
 * Emit a parser-level diagnostic event to the SSA event bus.
 * Payload shape matches SSA runtimeHints.payloadShape.
 *
 * @param {boolean} success
 * @param {object} detail
 */
function emitParserEvent(success, detail = {}) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") {
      // Soft fail in worker-like contexts or tests
      return;
    }
    const type = "import.parsed.raw";
    eventBus.emit(type, {
      type,
      ts: new Date().toISOString(),
      source: "import.parser.recipe",
      data: {
        success,
        ...detail,
      },
    });
  } catch (err) {
    // Never crash the import pipeline due to logging
    // eslint-disable-next-line no-console
    console.warn("[recipeParser] emitParserEvent failed:", err?.message || err);
  }
}

// -----------------------------------------------------------------------------
// 1. Get HTML from input (URL or raw HTML)
// -----------------------------------------------------------------------------
/**
 * Resolve raw into an HTML string, if possible.
 * Supports:
 *  - raw as HTML string
 *  - raw as URL string
 *  - raw as { html: "<html>..." }
 *
 * @param {any} raw
 * @returns {Promise<string|null>}
 */
async function getHtmlFromRaw(raw) {
  // 1) clearly HTML string
  if (
    typeof raw === "string" &&
    /<\/html>|<head>|<body>|<script[\s>]/i.test(raw)
  ) {
    return raw;
  }

  // 2) URL → fetch via scraperService
  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
    try {
      const html = await scraperService.fetchHtml(raw);
      return html;
    } catch (err) {
      console.warn(
        "[recipeParser] scraperService.fetchHtml failed:",
        err?.message || err
      );
      return null;
    }
  }

  // 3) object with html
  if (raw && typeof raw === "object" && typeof raw.html === "string") {
    return raw.html;
  }

  return null;
}

// -----------------------------------------------------------------------------
// 2. Try to parse JSON-LD from HTML
// -----------------------------------------------------------------------------
/**
 * Extract all JSON-LD blocks from a chunk of HTML.
 *
 * @param {string} html
 * @returns {any[]}
 */
function extractJsonLd(html) {
  if (!html) return [];
  const scripts = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const jsonText = match[1].trim();
    if (!jsonText) continue;
    try {
      const parsed = JSON.parse(jsonText);
      scripts.push(parsed);
    } catch {
      // ignore individual JSON errors, keep going
    }
  }
  return scripts;
}

// -----------------------------------------------------------------------------
// 3. Find the recipe object inside the parsed JSON-LD structures
// -----------------------------------------------------------------------------
/**
 * Walk JSON-LD structures to find a recipe-like node.
 *
 * @param {any[]} ldArray
 * @returns {object|null}
 */
function findRecipeObjectFromJsonLd(ldArray) {
  if (!Array.isArray(ldArray) || ldArray.length === 0) return null;

  for (const item of ldArray) {
    if (!item) continue;

    // @graph container
    if (Array.isArray(item["@graph"])) {
      for (const node of item["@graph"]) {
        if (node && RECIPE_TYPES.includes(node["@type"])) {
          return node;
        }
      }
    }

    // direct
    if (item && RECIPE_TYPES.includes(item["@type"])) {
      return item;
    }

    // array-of-things at top level
    if (Array.isArray(item)) {
      for (const node of item) {
        if (node && RECIPE_TYPES.includes(node["@type"])) {
          return node;
        }
      }
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// 4. Extract fields from a schema.org Recipe object
// -----------------------------------------------------------------------------
/**
 * Normalize a schema.org-style Recipe object into SSA's canonical recipeImport.
 *
 * @param {object} recipe
 * @param {string|null} sourceUrl
 * @returns {object|null}
 */
function normalizeJsonLdRecipe(recipe, sourceUrl) {
  if (!recipe || typeof recipe !== "object") return null;

  // ingredients
  let ingredients = [];
  if (Array.isArray(recipe.recipeIngredient)) {
    ingredients = recipe.recipeIngredient.map((i) => ({ name: i }));
  } else if (Array.isArray(recipe.ingredients)) {
    ingredients = recipe.ingredients.map((i) => ({ name: i }));
  }

  // instructions
  let steps = [];
  if (Array.isArray(recipe.recipeInstructions)) {
    steps = recipe.recipeInstructions
      .map((step, index) => {
        if (typeof step === "string") {
          return { text: step, index };
        }
        if (step && typeof step.text === "string") {
          return { text: step.text, index };
        }
        if (step && step["@type"] === "HowToStep" && step.name) {
          return { text: step.name, index };
        }
        return null;
      })
      .filter(Boolean);
  } else if (typeof recipe.recipeInstructions === "string") {
    steps = recipe.recipeInstructions
      .split(/\r?\n/)
      .map((l, index) => ({ text: l.trim(), index }))
      .filter((x) => x.text);
  }

  // tags / keywords
  const tags = Array.isArray(recipe.keywords)
    ? recipe.keywords
    : typeof recipe.keywords === "string"
    ? recipe.keywords
        .split(/[,;]/)
        .map((k) => k.trim())
        .filter(Boolean)
    : [];

  const images = Array.isArray(recipe.image)
    ? recipe.image
    : recipe.image
    ? [recipe.image]
    : [];

  return {
    type: "recipeImport",
    domain: "recipe",
    title: recipe.name || recipe.headline || "Imported recipe",
    sourceUrl: recipe.url || sourceUrl || null,
    ingredients,
    steps,
    yields: recipe.recipeYield || null,
    time: {
      prep: recipe.prepTime || null,
      cook: recipe.cookTime || null,
      total: recipe.totalTime || null,
    },
    cuisine: recipe.recipeCuisine || null,
    tags,
    images,
    nutrition: recipe.nutrition || null,
  };
}

// -----------------------------------------------------------------------------
// 5. Fallback HTML scrapers (very light) for pages without schema.org
// -----------------------------------------------------------------------------
/**
 * Quick-and-dirty HTML scraper for sites without JSON-LD.
 *
 * @param {string} html
 * @param {string|null} sourceUrl
 * @returns {object|null}
 */
function fallbackScrape(html, sourceUrl) {
  if (!html) return null;

  // title
  let title = "Imported recipe";
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // ingredients: look for <li class="ingredient"> or similar
  const ingredients = [];
  const ingredientRe =
    /<li[^>]+class=["'][^"']*(ingredient|ingredients|recipe-ingredient)[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let im;
  while ((im = ingredientRe.exec(html)) !== null) {
    const txt = im[2].replace(/<[^>]+>/g, "").trim();
    if (txt) ingredients.push({ name: txt });
  }

  // instructions: look for <li class="instruction"> or steps
  const steps = [];
  const stepRe =
    /<li[^>]+class=["'][^"']*(instruction|direction|step)[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let sm;
  let idx = 0;
  while ((sm = stepRe.exec(html)) !== null) {
    const txt = sm[2].replace(/<[^>]+>/g, "").trim();
    if (txt) {
      steps.push({ text: txt, index: idx++ });
    }
  }

  return {
    type: "recipeImport",
    domain: "recipe",
    title,
    sourceUrl: sourceUrl || null,
    ingredients,
    steps,
    yields: null,
    time: {
      prep: null,
      cook: null,
      total: null,
    },
    cuisine: null,
    tags: [],
    images: [],
    nutrition: null,
  };
}

// -----------------------------------------------------------------------------
// 6. MAIN PARSE FUNCTION (single result)
// -----------------------------------------------------------------------------
/**
 * Parse a recipe import into a single canonical recipeImport object.
 *
 * normalizeMany-compatible:
 *  - recipeParser.parse(raw, meta)    → one recipeImport object
 *  - recipeParser.parseMany(raw,meta) → [recipeImport]
 *
 * @param {any} raw
 * @param {object} [meta]
 * @returns {Promise<object>} recipeImport
 */
async function parse(raw, meta = {}) {
  const sourceUrl =
    (typeof raw === "string" && /^https?:\/\//i.test(raw) && raw) ||
    meta.url ||
    meta.sourceUrl ||
    null;

  // CASE 1: already a JSON object like schema.org from a bookmarklet/share
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw["@type"] === "Recipe" || raw.recipeIngredient)
  ) {
    const fromJson = normalizeJsonLdRecipe(raw, sourceUrl);
    emitParserEvent(true, {
      domain: "recipe",
      via: "direct-json",
      title: fromJson?.title,
      sourceUrl,
    });
    return (
      fromJson || {
        type: "recipeImport",
        domain: "recipe",
        title: "Imported recipe",
        sourceUrl,
        ingredients: [],
        steps: [],
        yields: null,
        time: { prep: null, cook: null, total: null },
        cuisine: null,
        tags: [],
        images: [],
        nutrition: null,
      }
    );
  }

  // CASE 2: raw is a URL or HTML → get HTML
  const html = await getHtmlFromRaw(raw);

  if (html) {
    // Try JSON-LD first
    const ldBlocks = extractJsonLd(html);
    const recipeObj = findRecipeObjectFromJsonLd(ldBlocks);
    if (recipeObj) {
      const normalized = normalizeJsonLdRecipe(recipeObj, sourceUrl);
      if (normalized) {
        emitParserEvent(true, {
          domain: "recipe",
          via: "json-ld",
          title: normalized.title,
          sourceUrl,
        });
        return normalized;
      }
    }

    // Fallback scrape if no JSON-LD recipe found
    const fallback = fallbackScrape(html, sourceUrl);
    if (fallback) {
      emitParserEvent(true, {
        domain: "recipe",
        via: "fallback-html",
        title: fallback.title,
        sourceUrl,
      });
      return fallback;
    }
  }

  // CASE 3: nothing worked (also covers non-HTML/non-JSON cases)
  emitParserEvent(false, {
    domain: "recipe",
    via: "unknown",
    error: "Could not parse recipe from provided input.",
    preview: typeof raw === "string" ? raw.slice(0, 160) : "[non-string]",
  });

  return {
    type: "recipeImport",
    domain: "recipe",
    title: "Unknown recipe",
    sourceUrl,
    ingredients: [],
    steps: [],
    yields: null,
    time: { prep: null, cook: null, total: null },
    cuisine: null,
    tags: [],
    images: [],
    nutrition: null,
    warning:
      "Parser could not identify a schema.org or HTML recipe structure — returned empty structure.",
  };
}

// -----------------------------------------------------------------------------
// 7. parseMany — helper for normalizeMany.js workflows
// -----------------------------------------------------------------------------
/**
 * Wraps `parse` into an array-based interface for normalizeMany-style helpers.
 *
 * @param {any} raw
 * @param {object} [meta]
 * @returns {Promise<object[]>}
 */
async function parseMany(raw, meta = {}) {
  const result = await parse(raw, meta);
  if (Array.isArray(result)) return result;
  if (!result) return [];
  return [result];
}

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------
const recipeParser = {
  parse,
  parseMany,
  // Expose internals for testing/debug if needed:
  __extractJsonLd: extractJsonLd,
  __findRecipeObjectFromJsonLd: findRecipeObjectFromJsonLd,
  __normalizeJsonLdRecipe: normalizeJsonLdRecipe,
};

export default recipeParser;
