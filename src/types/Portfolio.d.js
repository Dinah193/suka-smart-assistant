// src/types/Portfolio.d.js
// -----------------------------------------------------------------------------
// Portfolio type (+ helpers) with optional weeklyFlavorRhythm and tags
// - Accepts a Gregorian FlavorDayMap (Mon→Sun) as requested.
// - Internally can normalize to your default Creation scheme (Day One→Sabbath).
// - Adds tiny helpers for marketplace eligibility (≥30% unique).
// -----------------------------------------------------------------------------

import {
  RHYTHM_SCHEME,
  normalizeRhythm,
  defaultRhythm,
  mergeRhythms,
  getDayKeys,
} from "@/types/FlavorRhythm.d"; // uses the dynamic rhythm module you built

// ─────────────────────────────────────────────────────────────────────────────
// Types (JSDoc-style)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gregorian map (requested shape for compatibility)
 * @typedef {Object} FlavorDayMap
 * @property {string[]=} monday
 * @property {string[]=} tuesday
 * @property {string[]=} wednesday
 * @property {string[]=} thursday
 * @property {string[]=} friday
 * @property {string[]=} saturday
 * @property {string[]=} sunday
 */

/**
 * Rhythm that may include either Creation keys (day_one..sabbath) or Gregorian keys.
 * We keep this loose because the app supports both, but the UI asks for FlavorDayMap.
 * @typedef {Record<string, string[]|undefined>} AnyFlavorRhythm
 */

/**
 * Portfolio visibility
 * @readonly
 * @enum {string}
 */
export const PORTFOLIO_VISIBILITY = {
  PRIVATE: "private",
  FAMILY: "family",
  PUBLIC: "public",
};

/**
 * Marketplace metadata
 * @typedef {Object} MarketplaceMeta
 * @property {boolean=} enabled
 * @property {number=} price            // e.g., 2, 5, 10 (USD)
 * @property {number=} uniquenessScore  // 0..1 computed
 * @property {string=} listedAt         // ISO string
 */

/**
 * Core Portfolio shape
 * @typedef {Object} Portfolio
 * @property {string} id
 * @property {string} ownerId
 * @property {string} title
 * @property {string=} description
 * @property {string[]} recipeIds
 * @property {("private"|"family"|"public")=} visibility
 * @property {MarketplaceMeta=} marketplace
 * @property {FlavorDayMap=} weeklyFlavorRhythm  // OPTIONAL (Mon→Sun, per your request)
 * @property {string[]=} tags                    // OPTIONAL string tags
 * @property {Object.=} meta                     // free-form (e.g., flavor summary, cover)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Normalizers & utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize tags: trim, dedupe, keep case for display but dedupe case-insensitively.
 * @param {string[]|undefined|null} input
 * @returns {string[]}
 */
export function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const s = String(raw || "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Normalize a provided FlavorDayMap (Gregorian) to a complete map for the current scheme.
 * - If scheme is GREGORIAN → return complete Mon→Sun map.
 * - If scheme is CREATION → convert by simply storing values under the scheme's keys
 *   if they already match; otherwise fall back to empty for those keys.
 *   (Your upstream generator typically uses Creation keys; callers can also pass a
 *   ready-made Creation rhythm directly via `overrideRhythm` if they have it.)
 *
 * @param {AnyFlavorRhythm|undefined} provided
 * @param {("creation"|"gregorian")=} scheme
 * @returns {AnyFlavorRhythm}
 */
export function normalizePortfolioRhythm(provided, scheme = RHYTHM_SCHEME.CREATION) {
  // If the provided map looks like Creation keys, just normalize with that scheme.
  const looksCreation =
    provided &&
    typeof provided === "object" &&
    ["day_one","day_two","day_three","day_four","day_five","day_six","sabbath"]
      .some(k => Array.isArray(provided[k]));

  if (looksCreation) {
    return normalizeRhythm(provided, RHYTHM_SCHEME.CREATION);
  }

  // Otherwise treat it as Gregorian (the FlavorDayMap shape in your request)
  const normGreg = normalizeRhythm(provided || {}, RHYTHM_SCHEME.GREGORIAN);

  if (scheme === RHYTHM_SCHEME.GREGORIAN) {
    return normGreg;
  }

  // scheme === CREATION: start with empty Creation map, then *softly* map by weekday index.
  // Sun..Sat (JS) == [sunday, monday, tuesday, wednesday, thursday, friday, saturday]
  // We’ll align indices so that:
  //   Sun  -> day_one
  //   Mon  -> day_two
  //   ...
  //   Sat  -> sabbath
  const out = defaultRhythm(RHYTHM_SCHEME.CREATION);
  const gregKeys = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const creationKeys = ["day_one","day_two","day_three","day_four","day_five","day_six","sabbath"];
  gregKeys.forEach((gKey, idx) => {
    const cKey = creationKeys[idx];
    const arr = normGreg[gKey] || [];
    if (Array.isArray(arr) && arr.length) out[cKey] = arr;
  });
  return out;
}

/**
 * Normalize a Portfolio object (non-destructive for future fields).
 * - Ensures `tags` are deduped.
 * - Ensures `visibility` is known.
 * - Normalizes `weeklyFlavorRhythm` for the selected scheme (Creation default).
 *
 * @param {Partial<Portfolio>} input
 * @param {{scheme?: "creation"|"gregorian", overrideRhythm?: AnyFlavorRhythm}=} opts
 * @returns {Portfolio}
 */
export function normalizePortfolio(input, opts = {}) {
  const scheme = opts.scheme || RHYTHM_SCHEME.CREATION;
  const overrideRhythm = opts.overrideRhythm;

  const base = /** @type {Portfolio} */ ({
    id: String(input?.id || cryptoId()),
    ownerId: String(input?.ownerId || ""),
    title: String(input?.title || "Untitled Portfolio"),
    description: input?.description ? String(input.description) : undefined,
    recipeIds: Array.isArray(input?.recipeIds) ? input.recipeIds.map(String) : [],
    visibility: input?.visibility || PORTFOLIO_VISIBILITY.PRIVATE,
    marketplace: input?.marketplace || { enabled: false },
    weeklyFlavorRhythm: undefined,
    tags: normalizeTags(input?.tags),
    meta: input?.meta || {},
  });

  // Rhythm: prefer explicit override (already normalized), else normalize provided field.
  if (overrideRhythm) {
    base.weeklyFlavorRhythm = normalizePortfolioRhythm(overrideRhythm, scheme);
  } else if (input?.weeklyFlavorRhythm) {
    base.weeklyFlavorRhythm = normalizePortfolioRhythm(input.weeklyFlavorRhythm, scheme);
  } else {
    // keep undefined to distinguish "unset" from "empty"
    base.weeklyFlavorRhythm = undefined;
  }

  // Guard visibility
  if (!Object.values(PORTFOLIO_VISIBILITY).includes(base.visibility)) {
    base.visibility = PORTFOLIO_VISIBILITY.PRIVATE;
  }

  return base;
}

/**
 * Merge a preset rhythm (from Creation or Gregorian) into an existing portfolio rhythm.
 * De-dupes values and preserves the target scheme’s keys.
 *
 * @param {AnyFlavorRhythm|undefined} portfolioRhythm
 * @param {AnyFlavorRhythm|undefined} presetRhythm
 * @param {"creation"|"gregorian"} scheme
 * @returns {AnyFlavorRhythm}
 */
export function mergePortfolioRhythmWithPreset(portfolioRhythm, presetRhythm, scheme = RHYTHM_SCHEME.CREATION) {
  const a = portfolioRhythm ? normalizePortfolioRhythm(portfolioRhythm, scheme) : defaultRhythm(scheme);
  const b = presetRhythm ? normalizePortfolioRhythm(presetRhythm, scheme) : defaultRhythm(scheme);
  return mergeRhythms(b, a, scheme); // preset first, then user overrides/adds
}

// ─────────────────────────────────────────────────────────────────────────────
/* Marketplace: uniqueness scoring & eligibility */
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute uniqueness score vs. a global catalog of known recipe IDs.
 * Score = (# of recipeIds not present in catalog) / (total recipeIds)
 *
 * @param {string[]} recipeIds
 * @param {Set<string>|string[]} globalCatalogIds  // Set recommended
 * @returns {number}  // 0..1
 */
export function computeUniquenessScore(recipeIds, globalCatalogIds) {
  const ids = Array.isArray(recipeIds) ? recipeIds.map(String) : [];
  const catalog = Array.isArray(globalCatalogIds) ? new Set(globalCatalogIds.map(String)) : (globalCatalogIds || new Set());
  if (!ids.length) return 0;
  let unique = 0;
  for (const id of ids) {
    if (!catalog.has(id)) unique++;
  }
  return unique / ids.length;
}

/**
 * Portfolio is eligible for marketplace if:
 *  - marketplace.enabled === true
 *  - uniquenessScore >= threshold (default 0.30)
 *
 * @param {Portfolio} portfolio
 * @param {number=} threshold
 * @returns {boolean}
 */
export function isMarketplaceEligible(portfolio, threshold = 0.30) {
  const enabled = !!portfolio?.marketplace?.enabled;
  const score = Number(portfolio?.marketplace?.uniquenessScore ?? 0);
  return enabled && isFinite(score) && score >= threshold;
}

/**
 * Update marketplace fields immutably with a newly computed uniqueness score.
 * @param {Portfolio} portfolio
 * @param {Set<string>|string[]} catalogIds
 * @returns {Portfolio}
 */
export function withUniquenessComputed(portfolio, catalogIds) {
  const score = computeUniquenessScore(portfolio?.recipeIds || [], catalogIds);
  return {
    ...portfolio,
    marketplace: {
      ...(portfolio.marketplace || {}),
      uniquenessScore: score,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Tiny id helper for local-only creation (replace with uuid in prod) */
function cryptoId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "p_" + Math.random().toString(36).slice(2, 10);
}

/**
 * Quick label summary of which days have flavors set (for cards/chips).
 * @param {AnyFlavorRhythm|undefined} rhythm
 * @param {"creation"|"gregorian"} scheme
 * @returns {string} e.g., "Day One, Day Four, Sabbath" or "Mon, Wed, Fri"
 */
export function rhythmSummary(rhythm, scheme = RHYTHM_SCHEME.CREATION) {
  if (!rhythm) return "";
  const keys = getDayKeys(scheme);
  const days = [];
  for (const k of keys) {
    const arr = rhythm[k];
    if (Array.isArray(arr) && arr.length) days.push(k);
  }
  if (!days.length) return "";
  if (scheme === RHYTHM_SCHEME.GREGORIAN) {
    const short = { monday:"Mon", tuesday:"Tue", wednesday:"Wed", thursday:"Thu", friday:"Fri", saturday:"Sat", sunday:"Sun" };
    return days.map(d => short[d] || d).join(", ");
  }
  const english = {
    day_one:"Day One", day_two:"Day Two", day_three:"Day Three",
    day_four:"Day Four", day_five:"Day Five", day_six:"Day Six", sabbath:"Sabbath"
  };
  return days.map(d => english[d] || d).join(", ");
}
