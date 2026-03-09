// File: C:\Users\larho\suka-smart-assistant\src\agents\modes\validate.js
/**
 * agents/modes/validate.js
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Validate and normalize Reasoner outputs for a given mode.
 *  - Supports:
 *      1) Mode-provided JSON Schemas (draft-2020-12 or compatible)
 *      2) Mode-provided custom validate() function
 *      3) Light "shape guards" when no schema is present (never throws)
 *
 * Design goals (SSA):
 *  - Production-safe: never crash callers; return { valid:false, errors:[...] }.
 *  - Browser-safe: no Node-only imports.
 *  - Vite-safe: avoid dynamic requires and directory imports.
 *  - Deterministic: normalization is explicit and minimal.
 *
 * Expected mode config patterns (from getModeConfig / map.js):
 *  - modeConfig.schema:
 *      • schema object (JSON Schema)
 *      • OR string path to schema JSON (Vite will bundle if imported elsewhere)
 *  - modeConfig.validate:
 *      • function (mode, output) => { valid, normalized?, errors? }
 *  - modeConfig.output:
 *      • { kind: "purchaseList" | "sessionBlueprint" | ... } (optional hints)
 *
 * Public API:
 *  - validateModeOutput(modeIdOrConfig, rawResult, [opts]) -> Promise<{ valid, normalized, errors }>
 */

import { getModeConfig } from "./map.js";

/* -------------------------------------------------------------------------- */
/* Error helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ValidationError
 * @property {string} code
 * @property {string} message
 * @property {string} [path]
 * @property {any} [details]
 */

/**
 * Build a consistent error object.
 * @param {string} code
 * @param {string} message
 * @param {string} [path]
 * @param {any} [details]
 * @returns {ValidationError}
 */
function vErr(code, message, path, details) {
  const e = { code, message };
  if (path) e.path = path;
  if (details !== undefined) e.details = details;
  return e;
}

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

/* -------------------------------------------------------------------------- */
/* Reasoner output parsing & normalization                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reasoner may return:
 *  - Object already
 *  - JSON string
 *  - { content: "json..." } (LLM wrappers)
 *  - { output: {...} } (some shims)
 *  - Array / other
 *
 * We try to extract a usable object.
 *
 * @param {any} raw
 * @returns {{ ok: boolean, value: any, errors: ValidationError[] }}
 */
function extractPayload(raw) {
  const errors = [];

  if (raw == null) {
    return {
      ok: false,
      value: null,
      errors: [vErr("EMPTY", "Reasoner result is null/undefined.")],
    };
  }

  // If the result looks like an OpenAI-style response wrapper, try best-effort extraction.
  // We keep this conservative and avoid assuming any one SDK structure.
  let candidate = raw;

  // { output: ... } pattern
  if (
    isObject(candidate) &&
    "output" in candidate &&
    candidate.output != null
  ) {
    candidate = candidate.output;
  }

  // { content: "..." } pattern
  if (isObject(candidate) && typeof candidate.content === "string") {
    const maybe = tryParseJson(candidate.content);
    if (maybe.ok) return { ok: true, value: maybe.value, errors: [] };
    errors.push(
      vErr(
        "JSON_PARSE",
        "Failed to parse JSON from `content` string.",
        "content",
        maybe.errors
      )
    );
  }

  // Raw string JSON
  if (typeof candidate === "string") {
    const maybe = tryParseJson(candidate);
    if (maybe.ok) return { ok: true, value: maybe.value, errors: [] };
    return {
      ok: false,
      value: null,
      errors: [
        vErr(
          "JSON_PARSE",
          "Failed to parse Reasoner JSON string.",
          "",
          maybe.errors
        ),
      ],
    };
  }

  // Already an object/array/primitive
  return { ok: true, value: candidate, errors };
}

/**
 * Try parse JSON with a couple of safe fallbacks.
 * @param {string} text
 * @returns {{ ok: boolean, value: any, errors?: any }}
 */
function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e1) {
    // Sometimes models wrap JSON in ``` fences. Strip them carefully.
    const stripped = stripCodeFences(text);
    if (stripped !== text) {
      try {
        return { ok: true, value: JSON.parse(stripped) };
      } catch (e2) {
        return { ok: false, value: null, errors: String(e2?.message || e2) };
      }
    }
    return { ok: false, value: null, errors: String(e1?.message || e1) };
  }
}

/**
 * Remove common ```json ... ``` wrappers.
 * @param {string} s
 * @returns {string}
 */
function stripCodeFences(s) {
  if (!isNonEmptyString(s)) return s;
  const t = s.trim();
  // ```json ... ```
  if (t.startsWith("```")) {
    const firstNewline = t.indexOf("\n");
    const lastFence = t.lastIndexOf("```");
    if (firstNewline !== -1 && lastFence > firstNewline) {
      return t.slice(firstNewline + 1, lastFence).trim();
    }
  }
  return s;
}

/* -------------------------------------------------------------------------- */
/* Minimal JSON Schema validator                                               */
/* -------------------------------------------------------------------------- */
/**
 * NOTE:
 *  - This is NOT a full JSON Schema implementation.
 *  - It is an 80/20 validator for SSA mode outputs.
 *  - Supports:
 *      • type
 *      • required
 *      • properties (recursive)
 *      • additionalProperties (boolean)
 *      • items (arrays)
 *      • enum
 *      • oneOf (first matching)
 *      • anyOf (at least one matching)
 *      • allOf (all must match)
 *
 * If you need full JSON Schema, wire AJV later—but this keeps builds simple
 * and avoids additional deps in your current repo.
 */

/**
 * @param {any} schema
 * @returns {boolean}
 */
function looksLikeSchema(schema) {
  return isObject(schema) && (schema.type || schema.properties || schema.$defs);
}

/**
 * @param {any} schema
 * @param {any} value
 * @param {string} path
 * @returns {ValidationError[]}
 */
function validateBySchema(schema, value, path = "") {
  if (!looksLikeSchema(schema)) return [];

  // Handle composition
  if (Array.isArray(schema.oneOf)) {
    const all = schema.oneOf.map((s) => validateBySchema(s, value, path));
    const anyValid = all.some((errs) => errs.length === 0);
    return anyValid
      ? []
      : [
          vErr(
            "SCHEMA_ONEOF",
            "Value does not match any oneOf schema.",
            path,
            all
          ),
        ];
  }
  if (Array.isArray(schema.anyOf)) {
    const all = schema.anyOf.map((s) => validateBySchema(s, value, path));
    const anyValid = all.some((errs) => errs.length === 0);
    return anyValid
      ? []
      : [
          vErr(
            "SCHEMA_ANYOF",
            "Value does not match any anyOf schema.",
            path,
            all
          ),
        ];
  }
  if (Array.isArray(schema.allOf)) {
    const allErrs = schema.allOf.flatMap((s) =>
      validateBySchema(s, value, path)
    );
    return allErrs;
  }

  const errs = [];

  // enum
  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((v) => deepEqual(v, value));
    if (!ok) {
      errs.push(
        vErr(
          "SCHEMA_ENUM",
          `Value is not in enum: ${schema.enum.map(String).join(", ")}`,
          path,
          { enum: schema.enum }
        )
      );
      // keep going
    }
  }

  // type
  if (schema.type) {
    const ok = matchesType(schema.type, value);
    if (!ok) {
      errs.push(
        vErr(
          "SCHEMA_TYPE",
          `Expected type "${schema.type}" but got "${typeOf(value)}".`,
          path
        )
      );
      // If type mismatch is huge, stop further recursion
      return errs;
    }
  }

  // required
  if (Array.isArray(schema.required) && isObject(value)) {
    for (const k of schema.required) {
      if (!(k in value)) {
        errs.push(
          vErr(
            "SCHEMA_REQUIRED",
            `Missing required property "${k}".`,
            joinPath(path, k)
          )
        );
      }
    }
  }

  // properties
  if (schema.properties && isObject(value)) {
    const props = schema.properties || {};
    for (const [k, subSchema] of Object.entries(props)) {
      if (k in value) {
        errs.push(...validateBySchema(subSchema, value[k], joinPath(path, k)));
      }
    }

    // additionalProperties
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) {
          errs.push(
            vErr(
              "SCHEMA_ADDITIONAL",
              `Unexpected property "${k}".`,
              joinPath(path, k)
            )
          );
        }
      }
    }
  }

  // items (arrays)
  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      errs.push(
        ...validateBySchema(schema.items, value[i], joinPath(path, String(i)))
      );
    }
  }

  return errs;
}

function matchesType(schemaType, value) {
  if (Array.isArray(schemaType)) {
    return schemaType.some((t) => matchesType(t, value));
  }
  switch (schemaType) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      // unknown -> do not fail hard
      return true;
  }
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function joinPath(base, key) {
  if (!base) return key;
  // If key is numeric, treat like array index
  if (/^\d+$/.test(String(key))) return `${base}[${key}]`;
  return `${base}.${key}`;
}

/**
 * Deep equals used only for enum comparisons (small).
 * @param {any} a
 * @param {any} b
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Normalizers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Default normalizer: keep object as-is, but ensure meta stamps if requested.
 * Mode can override with modeConfig.normalize().
 *
 * @param {any} value
 * @param {object} modeConfig
 * @param {object} ctx
 * @returns {any}
 */
function defaultNormalize(value, modeConfig, ctx) {
  // If output is a primitive, wrap it (helps downstream consumers).
  if (!isObject(value) && !Array.isArray(value)) {
    return { value };
  }

  // Optionally ensure top-level shape: some modes expect { kind, ... }
  if (modeConfig?.output?.kind && isObject(value) && !value.kind) {
    return { kind: modeConfig.output.kind, ...value };
  }

  // Attach lightweight meta if caller asked for it
  if (ctx?.attachMeta && isObject(value)) {
    const meta = isObject(value.meta) ? value.meta : {};
    return {
      ...value,
      meta: {
        ...meta,
        validatedAt: new Date().toISOString(),
        mode: ctx?.modeId || modeConfig?.id || null,
      },
    };
  }

  return value;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate Reasoner result for mode and return normalized output.
 *
 * @param {string|object} mode - mode id string OR a mode config object
 * @param {any} rawResult
 * @param {object} [opts]
 * @param {boolean} [opts.attachMeta] - attach validatedAt/mode meta
 * @param {boolean} [opts.allowUnknownMode] - if true, do not fail when mode is missing
 * @returns {Promise<{ valid: boolean, normalized: any, errors: ValidationError[] }>}
 */
export async function validateModeOutput(mode, rawResult, opts = {}) {
  const errors = [];
  let modeConfig = null;

  try {
    modeConfig = typeof mode === "string" ? getModeConfig(mode) : mode;
  } catch (e) {
    modeConfig = null;
    errors.push(
      vErr(
        "MODE_LOOKUP",
        `Failed to resolve mode config for "${String(mode)}".`,
        "",
        String(e?.message || e)
      )
    );
  }

  // If modeConfig is missing and we don't allow unknowns -> invalid
  if (!modeConfig) {
    if (opts.allowUnknownMode) {
      const extracted = extractPayload(rawResult);
      if (!extracted.ok) {
        return { valid: false, normalized: null, errors: extracted.errors };
      }
      return {
        valid: true,
        normalized: defaultNormalize(
          extracted.value,
          {},
          { attachMeta: opts.attachMeta }
        ),
        errors: [],
      };
    }

    errors.push(
      vErr("MODE_MISSING", `No mode config found for "${String(mode)}".`)
    );
    return { valid: false, normalized: null, errors };
  }

  const modeId =
    modeConfig.id || modeConfig.name || (typeof mode === "string" ? mode : "");

  // Extract a usable JSON payload
  const extracted = extractPayload(rawResult);
  if (!extracted.ok) {
    return { valid: false, normalized: null, errors: extracted.errors };
  }

  const value = extracted.value;

  // Mode-specific custom validator takes precedence
  if (typeof modeConfig.validate === "function") {
    try {
      const out = await modeConfig.validate(value, { modeId, modeConfig });
      const valid = !!out?.valid;
      const outErrors = Array.isArray(out?.errors) ? out.errors : [];
      const normalized =
        out && "normalized" in out
          ? out.normalized
          : defaultNormalize(value, modeConfig, {
              attachMeta: opts.attachMeta,
              modeId,
            });

      if (!valid) {
        return {
          valid: false,
          normalized: normalized ?? null,
          errors: outErrors.length
            ? outErrors
            : [vErr("MODE_VALIDATE", "Mode validate() returned invalid.")],
        };
      }
      return { valid: true, normalized, errors: [] };
    } catch (e) {
      return {
        valid: false,
        normalized: null,
        errors: [
          vErr(
            "MODE_VALIDATE_THROW",
            "Mode validate() threw an error.",
            "",
            String(e?.message || e)
          ),
        ],
      };
    }
  }

  // Schema-based validation (if provided)
  const schema =
    modeConfig.schema && looksLikeSchema(modeConfig.schema)
      ? modeConfig.schema
      : null;

  if (schema) {
    const schemaErrs = validateBySchema(schema, value, "");
    if (schemaErrs.length) {
      return { valid: false, normalized: null, errors: schemaErrs };
    }
  } else {
    // Soft guard: if no schema, require an object or array (most SSA modes)
    if (!isObject(value) && !Array.isArray(value)) {
      return {
        valid: false,
        normalized: null,
        errors: [
          vErr(
            "SHAPE",
            `Mode "${modeId}" returned a non-object/non-array result without a schema.`,
            "",
            { got: typeOf(value) }
          ),
        ],
      };
    }
  }

  // Normalization (mode can override)
  let normalized = null;
  try {
    if (typeof modeConfig.normalize === "function") {
      normalized = await modeConfig.normalize(value, { modeId, modeConfig });
    } else {
      normalized = defaultNormalize(value, modeConfig, {
        attachMeta: opts.attachMeta,
        modeId,
      });
    }
  } catch (e) {
    return {
      valid: false,
      normalized: null,
      errors: [
        vErr(
          "NORMALIZE_THROW",
          `Normalization failed for mode "${modeId}".`,
          "",
          String(e?.message || e)
        ),
      ],
    };
  }

  return { valid: true, normalized, errors: [] };
}

export default {
  validateModeOutput,
};
