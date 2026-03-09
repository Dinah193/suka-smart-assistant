// C:\Users\larho\suka-smart-assistant\src\components\estimators\FoodSecurityCard.jsx
//
// FoodSecurityCard
// ----------------
// A deterministic, local-first UI card that summarizes:
// - Food Security %
// - Days Covered
// - Monthly Savings estimate (optional)
// - "What changed" deltas vs baseline (optional)
// - Progressive disclosure for details (uses ProgressiveDisclosurePanel if present)
//
// Data sources (preferred):
// - estimator_snapshots repo:  src/services/repos/estimators/snapshots.repo.js
// - estimator_baselines repo:  src/services/repos/estimators/baselines.repo.js
// - homestead_profile repo:    src/services/repos/homestead/homesteadProfile.repo.js
//
// Fallback:
// - If repos aren't available / return nothing, the component renders a friendly empty state
//   and provides “Create baseline” / “Run estimator” buttons via callbacks.
//
// Props:
// - householdId?: string (recommended)
// - personId?: string (optional)
// - snapshotId?: string (optional) if you want a specific snapshot
// - title?: string
// - showDetails?: boolean (default true)
// - compact?: boolean (default false)
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
//     foodSecurityPct: number (0-100),
//     daysCovered: number,
//     monthlySavings: number,
//     grocerySpendMonthly: number,
//     eatingOutSpendMonthly: number,
//   },
//   deltas?: {
//     monthlySavingsDelta?: number,
//     daysCoveredDelta?: number,
//     foodSecurityPctDelta?: number,
//   },
//   breakdown?: {
//     pantryDays?: number,
//     freezerDays?: number,
//     freshDays?: number,
//     scratchCookingPct?: number,
//     homesteadLevel?: string,
//     assumptions?: string[],
//     drivers?: Array<{ label, value, impact?: "positive"|"negative"|"neutral" }>
//   }
// }
//
// Baseline expected shape (flexible):
// {
//   id, householdId, personId?,
//   createdAt, updatedAt,
//   householdSize, mealsPerWeek,
//   grocerySpendMonthly,
//   eatingOutFrequencyPerWeek,
//   eatingOutSpendMonthly,
//   notes?
// }
//
// Homestead profile expected shape (flexible):
// {
//   householdId,
//   levelKey,
//   enabledDomains: [],
//   goals: [],
//   createdAt, updatedAt
// }
//
import React, { useEffect, useMemo, useState } from "react";

// Best-effort repo imports (you asked for these repos earlier)
import * as BaselinesRepo from "@/services/repos/estimators/baselines.repo";
import * as SnapshotsRepo from "@/services/repos/estimators/snapshots.repo";
import * as HomesteadProfileRepo from "@/services/repos/homestead/homesteadProfile.repo";

// Optional component dependencies (safe fallback if not present)
let ProgressiveDisclosurePanel = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  ProgressiveDisclosurePanel = (
    await import("@/components/homestead/ProgressiveDisclosurePanel.jsx")
  ).default;
} catch {
  ProgressiveDisclosurePanel = null;
}

let DismissibleTip = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
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
    // fallback
    const rounded = Math.round(n);
    return `$${rounded.toLocaleString("en-US")}`;
  }
}

function formatNumber(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(clamp(n, 0, 100))}%`;
}

function sign(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x === 0) return "";
  return x > 0 ? "+" : "−";
}

function abs(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return NaN;
  return Math.abs(x);
}

function DeltaPill({ label, value, kind = "neutral" }) {
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

function Gauge({ valuePct }) {
  const value = clamp(valuePct, 0, 100);
  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-xs text-black/60">
        <span>0%</span>
        <span>100%</span>
      </div>
      <div className="mt-1 h-3 w-full rounded-full bg-black/10">
        <div
          className="h-3 rounded-full bg-black"
          style={{ width: `${value}%` }}
          aria-label={`Food security ${Math.round(value)} percent`}
        />
      </div>
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

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-black/10 bg-white p-3">
      <div className="text-xs font-semibold text-black/50">{label}</div>
      <div className="mt-1 text-xl font-extrabold text-black">{value}</div>
      {sub ? <div className="mt-1 text-xs text-black/60">{sub}</div> : null}
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
      foodSecurityPct: Number(
        metrics.foodSecurityPct ??
          metrics.foodSecurity ??
          metrics.food_security_pct,
      ),
      daysCovered: Number(
        metrics.daysCovered ?? metrics.days_covered ?? metrics.coverageDays,
      ),
      monthlySavings: Number(
        metrics.monthlySavings ??
          metrics.monthly_savings ??
          metrics.savingsMonthly,
      ),
      grocerySpendMonthly: Number(
        metrics.grocerySpendMonthly ?? metrics.grocery_spend_monthly,
      ),
      eatingOutSpendMonthly: Number(
        metrics.eatingOutSpendMonthly ?? metrics.eating_out_spend_monthly,
      ),
    },
    deltas: {
      foodSecurityPctDelta: Number(
        deltas.foodSecurityPctDelta ?? deltas.food_security_pct_delta,
      ),
      daysCoveredDelta: Number(
        deltas.daysCoveredDelta ?? deltas.days_covered_delta,
      ),
      monthlySavingsDelta: Number(
        deltas.monthlySavingsDelta ?? deltas.monthly_savings_delta,
      ),
    },
    breakdown: {
      pantryDays: breakdown.pantryDays ?? breakdown.pantry_days,
      freezerDays: breakdown.freezerDays ?? breakdown.freezer_days,
      freshDays: breakdown.freshDays ?? breakdown.fresh_days,
      scratchCookingPct:
        breakdown.scratchCookingPct ?? breakdown.scratch_cooking_pct,
      homesteadLevel: breakdown.homesteadLevel ?? breakdown.homestead_level,
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
    householdSize: Number(raw.householdSize ?? raw.household_size),
    mealsPerWeek: Number(raw.mealsPerWeek ?? raw.meals_per_week),
    grocerySpendMonthly: Number(
      raw.grocerySpendMonthly ?? raw.grocery_spend_monthly,
    ),
    eatingOutFrequencyPerWeek: Number(
      raw.eatingOutFrequencyPerWeek ?? raw.eating_out_frequency_per_week,
    ),
    eatingOutSpendMonthly: Number(
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

export default function FoodSecurityCard({
  householdId,
  personId,
  snapshotId,
  title = "Food Security",
  showDetails = true,
  compact = false,
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

  // Load baseline + latest snapshot + homestead profile
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Baseline
        const baseRaw = snapshotId
          ? await safeCall(BaselinesRepo.getLatestByHouseholdId, hId, {
              personId: pId,
            })
          : await safeCall(BaselinesRepo.getLatestByHouseholdId, hId, {
              personId: pId,
            });

        // Snapshot: by id (if provided) else latest
        const snapRaw = snapshotId
          ? await safeCall(SnapshotsRepo.getById, snapshotId)
          : await safeCall(SnapshotsRepo.getLatestByHouseholdId, hId, {
              personId: pId,
            });

        // Homestead profile
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
    const s = snapshot;
    if (!s) return null;

    const fs = s.metrics.foodSecurityPct;
    const days = s.metrics.daysCovered;
    const savings = s.metrics.monthlySavings;

    const deltas = s.deltas || {};
    const fsDelta = deltas.foodSecurityPctDelta;
    const daysDelta = deltas.daysCoveredDelta;
    const savingsDelta = deltas.monthlySavingsDelta;

    const kindFor = (delta, positiveDirection = "up") => {
      const n = Number(delta);
      if (!Number.isFinite(n) || n === 0) return "neutral";
      // For food security, days covered, savings: positive is better (up)
      const good = positiveDirection === "up" ? n > 0 : n < 0;
      return good ? "positive" : "negative";
    };

    const pills = [];
    if (Number.isFinite(fsDelta) && fsDelta !== 0) {
      pills.push({
        label: "Food security",
        value: `${sign(fsDelta)}${Math.round(abs(fsDelta))}%`,
        kind: kindFor(fsDelta),
      });
    }
    if (Number.isFinite(daysDelta) && daysDelta !== 0) {
      pills.push({
        label: "Days covered",
        value: `${sign(daysDelta)}${Math.round(abs(daysDelta))}d`,
        kind: kindFor(daysDelta),
      });
    }
    if (Number.isFinite(savingsDelta) && savingsDelta !== 0) {
      pills.push({
        label: "Monthly savings",
        value: `${savingsDelta > 0 ? "+" : "−"}${formatMoney(abs(savingsDelta))}`,
        kind: kindFor(savingsDelta),
      });
    }

    return {
      foodSecurityPct: fs,
      daysCovered: days,
      monthlySavings: savings,
      pills,
    };
  }, [snapshot]);

  const emptyState = useMemo(() => {
    // Determine what’s missing
    const hasBaseline = Boolean(baseline && baseline.id);
    const hasSnapshot = Boolean(snapshot && snapshot.id);

    if (hasSnapshot) return null;

    if (!hasBaseline) {
      return {
        title: "Set your baseline to estimate food security",
        body: "Add a quick baseline (household size, meals per week, current grocery/eating-out habits). Then run the estimator to compute coverage and savings.",
        primary: { label: "Create baseline", onClick: onCreateBaseline },
        secondary: { label: "Run estimator", onClick: onRunEstimator },
      };
    }

    return {
      title: "Run the estimator to compute coverage",
      body: "Your baseline is saved. Run the estimator to calculate food security %, days covered, and potential savings based on your homestead level and provisioning targets.",
      primary: { label: "Run estimator", onClick: onRunEstimator },
      secondary: { label: "Edit baseline", onClick: onCreateBaseline },
    };
  }, [baseline, snapshot, onCreateBaseline, onRunEstimator]);

  const levelLabel =
    homesteadProfile?.levelKey && homesteadProfile.levelKey !== "unknown"
      ? homesteadProfile.levelKey
      : snapshot?.breakdown?.homesteadLevel || null;

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
                "Use a baseline + estimator run to compute your household food security."
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
            {/* Optional tip */}
            {DismissibleTip ? (
              <div className="mb-4">
                <DismissibleTip
                  householdId={hId}
                  tipKey="estimators.foodSecurityCard.tip"
                  title="How this is calculated"
                  tone="info"
                >
                  SSA estimates food security by combining your baseline
                  (meals/week, household size, spending) with your current
                  homestead plan outputs (pantry/freezer/fresh coverage and
                  scratch-cooking rate). This stays deterministic and
                  local-first.
                </DismissibleTip>
              </div>
            ) : null}

            {/* KPI row */}
            <div
              className={cx(
                "grid gap-3",
                compact
                  ? "grid-cols-1 md:grid-cols-3"
                  : "grid-cols-1 md:grid-cols-3",
              )}
            >
              <Stat
                label="Food security"
                value={pct(derived?.foodSecurityPct)}
                sub="Coverage confidence indicator"
              />
              <Stat
                label="Days covered"
                value={
                  Number.isFinite(Number(derived?.daysCovered))
                    ? `${Math.round(derived.daysCovered)} days`
                    : "—"
                }
                sub="Estimated household coverage"
              />
              <Stat
                label="Monthly savings"
                value={formatMoney(derived?.monthlySavings)}
                sub="Estimated budget relief"
              />
            </div>

            {/* Gauge */}
            <div className="mt-4 rounded-xl border border-black/10 bg-zinc-50 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold text-black">
                  Coverage gauge
                </div>
                <div className="text-xs text-black/60">
                  Updated:{" "}
                  {snapshot?.updatedAt
                    ? new Date(snapshot.updatedAt).toLocaleDateString("en-US")
                    : "—"}
                </div>
              </div>
              <div className="mt-3">
                <Gauge valuePct={derived?.foodSecurityPct ?? 0} />
              </div>

              {/* Deltas */}
              {derived?.pills?.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {derived.pills.map((p) => (
                    <DeltaPill
                      key={p.label}
                      label={p.label}
                      value={p.value}
                      kind={p.kind}
                    />
                  ))}
                </div>
              ) : (
                <div className="mt-3 text-xs text-black/60">
                  No change vs last snapshot.
                </div>
              )}
            </div>

            {/* Details */}
            {showDetails ? (
              <div className="mt-4">
                {ProgressiveDisclosurePanel ? (
                  <ProgressiveDisclosurePanel
                    householdId={hId}
                    panelKey="estimators.foodSecurity.details"
                    title="Details"
                    description="Expand only what you need. This panel helps avoid overwhelm."
                    mode="multi"
                    defaultExpandedIds={["summary"]}
                    sections={[
                      {
                        id: "summary",
                        title: "Snapshot summary",
                        description:
                          "What SSA saved from the last estimator run.",
                        defaultExpanded: true,
                        render: () => {
                          const s = snapshot;
                          if (!s)
                            return (
                              <div className="text-sm text-black/60">
                                No snapshot loaded.
                              </div>
                            );
                          return (
                            <div className="grid gap-2 text-sm">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="text-black/70">Snapshot ID</div>
                                <div className="font-mono text-xs text-black">
                                  {s.id || "—"}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="text-black/70">Created</div>
                                <div className="text-black">
                                  {s.createdAt
                                    ? new Date(s.createdAt).toLocaleString(
                                        "en-US",
                                      )
                                    : "—"}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="text-black/70">Updated</div>
                                <div className="text-black">
                                  {s.updatedAt
                                    ? new Date(s.updatedAt).toLocaleString(
                                        "en-US",
                                      )
                                    : "—"}
                                </div>
                              </div>
                            </div>
                          );
                        },
                      },
                      {
                        id: "breakdown",
                        title: "Coverage breakdown",
                        description:
                          "Where coverage is coming from (pantry/freezer/fresh).",
                        defaultExpanded: false,
                        render: () => {
                          const b = snapshot?.breakdown || {};
                          return (
                            <div className="grid gap-3 md:grid-cols-3">
                              <Stat
                                label="Pantry"
                                value={
                                  Number.isFinite(Number(b.pantryDays))
                                    ? `${Math.round(b.pantryDays)} days`
                                    : "—"
                                }
                                sub="Shelf-stable"
                              />
                              <Stat
                                label="Freezer"
                                value={
                                  Number.isFinite(Number(b.freezerDays))
                                    ? `${Math.round(b.freezerDays)} days`
                                    : "—"
                                }
                                sub="Frozen inventory"
                              />
                              <Stat
                                label="Fresh"
                                value={
                                  Number.isFinite(Number(b.freshDays))
                                    ? `${Math.round(b.freshDays)} days`
                                    : "—"
                                }
                                sub="Garden/market cadence"
                              />
                            </div>
                          );
                        },
                      },
                      {
                        id: "assumptions",
                        title: "Assumptions",
                        description:
                          "Deterministic assumptions used in this run.",
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
                        id: "drivers",
                        title: "Key drivers",
                        description:
                          "What had the biggest impact on coverage/savings.",
                        defaultExpanded: false,
                        items: snapshot?.breakdown?.drivers || [],
                        initialVisibleCount: 3,
                        step: 5,
                        renderItem: (item) => {
                          const impact = item?.impact || "neutral";
                          const tone =
                            impact === "positive"
                              ? "border-emerald-200 bg-emerald-50"
                              : impact === "negative"
                                ? "border-red-200 bg-red-50"
                                : "border-black/10 bg-white";
                          return (
                            <div className={cx("rounded-lg border p-3", tone)}>
                              <div className="text-sm font-bold text-black">
                                {item?.label || "Driver"}
                              </div>
                              <div className="mt-1 text-sm text-black/70">
                                {item?.value != null ? String(item.value) : "—"}
                              </div>
                            </div>
                          );
                        },
                        showMoreLabel: "Show more drivers",
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
                                  Number.isFinite(b.householdSize)
                                    ? String(Math.round(b.householdSize))
                                    : "—"
                                }
                              />
                              <Stat
                                label="Meals / week"
                                value={
                                  Number.isFinite(b.mealsPerWeek)
                                    ? String(Math.round(b.mealsPerWeek))
                                    : "—"
                                }
                              />
                              <Stat
                                label="Grocery spend"
                                value={formatMoney(b.grocerySpendMonthly)}
                                sub="Monthly"
                              />
                              <Stat
                                label="Eating out"
                                value={
                                  Number.isFinite(b.eatingOutFrequencyPerWeek)
                                    ? `${formatNumber(b.eatingOutFrequencyPerWeek, 1)} / week`
                                    : "—"
                                }
                                sub={
                                  Number.isFinite(b.eatingOutSpendMonthly)
                                    ? `${formatMoney(b.eatingOutSpendMonthly)} / month`
                                    : null
                                }
                              />
                            </div>
                          );
                        },
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
                  // Fallback detail view if ProgressiveDisclosurePanel isn't available
                  <div className="rounded-xl border border-black/10 bg-zinc-50 p-4">
                    <div className="text-sm font-bold text-black">Details</div>
                    <div className="mt-2 text-xs text-black/60">
                      ProgressiveDisclosurePanel not available. Showing minimal
                      info.
                    </div>
                    <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg border border-black/10 bg-white p-3 text-xs text-black/70">
                      {JSON.stringify(
                        {
                          snapshotId: snapshot?.id,
                          metrics: snapshot?.metrics,
                          deltas: snapshot?.deltas,
                          breakdown: snapshot?.breakdown,
                          baseline: baseline
                            ? {
                                id: baseline.id,
                                householdSize: baseline.householdSize,
                                mealsPerWeek: baseline.mealsPerWeek,
                              }
                            : null,
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
