/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\visibility\AppVisibilityContext.js
//
// AppVisibilityContext
// --------------------
// Tracks the user's "current module" (aka app surface):
//   - cooking, homestead, garden, animals, cleaning, storehouse, inventory, etc.
//   - used by VisibilityRulesEngine (and UI) to decide what to render.
//
// Design goals:
// - Router-aware (React Router location)
// - Event-bus aware (optional): emits app.visibility.module_changed
// - Safe if eventBus is missing (soft dependency)
// - Works even if used outside Router (falls back to window.location.pathname)
// - Provides a compact "surface" token + route info
//
// Exports:
//   - DEFAULT_MODULE
//   - MODULES
//   - getModuleFromPath(pathname)
//   - normalizeModuleToken(token)
//   - AppVisibilityProvider
//   - useAppVisibility()
//   - useCurrentModule()             -> convenience
//   - useIsModule(tokenOrList)       -> convenience
//

import React from "react";

export const DEFAULT_MODULE = "home";

export const MODULES = Object.freeze({
  HOME: "home",
  COOKING: "cooking",
  HOMESTEAD: "homestead",
  GARDEN: "garden",
  ANIMALS: "animals",
  CLEANING: "cleaning",
  STOREHOUSE: "storehouse",
  INVENTORY: "inventory",
  MEAL_PLANNING: "meal_planning",
  CALENDAR: "calendar",
  KNOWLEDGE: "knowledge",
  COMMUNITY: "community",
  SETTINGS: "settings",
  JOBS: "jobs",
  FAVORITES: "favorites",
  HOUSEHOLD: "household",
  TOOLS: "tools",
  OTHER: "other",
});

/**
 * Normalize arbitrary input into a stable module token.
 * Accepts: "Homestead Planner", "homesteadplanner", "homestead_planner", "/homesteadplanner"
 */
export function normalizeModuleToken(input) {
  if (!input) return DEFAULT_MODULE;
  const s = String(input).trim().toLowerCase();

  // Strip leading slashes and query fragments if path-like
  const cleaned = s
    .split("?")[0]
    .split("#")[0]
    .replace(/^\//, "")
    .replace(/\s+/g, "_");

  // Common aliases
  const alias = {
    "": DEFAULT_MODULE,
    home: MODULES.HOME,
    dashboard: MODULES.HOME,

    cooking: MODULES.COOKING,
    meals: MODULES.COOKING,
    "household/meals": MODULES.COOKING,

    homestead: MODULES.HOMESTEAD,
    homesteadplanner: MODULES.HOMESTEAD,
    homestead_planner: MODULES.HOMESTEAD,

    garden: MODULES.GARDEN,

    animals: MODULES.ANIMALS,
    animal_care: MODULES.ANIMALS,

    cleaning: MODULES.CLEANING,

    storehouse: MODULES.STOREHOUSE,

    inventory: MODULES.INVENTORY,

    "meal-planning": MODULES.MEAL_PLANNING,
    meal_planning: MODULES.MEAL_PLANNING,

    calendar: MODULES.CALENDAR,

    knowledge: MODULES.KNOWLEDGE,
    "knowledge-base": MODULES.KNOWLEDGE,

    community: MODULES.COMMUNITY,

    settings: MODULES.SETTINGS,

    jobs: MODULES.JOBS,

    favorites: MODULES.FAVORITES,

    tools: MODULES.TOOLS,
  };

  // Exact alias hit
  if (alias[cleaned]) return alias[cleaned];

  // Some path-like forms like "homesteadplanner/targets"
  const head = cleaned.split("/")[0];
  if (alias[head]) return alias[head];

  // allow direct tokens if they match known set
  const known = new Set(Object.values(MODULES));
  if (known.has(cleaned)) return cleaned;

  return MODULES.OTHER;
}

/**
 * Determine module from a pathname.
 * This is the canonical routing map used for visibility decisions.
 */
export function getModuleFromPath(pathname) {
  const p = String(pathname || "/")
    .split("?")[0]
    .split("#")[0];

  // Order matters: more specific first
  if (p === "/" || p === "") return MODULES.HOME;

  // ✅ Homestead planner surfaces (you asked for /homesteadplanner only)
  if (p === "/homesteadplanner" || p.startsWith("/homesteadplanner/")) {
    return MODULES.HOMESTEAD;
  }

  // Cooking + related
  if (p === "/cooking" || p.startsWith("/cooking/")) return MODULES.COOKING;

  // Garden
  if (p === "/garden" || p.startsWith("/garden/")) return MODULES.GARDEN;

  // Animals
  if (p === "/animals" || p.startsWith("/animals/")) return MODULES.ANIMALS;

  // Cleaning
  if (p === "/cleaning" || p.startsWith("/cleaning/")) return MODULES.CLEANING;

  // Storehouse
  if (p === "/storehouse" || p.startsWith("/storehouse/"))
    return MODULES.STOREHOUSE;

  // Inventory
  if (p === "/inventory" || p.startsWith("/inventory/"))
    return MODULES.INVENTORY;

  // Meal planner (separate from Cooking module if you want)
  if (p === "/meal-planning" || p.startsWith("/meal-planning/"))
    return MODULES.MEAL_PLANNING;

  // Calendar
  if (p === "/calendar" || p.startsWith("/calendar/")) return MODULES.CALENDAR;

  // Knowledge
  if (p === "/knowledge" || p.startsWith("/knowledge/"))
    return MODULES.KNOWLEDGE;

  // Community
  if (p === "/community" || p.startsWith("/community/"))
    return MODULES.COMMUNITY;

  // Settings
  if (p === "/settings" || p.startsWith("/settings/")) return MODULES.SETTINGS;

  // Jobs
  if (p === "/jobs" || p.startsWith("/jobs/")) return MODULES.JOBS;

  // Favorites
  if (p === "/favorites" || p.startsWith("/favorites/"))
    return MODULES.FAVORITES;

  // Household routes: keep a stable module for them
  if (p.startsWith("/household/")) return MODULES.HOUSEHOLD;

  // Tools routes
  if (p.startsWith("/tools/")) return MODULES.TOOLS;

  return MODULES.OTHER;
}

/* -------------------------------------------------------------------------- */
/*  Optional soft dependency: eventBus                                         */
/* -------------------------------------------------------------------------- */

function tryGetEventBus() {
  // We purposely avoid hard imports to prevent build breaks if paths move.
  // If you have a canonical eventBus, you can optionally add a direct import.
  try {
    const b = window?.__suka?.eventBus;
    if (b && typeof b.emit === "function") return b;
  } catch {}
  return null;
}

function safeEmit(eventType, detail) {
  try {
    // 1) app event bus (if present)
    const bus = tryGetEventBus();
    bus?.emit?.(eventType, detail);

    // 2) DOM CustomEvent for lightweight listeners
    window?.dispatchEvent?.(new CustomEvent(eventType, { detail }));
  } catch {}
}

/* -------------------------------------------------------------------------- */
/*  Context + Provider                                                         */
/* -------------------------------------------------------------------------- */

const AppVisibilityContext = React.createContext(null);

function getPathnameFallback() {
  try {
    return window?.location?.pathname || "/";
  } catch {
    return "/";
  }
}

function makeState({ pathname, module }) {
  const now = new Date().toISOString();
  return {
    // canonical
    module: normalizeModuleToken(module || getModuleFromPath(pathname)),
    pathname: String(pathname || "/"),
    // derived / helpful
    ts: now,
    // convenience flags
    is: (tokenOrList) => {
      const mod = normalizeModuleToken(module || getModuleFromPath(pathname));
      const arr = Array.isArray(tokenOrList) ? tokenOrList : [tokenOrList];
      const set = new Set(arr.map(normalizeModuleToken));
      return set.has(mod);
    },
  };
}

/**
 * AppVisibilityProvider
 *
 * Props:
 * - location: optional { pathname } from react-router
 * - children
 *
 * Usage:
 *   <AppVisibilityProvider location={useLocation()}>
 *     <App />
 *   </AppVisibilityProvider>
 *
 * If you can't pass router location here, it will still work via window.location.
 */
export function AppVisibilityProvider({ location, children }) {
  const pathname =
    location?.pathname != null ? location.pathname : getPathnameFallback();

  const [state, setState] = React.useState(() =>
    makeState({ pathname, module: getModuleFromPath(pathname) }),
  );

  // Update when pathname changes (router-aware if location prop provided)
  React.useEffect(() => {
    const nextModule = getModuleFromPath(pathname);
    setState((prev) => {
      const prevModule = prev?.module || DEFAULT_MODULE;
      const normalizedNext = normalizeModuleToken(nextModule);
      const normalizedPrev = normalizeModuleToken(prevModule);

      // Always update pathname; only emit if module changed
      const next = makeState({ pathname, module: normalizedNext });

      if (normalizedNext !== normalizedPrev) {
        safeEmit("app.visibility.module_changed", {
          from: normalizedPrev,
          to: normalizedNext,
          pathname,
          ts: next.ts,
        });
      }

      return next;
    });
  }, [pathname]);

  // Also watch popstate in case provider is used outside Router
  React.useEffect(() => {
    if (location?.pathname != null) return; // router is driving it
    const onPop = () => {
      const p = getPathnameFallback();
      const m = getModuleFromPath(p);
      setState((prev) => {
        const prevM = prev?.module || DEFAULT_MODULE;
        const nextM = normalizeModuleToken(m);
        const next = makeState({ pathname: p, module: nextM });
        if (normalizeModuleToken(prevM) !== nextM) {
          safeEmit("app.visibility.module_changed", {
            from: normalizeModuleToken(prevM),
            to: nextM,
            pathname: p,
            ts: next.ts,
          });
        }
        return next;
      });
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, [location?.pathname]);

  // API: imperative setter (rare; e.g., overlays or embedded views)
  const setModule = React.useCallback((token, meta = {}) => {
    const nextM = normalizeModuleToken(token);
    setState((prev) => {
      const prevM = normalizeModuleToken(prev?.module || DEFAULT_MODULE);
      const p = prev?.pathname || getPathnameFallback();
      const next = makeState({ pathname: p, module: nextM });

      if (prevM !== nextM) {
        safeEmit("app.visibility.module_changed", {
          from: prevM,
          to: nextM,
          pathname: p,
          ts: next.ts,
          meta,
          source: "imperative",
        });
      }
      return next;
    });
  }, []);

  const value = React.useMemo(() => {
    return {
      ...state,
      setModule,
      // helpers (stable)
      getModuleFromPath,
      normalizeModuleToken,
      MODULES,
    };
  }, [state, setModule]);

  return (
    <AppVisibilityContext.Provider value={value}>
      {children}
    </AppVisibilityContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hooks                                                                       */
/* -------------------------------------------------------------------------- */

export function useAppVisibility() {
  const ctx = React.useContext(AppVisibilityContext);
  if (!ctx) {
    // Provide a safe fallback so components don't crash if provider missing
    const pathname = getPathnameFallback();
    const module = getModuleFromPath(pathname);
    const fallback = {
      ...makeState({ pathname, module }),
      setModule: () => {},
      getModuleFromPath,
      normalizeModuleToken,
      MODULES,
      __fallback: true,
    };
    return fallback;
  }
  return ctx;
}

export function useCurrentModule() {
  const { module } = useAppVisibility();
  return module || DEFAULT_MODULE;
}

export function useIsModule(tokenOrList) {
  const { module } = useAppVisibility();
  const mod = normalizeModuleToken(module);
  const arr = Array.isArray(tokenOrList) ? tokenOrList : [tokenOrList];
  const set = new Set(arr.map(normalizeModuleToken));
  return set.has(mod);
}

/* -------------------------------------------------------------------------- */
/*  Optional helpers for non-React consumers (VisibilityRulesEngine, etc.)      */
/* -------------------------------------------------------------------------- */

/**
 * Read current module from the provider if mounted, otherwise derive from URL.
 * Useful for non-React services. (No hard dependency on React tree.)
 */
export function readCurrentModule() {
  try {
    // If someone stashes it on window, use that
    const w = window?.__suka?.appVisibility;
    if (w && typeof w.module === "string")
      return normalizeModuleToken(w.module);
  } catch {}
  return getModuleFromPath(getPathnameFallback());
}

/**
 * Lightweight subscription for non-React services:
 *   const off = subscribeModuleChanges(({to})=>...)
 */
export function subscribeModuleChanges(handler) {
  if (typeof handler !== "function") return () => {};
  const onEvt = (evt) => {
    try {
      handler(evt?.detail || {});
    } catch {}
  };
  try {
    window.addEventListener("app.visibility.module_changed", onEvt);
  } catch {}
  return () => {
    try {
      window.removeEventListener("app.visibility.module_changed", onEvt);
    } catch {}
  };
}

/* -------------------------------------------------------------------------- */
/*  DEV: expose to window for debugging                                         */
/* -------------------------------------------------------------------------- */
(function exposeDebug() {
  try {
    if (!window.__suka) window.__suka = {};
    if (window.__suka.__appVisibilityExposed) return;
    window.__suka.__appVisibilityExposed = true;

    // Provide a tiny live reader for debugging / rules engine
    Object.defineProperty(window.__suka, "appVisibility", {
      configurable: true,
      enumerable: true,
      get() {
        const pathname = getPathnameFallback();
        const module = getModuleFromPath(pathname);
        return {
          pathname,
          module,
          ts: new Date().toISOString(),
        };
      },
    });
  } catch {}
})();
