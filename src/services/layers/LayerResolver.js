// src/services/layers/LayerResolver.js
// -----------------------------------------------------------------------------
// LayerResolver
// -----------------------------------------------------------------------------
// Applies household/user overrides (Dexie layer_overrides) onto fixed methods.
// Deterministic:
// - same inputs -> same outputs
// - no AI
//
// ✅ Shopping Mode integration:
// - Adds "intent" routing: shopping.scan and shopping.receipt.commit
// - shopping.scan: writes L0 artifacts + L1 parsed_candidates, blocks L3 commit
// - shopping.receipt.commit: writes receipt artifact + parsed_candidates, then
//   produces L2 method_maps + L3 blueprints to allow downstream commit.
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import { db } from "@/services/db";
import LayerRegistry from "@/services/layers/LayerRegistry";

function nowIso() {
  return new Date().toISOString();
}

function str(x) {
  return String(x || "").trim();
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function makeFp(input) {
  // deterministic-enough local fingerprint; avoids crypto dependency
  try {
    const s = JSON.stringify(input ?? {});
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return `fp_${(h >>> 0).toString(16)}`;
  } catch {
    return `fp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

async function loadOverrides({ domain, methodKey, householdId, userId }) {
  if (!db?.layer_overrides) return [];

  const d = str(domain);
  const mk = str(methodKey);

  const results = [];

  // Strategy:
  // - fetch by scope+scopeId first (fast via [scope+scopeId])
  // - then filter by domain/methodKey
  // This avoids requiring compound indexes for every query permutation.
  const pick = (rows) =>
    (rows || []).filter((r) => {
      if (!r?.isActive) return false;
      if (d && r.domain && str(r.domain) !== d) return false;
      if (mk && r.methodKey && str(r.methodKey) !== mk) return false;
      return true;
    });

  try {
    if (householdId) {
      const hh = await db.layer_overrides
        .where("[scope+scopeId]")
        .equals(["household", str(householdId)])
        .toArray();
      results.push(...pick(hh));
    }
  } catch (e) {}

  try {
    if (userId) {
      const uu = await db.layer_overrides
        .where("[scope+scopeId]")
        .equals(["user", str(userId)])
        .toArray();
      results.push(...pick(uu));
    }
  } catch (e) {}

  // Deterministic sort: household first, then user, then createdAt
  results.sort((a, b) => {
    const sa = str(a.scope);
    const sb = str(b.scope);
    if (sa !== sb) return sa === "household" ? -1 : 1;
    return str(a.createdAt).localeCompare(str(b.createdAt));
  });

  return results;
}

/* -------------------------------------------------------------------------- */
/* Layer Spine helpers (L0-L3)                                                 */
/* -------------------------------------------------------------------------- */

async function ensureLayerTables() {
  // Keep this permissive: if tables don’t exist yet, do not throw.
  const missing = [];
  const need = [
    "artifacts",
    "parsed_candidates",
    "method_maps",
    "blueprints",
    "layer_overrides",
  ];
  for (const t of need) {
    if (!db?.[t]) missing.push(t);
  }
  return { ok: missing.length === 0, missing };
}

async function putArtifact({
  kind,
  domain,
  source,
  fingerprint,
  status,
  sessionId,
  payload,
  meta,
} = {}) {
  if (!db?.artifacts) return null;

  const now = nowIso();
  const row = {
    kind: str(kind) || "unknown",
    domain: str(domain) || "unknown",
    source: str(source) || "runtime",
    fingerprint: str(fingerprint) || makeFp({ kind, domain, source, payload }),
    status: str(status) || "new",
    sessionId: sessionId ? str(sessionId) : null,
    createdAt: now,
    updatedAt: now,
    payload: payload && typeof payload === "object" ? payload : {},
    meta: meta && typeof meta === "object" ? meta : {},
  };

  try {
    const id = await db.artifacts.add(row);
    return { ...row, id };
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[LayerResolver] putArtifact failed", e);
    return null;
  }
}

async function putParsedCandidate({
  artifactId,
  domain,
  parser,
  fingerprint,
  status,
  payload,
  meta,
} = {}) {
  if (!db?.parsed_candidates) return null;

  const now = nowIso();
  const row = {
    artifactId: artifactId ?? null,
    domain: str(domain) || "unknown",
    parser: str(parser) || "unknown.parser",
    fingerprint:
      str(fingerprint) || makeFp({ artifactId, domain, parser, payload }),
    status: str(status) || "new",
    createdAt: now,
    updatedAt: now,
    payload: payload && typeof payload === "object" ? payload : {},
    meta: meta && typeof meta === "object" ? meta : {},
  };

  try {
    const id = await db.parsed_candidates.add(row);
    return { ...row, id };
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[LayerResolver] putParsedCandidate failed", e);
    return null;
  }
}

async function putMethodMap({
  artifactId,
  candidateId,
  domain,
  methodKey,
  confidence = 0.5,
  status = "mapped",
  meta,
} = {}) {
  if (!db?.method_maps) return null;

  const now = nowIso();
  const row = {
    artifactId: artifactId ?? null,
    candidateId: candidateId ?? null,
    domain: str(domain) || "unknown",
    methodKey: str(methodKey) || "",
    confidence: Number.isFinite(confidence) ? confidence : 0.5,
    status: str(status) || "mapped",
    createdAt: now,
    updatedAt: now,
    meta: meta && typeof meta === "object" ? meta : {},
  };

  try {
    const id = await db.method_maps.add(row);
    return { ...row, id };
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[LayerResolver] putMethodMap failed", e);
    return null;
  }
}

async function putBlueprint({
  domain,
  blueprintKey,
  artifactId,
  candidateId,
  methodMapId,
  sessionId,
  status = "ready",
  meta,
} = {}) {
  if (!db?.blueprints) return null;

  const now = nowIso();
  const row = {
    domain: str(domain) || "unknown",
    blueprintKey: str(blueprintKey) || "",
    artifactId: artifactId ?? null,
    candidateId: candidateId ?? null,
    methodMapId: methodMapId ?? null,
    sessionId: sessionId ? str(sessionId) : null,
    status: str(status) || "ready",
    createdAt: now,
    updatedAt: now,
    meta: meta && typeof meta === "object" ? meta : {},
  };

  try {
    const id = await db.blueprints.add(row);
    return { ...row, id };
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[LayerResolver] putBlueprint failed", e);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Intent routing (Shopping becomes first-class)                               */
/* -------------------------------------------------------------------------- */

/**
 * Shopping intent: scan
 * - Create L0 artifact for the scan event
 * - Create L1 parsed_candidates for each provisional scanned item
 * - DO NOT create L2/L3 (blocked until receipt)
 */
async function handleShoppingScanIntent({
  householdId,
  userId,
  payload = {},
  sessionId,
} = {}) {
  const dom = "shopping";
  const now = nowIso();

  const scanPayload = payload && typeof payload === "object" ? payload : {};
  const scanFp = makeFp({
    intent: "shopping.scan",
    at: scanPayload?.ts || now,
    device: scanPayload?.deviceId || "",
    store: scanPayload?.store || scanPayload?.storeId || "",
    items: scanPayload?.items || scanPayload?.candidates || [],
  });

  const artifact = await putArtifact({
    kind: "shopping.scan",
    domain: dom,
    source: "intent.router",
    fingerprint: scanFp,
    status: "staged",
    sessionId: sessionId || scanPayload?.shoppingSessionId || null,
    payload: {
      intent: "shopping.scan",
      householdId: householdId || null,
      userId: userId || null,
      ...scanPayload,
    },
    meta: {
      blocksCommitUntilReceipt: true,
      layer: "L0",
    },
  });

  // Candidate normalization: accept multiple shapes
  const rawItems =
    scanPayload?.items ||
    scanPayload?.candidates ||
    scanPayload?.scans ||
    (scanPayload?.item ? [scanPayload.item] : []);

  const items = Array.isArray(rawItems) ? rawItems : [];
  const parsed = [];

  for (const it of items) {
    const candidateFp = makeFp({
      kind: "shopping.candidate",
      upc: it?.upc || it?.barcode || "",
      name: it?.name || it?.title || "",
      store: scanPayload?.store || scanPayload?.storeId || "",
      price: it?.price || it?.observedPrice || "",
      qty: it?.qty || 1,
    });

    const candidate = await putParsedCandidate({
      artifactId: artifact?.id ?? null,
      domain: dom,
      parser: "shopping.scan.v1",
      fingerprint: candidateFp,
      status: "provisional",
      payload: {
        type: "shopping.candidate",
        householdId: householdId || null,
        userId: userId || null,
        shoppingSessionId:
          sessionId ||
          scanPayload?.shoppingSessionId ||
          artifact?.sessionId ||
          null,
        store: scanPayload?.store || scanPayload?.storeId || null,
        scannedAt: scanPayload?.ts || now,
        // keep raw, but normalize common fields
        upc: it?.upc || it?.barcode || it?.gtin || null,
        name: it?.name || it?.title || null,
        brand: it?.brand || null,
        size: it?.size || it?.netContent || null,
        quantity: it?.qty || it?.quantity || 1,
        observedPrice: it?.price || it?.observedPrice || null,
        currency: it?.currency || "USD",
        raw: it && typeof it === "object" ? it : { value: it },
      },
      meta: {
        blocksCommitUntilReceipt: true,
        layer: "L1",
      },
    });

    if (candidate?.id != null) parsed.push(candidate);
  }

  return {
    ok: true,
    intent: "shopping.scan",
    domain: dom,
    blocked: true,
    blockedReason: "Receipt required before L3 commit.",
    layer: {
      L0: artifact ? { artifactId: artifact.id } : null,
      L1: { candidateIds: parsed.map((p) => p.id) },
      L2: null,
      L3: null,
    },
  };
}

/**
 * Shopping intent: receipt.commit
 * - Create L0 artifact for receipt
 * - Create L1 parsed_candidates for receipt parse (and optionally reconciliation output)
 * - Produce L2 method_maps + L3 blueprints so downstream pipeline can commit
 *
 * NOTE:
 * - This does NOT directly write to inventory; it unlocks the spine to do so.
 */
async function handleShoppingReceiptCommitIntent({
  householdId,
  userId,
  payload = {},
  sessionId,
} = {}) {
  const dom = "shopping";
  const now = nowIso();

  const receiptPayload = payload && typeof payload === "object" ? payload : {};
  const receiptFp = makeFp({
    intent: "shopping.receipt.commit",
    store: receiptPayload?.store || receiptPayload?.storeId || "",
    total: receiptPayload?.total || "",
    ts: receiptPayload?.ts || now,
    items: receiptPayload?.items || receiptPayload?.lines || [],
  });

  const receiptArtifact = await putArtifact({
    kind: "shopping.receipt",
    domain: dom,
    source: "intent.router",
    fingerprint: receiptFp,
    status: "received",
    sessionId: sessionId || receiptPayload?.shoppingSessionId || null,
    payload: {
      intent: "shopping.receipt.commit",
      householdId: householdId || null,
      userId: userId || null,
      ...receiptPayload,
    },
    meta: {
      unlocksCommit: true,
      layer: "L0",
    },
  });

  // L1: receipt parse result (single candidate)
  const receiptCandidate = await putParsedCandidate({
    artifactId: receiptArtifact?.id ?? null,
    domain: dom,
    parser: "shopping.receipt.v1",
    fingerprint: makeFp({ receiptFp, parser: "shopping.receipt.v1" }),
    status: "parsed",
    payload: {
      type: "shopping.receipt",
      householdId: householdId || null,
      userId: userId || null,
      shoppingSessionId:
        sessionId ||
        receiptPayload?.shoppingSessionId ||
        receiptArtifact?.sessionId ||
        null,
      store: receiptPayload?.store || receiptPayload?.storeId || null,
      purchasedAt: receiptPayload?.ts || now,
      subtotal: receiptPayload?.subtotal ?? null,
      tax: receiptPayload?.tax ?? null,
      total: receiptPayload?.total ?? null,
      currency: receiptPayload?.currency || "USD",
      lines: receiptPayload?.items || receiptPayload?.lines || [],
      raw: receiptPayload,
    },
    meta: { unlocksCommit: true, layer: "L1" },
  });

  // L2/L3:
  // We generate method_maps and blueprints for "shopping.receipt.commit"
  // so a downstream builder can:
  // - reconcile staged candidates -> receipt lines
  // - write price observations
  // - commit inventory deltas
  //
  // MethodKey convention:
  // - Keep it stable and discoverable in your fixed-method catalogs.
  // - This can later branch: "shopping.commit.inventory", "shopping.write.price_observations", etc.
  const methodKey = "shopping.receipt.commit";

  const mm = await putMethodMap({
    artifactId: receiptArtifact?.id ?? null,
    candidateId: receiptCandidate?.id ?? null,
    domain: dom,
    methodKey,
    confidence: 1.0,
    status: "mapped",
    meta: {
      reason: "Receipt provided; commit unlocked",
    },
  });

  const bp = await putBlueprint({
    domain: dom,
    blueprintKey: `bp_${methodKey}`,
    artifactId: receiptArtifact?.id ?? null,
    candidateId: receiptCandidate?.id ?? null,
    methodMapId: mm?.id ?? null,
    sessionId: sessionId || receiptPayload?.shoppingSessionId || null,
    status: "ready",
    meta: {
      intent: "shopping.receipt.commit",
      receiptArtifactId: receiptArtifact?.id ?? null,
      receiptCandidateId: receiptCandidate?.id ?? null,
      methodKey,
    },
  });

  return {
    ok: true,
    intent: "shopping.receipt.commit",
    domain: dom,
    blocked: false,
    layer: {
      L0: receiptArtifact ? { artifactId: receiptArtifact.id } : null,
      L1: receiptCandidate ? { candidateId: receiptCandidate.id } : null,
      L2: mm ? { methodMapId: mm.id, methodKey } : null,
      L3: bp ? { blueprintId: bp.id, blueprintKey: bp.blueprintKey } : null,
    },
  };
}

const INTENT_HANDLERS = {
  "shopping.scan": handleShoppingScanIntent,
  "shopping.receipt.commit": handleShoppingReceiptCommitIntent,
};

class LayerResolverService {
  async initAssets() {
    return await LayerRegistry.init();
  }

  /**
   * Resolve a methodKey to a usable definition, applying overrides.
   *
   * Returns:
   * {
   *   ok: true,
   *   methodKey,
   *   base: {...},          // base method definition (pattern/method)
   *   overrides: [...],     // applied overrides
   *   resolved: {...},      // merged definition
   *   audit: {applied: [...]}
   * }
   */
  async resolveMethod({ methodKey, domain, householdId, userId } = {}) {
    await this.initAssets();

    const mk = str(methodKey);
    if (!mk) return { ok: false, error: "Missing methodKey" };

    const resolvedBase = LayerRegistry.resolveMethodKey(mk);
    if (!resolvedBase) {
      return {
        ok: false,
        error: `Unknown methodKey: ${mk}`,
        methodKey: mk,
      };
    }

    const dom = str(
      domain || resolvedBase.domain || resolvedBase.pattern?.domain
    );
    const baseDef =
      resolvedBase.kind === "catalogPattern"
        ? resolvedBase.pattern
        : resolvedBase.method;

    const overrides = await loadOverrides({
      domain: dom,
      methodKey: mk,
      householdId,
      userId,
    });

    // Convention for overrides:
    // layer_overrides.payload = { patch: {...}, block: boolean, notes }
    // If "block" is true => hard block.
    const audit = [];
    let merged = { ...(baseDef || {}) };

    for (const o of overrides) {
      const patch = o?.patch || o?.payload?.patch || null;
      const block = Boolean(o?.block || o?.payload?.block);
      audit.push({
        id: o.id,
        scope: o.scope,
        scopeId: o.scopeId,
        domain: o.domain,
        methodKey: o.methodKey,
        block,
        appliedAt: nowIso(),
        notes: o.notes || o.payload?.notes || "",
      });

      if (block) {
        return {
          ok: false,
          blocked: true,
          methodKey: mk,
          domain: dom,
          base: baseDef,
          overrides,
          audit: { applied: audit },
          error: `Method blocked by override (${o.scope})`,
        };
      }

      if (patch) merged = deepMerge(merged, patch);
    }

    return {
      ok: true,
      methodKey: mk,
      domain: dom,
      base: baseDef,
      overrides,
      resolved: merged,
      audit: { applied: audit },
      sourceKind: resolvedBase.kind,
      source: resolvedBase,
    };
  }

  /**
   * ✅ Resolve a first-class "intent" into Layer Spine artifacts (L0-L3),
   * while staying deterministic and enforcing policy gates.
   *
   * Supported:
   * - shopping.scan
   * - shopping.receipt.commit
   *
   * Return shape mirrors the Layer Spine:
   * {
   *   ok: boolean,
   *   intent: string,
   *   domain: string,
   *   blocked: boolean,
   *   blockedReason?: string,
   *   layer: { L0, L1, L2, L3 }
   * }
   */
  async resolveIntent({
    intent,
    payload,
    householdId,
    userId,
    sessionId,
  } = {}) {
    const i = str(intent);
    if (!i) return { ok: false, error: "Missing intent" };

    // If Layer Spine tables aren’t present yet, we fail softly.
    const check = await ensureLayerTables();
    if (!check.ok) {
      return {
        ok: false,
        error: `Layer Spine tables missing: ${check.missing.join(", ")}`,
        intent: i,
        blocked: true,
        blockedReason: "Layer Spine not initialized.",
      };
    }

    const handler = INTENT_HANDLERS[i];
    if (!handler) {
      return { ok: false, error: `Unknown intent: ${i}`, intent: i };
    }

    try {
      return await handler({ householdId, userId, payload, sessionId });
    } catch (e) {
      if (import.meta?.env?.DEV) {
        console.warn("[LayerResolver] resolveIntent failed:", i, e);
      }
      return { ok: false, error: `Intent failed: ${i}`, intent: i };
    }
  }
}

export const LayerResolver = new LayerResolverService();
export default LayerResolver;
