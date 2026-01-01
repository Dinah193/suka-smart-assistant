// src/services/portfolio/uniqueness.js
// Uniqueness scoring based on recipe-ID overlap with the global catalog.
// Score = (1 - |candidate ∩ global| / |candidate|) * 100, clamped 0..100.

/**
 * @typedef {string} RecipeId
 */

/**
 * @typedef {Object} PortfolioLike
 * @property {string} id
 * @property {string} [title]
 * @property {RecipeId[]} [recipeIds]
 * @property {Array<{id?: RecipeId}|RecipeId>} [items]
 * @property {Array<{id?: RecipeId}|RecipeId>} [recipes]
 * @property {string[]} [flavor_profile]
 */

/**
 * @typedef {Object} UniquenessResult
 * @property {number} score            // 0..100
 * @property {number} candidateSize    // distinct recipe IDs on the portfolio
 * @property {number} overlapSize      // how many of those exist globally
 * @property {number} novelCount       // candidateSize - overlapSize
 * @property {RecipeId[]} sampleOverlaps // up to a few overlapping IDs (for UI)
 * @property {number} computedAt
 */

export const MIN_MARKETPLACE_UNIQUENESS = 30;

/* ------------------------------ ID utilities ------------------------------ */
const toId = (x) => {
  if (!x && x !== 0) return null;
  if (typeof x === "string") return x.trim();
  if (typeof x === "object" && x && "id" in x) {
    const v = x.id;
    return typeof v === "string" ? v.trim() : null;
    }
  return null;
};

/**
 * @param {PortfolioLike | null | undefined} candidate
 * @returns {RecipeId[]}
 */
function collectRecipeIds(candidate) {
  if (!candidate) return [];
  const out = [];

  // explicit array of ids
  (candidate.recipeIds || []).forEach((id) => {
    const t = toId(id);
    if (t) out.push(t);
  });

  // items[] may be strings or { id }
  (candidate.items || []).forEach((node) => {
    const t = toId(node);
    if (t) out.push(t);
  });

  // recipes[] may be strings or { id }
  (candidate.recipes || []).forEach((node) => {
    const t = toId(node);
    if (t) out.push(t);
  });

  // De-dupe, stable order
  const seen = new Set();
  const uniq = [];
  out.forEach((id) => {
    const key = id.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniq.push(id);
    }
  });
  return uniq;
}

/* -------------------------- Global catalog (cached) ------------------------ */
// Build a Set<string> of all recipe IDs referenced by any pack JSON.

let _globalIdsCache = null;     /** @type {Set<string> | null} */
let _globalIdsBuildStamp = 0;

async function buildGlobalCatalogIds() {
  if (_globalIdsCache && _globalIdsBuildStamp > 0) return _globalIdsCache;

  // Lazy import registry to keep normal routes slim
  const registry = await import("@/data/recipe-packs");
  const { listPacks, getPack } = registry;

  const manifests = await listPacks({ vision: null });
  const ids = new Set();

  // Keep it snappy with small concurrency
  const CONCURRENCY = 6;
  let i = 0;

  async function worker() {
    while (i < manifests.length) {
      const idx = i++;
      const m = manifests[idx];
      try {
        const pack = await getPack(m.id, { vision: null, applyRhythm: false });
        const nodes = Array.isArray(pack?.items)
          ? pack.items
          : Array.isArray(pack?.recipes)
          ? pack.recipes
          : [];
        for (const n of nodes) {
          const id = toId(n);
          if (id) ids.add(id.toLowerCase());
        }
      } catch {
        // ignore failures; continue
      }
    }
  }

  const tasks = Array.from({ length: Math.min(CONCURRENCY, manifests.length) }, () => worker());
  await Promise.all(tasks);

  _globalIdsCache = ids;
  _globalIdsBuildStamp = Date.now();
  return ids;
}

/* ------------------------------ Core Scorer -------------------------------- */
/**
 * @param {PortfolioLike | null | undefined} candidate
 * @returns {Promise<UniquenessResult>}
 */
export async function scoreByRecipeIds(candidate) {
  const candidateIds = collectRecipeIds(candidate);
  const candidateSize = candidateIds.length;

  if (candidateSize === 0) {
    return {
      score: 0,
      candidateSize: 0,
      overlapSize: 0,
      novelCount: 0,
      sampleOverlaps: [],
      computedAt: Date.now(),
    };
  }

  const globalIds = await buildGlobalCatalogIds();
  let overlapSize = 0;
  const overlaps = [];

  for (const id of candidateIds) {
    const hit = globalIds.has(id.toLowerCase());
    if (hit) {
      overlapSize++;
      if (overlaps.length < 8) overlaps.push(id);
    }
  }

  const novelCount = Math.max(0, candidateSize - overlapSize);
  const ratio = Math.min(1, overlapSize / Math.max(1, candidateSize));
  const score = Math.max(0, Math.min(100, Math.round((1 - ratio) * 100)));

  return {
    score,
    candidateSize,
    overlapSize,
    novelCount,
    sampleOverlaps: overlaps,
    computedAt: Date.now(),
  };
}

/* --------------------------- Convenience helpers --------------------------- */
/**
 * @param {PortfolioLike | null | undefined} candidate
 * @param {number} [minScore=MIN_MARKETPLACE_UNIQUENESS]
 * @returns {Promise<{ eligible: boolean, result: UniquenessResult }>}
 */
export async function isMarketplaceEligibleByIds(candidate, minScore = MIN_MARKETPLACE_UNIQUENESS) {
  const result = await scoreByRecipeIds(candidate);
  return { eligible: result.score >= minScore, result };
}

/** Invalidate the global catalog cache (useful in dev hot reloads or tests). */
export function clearGlobalCatalogCache() {
  _globalIdsCache = null;
  _globalIdsBuildStamp = 0;
}
