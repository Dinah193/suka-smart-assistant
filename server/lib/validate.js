// server/lib/validate.js
// -----------------------------------------------------------------------------
// Minimal query validation helpers.
// -----------------------------------------------------------------------------

export function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

export function str(x, fallback = "") {
  const s = String(x ?? "").trim();
  return s ? s : fallback;
}

export function boolish(x) {
  const s = String(x ?? "")
    .toLowerCase()
    .trim();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function latLonFromQuery(q) {
  const lat = toNum(q.lat);
  const lon = toNum(q.lon);
  if (lat == null || lon == null) return null;
  // basic sanity
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  return { lat, lon };
}

export function normalizeFields(fieldsStr, allowList) {
  const raw = String(fieldsStr ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // allow-list enforced
  const cleaned = raw.filter((f) => allowList.has(f));
  return cleaned.length ? cleaned : null;
}
