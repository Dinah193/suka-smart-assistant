// src/reasoner/cache/memo.js
// Tiny in-memory memo cache for the current runtime.
// If you later want Dexie persistence, do it elsewhere.

const MEMO = new Map();

export function getMemo(key) {
  if (!key) return null;
  return MEMO.get(String(key)) ?? null;
}

export function setMemo(key, value) {
  if (!key) return;
  MEMO.set(String(key), value);
}

export function clearMemo() {
  MEMO.clear();
}

/**
 * Back-compat aliases used by agent shims.
 * mealPlanningShim (and others) expect these names.
 */
export function getCachedResponse(key) {
  return getMemo(key);
}

export function setCachedResponse(key, value) {
  setMemo(key, value);
}

/**
 * Additional back-compat aliases expected by newer shims:
 *   import { getCached, setCached } from "@/reasoner/cache/memo";
 */
export function getCached(key) {
  return getMemo(key);
}

export function setCached(key, value) {
  setMemo(key, value);
}

export default {
  getMemo,
  setMemo,
  clearMemo,
  getCachedResponse,
  setCachedResponse,
  getCached,
  setCached,
};
