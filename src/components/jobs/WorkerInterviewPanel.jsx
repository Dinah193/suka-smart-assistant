// src/components/jobs/WorkerInterviewPanel.jsx

import React, { useState } from "react";
import { CalendarClock, ThumbsUp, ThumbsDown } from "lucide-react";

const mockInterviewRequests = [
  {
    id: "int-1",
    clientName: "K. Benjamin",
    serviceType: "Housekeeping",
    preferredDate: "2025-06-25",
    preferredTime: "11:00",
    message: "I'd like to interview you about weekly cleaning help for my home.",
  },
  {
    id: "int-2",
    clientName: "M. Elisha",
    serviceType: "Batch Cooking",
    preferredDate: "2025-06-26",
    preferredTime: "15:30",
    message: "Looking for twice-a-week meal prep help. Can we talk?",
  },
];

export default function WorkerInterviewPanel() {
  const [interviewList, setInterviewList] = useState(mockInterviewRequests);
  const [responses, setResponses] = useState({});

  const handleResponse = (id, status) => {
    setResponses((prev) => ({ ...prev, [id]: status }));
  };

  return (
    <div className="p-6 bg-white rounded-lg border border-orange-200 shadow-md">
      <h2 className="text-2xl font-bold text-orange-600 mb-4">
        🎤 Interview Invitations
      </h2>

      {interviewList.length === 0 ? (
        <p className="text-stone-400 italic">No interviews requested at this time.</p>
      ) : (
        interviewList.map((request) => (
          <div
            key={request.id}
            className="mb-5 p-4 border border-stone-200 bg-orange-50 rounded shadow-sm"
          >
            <h3 className="font-semibold text-lg text-stone-700 mb-2">
              {request.clientName} — {request.serviceType}
            </h3>

            <p className="text-sm text-stone-600 mb-2 italic">
              <CalendarClock className="inline mr-1" size={16} />
              {request.preferredDate} at {request.preferredTime}
            </p>

            <p className="mb-3 text-stone-800">{request.message}</p>

            {responses[request.id] ? (
              <div className={`text-sm font-medium ${responses[request.id] === "accepted" ? "text-green-600" : "text-red-500"}`}>
                You have {responses[request.id]} this interview.
              </div>
            ) : (
              <div className="flex gap-4">
                <button
                  onClick={() => handleResponse(request.id, "accepted")}
                  className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded shadow flex items-center gap-1"
                >
                  <ThumbsUp size={16} /> Accept
                </button>
                <button
                  onClick={() => handleResponse(request.id, "declined")}
                  className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded shadow flex items-center gap-1"
                >
                  <ThumbsDown size={16} /> Decline
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
