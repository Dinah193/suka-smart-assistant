// src/components/shared/AlertSettingsForm.jsx

import React, { useState } from "react";

export default function AlertSettingsForm({ initialSettings = {}, onSave }) {
  const [settings, setSettings] = useState({
    sessionReminders: initialSettings.sessionReminders ?? true,
    bookingUpdates: initialSettings.bookingUpdates ?? true,
    inventoryLow: initialSettings.inventoryLow ?? true,
    ecoTips: initialSettings.ecoTips ?? false,
    deliveryReminders: initialSettings.deliveryReminders ?? true,
  });

  const handleChange = (e) => {
    const { name, checked } = e.target;
    setSettings((prev) => ({ ...prev, [name]: checked }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (onSave) onSave(settings);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="p-6 bg-white border border-orange-300 rounded-xl shadow-md max-w-2xl"
    >
      <h2 className="text-2xl font-bold mb-4 text-orange-700">🔔 Alert & Notification Settings</h2>

      <div className="space-y-4">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            name="sessionReminders"
            checked={settings.sessionReminders}
            onChange={handleChange}
            className="form-checkbox text-orange-600"
          />
          Remind me before cooking or cleaning sessions
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            name="bookingUpdates"
            checked={settings.bookingUpdates}
            onChange={handleChange}
            className="form-checkbox text-orange-600"
          />
          Notify me of worker booking confirmations or changes
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            name="inventoryLow"
            checked={settings.inventoryLow}
            onChange={handleChange}
            className="form-checkbox text-orange-600"
          />
          Alert me when cleaning or food supplies are low
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            name="ecoTips"
            checked={settings.ecoTips}
            onChange={handleChange}
            className="form-checkbox text-orange-600"
          />
          Send eco-friendly tips weekly
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            name="deliveryReminders"
            checked={settings.deliveryReminders}
            onChange={handleChange}
            className="form-checkbox text-orange-600"
          />
          Remind me of upcoming food deliveries or recurring housekeeping
        </label>
      </div>

      <button
        type="submit"
        className="mt-6 bg-orange-500 text-white py-2 px-5 rounded hover:bg-orange-600 shadow"
      >
        ✅ Save Alert Preferences
      </button>
    </form>
  );
}
