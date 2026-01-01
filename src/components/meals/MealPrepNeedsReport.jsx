// src/components/meals/MealPrepNeedsReport.jsx

import React from "react";
import { useMealPlanStore } from "@/store/MealPlanStore";
import { Printer, ChefHat, ClipboardList } from "lucide-react";

// Placeholder function to simulate ingredient prep extraction
const extractPrepNeeds = (mealPlan) => {
  const needs = {};
  for (const day in mealPlan) {
    const recipes = mealPlan[day] || [];
    needs[day] = recipes.flatMap((recipe) =>
      recipe.prepNeeds || [`[Prep not listed] ${recipe.name}`]
    );
  }
  return needs;
};

export default function MealPrepNeedsReport() {
  const { mealPlan } = useMealPlanStore();
  const sortedDays = Object.keys(mealPlan).sort((a, b) => {
    const aDay = parseInt(a.replace("Day ", ""));
    const bDay = parseInt(b.replace("Day ", ""));
    return aDay - bDay;
  });

  const prepNeeds = extractPrepNeeds(mealPlan);

  const handlePrint = () => {
    const printable = sortedDays
      .map(
        (day) =>
          `${day}:\n` +
          (prepNeeds[day] || []).map((step) => `- ${step}`).join("\n")
      )
      .join("\n\n");

    const win = window.open("", "_blank");
    win.document.write(`<pre>${printable}</pre>`);
    win.document.close();
    win.print();
  };

  return (
    <div className="p-6 bg-white rounded-xl border border-orange-400 shadow-md max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-orange-800">
          🍳 Meal Prep Needs Report
        </h2>
        <button
          onClick={handlePrint}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-orange-600 text-white rounded hover:bg-orange-700"
        >
          <Printer size={16} />
          Print Prep Report
        </button>
      </div>

      {sortedDays.length === 0 ? (
        <p className="text-stone-500 italic">
          No meal cycle loaded. Generate one first in the Meal Cycle Planner.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[70vh] overflow-y-scroll pr-2">
          {sortedDays.map((day) => (
            <div
              key={day}
              className="bg-orange-50 border border-orange-200 rounded-lg p-4 shadow-sm"
            >
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-lg font-semibold text-orange-800">{day}</h3>
                <ClipboardList size={18} className="text-orange-600" />
              </div>
              {prepNeeds[day]?.length > 0 ? (
                <ul className="list-disc pl-5 text-stone-700 text-sm space-y-1">
                  {prepNeeds[day].map((step, idx) => (
                    <li key={idx}>{step}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-stone-500 italic text-sm">No prep needs listed.</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 border-t pt-4 text-right text-sm text-stone-500 flex items-center justify-end gap-2">
        <ChefHat size={16} />
        <span>Prep synced with Meal Plan & Cooking Timeline</span>
      </div>
    </div>
  );
}
