// src/components/meals/TargetsBadge.jsx
// Dynamic, self-contained component for visualizing daily macro targets,
// per‑meal splits, and remaining budget. Designed to work in sandbox without
// alias imports; in your app, you can swap the store shims for real stores.

import React, { useMemo, useState } from "react";

/* ----------------------------------------------------------------------------
   Minimal helpers (replace with your project utils if desired)
---------------------------------------------------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function pct(n, d) { if (!d) return 0; return (n / d) * 100; }
function round(n, p = 0) { const s = Math.pow(10, p); return Math.round((n + Number.EPSILON) * s) / s; }

// Normalize per‑meal split map of percentages into fractions that sum to 1.
export function getMealWeights(split) {
  const base = split || { Breakfast: 33.34, Lunch: 33.33, Dinner: 33.33, Snack: 0 };
  const total = Object.values(base).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) || 100;
  const norm = {}; for (const k of Object.keys(base)) norm[k] = (base[k] ?? 0) / total; return norm;
}

// Convert daily macro % targets into grams; keep calories as-is.
export function macrosFromPct({ calories, proteinPct, fatPct, carbsPct }) {
  const protein = round((calories * (proteinPct / 100)) / 4);
  const fat = round((calories * (fatPct / 100)) / 9);
  const carbs = round((calories * (carbsPct / 100)) / 4);
  return { calories, protein, fat, carbs };
}

// Compute per‑meal gram targets from daily + split; omit disabled meals if provided.
export function perMealTargets(dailyTargets, split, enabledSlots) {
  const weights = getMealWeights(split);
  const t = macrosFromPct(dailyTargets);
  const out = {};
  const slots = Object.keys(weights);
  const enabled = enabledSlots || slots.reduce((m, k) => (m[k] = true, m), {});
  for (const k of slots) {
    if (!enabled[k]) continue;
    const w = weights[k] ?? 0;
    out[k] = {
      calories: round(t.calories * w),
      protein: round(t.protein * w),
      fat: round(t.fat * w),
      carbs: round(t.carbs * w),
    };
  }
  return out;
}

/* ----------------------------------------------------------------------------
   TargetsBadge
   Props:
   - dailyTargets: { calories, proteinPct, fatPct, carbsPct }
   - mealSplit: { Breakfast, Lunch, Dinner, Snack } (percentages)
   - enabledSlots: map of slot->boolean
   - dayTotals: aggregate for the planned day { kcal, protein, fat, carbs }
   - compact: boolean (smaller chip)
   - showPerMeal: boolean (show per‑meal table in popover)
   - season: { isPassoverSeason?: boolean, isSabbath?: boolean }
---------------------------------------------------------------------------- */
export default function TargetsBadge({
  dailyTargets = { calories: 2000, proteinPct: 30, fatPct: 30, carbsPct: 40 },
  mealSplit = { Breakfast: 25, Lunch: 35, Dinner: 40, Snack: 0 },
  enabledSlots = { Breakfast: true, Lunch: true, Dinner: true, Snack: true },
  dayTotals = { kcal: 0, protein: 0, fat: 0, carbs: 0 },
  compact = false,
  showPerMeal = true,
  season = { isPassoverSeason: false, isSabbath: false },
}) {
  const [open, setOpen] = useState(false);

  const computed = useMemo(() => {
    const daily = macrosFromPct(dailyTargets);
    const over = {
      calories: clamp(dayTotals.kcal - daily.calories, -Infinity, Infinity),
      protein: clamp(dayTotals.protein - daily.protein, -Infinity, Infinity),
      fat: clamp(dayTotals.fat - daily.fat, -Infinity, Infinity),
      carbs: clamp(dayTotals.carbs - daily.carbs, -Infinity, Infinity),
    };
    const remain = {
      calories: daily.calories - dayTotals.kcal,
      protein: daily.protein - dayTotals.protein,
      fat: daily.fat - dayTotals.fat,
      carbs: daily.carbs - dayTotals.carbs,
    };
    const totalPct = round(
      pct(dayTotals.kcal, daily.calories), 1
    );
    const splitTotal = Object.values(mealSplit).reduce((a,b)=>a + (Number.isFinite(b)?b:0), 0);
    const perMeal = perMealTargets(dailyTargets, mealSplit, enabledSlots);
    return { daily, remain, over, totalPct, splitTotal, perMeal };
  }, [dailyTargets, dayTotals, mealSplit, enabledSlots]);

  const chip = (
    <button className={cx(
      "inline-flex items-center gap-1 rounded-full",
      compact ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs",
      "border border-base-300 bg-base-100 hover:bg-base-200/60"
    )} onClick={() => setOpen(!open)} title="View macro targets & remaining">
      <span className="font-medium">Targets</span>
      <span className="opacity-70">
        {computed.remain.calories >= 0 ? `${computed.remain.calories} kcal left` : `${Math.abs(computed.remain.calories)} over`}
      </span>
      <span className="opacity-60">· P {Math.max(0, computed.remain.protein)}g · F {Math.max(0, computed.remain.fat)}g · C {Math.max(0, computed.remain.carbs)}g</span>
      {season.isPassoverSeason && <span className="ml-1 badge badge-ghost badge-xs">Passover‑Safe</span>}
      {season.isSabbath && <span className="ml-1 badge badge-ghost badge-xs">Sabbath‑Ease</span>}
    </button>
  );

  return (
    <div className="relative inline-block">
      {chip}
      {open && (
        <div className="absolute z-20 mt-2 w-80 max-w-[90vw] rounded-xl border bg-base-100 shadow p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">Daily Targets</div>
            <button className="btn btn-ghost btn-xs" onClick={() => setOpen(false)}>Close</button>
          </div>

          {/* Totals Bar */}
          <TotalsBar daily={computed.daily} totals={dayTotals} />

          {/* Split warning */}
          {computed.splitTotal !== 100 && (
            <div className="mt-2 text-[11px] text-warning">
              Split sums to {computed.splitTotal}%. We normalize to 100% for per‑meal targets.
            </div>
          )}

          {/* Per‑meal targets */}
          {showPerMeal && (
            <div className="mt-2">
              <div className="text-xs font-semibold uppercase tracking-wide opacity-70 mb-1">Per‑meal targets</div>
              <PerMealTable perMeal={computed.perMeal} enabledSlots={enabledSlots} />
            </div>
          )}

          {/* Legend */}
          <div className="mt-3 text-[10px] opacity-70">
            Targets are computed from daily calories + macro % and distributed via your per‑meal split.
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Subcomponents
---------------------------------------------------------------------------- */
function TotalsBar({ daily, totals }) {
  const usedPct = pct(totals.kcal, daily.calories);
  const remain = Math.max(0, daily.calories - totals.kcal);
  const over = Math.max(0, totals.kcal - daily.calories);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span>{totals.kcal}/{daily.calories} kcal</span>
        <span>{round(usedPct,1)}%</span>
      </div>
      <div className="w-full h-2 rounded-full bg-base-200 overflow-hidden">
        <div className="h-2 bg-primary" style={{ width: `${clamp(usedPct, 0, 120)}%` }} />
      </div>
      <div className="flex gap-2 text-[10px] opacity-75">
        <span>Remain: {remain}</span>
        {over > 0 && <span>· Over: {over}</span>}
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px] mt-1">
        <MacroRow label="Protein" used={totals.protein} target={daily.protein} unit="g" />
        <MacroRow label="Fat" used={totals.fat} target={daily.fat} unit="g" />
        <MacroRow label="Carbs" used={totals.carbs} target={daily.carbs} unit="g" />
      </div>
    </div>
  );
}

function MacroRow({ label, used, target, unit }) {
  const usedPct = pct(used, target);
  return (
    <div>
      <div className="flex items-center justify-between"><span>{label}</span><span>{used}/{target}{unit}</span></div>
      <div className="w-full h-1.5 rounded bg-base-200 overflow-hidden"><div className="h-1.5 bg-secondary" style={{ width: `${clamp(usedPct,0,120)}%`}}/></div>
    </div>
  );
}

function PerMealTable({ perMeal, enabledSlots }) {
  const entries = Object.entries(perMeal);
  if (!entries.length) return <div className="text-[11px] opacity-60">No meals enabled.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="table table-compact w-full">
        <thead>
          <tr>
            <th className="text-[11px] font-semibold">Meal</th>
            <th className="text-[11px] font-semibold">kcal</th>
            <th className="text-[11px] font-semibold">P</th>
            <th className="text-[11px] font-semibold">F</th>
            <th className="text-[11px] font-semibold">C</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className={!enabledSlots[k] ? "opacity-40" : ""}>
              <td className="text-xs">{k}</td>
              <td className="text-xs">{v.calories}</td>
              <td className="text-xs">{v.protein}g</td>
              <td className="text-xs">{v.fat}g</td>
              <td className="text-xs">{v.carbs}g</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Inline tests (dev/demo) — optional
---------------------------------------------------------------------------- */
function assert(name, cond) { if (!cond) throw new Error("Test failed: "+name); }
export function runTargetsBadgeTests() {
  const daily = { calories: 2100, proteinPct: 30, fatPct: 30, carbsPct: 40 };
  const t = macrosFromPct(daily);
  assert("macrosFromPct calories", t.calories === 2100);
  assert("macrosFromPct grams positive", t.protein > 0 && t.fat > 0 && t.carbs > 0);

  const weights = getMealWeights({ Breakfast: 20, Lunch: 30, Dinner: 50, Snack: 0 });
  const sum = Object.values(weights).reduce((a,b)=>a+b,0);
  assert("weights sum ~1", Math.abs(sum - 1) < 1e-6);

  const per = perMealTargets(daily, { Breakfast: 20, Lunch: 30, Dinner: 50, Snack: 0 }, { Breakfast:true, Lunch:true, Dinner:true, Snack:false });
  assert("perMealTargets has Dinner", per.Dinner && per.Dinner.calories > 0);
  assert("Snack omitted when disabled", !per.Snack);

  const totals = { kcal: 1000, protein: 50, fat: 40, carbs: 110 };
  // Smoke test the component (not rendering here, but compute path via React is trivial)
  void totals;
}

if (typeof process === "undefined" || process?.env?.NODE_ENV !== "production") {
  try { runTargetsBadgeTests(); } catch (e) { console.error("TargetsBadge tests:", e); }
}
