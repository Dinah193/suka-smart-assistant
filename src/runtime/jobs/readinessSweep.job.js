// C:\Users\larho\suka-smart-assistant\src\runtime\jobs\readinessSweep.job.js
// SSA Runtime - Job: Readiness Sweep (runs at each T-x mark)
// -----------------------------------------------------------------------------
// Role in pipeline:
//   imports -> intelligence -> automation -> (optional) hub export
//   - Scans upcoming sessions inside a horizon and evaluates readiness at
//     thresholds (T-240, T-120, T-60, T-30, T-10 by default).
//   - Checks inventory availability, equipment, dependencies, constraints,
//     and environment notes (where available).
//   - Emits readiness events and can create prep tasks or reservations.
//   - If it mutates household data (creating prep tasks or reservations),
//     it also exports the change to the Hub when familyFundMode is enabled.
//
// Events emitted (all payloads use { type, ts, source, data }):
//   - planning.readiness.sweep.started
//   - planning.readiness.mark.checked
//   - planning.readiness.blocker.detected
//   - planning.readiness.prep.queued
//   - planning.readiness.ok
//   - planning.readiness.sweep.completed
//
// Defensive design:
//   - All external deps optional and guarded.
//   - Input validation with early returns.
//   - No hard failure if a subsystem is missing; we degrade gracefully.

let eventBus = { emit: function () {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = eb && (eb.default || eb.eventBus || eb) || eventBus;
} catch (_) {}

let featureFlags = { familyFundMode: false };
try {
  const ff = require("@/config/featureFlags");
  featureFlags = ff && (ff.default || ff) || featureFlags;
} catch (_) {}

// Optional subsystems (defensive requires)
let SessionStore = null; // listUpcomingInWindow, queuePrepTask, placeReservation
try { SessionStore = require("@/engines/scheduling/SessionStore"); } catch (_) { try { SessionStore = require("@/engines/scheduling/sessionStore"); } catch (_) {} }

let Inventory = null; // checkAvailability(items[]), reserve(items[], opts)
try { Inventory = require("@/domain/inventory/InventoryService"); } catch (_) {}

let Storehouse = null; // hasEquipment(equipment[])
try { Storehouse = require("@/domain/storehouse/StorehouseService"); } catch (_) {}

let constraintsPolicy = null; // isAllowed(session, ctx) or filterSessions
try { constraintsPolicy = require("@/engines/scheduling/policies/constraints"); } catch (_) {}

let buffersPolicy = null; // getRecommendedBuffer(domain, kind)
try { buffersPolicy = require("@/engines/scheduling/policies/buffers"); } catch (_) {}

let HubPacketFormatter = null;
try { HubPacketFormatter = require("@/services/hub/HubPacketFormatter"); } catch (_) {}
let FamilyFundConnector = null;
try { FamilyFundConnector = require("@/services/hub/FamilyFundConnector"); } catch (_) {}

module.exports = {
  /**
   * Run a readiness sweep for sessions starting within the horizon.
   * @param {Object} args
   * @param {number} [args.scanWindowMinutes=360]   horizon minutes ahead to scan
   * @param {number[]} [args.marksMinutes=[240,120,60,30,10]]  T-x thresholds
   * @param {boolean} [args.autoQueuePrep=true]     create lightweight prep tasks
   * @param {boolean} [args.autoReserveInventory=true]  soft-reserve inventory when tight
   * @param {string} [args.timezone="America/Chicago"]
   * @returns {Promise<{ok:boolean, inspected:number, blockers:number, prepsQueued:number, reservations:number}>}
   */
  async run(args) {
    const cfg = normalizeArgs(args);
    if (!cfg) {
      emit("planning.readiness.sweep.completed", { ok: false, reason: "invalid-args" });
      return { ok: false, inspected: 0, blockers: 0, prepsQueued: 0, reservations: 0 };
    }

    const now = new Date();
    const windowStart = now;
    const windowEnd = new Date(now.getTime() + cfg.scanWindowMinutes * 60000);

    const store = resolveSessionStore();
    if (!store || typeof store.listUpcomingInWindow !== "function") {
      emit("planning.readiness.sweep.completed", { ok: false, reason: "missing-session-store" });
      return { ok: false, inspected: 0, blockers: 0, prepsQueued: 0, reservations: 0 };
    }

    emit("planning.readiness.sweep.started", {
      windowStartISO: windowStart.toISOString(),
      windowEndISO: windowEnd.toISOString(),
      marksMinutes: cfg.marksMinutes
    });

    const upcoming = await safeCall(store.listUpcomingInWindow, store, windowStart, windowEnd);
    const sessions = Array.isArray(upcoming) ? upcoming : [];

    let inspected = 0;
    let blockers = 0;
    let prepsQueued = 0;
    let reservations = 0;

    // Iterate sessions and evaluate readiness at current T-x
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const startT = toTime(s.plannedStartISO || s.suggestedStartISO || s.deadlineISO);
      if (!isFinite(startT)) continue;

      inspected++;

      const minsToStart = Math.max(0, Math.round((startT - now.getTime()) / 60000));
      const nextMark = lowestMarkAtOrAbove(minsToStart, cfg.marksMinutes);
      if (nextMark == null) continue; // not at a mark window

      const ctx = {
        nowISO: now.toISOString(),
        windowStartISO: windowStart.toISOString(),
        windowEndISO: windowEnd.toISOString(),
        minsToStart: minsToStart,
        markMinutes: nextMark,
        timezone: cfg.timezone
      };

      emit("planning.readiness.mark.checked", {
        sessionId: s.id || s.sessionId,
        markMinutes: nextMark,
        minsToStart: minsToStart
      });

      // 1) Constraint sanity (e.g., quiet hours flips, sabbath)
      const constraintOk = await isAllowedByConstraints(s, ctx);
      if (!constraintOk) {
        blockers++;
        emit("planning.readiness.blocker.detected", {
          sessionId: s.id || s.sessionId,
          kind: "constraints",
          detail: "disallowed-by-constraints"
        });
        // Do not attempt other checks; session should be rescheduled by scheduler
        continue;
      }

      // 2) Equipment readiness
      const equipmentOk = await hasEquipment(s);
      if (!equipmentOk) {
        blockers++;
        const queued = await maybeQueuePrep(store, s, "equipment", cfg.autoQueuePrep, {
          title: "Locate required equipment",
          description: buildEquipPrepDescription(s),
          dueISO: minusMinutesISO(s.plannedStartISO, Math.min(30, nextMark))
        });
        prepsQueued += queued ? 1 : 0;
        emitReadyOrBlock(equipmentOk, s, "equipment", queued);
        continue;
      }

      // 3) Inventory readiness
      const invCheck = await checkInventory(s);
      if (!invCheck.ok) {
        blockers++;
        // Optionally queue a prep shopping task
        const queued = await maybeQueuePrep(store, s, "inventory", cfg.autoQueuePrep, {
          title: "Pick up missing items",
          description: buildInventoryPrepDescription(invCheck),
          dueISO: minusMinutesISO(s.plannedStartISO, Math.min(120, Math.max(30, nextMark)))
        });
        prepsQueued += queued ? 1 : 0;
        emitReadyOrBlock(false, s, "inventory", queued);
        continue;
      } else if (cfg.autoReserveInventory && invCheck.tight && Inventory && typeof Inventory.reserve === "function") {
        // Soft-reserve to avoid race if close to start
        try {
          const res = await Inventory.reserve(invCheck.itemsNeeded || [], {
            sessionId: s.id || s.sessionId,
            soft: true,
            expiresAtISO: minusMinutesISO(s.plannedStartISO, 5) // release close to start if unconsumed
          });
          if (res) reservations++;
        } catch (_) {}
      }

      // 4) Time buffer readiness (ensure pad is respected)
      const timeOk = await hasBuffer(s, ctx);
      if (!timeOk) {
        blockers++;
        const queued = await maybeQueuePrep(store, s, "time", cfg.autoQueuePrep, {
          title: "Clear time buffer",
          description: "Free up buffer before the session to avoid rushing.",
          dueISO: minusMinutesISO(s.plannedStartISO, Math.min(30, nextMark))
        });
        prepsQueued += queued ? 1 : 0;
        emitReadyOrBlock(false, s, "time", queued);
        continue;
      }

      // 5) Dependencies readiness (previous tasks done?)
      const depsOk = await depsSatisfied(s, store);
      if (!depsOk) {
        blockers++;
        const queued = await maybeQueuePrep(store, s, "dependency", cfg.autoQueuePrep, {
          title: "Complete prerequisites",
          description: "Finish required prerequisite task(s) before session start.",
          dueISO: minusMinutesISO(s.plannedStartISO, Math.min(60, nextMark))
        });
        prepsQueued += queued ? 1 : 0;
        emitReadyOrBlock(false, s, "dependency", queued);
        continue;
      }

      // All checks passed at this mark
      emit("planning.readiness.ok", {
        sessionId: s.id || s.sessionId,
        markMinutes: nextMark
      });
    }

    const summary = {
      inspected: inspected,
      blockers: blockers,
      prepsQueued: prepsQueued,
      reservations: reservations,
      windowStartISO: windowStart.toISOString(),
      windowEndISO: windowEnd.toISOString()
    };

    emit("planning.readiness.sweep.completed", { ok: true, summary: summary });

    // If we actually queued prep tasks or made reservations, that changed data.
    if (prepsQueued > 0 || reservations > 0) {
      await exportToHubIfEnabled({
        type: "planning.readiness.sweep.completed",
        ts: new Date().toISOString(),
        source: "runtime.jobs.readinessSweep",
        data: summary
      });
    }

    return { ok: true, inspected: inspected, blockers: blockers, prepsQueued: prepsQueued, reservations: reservations };
  }
};

// ------------------------------ checks and helpers ------------------------------

function normalizeArgs(args) {
  const scanWindowMinutes = Number((args && args.scanWindowMinutes) != null ? args.scanWindowMinutes : 360);
  let marks = Array.isArray(args && args.marksMinutes) ? args.marksMinutes.slice() : [240, 120, 60, 30, 10];
  marks = marks.filter(function (n) { return isFinite(n) && n > 0; }).sort(function (a, b) { return b - a; }); // desc for T-x logic
  const autoQueuePrep = !!((args && args.autoQueuePrep) != null ? args.autoQueuePrep : true);
  const autoReserveInventory = !!((args && args.autoReserveInventory) != null ? args.autoReserveInventory : true);
  const timezone = (args && args.timezone) || "America/Chicago";
  if (!isFinite(scanWindowMinutes) || scanWindowMinutes <= 0) return null;
  if (!marks.length) return null;
  return { scanWindowMinutes: scanWindowMinutes, marksMinutes: marks, autoQueuePrep: autoQueuePrep, autoReserveInventory: autoReserveInventory, timezone: timezone };
}

function resolveSessionStore() {
  if (!SessionStore) return null;
  if (typeof SessionStore.listUpcomingInWindow === "function") return SessionStore;
  if (SessionStore && typeof SessionStore.getInstance === "function") return SessionStore.getInstance();
  if (SessionStore && typeof SessionStore.default === "object") return SessionStore.default;
  return SessionStore;
}

function lowestMarkAtOrAbove(minsToStart, marksDesc) {
  // marksDesc is sorted desc. We want the highest mark that is <= minsToStart but not "farther than next lower check".
  // For simplicity, trigger when within +/- 2 minutes of a mark threshold.
  const tolerance = 2;
  for (let i = 0; i < marksDesc.length; i++) {
    const m = marksDesc[i];
    if (Math.abs(minsToStart - m) <= tolerance || minsToStart < m && (m - minsToStart) <= tolerance) {
      return m;
    }
  }
  return null;
}

async function isAllowedByConstraints(session, ctx) {
  if (!constraintsPolicy) return true;
  try {
    if (typeof constraintsPolicy.isAllowed === "function") {
      return !!(await constraintsPolicy.isAllowed(session, ctx));
    }
    if (typeof constraintsPolicy.filterSessions === "function") {
      const res = await constraintsPolicy.filterSessions([session], ctx);
      return Array.isArray(res) && res.length === 1;
    }
    return true;
  } catch (_) {
    return true;
  }
}

async function hasEquipment(session) {
  const equipment = session.equipment || [];
  if (!equipment.length) return true;
  if (!Storehouse || typeof Storehouse.hasEquipment !== "function") return true; // cannot validate, assume ok
  try {
    return !!(await Storehouse.hasEquipment(equipment));
  } catch (_) {
    return true;
  }
}

async function checkInventory(session) {
  const items = extractInventoryItems(session);
  if (!items.length) return { ok: true, itemsNeeded: [], tight: false };
  if (!Inventory || typeof Inventory.checkAvailability !== "function") {
    // cannot validate, assume ok but not tight
    return { ok: true, itemsNeeded: [], tight: false };
  }
  try {
    const res = await Inventory.checkAvailability(items);
    // expected shape: { ok:boolean, missing:[{sku,qty}], low:[{sku,qty}] }
    const ok = !!res && !!res.ok && (!res.missing || res.missing.length === 0);
    const tight = !!res && Array.isArray(res.low) && res.low.length > 0;
    const needed = Array.isArray(res.missing) ? res.missing : [];
    return { ok: ok, itemsNeeded: needed, tight: tight };
  } catch (_) {
    return { ok: true, itemsNeeded: [], tight: false };
  }
}

async function hasBuffer(session, ctx) {
  try {
    if (!buffersPolicy || typeof buffersPolicy.getRecommendedBuffer !== "function") return true;
    const rec = buffersPolicy.getRecommendedBuffer(session.domain || "general", session.meta && session.meta.kind);
    const beforeMs = Number((rec && rec.beforeMs) || 0);
    const afterMs = Number((rec && rec.afterMs) || 0);
    // If we are within T-x that is smaller than required pre-buffer, flag not ready
    return ctx.minsToStart * 60000 >= beforeMs;
  } catch (_) {
    return true;
  }
}

async function depsSatisfied(session, store) {
  try {
    const deps = Array.isArray(session.dependencies) ? session.dependencies : [];
    if (!deps.length) return true;
    if (!store || typeof store.areCompleted !== "function") return true; // cannot verify, assume ok
    return !!(await store.areCompleted(deps));
  } catch (_) {
    return true;
  }
}

async function maybeQueuePrep(store, session, kind, enabled, prep) {
  if (!enabled) return false;
  if (!store || typeof store.queuePrepTask !== "function") return false;
  try {
    const payload = {
      sessionId: session.id || session.sessionId,
      kind: kind,
      title: prep.title,
      description: prep.description,
      dueISO: prep.dueISO,
      priority: "high",
      soft: true
    };
    const ok = await store.queuePrepTask(payload);
    if (ok) {
      emit("planning.readiness.prep.queued", {
        sessionId: payload.sessionId,
        kind: kind,
        title: payload.title,
        dueISO: payload.dueISO
      });
    }
    return !!ok;
  } catch (_) {
    return false;
  }
}

function emitReadyOrBlock(ok, session, kind, queued) {
  if (ok) {
    emit("planning.readiness.ok", { sessionId: session.id || session.sessionId, kind: kind });
  } else {
    emit("planning.readiness.blocker.detected", {
      sessionId: session.id || session.sessionId,
      kind: kind,
      prepQueued: !!queued
    });
  }
}

function extractInventoryItems(session) {
  // Supports multiple domains. Expect recipe-like lines under session.ingredients or session.materials.
  const items = [];
  const list = Array.isArray(session.ingredients) ? session.ingredients : (Array.isArray(session.materials) ? session.materials : []);
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    // normalize { sku?, name, qty, unit }
    const sku = it.sku || it.code || null;
    const name = it.name || it.label || null;
    const qty = Number(it.qty || it.quantity || 0);
    const unit = it.unit || it.uom || null;
    if ((sku || name) && qty > 0) {
      items.push({ sku: sku, name: name, qty: qty, unit: unit });
    }
  }
  return items;
}

function buildInventoryPrepDescription(invCheck) {
  const names = (invCheck.itemsNeeded || []).map(function (m) { return (m.name || m.sku || "item") + " x" + (m.qty || "?"); });
  return names.length ? "Missing: " + names.join(", ") : "Missing inventory items.";
}

function buildEquipPrepDescription(session) {
  const eq = Array.isArray(session.equipment) ? session.equipment : [];
  return eq.length ? "Ensure available: " + eq.join(", ") : "Locate required equipment.";
}

function minusMinutesISO(iso, minutes) {
  const t = toTime(iso);
  if (!isFinite(t)) return null;
  return new Date(t - Math.max(0, minutes) * 60000).toISOString();
}

function toTime(isoOrDate) {
  if (!isoOrDate) return NaN;
  if (isoOrDate instanceof Date) return isoOrDate.getTime();
  const t = Date.parse(isoOrDate);
  return isNaN(t) ? NaN : t;
}

async function safeCall(fn, ctx) {
  const args = Array.prototype.slice.call(arguments, 2);
  if (typeof fn !== "function") return [];
  try {
    const res = await fn.apply(ctx, args);
    return Array.isArray(res) ? res : res || [];
  } catch (_) {
    return [];
  }
}

function emit(type, data) {
  try {
    eventBus.emit({ type: type, ts: new Date().toISOString(), source: "runtime.jobs.readinessSweep", data: data });
  } catch (_) {}
}

async function exportToHubIfEnabled(payload) {
  if (!featureFlags || !featureFlags.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = await (HubPacketFormatter.format ? HubPacketFormatter.format(payload) : payload);
    if (FamilyFundConnector && typeof FamilyFundConnector.send === "function") {
      await FamilyFundConnector.send(packet);
    }
  } catch (_) {
    // fail silently per requirement
  }
}
