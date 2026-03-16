// C:\Users\larho\suka-smart-assistant\src\contracts\validators\validateControlMessage.js
/**
 * validateControlMessage.js — Dev-only validator for remote/control envelopes
 *
 * Where this fits in SSA:
 * - SSA pipeline: imports → intelligence → automation → (optional) hub export.
 * - This module guards the automation/execution layer by validating control
 *   envelopes (step.next, step.go, timer.toggle, etc.) before they hit players.
 * - It DOES NOT mutate household data and DOES NOT export to the Hub.
 *
 * What it validates against:
 * - src/contracts/control.message.contract.json (draft-07 schema)
 *
 * Design goals:
 * - Helpful error messages (JSON Pointer locations, keyword hints).
 * - Soft dependency on Ajv (dev). If Ajv isn't present, fall back to
 *   lightweight structural checks so builds never crash.
 * - Emits standardized dev telemetry on the shared eventBus:
 *   { type, ts, source, data } with ISO timestamps.
 *
 * Public API:
 *   • validateControlMessage(payload, opts) -> { ok, errors?[], warnings?[] }
 *   • assertValidControlMessage(payload, opts) -> throws Error on invalid
 */

let eventBus = {
  emit: (...a) => console.debug("[validators:control:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

const nowISO = () => new Date().toISOString();
function emit(type, data = {}) {
  try {
    eventBus.emit({
      type,
      ts: nowISO(),
      source: "contracts.validators.control",
      data,
    });
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* Load contract schema                                                       */
/* -------------------------------------------------------------------------- */
let CONTRACT_SCHEMA = null;
try {
  CONTRACT_SCHEMA = require("@/contracts/control.message.contract.json");
} catch (err) {
  console.error(
    "[validateControlMessage] failed to load control contract schema:",
    err?.message || err
  );
}

/* -------------------------------------------------------------------------- */
/* Optional Ajv (dev dependency)                                              */
/* -------------------------------------------------------------------------- */
let Ajv = null;
try {
  Ajv = require("ajv"); // v6+ works for draft-07 in most setups
} catch {
  // Ajv not installed — we'll degrade gracefully
}

/* -------------------------------------------------------------------------- */
/* Pretty error formatter                                                     */
/* -------------------------------------------------------------------------- */
function toPointer(instancePath, dataPath /* Ajv v6 */) {
  if (typeof instancePath === "string" && instancePath.length)
    return instancePath;
  if (typeof dataPath === "string" && dataPath.length) return dataPath;
  return "";
}

function formatAjvErrors(errors = []) {
  if (!Array.isArray(errors) || !errors.length) return [];
  return errors.map((e) => {
    const ptr = toPointer(e.instancePath, e.dataPath) || "(root)";
    const kw = e.keyword ? `[${e.keyword}]` : "";
    const msg = e.message || "invalid";
    const params = e.params ? JSON.stringify(e.params) : "";
    const schema = e.schemaPath ? `schema: ${e.schemaPath}` : "";
    return `${kw} ${ptr} ${msg}${params ? " " + params : ""}${
      schema ? " — " + schema : ""
    }`;
  });
}

function preview(obj, max = 220) {
  try {
    const s = JSON.stringify(obj, (k, v) =>
      typeof v === "string" && v.length > 140 ? v.slice(0, 140) + "…" : v
    );
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(obj);
  }
}

/* -------------------------------------------------------------------------- */
/* Lightweight fallback checks                                                */
/* -------------------------------------------------------------------------- */
const ALLOWED_TYPES = new Set([
  "control.step.next",
  "control.step.prev",
  "control.step.go",
  "control.timer.start",
  "control.timer.pause",
  "control.timer.resume",
  "control.timer.cancel",
  "control.timer.toggle",
  "control.keepAwake",
  "control.speech.say",
  "control.speech.toggle",
  "control.overlay.toggle",
  "control.state.requestSync",
  "control.play.pause",
  "control.play.resume",
  "control.play.stop",
]);

function minimalEnvelopeCheck(p) {
  const errs = [];
  if (!p || typeof p !== "object") {
    errs.push("Payload must be an object.");
    return errs;
  }
  if (typeof p.type !== "string" || !ALLOWED_TYPES.has(p.type)) {
    errs.push("Missing or invalid 'type' (one of control.*).");
  }
  if (typeof p.ts !== "string")
    errs.push("Missing or invalid 'ts' (ISO string).");
  if (typeof p.source !== "string" || !p.source)
    errs.push("Missing or invalid 'source' (non-empty string).");
  if (!p.data || typeof p.data !== "object")
    errs.push("Missing or invalid 'data' (object).");

  // Common fields are expected in every control message's data
  if (p.data && typeof p.data === "object") {
    if (typeof p.data.domain !== "string")
      errs.push(
        "data.domain is required (cooking|cleaning|garden|animals|preservation|storehouse)."
      );
    if (typeof p.data.sessionId !== "string" || !p.data.sessionId)
      errs.push("data.sessionId is required (string).");

    // Type-specific minimal sanity (very light; Ajv handles full logic)
    if (
      p.type === "control.step.go" &&
      !(Number.isInteger(p.data.stepIndex) && p.data.stepIndex >= 0)
    ) {
      errs.push("control.step.go requires integer data.stepIndex ≥ 0.");
    }
    if (p.type === "control.timer.start") {
      if (typeof p.data.timerId !== "string" || !p.data.timerId)
        errs.push("control.timer.start requires data.timerId.");
      if (!(Number.isInteger(p.data.durationMs) && p.data.durationMs >= 0))
        errs.push("control.timer.start requires integer data.durationMs ≥ 0.");
    }
    if (p.type === "control.timer.toggle") {
      const actionOk = ["start", "pause", "resume", "cancel"].includes(
        p.data.action
      );
      if (!actionOk)
        errs.push(
          "control.timer.toggle requires data.action in {start,pause,resume,cancel}."
        );
      if (
        p.data.action === "start" &&
        !(Number.isInteger(p.data.durationMs) && p.data.durationMs >= 0)
      ) {
        errs.push(
          "control.timer.toggle with action=start requires integer data.durationMs ≥ 0."
        );
      }
      if (typeof p.data.timerId !== "string" || !p.data.timerId)
        errs.push("control.timer.toggle requires data.timerId (string).");
    }
    if (p.type === "control.keepAwake" && typeof p.data.on !== "boolean") {
      errs.push("control.keepAwake requires boolean data.on.");
    }
    if (
      p.type === "control.speech.say" &&
      (typeof p.data.text !== "string" || !p.data.text)
    ) {
      errs.push("control.speech.say requires non-empty data.text (string).");
    }
    if (
      p.type === "control.speech.toggle" &&
      typeof p.data.enabled !== "boolean"
    ) {
      errs.push("control.speech.toggle requires boolean data.enabled.");
    }
    if (
      p.type === "control.overlay.toggle" &&
      typeof p.data.enabled !== "boolean"
    ) {
      errs.push("control.overlay.toggle requires boolean data.enabled.");
    }
  }
  return errs;
}

/* -------------------------------------------------------------------------- */
/* Build Ajv validator if available                                           */
/* -------------------------------------------------------------------------- */
let validateFn = null;
let ajvWarnings = [];

function buildAjvValidator() {
  if (!Ajv || !CONTRACT_SCHEMA) return null;

  try {
    const ajv = new Ajv({
      allErrors: true,
      jsonPointers: true, // Ajv v6
      schemaId: "auto",
      $data: true,
      removeAdditional: false,
      useDefaults: false,
      coerceTypes: false,
      verbose: false,
    });

    const compiled = ajv.compile(CONTRACT_SCHEMA);
    return (data) => {
      const ok = compiled(data) === true;
      return { ok, errors: ok ? [] : compiled.errors || [] };
    };
  } catch (err) {
    ajvWarnings.push(
      `[validateControlMessage] Ajv compile failed: ${err?.message || err}`
    );
    return null;
  }
}

validateFn = buildAjvValidator();

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */
/**
 * Validate a control.* envelope against the contract.
 *
 * @param {any} payload
 * @param {{ strict?: boolean, throwOnError?: boolean, logOk?: boolean }} [opts]
 * @returns {{ ok: boolean, errors?: string[], warnings?: string[] }}
 */
function validateControlMessage(payload, opts = {}) {
  const strict = opts.strict !== false; // default true
  const throwOnError = opts.throwOnError !== false; // default true
  const logOk = !!opts.logOk;

  const warnings = [...ajvWarnings];

  if (!CONTRACT_SCHEMA) {
    warnings.push(
      "Control contract schema not loaded. Ensure @/contracts/control.message.contract.json exists."
    );
  }

  if (validateFn) {
    const { ok, errors } = validateFn(payload);
    if (ok) {
      if (logOk) emit("dev.validate.control.ok", { preview: preview(payload) });
      return { ok: true, warnings };
    }
    const friendly = formatAjvErrors(errors);
    emit("dev.validate.control.fail", {
      count: friendly.length,
      errors: friendly.slice(0, 6),
      preview: preview(payload),
    });
    if (strict && throwOnError) {
      const err = new Error(
        buildHelpfulMessage("control.*", friendly, payload)
      );
      err.name = "ControlContractError";
      throw err;
    }
    return { ok: false, errors: friendly, warnings };
  }

  // Fallback — minimal checks only
  warnings.push(
    "Ajv not found; using minimal envelope checks (dev). Install 'ajv' for full validation."
  );
  const basicErrors = minimalEnvelopeCheck(payload);
  if (basicErrors.length) {
    emit("dev.validate.control.fail", {
      count: basicErrors.length,
      errors: basicErrors,
      preview: preview(payload),
    });
    if (strict && throwOnError) {
      const err = new Error(
        buildHelpfulMessage("control.*", basicErrors, payload)
      );
      err.name = "ControlContractError";
      throw err;
    }
    return { ok: false, errors: basicErrors, warnings };
  }

  if (logOk) emit("dev.validate.control.ok", { preview: preview(payload) });
  return { ok: true, warnings };
}

/**
 * Assert variant — throws if invalid.
 * @param {any} payload
 * @param {{ strict?: boolean }} [opts]
 */
function assertValidControlMessage(payload, opts = {}) {
  return validateControlMessage(payload, { ...opts, throwOnError: true });
}

/* -------------------------------------------------------------------------- */
/* Error message helper                                                       */
/* -------------------------------------------------------------------------- */
function buildHelpfulMessage(contractName, errors, payload) {
  const list = (errors || []).map((e, i) => `  ${i + 1}. ${e}`).join("\n");
  const hint =
    "- Ensure 'type' is one of control.step.*, control.timer.*, control.keepAwake, control.speech.*, control.overlay.toggle, control.state.requestSync, control.play.*\n" +
    "- All messages require data.domain and data.sessionId\n" +
    "- control.step.go → data.stepIndex (integer ≥ 0)\n" +
    "- control.timer.start → data.timerId (string), data.durationMs (ms ≥ 0)\n" +
    "- control.timer.toggle → data.action in {start,pause,resume,cancel}, and durationMs when action=start\n" +
    "- control.keepAwake → data.on (boolean)\n" +
    "- control.speech.say → data.text (string)\n" +
    "- See src/contracts/control.message.contract.json for exact shapes";
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
  validateControlMessage,
  assertValidControlMessage,
};
