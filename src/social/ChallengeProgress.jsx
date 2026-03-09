// C:\Users\larho\suka-smart-assistant\src\social\ChallengeProgress.jsx
/**
 * ChallengeProgress (dynamic, streaks, Sabbath-aware)
 * ---------------------------------------------------
 * A social-friendly “cleaning challenge” panel that plugs into Suka’s
 * household system. It auto-loads suggested tasks from your cleaning agent /
 * routines, keeps live progress, awards points/streaks, and emits events the
 * orchestrator can use for nudges.
 *
 * Highlights:
 * - Dynamic task source (Dexie → cleaning agent → fallback template)
 * - Sabbath/quiet-hours aware: softens gamification & defers loud UI
 * - Session-aware: can attach to an active CLEANING session if present
 * - Points, levels, streaks, reward popup (with gentle celebration)
 * - Socket-aware: broadcasts changes if server/socket is present
 * - Works offline; persists to Dexie if available else localStorage
 *
 * Assumptions:
 * - DexieDB has tables: workerSessions (optional) & userMeta (optional)
 * - settings store exposes sabbath + quietHours preferences if present
 * - Optional agents: "@/agents/cleaningAgent"
 * - Optional orchestrator events (see shared/ontology.js EVENTS)
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import AnimatedProgressBar from "../ui/AnimatedProgressBar";
import Checklist from "../ui/Checklist";
import RewardPopup from "../ui/RewardPopup";
import "../theme/animations.css";

// Optional add-ons (loaded safely at runtime)
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try {
      // @vite-ignore
      const mod = await import(p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}

// Fallback templates so the UI is never empty
const FALLBACK_TASKS = [
  {
    id: "kitchen-counters",
    title: "Wipe kitchen counters",
    zone: "Kitchen",
    points: 10,
  },
  {
    id: "living-sweep",
    title: "Sweep living room",
    zone: "Living",
    points: 10,
  },
  {
    id: "bathroom-disinfect",
    title: "Disinfect bathroom surfaces",
    zone: "Bath",
    points: 15,
  },
  {
    id: "pantry-organize",
    title: "Quickly organize pantry (5m)",
    zone: "Pantry",
    points: 8,
  },
];

const STORAGE_KEY = "suka.challenge.v2";
const POINTS_LEVELS = [0, 50, 120, 220, 360, 540, 780]; // thresholds per level

/* ---------------------------------------------
   Helpers
----------------------------------------------*/
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const nowISO = () => new Date().toISOString();

function isWithin(iso, days = 1) {
  if (!iso) return false;
  const then = new Date(iso).getTime();
  return Date.now() - then < days * 86400000;
}

function readLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function writeLocal(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

function levelFromPoints(points) {
  let lvl = 1;
  for (let i = 0; i < POINTS_LEVELS.length; i++) {
    if (points >= POINTS_LEVELS[i]) lvl = i + 1;
  }
  return {
    level: lvl,
    nextAt: POINTS_LEVELS[lvl] ?? POINTS_LEVELS.at(-1) + 250,
  };
}

function formatStreak(n) {
  if (!n) return "No streak yet";
  if (n === 1) return "1-day streak";
  return `${n}-day streak`;
}

/* Sabbath & quiet hours */
function inQuietHours(now, settings) {
  const q = settings?.quietHours || { start: 21, end: 7 };
  const h = now.getHours();
  if ((q.start ?? 21) < (q.end ?? 7)) {
    return h >= (q.start ?? 21) && h < (q.end ?? 7);
  }
  return h >= (q.start ?? 21) || h < (q.end ?? 7);
}
function isSabbath(now, settings, sabbathFn) {
  try {
    if (typeof sabbathFn === "function") {
      const win = sabbathFn(now);
      if (win?.startISO && win?.endISO) {
        const s = new Date(win.startISO),
          e = new Date(win.endISO);
        return now >= s && now < e;
      }
    }
  } catch {}
  // Approx Fri 18:00 -> Sat 18:00
  const day = now.getDay();
  const fri18 = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + ((5 - day + 7) % 7),
    18,
    0,
    0,
    0
  );
  const sat18 = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + ((6 - day + 7) % 7),
    18,
    0,
    0,
    0
  );
  return now >= fri18 && now < sat18;
}

/* ---------------------------------------------
   Data loaders (Dexie, Settings, Agent, Socket)
----------------------------------------------*/
async function loadSettings() {
  const Settings = await safeImportMany([
    "@/store/SettingsStore.js",
    "@/store/SettingsStore",
  ]);
  const get = async (k, d) => {
    try {
      const v = await Settings?.get?.(k);
      return v ?? d;
    } catch {
      return d;
    }
  };
  return {
    units: await get("units.system", "us"),
    quietHours: await get("quietHours", { start: 21, end: 7 }),
    sabbath: { avoid: await get("sabbath.avoidSaturday", true) },
    profile: await get("profile.key", "standard-home"),
  };
}

async function loadDexie() {
  return await safeImportMany(["@/db/index.js", "@/db", "../db", "../../db"]);
}

async function loadCleaningAgent() {
  return await safeImportMany([
    "@/agents/cleaningShim.js",
    "@/agents/cleaningAgent",
  ]);
}

async function loadSocket() {
  const sock = await safeImportMany([
    "@/server/services/socket.js",
    "@/server/services/socket",
  ]);
  return sock?.socket || sock?.getSocket?.() || null;
}

async function loadOntology() {
  const ont = await safeImportMany([
    "@/shared/ontology.js",
    "@/shared/ontology",
  ]);
  return ont || {};
}

/* ---------------------------------------------
   Component
----------------------------------------------*/
export default function ChallengeProgress() {
  const [tasks, setTasks] = useState([]);
  const [completed, setCompleted] = useState([]); // array of task ids
  const [points, setPoints] = useState(0);
  const [streak, setStreak] = useState(0);
  const [levelInfo, setLevelInfo] = useState(() => levelFromPoints(0));
  const [showReward, setShowReward] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [settings, setSettings] = useState({
    quietHours: { start: 21, end: 7 },
    sabbath: { avoid: true },
  });

  const socketRef = useRef(null);
  const dexieRef = useRef(null);
  const sabbathFnRef = useRef(null);
  const profileRef = useRef("standard-home");

  // Load dynamic context on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [DexieDB, sock, ont, sett] = await Promise.all([
        loadDexie(),
        loadSocket(),
        loadOntology(),
        loadSettings(),
      ]);
      if (!mounted) return;

      dexieRef.current = DexieDB;
      socketRef.current = sock;
      sabbathFnRef.current = ont?.sabbath;
      setSettings(sett);
      profileRef.current = sett?.profile || "standard-home";

      // Restore state (local or Dexie)
      const restored = await restoreState(DexieDB);
      if (restored) {
        setTasks(restored.tasks);
        setCompleted(restored.completed);
        setPoints(restored.points);
        setStreak(restored.streak);
        setLevelInfo(levelFromPoints(restored.points));
        setSessionId(restored.sessionId || null);
      } else {
        // Try agent-suggested tasks
        const agent = await loadCleaningAgent();
        const suggested = await agent?.handleCommand?.("suggestQuickWins", {
          profile: profileRef.current,
          max: 6,
        });
        const list = normalizeTasks(suggested?.tasks) || FALLBACK_TASKS;
        setTasks(list);
        await persistState(DexieDB, {
          tasks: list,
          completed: [],
          points: 0,
          streak: 0,
          sessionId: null,
        });
      }

      // Wire socket listener for external updates (optional)
      if (sock?.on) {
        sock.on("automation/refreshTasks", ({ tasks: t }) => {
          const list = normalizeTasks(t) || [];
          if (list.length) {
            setTasks(list);
            persistState(DexieDB, (prev) => ({ ...prev, tasks: list }));
          }
        });
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Compute progress
  const progress = useMemo(() => {
    if (!tasks.length) return 0;
    return Math.round((completed.length / tasks.length) * 100);
  }, [tasks, completed]);

  // Level calculation
  useEffect(() => {
    setLevelInfo(levelFromPoints(points));
  }, [points]);

  // Reward popup when all done
  useEffect(() => {
    if (tasks.length && completed.length === tasks.length) {
      const now = new Date();
      const sab = isSabbath(now, settings, sabbathFnRef.current);
      const quiet = inQuietHours(now, settings);
      // During Sabbath or quiet hours, suppress popup but still log completion
      if (!sab && !quiet) {
        const t = setTimeout(() => setShowReward(true), 450);
        return () => clearTimeout(t);
      }
    }
  }, [completed, tasks.length, settings]);

  // Persist on changes (debounced)
  const persistTimer = useRef(null);
  useEffect(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      persistState(dexieRef.current, {
        tasks,
        completed,
        points,
        streak,
        sessionId,
      });
    }, 300);
    return () => clearTimeout(persistTimer.current);
  }, [tasks, completed, points, streak, sessionId]);

  // Emit lightweight “progress” event (orchestrator can listen)
  useEffect(() => {
    const detail = {
      progress,
      tasks: tasks.length,
      done: completed.length,
      at: nowISO(),
    };
    try {
      window.dispatchEvent?.(new CustomEvent("challenge:progress", { detail }));
    } catch {}
    socketRef.current?.emit?.("challenge/progress", detail);
  }, [progress, completed.length, tasks.length]);

  // Toggle task complete
  const toggleTask = (taskId) => {
    setCompleted((prev) => {
      const next = prev.includes(taskId)
        ? prev.filter((id) => id !== taskId)
        : [...prev, taskId];
      // points logic
      if (!prev.includes(taskId)) {
        const pts = tasks.find((t) => t.id === taskId)?.points || 5;
        setPoints((p) => p + pts);
      } else {
        const pts = tasks.find((t) => t.id === taskId)?.points || 5;
        setPoints((p) => Math.max(0, p - pts)); // allow undo
      }
      return next;
    });
  };

  // Start a focused cleaning session (if cookingBus-like service exists for cleaning)
  const startSession = async () => {
    const CleaningBus = await safeImportMany([
      "@/services/cleaningBus.js",
      "@/services/cleaningBus",
      "@/services/cookingBus.js", // fallback to cookingBus behavior shape
    ]);
    const userId = "localUser"; // if you have auth, replace accordingly
    if (CleaningBus?.createSession) {
      const res = await CleaningBus.createSession({
        userId,
        title: "Cleaning Challenge",
        batch: false,
        meta: { source: "challenge", profile: profileRef.current },
        recipes: [], // not used for cleaning; the service can ignore
      });
      setSessionId(res?.id || null);
      socketRef.current?.emit?.("SESSION.STARTED.CLEANING", {
        sessionId: res?.id,
        at: nowISO(),
      });
    }
  };

  // End session & award streak if finished today
  const finishSession = async () => {
    if (!sessionId) return;
    const CleaningBus = await safeImportMany([
      "@/services/cleaningBus.js",
      "@/services/cleaningBus",
      "@/services/cookingBus.js",
    ]);
    try {
      await CleaningBus?.finishSession?.(sessionId);
    } catch {}
    setSessionId(null);
    awardStreak();
    socketRef.current?.emit?.("SESSION.FINISHED.CLEANING", { at: nowISO() });
  };

  // Streak award (once/day on any completion)
  const awardStreak = () => {
    const data = readLocal() || {};
    const lastDay = data?.lastCompleteISO;
    const today = new Date();
    const ymd = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (!lastDay) {
      setStreak((s) => Math.max(1, s));
    } else {
      const prev = new Date(lastDay);
      // If yesterday -> increment; if today -> keep; else reset
      const dPrev = new Date(
        prev.getFullYear(),
        prev.getMonth(),
        prev.getDate()
      );
      const dToday = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      );
      const diff = Math.round((dToday - dPrev) / 86400000);
      if (diff === 1) setStreak((s) => s + 1);
      else if (diff > 1) setStreak(1);
    }
    writeLocal({ ...(data || {}), lastCompleteISO: today.toISOString() });
  };

  // UI sections
  const progressText = `${completed.length}/${tasks.length} done • Level ${
    levelInfo.level
  } • ${formatStreak(streak)}`;
  const nextTarget = levelInfo.nextAt;
  const toNext = Math.max(0, (nextTarget ?? 0) - points);

  return (
    <div className="flex h-full min-h-[70vh] bg-stone-50 rounded-xl border border-stone-200 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-72 bg-amber-50 p-5 border-r border-amber-200">
        <h2 className="text-lg font-semibold text-amber-800 mb-3">
          🧼 Cleaning Challenge
        </h2>
        <div className="text-sm text-amber-900/80 space-y-2">
          <div className="flex items-center justify-between">
            <span>Points</span>
            <span className="font-semibold">{points}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Level</span>
            <span className="font-semibold">{levelInfo.level}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Streak</span>
            <span className="font-semibold">{streak}d</span>
          </div>
          {toNext > 0 && (
            <div className="text-xs text-amber-700/80 mt-1">
              {toNext} pts to next level
            </div>
          )}
        </div>

        <div className="mt-6 space-y-2">
          <button
            onClick={startSession}
            className="w-full rounded-xl bg-amber-600 hover:bg-amber-700 text-white py-2 text-sm shadow transition"
            disabled={!!sessionId}
            title={
              sessionId
                ? "Session already running"
                : "Start a focused cleaning session"
            }
          >
            {sessionId ? "Session Running…" : "Start Session"}
          </button>
          <button
            onClick={finishSession}
            className="w-full rounded-xl bg-stone-800 hover:bg-stone-900 text-white py-2 text-sm shadow transition disabled:opacity-50"
            disabled={!sessionId}
          >
            Finish Session
          </button>
        </div>

        <div className="mt-6 text-xs text-stone-600 leading-relaxed">
          • Quiet hours: {settings?.quietHours?.start ?? 21}:00—
          {settings?.quietHours?.end ?? 7}:00
          <br />• Sabbath avoidance: {settings?.sabbath?.avoid ? "On" : "Off"}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 p-6 overflow-y-auto">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-stone-800">
            Today’s Tasks
          </h1>
          <div className="text-sm text-stone-600">{progressText}</div>
        </div>

        <div className="mt-3">
          <AnimatedProgressBar progress={progress} />
        </div>

        <div className="mt-6">
          <Checklist
            tasks={tasks.map((t) => t.title)}
            completedTasks={completed
              .map((id) => tasks.find((t) => t.id === id)?.title)
              .filter(Boolean)}
            toggleTask={(title) => {
              const task = tasks.find((t) => t.title === title);
              if (task) toggleTask(task.id);
            }}
          />
        </div>
      </main>

      {/* Reward */}
      {showReward && (
        <RewardPopup
          title="Cleaning Master!"
          message="You completed your session! 🎉"
          onClose={() => setShowReward(false)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------
   Normalize & Persistence
----------------------------------------------*/
function normalizeTasks(raw) {
  if (!raw || !Array.isArray(raw)) return null;
  return raw.map((r, i) => ({
    id: r.id || r.key || `t_${i}`,
    title: r.title || r.text || r.name || `Task ${i + 1}`,
    zone: r.zone || r.area || "General",
    points: Number(r.points ?? (r.difficulty === "high" ? 15 : 10)),
  }));
}

async function restoreState(DexieDB) {
  // Try Dexie userMeta first
  try {
    const db = DexieDB;
    if (db?.userMeta?.get) {
      const doc = await db.userMeta.get({ key: STORAGE_KEY });
      if (doc?.value) return doc.value;
    }
  } catch {}
  // Fallback localStorage
  const local = readLocal();
  if (local && Array.isArray(local.tasks)) return local;

  // Try to find today’s active cleaning session tasks (best-effort)
  try {
    const db = DexieDB;
    const todayISO = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const sessions = await db?.workerSessions
      ?.where?.("role")
      ?.equals?.("cleaner")
      ?.toArray?.();
    const latest = (sessions || [])
      .filter((s) => s?.date >= todayISO)
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    if (latest?.tasks?.length) {
      return {
        tasks: normalizeTasks(latest.tasks),
        completed: [],
        points: 0,
        streak: 0,
        sessionId: latest.id || null,
        at: nowISO(),
      };
    }
  } catch {}

  return null;
}

async function persistState(DexieDB, patch) {
  const current = readLocal() || {};
  const next =
    typeof patch === "function"
      ? patch(current)
      : { ...current, ...patch, at: nowISO() };

  // Write Dexie
  try {
    const db = DexieDB;
    if (db?.userMeta?.put) {
      await db.userMeta.put({
        key: STORAGE_KEY,
        value: next,
        updatedAt: nowISO(),
      });
    }
  } catch {}
  writeLocal(next);
}
