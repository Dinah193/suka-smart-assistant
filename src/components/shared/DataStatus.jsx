// src/components/shared/DataStatus.jsx
// A dynamic, reusable data state indicator for Suka Smart Assistant.
// Inspired by Notion, Linear, and GitHub: compact, informative, and actionable.
// No alias imports; Tailwind for styling; lightweight helpers + inline tests.

import React, { useEffect, useMemo, useRef, useState } from "react";

const cx = (...xs) => xs.filter(Boolean).join(" ");

/* --------------------------------------------------------------------------
   Types (doc)
   state: "idle" | "loading" | "success" | "error" | "empty" | "stale" | "syncing" | "offline"
---------------------------------------------------------------------------- */

/**
 * Props
 * - state: data state string (see above)
 * - message?: string                          // optional human text
 * - count?: number                            // number of items loaded
 * - lastUpdated?: number | string | Date      // timestamp for staleness display
 * - error?: { code?: string, message?: string } | string | null
 * - actions?: Array<{ key: string, label: string, onClick: () => void, primary?: boolean }>
 * - onRetry?: () => void
 * - onRefresh?: () => void
 * - compact?: boolean
 * - pill?: boolean                            // render as pill/badge style
 * - showSkeleton?: boolean                    // show skeleton rows when loading
 * - skeletonRows?: number                     // default 3
 * - stalenessMs?: number                      // when to label state as stale (default 5 min)
 * - optimistic?: boolean                      // show optimistic indicator
 * - syncingPct?: number                       // 0-100 when syncing
 * - align?: 'left' | 'center' | 'right'
 */
export default function DataStatus({
  state = "idle",
  message = "",
  count = undefined,
  lastUpdated = null,
  error = null,
  actions = [],
  onRetry,
  onRefresh,
  compact = false,
  pill = false,
  showSkeleton = false,
  skeletonRows = 3,
  stalenessMs = 5 * 60 * 1000,
  optimistic = false,
  syncingPct = undefined,
  align = "left",
}) {
  const now = useNowTicker(30000); // update every 30s for time-ago
  const stamp = useMemo(() => normalizeDate(lastUpdated), [lastUpdated]);
  const isStale = useMemo(() => !!stamp && Date.now() - stamp.getTime() > stalenessMs, [stamp, stalenessMs, now]);

  const derived = deriveState({ state, stamp, isStale, hasError: !!error });
  // NOTE: removed pickIcon() call (was causing ReferenceError). Tone covers visuals.
  const tone = pickTone(derived);

  const alignCls = align === "center" ? "justify-center" : align === "right" ? "justify-end" : "";

  const wrapperCls = pill
    ? cx(
        "inline-flex items-center gap-2 rounded-full border px-2 py-1",
        compact ? "text-[11px]" : "text-xs",
        tone.border
      )
    : cx(
        "rounded-2xl border p-2",
        compact ? "text-xs" : "text-sm",
        tone.border,
        derived.state === "error" && "bg-error/5",
        derived.state === "success" && "bg-success/5",
        derived.state === "stale" && "bg-warning/5",
        derived.state === "loading" && "bg-base-100"
      );

  // human message
  const parts = [];
  if (message) parts.push(message);
  if (count !== undefined && derived.state !== "loading") parts.push(`${count} item${count === 1 ? "" : "s"}`);
  if (stamp) parts.push("Updated " + formatTimeAgo(stamp, now));
  if (optimistic) parts.push("Pending sync…");
  const line = parts.join(" • ");

  return (
    <div className={cx(pill ? "inline-block" : "w-full")}> 
      <div className={wrapperCls} role="status" aria-live="polite">
        <div className={cx("flex items-center gap-2", alignCls)}>
          <StateDot tone={tone} spinning={derived.state === "loading" || derived.state === "syncing"} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cx("font-medium", compact ? "text-xs" : "text-sm", tone.text)}>
                {labelForState(derived)}
              </span>
              {typeof syncingPct === "number" && (
                <span className="text-[10px] opacity-70">{Math.round(syncingPct)}%</span>
              )}
            </div>
            {line && !pill && (
              <div className={cx("opacity-80", compact ? "text-[11px]" : "text-xs")}>{line}</div>
            )}
          </div>

          {/* Actions */}
          <div className="ml-auto flex items-center gap-2">
            {derived.state === "error" && (
              <button className="btn btn-xs" onClick={onRetry} disabled={!onRetry}>Retry</button>
            )}
            {derived.state !== "loading" && (
              <button className="btn btn-ghost btn-xs" onClick={onRefresh} disabled={!onRefresh}>Refresh</button>
            )}
            {actions?.map((a) => (
              <button key={a.key} className={cx("btn btn-xs", a.primary ? "btn-primary" : "")} onClick={a.onClick}>{a.label}</button>
            ))}
          </div>
        </div>

        {/* Progress bar for syncing/loading */}
        {(derived.state === "loading" || derived.state === "syncing") && !pill && (
          <div className="mt-2 w-full h-1.5 rounded bg-base-200 overflow-hidden">
            <div className={cx("h-1.5", derived.state === "loading" ? "bg-base-300 animate-pulse" : "bg-primary")}
                 style={{ width: typeof syncingPct === "number" ? `${syncingPct}%` : "40%" }} />
          </div>
        )}

        {/* Error detail */}
        {derived.state === "error" && !pill && error && (
          <div className="mt-2 text-[11px] text-error">
            {typeof error === "string" ? error : (error.message || JSON.stringify(error))}
          </div>
        )}

        {/* Empty and skeleton helpers */}
        {derived.state === "empty" && !pill && (
          <div className="mt-2 text-[11px] opacity-70">No data yet. Try adjusting filters or add your first item.</div>
        )}
        {showSkeleton && derived.state === "loading" && !pill && (
          <SkeletonRows rows={skeletonRows} />
        )}

        {/* Stale hint */}
        {derived.state === "stale" && !pill && (
          <div className="mt-2 text-[11px] text-warning">Data may be out of date. Consider refreshing.</div>
        )}

      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Visual bits
---------------------------------------------------------------------------- */
function StateDot({ tone, spinning }) {
  return (
    <span className={cx(
      "inline-flex w-2.5 h-2.5 rounded-full",
      tone.bg,
      spinning && "animate-pulse"
    )} aria-hidden="true" />
  );
}

function SkeletonRows({ rows = 3 }) {
  const arr = Array.from({ length: rows });
  return (
    <div className="mt-2 space-y-1.5" aria-hidden="true">
      {arr.map((_, i) => (
        <div key={i} className="h-8 rounded bg-base-200 animate-pulse" />
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------
   State helpers
---------------------------------------------------------------------------- */
export function deriveState({ state, stamp, isStale, hasError }) {
  // Normalize state with staleness & errors
  if (hasError) return { state: "error" };
  if (state === "loading") return { state };
  if (state === "offline") return { state };
  if (state === "syncing") return { state };
  if (state === "empty") return { state };
  if (state === "success" || state === "idle") {
    return { state: isStale ? "stale" : (stamp ? "success" : "idle") };
  }
  return { state };
}

export function labelForState(derived) {
  switch (derived.state) {
    case "loading": return "Loading";
    case "success": return "Up to date";
    case "stale": return "Stale";
    case "syncing": return "Syncing";
    case "empty": return "Empty";
    case "offline": return "Offline";
    case "error": return "Error";
    default: return "Idle";
  }
}

export function pickTone(derived) {
  switch (derived.state) {
    case "success": return { text: "text-success", bg: "bg-success", border: "border-success/40" };
    case "stale": return { text: "text-warning", bg: "bg-warning", border: "border-warning/40" };
    case "loading": return { text: "text-base-content", bg: "bg-base-300", border: "border-base-300" };
    case "syncing": return { text: "text-primary", bg: "bg-primary", border: "border-primary/40" };
    case "empty": return { text: "text-base-content/70", bg: "bg-base-200", border: "border-base-300" };
    case "offline": return { text: "text-base-content/70", bg: "bg-base-300", border: "border-base-300" };
    case "error": return { text: "text-error", bg: "bg-error", border: "border-error/40" };
    default: return { text: "text-base-content", bg: "bg-base-200", border: "border-base-300" };
  }
}

/* --------------------------------------------------------------------------
   Time helpers
---------------------------------------------------------------------------- */
export function useNowTicker(intervalMs = 30000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), Math.max(500, intervalMs));
    return () => clearInterval(id);
  }, [intervalMs]);
  return Date.now();
}

export function normalizeDate(input) {
  if (!input) return null;
  try {
    if (input instanceof Date) return input;
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

export function formatTimeAgo(date, nowTs = Date.now()) {
  if (!(date instanceof Date)) return "";
  const diff = Math.max(0, nowTs - date.getTime());
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/* --------------------------------------------------------------------------
   Inline tests for non-UI helpers
---------------------------------------------------------------------------- */
function assert(name, cond) { if (!cond) throw new Error("Test failed: " + name); }
export function runDataStatusTests() {
  // normalizeDate
  assert("normalizeDate null", normalizeDate(null) === null);
  assert("normalizeDate ISO", normalizeDate("2024-01-01T00:00:00Z") instanceof Date);
  assert("normalizeDate invalid", normalizeDate("not-a-date") === null);

  // formatTimeAgo
  const base = new Date("2024-01-01T00:00:00Z");
  const ms = base.getTime();
  assert("time just now", formatTimeAgo(base, ms + 3000) === "just now");
  assert("time seconds", formatTimeAgo(base, ms + 9000) === "9s ago");
  assert("time minutes", formatTimeAgo(base, ms + 61*1000).endsWith("m ago"));
  assert("time hours", formatTimeAgo(base, ms + 2*60*60*1000) === "2h ago");
  assert("time days", formatTimeAgo(base, ms + 3*24*60*60*1000) === "3d ago");

  // deriveState
  const ok = deriveState({ state: "success", stamp: new Date(), isStale: false, hasError: false }).state === "success";
  const stale = deriveState({ state: "success", stamp: new Date(0), isStale: true, hasError: false }).state === "stale";
  const err = deriveState({ state: "success", stamp: new Date(), isStale: false, hasError: true }).state === "error";
  const off = deriveState({ state: "offline", stamp: null, isStale: false, hasError: false }).state === "offline";
  assert("deriveState success", ok);
  assert("deriveState stale", stale);
  assert("deriveState error", err);
  assert("deriveState offline", off);

  // pickTone/label
  assert("label loading", labelForState({ state: "loading" }) === "Loading");
  assert("tone success has text-success", pickTone({ state: "success" }).text.includes("success"));
}

if (typeof process === "undefined" || process?.env?.NODE_ENV !== "production") {
  try { runDataStatusTests(); } catch (e) { console.error("DataStatus tests:", e); }
}
