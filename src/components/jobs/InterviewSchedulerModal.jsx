// src/components/jobs/InterviewSchedulerModal.jsx

import React, { useState } from "react";
import { Dialog } from "@headlessui/react";
import { CalendarDays, Clock, CheckCircle2, XCircle } from "lucide-react";

export default function InterviewSchedulerModal({ isOpen, onClose, worker, onSchedule }) {
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const handleSchedule = () => {
    if (selectedDate && selectedTime) {
      const scheduledInterview = {
        workerId: worker?.id,
        name: worker?.name,
        date: selectedDate,
        time: selectedTime,
      };
      onSchedule(scheduledInterview);
      setConfirmed(true);
    }
  };

  const resetState = () => {
    setSelectedDate("");
    setSelectedTime("");
    setConfirmed(false);
    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={resetState} className="relative z-50">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="bg-white p-6 rounded-lg shadow-lg w-full max-w-md border border-yellow-300">
          <Dialog.Title className="text-xl font-bold text-yellow-700 mb-3">
            🗓 Interview {worker?.name}
          </Dialog.Title>

          {!confirmed ? (
            <>
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <CalendarDays size={20} className="text-yellow-600" />
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="border border-stone-300 rounded px-3 py-2 w-full"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Clock size={20} className="text-yellow-600" />
                  <input
                    type="time"
                    value={selectedTime}
                    onChange={(e) => setSelectedTime(e.target.value)}
                    className="border border-stone-300 rounded px-3 py-2 w-full"
                  />
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={resetState}
                  className="text-red-500 hover:text-red-600 flex items-center gap-1"
                >
                  <XCircle size={18} /> Cancel
                </button>
                <button
                  onClick={handleSchedule}
                  className="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded flex items-center gap-1"
                  disabled={!selectedDate || !selectedTime}
                >
                  <CheckCircle2 size={18} /> Confirm
                </button>
              </div>
            </>
          ) : (
            <div className="text-center text-green-700">
              <CheckCircle2 size={48} className="mx-auto mb-3" />
              <p className="text-lg font-medium">Interview Scheduled!</p>
              <p className="text-sm mt-2">
                You’ll meet <strong>{worker?.name}</strong> on{" "}
                <strong>{selectedDate}</strong> at <strong>{selectedTime}</strong>.
              </p>
              <button
                onClick={resetState}
                className="mt-5 bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded"
              >
                Done
              </button>
            </div>
          )}
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
