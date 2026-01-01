// src/components/meals/MealPlannerDashboard.jsx

import React from "react";
import { useMealPlanStore } from "@/store/MealPlanStore";
import { Printer, Edit3, FileText } from "lucide-react";

export default function MealPlannerDashboard() {
  const { mealPlan } = useMealPlanStore();

  const sortedDays = Object.keys(mealPlan).sort((a, b) => {
    const aDay = parseInt(a.replace("Day ", ""));
    const bDay = parseInt(b.replace("Day ", ""));
    return aDay - bDay;
  });

  const handlePrint = () => {
    const printable = sortedDays
      .map(
        (day) =>
          `${day}:\n` +
          mealPlan[day].map((r) => `- ${r.name}`).join("\n")
      )
      .join("\n\n");

    const win = window.open("", "_blank");
    win.document.write(`<pre>${printable}</pre>`);
    win.document.close();
    win.print();
  };

  return (
    <div className="p-6 bg-white rounded-xl border border-lime-400 shadow-md max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-lime-800">
          🥗 Meal Planner Dashboard
        </h2>
        <button
          onClick={handlePrint}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-lime-600 text-white rounded hover:bg-lime-700"
        >
          <Printer size={16} />
          Print Full Plan
        </button>
      </div>

      {sortedDays.length === 0 ? (
        <p className="text-stone-500 italic">
          No meal cycle loaded yet. Start by creating one in the Meal Cycle
          Planner.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[70vh] overflow-y-scroll pr-2">
          {sortedDays.map((day) => (
            <div
              key={day}
              className="bg-lime-50 border border-lime-200 rounded-lg p-4 shadow-sm"
            >
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-lg font-semibold text-lime-800">{day}</h3>
                <button className="text-sm text-lime-600 hover:underline flex items-center gap-1">
                  <Edit3 size={14} />
                  Edit
                </button>
              </div>
              {mealPlan[day]?.length > 0 ? (
                <ul className="list-disc pl-5 text-stone-700 text-sm space-y-1">
                  {mealPlan[day].map((r) => (
                    <li key={r.id}>{r.name}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-stone-500 italic text-sm">
                  No meals assigned yet.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 border-t pt-4 text-right text-sm text-stone-500 flex items-center justify-end gap-2">
        <FileText size={16} />
        <span>Cycle synced with Batch Cooking, Prep Tasks & Procurement</span>
      </div>
    </div>
  );
}
