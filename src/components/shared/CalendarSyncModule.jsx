// src/components/shared/CalendarSyncModule.jsx

import React, { useState } from "react";
import { CalendarCheck, Link, RefreshCcw } from "lucide-react";

export default function CalendarSyncModule({ onSync, syncStatus = "idle" }) {
  const [calendar, setCalendar] = useState("google");
  const [isEnabled, setIsEnabled] = useState(false);

  const handleSync = () => {
    if (onSync) onSync(calendar, isEnabled);
  };

  return (
    <div className="p-6 bg-white border border-lime-300 rounded-xl shadow-md max-w-2xl">
      <h2 className="text-2xl font-bold mb-4 text-lime-700 flex items-center gap-2">
        <CalendarCheck size={24} /> Calendar Sync
      </h2>

      <div className="space-y-4">
        {/* Select Calendar Platform */}
        <div>
          <label className="block text-sm font-medium mb-1 text-stone-600">Choose Calendar Platform:</label>
          <select
            value={calendar}
            onChange={(e) => setCalendar(e.target.value)}
            className="border border-stone-300 px-3 py-2 rounded w-full"
          >
            <option value="google">Google Calendar</option>
            <option value="apple">Apple Calendar</option>
            <option value="outlook">Outlook Calendar</option>
            <option value="ical">Download .ics file</option>
          </select>
        </div>

        {/* Enable Toggle */}
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(e) => setIsEnabled(e.target.checked)}
            className="form-checkbox text-lime-600"
          />
          <span className="text-stone-700">Enable automatic sync of cooking, cleaning, and booking sessions</span>
        </div>

        {/* Sync Button */}
        <button
          type="button"
          onClick={handleSync}
          className="bg-lime-500 hover:bg-lime-600 text-white px-4 py-2 rounded shadow flex items-center gap-2"
        >
          <Link size={18} /> {syncStatus === "syncing" ? "Syncing..." : "Sync Now"}
        </button>

        {/* Status Message */}
        {syncStatus === "success" && (
          <p className="text-green-600 mt-2">✅ Sync successful. Check your calendar.</p>
        )}
        {syncStatus === "error" && (
          <p className="text-red-600 mt-2">⚠️ Sync failed. Please try again or check your connection.</p>
        )}
      </div>

      {/* ICS Export Option */}
      {calendar === "ical" && (
        <div className="mt-4">
          <a
            href="/api/export-calendar.ics"
            download="suka-village-household-schedule.ics"
            className="inline-block mt-2 text-lime-700 underline hover:text-lime-900"
          >
            📥 Download your household calendar as .ics
          </a>
        </div>
      )}

      {/* Reminder */}
      <div className="mt-6 p-4 bg-lime-100 border border-lime-300 rounded text-sm text-lime-800">
        <RefreshCcw className="inline-block mr-2" size={16} />
        Your events will be synced with your calendar every time you update a session or routine.
      </div>
    </div>
  );
}
