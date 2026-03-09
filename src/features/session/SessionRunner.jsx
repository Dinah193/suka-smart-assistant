/**
 * C:\Users\larho\suka-smart-assistant\src\features\session\SessionRunner.jsx
 *
 * SessionRunnerShim — background controller for SSA sessions
 * across domains (cooking, cleaning, garden, animals, preservation, storehouse).
 *
 * How this fits:
 * - NOT a React component anymore; this is a UI-agnostic shim module.
 * - Manages a single active session in memory + Dexie.
 * - Keeps timers running via a Web Worker (with setInterval fallback),
 *   even if your React UI unmounts or routes change.
 * - Persists checkpoints to Dexie after each step change and every 10s while running.
 * - Auto-resume helper can rehydrate a prior "running" session from Dexie.
 * - Emits consistent events via src/services/events/eventBus.js and optionally exports to Hub.
 * - Uses progressive enhancement: Wake Lock, Notifications, Media Session, Doc-PiP mini HUD.
 *
 * Contracts honored:
 * - Event payload: { type, ts, source, data } where ts is ISO 8601.
 * - Feature flag: featureFlags.familyFundMode (boolean).
 * - Hub helpers: HubPacketFormatter, FamilyFundConnector.
 * - Dexie: db.sessions store already exists; we use db.sessions.put/get.
 *
 * Usage from React (example):
 *
 *   import SessionRunnerShim from "@/features/session/SessionRunner";
 *
 *   useEffect(() => {
 *     const unsub = SessionRunnerShim.onChange((state) => {
 *       setSessionState(state); // for UI
 *     });
 *     SessionRunnerShim.initFromSession(sessionObj); // or initFromId(id)
 *     return unsub;
 *   }, [sessionObj?.id]);
 *
 *   // UI buttons:
 *   SessionRunnerShim.start();
 *   SessionRunnerShim.togglePause();
 *   SessionRunnerShim.next();
 *   SessionRunnerShim.prev();
 *   SessionRunnerShim.abort();
 *   SessionRunnerShim.openMiniHUD();
 *
 * Extension points:
 * - SessionRunnerShim.addGuard(name, fn)
 * - SessionRunnerShim.addCueRenderer(name, rendererFn)  (for HUD, optional)
 *
 * © Suka Smart Assistant
 */

// --- SSA services (defensive imports) ---------------------------------------
let eventBus;
try {
  // expected: export default { emit({type, ts, source, data}) }
  // eslint-disable-next-line global-require
  eventBus = require("../../services/events/eventBus.js").default;
} catch {
  eventBus = { emit: () => {} };
}

let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line global-require
  featureFlags = require("@/config/featureFlags.json");
} catch {
  /* noop */
}

let HubPacketFormatter;
let FamilyFundConnector;
try {
  // eslint-disable-next-line global-require
  HubPacketFormatter =
    require("@/services/hub/HubPacketFormatter.js").HubPacketFormatter;
  // eslint-disable-next-line global-require
  FamilyFundConnector =
    require("@/services/hub/FamilyFundConnector.js").FamilyFundConnector;
} catch {
  /* noop */
}

let db;
try {
  // expected to export a Dexie instance with a 'sessions' table
  // eslint-disable-next-line global-require
  db = require("../../services/db.js").db;
} catch {
  /* noop */
}

/**
 * @typedef {Object} SessionSource
 * @property {"recipe"|"cleaningPlan"|"gardenPlan"|"animalTask"|"import"|"manual"} type
 * @property {string|null} refId
 */

/**
 * @typedef {Object} SessionStepMetadata
 * @property {number} [tempTargetF]
 * @property {"color"|"texture"|"probeTemp"|"timer"|"smell"} [donenessCue]
 * @property {string} [cueNotes]
 */

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment"|"battery">} [blockers]
 * @property {SessionStepMetadata} [metadata]
 */

/**
 * @typedef {Object} SessionPrefs
 * @property {boolean} voiceGuidance
 * @property {boolean} haptic
 * @property {boolean} autoAdvance
 */

/**
 * @typedef {Object} SessionProgress
 * @property {number} currentStepIndex
 * @property {number} elapsedSec
 * @property {string|null} startedAt
 * @property {string|null} pausedAt
 */

/**
 * @typedef {Object} SessionAnalyticsAdjustment
 * @property {string} ts
 * @property {string} type
 * @property {any} [guards]
 */

/**
 * @typedef {Object} SessionAnalytics
 * @property {string[]} skippedSteps
 * @property {SessionAnalyticsAdjustment[]} adjustments
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} title
 * @property {SessionSource} source
 * @property {SessionStep[]} steps
 * @property {SessionPrefs} prefs
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @property {SessionProgress} progress
 * @property {SessionAnalytics} analytics
 * @property {string} createdAt
 * @property {string} updatedAt
 */

// --- small helpers ----------------------------------------------------------

/**
 * Format ISO timestamp now.
 * @returns {string}
 */
const isoNow = () => new Date().toISOString();

/**
 * Safe event emit wrapper.
 * @param {string} type
 * @param {string} source
 * @param {any} data
 */
function emit(type, source, data) {
  try {
    eventBus.emit({ type, ts: isoNow(), source, data });
  } catch {
    /* noop */
  }
}

/**
 * Merge with defaults to tolerate missing fields.
 * @param {Partial<Session>} s
 * @returns {Session}
 */
function normalizeSession(s) {
  const base = {
    id: "",
    domain: "cooking",
    title: "Untitled Session",
    source: { type: "manual", refId: null },
    steps: [],
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: isoNow(),
    updatedAt: isoNow(),
  };
  const out = { ...base, ...(s || {}) };
  out.prefs = { ...base.prefs, ...(s?.prefs || {}) };
  out.progress = { ...base.progress, ...(s?.progress || {}) };
  out.analytics = { ...base.analytics, ...(s?.analytics || {}) };
  out.steps = Array.isArray(s?.steps) ? s.steps : [];
  return out;
}

// --- Tick channel using Worker or setInterval -------------------------------

/**
 * Build an inline Worker that posts {type:"tick", now, deltaSec:1} every second,
 * pausing when told. Fallback to setInterval if Worker unsupported.
 * @param {(payload: {type:"tick", now:number, deltaSec:number}) => void} onTick
 */
function createTickChannel(onTick) {
  let stop = () => {};
  if (typeof window !== "undefined" && window.Worker) {
    const code = `
      let running = false, intervalId = null;
      function start(){
        if(intervalId) return;
        running = true;
        intervalId = setInterval(() => {
          if(running) self.postMessage({type:"tick", now: Date.now(), deltaSec:1});
        }, 1000);
      }
      function pause(){ running = false; }
      function resume(){ running = true; }
      function stopAll(){ running=false; clearInterval(intervalId); intervalId=null; }
      self.onmessage = (e)=>{
        const {cmd} = e.data||{};
        if(cmd==="start") start();
        if(cmd==="pause") pause();
        if(cmd==="resume") resume();
        if(cmd==="stop") stopAll();
      };
    `;
    const blob = new Blob([code], { type: "application/javascript" });
    const w = new Worker(URL.createObjectURL(blob));
    const handler = (e) => {
      if (e?.data?.type === "tick") onTick(e.data);
    };
    w.addEventListener("message", handler);
    w.postMessage({ cmd: "start" });
    stop = () => {
      try {
        w.postMessage({ cmd: "stop" });
        w.terminate();
      } catch {
        /* noop */
      }
    };
    return {
      pause: () => w.postMessage({ cmd: "pause" }),
      resume: () => w.postMessage({ cmd: "resume" }),
      stop,
    };
  }

  // Fallback
  let running = true;
  const id = setInterval(() => {
    if (running) onTick({ type: "tick", now: Date.now(), deltaSec: 1 });
  }, 1000);
  stop = () => clearInterval(id);
  return {
    pause: () => {
      running = false;
    },
    resume: () => {
      running = true;
    },
    stop,
  };
}

// --- Wake Lock --------------------------------------------------------------

async function requestWakeLock() {
  try {
    if (typeof navigator !== "undefined" && "wakeLock" in navigator) {
      // @ts-ignore
      const lock = await navigator.wakeLock.request("screen");
      return lock;
    }
  } catch {
    /* ignored */
  }
  return null;
}

// --- Notifications helpers --------------------------------------------------

async function notifyEnsurePermission() {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return "unsupported";
    }
    if (Notification.permission === "granted") return "granted";
    const res = await Notification.requestPermission();
    return res;
  } catch {
    return "denied";
  }
}

/**
 * @param {Session} session
 * @param {SessionStep|null} step
 * @param {boolean} [actions]
 */
function showOngoingNotification(session, step, actions = true) {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    const idx = session?.progress?.currentStepIndex || 0;
    const body = step
      ? `Step ${idx + 1}: ${step.title}`
      : "Session in progress";
    const opts = {
      body,
      tag: `ssa-session-${session?.id || "unknown"}`,
      renotify: true,
      requireInteraction: false,
      actions: actions
        ? [
            { action: "pause", title: "Pause" },
            { action: "next", title: "Next" },
          ]
        : [],
    };
    // eslint-disable-next-line no-new
    new Notification(session?.title || "Session", opts);
  } catch {
    /* noop */
  }
}

// --- Media Session handlers -------------------------------------------------

function wireMediaSessionHandlers({ onPlayPause, onNext, onPrev }) {
  try {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return () => {};
    }
    navigator.mediaSession.setActionHandler("play", onPlayPause);
    navigator.mediaSession.setActionHandler("pause", onPlayPause);
    navigator.mediaSession.setActionHandler("previoustrack", onPrev);
    navigator.mediaSession.setActionHandler("nexttrack", onNext);
    return () => {
      try {
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
      } catch {
        /* noop */
      }
    };
  } catch {
    return () => {};
  }
}

// --- Simple TTS -------------------------------------------------------------

function speak(text) {
  try {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.pitch = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    /* noop */
  }
}

// --- Guards (stubs; integrate your real guards here) ------------------------

const guardRegistry = {
  sabbath: async () => true,
  quietHours: async () => true,
  weather: async () => true,
  inventory: async () => true,
  equipment: async () => true,
  battery: async () => true, // optional
};

/**
 * Register/override a guard.
 * @param {string} name
 * @param {(step: SessionStep, session: Session) => Promise<boolean>|boolean} fn
 */
function addGuard(name, fn) {
  guardRegistry[name] = fn;
}

/**
 * @param {SessionStep|null} step
 * @param {Session} session
 * @returns {Promise<{ok:boolean, failed:string[]}>}
 */
async function evaluateStepGuards(step, session) {
  if (!step) return { ok: true, failed: [] };
  const blockers = Array.isArray(step?.blockers) ? step.blockers : [];
  const results = await Promise.all(
    blockers.map(async (b) => {
      const guard = guardRegistry[b];
      const ok = guard ? await guard(step, session) : true;
      return { name: b, ok };
    })
  );
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  return { ok: failed.length === 0, failed };
}

// --- Cue renderers for mini HUD (optional) ----------------------------------

const cueRenderers = {
  color: (notes) => `Color: ${notes || "watch for browning"}`,
  texture: (notes) => `Texture: ${notes || "smooth/firm cue"}`,
  probeTemp: (notes) => `Probe Temp: ${notes || "check thermometer"}`,
  timer: (notes) => `Timer: ${notes || "watch countdown"}`,
  smell: (notes) => `Smell: ${notes || "aroma cue"}`,
};

/**
 * @param {string} name
 * @param {(notes?:string) => string} renderer
 */
function addCueRenderer(name, renderer) {
  cueRenderers[name] = renderer;
}

// --- Document Picture-in-Picture mini HUD -----------------------------------

/**
 * Create a tiny always-on-top Picture-in-Picture window with controls wired
 * directly to the SessionRunnerShim controls. Optional.
 * @param {() => Session|null} getState
 * @param {{onPrev: () => void, onPlayPause: () => void, onNext: () => void}} handlers
 */
async function openMiniHUD(getState, handlers) {
  try {
    // @ts-ignore
    if (typeof window === "undefined" || !window.documentPictureInPicture) {
      return null;
    }
    // @ts-ignore
    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 360,
      height: 180,
    });
    const doc = pipWindow.document;
    doc.body.style.margin = "0";
    doc.body.style.fontFamily = "system-ui, sans-serif";
    doc.body.style.background = "#0b0f14";
    doc.body.style.color = "#e8ecf1";
    doc.body.innerHTML = `
      <div style="display:grid;grid-template-rows:auto 1fr auto;gap:8px;padding:10px;height:100%;">
        <div style="font-weight:700" id="title">Session</div>
        <div id="content" style="font-size:12px;opacity:.9"></div>
        <div style="display:flex;gap:8px;justify-content:space-between">
          <button id="prev">Prev</button>
          <button id="pause">Pause</button>
          <button id="next">Next</button>
        </div>
      </div>
    `;
    const update = () => {
      const s = getState();
      const titleNode = doc.getElementById("title");
      const contentNode = doc.getElementById("content");
      const pauseNode = doc.getElementById("pause");
      if (!titleNode || !contentNode || !pauseNode) return;
      if (!s) {
        titleNode.textContent = "Session";
        contentNode.textContent = "—";
        pauseNode.textContent = "Pause";
        return;
      }
      titleNode.textContent = s.title || "Session";
      const idx = s.progress?.currentStepIndex || 0;
      const step = s.steps?.[idx] || null;
      contentNode.textContent = step ? `Step ${idx + 1}: ${step.title}` : "—";
      pauseNode.textContent = s.status === "paused" ? "Resume" : "Pause";
    };
    pipWindow.addEventListener("pagehide", () => {
      if (pipWindow.close) pipWindow.close();
    });
    doc.getElementById("prev").addEventListener("click", handlers.onPrev);
    doc.getElementById("pause").addEventListener("click", handlers.onPlayPause);
    doc.getElementById("next").addEventListener("click", handlers.onNext);
    const timer = setInterval(update, 500);
    pipWindow.addEventListener("unload", () => clearInterval(timer));
    update();
    return pipWindow;
  } catch {
    return null;
  }
}

// --- Shim state & listeners -------------------------------------------------

/** @type {Session|null} */
let currentSession = null;

/** @type {Set<(state: Session|null) => void>} */
const listeners = new Set();

/** @type {{pause:() => void, resume:() => void, stop:() => void}|null} */
let tickChannel = null;

/** @type {any} */
let wakeLockRef = null;

/** @type {number} */
let tenSecondCounter = 0;

/** @type {Window|null} */
let pipWindowRef = null;

/** @type {() => void} */
let cleanupMediaSessionHandlers = () => {};

/**
 * Notify all registered listeners of state changes.
 */
function notifyListeners() {
  listeners.forEach((fn) => {
    try {
      fn(currentSession);
    } catch {
      /* noop */
    }
  });
}

/**
 * Save a checkpoint to Dexie.
 * @param {Session} s
 */
async function saveCheckpoint(s) {
  try {
    if (!db?.sessions) return;
    await db.sessions.put(s);
  } catch {
    /* noop */
  }
}

/**
 * Ensure tick channel exists.
 */
function ensureTickChannel() {
  if (!tickChannel) {
    tickChannel = createTickChannel(({ deltaSec }) => {
      if (!currentSession || currentSession.status !== "running") return;
      const elapsedSec = (currentSession.progress?.elapsedSec || 0) + deltaSec;
      currentSession = {
        ...currentSession,
        progress: {
          ...currentSession.progress,
          elapsedSec,
        },
        updatedAt: isoNow(),
      };
      tenSecondCounter = (tenSecondCounter + 1) % 10;
      if (tenSecondCounter === 0) {
        // checkpoint every 10 seconds
        saveCheckpoint(currentSession);
      }
      notifyListeners();
    });
  }
}

/**
 * Tear down tick channel.
 */
function stopTickChannel() {
  try {
    tickChannel?.stop();
  } catch {
    /* noop */
  }
  tickChannel = null;
}

/**
 * Request wake lock and re-acquire on visibility change.
 */
function ensureWakeLock() {
  if (typeof document === "undefined") return;
  requestWakeLock().then((lock) => {
    wakeLockRef = lock;
  });
  const handler = () => {
    if (document.visibilityState === "visible" && wakeLockRef?.released) {
      requestWakeLock().then((lock) => {
        wakeLockRef = lock;
      });
    }
  };
  document.addEventListener("visibilitychange", handler, { once: true });
}

/**
 * Ensure notifications permission is requested & SW listener registered.
 */
function ensureNotifications() {
  notifyEnsurePermission();
  try {
    if (!navigator?.serviceWorker) return;
    const handler = (e) => {
      const data = e?.data;
      if (!data || data.type !== "session-control") return;
      if (data.action === "pause") {
        togglePause();
      }
      if (data.action === "next") {
        next();
      }
      if (data.action === "prev") {
        prev();
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
  } catch {
    /* noop */
  }
}

/**
 * Ensure MediaSession handlers are wired.
 */
function ensureMediaSession() {
  cleanupMediaSessionHandlers = wireMediaSessionHandlers({
    onPlayPause: () => togglePause(),
    onNext: () => next(),
    onPrev: () => prev(),
  });
}

/**
 * Step-level helper for current step.
 * @returns {SessionStep|null}
 */
function getCurrentStep() {
  if (!currentSession) return null;
  const idx = currentSession.progress?.currentStepIndex || 0;
  return currentSession.steps?.[idx] || null;
}

// --- Public API -------------------------------------------------------------

/**
 * Initialize shim from a complete session object.
 * Uses normalizeSession and does NOT auto-start.
 * @param {Session} session
 */
async function initFromSession(session) {
  if (!session) return;
  currentSession = normalizeSession(session);
  tenSecondCounter = 0;
  ensureTickChannel();
  ensureWakeLock();
  ensureNotifications();
  ensureMediaSession();
  await saveCheckpoint(currentSession);
  notifyListeners();
}

/**
 * Initialize shim by loading from Dexie via id.
 * If found and status === "running", we keep it running.
 * @param {string} sessionId
 */
async function initFromId(sessionId) {
  if (!sessionId || !db?.sessions) return;
  try {
    const stored = await db.sessions.get(sessionId);
    if (!stored) return;
    currentSession = normalizeSession(stored);
    tenSecondCounter = 0;
    ensureTickChannel();
    ensureWakeLock();
    ensureNotifications();
    ensureMediaSession();
    notifyListeners();
  } catch {
    /* noop */
  }
}

/**
 * Auto-resume last running session from Dexie if any.
 */
async function autoResumeLastRunning() {
  if (!db?.sessions) return;
  try {
    const coll = db.sessions.toCollection();
    const running = await coll.filter((s) => s.status === "running").first();
    if (!running) return;
    currentSession = normalizeSession(running);
    tenSecondCounter = 0;
    ensureTickChannel();
    ensureWakeLock();
    ensureNotifications();
    ensureMediaSession();
    notifyListeners();
  } catch {
    /* noop */
  }
}

/**
 * Subscribe to state changes.
 * @param {(state: Session|null) => void} listener
 * @returns {() => void} unsubscribe
 */
function onChange(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  // immediate emit current state
  try {
    listener(currentSession);
  } catch {
    /* noop */
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Get current session state.
 * @returns {Session|null}
 */
function getState() {
  return currentSession;
}

/**
 * Start session if pending or paused.
 */
async function start() {
  if (!currentSession) return;
  if (
    currentSession.status !== "pending" &&
    currentSession.status !== "paused"
  ) {
    return;
  }
  ensureTickChannel();
  ensureWakeLock();
  ensureNotifications();
  ensureMediaSession();

  const now = isoNow();
  currentSession = {
    ...currentSession,
    status: "running",
    progress: {
      ...currentSession.progress,
      startedAt: currentSession.progress.startedAt || now,
      pausedAt: null,
    },
    updatedAt: now,
  };
  await saveCheckpoint(currentSession);
  emit("session.started", "SessionRunnerShim", {
    id: currentSession.id,
    domain: currentSession.domain,
  });

  const step = getCurrentStep();
  if (currentSession.prefs?.voiceGuidance) {
    const intro = step ? `Step 1: ${step.title}` : "";
    speak(`Starting session. ${intro}`);
  }

  showOngoingNotification(currentSession, step, true);
  tickChannel?.resume?.();
  notifyListeners();
}

/**
 * Pause or resume.
 */
async function togglePause() {
  if (!currentSession) return;
  if (
    currentSession.status !== "running" &&
    currentSession.status !== "paused"
  ) {
    return;
  }
  const nextStatus = currentSession.status === "running" ? "paused" : "running";
  const now = isoNow();
  currentSession = {
    ...currentSession,
    status: nextStatus,
    progress: {
      ...currentSession.progress,
      pausedAt: nextStatus === "paused" ? now : null,
    },
    updatedAt: now,
  };
  await saveCheckpoint(currentSession);
  if (nextStatus === "paused") {
    emit("session.paused", "SessionRunnerShim", {
      id: currentSession.id,
    });
    tickChannel?.pause?.();
  } else {
    emit("session.resumed", "SessionRunnerShim", {
      id: currentSession.id,
    });
    tickChannel?.resume?.();
  }
  const step = getCurrentStep();
  showOngoingNotification(currentSession, step, true);
  notifyListeners();
}

/**
 * Move to next step; if at last step, complete.
 */
async function next() {
  if (!currentSession) return;
  const total = currentSession.steps?.length || 0;
  const idx = currentSession.progress?.currentStepIndex || 0;

  // Last step -> complete
  if (idx >= total - 1) {
    const now = isoNow();
    currentSession = {
      ...currentSession,
      status: "completed",
      updatedAt: now,
    };
    await saveCheckpoint(currentSession);
    emit("session.completed", "SessionRunnerShim", {
      id: currentSession.id,
      domain: currentSession.domain,
    });

    if (
      featureFlags.familyFundMode &&
      HubPacketFormatter &&
      FamilyFundConnector
    ) {
      try {
        const payload = HubPacketFormatter.formatSession(currentSession);
        await FamilyFundConnector.send(payload);
        emit("session.exported", "SessionRunnerShim", {
          id: currentSession.id,
        });
      } catch {
        /* fail silent */
      }
    }

    tickChannel?.pause?.();
    showOngoingNotification(currentSession, null, false);
    notifyListeners();
    return;
  }

  const nextStep = currentSession.steps[idx + 1];
  const guards = await evaluateStepGuards(nextStep, currentSession);
  if (!guards.ok) {
    // record an analytics adjustment
    const now = isoNow();
    currentSession = {
      ...currentSession,
      analytics: {
        ...currentSession.analytics,
        adjustments: [
          ...(currentSession.analytics?.adjustments || []),
          {
            ts: now,
            type: "blocked",
            guards: guards.failed,
          },
        ],
      },
      updatedAt: now,
    };
    await saveCheckpoint(currentSession);
    notifyListeners();
    return;
  }

  const now = isoNow();
  currentSession = {
    ...currentSession,
    progress: {
      ...currentSession.progress,
      currentStepIndex: idx + 1,
    },
    updatedAt: now,
  };
  await saveCheckpoint(currentSession);
  emit("session.step.changed", "SessionRunnerShim", {
    id: currentSession.id,
    stepIndex: idx + 1,
  });

  const step = nextStep;
  if (currentSession.prefs?.voiceGuidance && step) {
    speak(`Step ${idx + 2}: ${step.title}`);
  }
  showOngoingNotification(currentSession, step, true);
  notifyListeners();
}

/**
 * Move to previous step (floor at 0).
 */
async function prev() {
  if (!currentSession) return;
  const idx = currentSession.progress?.currentStepIndex || 0;
  const nextIdx = Math.max(0, idx - 1);
  const now = isoNow();
  currentSession = {
    ...currentSession,
    progress: {
      ...currentSession.progress,
      currentStepIndex: nextIdx,
    },
    updatedAt: now,
  };
  await saveCheckpoint(currentSession);
  emit("session.step.changed", "SessionRunnerShim", {
    id: currentSession.id,
    stepIndex: nextIdx,
  });
  const step = getCurrentStep();
  if (currentSession.prefs?.voiceGuidance && step) {
    speak(`Back to step ${nextIdx + 1}`);
  }
  showOngoingNotification(currentSession, step, true);
  notifyListeners();
}

/**
 * Abort the session (mark as aborted and export if familyFundMode).
 */
async function abort() {
  if (!currentSession) return;
  const now = isoNow();
  currentSession = {
    ...currentSession,
    status: "aborted",
    updatedAt: now,
  };
  await saveCheckpoint(currentSession);
  emit("session.aborted", "SessionRunnerShim", {
    id: currentSession.id,
    domain: currentSession.domain,
  });

  if (
    featureFlags.familyFundMode &&
    HubPacketFormatter &&
    FamilyFundConnector
  ) {
    try {
      const payload = HubPacketFormatter.formatSession(currentSession);
      await FamilyFundConnector.send(payload);
      emit("session.exported", "SessionRunnerShim", {
        id: currentSession.id,
      });
    } catch {
      /* noop */
    }
  }

  tickChannel?.pause?.();
  showOngoingNotification(currentSession, null, false);
  notifyListeners();
}

/**
 * Gracefully stop background processing (e.g., on logout).
 */
async function teardown() {
  stopTickChannel();
  try {
    if (wakeLockRef) {
      await wakeLockRef.release?.();
    }
  } catch {
    /* noop */
  }
  wakeLockRef = null;
  cleanupMediaSessionHandlers();
  cleanupMediaSessionHandlers = () => {};
  if (pipWindowRef && !pipWindowRef.closed) {
    try {
      pipWindowRef.close();
    } catch {
      /* noop */
    }
  }
  pipWindowRef = null;
}

/**
 * Open / toggle the mini HUD window (Document Picture-in-Picture).
 */
async function toggleMiniHUD() {
  if (pipWindowRef && !pipWindowRef.closed) {
    try {
      pipWindowRef.close();
    } catch {
      /* noop */
    }
    pipWindowRef = null;
    return;
  }
  pipWindowRef = await openMiniHUD(getState, {
    onPrev: () => {
      prev();
    },
    onPlayPause: () => {
      togglePause();
    },
    onNext: () => {
      next();
    },
  });
}

// --- Exported shim object ---------------------------------------------------

const SessionRunnerShim = {
  // state
  getState,
  onChange,

  // init / resume
  initFromSession,
  initFromId,
  autoResumeLastRunning,

  // controls
  start,
  togglePause,
  next,
  prev,
  abort,
  teardown,
  toggleMiniHUD,

  // extension points
  addGuard,
  addCueRenderer,
};

export default SessionRunnerShim;
