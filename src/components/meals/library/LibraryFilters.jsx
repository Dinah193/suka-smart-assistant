// src/components/meals/library/LibraryFilters.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch (_) {
  Icons = {
    Filter: () => null,
    X: () => null,
    Save: () => null,
    ChevronDown: () => null,
    ChevronUp: () => null,
    Settings2: () => null,
    Star: () => null,
    StarOff: () => null,
    Clock: () => null,
    ChefHat: () => null,
    Salad: () => null,
    ListFilter: () => null,
    RefreshCcw: () => null,
    Search: () => null,
    Tags: () => null,
    Check: () => null,
    SlidersHorizontal: () => null,
    CopyPlus: () => null,
    Trash2: () => null,
    Download: () => null,
    Upload: () => null,
    Asterisk: () => null,
  };
}

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  eventBus = require("@/services/eventBus").eventBus || eventBus;
} catch (_) {}

let usePersonalFoodStandards = () => ({ standards: {} });
try {
  usePersonalFoodStandards =
    require("@/app/context/HouseholdSettingsContext").usePersonalFoodStandards ||
    usePersonalFoodStandards;
} catch (_) {}

let useBatchQueue = () => ({ addFilter: () => {}, clearFilter: () => {} });
try {
  useBatchQueue = require("@/features/meals/BatchQueueProvider").useBatchQueue || useBatchQueue;
} catch (_) {}

let TagSuggest = null;
try {
  TagSuggest = require("@/components/tags/TagSuggest.jsx").default || null;
} catch (_) {}

/* --------------------------------- Helpers ---------------------------------- */

const STORAGE_KEY = "suka.meals.library.filters.v3";
const PRESET_KEY = "suka.meals.library.presets.v1";

const defaultFilters = {
  q: "",
  includeTags: [],
  excludeTags: [],
  collections: [],
  mealTypes: [], // e.g., ["breakfast","lunch","dinner","snack","batch"]
  cuisine: [],
  difficulty: [], // ["easy","med","hard"]
  ratingMin: 0,
  prepTimeMax: 0, // 0 = any
  macros: { proteinMin: 0, carbsMax: 0, fatMax: 0, kcalMax: 0 },
  diet: {
    clean: false, // from PersonalFoodStandards
    lambBeefOnly: false,
    noPork: true,
    goatAllowed: true,
    allergens: [], // e.g. ["gluten","dairy","soy","peanut",...]
  },
  source: {
    vault: true,
    scanned: true,
    web: true,
    imported: true,
  },
  inventoryAware: false, // only show recipes possible with current inventory
  hasMedia: false, // has photo/video
  pinnedOnly: false,
  batchReadyOnly: false,
  createdRange: { from: null, to: null },
  updatedRange: { from: null, to: null },
  sort: { key: "relevance", dir: "desc" }, // key: relevance|created|updated|rating|prepTime|title
  viewPreset: "Decide", // Collect | Decide | Plan
};

function loadState(initial) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return { ...defaultFilters, ...(saved || {}), ...(initial || {}) };
  } catch {
    return { ...defaultFilters, ...(initial || {}) };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function loadPresets() {
  try {
    return JSON.parse(localStorage.getItem(PRESET_KEY) || "[]");
  } catch {
    return [];
  }
}

function savePresets(list) {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list));
  } catch {}
}

function toQueryString(filters) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.includeTags?.length) params.set("tags", filters.includeTags.join(","));
  if (filters.excludeTags?.length) params.set("not", filters.excludeTags.join(","));
  if (filters.collections?.length) params.set("col", filters.collections.join(","));
  if (filters.mealTypes?.length) params.set("type", filters.mealTypes.join(","));
  if (filters.cuisine?.length) params.set("cui", filters.cuisine.join(","));
  if (filters.difficulty?.length) params.set("diff", filters.difficulty.join(","));
  if (filters.ratingMin) params.set("rate", String(filters.ratingMin));
  if (filters.prepTimeMax) params.set("prep", String(filters.prepTimeMax));
  if (filters.inventoryAware) params.set("inv", "1");
  if (filters.pinnedOnly) params.set("pin", "1");
  if (filters.batchReadyOnly) params.set("batch", "1");
  if (filters.hasMedia) params.set("media", "1");
  if (filters.sort?.key) params.set("sort", filters.sort.key);
  if (filters.sort?.dir) params.set("dir", filters.sort.dir);
  if (filters.viewPreset) params.set("view", filters.viewPreset);
  return params.toString();
}

function fromQueryString(search) {
  const url = new URLSearchParams(search || "");
  const coerceList = (v) => (v ? v.split(",").filter(Boolean) : []);
  const num = (v, f = 0) => (v ? Number(v) || f : f);
  return {
    q: url.get("q") || "",
    includeTags: coerceList(url.get("tags")),
    excludeTags: coerceList(url.get("not")),
    collections: coerceList(url.get("col")),
    mealTypes: coerceList(url.get("type")),
    cuisine: coerceList(url.get("cui")),
    difficulty: coerceList(url.get("diff")),
    ratingMin: num(url.get("rate")),
    prepTimeMax: num(url.get("prep")),
    inventoryAware: url.get("inv") === "1",
    pinnedOnly: url.get("pin") === "1",
    batchReadyOnly: url.get("batch") === "1",
    hasMedia: url.get("media") === "1",
    sort: { key: url.get("sort") || "relevance", dir: url.get("dir") || "desc" },
    viewPreset: url.get("view") || "Decide",
  };
}

/* ---------------------------- Small UI primitives ---------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");

const Chip = ({ selected, onClick, children, className, "aria-label": ariaLabel }) => (
  <button
    type="button"
    aria-pressed={!!selected}
    aria-label={ariaLabel}
    onClick={onClick}
    className={cx(
      "inline-flex items-center rounded-full border px-3 py-1 text-sm mr-2 mb-2 transition",
      selected
        ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
        : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50",
      className
    )}
  >
    {children}
  </button>
);

const Toggle = ({ label, checked, onChange, icon: Icon, className }) => (
  <label className={cx("flex items-center gap-2 cursor-pointer select-none", className)}>
    <input
      type="checkbox"
      className="peer sr-only"
      checked={!!checked}
      onChange={(e) => onChange(e.target.checked)}
    />
    <span
      className={cx(
        "w-10 h-6 rounded-full relative transition",
        "after:content-[''] after:w-5 after:h-5 after:bg-white after:rounded-full after:absolute after:top-0.5 after:left-0.5 after:transition",
        checked ? "bg-emerald-600 after:translate-x-4" : "bg-gray-300"
      )}
    />
    {Icon ? <Icon className="w-4 h-4 text-gray-600" /> : null}
    <span className="text-sm text-gray-800">{label}</span>
  </label>
);

const Section = ({ title, icon: Icon, children, dense }) => (
  <div className={cx("rounded-xl border border-gray-200 bg-white", dense ? "p-3" : "p-4")}>
    <div className="flex items-center gap-2 mb-3">
      {Icon ? <Icon className="w-4 h-4 text-gray-500" /> : null}
      <h4 className="text-sm font-semibold text-gray-700">{title}</h4>
    </div>
    {children}
  </div>
);

/* ------------------------------- Main Component ------------------------------ */

export default function LibraryFilters({
  initial = {},
  availableTags = [], // [{id:'low-carb', label:'Low Carb', count: 12}, ...]
  availableCollections = [], // [{id:'my-favs', label:'My Favs', count: 20}]
  availableCuisines = [], // ["West African","Mediterranean",...]
  availableMealTypes = [], // ["breakfast","lunch","dinner","snack","batch"]
  onChange = () => {},
  onExportPreset, // optional callback when exporting current filters JSON
  onImportPreset, // optional callback when importing JSON -> filters
  counts = {}, // shape: { total: n, afterFilter: n } (optional)
}) {
  // Load order: URL -> localStorage -> parent initial
  const urlFilters = useMemo(() => fromQueryString(window?.location?.search || ""), []);
  const [filters, setFilters] = useState(() => loadState({ ...initial, ...urlFilters }));
  const [expanded, setExpanded] = useState(false);
  const [presets, setPresets] = useState(loadPresets());
  const [presetName, setPresetName] = useState("");
  const [qDraft, setQDraft] = useState(filters.q || "");

  const debounceRef = useRef(null);
  const isFirst = useRef(true);

  const { standards } = usePersonalFoodStandards();
  const { addFilter: linkToBatchQueue, clearFilter: clearBatchLink } = useBatchQueue();

  // Seed diet toggles from personal standards (only once)
  useEffect(() => {
    if (!isFirst.current) return;
    isFirst.current = false;
    setFilters((prev) => ({
      ...prev,
      diet: {
        ...prev.diet,
        clean: prev.diet.clean || !!standards?.prefersClean,
        noPork: prev.diet.noPork ?? true,
        goatAllowed: prev.diet.goatAllowed ?? true,
        lambBeefOnly: prev.diet.lambBeefOnly || !!standards?.lambBeefOnly,
        allergens: Array.isArray(standards?.allergens) ? [...standards.allergens] : prev.diet.allergens,
      },
    }));
  }, [standards]);

  // Debounced onChange + persist + URL sync + Batch queue link
  useEffect(() => {
    saveState(filters);
    const qs = toQueryString(filters);
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    window.history.replaceState({}, "", url);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onChange(normalize(filters));
      if (filters.viewPreset === "Plan" || filters.batchReadyOnly) {
        linkToBatchQueue({ source: "LibraryFilters", filters: normalize(filters) });
      } else {
        clearBatchLink?.();
      }
      eventBus.emit("meals.library.filters.changed", { filters: normalize(filters) });
    }, 180);

    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const totalShown = counts?.afterFilter ?? null;
  const totalAll = counts?.total ?? null;

  /* --------------------------------- Actions -------------------------------- */
  function normalize(f) {
    return {
      ...f,
      includeTags: unique(f.includeTags),
      excludeTags: unique(f.excludeTags),
      collections: unique(f.collections),
      mealTypes: unique(f.mealTypes),
      cuisine: unique(f.cuisine),
      difficulty: unique(f.difficulty),
      sort: { key: f.sort?.key || "relevance", dir: f.sort?.dir || "desc" },
      macros: {
        proteinMin: clampNum(f.macros?.proteinMin, 0, 300),
        carbsMax: clampNum(f.macros?.carbsMax, 0, 500),
        fatMax: clampNum(f.macros?.fatMax, 0, 200),
        kcalMax: clampNum(f.macros?.kcalMax, 0, 3000),
      },
      ratingMin: clampNum(f.ratingMin, 0, 5),
      prepTimeMax: clampNum(f.prepTimeMax, 0, 600),
    };
  }

  function unique(list) {
    return Array.from(new Set(list || [])).filter(Boolean);
  }

  function clampNum(v, min, max) {
    const n = Number(v) || 0;
    return Math.max(min, Math.min(max, n));
  }

  function clearAll() {
    setFilters({ ...defaultFilters, viewPreset: filters.viewPreset });
    setQDraft("");
  }

  function applyViewPreset(name) {
    // Presets that match your Collect • Decide • Plan UX
    if (name === "Collect") {
      setFilters((prev) => ({
        ...defaultFilters,
        viewPreset: "Collect",
        sort: { key: "created", dir: "desc" },
        source: { ...prev.source, web: true, imported: true, vault: true, scanned: true },
      }));
    } else if (name === "Decide") {
      setFilters((prev) => ({
        ...prev,
        viewPreset: "Decide",
        sort: { key: "relevance", dir: "desc" },
        ratingMin: 3,
        batchReadyOnly: false,
      }));
    } else if (name === "Plan") {
      setFilters((prev) => ({
        ...prev,
        viewPreset: "Plan",
        sort: { key: "title", dir: "asc" },
        batchReadyOnly: true,
        pinnedOnly: true,
      }));
    }
  }

  function savePreset() {
    const name = presetName?.trim();
    if (!name) return;
    const next = [
      ...presets.filter((p) => p.name !== name),
      { name, filters: normalize(filters), ts: Date.now() },
    ].sort((a, b) => b.ts - a.ts);
    setPresets(next);
    savePresets(next);
  }

  function deletePreset(name) {
    const next = presets.filter((p) => p.name !== name);
    setPresets(next);
    savePresets(next);
  }

  function applyPreset(p) {
    if (!p) return;
    setFilters({ ...filters, ...p.filters });
    setQDraft(p.filters?.q || "");
  }

  function exportPreset() {
    const payload = JSON.stringify(normalize(filters), null, 2);
    if (typeof onExportPreset === "function") onExportPreset(payload);
    try {
      const blob = new Blob([payload], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `library-filters-${Date.now()}.json`;
      link.click();
    } catch {}
  }

  async function importPreset(evt) {
    const file = evt?.target?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const merged = { ...defaultFilters, ...parsed };
      setFilters(merged);
      setQDraft(merged.q || "");
      if (typeof onImportPreset === "function") onImportPreset(merged);
    } catch (e) {
      console.error("[LibraryFilters] import failed:", e);
    } finally {
      evt.target.value = "";
    }
  }

  /* ---------------------------------- UI ------------------------------------ */
  const {
    Filter,
    X,
    Save,
    ChevronDown,
    ChevronUp,
    Settings2,
    Star,
    StarOff,
    Clock,
    ChefHat,
    Salad,
    ListFilter,
    RefreshCcw,
    Search,
    Tags,
    Check,
    SlidersHorizontal,
    CopyPlus,
    Trash2,
    Download,
    Upload,
    Asterisk,
  } = Icons;

  return (
    <div className="w-full bg-white/70 backdrop-blur supports-[backdrop-filter]:bg-white sticky top-0 z-30 border-b">
      <div className="max-w-7xl mx-auto px-4 py-3">
        {/* Top Row: Search + View Presets + Counts */}
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          {/* Search */}
          <div className="flex-1 relative">
            <Search className="w-4 h-4 text-gray-500 absolute left-3 top-3" />
            <input
              aria-label="Search recipes"
              value={qDraft}
              onChange={(e) => {
                setQDraft(e.target.value);
                setFilters((prev) => ({ ...prev, q: e.target.value }));
              }}
              placeholder="Search recipes, ingredients, tags… (Press / to focus)"
              className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQDraft("");
                  setFilters((p) => ({ ...p, q: "" }));
                }
              }}
            />
          </div>

          {/* View Preset */}
          <div className="flex items-center gap-2">
            {["Collect", "Decide", "Plan"].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => applyViewPreset(v)}
                className={cx(
                  "px-3 py-2 text-xs rounded-lg border transition",
                  filters.viewPreset === v
                    ? "bg-emerald-600 border-emerald-600 text-white"
                    : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
                )}
              >
                {v}
              </button>
            ))}
          </div>

          {/* Counts */}
          <div className="text-xs text-gray-600 ml-auto">
            {totalShown != null && totalAll != null ? (
              <span>
                Showing <strong>{totalShown}</strong> of <strong>{totalAll}</strong>
              </span>
            ) : null}
          </div>

          {/* Expand/Collapse */}
          <button
            type="button"
            onClick={() => setExpanded((s) => !s)}
            className="ml-1 inline-flex items-center gap-1 text-sm text-gray-700 hover:text-gray-900"
            aria-expanded={expanded}
          >
            <Filter className="w-4 h-4" />
            {expanded ? (
              <>
                Hide filters <ChevronUp className="w-4 h-4" />
              </>
            ) : (
              <>
                Show filters <ChevronDown className="w-4 h-4" />
              </>
            )}
          </button>
        </div>

        {/* Expanded Filter Panels */}
        {expanded && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mt-3">
            {/* Tags Include / Exclude */}
            <Section title="Tags" icon={Tags}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs text-gray-500">Include</span>
                <Asterisk className="w-3 h-3 text-emerald-500" />
              </div>
              <div className="flex flex-wrap">
                {(availableTags || []).map((t) => (
                  <Chip
                    key={`inc-${t.id}`}
                    selected={filters.includeTags.includes(t.id)}
                    onClick={() =>
                      setFilters((prev) => {
                        const selected = prev.includeTags.includes(t.id)
                          ? prev.includeTags.filter((x) => x !== t.id)
                          : [...prev.includeTags, t.id];
                        return { ...prev, includeTags: selected, excludeTags: prev.excludeTags.filter((x) => x !== t.id) };
                      })
                    }
                    aria-label={`Include tag ${t.label}`}
                  >
                    {t.label}
                    {typeof t.count === "number" ? (
                      <span className="ml-2 text-[10px] opacity-80">({t.count})</span>
                    ) : null}
                  </Chip>
                ))}
              </div>

              <div className="flex items-center gap-2 mt-3 mb-2">
                <span className="text-xs text-gray-500">Exclude</span>
              </div>
              <div className="flex flex-wrap">
                {(availableTags || []).map((t) => (
                  <Chip
                    key={`exc-${t.id}`}
                    selected={filters.excludeTags.includes(t.id)}
                    onClick={() =>
                      setFilters((prev) => {
                        const selected = prev.excludeTags.includes(t.id)
                          ? prev.excludeTags.filter((x) => x !== t.id)
                          : [...prev.excludeTags, t.id];
                        return { ...prev, excludeTags: selected, includeTags: prev.includeTags.filter((x) => x !== t.id) };
                      })
                    }
                    aria-label={`Exclude tag ${t.label}`}
                    className="border-rose-300 hover:bg-rose-50"
                  >
                    {t.label}
                  </Chip>
                ))}
              </div>

              {/* Optional Admin Tag Suggest */}
              {TagSuggest ? (
                <div className="mt-3">
                  <TagSuggest
                    onAdd={(tagId) =>
                      setFilters((p) => ({
                        ...p,
                        includeTags: unique([...(p.includeTags || []), tagId]),
                        excludeTags: (p.excludeTags || []).filter((x) => x !== tagId),
                      }))
                    }
                  />
                </div>
              ) : null}
            </Section>

            {/* Collections */}
            <Section title="Collections" icon={ListFilter}>
              <div className="flex flex-wrap">
                {(availableCollections || []).map((c) => (
                  <Chip
                    key={c.id}
                    selected={filters.collections.includes(c.id)}
                    onClick={() =>
                      setFilters((prev) => {
                        const selected = prev.collections.includes(c.id)
                          ? prev.collections.filter((x) => x !== c.id)
                          : [...prev.collections, c.id];
                        return { ...prev, collections: selected };
                      })
                    }
                    aria-label={`Toggle collection ${c.label}`}
                  >
                    {c.label}
                    {typeof c.count === "number" ? (
                      <span className="ml-2 text-[10px] opacity-80">({c.count})</span>
                    ) : null}
                  </Chip>
                ))}
              </div>
            </Section>

            {/* Meal Type & Cuisine */}
            <Section title="Type & Cuisine" icon={ChefHat}>
              <div className="mb-2">
                <div className="text-xs text-gray-500 mb-1">Meal Type</div>
                <div className="flex flex-wrap">
                  {(availableMealTypes || []).map((t) => (
                    <Chip
                      key={t}
                      selected={filters.mealTypes.includes(t)}
                      onClick={() =>
                        setFilters((prev) => {
                          const s = prev.mealTypes.includes(t)
                            ? prev.mealTypes.filter((x) => x !== t)
                            : [...prev.mealTypes, t];
                          return { ...prev, mealTypes: s };
                        })
                      }
                      aria-label={`Toggle meal type ${t}`}
                    >
                      {t}
                    </Chip>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Cuisine</div>
                <div className="flex flex-wrap">
                  {(availableCuisines || []).map((c) => (
                    <Chip
                      key={c}
                      selected={filters.cuisine.includes(c)}
                      onClick={() =>
                        setFilters((prev) => {
                          const s = prev.cuisine.includes(c)
                            ? prev.cuisine.filter((x) => x !== c)
                            : [...prev.cuisine, c];
                          return { ...prev, cuisine: s };
                        })
                      }
                      aria-label={`Toggle cuisine ${c}`}
                    >
                      {c}
                    </Chip>
                  ))}
                </div>
              </div>
            </Section>

            {/* Quality & Time */}
            <Section title="Quality & Time" icon={Star}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Min Rating</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0"
                      max="5"
                      step="1"
                      value={filters.ratingMin}
                      onChange={(e) =>
                        setFilters((p) => ({ ...p, ratingMin: Number(e.target.value) || 0 }))
                      }
                      className="w-full"
                      aria-label="Minimum rating"
                    />
                    <span className="text-sm w-6 text-right">{filters.ratingMin}</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Max Prep Time (min)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      max="600"
                      value={filters.prepTimeMax}
                      onChange={(e) =>
                        setFilters((p) => ({ ...p, prepTimeMax: Number(e.target.value) || 0 }))
                      }
                      className="w-24 px-2 py-1 rounded border border-gray-300"
                      aria-label="Max prep time"
                    />
                    <Clock className="w-4 h-4 text-gray-500" />
                  </div>
                </div>
              </div>

              <div className="mt-3">
                <div className="text-xs text-gray-500 mb-1">Difficulty</div>
                <div className="flex flex-wrap">
                  {["easy", "med", "hard"].map((d) => (
                    <Chip
                      key={d}
                      selected={filters.difficulty.includes(d)}
                      onClick={() =>
                        setFilters((prev) => {
                          const s = prev.difficulty.includes(d)
                            ? prev.difficulty.filter((x) => x !== d)
                            : [...prev.difficulty, d];
                          return { ...prev, difficulty: s };
                        })
                      }
                      aria-label={`Toggle difficulty ${d}`}
                    >
                      {d}
                    </Chip>
                  ))}
                </div>
              </div>
            </Section>

            {/* Dietary & Source */}
            <Section title="Dietary & Source" icon={Salad}>
              <div className="grid grid-cols-1 gap-2">
                <Toggle
                  label="Use my Personal Food Standards"
                  checked={!!filters.diet.clean}
                  onChange={(v) => setFilters((p) => ({ ...p, diet: { ...p.diet, clean: v } }))}
                  icon={Settings2}
                />
                <Toggle
                  label="No Pork"
                  checked={!!filters.diet.noPork}
                  onChange={(v) => setFilters((p) => ({ ...p, diet: { ...p.diet, noPork: v } }))}
                />
                <Toggle
                  label="Lamb/Beef only"
                  checked={!!filters.diet.lambBeefOnly}
                  onChange={(v) => setFilters((p) => ({ ...p, diet: { ...p.diet, lambBeefOnly: v } }))}
                />
                <Toggle
                  label="Goat allowed"
                  checked={!!filters.diet.goatAllowed}
                  onChange={(v) => setFilters((p) => ({ ...p, diet: { ...p.diet, goatAllowed: v } }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-2 mt-3">
                <Toggle
                  label="Vault"
                  checked={!!filters.source.vault}
                  onChange={(v) => setFilters((p) => ({ ...p, source: { ...p.source, vault: v } }))}
                />
                <Toggle
                  label="Scanned"
                  checked={!!filters.source.scanned}
                  onChange={(v) => setFilters((p) => ({ ...p, source: { ...p.source, scanned: v } }))}
                />
                <Toggle
                  label="Web"
                  checked={!!filters.source.web}
                  onChange={(v) => setFilters((p) => ({ ...p, source: { ...p.source, web: v } }))}
                />
                <Toggle
                  label="Imported"
                  checked={!!filters.source.imported}
                  onChange={(v) =>
                    setFilters((p) => ({ ...p, source: { ...p.source, imported: v } }))
                  }
                />
              </div>
            </Section>

            {/* Macros */}
            <Section title="Macro Targets (upper bounds except protein)" icon={SlidersHorizontal}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Protein min (g)</label>
                  <input
                    type="number"
                    min="0"
                    max="300"
                    value={filters.macros.proteinMin || 0}
                    onChange={(e) =>
                      setFilters((p) => ({
                        ...p,
                        macros: { ...p.macros, proteinMin: Number(e.target.value) || 0 },
                      }))
                    }
                    className="w-24 px-2 py-1 rounded border border-gray-300"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Carbs max (g)</label>
                  <input
                    type="number"
                    min="0"
                    max="500"
                    value={filters.macros.carbsMax || 0}
                    onChange={(e) =>
                      setFilters((p) => ({
                        ...p,
                        macros: { ...p.macros, carbsMax: Number(e.target.value) || 0 },
                      }))
                    }
                    className="w-24 px-2 py-1 rounded border border-gray-300"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Fat max (g)</label>
                  <input
                    type="number"
                    min="0"
                    max="200"
                    value={filters.macros.fatMax || 0}
                    onChange={(e) =>
                      setFilters((p) => ({
                        ...p,
                        macros: { ...p.macros, fatMax: Number(e.target.value) || 0 },
                      }))
                    }
                    className="w-24 px-2 py-1 rounded border border-gray-300"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Calories max</label>
                  <input
                    type="number"
                    min="0"
                    max="3000"
                    value={filters.macros.kcalMax || 0}
                    onChange={(e) =>
                      setFilters((p) => ({
                        ...p,
                        macros: { ...p.macros, kcalMax: Number(e.target.value) || 0 },
                      }))
                    }
                    className="w-24 px-2 py-1 rounded border border-gray-300"
                  />
                </div>
              </div>
            </Section>

            {/* Flags & Sort */}
            <Section title="Flags & Sort" icon={ListFilter}>
              <div className="grid grid-cols-2 gap-3">
                <Toggle
                  label="Inventory-aware"
                  checked={!!filters.inventoryAware}
                  onChange={(v) => setFilters((p) => ({ ...p, inventoryAware: v }))}
                />
                <Toggle
                  label="Pinned only"
                  checked={!!filters.pinnedOnly}
                  onChange={(v) => setFilters((p) => ({ ...p, pinnedOnly: v }))}
                  icon={Star}
                />
                <Toggle
                  label="Batch-ready only"
                  checked={!!filters.batchReadyOnly}
                  onChange={(v) => setFilters((p) => ({ ...p, batchReadyOnly: v }))}
                />
                <Toggle
                  label="Has media"
                  checked={!!filters.hasMedia}
                  onChange={(v) => setFilters((p) => ({ ...p, hasMedia: v }))}
                />
              </div>

              <div className="flex items-center gap-2 mt-3">
                <label className="text-xs text-gray-500">Sort</label>
                <select
                  value={filters.sort.key}
                  onChange={(e) =>
                    setFilters((p) => ({ ...p, sort: { ...p.sort, key: e.target.value } }))
                  }
                  className="px-2 py-1 rounded border border-gray-300 text-sm"
                >
                  <option value="relevance">Relevance</option>
                  <option value="created">Created</option>
                  <option value="updated">Updated</option>
                  <option value="rating">Rating</option>
                  <option value="prepTime">Prep Time</option>
                  <option value="title">Title</option>
                </select>

                <select
                  value={filters.sort.dir}
                  onChange={(e) =>
                    setFilters((p) => ({ ...p, sort: { ...p.sort, dir: e.target.value } }))
                  }
                  className="px-2 py-1 rounded border border-gray-300 text-sm"
                >
                  <option value="desc">Desc</option>
                  <option value="asc">Asc</option>
                </select>
              </div>
            </Section>

            {/* Presets */}
            <Section title="Presets" icon={Save} dense>
              <div className="flex items-center gap-2">
                <input
                  aria-label="Preset name"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Name this preset…"
                  className="flex-1 px-2 py-1 rounded border border-gray-300 text-sm"
                />
                <button
                  type="button"
                  onClick={savePreset}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded border text-sm bg-white hover:bg-gray-50"
                >
                  <Save className="w-4 h-4" /> Save
                </button>
                <button
                  type="button"
                  onClick={exportPreset}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded border text-sm bg-white hover:bg-gray-50"
                >
                  <Download className="w-4 h-4" /> Export
                </button>
                <label className="inline-flex items-center gap-1 px-3 py-1.5 rounded border text-sm bg-white hover:bg-gray-50 cursor-pointer">
                  <Upload className="w-4 h-4" />
                  Import
                  <input type="file" accept="application/json" onChange={importPreset} className="sr-only" />
                </label>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 max-h-40 overflow-auto pr-1">
                {presets.length === 0 ? (
                  <div className="text-xs text-gray-500">No presets saved yet.</div>
                ) : (
                  presets.map((p) => (
                    <div
                      key={p.name}
                      className="flex items-center justify-between px-3 py-2 rounded border hover:bg-gray-50"
                    >
                      <div className="text-sm font-medium">{p.name}</div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => applyPreset(p)}
                          className="text-emerald-700 hover:underline text-xs"
                        >
                          Apply
                        </button>
                        <button
                          type="button"
                          onClick={() => deletePreset(p.name)}
                          className="text-rose-600 hover:underline text-xs inline-flex items-center gap-1"
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Section>
          </div>
        )}

        {/* Footer bar: Clear / Reset / Quick toggles */}
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={clearAll}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-sm"
            aria-label="Clear all filters"
          >
            <RefreshCcw className="w-4 h-4" /> Clear
          </button>

          <div className="ml-auto flex items-center gap-2 text-xs text-gray-600">
            <Star className={cx("w-4 h-4", filters.pinnedOnly ? "text-amber-500" : "text-gray-400")} />
            <span>Tip: press <kbd className="px-1 border rounded">/</kbd> to focus search, <kbd className="px-1 border rounded">esc</kbd> to clear.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
