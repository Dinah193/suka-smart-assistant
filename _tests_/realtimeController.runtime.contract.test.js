import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function hasModule(id) {
  try {
    require.resolve(id);
    return true;
  } catch {
    return false;
  }
}

const runtimeFlag = String(process.env.SSA_ENABLE_RUNTIME_CONTRACT_TESTS || "").toLowerCase();
const runtimeEnabled = runtimeFlag === "1" || runtimeFlag === "true" || runtimeFlag === "yes";
const depsReady = hasModule("express") && hasModule("socket.io");
const canRun = runtimeEnabled && depsReady;

const runtimeDescribe = canRun ? describe : describe.skip;

function makeCoordinatorStub() {
  const seenEvents = new Set();
  const callOrder = [];
  const state = {
    suggestions: [
      {
        id: "s1",
        scope: "household",
        scopeId: "home-1",
        target: "task.sessions",
        action: "create-restock-task",
        title: "Create restock task",
        priorityScore: 85,
        consumedAt: null,
        assignedToUserId: null,
        assignedRole: null,
      },
    ],
    signals: [{ id: "sig-seed-1", type: "inventoryAdded" }, { id: "sig-seed-2", type: "inventoryAdded" }],
    audit: [{ id: "a1", type: "x" }, { id: "a2", type: "y" }, { id: "a3", type: "z" }],
  };

  function recomputeReport() {
    const pending = state.suggestions.filter((x) => !x.consumedAt);
    return {
      id: "r1",
      scope: "household",
      scopeId: "home-1",
      generatedAt: new Date().toISOString(),
      summary: {
        signals24h: state.signals.length,
        pendingSuggestions: pending.length,
        completedSuggestions: state.suggestions.length - pending.length,
        highPriorityPending: pending.filter((x) => Number(x.priorityScore || 0) >= 80).length,
        assignedPending: pending.filter((x) => !!x.assignedToUserId || !!x.assignedRole).length,
        unassignedPending: pending.filter((x) => !x.assignedToUserId && !x.assignedRole).length,
      },
      signalBreakdown: {
        inventoryAdded: state.signals.filter((s) => s.type === "inventoryAdded").length,
      },
    };
  }

  return {
    shouldAppendSignals: vi.fn(() => true),
    appendSignal: vi.fn((payload) => {
      callOrder.push("append");
      if (payload?.forceAppendFailure) {
        return { ok: false, error: "event_log_unavailable", reason: "append_failed" };
      }
      return { ok: true, entry: { id: "entry-1" } };
    }),
    appendSuggestionAction: vi.fn(() => ({ ok: true, entry: { id: "entry-action" } })),
    getState: vi.fn(() => ({ signalCount: 1 })),
    ingest: vi.fn((payload) => {
      callOrder.push("ingest");
      if (!payload || typeof payload !== "object") {
        return { ok: false, error: "invalid_event", reason: "signal_not_object" };
      }
      if (!payload.type && !payload.event) {
        return { ok: false, error: "invalid_event", reason: "missing_event_type" };
      }
      if (payload.eventId && seenEvents.has(payload.eventId)) {
        return { ok: false, error: "duplicate_event", reason: "duplicate_event_id" };
      }
      if (payload.eventId) seenEvents.add(payload.eventId);
      const signalId = `sig-${state.signals.length + 1}`;
      state.signals.push({ id: signalId, type: "inventoryAdded" });
      return { ok: true, signal: { id: signalId }, createdSuggestions: [] };
    }),
    listSuggestions: vi.fn(({ includeConsumed = false } = {}) =>
      state.suggestions.filter((s) => (includeConsumed ? true : !s.consumedAt))
    ),
    consumeSuggestion: vi.fn(({ suggestionId, userId } = {}) => {
      const item = state.suggestions.find((x) => x.id === suggestionId);
      if (!item) return null;
      item.consumedAt = new Date().toISOString();
      item.consumedBy = userId || "u1";
      return { ...item };
    }),
    assignSuggestion: vi.fn(({ suggestionId, assignedToUserId, assignedRole } = {}) => {
      const item = state.suggestions.find((x) => x.id === suggestionId);
      if (!item) return null;
      item.assignedToUserId = assignedToUserId || null;
      item.assignedRole = assignedRole || null;
      item.assignmentTs = new Date().toISOString();
      return { ...item };
    }),
    generateReports: vi.fn(() => undefined),
    getLatestReport: vi.fn(() => recomputeReport()),
    getAuditHistory: vi.fn(({ limit = 200 } = {}) => state.audit.slice(-Math.max(1, Number(limit || 200)))),
    getSignalHistory: vi.fn(({ limit = 200 } = {}) => state.signals.slice(-Math.max(1, Number(limit || 200)))),
    _callOrder: callOrder,
  };
}

function makeReplayCoordinator(store) {
  const state = {
    suggestions: [],
    report: null,
  };

  function applyEvent(evt) {
    const sig = evt?.signal || {};
    const scope = sig.scope || "household";
    const scopeId = sig.scopeId || "home-1";
    const suggestion = {
      id: `s-${sig.eventId || Math.random().toString(36).slice(2)}`,
      scope,
      scopeId,
      target: "task.sessions",
      action: "create-restock-task",
      title: "Create restock task",
      consumedAt: null,
      assignedToUserId: null,
    };
    state.suggestions.push(suggestion);
    state.report = {
      id: "r-replay",
      scope,
      scopeId,
      generatedAt: new Date().toISOString(),
      summary: {
        signals24h: state.suggestions.length,
        pendingSuggestions: state.suggestions.filter((x) => !x.consumedAt).length,
        completedSuggestions: state.suggestions.filter((x) => !!x.consumedAt).length,
        highPriorityPending: 0,
        assignedPending: state.suggestions.filter((x) => !!x.assignedToUserId).length,
        unassignedPending: state.suggestions.filter((x) => !x.assignedToUserId).length,
      },
      signalBreakdown: { inventoryAdded: state.suggestions.length },
    };
  }

  return {
    shouldAppendSignals: () => true,
    appendSignal(payload) {
      if (payload?.forceAppendFailure) {
        return { ok: false, error: "event_log_unavailable", reason: "append_failed" };
      }
      store.events.push({ kind: "signal.ingest", signal: payload });
      return { ok: true, entry: { id: `e-${store.events.length}` } };
    },
    appendSuggestionAction() {
      return { ok: true, entry: { id: `a-${Date.now()}` } };
    },
    ingest(payload) {
      if (!payload || (!payload.type && !payload.event)) {
        return { ok: false, error: "invalid_event", reason: "missing_event_type" };
      }
      applyEvent({ signal: payload });
      return { ok: true, signal: { id: "sig-replay-1" }, createdSuggestions: [] };
    },
    replayFromEventLog() {
      const start = store.checkpoint + 1;
      for (let i = start; i < store.events.length; i += 1) {
        const evt = store.events[i];
        if (evt.kind === "signal.ingest") applyEvent(evt);
        store.checkpoint = i;
      }
      return { ok: true };
    },
    listSuggestions() {
      return state.suggestions.slice();
    },
    consumeSuggestion() {
      return null;
    },
    assignSuggestion() {
      return null;
    },
    generateReports() {},
    getLatestReport() {
      return state.report;
    },
    getAuditHistory() {
      return [];
    },
    getSignalHistory() {
      return [];
    },
    getState() {
      return { signalCount: state.suggestions.length };
    },
  };
}

runtimeDescribe("realtimeController runtime contract", () => {
  let app;
  let server;
  let req;
  let socketMod;
  let restoreCoordinator;
  let currentCoordinator;

  beforeAll(async () => {
    const express = require("express");
    const controller = require("../src/server/routes/realtimeController.js");

    socketMod = require("../src/server/socket.js");
    const original = socketMod.getRealtimeCoordinator;
    currentCoordinator = makeCoordinatorStub();
    socketMod.getRealtimeCoordinator = () => currentCoordinator;
    restoreCoordinator = () => {
      socketMod.getRealtimeCoordinator = original;
    };

    app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(controller.basePath, controller.router);

    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    const origin = `http://127.0.0.1:${server.address().port}`;
    req = async (path, { method = "GET", headers = {}, body } = {}) => {
      const res = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      return { status: res.status, body: json };
    };

    req.text = async (path, { method = "GET", headers = {}, body } = {}) => {
      const res = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, text, headers: res.headers };
    };
  });

  beforeEach(() => {
    currentCoordinator = makeCoordinatorStub();
    socketMod.getRealtimeCoordinator = () => currentCoordinator;
  });

  afterAll(async () => {
    try {
      restoreCoordinator?.();
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
  });

  it("returns suggestions/suggestion aliases and enforces scope", async () => {
    const list = await req("/api/realtime/suggestions", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(Array.isArray(list.body.suggestions)).toBe(true);

    const consume = await req("/api/realtime/suggestions/s1/consume", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: {},
    });

    expect(consume.status).toBe(200);
    expect(consume.body.item).toBeTruthy();
    expect(consume.body.suggestion).toBeTruthy();

    const assign = await req("/api/realtime/suggestions/s1/assign", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: { assignedToUserId: "u1", assignedRole: "cook" },
    });

    expect(assign.status).toBe(200);
    expect(assign.body.item).toBeTruthy();
    expect(assign.body.suggestion).toBeTruthy();

    const forbidden = await req("/api/realtime/suggestions?scope=household&householdId=home-2", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe("forbidden_scope");
  });

  it("returns invalid_event and duplicate_event contracts for signal ingestion", async () => {
    const invalid = await req("/api/realtime/signals", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: { signal: {} },
    });

    expect(invalid.status).toBe(400);
    expect(invalid.body.ok).toBe(false);
    expect(invalid.body.error).toBe("invalid_event");

    const first = await req("/api/realtime/signals", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: {
        signal: {
          eventId: "evt-contract-1",
          correlationId: "corr-contract-1",
          type: "inventoryAdded",
          event: "inventory:delta",
          payload: { sku: "rice", qty: 2 },
        },
      },
    });

    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.signal?.id).toBeTruthy();

    const duplicate = await req("/api/realtime/signals", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: {
        signal: {
          eventId: "evt-contract-1",
          correlationId: "corr-contract-2",
          type: "inventoryAdded",
          event: "inventory:delta",
          payload: { sku: "rice", qty: 2 },
        },
      },
    });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.ok).toBe(false);
    expect(duplicate.body.error).toBe("duplicate_event");
  });

  it("appends event before coordinator mutation on POST /signals", async () => {
    const list = await req("/api/realtime/signals", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: {
        signal: {
          eventId: "evt-order-1",
          correlationId: "corr-order-1",
          type: "inventoryAdded",
          event: "inventory:delta",
          payload: { sku: "rice", qty: 1 },
        },
      },
    });

    expect(list.status).toBe(200);
    const c = socketMod.getRealtimeCoordinator();
    expect(c._callOrder.slice(0, 2)).toEqual(["append", "ingest"]);
  });

  it("returns family_scope_forbidden and household_scope_missing when scope ids are absent", async () => {
    const familyMissing = await req("/api/realtime/suggestions?scope=family", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(familyMissing.status).toBe(403);
    expect(familyMissing.body.error).toBe("family_scope_forbidden");

    const householdMissing = await req("/api/realtime/suggestions", {
      headers: { "x-user-id": "u1" },
    });

    expect(householdMissing.status).toBe(403);
    expect(householdMissing.body.error).toBe("household_scope_missing");
  });

  it("returns 503 with stable contract when append store fails", async () => {
    const fail = await req("/api/realtime/signals", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: {
        signal: {
          forceAppendFailure: true,
          eventId: "evt-fail-1",
          correlationId: "corr-fail-1",
          type: "inventoryAdded",
          event: "inventory:delta",
          payload: { sku: "rice", qty: 1 },
        },
      },
    });

    expect(fail.status).toBe(503);
    expect(fail.body.ok).toBe(false);
    expect(fail.body.error).toBe("event_log_unavailable");
    expect(fail.body.reason).toBe("append_failed");
  });

  it("returns realtime_not_ready when coordinator is unavailable", async () => {
    socketMod.getRealtimeCoordinator = () => null;

    const out = await req("/api/realtime/suggestions", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(out.status).toBe(503);
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toBe("realtime_not_ready");
  });

  it("returns suggestion_not_found for consume/assign unknown suggestion id", async () => {
    const consume = await req("/api/realtime/suggestions/unknown-id/consume", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: {},
    });
    expect(consume.status).toBe(404);
    expect(consume.body.error).toBe("suggestion_not_found");

    const assign = await req("/api/realtime/suggestions/unknown-id/assign", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: { assignedToUserId: "u1", assignedRole: "cook" },
    });
    expect(assign.status).toBe(404);
    expect(assign.body.error).toBe("suggestion_not_found");
  });

  it("returns report_not_found when latest report CSV is unavailable", async () => {
    const coordinator = makeCoordinatorStub();
    coordinator.getLatestReport = vi.fn(() => null);
    coordinator.generateReports = vi.fn(() => undefined);
    currentCoordinator = coordinator;
    socketMod.getRealtimeCoordinator = () => currentCoordinator;

    const out = await req.text("/api/realtime/reports/latest.csv", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(out.status).toBe(404);
    const payload = JSON.parse(out.text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("report_not_found");
  });

  it("simulates restart + replay to restore suggestions and latest report", async () => {
    const shared = { events: [], checkpoint: -1 };
    const firstCoordinator = makeReplayCoordinator(shared);
    socketMod.getRealtimeCoordinator = () => firstCoordinator;

    const post = await req("/api/realtime/signals", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: {
        signal: {
          eventId: "evt-restart-1",
          correlationId: "corr-restart-1",
          type: "inventoryAdded",
          event: "inventory:delta",
          payload: { sku: "barley", qty: 2 },
        },
      },
    });
    expect(post.status).toBe(200);

    const beforeRestartList = await req("/api/realtime/suggestions", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });
    const beforeRestartReport = await req("/api/realtime/reports/latest", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    const secondCoordinator = makeReplayCoordinator(shared);
    secondCoordinator.replayFromEventLog();
    socketMod.getRealtimeCoordinator = () => secondCoordinator;

    const afterRestartList = await req("/api/realtime/suggestions", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });
    const afterRestartReport = await req("/api/realtime/reports/latest", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(afterRestartList.status).toBe(200);
    expect(afterRestartList.body.count).toBe(beforeRestartList.body.count);
    expect(afterRestartReport.status).toBe(200);
    expect(afterRestartReport.body.report?.summary?.signals24h).toBe(
      beforeRestartReport.body.report?.summary?.signals24h
    );
  });

  it("health stays OK when replay is disabled", async () => {
    const coordinator = makeCoordinatorStub();
    coordinator.replayFromEventLog = undefined;
    socketMod.getRealtimeCoordinator = () => coordinator;

    const health = await req("/api/realtime/health", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.coordinatorReady).toBe(true);
  });

  it("reports/latest includes readiness summary keys", async () => {
    const out = await req("/api/realtime/reports/latest", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(out.status).toBe(200);
    expect(out.body.report?.summary).toBeTruthy();
    expect(typeof out.body.report.summary.pendingSuggestions).toBe("number");
    expect(typeof out.body.report.summary.assignedPending).toBe("number");
    expect(typeof out.body.report.summary.unassignedPending).toBe("number");
    expect(typeof out.body.report.summary.highPriorityPending).toBe("number");
  });

  it("POST /suggestions/:id/assign updates subsequent /suggestions listing", async () => {
    const assign = await req("/api/realtime/suggestions/s1/assign", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: { assignedToUserId: "u-assign-rt", assignedRole: "cook" },
    });
    expect(assign.status).toBe(200);

    const list = await req("/api/realtime/suggestions", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });
    const item = (list.body.items || []).find((x) => x.id === "s1");
    expect(item?.assignedToUserId).toBe("u-assign-rt");
  });

  it("POST /suggestions/:id/consume updates subsequent /reports/latest summary", async () => {
    const before = await req("/api/realtime/reports/latest", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    const consume = await req("/api/realtime/suggestions/s1/consume", {
      method: "POST",
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
      body: {},
    });
    expect(consume.status).toBe(200);

    const after = await req("/api/realtime/reports/latest", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(after.body.report.summary.pendingSuggestions).toBeLessThanOrEqual(
      before.body.report.summary.pendingSuggestions
    );
    expect(after.body.report.summary.completedSuggestions).toBeGreaterThanOrEqual(
      before.body.report.summary.completedSuggestions
    );
  });

  it("GET /audit honors limit query param", async () => {
    const out = await req("/api/realtime/audit?limit=2", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(out.status).toBe(200);
    expect(out.body.items.length).toBeLessThanOrEqual(2);
  });

  it("GET /signals honors limit query param", async () => {
    const out = await req("/api/realtime/signals?limit=1", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(out.status).toBe(200);
    expect(out.body.items.length).toBeLessThanOrEqual(1);
  });

  it("CSV export keeps required columns", async () => {
    const out = await req.text("/api/realtime/reports/latest.csv", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(out.status).toBe(200);
    expect(out.text.includes('"metric","value"')).toBe(true);
    expect(out.text.includes('"pendingSuggestions"')).toBe(true);
    expect(out.text.includes('"assignedPending"')).toBe(true);
    expect(out.text.includes('"unassignedPending"')).toBe(true);
    expect(out.text.includes('"highPriorityPending"')).toBe(true);
  });

  it("core realtime endpoints remain healthy when graph projection is unavailable", async () => {
    const graphDownCoordinator = makeCoordinatorStub();
    graphDownCoordinator.getDiagnostics = () => ({
      ingest: { accepted: 1 },
      projection: { readiness: [] },
      graphProjection: {
        state: { enabled: true, failed: 3, deadLettered: 2 },
      },
    });
    socketMod.getRealtimeCoordinator = () => graphDownCoordinator;

    const suggestions = await req("/api/realtime/suggestions", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });
    const report = await req("/api/realtime/reports/latest", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });
    const diagnostics = await req("/api/realtime/diagnostics", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(suggestions.status).toBe(200);
    expect(report.status).toBe(200);
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.body.diagnostics.graphProjection.state.failed).toBeGreaterThanOrEqual(1);
  });

  it("graph-enriched report field is optional and does not break base report contract", async () => {
    const withGraph = makeCoordinatorStub();
    const baseReport = withGraph.getLatestReport();
    withGraph.getLatestReport = vi.fn(() => ({
      ...baseReport,
      graph: {
        projectedEvents: 12,
        retryCount: 1,
        deadLetterCount: 0,
      },
    }));
    socketMod.getRealtimeCoordinator = () => withGraph;

    const out = await req("/api/realtime/reports/latest", {
      headers: { "x-home-id": "home-1", "x-user-id": "u1" },
    });

    expect(out.status).toBe(200);
    expect(out.body.report.summary).toBeTruthy();
    expect(out.body.report.graph).toBeTruthy();
    expect(typeof out.body.report.graph.projectedEvents).toBe("number");
  });
});
