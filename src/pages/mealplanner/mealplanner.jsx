// src/pages/mealplanner.jsx
import React, { useMemo, useState, useEffect, Suspense, useRef } from "react";

/* ---------------- Existing panels ---------------- */
import MealPlannerDashboard from "../../components/meals/MealPlannerDashboard.jsx";
import MealCyclePlannerCalendar from "./MealCyclePlannerCalendar.jsx";
import MealPrepNeedsReport from "../../components/meals/MealPrepNeedsReport.jsx";
import FoodProductionForecast from "../../components/meals/FoodProductionForecast.jsx";
import ProcurementReport from "../../components/meals/ProcurementReport.jsx";
import MealToMarketScalePanel from "../../components/meals/MealToMarketScalePanel.jsx";
import SeedAnimalInventoryForm from "../../components/meals/SeedAnimalInventoryForm.jsx";
import ZoneAwareCalendar from "../../components/meals/ZoneAwareCalendar.jsx";

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

/* ---------------- Vision (household profile) ---------------- */
import { useVision } from "@/context/VisionContext";

/* ---------------- Drafts + Current Plan stores ---------------- */
import {
  useMealPlanDraftStore,
  saveDraft as saveDraftAPI,
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
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <div style={{ fontWeight: 700, color: "var(--danger)" }}>
            A panel failed to load.
          </div>
          <div className="subtitle" style={{ marginTop: 6 }}>
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
      <div className="calendar card" style={{ padding: 0 }}>
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
      className={`btn sm ${active ? "primary" : ""}`}
      style={{ borderRadius: 999, lineHeight: 1.2 }}
    >
      <span className="label">{children}</span>
    </button>
  );
}
function SectionTitle({ title, subtitle }) {
  return (
    <div
      className="flex items-start justify-between gap-3"
      style={{ marginBottom: 6 }}
    >
      <div>
        <h2 className="mb-1 text-xl md:text-2xl font-extrabold">{title}</h2>
        {subtitle ? <div className="subtitle">{subtitle}</div> : null}
      </div>
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
    <div className="card" style={{ marginTop: 16 }}>
      <SectionTitle
        title={envelope.title || "Meal Plan"}
        subtitle={envelope.summary || ""}
      />
      <div
        className="grid"
        style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr" }}
      >
        <div className="card">
          <div className="font-bold mb-2">Schedule</div>
          {days.length ? (
            <div className="grid" style={{ display: "grid", gap: 8 }}>
              {days.map((d, i) => (
                <div key={i} className="rounded-2xl border p-3">
                  <div className="font-bold mb-1">Day {d.day ?? i + 1}</div>
                  <ul className="list-disc pl-5">
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

        <div className="card">
          <div className="font-bold mb-2">Shopping List</div>
          {groceries.length ? (
            <ul className="list-disc pl-5">
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

        <div className="card">
          <div className="font-bold mb-2">Prep Schedule</div>
          {prep.length ? (
            <ul className="list-disc pl-5">
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

  return (
    <div className="card" style={{ marginTop: 16 }}>
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
          <ul className="list-disc pl-5">
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
          <ul className="list-disc pl-5">
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

      {prep.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="subtitle" style={{ marginBottom: 6 }}>
            Prep tasks
          </div>
          <ul className="list-disc pl-5">
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
        <div className="card">
          <div className="font-bold">Budget</div>
          <div className="subtitle">
            {budget.estimate
              ? `$${Number(budget.estimate).toFixed(2)} estimated`
              : "No estimate"}
          </div>
          {budget.notes ? <div className="subtitle">{budget.notes}</div> : null}
        </div>
        <div className="card">
          <div className="font-bold">Macros (avg/day)</div>
          <div className="subtitle">
            {macros.calories ? `${macros.calories} kcal` : "—"} •{" "}
            {macros.protein ? `${macros.protein}g protein` : "—"} •{" "}
            {macros.carbs ? `${macros.carbs}g carbs` : "—"} •{" "}
            {macros.fat ? `${macros.fat}g fat` : "—"}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={onViewPlan}>
          <span className="label">View Plan</span>
        </button>
        <button
          className="btn sm"
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
          className="btn sm"
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
    <div
      className="grid grid-cols-1 gap-6 lg:grid-cols-3"
      style={{ marginTop: 16 }}
    >
      <div className="lg:col-span-2">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-lg font-semibold">Your Drafts</div>
          <div className="flex gap-2">
            <input
              placeholder="Search drafts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="btn sm"
              style={{ width: 220 }}
            />
            <input
              placeholder="Filter by tag (e.g., keto)"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="btn sm"
              style={{ width: 180 }}
            />
            <label>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                onChange={onImport}
                className="hidden"
              />
              <button className="btn sm">
                <span className="label">Import JSON</span>
              </button>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {filteredDrafts.length ? (
            filteredDrafts.map((d) => (
              <div
                key={d.id}
                className={`rounded-2xl border p-3 ${
                  d.id === selectedDraftId ? "ring-2 ring-indigo-500" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <InlineRename draft={d} />
                  <div className="text-xs text-slate-500">
                    Updated {new Date(d.updatedAt).toLocaleString()}
                  </div>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {d.meta?.duration ? (
                    <span className="mr-2">Duration: {d.meta.duration}</span>
                  ) : null}
                  {d.meta?.source ? (
                    <span className="mr-2">Source: {d.meta.source}</span>
                  ) : null}
                  {d.tags?.length ? (
                    <span className="mr-2">
                      {d.tags.map((t) => (
                        <span
                          key={t}
                          className="mr-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px]"
                        >
                          #{t}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className="btn sm"
                    onClick={() => selectDraftAPI(d.id)}
                    title="Preview"
                  >
                    <span className="label">Preview</span>
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => onPublish(d.id)}
                    title="Publish to Current"
                  >
                    <span className="label">Publish</span>
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => duplicateDraftAPI(d.id)}
                    title="Duplicate"
                  >
                    <span className="label">Duplicate</span>
                  </button>
                  <button
                    className="btn sm"
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
                  >
                    <span className="label">Export</span>
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => deleteDraftAPI(d.id)}
                    title="Delete"
                  >
                    <span className="label">Delete</span>
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-2xl border p-6 text-slate-500">
              No drafts match your filter.
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border p-4">
        <div className="mb-3 text-lg font-semibold">Draft Preview</div>
        {selectedDraft ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <button
                className="btn sm"
                onClick={() => onPublish(selectedDraft.id)}
              >
                <span className="label">Publish to Current</span>
              </button>
              {onQuickViewAsCurrent ? (
                <button
                  className="btn sm"
                  onClick={() => onQuickViewAsCurrent(selectedDraft)}
                >
                  <span className="label">Quick View as Current</span>
                </button>
              ) : null}
            </div>
            {/* Minimal inline digest */}
            <div className="subtitle">{selectedDraft.title}</div>
            <div className="text-xs text-slate-500">
              {selectedDraft.plan?.summary || ""}
            </div>
            <div className="mt-2">
              <div className="font-bold text-sm mb-1">Meals</div>
              <ul className="list-disc pl-5">
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
          <div className="rounded-2xl border p-6 text-slate-500">
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
    <div className="flex items-center gap-2">
      <input
        className="btn sm"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onCommit()}
        autoFocus
        style={{ width: 220 }}
      />
      <button className="btn sm" onClick={onCommit}>
        <span className="label">Save</span>
      </button>
    </div>
  );
}

/* ---------------- Main page ---------------- */
export default function MealPlanningPage() {
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

      // If saveAsDraft was requested but not handled upstream, save locally
      if (saveAsDraft && !res?.data?.draftId) {
        const planObj = res?.mealPlan;
        if (planObj?.plan?.length) {
          await saveDraftAPI(planObj, {
            title: planObj.summary || "Generated draft",
            meta: { duration, createdBy: "agent:generate" },
            tags: ["generated"],
          });
        }
      }

      const normalized = normalizePlan(res);
      setResult(normalized);
      setOk(true);

      if (saveAsDraft) {
        if (res?.data?.draftId) {
          try {
            selectDraftAPI(res.data.draftId);
          } catch {}
        }
        setActiveTool("drafts");
      }

      automation?.emit?.("meal/planGenerated", {
        res: normalized,
        meta: { templateId, cuisines, presets: selectedPresets },
      });
      window.dispatchEvent(
        new CustomEvent("toast", {
          detail: {
            type: "success",
            message: saveAsDraft ? "Draft generated." : "Meal plan generated.",
          },
        })
      );
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
    <div>
      <h1>🍽️ Meal Planner</h1>
      <p className="subtitle">
        Organize cycles, prep tasks, drafts, and procurement with one click.
      </p>

      {/* Tool Selector */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          margin: "6px 0 12px",
        }}
      >
        {TOOL_REGISTRY.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActiveTool(id)}
            className={`btn sm ${activeTool === id ? "primary" : ""}`}
            aria-pressed={activeTool === id}
          >
            <span className="label">{label}</span>
          </button>
        ))}
        {/* Drafts tab */}
        <button
          onClick={() => setActiveTool("drafts")}
          className={`btn sm ${activeTool === "drafts" ? "primary" : ""}`}
          aria-pressed={activeTool === "drafts"}
        >
          <span className="label">Drafts</span>
        </button>
      </div>

      {/* Active Tool */}
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
        <ToolErrorBoundary>
          <div className="card">
            <Suspense fallback={<div className="subtitle">Loading panel…</div>}>
              <SafeProps>{ActiveToolElement}</SafeProps>
            </Suspense>
          </div>
        </ToolErrorBoundary>
      )}

      {/* Presets */}
      <div className="card" style={{ marginTop: 16 }}>
        <SectionTitle
          title="Quick Start Presets"
          subtitle="Pick a vibe and we’ll prefill the form below. You can still tweak anything."
        />
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginBottom: 10,
          }}
        >
          {selectedPresets.length > 0 ? (
            <>
              <span className="subtitle">Selected:</span>
              {selectedPresets.map((id) => {
                const p = PRESETS.find((x) => x.id === id);
                return p ? (
                  <span key={id} className="badge sm">
                    {p.title}
                  </span>
                ) : null;
              })}
              <button className="btn sm" onClick={() => setSelectedPresets([])}>
                <span className="label">Reset</span>
              </button>
            </>
          ) : (
            <span className="subtitle">No preset selected yet.</span>
          )}
        </div>

        <div
          className="grid"
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          {PRESETS.map((p) => {
            const active = selectedPresets.includes(p.id);
            return (
              <div
                key={p.id}
                className="card"
                style={{
                  border: active
                    ? "2px solid var(--primary)"
                    : "1px solid var(--border)",
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="font-bold">{p.title}</div>
                  <div className="text-xs opacity-70">{p.duration}</div>
                </div>
                <div className="subtitle" style={{ marginTop: 6 }}>
                  {p.prompt}
                </div>
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  {p.tags.map((t) => (
                    <span key={t} className="badge sm">
                      {t}
                    </span>
                  ))}
                </div>
                <div style={{ marginTop: 10 }}>
                  <button
                    className={`btn sm ${active ? "primary" : ""}`}
                    onClick={() => togglePreset(p)}
                  >
                    <span className="label">
                      {active ? "Selected" : "Use this preset"}
                    </span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Smart Meal Plan Form */}
      <div className="card" style={{ marginTop: 16 }}>
        <SectionTitle
          title="Plan Settings"
          subtitle="Minimal inputs → full plan with shopping list, prep, and scheduling."
        />

        {/* Template + Duration + Budget */}
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            marginBottom: 8,
          }}
        >
          <label>
            <div style={{ fontWeight: 600 }}>AI Template</div>
            <select
              className="btn"
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
            <div style={{ fontWeight: 600 }}>Duration</div>
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="btn"
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
            <div style={{ fontWeight: 600 }}>Budget (USD)</div>
            <input
              className="btn"
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
        <label style={{ display: "block", marginBottom: 8 }}>
          <div style={{ fontWeight: 600 }}>Prompt</div>
          <input
            className="btn"
            placeholder="What should the plan optimize for?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{ width: "100%" }}
          />
        </label>

        {/* Cuisines */}
        <div className="card" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Cuisines / Flavor Focus
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
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
          <div className="subtitle" style={{ marginTop: 6 }}>
            Weekly Rhythm from Household Profile is applied automatically, but
            you can override it here.
          </div>
        </div>

        {/* Daily Goals: grams vs percent */}
        <div className="card" style={{ marginTop: 8 }}>
          <div className="flex items-center justify-between">
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Daily Goals</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className={`btn sm ${macroMode === "grams" ? "primary" : ""}`}
                onClick={() => setMacroMode("grams")}
              >
                <span className="label">By grams</span>
              </button>
              <button
                className={`btn sm ${macroMode === "percent" ? "primary" : ""}`}
                onClick={() => setMacroMode("percent")}
              >
                <span className="label">% of calories</span>
              </button>
            </div>
          </div>

          {/* Calories */}
          <div style={{ marginBottom: 8 }}>
            <label>
              <div>Calories (kcal)</div>
              <input
                className="btn"
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
              style={{
                display: "grid",
                gap: 8,
                gridTemplateColumns: "repeat(3, minmax(120px, 1fr))",
              }}
            >
              {["protein", "carbs", "fat"].map((k) => (
                <label key={k}>
                  <div style={{ textTransform: "capitalize" }}>{k} (g)</div>
                  <input
                    className="btn"
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
                style={{
                  display: "grid",
                  gap: 8,
                  gridTemplateColumns: "repeat(3, minmax(120px, 1fr))",
                }}
              >
                {["protein", "carbs", "fat"].map((k) => (
                  <label key={k}>
                    <div style={{ textTransform: "capitalize" }}>{k} (%)</div>
                    <input
                      className="btn"
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
              <div className="subtitle" style={{ marginTop: 6 }}>
                Converted:{" "}
                {(() => {
                  const g = pctToGrams(Number(dietary.calories || 0), macroPct);
                  return `${g.protein}g protein • ${g.carbs}g carbs • ${g.fat}g fat`;
                })()}
              </div>
            </>
          )}
        </div>

        {/* Bundles */}
        <div className="card" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
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
                  className="card"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
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
          <div className="subtitle" style={{ marginTop: 6 }}>
            Choose a pack to start from curated meals.
          </div>
        </div>

        {/* Inventory */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 8,
          }}
        >
          <input
            type="checkbox"
            checked={useInventory}
            onChange={(e) => setUseInventory(e.target.checked)}
          />
          Prioritize pantry/inventory items
        </label>

        {/* Forecast Horizon */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 12,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div className="subtitle">Forecast Horizon:</div>
          <select
            className="btn sm"
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

        {/* Actions */}
        <div
          style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}
        >
          <button
            className="btn primary sm"
            aria-busy={busy}
            onClick={() => onGenerate(false)}
          >
            <span className="label">{busy ? "Working…" : "Generate Plan"}</span>
          </button>
          <button
            className="btn sm"
            aria-busy={busy}
            onClick={() => onGenerate(true)}
            title="Generate and store as a draft (does not overwrite current plan)"
          >
            <span className="label">
              {busy ? "Working…" : "Generate → Draft"}
            </span>
          </button>
          <button className="btn sm" onClick={() => setResult(null)}>
            <span className="label">Clear</span>
          </button>
          <button className="btn sm" onClick={onSaveCurrentAsDraft}>
            <span className="label">Save Current as Draft</span>
          </button>
          {ok ? (
            <span className="subtitle" style={{ color: "var(--success)" }}>
              ✓ Done
            </span>
          ) : null}
        </div>
      </div>

      {/* Auto Estimates & Forecasts */}
      <div className="card" style={{ marginTop: 16 }}>
        <SectionTitle
          title="Auto Estimates & Forecasts"
          subtitle="Pulled from cooking, batch, garden, animal, and cleaning agents when available. Uses the forecast horizon above."
        />
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          <div className="card">
            <div className="font-bold">Prep Time</div>
            <div className="subtitle">
              {estimates.prepTimeHrs != null
                ? `${estimates.prepTimeHrs} hrs`
                : "—"}
            </div>
          </div>
          <div className="card">
            <div className="font-bold">Shopping Cost</div>
            <div className="subtitle">
              {estimates.shoppingCost != null
                ? `$${Number(estimates.shoppingCost).toFixed(2)}`
                : "—"}
            </div>
          </div>
          <div className="card">
            <div className="font-bold">Garden Utilization</div>
            <div className="subtitle">
              {estimates.gardenUsePct != null
                ? `${Math.round(estimates.gardenUsePct)}%`
                : "—"}
            </div>
          </div>
          <div className="card">
            <div className="font-bold">Animal Outputs</div>
            <div className="subtitle">
              {estimates.animalOutputs
                ? JSON.stringify(estimates.animalOutputs)
                : "—"}
            </div>
          </div>
          <div className="card">
            <div className="font-bold">Cleaning Ripple</div>
            <div className="subtitle">
              {estimates.cleaningImpact
                ? estimates.cleaningImpact.note ||
                  JSON.stringify(estimates.cleaningImpact)
                : "—"}
            </div>
          </div>
        </div>

        {/* Suggestions list */}
        <div style={{ marginTop: 12 }}>
          <div className="font-bold">Suggestions</div>
          {estimates.suggestions && estimates.suggestions.length ? (
            <ul className="list-disc pl-5">
              {estimates.suggestions.map((s, i) => (
                <li key={i}>
                  {typeof s === "string" ? s : s?.text || JSON.stringify(s)}
                </li>
              ))}
            </ul>
          ) : (
            <div className="subtitle">—</div>
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
          setActiveTool("dashboard"); // still show dashboard shell, but inline viewer will appear below
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
        {inlineEnvelope ? <InlinePlanViewer envelope={inlineEnvelope} /> : null}
      </div>

      {/* Dev automations (optional) */}
      {SHOW_DEV_AUTOMATIONS && AutomationPanel && (
        <AutomationPanel
          title="Quick Automations (Dev)"
          agents={quickAgents}
          onEmit={handleAutomationEmit}
        />
      )}
    </div>
  );
}
