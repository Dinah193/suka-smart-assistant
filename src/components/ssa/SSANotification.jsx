import React, { useState } from "react";

export function SSAInlineAlert({ tone = "info", children }) {
  const toneMap = {
    info: "border-[var(--ssa-status-info)]",
    success: "border-[var(--ssa-status-success)]",
    warning: "border-[var(--ssa-status-warning)]",
    danger: "border-[var(--ssa-status-danger)]",
  };

  return (
    <div className={`ssa-hero-wrap border-l-4 p-3 text-sm ${toneMap[tone] || toneMap.info}`} role="status">
      {children}
    </div>
  );
}

export function SSAProgressBar({ value = 0, label }) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="space-y-1">
      {label ? <div className="text-xs text-[var(--ssa-text-secondary)]">{label}</div> : null}
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--ssa-surface-1)]">
        <div
          className="h-2 bg-[var(--ssa-action-primary-bg)] transition-[width] duration-300"
          style={{ width: `${safe}%` }}
          aria-valuenow={safe}
          aria-valuemin={0}
          aria-valuemax={100}
          role="progressbar"
        />
      </div>
    </div>
  );
}

export function SSACollabUpdate({ actor, action, target }) {
  return (
    <div className="ssa-hero-wrap p-3 text-sm">
      <span className="font-semibold text-[var(--ssa-text-primary)]">{actor}</span>{" "}
      <span className="text-[var(--ssa-text-secondary)]">{action}</span>{" "}
      <span className="font-semibold text-[var(--ssa-text-primary)]">{target}</span>
    </div>
  );
}

export function SSAToastHost({ initial = [] }) {
  const [items, setItems] = useState(initial);

  const dismiss = (id) => setItems((prev) => prev.filter((x) => x.id !== id));

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,640px)] -translate-x-1/2 flex-col gap-2">
      {items.map((toast) => (
        <div key={toast.id} className="ssa-hero-wrap flex items-center justify-between p-3 text-sm">
          <span>{toast.message}</span>
          <button type="button" className="ssa-hero-chip" onClick={() => dismiss(toast.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
