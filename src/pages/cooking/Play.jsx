// C:\Users\larho\suka-smart-assistant\src\pages\cooking\Play.jsx
/* eslint-disable no-console */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import "./cooking.css";

/**
 * SSA — Cooking Session Play (interactive, local-first)
 * -----------------------------------------------------------------------------
 * Required features implemented:
 * 1) User flows:
 *    - start new session
 *    - resume session (from checkpoint)
 *    - swap session (modal)
 *    - pause / complete / abort
 *    - step list + current step view
 *
 * 2) Data contract:
 *    See SESSION CONTRACT below (id, domain, steps[], timers, artifacts, metadata, checkpoints).
 *
 * 3) State model:
 *    currentStepIndex, running/paused, timer state, blockers, validation,
 *    derived progress, loading states.
 *
 * 4) Persistence:
 *    Dexie sessionCheckpoints + kv (lastActiveSessionId per domain),
 *    soft-import db from multiple paths. Survives reload + navigation.
 *
 * 5) EventBus:
 *    Emits standardized events (minimum):
 *      session.started, session.resumed, session.step.changed,
 *      session.timer.started, session.timer.completed,
 *      session.completed, session.aborted
 *    Payload examples are produced in code.
 *    Soft-imports eventBus from:
 *      "@/services/events/eventBus.js" OR "../../services/events/eventBus"
 *
 * 6) Wiring:
 *    Defensive optional hooks (wake lock, TTS, notify). No hard Hub dependency.
 *    Will not crash if optional features missing.
 *
 * SSA rule reminder:
 * - Cooking sessions must consolidate steps into one comprehensive runnable session
 *   (all recipe steps + timers). This page assumes session.steps is already consolidated
 *   by your CookingSessionEngine / draftToPlay pipeline, but also defensively normalizes
 *   and flattens step timers for playback.
 */

/* -------------------------------------------------------------------------- */
/* Soft/defensive imports                                                     */
/* -------------------------------------------------------------------------- */

// eventBus (required by spec) - soft import
let eventBus = { emit: () => {}, on: () => () => {} };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb?.default || eb?.eventBus || eb || eventBus;
} catch {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const eb2 = require("../../services/events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2 || eventBus;
  } catch {}
}

// featureFlags - optional
let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  featureFlags = require("@/config/featureFlags.json") || featureFlags;
} catch {
  try {
    // eslint-disable-next-line global-require
    featureFlags = require("../../config/featureFlags.json") || featureFlags;
  } catch {}
}

// Wake lock - optional
let useWakeLock = () => ({ request: async () => {}, release: async () => {} });
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const wl = require("@/hooks/useWakeLock");
  useWakeLock = wl?.useWakeLock || wl?.default || wl || useWakeLock;
} catch {}

// TTS - optional
let speech = { speak: () => {}, cancel: () => {} };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const sp = require("@/services/speech");
  speech = sp?.default || sp || speech;
} catch {}

// notify - optional (vibrate / toast wrapper etc.)
let notify = {
  vibrate: (ms = 30) => (navigator?.vibrate ? navigator.vibrate(ms) : void 0),
};
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const nt = require("@/services/notify");
  notify = nt?.default || nt || notify;
} catch {}

// db - soft import (IMPORTANT: do NOT hard depend)
let db = null;
let getSessionById = null;
let saveSession = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require("@/services/db.js");
  db = mod?.db || mod?.default || mod;
  getSessionById = mod?.getSessionById || null;
  saveSession = mod?.saveSession || null;
} catch {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const mod2 = require("@/services/db");
    db = mod2?.db || mod2?.default || mod2;
    getSessionById = mod2?.getSessionById || null;
    saveSession = mod2?.saveSession || null;
  } catch {
    try {
      // eslint-disable-next-line global-require
      const mod3 = require("../../services/db");
      db = mod3?.db || mod3?.default || mod3;
      getSessionById = mod3?.getSessionById || null;
      saveSession = mod3?.saveSession || null;
    } catch {}
  }
}

/* -------------------------------------------------------------------------- */
/* Session Contract                                                           */
/* -------------------------------------------------------------------------- */
/**
 * SESSION CONTRACT (unified SSA session object)
 *
 * NOTE: PK strategy in Dexie:
 * - db.sessions has numeric PK ++id but canonical string id lives in session.sessionId (and alias id).
 * - This Play page uses the canonical *string* sessionId for routing/checkpoints/kv.
 *
 * {
 *   // identity
 *   sessionId: string,     // canonical stable id for routing/resume
 *   id: string,            // alias == sessionId (for back-compat)
 *   domain: "cooking",
 *   title?: string,
 *
 *   // playback core
 *   status: "draft"|"scheduled"|"running"|"paused"|"completed"|"aborted",
 *   steps: Array<{
 *     id: string,
 *     title?: string,
 *     text: string,
 *     // timers can be embedded:
 *     durationSec?: number,  // simple single timer
 *     timers?: Array<{
 *       id: string,
 *       label?: string,
 *       durationSec: number,
 *       autoStart?: boolean,
 *       autoAdvance?: boolean
 *     }>,
 *     // optional rich attachments:
 *     ingredients?: Array<{ name, qty, unit, notes? }>,
 *     equipment?: string[],
 *     artifacts?: object
 *   }>,
 *
 *   // artifacts + metadata
 *   artifacts?: {
 *     recipes?: any[],
 *     tools?: string[],
 *     utensils?: string[],
 *     equipment?: string[],
 *     inventoryLinks?: any[],
 *     notes?: string
 *   },
 *   metadata?: {
 *     source?: string,
 *     createdAt?: ISO,
 *     updatedAt?: ISO,
 *     version?: number,
 *     tags?: string[],
 *     servings?: number,
 *     nutrition?: object
 *   },
 *
 *   // checkpointing (stored separately in db.sessionCheckpoints)
 *   checkpoints?: {
 *     // optional in-session mirror; source-of-truth is sessionCheckpoints table
 *     lastCheckpointAt?: ISO
 *   }
 * }
 *
 * CHECKPOINT CONTRACT (db.sessionCheckpoints row)
 * {
 *   id: string,          // "cp_<sessionId>" (latest checkpoint per session)
 *   sessionId: string,
 *   domain: string,
 *   createdAt: ISO,
 *   updatedAt: ISO,
 *   status: string,
 *   currentStepIndex: number,
 *   timer: {
 *     activeTimerId: string|null,
 *     remainingSec: number,
 *     running: boolean
 *   },
 *   progress: {
 *     completedStepIds: string[],
 *     startedAt?: ISO,
 *     lastStepChangedAt?: ISO
 *   },
 *   // optional: any UI state you want to restore
 *   ui: { }
 * }
 */

/* -------------------------------------------------------------------------- */
/* Event helpers                                                              */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function emitSSAEvent(type, source, data) {
  // payload example shape (what consumers should expect)
  const payload = { type, ts: nowIso(), source, data };

  // Some parts of the repo call eventBus.emit(payload),
  // others call eventBus.emit(type, payload). We support both.
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      if (eventBus.emit.length >= 2) eventBus.emit(type, payload);
      else eventBus.emit(payload);
    }
  } catch (err) {
    if (import.meta?.env?.DEV) console.warn("[CookingPlay] emit failed:", err);
  }

  return payload;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

function makeId(prefix = "sess") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSession(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const sessionId = String(
    safe.sessionId || safe.id || safe.sid || safe._id || makeId("cook")
  );
  const stepsIn = Array.isArray(safe.steps) ? safe.steps : [];

  // Ensure consolidated cooking steps are runnable.
  // Also normalize timers so every step has timers[] (0..n).
  const steps = stepsIn
    .flatMap((s, i) => {
      const step = s && typeof s === "object" ? s : {};
      const baseId = String(step.id || `step_${i + 1}`);

      // If a step contains an array of substeps (rare), flatten it (defensive).
      if (Array.isArray(step.subSteps) && step.subSteps.length) {
        return step.subSteps.map((sub, j) => {
          const ss = sub && typeof sub === "object" ? sub : {};
          return normalizeStep(ss, `${baseId}_${j + 1}`, i, j);
        });
      }

      return [normalizeStep(step, baseId, i, 0)];
    })
    .filter(Boolean);

  return {
    ...safe,
    sessionId,
    id: sessionId, // alias for routing
    domain: "cooking",
    title: String(safe.title || safe.name || "Cooking Session"),
    status: String(safe.status || "draft"),
    steps,
    artifacts:
      safe.artifacts && typeof safe.artifacts === "object"
        ? safe.artifacts
        : {},
    metadata:
      safe.metadata && typeof safe.metadata === "object" ? safe.metadata : {},
  };
}

function normalizeStep(step, baseId, i /* step index */, j /* sub index */) {
  const text = String(step.text || step.instructions || step.body || "").trim();
  const title = String(step.title || step.name || `Step ${i + 1}`);
  const durationSec = toPositiveInt(step.durationSec || step.duration || 0);

  let timers = [];
  if (Array.isArray(step.timers)) {
    timers = step.timers
      .map((t, k) => {
        const tt = t && typeof t === "object" ? t : {};
        const dur = toPositiveInt(tt.durationSec || tt.duration || 0);
        if (!dur) return null;
        return {
          id: String(tt.id || `${baseId}_timer_${k + 1}`),
          label: String(tt.label || tt.name || "Timer"),
          durationSec: dur,
          autoStart: Boolean(tt.autoStart),
          autoAdvance: Boolean(tt.autoAdvance),
        };
      })
      .filter(Boolean);
  } else if (durationSec > 0) {
    // single-timer step fallback
    timers = [
      {
        id: `${baseId}_timer_1`,
        label: "Timer",
        durationSec,
        autoStart: false,
        autoAdvance: false,
      },
    ];
  }

  return {
    ...step,
    id: String(step.id || baseId),
    title,
    text,
    durationSec: durationSec || 0,
    timers,
  };
}

function toPositiveInt(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function formatMMSS(sec) {
  const t = Math.max(0, Math.floor(sec || 0));
  const m = String(Math.floor(t / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* -------------------------------------------------------------------------- */
/* Dexie checkpoint persistence helpers                                       */
/* -------------------------------------------------------------------------- */

async function kvGet(key) {
  try {
    if (!db?.kv) return null;
    const row = await db.kv.get(String(key));
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function kvSet(key, value) {
  try {
    if (!db?.kv) return;
    await db.kv.put({ key: String(key), value });
  } catch {}
}

async function saveCheckpoint(sessionId, domain, checkpoint) {
  try {
    if (!db?.sessionCheckpoints) return;
    const id = `cp_${sessionId}`; // latest checkpoint per session
    const now = nowIso();
    const row = {
      id,
      sessionId,
      domain,
      createdAt: checkpoint?.createdAt || now,
      updatedAt: now,
      ...checkpoint,
    };
    await db.sessionCheckpoints.put(row);
  } catch (err) {
    if (import.meta?.env?.DEV)
      console.warn("[CookingPlay] checkpoint save failed:", err);
  }
}

async function loadCheckpoint(sessionId) {
  try {
    if (!db?.sessionCheckpoints) return null;
    return await db.sessionCheckpoints.get(`cp_${sessionId}`);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Timer engine                                                               */
/* -------------------------------------------------------------------------- */

function useCountdownTimer({ onCompleted } = {}) {
  const [running, setRunning] = useState(false);
  const [remainingSec, setRemainingSec] = useState(0);
  const activeTimerIdRef = useRef(null);
  const startedAtRef = useRef(null);
  const initialDurationRef = useRef(0);
  const tickRef = useRef(null);

  const stop = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    setRunning(false);
    startedAtRef.current = null;
  }, []);

  const start = useCallback(
    (timerId, durationSec, resumeRemainingSec = null) => {
      const dur = toPositiveInt(durationSec);
      if (!dur) return;

      // if resuming with a remaining value, use it; else reset to full duration
      const startRemaining =
        resumeRemainingSec != null ? toPositiveInt(resumeRemainingSec) : dur;

      activeTimerIdRef.current = String(timerId || "timer");
      initialDurationRef.current = startRemaining;
      startedAtRef.current = Date.now();

      setRemainingSec(startRemaining);
      setRunning(true);

      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = setInterval(() => {
        if (!startedAtRef.current) return;
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
        const left = Math.max(initialDurationRef.current - elapsed, 0);
        setRemainingSec(left);
        if (left <= 0) {
          if (tickRef.current) clearInterval(tickRef.current);
          tickRef.current = null;
          setRunning(false);
          startedAtRef.current = null;
          try {
            onCompleted?.(activeTimerIdRef.current);
          } catch {}
        }
      }, 250);
    },
    [onCompleted]
  );

  useEffect(() => stop, [stop]);

  return {
    running,
    remainingSec,
    activeTimerId: activeTimerIdRef.current,
    start,
    stop,
    setRemainingSec,
    _setActiveTimerId: (id) => {
      activeTimerIdRef.current = id ? String(id) : null;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* UI bits                                                                    */
/* -------------------------------------------------------------------------- */

function Modal({ open, title, children, onClose }) {
  if (!open) return null;
  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          width: "min(720px, 96vw)",
          maxHeight: "80vh",
          overflow: "hidden",
          boxShadow: "0 24px 40px rgba(0,0,0,0.35)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: "12px 14px",
            borderBottom: "1px solid rgba(0,0,0,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontWeight: 800 }}>{title}</div>
          <button className="btn subtle" onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={{ padding: 14, overflow: "auto" }}>{children}</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Main component                                                             */
/* -------------------------------------------------------------------------- */

export default function Play() {
  const { id } = useParams(); // canonical sessionId (string) expected
  const navigate = useNavigate();
  const location = useLocation();

  const { request: wakeLockOn, release: wakeLockOff } = useWakeLock();

  // ------------------------------ State model ------------------------------
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);

  // playback state
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [status, setStatus] = useState("draft"); // running | paused | completed | aborted | etc.
  const [completedStepIds, setCompletedStepIds] = useState([]);

  // validation/blockers (for cooking you can use these later for "missing ingredients", etc.)
  const [blockers, setBlockers] = useState([]);
  const [validation, setValidation] = useState({ ok: true, issues: [] });

  // UI state
  const [swapOpen, setSwapOpen] = useState(false);
  const [swapLoading, setSwapLoading] = useState(false);
  const [swapList, setSwapList] = useState([]);
  const [error, setError] = useState(null);

  // timer state (single active timer at a time)
  const timer = useCountdownTimer({
    onCompleted: (timerId) => {
      // Emit timer completed and optionally auto-advance if configured
      const step = safeSteps[currentStepIndex] || null;
      const t = step?.timers?.find((x) => x.id === timerId) || null;

      emitSSAEvent("session.timer.completed", "pages.cooking.Play", {
        sessionId: session?.sessionId,
        domain: "cooking",
        stepIndex: currentStepIndex,
        stepId: step?.id || null,
        timerId,
        autoAdvance: Boolean(t?.autoAdvance),
      });

      try {
        notify.vibrate?.(60);
      } catch {}

      if (t?.autoAdvance) {
        // only auto-advance if currently running
        if (status === "running") {
          goNext();
        }
      }
    },
  });

  // Derived
  const safeSession = useMemo(
    () => (session ? normalizeSession(session) : null),
    [session]
  );

  const safeSteps = useMemo(() => safeSession?.steps || [], [safeSession]);
  const currentStep = useMemo(
    () => safeSteps[currentStepIndex] || null,
    [safeSteps, currentStepIndex]
  );

  const progress = useMemo(() => {
    const total = Math.max(1, safeSteps.length);
    const completed = completedStepIds.length;
    const pct = Math.round((completed / total) * 100);
    return { total, completed, pct };
  }, [safeSteps.length, completedStepIds.length]);

  const checkpointDebounceRef = useRef(null);
  const mountedRef = useRef(false);

  // ------------------------------ Persistence ------------------------------
  const persistCheckpoint = useCallback(
    async (override = {}) => {
      if (!safeSession?.sessionId) return;

      const ck = {
        status,
        currentStepIndex,
        timer: {
          activeTimerId: timer.activeTimerId || null,
          remainingSec: timer.remainingSec || 0,
          running: Boolean(timer.running),
        },
        progress: {
          completedStepIds,
          startedAt: override?.progress?.startedAt || null,
          lastStepChangedAt: nowIso(),
        },
        ui: {},
      };

      await saveCheckpoint(safeSession.sessionId, "cooking", {
        ...ck,
        ...override,
      });
      await kvSet(`lastActiveSessionId:cooking`, safeSession.sessionId);
    },
    [
      safeSession?.sessionId,
      status,
      currentStepIndex,
      timer.activeTimerId,
      timer.remainingSec,
      timer.running,
      completedStepIds,
    ]
  );

  const scheduleCheckpoint = useCallback(
    (override = {}) => {
      if (checkpointDebounceRef.current)
        clearTimeout(checkpointDebounceRef.current);
      checkpointDebounceRef.current = setTimeout(() => {
        void persistCheckpoint(override);
      }, 250);
    },
    [persistCheckpoint]
  );

  // ------------------------------ Navigation helpers ------------------------
  const closeToCooking = useCallback(() => {
    navigate("/cooking");
  }, [navigate]);

  const goToSession = useCallback(
    (sessionId) => {
      navigate(`/cooking/play/${encodeURIComponent(sessionId)}`, {
        replace: true,
      });
    },
    [navigate]
  );

  // ------------------------------ Load session + checkpoint -----------------
  const loadSession = useCallback(
    async (requestedId) => {
      setLoading(true);
      setError(null);

      try {
        const stateSession =
          location?.state?.session || location?.state?.play || null;

        // Find which sessionId to load:
        // 1) route param id
        // 2) location state session
        // 3) kv lastActiveSessionId
        let sessionId = requestedId ? String(requestedId) : null;
        if (!sessionId && stateSession?.sessionId)
          sessionId = String(stateSession.sessionId);
        if (!sessionId && stateSession?.id) sessionId = String(stateSession.id);
        if (!sessionId) {
          const last = await kvGet("lastActiveSessionId:cooking");
          if (last) sessionId = String(last);
        }

        // If nothing is available, return to Cooking.
        if (!sessionId && !stateSession) {
          setLoading(false);
          closeToCooking();
          return;
        }

        // Load session object
        let loadedSession = null;

        if (stateSession) {
          loadedSession = normalizeSession(stateSession);
        } else if (sessionId && typeof getSessionById === "function") {
          loadedSession = await getSessionById(sessionId);
          loadedSession = loadedSession
            ? normalizeSession(loadedSession)
            : null;
        } else if (sessionId && db?.sessions) {
          // Fallback direct query
          loadedSession =
            (await db.sessions.where("sessionId").equals(sessionId).first()) ||
            (await db.sessions.where("id").equals(sessionId).first()) ||
            null;

          loadedSession = loadedSession
            ? normalizeSession(loadedSession)
            : null;
        }

        if (!loadedSession) {
          setLoading(false);
          setError(`Could not load session "${sessionId || "(unknown)"}"`);
          return;
        }

        // Load checkpoint (if any)
        const ck = await loadCheckpoint(loadedSession.sessionId);

        const ckStepIndex = ck?.currentStepIndex;
        const restoredStepIndex =
          typeof ckStepIndex === "number"
            ? clamp(
                ckStepIndex,
                0,
                Math.max(0, (loadedSession.steps?.length || 1) - 1)
              )
            : 0;

        const restoredStatus = ck?.status || loadedSession.status || "draft";
        const restoredCompleted = Array.isArray(ck?.progress?.completedStepIds)
          ? ck.progress.completedStepIds
          : [];

        // Timer restore
        const restoreTimer =
          ck?.timer && typeof ck.timer === "object" ? ck.timer : null;

        // Commit
        setSession(loadedSession);
        setCurrentStepIndex(restoredStepIndex);
        setStatus(restoredStatus === "running" ? "paused" : restoredStatus); // safety: never auto-run on load
        setCompletedStepIds(restoredCompleted);

        // blockers/validation: basic checks for consolidated steps
        const issues = [];
        if (
          !Array.isArray(loadedSession.steps) ||
          loadedSession.steps.length === 0
        ) {
          issues.push("This session has no runnable steps.");
        }
        const ok = issues.length === 0;
        setValidation({ ok, issues });
        setBlockers(
          ok ? [] : issues.map((msg) => ({ type: "validation", message: msg }))
        );

        // Restore timer state without auto-starting
        if (restoreTimer?.activeTimerId) {
          timer._setActiveTimerId(restoreTimer.activeTimerId);
          timer.setRemainingSec(toPositiveInt(restoreTimer.remainingSec || 0));
        } else {
          timer._setActiveTimerId(null);
          timer.setRemainingSec(0);
        }

        setLoading(false);

        // Wake lock (best effort) while Play page is open
        try {
          await wakeLockOn?.();
        } catch {}

        // Emit resume/start event depending on checkpoint presence
        if (ck) {
          emitSSAEvent("session.resumed", "pages.cooking.Play", {
            sessionId: loadedSession.sessionId,
            domain: "cooking",
            restored: {
              status: restoredStatus,
              currentStepIndex: restoredStepIndex,
              activeTimerId: restoreTimer?.activeTimerId || null,
              remainingSec: restoreTimer?.remainingSec || 0,
              completedSteps: restoredCompleted.length,
            },
          });
        } else {
          emitSSAEvent("session.started", "pages.cooking.Play", {
            sessionId: loadedSession.sessionId,
            domain: "cooking",
            title: loadedSession.title,
            steps: loadedSession.steps?.length || 0,
          });
        }

        // Persist lastActiveSessionId immediately
        await kvSet(`lastActiveSessionId:cooking`, loadedSession.sessionId);
      } catch (err) {
        setLoading(false);
        setError(String(err?.message || err || "Unknown load error"));
      }
    },
    [location?.state, closeToCooking, timer, wakeLockOn]
  );

  // initial load + when route id changes
  useEffect(() => {
    mountedRef.current = true;
    void loadSession(id);

    return () => {
      mountedRef.current = false;
      if (checkpointDebounceRef.current)
        clearTimeout(checkpointDebounceRef.current);
      try {
        timer.stop();
      } catch {}
      try {
        speech.cancel?.();
      } catch {}
      (async () => {
        try {
          await wakeLockOff?.();
        } catch {}
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Auto-announce steps (optional)
  useEffect(() => {
    if (!safeSession || !currentStep) return;
    if (status !== "running") return;

    const msg = currentStep?.text || currentStep?.title || "Next step";
    try {
      speech.speak?.(msg);
    } catch {}

    try {
      notify.vibrate?.(35);
    } catch {}

    emitSSAEvent("session.step.changed", "pages.cooking.Play", {
      sessionId: safeSession.sessionId,
      domain: "cooking",
      stepIndex: currentStepIndex,
      stepId: currentStep.id,
      title: currentStep.title || null,
    });

    scheduleCheckpoint({
      progress: { lastStepChangedAt: nowIso() },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStepIndex, status]);

  // Save session status into db.sessions (best effort) so list ordering updates
  const persistSessionRow = useCallback(
    async (nextStatus) => {
      try {
        if (!safeSession) return;
        if (typeof saveSession === "function") {
          await saveSession({
            ...safeSession,
            status: nextStatus,
            updatedAt: nowIso(),
          });
          return;
        }
        // fallback: if db.sessions exists, update by sessionId
        if (db?.sessions && safeSession.sessionId) {
          const existing = await db.sessions
            .where("sessionId")
            .equals(safeSession.sessionId)
            .first();
          if (existing && typeof existing.id === "number") {
            await db.sessions.update(existing.id, {
              status: nextStatus,
              updatedAt: nowIso(),
            });
          }
        }
      } catch {}
    },
    [safeSession]
  );

  // ------------------------------ User flows --------------------------------
  const startOrResume = useCallback(async () => {
    if (!safeSession) return;
    if (!validation.ok) return;

    setStatus("running");
    await persistSessionRow("running");

    emitSSAEvent("session.started", "pages.cooking.Play", {
      sessionId: safeSession.sessionId,
      domain: "cooking",
      title: safeSession.title,
      steps: safeSteps.length,
      // payload example for downstream automation:
      example: {
        sessionId: safeSession.sessionId,
        stepIndex: currentStepIndex,
        timer: { activeTimerId: null, remainingSec: 0 },
      },
    });

    scheduleCheckpoint({
      status: "running",
      progress: { startedAt: nowIso() },
    });

    // Auto-start first timer if configured
    const firstTimer = (safeSteps[currentStepIndex]?.timers || []).find(
      (t) => t.autoStart
    );
    if (firstTimer) {
      timer.start(firstTimer.id, firstTimer.durationSec);
      emitSSAEvent("session.timer.started", "pages.cooking.Play", {
        sessionId: safeSession.sessionId,
        domain: "cooking",
        stepIndex: currentStepIndex,
        stepId: safeSteps[currentStepIndex]?.id || null,
        timerId: firstTimer.id,
        durationSec: firstTimer.durationSec,
      });
      scheduleCheckpoint({
        timer: {
          activeTimerId: firstTimer.id,
          remainingSec: firstTimer.durationSec,
          running: true,
        },
      });
    }
  }, [
    safeSession,
    validation.ok,
    persistSessionRow,
    scheduleCheckpoint,
    safeSteps,
    currentStepIndex,
    timer,
  ]);

  const pause = useCallback(async () => {
    if (!safeSession) return;
    timer.stop();
    setStatus("paused");
    await persistSessionRow("paused");
    scheduleCheckpoint({ status: "paused", timer: { running: false } });
  }, [safeSession, timer, persistSessionRow, scheduleCheckpoint]);

  const abort = useCallback(async () => {
    if (!safeSession) return;
    timer.stop();
    setStatus("aborted");
    await persistSessionRow("aborted");

    emitSSAEvent("session.aborted", "pages.cooking.Play", {
      sessionId: safeSession.sessionId,
      domain: "cooking",
      stepIndex: currentStepIndex,
      completedSteps: completedStepIds.length,
    });

    await saveCheckpoint(safeSession.sessionId, "cooking", {
      status: "aborted",
      currentStepIndex,
      timer: { activeTimerId: null, remainingSec: 0, running: false },
      progress: { completedStepIds },
    });

    closeToCooking();
  }, [
    safeSession,
    timer,
    persistSessionRow,
    currentStepIndex,
    completedStepIds,
    closeToCooking,
  ]);

  const complete = useCallback(async () => {
    if (!safeSession) return;
    timer.stop();
    setStatus("completed");
    await persistSessionRow("completed");

    emitSSAEvent("session.completed", "pages.cooking.Play", {
      sessionId: safeSession.sessionId,
      domain: "cooking",
      completedSteps: progress.total,
      percent: 100,
    });

    await saveCheckpoint(safeSession.sessionId, "cooking", {
      status: "completed",
      currentStepIndex: Math.max(0, progress.total - 1),
      timer: { activeTimerId: null, remainingSec: 0, running: false },
      progress: {
        completedStepIds: Array.from(
          new Set([...completedStepIds, ...safeSteps.map((s) => s.id)])
        ),
      },
    });

    closeToCooking();
  }, [
    safeSession,
    timer,
    persistSessionRow,
    progress.total,
    completedStepIds,
    safeSteps,
    closeToCooking,
  ]);

  const markStepComplete = useCallback(() => {
    if (!currentStep) return;
    setCompletedStepIds((prev) => {
      if (prev.includes(currentStep.id)) return prev;
      return [...prev, currentStep.id];
    });
  }, [currentStep]);

  const goPrev = useCallback(() => {
    if (!safeSession) return;
    timer.stop();
    setCurrentStepIndex((i) =>
      clamp(i - 1, 0, Math.max(0, safeSteps.length - 1))
    );
    scheduleCheckpoint({ timer: { running: false } });
  }, [safeSession, timer, safeSteps.length, scheduleCheckpoint]);

  const goNext = useCallback(() => {
    if (!safeSession) return;

    // step complete bookkeeping
    markStepComplete();

    timer.stop();

    const lastIndex = Math.max(0, safeSteps.length - 1);
    if (currentStepIndex >= lastIndex) {
      // complete session
      void complete();
      return;
    }

    const nextIndex = clamp(currentStepIndex + 1, 0, lastIndex);
    setCurrentStepIndex(nextIndex);

    // checkpoint save
    scheduleCheckpoint({
      currentStepIndex: nextIndex,
      timer: { running: false },
    });

    // Auto-start any timer with autoStart on the next step
    const nextStep = safeSteps[nextIndex] || null;
    const auto = (nextStep?.timers || []).find((t) => t.autoStart);
    if (auto && status === "running") {
      timer.start(auto.id, auto.durationSec);
      emitSSAEvent("session.timer.started", "pages.cooking.Play", {
        sessionId: safeSession.sessionId,
        domain: "cooking",
        stepIndex: nextIndex,
        stepId: nextStep?.id || null,
        timerId: auto.id,
        durationSec: auto.durationSec,
      });
      scheduleCheckpoint({
        timer: {
          activeTimerId: auto.id,
          remainingSec: auto.durationSec,
          running: true,
        },
      });
    }
  }, [
    safeSession,
    timer,
    safeSteps,
    currentStepIndex,
    scheduleCheckpoint,
    markStepComplete,
    complete,
    status,
  ]);

  // ------------------------------ Timer controls -----------------------------
  const startTimer = useCallback(
    (timerObj) => {
      if (!safeSession || !currentStep || !timerObj) return;
      if (status !== "running") return;

      const dur = toPositiveInt(timerObj.durationSec);
      if (!dur) return;

      timer.start(timerObj.id, dur);

      emitSSAEvent("session.timer.started", "pages.cooking.Play", {
        sessionId: safeSession.sessionId,
        domain: "cooking",
        stepIndex: currentStepIndex,
        stepId: currentStep.id,
        timerId: timerObj.id,
        durationSec: dur,
      });

      scheduleCheckpoint({
        timer: { activeTimerId: timerObj.id, remainingSec: dur, running: true },
      });
    },
    [
      safeSession,
      currentStep,
      status,
      timer,
      currentStepIndex,
      scheduleCheckpoint,
    ]
  );

  const pauseTimer = useCallback(() => {
    timer.stop();
    scheduleCheckpoint({ timer: { running: false } });
  }, [timer, scheduleCheckpoint]);

  const resumeTimer = useCallback(() => {
    if (status !== "running") return;
    if (!timer.activeTimerId) return;
    const remaining = toPositiveInt(timer.remainingSec);
    if (!remaining) return;
    timer.start(timer.activeTimerId, remaining, remaining);
    scheduleCheckpoint({ timer: { running: true } });
  }, [status, timer, scheduleCheckpoint]);

  // ------------------------------ Swap session modal -------------------------
  const openSwap = useCallback(async () => {
    setSwapOpen(true);
    setSwapLoading(true);
    setSwapList([]);

    try {
      if (!db?.sessions) {
        setSwapList([]);
        setSwapLoading(false);
        return;
      }

      // Grab latest sessions for cooking (by updatedAt if available).
      // db.sessions PK is numeric; sessionId is indexed.
      let rows = [];
      try {
        rows = await db.sessions.where("domain").equals("cooking").toArray();
      } catch {
        // if domain index missing, fallback to full scan
        rows = await db.sessions.toCollection().toArray();
        rows = rows.filter(
          (r) => String(r.domain || "").toLowerCase() === "cooking"
        );
      }

      rows.sort((a, b) =>
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
      );
      rows = rows.slice(0, 20);

      setSwapList(
        rows.map((r) => ({
          sessionId: String(r.sessionId || r.id || ""),
          title: String(r.title || r.name || "Cooking Session"),
          status: String(r.status || "draft"),
          updatedAt: String(r.updatedAt || ""),
          steps: Array.isArray(r.steps) ? r.steps.length : 0,
        }))
      );
    } catch (err) {
      if (import.meta?.env?.DEV)
        console.warn("[CookingPlay] swap list load failed:", err);
    } finally {
      setSwapLoading(false);
    }
  }, []);

  const doSwap = useCallback(
    async (sessionId) => {
      if (!sessionId) return;
      // Save checkpoint for current session before leaving
      scheduleCheckpoint();

      // Stop timers and go to new session
      timer.stop();
      setSwapOpen(false);
      goToSession(sessionId);
    },
    [scheduleCheckpoint, timer, goToSession]
  );

  // ------------------------------ Keyboard shortcuts -------------------------
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") {
        // do not auto-abort; just leave (checkpoint persists)
        closeToCooking();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        if (status !== "running") return;
        if (timer.running) pauseTimer();
        else resumeTimer();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closeToCooking,
    goNext,
    goPrev,
    status,
    timer.running,
    pauseTimer,
    resumeTimer,
  ]);

  // ------------------------------ UI render ---------------------------------
  if (loading) {
    return (
      <div className="cook-play loading" style={pageShellStyle()}>
        <div style={cardStyle()}>
          <div style={headerRowStyle()}>
            <div style={{ fontWeight: 900 }}>Cooking Session</div>
            <button className="btn subtle" onClick={closeToCooking}>
              Close
            </button>
          </div>
          <div style={{ padding: 14 }}>
            <div className="spinner" />
            <div className="subtle" style={{ marginTop: 8 }}>
              Loading session…
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !safeSession) {
    return (
      <div className="cook-play error" style={pageShellStyle()}>
        <div style={cardStyle()}>
          <div style={headerRowStyle()}>
            <div style={{ fontWeight: 900 }}>Cooking Session</div>
            <button className="btn subtle" onClick={closeToCooking}>
              Close
            </button>
          </div>
          <div style={{ padding: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>
              Missing session
            </div>
            <div className="subtle">
              {error || "We couldn't find a session to play."}
            </div>
            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button className="btn" onClick={closeToCooking}>
                Back to Cooking
              </button>
              <button className="btn subtle" onClick={openSwap}>
                Swap session
              </button>
            </div>
          </div>
        </div>

        <Modal
          open={swapOpen}
          title="Swap session"
          onClose={() => setSwapOpen(false)}
        >
          <SwapList loading={swapLoading} items={swapList} onPick={doSwap} />
        </Modal>
      </div>
    );
  }

  const canRun = validation.ok && blockers.length === 0;
  const lastIndex = Math.max(0, safeSteps.length - 1);
  const isLast = currentStepIndex >= lastIndex;

  return (
    <div className="cook-play" style={pageShellStyle()}>
      <div style={cardStyle()}>
        {/* Header */}
        <div style={headerRowStyle()}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 900, fontSize: 18, lineHeight: 1.1 }}>
              {safeSession.title || "Cooking Session"}
            </div>
            <div className="subtle" style={{ marginTop: 4 }}>
              Step {currentStepIndex + 1} of {progress.total} • {progress.pct}%
              complete • Status: <b>{status}</b>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn subtle" onClick={openSwap}>
              Swap
            </button>
            <button className="btn subtle" onClick={closeToCooking}>
              Close
            </button>
          </div>
        </div>

        {/* Blockers / validation */}
        {!canRun && (
          <div
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid rgba(0,0,0,0.08)",
            }}
          >
            <div style={{ fontWeight: 800, marginBottom: 6 }}>
              Can’t run yet
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {validation.issues.map((x) => (
                <li key={x} className="subtle">
                  {x}
                </li>
              ))}
              {blockers.map((b, i) => (
                <li key={`${b.type || "block"}_${i}`} className="subtle">
                  {b.message || String(b)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Body */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "260px 1fr",
            gap: 12,
            padding: 12,
          }}
        >
          {/* Step list */}
          <div
            style={{
              borderRight: "1px solid rgba(0,0,0,0.08)",
              paddingRight: 12,
              maxHeight: "70vh",
              overflow: "auto",
            }}
          >
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Steps</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {safeSteps.map((s, i) => {
                const done = completedStepIds.includes(s.id);
                const active = i === currentStepIndex;
                return (
                  <button
                    key={s.id}
                    className={`btn ${active ? "" : "subtle"}`}
                    style={{
                      textAlign: "left",
                      justifyContent: "flex-start",
                      gap: 8,
                      opacity: active ? 1 : 0.95,
                      whiteSpace: "normal",
                    }}
                    onClick={() => {
                      timer.stop();
                      setCurrentStepIndex(i);
                      scheduleCheckpoint({
                        currentStepIndex: i,
                        timer: { running: false },
                      });
                    }}
                  >
                    <span style={{ width: 18, textAlign: "center" }}>
                      {done ? "✓" : i + 1}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 13 }}>
                        {s.title || `Step ${i + 1}`}
                      </div>
                      <div
                        className="subtle"
                        style={{ fontSize: 12, marginTop: 2 }}
                      >
                        {truncate(s.text, 70)}
                      </div>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Current step view */}
          <div style={{ minWidth: 0, maxHeight: "70vh", overflow: "auto" }}>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>
                  {currentStep?.title || "Step"}
                </div>
                <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                  {currentStep?.text || ""}
                </div>
              </div>

              <div
                style={{
                  flexShrink: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  alignItems: "flex-end",
                }}
              >
                {status !== "running" ? (
                  <button
                    className="btn"
                    onClick={startOrResume}
                    disabled={!canRun}
                  >
                    {status === "paused" ? "Resume session" : "Start session"}
                  </button>
                ) : (
                  <button className="btn subtle" onClick={pause}>
                    Pause session
                  </button>
                )}

                <button className="btn subtle" onClick={abort}>
                  Abort
                </button>
              </div>
            </div>

            {/* Timers */}
            <div
              style={{
                marginTop: 16,
                paddingTop: 12,
                borderTop: "1px solid rgba(0,0,0,0.08)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div style={{ fontWeight: 800 }}>Timers</div>
                <div className="subtle">
                  Active: <b>{timer.activeTimerId || "none"}</b> • Remaining:{" "}
                  <b>{formatMMSS(timer.remainingSec || 0)}</b>
                </div>
              </div>

              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {(currentStep?.timers || []).length ? (
                  (currentStep.timers || []).map((t) => {
                    const isActive = timer.activeTimerId === t.id;
                    return (
                      <div
                        key={t.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 10,
                          border: "1px solid rgba(0,0,0,0.08)",
                          borderRadius: 12,
                          padding: "8px 10px",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 800 }}>
                            {t.label || "Timer"}{" "}
                            <span
                              className="subtle"
                              style={{ fontWeight: 600 }}
                            >
                              ({formatMMSS(t.durationSec)})
                            </span>
                          </div>
                          <div
                            className="subtle"
                            style={{ fontSize: 12, marginTop: 2 }}
                          >
                            {t.autoStart ? "Auto-start" : "Manual start"}
                            {t.autoAdvance ? " • Auto-advance" : ""}
                          </div>
                        </div>

                        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                          <button
                            className={`btn ${
                              isActive && timer.running ? "subtle" : ""
                            }`}
                            onClick={() => startTimer(t)}
                            disabled={status !== "running"}
                          >
                            Start
                          </button>
                          <button
                            className="btn subtle"
                            onClick={pauseTimer}
                            disabled={!isActive || !timer.running}
                          >
                            Pause
                          </button>
                          <button
                            className="btn subtle"
                            onClick={resumeTimer}
                            disabled={
                              !isActive ||
                              timer.running ||
                              status !== "running" ||
                              !timer.remainingSec
                            }
                          >
                            Resume
                          </button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="subtle">No timers for this step.</div>
                )}
              </div>
            </div>

            {/* Navigation controls */}
            <div
              style={{
                marginTop: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <button
                className="btn subtle"
                onClick={goPrev}
                disabled={currentStepIndex <= 0}
              >
                ← Previous
              </button>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn subtle"
                  onClick={() => {
                    markStepComplete();
                    scheduleCheckpoint();
                  }}
                  disabled={!currentStep}
                >
                  Mark step done
                </button>

                <button
                  className="btn"
                  onClick={goNext}
                  disabled={!currentStep}
                >
                  {isLast ? "Finish session" : "Next →"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={swapOpen}
        title="Swap session"
        onClose={() => setSwapOpen(false)}
      >
        <SwapList loading={swapLoading} items={swapList} onPick={doSwap} />
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Swap list component                                                        */
/* -------------------------------------------------------------------------- */

function SwapList({ loading, items, onPick }) {
  if (loading) return <div className="subtle">Loading sessions…</div>;
  if (!items?.length)
    return <div className="subtle">No recent cooking sessions found.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((s) => (
        <button
          key={s.sessionId}
          className="btn"
          style={{
            textAlign: "left",
            justifyContent: "flex-start",
            whiteSpace: "normal",
          }}
          onClick={() => onPick?.(s.sessionId)}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 900 }}>{s.title}</div>
            <div className="subtle" style={{ marginTop: 2 }}>
              {s.steps} steps • status: <b>{s.status}</b> • updated:{" "}
              {s.updatedAt || "—"}
            </div>
            <div className="subtle" style={{ marginTop: 2 }}>
              sessionId: {s.sessionId}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Small helpers/styles                                                       */
/* -------------------------------------------------------------------------- */

function truncate(str, max = 120) {
  const s = String(str || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function pageShellStyle() {
  return {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 12,
    zIndex: 999,
  };
}

function cardStyle() {
  return {
    background: "#fff",
    borderRadius: 20,
    width: "min(980px, 98vw)",
    maxHeight: "88vh",
    overflow: "hidden",
    boxShadow: "0 24px 40px rgba(0,0,0,0.35)",
    display: "flex",
    flexDirection: "column",
  };
}

function headerRowStyle() {
  return {
    padding: "12px 14px",
    borderBottom: "1px solid rgba(0,0,0,0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  };
}
