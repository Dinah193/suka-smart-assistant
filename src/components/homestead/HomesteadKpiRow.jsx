// C:\Users\larho\suka-smart-assistant\src\components\homestead\HomesteadKpiRow.jsx
/* eslint-disable react/prop-types */
/* eslint-disable no-console */
/**
 * SSA • Homestead KPI Row
 * -----------------------------------------------------------------------------
 * readiness score, backlog, next due targets
 *
 * Designed to sit at the top of Homestead Planner pages.
 *
 * What it does
 *  - Reads Homestead Planner tables (Dexie):
 *      • homesteadProvisioningTargets
 *      • homesteadInventory
 *      • homesteadBatches
 *      • homesteadGardenTargets
 *      • homesteadAnimalTargets
 *  - Computes:
 *      • Readiness Score (0–100) using simple, explainable heuristics
 *      • Backlog counts (overdue inventory, incomplete batches, uncomputed targets)
 *      • Next due targets (soonest expiring inventory, next "plan refresh" items)
 *  - Emits an event with the computed snapshot:
 *      • ssa.hp.kpi.snapshot
 *
 * Notes
 *  - This component is browser-safe (no Node imports)
 *  - If your app has a shared Dexie DB singleton, you can pass a `db` prop to avoid re-opening.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * Config
 * --------------------------------------------------------------------------- */

const SOURCE = "components/homestead/HomesteadKpiRow";
const DB_NAME = "SSA_HomesteadPlanner_Inventory_v1";

const DEFAULTS = {
  householdId: "primary",
  // how far forward to consider "next due"
  dueSoonDays: 14,
  // inventory freshness thresholds
  freshness: {
    okDays: 30, // bestBy/expires > 30d => ok
    warnDays: 7, // <= 7d => warn
    overdueDays: 0, // <= 0 => overdue
  },
  // how much each part influences readiness
  weights: {
    coverage: 0.55, // inventory coverage vs targets
    freshness: 0.3, // inventory shelf-life state
    backlog: 0.15, // outstanding work
  },
};

const DOMAIN_LABELS = {
  preservation: "Preservation",
  garden: "Garden",
  animals: "Animals",
  storehouse: "Storehouse",
  cooking: "Cooking",
  cleaning: "Cleaning",
  general: "General",
};

/* -----------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------- */

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}
function nowISO() {
  return new Date().toISOString();
}
function toLower(s) {
  return (typeof s === "string" ? s : s == null ? "" : String(s))
    .trim()
    .toLowerCase();
}
function uniq(arr) {
  return Array.from(
    new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean))
  );
}
function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}
function parseISO(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}
function daysBetween(a, b) {
  // b - a in days
  const ms = b.getTime() - a.getTime();
  return ms / 86400000;
}
function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}
function emitSSAEvent(type, detail) {
  try {
    if (typeof window !== "undefined" && window.eventBus?.emit)
      window.eventBus.emit(type, detail);
  } catch (e) {}
  try {
    if (typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch (e) {}
}
function scoreLabel(score) {
  if (score >= 85) return "Strong";
  if (score >= 70) return "Good";
  if (score >= 55) return "Needs attention";
  return "At risk";
}
function scoreTone(score) {
  if (score >= 85) return "success";
  if (score >= 70) return "neutral";
  if (score >= 55) return "warn";
  return "danger";
}
function fmtInt(n) {
  return new Intl.NumberFormat().format(safeNum(n, 0));
}
function shortDate(iso) {
  const d = parseISO(iso);
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

/* -----------------------------------------------------------------------------
 * Default DB opener (optional)
 * If you already have a shared db, pass it in as prop.
 * --------------------------------------------------------------------------- */

let _dbSingleton = null;

function getDb() {
  if (_dbSingleton) return _dbSingleton;

  const db = new Dexie(DB_NAME);

  // Keep stores definitions minimal (only the ones we read).
  // IMPORTANT: If your project already defines this DB elsewhere with versioning,
  // prefer passing that db instance via props to avoid divergence.
  db.version(1).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    homesteadProvisioningTargets:
      "id, nameLower, category, unit, qtyPerYear, updatedAt, createdAt, *tags",
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    homesteadGardenTargets:
      "id, computedAt, cropKey, cropNameLower, sourceHash, window, confidence, *tags",
    homesteadAnimalTargets:
      "id, computedAt, animalKey, animalNameLower, sourceHash, strategy, confidence, *tags",
  });

  _dbSingleton = db;
  return db;
}

/* -----------------------------------------------------------------------------
 * KPI compute logic (explainable heuristics)
 * --------------------------------------------------------------------------- */

function computeCoverageScore(targets, inventory) {
  // Naive coverage: if we have *any* inventory items matching a target's category/tags/name, it counts as covered.
  // Because targets are per-year quantities, deeper coverage modeling lives in targets.jsx; KPI is a top-level signal.
  if (!targets.length) return { score: 100, covered: 0, total: 0 };

  const invByCategory = new Map();
  const invTagSet = new Set();
  const invNames = new Set();

  for (const it of inventory) {
    invNames.add(toLower(it?.nameLower || it?.name || ""));
    const cat = toLower(it?.category || "");
    if (cat) invByCategory.set(cat, (invByCategory.get(cat) || 0) + 1);
    for (const t of uniq(it?.tags || [])) invTagSet.add(toLower(t));
  }

  let covered = 0;
  for (const t of targets) {
    const name = toLower(t?.nameLower || t?.name || "");
    const cat = toLower(t?.category || "");
    const tags = uniq(t?.tags || []).map(toLower);

    const nameHit = name && invNames.has(name);
    const catHit = cat && (invByCategory.get(cat) || 0) > 0;
    const tagHit = tags.length ? tags.some((x) => invTagSet.has(x)) : false;

    if (nameHit || catHit || tagHit) covered += 1;
  }

  const pct = covered / targets.length;
  return { score: Math.round(pct * 100), covered, total: targets.length };
}

function computeFreshnessScore(inventory, freshnessCfg) {
  // Evaluate shelf-life risk by earliest of expiresOn/bestByDate; if none => neutral.
  if (!inventory.length)
    return { score: 70, ok: 0, warn: 0, overdue: 0, total: 0 };

  const now = new Date();
  let ok = 0;
  let warn = 0;
  let overdue = 0;
  let total = 0;

  for (const it of inventory) {
    const status = toLower(it?.status || "");
    if (status === "archived" || status === "deleted") continue;

    const expires = parseISO(it?.expiresOn) || parseISO(it?.bestByDate);
    if (!expires) {
      // Unknown shelf life: treat as mild warn if it's a perishable domain, else ok-ish.
      const domain = toLower(it?.domain || "");
      if (["preservation", "garden", "animals", "cooking"].includes(domain))
        warn += 1;
      else ok += 1;
      total += 1;
      continue;
    }

    const d = daysBetween(now, expires); // days until expires
    total += 1;

    if (d <= freshnessCfg.overdueDays) overdue += 1;
    else if (d <= freshnessCfg.warnDays) warn += 1;
    else if (d >= freshnessCfg.okDays) ok += 1;
    else ok += 1;
  }

  if (!total) return { score: 70, ok: 0, warn: 0, overdue: 0, total: 0 };

  // Score: overdue hurts most, warn hurts somewhat
  const overdueRate = overdue / total;
  const warnRate = warn / total;

  const score = clamp(
    Math.round(100 - overdueRate * 70 - warnRate * 25),
    0,
    100
  );
  return { score, ok, warn, overdue, total };
}

function computeBacklogPenalty({
  overdueCount,
  incompleteBatches,
  missingTargets,
}) {
  // Convert backlog to a 0..100 "goodness" score where 100 is no backlog.
  const weighted =
    overdueCount * 2 + incompleteBatches * 3 + missingTargets * 1;
  // Map weighted backlog into penalty (cap)
  const penalty = clamp(weighted * 3, 0, 80); // max 80 penalty
  return clamp(100 - penalty, 0, 100);
}

function computeReadinessSnapshot({
  targets,
  inventory,
  batches,
  gardenTargets,
  animalTargets,
  config,
}) {
  const dueSoonDays = config.dueSoonDays;
  const now = new Date();
  const dueSoonCutoff = new Date(now.getTime() + dueSoonDays * 86400000);

  // Coverage score
  const coverage = computeCoverageScore(targets, inventory);

  // Freshness score
  const freshness = computeFreshnessScore(inventory, config.freshness);

  // Backlog metrics
  const overdueItems = findOverdueInventory(inventory);
  const incompleteBatches = (batches || []).filter((b) => {
    const st = toLower(b?.status || "");
    return st && st !== "completed" && st !== "archived";
  }).length;

  // Missing targets: garden/animal targets not computed recently (computedAt missing)
  const missingGarden = (gardenTargets || []).filter(
    (g) => !g?.computedAt
  ).length;
  const missingAnimals = (animalTargets || []).filter(
    (a) => !a?.computedAt
  ).length;
  const missingTargets = missingGarden + missingAnimals;

  const backlogGoodness = computeBacklogPenalty({
    overdueCount: overdueItems.length,
    incompleteBatches,
    missingTargets,
  });

  // Readiness (weighted)
  const w = config.weights;
  const readiness = clamp(
    Math.round(
      coverage.score * w.coverage +
        freshness.score * w.freshness +
        backlogGoodness * w.backlog
    ),
    0,
    100
  );

  // Next due: inventory expiring soon + incomplete batches updated recently + "recompute targets" hints
  const nextDueInventory = findNextDueInventory(inventory, dueSoonCutoff).slice(
    0,
    5
  );
  const nextDueBatches = (batches || [])
    .filter((b) => {
      const st = toLower(b?.status || "");
      if (!st || st === "completed" || st === "archived") return false;
      return true;
    })
    .sort((a, b) =>
      String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""))
    )
    .slice(0, 3)
    .map((b) => ({
      type: "batch",
      id: String(b?.id || ""),
      title: String(b?.title || b?.titleLower || "Preservation batch"),
      when: b?.startedAt || b?.updatedAt || b?.createdAt || null,
      meta: String(b?.methodLower || b?.status || ""),
      tone: "warn",
    }));

  const targetHints = [];
  if (missingGarden) {
    targetHints.push({
      type: "garden_targets",
      id: "garden_targets",
      title: "Compute garden targets",
      when: null,
      meta: `${missingGarden} missing`,
      tone: "warn",
    });
  }
  if (missingAnimals) {
    targetHints.push({
      type: "animal_targets",
      id: "animal_targets",
      title: "Compute animal targets",
      when: null,
      meta: `${missingAnimals} missing`,
      tone: "warn",
    });
  }

  const nextDue = [
    ...nextDueInventory,
    ...nextDueBatches,
    ...targetHints,
  ].slice(0, 8);

  return {
    computedAt: nowISO(),
    readiness,
    readinessLabel: scoreLabel(readiness),
    readinessTone: scoreTone(readiness),

    coverage,
    freshness,

    backlog: {
      overdueInventory: overdueItems.length,
      incompleteBatches,
      missingTargets,
      missingGarden,
      missingAnimals,
      backlogGoodness,
    },

    nextDue,
  };
}

function findOverdueInventory(inventory) {
  const now = new Date();
  const out = [];
  for (const it of inventory || []) {
    const st = toLower(it?.status || "");
    if (st === "archived" || st === "deleted") continue;
    const expires = parseISO(it?.expiresOn) || parseISO(it?.bestByDate);
    if (!expires) continue;
    const d = daysBetween(now, expires);
    if (d <= 0) out.push(it);
  }
  return out;
}

function findNextDueInventory(inventory, cutoffDate) {
  const now = new Date();
  const rows = [];

  for (const it of inventory || []) {
    const st = toLower(it?.status || "");
    if (st === "archived" || st === "deleted") continue;

    const expires = parseISO(it?.expiresOn) || parseISO(it?.bestByDate);
    if (!expires) continue;

    if (expires <= cutoffDate) {
      const d = Math.round(daysBetween(now, expires));
      const tone = d <= 0 ? "danger" : d <= 7 ? "warn" : "neutral";
      rows.push({
        type: "inventory",
        id: String(it?.id || ""),
        title: String(it?.name || it?.nameLower || "Inventory item"),
        when: expires.toISOString(),
        meta: d <= 0 ? "expired" : `due in ${d}d`,
        tone,
      });
    }
  }

  rows.sort((a, b) => String(a.when || "").localeCompare(String(b.when || "")));
  return rows;
}

/* -----------------------------------------------------------------------------
 * UI atoms (local, no dependencies)
 * --------------------------------------------------------------------------- */

function Badge({ tone = "neutral", children, title }) {
  const cls =
    tone === "success"
      ? "border-green-200 text-green-800 bg-green-50"
      : tone === "warn"
      ? "border-amber-200 text-amber-800 bg-amber-50"
      : tone === "danger"
      ? "border-red-200 text-red-800 bg-red-50"
      : "border-gray-200 text-black bg-white";
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-1 text-xs font-semibold",
        cls
      )}
    >
      {children}
    </span>
  );
}

function KpiCard({ title, value, subtitle, tone = "neutral", right, onClick }) {
  const clickable = !!onClick;
  return (
    <div
      className={cx(
        "rounded-2xl border border-gray-200 bg-white p-4",
        clickable ? "cursor-pointer hover:bg-gray-50 transition" : ""
      )}
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === "Enter" || e.key === " ") onClick?.();
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-bold opacity-70">{title}</div>
          <div className="mt-2 flex items-end gap-2">
            <div className="text-2xl font-black leading-none">{value}</div>
            <Badge tone={tone}>{toneLabel(tone)}</Badge>
          </div>
          {subtitle ? (
            <div className="text-xs opacity-70 mt-2">{subtitle}</div>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
    </div>
  );
}

function toneLabel(tone) {
  if (tone === "success") return "good";
  if (tone === "warn") return "watch";
  if (tone === "danger") return "risk";
  return "ok";
}

/* -----------------------------------------------------------------------------
 * Component
 * --------------------------------------------------------------------------- */

export default function HomesteadKpiRow({
  db = null,
  householdId = DEFAULTS.householdId,
  dueSoonDays = DEFAULTS.dueSoonDays,
  className = "",
  onNavigate = null, // optional: (to) => void (useful if you want clicking KPIs to route)
}) {
  const cfg = useMemo(() => {
    return {
      ...DEFAULTS,
      householdId,
      dueSoonDays,
    };
  }, [householdId, dueSoonDays]);

  const dbRef = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [data, setData] = useState({
    targets: [],
    inventory: [],
    batches: [],
    gardenTargets: [],
    animalTargets: [],
  });

  // Load once + refresh on storage events if your app emits them (optional)
  useEffect(() => {
    dbRef.current = db || getDb();

    (async () => {
      try {
        await loadAll(dbRef.current, setData);
        setError(null);
      } catch (e) {
        console.warn("[HomesteadKpiRow] load failed:", e);
        setError("KPI data unavailable.");
      } finally {
        setLoading(false);
      }
    })();

    const onRefresh = () => {
      loadAll(dbRef.current, setData).catch(() => {});
    };

    // Optional: listen for events from your planner pages
    window.addEventListener("ssa.hp.refresh", onRefresh);
    window.addEventListener("ssa.hp.targets.updated", onRefresh);
    window.addEventListener("ssa.hp.inventory.updated", onRefresh);
    window.addEventListener("ssa.hp.batches.updated", onRefresh);

    return () => {
      window.removeEventListener("ssa.hp.refresh", onRefresh);
      window.removeEventListener("ssa.hp.targets.updated", onRefresh);
      window.removeEventListener("ssa.hp.inventory.updated", onRefresh);
      window.removeEventListener("ssa.hp.batches.updated", onRefresh);
    };
  }, [db]);

  const snapshot = useMemo(() => {
    const snap = computeReadinessSnapshot({
      targets: data.targets,
      inventory: data.inventory,
      batches: data.batches,
      gardenTargets: data.gardenTargets,
      animalTargets: data.animalTargets,
      config: cfg,
    });

    emitSSAEvent("ssa.hp.kpi.snapshot", {
      source: SOURCE,
      householdId: cfg.householdId,
      ...snap,
      totals: {
        targets: data.targets.length,
        inventory: data.inventory.length,
        batches: data.batches.length,
      },
    });

    return snap;
  }, [data, cfg]);

  const nextDueCompact = useMemo(() => {
    return (snapshot.nextDue || []).slice(0, 3);
  }, [snapshot.nextDue]);

  const readinessSubtitle = useMemo(() => {
    const { coverage, freshness, backlog } = snapshot;
    return `${coverage.covered}/${coverage.total} targets covered • ${freshness.overdue} overdue • ${backlog.incompleteBatches} open batches`;
  }, [snapshot]);

  if (error) {
    return (
      <div
        className={cx(
          "rounded-2xl border border-red-200 bg-red-50 p-4 text-sm",
          className
        )}
      >
        <div className="font-bold text-red-800">Homestead KPIs</div>
        <div className="text-red-800 mt-1">{error}</div>
      </div>
    );
  }

  return (
    <div className={cx("w-full", className)}>
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        <KpiCard
          title="Readiness"
          value={loading ? "—" : `${snapshot.readiness}`}
          subtitle={loading ? "Computing…" : readinessSubtitle}
          tone={snapshot.readinessTone}
          onClick={
            onNavigate
              ? () => onNavigate("/homesteadplanner/targets")
              : undefined
          }
          right={
            <div className="text-right">
              <div className="text-xs font-bold opacity-70">status</div>
              <div className="mt-1">
                <Badge tone={snapshot.readinessTone}>
                  {snapshot.readinessLabel}
                </Badge>
              </div>
              <div className="text-[11px] opacity-60 mt-2">
                {shortDate(snapshot.computedAt)}
              </div>
            </div>
          }
        />

        <KpiCard
          title="Backlog"
          value={
            loading
              ? "—"
              : fmtInt(
                  snapshot.backlog.overdueInventory +
                    snapshot.backlog.incompleteBatches +
                    snapshot.backlog.missingTargets
                )
          }
          subtitle={
            loading
              ? "Computing…"
              : `${fmtInt(
                  snapshot.backlog.overdueInventory
                )} overdue items • ${fmtInt(
                  snapshot.backlog.incompleteBatches
                )} open batches • ${fmtInt(
                  snapshot.backlog.missingTargets
                )} targets missing`
          }
          tone={
            snapshot.backlog.overdueInventory > 0 ||
            snapshot.backlog.incompleteBatches > 0
              ? "warn"
              : snapshot.backlog.missingTargets > 0
              ? "neutral"
              : "success"
          }
          onClick={
            onNavigate
              ? () => onNavigate("/homesteadplanner/batches")
              : undefined
          }
          right={
            <div className="flex flex-col items-end gap-2">
              <Badge
                tone={
                  snapshot.backlog.overdueInventory > 0 ? "danger" : "neutral"
                }
              >
                overdue {fmtInt(snapshot.backlog.overdueInventory)}
              </Badge>
              <Badge
                tone={
                  snapshot.backlog.incompleteBatches > 0 ? "warn" : "neutral"
                }
              >
                batches {fmtInt(snapshot.backlog.incompleteBatches)}
              </Badge>
            </div>
          }
        />

        <KpiCard
          title="Next due"
          value={loading ? "—" : fmtInt(snapshot.nextDue.length)}
          subtitle={
            loading
              ? "Computing…"
              : "Soonest expiring inventory, open batches, and plan refresh tasks."
          }
          tone={
            snapshot.nextDue.some((x) => x.tone === "danger")
              ? "danger"
              : snapshot.nextDue.some((x) => x.tone === "warn")
              ? "warn"
              : "neutral"
          }
          onClick={
            onNavigate
              ? () => onNavigate("/homesteadplanner/inventory")
              : undefined
          }
          right={
            <div className="flex flex-col items-end gap-2">
              {nextDueCompact.length ? (
                nextDueCompact.map((x) => (
                  <div key={`${x.type}:${x.id}`} className="text-right">
                    <div className="text-xs font-bold">
                      <Badge tone={x.tone}>{x.type}</Badge>
                    </div>
                    <div className="text-xs mt-1 max-w-[14rem] truncate">
                      {x.title}
                    </div>
                    <div className="text-[11px] opacity-70">
                      {x.when ? shortDate(x.when) : "—"} • {x.meta || ""}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-xs opacity-70">Nothing due soon.</div>
              )}
            </div>
          }
        />
      </div>

      {/* Detail strip (optional, lightweight) */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone="neutral" title="Coverage score">
          coverage {fmtInt(snapshot.coverage.score)}%
        </Badge>
        <Badge
          tone={
            snapshot.freshness.overdue
              ? "danger"
              : snapshot.freshness.warn
              ? "warn"
              : "success"
          }
          title="Freshness score"
        >
          freshness {fmtInt(snapshot.freshness.score)}%
        </Badge>
        <Badge tone="neutral" title="Backlog goodness (100 = none)">
          backlog score {fmtInt(snapshot.backlog.backlogGoodness)}%
        </Badge>

        <span className="text-xs opacity-60 ml-auto">
          {loading ? "loading…" : `Updated ${shortDate(snapshot.computedAt)}`}
        </span>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Data loading
 * --------------------------------------------------------------------------- */

async function loadAll(db, setData) {
  // pull limited rows for speed; KPI is a snapshot, not a full analytics engine
  const [targets, inventory, batches, gardenTargets, animalTargets] =
    await Promise.all([
      db.homesteadProvisioningTargets
        ? db.homesteadProvisioningTargets.limit(200).toArray()
        : [],
      db.homesteadInventory ? db.homesteadInventory.limit(400).toArray() : [],
      db.homesteadBatches
        ? db.homesteadBatches
            .orderBy("updatedAt")
            .reverse()
            .limit(100)
            .toArray()
        : [],
      db.homesteadGardenTargets
        ? db.homesteadGardenTargets.limit(80).toArray()
        : [],
      db.homesteadAnimalTargets
        ? db.homesteadAnimalTargets.limit(80).toArray()
        : [],
    ]);

  setData({
    targets: targets || [],
    inventory: inventory || [],
    batches: batches || [],
    gardenTargets: gardenTargets || [],
    animalTargets: animalTargets || [],
  });
}
