// C:\Users\larho\suka-smart-assistant\src\services\calculators\calculatorValidation.js

/**
 * Calculator Validation Helpers
 *
 * How this fits:
 * - Provides a standard way to validate calculator INPUTS and OUTPUTS
 *   against JSON Schemas (or lightweight fallbacks) before:
 *     • running calculator shims,
 *     • storing results,
 *     • feeding data into the Planning Graph or SessionRunner.
 *
 * Design:
 * - Schema registry keyed by calculatorId:
 *     "health.macro", "garden.seeds.viability", etc.
 * - Optional Ajv integration (if installed) for full JSON Schema support.
 * - Fallback minimal validator (required fields only) when Ajv is absent.
 *
 * Typical usage:
 *   import {
 *     registerCalculatorSchemas,
 *     validateCalculatorInput,
 *     validateCalculatorOutput,
 *     ensureValidCalculatorInputOrThrow,
 *   } from "@/services/calculators/calculatorValidation";
 *
 *   registerCalculatorSchemas("health.macro", {
 *     inputSchema: macroInputSchemaJson,
 *     outputSchema: macroOutputSchemaJson,
 *   });
 *
 *   const { valid, errors } = await validateCalculatorInput("health.macro", data);
 *   if (!valid) { // show errors in UI }
 *
 * Notes:
 * - This module is intentionally UI-agnostic.
 * - It can be wired into `calculatorRunner` and/or individual shims.
 */

import eventBus from "@/services/eventBus";

/**
 * @typedef {Object} CalculatorSchemaPair
 * @property {object} [inputSchema]
 * @property {object} [outputSchema]
 */

/**
 * @typedef {Object} ValidationErrorDetail
 * @property {string} path       - JSON pointer-ish path, e.g. "/age" or "/inputs/0"
 * @property {string} message    - Human-readable error description
 * @property {string} [keyword]  - JSON Schema keyword (e.g. "type", "required")
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {ValidationErrorDetail[]} errors
 */

/**
 * @typedef {Object} ValidationOptions
 * @property {boolean} [throwOnError]   - If true, throws on invalid
 * @property {boolean} [emitEvents]     - If true (default), emit validation events
 */

/**
 * @typedef {Object} CalculatorRunContext
 * @property {string} [userId]
 * @property {string} [householdId]
 * @property {string} [sessionDomain]
 * @property {Object.<string, any>} [env]
 */

/** ------------------------------------------------------------------------
 *  Schema registry & Ajv initialization
 * --------------------------------------------------------------------- */

/** @type {Map<string, CalculatorSchemaPair>} */
const schemaRegistry = new Map();

// Lazy Ajv require to avoid hard dependency.
/** @type {any} */
let AjvCtor = null;
/** @type {any} */
let ajvInstance = null;

try {
  // eslint-disable-next-line global-require
  const ajvModule = require("ajv");
  AjvCtor = ajvModule.default || ajvModule;
} catch (_) {
  AjvCtor = null;
}

/**
 * Get or create a shared Ajv instance.
 *
 * @returns {any|null}
 */
function getAjv() {
  if (!AjvCtor) return null;
  if (!ajvInstance) {
    ajvInstance = new AjvCtor({
      allErrors: true,
      strict: false,
    });
  }
  return ajvInstance;
}

/** @type {Map<string, any>} */
const compiledValidators = new Map();

/** ------------------------------------------------------------------------
 *  Public API — registry
 * --------------------------------------------------------------------- */

/**
 * Register input/output JSON Schemas for a calculator.
 *
 * @param {string} calculatorId
 * @param {CalculatorSchemaPair} schemas
 */
export function registerCalculatorSchemas(calculatorId, schemas) {
  if (!calculatorId || typeof calculatorId !== "string") {
    throw new Error("[calculatorValidation] calculatorId is required");
  }
  if (!schemas || typeof schemas !== "object") {
    throw new Error("[calculatorValidation] schemas object is required");
  }

  schemaRegistry.set(calculatorId, {
    inputSchema: schemas.inputSchema || undefined,
    outputSchema: schemas.outputSchema || undefined,
  });

  // Clear any previously compiled validators for this calculator
  compiledValidators.delete(makeValidatorKey(calculatorId, "input"));
  compiledValidators.delete(makeValidatorKey(calculatorId, "output"));
}

/**
 * Get registered schemas for a calculator (if any).
 *
 * @param {string} calculatorId
 * @returns {CalculatorSchemaPair | null}
 */
export function getCalculatorSchemas(calculatorId) {
  if (!calculatorId || typeof calculatorId !== "string") return null;
  return schemaRegistry.get(calculatorId) || null;
}

/** ------------------------------------------------------------------------
 *  Public API — validation
 * --------------------------------------------------------------------- */

/**
 * Validate INPUT for a calculator against its registered inputSchema.
 *
 * @param {string} calculatorId
 * @param {any} data
 * @param {ValidationOptions} [options]
 * @returns {Promise<ValidationResult>}
 */
export async function validateCalculatorInput(
  calculatorId,
  data,
  options = {}
) {
  return validateCalculatorPayload(calculatorId, "input", data, options);
}

/**
 * Validate OUTPUT for a calculator against its registered outputSchema.
 *
 * @param {string} calculatorId
 * @param {any} data
 * @param {ValidationOptions} [options]
 * @returns {Promise<ValidationResult>}
 */
export async function validateCalculatorOutput(
  calculatorId,
  data,
  options = {}
) {
  return validateCalculatorPayload(calculatorId, "output", data, options);
}

/**
 * Ensure INPUT is valid or throw an Error with details.
 *
 * @param {string} calculatorId
 * @param {any} data
 * @param {ValidationOptions} [options]
 * @returns {Promise<void>}
 */
export async function ensureValidCalculatorInputOrThrow(
  calculatorId,
  data,
  options = {}
) {
  await ensureValid(calculatorId, "input", data, options);
}

/**
 * Ensure OUTPUT is valid or throw an Error with details.
 *
 * @param {string} calculatorId
 * @param {any} data
 * @param {ValidationOptions} [options]
 * @returns {Promise<void>}
 */
export async function ensureValidCalculatorOutputOrThrow(
  calculatorId,
  data,
  options = {}
) {
  await ensureValid(calculatorId, "output", data, options);
}

/** ------------------------------------------------------------------------
 *  Core validation logic
 * --------------------------------------------------------------------- */

/**
 * @param {string} calculatorId
 * @param {"input"|"output"} kind
 * @param {any} data
 * @param {ValidationOptions} options
 * @returns {Promise<ValidationResult>}
 */
async function validateCalculatorPayload(calculatorId, kind, data, options) {
  const { emitEvents = true, throwOnError = false } = options || {};

  if (!calculatorId || typeof calculatorId !== "string") {
    const err = new Error(
      `[calculatorValidation] calculatorId is required for ${kind} validation`
    );
    if (throwOnError) throw err;
    return { valid: false, errors: [{ path: "", message: err.message }] };
  }

  const schemas = schemaRegistry.get(calculatorId) || {};
  const schema =
    kind === "input" ? schemas.inputSchema : schemas.outputSchema;

  if (!schema || typeof schema !== "object") {
    // No schema registered → treat as valid (but log once).
    // eslint-disable-next-line no-console
    console.warn(
      `[calculatorValidation] No ${kind} schema registered for calculatorId '${calculatorId}'. Treating as valid.`
    );
    const result = { valid: true, errors: [] };
    if (emitEvents) {
      emitValidationEvent(calculatorId, kind, result);
    }
    return result;
  }

  // Prefer Ajv if available; otherwise fall back to lightweight validation.
  const ajv = getAjv();
  let result;

  if (ajv) {
    result = validateWithAjv(ajv, calculatorId, kind, schema, data);
  } else {
    result = validateWithFallback(schema, data);
  }

  if (emitEvents) {
    emitValidationEvent(calculatorId, kind, result);
  }

  if (!result.valid && throwOnError) {
    const err = new Error(
      `[calculatorValidation] ${kind} validation failed for '${calculatorId}': ` +
        result.errors.map((e) => e.message).join("; ")
    );
    // Attach details for higher-level handlers.
    // @ts-ignore
    err.details = result.errors;
    throw err;
  }

  return result;
}

/**
 * Helper to wrap ensureValid*OrThrow functions.
 *
 * @param {string} calculatorId
 * @param {"input"|"output"} kind
 * @param {any} data
 * @param {ValidationOptions} options
 */
async function ensureValid(calculatorId, kind, data, options) {
  await validateCalculatorPayload(calculatorId, kind, data, {
    ...options,
    throwOnError: true,
  });
}

/**
 * Validate using Ajv and cache compiled validators.
 *
 * @param {any} ajv
 * @param {string} calculatorId
 * @param {"input"|"output"} kind
 * @param {object} schema
 * @param {any} data
 * @returns {ValidationResult}
 */
function validateWithAjv(ajv, calculatorId, kind, schema, data) {
  const key = makeValidatorKey(calculatorId, kind);
  let validator = compiledValidators.get(key);

  if (!validator) {
    try {
      validator = ajv.compile(schema);
      compiledValidators.set(key, validator);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[calculatorValidation] Failed to compile schema for",
        calculatorId,
        kind,
        err
      );
      return {
        valid: false,
        errors: [
          {
            path: "",
            message: "Failed to compile validation schema",
            keyword: "schema",
          },
        ],
      };
    }
  }

  const valid = validator(data);
  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors =
    Array.isArray(validator.errors) && validator.errors.length
      ? validator.errors.map((e) => ({
          path: normalizeAjvPath(e.instancePath || e.dataPath || ""),
          message: e.message || "Invalid value",
          keyword: e.keyword,
        }))
      : [
          {
            path: "",
            message: "Validation failed for unknown reasons",
          },
        ];

  return { valid: false, errors };
}

/**
 * Lightweight fallback validator used when Ajv is not installed.
 *
 * - Supports:
 *   • object type check
 *   • "required" property presence
 *
 * @param {object} schema
 * @param {any} data
 * @returns {ValidationResult}
 */
function validateWithFallback(schema, data) {
  /** @type {ValidationErrorDetail[]} */
  const errors = [];

  if (schema.type === "object" && typeof data !== "object") {
    errors.push({
      path: "",
      message: "Expected object input/output",
      keyword: "type",
    });
    return { valid: false, errors };
  }

  if (
    schema.type === "object" &&
    Array.isArray(schema.required) &&
    typeof data === "object" &&
    data !== null
  ) {
    for (const prop of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(data, prop)) {
        errors.push({
          path: `/${prop}`,
          message: `Missing required property '${prop}'`,
          keyword: "required",
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/** ------------------------------------------------------------------------
 *  Events
 * --------------------------------------------------------------------- */

/**
 * Emit validation events for analytics / Stability dashboards.
 *
 * Types:
 *   - calculator.validation.input
 *   - calculator.validation.output
 *
 * Payload:
 *   {
 *     calculatorId,
 *     kind: "input" | "output",
 *     valid: boolean,
 *     errorCount: number,
 *   }
 *
 * @param {string} calculatorId
 * @param {"input"|"output"} kind
 * @param {ValidationResult} result
 */
function emitValidationEvent(calculatorId, kind, result) {
  if (!calculatorId) return;

  const payload = {
    type:
      kind === "input"
        ? "calculator.validation.input"
        : "calculator.validation.output",
    ts: new Date().toISOString(),
    source: "calculator.validation",
    data: {
      calculatorId,
      kind,
      valid: !!result.valid,
      errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
    },
  };

  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(payload);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[calculatorValidation] Failed to emit validation event",
      payload,
      err
    );
  }
}

/** ------------------------------------------------------------------------
 *  Utils
 * --------------------------------------------------------------------- */

/**
 * Normalize Ajv paths (which may be "" or "/prop") into a consistent
 * pointer-ish style.
 *
 * @param {string} path
 */
function normalizeAjvPath(path) {
  if (!path) return "";
  if (path.startsWith(".")) {
    // Data path style ".prop[0].name"
    return "/" + path.replace(/^\./, "").replace(/\./g, "/");
  }
  // Already pointer-style "/prop/0/name"
  return path;
}

/**
 * Build a cache key for validators.
 *
 * @param {string} calculatorId
 * @param {"input"|"output"} kind
 */
function makeValidatorKey(calculatorId, kind) {
  return `${calculatorId}::${kind}`;
}

export default {
  registerCalculatorSchemas,
  getCalculatorSchemas,
  validateCalculatorInput,
  validateCalculatorOutput,
  ensureValidCalculatorInputOrThrow,
  ensureValidCalculatorOutputOrThrow,
};
