// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\riskController\policy.js
/**
 * Scheduling Risk Controller — Policy (thresholds & triggers)
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 *   imports → intelligence (estimators/calibration) → automation (plans/resources)
 *   → gatekeeper (checks/contingencies) → risk controller (ETA, actions, policy)
 *   → (optional) hub export
 *
 * What this file does:
 *   - Centralizes risk thresholds and trigger logic for plans/windows.
 *   - Evaluates real-time signals (ETA drift, blocker checks, resource conflicts),
 *     and historical variability (P50/P90 duration) to fire typed triggers:
 *       • risk.late.soft / risk.late.hard
 *       • risk.p90.exceed (planned duration below P90)
 *       • risk.blockers.present
 *       • risk.conflicts.excess
 *       • risk.drift.escalate (plan-wide ETA slippage)
 *   - Computes risk scores per window and plan with domain-aware weights.
 *   - Emits structured events and optionally exports results to the Hub.
 *
 * Event payloads ({ type, ts, source, data }):
 *   - scheduling.risk.policy.evaluated
 *   - scheduling.risk.policy.triggered
 *   - scheduling.risk.policy.error
 *
 * Forward-thinking:
 *   - Policy is configurable at runtime; supports domain overrides and custom signals.
 *   - Historical stats provider is pluggable via dataGateway (falls back to in-memory).
 *   - Defensive and side-effect free (does not mutate plan); callers decide next actions.
 */

"use strict";

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[riskPolicy:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/featureFlags.json");
} catch {}

/** Optional data gateway (Dexie/IndexedDB/etc.) used for historical stats. */
let dataGateway = null;
try {
  dataGateway = require("@/services/dataGateway");
  dataGateway = dataGateway?.default || dataGateway;
} catch {}

/* --------------------------------- Helpers --------------------------------- */

const nowISO = () => new Date().toISOString();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const avg = (arr) => (arr.length ? sum(arr) / arr.length : 0);
const toMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function emit(type, source, data) {
  eventBus.emit({ type, ts: nowISO(), source, data });
}

/** Optional hub export — results only (no plan mutation) */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
    const FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
    const formatter = HubPacketFormatter?.default || HubPacketFormatter;
    const connector = FamilyFundConnector?.default || FamilyFundConnector;
    const packet = formatter.format("scheduling.risk.policy", payload);
    await connector.send(packet);
  } catch {
    // swallow
  }
}

/* ------------------------------ Policy Defaults ----------------------------- */
/**
 * Global defaults with domain-level overrides supported.
 * Units are minutes unless stated otherwise.
 */
let POLICY = Object.freeze({
  version: "1.0",
  // Drift thresholds (plan level, vs planned end or previous ETA)
  drift: {
    softMin: 10, // soft drift threshold
    hardMin: 30, // hard drift threshold
    escalateMin: 60, // emit risk.drift.escalate when beyond this
  },
  // Per-window lateness thresholds (ETA vs planned end)
  late: {
    softMin: 5,
    hardMin: 15,
  },
  // Resource conflicts
  conflicts: {
    maxAllowed: 0, // number of capacityUnmet/invalidWindow blockers tolerated
    warnAbove: 0, // warn when > warnAbove
  },
  // P90 protection — if planned duration < P90 * factor trigger exceed
  p90: {
    factor: 1.0, // if planned < P90 * factor → risk.p90.exceed
    minSamples: 5, // require at least N samples for confidence
  },
  // Risk scoring weights per signal
  scoring: {
    // base weights
    lateSoft: 0.5,
    lateHard: 1.0,
    p90Exceed: 0.7,
    blockers: 1.0,
    conflicts: 0.8,
    driftSoft: 0.4,
    driftHard: 0.8,
    driftEscalate: 1.2,
  },
  // Domain overrides (examples)
  domains: {
    cooking: {
      late: { softMin: 3, hardMin: 10 }, // time-sensitive plating
      p90: { factor: 0.9 }, // be safer than P90
    },
    preservation: {
      late: { softMin: 1, hardMin: 3 }, // safety-critical timing
      p90: { factor: 1.1 },
    },
    garden: {
      late: { softMin: 10, hardMin: 25 }, // flexible outdoors work
      p90: { factor: 0.8 },
    },
  },
});

/**
 * Update policy at runtime; shallow-merge with current policy and freeze.
 * Accepts domain overrides.
 */
function updatePolicy(partial) {
  if (!partial || typeof partial !== "object") return POLICY;
  POLICY = deepFreeze(mergeDeep(POLICY, partial));
  return POLICY;
}

/* --------------------------- Historical Stats Adapter ----------------------- */
/**
 * Returns an object with percentile stats for a given (domain, taskType).
 * Shape: { p50: number, p90: number, count: number }
 * - First tries dataGateway.analytics.getDurations(domain, taskType) → number[]
 * - Then tries dataGateway.kv.get("durations", `${domain}:${taskType}`)
 * - Falls back to empty.
 */
async function getDurationStats(domain = "generic", taskType = "any") {
  try {
    if (dataGateway?.analytics?.getDurations) {
      const arr = await dataGateway.analytics.getDurations(domain, taskType);
      return summarizeDurations(arr || []);
    }
    if (dataGateway?.kv?.get) {
      const arr =
        (await dataGateway.kv.get("durations", `${domain}:${taskType}`)) || [];
      return summarizeDurations(arr || []);
    }
  } catch {}
  return { p50: null, p90: null, count: 0 };
}

function summarizeDurations(arr) {
  const xs = (arr || []).filter(isNum).sort((a, b) => a - b);
  if (!xs.length) return { p50: null, p90: null, count: 0 };
  return {
    p50: percentile(xs, 0.5),
    p90: percentile(xs, 0.9),
    count: xs.length,
  };
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = clamp(p, 0, 1) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

/* --------------------------------- Evaluator -------------------------------- */
/**
 * Evaluate risk policy for a plan snapshot.
 *
 * @param {Object} req
 *  - planId: string
 *  - planStartISO?: string
 *  - planEndISO?: string              // planned end (or latest ETA if already updated)
 *  - windows: Array<{ id, domain?, startISO, endISO, etaISO?, status?, priority?, taskType? }>
 *  - issues?: Array                   // from gatekeeper/runChecks (blockers, etc.)
 *  - conflicts?: Array                // from resourceAllocator
 *  - export?: boolean                 // export results to Hub if familyFundMode
 *  - planMeta?: object
 *
 * @returns {Promise<{
 *   planId: string,
 *   planRiskScore: number,
 *   signals: { plan: Array, windows: Record<string, Array> },
 *   triggers: Array<{ code, level, scope, windowId?, meta }>,
 *   ts: string
 * }>}
 */
async function evaluatePolicy(req = {}) {
  const source = "engines/scheduling/riskController/policy.evaluatePolicy";

  try {
    const planId = String(req.planId || "").trim() || `ad-hoc-${Date.now()}`;
    const windows = Array.isArray(req.windows) ? req.windows.slice() : [];
    if (!windows.length) {
      emit("scheduling.risk.policy.error", source, {
        message: "No windows supplied",
        planId,
      });
      return emptyResult(planId);
    }

    // Conflicts/Issues
    const issues = Array.isArray(req.issues) ? req.issues.slice() : [];
    const conflicts = Array.isArray(req.conflicts) ? req.conflicts.slice() : [];

    // Build plan-level signals
    const plannedEndMs = toMs(req.planEndISO || inferPlannedEnd(windows));
    const latestEtaMs = inferLatestETAms(windows);
    const driftMin =
      isNum(plannedEndMs) && isNum(latestEtaMs)
        ? Math.round((latestEtaMs - plannedEndMs) / 60000)
        : 0;

    const planSignals = [];
    const triggers = [];
    // Drift triggers
    const dpol = POLICY.drift || {};
    if (isNum(driftMin) && driftMin >= (dpol.softMin ?? 10)) {
      planSignals.push({ code: "DRIFT_SOFT", value: driftMin });
      triggers.push({
        code: "risk.late.soft",
        level: "plan",
        scope: "plan",
        meta: { driftMin },
      });
    }
    if (isNum(driftMin) && driftMin >= (dpol.hardMin ?? 30)) {
      planSignals.push({ code: "DRIFT_HARD", value: driftMin });
      triggers.push({
        code: "risk.late.hard",
        level: "plan",
        scope: "plan",
        meta: { driftMin },
      });
    }
    if (isNum(driftMin) && driftMin >= (dpol.escalateMin ?? 60)) {
      planSignals.push({ code: "DRIFT_ESCALATE", value: driftMin });
      triggers.push({
        code: "risk.drift.escalate",
        level: "plan",
        scope: "plan",
        meta: { driftMin },
      });
    }

    // Conflicts triggers
    const conflictCount = conflicts.filter(
      (c) => c.type === "capacityUnmet" || c.type === "invalidWindow"
    ).length;
    const cpol = POLICY.conflicts || {};
    if (conflictCount > (cpol.warnAbove ?? 0)) {
      planSignals.push({ code: "CONFLICTS", value: conflictCount });
      triggers.push({
        code: "risk.conflicts.excess",
        level: "plan",
        scope: "plan",
        meta: { conflictCount },
      });
    }

    // Blockers triggers (from checks)
    const blockerCount = issues.filter((i) => i.severity === "blocker").length;
    if (blockerCount > 0) {
      planSignals.push({ code: "BLOCKERS", value: blockerCount });
      triggers.push({
        code: "risk.blockers.present",
        level: "plan",
        scope: "plan",
        meta: { blockerCount },
      });
    }

    // Per-window evaluation
    const windowSignals = {};
    const windowScores = new Map();

    for (const w of windows) {
      const domain = (w.domain || "generic").toLowerCase();
      const pol = withDomainOverrides(POLICY, domain);

      const signals = [];
      const plannedEnd = toMs(w.endISO);
      const eta = toMs(w.etaISO || w.endISO);
      const delayMin =
        isNum(plannedEnd) && isNum(eta)
          ? Math.round((eta - plannedEnd) / 60000)
          : 0;

      // Lateness
      if (delayMin >= (pol.late.softMin ?? 5)) {
        signals.push({ code: "LATE_SOFT", value: delayMin });
        triggers.push({
          code: "risk.late.soft",
          level: "window",
          scope: "window",
          windowId: w.id,
          meta: { delayMin },
        });
      }
      if (delayMin >= (pol.late.hardMin ?? 15)) {
        signals.push({ code: "LATE_HARD", value: delayMin });
        triggers.push({
          code: "risk.late.hard",
          level: "window",
          scope: "window",
          windowId: w.id,
          meta: { delayMin },
        });
      }

      // P90 exceed — check historical stats
      const durationPlannedMin = Math.max(
        1,
        Math.round(((plannedEnd || 0) - (toMs(w.startISO) || 0)) / 60000)
      );
      const stats = await getDurationStats(domain, String(w.taskType || "any"));
      if (isNum(stats.p90) && stats.count >= (pol.p90.minSamples ?? 5)) {
        const threshold = stats.p90 * (pol.p90.factor ?? 1.0);
        if (durationPlannedMin < threshold) {
          signals.push({
            code: "P90_EXCEED",
            planned: durationPlannedMin,
            p90: stats.p90,
            factor: pol.p90.factor ?? 1.0,
          });
          triggers.push({
            code: "risk.p90.exceed",
            level: "window",
            scope: "window",
            windowId: w.id,
            meta: {
              planned: durationPlannedMin,
              p90: stats.p90,
              factor: pol.p90.factor ?? 1.0,
              samples: stats.count,
            },
          });
        }
      }

      // Risk scoring
      const score = computeWindowRiskScore(
        signals,
        pol.scoring || POLICY.scoring
      );
      windowScores.set(w.id, score);
      windowSignals[w.id] = signals;
    }

    // Plan risk score: weighted sum
    const planRiskScore =
      computePlanRiskScore(planSignals, POLICY.scoring) +
      avg([...windowScores.values()]);

    const payload = {
      planId,
      planRiskScore: round1(planRiskScore),
      signals: { plan: planSignals, windows: windowSignals },
      triggers,
      planMeta: req.planMeta || {},
      ts: nowISO(),
    };

    emit("scheduling.risk.policy.evaluated", source, payload);

    // Emit a "triggered" event when there is at least one HARD signal
    const fired = triggers.filter(
      (t) =>
        t.code === "risk.late.hard" ||
        t.code === "risk.drift.escalate" ||
        t.code === "risk.blockers.present" ||
        t.code === "risk.conflicts.excess" ||
        t.code === "risk.p90.exceed"
    );
    if (fired.length) {
      emit("scheduling.risk.policy.triggered", source, {
        planId,
        triggers: fired,
        planRiskScore: payload.planRiskScore,
      });
    }

    if (req.export === true) {
      await exportToHubIfEnabled({
        action: "risk.policy.evaluated",
        ...payload,
      });
    }

    return payload;
  } catch (err) {
    emit(
      "scheduling.risk.policy.error",
      "engines/scheduling/riskController/policy.evaluatePolicy",
      {
        message: String(err?.message || err),
      }
    );
    return emptyResult(String(req?.planId || ""));
  }
}

/* -------------------------------- Internals -------------------------------- */

function emptyResult(planId) {
  return {
    planId,
    planRiskScore: 0,
    signals: { plan: [], windows: {} },
    triggers: [],
    ts: nowISO(),
  };
}

function withDomainOverrides(policy, domain) {
  const d =
    policy.domains && policy.domains[domain] ? policy.domains[domain] : {};
  return mergeDeep(policy, d);
}

function computeWindowRiskScore(signals, weights) {
  let score = 0;
  for (const s of signals) {
    switch (s.code) {
      case "LATE_SOFT":
        score += weights.lateSoft ?? 0.5;
        break;
      case "LATE_HARD":
        score += weights.lateHard ?? 1.0;
        break;
      case "P90_EXCEED":
        score += weights.p90Exceed ?? 0.7;
        break;
      default:
        break;
    }
  }
  return score;
}

function computePlanRiskScore(planSignals, weights) {
  let score = 0;
  for (const s of planSignals) {
    switch (s.code) {
      case "DRIFT_SOFT":
        score += weights.driftSoft ?? 0.4;
        break;
      case "DRIFT_HARD":
        score += weights.driftHard ?? 0.8;
        break;
      case "DRIFT_ESCALATE":
        score += weights.driftEscalate ?? 1.2;
        break;
      case "BLOCKERS":
        score += weights.blockers ?? 1.0;
        break;
      case "CONFLICTS":
        score += weights.conflicts ?? 0.8;
        break;
      default:
        break;
    }
  }
  return score;
}

function inferPlannedEnd(windows) {
  let maxISO = null;
  for (const w of windows) {
    if (!w?.endISO) continue;
    if (!maxISO || Date.parse(w.endISO) > Date.parse(maxISO)) maxISO = w.endISO;
  }
  return maxISO;
}

function inferLatestETAms(windows) {
  let maxMs = 0;
  for (const w of windows) {
    const t = toMs(w.etaISO || w.endISO);
    if (isNum(t)) maxMs = Math.max(maxMs, t);
  }
  return maxMs || null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/* ------------------------------- Small Utilities ---------------------------- */

function mergeDeep(target, src) {
  if (Array.isArray(target) || Array.isArray(src)) return src; // arrays: replace
  const out = { ...(target || {}) };
  for (const k of Object.keys(src || {})) {
    const v = src[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      out[k] = mergeDeep(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function deepFreeze(obj) {
  if (!obj || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return obj;
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  evaluatePolicy,
  updatePolicy,
  // for tests/ext
  _internals: {
    percentile,
    summarizeDurations,
    computeWindowRiskScore,
    computePlanRiskScore,
    inferPlannedEnd,
    inferLatestETAms,
  },
};
