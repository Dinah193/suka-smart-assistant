import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
  const suggestion = {
    id: "s1",
    scope: "household",
    scopeId: "home-1",
    target: "task.sessions",
    action: "create-restock-task",
    title: "Create restock task",
  };

  return {
    getState: vi.fn(() => ({ signalCount: 1 })),
    ingest: vi.fn(() => ({ signal: { id: "sig-1" }, createdSuggestions: [] })),
    listSuggestions: vi.fn(() => [suggestion]),
    consumeSuggestion: vi.fn(() => ({
      ...suggestion,
      consumedAt: new Date().toISOString(),
      consumedBy: "u1",
    })),
    assignSuggestion: vi.fn(() => ({
      ...suggestion,
      assignedToUserId: "u1",
      assignedRole: "cook",
      assignmentTs: new Date().toISOString(),
    })),
    generateReports: vi.fn(() => undefined),
    getLatestReport: vi.fn(() => ({
      id: "r1",
      scope: "household",
      scopeId: "home-1",
      generatedAt: new Date().toISOString(),
      summary: {
        signals24h: 1,
        pendingSuggestions: 1,
        completedSuggestions: 0,
        highPriorityPending: 0,
        assignedPending: 1,
        unassignedPending: 0,
      },
      signalBreakdown: { inventoryAdded: 1 },
    })),
    getAuditHistory: vi.fn(() => [{ id: "a1", type: "x" }]),
    getSignalHistory: vi.fn(() => [{ id: "sig-1", type: "inventoryAdded" }]),
  };
}

runtimeDescribe("realtimeController runtime contract", () => {
  let app;
  let server;
  let req;
  let socketMod;
  let restoreCoordinator;

  beforeAll(async () => {
    const express = require("express");
    const controller = require("../src/server/routes/realtimeController.js");

    socketMod = require("../src/server/socket.js");
    const coordinator = makeCoordinatorStub();
    const original = socketMod.getRealtimeCoordinator;
    socketMod.getRealtimeCoordinator = () => coordinator;
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
});
