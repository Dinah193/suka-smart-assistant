// C:\Users\larho\suka-smart-assistant\src\runtime\controllers\PlannerController.js
// SSA Runtime — Planner Controller
// -----------------------------------------------------------------------------
// Role in pipeline:
//   imports → intelligence → automation → (optional) hub export
//   - Entry point for compiling and (re)compiling plans on demand.
//   - Thin, defensive facade over scheduling jobs/handlers to keep UI/API
//     and automations decoupled from internal modules.
//   - Emits controller-scoped events and relays downstream job results.
//
// Exposed operations:
//   - compileToday(args?)           → build a day plan rollup (06:00 job on demand)
//   - quickRecalc(args?)            → re-evaluate next 3h (hourly job on demand)
//   - readinessSweep(args?)         → run readiness checks at T-x marks
//   - autoplanNow(args?)            → attempt placements for near-term deadlines
//   - previewTick()                 → lightweight priority snapshot (no commits)
//
// Events (payload shape: { type, ts, source, data }):
//   - planning.controller.* (this controller)
//   - Underlying jobs emit their own domain events as well.
//
// Hub export:
//   - If this controller triggers actions that *change household data*
//     (e.g., placements, queued preps), it invokes exportToHubIfEnabled(payload).
//   - Jobs already export when they change data; the controller will only export
//     if it directly causes a change that a job didn’t already mirror.
//
// -----------------------------------------------------------------------------

const path = require("path");

// --------- shared services (defensive requires) ----------
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

// --------- job modules (loaded defensively with requireSafe) ----------
const compileTodayJob = requireSafe("@/runtime/jobs/compileTodayPlan.job.js"); // .run(args)
const hourlyRecalcJob = requireSafe("@/runtime/jobs/hourlyRecalc.job.js"); // .run(args)
const readinessSweepJob = requireSafe("@/runtime/jobs/readinessSweep.job.js"); // .run(args)

// Optional handlers
const autoPlannerHandler = requireSafe(
  "@/runtime/jobs/handlers/autoPlanner.js"
); // .run(args)
const schedulerTickHandler = requireSafe(
  "@/runtime/jobs/handlers/schedulerTick.js"
); // .run(args)

// --------- public API ----------
module.exports = {
  /**
   * Compile today's plan (same logic as the 06:00 daily job).
   * Does NOT force commits beyond what the compile job normally does.
   * @param {Object} args optional overrides { timezone, windowStartLocal, windowEndLocal, maxGapFills }
   */
  async compileToday(args) {
    emit("planning.controller.compileToday.started", sanitizeArgs(args));
    ensureJob("compileToday", compileTodayJob, "run");

    try {
      const res = await compileTodayJob.run(args || {});
      emit("planning.controller.compileToday.completed", {
        ok: !!(res && res.ok),
        meta: shrink(res),
      });
      // compileTodayPlan.job emits and (optionally) exports on its own; no duplicate export here.
      return res || { ok: false };
    } catch (err) {
      emit("planning.controller.compileToday.failed", { error: msg(err) });
      return { ok: false, error: msg(err) };
    }
  },

  /**
   * Recalculate the next 3 hours and optionally place a few urgent sessions.
   * @param {Object} args { horizonMinutes=180, maxPlacements=3, timezone }
   */
  async quickRecalc(args) {
    emit("planning.controller.quickRecalc.started", sanitizeArgs(args));
    ensureJob("hourlyRecalc", hourlyRecalcJob, "run");

    try {
      const res = await hourlyRecalcJob.run(args || {});
      emit("planning.controller.quickRecalc.completed", {
        ok: !!(res && res.ok),
        meta: shrink(res),
      });

      // If placements occurred and the hourly job did not mirror (it normally does),
      // we still mirror a minimal rollup from the controller for redundancy.
      if (res && res.ok && Number(res.placed || 0) > 0) {
        await exportToHubIfEnabled({
          type: "planning.controller.quickRecalc.placements",
          ts: new Date().toISOString(),
          source: "runtime.controllers.PlannerController",
          data: { placed: res.placed, considered: res.considered },
        });
      }
      return res || { ok: false };
    } catch (err) {
      emit("planning.controller.quickRecalc.failed", { error: msg(err) });
      return { ok: false, error: msg(err) };
    }
  },

  /**
   * Run readiness sweep at T-x thresholds inside a scan window.
   * @param {Object} args { scanWindowMinutes=360, marksMinutes=[240,120,60,30,10], autoQueuePrep=true, autoReserveInventory=true }
   */
  async readinessSweep(args) {
    emit("planning.controller.readinessSweep.started", sanitizeArgs(args));
    ensureJob("readinessSweep", readinessSweepJob, "run");

    try {
      const res = await readinessSweepJob.run(args || {});
      emit("planning.controller.readinessSweep.completed", {
        ok: !!(res && res.ok),
        meta: shrink(res),
      });

      // If the sweep queued prep tasks or reservations, mirror a small summary (jobs also export).
      const changed =
        res &&
        res.ok &&
        ((res.prepsQueued || 0) > 0 || (res.reservations || 0) > 0);
      if (changed) {
        await exportToHubIfEnabled({
          type: "planning.controller.readinessSweep.delta",
          ts: new Date().toISOString(),
          source: "runtime.controllers.PlannerController",
          data: {
            prepsQueued: res.prepsQueued || 0,
            reservations: res.reservations || 0,
          },
        });
      }
      return res || { ok: false };
    } catch (err) {
      emit("planning.controller.readinessSweep.failed", { error: msg(err) });
      return { ok: false, error: msg(err) };
    }
  },

  /**
   * Attempt to place near-term sessions using feasibility/options/policies.
   * Controller-level shim over autoPlanner handler.
   * @param {Object} args { deadlineHorizonMinutes=240, maxPlacements=5, timezone }
   */
  async autoplanNow(args) {
    emit("planning.controller.autoplan.started", sanitizeArgs(args));
    ensureJob("autoPlanner", autoPlannerHandler, "run");

    // apply safe defaults if not provided
    const a = Object.assign(
      { deadlineHorizonMinutes: 240, maxPlacements: 5 },
      args || {}
    );
    try {
      const res = await autoPlannerHandler.run(a);
      emit("planning.controller.autoplan.completed", {
        ok: !!(res && res.ok),
        meta: shrink(res),
      });

      if (res && res.ok && Number(res.placed || 0) > 0) {
        await exportToHubIfEnabled({
          type: "planning.controller.autoplan.placements",
          ts: new Date().toISOString(),
          source: "runtime.controllers.PlannerController",
          data: { placed: res.placed, attempted: a.maxPlacements },
        });
      }
      return res || { ok: false };
    } catch (err) {
      emit("planning.controller.autoplan.failed", { error: msg(err) });
      return { ok: false, error: msg(err) };
    }
  },

  /**
   * Lightweight scheduler preview (no commits) for dashboards/UX.
   * Returns what the scheduler *would* consider right now.
   */
  async previewTick() {
    emit("planning.controller.previewTick.started", {});
    ensureJob("schedulerTick", schedulerTickHandler, "run");

    try {
      const res = await schedulerTickHandler.run({ emitPreviewOnly: true });
      emit("planning.controller.previewTick.completed", {
        ok: !!(res && res.ok),
        meta: shrink(res),
      });
      return res || { ok: false };
    } catch (err) {
      emit("planning.controller.previewTick.failed", { error: msg(err) });
      return { ok: false, error: msg(err) };
    }
  },
};

// --------- helpers ---------

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
    return null; // intentionally swallow; controller remains operable
  }
}

function ensureJob(name, mod, fnName) {
  if (!mod || typeof mod[fnName] !== "function") {
    throw new Error("job-missing:" + name);
  }
}

function sanitizeArgs(args) {
  if (!args) return {};
  // avoid logging large payloads or PII; copy select keys only
  const out = {};
  const keys = Object.keys(args);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = args[k];
    if (k.toLowerCase().indexOf("token") >= 0) continue;
    if (typeof v === "string" && v.length > 200) continue;
    out[k] = v;
  }
  return out;
}

function shrink(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const shallow = {};
  const allow = [
    "ok",
    "placed",
    "considered",
    "planCount",
    "inspected",
    "blockers",
    "prepsQueued",
    "reservations",
    "skipped",
    "reason",
  ];
  for (let i = 0; i < allow.length; i++) {
    const k = allow[i];
    if (Object.prototype.hasOwnProperty.call(obj, k)) shallow[k] = obj[k];
  }
  return shallow;
}

function msg(err) {
  return String((err && err.message) || err || "unknown");
}

function emit(type, data) {
  try {
    eventBus.emit({
      type: type,
      ts: new Date().toISOString(),
      source: "runtime.controllers.PlannerController",
      data: data,
    });
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
    // fail silently per requirement
  }
}
