// ============================================================
// v12 — Layer Spine tables (artifacts → parsed → method map → blueprint → overrides)
// IMPORTANT:
// - Dexie requires EACH version().stores({...}) to include ALL tables for that version.
// - We auto-derive the complete v11 stores spec from Dexie’s internal schema,
//   then extend it with the new layer tables.
//
// SSA Convention:
// - The actual Dexie instance lives in src/services/db.js
// - This file is the canonical export surface for app-wide imports ("@/db")
//   and the place where we extend schema versions safely.
// ============================================================

import db from "./services/db.js";

function buildStoresSpecFromDbSchema(dbSchema) {
  // Dexie internal schema object format:
  // dbSchema = { tableName: TableSchema, ... }
  // TableSchema: { name, primKey: { src }, indexes: [{ src }, ...] }
  const out = {};
  if (!dbSchema) return out;

  for (const [tableName, tableSchema] of Object.entries(dbSchema)) {
    const prim = tableSchema?.primKey?.src ? [tableSchema.primKey.src] : [];
    const idx = Array.isArray(tableSchema?.indexes)
      ? tableSchema.indexes.map((i) => i?.src).filter(Boolean)
      : [];

    // Stores() string is: "primKey, index1, index2, ..."
    // Example: "++id, domain, [domain+createdAt]"
    out[tableName] = [...prim, ...idx].join(", ");
  }

  return out;
}

// NOTE: This must execute AFTER version(11).stores(...) has already been declared.
// We derive the existing stores spec from Dexie’s in-memory schema, then extend.
const STORES_V11 = buildStoresSpecFromDbSchema(db?._dbSchema);

// 2) Add the new Layer Spine tables
const LAYER_SPINE_STORES = {
  // L0 — raw uploads / captures / quick-add payloads (normalized)
  // fingerprint lets you dedupe identical inputs
  artifacts:
    "++id, kind, domain, source, fingerprint, createdAt, updatedAt, status, sessionId, [kind+fingerprint], [domain+createdAt], [domain+status]",

  // L1 — parser outputs (extracted fields, candidates, structured notes)
  parsed_candidates:
    "++id, artifactId, domain, parser, fingerprint, createdAt, updatedAt, status, [artifactId+parser], [domain+createdAt], [domain+status]",

  // L2 — method/template matches (“fixed methods” library matches)
  method_maps:
    "++id, artifactId, candidateId, domain, methodKey, confidence, createdAt, updatedAt, status, [domain+methodKey], [candidateId+methodKey], [domain+status]",

  // L3 — runnable session blueprint produced from method map + candidate + user context
  blueprints:
    "++id, domain, blueprintKey, createdAt, updatedAt, artifactId, candidateId, methodMapId, sessionId, status, [domain+createdAt], [domain+status], [domain+blueprintKey]",

  // Overrides — household/user fixed-method preferences + pinning
  // scope: 'user' | 'household'
  // scopeId: userId/householdId
  layer_overrides:
    "++id, scope, scopeId, domain, methodKey, createdAt, updatedAt, isActive, [scope+scopeId], [domain+methodKey], [scope+scopeId+domain], [scope+scopeId+domain+methodKey]",

  // OPTIONAL — fast reparse avoidance (fingerprint → cached parse payload)
  // fingerprint is the primary key, so lookups are O(1)
  parse_cache: "fingerprint, createdAt, updatedAt, domain",
};

// 3) v12 schema = v11 schema + new tables
db.version(12)
  .stores({
    ...STORES_V11,
    ...LAYER_SPINE_STORES,
  })
  .upgrade(async (tx) => {
    // ✅ Safe, non-destructive migration.
    // New tables will be created automatically.
    // Keep this hook for future backfills.
    // Optional future pattern (DO NOT run now unless you decide you want it):
    // - Backfill artifacts from any legacy "quick add" table
    // - Populate parse_cache for recently used artifacts
    // For now: no-op is correct.
  });

// Canonical exports:
// - Named export supports: import { db } from "@/db"
// - Default export supports legacy: import db from "@/db"
export { db };
export default db;
