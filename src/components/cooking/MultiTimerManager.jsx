import React, { useState, useEffect } from "react";
import { Timer, PlayCircle, PauseCircle, XCircle, AlarmClock } from "lucide-react";
import AddTimerModal from "./AddTimerModal";

export default function MultiTimerManager() {
  const [timers, setTimers] = useState([]);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setTimers((prevTimers) =>
        prevTimers.map((t) => {
          if (t.running && t.remaining > 0) {
            return { ...t, remaining: t.remaining - 1 };
          }
          return t;
        })
      );
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const addTimer = (step) => {
    setTimers([
      ...timers,
      {
        id: Date.now(),
        label: step.label,
        duration: step.duration,
        remaining: step.duration,
        running: false,
      },
    ]);
  };

  const toggleTimer = (id) => {
    setTimers((prev) =>
      prev.map((t) => (t.id === id ? { ...t, running: !t.running } : t))
    );
  };

  const removeTimer = (id) => {
    setTimers((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="flex w-full h-full">
      {/* Sidebar */}
      <aside className="w-72 p-5 bg-orange-50 border-r border-orange-200">
        <h2 className="text-xl font-bold text-orange-700 mb-4">⏱ Cooking Step Timers</h2>
        <button
          className="w-full bg-orange-600 text-white py-2 rounded hover:bg-orange-700 flex items-center justify-center gap-2"
          onClick={() => setShowModal(true)}
        >
          ➕ Add Timer
        </button>
        <ul className="mt-4 space-y-3 text-sm">
          {timers.map((t) => (
            <li
              key={t.id}
              className="p-3 bg-white border border-orange-200 rounded shadow flex flex-col"
            >
              <div className="font-semibold text-stone-700">{t.label}</div>
              <div className="text-orange-600 font-mono text-lg">{formatTime(t.remaining)}</div>
              <div className="flex justify-between mt-2 text-sm text-orange-700">
                <button onClick={() => toggleTimer(t.id)}>
                  {t.running ? <PauseCircle size={18} /> : <PlayCircle size={18} />}
                </button>
                <button onClick={() => removeTimer(t.id)}>
                  <XCircle size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </aside>

      {/* Main Section */}
      <main className="flex-1 p-6 bg-white overflow-y-auto">
        <h3 className="text-lg font-semibold text-orange-800 mb-3 flex items-center gap-2">
          <AlarmClock size={20} /> Live Timer View
        </h3>

        {timers.length === 0 ? (
          <p className="text-stone-400 italic">No timers running. Add one from the sidebar.</p>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            {timers.map((t) => (
              <div key={t.id} className="p-5 bg-orange-100 border border-orange-300 rounded shadow">
                <h4 className="font-bold text-orange-800 text-md">{t.label}</h4>
                <div className="text-2xl font-mono mt-1 mb-2 text-orange-900">{formatTime(t.remaining)}</div>
                <div className="w-full bg-white h-3 rounded overflow-hidden">
                  <div
                    className="h-full bg-orange-600 transition-all"
                    style={{
                      width: `${(t.remaining / t.duration) * 100}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Add Timer Modal */}
      {showModal && (
        <AddTimerModal
          onClose={() => setShowModal(false)}
          onSave={(step) => {
            addTimer(step);
            setShowModal(false);
          }}
        />
      )}
    </div>
  );
}
