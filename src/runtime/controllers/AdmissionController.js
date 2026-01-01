// C:\Users\larho\suka-smart-assistant\src\runtime\controllers\AdmissionController.js
// SSA Runtime — Admission Controller
// -----------------------------------------------------------------------------
// Role in pipeline:
//   imports → intelligence → automation → (optional) hub export
//   - Guards new session additions before they enter the scheduling engine.
//   - Consolidates feasibility, constraints, buffers, priorities, and basic
//     inventory sanity into a single “admission gate”.
//   - Emits normalized admission events and mirrors accepted sessions to the Hub
//     (if familyFundMode is enabled).
//
// Exposed operations:
//   - preflightCheck(candidate)         → fast, non-mutating validation report
//   - proposeAdmission(candidate, opts) → attempts fixes (alt slots, simplify) and returns a plan
//   - admit(candidate, opts)            → create/update session if admissible
//   - upsertBatch(candidates, opts)     → efficient multi-admission with per-item outcomes
//
// Events (payloads always: { type, ts, source, data }):
//   - admission.preflight.started|completed|failed
//   - admission.proposal.started|completed|failed
//   - admission.created
//   - admission.updated
//   - admission.rejected
//   - admission.batch.completed
//
// Notes:
//   - “candidate” is a raw session-like object; this controller normalizes it.
//   - Inventory/storehouse checks here are *shallow* to keep admission snappy;
//     deeper readiness is handled later by readiness sweeps & risk controller.
// -----------------------------------------------------------------------------

const path = require("path");

// ---------- shared services (defensive requires) ----------
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

// ---------- engine/policy modules (defensive) ----------
const feasibility = requireSafe("@/engines/scheduling/admission/feasibility.js"); // canMeetDeadline({...})
const optionsEngine = requireSafe("@/engines/scheduling/admission/options.js");   // suggestAlternates, simplifyVariant
const buffersPolicy = requireSafe("@/engines/scheduling/policies/buffers.js");    // getRecommendedBuffer(domain, kind)
const priorities    = requireSafe("@/engines/scheduling/policies/priorities.js"); // computePriority/scoreSessions?
const constraints   = requireSafe("@/engines/scheduling/policies/constraints.js");// isAllowed(session, ctx)
const SessionStore  = requireSafe("@/engines/scheduling/SessionStore.js") || requireSafe("@/engines/scheduling/sessionStore.js"); // create/update/find
const Inventory     = requireSafe("@/domain/inventory/InventoryService.js");     // quickCheck(list)
const Storehouse    = requireSafe("@/domain/storehouse/StorehouseService.js");   // hasEquipment(list)

// ---------- controller API ----------
module.exports = {
  /**
   * Quick, non-mutating validation against policies and obvious errors.
   * @param {Object} candidate
   * @returns {Object} { ok, reasons[], warnings[], normalized }
   */
  async preflightCheck(candidate) {
    const startedAt = nowISO();
    emit("admission.preflight.started", { startedAt });

    const norm = normalizeCandidate(candidate);
    const reasons = [];
    const warnings = [];

    if (!norm) {
      emit("admission.preflight.completed", { ok: false, reasons: ["invalid-candidate"] });
      return { ok: false, reasons: ["invalid-candidate"], warnings: [], normalized: null };
    }

    // Basic fields
    if (!norm.title) reasons.push("missing-title");
    if (!isFiniteMs(Date.parse(norm.deadlineISO))) reasons.push("invalid-deadline");
    if (!isFinite(norm.estimatedMinutes) || norm.estimatedMinutes <= 0) reasons.push("invalid-estimatedMinutes");

    // Constraints snapshot
    const allowed = await allowedByConstraints(norm);
    if (!allowed) reasons.push("disallowed-by-constraints");

    // Equipment presence (warning-level)
    if (Array.isArray(norm.equipment) && norm.equipment.length) {
      const eqOK = await hasEquipment(norm.equipment);
      if (!eqOK) warnings.push("equipment-not-found");
    }

    // Inventory quick check (non-blocking here, just warning)
    const invChk = await quickInventoryCheck(norm);
    if (invChk.missing && invChk.missing.length) warnings.push("items-missing");
    if (invChk.low && invChk.low.length) warnings.push("items-low");

    // Feasibility (fast forward check)
    const now = nowISO();
    const startISO = norm.preferredStartISO || norm.suggestedStartISO || now;
    const endISO = addMinutesISO(startISO, norm.estimatedMinutes);
    const feas = await canMeet(norm, startISO, endISO, now);
    if (!feas) warnings.push("tight-against-deadline");

    const ok = reasons.length === 0;
    emit("admission.preflight.completed", { ok, reasons, warnings });

    return { ok, reasons, warnings, normalized: norm };
  },

  /**
   * Try to build an admission plan with mitigations (alternate slots, simplify).
   * Non-mutating; returns a recommended placement & variant if helpful.
   * @param {Object} candidate
   * @param {Object} opts { horizonMinutes=480, alternates=3, allowSimplify=true }
   */
  async proposeAdmission(candidate, opts) {
    emit("admission.proposal.started", {});
    const norm = normalizeCandidate(candidate);
    if (!norm) {
      emit("admission.proposal.failed", { error: "invalid-candidate" });
      return { ok: false, error: "invalid-candidate" };
    }

    // Respect constraints (hard block)
    const allowed = await allowedByConstraints(norm);
    if (!allowed) {
      emit("admission.proposal.completed", { ok: false, reasons: ["disallowed-by-constraints"] });
      return { ok: false, reasons: ["disallowed-by-constraints"] };
    }

    const plan = { alternates: [], simplify: null, buffers: {}, priority: null };

    // Buffers recommendation (for planner visuals)
    plan.buffers = safeBuffers(norm);

    // Priority score (if available)
    plan.priority = await safePriorityScore(norm);

    // Alternate slots
    const a = Object.assign({ horizonMinutes: 480, alternates: 3, allowSimplify: true }, opts || {});
    if (optionsEngine && typeof optionsEngine.suggestAlternates === "function") {
      try {
        const alts = await optionsEngine.suggestAlternates({
          session: norm,
          limit: Math.max(1, Math.min(10, Number(a.alternates) || 3)),
          horizonMinutes: Math.max(60, Math.min(1440, Number(a.horizonMinutes) || 480))
        });
        plan.alternates = Array.isArray(alts) ? alts : [];
      } catch (_) {}
    }

    // Simplify variant preview (shorter, safer variant)
    if (a.allowSimplify && optionsEngine) {
      const fn = optionsEngine.simplifyVariant || optionsEngine.simplify;
      if (typeof fn === "function") {
        try {
          const simp = await fn({ session: norm, dryRun: true, intent: "admission", maxReductionPercent: 0.3 });
          if (simp && simp.variant) plan.simplify = simp.variant;
        } catch (_) {}
      }
    }

    emit("admission.proposal.completed", { ok: true, planSummary: planSummary(plan) });
    return { ok: true, plan, normalized: norm };
  },

  /**
   * Admit a single session (create or update).
   * Applies minimal safe fixes if provided (chosenAlternate, chosenVariant).
   * @param {Object} candidate
   * @param {Object} opts { chosenAlternate?, chosenVariant?, upsertKey? }
   */
  async admit(candidate, opts) {
    const norm = normalizeCandidate(candidate);
    if (!norm) {
      emitRejected("invalid-candidate", candidate);
      return { ok: false, error: "invalid-candidate" };
    }

    // Hard guard: constraints
    if (!(await allowedByConstraints(norm))) {
      emitRejected("disallowed-by-constraints", norm);
      return { ok: false, error: "disallowed-by-constraints" };
    }

    // Optional fixes from caller
    const o = opts || {};
    const fixed = await applyChosenFixes(norm, o);

    // Feasibility at proposed times (after fixes)
    const startISO = fixed.proposedStartISO || norm.preferredStartISO || norm.suggestedStartISO || nowISO();
    const endISO = addMinutesISO(startISO, norm.estimatedMinutes);
    if (!(await canMeet(norm, startISO, endISO, nowISO()))) {
      // Try a tiny nudge (+/- 15m) before rejecting
      const nudged = await tryNudge(norm, 15);
      if (!nudged) {
        emitRejected("cannot-meet-deadline", norm);
        return { ok: false, error: "cannot-meet-deadline" };
      }
    }

    // Create or update
    if (!SessionStore || (typeof SessionStore.create !== "function" && typeof SessionStore.upsert !== "function")) {
      emitRejected("session-store-missing", norm);
      return { ok: false, error: "session-store-missing" };
    }

    const payload = Object.assign({}, norm, {
      plannedStartISO: startISO,
      plannedEndISO: addMinutesISO(startISO, norm.estimatedMinutes),
      buffers: safeBuffers(norm)
    });

    try {
      let res = null;
      if (typeof SessionStore.upsert === "function" && o.upsertKey) {
        res = await SessionStore.upsert(o.upsertKey, payload);
      } else {
        res = await SessionStore.create(payload);
      }

      const created = !!(res && res.id);
      emit(created ? "admission.created" : "admission.updated", {
        sessionId: created ? res.id : (res && res.id) || null,
        domain: norm.domain,
        kind: norm.kind || (norm.meta && norm.meta.kind) || "general",
        plannedStartISO: payload.plannedStartISO,
        plannedEndISO: payload.plannedEndISO
      });

      await exportToHubIfEnabled({
        type: created ? "admission.created" : "admission.updated",
        ts: nowISO(),
        source: "runtime.controllers.AdmissionController",
        data: {
          id: res && res.id,
          domain: norm.domain,
          kind: norm.kind || (norm.meta && norm.meta.kind) || "general",
          plannedStartISO: payload.plannedStartISO,
          plannedEndISO: payload.plannedEndISO
        }
      });

      return { ok: true, id: res && res.id, session: res || payload };
    } catch (err) {
      emitRejected("store-error:" + String(err && err.message || err), norm);
      return { ok: false, error: "store-error" };
    }
  },

  /**
   * Batch upsert with per-item isolation.
   * @param {Array<Object>} candidates
   * @param {Object} opts  { defaultHorizonMinutes?, allowSimplify?, upsertKeyField? }
   */
  async upsertBatch(candidates, opts) {
    const arr = Array.isArray(candidates) ? candidates : [];
    const outcomes = [];
    let okCount = 0; let rejectCount = 0;

    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      try {
        const upsertKey = opts && opts.upsertKeyField && c ? c[opts.upsertKeyField] : undefined;
        const res = await this.admit(c, { upsertKey, chosenVariant: c && c.chosenVariant, chosenAlternate: c && c.chosenAlternate });
        outcomes.push(res);
        okCount += res && res.ok ? 1 : 0;
        rejectCount += res && !res.ok ? 1 : 0;
      } catch (err) {
        outcomes.push({ ok: false, error: "exception", message: String(err && err.message || err) });
        rejectCount += 1;
      }
    }

    emit("admission.batch.completed", { total: arr.length, ok: okCount, rejected: rejectCount });
    return { ok: rejectCount === 0, total: arr.length, accepted: okCount, rejected: rejectCount, outcomes };
  }
};

// ---------- admission helpers ----------

async function applyChosenFixes(norm, opts) {
  const out = {};
  if (opts && opts.chosenVariant && optionsEngine) {
    const fn = optionsEngine.applyVariant || optionsEngine.simplifyVariant || optionsEngine.simplify;
    if (typeof fn === "function") {
      try {
        const applied = await fn({ session: norm, variant: opts.chosenVariant, dryRun: false, intent: "admission-apply" });
        if (applied && applied.accepted) Object.assign(norm, { variant: applied.variant, estimatedMinutes: applied.estimatedMinutes || norm.estimatedMinutes });
      } catch (_) {}
    }
  }
  if (opts && opts.chosenAlternate) {
    out.proposedStartISO = opts.chosenAlternate.startISO || opts.chosenAlternate.start || null;
  }
  return out;
}

async function tryNudge(norm, spanMinutes) {
  const span = Math.max(5, Number(spanMinutes) || 15);
  const start = norm.preferredStartISO || norm.suggestedStartISO || nowISO();
  const probes = [span, -span];
  for (let i = 0; i < probes.length; i++) {
    const sISO = addMinutesISO(start, probes[i]);
    const eISO = addMinutesISO(sISO, norm.estimatedMinutes);
    if (await canMeet(norm, sISO, eISO, nowISO())) {
      norm.suggestedStartISO = sISO;
      return true;
    }
  }
  return false;
}

async function allowedByConstraints(session) {
  if (!constraints || typeof constraints.isAllowed !== "function") return true;
  try {
    return !!(await constraints.isAllowed(session, { nowISO: nowISO() }));
  } catch (_) { return true; }
}

async function canMeet(session, startISO, endISO, now) {
  if (!feasibility || typeof feasibility.canMeetDeadline !== "function") return true;
  try {
    return !!(await feasibility.canMeetDeadline({
      session,
      proposedStartISO: startISO,
      proposedEndISO: endISO,
      nowISO: now
    }));
  } catch (_) { return true; }
}

function safeBuffers(session) {
  try {
    if (!buffersPolicy || typeof buffersPolicy.getRecommendedBuffer !== "function") return { beforeMs: 0, afterMs: 0 };
    const rec = buffersPolicy.getRecommendedBuffer(session.domain || "general", session.meta && session.meta.kind);
    return { beforeMs: Number(rec && rec.beforeMs || 0), afterMs: Number(rec && rec.afterMs || 0) };
  } catch (_) { return { beforeMs: 0, afterMs: 0 }; }
}

async function safePriorityScore(session) {
  try {
    if (!priorities) return null;
    if (typeof priorities.computePriority === "function") return await priorities.computePriority(session);
    if (typeof priorities.scoreSessions === "function") {
      const arr = await priorities.scoreSessions([session]);
      return Array.isArray(arr) && arr[0] ? arr[0].score : null;
    }
  } catch (_) {}
  return null;
}

async function quickInventoryCheck(session) {
  try {
    if (!Inventory || typeof Inventory.quickCheck !== "function") return { low: [], missing: [] };
    const items = extractInventoryItems(session);
    return await Inventory.quickCheck(items);
  } catch (_) { return { low: [], missing: [] }; }
}

async function hasEquipment(equipmentList) {
  try {
    if (!Storehouse || typeof Storehouse.hasEquipment !== "function") return true;
    return !!(await Storehouse.hasEquipment(equipmentList));
  } catch (_) { return true; }
}

// ---------- normalization & utils ----------

function normalizeCandidate(c) {
  if (!c || typeof c !== "object") return null;
  const title = String(c.title || c.name || "").trim();
  const domain = pickDomain(c.domain);
  const estimatedMinutes = toNum(c.estimatedMinutes, 0);
  const deadlineISO = toISO(c.deadlineISO || c.deadline || c.dueByISO || c.dueBy);
  const preferredStartISO = toISO(c.preferredStartISO || c.preferredStart || c.suggestedStartISO || c.suggestedStart);
  const equipment = Array.isArray(c.equipment) ? c.equipment : [];
  const ingredients = Array.isArray(c.ingredients) ? c.ingredients : (Array.isArray(c.materials) ? c.materials : []);

  const out = {
    id: c.id || c.sessionId,
    title,
    domain,
    kind: c.kind || (c.meta && c.meta.kind) || "general",
    estimatedMinutes: isFinite(estimatedMinutes) && estimatedMinutes > 0 ? estimatedMinutes : 0,
    deadlineISO,
    preferredStartISO,
    suggestedStartISO: preferredStartISO, // seed
    equipment,
    ingredients,
    meta: Object.assign({}, c.meta || {})
  };

  // Drop if minimal fields absent
  if (!out.title || !out.deadlineISO || out.estimatedMinutes <= 0) return null;
  return out;
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

function pickDomain(d) {
  const s = String(d || "general").toLowerCase();
  switch (s) {
    case "recipe":
    case "cooking": return "cooking";
    case "cleaning": return "cleaning";
    case "garden":
    case "seed":
    case "garden/seed": return "garden";
    case "animal":
    case "butchery": return "animal";
    case "preservation": return "preservation";
    case "storehouse": return "storehouse";
    default: return "general";
  }
}

function toISO(v) {
  const t = Date.parse(v || "");
  return isFiniteMs(t) ? new Date(t).toISOString() : null;
}
function toNum(v, def){ const n = Number(v); return isFinite(n) ? n : def; }
function addMinutesISO(iso, min){
  const t = Date.parse(iso || "");
  if (!isFiniteMs(t)) return null;
  return new Date(t + Math.max(0, Number(min) || 0) * 60000).toISOString();
}
function isFiniteMs(n){ return typeof n === "number" && isFinite(n); }

function planSummary(plan) {
  return {
    alternates: Array.isArray(plan.alternates) ? plan.alternates.length : 0,
    hasSimplify: !!(plan.simplify),
    hasBuffers: !!plan.buffers && (plan.buffers.beforeMs > 0 || plan.buffers.afterMs > 0),
    priority: plan.priority
  };
}

function emitRejected(reason, norm) {
  emit("admission.rejected", {
    reason,
    domain: norm && norm.domain,
    kind: norm && (norm.kind || (norm.meta && norm.meta.kind)),
    title: norm && norm.title
  });
}

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: nowISO(), source: "runtime.controllers.AdmissionController", data });
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

function nowISO(){ return new Date().toISOString(); }
