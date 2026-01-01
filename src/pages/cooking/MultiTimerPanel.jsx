// src/pages/cooking/MultiTimerPanel.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { automation } from "@/services/automation/runtime";

const STATION_COLORS = {
  Prep: "bg-emerald-50 text-emerald-900 border-emerald-200",
  Stove: "bg-amber-50 text-amber-900 border-amber-200",
  Oven: "bg-rose-50 text-rose-900 border-rose-200",
  Canning: "bg-indigo-50 text-indigo-900 border-indigo-200",
  Dehydrate: "bg-cyan-50 text-cyan-900 border-cyan-200",
  Label: "bg-slate-50 text-slate-900 border-slate-200",
  default: "bg-gray-50 text-gray-900 border-gray-200",
};

const pad = (n) => String(n).padStart(2, "0");
const fmt = (secs) => {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
};

function usePersistedState(key, initial) {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return typeof initial === "function" ? initial() : initial;
      return JSON.parse(raw);
    } catch {
      return typeof initial === "function" ? initial() : initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
  }, [key, state]);
  return [state, setState];
}

function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { Notification.requestPermission(); } catch {}
  }
}

function speak(text) {
  try {
    if (!("speechSynthesis" in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1;
    utter.pitch = 1;
    window.speechSynthesis.speak(utter);
  } catch {}
}

function chime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    o.start();
    o.stop(ctx.currentTime + 0.45);
  } catch {}
}

function notify({ title, body }) {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") new Notification(title, { body });
  } catch {}
}

/** map draft timers → UI model */
function normalizeFromDraft(draft) {
  const timers = Array.isArray(draft?.timers) ? draft.timers : [];
  return timers.map((t) => ({
    id: t.id,
    label: t.label || "Timer",
    station: t.station || null,
    stepId: t.stepId || null,
    original: Number(t.seconds || 0),
    remaining: Number(t.seconds || 0),
    running: false,
    startedAt: null,
    pausedAt: null,
    voice: t.voiceAlerts !== false, // default true
    fromDraft: true,
  }));
}

function stationClass(station) {
  return STATION_COLORS[station] || STATION_COLORS.default;
}

/* ---------------------------- Single Timer Row ---------------------------- */
function TimerRow({ timer, onChange, onRemove, onOpenStep }) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef(null);

  const toggle = () => {
    const running = !timer.running;
    const patch = running
      ? { running, startedAt: Date.now(), pausedAt: null }
      : { running, pausedAt: Date.now() };
    onChange(timer.id, patch, running ? "start" : "pause");
  };

  const reset = () => {
    onChange(timer.id, { remaining: timer.original, running: false, startedAt: null, pausedAt: null }, "reset");
  };

  const bump = (delta) => {
    const next = Math.max(0, Math.floor(timer.remaining + delta));
    onChange(timer.id, { remaining: next, original: Math.max(timer.original, next) }, "bump");
  };

  const saveEdit = () => {
    const v = inputRef.current?.value || "";
    const parts = v.split(":").map((n) => parseInt(n, 10));
    let secs = 0;
    if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) secs = parts[0] * 60 + parts[1];
    else secs = parseInt(v, 10) || timer.original;
    secs = Math.max(0, secs);
    onChange(timer.id, { original: secs, remaining: secs }, "edit");
    setEditing(false);
  };

  return (
    <div className={`p-3 border rounded-xl flex flex-col gap-2 ${stationClass(timer.station)}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {timer.station && (
            <span className="px-2 py-0.5 text-xs rounded-full border">{timer.station}</span>
          )}
          <div className="font-semibold text-sm">{timer.label}</div>
          {timer.stepId ? (
            <button
              className="text-xs text-blue-700 underline underline-offset-2"
              onClick={() => onOpenStep?.(timer.stepId)}
            >
              step
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`px-2 py-1 rounded-lg text-xs font-medium ${timer.running ? "bg-gray-900 text-white" : "bg-white border"}`}
            onClick={toggle}
            title={timer.running ? "Pause (Space)" : "Start (Space)"}
          >
            {timer.running ? "Pause" : "Start"}
          </button>
          <button className="px-2 py-1 rounded-lg text-xs border bg-white" onClick={() => bump(30)} title="+30 seconds">+30s</button>
          <button className="px-2 py-1 rounded-lg text-xs border bg-white" onClick={() => bump(60)} title="+1 minute">+1m</button>
          <button className="px-2 py-1 rounded-lg text-xs border bg-white" onClick={() => bump(300)} title="+5 minutes">+5m</button>
          <button className="px-2 py-1 rounded-lg text-xs border bg-white" onClick={reset} title="Reset (R)">Reset</button>
          <button className="px-2 py-1 rounded-lg text-xs border bg-white" onClick={() => onRemove(timer.id)} title="Remove">✕</button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-2xl tabular-nums tracking-tight">{fmt(timer.remaining)}</div>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <input
                ref={inputRef}
                defaultValue={fmt(timer.original)}
                className="px-2 py-1 text-sm border rounded-md w-28"
                onKeyDown={(e) => e.key === "Enter" && saveEdit()}
              />
              <button className="px-2 py-1 rounded-lg text-xs border bg-white" onClick={saveEdit}>Save</button>
              <button className="px-2 py-1 rounded-lg text-xs border bg-white" onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : (
            <>
              <span className="text-xs text-gray-600">orig {fmt(timer.original)}</span>
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!timer.voice}
                  onChange={(e) => onChange(timer.id, { voice: e.target.checked }, "voice")}
                />
                voice
              </label>
              <button className="px-2 py-1 rounded-lg text-xs border bg-white" onClick={() => setEditing(true)}>Edit</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Main Panel ------------------------------- */
export default function MultiTimerPanel({
  draft,                 // cooking session draft (timers/stations/steps)
  onOpenStep,            // (stepId) => void  optional
  className = "",
  storageKeyPrefix = "suka.cooking.timers"
}) {
  const draftId = draft?.id || "no-draft";
  const storageKey = `${storageKeyPrefix}:${draftId}`;

  // initialize timers from draft OR restore persisted
  const [timers, setTimers] = usePersistedState(storageKey, () => {
    const base = normalizeFromDraft(draft);
    // Always at least one ad-hoc timer for quick use
    return base.length ? base : [{
      id: `adhoc_${Date.now()}`,
      label: "Timer",
      station: null,
      stepId: null,
      original: 300,
      remaining: 300,
      running: false,
      startedAt: null,
      pausedAt: null,
      voice: true,
      fromDraft: false,
    }];
  });

  // if the draft id changes, seed from draft again (but keep any running timers from prev draft separate key)
  useEffect(() => {
    setTimers((prev) => {
      // if this is a fresh key (first mount), prev is already from initial; do nothing
      if (!prev || prev.length === 0) return normalizeFromDraft(draft);
      return prev; // keep persisted for this draft key
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // global ticking loop
  const rafRef = useRef(null);
  const lastTsRef = useRef(null);

  const stepMap = useMemo(() => {
    const map = new Map();
    (draft?.steps || []).forEach((s) => map.set(s.id, s));
    return map;
  }, [draft]);

  const stationsSet = useMemo(() => {
    const set = new Set();
    timers.forEach((t) => t.station && set.add(t.station));
    return set;
  }, [timers]);

  const tick = useCallback((ts) => {
    if (!lastTsRef.current) lastTsRef.current = ts;
    const delta = (ts - lastTsRef.current) / 1000; // seconds
    lastTsRef.current = ts;

    setTimers((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (!t.running) return t;
        const rem = t.remaining - delta;
        if (rem > 0) {
          if (Math.floor(rem) !== Math.floor(t.remaining)) changed = true;
          return { ...t, remaining: rem };
        }
        // hit zero
        changed = true;
        const donePatch = { ...t, remaining: 0, running: false, pausedAt: Date.now(), startedAt: null };
        // fire signals
        const stepLabel = t.stepId ? stepMap.get(t.stepId)?.label : null;
        const msg = `${t.label}${t.station ? ` at ${t.station}` : ""} is done${stepLabel ? ` — ${stepLabel}` : ""}`;
        chime();
        if (t.voice) speak(msg);
        notify({ title: "Timer done", body: msg });
        automation.emitEvent("timer.done", { timerId: t.id, label: t.label, station: t.station, stepId: t.stepId });
        return donePatch;
      });
      return changed ? next : prev;
    });

    rafRef.current = requestAnimationFrame(tick);
  }, [setTimers, stepMap]);

  useEffect(() => {
    requestNotificationPermission();
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [tick]);

  // page guard when timers running
  useEffect(() => {
    const anyRunning = timers.some((t) => t.running);
    const beforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    if (anyRunning) {
      window.addEventListener("beforeunload", beforeUnload);
      return () => window.removeEventListener("beforeunload", beforeUnload);
    }
  }, [timers]);

  const changeTimer = (id, patch, reason) => {
    setTimers((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
    );
    if (reason === "start") automation.emitEvent("timer.start", { timerId: id });
    if (reason === "pause") automation.emitEvent("timer.pause", { timerId: id });
    if (reason === "reset") automation.emitEvent("timer.reset", { timerId: id });
  };

  const removeTimer = (id) => {
    setTimers((prev) => prev.filter((t) => t.id !== id));
  };

  const addTimer = (presetSecs = 300) => {
    setTimers((prev) => [
      ...prev,
      {
        id: `adhoc_${Date.now()}`,
        label: "Timer",
        station: null,
        stepId: null,
        original: presetSecs,
        remaining: presetSecs,
        running: false,
        startedAt: null,
        pausedAt: null,
        voice: true,
        fromDraft: false,
      },
    ]);
  };

  const startAll = () => {
    const nowTs = Date.now();
    setTimers((prev) => prev.map((t) => (t.running ? t : { ...t, running: true, startedAt: nowTs, pausedAt: null })));
    automation.emitEvent("timer.start.all", { count: timers.length });
  };
  const pauseAll = () => {
    const ts = Date.now();
    setTimers((prev) => prev.map((t) => (t.running ? { ...t, running: false, pausedAt: ts } : t)));
    automation.emitEvent("timer.pause.all", { count: timers.length });
  };
  const resetAll = () => {
    setTimers((prev) => prev.map((t) => ({ ...t, running: false, remaining: t.original, startedAt: null, pausedAt: null })));
    automation.emitEvent("timer.reset.all", { count: timers.length });
  };

  // keyboard shortcuts for focused panel
  const panelRef = useRef(null);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onKey = (e) => {
      // act on first running or first timer
      const t = timers.find((x) => x.running) || timers[0];
      if (!t) return;
      if (e.key === " ") {
        e.preventDefault();
        changeTimer(t.id, t.running ? { running: false, pausedAt: Date.now() } : { running: true, startedAt: Date.now(), pausedAt: null }, t.running ? "pause" : "start");
      } else if (e.key === "+") {
        e.preventDefault();
        changeTimer(t.id, { remaining: t.remaining + 30, original: Math.max(t.original, t.remaining + 30) }, "bump");
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        changeTimer(t.id, { running: false, remaining: t.original, startedAt: null, pausedAt: null }, "reset");
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [timers]); // eslint-disable-line react-hooks/exhaustive-deps

  // group timers by station for tidy layout
  const grouped = useMemo(() => {
    const map = new Map();
    timers.forEach((t) => {
      const key = t.station || "Unassigned";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(t);
    });
    return Array.from(map.entries());
  }, [timers]);

  return (
    <div ref={panelRef} tabIndex={0} className={`outline-none ${className}`}>
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className="px-3 py-1.5 rounded-lg text-sm bg-gray-900 text-white" onClick={startAll}>Start all</button>
        <button className="px-3 py-1.5 rounded-lg text-sm border bg-white" onClick={pauseAll}>Pause all</button>
        <button className="px-3 py-1.5 rounded-lg text-sm border bg-white" onClick={resetAll}>Reset all</button>

        <div className="ml-auto flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-lg text-sm border bg-white" onClick={() => addTimer(180)}>+3m</button>
          <button className="px-3 py-1.5 rounded-lg text-sm border bg-white" onClick={() => addTimer(300)}>+5m</button>
          <button className="px-3 py-1.5 rounded-lg text-sm border bg-white" onClick={() => addTimer(600)}>+10m</button>
        </div>
      </div>

      {/* Stations */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {grouped.map(([station, items]) => (
          <div key={station} className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{station}</div>
            {items.map((t) => (
              <TimerRow
                key={t.id}
                timer={t}
                onChange={changeTimer}
                onRemove={removeTimer}
                onOpenStep={onOpenStep}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Footer hint */}
      <div className="mt-4 text-xs text-gray-500">
        Shortcuts: <kbd className="px-1 py-0.5 border rounded">Space</kbd> start/pause,{" "}
        <kbd className="px-1 py-0.5 border rounded">+</kbd> +30s,{" "}
        <kbd className="px-1 py-0.5 border rounded">R</kbd> reset. Timers persist per session draft.
      </div>
    </div>
  );
}
