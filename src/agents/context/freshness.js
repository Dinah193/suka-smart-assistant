/**
 * @file src/agents/context/freshness.js
 *
 * Dataset freshness / staleness policy rules for SSA reasoning.
 *
 * HOW THIS FITS:
 * - Before Reasoner work or cache reuse, SSA needs to know:
 *   - Is the existing Dexie / in-memory data FRESH enough?
 *   - Should we REFETCH (and if so, can it be background or must be blocking)?
 * - This module centralizes those rules so:
 *   - Session composition, guard evaluation, “Now” resolvers, etc. behave
 *     consistently across the app.
 *   - Different dataset kinds (weather vs inventory vs sessions) can have
 *     different TTLs and refresh strategies.
 *
 * TYPICAL USE:
 * ```js
 * import { evaluateDatasetFreshness } from '../../agents/context/freshness';
 *
 * const decision = await evaluateDatasetFreshness({
 *   kind: 'weather',
 *   domain: 'garden',
 *   lastUpdatedAt: lastWeatherIso,
 *   source: 'dexie'
 * });
 *
 * if (decision.shouldRefresh && decision.strategy === 'blocking') {
 *   await refreshWeather();
 * }
 * ```
 */

import { emit } from "../../services/events/eventBus";
import * as featureFlagsModule from "../../config/featureFlags";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {'sessions'|'inventory'|'weather'|'guards'|'calendar'|'imports'|'settings'} DatasetKind
 */

/**
 * @typedef {'fresh'|'soft-stale'|'hard-stale'|'unknown'} FreshnessState
 */

/**
 * @typedef {'none'|'background'|'blocking'} RefreshStrategy
 */

/**
 * Description of a dataset whose freshness we want to evaluate.
 *
 * NOTE:
 * - `lastUpdatedAt` should be an ISO string coming from Dexie or network.
 * - `ttlMs` / `hardTtlMs` allow overriding defaults on a per-dataset basis.
 *
 * @typedef {Object} DatasetDescriptor
 * @property {DatasetKind} kind
 * @property {'cooking'|'cleaning'|'garden'|'animals'|'preservation'|'storehouse'|'global'} [domain]
 * @property {string|null} [lastUpdatedAt]  ISO 8601 timestamp or null if unknown
 * @property {string} [source]              'dexie' | 'network' | 'sensor' | 'static' | 'unknown'
 * @property {number} [ttlMs]              Soft TTL override in ms
 * @property {number} [hardTtlMs]          Hard TTL override in ms
 * @property {boolean} [critical]          If true, we lean toward blocking refresh
 * @property {string} [id]                 Optional identifier for telemetry
 */

/**
 * Result of evaluating freshness for a dataset.
 *
 * @typedef {Object} FreshnessDecision
 * @property {FreshnessState} state
 * @property {boolean} shouldRefresh
 * @property {RefreshStrategy} strategy
 * @property {number} ageMs
 * @property {number} ttlMs
 * @property {number} hardTtlMs
 * @property {string} reason
 * @property {DatasetDescriptor} descriptor
 */

/* -------------------------------------------------------------------------- */
/*  Defaults by dataset kind                                                  */
/* -------------------------------------------------------------------------- */

// NOTE: these defaults are conservative and can be tuned as real usage emerges.
// ttlMs = "soft" TTL where we *prefer* to refresh, but can still use stale data
// hardTtlMs = "hard" TTL where we consider data too stale to trust.

/** @type {Record<DatasetKind, { ttlMs: number, hardTtlMs: number, critical: boolean }>} */
const KIND_DEFAULTS = {
  sessions: {
    ttlMs: 1 * 60 * 1000, // 1 minute
    hardTtlMs: 10 * 60 * 1000, // 10 minutes
    critical: true, // session state should be reliable
  },
  inventory: {
    ttlMs: 10 * 60 * 1000, // 10 minutes
    hardTtlMs: 60 * 60 * 1000, // 1 hour
    critical: true,
  },
  weather: {
    ttlMs: 5 * 60 * 1000, // 5 minutes
    hardTtlMs: 30 * 60 * 1000, // 30 minutes
    critical: false,
  },
  guards: {
    ttlMs: 60 * 60 * 1000, // 1 hour
    hardTtlMs: 24 * 60 * 60 * 1000, // 24 hours
    critical: true,
  },
  calendar: {
    ttlMs: 30 * 60 * 1000, // 30 minutes
    hardTtlMs: 6 * 60 * 60 * 1000, // 6 hours
    critical: false,
  },
  imports: {
    ttlMs: 24 * 60 * 60 * 1000, // 1 day
    hardTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    critical: false,
  },
  settings: {
    ttlMs: 24 * 60 * 60 * 1000, // 1 day
    hardTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    critical: false,
  },
};

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate freshness for a single dataset descriptor.
 *
 * - Applies kind-specific defaults.
 * - Combines with any per-descriptor overrides.
 * - Looks at `lastUpdatedAt` to determine age.
 * - Considers global feature flags (e.g., familyFundMode) to bias strategy.
 *
 * @param {DatasetDescriptor} descriptor
 * @param {Date} [nowDate]
 * @returns {Promise<FreshnessDecision>}
 */
export async function evaluateDatasetFreshness(descriptor, nowDate) {
  const now = nowDate instanceof Date ? nowDate : new Date();
  const nowMs = now.getTime();

  const normalized = normalizeDescriptor(descriptor);
  const ageMs = computeAgeMs(normalized.lastUpdatedAt, nowMs);

  const { ttlMs, hardTtlMs } = getEffectiveTtls(normalized);
  const baseState = classifyAge(ageMs, ttlMs, hardTtlMs);
  const flags = await safeGetFeatureFlagsSnapshot();

  const biased = applyFeatureFlagBias({
    state: baseState,
    descriptor: normalized,
    ttlMs,
    hardTtlMs,
    ageMs,
    flags,
  });

  safeEmitFreshnessEvaluated(biased);
  return biased;
}

/**
 * Convenience helper when evaluating multiple datasets at once.
 *
 * @param {DatasetDescriptor[]} descriptors
 * @param {Date} [nowDate]
 * @returns {Promise<FreshnessDecision[]>}
 */
export async function evaluateMultipleDatasets(descriptors, nowDate) {
  const now = nowDate instanceof Date ? nowDate : new Date();
  const decisions = [];

  for (const d of descriptors || []) {
    try {
      const decision = await evaluateDatasetFreshness(d, now);
      decisions.push(decision);
    } catch (err) {
      safeEmitFreshnessError("evaluateMultiple", err, d);
      // Even on error, push a conservative decision so callers can degrade gracefully.
      const normalized = normalizeDescriptor(d);
      decisions.push({
        state: "unknown",
        shouldRefresh: true,
        strategy: normalized.critical ? "blocking" : "background",
        ageMs: Number.NaN,
        ttlMs: 0,
        hardTtlMs: 0,
        reason: "error-evaluating-freshness",
        descriptor: normalized,
      });
    }
  }

  return decisions;
}

/* -------------------------------------------------------------------------- */
/*  Core policy logic                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Normalize descriptor, fill defaults for missing fields.
 *
 * @param {DatasetDescriptor} raw
 * @returns {DatasetDescriptor}
 */
function normalizeDescriptor(raw) {
  const kind = raw?.kind || "settings";
  const defaults = KIND_DEFAULTS[kind] || KIND_DEFAULTS.settings;

  return {
    kind,
    domain: raw.domain || "global",
    lastUpdatedAt: raw.lastUpdatedAt || null,
    source: raw.source || "unknown",
    ttlMs:
      typeof raw.ttlMs === "number" && raw.ttlMs > 0
        ? raw.ttlMs
        : defaults.ttlMs,
    hardTtlMs:
      typeof raw.hardTtlMs === "number" && raw.hardTtlMs >= raw.ttlMs
        ? raw.hardTtlMs
        : defaults.hardTtlMs,
    critical:
      typeof raw.critical === "boolean" ? raw.critical : !!defaults.critical,
    id: raw.id || `${kind}:${raw.domain || "global"}`,
  };
}

/**
 * Compute age of data in ms given lastUpdatedAt ISO.
 *
 * @param {string|null|undefined} lastUpdatedAt
 * @param {number} nowMs
 * @returns {number}
 */
function computeAgeMs(lastUpdatedAt, nowMs) {
  if (!lastUpdatedAt) return Number.POSITIVE_INFINITY;
  const t = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  const age = nowMs - t;
  return age < 0 ? 0 : age;
}

/**
 * Get effective TTLs for a descriptor. Ensures hardTtlMs >= ttlMs.
 *
 * @param {DatasetDescriptor} descriptor
 * @returns {{ ttlMs: number, hardTtlMs: number }}
 */
function getEffectiveTtls(descriptor) {
  const ttlMs =
    typeof descriptor.ttlMs === "number" && descriptor.ttlMs > 0
      ? descriptor.ttlMs
      : KIND_DEFAULTS[descriptor.kind].ttlMs;

  const hardTtlMsCandidate =
    typeof descriptor.hardTtlMs === "number" && descriptor.hardTtlMs > 0
      ? descriptor.hardTtlMs
      : KIND_DEFAULTS[descriptor.kind].hardTtlMs;

  const hardTtlMs = Math.max(ttlMs, hardTtlMsCandidate);

  return { ttlMs, hardTtlMs };
}

/**
 * Classify age into freshness state given TTLs.
 *
 * @param {number} ageMs
 * @param {number} ttlMs
 * @param {number} hardTtlMs
 * @returns {FreshnessState}
 */
function classifyAge(ageMs, ttlMs, hardTtlMs) {
  if (!Number.isFinite(ageMs)) return "unknown";
  if (ageMs <= ttlMs) return "fresh";
  if (ageMs <= hardTtlMs) return "soft-stale";
  return "hard-stale";
}

/**
 * Combine base state + feature flags into a final decision.
 *
 * - familyFundMode → be a bit more conservative for critical datasets.
 * - For non-critical datasets, we prefer background refresh when soft-stale.
 *
 * @param {{
 *   state: FreshnessState,
 *   descriptor: DatasetDescriptor,
 *   ageMs: number,
 *   ttlMs: number,
 *   hardTtlMs: number,
 *   flags: Record<string, any>
 * }} input
 * @returns {FreshnessDecision}
 */
function applyFeatureFlagBias(input) {
  const { state, descriptor, ageMs, ttlMs, hardTtlMs, flags } = input;

  const familyFund = !!flags.familyFundMode;
  let shouldRefresh = false;
  /** @type {RefreshStrategy} */
  let strategy = "none";
  let reason = "";

  switch (state) {
    case "fresh":
      shouldRefresh = false;
      strategy = "none";
      reason = "within-soft-ttl";
      break;
    case "soft-stale":
      if (descriptor.critical || familyFund) {
        shouldRefresh = true;
        strategy = "blocking";
        reason = "soft-stale-critical-or-familyFund";
      } else {
        shouldRefresh = true;
        strategy = "background";
        reason = "soft-stale-noncritical";
      }
      break;
    case "hard-stale":
      shouldRefresh = true;
      strategy = descriptor.critical ? "blocking" : "background";
      reason = descriptor.critical
        ? "hard-stale-critical"
        : "hard-stale-noncritical";
      break;
    case "unknown":
    default:
      // Unknown freshness → conservative: refresh for critical datasets.
      if (descriptor.critical || familyFund) {
        shouldRefresh = true;
        strategy = "blocking";
        reason = "unknown-age-critical";
      } else {
        shouldRefresh = true;
        strategy = "background";
        reason = "unknown-age-noncritical";
      }
      break;
  }

  // Additional domain-specific nuance:
  // - For weather used in garden/preservation sessions: lean more aggressive.
  if (
    descriptor.kind === "weather" &&
    (descriptor.domain === "garden" || descriptor.domain === "preservation")
  ) {
    if (state === "soft-stale") {
      shouldRefresh = true;
      strategy = "blocking";
      reason = "soft-stale-weather-critical-domain";
    }
  }

  // - For sessions: if source is "dexie" and age is very small (< 10s),
  //   allow using as-is even if TTL is technically exceeded (e.g. clock skew).
  if (
    descriptor.kind === "sessions" &&
    state !== "fresh" &&
    descriptor.source === "dexie" &&
    ageMs < 10_000
  ) {
    shouldRefresh = false;
    strategy = "none";
    reason = "sessions-recent-dexie-skew-override";
  }

  return {
    state,
    shouldRefresh,
    strategy,
    ageMs,
    ttlMs,
    hardTtlMs,
    reason,
    descriptor,
  };
}

/* -------------------------------------------------------------------------- */
/*  Feature flags snapshot helper                                             */
/* -------------------------------------------------------------------------- */

/**
 * Try to get a snapshot of feature flags in a defensive way.
 *
 * @returns {Promise<Record<string, any>>}
 */
async function safeGetFeatureFlagsSnapshot() {
  try {
    if (typeof featureFlagsModule.snapshotFlags === "function") {
      return await featureFlagsModule.snapshotFlags();
    }
    if (typeof featureFlagsModule.getAllFeatureFlags === "function") {
      return await featureFlagsModule.getAllFeatureFlags();
    }
    if (typeof featureFlagsModule.getFeatureFlags === "function") {
      return await featureFlagsModule.getFeatureFlags();
    }
    if (
      featureFlagsModule.default &&
      typeof featureFlagsModule.default === "object"
    ) {
      return featureFlagsModule.default;
    }

    /** @type {Record<string, any>} */
    const fallback = {};
    if ("familyFundMode" in featureFlagsModule) {
      fallback.familyFundMode = !!featureFlagsModule.familyFundMode;
    }
    return fallback;
  } catch {
    return {};
  }
}

/* -------------------------------------------------------------------------- */
/*  Telemetry                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Emit a telemetry event when freshness is evaluated.
 *
 * @param {FreshnessDecision} decision
 */
function safeEmitFreshnessEvaluated(decision) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "context.freshness.evaluated",
      ts: new Date().toISOString(),
      source: "agents.context.freshness",
      data: {
        descriptor: decision.descriptor,
        state: decision.state,
        shouldRefresh: decision.shouldRefresh,
        strategy: decision.strategy,
        ageMs: decision.ageMs,
        ttlMs: decision.ttlMs,
        hardTtlMs: decision.hardTtlMs,
        reason: decision.reason,
      },
    });
  } catch {
    // Never break callers on telemetry issues.
  }
}

/**
 * Emit a telemetry event when freshness evaluation fails.
 *
 * @param {string} scope
 * @param {any} err
 * @param {DatasetDescriptor} [descriptor]
 */
function safeEmitFreshnessError(scope, err, descriptor) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "context.freshness.error",
      ts: new Date().toISOString(),
      source: "agents.context.freshness",
      data: {
        scope,
        error: String(err),
        descriptor: descriptor || null,
      },
    });
  } catch {
    // swallow
  }
}
