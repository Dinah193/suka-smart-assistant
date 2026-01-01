// C:\Users\larho\suka-smart-assistant\src\pages\cooking\Remote.jsx
/* eslint-disable no-console */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";

/**
 * Suka Smart Assistant — Cooking: Remote View (Phone Controller)
 * -----------------------------------------------------------------------------
 * ROLE IN PIPELINE
 * imports → normalization → intelligence → session generation → play/overlay →
 * **remote control** → event emission → automation runtime → (optional) hub export
 *
 * This screen lets a phone join a "room" and remotely drive an active Play
 * session running on a desktop/TV overlay. It:
 *  - Accepts :room param or QR/paste to join via rtcClient (WS fallback)
 *  - Mirrors current play state (step title/text/remaining)
 *  - Sends control envelopes (prev/next/timer.start/timer.stop) per contract
 *  - Provides a “Streamer Safe” toggle (must mirror Play screen behavior)
 *  - Supports a station filter so multiple stations can be driven independently
 *  - Emits `remote.*` events using the shared eventBus and automation map
 *
 * NOTE: This view does NOT change household data directly; it only issues
 * controls to a running session. Therefore, it does not export to Hub.
 */

/* -------------------------------- Services -------------------------------- */
let eventBus = { emit: (...a) => console.debug("[Remote:eventBus.emit]", ...a), on: () => () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let AutomationEvents = { emit: () => {} };
try {
  AutomationEvents =
    require("@/services/automation/events.map").default ||
    require("@/services/automation/events.map");
} catch {}

const CONTROL_CHANNEL = "sv-cooking-control";
const STATE_CHANNEL = "sv-cooking-stream";

let rtcClient = null;
try {
  rtcClient =
    require("@/services/realtime/rtcClient").default ||
    require("@/services/realtime/rtcClient");
} catch {}

let wsFallback = null;
try {
  wsFallback =
    require("@/services/realtime/wsFallback").default ||
    require("@/services/realtime/wsFallback");
} catch {}

/* ----------------------------- Optional Helpers --------------------------- */
let QRScanner = null; // optional QR reader component
try {
  QRScanner = require("@/components/qr/QRScanner.jsx").default;
} catch {}

import "./cooking.css";

/* ---------------------------- Helper: ISO payload -------------------------- */
function isoPayload(type, source, data = {}) {
  return { type, ts: new Date().toISOString(), source, data };
}

/* ------------------------- Helpers: Event emission ------------------------- */
function emitBusAndAutomation(payload) {
  try {
    eventBus.emit(payload.type, payload);
  } catch {}
  try {
    AutomationEvents.emit?.(payload.type, payload.data || {});
  } catch {}
}
function emitEvent(type, data) {
  const payload = isoPayload(type, "pages.cooking.Remote", data);
  emitBusAndAutomation(payload);
  return payload;
}

/* ------------------------- Hook: Realtime connection ----------------------- */
function useRoomConnection(initialRoom) {
  const [room, setRoom] = useState(initialRoom || "");
  const [connected, setConnected] = useState(false);
  const [clientType, setClientType] = useState(null); // "rtc" | "ws" | null

  const clientRef = useRef(null);
  const stateUnsubRef = useRef(() => {});

  const join = useCallback(
    async (nextRoom) => {
      const targetRoom = (nextRoom || room || "").trim();
      if (!targetRoom) return { ok: false, reason: "Missing room" };

      // Clean up existing
      try {
        stateUnsubRef.current?.();
      } catch {}
      try {
        await clientRef.current?.leave?.();
      } catch {}

      // Prefer rtcClient, fallback to WS client if available
      let client = null;
      if (rtcClient) {
        try {
          client = await rtcClient.join(targetRoom);
          setClientType("rtc");
        } catch (e) {
          console.warn("rtcClient join failed, attempting WS fallback:", e);
        }
      }
      if (!client && wsFallback) {
        client = await wsFallback.join(targetRoom);
        setClientType("ws");
      }
      if (!client) {
        setConnected(false);
        return { ok: false, reason: "No realtime client available" };
      }

      clientRef.current = client;
      setRoom(targetRoom);
      setConnected(true);

      emitEvent("remote.joined", { room: targetRoom, clientType: client === wsFallback ? "ws" : "rtc" });

      return { ok: true };
    },
    [room]
  );

  const send = useCallback(
    async (payload) => {
      if (!connected || !clientRef.current) return false;
      try {
        await clientRef.current.send({ channel: CONTROL_CHANNEL, payload });
        return true;
      } catch (e) {
        console.warn("send failed:", e);
        return false;
      }
    },
    [connected]
  );

  const subscribeState = useCallback(
    (handler) => {
      if (!connected || !clientRef.current) return () => {};
      try {
        const unsub = clientRef.current.subscribe(STATE_CHANNEL, handler);
        stateUnsubRef.current = unsub;
        return unsub;
      } catch (e) {
        console.warn("subscribeState failed:", e);
        return () => {};
      }
    },
    [connected]
  );

  const leave = useCallback(async () => {
    try {
      stateUnsubRef.current?.();
    } catch {}
    try {
      await clientRef.current?.leave?.();
    } catch {}
    clientRef.current = null;
    setConnected(false);
    setClientType(null);
    emitEvent("remote.left", { room });
  }, [room]);

  return { room, setRoom, connected, clientType, join, leave, send, subscribeState };
}

/* ------------------------------- Main Screen ------------------------------ */
export default function Remote() {
  const { room: roomParam } = useParams();
  const navigate = useNavigate();

  // Connection
  const { room, setRoom, connected, clientType, join, leave, send, subscribeState } =
    useRoomConnection(roomParam);

  // Mirror of current play state
  const [state, setState] = useState({
    id: null,
    title: "",
    idx: 0,
    total: 0,
    step: null, // { id, title, text, durationSec }
    remaining: 0,
    stations: [], // discovered from incoming steps (step.station)
  });

  // UI controls
  const [streamerSafe, setStreamerSafe] = useState(true);
  const [stationFilter, setStationFilter] = useState("all"); // "all" or station key
  const [showScanner, setShowScanner] = useState(false);
  const [pasteCode, setPasteCode] = useState("");

  // Auto-join on mount when param exists
  useEffect(() => {
    if (!roomParam) return;
    join(roomParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomParam]);

  // Subscribe to play state stream
  useEffect(() => {
    if (!connected) return;
    const unsub = subscribeState((msg) => {
      // Expected payload shape from overlay/Play:
      // { kind: "play.state", id, idx, step: {id,title,text,durationSec,station?}, remaining, title }
      try {
        if (!msg?.payload || msg?.payload?.kind !== "play.state") return;
        const { id, idx, step, remaining, title } = msg.payload;
        const stations = collectStations(state.stations, step?.station);
        setState((s) => ({
          ...s,
          id: id || s.id,
          title: title || s.title,
          idx: typeof idx === "number" ? idx : s.idx,
          total: s.total, // overlay may not send total; keep prior
          step: sanitizeStep(step),
          remaining: typeof remaining === "number" ? remaining : s.remaining,
          stations,
        }));
      } catch (e) {
        console.warn("Bad play.state payload:", e);
      }
    });
    return () => {
      try {
        unsub?.();
      } catch {}
    };
  }, [connected, subscribeState, state.stations]);

  // Control envelope builder (keeps contract consistent)
  const envelope = useCallback(
    (action, extra = {}) => {
      return {
        kind: "control",
        action, // "prev" | "next" | "timer.start" | "timer.stop" | "announce"
        room,
        ts: new Date().toISOString(),
        streamerSafe,
        station: stationFilter !== "all" ? stationFilter : undefined,
        ...extra,
      };
    },
    [room, stationFilter, streamerSafe]
  );

  // Controls
  const doPrev = useCallback(async () => {
    const ok = await send(envelope("prev"));
    if (ok) emitEvent("remote.prev", { room, station: stationFilter });
  }, [send, envelope, room, stationFilter]);

  const doNext = useCallback(async () => {
    const ok = await send(envelope("next"));
    if (ok) emitEvent("remote.next", { room, station: stationFilter });
  }, [send, envelope, room, stationFilter]);

  const doTimerStart = useCallback(async () => {
    const ok = await send(envelope("timer.start"));
    if (ok) emitEvent("remote.timer.start", { room, station: stationFilter });
  }, [send, envelope, room, stationFilter]);

  const doTimerStop = useCallback(async () => {
    const ok = await send(envelope("timer.stop"));
    if (ok) emitEvent("remote.timer.stop", { room, station: stationFilter });
  }, [send, envelope, room, stationFilter]);

  const doAnnounce = useCallback(async () => {
    // Ask overlay to speak current step again (hands-busy aid)
    const ok = await send(envelope("announce", { message: "repeat" }));
    if (ok) emitEvent("remote.announce", { room, station: stationFilter });
  }, [send, envelope, room, stationFilter]);

  const onScan = useCallback(
    async (text) => {
      // Accept raw room or URLs like ".../cooking/remote/ROOMCODE"
      const match = /remote\/([^/?#]+)/i.exec(text || "") || /room=([^&]+)/i.exec(text || "");
      const code = (match ? match[1] : text)?.trim();
      if (!code) return;
      setRoom(code);
      await join(code);
      setShowScanner(false);
    },
    [join, setRoom]
  );

  // Derived UI bits
  const trimmedText = useMemo(() => {
    const t = state?.step?.text || "";
    return t.length > 300 ? `${t.slice(0, 297)}…` : t;
  }, [state?.step?.text]);

  const stationOptions = useMemo(() => {
    const set = new Set(["all", ...state.stations]);
    return Array.from(set);
  }, [state.stations]);

  /* --------------------------------- Render -------------------------------- */
  return (
    <div className="cook-remote">
      <header className="remote-header">
        <div className="title-wrap">
          <h1 className="play-title">Remote • Cooking</h1>
          <div className={`conn-pill ${connected ? "ok" : "bad"}`}>
            {connected ? `Connected (${clientType || "rt"})` : "Not Connected"}
          </div>
        </div>

        <div className="room-row">
          <label className="room-label">Room</label>
          <input
            className="room-input"
            placeholder="enter room code"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
          />
          <button className="btn" onClick={() => join()} disabled={!room}>
            Join
          </button>
          {connected && (
            <button className="btn subtle" onClick={leave}>
              Leave
            </button>
          )}
        </div>

        <div className="room-tools">
          <div className="paste-join">
            <input
              className="room-input"
              placeholder="paste QR text / link"
              value={pasteCode}
              onChange={(e) => setPasteCode(e.target.value)}
            />
            <button
              className="btn"
              onClick={() => {
                if (!pasteCode.trim()) return;
                onScan(pasteCode.trim());
                setPasteCode("");
              }}
            >
              Use
            </button>
          </div>

          {QRScanner ? (
            <>
              <button className="btn subtle" onClick={() => setShowScanner((s) => !s)}>
                {showScanner ? "Close Scanner" : "Scan QR"}
              </button>
              {showScanner && (
                <div className="qr-wrap">
                  <QRScanner onResult={(txt) => onScan(txt)} />
                </div>
              )}
            </>
          ) : null}

          <label className="toggle">
            <input
              type="checkbox"
              checked={streamerSafe}
              onChange={(e) => setStreamerSafe(e.target.checked)}
            />
            <span>Streamer Safe</span>
          </label>

          <div className="station-filter">
            <label>Station</label>
            <select value={stationFilter} onChange={(e) => setStationFilter(e.target.value)}>
              {stationOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <main className="remote-main">
        <section className="mirror">
          <div className="mirror-title">
            <div className="small">Session</div>
            <h2>{state.title || "—"}</h2>
          </div>

          <div className="mirror-step">
            <div className="step-top">
              <div className="step-index">
                Step {state.idx + 1}
                {state.total ? ` / ${state.total}` : ""}
              </div>
              <div className="step-station">{state?.step?.station ? `Station: ${state.step.station}` : ""}</div>
            </div>

            <div className="step-title big">{state?.step?.title || "…"}</div>
            <div className="step-text">{trimmedText}</div>

            <div className="timer-block">
              {typeof state?.step?.durationSec === "number" && state.step.durationSec > 0 ? (
                <>
                  <div className="timer-big">{formatMMSS(state?.remaining ?? 0)}</div>
                  <div className="hint">Single-timer focus (overlay owns the clock)</div>
                </>
              ) : (
                <div className="no-timer-note">No timer for this step</div>
              )}
            </div>
          </div>
        </section>

        <section className="controls">
          <div className="control-row">
            <button className="btn" onClick={doPrev} disabled={!connected}>
              ◀ Prev
            </button>
            <button className="btn" onClick={doAnnounce} disabled={!connected}>
              🔊 Repeat
            </button>
            <button className="btn" onClick={doNext} disabled={!connected}>
              Next ▶
            </button>
          </div>
          <div className="control-row">
            <button className="btn" onClick={doTimerStart} disabled={!connected}>
              ▶ Start Timer
            </button>
            <button className="btn" onClick={doTimerStop} disabled={!connected}>
              ⏸ Stop Timer
            </button>
          </div>
        </section>
      </main>

      <footer className="remote-footer">
        <button className="btn subtle" onClick={() => navigate("/cooking")}>
          Back to Cooking
        </button>
      </footer>
    </div>
  );
}

/* --------------------------------- Utils ---------------------------------- */
function formatMMSS(total) {
  const t = Math.max(0, Math.floor(total || 0));
  const m = Math.floor(t / 60)
    .toString()
    .padStart(2, "0");
  const s = (t % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
function sanitizeStep(step) {
  if (!step) return null;
  const { id, title, text, durationSec, station } = step;
  const trimmed = (text || "").length > 600 ? `${text.slice(0, 597)}…` : text || "";
  return { id: id || `step_${Date.now()}`, title: title || "", text: trimmed, durationSec: durationSec ?? 0, station };
}
function collectStations(existing = [], nextStation) {
  const out = new Set(existing);
  if (nextStation && typeof nextStation === "string") out.add(nextStation);
  return Array.from(out);
}
