// C:\Users\larho\suka-smart-assistant\src\pages\tasks\routes.jsx
import React, { Suspense, useEffect, useMemo, useState, useCallback } from "react";
import { Navigate } from "react-router-dom";

/**
 * Tasks Router — Suka Smart Assistant
 * --------------------------------------------------------------------
 * What this provides:
 * 1) Clear IA: /tasks with List, History, Run, Settings routes.
 * 2) Intuitive flows: Progress chips, Undo-first UX, single Next Best Action.
 * 3) Consistency: shared tokens, card patterns, loading/empty states.
 * 4) Event glue: listens to recipe.consolidated, inventory.updated,
 *    calendar.synced, preferences.changed, garden.*, animal.* and nudges UI.
 * 5) Glue to Jobs engine: progress → title, NBA & Undo bridged to global UI.
 *
 * Exports:
 *  - getTaskRoutes(base = "/tasks")
 *  - TaskLayout (shared layout for nested routes)
 */

// ---------- Soft imports (no hard failure if a service is missing) ----------
let Jobs = null;
try { Jobs = require("@/services/jobs/engine.js"); } catch (_) { Jobs = null; }

let Events = null;
try { Events = require("@/services/automation/events"); } catch (_) { Events = null; }

let getTIP = null;
try { ({ getTIP } = require("@/services/integration/torahProfileHooks.js")); } catch (_) { getTIP = null; }

// ---------- Lazy-loaded views (code-splitting) ------------------------------
const TasksList    = React.lazy(() => import("./views/TasksList.jsx"));
const TaskHistory  = React.lazy(() => import("./views/TaskHistory.jsx"));
const TaskRun      = React.lazy(() => import("./views/TaskRun.jsx"));
const TaskSettings = React.lazy(() => import("./views/TaskSettings.jsx"));

// ---------- Design tokens / small UI helpers --------------------------------
const TOKENS = {
  card: {
    base: "card bg-base-100 border border-base-200 rounded-2xl shadow-sm",
    body: "card-body",
    title: "card-title",
    meta:  "opacity-70 text-sm",
  },
  btn: {
    primary: "btn btn-primary btn-sm rounded-2xl",
    ghost:   "btn btn-ghost btn-sm rounded-2xl",
    outline: "btn btn-outline btn-sm rounded-2xl",
    xsGhost: "btn btn-ghost btn-xs rounded-2xl",
  },
  chip: {
    ok:   "badge badge-success rounded-full",
    warn: "badge badge-warning rounded-full",
    info: "badge badge-info rounded-full",
    idle: "badge badge-ghost rounded-full",
  },
  skeleton: "animate-pulse h-28 bg-base-200 rounded-2xl",
};

function classNames(...xs) { return xs.filter(Boolean).join(" "); }

function NavTab({ to, label, active }) {
  return (
    <a href={`#${to}`} className={classNames(TOKENS.btn.ghost, active && "btn-active")}>
      {label}
    </a>
  );
}

function SkeletonList({ rows = 3 }) {
  return (
    <div className="grid gap-3">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className={TOKENS.skeleton} />)}
    </div>
  );
}

function EmptyCard({ title = "Nothing here yet", subtitle = "Try a quick action below.", actions = [] }) {
  return (
    <div className={TOKENS.card.base}>
      <div className={TOKENS.card.body}>
        <h2 className={TOKENS.card.title}>{title}</h2>
        <p className={TOKENS.card.meta}>{subtitle}</p>
        {actions?.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {actions.map((a, i) => (
              <a key={i} href={a.href || "#"} onClick={a.onClick} className={TOKENS.btn.primary}>
                {a.label}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------- Torah profile banner --------------------------------------------
function useTipInfo() {
  const [tip, setTip] = useState(null);
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!getTIP) return setTip(null);
      try {
        const info = await getTIP();
        if (mounted) setTip(info || null);
      } catch { if (mounted) setTip(null); }
    })();
    return () => { mounted = false; };
  }, []);
  return tip;
}

// ---------- Global glue listeners (Progress / Undo / NBA / Domains) ---------
function useJobsGlue() {
  useEffect(() => {
    // Prefer central event bus if available
    const on = Jobs?.on || Events?.on;
    const offFns = [];

    // Progress → subtle document title feedback
    if (on) {
      offFns.push(on("ui.progress", ({ at = 0, message = "Working…" }) => {
        const pct = Math.max(0, Math.min(100, Math.round(at * 100)));
        const prev = document.title;
        document.title = `${pct}% • ${message}`;
        const t = setTimeout(() => (document.title = prev), 1400);
        offFns.push(() => clearTimeout(t));
      }));
    }

    // Bridge Undo offers and NBA to window events (so any shell UI can listen)
    const bridge = (topic, detail) =>
      window.dispatchEvent(new CustomEvent(topic, { detail }));

    if (on) {
      offFns.push(on("ui.nba.suggest",  (detail)      => bridge("ui.nba.suggest", detail)));
      offFns.push(on("ui.undo.offer",   (detail)      => bridge("ui.undo.offer", detail)));
      offFns.push(on("jobs.run.succeeded", ({ jobId }) =>
        bridge("ui.toast", { kind: "success", message: `${jobId} completed` })));
      offFns.push(on("jobs.run.failed",    ({ jobId, error }) =>
        bridge("ui.toast", { kind: "error", message: `${jobId} failed: ${error || "Unknown error"}` })));
      offFns.push(on("jobs.undo.performed", () =>
        bridge("ui.toast", { kind: "warning", message: "Last step undone" })));
    }

    // Domain-level glue (Meals/Inventory/Calendar/Prefs/Garden/Animal)
    const refresh = (scope, reason) => {
      bridge("ui.badges.refresh",  { scope, reason });
      bridge("ui.filters.refresh", { scope, reason });
      bridge("ui.lists.refresh",   { scope, reason });
    };

    const wire = (evt, scope) =>
      on ? on(evt, (detail) => refresh(scope, evt)) : null;

    const offs = [
      wire("recipe.consolidated", "meals"),
      wire("inventory.updated",   "inventory"),
      wire("calendar.synced",     "calendar"),
      wire("preferences.changed", "global"),
      // Garden + Animal categories (from your agents list)
      wire("garden.harvested",    "garden"),
      wire("garden.planted",      "garden"),
      wire("garden.health.updated", "garden"),
      wire("animal.health.updated", "animals"),
      wire("animal.inventory.updated", "animals"),
      wire("animal.breeding.updated", "animals"),
    ].filter(Boolean);

    offFns.push(...offs);

    return () => offFns.forEach((f) => typeof f === "function" && f());
  }, []);
}

// ---------- Undo/NBA Dock (lightweight, optional) ----------------------------
function useUndoNbaDock() {
  const [offer, setOffer] = useState(null);
  const [nba, setNba] = useState(null);

  useEffect(() => {
    const onOffer = (e) => setOffer(e.detail || null);
    const onNba   = (e) => setNba(e.detail || null);
    window.addEventListener("ui.undo.offer", onOffer);
    window.addEventListener("ui.nba.suggest", onNba);
    return () => {
      window.removeEventListener("ui.undo.offer", onOffer);
      window.removeEventListener("ui.nba.suggest", onNba);
    };
  }, []);

  const clearOffer = useCallback(() => setOffer(null), []);
  const clearNba = useCallback(() => setNba(null), []);

  return { offer, nba, clearOffer, clearNba };
}

function UndoNbaDock({ offer, nba, clearOffer, clearNba }) {
  if (!offer && !nba) return null;
  return (
    <div className="fixed bottom-3 left-0 right-0 mx-auto max-w-5xl px-4 z-40">
      <div className="flex flex-col md:flex-row gap-2 justify-center">
        {offer && (
          <div className={TOKENS.card.base}>
            <div className={`${TOKENS.card.body} py-3`}>
              <div className="flex items-center justify-between">
                <div>
                  <span className={classNames(TOKENS.chip.warn, "mr-2")}>Undo</span>
                  <span className="text-sm opacity-80">{offer.label || "Revert last step?"}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    className={TOKENS.btn.outline}
                    onClick={() => {
                      try { Jobs?.emit?.("jobs.undo.perform", { token: offer.token }); } catch {}
                      clearOffer();
                    }}
                  >
                    Undo
                  </button>
                  <button className={TOKENS.btn.ghost} onClick={clearOffer}>Dismiss</button>
                </div>
              </div>
            </div>
          </div>
        )}
        {nba && (
          <div className={TOKENS.card.base}>
            <div className={`${TOKENS.card.body} py-3`}>
              <div className="flex items-center justify-between">
                <div>
                  <span className={classNames(TOKENS.chip.info, "mr-2")}>Next</span>
                  <span className="text-sm opacity-80">{nba.label}</span>
                </div>
                <div>
                  <a href={nba.href || "#"} className={TOKENS.btn.primary} onClick={nba.onClick}>
                    {nba.cta || "Do it"}
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Layout -----------------------------------------------------------
export function TaskLayout({ base = "/tasks", route = "" }) {
  // Determine active tab from current hash (HashRouter-friendly)
  const [hash, setHash] = useState(
    typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : ""
  );

  useEffect(() => {
    const onHash = () => setHash(window.location.hash.replace(/^#/, ""));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const active = useMemo(() => {
    if (hash.startsWith(`${base}/history`))  return "history";
    if (hash.startsWith(`${base}/run`))      return "run";
    if (hash.startsWith(`${base}/settings`)) return "settings";
    return "list";
  }, [hash, base]);

  const tip = useTipInfo();
  useJobsGlue();
  const dock = useUndoNbaDock();

  const sabbathOn = !!tip?.sabbath?.guardActions;

  return (
    <div className="w-full max-w-7xl mx-auto px-4 md:px-0">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2 mt-2 mb-3">
        <div>
          <div className="text-sm breadcrumbs mb-1">
            <ul>
              <li><a href="#/dashboard">Dashboard</a></li>
              <li>Tasks</li>
              <li className="opacity-70 capitalize">{active}</li>
            </ul>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold">Tasks</h1>
          <p className="opacity-70">
            Run step-by-step jobs across Meals, Inventory, Garden, Animals, and Calendar.
            Undo instead of confirmations, with a single “Next Best Action” after each success.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="#/tasks/settings" className={TOKENS.btn.outline}>Settings</a>
          <a href="#/tasks/history"  className={TOKENS.btn.outline}>History</a>
          <a href="#/dashboard"       className={TOKENS.btn.primary}>Dashboard</a>
        </div>
      </div>

      {/* Sabbath banner (if enabled in Torah profile) */}
      <div className="mb-3">
        <div
          className={classNames(
            "rounded-2xl border px-4 py-3 text-sm",
            sabbathOn ? "border-info/30 bg-info/10" : "border-base-200 bg-base-100"
          )}
        >
          <div className="flex items-center justify-between">
            <div>
              <span className={classNames("badge rounded-full mr-2", sabbathOn ? "badge-info" : "badge-ghost")}>
                {sabbathOn ? "Sabbath Guard: ON" : "Sabbath Guard: OFF"}
              </span>
              <span className="opacity-80">
                {sabbathOn
                  ? "Some actions may be paused during Sabbath unless explicitly overridden."
                  : "Enable Sabbath guard in Task Settings if desired."}
              </span>
            </div>
            <a href="#/tasks/settings" className={TOKENS.btn.xsGhost}>Adjust</a>
          </div>
        </div>
      </div>

      {/* Section Nav */}
      <div className="flex items-center gap-2 mb-4">
        <NavTab to={`${base}`}           label="List"     active={active === "list"} />
        <NavTab to={`${base}/history`}   label="History"  active={active === "history"} />
        <NavTab to={`${base}/run`}       label="Run"      active={active === "run"} />
        <NavTab to={`${base}/settings`}  label="Settings" active={active === "settings"} />
      </div>

      {/* Content (children rendered by router) */}
      <div className="min-h-[320px]">
        <Suspense fallback={<SkeletonList rows={3} />}>
          {route || <EmptyCard
            title="No task selected"
            subtitle="Choose a task from the list or start a new run."
            actions={[
              { label: "Open Run", href: "#/tasks/run" },
              { label: "View History", href: "#/tasks/history" },
            ]}
          />}
        </Suspense>
      </div>

      {/* Undo / NBA Dock */}
      <UndoNbaDock {...dock} />
    </div>
  );
}

// ---------- Error Boundary-lite wrapper -------------------------------------
function ErrorBoundary({ children }) {
  const [err, setErr] = useState(null);
  if (err) {
    return (
      <div className={TOKENS.card.base}>
        <div className={TOKENS.card.body}>
          <h2 className={TOKENS.card.title}>Something went wrong</h2>
          <p className={TOKENS.card.meta}>{String(err)}</p>
          <div className="mt-3">
            <button className={TOKENS.btn.primary} onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <React.Suspense fallback={<div className={TOKENS.skeleton} />}>
      <ErrorCatcher onError={setErr}>{children}</ErrorCatcher>
    </React.Suspense>
  );
}
function ErrorCatcher({ onError, children }) {
  try { return <>{children}</>; } catch (e) { onError(e); return null; }
}

// ---------- Route factory ----------------------------------------------------
/**
 * getTaskRoutes(base) -> [{ path, element, children: [...] }]
 * - Designed for React Router v6 route arrays
 * - Uses TaskLayout as the shared wrapper for all nested pages
 */
export function getTaskRoutes(base = "/tasks") {
  const LayoutRoute = ({ element }) => <TaskLayout base={base} route={element} />;

  return [
    {
      path: base,
      element: (
        <LayoutRoute
          element={
            <ErrorBoundary>
              <TasksList />
            </ErrorBoundary>
          }
        />
      ),
    },
    {
      path: `${base}/history`,
      element: (
        <LayoutRoute
          element={
            <ErrorBoundary>
              <TaskHistory />
            </ErrorBoundary>
          }
        />
      ),
    },
    {
      path: `${base}/run`,
      element: (
        <LayoutRoute
          element={
            <ErrorBoundary>
              <TaskRun />
            </ErrorBoundary>
          }
        />
      ),
    },
    {
      path: `${base}/settings`,
      element: (
        <LayoutRoute
          element={
            <ErrorBoundary>
              <TaskSettings />
            </ErrorBoundary>
          }
        />
      ),
    },
    // Helpful redirect: /tasks/* -> /tasks
    { path: `${base}/*`, element: <Navigate to={base} replace /> },
  ];
}

export default getTaskRoutes;
