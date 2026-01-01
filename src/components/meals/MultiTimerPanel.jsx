// src/components/meals/MultiTimerPanel.jsx
/**
 * MultiTimerPanel
 *
 * DOMAIN ROLE (WEB OF MEANING):
 * - Primary domain: cooking / meals (timing pots, ovens, resting, proofing).
 * - Connected domains:
 *   - SessionRunner (cooking session timing & checkpoints),
 *   - storehouse/provisioning (cooling, freezing, canning windows),
 *   - feasts/events (coordinating dishes to land at serving time).
 *
 * CONCEPT:
 * - Not just "productivity timers" — this panel helps the householder
 *   keep rhythm over a cooking cycle: what is on the stove, in the oven,
 *   cooling for the storehouse, or finishing for a feast.
 *
 * TOOL MODE:
 * - Works standalone: the householder can spin up labelled timers
 *   without a session, just to manage today's cooking rhythm.
 *
 * STEWARDSHIP MODE:
 * - When given a sessionId and/or recipes/steps, this panel becomes a
 *   timing surface for a cooking session and emits meaningful eventBus
 *   events that other domains can respond to.
 *
 * EVENTS:
 * - cooking.timers.created
 * - cooking.timers.updated
 * - cooking.timer.started
 * - cooking.timer.paused
 * - cooking.timer.completed
 *
 * TODO[seasons]:
 * - Hook into seasonal engine for:
 *   - feast windows (align timer presets to Sabbath/feast meals),
 *   - suggestions for proofing/fermentation times per season.
 *
 * TODO[dependencies]:
 * - Link timers to preservation steps:
 *   - e.g., "cool stew for 30 min" before freezing/canning.
 *
 * TODO[insights]:
 * - Emit summaries about:
 *   - average cooking cycle length per session,
 *   - how often timers overrun for certain dishes,
 *   - which rhythms (weeknight vs feast) are more intense.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus";
import { automation } from "@/services/automation/runtime";

// Optional: shared store for active session / timers (works fine if missing)
let useSessionStore;
try {
  useSessionStore = require("@/store/SessionStore").useSessionStore;
} catch {}

/**
 * Timer shape (internal):
 * {
 *   id: string,
 *   label: string,
 *   recipeId?: string,
 *   stepLabel?: string,
 *   channel: "immediate" | "storehouse" | "feast", // rhythm focus
 *   totalSeconds: number,
 *   remainingSeconds: number,
 *   status: "idle" | "running" | "paused" | "done",
 *   createdAt: ISOString,
 *   sessionId?: string,
 * }
 */

/**
 * Props:
 * - stewardshipMode: boolean           // false = TOOL MODE, true = STEWARDSHIP_MODE
 * - sessionId?: string                 // cooking session id, if timers belong to a SessionRunner
 * - rhythmLabel?: string               // e.g. "Weeknight cycle", "Feast prep"
 * - initialTimers?: Timer[]            // optional initial timers (e.g. parsed from recipes)
 * - onTimersChange?(timers)            // parent callback when timers change
 * - onTimerCompleted?(timer)           // parent callback when a timer completes
 */
export default function MultiTimerPanel({
  stewardshipMode = false,
  sessionId,
  rhythmLabel = "Meal rhythm",
  initialTimers = [],
  onTimersChange,
  onTimerCompleted,
}) {
  const sessionStore = useSessionStore?.();
  const [timers, setTimers] = useState(() => normalizeInitial(initialTimers, sessionId));
  const [newLabel, setNewLabel] = useState("");
  const [newMinutes, setNewMinutes] = useState(10);
  const [newChannel, setNewChannel] = useState("immediate"); // immediate | storehouse | feast
  const [busy, setBusy] = useState(false);

  const tickRef = useRef(null);

  const modeContext = stewardshipMode ? "stewardship" : "tool";

  // Derived: running timers count
  const runningCount = useMemo(
    () => timers.filter((t) => t.status === "running").length,
    [timers]
  );

  // Persist & emit on changes
  useEffect(() => {
    if (onTimersChange) onTimersChange(timers);

    // Emit aggregated update
    eventBus?.emit?.("cooking.timers.updated", {
      context: modeContext,
      sessionId: sessionId || sessionStore?.activeSessionId || null,
      timersSummary: summarizeTimers(timers),
    });

    // Optionally notify automation/intelligence layer
    // TODO[insights]: automation?.("intelligence.cooking.timers.update", { timers, modeContext });

  }, [timers, onTimersChange, modeContext, sessionId, sessionStore?.activeSessionId]);

  // Heartbeat for running timers
  useEffect(() => {
    if (runningCount === 0) {
      clearInterval(tickRef.current);
      tickRef.current = null;
      return;
    }
    if (!tickRef.current) {
      tickRef.current = setInterval(() => {
        setTimers((prev) => {
          const now = Date.now();
          let changed = false;
          const next = prev.map((t) => {
            if (t.status !== "running") return t;
            const remaining = Math.max(0, t.remainingSeconds - 1);
            if (remaining !== t.remainingSeconds) changed = true;
            const status = remaining === 0 ? "done" : "running";
            return { ...t, remainingSeconds: remaining, status };
          });
          if (changed) {
            // Trigger completion side-channel for any newly done timers
            next
              .filter((t) => t.status === "done" && !prev.find((p) => p.id === t.id && p.status === "done"))
              .forEach((t) => handleTimerCompleted(t));
          }
          return next;
        });
      }, 1000);
    }
    return () => {
      clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [runningCount]);

  // When initialTimers prop changes, merge them in (e.g. from recipes)
  useEffect(() => {
    if (!initialTimers || !initialTimers.length) return;
    setTimers((prev) => mergeInitial(prev, initialTimers, sessionId));
  }, [JSON.stringify(initialTimers), sessionId]);

  // ------------------- Handlers -------------------

  function handleCreateTimer() {
    const label = newLabel.trim() || defaultLabelForChannel(newChannel);
    const minutes = Number(newMinutes);
    const totalSeconds = Math.max(30, minutes * 60);

    const timer = {
      id: `timer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label,
      recipeId: null,
      stepLabel: null,
      channel: newChannel,
      totalSeconds,
      remainingSeconds: totalSeconds,
      status: "idle",
      createdAt: new Date().toISOString(),
      sessionId: sessionId || sessionStore?.activeSessionId || null,
    };

    setTimers((prev) => [...prev, timer]);
    setNewLabel("");
    setNewMinutes(10);

    eventBus?.emit?.("cooking.timers.created", {
      context: modeContext,
      sessionId: timer.sessionId,
      timer,
    });
  }

  function handleStart(id) {
    setTimers((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: "running" }
          : t
      )
    );

    const timer = timers.find((t) => t.id === id);
    eventBus?.emit?.("cooking.timer.started", {
      context: modeContext,
      sessionId: timer?.sessionId || null,
      timerId: id,
      label: timer?.label,
    });

    // TODO[SessionRunner]: Notify session engine that a step-timer started.
    // automation?.("sessions.cooking.stepTimerStarted", { sessionId, timerId: id });
  }

  function handlePause(id) {
    setTimers((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: t.status === "running" ? "paused" : t.status }
          : t
      )
    );

    const timer = timers.find((t) => t.id === id);
    eventBus?.emit?.("cooking.timer.paused", {
      context: modeContext,
      sessionId: timer?.sessionId || null,
      timerId: id,
      label: timer?.label,
    });
  }

  function handleReset(id) {
    setTimers((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, remainingSeconds: t.totalSeconds, status: "idle" }
          : t
      )
    );
  }

  function handleRemove(id) {
    setTimers((prev) => prev.filter((t) => t.id !== id));
  }

  function handleTimerCompleted(timer) {
    // Notify parent
    onTimerCompleted?.(timer);

    // Emit household-aware event
    eventBus?.emit?.("cooking.timer.completed", {
      context: modeContext,
      sessionId: timer.sessionId || null,
      timerId: timer.id,
      label: timer.label,
      channel: timer.channel,
    });

    // TODO[storehouse]: for channel === "storehouse", trigger a gentle reminder
    // that items might be ready for freezing/canning/root-cellar.
    // automation?.("storehouse.coolingWindow.completed", { timer, modeContext });
  }

  async function handleSavePattern() {
    if (!timers.length) {
      alert("You need at least one timer to save a cooking rhythm.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        timers: timers.map(stripRuntimeFields),
        rhythmLabel,
        sessionId: sessionId || sessionStore?.activeSessionId || null,
      };

      // Save as a reusable pattern of cooking rhythm
      await automation?.("cooking.timers.savePattern", payload);

      // TODO[insights]: also notify progression engine that householder
      // has shaped a reusable rhythm.
      // eventBus?.emit?.("progression.stewardship.rhythmSaved", { domain: "cooking", rhythmLabel });

      alert("Cooking rhythm saved for reuse.");
    } finally {
      setBusy(false);
    }
  }

  // ------------------- Render -------------------

  const showEmpty = timers.length === 0;

  return (
    <div className="rounded-2xl border border-base-200 bg-base-100 shadow-md flex flex-col min-h-[240px]">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-base-200 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold uppercase tracking-wide text-base-content/70">
            Multi-Timer Rhythm Panel
          </div>
          <div className="text-xs text-base-content/70 truncate">
            Keep watch over your pots, ovens, and cooling dishes as part of a
            steady meal cycle.
            {stewardshipMode ? (
              <> • Connected to sessions & storehouse</>
            ) : (
              <> • Standalone timing surface</>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-base-content/60">
          <span className="px-2 py-1 rounded-full bg-base-200">
            {runningCount} in motion
          </span>
          <span className="px-2 py-1 rounded-full bg-base-200">
            {timers.length} total timers
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 flex-1 flex flex-col gap-3">
        {/* Quick add row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div className="space-y-1">
            <label className="label-text text-xs font-medium">Timer label</label>
            <input
              className="input input-bordered input-sm w-full"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. Rice pot, Oven tray, Cooling stew"
            />
          </div>
          <div className="space-y-1">
            <label className="label-text text-xs font-medium">Minutes</label>
            <input
              type="number"
              className="input input-bordered input-sm w-full"
              value={newMinutes}
              onChange={(e) => setNewMinutes(e.target.value)}
              min={1}
            />
          </div>
          <div className="space-y-1">
            <label className="label-text text-xs font-medium">Rhythm focus</label>
            <div className="flex items-center gap-2">
              <select
                className="select select-bordered select-sm w-full"
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
              >
                <option value="immediate">Cook for now (today&apos;s table)</option>
                <option value="storehouse">Storehouse (cooling/freezing/canning)</option>
                <option value="feast">Feast timing (landing dishes together)</option>
              </select>
              <button
                className="btn btn-primary btn-sm shrink-0"
                onClick={handleCreateTimer}
                disabled={busy}
              >
                Add timer
              </button>
            </div>
          </div>
        </div>

        {/* Timers list */}
        <div className="mt-2">
          {showEmpty ? (
            <EmptyTimers />
          ) : (
            <div className="space-y-2 max-h-[260px] overflow-auto pr-1">
              {timers.map((t) => (
                <TimerRow
                  key={t.id}
                  timer={t}
                  onStart={handleStart}
                  onPause={handlePause}
                  onReset={handleReset}
                  onRemove={handleRemove}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-base-200 flex items-center gap-3">
        <button
          className="btn btn-outline btn-sm"
          onClick={handleSavePattern}
          disabled={busy || !timers.length}
          title="Save this collection of timers as a reusable cooking rhythm"
        >
          Save as cooking rhythm
        </button>
        <div className="ml-auto text-[11px] text-base-content/60">
          {sessionId ? (
            <>Linked to session: {sessionId}</>
          ) : (
            <>No session attached — timing just today&apos;s cooking.</>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Subcomponents ------------------------------ */

function TimerRow({ timer, onStart, onPause, onReset, onRemove }) {
  const { label, channel, status, remainingSeconds, totalSeconds } = timer;
  const progress = totalSeconds > 0 ? 1 - remainingSeconds / totalSeconds : 0;
  const color =
    channel === "storehouse"
      ? "badge-info"
      : channel === "feast"
      ? "badge-warning"
      : "badge-ghost";

  const formattedRemaining = formatTime(remainingSeconds);

  return (
    <div className="rounded-lg border border-base-200 bg-base-100 px-3 py-2 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="font-medium text-xs truncate">{label}</div>
          <span className={cx("badge badge-xs", color)}>
            {channel === "storehouse"
              ? "Storehouse"
              : channel === "feast"
              ? "Feast"
              : "Immediate"}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-base-content/70">
          <div className="w-32 h-2 rounded-full bg-base-200 overflow-hidden">
            <div
              className={cx(
                "h-2",
                status === "done"
                  ? "bg-success"
                  : status === "running"
                  ? "bg-primary"
                  : "bg-base-300"
              )}
              style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
            />
          </div>
          <span>
            {formattedRemaining}{" "}
            {status === "running"
              ? "remaining"
              : status === "done"
              ? "finished"
              : status === "paused"
              ? "paused"
              : "ready"}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {status !== "running" && status !== "done" && (
          <button
            className="btn btn-primary btn-xs"
            onClick={() => onStart(timer.id)}
          >
            Start
          </button>
        )}
        {status === "running" && (
          <button
            className="btn btn-outline btn-xs"
            onClick={() => onPause(timer.id)}
          >
            Pause
          </button>
        )}
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => onReset(timer.id)}
        >
          Reset
        </button>
        <button
          className="btn btn-ghost btn-xs text-error"
          onClick={() => onRemove(timer.id)}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function EmptyTimers() {
  return (
    <div className="rounded-xl border border-dashed border-base-300 p-6 text-center bg-base-100">
      <div className="text-sm font-semibold">
        No cooking timers are running yet
      </div>
      <p className="text-xs text-base-content/70 mt-1 max-w-md mx-auto">
        Use this panel to keep a peaceful eye on your pots, ovens, and cooling
        dishes. Add timers for a single meal or an entire batch session so your
        rhythm stays steady.
      </p>
    </div>
  );
}

/* ------------------------------ Helpers ----------------------------------- */

function normalizeInitial(initial, sessionId) {
  if (!Array.isArray(initial) || !initial.length) return [];
  return mergeInitial([], initial, sessionId);
}

function mergeInitial(existing, initial, sessionId) {
  const map = new Map(existing.map((t) => [t.id, t]));
  initial.forEach((t) => {
    if (!t || !t.id) return;
    if (!map.has(t.id)) {
      map.set(t.id, {
        ...t,
        sessionId: t.sessionId || sessionId || null,
        status: t.status || "idle",
        createdAt: t.createdAt || new Date().toISOString(),
      });
    }
  });
  return Array.from(map.values());
}

function summarizeTimers(timers) {
  const total = timers.length;
  const running = timers.filter((t) => t.status === "running").length;
  const done = timers.filter((t) => t.status === "done").length;
  const byChannel = timers.reduce(
    (acc, t) => {
      acc[t.channel] = (acc[t.channel] || 0) + 1;
      return acc;
    },
    { immediate: 0, storehouse: 0, feast: 0 }
  );
  return { total, running, done, byChannel };
}

function stripRuntimeFields(timer) {
  const {
    id,
    label,
    recipeId,
    stepLabel,
    channel,
    totalSeconds,
    sessionId,
    createdAt,
  } = timer;
  return {
    id,
    label,
    recipeId: recipeId || null,
    stepLabel: stepLabel || null,
    channel,
    totalSeconds,
    sessionId: sessionId || null,
    createdAt,
  };
}

function defaultLabelForChannel(channel) {
  switch (channel) {
    case "storehouse":
      return "Cooling for storehouse";
    case "feast":
      return "Feast dish timing";
    default:
      return "Cooking timer";
  }
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
