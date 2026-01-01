/* readableBodyHeuristics.js
   Last-resort ingredient/steps heuristics for messy recipe pages without schema.org data.

   Exported API:
   - extractFromHtml(html, { url }) -> { ingredients, instructions, servings, yieldText, times, warnings, sources }
   - extractFromText(text, { url }) -> same as above
   - helpers: parseServings, parseTimesFromText, parseIngredientLine

   Design notes:
   - Optional cheerio: if present, we detect the main content area & lists; otherwise we fallback to HTML->text.
   - Conservative, zero-crash: always returns a structured object (may be empty arrays with warnings).
   - Output aligns with Suka’s internal shape (compatible with RecipeCard/Planner/InventoryMonitor).
*/

/* ----------------------- Optional dependency (cheerio) ---------------------- */
let cheerio = null;
try { cheerio = require("cheerio"); } catch (_) { /* optional */ }

/* -------------------------------- Utilities -------------------------------- */
const toArray = (x) => (Array.isArray(x) ? x : x != null ? [x] : []);
const uniq = (xs) => Array.from(new Set(xs.filter(Boolean).map((s) => String(s).trim())));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

/** Basic HTML → text */
function stripHtml(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|br|h[1-6])>/gi, "$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Unicode fraction → ascii decimal; preserves original alongside parsed quantity */
const FRACTIONS = {
  "¼": 0.25, "½": 0.5, "¾": 0.75,
  "⅐": 1/7, "⅑": 1/9, "⅒": 0.1, "⅓": 1/3, "⅔": 2/3, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
  "⅙": 1/6, "⅚": 5/6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};
function fracToDecimal(s = "") {
  let x = 0;
  let rest = s;
  Object.keys(FRACTIONS).forEach((k) => {
    if (s.includes(k)) {
      x += FRACTIONS[k];
      rest = rest.replace(k, "");
    }
  });
  // If rest still has a leading integer (e.g., "1 ½")
  const m = rest.match(/(\d+(?:\.\d+)?)/);
  if (m) x += parseFloat(m[1]);
  return x || undefined;
}

/** Parse nice time phrases → minutes */
function minutesFromText(s) {
  if (!s) return 0;
  const text = String(s).toLowerCase();
  let total = 0;
  const hour = /(\d+(?:\.\d+)?)\s*(h|hour|hours)/;
  const min = /(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)/;
  const day = /(\d+(?:\.\d+)?)\s*(d|day|days)/;

  const add = (re, mult) => {
    let t = text, m;
    while ((m = re.exec(t))) {
      total += parseFloat(m[1]) * mult;
      t = t.slice(m.index + m[0].length);
    }
  };
  add(day, 24 * 60);
  add(hour, 60);
  add(min, 1);

  // compact forms like "1h30m" / "1h 30"
  const compact = text.match(/(\d+)\s*h(?:\s*(\d+)\s*m?)?/);
  if (compact) {
    total = Math.max(total, (parseInt(compact[1]) * 60) + (parseInt(compact[2] || "0")));
  }

  // numbers only, with "ready in 45 minutes"
  const plain = text.match(/\b(\d{1,3})\s*minutes?\b/);
  if (plain) total = Math.max(total, parseInt(plain[1]));

  return Math.round(total);
}

/* -------------------------- Heuristic dictionaries -------------------------- */
const UNITS = [
  "teaspoon","teaspoons","tsp","t","tablespoon","tablespoons","tbsp","T",
  "cup","cups","c",
  "pint","pints","pt","quart","quarts","qt","gallon","gallons","gal",
  "milliliter","milliliters","ml","liter","liters","l",
  "ounce","ounces","oz","pound","pounds","lb","lbs","gram","grams","g","kilogram","kilograms","kg",
  "clove","cloves","can","cans","package","packages","pkg","slice","slices","stick","sticks",
  "pinch","dash"
].map((s)=>s.toLowerCase());

const COOKING_VERBS = [
  "preheat","mix","stir","combine","whisk","beat","fold","bake","roast","grill","boil","simmer","saute","sauté","fry",
  "pour","add","season","marinate","chop","slice","dice","peel","press","serve","garnish","transfer","let","cool","reduce",
  "cover","uncover","cook","knead","proof","rest","roll","divide","spread","sprinkle","drizzle","blend","process"
];

const SECTION_HINTS = /(for the|make the|prepare the|assembly|topping|filling|dough|sauce|glaze|optional)/i;

const STOP_HEADINGS = /(nutrition|notes?|faq|tips|equipment|more recipes|sponsored|related)/i;

/* --------------------------- Ingredient classifier -------------------------- */
function isIngredientLike(line) {
  const s = line.trim();
  if (!s) return 0;

  // bullets/numbers
  let score = /^[-*•\u2022]/.test(s) ? 1 : 0;
  score += /^\d+[\).]/.test(s) ? 0.5 : 0;

  // qty at start: "1", "1/2", "1 1/2", "½", "1-2"
  if (/^(\d+([\/\-]\d+)?|\d+\s+\d+\/\d+|[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])\b/.test(s)) score += 2.5;

  // unit present near begin
  if (new RegExp(`\\b(${UNITS.join("|")})\\b`, "i").test(s)) score += 2;

  // cooking verbs at beginning reduce ingredient-likeness
  if (new RegExp(`^(${COOKING_VERBS.join("|")})\\b`, "i").test(s)) score -= 2.5;

  // contains comma note "chopped", "softened" => slight bonus
  if (/\b(chopped|minced|softened|room temperature|melted|divided)\b/i.test(s)) score += 0.5;

  // very long sentences are less likely ingredients
  if (s.length > 140) score -= 1;

  return score;
}

/* ---------------------------- Instruction classifier ------------------------ */
function isInstructionLike(line) {
  const s = line.trim();
  if (!s) return 0;

  let score = 0;

  // numbered steps
  if (/^\s*(\d+[\).]|step\s*\d+[:.)]?)/i.test(s)) score += 2.5;

  // imperative verb start
  if (new RegExp(`^(${COOKING_VERBS.join("|")})\\b`, "i").test(s)) score += 2.5;

  // sentences end with period; include times/temps
  if (/[.!]$/.test(s)) score += 0.6;
  if (/\b(\d+\s*(minutes?|hours?|secs?))\b/i.test(s)) score += 0.6;
  if (/\b(\d{2,3})\s*°\s*[CF]?|\b(°c|°f)\b/i.test(s)) score += 0.6;

  // ingredient-like at start reduces instruction-likeness
  if (isIngredientLike(s) >= 2.5) score -= 1.5;

  // too short or very long
  if (s.length < 12) score -= 0.8;
  if (s.length > 300) score -= 0.6;

  return score;
}

/* ------------------------------ Line tokenizers ----------------------------- */
function tokenizeTextToLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------- Ingredient line parser --------------------------- */
function parseIngredientLine(line) {
  const original = String(line || "").trim();

  // Simple split: quantity + unit + name (+ note)
  const m = original.match(
    /^\s*(?:(\d+(?:\.\d+)?)\s+(\d+\/\d+))|(\d+\s*\-\s*\d+)|(\d+\s+\d+\/\d+)|(\d+\/\d+)|(\d+(?:\.\d+)?)|([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/
  );
  let quantity;
  let head = original;

  if (m) {
    const candidate = m[0].trim();
    // Try mixed/frac/number/Unicode
    quantity =
      fracToDecimal(candidate) ||
      (candidate.includes("/") ? (() => {
        // 1/2 or 1 1/2
        const parts = candidate.split(/\s+/);
        if (parts.length === 2) {
          const whole = parseFloat(parts[0]) || 0;
          const f = parts[1].split("/");
          return whole + (parseFloat(f[0]) / parseFloat(f[1]));
        }
        if (parts.length === 1 && candidate.includes("/")) {
          const f = candidate.split("/");
          return parseFloat(f[0]) / parseFloat(f[1]);
        }
        return parseFloat(candidate);
      })() : parseFloat(candidate)) ||
      undefined;

    head = original.slice(candidate.length).trim();
  }

  const unitMatch = head.match(new RegExp(`^(${UNITS.join("|")})\\b`, "i"));
  const unit = unitMatch ? unitMatch[0].toLowerCase() : undefined;
  const rest = unitMatch ? head.slice(unitMatch[0].length).trim() : head;

  // Pull out trailing notes after comma/parentheses
  let name = rest;
  let note;
  const noteParens = name.match(/\(([^)]+)\)\s*$/);
  if (noteParens) {
    note = noteParens[1].trim();
    name = name.slice(0, noteParens.index).trim();
  }
  const noteComma = name.match(/,\s*(.*)$/);
  if (noteComma) {
    note = (note ? `${note}; ` : "") + noteComma[1].trim();
    name = name.slice(0, noteComma.index).trim();
  }

  return { original, quantity, unit, name, note };
}

/* ---------------------------- Servings / Times ------------------------------ */
function parseServings(text) {
  const s = String(text || "").toLowerCase();
  const m =
    s.match(/\bserves?\s+(\d+(?:\.\d+)?)/) ||
    s.match(/\byields?\s+(\d+(?:\.\d+)?)/) ||
    s.match(/\b(\d+(?:\.\d+)?)\s*(servings?|people|portions?)\b/);
  return m ? parseFloat(m[1]) : undefined;
}

function parseTimesFromText(text) {
  const s = String(text || "");
  const total =
    minutesFromText((s.match(/total(?:\s*time)?[:\s]+([^.\n]+)/i) || [])[1]) ||
    minutesFromText((s.match(/ready(?:\s*in)?[:\s]+([^.\n]+)/i) || [])[1]);
  const prep = minutesFromText((s.match(/prep(?:aration)?(?:\s*time)?[:\s]+([^.\n]+)/i) || [])[1]);
  const cook = minutesFromText((s.match(/cook(?:ing)?(?:\s*time)?[:\s]+([^.\n]+)/i) || [])[1]);
  return {
    prepMinutes: clamp(prep, 0, 24 * 60),
    cookMinutes: clamp(cook, 0, 24 * 60),
    totalMinutes: clamp(total || (prep + cook) || 0, 0, 7 * 24 * 60),
  };
}

/* -------------------------- Block extraction (DOM) -------------------------- */
function pickLikelyContentRoot($) {
  // Score common recipe containers; fallback to article/main
  const candidates = [
    'section.recipe', 'article.recipe', '.recipe', '#recipe',
    '.post-content', '.entry-content', '.content', 'main article', 'article', 'main', 'body'
  ];
  let best = null, bestScore = -1;

  $(candidates.join(",")).each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    const score =
      (text.match(/\bingredient/i) ? 2 : 0) +
      (text.match(/\binstruction|directions|method/i) ? 2 : 0) +
      Math.min(5, Math.floor(text.length / 1000));
    if (score > bestScore) { best = $el; bestScore = score; }
  });

  return best || $("body");
}

function harvestListsAndHeadings($root) {
  const items = [];

  // Exclude obvious boilerplate
  $root.find("script,style,noscript,svg,iframe,header,footer,nav,aside,form,button,figure figcaption,.share,.ads, .advert, .wp-block-embed").remove();

  // capture headings + lists + paragraphs in order
  $root.children().each(function walk(_, node) {
    const $n = cheerio(node);
    const tag = ($n[0]?.tagName || "").toLowerCase();

    if (/h[1-6]/.test(tag)) {
      const text = $n.text().trim();
      if (text && !STOP_HEADINGS.test(text)) items.push({ type: "heading", text });
    } else if (tag === "ul" || tag === "ol") {
      const lines = $n.find("li").map((i, li) => cheerio(li).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
      if (lines.length) items.push({ type: "list", ordered: tag === "ol", lines });
    } else if (tag === "p" || tag === "div" || tag === "section" || tag === "article") {
      const text = $n.text().replace(/\s+/g, " ").trim();
      if (text) items.push({ type: "para", text });
    }

    // Recurse
    const children = $n.children();
    if (children && children.length) children.each(walk);
  });

  return items;
}

/* -------------------------- Heuristic core assembly ------------------------- */
function buildFromLines(lines) {
  const ingredients = [];
  const steps = [];

  // Try section grouping
  let inIngredientsBlock = false;
  let currentSection = null;

  const pushStep = (text) => {
    if (!text) return;
    if (currentSection) {
      currentSection.items.push({ type: "step", text });
    } else {
      steps.push({ type: "step", text });
    }
  };

  const startSection = (title) => {
    if (currentSection) {
      steps.push(currentSection);
    }
    currentSection = { type: "section", title, items: [] };
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;

    // Headings that hint sections
    if (SECTION_HINTS.test(line) && line.length < 80) {
      startSection(line.replace(/:$/,""));
      continue;
    }

    const iScore = isIngredientLike(line);
    const sScore = isInstructionLike(line);

    if (iScore >= 2 && iScore > sScore) {
      inIngredientsBlock = true;
      ingredients.push(parseIngredientLine(line.replace(/^[-*•\u2022]\s*/,"")));
      continue;
    }

    if (sScore >= 1.5 && sScore >= iScore) {
      pushStep(line);
      continue;
    }

    // If we are inside an ingredient block & the line looks shortish, assume it's an ingredient continuation
    if (inIngredientsBlock && line.length <= 120) {
      ingredients.push(parseIngredientLine(line));
      continue;
    }

    // Otherwise, defer: if it ends with a period, it's probably a step
    if (/[.!]$/.test(line) || sScore > 0.8) {
      pushStep(line);
    }
  }

  // Flush last open section
  if (currentSection) steps.push(currentSection);

  return { ingredients, steps };
}

/* ------------------------------ Public extractors --------------------------- */
function extractFromText(text, { url } = {}) {
  const warnings = [];
  const lines = tokenizeTextToLines(text);

  // Rough pass to isolate likely “Ingredients” and “Instructions” segments by headers
  let inIng = false, inInst = false;
  const ingLines = [], instLines = [];
  const otherLines = [];

  for (const ln of lines) {
    const low = ln.toLowerCase();
    if (/^ingredients?\b/.test(low)) { inIng = true; inInst = false; continue; }
    if (/^(instructions?|directions?|method)\b/.test(low)) { inInst = true; inIng = false; continue; }
    if (STOP_HEADINGS.test(low)) { inIng = false; inInst = false; continue; }

    if (inIng) ingLines.push(ln);
    else if (inInst) instLines.push(ln);
    else otherLines.push(ln);
  }

  const ingBuild = buildFromLines(ingLines.length ? ingLines : lines);
  const instBuild = buildFromLines(instLines.length ? instLines : lines);

  const ingredients = ingLines.length ? ingBuild.ingredients : ingBuild.ingredients;
  const instructions = instLines.length ? instBuild.steps : instBuild.steps;

  // Servings / times sniff
  const allText = text;
  const servings = parseServings(allText);
  const times = parseTimesFromText(allText);

  if (!ingredients.length) warnings.push("No ingredients detected via heuristics.");
  if (!instructions.length) warnings.push("No instructions detected via heuristics.");

  return {
    ingredients,
    instructions,
    servings,
    yieldText: servings ? `${servings} servings` : undefined,
    times,
    warnings,
    sources: { kind: "heuristics", url },
  };
}

function extractFromHtml(html, { url } = {}) {
  if (!html || typeof html !== "string") {
    return { ingredients: [], instructions: [], warnings: ["No HTML provided"], sources: { kind: "heuristics", url } };
  }
  const warnings = [];

  // If cheerio available → DOM strategy
  if (cheerio) {
    try {
      const $ = cheerio.load(html);
      const $root = pickLikelyContentRoot($);
      const blocks = harvestListsAndHeadings($root);

      // Convert lists/paras to candidate lines
      const lines = [];
      for (const b of blocks) {
        if (b.type === "heading") {
          lines.push(b.text);
        } else if (b.type === "list") {
          lines.push(...b.lines);
        } else if (b.type === "para") {
          // split paragraphs into sentences-ish
          const parts = b.text.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((x)=>x.trim()).filter(Boolean);
          lines.push(...parts);
        }
      }

      const textFallback = stripHtml(html);
      const combinedLines = lines.length ? lines : tokenizeTextToLines(textFallback);

      const { ingredients, steps } = buildFromLines(combinedLines);
      const allText = $root.text().trim() || textFallback;

      const servings = parseServings(allText);
      const times = parseTimesFromText(allText);

      if (!ingredients.length) warnings.push("No ingredients detected via DOM heuristics.");
      if (!steps.length) warnings.push("No instructions detected via DOM heuristics.");

      return {
        ingredients,
        instructions: steps,
        servings,
        yieldText: servings ? `${servings} servings` : undefined,
        times,
        warnings,
        sources: { kind: "heuristics", url },
      };
    } catch (e) {
      warnings.push(`DOM parse failed: ${e.message || e}`);
      // fall through to text fallback
    }
  }

  // Fallback: HTML → text and reuse text extractor
  const text = stripHtml(html);
  const out = extractFromText(text, { url });
  out.warnings = uniq([...(out.warnings || []), "Cheerio not available or DOM parse failed; used text fallback."]);
  return out;
}

/* --------------------------------- Exports --------------------------------- */
module.exports = {
  extractFromHtml,
  extractFromText,
  // helpers
  parseServings,
  parseTimesFromText,
  parseIngredientLine,
};
