/**
 * File: src/layers/resolvers/OverrideResolver.js
 * Purpose: Apply household overrides (preferences, bans, must-haves) to selected patterns.
 *
 * Supports:
 *  - hard blocks: blockPatternIds, blockTags, blockMethodKeys
 *  - must-haves: requireTagsAny / requireTagsAll
 *  - parameter overrides: perPatternParams
 *
 * Inputs:
 *  - selected: Array<{ id, score, reasons }>
 *  - overrides: {
 *      enabled?: boolean,
 *      blockPatternIds?: string[],
 *      blockTags?: string[],
 *      blockMethodKeys?: string[], // lexicon-level method keys; can be mapped to pattern IDs by caller if desired
 *      requireTagsAny?: string[],
 *      requireTagsAll?: string[],
 *      perPatternParams?: Record<string, object>,
 *      globalParams?: object
 *    }
 *  - patternMetaLookup?: (patternId) => { intentTags?: string[] } (optional)
 *
 * Output:
 *  - { selected: Array<{id, score, reasons, params}>, blocked: Array<{id, reason}>, debug:{} }
 */

import { safeArray, uniq } from "./_resolverUtils.js";

function hasAll(set, arr) {
  for (const a of arr) if (!set.has(a)) return false;
  return true;
}

function hasAny(set, arr) {
  for (const a of arr) if (set.has(a)) return true;
  return false;
}

export class OverrideResolver {
  apply(selected = [], overrides = {}, patternMetaLookup = null) {
    const enabled = overrides?.enabled !== false; // default on if overrides provided
    if (!enabled || !overrides) return { selected, blocked: [], debug: { enabled: false } };

    const blockIds = new Set(safeArray(overrides.blockPatternIds).map(String));
    const blockTags = new Set(safeArray(overrides.blockTags).map(String));
    const requireAny = safeArray(overrides.requireTagsAny).map(String);
    const requireAll = safeArray(overrides.requireTagsAll).map(String);

    const blocked = [];
    const out = [];

    for (const p of safeArray(selected)) {
      const id = String(p.id);
      if (blockIds.has(id)) {
        blocked.push({ id, reason: "Blocked by household override: patternId" });
        continue;
      }

      const meta = typeof patternMetaLookup === "function" ? (patternMetaLookup(id) || {}) : {};
      const tags = new Set(safeArray(meta.intentTags).map(String));

      if (blockTags.size && hasAny(tags, [...blockTags])) {
        blocked.push({ id, reason: "Blocked by household override: tag" });
        continue;
      }

      if (requireAny.length && !hasAny(tags, requireAny)) {
        blocked.push({ id, reason: "Filtered out: does not match requireTagsAny" });
        continue;
      }

      if (requireAll.length && !hasAll(tags, requireAll)) {
        blocked.push({ id, reason: "Filtered out: missing requireTagsAll tags" });
        continue;
      }

      const params = {
        ...(overrides.globalParams || {}),
        ...((overrides.perPatternParams || {})[id] || {})
      };

      const reasons = uniq([...(p.reasons || []),
        Object.keys(params).length ? "Household parameter overrides applied." : null
      ].filter(Boolean));

      out.push({ ...p, reasons, params });
    }

    return { selected: out, blocked, debug: { enabled: true, blockIds: [...blockIds], blockTags: [...blockTags], requireAny, requireAll } };
  }
}

export default OverrideResolver;
