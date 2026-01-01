// src/components/cleaning/CleaningPlanner.jsx
import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import ToolChecklistPanel from "./ToolChecklistPanel";
import SupplyChecklistPanel from "./SupplyChecklistPanel";
import CustomLocationsManager from "./CustomLocationsManager";
import AnimatedProgressBar from "../../ui/AnimatedProgressBar";
import Checklist from "../../ui/Checklist";
import RewardPopup from "../../ui/RewardPopup";
import { CalendarDays, Sparkles, ListChecks, Wrench, Boxes, MapPinned, History, Settings2, RotateCcw } from "lucide-react";
import "../../theme/animations.css";

/* -------------------------------- Lazy Opt-Ins --------------------------------
   These are optional panels that may not exist during early dev.
   We lazy-load and fall back gracefully.
-------------------------------------------------------------------------------- */
const DeepCleanSession = React.lazy(async () => {
  try { return await import("./DeepCleanSession"); }
  catch { return { default: () => <div className="p-3 rounded-xl border bg-slate-50 text-sm">Deep Clean builder unavailable.</div> }; }
});
const ZoneGroupPanel = React.lazy(async () => {
  try { return await import("./ZoneGroupPanel"); }
  catch { return { default: () => <div className="p-3 rounded-xl border bg-slate-50 text-sm">Zone manager unavailable.</div> }; }
});

/* -------------------------------- Safe Shims --------------------------------- */
let bus = { emit: () => {}, on: () => () => {}, invoke: async () => {} };
let automation = { queue: () => {}, invoke: async () => {} };
try { ({ eventBus: bus } = require("@/services/events/eventBus")); } catch {}
try { ({ automation } = require("@/services/automation/runtime")); } catch {}

/* -------------------------------- Helpers ------------------------------------ */
const STORAGE_TASKS = "cleaning.tasks.v2";
const STORAGE_DONE = "cleaning.done.v2";
const STORAGE_TAB = "cleaning.activeTab.v1";
const STORAGE_UNDO = "cleaning.undo.v1";

const uid = (p = "t") => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const clamp = (n, min, max) => Math.min(Math.max(Number(n) || 0, min), max);
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);
const iso = () => new Date().toISOString();

function isSabbath(dateObj = new Date(), { saturdayAsSabbath = false, hebrewDayOfWeek } = {}) {
  if (saturdayAsSabbath) return dateObj.getDay() === 6;
  if (typeof hebrewDayOfWeek === "function") return hebrewDayOfWeek(dateObj) === 7;
  return dateObj.getDay() === 6;
}

/* -------------------------- Seed / Suggested Tasks --------------------------- */
function defaultTasksSeed() {
  return [
    { id: uid(), title: "Wipe kitchen counters", zone: "Kitchen", estMin: 8, priority: 1 },
    { id: uid(), title: "Sweep living room", zone: "Living Room", estMin: 7, priority: 0 },
    { id: uid(), title: "Disinfect bathroom surfaces", zone: "Bathrooms", estMin: 12, priority: 2 },
    { id: uid(), title: "Organize pantry (fast pass)", zone: "Kitchen", estMin: 10, priority: 1 },
  ];
}

/* -------------------------------- Component ---------------------------------- */
export default function CleaningPlanner() {
  const [activeTab, setActiveTab] = useState(() => {
    try { return localStorage.getItem(STORAGE_TAB) || "checklist"; } catch { return "checklist"; }
  });

  const [tasks, setTasks] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_TASKS);
      return raw ? JSON.parse(raw) : defaultTasksSeed();
    } catch { return defaultTasksSeed(); }
  });

  const [done, setDone] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_DONE);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });

  const [showReward, setShowReward] = useState(false);
  const [sessionMinutes, setSessionMinutes] = useState(60);
  const [voiceAlerts, setVoiceAlerts] = useState(true);
  const [energy, setEnergy] = useState("moderate");
  const [undoStack, setUndoStack] = useState([]);
  const lastAction = useRef(null);

  /* ------------------------------- Persistence ------------------------------- */
  useEffect(() => { try { localStorage.setItem(STORAGE_TAB, activeTab); } catch {} }, [activeTab]);
  useEffect(() => { try { localStorage.setItem(STORAGE_TASKS, JSON.stringify(tasks)); } catch {} }, [tasks]);
  useEffect(() => { try { localStorage.setItem(STORAGE_DONE, JSON.stringify([...done])); } catch {} }, [done]);

  /* ------------------------------- Event Wiring ------------------------------ */
  // Accept a routine draft from ZoneGroupPanel: {zones:[...], focusIds:[...]}
  useEffect(() => {
    const off1 = bus.on?.("cleaning/routineDraft", (draft) => {
      try {
        if (!draft?.zones?.length) return;
        // Generate a simple plan from zones, emphasizing focus zones first
        const focusSet = new Set(draft.focusIds || []);
        const next = [];
        draft.zones.forEach((z) => {
          const pr = typeof z.priority === "number" ? z.priority : 0;
          // Two representative tasks per zone (could be made smarter later)
          const base = focusSet.has(z.id) || pr > 0 ? 2 : 1;
          for (let i = 0; i < base; i++) {
            next.push({
              id: uid(),
              title: `${i === 0 ? "Detail" : "Reset"} — ${z.name}`,
              zone: z.name,
              estMin: i === 0 ? 15 : 10,
              priority: pr,
            });
          }
        });
        pushUndo();
        setTasks((prev) => [...next]); // replace session list with draft
        setDone(new Set());
        setActiveTab("checklist");
        toast("Routine draft loaded", "info");
      } catch {}
    });

    // Accept deep-clean plan from DeepCleanSession via onPlanned or bus.emit
    const off2 = bus.on?.("deepclean/planBuilt", (payload) => {
      if (!payload?.plan?.sections) return;
      const generated = payload.plan.sections.flatMap((s) =>
        (s.tasks || []).map((t) => ({
          id: t.id || uid(),
          title: `${t.name} — ${s.title}`,
          zone: s.title || "Zone",
          estMin: t.estMin || 10,
          priority: payload.plan.sabbathSkipped ? -1 : 2,
        }))
      );
      pushUndo();
      setTasks(generated);
      setDone(new Set());
      setActiveTab("checklist");
      toast("Deep Clean plan loaded", "success");
    });

    return () => { try { off1?.(); off2?.(); } catch {} };
  }, []);

  /* ------------------------------- Progress ---------------------------------- */
  const completedCount = useMemo(() => tasks.reduce((a, t) => a + (done.has(t.id) ? 1 : 0), 0), [tasks, done]);
  const progress = useMemo(() => (tasks.length ? (completedCount / tasks.length) * 100 : 0), [completedCount, tasks]);
  useEffect(() => {
    if (tasks.length > 0 && completedCount === tasks.length) {
      const timer = setTimeout(() => setShowReward(true), 400);
      return () => clearTimeout(timer);
    }
  }, [completedCount, tasks.length]);

  /* ------------------------------- Next-Best-Action -------------------------- */
  const nba = useMemo(() => {
    const remaining = tasks.filter((t) => !done.has(t.id));
    if (!remaining.length) return null;
    // Highest priority + shortest time to get quick wins (or long if energy is high)
    const sorted = [...remaining].sort((a, b) => {
      const p = (b.priority || 0) - (a.priority || 0);
      if (p !== 0) return p;
      if (energy === "high") return (b.estMin || 0) - (a.estMin || 0);
      return (a.estMin || 0) - (b.estMin || 0);
    });
    return sorted[0];
  }, [tasks, done, energy]);

  /* --------------------------------- Undo ------------------------------------ */
  const pushUndo = () => {
    try {
      const snap = { tasks, done: [...done] };
      setUndoStack((prev) => {
        const next = [...prev, snap].slice(-15);
        localStorage.setItem(STORAGE_UNDO, JSON.stringify(next));
        return next;
      });
    } catch {}
  };
  const handleUndo = () => {
    try {
      const raw = localStorage.getItem(STORAGE_UNDO);
      const stack = raw ? JSON.parse(raw) : undoStack;
      if (!stack?.length) return;
      const prev = stack[stack.length - 1];
      setUndoStack(stack.slice(0, -1));
      localStorage.setItem(STORAGE_UNDO, JSON.stringify(stack.slice(0, -1)));
      setTasks(prev.tasks);
      setDone(new Set(prev.done));
      toast("Undid last change", "info");
    } catch {}
  };

  /* ----------------------- Keyboard Shortcuts (Save/Undo) -------------------- */
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); handleUndo(); }
      if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); doSave(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, done]);

  /* -------------------------------- Actions ---------------------------------- */
  const toggleTask = (taskIdOrTitle) => {
    const id = typeof taskIdOrTitle === "string" ? (tasks.find(t => t.title === taskIdOrTitle)?.id || taskIdOrTitle) : taskIdOrTitle;
    setDone((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const addQuickTask = (title, zone = "General", estMin = 8, priority = 0) => {
    pushUndo();
    setTasks((prev) => [...prev, { id: uid(), title, zone, estMin, priority }]);
  };

  const clearSession = () => {
    pushUndo();
    setTasks([]);
    setDone(new Set());
  };

  const sendToTaskBoard = async () => {
    const payload = {
      source: "CleaningPlanner",
      createdAt: iso(),
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        labels: ["cleaning"],
        zone: t.zone,
        estMin: t.estMin || 10,
        done: done.has(t.id),
      })),
      voiceAlerts,
    };
    try {
      bus.emit?.("tasks/createBatch", payload);
      await automation.invoke?.("tasks/createBatch", payload);
      lastAction.current = { type: "tasks.createBatch", payload: { count: payload.tasks.length } };
      toast(`Sent ${payload.tasks.length} tasks to Task Board`, "success");
    } catch {
      toast("Could not send to Task Board", "error");
    }
  };

  const scheduleOnCalendar = async () => {
    const start = new Date();
    const end = new Date(start.getTime() + (clamp(sessionMinutes, 15, 300) * 60000));
    const sabbath = isSabbath(new Date(), { saturdayAsSabbath: false });
    const payload = {
      source: "CleaningPlanner",
      title: sabbath ? "Cleaning Prep (Sabbath-safe)" : "Cleaning Session",
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      description: "Auto-scheduled from CleaningPlanner (approve or adjust).",
      requireApproval: true,
      metadata: { tasks: tasks.map((t) => t.id), energy, voiceAlerts },
    };
    try {
      bus.emit?.("calendar/schedule", payload);
      await automation.invoke?.("calendar/schedule", payload);
      lastAction.current = { type: "calendar.schedule" };
      toast("Session proposed on calendar", "success");
    } catch {
      toast("Could not schedule on calendar", "error");
    }
  };

  const doSave = () => {
    try {
      localStorage.setItem(STORAGE_TASKS, JSON.stringify(tasks));
      localStorage.setItem(STORAGE_DONE, JSON.stringify([...done]));
      toast("Session saved", "success");
    } catch { toast("Unable to save locally", "error"); }
  };

  const toast = (title, kind = "info") => {
    try { bus.emit?.("toast/show", { title, kind }); } catch {}
  };

  /* ----------------------------- Presentation ------------------------------- */
  const tabs = [
    { key: "checklist", label: "Today's Tasks", icon: <ListChecks size={16} /> },
    { key: "deep", label: "Generate Routine", icon: <Sparkles size={16} /> },
    { key: "zones", label: "Zones", icon: <MapPinned size={16} /> },
    { key: "tools", label: "Tools", icon: <Wrench size={16} /> },
    { key: "supplies", label: "Supplies", icon: <Boxes size={16} /> },
    { key: "custom", label: "My Places", icon: <Settings2 size={16} /> },
    { key: "activity", label: "Activity Log", icon: <History size={16} /> },
  ];

  const completedBanner = completedCount > 0 && completedCount < tasks.length;

  return (
    <div className="flex h-screen bg-stone-50">
      {/* Left Sidebar */}
      <aside className="w-72 bg-emerald-50/70 p-4 border-r border-emerald-200 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-800 mb-3 flex items-center gap-2">
          <CalendarDays size={18} /> Cleaning Planner
        </h2>

        <nav className="space-y-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`w-full text-left px-3 py-2 rounded-xl border ${activeTab === t.key ? "bg-white border-emerald-300 shadow-sm" : "bg-emerald-50/40 border-transparent hover:bg-emerald-50"}`}
            >
              <span className="inline-flex items-center gap-2">{t.icon}{t.label}</span>
            </button>
          ))}
        </nav>

        {/* Session controls */}
        <div className="mt-4 p-3 rounded-xl border bg-white">
          <div className="text-xs text-slate-500">Session Options</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-600">Minutes
              <input type="number" value={sessionMinutes} onChange={(e) => setSessionMinutes(clamp(e.target.value, 15, 300))} className="mt-1 w-full px-2 py-1 rounded-lg border"/>
            </label>
            <label className="text-xs text-slate-600">Energy
              <select value={energy} onChange={(e) => setEnergy(e.target.value)} className="mt-1 w-full px-2 py-1 rounded-lg border bg-white">
                <option value="low">Low</option>
                <option value="moderate">Moderate</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={voiceAlerts} onChange={(e) => setVoiceAlerts(e.target.checked)} />
            Voice alerts on step change
          </label>

          <div className="mt-3 grid grid-cols-1 gap-2">
            <button onClick={sendToTaskBoard} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50">Send to Task Board</button>
            <button onClick={scheduleOnCalendar} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50">Schedule on Calendar</button>
            <button onClick={doSave} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50">Save</button>
            <button onClick={handleUndo} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50 flex items-center gap-1"><RotateCcw size={14}/> Undo</button>
          </div>
        </div>

        {/* Quick add */}
        <div className="mt-3 p-3 rounded-xl border bg-white">
          <div className="text-xs text-slate-500 mb-2">Quick Add</div>
          <div className="grid grid-cols-1 gap-2">
            <button onClick={() => addQuickTask("Spot mop high-traffic areas", "Entry / Hall", 7, 1)} className="px-3 py-1.5 rounded-xl border bg-emerald-50 hover:bg-emerald-100 text-emerald-900">Spot Mop</button>
            <button onClick={() => addQuickTask("Clear & reset flat surfaces", "Common Areas", 6, 0)} className="px-3 py-1.5 rounded-xl border bg-emerald-50 hover:bg-emerald-100 text-emerald-900">Reset Surfaces</button>
            <button onClick={() => addQuickTask("Mirror & faucet shine", "Bathrooms", 5, 2)} className="px-3 py-1.5 rounded-xl border bg-emerald-50 hover:bg-emerald-100 text-emerald-900">Shine Mirrors</button>
          </div>
        </div>
      </aside>

      {/* Main Section */}
      <main className="flex-1 p-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-emerald-900">Cleaning Session Planner</h1>
          {completedBanner && (
            <div className="text-xs px-3 py-1.5 rounded-full border bg-white text-slate-600">
              {Math.round(progress)}% complete • {tasks.length - completedCount} to go
            </div>
          )}
        </div>

        <AnimatedProgressBar progress={progress} />

        {/* Next Best Action */}
        {nba && (
          <div className="mt-3 p-3 rounded-xl border bg-amber-50 text-amber-900">
            <div className="text-sm font-medium">Next best action</div>
            <div className="text-sm mt-1">{nba.title} <span className="text-xs text-amber-800">({nba.zone} • {nba.estMin} min)</span></div>
          </div>
        )}

        {/* Tabs */}
        <div className="mt-4">
          {activeTab === "checklist" && (
            <Checklist
              tasks={tasks.map((t) => t.title)}
              completedTasks={tasks.filter(t => done.has(t.id)).map(t => t.title)}
              toggleTask={(title) => toggleTask(title)}
            />
          )}

          {activeTab === "deep" && (
            <Suspense fallback={<div className="p-3 rounded-xl border bg-slate-50">Loading Deep Clean builder…</div>}>
              <DeepCleanSession
                onPlanned={(result) => {
                  // echo a lightweight event for other modules; keep yours too
                  try { bus.emit?.("deepclean/planBuilt", result); } catch {}
                }}
              />
            </Suspense>
          )}

          {activeTab === "zones" && (
            <Suspense fallback={<div className="p-3 rounded-xl border bg-slate-50">Loading Zones…</div>}>
              <ZoneGroupPanel
                onGenerateRoutine={(draft) => bus.emit?.("cleaning/routineDraft", draft)}
              />
            </Suspense>
          )}

          {activeTab === "tools" && <ToolChecklistPanel />}

          {activeTab === "supplies" && <SupplyChecklistPanel />}

          {activeTab === "custom" && <CustomLocationsManager />}

          {activeTab === "activity" && (
            <div className="rounded-2xl border bg-white p-4">
              <div className="text-sm text-slate-600">Recent Actions</div>
              <ul className="mt-2 text-sm list-disc ml-5">
                <li>Keyboard: Ctrl+S to save, Ctrl+Z to undo</li>
                <li>“Generate Routine” uses Zones (priority + cadence) to build a day plan</li>
                <li>Deep Clean builder respects Sabbath mode and integrates Tools/Supplies</li>
                <li>Send to Task Board / Schedule on Calendar emit events for approval</li>
              </ul>
            </div>
          )}
        </div>
      </main>

      {/* Reward */}
      {showReward && (
        <RewardPopup
          title="Cleaning Master!"
          message="You completed your session! 🎉"
          onClose={() => setShowReward(false)}
        />
      )}
    </div>
  );
}
