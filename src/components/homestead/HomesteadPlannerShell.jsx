// C:\Users\larho\suka-smart-assistant\src\components\homestead\HomesteadPlannerShell.jsx
/* eslint-disable react/prop-types */
/* eslint-disable no-console */
/**
 * SSA • HomesteadPlannerShell
 * -----------------------------------------------------------------------------
 * Wraps all Homestead subpages in the SAME layout system used by other domains:
 *  - Header (title/subtitle + optional chips)
 *  - Subnav (tabs/segmented control)
 *  - Actions row (primary/secondary/tertiary)
 *  - Optional KPI row (readiness/backlog/next-due)
 *  - Content container (consistent spacing + max width)
 *
 * IMPORTANT: Uses shared UI primitives where available:
 *  - src/components/ui/button.jsx
 *  - src/components/ui/card.jsx
 *  - src/components/ui/tabs.jsx (optional; Subnav is primary)
 *
 * Usage (in a homestead subpage):
 *  <HomesteadPlannerShell
 *    pageTitle="Inventory"
 *    pageSubtitle="Readiness + shelf life"
 *    primary={{ label: "Add item", to: "/homesteadplanner/inventory?new=1" }}
 *    secondary={{ label: "Browse catalog", to: "/homesteadplanner/components" }}
 *    tertiary={[{ label: "Refresh", onClick: refresh }]}
 *  >
 *    <YourPageContent />
 *  </HomesteadPlannerShell>
 */

import React, { useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";

import HomesteadPlannerSubnav, {
  HOMESTEAD_PLANNER_TABS,
} from "@/components/homestead/HomesteadPlannerSubnav";

import PlannerActionBar from "@/components/homestead/PlannerActionBar";
import HomesteadKpiRow from "@/components/homestead/HomesteadKpiRow";

// Shared UI primitives (expected to exist per your checklist)
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

// Optional: if you have tabs primitive and want to swap in later, keep this import commented.
// import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function resolveLabelFromRoute(pathname, base, tabs) {
  const p = (pathname || "").replace(/\/+$/, "") || "/";
  const b = (base || "/homesteadplanner").replace(/\/+$/, "");
  const list =
    Array.isArray(tabs) && tabs.length ? tabs : HOMESTEAD_PLANNER_TABS;

  // If route is exactly base, treat as targets
  const normalized = p === b ? `${b}/targets` : p;

  const hit = list
    .map((t) => {
      const href = `${b}${t.to?.startsWith("/") ? t.to : `/${t.to}`}`.replace(
        /\/+$/,
        ""
      );
      return { ...t, href };
    })
    .find((t) => normalized === t.href || normalized.startsWith(`${t.href}/`));

  return hit?.label || "Homestead";
}

/**
 * HomesteadPlannerShell
 */
export default function HomesteadPlannerShell({
  // Layout identity
  base = "/homesteadplanner",
  tabs = HOMESTEAD_PLANNER_TABS,

  // Header (top card)
  headerTitle = "Homestead Planner",
  headerSubtitle = "Provisioning → targets → inventory → preservation → skills",
  headerRight = null, // node (e.g., export button, badges)
  headerBadges = [], // [{ text, tone }] rendered as small chips

  // Page-level title/subtitle (shows in header card)
  pageTitle = null,
  pageSubtitle = null,

  // Actions row (PlannerActionBar)
  primary = null,
  secondary = null,
  tertiary = [],
  actionBarLeftSlot = null,
  actionBarRightSlot = null,
  actionBarStatus = null,
  actionBarStatusTone = "neutral",
  actionBarMetaBadges = [],

  // KPI row
  showKpis = true,
  kpiHouseholdId = "primary",
  kpiDueSoonDays = 14,

  // Container options
  maxWidthClass = "max-w-7xl",
  contentClassName = "",
  className = "",

  // Navigation handling (optional)
  onNavigate = null, // (to)=>void; if null, uses react-router navigate

  // Children
  children,
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const navFn = useMemo(() => {
    if (onNavigate) return onNavigate;
    return (to) => navigate(to);
  }, [onNavigate, navigate]);

  const routeLabel = useMemo(() => {
    return resolveLabelFromRoute(location?.pathname, base, tabs);
  }, [location?.pathname, base, tabs]);

  const effectivePageTitle = safeStr(pageTitle) || routeLabel;
  const effectivePageSubtitle = safeStr(pageSubtitle);

  const hasBadges = Array.isArray(headerBadges) && headerBadges.length;

  return (
    <div className={cx("w-full", className)}>
      <div className={cx("mx-auto w-full px-4 pb-10", maxWidthClass)}>
        {/* Header Card (shared UI Card primitive) */}
        <Card className="mt-4">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <CardTitle className="text-base font-black">
                {headerTitle}
              </CardTitle>
              {headerSubtitle ? (
                <CardDescription className="mt-1 text-sm">
                  {headerSubtitle}
                </CardDescription>
              ) : null}

              {/* Page context */}
              <div className="mt-4">
                <div className="text-lg font-black leading-tight">
                  {effectivePageTitle}
                </div>
                {effectivePageSubtitle ? (
                  <div className="mt-1 text-sm opacity-70">
                    {effectivePageSubtitle}
                  </div>
                ) : null}
              </div>

              {hasBadges ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {headerBadges.slice(0, 8).map((b, idx) => (
                    <HeaderChip
                      key={`${b?.text || "chip"}-${idx}`}
                      tone={b?.tone || "neutral"}
                    >
                      {b?.text || ""}
                    </HeaderChip>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="shrink-0 flex items-center gap-2">
              {headerRight}
              {/* Small “Home” convenience button (uses shared Button primitive) */}
              <Button
                variant="outline"
                onClick={() => navFn(base)}
                title="Go to Homestead Planner root"
              >
                Home
              </Button>
            </div>
          </CardHeader>

          <CardContent className="pt-0">
            <HomesteadPlannerSubnav base={base} tabs={tabs} sticky={false} />
          </CardContent>
        </Card>

        {/* Actions Row */}
        <div className="mt-3">
          <PlannerActionBar
            title={effectivePageTitle}
            subtitle={
              effectivePageSubtitle ||
              "Choose an action to move this plan forward."
            }
            primary={primary}
            secondary={secondary}
            tertiary={tertiary}
            leftSlot={actionBarLeftSlot}
            rightSlot={actionBarRightSlot}
            status={actionBarStatus}
            statusTone={actionBarStatusTone}
            metaBadges={actionBarMetaBadges}
            onNavigate={navFn}
            sticky={false}
          />
        </div>

        {/* KPI Row */}
        {showKpis ? (
          <div className="mt-3">
            <HomesteadKpiRow
              householdId={kpiHouseholdId}
              dueSoonDays={kpiDueSoonDays}
              onNavigate={navFn}
            />
          </div>
        ) : null}

        {/* Content */}
        <div className={cx("mt-4 space-y-4", contentClassName)}>{children}</div>

        {/* Footer helper */}
        <div className="mt-8 rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-black opacity-70">
                Homestead workflow
              </div>
              <div className="mt-1 text-sm opacity-80">
                Targets drive everything: planting, preservation, animal
                strategy, inventory readiness, and skill paths.
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => navFn(`${base}/targets`)}
              >
                Edit targets
              </Button>
              <Button onClick={() => navFn(`${base}/batches?new=1`)}>
                Start batch
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Small header chip (no extra deps)
 * --------------------------------------------------------------------------- */
function HeaderChip({ children, tone = "neutral" }) {
  const cls =
    tone === "success"
      ? "border-green-200 text-green-800 bg-green-50"
      : tone === "warn"
      ? "border-amber-200 text-amber-800 bg-amber-50"
      : tone === "danger"
      ? "border-red-200 text-red-800 bg-red-50"
      : "border-gray-200 text-black bg-white";

  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-black",
        cls
      )}
    >
      {children}
    </span>
  );
}
