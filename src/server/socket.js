// C:\Users\larho\suka-smart-assistant\src\server\socket.js
/**
 * Suka Smart Assistant — Socket Layer (Dynamic, CJS+ESM friendly)
 *
 * Exports:
 *   - createSocketServer(httpServer) -> io
 *   - getIO() -> io (after created)
 *   - EventBus (Node EventEmitter)
 *   - emitToUser(userId, event, payload)
 *   - emitToRoom(room, event, payload)
 *   - emitGlobal(event, payload)
 *   - namespaceEmit(ns, event, payload, room?)
 */

const { Server } = require("socket.io");
const { EventEmitter } = require("events");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

// ---- Hybrid loader (CJS + ESM) ----------------------------------------------
async function loadAny(modulePath) {
  try {
    const mod = require(modulePath);
    return mod && mod.__esModule ? (mod.default || mod) : mod;
  } catch (e1) {
    try {
      const full = path.isAbsolute(modulePath) ? modulePath : path.resolve(__dirname, modulePath);
      const url = `file://${full.replace(/\\/g, "/")}`;
      const mod = await import(url);
      return mod && (mod.default || mod);
    } catch {
      throw e1;
    }
  }
}

// ---- Prefs (optional) --------------------------------------------------------
let preferences = null;
(async () => {
  try {
    preferences = await loadAny("./services/preferencesService.js");
  } catch {
    // no-op in dev
  }
})();

let io = null;
let realtimeCoordinator = null;

// ---- Config -----------------------------------------------------------------
const SOCKET_PATH = process.env.SOCKET_PATH || "/socket.io";
const SOCKET_CORS = (process.env.SOCKET_CORS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AUTH_REQUIRED = process.env.SOCKET_AUTH_REQUIRED === "false" ? false : true;

const TOKEN_BUCKET = {
  refillPerSec: Number(process.env.SOCKET_RATE_REFILL || 6),
  capacity: Number(process.env.SOCKET_RATE_CAP || 20),
  costPerEvent: 1,
};

const NAMESPACES = ["/core", "/meals", "/cleaning", "/garden", "/inventory", "/automations"];

// Small in-memory replay buffers per namespace (for “late join” UX)
const REPLAY_SIZE = Number(process.env.SOCKET_REPLAY_SIZE || 20);
const replayBuffers = new Map(); // ns -> [{event, payload, ts}]

// ---- Central bus to bridge internal services with sockets -------------------
const EventBus = new EventEmitter();

// ---- Auth verifier (optional) -----------------------------------------------
/**
 * Expected return:
 *   { ok: true, userId, homeId?, familyId?, roles?: [] }
 */
async function verifySocketAuth(token, extra = {}) {
  try {
    const auth = await loadAny("./services/authService.js");
    if (auth?.verifySocketToken) {
      return await auth.verifySocketToken(token, extra);
    }
  } catch {
    // no auth service installed
  }
  if (!AUTH_REQUIRED || token === "dev") {
    return { ok: true, userId: extra?.userId || "guest", homeId: extra?.homeId || "default" };
  }
  return { ok: false, error: "Unauthorized" };
}

// ---- Rate limiter (per-socket token bucket) ---------------------------------
function attachRateLimiter(socket) {
  const state = { tokens: TOKEN_BUCKET.capacity, lastRefill: Date.now() };
  socket._rl = state;
  socket.use((packet, next) => {
    const now = Date.now();
    const elapsed = (now - state.lastRefill) / 1000;
    state.lastRefill = now;
    state.tokens = Math.min(TOKEN_BUCKET.capacity, state.tokens + elapsed * TOKEN_BUCKET.refillPerSec);
    if (state.tokens < TOKEN_BUCKET.costPerEvent) return next(new Error("rate_limited"));
    state.tokens -= TOKEN_BUCKET.costPerEvent;
    next();
  });
}

// ---- Ack helper with timeout (prevents dangling RPCs) -----------------------
function withAckTimeout(socket, ms = 7000) {
  return (event, payload) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("ack_timeout"));
        }
      }, ms);
      try {
        socket.emit(event, payload, (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(res);
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      }
    });
}

// ---- Replay buffer helpers ---------------------------------------------------
function pushReplay(ns, event, payload) {
  const buf = replayBuffers.get(ns) || [];
  buf.push({ event, payload, ts: Date.now() });
  while (buf.length > REPLAY_SIZE) buf.shift();
  replayBuffers.set(ns, buf);
}
function emitReplay(ns, socket) {
  const buf = replayBuffers.get(ns) || [];
  for (const item of buf) socket.emit(item.event, item.payload);
}

// ---- Namespace / connection wiring ------------------------------------------
const ALLOW_EVENTS_FROM_CLIENT = new Map([
  [
    "/core",
    new Set([
      "preferences:update",
      "notify",
      "client:ready",
      "presence:hello",
      "signal:emit",
      "suggestion:list",
      "suggestion:consume",
      "suggestion:assign",
      "report:request",
    ]),
  ],
  [
    "/inventory",
    new Set(["inventory:delta", "inventory:transfer", "inventory:scan"]),
  ],
  ["/meals", new Set(["mealplan:generated", "mealplan:update", "batch:status"])],
  ["/garden", new Set(["garden:harvest", "garden:alert", "irrigation:adjust"])],
  ["/automations", new Set(["automation:execution", "n8n:ping"])],
  ["/cleaning", new Set(["cleaning:task:update"])],
]);

function buildNamespace(ns) {
  const n = io.of(ns);

  function resolveAuthorizedScopeFromSocket(socket, requestedScope) {
    const scope = requestedScope === "family" ? "family" : "household";
    const scopeId = scope === "family" ? socket.user?.familyId : socket.user?.homeId;
    if (!scopeId) {
      const code = scope === "family" ? "family_scope_forbidden" : "household_scope_missing";
      throw new Error(code);
    }
    return { scope, scopeId };
  }

  function canJoinRoom(socket, room) {
    const user = socket?.user || {};
    if (typeof room !== "string" || !room) return false;

    if (room.startsWith("user:")) return room === `user:${user.id}`;
    if (room.startsWith("home:")) return room === `home:${user.homeId}`;
    if (room.startsWith("family:")) {
      return !!user.familyId && room === `family:${user.familyId}`;
    }

    // Scoped realtime channels (queue + report)
    if (room.startsWith("suggestions:household:")) {
      return room === `suggestions:household:${user.homeId}`;
    }
    if (room.startsWith("suggestions:family:")) {
      return !!user.familyId && room === `suggestions:family:${user.familyId}`;
    }
    if (room.startsWith("reports:household:")) {
      return room === `reports:household:${user.homeId}`;
    }
    if (room.startsWith("reports:family:")) {
      return !!user.familyId && room === `reports:family:${user.familyId}`;
    }

    // Keep backward compatibility for existing ad-hoc rooms.
    return true;
  }

  // Auth handshake
  n.use(async (socket, next) => {
    try {
      const a = socket.handshake.auth || {};
      const hdrToken =
        socket.handshake.headers["x-auth-token"] ||
        socket.handshake.headers["authorization"]?.replace(/^Bearer\s+/i, "");
      const token = a.token || hdrToken || null;

      const verify = await verifySocketAuth(token, {
        userId: a.userId,
        homeId: a.homeId || a.householdId,
        familyId: a.familyId,
      });

      if (!verify.ok) return next(new Error("unauthorized"));
      socket.user = {
        id: verify.userId,
        homeId: verify.homeId || a.homeId || a.householdId || "default",
        familyId: verify.familyId || a.familyId || null,
        roles: verify.roles || [],
      };
      next();
    } catch {
      next(new Error("auth_error"));
    }
  });

  n.on("connection", (socket) => {
    attachRateLimiter(socket);
    const conId = uuidv4();
    const ack = withAckTimeout(socket);

    // Rooms: user, home, family
    if (socket.user?.id) socket.join(`user:${socket.user.id}`);
    if (socket.user?.homeId) socket.join(`home:${socket.user.homeId}`);
    if (socket.user?.familyId) socket.join(`family:${socket.user.familyId}`);

    // Presence
    const presence = {
      id: conId,
      ns,
      user: socket.user,
      ts: Date.now(),
    };
    n.emit("user:joined", presence);
    pushReplay(ns, "user:joined", presence);

    // Initial connect + optional replay
    socket.emit("connected", presence);
    emitReplay(ns, socket);

    // Health & ping/pong
    socket.on("ping", (payload, cb) => {
      const data = { pong: true, t: Date.now(), payload: payload || null };
      if (typeof cb === "function") return cb(data);
      socket.emit("pong", data);
    });

    socket.on("health", async (cb) => {
      const data = { ok: true, ts: Date.now(), id: socket.id, user: socket.user || null, ns };
      if (typeof cb === "function") cb(data);
      else socket.emit("health", data);
    });

    // Client declares ready -> server may push initial state
    socket.on("client:ready", async (payload, cb) => {
      // future: push initial preferences snapshot, low-stock notices, etc.
      if (typeof cb === "function") cb({ ok: true, replayed: (replayBuffers.get(ns) || []).length });
    });

    // Room management
    socket.on("join", (room, cb) => {
      try {
        if (typeof room !== "string" || !room) throw new Error("invalid_room");
        if (!canJoinRoom(socket, room)) throw new Error("forbidden_room");
        socket.join(room);
        cb && cb({ ok: true, room });
      } catch (e) {
        cb && cb({ ok: false, error: String(e.message || e) });
      }
    });
    socket.on("leave", (room, cb) => {
      try {
        if (typeof room !== "string" || !room) throw new Error("invalid_room");
        socket.leave(room);
        cb && cb({ ok: true, room });
      } catch (e) {
        cb && cb({ ok: false, error: String(e.message || e) });
      }
    });

    // Typed allowlist for client -> server events
    socket.onAny((event, payload) => {
      const allow = ALLOW_EVENTS_FROM_CLIENT.get(ns);
      if (!allow || !allow.has(event)) return;
      EventBus.emit("client:event", {
        ns,
        event,
        payload,
        user: socket.user,
        socketId: socket.id,
        ts: Date.now(),
      });
    });

    // Simple notify helper (echo + user room)
    socket.on("notify", async (msg, cb) => {
      try {
        const safe = {
          id: uuidv4(),
          ts: Date.now(),
          from: { userId: socket.user?.id || null, ns },
          type: String(msg?.type || "info"),
          title: String(msg?.title || ""),
          body: String(msg?.body || ""),
          meta: msg?.meta || {},
        };
        socket.emit("notify", safe);
        if (socket.user?.id) n.to(`user:${socket.user.id}`).emit("notify", safe);
        pushReplay(ns, "notify", safe);
        cb && cb({ ok: true, id: safe.id });
      } catch (e) {
        cb && cb({ ok: false, error: String(e.message || e) });
      }
    });

    // Realtime signal aggregator APIs
    socket.on("signal:emit", (payload, cb) => {
      try {
        EventBus.emit("realtime:signal:ingest", {
          payload,
          context: {
            ns,
            user: socket.user,
            socketId: socket.id,
            sourceModule: ns,
          },
        });
        cb && cb({ ok: true });
      } catch (e) {
        cb && cb({ ok: false, error: String(e.message || e) });
      }
    });

    socket.on("suggestion:list", (query = {}, cb) => {
      try {
        if (!realtimeCoordinator) throw new Error("realtime_not_ready");
        const { scope, scopeId } = resolveAuthorizedScopeFromSocket(socket, query?.scope);
        const items = realtimeCoordinator.listSuggestions({
          scope,
          scopeId,
          includeConsumed: !!query?.includeConsumed,
          target: query?.target,
          domain: query?.domain,
          assignedToUserId: query?.assignedToUserId,
        });
        cb && cb({ ok: true, scope, scopeId, items, suggestions: items });
      } catch (e) {
        cb && cb({ ok: false, error: String(e.message || e) });
      }
    });

    socket.on("suggestion:consume", (payload = {}, cb) => {
      try {
        if (!realtimeCoordinator) throw new Error("realtime_not_ready");
        const { scope, scopeId } = resolveAuthorizedScopeFromSocket(socket, payload?.scope);
        const item = realtimeCoordinator.consumeSuggestion({
          scope,
          scopeId,
          suggestionId: payload?.suggestionId,
          userId: socket.user?.id,
        });
        cb && cb({ ok: !!item, item, suggestion: item });
      } catch (e) {
        cb && cb({ ok: false, error: String(e.message || e) });
      }
    });

    socket.on("suggestion:assign", (payload = {}, cb) => {
      try {
        if (!realtimeCoordinator) throw new Error("realtime_not_ready");
        const { scope, scopeId } = resolveAuthorizedScopeFromSocket(socket, payload?.scope);
        const item = realtimeCoordinator.assignSuggestion({
          scope,
          scopeId,
          suggestionId: payload?.suggestionId,
          assignedToUserId: payload?.assignedToUserId,
          assignedRole: payload?.assignedRole,
          assignedBy: socket.user?.id,
        });
        cb && cb({ ok: !!item, item, suggestion: item });
      } catch (e) {
        cb && cb({ ok: false, error: String(e.message || e) });
      }
    });

    socket.on("report:request", (payload = {}, cb) => {
      try {
        if (!realtimeCoordinator) throw new Error("realtime_not_ready");
        const { scope, scopeId } = resolveAuthorizedScopeFromSocket(socket, payload?.scope);
        if (payload?.forceGenerate) {
          realtimeCoordinator.generateReports();
        }
        const report = realtimeCoordinator.getLatestReport({ scope, scopeId });
        cb && cb({ ok: true, report, scope, scopeId });
      } catch (e) {
        cb && cb({ ok: false, error: String(e.message || e) });
      }
    });

    socket.on("disconnect", (reason) => {
      const payload = { ns, user: socket.user, reason, ts: Date.now() };
      n.emit("user:left", payload);
      pushReplay(ns, "user:left", payload);
    });

    // Attach ack helper for server RPCs (optional usage by other modules)
    socket._ack = ack;
  });

  return n;
}

// ---- Bridges: Preferences / Inventory / Labels / Automations -----------------
function wirePreferencesBridge() {
  if (!preferences?.onChange) return;
  preferences.onChange(({ userId, patch, path, reset }) => {
    const payload = { type: "preferences:update", userId, patch: patch || null, path: path || null, reset: reset || null, ts: Date.now() };
    if (io) {
      const core = io.of("/core");
      core.to(`user:${userId}`).emit("preferences:update", payload);
      core.emit("preferences:activity", payload);
      pushReplay("/core", "preferences:activity", payload);
    }
    EventBus.emit("server:event", { ns: "/core", event: "preferences:update", payload });
  });
}

// Public bridges for other services to emit through EventBus
// Example usage from services:
//   EventBus.emit('bridge:emit', { ns:'/inventory', event:'inventory:delta', payload, room:`user:${userId}` })
EventBus.on("bridge:emit", ({ ns = "/core", event, payload, room }) => {
  namespaceEmit(ns, event, payload, room);
  pushReplay(ns, event, payload);
});

// Sugar wrappers for common domains (optional)
function bridgeInventory(delta, { userId, homeId } = {}) {
  const room = userId ? `user:${userId}` : homeId ? `home:${homeId}` : null;
  EventBus.emit("bridge:emit", { ns: "/inventory", event: "inventory:delta", payload: delta, room });
}
function bridgeLabels(info, { userId } = {}) {
  const room = userId ? `user:${userId}` : null;
  EventBus.emit("bridge:emit", { ns: "/core", event: "labels:ready", payload: info, room });
}
function bridgeAutomation(evt, { userId } = {}) {
  const room = userId ? `user:${userId}` : null;
  EventBus.emit("bridge:emit", { ns: "/automations", event: "automation:execution", payload: evt, room });
}

// ---- Public helper emitters --------------------------------------------------
function getIO() {
  if (!io) throw new Error("socket.io has not been initialized. Call createSocketServer() first.");
  return io;
}
function emitToUser(userId, event, payload) {
  if (!io) return;
  NAMESPACES.forEach((ns) => io.of(ns).to(`user:${userId}`).emit(event, payload));
  NAMESPACES.forEach((ns) => pushReplay(ns, event, payload));
}
function emitToRoom(room, event, payload) {
  if (!io) return;
  NAMESPACES.forEach((ns) => io.of(ns).to(room).emit(event, payload));
  NAMESPACES.forEach((ns) => pushReplay(ns, event, payload));
}
function emitGlobal(event, payload) {
  if (!io) return;
  NAMESPACES.forEach((ns) => io.of(ns).emit(event, payload));
  NAMESPACES.forEach((ns) => pushReplay(ns, event, payload));
}
function namespaceEmit(ns, event, payload, room = null) {
  if (!io) return;
  const n = io.of(ns);
  if (room) n.to(room).emit(event, payload);
  else n.emit(event, payload);
  pushReplay(ns, event, payload);
}

function getRealtimeCoordinator() {
  return realtimeCoordinator;
}

// ---- Create server -----------------------------------------------------------
function createSocketServer(httpServer) {
  if (io) return io; // singleton

  io = new Server(httpServer, {
    path: SOCKET_PATH,
    serveClient: false,
    cors: {
      origin: SOCKET_CORS.length ? SOCKET_CORS : "*",
      methods: ["GET", "POST"],
      allowedHeaders: ["x-auth-token", "authorization", "content-type"],
      credentials: true,
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    },
  });

  // Build namespaces
  NAMESPACES.forEach(buildNamespace);

  // Health convenience on /core
  io.of("/core").on("connection", (socket) => {
    socket.on("health", (cb) => {
      const data = { ok: true, ts: Date.now(), id: socket.id, user: socket.user || null };
      if (typeof cb === "function") cb(data);
      else socket.emit("health", data);
    });
  });

  // Bridges
  wirePreferencesBridge();

  try {
    const { createCoordinator } = require("./services/realtimeCoordinator.js");
    realtimeCoordinator = createCoordinator({ eventBus: EventBus, namespaceEmit });
    realtimeCoordinator.start();
  } catch (e) {
    // Keep socket server alive even if realtime coordinator fails to boot.
    // eslint-disable-next-line no-console
    console.warn("[socket] realtime coordinator skipped:", e?.message || e);
  }

  return io;
}

// ---- Exports -----------------------------------------------------------------
module.exports = {
  createSocketServer,
  getIO,
  EventBus,
  emitToUser,
  emitToRoom,
  emitGlobal,
  namespaceEmit,
  getRealtimeCoordinator,

  // optional direct bridges for services
  bridgeInventory,
  bridgeLabels,
  bridgeAutomation,
};
