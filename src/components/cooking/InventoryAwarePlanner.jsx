import React, { useState, useEffect } from "react";
import { CheckCircle, XCircle, ShoppingCart, Leaf, Egg } from "lucide-react";

import { getInventoryItems } from "@/utils/inventoryUtils";
import { getRecipeIngredients } from "@/utils/recipeUtils";
import { addToGardenQueue } from "@/utils/gardenUtils";
import { addToAnimalQueue } from "@/utils/animalUtils";

const ANIMAL_PRODUCTS = ["chicken", "beef", "goat", "lamb", "eggs", "milk", "cheese", "butter", "yogurt", "honey", "duck", "rabbit", "fish"];
const PLANT_PRODUCTS = ["wheat", "corn", "onion", "garlic", "tomato", "pepper", "spinach", "lettuce", "herbs", "potato", "carrot", "beans", "peas", "cabbage"];

export default function InventoryAwarePlanner({ selectedRecipes = [], onInventoryCheck }) {
  const [inventory, setInventory] = useState([]);
  const [neededIngredients, setNeededIngredients] = useState([]);
  const [missingIngredients, setMissingIngredients] = useState([]);

  useEffect(() => {
    const inv = getInventoryItems();
    setInventory(inv);
  }, []);

  useEffect(() => {
    const aggregate = {};

    selectedRecipes.forEach((recipe) => {
      const ingredients = getRecipeIngredients(recipe);
      ingredients.forEach(({ name, quantity, unit }) => {
        const key = name.toLowerCase();
        if (!aggregate[key]) {
          aggregate[key] = { name, quantity, unit };
        } else {
          aggregate[key].quantity += quantity;
        }
      });
    });

    const allNeeded = Object.values(aggregate);
    setNeededIngredients(allNeeded);

    const missing = allNeeded.filter((needed) => {
      const stock = inventory.find((inv) => inv.name.toLowerCase() === needed.name.toLowerCase());
      return !stock || stock.quantity < needed.quantity;
    });

    // Forecast to garden/animal queues
    missing.forEach((item) => {
      const name = item.name.toLowerCase();
      if (ANIMAL_PRODUCTS.includes(name)) {
        addToAnimalQueue(item);
      } else if (PLANT_PRODUCTS.includes(name)) {
        addToGardenQueue(item);
      }
    });

    setMissingIngredients(missing);
    onInventoryCheck?.({ allNeeded, missing });
  }, [selectedRecipes, inventory, onInventoryCheck]);

  return (
    <div className="bg-white border border-stone-300 rounded-lg p-4 space-y-4 shadow-sm">
      <h2 className="text-xl font-bold text-rose-700">📦 Inventory Check & Forecast</h2>
      <p className="text-sm text-stone-600">
        Items not in your pantry will be added to your Garden or Animal Queue for future self-production.
      </p>

      {neededIngredients.length === 0 ? (
        <p className="text-stone-500 italic">No ingredients to check yet.</p>
      ) : (
        <ul className="space-y-2">
          {neededIngredients.map((item, i) => {
            const stock = inventory.find((inv) => inv.name.toLowerCase() === item.name.toLowerCase());
            const isInStock = stock && stock.quantity >= item.quantity;
            const lowerName = item.name.toLowerCase();

            return (
              <li key={i} className="flex items-center justify-between border-b py-2">
                <span>
                  <span className="font-medium text-stone-800">{item.name}</span>{" "}
                  <span className="text-sm text-stone-500">
                    – {item.quantity} {item.unit}
                  </span>
                </span>
                <span className="flex items-center gap-1 text-sm">
                  {isInStock ? (
                    <>
                      <CheckCircle className="text-green-500" size={16} />
                      <span className="text-green-600">In stock</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="text-red-500" size={16} />
                      <span className="text-red-600">Missing</span>
                      {ANIMAL_PRODUCTS.includes(lowerName) && <Egg className="text-orange-500 ml-1" size={14} title="Animal Queue" />}
                      {PLANT_PRODUCTS.includes(lowerName) && <Leaf className="text-green-500 ml-1" size={14} title="Garden Queue" />}
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {missingIngredients.length > 0 && (
        <div className="mt-6 bg-rose-50 border border-rose-300 p-4 rounded-lg">
          <h3 className="text-lg font-semibold text-rose-700 flex items-center gap-2">
            <ShoppingCart size={18} />
            Missing Items (Shopping List)
          </h3>
          <ul className="list-disc list-inside mt-2 text-sm text-stone-700">
            {missingIngredients.map((item, i) => (
              <li key={i}>
                {item.name} – {item.quantity} {item.unit}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
