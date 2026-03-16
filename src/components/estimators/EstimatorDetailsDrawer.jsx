// C:\Users\larho\suka-smart-assistant\src\components\estimators\EstimatorDetailsDrawer.jsx
/* eslint-disable react/prop-types */
import React, { useEffect, useId, useMemo, useRef } from "react";

/**
 * EstimatorDetailsDrawer
 * -----------------------------------------------------------------------------
 * A11y-first right-side drawer for showing estimator run details.
 *
 * Goals:
 * - Works with SSA "Estimator" outputs (food security, cost delta, etc.)
 * - Accessible (role="dialog", aria-modal, labeled, focus management, ESC/overlay close)
 * - No external deps (no Radix/shadcn required)
 * - Tailwind-first styling (matches SSA dashboard vibe)
 *
 * Props:
 * - open: boolean
 * - onClose: () => void
 * - title?: string
 * - estimator?: object (arbitrary; used for header/meta and fallback rendering)
 * - details?: object (arbitrary; preferred structured payload)
 * - sections?: array of { id?, title, description?, items?: [{label,value,hint?,mono?}], content?: ReactNode }
 * - widthClass?: string (tailwind width; default "w-full sm:w-[520px] md:w-[640px]")
 * - showRaw?: boolean (shows raw JSON for details/estimator)
 * - footer?: ReactNode
 * - busy?: boolean (shows spinner state)
 */
export default function EstimatorDetailsDrawer({
  open,
  onClose,
  title = "Estimator Details",
  estimator = null,
  details = null,
  sections = null,
  widthClass = "w-full sm:w-[520px] md:w-[640px]",
  showRaw = false,
  footer = null,
  busy = false,
}) {
  const headingId = useId();
  const descId = useId();
  const panelRef = useRef(null);
  const previouslyFocusedRef = useRef(null);

  const computedTitle = useMemo(() => {
    // Prefer explicit title, otherwise attempt to derive.
    if (title) return title;
    const t =
      details?.meta?.label ||
      details?.meta?.name ||
      details?.meta?.id ||
      estimator?.meta?.label ||
      estimator?.meta?.name ||
      estimator?.meta?.id;
    return t || "Estimator Details";
  }, [title, details, estimator]);

  const computedSubtitle = useMemo(() => {
    const d = details?.meta?.description || estimator?.meta?.description;
    return d || "";
  }, [details, estimator]);

  // Normalize sections:
  // - If explicit sections provided, use them.
  // - Else, build sensible defaults from details/estimator.
  const normalizedSections = useMemo(() => {
    if (Array.isArray(sections) && sections.length) return sections;

    const meta = details?.meta || estimator?.meta || {};
    const run = details?.run || details?.result || details || {};
    const summary = details?.summary || run?.summary || null;
    const inputs = details?.inputs || run?.inputs || null;
    const outputs = details?.outputs || run?.outputs || null;
    const assumptions = details?.assumptions || run?.assumptions || null;
    const warnings = details?.warnings || run?.warnings || null;

    const metaItems = [
      meta?.id ? { label: "Estimator ID", value: meta.id, mono: true } : null,
      meta?.type ? { label: "Type", value: meta.type } : null,
      meta?.domain ? { label: "Domain", value: meta.domain } : null,
      meta?.schemaVersion
        ? { label: "Schema", value: meta.schemaVersion, mono: true }
        : null,
      details?.updatedAt
        ? { label: "Updated", value: formatDate(details.updatedAt) }
        : estimator?.updatedAt
          ? { label: "Updated", value: formatDate(estimator.updatedAt) }
          : null,
    ].filter(Boolean);

    const mkKVSection = (id, title, obj, description) => {
      if (!obj || typeof obj !== "object") return null;
      const items = objectToItems(obj);
      if (!items.length) return null;
      return { id, title, description, items };
    };

    const built = [
      metaItems.length
        ? {
            id: "meta",
            title: "Metadata",
            description: "What this estimator is and how it’s classified.",
            items: metaItems,
          }
        : null,
      summary
        ? mkKVSection(
            "summary",
            "Summary",
            summary,
            "Top-level results and KPIs from the estimator run.",
          )
        : null,
      inputs
        ? mkKVSection(
            "inputs",
            "Inputs",
            inputs,
            "Inputs used to produce these results (user + defaults).",
          )
        : null,
      outputs
        ? mkKVSection(
            "outputs",
            "Outputs",
            outputs,
            "Primary outputs produced by the estimator.",
          )
        : null,
      assumptions
        ? mkKVSection(
            "assumptions",
            "Assumptions",
            assumptions,
            "Defaults and valuation assumptions applied.",
          )
        : null,
      warnings
        ? mkKVSection(
            "warnings",
            "Warnings",
            warnings,
            "Notes or issues detected during estimation.",
          )
        : null,
    ].filter(Boolean);

    // If nothing structured exists, still show a placeholder section.
    if (!built.length) {
      return [
        {
          id: "empty",
          title: "Details",
          description:
            "No structured details were provided for this estimator run.",
          content: (
            <div className="text-sm text-neutral-600">
              Provide{" "}
              <code className="rounded bg-neutral-100 px-1 py-0.5">
                details
              </code>{" "}
              or{" "}
              <code className="rounded bg-neutral-100 px-1 py-0.5">
                sections
              </code>{" "}
              to render structured content.
            </div>
          ),
        },
      ];
    }

    return built;
  }, [sections, details, estimator]);

  // Focus management + ESC close
  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current = document.activeElement;

    // Focus the first focusable element inside panel after render.
    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = getFocusable(panel);
      (focusables[0] || panel).focus?.();
    }, 0);

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key === "Tab") {
        trapTabKey(e, panelRef.current);
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    // Prevent background scroll
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;

      // Restore focus
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === "function") prev.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const rawPayload = details ?? estimator;

  return (
    <div className="fixed inset-0 z-[60]">
      {/* Overlay */}
      <button
        type="button"
        aria-label="Close details"
        className="absolute inset-0 h-full w-full cursor-default bg-black/40"
        onClick={() => onClose?.()}
      />

      {/* Panel */}
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descId}
        className={[
          "absolute right-0 top-0 h-full",
          widthClass,
          "bg-white shadow-2xl",
          "flex flex-col",
          "outline-none",
          "border-l border-neutral-200",
        ].join(" ")}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-4 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2
                id={headingId}
                className="truncate text-lg font-semibold text-neutral-900"
              >
                {computedTitle}
              </h2>
              {busy ? (
                <span className="inline-flex items-center gap-2 rounded-full bg-neutral-100 px-2 py-1 text-xs text-neutral-700">
                  <Spinner />
                  Working…
                </span>
              ) : null}
            </div>

            <p
              id={descId}
              className="mt-1 line-clamp-2 text-sm text-neutral-600"
            >
              {computedSubtitle ||
                "Review inputs, outputs, assumptions, and run context."}
            </p>

            {/* Optional meta line */}
            <MetaLine details={details} estimator={estimator} />
          </div>

          <div className="flex items-center gap-2">
            {rawPayload ? (
              <CopyJsonButton payload={rawPayload} label="Copy JSON" />
            ) : null}
            <button
              type="button"
              onClick={() => onClose?.()}
              className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-400"
            >
              Close
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-4 py-4">
          <div className="space-y-4">
            {normalizedSections.map((s, idx) => (
              <SectionCard key={s.id || `${idx}`} section={s} />
            ))}

            {showRaw && rawPayload ? (
              <div className="rounded-xl border border-neutral-200 bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold text-neutral-900">
                      Raw JSON
                    </div>
                    <div className="text-xs text-neutral-600">
                      Useful for debugging schema payloads.
                    </div>
                  </div>
                  <CopyJsonButton payload={rawPayload} label="Copy" />
                </div>
                <pre className="max-h-[340px] overflow-auto p-4 text-xs leading-relaxed text-neutral-800">
                  {safeStringify(rawPayload, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        {footer ? (
          <div className="border-t border-neutral-200 px-4 py-3">{footer}</div>
        ) : (
          <div className="border-t border-neutral-200 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-neutral-600">
                Tip: keep estimator outputs deterministic by logging inputs +
                assumptions along with the result.
              </div>
              <button
                type="button"
                onClick={() => onClose?.()}
                className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-400"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

/* =============================================================================
   Subcomponents
============================================================================= */

function MetaLine({ details, estimator }) {
  const meta = details?.meta || estimator?.meta || null;
  const runId =
    details?.runId || details?.meta?.runId || details?.run?.id || null;
  const createdAt = details?.createdAt || details?.run?.createdAt || null;

  if (!meta && !runId && !createdAt) return null;

  const pills = [
    runId ? { label: "Run", value: String(runId), mono: true } : null,
    meta?.domain ? { label: "Domain", value: String(meta.domain) } : null,
    meta?.type ? { label: "Type", value: String(meta.type) } : null,
    createdAt ? { label: "Created", value: formatDate(createdAt) } : null,
  ].filter(Boolean);

  if (!pills.length) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {pills.map((p, i) => (
        <span
          key={`${p.label}-${i}`}
          className={[
            "inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-700",
            p.mono ? "font-mono" : "",
          ].join(" ")}
        >
          <span className="text-neutral-500">{p.label}:</span>
          <span className="truncate">{p.value}</span>
        </span>
      ))}
    </div>
  );
}

function SectionCard({ section }) {
  const { title, description, items, content } = section;

  return (
    <section className="rounded-xl border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-4 py-3">
        <div className="text-sm font-semibold text-neutral-900">{title}</div>
        {description ? (
          <div className="mt-1 text-xs text-neutral-600">{description}</div>
        ) : null}
      </div>

      <div className="px-4 py-3">
        {content ? (
          <div className="text-sm text-neutral-800">{content}</div>
        ) : null}

        {Array.isArray(items) && items.length ? (
          <dl className="grid grid-cols-1 gap-3">
            {items.map((it, idx) => (
              <div
                key={`${it.label}-${idx}`}
                className="rounded-lg bg-neutral-50 px-3 py-2"
              >
                <dt className="text-xs font-medium text-neutral-700">
                  {it.label}
                </dt>
                <dd
                  className={[
                    "mt-1 text-sm text-neutral-900",
                    it.mono ? "font-mono" : "",
                    isLongString(it.value) ? "break-words" : "truncate",
                  ].join(" ")}
                  title={typeof it.value === "string" ? it.value : undefined}
                >
                  {renderValue(it.value)}
                </dd>
                {it.hint ? (
                  <div className="mt-1 text-xs text-neutral-600">{it.hint}</div>
                ) : null}
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </section>
  );
}

function CopyJsonButton({ payload, label = "Copy" }) {
  const onCopy = async () => {
    try {
      const text = safeStringify(payload, 2);
      await navigator.clipboard.writeText(text);
      // Optional: you can replace this with SSA toast eventBus hook if you have it.
    } catch {
      // noop
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-400"
    >
      {label}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent"
    />
  );
}

/* =============================================================================
   Helpers (focus trap, formatting, safe stringify, object normalization)
============================================================================= */

function getFocusable(root) {
  if (!root) return [];
  const selectors = [
    'a[href]:not([tabindex="-1"])',
    'button:not([disabled]):not([tabindex="-1"])',
    'textarea:not([disabled]):not([tabindex="-1"])',
    'input:not([disabled]):not([tabindex="-1"])',
    'select:not([disabled]):not([tabindex="-1"])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  const nodes = Array.from(root.querySelectorAll(selectors));
  return nodes.filter((el) => isVisible(el));
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    el.offsetParent !== null
  );
}

function trapTabKey(e, panel) {
  if (!panel) return;
  const focusables = getFocusable(panel);
  if (!focusables.length) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (e.shiftKey) {
    if (active === first || active === panel) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

function safeStringify(obj, space = 2) {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      if (typeof value === "function") return "[Function]";
      if (typeof value === "bigint") return value.toString();
      return value;
    },
    space,
  );
}

function formatDate(value) {
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(value);
  }
}

function renderValue(v) {
  if (v === null) return <span className="text-neutral-500">null</span>;
  if (v === undefined) return <span className="text-neutral-500">—</span>;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    if (!v.length) return <span className="text-neutral-500">[]</span>;
    // Render arrays compactly, but readable.
    return (
      <div className="space-y-1">
        {v.slice(0, 10).map((x, i) => (
          <div key={i} className="text-sm">
            • {typeof x === "string" ? x : safeStringify(x, 0)}
          </div>
        ))}
        {v.length > 10 ? (
          <div className="text-xs text-neutral-600">
            …and {v.length - 10} more
          </div>
        ) : null}
      </div>
    );
  }
  // Objects: compact preview
  return <code className="font-mono text-xs">{safeStringify(v, 0)}</code>;
}

function isLongString(v) {
  return typeof v === "string" && v.length > 80;
}

function objectToItems(obj) {
  // Convert object to [{label,value}] preserving key order.
  // If values are nested objects, we keep them as object for renderValue().
  if (!obj || typeof obj !== "object") return [];
  const entries = Object.entries(obj);

  return entries
    .filter(([k]) => k !== "$schema")
    .map(([k, v]) => ({
      label: humanizeKey(k),
      value: v,
      mono: typeof v === "string" && looksLikeIdOrToken(v),
    }));
}

function humanizeKey(key) {
  // turns "foodSecurityScore" -> "Food Security Score"
  // and "cost_delta" -> "Cost Delta"
  const s = String(key)
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(key);
}

function looksLikeIdOrToken(s) {
  return (
    /^[a-z0-9_.:-]{8,}$/i.test(s) ||
    s.includes("cuisines.") ||
    s.includes("estimators.")
  );
}
