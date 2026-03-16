// src/services/catalogs/catalogRecipeLibrary.js
// Catalog recipe ingestion for planner selectors.

function unwrapJsonModule(mod) {
  return mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
}

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function safeLower(v) {
  return String(v || "").toLowerCase();
}

function normalizeTags(...parts) {
  const out = [];
  for (const part of parts) {
    const list = Array.isArray(part)
      ? part
      : typeof part === "string"
      ? part
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];

    for (const tag of list) {
      const t = String(tag || "").trim();
      if (t) out.push(t);
    }
  }
  return Array.from(new Set(out));
}

function toCatalogEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    path: typeof raw.path === "string" ? raw.path.trim() : null,
    tags: normalizeTags(raw.tags),
  };
}

function toRecipePathKey(catalogPath, localPath) {
  if (!catalogPath || !localPath || !localPath.startsWith("./")) return null;
  const base = catalogPath.replace(/\/[^/]+$/, "");
  return `${base}/${localPath.slice(2)}`;
}

function extractRecipePathMeta(path) {
  const norm = String(path || "").replace(/\\/g, "/");

  const cuisineMatch = norm.match(/^\.\.\/\.\.\/catalogs\/cuisines\/([^/]+)\/recipes\/([^/]+)\.json$/);
  if (cuisineMatch) {
    return {
      domain: "cuisines",
      subdomain: cuisineMatch[1],
      recipeFile: cuisineMatch[2],
    };
  }

  const topMatch = norm.match(/^\.\.\/\.\.\/catalogs\/([^/]+)\/recipes\/([^/]+)\.json$/);
  if (topMatch) {
    return {
      domain: topMatch[1],
      subdomain: null,
      recipeFile: topMatch[2],
    };
  }

  return null;
}

function hasRecipeShape(recipe) {
  if (!recipe || typeof recipe !== "object") return false;
  if (Array.isArray(recipe.ingredients) && recipe.ingredients.length) return true;
  if (Array.isArray(recipe.steps) && recipe.steps.length) return true;
  if (Array.isArray(recipe.instructions) && recipe.instructions.length) return true;
  return false;
}

const _catalogModules = import.meta.glob("../../catalogs/**/*.catalog.json");
const _recipeModules = import.meta.glob("../../catalogs/**/recipes/*.json");

let _catalogIndexPromise = null;

async function getCatalogIndex() {
  if (_catalogIndexPromise) return _catalogIndexPromise;

  _catalogIndexPromise = (async () => {
    const byRecipeId = new Map();
    const byPathKey = new Map();

    for (const [path, loader] of Object.entries(_catalogModules)) {
      let json;
      try {
        json = unwrapJsonModule(await loader());
      } catch {
        continue;
      }

      const rawEntries = [
        ...asArray(json?.items),
        ...asArray(json?.dishes),
      ];

      for (const raw of rawEntries) {
        const entry = toCatalogEntry(raw);
        if (!entry) continue;

        if (!byRecipeId.has(entry.id)) byRecipeId.set(entry.id, []);
        byRecipeId.get(entry.id).push(entry);

        const key = toRecipePathKey(path, entry.path);
        if (key) {
          if (!byPathKey.has(key)) byPathKey.set(key, []);
          byPathKey.get(key).push(entry);
        }
      }
    }

    return { byRecipeId, byPathKey };
  })();

  return _catalogIndexPromise;
}

function allowDomain(meta, domainFilters) {
  if (!domainFilters.size) return true;
  const full = meta.subdomain ? `${meta.domain}/${meta.subdomain}` : meta.domain;
  return domainFilters.has(meta.domain) || domainFilters.has(full);
}

export async function listCatalogRecipeCandidates(options = {}) {
  const {
    domains = null,
    ids = null,
    limit = null,
  } = options;

  const domainFilters = new Set(
    asArray(domains)
      .map((x) => safeLower(x).trim())
      .filter(Boolean)
  );

  const idFilters = new Set(
    asArray(ids)
      .map((x) => String(x || "").trim())
      .filter(Boolean)
  );

  const index = await getCatalogIndex();
  const out = [];

  for (const [path, loader] of Object.entries(_recipeModules)) {
    const meta = extractRecipePathMeta(path);
    if (!meta) continue;
    if (!allowDomain(meta, domainFilters)) continue;

    let recipe;
    try {
      recipe = unwrapJsonModule(await loader());
    } catch {
      continue;
    }

    if (!hasRecipeShape(recipe)) continue;

    const id =
      recipe?.meta?.id ||
      recipe?.id ||
      `${meta.domain}.${meta.subdomain ? `${meta.subdomain}.` : ""}${meta.recipeFile}`;

    if (idFilters.size && !idFilters.has(String(id))) continue;

    const idEntries = index.byRecipeId.get(String(id)) || [];
    const pathEntries = index.byPathKey.get(path) || [];
    const catalogTags = normalizeTags(
      ...idEntries.map((x) => x.tags),
      ...pathEntries.map((x) => x.tags)
    );

    const tags = normalizeTags(
      recipe?.tags,
      recipe?.classification?.plannerTags,
      catalogTags,
      `catalog:${meta.domain}`,
      meta.subdomain ? `catalog:${meta.domain}/${meta.subdomain}` : null
    );

    out.push({
      id: String(id),
      title:
        recipe?.meta?.name ||
        recipe?.title ||
        recipe?.name ||
        recipe?.label ||
        meta.recipeFile,
      tags,
      macros: recipe?.macros || recipe?.nutrition || recipe?.macroTotals || null,
      ingredients: Array.isArray(recipe?.ingredients) ? recipe.ingredients : [],
      source: "catalogLibrary",
      sourceUrl: null,
      origin: "catalog",
      catalogDomain: meta.domain,
      catalogSubdomain: meta.subdomain,
      raw: recipe,
    });
  }

  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  if (Number.isFinite(Number(limit)) && Number(limit) > 0) {
    return out.slice(0, Number(limit));
  }

  return out;
}

export default {
  listCatalogRecipeCandidates,
};
