// C:\Users\larho\suka-smart-assistant\src\pages\tools\multi-timer.jsx
//
// Multi-Timer Tool (SSA Tools Suite)
// ----------------------------------
// Purpose in SSA pipeline:
//   - imports:  (indirect) receives "session context" from other domains via URL/context later
//   - intelligence: lets the user define multiple named timers with domain tags (cooking,
//                   cleaning, garden, animals, preservation, storehouse, other) to shape
//                   how a session runs in real time.
//   - automation: emits SSA events on start/pause/complete so SessionRunner, Analytics,
//                 or AutomationRuntime can react (e.g., "step done", "blocker hit").
//   - hub export: *not used directly here* because timers do not mutate inventory/storehouse.
//                 If you later log timer outcomes into storehouse or sessions, call
//                 exportToHubIfEnabled(payload) around those writes.
//
// Forward-thinking extension points:
//   - DOMAIN_OPTIONS can be extended with new domains like "textiles", "maintenance".
//   - timer objects include domain + sessionId so downstream engines can connect timers
//     to SSA sessions.
//   - window.sukaMultiTimerContext (optional) can pre-fill sessionId/domain from other pages.

import React, { useEffect, useMemo, useRef, useState } from "react";
import eventBus from "../../services/events/eventBus";

/***************************** Event helpers *****************************/

function nowIso() {
  return new Date().toISOString();
}

/**
 * Emit standardized SSA events from this tool.
 * Shape: { type, ts, source, data }
 */
function emitTimerEvent(type, data = {}) {
  try {
    eventBus.emit({
      type,
      ts: nowIso(),
      source: "tools/multi-timer",
      data,
    });
  } catch (err) {
    // Never let analytics/events crash the UI
    // eslint-disable-next-line no-console
    console.warn("MultiTimer event emit failed:", err);
  }
}

// Placeholder for future Hub export when timers start writing household data
// (e.g., logging preservation batches, cleaning sessions, etc.).
// import featureFlags from "../../config/featureFlags";
// import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
// import FamilyFundConnector from "@/services/hub/FamilyFundConnector";
// function exportToHubIfEnabled(payload) {
//   try {
//     if (!featureFlags?.familyFundMode) return;
//     const packet = HubPacketFormatter.format("multiTimerSession", payload);
//     FamilyFundConnector.send(packet);
//   } catch (err) {
//     console.warn("MultiTimer Hub export failed:", err);
//   }
// }

/********************** Shared pop UI (no special unicode) **********************/
const btnBase =
  "inline-flex items-center justify-center rounded-xl border bg-white px-4 py-2 font-medium shadow-[0_6px_0_rgba(0,0,0,0.2),0_1px_4px_rgba(0,0,0,0.15)] active:translate-y-[4px] active:shadow-[0_2px_0_rgba(0,0,0,0.25),0_1px_2px_rgba(0,0,0,0.25)] transition-all";
const card =
  "rounded-3xl p-4 bg-gradient-to-b from-slate-50 to-slate-200 border border-slate-300 shadow-[0_10px_0_rgba(0,0,0,0.15),0_2px_8px_rgba(0,0,0,0.15)]";
const cardSoft =
  "rounded-3xl p-4 bg-gradient-to-b from-white to-slate-50 border border-slate-200 shadow-[0_8px_0_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.12)]";

function Input({ className = "", ...props }) {
  return (
    <input
      className={`h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-indigo-400 ${className}`}
      {...props}
    />
  );
}
function SmallInput({ className = "", ...props }) {
  return (
    <input
      className={`h-8 rounded-xl border border-slate-300 bg-white px-2 text-sm outline-none focus:ring-2 focus:ring-indigo-400 ${className}`}
      {...props}
    />
  );
}
function KeyBtn({ children, onClick, className = "", title, disabled }) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`${btnBase} ${
        disabled ? "opacity-60 cursor-not-allowed" : ""
      } ${className}`}
    >
      {children}
    </button>
  );
}

/******************************* Timer utils ********************************/

const clampNum = (n) => (Number.isFinite(+n) ? +n : 0);
const SEC_MS = 1000;

function msFromMinSec(min, sec) {
  const totalSec = clampNum(min) * 60 + clampNum(sec);
  return Math.max(0, totalSec * SEC_MS);
}
function minSecFromMs(ms) {
  const totalSec = Math.max(0, Math.round(ms / SEC_MS));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return { m, s };
}
function formatHMS(ms) {
  const totalSec = Math.max(0, Math.round(ms / SEC_MS));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(
      2,
      "0"
    )}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const INITIAL_DOMAIN_OPTIONS = [
  { key: "cooking", label: "Cooking" },
  { key: "cleaning", label: "Cleaning" },
  { key: "garden", label: "Garden" },
  { key: "animals", label: "Animals" },
  { key: "preservation", label: "Preservation" },
  { key: "storehouse", label: "Storehouse" },
  { key: "other", label: "Other / Misc" },
];

/**
 * Try to read additional domain options from a global override so that
 * future SSA modules (textiles, maintenance, etc.) can add themselves
 * without changing this file.
 */
function getDomainOptions() {
  try {
    const extra = Array.isArray(window?.sukaMultiTimerDomains)
      ? window.sukaMultiTimerDomains
      : [];
    const normalized = extra
      .map((d) =>
        d && d.key
          ? {
              key: String(d.key),
              label: d.label || String(d.key),
            }
          : null
      )
      .filter(Boolean);
    const existingKeys = new Set(INITIAL_DOMAIN_OPTIONS.map((d) => d.key));
    const merged = [
      ...INITIAL_DOMAIN_OPTIONS,
      ...normalized.filter((d) => !existingKeys.has(d.key)),
    ];
    return merged;
  } catch {
    return INITIAL_DOMAIN_OPTIONS;
  }
}

/****************************** Multi-timer page ******************************/

export default function MultiTimerPage() {
  const [domainOptions] = useState(() => getDomainOptions());

  // Optional context injection from other SSA modules (e.g., SessionRunner)
  const [sessionContext] = useState(() => {
    try {
      return window?.sukaMultiTimerContext || null;
    } catch {
      return null;
    }
  });

  const [timers, setTimers] = useState(() => {
    try {
      const raw = localStorage.getItem("suka:tools:multiTimer:state");
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed?.timers) ? parsed.timers : [];
    } catch {
      return [];
    }
  });
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);
  const [domain, setDomain] = useState(
    sessionContext?.domain &&
      getDomainOptions().some((d) => d.key === sessionContext.domain)
      ? sessionContext.domain
      : "cooking"
  );
  const [sessionId, setSessionId] = useState(sessionContext?.sessionId || "");
  const [autoStart, setAutoStart] = useState(false);

  const tickRef = useRef(null);
  const lastTickRef = useRef(null);

  // Persist to localStorage whenever timers change.
  useEffect(() => {
    try {
      const payload = {
        timers,
        sessionId: sessionId || null,
        domain,
      };
      localStorage.setItem(
        "suka:tools:multiTimer:state",
        JSON.stringify(payload)
      );
    } catch {
      // ignore
    }
  }, [timers, sessionId, domain]);

  // Emit page-open event
  useEffect(() => {
    emitTimerEvent("tools.multiTimer.opened", {
      timerCount: timers.length,
      sessionContext: sessionContext
        ? { sessionId: sessionContext.sessionId || null }
        : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global ticking loop (single interval driving all timers)
  useEffect(() => {
    const hasRunning = timers.some((t) => t.status === "running");
    if (!hasRunning) {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
        lastTickRef.current = null;
      }
      return;
    }

    if (!tickRef.current) {
      lastTickRef.current = Date.now();
      tickRef.current = setInterval(() => {
        const now = Date.now();
        const dt = now - (lastTickRef.current || now);
        lastTickRef.current = now;

        setTimers((current) => {
          let changed = false;
          const next = current.map((t) => {
            if (t.status !== "running") return t;
            const newRemaining = Math.max(0, t.remainingMs - dt);
            if (newRemaining === t.remainingMs) return t;

            changed = true;
            if (newRemaining === 0) {
              // Timer completed
              emitTimerEvent("tools.multiTimer.timerCompleted", {
                id: t.id,
                label: t.label,
                totalMs: t.totalMs,
                domain: t.domain,
                sessionId: t.sessionId || null,
              });
              return {
                ...t,
                remainingMs: 0,
                status: "done",
                updatedAt: nowIso(),
              };
            }

            return { ...t, remainingMs: newRemaining, updatedAt: nowIso() };
          });

          return changed ? next : current;
        });
      }, 250);
    }

    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
        lastTickRef.current = null;
      }
    };
  }, [timers]);

  function createTimer() {
    const totalMs = msFromMinSec(minutes, seconds);
    if (!totalMs) return;
    const trimmedLabel = (label || "").trim() || "Timer";
    const id = `mt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = nowIso();

    const timer = {
      id,
      label: trimmedLabel,
      totalMs,
      remainingMs: totalMs,
      status: autoStart ? "running" : "idle", // idle | running | paused | done
      domain,
      sessionId: sessionId || null,
      createdAt: now,
      updatedAt: now,
    };

    setTimers((prev) => [...prev, timer]);

    emitTimerEvent("tools.multiTimer.timerCreated", {
      id,
      label: trimmedLabel,
      totalMs,
      domain,
      sessionId: sessionId || null,
      autoStart,
    });
  }

  function startTimer(id) {
    setTimers((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (t.status === "running") return t;
        emitTimerEvent("tools.multiTimer.timerStarted", {
          id: t.id,
          label: t.label,
          remainingMs: t.remainingMs,
          domain: t.domain,
          sessionId: t.sessionId || null,
        });
        return {
          ...t,
          status: "running",
          updatedAt: nowIso(),
        };
      })
    );
  }

  function pauseTimer(id) {
    setTimers((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (t.status !== "running") return t;
        emitTimerEvent("tools.multiTimer.timerPaused", {
          id: t.id,
          label: t.label,
          remainingMs: t.remainingMs,
          domain: t.domain,
          sessionId: t.sessionId || null,
        });
        return {
          ...t,
          status: "paused",
          updatedAt: nowIso(),
        };
      })
    );
  }

  function resetTimer(id) {
    setTimers((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        emitTimerEvent("tools.multiTimer.timerReset", {
          id: t.id,
          label: t.label,
          totalMs: t.totalMs,
          domain: t.domain,
          sessionId: t.sessionId || null,
        });
        return {
          ...t,
          remainingMs: t.totalMs,
          status: "idle",
          updatedAt: nowIso(),
        };
      })
    );
  }

  function deleteTimer(id) {
    setTimers((prev) => {
      const toDelete = prev.find((t) => t.id === id);
      if (toDelete) {
        emitTimerEvent("tools.multiTimer.timerDeleted", {
          id: toDelete.id,
          label: toDelete.label,
          domain: toDelete.domain,
          sessionId: toDelete.sessionId || null,
        });
      }
      return prev.filter((t) => t.id !== id);
    });
  }

  function startAll() {
    setTimers((prev) => {
      const next = prev.map((t) =>
        t.status === "done"
          ? t
          : {
              ...t,
              status: "running",
              updatedAt: nowIso(),
            }
      );
      emitTimerEvent("tools.multiTimer.allStarted", {
        count: next.length,
      });
      return next;
    });
  }

  function pauseAll() {
    setTimers((prev) => {
      const next = prev.map((t) =>
        t.status === "running"
          ? {
              ...t,
              status: "paused",
              updatedAt: nowIso(),
            }
          : t
      );
      emitTimerEvent("tools.multiTimer.allPaused", {
        count: next.length,
      });
      return next;
    });
  }

  function clearFinished() {
    setTimers((prev) => {
      const remaining = prev.filter((t) => t.status !== "done");
      const removed = prev.length - remaining.length;
      if (removed > 0) {
        emitTimerEvent("tools.multiTimer.finishedCleared", {
          removedCount: removed,
          remainingCount: remaining.length,
        });
      }
      return remaining;
    });
  }

  function clearAll() {
    const count = timers.length;
    setTimers([]);
    if (count > 0) {
      emitTimerEvent("tools.multiTimer.allCleared", {
        removedCount: count,
      });
    }
  }

  const stats = useMemo(() => {
    const total = timers.length;
    const running = timers.filter((t) => t.status === "running").length;
    const done = timers.filter((t) => t.status === "done").length;
    return { total, running, done };
  }, [timers]);

  const disableCreate = msFromMinSec(minutes, seconds) <= 0;

  return (
    <div className="space-y-6 p-4 max-w-5xl mx-auto">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Multi-Timer</h1>
          <p className="text-sm text-slate-600 max-w-xl">
            Run multiple named timers for cooking, cleaning, garden,
            preservation, and more. Timers are tagged by domain so SSA can
            connect them to sessions later.
          </p>
          {sessionContext?.sessionId && (
            <div className="mt-1 text-xs text-slate-500">
              Linked to session:{" "}
              <span className="font-semibold">{sessionContext.sessionId}</span>
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1 text-sm text-slate-600">
          <div>
            Total timers: <span className="font-semibold">{stats.total}</span>
          </div>
          <div>
            Running: <span className="font-semibold">{stats.running}</span>
          </div>
          <div>
            Completed: <span className="font-semibold">{stats.done}</span>
          </div>
          <div className="mt-2 flex gap-2">
            <KeyBtn onClick={startAll} disabled={!timers.length}>
              Start All
            </KeyBtn>
            <KeyBtn onClick={pauseAll} disabled={!timers.length}>
              Pause All
            </KeyBtn>
          </div>
        </div>
      </header>

      {/* Create timer */}
      <section className={card}>
        <div className="font-semibold mb-2">Add a Timer</div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_auto] items-end">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Label
            </label>
            <Input
              placeholder="e.g. Simmer sauce, Mop hallway, Rotate trays"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Duration
            </label>
            <div className="flex items-center gap-2">
              <SmallInput
                type="number"
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(clampNum(e.target.value))}
                className="w-20"
              />
              <span className="text-sm text-slate-600">min</span>
              <SmallInput
                type="number"
                inputMode="numeric"
                value={seconds}
                onChange={(e) => setSeconds(clampNum(e.target.value))}
                className="w-20"
              />
              <span className="text-sm text-slate-600">sec</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setMinutes(5);
                  setSeconds(0);
                }}
              >
                5:00
              </button>
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setMinutes(10);
                  setSeconds(0);
                }}
              >
                10:00
              </button>
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setMinutes(25);
                  setSeconds(0);
                }}
              >
                25:00
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Domain
              </label>
              <select
                className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-indigo-400 w-full"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              >
                {domainOptions.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Session ID (optional)
              </label>
              <Input
                placeholder="Link to SSA session (e.g. cook-2025-01-01-01)"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
              />
              Start immediately after adding
            </label>
          </div>
          <div className="flex justify-end">
            <KeyBtn onClick={createTimer} disabled={disableCreate}>
              Add Timer
            </KeyBtn>
          </div>
        </div>
      </section>

      {/* Timers list */}
      <section className={cardSoft}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold">Active Timers</h2>
          <div className="flex gap-2">
            <KeyBtn
              onClick={clearFinished}
              disabled={!timers.some((t) => t.status === "done")}
            >
              Clear Finished
            </KeyBtn>
            <KeyBtn onClick={clearAll} disabled={!timers.length}>
              Clear All
            </KeyBtn>
          </div>
        </div>

        {timers.length === 0 ? (
          <div className="text-sm text-slate-500">
            No timers yet. Add timers for each step of your cooking, cleaning,
            garden, or preservation session. You can link them to SSA sessions
            using the Session ID field.
          </div>
        ) : (
          <ul className="space-y-3">
            {timers.map((t) => {
              const timeLabel = formatHMS(t.remainingMs);
              const isRunning = t.status === "running";
              const isDone = t.status === "done";
              const { m, s } = minSecFromMs(t.totalMs);
              return (
                <li
                  key={t.id}
                  className="flex flex-col md:flex-row md:items-center gap-3 rounded-2xl border bg-white p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700"
                        title={t.domain}
                      >
                        {t.domain}
                      </span>
                      {t.sessionId && (
                        <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[0.7rem] text-indigo-700">
                          {t.sessionId}
                        </span>
                      )}
                    </div>
                    <div
                      className="mt-1 font-semibold text-slate-900 truncate"
                      title={t.label}
                    >
                      {t.label}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Original duration: {String(m).padStart(2, "0")}:
                      {String(s).padStart(2, "0")}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-2xl font-mono font-bold tabular-nums">
                      {timeLabel}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!isDone && !isRunning && (
                        <KeyBtn
                          onClick={() => startTimer(t.id)}
                          className="text-sm"
                          title="Start"
                        >
                          Start
                        </KeyBtn>
                      )}
                      {isRunning && (
                        <KeyBtn
                          onClick={() => pauseTimer(t.id)}
                          className="text-sm"
                          title="Pause"
                        >
                          Pause
                        </KeyBtn>
                      )}
                      {isDone && (
                        <span className="text-xs font-semibold text-emerald-700">
                          Done
                        </span>
                      )}
                      <KeyBtn
                        onClick={() => resetTimer(t.id)}
                        className="text-xs"
                        title="Reset"
                      >
                        Reset
                      </KeyBtn>
                      <KeyBtn
                        onClick={() => deleteTimer(t.id)}
                        className="text-xs"
                        title="Delete"
                      >
                        Delete
                      </KeyBtn>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Notes / Forward integration */}
      <section className={card}>
        <div className="font-semibold mb-1">How this ties into SSA</div>
        <p className="text-xs text-slate-600">
          This Multi-Timer tool is part of SSA&apos;s &quot;intelligence&quot;
          layer for live sessions. It doesn&apos;t change inventory or
          storehouse directly, but it emits events on the SSA eventBus ({'"'}
          tools.multiTimer.*{'"'}) so AutomationRuntime, SessionRunner, or
          Analytics can:
        </p>
        <ul className="mt-1 list-disc pl-5 text-xs text-slate-600 space-y-1">
          <li>
            Attach timers to cooking/cleaning/preservation sessions using the
            Session ID field.
          </li>
          <li>
            Record step durations for later optimization (e.g., better
            batch-cooking timelines).
          </li>
          <li>
            In future, log completed timers as session evidence and optionally
            export summaries to the Hub when timers represent real household
            work.
          </li>
        </ul>
      </section>
    </div>
  );
}
