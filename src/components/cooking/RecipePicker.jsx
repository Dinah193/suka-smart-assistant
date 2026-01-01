import React, { useState, useEffect } from "react";
import { PlusCircle, CheckCircle } from "lucide-react";

/**
 * Props:
 * - savedRecipes: [{ id, name, image, tags, ingredients, instructions }]
 * - onSelect: function(recipe) => void
 * - selectedIds: array of selected recipe IDs
 */
export default function RecipePicker({ savedRecipes = [], onSelect, selectedIds = [] }) {
  const [filter, setFilter] = useState("");

  const handleSelect = (recipe) => {
    // Prevent duplicate selections
    if (!selectedIds.includes(recipe.id)) {
      onSelect([...selectedIds, recipe]);
    } else {
      // If already selected, remove from list
      const updated = selectedIds.filter((r) => r.id !== recipe.id);
      onSelect(updated);
    }
  };

  const filteredRecipes = savedRecipes.filter((r) =>
    r.name.toLowerCase().includes(filter.toLowerCase()) ||
    r.tags?.some((t) => t.toLowerCase().includes(filter.toLowerCase()))
  );

  return (
    <div className="p-5 bg-white border border-orange-200 rounded-xl shadow">
      <h2 className="text-xl font-bold text-orange-600 mb-4">🍲 Choose Recipes</h2>

      <input
        type="text"
        placeholder="Search recipes..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="w-full mb-4 px-4 py-2 border border-stone-300 rounded"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
        {filteredRecipes.map((recipe) => {
          const isSelected = selectedIds.some((r) => r.id === recipe.id);
          return (
            <div
              key={recipe.id}
              className={`relative border rounded-xl overflow-hidden shadow hover:shadow-md transition-all ${
                isSelected ? "border-green-400" : "border-stone-200"
              }`}
            >
              {recipe.image && (
                <img
                  src={recipe.image}
                  alt={recipe.name}
                  className="h-32 w-full object-cover"
                />
              )}
              <div className="p-3">
                <h3 className="font-semibold text-orange-700">{recipe.name}</h3>
                {recipe.tags && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {recipe.tags.map((tag, i) => (
                      <span
                        key={i}
                        className="text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => handleSelect(recipe)}
                className={`absolute top-2 right-2 p-1 rounded-full border-2 transition ${
                  isSelected
                    ? "bg-green-100 border-green-500 text-green-700"
                    : "bg-orange-100 border-orange-300 text-orange-600"
                }`}
              >
                {isSelected ? <CheckCircle size={20} /> : <PlusCircle size={20} />}
              </button>
            </div>
          );
        })}
      </div>

      {filteredRecipes.length === 0 && (
        <p className="text-stone-400 italic mt-6 text-center">
          No recipes match your search.
        </p>
      )}
    </div>
  );
}
