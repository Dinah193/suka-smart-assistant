// C:\Users\larho\suka-smart-assistant\src\pages\tasks\index.jsx
import React, { Suspense, useEffect, useMemo, useState } from "react";
import { HashRouter, useRoutes } from "react-router-dom";
import getTaskRoutes, { TaskLayout } from "./routes.jsx";

// Lazy views (for standalone landing fallback)
const TasksList = React.lazy(() => import("./views/TasksList.jsx"));

/**
 * Tasks — Entry Point
 * Suka Smart Assistant
 * --------------------------------------------------------------------
 * What this file provides:
 * 1) A plug-and-play router mount (TasksRouterMount) for React Router v6.
 * 2) A safe standalone landing (default export) that still works if routes
 *    aren’t mounted yet, with obvious CTAs to List/History/Settings.
 * 3) Global event-driven glue (Undo/NBA/Progress + domain refresh).
 *
 * Use one of these two patterns:
 * A) In your app router:
 *    import { TasksRouterMount } from "@/pages/tasks";
 *    // inside your top-level <Router/>:
 *    <TasksRouterMount base="/tasks" />
 *
 * B) As a standalone page (useful during development):
 *    import TasksLanding from "@/pages/tasks";
 *    export default function Page(){ return <TasksLanding /> }
 */

// ---------- Soft imports (no hard failure) ----------------------------------
let Jobs = null;
try {
  // eslint-disable-next-line import/no-unresolved
  Jobs = require("@/services/jobs/engine.js");
} catch (_) {
  Jobs = null;
}

// ---------- Global glue listeners (Undo/NBA/Progress) -----------------------
function useJobsGlue() {
  useEffect(() => {
    if (!Jobs?.on) return;

    const progressOff = Jobs.on("ui.progress", ({ jobId, at, message }) => {
      const pct = Math.round((at || 0) * 100);
      const prev = document.title;
      document.title = `${pct}% • ${message || jobId || "Working…"}`;
      const t = setTimeout(() => (document.title = prev), 1500);
      return () => clearTimeout(t);
    });

    const bridge = (kind, message) =>
      window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind, message } }));

    const nbaOff = Jobs.on("ui.nba.suggest", (detail) => {
      window.dispatchEvent(new CustomEvent("ui.nba.suggest", { detail }));
    });
    const successOff = Jobs.on("jobs.run.succeeded", ({ jobId }) => bridge("success", `${jobId} completed`));
    const failOff = Jobs.on("jobs.run.failed", ({ jobId, error }) => bridge("error", `${jobId} failed: ${error || "Unknown error"}`));
    const undoOff = Jobs.on("jobs.undo.performed", () => bridge("warning", "Last step undone"));

    // Domain glue → subtle UI refreshers
    const refresher = (scope) => () => {
      window.dispatchEvent(new CustomEvent("ui.badges.refresh", { detail: { scope } }));
      window.dispatchEvent(new CustomEvent("ui.filters.refresh", { detail: { scope } }));
    };
    const offR = Jobs.on?.("recipe.consolidated", refresher("meals"));
    const offI = Jobs.on?.("inventory.updated", refresher("inventory"));
    const offC = Jobs.on?.("calendar.synced", refresher("calendar"));
    const offP = Jobs.on?.("preferences.changed", refresher("global"));

    return () => {
      progressOff && progressOff();
      nbaOff && nbaOff();
      successOff && successOff();
      failOff && failOff();
      undoOff && undoOff();
      offR && offR();
      offI && offI();
      offC && offC();
      offP && offP();
    };
  }, []);
}

// ---------- Router Mount (preferred integration) ----------------------------
export function TasksRouterMount({ base = "/tasks" }) {
  useJobsGlue();
  const routes = useMemo(() => getTaskRoutes(base), [base]);
  const element = useRoutes(routes);
  return element;
}

// ---------- Standalone landing (fallback) -----------------------------------
export default function TasksLanding() {
  useJobsGlue();

  // If the app does NOT have a Router, we still render a working experience
  // using a minimal HashRouter that mounts the task routes at #/tasks.
  // This is especially handy while developing the module in isolation.
  return (
    <HashRouter>
      <StandaloneShell />
    </HashRouter>
  );
}

function StandaloneShell() {
  const base = "/tasks";
  const routes = useMemo(() => getTaskRoutes(base), []);
  const element = useRoutes(routes);

  // If the hash doesn't start with /tasks, show a welcoming, CTA-friendly
  // landing that uses the same consistent layout and design tokens.
  const needsLanding =
    typeof window !== "undefined" &&
    window.location.hash &&
    !window.location.hash.replace(/^#/, "").startsWith(base);

  if (needsLanding) {
    return (
      <TaskLayout base={base} route={<LandingBody />} />
    );
  }
  return element;
}

function LandingBody() {
  return (
    <div className="w-full">
      <div className="card bg-base-100 border border-base-200 rounded-2xl shadow-sm">
        <div className="card-body">
          <h2 className="card-title">Welcome to Tasks</h2>
          <p className="opacity-80">
            Launch step-by-step jobs with clear progress, Undo instead of confirmations, and a single “Next Best Action” after success.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="#/tasks" className="btn btn-primary btn-sm rounded-2xl">Open Tasks List</a>
            <a href="#/tasks/history" className="btn btn-outline btn-sm rounded-2xl">View History</a>
            <a href="#/tasks/settings" className="btn btn-outline btn-sm rounded-2xl">Settings</a>
            <a href="#/dashboard" className="btn btn-ghost btn-sm rounded-2xl">Back to Dashboard</a>
          </div>
        </div>
      </div>

      <div className="h-4" />

      {/* Helpful preview of the List view (still lazy-loaded) */}
      <div className="card bg-base-100 border border-base-200 rounded-2xl shadow-sm">
        <div className="card-body">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Quick preview</div>
            <a className="btn btn-ghost btn-xs rounded-2xl" href="#/tasks">Open</a>
          </div>
          <div className="mt-3">
            <Suspense
              fallback={
                <div className="grid gap-3">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="animate-pulse h-24 bg-base-200 rounded-2xl" />
                  ))}
                </div>
              }
            >
              <TasksList />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
