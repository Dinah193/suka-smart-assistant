// C:\Users\larho\suka-smart-assistant\src\services\ingredients\IngredientPreferenceChecker.js
// -----------------------------------------------------------------------------
// IngredientPreferenceChecker
// - Compares ingredients against household shopping preferences
// - Returns a stable "ingredientsCheck" payload used by ShoppingCandidateCard
//
// Output shape:
// {
//   ok: boolean,
//   flags: [{ type, severity, label, match, ruleId }],
//   allergens: [...],
//   additives: [...],
//   notes: string[]
// }
//
// Preferences supported (see PreferenceResolver update):
// patch.shopping = {
//   avoidIngredients: ["red 40", ...],
//   requireIngredients: ["whole grain", ...],
//   allergens: { avoid: ["peanut","milk"], warn: ["soy"] },
//   additives: { avoid: ["msg"], warn: ["natural flavors"] },
//   brandBans: ["BrandName"],
//   upcBans: ["012345..."],
// }
//
// -----------------------------------------------------------------------------

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function uniq(arr) {
  return Array.from(
    new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean))
  );
}

export function checkIngredientsAgainstPreferences({
  ingredients = null, // { ingredientsText, ingredientsList, allergens, additives }
  preferencesPatch = {}, // merged patch from PreferenceResolver
  item = null, // { brand, upc, title }
} = {}) {
  const pref = preferencesPatch?.shopping || {};
  const notes = [];
  const flags = [];

  const upc = String(item?.upc || "").trim();
  const brand = String(item?.brand || "").trim();

  // hard bans
  if (Array.isArray(pref.upcBans) && upc && pref.upcBans.includes(upc)) {
    flags.push(flag("ban", "high", "Banned UPC", upc, "upcBans"));
  }
  if (
    Array.isArray(pref.brandBans) &&
    brand &&
    pref.brandBans.some((b) => norm(b) === norm(brand))
  ) {
    flags.push(flag("ban", "high", "Banned brand", brand, "brandBans"));
  }

  const ingText = norm(ingredients?.ingredientsText || "");
  const ingList = Array.isArray(ingredients?.ingredientsList)
    ? ingredients.ingredientsList.map(norm)
    : [];
  const allTokens = tokenBag(ingText, ingList);

  // avoid ingredients
  for (const a of uniq(pref.avoidIngredients)) {
    const needle = norm(a);
    if (!needle) continue;
    if (hasToken(allTokens, needle))
      flags.push(
        flag("avoid", "high", "Avoid ingredient", a, "avoidIngredients")
      );
  }

  // require ingredients (if specified, absence is a "warn" flag)
  const req = uniq(pref.requireIngredients);
  if (req.length) {
    for (const r of req) {
      const needle = norm(r);
      if (!needle) continue;
      if (!hasToken(allTokens, needle))
        flags.push(
          flag(
            "require",
            "medium",
            "Missing preferred ingredient",
            r,
            "requireIngredients"
          )
        );
    }
  }

  // allergens
  const allergensAvoid = uniq(pref?.allergens?.avoid);
  const allergensWarn = uniq(pref?.allergens?.warn);
  const ingAllergens = Array.isArray(ingredients?.allergens)
    ? ingredients.allergens.map(norm)
    : [];

  for (const a of allergensAvoid) {
    const needle = norm(a);
    if (!needle) continue;
    if (hasToken(allTokens, needle) || ingAllergens.includes(needle)) {
      flags.push(
        flag("allergen", "high", "Allergen (avoid)", a, "allergens.avoid")
      );
    }
  }
  for (const a of allergensWarn) {
    const needle = norm(a);
    if (!needle) continue;
    if (hasToken(allTokens, needle) || ingAllergens.includes(needle)) {
      flags.push(
        flag("allergen", "medium", "Allergen (warn)", a, "allergens.warn")
      );
    }
  }

  // additives
  const additivesAvoid = uniq(pref?.additives?.avoid);
  const additivesWarn = uniq(pref?.additives?.warn);
  const ingAdditives = Array.isArray(ingredients?.additives)
    ? ingredients.additives.map(norm)
    : [];

  for (const a of additivesAvoid) {
    const needle = norm(a);
    if (!needle) continue;
    if (hasToken(allTokens, needle) || ingAdditives.includes(needle)) {
      flags.push(
        flag("additive", "high", "Additive (avoid)", a, "additives.avoid")
      );
    }
  }
  for (const a of additivesWarn) {
    const needle = norm(a);
    if (!needle) continue;
    if (hasToken(allTokens, needle) || ingAdditives.includes(needle)) {
      flags.push(
        flag("additive", "medium", "Additive (warn)", a, "additives.warn")
      );
    }
  }

  const ok = !flags.some((f) => f.severity === "high");

  if (
    !ingredients?.ingredientsText &&
    !(ingredients?.ingredientsList || []).length
  ) {
    notes.push("Ingredients not available yet.");
  }

  return {
    ok,
    flags,
    allergens: Array.isArray(ingredients?.allergens)
      ? ingredients.allergens
      : [],
    additives: Array.isArray(ingredients?.additives)
      ? ingredients.additives
      : [],
    notes,
  };
}

function flag(type, severity, label, match, ruleId) {
  return { type, severity, label, match, ruleId };
}

function tokenBag(text, list) {
  const bag = new Set();
  for (const w of String(text || "").split(/[^a-z0-9]+/i)) {
    const t = norm(w);
    if (t && t.length > 2) bag.add(t);
  }
  for (const i of list || []) {
    const t = norm(i);
    if (t) bag.add(t);
    // also split list entries into words
    for (const w of String(i || "").split(/[^a-z0-9]+/i)) {
      const ww = norm(w);
      if (ww && ww.length > 2) bag.add(ww);
    }
  }
  return bag;
}

function hasToken(bag, phrase) {
  const p = norm(phrase);
  if (!p) return false;

  // Exact token
  if (bag.has(p)) return true;

  // Phrase match via word-by-word presence
  const words = p.split(" ").filter(Boolean);
  if (words.length <= 1) return false;
  return words.every((w) => bag.has(w));
}
