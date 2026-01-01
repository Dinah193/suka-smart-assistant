// src/components/cooking/MealLogger.jsx

import React, { useState, useEffect } from "react";
import {
  ClipboardCheck,
  CalendarDays,
  Trash2,
  Lightbulb,
  Printer
} from "lucide-react";

// LocalStorage helpers
const getMealLogs = () => JSON.parse(localStorage.getItem("mealLogs") || "[]");
const saveMealLogs = (logs) => localStorage.setItem("mealLogs", JSON.stringify(logs));

// Filters
const getWeekRange = () => {
  const now = new Date();
  const start = new Date(now.setDate(now.getDate() - now.getDay()));
  return start.toISOString().split("T")[0]; // YYYY-MM-DD
};

// Nutrient utils (dummy per-meal macro data)
const NUTRITION_DB = {
  "Beef Stew": { calories: 300, protein: 25, carbs: 15, fat: 18 },
  "Tomato Soup": { calories: 180, protein: 5, carbs: 20, fat: 8 },
  "Chicken Salad": { calories: 240, protein: 20, carbs: 10, fat: 14 },
  "Lamb Curry": { calories: 400, protein: 30, carbs: 12, fat: 22 }
};

export default function MealLogger({ availableMeals = [], onLogUpdate }) {
  const [logs, setLogs] = useState(getMealLogs());
  const [filteredLogs, setFilteredLogs] = useState([]);
  const [selectedMealId, setSelectedMealId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [timeOfDay, setTimeOfDay] = useState("Lunch");
  const [filterBy, setFilterBy] = useState("week");

  useEffect(() => {
    filterLogs();
  }, [logs, filterBy]);

  const filterLogs = () => {
    const today = new Date().toISOString().split("T")[0];
    const weekStart = getWeekRange();

    const filtered = logs.filter((log) => {
      const dateOnly = log.date.split("T")[0];
      if (filterBy === "today") return dateOnly === today;
      if (filterBy === "week") return dateOnly >= weekStart;
      return true;
    });

    setFilteredLogs(filtered);
  };

  const handleLog = () => {
    const meal = availableMeals.find((m) => m.id === selectedMealId);
    if (!meal) return;

    const entry = {
      id: Date.now(),
      name: meal.name,
      recipeId: meal.id,
      quantity,
      unit: meal.unit || "serving",
      timeOfDay,
      date: new Date().toISOString()
    };

    const updatedLogs = [...logs, entry];
    saveMealLogs(updatedLogs);
    setLogs(updatedLogs);
    setSelectedMealId("");
    setQuantity(1);
    onLogUpdate?.(updatedLogs);
  };

  const handleDelete = (entryId) => {
    const updated = logs.filter((log) => log.id !== entryId);
    saveMealLogs(updated);
    setLogs(updated);
    onLogUpdate?.(updated);
  };

  const formatDate = (iso) => new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });

  const aggregateMacros = () => {
    const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    filteredLogs.forEach((log) => {
      const data = NUTRITION_DB[log.name] || {};
      totals.calories += (data.calories || 0) * log.quantity;
      totals.protein += (data.protein || 0) * log.quantity;
      totals.carbs += (data.carbs || 0) * log.quantity;
      totals.fat += (data.fat || 0) * log.quantity;
    });
    return totals;
  };

  const getAISuggestion = () => {
    const names = filteredLogs.map((l) => l.name.toLowerCase());
    const freq = names.reduce((acc, name) => {
      acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {});
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0 && sorted[0][1] > 3) {
      return `🧠 You’ve had ${sorted[0][1]} meals with "${sorted[0][0]}" this week. Try something different for balance.`;
    }
    return null;
  };

  const macroTotals = aggregateMacros();
  const suggestion = getAISuggestion();

  return (
    <div className="bg-white border border-stone-300 rounded-lg p-4 space-y-4 shadow-sm mt-6">
      <h2 className="text-xl font-bold text-rose-700">📊 Meal Logger</h2>

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-sm items-center">
        <select
          value={selectedMealId}
          onChange={(e) => setSelectedMealId(e.target.value)}
          className="border px-2 py-1 rounded"
        >
          <option value="">Select a meal...</option>
          {availableMeals.map((meal) => (
            <option key={meal.id} value={meal.id}>
              {meal.name}
            </option>
          ))}
        </select>

        <input
          type="number"
          min="1"
          value={quantity}
          onChange={(e) => setQuantity(parseInt(e.target.value || 1))}
          className="border px-2 py-1 rounded"
          placeholder="Qty"
        />

        <select
          value={timeOfDay}
          onChange={(e) => setTimeOfDay(e.target.value)}
          className="border px-2 py-1 rounded"
        >
          <option>Breakfast</option>
          <option>Lunch</option>
          <option>Dinner</option>
          <option>Snack</option>
        </select>

        <button
          onClick={handleLog}
          className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded flex items-center gap-2"
        >
          <ClipboardCheck size={16} /> Log Meal
        </button>

        <select
          value={filterBy}
          onChange={(e) => setFilterBy(e.target.value)}
          className="border px-2 py-1 rounded"
        >
          <option value="week">This Week</option>
          <option value="today">Today</option>
          <option value="all">All Time</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
        <div>
          <h3 className="font-semibold text-stone-800">📈 Macro Totals</h3>
          <ul className="mt-1 text-stone-600">
            <li>Calories: {macroTotals.calories} kcal</li>
            <li>Protein: {macroTotals.protein} g</li>
            <li>Carbs: {macroTotals.carbs} g</li>
            <li>Fat: {macroTotals.fat} g</li>
          </ul>
        </div>
        {suggestion && (
          <div className="bg-yellow-100 border border-yellow-300 p-2 rounded text-yellow-800 text-sm flex gap-2">
            <Lightbulb size={18} />
            <span>{suggestion}</span>
          </div>
        )}
      </div>

      <div className="mt-4">
        <h3 className="text-lg font-semibold text-stone-800 mb-2 flex items-center gap-2">
          <CalendarDays size={18} />
          Logged Meals
        </h3>
        {filteredLogs.length === 0 ? (
          <p className="text-stone-500 italic text-sm">No meals logged yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {filteredLogs
              .slice()
              .reverse()
              .map((log) => (
                <li key={log.id} className="py-2 flex justify-between items-center">
                  <div>
                    <p className="font-medium text-stone-800">{log.name}</p>
                    <p className="text-xs text-stone-500">
                      {log.quantity} {log.unit} | {log.timeOfDay} | {formatDate(log.date)}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(log.id)}
                    className="text-red-600 hover:text-red-700"
                    title="Delete Log"
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      <div className="text-right">
        <button
          className="mt-3 bg-stone-600 hover:bg-stone-700 text-white px-4 py-2 rounded text-sm inline-flex items-center gap-2"
          onClick={() => window.print()}
        >
          <Printer size={16} />
          Print Report
        </button>
      </div>
    </div>
  );
}
