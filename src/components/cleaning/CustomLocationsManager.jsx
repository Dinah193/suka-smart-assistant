import React, { useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, Edit2, Save } from "lucide-react";

export default function CustomLocationsManager() {
  const [locations, setLocations] = useState([
    "Living Room",
    "Bathroom",
    "Kitchen"
  ]);
  const [newLocation, setNewLocation] = useState("");
  const [editingIndex, setEditingIndex] = useState(null);
  const [editedValue, setEditedValue] = useState("");

  const addLocation = () => {
    if (newLocation.trim()) {
      setLocations([...locations, newLocation.trim()]);
      setNewLocation("");
    }
  };

  const deleteLocation = (index) => {
    const updated = [...locations];
    updated.splice(index, 1);
    setLocations(updated);
  };

  const moveUp = (index) => {
    if (index > 0) {
      const updated = [...locations];
      [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
      setLocations(updated);
    }
  };

  const moveDown = (index) => {
    if (index < locations.length - 1) {
      const updated = [...locations];
      [updated[index + 1], updated[index]] = [updated[index], updated[index + 1]];
      setLocations(updated);
    }
  };

  const startEditing = (index) => {
    setEditingIndex(index);
    setEditedValue(locations[index]);
  };

  const saveEdit = (index) => {
    const updated = [...locations];
    updated[index] = editedValue;
    setLocations(updated);
    setEditingIndex(null);
    setEditedValue("");
  };

  return (
    <div className="bg-white p-4 rounded-xl shadow space-y-4 border border-yellow-200">
      <h2 className="text-xl font-bold text-yellow-700">🏠 Custom Cleaning Areas</h2>

      {/* Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newLocation}
          onChange={(e) => setNewLocation(e.target.value)}
          placeholder="e.g. Laundry Room, Porch, Closet"
          className="flex-1 border border-stone-300 px-3 py-2 rounded shadow-sm"
        />
        <button
          onClick={addLocation}
          className="bg-yellow-500 text-white px-4 py-2 rounded hover:bg-yellow-600"
        >
          <Plus size={20} />
        </button>
      </div>

      {/* List */}
      <ul className="space-y-2">
        {locations.map((loc, index) => (
          <li
            key={index}
            className="flex justify-between items-center border px-3 py-2 rounded bg-yellow-50 shadow-sm"
          >
            {editingIndex === index ? (
              <input
                value={editedValue}
                onChange={(e) => setEditedValue(e.target.value)}
                className="flex-1 mr-2 border border-yellow-300 rounded px-2 py-1"
              />
            ) : (
              <span className="text-stone-800 font-medium">{loc}</span>
            )}

            <div className="flex gap-2 ml-4">
              <button onClick={() => moveUp(index)} title="Move Up">
                <ArrowUp size={18} />
              </button>
              <button onClick={() => moveDown(index)} title="Move Down">
                <ArrowDown size={18} />
              </button>
              {editingIndex === index ? (
                <button onClick={() => saveEdit(index)} title="Save">
                  <Save size={18} className="text-green-600" />
                </button>
              ) : (
                <button onClick={() => startEditing(index)} title="Edit">
                  <Edit2 size={18} />
                </button>
              )}
              <button onClick={() => deleteLocation(index)} title="Delete">
                <Trash2 size={18} className="text-red-500" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
