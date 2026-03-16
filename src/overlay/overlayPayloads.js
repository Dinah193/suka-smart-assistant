function isObject(value) {
  return value !== null && typeof value === "object";
}

function cloneValue(value) {
  if (!isObject(value)) return value;
  if (Array.isArray(value)) return value.map(cloneValue);

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = cloneValue(val);
  }
  return out;
}

function parsePath(path) {
  return String(path || "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

function setAtPath(root, path, replacement) {
  const parts = parsePath(path);
  if (!parts.length) return;

  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!isObject(cur) || !(key in cur)) return;
    cur = cur[key];
  }

  const last = parts[parts.length - 1];
  if (!isObject(cur) || !(last in cur)) return;
  cur[last] = replacement;
}

function normalizeRedaction(redaction) {
  if (typeof redaction === "string" && redaction.length > 0) return redaction;
  return "[redacted]";
}

function normalizeScrubFields(scrubFields) {
  if (!Array.isArray(scrubFields)) return [];
  return scrubFields
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

export function applyStreamerSafeScrub(payload, scrubFields = [], redaction) {
  const safePayload = cloneValue(payload || {});
  const enabled = !!safePayload?.data?.streamerSafe;
  if (!enabled) return safePayload;

  const fields = normalizeScrubFields(scrubFields);
  if (!fields.length) return safePayload;

  const token = normalizeRedaction(redaction);
  for (const field of fields) {
    setAtPath(safePayload.data, field, token);
  }

  return safePayload;
}

export default {
  applyStreamerSafeScrub,
};
