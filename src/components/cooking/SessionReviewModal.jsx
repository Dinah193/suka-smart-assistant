import React, { useState } from "react";
import { X, CalendarDays, Clock, CheckCircle } from "lucide-react";

export default function SessionReviewModal({
  isOpen,
  onClose,
  recipes = [],
  tools = [],
  ingredients = [],
  timers = [],
  onConfirm,
}) {
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (!scheduledDate || !scheduledTime) return alert("Select a date and time.");
    const sessionDetails = {
      scheduledDate,
      scheduledTime,
      recipes,
      tools,
      ingredients,
      timers,
    };
    onConfirm(sessionDetails);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-center items-center">
      <div className="bg-white w-full max-w-3xl p-6 rounded-xl shadow-xl relative overflow-y-auto max-h-[90vh]">
        {/* Close Button */}
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-500 hover:text-red-500">
          <X size={24} />
        </button>

        <h2 className="text-2xl font-bold text-orange-700 mb-4">
          🍳 Review Your Cooking Session
        </h2>

        {/* Scheduled Time */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <label className="flex items-center gap-2 w-full sm:w-1/2">
            <CalendarDays size={20} />
            <input
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
              className="border border-stone-300 px-3 py-2 rounded w-full"
            />
          </label>
          <label className="flex items-center gap-2 w-full sm:w-1/2">
            <Clock size={20} />
            <input
              type="time"
              value={scheduledTime}
              onChange={(e) => setScheduledTime(e.target.value)}
              className="border border-stone-300 px-3 py-2 rounded w-full"
            />
          </label>
        </div>

        {/* Recipes */}
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-orange-600 mb-2">📋 Recipes</h3>
          <ul className="list-disc ml-6 space-y-1 text-stone-700">
            {recipes.map((r) => (
              <li key={r.id}>{r.name}</li>
            ))}
          </ul>
        </div>

        {/* Tools */}
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-orange-600 mb-2">🛠 Tools Required</h3>
          <ul className="list-disc ml-6 space-y-1 text-stone-700">
            {tools.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>

        {/* Ingredients */}
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-orange-600 mb-2">🥕 Ingredients</h3>
          <ul className="list-disc ml-6 space-y-1 text-stone-700">
            {ingredients.map((ing, i) => (
              <li key={i}>{ing}</li>
            ))}
          </ul>
        </div>

        {/* Timers */}
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-orange-600 mb-2">⏱ Timers</h3>
          <ul className="space-y-1 text-stone-700">
            {timers.map((t, i) => (
              <li key={i}>Step: <strong>{t.label}</strong> – {t.minutes} min</li>
            ))}
          </ul>
        </div>

        {/* Confirm Button */}
        <button
          onClick={handleConfirm}
          className="bg-green-600 hover:bg-green-700 text-white font-semibold px-5 py-3 rounded w-full flex items-center justify-center gap-2"
        >
          <CheckCircle size={20} />
          Confirm & Schedule Session
        </button>
      </div>
    </div>
  );
}
