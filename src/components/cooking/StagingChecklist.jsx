import React, { useState, useEffect } from "react";
import { CheckCircle, AlertCircle } from "lucide-react";

export default function StagingChecklist({ session }) {
  const [checklist, setChecklist] = useState([]);

  useEffect(() => {
    if (session?.tools?.length) {
      const formatted = session.tools.map((tool) => ({
        name: tool,
        checked: false
      }));
      setChecklist(formatted);
    }
  }, [session]);

  const toggleItem = (index) => {
    const updated = [...checklist];
    updated[index].checked = !updated[index].checked;
    setChecklist(updated);
  };

  const progress = checklist.length
    ? Math.round((checklist.filter(i => i.checked).length / checklist.length) * 100)
    : 0;

  return (
    <div className="bg-white rounded-xl shadow-md border border-orange-300 p-6 mb-6">
      <h2 className="text-xl font-bold text-orange-700 mb-4 flex items-center gap-2">
        🧰 Equipment & Tool Staging Checklist
      </h2>

      {/* Progress Bar */}
      <div className="mb-4">
        <div className="h-4 w-full bg-stone-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-orange-500 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="text-sm text-stone-600 mt-1">
          {progress}% staged
        </p>
      </div>

      {/* Checklist */}
      {checklist.length === 0 ? (
        <div className="flex items-center gap-2 text-stone-500 italic">
          <AlertCircle size={18} />
          No tools loaded. Select a cooking session first.
        </div>
      ) : (
        <ul className="space-y-3">
          {checklist.map((item, idx) => (
            <li
              key={idx}
              className={`flex items-center justify-between p-3 rounded border ${
                item.checked ? "bg-green-50 border-green-300" : "bg-orange-50 border-orange-200"
              }`}
            >
              <span className="text-stone-700 font-medium">{item.name}</span>
              <button
                onClick={() => toggleItem(idx)}
                className={`px-3 py-1 rounded text-sm font-semibold transition ${
                  item.checked
                    ? "bg-green-600 text-white hover:bg-green-700"
                    : "bg-orange-600 text-white hover:bg-orange-700"
                }`}
              >
                {item.checked ? "✔ Staged" : "Stage"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
