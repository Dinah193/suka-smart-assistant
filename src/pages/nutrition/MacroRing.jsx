// src/pages/nutrition/MacroRing.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

// Soft deps: event bus is optional
let eventBus = { emit: () => {}, on: () => () => {} };
try { eventBus = require("@/services/events/eventBus").eventBus; } catch {}

const CX = (...a) => a.filter(Boolean).join(" ");
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };

/**
 * MacroRing
 * -----------------------------------------------------------------------------
 * A11y-friendly animated donut with value, label, and optional delta-to-goal.
 *
 * Props:
 *  - size         : number px (default 72)
 *  - stroke       : number px (default 8)
 *  - pct          : 0..100 number (required)
 *  - value        : display string (e.g., "86 g")
 *  - label        : "Protein" | "Carbs" | "Fat" | string
 *  - colorClass   : tailwind classes for the active stroke (e.g., "text-primary")
 *  - goalPct      : optional target % to show delta (+/−)
 *  - compact      : boolean; hides delta row and reduces font sizes
 *  - onClick      : function; click handler
 *  - ariaLabel    : override accessible label (otherwise auto-built)
 */
export function MacroRing({
  size = 72,
  stroke = 8,
  pct = 0,
  value = "",
  label = "",
  colorClass = "text-primary",
  goalPct = null,
  compact = false,
  onClick,
  ariaLabel,
  className,
}) {
  const radius = (size / 2) - stroke / 2;
  const C = 2 * Math.PI * radius;

  // simple tween on mount/update
  const [animPct, setAnimPct] = useState(0);
  useEffect(() => {
    let raf;
    const start = performance.now();
    const dur = 420; // ms
    const from = animPct;
    const to = Math.max(0, Math.min(100, pct));
    const tick = (t) => {
      const k = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      setAnimPct(from + (to - from) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pct]);

  const dash = (Math.max(0, Math.min(100, animPct)) / 100) * C;
  const rest = C - dash;
  const aria = ariaLabel || `${label} ${Math.round(pct)}%${goalPct != null ? `; goal ${goalPct}%` : ""}`;

  const delta = goalPct == null ? null : Math.round(pct - goalPct);
  const deltaTone = delta == null
    ? ""
    : delta === 0
      ? "text-muted-foreground"
      : delta > 0
        ? "text-emerald-600"
        : "text-rose-600";

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={aria}
      onClick={onClick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick?.(e)}
      className={CX("group inline-flex items-center gap-3 select-none", className)}
      title={aria}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle
          cx={size/2} cy={size/2} r={radius}
          strokeWidth={stroke} fill="none"
          className="text-muted/30"
          stroke="currentColor"
          opacity={0.25}
        />
        <circle
          cx={size/2} cy={size/2} r={radius}
          strokeWidth={stroke} fill="none"
          strokeDasharray={`${dash} ${rest}`}
          strokeLinecap="round"
          className={colorClass}
          stroke="currentColor"
          transform={`rotate(-90 ${size/2} ${size/2})`}
        />
        {/* Center value */}
        <g pointerEvents="none">
          <text
            x="50%" y="48%"
            textAnchor="middle"
            className={CX("font-semibold", compact ? "text-xs" : "text-sm")}
          >
            {Math.round(pct)}%
          </text>
          {!compact && (
            <text x="50%" y="66%" textAnchor="middle" className="text-[10px] fill-muted-foreground">
              {value}
            </text>
          )}
        </g>
      </svg>

      <div className="leading-tight min-w-[84px]">
        <div className={CX("font-medium", compact ? "text-xs" : "text-sm")}>{label}</div>
        <div className={CX("text-xs text-muted-foreground", compact ? "hidden" : "block")}>
          {value}
          {goalPct != null && (
            <>
              {" • "}
              <span className={deltaTone}>
                {delta === 0 ? "on target" : delta > 0 ? `+${delta}%` : `${delta}%`}
              </span>
            </>
          )}
        </div>
        {/* hover hint */}
        <div className="text-[10px] text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition">
          Click for swaps
        </div>
      </div>
    </div>
  );
}

/**
 * MacroRingsGroup
 * -----------------------------------------------------------------------------
 * Convenience component to show Protein/Carbs/Fat rings together.
 *
 * Props:
 *  - totals  : { protein_g, carbs_g, fat_g, calories? }
 *  - targets : { protein_g?, carbs_g?, fat_g?, calories? } (optional)
 *  - onInspect(macroKey) : optional click handler
 *  - compact : boolean (smaller layout for sidebars)
 */
export function MacroRingsGroup({
  totals = { protein_g: 0, carbs_g: 0, fat_g: 0, calories: 0 },
  targets = null,
  onInspect,
  compact = false,
  className,
}) {
  const kcalProtein = (totals.protein_g || 0) * KCAL_PER_G.protein;
  const kcalCarbs   = (totals.carbs_g   || 0) * KCAL_PER_G.carbs;
  const kcalFat     = (totals.fat_g     || 0) * KCAL_PER_G.fat;
  const kcalTotal   = Math.max(1, totals.calories || (kcalProtein + kcalCarbs + kcalFat));

  const pPct = Math.round((kcalProtein / kcalTotal) * 100);
  const cPct = Math.round((kcalCarbs   / kcalTotal) * 100);
  const fPct = Math.round((kcalFat     / kcalTotal) * 100);

  // Optional goal % from targets
  const tKcal = Math.max(1,
    (targets?.protein_g || 0) * KCAL_PER_G.protein +
    (targets?.carbs_g   || 0) * KCAL_PER_G.carbs +
    (targets?.fat_g     || 0) * KCAL_PER_G.fat
  );
  const gpPct = targets ? Math.round(((targets?.protein_g || 0) * KCAL_PER_G.protein / tKcal) * 100) : null;
  const gcPct = targets ? Math.round(((targets?.carbs_g   || 0) * KCAL_PER_G.carbs   / tKcal) * 100) : null;
  const gfPct = targets ? Math.round(((targets?.fat_g     || 0) * KCAL_PER_G.fat     / tKcal) * 100) : null;

  const handle = (key) => {
    onInspect?.(key);
    // Emit a helpful event for your Suggest Swaps flow
    eventBus.emit("nutrition.macro.inspect", { macro: key, totals, targets });
    eventBus.emit("nutrition.suggestSwap", { macro: key, scope: null, gaps: computeGaps(totals, targets) });
  };

  return (
    <div className={CX("grid grid-cols-3 gap-3", className)}>
      <MacroRing
        pct={pPct}
        value={`${Math.round(totals.protein_g || 0)} g`}
        label="Protein"
        colorClass="text-indigo-600 dark:text-indigo-400"
        goalPct={gpPct}
        compact={compact}
        onClick={() => handle("protein")}
      />
      <MacroRing
        pct={cPct}
        value={`${Math.round(totals.carbs_g || 0)} g`}
        label="Carbs"
        colorClass="text-blue-600 dark:text-blue-400"
        goalPct={gcPct}
        compact={compact}
        onClick={() => handle("carbs")}
      />
      <MacroRing
        pct={fPct}
        value={`${Math.round(totals.fat_g || 0)} g`}
        label="Fat"
        colorClass="text-amber-600 dark:text-amber-400"
        goalPct={gfPct}
        compact={compact}
        onClick={() => handle("fat")}
      />
    </div>
  );
}

/**
 * Skeleton macro row — use during loading states
 */
export function MacroRingsSkeleton({ className }) {
  return (
    <div className={CX("grid grid-cols-3 gap-3", className)}>
      {[0,1,2].map((i) => (
        <div key={i} className="animate-pulse inline-flex items-center gap-3">
          <div className="rounded-full bg-muted h-18 w-18" style={{ height: 72, width: 72 }} />
          <div className="space-y-2">
            <div className="h-3 w-20 rounded bg-muted" />
            <div className="h-2 w-24 rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------- helpers ------------------------- */

function computeGaps(totals = {}, targets = {}) {
  if (!targets) return {};
  const gap = (k) => (targets?.[k] ?? 0) - (totals?.[k] ?? 0);
  return {
    protein_g: gap("protein_g"),
    carbs_g: gap("carbs_g"),
    fat_g: gap("fat_g"),
    calories: gap("calories"),
  };
}

export default MacroRing;
