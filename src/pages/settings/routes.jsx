// C:\Users\larho\suka-smart-assistant\src\pages\settings\routes.jsx
import React, { Suspense, useEffect, useMemo, useState } from "react";
import { Navigate, NavLink as RRNavLink, useLocation } from "react-router-dom";

/**
 * Settings Routes
 * Suka Smart Assistant — Unified configuration center
 * -------------------------------------------------------------------
 * What this provides:
 * 1) Clear IA: /settings with child routes (profile, food, garden, etc.)
 * 2) Consistent UI: cards, toasts, undo/NBA, responsive design
 * 3) Event glue: listens to key domain events and signals refresh
 * 4) Easy extensibility: add a view file and one route below
 *
 * Exports:
 *   - getSettingsRoutes(base = "/settings")
 *   - SettingsLayout (shared layout across sections)
 */

// --------------------- lazy imports ---------------------
const ProfileSettingsPage = React.lazy(() => import("./ProfileSettingsPage.jsx"));
const FoodSettingsPage = React.lazy(() => import("./views/FoodSettingsPage.jsx"));
const GardenSettingsPage = React.lazy(() => import("./views/GardenSettingsPage.jsx"));
const AnimalSettingsPage = React.lazy(() => import("./views/AnimalSettingsPage.jsx"));
const CleaningSettingsPage = React.lazy(() => import("./views/CleaningSettingsPage.jsx"));
const CalendarSettingsPage = React.lazy(() => import("./views/CalendarSettingsPage.jsx"));
const AutomationSettingsPage = React.lazy(() => import("./views/AutomationSettingsPage.jsx"));
const MealPlanningSettingsPage = React.lazy(() => import("./views/MealPlanningSettingsPage.jsx"));
const AdvancedSettingsPage = React.lazy(() => import("./views/AdvancedSettingsPage.jsx"));

// --------------------- soft imports ---------------------
let Jobs = null;
try { Jobs = require("@/services/jobs/engine"); }
catch { Jobs = { on: () => () => {}, emit: () => {} }; }

let Profile = null;
try { Profile = require("@/services/profile/householdProfileService"); }
catch { Profile = { subscribe: () => () => {}, getProfile: async () => ({}), setAtPath: () => {} }; }

// --------------------- helpers --------------------------
const cx = (...xs) => xs.filter(Boolean).join(" ");

function TabLink({ to, children }) {
  return (
    <RRNavLink
      to={to}
      className={({ isActive }) =>
        cx(
          "btn btn-ghost btn-sm rounded-2xl capitalize transition-all",
          isActive && "btn-active bg-base-200"
        )
      }
      end
    >
      {children}
    </RRNavLink>
  );
}

// --------------------- Global Glue ----------------------
function useGlobalGlue() {
  useEffect(() => {
    const toast = (kind, message) =>
      window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind, message } }));

    const offProgress = Jobs.on?.("ui.progress", ({ message, at }) => {
      const pct = Math.round((at || 0) * 100);
      const prev = document.title;
      document.title = `${pct}% • ${message || "Updating…"}`;
      const t = setTimeout(() => (document.title = prev), 1500);
      return () => clearTimeout(t);
    });

    const offUndo = Jobs.on?.("jobs.undo.performed", () => toast("warning", "Last change undone"));
    const offSuccess = Jobs.on?.("jobs.run.succeeded", ({ jobId }) => toast("success", `${jobId} completed`));

    // Domain events → bubble a generic refresh signal
    const evNames = [
      "preferences.changed",
      "recipe.consolidated",
      "inventory.updated",
      "calendar.synced",
      "garden.updated",
      "animal.updated",
    ];
    const handlers = evNames.map((name) => {
      const fn = () =>
        window.dispatchEvent(new CustomEvent("ui.refresh", { detail: { scope: name } }));
      window.addEventListener(name, fn);
      return { name, fn };
    });

    return () => {
      offProgress && offProgress();
      offUndo && offUndo();
      offSuccess && offSuccess();
      handlers.forEach(({ name, fn }) => window.removeEventListener(name, fn));
    };
  }, []);
}

// --------------------- Layout ----------------------------
export function SettingsLayout({ base = "/settings", route = null }) {
  const { pathname } = useLocation();
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const p = await Profile.getProfile();
        mounted && setProfile(p || {});
      } catch {
        mounted && setProfile({});
      }
    })();
    const unsub = Profile.subscribe?.((p) => setProfile(p || {}));
    return () => unsub && unsub();
  }, []);

  useGlobalGlue();

  const active = useMemo(() => {
    if (pathname.startsWith(`${base}/food`)) return "food";
    if (pathname.startsWith(`${base}/garden`)) return "garden";
    if (pathname.startsWith(`${base}/animal`)) return "animal";
    if (pathname.startsWith(`${base}/cleaning`)) return "cleaning";
    if (pathname.startsWith(`${base}/calendar`)) return "calendar";
    if (pathname.startsWith(`${base}/meal-planning`)) return "meal-planning";
    if (pathname.startsWith(`${base}/automation`)) return "automation";
    if (pathname.startsWith(`${base}/advanced`)) return "advanced";
    return "profile";
  }, [pathname, base]);

  const shellfishAllowed = !!profile?.torahFood?.shellfishAllowed;

  return (
    <div className="w-full max-w-7xl mx-auto px-4 py-4 md:px-0">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2 mb-4">
        <div>
          <div className="text-sm breadcrumbs mb-1">
            <ul>
              <li><RRNavLink to="/">Dashboard</RRNavLink></li>
              <li>Settings</li>
              <li className="opacity-70 capitalize">{active}</li>
            </ul>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold">Settings</h1>
          <p className="opacity-70 text-sm">
            Manage your household profile, food, garden, animal, and system settings.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-info"
              checked={shellfishAllowed}
              onChange={(e) =>
                Profile.setAtPath?.("torahFood.shellfishAllowed", e.target.checked)
              }
            />
            <span className="text-sm">
              Shellfish {shellfishAllowed ? "On" : "Off"}
            </span>
          </label>
          <RRNavLink to="/" className="btn btn-primary btn-sm rounded-2xl">
            Back
          </RRNavLink>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-4">
        <TabLink to={`${base}/profile`}>Profile</TabLink>
        <TabLink to={`${base}/food`}>Food</TabLink>
        <TabLink to={`${base}/garden`}>Garden</TabLink>
        <TabLink to={`${base}/animal`}>Animal</TabLink>
        <TabLink to={`${base}/cleaning`}>Cleaning</TabLink>
        <TabLink to={`${base}/calendar`}>Calendar</TabLink>
        <TabLink to={`${base}/meal-planning`}>Meal Planning</TabLink>
        <TabLink to={`${base}/automation`}>Automation</TabLink>
        <TabLink to={`${base}/advanced`}>Advanced</TabLink>
      </div>

      {/* Page Content */}
      <div className="min-h-[320px]">
        <Suspense
          fallback={
            <div className="grid gap-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="animate-pulse h-28 bg-base-200 rounded-2xl" />
              ))}
            </div>
          }
        >
          {route}
        </Suspense>
      </div>
    </div>
  );
}

// --------------------- Error Boundary-lite ---------------
function ErrorBoundary({ children }) {
  const [err, setErr] = useState(null);
  if (err) {
    return (
      <div className="card bg-base-100 border border-base-200 rounded-2xl shadow-sm">
        <div className="card-body">
          <h2 className="card-title">Something went wrong</h2>
          <p className="opacity-70 text-sm">{String(err)}</p>
          <div className="mt-3">
            <button className="btn btn-primary btn-sm rounded-2xl" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <React.Suspense fallback={<div className="animate-pulse h-28 bg-base-200 rounded-2xl" />}>
      <ErrorCatcher onError={setErr}>{children}</ErrorCatcher>
    </React.Suspense>
  );
}
function ErrorCatcher({ onError, children }) {
  try {
    // eslint-disable-next-line react/jsx-no-useless-fragment
    return <>{children}</>;
  } catch (e) {
    onError(e);
    return null;
  }
}

// --------------------- Route Factory ---------------------
export function getSettingsRoutes(base = "/settings") {
  const Layout = ({ element }) => <SettingsLayout base={base} route={element} />;

  return [
    // Helpful redirect: /settings -> /settings/profile
    { path: base, element: <Navigate to={`${base}/profile`} replace /> },

    { path: `${base}/profile`,   element: <Layout element={<ErrorBoundary><ProfileSettingsPage /></ErrorBoundary>} /> },
    { path: `${base}/food`,      element: <Layout element={<ErrorBoundary><FoodSettingsPage /></ErrorBoundary>} /> },
    { path: `${base}/garden`,    element: <Layout element={<ErrorBoundary><GardenSettingsPage /></ErrorBoundary>} /> },
    { path: `${base}/animal`,    element: <Layout element={<ErrorBoundary><AnimalSettingsPage /></ErrorBoundary>} /> },
    { path: `${base}/cleaning`,  element: <Layout element={<ErrorBoundary><CleaningSettingsPage /></ErrorBoundary>} /> },
    { path: `${base}/calendar`,  element: <Layout element={<ErrorBoundary><CalendarSettingsPage /></ErrorBoundary>} /> },
    { path: `${base}/meal-planning`, element: <Layout element={<ErrorBoundary><MealPlanningSettingsPage /></ErrorBoundary>} /> },
    { path: `${base}/automation`,element: <Layout element={<ErrorBoundary><AutomationSettingsPage /></ErrorBoundary>} /> },
    { path: `${base}/advanced`,  element: <Layout element={<ErrorBoundary><AdvancedSettingsPage /></ErrorBoundary>} /> },

    // Fallback for anything else under /settings/*
    { path: `${base}/*`, element: <Navigate to={`${base}/profile`} replace /> },
  ];
}

export default getSettingsRoutes;
