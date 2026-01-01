// src/services/planning/normalizeOccurrence.js
/* eslint-disable no-console */

import { occurrenceId, planKey } from "./ids.js";

/**
 * normalizeOccurrence(domain, plan, occurrence)
 * ---------------------------------------------------------------------------
 * Purpose:
 * - Coerce occurrences from any domain adapter into a consistent shape.
 * - Ensure stable IDs exist (for idempotent upserts).
 *
 * Output shape (minimum):
 * {
 *   id, domain, planId,
 *   startAt, endAt,
 *   title,
 *   meta: {...},
 *   source: { adapter, rawKey? }
 * }
 */

function isoOrNull(v) {
  if (!v) return null;
  // If it already looks ISO-ish, keep it.
  if (typeof v === "string") return v;
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

export function normalizeOccurrence(
  domain,
  plan,
  rawOccurrence,
  adapterName = "unknown"
) {
  if (!domain || typeof domain !== "string") {
    throw new Error("normalizeOccurrence: domain is required (string)");
  }
  if (!rawOccurrence || typeof rawOccurrence !== "object") {
    throw new Error("normalizeOccurrence: occurrence must be an object");
  }

  const planId = planKey(domain, plan);

  const startAt =
    isoOrNull(rawOccurrence.startAt) ||
    isoOrNull(rawOccurrence.start) ||
    isoOrNull(rawOccurrence.when?.startAt) ||
    isoOrNull(rawOccurrence.when?.start);

  const endAt =
    isoOrNull(rawOccurrence.endAt) ||
    isoOrNull(rawOccurrence.end) ||
    isoOrNull(rawOccurrence.when?.endAt) ||
    isoOrNull(rawOccurrence.when?.end);

  const title =
    rawOccurrence.title ||
    rawOccurrence.name ||
    rawOccurrence.label ||
    rawOccurrence.summary ||
    `${domain} occurrence`;

  const normalized = {
    id:
      rawOccurrence.id ||
      occurrenceId(domain, plan, { ...rawOccurrence, startAt, endAt, title }),
    domain,
    planId,
    startAt,
    endAt,
    title,
    meta: {
      priority: rawOccurrence.priority ?? null,
      tags: Array.isArray(rawOccurrence.tags) ? rawOccurrence.tags : [],
      location: rawOccurrence.location ?? null,
      notes: rawOccurrence.notes ?? null,
      // keep anything else in a nested rawMeta bucket
      rawMeta: rawOccurrence.meta ?? null,
    },
    source: {
      adapter: adapterName,
      rawKey: rawOccurrence.key || rawOccurrence.rawKey || null,
    },
    raw: rawOccurrence, // keep raw for debugging / future intelligence extraction
  };

  return normalized;
}
