/* eslint-disable no-console */
// src/components/animals/decider/DeciderFiltersBar.jsx
//
// Animals → Decider Filters Bar
//
// Highlights
// - Faceted filters: kind, action, tags, duration, supplies, date range, status
// - Power search: "kind:sheep action:feed tag:layer duration<=15 date:today"
// - Quick presets: Care Today, Health Week, Butchery Prep, Water Run
// - Compact/Comfortable views; keyboard focus; optimistic clear/apply
// - URL querystring sync (optional) + localStorage persistence
// - Emits analytics + eventBus signals (defensive if services absent)
// - Works without shadcn or external UI libs; Tailwind classes only
//
// Props
// - value?: FilterState
// - onChange?: (state) => void
// - onApply?: (state) => void
// - onReset?: () => void
// - options?: { kinds?: string[], actions?: string[], tags?: string[], supplies?: string[] }
// - counts?: { total?: number, filtered?: number }
// - syncQuerystring?: boolean (default true)
// - storageKey?: string (default 'ssa.animals.decider.filters')
// - className?: string
//
// FilterState
// {
//   q: string,
//   kinds: string[],
//   actions: string[],
//   tags: string[],
//   supplies: string[],
//   duration: { min?: number, max?: number },
//   date: { from?: string, to?: string }, // ISO (date-only ok)
//   status: ("unplanned"|"queued"|"scheduled"|"completed")[],
//   versionedOnly: boolean,
//   includeExisting: boolean
// }

import React, { useEffect, useMemo, useRef, useState } from "react";

function cx(...a){ return a.filter(Boolean).join(" "); }
const KIND_OPTS = ["Poultry","Sheep","Goat","Beef","Rabbit","Fish"];
const ACTION_OPTS = ["Feed","Water","Deworm","Vaccinate","Clean","Inspect","Butcher","Package"];
const STATUS_OPTS = ["unplanned","queued","scheduled","completed"];

const DEFAULTS = {
  q: "",
  kinds: [],
  actions: [],
  tags: [],
  supplies: [],
  duration: { min: undefined, max: undefined },
  date: { from: undefined, to: undefined },
  status: [],
  versionedOnly: false,
  includeExisting: true
};

function getServices() {
  return {
    bus: () => (window?.eventBus || window?.ssa?.eventBus || null),
    analytics: () => (window?.ssa?.analytics || null),
    nba: () => (window?.ssa?.services?.nba || window?.NBAOrchestrator || null),
    toast(msg){ try { window?.ssa?.ui?.toast?.(msg); } catch { console.log("[toast]", msg); } }
  };
}

/* ------------------------ URL & Storage Utilities ------------------------ */
function readQuery() {
  if (typeof window === "undefined") return {};
  const p = new URLSearchParams(window.location.search);
  const obj = {};
  for (const [k,v] of p.entries()) obj[k] = v;
  return obj;
}
function writeQuery(state) {
  if (typeof window === "undefined") return;
  const p = new URLSearchParams(window.location.search);
  // only write meaningful keys
  const setOrDel = (key, val) => {
    if (val === undefined || val === null || val === "" || (Array.isArray(val) && val.length === 0)) p.delete(key);
    else p.set(key, String(val));
  };
  setOrDel("q", state.q);
  setOrDel("kinds", (state.kinds||[]).join(","));
  setOrDel("actions", (state.actions||[]).join(","));
  setOrDel("tags", (state.tags||[]).join(","));
  setOrDel("supplies", (state.supplies||[]).join(","));
  setOrDel("durMin", state.duration?.min ?? "");
  setOrDel("durMax", state.duration?.max ?? "");
  setOrDel("from", state.date?.from ?? "");
  setOrDel("to", state.date?.to ?? "");
  setOrDel("status", (state.status||[]).join(","));
  setOrDel("versionedOnly", state.versionedOnly ? "1" : "");
  setOrDel("includeExisting", state.includeExisting ? "1" : "0");

  const next = `${window.location.pathname}?${p.toString()}${window.location.hash || ""}`;
  window.history.replaceState({}, "", next);
}
function parseList(s){ return (s||"").split(",").map(x=>x.trim()).filter(Boolean); }
function readFromQueryIntoState(base) {
  const q = readQuery();
  const st = { ...base };
  if (q.q) st.q = q.q;
  if (q.kinds) st.kinds = parseList(q.kinds);
  if (q.actions) st.actions = parseList(q.actions);
  if (q.tags) st.tags = parseList(q.tags);
  if (q.supplies) st.supplies = parseList(q.supplies);
  if (q.durMin) st.duration.min = Number(q.durMin);
  if (q.durMax) st.duration.max = Number(q.durMax);
  if (q.from) st.date.from = q.from;
  if (q.to) st.date.to = q.to;
  if (q.status) st.status = parseList(q.status);
  if (q.versionedOnly) st.versionedOnly = q.versionedOnly === "1";
  if ("includeExisting" in q) st.includeExisting = q.includeExisting !== "0";
  return st;
}
function loadStorage(key, base) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    return { ...base, ...parsed, duration:{...base.duration, ...(parsed.duration||{})}, date:{...base.date, ...(parsed.date||{})} };
  } catch { return base; }
}
function saveStorage(key, state) {
  try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
}

/* --------------------------- Power Search Parser --------------------------- */
// Supported tokens: kind:, action:, tag:, supply:, status:, dur<=, dur>=, date:
// date values: today, yesterday, thisweek, lastweek, YYYY-MM-DD (from/to by syntax "date:2025-10-20..2025-10-25")
function toISODateOnly(d){
  const y = d.getFullYear(); const m = String(d.getMonth()+1).padStart(2,"0"); const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function resolveDateKeyword(s){
  const now = new Date();
  const startOfWeek = (d) => {
    const n = new Date(d); const day = (n.getDay()+6)%7; // Monday=0
    n.setDate(n.getDate()-day); n.setHours(0,0,0,0);
    return n;
  };
  if (s==="today"){ const d = new Date(); d.setHours(0,0,0,0); return {from: toISODateOnly(d), to: toISODateOnly(d)}; }
  if (s==="yesterday"){ const d = new Date(); d.setDate(d.getDate()-1); d.setHours(0,0,0,0); return {from: toISODateOnly(d), to: toISODateOnly(d)}; }
  if (s==="thisweek"){ const a = startOfWeek(now); const b = new Date(a); b.setDate(a.getDate()+6); return {from: toISODateOnly(a), to: toISODateOnly(b)}; }
  if (s==="lastweek"){ const a = startOfWeek(now); a.setDate(a.getDate()-7); const b = new Date(a); b.setDate(a.getDate()+6); return {from: toISODateOnly(a), to: toISODateOnly(b)}; }
  return null;
}
function parsePowerQuery(q, into) {
  const state = JSON.parse(JSON.stringify(into || DEFAULTS));
  const tokens = (q||"").match(/"[^"]+"|\S+/g) || [];
  const free = [];
  tokens.forEach(tok=>{
    const t = tok.replace(/^"|"$/g,"");
    // range date e.g. date:2025-10-20..2025-10-25
    if (/^date:/.test(t)){
      const val = t.slice(5);
      const kw = resolveDateKeyword(val);
      if (kw){ state.date.from = kw.from; state.date.to = kw.to; return; }
      if (val.includes("..")){
        const [a,b] = val.split("..");
        if (a) state.date.from = a;
        if (b) state.date.to = b;
      } else {
        state.date.from = val; state.date.to = val;
      }
      return;
    }
    if (/^kind:/i.test(t)){ state.kinds = Array.from(new Set([...state.kinds, t.slice(5)])); return; }
    if (/^action:/i.test(t)){ state.actions = Array.from(new Set([...state.actions, t.slice(7)])); return; }
    if (/^tag:/i.test(t)){ state.tags = Array.from(new Set([...state.tags, t.slice(4)])); return; }
    if (/^supply:/i.test(t)){ state.supplies = Array.from(new Set([...state.supplies, t.slice(7)])); return; }
    if (/^status:/i.test(t)){ state.status = Array.from(new Set([...state.status, t.slice(7)])); return; }
    if (/^dur<=/i.test(t)){ const n = Number(t.slice(5)); if(!isNaN(n)) state.duration.max = n; return; }
    if (/^dur>=/i.test(t)){ const n = Number(t.slice(5)); if(!isNaN(n)) state.duration.min = n; return; }
    free.push(t);
  });
  state.q = free.join(" ");
  return state;
}

/* --------------------------------- UI Bits -------------------------------- */
function Label({children}){ return <span className="text-[11px] font-medium text-gray-600">{children}</span>; }
function Chip({children, active, onClick}) {
  return (
    <button
      type="button"
      className={cx(
        "rounded-full border px-2.5 py-1 text-xs",
        active ? "bg-black text-white border-black" : "hover:bg-gray-50"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function MultiSelect({value=[], options=[], placeholder="Any", onChange}) {
  const [open,setOpen]=useState(false);
  const ref = useRef(null);
  useEffect(()=>{
    const onDoc = (e)=>{ if (!ref.current) return; if (!ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return ()=>document.removeEventListener("mousedown", onDoc);
  },[]);
  const toggle = (opt)=>{
    const set = new Set(value);
    if (set.has(opt)) set.delete(opt); else set.add(opt);
    onChange?.(Array.from(set));
  };
  const summary = value.length ? `${value.length} selected` : placeholder;
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="w-full rounded-lg border px-3 py-2 text-xs text-left" onClick={()=>setOpen(v=>!v)}>
        {summary}
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-64 rounded-xl border bg-white p-2 shadow-lg">
          <div className="max-h-56 overflow-auto">
            {options.map(opt=>(
              <label key={opt} className="flex items-center gap-2 px-2 py-1 text-xs">
                <input type="checkbox" className="accent-black" checked={value.includes(opt)} onChange={()=>toggle(opt)} />
                <span>{opt}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50" onClick={()=>onChange?.([])}>Clear</button>
            <button className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50" onClick={()=>onChange?.(options.slice(0))}>All</button>
          </div>
        </div>
      )}
    </div>
  );
}
function NumberRange({value={}, onChange}) {
  const [min,setMin] = useState(value.min ?? "");
  const [max,setMax] = useState(value.max ?? "");
  useEffect(()=>{ setMin(value.min ?? ""); setMax(value.max ?? ""); },[value.min, value.max]);
  return (
    <div className="flex items-center gap-2">
      <input className="w-20 rounded-lg border px-2 py-1 text-xs" placeholder="min" value={min} onChange={e=>setMin(e.target.value)} onBlur={()=>onChange?.({min: min===""?undefined:Number(min), max: max===""?undefined:Number(max)})} />
      <span className="text-xs text-gray-500">to</span>
      <input className="w-20 rounded-lg border px-2 py-1 text-xs" placeholder="max" value={max} onChange={e=>setMax(e.target.value)} onBlur={()=>onChange?.({min: min===""?undefined:Number(min), max: max===""?undefined:Number(max)})} />
      <span className="text-[11px] text-gray-500">min</span>
    </div>
  );
}
function DateRange({value={}, onChange}) {
  const [from,setFrom] = useState(value.from || "");
  const [to,setTo] = useState(value.to || "");
  useEffect(()=>{ setFrom(value.from || ""); setTo(value.to || ""); },[value.from, value.to]);
  return (
    <div className="flex items-center gap-2">
      <input type="date" className="rounded-lg border px-2 py-1 text-xs" value={from} onChange={e=>{ setFrom(e.target.value); onChange?.({from:e.target.value||undefined,to}); }} />
      <span className="text-xs text-gray-500">to</span>
      <input type="date" className="rounded-lg border px-2 py-1 text-xs" value={to} onChange={e=>{ setTo(e.target.value); onChange?.({from, to:e.target.value||undefined}); }} />
    </div>
  );
}

/* -------------------------------- Component ------------------------------- */
export default function DeciderFiltersBar({
  value,
  onChange,
  onApply,
  onReset,
  options,
  counts,
  syncQuerystring = true,
  storageKey = "ssa.animals.decider.filters",
  className
}) {
  const Services = useMemo(()=>getServices(),[]);
  const opts = {
    kinds: options?.kinds?.length ? options.kinds : KIND_OPTS,
    actions: options?.actions?.length ? options.actions : ACTION_OPTS,
    tags: options?.tags || [],
    supplies: options?.supplies || []
  };

  const initial = useMemo(()=>{
    let base = { ...DEFAULTS };
    base = loadStorage(storageKey, base);
    if (syncQuerystring) base = readFromQueryIntoState(base);
    if (value) base = { ...base, ...value, duration:{...base.duration, ...(value.duration||{})}, date:{...base.date, ...(value.date||{})} };
    return base;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, syncQuerystring]);

  const [state,setState] = useState(initial);
  const [compact,setCompact] = useState(false);
  const qInputRef = useRef(null);

  useEffect(()=>{ saveStorage(storageKey, state); if (syncQuerystring) writeQuery(state); onChange?.(state); },[state]); // eslint-disable-line
  useEffect(()=>{ Services.analytics()?.track?.("animals:decider:filters:init", { compact }); },[]); // eslint-disable-line

  // Keyboard: Enter applies, Esc clears query focus, Ctrl/Cmd+K focus search
  useEffect(()=>{
    const onKey = (e)=>{
      const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase()==="k"){ e.preventDefault(); qInputRef.current?.focus(); }
      if (e.key==="Enter" && (document.activeElement===qInputRef.current)){ e.preventDefault(); onApply?.(state); Services.bus()?.emit?.("animals:decider:filters:apply", state); }
    };
    window.addEventListener("keydown", onKey);
    return ()=>window.removeEventListener("keydown", onKey);
  }, [state, onApply, Services]);

  const appliedCount = useMemo(()=>{
    let c = 0;
    if (state.q) c++;
    ["kinds","actions","tags","supplies","status"].forEach(k=>{ if ((state[k]||[]).length) c++; });
    if (state.duration?.min!=null || state.duration?.max!=null) c++;
    if (state.date?.from || state.date?.to) c++;
    if (state.versionedOnly) c++;
    if (state.includeExisting===false) c++;
    return c;
  },[state]);

  function update(patch) {
    setState((s)=>({...s, ...patch}));
  }
  function applyPreset(name) {
    const nowISO = toISODateOnly(new Date());
    let next = { ...DEFAULTS };
    switch(name){
      case "care-today":
        next = { ...next, date:{from:nowISO,to:nowISO}, actions:["Feed","Water","Clean","Inspect"] };
        break;
      case "health-week":
        next = { ...next, date: resolveDateKeyword("thisweek") || {}, actions:["Inspect","Vaccinate","Deworm"], versionedOnly:true };
        break;
      case "butchery-prep":
        next = { ...next, actions:["Butcher","Package","Clean"], supplies:["vacuum bags","labels","gloves"] };
        break;
      case "water-run":
        next = { ...next, actions:["Water"], duration:{max:15} };
        break;
      default: break;
    }
    setState(next);
    Services.bus()?.emit?.("animals:decider:filters:preset", { name, state: next });
    Services.analytics()?.track?.("animals:decider:filters:preset", { name });
  }
  function clearAll() {
    setState({ ...DEFAULTS });
    onReset?.();
    Services.bus()?.emit?.("animals:decider:filters:reset");
    Services.analytics()?.track?.("animals:decider:filters:reset");
  }
  function applyNow() {
    onApply?.(state);
    Services.bus()?.emit?.("animals:decider:filters:apply", state);
    Services.analytics()?.track?.("animals:decider:filters:apply", { appliedCount, total: counts?.total, filtered: counts?.filtered });
    Services.toast?.(`Applied ${appliedCount || 0} filter${appliedCount===1?"":"s"}`);
  }

  function parseAndMergeQueryString() {
    const parsed = parsePowerQuery(state.q, state);
    setState(parsed);
    Services.bus()?.emit?.("animals:decider:filters:parsed", parsed);
  }

  /* --------------------------------- Render -------------------------------- */
  return (
    <div className={cx("rounded-2xl border bg-white p-3 shadow-sm", className)}>
      {/* Top row */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Filters</h3>
          <span className="text-[11px] text-gray-500">
            {counts?.filtered!=null && counts?.total!=null
              ? `${counts.filtered} / ${counts.total}`
              : appliedCount ? `${appliedCount} active` : "none"}
          </span>
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
        </div>
      </div>

      {/* Search */}
      <div className="mb-3 flex flex-col gap-1">
        <input
          ref={qInputRef}
          className="w-full rounded-lg border px-3 py-2 text-sm"
          placeholder={`Search or type: kind:sheep action:feed tag:layer dur<=15 date:today — Press Enter to apply, Ctrl/Cmd+K to focus`}
          value={state.q}
          onChange={(e)=>update({ q: e.target.value })}
          onBlur={parseAndMergeQueryString}
        />
        <div className="text-[11px] text-gray-500">
          Tips: <code>date:2025-10-20..2025-10-25</code>, <code>status:queued</code>, <code>{"dur>=10"}</code>, <code>{"dur<=15"}</code>
        </div>
      </div>

      {/* Facets grid */}
      <div className={cx("grid gap-2", compact ? "md:grid-cols-3" : "md:grid-cols-4")}>
        <div className="grid gap-1">
          <Label>Kind</Label>
          <MultiSelect value={state.kinds} options={opts.kinds} onChange={(v)=>update({kinds:v})} />
        </div>
        <div className="grid gap-1">
          <Label>Action</Label>
          <MultiSelect value={state.actions} options={opts.actions} onChange={(v)=>update({actions:v})} />
        </div>
        <div className="grid gap-1">
          <Label>Tags</Label>
          <MultiSelect value={state.tags} options={opts.tags} onChange={(v)=>update({tags:v})} />
        </div>
        <div className="grid gap-1">
          <Label>Supplies</Label>
          <MultiSelect value={state.supplies} options={opts.supplies} onChange={(v)=>update({supplies:v})} />
        </div>
        <div className="grid items-center gap-1 md:col-span-2">
          <Label>Duration (min)</Label>
          <NumberRange value={state.duration} onChange={(v)=>update({duration:v})} />
        </div>
        <div className="grid items-center gap-1 md:col-span-2">
          <Label>Date Range</Label>
          <DateRange value={state.date} onChange={(v)=>update({date:v})} />
        </div>
        <div className="grid gap-1">
          <Label>Status</Label>
          <div className="flex flex-wrap gap-1">
            {STATUS_OPTS.map(s=>(
              <Chip
                key={s}
                active={state.status.includes(s)}
                onClick={()=>{
                  const set = new Set(state.status);
                  set.has(s) ? set.delete(s) : set.add(s);
                  update({ status: Array.from(set) });
                }}
              >
                {s}
              </Chip>
            ))}
          </div>
        </div>
        <div className="grid gap-1">
          <Label>Advanced</Label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="h-4 w-4 accent-black"
                checked={!!state.versionedOnly}
                onChange={(e)=>update({versionedOnly: e.target.checked})}
              />
              Versioned only
            </label>
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="h-4 w-4 accent-black"
                checked={!!state.includeExisting}
                onChange={(e)=>update({includeExisting: e.target.checked})}
              />
              Include existing
            </label>
          </div>
        </div>
      </div>

      {/* Presets & Actions */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          <Chip onClick={()=>applyPreset("care-today")}>Care Today</Chip>
          <Chip onClick={()=>applyPreset("health-week")}>Health Week</Chip>
          <Chip onClick={()=>applyPreset("butchery-prep")}>Butchery Prep</Chip>
          <Chip onClick={()=>applyPreset("water-run")}>Water Run</Chip>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={clearAll}>
            Clear All
          </button>
          <button className="rounded-lg bg-black px-3 py-2 text-xs text-white hover:opacity-90" onClick={applyNow}>
            Apply Filters
          </button>
        </div>
      </div>
    </div>
  );
}
