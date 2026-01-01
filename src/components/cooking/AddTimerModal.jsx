import React, { useState } from "react";
import { X } from "lucide-react";
import { createTimer } from "@/store/MultiTimerManager"; // ✅ Adjust the import if needed

export default function AddTimerModal({ onClose }) {
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState(1);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!label || minutes <= 0) return;

    const id = Date.now(); // Unique ID for this timer
    const duration = minutes * 60;

    createTimer(id, label, duration); // ✅ Save directly to timer store
    onClose(); // ✅ Close modal
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center">
      <div className="bg-white w-full max-w-md rounded-lg shadow-xl p-6 border-2 border-orange-400">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-orange-700">🆕 Add Cooking Step Timer</h2>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-800">
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-stone-600 mb-1">Step Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Simmer sauce"
              className="w-full border border-stone-300 rounded px-3 py-2"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-stone-600 mb-1">Duration (minutes)</label>
            <input
              type="number"
              min="1"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="w-full border border-stone-300 rounded px-3 py-2"
              required
            />
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              className="bg-orange-600 text-white font-semibold px-5 py-2 rounded hover:bg-orange-700"
            >
              ➕ Add Timer
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
