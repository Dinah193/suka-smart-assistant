
// FILE: src/services/cuisine/CuisineCatalogLoader.js
// SSA CuisineCatalogLoader — local fixed catalogs loader (no heavy deps)
// - Loads JSON catalogs from src/layers/cuisines/*
// - Performs lightweight shape validation
// - Caches results per session

const cache = new Map();

function safeJsonParse(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

function validateProfile(doc) {
  const errors = [];
  if (!isObj(doc)) errors.push("profile: not an object");
  if (!doc?.key || typeof doc.key !== "string") errors.push("profile.key missing");
  if (!doc?.name || typeof doc.name !== "string") errors.push("profile.name missing");
  if (!doc?.principles?.torahFoodLaw) errors.push("profile.principles.torahFoodLaw missing");
  return errors;
}

function validateDishCatalog(doc) {
  const errors = [];
  if (!isObj(doc)) errors.push("dishCatalog: not an object");
  if (!doc?.cuisineKey) errors.push("dishCatalog.cuisineKey missing");
  if (!Array.isArray(doc?.dishes)) errors.push("dishCatalog.dishes must be array");
  if (Array.isArray(doc?.dishes)) {
    for (const d of doc.dishes.slice(0, 50)) {
      if (!d?.key || typeof d.key !== "string") errors.push("dishCatalog.dish.key missing");
      if (!d?.name || typeof d.name !== "string") errors.push(`dishCatalog.dish.name missing for ${d?.key || "unknown"}`);
      if (!d?.mealType) errors.push(`dishCatalog.dish.mealType missing for ${d?.key || "unknown"}`);
    }
  }
  return errors;
}

function validateMatrix(doc) {
  const errors = [];
  if (!isObj(doc)) errors.push("spiceMatrix: not an object");
  if (!doc?.cuisineKey) errors.push("spiceMatrix.cuisineKey missing");
  if (!Array.isArray(doc?.blends)) errors.push("spiceMatrix.blends must be array");
  return errors;
}

function validateOverlap(doc) {
  const errors = [];
  if (!isObj(doc)) errors.push("techniqueOverlap: not an object");
  if (!doc?.cuisineKey) errors.push("techniqueOverlap.cuisineKey missing");
  if (!Array.isArray(doc?.techniqueFamilies)) errors.push("techniqueOverlap.techniqueFamilies must be array");
  if (!Array.isArray(doc?.overlaps)) errors.push("techniqueOverlap.overlaps must be array");
  return errors;
}

function validatePresCross(doc) {
  const errors = [];
  if (!isObj(doc)) errors.push("preservationCrosslinks: not an object");
  if (!doc?.cuisineKey) errors.push("preservationCrosslinks.cuisineKey missing");
  if (!Array.isArray(doc?.items)) errors.push("preservationCrosslinks.items must be array");
  return errors;
}

function validateFeast(doc) {
  const errors = [];
  if (!isObj(doc)) errors.push("feastLogic: not an object");
  if (!Array.isArray(doc?.feasts)) errors.push("feastLogic.feasts must be array");
  return errors;
}

async function loadJson(path) {
  // Vite supports import of JSON as module with default export.
  const mod = await import(/* @vite-ignore */ path);
  return mod?.default ?? mod;
}

export async function loadCuisineCatalogs({ cuisineKey = "aai" } = {}) {
  const ck = String(cuisineKey || "").trim() || "aai";
  if (cache.has(ck)) return cache.get(ck);

  const base = `/src/layers/cuisines`;
  const paths = {
    profile: `${base}/${ck}.cuisine.profile.json`,
    dishCatalog: `${base}/${ck}.dishCatalog.json`,
    spiceMatrix: `${base}/${ck}.spiceFlavorMatrix.json`,
    techniqueOverlap: `${base}/${ck}.techniqueOverlap.json`,
    preservationCrosslinks: `${base}/${ck}.preservationCrosslinks.json`,
    feastLogic: `${base}/${ck}.feastDayMealLogic.json`,
  };

  const out = { cuisineKey: ck, paths, errors: [], warnings: [] };

  try { out.profile = await loadJson(paths.profile); } catch (e) { out.errors.push(`Failed to load ${paths.profile}`); }
  try { out.dishCatalog = await loadJson(paths.dishCatalog); } catch (e) { out.errors.push(`Failed to load ${paths.dishCatalog}`); }
  try { out.spiceMatrix = await loadJson(paths.spiceMatrix); } catch (e) { out.errors.push(`Failed to load ${paths.spiceMatrix}`); }
  try { out.techniqueOverlap = await loadJson(paths.techniqueOverlap); } catch (e) { out.errors.push(`Failed to load ${paths.techniqueOverlap}`); }
  try { out.preservationCrosslinks = await loadJson(paths.preservationCrosslinks); } catch (e) { out.warnings.push(`Failed to load ${paths.preservationCrosslinks}`); }
  try { out.feastLogic = await loadJson(paths.feastLogic); } catch (e) { out.warnings.push(`Failed to load ${paths.feastLogic}`); }

  // Lightweight validations
  out.errors.push(...validateProfile(out.profile));
  out.errors.push(...validateDishCatalog(out.dishCatalog));
  out.errors.push(...validateMatrix(out.spiceMatrix));
  out.errors.push(...validateOverlap(out.techniqueOverlap));
  out.warnings.push(...validatePresCross(out.preservationCrosslinks || {}));
  out.warnings.push(...validateFeast(out.feastLogic || {}));

  cache.set(ck, out);
  return out;
}

export function clearCuisineCatalogCache() { cache.clear(); }

export function safeParseRulesJson(rulesJson, fallback = {}) {
  if (!rulesJson) return fallback;
  if (typeof rulesJson === "object") return rulesJson;
  if (typeof rulesJson === "string") return safeJsonParse(rulesJson, fallback);
  return fallback;
}
