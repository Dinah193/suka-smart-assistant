// C:\Users\larho\suka-smart-assistant\src\features\session\useSessionRunner.js

import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "../../services/eventBus";
import { familyFundMode } from "../../services/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "../../services/hub";
import { db } from "../../services/db"; // Dexie instance (sessions, sessionFavorites, sessionSchedules)

// 🔌 Shim + Orchestrator imports (adjust paths to match your project)
import { householdOrchestrator } from "../../orchestration/householdOrchestrator";
import { sessionShim } from "../../agents/shims/sessionShim";

/**
 * Source label for eventBus
 */
const SOURCE = "features/session/useSessionRunner";

/**
 * Domain presets / hints.
 * These are NOT rigid schemas; they are hints to help build dynamic sessions
 * across cleaning, garden, storehouse, meals, animals, and preservation.
 */
const DOMAIN_PRESETS = {
  cooking: {
    label: "Cooking / Meal Execution",
    defaultIcon: "🍳",
    defaultDurationMinutes: 45,
  },
  cleaning: {
    label: "Cleaning / Reset",
    defaultIcon: "🧽",
    defaultDurationMinutes: 30,
  },
  garden_planning: {
    label: "Garden Planning",
    defaultIcon: "🪴",
    defaultDurationMinutes: 45,
  },
  garden_care: {
    label: "Garden Care",
    defaultIcon: "🌱",
    defaultDurationMinutes: 30,
  },
  garden_harvest: {
    label: "Harvest & Log",
    defaultIcon: "🧺",
    defaultDurationMinutes: 30,
  },
  storehouse: {
    label: "Storehouse Stock & Grocery Planning",
    defaultIcon: "🏚️",
    defaultDurationMinutes: 40,
    // Simple grocery sections to inspire storehouse zones / list grouping
    grocerySections: [
      "Produce",
      "Meat & Seafood",
      "Dairy & Eggs",
      "Pantry / Dry Goods",
      "Frozen",
      "Canned & Jarred",
      "Oils, Spices & Seasonings",
      "Baking",
      "Snacks",
      "Beverages",
      "Household & Cleaning",
    ],
  },
  animals_acquisition: {
    label: "Animal Acquisition & Intake",
    defaultIcon: "🐑",
    defaultDurationMinutes: 60,
  },
  animals_care: {
    label: "Animal Care & Husbandry",
    defaultIcon: "🐄",
    defaultDurationMinutes: 30,
  },
  animals_butchery: {
    label: "Butchery & Processing",
    defaultIcon: "🔪",
    defaultDurationMinutes: 120,
  },
  preservation: {
    label: "Preservation Session",
    defaultIcon: "🥫",
    defaultDurationMinutes: 90,
  },
};

/**
 * Utility: get ISO timestamp "now"
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Utility: generate a simple ID if Dexie doesn't return one.
 */
function generateId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Compute summary stats for a session (total duration, completed steps, etc.)
 */
function computeSessionStats(session) {
  if (!session || !Array.isArray(session.steps)) {
    return { totalSteps: 0, completedSteps: 0, totalDurationMs: 0 };
  }

  const totalSteps = session.steps.length;
  let completedSteps = 0;
  let totalDurationMs = 0;

  for (const step of session.steps) {
    if (step.status === "completed") completedSteps += 1;
    if (typeof step.durationMs === "number") {
      totalDurationMs += step.durationMs;
    }
  }

  return { totalSteps, completedSteps, totalDurationMs };
}

/**
 * Normalize raw step input into a consistent step contract.
 */
function normalizeSteps(rawSteps = [], domainKey) {
  const preset = DOMAIN_PRESETS[domainKey] || {};
  const defaultDuration =
    (preset.defaultDurationMinutes || 30) * 60 * 1000; // ms

  return rawSteps.map((step, index) => {
    const base = typeof step === "string" ? { label: step } : step || {};
    return {
      id: base.id || `${domainKey || "generic"}_step_${index}_${Date.now()}`,
      label: base.label || `Step ${index + 1}`,
      description: base.description || "",
      domain: base.domain || domainKey || "generic",
      durationMs:
        typeof base.durationMs === "number" ? base.durationMs : defaultDuration,
      order: typeof base.order === "number" ? base.order : index,
      status: base.status || "pending", // pending | running | completed | skipped
      checklist: Array.isArray(base.checklist) ? base.checklist : [],
      meta: {
        ...base.meta,
      },
    };
  });
}

/**
 * Apply schedule info:
 * modes:
 *  - "now": start now, end now + totalDuration
 *  - "scheduled": startAt provided
 *  - "reverse": targetCompletion provided, compute backwards
 */
function applyScheduleToSession(session, scheduleOptions = {}) {
  const { totalDurationMs } = computeSessionStats(session);
  const {
    mode = "now",
    startsAt,
    targetCompletion,
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    recurrenceRule = null,
  } = scheduleOptions;

  let computedStartsAt = startsAt || nowIso();
  let computedEndsAt = null;

  if (mode === "reverse" && targetCompletion) {
    const target = new Date(targetCompletion);
    const start = new Date(target.getTime() - totalDurationMs);
    computedStartsAt = start.toISOString();
    computedEndsAt = target.toISOString();

    // Also push step-level schedule (simple reverse)
    let cursor = start.getTime();
    const steps = (session.steps || []).map((step) => {
      const duration = step.durationMs || 0;
      const stepStart = cursor;
      const stepEnd = cursor + duration;
      cursor = stepEnd;
      return {
        ...step,
        scheduledStartAt: new Date(stepStart).toISOString(),
        scheduledEndAt: new Date(stepEnd).toISOString(),
      };
    });
    session.steps = steps;
  } else {
    // "now" or "scheduled"
    const start = new Date(computedStartsAt);
    const end = new Date(start.getTime() + totalDurationMs);
    computedEndsAt = end.toISOString();
  }

  return {
    ...session,
    schedule: {
      ...(session.schedule || {}),
      mode,
      startsAt: computedStartsAt,
      endsAt: computedEndsAt,
      targetCompletion: targetCompletion || null,
      timezone,
      recurrenceRule,
    },
    updatedAt: nowIso(),
  };
}

/**
 * Normalize raw session input (from UI, importer, or automation) into a session object
 * compatible with SSA contracts.
 *
 * This supports all domains: cooking, cleaning, garden, storehouse, animals, preservation, etc.
 */
function normalizeSessionInput(raw, { domainOverride, scheduleOptions } = {}) {
  const domainKey = domainOverride || raw.domain || "generic";
  const preset = DOMAIN_PRESETS[domainKey] || {};

  const base = {
    id: raw.id || generateId(),
    title: raw.title || preset.label || "Household Session",
    domain: domainKey,
    icon: raw.icon || preset.defaultIcon || "✅",
    source: raw.source || "user", // user | system | automation
    isTemplate: !!raw.isTemplate,
    templateId: raw.templateId || null,
    status: raw.status || "scheduled", // idle | scheduled | running | paused | completed | cancelled | failed
    steps: normalizeSteps(raw.steps || [], domainKey),
    createdAt: raw.createdAt || nowIso(),
    updatedAt: nowIso(),
    meta: {
      // domain-aware hints
      gardenBeds: raw.meta?.gardenBeds || [],
      harvestItems: raw.meta?.harvestItems || [],
      storehouseZones:
        raw.meta?.storehouseZones ||
        DOMAIN_PRESETS.storehouse?.grocerySections ||
        [],
      grocerySections:
        raw.meta?.grocerySections ||
        DOMAIN_PRESETS.storehouse?.grocerySections ||
        [],
      animals:
        raw.meta?.animals || raw.meta?.animalIds || raw.meta?.herdIds || [],
      recipes: raw.meta?.recipes || [],
      butcheryCutSheetId: raw.meta?.butcheryCutSheetId || null,
      householdId: raw.meta?.householdId || null,
      notes: raw.meta?.notes || "",
      ...raw.meta,
    },
    schedule: raw.schedule || {},
  };

  // Apply schedule options
  const withSchedule = applyScheduleToSession(base, scheduleOptions);

  return withSchedule;
}

/**
 * Try exporting a session completion to the Family Fund Hub (when enabled).
 */
async function maybeExportToHubOnComplete(session) {
  if (!familyFundMode) return;

  try {
    const packet = HubPacketFormatter.formatSessionCompletion(session);
    await FamilyFundConnector.queuePacket(packet);

    emit({
      type: "hub.export.queued",
      ts: nowIso(),
      source: SOURCE,
      data: { sessionId: session.id, domain: session.domain },
    });
  } catch (err) {
    console.error("[useSessionRunner] Hub export failed", err);
    emit({
      type: "hub.export.failed",
      ts: nowIso(),
      source: SOURCE,
      data: { sessionId: session.id, domain: session.domain, error: String(err) },
    });
  }
}

/**
 * Acquire / release wake lock. (Safe no-op where unsupported.)
 */
async function tryAcquireWakeLock(ref) {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    ref.current = lock;
    lock.addEventListener("release", () => {
      ref.current = null;
    });
  } catch (err) {
    console.warn("[useSessionRunner] WakeLock request failed", err);
  }
}

async function tryReleaseWakeLock(ref) {
  if (ref.current && typeof ref.current.release === "function") {
    try {
      await ref.current.release();
    } catch (err) {
      console.warn("[useSessionRunner] WakeLock release failed", err);
    } finally {
      ref.current = null;
    }
  }
}

/**
 * Hook: useSessionRunner
 *
 * Responsibilities:
 *  - Load/resume the latest running/paused session from Dexie
 *  - Start "Now" sessions or scheduled/reverse sessions
 *  - Advance steps, pause, complete, cancel
 *  - Support user favorites & schedule saving (not just system templates)
 *  - Support reverse generation (backwards from targetCompletion)
 *  - Emit events for automation runtime + optional Hub export
 */
export function useSessionRunner({ autoResume = true } = {}) {
  const [activeSession, setActiveSession] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [error, setError] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [schedules, setSchedules] = useState([]);

  const wakeLockRef = useRef(null);

  /**
   * INTERNAL HELPERS
   */

  const loadFavorites = useCallback(async () => {
    if (!db?.sessionFavorites) return;
    const all = await db.sessionFavorites.toArray();
    setFavorites(all || []);
  }, []);

  const loadSchedules = useCallback(async () => {
    if (!db?.sessionSchedules) return;
    const all = await db.sessionSchedules.toArray();
    setSchedules(all || []);
  }, []);

  const persistSession = useCallback(async (session) => {
    if (!db?.sessions) return session;

    const toSave = {
      ...session,
      updatedAt: nowIso(),
    };

    const key = await db.sessions.put(toSave);
    const saved =
      typeof key === "number" || typeof key === "string"
        ? await db.sessions.get(key)
        : toSave;

    return saved;
  }, []);

  const restoreLastActive = useCallback(async () => {
    if (!db?.sessions) return;

    try {
      const candidate = await db.sessions
        .where("status")
        .anyOf("running", "paused")
        .last();

      if (candidate) {
        setActiveSession(candidate);
        setIsRunning(candidate.status === "running");
        setIsPaused(candidate.status === "paused");
        emit({
          type: "session.restored",
          ts: nowIso(),
          source: SOURCE,
          data: { sessionId: candidate.id, domain: candidate.domain },
        });
        await tryAcquireWakeLock(wakeLockRef);
      }
    } catch (err) {
      console.error("[useSessionRunner] restoreLastActive failed", err);
    }
  }, []);

  /**
   * PUBLIC API: start a session now / scheduled / reverse.
   *
   * `rawSession` is the domain-specific config coming from the UI (any domain).
   * `options` can include:
   *   - domainOverride
   *   - scheduleOptions: { mode, startsAt, targetCompletion, timezone, recurrenceRule }
   */
  const startSession = useCallback(
    async (rawSession, options = {}) => {
      setError(null);

      try {
        const normalized = normalizeSessionInput(rawSession, {
          domainOverride: options.domainOverride,
          scheduleOptions: options.scheduleOptions || { mode: "now" },
        });

        const session = await persistSession({
          ...normalized,
          status: "running",
          startedAt: nowIso(),
        });

        setActiveSession(session);
        setIsRunning(true);
        setIsPaused(false);

        emit({
          type: "session.started",
          ts: nowIso(),
          source: SOURCE,
          data: { session },
        });

        // 🔌 Direct shim + orchestrator hook — complements events
        try {
          if (householdOrchestrator?.onSessionStarted) {
            await householdOrchestrator.onSessionStarted(session);
          }
          if (sessionShim?.onSessionStarted) {
            await sessionShim.onSessionStarted(session);
          }
        } catch (shimErr) {
          console.error(
            "[useSessionRunner] shim/orchestrator onSessionStarted failed",
            shimErr
          );
          emit({
            type: "session.shim.onSessionStarted.failed",
            ts: nowIso(),
            source: SOURCE,
            data: { sessionId: session.id, error: String(shimErr) },
          });
        }

        await tryAcquireWakeLock(wakeLockRef);

        return session;
      } catch (err) {
        console.error("[useSessionRunner] startSession failed", err);
        setError(err);
        emit({
          type: "session.start.failed",
          ts: nowIso(),
          source: SOURCE,
          data: { error: String(err) },
        });
        return null;
      }
    },
    [persistSession]
  );

  /**
   * PUBLIC API: request a reverse-generated session.
   *
   * This BOTH:
   *  - applies a simple local reverse plan (targetCompletion -> backwards).
   *  - emits an event so AI/automation can generate richer sessions if desired.
   */
  const startReverseGeneratedSession = useCallback(
    async (rawSession, targetCompletion, options = {}) => {
      const scheduleOptions = {
        ...(options.scheduleOptions || {}),
        mode: "reverse",
        targetCompletion,
      };

      // 1) Start a basic reverse session using local logic
      const session = await startSession(rawSession, {
        ...options,
        scheduleOptions,
      });

      if (session) {
        // 2) Emit for event-driven listeners
        emit({
          type: "session.reverse.generated",
          ts: nowIso(),
          source: SOURCE,
          data: {
            sessionId: session.id,
            domain: session.domain,
            targetCompletion,
          },
        });

        // 3) 🔌 Optional direct shim + orchestrator enrichment
        try {
          const enrichedPlan = await sessionShim?.planSession?.({
            sessionId: session.id,
            domain: session.domain,
            targetCompletion,
            seedSession: session,
          });

          if (enrichedPlan) {
            const orchestrated =
              (await householdOrchestrator?.applyPlan?.({
                session,
                plan: enrichedPlan,
              })) || enrichedPlan;

            const saved = await persistSession(orchestrated);
            setActiveSession(saved);

            emit({
              type: "session.plan.enriched",
              ts: nowIso(),
              source: SOURCE,
              data: { sessionId: saved.id, domain: saved.domain },
            });
          }
        } catch (err) {
          console.error(
            "[useSessionRunner] shim/orchestrator enrichment failed",
            err
          );
          emit({
            type: "session.plan.enrichment.failed",
            ts: nowIso(),
            source: SOURCE,
            data: { sessionId: session.id, error: String(err) },
          });
        }
      }

      return session;
    },
    [startSession, persistSession]
  );

  /**
   * PUBLIC API: advance to the next step, marking the current one completed.
   */
  const completeCurrentStep = useCallback(
    async () => {
      if (!activeSession) return null;

      const currentIndex = (activeSession.steps || []).findIndex(
        (s) => s.status === "running"
      );

      // If none running, start the first pending step
      if (currentIndex === -1) {
        const nextIndex = (activeSession.steps || []).findIndex(
          (s) => s.status === "pending"
        );

        if (nextIndex === -1) {
          // No more steps -> complete session
          const completed = {
            ...activeSession,
            status: "completed",
            completedAt: nowIso(),
          };
          const saved = await persistSession(completed);
          setActiveSession(saved);
          setIsRunning(false);
          setIsPaused(false);

          emit({
            type: "session.completed",
            ts: nowIso(),
            source: SOURCE,
            data: { sessionId: saved.id, domain: saved.domain },
          });

          // 🔌 Direct hooks for downstream orchestration
          try {
            if (householdOrchestrator?.onSessionCompleted) {
              await householdOrchestrator.onSessionCompleted(saved);
            }
            if (sessionShim?.onSessionCompleted) {
              await sessionShim.onSessionCompleted(saved);
            }
          } catch (shimErr) {
            console.error(
              "[useSessionRunner] shim/orchestrator onSessionCompleted failed",
              shimErr
            );
            emit({
              type: "session.shim.onSessionCompleted.failed",
              ts: nowIso(),
              source: SOURCE,
              data: {
                sessionId: saved.id,
                domain: saved.domain,
                error: String(shimErr),
              },
            });
          }

          await tryReleaseWakeLock(wakeLockRef);
          await maybeExportToHubOnComplete(saved);
          return saved;
        }

        const updated = {
          ...activeSession,
          steps: activeSession.steps.map((step, idx) =>
            idx === nextIndex
              ? { ...step, status: "running", startedAt: nowIso() }
              : step
          ),
        };
        const saved = await persistSession(updated);
        setActiveSession(saved);

        emit({
          type: "session.step.started",
          ts: nowIso(),
          source: SOURCE,
          data: {
            sessionId: saved.id,
            domain: saved.domain,
            stepId: saved.steps[nextIndex].id,
            index: nextIndex,
          },
        });

        return saved;
      }

      // Mark current running step complete and start the next pending one
      const nextIndex = (activeSession.steps || []).findIndex(
        (s, idx) => idx > currentIndex && s.status === "pending"
      );

      const updatedSteps = activeSession.steps.map((step, idx) => {
        if (idx === currentIndex) {
          return {
            ...step,
            status: "completed",
            completedAt: nowIso(),
          };
        }
        if (idx === nextIndex) {
          return {
            ...step,
            status: "running",
            startedAt: nowIso(),
          };
        }
        return step;
      });

      const updatedSession = {
        ...activeSession,
        steps: updatedSteps,
      };

      const saved = await persistSession(updatedSession);
      setActiveSession(saved);

      emit({
        type: "session.step.completed",
        ts: nowIso(),
        source: SOURCE,
        data: {
          sessionId: saved.id,
          domain: saved.domain,
          stepId: activeSession.steps[currentIndex].id,
          index: currentIndex,
        },
      });

      if (nextIndex !== -1) {
        emit({
          type: "session.step.started",
          ts: nowIso(),
          source: SOURCE,
          data: {
            sessionId: saved.id,
            domain: saved.domain,
            stepId: saved.steps[nextIndex].id,
            index: nextIndex,
          },
        });
      } else {
        // That was the last step => complete the session
        const final = {
          ...saved,
          status: "completed",
          completedAt: nowIso(),
        };
        const persistedFinal = await persistSession(final);
        setActiveSession(persistedFinal);
        setIsRunning(false);
        setIsPaused(false);

        emit({
          type: "session.completed",
          ts: nowIso(),
          source: SOURCE,
          data: {
            sessionId: persistedFinal.id,
            domain: persistedFinal.domain,
          },
        });

        // 🔌 Direct hooks for downstream orchestration
        try {
          if (householdOrchestrator?.onSessionCompleted) {
            await householdOrchestrator.onSessionCompleted(persistedFinal);
          }
          if (sessionShim?.onSessionCompleted) {
            await sessionShim.onSessionCompleted(persistedFinal);
          }
        } catch (shimErr) {
          console.error(
            "[useSessionRunner] shim/orchestrator onSessionCompleted failed",
            shimErr
          );
          emit({
            type: "session.shim.onSessionCompleted.failed",
            ts: nowIso(),
            source: SOURCE,
            data: {
              sessionId: persistedFinal.id,
              domain: persistedFinal.domain,
              error: String(shimErr),
            },
          });
        }

        await tryReleaseWakeLock(wakeLockRef);
        await maybeExportToHubOnComplete(persistedFinal);

        return persistedFinal;
      }

      return saved;
    },
    [activeSession, persistSession]
  );

  /**
   * PUBLIC API: pause session
   */
  const pauseSession = useCallback(
    async () => {
      if (!activeSession) return null;

      const updated = {
        ...activeSession,
        status: "paused",
        updatedAt: nowIso(),
      };

      const saved = await persistSession(updated);
      setActiveSession(saved);
      setIsPaused(true);
      setIsRunning(false);

      emit({
        type: "session.paused",
        ts: nowIso(),
        source: SOURCE,
        data: { sessionId: saved.id, domain: saved.domain },
      });

      await tryReleaseWakeLock(wakeLockRef);

      return saved;
    },
    [activeSession, persistSession]
  );

  /**
   * PUBLIC API: resume session
   */
  const resumeSession = useCallback(
    async (sessionId = null) => {
      setError(null);

      try {
        let session = activeSession;

        if (!session && sessionId && db?.sessions) {
          session = await db.sessions.get(sessionId);
        }

        if (!session) return null;

        const updated = {
          ...session,
          status: "running",
          updatedAt: nowIso(),
        };

        const saved = await persistSession(updated);
        setActiveSession(saved);
        setIsRunning(true);
        setIsPaused(false);

        emit({
          type: "session.resumed",
          ts: nowIso(),
          source: SOURCE,
          data: { sessionId: saved.id, domain: saved.domain },
        });

        await tryAcquireWakeLock(wakeLockRef);

        return saved;
      } catch (err) {
        console.error("[useSessionRunner] resumeSession failed", err);
        setError(err);
        emit({
          type: "session.resume.failed",
          ts: nowIso(),
          source: SOURCE,
          data: { sessionId, error: String(err) },
        });
        return null;
      }
    },
    [activeSession, persistSession]
  );

  /**
   * PUBLIC API: cancel/stop session
   */
  const cancelSession = useCallback(
    async (reason = "user_cancelled") => {
      if (!activeSession) return null;

      const updated = {
        ...activeSession,
        status: "cancelled",
        cancelReason: reason,
        updatedAt: nowIso(),
      };

      const saved = await persistSession(updated);
      setActiveSession(saved);
      setIsRunning(false);
      setIsPaused(false);

      emit({
        type: "session.cancelled",
        ts: nowIso(),
        source: SOURCE,
        data: { sessionId: saved.id, domain: saved.domain, reason },
      });

      await tryReleaseWakeLock(wakeLockRef);

      return saved;
    },
    [activeSession, persistSession]
  );

  /**
   * PUBLIC API: mark a session as favorite (user-owned, not just system templates).
   */
  const markFavorite = useCallback(
    async (sessionId, label = null) => {
      if (!db?.sessionFavorites) return;

      const session =
        activeSession?.id === sessionId && activeSession
          ? activeSession
          : await db.sessions.get(sessionId);

      if (!session) return;

      const favorite = {
        id: `${sessionId}`,
        sessionId: session.id,
        domain: session.domain,
        title: label || session.title,
        createdAt: nowIso(),
        meta: {
          schedule: session.schedule || {},
          icon: session.icon || null,
        },
      };

      await db.sessionFavorites.put(favorite);
      await loadFavorites();

      emit({
        type: "session.favorited",
        ts: nowIso(),
        source: SOURCE,
        data: { sessionId: session.id, domain: session.domain },
      });

      return favorite;
    },
    [activeSession, loadFavorites]
  );

  /**
   * PUBLIC API: unmark a session as favorite.
   */
  const unmarkFavorite = useCallback(
    async (sessionId) => {
      if (!db?.sessionFavorites) return;

      await db.sessionFavorites.delete(sessionId);
      await loadFavorites();

      emit({
        type: "session.favorite.removed",
        ts: nowIso(),
        source: SOURCE,
        data: { sessionId },
      });
    },
    [loadFavorites]
  );

  /**
   * PUBLIC API: save a user-created schedule (recurring).
   */
  const saveSchedule = useCallback(
    async (scheduleConfig) => {
      if (!db?.sessionSchedules) return null;

      const schedule = {
        id: scheduleConfig.id || `sched_${Date.now()}`,
        title: scheduleConfig.title || "Household Schedule",
        domain: scheduleConfig.domain || "generic",
        sessionTemplateId: scheduleConfig.sessionTemplateId || null,
        recurrenceRule: scheduleConfig.recurrenceRule || null,
        startsAt: scheduleConfig.startsAt || nowIso(),
        timezone:
          scheduleConfig.timezone ||
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        meta: {
          ...scheduleConfig.meta,
        },
        createdAt: scheduleConfig.createdAt || nowIso(),
        updatedAt: nowIso(),
      };

      await db.sessionSchedules.put(schedule);
      await loadSchedules();

      emit({
        type: "session.schedule.saved",
        ts: nowIso(),
        source: SOURCE,
        data: { scheduleId: schedule.id, domain: schedule.domain },
      });

      return schedule;
    },
    [loadSchedules]
  );

  /**
   * PUBLIC API: load a specific session by ID (without starting it).
   */
  const loadSessionById = useCallback(async (sessionId) => {
    if (!db?.sessions) return null;
    const session = await db.sessions.get(sessionId);
    return session || null;
  }, []);

  /**
   * EFFECT: auto-resume last active on mount (if desired).
   */
  useEffect(() => {
    if (autoResume) {
      restoreLastActive();
    }
    loadFavorites();
    loadSchedules();

    // Re-acquire wake lock on visibility change if session is running
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && activeSession && isRunning) {
        tryAcquireWakeLock(wakeLockRef);
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      tryReleaseWakeLock(wakeLockRef);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResume]);

  /**
   * Derived info: current running step & progress
   */
  const currentStep =
    activeSession && Array.isArray(activeSession.steps)
      ? activeSession.steps.find((s) => s.status === "running") ||
        activeSession.steps.find((s) => s.status === "pending") ||
        null
      : null;

  const stats = computeSessionStats(activeSession);
  const progress =
    stats.totalSteps === 0
      ? 0
      : Math.round((stats.completedSteps / stats.totalSteps) * 100);

  return {
    // session state
    activeSession,
    isRunning,
    isPaused,
    currentStep,
    stats,
    progress,
    error,

    // favorites & schedules
    favorites,
    schedules,

    // core controls
    startSession,
    startReverseGeneratedSession,
    completeCurrentStep,
    pauseSession,
    resumeSession,
    cancelSession,

    // meta helpers
    markFavorite,
    unmarkFavorite,
    saveSchedule,
    loadSessionById,
  };
}
