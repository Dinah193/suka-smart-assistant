// C:\Users\larho\suka-smart-assistant\src\router.jsx
// Routes for household domains: meals, cleaning, garden, animals, inventory,
// storehouse, import, analytics, preservation, knowledge
// -----------------------------------------------------------------------------
// This router is part of the SSA pipeline:
//
//   imports → intelligence → automation → (optional) hub export → UI routes
//
// It does 4 important things:
//
// 1. Defines all household-first routes (SSA runs by itself)
// 2. Bridges window messages (bookmarklet, PWA share, iOS shortcut) → automation
// 3. Re-broadcasts route changes to the shared eventBus + automation runtime
// 4. Leaves extension points for NEW domains (preservation, animal, storehouse)
//    and Hub-only views without breaking SSA
//
// UPDATE:
// - Adds an OPTIONAL central route mapping (ROUTES) with helpers to generate paths
//   and read route params/query in a consistent way across the app.
//   Exported helpers: route(name, params?, query?), buildPath(template, params?, query?),
//   useRouteParams(), useQuery(), toQueryString(query), ROUTES (frozen).
//
// ASSUMPTIONS:
// - src/services/events/eventBus.js exports a default { emit, on }-style bus
// - src/services/automationRuntime.js exports initAutomationRuntime(), handleEvent()
// - pages may not all exist yet → we provide Stub(...) for missing ones
// -----------------------------------------------------------------------------

/* eslint-disable no-console */
import React, { Suspense, useEffect } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";

// shared event bus (window.__suka?.eventBus aware)
import eventBus from "@/services/events/eventBus";

// SSA automation runtime (imports → intelligence → automation)
import {
  initAutomationRuntime,
  handleEvent as automationHandleEvent,
} from "@/services/automationRuntime";

/* ----------------------------------------------------------------------------
 * OPTIONAL CENTRAL ROUTE MAP
 * ----------------------------------------------------------------------------
 * - Authoritative, name-based map for all paths (including :params)
 * - Use `route(name, params, query)` to generate links safely
 * - Use `useRouteParams()` and `useQuery()` inside pages to read params/query
 * - Does not *require* dynamic route rendering; we still define <Route> below.
 *   This keeps tree-shaking and lazy loading predictable while giving the rest
 *   of SSA a single source of truth for path strings.
 * -------------------------------------------------------------------------- */
const _ROUTES = {
  // Core
  home: { path: "/" },
  community: { path: "/community" },
  knowledge: { path: "/knowledge" },
  homestead: { path: "/homestead" },
  design_ssa_showcase: { path: "/design/ssa-showcase" },

  // Knowledge panels
  knowledge_events: { path: "/knowledge/events" },
  knowledge_yields: { path: "/knowledge/yield-curves" },
  knowledge_rules: { path: "/knowledge/rules" },
  knowledge_docs: { path: "/knowledge/docs" },

  // Import settings / inbox
  import_settings: { path: "/import/settings" },
  import_inbox: { path: "/import" },

  // Tools
  tool_macro: { path: "/tools/macro-calculator" },
  tool_bmi: { path: "/tools/bmi-calculator" },
  tool_multitimer: { path: "/tools/multi-timer" },

  // Domains
  meals: { path: "/meals" },
  cooking: { path: "/cooking" },
  cooking_draft: { path: "/cooking/draft/:id" }, // :id
  cooking_play: { path: "/cooking/play/:id" }, // :id
  cooking_remote: { path: "/cooking/remote/:room" }, // :room
  garden: { path: "/garden" },
  animals: { path: "/animals" },
  cleaning: { path: "/cleaning" },
  calendar: { path: "/calendar" },

  // Inventory vs Storehouse
  inventory: { path: "/inventory" },
  storehouse: { path: "/storehouse" },
  storehouse_preserve_queue: { path: "/storehouse/preserve-queue" },
  storehouse_autofill: { path: "/storehouse/auto-fill" },

  // Analytics / Preservation
  analytics: { path: "/analytics" },
  preservation: { path: "/preservation" },

  // Scan / Extreme Couponing
  scan: { path: "/scan" },
  scan_extreme: { path: "/scan/extreme" },

  // Optional Hub viewer (SSA still owns data first)
  hub: { path: "/hub" },
};

// Allow runtime extension without mutation (e.g., plugins can add names under window.__suka.routes)
const runtimeExtraRoutesRaw =
  (typeof window !== "undefined" && window.__suka?.routes) || {};
const runtimeExtraRoutes = Object.fromEntries(
  Object.entries(runtimeExtraRoutesRaw).filter(
    ([, value]) => value && typeof value.path === "string" && value.path.trim().length > 0
  )
);
export const ROUTES = Object.freeze({ ..._ROUTES, ...runtimeExtraRoutes });

/** Build a query-string from a POJO (skips null/undefined) */
export function toQueryString(query = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) v.forEach((val) => params.append(k, String(val)));
    else params.set(k, String(v));
  });
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Replace :params in a route template; throw if required params are missing */
export function buildPath(template, params = {}, query) {
  if (!template || typeof template !== "string")
    throw new Error("buildPath: template required");
  const missing = [];
  const out = template.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    if (!(key in params)) {
      missing.push(key);
      return `:${key}`;
    }
    return encodeURIComponent(String(params[key]));
  });
  if (missing.length) {
    throw new Error(`buildPath: missing params: ${missing.join(", ")}`);
  }
  return `${out}${toQueryString(query)}`;
}

/** Named route shortcut: route('cooking_play', { id: 'abc' }, { overlay: 1 }) */
export function route(name, params, query) {
  const def = ROUTES[name];
  if (!def) throw new Error(`route: unknown route name "${name}"`);
  return buildPath(def.path, params, query);
}

/** Grab current route params + query in a consistent shape */
export function useQuery() {
  const [searchParams] = useSearchParams();
  const obj = {};
  for (const [k, v] of searchParams.entries()) {
    // collect repeated params as arrays
    if (k in obj) obj[k] = Array.isArray(obj[k]) ? [...obj[k], v] : [obj[k], v];
    else obj[k] = v;
  }
  return obj;
}

export function useRouteParams() {
  const params = useParams(); // /path/:id
  const query = useQuery(); // ?a=1&b=2
  return { params, query };
}

// ---------------------------------------------------------------------------
// Fallback stub (in case user hasn't created a page yet)
// ---------------------------------------------------------------------------
function Stub(name) {
  return function StubComponent() {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold mb-2">{name} page missing</h1>
        <p className="text-sm opacity-70">
          Create{" "}
          <code>
            src/pages/{name.toLowerCase()}/{name}Page.jsx
          </code>{" "}
          (or the path you prefer) to replace this stub.
        </p>
      </div>
    );
  };
}

// ---------------------------------------------------------------------------
/** Lazy helper — tries multiple candidate paths; falls back to Stub on failure */
function lazyPage(candidates = [], stubName = "Page") {
  return React.lazy(async () => {
    for (const p of candidates) {
      try {
        const mod = await import(/* @vite-ignore */ p);
        if (mod?.default) return { default: mod.default };
        return mod;
      } catch {
        // try next candidate
      }
    }
    return { default: Stub(stubName) };
  });
}

// ---------------------------------------------------------------------------
// Lazy pages – all domain pages are loaded on demand to keep / fast
// ---------------------------------------------------------------------------
// Core
const HomePage = lazyPage(["@/pages/home.jsx", "@/pages/Home.jsx"], "Home");
const CommunityPage = lazyPage(["@/pages/community.jsx"], "Community");
const Knowledge = lazyPage(
  [
    "@/pages/knowledge.jsx",
    "@/pages/Knowledge.jsx",
    "@/pages/knowledge/KnowledgePage.jsx",
  ],
  "Knowledge"
);
const Homestead = lazyPage(
  [
    "@/pages/homesteadplanner/homestead.jsx",
    "@/pages/homesteadplanner/index.jsx",
    "@/pages/homestead.jsx",
    "@/pages/Homestead.jsx",
    "@/pages/homestead/index.jsx",
  ],
  "Homestead"
);

// Knowledge “panel” pages
const EventCatalog = lazyPage(
  ["@/pages/knowledge/events.jsx", "@/features/events/EventCatalog.jsx"],
  "EventCatalog"
);
const YieldCurves = lazyPage(
  ["@/pages/knowledge/yield-curves.jsx", "@/features/yield/YieldCurves.jsx"],
  "YieldCurves"
);
const InventoryRules = lazyPage(
  ["@/pages/knowledge/rules.jsx", "@/features/inventory/InventoryRules.jsx"],
  "InventoryRules"
);
const KnowledgeDocs = lazyPage(
  ["@/pages/knowledge/docs.jsx", "@/features/docs/DocsIndex.jsx"],
  "Docs"
);

// Import settings
const ImportSettings = lazyPage(
  ["@/features/import/ImportSettings.jsx", "@/pages/import/settings.jsx"],
  "ImportSettings"
);

// Tools
const MacroCalc = lazyPage(
  ["@/tools/MacroCalculator.jsx", "@/pages/tools/macro-calculator.jsx"],
  "MacroCalculator"
);
const BmiCalc = lazyPage(
  ["@/tools/BMICalculator.jsx", "@/pages/tools/bmi-calculator.jsx"],
  "BMICalculator"
);
const MultiTimer = lazyPage(
  ["@/tools/MultiTimerPanel.jsx", "@/pages/tools/multi-timer.jsx"],
  "MultiTimer"
);

// Domains
const MealPage = lazyPage(
  [
    "@/pages/mealplanner/index.jsx",
    "@/pages/mealplanner/mealplanner.jsx",
    "@/pages/meals/MealsPage.jsx",
    "@/domain/meals/MealPlanner.jsx",
    "@/pages/meals/index.jsx",
  ],
  "Meals"
);
const CookingPage = lazyPage(
  [
    "@/pages/cooking/CookingPage.jsx",
    "@/domain/meals/MealPlanner.jsx",
    "@/pages/cooking/index.jsx",
  ],
  "Cooking"
);
const GardenPage = lazyPage(
  [
    "@/pages/garden/GardenPage.jsx",
    "@/domain/garden/GardenPlanner.jsx",
    "@/pages/garden/index.jsx",
  ],
  "Garden"
);
const AnimalsPage = lazyPage(
  [
    "@/pages/animals/AnimalsPage.jsx",
    "@/domain/animals/AnimalPlanner.jsx",
    "@/pages/animals/index.jsx",
  ],
  "Animals"
);
const CleaningPage = lazyPage(
  [
    "@/pages/cleaning/CleaningPage.jsx",
    "@/domain/cleaning/CleaningPlanner.jsx",
    "@/pages/cleaning/index.jsx",
  ],
  "Cleaning"
);
const CalendarPage = lazyPage(
  ["@/pages/calendar/CalendarPage.jsx", "@/pages/calendar.jsx"],
  "Calendar"
);

// Inventory vs storehouse
const InventoryPage = lazyPage(
  ["@/pages/inventory/InventoryPage.jsx", "@/pages/inventory/index.jsx"],
  "Inventory"
);
const StorehousePage = lazyPage(
  [
    "@/pages/storehouse/storehouse.jsx",
    "@/pages/storehouse/StorehousePage.jsx",
    "@/pages/storehouse/index.jsx",
  ],
  "Storehouse"
);

// Storehouse subpages (deep links)
const PreserveQueue = lazyPage(
  [
    "@/domain/storehouse/PreserveQueue.jsx",
    "@/pages/storehouse/preserve-queue.jsx",
  ],
  "PreservationQueue"
);
const AutoFill = lazyPage(
  [
    "@/domain/storehouse/AutoFillPlanner.jsx",
    "@/pages/storehouse/auto-fill.jsx",
  ],
  "StorehouseAutoFill"
);

// Import landing / inbox
const ImportPage = lazyPage(
  ["@/pages/import/ImportLanding.jsx", "@/features/import/ImportLanding.jsx"],
  "Import"
);

// Analytics
const AnalyticsPage = lazyPage(
  ["@/pages/analytics/HouseholdAnalytics.jsx", "@/pages/analytics/index.jsx"],
  "Analytics"
);

// Preservation dashboard
const PreservationPage = lazyPage(
  [
    "@/pages/preservation/PreservationPage.jsx",
    "@/pages/preservation/index.jsx",
  ],
  "Preservation"
);

// Scan / Extreme couponing
const ScanExtreme = lazyPage(
  [
    "@/features/scan-compare-trust/ExtremeCouponing.jsx",
    "@/pages/scan.jsx",
    "@/pages/scan/index.jsx",
  ],
  "Scan"
);

// Optional: hub viewer (SSA still owns data first)
const HubViewerPage = lazyPage(
  ["@/pages/hub/HubViewerPage.jsx", "@/pages/hub/index.jsx"],
  "Hub"
);

const SSAShowcasePage = lazyPage(
  ["@/pages/design/ssa-showcase.jsx"],
  "SSAShowcase"
);

// 404
const NotFound = () => (
  <div className="p-6">
    <h1 className="text-2xl font-semibold">Page not found</h1>
    <p className="opacity-70 mt-2">
      This route isn’t registered. Check <code>src/router.jsx</code> or the path
      you navigated to.
    </p>
  </div>
);

// ---------------------------------------------------------------------------
// 1) Shared orchestration bridge
//    - listens for worker/import/PWA/iOS share messages
//    - pushes them into the automation runtime
//    - rebroadcasts in the SSA event shape { type, ts, source, data }
//    - supports reverse generation (recipe → animal, harvest → preservation)
// ---------------------------------------------------------------------------
function OrchestrationBridge() {
  const location = useLocation();

  useEffect(() => {
    if (typeof window === "undefined") return;

    // bootstrap automation runtime once per window
    if (!window.__suka) window.__suka = {};
    if (!window.__suka.automationInitialized) {
      try {
        initAutomationRuntime();
        window.__suka.automationInitialized = true;
      } catch {
        // runtime should never block router
      }
    }

    const messageHandler = (evt) => {
      const msg = evt.data;
      if (!msg || typeof msg !== "object") return;

      // normalize to SSA event shape
      const ssaEvt = {
        type: msg.type || "external.message",
        ts: new Date().toISOString(),
        source: "router.messageBridge",
        data: msg.payload || msg.data || {},
      };

      // always emit to bus so analytics / debugger can see it
      safeEmit(ssaEvt.type, ssaEvt);

      // import normalization → let UI & automation know
      if (msg.type === "import.normalized") {
        automationHandleEvent?.({
          type: "import.parsed",
          ts: ssaEvt.ts,
          source: "router.messageBridge",
          data: ssaEvt.data,
        });
      }

      // schedules from bookmarklet/mobile/iOS shortcut
      if (msg.type === "automation.schedule.request") {
        automationHandleEvent?.({
          type: "automation.schedule.request",
          ts: ssaEvt.ts,
          source: "router.messageBridge",
          data: ssaEvt.data,
        });
      }

      // user-owned favorites (sessions & schedules)
      if (msg.type === "favorite.request") {
        safeEmit("favorite.request", { ...ssaEvt, data: ssaEvt.data });
      }

      // reverse generation (cleaning → storehouse, recipe → animals, etc.)
      if (msg.type === "reverse.action.request") {
        automationHandleEvent?.({
          type: "reverse.action.request",
          ts: ssaEvt.ts,
          source: "router.messageBridge",
          data: ssaEvt.data,
        });
      }
    };

    window.addEventListener("message", messageHandler);

    // route change → inform automation + bus (helps NBA + inline tools)
    const routeEvt = {
      type: "route.changed",
      ts: new Date().toISOString(),
      source: "router",
      data: { path: location.pathname },
    };
    safeEmit("route.changed", routeEvt);
    automationHandleEvent?.(routeEvt);

    return () => window.removeEventListener("message", messageHandler);
  }, [location.pathname]);

  return null;
}

// small helper to keep bus safe
function safeEmit(type, detail) {
  try {
    // local app bus
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(type, detail);
    }
    // DOM-level bridge
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(type, { detail }));
      const bus = window.__suka?.eventBus;
      if (bus && typeof bus.emit === "function") {
        bus.emit(type, detail);
      }
    }
  } catch {
    // no-op: UI must never crash because of bus
  }
}

// ---------------------------------------------------------------------------
// 2) Route wrapper – adds suspense + orchestration only once
// ---------------------------------------------------------------------------
function AppRoutes() {
  return (
    <>
      <OrchestrationBridge />
      <Suspense
        fallback={
          <div className="p-6 text-sm text-slate-500">
            Loading Suka Smart Assistant…
          </div>
        }
      >
        <Routes>
          {/* CORE */}
          <Route path={ROUTES.home.path} element={<HomePage />} />
          <Route path={ROUTES.community.path} element={<CommunityPage />} />
          <Route path={ROUTES.knowledge.path} element={<Knowledge />} />
          <Route path={ROUTES.homestead.path} element={<Homestead />} />
          <Route
            path={ROUTES.design_ssa_showcase.path}
            element={<SSAShowcasePage />}
          />

          {/* KNOWLEDGE PANELS */}
          <Route
            path={ROUTES.knowledge_events.path}
            element={<EventCatalog />}
          />
          <Route
            path={ROUTES.knowledge_yields.path}
            element={<YieldCurves />}
          />
          <Route
            path={ROUTES.knowledge_rules.path}
            element={<InventoryRules />}
          />
          <Route
            path={ROUTES.knowledge_docs.path}
            element={<KnowledgeDocs />}
          />

          {/* IMPORT SETTINGS */}
          <Route
            path={ROUTES.import_settings.path}
            element={<ImportSettings />}
          />

          {/* TOOLS */}
          <Route path={ROUTES.tool_macro.path} element={<MacroCalc />} />
          <Route path={ROUTES.tool_bmi.path} element={<BmiCalc />} />
          <Route path={ROUTES.tool_multitimer.path} element={<MultiTimer />} />

          {/* DOMAINS */}
          <Route path={ROUTES.meals.path} element={<MealPage />} />
          <Route path={ROUTES.cooking.path} element={<CookingPage />} />
          <Route path={ROUTES.garden.path} element={<GardenPage />} />
          <Route path={ROUTES.animals.path} element={<AnimalsPage />} />
          <Route path={ROUTES.cleaning.path} element={<CleaningPage />} />
          <Route path={ROUTES.calendar.path} element={<CalendarPage />} />

          {/* INVENTORY / STOREHOUSE */}
          <Route path={ROUTES.inventory.path} element={<InventoryPage />} />
          <Route path={ROUTES.storehouse.path} element={<StorehousePage />} />
          <Route
            path={ROUTES.storehouse_preserve_queue.path}
            element={<PreserveQueue />}
          />
          <Route
            path={ROUTES.storehouse_autofill.path}
            element={<AutoFill />}
          />

          {/* IMPORT INBOX + ANALYTICS + PRESERVATION */}
          <Route path={ROUTES.import_inbox.path} element={<ImportPage />} />
          <Route path={ROUTES.analytics.path} element={<AnalyticsPage />} />
          <Route
            path={ROUTES.preservation.path}
            element={<PreservationPage />}
          />

          {/* SCAN / COUPONING */}
          <Route path={ROUTES.scan_extreme.path} element={<ScanExtreme />} />
          <Route
            path={ROUTES.scan.path}
            element={<Navigate to={ROUTES.scan_extreme.path} replace />}
          />

          {/* HUB VIEWER (optional) */}
          <Route path={ROUTES.hub.path} element={<HubViewerPage />} />

          {/* LEGACY SHORT PATHS */}
          <Route
            path="/meal-planning"
            element={<Navigate to={ROUTES.meals.path} replace />}
          />
          <Route
            path="/cooking/schedule"
            element={<Navigate to={ROUTES.cooking.path} replace />}
          />
          <Route
            path="/garden/planner"
            element={<Navigate to={ROUTES.garden.path} replace />}
          />
          <Route
            path="/animals/planner"
            element={<Navigate to={ROUTES.animals.path} replace />}
          />
          <Route
            path="/cleaning/routines"
            element={<Navigate to={ROUTES.cleaning.path} replace />}
          />
          <Route
            path="/scan-compare-trust"
            element={<Navigate to={ROUTES.scan_extreme.path} replace />}
          />
          <Route
            path="/imports"
            element={<Navigate to={ROUTES.import_inbox.path} replace />}
          />
          <Route
            path="/reports"
            element={<Navigate to={ROUTES.analytics.path} replace />}
          />
          <Route
            path="/storehouse/planner"
            element={<Navigate to={ROUTES.storehouse.path} replace />}
          />
          <Route
            path="/kg"
            element={<Navigate to={ROUTES.knowledge.path} replace />}
          />
          <Route
            path="/homesteadplanner"
            element={<Navigate to={ROUTES.homestead.path} replace />}
          />
          <Route
            path="/homesteadplanner/*"
            element={<Navigate to={ROUTES.homestead.path} replace />}
          />

          {/* 404 — do NOT redirect to "/" silently */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </>
  );
}

// ---------------------------------------------------------------------------
// 3) Final exported router component
//    - wraps with BrowserRouter
//    - this is the root of all SSA domain navigation
// ---------------------------------------------------------------------------
export default function AppRouter() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
