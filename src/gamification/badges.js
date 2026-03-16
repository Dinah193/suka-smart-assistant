// File: src/gamification/badges.js
/**
 * Badges (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Central badge catalog + evaluation helpers for SSA gamification.
 *  - Browser-only. No Node imports.
 *  - Designed to plug into xpEngine.configure({ badges }) or be used standalone.
 *
 * Badge Model
 * -----------------------------------------------------------------------------
 * {
 *   id: string,                      // stable key
 *   name: string,
 *   description: string,
 *   icon?: string,                   // emoji or icon key
 *   tier?: "bronze"|"silver"|"gold"|"platinum",
 *   category?: string,               // e.g. "cleaning" | "cooking" | "garden"
 *   hidden?: boolean,                // if true, only show when earned
 *   points?: number,                 // optional "badge points"
 *   test: (ctx) => boolean,          // pure function
 * }
 *
 * ctx passed to test()
 * -----------------------------------------------------------------------------
 * {
 *   profile: { totalXp, level, streakDays, ... },
 *   stats: {
 *     totals: { sessionsCompleted, minutes, steps, ... },
 *     byDomain: { cleaning:{...}, cooking:{...}, ... },
 *     byEventType: { "session/completed": 14, ... },
 *     byRuleId: { session_completed_base: 560, ... },
 *     last7Days: { xp, sessionsCompleted, ... },
 *     last30Days: { xp, sessionsCompleted, ... },
 *   },
 *   ledger: [ {ts, dayKey, type, ruleId, xp, meta, ...}, ... ] // optional
 * }
 *
 * Notes
 *  - This file does not assume you persist ledger in a specific place.
 *  - You can build `stats` from your ledger using computeBadgeStats().
 */

function asInt(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : fallback;
}

function clamp(n, min, max) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
}

function safeString(v) {
  return String(v ?? "");
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function toDayKeyLocal(tsOrISO) {
  const d = new Date(tsOrISO);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dayKey, deltaDays) {
  const d = new Date(`${dayKey}T12:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return toDayKeyLocal(d.toISOString());
}

function dayKeyTodayLocal() {
  return toDayKeyLocal(new Date().toISOString());
}

function withinDayRange(entryDayKey, fromDayKey, toDayKey) {
  // inclusive
  return entryDayKey >= fromDayKey && entryDayKey <= toDayKey;
}

function domainFromType(type) {
  const t = safeString(type);
  const root = t.split("/")[0] || "unknown";
  return root;
}

/* -------------------------------------------------------------------------- */
/*                              Badge stats helper                             */
/* -------------------------------------------------------------------------- */

/**
 * Build lightweight stats from a ledger.
 * This is meant for badge tests and UI.
 *
 * @param {Array} ledgerEntries
 * @param {{ nowISO?:string, dayKeyFn?:(ts)=>string }} [opts]
 */
export function computeBadgeStats(ledgerEntries, opts = {}) {
  const ledger = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  const dayKeyFn =
    typeof opts.dayKeyFn === "function" ? opts.dayKeyFn : toDayKeyLocal;
  const nowISO = opts.nowISO || new Date().toISOString();
  const today = dayKeyFn(nowISO);

  const totals = {
    xp: 0,
    entries: 0,
    sessionsCompleted: 0,
    sessionsStarted: 0,
    cleaningPlansSaved: 0,
    inventoryUpdates: 0,
    harvestLogs: 0,
    preservationCompleted: 0,
    mealplanUpdates: 0,
    minutes: 0,
    steps: 0,
  };

  const byDomain = Object.create(null);
  const byEventType = Object.create(null);
  const byRuleId = Object.create(null);

  const last7 = {
    xp: 0,
    sessionsCompleted: 0,
    minutes: 0,
  };
  const last30 = {
    xp: 0,
    sessionsCompleted: 0,
    minutes: 0,
  };

  const from7 = addDays(today, -6);
  const from30 = addDays(today, -29);

  for (const e of ledger) {
    if (!e) continue;
    const xp = asInt(e.xp, 0);
    const type = safeString(e.type || "unknown");
    const ruleId = safeString(e.ruleId || "unknown");
    const ts = safeString(e.ts || "");
    const dayKey = safeString(e.dayKey || (ts ? dayKeyFn(ts) : ""));

    totals.entries += 1;
    totals.xp += xp;

    byEventType[type] = (byEventType[type] || 0) + 1;
    byRuleId[ruleId] = (byRuleId[ruleId] || 0) + xp;

    const dom = domainFromType(type);
    if (!byDomain[dom])
      byDomain[dom] = { xp: 0, entries: 0, events: Object.create(null) };
    byDomain[dom].xp += xp;
    byDomain[dom].entries += 1;
    byDomain[dom].events[type] = (byDomain[dom].events[type] || 0) + 1;

    // common counters from event types
    if (type === "session/completed") totals.sessionsCompleted += 1;
    if (type === "session/started") totals.sessionsStarted += 1;
    if (type === "cleaning/tasksSaved") totals.cleaningPlansSaved += 1;
    if (type === "inventory/updated") totals.inventoryUpdates += 1;
    if (type === "garden/harvestLogged") totals.harvestLogs += 1;
    if (type === "preservation/completed") totals.preservationCompleted += 1;
    if (type === "mealplan/updated") totals.mealplanUpdates += 1;

    // duration + steps (best-effort; xpEngine rule uses these fields often)
    const durationSec =
      asInt(e?.meta?.durationSec, 0) ||
      asInt(e?.meta?.session?.durationSec, 0) ||
      asInt(e?.eventEnvelope?.data?.durationSec, 0) ||
      asInt(e?.eventEnvelope?.data?.session?.durationSec, 0);

    const stepsCompleted =
      asInt(e?.meta?.stepsCompleted, 0) ||
      asInt(e?.meta?.session?.stepsCompleted, 0) ||
      asInt(e?.eventEnvelope?.data?.stepsCompleted, 0) ||
      asInt(e?.eventEnvelope?.data?.session?.stepsCompleted, 0);

    if (durationSec > 0) totals.minutes += Math.floor(durationSec / 60);
    if (stepsCompleted > 0) totals.steps += stepsCompleted;

    if (dayKey) {
      if (withinDayRange(dayKey, from7, today)) {
        last7.xp += xp;
        if (type === "session/completed") last7.sessionsCompleted += 1;
        if (durationSec > 0) last7.minutes += Math.floor(durationSec / 60);
      }
      if (withinDayRange(dayKey, from30, today)) {
        last30.xp += xp;
        if (type === "session/completed") last30.sessionsCompleted += 1;
        if (durationSec > 0) last30.minutes += Math.floor(durationSec / 60);
      }
    }
  }

  return {
    totals,
    byDomain,
    byEventType,
    byRuleId,
    last7Days: last7,
    last30Days: last30,
  };
}

/* -------------------------------------------------------------------------- */
/*                               Badge evaluation                              */
/* -------------------------------------------------------------------------- */

export function evaluateBadges(badgeCatalog, ctx) {
  const list = Array.isArray(badgeCatalog) ? badgeCatalog : [];
  const out = [];
  for (const b of list) {
    if (!b?.id || typeof b?.test !== "function") continue;
    let ok = false;
    try {
      ok = !!b.test(ctx);
    } catch {
      ok = false;
    }
    if (ok) out.push(b.id);
  }
  return out;
}

export function diffNewBadges(earnedIds = [], nowEarnedIds = []) {
  const earned = new Set((earnedIds || []).map(String));
  return (nowEarnedIds || []).map(String).filter((id) => !earned.has(id));
}

/* -------------------------------------------------------------------------- */
/*                              SSA Badge Catalog                              */
/* -------------------------------------------------------------------------- */

/**
 * These badges are deliberately "SSA household stewardship" aligned:
 * - planning discipline (meal plan / cleaning plan)
 * - consistency (streak)
 * - completion (sessions)
 * - cross-domain behaviors (inventory + cooking + cleaning + garden)
 *
 * You can add UI later that groups by category/tier.
 */
export const BadgeCatalog = [
  /* ------------------------------- Onboarding ------------------------------ */
  {
    id: "first_xp",
    name: "First XP",
    description: "Earn your first XP.",
    icon: "✨",
    tier: "bronze",
    category: "onboarding",
    test: ({ profile }) => asInt(profile?.totalXp, 0) > 0,
  },
  {
    id: "first_session_complete",
    name: "First Session Complete",
    description: "Complete your first session.",
    icon: "✅",
    tier: "bronze",
    category: "sessions",
    test: ({ stats }) => asInt(stats?.totals?.sessionsCompleted, 0) >= 1,
  },
  {
    id: "first_cleaning_plan",
    name: "Plan Maker",
    description: "Save your first cleaning plan.",
    icon: "🧽",
    tier: "bronze",
    category: "cleaning",
    test: ({ stats }) => asInt(stats?.totals?.cleaningPlansSaved, 0) >= 1,
  },

  /* --------------------------------- Levels -------------------------------- */
  {
    id: "level_5",
    name: "Level 5",
    description: "Reach level 5.",
    icon: "🏅",
    tier: "bronze",
    category: "progression",
    test: ({ profile }) => asInt(profile?.level, 1) >= 5,
  },
  {
    id: "level_10",
    name: "Level 10",
    description: "Reach level 10.",
    icon: "🥈",
    tier: "silver",
    category: "progression",
    test: ({ profile }) => asInt(profile?.level, 1) >= 10,
  },
  {
    id: "level_20",
    name: "Level 20",
    description: "Reach level 20.",
    icon: "🥇",
    tier: "gold",
    category: "progression",
    test: ({ profile }) => asInt(profile?.level, 1) >= 20,
  },

  /* --------------------------------- Streaks ------------------------------- */
  {
    id: "streak_3",
    name: "3-Day Streak",
    description: "Earn XP 3 days in a row.",
    icon: "🔥",
    tier: "bronze",
    category: "consistency",
    test: ({ profile }) => asInt(profile?.streakDays, 0) >= 3,
  },
  {
    id: "streak_7",
    name: "7-Day Streak",
    description: "Earn XP 7 days in a row.",
    icon: "🔥",
    tier: "silver",
    category: "consistency",
    test: ({ profile }) => asInt(profile?.streakDays, 0) >= 7,
  },
  {
    id: "streak_30",
    name: "30-Day Streak",
    description: "Earn XP 30 days in a row.",
    icon: "🔥",
    tier: "gold",
    category: "consistency",
    test: ({ profile }) => asInt(profile?.streakDays, 0) >= 30,
  },

  /* ------------------------------- Sessions -------------------------------- */
  {
    id: "sessions_10",
    name: "Session Runner",
    description: "Complete 10 sessions.",
    icon: "🏃",
    tier: "bronze",
    category: "sessions",
    test: ({ stats }) => asInt(stats?.totals?.sessionsCompleted, 0) >= 10,
  },
  {
    id: "sessions_50",
    name: "Session Machine",
    description: "Complete 50 sessions.",
    icon: "⚙️",
    tier: "silver",
    category: "sessions",
    test: ({ stats }) => asInt(stats?.totals?.sessionsCompleted, 0) >= 50,
  },
  {
    id: "sessions_200",
    name: "Household Pro",
    description: "Complete 200 sessions.",
    icon: "🏠",
    tier: "gold",
    category: "sessions",
    test: ({ stats }) => asInt(stats?.totals?.sessionsCompleted, 0) >= 200,
  },

  /* ------------------------------- Time + Steps ---------------------------- */
  {
    id: "minutes_300",
    name: "5 Hours Logged",
    description: "Accumulate 300 minutes of session work.",
    icon: "⏱️",
    tier: "bronze",
    category: "effort",
    test: ({ stats }) => asInt(stats?.totals?.minutes, 0) >= 300,
  },
  {
    id: "minutes_2000",
    name: "33 Hours Logged",
    description: "Accumulate 2,000 minutes of session work.",
    icon: "⌛",
    tier: "silver",
    category: "effort",
    test: ({ stats }) => asInt(stats?.totals?.minutes, 0) >= 2000,
  },
  {
    id: "steps_500",
    name: "Checklist Crusher",
    description: "Complete 500 checklist steps.",
    icon: "🧾",
    tier: "bronze",
    category: "effort",
    test: ({ stats }) => asInt(stats?.totals?.steps, 0) >= 500,
  },
  {
    id: "steps_5000",
    name: "Checklist Legend",
    description: "Complete 5,000 checklist steps.",
    icon: "📋",
    tier: "gold",
    category: "effort",
    test: ({ stats }) => asInt(stats?.totals?.steps, 0) >= 5000,
  },

  /* ------------------------------- Cleaning -------------------------------- */
  {
    id: "cleaning_plans_10",
    name: "Cleaning Architect",
    description: "Save 10 cleaning plans.",
    icon: "🧼",
    tier: "silver",
    category: "cleaning",
    test: ({ stats }) => asInt(stats?.totals?.cleaningPlansSaved, 0) >= 10,
  },

  /* ------------------------------- Inventory ------------------------------- */
  {
    id: "inventory_updates_25",
    name: "Stock Steward",
    description: "Make 25 inventory updates.",
    icon: "📦",
    tier: "bronze",
    category: "inventory",
    test: ({ stats }) => asInt(stats?.totals?.inventoryUpdates, 0) >= 25,
  },
  {
    id: "inventory_updates_200",
    name: "Storehouse Keeper",
    description: "Make 200 inventory updates.",
    icon: "🏺",
    tier: "silver",
    category: "inventory",
    test: ({ stats }) => asInt(stats?.totals?.inventoryUpdates, 0) >= 200,
  },

  /* ------------------------------- Garden ---------------------------------- */
  {
    id: "harvest_logs_5",
    name: "Harvester",
    description: "Log 5 harvests.",
    icon: "🌿",
    tier: "bronze",
    category: "garden",
    test: ({ stats }) => asInt(stats?.totals?.harvestLogs, 0) >= 5,
  },
  {
    id: "harvest_logs_50",
    name: "Garden Steward",
    description: "Log 50 harvests.",
    icon: "🌱",
    tier: "silver",
    category: "garden",
    test: ({ stats }) => asInt(stats?.totals?.harvestLogs, 0) >= 50,
  },

  /* ------------------------------ Preservation ----------------------------- */
  {
    id: "preservation_5",
    name: "Preserver",
    description: "Complete 5 preservation batches.",
    icon: "🫙",
    tier: "bronze",
    category: "preservation",
    test: ({ stats }) => asInt(stats?.totals?.preservationCompleted, 0) >= 5,
  },
  {
    id: "preservation_25",
    name: "Larder Builder",
    description: "Complete 25 preservation batches.",
    icon: "🏺",
    tier: "silver",
    category: "preservation",
    test: ({ stats }) => asInt(stats?.totals?.preservationCompleted, 0) >= 25,
  },

  /* -------------------------------- Meal Plan ------------------------------ */
  {
    id: "mealplan_updates_10",
    name: "Meal Strategist",
    description: "Update your meal plan 10 times.",
    icon: "🍲",
    tier: "bronze",
    category: "mealplanning",
    test: ({ stats }) => asInt(stats?.totals?.mealplanUpdates, 0) >= 10,
  },

  /* ----------------------------- Cross-domain --------------------------------
   * These align with your "web of meaning" approach: consistent stewardship,
   * not just isolated tasks.
   */
  {
    id: "steward_cross_1",
    name: "Household Steward",
    description: "Earn XP in 3 different domains.",
    icon: "🧭",
    tier: "silver",
    category: "stewardship",
    test: ({ stats }) => {
      const byDomain = stats?.byDomain || {};
      const domains = Object.keys(byDomain).filter(
        (k) => asInt(byDomain[k]?.xp, 0) > 0
      );
      // ignore noisy/unknown if present
      const cleaned = domains.filter((d) => d && d !== "unknown");
      return cleaned.length >= 3;
    },
  },
  {
    id: "steward_cross_2",
    name: "Web of Meaning",
    description: "Earn XP in 5 different domains.",
    icon: "🕸️",
    tier: "gold",
    category: "stewardship",
    test: ({ stats }) => {
      const byDomain = stats?.byDomain || {};
      const domains = Object.keys(byDomain).filter(
        (k) => asInt(byDomain[k]?.xp, 0) > 0
      );
      const cleaned = domains.filter((d) => d && d !== "unknown");
      return cleaned.length >= 5;
    },
  },

  /* ------------------------------ Intensity badges -------------------------- */
  {
    id: "week_1000_xp",
    name: "Big Week",
    description: "Earn 1,000 XP in the last 7 days.",
    icon: "🚀",
    tier: "silver",
    category: "momentum",
    test: ({ stats }) => asInt(stats?.last7Days?.xp, 0) >= 1000,
  },
  {
    id: "month_5000_xp",
    name: "Big Month",
    description: "Earn 5,000 XP in the last 30 days.",
    icon: "🏔️",
    tier: "gold",
    category: "momentum",
    test: ({ stats }) => asInt(stats?.last30Days?.xp, 0) >= 5000,
  },
];

/* -------------------------------------------------------------------------- */
/*                         helpers to build badge ctx                          */
/* -------------------------------------------------------------------------- */

/**
 * Build badge evaluation context from a profile + ledger.
 * @param {object} profile
 * @param {Array} ledger
 * @param {{ nowISO?:string, dayKeyFn?:(ts)=>string }} [opts]
 */
export function buildBadgeContext(profile, ledger, opts = {}) {
  const p = isPlainObject(profile) ? profile : {};
  const l = Array.isArray(ledger) ? ledger : [];
  const stats = computeBadgeStats(l, opts);
  return { profile: p, ledger: l, stats };
}

/**
 * Evaluate the full catalog and return:
 * - earnedNow: array of badge ids that pass
 * - newBadges: badge objects not in alreadyEarned
 *
 * @param {object} profile
 * @param {Array} ledger
 * @param {Array<{id:string}>|Array<string>} alreadyEarned
 * @param {{ catalog?:Array, nowISO?:string, dayKeyFn?:(ts)=>string }} [opts]
 */
export function evaluateCatalog(profile, ledger, alreadyEarned, opts = {}) {
  const catalog = Array.isArray(opts.catalog) ? opts.catalog : BadgeCatalog;
  const ctx = buildBadgeContext(profile, ledger, opts);

  const earnedNow = evaluateBadges(catalog, ctx);

  const earnedIds = (alreadyEarned || [])
    .map((x) => (typeof x === "string" ? x : x?.id))
    .filter(Boolean);
  const newly = diffNewBadges(earnedIds, earnedNow);

  const newBadges = newly
    .map((id) => catalog.find((b) => b.id === id))
    .filter(Boolean);

  return { earnedNow, newBadges, ctx };
}

/* -------------------------------------------------------------------------- */
/*                              exports + default                              */
/* -------------------------------------------------------------------------- */

export default {
  BadgeCatalog,
  computeBadgeStats,
  buildBadgeContext,
  evaluateBadges,
  diffNewBadges,
  evaluateCatalog,
};
