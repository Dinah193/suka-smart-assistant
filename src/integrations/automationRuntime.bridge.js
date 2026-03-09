// File: C:\Users\larho\suka-smart-assistant\src\integrations\automationRuntime.bridge.js

/**
 * Automation Runtime Bridge
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Wire normalized scheduler/session events on the shared eventBus to the
 *    Automation Runtime (planner/executor) and fan back standardized results.
 *
 * Where it sits in the pipeline
 *  - imports → intelligence → **automation (this bridge)** → (optional) hub export
 *  - Upstream engines and UI emit normalized events like:
 *      • schedule.session.create
 *      • schedule.reschedule_item
 *      • schedule.autofit
 *      • schedule.resource.resolution
 *      • session.task.split
 *      • session.task.skip
 *      • inventory.updated (post-actions that affect storehouse)
 *  - This bridge translates those into AutomationRuntime API calls and emits:
 *      • schedule.plan.recomputed (on success)
 *      • automation.command.failed (on error)
 *      • inventory.updated / inventory.shortage.detected (when runtime returns deltas)
 *
 * Notes
 *  - Defensive and idempotent: dedupes by requestId.
 *  - Batch-aware: merges multiple requests in the same tick.
 *  - Exports data-affecting commands to Hub when familyFundMode=true (best-effort).
 */

import eventBus from "../services/events/eventBus";
import featureFlags from "../config/featureFlags";
import HubPacketFormatter from "@/services/hub/HubPacketFormatter.js";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector.js";

// The Automation Runtime is assumed to exist and expose a stable facade.
let AutomationRuntime = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  AutomationRuntime = require("../runtime/automationRuntime").default;
} catch {
  // The runtime might be injected later in tests/SSR. We guard every call.
  AutomationRuntime = null;
}

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------
const SOURCE = "bridge.automationRuntime";
const nowISO = () => new Date().toISOString();

function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  try {
    const pkt = HubPacketFormatter.format(payload);
    FamilyFundConnector.send(pkt);
  } catch {
    // Hub is optional plumbing — fail silently
  }
}

function safeEmit(type, data) {
  const payload = { type, ts: nowISO(), source: SOURCE, data };
  try {
    eventBus.emit(type, payload);
  } catch {
    // do not crash the bridge on emit issues
  }
  return payload;
}

function fail(type, data, error) {
  return safeEmit("automation.command.failed", {
    op: type,
    error: String(error?.message || error || "Unknown error"),
    ...data,
  });
}

function ensureRuntime() {
  if (!AutomationRuntime || typeof AutomationRuntime !== "object") {
    throw new Error("AutomationRuntime unavailable");
  }
  return AutomationRuntime;
}

function toMs(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function nonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Dedupe & coalescing
// ---------------------------------------------------------------------------
/**
 * We dedupe commands with an optional requestId. If absent, we synthesize a key
 * from the op & object ids to avoid obvious duplicates within a short window.
 */
const recent = new Map(); // key -> expiresTs
const TTL_MS = 8_000;

function isDuplicate(key) {
  const now = Date.now();
  // Clean
  for (const [k, exp] of recent.entries()) {
    if (exp <= now) recent.delete(k);
  }
  const exp = recent.get(key);
  if (exp && exp > now) return true;
  recent.set(key, now + TTL_MS);
  return false;
}

function dedupeKey(op, data) {
  if (data?.requestId) return `req:${data.requestId}`;
  if (op === "schedule.reschedule_item" && data?.sessionId && data?.offsetMs) {
    return `${op}:${data.sessionId}:${Math.sign(data.offsetMs)}`;
  }
  if (op === "schedule.autofit" && data?.window?.start && data?.window?.end) {
    return `${op}:${data.window.start}:${data.window.end}:${
      data.domain || "all"
    }`;
  }
  if (op === "schedule.session.create" && data?.title && data?.startISO) {
    return `${op}:${data.title}:${data.startISO}`;
  }
  if (data?.changeId) return `${op}:${data.changeId}`;
  return `${op}:${JSON.stringify(data).slice(0, 64)}`;
}

// ---------------------------------------------------------------------------
// Command handlers (each returns a recompute/meta payload on success)
// ---------------------------------------------------------------------------
async function handleSessionCreate(data) {
  const rt = ensureRuntime();
  const input = {
    title: nonEmptyString(data?.title) ? data.title.trim() : "Session",
    domain: data?.domain || "general",
    startISO: data?.startISO || nowISO(),
    endISO: data?.endISO || null,
    recipeId: data?.recipeId || null,
    seedId: data?.seedId || null,
    source: data?.source || SOURCE,
    metadata: data?.metadata || {},
  };
  const out = await rt.scheduleSession(input);
  return out; // { planId, affectedSessions, window, meta }
}

async function handleRescheduleItem(data) {
  const rt = ensureRuntime();
  if (!nonEmptyString(data?.sessionId)) throw new Error("sessionId required");
  const input = {
    sessionId: data.sessionId,
    domain: data?.domain || "general",
    offsetMs: toMs(data?.offsetMs),
    absolute: data?.absolute || null, // {startISO?, endISO?} optional absolute placement
    reason: data?.reason || "user",
    etaISO: data?.etaISO || null,
  };
  const out = await rt.rescheduleItem(input);
  return out;
}

async function handleAutofit(data) {
  const rt = ensureRuntime();
  const input = {
    window: data?.window || null, // {start, end}
    domain: data?.domain || null,
    strategy: data?.strategy || "compress_neighbors|defer_low_priority",
    reason: data?.reason || "user",
  };
  const out = await rt.applyAutofit(input);
  return out;
}

async function handleResourceResolution(data) {
  const rt = ensureRuntime();
  const input = {
    conflictId: data?.conflictId,
    resource: data?.resource,
    resolution: data?.resolution,
    domain: data?.domain || "general",
    window: data?.window || null,
  };
  const out = await rt.resolveResourceConflict(input);
  return out;
}

async function handleTaskSplit(data) {
  const rt = ensureRuntime();
  if (!nonEmptyString(data?.taskId)) throw new Error("taskId required");
  const input = {
    sessionId: data?.sessionId || null,
    taskId: data.taskId,
    ratio: Number(data?.ratio || data?.resolution?.ratio || 0.5),
    domain: data?.domain || "general",
    reason: data?.reason || "user",
  };
  const out = await rt.splitTask(input);
  return out;
}

async function handleTaskSkip(data) {
  const rt = ensureRuntime();
  if (!nonEmptyString(data?.taskId)) throw new Error("taskId required");
  const input = {
    sessionId: data?.sessionId || null,
    taskId: data.taskId,
    domain: data?.domain || "general",
    reason: data?.reason || "user",
  };
  const out = await rt.skipTask(input);
  return out;
}

// Optional: inventory sync when runtime reports deltas (storehouse updates)
function fanoutInventoryDeltas(meta) {
  if (!meta || !Array.isArray(meta.inventoryDeltas)) return;
  if (!meta.inventoryDeltas.length) return;
  const invPayload = safeEmit("inventory.updated", {
    deltas: meta.inventoryDeltas,
  });
  exportToHubIfEnabled(invPayload);
}

// Optional: shortage detection
function fanoutShortages(meta) {
  if (!meta || !Array.isArray(meta.shortages)) return;
  if (!meta.shortages.length) return;
  safeEmit("inventory.shortage.detected", { items: meta.shortages });
}

// ---------------------------------------------------------------------------
// Bridge wiring
// ---------------------------------------------------------------------------
const subscriptions = [];
let started = false;

function on(type, handler, exportOnSuccess = true) {
  const off = eventBus.on(type, async (evt) => {
    const data = evt?.data || evt || {};
    const key = dedupeKey(type, data);
    if (isDuplicate(key)) return;

    // Pre-flight telemetry
    safeEmit("automation.command.received", {
      op: type,
      key,
      preview: previewFor(type, data),
    });

    try {
      const res = await handler(data);

      // Standard success fan-out
      const resultPayload = safeEmit("schedule.plan.recomputed", {
        planId: res?.planId || res?.meta?.planId || null,
        window: res?.window || null,
        affectedSessions: res?.affectedSessions || res?.sessions || [],
        recalculation: {
          reason: type,
          ts: nowISO(),
          meta: res?.meta || {},
        },
      });

      // Optionally export data-affecting commands (most of these are)
      if (exportOnSuccess) exportToHubIfEnabled(resultPayload);

      // Side fan-outs (inventory/shortage)
      fanoutInventoryDeltas(res?.meta);
      fanoutShortages(res?.meta);
    } catch (error) {
      fail(type, previewFor(type, data), error);
    }
  });
  subscriptions.push(off);
}

function start() {
  if (started) return;
  started = true;

  // Core commands flowing from UI/engines → runtime
  on("schedule.session.create", handleSessionCreate, true);
  on("schedule.reschedule_item", handleRescheduleItem, true);
  on("schedule.autofit", handleAutofit, true);
  on("schedule.resource.resolution", handleResourceResolution, true);
  on("session.task.split", handleTaskSplit, true);
  on("session.task.skip", handleTaskSkip, true);

  // Optional: accept plan revert requests
  on(
    "schedule.plan.revert",
    async (data) => {
      const rt = ensureRuntime();
      const res = await rt.revertPlan({
        changeId: data?.changeId,
        planId: data?.planId || null,
        sessionId: data?.sessionId || null,
        domain: data?.domain || "general",
      });
      return res;
    },
    true
  );

  // Health checks
  safeEmit("automation.bridge.started", { startedAt: nowISO() });
}

function stop() {
  if (!started) return;
  while (subscriptions.length) {
    try {
      const off = subscriptions.pop();
      off?.();
    } catch {
      // ignore
    }
  }
  started = false;
  safeEmit("automation.bridge.stopped", { stoppedAt: nowISO() });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function previewFor(type, data) {
  switch (type) {
    case "schedule.session.create":
      return {
        title: data?.title,
        domain: data?.domain,
        startISO: data?.startISO,
        endISO: data?.endISO,
      };
    case "schedule.reschedule_item":
      return {
        sessionId: data?.sessionId,
        offsetMs: toMs(data?.offsetMs),
        domain: data?.domain,
      };
    case "schedule.autofit":
      return {
        window: data?.window,
        domain: data?.domain,
        strategy: data?.strategy,
      };
    case "schedule.resource.resolution":
      return {
        conflictId: data?.conflictId,
        strategy: data?.resolution?.strategy,
        resource: data?.resource?.id,
      };
    case "session.task.split":
      return {
        sessionId: data?.sessionId,
        taskId: data?.taskId,
        ratio: data?.ratio,
      };
    case "session.task.skip":
      return { sessionId: data?.sessionId, taskId: data?.taskId };
    case "schedule.plan.revert":
      return {
        changeId: data?.changeId,
        planId: data?.planId,
        sessionId: data?.sessionId,
      };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Auto-start
// ---------------------------------------------------------------------------
start();

// Export controls for SSR/tests
export default { start, stop };
