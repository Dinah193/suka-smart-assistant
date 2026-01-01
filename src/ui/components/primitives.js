/* eslint-disable react/prop-types */
/* Suka Smart Assistant — UI Primitives
   Components: Button, Card, Chip, Empty, InlineToastAction
   - Clear, consistent styles via CSS vars from src/ui/tokens.js
   - Async actions with loading, success/error states
   - Two-step confirm pattern (danger/irreversible)
   - Inline “next best action” nudge + optional undo hook
   - Emits app-wide events for analytics & toasts (via automation/runtime)
*/

import React, { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { on, emit } from "@/services/automation/runtime";

/* ---------------------------------- utils --------------------------------- */

function cx(...args) {
  return args.filter(Boolean).join(" ");
}

function useEvent(event, handler) {
  useEffect(() => {
    if (!event || !handler) return;
    return on(event, handler);
  }, [event, handler]);
}

function Spinner({ className }) {
  return (
    <svg
      className={cx("animate-spin", className)}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" opacity=".2" strokeWidth="4" fill="none" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" fill="none" />
    </svg>
  );
}

/* Lightweight undo stack (module-local). Push a function to enable undo. */
const UNDO_STACK = [];
export function pushUndo(fn) {
  if (typeof fn === "function") UNDO_STACK.push(fn);
  emit("ui.undo.available", { count: UNDO_STACK.length });
}
export function undoLast() {
  const fn = UNDO_STACK.pop();
  if (fn) fn();
  emit("ui.undo.available", { count: UNDO_STACK.length });
}

/* ------------------------------- Button ----------------------------------- */

const BUTTON_VARIANTS = {
  primary:
    "text-white bg-[var(--color-primary)] hover:bg-[var(--color-primary-alt)] focus-visible:shadow-[var(--shadow-focus)]",
  secondary:
    "text-[var(--color-text)] bg-[var(--color-surface-alt)] hover:bg-[color-mix(in_srgb,var(--color-surface-alt)_92%,#000_8%)] border border-[var(--color-border)]",
  outline:
    "text-[var(--color-text)] bg-transparent border border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]",
  ghost: "text-[var(--color-text-muted)] bg-transparent hover:bg-[var(--color-surface-alt)]",
  success: "text-white bg-[var(--color-success)] hover:brightness-95",
  danger: "text-white bg-[var(--color-danger)] hover:brightness-95",
};

const BUTTON_SIZES = {
  sm: "text-sm px-3 py-1.5 gap-2",
  md: "text-sm px-4 py-2 gap-2",
  lg: "text-base px-5 py-2.5 gap-3",
};

export const Button = forwardRef(function Button(
  {
    as: Comp = "button",
    variant = "primary",
    size = "md",
    className,
    icon,
    iconRight,
    children,
    loading: loadingProp = false,
    disabled,
    confirm = false, // two-step confirmation
    confirmLabel = "Confirm",
    onClick, // can be async
    onUndo, // optional undo handler pushed to stack after success
    nextActions = [], // [{label, href}] for next best action nudge
    nudgeMessage, // string
    "aria-label": ariaLabel,
    ...rest
  },
  ref
) {
  const [loading, setLoading] = useState(loadingProp);
  const [stepConfirm, setStepConfirm] = useState(false);
  const isDanger = variant === "danger";

  useEffect(() => setLoading(loadingProp), [loadingProp]);

  const base =
    "inline-flex items-center justify-center rounded-[var(--radius-lg)] shadow-[var(--shadow-xs)] focus-visible:outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed";
  const styles = cx(base, BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary, BUTTON_SIZES[size], className);

  async function handleClick(e) {
    if (disabled || loading) return;
    if ((confirm || isDanger) && !stepConfirm) {
      setStepConfirm(true);
      // auto-reset the confirm state if not clicked again within 4s
      const t = setTimeout(() => setStepConfirm(false), 4000);
      return () => clearTimeout(t);
    }

    if (typeof onClick !== "function") return;

    try {
      setLoading(true);
      const result = await onClick(e);

      // success: emit event and nudge
      emit("ui.action.completed", { at: Date.now(), result, source: "Button" });

      // offer undo (if provided)
      if (typeof onUndo === "function") {
        pushUndo(onUndo);
        emit("ui.nudge", {
          at: Date.now(),
          message: "Done. Undo this change?",
          actions: [{ label: "Undo", href: "action://ui.undo" }],
          source: "Button",
        });
      }

      // “next best action” suggestion
      if (nudgeMessage || (nextActions && nextActions.length)) {
        emit("ui.nudge", {
          at: Date.now(),
          message: nudgeMessage || "What would you like to do next?",
          actions: nextActions,
          source: "Button",
        });
      }
    } catch (err) {
      emit("ui.toast", {
        kind: "error",
        title: "Something went wrong",
        description: err?.message || String(err),
      });
    } finally {
      setLoading(false);
      setStepConfirm(false);
    }
  }

  const label = stepConfirm ? confirmLabel : children;

  return (
    <Comp
      ref={ref}
      className={styles}
      aria-label={ariaLabel}
      aria-busy={loading ? "true" : "false"}
      data-confirm={stepConfirm ? "true" : "false"}
      disabled={disabled || loading}
      onClick={handleClick}
      {...rest}
    >
      {loading ? (
        <>
          <Spinner className="mr-2" /> Processing…
        </>
      ) : (
        <>
          {icon ? <span className="inline-flex">{icon}</span> : null}
          <span>{label}</span>
          {iconRight ? <span className="inline-flex">{iconRight}</span> : null}
        </>
      )}
    </Comp>
  );
});

/* ---------------------------------- Card ---------------------------------- */

export function Card({
  className,
  onClick,
  interactive = false,
  title,
  subtitle,
  actions,
  footer,
  children,
}) {
  const base =
    "bg-[var(--card-bg)] border border-[var(--card-border)] rounded-[var(--radius-xl)] shadow-[var(--shadow-sm)]";
  const interactiveCls = interactive
    ? "hover:shadow-[var(--shadow-md)] hover:-translate-y-[1px] transition will-change-transform cursor-pointer"
    : "";
  return (
    <section className={cx(base, interactiveCls, className)} onClick={onClick}>
      {(title || actions || subtitle) && (
        <header className="flex items-start justify-between p-[var(--space-4)] pb-3">
          <div>
            {title ? <h3 className="text-[var(--font-lg)] font-semibold">{title}</h3> : null}
            {subtitle ? <p className="text-[var(--font-sm)] text-[var(--color-text-muted)] mt-1">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex gap-2">{actions}</div> : null}
        </header>
      )}
      <div className="px-[var(--space-4)] pb-[var(--space-4)]">{children}</div>
      {footer ? <footer className="px-[var(--space-4)] py-3 border-t border-[var(--color-border)]">{footer}</footer> : null}
    </section>
  );
}

/* ---------------------------------- Chip ---------------------------------- */

const CHIP_VARIANTS = {
  neutral:
    "bg-[color-mix(in_srgb,var(--color-neutral)_10%,transparent)] text-[var(--color-text)] border border-[var(--color-border)]",
  info: "bg-[color-mix(in_srgb,var(--color-info)_12%,transparent)] text-[var(--color-text)]",
  success: "bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-[var(--color-text)]",
  warning: "bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] text-[var(--color-text)]",
  danger: "bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-[var(--color-text)]",
  accent: "bg-[color-mix(in_srgb,var(--intent-accent)_18%,transparent)] text-[var(--color-text)]",
};

export function Chip({
  children,
  variant = "neutral",
  selected = false,
  dismissible = false,
  onDismiss,
  onToggle,
  className,
}) {
  const cls =
    "inline-flex items-center gap-2 rounded-[var(--radius-pill)] px-3 py-1 text-sm select-none";
  return (
    <span
      role={onToggle ? "switch" : undefined}
      aria-checked={onToggle ? (selected ? "true" : "false") : undefined}
      tabIndex={onToggle ? 0 : undefined}
      onClick={onToggle ? () => onToggle(!selected) : undefined}
      onKeyDown={
        onToggle
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle(!selected);
              }
            }
          : undefined
      }
      className={cx(cls, CHIP_VARIANTS[variant] || CHIP_VARIANTS.neutral, selected && "ring-2 ring-[var(--intent-accent)]", className)}
    >
      {children}
      {dismissible ? (
        <button
          aria-label="Remove"
          className="opacity-70 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss?.();
          }}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

/* ---------------------------------- Empty --------------------------------- */

export function Empty({ icon, title = "Nothing here yet", children, actions = [] }) {
  return (
    <div className="text-center p-[var(--space-8)] border border-dashed border-[var(--color-border)] rounded-[var(--radius-xl)] bg-[var(--color-surface-alt)]">
      <div className="flex justify-center mb-3 text-[var(--color-text-muted)]">{icon}</div>
      <h3 className="text-[var(--font-lg)] font-semibold">{title}</h3>
      {children ? <p className="text-[var(--font-sm)] text-[var(--color-text-muted)] mt-1">{children}</p> : null}
      {actions?.length ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {actions.map((a, i) => (
            <Button
              key={i}
              variant={a.variant || "outline"}
              size="sm"
              onClick={a.onClick}
              as={a.href ? "a" : "button"}
              href={a.href}
            >
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------- InlineToastAction ---------------------------- */
/**
 * InlineToastAction
 * - Renders a compact inline “toast” row with message + primary action + optional undo.
 * - Auto-dismiss after a timeout but persists if hovered/focused.
 * - Emits `ui.toast` for global collectors & accessibility log.
 */
export function InlineToastAction({
  kind = "info", // info | success | warning | error
  message,
  actionLabel,
  onAction,
  undoLabel = "Undo",
  onUndo,
  duration = 4500,
  className,
}) {
  const [open, setOpen] = useState(true);
  const timer = useRef();

  const KIND_STYLES = {
    info: "bg-[color-mix(in_srgb,var(--color-info)_10%,transparent)]",
    success: "bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)]",
    warning: "bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)]",
    error: "bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)]",
  };

  useEffect(() => {
    emit("ui.toast", { kind, title: message });
    if (duration <= 0) return;
    timer.current = setTimeout(() => setOpen(false), duration);
    return () => clearTimeout(timer.current);
  }, [kind, message, duration]);

  if (!open) return null;

  return (
    <div
      className={cx(
        "flex items-center justify-between gap-3 px-3 py-2 rounded-[var(--radius-lg)] border border-[var(--color-border)]",
        "shadow-[var(--shadow-xs)] text-[var(--color-text)]",
        KIND_STYLES[kind] || KIND_STYLES.info,
        className
      )}
      onMouseEnter={() => timer.current && clearTimeout(timer.current)}
      onMouseLeave={() => {
        if (duration > 0) timer.current = setTimeout(() => setOpen(false), duration);
      }}
      role="status"
      aria-live="polite"
    >
      <span className="text-sm">{message}</span>
      <div className="flex items-center gap-2">
        {onUndo ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              try {
                onUndo();
              } finally {
                setOpen(false);
              }
            }}
          >
            {undoLabel}
          </Button>
        ) : null}
        {onAction ? (
          <Button
            variant="primary"
            size="sm"
            onClick={async () => {
              try {
                await onAction();
                setOpen(false);
              } catch (e) {
                emit("ui.toast", { kind: "error", title: "Action failed", description: e?.message || String(e) });
              }
            }}
          >
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------- Event-driven glue ----------------------------- */
/**
 * These primitives don’t own routes, but we still hook into core events to
 * provide subtle, useful nudges (e.g., show inline toasts suggesting next steps).
 */
export function registerPrimitiveGlue() {
  // Meal plan created → offer “Share” or “Add to calendar”
  useEvent("mealplan.created", (evt) => {
    emit("ui.inline.suggestion", {
      message: "Meal plan created. Add to calendar or share it?",
      actions: [
        { label: "Create Calendar (.ics)", href: "/export?format=ics" },
        { label: "Share with Family", href: "/family" },
      ],
    });
  });

  // Batch completed → labels/storehouse
  useEvent("batch.completed", () => {
    emit("ui.inline.suggestion", {
      message: "Batch completed. Print labels and update storehouse?",
      actions: [
        { label: "Print Labels", href: "/export?format=labels" },
        { label: "Update Storehouse", href: "/tier2/household/inventory" },
      ],
    });
  });

  // Inventory low stock → shopping list
  useEvent("inventory.updated", (evt) => {
    if (evt?.payload?.lowStockCount > 0) {
      emit("ui.inline.suggestion", {
        message: `Low stock flagged (${evt.payload.lowStockCount}). Generate shopping list?`,
        actions: [{ label: "Shopping List", href: "/tier2/household/meals#shopping" }],
      });
    }
  });

  // Calendar changed → share
  useEvent("calendar.events.updated", () => {
    emit("ui.inline.suggestion", {
      message: "Calendar updated. Share tasks with the family?",
      actions: [{ label: "Open Family Board", href: "/family/board" }],
    });
  });

  // Global undo trigger from elsewhere
  useEvent("ui.undo.request", () => undoLast());
}

/* ------------------------------ IA helpers -------------------------------- */
/**
 * While primitives don't create pages, you can add a small “Style Guide” entry
 * for discovery/testing using your shell's dynamic nav/route registry.
 */
let _iaRegistered = false;
export function registerPrimitivesIA() {
  if (_iaRegistered) return;
  _iaRegistered = true;

  emit("shell.routes.register", {
    base: "/styleguide",
    children: [{ path: "", element: "StyleGuidePrimitives" }],
  });

  emit("shell.nav.register", {
    section: "Tools",
    items: [{ to: "/styleguide", label: "Style Guide", icon: "palette" }],
  });
}

/* ----------------------------- Convenience -------------------------------- */
/**
 * Quick samples for your style guide page (optional).
 * Not auto-rendered; import and use inside your StyleGuidePrimitives component.
 */
export function SampleStateButtons() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
      <Button>Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="success">Success</Button>
      <Button variant="danger" confirm>
        Delete
      </Button>
      <Button
        onClick={async () => {
          // fake async work
          await new Promise((r) => setTimeout(r, 900));
        }}
        nudgeMessage="Export finished. Share or file it?"
        nextActions={[
          { label: "Share with Family", href: "/family" },
          { label: "Open Exports", href: "/files/exports" },
        ]}
      >
        Async Action
      </Button>
    </div>
  );
}

export function SampleEmpty() {
  return (
    <Empty
      title="No exports yet"
      actions={[
        { label: "Start Export", href: "/export" },
        { label: "Open Meal Planner", href: "/tier2/household/meals" },
      ]}
    >
      Exported files will appear here once you create them.
    </Empty>
  );
}
