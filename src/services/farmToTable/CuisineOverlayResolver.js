/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\CuisineOverlayResolver.js
//
// CuisineOverlayResolver
// ----------------------
// Purpose
// - Determine which cuisines (base + overlays) should influence meal planning and
//   farm-to-table provisioning for a given household/person/time window.
// - Provide a deterministic, non-AI "next cuisines to use" selection.
// - Respect:
//   • Homestead profile enabled domains + selected level
//   • Cuisine user prefs (enabled/disabled, weights, exclusions)
//   • Rotation state (avoid repeating too often; maintain cadence)
//   • Optional per-session overrides (feasts, travel, illness)
//
// Dependencies (local-first)
// - Dexie db tables (see db.js):
//   • homestead_profile
//   • cuisine_profiles
//   • cuisine_user_prefs
//   • cuisine_rotation_state
//   • ftt_preferences_session_overrides (optional)
//   • personProfiles (optional)
//
// This resolver is designed to be safe even if some tables are missing:
// - Falls back to sane defaults (e.g., enabledByDefault cuisines).
//
// Output (typical):
// {
//   householdId,
//   personId,
//   window: { startISO, horizonDays },
//   baseCuisine: { key, name, weight },
//   overlays: [{ key, name, weight, reason, tags }],
//   blocked: [{ key, reason }],
//   debug: { ... },
// }
//
// Notes
// - "Cuisine overlay" here means: a cuisine flavor profile applied on top of a
//   planning baseline (e.g., "Herb & Garlic" overlay on top of "Levantine").
// - SSA catalogs define cuisine profiles; user prefs control enablement/weights.
// - This is a deterministic selector; randomness is optional but seeded if used.

import db from "@/services/db";

/* -------------------------------------------------------------------------- */
/* Utils */
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
  return Math.min(max, Math.max(min, safeNum(n, min)));
}

function toDayKey(iso) {
  // YYYY-MM-DD
  const s = safeStr(iso, nowIso());
  return s.slice(0, 10);
}

function stableHash(str) {
  // simple deterministic hash (no crypto dependency)
  const s = safeStr(str, "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  // deterministic PRNG (optional usage)
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hasTable(name) {
  try {
    void db.table(name);
    return true;
  } catch {
    return false;
  }
}

async function safeWhereEquals(tableName, indexName, value) {
  if (!hasTable(tableName)) return [];
  try {
    const t = db.table(tableName);
    return await t.where(indexName).equals(value).toArray();
  } catch {
    return [];
  }
}

async function safeFirstWhereEquals(tableName, indexName, value) {
  if (!hasTable(tableName)) return null;
  try {
    const t = db.table(tableName);
    return await t.where(indexName).equals(value).first();
  } catch {
    return null;
  }
}

async function safeGetAll(tableName) {
  if (!hasTable(tableName)) return [];
  try {
    return await db.table(tableName).toArray();
  } catch {
    return [];
  }
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Table loaders */
/* -------------------------------------------------------------------------- */

async function loadHomesteadProfile(householdId) {
  if (!hasTable("homestead_profile")) return null;
  // primary key likely "id" string; also store householdId
  try {
    const rows = await db.homestead_profile
      .where("householdId")
      .equals(safeStr(householdId))
      .toArray();
    rows.sort((a, b) =>
      safeStr(b.updatedAt).localeCompare(safeStr(a.updatedAt)),
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function loadCuisineProfiles() {
  // v14+ cuisine_profiles table includes:
  // cuisine_profiles: "++id,&key,name,enabledByDefault,createdAt,updatedAt"
  const rows = await safeGetAll("cuisine_profiles");
  // Normalize
  return rows
    .map((r) => ({
      key: safeStr(r.key || r.cuisineKey || r.meta?.id || r.id, ""),
      name: safeStr(r.name || r.label || r.meta?.label || r.key, ""),
      enabledByDefault: Boolean(r.enabledByDefault ?? r.enabled ?? false),
      tags: Array.isArray(r.tags) ? r.tags.map(String).filter(Boolean) : [],
      meta: r.meta && typeof r.meta === "object" ? r.meta : {},
      updatedAt: safeStr(r.updatedAt, ""),
      createdAt: safeStr(r.createdAt, ""),
    }))
    .filter((r) => r.key);
}

async function loadCuisineUserPrefs(householdId) {
  // cuisine_user_prefs: "++id,householdId,updatedAt"
  // Expected to store something like:
  // { householdId, enabledKeys:[], disabledKeys:[], weights:{[key]:number}, overlayKeys:[], baseKeys:[], ... }
  const rows = await safeWhereEquals(
    "cuisine_user_prefs",
    "householdId",
    safeStr(householdId),
  );
  rows.sort((a, b) => safeStr(b.updatedAt).localeCompare(safeStr(a.updatedAt)));
  return rows[0] || null;
}

async function loadRotationState(householdId) {
  // cuisine_rotation_state: "++id,householdId,cuisineKey,weekIndex,updatedAt,[householdId+cuisineKey],[householdId+updatedAt]"
  const rows = await safeWhereEquals(
    "cuisine_rotation_state",
    "householdId",
    safeStr(householdId),
  );
  return rows.map((r) => ({
    cuisineKey: safeStr(r.cuisineKey || r.key, ""),
    weekIndex: safeNum(r.weekIndex, 0),
    lastUsedISO: safeStr(r.lastUsedISO || r.updatedAt || "", ""),
    usedCount: safeNum(r.usedCount, 0),
    updatedAt: safeStr(r.updatedAt, ""),
  }));
}

async function loadSessionOverrides(householdId, appliesToISO) {
  // ftt_preferences_session_overrides: "id, householdId, appliesToISO, updatedAt, createdAt, status, ..."
  // We filter by householdId+appliesToISO if compound index exists, else scan.
  if (!hasTable("ftt_preferences_session_overrides")) return [];
  const h = safeStr(householdId);
  const day = toDayKey(appliesToISO || nowIso());
  try {
    const rows = await db.ftt_preferences_session_overrides
      .where("[householdId+appliesToISO]")
      .between([h, `${day}T00:00:00`], [h, `${day}T23:59:59.999`], true, true)
      .toArray();
    return rows;
  } catch {
    // fallback: filter scan for household
    const rows = await safeWhereEquals(
      "ftt_preferences_session_overrides",
      "householdId",
      h,
    );
    return rows.filter((r) => toDayKey(r.appliesToISO) === day);
  }
}

async function loadPersonProfile(personId) {
  if (!personId) return null;
  if (!hasTable("personProfiles")) return null;
  try {
    return await db.personProfiles.get(safeStr(personId));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Policy: defaults + normalization */
/* -------------------------------------------------------------------------- */

function normalizePrefs(prefs) {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const enabledKeys = Array.isArray(p.enabledKeys)
    ? p.enabledKeys.map(String)
    : [];
  const disabledKeys = Array.isArray(p.disabledKeys)
    ? p.disabledKeys.map(String)
    : [];
  const baseKeys = Array.isArray(p.baseKeys) ? p.baseKeys.map(String) : [];
  const overlayKeys = Array.isArray(p.overlayKeys)
    ? p.overlayKeys.map(String)
    : [];

  const weights = p.weights && typeof p.weights === "object" ? p.weights : {};
  const overlayWeights =
    p.overlayWeights && typeof p.overlayWeights === "object"
      ? p.overlayWeights
      : {};

  const maxOverlays = clamp(p.maxOverlays ?? 2, 0, 6);
  const avoidRepeatDays = clamp(p.avoidRepeatDays ?? 10, 0, 60);

  // Tag-based exclusions allow blocks by tags like "pork", "shellfish", etc.
  const excludeTags = Array.isArray(p.excludeTags)
    ? p.excludeTags.map(String)
    : [];

  return {
    enabledKeys,
    disabledKeys,
    baseKeys,
    overlayKeys,
    weights,
    overlayWeights,
    maxOverlays,
    avoidRepeatDays,
    excludeTags,
    raw: p,
  };
}

function normalizeHomesteadProfile(profile) {
  // homestead_profile: selected level, enabled domains, goals
  const p = profile && typeof profile === "object" ? profile : null;
  if (!p) return null;

  return {
    id: safeStr(p.id, ""),
    householdId: safeStr(p.householdId, ""),
    level: safeStr(p.level || p.selectedLevel || "starter"),
    enabledDomains: Array.isArray(p.enabledDomains)
      ? p.enabledDomains.map(String)
      : [],
    goals: Array.isArray(p.goals) ? p.goals.map(String) : [],
    cuisineMode: safeStr(p.cuisineMode || p.cuisineRotationMode || "rotation"), // rotation|fixed|off
    updatedAt: safeStr(p.updatedAt, ""),
  };
}

function daysSince(dateISO, refISO) {
  const a = Date.parse(dateISO || "");
  const b = Date.parse(refISO || "");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

function pickWeighted(items, weightFn, rng) {
  const weights = items.map((x) => Math.max(0, safeNum(weightFn(x), 0)));
  const total = weights.reduce((acc, w) => acc + w, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (let i = 0; i < items.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1] || null;
}

/* -------------------------------------------------------------------------- */
/* Resolver core */
/* -------------------------------------------------------------------------- */

/**
 * Resolve cuisine overlay selection.
 *
 * @param {object} args
 * @param {string} args.householdId
 * @param {string=} args.personId
 * @param {string=} args.startISO
 * @param {number=} args.horizonDays
 * @param {string=} args.intent  Optional: "mealplan"|"provisioning"|"shopping"
 * @param {boolean=} args.allowRandom  If true, weighted pick uses seeded randomness.
 * @returns {Promise<object>}
 */
export async function resolveCuisineOverlay({
  householdId,
  personId = null,
  startISO = nowIso(),
  horizonDays = 14,
  intent = "mealplan",
  allowRandom = true,
} = {}) {
  const hId = safeStr(householdId).trim();
  if (!hId) {
    throw new Error("[CuisineOverlayResolver] householdId is required");
  }

  const window = {
    startISO: safeStr(startISO, nowIso()),
    horizonDays: clamp(horizonDays, 1, 365),
  };

  // Load data (safe/local-first)
  const [
    homesteadProfileRaw,
    cuisineProfiles,
    prefsRaw,
    rotationState,
    overrides,
    person,
  ] = await Promise.all([
    loadHomesteadProfile(hId),
    loadCuisineProfiles(),
    loadCuisineUserPrefs(hId),
    loadRotationState(hId),
    loadSessionOverrides(hId, window.startISO),
    loadPersonProfile(personId),
  ]);

  const homesteadProfile = normalizeHomesteadProfile(homesteadProfileRaw);
  const prefs = normalizePrefs(prefsRaw);

  // If homestead profile explicitly disables cuisine/meal planning domains, return empty.
  // (We keep deterministic behavior, no implicit opt-in.)
  const enabledDomains = homesteadProfile?.enabledDomains || [];
  const cuisineDomainAllowed =
    enabledDomains.length === 0 ||
    enabledDomains.includes("meals") ||
    enabledDomains.includes("farm_to_table") ||
    enabledDomains.includes("ftt");

  // Session overrides can force cuisines (e.g., feast day theme)
  const overrideCuisineKeys = [];
  const blockCuisineKeys = [];
  const overrideOverlayKeys = [];
  let overrideMaxOverlays = null;

  for (const o of overrides || []) {
    const s = safeStr(o.status, "active");
    if (s === "archived" || s === "disabled") continue;

    // Convention (recommended):
    // o.cuisines = { forceBaseKeys:[], forceOverlayKeys:[], blockKeys:[], maxOverlays?: number }
    const c = o.cuisines && typeof o.cuisines === "object" ? o.cuisines : null;
    if (!c) continue;

    if (Array.isArray(c.forceBaseKeys))
      overrideCuisineKeys.push(...c.forceBaseKeys.map(String));
    if (Array.isArray(c.forceOverlayKeys))
      overrideOverlayKeys.push(...c.forceOverlayKeys.map(String));
    if (Array.isArray(c.blockKeys))
      blockCuisineKeys.push(...c.blockKeys.map(String));
    if (c.maxOverlays != null) overrideMaxOverlays = clamp(c.maxOverlays, 0, 6);
  }

  // Person constraints: allow tag exclusions (e.g. allergies/preferences) via person.meta
  const personExcludeTags =
    person?.excludeCuisineTags && Array.isArray(person.excludeCuisineTags)
      ? person.excludeCuisineTags.map(String)
      : person?.meta?.excludeCuisineTags &&
          Array.isArray(person.meta.excludeCuisineTags)
        ? person.meta.excludeCuisineTags.map(String)
        : [];

  // Build map of cuisines
  const byKey = new Map();
  for (const c of cuisineProfiles) byKey.set(c.key, c);

  // If no cuisine_profiles exist (early boot), return safe defaults (empty)
  if (!cuisineProfiles.length || !cuisineDomainAllowed) {
    return {
      householdId: hId,
      personId,
      intent,
      window,
      baseCuisine: null,
      overlays: [],
      blocked: [],
      debug: {
        reason: !cuisineDomainAllowed
          ? "cuisineDomainDisabledByHomesteadProfile"
          : "noCuisineProfiles",
        homesteadProfile,
      },
    };
  }

  // Candidate sets
  const enabledByDefault = cuisineProfiles.filter((c) => c.enabledByDefault);

  // Apply user prefs enable/disable
  const explicitlyEnabled = prefs.enabledKeys
    .map((k) => byKey.get(k))
    .filter(Boolean);
  const explicitlyDisabled = new Set(prefs.disabledKeys);

  // Start with:
  // - if enabledKeys set: use those
  // - else: enabledByDefault
  let candidateBase = (
    explicitlyEnabled.length ? explicitlyEnabled : enabledByDefault
  ).filter((c) => !explicitlyDisabled.has(c.key));

  // If baseKeys specified, constrain base candidates
  if (prefs.baseKeys.length) {
    const allowBase = new Set(prefs.baseKeys);
    candidateBase = candidateBase.filter((c) => allowBase.has(c.key));
  }

  // Tag-based exclusions (user/personal)
  const excludeTags = new Set(
    [...prefs.excludeTags, ...personExcludeTags].filter(Boolean),
  );
  if (excludeTags.size) {
    candidateBase = candidateBase.filter((c) => {
      const tags = new Set(
        [...(c.tags || []), ...(c.meta?.tags || [])].map(String),
      );
      for (const t of excludeTags) if (tags.has(t)) return false;
      return true;
    });
  }

  // Apply session blocks
  if (blockCuisineKeys.length) {
    const block = new Set(blockCuisineKeys);
    candidateBase = candidateBase.filter((c) => !block.has(c.key));
  }

  // Build overlay candidates:
  // - overlayKeys specified: use intersection with enabled
  // - else: "profile.overlay" tagged cuisines are overlays; if none, use enabledByDefault overlays heuristically
  let candidateOverlays = [];
  const overlayTagged = cuisineProfiles.filter((c) =>
    (c.tags || []).includes("profile.overlay"),
  );
  const baseTagged = cuisineProfiles.filter(
    (c) => !(c.tags || []).includes("profile.overlay"),
  );

  if (prefs.overlayKeys.length) {
    const allowOver = new Set(prefs.overlayKeys);
    candidateOverlays = cuisineProfiles.filter((c) => allowOver.has(c.key));
  } else if (overlayTagged.length) {
    candidateOverlays = overlayTagged.slice();
  } else {
    // fallback: allow any cuisine as overlay if no overlays exist
    candidateOverlays = enabledByDefault.slice();
  }

  // Apply user enable/disable to overlays
  candidateOverlays = candidateOverlays.filter(
    (c) => !explicitlyDisabled.has(c.key),
  );
  if (prefs.enabledKeys.length) {
    // if user used explicit enable list, overlays should also be from enabled
    const allow = new Set(prefs.enabledKeys);
    candidateOverlays = candidateOverlays.filter((c) => allow.has(c.key));
  }

  // Apply tag exclusions + session blocks to overlays
  if (excludeTags.size) {
    candidateOverlays = candidateOverlays.filter((c) => {
      const tags = new Set(
        [...(c.tags || []), ...(c.meta?.tags || [])].map(String),
      );
      for (const t of excludeTags) if (tags.has(t)) return false;
      return true;
    });
  }
  if (blockCuisineKeys.length) {
    const block = new Set(blockCuisineKeys);
    candidateOverlays = candidateOverlays.filter((c) => !block.has(c.key));
  }

  // De-dup + remove anything that is also selected as base (later)
  candidateOverlays = uniqBy(candidateOverlays, (c) => c.key);

  // Rotation penalty: avoid repeats (deterministic)
  const rotationByKey = new Map(rotationState.map((r) => [r.cuisineKey, r]));
  const refISO = window.startISO;
  const avoidDays = prefs.avoidRepeatDays;

  function baseWeight(c) {
    const base = safeNum(prefs.weights?.[c.key], 1);
    const rot = rotationByKey.get(c.key);
    const lastUsed = rot?.lastUsedISO;
    const ds = lastUsed ? daysSince(lastUsed, refISO) : Infinity;
    const penalty = ds < avoidDays ? 0.15 : 1; // heavy penalty if used recently
    return base * penalty;
  }

  function overlayWeight(c) {
    const base = safeNum(
      prefs.overlayWeights?.[c.key],
      safeNum(prefs.weights?.[c.key], 1),
    );
    const rot = rotationByKey.get(c.key);
    const lastUsed = rot?.lastUsedISO;
    const ds = lastUsed ? daysSince(lastUsed, refISO) : Infinity;
    const penalty = ds < Math.max(3, Math.floor(avoidDays / 2)) ? 0.35 : 1;
    // overlays get slightly reduced by default unless explicitly boosted
    return base * penalty * 0.9;
  }

  // Forced cuisines from session overrides override everything
  const forcedBase = overrideCuisineKeys
    .map((k) => byKey.get(k))
    .filter(Boolean);
  const forcedOverlays = overrideOverlayKeys
    .map((k) => byKey.get(k))
    .filter(Boolean);

  const debug = {
    homesteadProfile,
    prefs: prefsRaw || null,
    computed: {
      candidateBaseCount: candidateBase.length,
      candidateOverlayCount: candidateOverlays.length,
      overrideCuisineKeys,
      overrideOverlayKeys,
      blockCuisineKeys,
      excludeTags: Array.from(excludeTags),
      rotationStateCount: rotationState.length,
      intent,
    },
  };

  // Seeded randomness (optional) so results are stable for same day/person/intent
  const seed = stableHash(
    `${hId}|${safeStr(personId)}|${toDayKey(window.startISO)}|${intent}`,
  );
  const rng = allowRandom ? mulberry32(seed) : () => 0; // deterministic "first pick" if allowRandom=false

  // Select base cuisine
  let baseCuisine = null;
  if (forcedBase.length) {
    // Prefer first forced that isn't blocked/excluded (already filtered)
    baseCuisine = forcedBase[0] || null;
  } else {
    // Prefer non-overlay tagged for base if present
    const baseCandidates = candidateBase.filter((c) =>
      baseTagged.some((b) => b.key === c.key),
    );
    const pool = baseCandidates.length ? baseCandidates : candidateBase;
    baseCuisine = pickWeighted(pool, baseWeight, rng) || pool[0] || null;
  }

  // Select overlays
  const overlays = [];
  const blocked = [];

  const maxOverlays =
    overrideMaxOverlays == null ? prefs.maxOverlays : overrideMaxOverlays;

  // If forced overlays exist, use them up to max
  if (forcedOverlays.length) {
    for (const c of forcedOverlays) {
      if (!c || !c.key) continue;
      if (baseCuisine && c.key === baseCuisine.key) continue;
      overlays.push({
        key: c.key,
        name: c.name,
        weight: overlayWeight(c),
        reason: "forced_by_session_override",
        tags: c.tags || [],
      });
      if (overlays.length >= maxOverlays) break;
    }
  }

  // Fill overlays from candidates
  if (overlays.length < maxOverlays && candidateOverlays.length) {
    // remove base from overlays pool
    let pool = candidateOverlays.filter(
      (c) => !baseCuisine || c.key !== baseCuisine.key,
    );

    // remove overlays already chosen
    const already = new Set(overlays.map((o) => o.key));
    pool = pool.filter((c) => !already.has(c.key));

    // If user specified overlayKeys, keep that order bias via weights (still weighted)
    const picksNeeded = maxOverlays - overlays.length;

    // Deterministic multiple picks: pick one at a time, removing chosen
    for (let i = 0; i < picksNeeded; i += 1) {
      if (!pool.length) break;
      const chosen = pickWeighted(pool, overlayWeight, rng) || pool[0];
      if (!chosen) break;

      overlays.push({
        key: chosen.key,
        name: chosen.name,
        weight: overlayWeight(chosen),
        reason: "rotation_weighted_pick",
        tags: chosen.tags || [],
      });

      pool = pool.filter((c) => c.key !== chosen.key);
    }
  }

  // Compute blocked list (informational)
  // - disabledKeys
  // - session blocks
  // - tag exclusions
  const disabledList = prefs.disabledKeys
    .map((k) => byKey.get(k))
    .filter(Boolean)
    .map((c) => ({ key: c.key, reason: "disabled_by_user_prefs" }));

  const sessionBlockedList = blockCuisineKeys
    .map((k) => byKey.get(k))
    .filter(Boolean)
    .map((c) => ({ key: c.key, reason: "blocked_by_session_override" }));

  // tag excluded: any cuisine having any excluded tag
  const tagBlockedList = [];
  if (excludeTags.size) {
    for (const c of cuisineProfiles) {
      const tags = new Set(
        [...(c.tags || []), ...(c.meta?.tags || [])].map(String),
      );
      for (const t of excludeTags) {
        if (tags.has(t)) {
          tagBlockedList.push({ key: c.key, reason: `excluded_by_tag:${t}` });
          break;
        }
      }
    }
  }

  blocked.push(...disabledList, ...sessionBlockedList, ...tagBlockedList);
  const blockedUnique = uniqBy(blocked, (b) => `${b.key}:${b.reason}`);

  // Final shaping
  const baseOut =
    baseCuisine && baseCuisine.key
      ? {
          key: baseCuisine.key,
          name: baseCuisine.name,
          weight: baseWeight(baseCuisine),
        }
      : null;

  const overlayOut = overlays.map((o) => ({
    key: o.key,
    name: o.name,
    weight: o.weight,
    reason: o.reason,
    tags: o.tags,
  }));

  return {
    householdId: hId,
    personId,
    intent,
    window,
    baseCuisine: baseOut,
    overlays: overlayOut,
    blocked: blockedUnique,
    debug,
  };
}

/* -------------------------------------------------------------------------- */
/* Convenience helpers */
/* -------------------------------------------------------------------------- */

/**
 * Resolve and return just the cuisine keys in deterministic priority order:
 * [baseCuisineKey, ...overlayKeys]
 */
export async function resolveCuisineKeys(args) {
  const res = await resolveCuisineOverlay(args);
  const keys = [];
  if (res?.baseCuisine?.key) keys.push(res.baseCuisine.key);
  for (const o of res?.overlays || []) if (o?.key) keys.push(o.key);
  return keys;
}

/**
 * Resolve and return a tags union from base + overlays (useful for planners).
 */
export async function resolveCuisineTags(args) {
  const res = await resolveCuisineOverlay(args);
  const tags = new Set();

  const addTagsForKey = (key) => {
    if (!key) return;
    // We read cuisine_profiles for tag union
    // Note: we keep this local; no extra table joins needed for small scale.
    // If needed later, add a cuisine_tags_index table.
  };

  // Minimal tags output from resolver already includes overlay tags.
  // We don't currently include base tags in baseCuisine; so fetch.
  const all = await loadCuisineProfiles();
  const byKey = new Map(all.map((c) => [c.key, c]));
  const base = res?.baseCuisine?.key ? byKey.get(res.baseCuisine.key) : null;
  if (base) for (const t of base.tags || []) tags.add(String(t));
  for (const o of res?.overlays || []) {
    const c = byKey.get(o.key);
    if (c) for (const t of c.tags || []) tags.add(String(t));
  }

  void addTagsForKey; // keep lint happy for future expansion
  return Array.from(tags);
}

/* -------------------------------------------------------------------------- */
/* Default export */
/* -------------------------------------------------------------------------- */

const CuisineOverlayResolver = {
  resolveCuisineOverlay,
  resolveCuisineKeys,
  resolveCuisineTags,
};

export default CuisineOverlayResolver;
