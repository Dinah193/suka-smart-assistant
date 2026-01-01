// src/automation/validate.js
import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, removeAdditional: "failing" });

export function validate(schema, data) {
  const fn = ajv.compile(schema);
  const ok = fn(data);
  if (!ok) {
    const msg = fn.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    const err = new Error(`Payload validation failed: ${msg || "unknown error"}`);
    err.details = fn.errors;
    throw err;
  }
  return true;
}
