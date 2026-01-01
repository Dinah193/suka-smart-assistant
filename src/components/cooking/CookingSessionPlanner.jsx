import React, { useState } from "react";
import { CalendarDays, Utensils, Clock, PlayCircle, ClipboardList } from "lucide-react";
import CookingSessionReviewModal from "./CookingSessionReviewModal";

const sampleRecipes = [
  { id: 1, name: "Beef Stew", duration: 120 },
  { id: 2, name: "Roast Vegetables", duration: 45 },
  { id: 3, name: "Sourdough Bread", duration: 300 },
  { id: 4, name: "Fermented Pickles", duration: 1440 }
];

export default function CookingSessionPlanner() {
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [selectedRecipes, setSelectedRecipes] = useState([]);
  const [showReview, setShowReview] = useState(false);

  const toggleRecipe = (recipeId) => {
    if (selectedRecipes.includes(recipeId)) {
      setSelectedRecipes(selectedRecipes.filter(id => id !== recipeId));
    } else {
      setSelectedRecipes([...selectedRecipes, recipeId]);
    }
  };

  const plannedRecipes = sampleRecipes.filter(r => selectedRecipes.includes(r.id));

  return (
    <div className="flex w-full h-full">
      {/* Left Sidebar */}
      <aside className="w-72 p-5 bg-yellow-50 border-r border-yellow-200">
        <h2 className="text-xl font-bold text-yellow-700 mb-4">🍳 Plan a Cooking Session</h2>

        <div className="space-y-3 text-sm text-stone-700">
          <label className="block">
            <span className="flex items-center gap-2 font-medium text-yellow-800"><CalendarDays size={18} /> Date</span>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full border border-stone-300 rounded px-3 py-1 mt-1"
            />
          </label>

          <label className="block">
            <span className="flex items-center gap-2 font-medium text-yellow-800"><Clock size={18} /> Time</span>
            <input
              type="time"
              value={selectedTime}
              onChange={(e) => setSelectedTime(e.target.value)}
              className="w-full border border-stone-300 rounded px-3 py-1 mt-1"
            />
          </label>

          <button
            disabled={plannedRecipes.length === 0 || !selectedDate || !selectedTime}
            onClick={() => setShowReview(true)}
            className="w-full bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded flex items-center justify-center gap-2 mt-4"
          >
            <PlayCircle size={18} /> Review & Start
          </button>
        </div>
      </aside>

      {/* Main Section */}
      <main className="flex-1 p-6 bg-white">
        <h3 className="text-lg font-semibold text-yellow-800 mb-2 flex items-center gap-2">
          <Utensils size={20} /> Select Recipes to Include
        </h3>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sampleRecipes.map((recipe) => (
            <div
              key={recipe.id}
              onClick={() => toggleRecipe(recipe.id)}
              className={`cursor-pointer border rounded-lg p-4 shadow hover:shadow-md transition duration-200 ${
                selectedRecipes.includes(recipe.id)
                  ? "border-yellow-500 bg-yellow-100"
                  : "border-stone-200 bg-stone-50"
              }`}
            >
              <h4 className="text-md font-bold text-stone-700">{recipe.name}</h4>
              <p className="text-sm text-stone-500">{recipe.duration} min</p>
            </div>
          ))}
        </div>

        <div className="mt-6 bg-yellow-100 border border-yellow-300 p-4 rounded text-sm text-yellow-800 flex items-center gap-2">
          <ClipboardList size={18} />
          Once recipes, date and time are selected, you can review your session plan before starting. 🧑‍🍳
        </div>
      </main>

      {/* Review Modal */}
      {showReview && (
        <CookingSessionReviewModal
          onClose={() => setShowReview(false)}
          sessionData={{
            date: selectedDate,
            time: selectedTime,
            recipes: plannedRecipes
          }}
        />
      )}
    </div>
  );
}
