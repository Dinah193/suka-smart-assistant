import React from "react";

export default function PreservationTaskCard({ task, onComplete }) {
  return (
    <article className="rounded-lg border border-sky-200 bg-sky-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="font-medium text-sky-900">{task.title}</h4>
        <span className="text-xs text-sky-700">{task.method}</span>
      </div>

      <p className="text-sm text-sky-800">
        Prep reduction: {task.prepReductionMinutes || 0} min, Cook reduction: {task.cookReductionMinutes || 0} min
      </p>

      <p className="mt-1 text-xs text-sky-700">
        Collaboration: {task.collaborationHint || "Local household first"}
      </p>

      <button
        type="button"
        onClick={() => onComplete?.(task)}
        className="mt-3 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
      >
        Mark Complete
      </button>
    </article>
  );
}
