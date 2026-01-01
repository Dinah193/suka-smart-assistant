// src/services/ingest/UploadIngestService.js
// -----------------------------------------------------------------------------
// UploadIngestService
// -----------------------------------------------------------------------------
// L0 artifact creation entry point.
// Accepts payload: { text | url | json | fileMeta }
// - Determines sourceType
// - Creates fingerprint (dedupe)
// - Stores record in db.artifacts
// - Emits event: import.created
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import { db } from "@/services/db";
import { emit } from "@/services/events/eventBus";
import { makeFingerprint } from "@/services/ingest/fingerprint";

function nowIso() {
  return new Date().toISOString();
}

function str(x) {
  return String(x || "").trim();
}

function inferDomainHint({ domainHint, text, url, json } = {}) {
  const hint = str(domainHint);
  if (hint) return hint;

  const t = String(text || url || "");
  const low = t.toLowerCase();

  if (low.includes("clean") || low.includes("laundry") || low.includes("vacuum")) return "cleaning";
  if (low.includes("cook") || low.includes("recipe") || low.includes("bake") || low.includes("saute")) return "cooking";
  if (low.includes("garden") || low.includes("plant") || low.includes("seed") || low.includes("harvest")) return "garden";
  if (low.includes("animal") || low.includes("goat") || low.includes("chicken") || low.includes("sheep")) return "animals";
  if (low.includes("pantry") || low.includes("storehouse") || low.includes("restock") || low.includes("inventory")) return "storehouse";
  if (json && typeof json === "object") {
    if (json.domain) return str(json.domain);
  }
  return "unknown";
}

async function findExistingByFingerprint({ fingerprint, householdId } = {}) {
  if (!fingerprint) return null;
  if (!db?.artifacts) return null;

  try {
    // If householdId provided, restrict to household scope where possible.
    // We have [kind+fingerprint] and fingerprint as index in schema (see db.js).
    // Prefer exact match by fingerprint; then filter by householdId.
    const rows = await db.artifacts.where("fingerprint").equals(fingerprint).toArray();
    if (!rows?.length) return null;

    if (householdId) {
      const match = rows.find((r) => str(r.householdId) === str(householdId));
      return match || null;
    }

    // fallback: return most recent
    rows.sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));
    return rows[0] || null;
  } catch (e) {
    return null;
  }
}

export const UploadIngestService = {
  /**
   * Create an artifact (L0).
   *
   * @param {Object} payload
   * @param {string} payload.text
   * @param {string} payload.url
   * @param {Object} payload.json
   * @param {Object} payload.fileMeta
   * @param {string} payload.domainHint
   * @param {string} payload.source
   * @param {string} payload.householdId
   * @param {string} payload.userId
   * @param {boolean} payload.dedupe
   */
  async createArtifact(payload = {}) {
    if (!db?.artifacts) {
      throw new Error("Dexie db.artifacts table not available. Verify schema v12+.");
    }

    const {
      text,
      url,
      json,
      fileMeta,
      domainHint,
      source = "upload",
      householdId,
      userId,
      dedupe = true,
      meta = {},
    } = payload;

    const { fingerprint, kind } = await makeFingerprint({ text, url, json, fileMeta });

    const inferredDomain = inferDomainHint({ domainHint, text, url, json });

    if (dedupe) {
      const existing = await findExistingByFingerprint({ fingerprint, householdId });
      if (existing?.id) {
        // Emit created event anyway so automation can continue.
        emit("import.created", {
          artifactId: existing.id,
          domainHint: inferredDomain,
          fingerprint,
          deduped: true,
          source,
          householdId,
          userId,
          ts: nowIso(),
        });
        return { artifactId: existing.id, fingerprint, deduped: true };
      }
    }

    const createdAt = nowIso();
    const record = {
      kind,
      domain: inferredDomain,
      source,
      fingerprint,
      createdAt,
      updatedAt: createdAt,
      status: "created",
      householdId: householdId || null,
      userId: userId || null,
      payload: {
        text: text || null,
        url: url || null,
        json: json || null,
        fileMeta: fileMeta || null,
      },
      meta: meta || {},
    };

    const artifactId = await db.artifacts.add(record);

    emit("import.created", {
      artifactId,
      domainHint: inferredDomain,
      fingerprint,
      deduped: false,
      source,
      householdId,
      userId,
      ts: createdAt,
    });

    return { artifactId, fingerprint, deduped: false };
  },
};

export default UploadIngestService;
