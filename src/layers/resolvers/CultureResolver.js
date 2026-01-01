/**
 * File: src/layers/resolvers/CultureResolver.js
 * Purpose: Apply cultural workflow overlay(s) onto selected patterns (naming/ordering/defaults/bias).
 *
 * Deterministic blend modes:
 *  - "merge": secondary overlays fill only missing keys
 *  - "weighted": bias scores using weights (primaryWeight, secondaryWeight)
 *
 * Inputs:
 *  - selected: Array<{ id:string, score?:number, reasons?:string[] }>
 *  - culturePrefs: {
 *      enabled?: boolean,
 *      primaryId?: string,   // workflow overlay id
 *      secondaryId?: string, // workflow overlay id
 *      blendMode?: "merge" | "weighted",
 *      weightPrimary?: number, // 0..1 (weighted mode)
 *      weightSecondary?: number, // 0..1 (weighted mode)
 *    }
 *  - assets: { getWorkflowOverlay(id): object|null }  (LayerAssetLoader helper)
 *
 * Output:
 *  - { selected: Array<{id, score, reasons, overlay:{...}}>, blueprintSettings:{ tagsAdd, uiOverlays, constraintOverlays, patternBiases, roleDefaults }, debug:{} }
 */

import { clamp, safeArray, uniq } from "./_resolverUtils.js";

function deepMergeSoft(base, add) {
  if (add == null) return base;
  if (base == null) return Array.isArray(add) ? [...add] : { ...add };
  if (Array.isArray(base) && Array.isArray(add)) return uniq([...base, ...add]);
  if (typeof base === "object" && typeof add === "object") {
    const out = { ...base };
    for (const [k, v] of Object.entries(add)) {
      if (out[k] == null) out[k] = v;
      else out[k] = deepMergeSoft(out[k], v);
    }
    return out;
  }
  return base; // soft merge never overwrites primitives
}

function weightedBiasMerge(primaryBias = {}, secondaryBias = {}, wp = 0.7, ws = 0.3) {
  const out = { favor: {}, avoid: {} };
  for (const kind of ["favor", "avoid"]) {
    const a = primaryBias?.[kind] || {};
    const b = secondaryBias?.[kind] || {};
    const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const id of ids) {
      const av = Number(a[id] || 0);
      const bv = Number(b[id] || 0);
      out[kind][id] = av * wp + bv * ws;
    }
  }
  // passthrough hint tags if any
  out.emitHintTags = uniq([...(primaryBias.emitHintTags || []), ...(secondaryBias.emitHintTags || [])]);
  return out;
}

export class CultureResolver {
  /**
   * @param {object} opts
   * @param {function(string): any} opts.getWorkflowOverlay required
   */
  constructor(opts = {}) {
    if (typeof opts.getWorkflowOverlay !== "function") {
      throw new Error("CultureResolver requires getWorkflowOverlay(id) function.");
    }
    this.getWorkflowOverlay = opts.getWorkflowOverlay;
  }

  apply(selected = [], culturePrefs = {}) {
    const enabled = !!culturePrefs?.enabled;
    if (!enabled) return { selected, blueprintSettings: { tagsAdd: [], uiOverlays: {}, constraintOverlays: {}, patternBiases: {}, roleDefaults: {} }, debug: { enabled: false } };

    const primaryId = culturePrefs.primaryId || "";
    const secondaryId = culturePrefs.secondaryId || "";
    const blendMode = culturePrefs.blendMode || "merge";
    const wp = clamp(Number(culturePrefs.weightPrimary ?? 0.7), 0, 1);
    const ws = clamp(Number(culturePrefs.weightSecondary ?? (1 - wp)), 0, 1);

    const primary = primaryId ? this.getWorkflowOverlay(primaryId) : null;
    const secondary = secondaryId ? this.getWorkflowOverlay(secondaryId) : null;

    const pOut = primary?.outputs_default || {};
    const sOut = secondary?.outputs_default || {};
    const pBias = pOut.patternBiases || {};
    const sBias = sOut.patternBiases || {};

    let merged = {
      tagsAdd: uniq([...(pOut.tagOverlays || []), ...(sOut.tagOverlays || [])]),
      uiOverlays: deepMergeSoft(pOut.uiOverlays || {}, sOut.uiOverlays || {}),
      constraintOverlays: deepMergeSoft(pOut.constraintOverlays || {}, sOut.constraintOverlays || {}),
      roleDefaults: deepMergeSoft(pOut.roleDefaults || {}, sOut.roleDefaults || {}),
      patternBiases: blendMode === "weighted"
        ? weightedBiasMerge(pBias, sBias, wp, ws)
        : deepMergeSoft(pBias || {}, sBias || {}),
    };

    // Apply bias to selected patterns deterministically
    const outSelected = safeArray(selected).map((p) => {
      const id = String(p.id);
      const baseScore = Number(p.score || 0);
      const favor = Number(merged.patternBiases?.favor?.[id] || 0);
      const avoid = Number(merged.patternBiases?.avoid?.[id] || 0);
      // bias values are small multipliers; treat missing as 0
      const adjusted = clamp(baseScore * (1 + favor) * (1 + avoid), -1, 10);
      const reasons = uniq([...(p.reasons || []),
        favor ? `Culture bias favor applied (${favor.toFixed(2)}).` : null,
        avoid ? `Culture bias avoid applied (${avoid.toFixed(2)}).` : null
      ].filter(Boolean));
      return {
        ...p,
        score: adjusted,
        reasons,
        overlay: {
          tagsAdd: merged.tagsAdd,
          uiOverlays: merged.uiOverlays,
          constraintOverlays: merged.constraintOverlays,
        }
      };
    });

    return {
      selected: outSelected,
      blueprintSettings: merged,
      debug: { enabled: true, primaryId, secondaryId, blendMode, weightPrimary: wp, weightSecondary: ws }
    };
  }
}

export default CultureResolver;
