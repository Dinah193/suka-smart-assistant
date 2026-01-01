/* eslint-disable no-console */
// src/pages/scheduler/templates.jsx
import React, { useEffect, useMemo, useState, Suspense } from "react";

/* --------------------------------- Tokens ---------------------------------- */
const cx = (...a) => a.filter(Boolean).join(" ");
const WRAP = "mx-auto max-w-7xl px-4 py-6";
const BTN  = "inline-flex items-center gap-2 rounded-2xl px-3 py-1.5 text-sm font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 active:translate-y-px";
const VAR  = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle:  "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost:   "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  danger:  "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
};
const CHIP = "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2 py-0.5 text-[11px] font-medium text-gray-700";
const FIELD = "w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600";
const CARD = "rounded-2xl border border-gray-200 bg-white p-4 shadow-sm";
const GRID = "grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

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

/* Favorites: Schedules (user-owned) */
let useFavoriteSchedules = null;
try {
  const favSchedMod = require("@/hooks/useFavoriteSchedules");
  useFavoriteSchedules = favSchedMod && (favSchedMod.useFavoriteSchedules || favSchedMod.default) || null;
} catch(_){}

/* (Optional) Rule editor & save modals (lazy) */
let IFTTTRuleEditorLazy = null;
try {
  IFTTTRuleEditorLazy = React.lazy(() => import("@/components/scheduler/IFTTTRuleEditor.jsx"));
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
    Plus: L.Plus, Edit: L.Pencil, Trash: L.Trash2, Play: L.Play,
    Star: L.Star, StarOff: L.StarOff, Save: L.Save, Clock: L.Clock3,
    Filter: L.Filter, Download: L.Download, Upload: L.Upload, Cloud: L.Cloud,
    Search: L.Search, Settings: L.Settings, X: L.X, Check: L.Check,
    Layers: L.Layers, Sparkles: L.Sparkles, Copy: L.Copy, Zap: L.Zap
  };
} catch(_){
  I = new Proxy({}, { get(){ return () => <span/>; }});
}

/* ---------------------------------- Utils ---------------------------------- */
const uid = (p="tmp") => p+":"+Math.random().toString(36).slice(2,9);
const safeParse = (s, f=null) => { try { return JSON.parse(s); } catch { return f; } };
const toastSafe = (message, variant) => { try { eventBus.emit("ui.toast", { message, variant: variant||"success" }); } catch { variant==="error"?console.warn(message):console.log(message); } };
const prettyScheduleLabel = (trg) => {
  if (!trg || !trg.type) return "Schedule";
  if (trg.type === "time.at") return `At ${String(trg.value || "—")}`;
  if (trg.type === "time.every") return `Every ${String(trg.value || "—")}`;
  return `${trg.type} ${String(trg.value || "")}`;
};

/* ----------------------------- Defaults / seeds ----------------------------- */
// Minimal default library of session templates (can be replaced by runtime).
const DEFAULT_TEMPLATES = [
  {
    id: "tmpl:evening-routine",
    title: "Evening Routine",
    tags: ["daily","wind-down"],
    description: "Lights, calming playlist, check doors, dishwasher run.",
    trigger: { type:"time.at", value:"18:00" },
    conditions: [{ id: "guard.sabbath.off", value: "" }],
    actions: [{ id:"session.start", value:"Evening Routine" }]
  },
  {
    id: "tmpl:weekday-mornings",
    title: "Weekday Morning Check-ins",
    tags: ["weekday","mornings"],
    description: "Light check-in every 20m between 7–9am.",
    trigger: { type:"time.every", value:"+20m" },
    conditions: [
      { id: "time.between", value: { start:"07:00", end:"09:00" } },
      { id: "guard.sabbath.off", value: "" }
    ],
    actions: [{ id:"notify.toast", value:"Quick morning check-in" }]
  },
];

/* =============================== Page: Templates ============================ */
export default function SchedulerTemplatesPage(props){
  const domain = props.domain || "session";
  const [tab, setTab] = useState("system"); // system | mine | favorites
  const [query, setQuery] = useState("");
  const [templates, setTemplates] = useState(DEFAULT_TEMPLATES);
  const [mine, setMine] = useState([]);             // user-authored templates
  const [editing, setEditing] = useState(null);     // currently editing template (object)
  const [showJSON, setShowJSON] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);  // save schedule modal
  const [savePayload, setSavePayload] = useState(null);

  // Favorites API for schedules
  let favApi = null;
  try { favApi = useFavoriteSchedules ? useFavoriteSchedules(domain) : null; } catch(_){}
  const [favSchedules, setFavSchedules] = useState(() => (favApi && favApi.list ? favApi.list() : []));

  function refreshFavorites(){ try { setFavSchedules(favApi && favApi.list ? favApi.list() : []); } catch(_){} }

  /* ---------------------------- Orchestration sync -------------------------- */
  useEffect(() => {
    // Try boot from automation runtime if available
    try {
      if (automation && automation.templates && automation.templates.list){
        const maybe = automation.templates.list({ domain });
        if (maybe && typeof maybe.then === "function"){
          maybe.then((res) => { if (Array.isArray(res)) setTemplates(res); });
        } else if (Array.isArray(maybe)) {
          setTemplates(maybe);
        }
      }
      if (automation && automation.templates && automation.templates.listMine){
        const m = automation.templates.listMine({ domain });
        if (m && typeof m.then === "function"){ m.then((res)=>{ if (Array.isArray(res)) setMine(res); }); }
        else if (Array.isArray(m)) setMine(m);
      }
    } catch(_){}

    const upsertT = (p={}) => {
      setTemplates((cur) => {
        const arr = Array.isArray(cur)? cur.slice():[];
        const idx = arr.findIndex(x => x && x.id === p.id);
        const next = Object.assign({}, arr[idx]||{}, p);
        if (idx >= 0) arr[idx] = next; else arr.unshift(next);
        return arr;
      });
    };
    const removeT = (p={}) => setTemplates((cur)=>cur.filter(x=>x.id !== p.id));
    const upsertMine = (p={}) => {
      setMine((cur) => {
        const arr = Array.isArray(cur)? cur.slice():[];
        const idx = arr.findIndex(x => x && x.id === p.id);
        const next = Object.assign({}, arr[idx]||{}, p);
        if (idx >= 0) arr[idx] = next; else arr.unshift(next);
        return arr;
      });
    };
    try {
      eventBus.on && eventBus.on("templates.upserted", upsertT);
      eventBus.on && eventBus.on("templates.removed", removeT);
      eventBus.on && eventBus.on("templates.mine.upserted", upsertMine);
    } catch(_){}

    return () => {
      try {
        eventBus.off && eventBus.off("templates.upserted", upsertT);
        eventBus.off && eventBus.off("templates.removed", removeT);
        eventBus.off && eventBus.off("templates.mine.upserted", upsertMine);
      } catch(_){}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  /* --------------------------------- Helpers -------------------------------- */
  const q = query.trim().toLowerCase();
  const filteredSystem = useMemo(
    () => (!q ? templates : templates.filter(t => JSON.stringify(t).toLowerCase().includes(q))),
    [templates, q]
  );
  const filteredMine = useMemo(
    () => (!q ? mine : mine.filter(t => JSON.stringify(t).toLowerCase().includes(q))),
    [mine, q]
  );
  const filteredFavSchedules = useMemo(
    () => (!q ? favSchedules : favSchedules.filter(f => JSON.stringify(f).toLowerCase().includes(q))),
    [favSchedules, q]
  );

  function makeScheduleKeyFromTemplate(t){
    const trg = t && t.trigger ? t.trigger : null;
    if (!trg || !trg.type) return "";
    return `${trg.type}::${JSON.stringify(trg.value)}`;
  }

  function toggleFavoriteScheduleFromTemplate(t){
    const key = makeScheduleKeyFromTemplate(t);
    if (!key) { toastSafe("Template has no schedule.", "warn"); return; }
    try {
      if (!favApi || !favApi.toggleFavorite) {
        eventBus.emit && eventBus.emit("schedule.favorite.toggled", { domain, scheduleKey: key, next:true, trigger: t.trigger, source:"templates" });
        toastSafe("Favorited (best-effort).");
        return;
      }
      const meta = {
        id: key, domain, kind: "schedule", trigger: t.trigger,
        title: `${t.title || "Template"} — ${prettyScheduleLabel(t.trigger)}`
      };
      const next = favApi.toggleFavorite(key, meta);
      if (next && typeof next.then === "function"){
        next.then((v)=> { refreshFavorites(); toastSafe(v ? "Added to favorite schedules." : "Removed from favorite schedules."); });
      } else {
        refreshFavorites();
        toastSafe(next ? "Added to favorite schedules." : "Removed from favorite schedules.");
      }
    } catch(_){ toastSafe("Could not update favorite schedules.", "error"); }
  }

  function openSaveScheduleFromTemplate(t){
    const key = makeScheduleKeyFromTemplate(t);
    if (!key) { toastSafe("Template has no schedule.", "warn"); return; }
    setSavePayload({
      scheduleKey: key,
      domain,
      trigger: t.trigger,
      defaultTitle: `${t.title || "Template"} — ${prettyScheduleLabel(t.trigger)}`
    });
    setSaveOpen(true);
    try {
      eventBus.emit && eventBus.emit("schedule.save.modal.opened", {
        domain, scheduleKey: key, trigger: t.trigger, source:"templates"
      });
    } catch(_){}
  }

  function cloneToMine(t){
    const copy = Object.assign({}, t, {
      id: uid("tmpl"),
      title: (t.title || "Template") + " (Copy)",
      clonedFrom: t.id,
    });
    setMine((cur)=>[copy, ...cur]);
    try {
      if (automation && automation.templates && automation.templates.saveMine){
        const maybe = automation.templates.saveMine({ domain, template: copy });
        if (maybe && typeof maybe.then === "function") maybe.then(()=>toastSafe("Cloned to My Templates."));
      } else {
        eventBus.emit && eventBus.emit("templates.mine.upserted", copy);
        toastSafe("Cloned to My Templates.");
      }
    } catch(_){}
  }

  function removeMine(tid){
    setMine((cur)=>cur.filter(x=>x.id !== tid));
    try {
      if (automation && automation.templates && automation.templates.removeMine){
        automation.templates.removeMine({ domain, id: tid });
      } else {
        eventBus.emit && eventBus.emit("templates.mine.removed", { id: tid, domain });
      }
    } catch(_){}
  }

  function useInRule(t){
    // Broadcast a prefill request for IFTTT rule editor
    const rule = {
      id: uid("rule"),
      title: t.title || "New rule",
      enabled: true,
      priority: 5,
      trigger: t.trigger || { type:"time.at", value:"18:00" },
      conditions: Array.isArray(t.conditions) ? t.conditions : [],
      actions: Array.isArray(t.actions) ? t.actions : [],
      description: t.description || ""
    };
    try {
      eventBus.emit && eventBus.emit("automation.rule.prefill.requested", { rule, domain, source:"templates" });
      toastSafe("Sent to rule editor.");
    } catch(_){}
    setEditing(rule);
    setShowJSON(false);
  }

  /* ------------------------------ Export/Import ------------------------------ */
  function exportLibrary(){
    try {
      const dump = { domain, system: templates, mine };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `templates-${domain}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toastSafe("Downloaded templates.");
    } catch(_){ toastSafe("Export failed.", "error"); }
  }
  function exportToCloud(provider){
    try {
      const dump = { domain, system: templates, mine };
      eventBus.emit && eventBus.emit("automation.rule.export.requested", {
        provider, rule: dump, filename: `templates-${domain}.json`, source: "templates"
      });
      toastSafe(`Sent export to ${provider}.`);
    } catch(_){ toastSafe("Cloud export failed.", "error"); }
  }
  function importLibrary(){
    try {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "application/json";
      inp.onchange = (ev) => {
        const f = ev.target && ev.target.files && ev.target.files[0];
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => {
          const data = safeParse(String(fr.result||""), null);
          if (!data) { toastSafe("Invalid JSON.", "error"); return; }
          if (Array.isArray(data.system)) setTemplates(data.system);
          if (Array.isArray(data.mine)) setMine(data.mine);
          toastSafe("Imported templates.");
        };
        fr.readAsText(f);
      };
      inp.click();
    } catch(_){ toastSafe("Import failed.", "error"); }
  }

  /* ---------------------------------- UI ------------------------------------ */
  return (
    <main className={WRAP}>
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-gray-900">Session Templates</h1>
        <span className={CHIP}>{domain}</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <I.Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
            <input className={cx(FIELD, "pl-8 w-56")} placeholder="Search templates…" value={query} onChange={(e)=>setQuery(e.target.value)} />
          </div>
          <details className="relative">
            <summary className={cx(BTN, VAR.ghost, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
              <I.Download className="h-4 w-4" /> Tools
            </summary>
            <div className="absolute right-0 z-10 mt-2 min-w-[16rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
              <MenuItem onClick={exportLibrary} icon={<I.Download className="h-4 w-4" />} label="Export (.json)" />
              <MenuItem onClick={importLibrary} icon={<I.Upload className="h-4 w-4" />} label="Import (.json)" />
              <div className="h-px bg-gray-100" />
              <MenuItem onClick={()=>exportToCloud("gdrive")} icon={<I.Cloud className="h-4 w-4" />} label="Export to Google Drive" />
              <MenuItem onClick={()=>exportToCloud("onedrive")} icon={<I.Cloud className="h-4 w-4" />} label="Export to OneDrive" />
            </div>
          </details>
          <button className={cx(BTN, VAR.primary)} onClick={()=>setEditing({
            id: uid("tmpl"),
            title: "Untitled template",
            tags: [],
            description: "",
            trigger: { type:"time.at", value:"18:00" },
            conditions: [],
            actions: [{ id:"notify.toast", value:"Hello" }]
          })}>
            <I.Plus className="h-4 w-4" /> New template
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-4 flex flex-wrap gap-2">
        <Tab id="system" label="System" icon={<I.Layers className="h-4 w-4" />} active={tab==="system"} onClick={()=>setTab("system")} count={templates.length} />
        <Tab id="mine" label="My Templates" icon={<I.Sparkles className="h-4 w-4" />} active={tab==="mine"} onClick={()=>setTab("mine")} count={mine.length} />
        <Tab id="favorites" label="Favorite Schedules" icon={<I.Star className="h-4 w-4" />} active={tab==="favorites"} onClick={()=>setTab("favorites")} count={favSchedules.length} />
      </div>

      {/* Body */}
      <div className="mt-4 space-y-6">
        {tab === "system" ? (
          <TemplateGrid
            items={filteredSystem}
            onUse={useInRule}
            onClone={cloneToMine}
            onEdit={(t)=>{ setEditing(t); setShowJSON(false); }}
            onFavoriteSchedule={toggleFavoriteScheduleFromTemplate}
            onSaveSchedule={openSaveScheduleFromTemplate}
          />
        ) : null}

        {tab === "mine" ? (
          <TemplateGrid
            items={filteredMine}
            isMine
            onUse={useInRule}
            onClone={(t)=>cloneToMine(t)}
            onEdit={(t)=>{ setEditing(t); setShowJSON(false); }}
            onDelete={(t)=>removeMine(t.id)}
            onFavoriteSchedule={toggleFavoriteScheduleFromTemplate}
            onSaveSchedule={openSaveScheduleFromTemplate}
          />
        ) : null}

        {tab === "favorites" ? (
          <FavoritesScheduleGrid
            items={filteredFavSchedules}
            onRefresh={refreshFavorites}
            onApply={(fav) => {
              // Send favored schedule to editor as a new rule skeleton
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
              try { eventBus.emit && eventBus.emit("automation.rule.prefill.requested", { rule, domain, source:"templates" }); } catch(_){}
              toastSafe("Applied favorite schedule to a new rule.");
              setEditing(rule);
            }}
          />
        ) : null}
      </div>

      {/* Inline editor area (optional) */}
      {editing ? (
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-gray-900">Editor</div>
            <div className="flex items-center gap-2">
              <button className={cx(BTN, VAR.subtle)} onClick={()=>setShowJSON(!showJSON)}>
                <I.Settings className="h-4 w-4" /> {showJSON ? "Form view" : "Raw JSON"}
              </button>
              <button className={cx(BTN, VAR.primary)} onClick={()=>useInRule(editing)}>
                <I.Zap className="h-4 w-4" /> Use in rule
              </button>
              <button className={cx(BTN, VAR.ghost)} onClick={()=>setEditing(null)}>
                <I.X className="h-4 w-4" /> Close
              </button>
            </div>
          </div>

          <div className="mt-3 rounded-2xl border border-gray-200 bg-white p-3">
            {showJSON ? (
              <RawJSONEditor
                value={editing}
                onApply={(next)=>{
                  setEditing(next);
                  toastSafe("Applied JSON.");
                }}
              />
            ) : IFTTTRuleEditorLazy ? (
              <Suspense fallback={<div className="text-sm text-gray-500 p-3">Loading editor…</div>}>
                <IFTTTTRuleEditorLazy
                  domain={domain}
                  initialRule={{
                    id: editing.id || uid("rule"),
                    title: editing.title || "Template",
                    enabled: true,
                    priority: 5,
                    trigger: editing.trigger || { type:"time.at", value:"18:00" },
                    conditions: Array.isArray(editing.conditions)? editing.conditions : [],
                    actions: Array.isArray(editing.actions)? editing.actions : [],
                    description: editing.description || ""
                  }}
                  onSave={(rule)=>{
                    // Save as "mine" template
                    const t = {
                      id: editing.id || uid("tmpl"),
                      title: rule.title,
                      trigger: rule.trigger,
                      conditions: rule.conditions,
                      actions: rule.actions,
                      description: rule.description,
                      tags: editing.tags || []
                    };
                    setMine((cur)=>[t, ...cur.filter(x=>x.id!==t.id)]);
                    try {
                      if (automation && automation.templates && automation.templates.saveMine){
                        automation.templates.saveMine({ domain, template: t });
                      } else {
                        eventBus.emit && eventBus.emit("templates.mine.upserted", t);
                      }
                    } catch(_){}
                    toastSafe("Template saved to My Templates.");
                  }}
                />
              </Suspense>
            ) : (
              <div className="text-sm text-gray-600">Editor unavailable (lazy import failed).</div>
            )}
          </div>
        </div>
      ) : null}

      {/* Save Schedule modal (lazy preferred) */}
      {saveOpen && savePayload ? (
        SaveScheduleModalLazy ? (
          <Suspense fallback={null}>
            <SaveScheduleModalLazy
              isOpen={true}
              onClose={()=>{ setSaveOpen(false); setSavePayload(null); }}
              domain={savePayload.domain}
              scheduleKey={savePayload.scheduleKey}
              trigger={savePayload.trigger}
              defaultTitle={savePayload.defaultTitle}
              onSaved={(saved)=>{
                try { eventBus.emit && eventBus.emit("schedule.saved", { from:"templates", saved }); } catch(_){}
                toastSafe("Schedule saved.");
                setSaveOpen(false); setSavePayload(null);
                refreshFavorites();
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSchedule
            domain={savePayload.domain}
            scheduleKey={savePayload.scheduleKey}
            trigger={savePayload.trigger}
            defaultTitle={savePayload.defaultTitle}
            onClose={()=>{ setSaveOpen(false); setSavePayload(null); }}
            onSaved={(saved)=>{
              try { eventBus.emit && eventBus.emit("schedule.saved", { from:"templates", saved }); } catch(_){}
              toastSafe("Schedule saved.");
              setSaveOpen(false); setSavePayload(null);
              refreshFavorites();
            }}
          />
        )
      ) : null}
    </main>
  );
}

/* -------------------------------- Components -------------------------------- */
function TemplateGrid({ items, isMine, onUse, onClone, onEdit, onDelete, onFavoriteSchedule, onSaveSchedule }){
  if (!items || !items.length) return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-gray-300 p-10 text-sm text-gray-600">
      No templates yet.
    </div>
  );
  return (
    <div className={GRID}>
      {items.map((t) => {
        const scheduleTitle = prettyScheduleLabel(t.trigger);
        return (
          <article key={t.id} className={CARD}>
            <div className="flex items-start gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-gray-900">{t.title || "Untitled"}</h3>
                <div className="mt-1 flex flex-wrap gap-1">
                  <span className={CHIP}><I.Clock className="h-3 w-3" /> {scheduleTitle}</span>
                  {(t.tags||[]).slice(0,3).map((tag)=> <span key={tag} className={CHIP}>{tag}</span>)}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <button className={cx(BTN, VAR.ghost, "px-2")} title="Favorite schedule" onClick={()=>onFavoriteSchedule && onFavoriteSchedule(t)}>
                  <I.Star className="h-4 w-4 text-amber-500" />
                </button>
                <button className={cx(BTN, VAR.subtle, "px-2")} title="Save schedule" onClick={()=>onSaveSchedule && onSaveSchedule(t)}>
                  <I.Save className="h-4 w-4" />
                </button>
              </div>
            </div>

            {t.description ? <p className="mt-2 text-[13px] text-gray-700 line-clamp-3">{t.description}</p> : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button className={cx(BTN, VAR.primary)} onClick={()=>onUse && onUse(t)}><I.Zap className="h-4 w-4" /> Use in rule</button>
              <button className={cx(BTN, VAR.subtle)} onClick={()=>onEdit && onEdit(t)}><I.Edit className="h-4 w-4" /> Edit</button>
              <button className={cx(BTN, VAR.ghost)} onClick={()=>onClone && onClone(t)}><I.Copy className="h-4 w-4" /> Clone</button>
              {isMine ? (
                <button className={cx(BTN, VAR.danger)} onClick={()=>onDelete && onDelete(t)}><I.Trash className="h-4 w-4" /> Delete</button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function FavoritesScheduleGrid({ items, onRefresh, onApply }){
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button className={cx(BTN, VAR.subtle)} onClick={onRefresh}><I.Settings className="h-4 w-4" /> Refresh</button>
      </div>
      {!items || !items.length ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-gray-300 p-10 text-sm text-gray-600">
          No favorite schedules yet.
        </div>
      ) : (
        <div className={GRID}>
          {items.map((f) => (
            <div key={f.id} className={CARD}>
              <div className="flex items-center justify-between">
                <div className="font-semibold truncate">{f.title || f.id}</div>
                <span className={CHIP}>{prettyScheduleLabel(f.trigger)}</span>
              </div>
              {f.notes ? <div className="mt-1 text-[12px] text-gray-600 line-clamp-2">{f.notes}</div> : null}
              <div className="mt-3">
                <button className={cx(BTN, VAR.primary)} onClick={()=>onApply && onApply(f)}>
                  <I.Play className="h-4 w-4" /> Apply in rule
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuItem(p){
  return (
    <button type="button" onClick={p.onClick} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2">
      {p.icon}{p.label}
    </button>
  );
}

/* ------------------------------ Raw JSON Editor ----------------------------- */
function RawJSONEditor({ value, onApply }){
  const [text, setText] = useState(JSON.stringify(value || {}, null, 2));
  return (
    <div>
      <textarea
        className={cx(FIELD, "min-h-[44vh] font-mono text-xs")}
        value={text}
        onChange={(e)=>setText(e.target.value)}
      />
      <div className="mt-3 flex justify-end gap-2">
        <button className={cx(BTN, VAR.ghost)} onClick={()=>setText(JSON.stringify(value || {}, null, 2))}>
          Reset
        </button>
        <button className={cx(BTN, VAR.primary)} onClick={()=> {
          const next = safeParse(text, null);
          if (!next) { toastSafe("Invalid JSON.", "error"); return; }
          onApply && onApply(next);
        }}>
          <I.Check className="h-4 w-4" /> Apply
        </button>
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
      try { eventBus.emit && eventBus.emit("schedule.save.requested", { payload, source: "templates" }); } catch(_){}
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
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={props.onClose} aria-label="Close">
            <I.X className="h-4 w-4" />
          </button>
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
