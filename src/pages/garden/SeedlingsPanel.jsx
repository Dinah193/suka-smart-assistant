/* eslint-disable no-console */
// src/pages/garden/SeedlingsPanel.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * SeedlingsPanel — seed starting, trays & schedules
 * ----------------------------------------------------------------
 * Goals & features (aligned with Suka project):
 * - Collector surface: Quick Add + Bulk Paste CSV.
 * - Loss modeling: germination % and attrition % → expected usable starts.
 * - Dates: start → germinate → up-pot → harden-off → transplant (with offsets).
 * - Succession planning: repeat N times every X days/weeks.
 * - Trays: tray id, cells, per-cell sowing, light hours, heat mat, watering cadence.
 * - Hardening-off blocks (daily) with “Sabbath Guard” like skip option.
 * - Print labels (variety/row/tray), export → Task Board / Calendar / Inventory / Garden Map.
 * - Optional integrations (safe shims): eventBus, NBA, scheduleHelpers, labeling, automation templates.
 * - Autosave draft, undo toast, compact Notion/Linear-style UI.
 */

// ------------------ Optional services (safe shims) ------------------
function createLocalBus() {
  const listeners = {};
  return {
    on(evt, cb) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
      return () => (listeners[evt] = (listeners[evt] || []).filter((f) => f !== cb));
    },
    emit(evt, payload) {
      (listeners[evt] || []).forEach((cb) => {
        try { cb(payload); } catch (e) { console.warn("eventBus listener error:", e); }
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
        const mod = await import(/* webpackIgnore: true */ "../../services/eventBus.js").catch(() => null);
        if (on && mod?.eventBus) setBus(mod.eventBus);
      } catch {}
      if (on && !bus) setBus(createLocalBus());
    })();
    return () => { on = false; };
  }, []);
  return bus ?? createLocalBus();
}
function useSafeNBA() {
  const [invoke, setInvoke] = useState(() => () => {});
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const mod = await import(/* webpackIgnore: true */ "../../services/nbaOrchestrator.js").catch(() => null);
        if (on && mod?.invokeNBA) setInvoke(() => mod.invokeNBA);
      } catch {}
    })();
    return () => { on = false; };
  }, []);
  return invoke;
}
async function safeScheduleHelpers() {
  try {
    const mod = await import(/* webpackIgnore: true */ "../../engines/scheduling/scheduleHelpers.js").catch(() => null);
    return mod || {};
  } catch { return {}; }
}
async function safeLabelEngine() {
  try {
    const mod = await import(/* webpackIgnore: true */ "../../engines/labels/labelEngine.js").catch(() => null);
    return mod || {};
  } catch { return {}; }
}
async function safeAutomation() {
  try {
    const mod = await import(/* webpackIgnore: true */ "@/services/automation/runtime").catch(() => null);
    return mod?.automation || { runTemplate: async () => ({}), emit: () => {} };
  } catch { return { runTemplate: async () => ({}), emit: () => {} }; }
}

// ------------------ Local utils ------------------
const LS_KEY = "garden.seedlings.draft.v1";

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

const DEFAULTS = {
  trayCells: 72,
  perCellSeeds: 1,
  germDays: 6,
  upPotDays: 21,
  hardenDays: 7,
  transplantDays: 35,
  lightHours: 16,
  waterEveryDays: 2,
  germinationPct: 85,
  attritionPct: 10,
};

function parseBulk(text) {
  // CSV: variety,cultivar,tray,cells,perCell,start,germDays,upPotDays,hardenDays,transplantDays,germinationPct,attritionPct,notes
  // Simple: "Roma Tomato, 72, 2, 2025-03-15"
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((s) => s.trim());
      if (parts.length >= 4) {
        const [variety, cells, perCell, start, cultivar] = [parts[0], parts[1], parts[2], parts[3], parts[4]];
        return seedRow({
          variety: variety || "",
          cultivar: cultivar || "",
          tray: "",
          cells: numOr(cells, DEFAULTS.trayCells),
          perCell: numOr(perCell, DEFAULTS.perCellSeeds),
          start: start || "",
        });
      }
      // fallback with pipes: "Tray A | Lettuce | 128 | start 2025-02-20"
      const p2 = line.split("|").map((s) => s.trim());
      return seedRow({
        tray: p2[0] || "",
        variety: p2[1] || "",
        cells: numOr(p2[2], DEFAULTS.trayCells),
        start: (p2[3] || "").replace(/^start\s*/i, ""),
      });
    });
}

function seedRow(overrides = {}) {
  return {
    id: uid("seed"),
    tray: "",
    variety: "",
    cultivar: "",
    cells: DEFAULTS.trayCells,
    perCell: DEFAULTS.perCellSeeds,
    start: "",
    germDays: DEFAULTS.germDays,
    upPotDays: DEFAULTS.upPotDays,
    hardenDays: DEFAULTS.hardenDays,
    transplantDays: DEFAULTS.transplantDays,
    lightHours: DEFAULTS.lightHours,
    heatMat: false,
    waterEveryDays: DEFAULTS.waterEveryDays,
    germinationPct: DEFAULTS.germinationPct,
    attritionPct: DEFAULTS.attritionPct,
    successions: { repeats: 0, everyDays: 14 }, // 0 = none
    notes: "",
    ...overrides,
  };
}

function addDays(iso, days) {
  if (!iso) return "";
  const d = new Date(iso);
  if (String(d) === "Invalid Date") return "";
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function predictTimeline(row) {
  const germ = addDays(row.start, row.germDays);
  const upPot = addDays(row.start, row.upPotDays);
  const hardenStart = addDays(row.start, row.transplantDays - row.hardenDays);
  const transplant = addDays(row.start, row.transplantDays);
  return { germ, upPot, hardenStart, transplant };
}

function expectedStarts(row) {
  const sown = Number(row.cells || 0) * Number(row.perCell || 0);
  const genn = sown * clampRate(row.germinationPct);
  const keep = genn * (1 - clampRate(row.attritionPct));
  return { sown, germinated: Math.round(genn), expected: Math.round(keep) };
}

function clampRate(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(1, v / 100);
}

function numOr(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
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
        {hint ? <span className="text-[10px] text-gray-500">• {hint}</span> : null}
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
        <button type="button" onClick={onRemove} className="opacity-70 hover:opacity-100">×</button>
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
        <button className="underline text-sm mr-2" onClick={() => onUndo?.(toast)}>Undo</button>
      ) : null}
      <button className="opacity-80 hover:opacity-100" aria-label="close" onClick={onClose}>×</button>
    </div>
  );
}

// ------------------ Main ------------------
export default function SeedlingsPanel() {
  const eventBus = useSafeEventBus();
  const invokeNBA = useSafeNBA();

  const [rows, setRows] = useState(() => {
    try {
      const cached = localStorage.getItem(LS_KEY);
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });
  const [tab, setTab] = useState("collect"); // collect | plan | schedule | labels | preview
  const [bulk, setBulk] = useState("");
  const [q, setQ] = useState("");
  const [toast, setToast] = useState(null);
  const lastRemovedRef = useRef(null);

  // Autosave
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(rows)); } catch {}
  }, [rows]);

  // Derived filtered rows
  const filtered = useMemo(() => {
    if (!q) return rows;
    const f = q.toLowerCase();
    return rows.filter(r =>
      (r.variety || "").toLowerCase().includes(f) ||
      (r.cultivar || "").toLowerCase().includes(f) ||
      (r.tray || "").toLowerCase().includes(f)
    );
  }, [rows, q]);

  // Actions
  const addQuick = () => setRows((s) => [seedRow(), ...s]);
  const addBulk = () => {
    if (!bulk.trim()) return;
    const parsed = parseBulk(bulk);
    setRows((s) => [...parsed, ...s]);
    setBulk("");
    raiseToast("Bulk import complete", `${parsed.length} seed lines added.`, false);
  };
  const removeRow = (id) => {
    setRows((s) => {
      const idx = s.findIndex((r) => r.id === id);
      if (idx === -1) return s;
      const next = [...s];
      const [removed] = next.splice(idx, 1);
      lastRemovedRef.current = removed;
      return next;
    });
    raiseToast("Removed", "Seed line removed.", true);
  };
  const undoRemove = () => {
    if (!lastRemovedRef.current) return;
    setRows((s) => [lastRemovedRef.current, ...s]);
    lastRemovedRef.current = null;
    dismissToast();
  };
  const updateRow = (id, patch) => setRows((s) => s.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const clearAll = () => {
    if (!confirm("Clear all seed lines? This cannot be undone.")) return;
    setRows([]);
    raiseToast("Cleared", "All seed lines removed.", false);
  };

  // Planning helpers
  const normalizeAll = () => {
    setRows((s) =>
      s.map((r) => {
        const cells = r.cells || DEFAULTS.trayCells;
        const perCell = r.perCell || DEFAULTS.perCellSeeds;
        const next = { ...r, cells, perCell };
        return next;
      })
    );
    raiseToast("Normalized", "Default cells/per-cell applied where missing.", false);
  };

  // Export
  const sendTo = async (target) => {
    const sched = await safeScheduleHelpers();
    const payload = buildSchedule(rows, sched);
    eventBus.emit("export.requested", {
      kind: "seedlings",
      target,
      rows,
      schedule: payload,
      at: Date.now(),
    });
    raiseToast("Sent", `Exported to ${target}.`, false);
    try { invokeNBA?.({ reason: "seedlings_export", context: { target, count: rows.length } }); } catch {}
  };

  // Automation templates (optional)
  const planWithAI = async () => {
    const automation = await safeAutomation();
    try {
      const res = await automation.runTemplate("garden.seedlings.plan", { rows });
      if (Array.isArray(res?.rows)) setRows(res.rows);
      raiseToast("AI plan applied", "Dates/fields updated.", false);
    } catch (e) {
      automation.emit?.("event", { type: "garden/seedlings_plan_request", payload: { rows } });
      raiseToast("Queued", "Requested plan via automation.", false);
    }
  };
  const syncQueue = async () => {
    const automation = await safeAutomation();
    try {
      const res = await automation.runTemplate("garden.seedlings.queue.sync", { rows });
      eventBus.emit("export.requested", { kind: "seedlings", target: "Task Board", rows, tasks: res?.tasks || [] });
      raiseToast("Tasks created", `${(res?.tasks || []).length} tasks sent to Task Board.`, false);
    } catch {
      automation.emit?.("event", { type: "garden/seedlings_queue_sync_request", payload: { rows } });
      raiseToast("Queued", "Requested task sync via automation.", false);
    }
  };
  const printLabels = async () => {
    const lab = await safeLabelEngine();
    try {
      if (lab?.print) {
        await lab.print(buildLabels(rows));
      } else {
        window.print();
      }
      raiseToast("Labels", "Print job initiated.", false);
    } catch {
      window.print();
      raiseToast("Labels", "Fallback print started.", false);
    }
  };

  const raiseToast = (title, message, canUndo) => setToast({ id: uid("t"), title, message, canUndo });
  const dismissToast = () => setToast(null);

  // ------------------ Render ------------------
  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <header className="mb-4 md:mb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl md:text-2xl font-semibold">🌱 Seedlings — Start • Schedule • Label</h1>
          <div className="flex items-center gap-2">
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={normalizeAll}>Normalize</button>
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Task Board")}>Send → Task Board</button>
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Calendar")}>Send → Calendar</button>
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Inventory")}>Send → Inventory</button>
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Garden Map")}>Send → Garden Map</button>
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={printLabels}>Print Labels</button>
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-red-50 text-red-600" onClick={clearAll}>Clear</button>
          </div>
        </div>
        <nav className="mt-4 flex gap-2">
          {[
            { k: "collect", t: "Collect" },
            { k: "plan", t: "Plan" },
            { k: "schedule", t: "Schedule" },
            { k: "labels", t: "Labels" },
            { k: "preview", t: "Summary" },
          ].map((x) => (
            <button
              key={x.k}
              onClick={() => setTab(x.k)}
              className={`px-3 py-1.5 rounded-lg text-sm border ${tab === x.k ? "bg-black text-white border-black" : "hover:bg-gray-50"}`}
            >
              {x.t}
            </button>
          ))}
          <div className="ml-auto">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter variety/tray…"
              className="px-3 py-1.5 text-sm rounded-lg border w-56"
            />
          </div>
        </nav>
      </header>

      {/* COLLECT */}
      {tab === "collect" && (
        <div className="grid md:grid-cols-2 gap-4">
          <SectionCard
            title="Quick Add"
            actions={<button onClick={addQuick} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50">+ Row</button>}
          >
            {rows.length === 0 ? (
              <EmptyState onAdd={addQuick} />
            ) : (
              <SeedlingsTable rows={filtered} updateRow={updateRow} removeRow={removeRow} />
            )}
          </SectionCard>

          <SectionCard
            title="Bulk Paste / Import"
            actions={<button onClick={addBulk} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50">Parse & Add</button>}
          >
            <Field
              label="Paste CSV or simple lines"
              hint='CSV: variety,cultivar,tray,cells,perCell,start,…  •  Simple: "Roma Tomato, 72, 2, 2025-03-15"'
            >
              <textarea
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
                rows={10}
                placeholder={`e.g.\nLettuce,Salad Bowl,Tray A,128,1,2025-03-05\nRoma Tomato,72,2,2025-03-15`}
                className="w-full rounded-xl border p-2 text-sm"
              />
            </Field>
            <div className="text-xs text-gray-600">Defaults apply for missing fields; edit details in Plan tab.</div>
          </SectionCard>
        </div>
      )}

      {/* PLAN */}
      {tab === "plan" && (
        <SectionCard
          title="Plan Details & Loss Modeling"
          actions={
            <>
              <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={planWithAI}>
                AI Plan
              </button>
              <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={syncQueue}>
                Create Tasks
              </button>
            </>
          }
        >
          {rows.length === 0 ? (
            <EmptyState onAdd={() => setTab("collect")} label="No seed lines" sub="Add rows in Collect." btn="Go to Collect" />
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {filtered.map((r) => {
                const tl = predictTimeline(r);
                const stats = expectedStarts(r);
                return (
                  <div key={r.id} className="rounded-xl border p-4">
                    <div className="flex items-center justify-between mb-2">
                      <input
                        value={r.variety}
                        onChange={(e) => updateRow(r.id, { variety: e.target.value })}
                        placeholder="Variety (e.g., Roma Tomato)"
                        className="font-semibold w-64 border rounded-md px-2 py-1"
                      />
                      <button onClick={() => removeRow(r.id)} className="text-red-600 text-xs rounded-lg border px-2 py-1 hover:bg-red-50">
                        Remove
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Cultivar / Notes">
                        <input
                          value={r.cultivar}
                          onChange={(e) => updateRow(r.id, { cultivar: e.target.value })}
                          placeholder="e.g., San Marzano"
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>
                      <Field label="Tray / Location">
                        <input
                          value={r.tray}
                          onChange={(e) => updateRow(r.id, { tray: e.target.value })}
                          placeholder="e.g., Tray A"
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>

                      <Field label="Cells">
                        <input
                          type="number"
                          min="1"
                          value={r.cells}
                          onChange={(e) => updateRow(r.id, { cells: numOr(e.target.value, r.cells) })}
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>
                      <Field label="Seeds / cell">
                        <input
                          type="number"
                          min="1"
                          value={r.perCell}
                          onChange={(e) => updateRow(r.id, { perCell: numOr(e.target.value, r.perCell) })}
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>

                      <Field label="Start date (YYYY-MM-DD)">
                        <input
                          value={r.start}
                          onChange={(e) => updateRow(r.id, { start: e.target.value })}
                          placeholder="2025-03-05"
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>
                      <Field label="Germ days">
                        <input
                          type="number"
                          min="0"
                          value={r.germDays}
                          onChange={(e) => updateRow(r.id, { germDays: numOr(e.target.value, r.germDays) })}
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>

                      <Field label="Up-pot (days from start)">
                        <input
                          type="number"
                          min="0"
                          value={r.upPotDays}
                          onChange={(e) => updateRow(r.id, { upPotDays: numOr(e.target.value, r.upPotDays) })}
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>
                      <Field label="Transplant (days from start)">
                        <input
                          type="number"
                          min="0"
                          value={r.transplantDays}
                          onChange={(e) => updateRow(r.id, { transplantDays: numOr(e.target.value, r.transplantDays) })}
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>

                      <Field label="Harden-off (days)">
                        <input
                          type="number"
                          min="0"
                          value={r.hardenDays}
                          onChange={(e) => updateRow(r.id, { hardenDays: numOr(e.target.value, r.hardenDays) })}
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>
                      <Field label="Light hours">
                        <input
                          type="number"
                          min="0"
                          value={r.lightHours}
                          onChange={(e) => updateRow(r.id, { lightHours: numOr(e.target.value, r.lightHours) })}
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>

                      <Field label="Heat mat">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={!!r.heatMat}
                            onChange={(e) => updateRow(r.id, { heatMat: e.target.checked })}
                          />
                          <span className="text-sm">On</span>
                        </label>
                      </Field>
                      <Field label="Water every (days)">
                        <input
                          type="number"
                          min="1"
                          value={r.waterEveryDays}
                          onChange={(e) => updateRow(r.id, { waterEveryDays: numOr(e.target.value, r.waterEveryDays) })}
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>

                      <Field label="Germination %" hint="expected emergence">
                        <input
                          type="number"
                          min="0"
                          value={r.germinationPct}
                          onChange={(e) => updateRow(r.id, { germinationPct: numOr(e.target.value, r.germinationPct) })}
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>
                      <Field label="Attrition %" hint="damping-off/culls">
                        <input
                          type="number"
                          min="0"
                          value={r.attritionPct}
                          onChange={(e) => updateRow(r.id, { attritionPct: numOr(e.target.value, r.attritionPct) })}
                          className="w-full border rounded-md px-2 py-1"
                        />
                      </Field>

                      <Field label="Successions" hint="repeats × every N days">
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="number"
                            min="0"
                            value={r.successions?.repeats ?? 0}
                            onChange={(e) => updateRow(r.id, { successions: { ...(r.successions || {}), repeats: numOr(e.target.value, 0) } })}
                            className="w-full border rounded-md px-2 py-1"
                            placeholder="repeats"
                          />
                          <input
                            type="number"
                            min="1"
                            value={r.successions?.everyDays ?? 14}
                            onChange={(e) => updateRow(r.id, { successions: { ...(r.successions || {}), everyDays: numOr(e.target.value, 14) } })}
                            className="w-full border rounded-md px-2 py-1"
                            placeholder="every days"
                          />
                        </div>
                      </Field>
                    </div>

                    <Field label="Notes">
                      <input
                        value={r.notes}
                        onChange={(e) => updateRow(r.id, { notes: e.target.value })}
                        placeholder="e.g., pre-soak seeds, vermiculite dusting"
                        className="w-full border rounded-md px-2 py-1"
                      />
                    </Field>

                    <div className="mt-2 rounded-lg border p-3 text-sm bg-gray-50">
                      <div className="font-medium mb-1">Timeline</div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>Germ: <strong>{tl.germ || "—"}</strong></div>
                        <div>Up-pot: <strong>{tl.upPot || "—"}</strong></div>
                        <div>Harden start: <strong>{tl.hardenStart || "—"}</strong></div>
                        <div>Transplant: <strong>{tl.transplant || "—"}</strong></div>
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        <div>Sown: <strong>{stats.sown}</strong></div>
                        <div>Germinated≈ <strong>{stats.germinated}</strong></div>
                        <div>Expected usable≈ <strong>{stats.expected}</strong></div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      )}

      {/* SCHEDULE */}
      {tab === "schedule" && (
        <SectionCard
          title="Schedule Preview"
          actions={<button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={syncQueue}>Create Tasks</button>}
        >
          {rows.length === 0 ? (
            <EmptyState onAdd={() => setTab("collect")} label="No seed lines" sub="Add rows in Collect." btn="Go to Collect" />
          ) : (
            <SchedulePreview rows={filtered} />
          )}
        </SectionCard>
      )}

      {/* LABELS */}
      {tab === "labels" && (
        <SectionCard title="Labels" actions={<button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={printLabels}>Print</button>}>
          {rows.length === 0 ? (
            <EmptyState onAdd={() => setTab("collect")} label="No labels to print" sub="Add rows in Collect." btn="Go to Collect" />
          ) : (
            <LabelsPreview rows={filtered} />
          )}
        </SectionCard>
      )}

      {/* SUMMARY */}
      {tab === "preview" && (
        <SectionCard
          title="Summary"
          actions={<button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Task Board")}>Send → Task Board</button>}
        >
          <SummaryCard rows={filtered} />
        </SectionCard>
      )}

      <Toast toast={toast} onUndo={undoRemove} onClose={dismissToast} />
    </div>
  );
}

// ------------------ Subcomponents ------------------
function SeedlingsTable({ rows, updateRow, removeRow }) {
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            {["Variety", "Tray", "Cells", "Seeds/cell", "Start", "Germ %", "Attrition %", ""].map((h) => (
              <th key={h} className="py-2 pr-3 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b">
              <td className="py-2 pr-3">
                <input
                  value={r.variety}
                  onChange={(e) => updateRow(r.id, { variety: e.target.value })}
                  placeholder="Variety"
                  className="w-48 border rounded-md px-2 py-1"
                />
              </td>
              <td className="py-2 pr-3">
                <input
                  value={r.tray}
                  onChange={(e) => updateRow(r.id, { tray: e.target.value })}
                  placeholder="Tray A"
                  className="w-28 border rounded-md px-2 py-1"
                />
              </td>
              <td className="py-2 pr-3">
                <input
                  type="number"
                  min="1"
                  value={r.cells}
                  onChange={(e) => updateRow(r.id, { cells: numOr(e.target.value, r.cells) })}
                  className="w-20 border rounded-md px-2 py-1"
                />
              </td>
              <td className="py-2 pr-3">
                <input
                  type="number"
                  min="1"
                  value={r.perCell}
                  onChange={(e) => updateRow(r.id, { perCell: numOr(e.target.value, r.perCell) })}
                  className="w-24 border rounded-md px-2 py-1"
                />
              </td>
              <td className="py-2 pr-3">
                <input
                  value={r.start}
                  onChange={(e) => updateRow(r.id, { start: e.target.value })}
                  placeholder="YYYY-MM-DD"
                  className="w-32 border rounded-md px-2 py-1"
                />
              </td>
              <td className="py-2 pr-3">
                <input
                  type="number"
                  min="0"
                  value={r.germinationPct}
                  onChange={(e) => updateRow(r.id, { germinationPct: numOr(e.target.value, r.germinationPct) })}
                  className="w-24 border rounded-md px-2 py-1"
                />
              </td>
              <td className="py-2 pr-3">
                <input
                  type="number"
                  min="0"
                  value={r.attritionPct}
                  onChange={(e) => updateRow(r.id, { attritionPct: numOr(e.target.value, r.attritionPct) })}
                  className="w-24 border rounded-md px-2 py-1"
                />
              </td>
              <td className="py-2 pr-3 text-right">
                <button onClick={() => removeRow(r.id)} className="text-red-600 text-xs rounded-lg border px-2 py-1 hover:bg-red-50">
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SchedulePreview({ rows }) {
  const [sched, setSched] = useState([]);
  useEffect(() => {
    (async () => {
      const helpers = await safeScheduleHelpers();
      setSched(buildSchedule(rows, helpers));
    })();
  }, [rows]);

  if (!sched.length) return <div className="text-sm text-stone-500">No scheduled items yet.</div>;
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {sched.map((s) => (
        <div key={s.id} className="rounded-xl border p-4">
          <div className="font-semibold">{s.title}</div>
          <div className="text-xs text-gray-600">{s.date} • {s.kind}</div>
          <div className="text-sm mt-1">{s.notes}</div>
        </div>
      ))}
    </div>
  );
}

function LabelsPreview({ rows }) {
  const labels = useMemo(() => buildLabels(rows), [rows]);
  if (!labels.length) return <div className="text-sm text-stone-500">Nothing to print.</div>;
  return (
    <div className="grid md:grid-cols-3 gap-3">
      {labels.map((l) => (
        <div key={l.id} className="rounded-lg border p-3 text-sm">
          <div className="font-semibold">{l.variety}</div>
          <div className="text-xs text-gray-600">{l.cultivar || "—"}</div>
          <div className="text-xs">Tray: {l.tray || "—"}</div>
          <div className="text-xs">Start: {l.start || "—"}</div>
          <div className="text-[11px] mt-1 opacity-70">Cells: {l.cells} • Seeds/cell: {l.perCell}</div>
        </div>
      ))}
    </div>
  );
}

function SummaryCard({ rows }) {
  const totals = rows.reduce(
    (acc, r) => {
      const stats = expectedStarts(r);
      acc.sown += stats.sown;
      acc.expected += stats.expected;
      acc.trays += 1;
      return acc;
    },
    { sown: 0, expected: 0, trays: 0 }
  );
  return (
    <div className="rounded-xl border p-4 text-sm">
      <div className="grid grid-cols-3 gap-3">
        <div><div className="text-xs text-gray-600">Trays</div><div className="text-lg font-semibold">{totals.trays}</div></div>
        <div><div className="text-xs text-gray-600">Seeds sown</div><div className="text-lg font-semibold">{totals.sown}</div></div>
        <div><div className="text-xs text-gray-600">Expected usable</div><div className="text-lg font-semibold">{totals.expected}</div></div>
      </div>
      <div className="mt-3 text-xs text-stone-600">Expected counts account for germination and attrition loss.</div>
    </div>
  );
}

function EmptyState({ onAdd, label = "No seedlings yet", sub = "Start with a quick row or paste CSV.", btn = "Add a blank row" }) {
  return (
    <div className="border-2 border-dashed rounded-2xl p-8 text-center">
      <h4 className="font-semibold mb-1">{label}</h4>
      <p className="text-sm text-gray-600 mb-4">{sub}</p>
      <button onClick={onAdd} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">{btn}</button>
    </div>
  );
}

// ------------------ scheduling & labels builders ------------------
function buildSchedule(rows, helpers) {
  const out = [];
  rows.forEach((r) => {
    const tl = predictTimeline(r);
    const stats = expectedStarts(r);
    const baseItems = [
      { kind: "start", date: r.start, title: `Start: ${r.variety}`, notes: `Tray ${r.tray || "-"} • ${r.cells} cells • ${r.perCell}/cell • Light ${r.lightHours}h • Heat ${r.heatMat ? "ON" : "OFF"}` },
      { kind: "germ", date: tl.germ, title: `Germ check: ${r.variety}`, notes: `Expect ~${stats.germinated} emerged.` },
      { kind: "up-pot", date: tl.upPot, title: `Up-pot: ${r.variety}`, notes: `Prepare pots; expected ${stats.expected} keepers.` },
      { kind: "harden", date: tl.hardenStart, title: `Harden-off start: ${r.variety}`, notes: `Daily exposure over ${r.hardenDays} days.` },
      { kind: "transplant", date: tl.transplant, title: `Transplant: ${r.variety}`, notes: `Target ~${stats.expected} plants.` },
    ];
    baseItems.forEach((i) => {
      if (!i.date) return;
      out.push({ id: uid("sched"), ...i });
    });

    // Watering cadence events (every N days from start until transplant)
    if (r.start && r.waterEveryDays > 0 && tl.transplant) {
      const start = new Date(r.start);
      const end = new Date(tl.transplant);
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + r.waterEveryDays)) {
        const iso = d.toISOString().slice(0, 10);
        if (helpers?.isRestDay?.(iso)) continue; // optional Sabbath-like guard
        out.push({ id: uid("sched"), kind: "water", date: iso, title: `Water: ${r.variety}`, notes: `Cadence ${r.waterEveryDays}d` });
      }
    }

    // Successions
    const reps = Number(r.successions?.repeats || 0);
    const gap = Number(r.successions?.everyDays || 14);
    for (let i = 1; i <= reps; i++) {
      const start2 = addDays(r.start, i * gap);
      if (!start2) continue;
      const clone = { ...r, start: start2 };
      const sub = buildSchedule([clone], helpers);
      sub.forEach((x) => out.push({ ...x, id: uid("sched") }));
    }
  });

  // optional helpers could sort/normalize
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return out;
}

function buildLabels(rows) {
  const out = [];
  rows.forEach((r) => {
    const stats = expectedStarts(r);
    out.push({
      id: uid("label"),
      variety: r.variety || "—",
      cultivar: r.cultivar || "",
      tray: r.tray || "",
      start: r.start || "",
      cells: r.cells || 0,
      perCell: r.perCell || 1,
      expected: stats.expected,
    });
  });
  return out;
}
