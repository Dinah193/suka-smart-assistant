/* recipeSchemaOrgExtractor.js
   Parse schema.org/Recipe from JSON-LD and (optionally) microdata.
   Robust + defensive. Normalizes to Suka's internal recipe shape.

   Exports:
     - extractFromHtml(html, { url }) -> { recipe, warnings, sources }
     - extractFromJsonLd(jsonOrArray, { url }) -> { recipe, warnings, sources }
     - extract(source, { url }) -> auto-detects

   Optional deps:
     - cheerio (for microdata + HTML parsing fallbacks)
*/

let cheerio = null;
try { cheerio = require("cheerio"); } catch (_) {}

const toArr = (x) => (Array.isArray(x) ? x : x != null ? [x] : []);
const uniq = (xs) => Array.from(new Set(xs.filter(Boolean).map((s) => String(s).trim())));
const asNum = (x) => (Number.isFinite(Number(x)) ? Number(x) : undefined);
const safeStr = (x) => (x == null ? "" : String(x));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

/* ------------------------------- URL helpers -------------------------------- */
function absolutize(url, base) {
  try {
    if (!url) return undefined;
    const u = new URL(url, base || undefined);
    // strip useless tracking params
    ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","igsh", "fbclid"].forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch { return url; }
}
function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return undefined; }
}

/* ---------------------------- String cleaning -------------------------------- */
function cleanText(s) {
  const t = safeStr(s)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t;
}

/* ------------------------------- Durations ---------------------------------- */
function minutesFromISODuration(iso) {
  if (!iso || typeof iso !== "string") return 0;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return 0;
  const [_, d, h, min, s] = m;
  return (parseInt(d || 0, 10) * 24 * 60) + (parseInt(h || 0, 10) * 60) + parseInt(min || 0, 10) + Math.round((parseInt(s || 0, 10) || 0) / 60);
}
function normalizeTimes({ totalTime, prepTime, cookTime }) {
  const prep = minutesFromISODuration(prepTime) || asNum(prepTime) || 0;
  const cook = minutesFromISODuration(cookTime) || asNum(cookTime) || 0;
  let total = minutesFromISODuration(totalTime) || asNum(totalTime) || 0;
  if (!total && (prep || cook)) total = prep + cook;
  return { prepMinutes: prep || 0, cookMinutes: cook || 0, totalMinutes: total || 0 };
}

/* -------------------------------- Nutrition --------------------------------- */
function parseNumFromLabel(v) {
  if (v == null) return undefined;
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? asNum(m[0]) : undefined;
}
function normalizeNutrition(nut, servings) {
  if (!nut || typeof nut !== "object") {
    return { kcal: undefined, protein: undefined, carbs: undefined, fat: undefined, raw: undefined };
  }
  const raw = { ...nut };
  const kcal = parseNumFromLabel(nut.calories || nut.energy || nut.energyContent);
  const protein = parseNumFromLabel(nut.proteinContent);
  const carbs = parseNumFromLabel(nut.carbohydrateContent);
  const fat = parseNumFromLabel(nut.fatContent);

  // Convert totals → per serving where possible
  const per = (val) => {
    if (val == null) return undefined;
    if (!servings || servings <= 0) return val;
    // If string hints "per serving", do nothing; else divide cautiously
    const s = String(nut.servingSize || "").toLowerCase();
    const looksPer = /serv/i.test(s);
    return looksPer ? val : Math.round((Number(val) / servings) * 10) / 10;
  };

  return {
    kcal: per(kcal),
    protein: per(protein),
    carbs: per(carbs),
    fat: per(fat),
    raw,
  };
}

/* ------------------------------- Instructions ------------------------------- */
function isType(node, type) {
  const t = node && node["@type"];
  if (!t) return false;
  const arr = Array.isArray(t) ? t : [t];
  return arr.some((x) => String(x).toLowerCase() === String(type).toLowerCase());
}
function normalizeInstructions(instr) {
  if (!instr) return [];
  const out = [];

  const pushStep = (txt) => {
    const text = cleanText(txt);
    if (!text) return;
    // de-dupe trivial repeats
    if (out.length && out[out.length - 1].type === "step" && out[out.length - 1].text === text) return;
    out.push({ type: "step", text });
  };
  const pushSection = (title, items) => {
    const t = cleanText(title) || "Section";
    const arr = (items || []).map((x) => (typeof x === "string" ? { type: "step", text: cleanText(x) } :
      isType(x, "HowToStep") ? { type: "step", text: cleanText(x.text || x.name || x.description) } :
      null)).filter(Boolean);
    if (arr.length) out.push({ type: "section", title: t, items: arr });
  };

  for (const item of toArr(instr)) {
    if (!item) continue;
    if (typeof item === "string") { pushStep(item); continue; }
    if (typeof item !== "object") continue;

    if (isType(item, "HowToStep")) {
      pushStep(item.text || item.name || item.description);
      continue;
    }
    if (isType(item, "HowToSection")) {
      pushSection(item.name || item.headline, item.itemListElement || item.steps || []);
      continue;
    }
    // array-ish (some sites put steps under itemListElement without typing)
    if (Array.isArray(item.itemListElement)) {
      const maybeSteps = item.itemListElement.map((x) =>
        typeof x === "string"
          ? { type: "step", text: cleanText(x) }
          : isType(x, "HowToStep")
          ? { type: "step", text: cleanText(x.text || x.name || x.description) }
          : null
      ).filter(Boolean);
      if (maybeSteps.length) out.push(...maybeSteps);
      continue;
    }
    // generic fallback
    pushStep(item.text || item.description || item.name);
  }
  return out;
}

/* -------------------------------- Ingredients ------------------------------- */
function normalizeIngredients(node) {
  const a = toArr(node.recipeIngredient);
  const b = toArr(node.ingredients);
  // Sometimes ingredients are objects w/ name
  const map = (x) => (typeof x === "string" ? cleanText(x) : cleanText(x && (x.name || x.text)));
  return uniq([...a.map(map), ...b.map(map)]).filter(Boolean);
}

/* ------------------------------- JSON-LD hunt ------------------------------- */
function flattenGraph(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(flattenGraph);
  if (node["@graph"]) return flattenGraph(node["@graph"]);
  return [node];
}

function pickRecipeNodes(json) {
  const nodes = flattenGraph(json);

  // Direct Recipe nodes
  const recipes = nodes.filter((n) => isType(n, "Recipe"));
  if (recipes.length) return recipes;

  // WebPage/Article mainEntity
  const pages = nodes.filter((n) => isType(n, "WebPage") || isType(n, "Article") || isType(n, "BlogPosting"));
  for (const p of pages) {
    const me = p.mainEntity || p.mainEntityOfPage || p.primaryEntity;
    const flat = flattenGraph(me);
    const r = flat.filter((n) => isType(n, "Recipe"));
    if (r.length) return r;
  }

  // ItemList linking to recipes
  const lists = nodes.filter((n) => isType(n, "ItemList"));
  for (const lst of lists) {
    const items = toArr(lst.itemListElement)
      .map((e) => (typeof e === "object" ? e.item || e.url || e : null))
      .filter(Boolean);
    const flat = items.flatMap(flattenGraph);
    const r = flat.filter((n) => isType(n, "Recipe"));
    if (r.length) return r;
  }

  // BreadcrumbList sometimes holds item to Recipe
  const crumbs = nodes.filter((n) => isType(n, "BreadcrumbList"));
  for (const c of crumbs) {
    const items = toArr(c.itemListElement).map((it) => it && it.item).filter(Boolean);
    const flat = items.flatMap(flattenGraph);
    const r = flat.filter((n) => isType(n, "Recipe"));
    if (r.length) return r;
  }

  return [];
}

/* -------------------------------- Microdata --------------------------------- */
function extractMicrodataRecipeFromHtml(html, baseUrl) {
  if (!cheerio || typeof html !== "string") return null;
  try {
    const $ = cheerio.load(html);
    const $cand =
      $('[itemscope][itemtype*="schema.org/Recipe"]').first() ||
      $('[itemtype*="schema.org/Recipe"]').first() ||
      $('[itemscope][itemtype*="/Recipe"]').first();
    if (!$cand || !$cand.length) return null;

    const pick = (prop) => {
      const node = $cand.find(`[itemprop="${prop}"]`).first();
      if (!node.length) return undefined;
      const tag = node.get(0).tagName.toLowerCase();
      if (tag === "meta") return node.attr("content");
      if (tag === "img" || tag === "image") return absolutize(node.attr("src") || node.attr("content"), baseUrl);
      if (node.attr("content")) return node.attr("content");
      return cleanText(node.text());
    };
    const pickAll = (prop) =>
      $cand.find(`[itemprop="${prop}"]`).map((_, el) => {
        const n = $(el); const tag = n.get(0).tagName.toLowerCase();
        if (tag === "meta") return n.attr("content");
        if (tag === "img" || tag === "image") return absolutize(n.attr("src") || n.attr("content"), baseUrl);
        if (n.attr("content")) return n.attr("content");
        return cleanText(n.text());
      }).get();

    const images = uniq([...(pickAll("image") || []), ...(pickAll("photo") || [])]).map((u) => absolutize(u, baseUrl)).filter(Boolean);

    const node = {
      "@type": "Recipe",
      name: pick("name"),
      description: pick("description"),
      image: images,
      url: pick("url"),
      recipeYield: pick("recipeYield"),
      recipeCategory: pickAll("recipeCategory"),
      recipeCuisine: pickAll("recipeCuisine"),
      recipeIngredient: pickAll("recipeIngredient"),
      recipeInstructions: pickAll("recipeInstructions"),
      totalTime: pick("totalTime"),
      prepTime: pick("prepTime"),
      cookTime: pick("cookTime"),
      aggregateRating: {
        ratingValue: pick("ratingValue"),
        ratingCount: pick("ratingCount"),
      },
      nutrition: {
        calories: pick("calories"),
        proteinContent: pick("proteinContent"),
        carbohydrateContent: pick("carbohydrateContent"),
        fatContent: pick("fatContent"),
        servingSize: pick("servingSize"),
      },
      author: pick("author"),
      publisher: pick("publisher"),
    };
    return node;
  } catch { return null; }
}

/* ---------------------------------- Images ---------------------------------- */
function normalizeImages(imageField, baseUrl) {
  const list = toArr(
    typeof imageField === "string"
      ? imageField
      : Array.isArray(imageField)
      ? imageField
      : imageField && typeof imageField === "object"
      ? [imageField.url || imageField.contentUrl || imageField["@id"]]
      : []
  ).filter(Boolean);

  const images = uniq(list.map((u) => absolutize(u, baseUrl))).filter(Boolean);
  return { image: images[0], images };
}

/* ---------------------------------- Yield ----------------------------------- */
function normalizeYield(y) {
  if (!y) return { servings: undefined, yieldText: undefined };
  const s = Array.isArray(y) ? y.join(" ") : String(y);
  const m = s.match(/(\d+(?:\.\d+)?)\s*(servings?|people|portion|portions|pcs?)/i);
  const servings = m ? asNum(m[1]) : undefined;
  return { servings, yieldText: s.trim() || undefined };
}

/* -------------------------------- Taxonomy ---------------------------------- */
function gleanTags({ keywords, category, cuisine, description }) {
  const kw = toArr(keywords)
    .flatMap((k) => String(k).split(/[,/]/))
    .map((s) => s.trim());
  const cat = toArr(category).map((s) => String(s).trim());
  const cui = toArr(cuisine).map((s) => String(s).trim());
  const extra = [];
  if (description && /freezer|batch|make[-\s]?ahead/i.test(description)) extra.push("batch");
  return uniq([...kw, ...cat, ...cui, ...extra]);
}
function detectBatchReady({ tags = [], instructions = [] }) {
  const tagHit = tags.some((t) => /batch|freezer|make[-\s]?ahead/i.test(String(t)));
  const instrHit = instructions.some(
    (s) => (s.type === "step" && /batch|double\s+batch|freeze/i.test(s.text || "")) ||
           (s.type === "section" && /batch|freeze/i.test(s.title || ""))
  );
  return !!(tagHit || instrHit);
}
function detectAllergens({ ingredients = [], tags = [] }) {
  const text = [ingredients.join(" "), tags.join(" ")].join(" ").toLowerCase();
  const hits = [];
  if (/\bnuts?\b|almond|walnut|pecan|cashew|peanut/.test(text)) hits.push("nuts");
  if (/\bgluten\b|wheat flour/.test(text)) hits.push("gluten");
  if (/\bdairy\b|milk|cream|cheese|butter/.test(text)) hits.push("dairy");
  if (/\begg\b/.test(text)) hits.push("egg");
  if (/\bsoy\b|soy sauce|tofu/.test(text)) hits.push("soy");
  return uniq(hits);
}
function detectAppliances({ instructions = [] }) {
  const t = JSON.stringify(instructions).toLowerCase();
  const hits = [];
  if (/air\s*fryer/.test(t)) hits.push("air fryer");
  if (/\binstant\s*pot|\bpressure cooker/.test(t)) hits.push("pressure cooker");
  if (/\bslow cooker|\bcrock[ -]?pot/.test(t)) hits.push("slow cooker");
  if (/\bovernight\b/.test(t)) hits.push("overnight");
  return uniq(hits);
}

/* -------------------------------- Core normalize ----------------------------- */
function normalizeRecipeNode(node, { url } = {}) {
  const warnings = [];

  if (!node || typeof node !== "object") {
    return { recipe: null, warnings: ["No recipe node provided"], sources: { kind: "jsonld", url } };
  }

  const title = cleanText(node.name || node.headline);
  const urlFromNode =
    node.url ||
    (node.mainEntityOfPage && (typeof node.mainEntityOfPage === "string" ? node.mainEntityOfPage : node.mainEntityOfPage["@id"])) ||
    url;

  const { image, images } = normalizeImages(node.image, urlFromNode);

  const times = normalizeTimes({
    totalTime: node.totalTime,
    prepTime: node.prepTime,
    cookTime: node.cookTime,
  });

  const ingredients = normalizeIngredients(node);

  const instructions = normalizeInstructions(node.recipeInstructions);

  const { servings, yieldText } = normalizeYield(node.recipeYield);

  const nutrition = normalizeNutrition(node.nutrition || {}, servings);

  const ratingValue =
    asNum(node?.aggregateRating?.ratingValue || node?.aggregateRating?.rating) ||
    asNum(node.ratingValue);

  const ratingCount =
    asNum(node?.aggregateRating?.ratingCount || node?.aggregateRating?.reviewCount) ||
    asNum(node.ratingCount);

  const cuisine = toArr(node.recipeCuisine).map(cleanText).filter(Boolean);
  const category = toArr(node.recipeCategory).map(cleanText).filter(Boolean);
  const tags = gleanTags({
    keywords: node.keywords,
    category,
    cuisine,
    description: node.description,
  });

  const authors = uniq(
    toArr(node.author).map((a) =>
      typeof a === "string" ? a : (a && (a.name || a["@id"])) || ""
    ).map(cleanText)
  );

  // Publisher can be Organization or string
  const publisher =
    (node.publisher && (node.publisher.name || node.publisher)) ||
    (node.isPartOf && (node.isPartOf.name || node.isPartOf));

  const datePublished = node.datePublished || node.dateCreated || undefined;

  const video =
    node.video &&
    (typeof node.video === "string"
      ? node.video
      : node.video.contentUrl || node.video.embedUrl || node.video.url);

  const appliances = detectAppliances({ instructions });
  const allergens = detectAllergens({ ingredients, tags });

  const recipe = {
    id:
      node["@id"] ||
      urlFromNode ||
      title ||
      `recipe-${Math.random().toString(36).slice(2, 8)}`,

    // Identity
    title: title || "Untitled recipe",
    description: cleanText(node.description),
    url: absolutize(urlFromNode),
    source: {
      type: "web",
      url: absolutize(urlFromNode),
      site: hostname(urlFromNode),
    },

    // Media
    image,
    images,
    video,

    // Ratings
    rating: ratingValue || 0,
    ratingCount: ratingCount || 0,

    // Times
    prepMinutes: times.prepMinutes,
    cookMinutes: times.cookMinutes,
    totalMinutes: times.totalMinutes,

    // Yield
    servings,
    yieldText,

    // Content
    ingredients,
    instructions, // [{type:'step',text} | {type:'section',title,items:[...]}]

    // Nutrition (per serving where possible)
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

    // Dates
    datePublished,
    updatedAt: node.dateModified || undefined,

    // Extras for Suka
    batchReady: detectBatchReady({ tags, instructions }),
    appliances, // e.g., ["air fryer", "pressure cooker"]
    allergens,  // e.g., ["gluten","dairy"]
    favorite: false,
    pinned: false,
    sourceType: "schema.org",
  };

  if (!recipe.ingredients.length && !recipe.instructions.length) {
    warnings.push("Recipe has no ingredients or instructions.");
  }
  if (!title) warnings.push("Missing name/headline.");

  return { recipe, warnings, sources: { kind: "jsonld", url: recipe.url } };
}

/* ---------------------------- JSON-LD collectors ----------------------------- */
function safeJsonParse(str) {
  try { return JSON.parse(str); }
  catch {
    try {
      const fixed = str.replace(/,\s*([}\]])/g, "$1");
      return JSON.parse(fixed);
    } catch { return null; }
  }
}
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
  } catch { return []; }
}

/* -------------------------------- Public API -------------------------------- */
function extractFromJsonLd(jsonOrArray, { url } = {}) {
  const roots = Array.isArray(jsonOrArray) ? jsonOrArray : [jsonOrArray];
  let candidates = [];

  for (const root of roots) {
    if (!root) continue;
    const nodes = pickRecipeNodes(root);
    if (nodes.length) candidates.push(...nodes);
  }

  // Some callers pass raw JSON-LD strings array
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

  // Prefer most complete (field count + has ingredients)
  candidates = candidates
    .map((n) => ({ n, score: Object.keys(n || {}).length + (toArr(n.recipeIngredient).length ? 10 : 0) }))
    .sort((a, b) => b.score - a.score);

  return normalizeRecipeNode(candidates[0].n, { url });
}

function extractFromHtml(html, { url } = {}) {
  const warnings = [];
  if (typeof html !== "string" || !html.trim()) {
    return { recipe: null, warnings: ["No HTML provided"], sources: { kind: "html", url } };
  }

  // JSON-LD first
  const ldBlocks = findJsonLdBlocksFromHtml(html);
  const parsedBlocks = ldBlocks.map(safeJsonParse).filter(Boolean);
  if (parsedBlocks.length) {
    const res = extractFromJsonLd(parsedBlocks, { url });
    if (res.recipe) return res;
    warnings.push("No recipe found in JSON-LD; attempting microdata…");
  } else {
    warnings.push("No JSON-LD blocks found; attempting microdata…");
  }

  // Microdata fallback
  const micro = extractMicrodataRecipeFromHtml(html, url);
  if (micro) {
    return normalizeRecipeNode(micro, { url });
  }

  return { recipe: null, warnings: ["No schema.org Recipe found"], sources: { kind: "html", url } };
}

function extract(source, opts = {}) {
  if (typeof source === "string" && /<html|<head|<body|<script/i.test(source)) {
    return extractFromHtml(source, opts);
  }
  if (typeof source === "string") {
    const parsed = safeJsonParse(source);
    if (parsed) return extractFromJsonLd(parsed, opts);
    return { recipe: null, warnings: ["Unrecognized string format"], sources: { kind: "unknown", url: opts.url } };
  }
  if (Array.isArray(source)) return extractFromJsonLd(source, opts);
  if (source && typeof source === "object") return extractFromJsonLd(source, opts);
  return { recipe: null, warnings: ["Unsupported input type"], sources: { kind: "unknown", url: opts.url } };
}

module.exports = {
  extractFromHtml,
  extractFromJsonLd,
  extract,
};
