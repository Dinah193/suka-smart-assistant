// C:\Users\larho\suka-smart-assistant\src\contracts\validators\validateSessionPlay.js
/**
 * validateSessionPlay.js — Dev-only validator for session.play.* envelopes
 *
 * Where this fits in SSA:
 * - SSA pipeline: imports → intelligence → automation → (optional) hub export.
 * - This utility guards the "automation/execution" layer by validating that any
 *   eventBus envelope for session playback strictly conforms to the contract
 *   defined in src/contracts/session.play.contract.json.
 * - It DOES NOT mutate household data and does NOT export to the Hub.
 *
 * Design goals:
 * - Draft-07 compatible (matches the contract we generated for editors like VS Code).
 * - Helpful, human-readable errors with JSON Pointers, offending values, and hints.
 * - Defensive "soft import": if Ajv is missing in production builds, we degrade to
 *   a minimal structural check and log a warning rather than crash.
 * - Small API surface:
 *     • validateSessionPlay(payload, opts) → { ok, errors?[], warnings?[] }
 *     • assertValidSessionPlay(payload, opts) → throws Error with pretty message
 * - Emits standardized dev telemetry on eventBus: { type, ts, source, data }.
 */

let eventBus = {
  emit: (...a) => console.debug("[validators:sessionPlay:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

const nowISO = () => new Date().toISOString();
function emit(type, data = {}) {
  try {
    eventBus.emit({ type, ts: nowISO(), source: "contracts.validators.sessionPlay", data });
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* Load schema (draft-07)                                                     */
/* -------------------------------------------------------------------------- */
let CONTRACT_SCHEMA = null;
try {
  CONTRACT_SCHEMA = require("@/contracts/session.play.contract.json");
} catch (err) {
  console.error("[validateSessionPlay] failed to load contract schema:", err?.message || err);
}

/* -------------------------------------------------------------------------- */
/* Optional Ajv (dev dependency)                                              */
/* -------------------------------------------------------------------------- */
let Ajv = null;
try {
  Ajv = require("ajv"); // expect v6/v8 compatible instantiation for draft-07
} catch {
  // no-op: we'll fall back to a lightweight checker
}

/* -------------------------------------------------------------------------- */
/* Pretty error formatter                                                     */
/* -------------------------------------------------------------------------- */
function toPointer(instancePath, dataPath/* Ajv v6 */) {
  // Ajv v8 uses instancePath, v6 uses dataPath
  if (typeof instancePath === "string" && instancePath.length) return instancePath;
  if (typeof dataPath === "string" && dataPath.length) return dataPath;
  return "";
}

/**
 * Produce developer-friendly messages from Ajv errors.
 */
function formatAjvErrors(errors = [], payloadSnippet = "") {
  if (!Array.isArray(errors) || !errors.length) return [];
  return errors.map((e) => {
    const pointer = toPointer(e.instancePath, e.dataPath);
    const loc = pointer || "(root)";
    const keyword = e.keyword ? `[${e.keyword}]` : "";
    const msg = e.message || "invalid";
    const params = e.params ? JSON.stringify(e.params) : "";
    const detail = e.schemaPath ? `schema: ${e.schemaPath}` : "";
    return `${keyword} ${loc} ${msg}${params ? " " + params : ""}${detail ? " — " + detail : ""}`;
  });
}

/**
 * Trim and stringify a compact preview of the payload for error messages.
 */
function preview(obj, max = 220) {
  try {
    const s = JSON.stringify(obj, (k, v) => (typeof v === "string" && v.length > 140 ? v.slice(0, 140) + "…" : v));
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(obj);
  }
}

/* -------------------------------------------------------------------------- */
/* Lightweight fallback validator (no Ajv)                                    */
/* -------------------------------------------------------------------------- */
function minimalEnvelopeCheck(p) {
  const errs = [];
  if (!p || typeof p !== "object") {
    errs.push("Payload must be an object.");
    return errs;
  }
  if (typeof p.type !== "string") errs.push("Missing or invalid 'type' (string).");
  if (typeof p.ts !== "string") errs.push("Missing or invalid 'ts' (ISO string).");
  if (typeof p.source !== "string" || !p.source) errs.push("Missing or invalid 'source' (non-empty string).");
  if (!p.data || typeof p.data !== "object") errs.push("Missing or invalid 'data' (object).");
  return errs;
}

/* -------------------------------------------------------------------------- */
/* Validator factory                                                          */
/* -------------------------------------------------------------------------- */
let validateFn = null;
let ajvWarnings = [];

function buildAjvValidator() {
  if (!Ajv || !CONTRACT_SCHEMA) return null;

  try {
    // Ajv v6 constructor
    const ajv = new Ajv({
      allErrors: true,
      jsonPointers: true, // for v6 to populate dataPath
      schemaId: "auto",   // tolerate draft-07 $id
      $data: true,
      removeAdditional: false,
      useDefaults: false,
      coerceTypes: false,
      verbose: false,
    });

    // Some environments may also ship ajv-formats; we keep formats minimal (date-time).
    // Ajv v6 already understands "date-time" without extra plugin.

    const compiled = ajv.compile(CONTRACT_SCHEMA);
    return (data) => {
      const ok = compiled(data) === true;
      return {
        ok,
        errors: ok ? [] : (compiled.errors || []),
      };
    };
  } catch (err) {
    ajvWarnings.push(`[validateSessionPlay] Ajv compile failed: ${err?.message || err}`);
    return null;
  }
}

/* Build the validator (if Ajv available) */
validateFn = buildAjvValidator();

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */
/**
 * Validate a session.play.* envelope.
 *
 * @param {any} payload - The event envelope to validate.
 * @param {{strict?: boolean, throwOnError?: boolean, logOk?: boolean}} [opts]
 * @returns {{ ok: boolean, errors?: string[], warnings?: string[] }}
 */
function validateSessionPlay(payload, opts = {}) {
  const strict = opts.strict !== false; // default true
  const throwOnError = opts.throwOnError !== false; // default true
  const logOk = !!opts.logOk;

  const warnings = [...ajvWarnings];

  if (!CONTRACT_SCHEMA) {
    const msg = "Contract schema not loaded. Ensure @/contracts/session.play.contract.json exists.";
    warnings.push(msg);
  }

  // Try Ajv
  if (validateFn) {
    const { ok, errors } = validateFn(payload);
    if (ok) {
      if (logOk) emit("dev.validate.sessionPlay.ok", { preview: preview(payload) });
      return { ok: true, warnings };
    }
    // Convert Ajv errors → strings
    const friendly = formatAjvErrors(errors, preview(payload));
    const summary = {
      ok: false,
      errors: friendly,
      warnings,
    };
    emit("dev.validate.sessionPlay.fail", {
      count: friendly.length,
      errors: friendly.slice(0, 6),
      preview: preview(payload),
    });
    if (strict && throwOnError) {
      const err = new Error(buildHelpfulMessage("session.play.*", friendly, payload));
      err.name = "SessionPlayContractError";
      throw err;
    }
    return summary;
  }

  // Fallback: minimal checks only
  warnings.push("Ajv not found; using minimal envelope check (dev). Install 'ajv' for full validation.");
  const basicErrors = minimalEnvelopeCheck(payload);
  if (basicErrors.length) {
    const friendly = basicErrors;
    const summary = { ok: false, errors: friendly, warnings };
    emit("dev.validate.sessionPlay.fail", { count: friendly.length, errors: friendly, preview: preview(payload) });
    if (strict && throwOnError) {
      const err = new Error(buildHelpfulMessage("session.play.*", friendly, payload));
      err.name = "SessionPlayContractError";
      throw err;
    }
    return summary;
  }

  if (logOk) emit("dev.validate.sessionPlay.ok", { preview: preview(payload) });
  return { ok: true, warnings };
}

/**
 * Assert variant — throws with a helpful multi-line error if invalid.
 *
 * @param {any} payload
 * @param {{strict?: boolean}} [opts]
 */
function assertValidSessionPlay(payload, opts = {}) {
  return validateSessionPlay(payload, { ...opts, throwOnError: true });
}

/* -------------------------------------------------------------------------- */
/* Error message helper                                                       */
/* -------------------------------------------------------------------------- */
function buildHelpfulMessage(contractName, errors, payload) {
  const list = (errors || []).map((e, i) => `  ${i + 1}. ${e}`).join("\n");
  const hint =
    "- Double-check 'type' matches a contract event (e.g., session.play.start)\n" +
    "- Ensure 'data' includes { domain, sessionId } for all session.play.* events\n" +
    "- For step.go, include data.stepIndex (integer ≥ 0)\n" +
    "- For timer.start, include data.timerId and data.durationMs (ms ≥ 0)\n" +
    "- See src/contracts/session.play.contract.json for exact shapes.";
  return [
    `Invalid ${contractName} payload.`,
    "",
    "Errors:",
    list || "  (no details)",
    "",
    "Payload preview:",
    `  ${preview(payload)}`,
    "",
    "Hints:",
    `  ${hint}`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */
module.exports = {
  validateSessionPlay,
  assertValidSessionPlay,
};
