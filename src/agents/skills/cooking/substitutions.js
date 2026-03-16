/**
 * src/agents/skills/cooking/substitutions.js
 *
 * How this fits:
 * - Used by cooking Session composition and the SessionRunner's "tips" pane to suggest
 *   ingredient substitutions when inventory guard blocks progress or the user requests swaps.
 * - First queries the local, constraint-aware substitution table (fast, offline).
 * - If results are empty or low-confidence, optionally falls back to the Reasoner for suggestions.
 * - Keeps data Torah-safe by default (excludes pork/shellfish/unclean fats). Can be relaxed via options.
 *
 * Contracts:
 * - Returns a normalized array of suggestions: { for, substitute, ratio, notes, confidence, flags, source }
 *   where:
 *     - ratio: numeric multiplier by weight/volume (1 = 1:1), or {from: "1 cup", to:"1 cup"} for explicit forms
 *     - flags: { dairy?:boolean, nut?:boolean, gluten?:boolean, torahSafe?:boolean, allergen?:string[] }
 *     - source: "local" | "reasoner"
 *
 * Extension points:
 * - registerSubstitutions() to extend the local table at runtime.
 * - setReasoner() to plug in any async reasoning backend (LLM, rules engine, etc.).
 * - addCanonicalizer() to improve name matching.
 */

import { emit } from "../../../services/events/eventBus.js"; // optional: emit 'substitution.queried' etc. (not required)
let reasoner = null; // Optional async fallback; set via setReasoner(fn)

/** ----------------------------- Canonicalization --------------------------- */

/** Built-in canonicalizers; can be extended at runtime */
const canonicalizers = [
  // Lowercase & trim
  (s) => s.toLowerCase().trim(),
  // Strip punctuation
  (s) =>
    s
      .replace(/[().,/-]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  // Singularize simple plurals
  (s) =>
    s
      .replace(/\b(tomatoes)\b/g, "tomato")
      .replace(/\b(potatoes)\b/g, "potato")
      .replace(/\b(eggs)\b/g, "egg")
      .replace(/\b(onions)\b/g, "onion"),
  // Aliases
  (s) => ALIASES[s] || s,
];

/** Simple alias map for common names */
const ALIASES = {
  scallion: "green onion",
  "spring onion": "green onion",
  "bell pepper": "sweet pepper",
  capsicum: "sweet pepper",
  "brown sugar": "light brown sugar",
  "caster sugar": "superfine sugar",
  "bicarbonate of soda": "baking soda",
  cornflour: "cornstarch",
  "confectioners sugar": "powdered sugar",
  "icing sugar": "powdered sugar",
  "minced beef": "ground beef",
  "minced lamb": "ground lamb",
  garbanzo: "chickpea",
  "garbanzo bean": "chickpea",
  courgette: "zucchini",
  aubergine: "eggplant",
  cilantro: "coriander leaf",
  "coriander leaves": "coriander leaf",
};

/** Public: add a canonicalizer */
export function addCanonicalizer(fn) {
  if (typeof fn === "function") canonicalizers.push(fn);
}

/** Canonicalize an ingredient name for table lookup */
export function canonicalizeIngredient(name) {
  if (!name || typeof name !== "string") return "";
  return canonicalizers.reduce((acc, fn) => {
    try {
      return fn(acc);
    } catch {
      return acc;
    }
  }, name);
}

/** ------------------------------- Constraints ------------------------------ */

/**
 * @typedef {Object} Constraints
 * @property {boolean} [dairyFree]
 * @property {boolean} [nutFree]
 * @property {boolean} [glutenFree]
 * @property {boolean} [torahSafe]  // default true
 * @property {string[]} [allergens] // e.g., ["sesame","soy","peanut"]
 * @property {("baking"|"savory"|"sweet"|"grilling"|"frying"|"soup"|"stew")} [context]
 * @property {("volume"|"weight")} [measureBias] // prefer ratio format
 */

/** Disallowed by Torah-safe mode; keep small and explicit. */
const TORAH_UNCLEAN = new Set([
  "pork",
  "ham",
  "bacon",
  "prosciutto",
  "lard (porcine)",
  "gelatin (porcine)",
  "gelatin (fish-unknown)",
  "shrimp",
  "crab",
  "lobster",
  "clam",
  "oyster",
  "scallop",
  "squid",
  "octopus",
]);

/** Flag helpers */
function applyDietaryGuards(suggestion, constraints) {
  const flags = suggestion.flags || {};
  const allergens = new Set([...(flags.allergen || [])]);
  if (constraints?.nutFree && flags.nut) suggestion._reject = true;
  if (constraints?.dairyFree && flags.dairy) suggestion._reject = true;
  if (constraints?.glutenFree && flags.gluten) suggestion._reject = true;
  if (Array.isArray(constraints?.allergens)) {
    for (const a of constraints.allergens)
      if (allergens.has(a)) suggestion._reject = true;
  }
  const torahSafe = constraints?.torahSafe !== false; // default true
  if (torahSafe && (!("torahSafe" in flags) || flags.torahSafe === false)) {
    // If we can determine it's unclean by name, reject.
    const name = (suggestion.substitute?.name || "").toLowerCase();
    if ([...TORAH_UNCLEAN].some((u) => name.includes(u)))
      suggestion._reject = true;
  }
  return suggestion;
}

/** --------------------------- Local Substitution DB ------------------------ */

/**
 * Structure:
 *  key: canonical "for" ingredient
 *  value: array of normalized suggestions
 *  Notes:
 *  - Keep suggestions short and explicit; prefer 1:1 unless there's a known ratio.
 *  - confidence: 0..1 (local entries typically 0.7–0.95)
 *  - flags indicate allergens and kosher/Torah safety.
 */
const TABLE = new Map();

/** Seed the table with sensible, Torah-safe defaults and SSA household preferences (lamb/goat). */
seedLocalTable();

/** Public: add/merge substitutions at runtime */
export function registerSubstitutions(forName, suggestions) {
  const key = canonicalizeIngredient(forName);
  if (!key) return;
  const curr = TABLE.get(key) || [];
  const normalized = (Array.isArray(suggestions) ? suggestions : [suggestions])
    .map(normSuggestion)
    .filter(Boolean);
  TABLE.set(key, dedupeByName([...curr, ...normalized]));
}

/** ------------------------------- Public API ------------------------------- */

/**
 * Find substitution suggestions for an ingredient.
 * Tries local table first. If none or low coverage, optionally asks Reasoner.
 *
 * @param {string} forName - target ingredient name from recipe
 * @param {Constraints} [constraints]
 * @param {{useReasoner?:boolean, minLocalCount?:number, minLocalConfidence?:number}} [options]
 * @returns {Promise<Array<SubSuggestion>>}
 */
export async function findSubstitutions(
  forName,
  constraints = {},
  options = {}
) {
  const key = canonicalizeIngredient(forName);
  const useReasoner = options.useReasoner !== false; // default true
  const minLocalCount = options.minLocalCount ?? 1;
  const minLocalConfidence = options.minLocalConfidence ?? 0.55;

  // Local
  let local = (TABLE.get(key) || [])
    .map(clone)
    .map((s) => applyDietaryGuards(s, constraints))
    .filter((s) => !s._reject)
    .map((s) => formatMeasureBias(s, constraints?.measureBias));

  // Heuristic: if we only have few or low-confidence options, augment with Reasoner if available
  const needReasoner =
    useReasoner &&
    (!local.length ||
      local.length < minLocalCount ||
      Math.max(...local.map((s) => s.confidence), 0) < minLocalConfidence);

  let remote = [];
  if (needReasoner && typeof reasoner === "function") {
    try {
      remote =
        (await reasoner({
          for: forName,
          canonicalKey: key,
          constraints: {
            ...constraints,
            torahSafe: constraints?.torahSafe !== false,
          },
        })) || [];
      remote = remote
        .map(normSuggestion)
        .map((s) => ({ ...s, source: s.source || "reasoner" }));
      remote = remote
        .map((s) => applyDietaryGuards(s, constraints))
        .filter((s) => !s._reject);
    } catch (e) {
      // Silent failure by contract
      // console.warn("[substitutions] Reasoner failed:", e);
      remote = [];
    }
  }

  const merged = dedupeByName([...local, ...remote]);
  // Optional event emission for analytics/UX
  try {
    emit?.({
      type: "substitution.queried",
      ts: new Date().toISOString(),
      source: "cooking.substitutions",
      data: {
        for: forName,
        canonicalKey: key,
        localCount: local.length,
        remoteCount: remote.length,
      },
    });
  } catch {}

  return merged;
}

/** Allow the app to provide a custom Reasoner (async fn) */
export function setReasoner(fn) {
  if (typeof fn === "function") reasoner = fn;
}

/** ------------------------------- Normalizers ------------------------------ */

/**
 * @typedef {Object} SubSuggestion
 * @property {{ name:string, form?:string }} for
 * @property {{ name:string, form?:string }} substitute
 * @property {number|{from:string,to:string}} ratio
 * @property {string} [notes]
 * @property {number} [confidence] // 0..1
 * @property {{ dairy?:boolean, nut?:boolean, gluten?:boolean, torahSafe?:boolean, allergen?:string[] }} [flags]
 * @property {"local"|"reasoner"} [source]
 */

function normSuggestion(s) {
  if (!s || typeof s !== "object") return null;
  const forName = canonicalizeIngredient(s.for?.name || s.for);
  const subName = canonicalizeIngredient(s.substitute?.name || s.substitute);
  if (!forName || !subName) return null;
  const out = {
    for: { name: forName, ...(s.for?.form ? { form: s.for.form } : {}) },
    substitute: {
      name: subName,
      ...(s.substitute?.form ? { form: s.substitute.form } : {}),
    },
    ratio: normalizeRatio(s.ratio),
    notes: s.notes || "",
    confidence: clampNum(s.confidence, 0, 1, 0.75),
    flags: {
      ...(s.flags || {}),
      torahSafe: inferTorahSafety(subName, s.flags),
    },
    source: s.source || "local",
  };
  return out;
}

function normalizeRatio(r) {
  if (r == null) return 1;
  if (typeof r === "number" && isFinite(r) && r > 0) return r;
  if (
    r &&
    typeof r === "object" &&
    typeof r.from === "string" &&
    typeof r.to === "string"
  )
    return { from: r.from, to: r.to };
  return 1;
}

function clampNum(n, min, max, fallback) {
  return typeof n === "number" && isFinite(n)
    ? Math.max(min, Math.min(n, max))
    : fallback;
}

function inferTorahSafety(name, flags) {
  if (flags && typeof flags.torahSafe === "boolean") return flags.torahSafe;
  const n = (name || "").toLowerCase();
  return ![...TORAH_UNCLEAN].some((u) => n.includes(u));
}

function formatMeasureBias(s, measureBias) {
  if (!measureBias || typeof s.ratio !== "number") return s;
  if (measureBias === "volume") return s; // leave numeric (interpreted as 1:1 by volume)
  if (measureBias === "weight") return s; // numeric works for weight too; UI can label
  return s;
}

function dedupeByName(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const key = `${s.for.name}__${s.substitute.name}__${
      typeof s.ratio === "number" ? s.ratio : JSON.stringify(s.ratio)
    }`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

function clone(v) {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}

/** ------------------------------- Seeding ---------------------------------- */

function seedLocalTable() {
  // Helper to bulk add
  const add = (forName, list) => registerSubstitutions(forName, list);

  // Oils & fats (Torah-safe)
  add("butter", [
    {
      for: "butter",
      substitute: { name: "olive oil" },
      ratio: 0.75,
      notes: "Use 3/4 oil per 1 butter (by volume). Baking may change texture.",
      flags: { dairy: false },
    },
    {
      for: "butter",
      substitute: { name: "ghee" },
      ratio: 1,
      notes: "Clarified; similar flavor. Check dairy constraints.",
      flags: { dairy: true },
    },
    {
      for: "butter",
      substitute: { name: "coconut oil" },
      ratio: 1,
      notes: "Solid at room temp; works in baking.",
      flags: { nut: false, dairy: false },
    },
  ]);

  // Milk & cream
  add("milk", [
    {
      for: "milk",
      substitute: { name: "oat milk" },
      ratio: 1,
      notes: "Neutral flavor, good in sauces.",
      flags: { dairy: false },
    },
    {
      for: "milk",
      substitute: { name: "almond milk" },
      ratio: 1,
      notes: "Slight nut flavor.",
      flags: { dairy: false, nut: true, allergen: ["almond"] },
    },
    {
      for: "milk",
      substitute: { name: "soy milk" },
      ratio: 1,
      notes: "Higher protein; may curdle with acid.",
      flags: { dairy: false, allergen: ["soy"] },
    },
  ]);

  add("heavy cream", [
    {
      for: "heavy cream",
      substitute: { name: "evaporated milk" },
      ratio: 1,
      notes: "Lighter body than cream.",
      flags: { dairy: true },
    },
    {
      for: "heavy cream",
      substitute: { name: "coconut cream" },
      ratio: 1,
      notes: "Dairy-free; coconut aroma.",
      flags: { dairy: false },
    },
    {
      for: "heavy cream",
      substitute: { name: "milk + butter" },
      ratio: { from: "3/4 cup milk", to: "1/4 cup melted butter" },
      notes: "Mix to approximate fat content.",
      flags: { dairy: true },
    },
  ]);

  // Eggs (baking)
  add("egg", [
    {
      for: "egg",
      substitute: {
        name: "ground flax + water",
        form: "1 tbsp flax + 3 tbsp water",
      },
      ratio: { from: "1 egg", to: "1 flax egg" },
      notes: "Bind & moisture; not for meringue.",
      flags: { dairy: false },
    },
    {
      for: "egg",
      substitute: { name: "applesauce (unsweetened)" },
      ratio: { from: "1 egg", to: "1/4 cup" },
      notes: "Moisture; reduce sugar slightly.",
      flags: {},
    },
    {
      for: "egg",
      substitute: { name: "silken tofu (blended)" },
      ratio: { from: "1 egg", to: "1/4 cup" },
      notes: "Neutral; good binder in cakes.",
      flags: { allergen: ["soy"] },
    },
  ]);

  // Flours
  add("all-purpose flour", [
    {
      for: "all-purpose flour",
      substitute: { name: "bread flour" },
      ratio: 1,
      notes: "Higher protein; chewier.",
      flags: { gluten: true },
    },
    {
      for: "all-purpose flour",
      substitute: { name: "spelt flour" },
      ratio: 1,
      notes: "Nutty flavor; lower gluten strength.",
      flags: { gluten: true },
    },
    {
      for: "all-purpose flour",
      substitute: { name: "gluten-free blend" },
      ratio: 1,
      notes: "Use a 1:1 baking blend with xanthan.",
      flags: { gluten: false },
    },
  ]);

  // Sweeteners
  add("granulated sugar", [
    {
      for: "granulated sugar",
      substitute: { name: "light brown sugar" },
      ratio: 1,
      notes: "Adds molasses flavor & moisture.",
    },
    {
      for: "granulated sugar",
      substitute: { name: "honey" },
      ratio: 0.75,
      notes: "Use 3/4 honey; reduce liquid slightly; lower bake temp ~25°F.",
    },
    {
      for: "granulated sugar",
      substitute: { name: "maple syrup" },
      ratio: 0.75,
      notes: "Reduce liquid ~3 tbsp per cup syrup.",
    },
  ]);

  // Aromatics & herbs
  add("fresh garlic", [
    {
      for: "fresh garlic",
      substitute: { name: "garlic powder" },
      ratio: { from: "1 clove", to: "1/4 tsp" },
      notes: "Bloom in fat for best flavor.",
    },
    {
      for: "fresh garlic",
      substitute: { name: "granulated garlic" },
      ratio: { from: "1 clove", to: "1/3 tsp" },
      notes: "Slightly coarser than powder.",
    },
    {
      for: "fresh garlic",
      substitute: { name: "shallot" },
      ratio: 1,
      notes: "Different profile; milder sweetness.",
    },
  ]);

  add("onion", [
    {
      for: "onion",
      substitute: { name: "shallot" },
      ratio: 1,
      notes: "Sweeter, less pungent.",
    },
    {
      for: "onion",
      substitute: { name: "leek (white part)" },
      ratio: 1,
      notes: "Delicate, great in soups.",
    },
    {
      for: "onion",
      substitute: { name: "green onion" },
      ratio: 1,
      notes: "Use more white portion for aromatics.",
    },
  ]);

  // Acids
  add("lemon juice", [
    {
      for: "lemon juice",
      substitute: { name: "white wine vinegar" },
      ratio: 0.5,
      notes: "Vinegar is stronger; start with half.",
    },
    {
      for: "lemon juice",
      substitute: { name: "apple cider vinegar" },
      ratio: 0.5,
      notes: "Fruity tang.",
    },
    {
      for: "lemon juice",
      substitute: { name: "lime juice" },
      ratio: 1,
      notes: "Similar acidity; different aroma.",
    },
  ]);

  // Salts & umami (Torah-safe, fish-safe optional)
  add("anchovy", [
    {
      for: "anchovy",
      substitute: { name: "miso paste" },
      ratio: 1,
      notes: "Umami depth without fish; watch salt.",
      flags: { allergen: ["soy"] },
    },
    {
      for: "anchovy",
      substitute: { name: "olive tapenade" },
      ratio: 1,
      notes: "Briny, savory profile.",
    },
    {
      for: "anchovy",
      substitute: { name: "fish sauce" },
      ratio: 1,
      notes: "If allowed; intense—use sparingly.",
      flags: {},
    },
  ]);

  // Meat preferences (lamb/goat → beef, and vice versa)
  add("ground beef", [
    {
      for: "ground beef",
      substitute: { name: "ground lamb" },
      ratio: 1,
      notes: "Richer flavor; great in stews/kofta.",
      flags: {},
    },
    {
      for: "ground beef",
      substitute: { name: "ground goat" },
      ratio: 1,
      notes: "Lean; don’t overcook.",
      flags: {},
    },
    {
      for: "ground beef",
      substitute: { name: "ground turkey (dark)" },
      ratio: 1,
      notes: "Lean; add fat or moisture.",
      flags: {},
    },
  ]);

  add("ground lamb", [
    {
      for: "ground lamb",
      substitute: { name: "ground beef" },
      ratio: 1,
      notes: "Milder, widely available.",
      flags: {},
    },
    {
      for: "ground lamb",
      substitute: { name: "ground goat" },
      ratio: 1,
      notes: "Similar to lamb; leaner.",
      flags: {},
    },
  ]);

  add("goat", [
    {
      for: "goat",
      substitute: { name: "lamb" },
      ratio: 1,
      notes: "Comparable flavor; adjust fat.",
    },
    {
      for: "goat",
      substitute: { name: "beef chuck" },
      ratio: 1,
      notes: "For stews; longer braise ok.",
    },
  ]);

  // Broths
  add("chicken broth", [
    {
      for: "chicken broth",
      substitute: { name: "vegetable broth" },
      ratio: 1,
      notes: "Neutral; add umami (miso/mushroom).",
    },
    {
      for: "chicken broth",
      substitute: { name: "water + bouillon" },
      ratio: 1,
      notes: "Adjust salt to taste.",
    },
  ]);

  // Thickeners
  add("cornstarch", [
    {
      for: "cornstarch",
      substitute: { name: "arrowroot starch" },
      ratio: 1,
      notes: "Glossy finish; avoid long boil.",
    },
    {
      for: "cornstarch",
      substitute: { name: "potato starch" },
      ratio: 1,
      notes: "Good freeze-thaw stability.",
    },
    {
      for: "cornstarch",
      substitute: { name: "all-purpose flour" },
      ratio: 2,
      notes: "Use ~2x flour vs cornstarch; simmer to cook out.",
    },
  ]);

  // Spice stand-ins (examples)
  add("cumin", [
    {
      for: "cumin",
      substitute: { name: "coriander seed" },
      ratio: 1,
      notes: "Lighter citrusy tone.",
    },
    {
      for: "cumin",
      substitute: { name: "caraway" },
      ratio: 0.75,
      notes: "Stronger; start with less.",
    },
    {
      for: "cumin",
      substitute: { name: "chili powder (blend)" },
      ratio: 1,
      notes: "Contains cumin; adjust salt.",
    },
  ]);
}

/** ------------------------------- Utilities -------------------------------- */

function dedupeStr(a) {
  return Array.from(new Set(a));
}

// ✅ FIX: Removed the duplicate dedupeByName definition that caused
// "The symbol 'dedupeByName' has already been declared" during build.
// (The primary dedupeByName implementation already exists above.)

/** ------------------------------- Reasoner --------------------------------- */

/**
 * Default Reasoner bridge (optional). You should provide a real implementation elsewhere:
 *   setReasoner(async ({ for, canonicalKey, constraints }) => Array<SubSuggestion>)
 *
 * Example integration (not included here):
 *   import { askReasoner } from "@/agents/runtime/reasoner";
 *   setReasoner(askReasoner);
 */

/** ------------------------------- Exports ---------------------------------- */

export default {
  findSubstitutions,
  registerSubstitutions,
  setReasoner,
  canonicalizeIngredient,
  addCanonicalizer,
};
