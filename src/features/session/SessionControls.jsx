/**
 * C:\Users\larho\suka-smart-assistant\src\features\session\SessionControls.jsx
 *
 * SessionControls — reusable footer/toolbar for controlling an SSA session.
 *
 * How this fits:
 * - Designed to be used by SessionRunner and any domain pages that need inline transport controls.
 * - Pure UI + light device integrations (optional hotkeys, haptics, Media Session wiring).
 * - Emits UI click events through eventBus (non-authoritative) while delegating ALL state changes
 *   to callbacks provided by the parent (e.g., SessionRunner) to keep a single source of truth.
 *
 * Contracts honored:
 * - Event payload shape for UI signals: { type, ts, source, data } via src/services/eventBus.js.
 * - Prefs: uses session.prefs.haptic to vibrate on button click where supported.
 * - Accessibility: labeled buttons, keyboard shortcuts (opt-in) with Space/N/P/Escape.
 *
 * Extension points:
 * - You can add more buttons via the "extraLeft" and "extraRight" render props.
 * - You can hide pieces (progress/source pills) with flags.
 *
 * © Suka Smart Assistant
 */

import React, { useEffect, useMemo, useRef } from "react";

// --- Defensive imports for SSA services ------------------------------------
let eventBus;
try {
  eventBus = require("../../services/eventBus.js").default;
} catch {
  eventBus = { emit: () => {} };
}

// --- Styles (scoped here; swap to your design system when ready) ------------
const styles = {
  bar: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.02)",
  },
  cluster: { display: "flex", gap: 8, alignItems: "center" },
  btn: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.04)",
    color: "#e8ecf1",
    cursor: "pointer",
    fontWeight: 600,
  },
  btnPrimary: {
    background: "linear-gradient(180deg,#00a2ff,#0088d6)",
    border: "1px solid rgba(0,0,0,0.2)",
    color: "#fff",
  },
  btnDisabled: {
    opacity: 0.55,
    cursor: "not-allowed",
  },
  pill: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 10,
    border: "1px solid rgba(255,255,255,0.15)",
    color: "#cfe6ff",
  },
  meta: { display: "flex", gap: 8, alignItems: "center", opacity: 0.85, fontSize: 12 },
  progressWrap: { width: 140, height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 8, overflow: "hidden" },
  progressBar: (pct) => ({
    width: `${Math.min(100, Math.max(0, pct))}%`,
    height: "100%",
    background: "linear-gradient(90deg,#63ffa1,#1cc2ff)",
  }),
};

// --- Helpers ----------------------------------------------------------------

const isoNow = () => new Date().toISOString();

function emitUi(action, data = {}) {
  try {
    eventBus.emit({ type: "session.ui.click", ts: isoNow(), source: "SessionControls", data: { action, ...data } });
  } catch { /* noop */ }
}

function vibrateMaybe(enabled, pattern = [6, 12, 6]) {
  try {
    if (!enabled) return;
    navigator.vibrate?.(pattern);
  } catch { /* noop */ }
}

function formatHMS(totalSeconds = 0) {
  const s = Math.max(0, totalSeconds | 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

// --- Media Session wiring (optional) ----------------------------------------
function useMediaSession(enabled, handlers, metadata) {
  useEffect(() => {
    if (!enabled) return;
    try {
      if (!("mediaSession" in navigator)) return;
      if (metadata?.title) {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: metadata.title,
          artist: metadata.subtitle || "",
          album: metadata.context || "Suka Smart Assistant",
        });
      }
      navigator.mediaSession.setActionHandler("play", handlers.onPlayPause);
      navigator.mediaSession.setActionHandler("pause", handlers.onPlayPause);
      navigator.mediaSession.setActionHandler("previoustrack", handlers.onPrev);
      navigator.mediaSession.setActionHandler("nexttrack", handlers.onNext);
      return () => {
        try {
          navigator.mediaSession.setActionHandler("play", null);
          navigator.mediaSession.setActionHandler("pause", null);
          navigator.mediaSession.setActionHandler("previoustrack", null);
          navigator.mediaSession.setActionHandler("nexttrack", null);
        } catch {}
      };
    } catch { /* noop */ }
  }, [enabled, handlers, metadata]);
}

// --- Hotkeys (optional) -----------------------------------------------------
function useHotkeys(enabled, map) {
  const mapRef = useRef(map);
  mapRef.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e) => {
      const k = e.key;
      if (k === " " || e.code === "Space") { e.preventDefault(); mapRef.current.onSpace?.(); }
      else if (k?.toLowerCase() === "n") { e.preventDefault(); mapRef.current.onN?.(); }
      else if (k?.toLowerCase() === "p") { e.preventDefault(); mapRef.current.onP?.(); }
      else if (k === "Escape") { e.preventDefault(); mapRef.current.onEsc?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/**
 * @typedef {Object} SessionControlsProps
 * @property {any} session - The current session object (normalized).
 * @property {() => void} onStart
 * @property {() => void} onTogglePause
 * @property {() => void} onNext
 * @property {() => void} onPrev
 * @property {() => void} onAbort
 * @property {() => void} onClose
 * @property {() => void} [onNotify] - Optional: show a browser notification.
 * @property {() => void} [onOpenMiniHUD] - Optional: open Document PiP mini HUD.
 * @property {boolean} [compact=false] - Smaller layout for tight spaces.
 * @property {boolean} [showSource=true] - Show source/type pills.
 * @property {boolean} [showProgress=true] - Show progress meter.
 * @property {boolean} [enableHotkeys=false] - Wire Space/N/P/Esc shortcuts here (Runner already has its own).
 * @property {boolean} [mediaSession=false] - Wire Media Session handlers here if desired.
 * @property {React.ReactNode} [extraLeft] - Slot for custom left-side content.
 * @property {React.ReactNode} [extraRight] - Slot for custom right-side content.
 */

/**
 * Reusable transport controls for sessions.
 * Delegates state changes to parent via callbacks and provides UI affordances.
 * @param {SessionControlsProps} props
 */
export default function SessionControls({
  session,
  onStart,
  onTogglePause,
  onNext,
  onPrev,
  onAbort,
  onClose,
  onNotify,
  onOpenMiniHUD,
  compact = false,
  showSource = true,
  showProgress = true,
  enableHotkeys = false,
  mediaSession = false,
  extraLeft,
  extraRight,
}) {
  const status = session?.status || "pending";
  const running = status === "running";
  const paused = status === "paused";
  const idx = session?.progress?.currentStepIndex || 0;
  const total = session?.steps?.length || 0;
  const haptic = !!session?.prefs?.haptic;

  const stepLabel = useMemo(() => (total ? `${idx + 1}/${total}` : "—"), [idx, total]);
  const progressPct = useMemo(() => (total ? (idx / total) * 100 : 0), [idx, total]);
  const elapsed = useMemo(() => formatHMS(session?.progress?.elapsedSec || 0), [session?.progress?.elapsedSec]);

  // Media Session — optional (Runner usually wires this globally)
  useMediaSession(
    mediaSession,
    {
      onPlayPause: () => onTogglePause?.(),
      onPrev: () => onPrev?.(),
      onNext: () => onNext?.(),
    },
    { title: session?.title, subtitle: stepLabel, context: session?.domain }
  );

  // Optional hotkeys (Runner already has its own focus-level shortcuts)
  useHotkeys(enableHotkeys, {
    onSpace: () => onTogglePause?.(),
    onN: () => onNext?.(),
    onP: () => onPrev?.(),
    onEsc: () => onClose?.(),
  });

  // Button click wrappers (emit UI + vibrate)
  const handleStartOrPause = () => {
    vibrateMaybe(haptic, [12]);
    emitUi(paused ? "resume" : running ? "pause" : "start", { id: session?.id });
    if (!running && !paused) onStart?.();
    else onTogglePause?.();
  };
  const handleNext = () => {
    vibrateMaybe(haptic, [6, 8]);
    emitUi("next", { id: session?.id, from: idx, to: Math.min(idx + 1, total - 1) });
    onNext?.();
  };
  const handlePrev = () => {
    vibrateMaybe(haptic, [6, 8, 6]);
    emitUi("prev", { id: session?.id, from: idx, to: Math.max(0, idx - 1) });
    onPrev?.();
  };
  const handleAbort = () => {
    vibrateMaybe(haptic, [30, 30, 30]);
    emitUi("abort.confirm", { id: session?.id });
    onAbort?.();
  };

  return (
    <div
      role="toolbar"
      aria-label="Session controls"
      style={{
        ...styles.bar,
        ...(compact ? { padding: "8px 12px" } : null),
      }}
    >
      {/* LEFT CLUSTER */}
      <div style={styles.cluster}>
        <button
          type="button"
          style={{
            ...styles.btn,
            ...(running ? styles.btnPrimary : {}),
          }}
          onClick={handleStartOrPause}
          aria-label={running ? "Pause session" : paused ? "Resume session" : "Start session"}
          title="Space"
        >
          {running ? "Pause" : paused ? "Resume" : "Start"}
        </button>

        <button
          type="button"
          style={styles.btn}
          onClick={handlePrev}
          aria-label="Previous step"
          title="P"
          disabled={!total || idx <= 0}
        >
          Previous
        </button>

        <button
          type="button"
          style={styles.btn}
          onClick={handleNext}
          aria-label="Next step"
          title="N"
          disabled={!total}
        >
          Next
        </button>

        {extraLeft || null}
      </div>

      {/* MIDDLE STATUS */}
      <div style={styles.cluster}>
        {showProgress ? (
          <>
            <div aria-label="elapsed time" style={{ fontVariantNumeric: "tabular-nums", opacity: 0.9 }}>{elapsed}</div>
            <div style={styles.progressWrap} aria-label="step progress">
              <div style={styles.progressBar(progressPct)} />
            </div>
            <div aria-label="step position" style={{ opacity: 0.85 }}>{stepLabel}</div>
          </>
        ) : null}
      </div>

      {/* RIGHT CLUSTER */}
      <div style={styles.cluster}>
        {showSource ? (
          <div style={styles.meta}>
            <span>Source:</span>
            <span style={styles.pill}>{session?.source?.type || "manual"}</span>
            {session?.source?.refId ? <span style={styles.pill}>ref: {session.source.refId}</span> : null}
            {session?.domain ? <span style={styles.pill}>{session.domain}</span> : null}
            {session?.status ? <span style={styles.pill}>{session.status}</span> : null}
          </div>
        ) : null}

        <button
          type="button"
          style={styles.btn}
          onClick={() => {
            emitUi("miniHUD.toggle", { id: session?.id });
            onOpenMiniHUD?.();
          }}
          title="Open mini HUD (Document Picture-in-Picture)"
        >
          Mini HUD
        </button>

        <button
          type="button"
          style={styles.btn}
          onClick={() => {
            emitUi("notify", { id: session?.id });
            onNotify?.();
          }}
          title="Show ongoing notification"
        >
          Notify
        </button>

        <button
          type="button"
          style={{ ...styles.btn, ...(status === "running" ? styles.btnDisabled : null) }}
          onClick={onClose}
          aria-label="Close session"
          title="Esc"
          disabled={status === "running"}
        >
          Close
        </button>

        <button
          type="button"
          style={styles.btn}
          onClick={handleAbort}
          aria-label="Abort session"
          title="Abort session"
        >
          Abort
        </button>

        {extraRight || null}
      </div>
    </div>
  );
}
