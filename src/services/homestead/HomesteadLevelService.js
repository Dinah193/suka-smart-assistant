/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\homestead\HomesteadLevelService.js
//
// HomesteadLevelService
// ---------------------
// Single source of truth for:
// - homestead level normalization + labels (from level catalog when present)
// - unlock rules (features/domains) derived from catalog gates + rules
// - UI visibility rules (what to show at each level)
// - lightweight helpers for planners/estimators/FTT services
//
// IMPORTANT:
// - This service now reads the Homestead Levels catalog (best-effort) and applies unlock rules.
// - If the catalog file is missing, it falls back to internal defaults (safe).
//
// Expected profile shape (from homesteadProfile.repo.js)
// {
//   id: string,
//   householdId: string,
//   level: "0_off"|"1_pantry"|"2_scratch"|"3_homestead"|"4_village" | number | label,
//   enabledDomains: string[],
//   goals: string[],
//   createdAt, updatedAt
// }

import db from "@/services/db";

// Best-effort repo import (optional). Service works without it.
let HomesteadProfileRepo = null;
try {
  HomesteadProfileRepo = (
    await import("@/services/repos/homestead/homesteadProfile.repo.js")
  ).default;
} catch {
  HomesteadProfileRepo = null;
}

/* -------------------------------------------------------------------------- */
/* Catalog Loading (Homestead Level Catalog)                                   */
/* -------------------------------------------------------------------------- */
/**
 * We try multiple common paths so you can place your catalog wherever you want.
 * Recommended (you can pick one):
 * - src/catalogs/homestead/levels.catalog.json
 * - src/catalogs/homestead/homestead.levels.catalog.json
 * - src/catalogs/homestead/levels.json
 *
 * Catalog shape (supported):
 * {
 *   schemaVersion?: string,
 *   meta?: {...},
 *   defaultLevel?: "1_pantry",
 *   levels: [
 *     { key:"1_pantry", rank:1, label:"Pantry Builder", shortLabel:"Pantry", description:"...", uiTone:"info" }
 *   ],
 *   domainDefaults?: { "1_pantry":[...], ... },
 *   featureGates?: { estimator:{minRank:1}, plans:{minRank:3} },
 *   unlockRules?: [
 *     { id:"plans.require_ftt", type:"feature", key:"plans", requiresDomains:["farm_to_table"], minRank:3 }
 *   ],
 *   aliases?: { "pantry builder":"1_pantry", "pantry":"1_pantry", "2":"2_scratch" }
 * }
 */
const CATALOG_IMPORT_CANDIDATES = Object.freeze([
  "@/catalogs/homestead/levels.catalog.json",
  "@/catalogs/homestead/homestead.levels.catalog.json",
  "@/catalogs/homestead/levels.json",
  "@/catalogs/homestead/levels.catalog.js",
  "@/catalogs/homestead/homestead.levels.catalog.js",
]);

let _levelsCatalog = null; // resolved catalog or null
let _catalogLoadAttempted = false;

async function loadLevelsCatalogOnce() {
  if (_catalogLoadAttempted) return _levelsCatalog;
  _catalogLoadAttempted = true;

  for (const path of CATALOG_IMPORT_CANDIDATES) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      const cat = mod?.default ?? mod;
      if (
        cat &&
        typeof cat === "object" &&
        Array.isArray(cat.levels) &&
        cat.levels.length
      ) {
        _levelsCatalog = cat;
        if (import.meta?.env?.DEV)
          console.info("[HomesteadLevelService] Loaded levels catalog:", path);
        return _levelsCatalog;
      }
    } catch {
      // keep trying
    }
  }

  if (import.meta?.env?.DEV) {
    console.warn(
      "[HomesteadLevelService] Levels catalog not found. Using internal defaults. Tried:",
      CATALOG_IMPORT_CANDIDATES,
    );
  }
  _levelsCatalog = null;
  return _levelsCatalog;
}

// kick off best-effort async load (non-blocking)
void loadLevelsCatalogOnce();

function getLevelsCatalogSync() {
  return _levelsCatalog;
}

/* -------------------------------------------------------------------------- */
/* Internal Defaults (fallback)                                                */
/* -------------------------------------------------------------------------- */

const INTERNAL_LEVELS = {
  "0_off": {
    rank: 0,
    key: "0_off",
    label: "Off",
    shortLabel: "Off",
    description: "Homestead planning disabled.",
    uiTone: "neutral",
  },
  "1_pantry": {
    rank: 1,
    key: "1_pantry",
    label: "Pantry Builder",
    shortLabel: "Pantry",
    description: "Stock core staples and reduce grocery swings.",
    uiTone: "info",
  },
  "2_scratch": {
    rank: 2,
    key: "2_scratch",
    label: "Scratch Cooking",
    shortLabel: "Scratch",
    description: "Cook more from components; batch basics weekly.",
    uiTone: "info",
  },
  "3_homestead": {
    rank: 3,
    key: "3_homestead",
    label: "Homestead",
    shortLabel: "Homestead",
    description: "Garden/animals/preservation planning and longer horizons.",
    uiTone: "warning",
  },
  "4_village": {
    rank: 4,
    key: "4_village",
    label: "Sacred Village",
    shortLabel: "Village",
    description: "Community-scale production, surplus, and distribution.",
    uiTone: "warning",
  },
};

const INTERNAL_DEFAULT_LEVEL = "1_pantry";

const DOMAINS = {
  meals: "meals",
  storehouse: "storehouse",
  shopping: "shopping",
  estimators: "estimators",
  farmToTable: "farm_to_table",
  cooking: "cooking",
  cleaning: "cleaning",
  garden: "garden",
  animals: "animals",
  preservation: "preservation",
  finance: "finance",
};

const DOMAIN_LABELS = {
  [DOMAINS.meals]: "Meals",
  [DOMAINS.storehouse]: "Storehouse",
  [DOMAINS.shopping]: "Shopping",
  [DOMAINS.estimators]: "Estimators",
  [DOMAINS.farmToTable]: "Farm-to-Table",
  [DOMAINS.cooking]: "Cooking",
  [DOMAINS.cleaning]: "Cleaning",
  [DOMAINS.garden]: "Garden",
  [DOMAINS.animals]: "Animals",
  [DOMAINS.preservation]: "Preservation",
  [DOMAINS.finance]: "Finance",
};

const INTERNAL_DOMAIN_DEFAULTS = {
  "0_off": [],
  "1_pantry": [
    DOMAINS.meals,
    DOMAINS.storehouse,
    DOMAINS.shopping,
    DOMAINS.estimators,
    DOMAINS.farmToTable,
    DOMAINS.cooking,
  ],
  "2_scratch": [
    DOMAINS.meals,
    DOMAINS.storehouse,
    DOMAINS.shopping,
    DOMAINS.estimators,
    DOMAINS.farmToTable,
    DOMAINS.cooking,
    DOMAINS.preservation,
  ],
  "3_homestead": [
    DOMAINS.meals,
    DOMAINS.storehouse,
    DOMAINS.shopping,
    DOMAINS.estimators,
    DOMAINS.farmToTable,
    DOMAINS.cooking,
    DOMAINS.preservation,
    DOMAINS.garden,
    DOMAINS.animals,
  ],
  "4_village": [
    DOMAINS.meals,
    DOMAINS.storehouse,
    DOMAINS.shopping,
    DOMAINS.estimators,
    DOMAINS.farmToTable,
    DOMAINS.cooking,
    DOMAINS.preservation,
    DOMAINS.garden,
    DOMAINS.animals,
    DOMAINS.finance,
  ],
};

const INTERNAL_FEATURE_GATES = {
  baselines: { minRank: 1 },
  estimator: { minRank: 1 },
  targets: { minRank: 1 },
  components: { minRank: 2 },
  batches: { minRank: 2 },
  gaps: { minRank: 2 },
  sourcing: { minRank: 2 },
  plans: { minRank: 3 },
  plan_items: { minRank: 3 },
  garden_actions: { minRank: 3 },
  animal_actions: { minRank: 3 },
  preservation_actions: { minRank: 3 },
  advanced_debug: { minRank: 4 },
};

/* -------------------------------------------------------------------------- */
/* Catalog resolution helpers                                                  */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x, fallback = "") {
  if (x == null) return fallback;
  return String(x);
}

function isPlainObject(x) {
  return Boolean(x && typeof x === "object" && !Array.isArray(x));
}

function unique(arr) {
  return Array.from(new Set((arr || []).map(String).filter(Boolean)));
}

function hasTable(name) {
  try {
    void db.table(name);
    return true;
  } catch {
    return false;
  }
}

function resolveEffectiveCatalog() {
  const cat = getLevelsCatalogSync();

  // Build an effective catalog even when missing
  const effective = {
    defaultLevel:
      cat?.defaultLevel || cat?.defaults?.level || INTERNAL_DEFAULT_LEVEL,
    aliases: isPlainObject(cat?.aliases) ? cat.aliases : {},
    levels:
      Array.isArray(cat?.levels) && cat.levels.length
        ? cat.levels
        : Object.values(INTERNAL_LEVELS),
    domainDefaults: isPlainObject(cat?.domainDefaults)
      ? cat.domainDefaults
      : INTERNAL_DOMAIN_DEFAULTS,
    featureGates: isPlainObject(cat?.featureGates)
      ? cat.featureGates
      : INTERNAL_FEATURE_GATES,
    unlockRules: Array.isArray(cat?.unlockRules) ? cat.unlockRules : [],
  };

  // Normalize levels map for fast lookup
  const levelsByKey = {};
  for (const L of effective.levels) {
    const key = safeStr(L?.key).trim();
    if (!key) continue;
    const rank = Number(L?.rank);
    levelsByKey[key] = {
      ...L,
      key,
      rank: Number.isFinite(rank) ? rank : (INTERNAL_LEVELS[key]?.rank ?? 0),
      label: safeStr(L?.label, INTERNAL_LEVELS[key]?.label || key),
      shortLabel: safeStr(
        L?.shortLabel,
        INTERNAL_LEVELS[key]?.shortLabel || safeStr(L?.label, key),
      ),
      description: safeStr(
        L?.description,
        INTERNAL_LEVELS[key]?.description || "",
      ),
      uiTone: safeStr(L?.uiTone, INTERNAL_LEVELS[key]?.uiTone || "neutral"),
    };
  }

  effective.levelsByKey = levelsByKey;

  // Ensure default exists
  if (!effective.levelsByKey[effective.defaultLevel]) {
    effective.defaultLevel = INTERNAL_DEFAULT_LEVEL;
  }

  // Convenience: list of keys
  effective.levelKeys = Object.keys(effective.levelsByKey);

  return effective;
}

function normalizeLevel(level) {
  const C = resolveEffectiveCatalog();

  const raw = safeStr(level, C.defaultLevel).trim();
  if (C.levelsByKey[raw]) return raw;

  // catalog aliases
  const aliasKey = safeStr(C.aliases?.[raw], "").trim();
  if (aliasKey && C.levelsByKey[aliasKey]) return aliasKey;

  // numeric mapping
  const n = Number(raw);
  if (Number.isFinite(n)) {
    // try direct alias first ("2" etc.)
    const numAlias = safeStr(C.aliases?.[String(n)], "").trim();
    if (numAlias && C.levelsByKey[numAlias]) return numAlias;

    // fallback to internal numeric convention
    if (n <= 0 && C.levelsByKey["0_off"]) return "0_off";
    if (n === 1 && C.levelsByKey["1_pantry"]) return "1_pantry";
    if (n === 2 && C.levelsByKey["2_scratch"]) return "2_scratch";
    if (n === 3 && C.levelsByKey["3_homestead"]) return "3_homestead";
    if (n >= 4 && C.levelsByKey["4_village"]) return "4_village";
  }

  // fuzzy label match
  const ll = raw.toLowerCase();
  for (const key of C.levelKeys) {
    const L = C.levelsByKey[key];
    const hay = `${key} ${safeStr(L.label).toLowerCase()} ${safeStr(L.shortLabel).toLowerCase()}`;
    if (hay.includes(ll)) return key;
  }

  return C.defaultLevel;
}

function rankOf(level) {
  const C = resolveEffectiveCatalog();
  const key = normalizeLevel(level);
  return C.levelsByKey[key]?.rank ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Domains normalization                                                       */
/* -------------------------------------------------------------------------- */

const DOMAIN_KEYS = Object.freeze(Object.values(DOMAINS));

function normalizeDomain(domain) {
  const d = safeStr(domain, "").trim().toLowerCase();
  if (!d) return null;

  // Accept aliases
  const alias = {
    ftt: DOMAINS.farmToTable,
    farmtotable: DOMAINS.farmToTable,
    "farm-to-table": DOMAINS.farmToTable,
    estimator: DOMAINS.estimators,
    estimates: DOMAINS.estimators,
    store: DOMAINS.storehouse,
    pantry: DOMAINS.storehouse,
  };

  const mapped = alias[d] || d;
  // allow unknowns, but keep normalized mapped string
  return mapped;
}

/* -------------------------------------------------------------------------- */
/* Unlock rules engine                                                         */
/* -------------------------------------------------------------------------- */
/**
 * Applies:
 * 1) feature gates (minRank)
 * 2) domain defaults (per level)
 * 3) optional unlockRules array from catalog
 *
 * unlockRules format (supported):
 * { id, type:"feature"|"domain", key, minRank?, minLevelKey?, requiresDomains?, requiresGoals?, deny?:boolean, reason? }
 *
 * Notes:
 * - Rules are applied after gates/defaults.
 * - deny:true forces locked even if gates allow.
 * - If requiresDomains are present, profile must have those enabled.
 */
function applyUnlockRules({
  profile,
  levelKey,
  enabledDomains,
  featureGates,
  unlockRules,
}) {
  const levelRank = rankOf(levelKey);

  // Start: compute unlocked features from gates
  const features = {};
  for (const [featureKey, gate] of Object.entries(featureGates || {})) {
    const minRank = Number(gate?.minRank ?? 0);
    features[featureKey] = levelRank >= minRank;
  }

  // Start: domains already resolved by profile/level defaults
  const domains = {};
  for (const d of DOMAIN_KEYS) {
    domains[d] = enabledDomains.includes(d);
  }

  const lockedReasons = {
    features: {},
    domains: {},
  };

  // Apply rules
  const rules = Array.isArray(unlockRules) ? unlockRules : [];
  for (const rule of rules) {
    const type = safeStr(rule?.type).trim().toLowerCase();
    const key = safeStr(rule?.key).trim();
    if (!type || !key) continue;

    // min constraints
    const minRank = rule?.minRank != null ? Number(rule.minRank) : null;
    const minLevelKey = rule?.minLevelKey
      ? normalizeLevel(rule.minLevelKey)
      : null;
    const minLevelRank = minLevelKey ? rankOf(minLevelKey) : null;

    const meetsMinRank = minRank == null ? true : levelRank >= minRank;
    const meetsMinLevel =
      minLevelRank == null ? true : levelRank >= minLevelRank;

    const requiresDomains = unique(rule?.requiresDomains || [])
      .map(normalizeDomain)
      .filter(Boolean);
    const requiresGoals = unique(rule?.requiresGoals || [])
      .map(String)
      .filter(Boolean);

    const goals = unique(profile?.goals || []);
    const hasRequiredGoals = requiresGoals.length
      ? requiresGoals.every((g) => goals.includes(g))
      : true;
    const hasRequiredDomains = requiresDomains.length
      ? requiresDomains.every((d) => enabledDomains.includes(d))
      : true;

    const allow =
      meetsMinRank && meetsMinLevel && hasRequiredGoals && hasRequiredDomains;
    const deny = Boolean(rule?.deny === true);

    const reason =
      safeStr(rule?.reason, "") ||
      (deny ? "Locked by rule" : !allow ? "Requirements not met" : "");

    if (type === "feature") {
      if (deny) {
        features[key] = false;
        lockedReasons.features[key] = reason;
      } else if (!allow) {
        // Only force-lock if gate previously allowed; otherwise gate already locked
        if (features[key] !== false) {
          features[key] = false;
          lockedReasons.features[key] = reason;
        }
      } else {
        // allow: only elevate if previously false due to default; don't override explicit gate lock unless rule says so
        // We do allow elevation if catalog wants it.
        features[key] = true;
      }
    }

    if (type === "domain") {
      const domKey = normalizeDomain(key);
      if (!domKey) continue;
      if (deny) {
        domains[domKey] = false;
        lockedReasons.domains[domKey] = reason;
      } else if (!allow) {
        if (domains[domKey] !== false) {
          domains[domKey] = false;
          lockedReasons.domains[domKey] = reason;
        }
      } else {
        domains[domKey] = true;
      }
    }
  }

  return { features, domains, lockedReasons };
}

/* -------------------------------------------------------------------------- */
/* Profile loading                                                             */
/* -------------------------------------------------------------------------- */

async function loadProfile(
  householdId,
  { profile = null, fallbackLevel = null } = {},
) {
  const C = resolveEffectiveCatalog();
  const hId = safeStr(householdId).trim();

  if (!hId) {
    const lvl = normalizeLevel(fallbackLevel || C.defaultLevel);
    return {
      id: "homestead_profile:anonymous",
      householdId: "anonymous",
      level: lvl,
      enabledDomains: unique(
        C.domainDefaults?.[lvl] || INTERNAL_DOMAIN_DEFAULTS[lvl] || [],
      ),
      goals: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      source: "fallback",
    };
  }

  if (isPlainObject(profile)) {
    const lvl = normalizeLevel(
      profile.level || fallbackLevel || C.defaultLevel,
    );
    return {
      ...profile,
      householdId: profile.householdId || hId,
      level: lvl,
      enabledDomains: unique(
        profile.enabledDomains ||
          C.domainDefaults?.[lvl] ||
          INTERNAL_DOMAIN_DEFAULTS[lvl] ||
          [],
      ),
      goals: unique(profile.goals || []),
      source: "provided",
      updatedAt: profile.updatedAt || nowIso(),
      createdAt: profile.createdAt || nowIso(),
    };
  }

  if (
    HomesteadProfileRepo &&
    typeof HomesteadProfileRepo.getActive === "function"
  ) {
    try {
      const p = await HomesteadProfileRepo.getActive(hId);
      if (p && typeof p === "object") {
        const lvl = normalizeLevel(p.level || fallbackLevel || C.defaultLevel);
        return {
          ...p,
          householdId: p.householdId || hId,
          level: lvl,
          enabledDomains: unique(
            p.enabledDomains ||
              C.domainDefaults?.[lvl] ||
              INTERNAL_DOMAIN_DEFAULTS[lvl] ||
              [],
          ),
          goals: unique(p.goals || []),
          source: "repo",
        };
      }
    } catch (err) {
      if (import.meta?.env?.DEV)
        console.warn("[HomesteadLevelService] getActive profile failed:", err);
    }
  }

  // Direct db fallback
  if (hasTable("homestead_profile")) {
    try {
      const row =
        (await db.homestead_profile.get(`homestead_profile:${hId}`)) ||
        (await db.homestead_profile.where("householdId").equals(hId).first());

      if (row && typeof row === "object") {
        const lvl = normalizeLevel(
          row.level || fallbackLevel || C.defaultLevel,
        );
        return {
          ...row,
          householdId: row.householdId || hId,
          level: lvl,
          enabledDomains: unique(
            row.enabledDomains ||
              C.domainDefaults?.[lvl] ||
              INTERNAL_DOMAIN_DEFAULTS[lvl] ||
              [],
          ),
          goals: unique(row.goals || []),
          source: "db",
        };
      }
    } catch {
      // ignore
    }
  }

  const lvl = normalizeLevel(fallbackLevel || C.defaultLevel);
  return {
    id: `homestead_profile:${hId}`,
    householdId: hId,
    level: lvl,
    enabledDomains: unique(
      C.domainDefaults?.[lvl] || INTERNAL_DOMAIN_DEFAULTS[lvl] || [],
    ),
    goals: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    source: "fallback",
  };
}

/* -------------------------------------------------------------------------- */
/* Public API: levels                                                          */
/* -------------------------------------------------------------------------- */

export const HOMESTEAD_LEVELS = (() => {
  const C = resolveEffectiveCatalog();
  return Object.freeze({ ...C.levelsByKey });
})();

export const HOMESTEAD_LEVEL_KEYS = (() => {
  const C = resolveEffectiveCatalog();
  return Object.freeze([...C.levelKeys]);
})();

export const DEFAULT_LEVEL = (() => {
  const C = resolveEffectiveCatalog();
  return C.defaultLevel || INTERNAL_DEFAULT_LEVEL;
})();

export function normalizeHomesteadLevel(level) {
  return normalizeLevel(level);
}

export function getLevelMeta(level) {
  const C = resolveEffectiveCatalog();
  const key = normalizeLevel(level);
  return C.levelsByKey[key] || INTERNAL_LEVELS[INTERNAL_DEFAULT_LEVEL];
}

export function getLevelRank(level) {
  return rankOf(level);
}

export function compareLevels(a, b) {
  return rankOf(a) - rankOf(b);
}

export function defaultDetailMode(level) {
  const r = rankOf(level);
  if (r <= 1) return "lite";
  if (r === 2) return "standard";
  if (r === 3) return "detailed";
  return "expert";
}

/* -------------------------------------------------------------------------- */
/* Public API: domains + gating                                                 */
/* -------------------------------------------------------------------------- */

export { DOMAINS, DOMAIN_KEYS };

export function getDomainLabel(domain) {
  const d = normalizeDomain(domain);
  return DOMAIN_LABELS[d] || safeStr(d, domain);
}

/**
 * Gate helper based on catalog featureGates (minRank) + optional unlockRules.
 * NOTE: If you need rule-aware gating, use getUnlockState/getUiGateMap.
 */
export function levelAllows(level, featureKey) {
  const C = resolveEffectiveCatalog();
  const gate = C.featureGates?.[featureKey];
  if (!gate) return true; // unknown features allowed by default
  return rankOf(level) >= Number(gate?.minRank ?? 0);
}

/**
 * Determine enabled domains list for a profile/level combo (resolved + normalized).
 * This returns the *configured* enabled domains (profile override or domainDefaults),
 * before unlockRules can potentially deny/allow extras.
 */
export function getEnabledDomains({ profile, level } = {}) {
  const C = resolveEffectiveCatalog();
  const lvl = normalizeLevel(level || profile?.level || C.defaultLevel);
  if (rankOf(lvl) <= 0) return [];

  const fromProfile = Array.isArray(profile?.enabledDomains)
    ? profile.enabledDomains
    : null;
  const base =
    fromProfile ||
    C.domainDefaults?.[lvl] ||
    INTERNAL_DOMAIN_DEFAULTS[lvl] ||
    [];
  return unique(base.map(normalizeDomain).filter(Boolean));
}

/**
 * Determine if a domain should be available given profile + level.
 * NOTE: This is configuration-only. For rule-aware gating, use getUnlockState().
 */
export function isDomainEnabled({ profile, level, domain }) {
  const C = resolveEffectiveCatalog();
  const lvl = normalizeLevel(level || profile?.level || C.defaultLevel);
  if (rankOf(lvl) <= 0) return false;

  const d = normalizeDomain(domain);
  if (!d) return false;

  const enabled = getEnabledDomains({ profile, level: lvl });

  // Known domain keys must be enabled explicitly
  const isKnown = DOMAIN_KEYS.includes(d);
  if (isKnown) return enabled.includes(d);

  // Unknown domains only if explicitly enabled
  return enabled.includes(d);
}

/* -------------------------------------------------------------------------- */
/* Unlock State (catalog + rules applied)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compute unlock state for this household:
 * - resolved profile
 * - enabledDomains (config)
 * - unlockedDomains (after rules)
 * - unlockedFeatures (after gates + rules)
 */
export async function getUnlockState(householdId, opts = {}) {
  const C = resolveEffectiveCatalog();
  const profile = await loadProfile(householdId, opts);

  const levelKey = normalizeLevel(profile.level || C.defaultLevel);
  const levelMeta = getLevelMeta(levelKey);

  const enabledDomains = getEnabledDomains({ profile, level: levelKey });

  const { features, domains, lockedReasons } = applyUnlockRules({
    profile,
    levelKey,
    enabledDomains,
    featureGates: C.featureGates || INTERNAL_FEATURE_GATES,
    unlockRules: C.unlockRules || [],
  });

  const unlockedDomains = Object.entries(domains)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k);

  return {
    profile: {
      ...profile,
      level: levelKey,
      levelRank: levelMeta.rank,
      levelLabel: levelMeta.label,
    },
    enabledDomains,
    unlockedDomains,
    unlockedDomainLabels: unlockedDomains.map((d) => ({
      key: d,
      label: getDomainLabel(d),
    })),
    unlockedFeatures: features,
    lockedReasons,
  };
}

/**
 * Resolve homestead profile and include unlocked maps for UI consumption.
 */
export async function getResolvedProfile(householdId, opts = {}) {
  const unlock = await getUnlockState(householdId, opts);
  const { profile, enabledDomains, unlockedDomains } = unlock;
  return {
    ...profile,
    enabledDomains,
    enabledDomainLabels: enabledDomains.map((d) => ({
      key: d,
      label: getDomainLabel(d),
    })),
    unlockedDomains,
    unlockedDomainLabels: unlockedDomains.map((d) => ({
      key: d,
      label: getDomainLabel(d),
    })),
    unlockedFeatures: unlock.unlockedFeatures,
    lockedReasons: unlock.lockedReasons,
  };
}

/**
 * UI Gate Map:
 * {
 *   level, levelRank, levelLabel, detailMode,
 *   domains: { meals:true, garden:false, ... }   // UNLOCKED
 *   enabledDomains: [...]                         // CONFIGURED
 *   features: { estimator:true, plans:false, ...} // UNLOCKED
 *   lockedReasons: {features:{}, domains:{}}
 * }
 */
export async function getUiGateMap(householdId, opts = {}) {
  const unlock = await getUnlockState(householdId, opts);
  const lvl = unlock.profile.level;

  const domains = {};
  for (const d of DOMAIN_KEYS) {
    domains[d] = unlock.unlockedDomains.includes(d);
  }

  return {
    level: lvl,
    levelRank: unlock.profile.levelRank,
    levelLabel: unlock.profile.levelLabel,
    detailMode: defaultDetailMode(lvl),
    enabledDomains: unlock.enabledDomains,
    domains,
    features: unlock.unlockedFeatures,
    lockedReasons: unlock.lockedReasons,
  };
}

/* -------------------------------------------------------------------------- */
/* Recommended Next Step (rule-aware)                                          */
/* -------------------------------------------------------------------------- */

export async function getRecommendedNextStep(householdId, opts = {}) {
  const unlock = await getUnlockState(householdId, opts);
  const profile = unlock.profile;
  const lvl = profile.level;
  const r = profile.levelRank;

  if (r <= 0) {
    return {
      key: "enable_homestead",
      title: "Enable Homestead Planner",
      description:
        "Turn on Pantry Builder or Scratch Cooking to start tracking food security and savings.",
      action: {
        kind: "navigate",
        payload: { to: "/tier2/household/homestead" },
      },
    };
  }

  // Pantry: if baselines locked, don't suggest estimator
  if (r === 1) {
    const baselinesUnlocked = Boolean(
      unlock.unlockedFeatures?.baselines ?? unlock.unlockedFeatures?.estimator,
    );
    if (baselinesUnlocked && hasTable("estimator_baselines")) {
      try {
        const row = await db.estimator_baselines
          .where("householdId")
          .equals(profile.householdId)
          .first();
        if (!row) {
          return {
            key: "run_estimator",
            title: "Run the Estimator",
            description:
              "Enter your grocery and eating-out baseline so SSA can calculate food security and savings.",
            action: {
              kind: "navigate",
              payload: { to: "/tier2/household/homestead/estimator" },
            },
          };
        }
      } catch {
        // ignore
      }
    }
    return {
      key: "stock_staples",
      title: "Stock 10 Pantry Staples",
      description:
        "Start with core grains/beans/oils/spices to reduce grocery volatility.",
      action: {
        kind: "navigate",
        payload: { to: "/tier2/household/storehouse" },
      },
    };
  }

  if (r === 2) {
    const batchesUnlocked = Boolean(unlock.unlockedFeatures?.batches);
    if (batchesUnlocked && hasTable("ftt_component_batches")) {
      try {
        const row = await db.ftt_component_batches
          .where("householdId")
          .equals(profile.householdId)
          .first();
        if (!row) {
          return {
            key: "first_batch",
            title: "Cook Your First Components",
            description:
              "Batch beans, rice, broth, or chopped veg to make weeknight meals faster and cheaper.",
            action: {
              kind: "navigate",
              payload: { to: "/tier2/household/homestead/components" },
            },
          };
        }
      } catch {
        // ignore
      }
    }
    return {
      key: "review_targets",
      title: "Review Targets",
      description:
        "Check your top provisioning targets and fill the biggest gaps.",
      action: {
        kind: "navigate",
        payload: { to: "/tier2/household/homestead/targets" },
      },
    };
  }

  if (r >= 3) {
    const plansUnlocked = Boolean(unlock.unlockedFeatures?.plans);
    if (plansUnlocked && hasTable("ftt_plans")) {
      try {
        const row = await db.ftt_plans
          .where("householdId")
          .equals(profile.householdId)
          .first();
        if (!row) {
          return {
            key: "run_plan",
            title: "Run a Homestead Plan",
            description:
              "Generate a plan with targets, gaps, actions, and optional garden/animal suggestions.",
            action: {
              kind: "navigate",
              payload: { to: "/tier2/household/homestead/plans/new" },
            },
          };
        }
      } catch {
        // ignore
      }
    }
    return {
      key: "review_plan_items",
      title: "Review Plan Items",
      description:
        "Use plan items to schedule tasks and track weekly progress.",
      action: {
        kind: "navigate",
        payload: { to: "/tier2/household/homestead/plans" },
      },
    };
  }

  return {
    key: "review_targets",
    title: "Review Targets",
    description:
      "Check your top provisioning targets and fill the biggest gaps.",
    action: {
      kind: "navigate",
      payload: { to: "/tier2/household/homestead/targets" },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Default export                                                              */
/* -------------------------------------------------------------------------- */

const HomesteadLevelService = {
  // levels
  HOMESTEAD_LEVELS,
  HOMESTEAD_LEVEL_KEYS,
  DEFAULT_LEVEL,

  // domains
  DOMAINS,
  DOMAIN_KEYS,
  normalizeDomain,
  getDomainLabel,

  // level helpers
  normalizeHomesteadLevel,
  getLevelMeta,
  getLevelRank,
  compareLevels,
  defaultDetailMode,

  // config-only gating
  levelAllows,
  getEnabledDomains,
  isDomainEnabled,

  // rule-aware gating
  getUnlockState,
  getResolvedProfile,
  getUiGateMap,

  // onboarding
  getRecommendedNextStep,
};

export default HomesteadLevelService;
