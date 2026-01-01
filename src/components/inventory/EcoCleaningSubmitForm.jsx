import React, { useState } from "react";
import { PlusCircle, CheckCircle } from "lucide-react";

export default function EcoCleaningSubmitForm({ onSubmit }) {
  const [type, setType] = useState("Recipe");
  const [name, setName] = useState("");
  const [categories, setCategories] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [instructions, setInstructions] = useState("");
  const [source, setSource] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;

    const newItem = {
      id: Date.now(),
      name,
      type,
      categories: categories.split(",").map((c) => c.trim()),
      ingredients: type === "Recipe" ? ingredients.split(",").map((i) => i.trim()) : [],
      instructions: type === "Recipe" ? instructions.trim() : "",
      source: type === "Product" ? source.trim() : "",
    };

    if (onSubmit) onSubmit(newItem);
    setSubmitted(true);

    // Reset form after short delay
    setTimeout(() => {
      setSubmitted(false);
      setType("Recipe");
      setName("");
      setCategories("");
      setIngredients("");
      setInstructions("");
      setSource("");
    }, 2000);
  };

  return (
    <div className="bg-green-50 border border-green-300 rounded-lg p-6 mt-8 shadow">
      <h3 className="text-xl font-bold text-green-700 mb-4 flex items-center gap-2">
        <PlusCircle size={20} /> Submit a New Eco Option
      </h3>

      <form onSubmit={handleSubmit} className="space-y-4 text-sm text-stone-700">
        <div>
          <label className="block mb-1 font-semibold">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full border border-stone-300 rounded px-3 py-2"
          >
            <option value="Recipe">DIY Recipe</option>
            <option value="Product">Eco Product</option>
          </select>
        </div>

        <div>
          <label className="block mb-1 font-semibold">Name</label>
          <input
            type="text"
            placeholder="e.g. Lemon-Vinegar Degreaser"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-stone-300 rounded px-3 py-2"
            required
          />
        </div>

        <div>
          <label className="block mb-1 font-semibold">Categories</label>
          <input
            type="text"
            placeholder="e.g. kitchen, degreasing"
            value={categories}
            onChange={(e) => setCategories(e.target.value)}
            className="w-full border border-stone-300 rounded px-3 py-2"
          />
        </div>

        {type === "Recipe" ? (
          <>
            <div>
              <label className="block mb-1 font-semibold">Ingredients (comma separated)</label>
              <input
                type="text"
                placeholder="e.g. vinegar, lemon peel, baking soda"
                value={ingredients}
                onChange={(e) => setIngredients(e.target.value)}
                className="w-full border border-stone-300 rounded px-3 py-2"
              />
            </div>

            <div>
              <label className="block mb-1 font-semibold">Instructions</label>
              <textarea
                rows={3}
                placeholder="Describe how to make and use the recipe..."
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                className="w-full border border-stone-300 rounded px-3 py-2"
              />
            </div>
          </>
        ) : (
          <div>
            <label className="block mb-1 font-semibold">Purchase Link</label>
            <input
              type="url"
              placeholder="https://..."
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full border border-stone-300 rounded px-3 py-2"
            />
          </div>
        )}

        <button
          type="submit"
          className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded shadow"
        >
          ✅ Submit
        </button>

        {submitted && (
          <div className="mt-3 text-green-600 flex items-center gap-1 font-medium">
            <CheckCircle size={18} /> Submission received!
          </div>
        )}
      </form>
    </div>
  );
}
