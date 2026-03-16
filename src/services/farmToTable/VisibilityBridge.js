/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\VisibilityBridge.js
//
// VisibilityBridge (FTT)
// ----------------------
// Converts domain/engine outputs into **UI-safe summaries** depending on a
// household's homestead level + enabled domains + user visibility state.
//
// Why this exists
// - Engines can output deep, technical objects (targets, gaps, actions, drafts).
// - UI should not be overwhelmed, especially at beginner levels.
// - Different pages want different degrees of detail.
// - Users may dismiss panels ("don't show again") and collapse sections.
// - Homestead level changes what should be shown and how it's phrased.
//
// Inputs (common)
// - householdId
// - homesteadProfile (from repo) OR level (string)
// - visibilityState (from repo) OR per-call overrides
// - data: outputs from FTT engines (targets, gapCheck, sourcing, planItems, etc.)
//
// Output
// - { summary, cards, groups, stats, warnings, nextBestActions, debug }
//   where everything is safe to render without complex logic.
//
// This file is deterministic and non-AI by design.
// It makes best-effort reads from repos, but you can also pass direct objects
// for serverless/unit tests.
//
// Note: This bridge should NOT mutate engine outputs.

import db from "@/services/db";

// Optional repos (best-effort imports). If these paths do not exist yet,
// the bridge will still work when you pass profile/state explicitly.
let HomesteadProfileRepo = null;
let VisibilityStateRepo = null;

try {
  // eslint-disable-next-line global-require
  HomesteadProfileRepo = (
    await import("@/services/repos/homestead/homesteadProfile.repo.js")
  ).default;
} catch {
  HomesteadProfileRepo = null;
}
try {
  // eslint-disable-next-line global-require
  VisibilityStateRepo = (
    await import("@/services/repos/homestead/visibilityState.repo.js")
  ).default;
} catch {
  VisibilityStateRepo = null;
}

/* -------------------------------------------------------------------------- */
/* Utilities */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x, fallback = "") {
  if (x == null) return fallback;
  return String(x);
}

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  const nn = safeNum(n, min);
  return Math.min(max, Math.max(min, nn));
}

function toDayKey(iso) {
  return safeStr(iso, nowIso()).slice(0, 10);
}

function deepClone(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj || {}));
  }
}

function normalizeQty(qty) {
  if (!qty || typeof qty !== "object") return null;

  // SSA common shapes:
  // - { value, unit }
  // - { qty, unit }
  // - { amount: { value, unit } }
  if (qty.amount && typeof qty.amount === "object") {
    const v = safeNum(qty.amount.value, NaN);
    const u = safeStr(qty.amount.unit, "").trim();
    if (Number.isFinite(v) && u) return { value: v, unit: u };
  }

  const v = safeNum(qty.value ?? qty.qty, NaN);
  const u = safeStr(qty.unit, "").trim();
  if (Number.isFinite(v) && u) return { value: v, unit: u };

  return null;
}

function formatQty(qty, { maxDecimals = 1 } = {}) {
  const q = normalizeQty(qty);
  if (!q) return null;
  const d = clamp(maxDecimals, 0, 4);
  const v = Number.isInteger(q.value) ? q.value : Number(q.value.toFixed(d));
  return `${v} ${q.unit}`;
}

function unique(arr) {
  return Array.from(new Set((arr || []).map(String).filter(Boolean)));
}

function hashKey(parts) {
  return parts.map((p) => safeStr(p, "")).join("|");
}

function isTruthy(x) {
  return Boolean(x);
}

function hasTable(name) {
  try {
    void db.table(name);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Homestead levels + visibility policy */
/* -------------------------------------------------------------------------- */

export const HOMESTEAD_LEVELS = {
  // NOTE: Keep strings stable. UI can map these to labels.
  "0_off": {
    rank: 0,
    label: "Off",
    description: "Homestead planner disabled.",
  },
  "1_pantry": {
    rank: 1,
    label: "Pantry Builder",
    description: "Focus on stocking basics and reducing grocery spend.",
  },
  "2_scratch": {
    rank: 2,
    label: "Scratch Cooking",
    description: "Shift to cooking components and rotating staples.",
  },
  "3_homestead": {
    rank: 3,
    label: "Homestead",
    description:
      "Garden/animals/preservation planning and food security horizons.",
  },
  "4_village": {
    rank: 4,
    label: "Sacred Village",
    description: "Community-scale surplus, mutual aid, production scheduling.",
  },
};

function normalizeLevel(level) {
  const l = safeStr(level, "1_pantry").trim();
  if (HOMESTEAD_LEVELS[l]) return l;
  // accept numeric-ish shortcuts: 0..4
  const n = Number(l);
  if (Number.isFinite(n)) {
    if (n <= 0) return "0_off";
    if (n === 1) return "1_pantry";
    if (n === 2) return "2_scratch";
    if (n === 3) return "3_homestead";
    if (n >= 4) return "4_village";
  }
  return "1_pantry";
}

function levelRank(level) {
  return HOMESTEAD_LEVELS[normalizeLevel(level)]?.rank ?? 1;
}

function levelAllows(level, featureKey) {
  // Hard gate what appears at what level.
  const r = levelRank(level);

  // Pantry (1): show spend/baselines, quick wins, buy list, a few targets
  // Scratch (2): show components/batches, cook actions, small gap checks
  // Homestead (3): show garden/animals/preserve actions and long horizon
  // Village (4): show advanced breakdowns + plan items + distribution

  const gates = {
    baselines: r >= 1,
    estimator: r >= 1,
    targets: r >= 1,
    gaps: r >= 2,
    sourcing: r >= 2,
    components: r >= 2,
    batches: r >= 2,
    garden: r >= 3,
    animals: r >= 3,
    preservation: r >= 3,
    plans: r >= 3,
    plan_items: r >= 3,
    advanced_debug: r >= 4,
  };

  return Boolean(gates[featureKey]);
}

function defaultDetailLevel(level) {
  const r = levelRank(level);
  if (r <= 1) return "lite";
  if (r === 2) return "standard";
  if (r === 3) return "detailed";
  return "expert";
}

/* -------------------------------------------------------------------------- */
/* Visibility State helpers */
/* -------------------------------------------------------------------------- */

function normalizeVisibilityState(state) {
  const s = state && typeof state === "object" ? state : {};
  // "dismissedPanels": map panelKey -> true
  // "collapsedSections": map sectionKey -> true
  // "dontShowAgain": map key -> true
  return {
    dismissedPanels:
      s.dismissedPanels && typeof s.dismissedPanels === "object"
        ? s.dismissedPanels
        : {},
    collapsedSections:
      s.collapsedSections && typeof s.collapsedSections === "object"
        ? s.collapsedSections
        : {},
    dontShowAgain:
      s.dontShowAgain && typeof s.dontShowAgain === "object"
        ? s.dontShowAgain
        : {},
    preferences:
      s.preferences && typeof s.preferences === "object" ? s.preferences : {},
    updatedAt: s.updatedAt || null,
  };
}

function isDismissed(visibilityState, key) {
  const vs = normalizeVisibilityState(visibilityState);
  return Boolean(vs.dismissedPanels?.[key] || vs.dontShowAgain?.[key]);
}

function isCollapsed(visibilityState, key) {
  const vs = normalizeVisibilityState(visibilityState);
  return Boolean(vs.collapsedSections?.[key]);
}

/* -------------------------------------------------------------------------- */
/* Fetch profile/state (best effort) */
/* -------------------------------------------------------------------------- */

async function loadProfileIfNeeded({ householdId, homesteadProfile, level }) {
  if (homesteadProfile && typeof homesteadProfile === "object")
    return homesteadProfile;

  if (level) {
    return {
      householdId,
      level: normalizeLevel(level),
      enabledDomains: [],
      goals: [],
      updatedAt: nowIso(),
    };
  }

  if (
    HomesteadProfileRepo &&
    typeof HomesteadProfileRepo.getActive === "function"
  ) {
    try {
      return await HomesteadProfileRepo.getActive(householdId);
    } catch {
      // ignore
    }
  }

  // fallback
  return {
    householdId,
    level: "1_pantry",
    enabledDomains: [],
    goals: [],
    updatedAt: nowIso(),
  };
}

async function loadVisibilityIfNeeded({ householdId, visibilityState }) {
  if (visibilityState && typeof visibilityState === "object")
    return normalizeVisibilityState(visibilityState);

  if (
    VisibilityStateRepo &&
    typeof VisibilityStateRepo.getForHousehold === "function"
  ) {
    try {
      const vs = await VisibilityStateRepo.getForHousehold(householdId);
      return normalizeVisibilityState(vs);
    } catch {
      // ignore
    }
  }

  return normalizeVisibilityState({});
}

/* -------------------------------------------------------------------------- */
/* UI-safe object shapes */
/* -------------------------------------------------------------------------- */

function makeCard({
  id,
  title,
  subtitle,
  status = "info", // info|success|warning|danger|neutral
  icon = null,
  bullets = [],
  metrics = [],
  actions = [],
  tags = [],
  hiddenReason = null,
  collapsibleKey = null,
} = {}) {
  return {
    id: safeStr(id, ""),
    title: safeStr(title, ""),
    subtitle: subtitle == null ? null : safeStr(subtitle),
    status,
    icon,
    bullets: (bullets || []).map((b) => safeStr(b)).filter(Boolean),
    metrics: (metrics || [])
      .map((m) => ({
        label: safeStr(m?.label, ""),
        value: safeStr(m?.value, ""),
      }))
      .filter((m) => m.label && m.value),
    actions: (actions || [])
      .map((a) => ({
        id: safeStr(a?.id || a?.actionId || "", ""),
        label: safeStr(a?.label || a?.title || "", ""),
        kind: safeStr(a?.kind || "navigate"),
        payload: a?.payload && typeof a.payload === "object" ? a.payload : null,
      }))
      .filter((a) => a.label),
    tags: unique(tags || []),
    hiddenReason,
    collapsibleKey,
  };
}

function makeGroup({
  id,
  title,
  description,
  cards = [],
  hiddenReason = null,
} = {}) {
  return {
    id: safeStr(id, ""),
    title: safeStr(title, ""),
    description: description == null ? null : safeStr(description),
    cards: Array.isArray(cards) ? cards : [],
    hiddenReason,
  };
}

/* -------------------------------------------------------------------------- */
/* Summarizers: estimators / targets / gaps / sourcing / plan items */
/* -------------------------------------------------------------------------- */

function summarizeEstimator({
  level,
  visibilityState,
  baselines,
  snapshots,
} = {}) {
  const cards = [];
  const groups = [];
  const stats = {};
  const warnings = [];

  const showEstimator = levelAllows(level, "estimator");
  if (!showEstimator) {
    return {
      cards: [],
      groups: [],
      stats: {},
      warnings: [],
    };
  }

  const dismissed = isDismissed(visibilityState, "ftt.estimator");

  // Basic stats
  const lastSnap =
    Array.isArray(snapshots) && snapshots.length
      ? [...snapshots].sort((a, b) =>
          safeStr(b.createdAt || b.updatedAt).localeCompare(
            safeStr(a.createdAt || a.updatedAt),
          ),
        )[0]
      : null;

  const foodSecurityPct = safeNum(
    lastSnap?.foodSecurityPct ?? lastSnap?.outputs?.foodSecurityPct,
    null,
  );
  const daysCovered = safeNum(
    lastSnap?.daysCovered ?? lastSnap?.outputs?.daysCovered,
    null,
  );
  const monthlySavings = safeNum(
    lastSnap?.monthlySavings ?? lastSnap?.outputs?.monthlySavings,
    null,
  );

  if (foodSecurityPct != null)
    stats.foodSecurityPct = clamp(foodSecurityPct, 0, 100);
  if (daysCovered != null) stats.daysCovered = Math.max(0, daysCovered);
  if (monthlySavings != null) stats.monthlySavings = monthlySavings;

  // Pantry levels: keep it simple
  const detail = defaultDetailLevel(level);
  const metrics = [];

  if (stats.foodSecurityPct != null)
    metrics.push({
      label: "Food security",
      value: `${Math.round(stats.foodSecurityPct)}%`,
    });
  if (stats.daysCovered != null)
    metrics.push({
      label: "Days covered",
      value: `${Math.round(stats.daysCovered)}`,
    });
  if (stats.monthlySavings != null)
    metrics.push({
      label: "Monthly savings",
      value: `$${Math.round(stats.monthlySavings)}`,
    });

  const baselineSpend = safeNum(
    baselines?.grocerySpendMonthly ?? baselines?.grocerySpend ?? null,
    null,
  );
  const eatingOut = safeNum(
    baselines?.eatingOutMonthly ?? baselines?.eatingOutSpend ?? null,
    null,
  );
  const mealsPerWeek = safeNum(baselines?.mealsPerWeek ?? null, null);

  if (detail !== "lite") {
    if (baselineSpend != null)
      metrics.push({
        label: "Grocery baseline",
        value: `$${Math.round(baselineSpend)}/mo`,
      });
    if (eatingOut != null)
      metrics.push({
        label: "Eating out",
        value: `$${Math.round(eatingOut)}/mo`,
      });
    if (mealsPerWeek != null)
      metrics.push({
        label: "Meals/week",
        value: `${Math.round(mealsPerWeek)}`,
      });
  }

  const card = makeCard({
    id: "ftt.estimator.summary",
    title: "Food Security Snapshot",
    subtitle:
      detail === "lite"
        ? "A quick look at coverage and savings"
        : "Coverage, savings, and baselines",
    status:
      stats.foodSecurityPct != null && stats.foodSecurityPct >= 70
        ? "success"
        : stats.foodSecurityPct != null && stats.foodSecurityPct >= 40
          ? "warning"
          : "info",
    bullets:
      detail === "lite"
        ? [
            "Increase scratch cooking to improve coverage.",
            "Stock 10–15 pantry staples to reduce grocery swings.",
          ]
        : [
            "Food security rises when pantry staples and components are kept in rotation.",
            "Savings increases when components replace impulse buys and eating out.",
          ],
    metrics,
    actions: [
      {
        id: "ftt.openEstimator",
        label: "Open Estimator",
        kind: "navigate",
        payload: { to: "/tier2/household/homestead/estimator" },
      },
    ],
    tags: ["ftt", "estimator", "food_security"],
    hiddenReason: dismissed ? "dismissed" : null,
    collapsibleKey: "ftt.estimator",
  });

  if (!dismissed) cards.push(card);

  groups.push(
    makeGroup({
      id: "ftt.estimator.group",
      title: "Estimator",
      description: "Coverage and savings from your homestead settings",
      cards,
    }),
  );

  if (!snapshots || !Array.isArray(snapshots) || snapshots.length === 0) {
    warnings.push(
      "No estimator snapshots found yet. Run the Estimator once to populate baseline outputs.",
    );
  }

  return { cards, groups, stats, warnings };
}

function summarizeTargets({ level, visibilityState, targetsResult } = {}) {
  const showTargets = levelAllows(level, "targets");
  if (!showTargets) return { cards: [], groups: [], stats: {}, warnings: [] };

  const dismissed = isDismissed(visibilityState, "ftt.targets");
  if (dismissed) return { cards: [], groups: [], stats: {}, warnings: [] };

  const detail = defaultDetailLevel(level);

  const lines = Array.isArray(targetsResult?.lines)
    ? targetsResult.lines
    : Array.isArray(targetsResult?.targets)
      ? targetsResult.targets
      : [];

  // Keep UI safe: pick top lines by priority/qty
  const normalized = lines
    .map((l) => ({
      itemKey: safeStr(l.itemKey || l.item || l.sku, "").trim() || null,
      componentKey: safeStr(l.componentKey || l.component, "").trim() || null,
      qty: normalizeQty(l.qty || l.targetQty || l.amount || l.quantity),
      priority: safeStr(l.priority || "normal"),
      title: safeStr(l.title || "", "") || null,
      kind: safeStr(l.kind || "target"),
      tags: Array.isArray(l.tags) ? l.tags.map(String).filter(Boolean) : [],
    }))
    .filter((l) => l.qty && (l.itemKey || l.componentKey));

  const priorityRank = (p) => {
    const pp = safeStr(p, "normal").toLowerCase();
    if (pp === "critical") return 0;
    if (pp === "high") return 1;
    if (pp === "normal") return 2;
    if (pp === "low") return 3;
    return 4;
  };

  normalized.sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return safeNum(b.qty?.value, 0) - safeNum(a.qty?.value, 0);
  });

  const maxLines = detail === "lite" ? 6 : detail === "standard" ? 10 : 14;
  const top = normalized.slice(0, maxLines);

  const bullets =
    detail === "lite"
      ? ["These are the highest-impact targets to stock/prepare next."]
      : [
          "Targets are what your home should have ready for your chosen horizon.",
        ];

  const cards = [
    makeCard({
      id: "ftt.targets.top",
      title: "Top Provisioning Targets",
      subtitle: `Showing ${top.length} of ${normalized.length}`,
      status: "info",
      bullets,
      metrics: top.slice(0, 5).map((t) => ({
        label: t.title || t.itemKey || t.componentKey,
        value: formatQty(t.qty) || "",
      })),
      actions: [
        {
          id: "ftt.openTargets",
          label: "View All Targets",
          kind: "navigate",
          payload: { to: "/tier2/household/homestead/targets" },
        },
      ],
      tags: ["ftt", "targets"],
      collapsibleKey: "ftt.targets",
    }),
  ];

  const groups = [
    makeGroup({
      id: "ftt.targets.group",
      title: "Targets",
      description:
        "What to stock, batch, grow, or buy for your planning window",
      cards,
    }),
  ];

  const stats = {
    targetLines: normalized.length,
  };

  return { cards, groups, stats, warnings: [] };
}

function summarizeGaps({ level, visibilityState, gapResult } = {}) {
  const showGaps = levelAllows(level, "gaps");
  if (!showGaps) return { cards: [], groups: [], stats: {}, warnings: [] };

  const dismissed = isDismissed(visibilityState, "ftt.gaps");
  if (dismissed) return { cards: [], groups: [], stats: {}, warnings: [] };

  const detail = defaultDetailLevel(level);

  const lines = Array.isArray(gapResult?.lines) ? gapResult.lines : [];
  const normalized = lines
    .map((l) => {
      const targetQty = normalizeQty(l.targetQty || l.qty);
      const onHandQty = normalizeQty(l.onHandQty);
      const gapQty =
        normalizeQty(l.gapQty) ||
        (targetQty && onHandQty && targetQty.unit === onHandQty.unit
          ? {
              value: Math.max(0, targetQty.value - onHandQty.value),
              unit: targetQty.unit,
            }
          : null);

      return {
        itemKey: safeStr(l.itemKey || l.item || l.sku, "").trim() || null,
        componentKey: safeStr(l.componentKey || l.component, "").trim() || null,
        title: safeStr(l.title || "", "") || null,
        targetQty,
        onHandQty,
        gapQty,
        coveragePct: safeNum(l.coveragePct, null),
        priority: safeStr(l.priority || "normal"),
      };
    })
    .filter(
      (l) => l.gapQty && l.gapQty.value > 0 && (l.itemKey || l.componentKey),
    );

  normalized.sort(
    (a, b) => safeNum(b.gapQty?.value, 0) - safeNum(a.gapQty?.value, 0),
  );

  const maxLines = detail === "standard" ? 8 : detail === "detailed" ? 12 : 6;
  const top = normalized.slice(0, maxLines);

  const cards = [
    makeCard({
      id: "ftt.gaps.top",
      title: "Top Gaps to Fill",
      subtitle: `Showing ${top.length} of ${normalized.length}`,
      status: normalized.length === 0 ? "success" : "warning",
      bullets:
        normalized.length === 0
          ? ["You’re covered for the current targets window."]
          : ["Fill these gaps to increase coverage for your planned meals."],
      metrics: top.map((g) => ({
        label: g.title || g.itemKey || g.componentKey,
        value: formatQty(g.gapQty) || "",
      })),
      actions: [
        {
          id: "ftt.openGaps",
          label: "View Gap Details",
          kind: "navigate",
          payload: { to: "/tier2/household/homestead/gaps" },
        },
      ],
      tags: ["ftt", "gaps"],
      collapsibleKey: "ftt.gaps",
    }),
  ];

  const stats = {
    gapLines: normalized.length,
  };

  return {
    cards,
    groups: [
      makeGroup({
        id: "ftt.gaps.group",
        title: "Gaps",
        description: "What’s missing versus your targets",
        cards,
      }),
    ],
    stats,
    warnings: [],
  };
}

function summarizeSourcing({ level, visibilityState, sourcingResult } = {}) {
  const showSourcing = levelAllows(level, "sourcing");
  if (!showSourcing) return { cards: [], groups: [], stats: {}, warnings: [] };

  const dismissed = isDismissed(visibilityState, "ftt.sourcing");
  if (dismissed) return { cards: [], groups: [], stats: {}, warnings: [] };

  const detail = defaultDetailLevel(level);

  const actions = Array.isArray(sourcingResult?.actions)
    ? sourcingResult.actions
    : [];
  const normalized = actions
    .map((a) => ({
      id: safeStr(a.id || a.actionId, ""),
      kind: safeStr(a.kind || "buy"),
      itemKey: safeStr(a.itemKey, "") || null,
      componentKey: safeStr(a.componentKey, "") || null,
      qty: normalizeQty(a.qty),
      priority: safeStr(a.priority || "normal"),
      reason: safeStr(a.reason || "", "") || null,
    }))
    .filter((a) => a.kind && a.qty && (a.itemKey || a.componentKey));

  const allowedKindsByLevel = (lvl) => {
    const r = levelRank(lvl);
    if (r <= 1) return new Set(["buy", "use_on_hand"]);
    if (r === 2) return new Set(["buy", "cook", "use_on_hand", "preserve"]);
    if (r === 3)
      return new Set([
        "buy",
        "cook",
        "use_on_hand",
        "preserve",
        "garden",
        "animals",
      ]);
    return new Set([
      "buy",
      "cook",
      "use_on_hand",
      "preserve",
      "garden",
      "animals",
      "unknown",
    ]);
  };

  const allowed = allowedKindsByLevel(level);
  const filtered = normalized.filter((a) => allowed.has(a.kind));

  // Bucket for UI
  const buckets = {
    use_on_hand: [],
    cook: [],
    preserve: [],
    garden: [],
    animals: [],
    buy: [],
    unknown: [],
  };
  for (const a of filtered) {
    if (!buckets[a.kind]) buckets[a.kind] = [];
    buckets[a.kind].push(a);
  }

  const maxPerBucket = detail === "lite" ? 3 : detail === "standard" ? 5 : 8;

  const cards = [];
  const pushBucketCard = (kind, title, status, subtitle) => {
    const arr = buckets[kind] || [];
    if (!arr.length) return;

    arr.sort((x, y) => safeNum(y.qty?.value, 0) - safeNum(x.qty?.value, 0));
    const top = arr.slice(0, maxPerBucket);

    cards.push(
      makeCard({
        id: `ftt.sourcing.${kind}`,
        title,
        subtitle:
          subtitle ||
          `Top ${Math.min(maxPerBucket, arr.length)} of ${arr.length}`,
        status,
        bullets:
          detail === "lite"
            ? []
            : ["Tap into this list to generate tasks or a shopping list."],
        metrics: top.map((t) => ({
          label: t.componentKey || t.itemKey,
          value: formatQty(t.qty) || "",
        })),
        actions: [
          {
            id: `ftt.openSourcing.${kind}`,
            label: kind === "buy" ? "Add to Grocery Draft" : "Create Tasks",
            kind: "dispatch",
            payload: { kind, items: top },
          },
        ],
        tags: ["ftt", "sourcing", `sourcing.${kind}`],
      }),
    );
  };

  pushBucketCard("use_on_hand", "Use What You Have", "success");
  pushBucketCard("cook", "Cook Components", "info");
  pushBucketCard("preserve", "Preserve / Batch", "info");
  if (levelAllows(level, "garden"))
    pushBucketCard("garden", "Garden Actions", "warning");
  if (levelAllows(level, "animals"))
    pushBucketCard("animals", "Animal Actions", "warning");
  pushBucketCard("buy", "Buy List", "warning");

  const groups = [
    makeGroup({
      id: "ftt.sourcing.group",
      title: "Sourcing",
      description: "How to satisfy your gaps (on-hand, cook, grow, or buy)",
      cards,
    }),
  ];

  const stats = {
    actionsTotal: normalized.length,
    actionsShown: filtered.length,
    buyCount: buckets.buy.length,
    cookCount: buckets.cook.length,
    onHandCount: buckets.use_on_hand.length,
  };

  return { cards, groups, stats, warnings: [] };
}

function summarizePlanItems({ level, visibilityState, planItems } = {}) {
  const showPlanItems = levelAllows(level, "plan_items");
  if (!showPlanItems) return { cards: [], groups: [], stats: {}, warnings: [] };

  const dismissed = isDismissed(visibilityState, "ftt.planItems");
  if (dismissed) return { cards: [], groups: [], stats: {}, warnings: [] };

  const detail = defaultDetailLevel(level);

  const items = Array.isArray(planItems)
    ? planItems
    : Array.isArray(planItems?.items)
      ? planItems.items
      : [];
  const normalized = items
    .map((x) => ({
      id: safeStr(x.id, ""),
      kind: safeStr(x.kind || "note"),
      status: safeStr(x.status || "active"),
      itemKey: safeStr(x.itemKey, "") || null,
      componentKey: safeStr(x.componentKey, "") || null,
      title: safeStr(x.title || x.label || "", "") || null,
      summary: safeStr(x.summary || "", "") || null,
      qty: normalizeQty(x.qty || x.amount),
      updatedAt: x.updatedAt || x.createdAt || null,
    }))
    .filter((x) => x.kind);

  // At homestead/village we can show some of these, but keep top N only
  normalized.sort((a, b) =>
    safeStr(b.updatedAt).localeCompare(safeStr(a.updatedAt)),
  );

  const maxItems = detail === "detailed" ? 10 : 6;
  const top = normalized.slice(0, maxItems);

  const cards = [
    makeCard({
      id: "ftt.planItems.recent",
      title: "Plan Items (Recent)",
      subtitle: `Showing ${top.length} of ${normalized.length}`,
      status: "info",
      bullets: [
        "These are the latest saved plan items for your homestead plan.",
      ],
      metrics: top.map((t) => ({
        label: t.title || t.componentKey || t.itemKey || t.kind,
        value: t.qty ? formatQty(t.qty) : t.status,
      })),
      actions: [
        {
          id: "ftt.openPlans",
          label: "Open Homestead Plans",
          kind: "navigate",
          payload: { to: "/tier2/household/homestead/plans" },
        },
      ],
      tags: ["ftt", "plans", "plan_items"],
      collapsibleKey: "ftt.planItems",
    }),
  ];

  return {
    cards,
    groups: [
      makeGroup({
        id: "ftt.planItems.group",
        title: "Plans",
        description: "Saved homestead plans and their items",
        cards,
      }),
    ],
    stats: { planItems: normalized.length },
    warnings: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Orchestrator: build UI-safe summary bundle */
/* -------------------------------------------------------------------------- */

/**
 * Build UI-safe summaries for a homestead dashboard or domain page.
 *
 * @param {object} args
 * @param {string} args.householdId
 * @param {object=} args.homesteadProfile  // optional (if not provided, bridge tries repo)
 * @param {string=} args.level             // optional override for homesteadProfile.level
 * @param {object=} args.visibilityState   // optional (if not provided, bridge tries repo)
 * @param {object=} args.data              // engine outputs
 * @param {object=} args.options
 * @returns {Promise<object>} ui summary bundle
 */
export async function buildUiSafeSummaryBundle({
  householdId,
  homesteadProfile = null,
  level = null,
  visibilityState = null,
  data = {},
  options = {},
} = {}) {
  const hId = safeStr(householdId).trim();
  if (!hId) throw new Error("[VisibilityBridge] householdId is required");

  const profile = await loadProfileIfNeeded({
    householdId: hId,
    homesteadProfile,
    level,
  });
  const vs = await loadVisibilityIfNeeded({
    householdId: hId,
    visibilityState,
  });

  const lvl = normalizeLevel(level || profile?.level);
  const detail = safeStr(options.detail || defaultDetailLevel(lvl));

  // Data inputs (best effort)
  const baselines = data?.baselines || null;
  const snapshots = data?.snapshots || null;
  const targets = data?.targets || data?.fttTargets || null;
  const gaps = data?.gaps || data?.gapCheck || null;
  const sourcing = data?.sourcing || null;
  const planItems = data?.planItems || data?.fttPlanItems || null;

  // Collect groups by feature, applying level gates + visibility dismissals
  const groups = [];
  const cards = [];
  const stats = {};
  const warnings = [];
  const nextBestActions = [];

  // Estimator (always useful early)
  const est = summarizeEstimator({
    level: lvl,
    visibilityState: vs,
    baselines,
    snapshots,
  });
  if (est.groups.length) groups.push(...est.groups);
  cards.push(...est.cards);
  Object.assign(stats, est.stats);
  warnings.push(...(est.warnings || []));

  // Targets
  const tgt = summarizeTargets({
    level: lvl,
    visibilityState: vs,
    targetsResult: targets,
  });
  if (tgt.groups.length) groups.push(...tgt.groups);
  cards.push(...tgt.cards);
  Object.assign(stats, tgt.stats);

  // Gaps
  const gp = summarizeGaps({
    level: lvl,
    visibilityState: vs,
    gapResult: gaps,
  });
  if (gp.groups.length) groups.push(...gp.groups);
  cards.push(...gp.cards);
  Object.assign(stats, gp.stats);

  // Sourcing actions
  const src = summarizeSourcing({
    level: lvl,
    visibilityState: vs,
    sourcingResult: sourcing,
  });
  if (src.groups.length) groups.push(...src.groups);
  cards.push(...src.cards);
  Object.assign(stats, src.stats);

  // Plan items (only at homestead+)
  const pi = summarizePlanItems({ level: lvl, visibilityState: vs, planItems });
  if (pi.groups.length) groups.push(...pi.groups);
  cards.push(...pi.cards);
  Object.assign(stats, pi.stats);

  // Next Best Actions (NBA) – deterministic:
  // Pick 3 actions in priority order using sourcing buckets if provided.
  if (Array.isArray(sourcing?.actions)) {
    const prRank = (p) => {
      const pp = safeStr(p, "normal").toLowerCase();
      if (pp === "critical") return 0;
      if (pp === "high") return 1;
      if (pp === "normal") return 2;
      if (pp === "low") return 3;
      return 4;
    };

    const allowedKinds = (() => {
      const r = levelRank(lvl);
      if (r <= 1) return new Set(["buy", "use_on_hand"]);
      if (r === 2) return new Set(["buy", "cook", "use_on_hand", "preserve"]);
      if (r === 3)
        return new Set([
          "buy",
          "cook",
          "use_on_hand",
          "preserve",
          "garden",
          "animals",
        ]);
      return new Set([
        "buy",
        "cook",
        "use_on_hand",
        "preserve",
        "garden",
        "animals",
        "unknown",
      ]);
    })();

    const nba = sourcing.actions
      .map((a) => ({
        id: safeStr(a.id, ""),
        kind: safeStr(a.kind, "buy"),
        itemKey: safeStr(a.itemKey, "") || null,
        componentKey: safeStr(a.componentKey, "") || null,
        qty: normalizeQty(a.qty),
        priority: safeStr(a.priority || "normal"),
      }))
      .filter((a) => a.id && a.qty && allowedKinds.has(a.kind))
      .sort((a, b) => {
        const pr = prRank(a.priority) - prRank(b.priority);
        if (pr !== 0) return pr;
        return safeNum(b.qty.value, 0) - safeNum(a.qty.value, 0);
      })
      .slice(0, detail === "lite" ? 2 : 3)
      .map((a) => ({
        id: a.id,
        label:
          a.kind === "buy"
            ? `Buy: ${a.itemKey || a.componentKey} (${formatQty(a.qty)})`
            : a.kind === "cook"
              ? `Cook: ${a.componentKey || a.itemKey} (${formatQty(a.qty)})`
              : a.kind === "use_on_hand"
                ? `Use on-hand: ${a.itemKey || a.componentKey} (${formatQty(a.qty)})`
                : `${a.kind}: ${a.itemKey || a.componentKey} (${formatQty(a.qty)})`,
        kind: "dispatch",
        payload: { action: a },
      }));

    nextBestActions.push(...nba);
  }

  // Global summary header (small)
  const summary = {
    householdId: hId,
    level: lvl,
    levelLabel: HOMESTEAD_LEVELS[lvl]?.label || lvl,
    detail,
    generatedAt: nowIso(),
    // A concise "what to do next" line for top of the dashboard
    headline: (() => {
      const fs = stats.foodSecurityPct;
      if (fs != null) {
        if (fs >= 70)
          return "You’re in a strong position. Maintain rotation and fill a few small gaps.";
        if (fs >= 40)
          return "You’re building coverage. Focus on top gaps + 1–2 components this week.";
        return "Coverage is low. Start with pantry staples + a short buy list.";
      }
      return lvl === "1_pantry"
        ? "Start with pantry staples and a simple buy list."
        : "Review targets, then fill gaps using on-hand + components.";
    })(),
  };

  // Apply collapsed sections policy:
  // If a group is collapsed, keep it in output but mark all its cards as hidden.
  const finalGroups = groups.map((g) => {
    const collapsed =
      isCollapsed(vs, g.id) ||
      isCollapsed(vs, g?.cards?.[0]?.collapsibleKey || "");
    if (!collapsed) return g;

    return {
      ...g,
      cards: (g.cards || []).map((c) => ({
        ...c,
        hiddenReason: c.hiddenReason || "collapsed",
      })),
    };
  });

  // Filter out cards that are dismissed/collapsed (UI can still choose to render them)
  const visibleCards = cards.filter((c) => !c.hiddenReason);

  return {
    summary,
    // Provide both a grouped view and a flattened list
    groups: finalGroups,
    cards: visibleCards,
    stats,
    warnings: unique(warnings),
    nextBestActions,
    debug: options.includeDebug
      ? {
          profile: deepClone(profile),
          visibilityState: deepClone(vs),
          rawDataKeys: Object.keys(data || {}),
        }
      : null,
  };
}

/**
 * Convenience: build UI summary bundle from householdId, auto-loading profile/state,
 * and optionally auto-loading estimator data if requested.
 */
export async function buildDashboardBundle({
  householdId,
  data = {},
  options = {},
} = {}) {
  const hId = safeStr(householdId).trim();
  if (!hId) throw new Error("[VisibilityBridge] householdId is required");

  // Optional: load baselines/snapshots automatically if tables exist and caller wants it.
  const autoLoadEstimator = options.autoLoadEstimator === true;

  let baselines = data.baselines || null;
  let snapshots = data.snapshots || null;

  if (autoLoadEstimator) {
    if (!baselines && hasTable("estimator_baselines")) {
      try {
        const rows = await db.estimator_baselines
          .where("householdId")
          .equals(hId)
          .toArray();
        baselines =
          rows.sort((a, b) =>
            safeStr(b.updatedAt || b.createdAt).localeCompare(
              safeStr(a.updatedAt || a.createdAt),
            ),
          )[0] || null;
      } catch {
        // ignore
      }
    }
    if (!snapshots && hasTable("estimator_snapshots")) {
      try {
        const rows = await db.estimator_snapshots
          .where("householdId")
          .equals(hId)
          .toArray();
        snapshots = rows.sort((a, b) =>
          safeStr(b.createdAt || b.updatedAt).localeCompare(
            safeStr(a.createdAt || a.updatedAt),
          ),
        );
      } catch {
        // ignore
      }
    }
  }

  return buildUiSafeSummaryBundle({
    householdId: hId,
    data: { ...data, baselines, snapshots },
    options,
  });
}

const VisibilityBridge = {
  HOMESTEAD_LEVELS,
  buildUiSafeSummaryBundle,
  buildDashboardBundle,
};

export default VisibilityBridge;
