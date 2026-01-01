// src/config.js

/**
 * Canonical app configuration
 * -----------------------------------------------------------------------------
 * - In dev: use Vite proxy → "/api"
 * - In prod: use VITE_API_BASE_URL if defined
 *
 * Added:
 * - Google keys (Places/Maps) for Locals
 * - Sponsored/Ads flags (for shopping mode, pantry mode, receipt mode)
 * -----------------------------------------------------------------------------
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

/**
 * Google Locals / Places
 * Prefer using proxy mode to avoid exposing keys in the browser:
 *   VITE_GOOGLE_PLACES_PROXY=1
 *
 * Keys:
 * - VITE_GOOGLE_PLACES_API_KEY (preferred)
 * - VITE_GOOGLE_MAPS_API_KEY (fallback)
 */
const GOOGLE_PLACES_API_KEY = import.meta.env.VITE_GOOGLE_PLACES_API_KEY || "";
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";

/**
 * Ads / Sponsored modes
 * - VITE_ADS_MODE: "off" | "demo" | "live"
 * - VITE_SPONSORED_ENABLED: "1"/"true" toggles sponsored surfaces
 */
const ADS_MODE = import.meta.env.VITE_ADS_MODE || "off";

const SPONSORED_ENABLED = (() => {
  const v = String(import.meta.env.VITE_SPONSORED_ENABLED ?? "")
    .toLowerCase()
    .trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
})();

/**
 * Proxy mode for Google Places
 * (recommended) to avoid CORS + key exposure
 */
const GOOGLE_PLACES_PROXY = (() => {
  const v = String(import.meta.env.VITE_GOOGLE_PLACES_PROXY ?? "")
    .toLowerCase()
    .trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
})();

export {
  API_BASE_URL,
  GOOGLE_PLACES_API_KEY,
  GOOGLE_MAPS_API_KEY,
  GOOGLE_PLACES_PROXY,
  ADS_MODE,
  SPONSORED_ENABLED,
};
