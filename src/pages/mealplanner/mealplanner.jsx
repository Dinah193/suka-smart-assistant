// src/pages/mealplanner.jsx
import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CalendarDays, Leaf, ShoppingBasket } from "lucide-react";
import {
  buildMealPlannerProbeText,
  normalizeMealPlannerTool,
  resolveToolFromSearch,
} from "./toolProbe";

// SV (Sacred Village) shared styling used by Cooking/Cleaning/Garden pages
import "@/styles/household.css";
import "@/pages/cooking/cooking.css";

/* ---------------- Existing panels ---------------- */
import useRealtimeCoordination from "@/hooks/useRealtimeCoordination";
import RealtimeCoordinationPanel from "@/components/home/RealtimeCoordinationPanel";
import { useFoodSecurityEstimator } from "@/hooks/estimators/useFoodSecurityEstimator";
import { useCostDeltaEstimator } from "@/hooks/estimators/useCostDeltaEstimator";
import {
  Avatar as SacredAvatar,
  Button as SacredButton,
  Card as SacredCard,
  DashboardGrid,
  FeedPost,
  Notification,
} from "@/components/sacred";
import { SSAButton, SSAField, SSAInput, SSASelect } from "@/components/ssa";
import {
  recordProductActionClick,
  recordProductActionImpression,
} from "@/services/telemetry/productActionTelemetry";
import {
  areAgendaFiltersEqual,
  normalizeAppliedAgendaFilters,
} from "@/utils/householdAgendaControls";
import { buildHouseholdTodayUpcomingQuery } from "@/utils/householdAgendaQueryParams";
import { requestHouseholdAutomationPlan } from "@/pages/planners/HouseholdPlanningService";
import { getToken } from "@/services/auth/tokenProvider";
import LoadingBoundary from "@/components/common/LoadingBoundary";
import ShoppingListGenerator from "../../components/meals/ShoppingListGenerator.jsx";

const MealPlannerDashboard = React.lazy(() =>
  import("../../components/meals/MealPlannerDashboard.jsx")
);
const MealCyclePlannerCalendar = React.lazy(() => import("./MealCyclePlannerCalendar.jsx"));
const MealPrepNeedsReport = React.lazy(() =>
  import("../../components/meals/MealPrepNeedsReport.jsx")
);
const FoodProductionForecast = React.lazy(() =>
  import("../../components/meals/FoodProductionForecast.jsx")
);
const ProcurementReport = React.lazy(() =>
  import("../../components/meals/ProcurementReport.jsx")
);
const MealToMarketScalePanel = React.lazy(() =>
  import("../../components/meals/MealToMarketScalePanel.jsx")
);
const SeedAnimalInventoryForm = React.lazy(() =>
  import("../../components/meals/SeedAnimalInventoryForm.jsx")
);
const ZoneAwareCalendar = React.lazy(() =>
  import("../../components/meals/ZoneAwareCalendar.jsx")
);

/* ---------------- Primary agent (lazy + guarded) ---------------- */
// Prefer talking to the shim / HouseholdOrchestrator instead of raw agents.
let _mealPlanningAgent = null;

async function getMealPlanningAgent() {
  if (_mealPlanningAgent) return _mealPlanningAgent;

  // 1) Prefer dedicated domain shim
  try {
    const mod = await import("../../agents/shims/mealPlanningShim.js");
    _mealPlanningAgent = mod?.default || mod || null;
  } catch (e) {
    // ignore
  }

  // 2) Secondary alias path
  if (!_mealPlanningAgent) {
    try {
      const mod = await import("@/agents/shims/mealPlanningShim.js");
      _mealPlanningAgent = mod?.default || mod || null;
    } catch (e) {
      // ignore
    }
  }

  // 3) HouseholdOrchestrator shim bridge
  if (!_mealPlanningAgent) {
    try {
      const mod = await import("../../agents/shims/HouseholdOrchestrator.js");
      const orchestrator = mod?.default || mod || null;

      if (orchestrator?.handleCommand) {
        _mealPlanningAgent = {
          handleCommand(command, payload) {
            return orchestrator.handleCommand("mealPlanning", {
              command,
              payload,
            });
          },
        };
      }
    } catch (e) {
      // ignore
    }
  }

  // 4) Alias bridge for orchestrator
  if (!_mealPlanningAgent) {
    try {
      const mod = await import("@/agents/shims/HouseholdOrchestrator.js");
      const orchestrator = mod?.default || mod || null;

      if (orchestrator?.handleCommand) {
        _mealPlanningAgent = {
          handleCommand(command, payload) {
            return orchestrator.handleCommand("mealPlanning", {
              command,
              payload,
            });
          },
        };
      }
    } catch (e) {
      // ignore
    }
  }

  if (!_mealPlanningAgent) {
    throw new Error(
      "Meal planner shim not available. Ensure src/agents/shims/mealPlanningShim.js or HouseholdOrchestrator.js exists and exports handleCommand."
    );
  }

  return _mealPlanningAgent;
}

/* ---------------- Dev automations ---------------- */
import AutomationPanel from "../../ui/AutomationPanel.jsx";
import { automation } from "@/services/automation/runtime";
import { emitCanonicalSignal } from "@/services/realtime/canonicalSignalEmitter";
import { eventBus } from "@/services/events/eventBus";
import {
  emitHomesteadMealPlanGenerated,
  buildEstimateInputsFromNormalizedPlan,
  emitPlannerGapsUpdated,
} from "@/services/planners/mealPlannerBridge";
import { persistMealPlannerGeneration } from "./mealPlannerPersistence";
import { useStorehousePlannerStore } from "@/store/StorehousePlannerStore";
import { useHomesteadPlannerStore } from "@/store/homesteadPlannerStore";

/* ---------------- Vision (household profile) ---------------- */
import { useVision } from "@/context/VisionContext";

/* ---------------- Drafts + Current Plan stores ---------------- */
import {
  useMealPlanDraftStore,
  saveDraft as saveDraftAPI,
  getDraft as getDraftAPI,
  publishDraft as publishDraftAPI,
  exportDraftJSON as exportDraftJSONAPI,
  importDraftJSON as importDraftJSONAPI,
  renameDraft as renameDraftAPI,
  duplicateDraft as duplicateDraftAPI,
  deleteDraft as deleteDraftAPI,
  selectDraft as selectDraftAPI,
} from "@/store/MealPlanDraftStore";

let useMealPlanStore = null;
try {
  ({ useMealPlanStore } = require("@/store/MealPlanStore"));
} catch {}

/* ---------------- Flavor/Cuisine suggestions (guarded) ---------------- */
let suggestFlavorOptions;
try {
  ({ suggestFlavorOptions } = require("@/types/FlavorRhythm.d"));
} catch {
  suggestFlavorOptions = () => [
    "Soul Food",
    "Caribbean",
    "West African",
    "Cajun",
    "Creole",
    "Mediterranean",
    "BBQ",
    "Herb-Garlic",
    "Citrus-Chili",
    "Asian Fusion",
    "Tex-Mex",
    "Nigerian",
    "Ghanaian",
    "Ethiopian",
    "Levantine",
    "Indian",
    "Thai",
    "Korean",
    "Japanese",
    "Italian",
    "French Country",
    "Mexican",
    "Peruvian",
  ];
}

/* ---------------- Dev gating for internal controls ---------------- */
const SHOW_DEV_AUTOMATIONS =
  import.meta.env.DEV &&
  (localStorage.getItem("suka:showAutomations") === "1" ||
    import.meta.env.VITE_SHOW_DEV_AUTOMATIONS === "1");

/* ---------------- Error Boundary ---------------- */
class ToolErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("[MealPlanner Tool Crash]", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          className="sv-card sv-pad"
          style={{ border: "1px solid var(--danger)" }}
        >
          <div className="sv-row" style={{ alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 900, color: "var(--danger)" }}>
              A panel failed to load.
            </div>
          </div>
          <div className="sv-muted" style={{ marginTop: 6 }}>
            Check the console for details. The rest of the page is still usable.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* --------- Defensive wrapper to coerce any `open` prop to boolean ---- */
function SafeProps({ children }) {
  if (!React.isValidElement(children)) return children;
  const coercedProps = {};
  if ("open" in children.props) coercedProps.open = !!children.props.open;
  return React.cloneElement(children, coercedProps);
}

/* ---------------- Tool registry ------------------- */
const TOOL_REGISTRY = [
  {
    id: "dashboard",
    label: "Dashboard",
    loader: () => <MealPlannerDashboard />,
  },
  {
    id: "cycle",
    label: "Meal Cycle Planner",
    loader: () => (
      <div className="sv-card" style={{ padding: 0 }}>
        <div
          className="calendar-header"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ fontWeight: 700 }}>Meal Cycle Planner (Calendar)</div>
        </div>
        <div style={{ padding: 12 }}>
          <MealCyclePlannerCalendar
            view="grid"
            weeksShown={1}
            useGardenStyles
            dragDrop
          />
        </div>
      </div>
    ),
  },
  {
    id: "prep",
    label: "Meal Prep Needs",
    loader: () => <MealPrepNeedsReport />,
  },
  {
    id: "forecast",
    label: "Production Forecast",
    loader: () => <FoodProductionForecast />,
  },
  {
    id: "procurement",
    label: "Procurement Report",
    loader: () => <ProcurementReport />,
  },
  {
    id: "scale",
    label: "Meal-to-Market Scale",
    loader: () => <MealToMarketScalePanel />,
  },
  {
    id: "seed",
    label: "Seed & Animal Inventory",
    loader: () => <SeedAnimalInventoryForm />,
  },
  {
    id: "calendar",
    label: "Zone-Aware Calendar",
    loader: () => <ZoneAwareCalendar />,
  },
];

const defaultGoals = { calories: 2000, protein: 120, carbs: 180, fat: 70 };

/* ---------------- UI bits ---------------- */
function Pill({ active, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`sv-chip ${active ? "is-active" : ""}`}
      style={{ borderRadius: 999, lineHeight: 1.2 }}
    >
      {children}
    </button>
  );
}

function SectionTitle({ title, subtitle }) {
  return (
    <div className="sv-sectionHead">
      <div
        className="sv-row sv-wrap"
        style={{
          justifyContent: "space-between",
          alignItems: "flex-end",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 20, letterSpacing: -0.2 }}>
          {title}
        </div>
      </div>
      {subtitle ? <div className="sv-muted">{subtitle}</div> : null}
    </div>
  );
}

/* ---------------- Presets ---------------- */
const PRESETS = [
  {
    id: "pantry-saver",
    title: "Pantry Saver",
    prompt:
      "Use pantry/freezer first; minimize spend; batch leftovers smartly.",
    duration: "7-day",
    budgetHint: "",
    tags: ["budget", "inventory-first"],
  },
  {
    id: "budget-7",
    title: "Budget 7-Day",
    prompt:
      "Plan 7 budget-friendly dinners under $120, minimal specialty items.",
    duration: "7-day",
    budgetHint: "120",
    tags: ["budget"],
  },
  {
    id: "feast-day",
    title: "Feast Day Cycle",
    prompt:
      "Build a cycle aligned to Hebrew feast days with prep timelines and communal dishes.",
    duration: "14-day",
    budgetHint: "",
    tags: ["holy-days"],
  },
  {
    id: "hair-growth",
    title: "Hair-Growth Focus",
    prompt:
      "High-collagen, mineral-rich meals (goat/lamb, bone broths, leafy greens, beans).",
    duration: "14-day",
    budgetHint: "",
    tags: ["wellness"],
  },
  {
    id: "seasonal-garden",
    title: "Seasonal Garden Push",
    prompt:
      "Prioritize current harvest; preserve surpluses; auto-create canning/dehydrating tasks.",
    duration: "7-day",
    budgetHint: "",
    tags: ["garden"],
  },
];

/* ---------------- Bundles ---------------- */
async function fetchRecipeBundles() {
  try {
    const mod = await import("../../agents/shims/mealBundleShim.js");
    const mealBundleAgent = mod?.default || mod || null;
    if (mealBundleAgent?.handleCommand) {
      const out = await mealBundleAgent.handleCommand("listBundles", {});
      if (Array.isArray(out?.bundles)) return out.bundles;
    }
  } catch (e) {
    console.warn("[MealPlanner] mealBundleAgent.listBundles failed", e);
  }
  return [];
}

/* ---------------- Helpers ---------------- */
function isLikelyTestRuntime() {
  if (typeof import.meta !== "undefined") {
    if (import.meta.vitest || import.meta.env?.MODE === "test") return true;
  }
  if (typeof navigator === "undefined") return false;
  return /jsdom|node\.js/i.test(String(navigator.userAgent || ""));
}

function runWhenBrowserIdle(task, timeoutMs = 1000) {
  if (typeof window === "undefined") return () => {};
  if (typeof window.requestIdleCallback === "function") {
    const idleId = window.requestIdleCallback(() => task(), { timeout: timeoutMs });
    return () => window.cancelIdleCallback?.(idleId);
  }
  const timerId = window.setTimeout(task, 250);
  return () => window.clearTimeout(timerId);
}

async function tryAgent(agent, cmd, payload) {
  console.warn(`[MealPlanner] ${cmd} skipped: strict backend-only mode`);
  return null;
}
const KCAL_PER_G_PROTEIN = 4,
  KCAL_PER_G_CARBS = 4,
  KCAL_PER_G_FAT = 9;
function pctToGrams(calories, pct) {
  const safe = (n) => Math.max(0, Number(n || 0));
  return {
    protein: Math.round(
      (calories * safe(pct.protein)) / 100 / KCAL_PER_G_PROTEIN
    ),
    carbs: Math.round((calories * safe(pct.carbs)) / 100 / KCAL_PER_G_CARBS),
    fat: Math.round((calories * safe(pct.fat)) / 100 / KCAL_PER_G_FAT),
  };
}

/** 🔒 Robustly normalize any agent envelope/shape into a consistent preview object */
function normalizePlan(raw) {
  if (!raw) return null;

  // Envelope handling: prefer res.mealPlan if present
  if (raw?.mealPlan) raw = raw.mealPlan;

  // If it’s a string, try to pull JSON out of markdown fences or parse
  if (typeof raw === "string") {
    const fence = raw.match(/```json([\s\S]*?)```/i);
    if (fence) {
      try {
        raw = JSON.parse(fence[1]);
      } catch {}
    } else {
      try {
        raw = JSON.parse(raw);
      } catch {
        return {
          title: "Meal Plan",
          summary: String(raw),
          meals: [],
          shoppingList: [],
          prepTasks: [],
          budget: {},
          macros: {},
        };
      }
    }
  }

  // If LLM-style with .plan (array of day objects)
  if (Array.isArray(raw?.plan)) {
    const days = raw.plan;
    const meals = days.flatMap((d) =>
      (d?.meals || []).map((m) => ({
        ...m,
        day: d.day ?? null,
        date: d.date ?? null,
        slot: m.time || "meal",
      }))
    );
    return {
      title: raw.title || "Meal Plan",
      summary: raw.summary || "",
      meals,
      shoppingList: raw.groceryList || [],
      prepTasks: raw.prepSchedule || [],
      budget: raw.budget || {},
      macros: raw._macroSummary?.perDay
        ? {
            calories: raw._macroSummary.perDay.calories,
            protein: raw._macroSummary.perDay.protein_g,
            carbs: raw._macroSummary.perDay.carbs_g,
            fat: raw._macroSummary.perDay.fat_g,
          }
        : {},
      _raw: raw,
    };
  }

  // Generic shape handling
  const o = raw || {};
  const meals = Array.isArray(o.meals)
    ? o.meals
    : Array.isArray(o.dishes)
    ? o.dishes
    : [];
  const shopping = Array.isArray(o.shoppingList)
    ? o.shoppingList
    : Array.isArray(o.groceries)
    ? o.groceries
    : [];
  const prep = Array.isArray(o.prepTasks)
    ? o.prepTasks
    : Array.isArray(o.prep)
    ? o.prep
    : [];
  const macros = o.macros || o.nutrition || {};
  const budget = o.budget || {};

  return {
    title: o.title || o.name || "Meal Plan",
    summary: o.summary || o.note || "",
    meals,
    shoppingList: shopping,
    prepTasks: prep,
    budget,
    macros: {
      calories: macros.calories ?? macros.kcal ?? null,
      protein: macros.protein ?? macros.protein_g ?? null,
      carbs: macros.carbs ?? macros.carbs_g ?? null,
      fat: macros.fat ?? macros.fat_g ?? null,
    },
    _raw: o,
  };
}

/* ---------------- Full inline Plan Viewer (when setPlan is absent) -------- */
function coerceToEnvelope(normalized) {
  if (!normalized) return null;
  if (Array.isArray(normalized?._raw?.plan)) return normalized._raw;
  if (Array.isArray(normalized?.plan)) return normalized;

  // Build a minimal envelope from normalized fields
  const meals = Array.isArray(normalized.meals) ? normalized.meals : [];
  const byDay = new Map();
  meals.forEach((m, idx) => {
    const day = m?.day ?? `D${(idx % 7) + 1}`;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      title: m?.title || m?.name || "Meal",
      time: m?.time || m?.slot || "meal",
      ...m,
    });
  });
  const plan = Array.from(byDay.entries()).map(([day, arr]) => ({
    day,
    meals: arr,
  }));
  return {
    title: normalized.title || "Meal Plan",
    summary: normalized.summary || "",
    plan,
    groceryList: normalized.shoppingList || [],
    prepSchedule: normalized.prepTasks || [],
    budget: normalized.budget || {},
  };
}

function buildGenerateFailureMessage(res, normalized) {
  const warnings = Array.isArray(res?.warnings) ? res.warnings : [];
  const providerWarning = warnings.find((w) =>
    String(w?.type || "").toLowerCase().includes("providernotconfigured")
  );
  if (providerWarning?.message) return providerWarning.message;

  if (String(res?.data?.summary || "").trim()) {
    return String(res.data.summary).trim();
  }
  if (String(res?.summary || "").trim()) {
    return String(res.summary).trim();
  }

  const mealCount = Array.isArray(normalized?.meals) ? normalized.meals.length : 0;
  if (mealCount === 0) {
    return "Reasoner provider not configured. No meal recipes were generated.";
  }

  return "Meal plan generation failed.";
}

const EMERGENCY_PLAN_RECIPES = [
  {
    title: "Red Beans and Rice",
    ingredients: [
      { name: "red beans", qty: 2, unit: "cups" },
      { name: "rice", qty: 2, unit: "cups" },
      { name: "onion", qty: 1, unit: "unit" },
    ],
  },
  {
    title: "Herb Roast Chicken",
    ingredients: [
      { name: "chicken", qty: 1, unit: "whole" },
      { name: "potatoes", qty: 4, unit: "units" },
      { name: "mixed herbs", qty: 1, unit: "tbsp" },
    ],
  },
  {
    title: "Garden Vegetable Stew",
    ingredients: [
      { name: "carrots", qty: 3, unit: "units" },
      { name: "celery", qty: 2, unit: "stalks" },
      { name: "broth", qty: 4, unit: "cups" },
    ],
  },
  {
    title: "Skillet Salmon and Greens",
    ingredients: [
      { name: "salmon", qty: 4, unit: "fillets" },
      { name: "leafy greens", qty: 1, unit: "bag" },
      { name: "lemon", qty: 1, unit: "unit" },
    ],
  },
  {
    title: "Lentil Curry",
    ingredients: [
      { name: "lentils", qty: 2, unit: "cups" },
      { name: "coconut milk", qty: 1, unit: "can" },
      { name: "curry spice", qty: 1, unit: "tbsp" },
    ],
  },
  {
    title: "Turkey Chili",
    ingredients: [
      { name: "ground turkey", qty: 1, unit: "lb" },
      { name: "beans", qty: 2, unit: "cans" },
      { name: "tomato sauce", qty: 1, unit: "jar" },
    ],
  },
  {
    title: "Egg Fried Rice",
    ingredients: [
      { name: "rice", qty: 3, unit: "cups" },
      { name: "eggs", qty: 4, unit: "units" },
      { name: "peas", qty: 1, unit: "cup" },
    ],
  },
];

function resolvePlannerHouseholdId() {
  if (typeof window === "undefined") return "default-household";
  const fromGlobal =
    window.__suka?.profile?.householdId ||
    window.__suka?.profile?.homeId ||
    window.__suka?.householdId ||
    window.__suka?.homeId;
  if (fromGlobal) return String(fromGlobal);

  try {
    const raw = window.localStorage?.getItem("suka.profile");
    const parsed = raw ? JSON.parse(raw) : null;
    return String(parsed?.householdId || parsed?.homeId || "default-household");
  } catch {
    return "default-household";
  }
}

function plannerAuthHeaders(extra = {}) {
  const token = String(getToken("access") || "").trim();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function pickFiniteNumber(...candidates) {
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickFiniteNumberEntry(entries = []) {
  for (const entry of entries) {
    const n = Number(entry?.value);
    if (Number.isFinite(n)) {
      return { value: n, source: entry?.source || null };
    }
  }
  return { value: null, source: null };
}

function pickDefinedEntry(entries = []) {
  for (const entry of entries) {
    const value = entry?.value;
    if (value == null) continue;
    const text = String(value).trim();
    if (!text) continue;
    return { value: text, source: entry?.source || null };
  }
  return { value: null, source: null };
}

function formatBackendToolStatus({ projectionStatus, readiness, warnings }) {
  const pendingProjection = Number(
    projectionStatus?.pendingJobs ?? projectionStatus?.queue?.pending ?? 0
  );
  if (Number.isFinite(pendingProjection) && pendingProjection > 0) {
    return `Syncing (${pendingProjection} projection jobs pending)`;
  }

  const recentPlanCount = Number(readiness?.total_meal_plans_30d ?? 0);
  if (Number.isFinite(recentPlanCount) && recentPlanCount > 0) {
    return "Synced with backend planner records";
  }

  if (Array.isArray(warnings) && warnings.length) {
    return "Connected (backend warnings present)";
  }

  return "Waiting for first backend run";
}

async function fetchMealPlannerBackendContext({ householdId }) {
  const requests = await Promise.allSettled([
    fetch(`/api/planners/meal?householdId=${encodeURIComponent(householdId)}`, {
      headers: plannerAuthHeaders(),
      credentials: "include",
    }),
    fetch(
      `/api/planners/storehouse?householdId=${encodeURIComponent(householdId)}`,
      {
        headers: plannerAuthHeaders(),
        credentials: "include",
      }
    ),
    fetch(
      `/api/planners/operational/readiness/meal?householdId=${encodeURIComponent(
        householdId
      )}`,
      {
        headers: plannerAuthHeaders(),
        credentials: "include",
      }
    ),
    fetch(`/api/planners/projection/status`, {
      headers: plannerAuthHeaders(),
      credentials: "include",
    }),
  ]);

  const readJson = async (settledResult) => {
    if (settledResult.status !== "fulfilled") return null;
    const response = settledResult.value;
    if (!response || !response.ok) return null;
    return response.json().catch(() => null);
  };

  const [mealPayload, storehousePayload, readinessPayload, projectionPayload] =
    await Promise.all(requests.map(readJson));

  const warnings = [
    ...(Array.isArray(mealPayload?.warnings) ? mealPayload.warnings : []),
    ...(Array.isArray(storehousePayload?.warnings) ? storehousePayload.warnings : []),
  ];

  const snapshot = mealPayload?.snapshot || {};
  const plannerOutput = snapshot?.planner_output || {};
  const readiness = readinessPayload?.readiness || {};
  const storehouseSummary = storehousePayload?.summary || {};

  const foodSecurityEntry = pickFiniteNumberEntry([
    { source: "snapshot.planner_output.foodSecurityPct", value: plannerOutput?.foodSecurityPct },
    {
      source: "snapshot.planner_output.estimates.gardenUsePct",
      value: plannerOutput?.estimates?.gardenUsePct,
    },
    { source: "snapshot.planner_output.gardenUsePct", value: plannerOutput?.gardenUsePct },
    { source: "readiness.food_security_pct", value: readiness?.food_security_pct },
  ]);

  const costDeltaEntry = pickFiniteNumberEntry([
    {
      source: "snapshot.planner_output.costDelta.shoppingCost",
      value: plannerOutput?.costDelta?.shoppingCost,
    },
    {
      source: "snapshot.planner_output.costDelta.shopping_cost",
      value: plannerOutput?.costDelta?.shopping_cost,
    },
    {
      source: "snapshot.planner_output.costDelta.projectedShoppingCost",
      value: plannerOutput?.costDelta?.projectedShoppingCost,
    },
    {
      source: "snapshot.planner_output.budget.projectedShoppingCost",
      value: plannerOutput?.budget?.projectedShoppingCost,
    },
    {
      source: "snapshot.planner_output.budget.shoppingCost",
      value: plannerOutput?.budget?.shoppingCost,
    },
    { source: "snapshot.planner_output.shoppingCost", value: plannerOutput?.shoppingCost },
  ]);

  const plannerModeEntry = pickDefinedEntry([
    { source: "snapshot.plannerMode", value: snapshot?.plannerMode },
    { source: "snapshot.planner_mode", value: snapshot?.planner_mode },
    { source: "snapshot.planner_output.plannerMode", value: plannerOutput?.plannerMode },
    { source: "snapshot.planner_output.tool", value: plannerOutput?.tool },
    { source: "projection.activeTool", value: projectionPayload?.activeTool },
    { source: "projection.tool", value: projectionPayload?.tool },
  ]);

  const backendFoodSecurity = foodSecurityEntry.value;
  const backendCostDelta = costDeltaEntry.value;
  const plannerModeTool = plannerModeEntry.value;

  const dataContractGaps = [];
  if (!plannerModeTool) dataContractGaps.push("plannerMode.tool");
  if (backendFoodSecurity == null) dataContractGaps.push("foodSecurityPct");
  if (backendCostDelta == null) dataContractGaps.push("costDeltaShoppingCost");

  const lastRunAt =
    snapshot?.updated_at ||
    snapshot?.updatedAt ||
    readiness?.latest_meal_plan_at ||
    projectionPayload?.updatedAt ||
    null;

  const checkedFields = [
    {
      key: "plannerMode.tool",
      status: plannerModeTool ? "present" : "missing",
      source: plannerModeEntry.source,
      value: plannerModeTool,
    },
    {
      key: "foodSecurityPct",
      status: backendFoodSecurity == null ? "missing" : "present",
      source: foodSecurityEntry.source,
      value: backendFoodSecurity,
    },
    {
      key: "costDeltaShoppingCost",
      status: backendCostDelta == null ? "missing" : "present",
      source: costDeltaEntry.source,
      value: backendCostDelta,
    },
  ];

  return {
    householdId,
    plannerMode: {
      tool: plannerModeTool,
      status: formatBackendToolStatus({
        projectionStatus: projectionPayload,
        readiness,
        warnings,
      }),
      lastRunAt,
    },
    foodSecurityPct: backendFoodSecurity,
    costDeltaShoppingCost: backendCostDelta,
    dataContractGaps,
    checkedFields,
    backendSummary: {
      mealReady: Boolean(mealPayload?.ok),
      storehouseReady: Boolean(storehousePayload?.ok),
      readinessReady: Boolean(readinessPayload?.ok),
      projectionReady: Boolean(projectionPayload?.ok),
    },
    warnings,
  };
}

async function fetchMealPlannerContext({ householdId }) {
  const response = await fetch(
    `/api/planners/meal/context?householdId=${encodeURIComponent(householdId)}`,
    {
      headers: plannerAuthHeaders(),
      credentials: "include",
    }
  );
  if (!response.ok) {
    throw new Error(`context_fetch_failed:${response.status}`);
  }
  const payload = await response.json();
  return {
    feed: Array.isArray(payload?.feed) ? payload.feed : [],
    alerts: Array.isArray(payload?.alerts) ? payload.alerts : [],
  };
}

async function dismissMealPlannerContextAlert({ householdId, alertId, dismiss = true }) {
  const response = await fetch(
    `/api/planners/meal/context/alerts/${encodeURIComponent(alertId)}/dismiss`,
    {
      method: "POST",
      headers: plannerAuthHeaders({ "Content-Type": "application/json" }),
      credentials: "include",
      body: JSON.stringify({ householdId, dismiss }),
    }
  );
  if (!response.ok) {
    throw new Error(`context_alert_dismiss_failed:${response.status}`);
  }
  const payload = await response.json();
  return {
    feed: Array.isArray(payload?.feed) ? payload.feed : [],
    alerts: Array.isArray(payload?.alerts) ? payload.alerts : [],
  };
}

async function applyMealPlannerFeedAction({ householdId, postId, action, delta = 1 }) {
  const response = await fetch(
    `/api/planners/meal/context/feed/${encodeURIComponent(postId)}/action`,
    {
      method: "POST",
      headers: plannerAuthHeaders({ "Content-Type": "application/json" }),
      credentials: "include",
      body: JSON.stringify({ householdId, action, delta }),
    }
  );
  if (!response.ok) {
    throw new Error(`context_feed_action_failed:${response.status}`);
  }
  const payload = await response.json();
  return {
    feed: Array.isArray(payload?.feed) ? payload.feed : [],
    alerts: Array.isArray(payload?.alerts) ? payload.alerts : [],
  };
}

async function fetchHouseholdTodayUpcomingAgenda({
  householdId,
  todayLimit = 10,
  upcomingLimit = 10,
  person = "",
  module = "",
  priority = "",
  status = "",
  sortBy = "dueAt",
  sortDirection = "desc",
}) {
  const query = buildHouseholdTodayUpcomingQuery({
    householdId,
    todayLimit,
    upcomingLimit,
    filters: {
      person,
      module,
      priority,
      status,
      sortBy,
      sortDirection,
    },
  });

  const response = await fetch(
    `/api/planners/household/today-upcoming?${query.toString()}`,
    {
      headers: plannerAuthHeaders(),
      credentials: "include",
    }
  );
  if (!response.ok) {
    throw new Error(`household_today_upcoming_failed:${response.status}`);
  }
  const payload = await response.json();
  return {
    metrics: payload?.metrics && typeof payload.metrics === "object" ? payload.metrics : {},
    applied: payload?.applied && typeof payload.applied === "object"
      ? payload.applied
      : {
          filters: {
            person: String(person || ""),
            module: String(module || ""),
            priority: String(priority || ""),
            status: String(status || ""),
          },
          sortBy: String(sortBy || "dueAt"),
          sortDirection: String(sortDirection || "desc"),
          limits: {
            today: Number(todayLimit) || 10,
            upcoming: Number(upcomingLimit) || 10,
          },
        },
    today: Array.isArray(payload?.today) ? payload.today : [],
    upcoming: Array.isArray(payload?.upcoming) ? payload.upcoming : [],
  };
}

async function fetchCommunityApprovals({ householdId }) {
  const response = await fetch(
    `/api/planners/community/approvals?householdId=${encodeURIComponent(householdId)}`,
    {
      headers: plannerAuthHeaders(),
      credentials: "include",
    }
  );
  if (!response.ok) {
    throw new Error(`community_approvals_fetch_failed:${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload?.approvals) ? payload.approvals : [];
}

async function transitionCommunityApproval({ householdId, approvalId, nextState, reason }) {
  const response = await fetch(
    `/api/planners/community/approvals/${encodeURIComponent(approvalId)}/transition`,
    {
      method: "POST",
      headers: plannerAuthHeaders({ "Content-Type": "application/json" }),
      credentials: "include",
      body: JSON.stringify({ householdId, nextState, reason }),
    }
  );
  if (!response.ok) {
    throw new Error(`community_approval_transition_failed:${response.status}`);
  }
  const payload = await response.json();
  return payload?.approval || null;
}

function normalizeAssistantBundlePlan(bundle, duration = "7-day") {
  const recipes = Array.isArray(bundle?.suggestions?.meal?.recipes)
    ? bundle.suggestions.meal.recipes
    : [];
  if (!recipes.length) return null;

  const daysByDuration = {
    "1-day": 1,
    "7-day": 7,
    "14-day": 14,
    "1-month": 30,
    "3-month": 90,
    "6-month": 180,
  };
  const totalDays = daysByDuration[duration] || 7;

  const meals = Array.from({ length: totalDays }, (_, idx) => {
    const recipe = recipes[idx % recipes.length] || {};
    return {
      title: String(recipe?.title || recipe?.name || `Meal ${idx + 1}`),
      slot: "dinner",
      time: "dinner",
      day: idx + 1,
      reason: String(recipe?.reason || ""),
    };
  });

  const shoppingList = recipes.flatMap((recipe, idx) => {
    const baseName = String(recipe?.title || recipe?.name || `Recipe ${idx + 1}`);
    return [{ name: `${baseName} ingredients`, qty: 1, unit: "batch" }];
  });

  const summary =
    String(bundle?.narrative?.explanation || "").trim() ||
    "Generated from planner assistant backend recommendations.";

  return {
    title: "Meal Plan",
    summary,
    meals,
    shoppingList,
    prepTasks: [],
    budget: {},
    macros: {},
  };
}

function InlinePlanViewer({ envelope }) {
  if (!envelope) return null;
  const days = Array.isArray(envelope.plan) ? envelope.plan : [];
  const groceries = Array.isArray(envelope.groceryList)
    ? envelope.groceryList
    : [];
  const prep = Array.isArray(envelope.prepSchedule)
    ? envelope.prepSchedule
    : [];
  return (
    <div className="sv-card sv-pad" style={{ marginTop: 16 }}>
      <SectionTitle
        title={envelope.title || "Meal Plan"}
        subtitle={envelope.summary || ""}
      />
      <div
        className="grid"
        style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr" }}
      >
        <div className="sv-card sv-pad">
          <div className="subtitle">Schedule</div>
          {days.length ? (
            <div className="grid" style={{ display: "grid", gap: 8 }}>
              {days.map((d, i) => (
                <div key={i} className="sv-card sv-pad">
                  <div className="subtitle">Day {d.day ?? i + 1}</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {(d.meals || []).map((m, j) => (
                      <li key={j}>
                        {m.time || "meal"} — {m.title || m.name || "Meal"}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <div className="subtitle">No meals in schedule.</div>
          )}
        </div>

        <div className="sv-card sv-pad">
          <div className="subtitle">Shopping List</div>
          {groceries.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {groceries.map((g, i) => {
                const txt =
                  typeof g === "string"
                    ? g
                    : [[g.qty, g.unit].filter(Boolean).join(" "), g.name]
                        .filter(Boolean)
                        .join(" ");
                return <li key={i}>{txt}</li>;
              })}
            </ul>
          ) : (
            <div className="subtitle">—</div>
          )}
        </div>

        <div className="sv-card sv-pad">
          <div className="subtitle">Prep Schedule</div>
          {prep.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {prep.map((p, i) => (
                <li key={i}>
                  {typeof p === "string" ? p : p?.title || p?.name || "Task"}
                </li>
              ))}
            </ul>
          ) : (
            <div className="subtitle">—</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Draft Review ---------------- */
function DraftReview({ data, onViewPlan }) {
  if (!data) return null;

  const meals = Array.isArray(data.meals) ? data.meals : [];
  const shopping = Array.isArray(data.shoppingList) ? data.shoppingList : [];
  const prep = Array.isArray(data.prepTasks) ? data.prepTasks : [];
  const budget = data.budget || {};
  const macros = data.macros || {};
  const shoppingSeeds = shopping
    .map((it, i) => {
      if (typeof it === "string") {
        return {
          name: it,
          neededQty: 1,
          unit: "unit",
          recipeId: `plan-${i + 1}`,
          recipeTitle: "Meal Plan",
        };
      }

      return {
        name: it?.name,
        neededQty: Number(it?.qty ?? it?.neededQty ?? 0) || 0,
        unit: it?.unit || "unit",
        recipeId: it?.recipeId || `plan-${i + 1}`,
        recipeTitle: it?.recipeTitle || "Meal Plan",
      };
    })
    .filter((row) => String(row?.name || "").trim().length > 0);

  return (
    <div className="sv-card sv-pad" style={{ marginTop: 16 }}>
      <SectionTitle
        title="Draft Review"
        subtitle="Readable summary of the generated plan."
      />
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        {data.title || data.summary || "Meal Plan Draft"}
      </div>

      {meals.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="subtitle" style={{ marginBottom: 6 }}>
            Meals at a glance
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {meals.slice(0, 21).map((m, i) => {
              const label =
                typeof m === "string"
                  ? m
                  : [m?.day, m?.slot, m?.name || m?.title || "Meal"]
                      .filter(Boolean)
                      .join(" — ");
              return <li key={i}>{label}</li>;
            })}
          </ul>
          {meals.length > 21 && (
            <div className="subtitle" style={{ marginTop: 6 }}>
              …and {meals.length - 21} more.
            </div>
          )}
        </div>
      )}

      {shopping.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="subtitle" style={{ marginBottom: 6 }}>
            Shopping list (highlights)
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {shopping.slice(0, 15).map((it, i) => {
              const line =
                typeof it === "string"
                  ? it
                  : [[it.qty, it.unit].filter(Boolean).join(" "), it.name]
                      .filter(Boolean)
                      .join(" ");
              return <li key={i}>{line}</li>;
            })}
          </ul>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <ShoppingListGenerator
          recipes={[]}
          seedProvisionItems={shoppingSeeds}
          stewardshipMode
          sessionId={data?.id || data?.draftId || null}
          onSendToGrocery={(payload) => {
            automation?.emit?.("meal/shoppingForwarded", {
              source: "mealplanner:draftReview",
              payload,
            });
          }}
        />
      </div>

      {prep.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="subtitle" style={{ marginBottom: 6 }}>
            Prep tasks
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {prep.slice(0, 12).map((t, i) => (
              <li key={i}>
                {typeof t === "string" ? t : t?.title || t?.name || "Task"}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          marginTop: 12,
        }}
      >
        <div className="sv-card sv-pad">
          <div className="subtitle">Budget</div>
          <div className="subtitle">
            {budget.estimate
              ? `$${Number(budget.estimate).toFixed(2)} estimated`
              : "No estimate"}
          </div>
          {budget.notes ? <div className="subtitle">{budget.notes}</div> : null}
        </div>
        <div className="sv-card sv-pad">
          <div className="subtitle">Macros (avg/day)</div>
          <div className="subtitle">
            {macros.calories ? `${macros.calories} kcal` : "—"} •{" "}
            {macros.protein ? `${macros.protein}g protein` : "—"} •{" "}
            {macros.carbs ? `${macros.carbs}g carbs` : "—"} •{" "}
            {macros.fat ? `${macros.fat}g fat` : "—"}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button className="sv-btn sv-btn--outline" onClick={onViewPlan}>
          <span className="label">View Plan</span>
        </button>
        <button
          className="sv-btn sv-btn--outline"
          onClick={() => {
            if (typeof window !== "undefined") {
              window.location.assign("/meal-planning?tool=calendar");
            }
          }}
        >
          <span className="label">Send to Calendar</span>
        </button>
        <button
          className="sv-btn sv-btn--outline"
          onClick={() => {
            if (typeof window !== "undefined") {
              window.location.assign("/meal-planning?tool=procurement");
            }
          }}
        >
          <span className="label">Open Procurement</span>
        </button>
      </div>
    </div>
  );
}

function toPlannerMealsFromPlan(plan, estimatedMealCount = 0) {
  const rawMeals = Array.isArray(plan?.meals) ? plan.meals : [];
  if (rawMeals.length) {
    return rawMeals.map((meal, idx) => ({
      id: String(meal?.id || `planner_meal_${idx + 1}`),
      title: String(meal?.title || meal?.name || `Meal ${idx + 1}`),
      servingsNeeded: Number.isFinite(Number(meal?.servingsNeeded))
        ? Number(meal.servingsNeeded)
        : null,
    }));
  }

  const count = Math.max(0, Number(estimatedMealCount || 0));
  return Array.from({ length: count }, (_, idx) => ({
    id: `planner_meal_${idx + 1}`,
    title: `Planned meal ${idx + 1}`,
    servingsNeeded: null,
  }));
}

function toPlannerInventoryFromPlan(plan) {
  const rows = Array.isArray(plan?.shoppingList) ? plan.shoppingList : [];
  return rows
    .map((row, idx) => {
      const isString = typeof row === "string";
      const label = String(isString ? row : row?.name || "").trim();
      if (!label) return null;
      const quantity = Number(isString ? 1 : row?.qty ?? row?.neededQty ?? 0);
      return {
        id: `inv_${idx + 1}`,
        label,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        unit: String((isString ? "unit" : row?.unit) || "unit"),
      };
    })
    .filter(Boolean);
}

function toProductionCreditsFromEstimateInputs(estimateInputs) {
  const protein = estimateInputs?.animal?.proteinDemandByType || {};
  const tasks = Array.isArray(estimateInputs?.preservation?.tasks)
    ? estimateInputs.preservation.tasks
    : [];

  const proteinCredits = Object.entries(protein)
    .map(([key, qty], idx) => {
      const n = Number(qty);
      if (!Number.isFinite(n) || n <= 0) return null;
      return {
        id: `prod_protein_${idx + 1}`,
        key: `${String(key || "protein").toLowerCase()}`,
        qtyUnits: n,
        source: "mealplanner.estimateInputs",
      };
    })
    .filter(Boolean);

  const preservationCredits = tasks
    .map((task, idx) => {
      const produce = String(task?.produce || "").trim().toLowerCase();
      if (!produce) return null;
      const qty = Number(task?.quantity ?? 1);
      return {
        id: `prod_pres_${idx + 1}`,
        key: produce,
        qtyUnits: Number.isFinite(qty) && qty > 0 ? qty : 1,
        source: "mealplanner.preservation",
      };
    })
    .filter(Boolean);

  return [...proteinCredits, ...preservationCredits];
}

function UnifiedReadinessCard() {
  const lastEstimateInputs = useHomesteadPlannerStore(
    (s) => s.ingest?.lastEstimateInputs
  );
  const lastGeneratedPlan = useHomesteadPlannerStore(
    (s) => s.ingest?.lastGeneratedPlan
  );
  const lastIngestedAt = useHomesteadPlannerStore((s) => s.ingest?.lastIngestedAt);

  const adapters = useMemo(
    () => ({
      getMealPlan: () => ({
        items: toPlannerMealsFromPlan(
          lastGeneratedPlan,
          lastEstimateInputs?.animal?.mealCount
        ),
      }),
      getInventory: () => ({
        items: toPlannerInventoryFromPlan(lastGeneratedPlan),
      }),
      getTargets: () => {
        const needs =
          useStorehousePlannerStore.getState?.()?.storehouseNeeds || [];
        return {
          targets: needs.map((need) => ({
            key: String(need?.name || "").toLowerCase(),
            qty: Number(need?.qty ?? 0),
            unit: need?.unit || "unit",
            label: need?.name || "Item",
          })),
        };
      },
      getProduction: () => ({
        credits: toProductionCreditsFromEstimateInputs(lastEstimateInputs),
      }),
      emit: (eventName, payload) => {
        try {
          eventBus?.emit?.(eventName, payload);
        } catch {
          // no-op
        }
      },
      getMealPlanKey: () =>
        `${lastIngestedAt || "none"}:meal:${
          Array.isArray(lastGeneratedPlan?.meals)
            ? lastGeneratedPlan.meals.length
            : Number(lastEstimateInputs?.animal?.mealCount || 0)
        }`,
      getInventoryKey: () =>
        `${lastIngestedAt || "none"}:inv:${
          Array.isArray(lastGeneratedPlan?.shoppingList)
            ? lastGeneratedPlan.shoppingList.length
            : 0
        }`,
      getTargetsKey: () => {
        const needs =
          useStorehousePlannerStore.getState?.()?.storehouseNeeds || [];
        return `${lastIngestedAt || "none"}:targets:${needs.length}`;
      },
      getProductionKey: () =>
        `${lastIngestedAt || "none"}:prod:${
          Array.isArray(lastEstimateInputs?.preservation?.tasks)
            ? lastEstimateInputs.preservation.tasks.length
            : 0
        }`,
    }),
    [lastEstimateInputs, lastGeneratedPlan, lastIngestedAt]
  );

  const food = useFoodSecurityEstimator({
    context: { mode: "meal_planner", route: "mealplanner" },
    adapters,
    autoRun: true,
  });

  const cost = useCostDeltaEstimator({
    context: { mode: "meal_planner", route: "mealplanner" },
    adapters,
    autoRun: true,
  });

  const readiness = useMemo(() => {
    const coverageDays = Number(food?.result?.outputs?.coverageDays || 0);
    const weeklySavings = Number(cost?.result?.outputs?.weeklySavings || 0);
    const confidenceA = Number(food?.result?.outputs?.confidence || 0);
    const confidenceB = Number(cost?.result?.outputs?.confidence || 0);
    const confidence =
      confidenceA > 0 || confidenceB > 0
        ? (confidenceA + confidenceB) / (confidenceB > 0 ? 2 : 1)
        : 0;

    const scoreRaw = coverageDays * 8 + Math.max(0, weeklySavings) * 1.2 + confidence * 20;
    const score = Math.max(0, Math.min(100, Math.round(scoreRaw)));

    const status =
      score >= 75 ? "Ready" : score >= 45 ? "Stabilizing" : "Needs prep";

    return {
      score,
      status,
      coverageDays,
      weeklySavings,
      monthlySavings: Number(cost?.result?.outputs?.monthlySavings || 0),
      confidence: Number.isFinite(confidence) ? confidence : 0,
    };
  }, [food?.result, cost?.result]);

  const publishKey = useMemo(
    () =>
      JSON.stringify({
        at: lastIngestedAt || null,
        score: readiness.score,
        coverageDays: readiness.coverageDays,
        weeklySavings: readiness.weeklySavings,
      }),
    [lastIngestedAt, readiness]
  );

  const lastPublishKeyRef = useRef("");
  useEffect(() => {
    if (!lastIngestedAt) return;
    if (publishKey === lastPublishKeyRef.current) return;
    lastPublishKeyRef.current = publishKey;

    eventBus?.emit?.("planner.readiness.updated", {
      source: "mealplanner:unifiedReadinessCard",
      updatedAt: new Date().toISOString(),
      readiness,
      estimators: {
        foodSecurity: food?.result || null,
        costDelta: cost?.result || null,
      },
      estimateInputs: lastEstimateInputs || null,
    });
  }, [publishKey, lastIngestedAt, readiness, food?.result, cost?.result, lastEstimateInputs]);

  const isWaiting = !lastIngestedAt;
  const isHidden = !food?.gatedOn && !cost?.gatedOn;

  return (
    <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
      <SectionTitle
        title="Unified Readiness"
        subtitle="Food security + budget delta combined from planner estimate inputs."
      />

      {isWaiting ? (
        <div className="sv-muted">Generate a meal plan to publish estimate inputs and compute readiness.</div>
      ) : isHidden ? (
        <div className="sv-muted">
          Homestead estimators are gated off. Enable homestead mode (level 1+) to display readiness scoring.
        </div>
      ) : (
        <>
          <div
            className="sv-grid-3"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", marginTop: 8 }}
          >
            <div className="sv-card sv-pad">
              <div style={{ fontWeight: 800 }}>Readiness Score</div>
              <div style={{ fontSize: 28, fontWeight: 900 }}>{readiness.score}/100</div>
              <div className="sv-muted">{readiness.status}</div>
            </div>
            <div className="sv-card sv-pad">
              <div style={{ fontWeight: 800 }}>Coverage Days</div>
              <div style={{ fontSize: 24, fontWeight: 800 }}>
                {Number.isFinite(readiness.coverageDays)
                  ? readiness.coverageDays.toFixed(1)
                  : "0.0"}
              </div>
              <div className="sv-muted">from food-security estimator</div>
            </div>
            <div className="sv-card sv-pad">
              <div style={{ fontWeight: 800 }}>Weekly Savings</div>
              <div style={{ fontSize: 24, fontWeight: 800 }}>
                ${Number.isFinite(readiness.weeklySavings)
                  ? readiness.weeklySavings.toFixed(2)
                  : "0.00"}
              </div>
              <div className="sv-muted">
                Monthly: ${Number.isFinite(readiness.monthlySavings)
                  ? readiness.monthlySavings.toFixed(2)
                  : "0.00"}
              </div>
            </div>
          </div>

          <div className="sv-muted" style={{ marginTop: 8 }}>
            Confidence: {(readiness.confidence * 100).toFixed(0)}% · Updated {new Date(lastIngestedAt).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- Drafts UI ---------------- */
function DraftsPane({ onPublish, onQuickViewAsCurrent }) {
  // Keep a local snapshot and subscribe; avoid calling store methods in selectors (prevents loops).
  const [snapshot, setSnapshot] = useState(() => {
    const st = useMealPlanDraftStore.getState?.() || {};
    return {
      drafts: st.listDrafts ? st.listDrafts() : [],
      selectedDraft: st.getSelectedDraft ? st.getSelectedDraft() : null,
      selectedDraftId: st.selectedDraftId ?? null,
    };
  });

  useEffect(() => {
    const refresh = () => {
      const st = useMealPlanDraftStore.getState?.() || {};
      setSnapshot({
        drafts: st.listDrafts ? st.listDrafts() : [],
        selectedDraft: st.getSelectedDraft ? st.getSelectedDraft() : null,
        selectedDraftId: st.selectedDraftId ?? null,
      });
    };
    refresh();
    const unsub = useMealPlanDraftStore.subscribe
      ? useMealPlanDraftStore.subscribe(refresh)
      : () => {};
    return unsub;
  }, []);

  const { drafts, selectedDraft, selectedDraftId } = snapshot;

  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const fileRef = useRef(null);

  // Local, pure filtering to avoid store writes during render
  const filteredDrafts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const tag = (tagFilter || "").trim().toLowerCase();
    return (drafts || []).filter((d) => {
      const title = (d.title || "").toLowerCase();
      const summary = (d.plan?.summary || "").toLowerCase();
      const tags = (d.tags || []).map((t) => String(t).toLowerCase());
      const matchQ =
        !q ||
        title.includes(q) ||
        summary.includes(q) ||
        tags.some((t) => t.includes(q));
      const matchTag = !tag || tags.includes(tag);
      return matchQ && matchTag;
    });
  }, [drafts, query, tagFilter]);

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = importDraftJSONAPI(text);
      if (!res.ok) alert(res.error || "Import failed.");
      else
        window.dispatchEvent(
          new CustomEvent("toast", {
            detail: { type: "success", message: "Draft imported." },
          })
        );
    } catch {
      alert("Could not import file.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="sv-grid-2" style={{ marginTop: 12, alignItems: "start" }}>
      <div
        className="sv-card sv-pad"
        style={{ width: "100%", maxWidth: 1320, marginInline: "auto" }}
      >
          <div className="sv-card-title">Your Drafts</div>
          <div className="sv-row sv-wrap" style={{ gap: 8 }}>
            <input
              placeholder="Search drafts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="sv-btn sv-btn--outline"
              style={{ width: 220 }}
            />
            <input
              placeholder="Filter by tag (e.g., keto)"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="sv-btn sv-btn--outline"
              style={{ width: 180 }}
            />
            <label>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                onChange={onImport}
                style={{ display: "none" }}
              />
              <button className="sv-btn sv-btn--outline" type="button">
                <span className="label">Import JSON</span>
              </button>
            </label>
          </div>

        <div className="sv-grid-2" style={{ gap: 12 }}>
          {filteredDrafts.length ? (
            filteredDrafts.map((d) => (
              <div
                key={d.id}
                className={`card ${d.id === selectedDraftId ? "" : ""}`}
                style={
                  d.id === selectedDraftId
                    ? { border: "2px solid var(--primary)" }
                    : null
                }
              >
                <div className="sv-row sv-wrap">
                  <InlineRename draft={d} />
                  <div className="subtitle">
                    Updated {new Date(d.updatedAt).toLocaleString()}
                  </div>
                </div>
                <div className="subtitle">
                  {d.meta?.duration ? (
                    <span style={{ marginRight: 8 }}>
                      Duration: {d.meta.duration}
                    </span>
                  ) : null}
                  {d.meta?.source ? (
                    <span style={{ marginRight: 8 }}>
                      Source: {d.meta.source}
                    </span>
                  ) : null}
                  {d.tags?.length ? (
                    <span style={{ marginRight: 8 }}>
                      {d.tags.map((t) => (
                        <span key={t} className="sv-badge">
                          #{t}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <div
                  className="sv-row sv-wrap"
                  style={{ gap: 8, marginTop: 8 }}
                >
                  <button
                    className="sv-btn sv-btn--outline"
                    onClick={() => selectDraftAPI(d.id)}
                    title="Preview"
                    type="button"
                  >
                    <span className="label">Preview</span>
                  </button>
                  <button
                    className="sv-btn sv-btn--outline"
                    onClick={() => onPublish(d.id)}
                    title="Publish to Current"
                    type="button"
                  >
                    <span className="label">Publish</span>
                  </button>
                  <button
                    className="sv-btn sv-btn--outline"
                    onClick={() => duplicateDraftAPI(d.id)}
                    title="Duplicate"
                    type="button"
                  >
                    <span className="label">Duplicate</span>
                  </button>
                  <button
                    className="sv-btn sv-btn--outline"
                    onClick={() => {
                      const json = exportDraftJSONAPI(d.id);
                      if (!json) return alert("Export failed.");
                      const blob = new Blob([json], {
                        type: "application/json",
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `meal-plan-draft-${d.id}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    title="Export JSON"
                    type="button"
                  >
                    <span className="label">Export</span>
                  </button>
                  <button
                    className="sv-btn sv-btn--outline"
                    onClick={() => deleteDraftAPI(d.id)}
                    title="Delete"
                    type="button"
                  >
                    <span className="label">Delete</span>
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="sv-card sv-pad" style={{ opacity: 0.85 }}>
              No drafts match your filter.
            </div>
          )}
        </div>
      </div>

      <div className="sv-card sv-pad">
        <div className="sv-card-title" style={{ marginBottom: 10 }}>
          Draft Preview
        </div>
        {selectedDraft ? (
          <div className="stack-sm">
            <div className="sv-row sv-wrap" style={{ gap: 8 }}>
              <button
                className="sv-btn sv-btn--outline"
                onClick={() => onPublish(selectedDraft.id)}
                type="button"
              >
                <span className="label">Publish to Current</span>
              </button>
              {onQuickViewAsCurrent ? (
                <button
                  className="sv-btn sv-btn--outline"
                  onClick={() => onQuickViewAsCurrent(selectedDraft)}
                  type="button"
                >
                  <span className="label">Quick View as Current</span>
                </button>
              ) : null}
            </div>
            {/* Minimal inline digest */}
            <div className="subtitle">{selectedDraft.title}</div>
            <div className="subtitle">{selectedDraft.plan?.summary || ""}</div>
            <div style={{ marginTop: 8 }}>
              <div className="subtitle">Meals</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {(selectedDraft.plan?.plan || [])
                  .flatMap((d) =>
                    (d.meals || []).map((m) => ({
                      title: m.title || "Meal",
                      time: m.time || "meal",
                      day: d.day,
                    }))
                  )
                  .slice(0, 12)
                  .map((m, i) => (
                    <li key={i}>
                      Day {m.day}: {m.time} — {m.title}
                    </li>
                  ))}
              </ul>
            </div>
          </div>
        ) : (
          <div className="sv-card sv-pad" style={{ opacity: 0.85 }}>
            Select a draft to preview.
          </div>
        )}
      </div>
    </div>
  );
}

function InlineRename({ draft }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(draft.title);
  const onCommit = () => {
    renameDraftAPI(draft.id, val || draft.title);
    setEditing(false);
  };
  if (!editing) {
    return (
      <div
        className="font-medium hover:underline cursor-text"
        onClick={() => setEditing(true)}
        title="Click to rename"
      >
        {draft.title}
      </div>
    );
  }
  return (
    <div className="sv-row sv-wrap" style={{ gap: 8, alignItems: "center" }}>
      <input
        className="sv-btn sv-btn--outline"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onCommit()}
        autoFocus
        style={{ width: 220 }}
      />
      <button
        className="sv-btn sv-btn--outline"
        onClick={onCommit}
        type="button"
      >
        <span className="label">Save</span>
      </button>
    </div>
  );
}

function MyAssignmentsStrip({ onOpenCoordination }) {
  const rt = useRealtimeCoordination();
  const [busyId, setBusyId] = useState(null);

  const priorityMeta = (item) => {
    const urgency = String(item?.urgency || "").toLowerCase();
    const score = Number(item?.priorityScore || 0);
    const isHigh = urgency === "high" || score >= 80;
    const isLow = urgency === "low" || score <= 35;

    if (isHigh) {
      return {
        label: "High",
        chipStyle: {
          border: "1px solid #ef4444",
          background: "#fef2f2",
          color: "#991b1b",
        },
      };
    }
    if (isLow) {
      return {
        label: "Low",
        chipStyle: {
          border: "1px solid #9ca3af",
          background: "#f9fafb",
          color: "#374151",
        },
      };
    }
    return {
      label: "Normal",
      chipStyle: {
        border: "1px solid #3b82f6",
        background: "#eff6ff",
        color: "#1e3a8a",
      },
    };
  };

  const roles = useMemo(() => {
    if (typeof window === "undefined") return [];
    const fromGlobal = window.__suka?.profile?.roles;
    if (Array.isArray(fromGlobal)) return fromGlobal.map((r) => String(r).toLowerCase());
    const singleRole = window.__suka?.profile?.role;
    if (singleRole) return [String(singleRole).toLowerCase()];
    return [];
  }, []);

  const mine = useMemo(() => {
    const rank = (item) => {
      const urgency = String(item?.urgency || "").toLowerCase();
      const score = Number(item?.priorityScore || 0);
      if (urgency === "high" || score >= 80) return 0;
      if (urgency === "low" || score <= 35) return 2;
      return 1;
    };

    const pending = (rt.suggestions || []).filter((x) => !x.consumedAt);
    const userId = String(rt.userId || "");
    return pending
      .filter((item) => {
        const assignedUser = String(item?.assignedToUserId || "");
        const assignedRole = String(item?.assignedRole || "").toLowerCase();
        const isMineByUser = !!userId && assignedUser && assignedUser === userId;
        const isMineByRole = !!assignedRole && roles.includes(assignedRole);
        return isMineByUser || isMineByRole;
      })
      .sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        const sa = Number(a?.priorityScore || 0);
        const sb = Number(b?.priorityScore || 0);
        return sb - sa;
      })
      .slice(0, 4);
  }, [rt.suggestions, rt.userId, roles]);

  const consume = async (id) => {
    if (!id) return;
    setBusyId(id);
    try {
      await rt.consumeSuggestion(id);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
      <div className="sv-row sv-wrap" style={{ justifyContent: "space-between", gap: 8 }}>
        <div>
          <div className="sv-card-title">My Assignments</div>
          <div className="sv-muted" style={{ fontSize: 12 }}>
            Assigned to you/your role first.
          </div>
        </div>
        <div className="sv-row sv-wrap" style={{ gap: 8 }}>
          <span className={`sv-badge ${rt.connected ? "" : "sv-badge--muted"}`}>
            {rt.connected ? "Live" : "Offline"}
          </span>
          <button
            type="button"
            className="sv-btn sv-btn--outline"
            onClick={onOpenCoordination}
          >
            <span className="label">Open Coordination</span>
          </button>
        </div>
      </div>

      {mine.length ? (
        <div className="sv-row sv-wrap" style={{ marginTop: 10, gap: 8 }}>
          {mine.map((item) => {
            const p = priorityMeta(item);
            return (
            <div key={item.id} className="sv-chip" style={{ maxWidth: 420, ...p.chipStyle }}>
              <span className="sv-badge" style={{ marginRight: 6 }}>{p.label}</span>
              <span
                style={{
                  display: "inline-block",
                  maxWidth: 230,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  verticalAlign: "bottom",
                }}
                title={item.title || item.action || "Assignment"}
              >
                {item.title || item.action || "Assignment"}
              </span>
              <button
                type="button"
                className="sv-btn sv-btn--outline"
                style={{ marginLeft: 8 }}
                onClick={() => consume(item.id)}
                disabled={busyId === item.id}
              >
                <span className="label">
                  {busyId === item.id ? "Consuming..." : "Done"}
                </span>
              </button>
            </div>
          );})}
        </div>
      ) : (
        <div className="sv-muted" style={{ marginTop: 8 }}>
          No current assignments for your user/role.
        </div>
      )}
    </div>
  );
}

/* ---------------- Main page ---------------- */
export default function MealPlanningPage() {
  const coordinationRef = useRef(null);
  const liveContextRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();

  const knownToolIds = useMemo(
    () => new Set([...TOOL_REGISTRY.map((tool) => tool.id), "drafts"]),
    []
  );

  const normalizeToolParam = useCallback(
    (raw) => normalizeMealPlannerTool(raw, knownToolIds),
    [knownToolIds]
  );

  const toolFromQuery = useMemo(() => {
    return resolveToolFromSearch(location.search || "", knownToolIds);
  }, [location.search, knownToolIds]);

  const [activeTool, setActiveTool] = useState(() => toolFromQuery || "dashboard");
  useEffect(() => {
    recordProductActionImpression({
      page: "planner.meal",
      quickActionCount: 5,
      meta: {
        tool: activeTool || "dashboard",
      },
    });
    // Impression tracked once per page mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const probeText = useMemo(
    () => buildMealPlannerProbeText(activeTool),
    [activeTool]
  );
  const [sacredMealAlerts, setSacredMealAlerts] = useState([]);
  const [mealFeed, setMealFeed] = useState([]);
  const [mealContextLoading, setMealContextLoading] = useState(true);
  const [mealContextError, setMealContextError] = useState("");
  const [mealContextActionBusy, setMealContextActionBusy] = useState({});
  const [householdAgenda, setHouseholdAgenda] = useState({
    metrics: {},
    applied: {
      filters: {
        person: "",
        module: "",
        priority: "",
        status: "",
      },
      sortBy: "dueAt",
      sortDirection: "desc",
      limits: {
        today: 10,
        upcoming: 10,
      },
    },
    today: [],
    upcoming: [],
  });
  const [householdAgendaError, setHouseholdAgendaError] = useState("");
  const [agendaFilters, setAgendaFilters] = useState({
    person: "",
    module: "",
    priority: "",
    status: "",
    sortBy: "dueAt",
    sortDirection: "desc",
  });
  const [agendaPersonDraft, setAgendaPersonDraft] = useState("");
  const [communityApprovals, setCommunityApprovals] = useState([]);
  const [communityApprovalsError, setCommunityApprovalsError] = useState("");
  const deferNonCriticalPanels = !isLikelyTestRuntime();
  const [showLiveContextSection, setShowLiveContextSection] = useState(() => !deferNonCriticalPanels);
  const [showContextPanels, setShowContextPanels] = useState(() => !deferNonCriticalPanels);
  const [showCoordinationPanel, setShowCoordinationPanel] = useState(() => !deferNonCriticalPanels);

  const refreshMealContext = useCallback(async () => {
    const householdId = resolvePlannerHouseholdId();
    setMealContextLoading(true);
    setMealContextError("");
    setHouseholdAgendaError("");
    setCommunityApprovalsError("");
    try {
      const [payload, agendaPayload, approvalsPayload] = await Promise.all([
        fetchMealPlannerContext({ householdId }),
        fetchHouseholdTodayUpcomingAgenda({
          householdId,
          todayLimit: 10,
          upcomingLimit: 10,
          person: agendaFilters.person,
          module: agendaFilters.module,
          priority: agendaFilters.priority,
          status: agendaFilters.status,
          sortBy: agendaFilters.sortBy,
          sortDirection: agendaFilters.sortDirection,
        }),
        fetchCommunityApprovals({ householdId }).catch(() => []),
      ]);
      setMealFeed(payload.feed);
      setSacredMealAlerts(payload.alerts);
      setHouseholdAgenda(agendaPayload);
      const normalizedAppliedFilters = normalizeAppliedAgendaFilters(agendaPayload?.applied);
      setAgendaFilters((previous) => {
        if (areAgendaFiltersEqual(previous, normalizedAppliedFilters)) {
          return previous;
        }
        return normalizedAppliedFilters;
      });
      setAgendaPersonDraft((previous) => {
        if (previous === normalizedAppliedFilters.person) {
          return previous;
        }
        return normalizedAppliedFilters.person;
      });
      setCommunityApprovals(approvalsPayload);
    } catch (error) {
      setMealContextError(String(error?.message || error || "Failed to load planner context."));
      setHouseholdAgenda({
        metrics: {},
        applied: {
          filters: {
            person: "",
            module: "",
            priority: "",
            status: "",
          },
          sortBy: "dueAt",
          sortDirection: "desc",
          limits: {
            today: 10,
            upcoming: 10,
          },
        },
        today: [],
        upcoming: [],
      });
      setHouseholdAgendaError("Household timeline unavailable.");
      setCommunityApprovals([]);
      setCommunityApprovalsError("Approvals inbox unavailable.");
    } finally {
      setMealContextLoading(false);
    }
  }, [agendaFilters]);

  useEffect(() => {
    if (!showContextPanels) return;
    refreshMealContext();
  }, [refreshMealContext, showContextPanels]);

  const dismissMealAlert = useCallback(async (id) => {
    const householdId = resolvePlannerHouseholdId();
    setMealContextActionBusy((prev) => ({ ...prev, [id]: true }));
    try {
      const payload = await dismissMealPlannerContextAlert({ householdId, alertId: id, dismiss: true });
      setMealFeed(payload.feed);
      setSacredMealAlerts(payload.alerts);
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: { type: "success", message: "Planner alert dismissed." },
        })
      );
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: {
            type: "error",
            message: `Dismiss failed: ${String(error?.message || error || "unknown")}`,
          },
        })
      );
    } finally {
      setMealContextActionBusy((prev) => ({ ...prev, [id]: false }));
    }
  }, []);

  const onMealFeedAction = useCallback(async (postId, action) => {
    const householdId = resolvePlannerHouseholdId();
    const busyKey = `${postId}:${action}`;
    setMealContextActionBusy((prev) => ({ ...prev, [busyKey]: true }));
    try {
      const payload = await applyMealPlannerFeedAction({ householdId, postId, action, delta: 1 });
      setMealFeed(payload.feed);
      setSacredMealAlerts(payload.alerts);
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: { type: "success", message: `Saved ${action} to planner context.` },
        })
      );
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: {
            type: "error",
            message: `Action failed: ${String(error?.message || error || "unknown")}`,
          },
        })
      );
    } finally {
      setMealContextActionBusy((prev) => ({ ...prev, [busyKey]: false }));
    }
  }, []);

  const onApprovalTransition = useCallback(
    async (approvalId, nextState, reason) => {
      const householdId = resolvePlannerHouseholdId();
      const busyKey = `approval:${approvalId}:${nextState}`;
      setMealContextActionBusy((prev) => ({ ...prev, [busyKey]: true }));
      try {
        await transitionCommunityApproval({ householdId, approvalId, nextState, reason });
        const refreshed = await fetchCommunityApprovals({ householdId });
        setCommunityApprovals(refreshed);
        window.dispatchEvent(
          new CustomEvent("toast", {
            detail: { type: "success", message: `Approval moved to ${nextState}.` },
          })
        );
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("toast", {
            detail: {
              type: "error",
              message: `Approval update failed: ${String(error?.message || error || "unknown")}`,
            },
          })
        );
      } finally {
        setMealContextActionBusy((prev) => ({ ...prev, [busyKey]: false }));
      }
    },
    []
  );

  useEffect(() => {
    if (toolFromQuery && toolFromQuery !== activeTool) {
      setActiveTool(toolFromQuery);
    }
  }, [toolFromQuery, activeTool]);

  useEffect(() => {
    if (location.pathname !== "/meal-planning") return;
    // If URL query has a different valid tool, wait for state to catch up first.
    if (toolFromQuery && toolFromQuery !== activeTool) return;
    const params = new URLSearchParams(location.search || "");
    const current = normalizeToolParam(params.get("tool"));
    if (current === activeTool) return;
    params.set("tool", activeTool);
    navigate({ pathname: "/meal-planning", search: `?${params.toString()}` }, { replace: true });
  }, [activeTool, location.pathname, location.search, navigate, normalizeToolParam, toolFromQuery]);

  /* Form state */
  const [duration, setDuration] = useState("7-day");
  const [prompt, setPrompt] = useState("Plan dinners using pantry first.");
  const [dietary, setDietary] = useState(defaultGoals); // grams mode
  const [restrictions, setRestrictions] = useState("no pork, low sugar");
  const [budget, setBudget] = useState("");
  const [useInventory, setUseInventory] = useState(true);

  /* Macro mode & percentages */
  const [macroMode, setMacroMode] = useState("grams"); // 'grams' | 'percent'
  const [macroPct, setMacroPct] = useState({ protein: 30, carbs: 40, fat: 30 });

  /* Cuisines / Flavor Rhythm */
  const [cuisines, setCuisines] = useState([]);
  const [weeklyFlavor, setWeeklyFlavor] = useState({});

  /* AI template + bundles */
  const [templateId, setTemplateId] = useState("balanced-week");
  const [bundles, setBundles] = useState([]);
  const [selectedBundleIds, setSelectedBundleIds] = useState([]);

  /* Presets */
  const [selectedPresets, setSelectedPresets] = useState([]);

  /* Forecast horizon for companion suggestions */
  const [horizonMonths, setHorizonMonths] = useState(3);

  /* Vision */
  const { options: visionOptions = {} } = useVision();

  /* Run states */
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [result, setResult] = useState(null);

  /* When setPlan isn't available, show an inline viewer */
  const [inlineEnvelope, setInlineEnvelope] = useState(null);
  const inlineRef = useRef(null);

  /* Companion estimates */
  const [estimates, setEstimates] = useState({
    prepTimeHrs: null,
    shoppingCost: null,
    gardenUsePct: null,
    animalOutputs: null,
    cleaningImpact: null,
    suggestions: [],
  });
  const [backendCardContext, setBackendCardContext] = useState({
    loading: true,
    error: "",
    data: null,
  });
  const [lastAutoSyncAt, setLastAutoSyncAt] = useState(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [contractReportCopied, setContractReportCopied] = useState(false);

  function formatTimeAgo(timestamp) {
    if (!Number(timestamp)) return "Never";
    const deltaMs = Math.max(0, nowTick - Number(timestamp));
    const minutes = Math.floor(deltaMs / (60 * 1000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  const buildContractReport = useCallback(() => {
    return {
      exportedAt: new Date().toISOString(),
      householdId: backendCardContext.data?.householdId || resolvePlannerHouseholdId(),
      activeTool,
      loading: backendCardContext.loading,
      error: backendCardContext.error || null,
      checkedFields: backendCardContext.data?.checkedFields || [],
      dataContractGaps: backendCardContext.data?.dataContractGaps || [],
    };
  }, [activeTool, backendCardContext]);

  const refreshBackendCardContext = useCallback(async () => {
    const householdId = resolvePlannerHouseholdId();
    setBackendCardContext((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      const data = await fetchMealPlannerBackendContext({ householdId });
      setBackendCardContext({ loading: false, error: "", data });
      setLastAutoSyncAt(Date.now());
    } catch (error) {
      setBackendCardContext({
        loading: false,
        error: String(error?.message || error || "Failed to load backend planner context."),
        data: null,
      });
    }
  }, [activeTool]);

  useEffect(() => {
    if (!showLiveContextSection) return;
    refreshBackendCardContext();
  }, [refreshBackendCardContext, showLiveContextSection]);

  useEffect(() => {
    const tickId = window.setInterval(() => {
      setNowTick(Date.now());
    }, 60 * 1000);
    return () => {
      window.clearInterval(tickId);
    };
  }, []);

  const copyContractReport = useCallback(async () => {
    const report = buildContractReport();
    const payload = JSON.stringify(report, null, 2);

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const node = document.createElement("textarea");
        node.value = payload;
        node.setAttribute("readonly", "");
        node.style.position = "absolute";
        node.style.left = "-9999px";
        document.body.appendChild(node);
        node.select();
        document.execCommand("copy");
        document.body.removeChild(node);
      }

      setContractReportCopied(true);
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: { type: "success", message: "Contract report copied." },
        })
      );
      window.setTimeout(() => setContractReportCopied(false), 1400);
      recordProductActionClick({
        page: "planner.meal",
        action: "contract_report_copy",
        status: "success",
        mode: activeTool,
      });
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: {
            type: "error",
            message: `Copy failed: ${String(error?.message || error || "unknown")}`,
          },
        })
      );
      recordProductActionClick({
        page: "planner.meal",
        action: "contract_report_copy",
        status: "error",
        mode: activeTool,
      });
    }
  }, [activeTool, buildContractReport]);

  const exportContractReport = useCallback(() => {
    const report = buildContractReport();
    const payload = JSON.stringify(report, null, 2);
    const householdSlug = String(report.householdId || "household").replace(/[^a-zA-Z0-9_-]/g, "-");
    const fileName = `contract-report-${householdSlug}-${Date.now()}.json`;

    try {
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: { type: "success", message: "Contract report exported." },
        })
      );
      recordProductActionClick({
        page: "planner.meal",
        action: "contract_report_export",
        status: "success",
        mode: activeTool,
      });
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: {
            type: "error",
            message: `Export failed: ${String(error?.message || error || "unknown")}`,
          },
        })
      );
      recordProductActionClick({
        page: "planner.meal",
        action: "contract_report_export",
        status: "error",
        mode: activeTool,
      });
    }
  }, [activeTool, buildContractReport]);

  /* Current plan (for Quick View / publish checks) */
  const currentPlan = useMealPlanStore?.((s) => s.plan);
  const setPlan = useMealPlanStore?.((s) => s.setPlan);

  /* Style “Print Full Plan” to match buttons */
  useEffect(() => {
    const styleBtn = () => {
      const nodes = Array.from(document.querySelectorAll("button, a"));
      const target = nodes.find(
        (n) => (n.textContent || "").trim() === "Print Full Plan"
      );
      if (target) {
        target.classList.add("btn", "sm");
        if (!target.querySelector(".label")) {
          const txt = target.textContent;
          target.textContent = "";
          const span = document.createElement("span");
          span.className = "label";
          span.textContent = txt;
          target.appendChild(span);
        }
      }
    };
    styleBtn();
    const obs = new MutationObserver(styleBtn);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  /* Load bundles once */
  useEffect(() => {
    (async () => setBundles(await fetchRecipeBundles()))();
  }, []);

  /* Seed from Vision */
  useEffect(() => {
    const v = visionOptions || {};
    if (Array.isArray(v.preferredCuisines) && v.preferredCuisines.length)
      setCuisines(v.preferredCuisines);
    if (v.weeklyFlavorRhythm && typeof v.weeklyFlavorRhythm === "object")
      setWeeklyFlavor(v.weeklyFlavorRhythm);
  }, [visionOptions]);

  const cuisineOptions = useMemo(() => suggestFlavorOptions(), []);

  const activeToolEntry = useMemo(
    () => TOOL_REGISTRY.find((t) => t.id === activeTool),
    [activeTool]
  );
  const ActiveToolElement = useMemo(
    () => (activeToolEntry ? activeToolEntry.loader() : null),
    [activeToolEntry]
  );

  const compactVision = useMemo(() => {
    const v = visionOptions || {};
    return {
      weeklyFlavorRhythm:
        weeklyFlavor && Object.keys(weeklyFlavor).length
          ? weeklyFlavor
          : v.weeklyFlavorRhythm || {},
      goals: Array.isArray(v.goals) ? v.goals : [],
      constraints: Array.isArray(v.constraints) ? v.constraints : [],
      dietary: Array.isArray(v.dietary) ? v.dietary : [],
      weeklyHrs: v.weeklyHrs ?? "",
      budget: v.budget ?? "",
      calendar:
        v.calendar === "hebrew" || v.calendar === "creation"
          ? v.calendar
          : "gregorian",
      monthStartRule: v.monthStartRule || "fullMoon",
    };
  }, [visionOptions, weeklyFlavor]);

  function toggleCuisine(name) {
    setCuisines((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
    );
  }
  function toggleBundle(id) {
    setSelectedBundleIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }
  function togglePreset(preset) {
    setSelectedPresets((prev) =>
      prev.includes(preset.id)
        ? prev.filter((id) => id !== preset.id)
        : [...prev, preset.id]
    );
    if (!selectedPresets.includes(preset.id)) {
      setPrompt(preset.prompt);
      setDuration(preset.duration);
      if (preset.budgetHint) setBudget(preset.budgetHint);
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: { type: "info", message: `Preset applied: ${preset.title}` },
        })
      );
    }
  }
  function clearPresets() {
    setSelectedPresets([]);
  }

  /* Convert macros if using % mode */
  const dietaryForPayload = useMemo(() => {
    if (macroMode !== "percent") return dietary;
    const grams = pctToGrams(Number(dietary.calories || 0), macroPct);
    return {
      calories: dietary.calories,
      protein: grams.protein,
      carbs: grams.carbs,
      fat: grams.fat,
    };
  }, [macroMode, dietary, macroPct]);

  /* Build companion estimates & suggestions */
  async function buildCompanions(payloadForPlan) {
    const context = backendCardContext?.data || {};
    const backendSuggestions = Array.isArray(context?.suggestions)
      ? context.suggestions
      : [];
    const prepHours = pickFiniteNumber(
      context?.readiness?.avg_prep_hours,
      context?.projectionStatus?.avgPrepHours
    );
    const shoppingCost = pickFiniteNumber(
      context?.costDeltaShoppingCost,
      context?.mealSnapshot?.planner_output?.shoppingCost
    );
    const gardenUse = pickFiniteNumber(
      context?.foodSecurityPct,
      context?.storehouseSnapshot?.planner_output?.gardenUsePct
    );

    setEstimates({
      prepTimeHrs: prepHours,
      shoppingCost,
      gardenUsePct: gardenUse,
      animalOutputs: context?.homesteadSnapshot?.animalPlan || null,
      cleaningImpact: null,
      suggestions: backendSuggestions,
    });
  }

  /* Generate → Save as Draft */
  async function onGenerate(saveAsDraft = false) {
    recordProductActionClick({
      page: "planner.meal",
      action: saveAsDraft ? "generate_to_draft" : "generate_plan",
      status: "click",
      meta: {
        activeTool,
        duration,
      },
    });
    setBusy(true);
    setOk(false);
    setResult(null);
    setInlineEnvelope(null); // clear previous inline view

    const payload = {
      prompt,
      duration,
      dietaryGoals: dietaryForPayload,
      dietaryRestrictions: restrictions
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      budgetLimit: budget ? Number(budget) : null,
      useInventory,
      preferences: {},
      settings: {},
      location: {},
      people: undefined,
      vision: compactVision,
      templateId,
      cuisines,
      bundles: selectedBundleIds,
      presets: selectedPresets,
      macrosPct: macroMode === "percent" ? macroPct : null,
      horizonMonths,
      options: saveAsDraft ? { saveAsDraft: true } : { saveToStore: true },
    };

    try {
      buildCompanions(payload); // non-blocking
      let res = null;

      const householdId = resolvePlannerHouseholdId();
      const backendOut = await requestHouseholdAutomationPlan({
        householdId,
        preferences: {
          cuisines,
          dietaryNeeds: restrictions
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
        goals: {
          prompt,
          duration,
          calories: Number(dietaryForPayload?.calories || 0),
        },
        history: {
          presets: selectedPresets,
          bundles: selectedBundleIds,
        },
      });

      const normalizedFromBackend = normalizeAssistantBundlePlan(
        backendOut?.bundle,
        duration
      );
      if (!normalizedFromBackend) {
        throw new Error("Backend planner did not return a usable meal plan payload.");
      }

      res = {
        ok: true,
        mealPlan: coerceToEnvelope(normalizedFromBackend),
        data: {
          source: "backend_assistant",
          householdId,
        },
      };
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: {
            type: "success",
            message: "Generated via backend planner assistant.",
          },
        })
      );

      refreshBackendCardContext();

      const normalized = normalizePlan(res);
      const mealCount = Array.isArray(normalized?.meals) ? normalized.meals.length : 0;
      if (!res?.ok || mealCount < 1) {
        throw new Error(buildGenerateFailureMessage(res, normalized));
      }
      setResult(normalized);
      setOk(true);
      recordProductActionClick({
        page: "planner.meal",
        action: saveAsDraft ? "generate_to_draft" : "generate_plan",
        status: "success",
        meta: {
          activeTool,
          mealCount,
        },
      });

      const normalizedForDownstream = normalized;

      // Auto-forward normalized generated plan into downstream estimate inputs.
      // This keeps animal/garden/preservation estimation grounded in final outputs.
      const estimateInputs = buildEstimateInputsFromNormalizedPlan({
        normalizedPlan: normalizedForDownstream,
        meta: {
          sessionId: res?.data?.draftId || null,
          horizonMonths,
        },
      });

      try {
        const upsertPreservationTasks =
          useStorehousePlannerStore?.getState?.()?.upsertPreservationTasks;
        if (
          typeof upsertPreservationTasks === "function" &&
          Array.isArray(estimateInputs?.preservation?.tasks) &&
          estimateInputs.preservation.tasks.length
        ) {
          upsertPreservationTasks(estimateInputs.preservation.tasks);
        }
      } catch (e) {
        console.warn("[MealPlanner] preservation forward failed", e);
      }

      eventBus?.emit?.("planner.estimateInputs.updated", {
        source: "mealplanner:onGenerate",
        estimateInputs,
        normalizedPlan: normalizedForDownstream,
      });

      const gapsEmission = emitPlannerGapsUpdated({
        estimateInputs,
        normalizedPlan: normalizedForDownstream,
        meta: {
          sessionId: res?.data?.draftId || null,
          duration,
        },
        eventBusEmit: eventBus?.emit,
      });

      const plannerGaps = gapsEmission?.plannerGaps || null;

      buildCompanions({
        ...payload,
        normalizedPlan: normalizedForDownstream,
        estimateInputs,
      });

      // Ensure a real local draft record exists whenever draft mode is used.
      // Some upstream flows may return draftId without persisting to MealPlanDraftStore.
      let ensuredDraftId = res?.data?.draftId || null;
      let usedLocalDraftBridge = false;
      if (saveAsDraft) {
        const existing = ensuredDraftId ? getDraftAPI(ensuredDraftId) : null;
        if (!existing) {
          const candidatePlan =
            res?.mealPlan ||
            res?.data?.mealPlan ||
            res?.data?.plan ||
            coerceToEnvelope(normalizedForDownstream);

          if (candidatePlan?.plan?.length) {
            ensuredDraftId = await saveDraftAPI(candidatePlan, {
              id: ensuredDraftId || undefined,
              title: candidatePlan.summary || "Generated draft",
              meta: {
                duration,
                createdBy: "agent:generate",
                source: "mealplanner:onGenerate",
              },
              tags: ["generated"],
            });
            usedLocalDraftBridge = true;
          }
        }
      }

      const persistenceResult = await persistMealPlannerGeneration({
        normalizedPlan: normalizedForDownstream,
        saveAsDraft,
        duration,
        templateId,
        cuisines,
        presets: selectedPresets,
        horizonMonths,
        plannerGaps,
        estimateInputs,
        currentPlanId: currentPlan?.id || null,
        inferredPlanId: ensuredDraftId || res?.data?.draftId || null,
      });
      if (!persistenceResult?.ok && !persistenceResult?.skipped) {
        console.warn(
          "[MealPlanner] planner API save failed (non-blocking)",
          persistenceResult?.error || persistenceResult
        );
      }

      /* ✅ PATCH: always force the generated plan into the Current Plan store and switch to Dashboard */
      if (!saveAsDraft) {
        try {
          const envelope = coerceToEnvelope(normalizedForDownstream);
          const setter =
            useMealPlanStore?.getState?.()?.setPlan ||
            (typeof setPlan === "function" ? setPlan : null);

          if (envelope && typeof setter === "function") {
            // setPlan signature may be (plan, meta) – we pass meta defensively
            setter(envelope, {
              createdAt: new Date().toISOString(),
              source: "mealplanner:onGenerate",
              templateId,
              cuisines,
              presets: selectedPresets,
              duration,
            });
          } else if (envelope) {
            // Inline full viewer if store is missing
            setInlineEnvelope(envelope);
          }
        } catch (e) {
          console.warn("[MealPlanner] setPlan bridge failed", e);
          try {
            const envelope = coerceToEnvelope(normalizedForDownstream);
            if (envelope) setInlineEnvelope(envelope);
          } catch {}
        }
        setActiveTool("dashboard");
      }
      /* ✅ END PATCH */

      if (saveAsDraft) {
        if (ensuredDraftId) {
          try {
            selectDraftAPI(ensuredDraftId);
          } catch {}
        }
        setActiveTool("drafts");
      }

      automation?.emit?.("meal/planGenerated", {
        res: normalizedForDownstream,
        meta: { templateId, cuisines, presets: selectedPresets },
      });

      // Canonical realtime signal for aggregator queue routing.
      emitCanonicalSignal({
        type: currentPlan?.plan?.length ? "mealUpdated" : "mealAdded",
        sourceModule: "planner.meal",
        urgency: "normal",
        completionPct: 100,
        dependencies: ["inventory", "storehouse", "sessions"],
        payload: {
          templateId,
          cuisines,
          presets: selectedPresets,
          duration,
          saveAsDraft,
          mealCount: Array.isArray(normalizedForDownstream?.meals)
            ? normalizedForDownstream.meals.length
            : 0,
          shoppingCount: Array.isArray(normalizedForDownstream?.shoppingList)
            ? normalizedForDownstream.shoppingList.length
            : 0,
        },
      });

      emitHomesteadMealPlanGenerated({
        normalizedPlan: normalizedForDownstream,
        meta: {
          templateId,
          cuisines,
          presets: selectedPresets,
          duration,
          saveAsDraft,
        },
        eventBusEmit: eventBus?.emit?.bind(eventBus),
      });

      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: {
            type: "success",
            message: saveAsDraft ? "Draft generated." : "Meal plan generated.",
          },
        })
      );

      if (saveAsDraft && usedLocalDraftBridge) {
        window.dispatchEvent(
          new CustomEvent("toast", {
            detail: {
              type: "success",
              message: "Draft auto-saved locally.",
            },
          })
        );
      }

      setTimeout(() => setOk(false), 900);
    } catch (e) {
      recordProductActionClick({
        page: "planner.meal",
        action: saveAsDraft ? "generate_to_draft" : "generate_plan",
        status: "error",
        meta: {
          activeTool,
          message: String(e?.message || e || "unknown"),
        },
      });
      setResult({
        title: "Meal Plan",
        summary: e?.message || String(e),
        meals: [],
        shoppingList: [],
        prepTasks: [],
        budget: {},
        macros: {},
      });
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: {
            type: "error",
            message: "Meal plan failed. Check console.",
          },
        })
      );
      console.error("[MealPlanningPage] generate failed:", e);
    } finally {
      setBusy(false);
    }
  }

  async function onPublishDraft(draftId) {
    const res = await publishDraftAPI(draftId);
    if (!res?.ok) {
      alert(res?.error || "Failed to publish draft.");
    } else {
      emitCanonicalSignal({
        type: "mealUpdated",
        sourceModule: "planner.meal",
        urgency: "normal",
        completionPct: 100,
        dependencies: ["inventory", "sessions"],
        payload: {
          draftId,
          action: "publishDraft",
        },
      });

      setActiveTool("dashboard");
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: {
            type: "success",
            message: "Draft published to current plan.",
          },
        })
      );
    }
  }

  async function onSaveCurrentAsDraft() {
    recordProductActionClick({
      page: "planner.meal",
      action: "save_current_as_draft",
      status: "click",
      meta: {
        activeTool,
      },
    });
    const current = currentPlan;
    if (!current?.plan?.length) {
      alert("No current plan found.");
      return;
    }
    await saveDraftAPI(current, {
      title: current.summary || "Current Plan (snapshot)",
      meta: { createdBy: "user:snapshot" },
      tags: ["snapshot"],
    });
    window.dispatchEvent(
      new CustomEvent("toast", {
        detail: { type: "success", message: "Current plan saved as draft." },
      })
    );
    recordProductActionClick({
      page: "planner.meal",
      action: "save_current_as_draft",
      status: "success",
      meta: {
        activeTool,
      },
    });
  }

  const quickAgents = [
    {
      id: "soil/planIrrigation",
      label: "Irrigation Planner",
      note: "Creates rain-aware irrigation schedule.",
      run: async () =>
        tryAgent(null, "planIrrigation", {
          beds: [],
          irrigationHardware: {},
          weather: [],
          cropCoefficients: {},
          settings: {},
        }),
    },
    {
      id: "compost/estimateOutputs",
      label: "Compost — Estimate Outputs",
      note: "Converts animal waste to compost estimates.",
      run: async () =>
        tryAgent(null, "estimateOutputs", {
          animals: [],
          beddingInventory: [],
          compostSystem: {},
          options: { horizonDays: 30 },
        }),
    },
  ];

  /* -------- helper for AutomationPanel emit -------- */
  const handleAutomationEmit = (eventName, payload) => {
    try {
      if (automation && typeof automation.emit === "function") {
        automation.emit(eventName, payload);
      }
    } catch (e) {
      console.error("[AutomationPanel] emit failed", e);
    }
  };

  const openMealThread = (prefill = "Need support coordinating the next meal planning cycle.") => {
    try {
      eventBus.emit("profile/messages/open-thread", {
        type: "profile/messages/open-thread",
        source: "mealplanner.page",
        data: {
          conversationId: "dm-1",
          moduleKey: "meals",
          actionType: "assist",
          prefill,
        },
      });
    } catch {
      // Message intent should not block planner workflows.
    }
  };

  /* ---------------------------- Render ---------------------------- */
  return (
    <div className="sv-container ssa-content-flow">
      <div
        data-testid="meal-planner-content-probe"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clipPath: "inset(50%)",
          whiteSpace: "nowrap",
        }}
        aria-live="polite"
      >
        {probeText}
      </div>

      <div className="sv-hero sv-pad ssa-hero-wrap">
        <div
          className="sv-row sv-wrap"
          style={{ justifyContent: "space-between", alignItems: "flex-end" }}
        >
          <div>
            <div className="sv-row sv-wrap" style={{ gap: 8, alignItems: "center" }}>
              <h1 className="sv-pageTitle m-0 text-[var(--ssa-text-primary)]">Meal Planner</h1>
              <span className="ssa-hero-chip">
                Last auto-sync: {formatTimeAgo(lastAutoSyncAt)}
              </span>
            </div>
            <div className="sv-muted text-[var(--ssa-text-secondary)]">
              Organize cycles, prep tasks, drafts, and procurement with one
              click.
            </div>
          </div>

          <div className="sv-actions ssa-hero-actions">
            <SSAButton
              aria-busy={busy}
              onClick={() => onGenerate(false)}
              title="Generate and publish to Current Plan"
              type="button"
            >
              {busy ? "Working..." : "Generate Plan"}
            </SSAButton>
            <SSAButton
              variant="secondary"
              onClick={() => {
                setShowLiveContextSection(true);
                setShowContextPanels(true);
                liveContextRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              type="button"
            >
              Load Live Context
            </SSAButton>
            {ok ? (
              <span className="sv-muted" style={{ color: "var(--success)" }}>
                ✓ Done
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="sv-card sv-pad ssa-panel-balanced ssa-interactive-panel" style={{ marginTop: 12 }}>
        <div className="sv-row sv-wrap" style={{ justifyContent: "space-between", gap: 10, alignItems: "center" }}>
          <div>
            <strong style={{ color: "var(--fg)" }}>First Paint Shell</strong>
            <div className="sv-muted" style={{ marginTop: 4 }}>
              Heavy coordination, contract, feed, alerts, and dashboard cards are deferred until requested.
            </div>
          </div>
          <div className="sv-row sv-wrap" style={{ gap: 8 }}>
            <SSAButton
              type="button"
              variant="secondary"
              onClick={() => {
                setShowCoordinationPanel(true);
                coordinationRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              Load Coordination
            </SSAButton>
            <SSAButton
              type="button"
              variant="secondary"
              onClick={() => {
                setShowLiveContextSection(true);
                setShowContextPanels(true);
                liveContextRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              Load Live Context
            </SSAButton>
            <SSAButton
              type="button"
              variant="secondary"
              onClick={() => liveContextRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              Jump to Live Context
            </SSAButton>
          </div>
        </div>
      </div>

      <MyAssignmentsStrip
        onOpenCoordination={() => {
          setShowCoordinationPanel(true);
          coordinationRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />

      <div style={{ marginTop: 12 }} ref={coordinationRef}>
        {showCoordinationPanel ? (
          <LoadingBoundary placeholder={<div className="sv-muted">Loading coordination panel...</div>}>
            <RealtimeCoordinationPanel />
          </LoadingBoundary>
        ) : (
          <div className="sv-card sv-pad ssa-panel-balanced ssa-interactive-panel">
            <div className="sv-row sv-wrap" style={{ justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <div>
                <strong style={{ color: "var(--fg)" }}>Coordination</strong>
                <div className="sv-muted" style={{ marginTop: 4 }}>
                  Deferred until requested to keep first paint minimal.
                </div>
              </div>
              <SSAButton type="button" variant="secondary" onClick={() => setShowCoordinationPanel(true)}>
                Load coordination panel
              </SSAButton>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12 }} ref={liveContextRef}>
        <div className="sv-card sv-pad ssa-panel-balanced ssa-interactive-panel">
          <div className="sv-row sv-wrap" style={{ justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <strong style={{ color: "var(--fg)" }}>Live Planner Context</strong>
            {!showLiveContextSection ? (
              <SSAButton
                type="button"
                variant="secondary"
                onClick={() => {
                  setShowLiveContextSection(true);
                  setShowContextPanels(true);
                  refreshBackendCardContext();
                }}
              >
                Load dashboard context
              </SSAButton>
            ) : null}
          </div>

          {showLiveContextSection ? (
            <>
              <div style={{ marginTop: 12, width: "100%", maxWidth: 1420, marginInline: "auto" }}>
                <DashboardGrid columns={3}>
                  <SacredCard
                    kind="dashboard"
                    title="Planner Mode"
                    subtitle="Backend planner context"
                    value={
                      backendCardContext.loading
                        ? "Loading..."
                        : backendCardContext.data?.plannerMode?.tool || "Contract gap"
                    }
                    delta={3}
                    icon={<CalendarDays className="h-5 w-5" />}
                    footer={
                      backendCardContext.error
                        ? `Backend error: ${backendCardContext.error}`
                        : backendCardContext.data?.dataContractGaps?.includes("plannerMode.tool")
                        ? "Data contract gap: plannerMode.tool missing"
                        : backendCardContext.data?.plannerMode?.status || "Planner mode unavailable"
                    }
                  >
                    {backendCardContext.loading
                      ? "Loading planner mode from backend..."
                      : backendCardContext.data?.plannerMode?.lastRunAt
                      ? `Last backend run: ${new Date(
                          backendCardContext.data.plannerMode.lastRunAt
                        ).toLocaleString()}`
                      : "No backend run timestamp returned."}
                  </SacredCard>
                  <SacredCard
                    kind="meal"
                    title="Food Security"
                    subtitle="Backend estimator signal"
                    value={
                      backendCardContext.loading
                        ? "Loading..."
                        : backendCardContext.data?.foodSecurityPct != null
                        ? `${Math.round(Number(backendCardContext.data.foodSecurityPct))}%`
                        : "Contract gap"
                    }
                    delta={2}
                    icon={<Leaf className="h-5 w-5" />}
                    footer={
                      backendCardContext.error
                        ? "Estimator unavailable in backend"
                        : backendCardContext.data?.dataContractGaps?.includes("foodSecurityPct")
                        ? "Data contract gap: foodSecurityPct missing"
                        : "Current cycle confidence"
                    }
                  >
                    {backendCardContext.loading
                      ? "Requesting food-security signal from backend planner endpoints..."
                      : backendCardContext.data?.dataContractGaps?.includes("foodSecurityPct")
                      ? "Backend did not return foodSecurityPct. Check planner_output contract."
                      : "Uses backend planner context to estimate resilience."}
                  </SacredCard>
                  <SacredCard
                    kind="storehouse"
                    title="Cost Delta"
                    subtitle="Backend projected shopping cost"
                    value={
                      backendCardContext.loading
                        ? "Loading..."
                        : backendCardContext.data?.costDeltaShoppingCost != null
                        ? `$${Number(backendCardContext.data.costDeltaShoppingCost).toFixed(2)}`
                        : "Contract gap"
                    }
                    delta={1}
                    icon={<ShoppingBasket className="h-5 w-5" />}
                    footer={
                      backendCardContext.error
                        ? "Backend cost delta unavailable"
                        : backendCardContext.data?.dataContractGaps?.includes("costDeltaShoppingCost")
                        ? "Data contract gap: costDeltaShoppingCost missing"
                        : "Compared to baseline"
                    }
                    interactionTitle="Open procurement view"
                    onClick={() => {
                      navigate({ pathname: "/meal-planning", search: "?tool=procurement" }, { replace: false });
                      recordProductActionClick({
                        page: "planner.meal",
                        action: "cost_delta_open_procurement",
                        status: "click",
                        mode: activeTool,
                      });
                    }}
                  >
                    {backendCardContext.data?.dataContractGaps?.includes("costDeltaShoppingCost")
                      ? "Backend did not return costDeltaShoppingCost. Check planner_output budget/costDelta fields."
                      : "Watch this to keep budget drift visible before purchase runs."}
                  </SacredCard>
                </DashboardGrid>

                {showContextPanels ? (
                  <div
                    className="sv-card"
                    style={{
                      marginTop: 10,
                      padding: 12,
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                    }}
                  >
                    {/* Strict mode contract panel: makes missing backend keys explicit for the current run. */}
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <strong style={{ color: "var(--fg)" }}>Contract Fields (Strict Backend)</strong>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span className="sv-muted" style={{ fontSize: 12 }}>
                          Household: {backendCardContext.data?.householdId || resolvePlannerHouseholdId()}
                        </span>
                        <SSAButton
                          type="button"
                          variant="secondary"
                          onClick={copyContractReport}
                          title="Copy strict backend contract report to clipboard"
                          className="min-h-[34px]"
                        >
                          {contractReportCopied ? "Copied" : "Copy Contract Report"}
                        </SSAButton>
                        <SSAButton
                          type="button"
                          variant="secondary"
                          onClick={exportContractReport}
                          title="Download strict backend contract report as .json"
                          className="min-h-[34px]"
                        >
                          Export .json
                        </SSAButton>
                      </div>
                    </div>

                    {backendCardContext.loading ? (
                      <div className="sv-muted" style={{ marginTop: 8 }}>
                        Checking backend contract fields...
                      </div>
                    ) : backendCardContext.error ? (
                      <div style={{ marginTop: 8, color: "var(--danger)" }}>
                        Backend error: {backendCardContext.error}
                      </div>
                    ) : (
                      <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                        {(backendCardContext.data?.checkedFields || []).map((field) => {
                          const isMissing = field?.status === "missing";
                          return (
                            <div
                              key={field?.key}
                              style={{
                                display: "grid",
                                gridTemplateColumns: "180px 90px 1fr",
                                gap: 10,
                                alignItems: "center",
                                padding: "6px 8px",
                                borderRadius: 10,
                                background: isMissing
                                  ? "color-mix(in srgb, var(--danger) 10%, var(--surface))"
                                  : "color-mix(in srgb, var(--success) 8%, var(--surface))",
                                border: `1px solid ${isMissing ? "color-mix(in srgb, var(--danger) 45%, var(--border))" : "color-mix(in srgb, var(--success) 35%, var(--border))"}`,
                                fontSize: 12,
                              }}
                            >
                              <code style={{ color: "var(--fg)" }}>{field?.key}</code>
                              <span
                                style={{
                                  fontWeight: 700,
                                  color: isMissing ? "var(--danger)" : "var(--success)",
                                }}
                              >
                                {isMissing ? "missing" : "present"}
                              </span>
                              <span className="sv-muted" style={{ overflowWrap: "anywhere" }}>
                                {field?.source ? `source: ${field.source}` : "source: n/a"}
                                {field?.value != null ? ` | value: ${String(field.value)}` : ""}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="sv-card sv-pad" style={{ marginTop: 10 }}>
                    <div className="sv-row sv-wrap" style={{ justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                      <div className="sv-muted">Live planner context panels load after first paint.</div>
                      <SSAButton type="button" variant="secondary" onClick={() => setShowContextPanels(true)}>
                        Load now
                      </SSAButton>
                    </div>
                  </div>
                )}
              </div>

              {showContextPanels ? (
                <div style={{ marginTop: 12, display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
                  <div className="sv-card sv-pad">
                    <div className="sv-row sv-wrap" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <strong style={{ color: "var(--fg)" }}>Planner Activity Feed</strong>
                      <SSAButton type="button" variant="secondary" onClick={refreshMealContext}>
                        Refresh
                      </SSAButton>
                    </div>
                    {mealContextLoading ? (
                      <div className="sv-muted" style={{ marginTop: 8 }}>Loading planner context from backend...</div>
                    ) : mealContextError ? (
                      <>
                        <div className="sv-muted" style={{ marginTop: 6 }}>{mealContextError}</div>
                        <button type="button" className="sv-btn sv-btn--outline" onClick={refreshMealContext} style={{ marginTop: 10 }}>
                          <span className="label">Retry</span>
                        </button>
                      </>
                    ) : (
                      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                        {mealFeed.length ? (
                          mealFeed.map((item) => (
                            <FeedPost
                              key={item.id}
                              {...item}
                              onLike={() => onMealFeedAction(item.id, "like")}
                              onComment={() => onMealFeedAction(item.id, "comment")}
                              onShare={() => onMealFeedAction(item.id, "share")}
                              busyLike={Boolean(mealContextActionBusy[`${item.id}:like`])}
                              busyComment={Boolean(mealContextActionBusy[`${item.id}:comment`])}
                              busyShare={Boolean(mealContextActionBusy[`${item.id}:share`])}
                            />
                          ))
                        ) : (
                          <div className="sv-muted">No planning feed items returned from backend.</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="sv-card sv-pad">
                    <strong style={{ color: "var(--fg)" }}>Planner Alerts</strong>
                    {mealContextLoading ? (
                      <div className="sv-muted" style={{ marginTop: 8 }}>Loading planner alerts...</div>
                    ) : mealContextError ? (
                      <div className="sv-muted" style={{ marginTop: 8 }}>Alerts unavailable while planner context is failing.</div>
                    ) : (
                      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                        {sacredMealAlerts.length ? (
                          sacredMealAlerts.map((item) => (
                            <Notification
                              key={item.id}
                              type={item.type}
                              title={item.title}
                              message={item.message}
                              timestamp={item.timestamp}
                              updatedBy={item.updatedBy}
                              actionLog={item.actionLog}
                              lastAction={item.lastAction}
                              lastActionAt={item.lastActionAt}
                              dismissing={Boolean(mealContextActionBusy[item.id])}
                              onDismiss={() => dismissMealAlert(item.id)}
                            />
                          ))
                        ) : (
                          <div className="sv-muted">No planner alerts returned from backend.</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="sv-card sv-pad">
                    <strong style={{ color: "var(--fg)" }}>Household Today and Upcoming</strong>
                    <div
                      style={{
                        marginTop: 8,
                        display: "grid",
                        gap: 8,
                        gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                      }}
                    >
                      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                        <span className="sv-muted">Module</span>
                        <select
                          value={agendaFilters.module}
                          onChange={(event) =>
                            setAgendaFilters((prev) => ({ ...prev, module: String(event.target.value || "") }))
                          }
                        >
                          <option value="">All</option>
                          <option value="meal">meal</option>
                          <option value="cleaning">cleaning</option>
                          <option value="storehouse">storehouse</option>
                          <option value="homestead">homestead</option>
                          <option value="community">community</option>
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                        <span className="sv-muted">Priority</span>
                        <select
                          value={agendaFilters.priority}
                          onChange={(event) =>
                            setAgendaFilters((prev) => ({ ...prev, priority: String(event.target.value || "") }))
                          }
                        >
                          <option value="">All</option>
                          <option value="critical">critical</option>
                          <option value="high">high</option>
                          <option value="normal">normal</option>
                          <option value="low">low</option>
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                        <span className="sv-muted">Status</span>
                        <select
                          value={agendaFilters.status}
                          onChange={(event) =>
                            setAgendaFilters((prev) => ({ ...prev, status: String(event.target.value || "") }))
                          }
                        >
                          <option value="">All</option>
                          <option value="blocked">blocked</option>
                          <option value="pending_approval">pending_approval</option>
                          <option value="active">active</option>
                          <option value="draft">draft</option>
                          <option value="planned">planned</option>
                          <option value="completed">completed</option>
                          <option value="archived">archived</option>
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                        <span className="sv-muted">Sort</span>
                        <select
                          value={agendaFilters.sortBy}
                          onChange={(event) =>
                            setAgendaFilters((prev) => ({ ...prev, sortBy: String(event.target.value || "dueAt") }))
                          }
                        >
                          <option value="dueAt">dueAt</option>
                          <option value="priority">priority</option>
                          <option value="status">status</option>
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                        <span className="sv-muted">Direction</span>
                        <select
                          value={agendaFilters.sortDirection}
                          onChange={(event) =>
                            setAgendaFilters((prev) => ({ ...prev, sortDirection: String(event.target.value || "desc") }))
                          }
                        >
                          <option value="desc">desc</option>
                          <option value="asc">asc</option>
                        </select>
                      </label>
                    </div>
                    <div className="sv-row sv-wrap" style={{ marginTop: 8, gap: 8 }}>
                      <input
                        type="text"
                        value={agendaPersonDraft}
                        onChange={(event) => setAgendaPersonDraft(String(event.target.value || ""))}
                        placeholder="Filter by person handle"
                        style={{ flex: "1 1 220px" }}
                      />
                      <SSAButton
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          setAgendaFilters((prev) => ({
                            ...prev,
                            person: String(agendaPersonDraft || "").trim().toLowerCase(),
                          }))
                        }
                      >
                        Apply Person
                      </SSAButton>
                      <SSAButton
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          setAgendaPersonDraft("");
                          setAgendaFilters({
                            person: "",
                            module: "",
                            priority: "",
                            status: "",
                            sortBy: "dueAt",
                            sortDirection: "desc",
                          });
                        }}
                      >
                        Reset Filters
                      </SSAButton>
                    </div>
                    {mealContextLoading ? (
                      <div className="sv-muted" style={{ marginTop: 8 }}>Loading household timeline...</div>
                    ) : householdAgendaError ? (
                      <div className="sv-muted" style={{ marginTop: 8 }}>{householdAgendaError}</div>
                    ) : (
                      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                        <div className="sv-muted" style={{ fontSize: 12 }}>
                          Today: {Number(householdAgenda?.metrics?.todayCount || 0)} | Upcoming: {Number(householdAgenda?.metrics?.upcomingCount || 0)}
                        </div>
                        <div className="sv-muted" style={{ fontSize: 12 }}>
                          Applied: {String(householdAgenda?.applied?.filters?.module || "all modules")}
                          {householdAgenda?.applied?.filters?.priority
                            ? ` | ${String(householdAgenda.applied.filters.priority)} priority`
                            : ""}
                          {householdAgenda?.applied?.filters?.status
                            ? ` | ${String(householdAgenda.applied.filters.status)} status`
                            : ""}
                          {householdAgenda?.applied?.filters?.person
                            ? ` | person ${String(householdAgenda.applied.filters.person)}`
                            : ""}
                          {` | sort ${String(householdAgenda?.applied?.sortBy || "dueAt")}:${String(householdAgenda?.applied?.sortDirection || "desc")}`}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>Today</div>
                          {householdAgenda.today.length ? (
                            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
                              {householdAgenda.today.slice(0, 4).map((item) => (
                                <li key={item.id} style={{ color: "var(--fg)", fontSize: 13 }}>
                                  <div style={{ display: "grid", gap: 2 }}>
                                    <span>{item.title}</span>
                                    <span className="sv-muted" style={{ fontSize: 11 }}>
                                      {String(item?.module || item?.lane || "household")} | {String(item?.workflowState || item?.state || "planned")}
                                      {item?.priority ? ` | ${String(item.priority)}` : ""}
                                      {item?.recurrenceEnabled ? " | recurring" : ""}
                                      {item?.hasDependencyBlock ? ` | blocked by ${Number(item?.blockingDependencyCount || 0)} deps` : ""}
                                      {item?.hasConflict ? ` | conflicts ${Number(item?.conflictCount || 0)}` : ""}
                                      {item?.overdue ? " | overdue" : ""}
                                    </span>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div className="sv-muted">No current today items.</div>
                          )}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>Upcoming</div>
                          {householdAgenda.upcoming.length ? (
                            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
                              {householdAgenda.upcoming.slice(0, 4).map((item) => (
                                <li key={item.id} style={{ color: "var(--fg)", fontSize: 13 }}>
                                  <div style={{ display: "grid", gap: 2 }}>
                                    <span>{item.title}</span>
                                    <span className="sv-muted" style={{ fontSize: 11 }}>
                                      {String(item?.module || item?.lane || "household")} | {String(item?.workflowState || item?.state || "planned")}
                                      {item?.priority ? ` | ${String(item.priority)}` : ""}
                                      {item?.recurrenceEnabled ? " | recurring" : ""}
                                      {item?.hasDependencyBlock ? ` | blocked by ${Number(item?.blockingDependencyCount || 0)} deps` : ""}
                                      {item?.hasConflict ? ` | conflicts ${Number(item?.conflictCount || 0)}` : ""}
                                      {item?.overdue ? " | overdue" : ""}
                                    </span>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div className="sv-muted">No upcoming items.</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="sv-card sv-pad">
                    <strong style={{ color: "var(--fg)" }}>Approvals Inbox</strong>
                    {mealContextLoading ? (
                      <div className="sv-muted" style={{ marginTop: 8 }}>Loading approvals...</div>
                    ) : communityApprovalsError ? (
                      <div className="sv-muted" style={{ marginTop: 8 }}>{communityApprovalsError}</div>
                    ) : (
                      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                        {communityApprovals.length ? (
                          communityApprovals.slice(0, 6).map((approval) => {
                            const approvalId = String(approval?.id || "");
                            const workflowState = String(approval?.workflowState || "pending_approval");
                            const allow = new Set(
                              Array.isArray(approval?.allowedNextStates)
                                ? approval.allowedNextStates
                                : []
                            );
                            return (
                              <div
                                key={approvalId}
                                style={{
                                  border: "1px solid var(--border)",
                                  borderRadius: 12,
                                  padding: 10,
                                  display: "grid",
                                  gap: 8,
                                }}
                              >
                                <div className="sv-row sv-wrap" style={{ justifyContent: "space-between", gap: 8 }}>
                                  <div style={{ fontWeight: 700, color: "var(--fg)" }}>
                                    {String(approval?.subjectType || "approval").replace(/_/g, " ")}
                                  </div>
                                  <div className="sv-muted" style={{ fontSize: 12 }}>
                                    State: {workflowState}
                                  </div>
                                </div>
                                <div className="sv-muted" style={{ fontSize: 12 }}>
                                  Reason: {String(approval?.reason || "unspecified")}
                                </div>
                                <div className="sv-row sv-wrap" style={{ gap: 8 }}>
                                  <SSAButton
                                    type="button"
                                    variant="secondary"
                                    disabled={!allow.has("active") || Boolean(mealContextActionBusy[`approval:${approvalId}:active`])}
                                    onClick={() =>
                                      onApprovalTransition(approvalId, "active", "Approved from meal planner inbox")
                                    }
                                  >
                                    Approve
                                  </SSAButton>
                                  <SSAButton
                                    type="button"
                                    variant="secondary"
                                    disabled={!allow.has("blocked") || Boolean(mealContextActionBusy[`approval:${approvalId}:blocked`])}
                                    onClick={() =>
                                      onApprovalTransition(approvalId, "blocked", "Rejected from meal planner inbox")
                                    }
                                  >
                                    Reject
                                  </SSAButton>
                                  <SSAButton
                                    type="button"
                                    variant="secondary"
                                    disabled={!allow.has("archived") || Boolean(mealContextActionBusy[`approval:${approvalId}:archived`])}
                                    onClick={() =>
                                      onApprovalTransition(approvalId, "archived", "Archived from meal planner inbox")
                                    }
                                  >
                                    Archive
                                  </SSAButton>
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div className="sv-muted">No pending approvals for this household.</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="sv-muted" style={{ marginTop: 8 }}>
              Live dashboard context is deferred until first paint settles.
            </div>
          )}
        </div>
      </div>

      {/* Two-column workbench: left = inputs, right = outputs */}
      <div className="sv-grid-2" style={{ marginTop: 14, alignItems: "start" }}>
        <div className="sv-stack-sm">
          {/* Plan Settings (moved to replace Workspace) */}
          <div className="sv-card sv-pad">
            <SectionTitle
              title="Plan Settings"
              subtitle="Minimal inputs → full plan with shopping list, prep, and scheduling."
            />

            {/* Tabs moved here (Workspace removed) */}
            <div
              className="sv-row sv-wrap"
              style={{
                gap: 8,
                marginTop: 10,
                justifyContent: "flex-start",
                alignItems: "center",
              }}
            >
              {TOOL_REGISTRY.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setActiveTool(id)}
                  className={`sv-chip ${activeTool === id ? "is-active" : ""}`}
                  aria-pressed={activeTool === id}
                  type="button"
                >
                  <span className="label">{label}</span>
                </button>
              ))}
              <button
                onClick={() => setActiveTool("drafts")}
                className={`sv-chip ${
                  activeTool === "drafts" ? "is-active" : ""
                }`}
                aria-pressed={activeTool === "drafts"}
                type="button"
              >
                <span className="label">Drafts</span>
              </button>
            </div>

            {/* Template + Duration + Budget */}
            <div
              className="sv-grid-3"
              style={{
                gap: 12,
                marginTop: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              }}
            >
              <SSAField label="Template">
                <SSASelect
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="balanced-week">Balanced Week</option>
                  <option value="budget-batch">Budget + Batch Friendly</option>
                  <option value="feast-day-cycle">Feast Day Cycle</option>
                  <option value="wellness-hair-growth">
                    Wellness: Hair Growth
                  </option>
                  <option value="garden-forward">
                    Garden-Forward + Preservation
                  </option>
                </SSASelect>
              </SSAField>

              <SSAField label="Duration">
                <SSASelect
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option>1-day</option>
                  <option>7-day</option>
                  <option>14-day</option>
                  <option>1-month</option>
                  <option>3-month</option>
                  <option>6-month</option>
                </SSASelect>
              </SSAField>

              <SSAField label="Budget (USD)">
                <SSAInput
                  type="number"
                  min="0"
                  placeholder="e.g., 120"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  style={{ width: "100%" }}
                />
              </SSAField>
            </div>

            {/* Prompt */}
            <div style={{ marginTop: 12 }}>
              <SSAField label="Prompt">
                <SSAInput
                  placeholder="What should the plan optimize for?"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  style={{ width: "100%" }}
                />
              </SSAField>
            </div>

            {/* Cuisines */}
            <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>
                Cuisines / Flavor Focus
              </div>
              <div className="sv-row sv-wrap" style={{ gap: 8 }}>
                {cuisineOptions.map((c) => (
                  <Pill
                    key={c}
                    active={cuisines.includes(c)}
                    onClick={() => toggleCuisine(c)}
                  >
                    {c}
                  </Pill>
                ))}
              </div>
              <div className="sv-muted" style={{ marginTop: 8 }}>
                Weekly Rhythm from Household Profile is applied automatically,
                but you can override it here.
              </div>
            </div>

            {/* Daily Goals: grams vs percent */}
            <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
              <div
                className="sv-row"
                style={{
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ fontWeight: 800 }}>Daily Goals</div>
                <div className="sv-row" style={{ gap: 6 }}>
                  <button
                    className={`sv-chip ${
                      macroMode === "grams" ? "is-active" : ""
                    }`}
                    onClick={() => setMacroMode("grams")}
                    type="button"
                  >
                    <span className="label">By grams</span>
                  </button>
                  <button
                    className={`sv-chip ${
                      macroMode === "percent" ? "is-active" : ""
                    }`}
                    onClick={() => setMacroMode("percent")}
                    type="button"
                  >
                    <span className="label">% of calories</span>
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <label>
                  <div>Calories (kcal)</div>
                  <input
                    className="sv-input"
                    type="number"
                    value={dietary.calories}
                    onChange={(e) =>
                      setDietary({
                        ...dietary,
                        calories: Number(e.target.value || 0),
                      })
                    }
                    style={{ width: "100%" }}
                  />
                </label>
              </div>

              {macroMode === "grams" ? (
                <div
                  className="sv-grid-3"
                  style={{
                    gap: 8,
                    marginTop: 10,
                    gridTemplateColumns: "repeat(3, minmax(120px, 1fr))",
                  }}
                >
                  {["protein", "carbs", "fat"].map((k) => (
                    <label key={k}>
                      <div style={{ textTransform: "capitalize" }}>{k} (g)</div>
                      <input
                        className="sv-input"
                        type="number"
                        value={dietary[k]}
                        onChange={(e) =>
                          setDietary({
                            ...dietary,
                            [k]: Number(e.target.value || 0),
                          })
                        }
                        style={{ width: "100%" }}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <>
                  <div
                    className="sv-grid-3"
                    style={{
                      gap: 8,
                      marginTop: 10,
                      gridTemplateColumns: "repeat(3, minmax(120px, 1fr))",
                    }}
                  >
                    {["protein", "carbs", "fat"].map((k) => (
                      <label key={k}>
                        <div style={{ textTransform: "capitalize" }}>
                          {k} (%)
                        </div>
                        <input
                          className="sv-input"
                          type="number"
                          min="0"
                          max="100"
                          value={macroPct[k]}
                          onChange={(e) =>
                            setMacroPct({
                              ...macroPct,
                              [k]: Number(e.target.value || 0),
                            })
                          }
                          style={{ width: "100%" }}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="sv-muted" style={{ marginTop: 8 }}>
                    Converted:{" "}
                    {(() => {
                      const g = pctToGrams(
                        Number(dietary.calories || 0),
                        macroPct
                      );
                      return `${g.protein}g protein • ${g.carbs}g carbs • ${g.fat}g fat`;
                    })()}
                  </div>
                </>
              )}
            </div>

            {/* Bundles */}
            <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>
                Recipe Bundles (Optional)
              </div>
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                }}
              >
                {bundles.map((b) => {
                  const checked = selectedBundleIds.includes(b.id);
                  return (
                    <label
                      key={b.id}
                      className="sv-card sv-pad"
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBundle(b.id)}
                      />
                      <span>{b.name}</span>
                    </label>
                  );
                })}
              </div>
              <div className="sv-muted" style={{ marginTop: 8 }}>
                Choose a pack to start from curated meals.
              </div>
            </div>

            {/* Inventory */}
            <label className="sv-row" style={{ gap: 8, marginTop: 12 }}>
              <input
                type="checkbox"
                checked={useInventory}
                onChange={(e) => setUseInventory(e.target.checked)}
              />
              Prioritize pantry/inventory items
            </label>

            {/* Forecast Horizon */}
            <div
              className="sv-row sv-wrap"
              style={{ gap: 10, marginTop: 12, alignItems: "center" }}
            >
              <div className="sv-muted">Forecast Horizon:</div>
              <select
                className="sv-btn sv-btn--outline"
                value={horizonMonths}
                onChange={(e) => setHorizonMonths(Number(e.target.value))}
              >
                <option value={1}>1 month</option>
                <option value={3}>3 months</option>
                <option value={6}>6 months</option>
                <option value={12}>1 year</option>
                <option value={24}>2 years</option>
              </select>
            </div>
          </div>

          {/* Quick Start Presets (condensed) */}
          <div className="sv-card sv-pad">
            <SectionTitle
              title="Quick Start Presets"
              subtitle="Pick a vibe and we’ll prefill the form. You can still tweak anything."
            />

            <div className="sv-row sv-wrap" style={{ gap: 8, marginTop: 8 }}>
              {selectedPresets.length > 0 ? (
                <>
                  <span className="sv-muted">Selected:</span>
                  {selectedPresets.map((id) => {
                    const p = PRESETS.find((x) => x.id === id);
                    return p ? (
                      <span key={id} className="sv-badge">
                        {p.title}
                      </span>
                    ) : null;
                  })}
                  <button
                    className="sv-btn sv-btn--outline"
                    onClick={() => setSelectedPresets([])}
                    type="button"
                  >
                    <span className="label">Reset</span>
                  </button>
                </>
              ) : (
                <span className="sv-muted">No preset selected yet.</span>
              )}
            </div>

            {/* Compact preset rows */}
            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              {PRESETS.map((p) => {
                const active = selectedPresets.includes(p.id);
                return (
                  <div
                    key={p.id}
                    className="sv-card sv-pad"
                    style={{
                      border: active
                        ? "2px solid var(--primary)"
                        : "1px solid var(--border)",
                      padding: "10px 12px",
                    }}
                  >
                    <div
                      className="sv-row sv-wrap"
                      style={{ justifyContent: "space-between", gap: 10 }}
                    >
                      <div style={{ minWidth: 220 }}>
                        <div
                          className="sv-row"
                          style={{ gap: 10, alignItems: "baseline" }}
                        >
                          <div style={{ fontWeight: 900 }}>{p.title}</div>
                          <span className="sv-badge">{p.duration}</span>
                        </div>
                        <div
                          className="sv-muted"
                          style={{
                            marginTop: 6,
                            fontSize: 13,
                            lineHeight: 1.35,
                          }}
                        >
                          {p.prompt}
                        </div>
                        <div
                          className="sv-row sv-wrap"
                          style={{ marginTop: 8, gap: 6 }}
                        >
                          {p.tags.map((t) => (
                            <span key={t} className="sv-badge">
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div
                        className="sv-row"
                        style={{
                          gap: 8,
                          alignItems: "center",
                          justifyContent: "flex-end",
                        }}
                      >
                        <button
                          className={`sv-btn ${
                            active ? "sv-btn--primary" : "sv-btn--outline"
                          }`}
                          onClick={() => togglePreset(p)}
                          type="button"
                        >
                          <span className="label">
                            {active ? "Selected" : "Use"}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="sv-stack-sm">
          {/* Active Tool Panel (tabs pages) */}
          <div className="sv-card sv-pad">
            <ToolErrorBoundary>
              <div className="sv-card sv-pad">
                {activeTool === "drafts" ? (
                  <DraftsPane
                    onPublish={onPublishDraft}
                    onQuickViewAsCurrent={
                      useMealPlanStore
                        ? (d) =>
                            useMealPlanStore.getState()?.setPlan?.(d.plan, {
                              createdAt: new Date().toISOString(),
                              source: "draft-preview",
                              draftId: d.id,
                            })
                        : null
                    }
                  />
                ) : (
                  <React.Suspense fallback={<div className="sv-muted">Loading panel…</div>}>
                    <LoadingBoundary placeholder={<div className="sv-muted">Loading panel…</div>}>
                      <SafeProps>{ActiveToolElement}</SafeProps>
                    </LoadingBoundary>
                  </React.Suspense>
                )}
              </div>
            </ToolErrorBoundary>
          </div>

          {/* Auto Estimates & Forecasts */}
          <div className="sv-card sv-pad">
            <SectionTitle
              title="Auto Estimates & Forecasts"
              subtitle="Pulled from cooking, batch, garden, animal, and cleaning agents when available. Uses the forecast horizon."
            />

            <div
              className="sv-grid-3"
              style={{
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              }}
            >
              <div className="sv-card sv-pad">
                <div style={{ fontWeight: 800 }}>Prep Time</div>
                <div className="sv-muted">
                  {estimates.prepTimeHrs != null
                    ? `${estimates.prepTimeHrs} hrs`
                    : "—"}
                </div>
              </div>
              <div className="sv-card sv-pad">
                <div style={{ fontWeight: 800 }}>Shopping Cost</div>
                <div className="sv-muted">
                  {estimates.shoppingCost != null
                    ? `$${Number(estimates.shoppingCost).toFixed(2)}`
                    : "—"}
                </div>
              </div>
              <div className="sv-card sv-pad">
                <div style={{ fontWeight: 800 }}>Garden Utilization</div>
                <div className="sv-muted">
                  {estimates.gardenUsePct != null
                    ? `${Math.round(estimates.gardenUsePct)}%`
                    : "—"}
                </div>
              </div>
            </div>

            <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>
                Suggestions
              </div>
              {estimates.suggestions && estimates.suggestions.length ? (
                <ul className="list-disc" style={{ paddingLeft: 18 }}>
                  {estimates.suggestions.map((s, i) => (
                    <li key={i}>
                      {typeof s === "string" ? s : s?.text || JSON.stringify(s)}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="sv-muted">—</div>
              )}
            </div>
          </div>

          <UnifiedReadinessCard />

          {/* Draft Review (View Plan switches tool and also guarantees a display) */}
          <DraftReview
            data={result}
            onViewPlan={() => {
              // Try to push into the centralized store (Dashboard will pick it up)
              const envelope = coerceToEnvelope(result);
              if (useMealPlanStore?.getState && envelope) {
                const setter = useMealPlanStore.getState().setPlan;
                if (typeof setter === "function") {
                  setter(envelope, {
                    createdAt: new Date().toISOString(),
                    source: "preview-from-draft",
                  });
                  setActiveTool("dashboard");
                  return;
                }
              }
              // Render a full inline plan viewer on this page
              setInlineEnvelope(envelope);
              setActiveTool("dashboard");
              setTimeout(() => {
                try {
                  inlineRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                } catch {}
              }, 0);
            }}
          />

          {/* Inline full-plan viewer */}
          <div ref={inlineRef}>
            {inlineEnvelope ? (
              <InlinePlanViewer envelope={inlineEnvelope} />
            ) : null}
          </div>
        </div>
      </div>

      {/* Dev automations (optional) */}
      {SHOW_DEV_AUTOMATIONS && AutomationPanel && (
        <div className="sv-card sv-pad" style={{ marginTop: 14 }}>
          <AutomationPanel
            title="Quick Automations (Dev)"
            agents={quickAgents}
            onEmit={handleAutomationEmit}
          />
        </div>
      )}
    </div>
  );
}
