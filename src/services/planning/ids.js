// src/services/planning/ids.js
/* eslint-disable no-console */

/**
 * Stable IDs for planning acceptance.
 * ---------------------------------------------------------------------------
 * Why this exists:
 * - Accepting a plan must be idempotent (safe to run multiple times).
 * - We generate deterministic IDs for occurrences, sessions, and calendar events
 *   so upserts don't duplicate data.
 *
 * Design:
 * - Uses a small deterministic hash (FNV-1a 32-bit) over canonical strings.
 * - IDs are versioned with a prefix so we can evolve formats later.
 */

const ID_VERSION = "v1";

/** FNV-1a 32-bit hash -> base36 string */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (but keep 32-bit)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/** Stable stringify with sorted keys (handles primitives/arrays/objects) */
export function stableStringify(value) {
  const seen = new WeakSet();

  function _stringify(v) {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "undefined") return "undefined";
    if (t === "number" || t === "boolean") return String(v);
    if (t === "string") return JSON.stringify(v);
    if (t === "bigint") return `"${String(v)}n"`;
    if (t === "function") return `"__fn__"`;
    if (t !== "object") return JSON.stringify(String(v));

    if (seen.has(v)) return `"__cycle__"`;
    seen.add(v);

    if (Array.isArray(v)) {
      return `[${v.map(_stringify).join(",")}]`;
    }

    const keys = Object.keys(v).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${_stringify(v[k])}`);
    return `{${parts.join(",")}}`;
  }

  return _stringify(value);
}

export function makeId(prefix, ...parts) {
  const canonical = parts
    .map((p) => (typeof p === "string" ? p : stableStringify(p)))
    .join("|");
  return `${prefix}_${ID_VERSION}_${fnv1a32(canonical)}`;
}

/**
 * Plan-level stable key. Tries to prefer plan.id if present, otherwise hashes plan content.
 */
export function planKey(domain, plan) {
  const planId = plan?.id || plan?.planId || plan?.key;
  if (planId) return String(planId);
  return makeId("plan", domain, plan);
}

/**
 * Occurrence-level stable id. Uses planKey + occurrence "identity" fields.
 * Prefer occurrence.startAt/endAt/title if available, else full object hash.
 */
export function occurrenceId(domain, plan, occurrence) {
  const pk = planKey(domain, plan);
  const startAt =
    occurrence?.startAt || occurrence?.start || occurrence?.when?.startAt;
  const endAt = occurrence?.endAt || occurrence?.end || occurrence?.when?.endAt;
  const title = occurrence?.title || occurrence?.name || occurrence?.label;

  if (startAt || endAt || title) {
    return makeId(
      "occ",
      domain,
      pk,
      String(startAt || ""),
      String(endAt || ""),
      String(title || "")
    );
  }

  return makeId("occ", domain, pk, occurrence);
}

export function sessionId(domain, occurrence) {
  // Sessions are keyed primarily by occurrence identity.
  // If you later want multiple sessions per occurrence, add a "slot" argument.
  const occId =
    occurrence?.id ||
    occurrenceId(domain, { id: occurrence?.planId }, occurrence);
  return makeId("sess", domain, occId);
}

export function calendarEventId(domain, occurrence, slot = "default") {
  const occId =
    occurrence?.id ||
    occurrenceId(domain, { id: occurrence?.planId }, occurrence);
  return makeId("cal", domain, occId, slot);
}
