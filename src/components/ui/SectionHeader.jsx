// src/components/ui/SectionHeader.jsx
import React, { useEffect, useId, useMemo, useState } from "react";
import PropTypes from "prop-types";

/* ------------------------------- utilities ------------------------------- */
function cx(...xs) {
  return xs.filter(Boolean).join(" ");
}

/* Button that supports "primary" | "subtle" | "ghost" + busy state + automation intents */
function ActionButton({ label, icon, kind = "subtle", busy, busyLabel, onClick, intent, detail }) {
  const classMap = { primary: "btn primary", subtle: "btn subtle", ghost: "btn" };
  return (
    <button
      type="button"
      className={classMap[kind] || classMap.subtle}
      aria-busy={busy ? "true" : "false"}
      onMouseDown={(e) => e.currentTarget.classList.add("is-pressed")}
      onMouseUp={(e) => e.currentTarget.classList.remove("is-pressed")}
      onClick={async () => {
        if (onClick) return onClick();
        if (intent) {
          // Broadcast to the app
          window.dispatchEvent(new CustomEvent("automation:intent", { detail: { intent, ...(detail || {}) } }));
          // Try runtime if available (defensive)
          try {
            const mod = await import(/* @vite-ignore */ "@/services/automation/runtime").catch(() => null);
            const runtime = mod?.automation || mod?.default || null;
            if (runtime?.emitIntent) await runtime.emitIntent(intent, detail || {});
          } catch {}
        }
      }}
    >
      {icon ? <span aria-hidden>{icon}</span> : null}
      <span className="label">{busy && busyLabel ? busyLabel : label}</span>
    </button>
  );
}

ActionButton.propTypes = {
  label: PropTypes.node.isRequired,
  icon: PropTypes.node,
  kind: PropTypes.oneOf(["primary", "subtle", "ghost"]),
  busy: PropTypes.bool,
  busyLabel: PropTypes.string,
  onClick: PropTypes.func,
  intent: PropTypes.string,
  detail: PropTypes.object,
};

/* ------------------------------ Tabs control ----------------------------- */
function Tabs({ tabs = [], active, onChange, className = "" }) {
  const [indicatorStyle, setIndicatorStyle] = useState({});
  const tabIds = useMemo(() => tabs.map((_, i) => `tab-${i}-${Math.random().toString(36).slice(2, 7)}`), [tabs]);

  useEffect(() => {
    const idx = Math.max(0, tabs.findIndex((t) => (t.value ?? t.label) === active));
    const el = document.getElementById(tabIds[idx]);
    if (!el) return;
    const { offsetLeft, offsetWidth } = el;
    setIndicatorStyle({ transform: `translateX(${offsetLeft}px)`, width: `${offsetWidth}px` });
  }, [active, tabs, tabIds]);

  return (
    <div className={cx("relative", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--border))]">
        {tabs.map((t, i) => {
          const isActive = (t.value ?? t.label) === active;
          return (
            <button
              id={tabIds[i]}
              key={`${t.label}-${i}`}
              type="button"
              className={cx(
                "px-2.5 py-1.5 text-sm font-semibold rounded-md",
                isActive ? "text-[hsl(var(--foreground))]" : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              )}
              aria-selected={isActive}
              role="tab"
              onClick={() => onChange?.(t.value ?? t.label)}
              title={typeof t.tooltip === "string" ? t.tooltip : undefined}
            >
              <span className="inline-flex items-center gap-1">
                {t.icon ? <span aria-hidden>{t.icon}</span> : null}
                <span>{t.label}</span>
                {typeof t.count === "number" ? (
                  <span className="pill">{t.count}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {/* underline indicator */}
      <div
        className="absolute bottom-[-1px] h-[2px] bg-[hsl(var(--brand))] rounded-full transition-transform duration-200"
        style={indicatorStyle}
        aria-hidden
      />
    </div>
  );
}

Tabs.propTypes = {
  tabs: PropTypes.arrayOf(
    PropTypes.shape({
      label: PropTypes.node.isRequired,
      value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
      icon: PropTypes.node,
      tooltip: PropTypes.string,
      count: PropTypes.number,
    })
  ),
  active: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func,
  className: PropTypes.string,
};

/* ---------------------------- SectionHeader main ------------------------- */
/**
 * SectionHeader
 * A compact, reusable header bar for sections & dashboards.
 *
 * Props:
 *  - title (node, required)
 *  - subtitle? (node)
 *  - badge? (node)                 // status chip (e.g., "Beta", "Synced")
 *  - count? (number|string)        // optional count bubble
 *  - actions? (ActionButton props[])
 *  - tabs? (Tabs props)
 *  - search?: { value, onChange(q), onSubmit(q), placeholder? }
 *  - filterSlot?: ReactNode        // custom filter controls right of search
 *  - rightSlot?: ReactNode         // absolute right-side custom area
 *  - collapsible?: boolean
 *  - collapsed?: boolean           // controlled
 *  - defaultCollapsed?: boolean    // uncontrolled
 *  - onToggleCollapse?: (next: boolean) => void
 *  - controlsId?: string           // aria-controls id for the collapsible content container
 *  - className?: string
 *  - intentOnMount?: { intent, detail? }
 */
export default function SectionHeader({
  title,
  subtitle,
  badge,
  count,
  actions = [],
  tabs,
  search,
  filterSlot,
  rightSlot,
  collapsible = false,
  collapsed: collapsedProp,
  defaultCollapsed = false,
  onToggleCollapse,
  controlsId,
  className = "",
  intentOnMount,
}) {
  const uncontrolled = collapsedProp === undefined;
  const [collapsedState, setCollapsedState] = useState(defaultCollapsed);
  const collapsed = uncontrolled ? collapsedState : !!collapsedProp;
  const headingId = useId();

  useEffect(() => {
    if (intentOnMount?.intent) {
      window.dispatchEvent(new CustomEvent("automation:intent", { detail: { intent: intentOnMount.intent, ...(intentOnMount.detail || {}) } }));
    }
  }, [intentOnMount]);

  const [busyIdx, setBusyIdx] = useState(-1);

  const handleToggle = () => {
    const next = !collapsed;
    if (uncontrolled) setCollapsedState(next);
    onToggleCollapse?.(next);
  };

  return (
    <header
      className={cx(
        "w-full",
        "bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-[var(--radius)]",
        "px-4 py-3 md:px-5 md:py-4",
        "shadow-card",
        className
      )}
      role="region"
      aria-labelledby={headingId}
    >
      {/* Top row: title + actions */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {collapsible ? (
                <button
                  type="button"
                  className="btn icon"
                  aria-label={collapsed ? "Expand section" : "Collapse section"}
                  aria-controls={controlsId}
                  aria-expanded={!collapsed}
                  onClick={handleToggle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleToggle();
                    }
                  }}
                  title={collapsed ? "Expand" : "Collapse"}
                >
                  {collapsed ? "▸" : "▾"}
                </button>
              ) : null}

              <h2 id={headingId} className="text-xl md:text-2xl font-extrabold truncate">
                {title}
              </h2>

              {typeof count !== "undefined" ? (
                <span className="pill">{count}</span>
              ) : null}

              {badge ? <span className="badge">{badge}</span> : null}
            </div>

            {subtitle ? (
              <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">{subtitle}</p>
            ) : null}
          </div>

          {/* Actions + rightSlot */}
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {actions?.map((a, idx) => (
              <ActionButton
                key={`${a.label}-${idx}`}
                {...a}
                busy={busyIdx === idx}
                onClick={
                  a.onClick
                    ? async () => {
                        try {
                          setBusyIdx(idx);
                          await a.onClick();
                        } finally {
                          setBusyIdx(-1);
                        }
                      }
                    : undefined
                }
              />
            ))}
            {rightSlot ? rightSlot : null}
          </div>
        </div>

        {/* Tabs */}
        {tabs?.tabs?.length ? (
          <Tabs tabs={tabs.tabs} active={tabs.active} onChange={tabs.onChange} className="mt-1" />
        ) : null}

        {/* Search + filters row */}
        {(search?.onChange || search?.onSubmit || filterSlot) && (
          <div className="flex items-stretch gap-2 pt-1">
            {search ? <SearchBar {...search} /> : null}
            {filterSlot ? <div className="flex items-center gap-2">{filterSlot}</div> : null}
          </div>
        )}
      </div>
    </header>
  );
}

SectionHeader.propTypes = {
  title: PropTypes.node.isRequired,
  subtitle: PropTypes.node,
  badge: PropTypes.node,
  count: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  actions: PropTypes.arrayOf(
    PropTypes.shape({
      label: PropTypes.node.isRequired,
      icon: PropTypes.node,
      kind: PropTypes.oneOf(["primary", "subtle", "ghost"]),
      busyLabel: PropTypes.string,
      onClick: PropTypes.func,
      intent: PropTypes.string,
      detail: PropTypes.object,
    })
  ),
  tabs: PropTypes.shape({
    tabs: PropTypes.array,
    active: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    onChange: PropTypes.func,
  }),
  search: PropTypes.shape({
    value: PropTypes.string,
    onChange: PropTypes.func,
    onSubmit: PropTypes.func,
    placeholder: PropTypes.string,
  }),
  filterSlot: PropTypes.node,
  rightSlot: PropTypes.node,
  collapsible: PropTypes.bool,
  collapsed: PropTypes.bool,
  defaultCollapsed: PropTypes.bool,
  onToggleCollapse: PropTypes.func,
  controlsId: PropTypes.string,
  className: PropTypes.string,
  intentOnMount: PropTypes.shape({
    intent: PropTypes.string.isRequired,
    detail: PropTypes.object,
  }),
};

/* ----------------------------- Search component -------------------------- */
function SearchBar({ value, onChange, onSubmit, placeholder = "Search…" }) {
  const [q, setQ] = useState(value || "");
  return (
    <form
      className="flex items-stretch gap-2 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.(q);
      }}
    >
      <div className="relative flex-1">
        <input
          className="control w-full pr-9"
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            onChange?.(e.target.value);
          }}
          aria-label="Search"
        />
        <span
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]"
          aria-hidden
        >
          🔎
        </span>
      </div>
      <button className="btn primary" type="submit">
        Search
      </button>
    </form>
  );
}

SearchBar.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func,
  onSubmit: PropTypes.func,
  placeholder: PropTypes.string,
};

/* -------------------------------- Usage Examples --------------------------
1) Minimal:
<SectionHeader title="Inventory" count={12} />

2) Collapsible + actions + search:
<SectionHeader
  title="Meal Planner"
  subtitle="Rhythm-aware (16:8, 36h ADF, weekday flex)."
  badge="Beta"
  collapsible
  defaultCollapsed={false}
  controlsId="meal-planner-content"
  actions={[
    { label: "Open Planner", icon: "🍽️", intent: "mealPlan/open", kind: "primary", busyLabel: "Opening…" },
    { label: "Suggest Rhythm", icon: "⏱️", intent: "mealPlan/rhythm/suggest", busyLabel: "Suggesting…" },
  ]}
  search={{ onSubmit: (q)=>console.log("search", q) }}
/>

3) Tabs + filters:
<SectionHeader
  title="Garden"
  subtitle="Seasonal planting, soil & water health."
  tabs={{
    tabs: [
      { label: "Overview", value: "overview" },
      { label: "Plantings", value: "plantings", count: 8 },
      { label: "Irrigation", value: "irrigation" },
    ],
    active: activeTab,
    onChange: setActiveTab
  }}
  filterSlot={<>
    <select className="control control--select" onChange={(e)=>setZone(e.target.value)}>
      <option value="">All Zones</option>
      <option>Front Beds</option>
      <option>Back Garden</option>
    </select>
    <button className="btn">Export</button>
  </>}
/>
--------------------------------------------------------------------------- */
