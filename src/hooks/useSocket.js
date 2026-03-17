// C:\Users\larho\suka-smart-assistant\src\hooks\useSocket.js
//
// Reactive Socket.IO hook + channel helpers for Suka Smart Assistant
// - Auto-connects, authenticates, and (optionally) joins the current user's room
// - Robust to tab visibility changes, offline/online, and reconnection
// - QoS: queues emits while disconnected, flushes on connect
// - Ack/request helpers with per-call timeouts
// - Heartbeat ping to keep long-lived tabs healthy
// - Auto re-join user/explicit rooms after reconnect
// - Channel helpers for Cooking, MealPlan, BatchSession, Grocery, and Automation
//
// Install once: npm i socket.io-client
//

import { useEffect, useMemo, useRef, useState, useCallback } from "react";

/* -----------------------------------------------------------------------------
 * Fix strategy:
 *  - Remove ALL static imports of "socket.io-client"
 *  - Dynamically import it at runtime (browser only) inside an effect
 *  - If the module isn't installed, gracefully no-op (no crash, no build fail)
 *
 * Usage:
 *  const { socket, status, error, emit } = useSocket({
 *    url: "https://example.com",
 *    options: { transports: ["websocket"] },
 *    enabled: true,
 *  });
 *
 * status: "idle" | "connecting" | "connected" | "error" | "disabled"
 * -------------------------------------------------------------------------- */

/* -----------------------------------------------------------------------------
   Config helpers (SSR-safe)
----------------------------------------------------------------------------- */
function hasWindow() {
  return typeof window !== "undefined";
}

/** Resolve Socket URL with multiple fallbacks. */
function resolveSocketUrl() {
  if (hasWindow() && window.__SOCKET_URL__) return window.__SOCKET_URL__;
  // Vite-style env
  try {
    // eslint-disable-next-line no-undef
    if (
      typeof import.meta !== "undefined" &&
      import.meta.env?.VITE_SOCKET_URL
    ) {
      // eslint-disable-next-line no-undef
      return import.meta.env.VITE_SOCKET_URL;
    }
  } catch (_) {}
  // CRA-style env
  if (typeof process !== "undefined" && process.env?.REACT_APP_SOCKET_URL) {
    return process.env.REACT_APP_SOCKET_URL;
  }
  // Same-origin default (only if window exists)
  if (hasWindow()) {
    return `${window.location.protocol}//${window.location.host}`;
  }
  // Last resort
  return "http://localhost:3000";
}

/** Token getter (override at runtime if you prefer) */
let externalAuthProvider = null;
/** Register a token provider that returns string or Promise<string> */
export function registerSocketAuthProvider(fn) {
  externalAuthProvider = fn;
}

/* -----------------------------------------------------------------------------
   Internal singleton socket manager (ref-counted)
----------------------------------------------------------------------------- */

const socketSingleton = {
  socket: null,
  refs: 0,
  url: null,
  lastAuth: null,
  joinedRooms: new Set(), // rooms to rejoin across reconnects
  queue: [], // buffered emits when offline [{event, payload, ack}]
  heartbeat: null, // interval id
  ioFactory: null, // resolved `io` function (from dynamic import)
  ioLoadPromise: null, // in-flight loader promise
};

/**
 * IMPORTANT:
 * Vite/Rollup will still try to resolve `import("socket.io-client")` even if it
 * is inside a function. To avoid build-time resolution (and build failure when
 * the dep isn't installed), we must hide the import from the bundler.
 */
async function loadSocketIoClient() {
  // Browser only. In SSR/node builds, we remain disabled/no-op.
  if (!hasWindow()) return null;

  if (socketSingleton.ioFactory) return socketSingleton.ioFactory;
  if (socketSingleton.ioLoadPromise) return socketSingleton.ioLoadPromise;

  socketSingleton.ioLoadPromise = (async () => {
    try {
      const spec = "socket.io-client";

      // Hide import from bundlers: non-literal + Function indirection
      // eslint-disable-next-line no-new-func
      const dynImport = new Function(
        "s",
        "return import(/* @vite-ignore */ s);"
      );

      const mod = await dynImport(spec);

      // support various module shapes
      const ioFn = mod?.io || mod?.default?.io || mod?.default || mod;
      if (typeof ioFn !== "function") return null;

      socketSingleton.ioFactory = ioFn;
      return ioFn;
    } catch (_) {
      // dependency not installed or failed to load => gracefully disable sockets
      return null;
    } finally {
      socketSingleton.ioLoadPromise = null;
    }
  })();

  return socketSingleton.ioLoadPromise;
}

async function buildAuthPayload(userId, extraAuth = {}) {
  let token = null;
  if (typeof externalAuthProvider === "function") {
    try {
      token = await externalAuthProvider();
    } catch (_) {}
  }
  return {
    userId: userId || null,
    token: token || null,
    ...extraAuth,
  };
}

function normalizeNamespace(ns) {
  const raw = String(ns || "/core").trim();
  if (!raw) return "/core";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function createSocket(ioFn, url, auth, namespace = "/core") {
  const ns = normalizeNamespace(namespace);
  return ioFn(`${url}${ns}`, {
    transports: ["websocket"], // prefer ws for reliability
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 600, // base backoff
    reconnectionDelayMax: 6000,
    timeout: 20000,
    auth,
  });
}

function startHeartbeat(s) {
  stopHeartbeat();
  // Ping every 25s; server should respond with pong.
  socketSingleton.heartbeat = setInterval(() => {
    try {
      if (s && s.connected) s.emit("HEARTBEAT:PING", { t: Date.now() });
    } catch (_) {}
  }, 25000);
}
function stopHeartbeat() {
  if (socketSingleton.heartbeat) {
    clearInterval(socketSingleton.heartbeat);
    socketSingleton.heartbeat = null;
  }
}

function flushQueue() {
  const s = socketSingleton.socket;
  if (!s || !s.connected) return;
  const q = socketSingleton.queue;
  socketSingleton.queue = [];
  for (const item of q) {
    try {
      if (item.ack)
        s.timeout(item.timeoutMs || 10000).emit(
          item.event,
          item.payload,
          item.ack
        );
      else s.emit(item.event, item.payload);
    } catch (_) {
      // If emit fails immediately, requeue once at the end
      socketSingleton.queue.push(item);
    }
  }
}

async function ensureConnected({ userId, extraAuth, namespace = "/core" } = {}) {
  // If we are not in a browser, or socket.io-client isn't installed, no-op.
  const ioFn = await loadSocketIoClient();
  if (!ioFn) return null;

  const url = resolveSocketUrl();
  const auth = await buildAuthPayload(userId, extraAuth);

  if (!socketSingleton.socket) {
    socketSingleton.url = url;
    socketSingleton.lastAuth = auth;
    socketSingleton.socket = createSocket(ioFn, url, auth, namespace);
    // Wire core listeners once
    const s = socketSingleton.socket;

    s.on("connect", () => {
      // Re-auth ok by now; start heartbeat, flush, and rejoin rooms
      startHeartbeat(s);
      // Auto rejoin any tracked rooms
      for (const roomId of socketSingleton.joinedRooms) {
        try {
          s.emit("ROOM:JOIN", { roomId });
        } catch (_) {}
      }
      flushQueue();
    });

    s.on("disconnect", () => {
      // Leave heartbeat running? We stop to avoid extra emits while offline
      stopHeartbeat();
    });

    // Optional: if server sends auth-refresh hints
    s.on("AUTH:REFRESH", async () => {
      try {
        const newAuth = await buildAuthPayload(userId, extraAuth);
        s.auth = newAuth;
        socketSingleton.lastAuth = newAuth;
        if (s.connected) {
          try {
            s.disconnect();
          } catch (_) {}
          setTimeout(() => {
            try {
              s.connect();
            } catch (_) {}
          }, 150);
        }
      } catch (_) {}
    });

    // In case server announces a templates or automation change:
    s.on("AUTOMATION:UPDATED", () => {
      // No-op here; UI hooks can subscribe to the event directly.
    });
  } else {
    // Update auth if userId changed or token refreshed
    const prev = socketSingleton.lastAuth || {};
    if (prev.userId !== auth.userId || prev.token !== auth.token) {
      socketSingleton.socket.auth = auth;
      socketSingleton.lastAuth = auth;
      if (socketSingleton.socket.connected) {
        try {
          socketSingleton.socket.disconnect();
        } catch (_) {}
      }
    }
  }

  if (socketSingleton.socket && !socketSingleton.socket.connected) {
    socketSingleton.socket.connect();
  }

  return socketSingleton.socket;
}

function refSocket() {
  socketSingleton.refs += 1;
  return socketSingleton.refs;
}

function unrefSocket() {
  socketSingleton.refs = Math.max(0, socketSingleton.refs - 1);
  if (socketSingleton.refs === 0 && socketSingleton.socket) {
    try {
      socketSingleton.socket.disconnect();
    } catch (_) {}
    stopHeartbeat();
    socketSingleton.socket = null;
    socketSingleton.queue = [];
    socketSingleton.joinedRooms.clear();
  }
  return socketSingleton.refs;
}

/* -----------------------------------------------------------------------------
   React hook: useSocket
----------------------------------------------------------------------------- */

/**
 * useSocket
 * @param {object} options
 * @param {string} options.userId - current user id (used for joining a user room)
 * @param {object} [options.extraAuth] - extra fields for socket.auth
 * @param {boolean} [options.autoJoinUserRoom=true] - join a room named by userId
 * @param {string[]} [options.alsoJoinRooms] - other rooms to auto-join and rejoin
 * @returns {object} socket api
 */
export function useSocket({
  userId,
  extraAuth = {},
  autoJoinUserRoom = true,
  alsoJoinRooms = [],
  namespace = "/core",
} = {}) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const socketRef = useRef(null);

  // Keep latest values in refs for event handlers
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  // Connect on mount, disconnect on unmount; respond to auth/room changes
  useEffect(() => {
    let isMounted = true;
    let unsubVisibility = null;
    let unsubOnline = null;
    let unsubOffline = null;

    (async () => {
      setConnecting(true);
      try {
        const s = await ensureConnected({ userId, extraAuth, namespace });

        // If sockets are unavailable (SSR or socket.io-client missing), stay idle/no-op.
        if (!s) {
          if (!isMounted) return;
          socketRef.current = null;
          setConnected(false);
          setConnecting(false);
          // Keep error null so app doesn't look "broken" if sockets are optional.
          return;
        }

        if (!isMounted) return;

        socketRef.current = s;
        refSocket();

        const onConnect = () => {
          setConnected(true);
          setConnecting(false);
          setError(null);

          if (hasWindow()) {
            window.__SUKA_SOCKET__ = s;
            window.__suka = window.__suka || {};
            window.__suka.socket = s;
          }

          // Track auto-rooms for rejoin
          if (autoJoinUserRoom && userIdRef.current) {
            const userRoom = `user:${userIdRef.current}`;
            socketSingleton.joinedRooms.add(userRoom);
            s.emit("join", userRoom);
            // Legacy fallback for older socket handlers, harmless if ignored.
            s.emit("ROOM:JOIN", { roomId: userRoom });
          }
          (alsoJoinRooms || []).forEach((r) => {
            if (r) {
              socketSingleton.joinedRooms.add(r);
              s.emit("join", r);
              s.emit("ROOM:JOIN", { roomId: r });
            }
          });
          flushQueue();
        };
        const onDisconnect = () => {
          setConnected(false);
        };
        const onError = (e) => setError(e);
        const onConnectError = (e) => {
          setError(e);
          setConnecting(false);
        };

        s.on("connect", onConnect);
        s.on("disconnect", onDisconnect);
        s.on("error", onError);
        s.on("connect_error", onConnectError);

        // Handle tab visibility: when user returns, nudge reconnect
        const handleVisibility = () => {
          if (document.visibilityState === "visible" && s && !s.connected) {
            try {
              s.connect();
            } catch (_) {}
          }
        };
        if (hasWindow()) {
          document.addEventListener("visibilitychange", handleVisibility);
          unsubVisibility = () =>
            document.removeEventListener("visibilitychange", handleVisibility);
        }

        // Handle offline/online
        const goOnline = () => {
          try {
            s.connect();
          } catch (_) {}
        };
        const goOffline = () => {
          try {
            s.disconnect();
          } catch (_) {}
        };
        if (hasWindow()) {
          window.addEventListener("online", goOnline);
          window.addEventListener("offline", goOffline);
          unsubOnline = () => window.removeEventListener("online", goOnline);
          unsubOffline = () => window.removeEventListener("offline", goOffline);
        }

        if (!s.connected) s.connect();
      } catch (e) {
        if (!isMounted) return;
        setError(e);
        setConnecting(false);
      }
    })();

    return () => {
      isMounted = false;
      if (unsubVisibility) unsubVisibility();
      if (unsubOnline) unsubOnline();
      if (unsubOffline) unsubOffline();

      const s = socketRef.current;
      socketRef.current = null;

      if (s) {
        try {
          s.removeAllListeners("connect");
          s.removeAllListeners("disconnect");
          s.removeAllListeners("error");
          s.removeAllListeners("connect_error");
        } catch (_) {}
      }
      unrefSocket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    userId,
    JSON.stringify(extraAuth),
    autoJoinUserRoom,
    JSON.stringify(alsoJoinRooms),
    namespace,
  ]);

  /** Join a room (server should handle ROOM:JOIN) */
  const joinRoom = useCallback((roomId) => {
    const s = socketRef.current;
    if (!roomId) return;
    socketSingleton.joinedRooms.add(roomId);
    if (s && s.connected) {
      s.emit("join", roomId);
      s.emit("ROOM:JOIN", { roomId });
    }
    else {
      // ensure it joins on next connect
    }
  }, []);

  /** Leave a room */
  const leaveRoom = useCallback((roomId) => {
    const s = socketRef.current;
    socketSingleton.joinedRooms.delete(roomId);
    if (s && s.connected) {
      s.emit("leave", roomId);
      s.emit("ROOM:LEAVE", { roomId });
    }
  }, []);

  /** Core emit with buffering if offline */
  const emit = useCallback((event, payload) => {
    const s = socketRef.current;
    if (s && s.connected) return s.emit(event, payload);
    // buffer for later
    socketSingleton.queue.push({ event, payload });
  }, []);

  /**
   * Emit with ack & timeout.
   * Usage: await emitAck("MEALPLAN:SET", data, { timeoutMs: 12000 })
   */
  const emitAck = useCallback((event, payload, { timeoutMs = 10000 } = {}) => {
    const s = socketRef.current;
    return new Promise((resolve, reject) => {
      if (!s || !s.connected) {
        reject(new Error(`socket not connected for ack event: ${event}`));
        return;
      }

      let settled = false;
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      const timer = setTimeout(() => {
        finishReject(new Error(`emitAck timeout for ${event}`));
      }, timeoutMs + 200);

      const ack = (...args) => {
        if (args.length > 1) {
          const [err, res] = args;
          if (err) {
            finishReject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          finishResolve(res);
          return;
        }
        finishResolve(args[0]);
      };

      try {
        s.timeout(timeoutMs).emit(event, payload, ack);
      } catch (e) {
        finishReject(e);
      }
    });
  }, []);

  /**
   * Request/response pattern: listens for a single reply event.
   * request("ANNO:RUN", payload, "ANNO:DONE")
   */
  const request = useCallback(
    (event, payload, replyEvent, { timeoutMs = 12000 } = {}) => {
      const s = socketRef.current;
      return new Promise((resolve, reject) => {
        if (!replyEvent) return reject(new Error("replyEvent required"));
        const handler = (data) => {
          cleanup();
          resolve(data);
        };
        const cleanup = () => {
          try {
            s?.off(replyEvent, handler);
          } catch (_) {}
          clearTimeout(timer);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`request timeout for ${event}/${replyEvent}`));
        }, timeoutMs);
        try {
          s?.on(replyEvent, handler);
        } catch (_) {}
        emit(event, payload);
      });
    },
    [emit]
  );

  /** Subscribe with auto-cleanup */
  const subscribe = useCallback((event, handler) => {
    const s = socketRef.current;
    if (!s || !handler) return () => {};
    s.on(event, handler);
    return () => {
      try {
        s.off(event, handler);
      } catch (_) {}
    };
  }, []);

  /** Subscribe once */
  const subscribeOnce = useCallback((event, handler) => {
    const s = socketRef.current;
    if (!s || !handler) return () => {};
    const once = (data) => {
      try {
        s.off(event, once);
      } catch (_) {}
      handler(data);
    };
    s.on(event, once);
    return () => {
      try {
        s.off(event, once);
      } catch (_) {}
    };
  }, []);

  /** Await connection */
  const whenConnected = useCallback(() => {
    const s = socketRef.current;
    if (s?.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const on = () => {
        try {
          s?.off("connect", on);
        } catch (_) {}
        resolve(true);
      };
      try {
        s?.on("connect", on);
      } catch (_) {
        resolve(false);
      }
    });
  }, []);

  return useMemo(
    () => ({
      socket: socketRef.current,
      connected,
      connecting,
      error,
      joinRoom,
      leaveRoom,
      emit,
      emitAck,
      request,
      subscribe,
      subscribeOnce,
      whenConnected,
    }),
    [
      connected,
      connecting,
      error,
      joinRoom,
      leaveRoom,
      emit,
      emitAck,
      request,
      subscribe,
      subscribeOnce,
      whenConnected,
    ]
  );
}

/* -----------------------------------------------------------------------------
   Channel helpers — minimal boilerplate for common Suka events
----------------------------------------------------------------------------- */

/**
 * Cooking channel:
 * Events (server-emitted):
 *  - COOKING:STEP_STARTED { sessionId, stepId, stepName, expectedDurationSec }
 *  - COOKING:STEP_REMINDER { sessionId, stepId, note }
 *  - COOKING:SESSION_ENDED { sessionId, summary }
 */
export function useCookingChannel({
  userId,
  onStepStarted,
  onStepReminder,
  onSessionEnded,
} = {}) {
  const sock = useSocket({ userId, namespace: "/meals" });

  useEffect(() => {
    const unsubs = [];
    if (onStepStarted)
      unsubs.push(sock.subscribe("COOKING:STEP_STARTED", onStepStarted));
    if (onStepReminder)
      unsubs.push(sock.subscribe("COOKING:STEP_REMINDER", onStepReminder));
    if (onSessionEnded)
      unsubs.push(sock.subscribe("COOKING:SESSION_ENDED", onSessionEnded));
    return () => unsubs.forEach((u) => u && u());
  }, [sock, onStepStarted, onStepReminder, onSessionEnded]);

  return sock;
}

/**
 * Meal plan channel:
 * Events (server-emitted):
 *  - MEALPLAN:UPDATED { slots, weekStart }
 *  - MEALPLAN:NOTICE  { message }
 */
export function useMealPlanChannel({ userId, onPlanUpdated, onNotice } = {}) {
  const sock = useSocket({ userId, namespace: "/meals" });
  useEffect(() => {
    const unsubs = [];
    if (onPlanUpdated)
      unsubs.push(sock.subscribe("MEALPLAN:UPDATED", onPlanUpdated));
    if (onNotice) unsubs.push(sock.subscribe("MEALPLAN:NOTICE", onNotice));
    return () => unsubs.forEach((u) => u && u());
  }, [sock, onPlanUpdated, onNotice]);
  return sock;
}

/**
 * Batch session channel (BatchCooking suite):
 *  - BATCH:SESSION_CREATED { sessionId, recipes, startISO }
 *  - BATCH:TASKS_ASSIGNED  { sessionId, tasks }
 *  - BATCH:LABELS_READY    { sessionId, labelsPdfUrl }
 */
export function useBatchSessionChannel({
  userId,
  onCreated,
  onTasks,
  onLabels,
} = {}) {
  const sock = useSocket({ userId, namespace: "/meals" });
  useEffect(() => {
    const unsubs = [];
    if (onCreated)
      unsubs.push(sock.subscribe("BATCH:SESSION_CREATED", onCreated));
    if (onTasks) unsubs.push(sock.subscribe("BATCH:TASKS_ASSIGNED", onTasks));
    if (onLabels) unsubs.push(sock.subscribe("BATCH:LABELS_READY", onLabels));
    return () => unsubs.forEach((u) => u && u());
  }, [sock, onCreated, onTasks, onLabels]);
  return sock;
}

/**
 * Grocery channel:
 *  - GROCERY:LIST_UPDATED { listId, items }
 *  - GROCERY:SYNC_NOTICE  { message }
 */
export function useGroceryChannel({ userId, onUpdated, onNotice } = {}) {
  const sock = useSocket({ userId, namespace: "/core" });
  useEffect(() => {
    const unsubs = [];
    if (onUpdated)
      unsubs.push(sock.subscribe("GROCERY:LIST_UPDATED", onUpdated));
    if (onNotice) unsubs.push(sock.subscribe("GROCERY:SYNC_NOTICE", onNotice));
    return () => unsubs.forEach((u) => u && u());
  }, [sock, onUpdated, onNotice]);
  return sock;
}

/**
 * Automation channel:
 *  - AUTOMATION:UPDATED { version, what }
 *  - TEMPLATES:UPDATED  { count }
 */
export function useAutomationChannel({
  userId,
  onAutomation,
  onTemplates,
} = {}) {
  const sock = useSocket({ userId, namespace: "/automations" });
  useEffect(() => {
    const unsubs = [];
    if (onAutomation)
      unsubs.push(sock.subscribe("AUTOMATION:UPDATED", onAutomation));
    if (onTemplates)
      unsubs.push(sock.subscribe("TEMPLATES:UPDATED", onTemplates));
    return () => unsubs.forEach((u) => u && u());
  }, [sock, onAutomation, onTemplates]);
  return sock;
}

/* -----------------------------------------------------------------------------
   Optional: simple toast bridge
----------------------------------------------------------------------------- */
export function useToastBridge({ userId, showToast } = {}) {
  const sock = useSocket({ userId, namespace: "/core" });
  useEffect(() => {
    if (!showToast) return;
    const un1 = sock.subscribe("NOTICE", (msg) =>
      showToast(msg?.message || "Notice")
    );
    const un2 = sock.subscribe("ERROR", (msg) =>
      showToast(msg?.message || "Error")
    );
    return () => {
      un1 && un1();
      un2 && un2();
    };
  }, [sock, showToast]);
  return sock;
}
