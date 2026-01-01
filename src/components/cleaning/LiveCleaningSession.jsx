// src/components/cleaning/LiveCleaningSession.jsx

import React, { useEffect, useMemo, useRef, useState } from "react";
import useSound from "use-sound";
import {
  Play, Pause, Check, Volume2, ChevronRight, ChevronLeft,
  ListChecks, Filter, Info, Clock, Target, BadgeCheck
} from "lucide-react";

/**
 * Props:
 *  - plan: {
 *      id, title, routineType ("Standard"|"Deep"), zones: string[],
 *      tasks: Array<{ id, name, zone, estMinutes, cadence, focus?:string[], deepClean?:boolean, notes?:string }>
 *    }
 *  - onTaskDone?: ({ planId, taskId, durationSec }) => void (optional)
 */
export default function LiveCleaningSession({ plan, onTaskDone }) {
  const [currentZone, setCurrentZone] = useState(plan?.zones?.[0] || "General");
  const [focusFilter, setFocusFilter] = useState("all"); // all | declutter | detail | outflow
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds
  const [completed, setCompleted] = useState(() => new Set());
  const [showHelper, setShowHelper] = useState(false);
  const [playSound] = useSound("/audio/step.mp3", { volume: 0.45 });
  const tickId = useRef(null);

  const routineType = plan?.routineType || "Standard";
  const isDeep = routineType === "Deep";

  // ---- Derived: tasks by zone + filtered list ----
  const tasksByZone = useMemo(() => {
    const rec = {};
    (plan?.tasks || []).forEach((t) => {
      const z = t.zone || "General";
      if (!rec[z]) rec[z] = [];
      rec[z].push(t);
    });
    // stable ordering: declutter first in Deep sessions, else as-is
    Object.keys(rec).forEach((z) => {
      rec[z].sort((a, b) => {
        const af = a.focus || [];
        const bf = b.focus || [];
        const aDecl = af.includes("declutter") ? 0 : 1;
        const bDecl = bf.includes("declutter") ? 0 : 1;
        return isDeep ? aDecl - bDecl : 0;
      });
    });
    return rec;
  }, [plan?.tasks, isDeep]);

  const zones = useMemo(() => plan?.zones?.length ? plan.zones : Object.keys(tasksByZone), [plan?.zones, tasksByZone]);

  const filteredTasks = useMemo(() => {
    const list = tasksByZone[currentZone] || [];
    if (focusFilter === "all") return list;
    return list.filter((t) => (t.focus || []).includes(focusFilter));
  }, [tasksByZone, currentZone, focusFilter]);

  const currentTask = filteredTasks[currentIndex];

  // ---- Timers ----
  useEffect(() => {
    if (isRunning) {
      tickId.current = setInterval(() => setElapsed((e) => e + 1), 1000);
      return () => clearInterval(tickId.current);
    } else {
      clearInterval(tickId.current);
    }
  }, [isRunning]);

  // Reset timer when task changes
  useEffect(() => {
    setElapsed(0);
  }, [currentIndex, currentZone, focusFilter]);

  // ---- Speech ----
  const readAloud = () => {
    if (!currentTask) return;
    const text = `${currentTask.name}. ${isDeep && (currentTask.focus || []).includes("declutter") ? "Use five-bin rule: Keep, Relocate, Donate, Recycle, Trash." : ""}`;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      window.speechSynthesis?.speak(u);
    } catch {}
  };

  // ---- Navigation ----
  const gotoNext = () => {
    playSound();
    setIsRunning(false);
    // advance within filtered
    if (currentIndex + 1 < filteredTasks.length) {
      setCurrentIndex((i) => i + 1);
    } else {
      // next zone with tasks
      const zi = zones.indexOf(currentZone);
      for (let step = 1; step <= zones.length; step++) {
        const nextZ = zones[(zi + step) % zones.length];
        const has = (tasksByZone[nextZ] || []).length > 0;
        if (has) {
          setCurrentZone(nextZ);
          setCurrentIndex(0);
          break;
        }
      }
    }
  };

  const gotoPrev = () => {
    playSound();
    setIsRunning(false);
    if (currentIndex > 0) {
      setCurrentIndex((i) => Math.max(0, i - 1));
      return;
    }
    // previous zone last task
    const zi = zones.indexOf(currentZone);
    const prevZ = zones[(zi - 1 + zones.length) % zones.length];
    const prevList = tasksByZone[prevZ] || [];
    if (prevList.length) {
      setCurrentZone(prevZ);
      setCurrentIndex(Math.max(0, prevList.length - 1));
    }
  };

  // ---- Complete ----
  const markComplete = () => {
    if (!currentTask) return;
    const key = currentTask.id;
    if (!completed.has(key)) {
      const next = new Set(completed);
      next.add(key);
      setCompleted(next);
    }
    // notify manager if provided
    try {
      onTaskDone?.({ planId: plan?.id, taskId: currentTask.id, durationSec: elapsed });
    } catch {}
    gotoNext();
  };

  // ---- Session KPIs ----
  const totalMinutes = useMemo(
    () => (plan?.tasks || []).reduce((s, t) => s + (Number(t.estMinutes) || 0), 0),
    [plan?.tasks]
  );
  const doneMinutes = useMemo(() => {
    const map = new Map((plan?.tasks || []).map((t) => [t.id, t]));
    let sum = 0;
    completed.forEach((id) => (sum += Number(map.get(id)?.estMinutes || 0)));
    return sum;
  }, [completed, plan?.tasks]);
  const etaMinutes = Math.max(0, totalMinutes - doneMinutes - Math.round(elapsed / 60));
  const pct = totalMinutes > 0 ? Math.min(100, Math.round((doneMinutes / totalMinutes) * 100)) : 0;

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === " ") { e.preventDefault(); setIsRunning((r) => !r); }
      if (e.key === "Enter") { e.preventDefault(); markComplete(); }
      if (e.key === "ArrowRight") { e.preventDefault(); gotoNext(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); gotoPrev(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [markComplete, gotoNext, gotoPrev]);

  // ---- Helpers ----
  const fmtClock = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const r = (s % 60).toString().padStart(2, "0");
    return `${m}:${r}`;
  };

  return (
    <div className="p-6 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold text-green-700">🧽 Live Cleaning Walkthrough</h2>
          <p className="text-sm text-stone-500">{plan?.title || "Session"}</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold ${
              isDeep ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"
            }`}
            title="Routine Type"
          >
            <BadgeCheck size={14} />
            {routineType === "Deep" ? "Deep Clean" : "Standard"}
          </span>
          <button
            onClick={() => setShowHelper((v) => !v)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-stone-300 hover:bg-stone-100"
            title="Show 5-bin + rules helper"
          >
            <Info size={14} /> Helper
          </button>
        </div>
      </div>

      {/* Deep banner */}
      {isDeep && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
          <p className="text-sm">
            <strong>Clutter-first:</strong> map landing zones, apply the 5-bin rule, and follow "one-touch" + "like with like" + "label & limit."
            Morning outflow tips are prioritized if present.
          </p>
        </div>
      )}

      {/* Session meta */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className="rounded-lg border p-3 bg-white">
          <div className="text-xs text-stone-500">Progress</div>
          <div className="mt-1 h-2 rounded bg-stone-200">
            <div className="h-2 rounded bg-green-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-xs text-stone-600">{pct}% complete</div>
        </div>
        <div className="rounded-lg border p-3 bg-white">
          <div className="text-xs text-stone-500">Session ETA</div>
          <div className="mt-1 font-semibold text-stone-800 flex items-center gap-1">
            <Clock size={14} /> ~{etaMinutes} min remaining
          </div>
        </div>
        <div className="rounded-lg border p-3 bg-white">
          <div className="text-xs text-stone-500">Zone</div>
          <select
            value={currentZone}
            onChange={(e) => { setCurrentZone(e.target.value); setCurrentIndex(0); }}
            className="mt-1 w-full rounded border px-2 py-1"
          >
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="inline-flex items-center gap-1 text-stone-600 text-sm"><Filter size={14}/> Focus</span>
        {["all", "declutter", "detail", "outflow"].map((f) => (
          <button
            key={f}
            onClick={() => { setFocusFilter(f); setCurrentIndex(0); }}
            className={`px-3 py-1.5 rounded-full text-sm border ${
              focusFilter === f ? "bg-stone-900 text-white border-stone-900" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-100"
            }`}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Current task card */}
      <div className="bg-white border rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-green-700">
            {currentTask ? currentTask.zone : currentZone}
          </h3>
          <div className="flex items-center gap-2">
            <button onClick={readAloud} className="text-green-700 hover:text-green-900" title="Read aloud">
              <Volume2 size={18} />
            </button>
          </div>
        </div>

        <div className="text-[17px] font-medium">
          {currentTask?.name || "No task in this filter"}
        </div>

        {/* Guidance row */}
        <div className="text-sm text-stone-600 flex flex-wrap items-center gap-2">
          {isDeep && (currentTask?.focus || []).includes("declutter") && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-100 text-amber-800" title="Declutter first">
              <Target size={14}/> 5-bin first
            </span>
          )}
          {currentTask?.cadence && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-sky-100 text-sky-800">
              <ListChecks size={14}/> {currentTask.cadence}
            </span>
          )}
          {currentTask?.deepClean && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-100 text-emerald-800">
              Deep detail
            </span>
          )}
        </div>

        {/* Timer + controls */}
        <div className="flex items-center gap-3">
          <div className="text-2xl font-mono bg-stone-100 px-4 py-2 rounded">
            ⏱ {fmtClock(elapsed)}
          </div>
          <button
            onClick={() => setIsRunning((v) => !v)}
            className={`px-4 py-2 rounded text-white ${isRunning ? "bg-yellow-600 hover:bg-yellow-700" : "bg-green-600 hover:bg-green-700"}`}
            title={isRunning ? "Pause (Space)" : "Start (Space)"}
          >
            {isRunning ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button
            onClick={markComplete}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded"
            title="Mark complete (Enter)"
          >
            <Check size={16} className="inline-block mr-1" />
            Done
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={gotoPrev} className="px-3 py-2 rounded border hover:bg-stone-100" title="Previous (←)">
              <ChevronLeft size={16}/>
            </button>
            <button onClick={gotoNext} className="px-3 py-2 rounded border hover:bg-stone-100" title="Next (→)">
              <ChevronRight size={16}/>
            </button>
          </div>
        </div>

        {/* Completed list (per session) */}
        <div className="mt-4">
          <h4 className="text-sm font-semibold mb-2 text-stone-700">✅ Completed This Session</h4>
          {completed.size === 0 ? (
            <p className="text-sm text-stone-500">Nothing checked off yet.</p>
          ) : (
            <ul className="list-disc list-inside text-stone-600 space-y-1">
              {[...completed].map((id) => {
                const t = (plan?.tasks || []).find((x) => x.id === id);
                return <li key={id}>{t?.name || id}</li>;
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Helper drawer-like card */}
      {showHelper && (
        <div className="mt-4 rounded-xl border p-4 bg-white">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-stone-800">Clutter-first Helper</h4>
            <button onClick={() => setShowHelper(false)} className="text-stone-500 hover:text-stone-800">Close</button>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 mt-3 text-sm text-stone-700">
            <div className="rounded border p-3">
              <div className="font-semibold mb-1">5-Bin Rule</div>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>Keep</strong> (store here)</li>
                <li><strong>Relocate</strong> (right zone)</li>
                <li><strong>Donate</strong></li>
                <li><strong>Recycle</strong></li>
                <li><strong>Trash</strong></li>
              </ul>
            </div>
            <div className="rounded border p-3">
              <div className="font-semibold mb-1">Behavior Rules</div>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>One-touch:</strong> don’t set items down mid-path.</li>
                <li><strong>Like with like:</strong> group and label.</li>
                <li><strong>Label & limit:</strong> the container defines the quantity.</li>
              </ul>
            </div>
            <div className="rounded border p-3">
              <div className="font-semibold mb-1">Landing Zones</div>
              <ul className="list-disc list-inside space-y-1">
                <li>Hooks at eye/hand level</li>
                <li>Bowl for keys; tray for mail</li>
                <li>Charging shelf near entry</li>
                <li>Labeled shoe baskets</li>
              </ul>
            </div>
            <div className="rounded border p-3">
              <div className="font-semibold mb-1">Morning Outflow</div>
              <ul className="list-disc list-inside space-y-1">
                <li>Make beds first</li>
                <li>Reset vanity; squeegee glass</li>
                <li>Unload dishwasher with coffee</li>
                <li>Stage grab-zone: wallet/ID, meds, bottle, laptop, chargers</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Empty state for filter/zone combos */}
      {!currentTask && (
        <div className="mt-4 text-sm text-stone-500">
          No tasks in <strong>{currentZone}</strong> with filter <code>{focusFilter}</code>. Try switching focus or zone.
        </div>
      )}
    </div>
  );
}
