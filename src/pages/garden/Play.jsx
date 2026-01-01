// C:\Users\larho\suka-smart-assistant\src\pages\garden\Play.jsx
/* eslint-disable no-console */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

/**
 * Garden Play — Interactive Session Execution (NOT static)
 * -------------------------------------------------------
 * User flows (required):
 *  - start new session
 *  - resume session
 *  - swap session
 *  - pause
 *  - complete
 *  - abort
 *  - step list + current step view
 *
 * Persistence (required):
 *  - Dexie: save/load session checkpoints so it survives reload/navigation
 *  - store lastActiveSessionId per domain
 *  - soft-import db + eventBus + optional hooks
 *
 * EventBus (required):
 *  - session.started
 *  - session.resumed
 *  - session.step.changed
 *  - session.timer.started
 *  - session.timer.completed
 *  - session.completed
 *  - session.aborted
 *
 * SSA rules:
 *  - No TypeScript
 *  - Defensive imports
 *  - No hard dependency on Hub
 *  - Keep UI simple but functional
 */

/* ------------------------------ Soft Imports ------------------------------ */

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb?.default || eb?.eventBus || eb || eventBus;
} catch {
  try {
    // eslint-disable-next-line global-require
    const eb2 = require("../../services/events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2 || eventBus;
  } catch {}
}

let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  featureFlags =
    require("@/config/featureFlags.json")?.default ||
    require("@/config/featureFlags.json");
} catch {
  try {
    // eslint-disable-next-line global-require
    featureFlags =
      require("../../config/featureFlags.json")?.default ||
      require("../../config/featureFlags.json");
  } catch {}
}

let speech = { speak: () => {}, cancel: () => {} };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  speech =
    require("@/services/speech")?.default || require("@/services/speech");
} catch {}

let notify = {
  vibrate: (ms = 30) => (navigator.vibrate ? navigator.vibrate(ms) : undefined),
};
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  notify =
    require("@/services/notify")?.default || require("@/services/notify");
} catch {}

let useWakeLock = () => ({ request: async () => {}, release: async () => {} });
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  useWakeLock =
    require("@/hooks/useWakeLock")?.useWakeLock ||
    require("@/hooks/useWakeLock");
} catch {}

let db = null;
try {
  // Your project uses: C:\Users\larho\suka-smart-assistant\src\services\db.js
  // eslint-disable-next-line global-require, import/no-unresolved
  db = require("@/services/db").default || require("@/services/db");
} catch {
  try {
    // eslint-disable-next-line global-require
    db = require("../../services/db").default || require("../../services/db");
  } catch {}
}

/* ------------------------------ Data Contract ------------------------------ */
/**
 * Unified SSA Session Contract (minimal but future-proof)
 *
 * @typedef {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} SSADomain
 *
 * @typedef {Object} SSATimer
 * @property {string} id
 * @property {string} label
 * @property {number} durationSec
 *
 * @typedef {Object} SSAStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} [durationSec]         // primary timer for the step
 * @property {SSATimer[]} [timers]          // optional extra timers (multi-timer-ready)
 * @property {Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment">} [blockers]
 * @property {Object} [validation]          // optional checks
 * @property {boolean} [validation.requiredConfirm]
 * @property {string} [validation.prompt]
 * @property {Object} [metadata]
 *
 * @typedef {Object} SSASessionArtifacts
 * @property {Object} [harvestLog]          // garden-specific example
 * @property {Object} [issues]              // pests/disease notes
 * @property {Object} [photos]              // optional media refs
 *
 * @typedef {Object} SSASessionProgress
 * @property {number} currentStepIndex
 * @property {number} elapsedSec
 * @property {string|null} startedAt
 * @property {string|null} pausedAt
 *
 * @typedef {Object} SSASessionCheckpoint
 * @property {string} id
 * @property {string} sessionId
 * @property {SSADomain} domain
 * @property {number} currentStepIndex
 * @property {Object} timer                // persisted timer state snapshot
 * @property {boolean} timer.running
 * @property {number} timer.remainingSec
 * @property {string|null} timer.startedAt
 * @property {string|null} timer.stepId
 * @property {string} status               // "running"|"paused"|...
 * @property {SSASessionArtifacts} artifacts
 * @property {Object} metadata
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} SSASession
 * @property {string} id                   // canonical stable id (string)
 * @property {SSADomain} domain
 * @property {string} title
 * @property {{type:string, refId:string|null}} source
 * @property {SSAStep[]} steps
 * @property {SSASessionArtifacts} artifacts
 * @property {Object} metadata
 * @property {Object} checkpoints          // summary only; detailed rows live in sessionCheckpoints table
 * @property {SSASessionProgress} progress
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/* -------------------------------- Utilities -------------------------------- */

const DOMAIN = "garden";
const SOURCE = "pages.garden.Play";
const nowISO = () => new Date().toISOString();

function makeId(prefix = "sess") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function safeEmit(type, data) {
  const payload = { type, ts: nowISO(), source: SOURCE, data };
  // Payload examples (required) — these are exactly what gets emitted:
  // session.started: { sessionId, domain, title, startedAt, totalSteps }
  // session.step.changed: { sessionId, fromIndex, toIndex, stepId, title }
  // session.timer.started: { sessionId, stepId, durationSec }
  // session.timer.completed: { sessionId, stepId, elapsedSec }
  try {
    if (eventBus?.emit) {
      // try object-first style
      eventBus.emit(payload);
      return;
    }
  } catch {}
  try {
    // try string event + payload
    eventBus.emit?.(type, payload);
  } catch {}
}

function getSessionsTable() {
  return db?.sessions || db?.Sessions || null;
}
function getCheckpointsTable() {
  return db?.sessionCheckpoints || db?.SessionCheckpoints || null;
}
function getKvTable() {
  return db?.kv || db?.KV || null;
}

async function kvGet(key) {
  const kv = getKvTable();
  if (kv?.get) {
    try {
      const row = await kv.get(String(key));
      return row?.value ?? null;
    } catch {}
  }
  // fallback
  try {
    return localStorage.getItem(String(key));
  } catch {}
  return null;
}

async function kvSet(key, value) {
  const kv = getKvTable();
  if (kv?.put) {
    try {
      await kv.put({
        key: String(key),
        value: String(value),
        updatedAt: nowISO(),
      });
      return;
    } catch {}
  }
  // fallback
  try {
    localStorage.setItem(String(key), String(value));
  } catch {}
}

async function loadSessionById(id) {
  if (!id) return null;
  const sessions = getSessionsTable();
  if (!sessions) return null;

  // Prefer canonical sessionId index if available (your db.saveSession pattern)
  try {
    if (sessions.where) {
      const bySessionId = await sessions
        .where("sessionId")
        .equals(String(id))
        .first();
      if (bySessionId) return bySessionId;
    }
  } catch {}

  // Fallback: pk get (may be numeric or string depending on schema)
  try {
    const s = await sessions.get(id);
    if (s) return s;
  } catch {}

  // Fallback: try string
  try {
    const s2 = await sessions.get(String(id));
    if (s2) return s2;
  } catch {}

  return null;
}

async function listRecentDomainSessions(limit = 15) {
  const sessions = getSessionsTable();
  if (!sessions) return [];
  try {
    // Prefer indexed query if exists
    if (sessions.where) {
      const rows = await sessions.where("domain").equals(DOMAIN).toArray();
      rows.sort((a, b) =>
        String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""))
      );
      return rows.slice(0, limit);
    }
  } catch {}
  try {
    const rows = await sessions.toArray();
    const filtered = rows.filter(
      (r) => String(r?.domain || "").toLowerCase() === DOMAIN
    );
    filtered.sort((a, b) =>
      String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""))
    );
    return filtered.slice(0, limit);
  } catch {}
  return [];
}

async function saveSessionBestEffort(session) {
  const sessions = getSessionsTable();
  if (!sessions) return session;

  // If your db.js exports saveSession, use it (best)
  try {
    if (typeof db.saveSession === "function") {
      const saved = await db.saveSession(session);
      return saved || session;
    }
  } catch {}

  // Otherwise: put into sessions table (best-effort)
  try {
    // Ensure stable ids (support both old/new schemas)
    const sessionId = String(
      session?.sessionId || session?.id || makeId("sess")
    );
    const normalized = {
      ...session,
      sessionId,
      id: sessionId,
      domain: DOMAIN,
      updatedAt: nowISO(),
      createdAt: session.createdAt || nowISO(),
    };
    // put may insert/update depending on pk setup
    await sessions.put(normalized);
    return normalized;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[GardenPlay] saveSessionBestEffort failed:", e);
    return session;
  }
}

async function saveCheckpointBestEffort(checkpoint) {
  const cps = getCheckpointsTable();
  if (cps?.put) {
    try {
      await cps.put(checkpoint);
      return true;
    } catch {}
  }
  // Fallback: embed minimal checkpoint into session row
  try {
    const sessions = getSessionsTable();
    if (!sessions) return false;
    const sessionId = String(checkpoint.sessionId);
    const existing = await loadSessionById(sessionId);
    if (!existing) return false;
    const updated = {
      ...existing,
      progress: {
        ...(existing.progress || {}),
        currentStepIndex: checkpoint.currentStepIndex,
      },
      status: checkpoint.status || existing.status,
      checkpoints: {
        ...(existing.checkpoints || {}),
        lastCheckpointAt: checkpoint.updatedAt,
        lastCheckpointId: checkpoint.id,
      },
      updatedAt: checkpoint.updatedAt,
    };
    await saveSessionBestEffort(updated);
    return true;
  } catch {
    return false;
  }
}

async function loadLatestCheckpoint(sessionId) {
  const cps = getCheckpointsTable();
  if (cps?.where) {
    try {
      const rows = await cps
        .where("sessionId")
        .equals(String(sessionId))
        .toArray();
      rows.sort((a, b) =>
        String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""))
      );
      return rows[0] || null;
    } catch {}
  }
  // Fallback: use session.progress if no checkpoint table
  try {
    const s = await loadSessionById(sessionId);
    if (!s) return null;
    return {
      id: s?.checkpoints?.lastCheckpointId || makeId("cp"),
      sessionId: String(sessionId),
      domain: DOMAIN,
      currentStepIndex: Number(s?.progress?.currentStepIndex || 0),
      timer: { running: false, remainingSec: 0, startedAt: null, stepId: null },
      status: s?.status || "paused",
      artifacts: s?.artifacts || {},
      metadata: { fallback: true },
      createdAt: s?.updatedAt || nowISO(),
      updatedAt: s?.updatedAt || nowISO(),
    };
  } catch {}
  return null;
}

function normalizeSessionContract(raw) {
  const s = raw || {};
  const id = String(s.sessionId || s.id || makeId("sess"));
  const steps = Array.isArray(s.steps) ? s.steps : [];
  const normalizedSteps = steps.map((st, i) => {
    const durationSec = Number.isFinite(st?.durationSec) ? st.durationSec : 0;
    const timers = Array.isArray(st?.timers) ? st.timers : [];
    return {
      id: String(st?.id || `step_${i + 1}`),
      title: st?.title || `Step ${i + 1}`,
      desc: st?.desc || st?.text || "",
      durationSec: durationSec > 0 ? durationSec : undefined,
      timers,
      blockers: Array.isArray(st?.blockers) ? st.blockers : [],
      validation: st?.validation || null,
      metadata: st?.metadata || null,
    };
  });

  return {
    id,
    sessionId: id,
    domain: DOMAIN,
    title: s.title || "Garden Session",
    source: s.source || { type: "gardenPlan", refId: null },
    steps: normalizedSteps,
    artifacts:
      s.artifacts && typeof s.artifacts === "object" ? s.artifacts : {},
    metadata: s.metadata && typeof s.metadata === "object" ? s.metadata : {},
    checkpoints:
      s.checkpoints && typeof s.checkpoints === "object" ? s.checkpoints : {},
    progress: {
      currentStepIndex: Number(s?.progress?.currentStepIndex || 0),
      elapsedSec: Number(s?.progress?.elapsedSec || 0),
      startedAt: s?.progress?.startedAt || null,
      pausedAt: s?.progress?.pausedAt || null,
    },
    status: s.status || "pending",
    createdAt: s.createdAt || nowISO(),
    updatedAt: s.updatedAt || nowISO(),
  };
}

/* ----------------------------- Session Builders ---------------------------- */

function buildGardenQuickSession(action) {
  const sid = makeId("sess");
  const createdAt = nowISO();

  // Keep steps “comprehensive”: prep -> task -> log/cleanup
  const steps = [
    {
      id: makeId("step"),
      title: "Prep & gather tools",
      desc: "Grab gloves, pruners, bucket/basket, and water as needed. Do a quick walk to confirm what you’re doing today.",
      durationSec: 5 * 60,
      blockers: ["equipment"],
      validation: {
        requiredConfirm: true,
        prompt: "Tools gathered and plan is clear?",
      },
      metadata: { kind: "prep" },
    },
    ...(action.kind === "watering"
      ? [
          {
            id: makeId("step"),
            title: "Water priority beds / containers",
            desc: "Water slowly at the base of plants. Focus on transplants and containers first. Avoid soaking leaves if disease pressure is high.",
            durationSec: Math.max(5, action.estimatedMinutes) * 60,
            blockers: ["weather", "equipment"],
            validation: { requiredConfirm: false },
            metadata: { kind: "watering" },
          },
        ]
      : action.kind === "harvest"
      ? [
          {
            id: makeId("step"),
            title: "Harvest what’s ready",
            desc: "Pick ripe produce. Handle gently. Separate damaged items for immediate use. Note approximate amounts.",
            durationSec: Math.max(5, action.estimatedMinutes) * 60,
            blockers: ["weather"],
            validation: {
              requiredConfirm: true,
              prompt: "Harvest completed and staged for kitchen/storehouse?",
            },
            metadata: { kind: "harvest" },
          },
        ]
      : action.kind === "weeding"
      ? [
          {
            id: makeId("step"),
            title: "Weed priority zones",
            desc: "Pull weeds near crop stems first. Remove roots where possible. Leave soil level and avoid disturbing shallow crop roots.",
            durationSec: Math.max(5, action.estimatedMinutes) * 60,
            blockers: ["weather"],
            validation: { requiredConfirm: false },
            metadata: { kind: "weeding" },
          },
        ]
      : [
          {
            id: makeId("step"),
            title: "Inspect plants & soil",
            desc: "Check for pests, disease spots, wilting, nutrient issues, and soil moisture. Note any follow-up tasks SSA should schedule.",
            durationSec: Math.max(5, action.estimatedMinutes) * 60,
            blockers: [],
            validation: { requiredConfirm: false },
            metadata: { kind: "inspection" },
          },
        ]),
    {
      id: makeId("step"),
      title: "Log notes & reset",
      desc: "Put tools away. Log harvest amounts and issues (pests/disease/water stress). Capture next actions (spray, prune, trellis, replant).",
      durationSec: 5 * 60,
      blockers: [],
      validation: {
        requiredConfirm: true,
        prompt: "Notes captured for SSA to use later?",
      },
      metadata: { kind: "log" },
    },
  ];

  /** @type {SSASession} */
  const session = {
    id: sid,
    sessionId: sid,
    domain: DOMAIN,
    title: action.title,
    source: { type: "gardenPlan", refId: action.id },
    steps,
    artifacts: { harvestLog: {}, issues: {}, photos: {} },
    metadata: { quickAction: action, createdBy: SOURCE },
    checkpoints: {},
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    status: "pending",
    createdAt,
    updatedAt: createdAt,
  };

  return session;
}

/* ------------------------------- Timer Engine ------------------------------ */

function useStepTimer({ enabled, durationSec, onCompleted }) {
  const [running, setRunning] = useState(false);
  const [remainingSec, setRemainingSec] = useState(
    Math.max(0, Number(durationSec || 0))
  );
  const startedAtRef = useRef(null);
  const rafRef = useRef(null);

  const stop = useCallback(() => {
    setRunning(false);
    startedAtRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const reset = useCallback(
    (newDurationSec) => {
      stop();
      const d = Math.max(0, Number(newDurationSec || 0));
      setRemainingSec(d);
    },
    [stop]
  );

  const tick = useCallback(() => {
    if (!running || !startedAtRef.current) return;

    const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
    const left = Math.max(Math.floor(Number(durationSec || 0) - elapsed), 0);
    setRemainingSec(left);

    if (left <= 0) {
      stop();
      onCompleted?.();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [durationSec, onCompleted, running, stop]);

  const start = useCallback(() => {
    if (!enabled) return;
    const d = Math.max(0, Number(durationSec || 0));
    if (!d) return;
    stop();
    setRunning(true);
    setRemainingSec(d);
    startedAtRef.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
  }, [durationSec, enabled, stop, tick]);

  useEffect(() => {
    // when duration changes (step change), reset timer display
    reset(durationSec || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationSec]);

  useEffect(() => () => stop(), [stop]);

  return {
    running,
    remainingSec,
    start,
    stop,
    reset,
    startedAt: startedAtRef.current
      ? new Date(startedAtRef.current).toISOString()
      : null,
  };
}

/* ---------------------------------- UI ----------------------------------- */

function formatMMSS(totalSec) {
  const t = Math.max(0, Math.floor(Number(totalSec || 0)));
  const m = String(Math.floor(t / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function Pill({ children }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        background: "rgba(0,0,0,0.06)",
        marginRight: 6,
        marginBottom: 6,
      }}
    >
      {children}
    </span>
  );
}

/* -------------------------------- Component -------------------------------- */

export default function GardenPlayPage() {
  const { id: routeId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const { request: requestWake, release: releaseWake } = useWakeLock();

  // Loading states (required)
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Session state (required)
  const [session, setSession] = useState(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [status, setStatus] = useState("pending"); // running/paused/completed/aborted
  const [blockers, setBlockers] = useState([]);
  const [validationOk, setValidationOk] = useState(true);

  // swap modal
  const [swapOpen, setSwapOpen] = useState(false);
  const [recentSessions, setRecentSessions] = useState([]);

  const step = useMemo(
    () => session?.steps?.[currentStepIndex] || null,
    [session, currentStepIndex]
  );

  // Derived progress (required)
  const progress = useMemo(() => {
    const total = session?.steps?.length || 0;
    const done = Math.min(currentStepIndex, Math.max(0, total));
    const pct = total ? Math.round((done / total) * 100) : 0;
    return { total, done, pct };
  }, [session, currentStepIndex]);

  // Timer state (required)
  const timerEnabled = Boolean(step?.durationSec && step.durationSec > 0);
  const timer = useStepTimer({
    enabled: timerEnabled,
    durationSec: step?.durationSec || 0,
    onCompleted: () => {
      safeEmit("session.timer.completed", {
        sessionId: session?.id,
        domain: DOMAIN,
        stepId: step?.id,
        stepIndex: currentStepIndex,
        elapsedSec: Number(step?.durationSec || 0),
      });
      // Optional auto-advance only if step doesn't require confirm
      if (!step?.validation?.requiredConfirm) {
        goNext();
      }
    },
  });

  const lastActiveKey = `lastActiveSessionId:${DOMAIN}`;

  /* --------------------------- Validation + Blockers --------------------------- */

  useEffect(() => {
    const b = Array.isArray(step?.blockers) ? step.blockers : [];
    setBlockers(b);

    const v = step?.validation;
    if (!v) {
      setValidationOk(true);
      return;
    }
    if (v.requiredConfirm) {
      setValidationOk(false); // user must confirm per-step
      return;
    }
    setValidationOk(true);
  }, [step]);

  /* ------------------------------ Checkpoint IO ------------------------------ */

  const writeCheckpoint = useCallback(
    async (nextStatusOverride) => {
      if (!session) return;
      setSaving(true);
      try {
        const cp = {
          id: makeId("cp"),
          sessionId: String(session.sessionId || session.id),
          domain: DOMAIN,
          currentStepIndex: Number(currentStepIndex || 0),
          timer: {
            running: Boolean(timer.running),
            remainingSec: Number(timer.remainingSec || 0),
            startedAt: timer.startedAt || null,
            stepId: step?.id || null,
          },
          status: nextStatusOverride || status,
          artifacts: session.artifacts || {},
          metadata: { source: SOURCE },
          createdAt: nowISO(),
          updatedAt: nowISO(),
        };

        await saveCheckpointBestEffort(cp);

        // Also update session row (best-effort) for quick listing
        const updatedSession = {
          ...session,
          status: nextStatusOverride || status,
          progress: {
            ...(session.progress || {}),
            currentStepIndex: Number(currentStepIndex || 0),
            startedAt:
              session?.progress?.startedAt ||
              (status === "running" ? nowISO() : null),
            pausedAt:
              (nextStatusOverride || status) === "paused" ? nowISO() : null,
          },
          checkpoints: {
            ...(session.checkpoints || {}),
            lastCheckpointAt: cp.updatedAt,
            lastCheckpointId: cp.id,
          },
          updatedAt: cp.updatedAt,
        };

        const saved = await saveSessionBestEffort(updatedSession);
        setSession(normalizeSessionContract(saved));

        await kvSet(lastActiveKey, String(session.sessionId || session.id));
      } catch (e) {
        setError(e);
      } finally {
        setSaving(false);
      }
    },
    [
      currentStepIndex,
      lastActiveKey,
      session,
      status,
      step?.id,
      timer.running,
      timer.remainingSec,
      timer.startedAt,
    ]
  );

  /* --------------------------------- Load --------------------------------- */

  const hydrateFromLoaded = useCallback(
    async (loaded) => {
      const normalized = normalizeSessionContract(loaded);
      setSession(normalized);

      const sid = String(normalized.sessionId || normalized.id);

      // Load latest checkpoint if available
      const cp = await loadLatestCheckpoint(sid);
      if (cp) {
        setCurrentStepIndex(Number(cp.currentStepIndex || 0));
        setStatus(cp.status || normalized.status || "paused");
      } else {
        setCurrentStepIndex(
          Number(normalized?.progress?.currentStepIndex || 0)
        );
        setStatus(normalized.status || "pending");
      }

      await kvSet(lastActiveKey, sid);
      return normalized;
    },
    [lastActiveKey]
  );

  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        // Route load priority:
        //  1) location.state.session (caller passed a built session)
        //  2) route param id
        //  3) lastActiveSessionId for domain
        let loaded = location?.state?.session || null;

        if (!loaded && routeId) {
          loaded = await loadSessionById(routeId);
        }

        if (!loaded) {
          const last = await kvGet(lastActiveKey);
          if (last) loaded = await loadSessionById(last);
        }

        if (!alive) return;

        if (loaded) {
          const normalized = await hydrateFromLoaded(loaded);

          // If resuming, emit session.resumed
          safeEmit("session.resumed", {
            sessionId: normalized.id,
            domain: DOMAIN,
            title: normalized.title,
            resumedAt: nowISO(),
            currentStepIndex: Number(
              normalized?.progress?.currentStepIndex || 0
            ),
          });

          setLoading(false);
          return;
        }

        // No session found: show launcher UI
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(e);
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [hydrateFromLoaded, lastActiveKey, location?.state, routeId]);

  /* ------------------------------- Runner Ops ------------------------------- */

  const startSession = useCallback(
    async (newSession) => {
      const normalized = normalizeSessionContract(newSession);
      normalized.status = "running";
      normalized.progress = {
        ...(normalized.progress || {}),
        startedAt: nowISO(),
        pausedAt: null,
        currentStepIndex: 0,
      };

      const saved = await saveSessionBestEffort(normalized);
      await hydrateFromLoaded(saved);

      // Wake lock best effort
      try {
        await requestWake?.();
      } catch {}

      safeEmit("session.started", {
        sessionId: normalized.id,
        domain: DOMAIN,
        title: normalized.title,
        startedAt: nowISO(),
        totalSteps: normalized.steps.length,
      });

      // Start timer automatically only if step has timer and no required confirm
      const first = normalized.steps?.[0];
      if (first?.durationSec && !first?.validation?.requiredConfirm) {
        safeEmit("session.timer.started", {
          sessionId: normalized.id,
          domain: DOMAIN,
          stepId: first.id,
          stepIndex: 0,
          durationSec: Number(first.durationSec || 0),
        });
        timer.start();
      }

      // Navigate into route so it’s deep-linkable
      try {
        navigate(`/garden/play/${encodeURIComponent(normalized.id)}`, {
          replace: true,
        });
      } catch {}
    },
    [hydrateFromLoaded, navigate, requestWake, timer]
  );

  const pause = useCallback(async () => {
    timer.stop();
    setStatus("paused");
    safeEmit("session.step.changed", {
      sessionId: session?.id,
      domain: DOMAIN,
      fromIndex: currentStepIndex,
      toIndex: currentStepIndex,
      stepId: step?.id,
      title: step?.title,
      reason: "pause",
    });
    await writeCheckpoint("paused");
  }, [
    currentStepIndex,
    session?.id,
    step?.id,
    step?.title,
    timer,
    writeCheckpoint,
  ]);

  const resume = useCallback(async () => {
    setStatus("running");
    safeEmit("session.resumed", {
      sessionId: session?.id,
      domain: DOMAIN,
      title: session?.title,
      resumedAt: nowISO(),
      currentStepIndex,
    });
    await writeCheckpoint("running");
  }, [currentStepIndex, session?.id, session?.title, writeCheckpoint]);

  const abort = useCallback(async () => {
    timer.stop();
    setStatus("aborted");
    safeEmit("session.aborted", {
      sessionId: session?.id,
      domain: DOMAIN,
      title: session?.title,
      abortedAt: nowISO(),
      currentStepIndex,
    });
    await writeCheckpoint("aborted");
    try {
      await releaseWake?.();
    } catch {}
    navigate("/garden");
  }, [
    currentStepIndex,
    navigate,
    releaseWake,
    session?.id,
    session?.title,
    timer,
    writeCheckpoint,
  ]);

  const complete = useCallback(async () => {
    timer.stop();
    setStatus("completed");
    safeEmit("session.completed", {
      sessionId: session?.id,
      domain: DOMAIN,
      title: session?.title,
      completedAt: nowISO(),
      totalSteps: session?.steps?.length || 0,
    });
    await writeCheckpoint("completed");
    try {
      await releaseWake?.();
    } catch {}
    navigate("/garden");
  }, [
    navigate,
    releaseWake,
    session?.id,
    session?.steps?.length,
    session?.title,
    timer,
    writeCheckpoint,
  ]);

  const goToStep = useCallback(
    async (nextIndex, reason = "jump") => {
      if (!session) return;
      const total = session.steps?.length || 0;
      const clamped = Math.max(
        0,
        Math.min(Number(nextIndex || 0), Math.max(0, total - 1))
      );

      timer.stop();

      safeEmit("session.step.changed", {
        sessionId: session.id,
        domain: DOMAIN,
        fromIndex: currentStepIndex,
        toIndex: clamped,
        stepId: session.steps?.[clamped]?.id || null,
        title: session.steps?.[clamped]?.title || null,
        reason,
      });

      setCurrentStepIndex(clamped);

      // Save checkpoint
      await writeCheckpoint(status);

      // Speak step (optional)
      try {
        const txt = session.steps?.[clamped]?.title || "Next step";
        speech.speak?.(txt);
      } catch {}

      // Haptic (optional)
      try {
        notify.vibrate?.(35);
      } catch {}
    },
    [currentStepIndex, session, status, timer, writeCheckpoint]
  );

  const goPrev = useCallback(
    () => goToStep(currentStepIndex - 1, "prev"),
    [currentStepIndex, goToStep]
  );
  const goNext = useCallback(() => {
    if (!session) return;

    // Enforce requiredConfirm steps
    if (step?.validation?.requiredConfirm && !validationOk) return;

    const lastIndex = (session.steps?.length || 1) - 1;
    if (currentStepIndex >= lastIndex) {
      complete();
      return;
    }
    goToStep(currentStepIndex + 1, "next");
  }, [
    complete,
    currentStepIndex,
    goToStep,
    session,
    step?.validation?.requiredConfirm,
    validationOk,
  ]);

  /* ------------------------------ Swap Session ------------------------------ */

  const openSwap = useCallback(async () => {
    setSwapOpen(true);
    try {
      const rows = await listRecentDomainSessions(20);
      setRecentSessions(rows);
    } catch {
      setRecentSessions([]);
    }
  }, []);

  const swapTo = useCallback(
    async (sid) => {
      try {
        const loaded = await loadSessionById(sid);
        if (!loaded) return;
        await hydrateFromLoaded(loaded);
        safeEmit("session.resumed", {
          sessionId: String(sid),
          domain: DOMAIN,
          title: loaded?.title || "Garden Session",
          resumedAt: nowISO(),
          currentStepIndex: Number(loaded?.progress?.currentStepIndex || 0),
          reason: "swap",
        });
        setSwapOpen(false);
        try {
          navigate(`/garden/play/${encodeURIComponent(String(sid))}`, {
            replace: true,
          });
        } catch {}
      } catch {}
    },
    [hydrateFromLoaded, navigate]
  );

  /* ------------------------------ Launcher Data ------------------------------ */

  const quickActions = useMemo(
    () => [
      {
        id: "garden-qa-watering-today",
        title: "Water today’s beds",
        description:
          "A focused watering run: prep → water priorities → log notes.",
        kind: "watering",
        estimatedMinutes: 20,
        tags: ["daily", "watering"],
      },
      {
        id: "garden-qa-harvest-ready",
        title: "Harvest what’s ready",
        description:
          "Harvest ripe items and log approximate amounts for storehouse planning.",
        kind: "harvest",
        estimatedMinutes: 25,
        tags: ["harvest", "storehouse"],
      },
      {
        id: "garden-qa-weeding-priority",
        title: "Priority weed sweep",
        description: "A short weed session targeting the highest-impact zones.",
        kind: "weeding",
        estimatedMinutes: 15,
        tags: ["weeding", "maintenance"],
      },
      {
        id: "garden-qa-inspection",
        title: "Quick inspection walk",
        description:
          "Inspect plants/soil and capture issues + follow-up tasks.",
        kind: "inspection",
        estimatedMinutes: 10,
        tags: ["inspection", "planning"],
      },
    ],
    []
  );

  /* --------------------------------- UI --------------------------------- */

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <h2>Loading Garden Session…</h2>
        <p style={{ opacity: 0.75 }}>
          If you intended to start a new session, go back to Garden and choose
          “Play”.
        </p>
      </div>
    );
  }

  // LAUNCHER (no loaded session yet)
  if (!session) {
    return (
      <div style={{ padding: 16, maxWidth: 980 }}>
        <h1 style={{ marginBottom: 6 }}>Garden Play</h1>
        <p style={{ opacity: 0.8, marginTop: 0 }}>
          One-tap garden sessions you can execute right now. These sessions
          persist and resume after reload.
        </p>

        {error && (
          <div
            style={{
              background: "rgba(255,0,0,0.06)",
              padding: 12,
              borderRadius: 12,
              marginTop: 10,
            }}
          >
            <strong>Something went wrong:</strong>
            <div style={{ whiteSpace: "pre-wrap", opacity: 0.85 }}>
              {String(error?.message || error)}
            </div>
          </div>
        )}

        <div
          style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}
        >
          <button
            type="button"
            className="btn btn-secondary"
            onClick={async () => {
              const last = await kvGet(lastActiveKey);
              if (last)
                navigate(`/garden/play/${encodeURIComponent(String(last))}`);
              else navigate("/garden");
            }}
          >
            Resume last session
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={openSwap}
          >
            Swap / pick a saved session
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate("/garden")}
          >
            Back to Garden
          </button>
        </div>

        <div
          style={{
            marginTop: 16,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {quickActions.map((a) => (
            <div
              key={a.id}
              style={{
                border: "1px solid rgba(0,0,0,0.08)",
                borderRadius: 14,
                padding: 14,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <h3 style={{ margin: 0 }}>{a.title}</h3>
                <Pill>~{a.estimatedMinutes}m</Pill>
              </div>
              <div style={{ marginTop: 6, opacity: 0.8 }}>{a.description}</div>
              <div style={{ marginTop: 8 }}>
                {a.tags.map((t) => (
                  <Pill key={t}>{t}</Pill>
                ))}
              </div>
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => startSession(buildGardenQuickSession(a))}
                >
                  Start session
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Swap Modal */}
        {swapOpen && (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 999,
              padding: 12,
            }}
            onClick={() => setSwapOpen(false)}
          >
            <div
              style={{
                width: "min(920px, 96vw)",
                background: "#fff",
                borderRadius: 16,
                padding: 14,
                maxHeight: "80vh",
                overflow: "auto",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <h3 style={{ margin: 0 }}>Swap to another Garden session</h3>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSwapOpen(false)}
                >
                  Close
                </button>
              </div>

              <div style={{ marginTop: 10, opacity: 0.8 }}>
                Pick a previously saved Garden session to resume.
              </div>

              <div style={{ marginTop: 12 }}>
                {recentSessions.length === 0 ? (
                  <div style={{ opacity: 0.75 }}>
                    No saved garden sessions found.
                  </div>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: 10,
                    }}
                  >
                    {recentSessions.map((s) => {
                      const sid = String(s?.sessionId || s?.id || "");
                      return (
                        <div
                          key={sid}
                          style={{
                            border: "1px solid rgba(0,0,0,0.08)",
                            borderRadius: 14,
                            padding: 12,
                          }}
                        >
                          <div style={{ fontWeight: 700 }}>
                            {s?.title || "Garden Session"}
                          </div>
                          <div
                            style={{
                              opacity: 0.75,
                              fontSize: 12,
                              marginTop: 4,
                            }}
                          >
                            status: {s?.status || "unknown"} • updated:{" "}
                            {s?.updatedAt || ""}
                          </div>
                          <div
                            style={{ marginTop: 8, display: "flex", gap: 8 }}
                          >
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => swapTo(sid)}
                            >
                              Resume
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // RUNNER UI
  const totalSteps = session.steps?.length || 0;
  const isFirst = currentStepIndex <= 0;
  const isLast = currentStepIndex >= totalSteps - 1;

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ marginBottom: 6 }}>
            {session.title || "Garden Session"}
          </h1>
          <div style={{ opacity: 0.8 }}>
            <Pill>domain: {DOMAIN}</Pill>
            <Pill>status: {status}</Pill>
            <Pill>
              progress: {currentStepIndex + 1}/{Math.max(1, totalSteps)} (
              {progress.pct}%)
            </Pill>
            {saving ? <Pill>saving…</Pill> : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={async () => {
              await writeCheckpoint(status);
              openSwap();
            }}
          >
            Swap session
          </button>

          {status !== "running" ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                setStatus("running");
                await writeCheckpoint("running");
                safeEmit("session.resumed", {
                  sessionId: session.id,
                  domain: DOMAIN,
                  title: session.title,
                  resumedAt: nowISO(),
                  currentStepIndex,
                });
                try {
                  await requestWake?.();
                } catch {}
              }}
            >
              Resume
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={pause}>
              Pause
            </button>
          )}

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate("/garden")}
          >
            Back to Garden
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: "rgba(255,0,0,0.06)",
            padding: 12,
            borderRadius: 12,
            marginTop: 10,
          }}
        >
          <strong>Something went wrong:</strong>
          <div style={{ whiteSpace: "pre-wrap", opacity: 0.85 }}>
            {String(error?.message || error)}
          </div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 340px) 1fr",
          gap: 12,
          marginTop: 14,
        }}
      >
        {/* Step List */}
        <aside
          style={{
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 14,
            padding: 12,
            maxHeight: "72vh",
            overflow: "auto",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Steps</div>
          <ol style={{ paddingLeft: 18, margin: 0 }}>
            {(session.steps || []).map((s, i) => {
              const active = i === currentStepIndex;
              return (
                <li key={s.id} style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    onClick={() => goToStep(i, "stepList")}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      border: "1px solid rgba(0,0,0,0.08)",
                      background: active ? "rgba(0,0,0,0.06)" : "#fff",
                      borderRadius: 12,
                      padding: "8px 10px",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 13 }}>
                      {s.title}
                    </div>
                    <div style={{ opacity: 0.75, fontSize: 12 }}>
                      {s.durationSec
                        ? `~${Math.round(s.durationSec / 60)}m`
                        : "no timer"}
                      {Array.isArray(s.blockers) && s.blockers.length
                        ? ` • blockers: ${s.blockers.join(", ")}`
                        : ""}
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>

          <div
            style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}
          >
            <button type="button" className="btn btn-secondary" onClick={abort}>
              Abort
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={complete}
              disabled={status === "completed" || status === "aborted"}
            >
              Complete
            </button>
          </div>
        </aside>

        {/* Current Step */}
        <section
          style={{
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 14,
            padding: 14,
            minHeight: 320,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Step {currentStepIndex + 1} of {Math.max(1, totalSteps)}
              </div>
              <h2 style={{ marginTop: 4, marginBottom: 6 }}>
                {step?.title || "Step"}
              </h2>
            </div>

            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {timerEnabled ? (
                <Pill>timer: {formatMMSS(timer.remainingSec)}</Pill>
              ) : (
                <Pill>no timer</Pill>
              )}
              {blockers.length ? (
                <Pill>blockers: {blockers.join(", ")}</Pill>
              ) : null}
            </div>
          </div>

          <div style={{ marginTop: 8, opacity: 0.9, lineHeight: 1.5 }}>
            {step?.desc || ""}
          </div>

          {/* Validation */}
          {step?.validation?.requiredConfirm ? (
            <div
              style={{
                marginTop: 12,
                border: "1px solid rgba(0,0,0,0.08)",
                borderRadius: 12,
                padding: 12,
                background: "rgba(0,0,0,0.02)",
              }}
            >
              <div style={{ fontWeight: 700 }}>Confirm to proceed</div>
              <div style={{ opacity: 0.85, marginTop: 4 }}>
                {step?.validation?.prompt || "Confirm this step is complete."}
              </div>
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setValidationOk(true)}
                >
                  Confirm
                </button>
                {validationOk ? (
                  <span style={{ marginLeft: 10, opacity: 0.75 }}>
                    Confirmed ✓
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Timer controls */}
          <div
            style={{
              marginTop: 12,
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button
              type="button"
              className="btn btn-primary"
              disabled={!timerEnabled || status !== "running"}
              onClick={() => {
                safeEmit("session.timer.started", {
                  sessionId: session.id,
                  domain: DOMAIN,
                  stepId: step?.id,
                  stepIndex: currentStepIndex,
                  durationSec: Number(step?.durationSec || 0),
                });
                timer.start();
              }}
            >
              Start timer
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!timerEnabled}
              onClick={() => timer.stop()}
            >
              Pause timer
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!timerEnabled}
              onClick={() => timer.reset(step?.durationSec || 0)}
            >
              Reset timer
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                // Save snapshot explicitly
                await writeCheckpoint(status);
              }}
            >
              Save checkpoint
            </button>
          </div>

          {/* Navigation controls */}
          <div
            style={{
              marginTop: 14,
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              disabled={isFirst}
              onClick={goPrev}
            >
              ← Prev
            </button>

            <button
              type="button"
              className="btn btn-primary"
              onClick={goNext}
              disabled={
                status === "aborted" ||
                status === "completed" ||
                (step?.validation?.requiredConfirm && !validationOk)
              }
            >
              {isLast ? "Finish session" : "Next →"}
            </button>
          </div>

          <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
            Tip: this page persists progress. Reload the browser and use “Resume
            last session” to continue.
          </div>
        </section>
      </div>

      {/* Swap Modal (runner mode) */}
      {swapOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 999,
            padding: 12,
          }}
          onClick={() => setSwapOpen(false)}
        >
          <div
            style={{
              width: "min(920px, 96vw)",
              background: "#fff",
              borderRadius: 16,
              padding: 14,
              maxHeight: "80vh",
              overflow: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <h3 style={{ margin: 0 }}>Swap to another Garden session</h3>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setSwapOpen(false)}
              >
                Close
              </button>
            </div>

            <div style={{ marginTop: 10, opacity: 0.8 }}>
              Pick a previously saved Garden session to resume.
            </div>

            <div style={{ marginTop: 12 }}>
              {recentSessions.length === 0 ? (
                <div style={{ opacity: 0.75 }}>
                  No saved garden sessions found.
                </div>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                    gap: 10,
                  }}
                >
                  {recentSessions.map((s) => {
                    const sid = String(s?.sessionId || s?.id || "");
                    const isCurrent =
                      sid && sid === String(session?.sessionId || session?.id);
                    return (
                      <div
                        key={sid}
                        style={{
                          border: "1px solid rgba(0,0,0,0.08)",
                          borderRadius: 14,
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                          }}
                        >
                          <div style={{ fontWeight: 800 }}>
                            {s?.title || "Garden Session"}
                          </div>
                          {isCurrent ? <Pill>current</Pill> : null}
                        </div>
                        <div
                          style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}
                        >
                          status: {s?.status || "unknown"} • updated:{" "}
                          {s?.updatedAt || ""}
                        </div>
                        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={isCurrent}
                            onClick={() => swapTo(sid)}
                          >
                            Resume
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
