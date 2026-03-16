// src/components/storehouse/StorehouseAutoFillPlanner.jsx
import React, { useEffect, useMemo } from "react";
import { shallow } from "zustand/shallow";
import { useMealPlanStore } from "@/store/MealPlanStore";
import { useStorehousePlannerStore } from "@/store/StorehousePlannerStore";
import { summarizeIngredientsFromMealPlan, suggestPreservationType } from "@/utils/storehouseUtils";

// tiny helper; good enough for this deterministic array
const jsonSig = (v) => JSON.stringify(v ?? []);

export default function StorehouseAutoFillPlanner() {
  // ✅ Subscribe narrowly (avoid whole-store subscriptions)
  const mealPlan = useMealPlanStore((s) => s.mealPlan);
  const { storehouseNeeds, setStorehouseNeeds } = useStorehousePlannerStore(
    (s) => ({ storehouseNeeds: s.storehouseNeeds, setStorehouseNeeds: s.setStorehouseNeeds }),
    shallow
  );

  // ✅ Pure, memoized summary from the meal plan
  const summarized = useMemo(() => {
    try {
      const base = summarizeIngredientsFromMealPlan(mealPlan) || [];
      return base.map((item) => ({
        id: `${String(item.name || "").toLowerCase()}::${String(item.unit || "unit").toLowerCase()}`,
        name: item.name,
        unit: item.unit,
        qty: Number(item.total || item.qty || 0),
        category: "meal-planner",
        source: "meal-planner",
        tags: ["meal-plan", "autofill"],
      }));
    } catch {
      return [];
    }
  }, [mealPlan]);

  // ✅ Only write to the store when the computed summary actually changed
  const needsSig = jsonSig(
    (Array.isArray(storehouseNeeds) ? storehouseNeeds : []).map((item) => ({
      name: item?.name,
      unit: item?.unit,
      qty: Number(item?.qty ?? item?.total ?? 0),
    }))
  );
  const summarizedSig = jsonSig(summarized);

  useEffect(() => {
    if (needsSig !== summarizedSig) {
      setStorehouseNeeds(summarized);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summarizedSig, needsSig]); // depends on signatures, not raw arrays

  return (
    <div className="p-6 bg-white border border-green-300 shadow rounded-xl max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold text-green-700 mb-4">
        🏚 Storehouse Auto-Fill & Preservation Planner
      </h2>

      {storehouseNeeds.length === 0 ? (
        <p className="italic text-stone-500">No ingredients found in meal plan.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm border-collapse">
            <thead>
              <tr className="bg-green-100 text-left">
                <th className="p-2 border">Ingredient</th>
                <th className="p-2 border">Total Qty</th>
                <th className="p-2 border">Unit</th>
                <th className="p-2 border">Preservation Type</th>
              </tr>
            </thead>
            <tbody>
              {storehouseNeeds.map((item, i) => (
                <tr key={`${item.name}-${i}`} className="even:bg-green-50">
                  <td className="p-2 border">{item.name}</td>
                  <td className="p-2 border">{Number(item.qty ?? item.total ?? 0).toFixed(2)}</td>
                  <td className="p-2 border">{item.unit}</td>
                  <td className="p-2 border">{suggestPreservationType(item.name)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
