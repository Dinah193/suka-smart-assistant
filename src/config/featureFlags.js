// C:\Users\larho\suka-smart-assistant\src\config\featureFlags.js
// -----------------------------------------------------------------------------
// PURPOSE
// -----------------------------------------------------------------------------
// JS facade over featureFlags.json so callers NEVER named-import from JSON.
//
// ✅ Vite-safe (JSON default import)
// ✅ Exposes helpers used by agents:
//    - snapshotFlags()
//    - getAllFeatureFlags()
//    - getFeatureFlags(pathOrPaths)
//    - familyFundMode (boolean derived)
//
// ✅ COMPAT NOTE (Build fix)
// -----------------------------------------------------------------------------
// Some older/domain engines import:
//   import { featureFlags } from "../../config/featureFlags";
//
// This file previously did not export a named `featureFlags` symbol.
// We add it as a resolved snapshot of the flags tree.
// -----------------------------------------------------------------------------

import raw from "./featureFlags.json";

/**
 * Deep-get by "a.b.c" path.
 * @param {any} obj
 * @param {string} path
 * @param {any} [fallback]
 */
function getPath(obj, path, fallback) {
  if (!path) return fallback;
  const parts = String(path).split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object" || !(p in cur)) return fallback;
    cur = cur[p];
  }
  return cur;
}

/**
 * Shallow-ish deep merge for small objects (no special array logic).
 * @param {any} base
 * @param {any} patch
 */
function merge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? base.slice() : { ...(base || {}) };
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const bv = out[k];
    if (
      pv &&
      typeof pv === "object" &&
      !Array.isArray(pv) &&
      bv &&
      typeof bv === "object" &&
      !Array.isArray(bv)
    ) {
      out[k] = merge(bv, pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

/**
 * Resolve environment overlays if present.
 * @param {any} root
 */
function resolveEnv(root) {
  const env =
    (typeof import.meta !== "undefined" &&
      import.meta.env &&
      import.meta.env.MODE) ||
    "production";
  const envBlock = root?.environments?.[env];
  if (!envBlock) return root;
  // Merge env overrides onto defaults (do NOT mutate root)
  const out = { ...root };
  out.defaults = merge(out.defaults || {}, envBlock || {});
  return out;
}

/**
 * Return the fully resolved flags tree (defaults + env overrides).
 * Note: rule evaluation is intentionally NOT performed here unless you later
 * supply a context evaluator. This keeps the facade pure/simple.
 */
export function getAllFeatureFlags() {
  return resolveEnv(raw);
}

/**
 * Get a path or paths from the resolved tree.
 * @param {string|string[]} pathOrPaths
 * @param {any} [fallback]
 */
export function getFeatureFlags(pathOrPaths, fallback = undefined) {
  const root = getAllFeatureFlags();
  if (Array.isArray(pathOrPaths)) {
    const out = {};
    for (const p of pathOrPaths) out[p] = getPath(root, p, fallback);
    return out;
  }
  return getPath(root, pathOrPaths, fallback);
}

/**
 * Snapshot that agent shims can serialize into memo/cache.
 * @param {Object} [opts]
 * @param {string[]} [opts.paths]   Optional list of paths to include.
 * @returns {Object}
 */
export function snapshotFlags(opts = {}) {
  const root = getAllFeatureFlags();
  const paths = Array.isArray(opts.paths) ? opts.paths : null;
  if (!paths) {
    // Default compact snapshot
    return {
      version: root?.version || null,
      updatedAt: root?.updatedAt || null,
      defaults: root?.defaults || {},
    };
  }
  const picked = {};
  for (const p of paths) picked[p] = getPath(root, p, null);
  return {
    version: root?.version || null,
    updatedAt: root?.updatedAt || null,
    picked,
  };
}

/**
 * Convenience boolean used by shims.
 * (Matches your JSON: defaults.familyFundMode + defaults.toggles.familyFundMode)
 */
export const familyFundMode = !!(
  raw?.defaults?.familyFundMode || raw?.defaults?.toggles?.familyFundMode
);

/**
 * Named flag exports (referenced by agents/shims).
 *
 * Notes
 * - These are resolved from the current flag source (defaults + env overlays).
 * - We export booleans (not functions) because callers compare strict equality.
 */
export const allowLLM = !!(
  raw?.defaults?.allowLLM || raw?.defaults?.toggles?.allowLLM
);
export const debugAgents = !!(
  raw?.defaults?.debugAgents || raw?.defaults?.toggles?.debugAgents
);
export const isFamilyFundMode = familyFundMode;

/**
 * ✅ COMPAT EXPORT: featureFlags
 *
 * Some engines import `{ featureFlags }` and expect an object.
 * We expose a resolved snapshot of the full tree.
 *
 * IMPORTANT:
 * - This is a *value*, not a function.
 * - If you need up-to-the-moment values after env changes at runtime,
 *   prefer `getAllFeatureFlags()` instead.
 */
export const featureFlags = getAllFeatureFlags();

export default {
  featureFlags,
  familyFundMode,
  snapshotFlags,
  getAllFeatureFlags,
  getFeatureFlags,
};
