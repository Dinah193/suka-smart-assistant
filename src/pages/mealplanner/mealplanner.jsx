// src/pages/mealplanner.jsx
import React, { useMemo, useState, useEffect, Suspense, useRef } from "react";

// SV (Sacred Village) shared styling used by Cooking/Cleaning/Garden pages
import "@/styles/household.css";
import "@/pages/cooking/cooking.css";

/* ---------------- Existing panels ---------------- */
import MealPlannerDashboard from "../../components/meals/MealPlannerDashboard.jsx";
import MealCyclePlannerCalendar from "./MealCyclePlannerCalendar.jsx";
import MealPrepNeedsReport from "../../components/meals/MealPrepNeedsReport.jsx";
import FoodProductionForecast from "../../components/meals/FoodProductionForecast.jsx";
import ProcurementReport from "../../components/meals/ProcurementReport.jsx";
import ShoppingListGenerator from "../../components/meals/ShoppingListGenerator.jsx";
import MealToMarketScalePanel from "../../components/meals/MealToMarketScalePanel.jsx";
import SeedAnimalInventoryForm from "../../components/meals/SeedAnimalInventoryForm.jsx";
import ZoneAwareCalendar from "../../components/meals/ZoneAwareCalendar.jsx";
import RealtimeCoordinationPanel from "@/components/home/RealtimeCoordinationPanel";
import useRealtimeCoordination from "@/hooks/useRealtimeCoordination";

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

  // 2) Fallback alias path
  if (!_mealPlanningAgent) {
    try {
      const mod = await import("@/agents/shims/mealPlanningShim.js");
      _mealPlanningAgent = mod?.default || mod || null;
    } catch (e) {
      // ignore
    }
  }

  // 3) Fallback: HouseholdOrchestrator shim – wrap it
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

  // 4) Alias fallback for orchestrator
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

/* ---- Optional agents (guarded imports so the page never crashes) ---- */
// These point to *shims*, not raw agents.
let cookingAgent = null;
let batchCookingAgent = null;
let animalAgent = null;
let gardenAgent = null;
let cleaningAgent = null;
let mealBundleAgent = null;
let soilWaterAgent = null;
let wasteToCompostAgent = null;

try {
  cookingAgent =
    require("../../agents/shims/cookingShim.js").default ||
    require("../../agents/shims/cookingShim.js");
} catch {}
try {
  batchCookingAgent =
    require("../../agents/shims/batchCookingShim.js").default ||
    require("../../agents/shims/batchCookingShim.js");
} catch {}
try {
  animalAgent =
    require("../../agents/shims/animalShim.js").default ||
    require("../../agents/shims/animalShim.js");
} catch {}
try {
  gardenAgent =
    require("../../agents/shims/gardeningShim.js").default ||
    require("../../agents/shims/gardeningShim.js");
} catch {}
try {
  cleaningAgent =
    require("../../agents/shims/cleaningShim.js").default ||
    require("../../agents/shims/cleaningShim.js");
} catch {}
try {
  mealBundleAgent =
    require("../../agents/shims/mealBundleShim.js").default ||
    require("../../agents/shims/mealBundleShim.js");
} catch {}
try {
  soilWaterAgent =
    require("../../agents/shims/soilAndWaterShim.js").default ||
    require("../../agents/shims/soilAndWaterShim.js");
} catch {}
try {
  wasteToCompostAgent =
    require("../../agents/shims/wasteToCompostShim.js").default ||
    require("../../agents/shims/wasteToCompostShim.js");
} catch {}

/* ---------------- Dev automations ---------------- */
import AutomationPanel from "../../ui/AutomationPanel.jsx";
import { automation } from "@/services/automation/runtime";
import { emitCanonicalSignal } from "@/services/realtime/canonicalSignalEmitter";
import { eventBus } from "@/services/events/eventBus";
import {
  emitHomesteadMealPlanGenerated,
  buildEstimateInputsFromNormalizedPlan,
} from "@/services/planners/mealPlannerBridge";
import { useStorehousePlannerStore } from "@/store/StorehousePlannerStore";

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

/* ---------------- Bundles (fallback if agent missing) --------------- */
async function fetchRecipeBundles() {
  if (mealBundleAgent?.handleCommand) {
    try {
      const out = await mealBundleAgent.handleCommand("listBundles", {});
      if (Array.isArray(out?.bundles)) return out.bundles;
    } catch (e) {
      console.warn("[MealPlanner] mealBundleAgent.listBundles failed", e);
    }
  }
  return [
    { id: "family-favorites", name: "Family Favorites (10 dinners)" },
    { id: "soul-food-classics", name: "Soul Food Classics" },
    { id: "caribbean-week", name: "Caribbean Week Pack" },
    { id: "budget-batch", name: "Budget Batchers" },
  ];
}

/* ---------------- Helpers ---------------- */
async function tryAgent(agent, cmd, payload) {
  if (!agent?.handleCommand) return null;
  try {
    return (await agent.handleCommand(cmd, payload)) ?? null;
  } catch (e) {
    console.warn(`[MealPlanner] ${cmd} failed`, e);
    return null;
  }
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

  // Generic fallbacks
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

/* ---------------- Full inline Plan Viewer (fallback when setPlan is absent) -------- */
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
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("ui:navigate", {
                detail: { route: "ZoneAwareCalendar", params: {} },
              })
            )
          }
        >
          <span className="label">Send to Calendar</span>
        </button>
        <button
          className="sv-btn sv-btn--outline"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("ui:navigate", {
                detail: { route: "ProcurementReport", params: {} },
              })
            )
          }
        >
          <span className="label">Open Procurement</span>
        </button>
      </div>
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
      <div>
        <div className="sv-row sv-wrap" style={{ marginBottom: 10 }}>
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
  const [activeTool, setActiveTool] = useState("dashboard");

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

  /* When setPlan isn't available, show an inline viewer as a fallback */
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
    const [cook, shop, gardenUse, animals, clean, tips] = await Promise.all([
      tryAgent(cookingAgent, "estimatePrepTime", {
        planContext: payloadForPlan,
        horizonMonths,
      }),
      tryAgent(batchCookingAgent, "estimateShoppingCost", {
        planContext: payloadForPlan,
        horizonMonths,
      }),
      tryAgent(gardenAgent, "estimateGardenUtilization", {
        planContext: payloadForPlan,
        horizonMonths,
      }),
      tryAgent(animalAgent, "estimateOutputs", {
        planContext: payloadForPlan,
        horizonMonths,
      }),
      tryAgent(cleaningAgent, "predictCleaningRipple", {
        planContext: payloadForPlan,
        horizonMonths,
      }),
      tryAgent(cookingAgent, "planSuggestions", {
        planContext: payloadForPlan,
        horizonMonths,
      }),
    ]);

    // Fallback suggestions if agents missing
    const fallback = [];
    if (!tips?.suggestions) {
      if (horizonMonths >= 1)
        fallback.push("Batch cook stews monthly; freeze in 2–3 meal portions.");
      if (horizonMonths >= 3)
        fallback.push(
          "Plant quick-maturing greens to cover salads next quarter."
        );
      if (horizonMonths >= 6)
        fallback.push("Schedule canning/dehydrating week when garden peaks.");
      if (horizonMonths >= 12)
        fallback.push(
          "Rotate preserved staples (beans, grains) every 12 months."
        );
      if (horizonMonths >= 24)
        fallback.push(
          "Review animal breeding/harvest calendar for 2-year continuity."
        );
    }

    setEstimates({
      prepTimeHrs: cook?.hours ?? null,
      shoppingCost: shop?.cost ?? null,
      gardenUsePct: gardenUse?.percent ?? null,
      animalOutputs: animals ?? null,
      cleaningImpact: clean ?? null,
      suggestions: tips?.suggestions ?? fallback,
    });
  }

  /* Generate → Save as Draft (agent-first, with local fallback) */
  async function onGenerate(saveAsDraft = false) {
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
      const agent = await getMealPlanningAgent();

      let res = null;
      if (agent?.handleCommand) {
        // Use the agent router so we benefit from store + drafts integration
        res = await agent.handleCommand("generate", payload);
      } else if (typeof agent?.generateMealPlan === "function") {
        // Hard fallback: call direct export
        const plan = await agent.generateMealPlan(payload);
        res = { mealPlan: plan };
      } else {
        throw new Error(
          "mealPlanningAgent not available. Ensure mealPlanningShim or HouseholdOrchestrator is bundled."
        );
      }

      const normalized = normalizePlan(res);
      setResult(normalized);
      setOk(true);

      // Auto-forward normalized generated plan into downstream estimate inputs.
      // This keeps animal/garden/preservation estimation grounded in final outputs.
      const estimateInputs = buildEstimateInputsFromNormalizedPlan({
        normalizedPlan: normalized,
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
      });

      buildCompanions({
        ...payload,
        normalizedPlan: normalized,
        estimateInputs,
      });

      // Ensure a real local draft record exists whenever draft mode is used.
      // Some upstream flows may return draftId without persisting to MealPlanDraftStore.
      let ensuredDraftId = res?.data?.draftId || null;
      let usedLocalDraftFallback = false;
      if (saveAsDraft) {
        const existing = ensuredDraftId ? getDraftAPI(ensuredDraftId) : null;
        if (!existing) {
          const candidatePlan =
            res?.mealPlan ||
            res?.data?.mealPlan ||
            res?.data?.plan ||
            coerceToEnvelope(normalized);

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
            usedLocalDraftFallback = true;
          }
        }
      }

      /* ✅ PATCH: always force the generated plan into the Current Plan store and switch to Dashboard */
      if (!saveAsDraft) {
        try {
          const envelope = coerceToEnvelope(normalized);
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
            // fallback: inline full viewer if store is missing
            setInlineEnvelope(envelope);
          }
        } catch (e) {
          console.warn("[MealPlanner] setPlan fallback failed", e);
          try {
            const envelope = coerceToEnvelope(normalized);
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
        res: normalized,
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
          mealCount: Array.isArray(normalized?.meals) ? normalized.meals.length : 0,
          shoppingCount: Array.isArray(normalized?.shoppingList)
            ? normalized.shoppingList.length
            : 0,
        },
      });

      emitHomesteadMealPlanGenerated({
        normalizedPlan: normalized,
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

      if (saveAsDraft && usedLocalDraftFallback) {
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
  }

  const quickAgents = [
    {
      id: "soil/planIrrigation",
      label: "Irrigation Planner",
      note: "Creates rain-aware irrigation schedule.",
      run: async () =>
        tryAgent(soilWaterAgent, "planIrrigation", {
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
        tryAgent(wasteToCompostAgent, "estimateOutputs", {
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

  /* ---------------------------- Render ---------------------------- */
  return (
    <div className="sv-container">
      <div className="sv-hero sv-pad">
        <div
          className="sv-row sv-wrap"
          style={{ justifyContent: "space-between", alignItems: "flex-end" }}
        >
          <div>
            <div className="sv-pageTitle">Meal Planner</div>
            <div className="sv-muted">
              Organize cycles, prep tasks, drafts, and procurement with one
              click.
            </div>
          </div>

          <div className="sv-actions" style={{ flexWrap: "wrap" }}>
            <button
              className="sv-btn sv-btn--primary"
              aria-busy={busy}
              onClick={() => onGenerate(false)}
              title="Generate and publish to Current Plan"
              type="button"
            >
              <span className="label">
                {busy ? "Working…" : "Generate Plan"}
              </span>
            </button>
            <button
              className="sv-btn sv-btn--outline"
              aria-busy={busy}
              onClick={() => onGenerate(true)}
              title="Generate and store as a Draft (does not overwrite current plan)"
              type="button"
            >
              <span className="label">
                {busy ? "Working…" : "Generate → Draft"}
              </span>
            </button>
            <button
              className="sv-btn sv-btn--outline"
              onClick={onSaveCurrentAsDraft}
              type="button"
            >
              <span className="label">Save Current as Draft</span>
            </button>
            <button
              className="sv-btn sv-btn--outline"
              onClick={() => setResult(null)}
              type="button"
            >
              <span className="label">Clear</span>
            </button>
            {ok ? (
              <span className="sv-muted" style={{ color: "var(--success)" }}>
                ✓ Done
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <MyAssignmentsStrip
        onOpenCoordination={() => {
          coordinationRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />

      <div style={{ marginTop: 12 }} ref={coordinationRef}>
        <RealtimeCoordinationPanel />
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
              <label>
                <div style={{ fontWeight: 700 }}>Template</div>
                <select
                  className="sv-input"
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
                </select>
              </label>

              <label>
                <div style={{ fontWeight: 700 }}>Duration</div>
                <select
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  className="sv-input"
                  style={{ width: "100%" }}
                >
                  <option>1-day</option>
                  <option>7-day</option>
                  <option>14-day</option>
                  <option>1-month</option>
                  <option>3-month</option>
                  <option>6-month</option>
                </select>
              </label>

              <label>
                <div style={{ fontWeight: 700 }}>Budget (USD)</div>
                <input
                  className="sv-input"
                  type="number"
                  min="0"
                  placeholder="e.g., 120"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  style={{ width: "100%" }}
                />
              </label>
            </div>

            {/* Prompt */}
            <label style={{ display: "block", marginTop: 12 }}>
              <div style={{ fontWeight: 700 }}>Prompt</div>
              <input
                className="sv-input"
                placeholder="What should the plan optimize for?"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                style={{ width: "100%" }}
              />
            </label>

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
                  <Suspense
                    fallback={<div className="sv-muted">Loading panel…</div>}
                  >
                    <SafeProps>{ActiveToolElement}</SafeProps>
                  </Suspense>
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
              // Fallback: render a full inline plan viewer on this page
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

          {/* Inline fallback full-plan viewer */}
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
