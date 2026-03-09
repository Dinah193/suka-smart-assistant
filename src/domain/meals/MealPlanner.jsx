// C:\Users\larho\suka-smart-assistant\src\domain\meals\MealPlanner.jsx
// Household meal planning interface
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// This component sits in the SSA "meal" domain UI layer. It is where the user
// (or an automation) can:
//   1. See suggested meals (from imports → intelligence → meal suggestions).
//   2. Build a plan (day-by-day or session-based).
//   3. Save plans as "favorite sessions/schedules" (your recurring requirement).
//   4. Emit events to the shared eventBus so the automation runtime can
//      generate cooking sessions, inventory reservations, and storehouse deltas.
//   5. Optionally export the meal plan out to the Hub if familyFundMode=true.
//
// DATA FLOW
// imports (recipe/cleaning/garden/animal/storehouse/video) → ImportService →
// normalized recipe/intelligence records → meal suggestion engine → MealPlanner UI
// → user commits plan → emit { type: 'meal.plan.saved', ... } →
// automation/runtime reacts → cooking sessions, inventory updates →
// if enabled: exportToHubIfEnabled(payload)
//
// NOTES
// - This is forward-thinking: it already anticipates future domains like
//   preservation, animal, storehouse-driven menus, and garden-to-table.
// - It is defensive: checks for eventBus, featureFlags, and empty data.
// - It emits a consistent payload shape: { type, ts, source, data } with ISO time.
// - Uses optimistic local state so SSA can run fully offline.
// - Assumes Dexie/local DB or a dataGateway exists elsewhere for persistence.
// - You can later split this file into container + presentational components if needed.

import React, { useEffect, useMemo, useState } from "react";

// ASSUMED SERVICES (these should exist elsewhere in your SSA project)
import eventBus from "../../services/events/eventBus"; // shared app-wide bus
import featureFlags from "@/config/featureFlags.json"; // toggles incl. familyFundMode
// Assume these exist and have reasonable interfaces:
import { formatMealPlanForHub } from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";
// These are optional helpers — defensive import pattern:
import { getRecentImports } from "../../services/imports/ImportIntelligenceService";
import { suggestMealsFromIntelligence } from "../../services/meals/MealSuggestionService";
import {
  saveMealPlan,
  loadLatestMealPlan,
} from "../../services/meals/MealPlanStore";

const SOURCE_ID = "domain.meals.MealPlanner";

function MealPlanner() {
  // ---------------------------------------------------------------------------
  // LOCAL STATE
  // plannedMeals: array of { id, title, day, mealType, sourceId, ingredients, inventoryLinks }
  // favorites: array of saved plans (id, label, items[])
  // suggestions: array of meals suggested from imports/intelligence
  // viewMode: 'week' | 'list' | 'sessions'
  // ---------------------------------------------------------------------------
  const [plannedMeals, setPlannedMeals] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState("week");
  const [error, setError] = useState("");

  // On mount: load latest meal plan + fetch suggestions from intelligence
  useEffect(() => {
    let isActive = true;

    async function init() {
      setLoading(true);
      try {
        const [latestPlan, recentImports] = await Promise.all([
          safeLoadLatestMealPlan(),
          safeGetRecentImports(),
        ]);

        if (!isActive) return;

        if (latestPlan && Array.isArray(latestPlan.items)) {
          setPlannedMeals(latestPlan.items);
        }

        const suggested = safeSuggestMealsFromIntelligence(recentImports, {
          // future-ready: pull in seasonality, garden harvest, animal cuts, storehouse
          includeGarden: true,
          includeStorehouse: true,
          includePreservation: true,
          includeAnimal: true,
        });
        setSuggestions(suggested || []);
      } catch (e) {
        console.warn("[MealPlanner] init failed", e);
        if (isActive) {
          setError("Unable to load meal planner data right now.");
        }
      } finally {
        if (isActive) setLoading(false);
      }
    }

    init();

    // Subscribe to external events — e.g., import.parsed, inventory.updated
    const offImport = eventBus?.on?.("import.parsed", handleImportParsed);
    const offInv = eventBus?.on?.("inventory.updated", handleInventoryUpdated);

    return () => {
      isActive = false;
      offImport && offImport();
      offInv && offInv();
    };
  }, []);

  // Memo: group by day for 'week' view
  const mealsByDay = useMemo(() => {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const grouped = {};
    days.forEach((d) => (grouped[d] = []));
    plannedMeals.forEach((meal) => {
      const day = meal.day || "Unassigned";
      if (!grouped[day]) grouped[day] = [];
      grouped[day].push(meal);
    });
    return grouped;
  }, [plannedMeals]);

  // ---------------------------------------------------------------------------
  // EVENT HANDLERS
  // ---------------------------------------------------------------------------

  function handleImportParsed(evtPayload) {
    // import.parsed → we can attempt to get new suggestions
    // evtPayload shape: { type, ts, source, data: { domain, normalized } }
    try {
      const refreshed = safeSuggestMealsFromIntelligence(
        [evtPayload?.data?.normalized].filter(Boolean),
        {
          includeGarden: true,
          includeStorehouse: true,
          includePreservation: true,
          includeAnimal: true,
        }
      );
      if (refreshed && refreshed.length) {
        // prepend fresh suggestions
        setSuggestions((prev) => [...refreshed, ...prev]);
      }
    } catch (e) {
      console.warn(
        "[MealPlanner] failed to refresh suggestions from import",
        e
      );
    }
  }

  function handleInventoryUpdated(evtPayload) {
    // inventory.updated → we can mark some meals as "ready" if inventory items match
    // This is optional: depends on InventoryRules
    try {
      const updatedMeals = plannedMeals.map((m) => {
        if (m.inventoryLinks && Array.isArray(m.inventoryLinks)) {
          // simplistic example: mark ready=true if any inventory items updated
          return {
            ...m,
            ready: true,
          };
        }
        return m;
      });
      setPlannedMeals(updatedMeals);
    } catch (e) {
      console.warn("[MealPlanner] inventory.updated handler failed", e);
    }
  }

  function handleAddMealFromSuggestion(suggestion, targetDay = "Unassigned") {
    if (!suggestion) return;
    const newMeal = {
      id: suggestion.id || makeId("meal"),
      title: suggestion.title || "Imported Meal",
      day: targetDay,
      mealType: suggestion.mealType || "dinner",
      sourceId: suggestion.sourceId || suggestion.url || null,
      ingredients: suggestion.ingredients || [],
      inventoryLinks: suggestion.inventoryLinks || [],
      tags: suggestion.tags || [],
    };
    const next = [...plannedMeals, newMeal];
    setPlannedMeals(next);
    emitEvent("meal.plan.updated", {
      items: next,
      reason: "add-from-suggestion",
    });
  }

  function handleDayChange(mealId, newDay) {
    const next = plannedMeals.map((m) =>
      m.id === mealId
        ? {
            ...m,
            day: newDay,
          }
        : m
    );
    setPlannedMeals(next);
    emitEvent("meal.plan.updated", {
      items: next,
      reason: "day-change",
    });
  }

  async function handleSavePlan(label = "") {
    const planToSave = {
      id: makeId("plan"),
      label: label || `Plan ${new Date().toLocaleString()}`,
      items: plannedMeals,
      ts: new Date().toISOString(),
    };

    // save to local store (Dexie / IndexedDB)
    try {
      await saveMealPlan(planToSave);
    } catch (e) {
      console.warn("[MealPlanner] failed to persist meal plan", e);
    }

    // update favorites in UI
    setFavorites((prev) => [planToSave, ...prev]);

    // emit event so automation.runtime can generate sessions
    const evtPayload = emitEvent("meal.plan.saved", {
      plan: planToSave,
    });

    // optionally export to hub
    await exportToHubIfEnabled(evtPayload);
  }

  function handleApplyFavoritePlan(favPlan) {
    if (!favPlan || !Array.isArray(favPlan.items)) return;
    setPlannedMeals(favPlan.items);
    emitEvent("meal.plan.updated", {
      items: favPlan.items,
      reason: "apply-favorite",
    });
  }

  // ---------------------------------------------------------------------------
  // RENDER HELPERS
  // ---------------------------------------------------------------------------

  function renderToolbar() {
    return (
      <div className="ssa-meal-toolbar flex gap-3 mb-4 items-center">
        <h2 className="text-xl font-semibold">Meal Planner</h2>
        <div className="flex gap-2">
          <button
            className={viewMode === "week" ? "btn-primary" : "btn-secondary"}
            onClick={() => setViewMode("week")}
          >
            Week
          </button>
          <button
            className={viewMode === "list" ? "btn-primary" : "btn-secondary"}
            onClick={() => setViewMode("list")}
          >
            List
          </button>
          <button
            className={
              viewMode === "sessions" ? "btn-primary" : "btn-secondary"
            }
            onClick={() => setViewMode("sessions")}
          >
            Sessions
          </button>
        </div>
        <div className="flex gap-2 ml-auto">
          <button className="btn-secondary" onClick={() => handleSavePlan("")}>
            Save as favorite
          </button>
          <button
            className="btn-secondary"
            onClick={() =>
              emitEvent("automation.schedule.request", {
                domain: "meals",
                items: plannedMeals,
                policy: "next-best-action",
              })
            }
          >
            Send to automation
          </button>
        </div>
      </div>
    );
  }

  function renderSuggestions() {
    if (!suggestions.length) return null;
    return (
      <div className="ssa-meal-suggestions mb-4">
        <h3 className="font-semibold mb-2">Suggestions (from imports)</h3>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <div key={s.id || s.title} className="card p-2 rounded border">
              <div className="font-medium">{s.title}</div>
              {s.tags && s.tags.length ? (
                <div className="text-xs text-gray-500 mb-1">
                  {s.tags.join(" • ")}
                </div>
              ) : null}
              <button
                className="btn-xs btn-primary"
                onClick={() => handleAddMealFromSuggestion(s, "Unassigned")}
              >
                Add to plan
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderFavorites() {
    if (!favorites.length) return null;
    return (
      <div className="ssa-meal-favorites mb-4">
        <h3 className="font-semibold mb-2">Favorite Plans</h3>
        <div className="flex gap-2 flex-wrap">
          {favorites.map((f) => (
            <button
              key={f.id}
              className="btn-secondary btn-sm"
              onClick={() => handleApplyFavoritePlan(f)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderWeekView() {
    const days = [
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
      "Unassigned",
    ];
    return (
      <div className="grid grid-cols-4 md:grid-cols-8 gap-3">
        {days.map((day) => (
          <div key={day} className="border rounded p-2 bg-white/50">
            <div className="font-semibold mb-2">{day}</div>
            <div className="flex flex-col gap-1">
              {(mealsByDay[day] || []).map((meal) => (
                <div
                  key={meal.id}
                  className="border rounded p-1 flex items-center justify-between bg-white"
                >
                  <div>
                    <div className="text-sm font-medium">{meal.title}</div>
                    <div className="text-xs text-gray-500">
                      {meal.mealType || "dinner"}
                      {meal.ready ? " • ready" : ""}
                    </div>
                  </div>
                  <select
                    className="text-xs border rounded ml-2"
                    value={meal.day || "Unassigned"}
                    onChange={(e) => handleDayChange(meal.id, e.target.value)}
                  >
                    {days.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderListView() {
    if (!plannedMeals.length) {
      return <p className="text-gray-500 text-sm">No meals planned yet.</p>;
    }
    return (
      <div className="flex flex-col gap-2">
        {plannedMeals.map((meal) => (
          <div
            key={meal.id}
            className="border rounded p-2 flex items-center justify-between"
          >
            <div>
              <div className="font-medium">{meal.title}</div>
              <div className="text-xs text-gray-500">
                {meal.day || "Unassigned"} • {meal.mealType || "dinner"}
              </div>
            </div>
            <select
              className="text-xs border rounded"
              value={meal.day || "Unassigned"}
              onChange={(e) => handleDayChange(meal.id, e.target.value)}
            >
              {[
                "Mon",
                "Tue",
                "Wed",
                "Thu",
                "Fri",
                "Sat",
                "Sun",
                "Unassigned",
              ].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    );
  }

  function renderSessionsView() {
    // This view is a bridge to your CookingSessionEngine
    // For now, we just show what would be sent
    return (
      <div className="border rounded p-3 bg-white/50">
        <h3 className="font-semibold mb-2">Session view</h3>
        <p className="text-xs text-gray-600 mb-2">
          This view shows how your meal plan would be converted to cooking
          sessions. The actual conversion is handled by your
          CookingSessionEngine / MealSessionGenerator.
        </p>
        <pre className="bg-gray-100 rounded p-2 text-xs overflow-x-auto">
          {JSON.stringify(
            {
              domain: "meals",
              items: plannedMeals,
              policy: "batch-by-day",
            },
            null,
            2
          )}
        </pre>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // MAIN RENDER
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="p-4">
        <p className="text-sm text-gray-500">Loading meal planner…</p>
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {renderToolbar()}
      {error ? <p className="text-red-500 text-sm">{error}</p> : null}
      {renderSuggestions()}
      {renderFavorites()}
      {viewMode === "week" ? renderWeekView() : null}
      {viewMode === "list" ? renderListView() : null}
      {viewMode === "sessions" ? renderSessionsView() : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function emitEvent(type, data) {
  const payload = {
    type,
    ts: new Date().toISOString(),
    source: SOURCE_ID,
    data,
  };
  if (eventBus && typeof eventBus.emit === "function") {
    eventBus.emit(type, payload);
  } else {
    console.warn("[MealPlanner] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;

    const hubPacket = formatMealPlanForHub(evtPayload);
    if (!hubPacket) return;

    await FamilyFundConnector.send(hubPacket);
  } catch (e) {
    // fail silently – Hub is optional
    console.warn("[MealPlanner] Hub export failed (silently)", e);
  }
}

async function safeLoadLatestMealPlan() {
  try {
    const plan = await loadLatestMealPlan();
    return plan;
  } catch (e) {
    console.warn("[MealPlanner] safeLoadLatestMealPlan failed", e);
    return null;
  }
}

async function safeGetRecentImports() {
  try {
    const imports = await getRecentImports({
      domains: [
        "recipe",
        "cleaning",
        "garden",
        "animal",
        "storehouse",
        "video",
      ],
      limit: 30,
    });
    return imports;
  } catch (e) {
    console.warn("[MealPlanner] safeGetRecentImports failed", e);
    return [];
  }
}

function safeSuggestMealsFromIntelligence(intel, opts) {
  try {
    const res = suggestMealsFromIntelligence(intel, opts);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    console.warn("[MealPlanner] safeSuggestMealsFromIntelligence failed", e);
    return [];
  }
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default MealPlanner;
