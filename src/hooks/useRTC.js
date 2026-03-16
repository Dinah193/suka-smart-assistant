// src/hooks/useRTC.js
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * useRTC — shared RTC room join, reconnect, and presence state.
 *
 * What this does:
 * - Joins a realtime "room" using your RTC client with a WebSocket fallback.
 * - Maintains connection status, transport in use, and a live peer list (presence).
 * - Sends/receives app-level envelopes { type, ts, source, data }.
 * - Heartbeats presence on an interval; auto-reconnects with backoff when needed.
 * - Emits automation-friendly events on the shared eventBus for observability:
 *     "rtc.room.joining" | "rtc.room.connected" | "rtc.room.disconnected"
 *     "rtc.room.error"   | "rtc.peer.joined"    | "rtc.peer.left"
 *     "rtc.message.sent" | "rtc.message.recv"
 *
 * How it fits the SSA pipeline:
 * - Realtime transport is part of the EXECUTION layer (Play/Remote/Overlay).
 * - It does not mutate household data directly. If future messages do mutate
 *   inventory/storehouse, you can call exportToHubIfEnabled(payload) inside `send()`
 *   *for those specific message types*.
 *
 * API:
 *   const {
 *     status,              // "idle"|"joining"|"connected"|"error"|"closed"
 *     transport,           // "rtc"|"ws"|null
 *     room,                // room code (string|null)
 *     selfId,              // local peer id (if provided by transport)
 *     peers,               // Map<string, PeerPresence>
 *     join,                // (roomCode: string) => Promise<void>
 *     leave,               // () => Promise<void>
 *     send,                // (type: string, data?: any, opts?: {peerId?: string}) => Promise<boolean>
 *     onMessage,           // (fn: (envelope) => void) => () => void
 *     setPresence,         // (partial presence object) => void
 *     lastError,           // Error | null
 *   } = useRTC(options)
 *
 * Options:
 *   {
 *     initialRoom: string|null,
 *     heartbeatMs: number = 15000,
 *     reconnect: boolean = true,
 *     maxBackoffMs: number = 120000, // 2 min
 *     domain: string = "meal",
 *     presence: object = {},         // initial presence payload { role, stationKey, device, ... }
 *     source: string = "hooks.useRTC",
 *   }
 */

// ------------------------ Safe, lazy imports ------------------------
let eventBus = {
  emit: (...a) => console.debug("[useRTC:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let rtcClientFactory = null;
try {
  // Expected interface:
  //   const rtc = rtcClientFactory();
  //   await rtc.join(roomCode) -> { selfId }
  //   rtc.send(type, payload, opts?)
  //   rtc.leave()
  //   rtc.on("message", fn) -> off()
  //   rtc.on("peer.joined", fn(peer)) / rtc.on("peer.left", fn(peerId)) / rtc.on("disconnect", fn(err))
  rtcClientFactory =
    require("@/services/realtime/rtcClient.js")?.default ||
    require("@/services/realtime/rtcClient.js");
} catch {}

let wsFallbackFactory = null;
try {
  // Same interface as rtcClient above
  wsFallbackFactory =
    require("@/services/realtime/wsFallback.js")?.default ||
    require("@/services/realtime/wsFallback.js");
} catch {}

let featureFlags = {};
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter")?.default;
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector")?.default;
} catch {}

// ------------------------ Utils ------------------------
const isoNow = () => new Date().toISOString();

function envelope(type, data, source = "hooks.useRTC") {
  return { type, ts: isoNow(), source, data };
}

function emitBus(type, data) {
  const env = envelope(type, data);
  try {
    eventBus.emit?.(type, env);
  } catch {}
  return env;
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // fail-silent by design
  }
}

function createListenerSet() {
  const set = new Set();
  const add = (fn) => {
    if (typeof fn === "function") set.add(fn);
    return () => set.delete(fn);
  };
  const emit = (msg) =>
    set.forEach((fn) => {
      try {
        fn(msg);
      } catch (e) {
        console.warn("[useRTC] listener err", e);
      }
    });
  const clear = () => set.clear();
  return { add, emit, clear, size: () => set.size };
}

// ------------------------ Hook ------------------------
export default function useRTC({
  initialRoom = null,
  heartbeatMs = 15000,
  reconnect = true,
  maxBackoffMs = 120000,
  domain = "meal",
  presence: initialPresence = {},
  source = "hooks.useRTC",
} = {}) {
  const [status, setStatus] = useState("idle");
  const [transport, setTransport] = useState(null); // "rtc" | "ws" | null
  const [room, setRoom] = useState(initialRoom);
  const [selfId, setSelfId] = useState(null);
  const [lastError, setLastError] = useState(null);
  const peersRef = useRef(new Map()); // peerId -> presence object
  const [peersVersion, setPeersVersion] = useState(0); // trigger rerenders

  // presence state (local)
  const presenceRef = useRef({
    ...initialPresence,
    updatedAt: isoNow(),
  });

  // transport refs
  const clientRef = useRef(null); // current connected client
  const clientTypeRef = useRef(null); // "rtc" | "ws" | null
  const hbTimerRef = useRef(null);
  const retryRef = useRef({ tries: 0, timer: null });
  const visibilityRef = useRef(document?.visibilityState || "visible");

  // message listeners
  const msgListeners = useRef(createListenerSet());

  // ---- helpers to mutate peers map & trigger render ----
  const setPeerPresence = useCallback((peerId, partial) => {
    const cur = peersRef.current.get(peerId) || {};
    const next = { ...cur, ...partial, lastSeen: Date.now() };
    peersRef.current.set(peerId, next);
    setPeersVersion((v) => v + 1);
  }, []);

  const removePeer = useCallback((peerId) => {
    if (peersRef.current.has(peerId)) {
      peersRef.current.delete(peerId);
      setPeersVersion((v) => v + 1);
    }
  }, []);

  const peers = useMemo(() => {
    // return a stable array sorted by recent activity
    const arr = Array.from(peersRef.current.entries()).map(([id, p]) => ({
      id,
      ...p,
    }));
    arr.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return arr;
  }, [peersVersion]);

  // ---- transport setup & teardown ----
  const detachClient = useCallback(() => {
    try {
      clientRef.current?.off?.("*");
    } catch {}
    try {
      clientRef.current?.leave?.();
    } catch {}
    clientRef.current = null;
    clientTypeRef.current = null;
  }, []);

  const attachHandlers = useCallback(
    (client) => {
      // message
      const offMsg = client.on?.("message", (msg) => {
        const env = msg?.type ? msg : envelope("rtc.message", msg, source);
        emitBus("rtc.message.recv", {
          room,
          transport: clientTypeRef.current,
          envelope: env,
          domain,
        });
        msgListeners.current.emit(env);

        // presence updates (convention)
        // support both explicit type and inline presence on envelope
        if (env?.type === "presence.state" && env?.data?.peerId) {
          setPeerPresence(env.data.peerId, env.data.presence || {});
        }
        if (env?.type === "presence.ping" && env?.data?.peerId) {
          setPeerPresence(env.data.peerId, env.data.presence || {});
        }
      });

      // peer joined
      const offJoin = client.on?.("peer.joined", (peer) => {
        const pid = peer?.id || peer?.peerId || String(Math.random());
        setPeerPresence(pid, peer?.presence || {});
        emitBus("rtc.peer.joined", {
          room,
          transport: clientTypeRef.current,
          peerId: pid,
          domain,
        });
      });

      // peer left
      const offLeft = client.on?.("peer.left", (peerId) => {
        removePeer(peerId);
        emitBus("rtc.peer.left", {
          room,
          transport: clientTypeRef.current,
          peerId,
          domain,
        });
      });

      // disconnect
      const offDisc = client.on?.("disconnect", (err) => {
        setStatus("error");
        setLastError(err || new Error("disconnected"));
        emitBus("rtc.room.disconnected", {
          room,
          transport: clientTypeRef.current,
          message: String(err?.message || err),
          domain,
        });
        if (reconnect) scheduleReconnect();
      });

      // Generic off() aggregator
      return () => {
        try {
          offMsg?.();
        } catch {}
        try {
          offJoin?.();
        } catch {}
        try {
          offLeft?.();
        } catch {}
        try {
          offDisc?.();
        } catch {}
      };
    },
    [domain, removePeer, room, setPeerPresence, reconnect, source]
  );

  // ---- join logic with RTC→WS fallback ----
  const join = useCallback(
    async (roomCode) => {
      if (!roomCode || typeof roomCode !== "string") {
        const e = new Error("invalid-room");
        setLastError(e);
        return;
      }

      // reset before joining
      clearHeartbeat();
      clearRetry();
      detachClient();
      setRoom(roomCode);
      setStatus("joining");
      emitBus("rtc.room.joining", { room: roomCode, domain });

      // Try RTC first
      if (rtcClientFactory) {
        try {
          const rtc =
            typeof rtcClientFactory === "function"
              ? rtcClientFactory()
              : rtcClientFactory;
          const joinInfo = await rtc.join(roomCode);
          clientRef.current = rtc;
          clientTypeRef.current = "rtc";
          setTransport("rtc");
          setStatus("connected");
          setSelfId(joinInfo?.selfId || null);
          const off = attachHandlers(rtc);
          clientRef.current._offAll = off;
          emitBus("rtc.room.connected", {
            room: roomCode,
            transport: "rtc",
            domain,
          });
          startHeartbeat();
          return;
        } catch (e) {
          emitBus("rtc.room.error", {
            room: roomCode,
            transportTried: "rtc",
            message: String(e?.message || e),
            domain,
          });
          setLastError(e);
        }
      }

      // Fallback to WS
      if (wsFallbackFactory) {
        try {
          const ws =
            typeof wsFallbackFactory === "function"
              ? wsFallbackFactory()
              : wsFallbackFactory;
          const joinInfo = await ws.join(roomCode);
          clientRef.current = ws;
          clientTypeRef.current = "ws";
          setTransport("ws");
          setStatus("connected");
          setSelfId(joinInfo?.selfId || null);
          const off = attachHandlers(ws);
          clientRef.current._offAll = off;
          emitBus("rtc.room.connected", {
            room: roomCode,
            transport: "ws",
            domain,
          });
          startHeartbeat();
          return;
        } catch (e) {
          emitBus("rtc.room.error", {
            room: roomCode,
            transportTried: "ws",
            message: String(e?.message || e),
            domain,
          });
          setLastError(e);
          setStatus("error");
          if (reconnect) scheduleReconnect();
        }
      } else {
        // Nothing available
        const e = new Error("no-transport");
        setLastError(e);
        setStatus("error");
        emitBus("rtc.room.error", {
          room: roomCode,
          transportTried: "none",
          message: "No RTC/WS transport available",
          domain,
        });
        if (reconnect) scheduleReconnect();
      }
    },
    [attachHandlers, detachClient, domain, reconnect]
  );

  const leave = useCallback(async () => {
    clearHeartbeat();
    clearRetry();
    try {
      clientRef.current?._offAll?.();
    } catch {}
    try {
      clientRef.current?.leave?.();
    } catch {}
    detachClient();
    setStatus("closed");
    setTransport(null);
    setSelfId(null);
    peersRef.current.clear();
    setPeersVersion((v) => v + 1);
    emitBus("rtc.room.disconnected", {
      room,
      transport: null,
      message: "left",
      domain,
    });
  }, [detachClient, domain, room]);

  // ---- heartbeat & presence ----
  const setPresence = useCallback(
    (partial) => {
      presenceRef.current = {
        ...presenceRef.current,
        ...partial,
        updatedAt: isoNow(),
      };
      // push immediately if connected
      try {
        if (clientRef.current && status === "connected") {
          const payload = {
            peerId: selfId || undefined,
            presence: presenceRef.current,
          };
          const env = envelope("presence.ping", payload, source);
          clientRef.current.send?.("presence.ping", env);
          emitBus("rtc.message.sent", {
            room,
            transport: clientTypeRef.current,
            envelope: env,
            domain,
          });
        }
      } catch {}
    },
    [room, source, status, selfId]
  );

  const startHeartbeat = useCallback(() => {
    clearHeartbeat();
    if (!heartbeatMs || heartbeatMs < 1000) return;

    const tick = () => {
      if (document && visibilityRef.current === "hidden") return;
      setPresence({});
    };

    hbTimerRef.current = setInterval(tick, heartbeatMs);
    // immediate first tick
    tick();
  }, [heartbeatMs, setPresence]);

  const clearHeartbeat = useCallback(() => {
    if (hbTimerRef.current) {
      clearInterval(hbTimerRef.current);
      hbTimerRef.current = null;
    }
  }, []);

  // ---- reconnect with backoff ----
  const scheduleReconnect = useCallback(() => {
    clearRetry();
    if (!reconnect || !room) return;

    const tries = (retryRef.current.tries || 0) + 1;
    retryRef.current.tries = tries;
    const delay = Math.min(
      1000 * Math.pow(2, Math.floor(tries / 2)),
      maxBackoffMs
    ); // grow slower
    retryRef.current.timer = setTimeout(() => {
      if (!room) return;
      join(room);
    }, delay);
  }, [join, maxBackoffMs, reconnect, room]);

  const clearRetry = useCallback(() => {
    if (retryRef.current.timer) {
      clearTimeout(retryRef.current.timer);
      retryRef.current.timer = null;
    }
  }, []);

  // ---- send & onMessage ----
  const send = useCallback(
    async (type, data = {}, opts = {}) => {
      if (status !== "connected" || !clientRef.current) return false;
      const env = envelope(type, data, source);
      try {
        await clientRef.current.send?.(type, env, opts);
        emitBus("rtc.message.sent", {
          room,
          transport: clientTypeRef.current,
          envelope: env,
          domain,
        });

        // Example: If certain message types mutate household data, export them:
        // if (type.startsWith("inventory.") || type.startsWith("storehouse.") || type.startsWith("meal.executed")) {
        //   exportToHubIfEnabled({ type, ts: env.ts, domain, data });
        // }

        return true;
      } catch (e) {
        setLastError(e);
        emitBus("rtc.room.error", {
          room,
          transport: clientTypeRef.current,
          message: String(e?.message || e),
          domain,
        });
        return false;
      }
    },
    [domain, room, source, status]
  );

  const onMessage = useCallback((fn) => msgListeners.current.add(fn), []);

  // ---- visibility handling (pause heartbeats on hidden tabs) ----
  useEffect(() => {
    const handler = () => {
      visibilityRef.current = document.visibilityState;
      if (visibilityRef.current === "visible" && status === "connected") {
        // kick a presence immediately when returning
        setPresence({});
      }
    };
    document.addEventListener?.("visibilitychange", handler);
    return () => document.removeEventListener?.("visibilitychange", handler);
  }, [setPresence, status]);

  // ---- auto-join on mount if initialRoom is given ----
  useEffect(() => {
    if (initialRoom) join(initialRoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- cleanup on unmount ----
  useEffect(() => {
    return () => {
      try {
        msgListeners.current.clear();
      } catch {}
      clearHeartbeat();
      clearRetry();
      try {
        clientRef.current?._offAll?.();
      } catch {}
      try {
        clientRef.current?.leave?.();
      } catch {}
    };
  }, [clearHeartbeat, clearRetry]);

  // ---- public API ----
  return useMemo(
    () => ({
      status,
      transport,
      room,
      selfId,
      peers,
      lastError,
      join,
      leave,
      send,
      onMessage,
      setPresence,
    }),
    [
      join,
      lastError,
      leave,
      peers,
      room,
      selfId,
      send,
      setPresence,
      status,
      transport,
    ]
  );
}
