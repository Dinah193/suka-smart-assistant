// src/pages/settings/ProfileSettingsPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as Icons from "lucide-react";
import { automation } from "@/services/automation/runtime";
import SettingToggle from "@/components/settings/SettingToggle.jsx";
import SettingMultiCheck from "@/components/settings/SettingMultiCheck.jsx";

/* -------------------------------- soft imports -------------------------------- */
let SafeIcon = (p) => <span {...p}>{p.children}</span>;
try { SafeIcon = require("@/components/icons/SafeIcon.jsx").default; } catch {}

let Profile = null;
try { Profile = require("@/services/profile/householdProfileService"); }
catch { Profile = { getProfile: async () => ({}), subscribe: () => () => {}, setAtPath: () => {} }; }

let Jobs = null;
try { Jobs = require("@/services/jobs/engine"); }
catch { Jobs = { on: () => () => {}, emit: () => {} }; }

/* -------------------------------- helpers ------------------------------------ */
const cls = (...xs) => xs.filter(Boolean).join(" ");
const uid = () => Math.random().toString(36).slice(2, 9);
const detectTimezone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } };
const isTimeLike = (s) => /^\d{1,2}:\d{2}$/.test(String(s || ""));
const clampNumber = (n, a, b) => Math.max(a, Math.min(b, Number(n || 0)));

/* --------------------------------- data -------------------------------------- */
const AREA_OPTIONS = [
  { id: "cooking",   label: "Cooking & Meals",        iconKey: "ChefHat" },
  { id: "cleaning",  label: "Household Cleaning",     iconKey: "Sparkles" },
  { id: "inventory", label: "Inventory/Storehouse",   iconKey: "Database" },
  { id: "garden",    label: "Garden",                 iconKey: "Leaf" },
  { id: "animal",    label: "Animal Care",            iconKey: "PawPrint" },
  { id: "errand",    label: "Errands/Shopping",       iconKey: "Bell" },
];

const CUISINES_GROUPED = [
  { group: "Americas", items: [
    { id:"american", label:"American" }, { id:"african_american", label:"African American / Soul Food" },
    { id:"texmex", label:"Tex-Mex" }, { id:"cajun", label:"Cajun" }, { id:"creole", label:"Creole" },
    { id:"jamaican", label:"Jamaican" }, { id:"trinidadian", label:"Trinidadian" }, { id:"mexican", label:"Mexican" },
    { id:"peruvian", label:"Peruvian" }, { id:"brazilian", label:"Brazilian" }, { id:"argentinian", label:"Argentinian" },
    { id:"colombian", label:"Colombian" }, { id:"british", label:"British / Irish" },
  ]},
  { group: "Europe & Mediterranean", items: [
    { id:"italian", label:"Italian" }, { id:"sicilian", label:"Sicilian" }, { id:"french", label:"French" },
    { id:"spanish", label:"Spanish" }, { id:"portuguese", label:"Portuguese" }, { id:"greek", label:"Greek" },
    { id:"mediterranean", label:"Mediterranean (general)" }, { id:"german", label:"German" },
    { id:"polish", label:"Polish" }, { id:"russian", label:"Russian" }, { id:"ukrainian", label:"Ukrainian" },
    { id:"nordic", label:"Nordic / Scandinavian" },
  ]},
  { group: "Middle East & North Africa", items: [
    { id:"turkish", label:"Turkish" }, { id:"lebanese", label:"Lebanese" }, { id:"syrian", label:"Syrian" },
    { id:"palestinian", label:"Palestinian" }, { id:"israeli", label:"Israeli" }, { id:"iraqi", label:"Iraqi" },
    { id:"persian", label:"Persian (Iranian)" }, { id:"egyptian", label:"Egyptian" }, { id:"moroccan", label:"Moroccan" },
    { id:"tunisian", label:"Tunisian" },
  ]},
  { group: "Sub-Saharan Africa", items: [
    { id:"ethiopian", label:"Ethiopian" }, { id:"eritrean", label:"Eritrean" }, { id:"somali", label:"Somali" },
    { id:"nigerian", label:"Nigerian" }, { id:"ghanaian", label:"Ghanaian" }, { id:"kenyan", label:"Kenyan" },
    { id:"south_african", label:"South African" },
  ]},
  { group: "South Asia", items: [
    { id:"indian_north", label:"Indian (North)" }, { id:"indian_south", label:"Indian (South)" },
    { id:"pakistani", label:"Pakistani" }, { id:"bangladeshi", label:"Bangladeshi" }, { id:"sri_lankan", label:"Sri Lankan" },
    { id:"nepali", label:"Nepali" }, { id:"tibetan", label:"Tibetan" },
  ]},
  { group: "East Asia", items: [
    { id:"chinese_cantonese", label:"Chinese (Cantonese)" },
    { id:"chinese_sichuan", label:"Chinese (Sichuan)" },
    { id:"chinese_hunan", label:"Chinese (Hunan)" },
    { id:"chinese_shanghai", label:"Chinese (Shanghai)" },
    { id:"taiwanese", label:"Taiwanese" }, { id:"japanese", label:"Japanese" },
    { id:"korean", label:"Korean" }, { id:"mongolian", label:"Mongolian" },
  ]},
  { group: "Southeast Asia", items: [
    { id:"thai", label:"Thai" }, { id:"vietnamese", label:"Vietnamese" }, { id:"filipino", label:"Filipino" },
    { id:"malaysian", label:"Malaysian" }, { id:"indonesian", label:"Indonesian" }, { id:"singaporean", label:"Singaporean" },
    { id:"khmer", label:"Cambodian (Khmer)" }, { id:"laotian", label:"Laotian" }, { id:"burmese", label:"Burmese" },
  ]},
  { group: "Central Asia", items: [ { id:"uzbek", label:"Central Asian (Uzbek)" } ]},
];

/* ------------------------------ UI primitives ------------------------------ */
const WIDTH_MIN = 96, WIDTH_MAX = 192, WIDTH_DEFAULT = 160;

function FieldInput({ label, value, onChange, type="text", placeholder, id, width = WIDTH_DEFAULT }) {
  const w = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, width));
  const wrapStyle = { display:"inline-block", width:w, minWidth:w, maxWidth:w, flex:`0 0 ${w}px`, verticalAlign:"top", marginBottom:10 };
  return (
    <label className="space-y-1" title={label} style={wrapStyle}>
      <div className="text-xs font-semibold opacity-80">{label}</div>
      <input id={id} type={type} className="btn" value={value} onChange={(e)=>onChange(e.target.value)} placeholder={placeholder} style={{ width:"100%", paddingBlock:6 }} />
    </label>
  );
}

function FieldSelect({ label, value, onChange, options, id, width = WIDTH_DEFAULT, showLabel = true, srLabel }) {
  const w = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, width));
  const wrapStyle = { display:"inline-block", width:w, minWidth:w, maxWidth:w, flex:`0 0 ${w}px`, verticalAlign:"top", marginBottom:10 };
  return (
    <label className="space-y-1" title={label} style={wrapStyle}>
      {showLabel && <div className="text-xs font-semibold opacity-80">{label}</div>}
      <select id={id} className="btn" value={value} onChange={(e)=>onChange(e.target.value)} aria-label={!showLabel ? (srLabel || label || id || "Select") : undefined} style={{ width:"100%", paddingBlock:6 }}>
        {options.map((o, i) => (<option key={`${o.value}-${o.label}-${i}`} value={o.value}>{o.label}</option>))}
      </select>
    </label>
  );
}

function SwitchTiny({ label, checked, onChange, hint }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 bg-white"
      title={hint || label} style={{ boxShadow:"0 1px 0 rgba(0,0,0,.04)" }}>
      <span className="text-sm">{label}</span>
      <input type="checkbox" className="h-4 w-4" checked={checked} onChange={(e)=>onChange(e.target.checked)} />
    </label>
  );
}

function DropdownMulti({ label, value = [], onChange, groups, placeholder = "Select…" }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(""); const ref = useRef(null); const selected = new Set(value);
  useEffect(() => { const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", onDoc); return () => document.removeEventListener("mousedown", onDoc); }, []);
  const allOptions = useMemo(() => groups.flatMap(g => g.items), [groups]);
  const filtered = useMemo(() => { const s = q.toLowerCase(); if (!s) return null; return allOptions.filter(o => o.label.toLowerCase().includes(s)); }, [q, allOptions]);
  const toggle = (id) => { const next = new Set(selected); next.has(id) ? next.delete(id) : next.add(id); onChange(Array.from(next)); };
  const summary = value.length === 0 ? placeholder : value.length <= 2 ? value.map(v => allOptions.find(o => o.id === v)?.label || v).join(", ") : `${value.length} selected`;
  const wrapStyle = { display:"inline-block", width:WIDTH_MAX, minWidth:WIDTH_MAX, maxWidth:WIDTH_MAX, flex:`0 0 ${WIDTH_MAX}px`, verticalAlign:"top", position:"relative", marginBottom:10 };
  return (
    <div ref={ref} style={wrapStyle}>
      <div className="space-y-1">
        <div className="text-xs font-semibold opacity-80">{label}</div>
        <button type="button" className="btn" onClick={() => setOpen(v => !v)} aria-expanded={open} style={{ width:"100%", justifyContent:"space-between" }}>
          <span className="label">{summary}</span><Icons.ChevronDown className="w-4 h-4" />
        </button>
      </div>
      {open && (
        <div className="card" style={{ position:"absolute", zIndex:50, marginTop:6, right:0, width:WIDTH_MAX, maxHeight:320, overflow:"hidden", padding:8 }}>
          <input className="btn" placeholder="Search…" value={q} onChange={(e)=>setQ(e.target.value)} style={{ width:"100%", marginBottom:6, paddingBlock:6 }} />
          <div style={{ maxHeight:250, overflowY:"auto" }}>
            {filtered ? (filtered.length ? filtered.map(o => (
              <label key={o.id} className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-stone-50 cursor-pointer">
                <span className="text-sm">{o.label}</span><input type="checkbox" checked={selected.has(o.id)} onChange={() => toggle(o.id)} />
              </label>
            )) : <div className="subtitle text-sm px-2 py-1">No matches</div>) : (
              groups.map(g => (
                <div key={g.group} className="mb-2">
                  <div className="text-xs font-semibold opacity-70 px-2 py-1">{g.group}</div>
                  {g.items.map(o => (
                    <label key={o.id} className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-stone-50 cursor-pointer">
                      <span className="text-sm">{o.label}</span><input type="checkbox" checked={selected.has(o.id)} onChange={() => toggle(o.id)} />
                    </label>
                  ))}
                </div>
              ))
            )}
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <button className="btn sm" onClick={() => { onChange([]); setQ(""); }}>Clear</button>
            <button className="btn sm primary" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------- Favorite Dishes (chip input) ----------------------- */
function DishesInput({ label = "Favorite Dishes", value = [], onChange, cuisines = [] }) {
  // Normalize to objects to support tagging with cuisine
  const normalized = Array.isArray(value)
    ? value.map((v) => (typeof v === "string" ? { name: v } : v))
    : [];

  const [text, setText] = useState("");
  const [dishCuisine, setDishCuisine] = useState("");

  const cuisineOptions = useMemo(
    () => [{ id: "", label: "Any cuisine" }].concat(
      cuisines.map((c) => ({ id: c.id, label: c.label }))
    ),
    [cuisines]
  );

  const addDish = (raw) => {
    const name = (raw || text || "").trim();
    if (!name) return;
    const next = [...normalized, { name, cuisineId: dishCuisine || undefined }];
    onChange(next);
    setText("");
  };

  const removeDish = (idx) => {
    const next = normalized.slice();
    next.splice(idx, 1);
    onChange(next);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addDish();
    } else if (e.key === "Backspace" && !text && normalized.length) {
      removeDish(normalized.length - 1);
    }
  };

  const cuisineLabel = (id) => {
    if (!id) return "";
    const all = CUISINES_GROUPED.flatMap((g) => g.items);
    return all.find((x) => x.id === id)?.label || "";
  };

  return (
    <div className="space-y-1" style={{ minWidth: 280 }}>
      <div className="text-xs font-semibold opacity-80">{label}</div>

      <div className="rounded-xl border bg-white px-2 py-2" style={{ boxShadow:"0 1px 0 rgba(0,0,0,.04)" }}>
        {/* chips */}
        <div className="flex flex-wrap gap-2 mb-2">
          {normalized.length === 0 && (
            <span className="text-xs opacity-60">Add a few dishes you love (e.g., “pho”, “chicken tikka masala”).</span>
          )}
          {normalized.map((d, i) => (
            <span key={`${d.name}-${i}`} className="inline-flex items-center gap-2 px-2 py-1 rounded-full border bg-white text-sm"
                  title={d.cuisineId ? cuisineLabel(d.cuisineId) : "Any cuisine"}>
              <Icons.Heart className="w-3 h-3" />
              <span>{d.name}</span>
              {d.cuisineId && <span className="opacity-60 text-xs">• {cuisineLabel(d.cuisineId)}</span>}
              <button type="button" className="btn sm" onClick={() => removeDish(i)} aria-label={`Remove ${d.name}`}>
                <Icons.X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>

        {/* input row */}
        <div className="flex items-center gap-2">
          <input
            className="btn"
            placeholder="Type a dish and press Enter…"
            value={text}
            onChange={(e)=>setText(e.target.value)}
            onKeyDown={onKeyDown}
            style={{ flex: 1, paddingBlock: 6 }}
          />
          <select
            className="btn"
            value={dishCuisine}
            onChange={(e)=>setDishCuisine(e.target.value)}
            style={{ minWidth: 160 }}
            title="Optional: tag the dish with a cuisine"
          >
            {cuisineOptions.map((c) => (
              <option key={c.id || "any"} value={c.id}>{c.label}</option>
            ))}
          </select>
          <button className="btn primary sm" onClick={()=>addDish()}>
            <Icons.Plus className="w-4 h-4" />
            <span className="label">Add</span>
          </button>
        </div>
      </div>

      <div className="text-xs opacity-70">
        Tip: these help our agents bias recipes and suggestions toward your exact tastes.
      </div>
    </div>
  );
}

/* ---------------------------- collapsible section -------------------------- */
function Collapsible({ title, icon: Icon = Icons.ChevronDown, defaultOpen = false, children, hint }) {
  return (
    <details className="card bg-base-100 border border-base-200 shadow-sm rounded-2xl" open={defaultOpen}>
      <summary className="card-body py-3 cursor-pointer select-none flex items-center gap-2">
        <Icon className="w-4 h-4 opacity-70" />
        <span className="font-semibold">{title}</span>
        {hint && <span className="text-xs opacity-70">• {hint}</span>}
      </summary>
      <div className="px-4 pb-4">
        <div className="grid gap-3">{children}</div>
      </div>
    </details>
  );
}

/* --------------------------- defaults (system) ----------------------------- */
const DEFAULTS = {
  darkMode: false, compactMode: true, use24hClock: false, reduceMotion: false, highContrast: false, showTooltips: true,
  timezone: "America/Chicago", measurementUnit: "imperial", homeName: "", householdName: "",
  areas: AREA_OPTIONS.map(a => a.id), members: [],
  dietary: { torahCompliant: false, cuisineBias: ["american","african_american","mediterranean"], favoriteDishes: [] },
  sabbath: { aware: true, fridayCutoffSource: "calendar.sunset", fixedFridayCutoff: "17:00", finishMinutesBeforeSunset: 30 },
  meals: { breakfastTime:"08:00", lunchTime:"12:30", dinnerTime:"18:30", prepLeadMinutes:30 },
  budgetWeeklyUSD: 125, weeklyHrsCapacity: 10, lowStockDefault: 1,
  scheduling: { defaultTaskMinutes:25, cleaningRotationDays:3, maxParallelTasks:2, errandsBatchWindowDays:7, weekStartsOn:1 },
  autos: { mealPlanWeekly:true, gardenCalendar:true, cleaningRotation:true, sabbathMealPrep:true },
  notifications: { emailEnabled:false, smsEnabled:false, smsNumber:"" }
};

/* =============================== Page ===================================== */
export default function ProfileSettingsPage() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savedAt, setSavedAt] = useState(null);
  const lastSnapshot = useRef(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const p = (await Profile.getProfile()) || {};
        if (!mounted) return;
        setProfile(p);
        lastSnapshot.current = JSON.stringify(p);
      } finally { mounted && setLoading(false); }
    })();
    const unsub = Profile.subscribe?.((p) => {
      setProfile(p || {}); setSavedAt(Date.now());
    });
    return () => { mounted = false; unsub && unsub(); };
  }, []);

  /* Hide shell breadcrumbs/back/title while this page is mounted */
  useEffect(() => {
    document.body.dataset.hideShellChrome = "1";
    return () => { delete document.body.dataset.hideShellChrome; };
  }, []);

  const [settings, setSettings] = useState(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const fileInputRef = useRef(null);

  const mergeSettings = (saved = {}) => ({
    ...DEFAULTS, ...saved,
    dietary: { ...DEFAULTS.dietary, ...(saved.dietary || {}) },
    sabbath: { ...DEFAULTS.sabbath, ...(saved.sabbath || {}) },
    meals: { ...DEFAULTS.meals, ...(saved.meals || {}) },
    scheduling: { ...DEFAULTS.scheduling, ...(saved.scheduling || {}) },
    autos: { ...DEFAULTS.autos, ...(saved.autos || {}) },
    notifications: { ...DEFAULTS.notifications, ...(saved.notifications || {}) },
    members: Array.isArray(saved.members) ? saved.members : DEFAULTS.members,
    areas: Array.isArray(saved.areas) ? saved.areas : DEFAULTS.areas,
  });

  useEffect(() => {
    try {
      const raw = localStorage.getItem("householdSettings");
      if (raw) setSettings(mergeSettings(JSON.parse(raw)));
      else setSettings(s => ({ ...s, timezone: detectTimezone() || s.timezone }));
    } catch { setSettings(DEFAULTS); }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", !!settings.darkMode);
    root.dataset.theme = settings.darkMode ? "dark" : "light";
    root.style.setProperty("--density", settings.compactMode ? "8px" : "12px");
  }, [settings.darkMode, settings.compactMode]);

  const meals = settings.meals || DEFAULTS.meals;
  const sab = settings.sabbath || DEFAULTS.sabbath;
  const sched = settings.scheduling || DEFAULTS.scheduling;
  const notif = settings.notifications || DEFAULTS.notifications;

  const handleSave = async () => {
    if (![meals.breakfastTime, meals.lunchTime, meals.dinnerTime].every(isTimeLike)) { alert("Use HH:MM for meal times."); return; }
    if (sab.fridayCutoffSource === "fixed" && !isTimeLike(sab.fixedFridayCutoff)) { alert("Set HH:MM for Friday cutoff."); return; }
    setBusy(true);
    try {
      localStorage.setItem("householdSettings", JSON.stringify(settings));
      automation?.emit?.("settings/saved", settings);
      automation?.emit?.("automation/toggles_updated", settings.autos);
      setOk(true); setTimeout(()=>setOk(false), 900);
    } finally { setBusy(false); }
  };

  const handleExport = () => {
    const dump = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      dump[k] = localStorage.getItem(k);
    }
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `suka-settings-export-${new Date().toISOString().slice(0,10)}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const handleImportClick = () => fileInputRef.current?.click();
  const handleImport = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      Object.entries(data).forEach(([k, v]) => localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)));
      const raw = localStorage.getItem("householdSettings");
      setSettings(raw ? mergeSettings(JSON.parse(raw)) : DEFAULTS);
      alert("✅ Import complete.");
    } catch { alert("⚠️ Import failed."); } finally { e.target.value = ""; }
  };
  const handleReset = () => {
    if (!window.confirm("Clear ALL app data in this browser?")) return;
    localStorage.clear(); setSettings(DEFAULTS); alert("🧹 Data cleared.");
  };

  const setMeals  = (patch) => setSettings(s => ({ ...s, meals: { ...(s.meals||DEFAULTS.meals), ...patch } }));
  const setSab    = (patch) => setSettings(s => ({ ...s, sabbath: { ...(s.sabbath||DEFAULTS.sabbath), ...patch } }));
  const setSched  = (patch) => setSettings(s => ({ ...s, scheduling: { ...(s.scheduling||DEFAULTS.scheduling), ...patch } }));
  const setNotif  = (patch) => setSettings(s => ({ ...s, notifications: { ...(s.notifications||DEFAULTS.notifications), ...patch } }));
  const setDietary = (patch) => setSettings(s => ({ ...s, dietary: { ...(s.dietary || DEFAULTS.dietary), ...patch } }));

  const toggleArea = (id) => {
    setSettings(s => {
      const cur = Array.isArray(s.areas) ? s.areas : [];
      const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
      automation?.emit?.("home/areas_updated", next);
      return { ...s, areas: next };
    });
  };
  const addMember = () => setSettings(s => ({ ...s, members: [...(s.members||[]), { id: uid(), name: "", age: "", rooms: [] }] }));
  const updateMember = (id, patch) => setSettings(s => ({ ...s, members: (s.members||[]).map(m => m.id === id ? { ...m, ...patch } : m) }));
  const removeMember = (id) => setSettings(s => ({ ...s, members: (s.members||[]).filter(m => m.id !== id) }));
  const addRoomToMember = (id, type) => setSettings(s => ({ ...s, members: (s.members||[]).map(m => m.id === id ? { ...m, rooms: [...(m.rooms||[]), { type, name: "" }] } : m) }));
  const updateRoom = (mid, idx, patch) => setSettings(s => ({ ...s, members: (s.members||[]).map(m => (m.id !== mid ? m : { ...m, rooms: Object.assign([...(m.rooms||[])], { [idx]: { ...(m.rooms?.[idx]||{}), ...patch } }) })) }));
  const removeRoom = (mid, idx) => setSettings(s => ({ ...s, members: (s.members||[]).map(m => (m.id !== mid ? m : { ...m, rooms: (m.rooms||[]).filter((_, i) => i !== idx) })) }));

  if (loading) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="animate-pulse h-8 w-72 bg-base-200 rounded-2xl mb-4" />
        <div className="animate-pulse h-24 bg-base-200 rounded-2xl mb-3" />
        <div className="animate-pulse h-24 bg-base-200 rounded-2xl mb-3" />
        <div className="animate-pulse h-24 bg-base-200 rounded-2xl" />
      </div>
    );
  }

  return (
    <div id="settings-root" className="p-4 md:p-6 w-full max-w-6xl mx-auto space-y-4">
      {/* global style gated by body[data-hide-shell-chrome] so only this page is affected */}
      <style>{`
        body[data-hide-shell-chrome="1"] .breadcrumbs,
        body[data-hide-shell-chrome="1"] nav[aria-label="Breadcrumb"],
        body[data-hide-shell-chrome="1"] .page-breadcrumbs,
        body[data-hide-shell-chrome="1"] .route-tabs,
        body[data-hide-shell-chrome="1"] .settings-tabbar,
        body[data-hide-shell-chrome="1"] .btn-back,
        body[data-hide-shell-chrome="1"] a[aria-label="Back"],
        body[data-hide-shell-chrome="1"] button[aria-label="Back"],
        body[data-hide-shell-chrome="1"] .page-title,
        body[data-hide-shell-chrome="1"] header .title,
        body[data-hide-shell-chrome="1"] h1,
        body[data-hide-shell-chrome="1"] h2 { display: none !important; }
        #settings-root h1,
        #settings-root h2 { display: initial !important; }
      `}</style>

      {/* Header moved to the very top */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2">
        <h1 className="text-2xl md:text-3xl font-bold">Settings</h1>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-ghost btn-sm rounded-2xl"
            onClick={() => {
              try {
                const blob = new Blob([JSON.stringify(profile || {}, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a"); a.href = url; a.download = "household-profile.json"; a.click(); URL.revokeObjectURL(url);
              } catch {}
            }}
          >
            <SafeIcon className="mr-1">⬇</SafeIcon> Export Profile
          </button>
          <label className="btn btn-ghost btn-sm rounded-2xl cursor-pointer">
            <input
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={async (e) => {
                const f = e.target.files?.[0]; if (!f) return;
                try {
                  const text = await f.text(); const json = JSON.parse(text);
                  for (const [k, v] of Object.entries(json || {})) Profile.setAtPath(k, v);
                } catch {}
              }}
            />
            <SafeIcon className="mr-1">⬆</SafeIcon> Import Profile
          </label>
        </div>
      </div>

      {/* Saved toast (now below the header) */}
      <div className={cls("transition-all duration-200", ok ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2")}>
        {ok && (
          <div className="rounded-2xl border border-success/20 bg-success/10 px-3 py-2 inline-flex items-center gap-2">
            <span className="badge badge-success rounded-full">Saved</span>
            <span className="text-sm">Settings updated</span>
          </div>
        )}
      </div>

      {/* Essentials */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        {/* Profile basics */}
        <div className="card" style={{ padding: 10 }}>
          <h3 className="text-sm font-semibold flex items-center gap-2"><Icons.User className="w-4 h-4" /> Profile Basics</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <FieldInput label="Home Name" value={settings.homeName} onChange={(v)=>setSettings(s=>({...s, homeName:v}))} />
            <FieldInput label="Household Name" value={settings.householdName} onChange={(v)=>setSettings(s=>({...s, householdName:v}))} />
            <FieldSelect label="Time Zone" value={settings.timezone} onChange={(v)=>setSettings(s=>({...s, timezone:v}))} options={[
              { value: detectTimezone(), label: `Auto: ${detectTimezone()}` },
              { value:"America/New_York", label:"US Eastern" },
              { value:"America/Chicago", label:"US Central" },
              { value:"America/Denver", label:"US Mountain" },
              { value:"America/Los_Angeles", label:"US Pacific" },
              { value:"UTC", label:"UTC" },
            ]} />
            <FieldSelect label="Units" value={settings.measurementUnit} onChange={(v)=>setSettings(s=>({...s, measurementUnit:v}))}
              options={[{ value:"imperial", label:"US (cups, lbs)" },{ value:"metric", label:"Metric (L, g)" }]} />
          </div>
          <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            <SwitchTiny label="Dark Mode" checked={!!settings.darkMode} onChange={(v)=>setSettings(s=>({...s, darkMode:v}))} />
            <SwitchTiny label="Compact Mode" checked={!!settings.compactMode} onChange={(v)=>setSettings(s=>({...s, compactMode:v}))} />
            <SwitchTiny label="24-Hour Clock" checked={!!settings.use24hClock} onChange={(v)=>setSettings(s=>({...s, use24hClock:v}))} />
          </div>
        </div>

        {/* Notifications */}
        <div className="card" style={{ padding: 10 }}>
          <h3 className="text-sm font-semibold flex items-center gap-2"><Icons.Bell className="w-4 h-4" /> Notifications</h3>
          <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <SwitchTiny label="Desktop alerts" checked={true} onChange={()=>{}} />
            <SwitchTiny label="Email summaries" checked={!!notif.emailEnabled} onChange={(v)=>setNotif({ emailEnabled: v })} />
            <SwitchTiny label="Text messages" checked={!!notif.smsEnabled} onChange={(v)=>setNotif({ smsEnabled: v })} />
            {notif.smsEnabled && (
              <FieldInput label="Phone Number" value={notif.smsNumber} onChange={(v)=>setNotif({ smsNumber: v })} placeholder="+1 555 555 5555" width={180} />
            )}
          </div>
          <div className="mt-2" style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <button className="btn sm" onClick={()=>automation?.emit?.("notifications/test",{at:Date.now()})}>Send Test</button>
            {notif.smsEnabled && (
              <button className="btn sm" onClick={()=>automation?.emit?.("notifications/test_sms",{to:notif.smsNumber, at:Date.now()})}>Send Test SMS</button>
            )}
          </div>
        </div>

        {/* Automations */}
        <div className="card" style={{ padding: 10 }}>
          <h3 className="text-sm font-semibold flex items-center gap-2"><Icons.Timer className="w-4 h-4" /> Automations</h3>
          <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            {[
              ["mealPlanWeekly","Weekly Meal Plan","Generate a week of meals & groceries."],
              ["gardenCalendar","Garden Calendar","Seed/plant/harvest reminders."],
              ["cleaningRotation","Cleaning Rotation","Light 15–30m rotations."],
              ["sabbathMealPrep","Sabbath Meal Prep","Prep/reheats before Friday sunset."],
            ].map(([key, label, hint]) => (
              <SwitchTiny
                key={key}
                label={label}
                hint={hint}
                checked={!!(settings.autos?.[key])}
                onChange={(v)=>{ setSettings(s=>({ ...s, autos:{ ...(s.autos||DEFAULTS.autos), [key]:v } })); automation?.emit?.("automation/toggle",{key,enabled:v}); }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* COLLAPSIBLES */}
      <Collapsible title="Reminder & Meal Times" icon={Icons.Calendar} defaultOpen={false}>
        <div className="flex flex-wrap gap-2">
          <FieldInput label="Breakfast" value={meals.breakfastTime} onChange={(v)=>setMeals({ breakfastTime:v })} width={120} />
          <FieldInput label="Lunch" value={meals.lunchTime} onChange={(v)=>setMeals({ lunchTime:v })} width={120} />
          <FieldInput label="Dinner" value={meals.dinnerTime} onChange={(v)=>setMeals({ dinnerTime:v })} width={120} />
          <FieldInput label="Prep Lead (min)" type="number" value={meals.prepLeadMinutes} onChange={(v)=>setMeals({ prepLeadMinutes: clampNumber(v,0,240) })} width={140} />
        </div>
        <div className="mt-1">
          <SwitchTiny label="Sabbath Aware" checked={!!sab.aware} onChange={(v)=>setSab({ aware:v })} />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {sab.fridayCutoffSource === "fixed" ? (
            <FieldInput label="Fixed (HH:MM)" value={sab.fixedFridayCutoff} onChange={(v)=>setSab({ fixedFridayCutoff:v })} width={120} />
          ) : (
            <FieldInput label="Finish before (min)" type="number" value={sab.finishMinutesBeforeSunset} onChange={(v)=>setSab({ finishMinutesBeforeSunset: clampNumber(v,0,180) })} width={160} />
          )}
          <FieldSelect
            label="Sunset/Fixed Time"
            value={sab.fridayCutoffSource}
            onChange={(v)=>setSab({ fridayCutoffSource:v })}
            options={[{ value:"calendar.sunset", label:"Calendar Sunset (auto)" }, { value:"fixed", label:"Fixed Time" }]}
            width={180}
          />
        </div>
      </Collapsible>

      <Collapsible title="Budget & Scheduling" icon={Icons.Donut}>
        <div className="flex flex-wrap gap-2">
          <FieldInput label="Budget / wk ($)" type="number" value={settings.budgetWeeklyUSD} onChange={(v)=>setSettings(s=>({...s, budgetWeeklyUSD: clampNumber(v,0,1e6)}))} width={140} />
          <FieldInput label="Hours / wk" type="number" value={settings.weeklyHrsCapacity} onChange={(v)=>setSettings(s=>({...s, weeklyHrsCapacity: clampNumber(v,0,200)}))} width={120} />
          <FieldInput label="Low-Stock (qty)" type="number" value={settings.lowStockDefault} onChange={(v)=>setSettings(s=>({...s, lowStockDefault: clampNumber(v,0,999)}))} width={120} />
        </div>
        <div className="flex flex-wrap gap-2">
          <FieldInput label="Default Task (min)" type="number" value={sched.defaultTaskMinutes} onChange={(v)=>setSched({ defaultTaskMinutes: clampNumber(v,5,240) })} width={150} />
          <FieldInput label="Rotation (days)" type="number" value={sched.cleaningRotationDays} onChange={(v)=>setSched({ cleaningRotationDays: clampNumber(v,1,30) })} width={140} />
          <FieldInput label="Max Parallel" type="number" value={sched.maxParallelTasks} onChange={(v)=>setSched({ maxParallelTasks: clampNumber(v,1,10) })} width={130} />
          <FieldInput label="Errands Window (d)" type="number" value={sched.errandsBatchWindowDays} onChange={(v)=>setSched({ errandsBatchWindowDays: clampNumber(v,1,30) })} width={160} />
          <FieldSelect label="Week Starts On" value={sched.weekStartsOn} onChange={(v)=>setSched({ weekStartsOn: Number(v) })}
            options={[{value:1,label:"Mon"},{value:0,label:"Sun"}]} width={120} />
        </div>
      </Collapsible>

      <Collapsible title="Managed Areas" icon={Icons.Home}>
        <div className="flex flex-wrap gap-2">
          {AREA_OPTIONS.map(a => {
            const ActiveIcon = Icons?.[a.iconKey] || Icons.Sparkles;
            const active = (settings.areas || []).includes(a.id);
            return (
              <button key={a.id} className={`btn sm ${active ? "primary" : ""}`} onClick={()=>toggleArea(a.id)} aria-pressed={active} title={a.label}>
                <ActiveIcon className="w-4 h-4" /><span className="label">{a.label}</span>
              </button>
            );
          })}
        </div>
      </Collapsible>

      <Collapsible title="Dietary Preferences" icon={Icons.Salad}>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <SwitchTiny
            label="Torah Dietary Compliant"
            checked={!!(settings.dietary?.torahCompliant)}
            onChange={(v)=>setDietary({ torahCompliant: v })}
          />
          <DropdownMulti
            label="Preferred Cuisines"
            value={settings.dietary?.cuisineBias || []}
            onChange={(list)=>setDietary({ cuisineBias: list })}
            groups={CUISINES_GROUPED}
            placeholder="Choose cuisines"
          />
          <DishesInput
            label="Favorite Dishes"
            value={settings.dietary?.favoriteDishes || []}
            onChange={(list)=>setDietary({ favoriteDishes: list })}
            cuisines={CUISINES_GROUPED.flatMap(g => g.items)}
          />
        </div>
      </Collapsible>

      <Collapsible title="Feast & Interpretation (advanced)" icon={Icons.BookOpen}>
        <SettingToggle path="torahFood.shellfishAllowed" label="Shellfish Allowed" hint="If your household interpretation includes shellfish with fins and scales." />
        <SettingToggle path="sabbath.guardActions" label="Sabbath Guard Enabled" hint="Pauses active work during Sabbath and Appointed Times; converts steps to hands-off holds." />
        <SettingToggle path="cleanliness.ritualBathRequired" label="Ritual Cleansing Required" hint="Require cleansing before resuming specific food/community tasks." />
        <SettingMultiCheck path="calendar.observedFeasts" label="Observed Feasts" hint="Select which days your household observes."
          options={["Passover","Unleavened Bread","First Fruits","Shavuot","Trumpets","Atonement","Tabernacles/Sukkot"]} allowCustom />
        <SettingToggle path="calendar.fullMoonMonthStart" label="Full Moon as Month Start" hint="Begin months at the full moon." />
      </Collapsible>

      <Collapsible title="Household Members & Rooms" icon={Icons.Users}>
        <div className="space-y-3">
          {(settings.members || []).length === 0 && <div className="subtitle">No members yet.</div>}
          {(settings.members || []).map((m) => (
            <div key={m.id} className="rounded-xl border p-3 bg-white/60">
              <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 320px))" }}>
                <FieldInput label="Name" value={m.name} onChange={(v)=>updateMember(m.id,{name:v})} placeholder="e.g., Alex" />
                <FieldInput label="Age" type="number" value={m.age ?? ""} onChange={(v)=>updateMember(m.id,{age: v ? Number(v) : ""})} placeholder="e.g., 12" />
              </div>
              <div className="mt-2">
                <div className="text-sm font-medium mb-1">Rooms</div>
                {(m.rooms || []).map((r, idx) => (
                  <div key={idx} className="flex items-center gap-2 mb-1">
                    <select className="btn" value={r.type} onChange={(e)=>updateRoom(m.id, idx, { type: e.target.value })} style={{ width: 140 }}>
                      <option value="bedroom">Bedroom</option><option value="bathroom">Bathroom</option>
                    </select>
                    <input className="btn" value={r.name} onChange={(e)=>updateRoom(m.id, idx, { name: e.target.value })} placeholder="Label (e.g., Bedroom A)" style={{ flex:1, paddingBlock:6 }} />
                    <button className="btn sm" onClick={()=>removeRoom(m.id, idx)}>Remove</button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <button className="btn sm" onClick={()=>addRoomToMember(m.id,"bedroom")}>+ Bedroom</button>
                  <button className="btn sm" onClick={()=>addRoomToMember(m.id,"bathroom")}>+ Bathroom</button>
                  <div style={{ flex:1 }} />
                  <button className="btn sm" onClick={()=>removeMember(m.id)}>Remove Member</button>
                </div>
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <button className="btn sm" onClick={() => addMember()}>+ Add Member</button>
            <button className="btn sm" onClick={() =>
              setSettings(s => ({
                ...s, members: [
                  ...(s.members||[]),
                  { id: uid(), name: "Parent A", age: 35, rooms: [{ type:"bedroom", name:"Primary" }] },
                  { id: uid(), name: "Parent B", age: 35, rooms: [] },
                  { id: uid(), name: "Child",   age: 8,  rooms: [{ type:"bedroom", name:"Child Room" }] },
                ]
              }))
            }>Add Family Preset</button>
          </div>
        </div>
      </Collapsible>

      <Collapsible title="Data (export/import/reset)" icon={Icons.Database}>
        <div className="flex gap-2 flex-wrap items-center">
          <button className="btn sm" onClick={handleExport}>Export</button>
          <button className="btn sm" onClick={handleImportClick}>Import</button>
          <button className="btn sm" onClick={handleReset}>Reset</button>
          <input ref={fileInputRef} type="file" accept="application/json" onChange={handleImport} style={{ display:"none" }} />
        </div>
      </Collapsible>

      {/* Save bar */}
      <div className="flex items-center justify-end gap-3">
        <button onClick={()=>{
          try { Jobs.emit?.("jobs.undo.perform", { token: { source: "profile.settings" } }); } catch {}
        }} className="btn sm">Undo Last</button>
        <button onClick={handleSave} className="btn primary sm" aria-busy={busy}>
          <Icons.Save className="w-4 h-4" /><span className="label">Save All</span>
        </button>
      </div>
    </div>
  );
}
