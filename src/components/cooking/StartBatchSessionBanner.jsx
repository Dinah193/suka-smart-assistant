// src/components/cooking/StartBatchSessionBanner.jsx
import React from "react";
import { useNavigate } from "react-router-dom";

export default function StartBatchSessionBanner() {
  const navigate = useNavigate();

  return (
    <div className="relative bg-pink-600 text-white px-6 py-4 mt-4 rounded-xl shadow-lg border-4 border-yellow-300 hover:scale-105 transition-all duration-300">
      <div className="flex items-center justify-between">
        <div className="text-lg md:text-xl font-extrabold uppercase tracking-wide">
          Ready to Cook?
        </div>
        <button
          onClick={() => navigate("/cooking")}
          className="bg-white text-pink-700 font-bold px-4 py-2 rounded-full shadow-md hover:bg-yellow-300 hover:text-pink-800 transition"
        >
          Start Batch Cooking
        </button>
      </div>
    </div>
  );
}
