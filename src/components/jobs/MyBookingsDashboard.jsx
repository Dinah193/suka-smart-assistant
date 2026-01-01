import React, { useState, useEffect } from "react";
import { CalendarDays, Clock, RefreshCw, CheckCircle, XCircle } from "lucide-react";

const mockBookings = [
  {
    id: 1,
    type: "Meal Prep",
    provider: "Sister Tamar",
    date: "2025-06-25",
    time: "10:00 AM",
    status: "Upcoming",
    recurring: true,
  },
  {
    id: 2,
    type: "Deep Cleaning",
    provider: "House of Hadassah Services",
    date: "2025-06-18",
    time: "2:00 PM",
    status: "Completed",
    recurring: false,
  },
  {
    id: 3,
    type: "Laundry Folding",
    provider: "Brother Elam",
    date: "2025-06-28",
    time: "9:30 AM",
    status: "Upcoming",
    recurring: false,
  },
];

export default function MyBookingsDashboard() {
  const [bookings, setBookings] = useState([]);

  useEffect(() => {
    // Replace with API call later
    setBookings(mockBookings);
  }, []);

  return (
    <div className="p-6 bg-white border border-stone-200 rounded-xl shadow">
      <h2 className="text-2xl font-bold mb-4 text-amber-700">📅 My Household Bookings</h2>

      {bookings.length === 0 ? (
        <p className="text-stone-400 italic">You have no current or past bookings.</p>
      ) : (
        <div className="space-y-4">
          {bookings.map((booking) => (
            <div
              key={booking.id}
              className={`p-4 rounded border ${
                booking.status === "Completed"
                  ? "bg-green-50 border-green-300"
                  : "bg-yellow-50 border-yellow-300"
              }`}
            >
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-lg font-semibold text-stone-800 flex items-center gap-2">
                  🧺 {booking.type}
                </h3>
                {booking.status === "Completed" ? (
                  <CheckCircle className="text-green-600" />
                ) : (
                  <Clock className="text-yellow-600" />
                )}
              </div>
              <p className="text-sm text-stone-600 mb-1">
                <CalendarDays className="inline-block mr-1" size={16} />
                <strong>{booking.date}</strong> at <strong>{booking.time}</strong>
              </p>
              <p className="text-sm text-stone-500 mb-2">Provider: {booking.provider}</p>
              {booking.recurring && (
                <div className="flex items-center text-xs text-indigo-600 gap-1">
                  <RefreshCw size={14} />
                  Recurring booking
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
