// src/layout/SidebarButton.jsx
import React from "react";
import { useNavigate, useLocation } from "react-router-dom";

export default function SidebarButton({ to, label, icon }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isActive = location.pathname === to;

  return (
    <button
      onClick={() => navigate(to)}
      className={`w-full flex items-center gap-3 px-4 py-3 my-2 rounded-full shadow-md transition-all duration-200 text-sm font-bold border-4
        ${isActive
          ? "bg-yellow-300 border-white text-pink-700 scale-105"
          : "bg-orange-500 border-white text-white hover:bg-orange-600 hover:scale-105"}`}
      style={{ boxShadow: "0 4px 8px rgba(0,0,0,0.25)" }}
    >
      <div className="bg-white text-orange-600 rounded-full p-2">{icon}</div>
      <span className="flex-1 text-left">{label}</span>
    </button>
  );
}
