// src/hooks/useMealPrefs.js
/**
 * useMealPrefs
 * -----------------------------------------------------------------------------
 * React-friendly wrapper around MealPrefsStore with agent-ready helpers.
 *
 * What’s new (backward compatible):
 *  - Status meta: loading/error/dirty/hydrated/persisted/version/source/lastUpdated
 *  - Primary setter setPrefs(partial | updater) + tolerant deep merge
 *  - Quick selectors: pick(), get(), toQuery() for agent calls (meal plan, batch)
 *  - Higher-level actions: reset(kind), loadDefaults(), persistNow(), applyTemplate()
 *  - Validate() for guardrails; subscribe() for non-React consumers
 *  - Still exposes derived values you already use (portions, sabbathAware, nextBatchSessionISO)
 */

import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  useCallback,
} from "react";
import MealPrefsStore from "../store/MealPrefsStore";

/* ----------------------------------------------------------------------------
 * Init (safe once) — supports server baseUrl, sockets, and user-scoped prefs
 * --------------------------------------------------------------------------*/
function useMealPrefsInit({
  baseUrl = null,
  socketIO = null,
  user = null,
  autoInit = true,
} = {}) {
  const didInitRef = useRef(false);

  useEffect(() => {
    if (!autoInit || didInitRef.current) return;
    didInitRef.current = true;

    (async () => {
      try {
        if (MealPrefsStore?.init) {
          await MealPrefsStore.init({ baseUrl, socketIO, user });
        }
      } catch {
        // Non-fatal; keep working with local defaults.
      }
    })();

    // We don’t destroy the singleton by default on unmount; other modules may use it.
  }, [baseUrl, socketIO, user, autoInit]);
}

/* ----------------------------------------------------------------------------
 * Utilities
 * --------------------------------------------------------------------------*/
const isFn = (v) => typeof v === "function";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Deep merge that concatenates arrays instead of replacing them (agent-tolerant). */
function mergeDeepConcatArrays(target, patch) {
  if (!isObj(target) || !isObj(patch)) return patch;
  const out = { ...target };
  for (const k of Object.keys(patch)) {
    const a = target[k];
    const b = patch[k];
    if (Array.isArray(a) && Array.isArray(b)) {
      out[k] = [...a, ...b];
    } else if (isObj(a) && isObj(b)) {
      out[k] = mergeDeepConcatArrays(a, b);
    } else {
      out[k] = b;
    }
  }
  return out;
}

/** Safe getters off store with fallbacks so UI never crashes. */
function safeStore(fn, fallback) {
  try {
    const val = fn?.();
    return val == null ? fallback : val;
  } catch {
    return fallback;
  }
}

/* ----------------------------------------------------------------------------
 * Main hook
 * --------------------------------------------------------------------------*/
export function useMealPrefs(opts = {}) {
  useMealPrefsInit(opts);

  // --- subscription & snapshot
  const subscribe = useCallback((cb) => MealPrefsStore.subscribe(cb), []);
  const getSnapshot = useCallback(() => MealPrefsStore.getState(), []);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Canonical "prefs" object (support legacy shape where state === prefs)
  const prefs = useMemo(() => {
    // If state has a `prefs` field, prefer it; else treat state as prefs.
    return state?.prefs ? state.prefs : state || {};
  }, [state]);

  // --- status/meta (robust to missing fields)
  const loading = Boolean(
    state?.loading ??
      state?.status?.loading ??
      safeStore(() => MealPrefsStore.isLoading(), false)
  );
  const error =
    state?.error ??
    state?.status?.error ??
    safeStore(() => MealPrefsStore.getLastError?.(), null);

  const dirty = Boolean(
    state?.dirty ??
      state?.status?.dirty ??
      safeStore(() => MealPrefsStore.isDirty?.(), false)
  );
  const hydrated = Boolean(
    state?.hydrated ??
      state?.status?.hydrated ??
      safeStore(() => MealPrefsStore.isHydrated?.(), true)
  );
  const persisted = Boolean(
    state?.persisted ??
      state?.status?.persisted ??
      safeStore(() => MealPrefsStore.wasPersisted?.(), false)
  );
  const version =
    state?.version ??
    state?.status?.version ??
    safeStore(() => MealPrefsStore.getVersion?.(), 1);
  const source =
    state?.source ??
    state?.status?.source ??
    safeStore(() => MealPrefsStore.getSource?.(), "local");
  const lastUpdated =
    state?.lastUpdated ??
    state?.status?.lastUpdated ??
    safeStore(() => MealPrefsStore.getLastUpdated?.(), null);

  // --- derived (existing helpers preserved)
  const portions = useMemo(
    () => safeStore(() => MealPrefsStore.effectivePortions(), null),
    [state]
  );
  const sabbathAware = useMemo(
    () => safeStore(() => MealPrefsStore.sabbathAware(), false),
    [state]
  );
  const nextBatchSessionISO = useMemo(
    () => safeStore(() => MealPrefsStore.nextBatchSessionDate(), null),
    [state]
  );

  // --- base actions (stable)
  const setPath = useCallback(
    (path, value, extra) => MealPrefsStore.set(path, value, extra),
    []
  );
  const patch = useCallback(
    (obj, extra) => MealPrefsStore.patch(obj, extra),
    []
  );
  const resetSection = useCallback(
    (section = null, extra) => MealPrefsStore.reset(section, extra),
    []
  );

  // --- primary API expected by UI/agents
  const setPrefs = useCallback(
    (next) => {
      const current = prefs;
      const patchObj = isFn(next) ? next(current) : next || {};
      // Prefer store.merge if available (so it can handle schema/validation)
      if (MealPrefsStore.merge) {
        return MealPrefsStore.merge(patchObj);
      }
      // fallback: deep merge with array concatenation (tolerant)
      const merged = mergeDeepConcatArrays(current, patchObj);
      return MealPrefsStore.replace
        ? MealPrefsStore.replace(merged)
        : MealPrefsStore.patch(merged);
    },
    [prefs]
  );

  // tolerant merge helper (does NOT replace arrays)
  const merge = useCallback(
    (next) => {
      if (MealPrefsStore.merge) return MealPrefsStore.merge(next);
      const merged = mergeDeepConcatArrays(prefs, next || {});
      return MealPrefsStore.replace
        ? MealPrefsStore.replace(merged)
        : MealPrefsStore.patch(merged);
    },
    [prefs]
  );

  // Higher-level resets aligned with your flows
  const reset = useCallback(
    (kind = "soft") => {
      // Delegate if store knows about kinds:
      if (MealPrefsStore.resetKind) return MealPrefsStore.resetKind(kind);
      switch (kind) {
        case "factory":
          return MealPrefsStore.loadFactoryDefaults
            ? MealPrefsStore.loadFactoryDefaults()
            : resetSection(null, { factory: true });
        case "hard":
          return MealPrefsStore.loadProfileDefaults
            ? MealPrefsStore.loadProfileDefaults()
            : resetSection(null, { hard: true });
        case "soft":
        default:
          // Keep identity/macros, clear transient filters
          if (MealPrefsStore.resetSoft) return MealPrefsStore.resetSoft();
          return resetSection("transient", { soft: true });
      }
    },
    [resetSection]
  );

  const loadDefaults = useCallback((profileKey = null) => {
    if (MealPrefsStore.loadDefaults)
      return MealPrefsStore.loadDefaults(profileKey);
    if (MealPrefsStore.loadProfileDefaults)
      return MealPrefsStore.loadProfileDefaults(profileKey);
    return undefined;
  }, []);

  const persistNow = useCallback(async () => {
    if (MealPrefsStore.persist) return MealPrefsStore.persist();
    if (MealPrefsStore.save) return MealPrefsStore.save();
    return undefined;
  }, []);

  const applyTemplate = useCallback(
    (templateId, overrides = {}) => {
      if (MealPrefsStore.applyTemplate) {
        return MealPrefsStore.applyTemplate(templateId, overrides);
      }
      // Fallback: naive patch with overrides—assumes templates already expanded elsewhere.
      return merge(overrides);
    },
    [merge]
  );

  const validate = useCallback(() => {
    if (MealPrefsStore.validate) return MealPrefsStore.validate();
    return { ok: true, issues: [] };
  }, []);

  // Non-React consumers (e.g., agents, workers) may want to subscribe directly.
  const subscribeExternal = useCallback((listener) => {
    if (!isFn(listener)) return () => {};
    return MealPrefsStore.subscribe(() =>
      listener(MealPrefsStore.getState()?.prefs ?? MealPrefsStore.getState())
    );
  }, []);

  // --- convenience setters you already expose
  const setDefaultPortions = useCallback(
    (n) => setPath("meals.portions.default", Number(n)),
    [setPath]
  );
  const setBatchEnabled = useCallback(
    (enabled) => setPath("meals.batchCooking.enabled", !!enabled),
    [setPath]
  );
  const setBatchSessionDay = useCallback(
    (day) => setPath("meals.batchCooking.sessionDay", day),
    [setPath]
  );
  const setBatchSessionHour = useCallback(
    (hour) => setPath("meals.batchCooking.sessionHour", Number(hour)),
    [setPath]
  );
  const toggleCadence = useCallback(
    (slot, enabled) => setPath(`meals.cadence.${slot}`, !!enabled),
    [setPath]
  );
  const setDonenessVeg = useCallback(
    (v) => setPath("meals.donenessHints.vegetables", v),
    [setPath]
  );
  const setDonenessMeat = useCallback(
    (v) => setPath("meals.donenessHints.meat", v),
    [setPath]
  );
  const setProteins = useCallback(
    (arr) => patch({ meals: { proteins: Array.isArray(arr) ? arr : [] } }),
    [patch]
  );
  const setVeggies = useCallback(
    (arr) => patch({ meals: { veggies: Array.isArray(arr) ? arr : [] } }),
    [patch]
  );
  const setBreads = useCallback(
    (arr) => patch({ meals: { breads: Array.isArray(arr) ? arr : [] } }),
    [patch]
  );
  const setSabbathAware = useCallback(
    (enabled) => setPath("calendar.sabbathAware", !!enabled),
    [setPath]
  );
  const setSabbathOffsetMin = useCallback(
    (min) => setPath("calendar.sabbathSunsetOffsetMin", Number(min)),
    [setPath]
  );

  // --- selectors for simple components & agents
  const pick = useCallback(
    (keys) => {
      const out = {};
      (keys || []).forEach((k) => {
        out[k] = prefs?.[k];
      });
      return out;
    },
    [prefs]
  );

  const get = useCallback((key) => (key ? prefs?.[key] : undefined), [prefs]);

  /**
   * Build a compact query for agents:
   * season is calendar-aware if store exposes it; otherwise keep any value in prefs.calendar.season.
   * Includes macro targets if present, kosher/avoid lists, cadence, batch flags, and Sabbath awareness.
   */
  const toQuery = useCallback(() => {
    const season =
      safeStore(() => MealPrefsStore.getSeason?.(), null) ??
      prefs?.calendar?.season ??
      null;

    const kcal = prefs?.macros?.calories ?? null;
    const proteinG = prefs?.macros?.proteinG ?? null;
    const fatsG = prefs?.macros?.fatG ?? null;
    const carbsG = prefs?.macros?.carbG ?? null;

    const exclude = prefs?.diet?.exclude || [];
    const prefer = prefs?.diet?.prefer || [];
    const cadence = prefs?.meals?.cadence || {};
    const batchEnabled = prefs?.meals?.batchCooking?.enabled ?? false;

    return {
      season,
      kcal,
      proteinG,
      fatsG,
      carbsG,
      exclude,
      prefer,
      cadence,
      batchEnabled,
      sabbathAware,
      portions: portions ?? undefined,
    };
  }, [prefs, sabbathAware, portions]);

  return {
    // canonical snapshot
    prefs,

    // status/meta
    loading,
    error,
    dirty,
    hydrated,
    persisted,
    version,
    source,
    lastUpdated,

    // base actions
    set: setPath,
    patch,
    reset: resetSection, // ✅ low-level (section) reset

    // higher-level API (matches .d.ts)
    setPrefs,
    merge,
    resetKind: reset, // ✅ high-level kind reset (soft/hard/factory)
    loadDefaults,
    persistNow,
    subscribe: subscribeExternal,
    applyTemplate,
    validate,

    // derived values
    portions,
    sabbathAware,
    nextBatchSessionISO,

    // convenience setters
    setDefaultPortions,
    setBatchEnabled,
    setBatchSessionDay,
    setBatchSessionHour,
    toggleCadence,
    setDonenessVeg,
    setDonenessMeat,
    setProteins,
    setVeggies,
    setBreads,
    setSabbathAware,
    setSabbathOffsetMin,

    // selectors
    pick,
    get,
    toQuery,
  };
}

/* ----------------------------------------------------------------------------
 * Selector hook: subscribe to a slice of the store (with optional equality)
 * --------------------------------------------------------------------------*/
export function useMealPrefsSelector(selector, deps = [], areEqual) {
  const sel = selector || ((s) => s);
  const subscribe = useCallback((cb) => MealPrefsStore.subscribe(cb), []);
  const getSnapshot = useCallback(
    () => sel(MealPrefsStore.getState()),
    [sel, ...deps]
  );
  const serverSnapshot = getSnapshot;

  const slice = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);

  // Optional equality check to reduce rerenders for expensive components.
  const lastRef = useRef(slice);
  const out = useMemo(() => {
    const prev = lastRef.current;
    const next = slice;
    const same = areEqual ? areEqual(prev, next) : false;
    if (!same) lastRef.current = next;
    return same ? prev : next;
  }, [slice, areEqual]);

  return out;
}

/* ----------------------------------------------------------------------------
 * Optional provider helper (initializer-only)
 * --------------------------------------------------------------------------*/
/**
 * Call inside your app root once, e.g.:
 *   <MealPrefsProvider baseUrl="/api" socketIO={io('/core')} user={userId} />
 */
export function MealPrefsProvider({
  baseUrl = null,
  socketIO = null,
  user = null,
  autoInit = true,
}) {
  useMealPrefsInit({ baseUrl, socketIO, user, autoInit });
  return null; // no UI; it just initializes the singleton store
}

export default useMealPrefs;
