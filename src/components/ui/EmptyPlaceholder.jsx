// src/components/ui/EmptyPlaceholder.jsx
import React, { useCallback, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";

/** class combiner */
const cx = (...xs) => xs.filter(Boolean).join(" ");

/**
 * EmptyPlaceholder
 * - Use when a section/page has no data yet (recipes, meal plan, inventory, cleaning, garden).
 *
 * Props:
 *  - title: node
 *  - subtitle?: node
 *  - variant?: "default"|"brand"|"neutral"|"success"|"warn"|"danger"
 *  - layout?: "inset"|"fullscreen"                      // inset = framed card, fullscreen = center in viewport
 *  - illustration?: node                                // SVG / <img> / Emoji
 *  - icon?: node                                        // fallback to small rounded icon
 *  - actions?: [{ label, icon?, intent?, detail?, onClick?, kind?: 'primary'|'subtle'|'ghost', busyLabel? }]
 *  - secondary?: [{ label, href?, onClick? }]           // subtle link row under actions
 *  - suggestions?: string[]                              // rendered as chips you can click to prefill/trigger
 *  - hotkeys?: string[]                                  // small hint pills (e.g., ["Ctrl+S","Shift+M"])
 *  - dropzone?: {                                        // optional drag-and-drop area
 *      label?: string,
 *      accept?: string[],                                // e.g., ["text/plain","image/*"]
 *      onDrop?: (filesOrText: {files: File[], text?: string}) => void,
 *      busyLabel?: string
 *    }
 *  - error?: string                                      // prominent danger style
 *  - loading?: boolean                                   // skeleton state
 *  - className?: string
 */
export default function EmptyPlaceholder({
  title,
  subtitle,
  variant = "default",
  layout = "inset",
  illustration,
  icon,
  actions = [],
  secondary = [],
  suggestions = [],
  hotkeys = [],
  dropzone,
  error,
  loading = false,
  className = "",
}) {
  const look = useMemo(() => variantToLook(variant), [variant]);
  const frame =
    layout === "fullscreen"
      ? "min-h-[60vh] grid place-items-center p-4"
      : "card p-6 md:p-8";

  return (
    <section
      className={cx(
        frame,
        "text-center border",
        look.bg,
        look.border,
        "bg-[hsl(var(--card))]",
        className
      )}
      role="region"
      aria-label="Empty state"
    >
      <div className={cx("max-w-xl mx-auto", layout === "fullscreen" ? "mt-[-6vh]" : "")}>
        {/* Illustration / icon */}
        <div className="mb-4 flex justify-center">
          {illustration ? (
            <div className="w-28 h-28 md:w-32 md:h-32 grid place-items-center">{illustration}</div>
          ) : icon ? (
            <div
              className={cx(
                "w-12 h-12 grid place-items-center rounded-full border",
                look.icoBg,
                look.border,
                look.icoText
              )}
              aria-hidden
            >
              {icon}
            </div>
          ) : null}
        </div>

        {/* Title / Subtitle / Error / Skeleton */}
        <div className="space-y-2">
          <h2 className="text-2xl md:text-3xl font-extrabold">{loading ? <Skeleton w="12ch" /> : title}</h2>
          {error ? (
            <p className="text-[hsl(var(--danger))]">
              {error}
            </p>
          ) : (
            <p className="text-[hsl(var(--muted-foreground))]">
              {loading ? <Skeleton w="36ch" /> : subtitle}
            </p>
          )}
        </div>

        {/* Dropzone */}
        {dropzone ? <Dropzone {...dropzone} variantLook={look} disabled={loading} /> : null}

        {/* Suggestions (chips) */}
        {suggestions?.length ? (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {suggestions.map((s, i) => (
              <button
                key={`${s}-${i}`}
                type="button"
                className="chip"
                onClick={() => {
                  // broadcast a suggestion usage for analytics/agents
                  window.dispatchEvent(new CustomEvent("placeholder:suggest", { detail: { value: s } }));
                }}
                title={s}
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        {/* Hotkey pills */}
        {hotkeys?.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5 justify-center">
            {hotkeys.map((hk, i) => (
              <span key={`${hk}-${i}`} className="pill">{hk}</span>
            ))}
          </div>
        ) : null}

        {/* Actions */}
        {actions?.length ? (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {actions.map((a, idx) => (
              <ActionButton key={`${a.label}-${idx}`} {...a} />
            ))}
          </div>
        ) : null}

        {/* Secondary links */}
        {secondary?.length ? (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3 text-sm">
            {secondary.map((s, idx) =>
              s.href ? (
                <a key={idx} className="underline hover:no-underline" href={s.href} onClick={s.onClick}>
                  {s.label}
                </a>
              ) : (
                <button key={idx} type="button" className="btn ghost" onClick={s.onClick}>
                  {s.label}
                </button>
              )
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/* -------------------------------- subcomponents -------------------------- */

function ActionButton({ label, icon, kind = "primary", busyLabel, intent, detail, onClick }) {
  const [busy, setBusy] = useState(false);
  const classMap = { primary: "btn primary", subtle: "btn subtle", ghost: "btn" };
  return (
    <button
      type="button"
      className={classMap[kind] || classMap.primary}
      aria-busy={busy ? "true" : "false"}
      onMouseDown={(e) => e.currentTarget.classList.add("is-pressed")}
      onMouseUp={(e) => e.currentTarget.classList.remove("is-pressed")}
      onClick={async () => {
        try {
          setBusy(true);
          if (onClick) {
            await onClick();
          } else if (intent) {
            window.dispatchEvent(new CustomEvent("automation:intent", { detail: { intent, ...(detail || {}) } }));
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

function Dropzone({ label = "Drop files here (or paste URL / text)…", accept, onDrop, busyLabel, variantLook, disabled }) {
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  const acceptMatch = useCallback(
    (f) => {
      if (!accept || !accept.length) return true;
      return accept.some((a) => {
        if (a.endsWith("/*")) {
          const base = a.split("/")[0];
          return (f.type || "").startsWith(base + "/");
        }
        return f.type === a;
      });
    },
    [accept]
  );

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag(false);
    if (disabled) return;

    const files = Array.from(e.dataTransfer?.files || []).filter(acceptMatch);
    let text = undefined;

    if (!files.length) {
      // maybe it's a URL/text drop
      text = e.dataTransfer?.getData("text") || undefined;
    }

    if (!files.length && !text) return;
    try {
      setBusy(true);
      await onDrop?.({ files, text });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      className={cx(
        "mt-4 p-4 rounded-[var(--radius-lg)] border border-dashed transition-colors",
        drag ? "ring-2 ring-offset-2 ring-[hsl(var(--brand))]" : "",
        variantLook.dropBg,
        "cursor-pointer"
      )}
      role="button"
      tabIndex={0}
      onDragEnter={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDrag(false);
      }}
      onDrop={handleDrop}
      onClick={() => {
        // programmatically open a file picker
        if (disabled) return;
        const input = document.createElement("input");
        input.type = "file";
        if (accept?.length) input.accept = accept.join(",");
        input.multiple = true;
        input.onchange = async () => {
          const files = Array.from(input.files || []).filter(acceptMatch);
          if (!files.length) return;
          setBusy(true);
          try {
            await onDrop?.({ files });
          } finally {
            setBusy(false);
          }
        };
        input.click();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.currentTarget.click();
        }
      }}
      aria-label="Upload area"
    >
      <div className="flex items-center justify-center gap-2 text-sm">
        <span aria-hidden>📎</span>
        <span className="select-none">
          {busy ? busyLabel || "Processing…" : label}
        </span>
      </div>
    </div>
  );
}

function Skeleton({ w = "20ch" }) {
  return <span className="inline-block align-middle skeleton rounded-[8px]" style={{ height: 18, width: w }} />;
}

/* -------------------------------- helpers -------------------------------- */

function variantToLook(v) {
  switch (v) {
    case "brand":
      return {
        bg: "bg-[hsl(var(--brand-weak))]",
        border: "border-[hsl(var(--border))]",
        icoBg: "bg-[hsl(var(--brand-weak))/0.6]",
        icoText: "text-[hsl(var(--brand-ink))]",
        dropBg: "bg-[hsl(var(--brand-weak))/0.6]",
      };
    case "neutral":
      return {
        bg: "bg-[hsl(var(--muted))/0.2]",
        border: "border-[hsl(var(--border))]",
        icoBg: "bg-[hsl(var(--muted))/0.3]",
        icoText: "text-[hsl(var(--foreground))]",
        dropBg: "bg-[hsl(var(--muted))/0.25]",
      };
    case "success":
      return {
        bg: "bg-[hsl(var(--success))/0.12]",
        border: "border-[hsl(var(--success))/0.35]",
        icoBg: "bg-[hsl(var(--success))/0.2]",
        icoText: "text-[hsl(var(--success))]",
        dropBg: "bg-[hsl(var(--success))/0.12]",
      };
    case "warn":
      return {
        bg: "bg-[hsl(var(--warn))/0.12]",
        border: "border-[hsl(var(--warn))/0.35]",
        icoBg: "bg-[hsl(var(--warn))/0.2]",
        icoText: "text-[hsl(var(--warn))]",
        dropBg: "bg-[hsl(var(--warn))/0.12]",
      };
    case "danger":
      return {
        bg: "bg-[hsl(var(--danger))/0.12]",
        border: "border-[hsl(var(--danger))/0.35]",
        icoBg: "bg-[hsl(var(--danger))/0.2]",
        icoText: "text-[hsl(var(--danger))]",
        dropBg: "bg-[hsl(var(--danger))/0.12]",
      };
    case "default":
    default:
      return {
        bg: "bg-[hsl(var(--card))]",
        border: "border-[hsl(var(--border))]",
        icoBg: "bg-[hsl(var(--muted))/0.28]",
        icoText: "text-[hsl(var(--foreground))]",
        dropBg: "bg-[hsl(var(--muted))/0.22]",
      };
  }
}

/* -------------------------------- prop types ------------------------------ */
EmptyPlaceholder.propTypes = {
  title: PropTypes.node.isRequired,
  subtitle: PropTypes.node,
  variant: PropTypes.oneOf(["default", "brand", "neutral", "success", "warn", "danger"]),
  layout: PropTypes.oneOf(["inset", "fullscreen"]),
  illustration: PropTypes.node,
  icon: PropTypes.node,
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
  secondary: PropTypes.arrayOf(
    PropTypes.shape({
      label: PropTypes.node.isRequired,
      href: PropTypes.string,
      onClick: PropTypes.func,
    })
  ),
  suggestions: PropTypes.arrayOf(PropTypes.string),
  hotkeys: PropTypes.arrayOf(PropTypes.string),
  dropzone: PropTypes.shape({
    label: PropTypes.string,
    accept: PropTypes.arrayOf(PropTypes.string),
    onDrop: PropTypes.func,
    busyLabel: PropTypes.string,
  }),
  error: PropTypes.string,
  loading: PropTypes.bool,
  className: PropTypes.string,
};
