// src/components/meals/MealCyclePlanner.jsx

import React, { useState, useEffect } from "react";
import { useBatchQueueStore } from "@/store/BatchQueueStore";
import { useMealPlanStore } from "@/store/MealPlanStore";
import RecipeSelectorModal from "@/components/recipes/RecipeSelectorModal";

export default function MealCyclePlanner() {
  const [cycleLength, setCycleLength] = useState(7);
  const [showModalForDay, setShowModalForDay] = useState(null);
  const [cycle, setCycle] = useState({});
  const { setSelectedRecipes } = useBatchQueueStore();
  const { updateMealPlan, mealPlan } = useMealPlanStore();

  // ✅ Initialize plan for the cycle range
  useEffect(() => {
    const initial = {};
    for (let i = 0; i < cycleLength; i++) {
      const key = `Day ${i + 1}`;
      if (!cycle[key]) initial[key] = mealPlan[key] || [];
    }
    setCycle((prev) => ({ ...initial, ...prev }));
  }, [cycleLength, mealPlan]);

  // ✅ Handle recipe selection and global sync
  const handleRecipeSelect = (day, selected) => {
    const updatedCycle = { ...cycle, [day]: selected };
    setCycle(updatedCycle);
    setShowModalForDay(null);

    const allRecipes = Object.values(updatedCycle).flat();
    setSelectedRecipes(allRecipes); // ⬅️ BatchQueue updates

    // ✅ Sync entire cycle to MealPlanStore
    Object.entries(updatedCycle).forEach(([dayKey, recipes]) => {
      updateMealPlan(dayKey, recipes);
    });
  };

  return (
    <div className="p-6 bg-white border border-blue-300 shadow-md rounded-xl max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold text-blue-700 mb-4">🍽️ Meal Cycle Planner</h2>

      <div className="mb-4 flex items-center gap-4">
        <label className="text-sm font-semibold text-stone-700">
          Cycle Length (days):
        </label>
        <input
          type="number"
          value={cycleLength}
          min={1}
          max={730}
          onChange={(e) => setCycleLength(Number(e.target.value))}
          className="border rounded px-3 py-1 w-24"
        />
        <span className="text-xs text-stone-500">Up to 730 days (2 years)</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {Array.from({ length: cycleLength }, (_, i) => {
          const day = `Day ${i + 1}`;
          const recipes = cycle[day] || [];
          return (
            <div
              key={day}
              className="bg-blue-50 border border-blue-200 rounded p-4 shadow"
            >
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-bold text-blue-700">{day}</h3>
                <button
                  onClick={() => setShowModalForDay(day)}
                  className="text-sm text-blue-600 underline hover:text-blue-800"
                >
                  ➕ Add/Change Recipes
                </button>
              </div>
              {recipes.length === 0 ? (
                <p className="text-stone-500 italic">No recipes selected.</p>
              ) : (
                <ul className="text-stone-700 list-disc pl-5 space-y-1 text-sm">
                  {recipes.map((r) => (
                    <li key={r.id}>{r.name}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {showModalForDay && (
        <RecipeSelectorModal
          day={showModalForDay}
          selectedRecipes={cycle[showModalForDay] || []}
          onClose={() => setShowModalForDay(null)}
          onSelect={(recipes) => handleRecipeSelect(showModalForDay, recipes)}
        />
      )}
    </div>
  );
}
