
// FILE: src/services/cuisine/PhraseTagger.js
// Non-AI phrase tagger for mapping recipe titles/ingredients to cuisine & technique tags.
// - Uses deterministic dictionaries (local)
// - Designed for "Add recipe to rotation" + indexing.

const DEFAULT_DICT = {
  proteins: {
    beef: ["beef", "steak", "brisket", "oxtail", "short rib", "ground beef"],
    lamb: ["lamb", "mutton", "lamb chop", "lamb shank"],
    goat: ["goat", "cabrito"],
    fish: ["salmon", "cod", "tilapia", "trout", "snapper", "haddock"],
  },
  techniques: {
    smoke: ["smoked", "smoke", "pit", "bbq"],
    grill: ["grill", "grilled", "char", "skewer", "suya"],
    roast: ["roast", "roasted", "oven"],
    stew: ["stew", "gumbo", "soup", "broth", "braise"],
    ferment: ["ferment", "pickled", "kraut", "brine"],
    sausage: ["sausage", "link", "patty"],
    cure: ["cured", "bacon", "cure"],
    shawarma: ["shawarma", "gyro", "spit"],
  },
  spiceProfiles: {
    aai_suya_classic: ["suya"],
    aai_shawarma_brown: ["shawarma", "gyro"],
    aai_bbq_sweet_smoke: ["bbq", "barbecue"],
    aai_jollof_base: ["jollof"],
    aai_berbere_like: ["berbere"],
  },
  dishes: {
    "collard greens": ["collard", "collards"],
    "black-eyed peas": ["black eyed peas", "black-eyed peas"],
    "okra stew": ["okra", "gumbo"],
  }
};

function norm(s) { return String(s || "").toLowerCase(); }

function matchAny(text, list) {
  const t = norm(text);
  for (const w of (list || [])) {
    const ww = norm(w);
    if (!ww) continue;
    if (t.includes(ww)) return true;
  }
  return false;
}

export function tagPhrase({ text = "", dict = DEFAULT_DICT } = {}) {
  const t = norm(text);
  const tags = { proteins: [], techniques: [], spiceProfiles: [], dishHints: [] };

  for (const [k, words] of Object.entries(dict.proteins || {})) if (matchAny(t, words)) tags.proteins.push(k);
  for (const [k, words] of Object.entries(dict.techniques || {})) if (matchAny(t, words)) tags.techniques.push(k);
  for (const [k, words] of Object.entries(dict.spiceProfiles || {})) if (matchAny(t, words)) tags.spiceProfiles.push(k);
  for (const [k, words] of Object.entries(dict.dishes || {})) if (matchAny(t, words)) tags.dishHints.push(k);

  // Unique
  for (const k of Object.keys(tags)) tags[k] = Array.from(new Set(tags[k]));
  return tags;
}

export function tagRecipe({ title = "", ingredients = [], dict = DEFAULT_DICT } = {}) {
  const combined = [title, ...(ingredients || [])].join(" | ");
  const t = tagPhrase({ text: combined, dict });
  return {
    ...t,
    cuisineTags: ["aai"],
    confidence: Math.min(1, 0.25 + 0.15 * (t.proteins.length + t.techniques.length + t.spiceProfiles.length)),
  };
}
