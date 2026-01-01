// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\riskController\actions.js
/**
 * Scheduling Risk Controller — Actions (parallelize / trim / escalate)
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 *   imports → intelligence (estimators/calibration) → automation (plans/resources)
 *   → gatekeeper (checks/contingencies) → risk controller (ETA, actions)
 *   → (optional) hub export
 *
 * What this file does:
 *   - Defines three plan-shaping actions that can be triggered by risk controls:
 *       1) parallelize:   split a long window into N parallel sub-windows.
 *       2) trim:          shorten duration / remove optional phases.
 *       3) escalate:      raise priority / add person device / mark as urgent.
 *   - Applies actions to a persisted plan snapshot, re-allocates resources
 *     when needed, and emits structured events.
 *   - Optionally exports change sets to the Hub when familyFundMode is enabled.
 *
 * Events (payload shape: { type, ts, source, data }):
 *   - scheduling.risk.action.applied
 *   - scheduling.risk.action.error
 *
 * Plan mutations are household data → we export conditionally through Hub.
 */

"use strict";

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[riskActions:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/featureFlags.json");
} catch {}

/** Optional data gateway (Dexie/IndexedDB/etc.). Falls back to in-memory. */
let dataGateway = null;
try {
  dataGateway = require("@/services/dataGateway");
  dataGateway = dataGateway?.default || dataGateway;
} catch {}

let allocator = null;
try {
  allocator = require("../planner/resourceAllocator.js");
  allocator = allocator?.default || allocator;
} catch {}

/* ------------------------------ Local Fallbacks ----------------------------- */

const MEM_PLANS = new Map(); // planId -> snapshot (compilePlan)
const nowISO = () => new Date().toISOString();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";

/* -------------------------------- Utilities -------------------------------- */

function emit(type, source, data) {
  eventBus.emit({ type, ts: nowISO(), source, data });
}

const toMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const addMin = (ms, m) => (isNum(ms) && isNum(m) ? ms + Math.round(m * 60000) : null);
const toISO = (ms) => {
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
};

/** Optional hub export — silent failure by requirement. */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
    const FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
    const formatter = HubPacketFormatter?.default || HubPacketFormatter;
    const connector = FamilyFundConnector?.default || FamilyFundConnector;
    const packet = formatter.format("scheduling.risk.action", payload);
    await connector.send(packet);
  } catch {
    // swallow
  }
}

/* --------------------------------- Storage ---------------------------------- */

const store = {
  async getPlan(planId) {
    try {
      if (dataGateway?.kv?.get) {
        return (await dataGateway.kv.get("plans", planId)) || null;
      }
      return MEM_PLANS.get(planId) || null;
    } catch {
      return MEM_PLANS.get(planId) || null;
    }
  },
  async putPlan(planId, snapshot) {
    try {
      if (dataGateway?.kv?.set) {
        await dataGateway.kv.set("plans", planId, snapshot);
      } else {
        MEM_PLANS.set(planId, snapshot);
      }
    } catch (err) {
      console.warn("[riskActions.store.putPlan] fallback MEM", err);
      MEM_PLANS.set(planId, snapshot);
    }
  },
};

/* ------------------------------- Action Types ------------------------------- */
/**
 * Action input shapes:
 *
 * Parallelize:
 *  { type: "parallelize", targetId: string, value: {
 *      into?: number,                      // default 2
 *      minChunkMinutes?: number,           // default 10
 *      overlap?: boolean,                  // default true (parallel)
 *      spacingMin?: number,                // default 0 (between chunks if not parallel)
 *      duplicateRequirements?: boolean     // default true
 *  } }
 *
 * Trim:
 *  { type: "trim", targetId: string, value: {
 *      byPercent?: number,                 // 0..1 (e.g., 0.2 => cut 20%)
 *      floorMinutes?: number,              // minimum duration
 *      removeTags?: string[],              // if window.tags contains any, mark removedSubsteps
 *      softenQuality?: boolean             // annotate quality trade-off
 *  } }
 *
 * Escalate:
 *  { type: "escalate", targetId?: string, value: {
 *      priorityDelta?: number,             // +N
 *      addPersonRole?: string,             // e.g., "cook", "helper"
 *      addDeviceRole?: string,             // e.g., "oven"
 *      reason?: string,                    // human text
 *      allWindows?: boolean                // if true, apply to plan; else only targetId
 *  } }
 */

/* --------------------------------- Public API ------------------------------- */
/**
 * Apply a list of actions to a plan, re-allocate resources, and emit events.
 *
 * @param {Object} req
 *  - planId: string
 *  - actions: Array<Action>
 *  - resources?: Array<Resource> (catalog for reallocation)
 *  - export?: boolean
 *
 * @returns {Promise<{ planId, applied: Array, skipped: Array, snapshot?: object }>}
 */
async function applyActions(req = {}) {
  const source = "engines/scheduling/riskController/actions.applyActions";
  try {
    const planId = String(req.planId || "").trim();
    if (!planId) {
      emit("scheduling.risk.action.error", source, { message: "Missing planId" });
      return { planId: "", applied: [], skipped: [] };
    }
    const actions = Array.isArray(req.actions) ? req.actions : [];
    if (!actions.length) {
      return { planId, applied: [], skipped: [] };
    }

    const snap = await store.getPlan(planId);
    if (!snap || !Array.isArray(snap.windows)) {
      emit("scheduling.risk.action.error", source, { message: "Plan not found", planId });
      return { planId, applied: [], skipped: [] };
    }

    // Clone mutable structures
    const windows = snap.windows.map((w) => ({ ...w }));
    const byId = new Map(windows.map((w) => [w.id, w]));
    const applied = [];
    const skipped = [];

    for (const a of actions) {
      const t = String(a?.type || "").toLowerCase();
      try {
        switch (t) {
          case "parallelize": {
            const ok = await applyParallelize(windows, byId, a);
            ok ? applied.push(a) : skipped.push({ action: a, reason: "parallelize_failed" });
            break;
          }
          case "trim": {
            const ok = await applyTrim(windows, byId, a);
            ok ? applied.push(a) : skipped.push({ action: a, reason: "trim_failed" });
            break;
          }
          case "escalate": {
            const ok = await applyEscalate(windows, byId, a);
            ok ? applied.push(a) : skipped.push({ action: a, reason: "escalate_failed" });
            break;
          }
          default:
            skipped.push({ action: a, reason: "unknown_type" });
        }
      } catch (e) {
        skipped.push({ action: a, reason: String(e?.message || e) });
      }
    }

    // Re-allocate if there are material changes & allocator is available
    let reservations = snap.reservations || [];
    let conflicts = snap.conflicts || [];
    if (applied.length && allocator?.reserveResources && Array.isArray(req.resources) && req.resources.length) {
      try {
        if (allocator?.releaseReservations) {
          // Release all reservations for plan; re-allocate cleanly
          await allocator.releaseReservations({ planId, export: false });
        }
        const result = await allocator.reserveResources(windows, req.resources, {
          planId,
          strategy: "greedy",
          export: false,
          planMeta: snap.planMeta || {},
        });
        reservations = result.reservations || [];
        conflicts = result.conflicts || [];
      } catch (e) {
        // Allocation failure is non-fatal; caller can inspect conflicts
        conflicts = conflicts.concat([{ type: "internalError", message: "Allocator failed after actions" }]);
      }
    }

    // Persist updated plan snapshot
    const updated = {
      ...snap,
      windows,
      reservations,
      conflicts,
      ts: nowISO(),
    };
    await store.putPlan(planId, updated);

    const payload = { planId, appliedCount: applied.length, skipped, windows: leanWindows(windows), conflicts };
    emit("scheduling.risk.action.applied", source, payload);

    if (req.export === true && applied.length) {
      await exportToHubIfEnabled({ action: "risk.action.applied", ...payload });
    }

    return { planId, applied, skipped, snapshot: updated };
  } catch (err) {
    emit("scheduling.risk.action.error", "engines/scheduling/riskController/actions.applyActions", {
      message: String(err?.message || err),
    });
    return { planId: String(req?.planId || ""), applied: [], skipped: [] };
  }
}

/* ------------------------------- Implementations ---------------------------- */

/**
 * PARALLELIZE
 *  - Splits a window into N chunks.
 *  - If overlap=true, all chunks share same start and end (for parallel devices/people).
 *  - If overlap=false, chunks are laid back-to-back with optional spacing.
 */
async function applyParallelize(windows, byId, action) {
  const targetId = action?.targetId;
  const value = action?.value || {};
  const into = Math.max(2, Number(value.into) || 2);
  const minChunkMinutes = Math.max(1, Number(value.minChunkMinutes) || 10);
  const overlap = value.overlap !== false; // default true
  const spacing = Math.max(0, Number(value.spacingMin) || 0);
  const dupReq = value.duplicateRequirements !== false; // default true

  const w = byId.get(targetId);
  if (!w) return false;

  const s = toMs(w.startISO);
  const e = toMs(w.endISO);
  if (s == null || e == null) return false;
  const total = Math.max(1, Math.round((e - s) / 60000));
  const chunk = Math.max(minChunkMinutes, Math.round((total - (overlap ? 0 : spacing * (into - 1))) / (overlap ? 1 : into)));

  // Remove original
  const idx = windows.findIndex((x) => x.id === w.id);
  if (idx >= 0) windows.splice(idx, 1);

  for (let i = 0; i < into; i++) {
    const startMs = overlap ? s : addMin(s, i * (chunk + spacing));
    const endMs = overlap ? addMin(s, chunk) : addMin(startMs, chunk);
    windows.push({
      id: `${w.id}::p${i + 1}`,
      title: `${w.title || w.id} — parallel ${i + 1}/${into}`,
      domain: w.domain || "generic",
      startISO: toISO(startMs),
      endISO: toISO(endMs),
      priority: (isNum(w.priority) ? w.priority : 0) + 1, // slight bump—parallel work often urgent
      requirements: dupReq ? safeCloneArray(w.requirements) : [],
      tags: mergeTags(w.tags, ["parallel"]),
      variant: { ...(w.variant || {}), parallelized: true, into },
    });
  }
  return true;
}

/**
 * TRIM
 *  - Reduce duration and mark simplified flags & removed sub-steps for transparency.
 */
async function applyTrim(windows, byId, action) {
  const w = byId.get(action?.targetId);
  if (!w) return false;
  const value = action?.value || {};
  const pct = Math.max(0, Math.min(0.9, Number(value.byPercent) || 0.2)); // cap at 90% cut
  const floor = Math.max(1, Number(value.floorMinutes) || 5);
  const removeTags = Array.isArray(value.removeTags) ? value.removeTags.map(String) : [];
  const softenQuality = !!value.softenQuality;

  const s = toMs(w.startISO), e = toMs(w.endISO);
  if (s == null || e == null) return false;
  const dur = Math.max(1, Math.round((e - s) / 60000));
  const newDur = Math.max(floor, Math.round(dur * (1 - pct)));

  w.endISO = toISO(addMin(s, newDur));
  w.variant = { ...(w.variant || {}), trimmed: true, byPercent: pct };
  w.removedSubsteps = removeTags;
  w.qualityNote = softenQuality ? "trimmed_for_time" : (w.qualityNote || undefined);
  w.tags = mergeTags(w.tags, ["trimmed"]);
  return true;
}

/**
 * ESCALATE
 *  - Raise priority and/or add temp resource requirements (person/device).
 *  - Can apply to the whole plan (allWindows=true) or a single window.
 */
async function applyEscalate(windows, byId, action) {
  const value = action?.value || {};
  const applyAll = !!value.allWindows;
  const targets = applyAll
    ? windows
    : (action?.targetId ? [byId.get(action.targetId)].filter(Boolean) : []);

  if (!targets.length) return false;

  const delta = Number(value.priorityDelta) || 1;
  const addPersonRole = isStr(value.addPersonRole) ? value.addPersonRole : null;
  const addDeviceRole = isStr(value.addDeviceRole) ? value.addDeviceRole : null;

  for (const w of targets) {
    const pr = isNum(w.priority) ? w.priority : 0;
    w.priority = pr + delta;
    w.tags = mergeTags(w.tags, ["escalated"]);

    // Add temporary requirement(s)
    const reqs = Array.isArray(w.requirements) ? w.requirements.slice() : [];
    if (addPersonRole) {
      reqs.push({ type: "person", role: addPersonRole, quantity: 1, optional: true });
    }
    if (addDeviceRole) {
      reqs.push({ type: "device", role: addDeviceRole, quantity: 1, optional: true });
    }
    if (reqs.length) w.requirements = reqs;

    // Annotate meta
    w.meta = { ...(w.meta || {}), escalationReason: value.reason || "urgent" };
  }
  return true;
}

/* --------------------------------- Helpers ---------------------------------- */

function mergeTags(tags, extra) {
  const set = new Set([...(Array.isArray(tags) ? tags : []), ...(extra || [])].map(String));
  return Array.from(set);
}
function safeCloneArray(a) {
  return Array.isArray(a) ? a.map((x) => (x && typeof x === "object" ? { ...x } : x)) : [];
}
function leanWindows(list) {
  return (list || []).map((w) => ({
    id: w.id, title: w.title, domain: w.domain, startISO: w.startISO, endISO: w.endISO, priority: w.priority,
    tags: w.tags, variant: w.variant,
  }));
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  applyActions,
  // direct exports in case callers want granular control
  _internals: {
    applyParallelize,
    applyTrim,
    applyEscalate,
  },
};
