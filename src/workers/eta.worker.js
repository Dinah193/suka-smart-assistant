// File: C:\Users\larho\suka-smart-assistant\src\workers\eta.worker.js

/* eslint-disable no-restricted-globals */
/**
 * ETA Worker — minute-tick recomputation loop
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Maintain rolling ETAs for in-flight sessions/tasks across domains.
 *  - Listen to planner/runtime events (start/progress/overrun/recompute),
 *    keep a lightweight in-memory mirror, and on each minute boundary:
 *      • recompute per-session ETA & remaining time
 *      • emit `eta.updated` (per session) and `eta.batch.updated` (summary)
 *      • if ETA changes adjust planned end (optional), emit `schedule.reschedule_item`
 *        (this mutates household schedule → optionally export to Hub).
 *
 * Pipeline fit (imports → intelligence → automation → (optional) hub export)
 *  - Imports/engines create sessions & timers → runtime emits progress/overrun.
 *  - This worker (intelligence adjunct) calculates ETAs and feeds automation:
 *      • `eta.updated` -> UI badges, notifications
 *      • `schedule.reschedule_item` -> planner applies (optional Hub export)
 *
 * Forward-thinking / extensibility
 *  - Domain agnostic (cooking/cleaning/garden/animals/storehouse/preservation).
 *  - Plug-in model functions: `models[domain]` to customize ETA math per domain.
 *  - Defensive: tolerates missing fields & eventBus failures.
 */

import eventBus from "../services/events/eventBus";
import featureFlags from "../config/featureFlags";
import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

// ------------------------------
// Constants & helpers
// ------------------------------
const SOURCE = "worker.eta";
const MINUTE_MS = 60_000;
const SMALL_CHANGE_MS = 30_000; // don't spam if change is smaller than 30s

const now = () => Date.now();
const nowISO = () => new Date().toISOString();

function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    FamilyFundConnector.send(packet);
  } catch {
    // Hub is optional plumbing; fail silently
  }
}

function toMs(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ------------------------------
// Domain ETA models (extensible)
// ------------------------------
/**
 * Model signature:
 *   compute({ estimateMs, elapsedMs, overrunMs, bufferMs, tasks }) -> { remainingMs, confidence: 0..1 }
 * Default: proportional adjustment: remaining = max(0, estimate - elapsed) + overrun - buffer
 */
const models = {
  default(input) {
    const estimate = toMs(input.estimateMs);
    const elapsed = clamp(
      toMs(input.elapsedMs),
      0,
      estimate * 10 || 86_400_000
    );
    const overrun = Math.max(0, toMs(input.overrunMs));
    const buffer = Math.max(0, toMs(input.bufferMs));
    const baseRemaining = Math.max(0, estimate - elapsed);
    const remainingMs = Math.max(0, baseRemaining + overrun - buffer);
    // crude confidence: more task observations -> higher
    const taskCount = Array.isArray(input.tasks) ? input.tasks.length : 0;
    const confidence = clamp(0.4 + Math.min(0.5, taskCount * 0.05), 0, 0.95);
    return { remainingMs, confidence };
  },
  // Example: preservation domain tends to have cooling/resting buffers → keep buffer
  preservation(input) {
    const out = models.default(input);
    return {
      remainingMs: Math.round(out.remainingMs * 1.1),
      confidence: clamp(out.confidence - 0.05, 0, 1),
    };
  },
  // Example: animals/butchery may be labor-bound → scale by active_persons
  animals(input) {
    const out = models.default(input);
    const people = Math.max(1, Number(input.activePersons || 1));
    const factor = 1 / clamp(people, 1, 4); // more people -> faster
    return {
      remainingMs: Math.round(out.remainingMs * factor),
      confidence: out.confidence,
    };
  },
};

// ------------------------------
// Worker state
// ------------------------------
/**
 * sessions: Map<sessionId, SessionState>
 * SessionState:
 *  {
 *    sessionId, domain, title,
 *    startTs, plannedEndTs, estimateMs, bufferMs,
 *    elapsedMs, overrunMs, tasks: [{id, estimateMs, elapsedMs, status}],
 *    lastEtaMs, lastEmitTs
 *  }
 */
const sessions = new Map();
let tickTimer = null;
let running = false;

// ------------------------------
// Event intake / mutators
// ------------------------------
function onSessionStart(d) {
  const id = d?.sessionId || d?.id;
  if (!id) return;
  const startTs = d.startTs ? new Date(d.startTs).getTime() : now();
  const estimateMs = toMs(d.estimateMs, toMs(d.estimateMin, 0) * 60_000);
  const plannedEndTs = d.plannedEndTs
    ? new Date(d.plannedEndTs).getTime()
    : startTs + estimateMs;

  const prev = sessions.get(id) || {};
  sessions.set(id, {
    sessionId: id,
    domain: d.domain || prev.domain || "general",
    title: d.title || prev.title || "Session",
    startTs,
    plannedEndTs,
    estimateMs: estimateMs || prev.estimateMs || 0,
    bufferMs: toMs(d.bufferMs, prev.bufferMs || 0),
    elapsedMs: 0,
    overrunMs: 0,
    tasks: Array.isArray(d.tasks) ? normalizeTasks(d.tasks) : prev.tasks || [],
    lastEtaMs: prev.lastEtaMs,
    lastEmitTs: prev.lastEmitTs,
  });
}

function onProgress(d) {
  const id = d?.sessionId;
  if (!id || !sessions.has(id)) return;
  const s = sessions.get(id);
  const elapsedMs = toMs(d.totalElapsedMs, s.elapsedMs);
  const overrunMs = Math.max(0, toMs(d.overrunMs, s.overrunMs));
  const bufferMs = toMs(d.bufferMs, s.bufferMs);

  // Merge task progress if present
  let tasks = s.tasks;
  if (Array.isArray(d.tasks)) {
    const map = new Map(tasks.map((t) => [t.id, t]));
    for (const t of normalizeTasks(d.tasks)) {
      const prev = map.get(t.id) || {};
      map.set(t.id, { ...prev, ...t });
    }
    tasks = Array.from(map.values());
  }

  sessions.set(id, { ...s, elapsedMs, overrunMs, bufferMs, tasks });
}

function onOverrun(d) {
  const id = d?.sessionId;
  if (!id || !sessions.has(id)) return;
  const s = sessions.get(id);
  const overrun = Math.max(s.overrunMs || 0, toMs(d.deltaMs));
  sessions.set(id, { ...s, overrunMs: overrun });
}

function onSessionDone(d) {
  const id = d?.sessionId;
  if (!id) return;
  sessions.delete(id);
}

function onPlanRecomputed(e) {
  // If recompute provides updated plannedEndTs for sessions, merge them
  const arr = e?.affectedSessions || e?.sessions;
  if (!Array.isArray(arr)) return;
  for (const x of arr) {
    const id = x.sessionId || x.id;
    if (!id || !sessions.has(id)) continue;
    const s = sessions.get(id);
    const plannedEndTs = x.plannedEndTs
      ? new Date(x.plannedEndTs).getTime()
      : s.plannedEndTs;
    sessions.set(id, { ...s, plannedEndTs });
  }
}

// ------------------------------
// Tick loop
// ------------------------------
function start() {
  if (running) return;
  running = true;

  // Align to next minute boundary
  const delay = MINUTE_MS - (now() % MINUTE_MS);
  setTimeout(() => {
    if (!running) return;
    tick(); // immediate on boundary
    tickTimer = setInterval(tick, MINUTE_MS);
  }, delay);

  wireEvents();
}

function stop() {
  running = false;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  unwireEvents();
}

function tick() {
  const batch = [];
  const ts = now();

  for (const s of sessions.values()) {
    const model = models[s.domain] || models.default;

    const elapsedMs = Math.max(0, ts - (s.startTs || ts)) || s.elapsedMs || 0;
    const input = {
      estimateMs: s.estimateMs,
      elapsedMs,
      overrunMs: s.overrunMs,
      bufferMs: s.bufferMs,
      tasks: s.tasks,
      activePersons: s.activePersons,
    };

    const { remainingMs, confidence } = model(input);
    const etaMs = Math.max(0, remainingMs);
    const endTs = ts + etaMs;

    // Only emit if materially changed
    if (!s.lastEtaMs || Math.abs(etaMs - s.lastEtaMs) >= SMALL_CHANGE_MS) {
      const perPayload = {
        type: "eta.updated",
        ts: nowISO(),
        source: SOURCE,
        data: {
          sessionId: s.sessionId,
          domain: s.domain,
          title: s.title,
          remainingMs: etaMs,
          etaISO: new Date(endTs).toISOString(),
          confidence,
          cause: "minute_tick",
        },
      };
      safeEmit(perPayload);

      // Optional: if eta end deviates from planned end by > 5m, suggest reschedule
      const driftMs = s.plannedEndTs ? endTs - s.plannedEndTs : 0;
      if (Math.abs(driftMs) >= 5 * MINUTE_MS) {
        const resPayload = {
          type: "schedule.reschedule_item",
          ts: nowISO(),
          source: SOURCE,
          data: {
            sessionId: s.sessionId,
            domain: s.domain,
            offsetMs: driftMs,
            reason: "eta.drift",
            etaISO: new Date(endTs).toISOString(),
          },
        };
        // Emit as a *suggestion*; planners may accept or ignore
        safeEmit(resPayload);
        exportToHubIfEnabled(resPayload);
      }

      // Update mirror
      s.lastEtaMs = etaMs;
      s.lastEmitTs = ts;
      sessions.set(s.sessionId, s);
    }

    batch.push({
      sessionId: s.sessionId,
      domain: s.domain,
      remainingMs: s.lastEtaMs ?? etaMs,
      etaISO: new Date(endTs).toISOString(),
      confidence,
    });
  }

  // Batch summary event (for dashboard widgets)
  const batchPayload = {
    type: "eta.batch.updated",
    ts: nowISO(),
    source: SOURCE,
    data: {
      count: batch.length,
      window: { start: new Date(ts).toISOString(), horizonMin: 120 },
      items: batch,
    },
  };
  safeEmit(batchPayload);
}

// ------------------------------
// Event wiring
// ------------------------------
const offFns = [];

function wireEvents() {
  // Session lifecycle & progress
  offFns.push(
    eventBus.on("session.started", (e) => onSessionStart(e?.data || e)),
    eventBus.on("session.progress", (e) => onProgress(e?.data || e)),
    eventBus.on("session.task.progress", (e) => onProgress(e?.data || e)),
    eventBus.on("session.task.completed", (e) => onProgress(e?.data || e)),
    eventBus.on("session.completed", (e) => onSessionDone(e?.data || e)),
    eventBus.on("schedule.overrun.detected", (e) => onOverrun(e?.data || e)),
    eventBus.on("schedule.plan.recomputed", (e) =>
      onPlanRecomputed(e?.data || e)
    )
  );
}

function unwireEvents() {
  while (offFns.length) {
    const off = offFns.pop();
    try {
      off?.();
    } catch {
      // ignore
    }
  }
}

function safeEmit(payload) {
  try {
    eventBus.emit(payload.type, payload);
  } catch {
    // swallow: worker must be resilient
  }
  try {
    eventBus.emit("telemetry.debug", {
      type: "telemetry.debug",
      ts: nowISO(),
      source: SOURCE,
      data: { topic: "emit", eventType: payload.type },
    });
  } catch {
    // ignore
  }
}

// ------------------------------
// Utilities
// ------------------------------
function normalizeTasks(list) {
  return list.filter(Boolean).map((t) => ({
    id: t.id || t.taskId || String(Math.random()).slice(2),
    estimateMs: toMs(t.estimateMs, toMs(t.estimateMin, 0) * 60_000),
    elapsedMs: toMs(t.elapsedMs),
    status: t.status || "planned",
  }));
}

// ------------------------------
// Worker host interop (optional)
// ------------------------------
/**
 * If this file is executed inside a Web Worker, allow host to send control messages:
 *   postMessage({ cmd: 'start'|'stop'|'prime', sessions?: [...] })
 */
try {
  if (
    typeof self !== "undefined" &&
    typeof self.addEventListener === "function"
  ) {
    self.addEventListener("message", (ev) => {
      const msg = ev?.data || {};
      switch (msg.cmd) {
        case "start":
          start();
          break;
        case "stop":
          stop();
          break;
        case "prime":
          // Accept initial session mirror
          if (Array.isArray(msg.sessions)) {
            for (const s of msg.sessions) onSessionStart(s);
          }
          break;
        default:
          // Allow proxying events into the worker
          if (msg.type) {
            // mimic bus event
            eventBus.emit(msg.type, msg);
          }
      }
    });
  }
} catch {
  // ignore — not running in a worker host
}

// ------------------------------
// Auto-start when imported in app runtime
// ------------------------------
start();

// Named exports in case main thread needs manual control (SSR/testing)
export default { start, stop };
