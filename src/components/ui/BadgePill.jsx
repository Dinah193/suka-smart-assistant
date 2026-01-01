// src/components/ui/BadgePill.jsx
import React, { useMemo, useState } from "react";
import PropTypes from "prop-types";

/** classname combiner */
const cx = (...xs) => xs.filter(Boolean).join(" ");

/**
 * BadgePill
 * - Modes: static, button (onClick/intent), link (href), selectable (selected/onToggle), dismissible (onDismiss)
 * - Variants: neutral | brand | success | warn | danger | info
 * - Tones: soft | solid | outline
 * - Extras: count, avatar, icon, trailing, progress (mini ring), skeleton
 * - Automation-aware: emits `automation:intent` and optionally `automation.runtime.emitIntent`
 *
 * Common uses in Suka:
 * - Filters (selectable) for recipes, inventory, garden zones
 * - Status tags in cards/headers
 * - Actionable chips that kick off planners (“Suggest Rhythm”, etc.)
 */
export default function BadgePill({
  label,
  icon,
  trailing,
  avatar, // { src, alt } OR ReactNode
  count,
  maxCount = 99,
  progress, // number 0..100 draws a mini ring
  size = "md",
  variant = "neutral",
  tone = "soft",
  selected = false,
  onToggle,
  onClick,
  href,
  target,
  rel,
  intent,
  detail,
  dismissible = false,
  onDismiss,
  skeleton = false,
  disabled = false,
  className = "",
  title,
  ariaLabel,
}) {
  const [busy, setBusy] = useState(false);

  const look = useMemo(() => getLook(variant, tone, selected, disabled), [
    variant,
    tone,
    selected,
    disabled,
  ]);

  const sizing = useMemo(() => getSize(size), [size]);

  const role =
    onToggle || onClick || intent ? "button" : href ? undefined : "status";

  const showCount =
    typeof count === "number"
      ? Math.min(count, maxCount) + (count > maxCount ? "+" : "")
      : undefined;

  const content = (
    <span
      className={cx(
        "inline-flex items-center justify-center",
        "select-none",
        "rounded-chip",
        look.base,
        sizing.pad,
        skeleton ? "opacity-60" : "",
        className
      )}
      title={title}
      aria-label={ariaLabel}
      role={role}
      aria-pressed={onToggle ? !!selected : undefined}
      aria-busy={busy ? "true" : "false"}
      tabIndex={role ? 0 : undefined}
      onKeyDown={(e) => {
        if (disabled || skeleton) return;
        if ((e.key === "Enter" || e.key === " ") && role) {
          e.preventDefault();
          handlePress();
        }
        if ((e.key === "Backspace" || e.key === "Delete") && dismissible && onDismiss) {
          e.preventDefault();
          onDismiss();
        }
      }}
      onClick={(e) => {
        if (href) return; // anchor handles it
        if (disabled || skeleton) return;
        handlePress(e);
      }}
      onMouseDown={(e) => e.currentTarget.classList.add("is-pressed")}
      onMouseUp={(e) => e.currentTarget.classList.remove("is-pressed")}
    >
      {/* avatar / icon / progress ring (leading) */}
      {avatar ? (
        <span className={cx("mr-1.5 shrink-0", sizing.leadBox)}>
          {React.isValidElement(avatar) ? (
            avatar
          ) : (
            <img
              src={avatar.src}
              alt={avatar.alt || ""}
              className="w-full h-full rounded-full object-cover border border-[hsl(var(--border))]"
              draggable={false}
            />
          )}
        </span>
      ) : progress != null ? (
        <MiniRing percent={progress} className={cx("mr-1.5 shrink-0", sizing.leadBox)} colorClass={look.ring} />
      ) : icon ? (
        <span className={cx("mr-1.5", look.fgMuted)} aria-hidden>
          {icon}
        </span>
      ) : null}

      {/* label */}
      <span className={cx("truncate", sizing.text, look.fg)}>{skeleton ? <Sk w="10ch" /> : label}</span>

      {/* count */}
      {showCount != null && (
        <span
          className={cx(
            "ml-1.5 inline-flex items-center justify-center min-w-[1.5em]",
            sizing.countPad,
            "rounded-full text-[0.75em] font-bold",
            look.countBg,
            look.countFg
          )}
          aria-label={`${showCount} items`}
        >
          {showCount}
        </span>
      )}

      {/* trailing adornment */}
      {trailing ? <span className="ml-1.5">{trailing}</span> : null}

      {/* dismiss button */}
      {dismissible && onDismiss ? (
        <button
          type="button"
          className={cx("ml-1.5 btn icon", sizing.closeBox, look.closeBtn)}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss();
          }}
          title="Remove"
          aria-label="Remove"
        >
          ×
        </button>
      ) : null}
    </span>
  );

  if (href) {
    return (
      <a
        href={href}
        target={target}
        rel={rel}
        className="inline-block"
        onMouseDown={(e) => e.currentTarget.classList.add("is-pressed")}
        onMouseUp={(e) => e.currentTarget.classList.remove("is-pressed")}
      >
        {content}
      </a>
    );
  }

  return content;

  async function handlePress(e) {
    try {
      setBusy(true);
      if (onToggle) {
        onToggle(!selected);
        return;
      }
      if (onClick) {
        await onClick(e);
        return;
      }
      if (intent) {
        window.dispatchEvent(
          new CustomEvent("automation:intent", {
            detail: { intent, ...(detail || {}) },
          })
        );
        try {
          const mod = await import(/* @vite-ignore */ "@/services/automation/runtime").catch(() => null);
          const runtime = mod?.automation || mod?.default || null;
          if (runtime?.emitIntent) await runtime.emitIntent(intent, detail || {});
        } catch {}
      }
    } finally {
      setBusy(false);
    }
  }
}

/* --------------------------- Mini progress ring -------------------------- */
function MiniRing({ percent = 0, className = "", colorClass }) {
  const size = 18;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * Math.min(1, Math.max(0, percent / 100));
  return (
    <svg width={size} height={size} className={cx("block", className)} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="hsl(var(--muted)/.35)" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className={colorClass}
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={c - dash}
        style={{ transition: "stroke-dashoffset .25s ease" }}
      />
    </svg>
  );
}

/* ------------------------------- Skeleton -------------------------------- */
function Sk({ w = "8ch" }) {
  return <span className="inline-block align-middle skeleton rounded-[8px]" style={{ height: 16, width: w }} />;
}

/* --------------------------------- Looks --------------------------------- */
function getLook(variant, tone, selected, disabled) {
  const common = {
    fg: disabled ? "text-[hsl(var(--muted-foreground))]" : "text-[hsl(var(--foreground))]",
    fgMuted: disabled ? "text-[hsl(var(--muted-foreground))]" : "text-[hsl(var(--muted-foreground))]",
    ring: "stroke-[hsl(var(--brand))]",
    countBg: "bg-[hsl(var(--muted))/0.25]",
    countFg: "text-[hsl(var(--foreground))]",
    closeBtn: "subtle",
  };

  const palette = {
    neutral: {
      soft: {
        base: cx("border", "border-[hsl(var(--border))]", "bg-[hsl(var(--muted))/0.20]"),
        ...common,
      },
      solid: {
        base: cx("border", "border-[hsl(var(--border))]", "bg-[hsl(var(--foreground))]", "text-white"),
        fg: "text-white",
        fgMuted: "text-white/80",
        ring: "stroke-[hsl(var(--foreground))]",
        countBg: "bg-white/20",
        countFg: "text-white",
        closeBtn: "ghost",
      },
      outline: {
        base: cx("border-2", "border-[hsl(var(--border))]"),
        ...common,
      },
    },
    brand: softSolidOutline("brand"),
    success: softSolidOutline("success"),
    warn: softSolidOutline("warn"),
    danger: softSolidOutline("danger"),
    info: softSolidOutline("brand"), // alias to brand hue, softer messaging
  }[variant || "neutral"][tone || "soft"];

  // selected state boost (for filter chips)
  if (selected) {
    if (tone === "soft") {
      palette.base = cx("border", "bg-[hsl(var(--brand-weak))]", "border-[hsl(var(--brand)/0.35)]");
      palette.fg = "text-[hsl(var(--brand-ink))]";
      palette.ring = "stroke-[hsl(var(--brand))]";
    } else if (tone === "outline") {
      palette.base = cx("border-2", "border-[hsl(var(--brand))]");
      palette.fg = "text-[hsl(var(--brand-ink))]";
    }
  }

  // disabled dim
  if (disabled) {
    palette.base = cx(palette.base, "opacity-60 pointer-events-none");
  }

  return palette;
}

function softSolidOutline(token) {
  return {
    soft: {
      base: cx("border", `border-[hsl(var(--${token}))/0.35]`, `bg-[hsl(var(--${token}))/0.12]`),
      fg: `text-[hsl(var(--${token}))]`,
      fgMuted: `text-[hsl(var(--${token}))/0.85]`,
      ring: `stroke-[hsl(var(--${token}))]`,
      countBg: `bg-[hsl(var(--${token}))/0.25]`,
      countFg: `text-[hsl(var(--foreground))]`,
      closeBtn: "",
    },
    solid: {
      base: cx("border", `border-[hsl(var(--${token}))/0.85]`, `bg-[hsl(var(--${token}))]`, "text-white"),
      fg: "text-white",
      fgMuted: "text-white/90",
      ring: `stroke-[hsl(var(--${token}))]`,
      countBg: "bg-white/25",
      countFg: "text-white",
      closeBtn: "ghost",
    },
    outline: {
      base: cx("border-2", `border-[hsl(var(--${token}))]`),
      fg: `text-[hsl(var(--${token}))]`,
      fgMuted: `text-[hsl(var(--${token}))/0.85]`,
      ring: `stroke-[hsl(var(--${token}))]`,
      countBg: `bg-[hsl(var(--${token}))/0.15]`,
      countFg: `text-[hsl(var(--foreground))]`,
      closeBtn: "",
    },
  };
}

/* --------------------------------- Sizes --------------------------------- */
function getSize(size) {
  switch (size) {
    case "sm":
      return {
        pad: "px-2 py-1 text-[12.5px] font-semibold",
        text: "leading-tight",
        leadBox: "w-4 h-4",
        closeBox: "w-6 h-6",
        countPad: "px-1.5 py-[1px]",
      };
    case "lg":
      return {
        pad: "px-3.5 py-2 text-[15px] font-semibold",
        text: "leading-tight",
        leadBox: "w-6 h-6",
        closeBox: "w-8 h-8",
        countPad: "px-2 py-[2px]",
      };
    case "md":
    default:
      return {
        pad: "px-3 py-1.5 text-[14px] font-semibold",
        text: "leading-tight",
        leadBox: "w-5 h-5",
        closeBox: "w-7 h-7",
        countPad: "px-2 py-[1px]",
      };
  }
}

/* -------------------------------- PropTypes ------------------------------ */
BadgePill.propTypes = {
  label: PropTypes.node.isRequired,
  icon: PropTypes.node,
  trailing: PropTypes.node,
  avatar: PropTypes.oneOfType([
    PropTypes.shape({ src: PropTypes.string.isRequired, alt: PropTypes.string }),
    PropTypes.node,
  ]),
  count: PropTypes.number,
  maxCount: PropTypes.number,
  progress: PropTypes.number,
  size: PropTypes.oneOf(["sm", "md", "lg"]),
  variant: PropTypes.oneOf(["neutral", "brand", "success", "warn", "danger", "info"]),
  tone: PropTypes.oneOf(["soft", "solid", "outline"]),
  selected: PropTypes.bool,
  onToggle: PropTypes.func,
  onClick: PropTypes.func,
  href: PropTypes.string,
  target: PropTypes.string,
  rel: PropTypes.string,
  intent: PropTypes.string,
  detail: PropTypes.object,
  dismissible: PropTypes.bool,
  onDismiss: PropTypes.func,
  skeleton: PropTypes.bool,
  disabled: PropTypes.bool,
  className: PropTypes.string,
  title: PropTypes.string,
  ariaLabel: PropTypes.string,
};

/* -------------------------------- Examples --------------------------------
1) Filter chip (selectable):
<BadgePill
  label="Pantry-First"
  variant="brand"
  selected={filters.includes('Pantry-First')}
  onToggle={(next)=>setFilters(t => next ? [...t,'Pantry-First'] : t.filter(x=>x!=='Pantry-First'))}
/>

2) Dismissible tag with count:
<BadgePill label="Low Sugar" variant="success" count={12} dismissible onDismiss={()=>removeTag('Low Sugar')} />

3) Action chip (automation intent):
<BadgePill label="Suggest Rhythm" icon="⏱️" variant="brand" tone="solid" intent="mealPlan/rhythm/suggest" />

4) Link pill:
<BadgePill label="Open Meal Planner" href="/meal-planner" icon="🍽️" />

5) Progress pill (mini ring shows %):
<BadgePill label="Batch Session" progress={68} variant="info" />

6) Skeleton while loading:
<BadgePill label={<span />} skeleton />
--------------------------------------------------------------------------- */
