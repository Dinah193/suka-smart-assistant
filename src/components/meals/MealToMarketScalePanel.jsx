import React, { useState, useMemo } from "react";
import { useMealPlanStore } from "@/store/MealPlanStore";
import { SlidersHorizontal, ShoppingCart } from "lucide-react";

export default function MealToMarketScalePanel() {
  const { mealPlan } = useMealPlanStore();
  const [selectedDay, setSelectedDay] = useState("Monday");
  const [scaleFactor, setScaleFactor] = useState(10);

  const scaledIngredients = useMemo(() => {
    const recipes = mealPlan[selectedDay] || [];

    const map = new Map();

    recipes.forEach((recipe) => {
      recipe.ingredients?.forEach((ing) => {
        const key = ing.name.toLowerCase();
        const existing = map.get(key) || { ...ing, total: 0 };

        existing.total += (ing.quantity || 0) * scaleFactor;
        map.set(key, existing);
      });
    });

    return Array.from(map.values());
  }, [mealPlan, selectedDay, scaleFactor]);

  const dayOptions = Object.keys(mealPlan);

  return (
    <div className="p-6 bg-white border border-orange-300 rounded-lg shadow-md max-w-4xl mx-auto">
      <h2 className="text-xl font-bold text-orange-700 mb-4 flex items-center gap-2">
        <SlidersHorizontal size={20} /> Scale Meal to Market Production
      </h2>

      <div className="flex flex-col md:flex-row md:items-center gap-4 mb-6">
        <div className="flex flex-col">
          <label className="text-sm font-semibold text-stone-600 mb-1">📅 Choose Day</label>
          <select
            value={selectedDay}
            onChange={(e) => setSelectedDay(e.target.value)}
            className="border border-stone-300 px-3 py-2 rounded"
          >
            {dayOptions.map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col">
          <label className="text-sm font-semibold text-stone-600 mb-1">🔁 Scale Factor</label>
          <input
            type="number"
            min="1"
            value={scaleFactor}
            onChange={(e) => setScaleFactor(Number(e.target.value))}
            className="border border-stone-300 px-3 py-2 rounded w-24"
          />
        </div>
      </div>

      {scaledIngredients.length === 0 ? (
        <p className="text-stone-500 italic">No ingredients found for this day.</p>
      ) : (
        <table className="w-full table-auto border-collapse">
          <thead>
            <tr className="bg-orange-100 text-orange-800 font-semibold">
              <th className="text-left px-3 py-2 border">Ingredient</th>
              <th className="text-left px-3 py-2 border">Quantity</th>
              <th className="text-left px-3 py-2 border">Unit</th>
            </tr>
          </thead>
          <tbody>
            {scaledIngredients.map((item, idx) => (
              <tr key={idx} className="border-t">
                <td className="px-3 py-2">{item.name}</td>
                <td className="px-3 py-2">{item.total.toFixed(2)}</td>
                <td className="px-3 py-2">{item.unit || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex justify-end mt-6">
        <button
          className="bg-orange-600 text-white font-semibold px-5 py-2 rounded hover:bg-orange-700 flex items-center gap-2"
          onClick={() => alert("Future: Export to inventory or print labels")}
        >
          <ShoppingCart size={18} /> Export for Production
        </button>
      </div>
    </div>
  );
}
