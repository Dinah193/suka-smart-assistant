// src/components/decider/DeciderFiltersBar.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ---------------------------- Defensive imports ---------------------------- */
let automation = null;
try {
  // @ts-ignore
  automation = require("@/services/automation/runtime").automation || null;
} catch (_) {}

let useGardenStore = null;
try {
  // @ts-ignore
  useGardenStore = require("@/stores/gardenStore").useGardenStore || null;
} catch (_) {}

let useSettingsStore = null;
try {
  // @ts-ignore
  useSettingsStore = require("@/stores/settingsStore").useSettingsStore || null;
} catch (_) {}

let NBAInvokeButton = null;
try {
  // Try garden/cleaning/meals common buttons in case one exists
  NBAInvokeButton =
    require("@/components/animals/common/NBAInvokeButton.jsx").default ||
    require("@/components/cleaning/common/NBAInvokeButton.jsx").default ||
    require("@/components/meals/common/NBAInvokeButton.jsx").default ||
    null;
} catch (_) {}

/* ---------------------------------- Utils --------------------------------- */
const uid = () => Math.random().toString(36).slice(2, 10);
const b64 = {
  enc: (o) => {
    try {
      return btoa(unescape(encodeURIComponent(JSON.stringify(o))));
    } catch {
      return "";
    }
  },
  dec: (s) => {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(s))));
    } catch {
      return null;
    }
  },
};

const emit = (type, detail) => {
  if (automation?.emit) automation.emit(type, detail);
  window.dispatchEvent(new CustomEvent(type, { detail }));
};

/** Coerce to Date (YYYY-MM-DD or timestamp) */
const toDate = (d) => {
  if (!d) return null;
  if (d instanceof Date) return d;
  if (typeof d === "number") return new Date(d);
  if (typeof d === "string") return new Date(d);
  return null;
};

const formatMD = (d) =>
  !d ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

/* ------------------------------ Frost helpers ------------------------------ */
/**
 * settingsStore may expose:
 *  - settings.location.zip / lat / lon
 *  - settings.garden.frost.first (ISO)  // first fall frost
 *  - settings.garden.frost.last  (ISO)  // last spring frost
 * If missing, we still allow manual offsets and show “Unknown”.
 */
function getFrostDates(settings) {
  const first = toDate(settings?.garden?.frost?.first);
  const last = toDate(settings?.garden?.frost?.last);
  return { first, last };
}

/**
 * Window modes:
 *  - "any"           : ignore frost window
 *  - "before-last"   : only allow dates <= (lastFrost + daysAfterLast <= 0)
 *  - "after-last"    : only allow dates >= (lastFrost + daysAfterLast >= 0)
 *  - "between"       : allow date between [lastFrost + A, lastFrost + B]
 */
const DEFAULT_FROST = {
  mode: "any",
  daysA: -14, // for before/between
  daysB: 21,  // for after/between
  onlyFrostSafe: false, // mark to prefer crops marked frost-tolerant in catalogs
};

/* ------------------------------ MultiSelect UI ----------------------------- */
function MultiSelect({ label, options, values, onChange, placeholder = "Select…" }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);

  const filtered = useMemo(() => {
    const t = (q || "").toLowerCase();
    return (options || [])
      .filter((o) => (o.label || "").toLowerCase().includes(t))
      .slice(0, 200);
  }, [options, q]);

  useEffect(() => {
    const handle = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <button
        type="button"
        className="w-full rounded-lg border px-3 py-2 text-left hover:bg-gray-50"
        onClick={() => setOpen((o) => !o)}
      >
        {values?.length ? (
          <div className="flex flex-wrap gap-1">
            {values.map((v) => {
              const opt = options?.find((o) => o.value === v);
              const text = opt?.label || v;
              return (
                <span
                  key={v}
                  className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5"
                >
                  {text}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onChange(values.filter((x) => x !== v));
                    }}
                    className="text-gray-500 hover:text-gray-800"
                    aria-label={`Remove ${text}`}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        ) : (
          <span className="text-gray-400">{placeholder}</span>
        )}
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-[22rem] max-h-72 overflow-auto rounded-lg border bg-white shadow-lg">
          <div className="p-2 border-b">
            <input
              className="w-full rounded-md border px-2 py-1 text-sm"
              placeholder="Search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <ul className="p-2">
            {filtered.length ? (
              filtered.map((o) => {
                const checked = values?.includes(o.value);
                return (
                  <li key={o.value}>
                    <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!checked}
                        onChange={() => {
                          if (checked) {
                            onChange(values.filter((v) => v !== o.value));
                          } else {
                            onChange([...(values || []), o.value]);
                          }
                        }}
                      />
                      <span className="text-sm">{o.label}</span>
                    </label>
                  </li>
                );
              })
            ) : (
              <li className="text-sm text-gray-500 px-2 py-2">No matches</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Frost Window UI ---------------------------- */
function FrostWindowPicker({ frost, onChange, frostDates }) {
  const { first, last } = frostDates || {};
  const lastLbl = formatMD(last) + (last ? "" : " (unknown)");
  const firstLbl = formatMD(first) + (first ? "" : " (unknown)");

  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-gray-700">Frost Window</div>
        <div className="text-xs text-gray-500">
          Last frost: <b>{lastLbl}</b> • First frost: <b>{firstLbl}</b>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="text-sm">
          <div className="text-gray-600 mb-1">Mode</div>
          <select
            className="w-full rounded-lg border px-3 py-2"
            value={frost.mode}
            onChange={(e) => onChange({ ...frost, mode: e.target.value })}
          >
            <option value="any">Ignore frost dates</option>
            <option value="before-last">Before last frost</option>
            <option value="after-last">After last frost</option>
            <option value="between">Between offsets (relative to last frost)</option>
          </select>
        </label>

        <label className="text-sm">
          <div className="text-gray-600 mb-1">
            Days A {frost.mode === "after-last" ? "(min +)" : "(neg = before)"}
          </div>
          <input
            type="number"
            className="w-full rounded-lg border px-3 py-2"
            value={frost.daysA}
            onChange={(e) => onChange({ ...frost, daysA: Number(e.target.value) })}
          />
        </label>

        <label className="text-sm">
          <div className="text-gray-600 mb-1">
            {frost.mode === "between" ? "Days B (end)" : "Days B (fallback)"}
          </div>
          <input
            type="number"
            className="w-full rounded-lg border px-3 py-2"
            value={frost.daysB}
            onChange={(e) => onChange({ ...frost, daysB: Number(e.target.value) })}
            disabled={frost.mode !== "between"}
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!frost.onlyFrostSafe}
            onChange={(e) => onChange({ ...frost, onlyFrostSafe: e.target.checked })}
          />
          Prefer frost-tolerant crops
        </label>

        <div className="ml-auto flex gap-2">
          <button
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => onChange({ ...DEFAULT_FROST })}
          >
            Reset
          </button>
          <button
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => onChange({ ...frost, mode: "before-last", daysA: -21, daysB: -1 })}
            title="3 weeks before through just before last frost"
          >
            3w before
          </button>
          <button
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => onChange({ ...frost, mode: "after-last", daysA: 0 })}
            title="From last frost onward"
          >
            Post-frost
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Main Component ---------------------------- */
export default function DeciderFiltersBar({
  /** Optional overrides if stores not available */
  cropOptions: cropOptionsProp,
  bedOptions: bedOptionsProp,
  /** Controlled usage optional */
  value,
  onChange,
  /** debounce ms for auto-apply */
  debounceMs = 120,
}) {
  const garden = useGardenStore ? useGardenStore() : null;
  const settings = useSettingsStore ? useSettingsStore() : null;

  // Build options from stores (defensive).
  const cropOptions = useMemo(() => {
    if (Array.isArray(cropOptionsProp) && cropOptionsProp.length) return cropOptionsProp;
    const catalog = garden?.catalog?.crops || garden?.crops || [];
    // Allow shapes: [{id,name}] or strings
    return (catalog || []).map((c) =>
      typeof c === "string"
        ? { value: c, label: c }
        : { value: c.id || c.slug || c.name, label: c.name || c.title || c.id }
    );
  }, [cropOptionsProp, garden]);

  const bedOptions = useMemo(() => {
    if (Array.isArray(bedOptionsProp) && bedOptionsProp.length) return bedOptionsProp;
    const plots = garden?.plots || garden?.library?.plots || [];
    return (plots || []).map((p) => ({
      value: p.id || p.name,
      label: p.name || p.id,
    }));
  }, [bedOptionsProp, garden]);

  const frostDates = useMemo(() => getFrostDates(settings), [settings]);

  const [filters, setFilters] = useState(() => {
    // 1) try controlled value
    if (value) return { ...DEFAULT_FROST, text: "", crops: [], beds: [], ...value };
    // 2) try URL
    const usp = new URLSearchParams(window.location.search);
    const urlState = b64.dec(usp.get("deciderFilters")) || null;
    if (urlState) return { ...DEFAULT_FROST, text: "", crops: [], beds: [], ...urlState };
    // 3) try localStorage
    const saved = b64.dec(localStorage.getItem("suka.decider.filters") || "") || null;
    if (saved) return { ...DEFAULT_FROST, text: "", crops: [], beds: [], ...saved };
    // 4) default
    return { text: "", crops: [], beds: [], ...DEFAULT_FROST };
  });

  // Expose changes upward (controlled-ish), debounce
  useEffect(() => {
    const id = setTimeout(() => {
      onChange?.(filters);
      // Persist
      const encoded = b64.enc(filters);
      try {
        const usp = new URLSearchParams(window.location.search);
        usp.set("deciderFilters", encoded);
        const newUrl = `${window.location.pathname}?${usp.toString()}${window.location.hash || ""}`;
        window.history.replaceState({}, "", newUrl);
      } catch {}
      localStorage.setItem("suka.decider.filters", encoded);
      emit("decider.filters.changed", { filters });
    }, debounceMs);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  // Keep in sync if parent controls `value`
  useEffect(() => {
    if (!value) return;
    setFilters((f) => ({ ...f, ...value }));
  }, [value]);

  const summaryChips = useMemo(() => {
    const chips = [];
    if (filters.text) chips.push({ k: "text", label: `“${filters.text}”` });
    if (filters.crops?.length) chips.push({ k: "crops", label: `${filters.crops.length} crop(s)` });
    if (filters.beds?.length) chips.push({ k: "beds", label: `${filters.beds.length} bed(s)` });

    const f = filters;
    if (f.mode && f.mode !== "any") {
      if (f.mode === "before-last") chips.push({ k: "frost", label: `≤ last frost + ${f.daysA}d` });
      if (f.mode === "after-last") chips.push({ k: "frost", label: `≥ last frost + ${f.daysA}d` });
      if (f.mode === "between") chips.push({ k: "frost", label: `${f.daysA}…${f.daysB}d of last frost` });
    }
    if (f.onlyFrostSafe) chips.push({ k: "ft", label: "Prefer frost-safe" });
    return chips;
  }, [filters]);

  const clearKey = (k) => {
    setFilters((f) => {
      if (k === "text") return { ...f, text: "" };
      if (k === "crops") return { ...f, crops: [] };
      if (k === "beds") return { ...f, beds: [] };
      if (k === "frost") return { ...f, ...DEFAULT_FROST };
      if (k === "ft") return { ...f, onlyFrostSafe: false };
      return f;
    });
  };

  const resetAll = () => {
    setFilters({ text: "", crops: [], beds: [], ...DEFAULT_FROST });
  };

  return (
    <div className="rounded-2xl border bg-white p-4 md:p-5 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-base md:text-lg font-semibold text-gray-800">Filters</div>
          <div className="text-xs text-gray-500">
            Narrow candidates by crop, bed, and seasonal frost window. Results update automatically.
          </div>
        </div>
        <div className="flex items-center gap-2">
          {NBAInvokeButton ? (
            <NBAInvokeButton
              scope="garden"
              intent="decider.filters"
              label="NBA"
              payload={{ filters }}
              className="!px-3 !py-2"
            />
          ) : (
            <button
              className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
              onClick={() => emit("nba.requested", { scope: "garden", from: "DeciderFiltersBar", filters })}
            >
              Request NBA
            </button>
          )}
          <button
            className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
            onClick={resetAll}
            title="Reset all filters"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Row 1: Text search + chips */}
      <div className="mb-3">
        <div className="flex items-center gap-2">
          <input
            className="flex-1 rounded-lg border px-3 py-2"
            placeholder="Search crops, tasks, tags…"
            value={filters.text || ""}
            onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))}
          />
        </div>
        {!!summaryChips.length && (
          <div className="mt-2 flex flex-wrap gap-1">
            {summaryChips.map((c) => (
              <span
                key={c.k}
                className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 bg-gray-50"
              >
                {c.label}
                <button
                  type="button"
                  onClick={() => clearKey(c.k)}
                  className="text-gray-500 hover:text-gray-800"
                  aria-label={`Clear ${c.k}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Row 2: Crop & Bed */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <MultiSelect
          label="Crops"
          options={cropOptions}
          values={filters.crops || []}
          onChange={(vals) => setFilters((f) => ({ ...f, crops: vals }))}
          placeholder="All crops"
        />
        <MultiSelect
          label="Beds / Plots"
          options={bedOptions}
          values={filters.beds || []}
          onChange={(vals) => setFilters((f) => ({ ...f, beds: vals }))}
          placeholder="All beds"
        />
      </div>

      {/* Row 3: Frost Window */}
      <FrostWindowPicker
        frost={{
          mode: filters.mode ?? DEFAULT_FROST.mode,
          daysA: Number.isFinite(filters.daysA) ? filters.daysA : DEFAULT_FROST.daysA,
          daysB: Number.isFinite(filters.daysB) ? filters.daysB : DEFAULT_FROST.daysB,
          onlyFrostSafe: !!filters.onlyFrostSafe,
        }}
        frostDates={frostDates}
        onChange={(fw) => setFilters((f) => ({ ...f, ...fw }))}
      />

      {/* Footer helper */}
      <div className="mt-3 text-[11px] text-gray-500">
        Tip: Frost presets constrain planting windows relative to your{" "}
        <span className="font-medium">last frost</span>. If frost dates are unknown in Settings, presets still work but
        with relative offsets only.
      </div>
    </div>
  );
}
