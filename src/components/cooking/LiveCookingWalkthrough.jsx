// src/components/cooking/LiveCookingWalkthrough.jsx

import React, { useState } from "react";
import BatchSessionPlanner from "./BatchSessionPlanner";

export default function LiveCookingWalkthrough({ selectedRecipes = [], onExit }) {
  const [completedSteps, setCompletedSteps] = useState([]);

  const handleStepComplete = (step) => {
    setCompletedSteps((prev) => [...prev, step]);
  };

  return (
    <div className="fixed inset-0 bg-white z-50 overflow-y-auto p-8">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-rose-800">
          🍳 Live Batch Cooking Session
        </h1>
        <button
          onClick={onExit}
          className="bg-stone-300 hover:bg-stone-400 px-4 py-2 rounded text-stone-800 font-semibold"
        >
          ✖ Exit Session
        </button>
      </div>

      {/* Batch Session Planner (step walkthrough with timers + audio) */}
      <BatchSessionPlanner
        batchRecipes={selectedRecipes}
        onStepComplete={handleStepComplete}
      />

      {/* Completed Step Log */}
      <div className="mt-6 p-4 bg-rose-100 border border-rose-200 rounded">
        <h2 className="text-lg font-semibold text-rose-700">✅ Completed Steps</h2>
        <ul className="list-disc list-inside text-stone-700 text-sm mt-2">
          {completedSteps.map((step, index) => (
            <li key={index}>
              <strong>{step.recipeName}:</strong> {step.description}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
