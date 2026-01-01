// src/components/cooking/InventorySyncer.jsx

import React, { useState } from "react";
import { PlusCircle, CheckCircle } from "lucide-react";
import {
  getInventoryItems,
  setInventoryItems
} from "@/utils/inventoryUtils";

const STORAGE_LOCATIONS = ["Freezer", "Root Cellar", "Shelf"];
const PROCESSING_METHODS = ["Pressure Canned", "Fermented", "Dehydrated", "Frozen", "Smoked"];

export default function InventorySyncer({
  completedRecipes = [],
  storageIntentMap = {},
  onSyncComplete,
  onTriggerLabelPrint
}) {
  const [syncLog, setSyncLog] = useState([]);
  const [synced, setSynced] = useState(false);
  const [itemData, setItemData] = useState({});

  const updateField = (recipeId, field, value) => {
    setItemData((prev) => ({
      ...prev,
      [recipeId]: {
        ...(prev[recipeId] || {}),
        [field]: value
      }
    }));
  };

  const handleSync = () => {
    const inventory = getInventoryItems();
    const updates = [];

    completedRecipes.forEach((recipe) => {
      const intent = storageIntentMap[recipe.id];
      if (intent !== "store" && intent !== "partial") return;

      const fields = itemData[recipe.id] || {};
      const name = `${recipe.name} (Batch)`;
      const quantity = parseInt(fields.quantity || (intent === "store" ? recipe.yield || 1 : 0));
      const unit = fields.unit || "serving";
      const location = fields.location || "Shelf";
      const method = fields.processing || "Unprocessed";

      if (quantity <= 0) return;

      const existing = inventory.find((item) => item.name === name && item.location === location);
      if (existing) {
        existing.quantity += quantity;
      } else {
        inventory.push({
          name,
          quantity,
          unit,
          location,
          processing: method,
          source: "batch-cooking",
          createdAt: new Date().toISOString()
        });
      }

      updates.push(`${name} × ${quantity} to ${location} (${method})`);
    });

    setInventoryItems(inventory);
    setSyncLog(updates);
    setSynced(true);
    onSyncComplete?.(updates);
    onTriggerLabelPrint?.(completedRecipes, storageIntentMap, itemData);
  };

  return (
    <div className="bg-white border border-stone-300 p-4 rounded-lg shadow-sm space-y-4 mt-6">
      <h2 className="text-xl font-bold text-rose-700">📥 Sync to Inventory</h2>
      <p className="text-sm text-stone-600">
        For recipes marked to be stored, confirm quantity, unit, location, and processing method.
      </p>

      {completedRecipes.length === 0 ? (
        <p className="text-stone-400 italic">No completed recipes to sync.</p>
      ) : (
        completedRecipes.map((recipe) => {
          const intent = storageIntentMap[recipe.id];
          if (intent !== "store" && intent !== "partial") return null;

          const fields = itemData[recipe.id] || {};
          return (
            <div key={recipe.id} className="border-b py-3 space-y-1">
              <p className="font-medium text-stone-800">{recipe.name}</p>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-sm">
                <input
                  type="number"
                  min="1"
                  placeholder="Quantity"
                  className="border px-2 py-1 rounded"
                  value={fields.quantity || ""}
                  onChange={(e) => updateField(recipe.id, "quantity", e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Unit (e.g. jars, lbs)"
                  className="border px-2 py-1 rounded"
                  value={fields.unit || ""}
                  onChange={(e) => updateField(recipe.id, "unit", e.target.value)}
                />
                <select
                  value={fields.location || ""}
                  onChange={(e) => updateField(recipe.id, "location", e.target.value)}
                  className="border px-2 py-1 rounded"
                >
                  <option value="">Select Storage</option>
                  {STORAGE_LOCATIONS.map((loc) => (
                    <option key={loc} value={loc}>{loc}</option>
                  ))}
                </select>
                <select
                  value={fields.processing || ""}
                  onChange={(e) => updateField(recipe.id, "processing", e.target.value)}
                  className="border px-2 py-1 rounded"
                >
                  <option value="">Processing Method</option>
                  {PROCESSING_METHODS.map((method) => (
                    <option key={method} value={method}>{method}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })
      )}

      {!synced && (
        <button
          onClick={handleSync}
          className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded flex items-center gap-2"
        >
          <PlusCircle size={16} /> Sync to Pantry & Print Labels
        </button>
      )}

      {synced && syncLog.length > 0 && (
        <div className="bg-green-50 border border-green-300 rounded p-3 mt-4 text-green-800">
          <p className="font-semibold flex items-center gap-2">
            <CheckCircle size={16} />
            Inventory Updated:
          </p>
          <ul className="list-disc ml-6 mt-1 text-sm">
            {syncLog.map((msg, i) => <li key={i}>{msg}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
