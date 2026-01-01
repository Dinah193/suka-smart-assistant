// C:\Users\larho\suka-smart-assistant\src\pages\cleaning\Play.jsx
/* eslint-disable no-console */

//
// CleaningPlayPage (Interactive Session Execution)
// -----------------------------------------------
// This page is the "Play" surface for the cleaning domain. It executes a runnable
// cleaning Session (step list + current step + timers) and persists checkpoints
// so it survives reload/navigation.
//
// SSA rules honored:
// • No TypeScript
// • Defensive imports (eventBus, db, featureFlags, optional wake-lock/tts)
// • No hard dependency on Hub
// • Emits standardized session events (required set)
//
// Required UX flows supported:
// • Start new session (template)
// • Resume session (from Dexie checkpoint / lastActiveSessionId)
// • Swap session (modal)
// • Pause
// • Complete
// • Abort
// • Step list + current step view
//

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

/* ----------------------- Soft/defensive shared imports ---------------------- */
/**
 * eventBus soft-import
 * Supports:
 *  - "@/services/events/eventBus.js"
 *  - "../../services/events/eventBus"
 */
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
  } catch {
    // noop
  }
}

/**
 * featureFlags soft-import
 * Supports:
 *  - "@/config/featureFlags.json"
 *  - "../../config/featureFlags.json"
 */
let featureFlags = {};
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const ff = require("@/config/featureFlags.json");
  featureFlags = ff?.default || ff || featureFlags;
} catch {
  try {
    // eslint-disable-next-line global-require
    const ff2 = require("../../config/featureFlags.json");
    featureFlags = ff2?.default || ff2 || featureFlags;
  } catch {
    // noop
  }
}

/**
 * Dexie db soft-import.
 * We try common SSA patterns:
 *  - "@/services/db"
 *  - "@/services/db.js"
 *  - "../../services/db"
 *  - "../../services/db.js"
 *  - "@/db" (fallback if you have a db barrel)
 *  - "../../db"
 *
 * Expected (best case):
 *   db.sessions (table)
 *   db.sessionCheckpoints (table)
 *   db.kv (table)  // optional; falls back to localStorage if missing
 */
let db = null;
async function getDb() {
  if (db) return db;

  const candidates = [
    "@/services/db",
    "@/services/db.js",
    "../../services/db",
    "../../services/db.js",
    "@/db",
    "@/db/index.js",
    "../../db",
    "../../db/index.js",
  ];

  for (const path of candidates) {
    try {
      // eslint-disable-next-line import/no-unresolved
      const mod = await import(/* @vite-ignore */ path);
      db = mod?.db || mod?.default || mod || null;
      if (db) return db;
    } catch {
      // continue
    }
  }

  db = null;
  return null;
}

/**
 * Optional wake lock / TTS hooks (do not crash if missing)
 */
async function tryAcquireWakeLock() {
  try {
    if (!featureFlags?.wakeLock) return null;
    if (!("wakeLock" in navigator)) return null;
    // eslint-disable-next-line no-undef
    const lock = await navigator.wakeLock.request("screen");
    return lock || null;
  } catch {
    return null;
  }
}

function trySpeak(text) {
  try {
    if (!featureFlags?.tts) return;
    if (!text) return;
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    // noop
  }
}

/* --------------------------------- Contract -------------------------------- */
/**
 * Session object contract (SSA unified runner contract)
 *
 * @typedef {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} SessionDomain
 *
 * @typedef {Object} SessionTimer
 * @property {string} id
 * @property {string} stepId
 * @property {number} durationSec
 * @property {("countdown"|"countup")} mode
 *
 * @typedef {Object} SessionArtifact
 * @property {string} id
 * @property {string} kind         // "note" | "photo" | "metric" | "task" | etc.
 * @property {any} payload
 * @property {string} createdAt
 *
 * @typedef {Object} SessionCheckpoint
 * @property {string} id
 * @property {string} sessionId
 * @property {SessionDomain} domain
 * @property {number} currentStepIndex
 * @property {("pending"|"running"|"paused"|"completed"|"aborted")} status
 * @property {Object} timer
 * @property {boolean} timer.running
 * @property {number} timer.remainingSec
 * @property {string|null} timer.startedAt
 * @property {string|null} timer.completedAt
 * @property {string[]} completedStepIds
 * @property {string|null} startedAt
 * @property {string|null} pausedAt
 * @property {string|null} completedAt
 * @property {string|null} abortedAt
 * @property {any} blockers
 * @property {any} validation
 * @property {any[]} artifacts
 * @property {any} metadata
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment">} blockers
 * @property {any} metadata
 *
 * @typedef {Object} Session
 * @property {string} id
 * @property {SessionDomain} domain
 * @property {string} title
 * @property {SessionStep[]} steps              // consolidated, runnable
 * @property {SessionTimer[]} timers            // optional; may mirror step durations
 * @property {SessionArtifact[]} artifacts
 * @property {any} metadata
 * @property {Object} checkpoints               // lightweight pointers/summary
 * @property {string|null} checkpoints.lastCheckpointId
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/* --------------------------------- Keys ------------------------------------ */
const LS_LAST_ACTIVE = "ssa:lastActiveSessionId:cleaning";
const LS_CHECKPOINT_FALLBACK = "ssa:checkpoint:cleaning:v1";
const LS_SESSION_FALLBACK = "ssa:sessions:cleaning:v1";

const SOURCE = "ui/cleaning/play";
const nowISO = () => new Date().toISOString();

function createId(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function safeParseJSON(raw, fallback) {
  try {
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/* --------------------------------- Events ---------------------------------- */
/**
 * Standardized session events (minimum set required)
 *
 * Payload examples (emitted by this page):
 *  - session.started:
 *      { id, domain:"cleaning", title, ts, source:"ui/cleaning/play", checkpointId }
 *  - session.resumed:
 *      { id, domain:"cleaning", currentStepIndex, remainingSec, checkpointId }
 *  - session.step.changed:
 *      { id, domain:"cleaning", fromStepId, toStepId, toIndex, checkpointId }
 *  - session.timer.started:
 *      { id, domain:"cleaning", stepId, durationSec, remainingSec, checkpointId }
 *  - session.timer.completed:
 *      { id, domain:"cleaning", stepId, durationSec, checkpointId }
 *  - session.completed:
 *      { id, domain:"cleaning", completedAt, checkpointId }
 *  - session.aborted:
 *      { id, domain:"cleaning", abortedAt, reason, checkpointId }
 */
function emit(type, data = {}) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    const payload = { type, ts: nowISO(), source: SOURCE, data };

    // Support both eventBus.emit(type, payload) and eventBus.emit(payload)
    try {
      eventBus.emit(type, payload);
    } catch {
      eventBus.emit(payload);
    }
  } catch {
    // noop
  }
}

/* ------------------------------ Persistence --------------------------------- */
async function kvGet(key) {
  try {
    const d = await getDb();
    if (d?.kv?.get) {
      const row = await d.kv.get(key);
      return row?.value ?? null;
    }
  } catch {
    // ignore
  }
  return localStorage.getItem(key);
}

async function kvSet(key, value) {
  try {
    const d = await getDb();
    if (d?.kv?.put) {
      await d.kv.put({ key, value });
      return;
    }
  } catch {
    // ignore
  }
  localStorage.setItem(key, value);
}

async function saveSession(session) {
  const d = await getDb();
  if (d?.sessions?.put) {
    await d.sessions.put(session);
    return;
  }
  // localStorage fallback
  const raw = localStorage.getItem(LS_SESSION_FALLBACK);
  const arr = safeParseJSON(raw, []);
  const list = Array.isArray(arr) ? arr : [];
  const idx = list.findIndex((s) => s?.id === session.id);
  if (idx >= 0) list[idx] = session;
  else list.unshift(session);
  localStorage.setItem(LS_SESSION_FALLBACK, JSON.stringify(list.slice(0, 200)));
}

async function loadSession(sessionId) {
  const d = await getDb();
  if (d?.sessions?.get) {
    const s = await d.sessions.get(sessionId);
    if (s) return s;
  }
  const raw = localStorage.getItem(LS_SESSION_FALLBACK);
  const list = safeParseJSON(raw, []);
  return (
    (Array.isArray(list) ? list : []).find((s) => s?.id === sessionId) || null
  );
}

async function saveCheckpoint(cp) {
  const d = await getDb();
  if (d?.sessionCheckpoints?.put) {
    await d.sessionCheckpoints.put(cp);
    return;
  }
  localStorage.setItem(LS_CHECKPOINT_FALLBACK, JSON.stringify(cp));
}

async function loadCheckpoint(sessionId) {
  const d = await getDb();
  if (d?.sessionCheckpoints?.where) {
    const list = await d.sessionCheckpoints
      .where("sessionId")
      .equals(sessionId)
      .toArray();
    if (Array.isArray(list) && list.length) {
      list.sort((a, b) =>
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
      );
      return list[0];
    }
  }
  const raw = localStorage.getItem(LS_CHECKPOINT_FALLBACK);
  const cp = safeParseJSON(raw, null);
  if (cp?.sessionId === sessionId) return cp;
  return null;
}

/* ------------------------------ Templates ----------------------------------- */
/**
 * Built-in session templates (start new session).
 * These should later be generated by a CleaningSessionEngine that consolidates:
 *  - user chosen zones
 *  - storehouse/inventory realities
 *  - household preferences (quiet hours, sabbath rules, etc.)
 */
function buildCleaningSessionFromTemplate(templateId) {
  const id = createId("clean");
  const createdAt = nowISO();

  /** @type {SessionStep[]} */
  let steps = [];

  if (templateId === "kitchen-reset") {
    steps = [
      {
        id: createId("step"),
        title: "Prep & gather supplies",
        desc: "Grab your cleaning caddy (multi-surface spray, dish soap, sponge, cloths), a trash bag, and your broom/vacuum.",
        durationSec: 5 * 60,
        blockers: ["equipment"],
        metadata: { zone: "kitchen", kind: "prep" },
      },
      {
        id: createId("step"),
        title: "Clear dishes & trash",
        desc: "Load dishwasher / hand-wash essentials. Remove trash + recycling from counters and sink.",
        durationSec: 7 * 60,
        blockers: [],
        metadata: { zone: "kitchen", kind: "reset" },
      },
      {
        id: createId("step"),
        title: "Wipe counters & key surfaces",
        desc: "Spray and wipe counters, stove top, table/island. Work in one direction to avoid re-dirtying.",
        durationSec: 8 * 60,
        blockers: [],
        metadata: { zone: "kitchen", kind: "wipe" },
      },
      {
        id: createId("step"),
        title: "Quick floor reset",
        desc: "Sweep/vacuum visible crumbs in main traffic paths. Focus on ‘good enough’ to restore flow.",
        durationSec: 5 * 60,
        blockers: ["equipment"],
        metadata: { zone: "kitchen", kind: "floor" },
      },
      {
        id: createId("step"),
        title: "Reset supplies & log follow-ups",
        desc: "Put supplies back. Note any shortages (trash bags, spray, sponges) or deep-clean follow-ups.",
        durationSec: 4 * 60,
        blockers: [],
        metadata: { zone: "kitchen", kind: "log" },
      },
    ];
  } else if (templateId === "bathroom-blitz") {
    steps = [
      {
        id: createId("step"),
        title: "Prep & ventilate",
        desc: "Open vent/window. Gather bathroom cleaner, cloths, toilet brush, and a small trash bag.",
        durationSec: 4 * 60,
        blockers: ["equipment"],
        metadata: { zone: "bathroom", kind: "prep" },
      },
      {
        id: createId("step"),
        title: "Sink + counter + mirror",
        desc: "Spray and wipe sink/counter/faucet; use a separate cloth for mirror to reduce streaking.",
        durationSec: 6 * 60,
        blockers: [],
        metadata: { zone: "bathroom", kind: "wipe" },
      },
      {
        id: createId("step"),
        title: "Toilet reset",
        desc: "Quick clean bowl, seat, and exterior touch points. Aim for sanitary + presentable.",
        durationSec: 6 * 60,
        blockers: [],
        metadata: { zone: "bathroom", kind: "sanitize" },
      },
      {
        id: createId("step"),
        title: "Floor edges (spot)",
        desc: "Pick up items; spot clean around toilet and sink. Remove visible hair/dust.",
        durationSec: 5 * 60,
        blockers: ["equipment"],
        metadata: { zone: "bathroom", kind: "floor" },
      },
      {
        id: createId("step"),
        title: "Reset & log follow-ups",
        desc: "Replace towels/soap as needed. Note shortages (toilet cleaner, wipes) and deeper tasks.",
        durationSec: 4 * 60,
        blockers: [],
        metadata: { zone: "bathroom", kind: "log" },
      },
    ];
  } else if (templateId === "floor-reset") {
    steps = [
      {
        id: createId("step"),
        title: "Pick up floor clutter",
        desc: "Do a quick sweep pass: shoes, toys, random items. Just clear enough to clean floors.",
        durationSec: 5 * 60,
        blockers: [],
        metadata: { zone: "whole-home", kind: "declutter" },
      },
      {
        id: createId("step"),
        title: "Vacuum/sweep traffic paths",
        desc: "Hit the main walkways (living room → hall → entry). Focus on crumbs and visible debris.",
        durationSec: 10 * 60,
        blockers: ["equipment"],
        metadata: { zone: "whole-home", kind: "floor" },
      },
      {
        id: createId("step"),
        title: "Spot mop sticky areas",
        desc: "Spot mop kitchen/entry sticky spots. Save full mop for a scheduled deep clean.",
        durationSec: 5 * 60,
        blockers: ["equipment"],
        metadata: { zone: "whole-home", kind: "mop" },
      },
      {
        id: createId("step"),
        title: "Reset & log follow-ups",
        desc: "Return items to a single ‘staging’ bin if needed. Note repairs or deep-clean targets.",
        durationSec: 4 * 60,
        blockers: [],
        metadata: { zone: "whole-home", kind: "log" },
      },
    ];
  } else {
    // laundry-sprint
    steps = [
      {
        id: createId("step"),
        title: "Gather priority laundry",
        desc: "Collect laundry from hotspots. Sort only what you’ll wash now (towels, daily wear, etc.).",
        durationSec: 6 * 60,
        blockers: [],
        metadata: { zone: "laundry", kind: "gather" },
      },
      {
        id: createId("step"),
        title: "Start the most urgent load",
        desc: "Load machine, add detergent, start cycle. SSA can later schedule a switch/reminder session.",
        durationSec: 4 * 60,
        blockers: ["equipment"],
        metadata: { zone: "laundry", kind: "start" },
      },
      {
        id: createId("step"),
        title: "Micro-fold / stage finished load",
        desc: "If a load is ready, fold/hang just one load. Put away top-priority items first.",
        durationSec: 10 * 60,
        blockers: [],
        metadata: { zone: "laundry", kind: "fold" },
      },
      {
        id: createId("step"),
        title: "Reset & log follow-ups",
        desc: "Note any supplies running low (detergent, dryer sheets). Decide next laundry session target.",
        durationSec: 4 * 60,
        blockers: [],
        metadata: { zone: "laundry", kind: "log" },
      },
    ];
  }

  /** @type {Session} */
  const session = {
    id,
    domain: "cleaning",
    title:
      templateId === "kitchen-reset"
        ? "Kitchen Reset"
        : templateId === "bathroom-blitz"
        ? "Bathroom Blitz"
        : templateId === "floor-reset"
        ? "Floor Reset"
        : "Laundry Sprint",
    steps,
    timers: steps.map((s) => ({
      id: createId("t"),
      stepId: s.id,
      durationSec: s.durationSec,
      mode: "countdown",
    })),
    artifacts: [],
    metadata: {
      templateId,
      source: "built-in-template",
    },
    checkpoints: { lastCheckpointId: null },
    createdAt,
    updatedAt: createdAt,
  };

  return session;
}

/* ---------------------------------- UI ------------------------------------- */
function Modal({ open, title, children, onClose }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 9999,
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          width: "min(760px, 96vw)",
          background: "#fff",
          borderRadius: 14,
          boxShadow: "0 12px 40px rgba(0,0,0,0.2)",
          overflow: "hidden",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid #eee",
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 16, flex: 1 }}>{title}</div>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ padding: 16 }}>{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------ Main Component ------------------------------ */
export default function CleaningPlayPage() {
  const navigate = useNavigate();
  const params = useParams();

  // tolerate different route param names
  const routeSessionId = useMemo(
    () => params.sessionId || params.id || params.cleaningSessionId || "",
    [params]
  );

  /* ------------------------------ State model ------------------------------ */
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  /** @type {[Session|null, Function]} */
  const [session, setSession] = useState(null);

  const [status, setStatus] = useState("pending"); // "pending"|"running"|"paused"|"completed"|"aborted"
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  // timer state (countdown)
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerRemainingSec, setTimerRemainingSec] = useState(0);
  const [timerStartedAt, setTimerStartedAt] = useState(null);
  const [timerCompletedAt, setTimerCompletedAt] = useState(null);

  // blockers + validation placeholders (engine can populate these later)
  const [blockers, setBlockers] = useState({});
  const [validation, setValidation] = useState({});

  const [completedStepIds, setCompletedStepIds] = useState([]);
  const [artifacts, setArtifacts] = useState([]);

  const [startedAt, setStartedAt] = useState(null);
  const [pausedAt, setPausedAt] = useState(null);
  const [completedAt, setCompletedAt] = useState(null);
  const [abortedAt, setAbortedAt] = useState(null);

  const [swapOpen, setSwapOpen] = useState(false);

  // wake lock ref
  const wakeLockRef = useRef(null);

  // timer interval ref
  const intervalRef = useRef(null);

  // checkpoint save debounce
  const saveTimerRef = useRef(null);

  const steps = session?.steps || [];
  const currentStep = steps[currentStepIndex] || null;

  const derived = useMemo(() => {
    const total = steps.length || 1;
    const doneCount = completedStepIds.length;
    const pct = Math.round((doneCount / total) * 100);
    const canPrev = currentStepIndex > 0;
    const canNext = currentStepIndex < total - 1;
    return { total, doneCount, pct, canPrev, canNext };
  }, [steps.length, completedStepIds.length, currentStepIndex]);

  /* ------------------------------ Checkpoint IO ----------------------------- */
  function buildCheckpoint(nextPatch = {}) {
    const id = nextPatch?.id || createId("cp");
    /** @type {SessionCheckpoint} */
    const cp = {
      id,
      sessionId: session?.id || routeSessionId || "",
      domain: "cleaning",
      currentStepIndex,
      status,
      timer: {
        running: timerRunning,
        remainingSec: timerRemainingSec,
        startedAt: timerStartedAt,
        completedAt: timerCompletedAt,
      },
      completedStepIds,
      startedAt,
      pausedAt,
      completedAt,
      abortedAt,
      blockers,
      validation,
      artifacts,
      metadata: {
        ...(session?.metadata || {}),
        routeSessionId: routeSessionId || null,
      },
      createdAt: nextPatch?.createdAt || nowISO(),
      updatedAt: nowISO(),
      ...nextPatch,
    };
    return cp;
  }

  async function persistCheckpoint(reason = "state-change") {
    if (!session?.id) return;
    const cp = buildCheckpoint({
      metadata: { ...(session?.metadata || {}), reason },
    });
    try {
      await saveCheckpoint(cp);

      // also stamp session pointer
      const updatedSession = {
        ...session,
        checkpoints: {
          ...(session.checkpoints || {}),
          lastCheckpointId: cp.id,
        },
        updatedAt: nowISO(),
      };
      await saveSession(updatedSession);
      await kvSet(LS_LAST_ACTIVE, session.id);
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[CleaningPlayPage] persistCheckpoint failed:",
          e?.message || e
        );
      }
    }
  }

  function scheduleCheckpointSave(reason) {
    if (!session?.id) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      persistCheckpoint(reason);
    }, 250);
  }

  /* ------------------------------ Load / Init ------------------------------ */
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setLoadError("");

      try {
        // Decide which session to load:
        // 1) route param sessionId
        // 2) lastActiveSessionId for cleaning
        // 3) start with a default template session (kitchen-reset)
        let sid = routeSessionId;
        if (!sid) {
          const last = await kvGet(LS_LAST_ACTIVE);
          if (last) sid = String(last);
        }

        let s = null;
        if (sid) s = await loadSession(sid);

        if (!s) {
          s = buildCleaningSessionFromTemplate("kitchen-reset");
          await saveSession(s);
          await kvSet(LS_LAST_ACTIVE, s.id);
        }

        const cp = await loadCheckpoint(s.id);

        if (!alive) return;

        setSession(s);
        setStatus(cp?.status || "pending");
        setCurrentStepIndex(
          clamp(cp?.currentStepIndex ?? 0, 0, (s.steps?.length || 1) - 1)
        );
        setCompletedStepIds(
          Array.isArray(cp?.completedStepIds) ? cp.completedStepIds : []
        );

        setTimerRunning(Boolean(cp?.timer?.running));
        setTimerRemainingSec(
          typeof cp?.timer?.remainingSec === "number"
            ? cp.timer.remainingSec
            : s.steps?.[0]?.durationSec || 0
        );
        setTimerStartedAt(cp?.timer?.startedAt || null);
        setTimerCompletedAt(cp?.timer?.completedAt || null);

        setBlockers(cp?.blockers || {});
        setValidation(cp?.validation || {});
        setArtifacts(Array.isArray(cp?.artifacts) ? cp.artifacts : []);

        setStartedAt(cp?.startedAt || null);
        setPausedAt(cp?.pausedAt || null);
        setCompletedAt(cp?.completedAt || null);
        setAbortedAt(cp?.abortedAt || null);

        if (
          (cp?.status === "running" || cp?.status === "paused") &&
          featureFlags?.wakeLock
        ) {
          wakeLockRef.current = await tryAcquireWakeLock();
        }

        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setLoadError(e?.message || "Failed to load cleaning session.");
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [routeSessionId]);

  /* ------------------------------ Timer engine ------------------------------ */
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!timerRunning) return;

    intervalRef.current = setInterval(() => {
      setTimerRemainingSec((prev) => {
        const next = Math.max(0, (prev || 0) - 1);

        if (next === 0) {
          setTimerRunning(false);
          setTimerCompletedAt(nowISO());

          emit("session.timer.completed", {
            id: session?.id,
            domain: "cleaning",
            stepId: currentStep?.id,
            durationSec: currentStep?.durationSec || 0,
            checkpointId: session?.checkpoints?.lastCheckpointId || null,
          });

          // Mark step done
          if (currentStep?.id) {
            setCompletedStepIds((list) => {
              if (list.includes(currentStep.id)) return list;
              return [...list, currentStep.id];
            });
          }

          // Optional auto-advance
          const autoAdvance = Boolean(
            session?.metadata?.autoAdvance || featureFlags?.autoAdvanceTimers
          );
          if (autoAdvance) {
            setTimeout(() => {
              goNext("auto-advance");
            }, 150);
          }

          scheduleCheckpointSave("timer.completed");
        }

        return next;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerRunning, session?.id, currentStep?.id]);

  /* ------------------------------ Actions ---------------------------------- */
  async function startNewSession(templateId) {
    const s = buildCleaningSessionFromTemplate(templateId);
    await saveSession(s);
    await kvSet(LS_LAST_ACTIVE, s.id);

    setSession(s);
    setStatus("pending");
    setCurrentStepIndex(0);
    setCompletedStepIds([]);
    setTimerRunning(false);
    setTimerRemainingSec(s.steps?.[0]?.durationSec || 0);
    setTimerStartedAt(null);
    setTimerCompletedAt(null);
    setStartedAt(null);
    setPausedAt(null);
    setCompletedAt(null);
    setAbortedAt(null);
    setArtifacts([]);
    setBlockers({});
    setValidation({});

    scheduleCheckpointSave("session.created");

    // optional: keep URL in sync if your router supports /cleaning/play/:sessionId
    try {
      navigate(`/cleaning/play/${s.id}`);
    } catch {
      // noop
    }
  }

  async function startSession() {
    if (!session?.id) return;

    if (!wakeLockRef.current) {
      wakeLockRef.current = await tryAcquireWakeLock();
    }

    const ts = nowISO();
    setStartedAt((prev) => prev || ts);
    setStatus("running");

    emit("session.started", {
      id: session.id,
      domain: "cleaning",
      title: session.title,
      checkpointId: session?.checkpoints?.lastCheckpointId || null,
    });

    const dur = currentStep?.durationSec || 0;
    if ((timerRemainingSec || 0) <= 0 && dur > 0) setTimerRemainingSec(dur);
    if (featureFlags?.tts && currentStep?.title) trySpeak(currentStep.title);

    scheduleCheckpointSave("session.started");
  }

  async function resumeSession() {
    if (!session?.id) return;

    if (!wakeLockRef.current) {
      wakeLockRef.current = await tryAcquireWakeLock();
    }

    setStatus("running");
    setPausedAt(null);

    emit("session.resumed", {
      id: session.id,
      domain: "cleaning",
      currentStepIndex,
      remainingSec: timerRemainingSec,
      checkpointId: session?.checkpoints?.lastCheckpointId || null,
    });

    if ((timerRemainingSec || 0) <= 0 && currentStep?.durationSec) {
      setTimerRemainingSec(currentStep.durationSec);
    }
    if (featureFlags?.tts && currentStep?.title) trySpeak(currentStep.title);

    scheduleCheckpointSave("session.resumed");
  }

  async function pauseSession() {
    setStatus("paused");
    setTimerRunning(false);
    setPausedAt(nowISO());
    scheduleCheckpointSave("session.paused");
  }

  async function abortSession(reason = "user") {
    const ts = nowISO();
    setStatus("aborted");
    setTimerRunning(false);
    setAbortedAt(ts);

    emit("session.aborted", {
      id: session?.id,
      domain: "cleaning",
      abortedAt: ts,
      reason,
      checkpointId: session?.checkpoints?.lastCheckpointId || null,
    });

    try {
      if (wakeLockRef.current?.release) await wakeLockRef.current.release();
    } catch {
      // ignore
    }
    wakeLockRef.current = null;

    scheduleCheckpointSave("session.aborted");
  }

  async function completeSession() {
    const ts = nowISO();
    setStatus("completed");
    setTimerRunning(false);
    setCompletedAt(ts);

    emit("session.completed", {
      id: session?.id,
      domain: "cleaning",
      completedAt: ts,
      checkpointId: session?.checkpoints?.lastCheckpointId || null,
    });

    try {
      if (wakeLockRef.current?.release) await wakeLockRef.current.release();
    } catch {
      // ignore
    }
    wakeLockRef.current = null;

    scheduleCheckpointSave("session.completed");
  }

  function markStepDone(stepId) {
    if (!stepId) return;
    setCompletedStepIds((list) => {
      if (list.includes(stepId)) return list;
      return [...list, stepId];
    });
    scheduleCheckpointSave("step.marked_done");
  }

  function goPrev(source = "ui") {
    const from = currentStep;
    setCurrentStepIndex((idx) => {
      const nextIdx = clamp(idx - 1, 0, steps.length - 1);
      if (nextIdx !== idx) {
        const to = steps[nextIdx];

        emit("session.step.changed", {
          id: session?.id,
          domain: "cleaning",
          fromStepId: from?.id || null,
          toStepId: to?.id || null,
          toIndex: nextIdx,
          source,
          checkpointId: session?.checkpoints?.lastCheckpointId || null,
        });

        if (to?.durationSec) {
          setTimerRunning(false);
          setTimerRemainingSec(to.durationSec);
          setTimerStartedAt(null);
          setTimerCompletedAt(null);
        }

        if (featureFlags?.tts && to?.title) trySpeak(to.title);
        scheduleCheckpointSave("step.changed");
      }
      return nextIdx;
    });
  }

  function goNext(source = "ui") {
    const from = currentStep;
    setCurrentStepIndex((idx) => {
      const nextIdx = clamp(idx + 1, 0, steps.length - 1);
      if (nextIdx !== idx) {
        const to = steps[nextIdx];

        emit("session.step.changed", {
          id: session?.id,
          domain: "cleaning",
          fromStepId: from?.id || null,
          toStepId: to?.id || null,
          toIndex: nextIdx,
          source,
          checkpointId: session?.checkpoints?.lastCheckpointId || null,
        });

        if (to?.durationSec) {
          setTimerRunning(false);
          setTimerRemainingSec(to.durationSec);
          setTimerStartedAt(null);
          setTimerCompletedAt(null);
        }

        if (featureFlags?.tts && to?.title) trySpeak(to.title);
        scheduleCheckpointSave("step.changed");
      }
      return nextIdx;
    });
  }

  function startTimer() {
    if (!currentStep) return;

    const dur = currentStep.durationSec || 0;
    if ((timerRemainingSec || 0) <= 0 && dur > 0) setTimerRemainingSec(dur);

    setTimerRunning(true);
    setTimerStartedAt(nowISO());
    setTimerCompletedAt(null);

    emit("session.timer.started", {
      id: session?.id,
      domain: "cleaning",
      stepId: currentStep.id,
      durationSec: dur,
      remainingSec: timerRemainingSec > 0 ? timerRemainingSec : dur,
      checkpointId: session?.checkpoints?.lastCheckpointId || null,
    });

    scheduleCheckpointSave("timer.started");
  }

  function resetTimer() {
    if (!currentStep) return;
    const dur = currentStep.durationSec || 0;
    setTimerRunning(false);
    setTimerRemainingSec(dur);
    setTimerStartedAt(null);
    setTimerCompletedAt(null);
    scheduleCheckpointSave("timer.reset");
  }

  function addNote() {
    const text = window.prompt("Add a quick note for this cleaning session:");
    if (!text) return;

    const a = {
      id: createId("art"),
      kind: "note",
      payload: { text, stepId: currentStep?.id || null },
      createdAt: nowISO(),
    };

    setArtifacts((list) => [a, ...(Array.isArray(list) ? list : [])]);
    scheduleCheckpointSave("artifact.note.added");
  }

  /* -------------------------------- Render --------------------------------- */
  if (loading) {
    return (
      <div className="sv-page">
        <div className="sv-card sv-pad" style={{ borderRadius: 16 }}>
          <div className="sv-strong">Loading cleaning session…</div>
          <div className="sv-muted" style={{ marginTop: 6 }}>
            {routeSessionId
              ? `Session: ${routeSessionId}`
              : "Finding last active session…"}
          </div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="sv-page">
        <div className="sv-card sv-pad" style={{ borderRadius: 16 }}>
          <div className="sv-strong">Couldn’t load cleaning session</div>
          <div
            className="sv-muted"
            style={{ marginTop: 8, whiteSpace: "pre-wrap" }}
          >
            {loadError}
          </div>
          <div
            className="sv-row"
            style={{ gap: 10, marginTop: 12, flexWrap: "wrap" }}
          >
            <button
              className="btn primary"
              type="button"
              onClick={() => navigate("/cleaning")}
            >
              Back to Cleaning
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sv-page">
      {/* Header */}
      <div
        className="sv-card sv-pad"
        style={{ borderRadius: 16, marginBottom: 12 }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="sv-strong" style={{ fontSize: 20 }}>
              {session?.title || "Cleaning Session"}
            </div>
            <div className="sv-muted" style={{ marginTop: 4 }}>
              Status: <span className="sv-strong">{status}</span> • Progress:{" "}
              <span className="sv-strong">{derived.pct}%</span> (
              {derived.doneCount}/{derived.total})
            </div>
          </div>

          <div className="sv-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn"
              type="button"
              onClick={() => setSwapOpen(true)}
            >
              Swap session
            </button>
            <button className="btn" type="button" onClick={addNote}>
              Add note
            </button>

            {status === "pending" && (
              <button
                className="btn primary"
                type="button"
                onClick={startSession}
              >
                Start
              </button>
            )}

            {status === "paused" && (
              <button
                className="btn primary"
                type="button"
                onClick={resumeSession}
              >
                Resume
              </button>
            )}

            {status === "running" && (
              <button className="btn" type="button" onClick={pauseSession}>
                Pause
              </button>
            )}

            {(status === "running" ||
              status === "paused" ||
              status === "pending") && (
              <button
                className="btn danger"
                type="button"
                onClick={() => abortSession("user")}
              >
                Abort
              </button>
            )}

            {(status === "running" || status === "paused") && (
              <button
                className="btn success"
                type="button"
                onClick={completeSession}
              >
                Complete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main layout: step list + current step view */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "340px 1fr",
          gap: 12,
          alignItems: "start",
        }}
      >
        {/* Step list */}
        <div
          className="sv-card"
          style={{ borderRadius: 16, overflow: "hidden" }}
        >
          <div
            style={{
              padding: 12,
              borderBottom: "1px solid #eee",
              fontWeight: 800,
            }}
          >
            Steps
          </div>

          <div style={{ maxHeight: "70vh", overflow: "auto" }}>
            {steps.map((s, idx) => {
              const active = idx === currentStepIndex;
              const done = completedStepIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    const from = currentStep;
                    setCurrentStepIndex(idx);

                    emit("session.step.changed", {
                      id: session?.id,
                      domain: "cleaning",
                      fromStepId: from?.id || null,
                      toStepId: s?.id || null,
                      toIndex: idx,
                      source: "step.list.click",
                      checkpointId:
                        session?.checkpoints?.lastCheckpointId || null,
                    });

                    setTimerRunning(false);
                    setTimerRemainingSec(s.durationSec || 0);
                    setTimerStartedAt(null);
                    setTimerCompletedAt(null);

                    if (featureFlags?.tts && s?.title) trySpeak(s.title);
                    scheduleCheckpointSave("step.changed");
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: 12,
                    border: "none",
                    borderBottom: "1px solid #f2f2f2",
                    background: active ? "rgba(120, 80, 255, 0.08)" : "#fff",
                    cursor: "pointer",
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                  }}
                >
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 999,
                      marginTop: 2,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: done
                        ? "rgba(20, 180, 90, 0.15)"
                        : "rgba(0,0,0,0.06)",
                      fontWeight: 800,
                    }}
                    aria-label={done ? "Completed" : "Not completed"}
                  >
                    {done ? "✓" : idx + 1}
                  </div>

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, lineHeight: 1.2 }}>
                      {s.title}
                    </div>
                    <div
                      className="sv-muted"
                      style={{ fontSize: 12, marginTop: 2 }}
                    >
                      {fmtTime(s.durationSec)} •{" "}
                      {Array.isArray(s.blockers) && s.blockers.length
                        ? `Blockers: ${s.blockers.join(", ")}`
                        : "No blockers"}
                    </div>
                  </div>
                </button>
              );
            })}

            {!steps.length && (
              <div style={{ padding: 12 }} className="sv-muted">
                No steps found.
              </div>
            )}
          </div>
        </div>

        {/* Current step view */}
        <div className="sv-card sv-pad" style={{ borderRadius: 16 }}>
          {!currentStep ? (
            <div className="sv-muted">Select a step to begin.</div>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div className="sv-strong" style={{ fontSize: 18 }}>
                    Step {currentStepIndex + 1} of {steps.length}:{" "}
                    {currentStep.title}
                  </div>
                  <div
                    className="sv-muted"
                    style={{ marginTop: 6, whiteSpace: "pre-wrap" }}
                  >
                    {currentStep.desc}
                  </div>
                </div>

                <div style={{ textAlign: "right" }}>
                  <div style={{ fontWeight: 900, fontSize: 26, lineHeight: 1 }}>
                    {fmtTime(timerRemainingSec)}
                  </div>
                  <div
                    className="sv-muted"
                    style={{ fontSize: 12, marginTop: 2 }}
                  >
                    {timerRunning ? "Timer running" : "Timer paused"}
                  </div>
                </div>
              </div>

              {/* Timer controls */}
              <div
                className="sv-row"
                style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}
              >
                {!timerRunning ? (
                  <button
                    className="btn primary"
                    type="button"
                    onClick={startTimer}
                    disabled={status === "completed" || status === "aborted"}
                  >
                    Start timer
                  </button>
                ) : (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setTimerRunning(false)}
                  >
                    Pause timer
                  </button>
                )}

                <button className="btn" type="button" onClick={resetTimer}>
                  Reset
                </button>

                <button
                  className="btn"
                  type="button"
                  onClick={() => markStepDone(currentStep.id)}
                >
                  Mark step done
                </button>
              </div>

              {/* Navigation */}
              <div
                className="sv-row"
                style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}
              >
                <button
                  className="btn"
                  type="button"
                  onClick={() => goPrev("nav.prev")}
                  disabled={!derived.canPrev}
                >
                  Prev
                </button>

                <button
                  className="btn"
                  type="button"
                  onClick={() => goNext("nav.next")}
                  disabled={!derived.canNext}
                >
                  Next
                </button>

                <div style={{ flex: 1 }} />

                {(status === "pending" || status === "paused") && (
                  <button
                    className="btn primary"
                    type="button"
                    onClick={
                      status === "pending" ? startSession : resumeSession
                    }
                  >
                    {status === "pending" ? "Start session" : "Resume session"}
                  </button>
                )}

                {status === "running" && (
                  <button className="btn" type="button" onClick={pauseSession}>
                    Pause session
                  </button>
                )}
              </div>

              {/* Artifacts preview */}
              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>
                  Artifacts
                </div>
                {!artifacts.length ? (
                  <div className="sv-muted">
                    No artifacts yet (notes, photos, metrics, etc.).
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    {artifacts.slice(0, 6).map((a) => (
                      <div
                        key={a.id}
                        style={{
                          border: "1px solid #eee",
                          borderRadius: 12,
                          padding: 10,
                        }}
                      >
                        <div style={{ fontWeight: 800, fontSize: 12 }}>
                          {a.kind}
                        </div>
                        <div
                          className="sv-muted"
                          style={{ marginTop: 4, whiteSpace: "pre-wrap" }}
                        >
                          {a?.payload?.text || JSON.stringify(a.payload)}
                        </div>
                        <div
                          className="sv-muted"
                          style={{ fontSize: 11, marginTop: 4 }}
                        >
                          {a.createdAt}
                        </div>
                      </div>
                    ))}
                    {artifacts.length > 6 && (
                      <div className="sv-muted">
                        …and {artifacts.length - 6} more
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Debug timestamps (optional helpful info) */}
              <div className="sv-muted" style={{ fontSize: 12, marginTop: 14 }}>
                {startedAt ? `Started: ${startedAt}` : ""}
                {pausedAt ? ` • Paused: ${pausedAt}` : ""}
                {completedAt ? ` • Completed: ${completedAt}` : ""}
                {abortedAt ? ` • Aborted: ${abortedAt}` : ""}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Swap modal */}
      <Modal
        open={swapOpen}
        title="Swap session"
        onClose={() => setSwapOpen(false)}
      >
        <div className="sv-muted" style={{ marginBottom: 12 }}>
          Start a new cleaning session template. Your current session state is
          checkpointed automatically.
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 10,
          }}
        >
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await persistCheckpoint("swap.modal.before_new");
              await startNewSession("kitchen-reset");
              setSwapOpen(false);
            }}
          >
            Kitchen reset
          </button>

          <button
            type="button"
            className="btn"
            onClick={async () => {
              await persistCheckpoint("swap.modal.before_new");
              await startNewSession("bathroom-blitz");
              setSwapOpen(false);
            }}
          >
            Bathroom blitz
          </button>

          <button
            type="button"
            className="btn"
            onClick={async () => {
              await persistCheckpoint("swap.modal.before_new");
              await startNewSession("floor-reset");
              setSwapOpen(false);
            }}
          >
            Floor reset
          </button>

          <button
            type="button"
            className="btn"
            onClick={async () => {
              await persistCheckpoint("swap.modal.before_new");
              await startNewSession("laundry-sprint");
              setSwapOpen(false);
            }}
          >
            Laundry sprint
          </button>
        </div>

        <div
          style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}
        >
          <button
            type="button"
            className="btn"
            onClick={async () => {
              setSwapOpen(false);
              if (status === "paused") await resumeSession();
            }}
          >
            Keep current
          </button>

          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              await abortSession("swap.modal.abort");
              setSwapOpen(false);
            }}
          >
            Abort current
          </button>
        </div>
      </Modal>
    </div>
  );
}
