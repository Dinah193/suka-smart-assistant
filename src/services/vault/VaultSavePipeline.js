/**
 * @file C:\Users\larho\suka-smart-assistant\src\services\vault\VaultSavePipeline.js
 *
 * VaultSavePipeline
 * -----------------------------------------------------------------------------
 * Service-layer pipeline for preparing + saving “artifacts” into SSA’s Vault.
 *
 * CRITICAL DESIGN RULES
 * - ✅ NO UI imports here (no React, no drag/drop libs, etc.).
 * - ✅ Browser-safe (no node:fs / node:path / node:url).
 * - ✅ Works even if Dexie/DB tables aren’t present yet (graceful fallback).
 *
 * PRIMARY API (used by UI like HouseholdComplianceWizard flows)
 * - prepareArtifactForVault({ domain, householdId, rawInput, kind?, title?, meta? })
 * - saveArtifactToVault({ domain, householdId, artifact, options? })
 *
 * OPTIONAL UTILITIES
 * - getVaultArtifact(id), listVaultArtifacts(filter), deleteVaultArtifact(id)
 * - registerNormalizer(domain|kind, fn)
 * - registerComplianceRule(domain|kind, rule)
 *
 * STORAGE
 * - Prefers Dexie table: db.artifacts (if present)
 * - Fallback: localStorage under "ssa.vault.artifacts.v1"
 *
 * EVENT BUS
 * Emits "vault.artifact.prepared" / "vault.artifact.saved" / "vault.artifact.error"
 * using "@/services/events/eventBus" if available.
 */

/* ──────────────────────────────────────────────────────────────────────────────
 * Constants
 */

export const COMPLIANCE_STATUS = Object.freeze({
  COMPLIANT: "COMPLIANT",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  BLOCKED: "BLOCKED",
  ERROR: "ERROR",
});

const SOURCE = "VaultSavePipeline";
const LS_KEY = "ssa.vault.artifacts.v1";
const DEFAULT_SCHEMA_VERSION = 1;

/* ──────────────────────────────────────────────────────────────────────────────
 * Registries (extension points)
 */

const NORMALIZERS = new Map(); // key: "domain:cleaning" or "kind:recipe" etc.
const ENRICHERS = new Map(); // optional post-normalize enrichers
const COMPLIANCE_RULES = new Map(); // key => array of rule fns

/**
 * Register a normalizer for a domain or kind.
 * @param {object} spec
 * @param {string} [spec.domain]
 * @param {string} [spec.kind]
 * @param {(args:{ domain:string, kind:string, householdId:string|null, rawInput:any })=>any|Promise<any>} fn
 */
export function registerNormalizer(spec, fn) {
  const key = _keyForSpec(spec);
  if (!key || typeof fn !== "function") return;
  NORMALIZERS.set(key, fn);
}

/**
 * Register an enricher for a domain or kind (runs after normalize, before compliance).
 * @param {object} spec
 * @param {string} [spec.domain]
 * @param {string} [spec.kind]
 * @param {(args:{ artifact:any })=>any|Promise<any>} fn
 */
export function registerEnricher(spec, fn) {
  const key = _keyForSpec(spec);
  if (!key || typeof fn !== "function") return;
  ENRICHERS.set(key, fn);
}

/**
 * Register a compliance rule for a domain or kind.
 * Rule can return:
 * - null/undefined => no issues
 * - { status, issues[], warnings[], swaps?, notes? }
 * @param {object} spec
 * @param {string} [spec.domain]
 * @param {string} [spec.kind]
 * @param {(args:{ artifact:any, ctx:any })=>object|null|Promise<object|null>} rule
 */
export function registerComplianceRule(spec, rule) {
  const key = _keyForSpec(spec);
  if (!key || typeof rule !== "function") return;
  const list = COMPLIANCE_RULES.get(key) || [];
  list.push(rule);
  COMPLIANCE_RULES.set(key, list);
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Public API
 */

/**
 * Prepare an artifact for vault storage:
 * - normalize input (domain/kind specific if available)
 * - enrich (optional)
 * - run compliance
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {string|null} [args.householdId]
 * @param {any} args.rawInput
 * @param {string} [args.kind] - optional type within domain (e.g. "routine", "recipe", "plan")
 * @param {string} [args.title]
 * @param {object} [args.meta]
 * @param {object} [args.ctx] - optional context for compliance rules (prefs, inventory, etc.)
 * @returns {Promise<{ artifact: any|null, compliance: {status:string, issues?:any[], warnings?:any[], swaps?:any[], notes?:string[], error?:string} }>}
 */
export async function prepareArtifactForVault({
  domain,
  householdId = null,
  rawInput,
  kind = "artifact",
  title,
  meta = {},
  ctx = {},
} = {}) {
  const ts = _isoNow();

  try {
    if (!domain || typeof domain !== "string") {
      return {
        artifact: null,
        compliance: {
          status: COMPLIANCE_STATUS.ERROR,
          error: 'Missing/invalid "domain".',
        },
      };
    }

    const safeDomain = String(domain).toLowerCase().trim();
    const safeKind = String(kind || "artifact")
      .toLowerCase()
      .trim();

    // Normalize
    const normalized = await _normalize({
      domain: safeDomain,
      kind: safeKind,
      householdId,
      rawInput,
    });

    // Build base artifact envelope
    const artifact = {
      id: _newId(),
      domain: safeDomain,
      kind: safeKind,
      title:
        title || _defaultTitleFor(safeDomain, safeKind, normalized, rawInput),
      householdId: householdId || null,
      schemaVersion: DEFAULT_SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      source: SOURCE,
      meta: {
        ..._safeObject(meta),
        // fingerprints help with dedupe / caching
        fingerprint: _fingerprint({
          domain: safeDomain,
          kind: safeKind,
          rawInput,
          normalized,
        }),
      },
      rawInput: _safeSerializable(rawInput),
      normalized: _safeSerializable(normalized),
    };

    // Enrich
    const enriched = await _enrich(artifact);

    // Compliance
    const compliance = await _checkCompliance(enriched, ctx);

    // Attach compliance summary (keep full details returned separately too)
    enriched.meta = enriched.meta || {};
    enriched.meta.compliance = {
      status: compliance.status,
      issueCount: Array.isArray(compliance.issues)
        ? compliance.issues.length
        : 0,
      warningCount: Array.isArray(compliance.warnings)
        ? compliance.warnings.length
        : 0,
      checkedAt: ts,
    };

    await _emit("vault.artifact.prepared", {
      id: enriched.id,
      domain: enriched.domain,
      kind: enriched.kind,
      householdId: enriched.householdId,
      compliance: enriched.meta.compliance,
    });

    return { artifact: enriched, compliance };
  } catch (e) {
    const msg = e?.message || String(e);
    await _emit("vault.artifact.error", {
      stage: "prepare",
      domain: domain || null,
      householdId,
      message: msg,
    });
    return {
      artifact: null,
      compliance: { status: COMPLIANCE_STATUS.ERROR, error: msg },
    };
  }
}

/**
 * Persist a prepared artifact to Vault storage.
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {string|null} [args.householdId]
 * @param {any} args.artifact - prepared artifact envelope
 * @param {object} [args.options]
 * @param {boolean} [args.options.allowOverwrite] - if true and id exists, overwrite
 * @param {boolean} [args.options.forceLocalStorage] - debug/fallback mode
 * @returns {Promise<{ ok:boolean, id:string|null, storage:"dexie"|"localStorage"|"none", storedAt:string|null, error?:string }>}
 */
export async function saveArtifactToVault({
  domain,
  householdId = null,
  artifact,
  options = {},
} = {}) {
  const ts = _isoNow();

  try {
    if (!artifact || typeof artifact !== "object") {
      return {
        ok: false,
        id: null,
        storage: "none",
        storedAt: null,
        error: 'Missing/invalid "artifact".',
      };
    }

    const safeDomain = String(domain || artifact.domain || "")
      .toLowerCase()
      .trim();
    if (!safeDomain) {
      return {
        ok: false,
        id: null,
        storage: "none",
        storedAt: null,
        error: 'Missing/invalid "domain".',
      };
    }

    // ensure envelope fields
    const toStore = {
      ...artifact,
      domain: safeDomain,
      householdId: householdId || artifact.householdId || null,
      updatedAt: ts,
    };

    // Try Dexie first unless forced
    const forceLS = !!options.forceLocalStorage;

    if (!forceLS) {
      const db = await _maybeGetDexieDb();
      const table = db?.artifacts;
      if (table && typeof table.put === "function") {
        // put() upserts by primary key
        await table.put(toStore);
        await _emit("vault.artifact.saved", {
          id: toStore.id,
          domain: toStore.domain,
          kind: toStore.kind,
          householdId: toStore.householdId,
          storage: "dexie",
        });
        return { ok: true, id: toStore.id, storage: "dexie", storedAt: ts };
      }
    }

    // Fallback localStorage
    const ok = _lsUpsert(toStore, {
      allowOverwrite: options.allowOverwrite !== false,
    });
    if (ok) {
      await _emit("vault.artifact.saved", {
        id: toStore.id,
        domain: toStore.domain,
        kind: toStore.kind,
        householdId: toStore.householdId,
        storage: "localStorage",
      });
      return {
        ok: true,
        id: toStore.id,
        storage: "localStorage",
        storedAt: ts,
      };
    }

    return {
      ok: false,
      id: toStore.id || null,
      storage: "none",
      storedAt: null,
      error:
        "Failed to persist artifact (Dexie unavailable; localStorage failed).",
    };
  } catch (e) {
    const msg = e?.message || String(e);
    await _emit("vault.artifact.error", {
      stage: "save",
      domain: domain || null,
      householdId,
      message: msg,
    });
    return {
      ok: false,
      id: artifact?.id || null,
      storage: "none",
      storedAt: null,
      error: msg,
    };
  }
}

/**
 * Retrieve a vault artifact by id (Dexie first, then localStorage).
 * @param {string} id
 * @returns {Promise<any|null>}
 */
export async function getVaultArtifact(id) {
  const key = String(id || "").trim();
  if (!key) return null;

  const db = await _maybeGetDexieDb();
  const table = db?.artifacts;
  if (table && typeof table.get === "function") {
    try {
      const v = await table.get(key);
      if (v) return v;
    } catch {
      // ignore
    }
  }

  return _lsGet(key);
}

/**
 * List vault artifacts with optional filtering (Dexie first, then localStorage).
 * @param {object} [filter]
 * @param {string} [filter.domain]
 * @param {string} [filter.kind]
 * @param {string|null} [filter.householdId]
 * @param {number} [filter.limit]
 * @returns {Promise<any[]>}
 */
export async function listVaultArtifacts(filter = {}) {
  const f = _safeObject(filter);
  const domain = f.domain ? String(f.domain).toLowerCase().trim() : null;
  const kind = f.kind ? String(f.kind).toLowerCase().trim() : null;
  const householdId = f.householdId != null ? String(f.householdId) : null;
  const limit = Number.isFinite(Number(f.limit))
    ? Math.max(1, Number(f.limit))
    : 250;

  const db = await _maybeGetDexieDb();
  const table = db?.artifacts;

  if (table) {
    try {
      // Generic scan to avoid depending on schema/indexes (production-safe).
      const all = await table.toArray();
      const filtered = all
        .filter((a) => (domain ? a?.domain === domain : true))
        .filter((a) => (kind ? a?.kind === kind : true))
        .filter((a) =>
          householdId ? String(a?.householdId || "") === householdId : true
        )
        .sort((a, b) =>
          String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""))
        )
        .slice(0, limit);
      return filtered;
    } catch {
      // fall through to LS
    }
  }

  const allLS = _lsAll();
  return allLS
    .filter((a) => (domain ? a?.domain === domain : true))
    .filter((a) => (kind ? a?.kind === kind : true))
    .filter((a) =>
      householdId ? String(a?.householdId || "") === householdId : true
    )
    .sort((a, b) =>
      String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""))
    )
    .slice(0, limit);
}

/**
 * Delete a vault artifact by id (Dexie first, then localStorage).
 * @param {string} id
 * @returns {Promise<{ok:boolean, storage:"dexie"|"localStorage"|"none"}>}
 */
export async function deleteVaultArtifact(id) {
  const key = String(id || "").trim();
  if (!key) return { ok: false, storage: "none" };

  const db = await _maybeGetDexieDb();
  const table = db?.artifacts;
  if (table && typeof table.delete === "function") {
    try {
      await table.delete(key);
      await _emit("vault.artifact.deleted", { id: key, storage: "dexie" });
      return { ok: true, storage: "dexie" };
    } catch {
      // ignore
    }
  }

  const ok = _lsDelete(key);
  if (ok) {
    await _emit("vault.artifact.deleted", { id: key, storage: "localStorage" });
    return { ok: true, storage: "localStorage" };
  }

  return { ok: false, storage: "none" };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Internals: normalize / enrich / compliance
 */

async function _normalize({ domain, kind, householdId, rawInput }) {
  const dKey = `domain:${domain}`;
  const kKey = `kind:${kind}`;
  const fn = NORMALIZERS.get(kKey) || NORMALIZERS.get(dKey) || null;

  if (typeof fn === "function") {
    const out = await fn({ domain, kind, householdId, rawInput });
    return out == null ? rawInput : out;
  }

  // Default “safe normalize”:
  // - If string: wrap in { text }
  // - If object: shallow clone
  // - Else: wrap in { value }
  if (typeof rawInput === "string") return { text: rawInput };
  if (rawInput && typeof rawInput === "object") return { ...rawInput };
  return { value: rawInput };
}

async function _enrich(artifact) {
  const dKey = `domain:${artifact.domain}`;
  const kKey = `kind:${artifact.kind}`;
  const fn = ENRICHERS.get(kKey) || ENRICHERS.get(dKey) || null;

  if (typeof fn !== "function") return artifact;

  try {
    const out = await fn({ artifact });
    // Enricher may return a new artifact or partial updates
    if (out && typeof out === "object") {
      if (out.id && out.domain && out.kind) return out;
      return {
        ...artifact,
        ...out,
        meta: { ...(artifact.meta || {}), ...(out.meta || {}) },
        normalized:
          out.normalized != null ? out.normalized : artifact.normalized,
      };
    }
  } catch {
    // ignore enrich failures
  }
  return artifact;
}

async function _checkCompliance(artifact, ctx = {}) {
  // Default compliance is “COMPLIANT” unless rules say otherwise.
  const base = {
    status: COMPLIANCE_STATUS.COMPLIANT,
    issues: [],
    warnings: [],
    swaps: [],
    notes: [],
  };

  const dKey = `domain:${artifact.domain}`;
  const kKey = `kind:${artifact.kind}`;

  const rules = []
    .concat(COMPLIANCE_RULES.get(dKey) || [])
    .concat(COMPLIANCE_RULES.get(kKey) || []);

  if (!rules.length) return base;

  let status = COMPLIANCE_STATUS.COMPLIANT;
  const issues = [];
  const warnings = [];
  const swaps = [];
  const notes = [];

  for (const rule of rules) {
    try {
      const res = await rule({ artifact, ctx });
      if (!res) continue;

      const rStatus = res.status || COMPLIANCE_STATUS.NEEDS_REVIEW;

      if (rStatus === COMPLIANCE_STATUS.BLOCKED)
        status = COMPLIANCE_STATUS.BLOCKED;
      else if (
        rStatus === COMPLIANCE_STATUS.ERROR &&
        status !== COMPLIANCE_STATUS.BLOCKED
      )
        status = COMPLIANCE_STATUS.ERROR;
      else if (
        rStatus === COMPLIANCE_STATUS.NEEDS_REVIEW &&
        status === COMPLIANCE_STATUS.COMPLIANT
      )
        status = COMPLIANCE_STATUS.NEEDS_REVIEW;

      if (Array.isArray(res.issues)) issues.push(...res.issues);
      if (Array.isArray(res.warnings)) warnings.push(...res.warnings);
      if (Array.isArray(res.swaps)) swaps.push(...res.swaps);
      if (Array.isArray(res.notes)) notes.push(...res.notes);
    } catch (e) {
      status =
        status === COMPLIANCE_STATUS.BLOCKED ? status : COMPLIANCE_STATUS.ERROR;
      notes.push(`Compliance rule error: ${e?.message || String(e)}`);
    }
  }

  return {
    status,
    issues,
    warnings,
    swaps,
    notes,
  };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Internals: Dexie + event bus loaders (graceful, browser-safe)
 */

async function _maybeGetDexieDb() {
  // Try common SSA paths. No throws outward.
  const candidates = [
    "@/services/db", // user often uses services/db.js
    "@/services/db.js",
    "@/db",
    "@/db.js",
    "@/services/db/index.js",
  ];

  for (const p of candidates) {
    try {
      const mod = await import(/* @vite-ignore */ p);
      const db = mod?.db || mod?.default || mod?.DB || mod;

      // Must look like a Dexie instance with at least `tables` or `open`
      if (db && typeof db === "object") {
        // If artifacts table exists, great; if not, still return db for callers.
        return db;
      }
    } catch {
      // continue
    }
  }
  return null;
}

async function _emit(type, data) {
  try {
    const mod = await import("@/services/events/eventBus");
    const bus = mod?.default || mod?.eventBus || mod;
    if (!bus || typeof bus.emit !== "function") return;

    const payload = {
      type,
      ts: _isoNow(),
      source: SOURCE,
      data: _safeSerializable(data),
    };

    // SSA sometimes emits either raw type or wrapper
    try {
      bus.emit(type, payload);
    } catch {
      // fallback to a central channel if used
      try {
        bus.emit("automation.event", payload);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Internals: localStorage vault fallback
 */

function _lsRead() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore
  }
  return { byId: {}, order: [] };
}

function _lsWrite(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function _lsUpsert(artifact, { allowOverwrite = true } = {}) {
  try {
    const st = _lsRead();
    const id = String(artifact.id || "").trim();
    if (!id) return false;

    if (!allowOverwrite && st.byId[id]) return false;

    st.byId[id] = artifact;
    if (!st.order.includes(id)) st.order.unshift(id);
    else {
      // move to front
      st.order = [id, ...st.order.filter((x) => x !== id)];
    }
    return _lsWrite(st);
  } catch {
    return false;
  }
}

function _lsGet(id) {
  try {
    const st = _lsRead();
    return st.byId?.[id] || null;
  } catch {
    return null;
  }
}

function _lsAll() {
  const st = _lsRead();
  const order = Array.isArray(st.order) ? st.order : [];
  const byId = st.byId || {};
  const out = [];
  for (const id of order) {
    const v = byId[id];
    if (v) out.push(v);
  }
  // also include any stragglers
  for (const id of Object.keys(byId)) {
    if (!order.includes(id)) out.push(byId[id]);
  }
  return out;
}

function _lsDelete(id) {
  try {
    const st = _lsRead();
    if (!st.byId?.[id]) return false;
    delete st.byId[id];
    st.order = (st.order || []).filter((x) => x !== id);
    return _lsWrite(st);
  } catch {
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Helpers
 */

function _keyForSpec(spec) {
  const s = spec && typeof spec === "object" ? spec : {};
  if (s.kind) return `kind:${String(s.kind).toLowerCase().trim()}`;
  if (s.domain) return `domain:${String(s.domain).toLowerCase().trim()}`;
  return null;
}

function _newId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID)
      return crypto.randomUUID();
  } catch {
    // ignore
  }
  // fallback
  return `v_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function _isoNow() {
  return new Date().toISOString();
}

function _safeObject(x) {
  return x && typeof x === "object" ? x : {};
}

function _safeSerializable(x) {
  // Ensure we don’t accidentally stash functions, DOM nodes, circular refs, etc.
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    // fallback to a shallow safe shape
    if (x == null) return null;
    if (
      typeof x === "string" ||
      typeof x === "number" ||
      typeof x === "boolean"
    )
      return x;
    if (Array.isArray(x)) return x.map((v) => _safeSerializable(v));
    if (typeof x === "object") {
      const out = {};
      for (const k of Object.keys(x)) {
        const v = x[k];
        if (typeof v === "function") continue;
        out[k] = _safeSerializable(v);
      }
      return out;
    }
    return String(x);
  }
}

function _fingerprint({ domain, kind, rawInput, normalized }) {
  // Small non-crypto fingerprint for dedupe/caching (browser-safe).
  // NOTE: Not for security; for “same input” detection.
  const s = JSON.stringify({
    d: domain,
    k: kind,
    r: _safeSerializable(rawInput),
    n: _safeSerializable(normalized),
  });
  return _fnv1a(s);
}

function _fnv1a(str) {
  // 32-bit FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `fnv_${h.toString(16)}`;
}

function _defaultTitleFor(domain, kind, normalized, rawInput) {
  const d = String(domain || "vault").toLowerCase();
  const k = String(kind || "artifact").toLowerCase();

  const fromNorm =
    normalized && typeof normalized === "object"
      ? normalized.title || normalized.name || normalized.label
      : null;

  const fromRaw =
    rawInput && typeof rawInput === "object"
      ? rawInput.title || rawInput.name || rawInput.label
      : typeof rawInput === "string"
      ? rawInput.slice(0, 60)
      : null;

  const base = fromNorm || fromRaw || `${k}`;
  return `${_cap(d)} — ${_cap(base)}`;
}

function _cap(s) {
  return String(s || "")
    .replace(/[-_.]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Default built-in compliance rule (minimal, safe)
 * -----------------------------------------------------------------------------
 * This is intentionally conservative and generic.
 * You can register stronger domain rules elsewhere.
 *
 * What it does:
 * - If artifact.normalized contains `supplies` or `tools`, and ctx.inventory/ctx.equipment
 *   are provided as arrays of {key|id}, it flags missing requirements.
 *
 * Result:
 * - NEEDS_REVIEW if missing requirements exist (not BLOCKED).
 */

registerComplianceRule({ domain: "cleaning" }, async ({ artifact, ctx }) => {
  const inv = Array.isArray(ctx?.inventory) ? ctx.inventory : null;
  const eq = Array.isArray(ctx?.equipment) ? ctx.equipment : null;
  if (!inv && !eq) return null;

  const invSet = inv
    ? new Set(inv.map((x) => (x && (x.key || x.id)) || ""))
    : new Set();
  const eqSet = eq
    ? new Set(eq.map((x) => (x && (x.key || x.id)) || ""))
    : new Set();

  const n = artifact?.normalized;
  if (!n || typeof n !== "object") return null;

  const supplies = Array.isArray(n.supplies) ? n.supplies : [];
  const tools = Array.isArray(n.tools) ? n.tools : [];

  const missingSupplies = supplies.filter((k) => k && !invSet.has(k));
  const missingTools = tools.filter((k) => k && !eqSet.has(k));

  if (!missingSupplies.length && !missingTools.length) return null;

  return {
    status: COMPLIANCE_STATUS.NEEDS_REVIEW,
    issues: [
      ...(missingSupplies.length
        ? [{ type: "missingSupplies", keys: missingSupplies }]
        : []),
      ...(missingTools.length
        ? [{ type: "missingTools", keys: missingTools }]
        : []),
    ],
    warnings: [],
    swaps: [],
    notes: [
      "Some requirements are missing from current household inventory/equipment.",
    ],
  };
});

/* ──────────────────────────────────────────────────────────────────────────────
 * Default export (optional convenience)
 */

export default {
  COMPLIANCE_STATUS,
  prepareArtifactForVault,
  saveArtifactToVault,
  getVaultArtifact,
  listVaultArtifacts,
  deleteVaultArtifact,
  registerNormalizer,
  registerEnricher,
  registerComplianceRule,
};
