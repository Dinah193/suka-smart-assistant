import React from "react";

export default function GardenSchedule({ tasks = [] }) {
  return (
    <section className="rounded-xl border border-lime-200 bg-white p-4">
      <h3 className="mb-2 text-base font-semibold text-lime-900">Garden + Orchard Schedule</h3>
      <ul className="space-y-2 text-sm text-lime-800">
        {tasks.map((task) => (
          <li key={task.id || task.title} className="rounded-md bg-lime-50 p-2">
            <div className="font-medium">{task.title}</div>
            <div className="text-xs">{task.when || "Schedule window pending"}</div>
          </li>
        ))}
        {!tasks.length ? <li>No tasks scheduled yet.</li> : null}
      </ul>
    </section>
  );
}
