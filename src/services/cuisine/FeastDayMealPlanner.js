
// FILE: src/services/cuisine/FeastDayMealPlanner.js
// Scripture-only feast day meal suggestions.
// - Uses feastDayMealLogic catalog (no rabbinic sources)
// - Filters dish catalog by constraints and highlights preservation tie-ins.

import { loadCuisineCatalogs } from "./CuisineCatalogLoader";
import { getCuisinePrefs } from "./CuisinePreferenceService";

function uniq(a) { return Array.from(new Set((a || []).filter(Boolean))); }

export async function getFeastDaySuggestions({
  householdId = "default",
  cuisineKey = "aai",
  feastKey = null,
} = {}) {
  const catalogs = await loadCuisineCatalogs({ cuisineKey });
  const prefs = await getCuisinePrefs({ householdId });

  const feasts = catalogs?.feastLogic?.feasts || [];
  const feast = feastKey ? feasts.find((f) => f.key === feastKey) : null;

  const dishList = catalogs?.dishCatalog?.dishes || [];
  const dishByKey = new Map(dishList.map((d) => [d.key, d]));

  const suggested = (feast?.suggestedDishes || [])
    .map((k) => dishByKey.get(k))
    .filter(Boolean)
    .filter((d) => d.torahSafe !== false);

  const cross = catalogs?.preservationCrosslinks?.items || [];
  const suggestedCross = [];
  for (const item of cross) {
    const uses = new Set(item?.useIn || []);
    if (suggested.some((d) => uses.has(d.key))) suggestedCross.push(item);
  }

  return {
    cuisineKey,
    householdId,
    prefs,
    feast: feast || null,
    feastsIndex: feasts.map((f) => ({ key: f.key, name: f.name, scriptureRefs: f.scriptureRefs })),
    suggestions: suggested.map((d) => ({
      key: d.key,
      name: d.name,
      primaryProtein: d.primaryProtein,
      techniques: d.techniques,
      spiceProfiles: d.spiceProfiles,
      holyDaySuitable: d.holyDaySuitable,
      tags: d.tags,
    })),
    preservationTieIns: suggestedCross.map((i) => ({
      key: i.key,
      name: i.name,
      prepOnceUse3: i.prepOnceUse3,
      producedBy: i.producedBy,
    })),
    prepSuggestions: uniq(feast?.prepSuggestions || []),
    scriptureRefs: uniq(feast?.scriptureRefs || []),
    notes: String(catalogs?.feastLogic?.notes || ""),
    catalogWarnings: catalogs?.warnings || [],
    catalogErrors: catalogs?.errors || [],
  };
}
