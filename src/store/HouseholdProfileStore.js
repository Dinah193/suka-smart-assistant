// File: C:\Users\larho\suka-smart-assistant\src\store\HouseholdProfileStore.js
/**
 * HouseholdProfileStore (SSA)
 * -----------------------------------------------------------------------------
 * Offline-first household profile store (identity + members + household rules).
 *
 * Why this exists:
 *  - Many SSA modules need a single, resilient place for:
 *      • household identity (name, region, timezone)
 *      • members (roles, contacts, notification prefs)
 *      • dietary constraints + kitchen rules
 *      • Sabbath/quiet hours preferences
 *      • inventory/storehouse preferences (units, par levels, brands)
 *      • feature toggles at household level (optional)
 *
 * Design goals:
 *  - Browser-safe (no Node imports)
 *  - Dexie-backed if tables exist; localStorage fallback otherwise
 *  - Tolerant of missing tables / schema changes
 *  - Event-driven: emits changes for UI + automation runtime
 *  - Idempotent updates; supports partial patches and updater functions
 *
 * Recommended Dexie tables (if you create them later):
 *  - household_profile:  { id: "primary", value: {..}, updatedAt }
 *  - household_members:  optional normalized members table (not required)
 *
 * Public API:
 *  - hydrate()
 *  - getState() / subscribe()
 *  - getProfile()
 *  - setProfile(patch | updater, options?)
 *  - reset(kind?)
 *  - persistNow()
 *  - member helpers: upsertMember(), removeMember(), setPrimaryMember()
 *  - convenience getters: getTimezone(), getQuietHours(), getSabbathPrefs()
 *
 * Notes:
 *  - This store is a "single-document" profile with id="primary".
 *  - If you later normalize members into their own table, you can keep this
 *    store as the canonical snapshot and sync downstream.
 */

import db from "@/services/db";

/* -----------------------------------------------------------------------------
 * Optional deps (soft)
 * -------------------------------------------------------------------------- */

let eventBus = null;
try {
  const mod = await import("@/services/events/eventBus");
  eventBus = mod?.default ?? mod ?? null;
} catch {
  eventBus = null;
}

let autoBus = null;
try {
  const mod = await import("@/services/automation/eventBus.js");
  autoBus = mod?.default ?? mod ?? null;
} catch {
  autoBus = null;
}

let logger = null;
try {
  const mod = await import("@/utils/logger.js");
  logger = mod?.default ?? null;
} catch {
  logger = null;
}

// Feature flags are optional; this store never hard-requires them.
// Some projects keep them in src/featureFlags.js or src/services/featureFlags.js
let featureFlags = null;
try {
  const mod = await import("@/config/featureFlags");
  featureFlags = mod?.default ?? mod ?? null;
} catch {
  try {
    const mod2 = await import("@/config/featureFlags");
    featureFlags = mod2?.default ?? mod2 ?? null;
  } catch {
    featureFlags = null;
  }
}

/* -----------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------- */

const SOURCE = "store.HouseholdProfileStore";
const LS_KEY = "ssa.household.profile.v1";
const LS_META = "ssa.household.profile.meta.v1";

const DEFAULT_PROFILE = {
  id: "primary",
  version: 1,

  // Household identity
  householdName: "My Household",
  householdId: null, // optional external id (family fund hub, etc.)
  region: null, // e.g., "US-AL" or free-form
  timezone:
    (typeof Intl !== "undefined" &&
      Intl.DateTimeFormat?.().resolvedOptions?.().timeZone) ||
    null,
  locale:
    (typeof navigator !== "undefined" &&
      (navigator.language || navigator.languages?.[0])) ||
    null,

  // Leadership / primary contact
  primaryMemberId: null,

  // Members (lightweight; you can normalize later)
  // member shape:
  //  { id, name, role, email?, phone?, notifyPrefs?, dietaryPrefs? }
  members: [],

  // Household-wide preferences (kept intentionally broad)
  preferences: {
    // Sabbath/quiet hours (used by session alerts, calendar, etc.)
    sabbathAware: true,
    quietHours: { start: "22:00", end: "07:00", deferTo: "08:00" },

    // Calendar defaults
    weekStartsOn: 0, // 0=Sun, 1=Mon

    // Kitchen/dietary constraints at household level
    dietary: {
      // your meal prefs store likely goes deeper; this is household baseline.
      disallowedIngredients: [],
      disallowedTags: [],
      preferredCuisines: [],
      allergens: [],
      notes: "",
    },

    // Inventory/storehouse defaults
    inventory: {
      unitsSystem: "us", // "us" | "metric"
      defaultLocationId: null,
      showParLevels: true,
      lowStockThresholdPct: 0.2,
      preferredBrands: [],
      preferredStores: [],
    },

    // Notifications defaults (per-member can override)
    notifications: {
      channels: { push: true, sms: true, email: true },
      escalation: { enabled: false, afterMinutes: 10, toMemberIds: [] },
    },
  },

  // Household-level feature toggles (optional)
  // Use for "enable X module for this household", not global build flags.
  toggles: {},

  // Meta
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  meta: {},
};

const DEFAULT_STATE = {
  hydrated: false,
  dirty: false,
  lastUpdated: 0,
  error: null,
  source: "defaults", // defaults|dexie|localStorage
};

/* -----------------------------------------------------------------------------
 * Internal state
 * -------------------------------------------------------------------------- */

const state = {
  ...DEFAULT_STATE,
  profile: { ...DEFAULT_PROFILE },
};

const subs = new Set();
let persistTimer = null;

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}
function safeObj(x) {
  return isObj(x) ? x : {};
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function nowISO() {
  return new Date().toISOString();
}
function clamp(n, a, b) {
  const v = Number(n);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}
function normalizeId(x, fallbackPrefix = "id") {
  const s = String(x || "").trim();
  if (s) return s;
  return `${fallbackPrefix}_${Date.now().toString(16)}_${Math.random()
    .toString(16)
    .slice(2)}`;
}
function deepMerge(base, patch) {
  const b = safeObj(base);
  const p = safeObj(patch);
  const out = { ...b };
  for (const k of Object.keys(p)) {
    const pv = p[k];
    const bv = out[k];
    if (isObj(pv) && isObj(bv)) out[k] = deepMerge(bv, pv);
    else out[k] = pv;
  }
  return out;
}
function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
  try {
    autoBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
}
function notify() {
  const snap = getState();
  for (const fn of subs) {
    try {
      fn(snap);
    } catch {
      // ignore
    }
  }
}
function schedulePersist(delayMs = 250) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow().catch(() => {});
  }, delayMs);
}
function logWarn(msg, meta) {
  try {
    logger?.warn?.(msg, meta, { source: SOURCE });
  } catch {
    // ignore
  }
}

/* -----------------------------------------------------------------------------
 * Normalization
 * -------------------------------------------------------------------------- */

function normalizeQuietHours(qh) {
  const q = safeObj(qh);
  return {
    start: String(q.start || DEFAULT_PROFILE.preferences.quietHours.start),
    end: String(q.end || DEFAULT_PROFILE.preferences.quietHours.end),
    deferTo: String(
      q.deferTo || DEFAULT_PROFILE.preferences.quietHours.deferTo
    ),
  };
}

function normalizeMember(m) {
  const x = safeObj(m);
  const id = normalizeId(x.id, "member");
  const name = String(x.name || x.fullName || "Member");
  const role = String(x.role || x.kind || "member");
  const notifyPrefs = safeObj(x.notifyPrefs || x.notifications);
  const dietaryPrefs = safeObj(x.dietaryPrefs || x.dietary);

  return {
    id,
    name,
    role,
    email: x.email ? String(x.email) : null,
    phone: x.phone ? String(x.phone) : null,
    notifyPrefs: {
      preference: String(notifyPrefs.preference || "both"), // sms|email|both|push
      channels: {
        push: notifyPrefs.channels?.push ?? true,
        sms: notifyPrefs.channels?.sms ?? true,
        email: notifyPrefs.channels?.email ?? true,
      },
      quietHoursOverride: notifyPrefs.quietHoursOverride
        ? normalizeQuietHours(notifyPrefs.quietHoursOverride)
        : null,
    },
    dietaryPrefs: {
      disallowedIngredients: safeArr(dietaryPrefs.disallowedIngredients).map(
        String
      ),
      disallowedTags: safeArr(dietaryPrefs.disallowedTags).map(String),
      allergens: safeArr(dietaryPrefs.allergens).map(String),
      notes: dietaryPrefs.notes != null ? String(dietaryPrefs.notes) : "",
    },
    createdAt: String(x.createdAt || nowISO()),
    updatedAt: String(x.updatedAt || nowISO()),
    meta: safeObj(x.meta),
  };
}

function normalizeProfile(raw) {
  const r = safeObj(raw);

  const prefs = safeObj(r.preferences);
  const dietary = safeObj(prefs.dietary);
  const inv = safeObj(prefs.inventory);
  const notif = safeObj(prefs.notifications);

  const merged = deepMerge(DEFAULT_PROFILE, r);

  const normalized = {
    ...merged,
    id: "primary",
    version: DEFAULT_PROFILE.version,

    householdName: String(
      merged.householdName || DEFAULT_PROFILE.householdName
    ),
    householdId: merged.householdId != null ? String(merged.householdId) : null,
    region: merged.region != null ? String(merged.region) : null,
    timezone:
      merged.timezone != null
        ? String(merged.timezone)
        : DEFAULT_PROFILE.timezone,
    locale:
      merged.locale != null ? String(merged.locale) : DEFAULT_PROFILE.locale,

    primaryMemberId: merged.primaryMemberId
      ? String(merged.primaryMemberId)
      : null,
    members: safeArr(merged.members).map(normalizeMember),

    preferences: {
      sabbathAware: prefs.sabbathAware !== false,
      quietHours: normalizeQuietHours(prefs.quietHours),
      weekStartsOn: clamp(
        prefs.weekStartsOn ?? DEFAULT_PROFILE.preferences.weekStartsOn,
        0,
        1
      ),

      dietary: {
        disallowedIngredients: safeArr(dietary.disallowedIngredients).map(
          String
        ),
        disallowedTags: safeArr(dietary.disallowedTags).map(String),
        preferredCuisines: safeArr(dietary.preferredCuisines).map(String),
        allergens: safeArr(dietary.allergens).map(String),
        notes: dietary.notes != null ? String(dietary.notes) : "",
      },

      inventory: {
        unitsSystem: String(
          inv.unitsSystem || DEFAULT_PROFILE.preferences.inventory.unitsSystem
        ),
        defaultLocationId:
          inv.defaultLocationId != null ? String(inv.defaultLocationId) : null,
        showParLevels: inv.showParLevels !== false,
        lowStockThresholdPct: clamp(
          inv.lowStockThresholdPct ??
            DEFAULT_PROFILE.preferences.inventory.lowStockThresholdPct,
          0,
          1
        ),
        preferredBrands: safeArr(inv.preferredBrands).map(String),
        preferredStores: safeArr(inv.preferredStores).map(String),
      },

      notifications: {
        channels: {
          push:
            notif.channels?.push ??
            DEFAULT_PROFILE.preferences.notifications.channels.push,
          sms:
            notif.channels?.sms ??
            DEFAULT_PROFILE.preferences.notifications.channels.sms,
          email:
            notif.channels?.email ??
            DEFAULT_PROFILE.preferences.notifications.channels.email,
        },
        escalation: {
          enabled:
            notif.escalation?.enabled ??
            DEFAULT_PROFILE.preferences.notifications.escalation.enabled,
          afterMinutes: clamp(
            notif.escalation?.afterMinutes ??
              DEFAULT_PROFILE.preferences.notifications.escalation.afterMinutes,
            1,
            180
          ),
          toMemberIds: safeArr(
            notif.escalation?.toMemberIds ??
              DEFAULT_PROFILE.preferences.notifications.escalation.toMemberIds
          ).map(String),
        },
      },
    },

    toggles: safeObj(merged.toggles),
    meta: safeObj(merged.meta),

    createdAt: String(merged.createdAt || nowISO()),
    updatedAt: String(merged.updatedAt || nowISO()),
  };

  // If no primaryMemberId, set to first member if present
  if (!normalized.primaryMemberId && normalized.members.length) {
    normalized.primaryMemberId = normalized.members[0].id;
  }

  // Optional: merge global feature flags into toggles if you want a single read surface
  // (no-op if flags absent)
  try {
    const ff =
      typeof featureFlags?.getAll === "function"
        ? featureFlags.getAll()
        : safeObj(featureFlags?.flags || featureFlags);
    normalized.toggles = { ...safeObj(ff), ...safeObj(normalized.toggles) };
  } catch {
    // ignore
  }

  return normalized;
}

/* -----------------------------------------------------------------------------
 * Persistence (Dexie preferred, localStorage fallback)
 * -------------------------------------------------------------------------- */

const TABLE_CANDIDATES = [
  "household_profile",
  "householdProfile",
  "household_profiles",
  "profiles_household",
];

function resolveTable() {
  for (const name of TABLE_CANDIDATES) {
    const t = db?.[name];
    if (t && typeof t.put === "function" && typeof t.get === "function")
      return t;
  }
  try {
    const tables = db?.tables || [];
    for (const name of TABLE_CANDIDATES) {
      const hit = tables.find((t) => t?.name === name);
      if (hit) return hit;
    }
  } catch {
    // ignore
  }
  return null;
}

async function loadDexie() {
  const t = resolveTable();
  if (!t) return null;
  try {
    const row = await t.get("primary");
    if (!row) return null;
    return row.value || row.profile || row.state || row;
  } catch {
    return null;
  }
}

async function saveDexie(profile) {
  const t = resolveTable();
  if (!t) return false;
  try {
    await t.put({
      id: "primary",
      value: profile,
      updatedAt: Date.now(),
      source: SOURCE,
    });
    return true;
  } catch {
    return false;
  }
}

function loadLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveLS(profile) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(profile));
    localStorage.setItem(
      LS_META,
      JSON.stringify({ updatedAt: Date.now(), source: SOURCE })
    );
    return true;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

export function getState() {
  return {
    hydrated: state.hydrated,
    dirty: state.dirty,
    lastUpdated: state.lastUpdated,
    error: state.error,
    source: state.source,
    profile: getProfile(),
  };
}

export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  subs.add(fn);
  return () => subs.delete(fn);
}

export function getProfile() {
  // return safe snapshot
  const p = state.profile || DEFAULT_PROFILE;
  return {
    ...p,
    members: safeArr(p.members).map((m) => ({
      ...m,
      notifyPrefs: {
        ...safeObj(m.notifyPrefs),
        channels: { ...safeObj(m.notifyPrefs?.channels) },
      },
    })),
    preferences: {
      ...p.preferences,
      quietHours: { ...safeObj(p.preferences?.quietHours) },
      dietary: { ...safeObj(p.preferences?.dietary) },
      inventory: { ...safeObj(p.preferences?.inventory) },
      notifications: {
        ...safeObj(p.preferences?.notifications),
        channels: { ...safeObj(p.preferences?.notifications?.channels) },
        escalation: { ...safeObj(p.preferences?.notifications?.escalation) },
      },
    },
    toggles: { ...safeObj(p.toggles) },
    meta: { ...safeObj(p.meta) },
  };
}

/**
 * Hydrate from Dexie or localStorage
 */
export async function hydrate() {
  try {
    let loaded = await loadDexie();
    let source = "dexie";

    if (!loaded) {
      loaded = loadLS();
      source = loaded ? "localStorage" : "defaults";
    }

    const profile = normalizeProfile(loaded || DEFAULT_PROFILE);

    state.profile = profile;
    state.hydrated = true;
    state.dirty = false;
    state.error = null;
    state.source = source;
    state.lastUpdated = Date.now();

    emit("household.profile.hydrated", { source, profile });
    notify();

    return { ok: true, source, profile };
  } catch (err) {
    state.error = String(err?.message || err);
    try {
      logger?.error?.("HouseholdProfileStore hydrate failed", err, {
        source: SOURCE,
      });
    } catch {
      // ignore
    }
    notify();
    return { ok: false, error: state.error };
  }
}

/**
 * Persist immediately
 */
export async function persistNow() {
  try {
    const profile = normalizeProfile({ ...state.profile, updatedAt: nowISO() });

    let ok = await saveDexie(profile);
    let source = "dexie";
    if (!ok) {
      ok = saveLS(profile);
      source = "localStorage";
    }

    if (ok) {
      state.profile = profile;
      state.dirty = false;
      state.lastUpdated = Date.now();
      state.source = source;

      emit("household.profile.persisted", { source, profile });
      notify();
      return { ok: true, source };
    }

    return { ok: false, reason: "persist_failed" };
  } catch (err) {
    logWarn("HouseholdProfileStore persist failed", {
      err: String(err?.message || err),
    });
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Patch profile.
 * @param {object|function} patchOrUpdater - patch object or (prevProfile)=>patch
 * @param {object} [options]
 * @param {boolean} [options.persist=true]
 * @param {number} [options.persistDelayMs=250]
 */
export function setProfile(patchOrUpdater, options = {}) {
  const opts = safeObj(options);
  const prev = getProfile();
  const patch =
    typeof patchOrUpdater === "function"
      ? patchOrUpdater(prev)
      : patchOrUpdater;

  const nextRaw = deepMerge(prev, safeObj(patch));
  const next = normalizeProfile({ ...nextRaw, updatedAt: nowISO() });

  state.profile = next;
  state.dirty = true;
  state.lastUpdated = Date.now();

  emit("household.profile.changed", { patch: safeObj(patch), profile: next });
  notify();

  if (opts.persist !== false) schedulePersist(opts.persistDelayMs ?? 250);

  return getProfile();
}

/**
 * Reset store.
 * @param {"all"|"prefs"|"members"|"toggles"} [kind="all"]
 */
export function reset(kind = "all") {
  const k = String(kind || "all").toLowerCase();
  if (k === "prefs") {
    return setProfile({ preferences: { ...DEFAULT_PROFILE.preferences } });
  }
  if (k === "members") {
    return setProfile({ members: [], primaryMemberId: null });
  }
  if (k === "toggles") {
    return setProfile({ toggles: {} });
  }

  state.profile = normalizeProfile({
    ...DEFAULT_PROFILE,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  });
  state.dirty = true;
  state.lastUpdated = Date.now();

  emit("household.profile.reset", { profile: getProfile() });
  notify();
  schedulePersist(50);

  return getProfile();
}

/* -----------------------------------------------------------------------------
 * Member helpers
 * -------------------------------------------------------------------------- */

export function upsertMember(member, options = {}) {
  const m = normalizeMember(member);
  const opts = safeObj(options);

  return setProfile((prev) => {
    const members = safeArr(prev.members);
    const idx = members.findIndex((x) => x.id === m.id);
    const nextMembers =
      idx >= 0
        ? members.map((x) =>
            x.id === m.id ? { ...x, ...m, updatedAt: nowISO() } : x
          )
        : [...members, m];

    const primaryMemberId = prev.primaryMemberId || m.id;

    return { members: nextMembers, primaryMemberId };
  }, opts);
}

export function removeMember(memberId, options = {}) {
  const id = String(memberId || "").trim();
  if (!id) return getProfile();

  const opts = safeObj(options);

  return setProfile((prev) => {
    const members = safeArr(prev.members).filter((m) => m.id !== id);
    let primaryMemberId = prev.primaryMemberId;
    if (primaryMemberId === id) primaryMemberId = members[0]?.id || null;
    return { members, primaryMemberId };
  }, opts);
}

export function setPrimaryMember(memberId, options = {}) {
  const id = String(memberId || "").trim();
  if (!id) return getProfile();

  const opts = safeObj(options);
  return setProfile({ primaryMemberId: id }, opts);
}

/* -----------------------------------------------------------------------------
 * Convenience getters
 * -------------------------------------------------------------------------- */

export function getTimezone() {
  return getProfile().timezone;
}

export function getQuietHours() {
  return (
    getProfile().preferences?.quietHours ||
    DEFAULT_PROFILE.preferences.quietHours
  );
}

export function getSabbathPrefs() {
  const p = getProfile().preferences || DEFAULT_PROFILE.preferences;
  return {
    sabbathAware: p.sabbathAware !== false,
    quietHours: p.quietHours || DEFAULT_PROFILE.preferences.quietHours,
  };
}

/* -----------------------------------------------------------------------------
 * Auto-hydrate helper
 * -------------------------------------------------------------------------- */

let _autoHydrated = false;
export function ensureHydrated() {
  if (_autoHydrated) return;
  _autoHydrated = true;
  hydrate().catch(() => {});
}

/* -----------------------------------------------------------------------------
 * Default export facade
 * -------------------------------------------------------------------------- */

const HouseholdProfileStore = {
  // store basics
  getState,
  subscribe,
  hydrate,
  persistNow,
  reset,
  ensureHydrated,

  // profile
  getProfile,
  setProfile,

  // members
  upsertMember,
  removeMember,
  setPrimaryMember,

  // getters
  getTimezone,
  getQuietHours,
  getSabbathPrefs,
};

export default HouseholdProfileStore;
