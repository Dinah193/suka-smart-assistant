/* eslint-disable no-console */
// src/pages/garden/CollectOrganize.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Garden — Collect & Organize
 * ----------------------------------------------------------------
 * What this gives you (aligned with earlier chats + your system goals):
 * - Multi-view inventory of garden items (primarily seeds, also tools/amendments).
 * - Loss modeling: seed viability decay per year + storage quality; per-item overrides.
 * - Threshold alerts & quick “Restock” export.
 * - Bulk paste CSV / simple lines; fast inline table editing (Notion-ish).
 * - Kanban by status (wishlist → ordered → on-hand → planted/used); buttons (no DnD req).
 * - Autosave, undo toast; safe shims for eventBus/NBA/automation.
 * - Export: Task Board / Calendar / Inventory / Garden Map; CSV download; print labels.
 */

// ------------------ Optional services (safe shims) ------------------
function createLocalBus() {
  const listeners = {};
  return {
    on(evt, cb) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
      return () =>
        (listeners[evt] = (listeners[evt] || []).filter((f) => f !== cb));
    },
    emit(evt, payload) {
      (listeners[evt] || []).forEach((cb) => {
        try {
          cb(payload);
        } catch (e) {
          console.warn("eventBus listener error:", e);
        }
      });
    },
  };
}
function useSafeEventBus() {
  const [bus, setBus] = useState(null);
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const mod = await import(
          /* webpackIgnore: true */ "../../services/events/eventBus.js"
        ).catch(() => null);
        if (on && mod?.eventBus) setBus(mod.eventBus);
      } catch {}
      if (on && !bus) setBus(createLocalBus());
    })();
    return () => {
      on = false;
    };
  }, []);
  return bus ?? createLocalBus();
}
function useSafeNBA() {
  const [invoke, setInvoke] = useState(() => () => {});
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const mod = await import(
          /* webpackIgnore: true */ "../../services/nbaOrchestrator.js"
        ).catch(() => null);
        if (on && mod?.invokeNBA) setInvoke(() => mod.invokeNBA);
      } catch {}
    })();
    return () => {
      on = false;
    };
  }, []);
  return invoke;
}
async function safeAutomation() {
  try {
    const mod = await import(
      /* webpackIgnore: true */ "@/services/automation/runtime"
    ).catch(() => null);
    return mod?.automation || { runTemplate: async () => ({}), emit: () => {} };
  } catch {
    return { runTemplate: async () => ({}), emit: () => {} };
  }
}

// ------------------ Local utils & constants ------------------
const LS_KEY = "garden.collect.organize.v1";
const LS_SETTINGS = LS_KEY + ".settings";

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

const DEFAULT_SETTINGS = {
  // seed viability modeling
  baseDecayPctPerYear: 15, // generic annual drop
  storageQuality: "cool_dark", // cool_dark | room | hot_humid
  qualityMultipliers: { cool_dark: 0.7, room: 1.0, hot_humid: 1.5 },
  // global safety buffers for inventory (breakage/spillage/miscount)
  handlingLossPct: 3,
};

const DEFAULT_ITEM = () => ({
  id: uid("it"),
  type: "seed", // seed | tool | amendment | other
  name: "", // e.g., Tomato
  cultivar: "", // e.g., San Marzano
  tags: [], // e.g., paste, heirloom, determinate
  status: "on-hand", // wishlist | ordered | on-hand | planted | used-up
  qty: 0,
  unit: "pkt", // pkt | g | lb | bag | each
  threshold: 0,
  source: "",
  price: "",
  location: "", // storage bin
  purchasedOn: "",
  lot: "",
  // seed specifics
  sowBy: "", // printed "sow by" if any
  harvestedYear: "", // for saved seed
  viabilityOverridePct: "", // manual override if provided
  // computed cache (not persisted): none needed
});

function parseBulk(text) {
  // Accept both CSV and simple lines.
  // CSV header recognized (case-insensitive): type,name,cultivar,qty,unit,tags,status,location,threshold,purchasedOn,source,price,lot,sowBy,harvestedYear,viabilityOverridePct
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const first = lines[0].toLowerCase();
  const hasHeader = /(^|,)\s*(type|name|cultivar|qty)\s*(,|$)/.test(first);
  const rows = hasHeader ? lines.slice(1) : lines;

  return rows.map((line) => {
    const parts = line.includes(",")
      ? line.split(",").map((s) => s.trim())
      : line.split("|").map((s) => s.trim());
    // Heuristics: try map by position
    const [
      type,
      name,
      cultivar,
      qty,
      unit,
      tags,
      status,
      location,
      threshold,
      purchasedOn,
      source,
      price,
      lot,
      sowBy,
      harvestedYear,
      viabilityOverridePct,
    ] = [
      ...parts,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ].slice(0, 16);
    return {
      ...DEFAULT_ITEM(),
      type: type || "seed",
      name: name || "",
      cultivar: cultivar || "",
      qty: numOr(qty, 0),
      unit: unit || "pkt",
      tags: splitTags(tags),
      status: status || "on-hand",
      location: location || "",
      threshold: numOr(threshold, 0),
      purchasedOn: purchasedOn || "",
      source: source || "",
      price: price || "",
      lot: lot || "",
      sowBy: sowBy || "",
      harvestedYear: harvestedYear || "",
      viabilityOverridePct: viabilityOverridePct || "",
    };
  });
}

function splitTags(s) {
  if (!s) return [];
  return String(s)
    .split(/[,;#]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function numOr(n, fb) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fb;
}

function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(100, v);
}

// Seed viability model: baseline * (1 - decay)^years * storage multiplier, then minus handling loss
function yearsSince(yearOrIso) {
  if (!yearOrIso) return 0;
  const y =
    String(yearOrIso).length === 4
      ? Number(yearOrIso)
      : new Date(yearOrIso).getUTCFullYear();
  if (!Number.isFinite(y)) return 0;
  const nowY = new Date().getUTCFullYear();
  return Math.max(0, nowY - y);
}

function estimateViabilityPct(item, settings) {
  // If override, use it
  if (item.viabilityOverridePct !== "" && item.type === "seed") {
    return clampPct(item.viabilityOverridePct);
  }
  if (item.type !== "seed") return 100;

  const years = item.harvestedYear
    ? yearsSince(item.harvestedYear)
    : item.sowBy
    ? yearsSince(item.sowBy)
    : 0;
  const decay = clampPct(settings.baseDecayPctPerYear) / 100;
  const mult = settings.qualityMultipliers[settings.storageQuality] || 1.0;

  const effDecay = Math.min(0.99, decay * mult);
  const viability = Math.pow(1 - effDecay, years) * 100;
  const handlingAdj = (100 - clampPct(settings.handlingLossPct)) / 100;
  return clampPct(viability * handlingAdj);
}

function suggestRestock(items) {
  return items.filter(
    (it) => Number(it.threshold) > 0 && Number(it.qty) <= Number(it.threshold)
  );
}

function downloadCSV(filename, rows) {
  const headers = [
    "type",
    "name",
    "cultivar",
    "qty",
    "unit",
    "tags",
    "status",
    "location",
    "threshold",
    "purchasedOn",
    "source",
    "price",
    "lot",
    "sowBy",
    "harvestedYear",
    "viabilityOverridePct",
  ];
  const csv = [headers.join(",")]
    .concat(
      rows.map((r) =>
        [
          r.type,
          r.name,
          r.cultivar,
          r.qty,
          r.unit,
          (r.tags || []).join("; "),
          r.status,
          r.location,
          r.threshold,
          r.purchasedOn,
          r.source,
          r.price,
          r.lot,
          r.sowBy,
          r.harvestedYear,
          r.viabilityOverridePct,
        ]
          .map((v) =>
            String(v).includes(",")
              ? `"${String(v).replace(/"/g, '""')}"`
              : String(v)
          )
          .join(",")
      )
    )
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------ UI atoms ------------------
function SectionCard({ title, actions, children }) {
  return (
    <div className="rounded-2xl border bg-white shadow-sm p-4 md:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{title}</h3>
        <div className="flex gap-2">{actions}</div>
      </div>
      {children}
    </div>
  );
}
function Field({ label, hint, children }) {
  return (
    <label className="block mb-3">
      <div className="text-xs uppercase tracking-wide mb-1 flex items-center gap-2">
        <span>{label}</span>
        {hint ? (
          <span className="text-[10px] text-gray-500">• {hint}</span>
        ) : null}
      </div>
      {children}
    </label>
  );
}
function Chip({ children, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="opacity-70 hover:opacity-100"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
function Toast({ toast, onUndo, onClose }) {
  if (!toast) return null;
  return (
    <div className="fixed bottom-4 right-4 max-w-sm rounded-xl bg-black text-white p-4 shadow-lg flex items-start gap-3 z-50">
      <div className="text-sm flex-1">
        <strong className="block">{toast.title}</strong>
        <span className="opacity-90">{toast.message}</span>
      </div>
      {toast.canUndo ? (
        <button
          className="underline text-sm mr-2"
          onClick={() => onUndo?.(toast)}
        >
          Undo
        </button>
      ) : null}
      <button
        className="opacity-80 hover:opacity-100"
        aria-label="close"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

// ------------------ Main ------------------
export default function CollectOrganize() {
  const eventBus = useSafeEventBus();
  const invokeNBA = useSafeNBA();

  const [items, setItems] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [settings, setSettings] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      return raw ? JSON.parse(raw) : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [tab, setTab] = useState("table"); // table | kanban | labels | preview
  const [q, setQ] = useState("");
  const [bulk, setBulk] = useState("");
  const [toast, setToast] = useState(null);
  const lastRemovedRef = useRef(null);

  // autosave
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(items));
    } catch {}
  }, [items]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  // derived
  const filtered = useMemo(() => {
    if (!q) return items;
    const f = q.toLowerCase();
    return items.filter(
      (it) =>
        (it.name || "").toLowerCase().includes(f) ||
        (it.cultivar || "").toLowerCase().includes(f) ||
        (it.type || "").toLowerCase().includes(f) ||
        (it.tags || []).some((t) => t.toLowerCase().includes(f)) ||
        (it.status || "").toLowerCase().includes(f) ||
        (it.location || "").toLowerCase().includes(f)
    );
  }, [items, q]);

  const restock = useMemo(() => suggestRestock(items), [items]);
  const kanban = useMemo(() => {
    const lanes = ["wishlist", "ordered", "on-hand", "planted", "used-up"];
    const map = Object.fromEntries(lanes.map((l) => [l, []]));
    filtered.forEach((it) =>
      (map[it.status || "on-hand"] || map["on-hand"]).push(it)
    );
    return { lanes, map };
  }, [filtered]);

  // actions
  const addRow = () => setItems((s) => [{ ...DEFAULT_ITEM() }, ...s]);
  const addBulk = () => {
    if (!bulk.trim()) return;
    const parsed = parseBulk(bulk);
    setItems((s) => [...parsed, ...s]);
    setBulk("");
    raiseToast("Import complete", `${parsed.length} items added.`, false);
  };
  const removeRow = (id) => {
    setItems((s) => {
      const idx = s.findIndex((r) => r.id === id);
      if (idx === -1) return s;
      const next = [...s];
      const [removed] = next.splice(idx, 1);
      lastRemovedRef.current = removed;
      return next;
    });
    raiseToast("Removed", "Item removed.", true);
  };
  const undoRemove = () => {
    if (!lastRemovedRef.current) return;
    setItems((s) => [lastRemovedRef.current, ...s]);
    lastRemovedRef.current = null;
    dismissToast();
  };
  const updateRow = (id, patch) =>
    setItems((s) => s.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const setStatus = (id, status) => updateRow(id, { status });

  const clearAll = () => {
    if (!confirm("Clear all items? This cannot be undone.")) return;
    setItems([]);
    raiseToast("Cleared", "All items removed.", false);
  };

  // export & automation
  const sendTo = async (target, payloadExtra = {}) => {
    eventBus.emit("export.requested", {
      kind: "garden-collect",
      target,
      items,
      settings,
      at: Date.now(),
      ...payloadExtra,
    });
    raiseToast("Sent", `Exported to ${target}.`, false);
    try {
      invokeNBA?.({
        reason: "garden_collect_export",
        context: { target, count: items.length },
      });
    } catch {}
  };

  const generateLabels = () => buildLabels(items, settings);
  const exportCSV = () => downloadCSV("garden-collect.csv", items);

  const planWithAI = async () => {
    const automation = await safeAutomation();
    try {
      const res = await automation.runTemplate("garden.collect.normalize", {
        items,
        settings,
      });
      if (Array.isArray(res?.items)) setItems(res.items);
      raiseToast("AI normalize", "Cleaned fields & tags.", false);
    } catch {
      automation.emit?.("event", {
        type: "garden/collect_normalize_request",
        payload: { items },
      });
      raiseToast("Queued", "Requested normalization via automation.", false);
    }
  };

  const restockToTasks = () => {
    const list = suggestRestock(items);
    sendTo("Task Board", { tasks: list.map(toRestockTask) });
  };

  // toast helpers
  const raiseToast = (title, message, canUndo) =>
    setToast({ id: uid("t"), title, message, canUndo });
  const dismissToast = () => setToast(null);

  // ------------------ Render ------------------
  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <header className="mb-4 md:mb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl md:text-2xl font-semibold">
            🗂️ Garden — Collect & Organize
          </h1>
          <div className="flex items-center gap-2">
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={planWithAI}
            >
              AI Normalize
            </button>
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => sendTo("Inventory")}
            >
              Send → Inventory
            </button>
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => sendTo("Task Board")}
            >
              Send → Task Board
            </button>
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={exportCSV}
            >
              Export CSV
            </button>
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-red-50 text-red-600"
              onClick={clearAll}
            >
              Clear
            </button>
          </div>
        </div>
        <nav className="mt-4 flex gap-2">
          {[
            { k: "table", t: "Table" },
            { k: "kanban", t: "Kanban" },
            { k: "labels", t: "Labels" },
            { k: "preview", t: "Summary" },
          ].map((x) => (
            <button
              key={x.k}
              onClick={() => setTab(x.k)}
              className={`px-3 py-1.5 rounded-lg text-sm border ${
                tab === x.k
                  ? "bg-black text-white border-black"
                  : "hover:bg-gray-50"
              }`}
            >
              {x.t}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter name/tag/location…"
              className="px-3 py-1.5 text-sm rounded-lg border w-64"
            />
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={addRow}
            >
              + Item
            </button>
          </div>
        </nav>
      </header>

      {/* SETTINGS */}
      <div className="grid lg:grid-cols-3 gap-4">
        <SectionCard title="Seed Viability & Loss Settings">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Annual decay % (base)" hint="generic viability drop">
              <input
                className="w-full border rounded-md px-2 py-1"
                inputMode="decimal"
                value={settings.baseDecayPctPerYear}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    baseDecayPctPerYear: clampPct(e.target.value),
                  }))
                }
              />
            </Field>
            <Field label="Storage quality" hint="affects decay rate">
              <select
                className="w-full border rounded-md px-2 py-1"
                value={settings.storageQuality}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, storageQuality: e.target.value }))
                }
              >
                {["cool_dark", "room", "hot_humid"].map((k) => (
                  <option key={k} value={k}>
                    {k.replace("_", " ")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Handling loss %" hint="spillage/miscount">
              <input
                className="w-full border rounded-md px-2 py-1"
                inputMode="decimal"
                value={settings.handlingLossPct}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    handlingLossPct: clampPct(e.target.value),
                  }))
                }
              />
            </Field>
          </div>
          <div className="text-xs text-gray-600 mt-2">
            Items can override viability in the table (Viability % column).
          </div>
        </SectionCard>

        <SectionCard
          title="Bulk Paste / Import"
          actions={
            <button
              onClick={addBulk}
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              Parse & Add
            </button>
          }
        >
          <Field
            label="Paste CSV or simple lines"
            hint='CSV headers: type,name,cultivar,qty,unit,tags,status,location,threshold,purchasedOn,source,price,lot,sowBy,harvestedYear,viabilityOverridePct  •  Simple: "seed,Tomato,San Marzano,1,pkt,heirloom;paste,on-hand"'
          >
            <textarea
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              rows={8}
              placeholder={`e.g.\nseed,Tomato,San Marzano,1,pkt,heirloom;paste,on-hand,Bin A,1,2025-02-01,Botanical,3.50\namendment,Compost,,2,bag,organic,ordered,Shed,1`}
              className="w-full rounded-xl border p-2 text-sm"
            />
          </Field>
        </SectionCard>

        <SectionCard
          title="Restock Alerts"
          actions={
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={restockToTasks}
            >
              Create Restock Tasks
            </button>
          }
        >
          {restock.length ? (
            <ul className="text-sm space-y-1">
              {restock.map((it) => (
                <li key={it.id}>
                  <strong>
                    {it.name}
                    {it.cultivar ? ` — ${it.cultivar}` : ""}
                  </strong>{" "}
                  • {it.qty} {it.unit} in {it.location || "—"} (≤ {it.threshold}
                  )
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-gray-600">
              No items below threshold.
            </div>
          )}
        </SectionCard>
      </div>

      {/* TABLE VIEW */}
      {tab === "table" && (
        <SectionCard
          title="Items (Table)"
          actions={
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={addRow}
            >
              + Item
            </button>
          }
        >
          {items.length ? (
            <InventoryTable
              rows={filtered}
              updateRow={updateRow}
              removeRow={removeRow}
              settings={settings}
              estimateViabilityPct={estimateViabilityPct}
            />
          ) : (
            <EmptyState onAdd={addRow} />
          )}
        </SectionCard>
      )}

      {/* KANBAN VIEW */}
      {tab === "kanban" && (
        <SectionCard title="Status Board (Kanban)">
          <Kanban
            lanes={kanban.lanes}
            map={kanban.map}
            setStatus={setStatus}
            removeRow={removeRow}
          />
        </SectionCard>
      )}

      {/* LABELS */}
      {tab === "labels" && (
        <SectionCard
          title="Labels"
          actions={
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => window.print()}
            >
              Print
            </button>
          }
        >
          <LabelsPreview labels={generateLabels()} />
        </SectionCard>
      )}

      {/* SUMMARY */}
      {tab === "preview" && (
        <SectionCard
          title="Summary"
          actions={
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => sendTo("Inventory")}
            >
              Send → Inventory
            </button>
          }
        >
          <SummaryCard
            items={filtered}
            settings={settings}
            estimateViabilityPct={estimateViabilityPct}
          />
        </SectionCard>
      )}

      <Toast toast={toast} onUndo={undoRemove} onClose={dismissToast} />
    </div>
  );
}

// ------------------ Subcomponents ------------------
function InventoryTable({
  rows,
  updateRow,
  removeRow,
  settings,
  estimateViabilityPct,
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            {[
              "Type",
              "Name",
              "Cultivar",
              "Qty",
              "Unit",
              "Status",
              "Tags",
              "Location",
              "Threshold",
              "Purchased",
              "Source",
              "Price",
              "Sow by",
              "Harvested Yr",
              "Viability %",
              "",
            ].map((h) => (
              <th key={h} className="py-2 pr-3 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const viability = estimateViabilityPct(r, settings);
            const atRisk = r.type === "seed" && viability < 60;
            return (
              <tr key={r.id} className="border-b">
                <td className="py-2 pr-3">
                  <select
                    className="w-28 border rounded-md px-2 py-1"
                    value={r.type}
                    onChange={(e) => updateRow(r.id, { type: e.target.value })}
                  >
                    {["seed", "tool", "amendment", "other"].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-3">
                  <input
                    value={r.name}
                    onChange={(e) => updateRow(r.id, { name: e.target.value })}
                    placeholder="Name"
                    className="w-44 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    value={r.cultivar}
                    onChange={(e) =>
                      updateRow(r.id, { cultivar: e.target.value })
                    }
                    placeholder="Cultivar"
                    className="w-40 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="number"
                    min="0"
                    value={r.qty}
                    onChange={(e) =>
                      updateRow(r.id, { qty: numOr(e.target.value, r.qty) })
                    }
                    className="w-20 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    value={r.unit}
                    onChange={(e) => updateRow(r.id, { unit: e.target.value })}
                    placeholder="pkt"
                    className="w-20 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <select
                    className="w-28 border rounded-md px-2 py-1"
                    value={r.status}
                    onChange={(e) =>
                      updateRow(r.id, { status: e.target.value })
                    }
                  >
                    {[
                      "wishlist",
                      "ordered",
                      "on-hand",
                      "planted",
                      "used-up",
                    ].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-3">
                  <TagEditor
                    tags={r.tags}
                    onChange={(tags) => updateRow(r.id, { tags })}
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    value={r.location}
                    onChange={(e) =>
                      updateRow(r.id, { location: e.target.value })
                    }
                    placeholder="Bin/Room"
                    className="w-28 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="number"
                    min="0"
                    value={r.threshold}
                    onChange={(e) =>
                      updateRow(r.id, {
                        threshold: numOr(e.target.value, r.threshold),
                      })
                    }
                    className="w-20 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    value={r.purchasedOn}
                    onChange={(e) =>
                      updateRow(r.id, { purchasedOn: e.target.value })
                    }
                    placeholder="YYYY-MM-DD"
                    className="w-28 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    value={r.source}
                    onChange={(e) =>
                      updateRow(r.id, { source: e.target.value })
                    }
                    placeholder="Vendor"
                    className="w-28 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    value={r.price}
                    onChange={(e) => updateRow(r.id, { price: e.target.value })}
                    placeholder="$"
                    className="w-20 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    value={r.sowBy}
                    onChange={(e) => updateRow(r.id, { sowBy: e.target.value })}
                    placeholder="YYYY-MM-DD or year"
                    className="w-28 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    value={r.harvestedYear}
                    onChange={(e) =>
                      updateRow(r.id, { harvestedYear: e.target.value })
                    }
                    placeholder="YYYY"
                    className="w-20 border rounded-md px-2 py-1"
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    value={r.viabilityOverridePct}
                    onChange={(e) =>
                      updateRow(r.id, { viabilityOverridePct: e.target.value })
                    }
                    placeholder={String(
                      estimateViabilityPct(r, settings).toFixed(0)
                    )}
                    className={`w-20 border rounded-md px-2 py-1 ${
                      atRisk ? "bg-red-50" : ""
                    }`}
                  />
                </td>
                <td className="py-2 pr-3 text-right">
                  <button
                    onClick={() => removeRow(r.id)}
                    className="text-red-600 text-xs rounded-lg border px-2 py-1 hover:bg-red-50"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TagEditor({ tags = [], onChange }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((t, i) => (
        <Chip
          key={`${t}-${i}`}
          onRemove={() => onChange(tags.filter((_, idx) => idx !== i))}
        >
          {t}
        </Chip>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            onChange([...(tags || []), draft.trim()]);
            setDraft("");
          }
        }}
        placeholder="add tag"
        className="w-24 border rounded-md px-2 py-1 text-xs"
      />
    </div>
  );
}

function Kanban({ lanes, map, setStatus, removeRow }) {
  return (
    <div className="grid md:grid-cols-5 gap-3">
      {lanes.map((lane) => (
        <div key={lane} className="rounded-xl border p-3 bg-gray-50/40">
          <div className="text-xs uppercase tracking-wide mb-2 font-semibold">
            {lane}
          </div>
          <div className="space-y-2">
            {(map[lane] || []).map((it) => (
              <div key={it.id} className="rounded-lg border bg-white p-3">
                <div className="font-medium text-sm">
                  {it.name}
                  {it.cultivar ? ` — ${it.cultivar}` : ""}
                </div>
                <div className="text-xs text-gray-600">
                  {it.qty} {it.unit} • {it.location || "—"}
                </div>
                <div className="mt-2 flex gap-1 flex-wrap">
                  {lanes
                    .filter((l) => l !== lane)
                    .slice(0, 3)
                    .map((target) => (
                      <button
                        key={target}
                        className="rounded border px-2 py-0.5 text-xs hover:bg-gray-50"
                        onClick={() => setStatus(it.id, target)}
                      >
                        → {target}
                      </button>
                    ))}
                  <button
                    className="ml-auto text-red-600 text-xs rounded border px-2 py-0.5 hover:bg-red-50"
                    onClick={() => removeRow(it.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            {!(map[lane] || []).length && (
              <div className="text-xs text-gray-500">Empty</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function LabelsPreview({ labels }) {
  if (!labels.length)
    return <div className="text-sm text-stone-500">Nothing to print.</div>;
  return (
    <div className="grid md:grid-cols-3 gap-3">
      {labels.map((l) => (
        <div key={l.id} className="rounded-lg border p-3 text-sm">
          <div className="font-semibold">{l.name}</div>
          <div className="text-xs text-gray-600">{l.cultivar || "—"}</div>
          <div className="text-xs">Type: {l.type}</div>
          <div className="text-xs">
            Qty: {l.qty} {l.unit}
          </div>
          {l.sowBy ? <div className="text-xs">Sow by: {l.sowBy}</div> : null}
          {l.harvestedYear ? (
            <div className="text-xs">Harvested: {l.harvestedYear}</div>
          ) : null}
          <div className="text-[11px] mt-1 opacity-70">
            Tags: {(l.tags || []).join(", ") || "—"}
          </div>
          <div className="text-[11px] opacity-70">
            Loc: {l.location || "—"} • Lot: {l.lot || "—"}
          </div>
        </div>
      ))}
    </div>
  );
}

function SummaryCard({ items, settings, estimateViabilityPct }) {
  const totals = useMemo(() => {
    const byType = new Map();
    const seedRisk = [];
    items.forEach((it) => {
      const key = it.type || "other";
      byType.set(key, (byType.get(key) || 0) + 1);
      if (it.type === "seed" && estimateViabilityPct(it, settings) < 60)
        seedRisk.push(it);
    });
    return {
      byType: Array.from(byType, ([k, v]) => ({ type: k, count: v })),
      seedRisk,
    };
  }, [items, settings, estimateViabilityPct]);

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="rounded-xl border p-4">
        <div className="font-semibold mb-2">Counts by Type</div>
        {totals.byType.length ? (
          <ul className="text-sm space-y-1">
            {totals.byType.map((x) => (
              <li key={x.type}>
                <strong className="capitalize">{x.type}</strong>: {x.count}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-gray-600">No items.</div>
        )}
      </div>
      <div className="rounded-xl border p-4">
        <div className="font-semibold mb-2">Low Viability Seeds (&lt; 60%)</div>
        {totals.seedRisk.length ? (
          <ul className="text-sm space-y-1">
            {totals.seedRisk.map((it) => (
              <li key={it.id}>
                <strong>
                  {it.name}
                  {it.cultivar ? ` — ${it.cultivar}` : ""}
                </strong>{" "}
                • est. {estimateViabilityPct(it, settings).toFixed(0)}%
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-gray-600">None flagged.</div>
        )}
      </div>
    </div>
  );
}

// ------------------ builders ------------------
function buildLabels(items, settings) {
  return items.map((r) => ({
    id: uid("label"),
    type: r.type,
    name: r.name || "—",
    cultivar: r.cultivar || "",
    qty: r.qty || 0,
    unit: r.unit || "",
    tags: r.tags || [],
    location: r.location || "",
    lot: r.lot || "",
    sowBy: r.sowBy || "",
    harvestedYear: r.harvestedYear || "",
    viability: estimateViabilityPct(r, settings),
  }));
}

function toRestockTask(it) {
  return {
    id: uid("task"),
    name: `Restock ${it.name}${it.cultivar ? ` — ${it.cultivar}` : ""}`,
    description: `Qty: ${it.qty} ${it.unit} in ${
      it.location || "—"
    } (threshold ${it.threshold}). Vendor: ${it.source || "—"}.`,
    assignedRole: "Purchasing",
    tags: ["garden", "restock"],
  };
}

function EmptyState({
  onAdd,
  label = "No items yet",
  sub = "Start with a quick row or paste CSV.",
  btn = "Add a blank item",
}) {
  return (
    <div className="border-2 border-dashed rounded-2xl p-8 text-center">
      <h4 className="font-semibold mb-1">{label}</h4>
      <p className="text-sm text-gray-600 mb-4">{sub}</p>
      <button
        onClick={onAdd}
        className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
      >
        {btn}
      </button>
    </div>
  );
}
