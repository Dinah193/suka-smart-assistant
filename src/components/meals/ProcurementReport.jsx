// src/components/meals/ProcurementReport.jsx
import React, { useMemo } from "react";
import { useMealPlanStore } from "@/store/MealPlanStore";
import { Download } from "lucide-react";

// 🔁 Utility to count ingredients across the full meal plan
const aggregateIngredients = (mealPlan) => {
  const counts = {};

  Object.values(mealPlan).forEach((meals) => {
    meals.forEach((meal) => {
      (meal.ingredients || []).forEach((ingredient) => {
        const key = ingredient.name.toLowerCase();
        counts[key] = (counts[key] || 0) + (ingredient.quantity || 1);
      });
    });
  });

  return Object.entries(counts).map(([name, totalQuantity]) => ({
    name,
    totalQuantity,
  }));
};

// 📦 Download forecast as CSV
const downloadCSV = (data) => {
  const header = "Ingredient,Total Quantity Needed";
  const rows = data.map((item) => `${item.name},${item.totalQuantity}`);
  const blob = new Blob([header + "\n" + rows.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "procurement_forecast.csv";
  link.click();
};

export default function ProcurementReport() {
  const { mealPlan } = useMealPlanStore();
  const aggregated = useMemo(() => aggregateIngredients(mealPlan), [mealPlan]);

  return (
    <div className="p-6 bg-white border border-stone-300 rounded shadow">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold text-green-700">
          📋 Long-Range Procurement Report
        </h2>
        <button
          onClick={() => downloadCSV(aggregated)}
          className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 flex items-center gap-2"
        >
          <Download size={18} />
          Export CSV
        </button>
      </div>

      {aggregated.length === 0 ? (
        <p className="text-stone-500 italic">
          No ingredients found. Add meals to your long-term plan first.
        </p>
      ) : (
        <table className="w-full border border-stone-200 text-sm">
          <thead>
            <tr className="bg-green-100 text-left">
              <th className="px-4 py-2 border-b border-stone-300">Ingredient</th>
              <th className="px-4 py-2 border-b border-stone-300">
                Total Quantity (2-Year Plan)
              </th>
            </tr>
          </thead>
          <tbody>
            {aggregated.map((item) => (
              <tr key={item.name}>
                <td className="px-4 py-2 border-b">{item.name}</td>
                <td className="px-4 py-2 border-b">{item.totalQuantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
