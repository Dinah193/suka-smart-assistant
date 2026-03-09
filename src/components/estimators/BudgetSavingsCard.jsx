// C:\Users\larho\suka-smart-assistant\src\components\estimators\BudgetSavingsCard.jsx
//
// BudgetSavingsCard
// -----------------
// Deterministic estimator UI card for budget relief / savings.
//
// Primary goals:
// - Show "monthly savings" and its drivers (grocery delta, eating-out delta, scratch-cooking effect, etc.)
// - Read latest estimator snapshot + baseline and render a clean explanation
// - Progressive disclosure for details to prevent overwhelm
//
// Data sources (preferred):
// - estimator_snapshots repo:  src/services/repos/estimators/snapshots.repo.js
// - estimator_baselines repo:  src/services/repos/estimators/baselines.repo.js
// - homestead_profile repo:    src/services/repos/homestead/homesteadProfile.repo.js
//
// Props:
// - householdId?: string (recommended)
// - personId?: string (optional)
// - snapshotId?: string (optional)
// - title?: string
// - showDetails?: boolean (default true)
// - compact?: boolean (default false)
// - currency?: string (default "USD")
// - onCreateBaseline?: () => void
// - onRunEstimator?: () => void
// - onOpenHistory?: () => void
// - className?: string
//
// Snapshot expected shape (flexible):
// {
//   id, householdId, personId?,
//   createdAt, updatedAt,
//   metrics: {
//     monthlySavings: number,
//     grocerySpendMonthly: number,
//     eatingOutSpendMonthly: number,
//     baselineGrocerySpendMonthly?: number,
//     baselineEatingOutSpendMonthly?: number,
//     postGrocerySpendMonthly?: number,
//     postEatingOutSpendMonthly?: number,
//   },
//   deltas?: {
//     monthlySavingsDelta?: number
//   },
//   breakdown?: {
//     drivers?: Array<{
//       label: string,
//       value?: string|number,
//       amount?: number,
//       impact?: "positive"|"negative"|"neutral"
//     }>,
//     assumptions?: string[],
//     scratchCookingPct?: number,
//     homesteadLevel?: string
//   }
// }
//
// Baseline expected shape (flexible):
// {
//   grocerySpendMonthly,
//   eatingOutSpendMonthly,
//   eatingOutFrequencyPerWeek,
//   householdSize,
//   mealsPerWeek
// }
//
// Notes:
// - This component is repo-shape tolerant: it adapts to missing fields safely.
//
import React, { useEffect, useMemo, useState } from "react";

import * as BaselinesRepo from "@/services/repos/estimators/baselines.repo";
import * as SnapshotsRepo from "@/services/repos/estimators/snapshots.repo";
import * as HomesteadProfileRepo from "@/services/repos/homestead/homesteadProfile.repo";

// Optional: ProgressiveDisclosurePanel, DismissibleTip
let ProgressiveDisclosurePanel = null;
try {
  // eslint-disable-next-line import/no-unresolved
  ProgressiveDisclosurePanel = (
    await import("@/components/homestead/ProgressiveDisclosurePanel.jsx")
  ).default;
} catch {
  ProgressiveDisclosurePanel = null;
}

let DismissibleTip = null;
try {
  // eslint-disable-next-line import/no-unresolved
  DismissibleTip = (await import("@/components/homestead/DismissibleTip.jsx"))
    .default;
} catch {
  DismissibleTip = null;
}

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function formatMoney(value, currency = "USD") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    const r = Math.round(n);
    return `$${r.toLocaleString("en-US")}`;
  }
}

function formatPct(value) {
  const n = safeNum(value);
  if (n == null) return "—";
  return `${Math.round(clamp(n, 0, 100))}%`;
}

function signSymbol(delta) {
  const n = safeNum(delta);
  if (n == null || n === 0) return "";
  return n > 0 ? "+" : "−";
}

function abs(n) {
  const x = safeNum(n);
  return x == null ? null : Math.abs(x);
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-black/10 bg-white p-3">
      <div className="text-xs font-semibold text-black/50">{label}</div>
      <div className="mt-1 text-xl font-extrabold text-black">{value}</div>
      {sub ? <div className="mt-1 text-xs text-black/60">{sub}</div> : null}
    </div>
  );
}

function Button({
  children,
  onClick,
  disabled,
  variant = "subtle",
  className,
  type = "button",
}) {
  const base =
    "inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-black/20 disabled:opacity-50";
  const variants = {
    subtle: "bg-zinc-100 text-black hover:bg-zinc-200",
    ghost: "bg-transparent text-black hover:bg-black/5",
    primary: "bg-black text-white hover:bg-black/90",
  };
  return (
    <button
      type={type}
      className={cx(base, variants[variant], className)}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function Pill({ label, value, kind = "neutral" }) {
  const tone =
    kind === "positive"
      ? "bg-emerald-50 text-emerald-900 border-emerald-200"
      : kind === "negative"
        ? "bg-red-50 text-red-900 border-red-200"
        : "bg-zinc-50 text-black/70 border-black/10";
  return (
    <div
      className={cx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold",
        tone,
      )}
    >
      <span className="opacity-70">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function BarRow({
  label,
  leftValue,
  rightValue,
  deltaValue,
  currency = "USD",
}) {
  // deltaValue is baseline - post (positive is savings)
  const delta = safeNum(deltaValue);
  const kind =
    delta == null
      ? "neutral"
      : delta > 0
        ? "positive"
        : delta < 0
          ? "negative"
          : "neutral";
  return (
    <div className="rounded-xl border border-black/10 bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-bold text-black">{label}</div>
        <Pill
          label="Delta"
          value={
            delta == null
              ? "—"
              : `${delta > 0 ? "+" : "−"}${formatMoney(Math.abs(delta), currency)}`
          }
          kind={kind}
        />
      </div>
      <div className="mt-2 grid gap-2 text-sm text-black/70 md:grid-cols-2">
        <div className="flex items-center justify-between">
          <span className="text-black/60">Baseline</span>
          <span className="font-semibold text-black">
            {formatMoney(leftValue, currency)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-black/60">Estimated after</span>
          <span className="font-semibold text-black">
            {formatMoney(rightValue, currency)}
          </span>
        </div>
      </div>
    </div>
  );
}

async function safeCall(fn, ...args) {
  try {
    if (typeof fn === "function") return await fn(...args);
    return null;
  } catch {
    return null;
  }
}

function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const metrics =
    raw.metrics && typeof raw.metrics === "object" ? raw.metrics : {};
  const deltas = raw.deltas && typeof raw.deltas === "object" ? raw.deltas : {};
  const breakdown =
    raw.breakdown && typeof raw.breakdown === "object" ? raw.breakdown : {};

  return {
    ...raw,
    id: String(raw.id || raw.snapshotId || ""),
    householdId: raw.householdId ? String(raw.householdId) : null,
    personId: raw.personId ? String(raw.personId) : null,
    createdAt: raw.createdAt || raw.createdAtISO || raw.ts || null,
    updatedAt: raw.updatedAt || raw.updatedAtISO || raw.createdAt || null,
    metrics: {
      // primary
      monthlySavings: safeNum(
        metrics.monthlySavings ??
          metrics.monthly_savings ??
          metrics.savingsMonthly,
      ),
      // optional explicit baseline/post components
      baselineGrocerySpendMonthly: safeNum(
        metrics.baselineGrocerySpendMonthly ??
          metrics.baseline_grocery_spend_monthly,
      ),
      baselineEatingOutSpendMonthly: safeNum(
        metrics.baselineEatingOutSpendMonthly ??
          metrics.baseline_eating_out_spend_monthly,
      ),
      postGrocerySpendMonthly: safeNum(
        metrics.postGrocerySpendMonthly ??
          metrics.post_grocery_spend_monthly ??
          metrics.grocerySpendMonthly,
      ),
      postEatingOutSpendMonthly: safeNum(
        metrics.postEatingOutSpendMonthly ??
          metrics.post_eating_out_spend_monthly ??
          metrics.eatingOutSpendMonthly,
      ),
      grocerySpendMonthly: safeNum(
        metrics.grocerySpendMonthly ?? metrics.grocery_spend_monthly,
      ),
      eatingOutSpendMonthly: safeNum(
        metrics.eatingOutSpendMonthly ?? metrics.eating_out_spend_monthly,
      ),
    },
    deltas: {
      monthlySavingsDelta: safeNum(
        deltas.monthlySavingsDelta ?? deltas.monthly_savings_delta,
      ),
    },
    breakdown: {
      homesteadLevel: breakdown.homesteadLevel ?? breakdown.homestead_level,
      scratchCookingPct: safeNum(
        breakdown.scratchCookingPct ?? breakdown.scratch_cooking_pct,
      ),
      assumptions: Array.isArray(breakdown.assumptions)
        ? breakdown.assumptions
        : [],
      drivers: Array.isArray(breakdown.drivers) ? breakdown.drivers : [],
    },
  };
}

function normalizeBaseline(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    id: String(raw.id || raw.baselineId || ""),
    householdId: raw.householdId ? String(raw.householdId) : null,
    personId: raw.personId ? String(raw.personId) : null,
    createdAt: raw.createdAt || raw.createdAtISO || null,
    updatedAt: raw.updatedAt || raw.updatedAtISO || raw.createdAt || null,
    householdSize: safeNum(raw.householdSize ?? raw.household_size),
    mealsPerWeek: safeNum(raw.mealsPerWeek ?? raw.meals_per_week),
    grocerySpendMonthly: safeNum(
      raw.grocerySpendMonthly ?? raw.grocery_spend_monthly,
    ),
    eatingOutFrequencyPerWeek: safeNum(
      raw.eatingOutFrequencyPerWeek ?? raw.eating_out_frequency_per_week,
    ),
    eatingOutSpendMonthly: safeNum(
      raw.eatingOutSpendMonthly ?? raw.eating_out_spend_monthly,
    ),
    notes: raw.notes,
  };
}

function normalizeHomesteadProfile(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    householdId: raw.householdId ? String(raw.householdId) : null,
    levelKey: String(
      raw.levelKey ?? raw.level ?? raw.selectedLevel ?? "unknown",
    ),
    enabledDomains: Array.isArray(raw.enabledDomains) ? raw.enabledDomains : [],
    goals: Array.isArray(raw.goals) ? raw.goals : [],
    updatedAt: raw.updatedAt || raw.updatedAtISO || raw.createdAt || null,
  };
}

export default function BudgetSavingsCard({
  householdId,
  personId,
  snapshotId,
  title = "Budget Savings",
  showDetails = true,
  compact = false,
  currency = "USD",
  onCreateBaseline,
  onRunEstimator,
  onOpenHistory,
  className,
}) {
  const hId = String(householdId || "anonymous");
  const pId = personId ? String(personId) : null;

  const [loading, setLoading] = useState(true);
  const [baseline, setBaseline] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [homesteadProfile, setHomesteadProfile] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const baseRaw = await safeCall(
          BaselinesRepo.getLatestByHouseholdId,
          hId,
          { personId: pId },
        );
        const snapRaw = snapshotId
          ? await safeCall(SnapshotsRepo.getById, snapshotId)
          : await safeCall(SnapshotsRepo.getLatestByHouseholdId, hId, {
              personId: pId,
            });
        const hsRaw = await safeCall(
          HomesteadProfileRepo.getByHouseholdId,
          hId,
        );

        if (!alive) return;

        setBaseline(normalizeBaseline(baseRaw));
        setSnapshot(normalizeSnapshot(snapRaw));
        setHomesteadProfile(normalizeHomesteadProfile(hsRaw));
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(e);
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [hId, pId, snapshotId]);

  const derived = useMemo(() => {
    if (!snapshot) return null;

    const m = snapshot.metrics || {};
    const b = baseline || {};

    const baselineGrocery =
      safeNum(m.baselineGrocerySpendMonthly) ?? safeNum(b.grocerySpendMonthly);
    const baselineEatingOut =
      safeNum(m.baselineEatingOutSpendMonthly) ??
      safeNum(b.eatingOutSpendMonthly);

    const postGrocery =
      safeNum(m.postGrocerySpendMonthly) ??
      safeNum(m.grocerySpendMonthly) ??
      null;

    const postEatingOut =
      safeNum(m.postEatingOutSpendMonthly) ??
      safeNum(m.eatingOutSpendMonthly) ??
      null;

    const groceryDelta =
      baselineGrocery != null && postGrocery != null
        ? baselineGrocery - postGrocery
        : null;
    const eatingOutDelta =
      baselineEatingOut != null && postEatingOut != null
        ? baselineEatingOut - postEatingOut
        : null;

    const savings =
      safeNum(m.monthlySavings) ??
      (groceryDelta != null || eatingOutDelta != null
        ? (groceryDelta || 0) + (eatingOutDelta || 0)
        : null);

    const scratchPct = snapshot.breakdown?.scratchCookingPct ?? null;

    const driverPills = [];
    if (groceryDelta != null && groceryDelta !== 0) {
      driverPills.push({
        label: "Groceries",
        value: `${groceryDelta > 0 ? "+" : "−"}${formatMoney(Math.abs(groceryDelta), currency)}`,
        kind: groceryDelta > 0 ? "positive" : "negative",
      });
    }
    if (eatingOutDelta != null && eatingOutDelta !== 0) {
      driverPills.push({
        label: "Eating out",
        value: `${eatingOutDelta > 0 ? "+" : "−"}${formatMoney(Math.abs(eatingOutDelta), currency)}`,
        kind: eatingOutDelta > 0 ? "positive" : "negative",
      });
    }
    if (scratchPct != null) {
      driverPills.push({
        label: "Scratch cooking",
        value: formatPct(scratchPct),
        kind: "neutral",
      });
    }

    // Use snapshot breakdown drivers if provided
    const breakdownDrivers = Array.isArray(snapshot.breakdown?.drivers)
      ? snapshot.breakdown.drivers
      : [];
    const normalizedDrivers = breakdownDrivers
      .map((d, idx) => {
        const amount = safeNum(d?.amount);
        const impact = d?.impact || "neutral";
        const label = String(d?.label || `Driver ${idx + 1}`);
        const value =
          d?.value != null
            ? d.value
            : amount != null
              ? formatMoney(amount, currency)
              : "—";
        return { label, value, amount, impact };
      })
      .filter(Boolean);

    return {
      baselineGrocery,
      baselineEatingOut,
      postGrocery,
      postEatingOut,
      groceryDelta,
      eatingOutDelta,
      savings,
      scratchPct,
      driverPills,
      normalizedDrivers,
    };
  }, [snapshot, baseline, currency]);

  const emptyState = useMemo(() => {
    const hasBaseline = Boolean(baseline && baseline.id);
    const hasSnapshot = Boolean(snapshot && snapshot.id);

    if (hasSnapshot) return null;

    if (!hasBaseline) {
      return {
        title: "Set your baseline to estimate savings",
        body: "Add a baseline (current grocery and eating-out habits). Then run the estimator to compute budget savings based on your homestead level.",
        primary: { label: "Create baseline", onClick: onCreateBaseline },
        secondary: { label: "Run estimator", onClick: onRunEstimator },
      };
    }

    return {
      title: "Run the estimator to compute savings",
      body: "Your baseline is saved. Run the estimator to calculate monthly budget relief and what’s driving it.",
      primary: { label: "Run estimator", onClick: onRunEstimator },
      secondary: { label: "Edit baseline", onClick: onCreateBaseline },
    };
  }, [baseline, snapshot, onCreateBaseline, onRunEstimator]);

  const levelLabel =
    (homesteadProfile?.levelKey && homesteadProfile.levelKey !== "unknown"
      ? homesteadProfile.levelKey
      : snapshot?.breakdown?.homesteadLevel) || null;

  return (
    <div
      className={cx(
        "rounded-2xl border border-black/10 bg-white shadow-sm",
        className,
      )}
    >
      {/* Header */}
      <div className={cx("border-b border-black/10", compact ? "p-4" : "p-5")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-lg font-extrabold text-black">{title}</div>
            <div className="mt-1 text-sm text-black/60">
              {levelLabel ? (
                <>
                  Based on your homestead level:{" "}
                  <span className="font-semibold text-black">
                    {String(levelLabel)}
                  </span>
                </>
              ) : (
                "Estimate monthly budget relief from pantry coverage + scratch cooking + fewer purchases."
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {onOpenHistory ? (
              <Button variant="ghost" onClick={onOpenHistory}>
                History
              </Button>
            ) : null}
            {onRunEstimator ? (
              <Button variant="primary" onClick={onRunEstimator}>
                Run
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className={compact ? "p-4" : "p-5"}>
        {loading ? (
          <div className="text-sm text-black/60">Loading…</div>
        ) : error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            Failed to load estimator data.
          </div>
        ) : emptyState ? (
          <div className="rounded-xl border border-black/10 bg-zinc-50 p-4">
            <div className="text-base font-bold text-black">
              {emptyState.title}
            </div>
            <div className="mt-1 text-sm text-black/70">{emptyState.body}</div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {emptyState.primary?.onClick ? (
                <Button variant="primary" onClick={emptyState.primary.onClick}>
                  {emptyState.primary.label}
                </Button>
              ) : (
                <Button variant="primary" disabled>
                  {emptyState.primary?.label || "Primary"}
                </Button>
              )}

              {emptyState.secondary?.onClick ? (
                <Button variant="subtle" onClick={emptyState.secondary.onClick}>
                  {emptyState.secondary.label}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            {DismissibleTip ? (
              <div className="mb-4">
                <DismissibleTip
                  householdId={hId}
                  tipKey="estimators.budgetSavings.tip"
                  title="What “savings” means here"
                  tone="info"
                >
                  SSA estimates savings as the difference between your baseline
                  spending and the “after” spending implied by your
                  pantry/freezer coverage and scratch-cooking plan. This stays
                  deterministic and local-first.
                </DismissibleTip>
              </div>
            ) : null}

            {/* KPI row */}
            <div className="grid gap-3 md:grid-cols-3">
              <Stat
                label="Estimated monthly savings"
                value={formatMoney(derived?.savings, currency)}
                sub={
                  snapshot?.updatedAt
                    ? `Updated ${new Date(snapshot.updatedAt).toLocaleDateString("en-US")}`
                    : null
                }
              />
              <Stat
                label="Baseline groceries"
                value={formatMoney(derived?.baselineGrocery, currency)}
                sub="Monthly"
              />
              <Stat
                label="Baseline eating out"
                value={formatMoney(derived?.baselineEatingOut, currency)}
                sub="Monthly"
              />
            </div>

            {/* Drivers pill row */}
            {derived?.driverPills?.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {derived.driverPills.map((p) => (
                  <Pill
                    key={p.label}
                    label={p.label}
                    value={p.value}
                    kind={p.kind}
                  />
                ))}
              </div>
            ) : (
              <div className="mt-3 text-xs text-black/60">
                No savings drivers available for this snapshot.
              </div>
            )}

            {/* Breakdown rows */}
            <div className="mt-4 grid gap-3">
              <BarRow
                label="Groceries"
                leftValue={derived?.baselineGrocery}
                rightValue={derived?.postGrocery}
                deltaValue={derived?.groceryDelta}
                currency={currency}
              />
              <BarRow
                label="Eating out"
                leftValue={derived?.baselineEatingOut}
                rightValue={derived?.postEatingOut}
                deltaValue={derived?.eatingOutDelta}
                currency={currency}
              />
            </div>

            {/* Details */}
            {showDetails ? (
              <div className="mt-4">
                {ProgressiveDisclosurePanel ? (
                  <ProgressiveDisclosurePanel
                    householdId={hId}
                    panelKey="estimators.budgetSavings.details"
                    title="Details"
                    description="Expand only what you need. This prevents the savings model from feeling overwhelming."
                    mode="multi"
                    defaultExpandedIds={["drivers"]}
                    sections={[
                      {
                        id: "drivers",
                        title: "Key drivers",
                        description:
                          "What contributed most to savings in this run.",
                        defaultExpanded: true,
                        render: () => {
                          const drivers = derived?.normalizedDrivers || [];
                          if (!drivers.length) {
                            return (
                              <div className="text-sm text-black/60">
                                No driver list saved in this snapshot.
                              </div>
                            );
                          }
                          return (
                            <div className="grid gap-2">
                              {drivers.map((d) => {
                                const tone =
                                  d.impact === "positive"
                                    ? "border-emerald-200 bg-emerald-50"
                                    : d.impact === "negative"
                                      ? "border-red-200 bg-red-50"
                                      : "border-black/10 bg-white";
                                return (
                                  <div
                                    key={d.label}
                                    className={cx(
                                      "rounded-xl border p-3",
                                      tone,
                                    )}
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="text-sm font-bold text-black">
                                        {d.label}
                                      </div>
                                      <div className="text-sm font-semibold text-black">
                                        {String(d.value)}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        },
                      },
                      {
                        id: "assumptions",
                        title: "Assumptions",
                        description:
                          "Deterministic assumptions used for this estimate.",
                        defaultExpanded: false,
                        items: snapshot?.breakdown?.assumptions || [],
                        initialVisibleCount: 3,
                        step: 5,
                        renderItem: (item) => (
                          <div className="text-sm text-black/80">
                            {String(item)}
                          </div>
                        ),
                        showMoreLabel: "Show more assumptions",
                        showLessLabel: "Show fewer",
                      },
                      {
                        id: "baseline",
                        title: "Baseline used",
                        description:
                          "The baseline settings this run referenced.",
                        defaultExpanded: false,
                        render: () => {
                          const b = baseline;
                          if (!b) {
                            return (
                              <div className="text-sm text-black/60">
                                No baseline loaded. Create a baseline to improve
                                accuracy.
                              </div>
                            );
                          }
                          return (
                            <div className="grid gap-3 md:grid-cols-2">
                              <Stat
                                label="Household size"
                                value={
                                  b.householdSize != null
                                    ? String(Math.round(b.householdSize))
                                    : "—"
                                }
                              />
                              <Stat
                                label="Meals / week"
                                value={
                                  b.mealsPerWeek != null
                                    ? String(Math.round(b.mealsPerWeek))
                                    : "—"
                                }
                              />
                              <Stat
                                label="Grocery spend"
                                value={formatMoney(
                                  b.grocerySpendMonthly,
                                  currency,
                                )}
                                sub="Monthly"
                              />
                              <Stat
                                label="Eating out"
                                value={
                                  b.eatingOutFrequencyPerWeek != null
                                    ? `${b.eatingOutFrequencyPerWeek.toFixed(1)} / week`
                                    : "—"
                                }
                                sub={
                                  b.eatingOutSpendMonthly != null
                                    ? `${formatMoney(b.eatingOutSpendMonthly, currency)} / month`
                                    : null
                                }
                              />
                            </div>
                          );
                        },
                      },
                      {
                        id: "raw",
                        title: "Raw snapshot (debug)",
                        description:
                          "Use this only if you’re validating fields during development.",
                        defaultExpanded: false,
                        render: () => (
                          <pre className="whitespace-pre-wrap break-words rounded-lg border border-black/10 bg-zinc-50 p-3 text-xs text-black/70">
                            {JSON.stringify(
                              {
                                snapshotId: snapshot?.id,
                                metrics: snapshot?.metrics,
                                deltas: snapshot?.deltas,
                                breakdown: snapshot?.breakdown,
                                derived: {
                                  groceryDelta: derived?.groceryDelta,
                                  eatingOutDelta: derived?.eatingOutDelta,
                                  savings: derived?.savings,
                                  scratchPct: derived?.scratchPct,
                                },
                                loadedAt: nowIso(),
                              },
                              null,
                              2,
                            )}
                          </pre>
                        ),
                      },
                    ]}
                    footer={
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-black/60">
                          Deterministic summaries — no hidden AI logic.
                        </div>
                        <div className="flex items-center gap-2">
                          {onCreateBaseline ? (
                            <Button variant="subtle" onClick={onCreateBaseline}>
                              Edit baseline
                            </Button>
                          ) : null}
                          {onRunEstimator ? (
                            <Button variant="primary" onClick={onRunEstimator}>
                              Run again
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    }
                  />
                ) : (
                  <div className="rounded-xl border border-black/10 bg-zinc-50 p-4">
                    <div className="text-sm font-bold text-black">Details</div>
                    <div className="mt-2 text-xs text-black/60">
                      ProgressiveDisclosurePanel not available. Showing minimal
                      debug output.
                    </div>
                    <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg border border-black/10 bg-white p-3 text-xs text-black/70">
                      {JSON.stringify(
                        {
                          snapshotId: snapshot?.id,
                          baselineId: baseline?.id,
                          derived,
                          homesteadProfile,
                          loadedAt: nowIso(),
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
