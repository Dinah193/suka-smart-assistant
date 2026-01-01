/* eslint-disable no-console */
// src/components/decider/DeciderFiltersBar.jsx
// Context-aware Filters Bar for Decider screens
// - Modes: "meals" | "cleaning" | "garden" | "animal"
// - Cleaning variant adds Zone + Frequency (reusable in other modules)
// - Defensive against missing services (eventBus, analytics, storage)
// - Presets with localStorage (safe), optional URL sync
// - Emits "decider:filters:apply" on apply (if eventBus present) + onChange callback
// - Debounced search, active chips, reset, compact mode

import React, { useEffect, useMemo, useRef, useState } from "react";

/** Lightweight classNames helper */
function cx(...args) {
  return args.filter(Boolean).join(" ");
}

/** Debounce hook */
function useDebouncedValue(value, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return v;
}

/** Safe storage wrapper */
const store = {
  get(key, fallback = null) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  },
};

/** Default option catalogs (can be overridden via props) */
const DEFAULTS = {
  meals: {
    effort: ["Very Easy", "Easy", "Moderate", "Advanced"],
    time: ["<15m", "15–30m", "30–60m", "60–90m", "90m+"],
    appliance: ["Stovetop", "Oven", "Air Fryer", "Slow Cooker", "Pressure Cooker", "Grill"],
    course: ["Breakfast", "Lunch", "Dinner", "Snack", "Dessert"],
    diet: ["Paleo", "Keto", "Low-Carb", "Gluten-Free", "Dairy-Free", "Halal", "Kosher"],
    season: ["Spring", "Summer", "Autumn", "Winter"],
  },
  cleaning: {
    // Per your system: zones are user-editable via props; these are sensible defaults
    zones: ["Kitchen", "Bathrooms", "Bedrooms", "Living Areas", "Entryway", "Laundry", "Office", "Outdoors"],
    frequency: ["Daily", "Weekly", "Biweekly", "Monthly", "Quarterly", "Seasonal", "Annual", "As-Needed"],
    intensity: ["Tidy", "Light Clean", "Standard", "Deep Clean", "Reset"],
    duration: ["<10m", "10–20m", "20–40m", "40–60m", "60m+"],
  },
  garden: {
    season: ["Spring", "Summer", "Autumn", "Winter"],
    action: ["Plan", "Sow", "Transplant", "Irrigate", "Fertilize", "Weed", "Harvest", "Preserve", "Closeout"],
    bed: ["Raised A", "Raised B", "Row 1", "Row 2", "Greenhouse"],
  },
  animal: {
    kind: ["Poultry", "Sheep", "Goat", "Beef", "Rabbit", "Fish"],
    action: ["Feed", "Water", "Deworm", "Vaccinate", "Clean", "Inspect", "Butcher", "Package"],
    flags: ["Raw-Meat", "Cold-Chain", "Biohazard", "PPE"],
  },
};

/** URL helpers (optional sync) */
function readQueryParams() {
  try {
    const sp = new URLSearchParams(window.location.search);
    return Object.fromEntries(sp.entries());
  } catch {
    return {};
  }
}
function writeQueryParams(params) {
  try {
    const url = new URL(window.location.href);
    const sp = new URLSearchParams(url.search);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) sp.delete(k);
      else sp.set(k, Array.isArray(v) ? v.join(",") : String(v));
    });
    url.search = sp.toString();
    window.history.replaceState({}, "", url.toString());
  } catch {}
}

/** Active chip pill */
function Chip({ label, onRemove }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm hover:bg-gray-50"
      aria-label={`Remove filter ${label}`}
      title="Remove filter"
    >
      <span>{label}</span>
      <span className="text-gray-500">×</span>
    </button>
  );
}

/** Toggle (for compact UI etc.) */
function Toggle({ checked, onChange, label, id }) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-2 cursor-pointer select-none">
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4 accent-black"
        checked={!!checked}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="text-sm">{label}</span>
    </label>
  );
}

/** Multiselect control */
function MultiSelect({ value = [], options = [], placeholder = "Select…", onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => {
      if (!ref.current || ref.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const toggle = (opt) => {
    const exists = value.includes(opt);
    const next = exists ? value.filter((v) => v !== opt) : [...value, opt];
    onChange?.(next);
  };
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="w-full rounded-lg border px-3 py-2 text-left text-sm hover:bg-gray-50"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {value.length ? `${value.length} selected` : placeholder}
      </button>
      {open && (
        <ul
          className="absolute z-10 mt-2 max-h-56 w-64 overflow-auto rounded-lg border bg-white p-2 shadow"
          role="listbox"
          tabIndex={-1}
        >
          {options.map((opt) => (
            <li key={opt} className="flex items-center gap-2 px-2 py-1">
              <input
                id={`ms-${opt}`}
                type="checkbox"
                className="h-4 w-4 accent-black"
                checked={value.includes(opt)}
                onChange={() => toggle(opt)}
              />
              <label htmlFor={`ms-${opt}`} className="text-sm cursor-pointer">
                {opt}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** SingleSelect (native) */
function SingleSelect({ value = "", options = [], placeholder = "Any", onChange }) {
  return (
    <select
      className="w-full rounded-lg border px-3 py-2 text-sm"
      value={value || ""}
      onChange={(e) => onChange?.(e.target.value || "")}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/** Text input */
function Input({ value, onChange, placeholder = "Search…" }) {
  return (
    <input
      type="text"
      className="w-full rounded-lg border px-3 py-2 text-sm"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}

/**
 * DeciderFiltersBar
 * Props:
 * - mode: "meals" | "cleaning" | "garden" | "animal"
 * - initialFilters: object
 * - onChange: (filters) => void
 * - syncToURL?: boolean (default true)
 * - catalogs?: partial override of DEFAULTS per mode
 * - zones?: string[] (override cleaning zones)
 * - className?: string
 * - compactDefault?: boolean
 */
export default function DeciderFiltersBar({
  mode = "meals",
  initialFilters = {},
  onChange,
  syncToURL = true,
  catalogs = {},
  zones,
  className,
  compactDefault = false,
}) {
  const mergedCatalogs = useMemo(() => {
    const base = { ...DEFAULTS[mode] };
    if (mode === "cleaning" && Array.isArray(zones) && zones.length) {
      base.zones = zones;
    }
    return { ...base, ...(catalogs || {}) };
  }, [mode, catalogs, zones]);

  // Parse URL on mount if enabled
  const queryAtMount = useMemo(() => (syncToURL ? readQueryParams() : {}), [syncToURL]);

  // Filters state
  const [filters, setFilters] = useState(() => {
    const fromURL = {};
    if (syncToURL) {
      // decode arrays encoded as comma strings
      const tryList = (k) => {
        const raw = queryAtMount[k];
        if (!raw) return undefined;
        return String(raw).split(",").filter(Boolean);
      };
      // Common keys
      fromURL.q = queryAtMount.q || undefined;
      fromURL.effort = tryList("effort");
      fromURL.time = tryList("time");
      fromURL.appliance = tryList("appliance");
      fromURL.course = tryList("course");
      fromURL.diet = tryList("diet");
      fromURL.season = tryList("season");
      // Cleaning keys
      fromURL.zones = tryList("zones");
      fromURL.frequency = tryList("frequency");
      fromURL.intensity = tryList("intensity");
      fromURL.duration = tryList("duration");
      // Garden
      fromURL.action = tryList("action");
      fromURL.bed = tryList("bed");
      // Animal
      fromURL.kind = tryList("kind");
      fromURL.aflag = tryList("aflag");
    }
    return { ...initialFilters, ...fromURL };
  });

  // Compact UI toggle
  const [compact, setCompact] = useState(compactDefault);

  // Debounced search
  const [q, setQ] = useState(filters.q || "");
  const qDebounced = useDebouncedValue(q, 250);

  // Write to URL when filters change
  useEffect(() => {
    if (!syncToURL) return;
    const encode = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    const params = {
      q: qDebounced || "",
      // Meals
      effort: encode(filters.effort).join(","),
      time: encode(filters.time).join(","),
      appliance: encode(filters.appliance).join(","),
      course: encode(filters.course).join(","),
      diet: encode(filters.diet).join(","),
      season: encode(filters.season).join(","),
      // Cleaning
      zones: encode(filters.zones).join(","),
      frequency: encode(filters.frequency).join(","),
      intensity: encode(filters.intensity).join(","),
      duration: encode(filters.duration).join(","),
      // Garden
      action: encode(filters.action).join(","),
      bed: encode(filters.bed).join(","),
      // Animal
      kind: encode(filters.kind).join(","),
      aflag: encode(filters.aflag).join(","),
    };
    writeQueryParams(params);
  }, [filters, qDebounced, syncToURL]);

  // Notify parent
  useEffect(() => {
    onChange?.({ ...filters, q: qDebounced });
  }, [filters, qDebounced, onChange]);

  // Presets
  const PRESET_KEY = `ssa:decider:filters:${mode}`;
  const [presets, setPresets] = useState(() => store.get(PRESET_KEY, []));

  const savePreset = () => {
    const name = prompt("Save filters as preset name:");
    if (!name) return;
    const next = [...presets.filter((p) => p.name !== name), { name, filters: { ...filters, q } }];
    setPresets(next);
    store.set(PRESET_KEY, next);
  };

  const loadPreset = (p) => {
    if (!p) return;
    setFilters({ ...(p.filters || {}) });
    setQ(p.filters?.q || "");
  };

  const deletePreset = (name) => {
    const next = presets.filter((p) => p.name !== name);
    setPresets(next);
    store.set(PRESET_KEY, next);
  };

  const resetAll = () => {
    setFilters({});
    setQ("");
  };

  const applyNow = () => {
    // Emit to eventBus if present, then also call onChange immediately with current (non-debounced) q
    try {
      const bus = window?.eventBus || window?.ssa?.eventBus;
      bus?.emit?.("decider:filters:apply", { mode, filters: { ...filters, q } });
    } catch {}
    onChange?.({ ...filters, q });
  };

  // Helpers
  const setMulti = (key) => (list) => setFilters((f) => ({ ...f, [key]: list?.length ? list : undefined }));
  const setSingle = (key) => (val) =>
    setFilters((f) => ({ ...f, [key]: val && val.length ? [val] : undefined }));

  const activeChips = useMemo(() => {
    const entries = Object.entries(filters).flatMap(([k, v]) => {
      if (!v) return [];
      if (k === "q") return [];
      const arr = Array.isArray(v) ? v : [v];
      return arr.map((val) => ({ key: k, val, label: `${k}:${val}` }));
    });
    if (qDebounced) entries.unshift({ key: "q", val: qDebounced, label: `q:${qDebounced}` });
    return entries;
  }, [filters, qDebounced]);

  const removeChip = (chip) => {
    if (chip.key === "q") {
      setQ("");
      return;
    }
    setFilters((f) => {
      const arr = Array.isArray(f[chip.key]) ? f[chip.key] : f[chip.key] ? [f[chip.key]] : [];
      const next = arr.filter((v) => v !== chip.val);
      const rest = { ...f };
      if (next.length) rest[chip.key] = next;
      else delete rest[chip.key];
      return rest;
    });
  };

  // Sections per mode
  const renderMeals = () => (
    <>
      <MultiSelect
        value={filters.course || []}
        options={mergedCatalogs.course}
        placeholder="Course"
        onChange={setMulti("course")}
      />
      <MultiSelect
        value={filters.effort || []}
        options={mergedCatalogs.effort}
        placeholder="Effort"
        onChange={setMulti("effort")}
      />
      <MultiSelect
        value={filters.time || []}
        options={mergedCatalogs.time}
        placeholder="Time"
        onChange={setMulti("time")}
      />
      <MultiSelect
        value={filters.appliance || []}
        options={mergedCatalogs.appliance}
        placeholder="Appliance"
        onChange={setMulti("appliance")}
      />
      <MultiSelect
        value={filters.diet || []}
        options={mergedCatalogs.diet}
        placeholder="Diet"
        onChange={setMulti("diet")}
      />
      <MultiSelect
        value={filters.season || []}
        options={mergedCatalogs.season}
        placeholder="Season"
        onChange={setMulti("season")}
      />
    </>
  );

  const renderCleaning = () => (
    <>
      <MultiSelect
        value={filters.zones || []}
        options={mergedCatalogs.zones}
        placeholder="Zone"
        onChange={setMulti("zones")}
      />
      <MultiSelect
        value={filters.frequency || []}
        options={mergedCatalogs.frequency}
        placeholder="Frequency"
        onChange={setMulti("frequency")}
      />
      <MultiSelect
        value={filters.intensity || []}
        options={mergedCatalogs.intensity}
        placeholder="Intensity"
        onChange={setMulti("intensity")}
      />
      <MultiSelect
        value={filters.duration || []}
        options={mergedCatalogs.duration}
        placeholder="Duration"
        onChange={setMulti("duration")}
      />
      {/* Reuse: season or household rhythms may influence cleaning pushes */}
      <SingleSelect
        value={(filters.season || [])[0] || ""}
        options={DEFAULTS.meals.season}
        placeholder="Any Season"
        onChange={setSingle("season")}
      />
    </>
  );

  const renderGarden = () => (
    <>
      <MultiSelect
        value={filters.action || []}
        options={mergedCatalogs.action}
        placeholder="Action"
        onChange={setMulti("action")}
      />
      <MultiSelect
        value={filters.season || []}
        options={mergedCatalogs.season}
        placeholder="Season"
        onChange={setMulti("season")}
      />
      <MultiSelect
        value={filters.bed || []}
        options={mergedCatalogs.bed}
        placeholder="Bed"
        onChange={setMulti("bed")}
      />
    </>
  );

  const renderAnimal = () => (
    <>
      <MultiSelect
        value={filters.kind || []}
        options={mergedCatalogs.kind}
        placeholder="Animal"
        onChange={setMulti("kind")}
      />
      <MultiSelect
        value={filters.action || []}
        options={mergedCatalogs.action}
        placeholder="Action"
        onChange={setMulti("action")}
      />
      <MultiSelect
        value={filters.aflag || []}
        options={mergedCatalogs.flags}
        placeholder="Flags"
        onChange={setMulti("aflag")}
      />
      <SingleSelect
        value={(filters.season || [])[0] || ""}
        options={DEFAULTS.meals.season}
        placeholder="Any Season"
        onChange={setSingle("season")}
      />
    </>
  );

  const section = useMemo(() => {
    switch (mode) {
      case "cleaning":
        return renderCleaning();
      case "garden":
        return renderGarden();
      case "animal":
        return renderAnimal();
      case "meals":
      default:
        return renderMeals();
    }
  }, [mode, mergedCatalogs, filters]);

  return (
    <div className={cx("w-full rounded-2xl border bg-white p-4 shadow-sm", className)}>
      {/* Top row: Search + actions */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="w-full md:max-w-xl">
          <Input value={q} onChange={setQ} placeholder="Search keywords, tags, sources…" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle id="compact-ui" label="Compact" checked={compact} onChange={setCompact} />
          <button
            type="button"
            onClick={savePreset}
            className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
            title="Save current filters as preset"
          >
            Save Preset
          </button>
          {!!presets.length && (
            <div className="flex items-center gap-2">
              <label className="text-sm">Load:</label>
              <select
                className="rounded-lg border px-2 py-2 text-sm"
                onChange={(e) => {
                  const p = presets.find((x) => x.name === e.target.value);
                  loadPreset(p);
                }}
                defaultValue=""
              >
                <option value="" disabled>
                  Select preset…
                </option>
                {presets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-lg border px-2 py-2 text-sm hover:bg-gray-50"
                onClick={() => {
                  const name = prompt(
                    "Delete which preset? Type the name exactly:\n\n" + presets.map((p) => `• ${p.name}`).join("\n")
                  );
                  if (name) deletePreset(name);
                }}
                title="Delete a preset"
              >
                Delete
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={resetAll}
            className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
            title="Reset all filters"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={applyNow}
            className="rounded-lg bg-black px-3 py-2 text-sm text-white hover:opacity-90"
            title="Apply filters now"
          >
            Apply
          </button>
        </div>
      </div>

      {/* Filters grid */}
      <div
        className={cx(
          "mt-4 grid gap-3",
          compact ? "grid-cols-1 md:grid-cols-3" : "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
        )}
      >
        {section}
      </div>

      {/* Active chips */}
      <div className="mt-4 flex flex-wrap gap-2">
        {activeChips.length ? (
          activeChips.map((c, idx) => <Chip key={`${c.key}-${c.val}-${idx}`} label={c.label} onRemove={() => removeChip(c)} />)
        ) : (
          <span className="text-sm text-gray-500">No active filters</span>
        )}
      </div>

      {/* Footnote: UX hints */}
      <div className="mt-3 text-xs text-gray-500">
        Pro tip: Save your favorite combinations as presets (e.g., “Kitchen • Weekly • 20–40m”) and hit <em>Apply</em> to
        trigger Next-Best-Action suggestions downstream.
      </div>
    </div>
  );
}
