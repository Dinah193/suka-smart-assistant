/* eslint-disable no-console */
// src/pages/scheduler/settings.jsx
import React, { useEffect, useMemo, useState, Suspense } from "react";

/* --------------------------------- Tokens ---------------------------------- */
const cx = (...a) => a.filter(Boolean).join(" ");
const WRAP  = "mx-auto max-w-7xl px-4 py-6";
const CARD  = "rounded-2xl border border-gray-200 bg-white p-4 shadow-sm";
const GRID2 = "grid gap-3 md:grid-cols-2";
const BTN   = "inline-flex items-center gap-2 rounded-2xl px-3 py-1.5 text-sm font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 active:translate-y-px";
const VAR   = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle:  "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost:   "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  danger:  "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
};
const FIELD = "w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600";
const CHIP  = "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2 py-0.5 text-[11px] font-medium text-gray-700";

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

/* Favorites: Sessions & Schedules (user-owned) */
let useFavoriteSessions = null;
try {
  const favMod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions = favMod && (favMod.useFavoriteSessions || favMod.default) || null;
} catch(_){}
let useFavoriteSchedules = null;
try {
  const favSchedMod = require("@/hooks/useFavoriteSchedules");
  useFavoriteSchedules = favSchedMod && (favSchedMod.useFavoriteSchedules || favSchedMod.default) || null;
} catch(_){}

/* Lazy modals (optional) */
let SaveSessionModalLazy = null;
try {
  SaveSessionModalLazy = React.lazy(() => import("@/components/sessions/SaveSessionModal.jsx"));
} catch(_){}
let SaveScheduleModalLazy = null;
try {
  SaveScheduleModalLazy = React.lazy(() => import("@/components/scheduler/SaveScheduleModal.jsx"));
} catch(_){}

/* ----------------------------------- Icons ---------------------------------- */
let I = {};
try {
  const L = require("lucide-react");
  I = {
    Save: L.Save, Settings: L.Settings, Sun: L.Sun, Moon: L.Moon, Clock: L.Clock3, Calendar: L.Calendar,
    Plus: L.Plus, Trash: L.Trash2, Star: L.Star, StarOff: L.StarOff, Upload: L.Upload, Download: L.Download, Cloud: L.Cloud,
    User: L.User, Users: L.Users, Repeat: L.Repeat, Check: L.Check, X: L.X, Info: L.Info, Zap: L.Zap, Sparkles: L.Sparkles,
  };
} catch(_){ I = new Proxy({}, { get(){ return () => <span/>; }}); }

/* ---------------------------------- Utils ---------------------------------- */
const nowISO = () => new Date().toISOString();
const uid = (p="id") => p+":"+Math.random().toString(36).slice(2,9);
const safeParse = (s, f=null) => { try { return JSON.parse(s); } catch { return f; } };
const toastSafe = (message, variant) => { try { eventBus.emit("ui.toast", { message, variant: variant||"success" }); } catch { variant==="error"?console.warn(message):console.log(message); } };
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const prettyScheduleLabel = (trg) => {
  if (!trg || !trg.type) return "Schedule";
  if (trg.type === "time.at") return `At ${String(trg.value || "—")}`;
  if (trg.type === "time.every") return `Every ${String(trg.value || "—")}`;
  return `${trg.type} ${String(trg.value || "")}`;
};
const scheduleKey = (trigger) => trigger && trigger.type ? `${trigger.type}::${JSON.stringify(trigger.value)}` : "";

/* =============================== Settings Page ============================== */
export default function SchedulerSettingsPage(props){
  const domain = props.domain || "session";

  /* ------------------------------- State model ------------------------------ */
  const [quiet, setQuiet] = useState({
    enabled: true,
    ranges: [
      { id: uid("q"), label: "Night", days: [...DAYS], start: "21:30", end: "07:00" }
    ],
    allowCritical: true,
    // optional: auto-snooze scheduled anchors during quiet hours
    snoozeSchedules: true,
  });

  const [sabbath, setSabbath] = useState({
    enabled: true,
    locationHint: "",
    candleLightingOffsetMin: 18,
    havdalahOffsetMin: 42,
    muteAutomations: true,
    notes: "",
  });

  const [defaults, setDefaults] = useState({
    defaultMorningSession: "",
    defaultEveningSession: "",
    defaultMorningSchedule: { type: "time.at", value: "07:00" }, // NEW
    defaultEveningSchedule: { type: "time.at", value: "18:00" }, // NEW
    defaultNotificationLevel: "normal",
    inventoryAutoReorder: false,
  });

  const [household, setHousehold] = useState({
    members: 2,
    wakeTime: "07:00",
    bedTime:  "22:30",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
    choreRotation: "weekly",
  });

  const [rhythms, setRhythms] = useState([
    { id: uid("rh"), day: "Sun", time: "10:00", session: "Weekly Reset" },
    { id: uid("rh"), day: "Fri", time: "16:00", session: "Pre-Sabbath Prep" },
  ]);

  /* ------------------------------ Favorites APIs ---------------------------- */
  // Sessions
  let favSessApi = null;
  try { favSessApi = useFavoriteSessions ? useFavoriteSessions(domain) : null; } catch(_){}
  const [favoriteSessions, setFavoriteSessions] = useState(() => (favSessApi && favSessApi.list ? favSessApi.list() : []));
  const refreshFavSessions = () => { try { setFavoriteSessions(favSessApi && favSessApi.list ? favSessApi.list() : []); } catch(_){} };

  // Schedules
  let favSchedApi = null;
  try { favSchedApi = useFavoriteSchedules ? useFavoriteSchedules(domain) : null; } catch(_){}
  const [favoriteSchedules, setFavoriteSchedules] = useState(() => (favSchedApi && favSchedApi.list ? favSchedApi.list() : []));
  const refreshFavSchedules = () => { try { setFavoriteSchedules(favSchedApi && favSchedApi.list ? favSchedApi.list() : []); } catch(_){} };

  // Save modals
  const [saveSessionOpen, setSaveSessionOpen] = useState(false);
  const [saveSessionDefaults, setSaveSessionDefaults] = useState({ id: "__pending__", title: "My Session" });
  const [saveScheduleOpen, setSaveScheduleOpen] = useState(false);
  const [saveScheduleDefaults, setSaveScheduleDefaults] = useState({ key: "", title: "My Schedule", trigger: { type:"time.at", value:"18:00" } });

  /* ---------------------------- Load from runtime --------------------------- */
  useEffect(() => {
    try {
      if (automation && automation.settings && automation.settings.get){
        const maybe = automation.settings.get({ domain });
        if (maybe && typeof maybe.then === "function"){ maybe.then(hydrateFromRuntime); } else hydrateFromRuntime(maybe);
      }
    } catch(_){}
    const onUpdated = (p={}) => hydrateFromRuntime(p.settings || p);
    try { eventBus.on && eventBus.on("scheduler.settings.updated", onUpdated); } catch(_){}
    return () => { try { eventBus.off && eventBus.off("scheduler.settings.updated", onUpdated); } catch(_){} };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  function hydrateFromRuntime(s){
    if (!s || typeof s !== "object") return;
    if (s.quiet) setQuiet((q)=>Object.assign({}, q, s.quiet));
    if (s.sabbath) setSabbath((x)=>Object.assign({}, x, s.sabbath));
    if (s.defaults) setDefaults((d)=>Object.assign({}, d, s.defaults));
    if (s.household) setHousehold((h)=>Object.assign({}, h, s.household));
    if (Array.isArray(s.rhythms)) setRhythms(s.rhythms);
  }

  /* --------------------------------- Save all -------------------------------- */
  function saveAll(){
    const payload = { domain, quiet, sabbath, defaults, household, rhythms, updatedAt: nowISO() };
    const done = () => {
      toastSafe("Settings saved.");
      try { eventBus.emit && eventBus.emit("scheduler.settings.updated", { domain, settings: payload, source:"settings" }); } catch(_){}
    };
    try {
      if (automation && automation.settings && automation.settings.save){
        const maybe = automation.settings.save(payload);
        if (maybe && typeof maybe.then === "function"){ maybe.then(done).catch(()=>toastSafe("Save failed.", "error")); return; }
        done();
      } else {
        eventBus.emit && eventBus.emit("scheduler.settings.save.requested", { payload, source:"settings", reply: done });
        setTimeout(done, 250);
      }
    } catch(_){ toastSafe("Save failed.", "error"); }
  }

  /* ------------------------------ Export/Import ------------------------------ */
  function exportJSON(){
    try {
      const dump = { domain, quiet, sabbath, defaults, household, rhythms };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `scheduler-settings-${domain}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toastSafe("Downloaded settings.");
    } catch(_){ toastSafe("Export failed.", "error"); }
  }
  function exportToCloud(provider){
    try {
      const dump = { domain, quiet, sabbath, defaults, household, rhythms };
      eventBus.emit && eventBus.emit("automation.rule.export.requested", {
        provider, rule: dump, filename: `scheduler-settings-${domain}.json`, source: "settings"
      });
      toastSafe(`Sent export to ${provider}.`);
    } catch(_){ toastSafe("Cloud export failed.", "error"); }
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
          hydrateFromRuntime(data);
          toastSafe("Imported settings (not yet saved).");
        };
        fr.readAsText(file);
      };
      inp.click();
    } catch(_){ toastSafe("Import failed.", "error"); }
  }

  /* --------------------------- Quiet hours handlers -------------------------- */
  function addQuietRange(){
    setQuiet((q)=>Object.assign({}, q, { ranges: [...(q.ranges||[]), { id: uid("q"), label:"Quiet", days:[...DAYS], start:"22:00", end:"07:00" }] }));
  }
  function updateQuietRange(id, patch){
    setQuiet((q)=>{
      const arr = (q.ranges||[]).slice();
      const idx = arr.findIndex(x=>x.id===id);
      if (idx<0) return q;
      arr[idx] = Object.assign({}, arr[idx], patch);
      return Object.assign({}, q, { ranges: arr });
    });
  }
  function removeQuietRange(id){
    setQuiet((q)=>Object.assign({}, q, { ranges: (q.ranges||[]).filter(x=>x.id!==id) }));
  }

  /* ----------------------------- Sabbath handlers ---------------------------- */
  function broadcastSabbath(){
    const payload = { domain, sabbath, source:"settings" };
    try { eventBus.emit && eventBus.emit("guard.sabbath.updated", payload); } catch(_){}
    try { eventBus.emit && eventBus.emit("ui.toast", { message:"Sabbath guard updated.", variant:"success" }); } catch(_){}
  }

  /* -------------------------- Defaults + favorites UX ------------------------ */
  function setDefaultSession(kind, idOrTitle){
    setDefaults((d)=>Object.assign({}, d, kind === "morning" ? { defaultMorningSession: idOrTitle } : { defaultEveningSession: idOrTitle }));
  }
  function setDefaultSchedule(kind, trigger){
    setDefaults((d)=>Object.assign({}, d, kind === "morning" ? { defaultMorningSchedule: trigger } : { defaultEveningSchedule: trigger }));
  }

  function toggleFavSession(idOrTitle){
    if (!idOrTitle) return;
    try {
      if (favSessApi && favSessApi.toggleFavorite){
        const meta = { id: idOrTitle, title: String(idOrTitle), domain };
        const next = favSessApi.toggleFavorite(idOrTitle, meta);
        if (next && typeof next.then === "function"){ next.then(()=>refreshFavSessions()); } else { refreshFavSessions(); }
        toastSafe("Session favorites updated.");
      } else {
        eventBus.emit && eventBus.emit("session.favorite.toggled", { domain, sessionId: idOrTitle, next:true, source:"settings" });
      }
    } catch(_){ toastSafe("Favorite update failed.", "error"); }
  }
  function openSaveSession(idOrTitle, titleGuess){
    setSaveSessionDefaults({ id: idOrTitle || "__pending__", title: titleGuess || idOrTitle || "My Session" });
    setSaveSessionOpen(true);
    try { eventBus.emit && eventBus.emit("session.save.modal.opened", { domain, sessionId:idOrTitle||"__pending__", source:"settings" }); } catch(_){}
  }

  function toggleFavSchedule(trigger){
    const key = scheduleKey(trigger);
    if (!key) { toastSafe("Invalid schedule.", "warn"); return; }
    try {
      if (favSchedApi && favSchedApi.toggleFavorite){
        const meta = { id: key, domain, kind:"schedule", trigger, title: prettyScheduleLabel(trigger) };
        const next = favSchedApi.toggleFavorite(key, meta);
        if (next && typeof next.then === "function"){ next.then(()=>refreshFavSchedules()); } else { refreshFavSchedules(); }
        toastSafe("Schedule favorites updated.");
      } else {
        eventBus.emit && eventBus.emit("schedule.favorite.toggled", { domain, scheduleKey: key, trigger, next:true, source:"settings" });
      }
    } catch(_){ toastSafe("Favorite update failed.", "error"); }
  }
  function openSaveSchedule(trigger, title){
    const key = scheduleKey(trigger);
    if (!key) { toastSafe("Invalid schedule.", "warn"); return; }
    setSaveScheduleDefaults({ key, title: title || prettyScheduleLabel(trigger), trigger });
    setSaveScheduleOpen(true);
    try { eventBus.emit && eventBus.emit("schedule.save.modal.opened", { domain, scheduleKey:key, trigger, source:"settings" }); } catch(_){}
  }

  function applyFavoriteScheduleInRule(fav){
    const rule = {
      id: uid("rule"),
      title: fav.title || "Rule from favorite",
      enabled: true,
      priority: 5,
      trigger: fav.trigger || { type:"time.at", value:"18:00" },
      conditions: [],
      actions: [{ id:"notify.toast", value:"Running from favorite" }],
      description: fav.notes || ""
    };
    try { eventBus.emit && eventBus.emit("automation.rule.prefill.requested", { rule, domain, source:"settings" }); } catch(_){}
    toastSafe("Applied schedule to rule editor.");
  }

  /* ---------------------------------- UI ------------------------------------ */
  return (
    <main className={WRAP}>
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-gray-900">Scheduler Settings</h1>
        <span className={CHIP}>{household.timezone}</span>
        <div className="ml-auto flex items-center gap-2">
          <details className="relative">
            <summary className={cx(BTN, VAR.ghost, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
              <I.Download className="h-4 w-4" /> Tools
            </summary>
            <div className="absolute right-0 z-10 mt-2 min-w-[16rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
              <MenuItem onClick={exportJSON} icon={<I.Download className="h-4 w-4" />} label="Export (.json)" />
              <MenuItem onClick={importJSON} icon={<I.Upload className="h-4 w-4" />} label="Import (.json)" />
              <div className="h-px bg-gray-100" />
              <MenuItem onClick={()=>exportToCloud("gdrive")} icon={<I.Cloud className="h-4 w-4" />} label="Export to Google Drive" />
              <MenuItem onClick={()=>exportToCloud("onedrive")} icon={<I.Cloud className="h-4 w-4" />} label="Export to OneDrive" />
            </div>
          </details>
          <button className={cx(BTN, VAR.primary)} onClick={saveAll}><I.Save className="h-4 w-4" /> Save all</button>
        </div>
      </div>

      {/* Layout */}
      <div className="mt-4 space-y-4">
        <section className={GRID2}>
          {/* Quiet Hours */}
          <div className={CARD}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900"><I.Moon className="inline h-4 w-4 mr-1" /> Quiet Hours</h2>
              <label className="text-xs flex items-center gap-2">
                <input type="checkbox" checked={!!quiet.enabled} onChange={(e)=>setQuiet((q)=>Object.assign({}, q, { enabled: !!e.target.checked }))} />
                Enabled
              </label>
            </div>
            <p className="mt-1 text-xs text-gray-600">Suppress non-critical notifications and pause schedules during these ranges.</p>

            <div className="mt-3 space-y-3">
              {(quiet.ranges||[]).map((r) => (
                <div key={r.id} className="rounded-xl border border-gray-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input className={cx(FIELD, "w-40")} value={r.label||""} onChange={(e)=>updateQuietRange(r.id,{label:e.target.value})} placeholder="Label" />
                    <select className={cx(FIELD, "w-48")} value={JSON.stringify(r.days||DAYS)} onChange={(e)=>updateQuietRange(r.id,{days: safeParse(e.target.value, DAYS)})}>
                      <option value={JSON.stringify(DAYS)}>Every day</option>
                      <option value={JSON.stringify(["Mon","Tue","Wed","Thu","Fri"])}>Weekdays</option>
                      <option value={JSON.stringify(["Sat","Sun"])}>Weekends</option>
                      {DAYS.map((d)=> <option key={d} value={JSON.stringify([d])}>{d} only</option>)}
                    </select>
                    <input type="time" className={cx(FIELD, "w-28")} value={r.start||""} onChange={(e)=>updateQuietRange(r.id,{start:e.target.value})} />
                    <span className="text-xs text-gray-500">to</span>
                    <input type="time" className={cx(FIELD, "w-28")} value={r.end||""} onChange={(e)=>updateQuietRange(r.id,{end:e.target.value})} />
                    <div className="ml-auto">
                      <button className={cx(BTN, VAR.ghost, "px-2")} onClick={()=>removeQuietRange(r.id)} title="Remove"><I.Trash className="h-4 w-4" /></button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button className={cx(BTN, VAR.subtle)} onClick={addQuietRange}><I.Plus className="h-4 w-4" /> Add range</button>
              <label className="text-xs flex items-center gap-2">
                <input type="checkbox" checked={!!quiet.allowCritical} onChange={(e)=>setQuiet((q)=>Object.assign({}, q, { allowCritical: !!e.target.checked }))} />
                Allow critical during quiet hours
              </label>
              <label className="text-xs flex items-center gap-2">
                <input type="checkbox" checked={!!quiet.snoozeSchedules} onChange={(e)=>setQuiet((q)=>Object.assign({}, q, { snoozeSchedules: !!e.target.checked }))} />
                Snooze schedules in quiet hours
              </label>
            </div>
          </div>

          {/* Sabbath Guard */}
          <div className={CARD}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900"><I.Sun className="inline h-4 w-4 mr-1" /> Sabbath Guard</h2>
              <label className="text-xs flex items-center gap-2">
                <input type="checkbox" checked={!!sabbath.enabled} onChange={(e)=>setSabbath((s)=>Object.assign({}, s, { enabled: !!e.target.checked }))} />
                Enabled
              </label>
            </div>
            <p className="mt-1 text-xs text-gray-600">Pause/mute automations around Shabbat based on sunset windows.</p>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-gray-700">Location hint (ZIP/City)</label>
                <input className={FIELD} value={sabbath.locationHint||""} onChange={(e)=>setSabbath((s)=>Object.assign({}, s, { locationHint: e.target.value }))} placeholder="e.g., 10001 or Jerusalem" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700">Candle-lighting offset (min)</label>
                  <input type="number" className={FIELD} value={Number(sabbath.candleLightingOffsetMin||18)} onChange={(e)=>setSabbath((s)=>Object.assign({}, s, { candleLightingOffsetMin: Number(e.target.value||18) }))} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700">Havdalah offset (min)</label>
                  <input type="number" className={FIELD} value={Number(sabbath.havdalahOffsetMin||42)} onChange={(e)=>setSabbath((s)=>Object.assign({}, s, { havdalahOffsetMin: Number(e.target.value||42) }))} />
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <label className="text-xs flex items-center gap-2">
                <input type="checkbox" checked={!!sabbath.muteAutomations} onChange={(e)=>setSabbath((s)=>Object.assign({}, s, { muteAutomations: !!e.target.checked }))} />
                Mute automations during guard window
              </label>
              <div className="ml-auto flex items-center gap-2">
                <button className={cx(BTN, VAR.subtle)} onClick={broadcastSabbath}><I.Zap className="h-4 w-4" /> Update guard</button>
              </div>
            </div>

            <label className="mt-3 block text-xs font-medium text-gray-700">Notes</label>
            <textarea className={cx(FIELD, "min-h-[72px]")} value={sabbath.notes||""} onChange={(e)=>setSabbath((s)=>Object.assign({}, s, { notes: e.target.value }))} placeholder="Household preferences for observance…" />
          </div>
        </section>

        <section className={GRID2}>
          {/* Defaults — Sessions & Schedules */}
          <div className={CARD}>
            <h2 className="text-sm font-semibold text-gray-900"><I.Settings className="inline h-4 w-4 mr-1" /> Defaults</h2>

            {/* Sessions */}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-gray-700">Default Morning Session</label>
                <div className="flex items-center gap-2">
                  <input className={FIELD} value={defaults.defaultMorningSession||""} onChange={(e)=>setDefaultSession("morning", e.target.value)} placeholder="Session id or title" />
                  <button className={cx(BTN, VAR.ghost, "px-2")} title="Favorite" onClick={()=>toggleFavSession(defaults.defaultMorningSession)}>
                    <I.Star className="h-4 w-4 text-amber-500" />
                  </button>
                  <button className={cx(BTN, VAR.subtle, "px-2")} title="Save Session" onClick={()=>openSaveSession(defaults.defaultMorningSession, "Morning Routine")}>
                    <I.Save className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">Default Evening Session</label>
                <div className="flex items-center gap-2">
                  <input className={FIELD} value={defaults.defaultEveningSession||""} onChange={(e)=>setDefaultSession("evening", e.target.value)} placeholder="Session id or title" />
                  <button className={cx(BTN, VAR.ghost, "px-2")} title="Favorite" onClick={()=>toggleFavSession(defaults.defaultEveningSession)}>
                    <I.Star className="h-4 w-4 text-amber-500" />
                  </button>
                  <button className={cx(BTN, VAR.subtle, "px-2")} title="Save Session" onClick={()=>openSaveSession(defaults.defaultEveningSession, "Evening Routine")}>
                    <I.Save className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Schedules */}
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ScheduleInlineEditor
                label="Default Morning Schedule"
                trigger={defaults.defaultMorningSchedule}
                onChange={(tr)=>setDefaultSchedule("morning", tr)}
                onFavorite={toggleFavSchedule}
                onSave={openSaveSchedule}
              />
              <ScheduleInlineEditor
                label="Default Evening Schedule"
                trigger={defaults.defaultEveningSchedule}
                onChange={(tr)=>setDefaultSchedule("evening", tr)}
                onFavorite={toggleFavSchedule}
                onSave={openSaveSchedule}
              />
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-gray-700">Notification Level</label>
                <select className={FIELD} value={defaults.defaultNotificationLevel} onChange={(e)=>setDefaults((d)=>Object.assign({}, d, { defaultNotificationLevel: e.target.value }))}>
                  <option value="quiet">Quiet</option>
                  <option value="normal">Normal</option>
                  <option value="verbose">Verbose</option>
                </select>
              </div>
              <div className="sm:col-span-2 flex items-end">
                <label className="text-xs flex items-center gap-2">
                  <input type="checkbox" checked={!!defaults.inventoryAutoReorder} onChange={(e)=>setDefaults((d)=>Object.assign({}, d, { inventoryAutoReorder: !!e.target.checked }))} />
                  Auto-create shopping list items when inventory low
                </label>
              </div>
            </div>

            {/* Favorite quick-pick rows */}
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <FavoritesRow
                title="Your Favorite Sessions"
                empty="No favorite sessions yet. Use ⭐ anywhere to add."
                items={favoriteSessions}
                renderLabel={(f)=>f.title || f.id}
                onRefresh={refreshFavSessions}
                onPrimary={(f)=>setDefaultSession("morning", f.id)}
                primaryText="Set Morning"
              />
              <FavoritesRow
                title="Your Favorite Schedules"
                empty="No favorite schedules yet. Use ⭐ anywhere to add."
                items={favoriteSchedules}
                renderLabel={(f)=>f.title || prettyScheduleLabel(f.trigger)}
                onRefresh={refreshFavSchedules}
                onPrimary={applyFavoriteScheduleInRule}
                primaryText="Apply in Rule"
              />
            </div>
          </div>

          {/* Household Preferences */}
          <div className={CARD}>
            <h2 className="text-sm font-semibold text-gray-900"><I.User className="inline h-4 w-4 mr-1" /> Household</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-gray-700">Members</label>
                <input type="number" className={FIELD} value={Number(household.members||1)} onChange={(e)=>setHousehold((h)=>Object.assign({}, h, { members: Math.max(1, Number(e.target.value||1)) }))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">Timezone</label>
                <input className={FIELD} value={household.timezone} onChange={(e)=>setHousehold((h)=>Object.assign({}, h, { timezone: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">Wake time</label>
                <input type="time" className={FIELD} value={household.wakeTime||"07:00"} onChange={(e)=>setHousehold((h)=>Object.assign({}, h, { wakeTime: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">Bed time</label>
                <input type="time" className={FIELD} value={household.bedTime||"22:30"} onChange={(e)=>setHousehold((h)=>Object.assign({}, h, { bedTime: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">Chore rotation</label>
                <select className={FIELD} value={household.choreRotation} onChange={(e)=>setHousehold((h)=>Object.assign({}, h, { choreRotation: e.target.value }))}>
                  <option value="off">Off</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
            </div>
          </div>
        </section>

        {/* Rhythms */}
        <section className={CARD}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900"><I.Repeat className="inline h-4 w-4 mr-1" /> Household Rhythms</h2>
            <div className="flex items-center gap-2">
              <button className={cx(BTN, VAR.subtle)} onClick={()=>setRhythms((r)=>[{ id: uid("rh"), day: "Mon", time:"08:00", session:"" }, ...r])}><I.Plus className="h-4 w-4" /> Add</button>
              <button className={cx(BTN, VAR.primary)} onClick={publishRhythms}><I.Zap className="h-4 w-4" /> Apply</button>
            </div>
          </div>
          <p className="mt-1 text-xs text-gray-600">Weekly slots that suggest or auto-start sessions (respecting quiet hours & guards).</p>

          <div className="mt-3 space-y-3">
            {(!rhythms || !rhythms.length) ? (
              <div className="text-xs text-gray-600">No rhythms yet. Add a few to seed your week.</div>
            ) : rhythms.map((r)=>(
              <div key={r.id} className="rounded-xl border border-gray-200 p-3">
                <div className="grid gap-2 sm:grid-cols-[100px_120px_1fr_auto]">
                  <select className={FIELD} value={r.day} onChange={(e)=>updateRhythm(r.id, { day: e.target.value })}>
                    {DAYS.map((d)=> <option key={d} value={d}>{d}</option>)}
                  </select>
                  <input type="time" className={FIELD} value={r.time||"08:00"} onChange={(e)=>updateRhythm(r.id, { time: e.target.value })} />
                  <div className="flex items-center gap-2">
                    <input className={FIELD} value={r.session||""} onChange={(e)=>updateRhythm(r.id, { session: e.target.value })} placeholder="Session id or title" />
                    <button className={cx(BTN, VAR.ghost, "px-2")} title="Favorite session" onClick={()=>toggleFavSession(r.session)}><I.Star className="h-4 w-4 text-amber-500" /></button>
                    <button className={cx(BTN, VAR.subtle, "px-2")} title="Save session" onClick={()=>openSaveSession(r.session, r.session)}><I.Save className="h-4 w-4" /></button>
                  </div>
                  <div className="flex items-center justify-end">
                    <button className={cx(BTN, VAR.ghost, "px-2")} onClick={()=>removeRhythm(r.id)} title="Remove"><I.Trash className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Save Session modal (lazy preferred) */}
      {saveSessionOpen ? (
        SaveSessionModalLazy ? (
          <Suspense fallback={null}>
            <SaveSessionModalLazy
              isOpen={true}
              onClose={()=>setSaveSessionOpen(false)}
              domain={domain}
              sessionId={String(saveSessionDefaults.id || "__pending__")}
              defaultTitle={String(saveSessionDefaults.title || "My Session")}
              onSaved={(saved)=>{
                try { eventBus.emit && eventBus.emit("session.saved", { from:"settings", saved }); } catch(_){}
                toastSafe("Session saved.");
                setSaveSessionOpen(false);
                refreshFavSessions();
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSession
            domain={domain}
            sessionId={String(saveSessionDefaults.id || "__pending__")}
            defaultTitle={String(saveSessionDefaults.title || "My Session")}
            onClose={()=>setSaveSessionOpen(false)}
            onSaved={(saved)=>{
              try { eventBus.emit && eventBus.emit("session.saved", { from:"settings", saved }); } catch(_){}
              toastSafe("Session saved.");
              setSaveSessionOpen(false);
              refreshFavSessions();
            }}
          />
        )
      ) : null}

      {/* Save Schedule modal (lazy preferred) */}
      {saveScheduleOpen ? (
        SaveScheduleModalLazy ? (
          <Suspense fallback={null}>
            <SaveScheduleModalLazy
              isOpen={true}
              onClose={()=>setSaveScheduleOpen(false)}
              domain={domain}
              scheduleKey={String(saveScheduleDefaults.key || "__pending__")}
              trigger={saveScheduleDefaults.trigger}
              defaultTitle={String(saveScheduleDefaults.title || "My Schedule")}
              onSaved={(saved)=>{
                try { eventBus.emit && eventBus.emit("schedule.saved", { from:"settings", saved }); } catch(_){}
                toastSafe("Schedule saved.");
                setSaveScheduleOpen(false);
                refreshFavSchedules();
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSchedule
            domain={domain}
            scheduleKey={String(saveScheduleDefaults.key || "__pending__")}
            trigger={saveScheduleDefaults.trigger}
            defaultTitle={String(saveScheduleDefaults.title || "My Schedule")}
            onClose={()=>setSaveScheduleOpen(false)}
            onSaved={(saved)=>{
              try { eventBus.emit && eventBus.emit("schedule.saved", { from:"settings", saved }); } catch(_){}
              toastSafe("Schedule saved.");
              setSaveScheduleOpen(false);
              refreshFavSchedules();
            }}
          />
        )
      ) : null}
    </main>
  );

  /* ------------------------------- Handlers --------------------------------- */
  function updateRhythm(id, patch){
    setRhythms((r)=> {
      const arr = r.slice();
      const idx = arr.findIndex(x=>x.id===id);
      if (idx<0) return r;
      arr[idx] = Object.assign({}, arr[idx], patch);
      return arr;
    });
  }
  function removeRhythm(id){ setRhythms((r)=>r.filter(x=>x.id!==id)); }
  function publishRhythms(){
    const payload = { domain, rhythms, source:"settings" };
    try {
      if (automation && automation.rhythms && automation.rhythms.apply){
        const maybe = automation.rhythms.apply(payload);
        if (maybe && typeof maybe.then === "function"){ maybe.then(()=>toastSafe("Rhythms applied.")); return; }
      }
      eventBus.emit && eventBus.emit("scheduler.rhythms.apply.requested", payload);
      toastSafe("Rhythms apply requested.");
    } catch(_){ toastSafe("Could not apply rhythms.", "error"); }
  }
}

/* -------------------------------- Components -------------------------------- */
function MenuItem(p){
  return (
    <button type="button" onClick={p.onClick} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2">
      {p.icon}{p.label}
    </button>
  );
}

/* ------------------------ Inline Schedule mini-editor ----------------------- */
function ScheduleInlineEditor({ label, trigger, onChange, onFavorite, onSave }){
  const t = trigger || { type:"time.at", value:"18:00" };
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700">{label}</label>
      <div className="mt-1 grid gap-2 sm:grid-cols-[140px_1fr_auto_auto]">
        <select className={FIELD} value={t.type} onChange={(e)=>onChange && onChange({ type:e.target.value, value:"" })}>
          <option value="time.at">Time is (HH:MM)</option>
          <option value="time.every">Every interval</option>
        </select>
        {t.type === "time.at" ? (
          <input type="time" className={FIELD} value={String(t.value||"")} onChange={(e)=>onChange && onChange({ ...t, value: e.target.value })} />
        ) : (
          <input className={FIELD} placeholder="+15m" value={String(t.value||"")} onChange={(e)=>onChange && onChange({ ...t, value: e.target.value })} />
        )}
        <button className={cx(BTN, VAR.ghost, "px-2")} title="Favorite schedule" onClick={()=>onFavorite && onFavorite(t)}>
          <I.Star className="h-4 w-4 text-amber-500" />
        </button>
        <button className={cx(BTN, VAR.subtle, "px-2")} title="Save schedule" onClick={()=>onSave && onSave(t, `${label} — ${t.type==="time.at" ? t.value : t.value||""}`)}>
          <I.Save className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1 text-[11px] text-gray-600">{prettyScheduleLabel(t)}</div>
    </div>
  );
}

/* ----------------------------- Favorites row (UI) --------------------------- */
function FavoritesRow({ title, empty, items, renderLabel, onRefresh, onPrimary, primaryText }){
  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-gray-700">{title}</div>
        <button className={cx(BTN, VAR.subtle)} onClick={onRefresh}><I.Sparkles className="h-4 w-4" /> Refresh</button>
      </div>
      {!items || !items.length ? (
        <div className="mt-2 text-xs text-gray-600">{empty}</div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {items.map((f)=>(
            <button key={f.id} className={cx(BTN, VAR.ghost)} onClick={()=>onPrimary && onPrimary(f)}>
              {renderLabel(f)}
            </button>
          ))}
        </div>
      )}
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
      try { eventBus.emit && eventBus.emit("session.save.requested", { payload, source: "settings" }); } catch(_){}
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
            <I.Save className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Inline Save Schedule -------------------------- */
function InlineSaveSchedule(props){
  const [name, setName] = useState(props.defaultTitle || "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  function submit(){
    setBusy(true);
    try {
      const payload = {
        id: props.scheduleKey,
        domain: props.domain,
        title: name,
        notes,
        trigger: props.trigger || {},
        kind: "schedule"
      };
      try { eventBus.emit && eventBus.emit("schedule.save.requested", { payload, source: "settings" }); } catch(_){}
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
      aria-label="Save schedule"
      onClick={(e)=>{ if (e.target === e.currentTarget) props.onClose && props.onClose(); }}
    >
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">Save Schedule</h3>
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={props.onClose} aria-label="Close"><I.X className="h-4 w-4" /></button>
        </div>

        <label className="mt-4 block text-sm font-medium text-gray-700">Title</label>
        <input className={FIELD} value={name} onChange={(e)=>setName(e.target.value)} placeholder="Schedule title" />

        <label className="mt-4 block text-sm font-medium text-gray-700">Notes</label>
        <textarea className={cx(FIELD, "min-h-[96px]")} value={notes} onChange={(e)=>setNotes(e.target.value)} placeholder="e.g., Applies only on weekdays" />

        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VAR.ghost)} onClick={props.onClose}>Cancel</button>
          <button className={cx(BTN, VAR.primary)} onClick={submit} disabled={busy}>
            <I.Save className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
