// C:\Users\larho\suka-smart-assistant\src\server\services\realtimeCoordinator.js
//
// Realtime signal aggregation + suggestion queues + reporting worker (MVP).
// In-memory implementation for fast integration with existing Socket/EventBus.

"use strict";

const { v4: uuidv4 } = require("uuid");
const {
  createInMemoryEventLogStore,
  createFileEventLogStore,
} = require("./realtimeEventLogStore.js");
const { createGraphProjector } = require("./realtimeGraphProjector.js");

const MAX_SIGNAL_HISTORY = Number(process.env.SSA_SIGNAL_HISTORY_MAX || 5000);
const MAX_AUDIT_HISTORY = Number(process.env.SSA_AUDIT_HISTORY_MAX || 5000);
const DEFAULT_SUGGESTION_TTL_MS = Number(
  process.env.SSA_SUGGESTION_TTL_MS || 1000 * 60 * 60 * 24,
);
const REPORT_INTERVAL_MS = Number(
  process.env.SSA_REPORT_INTERVAL_MS || 1000 * 60 * 5,
);
const SUGGESTION_DEDUPE_WINDOW_MS = Number(
  process.env.SSA_SUGGESTION_DEDUPE_WINDOW_MS || 1000 * 60 * 60 * 6,
);
const SIGNAL_EVENT_DEDUPE_WINDOW_MS = Number(
  process.env.SSA_SIGNAL_EVENT_DEDUPE_WINDOW_MS || 1000 * 60 * 10,
);
const STRICT_ENVELOPE_REQUIRED = String(
  process.env.SSA_REALTIME_STRICT_ENVELOPE || "false",
).toLowerCase() === "true";
const APPEND_LOG_ENABLED = String(
  process.env.SSA_REALTIME_APPEND_LOG_ENABLED || "false",
).toLowerCase() === "true";
const REPLAY_ON_BOOT_ENABLED = String(
  process.env.SSA_REALTIME_REPLAY_ON_BOOT || "false",
).toLowerCase() === "true";
const EVENT_LOG_MEMORY_FALLBACK = String(
  process.env.SSA_REALTIME_EVENTLOG_FALLBACK_MEMORY || "true",
).toLowerCase() !== "false";
const REPLAY_CHECKPOINT_KEY = String(
  process.env.SSA_REALTIME_REPLAY_CHECKPOINT_KEY || "realtime.coordinator.replay",
);
const READINESS_STALE_MS = Number(
  process.env.SSA_READINESS_STALE_MS || 1000 * 60 * 30,
);
const GRAPH_PROJECTION_ENABLED = String(
  process.env.SSA_GRAPH_PROJECTION_ENABLED || "false",
).toLowerCase() === "true";
const GRAPH_MAX_RETRIES = Number(process.env.SSA_GRAPH_MAX_RETRIES || 3);
const GRAPH_RETRY_DELAY_MS = Number(process.env.SSA_GRAPH_RETRY_DELAY_MS || 100);
const GRAPH_DEADLETTER_LIMIT = Number(process.env.SSA_GRAPH_DEADLETTER_LIMIT || 1000);
const NEO4J_AVAILABLE = String(process.env.SSA_NEO4J_AVAILABLE || "true").toLowerCase() === "true";

function capPush(arr, item, max) {
  arr.push(item);
  while (arr.length > max) arr.shift();
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeScope(scope) {
  return scope === "family" ? "family" : "household";
}

function normalizeScopeId(scopeId) {
  return String(scopeId || "default");
}

function isoMs(iso, fallback = 0) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : fallback;
}

function inferSubjectKey(signal) {
  const p = signal?.payload || {};
  return String(
    p?.sku ||
      p?.name ||
      p?.crop ||
      p?.taskId ||
      p?.recipeId ||
      p?.ingredient ||
      p?.itemId ||
      "generic",
  ).toLowerCase();
}

function priorityScore({ urgency = "normal", hasDependencies = false, perishable = false }) {
  const urgencyWeight = {
    low: 20,
    normal: 50,
    medium: 55,
    high: 80,
    critical: 100,
  };
  let score = urgencyWeight[String(urgency || "normal").toLowerCase()] || 50;
  if (hasDependencies) score += 10;
  if (perishable) score += 15;
  return Math.max(0, Math.min(150, score));
}

function createCoordinator({
  eventBus,
  namespaceEmit,
  eventLogStore = null,
  graphProjector = null,
  flags = {},
} = {}) {
  if (!eventBus) throw new Error("createCoordinator requires eventBus");
  if (typeof namespaceEmit !== "function") {
    throw new Error("createCoordinator requires namespaceEmit");
  }

  const signalHistory = [];
  const auditHistory = [];

  // scopeKey -> [suggestions]
  const suggestionQueues = new Map();
  // reportKey -> report object
  const latestReports = new Map();
  const seenEventKeys = new Map();
  const replayedEntryIds = new Set();
  const ingestStats = {
    droppedInvalid: 0,
    droppedDuplicate: 0,
    accepted: 0,
    replayed: 0,
  };
  const projectionStats = {
    queueDepthByScope: new Map(),
    readinessByScope: new Map(),
    ingestToQueueLatencyMs: {
      count: 0,
      total: 0,
      last: 0,
      avg: 0,
      max: 0,
    },
  };

  let reportTimer = null;
  const appendEnabled =
    typeof flags.appendLogEnabled === "boolean" ? flags.appendLogEnabled : APPEND_LOG_ENABLED;
  const replayOnBootEnabled =
    typeof flags.replayOnBootEnabled === "boolean"
      ? flags.replayOnBootEnabled
      : REPLAY_ON_BOOT_ENABLED;
  const graphProjectionEnabled =
    typeof flags.graphProjectionEnabled === "boolean"
      ? flags.graphProjectionEnabled
      : GRAPH_PROJECTION_ENABLED;

  let store = eventLogStore;
  if (!store && appendEnabled) {
    try {
      store = createFileEventLogStore({});
    } catch {
      if (EVENT_LOG_MEMORY_FALLBACK) store = createInMemoryEventLogStore();
    }
  }

  let projector = graphProjector;
  if (!projector) {
    projector = createGraphProjector({
      enabled: graphProjectionEnabled,
      maxRetries: GRAPH_MAX_RETRIES,
      retryDelayMs: GRAPH_RETRY_DELAY_MS,
      deadLetterLimit: GRAPH_DEADLETTER_LIMIT,
      neo4jAvailable: NEO4J_AVAILABLE,
    });
  }

  function scopeKey(scope, scopeId) {
    return `${normalizeScope(scope)}:${normalizeScopeId(scopeId)}`;
  }

  function scopeRoom(scope, scopeId) {
    return scope === "family" ? `family:${scopeId}` : `home:${scopeId}`;
  }

  function writeAudit(type, data = {}) {
    capPush(
      auditHistory,
      {
        id: uuidv4(),
        type,
        ts: nowIso(),
        data,
      },
      MAX_AUDIT_HISTORY,
    );
  }

  function shouldAppendSignals() {
    return !!store && appendEnabled;
  }

  function enqueueGraphProjection(entry, meta = {}) {
    try {
      if (!projector?.enqueue) return { ok: true, skipped: true };
      return projector.enqueue(entry, meta);
    } catch {
      // Graph projection must never break core realtime flow.
      return { ok: false, skipped: true };
    }
  }

  function appendRecord(kind, payload = {}) {
    if (!shouldAppendSignals()) return { ok: true, skipped: true };
    try {
      const out = store.append({ kind, payload, ts: nowIso() });
      if (!out?.ok) {
        return { ok: false, error: "event_log_unavailable", reason: "append_failed" };
      }
      enqueueGraphProjection(out.entry, { source: "append" });
      return { ok: true, entry: out.entry };
    } catch {
      return { ok: false, error: "event_log_unavailable", reason: "append_failed" };
    }
  }

  function appendSignal(rawSignal = {}, context = {}) {
    return appendRecord("signal.ingest", {
      signal: rawSignal,
      context,
    });
  }

  function appendSuggestionAction(kind, payload = {}) {
    return appendRecord(kind, payload);
  }

  function buildReadinessForScope(scope, scopeId) {
    const key = scopeKey(scope, scopeId);
    const queue = pruneExpiredQueue(key);
    const pending = queue.filter((q) => !q.consumedAt);
    const highPriorityPending = pending.filter((p) => Number(p.priorityScore || 0) >= 80);
    const assignedPending = pending.filter((p) => !!p.assignedToUserId || !!p.assignedRole);
    const unassignedPending = pending.filter((p) => !p.assignedToUserId && !p.assignedRole);
    const now = Date.now();
    const highPriorityUnassignedStale = highPriorityPending.filter((p) => {
      if (p.assignedToUserId || p.assignedRole) return false;
      return now - isoMs(p.createdAt, now) >= READINESS_STALE_MS;
    }).length;

    const readiness = {
      scope,
      scopeId,
      queueDepth: pending.length,
      pendingSuggestions: pending.length,
      completedSuggestions: queue.length - pending.length,
      highPriorityPending: highPriorityPending.length,
      assignedPending: assignedPending.length,
      unassignedPending: unassignedPending.length,
      highPriorityUnassignedStale,
      updatedAt: nowIso(),
    };

    projectionStats.queueDepthByScope.set(key, readiness.queueDepth);
    projectionStats.readinessByScope.set(key, readiness);
    return readiness;
  }

  function recordIngestQueueLatency(ms) {
    const n = Math.max(0, Number(ms || 0));
    const lat = projectionStats.ingestToQueueLatencyMs;
    lat.count += 1;
    lat.total += n;
    lat.last = n;
    lat.max = Math.max(lat.max, n);
    lat.avg = lat.count ? Math.round((lat.total / lat.count) * 100) / 100 : 0;
  }

  function getReadiness(scope, scopeId) {
    const key = scopeKey(scope, scopeId);
    return projectionStats.readinessByScope.get(key) || buildReadinessForScope(scope, scopeId);
  }

  function pruneSeenEventKeys(now = Date.now()) {
    for (const [key, info] of seenEventKeys.entries()) {
      if (now - Number(info?.seenAt || 0) > SIGNAL_EVENT_DEDUPE_WINDOW_MS) {
        seenEventKeys.delete(key);
      }
    }
  }

  function validateIncomingSignal(raw = {}, context = {}) {
    if (!isPlainObject(raw)) {
      return { ok: false, error: "invalid_event", reason: "signal_not_object" };
    }

    const eventName = raw.event || raw.type || context.event || "";
    if (!eventName || typeof eventName !== "string") {
      return { ok: false, error: "invalid_event", reason: "missing_event_type" };
    }

    if (raw.ts && Number.isNaN(Date.parse(raw.ts))) {
      return { ok: false, error: "invalid_event", reason: "invalid_ts" };
    }

    if (!STRICT_ENVELOPE_REQUIRED) {
      return { ok: true };
    }

    const meta = isPlainObject(raw.meta) ? raw.meta : {};
    const eventId = raw.eventId || meta.eventId;
    const correlationId = raw.correlationId || meta.correlationId;
    const source = raw.sourceModule || raw.source || meta.source || context.sourceModule || context.ns;
    const version = raw.version || meta.version;
    const actorId = raw.actorId || meta.actorId || context.user?.id || raw.userId;

    if (!eventId) return { ok: false, error: "invalid_event", reason: "missing_event_id" };
    if (!correlationId) {
      return { ok: false, error: "invalid_event", reason: "missing_correlation_id" };
    }
    if (!source) return { ok: false, error: "invalid_event", reason: "missing_source" };
    if (!version) return { ok: false, error: "invalid_event", reason: "missing_version" };
    if (!actorId) return { ok: false, error: "invalid_event", reason: "missing_actor_id" };

    return { ok: true };
  }

  function dedupeKeyForSignal(signal) {
    if (signal.eventId) return `eventId:${signal.eventId}`;
    if (signal.correlationId) {
      return `corr:${signal.correlationId}:${signal.event}:${signal.scope}:${signal.scopeId}`;
    }
    return null;
  }

  function inferSignalType(eventName, payload) {
    const e = String(eventName || "");
    const status = String(payload?.status || payload?.state || "").toLowerCase();

    if (e.includes("mealplan:generated") || e.includes("mealAdded")) return "mealAdded";
    if (e.includes("mealplan:update") || e.includes("mealUpdated")) return "mealUpdated";

    if (e.includes("inventory:delta") || e.includes("inventoryAdded")) {
      if (toNum(payload?.qty || payload?.quantity, 0) < 0) return "inventoryUsed";
      return "inventoryAdded";
    }
    if (e.includes("shortage") || e.includes("inventoryShortage")) return "inventoryShortage";

    if (e.includes("garden:harvest") || e.includes("cropHarvested")) return "cropHarvested";
    if (e.includes("wateringDone")) return "wateringDone";

    if (e.includes("animalFed")) return "animalFed";
    if (e.includes("milkingDone")) return "milkingDone";
    if (e.includes("butcheryLogged")) return "butcheryLogged";

    if (e.includes("taskStarted") || status === "started" || status === "running") return "taskStarted";
    if (e.includes("taskCompleted") || status === "completed" || status === "done") return "taskCompleted";

    if (e.includes("automation:execution") && status === "completed") return "taskCompleted";

    return e || "unknownSignal";
  }

  function normalizeSignal(raw = {}, context = {}) {
    const eventName = raw.event || raw.type || context.event || "unknownSignal";
    const payload = raw.payload || raw.data || raw;

    const scope = raw.scope || context.scope || (context.user?.familyId ? "family" : "household");
    const scopeId =
      raw.scopeId ||
      context.scopeId ||
      (scope === "family" ? context.user?.familyId : context.user?.homeId) ||
      payload?.familyId ||
      payload?.homeId ||
      payload?.householdId ||
      "default";

    const meta = isPlainObject(raw.meta)
      ? raw.meta
      : isPlainObject(payload?.meta)
        ? payload.meta
        : {};

    const signal = {
      id: uuidv4(),
      eventId: String(raw.eventId || meta.eventId || ""),
      correlationId: String(raw.correlationId || meta.correlationId || ""),
      causationId: String(raw.causationId || meta.causationId || ""),
      type: inferSignalType(eventName, payload),
      event: String(eventName),
      ts: raw.ts || nowIso(),
      sourceModule:
        raw.sourceModule ||
        raw.source ||
        meta.source ||
        context.sourceModule ||
        context.ns ||
        payload?.source ||
        "unknown",
      version: String(raw.version || meta.version || "v1"),
      actorId: String(raw.actorId || meta.actorId || context.user?.id || raw.userId || payload?.userId || ""),
      privacyScope: raw.privacyScope || raw.privacy || "household",
      scope,
      scopeId: String(scopeId),
      userId: context.user?.id || raw.userId || payload?.userId || null,
      familyId: context.user?.familyId || raw.familyId || payload?.familyId || null,
      householdId:
        context.user?.homeId ||
        raw.householdId ||
        raw.homeId ||
        payload?.householdId ||
        payload?.homeId ||
        null,
      dependencies: Array.isArray(raw.dependencies)
        ? raw.dependencies
        : Array.isArray(payload?.dependencies)
          ? payload.dependencies
          : [],
      urgency: raw.urgency || payload?.urgency || "normal",
      completionPct: toNum(raw.completionPct ?? payload?.completionPct, 0),
      payload,
      consumed: false,
    };

    return signal;
  }

  function suggestionTemplatesFor(signal) {
    const p = signal.payload || {};
    const list = [];

    if (signal.type === "inventoryAdded") {
      list.push(
        {
          target: "cooking.sessions",
          action: "suggest-batch-creation",
          title: "Inventory threshold met for batch cooking",
          detail: `Evaluate batch opportunities for ${p?.sku || p?.name || "new inventory"}.`,
          urgency: "normal",
        },
        {
          target: "storehouse.planner",
          action: "verify-storage-allocation",
          title: "Verify storage placement",
          detail: `Confirm location and rotation for ${p?.sku || p?.name || "inventory item"}.`,
          urgency: "low",
        },
      );
    }

    if (signal.type === "inventoryShortage") {
      list.push(
        {
          target: "meal.planner",
          action: "suggest-substitutions",
          title: "Inventory shortage impacts meal plan",
          detail: `Shortage detected for ${p?.sku || p?.name || "item"}. Suggest substitutions.`,
          urgency: "high",
        },
        {
          target: "task.sessions",
          action: "create-restock-task",
          title: "Create restock task",
          detail: `Restock ${p?.sku || p?.name || "item"} below threshold.`,
          urgency: "high",
        },
      );
    }

    if (signal.type === "mealAdded" || signal.type === "mealUpdated") {
      list.push(
        {
          target: "storehouse.planner",
          action: "check-ingredient-availability",
          title: "Meal plan changed, verify ingredient availability",
          detail: "Check inventory coverage and flag shortage risks before session start.",
          urgency: signal.type === "mealUpdated" ? "normal" : "medium",
        },
        {
          target: "task.sessions",
          action: "prepare-prep-session",
          title: "Prepare meal prep task session",
          detail: "Convert planned meals into prep tasks and timing blocks.",
          urgency: "normal",
        },
      );
    }

    if (signal.type === "cropHarvested") {
      list.push(
        {
          target: "storehouse.planner",
          action: "add-harvest-inventory",
          title: "Harvest ready to inventory",
          detail: `Add harvested ${p?.crop || p?.name || "produce"} to inventory.`,
          urgency: "high",
          perishable: true,
        },
        {
          target: "cooking.sessions",
          action: "suggest-harvest-recipes",
          title: "Use fresh harvest in cooking",
          detail: `Create cooking session for harvested ${p?.crop || p?.name || "produce"}.`,
          urgency: "high",
          perishable: true,
        },
      );
    }

    if (signal.type === "animalFed" || signal.type === "milkingDone" || signal.type === "butcheryLogged") {
      list.push(
        {
          target: "preservation.planner",
          action: "suggest-preservation-session",
          title: "Animal output ready for preservation",
          detail: "Plan preservation or processing based on recent animal-care outputs.",
          urgency: signal.type === "milkingDone" ? "high" : "normal",
          perishable: signal.type === "milkingDone",
        },
        {
          target: "cooking.sessions",
          action: "suggest-production-session",
          title: "Animal output available for food production",
          detail: "Create food-production session from animal-care outputs.",
          urgency: "normal",
        },
      );
    }

    if (signal.type === "wateringDone") {
      list.push({
        target: "readiness.engine",
        action: "schedule-next-irrigation-check",
        title: "Irrigation updated, recalculate next watering tasks",
        detail: "Use crop cadence and weather assumptions to schedule next watering checks.",
        urgency: "low",
      });
    }

    if (signal.type === "taskStarted") {
      list.push({
        target: "readiness.engine",
        action: "monitor-active-dependencies",
        title: "Task started, monitor downstream dependencies",
        detail: "Track dependent tasks and rebalance queue if blockers appear.",
        urgency: "normal",
      });
    }

    if (signal.type === "taskCompleted") {
      list.push({
        target: "readiness.engine",
        action: "recalculate-readiness",
        title: "Task completed, recalculate readiness",
        detail: "Update dependent tasks and readiness priorities.",
        urgency: "normal",
      });
    }

    return list;
  }

  function pruneExpiredQueue(key) {
    const queue = suggestionQueues.get(key) || [];
    const now = Date.now();
    const filtered = queue.filter((item) => {
      if (item.consumedAt) return true;
      return isoMs(item.expiresAt, now + 1) > now;
    });
    if (filtered.length !== queue.length) {
      suggestionQueues.set(key, filtered);
      writeAudit("suggestion.queue.expired", {
        key,
        removed: queue.length - filtered.length,
      });
    }
    return suggestionQueues.get(key) || filtered;
  }

  function enqueueSuggestions(signal) {
    const templates = suggestionTemplatesFor(signal);
    if (!templates.length) return { created: [], merged: [] };

    const key = scopeKey(signal.scope, signal.scopeId);
    const queue = pruneExpiredQueue(key);
    const created = [];
    const merged = [];
    const subjectKey = inferSubjectKey(signal);
    const now = Date.now();

    for (const t of templates) {
      const hasDependencies = (signal.dependencies || []).length > 0;
      const score = priorityScore({
        urgency: t.urgency || signal.urgency,
        hasDependencies,
        perishable: !!t.perishable,
      });

      const existing = queue.find((q) => {
        if (q.consumedAt) return false;
        if (q.target !== t.target || q.action !== t.action) return false;
        if (String(q.metadata?.subjectKey || "") !== subjectKey) return false;
        return now - isoMs(q.lastSeenAt || q.createdAt, now) <= SUGGESTION_DEDUPE_WINDOW_MS;
      });

      if (existing) {
        existing.lastSeenAt = nowIso();
        existing.priorityScore = Math.max(existing.priorityScore || 0, score);
        existing.repeatCount = Number(existing.repeatCount || 1) + 1;
        existing.signalIds = Array.from(new Set([...(existing.signalIds || []), signal.id]));
        existing.metadata = {
          ...(existing.metadata || {}),
          sourceModule: signal.sourceModule,
          signalType: signal.type,
          urgency: t.urgency || signal.urgency,
          dependencies: signal.dependencies || [],
          completionPct: signal.completionPct,
          subjectKey,
        };
        merged.push(existing);
        continue;
      }

      const item = {
        id: uuidv4(),
        createdAt: nowIso(),
        lastSeenAt: nowIso(),
        expiresAt: new Date(Date.now() + DEFAULT_SUGGESTION_TTL_MS).toISOString(),
        consumedAt: null,
        consumedBy: null,
        assignedToUserId: null,
        assignedRole: null,
        assignmentTs: null,
        repeatCount: 1,
        signalIds: [signal.id],
        priorityScore: score,
        signalId: signal.id,
        scope: signal.scope,
        scopeId: signal.scopeId,
        target: t.target,
        action: t.action,
        title: t.title,
        detail: t.detail,
        metadata: {
          sourceModule: signal.sourceModule,
          signalType: signal.type,
          urgency: t.urgency || signal.urgency,
          dependencies: signal.dependencies || [],
          completionPct: signal.completionPct,
          subjectKey,
        },
      };

      queue.push(item);
      created.push(item);
    }

    queue.sort((a, b) => b.priorityScore - a.priorityScore || a.createdAt.localeCompare(b.createdAt));
    suggestionQueues.set(key, queue);

    return { created, merged };
  }

  function emitQueueUpdate(signal, createdItems, mergedItems = []) {
    const key = scopeKey(signal.scope, signal.scopeId);
    const queue = pruneExpiredQueue(key).filter((x) => !x.consumedAt);
    const readiness = buildReadinessForScope(signal.scope, signal.scopeId);

    const payload = {
      scope: signal.scope,
      scopeId: signal.scopeId,
      signalId: signal.id,
      queueDepth: queue.length,
      created: createdItems,
      merged: mergedItems,
      readiness,
      ts: nowIso(),
    };

    const room = scopeRoom(signal.scope, signal.scopeId);
    namespaceEmit("/core", "suggestion:queue:update", payload, room);
    writeAudit("suggestion.queue.update", { room, payload });
  }

  function projectSignal(signal) {
    const { created, merged } = enqueueSuggestions(signal);
    buildReadinessForScope(signal.scope, signal.scopeId);
    if (created.length || merged.length) emitQueueUpdate(signal, created, merged);
    return { created, merged };
  }

  function ingest(rawSignal = {}, context = {}) {
    const ingestStartedAt = Date.now();
    if (!context?._alreadyAppended && shouldAppendSignals()) {
      const appended = appendSignal(rawSignal, context);
      if (!appended.ok) return appended;
    }

    const valid = validateIncomingSignal(rawSignal, context);
    if (!valid.ok) {
      ingestStats.droppedInvalid += 1;
      writeAudit("signal.invalid", {
        error: valid.error,
        reason: valid.reason,
        sourceModule: context?.sourceModule || context?.ns || "unknown",
      });
      return { ok: false, error: valid.error, reason: valid.reason };
    }

    const signal = normalizeSignal(rawSignal, context);

    pruneSeenEventKeys();
    const dedupeKey = dedupeKeyForSignal(signal);
    const seen = dedupeKey ? seenEventKeys.get(dedupeKey) : null;
    if (seen) {
      ingestStats.droppedDuplicate += 1;
      writeAudit("signal.duplicate", {
        dedupeKey,
        priorSignalId: seen.signalId,
        eventId: signal.eventId || null,
        correlationId: signal.correlationId || null,
      });
      return {
        ok: false,
        error: "duplicate_event",
        reason: "duplicate_event_id",
        duplicateOf: seen.signalId,
      };
    }

    if (dedupeKey) {
      seenEventKeys.set(dedupeKey, {
        signalId: signal.id,
        seenAt: Date.now(),
      });
    }

    capPush(signalHistory, signal, MAX_SIGNAL_HISTORY);
    ingestStats.accepted += 1;

    namespaceEmit("/core", "signal:aggregated", signal, scopeRoom(signal.scope, signal.scopeId));
    writeAudit("signal.ingested", { signalId: signal.id, type: signal.type, scope: signal.scope, scopeId: signal.scopeId });

    const { created, merged } = projectSignal(signal);

    recordIngestQueueLatency(Date.now() - ingestStartedAt);

    return { ok: true, signal, createdSuggestions: created, mergedSuggestions: merged };
  }

  function listSuggestions({
    scope = "household",
    scopeId,
    includeConsumed = false,
    target,
    domain,
    assignedToUserId,
  } = {}) {
    const key = scopeKey(scope, normalizeScopeId(scopeId));
    const list = pruneExpiredQueue(key);
    return list.filter((x) => {
      if (!includeConsumed && x.consumedAt) return false;
      if (target && x.target !== target) return false;
      if (assignedToUserId && x.assignedToUserId !== assignedToUserId) return false;
      if (domain) {
        const d = String(x.target || "").split(/[.:/]/).filter(Boolean)[0] || "other";
        if (String(domain) !== d) return false;
      }
      return true;
    });
  }

  function consumeSuggestion({ scope = "household", scopeId, suggestionId, userId, _alreadyAppended = false }) {
    const key = scopeKey(scope, String(scopeId || "default"));
    const queue = suggestionQueues.get(key) || [];
    const item = queue.find((x) => x.id === suggestionId);
    if (!item) return null;

    if (shouldAppendSignals() && !_alreadyAppended) {
      const appended = appendSuggestionAction("suggestion.consume", {
        scope,
        scopeId,
        suggestionId,
        userId: userId || null,
        target: item.target,
        action: item.action,
      });
      if (!appended.ok) {
        writeAudit("eventlog.append.failed", {
          action: "suggestion.consume",
          error: appended.error,
          reason: appended.reason,
        });
      }
    }

    if (!item.consumedAt) {
      item.consumedAt = nowIso();
      item.consumedBy = userId || null;
    }

    const payload = {
      scope,
      scopeId: String(scopeId || "default"),
      suggestionId,
      consumedBy: userId || null,
      consumedAt: item.consumedAt,
    };

    namespaceEmit("/core", "suggestion:queue:consumed", payload, scopeRoom(scope, String(scopeId || "default")));
    writeAudit("suggestion.consumed", payload);
    buildReadinessForScope(scope, String(scopeId || "default"));

    return item;
  }

  function assignSuggestion({
    scope = "household",
    scopeId,
    suggestionId,
    assignedToUserId,
    assignedRole,
    assignedBy,
    _alreadyAppended = false,
  }) {
    const key = scopeKey(scope, normalizeScopeId(scopeId));
    const queue = pruneExpiredQueue(key);
    const item = queue.find((x) => x.id === suggestionId);
    if (!item) return null;
    if (item.consumedAt) return item;

    if (shouldAppendSignals() && !_alreadyAppended) {
      const appended = appendSuggestionAction("suggestion.assign", {
        scope,
        scopeId,
        suggestionId,
        assignedToUserId: assignedToUserId || null,
        assignedRole: assignedRole || null,
        assignedBy: assignedBy || null,
        target: item.target,
        action: item.action,
      });
      if (!appended.ok) {
        writeAudit("eventlog.append.failed", {
          action: "suggestion.assign",
          error: appended.error,
          reason: appended.reason,
        });
      }
    }

    item.assignedToUserId = assignedToUserId || null;
    item.assignedRole = assignedRole || null;
    item.assignmentTs = nowIso();

    const payload = {
      scope: normalizeScope(scope),
      scopeId: normalizeScopeId(scopeId),
      suggestionId,
      assignedToUserId: item.assignedToUserId,
      assignedRole: item.assignedRole,
      assignedBy: assignedBy || null,
      assignmentTs: item.assignmentTs,
    };

    namespaceEmit("/core", "suggestion:queue:assigned", payload, scopeRoom(scope, normalizeScopeId(scopeId)));
    writeAudit("suggestion.assigned", payload);
    buildReadinessForScope(normalizeScope(scope), normalizeScopeId(scopeId));
    return item;
  }

  function aggregateReportForScope(scope, scopeId) {
    const key = scopeKey(scope, scopeId);
    const queue = pruneExpiredQueue(key);

    const last24h = Date.now() - 1000 * 60 * 60 * 24;
    const scopeSignals = signalHistory.filter((s) => {
      if (s.scope !== scope || s.scopeId !== scopeId) return false;
      const t = Date.parse(s.ts || "");
      return Number.isFinite(t) ? t >= last24h : true;
    });

    const byType = {};
    for (const s of scopeSignals) {
      byType[s.type] = (byType[s.type] || 0) + 1;
    }

    const readiness = getReadiness(scope, scopeId);
    const pending = queue.filter((q) => !q.consumedAt);
    const report = {
      id: uuidv4(),
      generatedAt: nowIso(),
      scope,
      scopeId,
      summary: {
        signals24h: scopeSignals.length,
        pendingSuggestions: readiness.pendingSuggestions,
        completedSuggestions: readiness.completedSuggestions,
        highPriorityPending: readiness.highPriorityPending,
        assignedPending: readiness.assignedPending,
        unassignedPending: readiness.unassignedPending,
        highPriorityUnassignedStale: readiness.highPriorityUnassignedStale,
      },
      signalBreakdown: byType,
      topSuggestions: [...pending].slice(0, 10),
    };

    const graphSummary = projector?.getScopeSummary ? projector.getScopeSummary(scope, scopeId) : null;
    if (graphSummary) {
      // Optional extension, intentionally outside required summary contract.
      report.graph = graphSummary;
    }

    latestReports.set(key, report);
    return report;
  }

  function generateReports({ _alreadyAppended = false } = {}) {
    if (shouldAppendSignals() && !_alreadyAppended) {
      const appended = appendSuggestionAction("report.generate", {});
      if (!appended.ok) {
        writeAudit("eventlog.append.failed", {
          action: "report.generate",
          error: appended.error,
          reason: appended.reason,
        });
      }
    }

    const touched = new Set();
    for (const s of signalHistory) {
      touched.add(scopeKey(s.scope, s.scopeId));
    }

    for (const key of touched) {
      const [scope, scopeId] = key.split(":");
      const report = aggregateReportForScope(scope, scopeId);
      namespaceEmit("/core", "report:updated", report, scopeRoom(scope, scopeId));
      writeAudit("report.generated", { scope, scopeId, reportId: report.id });
    }
  }

  function getLatestReport({ scope = "household", scopeId } = {}) {
    return latestReports.get(scopeKey(scope, String(scopeId || "default"))) || null;
  }

  function onClientEvent(evt) {
    const event = String(evt?.event || "");
    if (event !== "signal:emit") return;
    ingest(evt.payload || {}, {
      ns: evt.ns,
      user: evt.user,
      event,
      sourceModule: evt.ns || "socket.client",
      scope: evt.user?.familyId ? "family" : "household",
      scopeId: evt.user?.familyId || evt.user?.homeId || "default",
    });
  }

  function onBridgeEmit(evt) {
    if (!evt || !evt.event) return;
    ingest(
      {
        type: evt.event,
        payload: evt.payload,
      },
      {
        ns: evt.ns || "/core",
        event: evt.event,
        sourceModule: evt.ns || "bridge",
        scope: evt.payload?.familyId ? "family" : "household",
        scopeId:
          evt.payload?.familyId ||
          evt.payload?.homeId ||
          evt.payload?.householdId ||
          "default",
      },
    );
  }

  function start() {
    if (reportTimer) return;

    if (replayOnBootEnabled) {
      try {
        replayFromEventLog();
      } catch {
        writeAudit("replay.failed", { reason: "boot_replay_failed" });
      }
    }

    eventBus.on("client:event", onClientEvent);
    eventBus.on("bridge:emit", onBridgeEmit);
    eventBus.on("realtime:signal:ingest", ({ payload, context }) => ingest(payload, context));
    eventBus.on("realtime:suggestion:consume", (args) => consumeSuggestion(args));
    eventBus.on("realtime:suggestion:assign", (args) => assignSuggestion(args));
    eventBus.on("realtime:report:generate", () => generateReports());

    reportTimer = setInterval(() => {
      try {
        generateReports();
      } catch {
        // keep interval alive
      }
    }, REPORT_INTERVAL_MS);

    if (typeof reportTimer.unref === "function") reportTimer.unref();

    writeAudit("realtime.started", { reportIntervalMs: REPORT_INTERVAL_MS });
  }

  function stop() {
    if (reportTimer) {
      clearInterval(reportTimer);
      reportTimer = null;
    }

    eventBus.off("client:event", onClientEvent);
    eventBus.off("bridge:emit", onBridgeEmit);

    writeAudit("realtime.stopped");
  }

  function applyReplayEntry(entry = {}) {
        function resolveReplaySuggestionId(p = {}) {
          const key = scopeKey(p.scope, normalizeScopeId(p.scopeId));
          const queue = suggestionQueues.get(key) || [];
          const byId = queue.find((x) => x.id === p.suggestionId);
          if (byId) return byId.id;

          if (p.target && p.action) {
            const byTargetAction = queue.find(
              (x) => !x.consumedAt && x.target === p.target && x.action === p.action,
            );
            if (byTargetAction) return byTargetAction.id;
          }

          return null;
        }

    const entryId = String(entry?.id || "");
    if (!entryId || replayedEntryIds.has(entryId)) return false;
    replayedEntryIds.add(entryId);
    enqueueGraphProjection(entry, { source: "replay" });

    const kind = String(entry?.kind || "");
    const payload = entry?.payload || {};

    if (kind === "signal.ingest") {
      const out = ingest(payload.signal || {}, {
        ...(payload.context || {}),
        _alreadyAppended: true,
      });
      if (out?.ok !== false) ingestStats.replayed += 1;
      return true;
    }

    if (kind === "suggestion.assign") {
      const resolvedId = resolveReplaySuggestionId(payload);
      if (!resolvedId) return false;
      assignSuggestion({
        scope: payload.scope,
        scopeId: payload.scopeId,
        suggestionId: resolvedId,
        assignedToUserId: payload.assignedToUserId,
        assignedRole: payload.assignedRole,
        assignedBy: payload.assignedBy,
        _alreadyAppended: true,
      });
      ingestStats.replayed += 1;
      return true;
    }

    if (kind === "suggestion.consume") {
      const resolvedId = resolveReplaySuggestionId(payload);
      if (!resolvedId) return false;
      consumeSuggestion({
        scope: payload.scope,
        scopeId: payload.scopeId,
        suggestionId: resolvedId,
        userId: payload.userId,
        _alreadyAppended: true,
      });
      ingestStats.replayed += 1;
      return true;
    }

    if (kind === "report.generate") {
      generateReports({ _alreadyAppended: true });
      ingestStats.replayed += 1;
      return true;
    }

    return false;
  }

  function replayFromEventLog({ force = false } = {}) {
    if (!store || typeof store.readAll !== "function") {
      return { ok: true, replayed: 0, reason: "eventlog_disabled" };
    }

    const all = store.readAll();
    const checkpoint = force ? null : store.getCheckpoint?.(REPLAY_CHECKPOINT_KEY);
    const startIndex = Number.isInteger(checkpoint?.lastIndex) ? checkpoint.lastIndex + 1 : 0;

    let replayed = 0;
    for (let i = Math.max(0, startIndex); i < all.length; i += 1) {
      if (applyReplayEntry(all[i])) replayed += 1;
    }

    const marker = {
      at: nowIso(),
      lastIndex: all.length - 1,
      replayed,
      total: all.length,
    };
    try {
      store.setCheckpoint?.(REPLAY_CHECKPOINT_KEY, marker);
    } catch {
      // no-op
    }

    writeAudit("replay.completed", marker);
    return { ok: true, ...marker };
  }

  return {
    start,
    stop,
    ingest,
    listSuggestions,
    consumeSuggestion,
    assignSuggestion,
    generateReports,
    getLatestReport,
    getAuditHistory({ limit = 200 } = {}) {
      const l = Math.max(1, Math.min(Number(limit || 200), MAX_AUDIT_HISTORY));
      return auditHistory.slice(-l);
    },
    getSignalHistory({ limit = 200 } = {}) {
      const l = Math.max(1, Math.min(Number(limit || 200), MAX_SIGNAL_HISTORY));
      return signalHistory.slice(-l);
    },
    getState() {
      return {
        signalCount: signalHistory.length,
        auditCount: auditHistory.length,
        appendLogEnabled: shouldAppendSignals(),
        ingest: {
          accepted: ingestStats.accepted,
          droppedInvalid: ingestStats.droppedInvalid,
          droppedDuplicate: ingestStats.droppedDuplicate,
          replayed: ingestStats.replayed,
        },
        projection: {
          readinessScopes: projectionStats.readinessByScope.size,
          latency: {
            ...projectionStats.ingestToQueueLatencyMs,
          },
        },
        graphProjection: projector?.getState ? projector.getState() : null,
        queues: Array.from(suggestionQueues.entries()).map(([k, v]) => ({ key: k, size: v.length })),
      };
    },
    getDiagnostics({ scope = null, scopeId = null } = {}) {
      const readiness =
        scope && scopeId
          ? [getReadiness(scope, scopeId)]
          : Array.from(projectionStats.readinessByScope.values());
      return {
        ingest: { ...ingestStats },
        projection: {
          queueDepthByScope: Object.fromEntries(projectionStats.queueDepthByScope.entries()),
          readiness,
          latency: { ...projectionStats.ingestToQueueLatencyMs },
        },
        graphProjection: projector?.getDiagnostics
          ? projector.getDiagnostics({ scope, scopeId })
          : projector?.getState
            ? { state: projector.getState() }
            : null,
      };
    },
    shouldAppendSignals,
    appendSignal,
    appendSuggestionAction,
    replayFromEventLog,
  };
}

module.exports = {
  createCoordinator,
};
