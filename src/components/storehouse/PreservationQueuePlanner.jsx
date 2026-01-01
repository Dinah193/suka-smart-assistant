// src/components/storehouse/PreservationQueuePlanner.jsx
import React, { useMemo } from "react";
import { useStorehousePlannerStore } from "@/store/StorehousePlannerStore";

export default function PreservationQueuePlanner() {
  // ✅ Subscribe only to the slice we need
  const storehouseNeeds = useStorehousePlannerStore((s) => s.storehouseNeeds);

  // ✅ Derive the queue once per change
  const queue = useMemo(() => {
    const needs = Array.isArray(storehouseNeeds) ? storehouseNeeds : [];
    return needs
      .filter((item) => item.preservation !== "Root Cellar / Dry Storage")
      .map((item) => ({
        ...item,
        status: "Queued",
      }));
  }, [storehouseNeeds]);

  return (
    <div className="p-4 bg-white border border-yellow-300 rounded shadow mt-6">
      <h3 className="text-xl font-semibold text-yellow-700 mb-2">
        🧊 Preservation Queue
      </h3>

      {queue.length === 0 ? (
        <p className="text-stone-500 italic">No items require preservation yet.</p>
      ) : (
        <ul className="space-y-2">
          {queue.map((item, i) => (
            <li
              key={`${item.name}-${i}`}
              className="p-2 border border-yellow-200 rounded bg-yellow-50 flex justify-between"
            >
              <span>
                {item.name} — {Number(item.total ?? 0).toFixed(1)} {item.unit}
              </span>
              <span className="text-yellow-700 font-medium">
                {item.preservation}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
