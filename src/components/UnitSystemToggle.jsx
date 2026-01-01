// src/components/UnitSystemToggle.jsx
import React from "react";
import { UnitSystem } from "@/utils/units";

const KEY = "suka.unitSystem";

export default function UnitSystemToggle({ value, onChange }) {
  const current = value || localStorage.getItem(KEY) || UnitSystem.STANDARD;
  const next = current === UnitSystem.STANDARD ? UnitSystem.METRIC : UnitSystem.STANDARD;

  function handleToggle() {
    localStorage.setItem(KEY, next);
    onChange?.(next);
  }

  return (
    <button
      onClick={handleToggle}
      className="px-3 py-2 rounded-xl shadow text-sm font-medium border hover:shadow-md transition"
      title="Switch unit system"
    >
      {current === UnitSystem.STANDARD ? "Standard (US) • click → Metric" : "Metric • click → Standard"}
    </button>
  );
}

export function getSavedUnitSystem() {
  return localStorage.getItem(KEY) || UnitSystem.STANDARD;
}
