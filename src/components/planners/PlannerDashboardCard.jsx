import React from "react";

export default function PlannerDashboardCard({
  title,
  subtitle,
  score,
  chips = [],
  children,
}) {
  return (
    <section className="rounded-xl border border-emerald-200 bg-white p-4 shadow-sm">
      <header className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-emerald-900">{title}</h3>
          {subtitle ? <p className="text-sm text-emerald-700">{subtitle}</p> : null}
        </div>
        {typeof score === "number" ? (
          <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
            Score {score.toFixed(2)}
          </span>
        ) : null}
      </header>

      {chips.length ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <span
              key={chip}
              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800"
            >
              {chip}
            </span>
          ))}
        </div>
      ) : null}

      <div>{children}</div>
    </section>
  );
}
