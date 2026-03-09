/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\engines\RecipeIntakeParser.js
//
// SSA • RecipeIntakeParser
// -----------------------------------------------------------------------------
// Purpose:
//   Deterministic "intake" parsing for imported or manually entered recipes.
//   Extracts (best-effort) the key planning signals SSA needs:
//
//     - vegetables
//     - fats
//     - proteins + cut tags
//     - methods (cook verbs + appliance hints)
//     - temperatures (°F/°C + oven/air fryer/etc.)
//     - times (durations + ranges)
//
// Input (tolerant):
//   parseRecipeIntake({ text, title, ingredients, steps, recipe, options })
//
// Where:
//   - text: a free-text blob (recipe paste)
//   - ingredients: string | string[] | [{ text, amount, unit, name }...]
//   - steps: string | string[] | [{ text|instruction|step }...]
//   - recipe: optional object containing any/all of the above
//
// Output:
//   {
//     ok: true,
//     extracted: {
//       proteins: [{ proteinCategory, item, cutTag, confidence, evidence: {...} }],
//       vegetables: [{ item, category, confidence, evidence }],
//       fats: [{ item, fatType, confidence, evidence }],
//       methods: [{ method, confidence, evidence }],
//       temperatures: [{ context, value, unit, confidence, evidence }],
//       times: [{ kind, seconds, rangeSeconds, confidence, evidence }],
//     },
//     signals: {
//       primaryProteinCategory,
//       primaryMethod,
//       hasOvenTemp,
//       totalTimeSecondsGuess,
//     },
//     report: { flags, notes, warnings, decisions }
//   }
//
// Design goals:
//   - browser-safe, no heavy NLP, no external deps
//   - explainable: we include evidence snippets + source fields
//   - tolerant: works with partial data
//   - SSA-friendly: proteinCategory/cutTag/method keys line up with your catalogs
//
// -----------------------------------------------------------------------------
// Notes:
//   This parser is NOT meant to perfectly classify every ingredient.
//   It’s meant to surface "good enough" signals to drive:
//     - DonenessResolver inputs
//     - CapabilityMatcher requirements
//     - RecipeAdapterService adaptation pipeline decisions
// -----------------------------------------------------------------------------
// Optional catalog alignment:
//   - If you have strict enums elsewhere, you can post-normalize using catalogs.
// -----------------------------------------------------------------------------
// No placeholders; defensive and production-ready.

const ENGINE_ID = "features/recipes/engines/RecipeIntakeParser";
const ENGINE_VERSION = "1.0.0";

const DEFAULTS = Object.freeze({
  maxChars: 200_000,
  maxLines: 10_000,
  maxItemsPerCategory: 100,

  // Confidence tuning
  baseConfidenceIngredient: 0.75,
  baseConfidenceStep: 0.7,
  baseConfidenceText: 0.6,

  // Time inference
  maxDurationSeconds: 7 * 24 * 3600,

  // Parsing behavior
  includeDuplicates: false, // if false, unique items by key
  preferIngredientsForEntities: true,
  preferStepsForMethodsTempsTimes: true,
});

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeString(s, max = 2000, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function uniqBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(arr) ? arr : []) {
    const k = keyFn(it);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  const y = Math.round(x);
  if (y < min) return min;
  if (y > max) return max;
  return y;
}

function clamp01(n, fallback = 0.7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function nowISO() {
  return new Date().toISOString();
}

function createReport(options) {
  return {
    ok: true,
    engine: { id: ENGINE_ID, version: ENGINE_VERSION },
    startedAt: nowISO(),
    finishedAt: null,
    flags: [],
    notes: [],
    warnings: [],
    decisions: [],
    limits: {
      maxChars: options.maxChars,
      maxLines: options.maxLines,
      maxItemsPerCategory: options.maxItemsPerCategory,
    },
  };
}

function warn(report, code, message, context = {}, severity = "warn") {
  if (!report) return;
  report.warnings.push({
    code: safeString(code, 128, "warning"),
    message: safeString(message, 2000, "Warning"),
    severity,
    context: isPlainObject(context) ? context : {},
  });
}

function note(report, message) {
  if (!report) return;
  report.notes.push(safeString(message, 2000, ""));
}

function decision(report, type, message, context = {}) {
  if (!report) return;
  report.decisions.push({
    at: nowISO(),
    type: safeString(type, 120, "decision"),
    message: safeString(message, 2000, ""),
    context: isPlainObject(context) ? context : {},
  });
}

/* -------------------------------------------------------------------------- */
/* Lexicons                                                                    */
/* -------------------------------------------------------------------------- */

// Methods map to SSA-ish keys (align with your DonenessTargets + substitution logic)
const METHOD_PATTERNS = [
  { method: "bake", re: /\bbake\b|\boven\b/g },
  { method: "roast", re: /\broast\b/g },
  { method: "broil", re: /\bbroil\b/g },
  { method: "grill", re: /\bgrill\b|\bbarbecue\b|\bbbq\b/g },
  { method: "smoke", re: /\bsmoke\b|\bsmoker\b/g },
  { method: "air_fry", re: /\bair\s*[- ]?fry\b|\bair\s*fryer\b/g },
  { method: "saute", re: /\bsaut(e|é)\b|\bsaut(e|é)ing\b/g },
  { method: "pan_sear", re: /\bsear\b|\bpan[- ]sear\b/g },
  { method: "stir_fry", re: /\bstir[- ]fry\b|\bwok\b/g },
  { method: "boil", re: /\bboil\b|\brolling boil\b/g },
  { method: "simmer", re: /\bsimmer\b/g },
  { method: "poach", re: /\bpoach\b/g },
  { method: "steam", re: /\bsteam\b|\bsteamer\b/g },
  { method: "deep_fry", re: /\bdeep[- ]fry\b|\bdeep fried\b/g },
  { method: "fry", re: /\bfry\b|\bfried\b/g },
  {
    method: "pressure_cook",
    re: /\bpressure cook\b|\binstant pot\b|\bpressure cooker\b/g,
  },
  { method: "slow_cook", re: /\bslow cook\b|\bcrock ?pot\b|\bslow cooker\b/g },
  { method: "sous_vide", re: /\bsous[- ]vide\b/g },
  { method: "microwave", re: /\bmicrowave\b/g },
];

// Protein categories and their token triggers
const PROTEIN_CATEGORIES = [
  {
    proteinCategory: "beef",
    tokens: [
      "beef",
      "steak",
      "brisket",
      "roast",
      "ground beef",
      "short ribs",
      "ribeye",
      "sirloin",
    ],
  },
  {
    proteinCategory: "lamb",
    tokens: ["lamb", "mutton", "lamb chop", "leg of lamb", "lamb shoulder"],
  },
  { proteinCategory: "goat", tokens: ["goat", "chevon"] },
  {
    proteinCategory: "pork",
    tokens: [
      "pork",
      "bacon",
      "ham",
      "sausage",
      "pork chop",
      "pork loin",
      "pork shoulder",
    ],
  },
  {
    proteinCategory: "chicken",
    tokens: ["chicken", "hen", "drumstick", "thigh", "breast", "wing"],
  },
  { proteinCategory: "turkey", tokens: ["turkey"] },
  { proteinCategory: "duck", tokens: ["duck"] },
  {
    proteinCategory: "fish",
    tokens: ["fish", "salmon", "tilapia", "cod", "catfish", "trout", "snapper"],
  },
  {
    proteinCategory: "shellfish",
    tokens: [
      "shrimp",
      "prawn",
      "crab",
      "lobster",
      "scallop",
      "mussel",
      "clam",
      "oyster",
    ],
  },
  { proteinCategory: "eggs", tokens: ["egg", "eggs"] },
  { proteinCategory: "venison", tokens: ["venison", "deer"] },
  { proteinCategory: "bison", tokens: ["bison"] },
];

// Cut tag inference tokens -> cutTag keys
const CUT_TAGS = [
  {
    cutTag: "steak",
    tokens: [
      "steak",
      "ribeye",
      "sirloin",
      "strip steak",
      "t-bone",
      "tbone",
      "porterhouse",
    ],
  },
  { cutTag: "ground", tokens: ["ground", "minced"] },
  { cutTag: "roast", tokens: ["roast"] },
  { cutTag: "brisket", tokens: ["brisket"] },
  { cutTag: "ribs", tokens: ["ribs", "rib"] },
  { cutTag: "chops", tokens: ["chop", "chops"] },
  { cutTag: "breast", tokens: ["breast"] },
  { cutTag: "thigh", tokens: ["thigh", "thighs"] },
  { cutTag: "wings", tokens: ["wing", "wings"] },
  { cutTag: "drumsticks", tokens: ["drumstick", "drumsticks"] },
  { cutTag: "fillet", tokens: ["fillet", "filet"] },
  { cutTag: "whole", tokens: ["whole"] },
];

// Vegetables list (broad). Category is optional and can be refined later.
const VEGETABLE_TOKENS = [
  // leafy
  { item: "spinach", category: "leafy" },
  { item: "kale", category: "leafy" },
  { item: "collard greens", category: "leafy" },
  { item: "cabbage", category: "cruciferous" },
  { item: "lettuce", category: "leafy" },
  // alliums
  { item: "onion", category: "allium" },
  { item: "garlic", category: "allium" },
  { item: "shallot", category: "allium" },
  { item: "leek", category: "allium" },
  // roots
  { item: "carrot", category: "root" },
  { item: "potato", category: "root" },
  { item: "sweet potato", category: "root" },
  { item: "yam", category: "root" },
  { item: "turnip", category: "root" },
  { item: "beet", category: "root" },
  // nightshades
  { item: "tomato", category: "nightshade" },
  { item: "bell pepper", category: "nightshade" },
  { item: "jalapeño", category: "nightshade" },
  { item: "jalapeno", category: "nightshade" },
  { item: "chili pepper", category: "nightshade" },
  { item: "eggplant", category: "nightshade" },
  // squash
  { item: "zucchini", category: "squash" },
  { item: "squash", category: "squash" },
  { item: "pumpkin", category: "squash" },
  // cruciferous
  { item: "broccoli", category: "cruciferous" },
  { item: "cauliflower", category: "cruciferous" },
  { item: "brussels sprouts", category: "cruciferous" },
  // others
  { item: "celery", category: "stem" },
  { item: "cucumber", category: "fruiting" },
  { item: "okra", category: "fruiting" },
  { item: "green beans", category: "legume" },
  { item: "peas", category: "legume" },
  { item: "corn", category: "grain/veg" },
  { item: "mushroom", category: "fungus" },
];

// Fats (oils, animal fats, dairy fats)
const FAT_TOKENS = [
  { item: "olive oil", fatType: "oil" },
  { item: "avocado oil", fatType: "oil" },
  { item: "vegetable oil", fatType: "oil" },
  { item: "canola oil", fatType: "oil" },
  { item: "coconut oil", fatType: "oil" },
  { item: "sesame oil", fatType: "oil" },
  { item: "butter", fatType: "dairy_fat" },
  { item: "ghee", fatType: "dairy_fat" },
  { item: "lard", fatType: "animal_fat" },
  { item: "tallow", fatType: "animal_fat" },
  { item: "duck fat", fatType: "animal_fat" },
  { item: "bacon fat", fatType: "animal_fat" },
  { item: "shortening", fatType: "fat" },
  { item: "margarine", fatType: "fat" },
];

// Extra temperature contexts
const TEMP_CONTEXT_PATTERNS = [
  { context: "oven", re: /\b(oven|bake|roast|broil)\b/i },
  { context: "air_fryer", re: /\bair\s*[- ]?fry|\bair\s*fryer\b/i },
  { context: "grill", re: /\bgrill|bbq|barbecue\b/i },
  { context: "oil", re: /\boil\b|\bdeep[- ]fry\b/i },
  {
    context: "internal",
    re: /\binternal\b|\bthermometer\b|\btemp(erature)?\b.*\binside\b/i,
  },
];

/* -------------------------------------------------------------------------- */
/* Text building                                                               */
/* -------------------------------------------------------------------------- */

function buildTextEnvelope(input, options, report) {
  const chunks = [];

  const push = (label, value) => {
    const t = safeString(value, options.maxChars, "");
    if (!t) return;
    chunks.push({ label, text: t });
  };

  const recipe = isPlainObject(input.recipe) ? input.recipe : {};

  push("title", input.title ?? recipe.title ?? recipe.name ?? "");
  push("text", input.text ?? recipe.text ?? recipe.rawText ?? "");

  // Ingredients
  const ing =
    input.ingredients ??
    recipe.ingredients ??
    recipe.ingredientLines ??
    recipe.ingredientsText;
  const ingLines = normalizeLinesFromUnknown(ing);
  if (ingLines.length) push("ingredients", ingLines.join("\n"));

  // Steps/instructions
  const steps =
    input.steps ?? recipe.steps ?? recipe.instructions ?? recipe.directions;
  const stepLines = normalizeLinesFromUnknown(steps);
  if (stepLines.length) push("steps", stepLines.join("\n"));

  // Safety: cap combined size
  const full = chunks.map((c) => c.text).join("\n");
  if (full.length > options.maxChars) {
    warn(
      report,
      "text_truncated",
      `Input text truncated to ${options.maxChars} characters.`,
      { original: full.length, max: options.maxChars }
    );
  }

  return {
    chunks,
    fullText: full.slice(0, options.maxChars),
    ingredientLines: ingLines,
    stepLines,
  };
}

function normalizeLinesFromUnknown(x) {
  if (!x) return [];
  if (typeof x === "string") {
    return x
      .split(/\n+/g)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, DEFAULTS.maxLines);
  }
  if (Array.isArray(x)) {
    const out = [];
    for (const it of x) {
      if (typeof it === "string") out.push(it);
      else if (isPlainObject(it))
        out.push(
          String(
            it.text ?? it.name ?? it.instruction ?? it.step ?? it.line ?? ""
          )
        );
    }
    return out
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .slice(0, DEFAULTS.maxLines);
  }
  if (isPlainObject(x)) {
    // maybe { lines: [] } or similar
    const arr = x.lines || x.items || x.values;
    if (Array.isArray(arr)) return normalizeLinesFromUnknown(arr);
    const t = x.text || x.value || "";
    return normalizeLinesFromUnknown(t);
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Core match helpers                                                          */
/* -------------------------------------------------------------------------- */

function findTokensInText(text, tokens) {
  const t = safeLower(text);
  if (!t) return [];

  const hits = [];
  for (const tok of tokens) {
    const item = safeLower(tok.item || "");
    if (!item) continue;

    // Use word boundary-ish for single words; for multiword, simple includes is OK.
    const isMulti = item.includes(" ");
    const found = isMulti
      ? t.includes(item)
      : new RegExp(`\\b${escapeRegExp(item)}\\b`, "i").test(text);

    if (!found) continue;

    hits.push(tok);
  }
  return hits;
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------------------------------------------------------------- */
/* Proteins                                                                    */
/* -------------------------------------------------------------------------- */

function inferProteinCategoryFromLine(line) {
  const t = safeLower(line);

  // shellfish hits should win over fish if explicit
  for (const row of PROTEIN_CATEGORIES) {
    for (const token of row.tokens) {
      const tok = safeLower(token);
      if (!tok) continue;
      const isMulti = tok.includes(" ");
      const found = isMulti
        ? t.includes(tok)
        : new RegExp(`\\b${escapeRegExp(tok)}\\b`, "i").test(line);
      if (found) return row.proteinCategory;
    }
  }
  return "";
}

function inferCutTagFromLine(line) {
  const t = safeLower(line);

  for (const row of CUT_TAGS) {
    for (const token of row.tokens) {
      const tok = safeLower(token);
      const isMulti = tok.includes(" ");
      const found = isMulti
        ? t.includes(tok)
        : new RegExp(`\\b${escapeRegExp(tok)}\\b`, "i").test(line);
      if (found) return row.cutTag;
    }
  }

  return "";
}

/* -------------------------------------------------------------------------- */
/* Methods                                                                     */
/* -------------------------------------------------------------------------- */

function inferMethodsFromText(text) {
  const out = [];
  for (const row of METHOD_PATTERNS) {
    const matches = text.match(row.re);
    if (matches && matches.length) {
      out.push({
        method: row.method,
        confidence: clamp01(0.75 + Math.min(matches.length, 3) * 0.05, 0.7),
        evidence: { source: "text", match: matches[0], count: matches.length },
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Temperatures                                                                */
/* -------------------------------------------------------------------------- */

function parseTemperatures(text) {
  // Extract:
  //  - 350°F, 350 F, 180°C, 180 C
  //  - "at 375 degrees" (assume F unless C is near)
  //  - "preheat oven to 400"
  const out = [];

  const raw = String(text || "");
  if (!raw.trim()) return out;

  // Pattern 1: number + unit
  const re = /(\d{2,3})\s*(°\s*)?(f|c)\b/gi;
  let m;
  while ((m = re.exec(raw))) {
    const value = Number(m[1]);
    const unit = safeLower(m[3]) === "c" ? "C" : "F";
    const snippet = snippetAround(raw, m.index, 60);
    out.push({
      context: inferTempContext(snippet),
      value,
      unit,
      confidence: 0.85,
      evidence: { source: "text", snippet, match: m[0] },
    });
  }

  // Pattern 2: "to 400 degrees" without F/C nearby
  const re2 = /\b(to|at)\s*(\d{2,3})\s*(degrees|degree)\b/gi;
  while ((m = re2.exec(raw))) {
    const value = Number(m[2]);
    const snippet = snippetAround(raw, m.index, 80);

    // Heuristic: if "c" or "cel" appears near, treat as C
    const near = safeLower(snippet);
    const unit =
      near.includes("celsius") || /\b\d{2,3}\s*°?\s*c\b/i.test(snippet)
        ? "C"
        : "F";

    out.push({
      context: inferTempContext(snippet),
      value,
      unit,
      confidence: 0.7,
      evidence: {
        source: "text",
        snippet,
        match: m[0],
        heuristic: "degrees_without_unit",
      },
    });
  }

  // de-dup by context+value+unit
  const dedup = uniqBy(out, (x) => `${x.context}:${x.value}${x.unit}`);
  return dedup.slice(0, DEFAULTS.maxItemsPerCategory);
}

function inferTempContext(snippet) {
  const s = String(snippet || "");
  for (const row of TEMP_CONTEXT_PATTERNS) {
    if (row.re.test(s)) return row.context;
  }
  return "unspecified";
}

function snippetAround(text, idx, radius = 60) {
  const s = String(text || "");
  const start = Math.max(0, idx - radius);
  const end = Math.min(s.length, idx + radius);
  return s.slice(start, end).trim();
}

/* -------------------------------------------------------------------------- */
/* Times                                                                       */
/* -------------------------------------------------------------------------- */

function parseDurations(text) {
  // Extract durations and ranges:
  //   - "20 minutes", "1 hour", "1 hr 20 min", "90 sec"
  //   - "20-25 minutes", "20 to 25 minutes"
  // Also attempts to infer kind based on surrounding words:
  //   - prep, cook, rest, total
  const out = [];
  const raw = String(text || "");
  if (!raw.trim()) return out;

  // Range: 20-25 minutes
  const range1 =
    /(\d+)\s*-\s*(\d+)\s*(seconds?|secs?|sec|minutes?|mins?|min|hours?|hrs?|hr)\b/gi;
  let m;
  while ((m = range1.exec(raw))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const unit = safeLower(m[3]);
    const rangeSeconds = [toSeconds(a, unit), toSeconds(b, unit)].sort(
      (x, y) => x - y
    );
    const seconds = Math.round((rangeSeconds[0] + rangeSeconds[1]) / 2);
    const snippet = snippetAround(raw, m.index, 70);
    out.push({
      kind: inferTimeKind(snippet),
      seconds: clampInt(seconds, 1, DEFAULTS.maxDurationSeconds, seconds),
      rangeSeconds,
      confidence: 0.8,
      evidence: { source: "text", snippet, match: m[0] },
    });
  }

  // Range: 20 to 25 minutes
  const range2 =
    /(\d+)\s*(to)\s*(\d+)\s*(seconds?|secs?|sec|minutes?|mins?|min|hours?|hrs?|hr)\b/gi;
  while ((m = range2.exec(raw))) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const unit = safeLower(m[4]);
    const rangeSeconds = [toSeconds(a, unit), toSeconds(b, unit)].sort(
      (x, y) => x - y
    );
    const seconds = Math.round((rangeSeconds[0] + rangeSeconds[1]) / 2);
    const snippet = snippetAround(raw, m.index, 70);
    out.push({
      kind: inferTimeKind(snippet),
      seconds: clampInt(seconds, 1, DEFAULTS.maxDurationSeconds, seconds),
      rangeSeconds,
      confidence: 0.78,
      evidence: { source: "text", snippet, match: m[0] },
    });
  }

  // Simple: 20 minutes
  const simple =
    /(\d+)\s*(seconds?|secs?|sec|minutes?|mins?|min|hours?|hrs?|hr)\b/gi;
  while ((m = simple.exec(raw))) {
    const value = Number(m[1]);
    const unit = safeLower(m[2]);
    const seconds = toSeconds(value, unit);
    const snippet = snippetAround(raw, m.index, 70);

    // Avoid double-counting those already included as ranges:
    // (heuristic: skip if snippet contains a "-" range close)
    if (snippet.match(/\d+\s*-\s*\d+\s*(seconds?|minutes?|hours?)/i)) continue;
    if (snippet.match(/\d+\s*to\s*\d+\s*(seconds?|minutes?|hours?)/i)) continue;

    out.push({
      kind: inferTimeKind(snippet),
      seconds: clampInt(seconds, 1, DEFAULTS.maxDurationSeconds, seconds),
      rangeSeconds: null,
      confidence: 0.75,
      evidence: { source: "text", snippet, match: m[0] },
    });
  }

  // De-dup by kind+seconds (+range if any)
  const dedup = uniqBy(
    out,
    (x) =>
      `${x.kind}:${x.seconds}:${x.rangeSeconds ? x.rangeSeconds.join("-") : ""}`
  );
  return dedup.slice(0, DEFAULTS.maxItemsPerCategory);
}

function toSeconds(value, unit) {
  const u = safeLower(unit);
  if (u.startsWith("hr") || u.startsWith("hour"))
    return Math.round(value * 3600);
  if (u.startsWith("min") || u.startsWith("minute"))
    return Math.round(value * 60);
  return Math.round(value);
}

function inferTimeKind(snippet) {
  const t = safeLower(snippet);
  if (t.includes("total")) return "total";
  if (t.includes("prep")) return "prep";
  if (t.includes("rest") || t.includes("cool") || t.includes("marinate"))
    return "rest";
  if (
    t.includes("bake") ||
    t.includes("cook") ||
    t.includes("roast") ||
    t.includes("simmer") ||
    t.includes("boil") ||
    t.includes("grill")
  )
    return "cook";
  return "unspecified";
}

/* -------------------------------------------------------------------------- */
/* Main parse                                                                  */
/* -------------------------------------------------------------------------- */

function parseRecipeIntake(input = {}) {
  const options = normalizeOptions(input.options);
  const report = createReport(options);

  const envelope = buildTextEnvelope(input, options, report);
  const { fullText, ingredientLines, stepLines } = envelope;

  if (!fullText.trim()) {
    report.ok = false;
    warn(
      report,
      "empty_input",
      "No input text/ingredients/steps provided.",
      {},
      "error"
    );
    report.finishedAt = nowISO();
    return {
      ok: false,
      extracted: emptyExtracted(),
      signals: emptySignals(),
      report,
    };
  }

  // Build analysis sources
  const sources = [];
  sources.push({
    type: "text",
    weight: options.baseConfidenceText,
    lines: splitLines(fullText, options.maxLines),
  });

  if (ingredientLines.length)
    sources.push({
      type: "ingredients",
      weight: options.baseConfidenceIngredient,
      lines: ingredientLines,
    });
  if (stepLines.length)
    sources.push({
      type: "steps",
      weight: options.baseConfidenceStep,
      lines: stepLines,
    });

  // Extract entities
  const proteins = [];
  const vegetables = [];
  const fats = [];
  const methods = [];
  const temperatures = [];
  const times = [];

  // Prefer ingredients for entities if configured
  const entitySources = options.preferIngredientsForEntities
    ? sources.sort(
        (a, b) =>
          (a.type === "ingredients" ? -1 : 0) -
          (b.type === "ingredients" ? -1 : 0)
      )
    : sources;

  // Prefer steps for methods/temps/times if configured
  const actionSources = options.preferStepsForMethodsTempsTimes
    ? sources.sort(
        (a, b) => (a.type === "steps" ? -1 : 0) - (b.type === "steps" ? -1 : 0)
      )
    : sources;

  // Entities: proteins/cuts, vegetables, fats
  for (const src of entitySources) {
    for (const line of src.lines) {
      if (!line) continue;
      const l = String(line);

      // proteins
      const proteinCategory = inferProteinCategoryFromLine(l);
      if (proteinCategory) {
        const cutTag = inferCutTagFromLine(l) || "";
        proteins.push({
          proteinCategory,
          item: safeString(l, 400, ""),
          cutTag: cutTag || null,
          confidence: clamp01(src.weight + (cutTag ? 0.05 : 0), 0.65),
          evidence: {
            source: src.type,
            line: safeString(l, 400, ""),
            matched: { proteinCategory, cutTag },
          },
        });
      }

      // vegetables
      for (const hit of findTokensInText(l, VEGETABLE_TOKENS)) {
        vegetables.push({
          item: hit.item,
          category: hit.category || null,
          confidence: clamp01(src.weight, 0.6),
          evidence: {
            source: src.type,
            line: safeString(l, 400, ""),
            matched: hit.item,
          },
        });
      }

      // fats
      for (const hit of findTokensInText(l, FAT_TOKENS)) {
        fats.push({
          item: hit.item,
          fatType: hit.fatType || "fat",
          confidence: clamp01(src.weight, 0.6),
          evidence: {
            source: src.type,
            line: safeString(l, 400, ""),
            matched: hit.item,
          },
        });
      }

      // Cap per category to avoid runaway
      if (proteins.length > options.maxItemsPerCategory * 3) break;
      if (vegetables.length > options.maxItemsPerCategory * 3) break;
      if (fats.length > options.maxItemsPerCategory * 3) break;
    }
  }

  // Methods/Temps/Times
  for (const src of actionSources) {
    for (const line of src.lines) {
      if (!line) continue;
      const l = String(line);

      // methods
      const mths = inferMethodsFromText(l);
      for (const m of mths) {
        methods.push({
          method: m.method,
          confidence: clamp01(Math.max(m.confidence, src.weight), 0.65),
          evidence: {
            ...m.evidence,
            source: src.type,
            line: safeString(l, 400, ""),
          },
        });
      }

      // temps
      const temps = parseTemperatures(l);
      for (const t of temps) {
        temperatures.push({
          context: t.context,
          value: t.value,
          unit: t.unit,
          confidence: clamp01(Math.max(t.confidence, src.weight), 0.65),
          evidence: { ...t.evidence, source: src.type },
        });
      }

      // times
      const durs = parseDurations(l);
      for (const d of durs) {
        times.push({
          kind: d.kind,
          seconds: d.seconds,
          rangeSeconds: d.rangeSeconds,
          confidence: clamp01(Math.max(d.confidence, src.weight), 0.65),
          evidence: { ...d.evidence, source: src.type },
        });
      }

      if (methods.length > options.maxItemsPerCategory * 4) break;
      if (temperatures.length > options.maxItemsPerCategory * 4) break;
      if (times.length > options.maxItemsPerCategory * 6) break;
    }
  }

  // Normalize / dedup
  const extracted = {
    proteins: finalizeProteins(proteins, options),
    vegetables: finalizeSimple(vegetables, (v) => safeLower(v.item), options),
    fats: finalizeSimple(fats, (f) => safeLower(f.item), options),
    methods: finalizeSimple(methods, (m) => safeLower(m.method), options),
    temperatures: finalizeSimple(
      temperatures,
      (t) => `${safeLower(t.context)}:${t.value}${t.unit}`,
      options
    ),
    times: finalizeSimple(
      times,
      (t) =>
        `${safeLower(t.kind)}:${t.seconds}:${
          t.rangeSeconds ? t.rangeSeconds.join("-") : ""
        }`,
      options
    ),
  };

  // Signals (primary picks)
  const signals = computeSignals(extracted);

  // Report notes
  decision(report, "counts", "Extraction counts", {
    proteins: extracted.proteins.length,
    vegetables: extracted.vegetables.length,
    fats: extracted.fats.length,
    methods: extracted.methods.length,
    temperatures: extracted.temperatures.length,
    times: extracted.times.length,
  });

  if (!extracted.proteins.length)
    note(
      report,
      "No proteins detected (may be vegetarian or extraction missed)."
    );
  if (!extracted.methods.length)
    note(
      report,
      "No cooking methods detected; default method may be used downstream."
    );
  if (!extracted.times.length)
    note(
      report,
      "No times detected; timers may need user input or inference from steps."
    );
  if (!extracted.temperatures.length)
    note(
      report,
      "No temperatures detected; appliance temps may need user input."
    );

  report.finishedAt = nowISO();

  return {
    ok: report.ok,
    extracted,
    signals,
    report,
  };
}

/* -------------------------------------------------------------------------- */
/* Finalizers                                                                  */
/* -------------------------------------------------------------------------- */

function finalizeProteins(list, options) {
  const arr = Array.isArray(list) ? list : [];
  // Aggregate duplicates by proteinCategory + cutTag (prefer higher confidence)
  const byKey = new Map();
  for (const p of arr) {
    if (!p || !p.proteinCategory) continue;
    const key = `${p.proteinCategory}:${p.cutTag || ""}`;
    const prev = byKey.get(key);
    if (!prev || (p.confidence ?? 0) > (prev.confidence ?? 0))
      byKey.set(key, p);
  }
  let out = Array.from(byKey.values());

  // Sort: confidence desc
  out.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  // Cap
  out = out.slice(0, options.maxItemsPerCategory);

  // Ensure stable fields
  return out.map((p) => ({
    proteinCategory: safeLower(p.proteinCategory) || "unknown",
    item: safeString(p.item, 400, ""),
    cutTag: p.cutTag ? safeLower(p.cutTag) : null,
    confidence: clamp01(p.confidence, 0.7),
    evidence: isPlainObject(p.evidence) ? p.evidence : {},
  }));
}

function finalizeSimple(list, keyFn, options) {
  const arr = Array.isArray(list) ? list : [];
  if (options.includeDuplicates) {
    return arr
      .slice(0, options.maxItemsPerCategory)
      .map((x) => normalizeExtractItem(x));
  }
  const out = uniqBy(arr, keyFn)
    .slice(0, options.maxItemsPerCategory)
    .map((x) => normalizeExtractItem(x));
  // sort by confidence desc
  out.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return out;
}

function normalizeExtractItem(x) {
  const o = isPlainObject(x) ? x : {};
  const common = {
    confidence: clamp01(o.confidence, 0.65),
    evidence: isPlainObject(o.evidence) ? o.evidence : {},
  };

  if ("method" in o)
    return { method: safeLower(o.method) || "unknown", ...common };
  if ("fatType" in o)
    return {
      item: safeLower(o.item) || "",
      fatType: safeLower(o.fatType) || "fat",
      ...common,
    };
  if ("category" in o)
    return {
      item: safeLower(o.item) || "",
      category: safeLower(o.category) || null,
      ...common,
    };
  if ("value" in o && "unit" in o) {
    return {
      context: safeLower(o.context) || "unspecified",
      value: Number(o.value),
      unit: o.unit === "C" ? "C" : "F",
      ...common,
    };
  }
  if ("seconds" in o) {
    return {
      kind: safeLower(o.kind) || "unspecified",
      seconds: clampInt(o.seconds, 1, DEFAULTS.maxDurationSeconds, o.seconds),
      rangeSeconds: Array.isArray(o.rangeSeconds)
        ? o.rangeSeconds.slice(0, 2)
        : null,
      ...common,
    };
  }

  return { ...o, ...common };
}

function computeSignals(extracted) {
  const proteins = extracted?.proteins || [];
  const methods = extracted?.methods || [];
  const temps = extracted?.temperatures || [];
  const times = extracted?.times || [];

  const primaryProteinCategory = proteins.length
    ? proteins[0].proteinCategory
    : null;

  // choose method with highest confidence; if tie, prefer "bake" if oven temp exists
  let primaryMethod = methods.length ? methods[0].method : null;

  const hasOvenTemp = temps.some(
    (t) =>
      safeLower(t.context) === "oven" || safeLower(t.context) === "air_fryer"
  );

  if (hasOvenTemp && methods.length) {
    const bakeish = methods.find((m) =>
      ["bake", "roast", "broil", "air_fry"].includes(safeLower(m.method))
    );
    if (bakeish) primaryMethod = bakeish.method;
  }

  // total time guess: if any "total" time exists, take highest confidence total,
  // else sum cook+rest (bounded), else largest duration (fallback)
  let totalTimeSecondsGuess = null;
  const totals = times
    .filter((t) => safeLower(t.kind) === "total")
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  if (totals.length) totalTimeSecondsGuess = totals[0].seconds;
  else {
    const cookRest = times.filter((t) =>
      ["cook", "rest", "prep"].includes(safeLower(t.kind))
    );
    if (cookRest.length) {
      const sum = cookRest.reduce(
        (acc, t) => acc + (Number(t.seconds) || 0),
        0
      );
      totalTimeSecondsGuess = clampInt(
        sum,
        1,
        DEFAULTS.maxDurationSeconds,
        sum
      );
    } else if (times.length) {
      const max = Math.max(...times.map((t) => Number(t.seconds) || 0));
      totalTimeSecondsGuess = max || null;
    }
  }

  return {
    primaryProteinCategory,
    primaryMethod,
    hasOvenTemp,
    totalTimeSecondsGuess,
  };
}

function splitLines(text, maxLines) {
  const t = String(text || "");
  const lines = t
    .split(/\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  return lines.slice(0, maxLines);
}

function emptyExtracted() {
  return {
    proteins: [],
    vegetables: [],
    fats: [],
    methods: [],
    temperatures: [],
    times: [],
  };
}

function emptySignals() {
  return {
    primaryProteinCategory: null,
    primaryMethod: null,
    hasOvenTemp: false,
    totalTimeSecondsGuess: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

function normalizeOptions(options) {
  const o = isPlainObject(options) ? options : {};
  return {
    maxChars: clampInt(
      o.maxChars ?? DEFAULTS.maxChars,
      10_000,
      2_000_000,
      DEFAULTS.maxChars
    ),
    maxLines: clampInt(
      o.maxLines ?? DEFAULTS.maxLines,
      100,
      200_000,
      DEFAULTS.maxLines
    ),
    maxItemsPerCategory: clampInt(
      o.maxItemsPerCategory ?? DEFAULTS.maxItemsPerCategory,
      10,
      1000,
      DEFAULTS.maxItemsPerCategory
    ),

    baseConfidenceIngredient: clamp01(
      o.baseConfidenceIngredient ?? DEFAULTS.baseConfidenceIngredient,
      DEFAULTS.baseConfidenceIngredient
    ),
    baseConfidenceStep: clamp01(
      o.baseConfidenceStep ?? DEFAULTS.baseConfidenceStep,
      DEFAULTS.baseConfidenceStep
    ),
    baseConfidenceText: clamp01(
      o.baseConfidenceText ?? DEFAULTS.baseConfidenceText,
      DEFAULTS.baseConfidenceText
    ),

    includeDuplicates:
      typeof o.includeDuplicates === "boolean"
        ? o.includeDuplicates
        : DEFAULTS.includeDuplicates,
    preferIngredientsForEntities:
      typeof o.preferIngredientsForEntities === "boolean"
        ? o.preferIngredientsForEntities
        : DEFAULTS.preferIngredientsForEntities,
    preferStepsForMethodsTempsTimes:
      typeof o.preferStepsForMethodsTempsTimes === "boolean"
        ? o.preferStepsForMethodsTempsTimes
        : DEFAULTS.preferStepsForMethodsTempsTimes,
  };
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

const RecipeIntakeParser = Object.freeze({
  engine: { id: ENGINE_ID, version: ENGINE_VERSION },
  parseRecipeIntake,
});

export { RecipeIntakeParser, ENGINE_ID, ENGINE_VERSION, parseRecipeIntake };
export default RecipeIntakeParser;
