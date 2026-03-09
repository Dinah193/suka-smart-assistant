/**
 * C:\Users\larho\suka-smart-assistant\src\features\session\SessionUpcomingPanel.jsx
 *
 * SessionUpcomingPanel — right-pane list of upcoming steps, with lightweight
 * guard indicators, inventory/substitution notes, quick actions (Jump / Skip),
 * and simple time math (per-step duration, total remaining, ETA).
 *
 * How this fits:
 * - Used by SessionRunner in the right pane under "Upcoming".
 * - Pure presentational + UI intents; authoritative mutations (progress,
 *   analytics) are handled by SessionRunner via provided callbacks.
 * - Emits "session.ui.click" via eventBus for telemetry; follows SSA event shape.
 *
 * Contracts honored:
 * - Step shape per Master Codegen Prompt.
 * - Props.onJumpTo(index) → parent changes the currentStepIndex and persists.
 * - Props.onSkip(index) → parent records analytics.skippedSteps and persists.
 * - Props.evaluateGuards(step) → {ok:boolean, failed:string[]} (optional).
 *
 * Resilience:
 * - Defensive around missing steps/fields.
 * - If evaluateGuards is unavailable, all steps render as "guard unknown".
 *
 * Extension points:
 * - renderStepExtras(step, i): custom JSX under each step (domain notes).
 * - pillRenderer: override for blocker/doneness/temperature pills.
 *
 * © Suka Smart Assistant
 */

import React, { useEffect, useMemo, useState } from "react";

// ---- Defensive imports -----------------------------------------------------
let eventBus;
try {
  eventBus = require("../../services/events/eventBus.js").default;
} catch {
  eventBus = { emit: () => {} };
}

// ---- Styles (scoped; swap to design system tokens later) -------------------
const styles = {
  wrap: { overflow: "auto" },
  sectionHeader: {
    padding: "12px 16px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    fontWeight: 700,
  },
  list: { listStyle: "none", margin: 0, padding: 12, display: "grid", gap: 8 },
  item: {
    border: "1px solid rgba(255,255,255,0.06)",
    background: "rgba(255,255,255,0.02)",
    borderRadius: 12,
    padding: 12,
    display: "grid",
    gap: 8,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  title: { fontWeight: 800, fontSize: 13.5 },
  metaRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  pill: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 10,
    border: "1px solid rgba(255,255,255,0.15)",
    color: "#cfe6ff",
  },
  warnPill: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 10,
    border: "1px solid rgba(255,200,0,0.35)",
    color: "#ffe9a1",
  },
  badPill: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 10,
    border: "1px solid rgba(255,120,120,0.35)",
    color: "#ffd0d0",
  },
  btnRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  btn: {
    padding: "7px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.04)",
    color: "#e8ecf1",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 12,
  },
  btnPrimary: {
    background: "linear-gradient(180deg,#00a2ff,#0088d6)",
    border: "1px solid rgba(0,0,0,0.2)",
  },
  note: { fontSize: 12, opacity: 0.9 },
  subList: {
    margin: "6px 0 0 0",
    padding: 0,
    listStyle: "disc inside",
    opacity: 0.9,
    fontSize: 12.5,
  },
  footer: {
    padding: "10px 12px",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    alignItems: "center",
    gap: 10,
    justifyContent: "space-between",
    fontSize: 12.5,
    opacity: 0.9,
  },
};

// ---- Helpers ---------------------------------------------------------------
const isoNow = () => new Date().toISOString();
const emitUi = (action, data = {}) => {
  try {
    eventBus.emit({
      type: "session.ui.click",
      ts: isoNow(),
      source: "SessionUpcomingPanel",
      data: { action, ...data },
    });
  } catch {
    /* noop */
  }
};
const mmss = (sec = 0) => {
  const s = Math.max(0, sec | 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
};

/**
 * @typedef {Object} SessionUpcomingPanelProps
 * @property {any} session - normalized session (see contract).
 * @property {number} currentIndex - zero-based index of current step.
 * @property {(idx:number)=>void} onJumpTo - Jump directly to step idx.
 * @property {(idx:number)=>void} onSkip - Mark step idx as skipped (parent persists).
 * @property {(step:any)=>Promise<{ok:boolean,failed:string[]}>} [evaluateGuards] - Optional guard check.
 * @property {(step:any,i:number)=>React.ReactNode} [renderStepExtras] - Optional domain-specific extras.
 * @property {(label:string,variant:"ok"|"warn"|"bad")=>React.ReactNode} [pillRenderer] - Optional pill override.
 */
export default function SessionUpcomingPanel({
  session,
  currentIndex,
  onJumpTo,
  onSkip,
  evaluateGuards,
  renderStepExtras,
  pillRenderer,
}) {
  const steps = Array.isArray(session?.steps) ? session.steps : [];
  const upcoming = useMemo(
    () => steps.slice(Math.max(0, currentIndex + 1)),
    [steps, currentIndex]
  );

  // Precompute simple totals
  const remainingDur = useMemo(() => {
    return upcoming.reduce(
      (sum, s) => sum + (Number.isFinite(s?.durationSec) ? s.durationSec : 0),
      0
    );
  }, [upcoming]);

  const eta = useMemo(() => {
    if (!remainingDur) return "—";
    const now = new Date();
    const then = new Date(now.getTime() + remainingDur * 1000);
    const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
    return `${pad(then.getHours())}:${pad(then.getMinutes())}`;
  }, [remainingDur]);

  // Guard states for visible upcoming (lazy-evaluated)
  const [guardMap, setGuardMap] = useState(
    /** @type {Record<number,{ok:boolean,failed:string[]}|undefined>} */ ({})
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!evaluateGuards) return setGuardMap({});
      const entries = await Promise.all(
        upcoming.map(async (s, i) => {
          try {
            const res = await evaluateGuards(s);
            return [i, res];
          } catch {
            return [i, { ok: true, failed: [] }];
          }
        })
      );
      if (!cancelled) {
        const m = {};
        entries.forEach(([i, res]) => (m[i] = res));
        setGuardMap(m);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [upcoming, evaluateGuards]);

  const renderPill = (label, variant = "ok") => {
    if (pillRenderer) return pillRenderer(label, variant);
    const base =
      variant === "bad"
        ? styles.badPill
        : variant === "warn"
        ? styles.warnPill
        : styles.pill;
    return <span style={base}>{label}</span>;
  };

  if (!upcoming.length) {
    return (
      <div style={styles.wrap} aria-live="polite">
        <div style={{ padding: 16, opacity: 0.7 }}>No upcoming steps.</div>
        <div style={styles.footer}>
          <div>Total remaining: 0:00</div>
          <div>ETA: —</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.wrap} aria-label="Upcoming steps">
      <ul style={styles.list}>
        {upcoming.map((s, i) => {
          const absoluteIndex = currentIndex + 1 + i;
          const duration = Number.isFinite(s?.durationSec) ? s.durationSec : 0;
          const blockers = Array.isArray(s?.blockers) ? s.blockers : [];
          const cue = s?.metadata?.donenessCue || null;
          const temp = s?.metadata?.tempTargetF || null;
          const invNotes = s?.metadata?.inventoryNotes;
          const subs = Array.isArray(s?.metadata?.substitutions)
            ? s.metadata.substitutions
            : null;

          const guardState = guardMap[i];
          const guardOk = guardState ? guardState.ok : undefined;
          const failed = guardState?.failed || [];

          return (
            <li key={s?.id || absoluteIndex} style={styles.item}>
              <div style={styles.row}>
                <div style={styles.title}>
                  Step {absoluteIndex + 1}: {s?.title || "Untitled"}
                </div>
                <div style={styles.metaRow} aria-label="time and guard">
                  {duration
                    ? renderPill(mmss(duration), "ok")
                    : renderPill("open", "warn")}
                  {guardOk === true
                    ? renderPill("guards ok", "ok")
                    : guardOk === false
                    ? renderPill(`blocked: ${failed.join(", ")}`, "bad")
                    : renderPill("guards ?", "warn")}
                </div>
              </div>

              {/* secondary meta */}
              <div className="meta" style={styles.metaRow}>
                {cue ? renderPill(`doneness: ${cue}`, "ok") : null}
                {Number.isFinite(temp) && temp
                  ? renderPill(`target: ${temp} °F`, "ok")
                  : null}
                {blockers?.length
                  ? blockers.map((b, bi) => (
                      <span key={`b-${bi}`} style={styles.pill}>
                        {b}
                      </span>
                    ))
                  : null}
              </div>

              {/* Notes */}
              {s?.desc ? <div style={styles.note}>{s.desc}</div> : null}
              {invNotes ? (
                <div style={styles.note}>
                  <strong>Inventory:</strong> {String(invNotes)}
                </div>
              ) : null}
              {subs?.length ? (
                <div>
                  <div style={{ ...styles.note, marginBottom: 4 }}>
                    <strong>Substitutions:</strong>
                  </div>
                  <ul style={styles.subList}>
                    {subs.map((x, xi) => (
                      <li key={xi}>
                        {typeof x === "string"
                          ? x
                          : x?.label || JSON.stringify(x)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* Domain extras slot */}
              {typeof renderStepExtras === "function"
                ? renderStepExtras(s, absoluteIndex)
                : null}

              <div style={styles.btnRow}>
                <button
                  type="button"
                  style={{ ...styles.btn, ...styles.btnPrimary }}
                  onClick={() => {
                    emitUi("upcoming.jump", {
                      idx: absoluteIndex,
                      id: session?.id,
                    });
                    onJumpTo?.(absoluteIndex);
                  }}
                  aria-label={`Jump to step ${absoluteIndex + 1}`}
                >
                  Jump
                </button>
                <button
                  type="button"
                  style={styles.btn}
                  onClick={() => {
                    emitUi("upcoming.skip", {
                      idx: absoluteIndex,
                      id: session?.id,
                    });
                    onSkip?.(absoluteIndex);
                  }}
                  aria-label={`Skip step ${absoluteIndex + 1}`}
                >
                  Skip
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div style={styles.footer}>
        <div>
          <strong>Total remaining:</strong> {mmss(remainingDur)}
        </div>
        <div>
          <strong>ETA:</strong> {eta}
        </div>
      </div>
    </div>
  );
}
