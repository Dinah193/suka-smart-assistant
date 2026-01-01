// src/components/cleaning/ZoneGroupPanel.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Home, PlusCircle, Pencil, Trash2, Star, StarHalf, StarOff,
  ArrowUp, ArrowDown, CalendarDays, Upload, Download, Wand2, RefreshCcw, Search
} from "lucide-react";

/**
 * ZoneGroupPanel — dynamic, event-driven Zone manager
 * ---------------------------------------------------
 * - Presets & Recommendations (auto-suggest based on common homes)
 * - Priority tiers (none → focus → critical) with star cycle
 * - Cadence per zone (none/monthly/quarterly/biannual/annual)
 * - Reorder (up/down), inline rename, delete with Undo
 * - Persist to localStorage; emits events to your bus + automation runtime
 * - Quick search filter; keyboard shortcuts (Ctrl+S save, Ctrl+Z undo, Ctrl+I import)
 * - “Apply Recommended” one-click adds popular zones with smart defaults
 * - “Generate Routine” bridge: emits a draft to cleaning planner (Deep Clean Focus aware)
 */

/* ----------------------------- IDs & Utils ----------------------------- */
const uid = (p = "z") => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const clampIndex = (i, min, max) => Math.min(Math.max(i, min), max);
const toTitle = (s = "") => s.replace(/\s+/g, " ").trim();
const STORAGE_KEY = "cleaning.zones.v2";
const STORAGE_UNDO = "cleaning.zones.undo";

const PRIORITY = {
  NONE: 0, FOCUS: 1, CRITICAL: 2,
};
const PRIORITY_LABEL = ["None", "Focus", "Critical"];
const CADENCE_LABEL = { none: "None", monthly: "Monthly", quarterly: "Quarterly", biannual: "Bi-Annually", annual: "Annually" };

/* ----------------------------- Safe shims ------------------------------ */
let busShim = { emit: () => {}, on: () => () => {}, invoke: async () => {} };
let automationShim = { queue: () => {}, invoke: async () => {} };
try { ({ eventBus: busShim } = require("@/services/events/eventBus")); } catch {}
try { ({ automation: automationShim } = require("@/services/automation/runtime")); } catch {}

/* ----------------------------- Presets --------------------------------- */
const RECOMMENDED_PRESETS = [
  { name: "Kitchen", cadence: "monthly", priority: PRIORITY.CRITICAL, tag: "grease" },
  { name: "Bathrooms", cadence: "monthly", priority: PRIORITY.CRITICAL, tag: "grout" },
  { name: "Living Room", cadence: "quarterly", priority: PRIORITY.FOCUS, tag: "dust" },
  { name: "Bedrooms", cadence: "quarterly", priority: PRIORITY.FOCUS, tag: "linen" },
  { name: "Entry / Mudroom", cadence: "monthly", priority: PRIORITY.FOCUS, tag: "traffic" },
  { name: "Laundry", cadence: "quarterly", priority: PRIORITY.NONE, tag: "lint" },
  { name: "Office / Study", cadence: "biannual", priority: PRIORITY.NONE, tag: "paper" },
  { name: "Dining", cadence: "biannual", priority: PRIORITY.NONE, tag: "polish" },
  { name: "Porch / Patio", cadence: "quarterly", priority: PRIORITY.NONE, tag: "outdoor" },
  { name: "Garage / Storage", cadence: "annual", priority: PRIORITY.NONE, tag: "declutter" },
];

/* ----------------------------- Load/Save -------------------------------- */
const loadZones = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
};
const saveZones = (zones) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(zones)); } catch {} };
const saveUndo = (zones) => { try { localStorage.setItem(STORAGE_UNDO, JSON.stringify(zones)); } catch {} };
const popUndo = () => {
  try {
    const raw = localStorage.getItem(STORAGE_UNDO);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    localStorage.removeItem(STORAGE_UNDO);
    return parsed;
  } catch { return null; }
};

/* ----------------------------- Component -------------------------------- */
export default function ZoneGroupPanel({
  initial = null,           // optional seed zones
  onChange = () => {},      // callback(zones)
  onGenerateRoutine = () => {} // callback(draft) or use eventBus
}) {
  const defaultSeed = useMemo(() => (initial && initial.length ? initial : [
    { id: uid(), name: "Kitchen", priority: PRIORITY.CRITICAL, cadence: "monthly" },
    { id: uid(), name: "Living Room", priority: PRIORITY.FOCUS, cadence: "quarterly" },
    { id: uid(), name: "Bathrooms", priority: PRIORITY.CRITICAL, cadence: "monthly" },
  ]), [initial]);

  const [zones, setZones] = useState(() => loadZones() || defaultSeed);
  const [zoneInput, setZoneInput] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [filter, setFilter] = useState("");
  const [lastAction, setLastAction] = useState(null); // {type, payload}

  /* Persist & notify */
  useEffect(() => {
    saveZones(zones);
    try { onChange(zones); } catch {}
    try { busShim.emit?.("zones/updated", { zones }); } catch {}
  }, [zones, onChange]);

  /* Keyboard shortcuts */
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); doSave(); }
      if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); handleUndo(); }
      if (e.ctrlKey && e.key.toLowerCase() === "i") { e.preventDefault(); triggerImport(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zones]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter(z => z.name.toLowerCase().includes(q));
  }, [zones, filter]);

  /* ----------------------------- Handlers -------------------------------- */
  const commitWithUndo = (next, action) => {
    saveUndo(zones);
    setZones(next);
    setLastAction(action || null);
  };

  const handleAddZone = () => {
    const name = toTitle(zoneInput);
    if (!name) return;
    const newZone = { id: uid(), name, priority: PRIORITY.NONE, cadence: "none" };
    commitWithUndo([...zones, newZone], { type: "add", payload: { id: newZone.id } });
    setZoneInput("");
  };

  const handleRename = (id, newName) => {
    const name = toTitle(newName);
    commitWithUndo(zones.map(z => z.id === id ? { ...z, name: name || z.name } : z), { type: "rename", payload: { id } });
    setEditingId(null);
  };

  const handleDelete = (id) => {
    commitWithUndo(zones.filter(z => z.id !== id), { type: "delete", payload: { id } });
  };

  const cyclePriority = (id) => {
    commitWithUndo(zones.map(z => {
      if (z.id !== id) return z;
      const next = ((z.priority ?? 0) + 1) % 3; // 0→1→2→0
      return { ...z, priority: next };
    }), { type: "priority", payload: { id } });
  };

  const setCadence = (id, cadence) => {
    commitWithUndo(zones.map(z => z.id === id ? { ...z, cadence } : z), { type: "cadence", payload: { id, cadence } });
  };

  const move = (id, dir) => {
    const idx = zones.findIndex(z => z.id === id);
    if (idx < 0) return;
    const to = clampIndex(idx + dir, 0, zones.length - 1);
    if (to === idx) return;
    const next = [...zones];
    const [item] = next.splice(idx, 1);
    next.splice(to, 0, item);
    commitWithUndo(next, { type: "reorder", payload: { id, from: idx, to } });
  };

  const applyRecommended = () => {
    const have = new Set(zones.map(z => z.name.toLowerCase()));
    const adds = RECOMMENDED_PRESETS
      .filter(p => !have.has(p.name.toLowerCase()))
      .map(p => ({ id: uid(), name: p.name, priority: p.priority, cadence: p.cadence, tag: p.tag }));
    if (!adds.length) return;
    commitWithUndo([...zones, ...adds], { type: "applyRecommended", payload: { count: adds.length } });
  };

  const clearAll = () => {
    if (!zones.length) return;
    commitWithUndo([], { type: "clear" });
  };

  const doSave = () => {
    saveZones(zones);
    setLastAction({ type: "save" });
    try { busShim.emit?.("toast/show", { title: "Zones saved", kind: "success" }); } catch {}
  };

  const handleUndo = () => {
    const prev = popUndo();
    if (!prev) return;
    setZones(prev);
    setLastAction(null);
  };

  /* ------------ Calendar bridge: schedule Deep Clean Focus by zone -------- */
  const scheduleCadences = async () => {
    if (!zones.length) return;
    const schedules = zones
      .filter(z => z.cadence && z.cadence !== "none")
      .map(z => ({
        title: `Deep Clean Focus: ${z.name}`,
        rrule: cadenceToRRule(z.cadence),
        startISO: new Date().toISOString(),
        durationMin: 45,
        metadata: { zoneId: z.id, priority: z.priority },
      }));
    if (!schedules.length) return;

    try {
      busShim.emit?.("calendar/scheduleRecurringBatch", { source: "ZoneGroupPanel", schedules, requireApproval: true });
      await automationShim.invoke?.("calendar/scheduleRecurringBatch", { source: "ZoneGroupPanel", schedules, requireApproval: true });
      setLastAction({ type: "calendar.scheduleRecurringBatch", payload: { count: schedules.length } });
      busShim.emit?.("toast/show", { title: `Scheduled ${schedules.length} deep-focus cadences`, kind: "success" });
    } catch {
      busShim.emit?.("toast/show", { title: "Could not schedule cadences", kind: "error" });
    }
  };

  const cadenceToRRule = (c) => {
    switch (c) {
      case "monthly": return "FREQ=MONTHLY";
      case "quarterly": return "FREQ=MONTHLY;INTERVAL=3";
      case "biannual": return "FREQ=MONTHLY;INTERVAL=6";
      case "annual": return "FREQ=YEARLY";
      default: return "";
    }
  };

  /* -------------------------- Import / Export JSON ------------------------ */
  const fileRef = useRef(null);
  const triggerImport = () => fileRef.current?.click();
  const onImport = (e) => {
    try {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = JSON.parse(evt.target.result);
          if (Array.isArray(data)) commitWithUndo(data.map(normalizeZone), { type: "import", payload: { count: data.length } });
        } catch { /* noop */ }
      };
      reader.readAsText(file);
      e.target.value = "";
    } catch {}
  };
  const normalizeZone = (z) => ({
    id: z.id || uid(),
    name: toTitle(z.name || "Zone"),
    priority: Number.isInteger(z.priority) ? z.priority : PRIORITY.NONE,
    cadence: ["none","monthly","quarterly","biannual","annual"].includes(z.cadence) ? z.cadence : "none",
    tag: z.tag || undefined,
  });
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(zones, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "zones.json"; a.click();
    URL.revokeObjectURL(url);
  };

  /* -------------------------- Generate Routine bridge -------------------- */
  const generateRoutine = () => {
    // Emits a minimal “routine draft” for the cleaning page to transform
    const draft = {
      createdAt: new Date().toISOString(),
      zones: zones.map(z => ({ id: z.id, name: z.name, priority: z.priority, cadence: z.cadence })),
      focusIds: zones.filter(z => z.priority >= PRIORITY.FOCUS).map(z => z.id),
    };
    try { onGenerateRoutine(draft); } catch {}
    try { busShim.emit?.("cleaning/routineDraft", draft); } catch {}
    try { automationShim.queue?.("cleaning/routineDraft", draft); } catch {}
    busShim.emit?.("toast/show", { title: "Routine draft created", kind: "info" });
  };

  /* ------------------------------ Render ---------------------------------- */
  return (
    <div className="bg-white border rounded-2xl p-5 shadow-sm">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <h2 className="text-lg font-semibold text-emerald-800 flex items-center gap-2">
          <Home size={18} className="text-emerald-600" />
          Zone Manager
        </h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={applyRecommended} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50 flex items-center gap-1" title="Add recommended zones">
            <Wand2 size={16} /> Apply Recommended
          </button>
          <button onClick={generateRoutine} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50 flex items-center gap-1" title="Send to Routine Generator">
            <RefreshCcw size={16} /> Generate Routine
          </button>
          <button onClick={scheduleCadences} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50 flex items-center gap-1" title="Schedule deep-focus cadences">
            <CalendarDays size={16} /> Schedule Cadences
          </button>
          <button onClick={exportJSON} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50 flex items-center gap-1" title="Export zones to JSON">
            <Download size={16} /> Export
          </button>
          <button onClick={triggerImport} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50 flex items-center gap-1" title="Import zones from JSON">
            <Upload size={16} /> Import
          </button>
          <input ref={fileRef} type="file" accept="application/json" onChange={onImport} className="hidden" />
        </div>
      </div>

      {/* Add / Search */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="flex gap-2 col-span-2">
          <input
            type="text"
            placeholder="Add a zone (e.g., Upstairs Bedrooms)"
            value={zoneInput}
            onChange={(e) => setZoneInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddZone()}
            className="flex-1 border px-3 py-2 rounded-xl"
          />
          <button onClick={handleAddZone} className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl flex items-center gap-1">
            <PlusCircle size={18} /> Add
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-full">
            <Search size={16} className="absolute left-2 top-2.5 text-slate-400" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search zones…"
              className="w-full pl-8 pr-3 py-2 border rounded-xl"
            />
          </div>
          {zones.length ? (
            <button onClick={clearAll} className="px-3 py-2 rounded-xl border bg-white hover:bg-slate-50" title="Clear all zones">
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {/* Empty state */}
      {!zones.length ? (
        <div className="mt-5 p-4 rounded-xl border bg-slate-50 text-sm text-slate-600">
          No zones yet. Use <span className="font-medium">Apply Recommended</span> for a fast start, or add your own above.
        </div>
      ) : null}

      {/* Zone list */}
      <ul className="mt-4 space-y-3">
        {filtered.map((zone, idx) => (
          <li key={zone.id} className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-emerald-50/60 border border-emerald-200 p-3 rounded-xl">
            {/* Left: name + edit */}
            <div className="flex items-center gap-2 min-w-0">
              <Home size={18} className="text-emerald-700 shrink-0" />
              {editingId === zone.id ? (
                <input
                  type="text"
                  defaultValue={zone.name}
                  onBlur={(e) => handleRename(zone.id, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleRename(zone.id, e.currentTarget.value)}
                  autoFocus
                  className="border px-2 py-1 rounded-lg w-full"
                />
              ) : (
                <span className="font-medium text-slate-800 truncate">{zone.name}</span>
              )}
            </div>

            {/* Middle: priority + cadence */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => cyclePriority(zone.id)}
                className="px-2 py-1 rounded-lg border bg-white hover:bg-slate-50 flex items-center gap-1"
                title={`Priority: ${PRIORITY_LABEL[zone.priority ?? 0]} (click to cycle)`}
                aria-label="Toggle priority"
              >
                {zone.priority === PRIORITY.CRITICAL ? <Star size={16} className="text-amber-500" /> :
                 zone.priority === PRIORITY.FOCUS ? <StarHalf size={16} className="text-amber-500" /> :
                 <StarOff size={16} className="text-amber-400" />}
                <span className="text-xs">{PRIORITY_LABEL[zone.priority ?? 0]}</span>
              </button>

              <select
                value={zone.cadence || "none"}
                onChange={(e) => setCadence(zone.id, e.target.value)}
                className="px-2 py-1 rounded-lg border bg-white text-sm"
                aria-label="Select deep clean cadence"
                title="Deep Clean Focus cadence"
              >
                {Object.entries(CADENCE_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            </div>

            {/* Right: actions */}
            <div className="flex items-center gap-1">
              <button onClick={() => setEditingId(zone.id)} className="text-blue-600 hover:text-blue-800 px-2 py-1" title="Rename">
                <Pencil size={18} />
              </button>
              <button onClick={() => move(zone.id, -1)} className="text-slate-700 hover:text-slate-900 px-2 py-1" title="Move up" aria-label="Move up">
                <ArrowUp size={18} />
              </button>
              <button onClick={() => move(zone.id, +1)} className="text-slate-700 hover:text-slate-900 px-2 py-1" title="Move down" aria-label="Move down">
                <ArrowDown size={18} />
              </button>
              <button onClick={() => handleDelete(zone.id)} className="text-red-600 hover:text-red-800 px-2 py-1" title="Delete">
                <Trash2 size={18} />
              </button>
            </div>
          </li>
        ))}
      </ul>

      {/* Footer actions */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-500">
          {zones.length} zones • {filtered.length !== zones.length ? `${filtered.length} shown` : "all shown"}
        </div>
        <div className="flex items-center gap-2">
          {lastAction && (
            <button onClick={handleUndo} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" title="Undo last change">
              Undo
            </button>
          )}
          <button onClick={doSave} className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50 flex items-center gap-1" title="Save zones">
            <SaveIcon /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* Small inline icon to avoid extra import churn */
function SaveIcon(props) { return <svg viewBox="0 0 24 24" width="16" height="16" {...props}><path fill="currentColor" d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4Zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm3-10H5V5h10v4Z"/></svg>; }
