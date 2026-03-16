// C:\Users\larho\suka-smart-assistant\src\hooks\estimators\useEstimatorBaselines.js

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHomesteadProfile } from "../homestead/useHomesteadProfile";
import { useHomesteadVisibility } from "../homestead/useHomesteadVisibility";

/**
 * useEstimatorBaselines
 * -----------------------------------------------------------------------------
 * Central hook for managing deterministic baseline assumptions used by SSA
 * estimators (Food Security + Cost Delta).
 *
 * Why this exists:
 * - Estimators need defaults so users can get value immediately (no setup).
 * - Users may later customize baselines (meals/day, servings, waste, grocery
 *   spend) for more accurate estimates.
 * - We want a single place to read/write those baselines consistently.
 *
 * Storage strategy:
 * - Default: localStorage (works without Dexie).
 * - Optional: supply adapter (Dexie) to persist.
 *
 * Visibility strategy:
 * - Baseline settings UI should usually be visible only when:
 *   homestead is enabled (level > 0) and the user is in homestead context.
 *
 * API:
 * const base = useEstimatorBaselines({ key, adapter, context });
 *
 * base.baselines              // current baseline object
 * base.status                 // loading/ready/error + source
 * base.patchBaselines(patch)  // deep merge patch + autosave
 * base.setBaselines(next)     // replace + autosave
 * base.resetBaselines()       // clear persisted + revert to defaults
 * base.exportBaselines()      // JSON string (safe)
 * base.importBaselines(json)  // validate+apply
 *
 * base.visibility             // homestead visibility object (gate UI)
 * base.shouldShowBaselinesUI  // recommended UI gate
 *
 * -----------------------------------------------------------------------------
 * Schema (lightweight, not enforced by JSON schema file yet):
 * {
 *   schemaVersion: "1.0.0",
 *   updatedAt: ISO,
 *   meta: { id, type, locale, label },
 *   foodSecurity: {
 *     mealsPerDay,
 *     servingsPerMealPerPerson,
 *     wasteFactor,
 *     unknownItemServingsFallback
 *   },
 *   costDelta: {
 *     weeklyMealsFallback,
 *     baselineConvenienceMultiplier,
 *     scratchEfficiencyMultiplier,
 *     offsetAffectsBaseline
 *   },
 *   pricing: {
 *     currency, region, defaultUnitSystem
 *   }
 * }
 */

/**
 * @typedef {Object} UseEstimatorBaselinesOptions
 * @property {string=} key localStorage key (default "ssa.estimators.baselines")
 * @property {Object=} adapter persistence adapter (Dexie etc.)
 * @property {Object=} events optional { emit(name,payload) }
 * @property {Object=} defaults override default baselines
 * @property {boolean=} autoSave (default true)
 * @property {number=} debounceMs (default 250)
 * @property {Object=} context visibility context (mode, screen, route)
 * @property {Object=} profileOptions forwarded to useHomesteadProfile
 * @property {Object=} visibilityOptions forwarded to useHomesteadVisibility
 * @property {boolean=} gatedUI if true, compute shouldShowBaselinesUI (default true)
 */

export function useEstimatorBaselines(options = {}) {
  const {
    key = "ssa.estimators.baselines",
    adapter = createLocalStorageAdapter({ key }),
    events = null,

    defaults = DEFAULT_BASELINES,

    autoSave = true,
    debounceMs = 250,

    context = null,
    profileOptions = undefined,
    visibilityOptions = undefined,
    gatedUI = true,
  } = options;

  const { profile, status: profileStatus } = useHomesteadProfile(
    profileOptions || {},
  );
  const vis = useHomesteadVisibility({
    context,
    ...(visibilityOptions || {}),
    profileOptions:
      profileOptions ||
      (visibilityOptions ? visibilityOptions.profileOptions : undefined),
  });

  const [phase, setPhase] = useState("idle"); // idle|loading|ready|error
  const [error, setError] = useState(null);
  const [source, setSource] = useState(adapter?.source || "local");
  const [baselines, setBaselinesState] = useState(() =>
    normalizeBaselines(defaults),
  );

  const saveTimerRef = useRef(null);

  const status = useMemo(
    () => ({
      loading: phase === "loading",
      ready: phase === "ready",
      error,
      phase,
      source,
      profileSource: profileStatus?.source || "default",
    }),
    [phase, error, source, profileStatus?.source],
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
          const next = migrateBaselines(loaded);
          setBaselinesState(next);
          setSource(adapter.source || "local");
          setPhase("ready");
          emit(events, "estimators.baselines.loaded", {
            source: adapter.source || "local",
            baselines: next,
          });
        } else {
          const base = normalizeBaselines(defaults);
          setBaselinesState(base);
          setSource(adapter.source || "default");
          setPhase("ready");
          emit(events, "estimators.baselines.defaulted", {
            source: adapter.source || "default",
            baselines: base,
          });
        }
      } catch (e) {
        if (cancelled) return;
        setError(e);
        setPhase("error");
      }
    }

    load();

    return () => {
      cancelled = true;
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const persistNow = useCallback(
    async (nextBaselines, meta = {}) => {
      const normalized = normalizeBaselines(migrateBaselines(nextBaselines));

      try {
        await safeAdapterSet(adapter, normalized);
        setSource(adapter.source || "local");
        emit(events, "estimators.baselines.saved", {
          baselines: normalized,
          meta,
          source: adapter.source || "local",
        });
        return { ok: true, baselines: normalized };
      } catch (e) {
        setError(e);
        setPhase("error");
        emit(events, "estimators.baselines.save_failed", {
          error: String(e?.message || e),
          meta,
        });
        return { ok: false, error: e };
      }
    },
    [adapter, events],
  );

  const queuePersist = useCallback(
    (nextBaselines, meta = {}) => {
      if (!autoSave) return;

      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      saveTimerRef.current = window.setTimeout(
        () => {
          saveTimerRef.current = null;
          persistNow(nextBaselines, meta);
        },
        Math.max(0, debounceMs),
      );
    },
    [autoSave, debounceMs, persistNow],
  );

  const setBaselines = useCallback(
    (next, meta = {}) => {
      const normalized = normalizeBaselines(migrateBaselines(next));
      setBaselinesState(normalized);
      setPhase((p) => (p === "idle" ? "ready" : p));
      emit(events, "estimators.baselines.changed", {
        baselines: normalized,
        meta,
      });
      queuePersist(normalized, { action: "set", ...meta });
      return normalized;
    },
    [events, queuePersist],
  );

  const patchBaselines = useCallback(
    (patch, meta = {}) => {
      setBaselinesState((prev) => {
        const merged = deepMerge(prev, patch || {});
        const normalized = normalizeBaselines(migrateBaselines(merged));
        emit(events, "estimators.baselines.changed", {
          baselines: normalized,
          meta,
        });
        queuePersist(normalized, { action: "patch", ...meta });
        return normalized;
      });
    },
    [events, queuePersist],
  );

  const resetBaselines = useCallback(
    async (meta = {}) => {
      const base = normalizeBaselines(defaults);
      setBaselinesState(base);
      setPhase("ready");
      setError(null);

      try {
        await safeAdapterClear(adapter);
        setSource(adapter.source || "local");
        emit(events, "estimators.baselines.reset", { baselines: base, meta });
      } catch (e) {
        setError(e);
        setPhase("error");
      }
      return base;
    },
    [adapter, defaults, events],
  );

  const exportBaselines = useCallback(() => {
    const safe = normalizeBaselines(baselines);
    return JSON.stringify(safe, null, 2);
  }, [baselines]);

  const importBaselines = useCallback(
    (jsonString, meta = {}) => {
      const parsed = safeParseJson(jsonString);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }

      const candidate = parsed.value;
      const validated = validateBaselines(candidate);
      if (!validated.ok) {
        return { ok: false, error: validated.error };
      }

      const next = setBaselines(candidate, { action: "import", ...meta });
      return { ok: true, baselines: next };
    },
    [setBaselines],
  );

  // Convenience selectors for estimator hooks (so they can do: base.foodSecurity.mealsPerDay, etc.)
  const foodSecurity = useMemo(
    () => baselines.foodSecurity,
    [baselines.foodSecurity],
  );
  const costDelta = useMemo(() => baselines.costDelta, [baselines.costDelta]);
  const pricing = useMemo(() => baselines.pricing, [baselines.pricing]);

  // UI gate: show only in homestead mode, and preferably in homestead planner context.
  const shouldShowBaselinesUI = useMemo(() => {
    if (!gatedUI) return true;

    const level = clampNumber(profile?.homestead?.level ?? 0, 0, 10);
    if (level <= 0) return false;
    if (!vis.enabled) return false;

    // Show in homestead planner; optionally also show in estimator drawer on meal planner.
    return vis.mode === "homestead_planner" || vis.showEstimatorPanels;
  }, [
    gatedUI,
    profile?.homestead?.level,
    vis.enabled,
    vis.mode,
    vis.showEstimatorPanels,
  ]);

  return useMemo(
    () => ({
      baselines,
      foodSecurity,
      costDelta,
      pricing,

      status,
      visibility: vis,
      shouldShowBaselinesUI,

      setBaselines,
      patchBaselines,
      resetBaselines,

      exportBaselines,
      importBaselines,

      // low-level access for advanced workflows
      persistNow,
    }),
    [
      baselines,
      foodSecurity,
      costDelta,
      pricing,
      status,
      vis,
      shouldShowBaselinesUI,
      setBaselines,
      patchBaselines,
      resetBaselines,
      exportBaselines,
      importBaselines,
      persistNow,
    ],
  );
}

/* =============================================================================
   Defaults
============================================================================= */

const DEFAULT_BASELINES = normalizeBaselines({
  schemaVersion: "1.0.0",
  updatedAt: new Date(0).toISOString(),
  meta: {
    id: "estimators.baselines",
    type: "estimators_baselines",
    locale: "en-US",
    label: "Estimator Baselines",
    description: "Deterministic baseline assumptions used by SSA estimators.",
  },
  foodSecurity: {
    mealsPerDay: 2,
    servingsPerMealPerPerson: 1,
    wasteFactor: 0.08,
    unknownItemServingsFallback: 0,
  },
  costDelta: {
    weeklyMealsFallback: 10,
    baselineConvenienceMultiplier: 1.18,
    scratchEfficiencyMultiplier: 0.92,
    offsetAffectsBaseline: 0.45,
  },
  pricing: {
    currency: "USD",
    region: "US",
    defaultUnitSystem: "us_customary",
  },
});

/* =============================================================================
   Adapter: localStorage (default)
============================================================================= */

function createLocalStorageAdapter({ key }) {
  return {
    source: "local",
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
    async set(obj) {
      const text = JSON.stringify(obj);
      window?.localStorage?.setItem(key, text);
    },
    async clear() {
      window?.localStorage?.removeItem(key);
    },
  };
}

/* =============================================================================
   Optional Dexie Adapter (drop-in)
============================================================================= */

export function createDexieEstimatorBaselinesAdapter({
  db,
  id = "estimators.baselines",
  table = "estimatorBaselines",
}) {
  if (!db)
    throw new Error(
      "createDexieEstimatorBaselinesAdapter requires a Dexie db instance.",
    );
  return {
    source: "dexie",
    async get() {
      const row = await db[table].get(id);
      return row ? stripDexieRow(row) : null;
    },
    async set(baselines) {
      const row = { id, ...baselines, updatedAt: new Date().toISOString() };
      await db[table].put(row);
    },
    async clear() {
      await db[table].delete(id);
    },
  };
}

function stripDexieRow(row) {
  if (!row || typeof row !== "object") return row;
  const { id, ...rest } = row;
  return rest?.meta?.id
    ? rest
    : { ...rest, meta: { ...(rest.meta || {}), id } };
}

/* =============================================================================
   Migrations + Validation
============================================================================= */

function migrateBaselines(b) {
  const base = normalizeBaselines(b);

  // Additive migration safety
  base.schemaVersion =
    typeof base.schemaVersion === "string" ? base.schemaVersion : "1.0.0";
  base.meta = {
    id: base.meta?.id || "estimators.baselines",
    type: base.meta?.type || "estimators_baselines",
    locale: base.meta?.locale || "en-US",
    label: base.meta?.label || "Estimator Baselines",
    description:
      base.meta?.description ||
      "Deterministic baseline assumptions used by SSA estimators.",
    ...(base.meta || {}),
  };

  base.foodSecurity = {
    mealsPerDay: clampNumber(base.foodSecurity?.mealsPerDay ?? 2, 1, 6),
    servingsPerMealPerPerson: clampNumber(
      base.foodSecurity?.servingsPerMealPerPerson ?? 1,
      0.5,
      4,
    ),
    wasteFactor: clampNumber(base.foodSecurity?.wasteFactor ?? 0.08, 0, 0.5),
    unknownItemServingsFallback: clampNumber(
      base.foodSecurity?.unknownItemServingsFallback ?? 0,
      0,
      100,
    ),
    ...(base.foodSecurity || {}),
  };

  base.costDelta = {
    weeklyMealsFallback: clampNumber(
      base.costDelta?.weeklyMealsFallback ?? 10,
      1,
      28,
    ),
    baselineConvenienceMultiplier: clampNumber(
      base.costDelta?.baselineConvenienceMultiplier ?? 1.18,
      1,
      2,
    ),
    scratchEfficiencyMultiplier: clampNumber(
      base.costDelta?.scratchEfficiencyMultiplier ?? 0.92,
      0.6,
      1.2,
    ),
    offsetAffectsBaseline: clampNumber(
      base.costDelta?.offsetAffectsBaseline ?? 0.45,
      0,
      1,
    ),
    ...(base.costDelta || {}),
  };

  base.pricing = {
    currency: String(base.pricing?.currency || "USD"),
    region: String(base.pricing?.region || "US"),
    defaultUnitSystem: String(
      base.pricing?.defaultUnitSystem || "us_customary",
    ),
    ...(base.pricing || {}),
  };

  base.updatedAt = normalizeIsoNow(base.updatedAt);

  return base;
}

function validateBaselines(candidate) {
  try {
    const b = normalizeBaselines(candidate);
    if (!b.meta?.id) return { ok: false, error: new Error("Missing meta.id") };
    if (!b.foodSecurity)
      return { ok: false, error: new Error("Missing foodSecurity") };
    if (!b.costDelta)
      return { ok: false, error: new Error("Missing costDelta") };
    return { ok: true, baselines: b };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/* =============================================================================
   Safe adapter wrappers
============================================================================= */

async function safeAdapterGet(adapter) {
  if (!adapter || typeof adapter.get !== "function") return null;
  return adapter.get();
}
async function safeAdapterSet(adapter, obj) {
  if (!adapter || typeof adapter.set !== "function") return;
  return adapter.set(obj);
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

/* =============================================================================
   Normalization + Merge utils
============================================================================= */

function normalizeBaselines(b) {
  const nowIso = new Date().toISOString();
  const obj = b && typeof b === "object" ? b : {};

  return {
    schemaVersion:
      typeof obj.schemaVersion === "string" ? obj.schemaVersion : "1.0.0",
    updatedAt: normalizeIsoNow(obj.updatedAt || nowIso),
    meta: {
      id: obj?.meta?.id || "estimators.baselines",
      type: obj?.meta?.type || "estimators_baselines",
      locale: obj?.meta?.locale || "en-US",
      label: obj?.meta?.label || "Estimator Baselines",
      description:
        obj?.meta?.description ||
        "Deterministic baseline assumptions used by SSA estimators.",
      ...(obj.meta || {}),
    },
    foodSecurity: {
      mealsPerDay: clampNumber(obj?.foodSecurity?.mealsPerDay ?? 2, 1, 6),
      servingsPerMealPerPerson: clampNumber(
        obj?.foodSecurity?.servingsPerMealPerPerson ?? 1,
        0.5,
        4,
      ),
      wasteFactor: clampNumber(obj?.foodSecurity?.wasteFactor ?? 0.08, 0, 0.5),
      unknownItemServingsFallback: clampNumber(
        obj?.foodSecurity?.unknownItemServingsFallback ?? 0,
        0,
        100,
      ),
      ...(obj.foodSecurity || {}),
    },
    costDelta: {
      weeklyMealsFallback: clampNumber(
        obj?.costDelta?.weeklyMealsFallback ?? 10,
        1,
        28,
      ),
      baselineConvenienceMultiplier: clampNumber(
        obj?.costDelta?.baselineConvenienceMultiplier ?? 1.18,
        1,
        2,
      ),
      scratchEfficiencyMultiplier: clampNumber(
        obj?.costDelta?.scratchEfficiencyMultiplier ?? 0.92,
        0.6,
        1.2,
      ),
      offsetAffectsBaseline: clampNumber(
        obj?.costDelta?.offsetAffectsBaseline ?? 0.45,
        0,
        1,
      ),
      ...(obj.costDelta || {}),
    },
    pricing: {
      currency: String(obj?.pricing?.currency || "USD"),
      region: String(obj?.pricing?.region || "US"),
      defaultUnitSystem: String(
        obj?.pricing?.defaultUnitSystem || "us_customary",
      ),
      ...(obj.pricing || {}),
    },
  };
}

/**
 * Deep merge for plain objects (arrays replaced, not merged).
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

  out.updatedAt = new Date().toISOString();
  return out;
}

function normalizeIsoNow(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function clampNumber(v, min, max) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeParseJson(text) {
  try {
    const value = JSON.parse(String(text || ""));
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e };
  }
}
