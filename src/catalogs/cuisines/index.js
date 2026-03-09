// src/catalogs/cuisines/index.js
// SSA • Cuisines Catalog Loader (Vite-friendly)
// -----------------------------------------------------------------------------
// Goals:
// - Single, deterministic entry point for cuisine catalogs living under:
//     src/catalogs/cuisines/<cuisine_slug>/...
// - Works with Vite import.meta.glob for both eager and lazy loading.
// - Avoids hardcoding every cuisine file path in code (but still provides
//   stable cuisine slugs + helpers).
//
// Expected folder conventions (per cuisine slug):
// - ./<slug>/cuisine.profile.json              (recommended / commonly present)
// - ./<slug>/dishes.catalog.json               (optional)
// - ./<slug>/ruleset.json OR ruleset*.json     (optional; some cuisines use rulesets)
// - ./<slug>/recipes/*.json                    (optional)
//
// NOTE:
// - JSON imports in Vite resolve as modules; use `.default ?? module` patterns.
// - Keep IDs deterministic: slug is derived from folder name.

function unwrapJsonModule(mod) {
  return mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
}

function normalizeSlugFromPath(path) {
  // Paths look like "./korean/cuisine.profile.json"
  const m = String(path).match(/^\.\/([^/]+)\//);
  return m ? m[1] : null;
}

function sortUnique(arr) {
  return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

function toErrorMessage(err) {
  if (!err) return "Unknown error";
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

// -----------------------------------------------------------------------------
// Globs
// -----------------------------------------------------------------------------

// Eager-load cuisine profiles (lightweight, used for menus / pickers)
const _profileMods = import.meta.glob("./*/cuisine.profile.json", {
  eager: true,
});

// Optional catalogs / rules (lazy by default)
const _dishesMods = import.meta.glob("./*/dishes.catalog.json"); // async
const _rulesetMods = import.meta.glob("./*/ruleset*.json"); // async (ruleset.json, ruleset.v2.json, etc.)

// Recipes are often large; keep lazy
const _recipeMods = import.meta.glob("./*/recipes/*.json"); // async

// -----------------------------------------------------------------------------
// Indexes
// -----------------------------------------------------------------------------

const CUISINE_PROFILES_BY_SLUG = Object.freeze(
  Object.entries(_profileMods).reduce((acc, [path, mod]) => {
    const slug = normalizeSlugFromPath(path);
    if (!slug) return acc;
    acc[slug] = unwrapJsonModule(mod);
    return acc;
  }, {}),
);

export const CUISINE_SLUGS = Object.freeze(
  sortUnique(Object.keys(CUISINE_PROFILES_BY_SLUG)),
);

// If a cuisine folder exists but has no cuisine.profile.json yet, it won't appear
// in CUISINE_SLUGS. You can still load files by slug using the loaders below,
// but profiles are the canonical “exists” signal in SSA catalogs.

// -----------------------------------------------------------------------------
// Public: Cuisine listing helpers
// -----------------------------------------------------------------------------

/**
 * Returns a stable list of cuisines, suitable for UI menus.
 * Uses cuisine.profile.json when available, falling back to slug defaults.
 */
export function listCuisines() {
  return CUISINE_SLUGS.map((slug) => {
    const profile = CUISINE_PROFILES_BY_SLUG[slug];
    const meta = profile?.meta || {};
    return {
      slug,
      id: meta.id || `cuisines.${slug}`,
      label: meta.label || slugToLabel(slug),
      description: meta.description || "",
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      locale: meta.locale || "en-US",
      status: meta.status || "canonical",
      // Helpful for deterministic UI sorting/filtering:
      _hasProfile: Boolean(profile),
    };
  });
}

/**
 * Convenience: fetch a cuisine profile synchronously (only works if the profile exists).
 */
export function getCuisineProfileSync(slug) {
  return CUISINE_PROFILES_BY_SLUG[String(slug)] || null;
}

/**
 * True if a cuisine profile exists for slug.
 */
export function hasCuisineProfile(slug) {
  return Boolean(CUISINE_PROFILES_BY_SLUG[String(slug)]);
}

// -----------------------------------------------------------------------------
// Public: Async loaders
// -----------------------------------------------------------------------------

/**
 * Loads cuisine profile JSON (async) if present, else returns null.
 * (Profiles are eagerly indexed, so this is just a uniform async wrapper.)
 */
export async function loadCuisineProfile(slug) {
  return getCuisineProfileSync(slug);
}

/**
 * Loads dishes.catalog.json for a cuisine if present, else returns null.
 */
export async function loadCuisineDishesCatalog(slug) {
  const target = `./${slug}/dishes.catalog.json`;
  const loader = _dishesMods[target];
  if (!loader) return null;

  try {
    const mod = await loader();
    return unwrapJsonModule(mod);
  } catch (err) {
    throw new Error(
      `Failed to load dishes catalog for cuisine "${slug}": ${toErrorMessage(err)}`,
    );
  }
}

/**
 * Loads ruleset JSON(s) for a cuisine (ruleset.json, ruleset.*.json).
 * Returns an array (possibly empty) to support multiple rulesets per cuisine.
 */
export async function loadCuisineRulesets(slug) {
  const prefix = `./${slug}/`;
  const entries = Object.entries(_rulesetMods).filter(([path]) =>
    path.startsWith(prefix),
  );

  if (entries.length === 0) return [];

  const results = [];
  for (const [path, loader] of entries) {
    try {
      const mod = await loader();
      results.push({
        path,
        data: unwrapJsonModule(mod),
      });
    } catch (err) {
      throw new Error(
        `Failed to load ruleset "${path}" for cuisine "${slug}": ${toErrorMessage(err)}`,
      );
    }
  }

  // Sort deterministically by path
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * Loads all recipe JSON files for a cuisine.
 * Returns:
 *   [{ path, data }]
 *
 * Note:
 * - This is intentionally lazy; call it only when needed.
 */
export async function loadCuisineRecipes(slug) {
  const prefix = `./${slug}/recipes/`;
  const entries = Object.entries(_recipeMods).filter(([path]) =>
    path.startsWith(prefix),
  );

  if (entries.length === 0) return [];

  const results = [];
  for (const [path, loader] of entries) {
    try {
      const mod = await loader();
      results.push({
        path,
        data: unwrapJsonModule(mod),
      });
    } catch (err) {
      throw new Error(
        `Failed to load recipe "${path}" for cuisine "${slug}": ${toErrorMessage(err)}`,
      );
    }
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * Loads a full cuisine bundle: profile + dishes + rulesets + recipes.
 * Use this for editors, deep browsing, or one-click “import cuisine to Dexie”.
 */
export async function loadCuisineBundle(slug, options = {}) {
  const {
    includeDishes = true,
    includeRulesets = true,
    includeRecipes = false, // default false to avoid heavy loads
  } = options;

  const safeSlug = String(slug);

  const profile = await loadCuisineProfile(safeSlug);
  const dishes = includeDishes
    ? await loadCuisineDishesCatalog(safeSlug)
    : null;
  const rulesets = includeRulesets ? await loadCuisineRulesets(safeSlug) : [];
  const recipes = includeRecipes ? await loadCuisineRecipes(safeSlug) : [];

  return {
    slug: safeSlug,
    profile,
    dishes,
    rulesets,
    recipes,
  };
}

/**
 * Loads profiles for all cuisines (fast; uses eager index).
 */
export async function loadAllCuisineProfiles() {
  return CUISINE_SLUGS.map((slug) => ({
    slug,
    profile: CUISINE_PROFILES_BY_SLUG[slug] || null,
  }));
}

// -----------------------------------------------------------------------------
// Public: Path + label utilities
// -----------------------------------------------------------------------------

export function cuisineSlugToBasePath(slug) {
  return `src/catalogs/cuisines/${String(slug)}`;
}

export function slugToLabel(slug) {
  return String(slug)
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// -----------------------------------------------------------------------------
// Default export (handy for imports)
// -----------------------------------------------------------------------------

export default {
  CUISINE_SLUGS,
  listCuisines,
  hasCuisineProfile,
  getCuisineProfileSync,
  loadCuisineProfile,
  loadCuisineDishesCatalog,
  loadCuisineRulesets,
  loadCuisineRecipes,
  loadCuisineBundle,
  loadAllCuisineProfiles,
  cuisineSlugToBasePath,
  slugToLabel,
};
