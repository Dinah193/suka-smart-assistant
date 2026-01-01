// src/services/layers/LayerRegistry.js
// -----------------------------------------------------------------------------
// LayerRegistry (service wrapper)
// -----------------------------------------------------------------------------
// SSA conventions:
// - Keep runtime imports light.
// - Load fixed-layer assets (catalogs + lexicons) via LayerAssetLoader.
// - Expose stable helpers for parsers/resolvers (L1/L2/L3 pipeline).
//
// ✅ Shopping Mode integration:
// - Adds clean resolution for "shopping.receipt.commit" (and friends) even if
//   catalogs/lexicons don't yet define them (safe fallback method objects).
// - This allows downstream blueprint builders to resolve methodKeys reliably.
//
// This file is SAFE to import anywhere (it does not eagerly load assets).
// Call LayerRegistry.init() once at app boot (or lazily) before queries.
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import LayerAssetLoader from "@/layers/loaders/LayerAssetLoader";
import {
  LEXICON_FILES,
  CATALOG_FILES,
  CATALOG_GROUPS,
  REGISTRY_META,
} from "@/layers/registry";

function nowIso() {
  return new Date().toISOString();
}

function normalizeId(x) {
  return String(x || "").trim();
}

function stableAssetVersionStamp() {
  // Used for cache invalidation keys in Dexie / memory.
  // If REGISTRY_META changes, this stamp changes.
  const v = `${REGISTRY_META?.version || "0"}:${
    REGISTRY_META?.buildId || "dev"
  }`;
  return v;
}

function safeLower(x) {
  return String(x || "")
    .toLowerCase()
    .trim();
}

/**
 * Minimal built-in method definitions for critical intents that must resolve
 * even if asset catalogs aren't updated yet.
 *
 * Downstream convention:
 * - Builders can use method.kind/type + steps OR treat it as a "blueprint recipe"
 *   with a known orchestrator route (shopping receipt reconciliation).
 *
 * NOTE: These are intentionally lightweight and deterministic.
 */
const BUILTIN_METHODS = {
  "shopping.receipt.commit": {
    key: "shopping.receipt.commit",
    id: "shopping.receipt.commit",
    domain: "shopping",
    intent: "shopping.receipt.commit",
    title: "Receipt Commit (Reconcile → Observe Prices → Commit)",
    description:
      "Reconciles staged shopping candidates against receipt lines, writes price observations, applies coupon/recall/ingredient checks, then commits inventory changes. Intended to run only after a receipt is provided.",
    tags: [
      "shopping",
      "receipt",
      "reconcile",
      "commit",
      "price-observation",
      "coupons",
      "recalls",
      "ingredients",
    ],
    requiresReceipt: true,
    commitPolicy: "commit_on_receipt",
    shopping: {
      gate: { requiresReceipt: true },
      actions: [
        "reconcile_candidates_to_receipt",
        "write_price_observations",
        "apply_coupon_matches",
        "apply_recall_checks",
        "apply_ingredient_checks",
        "commit_inventory",
      ],
    },
    // Optional "builder hints" (kept permissive; builders may ignore)
    builder: {
      route: "shopping.receipt.commit",
      expectedInputs: [
        "artifactId (receipt)",
        "candidateId (receipt parse)",
        "methodMapId",
      ],
      outputs: [
        "inventoryCommit",
        "priceObservations",
        "couponMatches",
        "recallAlerts",
        "ingredientFlags",
      ],
    },
    // Keep steps simple; builders can expand to full session steps if desired.
    steps: [
      {
        key: "receipt.validate",
        title: "Validate receipt payload",
        type: "check",
        notes:
          "Ensure receipt artifact + parsed receipt candidate exist and are consistent (store, totals, timestamp).",
      },
      {
        key: "reconcile",
        title: "Reconcile staged scans to receipt lines",
        type: "reconcile",
        notes:
          "Match staged candidates (L1 provisional scans) to receipt lines (UPC/name/size).",
      },
      {
        key: "price.observe",
        title: "Write price observations",
        type: "compare",
        notes:
          "Store per-item price snapshots for this store/location/time for later comparisons.",
      },
      {
        key: "checks",
        title: "Run coupons / recalls / ingredients checks",
        type: "check",
        notes:
          "Attach coupon matches, recall alerts, and ingredient flags to the receipt session.",
      },
      {
        key: "commit.inventory",
        title: "Commit to household inventory",
        type: "commit",
        notes:
          "Only after receipt reconciliation succeeds; apply deltas and record audit trail.",
      },
    ],
    version: 1,
    createdAt: null,
    updatedAt: null,
  },

  // Optional helper intents (safe to resolve if referenced by catalogs later)
  "shopping.scan": {
    key: "shopping.scan",
    id: "shopping.scan",
    domain: "shopping",
    intent: "shopping.scan",
    title: "Shopping Scan (Stage Only)",
    description:
      "Stages scanned items as provisional candidates (no household commit) until a receipt is provided.",
    tags: ["shopping", "scan", "staging"],
    requiresReceipt: true,
    commitPolicy: "allow_staging_only",
    shopping: { gate: { requiresReceipt: true } },
    steps: [
      {
        key: "scan.capture",
        title: "Capture scan input",
        type: "scan",
      },
      {
        key: "stage",
        title: "Stage provisional candidates",
        type: "check",
        notes: "Write L0 artifacts + L1 parsed_candidates; block commit.",
      },
    ],
    version: 1,
    createdAt: null,
    updatedAt: null,
  },
};

class LayerRegistryService {
  constructor() {
    this._loader = new LayerAssetLoader({
      lexiconFiles: LEXICON_FILES,
      catalogFiles: CATALOG_FILES,
    });
    this._ready = false;
    this._readyAt = null;
    this._assetStamp = stableAssetVersionStamp();
  }

  get meta() {
    return {
      ready: this._ready,
      readyAt: this._readyAt,
      assetStamp: this._assetStamp,
      registry: REGISTRY_META || {},
      groups: CATALOG_GROUPS || {},
    };
  }

  async init({ force = false } = {}) {
    if (this._ready && !force) return this.meta;

    const started = nowIso();
    const result = await this._loader.loadAll().catch((err) => {
      const errors = err?.errors || err?.message || String(err);
      if (import.meta?.env?.DEV)
        console.error("[LayerRegistry] loadAll failed", errors);
      throw err;
    });

    this._ready = true;
    this._readyAt = started;

    return { ...this.meta, result };
  }

  ensureReady() {
    if (!this._ready) {
      throw new Error(
        "LayerRegistry not initialized. Call LayerRegistry.init() once before queries."
      );
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Lexicons                                                                  */
  /* ------------------------------------------------------------------------ */

  getLexicon(idOrDomain) {
    this.ensureReady();
    return this._loader.getLexicon(idOrDomain);
  }

  /**
   * Returns a Map(phraseNorm -> [matchEntry...]) as built by LayerAssetLoader.
   */
  getLexiconPhraseIndex(idOrDomain) {
    this.ensureReady();
    return this._loader.getLexiconPhraseIndex(idOrDomain);
  }

  /**
   * Lightweight phrase scan: returns match objects with { phrase, methodIds, boost, source }.
   * NOTE: This is a "finite lexicon scan", not NLP. Deterministic.
   */
  scanTextWithLexicon({ text, lexiconIdOrDomain, maxMatches = 50 } = {}) {
    this.ensureReady();
    const t = String(text || "");
    if (!t.trim()) return [];

    const idx = this.getLexiconPhraseIndex(lexiconIdOrDomain);
    if (!idx) return [];

    const lower = t.toLowerCase();
    const out = [];

    for (const [phraseNorm, entries] of idx.entries()) {
      if (!phraseNorm) continue;
      // conservative contains check (we accept lexicon phrases as authored)
      if (!lower.includes(phraseNorm)) continue;

      for (const e of entries || []) {
        out.push({
          lexicon: normalizeId(lexiconIdOrDomain),
          phrase: e.phrase,
          phraseNorm,
          methodIds: Array.isArray(e.methodIds) ? e.methodIds : [],
          boost: typeof e.boost === "number" ? e.boost : 0,
          source: e.source || "unknown",
          notes: e.notes || "",
        });
        if (out.length >= maxMatches) return out;
      }
    }

    return out;
  }

  /* ------------------------------------------------------------------------ */
  /* Catalogs                                                                  */
  /* ------------------------------------------------------------------------ */

  getPattern(id) {
    this.ensureReady();
    return this._loader.getPattern(id);
  }

  searchCatalog(query) {
    this.ensureReady();
    return this._loader.searchCatalog(query);
  }

  /**
   * Helper: return all loaded lexicons (best-effort).
   */
  _listLexicons() {
    const byId = this._loader?.index?.lexiconById;
    if (!byId) return [];
    try {
      return Array.from(byId.values());
    } catch {
      return [];
    }
  }

  /**
   * Helper: normalize lexicon meta id
   */
  _lexiconId(lex) {
    return lex?.meta?.id || lex?.key || lex?.domain || "unknown";
  }

  /**
   * Helper for routing: given a methodKey, return a canonical "method" object.
   * Convention:
   * - planning patterns use catalog pattern IDs as methodKeys
   * - domain methods may come from lexicon.methods and point to session templates
   *
   * ✅ Shopping integration:
   * - "shopping.receipt.commit" should resolve cleanly even before you add it to catalogs.
   * - We return a stable "built-in method" fallback if not found in assets.
   *
   * Returns one of:
   * - { kind: "catalogPattern", pattern, ... }
   * - { kind: "lexiconMethod", method, ... }
   * - { kind: "builtinMethod", method, ... }  ✅ new
   */
  resolveMethodKey(methodKey) {
    this.ensureReady();
    const key = normalizeId(methodKey);
    if (!key) return null;

    const keyLower = safeLower(key);

    // 0) Built-in critical methods (fast path)
    if (BUILTIN_METHODS[keyLower]) {
      const m = BUILTIN_METHODS[keyLower];
      return {
        kind: "builtinMethod",
        methodKey: m.key || key,
        domain: m.domain || "unknown",
        title: m.title || key,
        method: m,
        builtin: true,
        source: { type: "builtin", id: m.key || key },
      };
    }

    // 1) Catalog pattern by ID
    const pattern = this.getPattern(key);
    if (pattern) {
      return {
        kind: "catalogPattern",
        methodKey: key,
        domain: pattern.domain || "unknown",
        title: pattern.title || key,
        pattern,
      };
    }

    // 2) Lexicon method definitions (search all loaded lexicons)
    const lexicons = this._listLexicons();
    for (const lex of lexicons) {
      const methods = lex?.methods || {};
      if (methods && typeof methods === "object" && methods[key]) {
        return {
          kind: "lexiconMethod",
          methodKey: key,
          domain: lex?.domain || lex?.meta?.domain || "unknown",
          title: methods[key]?.title || key,
          lexiconId: this._lexiconId(lex),
          method: methods[key],
        };
      }

      // Also allow case-insensitive keys in authored lexicons (best effort)
      if (methods && typeof methods === "object") {
        const direct = Object.keys(methods).find(
          (k) => safeLower(k) === keyLower
        );
        if (direct) {
          const m = methods[direct];
          return {
            kind: "lexiconMethod",
            methodKey: direct,
            domain: lex?.domain || lex?.meta?.domain || "unknown",
            title: m?.title || direct,
            lexiconId: this._lexiconId(lex),
            method: m,
          };
        }
      }
    }

    // 3) Soft fallback for shopping.* keys:
    // If someone referenced a shopping methodKey that isn't in catalogs yet,
    // return a safe placeholder method so pipeline doesn't hard-crash.
    if (keyLower.startsWith("shopping.")) {
      const placeholder = {
        key,
        id: key,
        domain: "shopping",
        title: key,
        description:
          "Placeholder shopping method (not yet defined in catalogs/lexicons). Add to fixed-method catalogs for richer behavior.",
        tags: ["shopping", "placeholder"],
        requiresReceipt:
          keyLower.includes("receipt") || keyLower.includes("commit"),
        commitPolicy: keyLower.includes("receipt")
          ? "commit_on_receipt"
          : "allow_staging_only",
        version: 1,
      };

      return {
        kind: "builtinMethod",
        methodKey: key,
        domain: "shopping",
        title: key,
        method: placeholder,
        builtin: true,
        source: { type: "builtin.placeholder", id: key },
      };
    }

    return null;
  }
}

export const LayerRegistry = new LayerRegistryService();
export default LayerRegistry;
