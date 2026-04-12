import React, { useMemo, useState } from "react";

export function SSABadge({ children, tone = "default" }) {
  const toneMap = {
    default: "text-[var(--ssa-text-secondary)]",
    request: "text-[var(--ssa-collab-request)]",
    assigned: "text-[var(--ssa-collab-assigned)]",
    complete: "text-[var(--ssa-collab-complete)]",
    blocked: "text-[var(--ssa-collab-blocked)]",
  };
  return <span className={`ssa-hero-chip ${toneMap[tone] || toneMap.default}`}>{children}</span>;
}

export function SSAProgressRing({ value = 0, size = 64, stroke = 6 }) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c - (safe / 100) * c;

  return (
    <svg width={size} height={size} role="img" aria-label={`Progress ${safe}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--ssa-surface-2)" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="var(--ssa-action-primary-bg)"
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={dash}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle" fontSize="12" fill="var(--ssa-text-primary)">
        {safe}%
      </text>
    </svg>
  );
}

export function SSASkeleton({ className = "h-4 w-full" }) {
  return (
    <div
      className={`animate-pulse rounded-[var(--ssa-radius-chip)] bg-[var(--ssa-surface-1)] ${className}`}
      style={{ backgroundImage: "var(--ssa-loading-shimmer)", backgroundSize: "200% 100%" }}
      aria-hidden="true"
    />
  );
}

export function SSAInteractiveTaskList({ tasks = [], onToggle }) {
  const [state, setState] = useState(tasks);
  const progress = useMemo(() => {
    const done = state.filter((x) => x.done).length;
    return state.length ? Math.round((done / state.length) * 100) : 0;
  }, [state]);

  return (
    <section className="ssa-hero-wrap p-4">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="ssa-hero-title text-base">Collaborative Tasks</h3>
        <SSABadge tone={progress === 100 ? "complete" : "assigned"}>{progress}%</SSABadge>
      </header>
      <ul className="space-y-2">
        {state.map((task) => (
          <li key={task.id} className="flex items-center justify-between rounded-[var(--ssa-radius-chip)] border border-[var(--ssa-border-subtle)] p-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={task.done}
                onChange={() => {
                  setState((prev) =>
                    prev.map((p) => (p.id === task.id ? { ...p, done: !p.done } : p))
                  );
                  onToggle?.(task.id);
                }}
              />
              <span className={task.done ? "line-through text-[var(--ssa-text-secondary)]" : "text-[var(--ssa-text-primary)]"}>
                {task.title}
              </span>
            </label>
            {task.household ? <SSABadge tone={task.done ? "complete" : "assigned"}>{task.household}</SSABadge> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SSAGrowthOverlay({ label = "Growth", value = 0, className = "" }) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className={`ssa-hero-wrap p-3 ${className}`.trim()}>
      <div className="mb-1 flex items-center justify-between text-xs text-[var(--ssa-text-secondary)]">
        <span>{label}</span>
        <span>{safe}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--ssa-surface-1)]">
        <div
          className="h-2 bg-[var(--ssa-status-success)] transition-[width] duration-300"
          style={{ width: `${safe}%` }}
          role="progressbar"
          aria-valuenow={safe}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} progress`}
        />
      </div>
    </div>
  );
}

export function SSASeasonalTaskHighlight({
  season = "spring",
  title,
  detail,
  urgency = "normal",
}) {
  const urgencyTone =
    urgency === "high"
      ? "border-[var(--ssa-status-danger)]"
      : urgency === "medium"
      ? "border-[var(--ssa-status-warning)]"
      : "border-[var(--ssa-border-subtle)]";

  return (
    <article className={`ssa-hero-wrap ssa-seasonal-card p-3 ${urgencyTone}`.trim()} data-ssa-season={season}>
      <h4 className="ssa-hero-title text-sm">{title}</h4>
      {detail ? <p className="ssa-hero-subtitle">{detail}</p> : null}
    </article>
  );
}

export function SSAHouseholdParticipation({
  entries = [],
  label = "Household Participation",
}) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const total = safeEntries.reduce((sum, item) => sum + Math.max(0, Number(item?.value) || 0), 0);

  return (
    <section className="ssa-hero-wrap p-3" aria-label={label}>
      <h4 className="ssa-hero-title text-sm">{label}</h4>
      <ul className="mt-2 space-y-2">
        {safeEntries.map((item, idx) => {
          const value = Math.max(0, Number(item?.value) || 0);
          const pct = total > 0 ? Math.round((value / total) * 100) : 0;
          return (
            <li key={`${item?.name || "member"}-${idx}`}>
              <div className="mb-1 flex items-center justify-between text-xs text-[var(--ssa-text-secondary)]">
                <span>{item?.name || `Member ${idx + 1}`}</span>
                <span>{pct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--ssa-surface-1)]">
                <div
                  className="h-1.5 bg-[var(--ssa-collab-assigned)] transition-[width] duration-300"
                  style={{ width: `${pct}%` }}
                  aria-hidden="true"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
