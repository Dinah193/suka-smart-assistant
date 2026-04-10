import React, { useState } from "react";

export function SSAHeader({ brand, actions }) {
  return (
    <header className="ssa-hero-wrap flex items-center justify-between gap-3 p-3">
      <div className="ssa-hero-title text-lg">{brand}</div>
      <div className="ssa-hero-actions">{actions}</div>
    </header>
  );
}

export function SSASidebar({ items = [], activeKey, onSelect }) {
  return (
    <nav aria-label="Sidebar" className="ssa-hero-wrap p-2">
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => onSelect?.(item.key)}
              className={`w-full rounded-[var(--ssa-radius-chip)] px-3 py-2 text-left text-sm ${
                activeKey === item.key
                  ? "bg-[var(--ssa-surface-1)] text-[var(--ssa-text-primary)]"
                  : "text-[var(--ssa-text-secondary)] hover:bg-[var(--ssa-surface-1)]"
              }`}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SSATabs({ tabs = [], activeKey, onChange }) {
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.key === activeKey)
  );

  const handleKeyDown = (event) => {
    if (!tabs.length) return;

    if (event.key === "ArrowRight") {
      event.preventDefault();
      const nextIndex = (activeIndex + 1) % tabs.length;
      onChange?.(tabs[nextIndex]?.key);
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const prevIndex = (activeIndex - 1 + tabs.length) % tabs.length;
      onChange?.(tabs[prevIndex]?.key);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      onChange?.(tabs[0]?.key);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      onChange?.(tabs[tabs.length - 1]?.key);
    }
  };

  return (
    <div role="tablist" className="ssa-hero-actions border-b border-[var(--ssa-border-default)] pb-2">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={activeKey === tab.key}
          tabIndex={activeKey === tab.key ? 0 : -1}
          onClick={() => onChange?.(tab.key)}
          onKeyDown={handleKeyDown}
          className={`rounded-[var(--ssa-radius-chip)] px-3 py-1.5 text-sm ${
            activeKey === tab.key
              ? "bg-[var(--ssa-action-primary-bg)] text-[var(--ssa-action-primary-fg)]"
              : "text-[var(--ssa-text-secondary)] hover:bg-[var(--ssa-surface-1)]"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function SSABreadcrumbs({ items = [] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="ssa-hero-actions text-xs text-[var(--ssa-text-secondary)]">
        {items.map((item, idx) => (
          <li key={`${item.label}-${idx}`} className="inline-flex items-center gap-2">
            {idx > 0 ? <span aria-hidden>/</span> : null}
            {item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function SSADropdown({ label, items = [] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button type="button" className="ssa-hero-chip" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        {label}
      </button>
      {open ? (
        <ul className="absolute right-0 z-30 mt-2 min-w-40 rounded-[var(--ssa-radius-chip)] border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-elevated)] p-1 shadow-[var(--ssa-shadow-2)]">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
                className="w-full rounded-[var(--ssa-radius-chip)] px-2 py-1.5 text-left text-sm hover:bg-[var(--ssa-surface-1)]"
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SSALayout({ header, sidebar, children }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside>{sidebar}</aside>
      <div className="space-y-4">
        {header}
        <main>{children}</main>
      </div>
    </div>
  );
}
