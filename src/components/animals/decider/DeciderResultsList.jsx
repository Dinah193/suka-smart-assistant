/* eslint-disable no-console */
// src/components/animals/decider/DeciderResultsList.jsx
//
// Animals → Decider Results List
//
// Goals
// - Fast, scannable results with multi-select, bulk actions, and keyboard shortcuts
// - Sort by relevance/date/duration/kind/action; client-side pagination with "virtual-ish" window
// - Defensive integrations: eventBus, analytics, reminders, NBA orchestrator (all optional)
// - Inline quick actions per row: Open, Queue, Schedule, Edit, More (emit events; do not hard-depend on services)
// - Clear empty, loading, and error states + optimistic toasts
// - Works with Tailwind only (no external UI libs)
//
// Props
// - items?: Array<ResultItem>               // already filtered; we render, sort, and paginate
// - loading?: boolean
// - error?: string
// - sortBy?: "relevance"|"date"|"duration"|"kind"|"action"
// - sortDir?: "asc"|"desc"
// - pageSize?: number                        // default 30
// - onSortChange?: (by, dir) => void
// - onOpen?: (item) => void
// - onEdit?: (item) => void
// - onQueue?: (items) => void
// - onSchedule?: (items) => void
// - onImport?: (items) => void               // Save/Import into library/log
// - onExport?: (items, format) => void       // e.g., "csv"
// - dedupeMap?: Map<string, {matchId:string, versionable?:boolean}>
// - className?: string
//
// ResultItem (suggested)
// {
//   id?: string,
//   url?: string,
//   title: string,
//   kind?: "Poultry"|"Sheep"|"Goat"|"Beef"|"Rabbit"|"Fish",
//   action?: "Feed"|"Water"|"Deworm"|"Vaccinate"|"Clean"|"Inspect"|"Butcher"|"Package",
//   tags?: string[],
//   supplies?: Array<{name:string, qty?:number, unit?:string}> | string[],
//   durationMin?: number,
//   occurredAt?: string,        // ISO when relevant (logs/tasks)
//   status?: "unplanned"|"queued"|"scheduled"|"completed",
//   source?: { site?: string, author?: string },
//   duplicateKey?: string       // for local dedupe display
// }

import React, { useEffect, useMemo, useRef, useState } from "react";

function cx(...a){ return a.filter(Boolean).join(" "); }

function getServices() {
  return {
    bus: () => (window?.eventBus || window?.ssa?.eventBus || null),
    analytics: () => (window?.ssa?.analytics || null),
    reminders: () => (window?.ssa?.services?.reminders || window?.ReminderManager || null),
    nba: () => (window?.ssa?.services?.nba || window?.NBAOrchestrator || null),
    toast(msg){ try { window?.ssa?.ui?.toast?.(msg); } catch { console.log("[toast]", msg); } }
  };
}

/* --------------------------------- small UI -------------------------------- */
function Badge({ children, tone="gray" }) {
  const tones = {
    gray: "border-gray-300 text-gray-700",
    blue: "border-blue-300 text-blue-700",
    green: "border-green-300 text-green-700",
    amber: "border-amber-300 text-amber-700",
    red: "border-red-300 text-red-700",
    violet: "border-violet-300 text-violet-700",
  };
  return (
    <span className={cx("inline-block rounded-full border px-2 py-0.5 text-[11px]", tones[tone] || tones.gray)}>
      {children}
    </span>
  );
}

function IconButton({ title, onClick, children, disabled }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className={cx(
        "rounded-lg border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function EmptyState({ title="No results", subtitle="Try adjusting filters or search terms." }) {
  return (
    <div className="rounded-2xl border p-8 text-center">
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-xs text-gray-600">{subtitle}</div>
    </div>
  );
}

function ErrorState({ message }) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {message || "Something went wrong."}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="grid grid-cols-[18px_1fr_auto] items-center gap-3 rounded-xl border p-3 animate-pulse">
      <div className="h-4 w-4 rounded bg-gray-200" />
      <div className="min-w-0">
        <div className="h-4 w-1/2 rounded bg-gray-200" />
        <div className="mt-2 flex gap-2">
          <div className="h-3 w-16 rounded bg-gray-200" />
          <div className="h-3 w-24 rounded bg-gray-200" />
          <div className="h-3 w-12 rounded bg-gray-200" />
        </div>
      </div>
      <div className="h-7 w-44 rounded bg-gray-200" />
    </div>
  );
}

/* --------------------------------- helpers -------------------------------- */
function fmtDuration(n){
  if (typeof n !== "number" || isNaN(n)) return "—";
  return `${n} min`;
}
function fmtDate(iso){
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}`;
  } catch { return "—"; }
}
function toCSV(rows){
  const headers = ["title","kind","action","durationMin","occurredAt","status","tags","supplies","site","author","url"];
  const esc = (v)=> {
    const s = Array.isArray(v) ? v.join(" | ") : (v ?? "");
    const needsQuote = /[",\n]/.test(String(s));
    return needsQuote ? `"${String(s).replace(/"/g,'""')}"` : s;
  };
  const lines = [
    headers.join(","),
    ...rows.map(r => {
      const supplies = Array.isArray(r.supplies)
        ? r.supplies.map(s => (typeof s === "string" ? s : `${s.name}${s.qty ? ` ${s.qty}` : ""}${s.unit ? ` ${s.unit}` : ""}`)).join(" | ")
        : "";
      return [
        r.title || "",
        r.kind || "",
        r.action || "",
        r.durationMin ?? "",
        r.occurredAt || "",
        r.status || "",
        (r.tags || []).join(" | "),
        supplies,
        r.source?.site || "",
        r.source?.author || "",
        r.url || ""
      ].map(esc).join(",");
    })
  ].join("\n");
  return new Blob([lines], { type: "text/csv;charset=utf-8" });
}

/* ----------------------------- main component ----------------------------- */
export default function DeciderResultsList({
  items = [],
  loading = false,
  error = "",
  sortBy = "relevance",
  sortDir = "desc",
  pageSize = 30,
  onSortChange,
  onOpen,
  onEdit,
  onQueue,
  onSchedule,
  onImport,
  onExport,
  dedupeMap,
  className
}) {
  const Services = useMemo(()=>getServices(),[]);
  const [dir, setDir] = useState(sortDir);
  const [by, setBy] = useState(sortBy);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(()=>new Set());

  // shift-select
  const lastCheckedIndexRef = useRef(null);

  useEffect(()=>{
    Services.analytics()?.track?.("animals:decider:results:init", { count: items?.length || 0 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sorted = useMemo(()=>{
    const arr = Array.isArray(items) ? items.slice(0) : [];
    const compare = {
      relevance: (a,b) => 0, // assume upstream ranking; stable
      date: (a,b) => new Date(a.occurredAt || 0) - new Date(b.occurredAt || 0),
      duration: (a,b) => (a.durationMin ?? 1e9) - (b.durationMin ?? 1e9),
      kind: (a,b) => String(a.kind||"").localeCompare(String(b.kind||"")),
      action: (a,b) => String(a.action||"").localeCompare(String(b.action||"")),
    }[by] || ((a,b)=>0);
    arr.sort(compare);
    if (dir === "desc") arr.reverse();
    return arr;
  }, [items, by, dir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(()=>{ if (page > totalPages) setPage(totalPages); }, [totalPages, page]);
  const pageStart = (page - 1) * pageSize;
  const pageSlice = sorted.slice(pageStart, pageStart + pageSize);

  // selection helpers
  const isSelected = (id) => selected.has(id);
  const toggleOne = (id, checked) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };
  const onRowCheckbox = (indexOnPage, id, checked, event) => {
    if (event.shiftKey && lastCheckedIndexRef.current != null) {
      const start = Math.min(lastCheckedIndexRef.current, indexOnPage);
      const end = Math.max(lastCheckedIndexRef.current, indexOnPage);
      setSelected(prev=>{
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          const row = pageSlice[i];
          if (!row) continue;
          checked ? next.add(row.id || row.url || `${i}`) : next.delete(row.id || row.url || `${i}`);
        }
        return next;
      });
    } else {
      toggleOne(id, checked);
    }
    lastCheckedIndexRef.current = indexOnPage;
  };
  const allCheckedOnPage = pageSlice.length > 0 && pageSlice.every((r, i) => {
    const key = r.id || r.url || String(i + pageStart);
    return selected.has(key);
  });
  const toggleAllOnPage = (checked) => {
    setSelected(prev => {
      const next = new Set(prev);
      pageSlice.forEach((r, i)=>{
        const key = r.id || r.url || String(i + pageStart);
        if (checked) next.add(key); else next.delete(key);
      });
      return next;
    });
  };
  const selectedRows = useMemo(()=>{
    const keys = Array.from(selected.values());
    const map = new Map();
    items.forEach((r, i)=> map.set(r.id || r.url || String(i), r));
    return keys.map(k => map.get(k)).filter(Boolean);
  }, [selected, items]);

  // keyboard enhancements
  useEffect(()=>{
    const onKey = (e) => {
      const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform);
      // Select all on page
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        toggleAllOnPage(true);
      }
      // Clear selection
      if (e.key === "Escape") {
        setSelected(new Set());
      }
      // Quick actions
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "e") {
        // export selection
        doExportCSV();
      }
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "q") {
        // queue selection
        if (selectedRows.length) doQueue(selectedRows);
      }
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "s") {
        // schedule selection
        if (selectedRows.length) doSchedule(selectedRows);
      }
    };
    window.addEventListener("keydown", onKey);
    return ()=>window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRows]);

  // actions
  const toast = (m)=>Services.toast(m);

  const doOpen = (row)=> {
    if (onOpen) onOpen(row);
    else if (row.url) window.open(row.url, "_blank", "noreferrer");
  };
  const doEdit = (row)=> {
    if (onEdit) onEdit(row);
    else {
      const t = prompt("Edit title", row.title || "") ?? row.title;
      Services.bus()?.emit?.("animals:decider:edit", { id: row.id, changes: { title: t } });
      toast("Edited");
    }
  };
  const doQueue = (rows)=> {
    if (!rows?.length) return toast("Select at least one item");
    onQueue?.(rows);
    Services.bus()?.emit?.("animals:decider:queue", { count: rows.length });
    Services.analytics()?.track?.("animals:decider:queue", { count: rows.length });
    toast("Queued");
  };
  const doSchedule = (rows)=> {
    if (!rows?.length) return toast("Select at least one item");
    onSchedule?.(rows);
    try {
      // heuristic: schedule follow-up tomorrow 9am
      const when = new Date(); when.setDate(when.getDate()+1); when.setHours(9,0,0,0);
      rows.forEach(r=>{
        Services.reminders()?.schedule?.({
          title: `Animals: ${r.action || "Task"} ${r.kind || ""}`.trim(),
          notes: r.title,
          when: when.toISOString(),
          metadata: { id: r.id, url: r.url }
        });
      });
    } catch {}
    Services.bus()?.emit?.("animals:decider:schedule", { count: rows.length });
    Services.analytics()?.track?.("animals:decider:schedule", { count: rows.length });
    toast("Scheduled");
  };
  const doImport = (rows)=> {
    if (!rows?.length) return toast("Select at least one item");
    onImport?.(rows);
    Services.bus()?.emit?.("animals:decider:import", { count: rows.length });
    Services.analytics()?.track?.("animals:decider:import", { count: rows.length });
    toast("Saved");
  };
  const doExportCSV = ()=> {
    const rows = selectedRows.length ? selectedRows : pageSlice; // export selection or current page
    if (!rows.length) return toast("Nothing to export");
    if (onExport) return onExport(rows, "csv");
    const blob = toCSV(rows);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "animals-decider-results.csv";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("Exported CSV");
  };

  function changeSort(newBy){
    let newDir = dir;
    if (newBy === by) newDir = dir === "asc" ? "desc" : "asc";
    else { newDir = newBy === "relevance" ? "desc" : "asc"; }
    setBy(newBy);
    setDir(newDir);
    onSortChange?.(newBy, newDir);
  }

  /* ---------------------------------- row ---------------------------------- */
  const Row = ({ row, indexOnPage }) => {
    const key = row.id || row.url || String(indexOnPage);
    const dupInfo = row.duplicateKey ? dedupeMap?.get(row.duplicateKey) : dedupeMap?.get(row.url || "");
    const isDup = !!dupInfo;

    return (
      <div className="grid grid-cols-[18px_1fr_auto] items-center gap-3 rounded-xl border p-3 hover:bg-gray-50">
        {/* checkbox */}
        <div className="pt-0.5">
          <input
            type="checkbox"
            className="h-4 w-4 accent-black"
            checked={isSelected(key)}
            onChange={(e)=>onRowCheckbox(indexOnPage, key, e.target.checked, e)}
          />
        </div>

        {/* main */}
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold" title={row.title || ""}>
                {row.title || "Untitled"}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                {row.kind ? <Badge tone="blue">{row.kind}</Badge> : null}
                {row.action ? <Badge tone="violet">{row.action}</Badge> : null}
                {typeof row.durationMin === "number" ? <Badge tone="amber">{fmtDuration(row.durationMin)}</Badge> : null}
                {row.occurredAt ? <Badge tone="green">{fmtDate(row.occurredAt)}</Badge> : null}
                {row.source?.site ? <Badge tone="gray">{row.source.site}</Badge> : null}
                {row.status ? <Badge tone={row.status==="completed"?"green":row.status==="scheduled"?"blue":row.status==="queued"?"amber":"gray"}>{row.status}</Badge> : null}
                {isDup ? <Badge tone="red">Duplicate</Badge> : null}
              </div>
            </div>
          </div>

          {/* tags + supplies */}
          {(row.tags?.length || row.supplies?.length) ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-700">
              {row.tags?.length ? (
                <div className="flex flex-wrap gap-1">
                  {row.tags.slice(0, 6).map((t)=>(
                    <span key={t} className="rounded-full bg-gray-100 px-2 py-0.5">#{t}</span>
                  ))}
                  {row.tags.length > 6 ? <span className="text-gray-500">+{row.tags.length - 6}</span> : null}
                </div>
              ) : null}
              {row.supplies?.length ? (
                <div className="truncate">
                  <span className="font-medium">Supplies:</span>{" "}
                  {Array.isArray(row.supplies)
                    ? row.supplies.map((s,i)=> typeof s === "string"
                        ? s
                        : `${s.name}${s.qty ? ` ${s.qty}` : ""}${s.unit ? ` ${s.unit}` : ""}`
                      ).join(", ")
                    : ""}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* actions */}
        <div className="flex items-center gap-2">
          <IconButton title="Open" onClick={()=>doOpen(row)}>Open</IconButton>
          <IconButton title="Queue" onClick={()=>doQueue([row])}>Queue</IconButton>
          <IconButton title="Schedule" onClick={()=>doSchedule([row])}>Schedule</IconButton>
          <IconButton title="Edit" onClick={()=>doEdit(row)}>Edit</IconButton>
        </div>
      </div>
    );
  };

  /* --------------------------------- render -------------------------------- */
  return (
    <div className={cx("rounded-2xl border bg-white p-3 shadow-sm", className)}>
      {/* header bar */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Results</h3>
          <span className="text-[11px] text-gray-600">
            {loading ? "Loading…" : `${sorted.length} item${sorted.length===1 ? "" : "s"}`}
          </span>
          {selected.size > 0 ? (
            <span className="rounded-full bg-black px-2 py-0.5 text-[11px] text-white">
              {selected.size} selected
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[11px] text-gray-600">Sort</label>
          <select
            className="rounded-lg border px-2 py-1 text-xs"
            value={by}
            onChange={(e)=>changeSort(e.target.value)}
          >
            <option value="relevance">Relevance</option>
            <option value="date">Date</option>
            <option value="duration">Duration</option>
            <option value="kind">Kind</option>
            <option value="action">Action</option>
          </select>
          <button
            type="button"
            className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50"
            onClick={()=>changeSort(by)}
            title="Toggle direction"
          >
            {dir === "asc" ? "Asc" : "Desc"}
          </button>
        </div>
      </div>

      {/* bulk bar */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="h-4 w-4 accent-black"
              checked={allCheckedOnPage}
              onChange={(e)=>toggleAllOnPage(e.target.checked)}
            />
            <span>Select page</span>
          </label>
          <button
            type="button"
            className="rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
            onClick={()=>setSelected(new Set())}
          >
            Clear selection
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <IconButton title="Save/Import selected" onClick={()=>doImport(selectedRows)}>
            Save
          </IconButton>
          <IconButton title="Queue selected (Ctrl/Cmd+Q)" onClick={()=>doQueue(selectedRows)}>
            Queue
          </IconButton>
          <IconButton title="Schedule selected (Ctrl/Cmd+S)" onClick={()=>doSchedule(selectedRows)}>
            Schedule
          </IconButton>
          <IconButton title="Export CSV (Ctrl/Cmd+E)" onClick={doExportCSV}>
            Export CSV
          </IconButton>
        </div>
      </div>

      {/* states */}
      {error ? <ErrorState message={error} /> : null}
      {loading && !items.length ? (
        <div className="grid gap-2">
          {Array.from({ length: 6 }).map((_,i)=><SkeletonRow key={i} />)}
        </div>
      ) : null}
      {!loading && !error && sorted.length === 0 ? <EmptyState /> : null}

      {/* list */}
      {!error && sorted.length > 0 ? (
        <div className="grid gap-2">
          {pageSlice.map((row, i)=>(
            <Row
              key={row.id || row.url || String(i + pageStart)}
              row={row}
              indexOnPage={i}
            />
          ))}
        </div>
      ) : null}

      {/* pagination */}
      {sorted.length > pageSize ? (
        <div className="mt-3 flex items-center justify-between">
          <div className="text-[11px] text-gray-600">
            Page {page} of {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
              disabled={page <= 1}
              onClick={()=>setPage(p=>Math.max(1, p-1))}
            >
              Prev
            </button>
            <button
              type="button"
              className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
              disabled={page >= totalPages}
              onClick={()=>setPage(p=>Math.min(totalPages, p+1))}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
