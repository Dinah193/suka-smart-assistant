"use strict";

const { v4: uuidv4 } = require("uuid");

function nowIso() {
  return new Date().toISOString();
}

function readNeo4jAvailability() {
  return String(process.env.SSA_NEO4J_AVAILABLE || "true").toLowerCase() === "true";
}

function toObject(value) {
  return value && typeof value === "object" ? value : {};
}

function asOutputs(value) {
  return Array.isArray(value) ? value.filter((x) => x && typeof x === "object") : [];
}

function resolveHomesteadProjectionInput(entry = {}, meta = {}) {
  const payload = toObject(entry.payload);
  const signal = toObject(payload.signal && typeof payload.signal === "object" ? payload.signal : payload);
  const signalPayload = toObject(signal.payload);

  const outputs = asOutputs(signalPayload.outputs || signal.outputs || payload.outputs);
  if (!outputs.length) return null;

  const householdId =
    signalPayload.householdId ||
    signal.householdId ||
    signal.scopeId ||
    payload.scopeId ||
    meta.scopeId ||
    "default";

  const planId = signalPayload.planId || signal.planId || payload.planId || null;
  const seasonKey = signalPayload.seasonKey || signal.seasonKey || payload.seasonKey || null;

  return {
    householdId: String(householdId),
    planId: planId == null ? null : String(planId),
    seasonKey: seasonKey == null ? null : String(seasonKey),
    outputs,
  };
}

async function defaultProcessEvent(entry = {}, meta = {}) {
  const neo4jAvailable =
    typeof meta.neo4jAvailable === "boolean" ? meta.neo4jAvailable : readNeo4jAvailability();
  if (!neo4jAvailable) {
    throw new Error("neo4j_unavailable");
  }

  const projectionInput = resolveHomesteadProjectionInput(entry, meta);
  if (!projectionInput) {
    return { ok: true, skipped: true, reason: "no_homestead_outputs" };
  }

  // Lazy-load planner integration to avoid hard dependency cycles during module initialization.
  const { projectHomesteadOutputsToNeo4j } = require("./planners/PlannerIntegrationService");
  if (typeof projectHomesteadOutputsToNeo4j !== "function") {
    throw new Error("neo4j_projection_handler_missing");
  }

  const out = await projectHomesteadOutputsToNeo4j(projectionInput);
  if (!out?.ok) {
    throw new Error(String(out?.reason || "neo4j_projection_failed"));
  }

  return out;
}

function createGraphProjector({
  enabled = false,
  processEvent = defaultProcessEvent,
  maxRetries = 3,
  retryDelayMs = 100,
  deadLetterLimit = 1000,
  neo4jAvailable = readNeo4jAvailability(),
} = {}) {
  const queue = [];
  const deadLetter = [];
  const scopeSummary = new Map();
  const seenIds = new Set();

  const stats = {
    enabled: !!enabled,
    enqueued: 0,
    processed: 0,
    failed: 0,
    retries: 0,
    deadLettered: 0,
    queueDepth: 0,
    lastProcessedAt: null,
    lastError: null,
  };

  let running = false;

  function updateQueueDepth() {
    stats.queueDepth = queue.length;
  }

  function entryScope(entry) {
    const payload = entry?.payload || {};
    const signal = payload.signal || payload;
    const ctx = payload.context || {};
    const scope = (signal.scope || ctx.scope) === "family" ? "family" : "household";
    const scopeId = String(
      signal.scopeId ||
        ctx.scopeId ||
        signal.familyId ||
        signal.homeId ||
        signal.householdId ||
        ctx.user?.familyId ||
        ctx.user?.homeId ||
        "default",
    );
    return { scope, scopeId, key: `${scope}:${scopeId}` };
  }

  function markScopeProjected(entry) {
    const { scope, scopeId, key } = entryScope(entry);
    const cur = scopeSummary.get(key) || {
      scope,
      scopeId,
      projectedEvents: 0,
      retryCount: 0,
      deadLetterCount: 0,
      lastProjectedAt: null,
    };
    cur.projectedEvents += 1;
    cur.lastProjectedAt = nowIso();
    scopeSummary.set(key, cur);
  }

  function markScopeRetry(entry) {
    const { scope, scopeId, key } = entryScope(entry);
    const cur = scopeSummary.get(key) || {
      scope,
      scopeId,
      projectedEvents: 0,
      retryCount: 0,
      deadLetterCount: 0,
      lastProjectedAt: null,
    };
    cur.retryCount += 1;
    scopeSummary.set(key, cur);
  }

  function markScopeDeadLetter(entry) {
    const { scope, scopeId, key } = entryScope(entry);
    const cur = scopeSummary.get(key) || {
      scope,
      scopeId,
      projectedEvents: 0,
      retryCount: 0,
      deadLetterCount: 0,
      lastProjectedAt: null,
    };
    cur.deadLetterCount += 1;
    scopeSummary.set(key, cur);
  }

  function enqueue(entry = {}, meta = {}) {
    if (!stats.enabled) return { ok: true, skipped: true };
    const id = String(entry.id || meta.id || uuidv4());
    if (seenIds.has(id)) return { ok: true, duplicate: true };
    seenIds.add(id);

    queue.push({ entry: { ...entry, id }, meta, attempts: 0, enqueuedAt: nowIso() });
    stats.enqueued += 1;
    updateQueueDepth();
    schedule();
    return { ok: true, enqueued: true, id };
  }

  async function processOne(item) {
    try {
      await processEvent(item.entry, { ...item.meta, neo4jAvailable });
      stats.processed += 1;
      stats.lastProcessedAt = nowIso();
      markScopeProjected(item.entry);
      return true;
    } catch (err) {
      stats.failed += 1;
      stats.lastError = String(err?.message || err || "graph_projection_error");
      item.attempts += 1;

      if (item.attempts <= maxRetries) {
        stats.retries += 1;
        markScopeRetry(item.entry);
        setTimeout(() => {
          queue.push(item);
          updateQueueDepth();
          schedule();
        }, retryDelayMs);
        return false;
      }

      deadLetter.push({
        id: item.entry?.id,
        entry: item.entry,
        meta: item.meta,
        attempts: item.attempts,
        failedAt: nowIso(),
        error: stats.lastError,
      });
      while (deadLetter.length > deadLetterLimit) deadLetter.shift();
      stats.deadLettered += 1;
      markScopeDeadLetter(item.entry);
      return false;
    }
  }

  async function runQueue() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        updateQueueDepth();
        await processOne(item);
      }
    } finally {
      running = false;
      updateQueueDepth();
    }
  }

  function schedule() {
    if (!stats.enabled) return;
    setTimeout(() => {
      runQueue().catch(() => {
        // keep projector non-blocking for caller
      });
    }, 0);
  }

  function getState() {
    return {
      ...stats,
      scopeSummaryCount: scopeSummary.size,
      deadLetterSize: deadLetter.length,
    };
  }

  function getDiagnostics({ scope = null, scopeId = null } = {}) {
    const scoped = scope && scopeId ? scopeSummary.get(`${scope}:${scopeId}`) || null : null;
    return {
      state: getState(),
      scopeSummary: scoped ? [scoped] : Array.from(scopeSummary.values()),
      deadLetter: deadLetter.slice(),
    };
  }

  function getScopeSummary(scope, scopeId) {
    return scopeSummary.get(`${scope}:${scopeId}`) || null;
  }

  return {
    enqueue,
    getState,
    getDiagnostics,
    getScopeSummary,
  };
}

module.exports = {
  createGraphProjector,
};
