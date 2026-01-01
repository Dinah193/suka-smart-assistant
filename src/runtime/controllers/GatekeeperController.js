// C:\Users\larho\suka-smart-assistant\src\runtime\controllers\GatekeeperController.js
// SSA Runtime — Gatekeeper Controller
// -----------------------------------------------------------------------------
// Role in pipeline:
//   imports → intelligence → automation → (optional) hub export
//   - Centralizes readiness checks and contingency actions across domains.
//   - Orchestrates sweeps (T-x marks), auto-fixes common blockers (inventory
//     substitutions, equipment alternatives), reschedules when needed, and
//     escalates notifications to humans when automation cannot proceed.
//   - Emits normalized events to the shared event bus.
//   - Exports deltas to the Family Fund Hub when featureFlags.familyFundMode is on.
//
// Exposed operations:
//   - sweep(args?)                  → run readiness sweep (delegates to job)
//   - resolveBlockers(args)         → attempt automatic fixes for a session/list
//   - contingencyPlanForWindow(args)→ dry-run: produce contingency suggestions
//   - rescheduleOnBlocker(args)     → move a session within its feasible window
//   - escalate(args)                → send human notifications for unresolved blockers
//
// Events (payload shape { type, ts, source, data }):
//   - gatekeeper.sweep.*
//   - gatekeeper.resolve.*
//   - gatekeeper.plan.*
//   - gatekeeper.reschedule.*
//   - gatekeeper.escalate.*
//
// Notes:
//   - This file is “controller-level glue” tying together readiness, options,
//     feasibility, inventory/storehouse, and notification handlers.
//   - Every mutation that changes household data will also attempt Hub export.
//
// -----------------------------------------------------------------------------

const path = require("path");

// ---------- defensive service loading ----------
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

let HubPacketFormatter = null;
try { HubPacketFormatter = require("@/services/hub/HubPacketFormatter"); } catch (_) {}
let FamilyFundConnector = null;
try { FamilyFundConnector = require("@/services/hub/FamilyFundConnector"); } catch (_) {}

// Engines/Jobs (defensive)
const readinessSweepJob = requireSafe("@/runtime/jobs/readinessSweep.job.js");   // .run(args)
const optionsEngine = requireSafe("@/engines/scheduling/admission/options.js");  // suggestAlternates, simplifyVariant?, suggestGaps?
const feasibility = requireSafe("@/engines/scheduling/admission/feasibility.js"); // canMeetDeadline({session,...})
const prioritiesPolicy = requireSafe("@/engines/scheduling/policies/priorities.js"); // (optional) scoreSessions
const constraintsPolicy = requireSafe("@/engines/scheduling/policies/constraints.js");
const buffersPolicy = requireSafe("@/engines/scheduling/policies/buffers.js");

// Domain services (defensive)
const Inventory = requireSafe("@/domain/inventory/InventoryService.js"); // checkAvailability, proposeSubstitutions, reserve
const Storehouse = requireSafe("@/domain/storehouse/StorehouseService.js"); // hasEquipment, altEquipment
const SessionStore = requireSafe("@/engines/scheduling/SessionStore.js") || requireSafe("@/engines/scheduling/sessionStore.js"); // CRUD on sessions
const Notifier = requireSafe("@/runtime/jobs/handlers/notify.js"); // send({channel, title, body, urgency})
const Rescheduler = requireSafe("@/runtime/jobs/handlers/rescheduler.js"); // move({id,startISO,endISO,reason})

// ---------- public API ----------
module.exports = {
  /**
   * Run a readiness sweep (delegates to job).
   * @param {Object} args { scanWindowMinutes, marksMinutes, autoQueuePrep, autoReserveInventory, timezone }
   */
  async sweep(args) {
    emit("gatekeeper.sweep.started", sanitizeArgs(args));
    ensureJob("readinessSweep", readinessSweepJob, "run");
    try {
      const res = await readinessSweepJob.run(args || {});
      emit("gatekeeper.sweep.completed", { ok: !!(res && res.ok), meta: shrink(res) });

      // If mutations occurred, mirror a tiny delta as a backup export
      const changed = res && res.ok && ((res.prepsQueued || 0) > 0 || (res.reservations || 0) > 0);
      if (changed) {
        await exportToHubIfEnabled({
          type: "gatekeeper.sweep.delta",
          ts: new Date().toISOString(),
          source: "runtime.controllers.GatekeeperController",
          data: { prepsQueued: res.prepsQueued || 0, reservations: res.reservations || 0 }
        });
      }
      return res || { ok: false };
    } catch (err) {
      emit("gatekeeper.sweep.failed", { error: msg(err) });
      return { ok: false, error: msg(err) };
    }
  },

  /**
   * Try to resolve blockers automatically for one or many sessions.
   * @param {Object} args
   * @param {string|string[]} args.sessionIds
   * @param {boolean} [args.allowSubstitutions=true]
   * @param {boolean} [args.allowAltEquipment=true]
   * @param {boolean} [args.allowSoftReserve=true]
   * @param {boolean} [args.allowSimplifyVariant=true]  // e.g., shorter prep variant
   * @param {boolean} [args.allowMoveWithinWindow=true] // adjust start by small delta
   * @param {string}  [args.timezone="America/Chicago"]
   */
  async resolveBlockers(args) {
    const cfg = normalizeResolveArgs(args);
    if (!cfg) {
      emit("gatekeeper.resolve.skipped", { reason: "invalid-args" });
      return { ok: false, resolved: 0, mutated: 0, details: [] };
    }
    if (!SessionStore || typeof SessionStore.getByIds !== "function") {
      emit("gatekeeper.resolve.skipped", { reason: "missing-session-store" });
      return { ok: false, resolved: 0, mutated: 0, details: [] };
    }

    emit("gatekeeper.resolve.started", { sessionIds: cfg.sessionIds });

    // Load sessions
    let sessions = [];
    try { sessions = await SessionStore.getByIds(cfg.sessionIds); } catch (_) {}
    sessions = Array.isArray(sessions) ? sessions : [];

    const results = [];
    let resolved = 0;
    let mutated = 0;

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const r = await attemptResolve(s, cfg);
      results.push({ id: s.id || s.sessionId, ...r });
      if (r.ok) resolved++;
      if (r.mutated) mutated++;
    }

    emit("gatekeeper.resolve.completed", { resolved, mutated, count: sessions.length });

    if (mutated > 0) {
      await exportToHubIfEnabled({
        type: "gatekeeper.resolve.mutations",
        ts: new Date().toISOString(),
        source: "runtime.controllers.GatekeeperController",
        data: { mutated, resolved, items: compactResults(results) }
      });
    }

    return { ok: true, resolved, mutated, details: results };
  },

  /**
   * Dry-run: compute contingency options for sessions in a time window.
   * No mutations. Intended for UI previews and planner sidebars.
   * @param {Object} args { windowStartISO, windowEndISO, limit=20 }
   */
  async contingencyPlanForWindow(args) {
    const a = args || {};
    const win = normalizeWindow(a.windowStartISO, a.windowEndISO);
    if (!win) {
      emit("gatekeeper.plan.skipped", { reason: "invalid-window" });
      return { ok: false, options: [] };
    }
    if (!SessionStore || typeof SessionStore.listUpcomingInWindow !== "function") {
      emit("gatekeeper.plan.skipped", { reason: "missing-session-store" });
      return { ok: false, options: [] };
    }

    const limit = isFinite(a.limit) && a.limit > 0 ? Math.min(a.limit, 100) : 20;
    emit("gatekeeper.plan.started", { windowStartISO: win.startISO, windowEndISO: win.endISO, limit });

    let upcoming = [];
    try { upcoming = await SessionStore.listUpcomingInWindow(new Date(win.startISO), new Date(win.endISO)); } catch (_) {}
    upcoming = (Array.isArray(upcoming) ? upcoming : []).slice(0, limit);

    const out = [];
    for (let i = 0; i < upcoming.length; i++) {
      const s = upcoming[i];
      const o = await computeContingencies(s);
      out.push({ id: s.id || s.sessionId, title: s.title, domain: s.domain, ...o });
    }

    emit("gatekeeper.plan.completed", { count: out.length });
    return { ok: true, options: out };
  },

  /**
   * Attempt a minimal reschedule when a blocker is detected.
   * @param {Object} args { sessionId, earliestISO?, latestISO?, maxShiftMinutes=45, reason? }
   */
  async rescheduleOnBlocker(args) {
    const a = args || {};
    const id = a.sessionId;
    if (!id) {
      emit("gatekeeper.reschedule.skipped", { reason: "missing-sessionId" });
      return { ok: false };
    }
    if (!Rescheduler || typeof Rescheduler.move !== "function" || !SessionStore) {
      emit("gatekeeper.reschedule.skipped", { reason: "missing-rescheduler" });
      return { ok: false };
    }

    let s = null;
    try { s = await (SessionStore.getByIds ? SessionStore.getByIds([id]) : Promise.resolve([])); } catch (_) {}
    s = Array.isArray(s) && s.length ? s[0] : null;
    if (!s) {
      emit("gatekeeper.reschedule.skipped", { reason: "session-not-found", sessionId: id });
      return { ok: false };
    }

    const win = boundShiftWindow(s, a.earliestISO, a.latestISO, a.maxShiftMinutes);
    const attempt = await findFeasibleShift(s, win);
    if (!attempt) {
      emit("gatekeeper.reschedule.failed", { sessionId: id, reason: "no-feasible-slot" });
      return { ok: false, reason: "no-feasible-slot" };
    }

    try {
      const ok = await Rescheduler.move({
        id,
        startISO: attempt.startISO,
        endISO: attempt.endISO,
        reason: a.reason || "gatekeeper:auto-reschedule"
      });
      if (ok) {
        emit("gatekeeper.reschedule.moved", { sessionId: id, startISO: attempt.startISO, endISO: attempt.endISO });
        await exportToHubIfEnabled({
          type: "gatekeeper.reschedule.moved",
          ts: new Date().toISOString(),
          source: "runtime.controllers.GatekeeperController",
          data: { sessionId: id, startISO: attempt.startISO, endISO: attempt.endISO }
        });
        return { ok: true, ...attempt };
      }
    } catch (err) {
      emit("gatekeeper.reschedule.failed", { sessionId: id, error: msg(err) });
      return { ok: false, error: msg(err) };
    }

    emit("gatekeeper.reschedule.failed", { sessionId: id, reason: "move-rejected" });
    return { ok: false, reason: "move-rejected" };
  },

  /**
   * Notify humans when automation cannot resolve blockers.
   * @param {Object} args { sessionId, channel="system", urgency="normal", title?, body? }
   */
  async escalate(args) {
    const a = Object.assign({ channel: "system", urgency: "normal" }, args || {});
    if (!a.sessionId) {
      emit("gatekeeper.escalate.skipped", { reason: "missing-sessionId" });
      return { ok: false };
    }
    if (!Notifier || typeof Notifier.send !== "function") {
      emit("gatekeeper.escalate.skipped", { reason: "missing-notifier" });
      return { ok: false };
    }
    const payload = {
      channel: String(a.channel || "system"),
      title: a.title || "Attention needed for session",
      body: a.body || ("Session " + a.sessionId + " requires attention."),
      urgency: String(a.urgency || "normal"),
      meta: { sessionId: a.sessionId }
    };

    try {
      const ok = await Notifier.send(payload);
      emit("gatekeeper.escalate.sent", { sessionId: a.sessionId, ok: !!ok });
      return { ok: !!ok };
    } catch (err) {
      emit("gatekeeper.escalate.failed", { sessionId: a.sessionId, error: msg(err) });
      return { ok: false, error: msg(err) };
    }
  }
};

// ---------- core resolver logic ----------

async function attemptResolve(session, cfg) {
  const result = {
    ok: false,
    mutated: false,
    steps: []
  };

  // 0) Quick pass: constraints allowed?
  const allowed = await isAllowedByConstraints(session);
  if (!allowed) {
    // try a small move within window if permitted
    if (cfg.allowMoveWithinWindow) {
      const moved = await smallMove(session, "constraints");
      if (moved && moved.ok) {
        result.ok = true;
        result.mutated = true;
        result.steps.push({ action: "move", info: moved });
        emit("gatekeeper.resolve.moved", { sessionId: session.id || session.sessionId, ...moved });
        return result;
      }
    }
    result.steps.push({ action: "checkConstraints", info: "disallowed" });
    return result;
  }

  // 1) Equipment alternatives
  if (cfg.allowAltEquipment) {
    const equipOk = await hasEquipment(session);
    if (!equipOk) {
      const alt = await proposeAltEquipment(session);
      if (alt && alt.accepted) {
        result.mutated = true;
        result.steps.push({ action: "altEquipment", info: alt.selection });
        emit("gatekeeper.resolve.altEquipment", { sessionId: session.id || session.sessionId, selection: alt.selection });
      } else {
        result.steps.push({ action: "altEquipment", info: "no-alt" });
      }
    }
  }

  // 2) Inventory substitutions / reserve
  const inv = await checkInventory(session);
  if (!inv.ok) {
    if (cfg.allowSubstitutions) {
      const sub = await proposeSubstitutions(inv, session);
      if (sub && sub.accepted) {
        result.mutated = true;
        result.steps.push({ action: "substitutions", info: sub.items });
        emit("gatekeeper.resolve.substitutions", { sessionId: session.id || session.sessionId, items: sub.items });
      }
    }
    if (cfg.allowSoftReserve && inv.tight) {
      try {
        if (Inventory && typeof Inventory.reserve === "function") {
          await Inventory.reserve(inv.itemsNeeded || [], {
            sessionId: session.id || session.sessionId,
            soft: true,
            expiresAtISO: minusMinutesISO(session.plannedStartISO || session.suggestedStartISO, 5)
          });
          result.steps.push({ action: "reserve", info: "soft" });
          emit("gatekeeper.resolve.reserve", { sessionId: session.id || session.sessionId, soft: true });
        }
      } catch (_) {}
    }
  }

  // 3) Simplify variant (shorter prep) if still risky
  if (cfg.allowSimplifyVariant) {
    const risky = inv.tight || !inv.ok;
    if (risky) {
      const simp = await simplifyVariant(session);
      if (simp && simp.accepted) {
        result.mutated = true;
        result.steps.push({ action: "simplify", info: simp.variant });
        emit("gatekeeper.resolve.simplified", { sessionId: session.id || session.sessionId, variant: simp.variant });
      }
    }
  }

  // 4) Final feasibility sanity around current start
  const startISO = session.plannedStartISO || session.suggestedStartISO;
  const endISO = startISO ? addMinutesISO(startISO, Number(session.estimatedMinutes || 0)) : null;
  let feasible = true;
  if (feasibility && typeof feasibility.canMeetDeadline === "function" && startISO && endISO) {
    try {
      feasible = !!(await feasibility.canMeetDeadline({
        session,
        proposedStartISO: startISO,
        proposedEndISO: endISO,
        nowISO: new Date().toISOString()
      }));
    } catch (_) {}
  }

  // If infeasible, try a tiny move inside the window
  if (!feasible && cfg.allowMoveWithinWindow) {
    const moved = await smallMove(session, "feasibility");
    if (moved && moved.ok) {
      result.mutated = true;
      result.steps.push({ action: "move", info: moved });
      emit("gatekeeper.resolve.moved", { sessionId: session.id || session.sessionId, ...moved });
      feasible = true;
    }
  }

  result.ok = feasible && (inv.ok || cfg.allowSubstitutions);
  return result;
}

// ---------- contingency primitives ----------

async function computeContingencies(session) {
  const out = { feasible: true, suggestions: [] };

  // Alternate slots / gap-fills
  if (optionsEngine && typeof optionsEngine.suggestAlternates === "function") {
    try {
      const alts = await optionsEngine.suggestAlternates({
        session,
        limit: 3,
        horizonMinutes: 240
      });
      if (Array.isArray(alts) && alts.length) {
        out.suggestions.push({ kind: "alternateSlots", items: alts });
      }
    } catch (_) {}
  }

  // Simplified variants
  const simp = await previewSimplify(session);
  if (simp && simp.variant) {
    out.suggestions.push({ kind: "simplifyVariant", items: [simp.variant] });
  }

  // Inventory substitutions preview
  const inv = await checkInventory(session);
  if (!inv.ok || inv.tight) {
    const sub = await previewSubstitutions(inv, session);
    if (sub && sub.items && sub.items.length) {
      out.suggestions.push({ kind: "substitutions", items: sub.items });
      out.feasible = false;
    }
  }

  // Constraint window nudges
  const allowed = await isAllowedByConstraints(session);
  if (!allowed) {
    out.suggestions.push({ kind: "nudgeWindow", items: ["Shift outside quiet hours/holy day window"] });
    out.feasible = false;
  }

  return out;
}

async function smallMove(session, reason) {
  if (!Rescheduler || typeof Rescheduler.move !== "function") return null;
  const maxShiftMinutes = 30;
  const startISO = session.plannedStartISO || session.suggestedStartISO;
  if (!startISO) return null;
  // Try +15, -15, +30 minutes
  const probes = [15, -15, 30];
  const durMin = Number(session.estimatedMinutes || 0);
  for (let i = 0; i < probes.length; i++) {
    const sISO = addMinutesISO(startISO, probes[i]);
    const eISO = addMinutesISO(sISO, durMin);
    const ok = await quickFeasible(session, sISO, eISO);
    if (ok) {
      try {
        const moved = await Rescheduler.move({
          id: session.id || session.sessionId,
          startISO: sISO,
          endISO: eISO,
          reason: "gatekeeper:" + reason
        });
        if (moved) return { ok: true, startISO: sISO, endISO: eISO, deltaMinutes: probes[i] };
      } catch (_) {}
    }
  }
  return null;
}

async function findFeasibleShift(session, window) {
  const step = 5; // minutes
  const durMin = Number(session.estimatedMinutes || 0);
  const startT = Date.parse(window.startISO);
  const endT = Date.parse(window.endISO);
  for (let t = startT; t + durMin * 60000 <= endT; t += step * 60000) {
    const sISO = new Date(t).toISOString();
    const eISO = new Date(t + durMin * 60000).toISOString();
    if (await quickFeasible(session, sISO, eISO)) return { startISO: sISO, endISO: eISO };
  }
  return null;
}

async function quickFeasible(session, startISO, endISO) {
  if (feasibility && typeof feasibility.canMeetDeadline === "function") {
    try {
      return !!(await feasibility.canMeetDeadline({
        session,
        proposedStartISO: startISO,
        proposedEndISO: endISO,
        nowISO: new Date().toISOString()
      }));
    } catch (_) {}
  }
  return true;
}

// ---------- domain helpers ----------

async function isAllowedByConstraints(session) {
  if (!constraintsPolicy) return true;
  try {
    if (typeof constraintsPolicy.isAllowed === "function") {
      return !!(await constraintsPolicy.isAllowed(session, { nowISO: new Date().toISOString() }));
    }
    if (typeof constraintsPolicy.filterSessions === "function") {
      const res = await constraintsPolicy.filterSessions([session], { nowISO: new Date().toISOString() });
      return Array.isArray(res) && res.length === 1;
    }
  } catch (_) {}
  return true;
}

async function hasEquipment(session) {
  const equipment = session.equipment || [];
  if (!equipment.length) return true;
  if (!Storehouse || typeof Storehouse.hasEquipment !== "function") return true;
  try { return !!(await Storehouse.hasEquipment(equipment)); } catch (_) { return true; }
}

async function proposeAltEquipment(session) {
  if (!Storehouse || typeof Storehouse.altEquipment !== "function") return null;
  try {
    const alt = await Storehouse.altEquipment(session.equipment || [], { domain: session.domain });
    if (alt && alt.accepted) {
      if (SessionStore && typeof SessionStore.updateEquipment === "function") {
        await SessionStore.updateEquipment(session.id || session.sessionId, alt.selection || []);
      }
      return { accepted: true, selection: alt.selection || [] };
    }
  } catch (_) {}
  return null;
}

async function checkInventory(session) {
  if (!Inventory || typeof Inventory.checkAvailability !== "function") {
    return { ok: true, itemsNeeded: [], tight: false };
  }
  const items = extractInventoryItems(session);
  try {
    const res = await Inventory.checkAvailability(items);
    const ok = !!res && !!res.ok && (!res.missing || res.missing.length === 0);
    const tight = !!res && Array.isArray(res.low) && res.low.length > 0;
    const needed = Array.isArray(res.missing) ? res.missing : [];
    return { ok, itemsNeeded: needed, tight };
  } catch (_) {
    return { ok: true, itemsNeeded: [], tight: false };
  }
}

async function proposeSubstitutions(inv, session) {
  if (!Inventory || typeof Inventory.proposeSubstitutions !== "function") return null;
  try {
    const proposal = await Inventory.proposeSubstitutions(inv.itemsNeeded || [], { domain: session.domain });
    if (proposal && proposal.items && proposal.items.length) {
      if (SessionStore && typeof SessionStore.applySubstitutions === "function") {
        await SessionStore.applySubstitutions(session.id || session.sessionId, proposal.items);
      }
      return { accepted: true, items: proposal.items };
    }
  } catch (_) {}
  return null;
}

async function previewSubstitutions(inv, session) {
  if (!Inventory || typeof Inventory.proposeSubstitutions !== "function") return null;
  try {
    const proposal = await Inventory.proposeSubstitutions(inv.itemsNeeded || [], { domain: session.domain, dryRun: true });
    return proposal || null;
  } catch (_) { return null; }
}

async function simplifyVariant(session) {
  if (!optionsEngine) return null;
  const fn = optionsEngine.simplifyVariant || optionsEngine.simplify || null;
  if (!fn) return null;
  try {
    const res = await fn({ session, intent: "reduce-prep", maxReductionPercent: 0.3 });
    if (res && res.accepted && SessionStore && typeof SessionStore.applyVariant === "function") {
      await SessionStore.applyVariant(session.id || session.sessionId, res.variant);
      return { accepted: true, variant: res.variant };
    }
  } catch (_) {}
  return null;
}

async function previewSimplify(session) {
  if (!optionsEngine) return null;
  const fn = optionsEngine.simplifyVariant || optionsEngine.simplify || null;
  if (!fn) return null;
  try {
    return await fn({ session, intent: "reduce-prep", dryRun: true, maxReductionPercent: 0.3 });
  } catch (_) { return null; }
}

// ---------- utility & infra ----------

function requireSafe(modulePath) {
  try {
    if (!modulePath) return null;
    if (modulePath.indexOf("@/") === 0) {
      const root = path.resolve(__dirname, "../.."); // -> src/
      const abs = path.join(root, modulePath.replace("@/", ""));
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require(abs);
    }
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(modulePath);
  } catch (_) { return null; }
}

function ensureJob(name, mod, fnName) {
  if (!mod || typeof mod[fnName] !== "function") {
    throw new Error("job-missing:" + name);
  }
}

function sanitizeArgs(args) {
  if (!args) return {};
  const out = {};
  for (const k of Object.keys(args)) {
    if (k.toLowerCase().includes("token")) continue;
    const v = args[k];
    if (typeof v === "string" && v.length > 200) continue;
    out[k] = v;
  }
  return out;
}

function shrink(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const keep = ["ok","resolved","mutated","prepsQueued","reservations","placed","considered","inspected","blockers","skipped","reason"];
  const o = {};
  for (const k of keep) if (Object.prototype.hasOwnProperty.call(obj, k)) o[k] = obj[k];
  return o;
}

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: new Date().toISOString(), source: "runtime.controllers.GatekeeperController", data });
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

function extractInventoryItems(session) {
  const out = [];
  const list = Array.isArray(session.ingredients) ? session.ingredients
    : (Array.isArray(session.materials) ? session.materials : []);
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    const sku = it.sku || it.code || null;
    const name = it.name || it.label || null;
    const qty = Number(it.qty || it.quantity || 0);
    const unit = it.unit || it.uom || null;
    if ((sku || name) && qty > 0) out.push({ sku, name, qty, unit });
  }
  return out;
}

function normalizeResolveArgs(args) {
  const a = args || {};
  const ids = Array.isArray(a.sessionIds) ? a.sessionIds
    : (a.sessionIds ? [a.sessionIds] : null);
  if (!ids || !ids.length) return null;
  return {
    sessionIds: ids,
    allowSubstitutions: flag(a.allowSubstitutions, true),
    allowAltEquipment: flag(a.allowAltEquipment, true),
    allowSoftReserve: flag(a.allowSoftReserve, true),
    allowSimplifyVariant: flag(a.allowSimplifyVariant, true),
    allowMoveWithinWindow: flag(a.allowMoveWithinWindow, true),
    timezone: a.timezone || "America/Chicago"
  };
}

function normalizeWindow(startISO, endISO) {
  const s = Date.parse(startISO || "");
  const e = Date.parse(endISO || "");
  if (!isFinite(s) || !isFinite(e) || e <= s) return null;
  return { startISO: new Date(s).toISOString(), endISO: new Date(e).toISOString() };
}

function boundShiftWindow(session, earliestISO, latestISO, maxShiftMinutes) {
  const startISO = session.plannedStartISO || session.suggestedStartISO;
  const durMin = Number(session.estimatedMinutes || 0);
  const baseS = Date.parse(startISO || "");
  const maxShift = isFinite(maxShiftMinutes) && maxShiftMinutes > 0 ? maxShiftMinutes : 45;
  const sMin = isFinite(Date.parse(earliestISO || "")) ? Date.parse(earliestISO) : (baseS - maxShift * 60000);
  const sMax = isFinite(Date.parse(latestISO || "")) ? Date.parse(latestISO) : (baseS + maxShift * 60000);
  return { startISO: new Date(sMin).toISOString(), endISO: new Date(sMax + durMin * 60000).toISOString() };
}

function flag(v, def) {
  return (v != null) ? !!v : !!def;
}

function addMinutesISO(iso, min) {
  const t = Date.parse(iso || "");
  if (!isFinite(t)) return null;
  return new Date(t + (Number(min) || 0) * 60000).toISOString();
}

function minusMinutesISO(iso, min) {
  const t = Date.parse(iso || "");
  if (!isFinite(t)) return null;
  return new Date(t - (Number(min) || 0) * 60000).toISOString();
}

function compactResults(results) {
  return results.map(r => ({
    id: r.id,
    ok: !!r.ok,
    mutated: !!r.mutated,
    steps: Array.isArray(r.steps) ? r.steps.map(s => s.action) : []
  }));
}

function msg(err) {
  return String((err && err.message) || err || "unknown");
}
