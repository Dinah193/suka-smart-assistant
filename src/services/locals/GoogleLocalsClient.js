// src/services/locals/GoogleLocalsClient.js
// -----------------------------------------------------------------------------
// GoogleLocalsClient (Google Places / Locals wrapper)
// -----------------------------------------------------------------------------
// Goals:
// - Text search / Nearby search for store discovery (grocery, supermarket, etc.)
// - Place Details fetch (hours, address, categories, phone, website, etc.)
// - Safe "proxy first" design to avoid exposing API keys + avoid CORS
//
// Usage modes:
// 1) Proxy mode (recommended): set VITE_GOOGLE_PLACES_PROXY=1
//    Calls your backend endpoints:
//      GET  /api/locals/text-search?query=...&lat=..&lon=..&radius=..
//      GET  /api/locals/nearby-search?keyword=...&lat=..&lon=..&radius=..
//      GET  /api/locals/place-details?placeId=...&fields=...
//
// 2) Direct mode (dev only): VITE_GOOGLE_PLACES_PROXY=0
//    Calls Google Places endpoints directly (may be blocked by CORS).
// -----------------------------------------------------------------------------

import {
  API_BASE_URL,
  GOOGLE_PLACES_API_KEY,
  GOOGLE_MAPS_API_KEY,
} from "@/config";
import { buildApiUrl, fetchJson } from "@/utils/apiConfig";

const DEFAULT_TIMEOUT_MS = 12000;

// Prefer places key; fallback to maps key if you only set one.
function resolveKey() {
  return GOOGLE_PLACES_API_KEY || GOOGLE_MAPS_API_KEY || "";
}

function truthyEnv(v) {
  const s = String(v ?? "")
    .toLowerCase()
    .trim();
  return s === "1" || s === "true" || s === "yes" || s === "on";
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

function normalizeLatLon(lat, lon) {
  const la = toNum(lat);
  const lo = toNum(lon);
  if (la == null || lo == null) return null;
  return { lat: la, lon: lo };
}

export default class GoogleLocalsClient {
  constructor(opts = {}) {
    this.apiBase = opts.apiBase || API_BASE_URL || "/api";
    this.useProxy =
      typeof opts.useProxy === "boolean"
        ? opts.useProxy
        : truthyEnv(import.meta?.env?.VITE_GOOGLE_PLACES_PROXY);

    this.timeoutMs = Number.isFinite(opts.timeoutMs)
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;

    this.key = opts.apiKey || resolveKey();

    // If running direct mode without key, searches will throw.
  }

  /* ------------------------------ Search helpers ------------------------------ */

  /**
   * Text search (e.g. "grocery store", "Walmart Supercenter", "Kroger near me")
   * You can provide (lat/lon + radius) to bias results.
   */
  async textSearch({
    query,
    lat = null,
    lon = null,
    radius = 5000,
    language = "en",
    region = "us",
    openNow = false,
    type = null, // optionally "supermarket"
    signal,
  }) {
    const q = String(query || "").trim();
    if (!q) return [];

    const r = clamp(radius, 100, 50000);

    const loc = normalizeLatLon(lat, lon);

    if (this.useProxy) {
      const url = buildApiUrl(`${this.apiBase}/locals/text-search`, {
        query: q,
        lat: loc?.lat ?? "",
        lon: loc?.lon ?? "",
        radius: r,
        language,
        region,
        openNow: openNow ? "1" : "0",
        type: type || "",
      });
      const json = await fetchJson(url, { signal, timeoutMs: this.timeoutMs });
      return normalizePlacesList(json);
    }

    // Direct mode (may be blocked by CORS depending on environment).
    this._requireKey();

    // Google Places Text Search (legacy endpoint format)
    // Note: New Places API exists; this keeps compatibility + simple backend proxy.
    const params = {
      query: q,
      key: this.key,
      language,
      region,
    };

    if (loc) params.location = `${loc.lat},${loc.lon}`;
    if (loc && r) params.radius = String(r);
    if (openNow) params.opennow = "true";
    if (type) params.type = type;

    const url = buildApiUrl(
      "https://maps.googleapis.com/maps/api/place/textsearch/json",
      params
    );
    const json = await fetchJson(url, { signal, timeoutMs: this.timeoutMs });
    return normalizePlacesList(json);
  }

  /**
   * Nearby search for categories/keywords:
   * - keyword: "grocery" / "supermarket" / "farmers market" / etc
   * - type can be used (supermarket) but keyword is usually better.
   */
  async nearbySearch({
    lat,
    lon,
    radius = 5000,
    keyword = "grocery store",
    language = "en",
    openNow = false,
    type = null,
    signal,
  }) {
    const loc = normalizeLatLon(lat, lon);
    if (!loc) throw new Error("nearbySearch requires lat/lon");

    const r = clamp(radius, 100, 50000);
    const kw = String(keyword || "").trim();

    if (this.useProxy) {
      const url = buildApiUrl(`${this.apiBase}/locals/nearby-search`, {
        lat: loc.lat,
        lon: loc.lon,
        radius: r,
        keyword: kw,
        language,
        openNow: openNow ? "1" : "0",
        type: type || "",
      });
      const json = await fetchJson(url, { signal, timeoutMs: this.timeoutMs });
      return normalizePlacesList(json);
    }

    this._requireKey();

    const params = {
      key: this.key,
      location: `${loc.lat},${loc.lon}`,
      radius: String(r),
      language,
    };
    if (kw) params.keyword = kw;
    if (openNow) params.opennow = "true";
    if (type) params.type = type;

    const url = buildApiUrl(
      "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
      params
    );
    const json = await fetchJson(url, { signal, timeoutMs: this.timeoutMs });
    return normalizePlacesList(json);
  }

  /**
   * Place Details
   * fields: array or comma string. If omitted, defaults to a strong "store profile" set.
   */
  async placeDetails({
    placeId,
    fields = null,
    language = "en",
    region = "us",
    signal,
  }) {
    const pid = String(placeId || "").trim();
    if (!pid) throw new Error("placeDetails requires placeId");

    const defaultFields = [
      "place_id",
      "name",
      "formatted_address",
      "geometry",
      "types",
      "opening_hours",
      "business_status",
      "formatted_phone_number",
      "international_phone_number",
      "website",
      "url",
      "rating",
      "user_ratings_total",
      "price_level",
      "utc_offset_minutes",
    ];

    const fieldsStr = Array.isArray(fields)
      ? fields.join(",")
      : typeof fields === "string" && fields.trim()
      ? fields.trim()
      : defaultFields.join(",");

    if (this.useProxy) {
      const url = buildApiUrl(`${this.apiBase}/locals/place-details`, {
        placeId: pid,
        fields: fieldsStr,
        language,
        region,
      });
      const json = await fetchJson(url, { signal, timeoutMs: this.timeoutMs });
      return normalizePlaceDetails(json);
    }

    this._requireKey();

    const url = buildApiUrl(
      "https://maps.googleapis.com/maps/api/place/details/json",
      {
        place_id: pid,
        fields: fieldsStr,
        language,
        region,
        key: this.key,
      }
    );

    const json = await fetchJson(url, { signal, timeoutMs: this.timeoutMs });
    return normalizePlaceDetails(json);
  }

  _requireKey() {
    if (!this.key) {
      throw new Error(
        "GoogleLocalsClient: Missing API key. Set VITE_GOOGLE_PLACES_API_KEY (or VITE_GOOGLE_MAPS_API_KEY) or enable proxy mode."
      );
    }
  }
}

/* ------------------------------ Normalizers ------------------------------ */

function normalizePlacesList(json) {
  // Proxy might return already-normalized { results: [...] }
  const results = Array.isArray(json?.results) ? json.results : [];
  return results.map(normalizePlaceResult).filter(Boolean);
}

function normalizePlaceResult(p) {
  if (!p) return null;
  const placeId = p.place_id || p.placeId || p.id;
  const name = p.name || p.displayName?.text || "Store";
  const types = Array.isArray(p.types) ? p.types : [];
  const addr =
    p.formatted_address ||
    p.formattedAddress ||
    p.vicinity ||
    p.address ||
    null;

  const lat =
    typeof p?.geometry?.location?.lat === "function"
      ? p.geometry.location.lat()
      : p?.geometry?.location?.lat ?? p?.lat ?? null;

  const lon =
    typeof p?.geometry?.location?.lng === "function"
      ? p.geometry.location.lng()
      : p?.geometry?.location?.lng ?? p?.lon ?? null;

  return {
    placeId: placeId ? String(placeId) : null,
    name: String(name),
    address: addr ? String(addr) : null,
    lat: toNum(lat),
    lon: toNum(lon),
    types: types.map(String),
    businessStatus: p.business_status || p.businessStatus || null,
    rating: toNum(p.rating),
    userRatingsTotal: toNum(p.user_ratings_total || p.userRatingsTotal),
    raw: p,
  };
}

function normalizePlaceDetails(json) {
  const result = json?.result || json?.place || json?.data || null;
  if (!result) return null;
  const base = normalizePlaceResult(result);

  const opening = result.opening_hours || result.openingHours || null;

  return {
    ...base,
    phone: result.formatted_phone_number || result.formattedPhoneNumber || null,
    intlPhone:
      result.international_phone_number ||
      result.internationalPhoneNumber ||
      null,
    website: result.website || null,
    googleUrl: result.url || null,
    priceLevel: toNum(result.price_level || result.priceLevel),
    utcOffsetMinutes: toNum(
      result.utc_offset_minutes || result.utcOffsetMinutes
    ),
    openingHours: opening
      ? {
          openNow:
            typeof opening.open_now === "boolean"
              ? opening.open_now
              : opening.openNow,
          weekdayText: Array.isArray(opening.weekday_text)
            ? opening.weekday_text
            : Array.isArray(opening.weekdayText)
            ? opening.weekdayText
            : [],
          periods: Array.isArray(opening.periods) ? opening.periods : [],
        }
      : null,
    types: Array.isArray(result.types) ? result.types.map(String) : base.types,
    raw: result,
  };
}
