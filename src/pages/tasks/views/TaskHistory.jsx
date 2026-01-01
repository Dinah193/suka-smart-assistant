// C:\Users\larho\suka-smart-assistant\src\pages\tasks\views\TaskHistory.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * TaskHistory.jsx
 * Suka Smart Assistant — Unified Task History
 * --------------------------------------------------------------------
 * Goals:
 * 1) Clear IA: filterable history (All / Meals / Inventory / Calendar), search,
 *    date range, status chips, and deep-link routes from jobs registry.
 * 2) Intuitive flow: each card shows steps, status, Undo (when available),
 *    and a single “Next Best Action” CTA after success.
 * 3) Consistent design: cards, buttons, empty/loading states & toasts via events.
 * 4) Event-driven UI: reacts to recipe.consolidated, inventory.updated,
 *    calendar.synced, preferences.changed to refresh history badges/filters.
 *
 * This page listens to the Jobs Engine event bus and maintains a local,
 * lightweight index of task runs. It also persists to localStorage so
 * refreshes still show recent history.
 */

// ---- Soft imports: fail gracefully if a service is not present -------------
let Jobs = null;
try {
  // eslint-disable-next-line import/no-unresolved
  Jobs = require("@/services/jobs/engine.js");
} catch (_) {
  Jobs = null;
}

let runtimeAutomation = null;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ automation: runtimeAutomation } = require("@/services/automation/runtime"));
} catch (_) {
  runtimeAutomation = null;
}

// ---- Local constants --------------------------------------------------------
const LS_KEY = "suka.tasks.history";
const MAX_ROWS = 400;

// ---- Utilities --------------------------------------------------------------
const nowISO = () => new Date().toISOString();

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function prettyMs(ms) {
  if (!ms && ms !== 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

const STATUS_COLORS = {
  running: "badge-info",
  succeeded: "badge-success",
  failed: "badge-error",
  undone: "badge-warning",
};

const CATEGORY_COLORS = {
  meals: "badge-secondary",
  inventory: "badge-accent",
  calendar: "badge-info",
  other: "badge-ghost",
};

// ---- Empty state component --------------------------------------------------
function EmptyState({ title, description, actions = [] }) {
  return (
    <div className="w-full p-8 flex flex-col items-center justify-center text-center">
      <div className="text-2xl font-semibold mb-2">{title}</div>
      <p className="text-base-content/70 max-w-xl mb-6">{description}</p>
      <div className="flex flex-wrap gap-2">
        {actions.map((a, idx) => (
          <button
            key={idx}
            onClick={() => handleAction(a)}
            className="btn btn-primary btn-sm rounded-2xl"
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Generic dispatcher for NBAs / actions
function handleAction(action) {
  if (!action) return;
  // type: nav | dispatch | ui | defer
  if (action.type === "nav") {
    // relies on your router; fall back to window.location
    if (action.to?.startsWith("http")) window.location.href = action.to;
    else window.location.hash = `#${action.to}`;
  } else if (action.type === "dispatch") {
    // bubble as a CustomEvent for a global event bridge
    window.dispatchEvent(new CustomEvent(action.event || "suka.dispatch", { detail: action.payload || {} }));
  } else if (action.type === "ui") {
    window.dispatchEvent(new CustomEvent(action.event || "suka.ui", { detail: action.payload || {} }));
  } else if (action.type === "defer") {
    // no background jobs here; just toast a reminder
    window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind: "info", message: "Scheduled to resume later." } }));
  }
}

// ---- Filters Header ---------------------------------------------------------
function FiltersBar({ q, setQ, status, setStatus, category, setCategory, dateFrom, setDateFrom, dateTo, setDateTo, onReset }) {
  return (
    <div className="card bg-base-100 shadow-sm mb-4 rounded-2xl">
      <div className="card-body gap-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="form-control w-full">
            <div className="label"><span className="label-text">Search</span></div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              type="text"
              placeholder="Search job, step, or notes…"
              className="input input-bordered rounded-2xl"
            />
          </label>

          <label className="form-control">
            <div className="label"><span className="label-text">Status</span></div>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="select select-bordered rounded-2xl"
            >
              <option value="all">All</option>
              <option value="running">Running</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="undone">Undone</option>
            </select>
          </label>

          <label className="form-control">
            <div className="label"><span className="label-text">Category</span></div>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="select select-bordered rounded-2xl"
            >
              <option value="all">All</option>
              <option value="meals">Meals</option>
              <option value="inventory">Inventory</option>
              <option value="calendar">Calendar</option>
              <option value="other">Other</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="form-control">
              <div className="label"><span className="label-text">From</span></div>
              <input
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                type="date"
                className="input input-bordered rounded-2xl"
              />
            </label>
            <label className="form-control">
              <div className="label"><span className="label-text">To</span></div>
              <input
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                type="date"
                className="input input-bordered rounded-2xl"
              />
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-sm opacity-70">
            Tips: Click a card to expand details. Use Undo for the most recent reversible step.
          </div>
          <button className="btn btn-ghost btn-sm rounded-2xl" onClick={onReset}>
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Row/Card ---------------------------------------------------------------
function HistoryCard({ row, onUndo, onNBA }) {
  const statusBadge = STATUS_COLORS[row.status] || "badge-ghost";
  const categoryBadge = CATEGORY_COLORS[row.category || "other"] || "badge-ghost";
  const [open, setOpen] = useState(false);

  return (
    <div className="card bg-base-100 shadow-sm rounded-2xl border border-base-200">
      <div className="card-body py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={classNames("badge", statusBadge, "rounded-full")}>{row.status}</span>
              <span className={classNames("badge", categoryBadge, "rounded-full")}>{row.category || "other"}</span>
              <span className="badge badge-outline rounded-full">{row.jobId}</span>
              {row.stepsCompleted != null && (
                <span className="badge badge-outline rounded-full">{row.stepsCompleted} step{row.stepsCompleted === 1 ? "" : "s"}</span>
              )}
            </div>
            <div className="mt-1 text-lg font-semibold">{row.label || row.title || "Task"}</div>
            <div className="text-sm opacity-70">
              {new Date(row.startedAt || row.timestamp).toLocaleString()} · {prettyMs(row.durationMs)} · {row.path || "/"}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {row.status === "succeeded" && !!onNBA && (
              <button className="btn btn-primary btn-sm rounded-2xl" onClick={() => onNBA(row)}>
                Next Best Action
              </button>
            )}
            <button className="btn btn-outline btn-sm rounded-2xl" onClick={() => setOpen((s) => !s)}>
              {open ? "Hide" : "Details"}
            </button>
            <button
              className="btn btn-ghost btn-sm rounded-2xl"
              onClick={() => onUndo?.(row)}
              disabled={!row.undoEligible}
              title={row.undoEligible ? "Undo last step" : "Nothing to undo"}
            >
              Undo
            </button>
          </div>
        </div>

        {open && (
          <div className="mt-3">
            {row.notes && <p className="text-sm mb-2">{row.notes}</p>}

            <div className="overflow-x-auto">
              <table className="table table-zebra">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Label</th>
                    <th>Status</th>
                    <th>At</th>
                  </tr>
                </thead>
                <tbody>
                  {(row.steps || []).map((s, idx) => (
                    <tr key={idx}>
                      <td className="font-mono text-xs">{s.id || idx + 1}</td>
                      <td>{s.label || "Step"}</td>
                      <td><span className="badge badge-ghost rounded-full">{s.status || "done"}</span></td>
                      <td className="text-xs opacity-70">{s.at ? new Date(s.at).toLocaleTimeString() : "—"}</td>
                    </tr>
                  ))}
                  {(row.steps || []).length === 0 && (
                    <tr><td colSpan={4} className="opacity-70">No step details captured.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {row.ctxSummary && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold">Context</summary>
                <pre className="mt-2 bg-base-200 p-3 rounded-xl text-xs overflow-x-auto">
                  {JSON.stringify(row.ctxSummary, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Main Page --------------------------------------------------------------
export default function TaskHistory() {
  const [rows, setRows] = useState(() => readLS(LS_KEY, []));
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [category, setCategory] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const mountedRef = useRef(false);

  // Persist history
  useEffect(() => {
    writeLS(LS_KEY, rows.slice(0, MAX_ROWS));
  }, [rows]);

  // Event subscriptions: Jobs Engine + domain glue
  useEffect(() => {
    if (!Jobs) return; // soft-fail

    mountedRef.current = true;

    const onRunStart = ({ jobRunId, jobId }) => {
      const job = Jobs.getJob?.(jobId) || {};
      setRows((prev) => [
        {
          id: jobRunId,
          jobRunId,
          jobId,
          label: job.label || jobId,
          category: job.category || "other",
          path: job.path || "/",
          status: "running",
          startedAt: nowISO(),
          timestamp: Date.now(),
          stepsCompleted: 0,
          steps: [],
          undoEligible: false,
        },
        ...prev.filter((r) => r.jobRunId !== jobRunId),
      ]);
    };

    const onStep = ({ jobRunId, stepId, label }) => {
      setRows((prev) =>
        prev.map((r) =>
          r.jobRunId === jobRunId
            ? {
                ...r,
                stepsCompleted: (r.stepsCompleted || 0) + 1,
                steps: [...(r.steps || []), { id: stepId, label, status: "done", at: nowISO() }],
                undoEligible: true,
              }
            : r
        )
      );
    };

    const onSuccess = ({ jobRunId, jobId, ctx }) => {
      const job = Jobs.getJob?.(jobId) || {};
      setRows((prev) =>
        prev.map((r) =>
          r.jobRunId === jobRunId
            ? {
                ...r,
                status: "succeeded",
                finishedAt: nowISO(),
                durationMs: Date.now() - new Date(r.startedAt || Date.now()).getTime(),
                ctxSummary: summarizeCtx(ctx),
                label: job.label || r.label,
                category: job.category || r.category,
                path: job.path || r.path,
              }
            : r
        )
      );

      // Offer a toast + NBA suggestion
      window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind: "success", message: `${job.label || jobId} completed` } }));
      const nba = Jobs.suggestNextBestAction?.(jobRunId);
      if (nba) window.dispatchEvent(new CustomEvent("ui.nba.suggest", { detail: nba }));
    };

    const onFail = ({ jobRunId, error }) => {
      setRows((prev) =>
        prev.map((r) => (r.jobRunId === jobRunId ? { ...r, status: "failed", error, finishedAt: nowISO() } : r))
      );
      window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind: "error", message: `Task failed: ${error || "Unknown error"}` } }));
    };

    const onUndo = ({ jobRunId }) => {
      setRows((prev) =>
        prev.map((r) => (r.jobRunId === jobRunId ? { ...r, status: "undone", finishedAt: nowISO() } : r))
      );
      window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind: "warning", message: "Last step undone" } }));
    };

    // Domain glue: when these fire, we refresh filters/badges (and optionally decorate latest row)
    const onDomainChange = (scope) => () => {
      window.dispatchEvent(new CustomEvent("ui.badges.refresh", { detail: { scope } }));
      window.dispatchEvent(new CustomEvent("ui.filters.refresh", { detail: { scope } }));
    };

    // Subscribe
    const off1 = Jobs.on?.("jobs.run.started", onRunStart);
    const off2 = Jobs.on?.("jobs.step.completed", onStep);
    const off3 = Jobs.on?.("jobs.run.succeeded", onSuccess);
    const off4 = Jobs.on?.("jobs.run.failed", onFail);
    const off5 = Jobs.on?.("jobs.undo.performed", onUndo);

    const offR = Jobs.on?.("recipe.consolidated", onDomainChange("meals"));
    const offI = Jobs.on?.("inventory.updated", onDomainChange("inventory"));
    const offC = Jobs.on?.("calendar.synced", onDomainChange("calendar"));
    const offP = Jobs.on?.("preferences.changed", onDomainChange("global"));

    return () => {
      off1 && off1();
      off2 && off2();
      off3 && off3();
      off4 && off4();
      off5 && off5();
      offR && offR();
      offI && offI();
      offC && offC();
      offP && offP();
      mountedRef.current = false;
    };
  }, []);

  // Undo handler (single-level per engine semantics)
  const handleUndo = async (row) => {
    if (!Jobs?.undo) return;
    const res = await Jobs.undo(row.jobRunId);
    if (!res?.ok) {
      window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind: "error", message: "Nothing to undo" } }));
      return;
    }
    // engine will emit jobs.undo.performed; our subscription updates UI
  };

  // Next Best Action handler
  const handleNBA = (row) => {
    const nba = Jobs?.suggestNextBestAction?.(row.jobRunId);
    if (nba) handleAction(nba.action ? nba : { type: "ui", event: "ui.nba.suggest", payload: nba });
  };

  // Derived filters
  const filtered = useMemo(() => {
    const qNorm = q.trim().toLowerCase();
    const df = dateFrom ? new Date(dateFrom).getTime() : null;
    const dt = dateTo ? new Date(dateTo).getTime() + 24 * 3600 * 1000 - 1 : null;

    return rows.filter((r) => {
      if (status !== "all" && r.status !== status) return false;
      if (category !== "all" && (r.category || "other") !== category) return false;

      const t = new Date(r.startedAt || r.timestamp || Date.now()).getTime();
      if (df && t < df) return false;
      if (dt && t > dt) return false;

      if (!qNorm) return true;
      const hay = [
        r.jobId,
        r.label,
        r.category,
        r.path,
        r.notes,
        ...(r.steps || []).map((s) => `${s.id} ${s.label}`),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(qNorm);
    });
  }, [rows, q, status, category, dateFrom, dateTo]);

  // Reset filters
  const handleReset = () => {
    setQ(""); setStatus("all"); setCategory("all"); setDateFrom(""); setDateTo("");
  };

  // Loading/Empty states
  const isEmpty = filtered.length === 0;

  return (
    <div className="w-full max-w-6xl mx-auto px-4 md:px-0">
      <div className="mb-4">
        <h1 className="text-2xl md:text-3xl font-bold">Task History</h1>
        <p className="opacity-70">Review completed, running, or failed jobs across Meals, Inventory, and Calendar.</p>
      </div>

      <FiltersBar
        q={q} setQ={setQ}
        status={status} setStatus={setStatus}
        category={category} setCategory={setCategory}
        dateFrom={dateFrom} setDateFrom={setDateFrom}
        dateTo={dateTo} setDateTo={setDateTo}
        onReset={handleReset}
      />

      {/* Loading skeleton (only on first mount without any items) */}
      {rows.length === 0 && (
        <div className="grid gap-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="animate-pulse h-28 bg-base-200 rounded-2xl" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {rows.length > 0 && isEmpty && (
        <EmptyState
          title="No tasks match your filters"
          description="Try clearing the filters or broaden the date range."
          actions={[
            { label: "Clear Filters", type: "ui", event: "ui.filters.clear" },
            { label: "Plan Meals", type: "nav", to: "/tier2/household/meals/plan" },
            { label: "Reconcile Inventory", type: "nav", to: "/tier2/household/inventory/reconcile" },
          ]}
        />
      )}

      {/* List */}
      {!isEmpty && (
        <div className="grid gap-3">
          {filtered.map((row) => (
            <HistoryCard key={row.jobRunId} row={row} onUndo={handleUndo} onNBA={handleNBA} />
          ))}
        </div>
      )}

      <div className="h-8" />

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2">
        <button
          className="btn btn-outline btn-sm rounded-2xl"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          Back to Top
        </button>
        <button
          className="btn btn-primary btn-sm rounded-2xl"
          onClick={() => handleAction({ type: "nav", to: "/dashboard" })}
        >
          Go to Dashboard
        </button>
      </div>
    </div>
  );
}

// ---- Helpers ----------------------------------------------------------------
function summarizeCtx(ctx) {
  if (!ctx) return null;
  // Provide a small, privacy-safe snapshot for quick glance
  const keys = Object.keys(ctx);
  const pick = {};
  for (const k of keys) {
    if (["plan", "pending", "events", "keys", "resolvedAt"].includes(k)) {
      // summarize arrays/objects into counts or small previews
      const v = ctx[k];
      if (Array.isArray(v)) pick[k] = `${v.length} item(s)`;
      else if (v && typeof v === "object") pick[k] = Object.keys(v).slice(0, 5);
      else pick[k] = v;
    }
  }
  return pick;
}
