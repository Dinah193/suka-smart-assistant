// C:\Users\larho\suka-smart-assistant\src\services\planningGraph\planningGraphLoader.js

/**
 * Planning Graph Loader
 *
 * How this fits:
 * - Central loader for SSA’s “Planning Graph” JSON files:
 *   imports → calculators → automation → sessions → analytics.
 * - Handles:
 *   • Versioning (multiple versions per graphId, semver-like).
 *   • Future feature-flagged variants or familyFundMode overrides.
 *   • Emitting events when graphs are loaded or when version issues occur.
 *
 * Typical usage:
 *   import {
 *     loadPlanningGraph,
 *     getRegisteredPlanningGraphs,
 *     registerPlanningGraphSource,
 *   } from "@/services/planningGraph/planningGraphLoader";
 *
 *   // Option 1: use default/latest version
 *   const graph = await loadPlanningGraph("core.household");
 *
 *   // Option 2: pin to a version or minimum version
 *   const graph = await loadPlanningGraph("core.household", {
 *     version: "1.1.0",
 *     minVersion: "1.0.0",
 *   });
 *
 * JSON shape (recommended, but loader is tolerant):
 *   {
 *     "meta": {
 *       "id": "core.household",
 *       "label": "Core Household Planning Graph",
 *       "version": "1.1.0",
 *       "domain": "multi",
 *       "createdAt": "2025-11-25T00:00:00.000Z",
 *       "updatedAt": "2025-11-25T00:00:00.000Z",
 *       "description": "Connects calculators, sessions, and storehouse goals."
 *     },
 *     "nodes": [ ... ],
 *     "edges": [ ... ],
 *     "schemas": { ... }
 *   }
 */

import eventBus from "@/services/events/eventBus";
import featureFlags from "@/config/featureFlags";

/**
 * @typedef {Object} PlanningGraphMeta
 * @property {string} id
 * @property {string} label
 * @property {string} version
 * @property {string} [domain]
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 * @property {string} [description]
 */

/**
 * @typedef {Object} LoadedPlanningGraph
 * @property {string} id
 * @property {string} version
 * @property {PlanningGraphMeta} meta
 * @property {any} data
 */

/**
 * @typedef {Object} PlanningGraphVersionConfig
 * @property {() => Promise<any>} loader  - async function that resolves to the JSON (or { default: json } depending on bundler)
 * @property {PlanningGraphMeta} [meta]   - optional static meta override (otherwise taken from JSON.meta)
 */

/**
 * @typedef {Object} PlanningGraphSourceConfig
 * @property {string} id
 * @property {string} label
 * @property {string} [defaultVersion]
 * @property {string} [domain]
 * @property {Object.<string, PlanningGraphVersionConfig>} versions  // version -> config
 */

/**
 * @typedef {Object} LoadOptions
 * @property {string} [version]        - requested specific version (e.g. "1.1.0")
 * @property {string} [minVersion]     - minimum acceptable version (semver-ish)
 * @property {boolean} [preferLatest]  - if true, always take the highest version available
 */

/** ------------------------------------------------------------------------
 *  Internal registry
 * --------------------------------------------------------------------- */

/**
 * Internal registry of Planning Graph sources.
 * - Key: graphId
 * - Value: PlanningGraphSourceConfig
 *
 * Seed is empty; register graphs either:
 * - in a central bootstrap file, or
 * - near the JSON definitions, via registerPlanningGraphSource().
 *
 * Example (add in an app bootstrap, *not* here, to avoid broken imports):
 *
 *   import coreV1 from "@/data/planningGraph/core.v1.json";
 *   import coreV1_1 from "@/data/planningGraph/core.v1_1.json";
 *
 *   registerPlanningGraphSource("core.household", {
 *     id: "core.household",
 *     label: "Core Household Planning Graph",
 *     defaultVersion: "1.1.0",
 *     domain: "multi",
 *     versions: {
 *       "1.0.0": { loader: async () => coreV1 },
 *       "1.1.0": { loader: async () => coreV1_1 },
 *     },
 *   });
 */

/** @type {Map<string, PlanningGraphSourceConfig>} */
const GRAPH_SOURCES = new Map();

/** ------------------------------------------------------------------------
 *  Public API: registration & discovery
 * --------------------------------------------------------------------- */

/**
 * Register a Planning Graph source and its versions.
 * Can be called multiple times to extend/override an existing graphId.
 *
 * @param {string} graphId
 * @param {PlanningGraphSourceConfig} config
 */
export function registerPlanningGraphSource(graphId, config) {
  if (!graphId || typeof graphId !== "string") {
    throw new Error(
      "[planningGraphLoader] graphId is required for registration"
    );
  }
  if (!config || typeof config !== "object") {
    throw new Error("[planningGraphLoader] config object is required");
  }
  if (!config.versions || typeof config.versions !== "object") {
    throw new Error("[planningGraphLoader] config.versions is required");
  }

  /** @type {PlanningGraphSourceConfig} */
  const normalized = {
    id: config.id || graphId,
    label: config.label || graphId,
    domain: config.domain,
    defaultVersion: config.defaultVersion,
    versions: config.versions,
  };

  GRAPH_SOURCES.set(graphId, normalized);
}

/**
 * Get a snapshot of all registered graphs and their versions.
 *
 * @returns {Array<{ id: string, label: string, domain?: string, versions: string[], defaultVersion?: string }>}
 */
export function getRegisteredPlanningGraphs() {
  const list = [];
  for (const [id, cfg] of GRAPH_SOURCES.entries()) {
    list.push({
      id,
      label: cfg.label,
      domain: cfg.domain,
      defaultVersion: cfg.defaultVersion,
      versions: Object.keys(cfg.versions || {}).sort(compareSemver),
    });
  }
  return list;
}

/** ------------------------------------------------------------------------
 *  Public API: loading
 * --------------------------------------------------------------------- */

/**
 * Load a Planning Graph JSON by id with optional version constraints.
 *
 * @param {string} graphId
 * @param {LoadOptions} [options]
 * @returns {Promise<LoadedPlanningGraph>}
 */
export async function loadPlanningGraph(graphId, options = {}) {
  const { version, minVersion, preferLatest } = options || {};

  if (!graphId || typeof graphId !== "string") {
    throw new Error("[planningGraphLoader] graphId is required");
  }

  const sourceConfig = GRAPH_SOURCES.get(graphId);
  if (!sourceConfig) {
    const err = new Error(
      `[planningGraphLoader] No Planning Graph registered for id '${graphId}'`
    );
    emitLoadFailed(graphId, null, err);
    throw err;
  }

  const resolvedVersion = resolveVersionForLoad(sourceConfig, {
    version,
    minVersion,
    preferLatest,
  });

  if (!resolvedVersion) {
    const err = new Error(
      `[planningGraphLoader] Could not resolve a compatible version for '${graphId}' ` +
        `(requested: ${version || "none"}, min: ${minVersion || "none"})`
    );
    emitLoadFailed(graphId, null, err);
    throw err;
  }

  const versionConfig = sourceConfig.versions[resolvedVersion];
  if (!versionConfig || typeof versionConfig.loader !== "function") {
    const err = new Error(
      `[planningGraphLoader] No loader configured for '${graphId}' version '${resolvedVersion}'`
    );
    emitLoadFailed(graphId, resolvedVersion, err);
    throw err;
  }

  emitLoadStarted(graphId, resolvedVersion);

  let raw;
  try {
    raw = await versionConfig.loader();
  } catch (loadErr) {
    emitLoadFailed(graphId, resolvedVersion, loadErr);
    throw loadErr;
  }

  const json = normalizeImportedJson(raw);

  const meta = normalizeGraphMeta(
    graphId,
    resolvedVersion,
    sourceConfig,
    versionConfig,
    json
  );

  /** @type {LoadedPlanningGraph} */
  const loaded = {
    id: meta.id,
    version: meta.version,
    meta,
    data: json,
  };

  handleVersionWarnings(graphId, meta, {
    requestedVersion: version,
    minVersion,
  });

  emitLoadSucceeded(graphId, meta);

  return loaded;
}

/** ------------------------------------------------------------------------
 *  Version resolution
 * --------------------------------------------------------------------- */

/**
 * Resolve which version to load based on:
 * - explicit `options.version`
 * - `options.minVersion`
 * - `options.preferLatest`
 * - `sourceConfig.defaultVersion`
 *
 * @param {PlanningGraphSourceConfig} sourceConfig
 * @param {LoadOptions} options
 * @returns {string | null}
 */
function resolveVersionForLoad(sourceConfig, options) {
  const versions = Object.keys(sourceConfig.versions || {});
  if (!versions.length) return null;

  const sorted = versions.slice().sort(compareSemver); // ascending
  const latest = sorted[sorted.length - 1];

  // 1) If explicit version requested and present, use that.
  if (options.version && versions.includes(options.version)) {
    return options.version;
  }

  // 2) If preferLatest, use highest version that meets minVersion.
  if (options.preferLatest) {
    if (!options.minVersion) return latest;
    const candidates = sorted.filter(
      (v) => compareSemver(v, options.minVersion) >= 0
    );
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  // 3) If defaultVersion is set, use that as base.
  const base =
    sourceConfig.defaultVersion &&
    versions.includes(sourceConfig.defaultVersion)
      ? sourceConfig.defaultVersion
      : latest;

  // If minVersion is provided, ensure base meets it; otherwise pick highest >= minVersion.
  if (options.minVersion) {
    if (compareSemver(base, options.minVersion) >= 0) {
      return base;
    }
    const candidates = sorted.filter(
      (v) => compareSemver(v, options.minVersion) >= 0
    );
    return candidates.length ? candidates[0] : null;
  }

  // 4) Fallback: base
  return base;
}

/**
 * Simple semver-like comparison: "1.2.3" → [1,2,3].
 * Returns:
 *   < 0 if a < b
 *   > 0 if a > b
 *   0   if equal
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareSemver(a, b) {
  if (a === b) return 0;
  const pa = String(a)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/** ------------------------------------------------------------------------
 *  Meta normalization
 * --------------------------------------------------------------------- */

/**
 * Normalize metadata for a loaded graph, preferring:
 *   1) versionConfig.meta (hard-coded)
 *   2) json.meta from the file
 *   3) fallback built from sourceConfig + version
 *
 * @param {string} graphId
 * @param {string} version
 * @param {PlanningGraphSourceConfig} sourceConfig
 * @param {PlanningGraphVersionConfig} versionConfig
 * @param {any} json
 * @returns {PlanningGraphMeta}
 */
function normalizeGraphMeta(
  graphId,
  version,
  sourceConfig,
  versionConfig,
  json
) {
  const jsonMeta = json && typeof json === "object" ? json.meta : null;
  const fromVersionConfig = versionConfig.meta || {};
  const now = new Date().toISOString();

  /** @type {PlanningGraphMeta} */
  const meta = {
    id:
      fromVersionConfig.id ||
      (jsonMeta && jsonMeta.id) ||
      sourceConfig.id ||
      graphId,
    label:
      fromVersionConfig.label ||
      (jsonMeta && jsonMeta.label) ||
      sourceConfig.label ||
      graphId,
    version:
      fromVersionConfig.version || (jsonMeta && jsonMeta.version) || version,
    domain:
      fromVersionConfig.domain ||
      (jsonMeta && jsonMeta.domain) ||
      sourceConfig.domain ||
      "multi",
    createdAt:
      fromVersionConfig.createdAt || (jsonMeta && jsonMeta.createdAt) || now,
    updatedAt:
      fromVersionConfig.updatedAt || (jsonMeta && jsonMeta.updatedAt) || now,
    description:
      fromVersionConfig.description || (jsonMeta && jsonMeta.description) || "",
  };

  return meta;
}

/**
 * Normalize imported JSON from dynamic imports.
 * Handles both:
 *   - import json from "./foo.json";
 *   - const mod = await import("./foo.json"); mod.default
 *
 * @param {any} raw
 * @returns {any}
 */
function normalizeImportedJson(raw) {
  if (!raw) return {};
  if (raw.default && typeof raw.default === "object") {
    return raw.default;
  }
  return raw;
}

/** ------------------------------------------------------------------------
 *  Warnings & feature flags
 * --------------------------------------------------------------------- */

/**
 * If requested version / minVersion don't match what was actually loaded,
 * emit soft warnings as events. This is helpful for:
 *   - Stability dashboards
 *   - Dev tooling to catch mismatched versions
 *
 * @param {string} graphId
 * @param {PlanningGraphMeta} meta
 * @param {{ requestedVersion?: string, minVersion?: string }} info
 */
function handleVersionWarnings(graphId, meta, info) {
  const { requestedVersion, minVersion } = info || {};
  const loadedVersion = meta.version;

  const warnings = [];

  if (requestedVersion && requestedVersion !== loadedVersion) {
    warnings.push(
      `Requested version '${requestedVersion}' but loaded '${loadedVersion}' for graphId '${graphId}'.`
    );
  }

  if (minVersion && compareSemver(loadedVersion, minVersion) < 0) {
    warnings.push(
      `Loaded version '${loadedVersion}' is less than minVersion '${minVersion}' for graphId '${graphId}'.`
    );
  }

  if (!warnings.length) return;

  // Emit a planningGraph.version.mismatch event.
  safeEmit({
    type: "planningGraph.version.mismatch",
    source: "planningGraph.loader",
    data: {
      graphId,
      loadedVersion,
      requestedVersion: requestedVersion || null,
      minVersion: minVersion || null,
      warnings,
    },
  });

  // Optionally, in dev mode, log warnings to console.
  if (featureFlags && featureFlags.isDevMode) {
    // eslint-disable-next-line no-console
    console.warn("[planningGraphLoader] Version warnings:", warnings);
  }
}

/** ------------------------------------------------------------------------
 *  Events
 * --------------------------------------------------------------------- */

/**
 * Emit "load started" event.
 *
 * @param {string} graphId
 * @param {string} version
 */
function emitLoadStarted(graphId, version) {
  safeEmit({
    type: "planningGraph.load.started",
    source: "planningGraph.loader",
    data: { graphId, version },
  });
}

/**
 * Emit "load succeeded" event.
 *
 * @param {string} graphId
 * @param {PlanningGraphMeta} meta
 */
function emitLoadSucceeded(graphId, meta) {
  safeEmit({
    type: "planningGraph.load.succeeded",
    source: "planningGraph.loader",
    data: {
      graphId,
      version: meta.version,
      domain: meta.domain,
    },
  });
}

/**
 * Emit "load failed" event.
 *
 * @param {string} graphId
 * @param {string | null} version
 * @param {any} error
 */
function emitLoadFailed(graphId, version, error) {
  safeEmit({
    type: "planningGraph.load.failed",
    source: "planningGraph.loader",
    data: {
      graphId,
      version: version || null,
      error: serializeError(error),
    },
  });
}

/**
 * Core safe emitter respecting SSA's event envelope.
 *
 * @param {{ type: string, source: string, data?: any }} payload
 */
function safeEmit(payload) {
  if (!payload || !payload.type) return;

  const envelope = {
    type: payload.type,
    ts: new Date().toISOString(),
    source: payload.source || "planningGraph.loader",
    data: payload.data,
  };

  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(envelope);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[planningGraphLoader] safeEmit failed", envelope, err);
  }
}

/**
 * Serialize arbitrary error into a JSON-safe payload.
 *
 * @param {any} err
 * @returns {{ name?: string, message?: string, stack?: string } | { message: string } | null}
 */
function serializeError(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  if (typeof err === "string") {
    return { message: err };
  }
  if (typeof err === "object") {
    try {
      return JSON.parse(JSON.stringify(err));
    } catch (_) {
      return { message: String(err) };
    }
  }
  return { message: String(err) };
}

export default {
  registerPlanningGraphSource,
  getRegisteredPlanningGraphs,
  loadPlanningGraph,
};
