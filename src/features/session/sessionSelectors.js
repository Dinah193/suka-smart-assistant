// C:\Users\larho\suka-smart-assistant\src\features\session\sessionSelectors.js

/**
 * Session selectors and helpers for SSA
 *
 * This module is intentionally UI-agnostic and side-effect-free:
 *  - it does NOT touch Dexie directly
 *  - it does NOT emit events
 *  - it does NOT call shims or orchestrators
 *
 * Instead, it:
 *  - normalizes & enriches sessions for display
 *  - merges in user favorites and schedules
 *  - surfaces reverse-planned sessions and other orchestration hints
 *  - groups sessions for dashboards (today, upcoming, past due, by domain)
 */

/**
 * Domain metadata for display and grouping.
 * Keep in sync with useSessionRunner DOMAIN_PRESETS as much as possible.
 */
export const DOMAIN_META = {
  cooking: {
    key: "cooking",
    label: "Meals & Cooking",
    icon: "🍳",
    sortOrder: 10,
  },
  cleaning: {
    key: "cleaning",
    label: "Cleaning & Reset",
    icon: "🧽",
    sortOrder: 20,
  },
  garden_planning: {
    key: "garden_planning",
    label: "Garden Planning",
    icon: "🪴",
    sortOrder: 30,
  },
  garden_care: {
    key: "garden_care",
    label: "Garden Care",
    icon: "🌱",
    sortOrder: 31,
  },
  garden_harvest: {
    key: "garden_harvest",
    label: "Harvest & Log",
    icon: "🧺",
    sortOrder: 32,
  },
  storehouse: {
    key: "storehouse",
    label: "Storehouse & Groceries",
    icon: "🏚️",
    sortOrder: 40,
    grocerySections: [
      "Produce",
      "Meat & Seafood",
      "Dairy & Eggs",
      "Pantry / Dry Goods",
      "Frozen",
      "Canned & Jarred",
      "Oils, Spices & Seasonings",
      "Baking",
      "Snacks",
      "Beverages",
      "Household & Cleaning",
    ],
  },
  animals_acquisition: {
    key: "animals_acquisition",
    label: "Animal Acquisition",
    icon: "🐑",
    sortOrder: 50,
  },
  animals_care: {
    key: "animals_care",
    label: "Animal Care",
    icon: "🐄",
    sortOrder: 51,
  },
  animals_butchery: {
    key: "animals_butchery",
    label: "Butchery & Processing",
    icon: "🔪",
    sortOrder: 52,
  },
  preservation: {
    key: "preservation",
    label: "Preservation",
    icon: "🥫",
    sortOrder: 60,
  },
  generic: {
    key: "generic",
    label: "Household Session",
    icon: "✅",
    sortOrder: 99,
  },
};

/**
 * Lightweight date helpers
 */
function toDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Compute simple schedule flags for a session.
 */
function computeScheduleFlags(session, now = new Date()) {
  const schedule = session.schedule || {};
  const startsAtDate = toDateOrNull(schedule.startsAt);
  const endsAtDate = toDateOrNull(schedule.endsAt);

  const mode = schedule.mode || "now";

  const hasStarted =
    !!startsAtDate && startsAtDate.getTime() <= now.getTime();
  const isToday =
    !!startsAtDate && isSameDay(startsAtDate, now);
  const isPastDue =
    !!endsAtDate && endsAtDate.getTime() < now.getTime();
  const isUpcoming =
    !!startsAtDate && startsAtDate.getTime() > now.getTime();

  return {
    mode,
    startsAtDate,
    endsAtDate,
    hasStarted,
    isToday,
    isPastDue,
    isUpcoming,
    isReverse: mode === "reverse",
    isScheduled: mode === "scheduled" || mode === "reverse",
    isAdHoc: mode === "now",
  };
}

/**
 * Compute display tags (badges/chips) for the UI, inspired by tools like Notion/Asana.
 */
function computeDisplayTags(session, flags) {
  const tags = [];

  const domainKey = session.domain || "generic";
  const domainMeta = DOMAIN_META[domainKey] || DOMAIN_META.generic;

  // Domain label
  tags.push(domainMeta.label);

  if (flags.isReverse) tags.push("Reverse Planned");
  if (session.isFavorite) tags.push("Favorite");
  if (flags.isToday) tags.push("Today");
  if (flags.isPastDue) tags.push("Past Due");
  if (flags.isUpcoming && !flags.isToday) tags.push("Upcoming");
  if (session.isTemplate) tags.push("Template");
  if (session.source === "system") tags.push("System");
  if (session.source === "automation") tags.push("Automation");

  return tags;
}

/**
 * Normalize a single session into a list-friendly shape.
 *
 * @param {object} session - raw session from Dexie
 * @param {object} options
 *  - favoriteIndex: Map<string, FavoriteRecord>
 *  - scheduleIndex: Map<string, Array<ScheduleRecord>>
 *  - now: Date
 */
export function normalizeSessionForList(
  session,
  { favoriteIndex, scheduleIndex, now = new Date() } = {}
) {
  if (!session) return null;

  const domainKey = session.domain || "generic";
  const domainMeta = DOMAIN_META[domainKey] || DOMAIN_META.generic;

  const flags = computeScheduleFlags(session, now);

  const favoriteRecord =
    favoriteIndex && session.id ? favoriteIndex.get(session.id) : null;
  const scheduleRecords =
    scheduleIndex && session.id ? scheduleIndex.get(session.id) || [] : [];

  const isFavorite = !!favoriteRecord;
  const nextSchedule = scheduleRecords[0] || null; // naive "first" schedule; UI can show more

  const tags = computeDisplayTags(
    {
      ...session,
      isFavorite,
    },
    flags
  );

  return {
    ...session,
    domainMeta,
    scheduleFlags: flags,
    isFavorite,
    favoriteRecord,
    schedules: scheduleRecords,
    nextSchedule,
    display: {
      icon: session.icon || domainMeta.icon,
      title: session.title || domainMeta.label,
      subtitle: buildSessionSubtitle(session, flags),
      tags,
    },
  };
}

/**
 * Build a concise subtitle for the UI (e.g. "Today • 4 steps • Reverse").
 * Inspired by calendar/task apps like Google Calendar / Todoist.
 */
function buildSessionSubtitle(session, flags) {
  const parts = [];

  const { steps = [] } = session;
  if (steps.length) {
    parts.push(`${steps.length} step${steps.length === 1 ? "" : "s"}`);
  }

  if (flags.isToday) {
    parts.unshift("Today");
  } else if (flags.isUpcoming) {
    parts.unshift("Upcoming");
  } else if (flags.isPastDue) {
    parts.unshift("Past due");
  }

  if (flags.isReverse) {
    parts.push("Reverse planned");
  }

  return parts.join(" • ") || "";
}

/**
 * Build lookup indexes from favorites & schedules for faster selectors.
 *
 * @param {Array} favorites - records from db.sessionFavorites
 * @param {Array} schedules - records from db.sessionSchedules
 */
export function buildSessionIndexes(favorites = [], schedules = []) {
  const favoriteIndex = new Map();
  for (const fav of favorites || []) {
    if (!fav || !fav.sessionId) continue;
    // Only one favorite per sessionId is assumed; if multiple exist, last one wins.
    favoriteIndex.set(fav.sessionId, fav);
  }

  const scheduleIndex = new Map();
  for (const sched of schedules || []) {
    if (!sched || !sched.sessionTemplateId) continue;
    const arr =
      scheduleIndex.get(sched.sessionTemplateId) || [];
    arr.push(sched);
    scheduleIndex.set(sched.sessionTemplateId, arr);
  }

  return { favoriteIndex, scheduleIndex };
}

/**
 * Normalize an array of sessions for dashboards or list views.
 *
 * @param {Array} sessions - session records from db.sessions
 * @param {Array} favorites - from db.sessionFavorites
 * @param {Array} schedules - from db.sessionSchedules
 * @param {Date} now
 */
export function normalizeSessionsForList(
  sessions = [],
  favorites = [],
  schedules = [],
  now = new Date()
) {
  const { favoriteIndex, scheduleIndex } = buildSessionIndexes(
    favorites,
    schedules
  );

  return (sessions || [])
    .map((s) =>
      normalizeSessionForList(s, {
        favoriteIndex,
        scheduleIndex,
        now,
      })
    )
    .filter(Boolean);
}

/**
 * Select sessions grouped for a dashboard:
 *  - today
 *  - upcoming
 *  - pastDue
 *  - favorites
 *  - byDomain
 *
 * This is the "brain" for a Notion/Asana-style Sessions dashboard.
 */
export function selectDashboardSessions({
  sessions = [],
  favorites = [],
  schedules = [],
  now = new Date(),
}) {
  const normalized = normalizeSessionsForList(
    sessions,
    favorites,
    schedules,
    now
  );

  const today = [];
  const upcoming = [];
  const pastDue = [];
  const reversePlanned = [];
  const favoritesList = [];
  const byDomain = {};

  for (const session of normalized) {
    const { scheduleFlags, domainMeta, isFavorite } = session;
    const { key: domainKey } = domainMeta;

    if (!byDomain[domainKey]) {
      byDomain[domainKey] = [];
    }
    byDomain[domainKey].push(session);

    if (scheduleFlags.isToday) {
      today.push(session);
    } else if (scheduleFlags.isUpcoming) {
      upcoming.push(session);
    } else if (scheduleFlags.isPastDue) {
      pastDue.push(session);
    }

    if (scheduleFlags.isReverse) {
      reversePlanned.push(session);
    }

    if (isFavorite) {
      favoritesList.push(session);
    }
  }

  // Sort sections by simple heuristics:
  const sortByStart = (a, b) => {
    const aStart = a.scheduleFlags.startsAtDate
      ? a.scheduleFlags.startsAtDate.getTime()
      : 0;
    const bStart = b.scheduleFlags.startsAtDate
      ? b.scheduleFlags.startsAtDate.getTime()
      : 0;
    return aStart - bStart;
  };

  today.sort(sortByStart);
  upcoming.sort(sortByStart);
  pastDue.sort(sortByStart);

  // Sort by domain order for stable dashboards
  const sortedDomainKeys = Object.keys(byDomain).sort((a, b) => {
    const aMeta = DOMAIN_META[a] || DOMAIN_META.generic;
    const bMeta = DOMAIN_META[b] || DOMAIN_META.generic;
    return aMeta.sortOrder - bMeta.sortOrder;
  });

  const byDomainSorted = {};
  for (const key of sortedDomainKeys) {
    byDomainSorted[key] = byDomain[key].slice().sort(sortByStart);
  }

  return {
    today,
    upcoming,
    pastDue,
    favorites: favoritesList,
    reversePlanned,
    byDomain: byDomainSorted,
    all: normalized,
  };
}

/**
 * Select sessions belonging to a specific domain (e.g. "cleaning", "garden_care").
 */
export function selectSessionsByDomain(domainKey, sessions = [], options = {}) {
  const { favorites = [], schedules = [], now = new Date() } = options;
  const normalized = normalizeSessionsForList(
    sessions,
    favorites,
    schedules,
    now
  );

  return normalized.filter(
    (s) => (s.domain || "generic") === domainKey
  );
}

/**
 * Select upcoming sessions for a specific domain.
 */
export function selectUpcomingSessionsForDomain(
  domainKey,
  sessions = [],
  options = {}
) {
  const list = selectSessionsByDomain(domainKey, sessions, options);
  return list.filter((s) => s.scheduleFlags.isUpcoming);
}

/**
 * Select reverse-planned sessions (schedule.mode === "reverse").
 * These are important for your reverse generation workflows and shims.
 */
export function selectReversePlannedSessions(
  sessions = [],
  options = {}
) {
  const { favorites = [], schedules = [], now = new Date() } = options;
  const normalized = normalizeSessionsForList(
    sessions,
    favorites,
    schedules,
    now
  );

  return normalized.filter((s) => s.scheduleFlags.isReverse);
}

/**
 * Select user favorites as enriched sessions (not just raw favorite records).
 */
export function selectFavoriteSessions(
  sessions = [],
  favorites = [],
  schedules = [],
  now = new Date()
) {
  const normalized = normalizeSessionsForList(
    sessions,
    favorites,
    schedules,
    now
  );
  return normalized.filter((s) => s.isFavorite);
}

/**
 * Select schedules relevant to a given domain (e.g., recurring cleaning, garden care).
 *
 * This is handy when you want a "Schedule" tab next to the "Sessions" tab
 * on each domain page.
 */
export function selectSchedulesByDomain(domainKey, schedules = []) {
  return (schedules || []).filter(
    (sched) => (sched.domain || "generic") === domainKey
  );
}

/**
 * Select storehouse-oriented sessions and attach grocery inspiration info.
 *
 * This will help you build UI similar to good grocery/meal apps:
 *  - group by grocerySection
 *  - show storehouse zones and planning inspirations
 */
export function selectStorehouseSessionsWithGroceryHints(
  sessions = [],
  favorites = [],
  schedules = [],
  now = new Date()
) {
  const normalized = normalizeSessionsForList(
    sessions,
    favorites,
    schedules,
    now
  );

  const storehouseSessions = normalized.filter(
    (s) => (s.domain || "generic") === "storehouse"
  );

  const grocerySections =
    DOMAIN_META.storehouse?.grocerySections || [];

  // Build grouping by grocery section (loose match in meta.grocerySections or storehouseZones)
  const bySection = {};
  for (const section of grocerySections) {
    bySection[section] = [];
  }
  bySection.Other = [];

  for (const session of storehouseSessions) {
    const meta = session.meta || {};
    const sessionSections = meta.grocerySections || meta.storehouseZones || [];

    // Find the first known section that matches
    const match =
      sessionSections.find((sec) =>
        grocerySections.includes(sec)
      ) || null;

    if (match) {
      bySection[match].push(session);
    } else {
      bySection.Other.push(session);
    }
  }

  return {
    sessions: storehouseSessions,
    bySection,
    grocerySections,
  };
}

/**
 * Helper: identify "chainable" sessions based on domain conventions.
 * (This is orchestration-aware but still purely derived: no side-effects.)
 *
 * Example patterns:
 *  - garden_harvest -> preservation, meals
 *  - animals_butchery -> preservation, cooking, storehouse
 *  - cooking -> cleaning
 */
export function selectChainableSessions(
  sessions = [],
  favorites = [],
  schedules = [],
  now = new Date()
) {
  const normalized = normalizeSessionsForList(
    sessions,
    favorites,
    schedules,
    now
  );

  const chainMap = {
    garden_harvest: ["preservation", "cooking", "storehouse"],
    animals_butchery: ["preservation", "cooking", "storehouse"],
    cooking: ["cleaning"],
    storehouse: ["cooking", "garden_planning"],
  };

  return normalized.map((session) => {
    const domain = session.domain || "generic";
    const chainTargets = chainMap[domain] || [];
    return {
      ...session,
      orchestrationHints: {
        chainTargets,
        canChain: chainTargets.length > 0,
      },
    };
  });
}
