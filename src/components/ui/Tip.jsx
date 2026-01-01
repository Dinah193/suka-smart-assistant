// src/components/ui/Tip.jsx
import React, { useEffect, useId, useMemo, useState } from "react";
import PropTypes from "prop-types";

/** join classnames safely */
const cx = (...xs) => xs.filter(Boolean).join(" ");

/**
 * Tip
 * - Contextual guidance / callouts for pages and components.
 * - Persistently dismissible (per-id) using localStorage.
 * - Variants: info | success | warn | danger | brand | neutral
 * - Inline (subtle) or Card (elevated) styles
 * - Automation-aware actions (emit `automation:intent` + optional runtime)
 * - Keyboard hint pills, copy-to-clipboard helper, optional illustration
 *
 * Props:
 *  - id?: string                        // persistence key for dismissal (recommended)
 *  - title?: node
 *  - children?: node                    // tip body
 *  - variant?: oneOf('info','success','warn','danger','brand','neutral')
 *  - icon?: node
 *  - inline?: boolean                   // inline = subtle row; false = elevated card
 *  - dismissible?: boolean (default true)
 *  - defaultOpen?: boolean (default true) // starting state when no persisted choice
 *  - actions?: [{ label, icon?, intent?, detail?, onClick?, kind?: 'primary'|'subtle'|'ghost', busyLabel? }]
 *  - hotkeys?: string[]                 // shown as pills, e.g. ["Ctrl+S","Shift+B"]
 *  - copyText?: string                  // reveals a small "Copy" button
 *  - illustration?: node                // right-side visual (small)
 *  - className?: string
 *  - onDismiss?: () => void
 *  - showIf?: boolean                   // conditional render shortcut (default true)
 */
export default function Tip({
  id,
  title,
  children,
  variant = "info",
  icon,
  inline = false,
  dismissible = true,
  defaultOpen = true,
  actions = [],
  hotkeys = [],
  copyText,
  illustration,
  className = "",
  onDismiss,
  showIf = true,
}) {
  const storageKey = id ? `suka.tip.dismissed:${id}` : null;
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const headingId = useId();

  // persistence
  useEffect(() => {
    if (!storageKey) return;
    try {
      const val = localStorage.getItem(storageKey);
      if (val === "1") setDismissed(true);
    } catch {}
  }, [storageKey]);

  if (!showIf) return null;
  if (dismissed) return null;
  if (!open) return null;

  const palette = useMemo(() => variantToPalette(variant), [variant]);

  const close = () => {
    setOpen(false);
    if (dismissible && storageKey) {
      try {
        localStorage.setItem(storageKey, "1");
      } catch {}
    }
    onDismiss?.();
  };

  return (
    <aside
      className={cx(
        inline
          ? "w-full rounded-[12px] px-3 py-2 border"
          : "card w-full p-4 md:p-5 border shadow-card",
        palette.bg,
        palette.border,
        className
      )}
      role="note"
      aria-labelledby={headingId}
    >
      <div className="flex items-start gap-3">
        {/* icon */}
        {icon ? (
          <div
            className={cx(
              "mt-0.5 grid place-items-center rounded-full w-8 h-8 shrink-0",
              palette.icoBg,
              palette.icoText,
              "border",
              palette.border
            )}
            aria-hidden
          >
            {icon}
          </div>
        ) : null}

        {/* content */}
        <div className="flex-1 min-w-0">
          {title ? (
            <div id={headingId} className={cx("font-extrabold", inline ? "text-sm" : "text-base md:text-lg")}>
              {title}
            </div>
          ) : null}

          {children ? (
            <div className={cx("mt-1", "text-[hsl(var(--muted-foreground))]", inline ? "text-sm" : "text-sm md:text-base")}>
              {children}
            </div>
          ) : null}

          {/* hotkeys */}
          {hotkeys?.length ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {hotkeys.map((hk, i) => (
                <span key={`${hk}-${i}`} className="pill">{hk}</span>
              ))}
            </div>
          ) : null}

          {/* actions row */}
          {(actions?.length || copyText) ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {actions.map((a, idx) => (
                <ActionButton key={`${a.label}-${idx}`} {...a} variantPalette={palette} />
              ))}
              {typeof copyText === "string" ? (
                <CopyButton
                  text={copyText}
                  copied={copied}
                  onCopied={() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                  variantPalette={palette}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        {/* right visual + dismiss */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          {illustration ? <div className="hidden md:block">{illustration}</div> : null}
          {dismissible ? (
            <button
              type="button"
              className={cx("btn icon", inline ? "" : "subtle")}
              aria-label="Dismiss tip"
              onClick={close}
              title="Dismiss"
            >
              ×
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

/* ---------------------------- subcomponents ------------------------------ */

function ActionButton({ label, icon, kind = "subtle", busyLabel, intent, detail, onClick, variantPalette }) {
  const [busy, setBusy] = useState(false);
  const classMap = {
    primary: "btn primary",
    subtle: "btn subtle",
    ghost: "btn",
  };
  return (
    <button
      type="button"
      className={cx(classMap[kind] || classMap.subtle, variantPalette?.btnAdj)}
      aria-busy={busy ? "true" : "false"}
      onMouseDown={(e) => e.currentTarget.classList.add("is-pressed")}
      onMouseUp={(e) => e.currentTarget.classList.remove("is-pressed")}
      onClick={async () => {
        try {
          setBusy(true);
          if (onClick) {
            await onClick();
          } else if (intent) {
            // Broadcast to app listeners
            window.dispatchEvent(new CustomEvent("automation:intent", { detail: { intent, ...(detail || {}) } }));
            // Optional runtime
            try {
              const mod = await import(/* @vite-ignore */ "@/services/automation/runtime").catch(() => null);
              const runtime = mod?.automation || mod?.default || null;
              if (runtime?.emitIntent) await runtime.emitIntent(intent, detail || {});
            } catch {}
          }
        } finally {
          setBusy(false);
        }
      }}
    >
      {icon ? <span aria-hidden>{icon}</span> : null}
      <span className="label">{busy && busyLabel ? busyLabel : label}</span>
    </button>
  );
}

function CopyButton({ text, copied, onCopied, variantPalette }) {
  return (
    <button
      type="button"
      className={cx("btn", "subtle", variantPalette?.btnAdj)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          onCopied?.();
        } catch {}
      }}
      title="Copy to clipboard"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

/* ------------------------------- helpers -------------------------------- */

function variantToPalette(variant) {
  switch (variant) {
    case "success":
      return {
        bg: "bg-[hsl(var(--success))/0.12]",
        border: "border-[hsl(var(--success))/0.35]",
        icoBg: "bg-[hsl(var(--success))/0.2]",
        icoText: "text-[hsl(var(--success))]",
        btnAdj: "",
      };
    case "warn":
      return {
        bg: "bg-[hsl(var(--warn))/0.12]",
        border: "border-[hsl(var(--warn))/0.35]",
        icoBg: "bg-[hsl(var(--warn))/0.2]",
        icoText: "text-[hsl(var(--warn))]",
        btnAdj: "",
      };
    case "danger":
      return {
        bg: "bg-[hsl(var(--danger))/0.12]",
        border: "border-[hsl(var(--danger))/0.35]",
        icoBg: "bg-[hsl(var(--danger))/0.2]",
        icoText: "text-[hsl(var(--danger))]",
        btnAdj: "",
      };
    case "brand":
      return {
        bg: "bg-[hsl(var(--brand))/0.12]",
        border: "border-[hsl(var(--brand))/0.35]",
        icoBg: "bg-[hsl(var(--brand))/0.18]",
        icoText: "text-[hsl(var(--brand))]",
        btnAdj: "ring-brand-2",
      };
    case "neutral":
      return {
        bg: "bg-[hsl(var(--muted))/0.22]",
        border: "border-[hsl(var(--border))]",
        icoBg: "bg-[hsl(var(--muted))/0.28]",
        icoText: "text-[hsl(var(--foreground))]",
        btnAdj: "",
      };
    case "info":
    default:
      return {
        bg: "bg-[hsl(var(--brand-weak))]",
        border: "border-[hsl(var(--border))]",
        icoBg: "bg-[hsl(var(--brand-weak))/0.6]",
        icoText: "text-[hsl(var(--brand-ink))]",
        btnAdj: "ring-brand-2",
      };
  }
}

/* ------------------------------- propTypes ------------------------------- */

Tip.propTypes = {
  id: PropTypes.string,
  title: PropTypes.node,
  children: PropTypes.node,
  variant: PropTypes.oneOf(["info", "success", "warn", "danger", "brand", "neutral"]),
  icon: PropTypes.node,
  inline: PropTypes.bool,
  dismissible: PropTypes.bool,
  defaultOpen: PropTypes.bool,
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
  hotkeys: PropTypes.arrayOf(PropTypes.string),
  copyText: PropTypes.string,
  illustration: PropTypes.node,
  className: PropTypes.string,
  onDismiss: PropTypes.func,
  showIf: PropTypes.bool,
};

/* -------------------------------- examples -------------------------------
1) Simple inline info tip:
<Tip
  id="home.saveVision.hint"
  inline
  title="Pro tip"
  hotkeys={["Ctrl+S"]}
>
  Press <strong>Ctrl + S</strong> anywhere to save your Household Vision.
</Tip>

2) Elevated brand tip with automation action:
<Tip
  id="meal.rhythm.suggest"
  title="Try a weekly meal rhythm"
  variant="brand"
  actions={[
    { label: "Suggest Rhythm", icon: "⏱️", intent: "mealPlan/rhythm/suggest", kind: "primary", busyLabel: "Suggesting…" },
  ]}
>
  Use time windows (e.g., 16:8 fast) and batch nights to reduce weekday cooking load.
</Tip>

3) With copy helper & illustration:
<Tip
  id="recipe.shortcuts"
  title="Keyboard shortcuts"
  variant="neutral"
  copyText="Shift+M — Meal Planner, Shift+B — Batch, Shift+C — Cleaning"
  illustration={<img alt="" src="/assets/keys.svg" width={96} height={48} />}
>
  Shift+M opens Meal Planner, Shift+B starts Batch Session, Shift+C generates Cleaning.
</Tip>
------------------------------------------------------------------------- */
