// C:\Users\larho\suka-smart-assistant\src\services\cookingBus.js
/**
 * cookingBus
 * ----------
 * Central event hub and lightweight runtime for cooking & batch sessions.
 *
 * Capabilities:
 *  - Create/track cooking sessions (batch or single-meal)
 *  - Derive step lists from recipes; mark started/completed; add notes/photos
 *  - In-memory timers per step with pause/resume/cancel + emits on finish
 *  - Persist/reload sessions to JSON DB with debounce + lock
 *  - Emit domain events for inventory deltas, label printing requests, n8n automations
 *  - Broadcast to Socket.IO (if present) using user rooms
 *
 * Optional integrations (auto-detected):
 *   - preferencesService (default portions / sabbath hints)
 *   - labelsService (PDF/label printing)
 *   - n8nClient (automations)
 *   - server/socket (realtime UI)
 *   - inventoryService (deduct/reserve ingredients)
 *   - recipeConsolidator (normalize recipe inputs)
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { EventEmitter } = require("events");
const { v4: _v4 } = (() => {
  try { return require("uuid").v4; } catch { return null; }
})();
const uuidv4 = () =>
  (_v4 ? _v4() : `id_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);

function tryRequire(p) { try { return require(p); } catch { return null; } }

// Optional services (soft requires; multiple resolutions for monorepo paths)
const preferences = tryRequire("../server/services/preferencesService")
  || tryRequire("./planning/../server/services/preferencesService");
const labelsService = tryRequire("../server/services/labelsService");
const n8n = tryRequire("../server/services/n8nClient");
const socketMod = tryRequire("../server/socket");
const inventoryService = tryRequire("./inventory/InventoryService")
  || tryRequire("../services/inventory/InventoryService")
  || tryRequire("../server/services/inventoryService");
const recipeConsolidator = tryRequire("./recipes/recipeConsolidator")
  || tryRequire("../features/meals/recipeConsolidator");

// Storage
const DATA_DIR = path.resolve(__dirname, "../data");
const DB_PATH = path.join(DATA_DIR, "cookingSessions.json");
const LOCK_PATH = `${DB_PATH}.lock`;

const DEFAULT_TIMER_GRACE_MS = 5_000;
const AUTOSAVE_MS = 1_000;
const DB_WRITE_DEBOUNCE_MS = 300;

// Domain events (aligned to orchestrator expectations where possible)
const E = {
  SESSION: {
    CREATED: "session:created",
    UPDATED: "session:updated",
    STARTED: "SESSION.STARTED.COOKING",   // for orchestrator
    FINISHED: "SESSION.FINISHED.COOKING", // for orchestrator
    CANCELED: "session:canceled",
    NOTE: "session:note",
  },
  STEP: {
    STATUS: "step:status",
  },
  TIMER: {
    STARTED: "timer:started",
    PAUSED: "timer:paused",
    RESUMED: "timer:resumed",
    CANCELED: "timer:canceled",
    FINISHED: "timer:finished",
    GRACE: "timer:grace",
  },
  LABELS: {
    READY: "labels:ready",
    ERROR: "labels:error",
  },
  INV: {
    DELTA: "inventory:delta",
  },
  AUTOMATION: {
    EXEC: "automation:execution",
    ERROR: "automation:error",
  },
};

/* -------------------------------------------------------------------------- */
/* Internal state                                                             */
/* -------------------------------------------------------------------------- */

const Bus = new EventEmitter();                // public event bus
const _timers = new Map();                     // timerId -> { timeout, data }
let _dbCache = { version: 2, sessions: [], updatedAt: null };
let _dbWriteTimer = null;
let _lockHandle = null;

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

const nowISO = () => new Date().toISOString();

function safeGetIO() {
  try { return socketMod?.getIO ? socketMod.getIO() : null; } catch { return null; }
}

function emitSocket(userId, event, payload, ns = "/core") {
  const io = safeGetIO();
  if (!io || !userId) return;
  io.of(ns).to(`user:${userId}`).emit(event, payload);
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try { await fsp.access(DB_PATH, fs.constants.F_OK); }
  catch {
    await fsp.writeFile(
      DB_PATH,
      JSON.stringify({ version: 2, sessions: [], updatedAt: nowISO() }, null, 2),
      "utf8"
    );
  }
}

async function acquireLock() {
  try {
    _lockHandle = await fsp.open(LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    await _lockHandle.write(String(process.pid));
    return true;
  } catch {
    return false;
  }
}

async function releaseLock() {
  if (_lockHandle) {
    try {
      await _lockHandle.close();
      await fsp.unlink(LOCK_PATH);
    } catch {}
    _lockHandle = null;
  }
}

async function readDB() {
  await ensureDirs();
  try {
    const raw = await fsp.readFile(DB_PATH, "utf8");
    _dbCache = raw ? JSON.parse(raw) : { version: 2, sessions: [] };
    // lightweight migration
    if (!_dbCache.version) _dbCache.version = 1;
    if (!_dbCache.sessions) _dbCache.sessions = [];
  } catch {
    _dbCache = { version: 2, sessions: [], updatedAt: nowISO() };
  }
  return _dbCache;
}

async function _writeDBImmediately(db) {
  const tmp = `${DB_PATH}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fsp.rename(tmp, DB_PATH);
}

async function writeDB(db) {
  db.updatedAt = nowISO();
  // debounce & lock for safety in multi-calls
  clearTimeout(_dbWriteTimer);
  _dbWriteTimer = setTimeout(async () => {
    const haveLock = await acquireLock();
    try {
      await _writeDBImmediately(db);
    } finally {
      if (haveLock) await releaseLock();
    }
  }, DB_WRITE_DEBOUNCE_MS);
  return db;
}

function getSessionById(id) {
  return _dbCache.sessions.find((s) => s.id === id) || null;
}

function persistAndBroadcast(userId, type, payload, session, socketEvent = null) {
  writeDB(_dbCache).catch(() => {});
  Bus.emit(type, payload);
  emitSocket(userId, `cooking:${socketEvent || type}`, { ...payload, sessionId: session?.id });
}

function sabbathAvoidDefault() {
  try {
    const v = preferences?.getGlobal?.("sabbath.avoidSaturday");
    if (typeof v === "boolean") return v;
  } catch {}
  return true; // default: avoid Saturday scheduling
}

/* -------------------------------------------------------------------------- */
/* Recipe normalization                                                       */
/* -------------------------------------------------------------------------- */

function normalizeRecipe(r, i = 0, defaultPortions = 4) {
  // Optional consolidator pre-pass
  if (recipeConsolidator?.normalize) {
    try { r = recipeConsolidator.normalize(r); } catch {}
  }

  const rawSteps = Array.isArray(r.steps)
    ? r.steps
    : Array.isArray(r.instructions)
    ? r.instructions
    : [];

  const steps = rawSteps.map((s, idx) => ({
    id: uuidv4(),
    idx,
    text: typeof s === "string" ? s : (s?.text || `Step ${idx + 1}`),
    status: "pending",     // 'pending' | 'in_progress' | 'done' | 'skipped'
    notes: [],
    timers: [],            // timerIds
    durationMin: Number(s?.durationMin || 0) || null,
  }));

  return {
    id: r.id || `recipe_${i}`,
    title: r.title || r.name || `Recipe ${i + 1}`,
    portions: Number(r.portions || defaultPortions),
    ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
    steps,
    tags: r.tags || [],
    meta: r.meta || {},
  };
}

/* -------------------------------------------------------------------------- */
/* Timers                                                                     */
/* -------------------------------------------------------------------------- */

function _timerKey(id) { return `timer:${id}`; }

function _createTimeout(timerId) {
  const t = _timers.get(_timerKey(timerId));
  if (!t) return;
  const remaining = t.data.remainingMs;
  if (remaining <= 0) return;

  const timeout = setTimeout(() => {
    // finish (only if still running)
    const entry = _timers.get(_timerKey(timerId));
    if (!entry || entry.data.status !== "running") return;

    entry.data.status = "done";
    _timers.delete(_timerKey(timerId));

    const payload = {
      id: timerId,
      userId: entry.data.userId,
      sessionId: entry.data.sessionId,
      stepId: entry.data.stepId,
      label: entry.data.label,
      finishedAt: nowISO(),
    };

    Bus.emit(E.TIMER.FINISHED, payload);
    emitSocket(entry.data.userId, `cooking:${E.TIMER.FINISHED}`, payload);
    setTimeout(() => {
      emitSocket(entry.data.userId, `cooking:${E.TIMER.GRACE}`, { id: timerId, sessionId: entry.data.sessionId, stepId: entry.data.stepId });
    }, entry.data.graceMs ?? DEFAULT_TIMER_GRACE_MS);
  }, remaining);

  t.timeout = timeout;
}

function startTimer({ userId, sessionId, recipeId, stepId, minutes = 0, label = "Timer", graceMs = DEFAULT_TIMER_GRACE_MS }) {
  const ms = Math.max(0, Math.round(Number(minutes) * 60 * 1000));
  const id = uuidv4();
  const data = {
    id,
    userId,
    sessionId,
    stepId,
    label,
    startedAt: Date.now(),
    status: "running",
    pausedAt: null,
    remainingMs: ms,
    graceMs,
  };

  _timers.set(_timerKey(id), { data, timeout: null });
  _createTimeout(id);

  const payload = { ...data, dueAtISO: new Date(Date.now() + ms).toISOString() };
  Bus.emit(E.TIMER.STARTED, payload);
  emitSocket(userId, `cooking:${E.TIMER.STARTED}`, payload);

  // Attach timer id to the step if present
  try {
    const s = getSessionById(sessionId);
    const r = s?.recipes?.find((x) => x.id === recipeId);
    const st = r?.steps?.find((x) => x.id === stepId);
    if (st) st.timers.push(id);
    writeDB(_dbCache).catch(() => {});
  } catch {}

  return data;
}

function pauseTimer(timerId) {
  const t = _timers.get(_timerKey(timerId));
  if (!t || t.data.status !== "running") return null;
  clearTimeout(t.timeout);
  t.timeout = null;
  t.data.status = "paused";
  t.data.pausedAt = Date.now();

  // recompute remaining
  // remainingMs = scheduled remaining - elapsed since start/last resume
  const elapsed = Date.now() - (t.data.lastResumedAt || t.data.startedAt);
  t.data.remainingMs = Math.max(0, (t.data.remainingMs ?? 0) - elapsed);

  const payload = { id: timerId, remainingMs: t.data.remainingMs, pausedAt: nowISO() };
  Bus.emit(E.TIMER.PAUSED, payload);
  emitSocket(t.data.userId, `cooking:${E.TIMER.PAUSED}`, payload);
  return t.data;
}

function resumeTimer(timerId) {
  const t = _timers.get(_timerKey(timerId));
  if (!t || t.data.status !== "paused") return null;
  t.data.status = "running";
  t.data.lastResumedAt = Date.now();
  _createTimeout(timerId);

  const payload = { id: timerId, remainingMs: t.data.remainingMs, resumedAt: nowISO() };
  Bus.emit(E.TIMER.RESUMED, payload);
  emitSocket(t.data.userId, `cooking:${E.TIMER.RESUMED}`, payload);
  return t.data;
}

function cancelTimer(timerId) {
  const t = _timers.get(_timerKey(timerId));
  if (!t) return false;
  clearTimeout(t.timeout);
  _timers.delete(_timerKey(timerId));
  const payload = { id: timerId, canceledAt: nowISO() };
  Bus.emit(E.TIMER.CANCELED, payload);
  emitSocket(t.data.userId, `cooking:${E.TIMER.CANCELED}`, payload);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

async function init() {
  await readDB();
  // Wire preference hints (optional)
  try {
    preferences?.onChange?.(({ userId }) => {
      emitSocket(userId, "cooking:prefs_hint", { ts: nowISO(), userId });
    });
  } catch {}
  return true;
}

/**
 * Create a new cooking session.
 * @param {Object} args
 *  - userId (required)
 *  - dateISO (optional; default now)
 *  - title (optional)
 *  - recipes: [{ id, title, steps[], ingredients[], portions? }]
 *  - batch: boolean
 *  - meta: any
 */
async function createSession({ userId, dateISO = nowISO(), title = "Cooking Session", recipes = [], batch = false, meta = {} }) {
  if (!userId) throw new Error("createSession: userId required");

  const defaultPortions =
    (await preferences?.getPreference?.(userId, "meals.portions.default")) || 4;
  const norm = recipes.map((r, i) => normalizeRecipe(r, i, defaultPortions));

  const session = {
    id: uuidv4(),
    userId,
    title,
    dateISO,
    batch,
    recipes: norm,
    status: "active", // 'active' | 'done' | 'canceled'
    createdAt: nowISO(),
    updatedAt: nowISO(),
    notes: [],
    meta: {
      sabbathAvoid: sabbathAvoidDefault(),
      ...(meta || {}),
    },
  };

  _dbCache.sessions.push(session);
  await writeDB(_dbCache);

  const payload = { session };
  Bus.emit(E.SESSION.CREATED, payload);
  emitSocket(userId, "cooking:session:created", payload);
  // Orchestrator-friendly high-level event
  emitSocket(userId, E.SESSION.STARTED, { sessionId: session.id, at: session.createdAt });

  return session;
}

async function getSession(sessionId) {
  if (!_dbCache.sessions?.length) await readDB();
  return getSessionById(sessionId);
}

async function listSessions({ userId, status } = {}) {
  if (!_dbCache.sessions?.length) await readDB();
  return _dbCache.sessions
    .filter((s) => (userId ? s.userId === userId : true))
    .filter((s) => (status ? s.status === status : true))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function patchSession(sessionId, updates = {}) {
  const s = getSessionById(sessionId);
  if (!s) throw new Error("session not found");
  Object.assign(s, updates);
  s.updatedAt = nowISO();
  await writeDB(_dbCache);
  persistAndBroadcast(s.userId, E.SESSION.UPDATED, { sessionId, updates }, s, "session:updated");
  return s;
}

async function addNote(sessionId, text, meta = {}) {
  const s = getSessionById(sessionId);
  if (!s) throw new Error("session not found");
  const note = { id: uuidv4(), text, meta, at: nowISO() };
  s.notes.push(note);
  s.updatedAt = nowISO();
  await writeDB(_dbCache);
  persistAndBroadcast(s.userId, E.SESSION.NOTE, { sessionId, note }, s);
  return note;
}

async function setStepStatus(sessionId, recipeId, stepId, status) {
  const s = getSessionById(sessionId);
  if (!s) throw new Error("session not found");
  const r = s.recipes.find((x) => x.id === recipeId);
  if (!r) throw new Error("recipe not found");
  const step = r.steps.find((st) => st.id === stepId);
  if (!step) throw new Error("step not found");
  if (!["pending", "in_progress", "done", "skipped"].includes(status)) throw new Error("invalid status");

  step.status = status;
  step.updatedAt = nowISO();
  s.updatedAt = nowISO();

  await writeDB(_dbCache);
  persistAndBroadcast(s.userId, E.STEP.STATUS, { sessionId, recipeId, stepId, status }, s);

  // Optional: inventory deduction when step completes and references ingredients
  if (status === "done" && inventoryService?.deductForStep) {
    try {
      const lines = await inventoryService.deductForStep({ userId: s.userId, recipe: r, step });
      if (lines?.length) emitInventoryDelta(s.userId, lines);
    } catch {}
  }

  return step;
}

async function startStep(sessionId, recipeId, stepId) {
  return setStepStatus(sessionId, recipeId, stepId, "in_progress");
}

async function completeStep(sessionId, recipeId, stepId) {
  return setStepStatus(sessionId, recipeId, stepId, "done");
}

async function cancelSession(sessionId, reason = "") {
  const s = getSessionById(sessionId);
  if (!s) return false;
  s.status = "canceled";
  s.canceledAt = nowISO();
  s.updatedAt = nowISO();
  await writeDB(_dbCache);
  persistAndBroadcast(s.userId, E.SESSION.CANCELED, { sessionId, reason }, s);
  return true;
}

async function finishSession(sessionId) {
  const s = getSessionById(sessionId);
  if (!s) return false;
  s.status = "done";
  s.finishedAt = nowISO();
  s.updatedAt = nowISO();
  await writeDB(_dbCache);

  persistAndBroadcast(s.userId, E.SESSION.FINISHED, { sessionId }, s);
  // High-level: tell orchestrator the cooking session finished
  emitSocket(s.userId, E.SESSION.FINISHED, { sessionId, at: s.finishedAt });
  return true;
}

/* -------------------------------------------------------------------------- */
/* Timers API (public)                                                        */
/* -------------------------------------------------------------------------- */

const startTimerPublic = (args) => startTimer(args);
const pause = (id) => pauseTimer(id);
const resume = (id) => resumeTimer(id);
const cancel = (id) => cancelTimer(id);

/* -------------------------------------------------------------------------- */
/* Labels / Inventory / Automations                                           */
/* -------------------------------------------------------------------------- */

async function printLabelsForItems({ userId, templateId = null, items = [], filename = null }) {
  if (!labelsService?.generateLabels) {
    const err = "labelsService not available";
    Bus.emit(E.LABELS.ERROR, { err });
    return { ok: false, error: err };
  }
  const { buffer, filePath, count } = await labelsService.generateLabels({
    templateId,
    items,
    options: { output: filename ? "file" : "buffer", filename },
  });
  const payload = { ok: true, filePath: filePath || null, count };
  Bus.emit(E.LABELS.READY, payload);
  emitSocket(userId, `cooking:${E.LABELS.READY}`, payload);
  return { ok: true, buffer, filePath, count };
}

function emitInventoryDelta(userId, lines = []) {
  const payload = { userId, lines, at: nowISO() };
  Bus.emit(E.INV.DELTA, payload);
  emitSocket(userId, "inventory:delta", payload, "/inventory");
  return payload;
}

async function triggerAutomation(keyOrWorkflowId, data = {}) {
  if (!n8n?.runWorkflow) return { ok: false, error: "n8n client not available" };
  try {
    const res = await n8n.runWorkflow(String(keyOrWorkflowId), data, { waitForFinish: false });
    Bus.emit(E.AUTOMATION.EXEC, { id: res.executionId, data: res.data });
    return { ok: true, executionId: res.executionId };
  } catch (e) {
    const error = String(e.message || e);
    Bus.emit(E.AUTOMATION.ERROR, { error });
    return { ok: false, error };
  }
}

/* -------------------------------------------------------------------------- */
/* Recovery / Autosave                                                        */
/* -------------------------------------------------------------------------- */

let _autosaveInterval = null;

function startAutosave() {
  if (_autosaveInterval) return;
  _autosaveInterval = setInterval(() => writeDB(_dbCache).catch(() => {}), AUTOSAVE_MS);
}

function stopAutosave() {
  if (_autosaveInterval) clearInterval(_autosaveInterval);
  _autosaveInterval = null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

module.exports = {
  // lifecycle
  init,
  startAutosave,
  stopAutosave,

  // event bus
  bus: Bus,
  on: (...args) => Bus.on(...args),
  off: (...args) => Bus.off(...args),
  once: (...args) => Bus.once(...args),

  // sessions
  createSession,
  patchSession,
  getSession,
  listSessions,
  addNote,
  startStep,
  completeStep,
  setStepStatus,
  cancelSession,
  finishSession,

  // timers
  startTimer: startTimerPublic,
  pauseTimer: pause,
  resumeTimer: resume,
  cancelTimer: cancel,

  // integrations
  printLabelsForItems,
  emitInventoryDelta,
  triggerAutomation,
};
