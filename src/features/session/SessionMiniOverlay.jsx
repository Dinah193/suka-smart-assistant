/**
 * src/features/session/SessionMiniOverlay.jsx
 * -----------------------------------------------------------------------------
 * Session Mini Overlay (floating in-app HUD)
 *
 * Purpose:
 * - Always-visible, draggable mini control surface for SessionRunner.
 * - Shows: step title, progress, timer, and controls (Prev, Pause/Resume, Next, Open, PiP).
 *
 * How it fits:
 * - Lives at app root via a portal (so navigation does not tear it down).
 * - Emits standard envelopes to eventBus on user actions and mirrors to Hub
 *   when familyFundMode is enabled.
 * - Listens for PiP actions (ui.pip.action) and forwards them to the parent
 *   controller via onAction, keeping controls in sync.
 *
 * Events emitted (payload: { type, ts, source, data }):
 * - ui.overlay.opened
 * - ui.overlay.closed
 * - ui.overlay.moved
 * - ui.overlay.action     (data.action: "prev"|"pause"|"resume"|"next"|"open"|"pip"|"close")
 * - ui.overlay.error
 *
 * Props:
 * - session: SessionContract (see Master Codegen Prompt)
 * - visible?: boolean = true
 * - keepAwake?: boolean = true  → uses useWakeLock(reason=`session:${id}`)
 * - onAction?: (action: string) => void
 *
 * UX:
 * - Keyboard: Space (Pause/Resume), N (Next), P (Prev), O (Open full).
 * - Draggable: click-drag header; position persisted to localStorage.
 * - Safe on SSR; defensive guards for browser-only APIs.
 * - Progressive enhancement: PiP button appears when supported.
 *
 * NOTE:
 * - Styling is inline/minimal to avoid external CSS coupling. Feel free to
 *   convert to Tailwind/shadcn in your design system pass.
 * -----------------------------------------------------------------------------
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import eventBus from "@/services/eventBus";
import { featureFlags } from "@/services/featureFlags";
import useWakeLock from "@/hooks/useWakeLock";
import pip from "@/features/session/session.pip";

let HubPacketFormatter = null;
let FamilyFundConnector = null;
(async () => {
  try {
    const m1 = await import("@/services/hub/HubPacketFormatter");
    const m2 = await import("@/services/hub/FamilyFundConnector");
    HubPacketFormatter = m1?.default || null;
    FamilyFundConnector = m2?.default || null;
  } catch { /* no-op */ }
})();

const SOURCE = "features.session.overlay";
const isoNow = () => new Date().toISOString();
const emit = (type, data = {}) => {
  const payload = { type, ts: isoNow(), source: SOURCE, data };
  try { eventBus?.emit?.(payload); } catch { /* no-op */ }
  if (featureFlags?.familyFundMode) exportToHubIfEnabled(payload);
  return payload;
};
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch { /* silent */ }
}

const POS_KEY = "ssa.session.overlay.pos.v1";

function mmss(sec) {
  const s = Math.max(0, Math.floor(+sec || 0));
  const m = String(Math.floor(s / 60)).padStart(2, "0");
  const r = String(s % 60).padStart(2, "0");
  return `${m}:${r}`;
}

/**
 * Persisted position helpers
 */
function readPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === "number" && typeof p?.y === "number") return p;
  } catch {}
  return null;
}
function writePos(x, y) {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ x, y })); } catch {}
}

/**
 * Determine current step safely
 */
function getCurrentStep(session) {
  const idx = Number(session?.progress?.currentStepIndex || 0);
  const arr = Array.isArray(session?.steps) ? session.steps : [];
  return { step: arr[idx] || null, idx, total: arr.length };
}

/**
 * Mini overlay component
 */
export default function SessionMiniOverlay({
  session,
  visible = true,
  keepAwake = true,
  onAction,
}) {
  const [mounted, setMounted] = useState(false);
  const [container, setContainer] = useState(null);

  // Timer state mirrors session.progress.elapsedSec with a local tick when running.
  const [elapsed, setElapsed] = useState(Number(session?.progress?.elapsedSec || 0));

  // Drag position
  const startPos = readPos() || { x: 16, y: 16 };
  const [pos, setPos] = useState(startPos);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, baseX: startPos.x, baseY: startPos.y });

  // Wake lock (optional, small boost to prevent dimming when mini overlay is in use)
  const reason = `session:${session?.id || "unknown"}`;
  const wl = useWakeLock({ auto: keepAwake, reason, hubSync: false });

  const { step, idx, total } = useMemo(() => getCurrentStep(session), [session]);
  const paused = session?.status === "paused";

  // Keep elapsed ticking while running; stop when paused/aborted/completed
  useEffect(() => setElapsed(Number(session?.progress?.elapsedSec || 0)), [session?.progress?.elapsedSec]);
  useEffect(() => {
    if (!visible) return;
    if (paused || session?.status !== "running") return;
    let rafId;
    let lastTs;
    const loop = (ts) => {
      if (lastTs != null) {
        const delta = (ts - lastTs) / 1000;
        setElapsed((e) => e + delta);
      }
      lastTs = ts;
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [visible, paused, session?.status]);

  // Portal mount
  useEffect(() => {
    setMounted(true);
    const el = document?.getElementById?.("ssa-overlay-root") || (() => {
      const root = document.createElement("div");
      root.id = "ssa-overlay-root";
      document.body.appendChild(root);
      return root;
    })();
    setContainer(el);
    emit("ui.overlay.opened", { sessionId: session?.id });
    return () => {
      emit("ui.overlay.closed", { sessionId: session?.id });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen to PiP actions and forward to controller
  useEffect(() => {
    const sub = (payload) => {
      if (payload?.type !== "ui.pip.action") return;
      const action = payload?.data?.action;
      if (!action) return;
      fireAction(action);
    };
    eventBus.on?.("ui.pip.action", sub);
    return () => eventBus.off?.("ui.pip.action", sub);
  }, []);

  // Keyboard shortcuts (local to overlay when focused OR global listener)
  useEffect(() => {
    const onKey = (e) => {
      const key = e.key?.toLowerCase?.();
      if (key === " " || key === "spacebar") {
        e.preventDefault();
        fireAction(paused ? "resume" : "pause");
      } else if (key === "n") {
        fireAction("next");
      } else if (key === "p") {
        fireAction("prev");
      } else if (key === "o") {
        fireAction("open");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  // Ensure overlay remains within viewport on resize/rotate
  useEffect(() => {
    const clamp = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setPos((p) => {
        const nx = Math.max(8, Math.min(p.x, vw - 8 - 320));  // assume ~320px width
        const ny = Math.max(8, Math.min(p.y, vh - 8 - 120));  // assume ~120px height
        if (nx !== p.x || ny !== p.y) {
          writePos(nx, ny);
          emit("ui.overlay.moved", { x: nx, y: ny });
        }
        return (nx !== p.x || ny !== p.y) ? { x: nx, y: ny } : p;
      });
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const fireAction = useCallback((action) => {
    const payload = emit("ui.overlay.action", { action, sessionId: session?.id });
    if (typeof onAction === "function") onAction(action);
    // Side-effects for certain actions that are UI-only:
    if (action === "pip" && pip.supported()) {
      pip.open(session).catch(() => {});
    }
    return payload;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAction, session?.id]);

  // Drag handlers
  const onDragStart = useCallback((e) => {
    const isTouch = e.type === "touchstart";
    const point = isTouch ? e.touches[0] : e;
    dragRef.current.dragging = true;
    dragRef.current.startX = point.clientX;
    dragRef.current.startY = point.clientY;
    dragRef.current.baseX = pos.x;
    dragRef.current.baseY = pos.y;
    document.body.style.userSelect = "none";
  }, [pos.x, pos.y]);

  const onDragMove = useCallback((e) => {
    if (!dragRef.current.dragging) return;
    const isTouch = e.type === "touchmove";
    const point = isTouch ? e.touches[0] : e;
    const dx = point.clientX - dragRef.current.startX;
    const dy = point.clientY - dragRef.current.startY;
    const nx = dragRef.current.baseX + dx;
    const ny = dragRef.current.baseY + dy;
    setPos({ x: nx, y: ny });
  }, []);

  const onDragEnd = useCallback(() => {
    if (!dragRef.current.dragging) return;
    dragRef.current.dragging = false;
    document.body.style.userSelect = "";
    writePos(pos.x, pos.y);
    emit("ui.overlay.moved", { x: pos.x, y: pos.y });
  }, [pos.x, pos.y]);

  // Derived UI state
  const progressPct = useMemo(() => {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round(((idx + 1) / total) * 100)));
  }, [idx, total]);

  if (!mounted || !container || !visible) return null;

  const width = 320;
  const styleWrap = {
    position: "fixed",
    left: `${pos.x}px`,
    top: `${pos.y}px`,
    width: `${width}px`,
    zIndex: 2147483000,
    background: "rgba(12,16,28,.92)",
    backdropFilter: "saturate(125%) blur(8px)",
    color: "#EAF2FF",
    border: "1px solid rgba(255,255,255,.08)",
    borderRadius: "14px",
    boxShadow: "0 10px 30px rgba(0,0,0,.35)",
    overflow: "hidden",
    fontFamily: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`,
  };
  const styleHeader = {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: "8px", padding: "8px 10px", cursor: "grab", background: "rgba(255,255,255,.04)",
  };
  const styleTitle = { fontWeight: 700, fontSize: 13, color: "#95A3B9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
  const styleBody = { padding: "10px", display: "grid", gap: "8px" };
  const styleStep = { fontWeight: 700, fontSize: 15, lineHeight: 1.2, maxHeight: 44, overflow: "hidden" };
  const styleRow = { display: "flex", alignItems: "center", gap: "8px" };
  const styleBar = { flex: 1, height: 6, borderRadius: 999, background: "rgba(255,255,255,.08)", overflow: "hidden" };
  const styleFill = { height: "100%", width: `${progressPct}%`, background: "linear-gradient(90deg, #6AA0FF, #9AD0FF)" };
  const styleTimer = { fontVariantNumeric: "tabular-nums", fontWeight: 700 };
  const styleControls = { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "8px" };
  const btn = {
    appearance: "none", border: "1px solid rgba(255,255,255,.10)", background: "rgba(255,255,255,.06)", color: "#EAF2FF",
    borderRadius: 10, padding: "8px 6px", fontWeight: 700, fontSize: 12, cursor: "pointer", textAlign: "center",
  };
  const btnDanger = { ...btn, borderColor: "rgba(255,122,122,.35)" };

  return createPortal(
    <section
      role="region"
      aria-label="Session mini overlay"
      style={styleWrap}
    >
      {/* Drag header */}
      <div
        style={styleHeader}
        onMouseDown={onDragStart}
        onMouseMove={onDragMove}
        onMouseUp={onDragEnd}
        onMouseLeave={onDragEnd}
        onTouchStart={onDragStart}
        onTouchMove={onDragMove}
        onTouchEnd={onDragEnd}
      >
        <div style={styleTitle} aria-label="Session title">
          {session?.title || "Session"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {pip.supported() && (
            <button
              style={btn}
              onClick={() => fireAction("pip")}
              title="Open Mini Window (Document PiP)"
            >
              PiP
            </button>
          )}
          <button
            style={btnDanger}
            onClick={() => fireAction("close")}
            title="Close overlay"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={styleBody}>
        <div style={styleStep} aria-live="polite">
          {step?.title || "Current step"}
        </div>

        <div style={styleRow}>
          <div style={styleBar} aria-hidden="true"><span style={styleFill} /></div>
          <div style={styleTimer} title="Elapsed">
            {mmss(elapsed)}
          </div>
        </div>

        {/* Cues */}
        <div style={{ fontSize: 12, color: "#FFCC66" }}>
          {step?.metadata?.donenessCue ? `Cue: ${step.metadata.donenessCue}` : ""}
          {Number.isFinite(+step?.metadata?.tempTargetF) ? `  •  Target: ${Math.round(+step.metadata.tempTargetF)}°F` : ""}
        </div>

        {/* Controls */}
        <div style={styleControls}>
          <button style={btn} onClick={() => fireAction("prev")} title="Previous (P)">Prev</button>
          <button
            style={btn}
            onClick={() => fireAction(paused ? "resume" : "pause")}
            title="Pause/Resume (Space)"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button style={btn} onClick={() => fireAction("next")} title="Next (N)">Next</button>
          <button style={btn} onClick={() => fireAction("open")} title="Open full Session Runner (O)">Open</button>
          <button
            style={btn}
            onClick={() => {
              // Best-effort wake control from the overlay
              if (!wl.supported) return;
              wl.toggle().catch(() => {});
            }}
            title={wl.active ? "Release wake lock" : "Keep screen on"}
          >
            {wl.active ? "Awake" : "Wake"}
          </button>
        </div>

        {/* Footer meta */}
        <div style={{ display: "flex", justifyContent: "space-between", color: "#95A3B9", fontSize: 11 }}>
          <span>Step {idx + 1}/{total || 0}</span>
          <span style={{ opacity: .9 }}>
            {session?.domain || ""}
          </span>
        </div>
      </div>
    </section>,
    container
  );
}
