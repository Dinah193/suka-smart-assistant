/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\App.jsx
import React, { Suspense } from "react";
import {
  // Router comes from main.jsx
  Routes,
  Route,
  NavLink,
  Navigate,
  useLocation,
  useNavigate,
  // ✅ FIX: needed for guaranteed fallback to /:domain/play/:id
} from "react-router-dom";

import RightSidebar from "@/components/layout/RightSidebar";
import { VisionProvider } from "@/context/VisionContext";
import "./index.css";

/* -------------------------------------------------------------------------- */
/* ✅ CRITICAL: purge stale Service Worker + caches on localhost ASAP          */
/*                                                                            */
/* Why: If a stale SW is serving an old app shell, you’ll see:                */
/* - HouseholdMealsCuisinePage “not defined” (old App bundle)                 */
/* - index.js / index.js / featureFlags.json served as text/html              */
/*                                                                            */
/* This runs at MODULE LOAD (before React render), so it works even if the    */
/* app crashes during initial render.                                         */
/* -------------------------------------------------------------------------- */
(() => {
  try {
    const host = window?.location?.hostname;
    const isLocal =
      host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
    if (!isLocal) return;
    if (!("serviceWorker" in navigator)) return;

    const key = "__ssa_sw_purged_once__";
    const alreadyPurged =
      window.sessionStorage && window.sessionStorage.getItem(key) === "1";

    (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      } catch {}

      try {
        if (window.caches && typeof window.caches.keys === "function") {
          const keys = await window.caches.keys();
          await Promise.all(keys.map((k) => window.caches.delete(k)));
        }
      } catch {}

      try {
        window.sessionStorage?.setItem(key, "1");
      } catch {}

      // Reload once to ensure we fetch the real, current modules.
      if (!alreadyPurged) {
        try {
          window.location.reload();
        } catch {}
      }
    })();
  } catch {}
})();

/* --------------------- Optional soft imports (safe if missing) --------------------- */
/**
 * ✅ FIX: remove require() usage (browser ESM + Vite-safe)
 * - require is not defined in the browser; even inside try/catch it can create brittle builds
 * - We load these lazily in bootSoftModulesOnce()
 */
let ProfileCapsule = () => null;
let Jobs = { on: () => () => {}, emit: () => {} };
let Events = { emit: () => {}, on: () => () => {} };

/* -------------------------------------------------------------------------- */
/* ✅ FIX #1: Vite/ESM-safe soft imports (no require())                        */
/* - require() fails under Vite ESM and silently leaves modules as null       */
/* - We load these once asynchronously and also expose them on window.__suka  */
/* -------------------------------------------------------------------------- */
let eventBus = null;
let automationRuntime = null;

/* NEW: HouseholdReasoner shim (shared cross-domain orchestration) */
let HouseholdReasoner = null;

/**
 * ✅ NEW: Global SessionRunner modal (soft import, safe if missing)
 * We mount this at the App chrome level so it behaves like Cooking Play.
 * If you already have a centralized runner component, this will use it.
 */
let SessionRunnerModal = null;

/* ✅ FIX: ProfileCapsule soft import must NOT hardcode a missing path. Use glob to include candidates without breaking build. */
const PROFILE_CAPSULE_MODULES = import.meta.glob(
  [
    "./components/profile/ProfileCapsule.jsx",
    "./components/profile/ProfileCapsule.tsx",
    "./features/profile/ProfileCapsule.jsx",
    "./features/profile/ProfileCapsule.tsx",
    "./profile/ProfileCapsule.jsx",
    "./profile/ProfileCapsule.tsx",
  ],
  { eager: false },
);

// Collect possible runner components so Vite includes them.
// ✅ UPDATED: include your real runner at ./features/session/SessionRunnerModal.jsx
const SESSION_RUNNER_MODULES = import.meta.glob(
  [
    // ✅ preferred (exists in your project)
    "./features/session/SessionRunnerModal.jsx",
    "./features/session/SessionRunnerModal.tsx",

    // legacy candidates (safe if missing)
    "./components/session/SessionRunnerModal.jsx",
    "./components/session/SessionRunner.jsx",
    "./components/session/SessionRunnerHost.jsx",

    // allow alternate casing/paths if they exist (no harm if missing)
    "./components/session/SessionRunnerModal.tsx",
    "./components/session/SessionRunner.tsx",
    "./components/session/SessionRunnerHost.tsx",
  ],
  { eager: false },
);

/* ✅ NEW: soft module registries (prevent build failure if files don’t exist) */
const JOBS_ENGINE_MODULES = import.meta.glob(
  [
    "./services/jobs/engine.js",
    "./services/jobs/engine.jsx",
    "./services/jobs/engine.ts",
    "./services/jobs/engine.tsx",
    "./services/jobs/engine/index.js",
    "./services/jobs/engine/index.jsx",
    "./services/jobs/Engine.js",
    "./services/jobs/Engine.jsx",
    "./services/jobs/Engine.ts",
    "./services/jobs/Engine.tsx",
  ],
  { eager: false },
);

const AUTOMATION_EVENTS_MODULES = import.meta.glob(
  [
    "./services/automation/events.js",
    "./services/automation/events.jsx",
    "./services/automation/events.ts",
    "./services/automation/events.tsx",
    "./services/automation/events/index.js",
    "./services/automation/events/index.jsx",
    "./services/automation/Events.js",
    "./services/automation/Events.jsx",
    "./services/automation/Events.ts",
    "./services/automation/Events.tsx",
  ],
  { eager: false },
);

const EVENTBUS_MODULES = import.meta.glob(
  [
    "./services/events/eventBus.js",
    "./services/events/eventBus.jsx",
    "./services/events/eventBus.ts",
    "./services/events/eventBus.tsx",
    "./services/events/eventBus/index.js",
    "./services/events/eventBus/index.jsx",
    "./services/eventBus.js",
    "./services/eventBus.jsx",
    "./services/eventBus.ts",
    "./services/eventBus.tsx",
    "./services/events/EventBus.js",
    "./services/events/EventBus.jsx",
    "./services/events/EventBus.ts",
    "./services/events/EventBus.tsx",
  ],
  { eager: false },
);

const AUTOMATION_RUNTIME_MODULES = import.meta.glob(
  [
    "./services/automation/runtime.js",
    "./services/automation/runtime.jsx",
    "./services/automation/runtime.ts",
    "./services/automation/runtime.tsx",
    "./services/automation/runtime/index.js",
    "./services/automation/runtime/index.jsx",
    "./services/automation/Runtime.js",
    "./services/automation/Runtime.jsx",
    "./services/automation/Runtime.ts",
    "./services/automation/Runtime.tsx",
  ],
  { eager: false },
);

const HOUSEHOLD_REASONER_MODULES = import.meta.glob(
  [
    "./agents/shims/HouseholdReasoner.js",
    "./agents/shims/HouseholdReasoner.jsx",
    "./agents/shims/HouseholdReasoner.ts",
    "./agents/shims/HouseholdReasoner.tsx",
    "./agents/HouseholdReasoner.js",
    "./agents/HouseholdReasoner.jsx",
    "./agents/HouseholdReasoner.ts",
    "./agents/HouseholdReasoner.tsx",
    "./services/reasoner/HouseholdReasoner.js",
    "./services/reasoner/HouseholdReasoner.jsx",
    "./services/reasoner/HouseholdReasoner.ts",
    "./services/reasoner/HouseholdReasoner.tsx",
  ],
  { eager: false },
);

async function loadFirstModuleFromMap(map, keys = []) {
  for (const key of keys) {
    const loader = map[key];
    if (!loader) continue;
    try {
      const mod = await loader();
      return mod?.default || mod;
    } catch {}
  }
  return null;
}

async function bootSoftModulesOnce() {
  if (!window.__suka) window.__suka = {};
  if (window.__suka.__appSoftBooted) return;
  window.__suka.__appSoftBooted = true;

  // ProfileCapsule (soft) ✅ FIX: glob-based so missing file won't break build
  try {
    const mod = await loadFirstModuleFromMap(PROFILE_CAPSULE_MODULES, [
      "./components/profile/ProfileCapsule.jsx",
      "./components/profile/ProfileCapsule.tsx",
      "./features/profile/ProfileCapsule.jsx",
      "./features/profile/ProfileCapsule.tsx",
      "./profile/ProfileCapsule.jsx",
      "./profile/ProfileCapsule.tsx",
    ]);
    if (mod) {
      ProfileCapsule = mod;
      window.__suka.ProfileCapsule = ProfileCapsule;
    }
  } catch {}

  // Jobs engine (soft) ✅ FIX: glob-based so missing file won't break build
  try {
    const mod = await loadFirstModuleFromMap(JOBS_ENGINE_MODULES, [
      "./services/jobs/engine.js",
      "./services/jobs/engine.jsx",
      "./services/jobs/engine.ts",
      "./services/jobs/engine.tsx",
      "./services/jobs/engine/index.js",
      "./services/jobs/engine/index.jsx",
      "./services/jobs/Engine.js",
      "./services/jobs/Engine.jsx",
      "./services/jobs/Engine.ts",
      "./services/jobs/Engine.tsx",
    ]);
    Jobs = mod || Jobs;
    window.__suka.Jobs = Jobs;
  } catch {}

  // Automation events (soft) ✅ FIX: glob-based so missing file won't break build
  try {
    const mod = await loadFirstModuleFromMap(AUTOMATION_EVENTS_MODULES, [
      "./services/automation/events.js",
      "./services/automation/events.jsx",
      "./services/automation/events.ts",
      "./services/automation/events.tsx",
      "./services/automation/events/index.js",
      "./services/automation/events/index.jsx",
      "./services/automation/Events.js",
      "./services/automation/Events.jsx",
      "./services/automation/Events.ts",
      "./services/automation/Events.tsx",
    ]);
    Events = mod || Events;
    window.__suka.Events = Events;
  } catch {}

  // eventBus ✅ FIX: glob-based so missing file won't break build
  try {
    const mod = await loadFirstModuleFromMap(EVENTBUS_MODULES, [
      "./services/events/eventBus.js",
      "./services/events/eventBus.jsx",
      "./services/events/eventBus.ts",
      "./services/events/eventBus.tsx",
      "./services/events/eventBus/index.js",
      "./services/events/eventBus/index.jsx",
      "./services/eventBus.js",
      "./services/eventBus.jsx",
      "./services/eventBus.ts",
      "./services/eventBus.tsx",
      "./services/events/EventBus.js",
      "./services/events/EventBus.jsx",
      "./services/events/EventBus.ts",
      "./services/events/EventBus.tsx",
    ]);
    eventBus = mod || eventBus;
    window.__suka.eventBus = eventBus;
  } catch {}

  // automationRuntime ✅ FIX: glob-based so missing file won't break build
  try {
    const mod = await loadFirstModuleFromMap(AUTOMATION_RUNTIME_MODULES, [
      "./services/automation/runtime.js",
      "./services/automation/runtime.jsx",
      "./services/automation/runtime.ts",
      "./services/automation/runtime.tsx",
      "./services/automation/runtime/index.js",
      "./services/automation/runtime/index.jsx",
      "./services/automation/Runtime.js",
      "./services/automation/Runtime.jsx",
      "./services/automation/Runtime.ts",
      "./services/automation/Runtime.tsx",
    ]);
    automationRuntime = mod || automationRuntime;
    window.__suka.automationRuntime = automationRuntime;
  } catch {}

  // HouseholdReasoner ✅ FIX: glob-based so missing file won't break build
  try {
    const mod = await loadFirstModuleFromMap(HOUSEHOLD_REASONER_MODULES, [
      "./agents/shims/HouseholdReasoner.js",
      "./agents/shims/HouseholdReasoner.jsx",
      "./agents/shims/HouseholdReasoner.ts",
      "./agents/shims/HouseholdReasoner.tsx",
      "./agents/HouseholdReasoner.js",
      "./agents/HouseholdReasoner.jsx",
      "./agents/HouseholdReasoner.ts",
      "./agents/HouseholdReasoner.tsx",
      "./services/reasoner/HouseholdReasoner.js",
      "./services/reasoner/HouseholdReasoner.jsx",
      "./services/reasoner/HouseholdReasoner.ts",
      "./services/reasoner/HouseholdReasoner.tsx",
    ]);
    HouseholdReasoner = mod || HouseholdReasoner;
    window.__suka.householdReasoner = HouseholdReasoner;
  } catch {}

  // SessionRunnerModal (pick first existing candidate)
  try {
    SessionRunnerModal =
      (await loadFirstModuleFromMap(SESSION_RUNNER_MODULES, [
        // ✅ prefer features/session modal
        "./features/session/SessionRunnerModal.jsx",
        "./features/session/SessionRunnerModal.tsx",
        // legacy fallbacks
        "./components/session/SessionRunnerModal.jsx",
        "./components/session/SessionRunner.jsx",
        "./components/session/SessionRunnerHost.jsx",
        "./components/session/SessionRunnerModal.tsx",
        "./components/session/SessionRunner.tsx",
        "./components/session/SessionRunnerHost.tsx",
      ])) || null;
    window.__suka.SessionRunnerModal = SessionRunnerModal;
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* Vite page registry + helpers                                               */
/* -------------------------------------------------------------------------- */
// Vite will statically collect every page file that matches this pattern.
// Keys will look like: "./pages/home.jsx", "./pages/cooking/index.jsx", etc.
const PAGE_MODULES = import.meta.glob("./pages/**/*.{jsx,tsx}");

/**
 * Normalize a dynamic specifier so that "@/pages/..." becomes "./pages/..."
 * This keeps the browser from choking on bare "@" when @vite-ignore is used.
 */
function normalizeDynamicSpecifier(path) {
  if (!path || typeof path !== "string") return path;
  if (path.startsWith("@/pages/")) {
    return path.replace(/^@\//, "./");
  }
  return path;
}

/**
 * Given an array of candidate strings, try to find a matching key
 * in PAGE_MODULES (which only knows about ./pages/**).
 */
function resolvePageLoaderFromCandidates(candidates = []) {
  for (const raw of candidates) {
    const spec = normalizeDynamicSpecifier(raw);
    const idx = spec.indexOf("/pages/");
    if (idx === -1) continue;
    const subPath = spec.slice(idx); // "/pages/home.jsx" or "/pages/home/index.jsx"
    const key = `.${subPath}`; // "./pages/home.jsx"
    if (Object.prototype.hasOwnProperty.call(PAGE_MODULES, key)) {
      return PAGE_MODULES[key]; // () => import("...")
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Lazy page helper — tolerant of file vs folder paths                         */
/* 🔧 UPDATED to avoid "@/pages/..." runtime spec errors                        */
/* -------------------------------------------------------------------------- */
function lazyPage(candidates = [], FallbackName = "Page") {
  // First try to resolve via PAGE_MODULES (only ./pages/**)
  const pageLoader = resolvePageLoaderFromCandidates(candidates);
  if (pageLoader) {
    if (import.meta.env.DEV) {
      console.info(
        `[lazyPage] Using PAGE_MODULES loader for ${FallbackName}`,
        candidates,
      );
    }
    // React.lazy can take the () => import() function directly
    return React.lazy(pageLoader);
  }

  // Fallback: dynamic import each candidate in order (for non-pages like "@/domain/...")
  return React.lazy(async () => {
    for (const raw of candidates) {
      const p = normalizeDynamicSpecifier(raw);
      try {
        const mod = await import(/* @vite-ignore */ p);
        if (mod?.default) return { default: mod.default };
        return mod;
      } catch (err) {
        // 👉 Log why this candidate failed (only in dev so prod stays clean)
        if (import.meta.env.DEV) {
          console.warn(`[lazyPage] Failed to load candidate "${p}"`, err);
        }
      }
    }

    if (import.meta.env.DEV) {
      console.warn(
        `[lazyPage] All candidates failed for ${FallbackName}`,
        candidates,
      );
    }

    return {
      default: () => (
        <div className="p-6 text-sm text-rose-600">
          {FallbackName} page missing. Create one of:
          <pre className="mt-2 text-xs bg-neutral-50 border border-neutral-200 rounded-xl p-2">
            {candidates.map((c) => `- ${c}`).join("\n")}
          </pre>
        </div>
      ),
    };
  });
}

/* ------------------------------- Lazy pages ------------------------------- */
const Home = lazyPage(
  ["@/pages/home.jsx", "./pages/home.jsx", "@/pages/home/index.jsx"],
  "Home",
);

/** Domains */
const Inventory = lazyPage(
  [
    "@/pages/inventory.jsx",
    "./pages/inventory.jsx",
    "@/pages/inventory/index.jsx",
  ],
  "Inventory",
);

const Cooking = lazyPage(
  [
    "@/pages/cooking/index.jsx",
    "./pages/cooking/index.jsx",
    "@/domain/meals/MealPlanner.jsx",
  ],
  "Cooking",
);

const Cleaning = lazyPage(
  [
    "@/pages/cleaning.jsx",
    "./pages/cleaning.jsx",
    "@/pages/cleaning/index.jsx",
    "@/domain/cleaning/CleaningPlanner.jsx",
  ],
  "Cleaning",
);

const Garden = lazyPage(
  [
    "@/pages/garden/index.jsx",
    "./pages/garden/index.jsx",
    "@/pages/garden/GardenPage.jsx",
    "./pages/garden.jsx",
  ],
  "Garden",
);

const Animals = lazyPage(
  [
    "@/pages/animals/index.jsx",
    "./pages/animals/index.jsx",
    "@/pages/animals/AnimalsPage.jsx",
    "./pages/animals.jsx",
  ],
  "Animals",
);

/** NEW: Play/Remote surfaces per domain (mobile runner + controller/overlay) */
// Cooking
const CookingPlay = lazyPage(
  [
    "@/pages/cooking/Play.jsx",
    "./pages/cooking/Play.jsx",
    "@/pages/cooking/play/index.jsx",
    "./pages/cooking/play/index.jsx",
    "@/pages/cooking/play.jsx",
  ],
  "CookingPlay",
);

const CookingRemote = lazyPage(
  [
    "@/pages/cooking/Remote.jsx",
    "./pages/cooking/Remote.jsx",
    "@/pages/cooking/remote/index.jsx",
    "./pages/cooking/remote/index.jsx",
    "@/pages/cooking/remote.jsx",
  ],
  "CookingRemote",
);

// Cleaning
const CleaningPlay = lazyPage(
  [
    "@/pages/cleaning/Play.jsx",
    "./pages/cleaning/Play.jsx",
    "@/pages/cleaning/play/index.jsx",
    "./pages/cleaning/play/index.jsx",
    "@/pages/cleaning/play.jsx",
  ],
  "CleaningPlay",
);

const CleaningRemote = lazyPage(
  [
    "@/pages/cleaning/Remote.jsx",
    "./pages/cleaning/Remote.jsx",
    "@/pages/cleaning/remote/index.jsx",
    "./pages/cleaning/remote/index.jsx",
    "@/pages/cleaning/remote.jsx",
  ],
  "CleaningRemote",
);

// Garden
const GardenPlay = lazyPage(
  [
    "@/pages/garden/Play.jsx",
    "./pages/garden/Play.jsx",
    "@/pages/garden/play/index.jsx",
    "./pages/garden/play/index.jsx",
    "@/pages/garden/play.jsx",
  ],
  "GardenPlay",
);

const GardenRemote = lazyPage(
  [
    "@/pages/garden/Remote.jsx",
    "./pages/garden/Remote.jsx",
    "@/pages/garden/remote/index.jsx",
    "./pages/garden/remote/index.jsx",
    "@/pages/garden/remote.jsx",
  ],
  "GardenRemote",
);

// Animals
const AnimalsPlay = lazyPage(
  [
    "@/pages/animals/Play.jsx",
    "./pages/animals/Play.jsx",
    "@/pages/animals/play/index.jsx",
    "./pages/animals/play/index.jsx",
    "@/pages/animals/play.jsx",
  ],
  "AnimalsPlay",
);

const AnimalsRemote = lazyPage(
  [
    "@/pages/animals/Remote.jsx",
    "./pages/animals/Remote.jsx",
    "@/pages/animals/remote/index.jsx",
    "./pages/animals/remote/index.jsx",
    "@/pages/animals/remote.jsx",
  ],
  "AnimalsRemote",
);

/** General nav */
const CustomLocations = lazyPage(
  ["./pages/custom-locations.jsx", "./pages/custom-locations.jsx"],
  "CustomLocations",
);
const CalendarPage = lazyPage(
  ["@/pages/calendar.jsx", "./pages/calendar.jsx"],
  "Calendar",
);
const CommunityPage = lazyPage(
  ["./pages/community.jsx", "./pages/community.jsx"],
  "Community",
);
const BadgesPage = lazyPage(
  ["./pages/badges.jsx", "./pages/badges.jsx"],
  "Badges",
);

/* ✅ UPDATED: Meal Planner page path (folder-based) */
const MealPlanningPage = lazyPage(
  [
    "@/pages/mealplanner/mealplanner.jsx",
    "./pages/mealplanner/mealplanner.jsx",
  ],
  "MealPlanning",
);

const JobsPage = lazyPage(["./pages/jobs.jsx", "./pages/jobs.jsx"], "Jobs");

/* ✅ FIX: Roles route should use the real roles page (not jobs) */
const RolesPage = lazyPage(["./pages/roles.jsx", "@/pages/roles.jsx"], "Roles");

/** Storehouse */
/* ✅ UPDATED: Storehouse page path (folder-based) */
const StorehousePage = lazyPage(
  ["@/pages/storehouse/storehouse.jsx", "./pages/storehouse/storehouse.jsx"],
  "Storehouse",
);

const StorehouseAutoFillPlanner = lazyPage(
  [
    "@/domain/storehouse/AutoFillPlanner.jsx",
    "./components/storehouse/StorehouseAutoFillPlanner.jsx",
  ],
  "StorehouseAutoFill",
);

const PreservationQueuePlanner = lazyPage(
  [
    "@/domain/storehouse/PreserveQueue.jsx",
    "./components/storehouse/PreservationQueuePlanner.jsx",
  ],
  "PreservationQueue",
);

/** NEW: Homestead + Knowledge (and Knowledge panels) */
/* ✅ UPDATED: Homestead Planner page path (subroutes; Overview is index.jsx) */
/* ✅ NOTE: Your real path is: src/pages/homesteadplanner/index.jsx */
const HomesteadPage = lazyPage(
  [
    "@/pages/homesteadplanner/index.jsx",
    "./pages/homesteadplanner/index.jsx",
    // legacy fallback (keep existing working file if present)
    "@/pages/homesteadplanner/homestead.jsx",
    "./pages/homesteadplanner/homestead.jsx",
  ],
  "HomesteadOverview",
);

const HomesteadTargetsPage = lazyPage(
  [
    "@/pages/homesteadplanner/targets.jsx",
    "./pages/homesteadplanner/targets.jsx",
  ],
  "HomesteadTargets",
);

const HomesteadComponentsPage = lazyPage(
  [
    "@/pages/homesteadplanner/components.jsx",
    "./pages/homesteadplanner/components.jsx",
  ],
  "HomesteadComponents",
);

const HomesteadInventoryPage = lazyPage(
  [
    "@/pages/homesteadplanner/inventory.jsx",
    "./pages/homesteadplanner/inventory.jsx",
  ],
  "HomesteadInventory",
);

const HomesteadBatchesPage = lazyPage(
  [
    "@/pages/homesteadplanner/batches.jsx",
    "./pages/homesteadplanner/batches.jsx",
  ],
  "HomesteadBatches",
);

const HomesteadGardenTargetsPage = lazyPage(
  [
    "@/pages/homesteadplanner/garden-targets.jsx",
    "./pages/homesteadplanner/garden-targets.jsx",
  ],
  "HomesteadGardenTargets",
);

const HomesteadAnimalTargetsPage = lazyPage(
  [
    "@/pages/homesteadplanner/animal-targets.jsx",
    "./pages/homesteadplanner/animal-targets.jsx",
  ],
  "HomesteadAnimalTargets",
);

const HomesteadCuisinesPage = lazyPage(
  [
    "@/pages/homesteadplanner/cuisines.jsx",
    "./pages/homesteadplanner/cuisines.jsx",
  ],
  "HomesteadCuisines",
);

const HomesteadPreferencesPage = lazyPage(
  [
    "@/pages/homesteadplanner/preferences.jsx",
    "./pages/homesteadplanner/preferences.jsx",
  ],
  "HomesteadPreferences",
);

const HomesteadSkillsPage = lazyPage(
  [
    "@/pages/homesteadplanner/skills.jsx",
    "./pages/homesteadplanner/skills.jsx",
  ],
  "HomesteadSkills",
);

// ✅ Put the RELATIVE path first so it works with @vite-ignore dynamic import
const KnowledgePage = lazyPage(
  [
    "./pages/knowledge.jsx",
    "@/pages/knowledge.jsx",
    "./pages/knowledge/index.jsx",
    "./pages/knowledge-base.jsx",
  ],
  "Knowledge",
);

/* 🔧 Expanded candidates here (alias + relative for both page and feature) */
const KnowledgeEvents = lazyPage(
  [
    "@/pages/knowledge/events.jsx",
    "./pages/knowledge/events.jsx",
    "@/features/events/EventCatalog.jsx",
    "./features/events/EventCatalog.jsx",
  ],
  "EventCatalog",
);

const KnowledgeYieldCurves = lazyPage(
  [
    "@/pages/knowledge/yield-curves.jsx",
    "./pages/knowledge/yield-curves.jsx",
    "@/features/yield/YieldCurves.jsx",
    "./features/yield/YieldCurves.jsx",
  ],
  "YieldCurves",
);

const KnowledgeRules = lazyPage(
  [
    "@/pages/knowledge/rules.jsx",
    "./pages/knowledge/rules.jsx",
    "@/features/inventory/InventoryRules.jsx",
    "./features/inventory/InventoryRules.jsx",
  ],
  "InventoryRules",
);

const KnowledgeDocs = lazyPage(
  [
    "@/pages/knowledge/docs.jsx",
    "./pages/knowledge/docs.jsx",
    "@/features/docs/DocsIndex.jsx",
    "./features/docs/DocsIndex.jsx",
  ],
  "Docs",
);

/** Import Settings + Scan/Extreme couponing + Tools */
const ImportSettings = lazyPage(
  ["@/features/import/ImportSettings.jsx", "./pages/import/settings.jsx"],
  "ImportSettings",
);
const ScanExtreme = lazyPage(
  [
    "@/features/scan-compare-trust/ExtremeCouponing.jsx",
    "./pages/scan/index.jsx",
  ],
  "ScanExtreme",
);
const MacroCalc = lazyPage(
  ["@/tools/MacroCalculator.jsx", "./pages/tools/macro-calculator.jsx"],
  "MacroCalculator",
);
const BmiCalc = lazyPage(
  ["@/tools/BMICalculator.jsx", "./pages/tools/bmi-calculator.jsx"],
  "BMICalculator",
);
const MultiTimer = lazyPage(
  ["@/tools/MultiTimerPanel.jsx", "./pages/tools/multi-timer.jsx"],
  "MultiTimer",
);

/** NEW: Favorites – user-saved sessions & schedules (cross-domain) */
const FavoritesPage = lazyPage(
  ["./pages/favorites/index.jsx", "@/pages/favorites/index.jsx"],
  "Favorites",
);

/**
 * ✅ FIX: Household meals route should load the real page first.
 * Your project includes:
 * - src/pages/household/meals.jsx (primary dashboard page)
 * - src/pages/household/HouseholdMealsCuisine.jsx (editor/settings page)
 */
const HouseholdMealsCuisinePage = lazyPage(
  [
    "@/pages/household/meals.jsx",
    "./pages/household/meals.jsx",
    "@/pages/household/HouseholdMealsCuisine.jsx",
    "./pages/household/HouseholdMealsCuisine.jsx",
  ],
  "HouseholdMeals",
);

/* ✅ Settings route factory */
import getSettingsRoutes from "./pages/settings/routes.jsx";

/* ✅ Automation bridge + floating HUD */
import FloatingAutomationPanel from "@/components/automation/FloatingAutomationPanel";
import { installAutomationBridge } from "@/bridges/automation/AutomationBridge";

/* ----------------------------- App scaffolding ---------------------------- */
function Loader() {
  return <div className="p-4 text-sm text-neutral-500">Loading...</div>;
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-4">
          <div className="text-lg font-semibold">Something went wrong.</div>
          <pre className="mt-2 text-xs bg-neutral-50 border border-neutral-200 rounded-xl p-3 overflow-auto">
            {String(this.state.error?.message || this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

async function safeDynImport(path) {
  try {
    const spec = normalizeDynamicSpecifier(path);
    return await import(/* @vite-ignore */ spec);
  } catch {
    return null;
  }
}

async function prewarmCandidates(candidates = []) {
  for (const p of candidates) {
    const ok = await safeDynImport(p);
    if (ok) return ok;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* DEV prewarm – candidate-based                                              */
/* -------------------------------------------------------------------------- */
async function prewarmAllRoutesDev() {
  if (!import.meta.env.DEV) return;

  const groups = [
    ["@/pages/home.jsx", "./pages/home.jsx", "./pages/home/index.jsx"],
    [
      "@/pages/inventory.jsx",
      "./pages/inventory.jsx",
      "@/pages/inventory/index.jsx",
    ],
    [
      "@/pages/cooking/index.jsx",
      "./pages/cooking/index.jsx",
      "@/domain/meals/MealPlanner.jsx",
    ],
    [
      "@/pages/cleaning.jsx",
      "./pages/cleaning.jsx",
      "@/pages/cleaning/index.jsx",
      "@/domain/cleaning/CleaningPlanner.jsx",
    ],
    [
      "@/pages/garden/index.jsx",
      "./pages/garden/index.jsx",
      "@/pages/garden/GardenPage.jsx",
      "./pages/garden.jsx",
    ],
    [
      "@/pages/animals/index.jsx",
      "./pages/animals/index.jsx",
      "@/pages/animals/AnimalsPage.jsx",
      "./pages/animals.jsx",
    ],

    /* ✅ UPDATED: Meal Planner prewarm */
    [
      "@/pages/mealplanner/mealplanner.jsx",
      "./pages/mealplanner/mealplanner.jsx",
    ],

    /* ✅ NEW: Household meals page prewarm */
    ["@/pages/household/meals.jsx", "./pages/household/meals.jsx"],

    ["@/pages/calendar.jsx", "./pages/calendar.jsx"],
    ["./pages/community.jsx", "./pages/community.jsx"],
    ["./pages/badges.jsx", "./pages/badges.jsx"],
    ["./pages/settings/routes.jsx"],

    /* ✅ UPDATED: Storehouse prewarm */
    ["@/pages/storehouse/storehouse.jsx", "./pages/storehouse/storehouse.jsx"],
    [
      "@/domain/storehouse/AutoFillPlanner.jsx",
      "./components/storehouse/StorehouseAutoFillPlanner.jsx",
    ],
    [
      "@/domain/storehouse/PreserveQueue.jsx",
      "./components/storehouse/PreservationQueuePlanner.jsx",
    ],

    ["./pages/custom-locations.jsx", "./pages/custom-locations.jsx"],
    ["./pages/roles.jsx", "@/pages/roles.jsx"],
    ["./pages/jobs.jsx", "./pages/jobs.jsx"],

    /* ✅ UPDATED: Homestead Planner prewarm (overview + subroutes) */
    [
      "@/pages/homesteadplanner/index.jsx",
      "./pages/homesteadplanner/index.jsx",
      "@/pages/homesteadplanner/homestead.jsx",
      "./pages/homesteadplanner/homestead.jsx",
    ],
    [
      "@/pages/homesteadplanner/targets.jsx",
      "./pages/homesteadplanner/targets.jsx",
    ],
    [
      "@/pages/homesteadplanner/components.jsx",
      "./pages/homesteadplanner/components.jsx",
    ],
    [
      "@/pages/homesteadplanner/inventory.jsx",
      "./pages/homesteadplanner/inventory.jsx",
    ],
    [
      "@/pages/homesteadplanner/batches.jsx",
      "./pages/homesteadplanner/batches.jsx",
    ],
    [
      "@/pages/homesteadplanner/garden-targets.jsx",
      "./pages/homesteadplanner/garden-targets.jsx",
    ],
    [
      "@/pages/homesteadplanner/animal-targets.jsx",
      "./pages/homesteadplanner/animal-targets.jsx",
    ],
    [
      "@/pages/homesteadplanner/cuisines.jsx",
      "./pages/homesteadplanner/cuisines.jsx",
    ],
    [
      "@/pages/homesteadplanner/preferences.jsx",
      "./pages/homesteadplanner/preferences.jsx",
    ],
    [
      "@/pages/homesteadplanner/skills.jsx",
      "./pages/homesteadplanner/skills.jsx",
    ],

    [
      "./pages/knowledge.jsx",
      "@/pages/knowledge.jsx",
      "./pages/knowledge/index.jsx",
      "./pages/knowledge-base.jsx",
    ],
    [
      "@/pages/knowledge/events.jsx",
      "./pages/knowledge/events.jsx",
      "@/features/events/EventCatalog.jsx",
      "./features/events/EventCatalog.jsx",
    ],
    [
      "@/pages/knowledge/yield-curves.jsx",
      "./pages/knowledge/yield-curves.jsx",
      "@/features/yield/YieldCurves.jsx",
      "./features/yield/YieldCurves.jsx",
    ],
    [
      "@/pages/knowledge/rules.jsx",
      "./pages/knowledge/rules.jsx",
      "@/features/inventory/InventoryRules.jsx",
      "./features/inventory/InventoryRules.jsx",
    ],
    [
      "@/pages/knowledge/docs.jsx",
      "./pages/knowledge/docs.jsx",
      "@/features/docs/DocsIndex.jsx",
      "./features/docs/DocsIndex.jsx",
    ],

    [
      "@/features/scan-compare-trust/ExtremeCouponing.jsx",
      "./pages/scan/index.jsx",
    ],
    ["@/tools/MacroCalculator.jsx", "./pages/tools/macro-calculator.jsx"],
    ["@/tools/BMICalculator.jsx", "./pages/tools/bmi-calculator.jsx"],
    ["@/tools/MultiTimerPanel.jsx", "./pages/tools/multi-timer.jsx"],
    ["@/features/import/ImportSettings.jsx", "./pages/import/settings.jsx"],

    // NEW: prewarm domain Play/Remote (dev only)
    [
      "@/pages/cooking/Play.jsx",
      "./pages/cooking/Play.jsx",
      "@/pages/cooking/play/index.jsx",
      "./pages/cooking/play/index.jsx",
      "@/pages/cooking/play.jsx",
    ],
    [
      "@/pages/cooking/Remote.jsx",
      "./pages/cooking/Remote.jsx",
      "@/pages/cooking/remote/index.jsx",
      "./pages/cooking/remote/index.jsx",
      "@/pages/cooking/remote.jsx",
    ],
    [
      "@/pages/cleaning/Play.jsx",
      "./pages/cleaning/Play.jsx",
      "@/pages/cleaning/play/index.jsx",
      "./pages/cleaning/play/index.jsx",
      "@/pages/cleaning/play.jsx",
    ],
    [
      "@/pages/cleaning/Remote.jsx",
      "./pages/cleaning/Remote.jsx",
      "@/pages/cleaning/remote/index.jsx",
      "./pages/cleaning/remote/index.jsx",
      "@/pages/cleaning/remote.jsx",
    ],
    [
      "@/pages/garden/Play.jsx",
      "./pages/garden/Play.jsx",
      "@/pages/garden/play/index.jsx",
      "./pages/garden/play/index.jsx",
      "@/pages/garden/play.jsx",
    ],
    [
      "@/pages/garden/Remote.jsx",
      "./pages/garden/Remote.jsx",
      "@/pages/garden/remote/index.jsx",
      "./pages/garden/remote/index.jsx",
      "@/pages/garden/remote.jsx",
    ],
    [
      "@/pages/animals/Play.jsx",
      "./pages/animals/Play.jsx",
      "@/pages/animals/play/index.jsx",
      "./pages/animals/play/index.jsx",
      "@/pages/animals/play.jsx",
    ],
    [
      "@/pages/animals/Remote.jsx",
      "./pages/animals/Remote.jsx",
      "@/pages/animals/remote/index.jsx",
      "./pages/animals/remote/index.jsx",
      "@/pages/animals/remote.jsx",
    ],

    // NEW: Favorites (user-saved sessions & schedules)
    ["./pages/favorites/index.jsx", "@/pages/favorites/index.jsx"],
  ];

  try {
    await Promise.all(groups.map((cands) => prewarmCandidates(cands)));
  } catch {}
}

function EnsureContent({ children, fallback }) {
  const ref = React.useRef(null);
  const [empty, setEmpty] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    requestAnimationFrame(() => {
      const isEmpty =
        el.childElementCount === 0 &&
        (el.textContent || "").trim().length === 0;
      if (isEmpty) setEmpty(true);
    });
  }, []);

  if (empty) return fallback || null;
  return <div ref={ref}>{children}</div>;
}

/* -------------------------- Sidebar Nav -------------------------- */
const ACTIVE_BG = "#3b82f6";
const ACTIVE_FG = "#ffffff";

function NavItem({ to, icon, label, end = false }) {
  return (
    <li style={{ listStyle: "none" }}>
      <NavLink
        to={to}
        end={end}
        className={({ isActive }) =>
          `nav-pill${isActive ? " active is-active" : ""}`
        }
        style={({ isActive }) => {
          const base = {
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderRadius: 9999,
            textDecoration: "none",
            padding: "9px 14px",
            fontSize: 16,
            lineHeight: "20px",
            transition:
              "background .12s ease, color .12s ease, box-shadow .12s ease",
          };
          if (isActive) {
            return {
              ...base,
              backgroundColor: ACTIVE_BG,
              color: ACTIVE_FG,
              fontWeight: 700,
              boxShadow: "0 6px 18px rgba(59,130,246,0.25)",
            };
          }
          return {
            ...base,
            backgroundColor: "transparent",
            color: "inherit",
            fontWeight: 500,
          };
        }}
      >
        <span className="shrink-0">{icon}</span>
        <span>{label}</span>
      </NavLink>
    </li>
  );
}

/* ------------------------------- Undo/NBA Dock ----------------------------- */
function SmallBadge({ tone = "zinc", label }) {
  const toneMap = {
    warning: "bg-amber-100 text-amber-800 border-amber-200",
    info: "bg-sky-100 text-sky-800 border-sky-200",
    zinc: "bg-neutral-100 text-neutral-800 border-neutral-200",
  };
  const cls = toneMap[tone] || toneMap.zinc;
  return (
    <span
      className={`inline-flex items-center border ${cls} text-xs px-2 py-0.5 rounded-full mr-2`}
    >
      {label}
    </span>
  );
}

function TButton({ variant = "ghost", size = "sm", children, ...props }) {
  const sizes = { sm: "text-sm px-3 py-1.5", md: "text-sm px-3.5 py-2" };
  const variants = {
    ghost: "hover:bg-neutral-100 border border-transparent",
    outline: "border border-neutral-300 hover:bg-neutral-50",
    primary:
      "bg-indigo-600 text-white hover:bg-indigo-700 border border-indigo-600",
  };
  return (
    <button
      className={`rounded-2xl ${sizes[size]} ${variants[variant]} transition`}
      {...props}
    >
      {children}
    </button>
  );
}

function Panel({ children }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="p-3">{children}</div>
    </div>
  );
}

function UndoNbaDock() {
  const [offer, setOffer] = React.useState(null);
  const [nba, setNba] = React.useState(null);

  React.useEffect(() => {
    const onOffer = (e) => setOffer(e.detail || null);
    const onNba = (e) => setNba(e.detail || null);
    window.addEventListener("ui.undo.offer", onOffer);
    window.addEventListener("ui.nba.suggest", onNba);
    return () => {
      window.removeEventListener("ui.undo.offer", onOffer);
      window.removeEventListener("ui.nba.suggest", onNba);
    };
  }, []);

  if (!offer && !nba) return null;

  return (
    <div className="fixed bottom-3 left-0 right-0 mx-auto max-w-5xl px-4 z-40">
      <div className="flex flex-col md:flex-row gap-2 justify-center">
        {offer && (
          <Panel>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm opacity-80">
                <SmallBadge tone="warning" label="Undo" />
                {offer.label || "Revert last step?"}
              </div>
              <div className="flex gap-2">
                <TButton
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    try {
                      Jobs.emit?.("jobs.undo.perform", { token: offer.token });
                    } catch {}
                    setOffer(null);
                  }}
                >
                  Undo
                </TButton>
                <TButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setOffer(null)}
                >
                  Dismiss
                </TButton>
              </div>
            </div>
          </Panel>
        )}

        {nba && (
          <Panel>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm opacity-80">
                <SmallBadge tone="info" label="Next" />
                {nba.label}
              </div>
              <a
                href={nba.href || "#"}
                onClick={nba.onClick}
                className="rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-3 py-1.5"
              >
                {nba.cta || "Do it"}
              </a>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

/* -------------------------- Orchestration Bridge -------------------------- */
function OrchestrationBridge() {
  const location = useLocation();

  React.useEffect(() => {
    try {
      installAutomationBridge?.();
    } catch {}
  }, []);

  React.useEffect(() => {
    const init = () => {
      try {
        automationRuntime?.initAutomationRuntime?.();
      } catch {}
    };
    if (!window.__suka) window.__suka = {};
    if (!window.__suka.automationInitialized) {
      init();
      window.__suka.automationInitialized = true;
    }
  }, []);

  React.useEffect(() => {
    const routeEvt = {
      type: "route.changed",
      ts: new Date().toISOString(),
      source: "app.router",
      data: { path: location.pathname },
    };
    safeEmit("route.changed", routeEvt);
    try {
      automationRuntime?.handleEvent?.(routeEvt);
    } catch {}
    try {
      HouseholdReasoner?.handleEvent?.(routeEvt);
    } catch {}
  }, [location.pathname]);

  React.useEffect(() => {
    const onMessage = (evt) => {
      const msg = evt.data;
      if (!msg || typeof msg !== "object") return;

      const envelope = {
        type: msg.type || "external.message",
        ts: new Date().toISOString(),
        source: "app.messageBridge",
        data: msg.payload || msg.data || {},
      };

      safeEmit(envelope.type, envelope);

      // Normalize imports from outside surfaces (recipes, cleaning, garden, animals, storehouse)
      if (msg.type === "import.normalized") {
        const parsedEvt = { ...envelope, type: "import.parsed" };
        try {
          automationRuntime?.handleEvent?.(parsedEvt);
        } catch {}
        try {
          HouseholdReasoner?.handleEvent?.(parsedEvt);
        } catch {}
        return;
      }

      // Favorites & automation-related requests (sessions/schedules)
      if (
        msg.type === "automation.schedule.request" ||
        msg.type === "reverse.action.request" ||
        msg.type === "session.favorite.saved" ||
        msg.type === "schedule.favorite.saved"
      ) {
        try {
          automationRuntime?.handleEvent?.(envelope);
        } catch {}
        try {
          HouseholdReasoner?.handleEvent?.(envelope);
        } catch {}
        return;
      }

      // Generic fall-through: let automation + reasoner observe cross-domain events
      try {
        automationRuntime?.handleEvent?.(envelope);
      } catch {}
      try {
        HouseholdReasoner?.handleEvent?.(envelope);
      } catch {}
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return null;
}

function safeEmit(type, detail) {
  try {
    eventBus?.emit?.(type, detail);
    window.dispatchEvent?.(new CustomEvent(type, { detail }));
    const bus = window.__suka?.eventBus;
    bus?.emit?.(type, detail);
  } catch {}
}

/**
 * ✅ NEW: Global SessionRunner host
 * - Listens for session.play.requested (cleaning/garden/animals + cooking)
 * - Opens the centrally-mounted SessionRunner modal:
 *   1) try window.__suka.sessionRunner.open(payload)
 *   2) else dispatch window event "ui.sessionrunner.open"
 *   3) ✅ FIX: if no modal catches it, navigate to /:domain/play/:id
 * - ✅ FIX (Stack overflow): guard against re-entrant openRunner loops where ui.sessionrunner.open triggers our own listener again.
 */
function GlobalSessionRunnerHost() {
  const location = useLocation();
  const navigate = useNavigate(); // ✅ FIX: fallback route push

  // ✅ Local modal state (supports features/session/SessionRunnerModal.jsx)
  const [modalOpen, setModalOpen] = React.useState(false);
  const [modalDomain, setModalDomain] = React.useState("cooking");

  // ✅ Re-entrancy / recursion guard
  const _runnerOpenLockRef = React.useRef(false);
  const _runnerOpenLastKeyRef = React.useRef("");

  const shouldBlockRunnerOpen = React.useCallback((sessionId) => {
    const sid = String(sessionId || "");
    const key = sid || "no-session-id";
    if (_runnerOpenLockRef.current) return true;
    if (_runnerOpenLastKeyRef.current === key) return true;

    _runnerOpenLockRef.current = true;
    _runnerOpenLastKeyRef.current = key;

    // Release lock next tick; keep lastKey briefly to avoid same-tick loops.
    queueMicrotask(() => {
      _runnerOpenLockRef.current = false;
      setTimeout(() => {
        if (_runnerOpenLastKeyRef.current === key) {
          _runnerOpenLastKeyRef.current = "";
        }
      }, 150);
    });

    return false;
  }, []);

  // ✅ Modal open listener (if a modal exists, it can “catch” ui.sessionrunner.open)
  React.useEffect(() => {
    if (!window.__suka) window.__suka = {};

    const mapDomainToModal = (d) => {
      // Keep this conservative—your modal supports these domain keys.
      if (d === "garden") return "garden_care";
      if (d === "animals") return "animals_care";
      if (d === "cleaning") return "cleaning";
      return "cooking";
    };

    const onUiOpen = (evt) => {
      const payload = evt?.detail || {};
      try {
        // Mark as handled so the dispatcher doesn’t navigate to /:domain/play/:id
        window.__suka.__sessionRunnerHandled = true;
      } catch {}
      setModalDomain(mapDomainToModal(payload.domain));
      setModalOpen(true);
    };

    window.addEventListener("ui.sessionrunner.open", onUiOpen);
    return () => window.removeEventListener("ui.sessionrunner.open", onUiOpen);
  }, []);

  React.useEffect(() => {
    if (!window.__suka) window.__suka = {};

    const inferDomainFromPath = (path) => {
      if (!path) return "unknown";
      if (path.startsWith("/cleaning")) return "cleaning";
      if (path.startsWith("/garden")) return "garden";
      if (path.startsWith("/animals")) return "animals";
      if (path.startsWith("/cooking")) return "cooking";
      return "unknown";
    };

    const ensureId = (maybeId) => {
      if (maybeId) return maybeId;
      return `draft_${Date.now()}`;
    };

    const toOpenPayload = (envelope) => {
      const data =
        envelope?.data ||
        envelope?.detail?.data ||
        envelope?.detail ||
        envelope ||
        {};
      const inferred = inferDomainFromPath(location.pathname);
      const domain =
        data?.domain ||
        data?.session?.domain ||
        data?.payload?.domain ||
        data?.payload?.session?.domain ||
        inferred;

      const id =
        data?.id ||
        data?.session?.id ||
        data?.payload?.id ||
        data?.payload?.session?.id ||
        data?.sessionId ||
        data?.draftId ||
        null;

      const session = data?.session || data?.payload?.session || null;

      return {
        ts: new Date().toISOString(),
        source: "app.globalSessionRunnerHost",
        domain,
        id: ensureId(id),
        session,
        raw: envelope,
      };
    };

    const navigateToPlay = (payload) => {
      const allowed = new Set(["cooking", "cleaning", "garden", "animals"]);
      if (!allowed.has(payload.domain)) return;

      // Don’t redirect if we're already on a Play route
      if ((location.pathname || "").includes("/play/")) return;

      try {
        navigate(`/${payload.domain}/play/${payload.id}`);
      } catch {}
    };

    const openRunner = (envelope) => {
      const payload = toOpenPayload(envelope);

      const allowed = new Set(["cooking", "cleaning", "garden", "animals"]);
      if (!allowed.has(payload.domain)) return;

      // ✅ Guard: block recursion / same-session tight loops
      if (shouldBlockRunnerOpen(payload.id)) return;

      // 1) Preferred: shared runner API
      try {
        const api = window.__suka?.sessionRunner;
        if (api && typeof api.open === "function") {
          api.open(payload);
          return;
        }
      } catch {}

      // 2) Try UI event a modal host might listen to
      // ✅ IMPORTANT: dispatching "ui.sessionrunner.open" can re-trigger our
      // own listener. The guard above prevents stack overflow.
      let dispatched = false;
      try {
        window.__suka.__sessionRunnerHandled = false;
      } catch {}

      try {
        window.dispatchEvent(
          new CustomEvent("ui.sessionrunner.open", { detail: payload }),
        );
        dispatched = true;
      } catch {}

      // ✅ If a modal caught it, stop here (don’t force /play)
      if (dispatched && window.__suka.__sessionRunnerHandled) {
        return;
      }

      // 3) Guaranteed fallback: route to Play surface
      if (dispatched) {
        Promise.resolve().then(() => navigateToPlay(payload));
      } else {
        navigateToPlay(payload);
      }
    };

    const onPlayRequested = (evt) => {
      const envelope = evt?.detail || evt;
      openRunner(envelope);
    };

    // ✅ NOTE: We no longer listen to "ui.sessionrunner.open" as an INPUT signal,
    // because we ourselves dispatch it. Listening would cause recursion loops.
    window.addEventListener("session.play.requested", onPlayRequested);
    window.addEventListener("play.started", onPlayRequested);

    let offBus = () => {};
    try {
      if (eventBus && typeof eventBus.on === "function") {
        const off1 = eventBus.on("session.play.requested", (envelope) =>
          openRunner(envelope),
        );
        const off2 = eventBus.on("play.started", (envelope) =>
          openRunner(envelope),
        );
        offBus = () => {
          try {
            off1?.();
          } catch {}
          try {
            off2?.();
          } catch {}
        };
      }
    } catch {}

    return () => {
      offBus?.();
      window.removeEventListener("session.play.requested", onPlayRequested);
      window.removeEventListener("play.started", onPlayRequested);
    };
  }, [location.pathname, navigate, shouldBlockRunnerOpen]);

  // ✅ Mount modal if available (extra props are safe for legacy components too)
  if (SessionRunnerModal) {
    return (
      <SessionRunnerModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        initialDomain={modalDomain}
      />
    );
  }
  return null;
}

/* ------------------------------- App Chrome ------------------------------- */
function AppChrome({ children }) {
  // ✅ NEW: only mount the Session Builder (GlobalSessionRunnerHost) on Home
  const location = useLocation();
  const isHome = (location?.pathname || "/") === "/";

  return (
    <div className="min-h-screen grid bg-background text-foreground">
      <style>{`
        .menu :where(li > .active:hover),
        .menu :where(li > a[aria-current="page"]:hover) {
          filter: brightness(0.95);
        }
      `}</style>

      <div
        className="app app--with-rightbar grid"
        style={{
          minHeight: "100%",
          display: "grid",
          gridTemplateColumns: "260px 1fr 320px",
          gridTemplateRows: "auto",
          gap: 0,
        }}
      >
        {/* LEFT SIDEBAR */}
        <aside
          className="sidebar bg-white"
          style={{
            borderRight: "1px solid #e5e7eb",
            padding: 12,
            overflow: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: "#111827",
              }}
            />
            <div style={{ fontWeight: 600 }}>Suka Smart Assistant</div>
          </div>

          <div className="px-3 pt-1 text-[11px] uppercase tracking-wide text-neutral-500">
            Home
          </div>

          <ul
            className="menu px-2 pt-1"
            style={{
              listStyle: "none",
              display: "grid",
              rowGap: 10,
              margin: "6px 0 14px",
              paddingLeft: 8,
              paddingRight: 8,
            }}
          >
            <NavItem to="/" icon="🏠" label="Home" end />
            <NavItem to="/calendar" icon="🗓️" label="Calendar" />
            <NavItem to="/meal-planning" icon="🍳" label="Meal Planner" />
            <NavItem to="/jobs" icon="🧰" label="Jobs" />
            <NavItem to="/storehouse" icon="📦" label="Storehouse" />
            <NavItem to="/community" icon="🤝" label="Community" />
            <NavItem to="/badges" icon="🏅" label="Badges" />
            {/* ✅ UPDATED: Homestead Planner only surfaces at /homesteadplanner */}
            <NavItem
              to="/homesteadplanner"
              icon="🏡"
              label="Homestead Planner"
            />
            <NavItem to="/favorites" icon="⭐" label="Favorites" />
            <NavItem to="/settings" icon="⚙️" label="Settings" />
          </ul>

          <div className="px-3 pt-3 text-[11px] uppercase tracking-wide text-neutral-500">
            Household
          </div>

          <ul
            className="menu px-2 pt-1"
            style={{
              listStyle: "none",
              display: "grid",
              rowGap: 10,
              marginTop: 8,
              paddingLeft: 8,
              paddingRight: 8,
            }}
          >
            <NavItem to="/inventory" icon="🧾" label="Inventory" />
            <NavItem to="/cooking" icon="🍲" label="Cooking" />
            <NavItem to="/cleaning" icon="🧼" label="Cleaning" />
            <NavItem to="/garden" icon="🌿" label="Garden" />
            <NavItem to="/animals" icon="🐓" label="Animal Care" />
            <NavItem
              to="/custom-locations"
              icon="📍"
              label="Custom Locations"
            />
            <NavItem to="/roles" icon="🗂️" label="Roles & Tasks" />
            <NavItem to="/knowledge" icon="📚" label="Knowledge Base" />
          </ul>
        </aside>

        {/* MAIN CONTENT */}
        <main className="min-h-screen overflow-auto p-3">
          <ErrorBoundary>
            <Suspense fallback={<Loader />}>{children}</Suspense>
          </ErrorBoundary>
        </main>

        {/* RIGHT SIDEBAR */}
        <div
          className="rightbar bg-white"
          style={{
            borderLeft: "1px solid #e5e7eb",
            padding: 8,
            overflow: "auto",
          }}
        >
          <ErrorBoundary>
            <Suspense
              fallback={
                <div style={{ padding: 8, fontSize: 12, color: "#9ca3af" }}>
                  Loading sidebar...
                </div>
              }
            >
              <RightSidebar />
            </Suspense>
          </ErrorBoundary>
        </div>

        {import.meta.env.DEV && (
          <div
            style={{
              position: "fixed",
              bottom: 8,
              left: 8,
              background: "#fef3c7",
              color: "#92400e",
              padding: "4px 8px",
              borderRadius: 6,
              fontSize: 11,
              boxShadow: "0 1px 6px rgba(0,0,0,.08)",
              pointerEvents: "none",
            }}
          >
            shell mounted
          </div>
        )}
      </div>

      {/* ✅ Mount global SessionRunner host ONLY on Home so Session Builder doesn't appear elsewhere */}
      {isHome ? <GlobalSessionRunnerHost /> : null}

      <UndoNbaDock />
      <FloatingAutomationPanel />
    </div>
  );
}

/* ------------------------ PWA Service Worker (prod) ------------------------ */
/**
 * ✅ FIX: The "MIME type text/html" module errors on localhost preview are
 * commonly caused by a stale Service Worker serving an old app shell (index.html)
 * that references /index.js, /index.js, /featureFlags.json, etc.
 *
 * So:
 * - On localhost/127.0.0.1, we proactively unregister SWs (prevents cache poison)
 * - In real prod, we register normally
 */
async function unregisterServiceWorkersOnLocalhost() {
  try {
    const host = window.location.hostname;
    const isLocal =
      host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
    if (!isLocal) return;
    if (!("serviceWorker" in navigator)) return;
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    console.info("[PWA] Unregistered service workers on localhost.");
  } catch {}
}

async function registerServiceWorkerIfProd() {
  if (!("serviceWorker" in navigator)) return;
  if (!import.meta.env.PROD) return;

  // ✅ Skip SW on localhost to avoid stale-cache module MIME errors
  const host = window.location.hostname;
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
  if (isLocal) return;

  const candidates = ["/sw.js", "/service-worker.js", "/pwa-sw.js"];
  for (const url of candidates) {
    try {
      const reg = await navigator.serviceWorker.register(url);
      console.info("[PWA] Service worker registered:", url, reg?.scope);
      return;
    } catch {
      // try next candidate
    }
  }
  console.warn("[PWA] No service worker registered from candidates.");
}

/* --------------------------------- App ------------------------------------ */
export default function App() {
  React.useEffect(() => {
    // ✅ FIX #1 boot (loads eventBus / runtime / reasoner / runner under Vite ESM)
    bootSoftModulesOnce();

    try {
      installAutomationBridge?.();
    } catch {}

    // ✅ FIX: stop SW from serving stale index.html on localhost preview
    unregisterServiceWorkersOnLocalhost();

    prewarmAllRoutesDev();
    registerServiceWorkerIfProd();
  }, []);

  const settingsRoutes = React.useMemo(
    () => getSettingsRoutes("/settings"),
    [],
  );

  return (
    <VisionProvider>
      {/* Router is provided by main.jsx */}
      <OrchestrationBridge />

      <AppChrome>
        <Routes>
          {/* Core */}
          <Route
            path="/"
            element={
              <EnsureContent
                fallback={
                  <div style={{ padding: 16 }}>
                    <div
                      style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}
                    >
                      Welcome 👋
                    </div>
                    <div style={{ fontSize: 13, color: "#6b7280" }}>
                      The <code>Home</code> page returned no visible content.
                      This is a safe stub so the app isn’t blank.
                    </div>
                  </div>
                }
              >
                <Home />
              </EnsureContent>
            }
          />

          {/* Household */}
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/cooking" element={<Cooking />} />
          <Route path="/cleaning" element={<Cleaning />} />
          <Route path="/garden" element={<Garden />} />
          <Route path="/animals" element={<Animals />} />
          <Route path="/custom-locations" element={<CustomLocations />} />

          {/* ✅ FIX: roles route uses RolesPage (not JobsPage) */}
          <Route path="/roles" element={<RolesPage />} />

          {/* NEW: Play/Remote execution routes (domain surfaces) */}
          {/* Cooking */}
          <Route path="/cooking/play/:id" element={<CookingPlay />} />
          <Route path="/cooking/remote/:room" element={<CookingRemote />} />

          {/* Cleaning */}
          <Route path="/cleaning/play/:id" element={<CleaningPlay />} />
          <Route path="/cleaning/remote/:room" element={<CleaningRemote />} />

          {/* Garden */}
          <Route path="/garden/play/:id" element={<GardenPlay />} />
          <Route path="/garden/remote/:room" element={<GardenRemote />} />

          {/* Animals */}
          <Route path="/animals/play/:id" element={<AnimalsPlay />} />
          <Route path="/animals/remote/:room" element={<AnimalsRemote />} />

          {/* Nav */}
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/community" element={<CommunityPage />} />
          <Route path="/badges" element={<BadgesPage />} />
          <Route path="/meal-planning" element={<MealPlanningPage />} />

          {/* ✅ UPDATED: load the real household meals page first */}
          <Route
            path="/household/meals"
            element={<HouseholdMealsCuisinePage />}
          />

          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />

          {/* Settings (generated) */}
          {settingsRoutes.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}

          {/* Storehouse + tools */}
          <Route path="/storehouse" element={<StorehousePage />} />
          <Route
            path="/storehouse/auto-fill"
            element={<StorehouseAutoFillPlanner />}
          />
          <Route
            path="/storehouse/preserve-queue"
            element={<PreservationQueuePlanner />}
          />

          {/* NEW sections */}
          {/* ✅ Homestead Planner ONLY surfaces here: /homesteadplanner/** */}
          <Route path="/homesteadplanner" element={<HomesteadPage />} />
          <Route
            path="/homesteadplanner/targets"
            element={<HomesteadTargetsPage />}
          />
          <Route
            path="/homesteadplanner/components"
            element={<HomesteadComponentsPage />}
          />
          <Route
            path="/homesteadplanner/inventory"
            element={<HomesteadInventoryPage />}
          />
          <Route
            path="/homesteadplanner/batches"
            element={<HomesteadBatchesPage />}
          />
          <Route
            path="/homesteadplanner/garden-targets"
            element={<HomesteadGardenTargetsPage />}
          />
          <Route
            path="/homesteadplanner/animal-targets"
            element={<HomesteadAnimalTargetsPage />}
          />
          <Route
            path="/homesteadplanner/cuisines"
            element={<HomesteadCuisinesPage />}
          />
          <Route
            path="/homesteadplanner/preferences"
            element={<HomesteadPreferencesPage />}
          />
          <Route
            path="/homesteadplanner/skills"
            element={<HomesteadSkillsPage />}
          />

          {/* ✅ Back-compat redirects to keep old links working, but NOT surface outputs elsewhere */}
          <Route
            path="/homestead"
            element={<Navigate to="/homesteadplanner" replace />}
          />
          <Route
            path="/homestead/targets"
            element={<Navigate to="/homesteadplanner/targets" replace />}
          />
          <Route
            path="/homestead/components"
            element={<Navigate to="/homesteadplanner/components" replace />}
          />
          <Route
            path="/homestead/inventory"
            element={<Navigate to="/homesteadplanner/inventory" replace />}
          />
          <Route
            path="/homestead/batches"
            element={<Navigate to="/homesteadplanner/batches" replace />}
          />
          <Route
            path="/homestead/garden-targets"
            element={<Navigate to="/homesteadplanner/garden-targets" replace />}
          />
          <Route
            path="/homestead/animal-targets"
            element={<Navigate to="/homesteadplanner/animal-targets" replace />}
          />
          <Route
            path="/homestead/cuisines"
            element={<Navigate to="/homesteadplanner/cuisines" replace />}
          />
          <Route
            path="/homestead/preferences"
            element={<Navigate to="/homesteadplanner/preferences" replace />}
          />
          <Route
            path="/homestead/skills"
            element={<Navigate to="/homesteadplanner/skills" replace />}
          />

          <Route path="/knowledge" element={<KnowledgePage />} />

          {/* Knowledge panels & tools & scan */}
          <Route path="/knowledge/events" element={<KnowledgeEvents />} />
          <Route
            path="/knowledge/yield-curves"
            element={<KnowledgeYieldCurves />}
          />
          <Route path="/knowledge/rules" element={<KnowledgeRules />} />
          <Route path="/knowledge/docs" element={<KnowledgeDocs />} />

          <Route path="/import/settings" element={<ImportSettings />} />
          <Route path="/scan/extreme" element={<ScanExtreme />} />
          <Route path="/tools/macro-calculator" element={<MacroCalc />} />
          <Route path="/tools/bmi-calculator" element={<BmiCalc />} />
          <Route path="/tools/multi-timer" element={<MultiTimer />} />

          {/* Legacy redirects */}
          <Route
            path="/scan"
            element={<Navigate to="/scan/extreme" replace />}
          />
          <Route
            path="/garden/planner"
            element={<Navigate to="/garden" replace />}
          />
          <Route
            path="/animals/planner"
            element={<Navigate to="/animals" replace />}
          />
          <Route
            path="/cleaning/routines"
            element={<Navigate to="/cleaning" replace />}
          />
          <Route
            path="/storehouse/planner"
            element={<Navigate to="/storehouse" replace />}
          />
          <Route path="/kg" element={<Navigate to="/knowledge" replace />} />

          {/* 404 — friendly message */}
          <Route
            path="*"
            element={
              <div className="p-6">
                <h1 className="text-2xl font-semibold">Page not found</h1>
                <p className="opacity-70 mt-2">
                  This route isn’t registered. Check <code>src/App.jsx</code> /
                  your page path.
                </p>
              </div>
            }
          />
        </Routes>
      </AppChrome>
    </VisionProvider>
  );
}

/* ----------------------------- tiny helpers ------------------------------ */
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Stable, tiny 32-bit hash for deterministic auto skillIds (session ingest)
function stableHash32(str) {
  const s = String(str || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // unsigned
  return (h >>> 0).toString(36);
}
