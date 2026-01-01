// src/components/workers/RecurringAvailabilitySetup.jsx

import React, { useState } from "react";
import { Clock, CalendarDays, Save } from "lucide-react";

const defaultWeekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function RecurringAvailabilitySetup({ onSubmit }) {
  const [availability, setAvailability] = useState(() =>
    defaultWeekdays.reduce((acc, day) => {
      acc[day] = { start: "", end: "" };
      return acc;
    }, {})
  );

  const handleTimeChange = (day, type, value) => {
    setAvailability((prev) => ({
      ...prev,
      [day]: {
        ...prev[day],
        [type]: value,
      },
    }));
  };

  const handleSave = () => {
    if (onSubmit) onSubmit(availability);
    alert("Availability saved!");
  };

  return (
    <div className="p-6 bg-white border border-emerald-300 rounded-lg shadow-md max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold text-emerald-700 mb-4 flex items-center gap-2">
        <CalendarDays size={24} /> Recurring Availability Setup
      </h2>

      <p className="text-stone-600 mb-6 text-sm">
        Set the weekly schedule during which you're available for bookings. These time slots can be matched with cleaning or cooking sessions.
      </p>

      <div className="space-y-4">
        {defaultWeekdays.map((day) => (
          <div
            key={day}
            className="flex items-center gap-4 justify-between border border-stone-200 rounded p-3"
          >
            <span className="font-medium w-24 text-stone-700">{day}</span>
            <input
              type="time"
              value={availability[day].start}
              onChange={(e) => handleTimeChange(day, "start", e.target.value)}
              className="border border-stone-300 px-3 py-2 rounded w-[120px]"
              placeholder="Start"
            />
            <span className="text-stone-400">to</span>
            <input
              type="time"
              value={availability[day].end}
              onChange={(e) => handleTimeChange(day, "end", e.target.value)}
              className="border border-stone-300 px-3 py-2 rounded w-[120px]"
              placeholder="End"
            />
          </div>
        ))}
      </div>

      <button
        onClick={handleSave}
        className="mt-6 bg-emerald-500 hover:bg-emerald-600 text-white px-6 py-2 rounded flex items-center gap-2"
      >
        <Save size={18} /> Save Availability
      </button>
    </div>
  );
}
