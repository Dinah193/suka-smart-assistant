import React, { useState } from "react";
import { CalendarCheck, Repeat, Send } from "lucide-react";

const providers = ["Sister Tamar", "House of Hadassah Services", "Brother Elam"];
const serviceTypes = ["Meal Prep", "Deep Cleaning", "Laundry Folding", "Kitchen Maintenance", "Sabbath Meals"];

export default function RecurringBookingForm({ onSubmit }) {
  const [form, setForm] = useState({
    provider: "",
    serviceType: "",
    startDate: "",
    time: "",
    frequency: "weekly",
    notes: "",
  });

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (onSubmit) onSubmit(form);
    alert("Recurring booking request submitted!");
    setForm({
      provider: "",
      serviceType: "",
      startDate: "",
      time: "",
      frequency: "weekly",
      notes: "",
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="p-6 bg-white rounded-xl border border-blue-200 shadow-md"
    >
      <h2 className="text-2xl font-bold text-blue-700 mb-4 flex items-center gap-2">
        <Repeat size={24} />
        Schedule Recurring Help
      </h2>

      {/* Provider Selection */}
      <label className="block mb-2 text-sm font-semibold">Choose Provider</label>
      <select
        name="provider"
        value={form.provider}
        onChange={handleChange}
        required
        className="w-full border border-stone-300 p-2 rounded mb-4"
      >
        <option value="">-- Select a Provider --</option>
        {providers.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>

      {/* Service Type */}
      <label className="block mb-2 text-sm font-semibold">Service Type</label>
      <select
        name="serviceType"
        value={form.serviceType}
        onChange={handleChange}
        required
        className="w-full border border-stone-300 p-2 rounded mb-4"
      >
        <option value="">-- Select a Service --</option>
        {serviceTypes.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      {/* Start Date */}
      <label className="block mb-2 text-sm font-semibold">Start Date</label>
      <input
        type="date"
        name="startDate"
        value={form.startDate}
        onChange={handleChange}
        required
        className="w-full border border-stone-300 p-2 rounded mb-4"
      />

      {/* Time */}
      <label className="block mb-2 text-sm font-semibold">Preferred Time</label>
      <input
        type="time"
        name="time"
        value={form.time}
        onChange={handleChange}
        required
        className="w-full border border-stone-300 p-2 rounded mb-4"
      />

      {/* Frequency */}
      <label className="block mb-2 text-sm font-semibold">Frequency</label>
      <select
        name="frequency"
        value={form.frequency}
        onChange={handleChange}
        className="w-full border border-stone-300 p-2 rounded mb-4"
      >
        <option value="weekly">Weekly</option>
        <option value="biweekly">Every 2 Weeks</option>
        <option value="monthly">Monthly</option>
      </select>

      {/* Notes */}
      <label className="block mb-2 text-sm font-semibold">Notes for Provider</label>
      <textarea
        name="notes"
        value={form.notes}
        onChange={handleChange}
        placeholder="Any details about your home, food preferences, access instructions, etc."
        rows={3}
        className="w-full border border-stone-300 p-2 rounded mb-6"
      />

      {/* Submit */}
      <button
        type="submit"
        className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded flex items-center gap-2"
      >
        <Send size={18} />
        Submit Booking Request
      </button>
    </form>
  );
}
