// src/components/home/KpiRow.jsx
import React, { useMemo } from "react";
import { UtensilsCrossed, Sparkles, Flame, Leaf, PawPrint } from "lucide-react";

/**
 * KpiRow
 * - Owns KPI layout + icon + click behavior
 * - Keeps KPI “row” consistent and reusable later
 *
 * Props:
 * - items?: Array<{
 *     key: string,
 *     label: string,
 *     value: number|string,
 *     loading?: boolean,
 *     onClick?: () => void,
 *     title?: string,
 *     icon?: ReactNode,
 *     active?: boolean
 *   }>
 * - loading?: boolean (global)
 * - variant?: "grid" | "row"   // row becomes horizontal scroll on small screens
 * - dense?: boolean
 */
export default function KpiRow({
  items = [],
  loading = false,
  variant = "grid",
  dense = false,
}) {
  const layoutClass = useMemo(() => {
    if (variant === "row") {
      // horizontally scrollable “row” on small screens, grid on larger
      return "flex gap-3 overflow-x-auto pb-1 md:grid md:grid-cols-3 xl:grid-cols-5 md:overflow-visible";
    }
    // default grid
    return "grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 md:gap-4";
  }, [variant]);

  const pad = dense ? "p-3" : "p-4";

  return (
    <div className={layoutClass} data-home-section="kpis">
      {items.map((k) => (
        <KpiCard
          key={k.key}
          label={k.label}
          value={k.value}
          loading={loading || !!k.loading}
          onClick={k.onClick}
          title={k.title}
          icon={k.icon}
          active={!!k.active}
          pad={pad}
        />
      ))}
    </div>
  );
}

function KpiCard({ label, value, loading, onClick, title, icon, active, pad }) {
  const Tag = onClick ? "button" : "div";
  const interactive = !!onClick;

  // Uses your bridge.scan.css card styles, plus optional KPI helpers you’ll add (.kpi-card, .kpi-card--active, .kpi-icon)
  const cls = [
    "card",
    "kpi-card",
    pad,
    interactive ? "cursor-pointer card--hover" : "",
    active ? "kpi-card--active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag
      type={interactive ? "button" : undefined}
      onClick={onClick}
      title={title || (interactive ? `Open ${label}` : undefined)}
      className={cls}
      style={{
        minHeight: 92,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        textAlign: "left",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-[hsl(var(--text-subtle))]">{label}</div>
        {icon ? (
          <span className="kpi-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
      </div>

      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          loading ? "skeleton" : ""
        }`}
      >
        {loading ? "\u00A0" : value}
      </div>
    </Tag>
  );
}

/**
 * Optional helper to quickly build default KPI definitions.
 * You can import { defaultHomeKpis } into home.jsx if you want.
 */
export function defaultHomeKpis({
  kpis,
  kpiLoading,
  startMealPlanning,
  startCleaning,
  openCookingSchedule,
  openGarden,
  openAnimals,
}) {
  return [
    {
      key: "mealsThisWeek",
      label: "Meals planned",
      value: kpis?.mealsThisWeek ?? 0,
      loading: kpiLoading,
      onClick: startMealPlanning,
      title: "Go to Meal Planning",
      icon: <UtensilsCrossed size={16} />,
    },
    {
      key: "tasksToday",
      label: "Today's cleaning",
      value: kpis?.tasksToday ?? 0,
      loading: kpiLoading,
      onClick: startCleaning,
      title: "Go to Cleaning",
      icon: <Sparkles size={16} />,
    },
    {
      key: "sessionsThisWeek",
      label: "Cooking sessions",
      value: kpis?.sessionsThisWeek ?? 0,
      loading: kpiLoading,
      onClick: openCookingSchedule,
      title: "Go to Cooking Schedule",
      icon: <Flame size={16} />,
    },
    {
      key: "gardenTasksThisWeek",
      label: "Garden tasks",
      value: kpis?.gardenTasksThisWeek ?? 0,
      loading: kpiLoading,
      onClick: openGarden,
      title: "Go to Garden",
      icon: <Leaf size={16} />,
    },
    {
      key: "animalTasksThisWeek",
      label: "Animal tasks",
      value: kpis?.animalTasksThisWeek ?? 0,
      loading: kpiLoading,
      onClick: openAnimals,
      title: "Go to Animals",
      icon: <PawPrint size={16} />,
    },
  ];
}
