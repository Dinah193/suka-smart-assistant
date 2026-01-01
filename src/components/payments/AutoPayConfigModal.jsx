// src/components/payments/AutoPayConfigModal.jsx

import React, { useState } from "react";
import { X, CalendarDays, DollarSign } from "lucide-react";

export default function AutoPayConfigModal({ isOpen, onClose, onSave }) {
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [startDate, setStartDate] = useState("");

  const handleSubmit = () => {
    if (!amount || !startDate) return;
    onSave({ amount, frequency, startDate });
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-40 flex items-center justify-center">
      <div className="bg-white rounded-lg p-6 w-full max-w-md shadow-xl border border-orange-300 relative">
        <button
          onClick={onClose}
          className="absolute top-2 right-2 text-stone-500 hover:text-stone-700"
        >
          <X size={20} />
        </button>

        <h2 className="text-2xl font-bold text-orange-600 mb-4">
          🔁 AutoPay Setup
        </h2>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-1 text-stone-700">
            💵 Amount per Session
          </label>
          <div className="relative">
            <span className="absolute left-2 top-2.5 text-stone-400">
              <DollarSign size={16} />
            </span>
            <input
              type="number"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 85"
              className="pl-8 pr-3 py-2 w-full border border-stone-300 rounded"
            />
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-1 text-stone-700">
            📅 Payment Frequency
          </label>
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            className="w-full border border-stone-300 px-3 py-2 rounded"
          >
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>

        <div className="mb-5">
          <label className="block text-sm font-medium mb-1 text-stone-700">
            ⏳ Start Date
          </label>
          <div className="relative">
            <span className="absolute left-2 top-2.5 text-stone-400">
              <CalendarDays size={16} />
            </span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="pl-8 pr-3 py-2 w-full border border-stone-300 rounded"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={handleSubmit}
            className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded shadow"
          >
            💳 Confirm AutoPay
          </button>
        </div>
      </div>
    </div>
  );
}
