/**
 * @file src/agents/context/selectors.js
 *
 * Pulls minimal Dexie context for reasoning.
 *
 * HOW THIS FITS:
 * - Reasoner / agents frequently need a *small*, normalized snapshot of the
 *   household state before composing sessions or running feasibility checks.
 * - This module centralizes those reads so:
 *   - We avoid over-fetching entire tables.
 *   - We keep a consistent “minimal context” shape for prompts / reasoning.
 *   - We can later evolve Dexie schema without touching every agent.
 *
 * TYPICAL USE:
 * ```js
 * import { getMinimalReasoningContext } from '../../agents/context/selectors';
 *
 * const ctx = await getMinimalReasoningContext({
 *   domain: 'cooking',        // or 'cleaning' | 'garden' | 'animals' | 'preservation' | 'storehouse'
 *   userId: currentUserId     // optional, can be anon
 * });
 *
 * // ctx is safe to embed in a Reasoner prompt / request body.
 * ```
 */

import { emit } from "@/services/events/eventBus";
import { db } from "@/services/db"; // Adjust if your Dexie instance is exported elsewhere.
import * as featureFlagsModule from "@/config/featureFlags";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {'cooking'|'cleaning'|'garden'|'animals'|'preservation'|'storehouse'} SessionDomain
 */

/**
 * Minimal summary for a session, optimized for reasoning.
 *
 * @typedef {Object} SessionSummary
 * @property {string} id
 * @property {SessionDomain} domain
 * @property {string} title
 * @property {'pending'|'running'|'paused'|'completed'|'aborted'} status
 * @property {number} [currentStepIndex]
 * @property {number} [totalSteps]
 * @property {number} [elapsedSec]
 * @property {string} [startedAt]
 * @property {string} [updatedAt]
 */

/**
 * Minimal guardian / guard configuration snapshot.
 *
 * @typedef {Object} GuardsContext
 * @property {{ enabled: boolean, dayOfWeek: number, sunsetOffsetMinutes: number } | null} sabbath
 * @property {{ enabled: boolean, startMinutes: number, endMinutes: number } | null} quietHours
 * @property {{ enabled: boolean, severeOnly: boolean } | null} weather
 * @property {{ enabled: boolean } | null} inventory
 * @property {{ enabled: boolean, lowBatteryThreshold: number } | null} battery
 */

/**
 * Minimal reasoning context returned from selectors.
 *
 * @typedef {Object} MinimalReasoningContext
 * @property {SessionDomain} domain
 * @property {string} userId
 * @property {string} nowIso
 * @property {Record<string, any>} featureFlags
 * @property {SessionSummary[]} sessions
 * @property {number} pendingSessions
 * @property {number} runningSessions
 * @property {GuardsContext} guards
 */

/**
 * Input to getMinimalReasoningContext.
 *
 * @typedef {Object} MinimalReasoningContextInput
 * @property {SessionDomain} domain
 * @property {string} [userId]
 * @property {Date} [now]
 * @property {number} [sessionLimit] Max number of sessions to include in summary
 */

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Pull a lean, reasoning-friendly snapshot of Dexie + flags state.
 *
 * - Uses only the fields that are actually useful for prompts:
 *   - basic session queue for the domain (id, title, status, step counts).
 *   - guard configuration (sabbath, quiet hours, weather, inventory, battery).
 *   - a feature flags snapshot.
 * - All reads are defensive: if a table does not exist, you still get a
 *   valid context object with sensible defaults.
 *
 * @param {MinimalReasoningContextInput} params
 * @returns {Promise<MinimalReasoningContext>}
 */
export async function getMinimalReasoningContext(params) {
  const domain = /** @type {SessionDomain} */ (params?.domain || "cooking");
  const userId = (params?.userId || "anon").trim() || "anon";
  const now = params?.now instanceof Date ? params.now : new Date();
  const sessionLimit = Number.isFinite(params?.sessionLimit)
    ? Math.max(1, Math.min(50, Number(params.sessionLimit)))
    : 10;

  const nowIso = now.toISOString();

  const [featureFlags, sessionsSnapshot, guards] = await Promise.all([
    safeGetFeatureFlagsSnapshot(),
    getSessionsSnapshotForDomain(domain, { userId, limit: sessionLimit }),
    getGuardsContextFromDexie(),
  ]);

  const ctx = {
    domain,
    userId,
    nowIso,
    featureFlags,
    sessions: sessionsSnapshot.list,
    pendingSessions: sessionsSnapshot.pendingCount,
    runningSessions: sessionsSnapshot.runningCount,
    guards,
  };

  safeEmitContextSelected("minimal", ctx, params);
  return ctx;
}

/**
 * Fetch a small session-only snapshot for a given domain.
 *
 * This is useful when the Reasoner only needs to know the queue state
 * (e.g., to decide what “Now” should point at), without extra guard or
 * feature flag context.
 *
 * @param {SessionDomain} domain
 * @param {{ userId?: string, limit?: number }} [options]
 * @returns {Promise<{ list: SessionSummary[], pendingCount: number, runningCount: number }>}
 */
export async function getSessionsSnapshotForDomain(domain, options = {}) {
  const table = safeDexieTable("sessions");
  const userId = (options.userId || "anon").trim() || "anon";
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(50, Number(options.limit)))
    : 10;

  if (!table) {
    // No sessions table yet; return empty snapshot.
    return {
      list: [],
      pendingCount: 0,
      runningCount: 0,
    };
  }

  try {
    // Basic strategy:
    // - Filter by domain.
    // - Optionally filter by userId if you have multi-user sessions.
    // - Sort by updatedAt desc (most recent first).
    // - Take up to `limit`.
    let collection = table.where("domain").equals(domain);

    // If your sessions table is multi-user, you can uncomment this and add
    // an index on `userId`:
    //
    // if (table.schema.idxByName.userId) {
    //   collection = collection.and((s) => s.userId === userId);
    // }

    const rows = await collection.reverse().sortBy("updatedAt"); // Dexie sort fallback; you can optimize with indexes.

    const trimmed = rows.slice(0, limit);

    /** @type {SessionSummary[]} */
    const list = trimmed.map((row) => normalizeSessionSummary(row));

    const pendingCount = rows.filter((r) => r.status === "pending").length;
    const runningCount = rows.filter((r) => r.status === "running").length;

    return { list, pendingCount, runningCount };
  } catch (err) {
    safeEmitContextError("sessionsSnapshot", err, { domain, userId });
    return {
      list: [],
      pendingCount: 0,
      runningCount: 0,
    };
  }
}

/**
 * Fetch a minimal guards configuration snapshot.
 *
 * - Reads from optional Dexie tables (guardRules / guards / settings).
 * - Falls back to conservative defaults if nothing is configured.
 *
 * @returns {Promise<GuardsContext>}
 */
export async function getGuardsContextFromDexie() {
  const guardsTable = safeDexieTable("guardRules") || safeDexieTable("guards");
  const settingsTable = safeDexieTable("settings");

  /** @type {GuardsContext} */
  const defaults = {
    sabbath: {
      enabled: true,
      dayOfWeek: 6, // 0=Sun...6=Sat
      sunsetOffsetMinutes: 0,
    },
    quietHours: {
      enabled: true,
      startMinutes: 22 * 60, // 22:00
      endMinutes: 7 * 60, // 07:00
    },
    weather: {
      enabled: true,
      severeOnly: true,
    },
    inventory: {
      enabled: true,
    },
    battery: {
      enabled: false,
      lowBatteryThreshold: 0.2,
    },
  };

  if (!guardsTable && !settingsTable) {
    return defaults;
  }

  try {
    let cfg = { ...defaults };

    if (guardsTable) {
      // Attempt to read a single row with type or id-specific config.
      const rows = await guardsTable.toArray();
      const primary = rows[0];

      if (primary?.sabbath) {
        cfg.sabbath = {
          ...cfg.sabbath,
          ...primary.sabbath,
        };
      }
      if (primary?.quietHours) {
        cfg.quietHours = {
          ...cfg.quietHours,
          ...primary.quietHours,
        };
      }
      if (primary?.weather) {
        cfg.weather = {
          ...cfg.weather,
          ...primary.weather,
        };
      }
      if (primary?.inventory) {
        cfg.inventory = {
          ...cfg.inventory,
          ...primary.inventory,
        };
      }
      if (primary?.battery) {
        cfg.battery = {
          ...cfg.battery,
          ...primary.battery,
        };
      }
    }

    if (settingsTable) {
      // If you store guard settings under a generic "guards" key:
      const maybeGuards = await settingsTable.get("guards");
      if (maybeGuards && typeof maybeGuards === "object") {
        if (maybeGuards.sabbath) {
          cfg.sabbath = {
            ...cfg.sabbath,
            ...maybeGuards.sabbath,
          };
        }
        if (maybeGuards.quietHours) {
          cfg.quietHours = {
            ...cfg.quietHours,
            ...maybeGuards.quietHours,
          };
        }
        if (maybeGuards.weather) {
          cfg.weather = {
            ...cfg.weather,
            ...maybeGuards.weather,
          };
        }
        if (maybeGuards.inventory) {
          cfg.inventory = {
            ...cfg.inventory,
            ...maybeGuards.inventory,
          };
        }
        if (maybeGuards.battery) {
          cfg.battery = {
            ...cfg.battery,
            ...maybeGuards.battery,
          };
        }
      }
    }

    return cfg;
  } catch (err) {
    safeEmitContextError("guardsContext", err, {});
    return defaults;
  }
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Safely access a Dexie table by name, or null if not found.
 *
 * @param {string} name
 * @returns {import('dexie').Table | null}
 */
function safeDexieTable(name) {
  try {
    if (!db || !db[name]) return null;
    return db[name];
  } catch {
    return null;
  }
}

/**
 * Normalize a raw session row into a SessionSummary.
 *
 * @param {any} row
 * @returns {SessionSummary}
 */
function normalizeSessionSummary(row) {
  const totalSteps = Array.isArray(row.steps) ? row.steps.length : undefined;
  const status = normalizeStatus(row.status);

  return {
    id: String(row.id || ""),
    domain: /** @type {SessionDomain} */ (row.domain || "cooking"),
    title: String(row.title || "Untitled session"),
    status,
    currentStepIndex: row?.progress?.currentStepIndex ?? 0,
    totalSteps,
    elapsedSec: row?.progress?.elapsedSec ?? 0,
    startedAt: row?.progress?.startedAt || null,
    updatedAt: row?.updatedAt || row?.createdAt || null,
  };
}

/**
 * Normalize session status to the contract set in the Master Codegen Prompt.
 *
 * @param {any} raw
 * @returns {'pending'|'running'|'paused'|'completed'|'aborted'}
 */
function normalizeStatus(raw) {
  const value = String(raw || "").toLowerCase();
  switch (value) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "completed":
    case "complete":
      return "completed";
    case "aborted":
    case "cancelled":
    case "canceled":
      return "aborted";
    case "pending":
    default:
      return "pending";
  }
}

/**
 * Try to get a feature flag snapshot from featureFlagsModule with a
 * defensive fallback.
 *
 * This keeps this selector decoupled from the exact feature flags API.
 *
 * @returns {Promise<Record<string, any>>}
 */
async function safeGetFeatureFlagsSnapshot() {
  try {
    // Possible exports:
    //   - snapshotFlags()
    //   - getAllFeatureFlags()
    //   - getFeatureFlags()
    //   - a default object `{ familyFundMode: boolean, ... }`
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

    // Fallback: construct a minimal flags object from known names.
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
 * Emit a telemetry event when context selectors are used.
 *
 * @param {'minimal'|'unknown'} selector
 * @param {MinimalReasoningContext} ctx
 * @param {MinimalReasoningContextInput} params
 */
function safeEmitContextSelected(selector, ctx, params) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "context.selectors.used",
      ts: new Date().toISOString(),
      source: "agents.context.selectors",
      data: {
        selector,
        params,
        summary: {
          domain: ctx.domain,
          userId: ctx.userId,
          pendingSessions: ctx.pendingSessions,
          runningSessions: ctx.runningSessions,
        },
      },
    });
  } catch {
    // Never let telemetry failures break callers.
  }
}

/**
 * Emit an error telemetry event for context failures.
 *
 * @param {string} scope
 * @param {any} err
 * @param {Record<string, any>} extra
 */
function safeEmitContextError(scope, err, extra) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "context.selectors.error",
      ts: new Date().toISOString(),
      source: "agents.context.selectors",
      data: {
        scope,
        error: String(err),
        ...extra,
      },
    });
  } catch {
    // swallow
  }
}

/* -------------------------------------------------------------------------- */
/* Compatibility exports (used by HouseholdOrchestrator)                        */
/* -------------------------------------------------------------------------- */

/**
 * selectProcurementContext
 * ---------------------------------------------------------------------------
 * Selector expected by procurementShim.
 */
export async function selectProcurementContext(input = {}) {
  const domain = /** @type {SessionDomain} */ (input?.domain || "storehouse");
  return getMinimalReasoningContext({ ...input, domain });
}

/**
 * selectRecipeConsolidatorContext
 * ---------------------------------------------------------------------------
 * Selector expected by recipeConsolidatorShim.
 *
 * Default domain is "cooking" since recipe consolidation typically operates
 * on cooking/meal planning state, but callers can override via input.domain.
 */
export async function selectRecipeConsolidatorContext(input = {}) {
  const domain = /** @type {SessionDomain} */ (input?.domain || "cooking");
  return getMinimalReasoningContext({ ...input, domain });
}

/**
 * getDomainContext
 * ---------------------------------------------------------------------------
 * Backward-compatible selector expected by HouseholdOrchestrator.
 * Returns a minimal reasoning context for a specific domain.
 */
export async function getDomainContext(domain, input = {}) {
  return getMinimalReasoningContext({ ...input, domain });
}

/**
 * getPendingOrRunningSessionForDomain
 * ---------------------------------------------------------------------------
 * Returns the most relevant session candidate for a domain:
 *   1) a running session if present
 *   2) otherwise a pending session if present
 */
export async function getPendingOrRunningSessionForDomain(domain, input = {}) {
  const snap = await getSessionsSnapshotForDomain(domain, {
    userId: input.userId,
    limit: input.limit ?? 50,
  });
  const runningList = snap?.running || snap?.runningSessions || [];
  const running = Array.isArray(runningList) ? runningList[0] : null;
  if (running) return running;
  const pendingList = snap?.pending || snap?.pendingSessions || [];
  const pending = Array.isArray(pendingList) ? pendingList[0] : null;
  return pending || null;
}

/**
 * getLatestSessionForDomain
 * ---------------------------------------------------------------------------
 * Returns the most recent session for a domain, preferring running/pending
 * if they exist, otherwise falling back to the latest historical session.
 */
export async function getLatestSessionForDomain(domain, input = {}) {
  const snap = await getSessionsSnapshotForDomain(domain, {
    userId: input.userId,
    limit: input.limit ?? 50,
  });
  const running = snap?.running || snap?.runningSessions || [];
  if (running.length) return running[0];
  const pending = snap?.pending || snap?.pendingSessions || [];
  if (pending.length) return pending[0];
  const recent = snap?.recent || snap?.history || snap?.latest || [];
  if (Array.isArray(recent) && recent.length) return recent[0];
  return null;
}
