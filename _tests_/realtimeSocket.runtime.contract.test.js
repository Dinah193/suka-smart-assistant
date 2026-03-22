import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import express from "express";
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
const socketRuntimeFlag = String(process.env.SSA_ENABLE_SOCKET_RUNTIME_CONTRACT_TESTS || "").toLowerCase();
const socketRuntimeEnabled =
  socketRuntimeFlag === "1" || socketRuntimeFlag === "true" || socketRuntimeFlag === "yes";
const depsReady = hasModule("socket.io") && hasModule("socket.io-client");
const canRun = runtimeEnabled && socketRuntimeEnabled && depsReady;
const runtimeDescribe = canRun ? describe : describe.skip;

runtimeDescribe("realtime socket runtime contract", () => {
  let server;
  let client;
  let ioClient;

  beforeAll(async () => {
    ioClient = require("socket.io-client").io;
    const { createSocketServer } = require("../src/server/socket.js");

    const app = express();
    const httpServer = http.createServer(app);
    createSocketServer(httpServer);

    server = await new Promise((resolve) => {
      const s = httpServer.listen(0, () => resolve(s));
    });

    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    client = ioClient(`${baseUrl}/core`, {
      path: "/socket.io",
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: {
        token: "dev",
        userId: "u1",
        homeId: "home-1",
      },
    });

    await new Promise((resolve, reject) => {
      client.once("connect", () => {
        resolve();
      });
      client.once("connect_error", (err) => {
        reject(err || new Error("socket_connect_error"));
      });
    });
  });

  afterAll(async () => {
    try {
      client?.disconnect();
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
  });

  function emitAck(event, payload) {
    return new Promise((resolve, reject) => {
      try {
        client.timeout(4000).emit(event, payload, (err, res) => {
          if (err) return reject(err);
          resolve(res);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  it("returns ack contracts for invalid, valid, and duplicate signal:emit", async () => {
    const invalid = await emitAck("signal:emit", {});
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toBe("invalid_event");

    const first = await emitAck("signal:emit", {
      eventId: "evt-socket-1",
      correlationId: "corr-socket-1",
      type: "inventoryAdded",
      event: "inventory:delta",
      sourceModule: "tests.socket",
      payload: { sku: "beans", qty: 2 },
    });

    expect(first.ok).toBe(true);
    expect(first.signal?.id).toBeTruthy();

    const duplicate = await emitAck("signal:emit", {
      eventId: "evt-socket-1",
      correlationId: "corr-socket-2",
      type: "inventoryAdded",
      event: "inventory:delta",
      sourceModule: "tests.socket",
      payload: { sku: "beans", qty: 2 },
    });

    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toBe("duplicate_event");
  });

  it("returns connect_error unauthorized for invalid auth token", async () => {
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const badClient = ioClient(`${baseUrl}/core`, {
      path: "/socket.io",
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: {
        token: "invalid-token",
        userId: "u-bad",
        homeId: "home-1",
      },
    });

    const err = await new Promise((resolve, reject) => {
      badClient.once("connect", () => {
        reject(new Error("unexpected_socket_connect"));
      });

      badClient.once("connect_error", (e) => {
        resolve(e);
      });
    });

    expect(String(err?.message || "")).toMatch(/unauthorized|auth_error/i);
    try {
      badClient.disconnect();
    } catch {
      // ignore
    }
  });

  it("returns invalid_room and forbidden_room contracts for join", async () => {
    const invalid = await emitAck("join", "");
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toBe("invalid_room");

    const forbidden = await emitAck("join", "suggestions:family:family-foreign");
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error).toBe("forbidden_room");
  });
});
