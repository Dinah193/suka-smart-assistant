// src/components/cooking/BatchCookingStorageIntentPanel.jsx

import React, { useState, useEffect } from "react";

export default function BatchCookingStorageIntentPanel({ recipes = [], onIntentSet }) {
  const [intentMap, setIntentMap] = useState({});

  // Notify parent anytime intent changes
  useEffect(() => {
    onIntentSet?.(intentMap);
  }, [intentMap, onIntentSet]);

  const handleChange = (recipeId, value) => {
    setIntentMap((prev) => ({ ...prev, [recipeId]: value }));
  };

  return (
    <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-sm space-y-4">
      <h2 className="text-xl font-bold text-rose-700">🧊 Storage Intent</h2>
      <p className="text-stone-600 text-sm">
        Choose how you want to handle each finished recipe after cooking.
      </p>
      {recipes.length === 0 && (
        <p className="text-stone-500 italic">No recipes selected.</p>
      )}
      {recipes.map((recipe) => (
        <div key={recipe.id} className="flex items-center justify-between border-b py-2">
          <div>
            <p className="font-medium text-stone-800">{recipe.name}</p>
          </div>
          <select
            value={intentMap[recipe.id] || ""}
            onChange={(e) => handleChange(recipe.id, e.target.value)}
            className="border border-stone-300 rounded px-3 py-1 text-sm"
          >
            <option value="">Select intent...</option>
            <option value="store">🧊 Store for later</option>
            <option value="consume">🍽️ Consume immediately</option>
            <option value="partial">🥄 Some now, some later</option>
          </select>
        </div>
      ))}
    </div>
  );
}
