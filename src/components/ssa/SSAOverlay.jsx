import React, { useState } from "react";

export function SSAModal({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="ssa-hero-wrap w-full max-w-xl p-4">
        <header className="flex items-center justify-between">
          <h3 className="ssa-hero-title text-lg">{title}</h3>
          <button type="button" className="ssa-hero-chip" onClick={onClose}>Close</button>
        </header>
        <div className="mt-3">{children}</div>
        {footer ? <footer className="mt-3 ssa-hero-actions">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function SSADrawer({ open, side = "right", title, onClose, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <aside
        className={`absolute top-0 h-full w-full max-w-md bg-[var(--ssa-surface-elevated)] p-4 shadow-[var(--ssa-shadow-3)] ${
          side === "left" ? "left-0" : "right-0"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <h3 className="ssa-hero-title text-lg">{title}</h3>
          <button type="button" className="ssa-hero-chip" onClick={onClose}>Close</button>
        </header>
        <div className="mt-3">{children}</div>
      </aside>
    </div>
  );
}

export function SSAPopover({ trigger, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button type="button" onClick={() => setOpen((x) => !x)}>{trigger}</button>
      {open ? (
        <div className="absolute z-30 mt-2 w-64 rounded-[var(--ssa-radius-chip)] border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-elevated)] p-3 shadow-[var(--ssa-shadow-2)]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function SSAAccordion({ items = [] }) {
  const [active, setActive] = useState(null);
  return (
    <div className="space-y-2">
      {items.map((item) => {
        const open = active === item.key;
        return (
          <section key={item.key} className="ssa-hero-wrap p-3">
            <button
              type="button"
              onClick={() => setActive(open ? null : item.key)}
              className="flex w-full items-center justify-between text-left"
              aria-expanded={open}
            >
              <span className="ssa-hero-title text-base">{item.title}</span>
              <span className="ssa-hero-chip">{open ? "Hide" : "Show"}</span>
            </button>
            {open ? <div className="mt-2 text-sm text-[var(--ssa-text-primary)]">{item.content}</div> : null}
          </section>
        );
      })}
    </div>
  );
}
