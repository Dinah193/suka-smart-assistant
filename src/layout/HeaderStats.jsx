// ✅ UPDATE (optional)
// C:\Users\larho\suka-smart-assistant\src\layout\HeaderStats.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Sparkles, Award } from "lucide-react";
import { getLevelProgress } from "@/gamification/xpEngine";
import badges from "@/gamification/badges"; // Static badge list

export default function HeaderStats({ user = {} }) {
  const [progress, setProgress] = useState({
    current: 0,
    required: 100,
    percent: 0,
  });

  // ✅ Fix: Only update when `user.xp` changes
  useEffect(() => {
    const xp = user?.xp || 0;
    const p = getLevelProgress(xp);
    setProgress(p);
  }, [user?.xp]);

  const earnedBadges = useMemo(() => {
    return Array.isArray(user.badges)
      ? user.badges
          .map((b) => badges.find((bdg) => bdg.id === b))
          .filter(Boolean)
      : [];
  }, [user?.badges]);

  return (
    <div className="bg-white/70 backdrop-bl-sm border-b border-white/70 shadow-sm">
      <div className="mx-auto w-full max-w-7xl px-4 md:px-6 lg:px-8 py-3">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
          {/* XP & Level */}
          <div className="w-full md:w-1/2">
            <div className="flex items-center gap-2">
              <div className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-pink-600/10 border border-pink-600/20">
                <Sparkles className="text-pink-700" size={18} />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-stone-500">
                  Progress
                </div>
                <h3 className="text-stone-800 font-extrabold text-base leading-tight">
                  Level {user.level ?? 1}
                </h3>
              </div>
            </div>

            <div className="mt-2">
              <div className="relative h-2 bg-stone-200/80 rounded-full overflow-hidden">
                <div
                  className="absolute top-0 left-0 h-full bg-pink-600 transition-all duration-500"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <p className="text-[11px] text-stone-500 mt-1">
                {progress.current} / {progress.required} XP
              </p>
            </div>
          </div>

          {/* Badges */}
          <div className="w-full md:w-1/2 flex flex-wrap md:justify-end items-center gap-2">
            {earnedBadges.length > 0 ? (
              earnedBadges.map((badge) => (
                <div
                  key={badge.id}
                  title={badge.name}
                  className="flex items-center gap-2 rounded-xl bg-white/60 border border-white/70 px-3 py-2 shadow-sm"
                >
                  <Award className="text-emerald-600" size={18} />
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-stone-700 truncate">
                      {badge.name}
                    </div>
                    <div className="text-[11px] text-stone-500 truncate">
                      Earned
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-stone-500 italic text-sm">No badges yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
