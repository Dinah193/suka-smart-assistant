// src/components/cleaning/DeepCleanBuilder.jsx
// Suka – Deep Clean Builder
// - Build a deep clean *routine* (not "session") with per-task cadences
// - Sabbath-aware guard (approx: Saturday in America/New_York)
// - Creates ad-hoc Cleaning Plan, schedules RRULEs per task
// - Aggregates Tools/Supplies, emits UI nudges (Paper Inbox / Harvest when present via tags)
// - Strategy shortcuts: Bug-Shield Perimeter, Appliance Care
// - Undo/Redo, local persistence, keyboard shortcuts: Ctrl+S (save), G (Generate), Ctrl+Z/Y (undo/redo)

import React, { useEffect, useMemo, useState } from "react";
import {
  Check, Trash2, Save, Play, CalendarPlus, Plus, MoveUp, MoveDown,
  Undo2, Redo2, Sparkles, Wrench, Shield, Info
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";

/* ------------------------------ Defensive imports ------------------------------ */
let eventBus = { emit: () => {}, on: () => () => {} };
let automation = { queue: () => {}, invoke: async () => {} };
let CleaningPlanManager = null;
let PreferencesStore = { getState: () => ({ timezone: "America/New_York", sabbathAware: true }) };
let deepCleanCadenceToRRULE = (x) => "RRULE:FREQ=YEARLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0";
let materializeStrategy = async () => ({ tasks: [] });

(async () => {
  try { ({ eventBus } = await import("@/services/events/eventBus")); } catch {}
  try { ({ automation } = await import("@/services/automation/runtime")); } catch {}
  try { ({ default: CleaningPlanManager } = await import("@/managers/CleaningPlanManager")); } catch {}
  try {
    const s = await import("@/data/organizingStrategies");
    deepCleanCadenceToRRULE = s?.deepCleanCadenceToRRULE || deepCleanCadenceToRRULE;
    materializeStrategy = s?.materializeStrategy || materializeStrategy;
  } catch {}
  try {
    const p = await import("@/stores/preferences");
    PreferencesStore = p?.usePreferencesStore || PreferencesStore;
  } catch {}
})();

/* --------------------------------- Presets --------------------------------- */
const DEEP_CLEAN_PRESETS = {
  Kitchen: [
    { name: "Inside oven (racks, door, seals)", area: "kitchen", estMinutes: 30, tools: ["Gloves", "Scraper"], supplies: ["Degreaser"], cadence: "quarterly", priority: 3, tags: ["grease", "appliance"] },
    { name: "Fridge deep clean (shelves, seals)", area: "kitchen", estMinutes: 30, tools: ["Towel"], supplies: ["Disinfectant"], cadence: "monthly", priority: 3, tags: ["appliance"] },
    { name: "Under appliances sweep & mop", area: "kitchen", estMinutes: 20, tools: ["Scrub Brush"], supplies: ["Floor Cleaner"], cadence: "bi-annual", priority: 2, tags: ["floor"] },
  ],
  Bathroom: [
    { name: "Grout scrub & reseal check", area: "bath", estMinutes: 35, tools: ["Grout Brush"], supplies: ["Baking Soda", "Vinegar"], cadence: "bi-annual", priority: 3, tags: ["grout"] },
    { name: "Toilet base disinfect + hinges", area: "bath", estMinutes: 10, tools: ["Rag"], supplies: ["Bleach"], cadence: "monthly", priority: 2, tags: ["disinfect"] },
    { name: "Exhaust fan cover clean", area: "bath", estMinutes: 10, tools: ["Screwdriver"], supplies: ["All-purpose Cleaner"], cadence: "quarterly", priority: 2, tags: ["vent"] },
  ],
  Bedroom: [
    { name: "Vacuum under bed", area: "bedrooms", estMinutes: 10, tools: ["Vacuum"], supplies: [], cadence: "quarterly", priority: 2, tags: [] },
    { name: "Baseboards wipe", area: "bedrooms", estMinutes: 12, tools: ["Cloth"], supplies: ["Dusting Spray"], cadence: "quarterly", priority: 2, tags: ["baseboards"] },
    { name: "Mattress rotate & vacuum", area: "bedrooms", estMinutes: 20, tools: ["Vacuum"], supplies: [], cadence: "quarterly", priority: 2, tags: ["mattress"] },
  ],
  LivingRoom: [
    { name: "Vacuum behind furniture", area: "living", estMinutes: 12, tools: ["Vacuum"], supplies: [], cadence: "quarterly", priority: 2, tags: [] },
    { name: "Ceiling fan blades clean", area: "living", estMinutes: 10, tools: ["Step Stool", "Duster"], supplies: [], cadence: "quarterly", priority: 2, tags: ["fan"] },
    { name: "Window tracks & sills", area: "living", estMinutes: 15, tools: ["Cloth"], supplies: ["Glass Cleaner"], cadence: "bi-annual", priority: 2, tags: ["windows"] },
  ],
};

/* --------------------------------- Utilities --------------------------------- */
const TZ = () => {
  try { return PreferencesStore.getState()?.timezone || "America/New_York"; } catch { return "America/New_York"; }
};
const SABBATH_AWARE = () => {
  try { return !!PreferencesStore.getState()?.sabbathAware; } catch { return true; }
};
const isSabbathApprox = (d = new Date(), tz = "America/New_York", aware = true) => {
  if (!aware) return false;
  const dow = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(d);
  return dow === "Sat";
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const uid = () => uuidv4();

/* -------------------------------- Persistence -------------------------------- */
const LKEY = "suka:deep-clean-builder:v1";
function loadState() {
  try { return JSON.parse(localStorage.getItem(LKEY) || "null"); } catch { return null; }
}
function saveState(state) {
  try { localStorage.setItem(LKEY, JSON.stringify(state)); } catch {}
}

/* ------------------------------- Undo/Redo Hook ------------------------------- */
function useHistory(initial) {
  const [stack, setStack] = useState([initial]);
  const [i, setI] = useState(0);
  const value = stack[i];
  const canUndo = i > 0;
  const canRedo = i < stack.length - 1;
  const set = (next) => { const arr = stack.slice(0, i + 1).concat([next]); setStack(arr); setI(arr.length - 1); };
  const undo = () => canUndo && setI(i - 1);
  const redo = () => canRedo && setI(i + 1);
  return { value, set, undo, redo, canUndo, canRedo };
}

/* --------------------------------- Component --------------------------------- */
export default function DeepCleanBuilder() {
  const persisted = loadState();
  const tz = useMemo(() => TZ(), []);
  const sabbathAware = useMemo(() => SABBATH_AWARE(), []);
  const sabbathActive = isSabbathApprox(new Date(), tz, sabbathAware);

  const [selectedArea, setSelectedArea] = useState(persisted?.selectedArea || "Kitchen");
  const history = useHistory(persisted?.tasks || []);
  const tasks = history.value;

  const [name, setName] = useState(persisted?.name || "Deep Clean Focus");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    saveState({ selectedArea, tasks, name });
  }, [selectedArea, tasks, name]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); handleSave(); }
      if (!e.repeat && k === "g") handleGenerateRoutine();
      if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); history.undo(); }
      if ((e.ctrlKey || e.metaKey) && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); history.redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tasks, name]);

  /* --------------------------------- Builders --------------------------------- */
  const addPresetTasks = () => {
    const presets = DEEP_CLEAN_PRESETS[selectedArea] || [];
    const existing = new Set(tasks.map((t) => t.name));
    const newOnes = presets
      .filter((p) => !existing.has(p.name))
      .map((p) => ({
        id: uid(),
        name: p.name,
        area: p.area,
        estMinutes: p.estMinutes,
        cadence: p.cadence,              // monthly/quarterly/bi-annual/annual/weekly/daily
        priority: p.priority || 2,
        sabbathBlocked: true,
        tools: p.tools || [],
        supplies: p.supplies || [],
        tags: p.tags || [],
      }));
    history.set([...(tasks || []), ...newOnes]);
    eventBus.emit("ui:toast", { type: "success", message: `Added ${newOnes.length} ${selectedArea} task(s).` });
  };

  const addCustomTask = () => {
    const t = {
      id: uid(),
      name: "",
      area: "kitchen",
      estMinutes: 20,
      cadence: "quarterly",
      priority: 2,
      sabbathBlocked: true,
      tools: [],
      supplies: [],
      tags: [],
    };
    history.set([...(tasks || []), t]);
  };

  const updateTask = (id, patch) => {
    history.set(tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const removeTask = (id) => {
    const prev = tasks;
    const next = tasks.filter((t) => t.id !== id);
    history.set(next);
    eventBus.emit("ui:toast:undo", {
      message: "Task removed",
      actionLabel: "Undo",
      onAction: () => history.set(prev),
    });
  };

  const moveTask = (id, dir) => {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const to = idx + dir;
    if (to < 0 || to >= tasks.length) return;
    const copy = tasks.slice();
    const [it] = copy.splice(idx, 1);
    copy.splice(to, 0, it);
    history.set(copy);
  };

  /* ------------------------------ Strategy shortcuts ------------------------------ */
  const injectStrategy = async (strategyId) => {
    setBusy(true);
    try {
      const res = await materializeStrategy(strategyId, { blockOnSabbath: true });
      const xs = (res?.tasks || []).map((t) => ({
        id: t.id || uid(),
        name: t.title,
        area: t.area || "entry",
        estMinutes: clamp(t.estMinutes || 10, 5, 120),
        cadence: t.cadence || null,
        priority: 2,
        sabbathBlocked: t.meta?.sabbathBlocked !== false,
        tools: [],
        supplies: [],
        tags: t.meta?.tags || [],
      }));
      history.set([...(tasks || []), ...xs]);
      eventBus.emit("ui:toast", { type: "success", message: "Added strategy tasks. Edit as needed." });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not add strategy tasks." });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------------- Plan Ops --------------------------------- */
  const buildPlanTasks = () => {
    return (tasks || [])
      .filter((t) => !(sabbathActive && t.sabbathBlocked))
      .map((t) => ({
        id: t.id,
        title: t.name,
        area: t.area || "kitchen",
        estMinutes: clamp(t.estMinutes || 20, 5, 180),
        priority: clamp(t.priority || 2, 1, 3),
        cadence: t.cadence || null,
        meta: {
          sabbathBlocked: !!t.sabbathBlocked,
          tags: t.tags || [],
          tools: t.tools || [],
          supplies: t.supplies || [],
        },
      }));
  };

  const scheduleCadences = (planTasks) => {
    planTasks.filter((t) => !!t.cadence).forEach((t) => {
      const rrule = deepCleanCadenceToRRULE(t.cadence);
      eventBus.emit("calendar:create:rrule", {
        title: `Deep Clean: ${t.title}`,
        area: t.area,
        rrule,
        tz,
        meta: { source: "deep-clean-builder", cadence: t.cadence },
      });
    });
  };

  const handleGenerateRoutine = () => {
    const planTasks = buildPlanTasks();
    if (!planTasks.length) {
      eventBus.emit("ui:toast", { type: "warning", message: "Add at least one task before generating." });
      return;
    }
    if (CleaningPlanManager?.createAdhocPlan) {
      try {
        const plan = CleaningPlanManager.createAdhocPlan({
          title: `${name} (Deep Clean)`,
          tasks: planTasks,
          meta: { source: "DeepCleanBuilder", createdAt: new Date().toISOString() },
        });
        eventBus.emit("cleaning:plan:created", { planId: plan?.id, source: "deep-clean-builder" });
        eventBus.emit("ui:navigate", { to: "/tier2/household/cleaning/live" });
      } catch (e) {
        console.error(e);
        eventBus.emit("ui:toast", { type: "error", message: "Could not create plan." });
      }
    }
    scheduleCadences(planTasks);

    // Nudges (if any tags present)
    if (planTasks.some((t) => (t.meta?.tags || []).includes("paper-inbox"))) {
      automation.queue?.("UI:Nudge", {
        message: "Pin a weekly ‘Paper Inbox Zero’ block on your calendar?",
        actions: [{ label: "Open Calendar", event: "ui:navigate", to: "/calendar" }],
      });
    }
    if (planTasks.some((t) => (t.meta?.tags || []).includes("harvest"))) {
      automation.queue?.("Inventory:SyncFromHarvestLog", { mode: "append" });
    }

    eventBus.emit("ui:toast", { type: "success", message: "Routine generated. Live Session is ready." });
  };

  const handleSave = () => {
    saveState({ selectedArea, tasks, name });
    eventBus.emit("ui:toast", { type: "success", message: "Deep Clean saved." });
  };

  /* --------------------------------- Summaries -------------------------------- */
  const summary = useMemo(() => {
    const tools = new Set();
    const supplies = new Set();
    (tasks || []).forEach((t) => {
      (t.tools || []).forEach((x) => tools.add(x));
      (t.supplies || []).forEach((x) => supplies.add(x));
    });
    return { tools: [...tools], supplies: [...supplies] };
  }, [tasks]);

  /* ------------------------------------ UI ------------------------------------ */
  return (
    <div className="bg-white p-6 rounded-2xl shadow-md border border-yellow-200 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-gray-700" />
          <h2 className="text-lg font-semibold">Deep Clean Builder</h2>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={handleSave}><Save className="w-4 h-4 mr-1" /> Save</button>
          <button className="btn btn-primary" onClick={handleGenerateRoutine}><Play className="w-4 h-4 mr-1" /> Generate Routine</button>
        </div>
      </div>

      {/* Meta / Presets / Strategies */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="p-3 rounded-xl border">
          <label className="text-xs text-gray-500">Routine name</label>
          <input className="w-full border rounded-lg px-3 py-2 mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Quarterly Deep Clean Focus" />
        </div>

        <div className="p-3 rounded-xl border">
          <div className="text-xs text-gray-500">Area presets</div>
          <div className="flex gap-2 mt-1">
            <select className="border rounded-lg px-3 py-2 flex-1" value={selectedArea} onChange={(e) => setSelectedArea(e.target.value)}>
              {Object.keys(DEEP_CLEAN_PRESETS).map((area) => <option key={area} value={area}>{area}</option>)}
            </select>
            <button className="btn" onClick={addPresetTasks}><Plus className="w-4 h-4" /></button>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">Adds unique tasks from the selected area.</p>
        </div>

        <div className="p-3 rounded-xl border">
          <div className="text-xs text-gray-500 mb-1">Strategy shortcuts</div>
          <div className="flex flex-wrap gap-2">
            <button className="btn" disabled={busy} onClick={() => injectStrategy("bug-shield-perimeter")}><Shield className="w-4 h-4 mr-1" /> Bug-Shield</button>
            <button className="btn" disabled={busy} onClick={() => injectStrategy("appliance-care")}><Wrench className="w-4 h-4 mr-1" /> Appliance Care</button>
          </div>
        </div>
      </div>

      {/* Builder list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-gray-700">
            <Info className="w-4 h-4" />
            <span className="text-sm">Add tasks, set cadences, then Generate Routine. Sabbath guard skips blocked tasks if active.</span>
          </div>
          <button className="btn" onClick={addCustomTask}><Plus className="w-4 h-4 mr-1" /> Add Task</button>
        </div>

        {tasks.length === 0 ? (
          <div className="border border-dashed rounded-2xl p-8 text-center text-gray-600">
            No tasks yet. Add a preset or create a custom task.
          </div>
        ) : (
          <ul className="space-y-2">
            {tasks.map((t, idx) => (
              <li key={t.id} className="p-3 rounded-xl border bg-white">
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-12 md:col-span-4">
                    <label className="text-xs text-gray-500">Task</label>
                    <input
                      className="w-full border rounded-lg px-3 py-2 mt-1"
                      value={t.name}
                      onChange={(e) => updateTask(t.id, { name: e.target.value })}
                      placeholder={`Task ${idx + 1}`}
                    />
                  </div>
                  <div className="col-span-6 md:col-span-2">
                    <label className="text-xs text-gray-500">Area</label>
                    <select
                      className="w-full border rounded-lg px-3 py-2 mt-1"
                      value={t.area}
                      onChange={(e) => updateTask(t.id, { area: e.target.value })}
                    >
                      {["kitchen", "bath", "bedrooms", "living", "laundry", "entry", "storehouse"].map((a) => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-3 md:col-span-1">
                    <label className="text-xs text-gray-500">Est (min)</label>
                    <input
                      type="number"
                      min={5}
                      className="w-full border rounded-lg px-3 py-2 mt-1"
                      value={t.estMinutes}
                      onChange={(e) => updateTask(t.id, { estMinutes: clamp(Number(e.target.value || 5), 5, 180) })}
                    />
                  </div>
                  <div className="col-span-6 md:col-span-2">
                    <label className="text-xs text-gray-500">Cadence</label>
                    <select
                      className="w-full border rounded-lg px-3 py-2 mt-1"
                      value={t.cadence || ""}
                      onChange={(e) => updateTask(t.id, { cadence: e.target.value || null })}
                    >
                      <option value="">— None —</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="bi-annual">Bi-Annual</option>
                      <option value="annual">Annual</option>
                    </select>
                    {t.cadence && (
                      <p className="text-[11px] text-gray-500 mt-1">
                        Schedules: {deepCleanCadenceToRRULE(t.cadence).replace("RRULE:", "")}
                      </p>
                    )}
                  </div>
                  <div className="col-span-3 md:col-span-1">
                    <label className="text-xs text-gray-500">Priority</label>
                    <select
                      className="w-full border rounded-lg px-3 py-2 mt-1"
                      value={t.priority}
                      onChange={(e) => updateTask(t.id, { priority: clamp(Number(e.target.value || 2), 1, 3) })}
                    >
                      {[1,2,3].map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </div>

                  <div className="col-span-12 md:col-span-4">
                    <label className="text-xs text-gray-500">Tools (comma-separated)</label>
                    <input
                      className="w-full border rounded-lg px-3 py-2 mt-1"
                      value={(t.tools || []).join(", ")}
                      onChange={(e) => updateTask(t.id, { tools: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                      placeholder="Gloves, Scraper"
                    />
                  </div>
                  <div className="col-span-12 md:col-span-4">
                    <label className="text-xs text-gray-500">Supplies (comma-separated)</label>
                    <input
                      className="w-full border rounded-lg px-3 py-2 mt-1"
                      value={(t.supplies || []).join(", ")}
                      onChange={(e) => updateTask(t.id, { supplies: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                      placeholder="Degreaser, Bleach"
                    />
                  </div>
                  <div className="col-span-12 md:col-span-4">
                    <label className="text-xs text-gray-500">Tags</label>
                    <input
                      className="w-full border rounded-lg px-3 py-2 mt-1"
                      value={(t.tags || []).join(", ")}
                      onChange={(e) => updateTask(t.id, { tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                      placeholder="appliance, grout"
                    />
                  </div>

                  <div className="col-span-12 md:col-span-3">
                    <label className="text-xs text-gray-500">Sabbath Block</label>
                    <div className="mt-1">
                      <button
                        className={`px-3 py-2 rounded-lg border ${t.sabbathBlocked ? "bg-gray-900 text-white" : "bg-white"}`}
                        onClick={() => updateTask(t.id, { sabbathBlocked: !t.sabbathBlocked })}
                      >
                        {t.sabbathBlocked ? "Blocked" : "Allowed"}
                      </button>
                      {sabbathActive && t.sabbathBlocked && (
                        <span className="ml-2 text-[11px] text-amber-600">Active now</span>
                      )}
                    </div>
                  </div>

                  <div className="col-span-12 md:col-span-3 flex items-end gap-2">
                    <button className="btn" onClick={() => moveTask(t.id, -1)} disabled={idx === 0}><MoveUp className="w-4 h-4" /></button>
                    <button className="btn" onClick={() => moveTask(t.id, +1)} disabled={idx === tasks.length - 1}><MoveDown className="w-4 h-4" /></button>
                    <button className="btn btn-danger" onClick={() => removeTask(t.id)}>
                      <Trash2 className="w-4 h-4 mr-1" /> Remove
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Summary + actions */}
      {tasks.length > 0 && (
        <div className="bg-yellow-50 p-4 rounded-2xl border border-yellow-200">
          <h4 className="font-semibold text-yellow-800 mb-2">Prep Summary</h4>
          <p className="text-sm"><strong>Tools:</strong> {summary.tools.join(", ") || "None"}</p>
          <p className="text-sm"><strong>Supplies:</strong> {summary.supplies.join(", ") || "None"}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={handleGenerateRoutine}>
              <Play className="w-4 h-4 mr-1" /> Generate Routine
            </button>
            <button className="btn" onClick={() => {
              const planTasks = buildPlanTasks();
              scheduleCadences(planTasks);
              eventBus.emit("ui:toast", { type: "success", message: "Cadence items scheduled." });
            }}>
              <CalendarPlus className="w-4 h-4 mr-1" /> Schedule Cadence
            </button>
            <button className="btn" onClick={handleSave}>
              <Save className="w-4 h-4 mr-1" /> Save
            </button>
            <button
              className="btn"
              onClick={() => {
                const data = JSON.stringify({ name, tasks }, null, 2);
                const blob = new Blob([data], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = `${name.replace(/\s+/g, "-").toLowerCase()}-deep-clean.json`;
                a.click(); URL.revokeObjectURL(url);
              }}
            >
              <Check className="w-4 h-4 mr-1" /> Export JSON
            </button>
          </div>
        </div>
      )}

      {/* Footer helper */}
      <div className="mt-3 p-3 rounded-xl border bg-white">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-600 flex items-center gap-1"><Undo2 className="w-4 h-4" /> Undo/Redo available</span>
          <span className="text-gray-600 flex items-center gap-1"><Sparkles className="w-4 h-4" /> Use cadences for Deep Clean Focus per task</span>
        </div>
      </div>

      <StyleSeed />
    </div>
  );
}

/* -------------------------------- Inline styles -------------------------------- */
function StyleSeed() {
  if (typeof document === "undefined") return null;
  const id = "deep-clean-builder-inline-styles";
  if (document.getElementById(id)) return null;
  const style = document.createElement("style");
  style.id = id;
  style.innerHTML = `
    .btn {
      display:inline-flex;align-items:center;justify-content:center;
      border:1px solid rgb(229,231,235);border-radius:0.75rem;
      padding:0.5rem 0.75rem;font-size:0.875rem;background:white;color:rgb(55,65,81);
    }
    .btn:hover { background: rgb(249,250,251); }
    .btn-primary { background: rgb(17,24,39); color: white; border-color: rgb(17,24,39); }
    .btn-primary:hover { background: black; }
    .btn-danger { color: rgb(220,38,38); border-color: rgb(252,165,165); }
  `;
  document.head.appendChild(style);
  return null;
}
