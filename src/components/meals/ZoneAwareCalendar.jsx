// src/components/meals/ZoneAwareCalendar.jsx

import React, { useEffect, useState } from "react";
import { CalendarDays, MapPin } from "lucide-react";
import { getZonePlantingData } from "@/utils/zoneUtils"; // 🔧 create this utility
import { useMealPlanStore } from "@/store/MealPlanStore";

export default function ZoneAwareCalendar() {
  const { mealPlan } = useMealPlanStore();
  const [zone, setZone] = useState("8a"); // Default fallback
  const [calendarData, setCalendarData] = useState([]);

  useEffect(() => {
    // Fetch zone-specific planting windows
    const data = getZonePlantingData(zone);
    setCalendarData(data);
  }, [zone]);

  const handleZoneChange = (e) => {
    setZone(e.target.value);
  };

  return (
    <div className="p-6 bg-white border border-yellow-400 rounded-xl shadow-md max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-yellow-800 flex gap-2 items-center">
          <CalendarDays size={22} />
          Zone-Aware Food Calendar
        </h2>

        <div className="flex items-center gap-2">
          <MapPin size={18} />
          <label className="text-sm font-semibold text-stone-600">Zone:</label>
          <select
            value={zone}
            onChange={handleZoneChange}
            className="border rounded px-2 py-1 text-sm"
          >
            {["6a", "6b", "7a", "7b", "8a", "8b", "9a", "9b"].map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
      </div>

      {calendarData.length === 0 ? (
        <p className="italic text-stone-500">No planting data available for this zone.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 max-h-[70vh] overflow-y-scroll pr-2">
          {calendarData.map((entry) => (
            <div
              key={entry.crop}
              className="bg-yellow-50 border border-yellow-200 p-4 rounded shadow-sm"
            >
              <h3 className="text-lg font-semibold text-yellow-800">{entry.crop}</h3>
              <ul className="text-sm text-stone-700 mt-2 list-disc pl-5 space-y-1">
                <li>
                  🌱 Planting:{" "}
                  <span className="font-medium">
                    {entry.start} – {entry.end}
                  </span>
                </li>
                <li>
                  🥕 Harvest Window:{" "}
                  <span className="font-medium">
                    {entry.harvestStart} – {entry.harvestEnd}
                  </span>
                </li>
                <li>
                  📅 Meal Plan Uses:{" "}
                  {(mealPlanUses(entry.crop, mealPlan) || []).join(", ") || (
                    <span className="italic text-stone-400">Not yet in meals</span>
                  )}
                </li>
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 🔧 helper to match meal plan ingredients to crops
function mealPlanUses(crop, mealPlan) {
  const uses = new Set();
  Object.values(mealPlan).forEach((recipes) => {
    recipes.forEach((r) => {
      if (r.ingredients?.some((i) => i.name.toLowerCase().includes(crop.toLowerCase()))) {
        uses.add(r.name);
      }
    });
  });
  return [...uses];
}
