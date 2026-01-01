/* taggingAutoClassifier.js
   Auto-infer cuisine, course, effort, appliances & more from recipe features.

   Exports:
     - classifyRecipe(recipe, opts) -> { facets, tags, scores, reasons }
     - batchClassify(recipes, opts) -> Array<...same as classifyRecipe per recipe...>
     - mergeTags(existingTags, auto) -> unique merged tag array (prefers user tags)
     - suggestChips(result, limit?) -> array of quick filter chips for UI

   Recipe shape (flexible):
     {
       id, title, description, ingredients[], instructions[] (steps/sections),
       cuisine[], category[], tags[], source{site}, macros, rating, ratingCount,
       prepMinutes, cookMinutes, totalMinutes, appliances[], allergens[]
     }

   Notes:
     - Pure heuristics + lightweight scoring; no external deps.
     - Returns per-facet confidences & human-readable "reasons" for auditing.
     - Safe if fields are missing; everything is optional.
*/

/* ------------------------------ utilities ---------------------------------- */
const toArr = (x) => (Array.isArray(x) ? x : x != null ? [x] : []);
const uniq = (xs) => Array.from(new Set(xs.filter(Boolean).map((s) => String(s).trim())));
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const txt = (...xs) => xs.filter(Boolean).join(" ").toLowerCase();

function getAllText(recipe = {}) {
  const title = recipe.title || "";
  const desc = recipe.description || "";
  const ing = toArr(recipe.ingredients).join("\n");
  const inst = Array.isArray(recipe.instructions)
    ? recipe.instructions.map((s) => (s?.type === "step" ? s.text : s?.title)).join("\n")
    : "";
  const site = recipe?.source?.site || "";
  const cuisine = toArr(recipe.cuisine).join(" ");
  const category = toArr(recipe.category).join(" ");
  const tags = toArr(recipe.tags).join(" ");
  return txt(title, desc, ing, inst, site, cuisine, category, tags);
}

function addScore(bucket, key, val, reason) {
  const cur = bucket[key] || { score: 0, reasons: [] };
  cur.score += Number(val) || 0;
  if (reason) cur.reasons.push(reason);
  bucket[key] = cur;
}

function normalizeScores(dict, softmax = false) {
  // clamp >=0 and optionally softmax to [0..1] distribution
  const out = {};
  const vals = Object.values(dict).map((v) => Math.max(0, v.score));
  const max = Math.max(0.0001, ...vals);
  const expVals = softmax ? vals.map((v) => Math.exp(v - max)) : null;
  const sumExp = softmax ? expVals.reduce((a, b) => a + b, 0) || 1 : 1;

  let i = 0;
  for (const key of Object.keys(dict)) {
    const raw = Math.max(0, dict[key].score);
    const conf = softmax ? expVals[i++] / sumExp : (max ? raw / max : 0);
    out[key] = { score: raw, confidence: clamp01(conf), reasons: dict[key].reasons };
  }
  return out;
}

/* ------------------------------- lexicons ---------------------------------- */
/* Cuisine keywords (weighted). Keep concise but effective. */
const CUISINE = [
  { key: "italian", w: 2, rx: /\b(pasta|spaghetti|penne|rigatoni|lasagna|gnocchi|mozzarella|parmigiano|pecorino|prosciutto|bolognese|risotto|arrabbiata|pesto|bruschetta)\b/ },
  { key: "mexican", w: 2, rx: /\b(taco|tacos|tortilla|salsa|enchilada|quesadilla|pozole|chile|adobo|asada|carnitas|elote|chipotle)\b/ },
  { key: "indian",  w: 2, rx: /\b(curry|garam masala|tikka|dal|tarka|chutney|naan|ghee|paneer|vindaloo|korma|masala|tandoori|saag)\b/ },
  { key: "chinese", w: 2, rx: /\b(stir[- ]?fry|wok|soy sauce|hoisin|oyster sauce|chow mein|lo mein|dumpling|xiaolongbao|mapo tofu|kung pao)\b/ },
  { key: "japanese",w: 2, rx: /\b(sushi|ramen|miso|dashi|tonkatsu|katsu|teriyaki|udon|soba|tempura|okonomiyaki|gyoza|takoyaki)\b/ },
  { key: "thai",    w: 2, rx: /\b(fish sauce|nam pla|lemongrass|galangal|tom yum|pad thai|green curry|red curry|kaffir|holy basil)\b/ },
  { key: "korean",  w: 2, rx: /\b(gochujang|gochugaru|kimchi|bulgogi|bibimbap|samgyeopsal|ssam|jjigae|galbi|banchan)\b/ },
  { key: "vietnamese", w: 2, rx: /\b(pho\b|nuoc mam|banh mi|vermicelli|lemongrass chicken|bun cha)\b/ },
  { key: "middle eastern", w: 2, rx: /\b(hummus|tahini|shawarma|za'atar|zaatar|sumac|labneh|falafel|shakshuka|harissa|pita)\b/ },
  { key: "greek",   w: 2, rx: /\b(feta|tzatziki|gyro|souvlaki|moussaka|halloumi|kalamata|dolma)\b/ },
  { key: "french",  w: 2, rx: /\b(béchamel|bechamel|bouillabaisse|coq au vin|ratatouille|gratin|niçoise|nicoise|sous vide|vinaigrette)\b/ },
  { key: "spanish", w: 2, rx: /\b(paella|romesco|tapas|chorizo|gazpacho|tortilla española|patatas bravas)\b/ },
  { key: "american",w: 1.5, rx: /\b(mac and cheese|cornbread|sloppy joe|meatloaf|buffalo sauce|ranch|buttermilk biscuits|cobb salad|pot roast)\b/ },
  { key: "bbq",     w: 1.5, rx: /\b(smoked|smoker|barbecue|bbq rub|brisket|pulled pork|dry rub|mesquite)\b/ },
  { key: "caribbean", w: 1.5, rx: /\b(jerk|plantain|ackee|saltfish|callaloo|sofrito)\b/ },
  { key: "african", w: 1.2, rx: /\b(jollof|berbere|injera|egusi|suya|peri[- ]?peri|yassa)\b/ },
  { key: "german",  w: 1.2, rx: /\b(spätzle|spaetzle|sauerkraut|bratwurst|schnitzel|kartoffel)\b/ },
  { key: "eastern european", w: 1.2, rx: /\b(borscht|pierogi|pelmeni|golabki|goulash)\b/ },
];

/* Course keywords */
const COURSE = [
  { key: "breakfast", w: 1.6, rx: /\b(oats?|oatmeal|pancake|waffle|omelet|omelette|granola|smoothie|scramble|breakfast|overnight)\b/ },
  { key: "brunch",    w: 1.2, rx: /\b(brunch|benedict|quiche|frittata|hash)\b/ },
  { key: "main",      w: 1.8, rx: /\b(roast|casserole|stew|curry|lasagna|meatloaf|skillet|sheet pan|one[- ]pot|main course)\b/ },
  { key: "side",      w: 1.4, rx: /\b(side dish|coleslaw|mashed|stuffing|gratin|pilaf|sautéed|sauteed|glazed carrots)\b/ },
  { key: "salad",     w: 1.4, rx: /\b(salad|vinaigrette|coleslaw)\b/ },
  { key: "soup",      w: 1.4, rx: /\b(soup|bisque|chowder|broth)\b/ },
  { key: "appetizer", w: 1.2, rx: /\b(appetizer|starter|dip|bruschetta|crostini|finger food)\b/ },
  { key: "dessert",   w: 1.8, rx: /\b(cookie|brownie|cake|cupcake|frosting|mousse|pudding|cobbler|pie|tart|dessert|ice cream)\b/ },
  { key: "drink",     w: 1.0, rx: /\b(smoothie|latte|lemonade|mojito|mocktail|cocktail|chai|hot chocolate)\b/ },
];

/* Methods / appliances */
const APPLIANCE = [
  { key: "air fryer",        w: 2.0, rx: /\b(air[- ]?fryer|air[- ]?fried)\b/ },
  { key: "pressure cooker",  w: 2.0, rx: /\b(instant\s*pot|pressure cooker|high pressure)\b/ },
  { key: "slow cooker",      w: 2.0, rx: /\b(slow cooker|crock[ -]?pot)\b/ },
  { key: "sous vide",        w: 1.5, rx: /\b(sous[- ]?vide)\b/ },
  { key: "grill",            w: 1.2, rx: /\b(grill|grilled|barbecue)\b/ },
  { key: "smoker",           w: 1.3, rx: /\b(smoker|smoked\b)\b/ },
  { key: "stovetop",         w: 0.8, rx: /\b(skillet|sauté|saute|saucepan|simmer)\b/ },
  { key: "oven",             w: 0.8, rx: /\b(oven|preheat|bake at|baked)\b/ },
  { key: "microwave",        w: 0.8, rx: /\b(microwave)\b/ },
];

/* Dietary / allergens */
const DIET = [
  { key: "vegan",     w: 1.8, rx: /\b(vegan|plant[- ]?based)\b/ },
  { key: "vegetarian",w: 1.4, rx: /\b(vegetarian)\b/ },
  { key: "gluten-free", w: 1.6, rx: /\b(gluten[- ]?free)\b/ },
  { key: "keto",      w: 1.4, rx: /\b(keto|ketogenic)\b/ },
  { key: "paleo",     w: 1.2, rx: /\b(paleo)\b/ },
  { key: "dairy-free", w: 1.2, rx: /\b(dairy[- ]?free)\b/ },
  { key: "low-carb",  w: 1.2, rx: /\b(low[- ]?carb)\b/ },
];

/* Quick ingredients -> diet contradictions (to down-weight false positives) */
const CONTRA = {
  vegan: /\b(egg|eggs|milk|cream|cheese|butter|honey|yogurt|yoghurt)\b/,
  vegetarian: /\b(chicken|beef|pork|fish|shrimp|bacon|steak|anchovy|anchovies|gelatin)\b/,
  "gluten-free": /\b(wheat flour|all[- ]purpose flour|breadcrumbs|panko)\b/,
  "dairy-free": /\b(milk|cream|cheese|butter|yogurt|yoghurt)\b/,
  keto: /\b(rice|pasta|bread|sugar|honey|maple syrup|flour)\b/,
  paleo: /\b(legumes|peanuts|soy|tofu|corn)\b/,
  "low-carb": /\b(rice|pasta|bread|sugar|honey|maple syrup|flour)\b/,
};

/* Effort heuristics by time, steps, and technique hints */
const EFFORT_LEVELS = [
  { key: "easy",    test: ({ minutes, steps, text }) =>
      (minutes <= 30 && steps <= 6) || /\b(no[- ]?bake|one[- ]pot|sheet pan|5[- ]ingredient)\b/.test(text) },
  { key: "medium",  test: ({ minutes, steps, text }) =>
      (minutes > 30 && minutes <= 75) || (steps > 6 && steps <= 12) || /\b(marinat|proof|roux|custard)\b/.test(text) },
  { key: "advanced",test: ({ minutes, steps, text }) =>
      minutes > 75 || steps > 12 || /\b(tempering chocolate|laminat|meringue|sous[- ]?vide)\b/.test(text) },
];

/* ---------------------------- core classifiers ------------------------------ */
function scoreFromLexicon(text, lex) {
  const bucket = {};
  for (const rule of lex) {
    if (rule.rx.test(text)) {
      addScore(bucket, rule.key, rule.w, `Matched: ${rule.rx}`);
    }
  }
  return normalizeScores(bucket);
}

function topFacet(scored, minConfidence = 0.35) {
  let best = null; let bestKey = null;
  for (const [k, v] of Object.entries(scored)) {
    if (!best || v.confidence > best.confidence) { best = v; bestKey = k; }
  }
  if (!best || best.confidence < minConfidence) return { key: null, ...best };
  return { key: bestKey, ...best };
}

function stepsCount(instructions = []) {
  let n = 0;
  for (const it of toArr(instructions)) {
    if (!it) continue;
    if (it.type === "step" && it.text) n++;
    else if (it.type === "section" && Array.isArray(it.items)) {
      n += it.items.filter((x) => x && x.type === "step" && x.text).length;
    }
  }
  return n || (Array.isArray(instructions) ? instructions.length : 0);
}

/* Adjust diet scores using contradictions in ingredients text */
function adjustDietByIngredients(dietScores, allText, ingredientsText) {
  const out = {};
  for (const [k, v] of Object.entries(dietScores)) {
    let score = v.score;
    const c = CONTRA[k];
    if (c && c.test(ingredientsText)) {
      score *= 0.35; // downweight claim if contradictory ingredient present
      v.reasons.push(`Contradiction: ${c}`);
    }
    out[k] = { ...v, score };
  }
  return normalizeScores(out);
}

/* Merge existing declared facets (from site) with inferred, prefer explicit */
function mergeFacetArrays(existing = [], inferredKey, inferredConfidence) {
  const low = inferredConfidence < 0.4 ? [] : [inferredKey];
  return uniq([...toArr(existing), ...low]).filter(Boolean);
}

/* ------------------------------- main entry -------------------------------- */
function classifyRecipe(recipe = {}, opts = {}) {
  try {
    const text = getAllText(recipe);
    const ingredientsText = txt(...toArr(recipe.ingredients));
    const minutes = Number(recipe.totalMinutes || recipe.prepMinutes || recipe.cookMinutes || 0) || 0;
    const steps = stepsCount(recipe.instructions);

    /* Cuisine */
    const cuisineScores = scoreFromLexicon(text, CUISINE);
    const cuisineTop = topFacet(cuisineScores, 0.33);

    /* Course */
    const courseScores = scoreFromLexicon(text, COURSE);
    const courseTop = topFacet(courseScores, 0.33);

    /* Appliances (union of extractor hints + inferred) */
    const applianceScores = scoreFromLexicon(text, APPLIANCE);
    // seed with extractor-provided appliances at high confidence
    const appl = new Set(toArr(recipe.appliances));
    for (const a of appl) addScore(applianceScores, a, 2.2, "Extractor appliance hint");
    const applianceFinal = normalizeScores(applianceScores);

    /* Diet / allergens (diet is heuristic; allergens often provided) */
    const dietScores0 = scoreFromLexicon(text, DIET);
    const dietScores = adjustDietByIngredients(dietScores0, text, ingredientsText);
    const allergens = uniq([...(toArr(recipe.allergens))]); // pass-through from extractor if present

    /* Effort */
    const effortCtx = { minutes, steps, text };
    let effort = "medium", effortReason = [];
    for (const lvl of EFFORT_LEVELS) {
      if (lvl.test(effortCtx)) {
        effort = lvl.key;
        effortReason.push(`Matched effort ${lvl.key}`);
        break;
      }
    }
    // slight time-based nudge
    if (minutes <= 20 && steps <= 5) { effort = "easy"; effortReason.push("<=20m & <=5 steps"); }
    if (minutes > 90 || steps > 14)  { effort = "advanced"; effortReason.push(">90m or >14 steps"); }

    /* Build facets */
    const facets = {
      cuisine: cuisineTop.key ? mergeFacetArrays(recipe.cuisine, cuisineTop.key, cuisineTop.confidence) : toArr(recipe.cuisine),
      course:  courseTop.key ? mergeFacetArrays(recipe.category, courseTop.key, courseTop.confidence)  : toArr(recipe.category),
      appliances: uniq([
        ...Object.keys(applianceFinal).filter((k) => applianceFinal[k].confidence >= 0.35),
      ]),
      diet: uniq(Object.keys(dietScores).filter((k) => dietScores[k].confidence >= 0.5)),
      allergens,
      effort,
    };

    /* Flat tag list for search chips (you can store in recipe.tags) */
    const tags = uniq([
      ...(toArr(recipe.tags) || []),
      ...(facets.cuisine || []),
      ...(facets.course || []),
      ...(facets.appliances || []),
      facets.effort,
      ...facets.diet,
      ...facets.allergens,
    ]);

    /* Scores (for analytics / tuning) */
    const scores = {
      cuisine: cuisineScores,
      course: courseScores,
      appliances: applianceFinal,
      diet: dietScores,
      effort: { [effort]: { score: 1, confidence: 1, reasons: effortReason } },
    };

    /* Reasons (human-friendly top-line explanations) */
    const reasons = {
      cuisine: cuisineTop.key ? cuisineScores[cuisineTop.key]?.reasons || [] : [],
      course: courseTop.key ? courseScores[courseTop.key]?.reasons || [] : [],
      appliances: Object.entries(applianceFinal)
        .filter(([, v]) => v.confidence >= 0.35)
        .flatMap(([k, v]) => v.reasons.map((r) => `${k}: ${r}`)),
      diet: Object.entries(dietScores)
        .filter(([, v]) => v.confidence >= 0.5)
        .flatMap(([k, v]) => v.reasons.map((r) => `${k}: ${r}`)),
      effort: effortReason,
    };

    return { facets, tags, scores, reasons };
  } catch (e) {
    return {
      facets: { cuisine: toArr(recipe.cuisine), course: toArr(recipe.category), appliances: toArr(recipe.appliances), diet: [], allergens: toArr(recipe.allergens), effort: "medium" },
      tags: uniq([...(toArr(recipe.tags) || []), ...(toArr(recipe.cuisine) || []), ...(toArr(recipe.category) || [])]),
      scores: {},
      reasons: { error: String(e && e.message || e) },
    };
  }
}

/* ------------------------------ helper APIs -------------------------------- */
function batchClassify(recipes = [], opts = {}) {
  return toArr(recipes).map((r) => ({
    id: r?.id || r?.url,
    ...classifyRecipe(r, opts),
  }));
}

function mergeTags(existingTags = [], auto) {
  const add = Array.isArray(auto) ? auto : toArr(auto?.tags);
  return uniq([...(existingTags || []), ...add]);
}

/* Small UI helper: pick a few good chips */
function suggestChips(result, limit = 5) {
  const chips = [];
  if (!result || !result.facets) return chips;
  const f = result.facets;

  if (f.cuisine?.length) chips.push({ facet: "cuisine", value: f.cuisine[0], label: cap(f.cuisine[0]) });
  if (f.course?.length) chips.push({ facet: "course", value: f.course[0], label: cap(f.course[0]) });
  if (f.effort) chips.push({ facet: "effort", value: f.effort, label: cap(f.effort) });
  (f.appliances || []).slice(0, 2).forEach((a) => chips.push({ facet: "appliance", value: a, label: cap(a) }));
  (f.diet || []).slice(0, 2).forEach((d) => chips.push({ facet: "diet", value: d, label: chipLabel(d) }));

  return chips.slice(0, limit);
}

function cap(s) { return String(s || "").replace(/\b\w/g, (m) => m.toUpperCase()); }
function chipLabel(s) {
  return s === "gluten-free" ? "Gluten-Free" :
         s === "dairy-free" ? "Dairy-Free" :
         cap(s);
}

/* --------------------------------- exports --------------------------------- */
module.exports = {
  classifyRecipe,
  batchClassify,
  mergeTags,
  suggestChips,
  // exposed for tests / tuning
  _internals: {
    CUISINE, COURSE, APPLIANCE, DIET, CONTRA, EFFORT_LEVELS,
    scoreFromLexicon, normalizeScores, topFacet, stepsCount,
  },
};
