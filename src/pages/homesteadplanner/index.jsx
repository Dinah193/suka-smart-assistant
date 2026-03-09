/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\homesteadplanner\index.jsx
//
// Homestead Planner — Overview (route: /homesteadplanner)
//
// Goals:
// - Provide a stable, always-rendering overview shell (no undefined dynamic components).
// - Emit module presence events so engines can refresh targets/estimators ONLY while user is in Homestead Planner.
// - React to core planning events: meal.plan.updated, meal.executed, inventory.updated (plus legacy equivalents).
// - Keep this file standalone and production-safe even if optional engines/stores are missing.
//
// Notes:
// - This page intentionally uses window-level and eventBus listeners (soft dependency).
// - It does NOT assume any particular store implementation.
// - It keeps UI clean, but includes dev diagnostics toggles for quick troubleshooting.

import React from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

// Stable import (file exists in your project)
import * as EventBusMod from "../../services/events/eventBus.js";

// Accept either default export or common named exports
const eventBus =
  EventBusMod?.default ?? EventBusMod?.eventBus ?? EventBusMod?.bus ?? null;

/* --------------------------------- helpers -------------------------------- */

function getBus() {
  // Prefer the imported bus if available; else fall back to global.
  return eventBus || window.__suka?.eventBus || null;
}

function emitBus(type, data, opts = {}) {
  try {
    const bus = getBus();
    bus?.emit?.(type, data, opts);
  } catch {}
}

function onBus(pattern, handler, opts) {
  try {
    const bus = getBus();
    if (!bus?.on) return () => {};
    return bus.on(pattern, handler, opts);
  } catch {
    return () => {};
  }
}

function safeNowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return `${Date.now()}`;
  }
}

function cls(...parts) {
  return parts.filter(Boolean).join(" ");
}

function summarizePayload(p) {
  try {
    // eventBus canonical payload uses {type, ts, source, data}
    if (p && typeof p === "object") {
      const data = p.data ?? p;
      if (data && typeof data === "object") {
        const keys = Object.keys(data);
        return keys.length ? `keys: ${keys.slice(0, 8).join(", ")}` : "object";
      }
      return typeof data;
    }
    return typeof p;
  } catch {
    return "unknown";
  }
}

function normalizeDotToSlash(name) {
  return String(name || "")
    .replace(/\./g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/|\/$/g, "");
}

function isHomesteadPath(pathname) {
  const p = String(pathname || "");
  return p === "/homesteadplanner" || p.startsWith("/homesteadplanner/");
}

/* ------------------------------- UI atoms --------------------------------- */

function Card({ title, subtitle, children, right }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="p-4 border-b border-neutral-100 flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold">{title}</div>
          {subtitle ? (
            <div className="mt-1 text-xs text-neutral-500">{subtitle}</div>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Pill({ tone = "zinc", children }) {
  const map = {
    zinc: "bg-neutral-100 text-neutral-800 border-neutral-200",
    blue: "bg-sky-100 text-sky-900 border-sky-200",
    green: "bg-emerald-100 text-emerald-900 border-emerald-200",
    amber: "bg-amber-100 text-amber-900 border-amber-200",
    rose: "bg-rose-100 text-rose-900 border-rose-200",
  };
  return (
    <span
      className={cls(
        "inline-flex items-center border text-xs px-2 py-0.5 rounded-full",
        map[tone] || map.zinc,
      )}
    >
      {children}
    </span>
  );
}

function Button({ variant = "outline", children, className, ...props }) {
  const variants = {
    outline:
      "border border-neutral-300 bg-white hover:bg-neutral-50 text-neutral-900",
    primary:
      "bg-indigo-600 text-white hover:bg-indigo-700 border border-indigo-600",
    ghost: "border border-transparent hover:bg-neutral-100 text-neutral-900",
  };
  return (
    <button
      className={cls(
        "rounded-2xl px-3 py-2 text-sm transition",
        variants[variant] || variants.outline,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* -------------------------- refresh orchestration -------------------------- */
/**
 * The homestead planner should "listen and refresh targets/estimators"
 * when user is inside the module.
 *
 * We do this by:
 * 1) Emitting homestead/active true/false (sticky) when mounted/unmounted.
 * 2) Listening for key planning events and translating them into a single
 *    refresh request event: homestead/refreshRequested
 * 3) Providing a simple UI status so you can see it happened.
 *
 * Engines/services can listen to:
 * - "homestead/active" (sticky)
 * - "homestead/refreshRequested"
 *
 * Why not run engines directly here?
 * - Keeps page lightweight and avoids circular deps.
 */

const REFRESH_EVENT = "homestead/refreshRequested";
const ACTIVE_EVENT = "homestead/active";

const TRIGGER_EVENTS = [
  // Requested explicit dot events from you
  "meal.plan.updated",
  "meal.executed",
  "inventory.updated",

  // Also listen to slash equivalents (eventBus normalizes dots→slashes)
  "meal/plan/updated",
  "meal/executed",
  "inventory/updated",

  // SSA canonical (older modules often use mealplan/updated)
  "mealplan/updated",
];

function emitRefresh(reason, raw) {
  const payload = {
    reason: String(reason || "unknown"),
    at: safeNowIso(),
    // keep raw small, do not dump huge objects
    summary: summarizePayload(raw),
  };
  emitBus(REFRESH_EVENT, payload, { source: "homesteadplanner.index" });
}

/* ------------------------------- main page -------------------------------- */

export default function HomesteadPlannerOverview() {
  const location = useLocation();
  const navigate = useNavigate();

  // UI state
  const [active, setActive] = React.useState(true);
  const [lastRefresh, setLastRefresh] = React.useState(null);
  const [refreshCount, setRefreshCount] = React.useState(0);
  const [lastTrigger, setLastTrigger] = React.useState(null);
  const [devOpen, setDevOpen] = React.useState(
    Boolean(
      import.meta?.env?.DEV && window.localStorage?.getItem("hp_dev") === "1",
    ),
  );

  // Determine current subroute selection (purely for highlighting quick links)
  const subPath = React.useMemo(() => {
    const p = String(location?.pathname || "");
    if (p === "/homesteadplanner") return "overview";
    const tail = p.replace("/homesteadplanner/", "");
    return tail || "overview";
  }, [location?.pathname]);

  // Emit active presence on mount/unmount, and when route enters/leaves homestead.
  React.useEffect(() => {
    const inHomestead = isHomesteadPath(location?.pathname);
    setActive(inHomestead);

    // Sticky so late listeners (engines) can know whether module is active.
    emitBus(
      ACTIVE_EVENT,
      { active: inHomestead, path: location?.pathname || "/homesteadplanner" },
      { sticky: true, source: "homesteadplanner.index" },
    );

    // Also emit a UI-friendly dot variant (optional for other modules)
    emitBus(
      "homestead.active",
      { active: inHomestead, path: location?.pathname || "/homesteadplanner" },
      { sticky: true, source: "homesteadplanner.index" },
    );

    // If we just entered homestead, trigger an initial refresh so targets/estimators load.
    if (inHomestead) {
      emitRefresh("enter.module", {
        type: "route.changed",
        data: { path: location?.pathname },
      });
    }

    return () => {
      // Only mark inactive if we truly leave/unmount
      emitBus(
        ACTIVE_EVENT,
        { active: false, path: location?.pathname || "/homesteadplanner" },
        { sticky: true, source: "homesteadplanner.index" },
      );
      emitBus(
        "homestead.active",
        { active: false, path: location?.pathname || "/homesteadplanner" },
        { sticky: true, source: "homesteadplanner.index" },
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.pathname]);

  // Listen to trigger events and request refresh while active.
  React.useEffect(() => {
    const unsubs = [];

    const handler = (payload, meta) => {
      // Only refresh if user is inside module
      if (!isHomesteadPath(location?.pathname)) return;

      const evtName = meta?.event || payload?.type || "unknown";
      const reason = normalizeDotToSlash(evtName);
      setLastTrigger({
        evt: evtName,
        at: safeNowIso(),
        summary: summarizePayload(payload),
      });

      // Request refresh for targets/estimators
      emitRefresh(reason, payload);

      // Update UI state
      setRefreshCount((n) => n + 1);
      setLastRefresh({
        at: safeNowIso(),
        reason,
        traceId: meta?.traceId || "",
      });
    };

    // Subscribe to each trigger event (both dot and slash forms)
    for (const name of TRIGGER_EVENTS) {
      const pat = normalizeDotToSlash(name);
      unsubs.push(onBus(pat, handler, { priority: 10 }));
    }

    // Bonus: Listen for any inventory/** changes if you want broader behavior (dev only toggle)
    if (devOpen) {
      unsubs.push(onBus("inventory/**", handler, { priority: 1 }));
    }

    return () => {
      for (const u of unsubs) {
        try {
          u?.();
        } catch {}
      }
    };
  }, [location?.pathname, devOpen]);

  // Listen for refresh events (so if engines emit them we reflect)
  React.useEffect(() => {
    return onBus(
      normalizeDotToSlash(REFRESH_EVENT),
      (payload) => {
        if (!isHomesteadPath(location?.pathname)) return;
        setLastRefresh({
          at: safeNowIso(),
          reason: payload?.data?.reason || payload?.reason || "refresh",
        });
      },
      { priority: 5 },
    );
  }, [location?.pathname]);

  // Simple “dev mode” toggle persistence
  React.useEffect(() => {
    try {
      if (!window.localStorage) return;
      if (devOpen) window.localStorage.setItem("hp_dev", "1");
      else window.localStorage.removeItem("hp_dev");
    } catch {}
  }, [devOpen]);

  // Manual refresh button
  const manualRefresh = React.useCallback(() => {
    if (!isHomesteadPath(location?.pathname)) return;
    emitRefresh("manual", { note: "manual refresh clicked" });
    setRefreshCount((n) => n + 1);
    setLastRefresh({ at: safeNowIso(), reason: "manual" });
  }, [location?.pathname]);

  const go = (to) => {
    try {
      navigate(to);
    } catch {}
  };

  return (
    <div className="p-3 md:p-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
        <div>
          <div className="text-2xl font-semibold">Homestead Planner</div>
          <div className="mt-1 text-sm text-neutral-600">
            Build food security step-by-step: targets → components → inventory
            gaps → batches.
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Pill tone={active ? "green" : "rose"}>
              {active ? "Module active" : "Module inactive"}
            </Pill>
            <Pill tone="blue">Refreshes while inside module</Pill>
            <Pill tone="zinc">
              Triggers: meal.plan.updated • meal.executed • inventory.updated
            </Pill>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={manualRefresh}>
            Refresh targets
          </Button>
          <Button
            variant="ghost"
            onClick={() => setDevOpen((v) => !v)}
            title="Dev diagnostics"
          >
            {devOpen ? "Hide diagnostics" : "Show diagnostics"}
          </Button>
        </div>
      </div>

      {/* Quick nav */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
        <Card
          title="Quick Links"
          subtitle="Jump to planner steps"
          right={<Pill tone="zinc">{subPath}</Pill>}
        >
          <div className="grid grid-cols-2 gap-2">
            <NavLink
              to="/homesteadplanner"
              className={cls(
                "rounded-2xl border px-3 py-2 text-sm",
                subPath === "overview"
                  ? "border-indigo-300 bg-indigo-50"
                  : "border-neutral-200 bg-white hover:bg-neutral-50",
              )}
            >
              Overview
            </NavLink>

            <NavLink
              to="/homesteadplanner/targets"
              className={cls(
                "rounded-2xl border px-3 py-2 text-sm",
                subPath === "targets"
                  ? "border-indigo-300 bg-indigo-50"
                  : "border-neutral-200 bg-white hover:bg-neutral-50",
              )}
            >
              Targets
            </NavLink>

            <NavLink
              to="/homesteadplanner/components"
              className={cls(
                "rounded-2xl border px-3 py-2 text-sm",
                subPath === "components"
                  ? "border-indigo-300 bg-indigo-50"
                  : "border-neutral-200 bg-white hover:bg-neutral-50",
              )}
            >
              Components
            </NavLink>

            <NavLink
              to="/homesteadplanner/inventory"
              className={cls(
                "rounded-2xl border px-3 py-2 text-sm",
                subPath === "inventory"
                  ? "border-indigo-300 bg-indigo-50"
                  : "border-neutral-200 bg-white hover:bg-neutral-50",
              )}
            >
              Inventory plan
            </NavLink>

            <NavLink
              to="/homesteadplanner/batches"
              className={cls(
                "rounded-2xl border px-3 py-2 text-sm",
                subPath === "batches"
                  ? "border-indigo-300 bg-indigo-50"
                  : "border-neutral-200 bg-white hover:bg-neutral-50",
              )}
            >
              Batches
            </NavLink>

            <NavLink
              to="/homesteadplanner/skills"
              className={cls(
                "rounded-2xl border px-3 py-2 text-sm",
                subPath === "skills"
                  ? "border-indigo-300 bg-indigo-50"
                  : "border-neutral-200 bg-white hover:bg-neutral-50",
              )}
            >
              Skills
            </NavLink>
          </div>

          <div className="mt-3 text-xs text-neutral-500">
            This overview page emits <code>homestead/active</code> and requests
            refreshes via <code>{REFRESH_EVENT}</code>.
          </div>
        </Card>

        <Card
          title="What refreshes here?"
          subtitle="Targets + estimators are updated while you’re in Homestead Planner"
        >
          <ul className="text-sm text-neutral-700 list-disc pl-5 space-y-1">
            <li>
              When meal plans update: <code>meal.plan.updated</code> /{" "}
              <code>meal/plan/updated</code>
            </li>
            <li>
              When meals are executed: <code>meal.executed</code> /{" "}
              <code>meal/executed</code>
            </li>
            <li>
              When inventory changes: <code>inventory.updated</code> /{" "}
              <code>inventory/updated</code>
            </li>
            <li>
              On entering this module (route changed into{" "}
              <code>/homesteadplanner</code>)
            </li>
          </ul>

          <div className="mt-3 flex gap-2 flex-wrap">
            <Pill tone="amber">refreshCount: {refreshCount}</Pill>
            {lastRefresh?.at ? (
              <Pill tone="zinc">last: {lastRefresh.at}</Pill>
            ) : null}
            {lastRefresh?.reason ? (
              <Pill tone="zinc">reason: {lastRefresh.reason}</Pill>
            ) : null}
          </div>
        </Card>

        <Card title="Next steps" subtitle="Starter flows">
          <div className="grid grid-cols-1 gap-2">
            <Button
              variant="primary"
              onClick={() => go("/homesteadplanner/targets")}
              className="w-full"
            >
              Set food security targets
            </Button>
            <Button
              variant="outline"
              onClick={() => go("/homesteadplanner/components")}
              className="w-full"
            >
              Pick components (grains, proteins, veg)
            </Button>
            <Button
              variant="outline"
              onClick={() => go("/homesteadplanner/inventory")}
              className="w-full"
            >
              Generate inventory gaps
            </Button>
            <Button
              variant="outline"
              onClick={() => go("/homesteadplanner/batches")}
              className="w-full"
            >
              Plan batch cooking & preservation
            </Button>
          </div>
          <div className="mt-3 text-xs text-neutral-500">
            Tip: If you want this to drive garden/animal targets, listen to{" "}
            <code>{REFRESH_EVENT}</code> in those engines and recalc demand
            deltas.
          </div>
        </Card>
      </div>

      {/* Diagnostics */}
      {devOpen ? (
        <Card
          title="Diagnostics"
          subtitle="Useful when a route renders blank or events don’t trigger"
          right={<Pill tone="amber">DEV</Pill>}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-3">
              <div className="text-xs font-semibold text-neutral-700 mb-2">
                Bus status
              </div>
              <div className="text-sm text-neutral-800 space-y-1">
                <div>
                  Imported bus:{" "}
                  <Pill tone={eventBus ? "green" : "rose"}>
                    {eventBus ? "ok" : "missing"}
                  </Pill>
                </div>
                <div>
                  window.__suka.eventBus:{" "}
                  <Pill tone={window.__suka?.eventBus ? "green" : "rose"}>
                    {window.__suka?.eventBus ? "ok" : "missing"}
                  </Pill>
                </div>
                <div className="text-xs text-neutral-600 mt-2">
                  If both are missing, check{" "}
                  <code>src/services/events/eventBus.js</code> exports.
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-3">
              <div className="text-xs font-semibold text-neutral-700 mb-2">
                Last trigger
              </div>
              {lastTrigger ? (
                <div className="text-sm text-neutral-800 space-y-1">
                  <div>
                    Event: <code>{String(lastTrigger.evt)}</code>
                  </div>
                  <div>At: {String(lastTrigger.at)}</div>
                  <div>Payload: {String(lastTrigger.summary)}</div>
                </div>
              ) : (
                <div className="text-sm text-neutral-600">
                  No triggers yet. Try changing inventory or updating a meal
                  plan.
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    // Emit a test trigger (won't affect data)
                    emitBus(
                      "meal.plan.updated",
                      { test: true },
                      { source: "homesteadplanner.index" },
                    );
                  }}
                >
                  Emit test meal.plan.updated
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    emitBus(
                      "inventory.updated",
                      { test: true },
                      { source: "homesteadplanner.index" },
                    );
                  }}
                >
                  Emit test inventory.updated
                </Button>
              </div>
            </div>
          </div>

          <div className="mt-3 text-xs text-neutral-500">
            If you ever get React error #306 again, it means a route component
            resolved to <code>undefined</code>. Ensure your pages export{" "}
            <code>default</code>.
          </div>
        </Card>
      ) : null}
    </div>
  );
}
