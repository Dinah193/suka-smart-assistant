// C:\Users\larho\suka-smart-assistant\src\app\shared\session\SessionRunnerContext.js
/**
 * SessionRunnerContext (shared)
 * ---------------------------------------------------------------------------
 * Shared React Context for running sessions across SSA without hard dependencies.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
} from "react";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

const isoNow = () => new Date().toISOString();

function safeString(err) {
  try {
    if (err == null) return "";
    if (typeof err === "string") return err;
    if (err instanceof Error) return err.message || String(err);
    return String(err);
  } catch {
    return "Unknown error";
  }
}

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function randomId(prefix = "sess") {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${rand}`;
}

/**
 * Normalize a "session draft" into a runnable session object.
 * IMPORTANT: avoid duplicate keys in object literal (esbuild strict).
 */
function normalizeSession(input, opts = {}) {
  const domain = opts.domain || input?.domain || "generic";
  const intent = opts.intent || input?.intent || "unknown";

  const base =
    isObject(input) && (input.id || input.steps || input.plan || input.session)
      ? input.session || input
      : {};

  const id = base.id || randomId(domain);

  const steps = Array.isArray(base.steps)
    ? base.steps
    : Array.isArray(base.plan?.steps)
    ? base.plan.steps
    : [];

  const normalizedSteps = steps.map((s, idx) => {
    const step = isObject(s) ? s : { title: String(s) };
    return {
      id: step.id || `${id}_step_${idx}`,
      title: step.title || step.name || `Step ${idx + 1}`,
      status: step.status || "pending", // pending|active|done|skipped|blocked
      ...step,
    };
  });

  const currentStepIndex =
    typeof base.currentStepIndex === "number" && base.currentStepIndex >= 0
      ? base.currentStepIndex
      : 0;

  // Build object with spread order that guarantees our computed fields win
  // WITHOUT re-declaring keys twice in the same literal.
  const merged = {
    ...base,
    steps: normalizedSteps,
    metadata: isObject(base.metadata) ? base.metadata : {},
    analytics: isObject(base.analytics) ? base.analytics : {},
  };

  // Now assign "authoritative" computed values in a second step (no duplicate keys)
  merged.id = id;
  merged.domain = domain;
  merged.intent = intent;
  merged.title = merged.title || `${domain} session`;
  merged.createdAt = merged.createdAt || isoNow();
  merged.updatedAt = merged.updatedAt || isoNow();
  merged.status = merged.status || "draft";
  merged.currentStepIndex = currentStepIndex;

  return merged;
}

/* -------------------------------------------------------------------------- */
/* Optional adapters                                                          */
/* -------------------------------------------------------------------------- */

function defaultEmitter() {}

const defaultPersistence = {
  async upsertSession() {},
  async getSession() {
    return null;
  },
  async removeSession() {},
};

/* -------------------------------------------------------------------------- */
/* State + reducer                                                            */
/* -------------------------------------------------------------------------- */

const initialState = {
  activeSession: null,
  activeSessionId: null,
  status: "idle", // idle|running|paused|completed|aborted|error
  lastError: null,
  lastActionAt: null,
  lastEvent: null,
};

function reducer(state, action) {
  switch (action.type) {
    case "SET_ERROR":
      return {
        ...state,
        status: "error",
        lastError: action.error || "Unknown error",
        lastActionAt: isoNow(),
      };

    case "CLEAR_ERROR":
      return { ...state, lastError: null, lastActionAt: isoNow() };

    case "SET_ACTIVE_SESSION": {
      const sess = action.session || null;
      return {
        ...state,
        activeSession: sess,
        activeSessionId: sess?.id || null,
        status: sess ? action.status || "running" : "idle",
        lastError: null,
        lastActionAt: isoNow(),
      };
    }

    case "PATCH_SESSION": {
      if (!state.activeSession) return state;
      const patched = {
        ...state.activeSession,
        ...(action.patch || {}),
        updatedAt: isoNow(),
      };
      return {
        ...state,
        activeSession: patched,
        activeSessionId: patched.id,
        lastActionAt: isoNow(),
      };
    }

    case "SET_STATUS":
      return {
        ...state,
        status: action.status || state.status,
        lastActionAt: isoNow(),
      };

    case "SET_LAST_EVENT":
      return {
        ...state,
        lastEvent: action.event || null,
        lastActionAt: isoNow(),
      };

    default:
      return state;
  }
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

const SessionRunnerContext = createContext(null);

export function SessionRunnerProvider({
  children,
  adapters = {},
  defaults = {},
}) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const adaptersRef = useRef({
    emitter: adapters.emitter || defaultEmitter,
    persistence: adapters.persistence || defaultPersistence,
  });

  adaptersRef.current.emitter = adapters.emitter || defaultEmitter;
  adaptersRef.current.persistence = adapters.persistence || defaultPersistence;

  const emit = useCallback((type, data) => {
    const evt = {
      type,
      ts: isoNow(),
      source: "app/shared/session/SessionRunnerContext",
      data: data || {},
    };
    dispatch({ type: "SET_LAST_EVENT", event: evt });
    try {
      adaptersRef.current.emitter(evt);
    } catch {
      // never crash UI
    }
  }, []);

  const persist = useCallback(async (session) => {
    try {
      await adaptersRef.current.persistence.upsertSession(session);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: safeString(e) };
    }
  }, []);

  const startSession = useCallback(
    async ({
      session,
      domain,
      intent,
      title,
      input,
      context,
      runtime,
    } = {}) => {
      try {
        const normalized = normalizeSession(session || {}, {
          domain: domain || defaults.domain,
          intent: intent || defaults.intent,
        });

        const finalSession = {
          ...normalized,
          title: title || normalized.title,
          status: "active",
          startedAt: isoNow(),
          updatedAt: isoNow(),
          input: isObject(input) ? input : normalized.input,
          context: isObject(context) ? context : normalized.context,
          runtime: isObject(runtime) ? runtime : normalized.runtime,
        };

        dispatch({
          type: "SET_ACTIVE_SESSION",
          session: finalSession,
          status: "running",
        });

        emit("session.started", {
          sessionId: finalSession.id,
          domain: finalSession.domain,
          intent: finalSession.intent,
        });

        if (
          Array.isArray(finalSession.steps) &&
          finalSession.steps.length > 0
        ) {
          const idx =
            typeof finalSession.currentStepIndex === "number"
              ? finalSession.currentStepIndex
              : 0;

          const steps = finalSession.steps.map((s, i) => ({
            ...s,
            status:
              i === idx ? (s.status === "done" ? "done" : "active") : s.status,
          }));

          const patched = { ...finalSession, steps, currentStepIndex: idx };
          dispatch({ type: "PATCH_SESSION", patch: patched });
        }

        await persist({ ...finalSession });
        return { ok: true, session: finalSession };
      } catch (e) {
        const msg = safeString(e);
        dispatch({ type: "SET_ERROR", error: msg });
        emit("session.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
    [defaults.domain, defaults.intent, emit, persist]
  );

  const loadSession = useCallback(
    async (sessionId) => {
      try {
        if (!sessionId) return { ok: false, error: "Missing sessionId" };
        const s = await adaptersRef.current.persistence.getSession(sessionId);
        if (!s) return { ok: false, error: "Session not found" };

        const normalized = normalizeSession(s, {
          domain: s.domain || defaults.domain,
          intent: s.intent || defaults.intent,
        });

        dispatch({
          type: "SET_ACTIVE_SESSION",
          session: normalized,
          status:
            normalized.status === "paused"
              ? "paused"
              : normalized.status === "completed"
              ? "completed"
              : "running",
        });

        emit("session.loaded", {
          sessionId: normalized.id,
          domain: normalized.domain,
          intent: normalized.intent,
        });
        return { ok: true, session: normalized };
      } catch (e) {
        const msg = safeString(e);
        dispatch({ type: "SET_ERROR", error: msg });
        emit("session.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
    [defaults.domain, defaults.intent, emit]
  );

  const pauseSession = useCallback(async () => {
    try {
      if (!state.activeSession)
        return { ok: false, error: "No active session" };

      const patched = {
        ...state.activeSession,
        status: "paused",
        pausedAt: isoNow(),
        updatedAt: isoNow(),
      };
      dispatch({ type: "PATCH_SESSION", patch: patched });
      dispatch({ type: "SET_STATUS", status: "paused" });
      emit("session.paused", { sessionId: patched.id });
      await persist(patched);
      return { ok: true, session: patched };
    } catch (e) {
      const msg = safeString(e);
      dispatch({ type: "SET_ERROR", error: msg });
      emit("session.error", { error: msg });
      return { ok: false, error: msg };
    }
  }, [emit, persist, state.activeSession]);

  const resumeSession = useCallback(async () => {
    try {
      if (!state.activeSession)
        return { ok: false, error: "No active session" };

      const patched = {
        ...state.activeSession,
        status: "active",
        resumedAt: isoNow(),
        updatedAt: isoNow(),
      };
      dispatch({ type: "PATCH_SESSION", patch: patched });
      dispatch({ type: "SET_STATUS", status: "running" });
      emit("session.resumed", { sessionId: patched.id });
      await persist(patched);
      return { ok: true, session: patched };
    } catch (e) {
      const msg = safeString(e);
      dispatch({ type: "SET_ERROR", error: msg });
      emit("session.error", { error: msg });
      return { ok: false, error: msg };
    }
  }, [emit, persist, state.activeSession]);

  const setStepIndex = useCallback(
    async (index) => {
      try {
        const s = state.activeSession;
        if (!s) return { ok: false, error: "No active session" };
        const steps = Array.isArray(s.steps) ? s.steps : [];
        if (!steps.length) return { ok: false, error: "Session has no steps" };

        const nextIdx = Math.max(0, Math.min(index, steps.length - 1));

        const patchedSteps = steps.map((st, i) => ({
          ...st,
          status:
            i === nextIdx
              ? st.status === "done"
                ? "done"
                : "active"
              : st.status === "active"
              ? "pending"
              : st.status,
        }));

        const patched = {
          ...s,
          steps: patchedSteps,
          currentStepIndex: nextIdx,
          updatedAt: isoNow(),
        };
        dispatch({ type: "PATCH_SESSION", patch: patched });

        emit("session.step.changed", {
          sessionId: patched.id,
          stepIndex: nextIdx,
          stepId: patchedSteps[nextIdx]?.id || null,
          title: patchedSteps[nextIdx]?.title || null,
        });

        await persist(patched);
        return { ok: true, session: patched };
      } catch (e) {
        const msg = safeString(e);
        dispatch({ type: "SET_ERROR", error: msg });
        emit("session.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
    [emit, persist, state.activeSession]
  );

  const nextStep = useCallback(async () => {
    const s = state.activeSession;
    const idx =
      typeof s?.currentStepIndex === "number" ? s.currentStepIndex : 0;
    return setStepIndex(idx + 1);
  }, [setStepIndex, state.activeSession]);

  const prevStep = useCallback(async () => {
    const s = state.activeSession;
    const idx =
      typeof s?.currentStepIndex === "number" ? s.currentStepIndex : 0;
    return setStepIndex(idx - 1);
  }, [setStepIndex, state.activeSession]);

  const completeStep = useCallback(
    async (index = null) => {
      try {
        const s = state.activeSession;
        if (!s) return { ok: false, error: "No active session" };
        const steps = Array.isArray(s.steps) ? s.steps : [];
        if (!steps.length) return { ok: false, error: "Session has no steps" };

        const idx =
          typeof index === "number"
            ? Math.max(0, Math.min(index, steps.length - 1))
            : typeof s.currentStepIndex === "number"
            ? s.currentStepIndex
            : 0;

        const patchedSteps = steps.map((st, i) =>
          i === idx ? { ...st, status: "done", completedAt: isoNow() } : st
        );

        const patched = { ...s, steps: patchedSteps, updatedAt: isoNow() };
        dispatch({ type: "PATCH_SESSION", patch: patched });

        emit("session.step.completed", {
          sessionId: patched.id,
          stepIndex: idx,
          stepId: patchedSteps[idx]?.id || null,
        });

        await persist(patched);

        if (idx < patchedSteps.length - 1) {
          await setStepIndex(idx + 1);
        }

        return { ok: true, session: patched };
      } catch (e) {
        const msg = safeString(e);
        dispatch({ type: "SET_ERROR", error: msg });
        emit("session.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
    [emit, persist, setStepIndex, state.activeSession]
  );

  const finishSession = useCallback(
    async ({ status = "completed", notes } = {}) => {
      try {
        const s = state.activeSession;
        if (!s) return { ok: false, error: "No active session" };

        const patched = {
          ...s,
          status,
          finishedAt: isoNow(),
          updatedAt: isoNow(),
          ...(notes ? { notes } : {}),
        };

        dispatch({ type: "PATCH_SESSION", patch: patched });
        dispatch({
          type: "SET_STATUS",
          status: status === "completed" ? "completed" : "aborted",
        });

        emit("session.finished", { sessionId: patched.id, status });

        await persist(patched);
        return { ok: true, session: patched };
      } catch (e) {
        const msg = safeString(e);
        dispatch({ type: "SET_ERROR", error: msg });
        emit("session.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
    [emit, persist, state.activeSession]
  );

  const clearActiveSession = useCallback(async () => {
    try {
      const s = state.activeSession;
      if (s?.id) emit("session.cleared", { sessionId: s.id });
      dispatch({ type: "SET_ACTIVE_SESSION", session: null, status: "idle" });
      return { ok: true };
    } catch (e) {
      const msg = safeString(e);
      dispatch({ type: "SET_ERROR", error: msg });
      return { ok: false, error: msg };
    }
  }, [emit, state.activeSession]);

  const value = useMemo(() => {
    const active = state.activeSession;
    const steps = Array.isArray(active?.steps) ? active.steps : [];
    const currentIndex =
      typeof active?.currentStepIndex === "number"
        ? active.currentStepIndex
        : 0;

    return {
      state,
      activeSession: active,
      activeSessionId: state.activeSessionId,
      status: state.status,
      lastError: state.lastError,
      lastEvent: state.lastEvent,

      steps,
      currentStepIndex: currentIndex,
      currentStep: steps[currentIndex] || null,

      startSession,
      loadSession,
      pauseSession,
      resumeSession,
      setStepIndex,
      nextStep,
      prevStep,
      completeStep,
      finishSession,
      clearActiveSession,

      emit,
      persist,
      clearError: () => dispatch({ type: "CLEAR_ERROR" }),
    };
  }, [
    clearActiveSession,
    completeStep,
    emit,
    finishSession,
    loadSession,
    nextStep,
    pauseSession,
    persist,
    prevStep,
    resumeSession,
    setStepIndex,
    startSession,
    state,
  ]);

  return (
    <SessionRunnerContext.Provider value={value}>
      {children}
    </SessionRunnerContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* Hooks                                                                      */
/* -------------------------------------------------------------------------- */

export function useSessionRunner() {
  const ctx = useContext(SessionRunnerContext);
  if (!ctx) {
    throw new Error(
      "useSessionRunner must be used within a <SessionRunnerProvider />"
    );
  }
  return ctx;
}

export function useSessionRunnerState() {
  const ctx = useSessionRunner();
  return {
    status: ctx.status,
    lastError: ctx.lastError,
    activeSessionId: ctx.activeSessionId,
    activeSession: ctx.activeSession,
    steps: ctx.steps,
    currentStepIndex: ctx.currentStepIndex,
    currentStep: ctx.currentStep,
    lastEvent: ctx.lastEvent,
  };
}

export { SessionRunnerContext };

export default SessionRunnerProvider;
