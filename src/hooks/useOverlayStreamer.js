// src/hooks/useOverlayStreamer.js
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * useOverlayStreamer — push overlay snapshots to:
 *   1) BroadcastChannel (same-device overlay window / OBS Browser Source)
 *   2) Room transport when `room` is present (RTC with WS fallback)
 *
 * How it fits SSA’s pipeline:
 * - This is an execution-layer utility for live session presentation (no domain
 *   mutation). It emits automation-friendly envelopes to the shared eventBus so
 *   the runtime can observe user intent and media state.
 * - If in the future overlay data needs to be aggregated to the Hub, the
 *   optional `exportToHubIfEnabled` helper is already included (currently not
 *   used since overlays do not mutate household data).
 *
 * Contract:
 *   const {
 *     connected,                        // "none" | "local" | "room:joining" | "room:connected" | "room:error"
 *     pushSnapshot,                     // (rawDraftLike, opts?) => void
 *     setRoom,                          // (roomCode | null) => void
 *     setStreamerSafe,                  // (boolean) => void
 *     streamerSafe,                     // current boolean
 *     setStationFilter,                 // (key | "all") => void
 *   } = useOverlayStreamer({
 *     channel = "sv-cooking-stream",    // BroadcastChannel name
 *     room = null,                      // optional room code to join
 *     kind = "overlay:update",          // message kind tag
 *     title = "Cooking Session",        // default title for overlays
 *     initialStreamerSafe = true,       // hide private fields when true
 *     initialStationFilter = "all",     // "all" or station key
 *     domain = "meal",                  // for eventBus routing and analytics
 *   })
 */

// ------------------------ Safe, lazy imports ------------------------
let eventBus = { emit: (...a) => console.debug("[useOverlayStreamer:eventBus.emit]", ...a), on: () => () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let rtcClientFactory = null;
try {
  // Expected API:
  //   const rtc = rtcClientFactory();
  //   await rtc.join(roomCode);
  //   rtc.send(type, payload)
  //   rtc.leave()
  rtcClientFactory = require("@/services/realtime/rtcClient.js")?.default
                  || require("@/services/realtime/rtcClient.js");
} catch {}

let wsFallbackFactory = null;
try {
  // Expected API mirrors rtcClient: join(room), send(type, payload), leave()
  wsFallbackFactory = require("@/services/realtime/wsFallback.js")?.default
                   || require("@/services/realtime/wsFallback.js");
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

// ------------------------ Utilities ------------------------
const isoNow = () => new Date().toISOString();

function emit(type, data) {
  const payload = { type, ts: isoNow(), source: "hooks.useOverlayStreamer", data };
  try {
    eventBus.emit?.(type, payload);
  } catch {}
  return payload;
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // silent by design
  }
}

// Remove private/pantry/inventory fields, notes, recipe URLs, etc.
function sanitizeForStream(draftOrSnapshot) {
  if (!draftOrSnapshot) return draftOrSnapshot;
  try {
    const d = draftOrSnapshot;
    const copy = {
      kind: d.kind ?? "overlay:update",
      at: d.at ?? Date.now(),
      title: d.title ?? "Session",
      stationFilter: d.stationFilter ?? "all",
      streamerSafe: true,
      metrics: d.metrics ?? {},
      stations: Array.isArray(d.stations)
        ? d.stations.map((s) => ({ key: s.key, label: s.label }))
        : [],
      steps: Array.isArray(d.steps)
        ? d.steps.map((s) => ({
            id: s.id,
            label: s.label,
            station: s.station,
            stationKey: s.stationKey,
            estMin: s.estMin,
            done: !!s.done,
          }))
        : [],
      timers: Array.isArray(d.timers)
        ? d.timers.map((t) => ({
            id: t.id,
            label: t.label,
            station: t.station,
            seconds: t.seconds,
            startedAt: t.startedAt || null,
            running: !!t.running,
          }))
        : [],
      focus: d.focus
        ? {
            currentStep: d.focus.currentStep
              ? {
                  id: d.focus.currentStep.id,
                  label: d.focus.currentStep.label,
                  station: d.focus.currentStep.station,
                  estMin: d.focus.currentStep.estMin,
                }
              : null,
            nextStep: d.focus.nextStep
              ? {
                  id: d.focus.nextStep.id,
                  label: d.focus.nextStep.label,
                  station: d.focus.nextStep.station,
                  estMin: d.focus.nextStep.estMin,
                }
              : null,
          }
        : { currentStep: null, nextStep: null },
    };
    return copy;
  } catch {
    return draftOrSnapshot;
  }
}

function applyStationFilter(snapshot, stationFilter) {
  if (!snapshot || stationFilter === "all") return snapshot;
  const steps = (snapshot.steps || []).filter(
    (s) => s.stationKey === stationFilter || s.station === stationFilter
  );
  const timers = (snapshot.timers || []).filter(
    (t) => t.stationKey === stationFilter || t.station === stationFilter
  );
  const queue = steps.filter((s) => !s.done);
  const currentStep = queue[0] || steps[0] || null;
  const nextStep = queue[1] || steps[1] || null;

  return {
    ...snapshot,
    stationFilter,
    steps,
    timers,
    focus: {
      currentStep: currentStep
        ? { id: currentStep.id, label: currentStep.label, station: currentStep.station, estMin: currentStep.estMin }
        : null,
      nextStep: nextStep
        ? { id: nextStep.id, label: nextStep.label, station: nextStep.station, estMin: nextStep.estMin }
        : null,
    },
  };
}

// ------------------------ Hook ------------------------
export default function useOverlayStreamer({
  channel = "sv-cooking-stream",
  room = null,
  kind = "overlay:update",
  title = "Cooking Session",
  initialStreamerSafe = true,
  initialStationFilter = "all",
  domain = "meal",
} = {}) {
  const bcRef = useRef(null);
  const rtcRef = useRef(null);
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(() => (typeof BroadcastChannel !== "undefined" ? "local" : "none"));
  const [streamerSafe, _setStreamerSafe] = useState(!!initialStreamerSafe);
  const [stationFilter, _setStationFilter] = useState(initialStationFilter);
  const roomRef = useRef(room);

  // Init BroadcastChannel
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      setConnected((c) => (c === "local" ? "none" : c));
      return;
    }
    try {
      bcRef.current = new BroadcastChannel(channel);
      setConnected((c) => (c === "none" ? "local" : c));
      const p = emit("overlay.channel.ready", { channel, domain });
      // no hub export (observability-only)
      void p;
    } catch (e) {
      emit("overlay.channel.error", { channel, message: String(e?.message || e) });
      setConnected("none");
    }
    return () => {
      try {
        bcRef.current?.close?.();
      } catch {}
      bcRef.current = null;
    };
  }, [channel, domain]);

  // Join/leave room transport
  const joinRoom = useCallback(
    async (roomCode) => {
      roomRef.current = roomCode || null;
      if (!roomCode) {
        // leaving if previously connected
        try {
          await rtcRef.current?.leave?.();
        } catch {}
        try {
          await wsRef.current?.leave?.();
        } catch {}
        rtcRef.current = null;
        wsRef.current = null;
        setConnected((c) => (c.startsWith("room") ? "local" : c));
        emit("overlay.room.left", { room: null, domain });
        return;
      }

      setConnected("room:joining");
      emit("overlay.room.joining", { room: roomCode, domain });

      // Prefer RTC, fall back to WS
      let rtc = null;
      if (rtcClientFactory) {
        try {
          rtc = typeof rtcClientFactory === "function" ? rtcClientFactory() : rtcClientFactory;
          await rtc.join(roomCode);
          rtcRef.current = rtc;
          setConnected("room:connected");
          emit("overlay.room.connected", { room: roomCode, transport: "rtc", domain });
          return;
        } catch (e) {
          emit("overlay.room.error", {
            room: roomCode,
            transportTried: "rtc",
            message: String(e?.message || e),
          });
          rtcRef.current = null;
        }
      }

      if (wsFallbackFactory) {
        try {
          const ws = typeof wsFallbackFactory === "function" ? wsFallbackFactory() : wsFallbackFactory;
          await ws.join(roomCode);
          wsRef.current = ws;
          setConnected("room:connected");
          emit("overlay.room.connected", { room: roomCode, transport: "ws", domain });
          return;
        } catch (e) {
          emit("overlay.room.error", {
            room: roomCode,
            transportTried: "ws",
            message: String(e?.message || e),
          });
          wsRef.current = null;
        }
      }

      setConnected("room:error");
    },
    [domain]
  );

  const leaveRoom = useCallback(async () => {
    await joinRoom(null);
  }, [joinRoom]);

  useEffect(() => {
    if (room) joinRoom(room);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // Setters exposed
  const setStreamerSafe = useCallback((v) => {
    _setStreamerSafe(!!v);
    emit("overlay.streamerSafe.changed", { streamerSafe: !!v, domain });
  }, [domain]);

  const setStationFilter = useCallback((key) => {
    _setStationFilter(key || "all");
    emit("overlay.stationFilter.changed", { stationFilter: key || "all", domain });
  }, [domain]);

  // Compose & send snapshot
  const pushSnapshot = useCallback(
    (rawDraftOrSnapshot, opts = {}) => {
      if (!rawDraftOrSnapshot) return;

      // Build base overlay snapshot
      const base = {
        kind,
        at: Date.now(),
        title: opts.title || rawDraftOrSnapshot.title || title,
        stationFilter,
        streamerSafe,
        metrics: rawDraftOrSnapshot.metrics || {},
        stations: rawDraftOrSnapshot.stations || [],
        steps: rawDraftOrSnapshot.steps || [],
        timers: rawDraftOrSnapshot.timers || [],
        focus: rawDraftOrSnapshot.focus || null,
      };

      // Optional sanitization
      const payload = streamerSafe ? sanitizeForStream(base) : base;
      const filtered = applyStationFilter(payload, stationFilter);

      // 1) BroadcastChannel (same-device)
      try {
        bcRef.current?.postMessage(filtered);
        emit("overlay.snapshot.local", { size: estimateSize(filtered), stationFilter, streamerSafe, domain });
      } catch (e) {
        emit("overlay.snapshot.error", { stage: "local", message: String(e?.message || e) });
      }

      // 2) Room transport if connected
      if (connected === "room:connected" && (rtcRef.current || wsRef.current)) {
        try {
          const envelope = { type: "overlay.snapshot", ts: isoNow(), source: "hooks.useOverlayStreamer", data: filtered };
          if (rtcRef.current) {
            rtcRef.current.send?.("overlay.snapshot", envelope);
          } else {
            wsRef.current?.send?.("overlay.snapshot", envelope);
          }
          emit("overlay.snapshot.room", {
            stationFilter,
            streamerSafe,
            size: estimateSize(filtered),
            transport: rtcRef.current ? "rtc" : "ws",
            domain,
          });
        } catch (e) {
          emit("overlay.snapshot.error", { stage: "room", message: String(e?.message || e) });
        }
      }
    },
    [connected, domain, kind, stationFilter, streamerSafe, title]
  );

  // Helper to estimate payload size for diagnostics
  const estimateSize = useCallback((obj) => {
    try {
      return new Blob([JSON.stringify(obj)]).size;
    } catch {
      return -1;
    }
  }, []);

  // Public API
  return useMemo(
    () => ({
      connected,
      pushSnapshot,
      setRoom: joinRoom,
      leaveRoom,
      setStreamerSafe,
      streamerSafe,
      setStationFilter,
    }),
    [connected, pushSnapshot, joinRoom, leaveRoom, setStreamerSafe, streamerSafe, setStationFilter]
  );
}
