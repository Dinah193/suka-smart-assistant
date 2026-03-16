// C:\Users\larho\suka-smart-assistant\src\runtime\controllers\RiskController.js
// SSA Runtime — Risk Controller
// -----------------------------------------------------------------------------
// Role in pipeline:
//   imports → intelligence → automation → (optional) hub export
//   - Monitors *live / in-progress* sessions across domains (cooking, cleaning,
//     garden, animal, preservation).
//   - Computes a unified risk score and applies corrective actions:
//       • soft-pause / resume
//       • extend time buffers / split into follow-up
//       • substitute risky steps (e.g., lower-heat variant)
//       • throttle concurrency / shed non-critical work
//       • escalate to human, or hard-abort if unsafe
//   - Emits normalized runtime events and mirrors state deltas to the Hub
//     when familyFundMode is enabled.
//
// Events (payloads always: { type, ts, source, data }):
//   - risk.monitor.started
//   - risk.session.scored
//   - risk.session.action.applied
//   - risk.session.escalated
//   - risk.session.aborted
//   - risk.monitor.completed
//
// Defensive design:
//   - All dependencies optional and guarded. If a subsystem is missing, we
//     degrade gracefully while continuing to emit observability events.
//   - Strict input validation and early returns.
//
// Notes:
//   - This controller does *not* schedule new work. It guards currently running
//     sessions. For upstream admission/priorities/constraints, see other engines.
// -----------------------------------------------------------------------------

const path = require("path");

// ---------- shared services (defensive requires) ----------
let eventBus = { emit: function () {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_) {}

let featureFlags = { familyFundMode: false };
try {
  const ff = require("@/config/featureFlags");
  featureFlags = (ff && (ff.default || ff)) || featureFlags;
} catch (_) {}

let HubPacketFormatter = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
} catch (_) {}
let FamilyFundConnector = null;
try {
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch (_) {}

// ---------- domain stores/engines (defensive) ----------
const LiveSessionStore = requireSafe(
  "@/engines/scheduling/LiveSessionStore.js"
); // getActive(), getById(), update(), appendNote()
const SessionControl = requireSafe("@/engines/scheduling/SessionControl.js"); // pause(), resume(), extend(), split(), abort()
const Inventory = requireSafe("@/domain/inventory/InventoryService.js"); // driftSinceReservation(sessionId)
const Storehouse = requireSafe("@/domain/storehouse/StorehouseService.js"); // sensorSnapshot?(equipmentIds)
const constraints = requireSafe("@/engines/scheduling/policies/constraints.js");
const buffersPolicy = requireSafe("@/engines/scheduling/policies/buffers.js");
const priorities = requireSafe("@/engines/scheduling/policies/priorities.js");
const OptionsEngine = requireSafe("@/engines/scheduling/admission/options.js"); // simplifyVariant({session,...})

// ---------- public API ----------
module.exports = {
  /**
   * One-shot monitor pass. Intended to be called by a job every N minutes, or ad-hoc.
   * @param {Object} args
   * @param {number} [args.maxToInspect=50]
   * @param {boolean} [args.allowStepSubstitution=true]
   * @param {boolean} [args.allowExtend=true]
   * @param {boolean} [args.allowPause=true]
   * @param {boolean} [args.allowAbortOnUnsafe=true]
   * @param {boolean} [args.allowThrottle=true]
   * @param {string}  [args.timezone="America/Chicago"]
   */
  async monitorOnce(args) {
    const cfg = normalizeArgs(args);
    if (!cfg) {
      emit("risk.monitor.completed", { ok: false, reason: "invalid-args" });
      return { ok: false, inspected: 0, actions: 0 };
    }

    if (!LiveSessionStore || typeof LiveSessionStore.getActive !== "function") {
      emit("risk.monitor.completed", {
        ok: false,
        reason: "missing-live-store",
      });
      return { ok: false, inspected: 0, actions: 0 };
    }

    emit("risk.monitor.started", {
      maxToInspect: cfg.maxToInspect,
      policy: pick(cfg, [
        "allowStepSubstitution",
        "allowExtend",
        "allowPause",
        "allowAbortOnUnsafe",
        "allowThrottle",
      ]),
    });

    let active = [];
    try {
      active = await LiveSessionStore.getActive();
    } catch (_) {
      active = [];
    }
    active = (Array.isArray(active) ? active : []).slice(0, cfg.maxToInspect);

    let inspected = 0;
    let actions = 0;

    for (let i = 0; i < active.length; i++) {
      const session = active[i];
      inspected++;
      const ctx = await buildContext(session);

      const score = scoreRisk(session, ctx);
      emit("risk.session.scored", {
        sessionId: sid(session),
        score,
        ctx: minCtx(ctx),
      });

      // Safety first: abort if actively unsafe and policy allows.
      if (score.flags.unsafe && cfg.allowAbortOnUnsafe) {
        const applied = await safeAbort(session, "unsafe-conditions");
        actions += applied ? 1 : 0;
        if (applied) continue; // move to next session
      }

      // If not unsafe but high risk, attempt mitigations in sequence.
      if (score.level === "high") {
        const applied = await mitigateHighRisk(session, ctx, cfg);
        actions += applied ? 1 : 0;
        continue;
      }

      // Moderate risk: gentle actions (pause or extend)
      if (score.level === "moderate") {
        const applied = await mitigateModerateRisk(session, ctx, cfg);
        actions += applied ? 1 : 0;
        continue;
      }

      // Low risk: no action.
    }

    const summary = { ok: true, inspected, actions };
    emit("risk.monitor.completed", summary);
    if (actions > 0) {
      await exportToHubIfEnabled({
        type: "risk.monitor.delta",
        ts: new Date().toISOString(),
        source: "runtime.controllers.RiskController",
        data: summary,
      });
    }
    return summary;
  },

  /**
   * Direct intervention API — useful for operators or rule-based triggers.
   * @param {Object} args { sessionId, action, params? }
   * action ∈ {"pause","resume","extend","split","abort","simplify"}
   */
  async intervene(args) {
    const a = args || {};
    const id = a.sessionId;
    const action = String(a.action || "").toLowerCase();
    if (!id || !action) return { ok: false, error: "invalid-args" };
    if (!LiveSessionStore || typeof LiveSessionStore.getById !== "function")
      return { ok: false, error: "missing-live-store" };

    let s = null;
    try {
      s = await LiveSessionStore.getById(id);
    } catch (_) {}
    if (!s) return { ok: false, error: "session-not-found" };

    const res = await applyAction(s, action, a.params || {});
    return res || { ok: false, error: "action-failed" };
  },
};

// ---------- mitigation strategies ----------

async function mitigateHighRisk(session, ctx, cfg) {
  // Priority: pause (if safe), substitute risky steps, extend time, throttle concurrency, escalate.
  // Return true if *any* action was applied.
  // 1) Pause if equipment overheating or constraint breach
  if (
    cfg.allowPause &&
    (ctx.sensors.overheat || ctx.constraints.disallowedNow)
  ) {
    if (await safePause(session, "safety-pause")) return true;
  }

  // 2) Step substitution (simplify variant, e.g., lower-heat method)
  if (cfg.allowStepSubstitution) {
    const sub = await trySimplify(session, {
      intent: "risk-reduce",
      maxReductionPercent: 0.4,
    });
    if (sub && sub.ok) return true;
  }

  // 3) Extend time buffers (if possible)
  if (
    cfg.allowExtend &&
    (await safeExtend(session, ctx, 15, "extend-buffer-high-risk"))
  )
    return true;

  // 4) Throttle: pause a concurrent non-critical session (if any)
  if (cfg.allowThrottle) {
    const throttled = await tryShedNonCritical(
      session,
      ctx,
      "throttle-concurrency"
    );
    if (throttled) return true;
  }

  // 5) Escalate to human
  await escalateHuman(session, "High risk detected. Please check progress.");
  return false;
}

async function mitigateModerateRisk(session, ctx, cfg) {
  // Priority: extend time or soft-pause to regain buffer
  if (
    cfg.allowExtend &&
    (await safeExtend(session, ctx, 10, "extend-buffer-moderate"))
  )
    return true;

  if (
    cfg.allowPause &&
    ctx.buffers.preBeforeMs < 2 * MINUTE &&
    ctx.progress.behindByMinutes > 5
  ) {
    return await safePause(session, "stabilize");
  }
  return false;
}

// ---------- core actions (apply + emit + hub mirror) ----------

async function applyAction(session, action, params) {
  switch (action) {
    case "pause":
      return await safePause(session, (params && params.reason) || "manual");
    case "resume":
      return await safeResume(session, (params && params.reason) || "manual");
    case "extend":
      return await safeExtend(
        session,
        await buildContext(session),
        Number((params && params.minutes) || 10),
        (params && params.reason) || "manual-extend"
      );
    case "split":
      return await safeSplit(
        session,
        Number((params && params.minutes) || 15),
        (params && params.reason) || "manual-split"
      );
    case "abort":
      return await safeAbort(session, (params && params.reason) || "manual");
    case "simplify": {
      const res = await trySimplify(session, {
        intent: "manual",
        maxReductionPercent: Number(
          (params && params.maxReductionPercent) || 0.3
        ),
      });
      return res || { ok: false, error: "simplify-failed" };
    }
    default:
      return { ok: false, error: "unknown-action" };
  }
}

async function safePause(session, reason) {
  if (!SessionControl || typeof SessionControl.pause !== "function")
    return false;
  try {
    const ok = await SessionControl.pause({ id: sid(session), reason });
    if (ok) {
      const data = { sessionId: sid(session), action: "pause", reason };
      emit("risk.session.action.applied", data);
      await exportToHubIfEnabled({
        type: "risk.session.action.applied",
        ts: nowISO(),
        source: SRC,
        data,
      });
    }
    return !!ok;
  } catch (_) {
    return false;
  }
}

async function safeResume(session, reason) {
  if (!SessionControl || typeof SessionControl.resume !== "function")
    return false;
  try {
    const ok = await SessionControl.resume({ id: sid(session), reason });
    if (ok) {
      const data = { sessionId: sid(session), action: "resume", reason };
      emit("risk.session.action.applied", data);
      await exportToHubIfEnabled({
        type: "risk.session.action.applied",
        ts: nowISO(),
        source: SRC,
        data,
      });
    }
    return !!ok;
  } catch (_) {
    return false;
  }
}

async function safeExtend(session, ctx, minutes, reason) {
  if (!SessionControl || typeof SessionControl.extend !== "function")
    return false;
  const min = Math.max(1, Number(minutes || 0));
  // Respect constraints: ensure the new end time remains allowed
  const newEndISO = addMinutesISO(
    (session.live && session.live.expectedEndISO) || session.plannedEndISO,
    min
  );
  if (
    !(await allowedAtWindow(
      session,
      session.plannedStartISO || nowISO(),
      newEndISO
    ))
  )
    return false;

  try {
    const ok = await SessionControl.extend({
      id: sid(session),
      minutes: min,
      reason,
    });
    if (ok) {
      const data = {
        sessionId: sid(session),
        action: "extend",
        minutes: min,
        reason,
      };
      emit("risk.session.action.applied", data);
      await exportToHubIfEnabled({
        type: "risk.session.action.applied",
        ts: nowISO(),
        source: SRC,
        data,
      });
    }
    return !!ok;
  } catch (_) {
    return false;
  }
}

async function safeSplit(session, minutes, reason) {
  if (!SessionControl || typeof SessionControl.split !== "function")
    return false;
  const min = Math.max(5, Number(minutes || 0));
  try {
    const ok = await SessionControl.split({
      id: sid(session),
      remainingMinutes: min,
      reason,
    });
    if (ok) {
      const data = {
        sessionId: sid(session),
        action: "split",
        remainingMinutes: min,
        reason,
      };
      emit("risk.session.action.applied", data);
      await exportToHubIfEnabled({
        type: "risk.session.action.applied",
        ts: nowISO(),
        source: SRC,
        data,
      });
    }
    return !!ok;
  } catch (_) {
    return false;
  }
}

async function safeAbort(session, reason) {
  if (!SessionControl || typeof SessionControl.abort !== "function")
    return false;
  try {
    const ok = await SessionControl.abort({
      id: sid(session),
      reason: reason || "risk-abort",
    });
    if (ok) {
      const data = {
        sessionId: sid(session),
        action: "abort",
        reason: reason || "risk-abort",
      };
      emit("risk.session.aborted", data);
      await exportToHubIfEnabled({
        type: "risk.session.aborted",
        ts: nowISO(),
        source: SRC,
        data,
      });
    }
    return !!ok;
  } catch (_) {
    return false;
  }
}

async function trySimplify(session, opts) {
  if (!OptionsEngine) return null;
  const fn = OptionsEngine.simplifyVariant || OptionsEngine.simplify || null;
  if (!fn) return null;
  try {
    const res = await fn({
      session,
      intent: opts.intent,
      maxReductionPercent: opts.maxReductionPercent,
      dryRun: false,
    });
    if (res && res.accepted) {
      const data = {
        sessionId: sid(session),
        action: "simplify",
        variant: res.variant,
        intent: opts.intent,
      };
      emit("risk.session.action.applied", data);
      await exportToHubIfEnabled({
        type: "risk.session.action.applied",
        ts: nowISO(),
        source: SRC,
        data,
      });
      return { ok: true, variant: res.variant };
    }
  } catch (_) {}
  return null;
}

async function tryShedNonCritical(session, ctx, reason) {
  if (
    !priorities ||
    typeof priorities.scoreSessions !== "function" ||
    !LiveSessionStore
  )
    return false;
  let others = [];
  try {
    others = await LiveSessionStore.getActive();
  } catch (_) {}
  others = Array.isArray(others)
    ? others.filter((s) => sid(s) !== sid(session))
    : [];
  if (!others.length) return false;

  // Score and find lowest-priority non-hard session to pause
  let scored = [];
  try {
    scored = await priorities.scoreSessions(others);
  } catch (_) {
    scored = others.map((s) => ({ session: s, score: 0 }));
  }
  scored.sort((a, b) => a.score - b.score);
  const candidate = scored.find(
    (x) => !(x.session && x.session.policy && x.session.policy.hard)
  );
  if (!candidate) return false;

  return await safePause(candidate.session, reason);
}

// ---------- risk scoring ----------

const MINUTE = 60000;
const SRC = "runtime.controllers.RiskController";

/**
 * Build a lightweight runtime context for risk scoring.
 */
async function buildContext(session) {
  const now = Date.now();
  const startT = Date.parse(
    (session.live && session.live.startedAtISO) ||
      session.plannedStartISO ||
      session.suggestedStartISO ||
      session.deadlineISO ||
      nowISO()
  );
  const expEndT = Date.parse(
    (session.live && session.live.expectedEndISO) ||
      session.plannedEndISO ||
      addMinutesISO(
        new Date(startT).toISOString(),
        Number(session.estimatedMinutes || 0)
      )
  );

  // Buffers (policy-driven)
  let beforeMs = 0,
    afterMs = 0;
  try {
    if (
      buffersPolicy &&
      typeof buffersPolicy.getRecommendedBuffer === "function"
    ) {
      const rec = buffersPolicy.getRecommendedBuffer(
        session.domain || "general",
        session.meta && session.meta.kind
      );
      beforeMs = Number((rec && rec.beforeMs) || 0);
      afterMs = Number((rec && rec.afterMs) || 0);
    }
  } catch (_) {}

  // Constraint snapshot
  let disallowedNow = false;
  try {
    if (constraints && typeof constraints.isAllowed === "function") {
      disallowedNow = !(await constraints.isAllowed(session, {
        nowISO: nowISO(),
      }));
    }
  } catch (_) {}

  // Inventory drift
  let drift = { low: false, missing: false };
  try {
    if (Inventory && typeof Inventory.driftSinceReservation === "function") {
      const d = await Inventory.driftSinceReservation(sid(session));
      drift.low = !!(d && d.low && d.low.length);
      drift.missing = !!(d && d.missing && d.missing.length);
    }
  } catch (_) {}

  // Equipment state (optional sensors)
  let sensors = { overheat: false, offline: false };
  try {
    const eq = Array.isArray(session.equipment) ? session.equipment : [];
    if (
      Storehouse &&
      typeof Storehouse.sensorSnapshot === "function" &&
      eq.length
    ) {
      const snap = await Storehouse.sensorSnapshot(eq);
      sensors.overheat = !!(snap && snap.anyOverheat);
      sensors.offline = !!(snap && snap.anyOffline);
    }
  } catch (_) {}

  // Progress estimation
  const elapsedMin = Math.max(0, Math.round((now - startT) / MINUTE));
  const estMin = Number(session.estimatedMinutes || 0);
  const expectedProgress = Math.min(
    100,
    estMin > 0 ? Math.round((elapsedMin / estMin) * 100) : 0
  );
  const observedProgress = Number(
    (session.live && session.live.progressPct) || session.progressPct || 0
  );
  const behindBy = Math.max(
    0,
    Math.round(((expectedProgress - observedProgress) * estMin) / 100)
  );

  return {
    time: {
      nowISO: nowISO(),
      startISO: new Date(startT).toISOString(),
      expEndISO: new Date(expEndT).toISOString(),
    },
    buffers: { preBeforeMs: beforeMs, postAfterMs: afterMs },
    constraints: { disallowedNow },
    inventory: drift,
    sensors,
    progress: {
      elapsedMin: elapsedMin,
      expectedProgressPct: expectedProgress,
      observedProgressPct: observedProgress,
      behindByMinutes: behindBy,
    },
  };
}

/**
 * Produce a stable risk score with flags that drive actions.
 */
function scoreRisk(session, ctx) {
  // Base risk indicators
  const latenessMin = ctx.progress.behindByMinutes;
  const inventoryRisk = ctx.inventory.missing ? 2 : ctx.inventory.low ? 1 : 0;
  const sensorRisk = ctx.sensors.overheat ? 2 : ctx.sensors.offline ? 1 : 0;
  const constraintRisk = ctx.constraints.disallowedNow ? 2 : 0;

  // Combine with buffers (less pre-buffer -> higher risk)
  const preMin = Math.round(ctx.buffers.preBeforeMs / MINUTE);
  const bufferPenalty = preMin < 5 ? 2 : preMin < 10 ? 1 : 0;

  const score =
    (latenessMin >= 15 ? 2 : latenessMin >= 5 ? 1 : 0) +
    inventoryRisk +
    sensorRisk +
    constraintRisk +
    bufferPenalty;

  const flags = {
    unsafe: ctx.sensors.overheat || constraintRisk >= 2,
    lowInventory: ctx.inventory.low || ctx.inventory.missing,
    behind: latenessMin >= 5,
  };

  let level = "low";
  if (score >= 4) level = "high";
  else if (score >= 2) level = "moderate";

  return { value: score, level, flags };
}

// ---------- guards & utilities ----------

async function allowedAtWindow(session, startISO, endISO) {
  if (!constraints || typeof constraints.isAllowed !== "function") return true;
  try {
    return !!(await constraints.isAllowed(session, {
      nowISO: nowISO(),
      startISO,
      endISO,
    }));
  } catch (_) {
    return true;
  }
}

function sid(s) {
  return s && (s.id || s.sessionId);
}
function nowISO() {
  return new Date().toISOString();
}
function addMinutesISO(iso, min) {
  const t = Date.parse(iso || "");
  if (!isFinite(t)) return null;
  return new Date(t + Math.max(0, Number(min) || 0) * MINUTE).toISOString();
}

function minCtx(ctx) {
  return {
    time: ctx.time,
    inv: ctx.inventory,
    sens: ctx.sensors,
    prog: { behindByMinutes: ctx.progress.behindByMinutes },
    buf: { preBeforeMs: ctx.buffers.preBeforeMs },
  };
}

function normalizeArgs(args) {
  const a = args || {};
  const maxToInspect = Number(a.maxToInspect != null ? a.maxToInspect : 50);
  if (!isFinite(maxToInspect) || maxToInspect <= 0) return null;
  return {
    maxToInspect,
    allowStepSubstitution: flag(a.allowStepSubstitution, true),
    allowExtend: flag(a.allowExtend, true),
    allowPause: flag(a.allowPause, true),
    allowAbortOnUnsafe: flag(a.allowAbortOnUnsafe, true),
    allowThrottle: flag(a.allowThrottle, true),
    timezone: a.timezone || "America/Chicago",
  };
}

function flag(v, def) {
  return v != null ? !!v : !!def;
}

function pick(obj, keys) {
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
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
  } catch (_) {
    return null;
  }
}

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: nowISO(), source: SRC, data });
  } catch (_) {}
}

async function exportToHubIfEnabled(payload) {
  if (!featureFlags || !featureFlags.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = await (HubPacketFormatter.format
      ? HubPacketFormatter.format(payload)
      : payload);
    if (FamilyFundConnector && typeof FamilyFundConnector.send === "function") {
      await FamilyFundConnector.send(packet);
    }
  } catch (_) {
    // fail silently by requirement
  }
}
