// src/components/workers/WorkerProfileCard.jsx

import React from "react";
import { CalendarCheck2, Clock3, MapPin, PhoneCall, Star } from "lucide-react";

export default function WorkerProfileCard({ worker, onInterview, onBook }) {
  const {
    name,
    photo,
    role,
    rating,
    location,
    hourlyRate,
    availabilitySummary,
    contact,
    specialties = [],
  } = worker;

  return (
    <div className="bg-white border border-stone-200 rounded-xl shadow p-5 flex flex-col sm:flex-row gap-6 items-start">
      {/* Worker Photo */}
      <div className="w-32 h-32 rounded-full overflow-hidden border-4 border-yellow-300">
        <img
          src={photo}
          alt={`${name} profile`}
          className="w-full h-full object-cover"
        />
      </div>

      {/* Worker Details */}
      <div className="flex-1 space-y-2">
        <h2 className="text-xl font-bold text-yellow-700">{name}</h2>
        <p className="text-stone-600 italic">{role}</p>

        <div className="flex items-center gap-2 text-sm text-yellow-600">
          <Star size={16} className="text-yellow-500" />
          <span>{rating} stars</span>
        </div>

        <div className="flex items-center gap-2 text-sm text-stone-500">
          <MapPin size={16} /> {location}
        </div>

        <div className="flex items-center gap-2 text-sm text-stone-500">
          <Clock3 size={16} /> ${hourlyRate}/hr
        </div>

        {availabilitySummary && (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <CalendarCheck2 size={16} />
            <span>{availabilitySummary}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mt-2">
          {specialties.map((tag) => (
            <span
              key={tag}
              className="px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 text-xs font-medium border border-yellow-300"
            >
              {tag}
            </span>
          ))}
        </div>

        {contact && (
          <div className="flex items-center gap-2 text-sm text-blue-600 mt-2">
            <PhoneCall size={16} /> {contact}
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-3 mt-4">
          <button
            onClick={() => onInterview?.(worker)}
            className="bg-blue-500 hover:bg-blue-600 text-white text-sm px-4 py-2 rounded shadow"
          >
            🎙 Interview
          </button>
          <button
            onClick={() => onBook?.(worker)}
            className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm px-4 py-2 rounded shadow"
          >
            📅 Book
          </button>
        </div>
      </div>
    </div>
  );
}
