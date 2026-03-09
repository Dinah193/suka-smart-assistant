// C:\Users\larho\suka-smart-assistant\src\runtime\jobs\learningLoopNightly.job.js
// SSA Runtime - Job: Nightly Learning/Calibration Updates
// -----------------------------------------------------------------------------
// Role in pipeline:
//   imports -> intelligence -> automation -> (optional) hub export
//   - Consumes recorded “actuals” from the scheduling/execution loop.
//   - Updates per-domain correction factors (time, prep, cleanup) and
//     recommended buffers (before/after/total) via learningLoop/updateModels.
//   - Emits learning events that analytics and the planner consume next day.
//   - If enabled (familyFundMode), mirrors the “models.updated” rollup to the Hub.
//
// Events (all payloads follow { type, ts, source, data }):
//   - learning.models.update.started
//   - learning.models.update.skipped
//   - learning.models.update.failed
//   - learning.models.updated          <-- main success signal
//
// Defensive design:
//   - All external dependencies are optional and guarded.
//   - Input validation + early returns.
//   - Silent Hub export failure by requirement.

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

// Learning loop engine (expected to exist from earlier files)
let updateModels = null; // expected: nightlyUpdate({ lookbackDays, minObservations, dryRun, maxPerDomain })
try {
  updateModels = require("@/engines/scheduling/learningLoop/updateModels");
} catch (_) {}

// Optional stores/services (defensive)
let ActualsStore = null; // expected: countInWindow(startISO,endISO)
try {
  ActualsStore = require("@/engines/scheduling/learningLoop/ActualsStore");
} catch (_) {}

let HubPacketFormatter = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
} catch (_) {}
let FamilyFundConnector = null;
try {
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch (_) {}

module.exports = {
  /**
   * Run nightly learning model refresh.
   * @param {Object} args
   * @param {number} [args.lookbackDays=30]          // days of actuals to consider
   * @param {number} [args.minObservations=5]        // floor per domain-kind before updating
   * @param {boolean} [args.dryRun=false]            // calculate but do not persist
   * @param {number} [args.maxPerDomain=5000]        // cap rows per domain to scan
   * @param {string} [args.timezone="America/Chicago"]
   */
  async nightlyUpdate(args) {
    const cfg = normalizeArgs(args);
    if (!cfg) {
      emit("learning.models.update.skipped", { reason: "invalid-args" });
      return { ok: false, reason: "invalid-args" };
    }

    const window = computeWindow(cfg.lookbackDays);
    emit("learning.models.update.started", {
      lookbackDays: cfg.lookbackDays,
      windowStartISO: window.startISO,
      windowEndISO: window.endISO,
      dryRun: !!cfg.dryRun,
      minObservations: cfg.minObservations,
    });

    // Optional: sanity check that we actually have data to learn from
    if (ActualsStore && typeof ActualsStore.countInWindow === "function") {
      try {
        const n = await ActualsStore.countInWindow(
          window.startISO,
          window.endISO
        );
        if (!isFinite(n) || n < cfg.minObservations) {
          emit("learning.models.update.skipped", {
            reason: "insufficient-actuals",
            count: isFinite(n) ? n : 0,
            minObservations: cfg.minObservations,
          });
          return {
            ok: true,
            skipped: true,
            reason: "insufficient-actuals",
            count: isFinite(n) ? n : 0,
          };
        }
      } catch (_) {
        // If the store check fails, proceed anyway; the learning engine will decide.
      }
    }

    if (!updateModels || typeof updateModels.nightlyUpdate !== "function") {
      emit("learning.models.update.failed", {
        error: "learning-engine-missing",
      });
      return { ok: false, error: "learning-engine-missing" };
    }

    try {
      // Delegate to the learning engine; contract returns a rollup describing updates
      const rollup = await updateModels.nightlyUpdate({
        lookbackDays: cfg.lookbackDays,
        minObservations: cfg.minObservations,
        dryRun: !!cfg.dryRun,
        maxPerDomain: cfg.maxPerDomain,
      });

      // Expect rollup like:
      // {
      //   updatedAtISO, window:{startISO,endISO,days},
      //   domains:[{domain, kinds:[{kind, n, corrections:{...}, buffers:{...}}]}],
      //   totals:{observations, domains, kinds, updated}
      // }
      emit("learning.models.updated", {
        rollup: coerceRollup(rollup, window, cfg),
      });

      // Optional Hub mirror
      await exportToHubIfEnabled({
        type: "learning.models.updated",
        ts: new Date().toISOString(),
        source: "runtime.jobs.learningLoopNightly",
        data: rollup || {
          updatedAtISO: new Date().toISOString(),
          window: {
            startISO: window.startISO,
            endISO: window.endISO,
            days: cfg.lookbackDays,
          },
          totals: {
            observations: null,
            domains: null,
            kinds: null,
            updated: null,
          },
        },
      });

      return { ok: true, updated: safeTotals(rollup) };
    } catch (err) {
      emit("learning.models.update.failed", {
        error: String((err && err.message) || err || "unknown"),
      });
      return {
        ok: false,
        error: String((err && err.message) || err || "unknown"),
      };
    }
  },
};

// --------------------------------- helpers ---------------------------------

function normalizeArgs(args) {
  const lookbackDays = Number(
    (args && args.lookbackDays) != null ? args.lookbackDays : 30
  );
  const minObservations = Number(
    (args && args.minObservations) != null ? args.minObservations : 5
  );
  const dryRun = !!((args && args.dryRun) != null ? args.dryRun : false);
  const maxPerDomain = Number(
    (args && args.maxPerDomain) != null ? args.maxPerDomain : 5000
  );
  const timezone = (args && args.timezone) || "America/Chicago";
  if (!isFinite(lookbackDays) || lookbackDays <= 0) return null;
  if (!isFinite(minObservations) || minObservations < 0) return null;
  if (!isFinite(maxPerDomain) || maxPerDomain <= 0) return null;
  return { lookbackDays, minObservations, dryRun, maxPerDomain, timezone };
}

function computeWindow(lookbackDays) {
  const end = new Date(); // now
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function coerceRollup(rollup, window, cfg) {
  // Ensure a minimal well-known shape for downstream consumers
  const r = rollup || {};
  if (!r.window)
    r.window = {
      startISO: window.startISO,
      endISO: window.endISO,
      days: cfg.lookbackDays,
    };
  if (!r.updatedAtISO) r.updatedAtISO = new Date().toISOString();
  if (!Array.isArray(r.domains)) r.domains = [];
  if (!r.totals)
    r.totals = {
      observations: null,
      domains: r.domains.length,
      kinds: null,
      updated: null,
    };
  return r;
}

function safeTotals(rollup) {
  try {
    return rollup && rollup.totals ? rollup.totals.updated : null;
  } catch (_) {
    return null;
  }
}

function emit(type, data) {
  try {
    eventBus.emit({
      type: type,
      ts: new Date().toISOString(),
      source: "runtime.jobs.learningLoopNightly",
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
    // fail silently by requirement
  }
}
