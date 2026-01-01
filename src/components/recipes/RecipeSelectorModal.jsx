// src/components/recipes/RecipeSelectorModal.jsx
import React, { useState, useEffect } from "react";
import { useDrag } from "react-dnd";
import useRecipeStore from "@/store/RecipeStore";
import { Dialog } from "@headlessui/react";
import { X, Search, ChefHat, CheckCircle, PlusCircle } from "lucide-react";

export default function RecipeSelectorModal({ isOpen, onClose, onSelect }) {
  const { recipes, updateRecipeTags } = useRecipeStore();
  const [search, setSearch] = useState("");
  const [selectedTag, setSelectedTag] = useState(null);
  const [sortBy, setSortBy] = useState("name");
  const [filtered, setFiltered] = useState([]);
  const [selectedRecipes, setSelectedRecipes] = useState([]);
  const [newTag, setNewTag] = useState("");

  const allTags = [...new Set(recipes.flatMap((r) => r.tags || []))];

  useEffect(() => {
    let results = recipes.filter((r) =>
      r.name.toLowerCase().includes(search.toLowerCase())
    );
    if (selectedTag) results = results.filter((r) => r.tags?.includes(selectedTag));
    results.sort((a, b) => a[sortBy]?.localeCompare(b[sortBy]));
    setFiltered(results);
  }, [search, selectedTag, sortBy, recipes]);

  const toggleSelect = (recipe) => {
    setSelectedRecipes((prev) =>
      prev.find((r) => r.id === recipe.id)
        ? prev.filter((r) => r.id !== recipe.id)
        : [...prev, recipe]
    );
  };

  const handleAddTag = (id, tag) => {
    if (!tag) return;
    updateRecipeTags(id, tag);
    setNewTag("");
  };

  const isSelected = (id) => selectedRecipes.some((r) => r.id === id);

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl border-4 border-yellow-500">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-pink-700 flex items-center gap-2">
              <ChefHat className="text-orange-600" /> Select Recipes
            </h2>
            <button onClick={onClose} className="text-stone-400 hover:text-red-500">
              <X size={24} />
            </button>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 text-stone-400" size={18} />
              <input
                type="text"
                placeholder="Search recipes..."
                className="w-full pl-10 pr-4 py-2 border rounded-md"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select value={selectedTag || ""} onChange={(e) => setSelectedTag(e.target.value || null)} className="border rounded-md px-3 py-2">
              <option value="">All Tags</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="border rounded-md px-3 py-2">
              <option value="name">Sort by Name</option>
              <option value="category">Sort by Category</option>
            </select>
          </div>

          <div className="max-h-[50vh] overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-4">
            {filtered.map((recipe) => (
              <DraggableRecipeCard
                key={recipe.id}
                recipe={recipe}
                isSelected={isSelected(recipe.id)}
                onToggle={() => toggleSelect(recipe)}
                newTag={newTag}
                setNewTag={setNewTag}
                handleAddTag={handleAddTag}
              />
            ))}
            {filtered.length === 0 && (
              <p className="col-span-2 text-sm text-stone-500 italic">No recipes found.</p>
            )}
          </div>

          <div className="mt-4 text-right">
            <button
              className="bg-yellow-500 text-white px-4 py-2 rounded-md"
              disabled={selectedRecipes.length === 0}
              onClick={() => { onSelect(selectedRecipes); onClose(); }}
            >
              Confirm Selection ({selectedRecipes.length})
            </button>
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}

function DraggableRecipeCard({ recipe, isSelected, onToggle, newTag, setNewTag, handleAddTag }) {
  const [{ isDragging }, dragRef] = useDrag({
    type: "RECIPE_CARD",
    item: { ...recipe },
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  return (
    <div
      ref={dragRef}
      className={`relative border rounded-lg p-3 cursor-pointer transition-all ${
        isSelected ? "bg-yellow-200 border-yellow-500" : "bg-white"
      } ${isDragging ? "opacity-40" : "hover:bg-yellow-50"}`}
      onClick={onToggle}
    >
      <h3 className="font-semibold text-orange-700">{recipe.name}</h3>
      {recipe.tags && (
        <div className="mt-1 flex flex-wrap gap-1 text-xs text-stone-500">
          {recipe.tags.map((t) => (
            <span key={t} className="bg-stone-200 rounded-full px-2 py-0.5">{t}</span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 mt-2">
        <input
          type="text"
          placeholder="Add tag"
          className="text-xs border px-2 py-1 rounded w-full"
          value={newTag}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setNewTag(e.target.value)}
        />
        <button
          className="text-green-600 hover:text-green-800"
          onClick={(e) => {
            e.stopPropagation();
            handleAddTag(recipe.id, newTag);
          }}
        >
          <PlusCircle size={18} />
        </button>
      </div>
      {isSelected && <CheckCircle size={18} className="absolute top-2 right-2 text-green-600" />}
    </div>
  );
}
