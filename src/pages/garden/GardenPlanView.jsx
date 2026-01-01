/* eslint-disable no-console */
// src/pages/garden/GardenPlanView.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * GardenPlanView — beds, crops, successions, schedule, yields
 * ----------------------------------------------------------------
 * Key features (aligned with your project + prior chats):
 * - Map: grid-based beds (W×L), tags (zone, sun), irrigation zone toggle, notes.
 * - Assign: crop → bed/row with spacing, days to maturity, successions, interplants.
 * - Rotation guard + Companion hints (simple rule set).
 * - Yield estimates w/ loss modeling (pest/weather/handling) + manual overrides.
 * - Schedule: sow/plant/harvest windows; autoskip optional "rest days".
 * - Exports: Task Board / Calendar / Inventory / Garden Map; print bed cards.
 * - Safe shims: eventBus, NBA, scheduleHelpers, automation; nothing crashes if absent.
 * - Autosave, undo toast, compact, keyboard-friendly UI.
 */

// ----------------- Optional services (safe shims) -----------------
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
async function safeAutomation() {
  try {
    const mod = await import(/* webpackIgnore: true */ "@/services/automation/runtime").catch(() => null);
    return mod?.automation || { runTemplate: async () => ({}), emit: () => {} };
  } catch { return { runTemplate: async () => ({}), emit: () => {} }; }
}

// ----------------- Local constants & utils -----------------
const LS_KEY = "garden.plan.view.v1";

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

const DEFAULT_BED = () => ({
  id: uid("bed"),
  name: "",
  widthFt: 3,
  lengthFt: 10,
  rows: 1,
  zone: "Front",
  sun: "full", // full | partial | shade
  irrigationZone: "IZ-1",
  notes: "",
  // per-bed loss overrides (optional)
  pestLossPct: undefined,
  weatherLossPct: undefined,
  handlingLossPct: undefined,
  plantings: [], // [{id,crop,spacingIn,row,qty,method,dtStart,daysToMaturity,successions,interplantOf,lossOverrides}]
});

const DEFAULT_LOSS = { pestLossPct: 10, weatherLossPct: 8, handlingLossPct: 5 };

const CROP_BASELINES = {
  // yield per plant (approx); adjust to your engine if present
  tomato: { unit: "lb", perPlant: 8, dtm: 75, spacingIn: 18, method: "transplant" },
  cucumber: { unit: "lb", perPlant: 6, dtm: 55, spacingIn: 12, method: "direct" },
  lettuce: { unit: "heads", perPlant: 1, dtm: 50, spacingIn: 10, method: "transplant" },
  carrot: { unit: "lb", perPlant: 0.2, dtm: 70, spacingIn: 3, method: "direct" },
  bean: { unit: "lb", perPlant: 0.25, dtm: 55, spacingIn: 4, method: "direct" },
};

// basic crop families for rotation hints
const CROP_FAMILY = {
  tomato: "solanaceae",
  pepper: "solanaceae",
  potato: "solanaceae",
  cucumber: "cucurbitaceae",
  squash: "cucurbitaceae",
  melon: "cucurbitaceae",
  lettuce: "asteraceae",
  carrot: "apiaceae",
  beet: "amaranthaceae",
  chard: "amaranthaceae",
  spinach: "amaranthaceae",
  bean: "fabaceae",
  pea: "fabaceae",
};

// oversimplified companion rules (demo)
const COMPANION_WARN = [
  ["cucumber", "potato"],
  ["tomato", "potato"],
  ["bean", "onion"],
];

// ------------- math helpers -------------
function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(100, v);
}
function addDaysISO(iso, days) {
  if (!iso) return "";
  const d = new Date(iso);
  if (String(d) === "Invalid Date") return "";
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

// plants that fit given spacing in a bed row
function plantsPerRow(lengthFt, spacingIn) {
  const lenIn = Number(lengthFt || 0) * 12;
  const sp = Math.max(1, Number(spacingIn || 1));
  return Math.floor(lenIn / sp);
}
function rowsPerBed(widthFt, rows) {
  return Math.max(1, Math.floor(Number(rows || 1)));
}
function yieldForPlanting(p, baselines, lossGlobal) {
  const base = baselines[p.crop] || { unit: "units", perPlant: 1, dtm: 60, spacingIn: 8, method: "direct" };
  const perPlant = Number(p.perPlant || base.perPlant);
  const qty = Number(p.qty || 0);
  const loss = {
    pestLossPct: clampPct(p?.lossOverrides?.pestLossPct ?? lossGlobal.pestLossPct),
    weatherLossPct: clampPct(p?.lossOverrides?.weatherLossPct ?? lossGlobal.weatherLossPct),
    handlingLossPct: clampPct(p?.lossOverrides?.handlingLossPct ?? lossGlobal.handlingLossPct),
  };
  const eff = (100 - loss.pestLossPct) / 100 * (100 - loss.weatherLossPct) / 100 * (100 - loss.handlingLossPct) / 100;
  return {
    unit: base.unit,
    raw: qty * perPlant,
    final: qty * perPlant * eff,
    dtm: Number(p.daysToMaturity || base.dtm),
    eff,
    loss,
  };
}

// ------------- UI atoms -------------
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

// ----------------- Main -----------------
export default function GardenPlanView() {
  const eventBus = useSafeEventBus();
  const invokeNBA = useSafeNBA();

  // tabs
  const [tab, setTab] = useState("map"); // map | assign | schedule | preview | print

  // state
  const [beds, setBeds] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [loss, setLoss] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_KEY + ".loss");
      return raw ? JSON.parse(raw) : DEFAULT_LOSS;
    } catch { return DEFAULT_LOSS; }
  });
  const [q, setQ] = useState("");
  const [toast, setToast] = useState(null);
  const lastRemovedRef = useRef(null);

  // autosave
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(beds)); } catch {} }, [beds]);
  useEffect(() => { try { localStorage.setItem(LS_KEY + ".loss", JSON.stringify(loss)); } catch {} }, [loss]);

  // filtered
  const filteredBeds = useMemo(() => {
    if (!q) return beds;
    const f = q.toLowerCase();
    return beds.filter(b =>
      (b.name || "").toLowerCase().includes(f) ||
      (b.zone || "").toLowerCase().includes(f) ||
      (b.irrigationZone || "").toLowerCase().includes(f)
    );
  }, [beds, q]);

  // actions
  const addBed = () => setBeds(s => [DEFAULT_BED(), ...s]);
  const removeBed = (id) => {
    setBeds((s) => {
      const idx = s.findIndex((b) => b.id === id);
      if (idx === -1) return s;
      const next = [...s];
      const [removed] = next.splice(idx, 1);
      lastRemovedRef.current = removed;
      return next;
    });
    raiseToast("Removed", "Bed removed.", true);
  };
  const undoRemove = () => {
    if (!lastRemovedRef.current) return;
    setBeds((s) => [lastRemovedRef.current, ...s]);
    lastRemovedRef.current = null;
    dismissToast();
  };
  const updateBed = (id, patch) => setBeds((s) => s.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const addPlanting = (bedId) => setBeds(s => s.map(b => b.id === bedId ? { ...b, plantings: [{ id: uid("plant"), crop: "", spacingIn: "", row: 1, qty: 0, method: "", dtStart: "", daysToMaturity: "", successions: { repeats: 0, everyDays: 14 }, interplantOf: "", lossOverrides: {}, }, ...(b.plantings || [])] } : b));
  const updatePlanting = (bedId, plantId, patch) =>
    setBeds(s => s.map(b => b.id === bedId ? { ...b, plantings: (b.plantings || []).map(p => p.id === plantId ? { ...p, ...patch } : p) } : b));
  const removePlanting = (bedId, plantId) =>
    setBeds(s => s.map(b => b.id === bedId ? { ...b, plantings: (b.plantings || []).filter(p => p.id !== plantId) } : b));

  // export
  const sendTo = async (target) => {
    const schedHelpers = await safeScheduleHelpers();
    const schedule = buildSchedule(beds, loss, schedHelpers);
    eventBus.emit("export.requested", {
      kind: "garden-plan",
      target,
      beds,
      schedule,
      loss,
      at: Date.now(),
    });
    raiseToast("Sent", `Garden plan exported to ${target}.`, false);
    try { invokeNBA?.({ reason: "garden_plan_export", context: { target, beds: beds.length } }); } catch {}
  };

  // AI assist (optional)
  const planWithAI = async () => {
    const automation = await safeAutomation();
    try {
      const res = await automation.runTemplate("garden.plan.optimize", { beds, loss });
      if (Array.isArray(res?.beds)) setBeds(res.beds);
      raiseToast("AI plan applied", "Plantings updated.", false);
    } catch {
      automation.emit?.("event", { type: "garden/plan_optimize_request", payload: { beds, loss } });
      raiseToast("Queued", "Requested optimization via automation.", false);
    }
  };

  // toast helpers
  const raiseToast = (title, message, canUndo) => setToast({ id: uid("t"), title, message, canUndo });
  const dismissToast = () => setToast(null);

  // derived summaries
  const rotationAlerts = useMemo(() => buildRotationAlerts(beds), [beds]);
  const companionAlerts = useMemo(() => buildCompanionAlerts(beds), [beds]);
  const yieldSummary = useMemo(() => summarizeYields(beds, loss), [beds, loss]);

  // --------------- render ---------------
  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <header className="mb-4 md:mb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl md:text-2xl font-semibold">🪴 Garden Plan — Beds • Assign • Schedule</h1>
          <div className="flex items-center gap-2">
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Task Board")}>Send → Task Board</button>
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Calendar")}>Send → Calendar</button>
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Inventory")}>Send → Inventory</button>
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Garden Map")}>Send → Garden Map</button>
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => window.print()}>Print Bed Cards</button>
          </div>
        </div>
        <nav className="mt-4 flex gap-2">
          {[
            { k: "map", t: "Map" },
            { k: "assign", t: "Assign" },
            { k: "schedule", t: "Schedule" },
            { k: "preview", t: "Preview" },
            { k: "print", t: "Print" },
          ].map(x => (
            <button key={x.k} onClick={() => setTab(x.k)} className={`px-3 py-1.5 rounded-lg text-sm border ${tab === x.k ? "bg-black text-white border-black" : "hover:bg-gray-50"}`}>{x.t}</button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter beds…" className="px-3 py-1.5 text-sm rounded-lg border w-56" />
            <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={addBed}>+ Bed</button>
          </div>
        </nav>
      </header>

      {/* MAP */}
      {tab === "map" && (
        <div className="grid lg:grid-cols-3 gap-4">
          <SectionCard
            title="Beds"
            actions={<button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={planWithAI}>AI Optimize</button>}
          >
            {filteredBeds.length ? (
              <BedsList beds={filteredBeds} onUpdate={updateBed} onRemove={removeBed} onAddPlanting={addPlanting} loss={loss} />
            ) : (
              <EmptyState onAdd={addBed} />
            )}
          </SectionCard>

          <SectionCard title="Loss Modeling">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Pest %" hint="insects, critters">
                <input className="w-full border rounded-md px-2 py-1" inputMode="decimal" value={loss.pestLossPct} onChange={(e) => setLoss(l => ({ ...l, pestLossPct: clampPct(e.target.value) }))} />
              </Field>
              <Field label="Weather %" hint="hail, heat">
                <input className="w-full border rounded-md px-2 py-1" inputMode="decimal" value={loss.weatherLossPct} onChange={(e) => setLoss(l => ({ ...l, weatherLossPct: clampPct(e.target.value) }))} />
              </Field>
              <Field label="Handling %" hint="harvest, storage">
                <input className="w-full border rounded-md px-2 py-1" inputMode="decimal" value={loss.handlingLossPct} onChange={(e) => setLoss(l => ({ ...l, handlingLossPct: clampPct(e.target.value) }))} />
              </Field>
            </div>
            <div className="text-xs text-gray-600 mt-2">Beds may override these in Assign → Planting.</div>
          </SectionCard>

          <SectionCard title="Health Checks">
            <div className="text-sm">
              <div className="font-semibold mb-1">Rotation alerts</div>
              {rotationAlerts.length ? (
                <ul className="list-disc ml-5 space-y-1">
                  {rotationAlerts.map((a) => <li key={a.id}><strong>{a.bed}</strong>: {a.message}</li>)}
                </ul>
              ) : <div className="text-gray-600">None detected.</div>}

              <div className="font-semibold mt-3 mb-1">Companion warnings</div>
              {companionAlerts.length ? (
                <ul className="list-disc ml-5 space-y-1">
                  {companionAlerts.map((a, i) => <li key={i}><strong>{a.bed}</strong>: {a.message}</li>)}
                </ul>
              ) : <div className="text-gray-600">None detected.</div>}
            </div>
          </SectionCard>
        </div>
      )}

      {/* ASSIGN */}
      {tab === "assign" && (
        <SectionCard title="Assign Crops to Beds">
          {filteredBeds.length ? (
            <AssignPanel beds={filteredBeds} onUpdateBed={updateBed} onUpdatePlanting={updatePlanting} onRemovePlanting={removePlanting} onAddPlanting={addPlanting} lossGlobal={loss} />
          ) : (
            <EmptyState onAdd={addBed} label="No beds yet" sub="Add beds in Map tab." btn="Add a bed" />
          )}
        </SectionCard>
      )}

      {/* SCHEDULE */}
      {tab === "schedule" && (
        <SectionCard title="Schedule Preview" actions={<button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Task Board")}>Create Tasks</button>}>
          <SchedulePreview beds={filteredBeds} loss={loss} />
        </SectionCard>
      )}

      {/* PREVIEW */}
      {tab === "preview" && (
        <SectionCard title="Plan Summary" actions={<button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => sendTo("Calendar")}>Send → Calendar</button>}>
          <SummaryCard yieldSummary={yieldSummary} beds={filteredBeds} />
        </SectionCard>
      )}

      {/* PRINT */}
      {tab === "print" && (
        <SectionCard title="Bed Cards" actions={<button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => window.print()}>Print</button>}>
          <BedCards beds={filteredBeds} loss={loss} />
        </SectionCard>
      )}

      <Toast toast={toast} onUndo={undoRemove} onClose={dismissToast} />
    </div>
  );
}

// ----------------- Subcomponents -----------------
function BedsList({ beds, onUpdate, onRemove, onAddPlanting, loss }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {beds.map((b) => {
        const area = Number(b.widthFt || 0) * Number(b.lengthFt || 0);
        return (
          <div key={b.id} className="rounded-xl border p-4">
            <div className="flex items-center justify-between mb-2">
              <input
                value={b.name}
                onChange={(e) => onUpdate(b.id, { name: e.target.value })}
                placeholder="Bed name (e.g., B1)"
                className="font-semibold w-40 border rounded-md px-2 py-1"
              />
              <button className="text-red-600 text-xs rounded-lg border px-2 py-1 hover:bg-red-50" onClick={() => onRemove(b.id)}>Remove</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Width (ft)">
                <input className="w-full border rounded-md px-2 py-1" inputMode="decimal" value={b.widthFt} onChange={(e) => onUpdate(b.id, { widthFt: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="Length (ft)">
                <input className="w-full border rounded-md px-2 py-1" inputMode="decimal" value={b.lengthFt} onChange={(e) => onUpdate(b.id, { lengthFt: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="Rows">
                <input className="w-full border rounded-md px-2 py-1" inputMode="numeric" value={b.rows} onChange={(e) => onUpdate(b.id, { rows: Math.max(1, Number(e.target.value) || 1) })} />
              </Field>
              <Field label="Zone / Sun">
                <div className="grid grid-cols-2 gap-2">
                  <input className="w-full border rounded-md px-2 py-1" value={b.zone} onChange={(e) => onUpdate(b.id, { zone: e.target.value })} placeholder="Front" />
                  <select className="w-full border rounded-md px-2 py-1" value={b.sun} onChange={(e) => onUpdate(b.id, { sun: e.target.value })}>
                    {["full","partial","shade"].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </Field>
              <Field label="Irrigation zone">
                <input className="w-full border rounded-md px-2 py-1" value={b.irrigationZone} onChange={(e) => onUpdate(b.id, { irrigationZone: e.target.value })} placeholder="IZ-1" />
              </Field>
              <Field label="Per-bed loss overrides" hint="leave blank to inherit">
                <div className="grid grid-cols-3 gap-2">
                  <input className="w-full border rounded-md px-2 py-1" placeholder={`Pest ${loss.pestLossPct}%`} value={b.pestLossPct ?? ""} onChange={(e)=>onUpdate(b.id, { pestLossPct: e.target.value === "" ? undefined : clampPct(e.target.value) })}/>
                  <input className="w-full border rounded-md px-2 py-1" placeholder={`Weather ${loss.weatherLossPct}%`} value={b.weatherLossPct ?? ""} onChange={(e)=>onUpdate(b.id, { weatherLossPct: e.target.value === "" ? undefined : clampPct(e.target.value) })}/>
                  <input className="w-full border rounded-md px-2 py-1" placeholder={`Handling ${loss.handlingLossPct}%`} value={b.handlingLossPct ?? ""} onChange={(e)=>onUpdate(b.id, { handlingLossPct: e.target.value === "" ? undefined : clampPct(e.target.value) })}/>
                </div>
              </Field>
            </div>

            <Field label="Notes">
              <input className="w-full border rounded-md px-2 py-1" value={b.notes} onChange={(e) => onUpdate(b.id, { notes: e.target.value })} placeholder="e.g., low spot—mulch heavy" />
            </Field>

            <div className="text-xs text-gray-600">Area ≈ {area.toFixed(1)} ft² • Rows: {rowsPerBed(b.widthFt, b.rows)}</div>
            <div className="mt-3">
              <button className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50" onClick={() => onAddPlanting(b.id)}>+ Planting</button>
            </div>
            {(b.plantings || []).length ? <PlantingsMiniList bed={b} /> : <div className="text-xs text-gray-500 mt-2">No plantings yet.</div>}
          </div>
        );
      })}
    </div>
  );
}

function PlantingsMiniList({ bed }) {
  return (
    <div className="mt-2 text-xs">
      <div className="font-semibold mb-1">Plantings</div>
      <div className="flex flex-wrap gap-1">
        {(bed.plantings || []).map((p) => (
          <Chip key={p.id}>{p.crop || "crop"} • row {p.row || 1} • {p.qty || 0} pcs</Chip>
        ))}
      </div>
    </div>
  );
}

function AssignPanel({ beds, onUpdateBed, onUpdatePlanting, onRemovePlanting, onAddPlanting, lossGlobal }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {beds.map((b) => (
        <div key={b.id} className="rounded-xl border p-4">
          <div className="font-semibold mb-2">{b.name || "Unnamed bed"} <span className="text-xs text-gray-600">({b.widthFt}×{b.lengthFt} ft, rows {b.rows})</span></div>
          <div className="mb-2">
            <button className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50" onClick={() => onAddPlanting(b.id)}>+ Add planting</button>
          </div>

          {(b.plantings || []).map((p) => {
            const base = CROP_BASELINES[p.crop] || {};
            const perRow = plantsPerRow(b.lengthFt, Number(p.spacingIn || base.spacingIn || 6));
            const rCount = rowsPerBed(b.widthFt, b.rows);
            const maxPlants = perRow * rCount;
            const y = yieldForPlanting({ ...p, qty: Number(p.qty || 0), perPlant: base.perPlant }, CROP_BASELINES, {
              pestLossPct: b.pestLossPct ?? lossGlobal.pestLossPct,
              weatherLossPct: b.weatherLossPct ?? lossGlobal.weatherLossPct,
              handlingLossPct: b.handlingLossPct ?? lossGlobal.handlingLossPct,
            });

            return (
              <div key={p.id} className="rounded-lg border p-3 mb-3">
                <div className="flex items-center justify-between">
                  <input className="font-medium border rounded-md px-2 py-1 w-40" value={p.crop} onChange={(e)=>onUpdatePlanting(b.id, p.id, { crop: e.target.value.toLowerCase().trim() })} placeholder="tomato, lettuce…" />
                  <button className="text-red-600 text-xs rounded-lg border px-2 py-1 hover:bg-red-50" onClick={() => onRemovePlanting(b.id, p.id)}>Remove</button>
                </div>

                <div className="grid grid-cols-2 gap-3 mt-2">
                  <Field label="Row #">
                    <input className="w-full border rounded-md px-2 py-1" inputMode="numeric" value={p.row ?? 1} onChange={(e)=>onUpdatePlanting(b.id, p.id, { row: Math.max(1, Number(e.target.value)||1) })}/>
                  </Field>
                  <Field label="Spacing (in)">
                    <input className="w-full border rounded-md px-2 py-1" inputMode="decimal" value={p.spacingIn ?? base.spacingIn ?? 6} onChange={(e)=>onUpdatePlanting(b.id, p.id, { spacingIn: Number(e.target.value)||6 })}/>
                  </Field>
                  <Field label="Qty (max recommended shown)">
                    <input className="w-full border rounded-md px-2 py-1" inputMode="numeric" value={p.qty ?? perRow} onChange={(e)=>onUpdatePlanting(b.id, p.id, { qty: Math.max(0, Number(e.target.value)||0) })}/>
                    <div className="text-[11px] text-gray-500 mt-1">Per row {perRow} • Rows {rCount} • Max ~{maxPlants}</div>
                  </Field>
                  <Field label="Method">
                    <select className="w-full border rounded-md px-2 py-1" value={p.method || base.method || "direct"} onChange={(e)=>onUpdatePlanting(b.id, p.id, { method: e.target.value })}>
                      {["direct","transplant"].map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </Field>
                  <Field label="Start (YYYY-MM-DD)">
                    <input className="w-full border rounded-md px-2 py-1" value={p.dtStart || ""} onChange={(e)=>onUpdatePlanting(b.id, p.id, { dtStart: e.target.value })} placeholder="2025-04-15"/>
                  </Field>
                  <Field label="Days to maturity">
                    <input className="w-full border rounded-md px-2 py-1" inputMode="numeric" value={p.daysToMaturity ?? base.dtm ?? 60} onChange={(e)=>onUpdatePlanting(b.id, p.id, { daysToMaturity: Math.max(0, Number(e.target.value)||0) })}/>
                  </Field>

                  <Field label="Successions (repeats × every N days)">
                    <div className="grid grid-cols-2 gap-2">
                      <input className="w-full border rounded-md px-2 py-1" inputMode="numeric" value={p.successions?.repeats ?? 0} onChange={(e)=>onUpdatePlanting(b.id, p.id, { successions: { ...(p.successions||{}), repeats: Math.max(0, Number(e.target.value)||0) } })} placeholder="repeats"/>
                      <input className="w-full border rounded-md px-2 py-1" inputMode="numeric" value={p.successions?.everyDays ?? 14} onChange={(e)=>onUpdatePlanting(b.id, p.id, { successions: { ...(p.successions||{}), everyDays: Math.max(1, Number(e.target.value)||14) } })} placeholder="every days"/>
                    </div>
                  </Field>

                  <Field label="Interplant of" hint="optional crop id/name">
                    <input className="w-full border rounded-md px-2 py-1" value={p.interplantOf || ""} onChange={(e)=>onUpdatePlanting(b.id, p.id, { interplantOf: e.target.value })} placeholder="e.g., carrot under tomato"/>
                  </Field>

                  <Field label="Loss overrides (%)" hint="pest | weather | handling">
                    <div className="grid grid-cols-3 gap-2">
                      <input className="w-full border rounded-md px-2 py-1" value={p.lossOverrides?.pestLossPct ?? ""} onChange={(e)=>onUpdatePlanting(b.id, p.id, { lossOverrides: { ...(p.lossOverrides||{}), pestLossPct: e.target.value === "" ? undefined : clampPct(e.target.value) } })} placeholder="inherit"/>
                      <input className="w-full border rounded-md px-2 py-1" value={p.lossOverrides?.weatherLossPct ?? ""} onChange={(e)=>onUpdatePlanting(b.id, p.id, { lossOverrides: { ...(p.lossOverrides||{}), weatherLossPct: e.target.value === "" ? undefined : clampPct(e.target.value) } })} placeholder="inherit"/>
                      <input className="w-full border rounded-md px-2 py-1" value={p.lossOverrides?.handlingLossPct ?? ""} onChange={(e)=>onUpdatePlanting(b.id, p.id, { lossOverrides: { ...(p.lossOverrides||{}), handlingLossPct: e.target.value === "" ? undefined : clampPct(e.target.value) } })} placeholder="inherit"/>
                    </div>
                  </Field>
                </div>

                <div className="mt-2 text-xs rounded-lg border p-2 bg-gray-50">
                  <div>Yield: raw <strong>{y.raw.toFixed(y.unit === "heads" ? 0 : 1)} {y.unit}</strong> → final <strong>{y.final.toFixed(y.unit === "heads" ? 0 : 1)} {y.unit}</strong> (eff {(y.eff*100).toFixed(0)}%)</div>
                  <div>Harvest window ~ <strong>{p.dtStart ? addDaysISO(p.dtStart, y.dtm) : "—"}</strong></div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SchedulePreview({ beds, loss }) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    (async () => {
      const helpers = await safeScheduleHelpers();
      setItems(buildSchedule(beds, loss, helpers));
    })();
  }, [beds, loss]);

  if (!items.length) return <div className="text-sm text-stone-500">No scheduled items yet.</div>;
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {items.map((s) => (
        <div key={s.id} className="rounded-xl border p-4">
          <div className="font-semibold">{s.title}</div>
          <div className="text-xs text-gray-600">{s.date} • {s.kind}</div>
          <div className="text-sm mt-1">{s.notes}</div>
        </div>
      ))}
    </div>
  );
}

function SummaryCard({ yieldSummary, beds }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="rounded-xl border p-4">
        <div className="font-semibold mb-2">Yields (after loss)</div>
        {yieldSummary.length ? (
          <ul className="text-sm space-y-1">
            {yieldSummary.map((y) => (
              <li key={y.crop}>
                <strong className="capitalize">{y.crop}</strong>: {y.final.toFixed(y.unit === "heads" ? 0 : 1)} {y.unit}
                <span className="text-xs text-gray-500"> (raw {y.raw.toFixed(y.unit === "heads" ? 0 : 1)})</span>
              </li>
            ))}
          </ul>
        ) : <div className="text-sm text-gray-600">No plantings yet.</div>}
      </div>

      <div className="rounded-xl border p-4">
        <div className="font-semibold mb-2">Beds & Irrigation</div>
        <ul className="text-sm space-y-1">
          {beds.map((b) => (
            <li key={b.id}>
              <strong>{b.name || "Bed"}</strong>: {b.widthFt}×{b.lengthFt} ft • rows {b.rows} • zone {b.zone} • sun {b.sun} • IZ {b.irrigationZone}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function BedCards({ beds, loss }) {
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3 print:grid-cols-2">
      {beds.map((b) => (
        <div key={b.id} className="rounded-xl border p-4">
          <div className="font-semibold">{b.name || "Bed"}</div>
          <div className="text-xs text-gray-600 mb-2">{b.widthFt}×{b.lengthFt} ft • rows {b.rows} • {b.sun} sun • {b.zone} • {b.irrigationZone}</div>
          {(b.plantings || []).length ? (
            <ul className="text-sm space-y-1">
              {b.plantings.map((p) => {
                const y = yieldForPlanting({ ...p, qty: Number(p.qty || 0) }, CROP_BASELINES, {
                  pestLossPct: b.pestLossPct ?? loss.pestLossPct,
                  weatherLossPct: b.weatherLossPct ?? loss.weatherLossPct,
                  handlingLossPct: b.handlingLossPct ?? loss.handlingLossPct,
                });
                return (
                  <li key={p.id}>
                    <strong className="capitalize">{p.crop || "crop"}</strong> — row {p.row} • {p.qty || 0} pcs • harvest ~ {p.dtStart ? addDaysISO(p.dtStart, y.dtm) : "—"} • final {y.final.toFixed(y.unit === "heads" ? 0 : 1)} {y.unit}
                  </li>
                );
              })}
            </ul>
          ) : <div className="text-xs text-gray-500">No plantings.</div>}
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onAdd, label = "No beds yet", sub = "Start by creating a bed.", btn = "Add a bed" }) {
  return (
    <div className="border-2 border-dashed rounded-2xl p-8 text-center">
      <h4 className="font-semibold mb-1">{label}</h4>
      <p className="text-sm text-gray-600 mb-4">{sub}</p>
      <button onClick={onAdd} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">{btn}</button>
    </div>
  );
}

// ----------------- builders & checks -----------------
function buildSchedule(beds, loss, helpers) {
  const out = [];
  beds.forEach((b) => {
    (b.plantings || []).forEach((p) => {
      const base = CROP_BASELINES[p.crop] || {};
      const dtStart = p.dtStart || "";
      const dtm = Number(p.daysToMaturity || base.dtm || 60);
      const harvest = dtStart ? addDaysISO(dtStart, dtm) : "";
      // sow/plant
      if (dtStart) out.push({ id: uid("s"), kind: p.method || base.method || "direct", date: dtStart, title: `${(p.method || base.method || "Plant")} ${p.crop} — ${b.name}`, notes: `Row ${p.row} • ${p.qty} pcs • Spacing ${p.spacingIn || base.spacingIn || 6}"` });
      // harvest
      if (harvest) out.push({ id: uid("s"), kind: "harvest", date: harvest, title: `Harvest ${p.crop} — ${b.name}`, notes: `Target qty ${p.qty || 0}; adjust for loss` });

      // successions
      const reps = Number(p.successions?.repeats || 0);
      const gap = Number(p.successions?.everyDays || 14);
      for (let i = 1; i <= reps; i++) {
        const start2 = dtStart ? addDaysISO(dtStart, i * gap) : "";
        if (!start2) continue;
        const harvest2 = addDaysISO(start2, dtm);
        out.push({ id: uid("s"), kind: p.method || base.method || "direct", date: start2, title: `Succession ${i}: ${p.crop} — ${b.name}`, notes: `Row ${p.row} • ${p.qty} pcs` });
        out.push({ id: uid("s"), kind: "harvest", date: harvest2, title: `Harvest (succ ${i}) ${p.crop} — ${b.name}`, notes: `Plan storage; loss modeled downstream` });
      }
    });
  });

  // optional helper: skip rest days
  const skip = helpers?.isRestDay ? (d) => helpers.isRestDay(d) : () => false;
  const filtered = out.filter((i) => !skip(i.date));
  filtered.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return filtered;
}

function buildRotationAlerts(beds) {
  // lightweight: warn if same family appears 2+ times in same bed
  const alerts = [];
  beds.forEach((b) => {
    const famCount = {};
    (b.plantings || []).forEach((p) => {
      const fam = CROP_FAMILY[p.crop] || p.crop || "unknown";
      famCount[fam] = (famCount[fam] || 0) + 1;
    });
    Object.entries(famCount).forEach(([fam, c]) => {
      if (c > 1 && fam !== "unknown") {
        alerts.push({ id: uid("rot"), bed: b.name || "Bed", message: `Multiple ${fam} plantings — rotate next season.` });
      }
    });
  });
  return alerts;
}

function buildCompanionAlerts(beds) {
  const alerts = [];
  beds.forEach((b) => {
    const crops = (b.plantings || []).map(p => p.crop).filter(Boolean);
    COMPANION_WARN.forEach(([a, c]) => {
      if (crops.includes(a) && crops.includes(c)) {
        alerts.push({ bed: b.name || "Bed", message: `${a} with ${c} is a poor pairing.` });
      }
    });
  });
  return alerts;
}

function summarizeYields(beds, lossGlobal) {
  const map = new Map();
  beds.forEach((b) => {
    (b.plantings || []).forEach((p) => {
      const y = yieldForPlanting({ ...p, qty: Number(p.qty || 0) }, CROP_BASELINES, {
        pestLossPct: b.pestLossPct ?? lossGlobal.pestLossPct,
        weatherLossPct: b.weatherLossPct ?? lossGlobal.weatherLossPct,
        handlingLossPct: b.handlingLossPct ?? lossGlobal.handlingLossPct,
      });
      const key = p.crop || "crop";
      const prev = map.get(key) || { crop: key, unit: y.unit, raw: 0, final: 0 };
      prev.raw += y.raw;
      prev.final += y.final;
      map.set(key, prev);
    });
  });
  return Array.from(map.values()).sort((a, b) => a.crop.localeCompare(b.crop));
}
