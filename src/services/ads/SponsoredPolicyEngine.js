// src/services/ads/SponsoredPolicyEngine.js
// Trust-safe sponsored placement policy engine
// Rules:
// - caps per session (impressions + sponsored cards shown)
// - avoid misleading placement (must be clearly labeled + eligible)
// - only show sponsor if still meets user filters (distance/category/etc.)

const isBrowser = typeof window !== "undefined";

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const now = () => Date.now();

function safeStr(v) {
  try {
    return String(v ?? "");
  } catch {
    return "";
  }
}

/**
 * Default caps — conservative.
 * You can override these from SponsoredPlacementService options.
 */
export const DEFAULT_SPONSORED_CAPS = {
  maxSponsoredCardsPerSession: 1,
  maxImpressionsPerSession: 6,
  minSecondsBetweenImpressions: 8,
};

/**
 * Minimal, stable filter contract for local places/stores.
 * We intentionally keep it loose so you can pass Google Places/Locals objects
 * or your own normalized store objects.
 */
export function normalizePlace(place = {}) {
  const p = place || {};
  const id =
    p.place_id ||
    p.placeId ||
    p.id ||
    p.storeId ||
    (p.location && `${p.location.lat},${p.location.lng}`) ||
    "";

  const category =
    (Array.isArray(p.types) && p.types[0]) ||
    p.category ||
    p.primaryCategory ||
    p.kind ||
    "";

  const name = p.name || p.title || p.storeName || "";

  // Distance may already be computed by upstream.
  const distanceMeters = Number.isFinite(p.distanceMeters)
    ? p.distanceMeters
    : null;

  const isOpenNow =
    typeof p.open_now === "boolean"
      ? p.open_now
      : typeof p.openNow === "boolean"
      ? p.openNow
      : null;

  return {
    raw: p,
    id: safeStr(id),
    name: safeStr(name),
    category: safeStr(category),
    distanceMeters,
    isOpenNow,
  };
}

export function normalizeFilters(filters = {}) {
  const f = filters || {};
  const maxDistanceMeters = Number.isFinite(f.maxDistanceMeters)
    ? clamp(f.maxDistanceMeters, 100, 200_000)
    : null;

  const allowedCategories = Array.isArray(f.allowedCategories)
    ? f.allowedCategories.map((x) => safeStr(x).toLowerCase()).filter(Boolean)
    : null;

  const requireOpenNow = !!f.requireOpenNow;

  return { maxDistanceMeters, allowedCategories, requireOpenNow };
}

export function placeMatchesFilters(place, filters) {
  const p = normalizePlace(place);
  const f = normalizeFilters(filters);

  if (!p.id) return { ok: false, reason: "missing_place_id" };

  if (f.maxDistanceMeters != null && p.distanceMeters != null) {
    if (p.distanceMeters > f.maxDistanceMeters) {
      return { ok: false, reason: "distance_filter" };
    }
  }

  if (f.allowedCategories && f.allowedCategories.length) {
    const cat = safeStr(p.category).toLowerCase();
    const types = Array.isArray(p.raw?.types)
      ? p.raw.types.map((x) => safeStr(x).toLowerCase())
      : [];
    const matches =
      f.allowedCategories.includes(cat) ||
      types.some((t) => f.allowedCategories.includes(t));
    if (!matches) return { ok: false, reason: "category_filter" };
  }

  if (f.requireOpenNow && p.isOpenNow === false) {
    return { ok: false, reason: "open_now_filter" };
  }

  return { ok: true };
}

/**
 * Evaluate whether a candidate is eligible for sponsored placement.
 *
 * @param {Object} args
 * @param {Object} args.place - store/place candidate
 * @param {Object} args.filters - current user filters (distance/category/open-now)
 * @param {Object} args.session - session context (id, counters)
 * @param {Object} args.caps - caps config
 * @param {Object} args.ui - ui capabilities (must be able to display badge)
 */
export function evaluateSponsoredEligibility({
  place,
  filters,
  session = {},
  caps = DEFAULT_SPONSORED_CAPS,
  ui = {},
} = {}) {
  const p = normalizePlace(place);

  // Trust-safe: MUST be label-able or we refuse to sponsor.
  const canBadge =
    ui?.canShowSponsoredBadge === true ||
    ui?.canLabelSponsored === true ||
    ui?.sponsoredBadge === true;

  if (!canBadge) {
    return { ok: false, reason: "ui_cannot_label_sponsored" };
  }

  // Must match user filters exactly (no bait-and-switch).
  const mf = placeMatchesFilters(p.raw, filters);
  if (!mf.ok) return { ok: false, reason: `filters:${mf.reason}` };

  // Session caps
  const maxCards = Number.isFinite(caps.maxSponsoredCardsPerSession)
    ? clamp(caps.maxSponsoredCardsPerSession, 0, 10)
    : DEFAULT_SPONSORED_CAPS.maxSponsoredCardsPerSession;

  const maxImps = Number.isFinite(caps.maxImpressionsPerSession)
    ? clamp(caps.maxImpressionsPerSession, 0, 50)
    : DEFAULT_SPONSORED_CAPS.maxImpressionsPerSession;

  const shownCards = Number.isFinite(session.sponsoredCardsShown)
    ? session.sponsoredCardsShown
    : 0;

  const imps = Number.isFinite(session.sponsoredImpressions)
    ? session.sponsoredImpressions
    : 0;

  if (maxCards === 0 || maxImps === 0) return { ok: false, reason: "caps_off" };
  if (shownCards >= maxCards) return { ok: false, reason: "cap_cards" };
  if (imps >= maxImps) return { ok: false, reason: "cap_impressions" };

  // Throttle impressions
  const minGapSec = Number.isFinite(caps.minSecondsBetweenImpressions)
    ? clamp(caps.minSecondsBetweenImpressions, 0, 600)
    : DEFAULT_SPONSORED_CAPS.minSecondsBetweenImpressions;

  const lastTs = Number.isFinite(session.lastSponsoredImpressionAt)
    ? session.lastSponsoredImpressionAt
    : null;

  if (lastTs && minGapSec > 0 && now() - lastTs < minGapSec * 1000) {
    return { ok: false, reason: "throttle_impressions" };
  }

  // Avoid misleading placement:
  // - if place lacks basic identity, refuse
  if (!p.name || !p.id) return { ok: false, reason: "insufficient_identity" };

  return { ok: true, reason: "eligible" };
}
