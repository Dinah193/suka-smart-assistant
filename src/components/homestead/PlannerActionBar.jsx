// C:\Users\larho\suka-smart-assistant\src\components\homestead\PlannerActionBar.jsx
/* eslint-disable react/prop-types */
/**
 * SSA • PlannerActionBar
 * -----------------------------------------------------------------------------
 * Primary/secondary action buttons aligned with other domains.
 *
 * Goals
 *  - Consistent “SSA card toolbar” look: rounded, bordered, subtle shadow
 *  - Primary + secondary actions with optional tertiary actions
 *  - Left content (title/subtitle/filters) + right actions
 *  - Responsive: stacks on small screens, inline on larger screens
 *  - Optional sticky mode for long pages
 *  - Supports SPA navigation via onNavigate(to) OR href fallback
 *
 * Usage
 *  <PlannerActionBar
 *    title="Homestead Planner"
 *    subtitle="Targets → inventory → preservation batches"
 *    primary={{ label:"Add target", to:"/homesteadplanner/targets?new=1" }}
 *    secondary={{ label:"Browse catalog", to:"/homesteadplanner/components" }}
 *    tertiary={[
 *      { label:"Refresh", onClick: refresh },
 *      { label:"Export", onClick: exportIt, tone:"ghost" }
 *    ]}
 *    rightSlot={<Badge>v1</Badge>}
 *    onNavigate={(to)=>navigate(to)}
 *    sticky
 *  />
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function Icon({ name }) {
  // Minimal symbols; avoids icon deps build failures.
  const map = {
    plus: "+",
    refresh: "↻",
    export: "⇪",
    play: "▶",
    arrow: "→",
    gear: "⚙",
    check: "✓",
    dots: "⋯",
  };
  return <span aria-hidden="true">{map[name] || "•"}</span>;
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function runNav(to, onNavigate) {
  if (!to) return;
  if (onNavigate) return onNavigate(to);
  try {
    window.location.href = to;
  } catch (e) {}
}

function Button({
  label,
  title,
  onClick,
  href,
  disabled,
  icon,
  tone = "primary", // primary | secondary | ghost | danger
  size = "md", // sm | md
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl border font-black transition select-none";
  const pad = size === "sm" ? "px-3 py-2 text-xs" : "px-4 py-2 text-sm";

  const cls =
    tone === "primary"
      ? "bg-black text-white border-black hover:opacity-90"
      : tone === "danger"
      ? "bg-red-600 text-white border-red-600 hover:opacity-90"
      : tone === "ghost"
      ? "bg-transparent text-black border-transparent hover:bg-gray-50"
      : "bg-white text-black border-gray-200 hover:bg-gray-50";

  const content = (
    <>
      {icon ? <Icon name={icon} /> : null}
      <span className="truncate">{label}</span>
    </>
  );

  if (href) {
    return (
      <a
        className={cx(
          base,
          pad,
          cls,
          disabled ? "pointer-events-none opacity-60" : ""
        )}
        title={title}
        href={href}
        onClick={onClick}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cx(
        base,
        pad,
        cls,
        disabled ? "opacity-60 cursor-not-allowed" : ""
      )}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {content}
    </button>
  );
}

function Badge({ children, tone = "neutral" }) {
  const cls =
    tone === "success"
      ? "border-green-200 text-green-800 bg-green-50"
      : tone === "warn"
      ? "border-amber-200 text-amber-800 bg-amber-50"
      : tone === "danger"
      ? "border-red-200 text-red-800 bg-red-50"
      : "border-gray-200 text-black bg-white";
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-black",
        cls
      )}
    >
      {children}
    </span>
  );
}

/**
 * Optional overflow menu for many tertiary actions
 */
function OverflowMenu({ actions = [], onNavigate }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onDoc = (e) => {
      if (!e?.target?.closest?.("[data-ssabar-overflow]")) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (!actions.length) return null;

  return (
    <div className="relative" data-ssabar-overflow>
      <Button
        label="More"
        icon="dots"
        tone="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title="More actions"
      />
      {open ? (
        <div className="absolute right-0 mt-2 w-56 rounded-2xl border border-gray-200 bg-white shadow-lg p-2 z-50">
          <div className="text-[11px] font-black opacity-70 px-2 py-2">
            More actions
          </div>
          <div className="space-y-1">
            {actions.map((a, idx) => {
              const label = safeStr(a?.label) || `Action ${idx + 1}`;
              const tone = a?.tone || "ghost";
              const disabled = !!a?.disabled;

              return (
                <button
                  key={a?.key || `${label}-${idx}`}
                  type="button"
                  className={cx(
                    "w-full text-left rounded-xl px-3 py-2 text-sm font-bold border transition",
                    tone === "danger"
                      ? "border-red-200 text-red-700 hover:bg-red-50"
                      : "border-transparent text-black hover:bg-gray-50",
                    disabled ? "opacity-60 cursor-not-allowed" : ""
                  )}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    setOpen(false);
                    if (a?.onClick) return a.onClick();
                    if (a?.to) return runNav(a.to, onNavigate);
                  }}
                  title={a?.title}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{label}</span>
                    {a?.icon ? (
                      <span className="opacity-70">
                        <Icon name={a.icon} />
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * PlannerActionBar
 */
export default function PlannerActionBar({
  className = "",
  title,
  subtitle,
  leftSlot = null, // custom node under title/subtitle
  rightSlot = null, // custom node near actions

  primary = null, // { label, to?, onClick?, icon?, title?, disabled? }
  secondary = null, // { ... }
  tertiary = [], // array of actions; auto-overflows if > maxInlineTertiary

  onNavigate = null, // (to) => void

  sticky = false,
  dense = false,
  maxInlineTertiary = 2,

  // Status chips
  status = null, // string
  statusTone = "neutral",
  metaBadges = [], // [{ text, tone }]
}) {
  const wrapPad = dense ? "px-4 py-3" : "px-4 py-4";

  const inlineTertiary = useMemo(() => {
    const arr = Array.isArray(tertiary) ? tertiary.filter(Boolean) : [];
    return arr.slice(0, Math.max(0, maxInlineTertiary));
  }, [tertiary, maxInlineTertiary]);

  const overflowTertiary = useMemo(() => {
    const arr = Array.isArray(tertiary) ? tertiary.filter(Boolean) : [];
    return arr.slice(Math.max(0, maxInlineTertiary));
  }, [tertiary, maxInlineTertiary]);

  // Sticky shadow boost when scrolled (nice affordance)
  const stickyRef = useRef(null);
  const [raised, setRaised] = useState(false);

  useEffect(() => {
    if (!sticky) return;
    const onScroll = () => setRaised((window.scrollY || 0) > 6);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [sticky]);

  const shellClass = cx(
    "rounded-2xl border border-gray-200 bg-white",
    raised ? "shadow-md" : "shadow-sm",
    sticky ? "sticky top-0 z-40" : "",
    className
  );

  const hasHeaderText = !!(title || subtitle);

  const actionToProps = (a, fallbackTone) => {
    if (!a) return null;
    const label = safeStr(a.label);
    const icon = a.icon || null;
    const titleAttr = a.title || label;
    const disabled = !!a.disabled;
    const tone = a.tone || fallbackTone;

    const click = (e) => {
      if (disabled) return;
      if (a.onClick) return a.onClick(e);
      if (a.to) return runNav(a.to, onNavigate);
    };

    // If we don't have onNavigate, use href for accessibility + standard browser behavior
    const href = !onNavigate && a.to ? a.to : null;

    return {
      label,
      icon,
      title: titleAttr,
      disabled,
      tone,
      onClick: click,
      href,
    };
  };

  const p = actionToProps(primary, "primary");
  const s = actionToProps(secondary, "secondary");

  return (
    <div className={shellClass} ref={stickyRef}>
      <div
        className={cx(
          wrapPad,
          "flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
        )}
      >
        <div className="min-w-0">
          {hasHeaderText ? (
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {title ? (
                  <div className="text-sm font-black truncate">{title}</div>
                ) : null}
                {status ? <Badge tone={statusTone}>{status}</Badge> : null}
                {Array.isArray(metaBadges) && metaBadges.length
                  ? metaBadges.slice(0, 4).map((b, i) => (
                      <Badge key={i} tone={b?.tone || "neutral"}>
                        {b?.text || ""}
                      </Badge>
                    ))
                  : null}
              </div>
              {subtitle ? (
                <div className="mt-1 text-xs opacity-70">{subtitle}</div>
              ) : null}
            </div>
          ) : null}

          {leftSlot ? (
            <div className={cx(hasHeaderText ? "mt-2" : "")}>{leftSlot}</div>
          ) : null}
        </div>

        <div className="shrink-0 flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-end">
          {/* Inline tertiary */}
          {inlineTertiary.map((a, idx) => {
            const ap = actionToProps(a, a?.tone || "ghost");
            if (!ap) return null;
            return (
              <Button
                key={a?.key || `${ap.label}-${idx}`}
                label={ap.label}
                icon={ap.icon}
                title={ap.title}
                disabled={ap.disabled}
                onClick={ap.onClick}
                href={ap.href}
                tone={ap.tone}
                size="sm"
              />
            );
          })}

          {/* Overflow tertiary */}
          {overflowTertiary.length ? (
            <OverflowMenu actions={overflowTertiary} onNavigate={onNavigate} />
          ) : null}

          {/* Secondary + Primary */}
          {rightSlot ? (
            <div className="hidden md:block mx-2">{rightSlot}</div>
          ) : null}

          <div className="flex items-center gap-2">
            {s ? (
              <Button
                label={s.label}
                icon={s.icon}
                title={s.title}
                disabled={s.disabled}
                onClick={s.onClick}
                href={s.href}
                tone={s.tone}
                size="md"
              />
            ) : null}
            {p ? (
              <Button
                label={p.label}
                icon={p.icon}
                title={p.title}
                disabled={p.disabled}
                onClick={p.onClick}
                href={p.href}
                tone={p.tone}
                size="md"
              />
            ) : null}
          </div>

          {/* Right slot on small screens */}
          {rightSlot ? <div className="md:hidden">{rightSlot}</div> : null}
        </div>
      </div>
    </div>
  );
}
