import React, { useState, useEffect } from "react";
import { Search, Filter, Leaf, SprayCan, Info } from "lucide-react";
import ecoCleaningDatabase from "@/data/EcoCleaningDatabase";

export default function EcoCleaningLibrary() {
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("All");
  const [filteredItems, setFilteredItems] = useState([]);

  useEffect(() => {
    let results = ecoCleaningDatabase;

    if (filterType !== "All") {
      results = results.filter((item) => item.type === filterType);
    }

    if (search.trim()) {
      results = results.filter((item) =>
        item.name.toLowerCase().includes(search.toLowerCase()) ||
        item.categories.some((c) => c.toLowerCase().includes(search.toLowerCase()))
      );
    }

    setFilteredItems(results);
  }, [search, filterType]);

  return (
    <div className="p-6 bg-white rounded-xl border border-green-300 shadow-md">
      <h2 className="text-2xl font-bold text-green-700 mb-6 flex items-center gap-2">
        <Leaf size={24} /> Eco Cleaning Library
      </h2>

      {/* Search and Filter Controls */}
      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 text-green-500" size={18} />
          <input
            type="text"
            placeholder="Search by name or category..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-stone-300 rounded"
          />
        </div>

        <div className="flex items-center gap-2">
          <Filter size={18} className="text-green-600" />
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="border border-stone-300 px-3 py-2 rounded"
          >
            <option value="All">All Types</option>
            <option value="Recipe">DIY Recipes</option>
            <option value="Product">Eco Products</option>
          </select>
        </div>
      </div>

      {/* Results */}
      {filteredItems.length === 0 ? (
        <p className="text-stone-500 italic flex items-center gap-2">
          <Info size={16} />
          No matches found for your search.
        </p>
      ) : (
        <ul className="grid md:grid-cols-2 gap-6">
          {filteredItems.map((item) => (
            <li
              key={item.id}
              className="p-4 bg-green-50 border border-green-200 rounded-lg shadow-sm"
            >
              <h3 className="font-semibold text-green-800 text-lg flex items-center gap-1">
                <SprayCan size={16} /> {item.name}
              </h3>
              <p className="text-xs text-stone-500 mt-1 italic">{item.type}</p>

              <div className="text-sm text-stone-700 mt-2">
                <strong>Use Cases:</strong>{" "}
                {item.categories.map((cat, i) => (
                  <span
                    key={i}
                    className="inline-block bg-green-100 text-green-700 px-2 py-0.5 rounded text-xs mr-1"
                  >
                    {cat}
                  </span>
                ))}
              </div>

              {item.type === "Recipe" && (
                <div className="mt-3">
                  <strong>Ingredients:</strong>
                  <ul className="list-disc list-inside text-stone-700 text-sm ml-2">
                    {item.ingredients.map((ing, idx) => (
                      <li key={idx}>{ing}</li>
                    ))}
                  </ul>
                  <div className="mt-2 text-stone-700">
                    <strong>Instructions:</strong> <em>{item.instructions}</em>
                  </div>
                </div>
              )}

              {item.type === "Product" && (
                <div className="mt-2">
                  <a
                    href={item.source}
                    target="_blank"
                    rel="noreferrer"
                    className="text-green-600 underline text-sm"
                  >
                    🛒 Buy Product
                  </a>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
