// src/components/meals/decider/DeciderFiltersBar.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try { Icons = require("lucide-react"); } catch {}

let eventBus = null;
try { eventBus = require("@/services/eventBus").eventBus || null; } catch {}

let automation = null;
try { automation = require("@/services/automation/runtime").automation || null; } catch {}

let useMealPlanStore = () => null;
try {
  // optional selector (if you have it)
  const mod = require("@/store/MealPlanStore");
  useMealPlanStore = mod.useMealPlanStore || useMealPlanStore;
} catch {}

let TaggingPanel = null;
try {
  TaggingPanel = require("../collector/TaggingPanel.jsx").default || null;
} catch {}

/* --------------------------------- Utilities --------------------------------- */
const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, Number.isFinite(n) ? n : a));
const toInt = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const debounce = (fn, ms = 300) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};
const uniq = (arr) => Array.from(new Set(arr || []));

const DEFAULTS = {
  query: "",
  timeframe: "week", // week | two_weeks | month | custom
  rangeDays: 7,
  mealSlots: ["breakfast", "lunch", "dinner"], // user-selectable
  diet: [], // e.g., ["dairy-free","gluten-free","no-pork"]
  macros: { kcalMin: 0, kcalMax: 1200, proteinMin: 0, proteinMax: 120, carbsMin: 0, carbsMax: 200, fatMin: 0, fatMax: 80 },
  budget: { maxPerMeal: 999, mode: "any" }, // any | under | target
  inventory: { minMatchPct: 0, pantryFirst: false },
  calendar: { sabbathGuard: true, feastDayOnly: false, busyDayOnly: false },
  tags: [],
  sort: { by: "score", dir: "desc" }, // score | time | cost | protein | carbs | fat | inventory | calories
};

const PRESETS = [
  {
    id: "pantry-first",
    label: "Use Pantry First",
    hint: "High inventory match, low cost",
    apply: (f) => ({
      ...f,
      inventory: { ...f.inventory, minMatchPct: 60, pantryFirst: true },
      budget: { ...f.budget, mode: "under", maxPerMeal: Math.min(f.budget.maxPerMeal || 999, 6) },
      sort: { by: "inventory", dir: "desc" },
    }),
  },
  {
    id: "budget-saver",
    label: "Budget Saver",
    hint: "Keep per-meal spend low",
    apply: (f) => ({
      ...f,
      budget: { mode: "under", maxPerMeal: 5 },
      inventory: { ...f.inventory, minMatchPct: 40, pantryFirst: true },
      sort: { by: "cost", dir: "asc" },
    }),
  },
  {
    id: "high-protein",
    label: "High Protein",
    hint: "Prioritize protein",
    apply: (f) => ({
      ...f,
      macros: { ...f.macros, proteinMin: 30, proteinMax: 120 },
      sort: { by: "protein", dir: "desc" },
      tags: uniq([...(f.tags || []), "high-protein"]),
    }),
  },
  {
    id: "sabbath-simple",
    label: "Sabbath Simple",
    hint: "Fast prep / reheat only",
    apply: (f) => ({
      ...f,
      calendar: { ...f.calendar, sabbathGuard: true, busyDayOnly: true },
      tags: uniq([...(f.tags || []), "quick", "make-ahead", "reheat"]),
      sort: { by: "time", dir: "asc" },
    }),
  },
  {
    id: "feast-day-menu",
    label: "Feast Day Menu",
    hint: "Show feast-day aligned dishes",
    apply: (f) => ({
      ...f,
      calendar: { ...f.calendar, feastDayOnly: true, sabbathGuard: true },
      tags: uniq([...(f.tags || []), "feast-day"]),
      sort: { by: "score", dir: "desc" },
    }),
  },
];

/* ------------------------------ Local persistence ---------------------------- */
const STATE_KEY = (householdId = "default") => `decider.filters.v1.${householdId}`;

const loadState = (householdId) => {
  try {
    const str = localStorage.getItem(STATE_KEY(householdId));
    if (!str) return null;
    const parsed = JSON.parse(str);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return null;
  }
};

const saveState = (householdId, state) => {
  try {
    localStorage.setItem(STATE_KEY(householdId), JSON.stringify(state));
  } catch {}
};

/* ------------------------------- Main component ------------------------------ */
/**
 * DeciderFiltersBar
 *
 * Props:
 * - value?: object (controlled). If omitted, uses internal state with persistence.
 * - onChange?: (filters) => void    // debounced emit (300ms)
 * - onApply?: (filters) => void     // fire immediately when pressing "Apply"
 * - compact?: boolean               // tighter spacing
 * - householdId?: string            // persistence scope
 * - showTags?: boolean              // toggle tag panel visualization
 */
const DeciderFiltersBar = ({
  value,
  onChange,
  onApply,
  compact = false,
  householdId = "default",
  showTags = true,
}) => {
  const store = useMealPlanStore ? useMealPlanStore() : null;
  const initial = useMemo(() => value || loadState(householdId) || DEFAULTS, [value, householdId]);
  const [filters, setFilters] = useState(initial);
  const [expanded, setExpanded] = useState(false);

  const debouncedEmit = useMemo(
    () =>
      debounce((next) => {
        try {
          eventBus?.emit?.("meals.decider.filters.changed", { filters: next, ts: Date.now() });
          automation?.runTemplate?.("meals.decider.filters.changed", { filters: next });
        } catch {}
        onChange?.(next);
      }, 300),
    [onChange]
  );

  // Sync local persistence (only when uncontrolled)
  useEffect(() => {
    if (value) return; // controlled
    saveState(householdId, filters);
  }, [filters, value, householdId]);

  // External value updates (controlled mode)
  useEffect(() => {
    if (value) setFilters({ ...DEFAULTS, ...value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value || {})]);

  // Emit debounced updates
  useEffect(() => {
    debouncedEmit(filters);
  }, [filters, debouncedEmit]);

  /* --------------------------------- Handlers --------------------------------- */
  const patch = (path, v) => {
    setFilters((prev) => {
      const next = structuredClone ? structuredClone(prev) : JSON.parse(JSON.stringify(prev));
      // tiny path setter
      const parts = path.split(".");
      let cur = next;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
      cur[parts[parts.length - 1]] = v;
      return next;
    });
  };

  const applyPreset = (p) => {
    const preset = PRESETS.find((x) => x.id === p);
    if (!preset) return;
    const next = preset.apply(filters);
    setFilters(next);
    onApply?.(next);
    try {
      eventBus?.emit?.("meals.decider.filters.preset", { id: p, filters: next });
    } catch {}
  };

  const applyNow = () => {
    onApply?.(filters);
    try {
      eventBus?.emit?.("meals.decider.filters.applied", { filters, ts: Date.now() });
    } catch {}
  };

  /* ---------------------------------- Icons ---------------------------------- */
  const {
    Filter = () => null,
    Search = () => null,
    ChevronDown = () => null,
    Clock = () => null,
    ChefHat = () => null,
    ShieldCheck = () => null,
    CalendarDays = () => null,
    Tag = () => null,
    DollarSign = () => null,
    Package = () => null,
    Gauge = () => null,
    Layers = () => null,
    Sparkles = () => null,
  } = Icons;

  /* ---------------------------------- UI bits --------------------------------- */
  const PresetButton = ({ id, label, hint }) => (
    <button
      type="button"
      className="px-2.5 py-1.5 rounded-full border text-xs hover:bg-gray-50"
      onClick={() => applyPreset(id)}
      title={hint}
    >
      {label}
    </button>
  );

  const Section = ({ title, icon: Ico, children }) => (
    <div className="rounded-xl border p-3">
      <div className="flex items-center gap-2 mb-2">
        {Ico ? <Ico className="w-4 h-4 opacity-80" /> : null}
        <div className="font-medium">{title}</div>
      </div>
      {children}
    </div>
  );

  const Labeled = ({ label, children }) => (
    <label className="text-xs text-gray-600 flex flex-col gap-1">
      <span>{label}</span>
      {children}
    </label>
  );

  /* ---------------------------------- Render ---------------------------------- */
  return (
    <div className={`rounded-2xl border ${compact ? "p-3" : "p-4"} bg-white/80 backdrop-blur`}>
      {/* Top row: search + quick selectors */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border flex-1 min-w-[220px]">
          <Search className="w-4 h-4 opacity-70" />
          <input
            className="w-full text-sm outline-none"
            placeholder="Search meals, ingredients, tags…"
            value={filters.query}
            onChange={(e) => patch("query", e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2 px-3 py-2 rounded-md border">
          <Clock className="w-4 h-4 opacity-70" />
          <select
            className="text-sm outline-none bg-transparent"
            value={filters.timeframe}
            onChange={(e) => {
              const tf = e.target.value;
              patch("timeframe", tf);
              patch("rangeDays", tf === "week" ? 7 : tf === "two_weeks" ? 14 : tf === "month" ? 30 : filters.rangeDays);
            }}
          >
            <option value="week">Week (7)</option>
            <option value="two_weeks">2 Weeks (14)</option>
            <option value="month">Month (30)</option>
            <option value="custom">Custom…</option>
          </select>
          {filters.timeframe === "custom" ? (
            <input
              type="number"
              min={1}
              className="w-16 text-sm border rounded px-2 py-1 ml-2"
              value={filters.rangeDays}
              onChange={(e) => patch("rangeDays", clamp(toInt(e.target.value, 7), 1, 90))}
              title="Number of days"
            />
          ) : null}
        </div>

        <button
          type="button"
          className="inline-flex items-center gap-2 px-3 py-2 rounded-md border hover:bg-gray-50"
          onClick={() => setExpanded((s) => !s)}
          aria-expanded={expanded}
          title="More filters"
        >
          <Filter className="w-4 h-4" />
          Filters
          <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>

        <button
          type="button"
          className="inline-flex items-center gap-2 px-3 py-2 rounded-md border hover:bg-gray-50"
          onClick={applyNow}
          title="Apply filters"
        >
          <Sparkles className="w-4 h-4" />
          Apply
        </button>
      </div>

      {/* Presets */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <PresetButton key={p.id} id={p.id} label={p.label} hint={p.hint} />
        ))}
      </div>

      {/* Expanded filter grid */}
      {expanded ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mt-3">
          {/* Meal slots & diet */}
          <Section title="Meal & Diet" icon={ChefHat}>
            <div className="flex flex-wrap gap-2">
              {["breakfast", "lunch", "dinner", "snack"].map((slot) => {
                const active = filters.mealSlots.includes(slot);
                return (
                  <button
                    key={slot}
                    type="button"
                    className={`px-2.5 py-1.5 rounded-full border text-xs ${active ? "bg-gray-900 text-white border-gray-900" : "hover:bg-gray-50"}`}
                    onClick={() => {
                      const set = new Set(filters.mealSlots);
                      active ? set.delete(slot) : set.add(slot);
                      patch("mealSlots", Array.from(set));
                    }}
                  >
                    {slot}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              {[
                "dairy-free",
                "gluten-free",
                "no-pork",
                "no-shellfish",
                "low-sugar",
                "low-sodium",
                "keto-ish",
                "vegetarian",
              ].map((d) => {
                const active = filters.diet.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    className={`px-2 py-1.5 rounded-full border text-[11px] ${active ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "hover:bg-gray-50"}`}
                    onClick={() => {
                      const set = new Set(filters.diet);
                      active ? set.delete(d) : set.add(d);
                      patch("diet", Array.from(set));
                    }}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Inventory */}
          <Section title="Inventory" icon={Package}>
            <div className="flex items-center gap-3">
              <Labeled label="Min. on-hand match (%)">
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="w-20 border rounded px-2 py-1 text-sm"
                  value={filters.inventory.minMatchPct}
                  onChange={(e) => patch("inventory.minMatchPct", clamp(toInt(e.target.value, 0), 0, 100))}
                />
              </Labeled>
              <Labeled label="Pantry first">
                <input
                  type="checkbox"
                  className="w-4 h-4"
                  checked={!!filters.inventory.pantryFirst}
                  onChange={(e) => patch("inventory.pantryFirst", !!e.target.checked)}
                />
              </Labeled>
            </div>
          </Section>

          {/* Budget */}
          <Section title="Budget" icon={DollarSign}>
            <div className="flex items-center gap-3">
              <Labeled label="Mode">
                <select
                  className="border rounded px-2 py-1 text-sm"
                  value={filters.budget.mode}
                  onChange={(e) => patch("budget.mode", e.target.value)}
                >
                  <option value="any">Any</option>
                  <option value="under">Under max</option>
                  <option value="target">Targeted</option>
                </select>
              </Labeled>
              <Labeled label="Max per meal ($)">
                <input
                  type="number"
                  min={0}
                  className="w-24 border rounded px-2 py-1 text-sm"
                  value={filters.budget.maxPerMeal}
                  onChange={(e) => patch("budget.maxPerMeal", Math.max(0, toInt(e.target.value, 0)))}
                />
              </Labeled>
            </div>
          </Section>

          {/* Macros */}
          <Section title="Macros" icon={Gauge}>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <Labeled label="Calories min">
                <input
                  type="number"
                  className="border rounded px-2 py-1"
                  value={filters.macros.kcalMin}
                  onChange={(e) => patch("macros.kcalMin", Math.max(0, toInt(e.target.value, 0)))}
                />
              </Labeled>
              <Labeled label="Calories max">
                <input
                  type="number"
                  className="border rounded px-2 py-1"
                  value={filters.macros.kcalMax}
                  onChange={(e) => patch("macros.kcalMax", Math.max(filters.macros.kcalMin, toInt(e.target.value, 1200)))}
                />
              </Labeled>
              <Labeled label="Protein min (g)">
                <input
                  type="number"
                  className="border rounded px-2 py-1"
                  value={filters.macros.proteinMin}
                  onChange={(e) => patch("macros.proteinMin", Math.max(0, toInt(e.target.value, 0)))}
                />
              </Labeled>
              <Labeled label="Protein max (g)">
                <input
                  type="number"
                  className="border rounded px-2 py-1"
                  value={filters.macros.proteinMax}
                  onChange={(e) => patch("macros.proteinMax", Math.max(filters.macros.proteinMin, toInt(e.target.value, 120)))}
                />
              </Labeled>
              <Labeled label="Carbs max (g)">
                <input
                  type="number"
                  className="border rounded px-2 py-1"
                  value={filters.macros.carbsMax}
                  onChange={(e) => patch("macros.carbsMax", Math.max(filters.macros.carbsMin, toInt(e.target.value, 200)))}
                />
              </Labeled>
              <Labeled label="Fat max (g)">
                <input
                  type="number"
                  className="border rounded px-2 py-1"
                  value={filters.macros.fatMax}
                  onChange={(e) => patch("macros.fatMax", Math.max(filters.macros.fatMin, toInt(e.target.value, 80)))}
                />
              </Labeled>
            </div>
          </Section>

          {/* Calendar (Sabbath & Feast Day aware) */}
          <Section title="Calendar" icon={CalendarDays}>
            <div className="grid grid-cols-2 gap-2">
              <Labeled label="Sabbath Guard (respect rest window)">
                <input
                  type="checkbox"
                  className="w-4 h-4"
                  checked={!!filters.calendar.sabbathGuard}
                  onChange={(e) => patch("calendar.sabbathGuard", !!e.target.checked)}
                />
              </Labeled>
              <Labeled label="Feast day only">
                <input
                  type="checkbox"
                  className="w-4 h-4"
                  checked={!!filters.calendar.feastDayOnly}
                  onChange={(e) => patch("calendar.feastDayOnly", !!e.target.checked)}
                />
              </Labeled>
              <Labeled label="Busy-day simple meals">
                <input
                  type="checkbox"
                  className="w-4 h-4"
                  checked={!!filters.calendar.busyDayOnly}
                  onChange={(e) => patch("calendar.busyDayOnly", !!e.target.checked)}
                />
              </Labeled>
              <div className="text-[11px] text-gray-600">
                If your Israelite calendar is configured to start months at the <em>full moon</em>, feast day matching will follow that.
              </div>
            </div>
          </Section>

          {/* Tags */}
          {showTags ? (
            <Section title="Tags" icon={Tag}>
              {TaggingPanel ? (
                <TaggingPanel value={filters.tags} onChange={(v) => patch("tags", v)} compact />
              ) : (
                <input
                  className="w-full border rounded px-2 py-2 text-sm"
                  placeholder="Comma-separated tags"
                  value={(filters.tags || []).join(", ")}
                  onChange={(e) =>
                    patch(
                      "tags",
                      e.target.value
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean)
                    )
                  }
                />
              )}
            </Section>
          ) : null}

          {/* Sort */}
          <Section title="Sort" icon={Layers}>
            <div className="flex items-center gap-3">
              <Labeled label="By">
                <select
                  className="border rounded px-2 py-1 text-sm"
                  value={filters.sort.by}
                  onChange={(e) => patch("sort.by", e.target.value)}
                >
                  <option value="score">Overall score</option>
                  <option value="time">Cook time</option>
                  <option value="cost">Cost</option>
                  <option value="protein">Protein</option>
                  <option value="carbs">Carbs</option>
                  <option value="fat">Fat</option>
                  <option value="inventory">Inventory fit</option>
                  <option value="calories">Calories</option>
                </select>
              </Labeled>
              <Labeled label="Direction">
                <select
                  className="border rounded px-2 py-1 text-sm"
                  value={filters.sort.dir}
                  onChange={(e) => patch("sort.dir", e.target.value)}
                >
                  <option value="desc">Desc</option>
                  <option value="asc">Asc</option>
                </select>
              </Labeled>
            </div>
          </Section>
        </div>
      ) : null}
    </div>
  );
};

export default DeciderFiltersBar;
