/* eslint-disable no-console */
// src/components/scheduler/SchedulerDevPanel.jsx
import React, { useEffect, useMemo, useRef, useState, Suspense } from "react";

/* --------------------------------- Tokens ---------------------------------- */
const cx = (...a) => a.filter(Boolean).join(" ");
const WRAP = "rounded-3xl border border-gray-200 bg-white shadow-sm";
const BTN  = "inline-flex items-center gap-2 rounded-2xl px-3 py-1.5 text-sm font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 active:translate-y-px";
const VAR  = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle:  "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost:   "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  danger:  "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
  warn:    "bg-amber-500 text-white hover:bg-amber-600 focus:ring-amber-600",
};
const CHIP = "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2.5 py-0.5 text-[11px] font-medium text-gray-700";
const FIELD = "w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600";

/* ----------------------------- Defensive imports ---------------------------- */
let eventBus = { emit(){}, on(){}, off(){} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
} catch(_){}

let automation = null;
try {
  const a = require("@/services/automation/runtime");
  automation = a && (a.automation || a.default) || null;
} catch(_){}

/* Favorites: Sessions (user-owned) */
let useFavoriteSessions = null;
try {
  const favMod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions = favMod && (favMod.useFavoriteSessions || favMod.default) || null;
} catch(_){}

/* Lazy: Save Session modal (optional) */
let SaveSessionModalLazy = null;
try {
  SaveSessionModalLazy = React.lazy(() => import("@/components/sessions/SaveSessionModal.jsx"));
} catch(_){}

/* ----------------------------------- Icons ---------------------------------- */
let I = {};
try {
  const L = require("lucide-react");
  I = {
    Clock: L.Clock3, Timer: L.Timer, Zap: L.Zap, Calendar: L.Calendar,
    Shield: L.Shield, Cloud: L.Cloud, Download: L.Download, Upload: L.Upload,
    Play: L.Play, Pause: L.Pause, Stop: L.StopCircle, Trash: L.Trash2,
    Star: L.Star, StarOff: L.StarOff, Refresh: L.RefreshCcw, X: L.X, Check: L.Check,
    Filter: L.Filter, Bug: L.Bug, Alert: L.AlertTriangle, Copy: L.Copy, Search: L.Search
  };
} catch(_){
  I = new Proxy({}, { get(){ return () => <span/>; }});
}

/* ---------------------------------- Utils ---------------------------------- */
const nowISO = () => new Date().toISOString();
const safeParse = (s, f=null) => { try { return JSON.parse(s); } catch{ return f; } };
const toastSafe = (message, variant) => { try { eventBus.emit("ui.toast", { message, variant: variant||"success" }); } catch{ variant==="error"?console.warn(message):console.log(message); } };

/* =============================== Dev Panel ================================= */
/**
 * SchedulerDevPanel
 *
 * Props:
 * - domain?: string (default "session")
 * - compact?: boolean
 *
 * Shows:
 *  - Timers (active/pending)
 *  - Anchors (time.at / time.every subscriptions)
 *  - Guard hits (sabbath/inventory/weather/pause/conflicts)
 *  - Favorites: user sessions (quick start/pin/save)
 *  - Event log
 */
export default function SchedulerDevPanel(props){
  const domain = props.domain || "session";
  const [tab, setTab] = useState("timers"); // timers | anchors | guards | favorites | log
  const [query, setQuery] = useState("");

  /* ---------------------------- Runtime snapshots --------------------------- */
  const [timers, setTimers] = useState([]);     // [{id,title,etaISO,kind:"timeout|interval",meta}]
  const [anchors, setAnchors] = useState([]);   // [{id,type:"time.at|time.every",value,meta}]
  const [guards, setGuards] = useState([]);     // [{id,kind,ok:boolean,notes,atISO}]
  const [logs, setLogs]     = useState([]);     // [{atISO, event, payload}]
  const logRef = useRef([]);

  const MAX_LOG = 250;

  /* ------------------------------ Favorites API ----------------------------- */
  let favApi = null;
  try { favApi = useFavoriteSessions ? useFavoriteSessions(domain) : null; } catch(_){}

  const [favList, setFavList] = useState(() => (favApi && favApi.list ? favApi.list() : []));
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [pendingSession, setPendingSession] = useState({ id: "", title: "" });

  function refreshFavorites(){
    try { setFavList(favApi && favApi.list ? favApi.list() : []); } catch(_){}
  }

  function toggleFav(id, meta){
    try {
      if (!favApi || !favApi.toggleFavorite) return;
      const next = favApi.toggleFavorite(id, meta || { id, title: String(id), domain });
      if (next && typeof next.then === "function"){
        next.then(() => refreshFavorites());
      } else {
        refreshFavorites();
      }
      toastSafe(next ? "Added to favorites." : "Removed from favorites.");
    } catch(e){ toastSafe("Favorite toggle failed.", "error"); }
  }

  function openSaveSessionDefault(){
    setPendingSession({ id: "__pending__", title: "My Session" });
    setSaveModalOpen(true);
  }

  function startSession(idOrTitle){
    try {
      const payload = { idOrTitle, domain, source: "SchedulerDevPanel" };
      if (automation && automation.sessions && automation.sessions.start){
        const maybe = automation.sessions.start(payload);
        if (maybe && typeof maybe.then === "function"){
          maybe.then(() => toastSafe("Start requested."));
        } else {
          toastSafe("Start requested.");
        }
      } else {
        eventBus.emit && eventBus.emit("session.start.requested", payload);
        toastSafe("Start requested.");
      }
    } catch(e){ toastSafe("Could not start session.", "error"); }
  }

  function pauseAll(){
    try {
      if (automation && automation.scheduler && automation.scheduler.pauseAll){
        const maybe = automation.scheduler.pauseAll({ domain, source: "SchedulerDevPanel" });
        maybe && typeof maybe.then === "function" ? maybe.then(()=>toastSafe("Pause requested.")) : toastSafe("Pause requested.");
      } else {
        eventBus.emit && eventBus.emit("scheduler.pause.requested", { domain, source:"SchedulerDevPanel" });
        toastSafe("Pause requested.");
      }
    } catch(e){ toastSafe("Pause failed.", "error"); }
  }

  /* --------------------------- Event wire-up (bus) -------------------------- */
  useEffect(() => {
    const onTimerUpsert = (p={}) => {
      setTimers((cur) => {
        const arr = Array.isArray(cur)? cur.slice():[];
        const idx = arr.findIndex(x => x && x.id === p.id);
        const next = Object.assign({}, arr[idx]||{}, p);
        if (idx >= 0) arr[idx] = next; else arr.unshift(next);
        return arr.slice(0, 200);
      });
      pushLog("automation.timer.upserted", p);
    };

    const onTimerRemoved = (p={}) => {
      setTimers((cur) => (Array.isArray(cur)? cur.filter(x => x.id !== p.id) : []));
      pushLog("automation.timer.removed", p);
    };

    const onAnchorUpsert = (p={}) => {
      setAnchors((cur) => {
        const arr = Array.isArray(cur)? cur.slice():[];
        const idx = arr.findIndex(x => x && x.id === p.id);
        const next = Object.assign({}, arr[idx]||{}, p);
        if (idx >= 0) arr[idx] = next; else arr.unshift(next);
        return arr.slice(0, 200);
      });
      pushLog("schedule.anchor.upserted", p);
    };

    const onAnchorRemoved = (p={}) => {
      setAnchors((cur) => (Array.isArray(cur)? cur.filter(x => x.id !== p.id) : []));
      pushLog("schedule.anchor.removed", p);
    };

    const onGuardHit = (p={}) => {
      setGuards((cur) => [{ id: p.id || p.kind || Math.random().toString(36).slice(2,7), kind: p.kind || "guard", ok: !!p.ok, notes: p.notes || "", atISO: p.atISO || nowISO() }, ...cur].slice(0, 200));
      pushLog("guard.hit", p);
    };

    const onConflict = (p={}) => { pushLog("planner.conflict.detected", p); };
    const onShortage = (p={}) => { pushLog("inventory.shortage.detected", p); };
    const onScheduleSaved = (p={}) => { pushLog("schedule.saved", p); };
    const onRuleSaved = (p={}) => { pushLog("automation.rule.saved", p); };

    // Subscribe
    try {
      eventBus.on && eventBus.on("automation.timer.upserted", onTimerUpsert);
      eventBus.on && eventBus.on("automation.timer.removed", onTimerRemoved);
      eventBus.on && eventBus.on("schedule.anchor.upserted", onAnchorUpsert);
      eventBus.on && eventBus.on("schedule.anchor.removed", onAnchorRemoved);
      eventBus.on && eventBus.on("guard.hit", onGuardHit);
      eventBus.on && eventBus.on("planner.conflict.detected", onConflict);
      eventBus.on && eventBus.on("inventory.shortage.detected", onShortage);
      eventBus.on && eventBus.on("schedule.saved", onScheduleSaved);
      eventBus.on && eventBus.on("automation.rule.saved", onRuleSaved);
    } catch(_){}

    // Optional boot snapshot from automation runtime
    try {
      if (automation && automation.scheduler && automation.scheduler.snapshot){
        const s = automation.scheduler.snapshot({ domain });
        if (s) {
          setTimers(Array.isArray(s.timers)? s.timers : []);
          setAnchors(Array.isArray(s.anchors)? s.anchors : []);
        }
      }
    } catch(_){}

    return () => {
      try {
        eventBus.off && eventBus.off("automation.timer.upserted", onTimerUpsert);
        eventBus.off && eventBus.off("automation.timer.removed", onTimerRemoved);
        eventBus.off && eventBus.off("schedule.anchor.upserted", onAnchorUpsert);
        eventBus.off && eventBus.off("schedule.anchor.removed", onAnchorRemoved);
        eventBus.off && eventBus.off("guard.hit", onGuardHit);
        eventBus.off && eventBus.off("planner.conflict.detected", onConflict);
        eventBus.off && eventBus.off("inventory.shortage.detected", onShortage);
        eventBus.off && eventBus.off("schedule.saved", onScheduleSaved);
        eventBus.off && eventBus.off("automation.rule.saved", onRuleSaved);
      } catch(_){}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  function pushLog(event, payload){
    logRef.current = [{ atISO: nowISO(), event, payload }, ...logRef.current].slice(0, MAX_LOG);
    setLogs(logRef.current);
  }

  /* -------------------------------- Filters --------------------------------- */
  const q = query.trim().toLowerCase();
  const filteredTimers  = useMemo(() => !q ? timers : timers.filter(t => JSON.stringify(t).toLowerCase().includes(q)), [timers, q]);
  const filteredAnchors = useMemo(() => !q ? anchors : anchors.filter(a => JSON.stringify(a).toLowerCase().includes(q)), [anchors, q]);
  const filteredGuards  = useMemo(() => !q ? guards : guards.filter(g => JSON.stringify(g).toLowerCase().includes(q)), [guards, q]);
  const filteredFavs    = useMemo(() => !q ? favList : favList.filter(f => JSON.stringify(f).toLowerCase().includes(q)), [favList, q]);
  const filteredLogs    = useMemo(() => !q ? logs : logs.filter(l => JSON.stringify(l).toLowerCase().includes(q)), [logs, q]);

  /* ------------------------------ Export/Import ------------------------------ */
  function exportJSON(){
    try {
      const dump = { at: nowISO(), domain, timers, anchors, guards, favList, logs };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `scheduler-dev-${domain}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toastSafe("Downloaded dev snapshot.");
    } catch(e){ toastSafe("Export failed.", "error"); }
  }

  function exportToCloud(provider){
    try {
      const dump = { at: nowISO(), domain, timers, anchors, guards, favList, logs };
      eventBus.emit && eventBus.emit("automation.rule.export.requested", {
        provider, rule: dump, filename: `scheduler-dev-${domain}.json`, source: "SchedulerDevPanel"
      });
      toastSafe(`Sent export to ${provider}.`);
    } catch(e){ toastSafe("Cloud export failed.", "error"); }
  }

  function importJSON(){
    try {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "application/json";
      inp.onchange = (ev) => {
        const file = ev.target && ev.target.files && ev.target.files[0];
        if (!file) return;
        const fr = new FileReader();
        fr.onload = () => {
          const data = safeParse(String(fr.result||""), null);
          if (!data) { toastSafe("Invalid JSON.", "error"); return; }
          setTimers(Array.isArray(data.timers)? data.timers : []);
          setAnchors(Array.isArray(data.anchors)? data.anchors : []);
          setGuards(Array.isArray(data.guards)? data.guards : []);
          setLogs(Array.isArray(data.logs)? data.logs : []);
          if (Array.isArray(data.favList) && data.favList.length && favApi && favApi.toggleFavorite){
            // Merge imported favorites into local
            data.favList.forEach((f) => { try { favApi.toggleFavorite(f.id, f); } catch(_){ } });
            refreshFavorites();
          }
          toastSafe("Imported dev snapshot.");
        };
        fr.readAsText(file);
      };
      inp.click();
    } catch(e){ toastSafe("Import failed.", "error"); }
  }

  /* --------------------------------- Render --------------------------------- */
  return (
    <section className={WRAP} aria-label="Scheduler Dev Panel">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gradient-to-r from-white to-gray-50 px-4 py-3 rounded-t-3xl">
        <div className="text-sm font-semibold text-gray-900">Scheduler Dev Panel</div>
        <span className={CHIP}>{domain}</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <I.Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
            <input className={cx(FIELD, "pl-8 w-56")} placeholder="Filter…" value={query} onChange={(e)=>setQuery(e.target.value)} />
          </div>
          <details className="relative">
            <summary className={cx(BTN, VAR.ghost, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
              <I.Download className="h-4 w-4" />
              Tools
            </summary>
            <div className="absolute right-0 z-10 mt-2 min-w-[15rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
              <MenuItem onClick={exportJSON} icon={<I.Download className="h-4 w-4" />} label="Export (.json)" />
              <MenuItem onClick={importJSON} icon={<I.Upload className="h-4 w-4" />} label="Import (.json)" />
              <div className="h-px bg-gray-100" />
              <MenuItem onClick={()=>exportToCloud("gdrive")} icon={<I.Cloud className="h-4 w-4" />} label="Export to Google Drive" />
              <MenuItem onClick={()=>exportToCloud("onedrive")} icon={<I.Cloud className="h-4 w-4" />} label="Export to OneDrive" />
            </div>
          </details>
          <button className={cx(BTN, VAR.subtle)} onClick={pauseAll}><I.Pause className="h-4 w-4" />Pause all</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-4 pt-3">
        <div className="flex flex-wrap gap-2">
          <Tab label="Timers"   id="timers"   icon={<I.Timer className="h-4 w-4" />} active={tab==="timers"}   onClick={()=>setTab("timers")} count={timers.length} />
          <Tab label="Anchors"  id="anchors"  icon={<I.Clock className="h-4 w-4" />} active={tab==="anchors"}  onClick={()=>setTab("anchors")} count={anchors.length} />
          <Tab label="Guards"   id="guards"   icon={<I.Shield className="h-4 w-4" />} active={tab==="guards"}   onClick={()=>setTab("guards")} count={guards.length} />
          <Tab label="Favorites" id="favorites" icon={<I.Star className="h-4 w-4" />} active={tab==="favorites"} onClick={()=>setTab("favorites")} count={favList.length} />
          <Tab label="Log"      id="log"      icon={<I.Bug className="h-4 w-4" />} active={tab==="log"}      onClick={()=>setTab("log")} count={logs.length} />
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-4">
        {tab === "timers" && <TimersTable items={filteredTimers} onStart={startSession} />}
        {tab === "anchors" && <AnchorsTable items={filteredAnchors} />}
        {tab === "guards"  && <GuardsTable items={filteredGuards} />}
        {tab === "favorites" && (
          <FavoritesPanel
            items={filteredFavs}
            onRefresh={refreshFavorites}
            onStart={startSession}
            onToggleFav={toggleFav}
            onOpenSave={() => openSaveSessionDefault()}
          />
        )}
        {tab === "log" && <LogPanel items={filteredLogs} />}
      </div>

      {/* Save session modal (lazy or inline fallback) */}
      {saveModalOpen ? (
        SaveSessionModalLazy ? (
          <Suspense fallback={null}>
            <SaveSessionModalLazy
              isOpen={true}
              onClose={()=>setSaveModalOpen(false)}
              domain={domain}
              sessionId={String(pendingSession.id || "__pending__")}
              defaultTitle={String(pendingSession.title || "My Session")}
              onSaved={(saved)=>{
                try { eventBus.emit && eventBus.emit("session.saved", { from: "SchedulerDevPanel", saved }); } catch(_){}
                toastSafe("Session saved.");
                setSaveModalOpen(false);
                refreshFavorites();
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSession
            domain={domain}
            sessionId={String(pendingSession.id || "__pending__")}
            defaultTitle={String(pendingSession.title || "My Session")}
            onClose={()=>setSaveModalOpen(false)}
            onSaved={(saved)=>{
              try { eventBus.emit && eventBus.emit("session.saved", { from: "SchedulerDevPanel", saved }); } catch(_){}
              toastSafe("Session saved.");
              setSaveModalOpen(false);
              refreshFavorites();
            }}
          />
        )
      ) : null}
    </section>
  );
}

/* --------------------------------- Partials --------------------------------- */
function Tab({ label, id, icon, active, onClick, count }){
  return (
    <button className={cx(BTN, active ? VAR.primary : VAR.subtle)} onClick={onClick}>
      {icon}{label}{typeof count==="number" ? <span className={CHIP}>{count}</span> : null}
    </button>
  );
}

function MenuItem(p){
  return (
    <button type="button" onClick={p.onClick} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2">
      {p.icon}{p.label}
    </button>
  );
}

function KeyVal({label, value}){
  return (
    <div className="text-[11px]">
      <span className="text-gray-500">{label}: </span>
      <span className="font-mono">{typeof value === "string" ? value : JSON.stringify(value)}</span>
    </div>
  );
}

/* ------------------------------- Timers table ------------------------------- */
function TimersTable({ items, onStart }){
  if (!items || !items.length) return <EmptyState icon={<I.Timer className="h-5 w-5" />} text="No timers yet." />;
  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-200">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <Th>ID</Th><Th>Title</Th><Th>ETA</Th><Th>Kind</Th><Th>Meta</Th><Th></Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map((t) => (
            <tr key={t.id}>
              <Td className="font-mono">{t.id}</Td>
              <Td>{t.title || "—"}</Td>
              <Td><span className={CHIP}>{t.etaISO || "—"}</span></Td>
              <Td><span className={CHIP}>{t.kind || "timeout"}</span></Td>
              <Td><pre className="text-[11px] whitespace-pre-wrap">{JSON.stringify(t.meta||{}, null, 2)}</pre></Td>
              <Td>
                {!!(t.meta && t.meta.sessionIdOrTitle) ? (
                  <button className={cx(BTN, VAR.subtle)} onClick={()=>onStart && onStart(t.meta.sessionIdOrTitle)}>
                    <I.Play className="h-4 w-4" /> Start session
                  </button>
                ) : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------- Anchors table ------------------------------ */
function AnchorsTable({ items }){
  if (!items || !items.length) return <EmptyState icon={<I.Clock className="h-5 w-5" />} text="No anchors yet." />;
  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-200">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <Th>ID</Th><Th>Type</Th><Th>Value</Th><Th>Next Fire</Th><Th>Meta</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map((a) => (
            <tr key={a.id}>
              <Td className="font-mono">{a.id}</Td>
              <Td><span className={CHIP}>{a.type}</span></Td>
              <Td><span className={CHIP}>{formatTriggerValue(a.type, a.value)}</span></Td>
              <Td><span className={CHIP}>{a.nextISO || "—"}</span></Td>
              <Td><pre className="text-[11px] whitespace-pre-wrap">{JSON.stringify(a.meta||{}, null, 2)}</pre></Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatTriggerValue(type, value){
  if (!type) return String(value||"");
  if (type === "time.at") return String(value||"—");
  if (type === "time.every") return String(value||"—");
  return JSON.stringify(value);
}

/* -------------------------------- Guards table ------------------------------ */
function GuardsTable({ items }){
  if (!items || !items.length) return <EmptyState icon={<I.Shield className="h-5 w-5" />} text="No guard hits yet." />;
  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-200">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <Th>When</Th><Th>Kind</Th><Th>OK?</Th><Th>Notes</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map((g, idx) => (
            <tr key={g.id || idx}>
              <Td><span className={CHIP}>{g.atISO || "—"}</span></Td>
              <Td><span className={CHIP}>{g.kind || "guard"}</span></Td>
              <Td>{g.ok ? <span className={cx(CHIP,"border-green-300 text-green-700")}>yes</span> : <span className={cx(CHIP,"border-rose-300 text-rose-700")}>no</span>}</Td>
              <Td className="text-[12px]">{g.notes || "—"}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------- Favorites panel ------------------------------ */
function FavoritesPanel({ items, onRefresh, onStart, onToggleFav, onOpenSave }){
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button className={cx(BTN, VAR.subtle)} onClick={onRefresh}><I.Refresh className="h-4 w-4" />Refresh</button>
        <button className={cx(BTN, VAR.primary)} onClick={onOpenSave}><I.Star className="h-4 w-4" />Save new session</button>
      </div>
      {!items || !items.length ? (
        <EmptyState icon={<I.Star className="h-5 w-5" />} text="No favorite sessions yet. Save one to get started." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((f) => (
            <div key={f.id} className="rounded-2xl border border-gray-200 p-3">
              <div className="flex items-center gap-2">
                <div className="font-semibold truncate">{f.title || f.id}</div>
                <span className={CHIP}>{f.domain || "session"}</span>
              </div>
              {f.notes ? <div className="mt-1 text-[12px] text-gray-600 line-clamp-2">{f.notes}</div> : null}
              <div className="mt-3 flex items-center gap-2">
                <button className={cx(BTN, VAR.subtle)} onClick={()=>onStart && onStart(f.id || f.title)}>
                  <I.Play className="h-4 w-4" />Start
                </button>
                <button className={cx(BTN, VAR.ghost)} onClick={()=>onToggleFav && onToggleFav(f.id, f)}>
                  <I.StarOff className="h-4 w-4" />Unfavorite
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Log panel ------------------------------- */
function LogPanel({ items }){
  if (!items || !items.length) return <EmptyState icon={<I.Bug className="h-5 w-5" />} text="No events yet." />;
  return (
    <div className="rounded-2xl border border-gray-200">
      <div className="max-h-[52vh] overflow-auto divide-y divide-gray-100">
        {items.map((l, idx) => (
          <div key={idx} className="p-3">
            <div className="flex items-center gap-2">
              <span className={CHIP}>{l.atISO}</span>
              <span className={cx(CHIP,"bg-gray-100")}>{l.event}</span>
            </div>
            <pre className="mt-2 text-[11px] whitespace-pre-wrap">{JSON.stringify(l.payload||{}, null, 2)}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- Table UI -------------------------------- */
function Th({ children }){ return <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700">{children}</th>; }
function Td({ children, className }){ return <td className={cx("px-3 py-2 align-top", className)}>{children}</td>; }

function EmptyState({ icon, text }){
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-600">
      <div className="mb-2 opacity-70">{icon}</div>
      {text}
    </div>
  );
}

/* ---------------------------- Inline Save (Fallback) ------------------------ */
function InlineSaveSession(props){
  const [name, setName] = useState(props.defaultTitle || "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  function submit(){
    setBusy(true);
    try {
      const payload = { id: props.sessionId, domain: props.domain, title: name, notes };
      try { eventBus.emit && eventBus.emit("session.save.requested", { payload, source: "SchedulerDevPanel" }); } catch(_){}
      props.onSaved && props.onSaved(payload);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label="Save session"
      onClick={(e)=>{ if (e.target === e.currentTarget) props.onClose && props.onClose(); }}
    >
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">Save Session</h3>
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={props.onClose} aria-label="Close"><I.X className="h-4 w-4" /></button>
        </div>

        <label className="mt-4 block text-sm font-medium text-gray-700">Title</label>
        <input className={FIELD} value={name} onChange={(e)=>setName(e.target.value)} placeholder="Session title" />

        <label className="mt-4 block text-sm font-medium text-gray-700">Notes</label>
        <textarea className={cx(FIELD, "min-h-[96px]")} value={notes} onChange={(e)=>setNotes(e.target.value)} placeholder="What should future-you remember?" />

        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VAR.ghost)} onClick={props.onClose}>Cancel</button>
          <button className={cx(BTN, VAR.primary)} onClick={submit} disabled={busy}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
