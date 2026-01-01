// C:\Users\larho\suka-smart-assistant\src\pages\tasks\views\TaskRun.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * TaskRun.jsx
 * Suka Smart Assistant — Task Run Viewer
 * --------------------------------------------------------------------
 * Purpose
 * 1) Clear IA: deep-linked view for a single job run with breadcrumbs,
 *    progress, steps timeline, and route hints back to History/Dashboard.
 * 2) Intuitive flow: obvious primary CTA, per-step details, Undo, Retry,
 *    and a single “Next Best Action” after success.
 * 3) Consistent design: DaisyUI/Tailwind cards, buttons, badges, toasts,
 *    loading & empty states, and confirmation patterns.
 * 4) Event-driven glue: listens to recipe.consolidated, inventory.updated,
 *    calendar.synced, preferences.changed and engine events to live-update.
 *
 * Usage
 * <TaskRun jobRunId="jobrun_abcd_12345" />
 * …or detect from URL query (?run=jobrun_…) / hash segment.
 */

// ---- Soft imports (fail gracefully if service missing) ----------------------
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

// ---- Utils -----------------------------------------------------------------
function classNames(...xs) { return xs.filter(Boolean).join(" "); }
function prettyMs(ms) {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function getQueryParam(name) {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}
function nowISO() { return new Date().toISOString(); }

const STATUS_STYLES = {
  running: { badge: "badge-info", bar: "progress-info" },
  succeeded: { badge: "badge-success", bar: "progress-success" },
  failed: { badge: "badge-error", bar: "progress-error" },
  undone: { badge: "badge-warning", bar: "progress-warning" }
};
const CATEGORY_BADGES = {
  meals: "badge-secondary",
  inventory: "badge-accent",
  calendar: "badge-info",
  other: "badge-ghost"
};

// Generic dispatcher for nav/dispatch/ui actions
function dispatchAction(action) {
  if (!action) return;
  if (action.type === "nav") {
    if (action.to?.startsWith("http")) window.location.href = action.to;
    else window.location.hash = `#${action.to}`;
  } else if (action.type === "dispatch") {
    window.dispatchEvent(new CustomEvent(action.event || "suka.dispatch", { detail: action.payload || {} }));
  } else if (action.type === "ui") {
    window.dispatchEvent(new CustomEvent(action.event || "suka.ui", { detail: action.payload || {} }));
  } else if (action.type === "defer") {
    window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind: "info", message: "Scheduled to resume later." } }));
  }
}

// ---- Subcomponents ----------------------------------------------------------
function Breadcrumbs({ job, runId }) {
  return (
    <div className="text-sm breadcrumbs mb-2">
      <ul>
        <li><a href="#/dashboard">Dashboard</a></li>
        <li><a href="#/tasks/history">Task History</a></li>
        <li>{job?.label || job?.id || "Run"}</li>
        <li className="opacity-70">{runId?.slice(0, 18)}…</li>
      </ul>
    </div>
  );
}

function EmptyState({ title, description, actions = [] }) {
  return (
    <div className="card bg-base-100 border border-base-200 rounded-2xl shadow-sm">
      <div className="card-body items-center text-center">
        <h2 className="card-title">{title}</h2>
        <p className="opacity-70">{description}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((a, i) => (
            <button key={i} className="btn btn-primary btn-sm rounded-2xl" onClick={() => dispatchAction(a)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepRow({ idx, step, active }) {
  return (
    <div className={classNames(
      "grid grid-cols-[auto,1fr,auto] items-start gap-3 py-2 px-3 rounded-xl",
      active ? "bg-base-200" : "bg-transparent"
    )}>
      <div className={classNames("badge badge-ghost rounded-full", active && "badge-info")}>
        {idx + 1}
      </div>
      <div>
        <div className="font-medium">{step.label || step.id || `Step ${idx + 1}`}</div>
        <div className="text-xs opacity-70">
          {step.status || "done"} {step.at ? `· ${new Date(step.at).toLocaleString()}` : ""}
        </div>
      </div>
      <div className="text-xs opacity-70">{step.duration ? prettyMs(step.duration) : ""}</div>
    </div>
  );
}

function ContextPreview({ ctx }) {
  const summary = useMemo(() => summarizeCtx(ctx), [ctx]);
  if (!summary) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-semibold">Run Context</summary>
      <pre className="mt-2 bg-base-200 p-3 rounded-xl text-xs overflow-x-auto">{JSON.stringify(summary, null, 2)}</pre>
    </details>
  );
}

function summarizeCtx(ctx) {
  if (!ctx) return null;
  const keys = Object.keys(ctx);
  const out = {};
  for (const k of keys) {
    if (["plan", "pending", "events", "keys", "resolvedAt"].includes(k)) {
      const v = ctx[k];
      if (Array.isArray(v)) out[k] = `${v.length} item(s)`;
      else if (v && typeof v === "object") out[k] = Object.keys(v).slice(0, 5);
      else out[k] = v;
    }
  }
  return out;
}

// ---- Main Component ---------------------------------------------------------
export default function TaskRun({ jobRunId: propRunId }) {
  const urlRun = getQueryParam("run");
  const runId = propRunId || urlRun || (typeof window !== "undefined" ? window.location.hash.split("?run=")[1] : null);

  const [runtime, setRuntime] = useState(null);     // live engine runtime (if still in memory)
  const [snapshot, setSnapshot] = useState(null);   // frozen snapshot for finished runs
  const [job, setJob] = useState(null);
  const [jobMeta, setJobMeta] = useState({ label: "", category: "other", path: "/" });
  const [percent, setPercent] = useState(0);
  const [status, setStatus] = useState("running");
  const [startedAt, setStartedAt] = useState(null);
  const [finishedAt, setFinishedAt] = useState(null);
  const [steps, setSteps] = useState([]);
  const [undoEligible, setUndoEligible] = useState(false);
  const [nba, setNba] = useState(null);

  const mounted = useRef(false);

  // Load initial state from engine (if available)
  useEffect(() => {
    mounted.current = true;
    if (!Jobs || !runId) return;

    try {
      const rt = Jobs.getJobRuntimeState?.(runId);
      setRuntime(rt || null);

      if (rt) {
        const j = Jobs.getJob?.(rt.jobId) || {};
        setJob(j);
        setJobMeta({
          label: j.label || rt.jobId,
          category: j.category || "other",
          path: j.path || "/",
          description: j.description
        });
        setStatus(rt.status || "running");
        setStartedAt(rt.startedAt || new Date().toISOString());
        setSteps(rt.steps || []);
        setUndoEligible(!!(rt.history && rt.history.length));
        setPercent(calcPercent(rt));
      } else {
        // runtime not found — wait for success/fail event snapshot or show empty
      }
    } catch (e) {
      console.warn("[TaskRun] init error", e);
    }

    // Subscribe to engine events to live-update
    const offStart = Jobs.on?.("jobs.run.started", ({ jobRunId, jobId }) => {
      if (jobRunId !== runId) return;
      const j = Jobs.getJob?.(jobId) || {};
      setJob(j);
      setJobMeta({ label: j.label || jobId, category: j.category || "other", path: j.path || "/" });
      setStatus("running");
      setStartedAt(nowISO());
      setSteps([]);
      setUndoEligible(false);
      setPercent(0);
    });

    const offStep = Jobs.on?.("jobs.step.completed", ({ jobRunId, stepId, label }) => {
      if (jobRunId !== runId) return;
      setSteps((prev) => [...prev, { id: stepId, label, status: "done", at: nowISO() }]);
      setUndoEligible(true);
      const rt2 = Jobs.getJobRuntimeState?.(runId);
      setPercent(calcPercent(rt2));
    });

    const offProgress = Jobs.on?.("ui.progress", ({ jobRunId, at }) => {
      if (jobRunId !== runId) return;
      setPercent(Math.max(0, Math.min(100, Math.round(at * 100))));
    });

    const offSuccess = Jobs.on?.("jobs.run.succeeded", ({ jobRunId, jobId, ctx }) => {
      if (jobRunId !== runId) return;
      const j = Jobs.getJob?.(jobId) || {};
      setStatus("succeeded");
      setFinishedAt(nowISO());
      setPercent(100);
      setJob(j);
      setJobMeta((prev) => ({ ...prev, label: j.label || prev.label }));
      const snap = {
        jobRunId,
        jobId,
        label: j.label || jobId,
        category: j.category || "other",
        path: j.path || "/",
        startedAt,
        finishedAt: nowISO(),
        steps,
        ctx
      };
      setSnapshot(snap);
      const suggestion = Jobs.suggestNextBestAction?.(runId);
      if (suggestion) setNba(suggestion);
      window.dispatchEvent(new CustomEvent("ui.nba.suggest", { detail: suggestion }));
    });

    const offFail = Jobs.on?.("jobs.run.failed", ({ jobRunId, error }) => {
      if (jobRunId !== runId) return;
      setStatus("failed");
      setFinishedAt(nowISO());
      setPercent((p) => (p < 90 ? 90 : p)); // leave some progress but mark fail
      window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind: "error", message: `Task failed: ${error || "Unknown error"}` } }));
    });

    const offUndo = Jobs.on?.("jobs.undo.performed", ({ jobRunId }) => {
      if (jobRunId !== runId) return;
      setUndoEligible(false); // single-level undo by engine semantics
      setStatus("undone");
      setFinishedAt(nowISO());
      window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind: "warning", message: "Last step undone" } }));
    });

    // Domain glue (refresh badges/filters on relevant changes)
    const onDomain = (scope) => () => {
      window.dispatchEvent(new CustomEvent("ui.badges.refresh", { detail: { scope } }));
      window.dispatchEvent(new CustomEvent("ui.filters.refresh", { detail: { scope } }));
    };
    const offR = Jobs.on?.("recipe.consolidated", onDomain("meals"));
    const offI = Jobs.on?.("inventory.updated", onDomain("inventory"));
    const offC = Jobs.on?.("calendar.synced", onDomain("calendar"));
    const offP = Jobs.on?.("preferences.changed", onDomain("global"));

    return () => {
      mounted.current = false;
      offStart && offStart();
      offStep && offStep();
      offProgress && offProgress();
      offSuccess && offSuccess();
      offFail && offFail();
      offUndo && offUndo();
      offR && offR();
      offI && offI();
      offC && offC();
      offP && offP();
    };
  }, [runId]);

  // Derived UI
  const style = STATUS_STYLES[status] || STATUS_STYLES.running;
  const catBadge = CATEGORY_BADGES[(jobMeta.category || "other")] || "badge-ghost";
  const durationMs = useMemo(() => {
    if (!startedAt) return null;
    const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
    return end - new Date(startedAt).getTime();
  }, [startedAt, finishedAt]);

  // Actions
  const handleUndo = async () => {
    if (!Jobs?.undo) return;
    const res = await Jobs.undo(runId);
    if (!res?.ok) {
      window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind: "error", message: "Nothing to undo" } }));
    }
  };

  const handleNBA = () => {
    const suggestion = nba || Jobs?.suggestNextBestAction?.(runId);
    if (suggestion?.action) dispatchAction(suggestion.action);
  };

  const handleRerun = async () => {
    if (!Jobs?.getJob || !Jobs?.runJob || !runtime) return;
    const j = Jobs.getJob(runtime.jobId);
    if (!j) return;
    // Confirmation pattern
    const ok = window.confirm(`Re-run "${j.label || j.id}"?`);
    if (!ok) return;
    // Start a new run; engine will emit events and this page will follow if URL changes
    await Jobs.runJob(j.id, { ...runtime.ctx, rerunOf: runId });
    window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind: "info", message: "Started new run" } }));
  };

  const handleExport = () => {
    const data = {
      runId,
      job: jobMeta,
      status,
      startedAt,
      finishedAt,
      durationMs,
      percent,
      steps,
      snapshot
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${jobMeta.label || "task"}_${runId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Empty state when engine has no knowledge of this run
  if (!runId) {
    return (
      <div className="max-w-5xl mx-auto px-4">
        <EmptyState
          title="No run selected"
          description="Open a task from history or start a new job to view its run details."
          actions={[
            { label: "Open Task History", type: "nav", to: "/tasks/history" },
            { label: "Go to Dashboard", type: "nav", to: "/dashboard" }
          ]}
        />
      </div>
    );
  }

  // Loading skeleton while we wait for engine signals on first mount
  if (!runtime && !snapshot && status === "running") {
    return (
      <div className="max-w-5xl mx-auto px-4">
        <Breadcrumbs job={job} runId={runId} />
        <div className="card bg-base-100 rounded-2xl shadow-sm border border-base-200">
          <div className="card-body">
            <div className="animate-pulse h-6 w-48 bg-base-200 rounded-xl mb-2" />
            <div className="animate-pulse h-4 w-32 bg-base-200 rounded-xl mb-4" />
            <progress className="progress w-full" value="15" max="100" />
            <div className="mt-4 grid gap-2">
              {[...Array(4)].map((_, i) => <div key={i} className="animate-pulse h-10 bg-base-200 rounded-xl" />)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4">
      <Breadcrumbs job={job} runId={runId} />

      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold leading-tight">
            {jobMeta.label || "Task"}
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <span className={classNames("badge rounded-full", style.badge)}>{status}</span>
            <span className={classNames("badge rounded-full", catBadge)}>{jobMeta.category}</span>
            <span className="badge badge-outline rounded-full">{job?.id || runtime?.jobId || "—"}</span>
          </div>
          <div className="text-sm opacity-70 mt-1">
            {startedAt ? new Date(startedAt).toLocaleString() : ""} {finishedAt ? `· ${new Date(finishedAt).toLocaleString()}` : ""} {durationMs != null ? `· ${prettyMs(durationMs)}` : ""}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost btn-sm rounded-2xl" onClick={() => (window.location.hash = "#/tasks/history")}>
            History
          </button>
          <button className="btn btn-outline btn-sm rounded-2xl" onClick={handleExport}>
            Export JSON
          </button>
          <button className="btn btn-outline btn-sm rounded-2xl" onClick={handleRerun} disabled={!runtime?.jobId}>
            Re-run
          </button>
          <button className="btn btn-primary btn-sm rounded-2xl" onClick={() => (window.location.hash = "#/dashboard")}>
            Dashboard
          </button>
        </div>
      </div>

      {/* Description */}
      {jobMeta.description && (
        <p className="opacity-80 mb-3">{jobMeta.description}</p>
      )}

      {/* Progress */}
      <div className="card bg-base-100 rounded-2xl shadow-sm border border-base-200 mb-4">
        <div className="card-body">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Progress</div>
            <div className="text-sm opacity-70">{percent}%</div>
          </div>
          <progress className={classNames("progress w-full", style.bar)} value={percent} max="100" />
          <div className="mt-3 flex items-center gap-2">
            <button
              className="btn btn-ghost btn-sm rounded-2xl"
              onClick={handleUndo}
              disabled={!undoEligible || status !== "running"}
              title={undoEligible ? "Undo last step" : "Nothing to undo"}
            >
              Undo
            </button>

            {status === "succeeded" && (
              <button className="btn btn-primary btn-sm rounded-2xl" onClick={handleNBA}>
                Next Best Action
              </button>
            )}

            {status === "failed" && (
              <button className="btn btn-warning btn-sm rounded-2xl" onClick={handleRerun}>
                Retry
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Steps Timeline */}
      <div className="card bg-base-100 rounded-2xl shadow-sm border border-base-200">
        <div className="card-body">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Steps</div>
            <div className="text-sm opacity-70">{steps.length} completed</div>
          </div>
          <div className="mt-2 grid gap-1">
            {steps.length > 0 ? (
              steps.map((s, i) => <StepRow key={s.id || i} idx={i} step={s} active={i === steps.length - 1 && status === "running"} />)
            ) : (
              <div className="text-sm opacity-70">No steps recorded yet.</div>
            )}
          </div>

          <ContextPreview ctx={runtime?.ctx || snapshot?.ctx} />
        </div>
      </div>

      {/* Footer CTA row */}
      <div className="mt-6 flex items-center justify-between">
        <div className="text-sm opacity-70">
          Route: <span className="font-mono">{jobMeta.path}</span>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-outline btn-sm rounded-2xl" onClick={() => (window.location.hash = "#/tasks/history")}>
            Back to History
          </button>
          <button className="btn btn-primary btn-sm rounded-2xl" onClick={() => (window.location.hash = `#${jobMeta.path}`)}>
            Open Feature
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- helpers ----------------------------------------------------------------
function calcPercent(rt) {
  if (!rt || !rt.jobId) return 0;
  // If engine exposes stepIndex and total steps via job registry, approximate:
  const job = Jobs?.getJob?.(rt.jobId);
  const total = job?.steps?.length || 1;
  const idx = typeof rt.stepIndex === "number" ? rt.stepIndex : 0;
  const rough = Math.round(((idx) / total) * 100);
  // Clamp to 95%; final event will set 100%
  return Math.max(0, Math.min(95, rough));
}
