/**
 * SSA Fixed-Layer Resolvers — shared helpers (internal).
 * Deterministic: same input => same output.
 * No heavy runtime deps; safe for browser + node test runners.
 */

export function stableHash(str) {
  // Deterministic, non-crypto. Used only for tie-breaking when needed.
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function normalizeText(s) {
  return String(s || "").trim().toLowerCase();
}

export function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const k = typeof v === "string" ? v : JSON.stringify(v);
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

export function addReason(reasons, id, reason) {
  if (!reasons[id]) reasons[id] = [];
  reasons[id].push(reason);
}

export function sortRanked(items) {
  // Deterministic: score desc, then id asc
  return [...items].sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    const ai = String(a.id || "");
    const bi = String(b.id || "");
    return ai.localeCompare(bi);
  });
}

export function clamp(n, min, max) {
  const x = Number.isFinite(n) ? n : 0;
  return Math.max(min, Math.min(max, x));
}

export function hasAnyTag(tags, wanted) {
  const set = new Set(tags || []);
  for (const w of wanted || []) if (set.has(w)) return true;
  return false;
}

export function pickTop(items, n = 5) {
  return sortRanked(items).slice(0, n);
}

export function safeArray(v) {
  return Array.isArray(v) ? v : (v == null ? [] : [v]);
}
