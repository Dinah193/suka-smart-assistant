// File: C:\Users\larho\suka-smart-assistant\src\workers\calibration.worker.js

/* eslint-disable no-restricted-globals */
/**
 * Nightly Calibration Worker — learning loop
 * -----------------------------------------------------------------------------
 * Purpose
 *  - At a scheduled nightly time window, learn from historical session runs
 *    and update planning calibration (bias/variance/quantiles) per domain.
 *
 * Pipeline fit (imports → intelligence → automation → (optional) hub export)
 *  - Imports & runtime generate execution logs → analytics/history store.
 *  - This worker (intelligence) pulls summaries, learns new calibration
 *    parameters, and emits:
 *      • analytics.calibration.result          (readout for dashboards)
 *      • calibration.model.update              (command to planners)  ⚠ mutates future plans
 *      • calibration.nightly.completed         (audit + observability)
 *  - Since calibration changes household planning behavior, we optionally export
 *    changes to the Hub (Family Fund) via exportToHubIfEnabled(payload).
 *
 * Forward-thinking
 *  - Domain-agnostic; supports cooking/cleaning/garden/animals/storehouse/preservation.
 *  - Pluggable learners: strategies map with extensible algorithms.
 *  - Defensive: tolerant of partial data and downstream failures.
 */

import eventBus from "../services/events/eventBus";
import featureFlags from "../config/featureFlags";
import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

// ---------------------------------------------------------------------------
// Constants & simple helpers
// ---------------------------------------------------------------------------
const SOURCE = "worker.calibration";
const MILLIS_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_NIGHTLY_HOUR = 2; // 02:00 local time
const DEFAULT_LOOKBACK_DAYS = 30; // learn from past 30 days by default

const nowISO = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toNum = (n, d = 0) => (Number.isFinite(+n) ? +n : d);

// Domains handled; 'all' means aggregate across everything (usually not applied)
const DOMAINS = [
  "cooking",
  "cleaning",
  "garden",
  "animals",
  "storehouse",
  "preservation",
];

/**
 * Hub export — only for commands that change household planning behavior.
 * Fail silently if Hub is unavailable; SSA still owns the data first.
 */
function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  try {
    const pkt = HubPacketFormatter.format(payload);
    FamilyFundConnector.send(pkt);
  } catch {
    // optional plumbing; ignore failure
  }
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------
/**
 * The worker fetches historical analytics via either:
 *  1) Optional analyticsService (if present), or
 *  2) Request/response over eventBus:
 *      -> analytics.history.request   {from, to, domain}
 *      <- analytics.history.result    {runs:[{estimateMin, actualMin, ...}]}
 */
let svc = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  svc = require("../services/analyticsService").default;
} catch {
  // service is optional; fall back to bus
}

async function fetchHistoryWindow({ fromISO, toISO, domain }) {
  if (svc?.getHistory) {
    const res = await svc.getHistory({ from: fromISO, to: toISO, domain });
    return Array.isArray(res?.runs) ? res.runs : [];
  }
  return new Promise((resolve) => {
    const req = {
      type: "analytics.history.request",
      ts: nowISO(),
      source: SOURCE,
      data: { from: fromISO, to: toISO, domain },
    };
    const off = eventBus.on("analytics.history.result", (e) => {
      try {
        off?.();
      } catch {}
      resolve(Array.isArray(e?.data?.runs) ? e.data.runs : []);
    });
    eventBus.emit(req.type, req);
    setTimeout(() => {
      try {
        off?.();
      } catch {}
      resolve([]);
    }, 5000);
  });
}

// ---------------------------------------------------------------------------
// Learners (strategies) — pluggable algorithms
// ---------------------------------------------------------------------------
/**
 * Each learner returns a calibration object:
 * {
 *   strategy: 'proportional_bias' | 'offset_minutes' | 'quantile_fit' | <custom>,
 *   params: { ... },       // strategy-specific parameters
 *   metrics: { bias, variance, p50, p90, sampleSize }
 * }
 *
 * Input runs rows: { estimateMin:number, actualMin:number, ... }
 */
const strategies = {
  proportional_bias(runs) {
    const m = computeMetrics(runs);
    // Apply a capped proportional bias from mean signed error
    const factor = clamp(m.bias, -0.5, 0.8); // allow down to -50% up to +80%
    return {
      strategy: "proportional_bias",
      params: { factor },
      metrics: m,
    };
  },
  offset_minutes(runs) {
    const m = computeMetrics(runs);
    // Use median absolute error as a robust offset suggestion
    const absErr = runs.map((r) =>
      Math.abs(toNum(r.actualMin) - toNum(r.estimateMin))
    );
    const offset = Math.round(percentile(absErr, 50));
    return {
      strategy: "offset_minutes",
      params: { offset },
      metrics: m,
    };
  },
  quantile_fit(runs, targetP90 = 0.85) {
    const m = computeMetrics(runs);
    // Scale estimates so that p90 error ≈ target (under 1 means underestimation)
    const scale = safeQuantileScale(runs, targetP90);
    return {
      strategy: "quantile_fit",
      params: { targetP90, scale },
      metrics: m,
    };
  },
};

/**
 * Compute bias/variance/quantiles from runs.
 * bias: mean((actual - estimate)/max(estimate,1))
 * variance: variance of signed % error
 * p50/p90: percentiles of signed % error
 */
function computeMetrics(runs = []) {
  const clean = runs
    .map((r) => ({
      est: Math.max(1, toNum(r.estimateMin)), // avoid division by 0
      act: Math.max(0, toNum(r.actualMin)),
    }))
    .filter((r) => Number.isFinite(r.est) && Number.isFinite(r.act));

  const n = clean.length;
  if (!n) return { bias: 0, variance: 0, p50: 0, p90: 0, sampleSize: 0 };

  const errors = clean.map((r) => (r.act - r.est) / r.est);
  const bias = errors.reduce((a, b) => a + b, 0) / n;
  const mean = bias;
  const variance =
    errors.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
    Math.max(1, n - 1);
  const p50 = percentile(errors, 50);
  const p90 = percentile(errors, 90);

  return { bias, variance, p50, p90, sampleSize: n };
}

function percentile(arr, p) {
  if (!arr?.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = clamp((p / 100) * (sorted.length - 1), 0, sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return lo === hi ? sorted[lo] : sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function safeQuantileScale(runs, targetP90 = 0.85) {
  const errors = runs
    .map((r) => {
      const est = Math.max(1, toNum(r.estimateMin));
      const act = Math.max(0, toNum(r.actualMin));
      return (act - est) / est;
    })
    .filter((e) => Number.isFinite(e));
  if (!errors.length) return 1.0;
  const currentP90 = percentile(errors, 90);
  // Positive error means underestimation; reduce it toward target
  const desired = targetP90;
  const delta = desired - currentP90;
  // Map desired p90 error to a multiplicative scale on estimates
  // If currentP90 = 0.30 and desired = 0.15, scale ≈ est*(1+0.15)/(1+0.30)
  const scale =
    (1 + Math.max(-0.8, Math.min(1.5, desired))) /
    (1 + Math.max(-0.8, Math.min(1.5, currentP90)));
  return clamp(scale, 0.4, 2.0);
}

// ---------------------------------------------------------------------------
// Nightly scheduler
// ---------------------------------------------------------------------------
let intervalHandle = null;
let armedTimeout = null;
let running = false;

function scheduleNextNightly(hour = DEFAULT_NIGHTLY_HOUR) {
  clearTimeout(armedTimeout);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setTime(next.getTime() + MILLIS_DAY);
  const delay = next.getTime() - now.getTime();
  armedTimeout = setTimeout(runNightlyCycle, delay);
  telemetry("scheduler.armed", { fireAt: next.toISOString(), delayMs: delay });
}

function start({ nightlyHour = DEFAULT_NIGHTLY_HOUR } = {}) {
  if (running) return;
  running = true;
  // Align the first run to the nightly hour
  scheduleNextNightly(nightlyHour);

  // Safety net: if host wants a periodic guard, set a 12h ping
  clearInterval(intervalHandle);
  intervalHandle = setInterval(
    () => telemetry("scheduler.ping", {}),
    12 * 60 * 60 * 1000
  );

  wireEventShortcuts();
}

function stop() {
  running = false;
  try {
    clearTimeout(armedTimeout);
  } catch {}
  try {
    clearInterval(intervalHandle);
  } catch {}
  armedTimeout = null;
  intervalHandle = null;
  unwireEventShortcuts();
}

// ---------------------------------------------------------------------------
// Core nightly cycle
// ---------------------------------------------------------------------------
async function runNightlyCycle() {
  const startedAt = nowISO();
  telemetry("nightly.begin", { startedAt });

  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - DEFAULT_LOOKBACK_DAYS);

  // Learn for each domain independently
  const results = [];
  for (const domain of DOMAINS) {
    const runs = await fetchHistoryWindow({
      fromISO: from.toISOString(),
      toISO: to.toISOString(),
      domain,
    });

    // Pick a strategy per domain (extensible)
    // - preservation: quantile_fit
    // - animals: proportional_bias
    // - others: proportional_bias with fallback to offset_minutes if tiny sample
    const stratKey =
      domain === "preservation"
        ? "quantile_fit"
        : domain === "animals"
        ? "proportional_bias"
        : "proportional_bias";

    const strat = strategies[stratKey] || strategies.proportional_bias;
    const learned =
      stratKey === "quantile_fit"
        ? strat(runs, 0.85)
        : runs.length >= 8
        ? strat(runs)
        : strategies.offset_minutes(runs);

    const out = {
      domain,
      strategy: learned.strategy,
      params: learned.params,
      metrics: learned.metrics,
      window: { from: from.toISOString(), to: to.toISOString() },
    };
    results.push(out);

    // Emit analytics readout
    safeEmit({
      type: "analytics.calibration.result",
      ts: nowISO(),
      source: SOURCE,
      data: out,
    });

    // Issue model update command (planner will persist & bump version)
    const updateCmd = {
      type: "calibration.model.update",
      ts: nowISO(),
      source: SOURCE,
      data: {
        strategy: out.strategy,
        domain,
        params: out.params,
        metrics: out.metrics,
        window: out.window,
        reason: "nightly_learning",
      },
    };
    safeEmit(updateCmd);
    exportToHubIfEnabled(updateCmd);
  }

  // Final completion event (batch)
  safeEmit({
    type: "calibration.nightly.completed",
    ts: nowISO(),
    source: SOURCE,
    data: {
      ranAt: startedAt,
      results,
      domains: DOMAINS,
    },
  });

  // Arm the next run
  scheduleNextNightly(DEFAULT_NIGHTLY_HOUR);
}

// ---------------------------------------------------------------------------
// Event shortcuts (manual triggers)
// ---------------------------------------------------------------------------
const offFns = [];

function wireEventShortcuts() {
  // Allow admin/ops to trigger learning on demand
  offFns.push(
    eventBus.on("calibration.nightly.run", async (e) => {
      const d = e?.data || {};
      if (d?.domains && Array.isArray(d.domains)) {
        // restrict to requested domains
        await runNightlySubset(d.domains);
      } else {
        await runNightlyCycle();
      }
    }),
    eventBus.on("calibration.inspect", async (e) => {
      // Returns a dry-run analytics.calibration.result for the requested domain/window
      const d = e?.data || {};
      const domain = d.domain || "cooking";
      const to = new Date(d.to || Date.now());
      const from = new Date(
        d.from || to.getTime() - DEFAULT_LOOKBACK_DAYS * MILLIS_DAY
      );
      const runs = await fetchHistoryWindow({
        fromISO: from.toISOString(),
        toISO: to.toISOString(),
        domain,
      });
      const m = computeMetrics(runs);
      safeEmit({
        type: "analytics.calibration.result",
        ts: nowISO(),
        source: SOURCE,
        data: {
          domain,
          strategy: "inspect_only",
          params: {},
          metrics: m,
          window: { from: from.toISOString(), to: to.toISOString() },
        },
      });
    })
  );
}

function unwireEventShortcuts() {
  while (offFns.length) {
    try {
      const off = offFns.pop();
      off?.();
    } catch {
      // ignore
    }
  }
}

async function runNightlySubset(domains) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - DEFAULT_LOOKBACK_DAYS);

  for (const domain of domains) {
    const runs = await fetchHistoryWindow({
      fromISO: from.toISOString(),
      toISO: to.toISOString(),
      domain,
    });
    const learned = strategies.proportional_bias(runs);
    const out = {
      domain,
      strategy: learned.strategy,
      params: learned.params,
      metrics: learned.metrics,
      window: { from: from.toISOString(), to: to.toISOString() },
    };
    safeEmit({
      type: "analytics.calibration.result",
      ts: nowISO(),
      source: SOURCE,
      data: out,
    });
    const updateCmd = {
      type: "calibration.model.update",
      ts: nowISO(),
      source: SOURCE,
      data: {
        strategy: out.strategy,
        domain,
        params: out.params,
        metrics: out.metrics,
        window: out.window,
        reason: "manual_subset",
      },
    };
    safeEmit(updateCmd);
    exportToHubIfEnabled(updateCmd);
  }

  safeEmit({
    type: "calibration.nightly.completed",
    ts: nowISO(),
    source: SOURCE,
    data: { ranAt: nowISO(), results: [], domains },
  });
}

// ---------------------------------------------------------------------------
// Safe emit + telemetry
// ---------------------------------------------------------------------------
function safeEmit(payload) {
  try {
    eventBus.emit(payload.type, payload);
  } catch {
    // worker should be resilient
  }
  telemetry("emit", { type: payload.type });
}

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

// ---------------------------------------------------------------------------
// Web Worker host interop (optional)
// ---------------------------------------------------------------------------
/**
 * If executed inside a real Web Worker, allow host messages:
 *  - { cmd: 'start', nightlyHour?: number }
 *  - { cmd: 'stop' }
 *  - { cmd: 'runNow' }
 *  - { cmd: 'inspect', domain, from?, to? }
 */
try {
  if (
    typeof self !== "undefined" &&
    typeof self.addEventListener === "function"
  ) {
    self.addEventListener("message", (ev) => {
      const msg = ev?.data || {};
      switch (msg.cmd) {
        case "start":
          start({ nightlyHour: toNum(msg.nightlyHour, DEFAULT_NIGHTLY_HOUR) });
          break;
        case "stop":
          stop();
          break;
        case "runNow":
          runNightlyCycle();
          break;
        case "inspect":
          eventBus.emit("calibration.inspect", {
            type: "calibration.inspect",
            ts: nowISO(),
            source: SOURCE,
            data: { domain: msg.domain, from: msg.from, to: msg.to },
          });
          break;
        default:
          // Proxy unknown typed messages onto the bus
          if (msg.type) {
            try {
              eventBus.emit(msg.type, msg);
            } catch {}
          }
      }
    });
  }
} catch {
  // Not in worker host; ignore
}

// ---------------------------------------------------------------------------
// Auto-start by default (can be disabled by not importing this module)
// ---------------------------------------------------------------------------
start();

// Export control for SSR/tests
export default { start, stop };
