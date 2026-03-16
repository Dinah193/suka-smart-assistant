// src/store/MultiTimerManager.js
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

let TICKER = null;

/** Utility */
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Timer shape (BC with old fields):
 * {
 *   id: string,
 *   label: string,
 *   duration: number,   // seconds (as before)
 *   remaining: number,  // seconds (as before)
 *   status: "idle"|"running"|"paused"|"complete",
 *   // New metadata (optional, safe to ignore in old UIs):
 *   meta?: {
 *     recipeId?: string;
 *     stepId?: string;
 *     slotId?: string;
 *     tags?: string[];
 *     dueAt?: string;        // ISO timestamp; if set when creating, duration = max(0, dueAt - now)
 *     createdAt?: string;    // ISO
 *     startedAt?: string;    // ISO (last start)
 *     quietHours?: boolean;  // let UI suppress alerts (e.g., sabbath window)
 *   }
 * }
 */

function startTicker(get, set) {
  if (TICKER) return;
  let last = nowSec();
  TICKER = setInterval(() => {
    const cur = nowSec();
    let delta = cur - last;
    if (delta <= 0) return;
    last = cur;

    const { timers } = get();
    if (!timers.length) {
      stopTicker();
      return;
    }

    let changed = false;
    const completed = [];

    const next = timers.map((t) => {
      if (t.status !== "running" || t.remaining <= 0) return t;

      const rem = Math.max(0, t.remaining - delta);
      if (rem !== t.remaining) changed = true;

      if (rem <= 0) {
        const done = {
          ...t,
          remaining: 0,
          status: "complete",
          meta: { ...(t.meta || {}), completedAt: new Date().toISOString() },
        };
        completed.push(done);
        return done;
      }

      return { ...t, remaining: rem };
    });

    if (changed) set({ timers: next });

    // Fire completion events after state update
    if (completed.length) {
      completed.forEach((timer) => {
        try {
          window.dispatchEvent(
            new CustomEvent("multitimer:complete", { detail: { timer } })
          );
        } catch {}
      });
    }

    // Stop ticker if nothing is running anymore
    const anyRunning = next.some((t) => t.status === "running");
    if (!anyRunning) stopTicker();
  }, 250); // 4Hz, smooth enough without burning CPU
}

function stopTicker() {
  if (TICKER) {
    clearInterval(TICKER);
    TICKER = null;
  }
}

/** Normalize duration from seconds or from a dueAt timestamp */
function computeInitialDuration(duration, dueAtIso) {
  const fromSeconds = Math.max(0, Number(duration || 0));
  if (dueAtIso) {
    const due = Date.parse(dueAtIso);
    if (!Number.isNaN(due)) {
      const secs = Math.max(0, Math.floor((due - Date.now()) / 1000));
      return secs;
    }
  }
  return fromSeconds;
}

/** Persist & hydrate with migration */
const useTimerStore = create(
  persist(
    (set, get) => ({
      timers: [],

      /** BC: same signature; `duration` may also be an object to unlock richer creation. */
      createTimer: (id, label, durationOrOpts) => {
        // Support legacy call: (id, label, durationSeconds)
        // And new call: (id, label, { duration, dueAt, meta })
        const opts =
          typeof durationOrOpts === "object" && durationOrOpts !== null
            ? durationOrOpts
            : { duration: durationOrOpts };

        const safeId = String(id ?? `t-${Date.now()}`).trim();
        const dur = computeInitialDuration(opts.duration, opts.dueAt);
        if (!safeId || !Number.isFinite(dur)) return;

        const prev = get().timers || [];
        if (prev.some((t) => t.id === safeId)) return; // no duplicates

        const next = [
          ...prev,
          {
            id: safeId,
            label: label || "Timer",
            duration: dur,
            remaining: dur,
            status: "idle",
            meta: {
              createdAt: new Date().toISOString(),
              ...(opts.dueAt ? { dueAt: opts.dueAt } : {}),
              ...(opts.meta || {}),
            },
          },
        ];
        set({ timers: next });
      },

      startTimer: (id) => {
        const safeId = String(id ?? "").trim();
        const prev = get().timers || [];
        let changed = false;

        const next = prev.map((t) => {
          if (t.id !== safeId) return t;
          if (t.status === "complete") return t;
          if (t.status !== "running") {
            changed = true;
            return {
              ...t,
              status: "running",
              meta: { ...(t.meta || {}), startedAt: new Date().toISOString() },
            };
          }
          return t;
        });

        if (changed) {
          set({ timers: next });
          startTicker(get, set);
        }
      },

      pauseTimer: (id) => {
        const safeId = String(id ?? "").trim();
        const prev = get().timers || [];
        let changed = false;

        const next = prev.map((t) => {
          if (t.id !== safeId) return t;
          if (t.status === "running") {
            changed = true;
            return { ...t, status: "paused" };
          }
          return t;
        });

        if (changed) {
          set({ timers: next });
          const stillRunning = next.some((t) => t.status === "running");
          if (!stillRunning) stopTicker();
        }
      },

      completeTimer: (id) => {
        const safeId = String(id ?? "").trim();
        const prev = get().timers || [];
        let changed = false;

        const next = prev.map((t) => {
          if (t.id !== safeId) return t;
          if (t.status !== "complete" || t.remaining !== 0) {
            changed = true;
            return {
              ...t,
              status: "complete",
              remaining: 0,
              meta: {
                ...(t.meta || {}),
                completedAt: new Date().toISOString(),
              },
            };
          }
          return t;
        });

        if (changed) {
          set({ timers: next });
          const stillRunning = next.some((t) => t.status === "running");
          if (!stillRunning) stopTicker();

          // Emit completion event for listeners
          next.forEach((t) => {
            if (t.id === safeId && t.status === "complete") {
              try {
                window.dispatchEvent(
                  new CustomEvent("multitimer:complete", {
                    detail: { timer: t },
                  })
                );
              } catch {}
            }
          });
        }
      },

      removeTimer: (id) => {
        const safeId = String(id ?? "").trim();
        const prev = get().timers || [];
        const next = prev.filter((t) => t.id !== safeId);
        if (next.length === prev.length) return; // no change
        set({ timers: next });
        const stillRunning = next.some((t) => t.status === "running");
        if (!stillRunning) stopTicker();
      },

      clearAll: () => {
        const hadAny = (get().timers || []).length > 0;
        if (!hadAny) return;
        set({ timers: [] });
        stopTicker();
      },

      /* ----------------- New ergonomic helpers ----------------- */

      /** Add seconds to a timer (can be negative to subtract). */
      addTime: (id, seconds) => {
        const safeId = String(id ?? "").trim();
        const add = Math.floor(Number(seconds || 0));
        if (!add) return;
        const prev = get().timers || [];
        const next = prev.map((t) => {
          if (t.id !== safeId) return t;
          const remaining = Math.max(0, (t.remaining ?? 0) + add);
          // If it was complete and we added time, put it in paused state so user can start
          const status =
            remaining === 0
              ? "complete"
              : t.status === "complete"
              ? "paused"
              : t.status;
          return {
            ...t,
            remaining,
            duration: Math.max(remaining, t.duration || remaining),
            status,
          };
        });
        set({ timers: next });
      },

      /** Snooze a completed or running timer by N seconds. */
      snooze: (id, seconds = 300) => {
        const safeId = String(id ?? "").trim();
        const add = Math.max(1, Math.floor(Number(seconds || 0)));
        const prev = get().timers || [];
        const next = prev.map((t) => {
          if (t.id !== safeId) return t;
          const remaining = (t.remaining || 0) + add;
          return { ...t, remaining, status: "running" };
        });
        set({ timers: next });
        startTicker(get, set);
      },

      /** Restart timer to its original duration, set to paused (so user can start). */
      restart: (id) => {
        const safeId = String(id ?? "").trim();
        const prev = get().timers || [];
        const next = prev.map((t) => {
          if (t.id !== safeId) return t;
          const dur = Math.max(0, Number(t.duration || 0));
          return { ...t, remaining: dur, status: "paused" };
        });
        set({ timers: next });
      },

      /** Schedule a timer to a future moment (dueAt ISO). */
      scheduleFor: (id, label, dueAtIso) => {
        const safeId = String(id ?? `t-${Date.now()}`).trim();
        const prev = get().timers || [];
        if (prev.some((t) => t.id === safeId)) {
          // update existing
          const dur = computeInitialDuration(undefined, dueAtIso);
          const next = prev.map((t) =>
            t.id === safeId
              ? {
                  ...t,
                  label: label || t.label,
                  duration: dur,
                  remaining: dur,
                  status: "idle",
                  meta: { ...(t.meta || {}), dueAt: dueAtIso },
                }
              : t
          );
          set({ timers: next });
          return;
        }
        // create new
        get().createTimer(safeId, label, {
          dueAt: dueAtIso,
          meta: { dueAt: dueAtIso },
        });
      },

      /** Attach metadata (recipe/step/slot/tags). */
      attachMeta: (id, metaPatch) => {
        const safeId = String(id ?? "").trim();
        const prev = get().timers || [];
        const next = prev.map((t) =>
          t.id === safeId
            ? { ...t, meta: { ...(t.meta || {}), ...(metaPatch || {}) } }
            : t
        );
        set({ timers: next });
      },
    }),
    {
      name: "suka.multitimer.v2",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) => {
        if (!persisted) return persisted;
        if (version < 2 && Array.isArray(persisted.timers)) {
          // Ensure shape robustness
          persisted.timers = persisted.timers.map((t) => ({
            id: t.id,
            label: t.label ?? "Timer",
            duration: Math.max(0, Number(t.duration || t.remaining || 0)),
            remaining: Math.max(0, Number(t.remaining || t.duration || 0)),
            status: t.status || "idle",
            meta: t.meta || { createdAt: new Date().toISOString() },
          }));
        }
        return persisted;
      },
      // Only persist timers array
      partialize: (s) => ({ timers: s.timers }),
      onRehydrateStorage: () => (state) => {
        // Recalculate remaining for any timers that were "running" across reloads
        const timers = (state?.timers || []).map((t) => {
          if (t.status !== "running") return t;
          // If it had dueAt, recompute from dueAt; else keep remaining as-is and let ticker resume
          const due = t.meta?.dueAt ? Date.parse(t.meta.dueAt) : null;
          if (due && !Number.isNaN(due)) {
            const dur = computeInitialDuration(undefined, t.meta.dueAt);
            return {
              ...t,
              duration: dur,
              remaining: dur,
              status: dur === 0 ? "complete" : "running",
            };
          }
          return t;
        });
        // Write back recalculated timers
        if (timers.length) {
          // eslint-disable-next-line no-undef
          setTimeout(() => {
            try {
              useTimerStore.setState({ timers });
              if (timers.some((x) => x.status === "running")) {
                startTicker(useTimerStore.getState, useTimerStore.setState);
              }
            } catch {}
          }, 0);
        }
      },
    }
  )
);

/* Public selectors & imperative helpers (unchanged core API) */
export const useTimers = () => useTimerStore((state) => state.timers);

export const createTimer = (id, label, durationOrOpts) =>
  useTimerStore.getState().createTimer(id, label, durationOrOpts);

export const startTimer = (id) => useTimerStore.getState().startTimer(id);
export const pauseTimer = (id) => useTimerStore.getState().pauseTimer(id);
export const completeTimer = (id) => useTimerStore.getState().completeTimer(id);
export const removeTimer = (id) => useTimerStore.getState().removeTimer(id);

/**
 * getAllTimers
 * - Backward-compatible export expected by MultiTimerManagerUI.jsx.
 * - Returns the current timers array (never throws).
 */
export function getAllTimers() {
  try {
    const s = useTimerStore?.getState?.();
    return Array.isArray(s?.timers) ? s.timers : [];
  } catch {
    return [];
  }
}

/** formatTime
 * - Backward-compatible helper used by UI.
 * - Accepts seconds; returns "MM:SS" or "H:MM:SS" when >= 1 hour.
 */
export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const pad2 = (n) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

/* Optional helpers (new, backwards-compatible) */
export const clearAllTimers = () => useTimerStore.getState().clearAll();
export const addTimeToTimer = (id, seconds) =>
  useTimerStore.getState().addTime(id, seconds);
export const snoozeTimer = (id, seconds = 300) =>
  useTimerStore.getState().snooze(id, seconds);
export const restartTimer = (id) => useTimerStore.getState().restart(id);
export const scheduleTimerFor = (id, label, dueAtIso) =>
  useTimerStore.getState().scheduleFor(id, label, dueAtIso);
export const linkTimerTo = (id, metaPatch) =>
  useTimerStore.getState().attachMeta(id, metaPatch);
