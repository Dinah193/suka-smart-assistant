// C:\Users\larho\suka-smart-assistant\src\agents\telemetry\counters.js
// Simple usage counters for budgets (agents + sessions + favorites + reverse generation)

/*
  This module provides dynamic telemetry counters for Suka Smart Assistant (SSA).

  It is intentionally:
    - domain-aware (cleaning, garden, storehouse, meals, animals)
    - origin-aware ("system" | "user" | "reverse")
    - event-driven (consumes agent.* and session.* events)
    - budget-friendly (callers can ask for budget status per counter key)
    - Hub-friendly (optional export when familyFundMode === true)

  Typical usage:

    import { handleTelemetryEvent } from "@/agents/telemetry/counters";
    import eventBus from "@/services/eventBus";

    // Somewhere in your central event orchestration:
    eventBus.subscribe((evt) => {
      handleTelemetryEvent(evt);
    });

    // Elsewhere (e.g., for AI budgets):
    const status = await getBudgetStatus("agent.meals.invoked.daily");

  NOTE:
    - Make sure your Dexie db has a "usageCounters" table with:
        { id: string, value: number, firstTs: string, lastTs: string, meta?: object }
    - If db is missing or table is undefined, this falls back to an in-memory Map,
      so SSA continues to function while you evolve the DB.
*/

let db = null;
try {
  // Optional Dexie integration; adjust path if needed.
  // Expected: db.usageCounters where primary key is "id".
  // eslint-disable-next-line global-require, import/no-unresolved
  const dbModule = require("@/services/db");
  db = dbModule.db || dbModule.default || dbModule;
} catch (err) {
  // Swallow error: we'll gracefully fall back to an in-memory store.
  // console.warn("[telemetry/counters] Dexie db not available, using in-memory counters only.", err);
}

let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const flagsModule = require("@/services/featureFlags");
  featureFlags = flagsModule || featureFlags;
} catch (err) {
  // ignore; default featureFlags used
}

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // Optional Hub helpers for familyFundMode export
  // eslint-disable-next-line global-require, import/no-unresolved
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  // eslint-disable-next-line global-require, import/no-unresolved
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch (err) {
  // ignore; Hub export is optional
}

/**
 * In-memory fallback when Dexie is not available or table is undefined.
 * Map<string, { value: number, firstTs: string, lastTs: string, meta?: object }>
 */
const memoryCounters = new Map();

/**
 * Default budgets (you can override at runtime if you want).
 * These are *logical* budgets; the exact enforcement is up to callers.
 * 
 * Patterns inspired by well-executed SaaS dashboards:
 * - domain-scoped
 * - activity-specific
 * - time-scoped via naming (e.g., ".daily", ".weekly")
 */
const DEFAULT_BUDGETS = {
  // Agent invocations
  "agent.meals.invoked.daily": 200,
  "agent.cleaning.invoked.daily": 200,
  "agent.garden.invoked.daily": 200,
  "agent.storehouse.invoked.daily": 200,
  "agent.animals.invoked.daily": 200,

  // Reverse generation
  "agent.reverse.generated.daily": 50,

  // Favorites
  "favorites.sessions.saved.daily": 500,
  "favorites.schedules.saved.daily": 500
};

// Allow runtime overrides without mutating DEFAULT_BUDGETS directly.
const runtimeBudgets = {};

/**
 * Merge effective budgets: DEFAULT_BUDGETS + runtimeBudgets override.
 */
function getEffectiveBudget(key) {
  if (Object.prototype.hasOwnProperty.call(runtimeBudgets, key)) {
    return runtimeBudgets[key];
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULT_BUDGETS, key)) {
    return DEFAULT_BUDGETS[key];
  }
  return null;
}

/**
 * Set / override a budget at runtime.
 * @param {string} key
 * @param {number|null} value - null to clear override and fall back to default.
 */
function setBudget(key, value) {
  if (value == null) {
    delete runtimeBudgets[key];
    return;
  }
  runtimeBudgets[key] = value;
}

/**
 * Get a counter record from Dexie or memory.
 * @param {string} key
 * @returns {Promise<{ id: string, value: number, firstTs: string|null, lastTs: string|null, meta?: object }>}
 */
async function getCounter(key) {
  const nowIso = new Date().toISOString();

  if (db && db.usageCounters) {
    try {
      const existing = await db.usageCounters.get(key);
      if (existing) {
        return existing;
      }
      return {
        id: key,
        value: 0,
        firstTs: null,
        lastTs: null,
        meta: {}
      };
    } catch (err) {
      // If Dexie fails, fall through to memory
    }
  }

  const mem = memoryCounters.get(key);
  if (mem) {
    return { id: key, ...mem };
  }
  return {
    id: key,
    value: 0,
    firstTs: null,
    lastTs: null,
    meta: {}
  };
}

/**
 * Increment a counter by `amount`.
 * @param {string} key
 * @param {number} [amount=1]
 * @param {object} [metaUpdates={}] - merged into existing meta (shallow)
 * @returns {Promise<{ id: string, value: number, firstTs: string, lastTs: string, meta?: object }>}
 */
async function incrementCounter(key, amount = 1, metaUpdates = {}) {
  const nowIso = new Date().toISOString();

  if (db && db.usageCounters) {
    try {
      const existing = await db.usageCounters.get(key);
      const base = existing || {
        id: key,
        value: 0,
        firstTs: nowIso,
        lastTs: nowIso,
        meta: {}
      };

      const updated = {
        ...base,
        value: base.value + amount,
        firstTs: base.firstTs || nowIso,
        lastTs: nowIso,
        meta: {
          ...(base.meta || {}),
          ...metaUpdates
        }
      };

      await db.usageCounters.put(updated);
      return updated;
    } catch (err) {
      // Dexie error: fall through to memory
    }
  }

  // In-memory fallback
  const mem = memoryCounters.get(key) || {
    value: 0,
    firstTs: nowIso,
    lastTs: nowIso,
    meta: {}
  };

  const updatedMem = {
    value: mem.value + amount,
    firstTs: mem.firstTs || nowIso,
    lastTs: nowIso,
    meta: {
      ...(mem.meta || {}),
      ...metaUpdates
    }
  };

  memoryCounters.set(key, updatedMem);
  return { id: key, ...updatedMem };
}

/**
 * Reset a specific counter.
 * @param {string} key
 * @returns {Promise<void>}
 */
async function resetCounter(key) {
  if (db && db.usageCounters) {
    try {
      await db.usageCounters.delete(key);
    } catch (err) {
      // ignore and attempt memory reset
    }
  }
  memoryCounters.delete(key);
}

/**
 * Get budget status for a counter key.
 * 
 * @param {string} key
 * @returns {Promise<{ key: string, used: number, limit: number|null, remaining: number|null, isOver: boolean }>}
 */
async function getBudgetStatus(key) {
  const counter = await getCounter(key);
  const limit = getEffectiveBudget(key);
  if (limit == null) {
    return {
      key,
      used: counter.value,
      limit: null,
      remaining: null,
      isOver: false
    };
  }
  const remaining = Math.max(0, limit - counter.value);
  return {
    key,
    used: counter.value,
    limit,
    remaining,
    isOver: counter.value > limit
  };
}

/**
 * Utility: normalize domain string.
 * @param {string} raw
 * @returns {"cleaning"|"garden"|"storehouse"|"meals"|"animals"|"unknown"}
 */
function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return "unknown";
  const v = raw.toLowerCase();
  if (["cleaning", "garden", "storehouse", "meals", "animals"].includes(v)) {
    return v;
  }
  return "unknown";
}

/**
 * Handle a single event and update counters.
 * 
 * This is intentionally pure-ish: you call it from your central event
 * router / middleware for every event emitted on the bus.
 * 
 * @param {{ type: string, ts: string, source: string, data?: any }} evt
 */
async function handleTelemetryEvent(evt) {
  if (!evt || !evt.type) return;

  const { type, data = {} } = evt;
  const domain = normalizeDomain(data.domain);

  // --- Agent-level events ---------------------------------------------------

  if (type === "agent.invoked") {
    const baseKey = "agent.invoked";
    await incrementCounter(baseKey, 1, { lastDomain: domain });
    if (domain !== "unknown") {
      await incrementCounter(`agent.${domain}.invoked`, 1, { domain });
      // Budget-friendly alias, e.g. "agent.meals.invoked.daily"
      await incrementCounter(`agent.${domain}.invoked.daily`, 1, { domain });
    }
    return;
  }

  if (type === "agent.plan.generated") {
    const origin = data.mode === "reverse" ? "reverse" : "system";
    await incrementCounter("agent.plans.generated", 1, { lastDomain: domain, origin });
    if (domain !== "unknown") {
      await incrementCounter(`agent.${domain}.plans.generated`, 1, { domain, origin });
    }
    return;
  }

  if (type === "agent.plan.failed") {
    await incrementCounter("agent.plans.failed", 1, { lastDomain: domain, errorCode: data.errorCode });
    if (domain !== "unknown") {
      await incrementCounter(`agent.${domain}.plans.failed`, 1, { domain, errorCode: data.errorCode });
    }
    return;
  }

  if (type === "agent.session.generated" || type === "agent.session.userCreated") {
    const session = data.session || {};
    const origin = session.origin || (type === "agent.session.userCreated" ? "user" : "system");

    // Total sessions
    await incrementCounter("sessions.total", 1, { lastDomain: domain, origin });

    // Per-domain sessions
    if (domain !== "unknown") {
      await incrementCounter(`sessions.${domain}.total`, 1, { domain, origin });
    }

    // Origin-specific counters (system vs user vs reverse)
    await incrementCounter(`sessions.origin.${origin}.total`, 1, { origin, domain });
    if (domain !== "unknown") {
      await incrementCounter(`sessions.${domain}.origin.${origin}.total`, 1, { domain, origin });
    }

    // Templates vs non-templates
    if (session.isTemplate) {
      await incrementCounter("sessions.templates.total", 1, { origin, domain });
      if (domain !== "unknown") {
        await incrementCounter(`sessions.${domain}.templates.total`, 1, { origin, domain });
      }
    }

    return;
  }

  if (type === "agent.schedule.generated" || type === "agent.schedule.userCreated") {
    const schedule = data.schedule || {};
    const origin = schedule.origin || (type === "agent.schedule.userCreated" ? "user" : "system");
    const scheduleDomains = Array.isArray(schedule.domains) ? schedule.domains : [];

    // Total schedules
    await incrementCounter("schedules.total", 1, { origin });
    await incrementCounter(`schedules.origin.${origin}.total`, 1, { origin });

    // Per-domain schedules
    for (const d of scheduleDomains) {
      const nd = normalizeDomain(d);
      if (nd === "unknown") continue;
      await incrementCounter(`schedules.${nd}.total`, 1, { domain: nd, origin });
      await incrementCounter(`schedules.${nd}.origin.${origin}.total`, 1, { domain: nd, origin });
    }
    return;
  }

  // --- Favorites: sessions & schedules -------------------------------------

  if (type === "agent.session.favorite.saved") {
    const origin = data.origin || "system";
    await incrementCounter("favorites.sessions.saved", 1, { origin, domain });

    if (domain !== "unknown") {
      await incrementCounter(`favorites.sessions.${domain}.saved`, 1, { origin, domain });
      await incrementCounter(`favorites.sessions.${domain}.saved.daily`, 1, { origin, domain });
    }

    await incrementCounter(`favorites.sessions.origin.${origin}.saved`, 1, { origin, domain });
    return;
  }

  if (type === "agent.session.favorite.removed") {
    const origin = data.origin || "system";
    await incrementCounter("favorites.sessions.removed", 1, { origin, domain });

    if (domain !== "unknown") {
      await incrementCounter(`favorites.sessions.${domain}.removed`, 1, { origin, domain });
    }

    await incrementCounter(`favorites.sessions.origin.${origin}.removed`, 1, { origin, domain });
    return;
  }

  if (type === "agent.schedule.favorite.saved") {
    await incrementCounter("favorites.schedules.saved", 1, { domain });

    const schedule = data.schedule || {};
    const scheduleDomains = Array.isArray(schedule.domains) ? schedule.domains : (domain !== "unknown" ? [domain] : []);

    for (const d of scheduleDomains) {
      const nd = normalizeDomain(d);
      if (nd === "unknown") continue;
      await incrementCounter(`favorites.schedules.${nd}.saved`, 1, { domain: nd });
      await incrementCounter(`favorites.schedules.${nd}.saved.daily`, 1, { domain: nd });
    }
    return;
  }

  if (type === "agent.schedule.favorite.removed") {
    await incrementCounter("favorites.schedules.removed", 1, { domain });

    const schedule = data.schedule || {};
    const scheduleDomains = Array.isArray(schedule.domains) ? schedule.domains : (domain !== "unknown" ? [domain] : []);

    for (const d of scheduleDomains) {
      const nd = normalizeDomain(d);
      if (nd === "unknown") continue;
      await incrementCounter(`favorites.schedules.${nd}.removed`, 1, { domain: nd });
    }
    return;
  }

  // --- Reverse generation ---------------------------------------------------

  if (type === "agent.reverseGeneration.requested") {
    await incrementCounter("agent.reverse.requested", 1, { domain, agentId: data.agentId, userId: data.userId });
    if (domain !== "unknown") {
      await incrementCounter(`agent.${domain}.reverse.requested`, 1, { domain, agentId: data.agentId, userId: data.userId });
    }
    return;
  }

  if (type === "agent.reverseGeneration.completed") {
    const createdSessions = Array.isArray(data.createdSessions) ? data.createdSessions.length : 0;
    const createdSchedules = Array.isArray(data.createdSchedules) ? data.createdSchedules.length : 0;

    await incrementCounter("agent.reverse.completed", 1, { domain, agentId: data.agentId, userId: data.userId });
    await incrementCounter("agent.reverse.sessionsCreated", createdSessions, { domain });
    await incrementCounter("agent.reverse.schedulesCreated", createdSchedules, { domain });

    if (domain !== "unknown") {
      await incrementCounter(`agent.${domain}.reverse.completed`, 1, { domain });
      await incrementCounter(`agent.${domain}.reverse.sessionsCreated`, createdSessions, { domain });
      await incrementCounter(`agent.${domain}.reverse.schedulesCreated`, createdSchedules, { domain });
    }

    // Budget tracking for reverse generation
    await incrementCounter("agent.reverse.generated.daily", 1, { domain });
    return;
  }

  if (type === "agent.reverseGeneration.failed") {
    await incrementCounter("agent.reverse.failed", 1, { domain, agentId: data.agentId, userId: data.userId, errorCode: data.errorCode });
    if (domain !== "unknown") {
      await incrementCounter(`agent.${domain}.reverse.failed`, 1, { domain, errorCode: data.errorCode });
    }
    return;
  }

  // --- Domain context updates (cleaning, garden, storehouse, meals, animals) ---

  if (type === "agent.context.updated.cleaning") {
    await incrementCounter("contextUpdates.cleaning", 1, { domain: "cleaning" });
    return;
  }

  if (type === "agent.context.updated.garden") {
    await incrementCounter("contextUpdates.garden", 1, { domain: "garden" });
    return;
  }

  if (type === "agent.context.updated.storehouse") {
    await incrementCounter("contextUpdates.storehouse", 1, { domain: "storehouse" });
    return;
  }

  if (type === "agent.context.updated.meals") {
    await incrementCounter("contextUpdates.meals", 1, { domain: "meals" });
    return;
  }

  if (type === "agent.context.updated.animals") {
    await incrementCounter("contextUpdates.animals", 1, { domain: "animals" });
    return;
  }

  // --- (Optional) session runner events, if you wire them in) ---------------

  if (type === "session.started" || type === "session.runner.started") {
    const s = data.session || {};
    const sDomain = normalizeDomain(s.domain || domain);
    await incrementCounter("sessions.started", 1, { domain: sDomain });
    if (sDomain !== "unknown") {
      await incrementCounter(`sessions.${sDomain}.started`, 1, { domain: sDomain });
    }
    return;
  }

  if (type === "session.completed" || type === "session.runner.completed") {
    const s = data.session || {};
    const sDomain = normalizeDomain(s.domain || domain);
    await incrementCounter("sessions.completed", 1, { domain: sDomain });
    if (sDomain !== "unknown") {
      await incrementCounter(`sessions.${sDomain}.completed`, 1, { domain: sDomain });
    }
    return;
  }

  if (type === "session.abandoned" || type === "session.runner.abandoned") {
    const s = data.session || {};
    const sDomain = normalizeDomain(s.domain || domain);
    await incrementCounter("sessions.abandoned", 1, { domain: sDomain });
    if (sDomain !== "unknown") {
      await incrementCounter(`sessions.${sDomain}.abandoned`, 1, { domain: sDomain });
    }
  }

  // NOTE: add more event mappings here as SSA evolves.
}

/**
 * Optional: export an aggregated snapshot of counters to the Hub
 * when familyFundMode === true. You can call this explicitly or
 * wire it to a "telemetry.counters.flushRequested" event.
 * 
 * @returns {Promise<void>}
 */
async function flushCountersToHub() {
  if (!featureFlags.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;

  let records = [];

  if (db && db.usageCounters) {
    try {
      records = await db.usageCounters.toArray();
    } catch (err) {
      // fallback below
    }
  }

  if (!records.length && memoryCounters.size > 0) {
    records = Array.from(memoryCounters.entries()).map(([id, v]) => ({
      id,
      value: v.value,
      firstTs: v.firstTs,
      lastTs: v.lastTs,
      meta: v.meta || {}
    }));
  }

  if (!records.length) return;

  try {
    const packet = HubPacketFormatter.formatUsageCounters(records);
    await FamilyFundConnector.sendTelemetry(packet);
  } catch (err) {
    // Swallow errors: Hub export must never break household usage.
    // console.error("[telemetry/counters] Failed to flush to Hub", err);
  }
}

module.exports = {
  getCounter,
  incrementCounter,
  resetCounter,
  getBudgetStatus,
  setBudget,
  handleTelemetryEvent,
  flushCountersToHub
};
