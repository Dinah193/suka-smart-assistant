// server/lib/googlePlaces.js
// -----------------------------------------------------------------------------
// Google Places REST caller (server-side).
// Uses legacy JSON endpoints for simplicity + compatibility.
// -----------------------------------------------------------------------------

import { clamp } from "./validate.js";

const BASE = "https://maps.googleapis.com/maps/api/place";

function resolveKey() {
  return (
    process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || ""
  );
}

function requireKey() {
  const key = resolveKey();
  if (!key) {
    const err = new Error(
      "Missing Google Places API key. Set GOOGLE_PLACES_API_KEY (or GOOGLE_MAPS_API_KEY)."
    );
    err.status = 500;
    throw err;
  }
  return key;
}

function buildUrl(path, params) {
  const u = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (!s) continue;
    u.searchParams.set(k, s);
  }
  return u.toString();
}

async function fetchJson(url, { timeoutMs = 12000, signal } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  const merged = mergeSignals(signal, ctrl.signal);

  try {
    const res = await fetch(url, { method: "GET", signal: merged });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(`Google request failed (${res.status})`);
      err.status = 502;
      err.data = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// Tiny signal merge
function mergeSignals(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.aborted || b.aborted) {
    const ctrl = new AbortController();
    ctrl.abort();
    return ctrl.signal;
  }
  const ctrl = new AbortController();
  const onAbort = () => {
    try {
      ctrl.abort();
    } catch {}
  };
  a.addEventListener?.("abort", onAbort, { once: true });
  b.addEventListener?.("abort", onAbort, { once: true });
  return ctrl.signal;
}

/* ------------------------------ Endpoints ------------------------------ */

export async function placesTextSearch({
  query,
  lat = null,
  lon = null,
  radius = 5000,
  language = "en",
  region = "us",
  openNow = false,
  type = null,
  signal,
}) {
  const key = requireKey();
  const r = clamp(radius, 100, 50000);

  const params = {
    query,
    language,
    region,
    key,
  };

  if (lat != null && lon != null) {
    params.location = `${lat},${lon}`;
    params.radius = String(r);
  }
  if (openNow) params.opennow = "true";
  if (type) params.type = type;

  const url = buildUrl("/textsearch/json", params);
  return fetchJson(url, { signal });
}

export async function placesNearbySearch({
  lat,
  lon,
  radius = 5000,
  keyword = "grocery store",
  language = "en",
  openNow = false,
  type = null,
  signal,
}) {
  const key = requireKey();
  const r = clamp(radius, 100, 50000);

  const params = {
    location: `${lat},${lon}`,
    radius: String(r),
    keyword,
    language,
    key,
  };
  if (openNow) params.opennow = "true";
  if (type) params.type = type;

  const url = buildUrl("/nearbysearch/json", params);
  return fetchJson(url, { signal });
}

export async function placesDetails({
  placeId,
  fields,
  language = "en",
  region = "us",
  signal,
}) {
  const key = requireKey();

  const params = {
    place_id: placeId,
    fields,
    language,
    region,
    key,
  };

  const url = buildUrl("/details/json", params);
  return fetchJson(url, { signal });
}
