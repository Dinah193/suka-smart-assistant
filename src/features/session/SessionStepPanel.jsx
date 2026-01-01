/**
 * C:\Users\larho\suka-smart-assistant\src\features\session\SessionStepPanel.jsx
 *
 * SessionStepPanel — focused UI for the "current step" inside SessionRunner.
 *
 * How this fits:
 * - Rendered by SessionRunner’s left/main pane to show the active step with cues,
 *   mini checklist, blockers, doneness/temperature tips, and a per-step countdown.
 * - Pure presentational + light behaviors; authoritative state (progress, status)
 *   still lives in SessionRunner. We communicate via callbacks.
 * - Honors session.prefs.voiceGuidance (TTS) and session.prefs.autoAdvance.
 * - Evaluates per-step guards on mount/change and before auto-advance.
 *
 * Contracts honored:
 * - Step shape per Master Codegen Prompt (id, title, desc, durationSec, blockers[], metadata{}).
 * - Emits "session.ui.click" via eventBus for user interactions (non-authoritative).
 * - Calls props.onAdvanceRequested() when the step is done (manual or auto-advance).
 * - Calls props.onSkipRequested() when user chooses to skip (records analytics upstream).
 * - Calls props.onAdjustDuration(deltaSec) to nudge duration (±10s/±60s).
 *
 * Persistence & resilience:
 * - Tolerates missing/invalid steps; renders warnings instead of crashing.
 * - The per-step countdown derives from a local ref "stepStartedAt" and the provided
 *   "sessionIsRunning" boolean so the panel can continue ticking if the runner resumes.
 *
 * Extension points:
 * - addCueRenderer(name, renderer) pattern compatible with SessionRunner’s extension point.
 * - onRenderExtras slot for domain-specific content (e.g., probe graph, sanitizer tips).
 *
 * © Suka Smart Assistant
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

// ---- Defensive imports -----------------------------------------------------
let eventBus;
try {
  eventBus = require("../../services/eventBus.js").default;
} catch {
  eventBus = { emit: () => {} };
}

// ---- Styles (scoped; replace with your design system tokens) ---------------
const styles = {
  card: {
    background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 16,
    padding: 16,
  },
  headerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  title: { fontWeight: 800, fontSize: 16 },
  sub: { fontSize: 12, opacity: 0.8 },
  pill: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 10,
    border: "1px solid rgba(255,255,255,0.15)",
    color: "#cfe6ff",
  },
  desc: { opacity: 0.9, marginTop: 8, whiteSpace: "pre-wrap" },
  cuesRow: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 },
  section: { marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.08)" },
  checklist: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 },
  item: {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.06)",
    background: "rgba(255,255,255,0.02)",
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  warn: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,200,0,0.35)",
    background: "rgba(255,200,0,0.08)",
    color: "#ffe9a1",
    fontSize: 12,
  },
  danger: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,120,120,0.35)",
    background: "rgba(255,120,120,0.08)",
    color: "#ffd0d0",
    fontSize: 12,
  },
  controls: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 },
  btn: {
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.04)",
    color: "#e8ecf1",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
  },
  btnPrimary: {
    background: "linear-gradient(180deg,#00a2ff,#0088d6)",
    border: "1px solid rgba(0,0,0,0.2)",
  },
  timeBadge: { fontVariantNumeric: "tabular-nums", fontWeight: 700 },
  gaugesRow: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
};

// ---- Cue renderers (compatible with SessionRunner.addCueRenderer) ----------
const cueRenderers = {
  color: (notes) => <span style={styles.pill}>Color: {notes || "watch for browning"}</span>,
  texture: (notes) => <span style={styles.pill}>Texture: {notes || "smooth/firm cue"}</span>,
  probeTemp: (notes) => <span style={styles.pill}>Probe Temp: {notes || "check thermometer"}</span>,
  timer: (notes) => <span style={styles.pill}>Timer: {notes || "watch countdown"}</span>,
  smell: (notes) => <span style={styles.pill}>Smell: {notes || "aroma cue"}</span>,
};

/** Allow runtime extension by other modules */
export function addCueRenderer(name, renderer) {
  cueRenderers[name] = renderer;
}

// ---- Helpers ---------------------------------------------------------------
const isoNow = () => new Date().toISOString();

function emitUi(action, data = {}) {
  try {
    eventBus.emit({ type: "session.ui.click", ts: isoNow(), source: "SessionStepPanel", data: { action, ...data } });
  } catch { /* noop */ }
}

function speakMaybe(enabled, text) {
  try {
    if (!enabled || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.pitch = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { /* noop */ }
}

function secondsToMMSS(s) {
  const t = Math.max(0, s | 0);
  const m = Math.floor(t / 60);
  const sec = t % 60;
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(m)}:${pad(sec)}`;
}

// ---- Component -------------------------------------------------------------

/**
 * @typedef {Object} SessionStepPanelProps
 * @property {any} session - normalized session object (see contract).
 * @property {any|null} step - the current step.
 * @property {number} stepIndex - zero-based index of the current step.
 * @property {boolean} sessionIsRunning - whether the parent runner is in "running" state.
 * @property {() => Promise<{ok:boolean,failed:string[]}>} [evaluateGuards] - optional guard evaluator; falls back to ok.
 * @property {() => void} onAdvanceRequested - called when user or auto-advance requests "Next".
 * @property {() => void} onSkipRequested - called when user chooses to skip this step.
 * @property {(deltaSec:number) => void} onAdjustDuration - called to nudge duration (±10s/±60s).
 * @property {(idx:number, checked:boolean) => void} [onChecklistToggle] - optional mini-checklist toggles.
 * @property {() => React.ReactNode} [onRenderExtras] - optional slot for domain-specific extras (graphs, notes).
 */
export default function SessionStepPanel({
  session,
  step,
  stepIndex,
  sessionIsRunning,
  evaluateGuards,
  onAdvanceRequested,
  onSkipRequested,
  onAdjustDuration,
  onChecklistToggle,
  onRenderExtras,
}) {
  // Internal countdown derived from step.durationSec, not authoritative.
  const [remaining, setRemaining] = useState(() => Math.max(0, step?.durationSec | 0));
  const startedAtRef = useRef(Date.now());
  const tickIdRef = useRef(0);
  const [guardFail, setGuardFail] = useState(/** @type {string[]} */([]));

  // Reset countdown on step change
  useEffect(() => {
    startedAtRef.current = Date.now();
    setRemaining(Math.max(0, step?.durationSec | 0));
    setGuardFail([]);
    // Voice summary on step change
    if (session?.prefs?.voiceGuidance && step?.title) {
      const cueText = step?.metadata?.donenessCue ? `, cue: ${step.metadata.donenessCue}` : "";
      speakMaybe(true, `Step ${stepIndex + 1}. ${step.title}${cueText}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id]);

  // Evaluate guards when step mounts/changes
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!step) return setGuardFail([]);
      const res = await (evaluateGuards ? evaluateGuards(step) : Promise.resolve({ ok: true, failed: [] }));
      if (mounted) setGuardFail(res.ok ? [] : (res.failed || []));
    })();
    return () => { mounted = false; };
  }, [step, evaluateGuards]);

  // Local ticking (ties to parent running state)
  useEffect(() => {
    clearInterval(tickIdRef.current);
    if (!sessionIsRunning) return;
    tickIdRef.current = setInterval(() => {
      const target = Math.max(0, step?.durationSec | 0);
      if (!target) return; // open-ended step; no countdown
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      const left = Math.max(0, target - elapsed);
      setRemaining(left);

      // Auto-advance when timer hits 0 if enabled and guards pass
      if (left === 0 && session?.prefs?.autoAdvance) {
        clearInterval(tickIdRef.current);
        (async () => {
          // re-check guards just before advancing
          const res = await (evaluateGuards ? evaluateGuards(step) : Promise.resolve({ ok: true, failed: [] }));
          if (res.ok) {
            emitUi("autoAdvance", { id: session?.id, stepIndex });
            onAdvanceRequested?.();
          } else {
            setGuardFail(res.failed || []);
          }
        })();
      }
    }, 1000);
    return () => clearInterval(tickIdRef.current);
  }, [sessionIsRunning, step?.durationSec, stepIndex, session?.prefs?.autoAdvance, evaluateGuards, onAdvanceRequested, step, session?.id]);

  // Derived display
  const cue = step?.metadata?.donenessCue || null;
  const cueNotes = step?.metadata?.cueNotes || "";
  const tempTarget = step?.metadata?.tempTargetF || null;

  const blockersBadges = useMemo(() => {
    const list = Array.isArray(step?.blockers) ? step.blockers : [];
    if (!list.length) return null;
    return (
      <div className="blockers" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        {list.map((b, i) => (
          <span key={b + i} style={styles.pill}>{b}</span>
        ))}
      </div>
    );
  }, [step]);

  // Mini checklist storage is upstream; just render if present on step.metadata.checklist
  const checklist = Array.isArray(step?.metadata?.checklist) ? step.metadata.checklist : null;

  return (
    <div style={styles.card}>
      {/* Header */}
      <div style={styles.headerRow}>
        <div>
          <div style={styles.title}>
            {step ? `Step ${stepIndex + 1}: ${step.title}` : "No current step"}
          </div>
          <div style={styles.sub}>
            {step ? <>
              <span style={styles.timeBadge}>
                {step?.durationSec ? secondsToMMSS(remaining) : "—:—"}
              </span>
              {step?.durationSec ? <span style={{ marginLeft: 8, opacity: 0.8 }}>remaining</span> : <span style={{ marginLeft: 8, opacity: 0.8 }}>open-ended</span>}
            </> : null}
          </div>
        </div>

        {/* Duration nudge & action buttons */}
        <div style={styles.gaugesRow}>
          {typeof step?.durationSec === "number" && step.durationSec > 0 ? (
            <>
              <button
                type="button"
                style={styles.btn}
                onClick={() => { emitUi("duration.nudge", { id: session?.id, stepIndex, delta: -10 }); onAdjustDuration?.(-10); }}
                title="-10s"
              >−10s</button>
              <button
                type="button"
                style={styles.btn}
                onClick={() => { emitUi("duration.nudge", { id: session?.id, stepIndex, delta: +10 }); onAdjustDuration?.(+10); }}
                title="+10s"
              >+10s</button>
              <button
                type="button"
                style={styles.btn}
                onClick={() => { emitUi("duration.nudge", { id: session?.id, stepIndex, delta: -60 }); onAdjustDuration?.(-60); }}
                title="-60s"
              >−60s</button>
              <button
                type="button"
                style={styles.btn}
                onClick={() => { emitUi("duration.nudge", { id: session?.id, stepIndex, delta: +60 }); onAdjustDuration?.(+60); }}
                title="+60s"
              >+60s</button>
            </>
          ) : null}
          <button
            type="button"
            style={{ ...styles.btn, ...styles.btnPrimary }}
            onClick={() => { emitUi("advance.request", { id: session?.id, stepIndex }); onAdvanceRequested?.(); }}
            title="Next"
          >
            Next
          </button>
          <button
            type="button"
            style={styles.btn}
            onClick={() => { emitUi("skip.request", { id: session?.id, stepIndex }); onSkipRequested?.(); }}
            title="Skip step"
          >
            Skip
          </button>
        </div>
      </div>

      {/* Description */}
      {step?.desc ? <div style={styles.desc}>{step.desc}</div> : (
        <div style={{ ...styles.desc, opacity: 0.7 }}>(No details provided for this step.)</div>
      )}

      {/* Cues */}
      <div style={styles.cuesRow}>
        {cue ? (cueRenderers[cue] ? cueRenderers[cue](cueNotes) : <span style={styles.pill}>{cue}: {cueNotes || "—"}</span>) : null}
        {tempTarget ? <span style={styles.pill}>Target: {tempTarget} °F</span> : null}
      </div>

      {/* Blockers (declared) */}
      {blockersBadges}

      {/* Guard failures (evaluated) */}
      {guardFail.length ? (
        <div style={{ ...styles.section }}>
          <div style={styles.danger}>Blocked by: {guardFail.join(", ")}. Resolve before advancing.</div>
        </div>
      ) : null}

      {/* Mini checklist */}
      {checklist ? (
        <div style={styles.section}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Checklist</div>
          <ul style={styles.checklist}>
            {checklist.map((c, i) => {
              const id = `${step?.id || "step"}-c-${i}`;
              const checked = !!c.checked;
              return (
                <li key={id} style={styles.item}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      emitUi("checklist.toggle", { id: session?.id, stepIndex, itemIndex: i, checked: e.target.checked });
                      onChecklistToggle?.(i, e.target.checked);
                    }}
                  />
                  <label htmlFor={id} style={{ cursor: "pointer" }}>{c.label || `Item ${i + 1}`}</label>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Temperature / Doneness tips */}
      {(tempTarget || cueNotes) ? (
        <div style={styles.section}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Tips</div>
          <div style={styles.gaugesRow}>
            {tempTarget ? <span style={styles.pill}>Probe to {tempTarget} °F</span> : null}
            {cue ? <span style={styles.pill}>Doneness: {cue}</span> : null}
          </div>
          {cueNotes ? <div style={{ marginTop: 8, opacity: 0.9, fontSize: 13 }}>{cueNotes}</div> : null}
        </div>
      ) : null}

      {/* Domain extras slot */}
      {onRenderExtras ? (
        <div style={styles.section}>
          {onRenderExtras()}
        </div>
      ) : null}

      {/* Warnings for bad/missing step */}
      {!step ? (
        <div style={{ ...styles.section }}>
          <div style={styles.warn}>This session has no valid current step. Use Next/Prev to navigate or Abort.</div>
        </div>
      ) : null}
    </div>
  );
}
