/* eslint-disable no-console */
// src/components/scheduler/TemplatePicker.jsx
import React, { useEffect, useMemo, useRef, useState, Suspense } from "react";

/* --------------------------------- Tokens ---------------------------------- */
var cx = function(){ return Array.prototype.slice.call(arguments).filter(Boolean).join(" "); };
var WRAP = "rounded-3xl border border-gray-200 bg-white shadow-sm";
var BTN  = "inline-flex items-center gap-2 rounded-2xl px-3 py-1.5 text-sm font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 active:translate-y-px";
var VAR  = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle:  "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost:   "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
};
var FIELD = "w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600";
var CHIP  = "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2.5 py-0.5 text-[11px] font-medium text-gray-700";
var CARD  = "group relative rounded-2xl border border-gray-200 bg-white p-3 shadow-xs hover:shadow-sm transition";

/* ----------------------------- Defensive imports ---------------------------- */
var eventBus = { emit:function(){}, on:function(){}, off:function(){} };
try {
  var eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
} catch(_){}

var useFavoriteTemplates = null;
try {
  var favMod = require("@/hooks/useFavoriteTemplates");
  useFavoriteTemplates = favMod && (favMod.useFavoriteTemplates || favMod.default) || null;
} catch(_){}

var SaveTemplateModalLazy = null;
try {
  SaveTemplateModalLazy = React.lazy(function(){ return import("@/components/scheduler/SaveTemplateModal.jsx"); });
} catch(_){}

/* ----------------------------------- Icons ---------------------------------- */
var I = {};
try {
  var L = require("lucide-react");
  I = {
    Star: L.Star,
    StarOff: L.StarOff,
    Save: L.Save,
    Search: L.Search,
    Filter: L.Filter,
    Grid: L.LayoutGrid,
    List: L.List,
    Eye: L.Eye,
    Play: L.Play,
    More: L.MoreHorizontal,
    Download: L.Download,
    Upload: L.Upload,
    Calendar: L.Calendar,
    Check: L.Check,
    X: L.X,
    Sparkles: L.Sparkles,
    Tag: L.Tag,
    Clock: L.Clock3,
  };
} catch(_){
  I = {
    Star: function(){return <span>★</span>;},
    StarOff: function(){return <span>☆</span>;},
    Save: function(){return <span>💾</span>;},
    Search: function(){return <span>🔎</span>;},
    Filter: function(){return <span>⧉</span>;},
    Grid: function(){return <span>▦</span>;},
    List: function(){return <span>≣</span>;},
    Eye: function(){return <span>👁</span>;},
    Play: function(){return <span>▶</span>;},
    More: function(){return <span>⋯</span>;},
    Download: function(){return <span>⬇</span>;},
    Upload: function(){return <span>⬆</span>;},
    Calendar: function(){return <span>📅</span>;},
    Check: function(){return <span>✔</span>;},
    X: function(){return <span>✕</span>;},
    Sparkles: function(){return <span>✦</span>;},
    Tag: function(){return <span>🏷</span>;},
    Clock: function(){return <span>🕒</span>;},
  };
}

/* ---------------------------------- Utils ---------------------------------- */
function toastSafe(message, variant){
  try { eventBus.emit("ui.toast", { message: message, variant: variant || "success" }); }
  catch(_){ if (variant === "error") console.warn(message); else console.log(message); }
}
function uid(prefix){ return (prefix||"id")+":"+Math.random().toString(36).slice(2,9); }
function safeFile(name){ return String(name||"template").toLowerCase().replace(/[^a-z0-9-_]+/gi,"-").replace(/-+/g,"-"); }
function safeParse(text, fallback){ try { return JSON.parse(text); } catch(_){ return fallback; } }

/* ----------------------------- Default placeholders ----------------------------- */
var DEFAULT_TEMPLATES = [
  { id:"sys:morning-routine", title:"Morning Routine", domain:"meals", tags:["daily","short"], estMin:25, description:"Quick morning flow with prep and cleanup." },
  { id:"sys:evening-reset",   title:"Evening Reset",   domain:"cleaning", tags:["daily"],      estMin:40, description:"Surface wipe, quick tidy, dish cycle." },
  { id:"sys:pet-care",        title:"Pet Care",        domain:"animals", tags:["weekly"],     estMin:30, description:"Feed, brush, litter refresh or walk." },
];

/* ---------------------------------- Component --------------------------------- */
/**
 * TemplatePicker — select a plan/template per domain
 *
 * Props:
 *  - domain?: string (default "session")
 *  - value?: string | object (selected template id or object)
 *  - templates?: array (prefetched list)
 *  - showHeader?: boolean (default true)
 *  - onChange?: (templateObj) => void
 *  - onPreview?: (templateObj) => void
 *  - onStart?: (templateObj) => void  // emits session.start.requested with template details
 */
export default function TemplatePicker(props){
  var domain = props.domain || "session";
  var showHeader = props.showHeader !== false;

  /* Catalog state */
  var _list = useState(Array.isArray(props.templates) && props.templates.length ? props.templates : DEFAULT_TEMPLATES), list = _list[0], setList = _list[1];
  var _loading = useState(false), loading = _loading[0], setLoading = _loading[1];

  /* UI state */
  var _q = useState(""), q = _q[0], setQ = _q[1];
  var _tag = useState(""), tag = _tag[0], setTag = _tag[1];
  var _view = useState("grid"), view = _view[0], setView = _view[1]; // "grid" | "list"
  var _saveOpen = useState(false), saveOpen = _saveOpen[0], setSaveOpen = _saveOpen[1];

  /* Favorites (user-owned templates) */
  var favApi = null;
  try { favApi = useFavoriteTemplates ? useFavoriteTemplates(domain) : null; } catch(_){}
  var _favSet = useState(function(){ return new Set(); }), favSet = _favSet[0], setFavSet = _favSet[1];

  /* Selection */
  var _sel = useState(props.value || null), selected = _sel[0], setSelected = _sel[1];

  /* Load from orchestrator (catalog) */
  useEffect(function(){
    var done = false;
    setLoading(true);
    try {
      // Ask for a domain-scoped catalog; reply should be an array of templates
      eventBus.emit && eventBus.emit("templates.catalog.requested", {
        domain: domain,
        source: "TemplatePicker",
        reply: function(items){
          if (done) return;
          var arr = Array.isArray(items) && items.length ? items : list;
          setList(arr);
          // seed favSet (defensive)
          try {
            if (favApi && favApi.isFavorite) {
              var s = new Set();
              for (var i=0;i<arr.length;i++){
                var t = arr[i];
                if (favApi.isFavorite(t.id)) s.add(t.id);
              }
              setFavSet(s);
            }
          } catch(_){}
          setLoading(false);
        }
      });
      // if nobody replies, fall back quickly
      setTimeout(function(){ if (!done) { setLoading(false); } }, 350);
    } catch(_){
      setLoading(false);
    }
    return function(){ done = true; };
  }, [domain]);

  /* Derived: tags, filtered list */
  var allTags = useMemo(function(){
    var s = new Set();
    (list||[]).forEach(function(t){ (t.tags||[]).forEach(function(x){ s.add(x); }); });
    return Array.from(s).sort();
  }, [list]);

  var filtered = useMemo(function(){
    var term = q.trim().toLowerCase();
    return (list||[]).filter(function(t){
      var matchQ = !term || (String(t.title||"").toLowerCase().indexOf(term) >= 0) || (String(t.description||"").toLowerCase().indexOf(term) >= 0);
      var matchTag = !tag || (t.tags||[]).indexOf(tag) >= 0;
      var matchDomain = !domain || (t.domain || domain) === domain; // prefer scoped
      return matchQ && matchTag && matchDomain;
    });
  }, [list, q, tag, domain]);

  /* Actions */
  function selectTemplate(t){
    setSelected(t && (t.id || t));
    props.onChange && props.onChange(t);
    try {
      eventBus.emit && eventBus.emit("scheduler.template.selected", {
        domain: domain, template: t, source: "TemplatePicker"
      });
    } catch(_){}
  }

  function previewTemplate(t){
    props.onPreview && props.onPreview(t);
    try {
      eventBus.emit && eventBus.emit("template.open.preview", {
        domain: domain, template: t, source: "TemplatePicker"
      });
    } catch(_){}
  }

  function startFromTemplate(t){
    // Fire a session start seeded by this template
    props.onStart && props.onStart(t);
    try {
      eventBus.emit && eventBus.emit("session.start.requested", {
        domain: domain,
        source: "TemplatePicker",
        templateId: t.id,
        template: t
      });
      toastSafe("Starting session from template…");
    } catch(_){}
  }

  function toggleFavoriteTemplate(t){
    try {
      if (favApi && favApi.toggleFavorite){
        var maybe = favApi.toggleFavorite(t.id, t);
        if (maybe && typeof maybe.then === "function"){
          maybe.then(function(v){
            setFavSet(function(prev){ var s=new Set(prev); if (v) s.add(t.id); else s.delete(t.id); return s; });
          });
        } else {
          var isNow = !!maybe;
          setFavSet(function(prev){ var s=new Set(prev); if (isNow) s.add(t.id); else s.delete(t.id); return s; });
        }
      } else {
        // local UI toggle + event
        setFavSet(function(prev){
          var s = new Set(prev);
          var add = !s.has(t.id);
          if (add) s.add(t.id); else s.delete(t.id);
          try {
            eventBus.emit && eventBus.emit("template.favorite.toggled", {
              domain: domain, templateId: t.id, next: add, meta: { title: t.title }, source: "TemplatePicker"
            });
          } catch(_){}
          toastSafe(add ? "Added to favorite templates." : "Removed from favorite templates.");
          return s;
        });
      }
    } catch(_){
      toastSafe("Could not update favorite templates.", "error");
    }
  }

  function openSaveTemplate(t){
    setSaveOpen(true);
    try {
      eventBus.emit && eventBus.emit("template.save.modal.opened", {
        domain: domain, template: t, source: "TemplatePicker"
      });
    } catch(_){}
  }

  function exportTemplate(t){
    try {
      var blob = new Blob([JSON.stringify(t, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = safeFile(t.title || t.id || "template") + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
      toastSafe("Downloaded template.");
    } catch(_){ toastSafe("Export failed.", "error"); }
  }

  function importTemplate(){
    try {
      var el = document.createElement("input");
      el.type = "file"; el.accept = "application/json";
      el.onchange = function(e){
        var f = e.target && e.target.files && e.target.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function(){
          var tpl = safeParse(String(fr.result||""), null);
          if (!tpl || !tpl.title) { toastSafe("Invalid template file.", "error"); return; }
          tpl.id = tpl.id || uid("tpl");
          setList(function(prev){ return [tpl].concat(prev||[]); });
          toastSafe("Imported template.");
        };
        fr.readAsText(f);
      };
      el.click();
    } catch(_){ toastSafe("Import failed.", "error"); }
  }

  /* ---------------------------------- UI ------------------------------------ */
  return (
    <section className={WRAP} aria-label="Template picker">
      {/* Header */}
      {showHeader ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gradient-to-r from-white to-gray-50 px-4 py-3 rounded-t-3xl">
          <div className="relative w-full sm:w-96">
            <I.Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
            <input
              className={cx(FIELD, "pl-9")}
              value={q}
              onChange={function(e){ setQ(e.target.value); }}
              placeholder="Search templates…"
              aria-label="Search templates"
            />
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <div className="relative">
              <button className={cx(BTN, VAR.subtle)} title="Filter by tag">
                <I.Filter className="h-4 w-4" />
                <span className="hidden sm:inline">Filter</span>
              </button>
              {/* Simple tag popover */}
              <div className="absolute z-10 mt-2 min-w-[14rem] rounded-xl border border-gray-200 bg-white shadow-xl p-2 hidden group-hover:block"></div>
              <details className="absolute right-0">
                <summary className="sr-only">open</summary>
              </details>
            </div>

            <select className={cx(FIELD, "w-36")} value={tag} onChange={function(e){ setTag(e.target.value); }} aria-label="Tag filter">
              <option value="">All tags</option>
              {allTags.map(function(t){ return <option key={t} value={t}>{t}</option>; })}
            </select>

            <button
              className={cx(BTN, VAR.ghost)}
              onClick={function(){ setView(view === "grid" ? "list" : "grid"); }}
              title={view === "grid" ? "Switch to list view" : "Switch to grid view"}
              aria-label="Toggle view"
            >
              {view === "grid" ? <I.List className="h-4 w-4" /> : <I.Grid className="h-4 w-4" />}
            </button>

            <details className="relative">
              <summary className={cx(BTN, VAR.ghost, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
                <I.More className="h-4 w-4" />
                <span className="hidden sm:inline">More</span>
              </summary>
              <div className="absolute right-0 z-10 mt-2 min-w-[14rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
                <MenuItem onClick={importTemplate} icon={<I.Upload className="h-4 w-4" />} label="Import template (.json)" />
                <MenuItem onClick={function(){
                  // quick-create personal blank
                  var t = { id: uid("tpl"), title:"My custom template", domain: domain, tags:["custom"], estMin:30, description:"", steps:[] };
                  setList(function(prev){ return [t].concat(prev||[]); });
                  setQ("My custom template");
                  toastSafe("Added a new custom template. Edit and Save as needed.");
                }} icon={<I.Sparkles className="h-4 w-4" />} label="New custom template" />
              </div>
            </details>
          </div>
        </div>
      ) : null}

      {/* Body */}
      <div className="px-4 py-4">
        {loading ? (
          <div className="text-sm text-gray-500">Loading templates…</div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-gray-500">No templates. Try clearing filters or importing one.</div>
        ) : view === "list" ? (
          <ListView
            items={filtered}
            favSet={favSet}
            onFavorite={toggleFavoriteTemplate}
            onPreview={previewTemplate}
            onSelect={selectTemplate}
            onStart={startFromTemplate}
            onSave={openSaveTemplate}
            onExport={exportTemplate}
            selected={selected}
          />
        ) : (
          <GridView
            items={filtered}
            favSet={favSet}
            onFavorite={toggleFavoriteTemplate}
            onPreview={previewTemplate}
            onSelect={selectTemplate}
            onStart={startFromTemplate}
            onSave={openSaveTemplate}
            onExport={exportTemplate}
            selected={selected}
          />
        )}
      </div>

      {/* Save Template modal (lazy preferred; inline fallback below) */}
      {saveOpen ? (
        SaveTemplateModalLazy ? (
          <Suspense fallback={null}>
            <SaveTemplateModalLazy
              isOpen={true}
              onClose={function(){ setSaveOpen(false); }}
              domain={domain}
              onSaved={function(saved){
                setList(function(prev){ return [saved].concat(prev||[]); });
                try { eventBus.emit && eventBus.emit("template.saved", { from:"TemplatePicker", saved:saved }); } catch(_){}
                toastSafe("Template saved.");
                setSaveOpen(false);
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveTemplate
            domain={domain}
            onClose={function(){ setSaveOpen(false); }}
            onSaved={function(saved){
              setList(function(prev){ return [saved].concat(prev||[]); });
              try { eventBus.emit && eventBus.emit("template.saved", { from:"TemplatePicker", saved:saved }); } catch(_){}
              toastSafe("Template saved.");
              setSaveOpen(false);
            }}
          />
        )
      ) : null}
    </section>
  );
}

/* -------------------------------- Subcomponents ----------------------------- */
function MenuItem(props){
  return (
    <button type="button" onClick={props.onClick} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2">
      {props.icon}<span>{props.label}</span>
    </button>
  );
}

function GridView(props){
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {props.items.map(function(t){
        var fav = props.favSet.has(t.id);
        var selected = props.selected && (props.selected === t.id || props.selected === t);
        return (
          <article key={t.id || t.title} className={cx(CARD, selected && "ring-2 ring-indigo-500")}>
            <header className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <h4 className="truncate text-sm font-semibold text-gray-900">{t.title}</h4>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-600">
                  <span className={CHIP}><I.Calendar className="h-3.5 w-3.5" /> {t.domain || "session"}</span>
                  {typeof t.estMin === "number" ? <span className={CHIP}><I.Clock className="h-3.5 w-3.5" /> ~{t.estMin}m</span> : null}
                </div>
              </div>
              <button
                className={cx(BTN, VAR.ghost, "px-2")}
                title={fav ? "Unfavorite template" : "Favorite template"}
                onClick={function(){ props.onFavorite(t); }}
              >
                {fav ? <I.Star className="h-4 w-4 text-amber-500" /> : <I.StarOff className="h-4 w-4" />}
              </button>
            </header>

            {t.description ? <p className="mt-2 line-clamp-2 text-xs text-gray-600">{t.description}</p> : null}

            <div className="mt-2 flex flex-wrap gap-1">
              {(t.tags||[]).slice(0,4).map(function(tag){ return <span key={tag} className={CHIP}><I.Tag className="h-3.5 w-3.5" />{tag}</span>; })}
              {(t.tags||[]).length > 4 ? <span className={CHIP}>+{(t.tags||[]).length - 4}</span> : null}
            </div>

            <footer className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button className={cx(BTN, VAR.subtle)} onClick={function(){ props.onPreview(t); }}>
                  <I.Eye className="h-4 w-4" />
                  Preview
                </button>
                <button className={cx(BTN, VAR.ghost)} onClick={function(){ props.onSave(t); }}>
                  <I.Save className="h-4 w-4" />
                  Save as…
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button className={cx(BTN, VAR.primary)} onClick={function(){ props.onStart(t); }}>
                  <I.Play className="h-4 w-4" />
                  Start
                </button>
                <details className="relative">
                  <summary className={cx(BTN, VAR.ghost, "cursor-pointer list-none [&::-webkit-details-marker]:hidden px-2")}>
                    <I.More className="h-4 w-4" />
                  </summary>
                  <div className="absolute right-0 z-10 mt-2 min-w-[12rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
                    <MenuItem onClick={function(){ props.onSelect(t); }} icon={<I.Check className="h-4 w-4" />} label="Select" />
                    <MenuItem onClick={function(){ props.onExport(t); }} icon={<I.Download className="h-4 w-4" />} label="Export (.json)" />
                  </div>
                </details>
              </div>
            </footer>
          </article>
        );
      })}
    </div>
  );
}

function ListView(props){
  return (
    <ul className="divide-y divide-gray-100">
      {props.items.map(function(t){
        var fav = props.favSet.has(t.id);
        var selected = props.selected && (props.selected === t.id || props.selected === t);
        return (
          <li key={t.id || t.title} className={cx("py-3 flex items-center gap-3", selected && "bg-indigo-50/40")}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-gray-900">{t.title}</span>
                <span className={CHIP}><I.Calendar className="h-3.5 w-3.5" /> {t.domain || "session"}</span>
                {typeof t.estMin === "number" ? <span className={CHIP}><I.Clock className="h-3.5 w-3.5" /> ~{t.estMin}m</span> : null}
              </div>
              {t.description ? <p className="mt-0.5 line-clamp-1 text-xs text-gray-600">{t.description}</p> : null}
              <div className="mt-1 flex flex-wrap gap-1">
                {(t.tags||[]).slice(0,6).map(function(tag){ return <span key={tag} className={CHIP}><I.Tag className="h-3.5 w-3.5" />{tag}</span>; })}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button className={cx(BTN, VAR.ghost, "px-2")} onClick={function(){ props.onFavorite(t); }} title={fav ? "Unfavorite template" : "Favorite template"}>
                {fav ? <I.Star className="h-4 w-4 text-amber-500" /> : <I.StarOff className="h-4 w-4" />}
              </button>
              <button className={cx(BTN, VAR.subtle)} onClick={function(){ props.onPreview(t); }}>
                <I.Eye className="h-4 w-4" />
                Preview
              </button>
              <button className={cx(BTN, VAR.ghost)} onClick={function(){ props.onSave(t); }}>
                <I.Save className="h-4 w-4" />
                Save as…
              </button>
              <button className={cx(BTN, VAR.primary)} onClick={function(){ props.onStart(t); }}>
                <I.Play className="h-4 w-4" />
                Start
              </button>
              <details className="relative">
                <summary className={cx(BTN, VAR.ghost, "cursor-pointer list-none [&::-webkit-details-marker]:hidden px-2")}>
                  <I.More className="h-4 w-4" />
                </summary>
                <div className="absolute right-0 z-10 mt-2 min-w-[12rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
                  <MenuItem onClick={function(){ props.onSelect(t); }} icon={<I.Check className="h-4 w-4" />} label="Select" />
                  <MenuItem onClick={function(){ props.onExport(t); }} icon={<I.Download className="h-4 w-4" />} label="Export (.json)" />
                </div>
              </details>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------ Inline Save Template (fallback) ------------------- */
function InlineSaveTemplate(props){
  var _name = useState("My template"), name = _name[0], setName = _name[1];
  var _desc = useState(""), desc = _desc[0], setDesc = _desc[1];
  var _tags = useState("custom"), tags = _tags[0], setTags = _tags[1];
  var _busy = useState(false), busy = _busy[0], setBusy = _busy[1];

  function submit(){
    setBusy(true);
    try {
      var payload = {
        id: uid("tpl"),
        title: name,
        description: desc,
        tags: tags.split(",").map(function(x){return x.trim();}).filter(Boolean),
        domain: props.domain || "session",
        estMin: 30,
        userOwned: true
      };
      try {
        eventBus.emit && eventBus.emit("template.save.requested", { payload: payload, source: "TemplatePicker" });
      } catch(_){}
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
      aria-label="Save template"
      onClick={function(e){ if (e.target === e.currentTarget) props.onClose && props.onClose(); }}
    >
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">Save Template</h3>
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={props.onClose}><I.X className="h-4 w-4" /></button>
        </div>

        <label className="mt-4 block text-sm font-medium text-gray-700">Title</label>
        <input className={FIELD} value={name} onChange={function(e){ setName(e.target.value); }} placeholder="Template title" />

        <label className="mt-4 block text-sm font-medium text-gray-700">Description</label>
        <textarea className={cx(FIELD, "min-h-[96px]")} value={desc} onChange={function(e){ setDesc(e.target.value); }} placeholder="What does this template cover?" />

        <label className="mt-4 block text-sm font-medium text-gray-700">Tags (comma separated)</label>
        <input className={FIELD} value={tags} onChange={function(e){ setTags(e.target.value); }} placeholder="daily, quick" />

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
