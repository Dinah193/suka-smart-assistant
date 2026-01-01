// server/routes/locals.js
// -----------------------------------------------------------------------------
// /api/locals/* proxy routes
// -----------------------------------------------------------------------------

import express from "express";
import TTLCache from "../lib/cache.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  str,
  boolish,
  clamp,
  latLonFromQuery,
  normalizeFields,
} from "../lib/validate.js";

import {
  placesTextSearch,
  placesNearbySearch,
  placesDetails,
} from "../lib/googlePlaces.js";

const router = express.Router();

const cacheTtl = Number(process.env.LOCALS_CACHE_TTL_MS || 300000);
const cache = new TTLCache({ ttlMs: cacheTtl });

const windowMs = Number(process.env.LOCALS_RATE_LIMIT_WINDOW_MS || 60000);
const max = Number(process.env.LOCALS_RATE_LIMIT_MAX || 60);

router.use(rateLimit({ windowMs, max }));

// Allow-list for details fields (prevents “request anything” abuse)
const DETAILS_FIELDS_ALLOW = new Set([
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
]);

function cacheKey(req) {
  // stable cache key (path + sorted query)
  const q = new URLSearchParams(req.query);
  const pairs = Array.from(q.entries()).sort(([a], [b]) => a.localeCompare(b));
  const sorted = new URLSearchParams(pairs).toString();
  return `${req.path}?${sorted}`;
}

function normalizePlacesResponse(json, source = "google") {
  return {
    status: json?.status || "OK",
    source,
    results: Array.isArray(json?.results) ? json.results : [],
    next_page_token: json?.next_page_token || null,
    error_message: json?.error_message || null,
  };
}

function normalizeDetailsResponse(json, source = "google") {
  return {
    status: json?.status || "OK",
    source,
    result: json?.result || null,
    error_message: json?.error_message || null,
  };
}

/**
 * GET /api/locals/text-search
 * Query params:
 *  - query (required)
 *  - lat, lon (optional)
 *  - radius (optional, default 5000)
 *  - language (default en)
 *  - region (default us)
 *  - openNow (0/1)
 *  - type (optional)
 */
router.get("/text-search", async (req, res, next) => {
  try {
    const query = str(req.query.query);
    if (!query) {
      res
        .status(400)
        .json({ status: "ERROR", error: { message: "Missing query" } });
      return;
    }

    const loc = latLonFromQuery(req.query);
    const radius = clamp(req.query.radius ?? 5000, 100, 50000);

    const language = str(req.query.language, "en");
    const region = str(req.query.region, "us");
    const openNow = boolish(req.query.openNow);
    const type = str(req.query.type, "");

    const key = cacheKey(req);
    const cached = cache.get(key);
    if (cached) {
      res.json(normalizePlacesResponse(cached, "cache"));
      return;
    }

    const json = await placesTextSearch({
      query,
      lat: loc?.lat ?? null,
      lon: loc?.lon ?? null,
      radius,
      language,
      region,
      openNow,
      type: type || null,
    });

    cache.set(key, json);

    res.json(normalizePlacesResponse(json, "google"));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/locals/nearby-search
 * Query params:
 *  - lat, lon (required)
 *  - radius (optional, default 5000)
 *  - keyword (optional, default "grocery store")
 *  - language (default en)
 *  - openNow (0/1)
 *  - type (optional)
 */
router.get("/nearby-search", async (req, res, next) => {
  try {
    const loc = latLonFromQuery(req.query);
    if (!loc) {
      res.status(400).json({
        status: "ERROR",
        error: { message: "Missing/invalid lat/lon" },
      });
      return;
    }

    const radius = clamp(req.query.radius ?? 5000, 100, 50000);
    const keyword = str(req.query.keyword, "grocery store");
    const language = str(req.query.language, "en");
    const openNow = boolish(req.query.openNow);
    const type = str(req.query.type, "");

    const key = cacheKey(req);
    const cached = cache.get(key);
    if (cached) {
      res.json(normalizePlacesResponse(cached, "cache"));
      return;
    }

    const json = await placesNearbySearch({
      lat: loc.lat,
      lon: loc.lon,
      radius,
      keyword,
      language,
      openNow,
      type: type || null,
    });

    cache.set(key, json);

    res.json(normalizePlacesResponse(json, "google"));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/locals/place-details
 * Query params:
 *  - placeId (required)
 *  - fields (optional, comma-separated; allow-list enforced)
 *  - language (default en)
 *  - region (default us)
 */
router.get("/place-details", async (req, res, next) => {
  try {
    const placeId = str(req.query.placeId);
    if (!placeId) {
      res
        .status(400)
        .json({ status: "ERROR", error: { message: "Missing placeId" } });
      return;
    }

    const language = str(req.query.language, "en");
    const region = str(req.query.region, "us");

    // enforce allow-list; if empty/invalid -> defaults
    const requestedFields = normalizeFields(
      req.query.fields,
      DETAILS_FIELDS_ALLOW
    );
    const fields =
      requestedFields?.join(",") ||
      [
        "place_id",
        "name",
        "formatted_address",
        "geometry",
        "types",
        "opening_hours",
        "business_status",
        "formatted_phone_number",
        "website",
        "url",
        "rating",
        "user_ratings_total",
      ].join(",");

    const key = cacheKey(req);
    const cached = cache.get(key);
    if (cached) {
      res.json(normalizeDetailsResponse(cached, "cache"));
      return;
    }

    const json = await placesDetails({
      placeId,
      fields,
      language,
      region,
    });

    cache.set(key, json);

    res.json(normalizeDetailsResponse(json, "google"));
  } catch (e) {
    next(e);
  }
});

export default router;
