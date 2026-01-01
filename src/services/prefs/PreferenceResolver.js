// C:\Users\larho\suka-smart-assistant\src\services\prefs\PreferenceResolver.js
// -----------------------------------------------------------------------------
// PreferenceResolver
// -----------------------------------------------------------------------------
// Deterministically merges preferences into a patch object SSA can apply to a
// blueprint/session.
// Precedence order (highest first):
// 1) Safety / hard constraints
// 2) Household rules
// 3) User preferences
// 4) Context
// 5) Method defaults (catalog)
// -----------------------------------------------------------------------------
//
// Output:
// {
//   patch: {...},                 // deterministic merged patch
//   preferencesApplied: [...],    // audit trail (ordered)
// }
//
// ✅ Update:
// Adds shopping-related preference helpers and a stable schema under patch.shopping
// so scan → enrich → UI can rely on it.
//
// patch.shopping schema (recommended):
// {
//   avoidIngredients: string[],
//   requireIngredients: string[],
//   allergens: { avoid: string[], warn: string[] },
//   additives: { avoid: string[], warn: string[] },
//   brandBans: string[],
//   upcBans: string[],
//   hideIngredientsByDefault: boolean,
//   couponOptIn: boolean,
//   recallOptIn: boolean,
//   sponsoredEnabled: boolean,
//   priceCompareEnabled: boolean,
// }
// -----------------------------------------------------------------------------

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  if (!isObj(patch) && !Array.isArray(patch)) return out;

  if (Array.isArray(patch)) return [...patch]; // arrays override

  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v)) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function stamp(source, keys) {
  return {
    source,
    keys: Array.isArray(keys) ? keys : [],
  };
}

export function resolvePreferences({
  safety = {},
  household = {},
  user = {},
  context = {},
  methodDefaults = {},
} = {}) {
  const preferencesApplied = [];

  // Start from lowest precedence (method defaults) and overlay up to highest.
  let patch = {};

  patch = deepMerge(patch, methodDefaults || {});
  preferencesApplied.push(
    stamp("methodDefaults", Object.keys(methodDefaults || {}))
  );

  patch = deepMerge(patch, context || {});
  preferencesApplied.push(stamp("context", Object.keys(context || {})));

  patch = deepMerge(patch, user || {});
  preferencesApplied.push(stamp("user", Object.keys(user || {})));

  patch = deepMerge(patch, household || {});
  preferencesApplied.push(stamp("household", Object.keys(household || {})));

  patch = deepMerge(patch, safety || {});
  preferencesApplied.push(stamp("safety", Object.keys(safety || {})));

  // ✅ Ensure stable shopping schema exists (non-breaking additive)
  patch = deepMerge(patch, {
    shopping: materializeShoppingPrefs(patch?.shopping),
  });

  return { patch, preferencesApplied };
}

// -----------------------------------------------------------------------------
// ✅ Shopping preference helpers (NEW)
// -----------------------------------------------------------------------------

export function materializeShoppingPrefs(raw = {}) {
  const r = isObj(raw) ? raw : {};

  return {
    avoidIngredients: toStrList(r.avoidIngredients || r.avoid_ingredients),
    requireIngredients: toStrList(
      r.requireIngredients || r.require_ingredients
    ),
    allergens: {
      avoid: toStrList(r?.allergens?.avoid || r?.allergensAvoid),
      warn: toStrList(r?.allergens?.warn || r?.allergensWarn),
    },
    additives: {
      avoid: toStrList(r?.additives?.avoid || r?.additivesAvoid),
      warn: toStrList(r?.additives?.warn || r?.additivesWarn),
    },
    brandBans: toStrList(r.brandBans || r.brand_bans),
    upcBans: toStrList(r.upcBans || r.upc_bans),

    // UI / feature toggles
    hideIngredientsByDefault: toBool(r.hideIngredientsByDefault, false),
    couponOptIn: toBool(r.couponOptIn, true),
    recallOptIn: toBool(r.recallOptIn, true),
    sponsoredEnabled: toBool(r.sponsoredEnabled, true),
    priceCompareEnabled: toBool(r.priceCompareEnabled, true),
  };
}

/**
 * Convenience builder: creates a shopping patch from a household profile object.
 * (Optional usage from your pipeline or settings UI.)
 */
export function buildShoppingPreferencePatchFromHouseholdProfile(
  householdProfile = {}
) {
  const h = isObj(householdProfile) ? householdProfile : {};

  return {
    shopping: materializeShoppingPrefs({
      avoidIngredients:
        h?.shopping?.avoidIngredients || h?.diet?.avoidIngredients,
      requireIngredients:
        h?.shopping?.requireIngredients || h?.diet?.requireIngredients,
      allergens: h?.shopping?.allergens || h?.diet?.allergens,
      additives: h?.shopping?.additives || h?.diet?.additives,
      brandBans: h?.shopping?.brandBans,
      upcBans: h?.shopping?.upcBans,

      hideIngredientsByDefault: h?.shopping?.hideIngredientsByDefault,
      couponOptIn: h?.shopping?.couponOptIn,
      recallOptIn: h?.shopping?.recallOptIn,
      sponsoredEnabled: h?.shopping?.sponsoredEnabled,
      priceCompareEnabled: h?.shopping?.priceCompareEnabled,
    }),
  };
}

function toStrList(v) {
  if (!v) return [];
  if (Array.isArray(v))
    return uniq(v.map((x) => String(x || "").trim()).filter(Boolean));
  if (typeof v === "string") {
    // allow comma-separated
    return uniq(
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  return [];
}

function uniq(arr) {
  return Array.from(new Set(arr || []));
}

function toBool(v, fallback) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "")
    .toLowerCase()
    .trim();
  if (!s) return !!fallback;
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return !!fallback;
}

export default {
  resolvePreferences,
  materializeShoppingPrefs,
  buildShoppingPreferencePatchFromHouseholdProfile,
};
