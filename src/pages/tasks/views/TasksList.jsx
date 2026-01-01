// C:\Users\larho\suka-smart-assistant\src\pages\tasks\views\TasksList.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * TasksList.jsx
 * Suka Smart Assistant — Jobs Catalog (Tasks List)
 * --------------------------------------------------------------------
 * Goals
 * 1) Clear IA: organized list of jobs by category with quick filters,
 *    search, and deep links to feature routes.
 * 2) Intuitive flows: each job card shows purpose, primary CTA (Run),
 *    secondary (Open Feature), and a compact step overview.
 * 3) Consistent design: DaisyUI/Tailwind cards, buttons, states, toasts.
 * 4) Event-driven glue: listens to recipe.consolidated, inventory.updated,
 *    calendar.synced, preferences.changed; updates badges and last-run info.
 * 5) UX patterns: empty/loading states, Undo after run (if available),
 *    and a single “Next Best Action” suggestion after success.
 */

// --------- Soft imports (fail gracefully) -----------------------------------
let Jobs = null;
try {
  // eslint-disable-next-line import/no-unresolved
  Jobs = require("@/services/jobs/engine.js");
} catch (_) {
  Jobs = null;
}

// ---------- Local storage helpers -------------------------------------------
const LS_FAVS = "suka.tasks.favorites";
const LS_LAST = "suka.tasks.lastRunMeta"; // map jobId -> { runId, status, at }

function readLS(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function writeLS(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// ---------- UI utils ---------------------------------------------------------
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
const STATUS_BADGE = {
  running: "badge-info",
  succeeded: "badge-success",
  failed: "badge-error",
  undone: "badge-warning",
};
const CATEGORY_LABELS = {
  meals: "Meals",
  inventory: "Inventory",
  calendar: "Calendar",
  other: "Other",
};

// ---------- Toast + NBA bridges ---------------------------------------------
function toast(kind, message) {
  window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind, message } }));
}

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

// ---------- Subcomponents ----------------------------------------------------
function FiltersBar({ q, setQ, category, setCategory, favoritesOnly, setFavoritesOnly, onReset }) {
  return (
    <div className="card bg-base-100 shadow-sm mb-4 rounded-2xl">
      <div className="card-body gap-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="form-control">
            <div className="label"><span className="label-text">Search tasks</span></div>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a job by name or description…"
              className="input input-bordered rounded-2xl"
            />
          </label>
          <label className="form-control">
            <div className="label"><span className="label-text">Category</span></div>
            <select
              className="select select-bordered rounded-2xl"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="all">All</option>
              <option value="meals">Meals</option>
              <option value="inventory">Inventory</option>
              <option value="calendar">Calendar</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="form-control">
            <div className="label"><span className="label-text">Favorites</span></div>
            <input
              type="checkbox"
              className="toggle"
              checked={favoritesOnly}
              onChange={(e) => setFavoritesOnly(e.target.checked)}
            />
          </label>
          <div className="flex items-end">
            <button className="btn btn-ghost rounded-2xl" onClick={onReset}>Reset</button>
          </div>
        </div>
        <div className="text-sm opacity-70">
          Tip: Click the star to favorite a task. Use “Run” for a guided flow, or “Open Feature” to jump to its page.
        </div>
      </div>
    </div>
  );
}

function EmptyState({ title, description, actions = [] }) {
  return (
    <div className="w-full p-10 text-center">
      <div className="text-2xl font-semibold mb-2">{title}</div>
      <p className="text-base-content/70 max-w-xl mx-auto mb-6">{description}</p>
      <div className="flex flex-wrap gap-2 justify-center">
        {actions.map((a, i) => (
          <button key={i} className="btn btn-primary btn-sm rounded-2xl" onClick={() => dispatchAction(a)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StepDots({ count }) {
  const c = Math.min(6, Math.max(1, count || 1));
  return (
    <div className="flex gap-1">
      {[...Array(c)].map((_, i) => (
        <span key={i} className="w-2 h-2 rounded-full bg-base-300 inline-block" />
      ))}
    </div>
  );
}

function LastRunMeta({ meta }) {
  if (!meta) return <span className="text-xs opacity-60">No runs yet</span>;
  const badge = STATUS_BADGE[meta.status] || "badge-ghost";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={classNames("badge rounded-full", badge)}>{meta.status}</span>
      <span className="opacity-70">{new Date(meta.at).toLocaleString()}</span>
    </div>
  );
}

function JobCard({ job, fav, toggleFav, onRun, onOpen, lastMeta, runningFor }) {
  const isRunning = runningFor === job.id;
  return (
    <div className="card bg-base-100 border border-base-200 rounded-2xl shadow-sm">
      <div className="card-body">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold">{job.label || job.id}</h3>
              <button
                className={classNames("btn btn-ghost btn-xs px-2 rounded-full", fav && "text-warning")}
                title={fav ? "Unfavorite" : "Favorite"}
                onClick={() => toggleFav(job.id)}
              >
                ★
              </button>
            </div>
            <div className="text-sm opacity-70">{job.description || "No description provided."}</div>
          </div>
          <div className="text-right">
            <LastRunMeta meta={lastMeta} />
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="badge badge-outline rounded-full">{job.category || "other"}</span>
            <StepDots count={job.steps?.length} />
          </div>
          <div className="join">
            <button
              className="btn btn-outline btn-sm join-item rounded-l-2xl"
              onClick={() => onOpen(job)}
              title="Open feature page"
            >
              Open Feature
            </button>
            <button
              className={classNames("btn btn-primary btn-sm join-item rounded-r-2xl", isRunning && "btn-disabled")}
              onClick={() => onRun(job)}
            >
              {isRunning ? "Running…" : "Run"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Main Component ---------------------------------------------------
export default function TasksList() {
  const [allJobs, setAllJobs] = useState([]);
  const [favorites, setFavorites] = useState(() => new Set(readLS(LS_FAVS, [])));
  const [lastRuns, setLastRuns] = useState(() => readLS(LS_LAST, {}));
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [runningFor, setRunningFor] = useState(null);
  const mountedRef = useRef(false);

  // Initialize job list from registry
  useEffect(() => {
    mountedRef.current = true;
    const list = Jobs ? collectJobs() : [];
    setAllJobs(list);

    // subscribe to future registrations (hot reload / dynamic modules)
    const offReg = Jobs?.on?.("jobs.registered", () => setAllJobs(collectJobs()));

    // listen engine events to update last-run meta + NBA
    const offStart = Jobs?.on?.("jobs.run.started", ({ jobRunId, jobId }) => {
      setRunningFor(jobId);
      bumpLastRun(jobId, { runId: jobRunId, status: "running", at: Date.now() });
    });
    const offSuccess = Jobs?.on?.("jobs.run.succeeded", ({ jobRunId, jobId }) => {
      setRunningFor((cur) => (cur === jobId ? null : cur));
      bumpLastRun(jobId, { runId: jobRunId, status: "succeeded", at: Date.now() });
      // NBA suggestion
      const nba = Jobs?.suggestNextBestAction?.(jobRunId);
      if (nba?.action) {
        window.dispatchEvent(new CustomEvent("ui.nba.suggest", { detail: nba }));
        toast("success", `${getJobLabel(jobId)} completed`);
      }
    });
    const offFail = Jobs?.on?.("jobs.run.failed", ({ jobRunId, jobId }) => {
      setRunningFor((cur) => (cur === jobId ? null : cur));
      bumpLastRun(jobId, { runId: jobRunId, status: "failed", at: Date.now() });
      toast("error", `${getJobLabel(jobId)} failed`);
    });
    const offUndo = Jobs?.on?.("jobs.undo.performed", ({ jobRunId }) => {
      // find jobId from lastRuns (best effort)
      const entry = Object.entries(readLS(LS_LAST, {})).find(([, v]) => v.runId === jobRunId);
      if (entry) {
        const [jobId, meta] = entry;
        bumpLastRun(jobId, { ...meta, status: "undone", at: Date.now() });
        toast("warning", "Last step undone");
      }
    });

    // domain glue → refresh badges/filters subtly
    const onDomain = (scope) => () => {
      window.dispatchEvent(new CustomEvent("ui.badges.refresh", { detail: { scope } }));
      window.dispatchEvent(new CustomEvent("ui.filters.refresh", { detail: { scope } }));
    };
    const offR = Jobs?.on?.("recipe.consolidated", onDomain("meals"));
    const offI = Jobs?.on?.("inventory.updated", onDomain("inventory"));
    const offC = Jobs?.on?.("calendar.synced", onDomain("calendar"));
    const offP = Jobs?.on?.("preferences.changed", onDomain("global"));

    return () => {
      mountedRef.current = false;
      offReg && offReg();
      offStart && offStart();
      offSuccess && offSuccess();
      offFail && offFail();
      offUndo && offUndo();
      offR && offR();
      offI && offI();
      offC && offC();
      offP && offP();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep lastRuns persisted
  useEffect(() => writeLS(LS_LAST, lastRuns), [lastRuns]);
  // Keep favorites persisted
  useEffect(() => writeLS(LS_FAVS, Array.from(favorites)), [favorites]);

  // Search/filter
  const filtered = useMemo(() => {
    const qn = q.trim().toLowerCase();
    return allJobs.filter((j) => {
      if (category !== "all" && (j.category || "other") !== category) return false;
      if (favoritesOnly && !favorites.has(j.id)) return false;
      if (!qn) return true;
      const hay = `${j.id} ${j.label} ${j.description} ${j.category}`.toLowerCase();
      return hay.includes(qn);
    });
  }, [allJobs, q, category, favoritesOnly, favorites]);

  // Group by category for clear IA
  const grouped = useMemo(() => {
    const map = new Map();
    for (const j of filtered) {
      const cat = j.category || "other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(j);
    }
    // sort inside group by label
    for (const arr of map.values()) arr.sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id));
    return map;
  }, [filtered]);

  function collectJobs() {
    if (!Jobs?.getJobsByCategory) return [];
    // collect known categories + anything else
    const cats = ["meals", "inventory", "calendar", "other"];
    const list = [];
    for (const c of cats) list.push(...(Jobs.getJobsByCategory(c) || []));
    // ensure dedupe
    const seen = new Set();
    return list.filter((j) => (!seen.has(j.id) && seen.add(j.id)));
  }

  function bumpLastRun(jobId, meta) {
    setLastRuns((prev) => ({ ...prev, [jobId]: meta }));
  }

  function getJobLabel(jobId) {
    const j = allJobs.find((x) => x.id === jobId);
    return j?.label || jobId;
  }

  // Handlers
  const toggleFav = (jobId) => {
    setFavorites((prev) => {
      const copy = new Set(prev);
      if (copy.has(jobId)) copy.delete(jobId);
      else copy.add(jobId);
      return copy;
    });
  };

  const handleRun = async (job) => {
    if (!Jobs?.runJob) return;
    // Prefer Undo pattern; if job requires confirm for dangerous actions, you may ask:
    // (We keep friction low and rely on per-step undo from engine)
    setRunningFor(job.id);
    const res = await Jobs.runJob(job.id, { allowSabbathOverride: false });
    if (!res?.ok) {
      setRunningFor((cur) => (cur === job.id ? null : cur));
      // If a guard blocked the action, surface recommendation
      if (res.guard?.recommend?.action) window.dispatchEvent(new CustomEvent("ui.nba.suggest", { detail: res.guard }));
      toast("warning", res.guard?.reason || "Task did not start");
    } else {
      // run started; follow events for success/failed
      window.location.hash = `#/tasks/run?run=${res.jobRunId}`;
    }
  };

  const handleOpen = (job) => {
    const to = job.path || "/dashboard";
    window.location.hash = `#${to}`;
  };

  const handleReset = () => {
    setQ(""); setCategory("all"); setFavoritesOnly(false);
  };

  // Loading state if engine missing
  if (!Jobs) {
    return (
      <div className="max-w-6xl mx-auto px-4">
        <div className="mb-4">
          <h1 className="text-2xl md:text-3xl font-bold">Tasks</h1>
          <p className="opacity-70">Jobs engine not available. Ensure <code className="kbd kbd-sm">src/services/jobs/engine.js</code> is loaded.</p>
        </div>
        <div className="grid gap-3">
          {[...Array(3)].map((_, i) => <div key={i} className="animate-pulse h-28 bg-base-200 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-0">
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-2xl md:text-3xl font-bold">Tasks</h1>
        <p className="opacity-70">
          Launch step-by-step jobs for Meals, Inventory, and Calendar. Each job offers Undo and a Next Best Action upon success.
        </p>
      </div>

      {/* Filters */}
      <FiltersBar
        q={q} setQ={setQ}
        category={category} setCategory={setCategory}
        favoritesOnly={favoritesOnly} setFavoritesOnly={setFavoritesOnly}
        onReset={handleReset}
      />

      {/* Loading skeleton on very first mount */}
      {allJobs.length === 0 && (
        <div className="grid gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="animate-pulse h-28 bg-base-200 rounded-2xl" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {allJobs.length > 0 && filtered.length === 0 && (
        <EmptyState
          title="No tasks match your filters"
          description="Try clearing filters, or open a feature to add data that enables jobs."
          actions={[
            { label: "Clear Filters", type: "ui", event: "ui.filters.clear" },
            { label: "Open Meal Planner", type: "nav", to: "/tier2/household/meals/plan" },
            { label: "Reconcile Inventory", type: "nav", to: "/tier2/household/inventory/reconcile" },
          ]}
        />
      )}

      {/* Grouped lists */}
      {grouped.size > 0 && (
        <div className="grid gap-6">
          {[...grouped.keys()].sort().map((cat) => (
            <section key={cat}>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-semibold">{CATEGORY_LABELS[cat] || cat}</h2>
                <div className="text-xs opacity-70">{grouped.get(cat).length} job(s)</div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {grouped.get(cat).map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    fav={favorites.has(job.id)}
                    toggleFav={toggleFav}
                    onRun={handleRun}
                    onOpen={handleOpen}
                    lastMeta={lastRuns[job.id]}
                    runningFor={runningFor}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="h-8" />

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2">
        <button
          className="btn btn-outline btn-sm rounded-2xl"
          onClick={() => (window.location.hash = "#/tasks/history")}
        >
          View Task History
        </button>
        <button
          className="btn btn-primary btn-sm rounded-2xl"
          onClick={() => (window.location.hash = "#/tasks/settings")}
        >
          Task Settings
        </button>
      </div>
    </div>
  );
}
