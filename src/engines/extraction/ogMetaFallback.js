/* recipeSchemaOrgExtractor.js
   Parse schema.org/Recipe from JSON-LD (and microdata when HTML is provided).
   Defensive & zero-crash: optional cheerio, resilient JSON-LD parsing, robust normalization.

   Exported API:
   - extractFromHtml(html, { url }) -> { recipe, warnings, sources }
   - extractFromJsonLd(jsonOrArray, { url }) -> { recipe, warnings, sources }
   - extract(source, opts) -> auto-detects html vs json/objects

   Notes:
   - Designed to integrate with Suka's Meals pipeline.
   - Produces normalized shape aligned with RecipeCard/Planner needs.
*/

/* ----------------------- Optional dependency (cheerio) ---------------------- */
let cheerio = null;
try {
  // If cheerio is present, we'll parse microdata & easily collect JSON-LD scripts
  cheerio = require("cheerio");
} catch (_) {
  // optional
}

/* -------------------------------- Utilities -------------------------------- */
const toArray = (x) => (Array.isArray(x) ? x : x != null ? [x] : []);
const uniq = (xs) => Array.from(new Set(xs.filter(Boolean).map((s) => String(s).trim())));

function cleanText(s) {
  if (s == null) return "";
  const str = String(s);
  // Strip basic HTML tags & excess whitespace
  return str
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function minutesFromISODuration(iso) {
  if (!iso || typeof iso !== "string") return 0;
  // Supports PT#H#M#S and P#DT#H#M#S. Ignore years/months/weeks for recipes.
  const m = iso.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i
  );
  if (!m) return 0;
  const days = parseInt(m[1] || "0", 10);
  const hours = parseInt(m[2] || "0", 10);
  const mins = parseInt(m[3] || "0", 10);
  const secs = parseInt(m[4] || "0", 10);
  return days * 24 * 60 + hours * 60 + mins + Math.round(secs / 60);
}

function firstString(...candidates) {
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const found = c.find((x) => typeof x === "string" && x.trim());
      if (found) return found.trim();
    } else if (typeof c === "string" && c.trim()) {
      return c.trim();
    }
  }
  return undefined;
}

function asNumber(x) {
  const n = Number(x);
  if (!isFinite(n)) return undefined;
  return n;
}

function safeJsonParse(str) {
  try {
    // Some sites embed multiple JSON objects or invalid comments—try to sanitize a bit
    return JSON.parse(str);
  } catch {
    try {
      // Attempt to fix common trailing commas
      const fixed = str.replace(/,\s*([}\]])/g, "$1");
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

/* ---------------------------- JSON-LD collection ---------------------------- */
function findJsonLdBlocksFromHtml(html) {
  if (!cheerio || typeof html !== "string") return [];
  try {
    const $ = cheerio.load(html);
    const blocks = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text();
      if (raw && raw.trim()) blocks.push(raw.trim());
    });
    return blocks;
  } catch {
    return [];
  }
}

function flattenGraph(node) {
  // Resolve @graph arrays; return array of candidate nodes
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(flattenGraph);
  if (node["@graph"]) return flattenGraph(node["@graph"]);
  return [node];
}

function isType(node, type) {
  const t = node["@type"];
  if (!t) return false;
  const arr = Array.isArray(t) ? t : [t];
  return arr.some((x) => String(x).toLowerCase() === String(type).toLowerCase());
}

function pickRecipeNodes(json) {
  // Accept document root, graph, or array
  const nodes = flattenGraph(json);
  const recipes = nodes.filter((n) => isType(n, "Recipe"));
  if (recipes.length) return recipes;

  // Sometimes the Recipe is nested in a WebPage's mainEntity
  const pages = nodes.filter((n) => isType(n, "WebPage") || isType(n, "Article"));
  for (const p of pages) {
    const me = p.mainEntity || p.mainEntityOfPage;
    const flat = flattenGraph(me);
    const r = flat.filter((n) => isType(n, "Recipe"));
    if (r.length) return r;
  }

  // Or Recipe attached via "itemListElement"
  const lists = nodes.filter((n) => isType(n, "ItemList"));
  for (const l of lists) {
    const els = toArray(l.itemListElement);
    const items = els
      .map((e) => (typeof e === "object" ? e.item || e : null))
      .filter(Boolean);
    const rs = items.flatMap((it) => flattenGraph(it)).filter((n) => isType(n, "Recipe"));
    if (rs.length) return rs;
  }

  return [];
}

/* --------------------------- Microdata (optional) --------------------------- */
function extractMicrodataRecipeFromHtml(html) {
  if (!cheerio || typeof html !== "string") return null;
  try {
    const $ = cheerio.load(html);
    // Simple microdata: itemscope itemtype *Recipe*
    const candidates = $('[itemscope][itemtype*="Recipe"], [itemtype*="schema.org/Recipe"]');
    if (!candidates.length) return null;

    const el = candidates.first();
    function getItemprop(prop) {
      const node = el.find(`[itemprop="${prop}"]`).first();
      if (!node.length) return undefined;
      const tag = node.get(0).tagName.toLowerCase();
      if (tag === "meta") return node.attr("content");
      if (tag === "img" || tag === "image") return node.attr("src") || node.attr("content");
      if (node.attr("content")) return node.attr("content");
      return cleanText(node.text());
    }
    function getAllItemprop(prop) {
      return el
        .find(`[itemprop="${prop}"]`)
        .map((_, n) => {
          const $n = $(n);
          const tag = $n.get(0).tagName.toLowerCase();
          if (tag === "meta") return $n.attr("content");
          if (tag === "img" || tag === "image") return $n.attr("src") || $n.attr("content");
          if ($n.attr("content")) return $n.attr("content");
          return cleanText($n.text());
        })
        .get()
        .filter(Boolean);
    }

    const title = getItemprop("name");
    const images = uniq([...getAllItemprop("image"), ...getAllItemprop("photo")]);
    const rec = {
      title,
      images,
      image: images[0],
      description: getItemprop("description"),
      recipeYield: getItemprop("recipeYield"),
      recipeCategory: getAllItemprop("recipeCategory"),
      recipeCuisine: getAllItemprop("recipeCuisine"),
      recipeIngredient: getAllItemprop("recipeIngredient"),
      recipeInstructions: getAllItemprop("recipeInstructions"),
      totalTime: getItemprop("totalTime"),
      prepTime: getItemprop("prepTime"),
      cookTime: getItemprop("cookTime"),
      aggregateRating: {
        ratingValue: getItemprop("ratingValue"),
        ratingCount: getItemprop("ratingCount"),
      },
      nutrition: {
        calories: getItemprop("calories"),
        proteinContent: getItemprop("proteinContent"),
        carbohydrateContent: getItemprop("carbohydrateContent"),
        fatContent: getItemprop("fatContent"),
      },
      author: getItemprop("author"),
    };
    return rec;
  } catch {
    return null;
  }
}

/* ------------------------------ Normalization ------------------------------ */
function normalizeInstructions(instr) {
  if (!instr) return [];
  const out = [];
  const arr = toArray(instr);

  for (const item of arr) {
    if (!item) continue;

    // Plain string
    if (typeof item === "string") {
      const lines = item.split(/\n|\. (?=[A-Z])/).map((s) => cleanText(s)).filter(Boolean);
      if (lines.length) out.push({ type: "step", text: lines.join(" ") });
      continue;
    }

    // HowToStep object
    if (typeof item === "object" && isType(item, "HowToStep")) {
      out.push({ type: "step", text: cleanText(item.text || item.name || item.description) });
      continue;
    }

    // HowToSection object
    if (typeof item === "object" && isType(item, "HowToSection")) {
      const name = cleanText(item.name || item.headline || "Section");
      const steps = normalizeInstructions(item.itemListElement || item.steps || []);
      out.push({ type: "section", title: name, items: steps });
      continue;
    }

    // Unknown object: try generic fields
    if (typeof item === "object") {
      const text = cleanText(item.text || item.description || item.name);
      if (text) out.push({ type: "step", text });
    }
  }

  return out;
}

function normalizeNutrition(nut) {
  if (!nut || typeof nut !== "object") return { kcal: undefined, protein: undefined, carbs: undefined, fat: undefined, raw: undefined };
  const raw = { ...nut };

  const parseVal = (v) => {
    if (v == null) return undefined;
    // extract number from "220 kcal" / "20 g"
    const m = String(v).match(/(-?\d+(?:\.\d+)?)/);
    return m ? asNumber(m[1]) : undefined;
  };

  const kcal = parseVal(nut.calories || nut["energy"] || nut["energyContent"]);
  const protein = parseVal(nut.proteinContent);
  const carbs = parseVal(nut.carbohydrateContent);
  const fat = parseVal(nut.fatContent);
  return { kcal, protein, carbs, fat, raw };
}

function normalizeTimes({ totalTime, prepTime, cookTime }) {
  const prep = minutesFromISODuration(prepTime) || asNumber(prepTime) || 0;
  const cook = minutesFromISODuration(cookTime) || asNumber(cookTime) || 0;
  let total = minutesFromISODuration(totalTime) || asNumber(totalTime) || 0;
  if (!total && (prep || cook)) total = prep + cook;
  return { prepMinutes: prep || 0, cookMinutes: cook || 0, totalMinutes: total || 0 };
}

function normalizeYield(y) {
  if (!y) return { servings: undefined, yieldText: undefined };
  const s = Array.isArray(y) ? y.join(" ") : String(y);
  const m = s.match(/(\d+(?:\.\d+)?)\s*(servings?|portion|people|pcs?)/i);
  const servings = m ? asNumber(m[1]) : undefined;
  return { servings, yieldText: s.trim() || undefined };
}

function gleanTags({ keywords, category, cuisine, description }) {
  const tags = [
    ...toArray(keywords || []),
    ...toArray(category || []),
  ]
    .join(",")
    .split(/[,/]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const cuisineTags = toArray(cuisine || []).map(String);
  const extra = [];
  if (description && /freezer|batch|make[-\s]?ahead/i.test(description)) extra.push("batch");

  return uniq([...tags, ...cuisineTags, ...extra]);
}

function detectBatchReady({ tags = [], instructions = [] }) {
  const tagHit = tags.some((t) => /batch|freezer|make[-\s]?ahead/i.test(String(t)));
  const instrHit = instructions.some((s) =>
    (s.type === "step" && /batch|double\s+batch|freeze/i.test(s.text || "")) ||
    (s.type === "section" && (s.title || "").match(/batch|freeze/i))
  );
  return !!(tagHit || instrHit);
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/* ------------------------------ Core normalize ------------------------------ */
function normalizeRecipeNode(node, { url } = {}) {
  const warnings = [];

  if (!node || typeof node !== "object") {
    return { recipe: null, warnings: ["No recipe node provided"], sources: { kind: "jsonld", url } };
  }

  const title = firstString(node.name, node.headline);
  const imageField = node.image;
  const images = uniq(
    toArray(
      typeof imageField === "string" ? imageField :
      Array.isArray(imageField) ? imageField :
      (imageField && typeof imageField === "object" && (imageField.url || imageField["@id"])) ?
        [imageField.url || imageField["@id"]] : []
    )
  );

  const times = normalizeTimes({
    totalTime: node.totalTime,
    prepTime: node.prepTime,
    cookTime: node.cookTime,
  });

  const ing = uniq([
    ...toArray(node.recipeIngredient),
    ...toArray(node.ingredients),
  ].map(cleanText));

  const instructions = normalizeInstructions(node.recipeInstructions);

  const nutrition = normalizeNutrition(node.nutrition || {});

  const ratingValue = asNumber(
    (node.aggregateRating && (node.aggregateRating.ratingValue || node.aggregateRating.rating)) ||
      node.ratingValue
  );
  const ratingCount = asNumber(
    (node.aggregateRating && (node.aggregateRating.ratingCount || node.aggregateRating.reviewCount)) ||
      node.ratingCount
  );

  const { servings, yieldText } = normalizeYield(node.recipeYield);

  const cuisine = toArray(node.recipeCuisine).map(cleanText).filter(Boolean);
  const category = toArray(node.recipeCategory).map(cleanText).filter(Boolean);

  const tags = uniq(
    gleanTags({
      keywords: node.keywords,
      category,
      cuisine,
      description: node.description,
    })
  );

  const authors = uniq(
    toArray(node.author)
      .map((a) => (typeof a === "string" ? a : a && (a.name || a["@id"])))
      .filter(Boolean)
      .map(cleanText)
  );

  const publisher =
    (node.publisher && (node.publisher.name || node.publisher)) ||
    (node.isPartOf && (node.isPartOf.name || node.isPartOf)) ||
    undefined;

  const datePublished = node.datePublished || node.dateCreated || undefined;

  const urlFromNode =
    node.url ||
    (node.mainEntityOfPage && (typeof node.mainEntityOfPage === "string" ? node.mainEntityOfPage : node.mainEntityOfPage["@id"])) ||
    url;

  const recipe = {
    id: node["@id"] || urlFromNode || title || `recipe-${Math.random().toString(36).slice(2, 8)}`,
    title: title || "Untitled recipe",
    description: cleanText(node.description),
    image: images[0],
    images,
    url: urlFromNode,
    source: {
      type: "web",
      url: urlFromNode,
      site: domainFromUrl(urlFromNode),
    },

    // Ratings
    rating: ratingValue || 0,
    ratingCount: ratingCount || 0,

    // Times
    prepMinutes: times.prepMinutes,
    cookMinutes: times.cookMinutes,
    totalMinutes: times.totalMinutes,

    // Yield
    servings: servings,
    yieldText,

    // Content
    ingredients: ing,
    instructions,

    // Nutrition
    macros: {
      kcal: nutrition.kcal,
      protein: nutrition.protein,
      carbs: nutrition.carbs,
      fat: nutrition.fat,
    },
    nutritionRaw: nutrition.raw,

    // Taxonomy
    cuisine,
    category,
    tags,

    // People/attribution
    author: authors[0],
    authors,
    publisher: cleanText(publisher),

    // Other hints
    video: node.video && (node.video.contentUrl || node.video.embedUrl || node.video.url),
    datePublished,
    updatedAt: node.dateModified || undefined,

    // Suka extras
    batchReady: detectBatchReady({ tags, instructions }),
    favorite: false,
    pinned: false,
    sourceType: "schema.org",
  };

  // Basic validation
  if (!recipe.ingredients.length && !recipe.instructions.length) {
    warnings.push("Recipe has no ingredients or instructions.");
  }
  if (!title) warnings.push("Missing name/headline.");

  return { recipe, warnings, sources: { kind: "jsonld", url: urlFromNode } };
}

/* ------------------------------ Public extractors ------------------------------ */
function extractFromJsonLd(jsonOrArray, { url } = {}) {
  const warnings = [];
  let candidates = [];

  const roots = Array.isArray(jsonOrArray) ? jsonOrArray : [jsonOrArray];
  for (const root of roots) {
    if (!root) continue;
    const nodes = pickRecipeNodes(root);
    if (nodes.length) candidates.push(...nodes);
  }

  // If still empty, it might be that input was raw JSON-LD strings (rare)
  if (!candidates.length && Array.isArray(jsonOrArray)) {
    for (const str of jsonOrArray) {
      if (typeof str !== "string") continue;
      const parsed = safeJsonParse(str);
      const nodes = pickRecipeNodes(parsed || {});
      if (nodes.length) candidates.push(...nodes);
    }
  }

  if (!candidates.length) {
    return { recipe: null, warnings: ["No Recipe node found in JSON-LD"], sources: { kind: "jsonld", url } };
  }

  // Prefer the most complete node (heuristic: most fields & has ingredients)
  candidates = candidates.map((n) => ({ n, score: Object.keys(n || {}).length + (toArray(n.recipeIngredient).length ? 10 : 0) }));
  candidates.sort((a, b) => b.score - a.score);

  return normalizeRecipeNode(candidates[0].n, { url });
}

function extractFromHtml(html, { url } = {}) {
  const warnings = [];
  if (typeof html !== "string" || !html.trim()) {
    return { recipe: null, warnings: ["No HTML provided"], sources: { kind: "html", url } };
  }

  // 1) JSON-LD blocks first (most reliable)
  const ldBlocks = findJsonLdBlocksFromHtml(html);
  const parsedBlocks = ldBlocks.map(safeJsonParse).filter(Boolean);
  if (parsedBlocks.length) {
    const res = extractFromJsonLd(parsedBlocks, { url });
    if (res.recipe) return res;
    warnings.push("No recipe found in JSON-LD; attempting microdata…");
  } else {
    warnings.push("No JSON-LD blocks found; attempting microdata…");
  }

  // 2) Microdata fallback (best-effort)
  const micro = extractMicrodataRecipeFromHtml(html);
  if (micro) {
    return normalizeRecipeNode(micro, { url });
  }

  return { recipe: null, warnings: ["No schema.org Recipe found"], sources: { kind: "html", url } };
}

function extract(source, opts = {}) {
  // Auto-detect: HTML string vs already-parsed JSON/array/object
  if (typeof source === "string" && /<html|<head|<body|<script/gi.test(source)) {
    return extractFromHtml(source, opts);
  }
  if (typeof source === "string") {
    // might be a raw JSON-LD string
    const parsed = safeJsonParse(source);
    if (parsed) return extractFromJsonLd(parsed, opts);
    return { recipe: null, warnings: ["Unrecognized string format"], sources: { kind: "unknown", url: opts.url } };
  }
  if (Array.isArray(source)) {
    return extractFromJsonLd(source, opts);
  }
  if (source && typeof source === "object") {
    return extractFromJsonLd(source, opts);
  }
  return { recipe: null, warnings: ["Unsupported input type"], sources: { kind: "unknown", url: opts.url } };
}

/* --------------------------------- Exports --------------------------------- */
module.exports = {
  extractFromHtml,
  extractFromJsonLd,
  extract,
};
