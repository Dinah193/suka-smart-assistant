// src/services/catalogs/catalogResolver.js
// Canonical facade for catalog-backed recipe candidates.

import { listCatalogRecipeCandidates } from "@/services/catalogs/catalogRecipeLibrary.js";

const sharedModules = import.meta.glob("../../catalogs/cuisines_shared/*.json");

const SHARED_KEYS = {
  "ingredients.aliases": "aliases",
  "allergens.map": "allergens",
  "units.map": "units",
  "techniques.glossary": "techniques",
};

let sharedPromise = null;

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function normalizeText(v) {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clone(v) {
  if (v == null) return v;
  return JSON.parse(JSON.stringify(v));
}

function normalizeTags(tags = []) {
  return Array.from(
    new Set(
      asArray(tags)
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );
}

async function loadSharedDictionaries() {
  if (sharedPromise) return sharedPromise;

  sharedPromise = (async () => {
    const out = {
      aliases: {},
      allergens: { termMap: {}, ingredientTriggers: [] },
      units: { map: {} },
      techniques: { techniques: [] },
    };

    for (const [path, loader] of Object.entries(sharedModules)) {
      let mod;
      try {
        mod = await loader();
      } catch {
        continue;
      }
      const json = mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
      const file = path.split("/").pop() || "";

      if (file.includes("ingredients.aliases")) out.aliases = json?.aliases || {};
      if (file.includes("allergens.map")) {
        out.allergens = {
          termMap: json?.termMap || {},
          ingredientTriggers: Array.isArray(json?.ingredientTriggers)
            ? json.ingredientTriggers
            : [],
        };
      }
      if (file.includes("units.map")) out.units = { map: json?.map || {} };
      if (file.includes("techniques.glossary")) {
        out.techniques = { techniques: Array.isArray(json?.techniques) ? json.techniques : [] };
      }
    }

    return out;
  })();

  return sharedPromise;
}

function normalizeIngredientNameWithAliases(name, aliasMap = {}) {
  const normalized = normalizeText(name);
  if (!normalized) return { normalized, canonicalIngredientId: null };
  const canonicalIngredientId = aliasMap[normalized] || null;
  return { normalized, canonicalIngredientId };
}

function normalizeIngredientUnit(unit, unitMap = {}) {
  const normalized = normalizeText(unit);
  if (!normalized) return { normalizedUnit: null, canonicalUnitId: null };
  return {
    normalizedUnit: normalized,
    canonicalUnitId: unitMap[normalized] || null,
  };
}

function inferAllergenIds(ingredients = [], allergensDict = {}) {
  const out = new Set();
  const termMap = allergensDict?.termMap || {};
  const triggers = Array.isArray(allergensDict?.ingredientTriggers)
    ? allergensDict.ingredientTriggers
    : [];

  for (const ing of asArray(ingredients)) {
    const text = normalizeText(ing?.name || ing?.label || "");
    if (!text) continue;

    for (const [term, ids] of Object.entries(termMap)) {
      const t = normalizeText(term);
      if (!t) continue;
      if (text.includes(t)) {
        for (const id of asArray(ids)) out.add(String(id));
      }
    }

    for (const rule of triggers) {
      const aid = String(rule?.allergenId || "").trim();
      if (!aid) continue;
      const tokens = asArray(rule?.tokens).map((x) => normalizeText(x)).filter(Boolean);
      if (tokens.some((tk) => text.includes(tk))) out.add(aid);
    }
  }

  return Array.from(out);
}

function inferTechniqueIds(recipe, techniquesDict = {}) {
  const techniques = Array.isArray(techniquesDict?.techniques)
    ? techniquesDict.techniques
    : [];
  if (!techniques.length) return [];

  const textParts = [];
  for (const s of asArray(recipe?.steps)) textParts.push(String(s || ""));
  for (const s of asArray(recipe?.instructions)) {
    if (typeof s === "string") textParts.push(s);
    else if (s && typeof s === "object") {
      if (s.text) textParts.push(String(s.text));
      if (s.instruction) textParts.push(String(s.instruction));
    }
  }

  const hay = normalizeText(textParts.join(" "));
  if (!hay) return [];

  const found = [];
  for (const t of techniques) {
    const aliases = [t?.label, ...(Array.isArray(t?.aliases) ? t.aliases : [])]
      .map((x) => normalizeText(x))
      .filter(Boolean);
    if (aliases.some((a) => hay.includes(a))) {
      found.push(String(t?.id || "").trim());
    }
  }

  return Array.from(new Set(found.filter(Boolean)));
}

function normalizeCatalogRecipeCandidate(candidate, shared) {
  if (!candidate || typeof candidate !== "object") return null;

  const aliasMap = shared?.aliases || {};
  const unitMap = shared?.units?.map || {};

  const normalizedIngredients = asArray(candidate.ingredients).map((ing) => {
    const next = { ...(ing || {}) };
    const name = next.name || next.label || "";
    const nameInfo = normalizeIngredientNameWithAliases(name, aliasMap);
    const unitInfo = normalizeIngredientUnit(next.unit || next.amount?.unit || "", unitMap);

    if (nameInfo.normalized) next.normalizedName = nameInfo.normalized;
    if (nameInfo.canonicalIngredientId) next.canonicalIngredientId = nameInfo.canonicalIngredientId;
    if (unitInfo.normalizedUnit) next.normalizedUnit = unitInfo.normalizedUnit;
    if (unitInfo.canonicalUnitId) next.canonicalUnitId = unitInfo.canonicalUnitId;

    return next;
  });

  const allergenIds = inferAllergenIds(normalizedIngredients, shared?.allergens || {});
  const techniqueIds = inferTechniqueIds(candidate.raw || candidate, shared?.techniques || {});

  const catalogTags = normalizeTags(
    ...(asArray(candidate.tags).filter((t) => String(t).startsWith("catalog:")))
  );

  const tags = normalizeTags(
    ...asArray(candidate.tags),
    ...allergenIds.map((x) => `allergen:${x}`),
    ...techniqueIds.map((x) => `technique:${x}`)
  );

  const catalogId =
    String(candidate?.raw?.meta?.id || candidate?.raw?.id || candidate?.id || "").trim() ||
    null;

  return {
    id: candidate.id ? String(candidate.id) : null,
    title: String(candidate.title || candidate.name || "Untitled Recipe"),
    tags,
    macros: candidate.macros || null,
    ingredients: normalizedIngredients,
    source: "catalog",
    sourceUrl: candidate.sourceUrl || null,
    origin: "catalog",
    catalogDomain: candidate.catalogDomain || null,
    catalogId,
    catalogTags,
    raw: clone(candidate.raw || candidate),
  };
}

export async function listResolvedCatalogRecipes(options = {}) {
  const [shared, rawCandidates] = await Promise.all([
    loadSharedDictionaries(),
    listCatalogRecipeCandidates({
      domains: options.domains || null,
      ids: options.ids || null,
      limit: options.limit || null,
    }),
  ]);

  return asArray(rawCandidates)
    .map((c) => normalizeCatalogRecipeCandidate(c, shared))
    .filter(Boolean);
}

export async function getCatalogResolverDictionaries() {
  const shared = await loadSharedDictionaries();
  return clone(shared);
}

export default {
  listResolvedCatalogRecipes,
  getCatalogResolverDictionaries,
};
