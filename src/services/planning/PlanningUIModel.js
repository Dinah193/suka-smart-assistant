/**
 * File: src/services/planning/PlanningUIModel.js
 * Purpose: Transform pattern.ui blocks + overlays + constraints into interactive UI configuration.
 *
 * Output:
 *  - { form: { fields:[], defaults:{} }, chips:[], filters:[], help:{...}, why:[] }
 */

function safeArr(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function mergeSoft(base, add) {
  if (!add) return base;
  if (!base) return Array.isArray(add) ? [...add] : { ...add };
  if (Array.isArray(base) && Array.isArray(add)) return [...base, ...add];
  if (typeof base === "object" && typeof add === "object") {
    const out = { ...base };
    for (const [k, v] of Object.entries(add)) {
      if (out[k] == null) out[k] = v;
      else out[k] = mergeSoft(out[k], v);
    }
    return out;
  }
  return base;
}

function normalizeField(f) {
  return {
    key: String(f?.key || ""),
    type: String(f?.type || "text"), // text|number|select|multiselect|toggle|slider
    label: String(f?.label || f?.key || ""),
    help: String(f?.help || ""),
    options: safeArr(f?.options).map((o) => (typeof o === "string" ? { label: o, value: o } : o)),
    min: Number.isFinite(f?.min) ? f.min : undefined,
    max: Number.isFinite(f?.max) ? f.max : undefined,
    step: Number.isFinite(f?.step) ? f.step : undefined,
    required: !!f?.required,
    default: f?.default,
    ui: f?.ui || {},
  };
}

function buildWhy(ranked = []) {
  return safeArr(ranked).map((r) => ({
    patternId: String(r.id),
    score: Number(r.score || 0),
    reasons: safeArr(r.reasons).map(String),
  }));
}

export class PlanningUIModel {
  build({ domain, patterns = [], ranked = [], seasonal = {}, culture = {}, constraints = [], context = {}, lean = {} } = {}) {
    // Combine ui blocks across selected patterns (keep deterministic ordering)
    const uiBlocks = safeArr(patterns).map((p) => p?.ui || {}).filter(Boolean);

    // Merge culture ui overlay (soft, non-destructive)
    const cultureUi = culture?.uiOverlays || {};
    const mergedUi = uiBlocks.reduce((acc, u) => mergeSoft(acc, u), {});
    const finalUi = mergeSoft(mergedUi, cultureUi);

    const fields = safeArr(finalUi?.form?.fields).map(normalizeField);
    const defaults = { ...(finalUi?.form?.defaults || {}) };

    // Apply constraint-driven defaults (only if missing)
    const constraintSet = new Set(safeArr(constraints).map(String));
    if (constraintSet.has("needsInventorySnapshot") && defaults.inventorySnapshot == null) {
      defaults.inventorySnapshot = "required";
    }
    if (constraintSet.has("season:winter") && defaults.preservationBias == null) {
      defaults.preservationBias = "low";
    }

    // Chips and filters
    const chips = safeArr(finalUi?.chips).map((c) => ({
      key: String(c?.key || c || ""),
      label: String(c?.label || c?.key || c || ""),
      tag: String(c?.tag || c || ""),
      kind: String(c?.kind || "chip"),
    }));

    const filters = safeArr(finalUi?.filters).map((f) => ({
      key: String(f?.key || ""),
      label: String(f?.label || f?.key || ""),
      type: String(f?.type || "tag"),
      options: safeArr(f?.options),
      default: f?.default,
    }));

    // Help text + "why"
    const help = {
      title: String(finalUi?.help?.title || "Plan settings"),
      intro: String(finalUi?.help?.intro || ""),
      tips: safeArr(finalUi?.help?.tips).map(String),
      constraints: safeArr(constraints).map(String),
      seasonal: safeArr(seasonal?.tags).map(String),
      leanNotes: safeArr(lean?.recommendations?.countermeasureHints).map((h) => ({
        hintTag: h.hintTag,
        reason: h.reason,
      })),
    };

    return {
      domain,
      form: { fields, defaults },
      chips,
      filters,
      help,
      why: buildWhy(ranked),
    };
  }
}

export default PlanningUIModel;
