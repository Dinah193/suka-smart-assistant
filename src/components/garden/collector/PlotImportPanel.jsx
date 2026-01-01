// src/components/garden/collector/PlotImportPanel.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ---------------------------- Defensive imports ---------------------------- */
// Try to import services if available; otherwise stub gracefully
let automation = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  automation = require("@/services/automation/runtime").automation || null;
} catch (_) {}

let GardenQueueManager = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  GardenQueueManager = require("@/managers/GardenQueueManager").default || null;
} catch (_) {}

let ReminderManager = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  ReminderManager = require("@/managers/ReminderManager").default || null;
} catch (_) {}

let useGardenStore = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  useGardenStore = require("@/stores/gardenStore").useGardenStore || null;
} catch (_) {}

let NBAInvokeButton = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  NBAInvokeButton = require("@/components/animals/common/NBAInvokeButton.jsx").default
    || require("@/components/cleaning/common/NBAInvokeButton.jsx").default
    || require("@/components/meals/common/NBAInvokeButton.jsx").default
    || null;
} catch (_) {}

/* ---------------------------------- Utils --------------------------------- */
const uid = () => Math.random().toString(36).slice(2, 10);

const safeJSON = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    // NDJSON support: one JSON object per line
    try {
      const lines = text.split(/\r?\n/).filter(Boolean);
      return lines.map((l) => JSON.parse(l));
    } catch {
      return null;
    }
  }
};

// Tiny CSV parser (no external deps), handles commas in quotes
function parseCSV(csvText) {
  const rows = [];
  let current = "";
  let insideQuotes = false;
  const pushCell = (row) => {
    row.push(current);
    current = "";
  };
  const pushRow = (row) => {
    rows.push(row);
  };
  let row = [];
  for (let i = 0; i < csvText.length; i++) {
    const c = csvText[i];
    if (c === '"') {
      // Toggle or escape
      if (insideQuotes && csvText[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (c === "," && !insideQuotes) {
      pushCell(row);
      row = row; // noop clarity
    } else if ((c === "\n" || c === "\r") && !insideQuotes) {
      if (current.length || row.length) pushCell(row);
      if (row.length) pushRow(row);
      row = [];
      // handle CRLF by skipping next \n
      if (c === "\r" && csvText[i + 1] === "\n") i++;
    } else {
      current += c;
    }
  }
  if (current.length || row.length) {
    pushCell(row);
    pushRow(row);
  }
  return rows;
}

// Attempt to coerce string → number where appropriate
const num = (v) => {
  if (v === null || v === undefined) return null;
  const t = typeof v === "string" ? v.trim() : v;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

// Stable hash for dedupe (simple yet effective for UI)
const stableHash = (obj) => {
  const s = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(36);
};

/* ------------------------------ Canonical Schema ------------------------------ 
   Internal normalized plot schema the app can count on:

   Plot {
     id: string,
     name: string,
     kind: "bed" | "block" | "row" | "container",
     size: { length: number, width: number, unit: "ft"|"in"|"m" },
     layout: { rows?: number, cols?: number, rowSpacing?: number, colSpacing?: number, unit: "in"|"cm" },
     soil?: string,
     tags?: string[],
     notes?: string,
     source?: { type: "url"|"file"|"paste"|"draw", ref?: string },
   }
-------------------------------------------------------------------------------*/

const DEFAULT_UNIT = "ft";
const DEFAULT_LAYOUT_UNIT = "in";

/** Flexible normalizer from arbitrary keys */
function normalizeRecord(raw, sourceMeta = {}) {
  // Allow several common column names
  const get = (keys, fallback = null) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== "") return raw[k];
      // case-insensitive
      const hit = Object.keys(raw).find((rk) => rk.toLowerCase() === k.toLowerCase());
      if (hit) return raw[hit];
    }
    return fallback;
  };

  const name = (get(["name", "bed", "plot", "title"]) || "Untitled Plot").toString().trim();
  const kind = (get(["kind", "type", "category"], "bed") || "bed").toString().toLowerCase();

  const len = num(get(["length", "len", "l"]));
  const wid = num(get(["width", "w"]));
  const unit = (get(["unit", "units"], DEFAULT_UNIT) || DEFAULT_UNIT).toLowerCase();

  const rows = num(get(["rows"]));
  const cols = num(get(["cols", "columns"]));
  const rowSpacing = num(get(["rowSpacing", "row_spacing", "row-gap", "row gap", "rowgap"]));
  const colSpacing = num(get(["colSpacing", "col_spacing", "col-gap", "col gap", "colgap"]));
  const layoutUnit = (get(["layoutUnit", "layout_unit"], DEFAULT_LAYOUT_UNIT) || DEFAULT_LAYOUT_UNIT)
    .toLowerCase();

  const soil = get(["soil", "soilType", "soil_type"]);
  const tags = (() => {
    const t = get(["tags", "label", "labels"]);
    if (!t) return [];
    if (Array.isArray(t)) return t.map((x) => x.toString());
    return t.toString().split(/[|,;]/).map((x) => x.trim()).filter(Boolean);
  })();

  const notes = get(["notes", "note", "description", "desc"]);

  const base = {
    name,
    kind: ["bed", "block", "row", "container"].includes(kind) ? kind : "bed",
    size: {
      length: len ?? 8,
      width: wid ?? 4,
      unit: ["ft", "in", "m"].includes(unit) ? unit : DEFAULT_UNIT,
    },
    layout: {
      rows: rows ?? null,
      cols: cols ?? null,
      rowSpacing: rowSpacing ?? null,
      colSpacing: colSpacing ?? null,
      unit: ["in", "cm"].includes(layoutUnit) ? layoutUnit : DEFAULT_LAYOUT_UNIT,
    },
    soil: soil || null,
    tags,
    notes: notes || null,
    source: sourceMeta,
  };

  // Attach a deterministic id for dedupe/updates
  const id = stableHash(base);
  return { id, ...base };
}

/** Convert CSV rows + header → array of normalized plots, with column map support */
function csvToPlots(rows, headerMap = null, sourceMeta = {}) {
  if (!rows || !rows.length) return [];
  const header = rows[0];
  const body = rows.slice(1).filter((r) => r.some((c) => (c ?? "").toString().trim().length));

  const headerIndex = Object.fromEntries(header.map((h, i) => [h, i]));

  // If a column map was provided by the user, use it to construct raw objects
  if (headerMap) {
    return body.map((r) => {
      const raw = {};
      for (const [targetKey, srcHeader] of Object.entries(headerMap)) {
        if (!srcHeader) continue;
        const idx = headerIndex[srcHeader];
        raw[targetKey] = idx != null ? r[idx] : null;
      }
      return normalizeRecord(raw, sourceMeta);
    });
  }

  // Otherwise, try best-effort direct mapping by header name
  return body.map((r) => {
    const raw = {};
    header.forEach((h, i) => (raw[h] = r[i]));
    return normalizeRecord(raw, sourceMeta);
  });
}

/* ------------------------------ Preview Helpers ------------------------------ */
function PlotPreview({ plot }) {
  // Simple grid preview using SVG
  const length = plot.size?.length ?? 8;
  const width = plot.size?.width ?? 4;
  const rows = plot.layout?.rows ?? 0;
  const cols = plot.layout?.cols ?? 0;

  // Normalize canvas size
  const W = 280;
  const H = 160;
  const aspect = width > 0 ? length / width : 1;
  const canvasW = aspect >= 1 ? W : W * aspect;
  const canvasH = aspect >= 1 ? H / aspect : H;

  const cells = [];
  if (rows && cols) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({ r, c });
      }
    }
  }

  return (
    <div className="border rounded-xl p-3 bg-white shadow-sm">
      <div className="text-sm font-medium text-gray-700 mb-1">{plot.name}</div>
      <div className="text-xs text-gray-500 mb-2">
        {plot.kind} • {length}×{width} {plot.size?.unit || "ft"}
        {plot.layout?.rows && plot.layout?.cols ? (
          <> • {plot.layout.rows}×{plot.layout.cols}</>
        ) : null}
      </div>
      <svg
        viewBox={`0 0 ${canvasW} ${canvasH}`}
        className="w-full rounded-lg border"
        role="img"
        aria-label={`${plot.name} preview`}
      >
        <rect x="1" y="1" width={canvasW - 2} height={canvasH - 2} fill="transparent" stroke="currentColor" />
        {rows > 1 &&
          [...Array(rows - 1)].map((_, i) => {
            const y = ((i + 1) * canvasH) / rows;
            return <line key={`r${i}`} x1="0" y1={y} x2={canvasW} y2={y} stroke="currentColor" strokeOpacity="0.15" />;
          })}
        {cols > 1 &&
          [...Array(cols - 1)].map((_, i) => {
            const x = ((i + 1) * canvasW) / cols;
            return <line key={`c${i}`} x1={x} y1="0" x2={x} y2={canvasH} stroke="currentColor" strokeOpacity="0.15" />;
          })}
      </svg>
      {plot.tags?.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {plot.tags.map((t) => (
            <span key={t} className="text-[10px] border px-2 py-0.5 rounded-full text-gray-600">
              {t}
            </span>
          ))}
        </div>
      ) : null}
      {plot.soil ? <div className="mt-1 text-[11px] text-gray-500">Soil: {plot.soil}</div> : null}
      {plot.notes ? <div className="mt-1 text-[11px] text-gray-500 line-clamp-2">Notes: {plot.notes}</div> : null}
    </div>
  );
}

/* ---------------------------- Column Mapper UI ---------------------------- */
function ColumnMapper({ headers, onConfirm }) {
  const fields = [
    { key: "name", label: "Name" },
    { key: "kind", label: "Kind" },
    { key: "length", label: "Length" },
    { key: "width", label: "Width" },
    { key: "unit", label: "Unit" },
    { key: "rows", label: "Rows" },
    { key: "cols", label: "Cols" },
    { key: "rowSpacing", label: "Row Spacing" },
    { key: "colSpacing", label: "Col Spacing" },
    { key: "layoutUnit", label: "Layout Unit" },
    { key: "soil", label: "Soil" },
    { key: "tags", label: "Tags" },
    { key: "notes", label: "Notes" },
  ];
  const [map, setMap] = useState({});

  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="font-medium text-gray-700 mb-2">Map your CSV columns</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {fields.map((f) => (
          <label key={f.key} className="text-sm">
            <div className="text-gray-600 mb-1">{f.label}</div>
            <select
              className="w-full rounded-lg border px-3 py-2"
              value={map[f.key] || ""}
              onChange={(e) => setMap((m) => ({ ...m, [f.key]: e.target.value }))}
            >
              <option value="">— Not mapped —</option>
              {headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          className="rounded-lg px-4 py-2 border hover:bg-gray-50"
          onClick={() => onConfirm(map)}
        >
          Confirm Mapping
        </button>
      </div>
    </div>
  );
}

/* ----------------------------- Draw Plot Helper ----------------------------- */
function DrawPlotForm({ onCreate }) {
  const [name, setName] = useState("New Bed");
  const [kind, setKind] = useState("bed");
  const [length, setLength] = useState(8);
  const [width, setWidth] = useState(4);
  const [unit, setUnit] = useState("ft");
  const [rows, setRows] = useState(0);
  const [cols, setCols] = useState(0);

  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="text-sm">
          <div className="text-gray-600 mb-1">Name</div>
          <input className="w-full rounded-lg border px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-sm">
          <div className="text-gray-600 mb-1">Kind</div>
          <select className="w-full rounded-lg border px-3 py-2" value={kind} onChange={(e) => setKind(e.target.value)}>
            {["bed", "block", "row", "container"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <div className="text-gray-600 mb-1">Unit</div>
          <select className="w-full rounded-lg border px-3 py-2" value={unit} onChange={(e) => setUnit(e.target.value)}>
            {["ft", "in", "m"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <div className="text-gray-600 mb-1">Length</div>
          <input
            type="number"
            className="w-full rounded-lg border px-3 py-2"
            value={length}
            onChange={(e) => setLength(Number(e.target.value))}
            min={0}
          />
        </label>
        <label className="text-sm">
          <div className="text-gray-600 mb-1">Width</div>
          <input
            type="number"
            className="w-full rounded-lg border px-3 py-2"
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
            min={0}
          />
        </label>
        <div className="text-sm" />

        <label className="text-sm">
          <div className="text-gray-600 mb-1">Rows (optional)</div>
          <input
            type="number"
            className="w-full rounded-lg border px-3 py-2"
            value={rows}
            onChange={(e) => setRows(Number(e.target.value))}
            min={0}
          />
        </label>
        <label className="text-sm">
          <div className="text-gray-600 mb-1">Cols (optional)</div>
          <input
            type="number"
            className="w-full rounded-lg border px-3 py-2"
            value={cols}
            onChange={(e) => setCols(Number(e.target.value))}
            min={0}
          />
        </label>
        <div className="text-sm flex items-end">
          <button
            className="rounded-lg px-4 py-2 border hover:bg-gray-50"
            onClick={() =>
              onCreate(
                normalizeRecord(
                  {
                    name,
                    kind,
                    length,
                    width,
                    unit,
                    rows: rows || null,
                    cols: cols || null,
                  },
                  { type: "draw" }
                )
              )
            }
          >
            Add Plot
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Main Import Component ---------------------------- */
export default function PlotImportPanel() {
  const inputFileRef = useRef(null);
  const [activeTab, setActiveTab] = useState("url"); // url | upload | paste | draw
  const [url, setUrl] = useState("");
  const [rawRows, setRawRows] = useState([]); // CSV rows
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [columnMapNeeded, setColumnMapNeeded] = useState(false);
  const [plots, setPlots] = useState([]);
  const [selection, setSelection] = useState({});
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const gardenStore = useGardenStore ? useGardenStore() : null;

  const selectedCount = useMemo(() => Object.values(selection).filter(Boolean).length, [selection]);

  /* ------------------------------- Event helpers ------------------------------ */
  const emitEvent = (type, payload) => {
    // Preferred: automation runtime event
    if (automation?.emit) {
      automation.emit(type, payload);
    }
    // Also broadcast in window for non-runtime listeners
    window.dispatchEvent(new CustomEvent(type, { detail: payload }));
  };

  const toast = (kind, message) => {
    setStatus({ id: uid(), kind, message });
    setTimeout(() => setStatus(null), 3500);
  };

  /* --------------------------------- Parsers --------------------------------- */
  async function handleURLImport() {
    setError(null);
    setStatus({ id: uid(), kind: "info", message: "Fetching…" });
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
      const text = await res.text();

      // Try JSON first
      const maybeJSON = safeJSON(text);
      if (maybeJSON) {
        const arr = Array.isArray(maybeJSON) ? maybeJSON : [maybeJSON];
        const normalized = arr.map((r) => normalizeRecord(r, { type: "url", ref: url }));
        const unique = dedupe(normalized);
        setPlots(unique);
        setRawRows([]);
        setCsvHeaders([]);
        setColumnMapNeeded(false);
        toast("success", `Imported ${unique.length} plot(s) from JSON.`);
        emitEvent("garden.plots.imported", { source: "url-json", count: unique.length });
        return;
      }

      // Else parse as CSV
      const rows = parseCSV(text);
      if (!rows.length) throw new Error("No data detected in URL");
      setRawRows(rows);
      setCsvHeaders(rows[0] || []);
      setColumnMapNeeded(true);
      setPlots([]);
      toast("info", "CSV detected. Map your columns below.");
      emitEvent("garden.plots.detected.csv", { source: "url", headers: rows[0] || [] });
    } catch (e) {
      console.error(e);
      setError(e.message || "Import failed");
      toast("error", "Import failed.");
    }
  }

  function handleFileSelect(file) {
    if (!file) return;
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;

      // JSON?
      const maybeJSON = safeJSON(text);
      if (maybeJSON) {
        const arr = Array.isArray(maybeJSON) ? maybeJSON : [maybeJSON];
        const normalized = arr.map((r) => normalizeRecord(r, { type: "file", ref: file.name }));
        const unique = dedupe(normalized);
        setPlots(unique);
        setRawRows([]);
        setCsvHeaders([]);
        setColumnMapNeeded(false);
        toast("success", `Imported ${unique.length} plot(s) from JSON.`);
        emitEvent("garden.plots.imported", { source: "file-json", count: unique.length });
        return;
      }

      // CSV
      const rows = parseCSV(text);
      if (!rows.length) {
        setError("No data detected in file");
        toast("error", "Import failed.");
        return;
      }
      setRawRows(rows);
      setCsvHeaders(rows[0] || []);
      setColumnMapNeeded(true);
      setPlots([]);
      toast("info", "CSV detected. Map your columns below.");
      emitEvent("garden.plots.detected.csv", { source: "file", headers: rows[0] || [] });
    };
    reader.readAsText(file);
  }

  function handlePaste(text) {
    setError(null);
    // JSON?
    const maybeJSON = safeJSON(text);
    if (maybeJSON) {
      const arr = Array.isArray(maybeJSON) ? maybeJSON : [maybeJSON];
      const normalized = arr.map((r) => normalizeRecord(r, { type: "paste" }));
      setPlots(dedupe(normalized));
      setRawRows([]);
      setCsvHeaders([]);
      setColumnMapNeeded(false);
      toast("success", `Imported ${arr.length} plot(s) from JSON.`);
      emitEvent("garden.plots.imported", { source: "paste-json", count: arr.length });
      return;
    }
    // CSV
    const rows = parseCSV(text);
    if (!rows.length) {
      setError("Paste did not contain JSON or CSV.");
      toast("error", "Import failed.");
      return;
    }
    setRawRows(rows);
    setCsvHeaders(rows[0] || []);
    setColumnMapNeeded(true);
    setPlots([]);
    toast("info", "CSV detected. Map your columns below.");
    emitEvent("garden.plots.detected.csv", { source: "paste", headers: rows[0] || [] });
  }

  function onConfirmMapping(map) {
    try {
      const normalized = csvToPlots(rawRows, map, { type: "csv" });
      const unique = dedupe(normalized);
      setPlots(unique);
      setColumnMapNeeded(false);
      toast("success", `Mapped and imported ${unique.length} plot(s).`);
      emitEvent("garden.plots.imported", { source: "csv", count: unique.length });
    } catch (e) {
      console.error(e);
      setError("Mapping failed — check column selections.");
      toast("error", "Mapping failed.");
    }
  }

  function dedupe(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
    return out;
  }

  /* ----------------------------- Commit / Save flows ----------------------------- */
  function addToLibrary(selectedPlots) {
    // Option A: garden store if available
    if (gardenStore?.addPlots) {
      gardenStore.addPlots(selectedPlots);
    }
    // Option B: GardenQueueManager as a sink
    if (GardenQueueManager?.queue) {
      GardenQueueManager.queue({ type: "plots.added", payload: selectedPlots });
    }
    emitEvent("garden.plots.added", { count: selectedPlots.length, ids: selectedPlots.map((p) => p.id) });
    toast("success", `Added ${selectedPlots.length} plot(s) to your library.`);
  }

  function addToPlanner(selectedPlots) {
    // If you have a planner shell API, route there; for now, emit & queue
    if (GardenQueueManager?.queue) {
      GardenQueueManager.queue({ type: "planner.attach.plots", payload: selectedPlots });
    }
    emitEvent("garden.planner.attach", { count: selectedPlots.length });
    toast("success", `Sent ${selectedPlots.length} plot(s) to Planner.`);
  }

  function scheduleSoilPrep(selectedPlots) {
    if (!ReminderManager?.schedule) {
      toast("info", "Reminder manager unavailable; simulated schedule created.");
      emitEvent("garden.reminder.simulated", { kind: "soil-prep", count: selectedPlots.length });
      return;
    }
    const when = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // +1 week
    selectedPlots.forEach((p) => {
      ReminderManager.schedule({
        title: `Soil prep: ${p.name}`,
        notes: `Condition soil for ${p.kind}.`,
        date: when,
        tags: ["garden", "soil-prep"],
      });
    });
    toast("success", "Soil-prep reminders scheduled for next week.");
    emitEvent("garden.reminders.scheduled", { kind: "soil-prep", count: selectedPlots.length });
  }

  const selectedPlots = useMemo(() => {
    const ids = Object.entries(selection).filter(([_, v]) => v).map(([k]) => k);
    return plots.filter((p) => ids.includes(p.id));
  }, [selection, plots]);

  /* --------------------------------- Render UI -------------------------------- */
  return (
    <div className="rounded-2xl border bg-white p-4 md:p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-lg font-semibold text-gray-800">Plot Importer</div>
          <div className="text-sm text-gray-500">
            Import garden beds/plots from URL, file, paste, or draw a quick layout. CSV & JSON supported.
          </div>
        </div>
        <div className="flex items-center gap-2">
          {NBAInvokeButton ? (
            <NBAInvokeButton
              scope="garden"
              intent="collector"
              payload={{ component: "PlotImportPanel" }}
              className="!px-3 !py-2"
              label="Next Best Action"
            />
          ) : (
            <button
              className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
              onClick={() => emitEvent("nba.requested", { scope: "garden", from: "PlotImportPanel" })}
              title="Request NBA (fallback)"
            >
              Request NBA
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2">
        {["url", "upload", "paste", "draw"].map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-3 py-2 rounded-lg border text-sm ${
              activeTab === t ? "bg-gray-900 text-white border-gray-900" : "hover:bg-gray-50"
            }`}
          >
            {t === "url" && "From URL"}
            {t === "upload" && "Upload File"}
            {t === "paste" && "Paste"}
            {t === "draw" && "Draw a Plot"}
          </button>
        ))}
      </div>

      {/* Panels */}
      {activeTab === "url" && (
        <div className="rounded-xl border p-4">
          <div className="mb-2 text-sm text-gray-600">
            Paste a URL to a CSV/JSON (e.g., Google Sheets CSV export, GitHub raw JSON, NDJSON log).
          </div>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-lg border px-3 py-2"
              placeholder="https://example.com/my-plots.csv"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button className="rounded-lg border px-4 py-2 hover:bg-gray-50" onClick={handleURLImport}>
              Import
            </button>
          </div>
        </div>
      )}

      {activeTab === "upload" && (
        <div
          className="rounded-xl border p-6 text-center cursor-pointer hover:bg-gray-50"
          onClick={() => inputFileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) handleFileSelect(f);
          }}
        >
          <input
            ref={inputFileRef}
            type="file"
            accept=".csv,.json,.ndjson,application/json,text/csv"
            className="hidden"
            onChange={(e) => handleFileSelect(e.target.files?.[0])}
          />
          <div className="text-gray-700 font-medium">Drop a CSV/JSON here, or click to select</div>
          <div className="text-sm text-gray-500 mt-1">We’ll auto-detect the format.</div>
        </div>
      )}

      {activeTab === "paste" && <PastePanel onPaste={handlePaste} />}

      {activeTab === "draw" && <DrawPlotForm onCreate={(p) => setPlots((prev) => dedupe([p, ...prev]))} />}

      {/* Column Mapper */}
      {columnMapNeeded && csvHeaders.length ? (
        <div className="mt-4">
          <ColumnMapper headers={csvHeaders} onConfirm={onConfirmMapping} />
        </div>
      ) : null}

      {/* Preview & select */}
      {!!plots.length && !columnMapNeeded && (
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-gray-600">
              {plots.length} plot(s) ready • {selectedCount} selected
            </div>
            <div className="flex gap-2">
              <button
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
                onClick={() => setSelection(Object.fromEntries(plots.map((p) => [p.id, true])))}
              >
                Select all
              </button>
              <button
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
                onClick={() => setSelection({})}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {plots.map((p) => (
              <label
                key={p.id}
                className={`relative rounded-2xl border p-3 ${selection[p.id] ? "ring-2 ring-gray-900" : ""}`}
              >
                <div className="absolute top-2 right-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={!!selection[p.id]}
                    onChange={(e) => setSelection((s) => ({ ...s, [p.id]: e.target.checked }))}
                    aria-label={`Select ${p.name}`}
                  />
                </div>
                <PlotPreview plot={p} />
              </label>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="rounded-lg px-4 py-2 border hover:bg-gray-50 disabled:opacity-50"
              disabled={!selectedCount}
              onClick={() => addToLibrary(selectedPlots)}
            >
              Save to Library
            </button>
            <button
              className="rounded-lg px-4 py-2 border hover:bg-gray-50 disabled:opacity-50"
              disabled={!selectedCount}
              onClick={() => addToPlanner(selectedPlots)}
            >
              Add to Planner
            </button>
            <button
              className="rounded-lg px-4 py-2 border hover:bg-gray-50 disabled:opacity-50"
              disabled={!selectedCount}
              onClick={() => scheduleSoilPrep(selectedPlots)}
              title="Quick helper: schedule soil-prep reminders next week"
            >
              Schedule Soil-Prep
            </button>
          </div>
        </div>
      )}

      {/* Status / Error */}
      <div className="mt-3 min-h-[24px]">
        {status ? (
          <div
            className={`inline-block rounded-lg px-3 py-1.5 text-sm ${
              status.kind === "success"
                ? "bg-green-50 text-green-700 border border-green-200"
                : status.kind === "error"
                ? "bg-red-50 text-red-700 border border-red-200"
                : "bg-gray-50 text-gray-700 border border-gray-200"
            }`}
          >
            {status.message}
          </div>
        ) : error ? (
          <div className="inline-block rounded-lg px-3 py-1.5 text-sm bg-red-50 text-red-700 border border-red-200">
            {error}
          </div>
        ) : null}
      </div>

      {/* Footer helper */}
      <div className="mt-6 text-xs text-gray-500">
        Tip: CSV headers like <code>name,length,width,unit,rows,cols,tags,soil,notes</code> auto-map.
        JSON/NDJSON arrays of objects also work.
      </div>
    </div>
  );
}

/* -------------------------------- Subcomponents ------------------------------- */
function PastePanel({ onPaste }) {
  const [text, setText] = useState("");
  return (
    <div className="rounded-xl border p-4">
      <div className="mb-2 text-sm text-gray-600">
        Paste CSV, JSON array/object, or NDJSON (one JSON object per line).
      </div>
      <textarea
        className="w-full min-h-[140px] rounded-lg border px-3 py-2 font-mono text-sm"
        placeholder='[{"name":"Bed A","length":8,"width":4,"unit":"ft"}]'
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2 flex justify-end">
        <button className="rounded-lg border px-4 py-2 hover:bg-gray-50" onClick={() => onPaste(text)}>
          Import
        </button>
      </div>
    </div>
  );
}
