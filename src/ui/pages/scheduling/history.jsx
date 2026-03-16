// File: C:\Users\larho\suka-smart-assistant\src\ui\pages\scheduling\history.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";

// 🔌 Shared services (assumed to exist per SSA conventions)
import eventBus from "@/services/events/eventBus";
import featureFlags from "@/config/featureFlags";
import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

// 📈 Charts (project convention: recharts is available)
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
  Legend,
} from "recharts";

/**
 * Scheduling › History & Calibration
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Visualize historical runs of sessions/tasks (actual vs estimated),
 *    track overruns/underruns, and manage calibration updates that feed the
 *    planning engines.
 *
 * Pipeline fit (imports → intelligence → automation → (optional) hub export)
 *  - Imports create sessions; engines record execution metrics -> events like:
 *      • session.run.logged
 *      • session.task.completed
 *      • timer.overrun
 *  - Intelligence builds aggregates (bias, variance, p50/p90), which this page
 *    fetches/subscribes to for analytics visualizations.
 *  - Automation can be tuned via "Apply calibration" based on history; when user
 *    applies a model update, we emit a normalized event and (optionally) export
 *    to the Hub using exportToHubIfEnabled(payload).
 *
 * Forward-thinking
 *  - Domain-agnostic filters (cooking, cleaning, garden, animals, storehouse, preservation).
 *  - Extensible metric registry.
 *  - Defensive: renders gracefully with partial data; isolates single-use helpers.
 */

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const SOURCE = "ui.scheduling.history";
const nowISO = () => new Date().toISOString();

function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  try {
    const pkt = HubPacketFormatter.format(payload);
    FamilyFundConnector.send(pkt);
  } catch {
    // Hub is optional; fail silently
  }
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}
function fmtMin(n) {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)} min`;
}
function safeNum(n, f = 0) {
  return Number.isFinite(n) ? n : f;
}
function daysAgoISO(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

const DOMAINS = [
  "all",
  "cooking",
  "cleaning",
  "garden",
  "animals",
  "storehouse",
  "preservation",
];

// -----------------------------------------------------------------------------
// Data access (defensive): we try a service, else fall back to eventBus request.
// Assumed service shape if present: src/services/analyticsService.js
//   - getHistory({from,to,domain}) -> { runs: [], tasks: [] }
//   - getCalibrationSummary({from,to,domain}) -> { bias, variance, p50, p90, modelVersion, sampleSize }
//   - applyCalibration({strategy, domain, params}) -> { modelVersion }
// -----------------------------------------------------------------------------
let svc = null;
try {
  // Lazy/optional import to avoid hard crash if not wired yet
  // eslint-disable-next-line global-require, import/no-unresolved
  svc = require("../../services/analyticsService").default;
} catch {
  // no-op; we will use eventBus request pattern
}

async function fetchHistory(filters) {
  if (svc?.getHistory) return svc.getHistory(filters);
  // Request-response via eventBus (the analytics daemon should reply with `analytics.history.result`)
  return new Promise((resolve) => {
    const payload = {
      type: "analytics.history.request",
      ts: nowISO(),
      source: SOURCE,
      data: filters,
    };
    const off = eventBus.on("analytics.history.result", (e) => {
      off?.();
      resolve(e?.data || { runs: [], tasks: [] });
    });
    eventBus.emit(payload.type, payload);
    // Fallback timeout
    setTimeout(() => {
      off?.();
      resolve({ runs: [], tasks: [] });
    }, 3000);
  });
}

async function fetchCalibration(filters) {
  if (svc?.getCalibrationSummary) return svc.getCalibrationSummary(filters);
  return new Promise((resolve) => {
    const payload = {
      type: "analytics.calibration.request",
      ts: nowISO(),
      source: SOURCE,
      data: filters,
    };
    const off = eventBus.on("analytics.calibration.result", (e) => {
      off?.();
      resolve(e?.data || {});
    });
    eventBus.emit(payload.type, payload);
    setTimeout(() => {
      off?.();
      resolve({});
    }, 3000);
  });
}

async function applyCalibration(strategy, domain, params) {
  if (svc?.applyCalibration)
    return svc.applyCalibration({ strategy, domain, params });
  // Emit command; listener should update model and reply
  return new Promise((resolve) => {
    const cmd = {
      type: "calibration.model.update",
      ts: nowISO(),
      source: SOURCE,
      data: { strategy, domain, params },
    };
    eventBus.emit(cmd.type, cmd);
    exportToHubIfEnabled(cmd); // 🔁 changes household planning behavior → export optional
    const off = eventBus.on("calibration.model.update.result", (e) => {
      off?.();
      resolve(e?.data || {});
    });
    setTimeout(() => {
      off?.();
      resolve({});
    }, 3000);
  });
}

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const initialFilters = {
  domain: "all",
  from: daysAgoISO(30),
  to: nowISO(),
};
const initialState = {
  loading: true,
  runs: [], // each: { id, date, domain, sessionId, estimateMin, actualMin, overrunMin, tasks:int }
  tasks: [], // fine-grained if available
  calib: {
    bias: 0, // mean signed error (actual-estimate)/estimate
    variance: 0,
    p50: 0,
    p90: 0,
    modelVersion: "v0",
    sampleSize: 0,
  },
  error: null,
};

function reducer(state, action) {
  switch (action.type) {
    case "LOAD_START":
      return { ...state, loading: true, error: null };
    case "LOAD_SUCCESS":
      return {
        ...state,
        loading: false,
        runs: action.runs || [],
        tasks: action.tasks || [],
        calib: { ...state.calib, ...(action.calib || {}) },
        error: null,
      };
    case "LOAD_ERROR":
      return {
        ...state,
        loading: false,
        error: action.error || "Failed to load analytics.",
      };
    default:
      return state;
  }
}

// -----------------------------------------------------------------------------
// Page Component
// -----------------------------------------------------------------------------
export default function SchedulingHistoryPage() {
  const [filters, setFilters] = useState(initialFilters);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [calibForm, setCalibForm] = useState({
    strategy: "proportional_bias",
    factor: 0.1,
  });

  const load = useCallback(async () => {
    dispatch({ type: "LOAD_START" });
    try {
      const [hist, cal] = await Promise.all([
        fetchHistory(filters),
        fetchCalibration(filters),
      ]);
      dispatch({
        type: "LOAD_SUCCESS",
        runs: hist?.runs || [],
        tasks: hist?.tasks || [],
        calib: cal || {},
      });
    } catch (err) {
      dispatch({ type: "LOAD_ERROR", error: String(err?.message || err) });
    }
  }, [filters]);

  // Initial & reactive load
  useEffect(() => {
    load();
  }, [load]);

  // Live updates: if new executions come in, append and recompute lightweight KPIs
  useEffect(() => {
    const off = eventBus.on("session.run.logged", (e) => {
      const d = e?.data;
      if (!d) return;
      if (filters.domain !== "all" && d.domain !== filters.domain) return;
      dispatch({
        type: "LOAD_SUCCESS",
        runs: [
          {
            // build minimal row
            id: d.runId || `${d.sessionId}:${d.ts || nowISO()}`,
            date: d.ts || nowISO(),
            domain: d.domain,
            sessionId: d.sessionId,
            estimateMin: safeNum(d.estimateMin),
            actualMin: safeNum(d.actualMin),
            overrunMin: safeNum(d.actualMin - d.estimateMin),
            tasks: safeNum(d.taskCount, 0),
          },
          ...(state.runs || []),
        ].slice(0, 250),
        tasks: state.tasks,
        calib: state.calib,
      });
    });
    return () => {
      try {
        off?.();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.domain, state.runs, state.tasks, state.calib]);

  // Derived KPIs
  const kpis = useMemo(() => {
    const rows = state.runs;
    if (!rows?.length) {
      return { onTime: 1, avgOverrun: 0, bias: 0, count: 0 };
    }
    const count = rows.length;
    const onTimeCount = rows.filter(
      (r) => (r.actualMin || 0) <= (r.estimateMin || 0) + 0.5
    ).length;
    const onTime = onTimeCount / count;
    const avgOverrun =
      rows.reduce((acc, r) => acc + safeNum(r.actualMin - r.estimateMin), 0) /
      count;
    const bias =
      rows.reduce(
        (acc, r) =>
          acc +
          safeNum(r.actualMin - r.estimateMin) / Math.max(1, r.estimateMin),
        0
      ) / count;
    return { onTime, avgOverrun, bias, count };
  }, [state.runs]);

  // Chart data
  const timeSeries = useMemo(
    () =>
      (state.runs || [])
        .slice()
        .reverse()
        .map((r) => ({
          x: new Date(r.date).toLocaleDateString([], {
            month: "numeric",
            day: "numeric",
          }),
          estimate: safeNum(r.estimateMin),
          actual: safeNum(r.actualMin),
          overrun: safeNum(r.actualMin - r.estimateMin),
        })),
    [state.runs]
  );

  const domainBars = useMemo(() => {
    const map = new Map();
    for (const r of state.runs || []) {
      const key = r.domain || "general";
      const cur = map.get(key) || { domain: key, runs: 0, overruns: 0 };
      cur.runs += 1;
      cur.overruns += safeNum(r.actualMin - r.estimateMin) > 0 ? 1 : 0;
      map.set(key, cur);
    }
    return Array.from(map.values()).map((d) => ({
      domain: d.domain,
      runs: d.runs,
      overrunRate: d.runs ? d.overruns / d.runs : 0,
    }));
  }, [state.runs]);

  // Actions
  const onApplyCalibration = useCallback(async () => {
    const domain = filters.domain === "all" ? undefined : filters.domain;
    const params = { ...calibForm };
    const res = await applyCalibration(calibForm.strategy, domain, params);
    // Soft refresh to reflect new modelVersion
    load();
    // Emit a user action for analytics/navigation
    const payload = {
      type: "ui.calibration.applied",
      ts: nowISO(),
      source: SOURCE,
      data: {
        domain: domain || "all",
        strategy: calibForm.strategy,
        params,
        result: res,
      },
    };
    eventBus.emit(payload.type, payload);
    eventBus.emit("ui.action", payload);
  }, [calibForm, filters.domain, load]);

  const onRecomputeAnalytics = useCallback(() => {
    const payload = {
      type: "analytics.recompute.request",
      ts: nowISO(),
      source: SOURCE,
      data: { ...filters },
    };
    eventBus.emit(payload.type, payload);
    eventBus.emit("ui.action", payload);
  }, [filters]);

  // UI
  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            Scheduling history & calibration
          </h1>
          <p className="text-sm text-slate-600">
            Track estimate accuracy, overruns, and tune calibration used by
            planners.
          </p>
        </div>
        <Filters filters={filters} setFilters={setFilters} onRefresh={load} />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="On-time rate"
          value={fmtPct(kpis.onTime)}
          sub={`${kpis.count} runs`}
        />
        <KpiCard
          label="Avg overrun"
          value={fmtMin(kpis.avgOverrun)}
          sub="mean (min)"
        />
        <KpiCard
          label="Estimate bias"
          value={fmtPct(kpis.bias)}
          sub="mean signed %"
        />
        <KpiCard
          label="Model version"
          value={state.calib?.modelVersion || "—"}
          sub={`n=${state.calib?.sampleSize || 0}`}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <ChartCard title="Estimate vs Actual (time series)">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={timeSeries}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="x" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="estimate" />
              <Line type="monotone" dataKey="actual" />
              <Line type="monotone" dataKey="overrun" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Overrun rate by domain">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={domainBars}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="domain" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="runs" />
              <Bar dataKey="overrunRate" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Calibration percentiles">
          <div className="p-3 grid grid-cols-3 gap-3">
            <MiniStat label="p50 error" value={fmtPct(state.calib?.p50)} />
            <MiniStat label="p90 error" value={fmtPct(state.calib?.p90)} />
            <MiniStat label="variance" value={fmtPct(state.calib?.variance)} />
          </div>
        </ChartCard>
      </div>

      {/* Controls: Calibration */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Calibration controls
            </h3>
            <p className="text-xs text-slate-600">
              Apply a model tweak based on recent history. This affects future
              plans.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onRecomputeAnalytics}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50"
            >
              Recompute analytics
            </button>
          </div>
        </div>

        <div className="p-4 grid md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-slate-700 mb-1">
              Strategy
            </label>
            <select
              value={calibForm.strategy}
              onChange={(e) =>
                setCalibForm((s) => ({ ...s, strategy: e.target.value }))
              }
              className="w-full text-sm border border-slate-300 rounded-lg px-2 py-1.5 bg-white"
            >
              <option value="proportional_bias">
                Proportional bias (scale by %)
              </option>
              <option value="offset_minutes">Fixed offset (± minutes)</option>
              <option value="quantile_fit">Quantile fit (target p90)</option>
            </select>
          </div>

          {calibForm.strategy === "proportional_bias" && (
            <div>
              <label className="block text-xs text-slate-700 mb-1">
                Factor (e.g., 0.10 = +10%)
              </label>
              <input
                type="number"
                step="0.01"
                value={calibForm.factor}
                onChange={(e) =>
                  setCalibForm((s) => ({
                    ...s,
                    factor: Number(e.target.value),
                  }))
                }
                className="w-full text-sm border border-slate-300 rounded-lg px-2 py-1.5"
              />
            </div>
          )}

          {calibForm.strategy === "offset_minutes" && (
            <div>
              <label className="block text-xs text-slate-700 mb-1">
                Offset (minutes)
              </label>
              <input
                type="number"
                step="1"
                value={calibForm.offset || 5}
                onChange={(e) =>
                  setCalibForm((s) => ({
                    ...s,
                    offset: Number(e.target.value),
                  }))
                }
                className="w-full text-sm border border-slate-300 rounded-lg px-2 py-1.5"
              />
            </div>
          )}

          {calibForm.strategy === "quantile_fit" && (
            <div>
              <label className="block text-xs text-slate-700 mb-1">
                Target p90 (e.g., 0.85)
              </label>
              <input
                type="number"
                step="0.01"
                value={calibForm.targetP90 || 0.85}
                onChange={(e) =>
                  setCalibForm((s) => ({
                    ...s,
                    targetP90: Number(e.target.value),
                  }))
                }
                className="w-full text-sm border border-slate-300 rounded-lg px-2 py-1.5"
              />
            </div>
          )}

          <div className="md:col-span-3 flex items-center justify-end">
            <button
              onClick={onApplyCalibration}
              className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
              disabled={state.loading}
            >
              Apply calibration
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Recent runs</h3>
          {state.loading && (
            <span className="text-[11px] text-slate-600">Loading…</span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                <Th>When</Th>
                <Th>Domain</Th>
                <Th>Session</Th>
                <Th className="text-right">Estimate</Th>
                <Th className="text-right">Actual</Th>
                <Th className="text-right">Overrun</Th>
                <Th className="text-right">Tasks</Th>
              </tr>
            </thead>
            <tbody>
              {(state.runs || []).map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-slate-100 hover:bg-slate-50/50"
                >
                  <Td>
                    {new Date(r.date).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Td>
                  <Td>{r.domain || "—"}</Td>
                  <Td>
                    <button
                      onClick={() => {
                        const payload = {
                          type: "ui.session.open_details",
                          ts: nowISO(),
                          source: SOURCE,
                          data: { sessionId: r.sessionId, domain: r.domain },
                        };
                        eventBus.emit(payload.type, payload);
                        eventBus.emit("ui.action", payload);
                      }}
                      className="underline underline-offset-2"
                      title="Open session details"
                    >
                      {r.sessionId || "—"}
                    </button>
                  </Td>
                  <Td className="text-right">{fmtMin(r.estimateMin)}</Td>
                  <Td className="text-right">{fmtMin(r.actualMin)}</Td>
                  <Td
                    className={`text-right ${
                      safeNum(r.actualMin - r.estimateMin) > 0
                        ? "text-red-600"
                        : "text-emerald-600"
                    }`}
                  >
                    {fmtMin(safeNum(r.actualMin - r.estimateMin))}
                  </Td>
                  <Td className="text-right">{r.tasks ?? "—"}</Td>
                </tr>
              ))}
              {!state.runs?.length && !state.loading && (
                <tr>
                  <Td colSpan={7} className="text-center text-slate-500 py-8">
                    No historical runs in the selected window.
                  </Td>
                </tr>
              )}
            </tbody>
          </table>
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

// -----------------------------------------------------------------------------
// UI Fragments
// -----------------------------------------------------------------------------
function Filters({ filters, setFilters, onRefresh }) {
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  return (
    <div className="flex flex-col md:flex-row gap-2">
      <select
        className="text-sm border border-slate-300 rounded-lg px-2 py-1.5 bg-white"
        value={filters.domain}
        onChange={(e) => set({ domain: e.target.value })}
        title="Domain filter"
      >
        {DOMAINS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <input
        type="datetime-local"
        className="text-sm border border-slate-300 rounded-lg px-2 py-1.5"
        value={toLocalInput(filters.from)}
        onChange={(e) => set({ from: fromLocalInput(e.target.value) })}
        title="From"
      />
      <input
        type="datetime-local"
        className="text-sm border border-slate-300 rounded-lg px-2 py-1.5"
        value={toLocalInput(filters.to)}
        onChange={(e) => set({ to: fromLocalInput(e.target.value) })}
        title="To"
      />
      <button
        onClick={onRefresh}
        className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50"
      >
        Refresh
      </button>
    </div>
  );
}

function KpiCard({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-3">
      <div className="text-xs text-slate-600">{label}</div>
      <div className="text-xl font-semibold text-slate-900 mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs text-slate-600">{label}</div>
      <div className="text-base font-semibold text-slate-900 mt-0.5">
        {value}
      </div>
    </div>
  );
}

function Th({ children, className = "" }) {
  return (
    <th className={`text-left text-xs font-semibold px-3 py-2 ${className}`}>
      {children}
    </th>
  );
}
function Td({ children, className = "", colSpan }) {
  return (
    <td className={`px-3 py-2 align-middle ${className}`} colSpan={colSpan}>
      {children}
    </td>
  );
}

// -----------------------------------------------------------------------------
// Tiny date helpers for <input type="datetime-local"> binding
// -----------------------------------------------------------------------------
function toLocalInput(iso) {
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  } catch {
    return "";
  }
}
function fromLocalInput(local) {
  try {
    // Treat local time as-is and convert to ISO
    const d = new Date(local);
    return d.toISOString();
  } catch {
    return nowISO();
  }
}
