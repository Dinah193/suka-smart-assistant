// File: C:\Users\larho\suka-smart-assistant\src\ui\pages\scheduling\index.jsx
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

// 🔌 Shared services (assumed to exist per SSA conventions)
import eventBus from "../../services/eventBus";
import featureFlags from "../../config/featureFlags";
import HubPacketFormatter from "../../hub/HubPacketFormatter";
import FamilyFundConnector from "../../hub/FamilyFundConnector";

// 🧭 Purpose
// Main Scheduling Dashboard (day/week view)
// • Shows household sessions across domains (cooking, cleaning, garden, animals, storehouse, preservation)
// • Highlights conflicts (resource/person overlaps) & overruns
// • Provides quick actions (create, reschedule, autofit) and emits normalized events
//
// Pipeline fit (imports → intelligence → automation → (optional) hub export)
// • Imports & domain engines propose sessions → planners compute a plan → emit `schedule.plan.recomputed`
// • This UI renders that plan, listens for runtime signals (overruns/conflicts), and lets user adjust
// • Actions like reschedule/autofit affect household data → we also export to Hub if familyFundMode=true

// --------------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------------
const SOURCE = "ui.scheduling.index";
const nowISO = () => new Date().toISOString();

function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    FamilyFundConnector.send(packet);
  } catch {
    // Hub is optional plumbing — fail silently
  }
}

const DOMAINS = ["all", "cooking", "cleaning", "garden", "animals", "storehouse", "preservation"];
const VIEW_MODES = ["day", "week"];

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtShort(dt) {
  return new Date(dt).toLocaleString([], { month: "short", day: "numeric" });
}
function toISO(dt) {
  return new Date(dt).toISOString();
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// --------------------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------------------
/**
 * Session row:
 * {
 *   id, sessionId, title, domain, startISO, endISO,
 *   resource?: { id, type, name }, people?: string[],
 *   status?: 'planned'|'running'|'done',
 *   flags?: { risk?: 'green'|'amber'|'red', overrunMs?: number }
 * }
 * Conflict row:
 * {
 *   id, resource: {id,type,name}, overlaps: [{bookingId, sessionId, label, start, end}],
 *   window: {start,end}, domain
 * }
 */
const initialState = {
  loading: true,
  error: null,
  sessions: [],
  conflicts: [],
  planMeta: { planId: null, modelVersion: null },
};

function reducer(state, action) {
  switch (action.type) {
    case "LOAD_START":
      return { ...state, loading: true, error: null };
    case "LOAD_SUCCESS":
      return {
        ...state,
        loading: false,
        error: null,
        sessions: action.sessions || [],
        conflicts: action.conflicts || [],
        planMeta: action.planMeta || state.planMeta,
      };
    case "UPSERT_SESSION": {
      const s = action.session;
      if (!s?.id) return state;
      const idx = state.sessions.findIndex((x) => x.id === s.id);
      const next = [...state.sessions];
      if (idx >= 0) next[idx] = { ...next[idx], ...s };
      else next.push(s);
      return { ...state, sessions: next };
    }
    case "SET_CONFLICTS":
      return { ...state, conflicts: action.conflicts || [] };
    case "LOAD_ERROR":
      return { ...state, loading: false, error: action.error || "Failed to load schedule." };
    default:
      return state;
  }
}

// --------------------------------------------------------------------------------------
// Data fetching
// --------------------------------------------------------------------------------------
// Option A: analytics/planner service (if present)
// Option B: eventBus request/response
let svc = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  svc = require("../../services/schedulingService").default;
} catch {
  // no-op
}

async function fetchSchedule({ fromISO, toISO, domain }) {
  if (svc?.getSchedule) return svc.getSchedule({ fromISO, toISO, domain });
  return new Promise((resolve) => {
    const req = {
      type: "schedule.window.request",
      ts: nowISO(),
      source: SOURCE,
      data: { fromISO, toISO, domain },
    };
    const off = eventBus.on("schedule.window.result", (e) => {
      off?.();
      resolve(e?.data || { sessions: [], conflicts: [], meta: {} });
    });
    eventBus.emit(req.type, req);
    setTimeout(() => {
      off?.();
      resolve({ sessions: [], conflicts: [], meta: {} });
    }, 3000);
  });
}

// --------------------------------------------------------------------------------------
// Page
// --------------------------------------------------------------------------------------
export default function SchedulingDashboardPage() {
  // Filters / view
  const [view, setView] = useState("day"); // 'day' | 'week'
  const [domain, setDomain] = useState("all");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date())); // start day of the visible window

  const [state, dispatch] = useReducer(reducer, initialState);

  const windowStart = useMemo(() => (view === "day" ? anchor : startOfDay(anchor)), [view, anchor]);
  const windowEnd = useMemo(
    () => (view === "day" ? addDays(windowStart, 1) : addDays(windowStart, 7)),
    [view, windowStart]
  );
  const fromISO = useMemo(() => toISO(windowStart), [windowStart]);
  const toISO = useMemo(() => toISO(windowEnd), [windowEnd]);

  // Load schedule for window
  const load = useCallback(async () => {
    dispatch({ type: "LOAD_START" });
    try {
      const res = await fetchSchedule({ fromISO, toISO, domain: domain === "all" ? undefined : domain });
      dispatch({
        type: "LOAD_SUCCESS",
        sessions: (res.sessions || []).map(normalizeSession),
        conflicts: (res.conflicts || []).map(normalizeConflict),
        planMeta: { planId: res?.meta?.planId || null, modelVersion: res?.meta?.modelVersion || null },
      });
    } catch (err) {
      dispatch({ type: "LOAD_ERROR", error: String(err?.message || err) });
    }
  }, [fromISO, toISO, domain]);

  useEffect(() => {
    load();
  }, [load]);

  // Live updates
  useEffect(() => {
    const offRecompute = eventBus.on("schedule.plan.recomputed", (e) => {
      const d = e?.data || {};
      // If the recompute intersects our window, refresh
      if (rangesIntersect(d.window?.start, d.window?.end, fromISO, toISO)) load();
    });
    const offOverrun = eventBus.on("schedule.overrun.detected", (e) => {
      const d = e?.data || {};
      if (!d?.sessionId) return;
      dispatch({
        type: "UPSERT_SESSION",
        session: {
          id: d.sessionId,
          flags: { risk: "amber", overrunMs: Math.max(0, d.deltaMs || 0) },
        },
      });
    });
    const offConflict = eventBus.on("schedule.resource.conflict", (e) => {
      const c = normalizeConflict(e?.data || e);
      if (!c) return;
      // Refresh full list rather than append (planner might produce merged conflicts)
      load();
    });

    return () => {
      try { offRecompute?.(); } catch {}
      try { offOverrun?.(); } catch {}
      try { offConflict?.(); } catch {}
    };
  }, [fromISO, toISO, load]);

  // Actions
  const emit = useCallback((type, data, { exportToHub = false } = {}) => {
    const payload = { type, ts: nowISO(), source: SOURCE, data };
    try {
      eventBus.emit(type, payload);
      eventBus.emit("ui.action", payload);
    } catch {}
    if (exportToHub) exportToHubIfEnabled(payload);
  }, []);

  const createQuickSession = useCallback(
    (patch = {}) => {
      const start = new Date(anchor);
      start.setHours(12, 0, 0, 0);
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + 45);

      const data = {
        title: patch.title || "Quick session",
        domain: patch.domain || (domain !== "all" ? domain : "general"),
        startISO: start.toISOString(),
        endISO: end.toISOString(),
      };
      emit("schedule.session.create", data, { exportToHub: true });
    },
    [emit, anchor, domain]
  );

  const requestAutofit = useCallback(() => {
    emit(
      "schedule.autofit",
      {
        window: { start: fromISO, end: toISO },
        domain: domain === "all" ? undefined : domain,
        strategy: "compress_neighbors|defer_low_priority",
        reason: "user.dashboard_autofit",
      },
      { exportToHub: true }
    );
  }, [emit, fromISO, toISO, domain]);

  const openConflictModal = useCallback(
    (conflict) => {
      emit("ui.modal.open", { modal: "ResourceConflictModal", props: { isOpen: true, conflict } });
    },
    [emit]
  );

  // Derived session maps for grid
  const gridModel = useMemo(() => buildGridModel(state.sessions, windowStart, windowEnd, view), [
    state.sessions,
    windowStart,
    windowEnd,
    view,
  ]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Scheduling</h1>
          <p className="text-sm text-slate-600">
            Plan view for {view === "day" ? "today" : "this week"} · Plan{" "}
            <span className="font-mono">{state.planMeta.planId || "—"}</span>{" "}
            <span className="text-slate-400">(model {state.planMeta.modelVersion || "—"})</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle view={view} setView={setView} />
          <DateNav view={view} anchor={anchor} setAnchor={setAnchor} />
          <select
            className="text-sm border border-slate-300 rounded-lg px-2 py-1.5 bg-white"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            title="Domain"
          >
            {DOMAINS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <button
            onClick={load}
            className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => createQuickSession({})}
          className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
        >
          + Quick session
        </button>
        <button
          onClick={requestAutofit}
          className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50"
        >
          Auto-fit window
        </button>
        <Legend />
      </div>

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Schedule grid */}
        <div className="lg:col-span-3 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-2 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              {view === "day"
                ? `${fmtShort(windowStart)} timeline`
                : `${fmtShort(windowStart)} → ${fmtShort(addDays(windowStart, 6))}`}
            </h3>
            {state.loading && <span className="text-[11px] text-slate-600">Loading…</span>}
          </div>
          <ScheduleGrid
            model={gridModel}
            onSessionClick={(s) =>
              emit("ui.session.open_details", { sessionId: s.sessionId || s.id, domain: s.domain })
            }
            onSessionNudge={(s, minutes) => {
              // Simple reschedule +/- minutes
              const payload = {
                type: "schedule.reschedule_item",
                ts: nowISO(),
                source: SOURCE,
                data: {
                  sessionId: s.sessionId || s.id,
                  domain: s.domain,
                  offsetMs: minutes * 60 * 1000,
                  reason: "user.nudge",
                },
              };
              eventBus.emit(payload.type, payload);
              eventBus.emit("ui.action", payload);
              exportToHubIfEnabled(payload);
            }}
          />
        </div>

        {/* Conflict / Alerts panel */}
        <div className="lg:col-span-1 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-2 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Conflicts & alerts</h3>
            <button
              onClick={() => load()}
              className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50"
            >
              Reload
            </button>
          </div>
          <div className="p-3 space-y-2">
            {(state.conflicts || []).length === 0 && (
              <div className="text-xs text-slate-500">No conflicts detected.</div>
            )}
            {(state.conflicts || []).map((c) => (
              <div
                key={c.id}
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
              >
                <div className="text-xs font-semibold">
                  {c.resource?.name || "Resource"} overlap
                </div>
                <ul className="mt-1 space-y-0.5">
                  {(c.overlaps || []).map((o) => (
                    <li key={o.bookingId} className="text-[11px]">
                      {(o.label || "Task")} #{o.bookingId} ·{" "}
                      <span className="font-mono">{timeRangeLabel(o.start, o.end)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => openConflictModal(c)}
                    className="text-[11px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    Resolve…
                  </button>
                  <button
                    onClick={() =>
                      emit(
                        "schedule.autofit",
                        {
                          window: c.window,
                          domain: c.domain,
                          strategy: "resolve_resource_overlap",
                          reason: "user.quick_resolve_conflict",
                        },
                        { exportToHub: true }
                      )
                    }
                    className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50"
                  >
                    Auto-fit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Error */}
      {state.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-3 py-2 text-sm">
          {String(state.error)}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------------------
// Subcomponents
// --------------------------------------------------------------------------------------
function ViewToggle({ view, setView }) {
  return (
    <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
      {VIEW_MODES.map((v) => {
        const active = v === view;
        return (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-3 py-1.5 text-sm rounded-md ${
              active ? "bg-slate-900 text-white" : "text-slate-900 hover:bg-slate-50"
            }`}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}

function DateNav({ view, anchor, setAnchor }) {
  const back = () => setAnchor((a) => addDays(a, view === "day" ? -1 : -7));
  const fwd = () => setAnchor((a) => addDays(a, view === "day" ? 1 : 7));
  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={back}
        className="text-sm px-2 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50"
        title="Previous"
      >
        ←
      </button>
      <div className="text-sm text-slate-700 min-w-[8ch] text-center font-medium">
        {anchor.toLocaleDateString([], { month: "short", day: "numeric" })}
      </div>
      <button
        onClick={fwd}
        className="text-sm px-2 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50"
        title="Next"
      >
        →
      </button>
    </div>
  );
}

function Legend() {
  return (
    <div className="ml-auto flex items-center gap-3">
      <LegendDot color="bg-emerald-500" label="On track" />
      <LegendDot color="bg-amber-500" label="At risk" />
      <LegendDot color="bg-red-600" label="Attention" />
    </div>
  );
}
function LegendDot({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

// --------------------------------------------------------------------------------------
// Schedule Grid (simple, responsive, no external DnD)
// --------------------------------------------------------------------------------------
function ScheduleGrid({ model, onSessionClick, onSessionNudge }) {
  const hours = model.hours;
  const columns = model.columns; // per-day columns for week view, or single-day
  return (
    <div className="grid grid-cols-[72px_1fr]">
      {/* Time rail */}
      <div className="border-r border-slate-200 bg-slate-50">
        {hours.map((h) => (
          <div
            key={h.label}
            className="h-14 border-b border-slate-100 text-[11px] text-slate-500 flex items-start justify-end pr-2 pt-1"
          >
            {h.label}
          </div>
        ))}
      </div>

      {/* Canvas */}
      <div className="relative">
        {/* Hour lines */}
        {hours.map((h, i) => (
          <div
            key={h.label}
            aria-hidden="true"
            className="h-14 border-b border-slate-100"
            style={{ gridRowStart: i + 1 }}
          />
        ))}

        {/* Columns wrapper */}
        <div
          className={`grid ${columns.length > 1 ? `grid-cols-${columns.length}` : "grid-cols-1"}`}
          style={{ position: "relative", marginTop: "-100%" }}
        />

        {/* Render sessions as absolutely positioned blocks */}
        <div className="absolute inset-0">
          {columns.map((day, colIdx) =>
            day.items.map((s) => {
              const topPct = s.relTopPct;
              const heightPct = s.relHeightPct;
              const leftPct =
                columns.length === 1 ? 0 : (colIdx * 100) / columns.length + s.laneOffsetPct;
              const widthPct =
                columns.length === 1
                  ? s.laneWidthPct
                  : (100 / columns.length) * s.laneWidthFraction;
              const riskClass =
                s.flags?.risk === "red"
                  ? "ring-red-300"
                  : s.flags?.risk === "amber"
                  ? "ring-amber-300"
                  : "ring-emerald-300";

              return (
                <div
                  key={`${s.id}-${colIdx}`}
                  className={`absolute rounded-lg border border-slate-300 bg-white/95 backdrop-blur p-2 shadow-sm ring-2 ${riskClass} hover:shadow-md`}
                  style={{
                    top: `${topPct}%`,
                    height: `${heightPct}%`,
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-slate-900 truncate">{s.title}</div>
                      <div className="text-[11px] text-slate-600">
                        {s.domain} · <span className="font-mono">{timeRangeLabel(s.startISO, s.endISO)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        className="text-[11px] px-1.5 py-0.5 rounded border border-slate-300 bg-white hover:bg-slate-50"
                        title="-5 min"
                        onClick={() => onSessionNudge?.(s, -5)}
                      >
                        −5
                      </button>
                      <button
                        className="text-[11px] px-1.5 py-0.5 rounded border border-slate-300 bg-white hover:bg-slate-50"
                        title="+5 min"
                        onClick={() => onSessionNudge?.(s, +5)}
                      >
                        +5
                      </button>
                    </div>
                  </div>
                  <button
                    onClick={() => onSessionClick?.(s)}
                    className="mt-1 text-[11px] underline underline-offset-2"
                    title="Open details"
                  >
                    Details
                  </button>
                  {Number.isFinite(s.flags?.overrunMs) && s.flags.overrunMs > 0 && (
                    <div className="mt-1 text-[11px] text-amber-700">
                      Overrun: {Math.round(s.flags.overrunMs / 60000)}m
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------
// Normalizers & grid model
// --------------------------------------------------------------------------------------
function normalizeSession(x) {
  if (!x) return null;
  const startISO = x.startISO || x.start || x.startTime || nowISO();
  const endISO = x.endISO || x.end || x.endTime || startISO;
  return {
    id: x.id || x.sessionId || `${startISO}:${x.title || "sess"}`,
    sessionId: x.sessionId || x.id,
    title: x.title || x.label || "Session",
    domain: x.domain || "general",
    startISO,
    endISO,
    resource: x.resource || null,
    people: x.people || [],
    status: x.status || "planned",
    flags: x.flags || {},
  };
}

function normalizeConflict(c) {
  if (!c) return null;
  return {
    id: c.id || c.conflictId || `${c.resourceId || "res"}:${c.window?.start || ""}`,
    domain: c.domain || "general",
    resource: c.resource || { id: c.resourceId, type: c.resourceType, name: c.resourceName },
    overlaps: Array.isArray(c.overlaps) ? c.overlaps : c.bookings || [],
    window: c.window || { start: c.start, end: c.end },
  };
}

function buildGridModel(sessions, start, end, view) {
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2, "0")}:00`;
    hours.push({ label, hour: h });
  }

  // Partition by day for week, single bucket for day
  const days = view === "day" ? [start] : Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const columns = days.map((d) => ({ date: d, items: [] }));

  // Compute relative positions and simple lane packing per column
  const totalMs = end - start;
  const byDay = new Map(columns.map((c, idx) => [idx, []]));

  (sessions || []).forEach((raw) => {
    const s = normalizeSession(raw);
    const sStart = new Date(s.startISO);
    const sEnd = new Date(s.endISO);
    if (sEnd <= start || sStart >= end) return; // outside window

    // Assign day index
    const dayIdx = clamp(Math.floor((startOfDay(sStart) - start) / (24 * 3600 * 1000)), 0, columns.length - 1);

    // Relative top/height (0-100%)
    const relTopPct = ((Math.max(0, sStart - start) / totalMs) * 100);
    const relHeightPct = ((Math.max(15 * 60 * 1000, sEnd - sStart) / totalMs) * 100); // min 15min

    byDay.get(dayIdx).push({
      ...s,
      relTopPct,
      relHeightPct,
    });
  });

  // Lane packing (avoid overlaps in same column)
  for (const [idx, items] of byDay.entries()) {
    const lanes = [];
    items
      .sort((a, b) => new Date(a.startISO) - new Date(b.startISO))
      .forEach((it) => {
        let placed = false;
        for (let l = 0; l < lanes.length; l++) {
          const last = lanes[l][lanes[l].length - 1];
          if (new Date(last.endISO) <= new Date(it.startISO)) {
            lanes[l].push(it);
            it.lane = l;
            placed = true;
            break;
          }
        }
        if (!placed) {
          lanes.push([it]);
          it.lane = lanes.length - 1;
        }
      });

    const maxLanes = Math.max(1, lanes.length);
    items.forEach((it) => {
      it.laneOffsetPct = (it.lane / maxLanes) * 100;
      it.laneWidthPct = 100 / maxLanes;
      it.laneWidthFraction = 1 / maxLanes;
    });

    columns[idx].items = items;
  }

  return { hours, columns };
}

function timeRangeLabel(a, b) {
  const A = new Date(a);
  const B = new Date(b);
  return `${A.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${B.toLocaleTimeString(
    [],
    { hour: "2-digit", minute: "2-digit" }
  )}`;
}

function rangesIntersect(a1, a2, b1, b2) {
  const A1 = a1 ? new Date(a1).getTime() : 0;
  const A2 = a2 ? new Date(a2).getTime() : 0;
  const B1 = b1 ? new Date(b1).getTime() : 0;
  const B2 = b2 ? new Date(b2).getTime() : 0;
  if (!A1 || !A2 || !B1 || !B2) return true;
  return Math.max(A1, B1) < Math.min(A2, B2);
}
