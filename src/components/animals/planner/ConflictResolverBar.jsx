/* eslint-disable no-console */
// src/components/animals/planner/ConflictResolverBar.jsx
//
// Animals → Planner → Conflict Resolver Bar
//
// Purpose
// - Detects and resolves scheduling conflicts for animal tasks (feed/water/deworm/vaccinate/clean/inspect/butchery/package).
// - Presents smart, one-click strategies inspired by great schedulers (Linear, Fantastical, Google Calendar, Asana).
// - Works defensively with optional services (eventBus, analytics, reminders, inventory).
// - Keyboard-friendly, compact, optimistic UI with bulk apply + per-conflict actions.
//
// Props
// - conflicts: Conflict[]                                // required (pre-detected or live)
// - calendarEvents?: Event[]                             // optional, for availability simulation
// - onApply?: (resolutions: Resolution[]) => void        // called with accepted resolutions
// - onIgnore?: (conflictIds: string[]) => void           // mark conflicts as ignored
// - getAvailability?: (range: {start:number,end:number}) => Promise<{start:number,end:number}[]> | Array<...>
// - checkSupplies?: (items: Task[]) => Promise<{ok:boolean, missing?:string[]}>
// - defaultWorkHours?: { startHour?:number, endHour?:number } // default 7→19
// - className?: string
//
// Types (suggested shapes; loose by design)
// Conflict {
//   id: string,
//   kind?: string,                                        // aggregate hint
//   reason: "overlap"|"supply"|"duplicate"|"capacity",
//   window?: { start: number, end: number },              // ms epoch
//   capacity?: { maxParallel?: number },
//   items: Task[],
// }
// Task {
//   id: string,
//   title: string,
//   kind?: "Poultry"|"Sheep"|"Goat"|"Beef"|"Rabbit"|"Fish",
//   action?: "Feed"|"Water"|"Deworm"|"Vaccinate"|"Clean"|"Inspect"|"Butcher"|"Package",
//   durationMin?: number,
//   scheduled?: { start?: number, end?: number },         // ms epoch
//   supplies?: Array<{name:string, qty?:number, unit?:string}>,
//   priority?: number,                                    // higher first
// }
// Resolution {
//   conflictId: string,
//   strategy: string,                                     // e.g. "stagger-15", "move-window", "merge-batch"
//   changes: Array<{ taskId: string, scheduled?: {start:number,end:number}, notes?: string }>
// }
//
// Notes
// - This component provides a panel with: conflict summary, strategies, preview of changes, and apply/ignore controls.
// - It does *not* mutate remote state; it emits resolutions so a parent can save changes.
//

import React, { useEffect, useMemo, useRef, useState } from "react";

/* -------------------------------- utils -------------------------------- */
function cx(...a){ return a.filter(Boolean).join(" "); }
const ACTION_OPTS = ["Feed","Water","Deworm","Vaccinate","Clean","Inspect","Butcher","Package"];

function getServices() {
  return {
    bus: () => (window?.eventBus || window?.ssa?.eventBus || null),
    analytics: () => (window?.ssa?.analytics || null),
    reminders: () => (window?.ssa?.services?.reminders || window?.ReminderManager || null),
    toast(msg){ try { window?.ssa?.ui?.toast?.(msg); } catch { console.log("[toast]", msg); } },
  };
}

function minutes(n){ return n*60*1000; }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function toISO(ts){ try { return new Date(ts).toISOString(); } catch { return ""; } }
function fmtTime(ts){
  try { return new Date(ts).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}); } catch { return "—"; }
}
function fmtDate(ts){
  try { return new Date(ts).toLocaleDateString(); } catch { return "—"; }
}
function durationOf(task){
  const d = typeof task.durationMin === "number" && task.durationMin > 0 ? task.durationMin : 15;
  return minutes(d);
}
function humanStrategy(name){
  const map = {
    "stagger-10": "Stagger by 10 min",
    "stagger-15": "Stagger by 15 min",
    "stagger-30": "Stagger by 30 min",
    "move-tomorrow-9": "Move to tomorrow 9:00",
    "move-window-next": "Move to next free window",
    "fit-within-window": "Distribute within conflict window",
    "merge-batch": "Merge into single batch",
    "split-batch": "Split long tasks",
    "respect-capacity": "Limit parallel to capacity",
    "reorder-priority": "Reorder by priority",
  };
  return map[name] || name;
}

/* ---------------------- availability + scheduling core --------------------- */
// Prepares a map of busy intervals from calendarEvents + provided tasks
function buildBusyIntervals(calendarEvents = [], tasks = []) {
  const arr = [];
  calendarEvents.forEach(ev=>{
    if (!ev?.start || !ev?.end) return;
    arr.push([ev.start, ev.end]);
  });
  tasks.forEach(t=>{
    const st = t?.scheduled?.start, en = t?.scheduled?.end;
    if (st && en) arr.push([st, en]);
  });
  // merge overlaps
  arr.sort((a,b)=>a[0]-b[0]);
  const merged = [];
  for (const [s,e] of arr){
    if (!merged.length || s > merged[merged.length-1][1]) merged.push([s,e]);
    else merged[merged.length-1][1] = Math.max(merged[merged.length-1][1], e);
  }
  return merged;
}

function isFree(mergedBusy, start, end) {
  // binary-ish scan (linear here, small sets expected)
  for (const [s,e] of mergedBusy){
    if (end <= s) return true;
    if (start < e && end > s) return false;
  }
  return true; // after last busy block
}

function findNextSlot(mergedBusy, desiredStart, durationMs, workHours = {startHour:7, endHour:19}, stepMin = 5) {
  const step = minutes(stepMin);
  let t = desiredStart;
  // normalize to work hours
  const dayStart = (ts)=>{
    const d = new Date(ts);
    d.setHours(workHours.startHour,0,0,0);
    return d.getTime();
  };
  const dayEnd = (ts)=>{
    const d = new Date(ts);
    d.setHours(workHours.endHour,0,0,0);
    return d.getTime();
  };
  // snap to at-least dayStart
  if (t < dayStart(t)) t = dayStart(t);

  for (let i=0; i<5000; i++){ // guard
    const windowEnd = t + durationMs;
    const ds = dayStart(t), de = dayEnd(t);
    if (windowEnd > de) { // move to next day start
      t = dayStart(t + minutes(24*60));
      continue;
    }
    if (isFree(mergedBusy, t, windowEnd)) return [t, windowEnd];
    t += step;
  }
  return null;
}

function distributeWithinWindow(windowRange, tasks, mergedBusy, workHours, spacingMin = 10) {
  const res = [];
  let cursor = clamp(windowRange.start, windowRange.start, windowRange.end);
  for (const t of tasks){
    const d = durationOf(t);
    const slot = findNextSlot(mergedBusy, cursor, d, workHours, spacingMin);
    if (!slot) break;
    const [s, e] = slot;
    res.push({ taskId: t.id, scheduled: {start: s, end: e} });
    // push as busy for later tasks
    mergedBusy = buildBusyIntervals(
      [], // no calendar add here
      [{ scheduled: {start: s, end: e} }]
    ).concat(mergedBusy).sort((a,b)=>a[0]-b[0]);
    cursor = e + minutes(spacingMin);
  }
  return res;
}

function staggerStart(tasks, baseStart, mergedBusy, workHours, stepMin) {
  const res = [];
  let cursor = baseStart;
  for (const t of tasks){
    const d = durationOf(t);
    const slot = findNextSlot(mergedBusy, cursor, d, workHours, stepMin);
    if (!slot) break;
    const [s,e] = slot;
    res.push({ taskId: t.id, scheduled: {start:s, end:e} });
    mergedBusy = buildBusyIntervals([], [{ scheduled: {start:s, end:e} }]).concat(mergedBusy).sort((a,b)=>a[0]-b[0]);
    cursor = s + minutes(stepMin);
  }
  return res;
}

function mergeBatch(tasks, baseStart, mergedBusy, workHours) {
  // For actions like Butcher/Package/Clean where batching is efficient
  // Use total duration = max(duration) + setup overhead (5 min per extra task)
  if (!tasks.length) return [];
  const maxDur = Math.max(...tasks.map(durationOf));
  const overhead = minutes(Math.max(0, tasks.length - 1) * 5);
  const total = maxDur + overhead;
  const slot = findNextSlot(mergedBusy, baseStart, total, workHours, 5);
  if (!slot) return [];
  const [s,e] = slot;
  return tasks.map(t => ({ taskId: t.id, scheduled: {start:s, end:e}, notes: "Merged batch window"}));
}

function splitLongTasks(tasks, maxMin = 30) {
  // Split >maxMin tasks into two chunks with 5-min buffer
  const changes = [];
  tasks.forEach(t=>{
    const dMin = (t.durationMin ?? 15);
    if (dMin <= maxMin || !t?.scheduled?.start) return;
    const start = t.scheduled.start;
    const mid = start + minutes(Math.ceil(dMin/2));
    const end = t.scheduled.end ?? (start + minutes(dMin));
    // First half remains, second half becomes follow-up 5 min later (note only resolution sketch)
    changes.push({ taskId: t.id, scheduled: {start, end: mid - minutes(5)}, notes: "Split 1/2" });
    changes.push({ taskId: t.id + ":part2", scheduled: {start: mid + minutes(5), end}, notes: "Split 2/2 (new instance)" });
  });
  return changes;
}

function respectCapacity(tasks, capacity = 1, windowRange, mergedBusy, workHours) {
  // Group into chunks of size <= capacity and schedule sequentially
  const groups = [];
  for (let i=0; i<tasks.length; i+=capacity){
    groups.push(tasks.slice(i, i+capacity));
  }
  let cursor = windowRange?.start ?? (Date.now());
  const res = [];
  groups.forEach(group=>{
    const maxDur = Math.max(...group.map(durationOf));
    const slot = findNextSlot(mergedBusy, cursor, maxDur, workHours, 5);
    if (!slot) return;
    const [s,e] = slot;
    group.forEach(t=> res.push({ taskId: t.id, scheduled: {start:s, end:s + durationOf(t)} }));
    mergedBusy = buildBusyIntervals([], [{ scheduled: {start:s, end:e} }]).concat(mergedBusy).sort((a,b)=>a[0]-b[0]);
    cursor = e + minutes(5);
  });
  return res;
}

/* --------------------------------- UI bits -------------------------------- */
function Label({children}){ return <span className="text-[11px] font-medium text-gray-600">{children}</span>; }
function Chip({children, tone="gray"}) {
  const map = {
    gray: "border-gray-300 text-gray-700",
    blue: "border-blue-300 text-blue-700",
    green: "border-green-300 text-green-700",
    amber: "border-amber-300 text-amber-700",
    red: "border-red-300 text-red-700",
    purple: "border-purple-300 text-purple-700",
  };
  return <span className={cx("inline-block rounded-full border px-2 py-0.5 text-[11px]", map[tone] || map.gray)}>{children}</span>;
}
function IconButton({title, onClick, children, disabled}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className={cx("rounded-lg border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ----------------------------- main component ----------------------------- */
export default function ConflictResolverBar({
  conflicts = [],
  calendarEvents = [],
  onApply,
  onIgnore,
  getAvailability,
  checkSupplies,
  defaultWorkHours = { startHour: 7, endHour: 19 },
  className
}) {
  const Services = useMemo(()=>getServices(),[]);
  const [compact, setCompact] = useState(false);
  const [preview, setPreview] = useState([]); // Resolution[]
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // persisted strategy choice (per session)
  const [strategy, setStrategy] = useState("stagger-15");

  useEffect(()=>{
    Services.analytics()?.track?.("animals:planner:conflicts:init", { count: conflicts.length });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keyboard helpers
  useEffect(()=>{
    const onKey = (e)=>{
      const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase()==="r") { // apply resolutions
        e.preventDefault();
        handleApply();
      }
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase()==="i") { // ignore all
        e.preventDefault();
        ignoreAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return ()=>window.removeEventListener("keydown", onKey);
  }, [preview, conflicts]);

  const mergedBusyBase = useMemo(()=>buildBusyIntervals(calendarEvents, []), [calendarEvents]);

  function previewByStrategy(conflict, strat) {
    const items = (conflict.items || []).slice(0);
    // Prefer order: priority desc, then action grouping
    items.sort((a,b)=> (b.priority ?? 0) - (a.priority ?? 0) || String(a.action||"").localeCompare(String(b.action||"")));

    let res = [];
    let name = strat;

    const mergedBusy = buildBusyIntervals(calendarEvents, items.filter(t=>t.scheduled?.start && t.scheduled?.end));
    const baseStart = conflict.window?.start ?? (items[0]?.scheduled?.start ?? Date.now());

    if (strat.startsWith("stagger-")) {
      const step = Number(strat.split("-")[1]) || 15;
      res = staggerStart(items, baseStart, mergedBusy, defaultWorkHours, step);
    } else if (strat === "move-tomorrow-9") {
      const d = new Date(Date.now()); d.setDate(d.getDate()+1); d.setHours(9,0,0,0);
      const start = d.getTime();
      res = staggerStart(items, start, mergedBusyBase, defaultWorkHours, 10);
    } else if (strat === "fit-within-window" && conflict.window) {
      res = distributeWithinWindow(conflict.window, items, mergedBusy, defaultWorkHours, 10);
    } else if (strat === "move-window-next") {
      // find first task's desired start, then place all to next free slot block
      const total = items.reduce((sum,t)=> sum + durationOf(t) + minutes(5), 0);
      const slot = findNextSlot(mergedBusy, baseStart, total, defaultWorkHours, 5);
      if (slot) {
        const [s] = slot;
        res = staggerStart(items, s, mergedBusy, defaultWorkHours, 10);
      }
    } else if (strat === "merge-batch") {
      const batchable = ["Butcher","Package","Clean","Vaccinate","Deworm"];
      const mergeables = items.filter(t=> batchable.includes(t.action || ""));
      const others = items.filter(t=> !batchable.includes(t.action || ""));
      const merged = mergeBatch(mergeables, baseStart, mergedBusy, defaultWorkHours);
      const staggeredOthers = staggerStart(others, (merged[0]?.scheduled?.end ?? baseStart), mergedBusy, defaultWorkHours, 10);
      res = [...merged, ...staggeredOthers];
    } else if (strat === "split-batch") {
      res = splitLongTasks(items, 30);
    } else if (strat === "respect-capacity") {
      const cap = conflict.capacity?.maxParallel ?? 1;
      const win = conflict.window ?? { start: baseStart, end: baseStart + minutes(240) };
      res = respectCapacity(items, Math.max(1, cap), win, mergedBusy, defaultWorkHours);
    } else if (strat === "reorder-priority") {
      // reorder but keep initial slots if possible: bump high priority earlier via stagger
      res = staggerStart(items, baseStart, mergedBusy, defaultWorkHours, 5);
    }

    return {
      conflictId: conflict.id,
      strategy: name,
      changes: res
    };
  }

  function recomputePreview(selectedStrategy = strategy) {
    try {
      setError("");
      const results = conflicts.map(cf => previewByStrategy(cf, selectedStrategy));
      setPreview(results);
    } catch (e) {
      console.error(e);
      setError("Failed to compute a preview. Try a different strategy.");
    }
  }

  useEffect(()=>{ recomputePreview(strategy); /* eslint-disable-next-line */ }, [conflicts, strategy, defaultWorkHours.startHour, defaultWorkHours.endHour]);

  async function handleApply() {
    if (!preview.length) {
      Services.toast("Nothing to apply");
      return;
    }
    setBusy(true);
    try {
      // Optional supplies check for supply conflicts
      const supplyConflicts = conflicts.filter(c=>c.reason === "supply");
      if (supplyConflicts.length && typeof checkSupplies === "function") {
        const allTasks = supplyConflicts.flatMap(c=>c.items || []);
        const sOK = await checkSupplies(allTasks);
        if (sOK && sOK.ok === false) {
          Services.toast(`Missing supplies: ${(sOK.missing || []).join(", ")}`);
        }
      }

      onApply?.(preview);
      Services.bus()?.emit?.("animals:planner:conflicts:apply", { count: preview.length, strategy });
      Services.analytics()?.track?.("animals:planner:conflicts:apply", { count: preview.length, strategy });
      Services.toast("Resolutions applied");
    } catch (e) {
      console.error(e);
      setError("Apply failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function ignoreAll() {
    const ids = conflicts.map(c=>c.id);
    onIgnore?.(ids);
    Services.bus()?.emit?.("animals:planner:conflicts:ignore", { count: ids.length });
    Services.analytics()?.track?.("animals:planner:conflicts:ignore", { count: ids.length });
    Services.toast("Ignored");
  }

  function ignoreOne(id) {
    onIgnore?.([id]);
    Services.bus()?.emit?.("animals:planner:conflicts:ignore", { count: 1 });
  }

  function applyOne(conflictId) {
    const r = preview.find(p=>p.conflictId === conflictId);
    if (!r) return Services.toast("No preview for this conflict");
    onApply?.([r]);
    Services.bus()?.emit?.("animals:planner:conflicts:apply-one", { conflictId, strategy: r.strategy });
    Services.analytics()?.track?.("animals:planner:conflicts:apply-one", { conflictId, strategy: r.strategy });
    Services.toast("Resolved");
  }

  /* --------------------------------- UI --------------------------------- */
  const ConflictRow = ({ conflict }) => {
    const pv = preview.find(p=>p.conflictId === conflict.id);
    const changes = pv?.changes || [];
    const totalMin = (conflict.items || []).reduce((s,t)=> s + (t.durationMin ?? 15), 0);

    return (
      <div className="rounded-xl border p-3">
        <div className="mb-1 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold">Conflict</div>
              <Chip tone={conflict.reason === "overlap" ? "amber" : conflict.reason === "supply" ? "purple" : "red"}>
                {conflict.reason}
              </Chip>
              {conflict.window ? (
                <Chip tone="blue">
                  {fmtDate(conflict.window.start)} {fmtTime(conflict.window.start)} → {fmtTime(conflict.window.end)}
                </Chip>
              ) : null}
              {conflict.capacity?.maxParallel ? (
                <Chip tone="green">cap: {conflict.capacity.maxParallel}</Chip>
              ) : null}
              <Chip tone="gray">{conflict.items?.length || 0} task{(conflict.items?.length||0)===1?"":"s"}</Chip>
              <Chip tone="gray">{totalMin} min</Chip>
            </div>
            <div className="mt-1 text-[11px] text-gray-600">
              {(conflict.items || []).slice(0, 4).map(t => t.title).join(" • ")}
              {(conflict.items || []).length > 4 ? " …" : ""}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <IconButton title="Apply only this" onClick={()=>applyOne(conflict.id)}>Apply</IconButton>
            <IconButton title="Ignore" onClick={()=>ignoreOne(conflict.id)}>Ignore</IconButton>
          </div>
        </div>

        {/* preview table */}
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-left text-[12px]">
            <thead>
              <tr className="text-gray-500">
                <th className="py-1 pr-3 font-medium">Task</th>
                <th className="py-1 pr-3 font-medium">Kind</th>
                <th className="py-1 pr-3 font-medium">Action</th>
                <th className="py-1 pr-3 font-medium">Original</th>
                <th className="py-1 pr-3 font-medium">Suggested</th>
                <th className="py-1 pr-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {(conflict.items || []).map((t)=>{
                const sug = changes.find(c=>c.taskId === t.id || c.taskId?.startsWith?.(t.id));
                return (
                  <tr key={t.id} className="border-t">
                    <td className="py-1 pr-3">
                      <div className="truncate max-w-[240px]" title={t.title}>{t.title || t.id}</div>
                    </td>
                    <td className="py-1 pr-3">{t.kind || "—"}</td>
                    <td className="py-1 pr-3">{t.action || "—"}</td>
                    <td className="py-1 pr-3">
                      {t.scheduled?.start ? `${fmtTime(t.scheduled.start)} → ${fmtTime(t.scheduled.end)}` : "—"}
                    </td>
                    <td className="py-1 pr-3">
                      {sug?.scheduled ? `${fmtTime(sug.scheduled.start)} → ${fmtTime(sug.scheduled.end)}` : "—"}
                    </td>
                    <td className="py-1 pr-3">{sug?.notes || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* quick-strategy row (per conflict overrides global) */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            <Label>Try:</Label>
            {["stagger-10","stagger-15","fit-within-window","move-window-next","merge-batch","respect-capacity","split-batch","reorder-priority","move-tomorrow-9"].map(s=>(
              <button
                key={s}
                type="button"
                className="rounded-full border px-2.5 py-1 text-[11px] hover:bg-gray-50"
                onClick={()=> {
                  const individualized = previewByStrategy(conflict, s);
                  setPreview(prev => prev.map(p => p.conflictId === conflict.id ? individualized : p));
                  Services.analytics()?.track?.("animals:planner:conflicts:try", { conflictId: conflict.id, strategy: s });
                }}
              >
                {humanStrategy(s)}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-gray-500">
            Strategy: <strong>{humanStrategy(preview.find(p=>p.conflictId===conflict.id)?.strategy || strategy)}</strong>
          </div>
        </div>
      </div>
    );
  };

  /* -------------------------------- render -------------------------------- */
  return (
    <div className={cx("rounded-2xl border bg-white p-3 shadow-sm", className)}>
      {/* header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Resolve Conflicts</h3>
          <span className="text-[11px] text-gray-600">
            {conflicts.length} issue{conflicts.length===1?"":"s"}
          </span>
          {busy ? <span className="rounded-full bg-black px-2 py-0.5 text-[11px] text-white">Applying…</span> : null}
        </div>
        <div className="flex items-center gap-2">
          <Label>View</Label>
          <select
            className="rounded-lg border px-2 py-1 text-xs"
            value={compact ? "compact" : "comfortable"}
            onChange={(e)=>setCompact(e.target.value==="compact")}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
          <Label>Strategy</Label>
          <select
            className="rounded-lg border px-2 py-1 text-xs"
            value={strategy}
            onChange={(e)=>{ setStrategy(e.target.value); Services.bus()?.emit?.("animals:planner:conflicts:strategy", e.target.value); }}
          >
            <option value="stagger-15">Stagger by 15</option>
            <option value="stagger-10">Stagger by 10</option>
            <option value="fit-within-window">Fit within window</option>
            <option value="move-window-next">Move to next free</option>
            <option value="move-tomorrow-9">Move tomorrow 9:00</option>
            <option value="merge-batch">Merge batch</option>
            <option value="split-batch">Split long tasks</option>
            <option value="respect-capacity">Respect capacity</option>
            <option value="reorder-priority">Reorder by priority</option>
          </select>
        </div>
      </div>

      {/* bulk action bar */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
            onClick={()=>recomputePreview(strategy)}
            title="Rebuild preview"
          >
            Recompute Preview
          </button>
          <button
            type="button"
            className="rounded-lg bg-black px-3 py-1.5 text-xs text-white hover:opacity-90"
            onClick={handleApply}
            disabled={!preview.length || busy}
            title="Apply all (Ctrl/Cmd+R)"
          >
            Apply All
          </button>
          <button
            type="button"
            className="rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
            onClick={ignoreAll}
            title="Ignore all (Ctrl/Cmd+I)"
          >
            Ignore All
          </button>
        </div>
        <div className="text-[11px] text-gray-600">
          Previewing {preview.length} resolution{preview.length===1?"":"s"}
        </div>
      </div>

      {/* error */}
      {error ? (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {/* conflicts list */}
      {conflicts.length === 0 ? (
        <div className="rounded-2xl border p-6 text-center text-sm text-gray-600">
          No conflicts 🎉
        </div>
      ) : (
        <div className={cx("grid gap-2", compact ? "md:grid-cols-1" : "md:grid-cols-1")}>
          {conflicts.map(cf => <ConflictRow key={cf.id} conflict={cf} />)}
        </div>
      )}

      {/* footer hint */}
      <div className="mt-3 text-[11px] text-gray-500">
        Tips: Use <code>{"Ctrl/Cmd+R"}</code> to apply all, <code>{"Ctrl/Cmd+I"}</code> to ignore all. Strategies like <code>{"merge-batch"}</code> are great for butchery/packaging/cleaning runs; <code>{"respect-capacity"}</code> limits concurrent work to your crew size.
      </div>
    </div>
  );
}
