// src/components/profile/WeeklyFlavorRhythmPicker.jsx
import React, { useEffect, useMemo, useState } from "react";

/* -----------------------------------------------------------------------------
   GOAL
   - Pool-based cuisine selection (weights, variety, exclusions)
   - Minimal friction; clear, tappable chips/buttons
   - Backwards-compatible with any old weekday map coming in
 --------------------------------------------------------------------------- */

/* --------------------------------- Options --------------------------------- */
let suggestFlavorOptions;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ suggestFlavorOptions } = require("@/types/FlavorRhythm.d"));
} catch {
  suggestFlavorOptions = () => [
    "Soul Food",
    "Caribbean",
    "West African",
    "Cajun",
    "Creole",
    "Mediterranean",
    "BBQ",
    "Herb-Garlic",
    "Citrus-Chili",
    "Asian Fusion",
    "Tex-Mex",
    "Nigerian",
    "Ghanaian",
    "Ethiopian",
    "Levantine",
    "Indian",
    "Thai",
    "Korean",
    "Japanese Home",
    "Simple Comfort",
    "Low-Sugar",
    "High-Protein",
    "Garden-Fresh",
    "Pantry-First",
  ];
}

/* -------------------------- Legacy week compatibility ---------------------- */
const CAL_GREGORIAN = "gregorian";
const CAL_HEBREW = "hebrew";
const CAL_CREATION = "creation";
const GREG_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const HEBREW_KEYS = ["yom_rishon", "yom_sheni", "yom_shelishi", "yom_revi_i", "yom_chamishi", "yom_shishi", "shabbat"];
const CREATION_KEYS = ["day_one", "day_two", "day_three", "day_four", "day_five", "day_six", "sabbath"];

const POS = {
  [CAL_GREGORIAN]: GREG_KEYS,
  [CAL_HEBREW]: HEBREW_KEYS,
  [CAL_CREATION]: CREATION_KEYS,
};

function detectCalendar(map = {}) {
  const has = (ks) => ks.some((k) => Array.isArray(map[k]));
  if (has(HEBREW_KEYS)) return CAL_HEBREW;
  if (has(CREATION_KEYS)) return CAL_CREATION;
  if (has(GREG_KEYS)) return CAL_GREGORIAN;
  return null; // not a week map
}

function normalizeWeekShape(map = {}, calendar) {
  const out = {};
  (POS[calendar] || GREG_KEYS).forEach((k) => (out[k] = Array.isArray(map[k]) ? [...map[k]] : []));
  return out;
}

function convertWeekMap(srcMap = {}, srcCal, dstCal) {
  const out = {};
  const srcKeys = POS[srcCal];
  const dstKeys = POS[dstCal];
  for (let i = 0; i < 7; i++) {
    const sk = srcKeys[i];
    const dk = dstKeys[i];
    out[dk] = Array.isArray(srcMap[sk]) ? [...srcMap[sk]] : [];
  }
  return out;
}

/* ---------------------------- Pool helpers -------------------------------- */
function inferPoolFromWeekMap(weekMap = {}) {
  const counts = new Map();
  Object.values(weekMap || {}).forEach((arr) => {
    (arr || []).forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
  });
  const maxCount = Math.max(1, ...Array.from(counts.values()));
  const pool = {};
  counts.forEach((count, key) => {
    const w = Math.ceil((count / maxCount) * 5);
    pool[key] = Math.min(5, Math.max(1, w));
  });
  return pool;
}

/* --------------------------------- Icons ---------------------------------- */
const Plus = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden className="opacity-80">
    <path d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2h6z" fill="currentColor" />
  </svg>
);
const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden className="opacity-80">
    <path d="M20.285 6.709l-11.01 11.01-5.56-5.56 1.414-1.415 4.146 4.146 9.596-9.596z" fill="currentColor" />
  </svg>
);

/* ------------------------------- Small atoms ------------------------------- */
function Hint({ children }) {
  return <span className="text-xs text-[hsl(var(--muted-foreground))]">{children}</span>;
}

/** Chip with variants:
 *  - variant="add"     (pill with + icon; hover/active brand)
 *  - variant="toggle"  (selectable; active brand)
 *  - variant="danger"  (for excluded=true state; red styling)
 */
function Chip({ label, onClick, active = false, variant = "toggle", title }) {
  let base =
    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition select-none " +
    "focus:outline-none focus:ring-2 focus:ring-[hsl(var(--brand))]/40";

  let cls = "";
  let Icon = null;

  if (variant === "add") {
    Icon = Plus;
    cls = active
      ? "bg-[hsl(var(--brand))]/10 border-[hsl(var(--brand))] text-[hsl(var(--brand))] hover:bg-[hsl(var(--brand))]/15"
      : "bg-white border-stone-200 hover:bg-stone-50";
  } else if (variant === "danger") {
    Icon = active ? Check : null;
    cls = active
      ? "bg-red-50 border-red-300 text-red-700"
      : "bg-white border-stone-200 hover:bg-stone-50";
  } else {
    // toggle
    Icon = active ? Check : null;
    cls = active
      ? "bg-[hsl(var(--brand))]/10 border-[hsl(var(--brand))] text-[hsl(var(--brand))]"
      : "bg-white border-stone-200 hover:bg-stone-50";
  }

  return (
    <button
      type="button"
      className={base + " " + cls}
      onClick={onClick}
      title={title || label}
      aria-pressed={active}
    >
      {Icon ? <Icon /> : null}
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

/* ----------------------------- Weight selector ----------------------------- */
function WeightControl({ value = 1, onChange, min = 1, max = 5 }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn subtle !py-1 !px-2"
        onClick={() => onChange(Math.max(min, (value || min) - 1))}
        aria-label="Decrease"
        title="Decrease"
      >
        −
      </button>
      <input
        className="control !py-1 !px-2 w-16 text-center tabular-nums"
        type="number"
        min={min}
        max={max}
        value={value ?? min}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        aria-label="Weight"
        title="Weight"
      />
      <button
        type="button"
        className="btn subtle !py-1 !px-2"
        onClick={() => onChange(Math.min(max, (value || min) + 1))}
        aria-label="Increase"
        title="Increase"
      >
        +
      </button>
      <Hint>priority</Hint>
    </div>
  );
}

/* -----------------------------------------------------------------------------
   Main Component (pool-first)
   --------------------------------------------------------------------------- */
export default function WeeklyFlavorRhythmPicker({
  value,
  onChange,
  options,
  layout = "pool",
  showAgentButtons = true,
  allowCustom = true,
}) {
  // options
  const allOptions = useMemo(() => {
    try {
      const dyn = suggestFlavorOptions?.({}) || [];
      const base = Array.isArray(options) && options.length ? options : dyn;
      return Array.from(new Set(base)).sort((a, b) => a.localeCompare(b));
    } catch {
      const base = Array.isArray(options) && options.length ? options : suggestFlavorOptions();
      return Array.from(new Set(base)).sort((a, b) => a.localeCompare(b));
    }
  }, [options]);

  // detect/normalize incoming
  const detectedCal = useMemo(() => detectCalendar(value), [value]);
  const initialPool = useMemo(() => {
    if (detectedCal) {
      const weekNorm = normalizeWeekShape(value, detectedCal);
      return { pool: inferPoolFromWeekMap(weekNorm), varietyPerWeek: 5, exclusions: [], notes: "" };
    }
    if (value && typeof value === "object" && ("pool" in value || "varietyPerWeek" in value)) {
      return {
        pool: { ...(value.pool || {}) },
        varietyPerWeek: value.varietyPerWeek ?? 5,
        exclusions: Array.isArray(value.exclusions) ? value.exclusions : [],
        notes: value.notes || "",
      };
    }
    return { pool: {}, varietyPerWeek: 5, exclusions: [], notes: "" };
  }, [value, detectedCal]);

  // local state
  const [pool, setPool] = useState(initialPool.pool);
  const [variety, setVariety] = useState(initialPool.varietyPerWeek || 5);
  const [exclusions, setExclusions] = useState(initialPool.exclusions || []);
  const [notes, setNotes] = useState(initialPool.notes || "");
  const [customAdd, setCustomAdd] = useState("");

  useEffect(() => {
    setPool(initialPool.pool);
    setVariety(initialPool.varietyPerWeek || 5);
    setExclusions(initialPool.exclusions || []);
    setNotes(initialPool.notes || "");
  }, [initialPool.pool, initialPool.varietyPerWeek, initialPool.exclusions, initialPool.notes]);

  const emit = (next = { pool, varietyPerWeek: variety, exclusions, notes }) => {
    const out = {
      pool: { ...next.pool },
      varietyPerWeek: next.varietyPerWeek ?? variety,
      exclusions: Array.isArray(next.exclusions) ? next.exclusions : exclusions,
      notes: next.notes ?? notes,
    };
    onChange?.(out);
    window.dispatchEvent(new CustomEvent("agents:flavor_profile_changed", { detail: out }));
  };

  const isSelected = (name) => (pool || {})[name] != null;
  const toggleCuisine = (name) => {
    const next = { ...pool };
    if (isSelected(name)) delete next[name];
    else next[name] = 3;
    setPool(next);
    emit({ pool: next, varietyPerWeek: variety, exclusions, notes });
  };
  const setWeight = (name, w) => {
    const next = { ...pool, [name]: Math.min(5, Math.max(1, w || 1)) };
    setPool(next);
    emit({ pool: next, varietyPerWeek: variety, exclusions, notes });
  };
  const addCustom = () => {
    const v = (customAdd || "").trim();
    if (!v) return;
    if (!allowCustom && !allOptions.includes(v)) return;
    const next = { ...pool, [v]: pool?.[v] ?? 3 };
    setPool(next);
    setCustomAdd("");
    emit({ pool: next, varietyPerWeek: variety, exclusions, notes });
  };

  const toggleExclusion = (name) => {
    const set = new Set(exclusions || []);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    const next = Array.from(set);
    setExclusions(next);
    emit({ pool, varietyPerWeek: variety, exclusions: next, notes });
  };

  /* ------------------------------- UI: Pool -------------------------------- */
  const PoolView = () => {
    const selectedList = Object.keys(pool || {}).sort((a, b) => a.localeCompare(b));
    const available = allOptions.filter((o) => !selectedList.includes(o) && !(exclusions || []).includes(o));

    return (
      <div className="w-full">
        {/* Header controls */}
        <div className="rounded-2xl border bg-white p-3 mb-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold">Target weekly variety</div>
              <div className="flex items-center gap-2">
                <input
                  className="control w-20 text-center tabular-nums"
                  type="number"
                  min={1}
                  max={14}
                  value={variety}
                  onChange={(e) => {
                    const n = Math.min(14, Math.max(1, Number(e.target.value) || 1));
                    setVariety(n);
                    emit({ pool, varietyPerWeek: n, exclusions, notes });
                  }}
                  aria-label="Variety per week"
                  title="How many distinct cuisines to include each week"
                />
                <Hint>distinct cuisines / week</Hint>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold">Exclusions</div>
              <div className="flex flex-wrap gap-1.5">
                {(exclusions || []).length ? (
                  exclusions.map((x) => (
                    <span key={`ex-${x}`} className="chip">
                      {x}
                      <button
                        className="x"
                        title="Remove exclusion"
                        onClick={() => toggleExclusion(x)}
                        aria-label={`Remove ${x}`}
                      >
                        ×
                      </button>
                    </span>
                  ))
                ) : (
                  <Hint>none</Hint>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold">Notes</div>
              <input
                className="control"
                placeholder="Any preferences, spice levels, proteins…"
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  emit({ pool, varietyPerWeek: variety, exclusions, notes: e.target.value });
                }}
              />
            </div>
          </div>
        </div>

        {/* Selected cuisines with weights */}
        <div className="rounded-2xl border bg-white p-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">Selected cuisines</div>
            <Hint>Set a higher weight to see it more often</Hint>
          </div>
          {selectedList.length === 0 ? (
            <Hint>No cuisines chosen yet — pick from the list below or add a custom one.</Hint>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {selectedList.map((name) => (
                <div key={`sel-${name}`} className="rounded-xl border p-3 shadow-sm ring-1 ring-black/5 bg-white">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold">{name}</div>
                    <button
                      type="button"
                      className="btn subtle danger !py-1 !px-2"
                      onClick={() => toggleCuisine(name)}
                      title="Remove"
                      aria-label={`Remove ${name}`}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="mt-2">
                    <WeightControl value={pool[name] ?? 3} onChange={(w) => setWeight(name, w)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Available + custom */}
        <div className="rounded-2xl border bg-white p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">Add cuisines</div>
            <div className="flex items-center gap-2">
              <input
                className="control text-sm"
                placeholder="Add custom cuisine…"
                value={customAdd}
                onChange={(e) => setCustomAdd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
              />
              <button type="button" className="btn subtle" onClick={addCustom} title="Add custom">
                Add
              </button>
            </div>
          </div>

          {/* AVAILABLE (Add) */}
          <div className="flex flex-wrap gap-2 mb-3">
            {available.length ? (
              available.map((opt) => (
                <Chip
                  key={`opt-${opt}`}
                  label={opt}
                  variant="add"
                  active={false}
                  onClick={() => toggleCuisine(opt)}
                  title={`Add ${opt}`}
                />
              ))
            ) : (
              <Hint>All options are selected or excluded.</Hint>
            )}
          </div>

          {/* EXCLUDE (toggle; red when active) */}
          {(available.length || selectedList.length) && (
            <div className="mt-3">
              <div className="font-semibold mb-1">Exclude cuisines</div>
              <div className="flex flex-wrap gap-2">
                {allOptions.map((opt) => (
                  <Chip
                    key={`exopt-${opt}`}
                    label={opt}
                    variant={(exclusions || []).includes(opt) ? "danger" : "danger"}
                    active={(exclusions || []).includes(opt)}
                    onClick={() => toggleExclusion(opt)}
                    title={`Toggle exclude ${opt}`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Agent actions */}
        {showAgentButtons && (
          <div className="flex flex-wrap items-center justify-end gap-2 mt-3">
            <button
              type="button"
              className="btn primary"
              title="Ask agents to populate meals from these cuisines"
              onClick={() => {
                const detail = { pool, varietyPerWeek: variety, exclusions, notes, intent: "populate-meals" };
                window.dispatchEvent(new CustomEvent("agents:flavor_profile_changed", { detail }));
              }}
            >
              Let AI Agents add meals
            </button>
            <button
              type="button"
              className="btn subtle"
              title="Signal agents to update pantry & shopping suggestions"
              onClick={() => {
                const detail = { pool, varietyPerWeek: variety, exclusions, notes, intent: "update-pantry" };
                window.dispatchEvent(new CustomEvent("agents:flavor_profile_changed", { detail }));
              }}
            >
              Update pantry targets
            </button>
          </div>
        )}
      </div>
    );
  };

  /* ------------------------------ Legacy Week ------------------------------ */
  // We still honour layout="week" (used rarely now)
  const WeekView = () => {
    const [applyFrom, setApplyFrom] = useState(GREG_KEYS[0]);
    const [weekMap, setWeekMap] = useState(() => {
      if (detectedCal) return convertWeekMap(normalizeWeekShape(value, detectedCal), detectedCal, CAL_GREGORIAN);
      return GREG_KEYS.reduce((acc, k) => ((acc[k] = []), acc), {});
    });
    const flavorOptions = allOptions;

    const setDayValues = (dayKey, vals) => {
      const next = { ...weekMap, [dayKey]: Array.from(new Set(vals || [])) };
      setWeekMap(next);
      const poolFromWeek = inferPoolFromWeekMap(next);
      emit({ pool: poolFromWeek, varietyPerWeek: variety, exclusions, notes });
    };
    const copyFromDay = (srcKey, targets) => {
      const srcVals = Array.isArray(weekMap[srcKey]) ? weekMap[srcKey] : [];
      const next = { ...weekMap };
      targets.forEach((k) => (next[k] = [...srcVals]));
      setWeekMap(next);
      const poolFromWeek = inferPoolFromWeekMap(next);
      emit({ pool: poolFromWeek, varietyPerWeek: variety, exclusions, notes });
    };
    const applyToAll = () => copyFromDay(applyFrom, GREG_KEYS);
    const applyToWeekdays = () => copyFromDay(applyFrom, GREG_KEYS.slice(0, 5));
    const applyToWeekend = () => copyFromDay(applyFrom, GREG_KEYS.slice(5));
    const clearAll = () => {
      const blank = GREG_KEYS.reduce((acc, k) => ((acc[k] = []), acc), {});
      setWeekMap(blank);
      emit({ pool: {}, varietyPerWeek: variety, exclusions, notes });
    };

    function DayColumn({ k }) {
      const [custom, setCustom] = useState("");
      const vals = weekMap[k] || [];
      const toggle = (opt) => {
        const exists = vals.includes(opt);
        setDayValues(k, exists ? vals.filter((v) => v !== opt) : [...vals, opt]);
      };
      const addCustom = () => {
        const v = (custom || "").trim();
        if (!v) return;
        if (!allowCustom && !flavorOptions.includes(v)) return;
        if (!vals.includes(v)) setDayValues(k, [...vals, v]);
        setCustom("");
      };
      const pretty = (s) => s[0].toUpperCase() + s.slice(1);
      return (
        <div className="rounded-xl border p-3 bg-white shadow-sm ring-1 ring-black/5">
          <div className="text-sm font-semibold mb-2">{pretty(k)}</div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {flavorOptions.map((opt) => (
              <Chip
                key={`${k}-${opt}`}
                label={opt}
                active={vals.includes(opt)}
                onClick={() => toggle(opt)}
                title={vals.includes(opt) ? "Remove" : "Add"}
              />
            ))}
          </div>
          {allowCustom && (
            <div className="flex items-center gap-2">
              <input
                className="control text-xs"
                placeholder="Add custom…"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
              />
              <button type="button" className="btn subtle text-xs" onClick={addCustom}>
                Add
              </button>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="w-full">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[hsl(var(--muted-foreground))]">Copy flavors from</span>
            <select
              className="control control--select !py-1 !px-2"
              value={applyFrom}
              onChange={(e) => setApplyFrom(e.target.value)}
            >
              {GREG_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k[0].toUpperCase() + k.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn subtle" onClick={applyToAll}>
              Apply to all days
            </button>
            <button type="button" className="btn subtle" onClick={applyToWeekdays}>
              Apply to weekdays
            </button>
            <button type="button" className="btn subtle" onClick={applyToWeekend}>
              Apply to weekend
            </button>
            <button type="button" className="btn subtle danger" onClick={clearAll}>
              Clear all
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-7 gap-3">
          {GREG_KEYS.map((k) => (
            <DayColumn key={k} k={k} />
          ))}
        </div>
      </div>
    );
  };

  /* ---------------------------------- Render -------------------------------- */
  return layout === "week" ? <WeekView /> : <PoolView />;
}
