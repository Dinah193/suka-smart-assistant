// src/services/ads/SponsoredPlacementService.js
// Chooses which local store card is sponsored and creates an impression record.
// Local-only unless user opts in (prefs). Also respects trust-safe policy engine.

import {
  DEFAULT_SPONSORED_CAPS,
  evaluateSponsoredEligibility,
  normalizePlace,
} from "./SponsoredPolicyEngine";
import AdsTelemetryService from "./AdsTelemetryService";

const isBrowser = typeof window !== "undefined";

const safeJSON = {
  parse: (s, f = null) => {
    try {
      return JSON.parse(s);
    } catch {
      return f;
    }
  },
  stringify: (o) => {
    try {
      return JSON.stringify(o);
    } catch {
      return "";
    }
  },
};

const storage = (() => {
  const keyPrefix = "suka::ads::";
  if (isBrowser && window.localStorage) {
    return {
      get: (k, d = null) =>
        safeJSON.parse(localStorage.getItem(keyPrefix + k), d),
      set: (k, v) => localStorage.setItem(keyPrefix + k, safeJSON.stringify(v)),
      del: (k) => localStorage.removeItem(keyPrefix + k),
    };
  }
  const mem = new Map();
  return {
    get: (k, d = null) => (mem.has(k) ? mem.get(k) : d),
    set: (k, v) => mem.set(k, v),
    del: (k) => mem.delete(k),
  };
})();

const PREF_KEY = "prefs";

export function getAdsPrefs() {
  return storage.get(PREF_KEY, {
    sponsoredPlacementsEnabled: true, // master toggle
    shareAdsTelemetry: false, // opt-in only
    premiumConversionProxy: false, // optional premium feature gate
    explainersEnabled: true,
  });
}

export function setAdsPrefs(partial = {}) {
  const prev = getAdsPrefs();
  const next = { ...prev, ...(partial || {}) };
  storage.set(PREF_KEY, next);

  // Let the app react without tight coupling.
  try {
    window.dispatchEvent(
      new CustomEvent("ads.preferences.changed", { detail: { prev, next } })
    );
  } catch {}

  // Also align with broader settings event style (if you use it elsewhere).
  try {
    window.dispatchEvent(
      new CustomEvent("preferences.changed", {
        detail: { domain: "ads", prev, next },
      })
    );
  } catch {}

  return next;
}

export function openWhyThisAdModal(payload = {}) {
  try {
    window.dispatchEvent(new CustomEvent("ads.why.open", { detail: payload }));
  } catch {}
}

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Sponsored pool contract:
 * Each sponsored candidate should include:
 * - placeId / place_id (must match a place in the visible list OR be mappable)
 * - bid (optional)
 * - sponsorId (optional)
 * - campaignId (optional)
 * - creative (optional)
 *
 * You can build this pool from “Google Locals / promoted results”
 * OR from your own local ad marketplace later.
 */
function scoreCandidate({ place, sponsored = {} } = {}) {
  const bid = Number.isFinite(sponsored.bid) ? sponsored.bid : 0;
  const rating = Number.isFinite(place?.raw?.rating) ? place.raw.rating : 0;
  const distance = Number.isFinite(place?.distanceMeters)
    ? place.distanceMeters
    : 999999;

  // Trust-safe: bid helps selection, but never overrides user filters or caps.
  // Score should be monotonic but not extreme.
  const score =
    bid * 10 + rating * 2 + (distance > 0 ? Math.min(5, 2000 / distance) : 0);

  return score;
}

function buildSessionKey(sessionId) {
  return `session:${String(sessionId || "default")}`;
}

function getSessionCounters(sessionId) {
  const key = buildSessionKey(sessionId);
  return storage.get(key, {
    sponsoredCardsShown: 0,
    sponsoredImpressions: 0,
    lastSponsoredImpressionAt: null,
  });
}

function setSessionCounters(sessionId, patch = {}) {
  const key = buildSessionKey(sessionId);
  const cur = getSessionCounters(sessionId);
  const next = { ...cur, ...(patch || {}) };
  storage.set(key, next);
  return next;
}

/**
 * Choose one sponsored place among visible places.
 * Returns:
 * - sponsoredPlaceId
 * - sponsoredMeta
 * - updatedPlaces (same array, but with `__sponsored` marker on one item)
 */
export async function chooseSponsoredPlacement({
  places = [],
  sponsoredPool = [],
  filters = {},
  sessionId = "default",
  ui = { canShowSponsoredBadge: true },
  caps = DEFAULT_SPONSORED_CAPS,
  context = {}, // extra diagnostic context (search query, user intent, etc.)
} = {}) {
  const prefs = getAdsPrefs();
  if (!prefs.sponsoredPlacementsEnabled) {
    return { ok: true, sponsoredPlaceId: null, places, reason: "disabled" };
  }

  const normalized = (places || [])
    .map((p) => normalizePlace(p))
    .filter((p) => p.id);

  if (!normalized.length) {
    return { ok: true, sponsoredPlaceId: null, places, reason: "no_places" };
  }

  const pool = Array.isArray(sponsoredPool) ? sponsoredPool : [];
  if (!pool.length) {
    return {
      ok: true,
      sponsoredPlaceId: null,
      places,
      reason: "no_sponsored_pool",
    };
  }

  const counters = getSessionCounters(sessionId);

  // Build candidate list: must correspond to visible places.
  const byId = new Map(normalized.map((p) => [p.id, p]));
  const candidates = [];

  for (const s of pool) {
    const pid = String(s?.place_id || s?.placeId || s?.id || "");
    if (!pid) continue;
    const place = byId.get(pid);
    if (!place) continue; // we only sponsor something actually shown

    const eligible = evaluateSponsoredEligibility({
      place: place.raw,
      filters,
      session: counters,
      caps,
      ui,
    });

    if (!eligible.ok) continue;

    candidates.push({
      place,
      sponsored: s,
      score: scoreCandidate({ place, sponsored: s }),
    });
  }

  if (!candidates.length) {
    return {
      ok: true,
      sponsoredPlaceId: null,
      places,
      reason: "no_eligible_candidates",
    };
  }

  // Pick highest score (deterministic). You can switch to weighted random later if desired.
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const picked = candidates[0];

  const sponsoredPlaceId = picked.place.id;
  const sponsoredMeta = {
    sponsorId:
      picked.sponsored.sponsorId || picked.sponsored.sponsor_id || null,
    campaignId:
      picked.sponsored.campaignId || picked.sponsored.campaign_id || null,
    bid: Number.isFinite(picked.sponsored.bid) ? picked.sponsored.bid : null,
    source: picked.sponsored.source || "google-locals",
    reason: "eligible_and_selected",
  };

  // Mark it on the original places array for rendering
  const updatedPlaces = (places || []).map((p) => {
    const id = String(p?.place_id || p?.placeId || p?.id || p?.storeId || "");
    if (id && id === sponsoredPlaceId) {
      return {
        ...p,
        __sponsored: true,
        __sponsoredMeta: sponsoredMeta,
      };
    }
    return {
      ...p,
      __sponsored: false,
    };
  });

  // Record impression intent now (render layer should call recordImpression when actually displayed),
  // but we also create a local impression record here for durability.
  const impression = {
    id: `imp_${genId()}`,
    sessionId: String(sessionId),
    placeId: sponsoredPlaceId,
    ts: Date.now(),
    meta: sponsoredMeta,
    context: {
      filters,
      query: context?.query || null,
      intent: context?.intent || null,
    },
  };

  // Update counters (card shown)
  setSessionCounters(sessionId, {
    sponsoredCardsShown: (counters.sponsoredCardsShown || 0) + 1,
  });

  await AdsTelemetryService.recordImpression(impression, { prefs });

  return {
    ok: true,
    sponsoredPlaceId,
    sponsoredMeta,
    impressionId: impression.id,
    places: updatedPlaces,
  };
}

/**
 * Call this when the sponsored card is actually rendered in-view.
 * (e.g., IntersectionObserver in your store list UI.)
 */
export async function recordSponsoredImpression({
  sessionId = "default",
  placeId,
  impressionId,
  meta = {},
  context = {},
} = {}) {
  const prefs = getAdsPrefs();
  if (!prefs.sponsoredPlacementsEnabled)
    return { ok: false, reason: "disabled" };
  if (!placeId) return { ok: false, reason: "missing_placeId" };

  const counters = getSessionCounters(sessionId);
  setSessionCounters(sessionId, {
    sponsoredImpressions: (counters.sponsoredImpressions || 0) + 1,
    lastSponsoredImpressionAt: Date.now(),
  });

  const payload = {
    id: impressionId || `imp_${genId()}`,
    sessionId: String(sessionId),
    placeId: String(placeId),
    ts: Date.now(),
    meta,
    context,
  };

  await AdsTelemetryService.recordImpression(payload, { prefs });

  return { ok: true };
}

/**
 * Call this on click (e.g., “View store details”).
 */
export async function recordSponsoredClick({
  sessionId = "default",
  placeId,
  impressionId = null,
  meta = {},
  context = {},
} = {}) {
  const prefs = getAdsPrefs();
  if (!prefs.sponsoredPlacementsEnabled)
    return { ok: false, reason: "disabled" };
  if (!placeId) return { ok: false, reason: "missing_placeId" };

  const payload = {
    id: `clk_${genId()}`,
    sessionId: String(sessionId),
    placeId: String(placeId),
    impressionId,
    ts: Date.now(),
    meta,
    context,
  };

  await AdsTelemetryService.recordClick(payload, { prefs });
  return { ok: true };
}

/**
 * Optional “conversion proxy”:
 * Receipt-confirmed purchase at store (premium / opt-in).
 */
export async function recordSponsoredConversionProxy({
  sessionId = "default",
  placeId,
  receiptId,
  meta = {},
  context = {},
} = {}) {
  const prefs = getAdsPrefs();
  if (!prefs.sponsoredPlacementsEnabled)
    return { ok: false, reason: "disabled" };
  if (!prefs.premiumConversionProxy)
    return { ok: false, reason: "premium_disabled" };
  if (!placeId || !receiptId) return { ok: false, reason: "missing_fields" };

  const payload = {
    id: `cnv_${genId()}`,
    sessionId: String(sessionId),
    placeId: String(placeId),
    receiptId: String(receiptId),
    ts: Date.now(),
    meta,
    context,
  };

  await AdsTelemetryService.recordConversionProxy(payload, { prefs });
  return { ok: true };
}
