// File: C:\Users\larho\suka-smart-assistant\src\integrations\hubExport.bridge.js

/**
 * Hub Export Bridge (optional)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Optionally export plan snapshots and execution actuals to the
 *    Suka Village Family Fund Hub (SVFFH) for household analytics.
 *
 * Where it sits in the pipeline
 *  - imports → intelligence → automation → **(optional) hub export (this bridge)**
 *  - Upstream subsystems emit normalized events on the eventBus:
 *      • schedule.plan.recomputed
 *      • session.run.logged / session.completed / meal.executed / garden.harvest.logged / preservation.completed
 *      • inventory.updated / inventory.shortage.detected
 *  - This bridge listens, shapes a Hub-friendly envelope, and pushes via
 *    HubPacketFormatter + FamilyFundConnector (best-effort, silent failure).
 *
 * Safety / Design
 *  - Fully optional: disabled unless featureFlags.familyFundMode === true.
 *  - Batches exports with dedupe + exponential backoff on transient failure.
 *  - Never blocks the app; failures are logged to `telemetry.debug` and an
 *    internal `hub.export.failed` event. Successes fan out `hub.export.sent`.
 */

import eventBus from "../services/events/eventBus";
import featureFlags from "../config/featureFlags";
import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------
const SOURCE = "bridge.hubExport";
const nowISO = () => new Date().toISOString();

const BATCH_INTERVAL_MS = 2_000; // flush cadence
const MAX_BATCH = 50; // flush early if exceeded
const MAX_BACKOFF_MS = 60_000;

function telemetry(topic, data) {
  try {
    eventBus.emit("telemetry.debug", {
      type: "telemetry.debug",
      ts: nowISO(),
      source: SOURCE,
      data: { topic, ...(data || {}) },
    });
  } catch {
    // ignore
  }
}

function safeEmit(type, data) {
  try {
    eventBus.emit(type, { type, ts: nowISO(), source: SOURCE, data });
  } catch {
    // never throw from the bridge
  }
}

function dedupeKey(item) {
  // Stable-ish keys so we don't flood Hub with identical exports
  const d = item?.data || {};
  switch (item.type) {
    case "hub.plan.snapshot":
      return `${item.type}:${d.planId || "unknown"}:${d.window?.start || ""}:${
        d.window?.end || ""
      }`;
    case "hub.actuals.session":
      return `${item.type}:${d.sessionId || ""}:${
        d.runId || d.completedAt || ""
      }`;
    case "hub.inventory.delta":
      return `${item.type}:${(d.deltas || [])
        .map((x) => `${x.itemId}:${x.qty}`)
        .slice(0, 8)
        .join("|")}`;
    case "hub.shortage.alert":
      return `${item.type}:${(d.items || [])
        .map((x) => x.itemId || x.sku || x.name)
        .slice(0, 8)
        .join("|")}`;
    default:
      return `${item.type}:${JSON.stringify(d).slice(0, 96)}`;
  }
}

// ---------------------------------------------------------------------------
// Queue & backoff
// ---------------------------------------------------------------------------
const queue = [];
const seen = new Map(); // key -> expiresTs
const TTL_MS = 5 * 60 * 1000; // 5 min dedupe TTL

let flushTimer = null;
let backoffMs = 0;
let started = false;

function enqueue(item) {
  // Deduplicate within a TTL window
  const key = dedupeKey(item);
  const now = Date.now();
  // Sweep expired
  for (const [k, exp] of seen.entries()) {
    if (exp <= now) seen.delete(k);
  }
  if (seen.has(key)) {
    telemetry("dedupe.skip", { key, type: item.type });
    return;
  }
  seen.set(key, now + TTL_MS);

  queue.push(item);
  if (queue.length >= MAX_BATCH) flushSoon(0);
}

function flushSoon(delay = BATCH_INTERVAL_MS) {
  if (!started) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, Math.max(0, delay));
}

async function flush() {
  if (!featureFlags?.familyFundMode) {
    // If FF is off, drop queue silently
    queue.length = 0;
    return;
  }
  if (!queue.length) {
    backoffMs = 0;
    return;
  }

  const batch = queue.splice(0, MAX_BATCH);
  const packets = [];
  try {
    for (const item of batch) {
      // HubPacketFormatter can accept our envelope and return a Hub-ready packet
      const pkt = HubPacketFormatter.format(item);
      packets.push(pkt);
    }
  } catch (e) {
    // Formatting failure — drop batch (don't retry malformed payloads)
    telemetry("format.error", { error: String(e?.message || e) });
    safeEmit("hub.export.failed", {
      reason: "format_error",
      size: batch.length,
    });
    backoffMs = 0;
    flushSoon(BATCH_INTERVAL_MS);
    return;
  }

  try {
    // FamilyFundConnector can accept array or singular; assume array is OK.
    await FamilyFundConnector.send(packets);
    safeEmit("hub.export.sent", { count: packets.length });
    telemetry("flush.ok", { count: packets.length });
    backoffMs = 0;
    // If more items queued during send, schedule next flush quickly
    if (queue.length) flushSoon(250);
  } catch (e) {
    // Transient send issue — push items back to the front and back off
    telemetry("flush.error", {
      error: String(e?.message || e),
      count: packets.length,
    });
    safeEmit("hub.export.failed", {
      reason: "send_error",
      error: String(e?.message || e),
    });
    queue.unshift(...batch); // restore
    backoffMs = backoffMs ? Math.min(MAX_BACKOFF_MS, backoffMs * 2) : 1_000;
    flushSoon(backoffMs);
  }
}

// ---------------------------------------------------------------------------
// Event transformers → Hub envelopes
// ---------------------------------------------------------------------------
/**
 * The Hub expects high-level "channels" (plan, actuals, inventory). We turn
 * our normalized SSA events into simple envelopes that HubPacketFormatter
 * understands — it will add household/account metadata as needed.
 */

function onPlanRecomputed(evt) {
  const d = evt?.data || evt || {};
  const item = {
    type: "hub.plan.snapshot",
    ts: evt?.ts || nowISO(),
    source: SOURCE,
    data: {
      planId: d.planId || d.meta?.planId || "unknown",
      window: d.window || null,
      modelVersion:
        d.recalculation?.meta?.modelVersion || d.meta?.modelVersion || null,
      reason: d.recalculation?.reason || "plan_recomputed",
      sessions: (d.affectedSessions || d.sessions || []).map((s) => ({
        sessionId: s.sessionId || s.id,
        title: s.title || s.label,
        domain: s.domain || "general",
        startISO: s.startISO || s.startTime || s.start,
        endISO: s.endISO || s.endTime || s.end,
        status: s.status || "planned",
      })),
    },
  };
  enqueue(item);
}

function onSessionRunLogged(evt) {
  const d = evt?.data || evt || {};
  const item = {
    type: "hub.actuals.session",
    ts: evt?.ts || nowISO(),
    source: SOURCE,
    data: {
      runId: d.runId || `${d.sessionId}:${evt?.ts || nowISO()}`,
      sessionId: d.sessionId,
      domain: d.domain || "general",
      startedAt: d.startedAt || d.ts || null,
      completedAt: d.completedAt || null,
      estimateMin: toNum(d.estimateMin),
      actualMin: toNum(d.actualMin),
      taskCount: toNum(d.taskCount),
      // Optional per-task stats if available
      tasks: Array.isArray(d.tasks)
        ? d.tasks.map((t) => ({
            taskId: t.taskId || t.id,
            label: t.label || t.name,
            estimateMin: toNum(t.estimateMin),
            actualMin: toNum(t.actualMin),
            status: t.status || "done",
          }))
        : [],
    },
  };
  enqueue(item);
}

function onSessionCompleted(evt) {
  const d = evt?.data || evt || {};
  const item = {
    type: "hub.actuals.session",
    ts: evt?.ts || nowISO(),
    source: SOURCE,
    data: {
      runId: d.runId || `${d.sessionId}:${evt?.ts || nowISO()}`,
      sessionId: d.sessionId,
      domain: d.domain || "general",
      startedAt: d.startedAt || null,
      completedAt: d.completedAt || evt?.ts || nowISO(),
      estimateMin: toNum(d.estimateMin),
      actualMin: toNum(d.actualMin),
      taskCount: toNum(d.taskCount),
    },
  };
  enqueue(item);
}

function onDomainCompletion(evt, domainKey) {
  const d = evt?.data || evt || {};
  const item = {
    type: "hub.actuals.session",
    ts: evt?.ts || nowISO(),
    source: SOURCE,
    data: {
      runId: d.runId || `${domainKey}:${evt?.ts || nowISO()}`,
      sessionId: d.sessionId || null,
      domain: domainKey,
      startedAt: d.startedAt || null,
      completedAt: d.completedAt || evt?.ts || nowISO(),
      estimateMin: toNum(d.estimateMin),
      actualMin: toNum(d.actualMin),
      taskCount: toNum(d.taskCount),
    },
  };
  enqueue(item);
}

function onInventoryUpdated(evt) {
  const d = evt?.data || evt || {};
  const deltas = Array.isArray(d.deltas) ? d.deltas : [];
  if (!deltas.length) return;
  const item = {
    type: "hub.inventory.delta",
    ts: evt?.ts || nowISO(),
    source: SOURCE,
    data: {
      deltas: deltas.map((x) => ({
        itemId: x.itemId || x.sku || x.name,
        name: x.name,
        qty: toNum(x.qty),
        unit: x.unit || x.uom || null,
        location: x.location || null,
        reason: x.reason || d.reason || null,
      })),
    },
  };
  enqueue(item);
}

function onShortage(evt) {
  const d = evt?.data || evt || {};
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) return;
  const item = {
    type: "hub.shortage.alert",
    ts: evt?.ts || nowISO(),
    source: SOURCE,
    data: {
      items: items.map((x) => ({
        itemId: x.itemId || x.sku || x.name,
        name: x.name || null,
        neededQty: toNum(x.neededQty),
        unit: x.unit || x.uom || null,
      })),
      detectedAt: evt?.ts || nowISO(),
    },
  };
  enqueue(item);
}

// Tiny numeric sanitizer
function toNum(n, f = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : f;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
const subscriptions = [];

function wire() {
  // Plan snapshots (recomputed after user/runtime changes)
  subscriptions.push(eventBus.on("schedule.plan.recomputed", onPlanRecomputed));

  // Actuals across domains
  subscriptions.push(eventBus.on("session.run.logged", onSessionRunLogged));
  subscriptions.push(eventBus.on("session.completed", onSessionCompleted));
  subscriptions.push(
    eventBus.on("meal.executed", (e) => onDomainCompletion(e, "cooking"))
  );
  subscriptions.push(
    eventBus.on("garden.harvest.logged", (e) => onDomainCompletion(e, "garden"))
  );
  subscriptions.push(
    eventBus.on("preservation.completed", (e) =>
      onDomainCompletion(e, "preservation")
    )
  );

  // Storehouse deltas
  subscriptions.push(eventBus.on("inventory.updated", onInventoryUpdated));
  subscriptions.push(eventBus.on("inventory.shortage.detected", onShortage));

  // Flush loop
  flushSoon(0);
}

function unwire() {
  while (subscriptions.length) {
    try {
      const off = subscriptions.pop();
      off?.();
    } catch {
      // ignore
    }
  }
  clearTimeout(flushTimer);
}

// ---------------------------------------------------------------------------
// Public controls
// ---------------------------------------------------------------------------
export function start() {
  if (started) return;
  started = true;
  telemetry("start", { enabled: !!featureFlags?.familyFundMode });
  wire();
}

export function stop() {
  if (!started) return;
  started = false;
  unwire();
  telemetry("stop", {});
}

// Auto-start if imported (no-op if feature flag is off)
start();

export default { start, stop };
