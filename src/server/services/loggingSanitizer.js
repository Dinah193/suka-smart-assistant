"use strict";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-auth-token",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "session",
  "password",
  "secret",
  "api_key",
  "apikey",
]);

const SENSITIVE_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
  /(x-auth-token\s*[:=]\s*)[^\s,;]+/gi,
  /(cookie\s*[:=]\s*)[^\n\r]+/gi,
  /((?:^|\s)(?:token|access_token|refresh_token|id_token|api_key|apikey|password|secret)\s*=\s*)[^\s,;]+/gi,
  /([?&](?:token|access_token|refresh_token|id_token|api_key|apikey|password|secret)=)[^&\s]+/gi,
];

function redactValue(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length <= 6) return "[REDACTED]";
    return `${value.slice(0, 2)}...[REDACTED]`;
  }
  if (Array.isArray(value)) return value.map(() => "[REDACTED]");
  return "[REDACTED]";
}

function redactObject(input) {
  if (!input || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => redactObject(item));
  }

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) {
      out[key] = redactValue(value);
      continue;
    }
    if (value && typeof value === "object") {
      out[key] = redactObject(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function redactText(text) {
  let out = String(text || "");
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, "$1[REDACTED]");
  }
  return out;
}

module.exports = {
  redactObject,
  redactText,
};
