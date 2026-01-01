/* eslint-disable no-console */
// src/pages/garden/GardenPlannerShell.jsx
import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";

/**
 * GardenPlannerShell
 * --------------------------------------------------------------------
 * Roles:
 * - Navigation container for Garden flows (Collect → Seedlings → Plan).
 * - Global garden settings: loss modeling, rest-day skipping, zones.
 * - Export Inbox: displays export payloads sent via eventBus ("export.requested").
 * - Quick calculators: Soil/compost estimator with adjustable waste (loss)%.
 * - UX niceties: autosave, undo toasts, keyboard shortcuts, defensive shims.
 *
 * Notes:
 * - Child pages already include their own safe shims & autosave. This shell
 *   adds a cohesive top bar + right rail and gathers exports in one spot.
 */

// ---- Lazy children (keeps first paint snappy) ----
const CollectOrganize = lazy(() => import("./CollectOrganize.jsx"));
const SeedlingsPanel = lazy(() => import("./SeedlingsPanel.jsx"));
const GardenPlanView = lazy(() => import("./GardenPlanView.jsx"));

// ---- Optional event bus (shared if available) ----
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

// Try to mount a shared bus at window so child shims can “find” one
function useGlobalEventBus() {
  const [bus, setBus] = useState(null);
  useEffect(() => {
    const w = typeof window !== "undefined" ? window : {};
    if (!w.SUKA_EVENTBUS) {
      w.SUKA_EVENTBUS = createLocalBus();
      // Expose as a very light module proxy (helps shims that dynamically import services/eventBus.js)
      // Not required, but useful during wiring:
      // w.__SUKA_EVENTBUS_READY__ = true;
    }
    setBus(w.SUKA_EVENTBUS);
  }, []);
  return bus ?? createLocalBus();
}

// ---- Utilities ----
const LS_KEY = "garden.shell.settings.v1";
const LS_INBOX = "garden.shell.inbox.v1";

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}
function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(100, v);
}
function toYd3(cubicFeet) {
  return (Number(cubicFeet || 0) / 27);
}

// ---- Default settings shared across garden ----
const DEFAULTS = {
  // global loss modeling (used by GardenPlanView; mirrors per-page defaults)
  loss: { pestLossPct: 10, weatherLossPct: 8, handlingLossPct: 5 },
  // rest day (skip when generating schedules)
  restDay: "Sunday", // Sunday | Saturday | None
  // garden metadata
  zones: ["Front", "Side", "Back"],
  irrigationZones: ["IZ-1", "IZ-2", "IZ-3"],
  // soil calc defaults
  soil: { bedDepthIn: 10, wastePct: 7 },
};

// ---- Toast UI ----
function Toast({ toast, onUndo, onClose }) {
  if (!toast) return null;
  return (
    <div className="fixed bottom-4 right-4 max-w-sm rounded-xl bg-black text-white p-4 shadow-lg flex items-start gap-3 z-50">
      <div className="text-sm flex-1">
        <strong className="block">{toast.title}</strong>
        <span className="opacity-90">{toast.message}</span>
      </div>
      {toast.canUndo ? <button className="underline text-sm mr-2" onClick={() => onUndo?.(toast)}>Undo</button> : null}
      <button className="opacity-80 hover:opacity-100" aria-label="close" onClick={onClose}>×</button>
    </div>
  );
}

// ---- Shell ----
export default function GardenPlannerShell() {
  const bus = useGlobalEventBus();

  // Navigation
  const [tab, setTab] = useState("collect"); // collect | seedlings | plan | exports

  // Settings
  const [settings, setSettings] = useState(() => {
    try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : DEFAULTS; } catch { return DEFAULTS; }
  });

  // Export inbox (captures export.requested events from child pages)
  const [inbox, setInbox] = useState(() => {
    try { const raw = localStorage.getItem(LS_INBOX); return raw ? JSON.parse(raw) : []; } catch { return []; }
  });
  const lastRemovedRef = useRef(null);

  // Toast
  const [toast, setToast] = useState(null);
  const raiseToast = (title, message, canUndo = false) => setToast({ id: uid("t"), title, message, canUndo });
  const dismissToast = () => setToast(null);
  const undoRemove = () => {
    if (!lastRemovedRef.current) return;
    setInbox((s) => [lastRemovedRef.current, ...s]);
    lastRemovedRef.current = null;
    dismissToast();
  };

  // Persist
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch {} }, [settings]);
  useEffect(() => { try { localStorage.setItem(LS_INBOX, JSON.stringify(inbox)); } catch {} }, [inbox]);

  // Listen for exports
  useEffect(() => {
    if (!bus) return;
    const off = bus.on("export.requested", (payload) => {
      setInbox((s) => [{ id: uid("x"), at: Date.now(), ...payload }, ...s].slice(0, 200));
      // Friendly nudge
      raiseToast("Export received", `${payload?.target || "Destination"} • ${payload?.kind || "garden"}`);
    });
    return () => off && off();
  }, [bus]);

  // Keyboard shortcuts: g+c, g+s, g+p, g+e
  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey && !e.ctrlKey && !e.metaKey) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === "1") { setTab("collect"); e.preventDefault(); }
        if (k === "2") { setTab("seedlings"); e.preventDefault(); }
        if (k === "3") { setTab("plan"); e.preventDefault(); }
        if (k === "4") { setTab("exports"); e.preventDefault(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Derived
  const restDayHelp = useMemo(() => {
    const rd = settings.restDay;
    return rd === "None" ? "No days skipped." : `Schedules will skip ${rd}.`;
  }, [settings.restDay]);

  // Quick calculators state
  const [calc, setCalc] = useState({ widthFt: 3, lengthFt: 10, depthIn: settings.soil.bedDepthIn, wastePct: settings.soil.wastePct });
  const areaFt2 = Number(calc.widthFt || 0) * Number(calc.lengthFt || 0);
  const volFt3 = areaFt2 * (Number(calc.depthIn || 0) / 12);
  const volFt3Adj = volFt3 * (1 + clampPct(calc.wastePct) / 100);
  const volYd3Adj = toYd3(volFt3Adj);

  const resetSettings = () => {
    if (!confirm("Reset garden settings to defaults?")) return;
    setSettings(DEFAULTS);
    raiseToast("Settings reset", "Defaults restored.", false);
  };

  const clearInbox = () => {
    if (!confirm("Clear the export inbox?")) return;
    setInbox([]);
    raiseToast("Cleared", "Export inbox cleared.", false);
  };

  // Render
  return (
    <div className="min-h-screen bg-orange-50">
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-orange-50/90 backdrop-blur border-b border-orange-200">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <h1 className="text-2xl font-bold text-orange-900">🌿 Garden Planner</h1>
          <nav className="ml-2 flex gap-2">
            {[
              { k: "collect", t: "Collect" },
              { k: "seedlings", t: "Seedlings" },
              { k: "plan", t: "Plan" },
              { k: "exports", t: "Exports" },
            ].map((x) => (
              <button
                key={x.k}
                onClick={() => setTab(x.k)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${tab === x.k ? "bg-black text-white border-black" : "hover:bg-orange-100"}`}
              >
                {x.t}
              </button>
            ))}
          </nav>

          {/* Right actions */}
          <div className="ml-auto flex items-center gap-2">
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-orange-100"
              onClick={() => window.print()}
              title="Print"
            >
              Print
            </button>
            <a
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-orange-100"
              href="https://"
              onClick={(e) => e.preventDefault()}
              title="Help"
            >
              Help
            </a>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-4 grid lg:grid-cols-[1fr_320px] gap-4">
        {/* Primary content */}
        <div className="min-w-0">
          <Suspense
            fallback={
              <div className="rounded-2xl border bg-white p-6 shadow-sm">
                <div className="animate-pulse text-sm text-stone-500">Loading…</div>
              </div>
            }
          >
            {tab === "collect" && <CollectOrganize />}
            {tab === "seedlings" && <SeedlingsPanel />}
            {tab === "plan" && <GardenPlanView />}
            {tab === "exports" && <ExportInbox inbox={inbox} onClear={clearInbox} onRemove={(id) => {
              setInbox((s) => {
                const idx = s.findIndex((x) => x.id === id);
                if (idx === -1) return s;
                const next = [...s];
                [lastRemovedRef.current] = next.splice(idx, 1);
                return next;
              });
              raiseToast("Removed", "Export entry removed.", true);
            }} />}
          </Suspense>
        </div>

        {/* Right rail: Settings & Calculators */}
        <aside className="space-y-4">
          <section className="rounded-2xl border bg-white shadow-sm p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Global Garden Settings</h3>
              <button className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50" onClick={resetSettings}>Reset</button>
            </div>

            <div className="text-xs uppercase tracking-wide mb-1">Loss Modeling</div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div>
                <div className="text-[11px] text-gray-600 mb-1">Pest %</div>
                <input
                  className="w-full border rounded-md px-2 py-1"
                  inputMode="decimal"
                  value={settings.loss.pestLossPct}
                  onChange={(e) => setSettings((s) => ({ ...s, loss: { ...s.loss, pestLossPct: clampPct(e.target.value) } }))}
                />
              </div>
              <div>
                <div className="text-[11px] text-gray-600 mb-1">Weather %</div>
                <input
                  className="w-full border rounded-md px-2 py-1"
                  inputMode="decimal"
                  value={settings.loss.weatherLossPct}
                  onChange={(e) => setSettings((s) => ({ ...s, loss: { ...s.loss, weatherLossPct: clampPct(e.target.value) } }))}
                />
              </div>
              <div>
                <div className="text-[11px] text-gray-600 mb-1">Handling %</div>
                <input
                  className="w-full border rounded-md px-2 py-1"
                  inputMode="decimal"
                  value={settings.loss.handlingLossPct}
                  onChange={(e) => setSettings((s) => ({ ...s, loss: { ...s.loss, handlingLossPct: clampPct(e.target.value) } }))}
                />
              </div>
            </div>

            <div className="text-xs uppercase tracking-wide mb-1">Scheduling</div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <div className="text-[11px] text-gray-600 mb-1">Rest day</div>
                <select
                  className="w-full border rounded-md px-2 py-1"
                  value={settings.restDay}
                  onChange={(e) => setSettings((s) => ({ ...s, restDay: e.target.value }))}
                >
                  {["Sunday", "Saturday", "None"].map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div className="text-[11px] text-gray-600 flex items-end">{restDayHelp}</div>
            </div>

            <div className="text-xs uppercase tracking-wide mb-1">Zones</div>
            <TagEditor
              tags={settings.zones}
              onChange={(tags) => setSettings((s) => ({ ...s, zones: tags }))}
              placeholder="Add zone"
            />

            <div className="text-xs uppercase tracking-wide mt-3 mb-1">Irrigation Zones</div>
            <TagEditor
              tags={settings.irrigationZones}
              onChange={(tags) => setSettings((s) => ({ ...s, irrigationZones: tags }))}
              placeholder="Add IZ"
            />
          </section>

          <section className="rounded-2xl border bg-white shadow-sm p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Soil / Compost Calculator</h3>
              <button
                className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50"
                onClick={() => setCalc({ widthFt: 3, lengthFt: 10, depthIn: settings.soil.bedDepthIn, wastePct: settings.soil.wastePct })}
              >
                Reset
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Width (ft)">
                <input className="w-full border rounded-md px-2 py-1" inputMode="decimal" value={calc.widthFt} onChange={(e)=>setCalc(c=>({ ...c, widthFt: Number(e.target.value)||0 }))}/>
              </Field>
              <Field label="Length (ft)">
                <input className="w-full border rounded-md px-2 py-1" inputMode="decimal" value={calc.lengthFt} onChange={(e)=>setCalc(c=>({ ...c, lengthFt: Number(e.target.value)||0 }))}/>
              </Field>
              <Field label="Depth (in)">
                <input className="w-full border rounded-md px-2 py-1" inputMode="decimal" value={calc.depthIn} onChange={(e)=>setCalc(c=>({ ...c, depthIn: Number(e.target.value)||0 }))}/>
              </Field>
              <Field label="Waste / loss %">
                <input className="w-full border rounded-md px-2 py-1" inputMode="decimal" value={calc.wastePct} onChange={(e)=>setCalc(c=>({ ...c, wastePct: clampPct(e.target.value) }))}/>
              </Field>
            </div>
            <div className="mt-2 text-sm rounded-lg border p-2 bg-gray-50">
              <div>Area ≈ <strong>{areaFt2.toFixed(1)}</strong> ft²</div>
              <div>Volume (adj) ≈ <strong>{volFt3Adj.toFixed(1)}</strong> ft³ (<strong>{volYd3Adj.toFixed(2)}</strong> yd³)</div>
              <div className="text-xs text-gray-600">Includes waste/loss buffer.</div>
            </div>
          </section>

          <section className="rounded-2xl border bg-white shadow-sm p-4">
            <h3 className="font-semibold mb-2">Shortcuts</h3>
            <ul className="text-sm space-y-1">
              <li><kbd className="kbd">Ctrl/⌘</kbd> + <kbd className="kbd">1</kbd> — Collect</li>
              <li><kbd className="kbd">Ctrl/⌘</kbd> + <kbd className="kbd">2</kbd> — Seedlings</li>
              <li><kbd className="kbd">Ctrl/⌘</kbd> + <kbd className="kbd">3</kbd> — Plan</li>
              <li><kbd className="kbd">Ctrl/⌘</kbd> + <kbd className="kbd">4</kbd> — Exports</li>
            </ul>
          </section>
        </aside>
      </main>

      <Toast toast={toast} onUndo={undoRemove} onClose={dismissToast} />
      <style>{styles}</style>
    </div>
  );
}

/* ---------- Reusable small atoms ---------- */
function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[11px] text-gray-600 mb-1">{label}</div>
      {children}
    </label>
  );
}

function TagEditor({ tags = [], onChange, placeholder = "add tag" }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((t, i) => (
        <span key={`${t}-${i}`} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
          {t}
          <button className="opacity-70 hover:opacity-100" onClick={() => onChange(tags.filter((_, idx) => idx !== i))}>×</button>
        </span>
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
        placeholder={placeholder}
        className="w-28 border rounded-md px-2 py-1 text-xs"
      />
    </div>
  );
}

/* ---------- Export Inbox ---------- */
function ExportInbox({ inbox, onClear, onRemove }) {
  return (
    <div className="rounded-2xl border bg-white shadow-sm">
      <div className="p-4 flex items-center justify-between border-b">
        <h3 className="font-semibold">Export Inbox</h3>
        <div className="flex gap-2">
          <button className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50" onClick={onClear}>Clear</button>
        </div>
      </div>
      <div className="p-4">
        {inbox.length ? (
          <div className="space-y-3">
            {inbox.map((x) => (
              <div key={x.id} className="rounded-xl border p-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{x.kind || "garden"}</div>
                  <div className="text-xs text-gray-600">{x.target || "—"} • {new Date(x.at).toLocaleString()}</div>
                </div>
                <div className="text-xs text-gray-600 mt-1">Payload keys: {(Object.keys(x || {}).filter(k => !["id","at"].includes(k))).join(", ") || "—"}</div>
                {x.schedule?.length ? (
                  <div className="mt-2 text-xs">
                    <div className="font-semibold mb-1">Schedule items: {x.schedule.length}</div>
                    <ul className="list-disc ml-5 space-y-1">
                      {x.schedule.slice(0, 5).map((s) => <li key={s.id}>{s.date} — {s.title}</li>)}
                    </ul>
                    {x.schedule.length > 5 ? <div className="text-[11px] text-gray-500 mt-1">+{x.schedule.length - 5} more…</div> : null}
                  </div>
                ) : null}
                <div className="mt-2 text-right">
                  <button className="text-red-600 text-xs rounded border px-2 py-0.5 hover:bg-red-50" onClick={() => onRemove(x.id)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-stone-500 italic">No exports captured yet. Actions from Collect/Seedlings/Plan will appear here when they emit <code>export.requested</code>.</div>
        )}
      </div>
    </div>
  );
}

/* ---------- Tiny style helpers ---------- */
const styles = `
  .kbd{display:inline-block;padding:0 .4rem;border:1px solid rgba(0,0,0,.2);border-bottom-width:2px;border-radius:.4rem;background:#fff;font:600 11px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif}
`;
