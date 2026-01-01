// src/features/foodtruck/FoodTruckWrapper.jsx
// Suka Smart Assistant — Food Truck Wrapper + Logo + Large Menu Board
// + Typography controls (user‑selectable fonts)
// - Tailwind + shadcn/ui style API (no hard dependency required)
// - Pure React (.jsx) ready to paste
// - Persisted to localStorage
// - Editor + Live Preview + Fullscreen Menu Board
// - Print-friendly menu board (Ctrl+P)
// - Designed to integrate later with foodTruckAgent.js events

import React, { useEffect, useState } from "react";
import { Plus, Trash2, Image as ImageIcon, Upload, Maximize2, Minimize2, Settings, PanelLeftClose, PanelLeftOpen } from "lucide-react";

// -------------- Utilities
const uid = () => Math.random().toString(36).slice(2, 9);
const readFileAsDataURL = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(file);
});

const STORAGE_KEY = "suka.foodtruck.wrapper.v2"; // bump to v2 for new font settings

const DEFAULT_THEME = {
  primary: "#1d4ed8", // blue-700
  accent: "#D4AF37", // gold
  bg: "#f5f3ff",     // violet-50 (light purple)
  text: "#b91c1c",   // scarlet (red-700)
};

const DEFAULT_FONTS = {
  base: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  headings: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  linkHelp: "Optional: load Google Fonts in your app's <head> for custom faces.",
  lockHeadingsToBase: true,
};

const DEFAULT_MENU = {
  truckName: "Curry Döner Express",
  tagline: "Bold • Fast • Torah‑aware",
  logoDataUrl: "",
  theme: DEFAULT_THEME,
  fonts: DEFAULT_FONTS,
  showPrices: true,
  currency: "$",
  sections: [
    {
      id: uid(),
      title: "Wraps",
      note: "Hand‑held, craveable, ready fast",
      items: [
        {
          id: uid(),
          name: "Curry‑Döner Wrap",
          desc: "marinated lamb, spiced kraut, raita‑garlic herb",
          price: 8,
          badge: "signature",
        },
        {
          id: uid(),
          name: "Chicken Masala Wrap",
          desc: "yogurt‑garam, mint‑dill sauce",
          price: 7,
        },
      ],
    },
    {
      id: uid(),
      title: "Sides & Sips",
      note: "pair it right",
      items: [
        { id: uid(), name: "Crisp Masala Fries", desc: "tempered spice finish", price: 4 },
        { id: uid(), name: "Mango Lassi Cup", desc: "cultured, bright", price: 5, badge: "popular" },
      ],
    },
  ],
  footerNotes: [
    "Allergens listed at window • Ask about dairy‑free options",
    "Hot‑hold ≥135°F • Cold‑hold ≤41°F",
  ],
};

// ---------- Pure helpers (also used in self‑tests)
export function reorder(arr, fromIndex, toIndex) {
  const a = [...arr];
  const from = Math.max(0, Math.min(a.length - 1, fromIndex));
  const to = Math.max(0, Math.min(a.length - 1, toIndex));
  const [m] = a.splice(from, 1);
  a.splice(to, 0, m);
  return a;
}

export function formatPrice(currency, n) {
  const num = Number.isFinite(+n) ? +n : 0;
  return `${currency}${num.toFixed(2)}`;
}

export function validateMenu(menu) {
  const errors = [];
  if (!menu) errors.push("menu: required");
  if (!menu.truckName) errors.push("menu.truckName: required");
  if (!Array.isArray(menu.sections)) errors.push("menu.sections: array required");
  (menu.sections || []).forEach((s, si) => {
    if (!s.title) errors.push(`sections[${si}].title: required`);
    if (!Array.isArray(s.items)) errors.push(`sections[${si}].items: array required`);
    (s.items || []).forEach((it, ii) => {
      if (!it.name) errors.push(`sections[${si}].items[${ii}].name: required`);
    });
  });
  // Fonts
  if (!menu.fonts || !menu.fonts.base) errors.push("menu.fonts.base: required");
  return errors;
}

// ---------------- UI bits (single declarations)
function ColorInput({ label, value, onChange }) {
  return (
    <div className="grid grid-cols-3 items-center gap-2">
      <span className="text-sm col-span-2">{label}</span>
      <input type="color" className="h-9 w-full rounded" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function FontSelect({ label, value, options, onChange, disabled }) {
  return (
    <div className="grid grid-cols-3 items-center gap-2">
      <label className="text-sm col-span-1">{label}</label>
      <select
        className="col-span-2 rounded-lg border px-2 py-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ fontFamily: value }}
      >
        {options.map((o) => (
          <option key={o} value={o} style={{ fontFamily: o }}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

// -------------- Core Component
export default function FoodTruckWrapper({ initialMenu }) {
  const [data, setData] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return (
        cached ||
        initialMenu ||
        // migrate old storage key if present
        (() => {
          try {
            const old = JSON.parse(localStorage.getItem("suka.foodtruck.wrapper.v1"));
            if (old && !old.fonts) return { ...old, fonts: DEFAULT_FONTS };
            return old || DEFAULT_MENU;
          } catch {
            return DEFAULT_MENU;
          }
        })()
      );
    } catch {
      return initialMenu || DEFAULT_MENU;
    }
  });
  const [showEditor, setShowEditor] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  // ---- Mutators
  const updateTheme = (key, val) => setData((d) => ({ ...d, theme: { ...d.theme, [key]: val } }));
  const setLogo = (logoDataUrl) => setData((d) => ({ ...d, logoDataUrl }));
  const setTruckName = (truckName) => setData((d) => ({ ...d, truckName }));
  const setTagline = (tagline) => setData((d) => ({ ...d, tagline }));

  // Typography
  const FONT_CHOICES = [
    "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    "Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif",
    "Roboto, Helvetica, Arial, sans-serif",
    "Montserrat, Roboto, Helvetica, Arial, sans-serif",
    "Lato, Roboto, Helvetica, Arial, sans-serif",
    "Playfair Display, Georgia, Times New Roman, serif",
    "Georgia, Times New Roman, serif",
    "Times New Roman, Times, serif",
    "Fira Sans, Inter, system-ui, sans-serif",
    "Courier New, Courier, monospace",
  ];
  const setBaseFont = (stack) =>
    setData((d) => {
      const fonts = { ...(d.fonts || DEFAULT_FONTS), base: stack };
      if (fonts.lockHeadingsToBase) fonts.headings = stack;
      return { ...d, fonts };
    });
  const setHeadingFont = (stack) => setData((d) => ({ ...d, fonts: { ...(d.fonts || DEFAULT_FONTS), headings: stack } }));
  const toggleLockHeadings = () =>
    setData((d) => {
      const lock = !(d.fonts?.lockHeadingsToBase ?? true);
      const fonts = { ...(d.fonts || DEFAULT_FONTS), lockHeadingsToBase: lock };
      if (lock) fonts.headings = fonts.base;
      return { ...d, fonts };
    });

  const addSection = () =>
    setData((d) => ({ ...d, sections: [...d.sections, { id: uid(), title: "New Section", note: "", items: [] }] }));
  const removeSection = (sid) => setData((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== sid) }));
  const updateSection = (sid, patch) => setData((d) => ({ ...d, sections: d.sections.map((s) => (s.id === sid ? { ...s, ...patch } : s)) }));
  const moveSection = (sid, dir) =>
    setData((d) => {
      const i = d.sections.findIndex((s) => s.id === sid);
      if (i < 0) return d;
      const j = Math.max(0, Math.min(d.sections.length - 1, i + (dir === "up" ? -1 : 1)));
      return { ...d, sections: reorder(d.sections, i, j) };
    });

  const addItem = (sid) =>
    setData((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.id === sid ? { ...s, items: [...s.items, { id: uid(), name: "New Item", desc: "", price: 0 }] } : s)),
    }));
  const removeItem = (sid, iid) =>
    setData((d) => ({ ...d, sections: d.sections.map((s) => (s.id === sid ? { ...s, items: s.items.filter((i) => i.id !== iid) } : s)) }));
  const updateItem = (sid, iid, patch) =>
    setData((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.id === sid ? { ...s, items: s.items.map((i) => (i.id === iid ? { ...i, ...patch } : i)) } : s)),
    }));
  const moveItem = (sid, iid, dir) =>
    setData((d) => {
      const secIndex = d.sections.findIndex((s) => s.id === sid);
      if (secIndex < 0) return d;
      const sec = d.sections[secIndex];
      const i = sec.items.findIndex((i) => i.id === iid);
      if (i < 0) return d;
      const j = Math.max(0, Math.min(sec.items.length - 1, i + (dir === "up" ? -1 : 1)));
      const newItems = reorder(sec.items, i, j);
      const newSections = [...d.sections];
      newSections[secIndex] = { ...sec, items: newItems };
      return { ...d, sections: newSections };
    });

  const togglePrices = () => setData((d) => ({ ...d, showPrices: !d.showPrices }));
  const setCurrency = (currency) => setData((d) => ({ ...d, currency }));
  const addFooterNote = () => setData((d) => ({ ...d, footerNotes: [...(d.footerNotes || []), "New note"] }));
  const removeFooterNote = (idx) => setData((d) => ({ ...d, footerNotes: d.footerNotes.filter((_, i) => i !== idx) }));
  const updateFooterNote = (idx, text) => setData((d) => ({ ...d, footerNotes: d.footerNotes.map((t, i) => (i === idx ? text : t)) }));

  const baseFont = data.fonts?.base || DEFAULT_FONTS.base;
  const headingFont = data.fonts?.headings || baseFont;

  // -------------- UI (render)
  return (
    <div
      className="w-full grid grid-cols-12 gap-4 p-4"
      style={{ background: data.theme.bg, color: data.theme.text, fontFamily: baseFont }}
    >
      {/* Left Editor Panel */}
      <aside className={`col-span-12 lg:col-span-4 ${showEditor ? "" : "hidden lg:block"}`}>
        <div className="rounded-2xl shadow p-4 bg-white/80 border border-black/5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-semibold">Truck Wrapper Settings</h2>
            <button className="btn btn-ghost" onClick={() => setShowEditor((v) => !v)}>
              {showEditor ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
              <span className="ml-2 hidden sm:inline">{showEditor ? "Hide" : "Show"}</span>
            </button>
          </div>

          {/* Logo uploader */}
          <div className="mb-4">
            <label className="text-sm font-medium">Logo</label>
            <div className="mt-2 flex items-center gap-3">
              {data.logoDataUrl ? (
                <img src={data.logoDataUrl} alt="logo" className="h-14 w-14 rounded-xl object-contain border" />
              ) : (
                <div className="h-14 w-14 rounded-xl border grid place-items-center text-gray-400">
                  <ImageIcon />
                </div>
              )}
              <label className="inline-flex items-center px-3 py-2 rounded-xl border cursor-pointer bg-white hover:bg-gray-50">
                <Upload size={16} className="mr-2" />Upload
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const url = await readFileAsDataURL(f);
                    setLogo(url);
                  }}
                />
              </label>
              {data.logoDataUrl && (
                <button className="px-3 py-2 rounded-xl border hover:bg-gray-50" onClick={() => setLogo("")}>
                  Remove
                </button>
              )}
            </div>
          </div>

          {/* Title / Tagline */}
          <div className="grid grid-cols-1 gap-3 mb-4">
            <div>
              <label className="text-sm font-medium">Truck Name</label>
              <input
                className="mt-1 w-full rounded-xl border px-3 py-2"
                value={data.truckName}
                onChange={(e) => setTruckName(e.target.value)}
                placeholder="Your food truck name"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Tagline</label>
              <input
                className="mt-1 w-full rounded-xl border px-3 py-2"
                value={data.tagline}
                onChange={(e) => setTagline(e.target.value)}
                placeholder="e.g., Bold • Fast • Torah‑aware"
              />
            </div>
          </div>

          {/* Theme */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Settings size={16} />
              <span className="font-medium">Theme</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <ColorInput label="Primary" value={data.theme.primary} onChange={(v) => updateTheme("primary", v)} />
              <ColorInput label="Accent" value={data.theme.accent} onChange={(v) => updateTheme("accent", v)} />
              <ColorInput label="Background" value={data.theme.bg} onChange={(v) => updateTheme("bg", v)} />
              <ColorInput label="Text" value={data.theme.text} onChange={(v) => updateTheme("text", v)} />
            </div>
          </div>

          {/* Typography */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Settings size={16} />
              <span className="font-medium">Typography</span>
            </div>
            <div className="space-y-3">
              <FontSelect label="Base font" value={data.fonts?.base || DEFAULT_FONTS.base} options={FONT_CHOICES} onChange={setBaseFont} />
              <div className="flex items-center gap-2">
                <input id="lockHeadings" type="checkbox" className="h-4 w-4" checked={data.fonts?.lockHeadingsToBase ?? true} onChange={toggleLockHeadings} />
                <label htmlFor="lockHeadings" className="text-sm">Headings use base font</label>
              </div>
              <FontSelect label="Heading font" value={data.fonts?.headings || data.fonts?.base || DEFAULT_FONTS.base} options={FONT_CHOICES} onChange={setHeadingFont} disabled={data.fonts?.lockHeadingsToBase} />
              <p className="text-xs text-gray-600">{DEFAULT_FONTS.linkHelp}</p>
            </div>
          </div>

          {/* Menu settings */}
          <div className="mb-4 grid grid-cols-2 gap-3 items-end">
            <div>
              <label className="text-sm font-medium">Currency</label>
              <input className="mt-1 w-full rounded-xl border px-3 py-2" value={data.currency} onChange={(e) => setCurrency(e.target.value || "$")} />
            </div>
            <div className="flex items-center gap-2">
              <input id="showPrices" type="checkbox" className="h-4 w-4" checked={data.showPrices} onChange={togglePrices} />
              <label htmlFor="showPrices" className="text-sm">
                Show Prices
              </label>
            </div>
          </div>

          {/* Sections */}
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Menu Sections</h3>
            <button className="inline-flex items-center px-3 py-2 rounded-xl border bg-white hover:bg-gray-50" onClick={addSection}>
              <Plus size={16} className="mr-1" />Add
            </button>
          </div>
          <div className="space-y-3">
            {data.sections.map((s) => (
              <div key={s.id} className="rounded-xl border p-3 bg-white/70">
                <div className="flex items-center gap-2">
                  <input className="flex-1 rounded-lg border px-2 py-1 font-medium" value={s.title} onChange={(e) => updateSection(s.id, { title: e.target.value })} />
                  <button title="Up" className="px-2 py-1 rounded-lg border" onClick={() => moveSection(s.id, "up")}>
                    ↑
                  </button>
                  <button title="Down" className="px-2 py-1 rounded-lg border" onClick={() => moveSection(s.id, "down")}>
                    ↓
                  </button>
                  <button title="Remove" className="p-2 rounded-lg border text-red-600" onClick={() => removeSection(s.id)}>
                    <Trash2 size={16} />
                  </button>
                </div>
                <input
                  className="mt-2 w-full rounded-lg border px-2 py-1 text-sm"
                  placeholder="Section note (optional)"
                  value={s.note || ""}
                  onChange={(e) => updateSection(s.id, { note: e.target.value })}
                />
                <div className="mt-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium">Items</span>
                    <button className="inline-flex items-center px-2 py-1 rounded-lg border" onClick={() => addItem(s.id)}>
                      <Plus size={14} className="mr-1" />Add Item
                    </button>
                  </div>
                  <div className="space-y-2">
                    {s.items.map((it) => (
                      <div key={it.id} className="grid grid-cols-12 gap-2 items-start">
                        <input className="col-span-4 rounded-lg border px-2 py-1" placeholder="Name" value={it.name} onChange={(e) => updateItem(s.id, it.id, { name: e.target.value })} />
                        <input className="col-span-6 rounded-lg border px-2 py-1" placeholder="Description" value={it.desc || ""} onChange={(e) => updateItem(s.id, it.id, { desc: e.target.value })} />
                        <div className="col-span-2 flex items-center gap-2">
                          <input
                            className="w-20 rounded-lg border px-2 py-1"
                            type="number"
                            min="0"
                            step="0.25"
                            placeholder="Price"
                            value={it.price ?? 0}
                            onChange={(e) => updateItem(s.id, it.id, { price: parseFloat(e.target.value || 0) })}
                          />
                          <input className="w-24 rounded-lg border px-2 py-1" placeholder="Badge" value={it.badge || ""} onChange={(e) => updateItem(s.id, it.id, { badge: e.target.value })} />
                          <button title="Up" className="px-2 py-1 rounded-lg border" onClick={() => moveItem(s.id, it.id, "up")}>
                            ↑
                          </button>
                          <button title="Down" className="px-2 py-1 rounded-lg border" onClick={() => moveItem(s.id, it.id, "down")}>
                            ↓
                          </button>
                          <button title="Remove" className="p-2 rounded-lg border text-red-600" onClick={() => removeItem(s.id, it.id)}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Footer notes */}
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium">Footer Notes</span>
              <button className="inline-flex items-center px-2 py-1 rounded-lg border" onClick={addFooterNote}>
                <Plus size={14} className="mr-1" />Add Note
              </button>
            </div>
            <div className="space-y-2">
              {(data.footerNotes || []).map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input className="flex-1 rounded-lg border px-2 py-1 text-sm" value={t} onChange={(e) => updateFooterNote(i, e.target.value)} />
                  <button className="p-2 rounded-lg border text-red-600" onClick={() => removeFooterNote(i)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* Right: Live Menu Board */}
      <main className={`col-span-12 ${showEditor ? "lg:col-span-8" : "lg:col-span-12"}`}>
        <div className="rounded-3xl border shadow overflow-hidden" style={{ background: data.theme.bg }}>
          <MenuBoard data={data} compact={compact} />
          <div className="flex items-center justify-between p-3 bg-white/70 border-t">
            <div className="flex items-center gap-2">
              <button className="px-3 py-2 rounded-xl border" onClick={() => setCompact((v) => !v)}>
                {compact ? "Spacious" : "Compact"} Layout
              </button>
              <button className="px-3 py-2 rounded-xl border" onClick={() => window.print()}>Print Menu</button>
            </div>
            <div className="flex items-center gap-2">
              <button className="px-3 py-2 rounded-xl border" onClick={() => setShowEditor((v) => !v)}>
                {showEditor ? "Hide Editor" : "Show Editor"}
              </button>
              <button className="px-3 py-2 rounded-xl border" onClick={() => setFullscreen((v) => !v)}>
                {fullscreen ? (
                  <span className="inline-flex items-center">
                    <Minimize2 size={16} className="mr-2" />Exit Fullscreen
                  </span>
                ) : (
                  <span className="inline-flex items-center">
                    <Maximize2 size={16} className="mr-2" />Fullscreen
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>
      </main>

      {/* Fullscreen overlay */}
      {fullscreen && (
        <div className="fixed inset-0 z-50" style={{ background: data.theme.bg }}>
          <div className="absolute inset-0 p-6">
            <div className="absolute top-4 right-4">
              <button className="px-4 py-2 rounded-xl border bg-white/80" onClick={() => setFullscreen(false)}>
                <Minimize2 size={16} className="inline mr-2" />Exit
              </button>
            </div>
            <MenuBoard data={data} compact={compact} fullscreen />
          </div>
        </div>
      )}
    </div>
  );
}

function MenuBoard({ data, compact = false, fullscreen = false }) {
  const accent = data.theme.accent;
  const primary = data.theme.primary;
  const baseFont = data.fonts?.base || DEFAULT_FONTS.base;
  const headingFont = data.fonts?.headings || baseFont;

  return (
    <div className={`w-full ${fullscreen ? "h-full" : ""} `}>
      {/* Header */}
      <div className="relative overflow-hidden">
        <div className="px-6 py-5 md:px-10 md:py-8 grid grid-cols-12 gap-4 items-center" style={{ background: primary, color: "white" }}>
          <div className="col-span-3 md:col-span-2 flex items-center gap-3">
            {data.logoDataUrl ? (
              <img src={data.logoDataUrl} alt="logo" className="h-16 w-16 md:h-20 md:w-20 rounded-2xl object-contain bg-white/10 p-2" />
            ) : (
              <div className="h-16 w-16 md:h-20 md:w-20 rounded-2xl grid place-items-center bg-white/10 text-white/70">
                <ImageIcon />
              </div>
            )}
          </div>
          <div className="col-span-9 md:col-span-10">
            <h1
              className={`font-black tracking-tight ${compact ? "text-2xl md:text-4xl" : "text-3xl md:text-5xl"}`}
              style={{ fontFamily: headingFont }}
            >
              {data.truckName}
            </h1>
            {data.tagline && (
              <p className={`opacity-90 ${compact ? "text-sm md:text-base" : "text-base md:text-lg"}`} style={{ fontFamily: baseFont }}>
                {data.tagline}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Sections */}
      <div className={`px-6 md:px-10 ${compact ? "py-4" : "py-8"}`} style={{ fontFamily: baseFont }}>
        <div className={`grid gap-6 ${compact ? "md:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3"}`}>
          {data.sections.map((sec) => (
            <section key={sec.id} className="rounded-2xl border bg-white/70 backdrop-blur p-4 shadow-sm">
              <div className="flex items-baseline justify-between mb-2">
                <h2 className={`${compact ? "text-xl" : "text-2xl"} font-extrabold`} style={{ color: primary, fontFamily: headingFont }}>
                  {sec.title}
                </h2>
                {sec.note && (
                  <span className="text-xs px-2 py-1 rounded-full" style={{ background: accent, color: "#111", fontFamily: baseFont }}>
                    {sec.note}
                  </span>
                )}
              </div>
              <ul className="space-y-2">
                {sec.items.map((it) => (
                  <li key={it.id} className="flex items-start justify-between gap-3">
                    <div>
                      <div className={`font-semibold ${compact ? "text-base" : "text-lg"}`} style={{ fontFamily: headingFont }}>
                        {it.name}
                        {it.badge && (
                          <span className="ml-2 text-xs uppercase tracking-wide px-2 py-0.5 rounded-full" style={{ background: accent, color: "#111", fontFamily: baseFont }}>
                            {it.badge}
                          </span>
                        )}
                      </div>
                      {it.desc && (
                        <p className={`text-sm opacity-80 ${compact ? "mt-0.5" : "mt-1"}`} style={{ fontFamily: baseFont }}>
                          {it.desc}
                        </p>
                      )}
                    </div>
                    {data.showPrices && (
                      <div className={`shrink-0 font-bold ${compact ? "text-base" : "text-lg"}`} style={{ fontFamily: headingFont }}>
                        {formatPrice(data.currency, it.price || 0)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 md:px-10 pb-6" style={{ fontFamily: baseFont }}>
        {data.footerNotes && data.footerNotes.length > 0 && (
          <div className="text-xs opacity-80 space-y-1">
            {data.footerNotes.map((t, i) => (
              <p key={i}>• {t}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------- Dev Self‑Tests (non‑breaking)
// Call __selfTest_FoodTruckWrapper() in a console/dev route to see results.
export function __selfTest_FoodTruckWrapper() {
  const results = [];
  // Test: reorder basic up/down
  results.push({ name: "reorder up", pass: JSON.stringify(reorder(["a", "b", "c"], 1, 0)) === JSON.stringify(["b", "a", "c"]) });
  results.push({ name: "reorder down", pass: JSON.stringify(reorder(["a", "b", "c"], 1, 2)) === JSON.stringify(["a", "c", "b"]) });
  // NEW: reorder clamps
  results.push({ name: "reorder clamps", pass: JSON.stringify(reorder(["a", "b", "c"], 10, -5)) === JSON.stringify(["c", "a", "b"]) });
  // Test: formatPrice
  results.push({ name: "format price $", pass: formatPrice("$", 8) === "$8.00" });
  results.push({ name: "format price edge", pass: formatPrice("$", "") === "$0.00" });
  // NEW: formatPrice non-numeric
  results.push({ name: "format price non-numeric", pass: formatPrice("$", "abc") === "$0.00" });
  // NEW: formatPrice euro
  results.push({ name: "format price €", pass: formatPrice("€", 3.5) === "€3.50" });
  // Test: validate default menu
  results.push({ name: "validate default menu", pass: validateMenu(DEFAULT_MENU).length === 0 });
  // Test: validate missing fields
  results.push({ name: "validate missing title", pass: validateMenu({ ...DEFAULT_MENU, truckName: "" }).includes("menu.truckName: required") });
  // NEW: validate sections must be array
  results.push({ name: "validate sections array", pass: validateMenu({ ...DEFAULT_MENU, sections: null }).includes("menu.sections: array required") });
  // Test: fonts propagate
  const tmp = { ...DEFAULT_MENU, fonts: { ...DEFAULT_FONTS, base: "Georgia, serif", headings: "Times New Roman, serif", lockHeadingsToBase: false } };
  const okFonts = !validateMenu(tmp).some((e) => e.startsWith("menu.fonts.base"));
  results.push({ name: "validate fonts present", pass: okFonts });
  // NEW: validate fonts missing
  const missingFonts = { ...DEFAULT_MENU, fonts: { base: "" } };
  results.push({ name: "validate fonts missing base", pass: validateMenu(missingFonts).includes("menu.fonts.base: required") });

  return results;
}
