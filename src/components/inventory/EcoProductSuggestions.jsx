import React, { useEffect, useState } from "react";
import { Leaf, SprayCan, Info } from "lucide-react";

// Mock product suggestion logic (can later be replaced with API or DB lookup)
const getEcoSuggestions = (tasks) => {
  const suggestions = [];

  if (tasks.some(t => /toilet|bathroom|sink/i.test(t)))
    suggestions.push({
      name: "DIY Citrus Vinegar Cleaner",
      type: "Recipe",
      eco: true,
      ingredients: ["Citrus peels", "White vinegar", "Water"],
      instructions: "Steep citrus peels in vinegar for 2 weeks, dilute 1:1 with water."
    });

  if (tasks.some(t => /floor|mop|sweep/i.test(t)))
    suggestions.push({
      name: "Dr. Bronner’s Sal Suds Biodegradable Cleaner",
      type: "Product",
      eco: true,
      source: "https://shop.drbronner.com"
    });

  if (tasks.some(t => /windows|glass/i.test(t)))
    suggestions.push({
      name: "Streak-Free Glass Spray",
      type: "Recipe",
      eco: true,
      ingredients: ["1 cup water", "1 cup vinegar", "1 tbsp cornstarch"],
      instructions: "Mix and shake well before spraying on glass. Wipe with microfiber cloth."
    });

  return suggestions;
};

export default function EcoProductSuggestions({ tasks = [] }) {
  const [recommendations, setRecommendations] = useState([]);

  useEffect(() => {
    if (tasks.length > 0) {
      setRecommendations(getEcoSuggestions(tasks));
    } else {
      setRecommendations([]);
    }
  }, [tasks]);

  return (
    <div className="p-6 bg-white rounded-xl border border-green-300 shadow-md">
      <h2 className="text-xl font-bold text-green-700 mb-4 flex items-center gap-2">
        <Leaf size={20} /> Eco-Friendly & Effective Product Suggestions
      </h2>

      {recommendations.length === 0 ? (
        <div className="text-stone-500 italic flex gap-2 items-center">
          <Info size={18} />
          No tasks detected yet. Start planning a cleaning session to get suggestions.
        </div>
      ) : (
        <ul className="space-y-5">
          {recommendations.map((rec, i) => (
            <li
              key={i}
              className="p-4 bg-green-50 border border-green-200 rounded-lg shadow-sm"
            >
              <h3 className="font-semibold text-green-800 text-lg flex items-center gap-1">
                <SprayCan size={16} />
                {rec.name}
              </h3>

              <p className="text-sm text-stone-600 mt-1">
                {rec.type === "Product" && (
                  <>
                    🛒{" "}
                    <a
                      href={rec.source}
                      target="_blank"
                      rel="noreferrer"
                      className="text-green-700 underline"
                    >
                      Buy here
                    </a>
                  </>
                )}

                {rec.type === "Recipe" && (
                  <>
                    🧪 Ingredients:
                    <ul className="list-disc list-inside ml-2 text-stone-700 mt-1">
                      {rec.ingredients.map((ing, idx) => (
                        <li key={idx}>{ing}</li>
                      ))}
                    </ul>
                    <div className="mt-2 text-stone-700">
                      🧼 Instructions: <em>{rec.instructions}</em>
                    </div>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
