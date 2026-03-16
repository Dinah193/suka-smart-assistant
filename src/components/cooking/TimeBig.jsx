// src/components/cooking/TimeBig.jsx
import React, { useMemo, useCallback, useEffect, useRef } from "react";

/**
 * TimeBig — large single-timer readout with Start/Pause and Reset.
 *
 * Where it fits in SSA:
 * - Lives in the execution UI (Cook Now / Play). It doesn’t parse imports;
 *   it reacts to the already-generated session state (intelligence → automation → execution).
 * - Emits play.* events to the shared eventBus with a consistent payload shape:
 *     { type, ts, source, data }
 * - If you consider timer state as household data worth exporting upstream, set hubSync={true}
 *   and it will optionally export via HubPacketFormatter + FamilyFundConnector when
 *   featureFlags.familyFundMode is true (fails silently if Hub is unavailable).
 *
 * Extension points:
 * - onToggle / onReset delegate to your state machine.
 * - onControlSend sends realtime envelopes (rtcClient WS fallback) if provided.
 * - renderLeft / renderRight let you inject extra controls (e.g., “Mark Step Done”).
 */

// ---------- Shared glue (safe-requiring) ----------
let eventBus = {
  emit: (...a) => console.debug("[TimeBig:eventBus.emit]", ...a),
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = {};
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter").default;
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector").default;
} catch {}

// ---------- Helpers ----------
const isoNow = () => new Date().toISOString();

function emitEvent(type, data = {}) {
  const payload = {
    type,
    ts: isoNow(),
    source: "components.cooking.TimeBig",
    data,
  };
  eventBus.emit?.(type, payload);
  return payload;
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // fail silently by design
  }
}

function clampNumber(n, min = 0) {
  const v = Number.isFinite(n) ? n : 0;
  return Math.max(min, v);
}

function mmss(totalSeconds = 0) {
  const s = clampNumber(Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function preferredLabel(label, fallback = "Timer") {
  const s = (label || "").toString().trim();
  return s || fallback;
}

// ---------- Component ----------
export default function TimeBig({
  timer, // { id, label, running, remainingSeconds, totalSeconds, station }
  onToggle, // () => void   // you keep the state machine
  onReset, // () => void
  // Context for events + realtime
  sessionId = null,
  stepId = null,
  station = null,
  room = null,
  hubSync = false,
  onControlSend = null,
  // UX
  showLabel = true,
  emphasize = true,
  compact = false,
  allowHaptics = true,
  disabled = false,
  // Slots
  renderLeft = null,
  renderRight = null,
  className = "",
  style = {},
  "aria-label": ariaLabel,
}) {
  const running = !!timer?.running;
  const seconds = timer?.remainingSeconds ?? timer?.totalSeconds ?? 0;
  const timeText = useMemo(() => mmss(seconds), [seconds]);
  const titleText = preferredLabel(timer?.label);

  const containerRef = useRef(null);

  const vibrate = (pattern = 20) => {
    try {
      if (!allowHaptics) return;
      if ("vibrate" in navigator) navigator.vibrate(pattern);
    } catch {}
  };

  const sendEnvelope = useCallback(
    (kind, extra = {}) => {
      const env = {
        kind, // "timer.toggle" | "timer.reset"
        ts: isoNow(),
        room,
        sessionId,
        stepId,
        station: station ?? timer?.station ?? null,
        timer: {
          id: timer?.id ?? null,
          label: preferredLabel(timer?.label, null),
          running: !!timer?.running,
          remainingSeconds: clampNumber(timer?.remainingSeconds ?? 0),
          totalSeconds: clampNumber(timer?.totalSeconds ?? 0),
        },
        ...extra,
      };
      eventBus.emit?.("play.control", {
        type: "play.control",
        ts: env.ts,
        source: "TimeBig",
        data: env,
      });
      try {
        onControlSend?.(env);
      } catch {}
      return env;
    },
    [room, sessionId, stepId, station, timer, onControlSend]
  );

  const handleToggle = useCallback(() => {
    if (disabled) return;
    vibrate([10, 10, 10]);
    const toState = running ? "paused" : "running";
    sendEnvelope("timer.toggle", { toState });
    const e = emitEvent("play.timer.toggled", {
      sessionId,
      room,
      stepId,
      station: station ?? timer?.station ?? null,
      timerId: timer?.id ?? null,
      toState,
      remainingSeconds: clampNumber(timer?.remainingSeconds ?? 0),
    });
    try {
      onToggle?.();
    } catch (err) {
      console.warn("[TimeBig] onToggle error:", err);
    }
    if (hubSync) exportToHubIfEnabled(e);
  }, [
    disabled,
    running,
    sendEnvelope,
    sessionId,
    room,
    stepId,
    station,
    timer,
    onToggle,
    hubSync,
  ]);

  const handleReset = useCallback(() => {
    if (disabled) return;
    vibrate([25, 40]);
    sendEnvelope("timer.reset");
    const e = emitEvent("play.timer.reset", {
      sessionId,
      room,
      stepId,
      station: station ?? timer?.station ?? null,
      timerId: timer?.id ?? null,
    });
    try {
      onReset?.();
    } catch (err) {
      console.warn("[TimeBig] onReset error:", err);
    }
    if (hubSync) exportToHubIfEnabled(e);
  }, [
    disabled,
    sendEnvelope,
    sessionId,
    room,
    stepId,
    station,
    timer,
    onReset,
    hubSync,
  ]);

  // Space/Enter toggles; R resets (focus on widget)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e) => {
      if (e.defaultPrevented) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        handleToggle();
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        handleReset();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [handleToggle, handleReset]);

  // Sizes
  const sizeClass = compact
    ? "sv-timerBig--sm"
    : emphasize
    ? "sv-timerBig--xl"
    : "sv-timerBig--md";

  return (
    <div
      ref={containerRef}
      className={`sv-card sv-pad sv-timerBig ${sizeClass} ${className}`}
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 12,
        ...(style || {}),
      }}
      role="group"
      aria-label={ariaLabel || `${titleText} timer`}
      tabIndex={0}
    >
      {/* Left slot (optional) */}
      <div className="sv-timerBig__left" aria-hidden={!renderLeft}>
        {typeof renderLeft === "function"
          ? renderLeft({ running, seconds })
          : renderLeft}
      </div>

      {/* Main time */}
      <div className="sv-timerBig__center" style={{ textAlign: "center" }}>
        {showLabel && (
          <div
            className="sv-timerBig__label sv-muted"
            style={{ marginBottom: 6, fontWeight: 600 }}
            title={titleText}
          >
            {titleText}
          </div>
        )}
        <div
          className="sv-timerBig__time"
          style={{
            fontVariantNumeric: "tabular-nums",
            fontSize: compact ? 36 : emphasize ? 72 : 48,
            lineHeight: 1,
            fontWeight: 800,
            letterSpacing: ".02em",
          }}
          aria-live="polite"
        >
          {timeText}
        </div>
      </div>

      {/* Controls */}
      <div
        className="sv-timerBig__controls"
        style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
      >
        <button
          type="button"
          className="sv-btn sv-btn--outline"
          onClick={handleReset}
          disabled={disabled}
          aria-label="Reset timer"
          title="Reset (R)"
        >
          ↺ Reset
        </button>
        <button
          type="button"
          className={`sv-btn ${
            running ? "sv-btn--outline" : "sv-btn--primary"
          }`}
          onClick={handleToggle}
          disabled={disabled}
          aria-pressed={running}
          aria-label={running ? "Pause timer" : "Start timer"}
          title={running ? "Pause (Space/Enter)" : "Start (Space/Enter)"}
        >
          {running ? "⏸ Pause" : "▶ Start"}
        </button>
        {/* Right slot (optional) */}
        {typeof renderRight === "function"
          ? renderRight({ running, seconds })
          : renderRight}
      </div>
    </div>
  );
}
