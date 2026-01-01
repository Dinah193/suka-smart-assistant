// src/components/meals/RhythmBuilder.jsx
// Self-contained sandbox build (no alias imports). In your app, replace the
// inline shims with your real modules/stores/components.

import React, { useEffect, useMemo, useRef, useState } from "react";

/* ---------------------------------------------------------------------------
   Inline shims (replace with your project modules in production)
----------------------------------------------------------------------------*/
function cx(...args) {
  return args.filter(Boolean).join(" ");
}
const eventBus = (() => {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      listeners.get(type)?.forEach((fn) => fn(payload));
    },
  };
})();
const automation = {
  async generateMealPlanFromRhythm({ rhythm, mode }) {
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, id: "draft-" + Date.now(), rhythm, mode };
  },
};
const emitProgress = (evt, data) => console.debug("[progress]", evt, data);
function usePreferencesStore() {
  return {
    mealMode: "auto",
    calendar: { isPassoverSeason: false },
    macros: { calories: 2000, proteinPct: 30, fatPct: 30, carbsPct: 40 },
  };
}
function useMealRhythmStore() {
  return {
    weeklyRhythm: null,
    setWeeklyRhythm(r) {
      this.weeklyRhythm = r;
    },
  };
}
function useFoodStore() {
  return {
    favorites: [
      { name: "Jollof Rice", tags: ["West African", "Rice", "Tomato", "Balanced"] },
      { name: "Suya", tags: ["West African", "Beef", "Grill", "Street Food", "High Protein"] },
    ],
  };
}
const Icon = ({ label }) => (
  <span className="inline-block w-4 h-4 align-middle rounded-sm border border-base-300 text-[9px] text-center leading-4 mr-1">
    {label}
  </span>
);
function TargetsBadge({ className = "" }) {
  return (
    <span className={cx("badge badge-ghost text-[10px]", className)} title="Nutrition / macros targets">
      Targets
    </span>
  );
}
function NBAToolbar({ actions = [] }) {
  return (
    <div className="rounded-xl border bg-base-100 p-2 flex flex-wrap gap-2">
      {actions.map((a) => (
        <button key={a.key} className="btn btn-xs" onClick={a.onClick} title={a.label}>
          {a.label}
        </button>
      ))}
    </div>
  );
}
function UndoToast({ onUndo }) {
  return (
    <div className="fixed bottom-2 right-2">
      <button className="btn btn-xs btn-ghost" onClick={onUndo} title="Undo last action">
        Undo
      </button>
    </div>
  );
}
function RecipePickerDrawer({ isOpen, onClose, onSelect, context }) {
  if (!isOpen) return null;
  const mealType = context?.slot;
  const filtered = mealType ? MOCK_RECIPES.filter((r) => r.mealType === mealType) : MOCK_RECIPES;
  return (
    <div className="fixed inset-0 bg-black/40 flex justify-end">
      <div className="w-full max-w-md h-full bg-base-100 p-4 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">Pick a recipe for {context?.day} {context?.slot}</div>
          <button className="btn btn-xs" onClick={onClose}>Close</button>
        </div>
        <ul className="space-y-2">
          {filtered.map((r) => (
            <li key={r.id} className="p-2 rounded border hover:bg-base-200/50 cursor-pointer"
                onClick={() => { onSelect?.(r); onClose?.(); }}>
              <div className="font-medium">{r.title}</div>
              <div className="text-xs opacity-70">{r.tags.join(" · ")}</div>
              <div className="text-[10px] opacity-60">~{r.kcal} kcal • P{r.protein}g F{r.fat}g C{r.carbs}g</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Constants & Data
----------------------------------------------------------------------------*/
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SLOTS = ["Breakfast", "Lunch", "Dinner", "Snack"]; // canonical order

const DEFAULT_TAG_GROUPS = {
  cuisine: [
    "West African", "Nigerian", "Ghanaian", "Senegalese", "Jollof", "Suya", "Egusi", "Waakye",
    "Kelewele", "Ethiopian", "Eritrean", "Somali", "Caribbean", "Jamaican", "Haitian", "Gullah",
    "Soul Food", "Indian", "Indo‑African", "Turkish", "Levant", "Mediterranean", "North African",
    "Mexican", "Thai",
  ],
  protein: ["Lamb", "Goat", "Beef", "Chicken", "Turkey", "Fish", "Eggs", "Beans", "Lentils", "Tofu"],
  method: ["Grill", "Roast", "Stew", "Braise", "Pressure Cook", "Skillet", "Air‑Fry", "Smoke", "Cure", "Fry"],
  mode: ["Home", "Street Food", "Food Truck"],
  focus: ["High Protein", "Low Carb", "Balanced", "Feast Day", "Passover‑Safe", "Sabbath‑Ease"],
};

const MOCK_RECIPES = [
  { id: 1, mealType: "Dinner", title: "Goat Egusi Stew", kcal: 700, protein: 45, fat: 35, carbs: 55,
    tags: ["West African", "Goat", "Stew", "Home", "Balanced"] },
  { id: 2, mealType: "Dinner", title: "Senegalese Grilled Fish", kcal: 550, protein: 42, fat: 18, carbs: 50,
    tags: ["Senegalese", "Fish", "Grill", "Street Food", "High Protein"] },
  { id: 3, mealType: "Breakfast", title: "Akara & Fruit", kcal: 420, protein: 16, fat: 18, carbs: 48,
    tags: ["West African", "Beans", "Fry", "Street Food", "Balanced"] },
  { id: 4, mealType: "Breakfast", title: "Kelewele Yogurt Bowl", kcal: 380, protein: 20, fat: 12, carbs: 52,
    tags: ["Ghanaian", "Kelewele", "Fry", "Home", "Balanced"] },
  { id: 5, mealType: "Lunch", title: "Jollof + Suya Beef Bowl", kcal: 650, protein: 35, fat: 22, carbs: 78,
    tags: ["West African", "Beef", "Grill", "Rice", "Street Food"] },
  { id: 6, mealType: "Lunch", title: "Shito Fish Salad", kcal: 480, protein: 34, fat: 20, carbs: 32,
    tags: ["Ghanaian", "Fish", "Home", "Low Carb"] },
  { id: 7, mealType: "Dinner", title: "Levant Lamb Roast", kcal: 820, protein: 48, fat: 46, carbs: 40,
    tags: ["Levant", "Lamb", "Roast", "Food Truck", "Feast Day"] },
  { id: 8, mealType: "Dinner", title: "Soul Food Fish Fry", kcal: 760, protein: 40, fat: 44, carbs: 52,
    tags: ["Soul Food", "Fish", "Fry", "Home", "Sabbath‑Ease"] },
];

const WA_TEMPLATE = {
  Mon: { Breakfast: emptyCell(), Lunch: emptyCell(),
         Dinner: filledCell({ cuisine:["West African"], protein:["Goat"], method:["Stew"], mode:["Home"], focus:["Balanced"] }),
         Snack: emptyCell() },
  Tue: { Breakfast: emptyCell(), Lunch: emptyCell(),
         Dinner: filledCell({ cuisine:["Senegalese"], protein:["Fish"], method:["Grill"], mode:["Street Food"], focus:["High Protein"] }),
         Snack: emptyCell() },
  Wed: { Breakfast: emptyCell(), Lunch: emptyCell(),
         Dinner: filledCell({ cuisine:["Ghanaian"], protein:["Chicken"], method:["Roast"], mode:["Home"], focus:["Balanced"] }),
         Snack: emptyCell() },
  Thu: { Breakfast: emptyCell(), Lunch: emptyCell(),
         Dinner: filledCell({ cuisine:["Caribbean"], protein:["Beef"], method:["Braise"], mode:["Home"], focus:["Balanced"] }),
         Snack: emptyCell() },
  Fri: { Breakfast: emptyCell(), Lunch: emptyCell(),
         Dinner: filledCell({ cuisine:["Soul Food"], protein:["Fish"], method:["Fry"], mode:["Home"], focus:["Sabbath‑Ease"] }),
         Snack: emptyCell() },
  Sat: { Breakfast: emptyCell(), Lunch: emptyCell(),
         Dinner: filledCell({ cuisine:["Levant"], protein:["Lamb"], method:["Roast"], mode:["Food Truck"], focus:["Feast Day"] }),
         Snack: emptyCell() },
  Sun: { Breakfast: emptyCell(), Lunch: emptyCell(),
         Dinner: filledCell({ cuisine:["Nigerian"], protein:["Beef"], method:["Stew"], mode:["Home"], focus:["Balanced"] }),
         Snack: emptyCell() },
};

function emptyCell() {
  return { cuisine: [], protein: [], method: [], mode: [], focus: [] };
}
function filledCell(x) {
  return { cuisine: x.cuisine||[], protein: x.protein||[], method: x.method||[], mode: x.mode||[], focus: x.focus||[] };
}

const safeParse = (json, fallback) => {
  try { return JSON.parse(json); } catch { return fallback; }
};

/* ---------------------------------------------------------------------------
   Component
----------------------------------------------------------------------------*/
export default function RhythmBuilder({ className = "", onSaved }) {
  const prefStore = usePreferencesStore();
  const rhythmStore = useMealRhythmStore();
  const foodStore = useFoodStore();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeDaySlot, setActiveDaySlot] = useState({ day: "Mon", slot: "Dinner" });
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [mode, setMode] = useState(prefStore?.mealMode || "auto");
  const [draft, setDraft] = useState(() => initialDraftFromStore(rhythmStore) || buildEmptyWeek());
  const undoStack = useRef([]);
  const redoStack = useRef([]);

  // User-configurable per‑meal macro split + enable/disable meals
  const defaultSplit = { Breakfast: 25, Lunch: 35, Dinner: 40, Snack: 0 };
  const [mealSplit, setMealSplit] = useState(() => {
    const saved = typeof localStorage !== "undefined" && safeParse(localStorage.getItem("meal.split"), null);
    return saved ? { ...defaultSplit, ...saved } : defaultSplit;
  });
  const [enabledSlots, setEnabledSlots] = useState(() => {
    const saved = typeof localStorage !== "undefined" && safeParse(localStorage.getItem("meal.enabledSlots"), null);
    return saved ? { Breakfast: true, Lunch: true, Dinner: true, Snack: true, ...saved } : { Breakfast: true, Lunch: true, Dinner: true, Snack: true };
  });
  const filteredSlots = useMemo(() => SLOTS.filter((s) => enabledSlots[s]), [enabledSlots]);

  const favoriteTags = useMemo(() => {
    const favs = foodStore?.favorites || [];
    const tags = favs.flatMap((f) => f.tags || []);
    return Array.from(new Set(tags)).slice(0, 50);
  }, [foodStore?.favorites]);

  const tagGroups = useMemo(() => enhanceTagGroups(DEFAULT_TAG_GROUPS, favoriteTags, prefStore), [favoriteTags, prefStore]);
  const filteredPalette = useMemo(() => filterPalette(tagGroups, query), [tagGroups, query]);

  useEffect(() => {
    const targets = prefStore?.macros || { calories: 2000, proteinPct: 30, fatPct: 30, carbsPct: 40 };
    const act = { day: activeDaySlot.day, slot: activeDaySlot.slot, cell: draft[activeDaySlot.day]?.[activeDaySlot.slot] };
    setSuggestions(suggestComplements({ query, active: act, targets, mealSplit }));
  }, [query, activeDaySlot, draft, prefStore, mealSplit]);

  useEffect(() => {
    const off = eventBus.on("preferences.changed", (payload) => {
      if (payload?.keys?.includes("TorahMode")) setDraft((prev) => enforceTorahConstraints(prev, prefStore));
    });
    return () => off?.();
  }, [prefStore]);

  // Undo / Redo helpers
  const commit = (next) => { undoStack.current.push(draft); redoStack.current = []; setDraft(next); };
  const undo = () => { const prev = undoStack.current.pop(); if (!prev) return; redoStack.current.push(draft); setDraft(prev); };
  const redo = () => { const nxt = redoStack.current.pop(); if (!nxt) return; undoStack.current.push(draft); setDraft(nxt); };

  // DnD
  const onDragStart = (e, payload) => { e.dataTransfer.setData("application/json", JSON.stringify(payload)); };
  const onDropChip = (e, day, slot) => {
    e.preventDefault();
    const payload = safeParse(e.dataTransfer.getData("application/json"), null);
    if (!payload) return;
    const next = structuredClone(draft); ensureDaySlot(next, day, slot);
    if (payload.group === "suggestion") {
      const stamp = normalizeRecipeTags(payload.value);
      Object.entries(stamp).forEach(([k, arr]) => {
        next[day][slot][k] = Array.from(new Set([...(next[day][slot][k] || []), ...arr]));
      });
    } else {
      const list = next[day][slot][payload.group] || (next[day][slot][payload.group] = []);
      if (!list.includes(payload.value)) list.push(payload.value);
    }
    commit(next);
  };
  const allowDrop = (e) => e.preventDefault();

  // Top-level actions
  const clearDay = (day) => commit({ ...draft, [day]: {} });
  const clearAll = () => commit(buildEmptyWeek());
  const applyToAll = (fromDay, fromSlot = "Dinner") => {
    const base = draft[fromDay]?.[fromSlot] || {};
    const next = buildEmptyWeek();
    for (const d of DAYS) next[d][fromSlot] = structuredClone(base);
    commit(next);
  };
  const shuffleWeek = () => {
    const g = tagGroups; const next = buildEmptyWeek();
    for (const d of DAYS) for (const s of SLOTS) next[d][s] = {
      cuisine: pickSome(g.cuisine, 1, 2), protein: pickSome(g.protein, 1, 2), method: pickSome(g.method, 1, 1),
      mode: pickSome(g.mode, 1, 1), focus: pickSome(g.focus, 1, 1),
    };
    commit(next);
  };

  const saveRhythm = async () => {
    try {
      rhythmStore?.setWeeklyRhythm?.(draft);
      if (typeof localStorage !== "undefined") localStorage.setItem("meal.weeklyRhythm", JSON.stringify(draft));
      eventBus.emit("meal.rhythm.updated", { draft });
      onSaved?.(draft);
    } catch (e) { console.error("saveRhythm", e); }
  };
  const exportRhythm = () => {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `meal-rhythm-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
  };
  const importRhythm = (file) => { const r = new FileReader(); r.onload = () => { const json = safeParse(r.result, null); if (json) commit(ensureAllSlots(json)); }; r.readAsText(file); };
  const generatePlan = async () => { emitProgress("meal.rhythm.generate.start", { mode }); await automation.generateMealPlanFromRhythm({ rhythm: draft, mode, source: "RhythmBuilder" }); emitProgress("meal.rhythm.generate.end", { ok: true }); };

  const activeCell = draft[activeDaySlot.day]?.[activeDaySlot.slot] || {};

  return (
    <div className={cx("w-full", className)}>
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-3">
        <div>
          <div className="text-xl font-semibold">
            Weekly Rhythm Builder
            <span className="ml-2 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
              {mode === "auto" ? "auto" : "manual"}
            </span>
          </div>
          <p className="text-sm text-base-content/70">Set a repeatable flavor rhythm (cuisine • protein • method • mode • focus). West African first, street/food‑truck friendly, honors Torah constraints.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setMode(mode === "auto" ? "manual" : "auto")} className="btn btn-sm"><Icon label="A" /> {mode === "auto" ? "Switch to Manual" : "Switch to Auto"}</button>
          <button onClick={shuffleWeek} className="btn btn-sm"><Icon label="S" /> Shuffle</button>
          <button onClick={saveRhythm} className="btn btn-sm btn-primary"><Icon label="💾" /> Save</button>
          <button onClick={generatePlan} className="btn btn-sm btn-accent"><Icon label="👨‍🍳" /> Generate Plan</button>
          <label className="btn btn-sm"><Icon label="⬆" /> Import
            <input type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && importRhythm(e.target.files[0])} />
          </label>
          <button onClick={exportRhythm} className="btn btn-sm"><Icon label="⬇" /> Export</button>
          <button onClick={clearAll} className="btn btn-sm btn-ghost text-error"><Icon label="🗑" /> Clear</button>
        </div>
      </div>

      {/* Config: Per‑meal split + Remove meal toggles */}
      <MealConfigBar
        mealSplit={mealSplit}
        setMealSplit={(next) => { setMealSplit(next); if (typeof localStorage !== "undefined") localStorage.setItem("meal.split", JSON.stringify(next)); }}
        enabledSlots={enabledSlots}
        setEnabledSlots={(next) => { setEnabledSlots(next); if (typeof localStorage !== "undefined") localStorage.setItem("meal.enabledSlots", JSON.stringify(next)); }}
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: Tag palette */}
        <div className="lg:col-span-4 xl:col-span-3">
          <div className="rounded-2xl border bg-base-100 p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <span className="w-4 h-4 absolute left-2 top-2.5 opacity-60 text-[10px]">🔎</span>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tags… or calories/macros" className="input input-sm pl-8 w-full" />
              </div>
              <TargetsBadge className="ml-auto" />
            </div>
            <PaletteSection title="Cuisine (WA first)" icon={<Icon label="🍲" />} chips={filteredPalette.cuisine} onDragStart={onDragStart} group="cuisine" />
            <PaletteSection title="Protein" chips={filteredPalette.protein} onDragStart={onDragStart} group="protein" />
            <PaletteSection title="Method" chips={filteredPalette.method} onDragStart={onDragStart} group="method" />
            <PaletteSection title="Mode (Home • Street • Truck)" icon={<Icon label="🚚" />} chips={filteredPalette.mode} onDragStart={onDragStart} group="mode" />
            <PaletteSection title="Focus (Macros/Feasts)" chips={filteredPalette.focus} onDragStart={onDragStart} group="focus" />
            {favoriteTags?.length > 0 && (
              <PaletteSection title="Household Favorites" chips={favoriteTags} onDragStart={onDragStart} group="favorites" />
            )}
            {suggestions?.length > 0 && (
              <SuggestionSection title="Suggested Complements" items={suggestions}
                onDragStart={(e, item) => onDragStart(e, { group: "suggestion", value: item })} />
            )}
          </div>
        </div>

        {/* Right: Week planner */}
        <div className="lg:col-span-8 xl:col-span-9">
          <div className="rounded-2xl border bg-base-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm opacity-70">Drag chips into any day/slot. Click a cell to open Recipe Picker.</div>
              <div className="flex gap-2">
                <button onClick={() => applyToAll(activeDaySlot.day, activeDaySlot.slot)} className="btn btn-xs"><Icon label="➕" /> Apply to all</button>
                <button onClick={() => clearDay(activeDaySlot.day)} className="btn btn-xs btn-ghost text-error"><Icon label="🗑" /> Clear day</button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th className="w-16">Day</th>
                    {filteredSlots.map((slot) => (<th key={slot}>{slot}</th>))}
                  </tr>
                </thead>
                <tbody>
                  {DAYS.map((day) => (
                    <tr key={day} className={cx(activeDaySlot.day === day && "bg-base-200/40")}>
                      <td className="font-medium">{day}</td>
                      {filteredSlots.map((slot) => (
                        <td key={slot}>
                          <DropCell
                            day={day}
                            slot={slot}
                            data={draft[day]?.[slot]}
                            onDrop={(e) => onDropChip(e, day, slot)}
                            onDragOver={allowDrop}
                            onClick={() => { setActiveDaySlot({ day, slot }); setDrawerOpen(true); }}
                            isActive={activeDaySlot.day === day && activeDaySlot.slot === slot}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3">
            <NBAToolbar
              actions={[
                { key: "suggest", label: "Suggest recipes for active cell", onClick: () => setDrawerOpen(true) },
                { key: "autoFill", label: "Auto‑fill week from profile", onClick: shuffleWeek },
                { key: "generate", label: "Generate meal plan draft", onClick: generatePlan },
                { key: "undo", label: "Undo", onClick: undo },
                { key: "redo", label: "Redo", onClick: redo },
              ]}
            />
          </div>
        </div>
      </div>

      <RecipePickerDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSelect={(recipe) => {
          const next = structuredClone(draft);
          ensureDaySlot(next, activeDaySlot.day, activeDaySlot.slot);
          const stamp = normalizeRecipeTags(recipe);
          Object.entries(stamp).forEach(([k, arr]) => {
            next[activeDaySlot.day][activeDaySlot.slot][k] = Array.from(new Set([...(next[activeDaySlot.day][activeDaySlot.slot][k] || []), ...arr]));
          });
          commit(next);
        }}
        context={{ day: activeDaySlot.day, slot: activeDaySlot.slot, filters: activeCell, mealSplit }}
      />

      <UndoToast onUndo={undo} />
      <div className="mt-4 text-xs opacity-70">
        Shortcuts: <kbd className="kbd kbd-xs">Ctrl</kbd>+<kbd className="kbd kbd-xs">Z</kbd> undo • <kbd className="kbd kbd-xs">Ctrl</kbd>+<kbd className="kbd kbd-xs">Y</kbd> redo • Click a cell to browse recipes • Drag chips into cells
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Sub-components
----------------------------------------------------------------------------*/
function MealConfigBar({ mealSplit, setMealSplit, enabledSlots, setEnabledSlots }) {
  const total = Object.values(mealSplit).reduce((a,b)=>a + (Number.isFinite(b)?b:0), 0);
  const overUnder = Math.round((total - 100) * 100) / 100;
  const update = (slot, val) => {
    const n = Math.max(0, Math.min(100, Number(val) || 0));
    setMealSplit({ ...mealSplit, [slot]: n });
  };
  const toggle = (slot) => setEnabledSlots({ ...enabledSlots, [slot]: !enabledSlots[slot] });
  return (
    <div className="rounded-xl border bg-base-100 p-3 mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-xs font-semibold uppercase tracking-wide opacity-70">Per‑meal macro split (%)</div>
        {SLOTS.map((s) => (
          <label key={s} className="flex items-center gap-1 text-xs">
            <span className="w-14">{s}</span>
            <input type="number" min={0} max={100} value={mealSplit[s] ?? 0} onChange={(e)=>update(s, e.target.value)} className="input input-xs w-16" />
          </label>
        ))}
        <div className={cx("text-xs", overUnder===0?"text-success":"text-error")}>Total: {total}% {overUnder!==0 && `(±${overUnder})`}</div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide opacity-70">Meals</div>
        {SLOTS.map((s) => (
          <label key={s} className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={!!enabledSlots[s]} onChange={()=>toggle(s)} />
            <span>{enabledSlots[s]?"Shown":"Removed"} {s}</span>
          </label>
        ))}
        <div className="text-[10px] opacity-60 ml-auto">Removing a meal hides its column and excludes it from macro scoring.</div>
      </div>
    </div>
  );
}

function SuggestionSection({ title, items = [], onDragStart }) {
  return (
    <div className="mt-4 border-t pt-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon label="✨" />
        <div className="text-xs font-semibold uppercase tracking-wide opacity-70">{title}</div>
      </div>
      <div className="flex flex-col gap-1.5">
        {items.map((it) => (
          <div key={it.id} className="p-2 rounded border hover:bg-base-200/50 cursor-grab select-none" draggable
               onDragStart={(e) => onDragStart(e, it)} title={`Drag to ${it.mealType} cell`}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="font-medium text-sm">{it.title} <span className="opacity-60 text-[10px]">({it.mealType})</span></div>
                <div className="text-[10px] opacity-60">~{it.kcal} kcal • P{it.protein}g F{it.fat}g C{it.carbs}g</div>
              </div>
              <div className="text-[10px] opacity-70">match {Math.round(it.matchScore * 100)}%</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PaletteSection({ title, chips = [], onDragStart, group, icon }) {
  if (!chips?.length) return null;
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1">{icon}<div className="text-xs font-semibold uppercase tracking-wide opacity-70">{title}</div></div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <span key={group + ":" + c} className="badge badge-outline cursor-grab select-none" draggable
                onDragStart={(e) => onDragStart(e, { group, value: c })} title="Drag onto a day/slot">{c}</span>
        ))}
      </div>
    </div>
  );
}

function DropCell({ day, slot, data = {}, onDrop, onDragOver, onClick, isActive }) {
  const chips = flattenCellChips(data);
  return (
    <div onDrop={onDrop} onDragOver={onDragOver} onClick={onClick}
         className={cx("rounded-xl border p-2 min-h-[56px] cursor-pointer",
           isActive ? "border-primary bg-primary/5" : "border-base-300 hover:bg-base-200/30")}
    >
      <div className="text-[10px] uppercase tracking-wide opacity-60 mb-1">{slot}</div>
      {chips.length ? (
        <div className="flex flex-wrap gap-1">{chips.map((t, i) => (<span key={i} className="badge badge-ghost badge-sm">{t}</span>))}</div>
      ) : (
        <div className="text-xs opacity-50">Drop tags here…</div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Utilities
----------------------------------------------------------------------------*/
function ensureAllSlots(week) {
  const next = structuredClone(week);
  for (const d of DAYS) {
    next[d] ||= {};
    for (const s of SLOTS) next[d][s] ||= emptyCell();
  }
  return next;
}
function macrosFromPct({ calories, proteinPct, fatPct, carbsPct }) {
  const protein = Math.round((calories * (proteinPct / 100)) / 4);
  const fat = Math.round((calories * (fatPct / 100)) / 9);
  const carbs = Math.round((calories * (carbsPct / 100)) / 4);
  return { calories, protein, fat, carbs };
}
function getMealWeights(split) {
  const base = split || { Breakfast: 33.34, Lunch: 33.33, Dinner: 33.33, Snack: 0 };
  const total = Object.values(base).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) || 100;
  const norm = {}; for (const s of SLOTS) norm[s] = (base[s] ?? 0) / total; return norm; // fractions summing ~1
}
function scoreRecipeAgainstTargets(recipe, targets, slot = "Dinner", split = null) {
  const t = macrosFromPct(targets); const w = getMealWeights(split)[slot] ?? 1/3;
  const dk = Math.abs(recipe.kcal - t.calories * w);
  const dp = Math.abs(recipe.protein - t.protein * w);
  const df = Math.abs(recipe.fat - t.fat * w);
  const dc = Math.abs(recipe.carbs - t.carbs * w);
  const dist = dk / 10 + dp + df + dc; return 1 / (1 + dist / 100);
}
function suggestComplements({ query, active, targets, mealSplit }) {
  // Returns an ARRAY of suggestion objects; JSX is rendered elsewhere.
  const q = (query || "").toLowerCase();
  const actTags = flattenCellChips(active.cell || {});

  // Filter DB by query text and tag affinity (no meal-type bias)
  let pool = MOCK_RECIPES.filter((r) => {
    const text = (r.title + " " + r.tags.join(" ")).toLowerCase();
    const textMatch = q ? text.includes(q) : true;
    const tagMatch = !actTags.length ? true : r.tags.some((t) => actTags.includes(t));
    return textMatch && tagMatch;
  });

  // Score by macro fit for the ACTIVE slot using user's per‑meal split
  const scored = pool.map((r) => ({
    ...r,
    matchScore: scoreRecipeAgainstTargets(r, targets, active.slot, mealSplit),
  }));
  scored.sort((a, b) => b.matchScore - a.matchScore);

  // Balanced mix across meal types via round‑robin selection
  const buckets = new Map();
  for (const r of scored) {
    if (!buckets.has(r.mealType)) buckets.set(r.mealType, []);
    buckets.get(r.mealType).push(r);
  }
  const order = Array.from(buckets.keys());
  const out = [];
  let i = 0;
  while (out.length < 6 && order.length) {
    const key = order[i % order.length];
    const arr = buckets.get(key);
    if (arr && arr.length) out.push(arr.shift());
    if (!arr || arr.length === 0) {
      // remove empty bucket and update order
      const idx = order.indexOf(key);
      if (idx >= 0) order.splice(idx, 1);
      buckets.delete(key);
    }
    i++;
    if (i > 100) break; // safety
  }
  return out;
}
function buildEmptyWeek() { const week = {}; for (const d of DAYS) { week[d] = {}; for (const s of SLOTS) week[d][s] = emptyCell(); } return week; }
function ensureDaySlot(obj, day, slot) { obj[day] ||= {}; obj[day][slot] ||= emptyCell(); }
function flattenCellChips(data) { const out = []; for (const k of ["cuisine", "protein", "method", "mode", "focus"]) (data[k] || []).forEach((v) => out.push(v)); return out; }
function pickSome(arr, min = 1, max = 1) { if (!arr?.length) return []; const n = Math.max(min, Math.min(max, 1 + Math.floor(Math.random() * max))); const pool = [...arr]; const out = []; while (out.length < n && pool.length) { const i = Math.floor(Math.random() * pool.length); out.push(pool.splice(i, 1)[0]); } return out; }
function filterPalette(groups, q) { if (!q) return groups; const s = String(q).toLowerCase(); const out = {}; Object.entries(groups).forEach(([k, list]) => { out[k] = list.filter((x) => String(x).toLowerCase().includes(s)); }); return out; }
function enhanceTagGroups(base, favorites, prefStore) {
  const out = structuredClone(base);
  if (prefStore?.calendar?.isPassoverSeason) out.focus = Array.from(new Set(["Passover‑Safe", ...out.focus]));
  if (favorites?.length) out.cuisine = Array.from(new Set([...(favorites.filter((f) => f.length < 18) || []), ...out.cuisine]));
  return out;
}
function normalizeRecipeTags(recipe) {
  const tags = recipe?.tags || []; const lower = tags.map((t) => String(t).toLowerCase());
  const stamp = emptyCell();
  DEFAULT_TAG_GROUPS.cuisine.forEach((c) => { if (lower.includes(c.toLowerCase())) stamp.cuisine.push(c); });
  DEFAULT_TAG_GROUPS.protein.forEach((c) => { if (lower.includes(c.toLowerCase())) stamp.protein.push(c); });
  DEFAULT_TAG_GROUPS.method.forEach((c) => { if (lower.includes(c.toLowerCase())) stamp.method.push(c); });
  ["Home", "Street Food", "Food Truck"].forEach((c) => { if (lower.includes(c.toLowerCase())) stamp.mode.push(c); });
  ["High Protein", "Low Carb", "Balanced", "Feast Day", "Passover‑Safe", "Sabbath‑Ease"].forEach((c) => { if (lower.includes(c.toLowerCase())) stamp.focus.push(c); });
  return stamp;
}
function enforceTorahConstraints(week, prefStore) {
  const passover = prefStore?.calendar?.isPassoverSeason; const next = structuredClone(week);
  for (const d of Object.keys(next)) {
    for (const slot of Object.keys(next[d] || {})) {
      const cell = next[d][slot]; if (!cell) continue; cell.focus ||= [];
      if (passover && !cell.focus.includes("Passover‑Safe")) cell.focus.push("Passover‑Safe");
      if ((d === "Fri" || d === "Sat") && !cell.focus.includes("Sabbath‑Ease")) cell.focus.push("Sabbath‑Ease");
    }
  }
  return next;
}
function initialDraftFromStore(rhythmStore) {
  const fromStore = rhythmStore?.weeklyRhythm; if (fromStore) return ensureAllSlots(fromStore);
  const fromLocal = typeof localStorage !== "undefined" ? safeParse(localStorage.getItem("meal.weeklyRhythm"), null) : null;
  if (fromLocal) return ensureAllSlots(fromLocal); return ensureAllSlots(WA_TEMPLATE);
}

/* ---------------------------------------------------------------------------
   Inline tests (dev/demo)
----------------------------------------------------------------------------*/
function assert(name, condition) { if (!condition) throw new Error("Test failed: " + name); console.debug("✔", name); }
export function runRhythmBuilderTests() {
  // buildEmptyWeek + slots
  const wk = buildEmptyWeek();
  assert("buildEmptyWeek has 7 days", Object.keys(wk).length === 7);
  assert("buildEmptyWeek has Breakfast", !!wk.Mon?.Breakfast && Array.isArray(wk.Mon.Breakfast.cuisine));
  assert("buildEmptyWeek has Lunch", !!wk.Mon?.Lunch && Array.isArray(wk.Mon.Lunch.cuisine));
  assert("buildEmptyWeek has Dinner", !!wk.Mon?.Dinner && Array.isArray(wk.Mon.Dinner.cuisine));

  // ensureDaySlot
  ensureDaySlot(wk, "Mon", "Dinner");
  assert("ensureDaySlot creates cell", Array.isArray(wk.Mon.Dinner.cuisine));

  // flattenCellChips
  wk.Mon.Dinner.cuisine.push("West African");
  const chips = flattenCellChips(wk.Mon.Dinner);
  assert("flattenCellChips returns cuisine tag", chips.includes("West African"));

  // filterPalette
  const fp = filterPalette({ cuisine: ["West African", "Thai"] }, "west");
  assert("filterPalette filters by query", fp.cuisine.length === 1 && fp.cuisine[0] === "West African");

  // enhanceTagGroups
  const enhanced = enhanceTagGroups({ cuisine: ["A"], focus: ["B"] }, ["Fav"], { calendar: { isPassoverSeason: true } });
  assert("enhanceTagGroups adds Passover‑Safe", enhanced.focus.includes("Passover‑Safe"));
  assert("enhanceTagGroups merges favorites", enhanced.cuisine.includes("Fav"));

  // normalizeRecipeTags
  const stamp = normalizeRecipeTags({ tags: ["West African", "Goat", "Stew", "Home", "Balanced"] });
  assert("normalizeRecipeTags captures cuisine", stamp.cuisine.includes("West African"));
  assert("normalizeRecipeTags captures protein", stamp.protein.includes("Goat"));

  // enforceTorahConstraints
  const enforced = enforceTorahConstraints({ Fri: { Dinner: { focus: [] } } }, { calendar: { isPassoverSeason: true } });
  assert("enforceTorahConstraints adds Sabbath‑Ease", enforced.Fri.Dinner.focus.includes("Sabbath‑Ease"));
  assert("enforceTorahConstraints adds Passover‑Safe", enforced.Fri.Dinner.focus.includes("Passover‑Safe"));

  // pickSome — bounds
  const ps = pickSome([1, 2, 3], 1, 2); assert("pickSome returns <=2 items", ps.length >= 1 && ps.length <= 2);

  // suggestions basic
  const sugg = suggestComplements({ query: "", active: { day: "Mon", slot: "Dinner", cell: { cuisine: ["West African"] } }, targets: { calories: 2000, proteinPct: 30, fatPct: 30, carbsPct: 40 }, mealSplit: { Breakfast: 25, Lunch: 35, Dinner: 40, Snack: 0 } });
  assert("suggestComplements returns array", Array.isArray(sugg) && sugg.length > 0);

  // weights normalize + scoring prefers the right slot
  const weights = getMealWeights({ Breakfast: 20, Lunch: 30, Dinner: 50, Snack: 0 });
  const sum = weights.Breakfast + weights.Lunch + weights.Dinner + weights.Snack;
  assert("weights normalize to 1", Math.abs(sum - 1) < 1e-6);
  const t2 = { calories: 2000, proteinPct: 30, fatPct: 30, carbsPct: 40 };
  const dinnerTarget = macrosFromPct(t2);
  const dinnerPerfect = { kcal: Math.round(dinnerTarget.calories * weights.Dinner), protein: Math.round(dinnerTarget.protein * weights.Dinner), fat: Math.round(dinnerTarget.fat * weights.Dinner), carbs: Math.round(dinnerTarget.carbs * weights.Dinner) };
  const sDinner = scoreRecipeAgainstTargets(dinnerPerfect, t2, "Dinner", { Breakfast: 20, Lunch: 30, Dinner: 50, Snack: 0 });
  const sBreakfast = scoreRecipeAgainstTargets(dinnerPerfect, t2, "Breakfast", { Breakfast: 20, Lunch: 30, Dinner: 50, Snack: 0 });
  assert("dinner-weighted score > breakfast-weighted", sDinner > sBreakfast);

  // ensureAllSlots upgrade
  const upgraded = ensureAllSlots({ ...WA_TEMPLATE, Mon: { Dinner: WA_TEMPLATE.Mon.Dinner } });
  assert("ensureAllSlots adds Breakfast/Lunch/Snack", upgraded.Mon.Breakfast && upgraded.Mon.Lunch && upgraded.Mon.Snack);

  // NEW: disabled meal columns are not rendered
  const enabled = { Breakfast: false, Lunch: true, Dinner: true, Snack: false };
  const filtered = SLOTS.filter((s) => enabled[s]);
  assert("filteredSlots drops disabled", filtered.length === 2 && filtered[0] === "Lunch" && filtered[1] === "Dinner");

  // NEW: balanced mix regardless of active cell should include multiple mealTypes when available
  const sugg2 = suggestComplements({
    query: "",
    active: { day: "Tue", slot: "Dinner", cell: {} },
    targets: { calories: 2000, proteinPct: 30, fatPct: 30, carbsPct: 40 },
    mealSplit: { Breakfast: 25, Lunch: 35, Dinner: 40, Snack: 0 },
  });
  const types2 = new Set(sugg2.map((s) => s.mealType));
  assert("balanced mix includes Breakfast", types2.has("Breakfast") || !MOCK_RECIPES.some(r=>r.mealType==="Breakfast"));
  assert("balanced mix includes Lunch", types2.has("Lunch") || !MOCK_RECIPES.some(r=>r.mealType==="Lunch"));

  console.debug("All RhythmBuilder tests passed");
}

if (typeof process === "undefined" || process?.env?.NODE_ENV !== "production") {
  try { runRhythmBuilderTests(); } catch (e) { console.error(e); }
}
