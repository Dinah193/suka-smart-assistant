// src/hooks/useFavoritePlans.js
// Domain-aware React hook for Favorite Plans (featured + user plans + favorites)
// - Defensive imports (eventBus, FavoritePlans manager, automation runtime optional)
// - SSR-safe, optimistic updates, and event-driven refresh
// - Search, tag, domain filters; exposes full CRUD for user-saved plans
// - Emits/consumes canonical events used across your orchestration (NBA, inventory/conflicts)
//
// Usage:
//   const {
//     state, list, listFavorites, refresh,
//     saveUserPlan, removeUserPlan,
//     favorite, unfavorite, toggleFavorite,
//     adoptFeatured, attachTags,
//     exportAll, importAll,
//     get, snapshot
//   } = useFavoritePlans({ userId, domain: "meals", only: "all", search: "", tags: [] });
/* eslint-disable no-console */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* --------------------------------- Imports -------------------------------- */
let eventBus = { on(){}, off(){}, emit(){} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let FavoritePlans = null;
try {
  const mod = require("@/managers/FavoritePlans");
  FavoritePlans = mod?.default || mod?.favoritePlans || mod || null;
} catch (_e) {}

let automation = null;
try {
  const rt = require("@/services/automation/runtime");
  automation = rt?.automation || rt?.default || null;
} catch (_e) {}

const isBrowser = typeof window !== "undefined";

/* ------------------------------- Small utils ------------------------------ */
const now = () => Date.now();
const shallowEq = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
};

const debounce = (fn, ms) => {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

const rafBatch = (fn) => {
  let pending = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    (isBrowser ? window.requestAnimationFrame : setTimeout)(() => {
      pending = false;
      fn(...(lastArgs || []));
    }, 16);
  };
};

/* ------------------------------ Default params ---------------------------- */
const DEFAULT_DOMAIN = "meals";
/**
 * @typedef UseFavoritePlansParams
 * @property {string} userId
 * @property {string=} domain
 * @property {"all"|"mine"|"featured"=} only
 * @property {string=} search
 * @property {string[]=} tags
 */

const initialState = {
  loading: true,
  error: null,
  domain: DEFAULT_DOMAIN,
  only: "all",
  search: "",
  tags: [],
  items: /** @type {Array<any>} */ ([]),
  favorites: /** @type {Array<any>} */ ([]),
  lastUpdated: 0,
  snapshot: null,
};

/* ---------------------------------- Hook ---------------------------------- */
export default function useFavoritePlans(params = {}) {
  const {
    userId = "anon",
    domain = DEFAULT_DOMAIN,
    only = "all",
    search = "",
    tags = [],
  } = params;

  const mountedRef = useRef(true);
  const argsRef = useRef({ userId, domain, only, search, tags });
  const [state, setState] = useState(() => ({
    ...initialState,
    loading: true,
    domain,
    only,
    search,
    tags,
  }));

  // Keep argsRef synced without causing renders
  useEffect(() => {
    argsRef.current = { userId, domain, only, search, tags };
  }, [userId, domain, only, search, tags]);

  const setPartial = useCallback((patch) => {
    setState((s) => {
      const next = { ...s, ...patch };
      return shallowEq(next, s) ? s : next;
    });
  }, []);

  const guardFP = useCallback(() => {
    if (!FavoritePlans) throw new Error("FavoritePlans manager not available.");
  }, []);

  const refreshCore = useCallback(async () => {
    guardFP();
    const { userId: uid, domain: d, only: o, tags: tg, search: q } = argsRef.current;
    try {
      if (mountedRef.current) setPartial({ loading: true, error: null });
      await FavoritePlans.init?.();
      const [items, favorites, snap] = await Promise.all([
        FavoritePlans.list({ userId: uid, domain: d, only: o, tags: tg, search: q }),
        FavoritePlans.listFavorites({ userId: uid, domain: d }),
        FavoritePlans.snapshot({ userId: uid, domain: d }),
      ]);
      if (!mountedRef.current) return;
      setPartial({
        loading: false,
        error: null,
        domain: d,
        only: o,
        search: q,
        tags: tg,
        items,
        favorites,
        snapshot: snap,
        lastUpdated: now(),
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setPartial({ loading: false, error: err?.message || String(err) });
    }
  }, [guardFP, setPartial]);

  const refresh = useMemo(() => rafBatch(refreshCore), [refreshCore]);

  // Initial load + whenever inputs change
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, domain, only, search, JSON.stringify(tags)]);

  // Wire events for live updates
  useEffect(() => {
    mountedRef.current = true;
    const debouncedRefresh = debounce(refresh, 60);

    const onFavChanged = ({ domain: d, userId: uid }) => {
      const a = argsRef.current;
      if ((d == null || d === a.domain) && uid === a.userId) debouncedRefresh();
    };

    const onPlanEvent = ({ domain: d, userId: uid }) => {
      const a = argsRef.current;
      if ((d == null || d === a.domain) && uid === a.userId) debouncedRefresh();
    };

    // Favorites + plan lifecycle
    eventBus.on("favorites.changed", onFavChanged);
    eventBus.on("plan.saved", onPlanEvent);
    eventBus.on("plan.removed", onPlanEvent);
    eventBus.on("plan.favorited", onPlanEvent);
    eventBus.on("plan.unfavorited", onPlanEvent);
    eventBus.on("plan.tags.updated", onPlanEvent);
    eventBus.on("plan.shared", onPlanEvent);

    // Domain-aware orchestration listeners (inventory + conflicts nudges)
    const onShortage = ({ domain: d, userId: uid }) => {
      const a = argsRef.current;
      if ((d == null || d === a.domain) && uid === a.userId) debouncedRefresh();
    };
    const onConflict = ({ domain: d, userId: uid }) => {
      const a = argsRef.current;
      if ((d == null || d === a.domain) && uid === a.userId) debouncedRefresh();
    };
    eventBus.on("inventory.shortage.detected", onShortage);
    eventBus.on("planner.conflict.detected", onConflict);

    return () => {
      mountedRef.current = false;
      eventBus.off("favorites.changed", onFavChanged);
      eventBus.off("plan.saved", onPlanEvent);
      eventBus.off("plan.removed", onPlanEvent);
      eventBus.off("plan.favorited", onPlanEvent);
      eventBus.off("plan.unfavorited", onPlanEvent);
      eventBus.off("plan.tags.updated", onPlanEvent);
      eventBus.off("plan.shared", onPlanEvent);
      eventBus.off("inventory.shortage.detected", onShortage);
      eventBus.off("planner.conflict.detected", onConflict);
    };
  }, [refresh]);

  /* --------------------------- Exposed operations --------------------------- */
  const list = useCallback(async (opts = {}) => {
    guardFP();
    const a = { ...argsRef.current, ...opts };
    return FavoritePlans.list(a);
  }, [guardFP]);

  const listFavorites = useCallback(async (opts = {}) => {
    guardFP();
    const a = { ...argsRef.current, ...opts };
    return FavoritePlans.listFavorites(a);
  }, [guardFP]);

  const get = useCallback(async ({ planId, domain: d }) => {
    guardFP();
    const a = argsRef.current;
    return FavoritePlans.get({ userId: a.userId, domain: d || a.domain, planId });
  }, [guardFP]);

  const saveUserPlan = useCallback(async (raw) => {
    guardFP();
    const a = argsRef.current;
    const payload = { ...raw, userId: a.userId, domain: raw?.domain || a.domain };
    // optimistic: add/update locally first
    setPartial((s) => {
      // lightweight optimistic merge
      const items = (s.items || []).slice();
      const idx = items.findIndex((p) => p.id === payload.id);
      const np = {
        id: payload.id || `tmp_${Math.random().toString(36).slice(2)}`,
        domain: payload.domain,
        title: payload.title || "Untitled Plan",
        summary: payload.summary || "",
        tags: payload.tags || [],
        planBody: payload.planBody || {},
        session: payload.session || {},
        meta: { createdBy: a.userId, visibility: "private", source: "user", version: 1, ...(raw?.meta || {}) },
        updatedAt: now(),
        createdAt: now(),
        isFavorite: false,
      };
      if (idx >= 0) items[idx] = { ...items[idx], ...np };
      else items.unshift(np);
      return { ...s, items };
    });
    try {
      const saved = await FavoritePlans.saveUserPlan(payload);
      // hydration refresh
      refresh();
      // Optional: automation signal for NBA
      automation?.emit?.("nba.signal", { kind: "plan.saved", domain: payload.domain, userId: a.userId, planId: saved.id, ts: now() });
      return saved;
    } catch (err) {
      // rollback by simply refreshing from source of truth
      refresh();
      throw err;
    }
  }, [guardFP, refresh, setPartial]);

  const removeUserPlan = useCallback(async ({ planId, domain: d }) => {
    guardFP();
    const a = argsRef.current;
    const domainUse = d || a.domain;
    // optimistic removal
    setPartial((s) => ({ ...s, items: (s.items || []).filter((p) => p.id !== planId) }));
    try {
      await FavoritePlans.removeUserPlan({ userId: a.userId, domain: domainUse, planId });
      refresh();
      return true;
    } catch (err) {
      refresh();
      throw err;
    }
  }, [guardFP, refresh, setPartial]);

  const favorite = useCallback(async ({ planId, domain: d }) => {
    guardFP();
    const a = argsRef.current;
    const domainUse = d || a.domain;
    // optimistic
    setPartial((s) => ({
      ...s,
      items: (s.items || []).map((p) => (p.id === planId ? { ...p, isFavorite: true } : p)),
    }));
    try {
      await FavoritePlans.favorite({ userId: a.userId, domain: domainUse, planId });
      refresh();
      return true;
    } catch (err) {
      refresh();
      throw err;
    }
  }, [guardFP, refresh, setPartial]);

  const unfavorite = useCallback(async ({ planId, domain: d }) => {
    guardFP();
    const a = argsRef.current;
    const domainUse = d || a.domain;
    setPartial((s) => ({
      ...s,
      items: (s.items || []).map((p) => (p.id === planId ? { ...p, isFavorite: false } : p)),
    }));
    try {
      await FavoritePlans.unfavorite({ userId: a.userId, domain: domainUse, planId });
      refresh();
      return true;
    } catch (err) {
      refresh();
      throw err;
    }
  }, [guardFP, refresh, setPartial]);

  const toggleFavorite = useCallback(async ({ planId, domain: d }) => {
    const item = (state.items || []).find((p) => p.id === planId);
    if (item?.isFavorite) return unfavorite({ planId, domain: d });
    return favorite({ planId, domain: d });
  }, [favorite, unfavorite, state.items]);

  const adoptFeatured = useCallback(async ({ planId, domain: d, favorite: fav = true }) => {
    guardFP();
    const a = argsRef.current;
    const domainUse = d || a.domain;
    const plan = await FavoritePlans.adoptFeatured({ userId: a.userId, domain: domainUse, planId, favorite: fav });
    refresh();
    return plan;
  }, [guardFP, refresh]);

  const attachTags = useCallback(async ({ planId, tags: tg, domain: d }) => {
    guardFP();
    const a = argsRef.current;
    const domainUse = d || a.domain;
    await FavoritePlans.attachTags({ userId: a.userId, domain: domainUse, planId, tags: tg });
    refresh();
    return true;
  }, [guardFP, refresh]);

  const exportAll = useCallback(async () => {
    guardFP();
    const a = argsRef.current;
    return FavoritePlans.exportAll({ userId: a.userId });
  }, [guardFP]);

  const importAll = useCallback(async ({ blob, mergeMode = "merge" }) => {
    guardFP();
    const a = argsRef.current;
    const ok = await FavoritePlans.importAll({ userId: a.userId, blob, mergeMode });
    refresh();
    return ok;
  }, [guardFP, refresh]);

  const doSnapshot = useCallback(async (opts = {}) => {
    guardFP();
    const a = { ...argsRef.current, ...opts };
    return FavoritePlans.snapshot({ userId: a.userId, domain: a.domain });
  }, [guardFP]);

  /* ------------------------------ Derived data ------------------------------ */
  const favoritesSet = useMemo(() => {
    const s = new Set();
    for (const p of state.items || []) if (p.isFavorite) s.add(p.id);
    return s;
  }, [state.items]);

  /* --------------------------------- Return -------------------------------- */
  return {
    state,
    refresh,
    list,
    listFavorites,
    get,
    saveUserPlan,
    removeUserPlan,
    favorite,
    unfavorite,
    toggleFavorite,
    adoptFeatured,
    attachTags,
    exportAll,
    importAll,
    snapshot: doSnapshot,
    favoritesSet,
  };
}
