// src/components/meals/SeedAnimalInventoryForm.jsx

import React, { useState } from "react";
import { PlusCircle, Save, XCircle } from "lucide-react";

export default function SeedAnimalInventoryForm({ onSubmit }) {
  const [entries, setEntries] = useState([
    { type: "seed", name: "", variety: "", quantity: "", unit: "", notes: "" },
  ]);

  const handleChange = (index, field, value) => {
    const updated = [...entries];
    updated[index][field] = value;
    setEntries(updated);
  };

  const handleAddRow = () => {
    setEntries([
      ...entries,
      { type: "seed", name: "", variety: "", quantity: "", unit: "", notes: "" },
    ]);
  };

  const handleRemoveRow = (index) => {
    const updated = entries.filter((_, i) => i !== index);
    setEntries(updated);
  };

  const handleSave = () => {
    if (onSubmit) {
      onSubmit(entries);
    }
    alert("Inventory submitted!");
  };

  return (
    <div className="p-6 bg-white rounded-xl border border-green-400 shadow-md max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold text-green-800 mb-4">
        🌱 Seed & 🐑 Animal Inventory Form
      </h2>

      <div className="overflow-x-auto">
        <table className="min-w-full table-auto border-collapse border border-green-300">
          <thead className="bg-green-100">
            <tr>
              <th className="border border-green-300 px-3 py-2">Type</th>
              <th className="border border-green-300 px-3 py-2">Name</th>
              <th className="border border-green-300 px-3 py-2">Variety/Breed</th>
              <th className="border border-green-300 px-3 py-2">Quantity</th>
              <th className="border border-green-300 px-3 py-2">Unit</th>
              <th className="border border-green-300 px-3 py-2">Notes</th>
              <th className="border border-green-300 px-3 py-2">Remove</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, idx) => (
              <tr key={idx} className="bg-green-50">
                <td className="border border-green-300 px-2 py-1">
                  <select
                    value={entry.type}
                    onChange={(e) => handleChange(idx, "type", e.target.value)}
                    className="w-full p-1 rounded"
                  >
                    <option value="seed">Seed</option>
                    <option value="animal">Animal</option>
                  </select>
                </td>
                <td className="border border-green-300 px-2 py-1">
                  <input
                    type="text"
                    value={entry.name}
                    onChange={(e) => handleChange(idx, "name", e.target.value)}
                    className="w-full p-1 rounded"
                  />
                </td>
                <td className="border border-green-300 px-2 py-1">
                  <input
                    type="text"
                    value={entry.variety}
                    onChange={(e) => handleChange(idx, "variety", e.target.value)}
                    className="w-full p-1 rounded"
                  />
                </td>
                <td className="border border-green-300 px-2 py-1">
                  <input
                    type="number"
                    value={entry.quantity}
                    onChange={(e) => handleChange(idx, "quantity", e.target.value)}
                    className="w-full p-1 rounded"
                  />
                </td>
                <td className="border border-green-300 px-2 py-1">
                  <input
                    type="text"
                    value={entry.unit}
                    onChange={(e) => handleChange(idx, "unit", e.target.value)}
                    className="w-full p-1 rounded"
                  />
                </td>
                <td className="border border-green-300 px-2 py-1">
                  <input
                    type="text"
                    value={entry.notes}
                    onChange={(e) => handleChange(idx, "notes", e.target.value)}
                    className="w-full p-1 rounded"
                  />
                </td>
                <td className="border border-green-300 px-2 py-1 text-center">
                  <button onClick={() => handleRemoveRow(idx)} className="text-red-500 hover:text-red-700">
                    <XCircle size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex gap-4">
        <button
          onClick={handleAddRow}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-green-500 text-white rounded hover:bg-green-600"
        >
          <PlusCircle size={16} />
          Add Entry
        </button>
        <button
          onClick={handleSave}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-green-700 text-white rounded hover:bg-green-800"
        >
          <Save size={16} />
          Save Inventory
        </button>
      </div>
    </div>
  );
}
