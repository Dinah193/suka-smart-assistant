// C:\Users\larho\suka-smart-assistant\src\components\homestead\PlannerSectionCard.jsx
/* eslint-disable react/prop-types */
/**
 * SSA • PlannerSectionCard
 * -----------------------------------------------------------------------------
 * Standard section card wrapper used across Homestead Planner pages.
 * Matches the “clean, rounded, bordered, soft” SSA page card style.
 *
 * Features
 *  - Header: title, subtitle, right actions/slot
 *  - Body: children, optional padded/flush mode
 *  - Footer: optional footer slot
 *  - States: loading, empty, error
 *  - Optional collapsible behavior (persisted via localStorage)
 *  - Optional “toolbar” row under header
 *  - Optional “variant” styling (default / subtle / danger / success / warn)
 *
 * Usage
 *  <PlannerSectionCard
 *    title="Inventory"
 *    subtitle="Readiness + shelf life"
 *    right={<button ...>Add</button>}
 *  >
 *    ...content...
 *  </PlannerSectionCard>
 */

import React, { useEffect, useMemo, useState } from "react";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function safeId(id, fallback) {
  const s = (id || "").toString().trim();
  return s || fallback;
}

function normalizeStorageKey(key) {
  const s = (key || "").toString().trim();
  return s ? `ssa.sectionCard.${s}` : null;
}

function readBoolLS(key, fallback = false) {
  try {
    const k = normalizeStorageKey(key);
    if (!k) return fallback;
    const v = window?.localStorage?.getItem(k);
    if (v == null) return fallback;
    return v === "1" || v === "true";
  } catch (e) {
    return fallback;
  }
}

function writeBoolLS(key, value) {
  try {
    const k = normalizeStorageKey(key);
    if (!k) return;
    window?.localStorage?.setItem(k, value ? "1" : "0");
  } catch (e) {}
}

function VariantStyles(variant) {
  // Keep minimal: border/back drop tuned per state.
  switch ((variant || "").toLowerCase()) {
    case "subtle":
      return {
        shell: "border-gray-100 bg-white",
        header: "",
      };
    case "success":
      return {
        shell: "border-green-200 bg-white",
        header: "",
      };
    case "warn":
      return {
        shell: "border-amber-200 bg-white",
        header: "",
      };
    case "danger":
      return {
        shell: "border-red-200 bg-white",
        header: "",
      };
    default:
      return {
        shell: "border-gray-200 bg-white",
        header: "",
      };
  }
}

function IconChevron({ open }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex items-center justify-center transition-transform duration-150",
        open ? "rotate-180" : "rotate-0"
      )}
    >
      ▾
    </span>
  );
}

function MiniBadge({ children }) {
  return (
    <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2 py-1 text-[11px] font-bold">
      {children}
    </span>
  );
}

function DefaultEmpty({
  emptyTitle = "Nothing here yet",
  emptyHint = "Add items to get started.",
}) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-6 text-center">
      <div className="text-sm font-black">{emptyTitle}</div>
      <div className="mt-2 text-xs opacity-70">{emptyHint}</div>
    </div>
  );
}

function DefaultError({ error }) {
  const msg =
    typeof error === "string"
      ? error
      : error?.message || "Something went wrong.";
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
      <div className="text-sm font-black text-red-900">Section error</div>
      <div className="mt-2 text-xs text-red-900 opacity-90">{msg}</div>
    </div>
  );
}

function DefaultLoading({ lines = 3 }) {
  return (
    <div className="animate-pulse space-y-3">
      {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
        <div key={i} className="h-4 w-full rounded-full bg-gray-100" />
      ))}
    </div>
  );
}

/**
 * PlannerSectionCard
 */
export default function PlannerSectionCard({
  id, // used for aria + persistence; strongly recommended
  className = "",
  variant = "default",

  // Header
  title,
  subtitle,
  right, // node
  badge, // string | node
  hint, // small hint under subtitle (string | node)
  toolbar, // node under header (e.g., filters)

  // Content
  children,
  padded = true, // padding inside body
  flush = false, // overrides padded for edge-to-edge content
  bodyClassName = "",

  // Footer
  footer,
  footerClassName = "",

  // States
  loading = false,
  empty = false,
  error = null,
  emptyTitle,
  emptyHint,
  loadingLines = 3,

  // Collapsible
  collapsible = false,
  defaultOpen = true,
  persistKey = null, // if provided, overrides id-based key
  onToggle, // (open) => void

  // Optional header click behavior
  headerClickable = true,
}) {
  const autoId = useMemo(
    () => safeId(id, `planner-section-${Math.random().toString(16).slice(2)}`),
    [id]
  );
  const collapseKey = persistKey || autoId;

  const initialOpen = useMemo(() => {
    if (!collapsible) return true;
    // persisted state wins
    const persistedClosed = readBoolLS(`${collapseKey}.closed`, !defaultOpen);
    return !persistedClosed;
  }, [collapsible, collapseKey, defaultOpen]);

  const [open, setOpen] = useState(initialOpen);

  useEffect(() => {
    if (!collapsible) return;
    // keep in sync if parent changes defaultOpen/persistKey
    setOpen(initialOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOpen, collapsible, collapseKey]);

  const styles = VariantStyles(variant);

  const hasHeader = !!(title || subtitle || right || badge || collapsible);

  const bodyPadding = flush ? "p-0" : padded ? "p-4" : "p-0";
  const headerId = `${autoId}-header`;
  const panelId = `${autoId}-panel`;

  const toggle = () => {
    if (!collapsible) return;
    const next = !open;
    setOpen(next);
    writeBoolLS(`${collapseKey}.closed`, !next);
    onToggle?.(next);
  };

  const Header = hasHeader ? (
    <div
      id={headerId}
      className={cx(
        "flex items-start justify-between gap-3",
        "px-4 py-4",
        "border-b border-gray-200",
        styles.header,
        collapsible && headerClickable
          ? "cursor-pointer select-none hover:bg-gray-50 transition"
          : ""
      )}
      onClick={collapsible && headerClickable ? toggle : undefined}
      role={collapsible && headerClickable ? "button" : undefined}
      tabIndex={collapsible && headerClickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (!(collapsible && headerClickable)) return;
        if (e.key === "Enter" || e.key === " ") toggle();
      }}
      aria-controls={panelId}
      aria-expanded={collapsible ? (open ? "true" : "false") : undefined}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {title ? <div className="text-sm font-black">{title}</div> : null}
          {badge ? <MiniBadge>{badge}</MiniBadge> : null}
        </div>

        {subtitle ? (
          <div className="mt-1 text-xs opacity-70">{subtitle}</div>
        ) : null}
        {hint ? (
          <div className="mt-2 text-[11px] opacity-60">{hint}</div>
        ) : null}
      </div>

      <div className="shrink-0 flex items-center gap-2">
        {right ? (
          <div
            // stop clicks on right controls from toggling collapse
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {right}
          </div>
        ) : null}
        {collapsible ? (
          <button
            type="button"
            className={cx(
              "inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-bold",
              "hover:bg-gray-50 transition"
            )}
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            aria-label={open ? "Collapse section" : "Expand section"}
            title={open ? "Collapse" : "Expand"}
          >
            <span className="hidden sm:inline">{open ? "Hide" : "Show"}</span>
            <IconChevron open={open} />
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

  const Toolbar = toolbar ? (
    <div
      className="px-4 py-3 border-b border-gray-200 bg-white"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {toolbar}
    </div>
  ) : null;

  const Content = (() => {
    if (loading) return <DefaultLoading lines={loadingLines} />;
    if (error) return <DefaultError error={error} />;
    if (empty)
      return <DefaultEmpty emptyTitle={emptyTitle} emptyHint={emptyHint} />;
    return children;
  })();

  return (
    <section
      className={cx(
        "rounded-2xl border shadow-sm",
        "overflow-hidden",
        styles.shell,
        className
      )}
      aria-labelledby={hasHeader ? headerId : undefined}
    >
      {Header}
      {open ? (
        <>
          {Toolbar}
          <div id={panelId} className={cx(bodyPadding, bodyClassName)}>
            {Content}
          </div>

          {footer ? (
            <div
              className={cx(
                "px-4 py-3 border-t border-gray-200 bg-white",
                footerClassName
              )}
            >
              {footer}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
