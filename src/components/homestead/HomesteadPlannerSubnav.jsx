// C:\Users\larho\suka-smart-assistant\src\components\homestead\HomesteadPlannerSubnav.jsx
/* eslint-disable react/prop-types */
/**
 * SSA • Homestead Planner Subnav
 * -----------------------------------------------------------------------------
 * Tabs/segmented control linking to Homestead Planner subpages.
 *
 * Goals
 *  - React Router friendly (NavLink)
 *  - Highlights active route
 *  - Works in narrow + wide layouts (wraps)
 *  - Optional compact mode (true segmented pill buttons)
 *  - Optional overflow dropdown when many tabs (simple, no dependencies)
 *
 * Usage
 *  <HomesteadPlannerSubnav base="/homesteadplanner" />
 *
 * If your routes are nested (recommended):
 *  base="/homesteadplanner" and each tab uses `${base}/inventory`, etc.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

const DEFAULT_BASE = "/homesteadplanner";

/**
 * Define your Homestead Planner subpages here.
 * Keep in sync with your router config / App.jsx.
 */
export const HOMESTEAD_PLANNER_TABS = [
  {
    key: "targets",
    label: "Targets",
    to: "/targets",
    title: "Provisioning targets + gaps + actions",
  },
  {
    key: "components",
    label: "Catalog",
    to: "/components",
    title: "Components & Preservation catalog browser",
  },
  {
    key: "inventory",
    label: "Inventory",
    to: "/inventory",
    title: "Component inventory view: readiness + shelf life",
  },
  {
    key: "batches",
    label: "Batches",
    to: "/batches",
    title: "Batch history + start preservation batch",
  },
  {
    key: "gardenTargets",
    label: "Garden targets",
    to: "/garden-targets",
    title: "Planting targets derived from provisioning",
  },
  {
    key: "animalTargets",
    label: "Animal targets",
    to: "/animal-targets",
    title: "Breeding/purchase targets derived from provisioning",
  },
  {
    key: "cuisines",
    label: "Cuisines",
    to: "/cuisines",
    title: "Cuisine profile selection + rotation",
  },
  {
    key: "preferences",
    label: "Preferences",
    to: "/preferences",
    title: "Household preferences + taste cards",
  },
  {
    key: "skills",
    label: "Skills",
    to: "/skills",
    title: "Skill paths tied to what’s planned next",
  },
];

/**
 * Small helper to join classnames without dependencies.
 */
function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function normalizeBase(base) {
  const b = typeof base === "string" ? base.trim() : DEFAULT_BASE;
  if (!b) return DEFAULT_BASE;
  if (b === "/") return "";
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

function safeTabs(tabs) {
  return Array.isArray(tabs) && tabs.length ? tabs : HOMESTEAD_PLANNER_TABS;
}

function buildTo(base, tabTo) {
  const b = normalizeBase(base);
  const t = typeof tabTo === "string" ? tabTo : "";
  if (!t) return b || "/";
  if (t.startsWith("/")) return `${b}${t}`;
  return `${b}/${t}`;
}

function isPathActive(pathname, target) {
  // Normalize trailing slashes
  const p = (pathname || "").replace(/\/+$/, "") || "/";
  const t = (target || "").replace(/\/+$/, "") || "/";
  if (t === "/") return p === "/";
  return p === t || p.startsWith(`${t}/`);
}

/**
 * HomesteadPlannerSubnav
 */
export default function HomesteadPlannerSubnav({
  base = DEFAULT_BASE,
  tabs = HOMESTEAD_PLANNER_TABS,
  className = "",
  compact = false, // true => more segmented
  sticky = false, // true => makes bar sticky to top
  withOverflow = true, // true => use overflow dropdown if wrapping
  rightSlot = null, // optional node on right side
  ariaLabel = "Homestead Planner navigation",
}) {
  const location = useLocation();

  const normalizedTabs = useMemo(() => safeTabs(tabs), [tabs]);

  const resolvedTabs = useMemo(() => {
    return normalizedTabs.map((t) => ({
      ...t,
      href: buildTo(base, t.to),
    }));
  }, [normalizedTabs, base]);

  // Active tab resolution (for overflow selection)
  const activeKey = useMemo(() => {
    const pathname = location?.pathname || "/";
    const hit =
      resolvedTabs.find((t) => isPathActive(pathname, t.href)) ||
      resolvedTabs.find((t) => pathname === buildTo(base, "/")) ||
      null;
    return hit?.key || null;
  }, [location?.pathname, resolvedTabs, base]);

  // Overflow logic: detect wrapping by measuring container scrollHeight vs lineHeight-ish
  const wrapRef = useRef(null);
  const [wrapped, setWrapped] = useState(false);

  useEffect(() => {
    if (!withOverflow) return;

    const el = wrapRef.current;
    if (!el) return;

    const measure = () => {
      // If items wrap, the container's scrollHeight will exceed its clientHeight noticeably.
      // Use a small threshold.
      const w = el.scrollHeight - el.clientHeight > 6;
      setWrapped(w);
    };

    measure();

    const ro = new ResizeObserver(() => measure());
    ro.observe(el);

    window.addEventListener("resize", measure);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {}
      window.removeEventListener("resize", measure);
    };
  }, [withOverflow, resolvedTabs.length]);

  // If wrapped and overflow enabled, show a dropdown + a condensed visible set
  const [showAll, setShowAll] = useState(false);

  const visibleTabs = useMemo(() => {
    if (!withOverflow) return resolvedTabs;
    if (!wrapped) return resolvedTabs;
    if (showAll) return resolvedTabs;

    // Keep first 4 + active tab if not included
    const first = resolvedTabs.slice(0, 4);
    if (!activeKey) return first;
    const hasActive = first.some((t) => t.key === activeKey);
    if (hasActive) return first;

    const activeTab = resolvedTabs.find((t) => t.key === activeKey);
    if (!activeTab) return first;

    // Replace last item with active to keep relevance
    const trimmed = first.slice(0, Math.max(0, first.length - 1));
    return [...trimmed, activeTab];
  }, [resolvedTabs, wrapped, showAll, withOverflow, activeKey]);

  const overflowTabs = useMemo(() => {
    if (!withOverflow) return [];
    if (!wrapped || showAll) return [];
    const visibleKeys = new Set(visibleTabs.map((t) => t.key));
    return resolvedTabs.filter((t) => !visibleKeys.has(t.key));
  }, [resolvedTabs, wrapped, showAll, withOverflow, visibleTabs]);

  // UI styles
  const shellClass = cx(
    "w-full",
    sticky
      ? "sticky top-0 z-40 bg-white/90 backdrop-blur border-b border-gray-200"
      : "",
    className
  );

  const innerClass = cx(
    "flex items-center justify-between gap-3",
    sticky ? "px-4 py-3" : ""
  );

  const segmentWrapClass = cx("flex-1", sticky ? "" : "mt-0");

  const tabsRowClass = cx(
    "flex flex-wrap items-center gap-2",
    compact ? "rounded-2xl border border-gray-200 bg-white p-1" : ""
  );

  const tabBaseClass = cx(
    "inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold border transition select-none",
    compact ? "border-transparent" : "border-gray-200 bg-white hover:bg-gray-50"
  );

  const tabActiveClass = compact
    ? "bg-black text-white"
    : "bg-black text-white border-black";

  const tabInactiveClass = compact
    ? "bg-white text-black hover:bg-gray-50"
    : "text-black";

  return (
    <div className={shellClass} aria-label={ariaLabel}>
      <div
        className={cx(
          innerClass,
          sticky ? "" : "flex items-center justify-between gap-3"
        )}
      >
        <div className={segmentWrapClass}>
          <div
            ref={wrapRef}
            className={tabsRowClass}
            role="tablist"
            aria-label={ariaLabel}
          >
            {visibleTabs.map((t) => (
              <NavLink
                key={t.key}
                to={t.href}
                title={t.title || t.label}
                role="tab"
                aria-selected={t.key === activeKey}
                className={({ isActive }) => {
                  // NavLink's isActive doesn't always cover nested routes unless `end` is set;
                  // we apply a more robust check here.
                  const on =
                    isActive || isPathActive(location?.pathname || "/", t.href);
                  return cx(
                    tabBaseClass,
                    on ? tabActiveClass : tabInactiveClass
                  );
                }}
              >
                <span className="truncate max-w-[14rem]">{t.label}</span>
              </NavLink>
            ))}

            {withOverflow && wrapped && overflowTabs.length ? (
              <OverflowMenu
                label={`More (${overflowTabs.length})`}
                activeKey={activeKey}
                overflowTabs={overflowTabs}
                compact={compact}
                tabBaseClass={tabBaseClass}
                tabActiveClass={tabActiveClass}
                tabInactiveClass={tabInactiveClass}
              />
            ) : null}

            {withOverflow && wrapped ? (
              <button
                type="button"
                className={cx(
                  tabBaseClass,
                  "text-black border-gray-200 bg-white hover:bg-gray-50",
                  compact ? "border-transparent" : ""
                )}
                onClick={() => setShowAll((v) => !v)}
                title={showAll ? "Show fewer tabs" : "Show all tabs"}
              >
                {showAll ? "Less" : "All"}
              </button>
            ) : null}
          </div>
        </div>

        {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Overflow dropdown (no deps)
 * --------------------------------------------------------------------------- */

function OverflowMenu({
  label,
  activeKey,
  overflowTabs,
  compact,
  tabBaseClass,
  tabActiveClass,
  tabInactiveClass,
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onDoc = (e) => {
      // close on outside click
      if (!e?.target?.closest?.("[data-hp-overflow]")) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="relative" data-hp-overflow>
      <button
        type="button"
        className={cx(
          tabBaseClass,
          compact ? "bg-white text-black hover:bg-gray-50" : "text-black",
          "border-gray-200"
        )}
        onClick={() => setOpen((v) => !v)}
        title="More sections"
        aria-haspopup="menu"
        aria-expanded={open ? "true" : "false"}
      >
        {label} ▾
      </button>

      {open ? (
        <div className="absolute right-0 mt-2 w-64 rounded-2xl border border-gray-200 bg-white shadow-lg p-2 z-50">
          <div className="text-xs font-bold opacity-70 px-2 py-2">More</div>
          <div className="space-y-1">
            {overflowTabs.map((t) => {
              const on = t.key === activeKey;
              return (
                <NavLink
                  key={t.key}
                  to={t.href}
                  title={t.title || t.label}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    cx(
                      "flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm font-semibold border transition",
                      on || isActive ? tabActiveClass : tabInactiveClass,
                      compact
                        ? "border-transparent"
                        : "border-gray-200 bg-white hover:bg-gray-50"
                    )
                  }
                >
                  <span className="truncate">{t.label}</span>
                  {on ? (
                    <span className="text-xs opacity-80">active</span>
                  ) : null}
                </NavLink>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
