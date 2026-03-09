// File: src/agents/runtime/reasoner/cache/keys.js
// SSA — Reasoner Cache Keys (production-ready)
//
// Purpose
// - Generate stable, deterministic cache keys for reasoner outputs.
// - Normalize inputs so equivalent requests map to the same key.
// - Keep keys short-ish, readable, and safe for Dexie/localStorage/Map.
// - Provide helpers for "namespacing" by household/user/domain/kind/mode.
//
// Design notes
// - Keys MUST be deterministic across reloads.
// - Avoid including volatile values (timestamps, random ids) unless explicitly asked.
// - For nested objects, use stable JSON stringify (sorted keys).
// - Hashing is used to keep keys from growing too large.
//
// Dependencies
// - None (no Node crypto). Uses a tiny FNV-1a hash implementation.

const VERSION = 1;

/* ------------------------------ small utils ------------------------------ */

function isPlainObject(v) {
  if (!v || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function safeStr(v, fallback = "") {
  if (v == null) return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function normalizeToken(s) {
  return safeStr(s, "").trim().toLowerCase().replace(/\s+/g, "-");
}

function clampInt(n, min, max, fallback) {
  const x = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(x)) return fallback;
  const i = Math.trunc(x);
  return Math.max(min, Math.min(max, i));
}

/**
 * Stable stringify:
 * - sorts object keys
 * - preserves array order
 * - drops undefined + functions
 * - converts Date -> ISO
 * - converts NaN/Infinity -> null
 */
export function stableStringify(value) {
  const seen = new WeakSet();

  const _norm = (v) => {
    if (v === undefined) return undefined;
    if (typeof v === "function") return undefined;
    if (typeof v === "number") {
      return Number.isFinite(v) ? v : null;
    }
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string" || typeof v === "boolean" || v === null) return v;

    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isFinite(t) ? v.toISOString() : null;
    }

    if (Array.isArray(v)) {
      return v.map(_norm).filter((x) => x !== undefined);
    }

    if (isPlainObject(v)) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);

      const out = {};
      const keys = Object.keys(v).sort();
      for (const k of keys) {
        const nv = _norm(v[k]);
        if (nv !== undefined) out[k] = nv;
      }
      return out;
    }

    // fallback for other objects (Map/Set/etc.)
    try {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      return _norm(JSON.parse(JSON.stringify(v)));
    } catch {
      return safeStr(v, String(v));
    }
  };

  const normalized = _norm(value);
  return JSON.stringify(normalized);
}

/* ------------------------------ tiny hash (FNV-1a) ------------------------------ */
/**
 * FNV-1a 32-bit hash; returns base36 string.
 * Deterministic and fast; good enough for cache keys.
 */
export function hash32(input) {
  const str = safeStr(input, "");
  let h = 0x811c9dc5; // offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime multiplication (via shifts)
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(36);
}

/* ------------------------------ redaction helpers ------------------------------ */

const DEFAULT_VOLATILE_KEYS = new Set([
  "ts",
  "timestamp",
  "createdAt",
  "updatedAt",
  "resolvedAt",
  "resolvedAtMs",
  "now",
  "nonce",
  "requestId",
  "id",
  "__debug",
  "__trace",
]);

function stripVolatile(obj, options = {}) {
  if (!obj || typeof obj !== "object") return obj;

  const volatileKeys = options.volatileKeys
    ? new Set(Array.from(options.volatileKeys))
    : DEFAULT_VOLATILE_KEYS;

  const maxDepth = clampInt(options.maxDepth ?? 8, 1, 50, 8);

  const seen = new WeakMap();

  const _strip = (v, depth) => {
    if (depth > maxDepth) return "[MaxDepth]";
    if (v == null) return v;
    if (typeof v !== "object") return v;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map((x) => _strip(x, depth + 1));

    if (seen.has(v)) return "[Circular]";
    seen.set(v, true);

    if (isPlainObject(v)) {
      const out = {};
      for (const k of Object.keys(v)) {
        if (volatileKeys.has(k)) continue;
        const nv = _strip(v[k], depth + 1);
        if (nv !== undefined) out[k] = nv;
      }
      return out;
    }

    // other objects
    try {
      return _strip(JSON.parse(JSON.stringify(v)), depth + 1);
    } catch {
      return safeStr(v, String(v));
    }
  };

  return _strip(obj, 0);
}

/* ------------------------------ key building ------------------------------ */

/**
 * Build a normalized "context" chunk for keys.
 * @param {object} ctx
 * @returns {string}
 */
export function ctxKey(ctx = {}) {
  const domain = normalizeToken(
    ctx.domain || ctx.area || ctx.type || "generic"
  );
  const kind = normalizeToken(
    ctx.kind || ctx.intent || ctx.action || "generic"
  );
  const mode = normalizeToken(ctx.mode || ctx.strategy || "default");
  const householdId = safeStr(ctx.householdId || ctx.household_id || "", "");
  const userId = safeStr(ctx.userId || ctx.user_id || "", "");

  // keep IDs as-is (do not lowercase; these are identifiers)
  const h = householdId ? `h:${householdId}` : "h:-";
  const u = userId ? `u:${userId}` : "u:-";
  const d = `d:${domain}`;
  const k = `k:${kind}`;
  const m = `m:${mode}`;

  return [d, k, m, h, u].join("|");
}

/**
 * Key for a reasoner "request" object (normalized + hashed).
 *
 * @param {string} namespace e.g. "reasoner", "budget", "gating"
 * @param {object} ctx e.g. { domain, kind, mode, householdId, userId }
 * @param {object} payload request data to include (will be stripped of volatile keys)
 * @param {object} [options]
 * @returns {string}
 */
export function makeKey(namespace, ctx, payload, options = {}) {
  const ns = normalizeToken(namespace || "reasoner");
  const context = ctxKey(ctx);

  const stripped = stripVolatile(payload, options);
  const body = stableStringify(stripped);

  // hash body to avoid huge keys
  const bodyHash = hash32(body);

  // include a short prefix for debugging/readability
  const prefix = options.prefix ? normalizeToken(options.prefix) : ns;

  // Version included for future migrations
  return `${prefix}:v${VERSION}|${context}|p:${bodyHash}`;
}

/**
 * Sometimes you want a "coarse" key that ignores most payload content.
 * Example: "latest budget snapshot for household X" where payload is irrelevant.
 */
export function makeCoarseKey(namespace, ctx, options = {}) {
  const ns = normalizeToken(namespace || "reasoner");
  const context = ctxKey(ctx);
  const prefix = options.prefix ? normalizeToken(options.prefix) : ns;
  return `${prefix}:v${VERSION}|${context}|p:-`;
}

/**
 * Key for caching by "artifact" (scan/receipt/etc.).
 * Uses artifactId as primary discriminator, plus ctx.
 */
export function makeArtifactKey(namespace, ctx, artifactId, options = {}) {
  const ns = normalizeToken(namespace || "reasoner");
  const context = ctxKey(ctx);
  const prefix = options.prefix ? normalizeToken(options.prefix) : ns;

  const a = safeStr(artifactId || "", "").trim();
  const aid = a ? `a:${a}` : "a:-";
  return `${prefix}:v${VERSION}|${context}|${aid}`;
}

/**
 * Key for caching by "entity" (inventory item, recipe id, etc.).
 */
export function makeEntityKey(
  namespace,
  ctx,
  entityType,
  entityId,
  options = {}
) {
  const ns = normalizeToken(namespace || "reasoner");
  const context = ctxKey(ctx);
  const prefix = options.prefix ? normalizeToken(options.prefix) : ns;

  const et = normalizeToken(entityType || "entity");
  const eid = safeStr(entityId || "", "").trim();

  const idPart = eid ? `id:${eid}` : "id:-";
  return `${prefix}:v${VERSION}|${context}|e:${et}|${idPart}`;
}

/**
 * Create a group key that can be used for invalidation sets.
 * Example: invalidate all "budget" for household X.
 */
export function makeGroupKey(namespace, ctx, options = {}) {
  const ns = normalizeToken(namespace || "reasoner");
  const prefix = options.prefix ? normalizeToken(options.prefix) : ns;
  const context = ctxKey(ctx);
  return `${prefix}:v${VERSION}|${context}`;
}

/**
 * Parse a key back into basic parts (best-effort).
 * Useful for debugging.
 */
export function parseKey(key) {
  const k = safeStr(key, "");
  const out = {
    raw: k,
    prefix: null,
    version: null,
    domain: null,
    kind: null,
    mode: null,
    householdId: null,
    userId: null,
    payloadHash: null,
    artifactId: null,
  };

  if (!k) return out;

  // prefix:v1|d:x|k:y|m:z|h:id|u:id|p:hash OR a:id
  const [prefixPart, ...rest] = k.split("|");
  const m1 = /^([^:]+):v(\d+)/.exec(prefixPart);
  if (m1) {
    out.prefix = m1[1];
    out.version = Number(m1[2]);
  }

  for (const part of rest) {
    if (part.startsWith("d:")) out.domain = part.slice(2);
    else if (part.startsWith("k:")) out.kind = part.slice(2);
    else if (part.startsWith("m:")) out.mode = part.slice(2);
    else if (part.startsWith("h:")) out.householdId = part.slice(2);
    else if (part.startsWith("u:")) out.userId = part.slice(2);
    else if (part.startsWith("p:")) out.payloadHash = part.slice(2);
    else if (part.startsWith("a:")) out.artifactId = part.slice(2);
  }

  // Normalize "-" placeholders
  if (out.householdId === "-") out.householdId = null;
  if (out.userId === "-") out.userId = null;
  if (out.payloadHash === "-") out.payloadHash = null;
  if (out.artifactId === "-") out.artifactId = null;

  return out;
}

/* ------------------------------ back-compat exports ------------------------------ */
/**
 * Back-compat named export expected by some runtime code:
 *   import { buildReasonerCacheKey } from "./cache/keys";
 */
export function buildReasonerCacheKey(args = {}) {
  const a = args || {};

  // If caller already provided ctx/payload, honor them.
  const ctx =
    a.ctx && typeof a.ctx === "object"
      ? a.ctx
      : {
          domain: a.domain,
          kind: a.intent || a.kind,
          mode: a.mode,
          householdId: a.householdId,
          userId: a.userId,
        };

  const payload =
    a.payload && typeof a.payload === "object"
      ? a.payload
      : {
          domain: a.domain,
          intent: a.intent || a.kind,
          mode: a.mode,
          input: a.input,
          context: a.context,
          policy: a.policy,
          evidence: a.evidence,
          runtime: a.runtime,
        };

  const namespace = a.namespace || "reasoner";
  const options = a.options && typeof a.options === "object" ? a.options : {};

  return makeKey(namespace, ctx, payload, { prefix: namespace, ...options });
}

/**
 * Back-compat: storehouse shim expects makeStorehouseCacheKey().
 */
export function makeStorehouseCacheKey(ctx = {}, payload = {}, options = {}) {
  const c = {
    ...ctx,
    domain: ctx.domain || "storehouse",
    kind: ctx.kind || ctx.intent || "storehouse",
    mode: ctx.mode || "default",
  };

  const p = isPlainObject(payload) ? payload : { value: payload };

  return makeKey("storehouse", c, p, { prefix: "storehouse", ...options });
}

/**
 * Back-compat: procurement shim expects makeProcurementCacheKey().
 */
export function makeProcurementCacheKey(ctx = {}, payload = {}, options = {}) {
  const c = {
    ...ctx,
    domain: ctx.domain || "procurement",
    kind: ctx.kind || ctx.intent || "procurement",
    mode: ctx.mode || "default",
  };

  const p = isPlainObject(payload) ? payload : { value: payload };

  return makeKey("procurement", c, p, { prefix: "procurement", ...options });
}

/**
 * Back-compat: recipeConsolidator shim expects makeRecipeConsolidatorCacheKey().
 */
export function makeRecipeConsolidatorCacheKey(
  ctx = {},
  payload = {},
  options = {}
) {
  const c = {
    ...ctx,
    domain: ctx.domain || "recipe-consolidator",
    kind: ctx.kind || ctx.intent || "recipe-consolidator",
    mode: ctx.mode || "default",
  };

  const p = isPlainObject(payload) ? payload : { value: payload };

  return makeKey("recipeConsolidator", c, p, {
    prefix: "recipeConsolidator",
    ...options,
  });
}

/**
 * Back-compat: if anything expects a generic "makeReasonerCacheKey".
 */
export function makeReasonerCacheKey(ctx = {}, payload = {}, options = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const p = isPlainObject(payload) ? payload : { value: payload };
  return makeKey("reasoner", c, p, { prefix: "reasoner", ...options });
}

/**
 * Back-compat: sabab shim expects makeSababCacheKey().
 * Provide a stable key builder that namespaces by "sabab" but otherwise uses the same
 * deterministic normalization + hashing strategy.
 */
export function makeSababCacheKey(ctx = {}, payload = {}, options = {}) {
  const c = {
    ...safeObject(ctx),
    domain: ctx?.domain || "sabab",
    kind: ctx?.kind || ctx?.intent || "sabab",
    mode: ctx?.mode || "default",
  };

  const p = isPlainObject(payload) ? payload : { value: payload };

  return makeKey("sabab", c, p, { prefix: "sabab", ...options });
}

/**
 * Back-compat: sausage shim expects makeSausageCacheKey().
 * Provide a stable key builder that namespaces by "sausage" but otherwise uses
 * the same deterministic normalization + hashing strategy.
 */
export function makeSausageCacheKey(ctx = {}, payload = {}, options = {}) {
  const c = {
    ...safeObject(ctx),
    domain: ctx?.domain || "sausage",
    kind: ctx?.kind || ctx?.intent || "sausage",
    mode: ctx?.mode || "default",
  };

  const p = isPlainObject(payload) ? payload : { value: payload };

  return makeKey("sausage", c, p, { prefix: "sausage", ...options });
}

/**
 * Back-compat: shopping shim expects makeShoppingCacheKey().
 * Provide a stable key builder that namespaces by "shopping" but otherwise uses
 * the same deterministic normalization + hashing strategy.
 */
export function makeShoppingCacheKey(ctx = {}, payload = {}, options = {}) {
  const c = {
    ...safeObject(ctx),
    domain: ctx?.domain || "shopping",
    kind: ctx?.kind || ctx?.intent || "shopping",
    mode: ctx?.mode || "default",
  };

  const p = isPlainObject(payload) ? payload : { value: payload };

  return makeKey("shopping", c, p, { prefix: "shopping", ...options });
}

/**
 * Back-compat: soilAndWater shim expects makeSoilWaterCacheKey().
 * Provide a stable key builder that namespaces by "soilWater" (prefix),
 * while using a readable domain token "soil-water".
 */
export function makeSoilWaterCacheKey(ctx = {}, payload = {}, options = {}) {
  const c = {
    ...safeObject(ctx),
    domain: ctx?.domain || "soil-water",
    kind: ctx?.kind || ctx?.intent || "soil-water",
    mode: ctx?.mode || "default",
  };

  const p = isPlainObject(payload) ? payload : { value: payload };

  // namespace/prefix kept short + consistent
  return makeKey("soilWater", c, p, { prefix: "soilWater", ...options });
}

/**
 * Back-compat: spice shim expects makeSpiceCacheKey().
 * Provide a stable key builder that namespaces by "spice" but otherwise uses
 * the same deterministic normalization + hashing strategy.
 */
export function makeSpiceCacheKey(ctx = {}, payload = {}, options = {}) {
  const c = {
    ...safeObject(ctx),
    domain: ctx?.domain || "spice",
    kind: ctx?.kind || ctx?.intent || "spice",
    mode: ctx?.mode || "default",
  };

  const p = isPlainObject(payload) ? payload : { value: payload };

  return makeKey("spice", c, p, { prefix: "spice", ...options });
}

/**
 * Back-compat: wasteToCompost shim expects makeWasteToCompostCacheKey().
 * Provide a stable key builder that namespaces by "wasteToCompost" (prefix),
 * while using a readable domain token "waste-to-compost".
 */
export function makeWasteToCompostCacheKey(
  ctx = {},
  payload = {},
  options = {}
) {
  const c = {
    ...safeObject(ctx),
    domain: ctx?.domain || "waste-to-compost",
    kind: ctx?.kind || ctx?.intent || "waste-to-compost",
    mode: ctx?.mode || "default",
  };

  const p = isPlainObject(payload) ? payload : { value: payload };

  return makeKey("wasteToCompost", c, p, {
    prefix: "wasteToCompost",
    ...options,
  });
}

/* -------------------------------------------------------------------------- */
/* tiny local helper used only below                                           */
/* -------------------------------------------------------------------------- */
function safeObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/* ------------------------------ exports (convenience) ------------------------------ */

export const ReasonerCacheKeys = {
  VERSION,
  stableStringify,
  hash32,
  ctxKey,
  makeKey,
  makeCoarseKey,
  makeArtifactKey,
  makeEntityKey,
  makeGroupKey,
  parseKey,
  buildReasonerCacheKey,
  makeStorehouseCacheKey,
  makeProcurementCacheKey,
  makeRecipeConsolidatorCacheKey,
  makeReasonerCacheKey,
  makeSababCacheKey,
  makeSausageCacheKey,
  makeShoppingCacheKey,
  makeSoilWaterCacheKey,
  makeSpiceCacheKey,
  makeWasteToCompostCacheKey,
};

export default ReasonerCacheKeys;
