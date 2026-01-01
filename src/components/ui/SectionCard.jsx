// src/components/ui/SectionCard.jsx
import React, { useState } from "react";
import PropTypes from "prop-types";

/** Utility: class combiner */
function cx(...xs) {
  return xs.filter(Boolean).join(" ");
}

/**
 * SectionCard
 * - Consistent card UI across Home, Meals, Cleaning, Garden, Finance, etc.
 * - Supports collapse/expand, header actions, automation intents, and status badges.
 *
 * Props:
 *  - title: string | ReactNode
 *  - subtitle?: string | ReactNode
 *  - actions?: [{ label, icon?, intent?, detail?, onClick?, kind?: "primary"|"subtle"|"ghost", busyLabel? }]
 *  - badge?: string | ReactNode
 *  - collapsible?: boolean
 *  - defaultCollapsed?: boolean
 *  - children: ReactNode
 *  - footer?: ReactNode
 *  - skeleton?: boolean
 *  - className?: string
 *  - intentOnMount?: { intent: string, detail?: object }   // auto-fire on mount (optional)
 */
export default function SectionCard({
  title,
  subtitle,
  actions = [],
  badge,
  collapsible = false,
  defaultCollapsed = false,
  children,
  footer,
  skeleton = false,
  className = "",
  intentOnMount,
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [busyIdx, setBusyIdx] = useState(-1);

  React.useEffect(() => {
    if (intentOnMount?.intent) {
      window.dispatchEvent(
        new CustomEvent("automation:intent", {
          detail: { intent: intentOnMount.intent, ...(intentOnMount.detail || {}) },
        })
      );
    }
  }, [intentOnMount]);

  return (
    <section
      className={cx(
        "card flex flex-col gap-3",
        collapsible ? "cursor-pointer" : "",
        className
      )}
    >
      {/* Header */}
      <div
        className="flex items-start justify-between gap-3"
        onClick={() => {
          if (collapsible) setCollapsed((c) => !c);
        }}
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2 className="text-xl md:text-2xl font-extrabold">{title}</h2>
            {badge ? <span className="badge">{badge}</span> : null}
          </div>
          {subtitle ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">{subtitle}</p>
          ) : null}
        </div>

        {actions?.length ? (
          <div
            className="flex flex-wrap items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            {actions.map((a, idx) => (
              <ActionButton
                key={`${a.label}-${idx}`}
                {...a}
                busy={busyIdx === idx}
                onPress={async () => {
                  try {
                    setBusyIdx(idx);
                    if (a.onClick) {
                      await a.onClick();
                    } else if (a.intent) {
                      window.dispatchEvent(
                        new CustomEvent("automation:intent", {
                          detail: { intent: a.intent, ...(a.detail || {}) },
                        })
                      );
                      try {
                        const mod = await import(
                          /* @vite-ignore */ "@/services/automation/runtime"
                        ).catch(() => null);
                        const runtime = mod?.automation || mod?.default || null;
                        if (runtime?.emitIntent) {
                          await runtime.emitIntent(a.intent, a.detail || {});
                        }
                      } catch {}
                    }
                  } finally {
                    setBusyIdx(-1);
                  }
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      {/* Body */}
      {!collapsed ? (
        <div className="flex flex-col gap-3">
          {skeleton ? (
            <div className="space-y-2">
              <div className="skeleton h-5 w-1/3" />
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-4 w-5/6" />
            </div>
          ) : (
            children
          )}
        </div>
      ) : (
        <div className="text-sm text-[hsl(var(--muted-foreground))] italic">
          Section collapsed
        </div>
      )}

      {/* Footer */}
      {footer ? <div className="pt-2 border-t border-[hsl(var(--border))]">{footer}</div> : null}
    </section>
  );
}

/* -------------------------------- Subcomponents -------------------------- */
function ActionButton({ label, icon, kind = "subtle", busy, busyLabel, onPress }) {
  const classMap = {
    primary: "btn primary",
    subtle: "btn subtle",
    ghost: "btn",
  };
  return (
    <button
      type="button"
      className={classMap[kind] || classMap.subtle}
      aria-busy={busy ? "true" : "false"}
      onMouseDown={(e) => e.currentTarget.classList.add("is-pressed")}
      onMouseUp={(e) => e.currentTarget.classList.remove("is-pressed")}
      onClick={onPress}
    >
      {icon ? <span aria-hidden>{icon}</span> : null}
      <span className="label">{busy && busyLabel ? busyLabel : label}</span>
    </button>
  );
}

/* -------------------------------- PropTypes ------------------------------ */
SectionCard.propTypes = {
  title: PropTypes.node.isRequired,
  subtitle: PropTypes.node,
  actions: PropTypes.arrayOf(
    PropTypes.shape({
      label: PropTypes.node.isRequired,
      icon: PropTypes.node,
      intent: PropTypes.string,
      detail: PropTypes.object,
      onClick: PropTypes.func,
      kind: PropTypes.oneOf(["primary", "subtle", "ghost"]),
      busyLabel: PropTypes.string,
    })
  ),
  badge: PropTypes.node,
  collapsible: PropTypes.bool,
  defaultCollapsed: PropTypes.bool,
  children: PropTypes.node,
  footer: PropTypes.node,
  skeleton: PropTypes.bool,
  className: PropTypes.string,
  intentOnMount: PropTypes.shape({
    intent: PropTypes.string.isRequired,
    detail: PropTypes.object,
  }),
};

/* -------------------------------- Usage Examples -------------------------
1) Basic section:
<SectionCard title="Recipe Consolidator" subtitle="Normalize your recipes.">
  <RecipeConsolidatorCard />
</SectionCard>

2) Collapsible with status badge + automation action:
<SectionCard
  title="Meal Planner"
  subtitle="Plan by rhythm, macros, or feast cycles."
  badge="Beta"
  collapsible
  actions={[
    { label: "Open Planner", icon: "🍽️", intent: "mealPlan/open", kind: "primary", busyLabel: "Opening…" },
    { label: "Suggest Rhythm", icon: "⏱️", intent: "mealPlan/rhythm/suggest", busyLabel: "Suggesting…" },
  ]}
>
  <MealPlannerDashboard />
</SectionCard>

3) Skeleton state:
<SectionCard title="Inventory Status" skeleton />
--------------------------------------------------------------------------- */
