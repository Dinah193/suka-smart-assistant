// src/components/ui/PageHero.jsx
import React, { useMemo, useState } from "react";
import PropTypes from "prop-types";

/** tiny util to join classes safely */
function cx(...xs) {
  return xs.filter(Boolean).join(" ");
}

/**
 * PageHero
 * - Unifies hero layout across pages (Home, Meals, Cleaning, Garden, Finance, etc.)
 * - Theming via `variant`: "default" | "sacred" | "fitness" | { gradient: "...", accentClass: "..." }
 * - Emits automation intents for quick-start actions (consistent with Home page)
 *
 * Props:
 *  - breadcrumbs?: [{ label, href?, onClick? }]
 *  - title: string | ReactNode
 *  - subtitle?: string | ReactNode
 *  - badges?: string[] | ReactNodes[]
 *  - search?: { placeholder?, value?, onChange?, onSubmit? }
 *  - actions?: [{ label, icon?, intent?, detail?, onClick?, kind?: "primary"|"subtle"|"ghost", busyLabel? }]
 *  - kpis?: [{ label, value, loading? }]
 *  - illustration?: ReactNode (image, svg, etc.)
 *  - right?: ReactNode (custom right-side slot; overrides illustration/kpis on large screens)
 *  - variant?: "default" | "sacred" | "fitness" | { gradient?: string, accentClass?: string }
 *  - className?: string
 */
export default function PageHero({
  breadcrumbs = [],
  title,
  subtitle,
  badges = [],
  search,
  actions = [],
  kpis = [],
  illustration,
  right,
  variant = "default",
  className = "",
}) {
  const [busyIdx, setBusyIdx] = useState(-1);

  const theme = useMemo(() => {
    if (typeof variant === "object") {
      return {
        gradient:
          variant.gradient ||
          "linear-gradient(135deg, hsl(var(--brand-weak)) 0%, #fff 50%, hsl(var(--brand-weak)) 100%)",
        accentClass: variant.accentClass || "ring-brand-2",
      };
    }
    if (variant === "sacred") {
      return {
        gradient:
          "linear-gradient(135deg, hsl(var(--brand-weak)) 0%, #fff 55%, hsl(var(--brand-weak)) 100%)",
        accentClass: "ring-brand-2",
      };
    }
    if (variant === "fitness") {
      return {
        gradient:
          "linear-gradient(135deg, hsl(var(--accent)/.25) 0%, #fff 55%, hsl(var(--accent)/.25) 100%)",
        accentClass: "ring-brand-2",
      };
    }
    return {
      gradient:
        "linear-gradient(135deg, hsl(var(--muted)/.35) 0%, #fff 55%, hsl(var(--muted)/.35) 100%)",
      accentClass: "ring-brand-2",
    };
  }, [variant]);

  const hasSearch = !!search && (search.onChange || search.onSubmit);

  return (
    <div
      className={cx(
        "card overflow-hidden",
        "p-4 md:p-6",
        "bg-[hsl(var(--card))] border border-[hsl(var(--border))]",
        className
      )}
      style={{
        backgroundImage: theme.gradient,
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
      }}
      role="region"
      aria-label="Page hero"
    >
      {/* Top row: breadcrumbs */}
      {breadcrumbs?.length ? (
        <nav aria-label="Breadcrumb" className="mb-3">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-[hsl(var(--muted-foreground))]">
            {breadcrumbs.map((bc, i) => {
              const isLast = i === breadcrumbs.length - 1;
              const common = cx(
                "hover:underline",
                isLast ? "text-[hsl(var(--foreground))] font-semibold" : ""
              );
              const content = <span className={common}>{bc.label}</span>;
              return (
                <li key={`${bc.label}-${i}`} className="flex items-center gap-1">
                  {bc.href ? (
                    <a
                      className={common}
                      href={bc.href}
                      onClick={bc.onClick}
                      aria-current={isLast ? "page" : undefined}
                    >
                      {bc.label}
                    </a>
                  ) : bc.onClick ? (
                    <button
                      type="button"
                      className={cx("btn", "ghost")}
                      onClick={bc.onClick}
                      aria-current={isLast ? "page" : undefined}
                    >
                      {bc.label}
                    </button>
                  ) : (
                    content
                  )}
                  {!isLast && <span aria-hidden>›</span>}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}

      {/* Middle: title area */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6">
        <div className="lg:col-span-7 xl:col-span-8 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {Array.isArray(badges) &&
              badges.map((b, i) => (
                <span key={i} className="badge">
                  {b}
                </span>
              ))}
          </div>

          <div>
            <h1 className="text-2xl md:text-4xl font-extrabold leading-tight">{title}</h1>
            {subtitle ? (
              <p className="mt-1 text-[hsl(var(--muted-foreground))]">{subtitle}</p>
            ) : null}
          </div>

          {hasSearch ? (
            <HeroSearch
              placeholder={search.placeholder || "Search…"}
              value={search.value}
              onChange={search.onChange}
              onSubmit={search.onSubmit}
            />
          ) : null}

          {actions?.length ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {actions.map((a, idx) => (
                <HeroActionButton
                  key={`${a.label}-${idx}`}
                  {...a}
                  busy={busyIdx === idx}
                  onPress={async () => {
                    try {
                      if (a.onClick) {
                        setBusyIdx(idx);
                        await a.onClick();
                      } else if (a.intent) {
                        setBusyIdx(idx);
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
                          if (runtime?.emitIntent) await runtime.emitIntent(a.intent, a.detail || {});
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

        {/* Right side: KPIs / Illustration / Custom slot */}
        <div className="lg:col-span-5 xl:col-span-4">
          {right ? (
            <div className="flex flex-col gap-3">{right}</div>
          ) : illustration ? (
            <div className="flex items-center justify-center">{illustration}</div>
          ) : kpis?.length ? (
            <div className="grid grid-cols-3 gap-2 md:gap-3">
              {kpis.map((k, i) => (
                <KpiCard key={i} label={k.label} value={k.value} loading={k.loading} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- subcomponents --------------------------- */

function HeroSearch({ placeholder, value, onChange, onSubmit }) {
  const [q, setQ] = useState(value || "");
  return (
    <form
      className="flex items-stretch gap-2"
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

function HeroActionButton({ label, icon, kind = "subtle", busy, busyLabel, onPress }) {
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

function KpiCard({ label, value, loading }) {
  return (
    <div className="kpi-card">
      <div className="label">{label}</div>
      <div className={cx("value", loading ? "skeleton" : "")}>{loading ? "\u00A0" : value}</div>
    </div>
  );
}

/* -------------------------------- PropTypes ------------------------------ */
PageHero.propTypes = {
  breadcrumbs: PropTypes.arrayOf(
    PropTypes.shape({
      label: PropTypes.node.isRequired,
      href: PropTypes.string,
      onClick: PropTypes.func,
    })
  ),
  title: PropTypes.node.isRequired,
  subtitle: PropTypes.node,
  badges: PropTypes.array,
  search: PropTypes.shape({
    placeholder: PropTypes.string,
    value: PropTypes.string,
    onChange: PropTypes.func,
    onSubmit: PropTypes.func,
  }),
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
  kpis: PropTypes.arrayOf(
    PropTypes.shape({
      label: PropTypes.node.isRequired,
      value: PropTypes.node,
      loading: PropTypes.bool,
    })
  ),
  illustration: PropTypes.node,
  right: PropTypes.node,
  variant: PropTypes.oneOfType([
    PropTypes.oneOf(["default", "sacred", "fitness"]),
    PropTypes.shape({ gradient: PropTypes.string, accentClass: PropTypes.string }),
  ]),
  className: PropTypes.string,
};

/* -------------------------------- Usage notes ----------------------------
1) Quick drop-in (Home):
<PageHero
  breadcrumbs={[{ label: "Home" }]}
  title="Suka Smart Assistant"
  subtitle="Organize, automate, and beautify your household system."
  badges={["Beta", "Rhythm Aware", "Moedim Ready"]}
  actions={[
    { label: "Scan a Recipe", icon: "📷", intent: "recipes/scan", busyLabel: "Scanning…" },
    { label: "Open Meal Planner", icon: "🍽️", intent: "mealPlan/open", kind: "primary", busyLabel: "Opening…" },
    { label: "Start Batch Session", icon: "🧑🏽‍🍳", intent: "batch/start", busyLabel: "Starting…" },
    { label: "Generate Cleaning Session", icon: "🧹", intent: "cleaning/generate", busyLabel: "Generating…" },
  ]}
  kpis={[
    { label: "Meals planned", value: 8, loading: false },
    { label: "Tasks today", value: 5, loading: false },
    { label: "Low inventory", value: 3, loading: false },
  ]}
/>

2) Fitness flavor:
<PageHero variant="fitness" ... />

3) Custom gradient:
<PageHero variant={{ gradient: "linear-gradient(120deg, #d1fae5, #fff 60%, #dbeafe)" }} ... />
------------------------------------------------------------------------- */
