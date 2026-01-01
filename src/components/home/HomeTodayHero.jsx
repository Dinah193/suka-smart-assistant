// src/components/home/HomeTodayHero.jsx
import React, { useMemo } from "react";
import { HOME_COPY } from "@/copy/home.copy";

/**
 * HomeTodayHero
 * - Homey “Your Household Today” hero
 * - Greeting (auto by time) + optional override
 * - Primary CTA (Quick Add)
 * - Secondary action row (pills/buttons)
 *
 * Styling:
 * - Uses bridge.scan.css classes: card, btn, btn--ghost, btn-bar, chip, etc.
 *
 * Props:
 * - householdName?: string
 * - title?: string
 * - subtitle?: string
 * - greeting?: string | null   // if null, auto
 * - primaryCtaLabel?: string
 * - onPrimaryCta: () => void
 * - secondaryActions?: Array<{
 *     label: string,
 *     onClick: () => void,
 *     variant?: "ghost"|"primary"|"accent"|"warn"|"ok"|"info",
 *     disabled?: boolean,
 *     title?: string
 *   }>
 * - rightSlot?: ReactNode (optional)
 * - tone?: "default"|"alt"|"brand"
 * - compact?: boolean  // ✅ reduces white space above the fold
 */
export default function HomeTodayHero({
  householdName,
  title = HOME_COPY?.hero?.title || "Your Household Today",
  subtitle = HOME_COPY?.hero?.subtitle || "",
  greeting = null,
  primaryCtaLabel = HOME_COPY?.hero?.primaryCta || "Quick Add",
  onPrimaryCta,
  secondaryActions = [],
  rightSlot = null,
  tone = "alt",
  compact = true,
}) {
  const computedGreeting = useMemo(() => {
    if (typeof greeting === "string") return greeting;
    try {
      const h = new Date().getHours();
      if (h < 12) return "Good morning";
      if (h < 17) return "Good afternoon";
      return "Good evening";
    } catch {
      return "Welcome";
    }
  }, [greeting]);

  const cardToneClass =
    tone === "brand"
      ? "card card-brand"
      : tone === "alt"
      ? "card card-alt"
      : "card";

  const readyChip = HOME_COPY?.hero?.chips?.ready || "Ready for today";
  const focusTitle = HOME_COPY?.hero?.chips?.focus || "Today’s focus";

  const titleCls = compact
    ? "mt-2 text-xl md:text-2xl font-extrabold leading-tight"
    : "mt-2 text-2xl md:text-3xl font-extrabold leading-tight";

  const subCls = compact
    ? "mt-1 text-sm text-[hsl(var(--text-subtle))] max-w-2xl"
    : "mt-1 text-sm md:text-base text-[hsl(var(--text-subtle))] max-w-2xl";

  const actionGap = compact ? "mt-2" : "mt-3";

  return (
    <section className={cardToneClass} data-home-section="hero">
      <div className="flex flex-col lg:flex-row lg:items-start gap-3">
        {/* Left: Greeting + Title */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip chip--brand">
              <span className="dot" aria-hidden />
              {computedGreeting}
              {householdName ? `, ${householdName}` : ""}
            </span>

            <span className="chip" title={focusTitle}>
              {readyChip}
            </span>
          </div>

          <h1 className={titleCls}>{title}</h1>

          {subtitle ? <p className={subCls}>{subtitle}</p> : null}

          {/* Actions */}
          <div className={`btn-bar ${actionGap}`}>
            <button type="button" className="btn" onClick={onPrimaryCta}>
              {primaryCtaLabel}
            </button>

            {secondaryActions.map((a, idx) => {
              const v = a?.variant || "ghost";

              // ✅ default secondary actions to compact size (better above-the-fold)
              const base = compact ? "btn btn--sm" : "btn";

              const cls =
                v === "primary"
                  ? `${base} btn--primary`
                  : v === "accent"
                  ? `${base} btn--accent`
                  : v === "warn"
                  ? `${base} btn--warn`
                  : v === "ok"
                  ? `${base} btn--ok`
                  : v === "info"
                  ? `${base} btn--info`
                  : `${base} btn--ghost`;

              return (
                <button
                  key={`${a.label}-${idx}`}
                  type="button"
                  className={cls}
                  onClick={a.onClick}
                  disabled={!!a.disabled}
                  title={a.title || a.label}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: optional slot (mini status, upcoming, etc.) */}
        {rightSlot ? (
          <div className="w-full lg:w-[360px]">{rightSlot}</div>
        ) : null}
      </div>
    </section>
  );
}
