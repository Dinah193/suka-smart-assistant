// C:\Users\larho\suka-smart-assistant\src\server\services\realtimeCoordinator.js
//
// Realtime signal aggregation + suggestion queues + reporting worker (MVP).
// In-memory implementation for fast integration with existing Socket/EventBus.

"use strict";

const { v4: uuidv4 } = require("uuid");

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

function capPush(arr, item, max) {
  arr.push(item);
  while (arr.length > max) arr.shift();
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

function createCoordinator({ eventBus, namespaceEmit }) {
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

  let reportTimer = null;

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

    const signal = {
      id: uuidv4(),
      type: inferSignalType(eventName, payload),
      event: String(eventName),
      ts: raw.ts || nowIso(),
      sourceModule:
        raw.sourceModule ||
        context.sourceModule ||
        context.ns ||
        payload?.source ||
        "unknown",
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

    const payload = {
      scope: signal.scope,
      scopeId: signal.scopeId,
      signalId: signal.id,
      queueDepth: queue.length,
      created: createdItems,
      merged: mergedItems,
      ts: nowIso(),
    };

    const room = scopeRoom(signal.scope, signal.scopeId);
    namespaceEmit("/core", "suggestion:queue:update", payload, room);
    writeAudit("suggestion.queue.update", { room, payload });
  }

  function ingest(rawSignal = {}, context = {}) {
    const signal = normalizeSignal(rawSignal, context);
    capPush(signalHistory, signal, MAX_SIGNAL_HISTORY);

    namespaceEmit("/core", "signal:aggregated", signal, scopeRoom(signal.scope, signal.scopeId));
    writeAudit("signal.ingested", { signalId: signal.id, type: signal.type, scope: signal.scope, scopeId: signal.scopeId });

    const { created, merged } = enqueueSuggestions(signal);
    if (created.length || merged.length) emitQueueUpdate(signal, created, merged);

    return { signal, createdSuggestions: created, mergedSuggestions: merged };
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

  function consumeSuggestion({ scope = "household", scopeId, suggestionId, userId }) {
    const key = scopeKey(scope, String(scopeId || "default"));
    const queue = suggestionQueues.get(key) || [];
    const item = queue.find((x) => x.id === suggestionId);
    if (!item) return null;
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

    return item;
  }

  function assignSuggestion({ scope = "household", scopeId, suggestionId, assignedToUserId, assignedRole, assignedBy }) {
    const key = scopeKey(scope, normalizeScopeId(scopeId));
    const queue = pruneExpiredQueue(key);
    const item = queue.find((x) => x.id === suggestionId);
    if (!item) return null;
    if (item.consumedAt) return item;

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

    const pending = queue.filter((q) => !q.consumedAt);
    const report = {
      id: uuidv4(),
      generatedAt: nowIso(),
      scope,
      scopeId,
      summary: {
        signals24h: scopeSignals.length,
        pendingSuggestions: pending.length,
        completedSuggestions: queue.length - pending.length,
        highPriorityPending: pending.filter((p) => p.priorityScore >= 80).length,
        assignedPending: pending.filter((p) => !!p.assignedToUserId || !!p.assignedRole).length,
        unassignedPending: pending.filter((p) => !p.assignedToUserId && !p.assignedRole).length,
      },
      signalBreakdown: byType,
      topSuggestions: [...pending].slice(0, 10),
    };

    latestReports.set(key, report);
    return report;
  }

  function generateReports() {
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
        queues: Array.from(suggestionQueues.entries()).map(([k, v]) => ({ key: k, size: v.length })),
      };
    },
  };
}

module.exports = {
  createCoordinator,
};
