// File: C:\Users\larho\suka-smart-assistant\src\reasoner\utils\promptUtils.js
/**
 * Prompt Utils
 * -----------------------------------------------------------------------------
 * Browser-safe helpers for prompt building.
 *
 * Exports:
 *  - stableStringify(value, space)  // deterministic key order
 *  - sanitizeForPrompt(value)       // strips functions/symbols/cycles
 */

export function stableStringify(value, space = 2) {
  const seen = new WeakSet();

  const normalize = (v) => {
    if (v === null || v === undefined) return v;

    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;

    if (t === "bigint") return String(v);
    if (t === "function") return "[Function]";
    if (t === "symbol") return "[Symbol]";

    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Error)
      return { name: v.name, message: v.message, stack: v.stack };

    if (Array.isArray(v)) return v.map(normalize);

    if (t === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);

      const keys = Object.keys(v).sort();
      const out = {};
      for (const k of keys) {
        out[k] = normalize(v[k]);
      }
      return out;
    }

    return String(v);
  };

  try {
    return JSON.stringify(normalize(value), null, space);
  } catch (e) {
    return JSON.stringify(
      { error: "stableStringify_failed", message: String(e?.message || e) },
      null,
      space
    );
  }
}

export function sanitizeForPrompt(value) {
  // Similar to stableStringify normalize, but returns a JS value (not a string).
  const seen = new WeakSet();

  const normalize = (v) => {
    if (v === null || v === undefined) return v;

    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;

    if (t === "bigint") return String(v);
    if (t === "function") return undefined;
    if (t === "symbol") return undefined;

    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Error) return { name: v.name, message: v.message };

    if (Array.isArray(v))
      return v.map(normalize).filter((x) => x !== undefined);

    if (t === "object") {
      if (seen.has(v)) return undefined;
      seen.add(v);

      const out = {};
      for (const k of Object.keys(v)) {
        const nv = normalize(v[k]);
        if (nv !== undefined) out[k] = nv;
      }
      return out;
    }

    return String(v);
  };

  return normalize(value);
}
