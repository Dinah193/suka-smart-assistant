// C:\Users\larho\suka-smart-assistant\src\components\homestead\HomesteadReadinessCard.jsx
//
// HomesteadReadinessCard
// ----------------------
// UI card that summarizes "how ready" a household is for the selected Homestead level.
// Deterministic, local-first, and safe to render even if services/repos are missing.
//
// What it does (no AI):
// - Reads household homestead profile (selected level, enabled domains, goals)
// - Reads latest estimator snapshot (food security %, days covered, monthly savings estimate)
// - Reads Farm-to-Table latest plan/targets (if present)
// - Uses HomesteadLevelService + VisibilityRulesEngine to compute what should be shown
// - Outputs a UI-safe readiness summary + next actions
//
// Props:
// - householdId?: string (recommended)
// - personId?: string (optional; used for estimator snapshot scoping if your repo supports it)
// - levelOverride?: string (optional; force level for preview)
// - showDetails?: boolean (default true)
// - compact?: boolean (default false)
// - className?: string
// - onOpenLevelPicker?: () => void
// - onOpenEstimator?: () => void
// - onOpenPlan?: () => void
//
// Dependencies (expected in your project per prior requests):
// - repos:
//   - src/services/repos/homestead/homesteadProfile.repo.js
//   - src/services/repos/homestead/visibilityState.repo.js
//   - src/services/repos/estimators/baselines.repo.js
//   - src/services/repos/estimators/snapshots.repo.js
//   - src/services/repos/farmToTable/targets.repo.js
//   - src/services/repos/farmToTable/componentInventory.repo.js
//   - src/services/repos/farmToTable/batches.repo.js
// - services:
//   - src/services/homestead/HomesteadLevelService.js
//   - src/services/homestead/VisibilityRulesEngine.js
//   - src/services/farmToTable/VisibilityBridge.js
//
// This component is resilient:
// - It will render with "Not configured yet" states if any table/repo is absent.
// - It will not throw in production.
//
// Tailwind: used lightly.
//

import React, { useEffect, useMemo, useState } from "react";

import HomesteadLevelService from "@/services/homestead/HomesteadLevelService";
import VisibilityRulesEngine from "@/services/homestead/VisibilityRulesEngine";
import VisibilityBridge from "@/services/farmToTable/VisibilityBridge";

// Repos (best-effort imports)
import * as HomesteadProfileRepo from "@/services/repos/homestead/homesteadProfile.repo";
import * as VisibilityStateRepo from "@/services/repos/homestead/visibilityState.repo";
import * as EstimatorBaselinesRepo from "@/services/repos/estimators/baselines.repo";
import * as EstimatorSnapshotsRepo from "@/services/repos/estimators/snapshots.repo";
import * as FttTargetsRepo from "@/services/repos/farmToTable/targets.repo";
import * as FttComponentInventoryRepo from "@/services/repos/farmToTable/componentInventory.repo";
import * as FttBatchesRepo from "@/services/repos/farmToTable/batches.repo";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function pct(n, digits = 0) {
  const v = safeNum(n);
  if (v == null) return null;
  return `${v.toFixed(digits)}%`;
}

function fmtMoney(n) {
  const v = safeNum(n);
  if (v == null) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

function isoOrNull(x) {
  if (!x) return null;
  const s = String(x);
  return s.includes("T") ? s : null;
}

function daysBetweenISO(aISO, bISO) {
  try {
    const a = new Date(aISO).getTime();
    const b = new Date(bISO).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const d = Math.round((b - a) / (1000 * 60 * 60 * 24));
    return d;
  } catch {
    return null;
  }
}

function levelLabel(levelKey) {
  const meta = HomesteadLevelService.getLevelMeta(levelKey);
  return meta?.label || meta?.name || levelKey;
}

function badgeForScore(score01) {
  const s = safeNum(score01);
  if (s == null) return { text: "Unknown", tone: "neutral" };
  if (s >= 0.8) return { text: "Strong", tone: "good" };
  if (s >= 0.55) return { text: "Building", tone: "warn" };
  return { text: "Starting", tone: "neutral" };
}

function toneClass(tone) {
  if (tone === "good") return "bg-emerald-700 text-white";
  if (tone === "warn") return "bg-amber-600 text-white";
  return "bg-zinc-700 text-white";
}

function Card({ className, children }) {
  return (
    <div
      className={cx(
        "rounded-xl border border-black/10 bg-white shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Tag({ text, tone = "neutral" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
        toneClass(tone),
      )}
    >
      {text}
    </span>
  );
}

function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  className,
  type = "button",
}) {
  const base =
    "inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-black/20";
  const variants = {
    primary: "bg-black text-white hover:bg-black/90 disabled:bg-black/40",
    ghost: "bg-transparent text-black hover:bg-black/5 disabled:text-black/40",
    subtle: "bg-zinc-100 text-black hover:bg-zinc-200 disabled:bg-zinc-100/50",
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

function ProgressBar({ value01 }) {
  const v = safeNum(value01);
  const clamped = v == null ? 0 : Math.max(0, Math.min(1, v));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-black/10">
      <div
        className="h-full bg-black"
        style={{ width: `${Math.round(clamped * 100)}%` }}
      />
    </div>
  );
}

function kpiLabel(text) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wide text-black/50">
      {text}
    </div>
  );
}

function kpiValue(text) {
  return <div className="mt-1 text-lg font-bold text-black">{text}</div>;
}

function deriveReadiness({
  level,
  profile,
  baselines,
  snapshot,
  latestTargets,
  componentInvCount,
  recentBatchesCount,
}) {
  // Deterministic readiness rubric:
  // - Base readiness from estimator snapshot (food security %, days covered)
  // - Add small boosts for having FTT targets + component inventory + recent batches
  // - Penalize if no baselines configured for estimator when level expects it
  const expectsEstimator = level !== "off";
  const expectsFTT = ["scratch", "homestead", "village"].includes(level);

  const foodSecurityPct = safeNum(
    snapshot?.foodSecurityPct ??
      snapshot?.food_security_pct ??
      snapshot?.foodSecurity?.pct,
  );
  const daysCovered = safeNum(
    snapshot?.daysCovered ??
      snapshot?.days_covered ??
      snapshot?.foodSecurity?.daysCovered,
  );
  const monthlySavings = safeNum(
    snapshot?.monthlySavings ??
      snapshot?.monthly_savings ??
      snapshot?.savings?.monthly,
  );

  // Base score from food security or days covered
  let score = 0.35; // default "starting"
  if (foodSecurityPct != null) {
    score = Math.max(score, Math.min(1, foodSecurityPct / 100));
  } else if (daysCovered != null) {
    // cap at 30 days -> 1.0
    score = Math.max(score, Math.min(1, daysCovered / 30));
  }

  // Boosts
  const hasBaselines = Boolean(baselines && Object.keys(baselines).length);
  const hasTargets = Boolean(
    latestTargets &&
    (latestTargets?.id ||
      latestTargets?.updatedAt ||
      latestTargets?.updatedAtISO),
  );
  const invCount = safeNum(componentInvCount) || 0;
  const batchCount = safeNum(recentBatchesCount) || 0;

  if (expectsEstimator && hasBaselines) score += 0.05;
  if (expectsFTT && hasTargets) score += 0.08;
  if (expectsFTT && invCount >= 10) score += 0.05;
  if (expectsFTT && batchCount >= 1) score += 0.04;
  if (expectsFTT && batchCount >= 3) score += 0.02;

  // Penalize if estimator expected but not configured
  if (expectsEstimator && !hasBaselines) score -= 0.06;

  // Clamp
  score = Math.max(0.05, Math.min(0.98, score));

  // Next actions (deterministic)
  const actions = [];

  if (level === "off") {
    actions.push({
      id: "enable_level",
      title: "Pick a homestead level",
      body: "Turn on Pantry or Scratch to start tracking food security and savings.",
      kind: "level",
      priority: 1,
    });
    return {
      score,
      badge: badgeForScore(score),
      foodSecurityPct,
      daysCovered,
      monthlySavings,
      actions,
    };
  }

  if (!hasBaselines) {
    actions.push({
      id: "set_baselines",
      title: "Set estimator baselines",
      body: "Add grocery spend, meals/week, and eating-out frequency so SSA can estimate savings and days covered.",
      kind: "estimator",
      priority: 1,
    });
  }

  if (expectsFTT && !hasTargets) {
    actions.push({
      id: "run_provisioning",
      title: "Run Farm-to-Table provisioning",
      body: "Generate targets so SSA can calculate storehouse gaps and the next best actions.",
      kind: "plan",
      priority: 2,
    });
  }

  if (expectsFTT && invCount < 10) {
    actions.push({
      id: "map_components",
      title: "Map pantry components",
      body: "Link 10–20 staple components (rice, beans, broth, veg) to inventory items for accurate gap checks.",
      kind: "plan",
      priority: 3,
    });
  }

  if (expectsFTT && batchCount < 1) {
    actions.push({
      id: "log_batch",
      title: "Log one batch-prep item",
      body: "Record a cooked staple (beans/broth/chopped veg) so readiness reflects real outputs.",
      kind: "plan",
      priority: 4,
    });
  }

  // If already fairly ready, suggest refinement
  if (score >= 0.75) {
    actions.push({
      id: "tighten_rotation",
      title: "Tighten rotation + goals",
      body: "Adjust scratch-cooking percentage and rotation so targets match your real cadence.",
      kind: "plan",
      priority: 5,
    });
  }

  actions.sort((a, b) => a.priority - b.priority);

  return {
    score,
    badge: badgeForScore(score),
    foodSecurityPct,
    daysCovered,
    monthlySavings,
    actions,
  };
}

async function safeCall(fn, ...args) {
  try {
    if (typeof fn !== "function") return null;
    return await fn(...args);
  } catch {
    return null;
  }
}

export default function HomesteadReadinessCard({
  householdId,
  personId,
  levelOverride,
  showDetails = true,
  compact = false,
  className,
  onOpenLevelPicker,
  onOpenEstimator,
  onOpenPlan,
}) {
  const hId = String(householdId || "anonymous");
  const pId = personId ? String(personId) : null;

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [profile, setProfile] = useState(null);
  const [visibilityState, setVisibilityState] = useState(null);

  const [baselines, setBaselines] = useState(null);
  const [snapshot, setSnapshot] = useState(null);

  const [latestTargets, setLatestTargets] = useState(null);
  const [componentInvCount, setComponentInvCount] = useState(0);
  const [recentBatchesCount, setRecentBatchesCount] = useState(0);

  // Load data
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr("");

    (async () => {
      try {
        // Profile + visibility state
        const prof =
          (await safeCall(HomesteadProfileRepo.getByHouseholdId, hId)) ||
          (await safeCall(HomesteadProfileRepo.getProfile, hId)) ||
          null;

        const vis =
          (await safeCall(VisibilityStateRepo.getByHouseholdId, hId)) ||
          (await safeCall(VisibilityStateRepo.getState, hId)) ||
          null;

        // Baselines + latest snapshot
        const base =
          (await safeCall(EstimatorBaselinesRepo.getByHouseholdId, hId)) ||
          (await safeCall(EstimatorBaselinesRepo.getBaselines, hId)) ||
          null;

        const snap =
          (await safeCall(EstimatorSnapshotsRepo.getLatestByHouseholdId, hId, {
            personId: pId,
          })) ||
          (await safeCall(EstimatorSnapshotsRepo.getLatest, hId, {
            personId: pId,
          })) ||
          null;

        // FTT targets + inventory + batches
        const targets =
          (await safeCall(FttTargetsRepo.getLatestByHouseholdId, hId)) ||
          (await safeCall(FttTargetsRepo.getLatest, hId)) ||
          null;

        const compCount =
          (await safeCall(FttComponentInventoryRepo.countByHouseholdId, hId)) ||
          (await safeCall(FttComponentInventoryRepo.countForHousehold, hId)) ||
          0;

        const batchCount =
          (await safeCall(FttBatchesRepo.countRecentByHouseholdId, hId, {
            days: 14,
          })) ||
          (await safeCall(FttBatchesRepo.countRecent, hId, { days: 14 })) ||
          0;

        if (!alive) return;

        setProfile(prof);
        setVisibilityState(vis);
        setBaselines(base);
        setSnapshot(snap);
        setLatestTargets(targets);
        setComponentInvCount(Number(compCount || 0));
        setRecentBatchesCount(Number(batchCount || 0));
      } catch (e) {
        if (!alive) return;
        setErr(String(e?.message || e));
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [hId, pId]);

  const level = useMemo(() => {
    if (levelOverride)
      return HomesteadLevelService.normalizeHomesteadLevel(levelOverride);
    const fromProfile =
      profile?.level ||
      profile?.selectedLevel ||
      profile?.homesteadLevel ||
      profile?.meta?.level ||
      profile?.settings?.level ||
      null;
    return HomesteadLevelService.normalizeHomesteadLevel(fromProfile || "off");
  }, [profile, levelOverride]);

  const gates = useMemo(() => {
    // Deterministic show/hide map for this level
    try {
      if (typeof VisibilityRulesEngine.computeUiGates !== "function")
        return null;
      return VisibilityRulesEngine.computeUiGates({
        householdId: hId,
        level,
        profile: profile || {},
        visibilityState: visibilityState || {},
      });
    } catch {
      return null;
    }
  }, [hId, level, profile, visibilityState]);

  const readiness = useMemo(() => {
    return deriveReadiness({
      level,
      profile,
      baselines,
      snapshot,
      latestTargets,
      componentInvCount,
      recentBatchesCount,
    });
  }, [
    level,
    profile,
    baselines,
    snapshot,
    latestTargets,
    componentInvCount,
    recentBatchesCount,
  ]);

  const uiSafeSummary = useMemo(() => {
    // Convert raw data to UI-safe summaries depending on homestead level.
    // If your VisibilityBridge is implemented, prefer it; otherwise return a conservative summary.
    try {
      if (typeof VisibilityBridge.toUiSafeReadinessSummary === "function") {
        return VisibilityBridge.toUiSafeReadinessSummary({
          level,
          profile,
          baselines,
          snapshot,
          latestTargets,
          componentInvCount,
          recentBatchesCount,
          readiness,
          gates,
        });
      }
    } catch {
      // ignore
    }

    return {
      level,
      levelLabel: levelLabel(level),
      readinessScore01: readiness.score,
      badge: readiness.badge,
      kpis: {
        foodSecurityPct: readiness.foodSecurityPct,
        daysCovered: readiness.daysCovered,
        monthlySavings: readiness.monthlySavings,
        componentInvCount,
        recentBatchesCount,
      },
      show: {
        estimator: level !== "off",
        ftt: ["scratch", "homestead", "village"].includes(level),
      },
      actions: readiness.actions,
      gates,
    };
  }, [
    level,
    profile,
    baselines,
    snapshot,
    latestTargets,
    componentInvCount,
    recentBatchesCount,
    readiness,
    gates,
  ]);

  const lastUpdatedText = useMemo(() => {
    const sUpdated =
      snapshot?.updatedAt ||
      snapshot?.updatedAtISO ||
      snapshot?.createdAt ||
      snapshot?.createdAtISO;
    const tUpdated =
      latestTargets?.updatedAt ||
      latestTargets?.updatedAtISO ||
      latestTargets?.createdAt ||
      latestTargets?.createdAtISO;
    const best = isoOrNull(sUpdated) || isoOrNull(tUpdated);
    if (!best) return "Not yet computed";
    try {
      const daysAgo = daysBetweenISO(best, new Date().toISOString());
      if (daysAgo == null) return "Updated recently";
      if (daysAgo === 0) return "Updated today";
      if (daysAgo === 1) return "Updated 1 day ago";
      return `Updated ${daysAgo} days ago`;
    } catch {
      return "Updated recently";
    }
  }, [snapshot, latestTargets]);

  function handleAction(action) {
    const kind = action?.kind;
    if (kind === "level" && typeof onOpenLevelPicker === "function")
      return onOpenLevelPicker();
    if (kind === "estimator" && typeof onOpenEstimator === "function")
      return onOpenEstimator();
    if (kind === "plan" && typeof onOpenPlan === "function")
      return onOpenPlan();

    // Fallback: if no callbacks, do nothing (component stays deterministic)
    return undefined;
  }

  const title = compact ? "Readiness" : "Homestead Readiness";
  const subtitle = `${uiSafeSummary.levelLabel} • ${lastUpdatedText}`;

  return (
    <Card className={cx(className)}>
      <div className={cx("border-b border-black/10", compact ? "p-3" : "p-4")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div
              className={cx(
                "font-bold text-black",
                compact ? "text-base" : "text-lg",
              )}
            >
              {title}
            </div>
            <div
              className={cx(
                "mt-1 text-black/60",
                compact ? "text-xs" : "text-sm",
              )}
            >
              {subtitle}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Tag
              text={uiSafeSummary.badge?.text || "Unknown"}
              tone={uiSafeSummary.badge?.tone || "neutral"}
            />
            {typeof onOpenLevelPicker === "function" ? (
              <Button variant="ghost" onClick={onOpenLevelPicker}>
                Change level
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-3">
          <ProgressBar value01={uiSafeSummary.readinessScore01} />
          <div className="mt-1 flex items-center justify-between text-xs text-black/50">
            <span>Starting</span>
            <span>Strong</span>
          </div>
        </div>
      </div>

      <div className={cx(compact ? "p-3" : "p-4")}>
        {loading ? (
          <div className="text-sm text-black/60">Loading readiness…</div>
        ) : err ? (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
            {err}
          </div>
        ) : (
          <>
            {/* KPI Row */}
            <div
              className={cx(
                "grid gap-3",
                compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-4",
              )}
            >
              <div className="rounded-xl border border-black/10 bg-white p-3">
                {kpiLabel("Food security")}
                {kpiValue(pct(uiSafeSummary.kpis?.foodSecurityPct, 0) || "—")}
                <div className="mt-1 text-xs text-black/50">Estimated</div>
              </div>

              <div className="rounded-xl border border-black/10 bg-white p-3">
                {kpiLabel("Days covered")}
                {kpiValue(
                  uiSafeSummary.kpis?.daysCovered != null
                    ? String(Math.round(uiSafeSummary.kpis.daysCovered))
                    : "—",
                )}
                <div className="mt-1 text-xs text-black/50">Estimated</div>
              </div>

              <div className="rounded-xl border border-black/10 bg-white p-3">
                {kpiLabel("Monthly savings")}
                {kpiValue(fmtMoney(uiSafeSummary.kpis?.monthlySavings) || "—")}
                <div className="mt-1 text-xs text-black/50">Estimated</div>
              </div>

              <div className="rounded-xl border border-black/10 bg-white p-3">
                {kpiLabel("Batch outputs")}
                {kpiValue(String(uiSafeSummary.kpis?.recentBatchesCount ?? 0))}
                <div className="mt-1 text-xs text-black/50">Last 14 days</div>
              </div>
            </div>

            {/* Details */}
            {showDetails ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-black/10 bg-zinc-50 p-3">
                  <div className="text-sm font-semibold">
                    What SSA is tracking
                  </div>
                  <ul className="mt-2 list-disc pl-5 text-sm text-black/70">
                    <li>
                      Level:{" "}
                      <span className="font-semibold text-black">
                        {uiSafeSummary.levelLabel}
                      </span>
                    </li>
                    <li>
                      Estimator:{" "}
                      <span className="font-semibold text-black">
                        {uiSafeSummary.show?.estimator ? "Enabled" : "Off"}
                      </span>
                    </li>
                    <li>
                      Farm-to-Table:{" "}
                      <span className="font-semibold text-black">
                        {uiSafeSummary.show?.ftt ? "Enabled" : "Off"}
                      </span>
                    </li>
                    <li>
                      Component inventory mapped:{" "}
                      <span className="font-semibold text-black">
                        {uiSafeSummary.kpis?.componentInvCount ?? 0}
                      </span>
                    </li>
                  </ul>

                  {gates && typeof gates === "object" ? (
                    <div className="mt-3 text-xs text-black/50">
                      Visibility rules applied for this level (deterministic).
                    </div>
                  ) : (
                    <div className="mt-3 text-xs text-black/50">
                      Visibility rules engine not available yet (showing safe
                      defaults).
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-black/10 bg-zinc-50 p-3">
                  <div className="text-sm font-semibold">Next best actions</div>
                  {Array.isArray(uiSafeSummary.actions) &&
                  uiSafeSummary.actions.length ? (
                    <div className="mt-2 flex flex-col gap-2">
                      {uiSafeSummary.actions.slice(0, 4).map((a) => (
                        <div
                          key={a.id}
                          className="rounded-lg border border-black/10 bg-white p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-black">
                                {a.title}
                              </div>
                              <div className="mt-1 text-sm text-black/70">
                                {a.body}
                              </div>
                            </div>
                            <Button
                              variant="subtle"
                              className="shrink-0"
                              onClick={() => handleAction(a)}
                              disabled={
                                (a.kind === "level" &&
                                  typeof onOpenLevelPicker !== "function") ||
                                (a.kind === "estimator" &&
                                  typeof onOpenEstimator !== "function") ||
                                (a.kind === "plan" &&
                                  typeof onOpenPlan !== "function")
                              }
                            >
                              Open
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 text-sm text-black/70">
                      You’re set. Keep logging batches and purchases.
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {typeof onOpenEstimator === "function" ? (
                      <Button variant="ghost" onClick={onOpenEstimator}>
                        Estimator
                      </Button>
                    ) : null}
                    {typeof onOpenPlan === "function" ? (
                      <Button variant="ghost" onClick={onOpenPlan}>
                        Farm-to-Table plan
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {/* Footnote */}
            <div className="mt-4 text-xs text-black/50">
              Readiness is deterministic and based on configured baselines,
              latest estimator snapshot, and logged FTT outputs. No AI is used.
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
