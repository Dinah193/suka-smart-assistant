// src/components/cooking/MultitimerCookingGuide.jsx

import React, { useEffect, useState } from "react";
import {
  PlayCircle,
  PauseCircle,
  CheckCircle,
  Timer,
  XCircle
} from "lucide-react";

import {
  createTimer,
  startTimer,
  pauseTimer,
  completeTimer,
  getAllTimers
} from "./MultiTimerManager";

export default function MultitimerCookingGuide({ recipes = [] }) {
  const [timers, setTimers] = useState([]);

  useEffect(() => {
    // Initialize timers once
    const timerList = [];

    recipes.forEach((recipe) => {
      recipe.steps?.forEach((step, index) => {
        const timerId = `${recipe.id}-step-${index}`;
        const label = `${recipe.name}: Step ${index + 1}`;
        const seconds = (step.estimatedTime || 5) * 60;

        createTimer(timerId, label, seconds);
        timerList.push({ id: timerId, label, seconds });
      });
    });

    const interval = setInterval(() => {
      setTimers(getAllTimers());
    }, 1000);

    return () => clearInterval(interval);
  }, [recipes]);

  const speak = (text) => {
    if ("speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      window.speechSynthesis.speak(utterance);
    }
  };

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  return (
    <div className="bg-white border border-stone-300 rounded-lg p-4 shadow-sm space-y-4">
      <h2 className="text-xl font-bold text-rose-700 flex items-center gap-2">
        <Timer size={20} />
        Multitimer Cooking Guide
      </h2>

      {timers.length === 0 ? (
        <p className="text-stone-500 italic">No timers active yet.</p>
      ) : (
        <ul className="space-y-3">
          {timers.map((t) => (
            <li
              key={t.id}
              className="border rounded p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
            >
              <div>
                <p className="font-medium text-stone-800">{t.label}</p>
                <p className="text-sm text-stone-600">
                  ⏱ Time Left: {formatTime(t.remaining || 0)} | Status:{" "}
                  <span className="font-semibold text-rose-600">{t.status}</span>
                </p>
              </div>

              <div className="flex items-center gap-2 text-sm">
                {t.status === "idle" && (
                  <button
                    onClick={() => {
                      startTimer(t.id);
                      speak(`Starting ${t.label}`);
                    }}
                    className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded flex gap-1 items-center"
                  >
                    <PlayCircle size={16} /> Start
                  </button>
                )}

                {t.status === "running" && (
                  <button
                    onClick={() => {
                      pauseTimer(t.id);
                      speak(`Paused ${t.label}`);
                    }}
                    className="bg-yellow-500 hover:bg-yellow-600 text-white px-3 py-1 rounded flex gap-1 items-center"
                  >
                    <PauseCircle size={16} /> Pause
                  </button>
                )}

                {t.status === "paused" && (
                  <button
                    onClick={() => {
                      startTimer(t.id);
                      speak(`Resuming ${t.label}`);
                    }}
                    className="bg-green-500 hover:bg-green-600 text-white px-3 py-1 rounded flex gap-1 items-center"
                  >
                    <PlayCircle size={16} /> Resume
                  </button>
                )}

                {t.status !== "complete" && (
                  <button
                    onClick={() => {
                      completeTimer(t.id);
                      speak(`Step completed: ${t.label}`);
                    }}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded flex gap-1 items-center"
                  >
                    <CheckCircle size={16} /> Complete
                  </button>
                )}

                <button
                  onClick={() => completeTimer(t.id)}
                  className="bg-stone-400 hover:bg-stone-500 text-white px-2 py-1 rounded"
                  title="Remove"
                >
                  <XCircle size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
