// src/pages/FoodTruckPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Save,
  UploadCloud,
  DownloadCloud,
  ChefHat,
  BusFront,
  Megaphone,
  Palette,
  Type as TypeIcon,
  ForkKnife,
  Sandwich,
  Undo2,
  Rocket,
  Settings2,
} from "lucide-react";

// --- Optional event bus hooks (non-fatal if absent) ---
let eventBus = null;
try {
  // Prefer your shared event bus if present in your codebase
  // e.g., "@/services/events/eventBus" or "@/services/automation/runtime"
  // eslint-disable-next-line import/no-unresolved
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.eventBus || eb?.default || null;
} catch {
  eventBus = null;
}
const emit = (name, payload) => {
  if (eventBus?.emit) eventBus.emit(name, payload);
};

// --- Constants ---
const THEME_PALETTES = {
  blue: {
    "--ft-bg": "#0b1220",
    "--ft-accent": "#2563eb", // blue-600
    "--ft-accent-2": "#60a5fa",
    "--ft-gold": "#facc15",
    "--ft-scarlet": "#ef4444",
    "--ft-card": "#0f172a", // slate-900
    "--ft-ink": "#e5e7eb",
  },
  purple: {
    "--ft-bg": "#0d0718",
    "--ft-accent": "#7c3aed", // violet-600
    "--ft-accent-2": "#a78bfa",
    "--ft-gold": "#facc15",
    "--ft-scarlet": "#ef4444",
    "--ft-card": "#111827",
    "--ft-ink": "#e5e7eb",
  },
  scarlet: {
    "--ft-bg": "#1a0b0b",
    "--ft-accent": "#dc2626", // red-600
    "--ft-accent-2": "#f87171",
    "--ft-gold": "#facc15",
    "--ft-scarlet": "#ef4444",
    "--ft-card": "#111827",
    "--ft-ink": "#fde68a",
  },
  gold: {
    "--ft-bg": "#140f03",
    "--ft-accent": "#eab308", // yellow-500
    "--ft-accent-2": "#fcd34d",
    "--ft-gold": "#f59e0b",
    "--ft-scarlet": "#ef4444",
    "--ft-card": "#0f172a",
    "--ft-ink": "#fff7ed",
  },
};

const FONT_CHOICES = [
  { label: "System UI", value: "system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial, sans-serif" },
  { label: "Display — Impactish", value: "'Impact', Haettenschweiler, 'Arial Narrow Bold', sans-serif" },
  { label: "Grotesk — Inter-like", value: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, Noto Sans, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif" },
  { label: "Slab — Rockwellish", value: "Rockwell, 'Rockwell Nova', 'DejaVu Serif', 'Times New Roman', serif" },
  { label: "Monospace Menu", value: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
];

const DEFAULT_MENU = [
  {
    id: "cat-plates",
    name: "Plates",
    items: [
      { id: "itm-1", name: "Masala Doner Plate", price: 14, desc: "Indian curry + German lamb döner fusion over turmeric rice." },
      { id: "itm-2", name: "Tandoori Lamb Wrap", price: 12, desc: "Street-wrap with mint yogurt & pickled red cabbage." },
    ],
  },
  {
    id: "cat-sides",
    name: "Sides",
    items: [
      { id: "itm-3", name: "Curry Fries", price: 6, desc: "Crispy fries dusted with chaat masala." },
      { id: "itm-4", name: "Red Cabbage Slaw", price: 5, desc: "Tangy, herby crunch." },
    ],
  },
  {
    id: "cat-drinks",
    name: "Drinks",
    items: [
      { id: "itm-5", name: "Mango Lassi", price: 6, desc: "Sweet, creamy, cooling." },
      { id: "itm-6", name: "Sparkling Ayran", price: 4, desc: "Yogurt, salt, fizz." },
    ],
  },
];

const MODES = [
  { key: "food_truck", label: "Food Truck", icon: BusFront },
  { key: "street_food", label: "Street Food", icon: Sandwich },
  { key: "restaurant", label: "Restaurant", icon: ForkKnife },
];

const STORAGE_KEY = "suka.foodtruck.state.v1";

function uid(prefix = "id") {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

// --- Helpers for undo stack ---
function useUndoStack() {
  const [lastAction, setLastAction] = useState(null); // {type, payload, revert()}
  const scheduleUndo = (entry) => setLastAction(entry);
  const clearUndo = () => setLastAction(null);
  return { lastAction, scheduleUndo, clearUndo };
}

export default function FoodTruckPage() {
  // --- State ---
  const [paletteKey, setPaletteKey] = useState("blue");
  const [font, setFont] = useState(FONT_CHOICES[0].value);
  const [mode, setMode] = useState(MODES[0].key);
  const [menu, setMenu] = useState(DEFAULT_MENU);
  const [truckName, setTruckName] = useState("Suka Street Kitchen");
  const [logoText, setLogoText] = useState("SUKA");
  const [announcement, setAnnouncement] = useState("Now serving fusion plates! Ask about today's special.");
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState(null); // {title, desc, actionLabel, onAction}
  const { lastAction, scheduleUndo, clearUndo } = useUndoStack();

  const palette = THEME_PALETTES[paletteKey];

  // --- Persistence ---
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (s.paletteKey) setPaletteKey(s.paletteKey);
        if (s.font) setFont(s.font);
        if (s.mode) setMode(s.mode);
        if (s.menu) setMenu(s.menu);
        if (s.truckName) setTruckName(s.truckName);
        if (s.logoText) setLogoText(s.logoText);
        if (s.announcement) setAnnouncement(s.announcement);
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    const state = { paletteKey, font, mode, menu, truckName, logoText, announcement };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [paletteKey, font, mode, menu, truckName, logoText, announcement]);

  // --- Event glue (listen for upstream changes) ---
  useEffect(() => {
    if (!eventBus?.on) return;
    const off1 = eventBus.on("recipe.consolidated", (payload) => {
      // Example: auto-suggest featured item from latest consolidation
      // Non-blocking: show a toast with add option
      setToast({
        title: "New recipes consolidated",
        desc: "Add a featured dish to your board?",
        actionLabel: "Add Dish",
        onAction: () => {
          const dishName = payload?.topPick?.name || "Chef's Special";
          const newItem = {
            id: uid("itm"),
            name: dishName,
            price: payload?.topPick?.price || 13,
            desc: payload?.topPick?.summary || "Limited-time special.",
          };
          addItemToCategory("Plates", newItem);
          setToast(null);
        },
      });
    });
    const off2 = eventBus.on("inventory.updated", () => {
      // Recommend toggling availability when stock is low (not implemented here)
    });
    const off3 = eventBus.on("preferences.changed", (p) => {
      if (p?.theme) setPaletteKey(p.theme);
      if (p?.font) setFont(p.font);
    });
    return () => {
      off1?.();
      off2?.();
      off3?.();
    };
  }, []);

  // --- Derived styles ---
  const cssVars = useMemo(() => palette, [palette]);
  const fontStyle = useMemo(() => ({ fontFamily: font }), [font]);

  // --- Mutators ---
  const addCategory = () => {
    const next = [...menu, { id: uid("cat"), name: "New Category", items: [] }];
    setMenu(next);
    setDirty(true);
  };

  const renameCategory = (catId, name) => {
    setMenu((prev) =>
      prev.map((c) => (c.id === catId ? { ...c, name } : c))
    );
    setDirty(true);
  };

  const removeCategory = (catId) => {
    const removed = menu.find((c) => c.id === catId);
    setMenu(menu.filter((c) => c.id !== catId));
    setDirty(true);
    scheduleUndo({
      type: "remove.category",
      payload: removed,
      revert: () => {
        setMenu((prev) => [...prev, removed]);
        clearUndo();
      },
    });
  };

  const addItem = (catId) => {
    const newItem = { id: uid("itm"), name: "New Item", price: 0, desc: "" };
    setMenu((prev) =>
      prev.map((c) => (c.id === catId ? { ...c, items: [...c.items, newItem] } : c))
    );
    setDirty(true);
  };

  const addItemToCategory = (catName, item) => {
    const cat = menu.find((c) => c.name.toLowerCase() === catName.toLowerCase());
    if (cat) addItem(cat.id);
    else {
      const newCat = { id: uid("cat"), name: catName, items: [{ ...item, id: uid("itm") }] };
      setMenu((prev) => [...prev, newCat]);
      setDirty(true);
    }
  };

  const updateItem = (catId, itmId, patch) => {
    setMenu((prev) =>
      prev.map((c) =>
        c.id === catId
          ? { ...c, items: c.items.map((i) => (i.id === itmId ? { ...i, ...patch } : i)) }
          : c
      )
    );
    setDirty(true);
  };

  const removeItem = (catId, itmId) => {
    const cat = menu.find((c) => c.id === catId);
    const removed = cat?.items.find((i) => i.id === itmId);
    setMenu((prev) =>
      prev.map((c) =>
        c.id === catId ? { ...c, items: c.items.filter((i) => i.id !== itmId) } : c
      )
    );
    setDirty(true);
    scheduleUndo({
      type: "remove.item",
      payload: { catId, removed },
      revert: () => {
        setMenu((prev) =>
          prev.map((c) =>
            c.id === catId ? { ...c, items: [...c.items, removed] } : c
          )
        );
        clearUndo();
      },
    });
  };

  const publishMenu = () => {
    emit("foodtruck.menu.published", { menu, theme: paletteKey, font, mode, truckName });
    setDirty(false);
    setToast({
      title: "Menu published",
      desc: "Your board is live. Share with family & vendors?",
      actionLabel: "Share",
      onAction: () => {
        emit("sharing.request", {
          channel: "family.agrarian",
          payload: { kind: "menu", truckName, menu },
        });
        setToast(null);
      },
    });
  };

  const savePreset = () => {
    const key = prompt("Save preset as:");
    if (!key) return;
    localStorage.setItem(`suka.foodtruck.preset.${key}`, JSON.stringify({ menu, paletteKey, font, mode, truckName, logoText, announcement }));
    setToast({ title: "Preset saved", desc: `Saved as "${key}".`, actionLabel: null, onAction: null });
  };

  const loadPreset = () => {
    const key = prompt("Load preset name:");
    if (!key) return;
    const data = localStorage.getItem(`suka.foodtruck.preset.${key}`);
    if (!data) {
      setToast({ title: "Preset not found", desc: `No preset named "${key}".`, actionLabel: null, onAction: null });
      return;
    }
    try {
      const s = JSON.parse(data);
      setMenu(s.menu || DEFAULT_MENU);
      setPaletteKey(s.paletteKey || "blue");
      setFont(s.font || FONT_CHOICES[0].value);
      setMode(s.mode || "food_truck");
      setTruckName(s.truckName || "Suka Street Kitchen");
      setLogoText(s.logoText || "SUKA");
      setAnnouncement(s.announcement || "");
      setDirty(true);
      setToast({ title: "Preset loaded", desc: `Loaded "${key}".`, actionLabel: null, onAction: null });
    } catch {
      // ignore
    }
  };

  // --- Keyboard undo convenience ---
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && lastAction?.revert) {
        e.preventDefault();
        lastAction.revert();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lastAction]);

  // --- Render ---
  return (
    <div
      className="min-h-screen"
      style={{
        ...cssVars,
        background: "var(--ft-bg)",
        color: "var(--ft-ink)",
        transition: "background .2s ease, color .2s ease",
        ...fontStyle,
      }}
    >
      {/* Top Bar */}
      <header className="sticky top-0 z-30 backdrop-blur bg-black/30 border-b border-white/10">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-3">
          <TruckLogo logoText={logoText} paletteKey={paletteKey} />
          <input
            value={truckName}
            onChange={(e) => { setTruckName(e.target.value); setDirty(true); }}
            className="bg-transparent text-xl md:text-2xl font-semibold outline-none border-b border-transparent focus:border-white/30"
            aria-label="Food truck name"
          />
          <span className="ml-auto flex items-center gap-2">
            <ModeSwitch mode={mode} setMode={setMode} />
            <ThemeSwitch paletteKey={paletteKey} setPaletteKey={setPaletteKey} />
            <FontPicker font={font} setFont={setFont} />
            <a
              href="/chefs-catalogue"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20"
              title="Chef's Catalogue"
            >
              <ChefHat size={18} /> Catalogue
            </a>
            <a
              href="/fusion-lab"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--ft-accent)] hover:opacity-90"
              title="Fusion Lab"
            >
              <Rocket size={18} /> Fusion
            </a>
          </span>
        </div>
      </header>

      {/* Announcement / Marquee */}
      <div className="mx-auto max-w-7xl px-4 pt-4">
        <div className="flex items-center gap-2 text-sm opacity-90">
          <Megaphone size={16} />
          <input
            value={announcement}
            onChange={(e) => { setAnnouncement(e.target.value); setDirty(true); }}
            placeholder="Add a short announcement for your menu board…"
            className="flex-1 bg-transparent border-b border-white/10 focus:border-white/30 outline-none pb-1"
          />
        </div>
      </div>

      {/* Truck Chrome + Menu Board */}
      <main className="mx-auto max-w-7xl px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className={`lg:col-span-2 rounded-2xl border border-white/10 shadow-xl overflow-hidden ${
          mode === "street_food" ? "p-4 bg-[var(--ft-card)]/60" : "p-6 bg-[var(--ft-card)]/80"
        }`}>
          <TruckChrome mode={mode} paletteKey={paletteKey} logoText={logoText} setLogoText={setLogoText} />
          <MenuBoard
            menu={menu}
            addCategory={addCategory}
            renameCategory={renameCategory}
            removeCategory={removeCategory}
            addItem={addItem}
            updateItem={updateItem}
            removeItem={removeItem}
          />
        </div>

        {/* Side Controls */}
        <aside className="space-y-4">
          <ControlCard title="Quick Actions" icon={<Settings2 size={18} />}>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={publishMenu}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--ft-accent)] hover:opacity-90"
                title="Publish menu"
              >
                <UploadCloud size={18} /> Publish
              </button>
              <button
                onClick={savePreset}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20"
                title="Save preset"
              >
                <Save size={18} /> Save Preset
              </button>
              <button
                onClick={loadPreset}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20"
                title="Load preset"
              >
                <DownloadCloud size={18} /> Load Preset
              </button>
              {lastAction?.revert && (
                <button
                  onClick={lastAction.revert}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20"
                  title="Undo"
                >
                  <Undo2 size={18} /> Undo
                </button>
              )}
            </div>
          </ControlCard>

          <ControlCard title="Next Best Action" icon={<Rocket size={18} />}>
            <NextBestAction dirty={dirty} onPublish={publishMenu} />
          </ControlCard>

          <ControlCard title="Tips" icon={<ChefHat size={18} />}>
            <ul className="text-sm space-y-2 opacity-90 list-disc pl-5">
              <li>Keep item names short and punchy. Put flavor in the description.</li>
              <li>Use <span className="text-[var(--ft-accent-2)]">scarlet</span> accents sparingly to highlight specials.</li>
              <li>Street Food mode condenses spacing—great for kiosks and pop-ups.</li>
            </ul>
          </ControlCard>
        </aside>
      </main>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-0 right-0 z-40 flex justify-center">
          <div className="max-w-xl w-full mx-4 rounded-2xl border border-white/10 bg-black/70 backdrop-blur px-4 py-3 flex items-center gap-3">
            <div>
              <div className="font-semibold">{toast.title}</div>
              {toast.desc && <div className="text-sm opacity-80">{toast.desc}</div>}
            </div>
            <div className="ml-auto">
              {toast.actionLabel && toast.onAction && (
                <button
                  onClick={toast.onAction}
                  className="px-3 py-2 rounded-xl bg-[var(--ft-accent)] hover:opacity-90"
                >
                  {toast.actionLabel}
                </button>
              )}
              <button onClick={() => setToast(null)} className="ml-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20">
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Subcomponents ---

function ControlCard({ title, icon, children }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[var(--ft-card)]/70 p-4">
      <header className="flex items-center gap-2 mb-3">
        <div className="opacity-80">{icon}</div>
        <h3 className="font-semibold">{title}</h3>
      </header>
      {children}
    </section>
  );
}

function TruckLogo({ logoText, paletteKey }) {
  return (
    <div className="inline-flex items-center gap-2">
      <div
        className="rounded-xl px-2.5 py-1 text-sm font-bold tracking-wide"
        style={{ background: "var(--ft-accent)", color: "#0a0a0a" }}
      >
        {logoText || "SUKA"}
      </div>
      <span className="text-xs uppercase tracking-widest opacity-80">Theme: {paletteKey}</span>
    </div>
  );
}

function ModeSwitch({ mode, setMode }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-xl bg-white/10 p-1">
      {MODES.map((m) => {
        const Icon = m.icon;
        const active = mode === m.key;
        return (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm ${
              active ? "bg-[var(--ft-accent)] text-black" : "hover:bg-white/10"
            }`}
            title={m.label}
          >
            <Icon size={16} />
            <span className="hidden sm:block">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ThemeSwitch({ paletteKey, setPaletteKey }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-xl bg-white/10 p-1 pl-2">
      <Palette size={16} className="opacity-80" />
      <select
        value={paletteKey}
        onChange={(e) => setPaletteKey(e.target.value)}
        className="bg-transparent outline-none text-sm"
        aria-label="Theme colors"
        title="Theme colors"
      >
        {Object.keys(THEME_PALETTES).map((k) => (
          <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>
        ))}
      </select>
    </div>
  );
}

function FontPicker({ font, setFont }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-xl bg-white/10 p-1 pl-2">
      <TypeIcon size={16} className="opacity-80" />
      <select
        value={font}
        onChange={(e) => setFont(e.target.value)}
        className="bg-transparent outline-none text-sm max-w-[220px]"
        aria-label="Font"
        title="Font"
      >
        {FONT_CHOICES.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>
    </div>
  );
}

function TruckChrome({ mode, paletteKey, logoText, setLogoText }) {
  return (
    <div className={`rounded-2xl mb-4 border border-white/10 p-4 ${mode === "restaurant" ? "hidden" : ""}`}>
      <div className="flex items-center gap-3">
        <BusFront className="opacity-80" />
        <div className="flex-1">
          <div className="text-sm opacity-80">Truck Wrapper</div>
          <div className="text-xs opacity-60">Mode: {mode} • Theme: {paletteKey}</div>
        </div>
        <input
          value={logoText}
          onChange={(e) => setLogoText(e.target.value)}
          placeholder="Logo text"
          className="bg-transparent border-b border-white/10 focus:border-white/30 outline-none"
          aria-label="Logo text"
        />
      </div>
    </div>
  );
}

function MenuBoard({
  menu,
  addCategory,
  renameCategory,
  removeCategory,
  addItem,
  updateItem,
  removeItem,
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
      <header className="flex items-center gap-2 mb-4">
        <h2 className="text-xl font-bold">Menu Board</h2>
        <button
          onClick={addCategory}
          className="ml-auto inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20"
          title="Add category"
        >
          <Plus size={18} /> Add Category
        </button>
      </header>

      {menu.length === 0 ? (
        <EmptyBoard onAddCategory={addCategory} />
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {menu.map((cat) => (
            <CategoryCard
              key={cat.id}
              cat={cat}
              renameCategory={renameCategory}
              removeCategory={removeCategory}
              addItem={addItem}
              updateItem={updateItem}
              removeItem={removeItem}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyBoard({ onAddCategory }) {
  return (
    <div className="rounded-xl border border-dashed border-white/15 p-8 text-center">
      <div className="text-lg font-semibold mb-2">No categories yet</div>
      <div className="opacity-80 mb-4">Start by adding a category (e.g., Plates, Sides, Drinks).</div>
      <button
        onClick={onAddCategory}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--ft-accent)] text-black"
      >
        <Plus size={18} /> Add First Category
      </button>
    </div>
  );
}

function CategoryCard({ cat, renameCategory, removeCategory, addItem, updateItem, removeItem }) {
  const [name, setName] = useState(cat.name);

  useEffect(() => setName(cat.name), [cat.name]);

  return (
    <section className="rounded-xl border border-white/10 bg-[var(--ft-card)]/70 p-4">
      <header className="flex items-center gap-2 mb-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && renameCategory(cat.id, name)}
          className="flex-1 bg-transparent font-semibold outline-none border-b border-transparent focus:border-white/30"
          aria-label="Category name"
        />
        <button
          onClick={() => addItem(cat.id)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20"
          title="Add item"
        >
          <Plus size={16} /> Item
        </button>
        <button
          onClick={() => removeCategory(cat.id)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20"
          title="Remove category"
        >
          <Trash2 size={16} /> Remove
        </button>
      </header>

      {cat.items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/15 p-6 text-center">
          <div className="opacity-80 mb-3">No items yet.</div>
          <button
            onClick={() => addItem(cat.id)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--ft-accent)] text-black"
          >
            <Plus size={16} /> Add Item
          </button>
        </div>
      ) : (
        <ul className="space-y-3">
          {cat.items.map((i) => (
            <li key={i.id} className="rounded-lg border border-white/10 p-3 bg-black/20">
              <div className="flex gap-3">
                <input
                  value={i.name}
                  onChange={(e) => updateItem(cat.id, i.id, { name: e.target.value })}
                  className="flex-1 bg-transparent font-medium outline-none border-b border-transparent focus:border-white/30"
                  placeholder="Item name"
                  aria-label="Item name"
                />
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={i.price}
                  onChange={(e) => updateItem(cat.id, i.id, { price: Number(e.target.value) })}
                  className="w-24 bg-transparent text-right outline-none border-b border-transparent focus:border-white/30"
                  placeholder="0"
                  aria-label="Price"
                />
                <span className="opacity-70">$</span>
                <button
                  onClick={() => removeItem(cat.id, i.id)}
                  className="ml-2 inline-flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/10 hover:bg-white/20"
                  title="Remove item"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <textarea
                value={i.desc}
                onChange={(e) => updateItem(cat.id, i.id, { desc: e.target.value })}
                className="mt-2 w-full bg-transparent text-sm outline-none border-b border-transparent focus:border-white/30"
                placeholder="Short, tasty description…"
                rows={2}
                aria-label="Item description"
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NextBestAction({ dirty, onPublish }) {
  if (dirty) {
    return (
      <div className="text-sm">
        <div className="font-medium mb-1">Finish & publish</div>
        <div className="opacity-80 mb-3">You have unsaved changes to your board.</div>
        <button
          onClick={onPublish}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--ft-accent)] text-black"
        >
          <UploadCloud size={18} /> Publish Now
        </button>
      </div>
    );
  }
  return (
    <div className="text-sm">
      <div className="font-medium mb-1">Promote your menu</div>
      <div className="opacity-80 mb-3">Share with family agrarians to forecast garden & animal supply.</div>
      <button
        onClick={() => {
          emit("sharing.request", { channel: "family.agrarian", payload: { kind: "menu.link" } });
        }}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20"
      >
        <Megaphone size={18} /> Share Plan
      </button>
    </div>
  );
}
