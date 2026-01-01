/**
 * @file src/agents/cache/keys.js
 *
 * Hash/key builder for cached reasoning in Suka Smart Assistant (SSA).
 *
 * HOW THIS FITS:
 * - This module centralizes how we build cache keys for *reasoned* outputs:
 *   - Session composition (cooking, cleaning, garden, animals, preservation, storehouse)
 *   - Guard evaluations / feasibility checks
 *   - Swap suggestions and “Now” resolvers
 * - It ensures that all agents that participate in memoization use the same
 *   stable hashing & namespacing scheme, so:
 *   - memo.js, Reasoner wrappers, and Dexie-backed caches stay in sync.
 *   - Keys are deterministic and debuggable.
 *
 * FORMAT (canonical key example):
 *   ssa:v1:sessions:session.compose.cooking:v2:user-123:fam1:risk-high:conf-high:fpr-abc|kz9w3m
 *
 * Where:
 *   - `ssa:v1`            global namespace & version
 *   - `sessions`          domain
 *   - `session.compose.cooking`  intent
 *   - `v2`                variant / model/agent version
 *   - `user-123`          per-user scope (hashed or pseudonymous)
 *   - `fam1`              familyFundMode enabled
 *   - `risk-high`         risk level
 *   - `conf-high`         confidence label
 *   - `fpr-abc`           fingerprint of environment/context
 *   - `kz9w3m`            hash of serialized payload + env
 */

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {'low'|'medium'|'high'|'critical'} RiskLevel
 */

/**
 * @typedef {'high'|'medium'|'low'|'veryLow'|''} ConfidenceLabel
 */

/**
 * Core key parts for reasoning cache keys.
 *
 * NOTE:
 * - `userId` should already be anonymized/hashed by the caller if needed.
 * - `fingerprint` can be a short env hash (locale, tz, feature flags, etc.).
 *
 * @typedef {Object} ReasoningKeyParts
 * @property {string} domain               SSA domain, e.g. 'sessions', 'imports'
 * @property {string} intent               Intent key, e.g. 'session.compose.cooking'
 * @property {string} [variant]            Optional variant/version label, e.g. 'v1', 'lowPower'
 * @property {string} [userId]             Optional per-user scope; default 'anon'
 * @property {boolean} [familyFundMode]    If true, key is scoped to Hub-enabled mode
 * @property {RiskLevel} [riskLevel]       Risk classification (from confidence policy)
 * @property {ConfidenceLabel} [confidenceLabel] Confidence label (from confidence policy)
 * @property {string} [fingerprint]        Optional short string derived from environment
 * @property {string[]} [tags]             Optional free-form tags; will be sorted & joined
 */

/**
 * Options for building a reasoning key.
 *
 * @typedef {Object} ReasoningKeyOptions
 * @property {string} [namespace]          Global namespace prefix; default 'ssa'
 * @property {string} [schemaVersion]      High-level schema version; default 'v1'
 */

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build a canonical cache key for Reasoner / heavy reasoning results.
 *
 * The payload is serialized via stable JSON (deterministic key ordering)
 * and hashed to avoid overly long keys, but we still keep human-readable
 * prefixes for debugging and metrics.
 *
 * Example:
 * ```js
 * import { buildReasoningKey } from '../../agents/cache/keys';
 *
 * const key = buildReasoningKey(
 *   {
 *     domain: 'sessions',
 *     intent: 'session.compose.cooking',
 *     variant: 'v2',
 *     userId: 'user-123',
 *     familyFundMode: true,
 *     riskLevel: 'high',
 *     confidenceLabel: 'medium',
 *     fingerprint: 'tz-ct-locale-enUS',
 *     tags: ['desktop', 'batch']
 *   },
 *   { recipeId: 'r-abc', servings: 6 }
 * );
 * ```
 *
 * @param {ReasoningKeyParts} parts
 * @param {any} payload
 * @param {ReasoningKeyOptions} [options]
 * @returns {string}
 */
export function buildReasoningKey(parts, payload, options = {}) {
  const ns = typeof options.namespace === 'string' && options.namespace.trim()
    ? options.namespace.trim()
    : 'ssa';

  const schemaVersion = typeof options.schemaVersion === 'string' && options.schemaVersion.trim()
    ? options.schemaVersion.trim()
    : 'v1';

  const safeDomain = normalizeSegment(parts.domain, 'unknown-domain');
  const safeIntent = normalizeSegment(parts.intent, 'unknown-intent');
  const variant = normalizeSegment(parts.variant || 'default', 'default');
  const userId = normalizeSegment(parts.userId || 'anon', 'anon');

  const famSegment = parts.familyFundMode ? 'fam1' : 'fam0';
  const riskSegment = parts.riskLevel ? `risk-${parts.riskLevel}` : 'risk-unk';

  const confLabel = parts.confidenceLabel || '';
  const confSegment = confLabel ? `conf-${confLabel}` : 'conf-unk';

  const fingerprintSegment = parts.fingerprint
    ? `fpr-${compactString(parts.fingerprint)}`
    : 'fpr-none';

  const tagsSegment = Array.isArray(parts.tags) && parts.tags.length
    ? `tags-${compactString(parts.tags.slice().sort().join(','))}`
    : 'tags-none';

  const payloadStr = stableStringify(payload);
  const payloadHash = simpleHash(payloadStr);

  // key layout:
  //   {ns}:{schemaVersion}:{domain}:{intent}:{variant}:{userId}:
  //   {famSegment}:{riskSegment}:{confSegment}:{fingerprintSegment}:{tagsSegment}|{payloadHash}
  return [
    `${ns}:${schemaVersion}`,
    safeDomain,
    safeIntent,
    variant,
    userId,
    famSegment,
    riskSegment,
    confSegment,
    fingerprintSegment,
    tagsSegment
  ].join(':') + '|' + payloadHash;
}

/**
 * Convenience builder when you have raw pieces instead of a ReasoningKeyParts
 * object. Primarily helpful when wiring inside small agents.
 *
 * @param {string} domain
 * @param {string} intent
 * @param {any} payload
 * @param {Partial<ReasoningKeyParts> & ReasoningKeyOptions} [extras]
 * @returns {string}
 */
export function makeReasoningKey(domain, intent, payload, extras = {}) {
  const { namespace, schemaVersion, ...rest } = extras;
  return buildReasoningKey(
    {
      domain,
      intent,
      ...rest
    },
    payload,
    { namespace, schemaVersion }
  );
}

/**
 * Serialize key parts (without payload hash) in a human-readable form.
 * Useful for logging / debugging when you want to inspect what scopes
 * were used to build a key.
 *
 * @param {ReasoningKeyParts} parts
 * @param {ReasoningKeyOptions} [options]
 * @returns {string}
 */
export function describeKeyParts(parts, options = {}) {
  const ns = options.namespace || 'ssa';
  const schemaVersion = options.schemaVersion || 'v1';

  const tags = Array.isArray(parts.tags) && parts.tags.length
    ? parts.tags.slice().sort().join(',')
    : '';

  return JSON.stringify({
    ns,
    schemaVersion,
    domain: parts.domain,
    intent: parts.intent,
    variant: parts.variant || 'default',
    userId: parts.userId || 'anon',
    familyFundMode: !!parts.familyFundMode,
    riskLevel: parts.riskLevel || 'medium',
    confidenceLabel: parts.confidenceLabel || 'unknown',
    fingerprint: parts.fingerprint || '',
    tags
  });
}

/* -------------------------------------------------------------------------- */
/*  Shared utilities (exported for memo.js & others)                          */
/* -------------------------------------------------------------------------- */

/**
 * Stable JSON stringify: sorts object keys recursively so we don't get
 * different cache keys from different key orders in the input payload.
 *
 * This is intentionally simple and deterministic (not super optimized).
 *
 * @param {any} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * Simple non-cryptographic string hash.
 *
 * - Fast enough for building short key suffixes.
 * - NOT suitable for security-sensitive hashing; only for cache keys.
 *
 * @param {string} str
 * @returns {string}
 */
export function simpleHash(str) {
  if (typeof str !== 'string' || !str.length) return '0';

  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0; // 31-based rolling hash
  }
  return Math.abs(hash).toString(36);
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a key segment: trim, replace unsafe chars, and ensure a
 * non-empty fallback.
 *
 * Only allows [a-zA-Z0-9._-]; other chars become '-'.
 *
 * @param {string} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeSegment(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * Compact arbitrary strings to a shorter, safe form appropriate for
 * key segments by hashing when needed.
 *
 * - If string is short and safe, return as-is.
 * - If long or contains unsafe characters, return a short hash prefix.
 *
 * @param {string} str
 * @returns {string}
 */
function compactString(str) {
  if (typeof str !== 'string') return '';
  const safe = str.trim();
  if (!safe) return '';
  if (safe.length <= 32 && /^[a-zA-Z0-9._-]+$/.test(safe)) {
    return safe;
  }
  return simpleHash(safe).slice(0, 8);
}
