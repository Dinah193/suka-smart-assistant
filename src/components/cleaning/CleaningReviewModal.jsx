import React, { useState } from "react";
import { Dialog } from "@headlessui/react";
import { X } from "lucide-react";

export default function CleaningReviewModal({
  isOpen,
  onClose,
  sessionPlan,
  onSave,
  onStartNow
}) {
  const [editDateTime, setEditDateTime] = useState(false);
  const [date, setDate] = useState(sessionPlan?.date || "");
  const [time, setTime] = useState(sessionPlan?.time || "");
  const [confirmed, setConfirmed] = useState(false);

  if (!sessionPlan) return null;

  const {
    title,
    locations = [],
    tools = [],
    supplies = [],
    tasks = []
  } = sessionPlan;

  const handleConfirm = () => {
    const updatedSession = {
      ...sessionPlan,
      date,
      time,
    };
    onSave(updatedSession);
    setConfirmed(true);
  };

  return (
    <Dialog open={isOpen} onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <Dialog.Panel className="bg-white w-full max-w-3xl rounded-2xl shadow-xl p-6 space-y-6">
        <div className="flex justify-between items-center border-b pb-3">
          <Dialog.Title className="text-2xl font-bold text-yellow-700">
            {title || "Cleaning Session Review"}
          </Dialog.Title>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-2">
          {/* Session Timing */}
          <section className="space-y-1">
            <h3 className="font-semibold text-yellow-600">🕒 Date & Time</h3>
            {editDateTime ? (
              <div className="flex gap-4">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="border rounded px-2 py-1"
                />
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="border rounded px-2 py-1"
                />
              </div>
            ) : (
              <p className="text-sm text-stone-700">
                {date && time ? `${date} at ${time}` : <em>No time selected</em>}
              </p>
            )}
            <button
              onClick={() => setEditDateTime(!editDateTime)}
              className="text-xs text-blue-600 underline"
            >
              {editDateTime ? "Done Editing" : "Change Time"}
            </button>
          </section>

          {/* Locations */}
          <section>
            <h3 className="font-semibold text-yellow-600 mb-1">🗺 Areas to Clean</h3>
            <ul className="list-disc list-inside text-sm text-stone-700">
              {locations.map((loc, i) => <li key={i}>{loc}</li>)}
            </ul>
          </section>

          {/* Tools */}
          <section>
            <h3 className="font-semibold text-yellow-600 mb-1">🧰 Required Tools</h3>
            <ul className="list-disc list-inside text-sm text-stone-700">
              {tools.map((tool, i) => <li key={i}>{tool}</li>)}
            </ul>
          </section>

          {/* Supplies */}
          <section>
            <h3 className="font-semibold text-yellow-600 mb-1">🧴 Cleaning Supplies</h3>
            <ul className="list-disc list-inside text-sm text-stone-700">
              {supplies.map((supply, i) => <li key={i}>{supply}</li>)}
            </ul>
          </section>

          {/* Tasks */}
          <section>
            <h3 className="font-semibold text-yellow-600 mb-1">✅ Planned Tasks</h3>
            <ul className="list-decimal list-inside text-sm text-stone-700">
              {tasks.map((task, i) => <li key={i}>{task}</li>)}
            </ul>
          </section>
        </div>

        {/* Footer Buttons */}
        <div className="flex justify-between items-center gap-4 pt-4 border-t">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          {!confirmed ? (
            <button
              onClick={handleConfirm}
              className="px-4 py-2 rounded bg-yellow-500 text-white font-semibold hover:bg-yellow-600"
            >
              ✅ Confirm Plan
            </button>
          ) : (
            <button
              onClick={() => onStartNow(sessionPlan)}
              className="px-4 py-2 rounded bg-green-500 text-white font-semibold hover:bg-green-600"
            >
              🚀 Start Now
            </button>
          )}
        </div>
      </Dialog.Panel>
    </Dialog>
  );
}
