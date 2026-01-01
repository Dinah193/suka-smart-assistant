// src/services/locals/LocalsResolver.js
// -----------------------------------------------------------------------------
// LocalsResolver
// -----------------------------------------------------------------------------
// Input: user-selected stores + radius (+ optional center point)
// Output: normalized store list for shopping session
//
// - Expands selected stores by searching nearby competitors (optional)
// - Resolves place details (hours/address/categories) via GoogleLocalsClient
// - Caches place profiles via LocalsCache
// - Produces normalized store objects compatible with Shopping store selection.
//
// Normalized store shape (aligned to StoreSelectorService):
// {
//   id: "place:<placeId>" | "chain:<chainKey>",
//   kind: "location" | "chain",
//   name,
//   chain: { key, name } | null,
//   placeId,
//   address,
//   lat, lon,
//   tags: [],
//   categories: [],
//   hours: { openNow, weekdayText } | null,
//   source: "google"|"cache"|"user",
//   updatedAt
// }
//
// Emits (optional, if eventBus provided):
// - "locals:resolver.progress" { step, done, total, message }
// -----------------------------------------------------------------------------

import GoogleLocalsClient from "@/services/locals/GoogleLocalsClient";
import LocalsCache from "@/services/locals/LocalsCache";

function now() {
  return Date.now();
}
function safeStr(x) {
  return String(x || "").trim();
}
function normKey(x) {
  return safeStr(x)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_:-]/g, "");
}
function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}
function uniqBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function getEventBusFromGlobals() {
  if (typeof window === "undefined") return null;
  return window.__SUKA_EVENT_BUS__ || null;
}

export default class LocalsResolver {
  constructor(opts = {}) {
    this.eventBus = opts.eventBus ||
      getEventBusFromGlobals() || {
        emit: () => {},
        on: () => {},
        off: () => {},
      };

    this.client = opts.client || new GoogleLocalsClient(opts.clientOpts || {});
    this.cache = opts.cache || new LocalsCache(opts.cacheOpts || {});

    // default categories for competitors
    this.defaultKeywords = Array.isArray(opts.keywords)
      ? opts.keywords
      : ["grocery store", "supermarket"];

    this.detailsFields = opts.detailsFields || [
      "place_id",
      "name",
      "formatted_address",
      "geometry",
      "types",
      "opening_hours",
      "business_status",
      "rating",
      "user_ratings_total",
      "website",
      "url",
      "formatted_phone_number",
    ];
  }

  /**
   * Resolve a normalized list for shopping session.
   *
   * @param {Object} params
   * @param {Array} params.selectedStores - stores user selected (chain or place)
   * @param {number} params.radiusMeters - search radius for competitors
   * @param {Object|null} params.center - {lat, lon} used for nearby search
   * @param {boolean} params.expandNearby - include nearby discovered stores
   * @param {boolean} params.fetchDetails - fetch place details for better profile
   * @param {AbortSignal} params.signal
   */
  async resolveStores({
    selectedStores = [],
    radiusMeters = 5000,
    center = null,
    expandNearby = true,
    fetchDetails = true,
    signal,
  } = {}) {
    const radius = clamp(radiusMeters, 100, 50000);
    const selected = Array.isArray(selectedStores) ? selectedStores : [];

    // Normalize selected into a stable base list.
    const base = selected
      .map((s) => this._normalizeIncomingStore(s))
      .filter(Boolean);

    // Choose a center:
    // - explicit center if provided
    // - else first location store's lat/lon
    const chosenCenter =
      center &&
      typeof center === "object" &&
      toNum(center.lat) != null &&
      toNum(center.lon) != null
        ? { lat: toNum(center.lat), lon: toNum(center.lon) }
        : pickFirstLatLon(base);

    let discovered = [];
    if (expandNearby && chosenCenter) {
      this._emitProgress({
        step: "nearby-search",
        message: "Searching nearby stores…",
      });

      // nearby search for each keyword and merge
      const batches = [];
      for (const kw of this.defaultKeywords) {
        batches.push(
          this.client.nearbySearch({
            lat: chosenCenter.lat,
            lon: chosenCenter.lon,
            radius,
            keyword: kw,
            signal,
          })
        );
      }

      const results = await Promise.allSettled(batches);
      const places = results
        .filter((r) => r.status === "fulfilled")
        .flatMap((r) => r.value || []);

      discovered = places
        .map((p) => this._normalizePlace(p, { source: "google" }))
        .filter(Boolean);

      // remove anything already selected (by placeId)
      discovered = discovered.filter((d) => {
        if (!d.placeId) return true;
        return !base.some(
          (b) => safeStr(b.placeId) && safeStr(b.placeId) === safeStr(d.placeId)
        );
      });
    }

    let combined = uniqBy([...base, ...discovered], (s) => safeStr(s.id));

    // Optionally enrich with details + cache
    if (fetchDetails) {
      this._emitProgress({
        step: "details",
        message: "Fetching store details…",
      });

      // Only location stores with placeId
      const locs = combined.filter((s) => s.kind === "location" && s.placeId);

      const total = locs.length;
      let done = 0;

      const enrichedLocs = [];
      for (const s of locs) {
        if (signal?.aborted) break;

        const placeId = safeStr(s.placeId);
        const cached = await this.cache.getWithStaleness(placeId);

        if (cached.row?.profile && !cached.isStale && !cached.isExpired) {
          enrichedLocs.push(
            this._mergeProfileIntoStore(s, cached.row.profile, "cache")
          );
        } else {
          // Use cached profile immediately if present (stale-while-revalidate)
          if (cached.row?.profile) {
            enrichedLocs.push(
              this._mergeProfileIntoStore(s, cached.row.profile, "cache")
            );
          } else {
            enrichedLocs.push(s);
          }

          // Fetch fresh details
          try {
            const details = await this.client.placeDetails({
              placeId,
              fields: this.detailsFields,
              signal,
            });
            if (details) {
              const profile = this._detailsToProfile(details);
              await this.cache.put(placeId, profile);

              // replace last entry for this store with fresh merge
              enrichedLocs[enrichedLocs.length - 1] =
                this._mergeProfileIntoStore(s, profile, "google");
            }
          } catch {
            // keep stale or base
          }
        }

        done += 1;
        this._emitProgress({
          step: "details",
          done,
          total,
          message: `Resolved ${done}/${total}`,
        });
      }

      // Rebuild combined with enriched location stores
      const enrichedById = new Map(enrichedLocs.map((x) => [safeStr(x.id), x]));
      combined = combined.map((x) => enrichedById.get(safeStr(x.id)) || x);
    }

    // Final normalized list
    combined = combined.map((s) => ({
      ...s,
      updatedAt: now(),
    }));

    this._emitProgress({ step: "done", message: "Store list ready." });
    return combined;
  }

  /* ------------------------------ Internals ------------------------------ */

  _emitProgress(payload) {
    this.eventBus.emit?.("locals:resolver.progress", payload);
  }

  _normalizeIncomingStore(s) {
    if (!s || typeof s !== "object") return null;

    // Already normalized from StoreSelectorService
    if (s.id && (s.kind === "location" || s.kind === "chain")) {
      return {
        id: safeStr(s.id),
        kind: s.kind,
        name: s.name || "Store",
        chain: s.chain || null,
        placeId: s.placeId || null,
        address: s.address || null,
        lat: toNum(s.lat),
        lon: toNum(s.lon),
        tags: Array.isArray(s.tags) ? s.tags : [],
        categories: Array.isArray(s.categories) ? s.categories : [],
        hours: s.hours || null,
        source: s.source || "user",
        updatedAt: now(),
      };
    }

    // Chain-only selection
    if (s.chainKey || s.kind === "chain") {
      const ck = normKey(s.chainKey || s.key || s.name);
      const nm = s.name || ck;
      return {
        id: `chain:${ck}`,
        kind: "chain",
        name: nm,
        chain: { key: ck, name: nm },
        placeId: null,
        address: null,
        lat: null,
        lon: null,
        tags: [],
        categories: [],
        hours: null,
        source: "user",
        updatedAt: now(),
      };
    }

    // Place-like selection
    const placeId = safeStr(s.placeId || s.place_id || s.googlePlaceId);
    if (placeId) {
      return this._normalizePlace(
        {
          placeId,
          name: s.name,
          address: s.address,
          lat: s.lat,
          lon: s.lon,
          types: s.types || s.categories,
        },
        { source: "user" }
      );
    }

    return null;
  }

  _normalizePlace(p, { source = "google" } = {}) {
    if (!p) return null;
    const placeId = safeStr(p.placeId || p.place_id || p.id);
    if (!placeId) return null;

    const name = p.name || "Store";
    const types = Array.isArray(p.types)
      ? p.types
      : Array.isArray(p.categories)
      ? p.categories
      : [];
    const address =
      p.address ||
      p.formatted_address ||
      p.formattedAddress ||
      p.vicinity ||
      null;

    // Chain inference: very light heuristic; you can replace with a real chain matcher later.
    const chain = inferChainFromName(name);

    return {
      id: `place:${placeId}`,
      kind: "location",
      name,
      chain,
      placeId,
      address,
      lat: toNum(p.lat ?? p.geometry?.location?.lat),
      lon: toNum(p.lon ?? p.geometry?.location?.lng),
      tags: [],
      categories: types.map(String),
      hours: null,
      source,
      updatedAt: now(),
    };
  }

  _detailsToProfile(details) {
    return {
      placeId: safeStr(details.placeId),
      name: details.name || "Store",
      address: details.address || null,
      lat: toNum(details.lat),
      lon: toNum(details.lon),
      categories: Array.isArray(details.types) ? details.types : [],
      hours: details.openingHours
        ? {
            openNow: details.openingHours.openNow ?? null,
            weekdayText: Array.isArray(details.openingHours.weekdayText)
              ? details.openingHours.weekdayText
              : [],
          }
        : null,
      rating: details.rating ?? null,
      userRatingsTotal: details.userRatingsTotal ?? null,
      phone: details.phone || null,
      website: details.website || null,
      googleUrl: details.googleUrl || null,
      businessStatus: details.businessStatus || null,
      updatedAt: now(),
    };
  }

  _mergeProfileIntoStore(store, profile, source = "cache") {
    const p = profile && typeof profile === "object" ? profile : null;
    if (!p) return store;

    const chain = store.chain || inferChainFromName(p.name || store.name);

    return {
      ...store,
      name: p.name || store.name,
      address: p.address || store.address,
      lat: toNum(p.lat) ?? store.lat,
      lon: toNum(p.lon) ?? store.lon,
      categories: Array.isArray(p.categories) ? p.categories : store.categories,
      hours: p.hours || store.hours,
      chain,
      source,
      updatedAt: now(),
    };
  }
}

/* ------------------------------ Helpers ------------------------------ */

function pickFirstLatLon(stores) {
  for (const s of stores || []) {
    if (
      s?.kind === "location" &&
      Number.isFinite(s?.lat) &&
      Number.isFinite(s?.lon)
    ) {
      return { lat: s.lat, lon: s.lon };
    }
  }
  return null;
}

function inferChainFromName(name) {
  const n = String(name || "").toLowerCase();

  const known = [
    ["walmart", { key: "walmart", name: "Walmart" }],
    ["target", { key: "target", name: "Target" }],
    ["kroger", { key: "kroger", name: "Kroger" }],
    ["aldi", { key: "aldi", name: "ALDI" }],
    ["costco", { key: "costco", name: "Costco" }],
    ["sam's", { key: "sams_club", name: "Sam's Club" }],
    ["whole foods", { key: "whole_foods", name: "Whole Foods" }],
    ["publix", { key: "publix", name: "Publix" }],
    ["h-e-b", { key: "h_e_b", name: "H-E-B" }],
    ["heb", { key: "h_e_b", name: "H-E-B" }],
  ];

  for (const [needle, chain] of known) {
    if (n.includes(needle)) return chain;
  }
  return null;
}
