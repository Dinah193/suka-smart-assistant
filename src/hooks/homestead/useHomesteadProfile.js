// C:\Users\larho\suka-smart-assistant\src\hooks\homestead\useHomesteadProfile.js

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * useHomesteadProfile
 * -----------------------------------------------------------------------------
 * Canonical hook for reading/writing a user's "homestead profile" used by:
 * - Homestead Planner (levels, start date, household size, goals)
 * - Estimators (food security, cost delta)
 * - Provisioning targets (garden/animals/storehouse)
 *
 * Design goals:
 * - Works even before Dexie schema is fully in place (localStorage fallback).
 * - Can later be upgraded to Dexie seamlessly by swapping the adapter.
 * - Stable API for UI components: { profile, setProfile, patchProfile, reset, status }
 *
 * Usage:
 * const { profile, patchProfile, setProfile, reset, status } = useHomesteadProfile();
 *
 * status:
 * - loading: boolean
 * - ready: boolean
 * - error: Error | null
 * - source: "dexie" | "local" | "default"
 *
 * Notes:
 * - This hook is intentionally dependency-light and does not require SSA eventBus.
 *   If you want event emissions, pass an `events` adapter.
 */

/** @typedef {"default"|"local"|"dexie"} HomesteadSource */
/** @typedef {"idle"|"loading"|"ready"|"error"} HomesteadPhase */

/**
 * @typedef {Object} HomesteadProfile
 * @property {string} schemaVersion
 * @property {string} updatedAt ISO timestamp
 * @property {Object} meta
 * @property {string} meta.id stable id (e.g. "homestead.profile")
 * @property {string} meta.type fixed "homestead_profile"
 * @property {string} meta.locale e.g. "en-US"
 * @property {string} meta.label display label
 * @property {string=} meta.description
 * @property {Object} household
 * @property {number} household.size household headcount
 * @property {Object=} household.diet optional preferences
 * @property {Object} homestead
 * @property {number} homestead.level 0..5 (or any scale you prefer)
 * @property {string=} homestead.startDate ISO date or timestamp
 * @property {string=} homestead.region optional; e.g. "US-South"
 * @property {Object=} homestead.focus optional focus flags
 * @property {Object} goals user goals
 * @property {string[]=} goals.primary e.g. ["food_security", "budget_reduction"]
 * @property {Object=} goals.targets numeric targets
 * @property {Object=} notes freeform notes (strings)
 */

/**
 * @typedef {Object} UseHomesteadProfileOptions
 * @property {string=} key localStorage key (default "ssa.homestead.profile")
 * @property {HomesteadProfile=} defaults custom default profile override
 * @property {Object=} adapter persistence adapter; defaults to localStorage adapter
 * @property {Object=} events optional events adapter with emit(name, payload)
 * @property {boolean=} autoSave if true, patch/set auto-saves (default true)
 * @property {number=} debounceMs debounce for autoSave (default 250)
 * @property {boolean=} migrate if true, run migrations on load/save (default true)
 */

/**
 * Persistence adapter interface (minimal).
 * - get(): Promise<HomesteadProfile|null>
 * - set(profile): Promise<void>
 * - clear(): Promise<void>
 * - source: "dexie"|"local"|"default"
 */

/* -----------------------------------------------------------------------------
   Public Hook
----------------------------------------------------------------------------- */

export function useHomesteadProfile(options = {}) {
  const {
    key = "ssa.homestead.profile",
    defaults = DEFAULT_PROFILE,
    adapter = createLocalStorageAdapter({ key }),
    events = null,
    autoSave = true,
    debounceMs = 250,
    migrate = true,
  } = options;

  const [phase, setPhase] = useState(/** @type {HomesteadPhase} */ ("idle"));
  const [error, setError] = useState(null);
  const [source, setSource] = useState(
    /** @type {HomesteadSource} */ ("default"),
  );
  const [profile, setProfileState] = useState(() => normalizeProfile(defaults));

  const saveTimerRef = useRef(/** @type {number|null} */ (null));
  const mountedRef = useRef(false);

  const status = useMemo(
    () => ({
      loading: phase === "loading",
      ready: phase === "ready",
      error,
      source,
      phase,
    }),
    [phase, error, source],
  );

  // Load once
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setPhase("loading");
      setError(null);

      try {
        const loaded = await safeAdapterGet(adapter);
        if (cancelled) return;

        if (loaded) {
          const next = migrate ? migrateProfile(loaded) : loaded;
          setProfileState(normalizeProfile(next));
          setSource(adapter.source || "local");
          setPhase("ready");
          emit(events, "homestead.profile.loaded", {
            source: adapter.source || "local",
            profile: next,
          });
        } else {
          const base = normalizeProfile(defaults);
          setProfileState(base);
          setSource(adapter.source || "default");
          setPhase("ready");
          emit(events, "homestead.profile.defaulted", {
            source: adapter.source || "default",
            profile: base,
          });
        }
      } catch (e) {
        if (cancelled) return;
        setError(e);
        setPhase("error");
      }
    }

    load();
    mountedRef.current = true;

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]); // key changes => new storage namespace; reload

  const persistNow = useCallback(
    async (nextProfile, meta = {}) => {
      const normalized = normalizeProfile(
        migrate ? migrateProfile(nextProfile) : nextProfile,
      );

      try {
        await safeAdapterSet(adapter, normalized);
        setSource(adapter.source || "local");
        emit(events, "homestead.profile.saved", {
          source: adapter.source || "local",
          profile: normalized,
          meta,
        });
        return { ok: true, profile: normalized };
      } catch (e) {
        setError(e);
        setPhase("error");
        emit(events, "homestead.profile.save_failed", {
          error: String(e?.message || e),
          meta,
        });
        return { ok: false, error: e };
      }
    },
    [adapter, events, migrate],
  );

  const queuePersist = useCallback(
    (nextProfile, meta = {}) => {
      if (!autoSave) return;

      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      saveTimerRef.current = window.setTimeout(
        () => {
          saveTimerRef.current = null;
          // fire and forget; errors captured in state
          persistNow(nextProfile, meta);
        },
        Math.max(0, debounceMs),
      );
    },
    [autoSave, debounceMs, persistNow],
  );

  const setProfile = useCallback(
    (nextProfile, meta = {}) => {
      const normalized = normalizeProfile(
        migrate ? migrateProfile(nextProfile) : nextProfile,
      );
      setProfileState(normalized);
      setPhase((p) => (p === "idle" ? "ready" : p));
      emit(events, "homestead.profile.changed", { profile: normalized, meta });
      queuePersist(normalized, { action: "set", ...meta });
      return normalized;
    },
    [events, migrate, queuePersist],
  );

  const patchProfile = useCallback(
    (patch, meta = {}) => {
      setProfileState((prev) => {
        const merged = deepMerge(prev, patch || {});
        const normalized = normalizeProfile(
          migrate ? migrateProfile(merged) : merged,
        );
        emit(events, "homestead.profile.changed", {
          profile: normalized,
          meta,
        });
        queuePersist(normalized, { action: "patch", ...meta });
        return normalized;
      });
    },
    [events, migrate, queuePersist],
  );

  const reset = useCallback(
    async (meta = {}) => {
      const base = normalizeProfile(defaults);
      setProfileState(base);
      setPhase("ready");
      setError(null);

      try {
        await safeAdapterClear(adapter);
        setSource(adapter.source || "local");
        emit(events, "homestead.profile.reset", { profile: base, meta });
      } catch (e) {
        setError(e);
        setPhase("error");
      }
      return base;
    },
    [adapter, defaults, events],
  );

  // Helpers for common fields (optional ergonomic sugar)
  const setHomesteadLevel = useCallback(
    (level, meta = {}) => {
      const n = clampNumber(level, 0, 10); // allow 0..10 by default
      patchProfile(
        { homestead: { level: n } },
        { field: "homestead.level", ...meta },
      );
    },
    [patchProfile],
  );

  const setHouseholdSize = useCallback(
    (size, meta = {}) => {
      const n = clampNumber(size, 1, 50);
      patchProfile(
        { household: { size: n } },
        { field: "household.size", ...meta },
      );
    },
    [patchProfile],
  );

  const api = useMemo(
    () => ({
      profile,
      setProfile,
      patchProfile,
      reset,
      status,
      persistNow, // exposed for "Save" buttons or explicit workflows
      // ergonomic setters
      setHomesteadLevel,
      setHouseholdSize,
    }),
    [
      profile,
      setProfile,
      patchProfile,
      reset,
      status,
      persistNow,
      setHomesteadLevel,
      setHouseholdSize,
    ],
  );

  return api;
}

/* -----------------------------------------------------------------------------
   Defaults
----------------------------------------------------------------------------- */

const DEFAULT_PROFILE = normalizeProfile({
  schemaVersion: "1.0.0",
  updatedAt: new Date(0).toISOString(),
  meta: {
    id: "homestead.profile",
    type: "homestead_profile",
    locale: "en-US",
    label: "Homestead Profile",
    description:
      "Baseline household + homesteading preferences used by planners and estimators.",
  },
  household: {
    size: 4,
    diet: {
      // optional structure; safe defaults
      preferences: [],
      restrictions: [],
    },
  },
  homestead: {
    level: 0, // 0 = not homesteading yet
    startDate: null, // ISO date or timestamp
    region: null,
    focus: {
      garden: false,
      animals: false,
      preservation: false,
      scratchCooking: true,
    },
  },
  goals: {
    primary: ["food_security", "budget_reduction"],
    targets: {
      // Example: "coverageDays": 30, "monthlySavings": 250
    },
  },
  notes: {},
});

/* -----------------------------------------------------------------------------
   Adapter: localStorage (default)
----------------------------------------------------------------------------- */

function createLocalStorageAdapter({ key }) {
  return {
    source: /** @type {HomesteadSource} */ ("local"),
    async get() {
      try {
        const raw = window?.localStorage?.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        return parsed;
      } catch {
        return null;
      }
    },
    async set(profile) {
      const text = JSON.stringify(profile);
      window?.localStorage?.setItem(key, text);
    },
    async clear() {
      window?.localStorage?.removeItem(key);
    },
  };
}

/* -----------------------------------------------------------------------------
   Optional Dexie Adapter (drop-in)
-----------------------------------------------------------------------------
   If/when you add a Dexie table like `homesteadProfiles` with a stable key:
   - Provide adapter = createDexieHomesteadAdapter({ db, id: "homestead.profile" })
----------------------------------------------------------------------------- */

export function createDexieHomesteadAdapter({
  db,
  id = "homestead.profile",
  table = "homesteadProfiles",
}) {
  if (!db)
    throw new Error(
      "createDexieHomesteadAdapter requires a Dexie db instance.",
    );
  return {
    source: /** @type {HomesteadSource} */ ("dexie"),
    async get() {
      // expects { id, ...profile }
      const row = await db[table].get(id);
      return row ? stripDexieRow(row) : null;
    },
    async set(profile) {
      const row = { id, ...profile, updatedAt: new Date().toISOString() };
      await db[table].put(row);
    },
    async clear() {
      await db[table].delete(id);
    },
  };
}

function stripDexieRow(row) {
  if (!row || typeof row !== "object") return row;
  // Remove Dexie primary key duplicate if present (we store it anyway as meta.id)
  const { id, ...rest } = row;
  return rest?.meta?.id
    ? rest
    : { ...rest, meta: { ...(rest.meta || {}), id } };
}

/* -----------------------------------------------------------------------------
   Migrations (lightweight)
----------------------------------------------------------------------------- */

function migrateProfile(p) {
  // Migrations should be additive and non-breaking.
  const base = normalizeProfile(p);

  // Example migration hooks:
  // - Ensure meta.type exists
  // - Ensure household.size exists
  // - Ensure homestead.level exists
  // - Ensure goals.primary is array
  // - Ensure timestamps are valid ISO strings
  const next = { ...base };

  next.schemaVersion =
    typeof next.schemaVersion === "string" ? next.schemaVersion : "1.0.0";
  next.meta = {
    id: next.meta?.id || "homestead.profile",
    type: next.meta?.type || "homestead_profile",
    locale: next.meta?.locale || "en-US",
    label: next.meta?.label || "Homestead Profile",
    description:
      next.meta?.description ||
      "Baseline household + homesteading preferences used by planners and estimators.",
    ...(next.meta || {}),
  };

  next.household = {
    size: clampNumber(next.household?.size ?? 4, 1, 50),
    diet: {
      preferences: arrayify(next.household?.diet?.preferences),
      restrictions: arrayify(next.household?.diet?.restrictions),
      ...(next.household?.diet || {}),
    },
    ...(next.household || {}),
  };

  next.homestead = {
    level: clampNumber(next.homestead?.level ?? 0, 0, 10),
    startDate: normalizeNullableDate(next.homestead?.startDate),
    region: next.homestead?.region ?? null,
    focus: {
      garden: Boolean(next.homestead?.focus?.garden),
      animals: Boolean(next.homestead?.focus?.animals),
      preservation: Boolean(next.homestead?.focus?.preservation),
      scratchCooking: next.homestead?.focus?.scratchCooking !== false,
      ...(next.homestead?.focus || {}),
    },
    ...(next.homestead || {}),
  };

  next.goals = {
    primary: arrayify(
      next.goals?.primary ?? ["food_security", "budget_reduction"],
    ),
    targets:
      next.goals?.targets && typeof next.goals.targets === "object"
        ? next.goals.targets
        : {},
    ...(next.goals || {}),
  };

  next.notes = next.notes && typeof next.notes === "object" ? next.notes : {};

  next.updatedAt = normalizeIsoNow(next.updatedAt);

  return next;
}

/* -----------------------------------------------------------------------------
   Safe adapter wrappers
----------------------------------------------------------------------------- */

async function safeAdapterGet(adapter) {
  if (!adapter || typeof adapter.get !== "function") return null;
  return adapter.get();
}
async function safeAdapterSet(adapter, profile) {
  if (!adapter || typeof adapter.set !== "function") return;
  return adapter.set(profile);
}
async function safeAdapterClear(adapter) {
  if (!adapter || typeof adapter.clear !== "function") return;
  return adapter.clear();
}

function emit(events, name, payload) {
  try {
    if (!events || typeof events.emit !== "function") return;
    events.emit(name, payload);
  } catch {
    // no-op
  }
}

/* -----------------------------------------------------------------------------
   Normalization utils
----------------------------------------------------------------------------- */

function normalizeProfile(p) {
  const nowIso = new Date().toISOString();
  const obj = p && typeof p === "object" ? p : {};

  // Keep it permissive; migrations will tighten
  return {
    schemaVersion:
      typeof obj.schemaVersion === "string" ? obj.schemaVersion : "1.0.0",
    updatedAt: normalizeIsoNow(obj.updatedAt || nowIso),
    meta: {
      id: obj?.meta?.id || "homestead.profile",
      type: obj?.meta?.type || "homestead_profile",
      locale: obj?.meta?.locale || "en-US",
      label: obj?.meta?.label || "Homestead Profile",
      description:
        obj?.meta?.description ||
        "Baseline household + homesteading preferences used by planners and estimators.",
      ...(obj.meta || {}),
    },
    household: {
      size: clampNumber(obj?.household?.size ?? 4, 1, 50),
      diet: {
        ...(obj?.household?.diet || {}),
        preferences: arrayify(obj?.household?.diet?.preferences),
        restrictions: arrayify(obj?.household?.diet?.restrictions),
      },
      ...(obj.household || {}),
    },
    homestead: {
      level: clampNumber(obj?.homestead?.level ?? 0, 0, 10),
      startDate: normalizeNullableDate(obj?.homestead?.startDate),
      region: obj?.homestead?.region ?? null,
      focus: {
        garden: Boolean(obj?.homestead?.focus?.garden),
        animals: Boolean(obj?.homestead?.focus?.animals),
        preservation: Boolean(obj?.homestead?.focus?.preservation),
        scratchCooking: obj?.homestead?.focus?.scratchCooking !== false,
        ...(obj?.homestead?.focus || {}),
      },
      ...(obj.homestead || {}),
    },
    goals: {
      primary: arrayify(
        obj?.goals?.primary ?? ["food_security", "budget_reduction"],
      ),
      targets:
        obj?.goals?.targets && typeof obj.goals.targets === "object"
          ? obj.goals.targets
          : {},
      ...(obj.goals || {}),
    },
    notes: obj?.notes && typeof obj.notes === "object" ? obj.notes : {},
  };
}

function normalizeIsoNow(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function normalizeNullableDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Use date-only if input looks like date-only; otherwise full ISO.
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return d.toISOString();
}

function arrayify(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v))
    return v.filter((x) => x !== null && x !== undefined).map(String);
  return [String(v)];
}

function clampNumber(v, min, max) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * Deep merge for plain objects (no arrays merging; arrays replaced).
 * - Keeps SSA usage predictable for patches.
 */
function deepMerge(base, patch) {
  const a = base && typeof base === "object" ? base : {};
  const b = patch && typeof patch === "object" ? patch : {};

  if (Array.isArray(a) || Array.isArray(b)) return b;

  const out = { ...a };
  for (const k of Object.keys(b)) {
    const av = a[k];
    const bv = b[k];

    if (
      bv &&
      typeof bv === "object" &&
      !Array.isArray(bv) &&
      av &&
      typeof av === "object" &&
      !Array.isArray(av)
    ) {
      out[k] = deepMerge(av, bv);
    } else {
      out[k] = bv;
    }
  }

  // Update timestamp if anything changes at root
  out.updatedAt = new Date().toISOString();
  return out;
}
