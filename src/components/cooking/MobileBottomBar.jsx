// src/components/cooking/MobileBottomBar.jsx
import React, { useMemo } from "react";

/**
 * MobileBottomBar — sticky bottom action bar for hands-busy Play mode.
 * Layout: [ Prev ] [ Timer Puck (Start/Pause) ] [ Next ]
 *
 * How this fits the SSA pipeline:
 * - This component does not parse imports itself. It sits in the "automation → execution" step.
 * - It emits play.* events to the shared eventBus with a consistent payload shape:
 *     { type, ts, source, data }  // ISO timestamp
 * - If you choose to treat step/timer mutations as "household data" in your app,
 *   you can pass hubSync={true} and it will also attempt an optional Hub export
 *   (familyFundMode) using HubPacketFormatter + FamilyFundConnector.
 *
 * Extension points:
 * - onControlSend: upstream can send envelopes to rtcClient (remote), WS fallback, etc.
 * - onPrev/onNext/onTimerToggle: injection points for local state machines / orchestration.
 * - actions.right / actions.left: add custom controls later (e.g., "Mark Done", "Skip")
 */

let eventBus = {
  emit: (...a) => console.debug("[MobileBottomBar:eventBus.emit]", ...a),
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = {};
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

/** Optional Hub modules (fail silently if absent) */
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter").default;
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector").default;
} catch {}

/* ------------------------------ Small helpers ------------------------------ */
const isoNow = () => new Date().toISOString();

function emitEvent(type, data = {}) {
  const payload = {
    type,
    ts: isoNow(),
    source: "components.cooking.MobileBottomBar",
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

/** Format seconds → mm:ss (clamped to >= 0). */
function mmss(totalSeconds = 0) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/* ------------------------------- Component -------------------------------- */
export default function MobileBottomBar({
  // Navigation
  onPrev,
  onNext,

  // Timer
  onTimerToggle,
  primaryTimer, // { id, label, running, remainingSeconds, totalSeconds }
  timerDisabled = false,

  // Context (for event + remote envelopes)
  sessionId,
  stepId, // current step id
  room, // optional: current RTC/WS room code
  station, // optional: active station
  hubSync = false, // also export to hub (if familyFundMode)

  // Accessibility / UX
  allowHaptics = true,
  disabled = false,

  // Extension points (optional)
  onControlSend, // fn(envelope)
  leftSlot = null, // custom node left of Prev
  rightSlot = null, // custom node right of Next
}) {
  const time = useMemo(() => {
    const secs =
      primaryTimer?.remainingSeconds ?? primaryTimer?.totalSeconds ?? 0;
    return mmss(secs);
  }, [primaryTimer?.remainingSeconds, primaryTimer?.totalSeconds]);

  const running = !!primaryTimer?.running;

  const vibrate = (pattern = 20) => {
    try {
      if (!allowHaptics) return;
      if ("vibrate" in navigator) navigator.vibrate(pattern);
    } catch {}
  };

  const sendEnvelope = (kind, extra = {}) => {
    const env = {
      kind, // "prev" | "next" | "timer.toggle" | future kinds
      ts: isoNow(),
      room: room || null,
      sessionId: sessionId || null,
      stepId: stepId || null,
      station: station || null,
      timer: {
        id: primaryTimer?.id || null,
        running: !!primaryTimer?.running,
        remainingSeconds: Number(primaryTimer?.remainingSeconds ?? 0),
        totalSeconds: Number(primaryTimer?.totalSeconds ?? 0),
        label: primaryTimer?.label || null,
      },
      ...extra,
    };
    // Local bus for observers (Remote, Overlay sync handlers, etc.)
    eventBus.emit?.("play.control", {
      type: "play.control",
      ts: env.ts,
      source: "MobileBottomBar",
      data: env,
    });
    // Optional upstream delivery (rtcClient, WS fallback)
    try {
      onControlSend?.(env);
    } catch {}
    return env;
  };

  const handlePrev = () => {
    if (disabled) return;
    vibrate();
    const env = sendEnvelope("prev");
    const e = emitEvent("play.step.navigated", {
      direction: "prev",
      sessionId,
      stepId,
      room,
      station,
    });
    try {
      onPrev?.();
    } catch (err) {
      console.warn("[MobileBottomBar] onPrev error:", err);
    }
    if (hubSync) exportToHubIfEnabled(e);
  };

  const handleNext = () => {
    if (disabled) return;
    vibrate([15, 25]);
    const env = sendEnvelope("next");
    const e = emitEvent("play.step.navigated", {
      direction: "next",
      sessionId,
      stepId,
      room,
      station,
    });
    try {
      onNext?.();
    } catch (err) {
      console.warn("[MobileBottomBar] onNext error:", err);
    }
    if (hubSync) exportToHubIfEnabled(e);
  };

  const handleTimerToggle = () => {
    if (disabled || timerDisabled) return;
    vibrate([10, 10, 10]);
    const env = sendEnvelope("timer.toggle", {
      toState: running ? "paused" : "running",
    });
    const e = emitEvent("play.timer.toggled", {
      sessionId,
      timerId: primaryTimer?.id || null,
      toState: running ? "paused" : "running",
      remainingSeconds: Number(primaryTimer?.remainingSeconds ?? 0),
      room,
      station,
    });
    try {
      onTimerToggle?.();
    } catch (err) {
      console.warn("[MobileBottomBar] onTimerToggle error:", err);
    }
    if (hubSync) exportToHubIfEnabled(e);
  };

  return (
    <div className="sv-bottomBar" role="toolbar" aria-label="Cooking controls">
      {leftSlot}
      <button
        type="button"
        className="sv-bottomBar__btn"
        onClick={handlePrev}
        disabled={disabled}
        aria-label="Previous step"
        title="Previous step"
      >
        ◀ Prev
      </button>

      <button
        type="button"
        className="sv-timerPuck"
        onClick={handleTimerToggle}
        disabled={disabled || timerDisabled}
        aria-pressed={running}
        aria-label={running ? "Pause timer" : "Start timer"}
        title={running ? "Pause timer" : "Start timer"}
      >
        <span aria-hidden>{running ? "⏸" : "▶"}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{time}</span>
      </button>

      <button
        type="button"
        className="sv-bottomBar__btn sv-bottomBar__btn--primary"
        onClick={handleNext}
        disabled={disabled}
        aria-label="Next step"
        title="Next step"
      >
        Next ▶
      </button>
      {rightSlot}
    </div>
  );
}
