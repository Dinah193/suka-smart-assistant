// File: src/utils/rand.js
/**
 * rand.js (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Deterministic + non-deterministic random helpers for SSA.
 *  - Supports seeded RNG for "fixed-but-feels-random" planning (meal rotations,
 *    task shuffles, method selection, etc.).
 *  - Browser-safe; uses crypto when available, with safe fallbacks.
 *
 * Design goals
 *  - Provide a small, predictable API:
 *      • randomInt(min,max)
 *      • randomFloat(min,max)
 *      • chance(p)
 *      • pick(list)
 *      • pickN(list,n,{unique})
 *      • shuffle(list)
 *      • weightedPick(items, weightFn)
 *      • uuid()
 *      • createRng(seed)  -> { int, float, chance, pick, shuffle, ... }
 *      • seedFrom(...)
 *  - Never throw on bad inputs; degrade gracefully.
 */

/* ---------------------------------- Crypto --------------------------------- */

function hasCrypto() {
  return (
    typeof globalThis !== "undefined" &&
    !!globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === "function"
  );
}

function cryptoUint32() {
  if (!hasCrypto()) return null;
  try {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0] >>> 0;
  } catch {
    return null;
  }
}

function mathUint32() {
  // not cryptographically secure
  return ((Math.random() * 0x100000000) >>> 0) >>> 0;
}

function anyUint32() {
  return cryptoUint32() ?? mathUint32();
}

/* ------------------------------ Hash / Seeding ------------------------------ */

/**
 * FNV-1a 32-bit hash (fast, stable).
 */
export function fnv1a32(input) {
  const str = String(input ?? "");
  let h = 0x811c9dc5; // offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (with overflow)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Build a 32-bit seed from mixed inputs.
 * - Great for "fixed-but-random" rhythms (e.g., householdId + dateKey + mode)
 */
export function seedFrom(...parts) {
  const joined = parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .map((p) => {
      if (p == null) return "";
      if (typeof p === "object") {
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      }
      return String(p);
    })
    .join("|");
  return fnv1a32(joined);
}

/**
 * clamp01 (SSA)
 * -----------------------------------------------------------------------------
 * Compatibility export:
 * Some recommenders import clamp01 from "@/utils/rand".
 */
export function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * hashStringToSeed (SSA)
 * -----------------------------------------------------------------------------
 * Compatibility export:
 * Some meal planning recommenders import:
 *   import { stableRand01, hashStringToSeed } from "@/utils/rand";
 *
 * We standardize "string -> 32-bit seed" using fnv1a32.
 */
export function hashStringToSeed(str) {
  return fnv1a32(String(str ?? ""));
}

/* --------------------------- Deterministic RNG Core -------------------------- */

/**
 * mulberry32 - simple fast PRNG with decent distribution for UI use.
 * Returns float in [0,1).
 */
function mulberry32(seed) {
  let a = seed >>> 0 || 0x9e3779b9;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * xmur3 - string seed -> 32-bit number generator (used sometimes).
 * Kept for completeness; we still expose seedFrom() primarily.
 */
export function xmur3(str) {
  let h = 1779033703 ^ String(str ?? "").length;
  for (let i = 0; i < String(str ?? "").length; i++) {
    h = Math.imul(h ^ String(str ?? "").charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/* ---------------------------------- Core API -------------------------------- */

export function clampInt(n, min, max) {
  const x = Number(n);
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(x)) return Number.isFinite(lo) ? lo : 0;
  const a = Number.isFinite(lo) ? lo : 0;
  const b = Number.isFinite(hi) ? hi : a;
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return Math.min(high, Math.max(low, Math.trunc(x)));
}

export function clampFloat(n, min, max) {
  const x = Number(n);
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(x)) return Number.isFinite(lo) ? lo : 0;
  const a = Number.isFinite(lo) ? lo : 0;
  const b = Number.isFinite(hi) ? hi : a;
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return Math.min(high, Math.max(low, x));
}

/**
 * Unseeded random float in [min,max).
 */
export function randomFloat(min = 0, max = 1) {
  const lo = Number(min);
  const hi = Number(max);
  const a = Number.isFinite(lo) ? lo : 0;
  const b = Number.isFinite(hi) ? hi : 1;
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  const r = anyUint32() / 4294967296 || 0; // [0,1)
  return low + r * (high - low);
}

/**
 * Unseeded random int in [min,max] (inclusive).
 */
export function randomInt(min = 0, max = 1) {
  const lo = clampInt(min, -2147483648, 2147483647);
  const hi = clampInt(max, -2147483648, 2147483647);
  const low = Math.min(lo, hi);
  const high = Math.max(lo, hi);
  const range = high - low + 1;
  if (range <= 1) return low;

  // Rejection sampling to avoid modulo bias
  const maxUint = 0xffffffff;
  const limit = maxUint - (maxUint % range);
  let x;
  do {
    x = anyUint32();
  } while (x >= limit);

  return low + (x % range);
}

export function chance(p = 0.5) {
  const prob = clampFloat(p, 0, 1);
  return randomFloat(0, 1) < prob;
}

export function pick(list, fallback = null) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return fallback;
  return arr[randomInt(0, arr.length - 1)];
}

export function pickN(list, n = 1, { unique = true } = {}) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  if (!count || !arr.length) return [];

  if (!unique) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(pick(arr));
    return out;
  }

  // unique: partial shuffle
  const out = [];
  const m = Math.min(count, arr.length);
  for (let i = 0; i < m; i++) {
    const j = randomInt(i, arr.length - 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
    out.push(arr[i]);
  }
  return out;
}

export function shuffle(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Weighted pick.
 * - items: array
 * - weightFn: (item, index) => number
 * Returns { item, index, weight, total } or null.
 */
export function weightedPick(items, weightFn, fallback = null) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return fallback;

  const fn = typeof weightFn === "function" ? weightFn : (x) => x?.weight;
  const weights = new Array(arr.length);
  let total = 0;

  for (let i = 0; i < arr.length; i++) {
    const w = Number(fn(arr[i], i));
    const ww = Number.isFinite(w) && w > 0 ? w : 0;
    weights[i] = ww;
    total += ww;
  }

  if (total <= 0) {
    const index = randomInt(0, arr.length - 1);
    return { item: arr[index], index, weight: 0, total: 0 };
  }

  const r = randomFloat(0, total);
  let acc = 0;
  for (let i = 0; i < arr.length; i++) {
    acc += weights[i];
    if (r < acc) {
      return { item: arr[i], index: i, weight: weights[i], total };
    }
  }

  // Fallback (floating rounding)
  const last = arr.length - 1;
  return { item: arr[last], index: last, weight: weights[last], total };
}

/* ----------------------------------- UUID ---------------------------------- */

/**
 * uuid v4 (best-effort).
 * - Uses crypto.randomUUID if available.
 * - Falls back to getRandomValues-based v4.
 * - Final fallback uses Math.random (non-secure).
 */
export function uuid() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // ignore
  }

  // v4 template
  const bytes = new Uint8Array(16);
  if (hasCrypto()) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = randomInt(0, 255);
  }

  // Set version and variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    ""
  );
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

/* ------------------------------ Seeded RNG API ------------------------------ */

/**
 * Create a deterministic RNG with a seed.
 * Example:
 *  const rng = createRng(seedFrom(householdId, localDateKey, "dinner"));
 *  rng.pick(meals)
 */
export function createRng(seed) {
  const s = Number.isFinite(Number(seed))
    ? Number(seed) >>> 0
    : seedFrom(String(seed ?? ""));
  const nextFloat01 = mulberry32(s);

  const float = (min = 0, max = 1) => {
    const lo = Number(min);
    const hi = Number(max);
    const a = Number.isFinite(lo) ? lo : 0;
    const b = Number.isFinite(hi) ? hi : 1;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const r = nextFloat01();
    return low + r * (high - low);
  };

  const int = (min = 0, max = 1) => {
    const lo = clampInt(min, -2147483648, 2147483647);
    const hi = clampInt(max, -2147483648, 2147483647);
    const low = Math.min(lo, hi);
    const high = Math.max(lo, hi);
    const range = high - low + 1;
    if (range <= 1) return low;

    // rejection sampling via float source
    // (mulberry32 provides 32-bit-ish randomness; bias is negligible for UI)
    const r = nextFloat01();
    const x = Math.floor(r * range);
    return low + Math.min(range - 1, Math.max(0, x));
  };

  const ch = (p = 0.5) => float(0, 1) < clampFloat(p, 0, 1);

  const pk = (list, fallback = null) => {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return fallback;
    return arr[int(0, arr.length - 1)];
  };

  const pkN = (list, n = 1, { unique = true } = {}) => {
    const arr = Array.isArray(list) ? list.slice() : [];
    const count = Math.max(0, Math.trunc(Number(n) || 0));
    if (!count || !arr.length) return [];

    if (!unique) {
      const out = [];
      for (let i = 0; i < count; i++) out.push(pk(arr));
      return out;
    }

    const out = [];
    const m = Math.min(count, arr.length);
    for (let i = 0; i < m; i++) {
      const j = int(i, arr.length - 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
      out.push(arr[i]);
    }
    return out;
  };

  const shuf = (list) => {
    const arr = Array.isArray(list) ? list.slice() : [];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = int(0, i);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  };

  const wPick = (items, weightFn, fallback = null) => {
    const arr = Array.isArray(items) ? items : [];
    if (!arr.length) return fallback;

    const fn = typeof weightFn === "function" ? weightFn : (x) => x?.weight;
    const weights = new Array(arr.length);
    let total = 0;

    for (let i = 0; i < arr.length; i++) {
      const w = Number(fn(arr[i], i));
      const ww = Number.isFinite(w) && w > 0 ? w : 0;
      weights[i] = ww;
      total += ww;
    }

    if (total <= 0) {
      const index = int(0, arr.length - 1);
      return { item: arr[index], index, weight: 0, total: 0 };
    }

    const r = float(0, total);
    let acc = 0;
    for (let i = 0; i < arr.length; i++) {
      acc += weights[i];
      if (r < acc) return { item: arr[i], index: i, weight: weights[i], total };
    }

    const last = arr.length - 1;
    return { item: arr[last], index: last, weight: weights[last], total };
  };

  return {
    seed: s >>> 0,
    float,
    int,
    chance: ch,
    pick: pk,
    pickN: pkN,
    shuffle: shuf,
    weightedPick: wPick,
  };
}

/**
 * stableRand01 (SSA)
 * -----------------------------------------------------------------------------
 * Compatibility export:
 * Deterministic float in [0,1) for a given input (string/number/object).
 * - Used for "fixed-but-feels-random" weighting (e.g., cuisine weights).
 *
 * NOTE: For objects, we fall back to JSON stringify (best-effort).
 */
export function stableRand01(input) {
  if (typeof input === "number" && Number.isFinite(input)) {
    return createRng(input >>> 0).float(0, 1);
  }
  if (typeof input === "string") {
    return createRng(hashStringToSeed(input)).float(0, 1);
  }
  if (input == null) {
    return createRng(0).float(0, 1);
  }
  if (typeof input === "object") {
    try {
      return createRng(hashStringToSeed(JSON.stringify(input))).float(0, 1);
    } catch {
      return createRng(hashStringToSeed(String(input))).float(0, 1);
    }
  }
  return createRng(hashStringToSeed(String(input))).float(0, 1);
}

/* ------------------------------ Compatibility ------------------------------- */

/**
 * ✅ seededShuffle (SSA)
 * -----------------------------------------------------------------------------
 * Compatibility export expected by mealPlanEngine.js:
 *   import { seededShuffle } from "@/utils/rand";
 *
 * Deterministically shuffles a list using a provided seed (string/number/object).
 * - Returns a NEW array (does not mutate input).
 * - Browser-safe, no Node imports.
 */
export function seededShuffle(list, seed) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (arr.length <= 1) return arr;

  const s =
    typeof seed === "number" && Number.isFinite(seed)
      ? seed >>> 0
      : seedFrom(seed);

  const rng = createRng(s);

  // Fisher–Yates using seeded int()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/* ------------------------------ Misc / Helpers ------------------------------ */

/**
 * Returns a "random-ish" seed suitable for one-off RNG instances.
 */
export function randomSeed() {
  return anyUint32();
}

/**
 * Random string (non-secure unless crypto exists).
 */
export function randomString(
  len = 12,
  alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
) {
  const n = Math.max(0, Math.trunc(Number(len) || 0));
  const chars = String(alphabet || "");
  if (!n || !chars.length) return "";
  let out = "";
  for (let i = 0; i < n; i++) {
    out += chars[randomInt(0, chars.length - 1)];
  }
  return out;
}
