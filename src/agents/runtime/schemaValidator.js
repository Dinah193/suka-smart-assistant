// File: C:\Users\larho\suka-smart-assistant\src\agents\runtime\schemaValidator.js
/**
 * SSA Schema Validator (runtime)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Provide a lightweight, production-safe JSON Schema validation utility for
 *    agent/runtime shims and orchestration layers.
 *
 * Design goals
 *  - Zero heavy deps by default (no Ajv required).
 *  - Works in Vite/browser builds.
 *  - Supports 3 modes:
 *      1) "off"   : no-op (always valid)
 *      2) "soft"  : best-effort validation (warn on issues, returns valid=false)
 *      3) "strict": throws on invalid
 *  - Optional Ajv adapter if present in the bundle (dynamic import).
 *
 * Assumptions
 *  - Many SSA "schemas" are simple contracts (shape checks) rather than full
 *    draft-2020 JSON Schema. This module supports:
 *      - basic type checks (object/array/string/number/integer/boolean/null)
 *      - required properties
 *      - properties (recursive)
 *      - items (array)
 *      - enum
 *      - oneOf / anyOf / allOf (basic)
 *      - additionalProperties (boolean or schema)
 *      - minimum/maximum (number)
 *      - minLength/maxLength (string)
 *      - pattern (string regex)
 *      - minItems/maxItems (array)
 *  - If you need full JSON Schema compliance: install Ajv and enable useAjv.
 *
 * Public API
 *  - validate(data, schema, opts) -> { ok, errors, warnings, meta }
 *  - assertValid(data, schema, opts) -> data (throws on invalid)
 *  - compile(schema, opts) -> (data) => result
 *  - registerSchema(id, schema) / getSchema(id)
 *  - setDefaultMode(mode) / getDefaultMode()
 */

const DEFAULTS = Object.freeze({
  mode: "soft", // "off" | "soft" | "strict"
  source: "agents/runtime/schemaValidator",
  useAjv: false, // if true, will try to load Ajv dynamically (best-effort)
  ajvOptions: null,
  maxErrors: 25,
  allowUnknownSchemaKeywords: true, // tolerate custom schema shapes
});

const registry = new Map(); // id -> schema
let defaultMode = DEFAULTS.mode;

// ----------------------------------------------------------------------------
// Utils
// ----------------------------------------------------------------------------
function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function nowISO() {
  return new Date().toISOString();
}

function safeString(x) {
  try {
    return typeof x === "string" ? x : JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function joinPath(base, key) {
  if (!base) return key ? `/${key}` : "/";
  if (!key) return base;
  return `${base}/${key}`;
}

function typeOfValue(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean" | "undefined" | "function"
}

function normalizeType(t) {
  if (!t) return null;
  // JSON Schema "integer" is a special number subtype
  return t;
}

function isInteger(n) {
  return typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
}

function asArray(x) {
  return Array.isArray(x) ? x : x == null ? [] : [x];
}

function capErrors(arr, max) {
  if (!Array.isArray(arr)) return [];
  if (!Number.isFinite(max) || max <= 0) return arr;
  return arr.slice(0, max);
}

// ----------------------------------------------------------------------------
// Error objects
// ----------------------------------------------------------------------------
function makeIssue(kind, path, message, detail) {
  return {
    kind, // "error" | "warning"
    path: path || "/",
    message: message || "Invalid value",
    detail: detail || null,
  };
}

// ----------------------------------------------------------------------------
// Minimal schema validator (best-effort)
// ----------------------------------------------------------------------------
function validateWithMiniEngine(data, schema, opts) {
  const errors = [];
  const warnings = [];

  const maxErrors = Number.isFinite(opts?.maxErrors)
    ? opts.maxErrors
    : DEFAULTS.maxErrors;
  const allowUnknown =
    opts?.allowUnknownSchemaKeywords ?? DEFAULTS.allowUnknownSchemaKeywords;

  function pushError(path, message, detail) {
    if (errors.length >= maxErrors) return;
    errors.push(makeIssue("error", path, message, detail));
  }

  function pushWarn(path, message, detail) {
    if (warnings.length >= maxErrors) return;
    warnings.push(makeIssue("warning", path, message, detail));
  }

  function checkType(value, expectedType, path) {
    const t = normalizeType(expectedType);
    if (!t) return true;

    if (t === "integer") {
      if (!isInteger(value)) {
        pushError(path, `Expected integer but got ${typeOfValue(value)}`, {
          expected: t,
          got: typeOfValue(value),
        });
        return false;
      }
      return true;
    }

    if (t === "array") {
      if (!Array.isArray(value)) {
        pushError(path, `Expected array but got ${typeOfValue(value)}`, {
          expected: t,
          got: typeOfValue(value),
        });
        return false;
      }
      return true;
    }

    if (t === "null") {
      if (value !== null) {
        pushError(path, `Expected null but got ${typeOfValue(value)}`, {
          expected: t,
          got: typeOfValue(value),
        });
        return false;
      }
      return true;
    }

    // "number", "string", "boolean", "object"
    if (t === "object") {
      if (!isPlainObject(value)) {
        pushError(path, `Expected object but got ${typeOfValue(value)}`, {
          expected: t,
          got: typeOfValue(value),
        });
        return false;
      }
      return true;
    }

    if (typeof value !== t) {
      pushError(path, `Expected ${t} but got ${typeOfValue(value)}`, {
        expected: t,
        got: typeOfValue(value),
      });
      return false;
    }

    // number must be finite
    if (t === "number" && !Number.isFinite(value)) {
      pushError(path, `Expected finite number but got ${String(value)}`, {
        expected: t,
        got: String(value),
      });
      return false;
    }

    return true;
  }

  function checkEnum(value, enumList, path) {
    if (!Array.isArray(enumList) || !enumList.length) return true;
    const ok = enumList.some((e) => Object.is(e, value));
    if (!ok) {
      pushError(path, `Value not in enum`, { enum: enumList, got: value });
      return false;
    }
    return true;
  }

  function checkNumberBounds(value, schemaNode, path) {
    if (typeof value !== "number" || !Number.isFinite(value) || !schemaNode)
      return true;

    if (Number.isFinite(schemaNode.minimum) && value < schemaNode.minimum) {
      pushError(path, `Number < minimum`, {
        minimum: schemaNode.minimum,
        got: value,
      });
      return false;
    }
    if (Number.isFinite(schemaNode.maximum) && value > schemaNode.maximum) {
      pushError(path, `Number > maximum`, {
        maximum: schemaNode.maximum,
        got: value,
      });
      return false;
    }
    return true;
  }

  function checkStringBounds(value, schemaNode, path) {
    if (typeof value !== "string" || !schemaNode) return true;

    if (
      Number.isFinite(schemaNode.minLength) &&
      value.length < schemaNode.minLength
    ) {
      pushError(path, `String shorter than minLength`, {
        minLength: schemaNode.minLength,
        gotLength: value.length,
      });
      return false;
    }
    if (
      Number.isFinite(schemaNode.maxLength) &&
      value.length > schemaNode.maxLength
    ) {
      pushError(path, `String longer than maxLength`, {
        maxLength: schemaNode.maxLength,
        gotLength: value.length,
      });
      return false;
    }
    if (typeof schemaNode.pattern === "string" && schemaNode.pattern.length) {
      let re = null;
      try {
        re = new RegExp(schemaNode.pattern);
      } catch (e) {
        // schema issue: invalid regex
        if (allowUnknown) {
          pushWarn(path, `Invalid schema pattern regex`, {
            pattern: schemaNode.pattern,
            error: String(e?.message || e),
          });
          return true;
        }
        pushError(path, `Invalid schema pattern regex`, {
          pattern: schemaNode.pattern,
          error: String(e?.message || e),
        });
        return false;
      }
      if (re && !re.test(value)) {
        pushError(path, `String does not match pattern`, {
          pattern: schemaNode.pattern,
          got: value,
        });
        return false;
      }
    }
    return true;
  }

  function checkArrayBounds(value, schemaNode, path) {
    if (!Array.isArray(value) || !schemaNode) return true;
    if (
      Number.isFinite(schemaNode.minItems) &&
      value.length < schemaNode.minItems
    ) {
      pushError(path, `Array has fewer items than minItems`, {
        minItems: schemaNode.minItems,
        gotLength: value.length,
      });
      return false;
    }
    if (
      Number.isFinite(schemaNode.maxItems) &&
      value.length > schemaNode.maxItems
    ) {
      pushError(path, `Array has more items than maxItems`, {
        maxItems: schemaNode.maxItems,
        gotLength: value.length,
      });
      return false;
    }
    return true;
  }

  function validateNode(value, schemaNode, path) {
    if (errors.length >= maxErrors) return false;
    if (!schemaNode || typeof schemaNode !== "object") return true;

    // Support shorthand schema: { type: ["string","null"] }
    const types = asArray(schemaNode.type).filter(Boolean);

    if (types.length) {
      // if multiple types, accept any
      const okAny = types.some((t) => checkType(value, t, path));
      if (!okAny) return false;
    }

    if (schemaNode.enum) {
      if (!checkEnum(value, schemaNode.enum, path)) return false;
    }

    // Number constraints
    checkNumberBounds(value, schemaNode, path);

    // String constraints
    checkStringBounds(value, schemaNode, path);

    // Array constraints
    checkArrayBounds(value, schemaNode, path);

    // Logical composition
    if (Array.isArray(schemaNode.allOf) && schemaNode.allOf.length) {
      for (const s of schemaNode.allOf) validateNode(value, s, path);
    }

    if (Array.isArray(schemaNode.anyOf) && schemaNode.anyOf.length) {
      const startErrCount = errors.length;
      const subErrs = [];
      let ok = false;
      for (const s of schemaNode.anyOf) {
        const before = errors.length;
        // attempt; capture errors produced by this attempt
        validateNode(value, s, path);
        const produced = errors.splice(before); // remove produced errors for this attempt
        subErrs.push(produced);
        if (produced.length === 0) {
          ok = true;
          // restore errors to original count (none)
          break;
        }
      }
      if (!ok) {
        // restore a representative error set
        const pick = subErrs.find((arr) => arr.length) || [];
        for (const e of pick) errors.push(e);
        if (errors.length === startErrCount) {
          pushError(path, "Value did not match anyOf schemas");
        }
      }
    }

    if (Array.isArray(schemaNode.oneOf) && schemaNode.oneOf.length) {
      let matchCount = 0;
      const saved = [];
      for (const s of schemaNode.oneOf) {
        const before = errors.length;
        validateNode(value, s, path);
        const produced = errors.splice(before);
        saved.push(produced);
        if (produced.length === 0) matchCount += 1;
      }
      if (matchCount !== 1) {
        const msg =
          matchCount === 0
            ? "Value did not match any oneOf schema"
            : "Value matched more than one oneOf schema";
        pushError(path, msg, { matchCount });
        // optionally attach first failure details
        const firstFail = saved.find((arr) => arr.length) || [];
        for (const e of firstFail) {
          if (errors.length >= maxErrors) break;
          errors.push(e);
        }
      }
    }

    // Object recursion
    if (isPlainObject(value)) {
      const required = Array.isArray(schemaNode.required)
        ? schemaNode.required
        : [];
      for (const key of required) {
        if (!(key in value)) {
          pushError(joinPath(path, key), `Missing required property`, {
            required: key,
          });
        }
      }

      const props = isPlainObject(schemaNode.properties)
        ? schemaNode.properties
        : null;
      if (props) {
        for (const [k, s] of Object.entries(props)) {
          if (k in value) {
            validateNode(value[k], s, joinPath(path, k));
          }
        }
      }

      // additionalProperties
      if (schemaNode.additionalProperties === false && props) {
        for (const k of Object.keys(value)) {
          if (!(k in props)) {
            pushError(joinPath(path, k), `Additional property not allowed`, {
              key: k,
            });
          }
        }
      } else if (isPlainObject(schemaNode.additionalProperties) && props) {
        for (const k of Object.keys(value)) {
          if (!(k in props)) {
            validateNode(
              value[k],
              schemaNode.additionalProperties,
              joinPath(path, k)
            );
          }
        }
      }
    }

    // Array recursion
    if (Array.isArray(value)) {
      if (schemaNode.items) {
        if (Array.isArray(schemaNode.items)) {
          // tuple validation
          for (let i = 0; i < value.length; i++) {
            const s = schemaNode.items[i] || schemaNode.additionalItems;
            if (s) validateNode(value[i], s, joinPath(path, String(i)));
          }
        } else {
          // single schema applies to all items
          for (let i = 0; i < value.length; i++) {
            validateNode(value[i], schemaNode.items, joinPath(path, String(i)));
          }
        }
      }
    }

    // Unknown keywords
    if (!allowUnknown) {
      // Very conservative: detect a few known keywords and warn on others
      const known = new Set([
        "$schema",
        "$id",
        "title",
        "description",
        "type",
        "required",
        "properties",
        "items",
        "enum",
        "oneOf",
        "anyOf",
        "allOf",
        "additionalProperties",
        "additionalItems",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "pattern",
        "minItems",
        "maxItems",
      ]);
      for (const k of Object.keys(schemaNode)) {
        if (!known.has(k))
          pushWarn(path, `Unknown schema keyword`, { keyword: k });
      }
    }

    return errors.length === 0;
  }

  validateNode(data, schema, "/");

  return {
    ok: errors.length === 0,
    errors: capErrors(errors, maxErrors),
    warnings: capErrors(warnings, maxErrors),
    meta: {
      engine: "mini",
      validatedAt: nowISO(),
    },
  };
}

// ----------------------------------------------------------------------------
// Optional Ajv engine (dynamic import, best-effort)
// ----------------------------------------------------------------------------
async function tryCreateAjv(opts) {
  // If user didn't request Ajv, skip.
  if (!opts?.useAjv) return null;

  // Ajv may not be installed; dynamic import protects builds.
  try {
    const mod = await import("ajv");
    const Ajv = mod?.default || mod?.Ajv || mod;
    if (!Ajv) return null;

    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      ...(opts?.ajvOptions || {}),
    });

    // addFormats is separate in newer versions; tolerate missing
    try {
      const fm = await import("ajv-formats");
      const addFormats = fm?.default || fm;
      if (typeof addFormats === "function") addFormats(ajv);
    } catch {
      // ignore
    }

    return ajv;
  } catch {
    return null;
  }
}

async function validateWithAjv(data, schema, opts) {
  const maxErrors = Number.isFinite(opts?.maxErrors)
    ? opts.maxErrors
    : DEFAULTS.maxErrors;

  const ajv = await tryCreateAjv(opts);
  if (!ajv) {
    // fallback to mini engine
    return validateWithMiniEngine(data, schema, opts);
  }

  let validateFn = null;
  try {
    validateFn = ajv.compile(schema);
  } catch (e) {
    // schema itself invalid for Ajv; fallback to mini
    const mini = validateWithMiniEngine(data, schema, opts);
    mini.warnings = (mini.warnings || []).concat(
      makeIssue(
        "warning",
        "/",
        "Ajv compile failed; fell back to mini validator",
        {
          error: String(e?.message || e),
        }
      )
    );
    return mini;
  }

  const ok = !!validateFn(data);
  const errors = [];
  if (!ok && Array.isArray(validateFn.errors)) {
    for (const err of validateFn.errors.slice(0, maxErrors)) {
      errors.push(
        makeIssue(
          "error",
          err?.instancePath || "/",
          err?.message || "Schema validation error",
          {
            keyword: err?.keyword,
            params: err?.params,
            schemaPath: err?.schemaPath,
          }
        )
      );
    }
  }

  return {
    ok,
    errors,
    warnings: [],
    meta: {
      engine: "ajv",
      validatedAt: nowISO(),
    },
  };
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Register a schema by id (e.g., "session.contract.v1").
 */
export function registerSchema(id, schema) {
  if (typeof id !== "string" || !id.trim()) return false;
  if (!schema || typeof schema !== "object") return false;
  registry.set(id.trim(), schema);
  return true;
}

/**
 * Get a registered schema.
 */
export function getSchema(id) {
  if (typeof id !== "string" || !id.trim()) return null;
  return registry.get(id.trim()) || null;
}

/**
 * Set default validation mode globally.
 * @param {"off"|"soft"|"strict"} mode
 */
export function setDefaultMode(mode) {
  if (mode === "off" || mode === "soft" || mode === "strict") {
    defaultMode = mode;
  }
  return defaultMode;
}

export function getDefaultMode() {
  return defaultMode;
}

function resolveOptions(opts) {
  const merged = {
    ...DEFAULTS,
    ...(opts || {}),
  };

  merged.mode = merged.mode || defaultMode;

  if (
    merged.mode !== "off" &&
    merged.mode !== "soft" &&
    merged.mode !== "strict"
  ) {
    merged.mode = defaultMode;
  }

  merged.useAjv = !!merged.useAjv;
  merged.maxErrors = Number.isFinite(merged.maxErrors)
    ? merged.maxErrors
    : DEFAULTS.maxErrors;

  return merged;
}

/**
 * Validate data against schema.
 * @param {any} data
 * @param {object|string} schemaOrId schema object OR registered schema id
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, errors:Array, warnings:Array, meta:Object}>}
 */
export async function validate(data, schemaOrId, opts = {}) {
  const o = resolveOptions(opts);

  // Off mode: always OK
  if (o.mode === "off") {
    return {
      ok: true,
      errors: [],
      warnings: [],
      meta: { engine: "off", validatedAt: nowISO() },
    };
  }

  const schema =
    typeof schemaOrId === "string" ? getSchema(schemaOrId) : schemaOrId;

  if (!schema || typeof schema !== "object") {
    const res = {
      ok: false,
      errors: [
        makeIssue("error", "/", "Schema is missing or invalid", { schemaOrId }),
      ],
      warnings: [],
      meta: { engine: "none", validatedAt: nowISO() },
    };
    if (o.mode === "strict") {
      const e = new Error("Schema validation failed: schema missing/invalid");
      e.details = res;
      throw e;
    }
    return res;
  }

  const result = o.useAjv
    ? await validateWithAjv(data, schema, o)
    : validateWithMiniEngine(data, schema, o);

  // Soft mode: return errors; Strict mode: throw
  if (!result.ok && o.mode === "strict") {
    const e = new Error(
      `Schema validation failed (${result?.meta?.engine || "unknown"}): ${
        result?.errors?.[0]?.message || "invalid"
      }`
    );
    e.details = result;
    throw e;
  }

  return result;
}

/**
 * Back-compat export expected by shims (e.g. sababShim.js):
 *   import { validateModeOutput } from "@/agents/runtime/schemaValidator";
 *
 * Flexible signature:
 *  - validateModeOutput(output, schemaOrId, opts)
 *  - validateModeOutput(schemaId, output, opts)
 */
export async function validateModeOutput(a, b, c) {
  // If first arg is a schema id string and second is data -> (schemaId, data, opts)
  if (typeof a === "string") {
    return validate(b, a, c || {});
  }
  // Otherwise -> (data, schemaOrId, opts)
  return validate(a, b, c || {});
}

/**
 * Throw if invalid; otherwise return data.
 */
export async function assertValid(data, schemaOrId, opts = {}) {
  const o = resolveOptions({ ...opts, mode: "strict" });
  await validate(data, schemaOrId, o);
  return data;
}

/**
 * Compile a schema into a validator function.
 * @param {object|string} schemaOrId
 * @param {object} [opts]
 * @returns {(data:any)=>Promise<{ok:boolean, errors:Array, warnings:Array, meta:Object}>}
 */
export function compile(schemaOrId, opts = {}) {
  const o = resolveOptions(opts);
  return async (data) => validate(data, schemaOrId, o);
}

/**
 * Convenience: validate and return a boolean.
 */
export async function isValid(data, schemaOrId, opts = {}) {
  const res = await validate(data, schemaOrId, opts);
  return !!res.ok;
}

export default {
  validate,
  validateModeOutput,
  assertValid,
  compile,
  isValid,
  registerSchema,
  getSchema,
  setDefaultMode,
  getDefaultMode,
};
