// File: src/utils/obj.js
/**
 * obj.js (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Hardened object/array utilities used across SSA.
 *  - Browser-safe, dependency-free, tree-shake friendly.
 *
 * Design goals
 *  - Never throw on "weird" inputs (null, undefined, functions, Dates, etc.).
 *  - No prototype pollution vectors in merge/set operations.
 *  - Useful for stores, services, and fixed-layer resolvers.
 */

/* ---------------------------------- Guards --------------------------------- */

export function isNil(v) {
  return v === null || v === undefined;
}

export function isDef(v) {
  return v !== null && v !== undefined;
}

export function isFn(v) {
  return typeof v === "function";
}

export function isStr(v) {
  return typeof v === "string";
}

export function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function isBool(v) {
  return typeof v === "boolean";
}

export function isArr(v) {
  return Array.isArray(v);
}

export function isDate(v) {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

export function isRegExp(v) {
  return v instanceof RegExp;
}

export function isPlainObject(v) {
  if (!v || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  if (v instanceof Date) return false;
  if (v instanceof RegExp) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function hasOwn(obj, key) {
  if (!obj || typeof obj !== "object") return false;
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Prevent prototype pollution in merge/set operations.
 */
export function isUnsafeKey(key) {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

/* --------------------------------- Basics ---------------------------------- */

export function shallowClone(v) {
  if (Array.isArray(v)) return v.slice();
  if (isPlainObject(v)) return { ...v };
  return v;
}

export function freezeDeep(v) {
  if (!v || typeof v !== "object") return v;
  if (Object.isFrozen(v)) return v;

  if (Array.isArray(v)) {
    for (const item of v) freezeDeep(item);
    Object.freeze(v);
    return v;
  }

  if (isPlainObject(v)) {
    for (const k of Object.keys(v)) {
      if (isUnsafeKey(k)) continue;
      freezeDeep(v[k]);
    }
    Object.freeze(v);
    return v;
  }

  // For non-plain objects, freeze only the object (best-effort)
  try {
    Object.freeze(v);
  } catch {
    // ignore
  }
  return v;
}

/* --------------------------------- Compare --------------------------------- */

export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b) return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!(aArr && bArr)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }

  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a).filter((k) => !isUnsafeKey(k));
  const bKeys = Object.keys(b).filter((k) => !isUnsafeKey(k));
  if (aKeys.length !== bKeys.length) return false;

  for (const k of aKeys) {
    if (!hasOwn(b, k)) return false;
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Deep equality for plain objects/arrays. Treats Dates as value-equal by time.
 * Does NOT attempt to compare class instances structurally.
 */
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  if (isRegExp(a) && isRegExp(b))
    return a.source === b.source && a.flags === b.flags;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!(aArr && bArr)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = isPlainObject(a);
  const bObj = isPlainObject(b);
  if (aObj || bObj) {
    if (!(aObj && bObj)) return false;
    const aKeys = Object.keys(a).filter((k) => !isUnsafeKey(k));
    const bKeys = Object.keys(b).filter((k) => !isUnsafeKey(k));
    if (aKeys.length !== bKeys.length) return false;

    for (const k of aKeys) {
      if (!hasOwn(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }

  return false;
}

/* ---------------------------------- Merge ---------------------------------- */

/**
 * Deep merge for plain objects.
 * - Arrays are replaced by default (not concatenated) for predictability.
 * - Dates/RegExp/non-plain objects are replaced.
 * - Skips unsafe keys to prevent prototype pollution.
 */
export function deepMerge(base, patch, opts = {}) {
  const {
    arrayMode = "replace", // replace | concat | unique
    skipUndefined = true,
  } = opts || {};

  if (!isPlainObject(base) || !isPlainObject(patch)) {
    // If patch is undefined and we're skipping, keep base.
    if (skipUndefined && patch === undefined) return base;
    return patch;
  }

  const out = { ...base };

  for (const key of Object.keys(patch)) {
    if (isUnsafeKey(key)) continue;

    const pv = patch[key];
    if (skipUndefined && pv === undefined) continue;

    const bv = out[key];

    if (Array.isArray(bv) && Array.isArray(pv)) {
      if (arrayMode === "concat") out[key] = bv.concat(pv);
      else if (arrayMode === "unique") out[key] = unique(bv.concat(pv));
      else out[key] = pv.slice();
      continue;
    }

    if (isPlainObject(bv) && isPlainObject(pv)) {
      out[key] = deepMerge(bv, pv, opts);
      continue;
    }

    // Replace for all other types
    out[key] = pv;
  }

  return out;
}

/* ------------------------------ Pick / Omit -------------------------------- */

export function pick(obj, keys) {
  const out = {};
  if (!isPlainObject(obj)) return out;
  const arr = Array.isArray(keys) ? keys : [];
  for (const k of arr) {
    const key = String(k);
    if (isUnsafeKey(key)) continue;
    if (hasOwn(obj, key)) out[key] = obj[key];
  }
  return out;
}

export function omit(obj, keys) {
  if (!isPlainObject(obj)) return {};
  const blacklist = new Set(
    (Array.isArray(keys) ? keys : []).map((k) => String(k))
  );
  const out = {};
  for (const k of Object.keys(obj)) {
    if (isUnsafeKey(k)) continue;
    if (blacklist.has(k)) continue;
    out[k] = obj[k];
  }
  return out;
}

/* ------------------------------- Paths (get/set) ---------------------------- */

export function toPath(path) {
  if (Array.isArray(path)) return path.map((p) => String(p)).filter(Boolean);
  if (typeof path === "string") {
    // supports "a.b.c" and "a[0].b"
    const parts = [];
    const re = /[^.[\]]+|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(path))) {
      parts.push(m[1] != null ? m[1] : m[0]);
    }
    return parts.map((p) => String(p)).filter(Boolean);
  }
  return [];
}

export function getIn(obj, path, fallback = undefined) {
  const parts = toPath(path);
  let cur = obj;
  for (const key of parts) {
    if (isUnsafeKey(key)) return fallback;
    if (cur == null) return fallback;
    cur = cur[key];
  }
  return cur === undefined ? fallback : cur;
}

/**
 * Immutable setIn.
 * - Creates intermediate objects/arrays as needed.
 * - Avoids unsafe keys.
 */
export function setIn(obj, path, value) {
  const parts = toPath(path);
  if (!parts.length) return value;

  const root = Array.isArray(obj)
    ? obj.slice()
    : isPlainObject(obj)
    ? { ...obj }
    : {};
  let cur = root;

  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (isUnsafeKey(key)) return root;

    const last = i === parts.length - 1;
    const nextKey = parts[i + 1];
    const wantsArray = nextKey != null && /^[0-9]+$/.test(String(nextKey));

    if (last) {
      cur[key] = value;
      break;
    }

    const existing = cur[key];

    let next;
    if (Array.isArray(existing)) next = existing.slice();
    else if (isPlainObject(existing)) next = { ...existing };
    else next = wantsArray ? [] : {};

    cur[key] = next;
    cur = next;
  }

  return root;
}

/**
 * Immutable updateIn: updater(prev) -> next
 */
export function updateIn(obj, path, updater, fallback = undefined) {
  const prev = getIn(obj, path, fallback);
  const next = isFn(updater) ? updater(prev) : updater;
  return setIn(obj, path, next);
}

/**
 * Immutable deleteIn. Returns original if path missing.
 */
export function deleteIn(obj, path) {
  const parts = toPath(path);
  if (!parts.length) return obj;
  if (obj == null || (typeof obj !== "object" && !Array.isArray(obj)))
    return obj;

  const root = Array.isArray(obj)
    ? obj.slice()
    : isPlainObject(obj)
    ? { ...obj }
    : {};
  let cur = root;

  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (isUnsafeKey(key)) return root;

    const last = i === parts.length - 1;

    if (last) {
      if (Array.isArray(cur)) {
        const idx = Number(key);
        if (Number.isFinite(idx) && idx >= 0 && idx < cur.length) {
          cur.splice(idx, 1);
        }
      } else if (isPlainObject(cur)) {
        if (hasOwn(cur, key)) delete cur[key];
      } else {
        // do nothing
      }
      break;
    }

    const existing = cur[key];
    if (
      existing == null ||
      (typeof existing !== "object" && !Array.isArray(existing))
    ) {
      return obj; // nothing to delete
    }

    const next = Array.isArray(existing)
      ? existing.slice()
      : isPlainObject(existing)
      ? { ...existing }
      : existing;
    cur[key] = next;
    cur = next;
  }

  return root;
}

/* ---------------------------------- Arrays --------------------------------- */

export function unique(arr) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    const key = typeof v === "string" ? v : JSON.stringify(v);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

export function compact(arr) {
  return (Array.isArray(arr) ? arr : []).filter((v) => v != null);
}

export function chunk(arr, size = 10) {
  const a = Array.isArray(arr) ? arr : [];
  const n = Math.max(1, Math.trunc(Number(size) || 10));
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/* ------------------------------ Object Helpers ------------------------------ */

export function keys(obj) {
  if (!isPlainObject(obj)) return [];
  return Object.keys(obj).filter((k) => !isUnsafeKey(k));
}

export function values(obj) {
  return keys(obj).map((k) => obj[k]);
}

export function entries(obj) {
  return keys(obj).map((k) => [k, obj[k]]);
}

export function mapValues(obj, fn) {
  if (!isPlainObject(obj) || !isFn(fn)) return {};
  const out = {};
  for (const k of keys(obj)) out[k] = fn(obj[k], k, obj);
  return out;
}

export function mapKeys(obj, fn) {
  if (!isPlainObject(obj) || !isFn(fn)) return {};
  const out = {};
  for (const k of keys(obj)) {
    const nk = String(fn(k, obj[k], obj));
    if (isUnsafeKey(nk)) continue;
    out[nk] = obj[k];
  }
  return out;
}

export function filterValues(obj, predicate) {
  if (!isPlainObject(obj) || !isFn(predicate)) return {};
  const out = {};
  for (const k of keys(obj)) {
    const v = obj[k];
    if (predicate(v, k, obj)) out[k] = v;
  }
  return out;
}

/**
 * Safe JSON stringify with circular reference handling.
 * - Useful for logs and snapshots.
 */
export function safeStringify(value, { space = 2, maxDepth = 50 } = {}) {
  const seen = new WeakSet();

  function replacer(key, val) {
    // depth control (approx)
    // Note: JSON.stringify doesn't provide depth; this is a best-effort guard.
    if (key && key.length > 10_000) return "[[TRUNCATED_KEY]]";

    if (val && typeof val === "object") {
      if (seen.has(val)) return "[[CIRCULAR]]";
      seen.add(val);

      // Prevent huge objects from causing performance issues
      // (basic limiter; callers should still be careful).
      if (maxDepth <= 0) return "[[MAX_DEPTH]]";
    }
    return val;
  }

  try {
    return JSON.stringify(value, replacer, space);
  } catch {
    try {
      return String(value);
    } catch {
      return "[[UNSTRINGIFIABLE]]";
    }
  }
}

/* ------------------------------ Normalization ------------------------------- */

export function toInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

export function toFloat(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

export function clampNum(v, min, max, fallback = min) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

export function ensurePlainObject(v, fallback = {}) {
  return isPlainObject(v) ? v : fallback;
}

/* ---------------------------------- Misc ----------------------------------- */

/**
 * Create a stable key for objects for dedupe sets/maps.
 * - Not cryptographic. Intended for UI lists and small dedupe tasks.
 */
export function stableKey(v) {
  if (v == null) return "nil";
  if (typeof v === "string") return `s:${v}`;
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "boolean") return `b:${v}`;
  if (isDate(v)) return `d:${v.toISOString()}`;
  if (Array.isArray(v)) return `a:[${v.map(stableKey).join(",")}]`;
  if (isPlainObject(v)) {
    const ks = keys(v).sort();
    return `o:{${ks.map((k) => `${k}:${stableKey(v[k])}`).join(",")}}`;
  }
  return `x:${String(v)}`;
}

/* -------------------------------------------------------------------------- */
/* ✅ Compatibility exports expected elsewhere                                 */
/* -------------------------------------------------------------------------- */

/**
 * deepClone
 * - Some SSA modules import { deepClone } from "@/utils/obj"
 * - Provide a safe, browser-friendly deep clone.
 * - Prefers structuredClone when available; falls back to JSON for plain data.
 */
export function deepClone(value) {
  // structuredClone exists in modern browsers + recent Node, but is safe here.
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    // ignore and fallback
  }

  // Best-effort: clone only plain JSON-safe data. If it fails, return original.
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/**
 * uid
 * - Some SSA modules import { uid } from "@/utils/obj"
 * - Provide a stable, browser-safe unique id generator (not cryptographic).
 */
export function uid(prefix = "id") {
  const p = String(prefix || "id");

  // Prefer crypto.randomUUID when available.
  try {
    const c = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (c && typeof c.randomUUID === "function") {
      return `${p}_${c.randomUUID()}`;
    }
  } catch {
    // ignore
  }

  // Fallback: time + counter + random
  const now = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  uid.__c = (uid.__c || 0) + 1;
  const ctr = uid.__c.toString(36);
  return `${p}_${now}_${ctr}_${rand}`;
}
