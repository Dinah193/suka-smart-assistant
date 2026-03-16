"use strict";

const { createHash } = require("node:crypto");
const { pgPool } = require("./PlannerIntegrationService");

const DEFAULT_WINDOW_MS = Math.max(
  60000,
  Number(process.env.OPERATIONAL_OUTBOX_OBSERVABILITY_WINDOW_MS || 300000)
);
const MAX_EVENT_LOG = Math.max(
  100,
  Number(process.env.OPERATIONAL_OUTBOX_OBSERVABILITY_EVENT_LOG_MAX || 2000)
);
const MAX_SAMPLES = Math.max(
  100,
  Number(process.env.OPERATIONAL_OUTBOX_OBSERVABILITY_SAMPLES_MAX || 1000)
);
const ALERT_HOOK_DEDUPE_MS = Math.max(
  0,
  Number(process.env.OPERATIONAL_OUTBOX_ALERT_HOOK_DEDUPE_MS || 60000)
);
const ALERT_HOOK_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.OPERATIONAL_OUTBOX_ALERT_HOOK_TIMEOUT_MS || 5000)
);
const ALERT_HOOK_URLS = String(process.env.OPERATIONAL_OUTBOX_ALERT_WEBHOOK_URLS || "")
  .split(",")
  .map((x) => String(x || "").trim())
  .filter(Boolean);

const THRESHOLD_DEFAULTS = {
  pendingAgeWarnMs: Math.max(
    5000,
    Number(process.env.OPERATIONAL_OUTBOX_ALERT_PENDING_AGE_WARN_MS || 120000)
  ),
  pendingAgeCritMs: Math.max(
    5000,
    Number(process.env.OPERATIONAL_OUTBOX_ALERT_PENDING_AGE_CRIT_MS || 300000)
  ),
  deadLetterWarnCount: Math.max(
    0,
    Number(process.env.OPERATIONAL_OUTBOX_ALERT_DEAD_LETTER_WARN_COUNT || 1)
  ),
  deadLetterCritCount: Math.max(
    0,
    Number(process.env.OPERATIONAL_OUTBOX_ALERT_DEAD_LETTER_CRIT_COUNT || 5)
  ),
  staleLeaseWarnCount: Math.max(
    0,
    Number(process.env.OPERATIONAL_OUTBOX_ALERT_STALE_LEASE_WARN_COUNT || 1)
  ),
  staleLeaseCritCount: Math.max(
    0,
    Number(process.env.OPERATIONAL_OUTBOX_ALERT_STALE_LEASE_CRIT_COUNT || 3)
  ),
  retryRateWarn: Math.max(
    0,
    Math.min(1, Number(process.env.OPERATIONAL_OUTBOX_ALERT_RETRY_RATE_WARN || 0.1))
  ),
  retryRateCrit: Math.max(
    0,
    Math.min(1, Number(process.env.OPERATIONAL_OUTBOX_ALERT_RETRY_RATE_CRIT || 0.25))
  ),
};

const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"];
const configuredLevel = String(process.env.OPERATIONAL_OUTBOX_OBSERVABILITY_LOG_LEVEL || "info")
  .toLowerCase()
  .trim();
const EFFECTIVE_LOG_LEVEL = LOG_LEVELS.includes(configuredLevel) ? configuredLevel : "info";

const state = {
  startedAt: new Date().toISOString(),
  counters: {
    claimed: 0,
    processed: 0,
    retried: 0,
    deadLettered: 0,
    projectionFailures: 0,
    heartbeatRuns: 0,
    heartbeatRenewed: 0,
    heartbeatErrors: 0,
    batchRuns: 0,
    batchErrors: 0,
  },
  latencyMs: {
    projection: [],
    batch: [],
  },
  events: [],
  thresholdOverrides: {},
  alertDeliveries: [],
  lastAlertDispatchByKey: {},
};

const THRESHOLD_CONFIG_KEY = "global";
let thresholdsLoaded = false;
let thresholdsLoadPromise = null;

function nowIso() {
  return new Date().toISOString();
}

function trimArray(arr, max) {
  while (arr.length > max) arr.shift();
}

function logEnabled(level) {
  const idx = LOG_LEVELS.indexOf(EFFECTIVE_LOG_LEVEL);
  const want = LOG_LEVELS.indexOf(level);
  if (idx < 0 || want < 0) return false;
  if (EFFECTIVE_LOG_LEVEL === "silent") return false;
  return want <= idx;
}

function logStructured(level, eventType, details = {}) {
  if (!logEnabled(level)) return;
  const payload = {
    ts: nowIso(),
    level,
    scope: "operational_outbox",
    eventType,
    ...details,
  };
  if (level === "error") {
    console.error("[outbox.observe]", JSON.stringify(payload));
  } else if (level === "warn") {
    console.warn("[outbox.observe]", JSON.stringify(payload));
  } else {
    console.log("[outbox.observe]", JSON.stringify(payload));
  }
}

function pushEvent(type, details = {}) {
  const entry = {
    ts: nowIso(),
    type,
    ...details,
  };
  state.events.push(entry);
  trimArray(state.events, MAX_EVENT_LOG);
  return entry;
}

function pushLatencySample(kind, ms) {
  const value = Math.max(0, Number(ms || 0));
  if (!Number.isFinite(value)) return;
  state.latencyMs[kind].push(value);
  trimArray(state.latencyMs[kind], MAX_SAMPLES);
}

function percentile(samples, p) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx] || 0);
}

function getThresholds() {
  return {
    ...THRESHOLD_DEFAULTS,
    ...state.thresholdOverrides,
  };
}

function normalizeHookUrls(next = []) {
  const input = Array.isArray(next) ? next : ALERT_HOOK_URLS;
  const unique = new Set();
  for (const raw of input) {
    const url = String(raw || "").trim();
    if (!url) continue;
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    unique.add(url);
  }
  return Array.from(unique.values());
}

function buildAlertDispatchKey(payload = {}) {
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const normalizedAlerts = alerts.map((item = {}) => ({
    key: String(item.key || "unknown"),
    severity: String(item.severity || "unknown"),
    threshold: Number(item.threshold || 0),
    value: Number(item.value || 0),
  }));

  const shape = {
    householdId: payload.householdId == null ? null : String(payload.householdId),
    windowMs: Math.max(1000, Number(payload.windowMs || DEFAULT_WINDOW_MS)),
    alerts: normalizedAlerts,
  };

  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

function postJsonWithTimeout(url, body, timeoutMs = ALERT_HOOK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("alert_hook_timeout"));
    }, Math.max(100, Number(timeoutMs || ALERT_HOOK_TIMEOUT_MS)));

    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body || {}),
    })
      .then(async (res) => {
        const raw = await res.text().catch(() => "");
        if (!res.ok) {
          throw new Error(`alert_hook_http_${res.status}:${raw.slice(0, 160)}`);
        }
        resolve({ ok: true, status: res.status });
      })
      .catch((error) => {
        reject(error);
      })
      .finally(() => {
        clearTimeout(timer);
      });
  });
}

function normalizeThresholdOverrides(next = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(next || {})) {
    if (!(key in THRESHOLD_DEFAULTS)) continue;
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    normalized[key] = num;
  }
  return normalized;
}

async function ensureThresholdConfigTable() {
  await pgPool.query(`
    create table if not exists operational_outbox_observability_config (
      config_key text primary key,
      threshold_overrides jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
}

async function persistThresholdOverrides() {
  await ensureThresholdConfigTable();
  await pgPool.query(
    `
      insert into operational_outbox_observability_config (
        config_key,
        threshold_overrides,
        updated_at
      )
      values ($1, $2::jsonb, now())
      on conflict (config_key) do update
        set threshold_overrides = excluded.threshold_overrides,
            updated_at = now()
    `,
    [THRESHOLD_CONFIG_KEY, JSON.stringify(state.thresholdOverrides || {})]
  );
}

async function ensureThresholdOverridesLoaded() {
  if (thresholdsLoaded) return;
  if (thresholdsLoadPromise) {
    await thresholdsLoadPromise;
    return;
  }

  thresholdsLoadPromise = (async () => {
    try {
      await ensureThresholdConfigTable();
      const { rows } = await pgPool.query(
        `
          select threshold_overrides
          from operational_outbox_observability_config
          where config_key = $1
          limit 1
        `,
        [THRESHOLD_CONFIG_KEY]
      );

      const persisted = rows[0]?.threshold_overrides || {};
      state.thresholdOverrides = normalizeThresholdOverrides(persisted);
    } catch (error) {
      logStructured("warn", "thresholds.load_failed", {
        error: String(error?.message || error || "threshold_load_failed"),
      });
    } finally {
      thresholdsLoaded = true;
      thresholdsLoadPromise = null;
    }
  })();

  await thresholdsLoadPromise;
}

async function setThresholdOverrides(next = {}) {
  await ensureThresholdOverridesLoaded();
  const normalized = normalizeThresholdOverrides(next);
  state.thresholdOverrides = {
    ...state.thresholdOverrides,
    ...normalized,
  };
  try {
    await persistThresholdOverrides();
  } catch (error) {
    logStructured("warn", "thresholds.persist_failed", {
      error: String(error?.message || error || "threshold_persist_failed"),
    });
  }
  pushEvent("thresholds.updated", { keys: Object.keys(normalized) });
  logStructured("info", "thresholds.updated", { keys: Object.keys(normalized) });
  return getThresholds();
}

async function clearThresholdOverrides() {
  await ensureThresholdOverridesLoaded();
  state.thresholdOverrides = {};
  try {
    await persistThresholdOverrides();
  } catch (error) {
    logStructured("warn", "thresholds.persist_failed", {
      error: String(error?.message || error || "threshold_persist_failed"),
    });
  }
  pushEvent("thresholds.cleared", {});
  logStructured("info", "thresholds.cleared", {});
  return getThresholds();
}

function eventsInWindow(windowMs = DEFAULT_WINDOW_MS) {
  const cutoff = Date.now() - Math.max(1000, Number(windowMs || DEFAULT_WINDOW_MS));
  return state.events.filter((x) => new Date(x.ts).getTime() >= cutoff);
}

function summarizeWindow(windowMs = DEFAULT_WINDOW_MS) {
  const recent = eventsInWindow(windowMs);
  const totals = {
    processed: 0,
    retried: 0,
    deadLettered: 0,
    failed: 0,
    claimed: 0,
  };
  for (const evt of recent) {
    if (evt.type === "event.claimed") totals.claimed += 1;
    if (evt.type === "event.processed") totals.processed += 1;
    if (evt.type === "event.retried") totals.retried += 1;
    if (evt.type === "event.dead_lettered") totals.deadLettered += 1;
    if (evt.type === "event.failed") totals.failed += 1;
  }
  const retryDen = totals.processed + totals.retried + totals.deadLettered;
  return {
    windowMs: Math.max(1000, Number(windowMs || DEFAULT_WINDOW_MS)),
    totals,
    retryRate: retryDen > 0 ? totals.retried / retryDen : 0,
    deadLetterRate: retryDen > 0 ? totals.deadLettered / retryDen : 0,
  };
}

function recordBatchStart({ requestedLimit = null, householdId = null } = {}) {
  state.counters.batchRuns += 1;
  const startTs = nowIso();
  pushEvent("batch.started", { requestedLimit, householdId, startTs });
  logStructured("debug", "batch.started", { requestedLimit, householdId });
  return { startedAt: Date.now(), startTs, requestedLimit, householdId };
}

function recordBatchResult({ startedAt, claimed = 0, processed = 0, failed = 0, deadLettered = 0 } = {}) {
  const durationMs = Math.max(0, Date.now() - Number(startedAt || Date.now()));
  pushLatencySample("batch", durationMs);
  pushEvent("batch.completed", { claimed, processed, failed, deadLettered, durationMs });
  logStructured("info", "batch.completed", { claimed, processed, failed, deadLettered, durationMs });
  return durationMs;
}

function recordBatchError(error) {
  state.counters.batchErrors += 1;
  const message = String(error?.message || error || "batch_error");
  pushEvent("batch.error", { error: message });
  logStructured("error", "batch.error", { error: message });
}

function recordClaimedEvent(event) {
  state.counters.claimed += 1;
  pushEvent("event.claimed", {
    id: String(event?.id || ""),
    attempts: Number(event?.attempts || 0),
    eventType: String(event?.event_type || "unknown"),
    householdId: event?.household_id == null ? null : String(event.household_id),
  });
}

function recordProcessedEvent({ id, eventType, durationMs, attempts, targets }) {
  state.counters.processed += 1;
  pushLatencySample("projection", durationMs);
  pushEvent("event.processed", {
    id: String(id || ""),
    attempts: Number(attempts || 0),
    eventType: String(eventType || "unknown"),
    durationMs: Math.max(0, Number(durationMs || 0)),
    targets: targets || {},
  });
}

function recordRetriedEvent({ id, eventType, durationMs, attempts, error }) {
  state.counters.retried += 1;
  state.counters.projectionFailures += 1;
  pushLatencySample("projection", durationMs);
  pushEvent("event.retried", {
    id: String(id || ""),
    attempts: Number(attempts || 0),
    eventType: String(eventType || "unknown"),
    durationMs: Math.max(0, Number(durationMs || 0)),
    error: String(error || "retry_requested"),
  });
  logStructured("warn", "event.retried", {
    id: String(id || ""),
    attempts: Number(attempts || 0),
    eventType: String(eventType || "unknown"),
    error: String(error || "retry_requested"),
  });
}

function recordDeadLetteredEvent({ id, eventType, attempts, error }) {
  state.counters.deadLettered += 1;
  state.counters.projectionFailures += 1;
  pushEvent("event.dead_lettered", {
    id: String(id || ""),
    attempts: Number(attempts || 0),
    eventType: String(eventType || "unknown"),
    error: String(error || "max_attempts_reached"),
  });
  logStructured("error", "event.dead_lettered", {
    id: String(id || ""),
    attempts: Number(attempts || 0),
    eventType: String(eventType || "unknown"),
    error: String(error || "max_attempts_reached"),
  });
}

function recordEventFailure({ id, eventType, attempts, error }) {
  state.counters.projectionFailures += 1;
  pushEvent("event.failed", {
    id: String(id || ""),
    attempts: Number(attempts || 0),
    eventType: String(eventType || "unknown"),
    error: String(error || "projection_failed"),
  });
}

function recordHeartbeatRun({ renewed = 0, error = null } = {}) {
  state.counters.heartbeatRuns += 1;
  state.counters.heartbeatRenewed += Math.max(0, Number(renewed || 0));
  if (error) {
    state.counters.heartbeatErrors += 1;
    pushEvent("heartbeat.error", { error: String(error) });
    logStructured("warn", "heartbeat.error", { error: String(error) });
    return;
  }
  pushEvent("heartbeat.run", { renewed: Math.max(0, Number(renewed || 0)) });
}

function getMetricsSnapshot({ windowMs = DEFAULT_WINDOW_MS } = {}) {
  const projectionSamples = state.latencyMs.projection;
  const batchSamples = state.latencyMs.batch;
  const windowSummary = summarizeWindow(windowMs);
  return {
    startedAt: state.startedAt,
    now: nowIso(),
    logLevel: EFFECTIVE_LOG_LEVEL,
    counters: { ...state.counters },
    latency: {
      projectionMs: {
        count: projectionSamples.length,
        p50: percentile(projectionSamples, 50),
        p95: percentile(projectionSamples, 95),
        p99: percentile(projectionSamples, 99),
      },
      batchMs: {
        count: batchSamples.length,
        p50: percentile(batchSamples, 50),
        p95: percentile(batchSamples, 95),
        p99: percentile(batchSamples, 99),
      },
    },
    window: windowSummary,
  };
}

function evaluateAlerts({ outboxSummary = {}, healthSignals = {}, windowMs = DEFAULT_WINDOW_MS } = {}) {
  const thresholds = getThresholds();
  const metrics = getMetricsSnapshot({ windowMs });
  const alerts = [];

  const pendingAgeMs = Math.max(0, Number(healthSignals.oldestPendingAgeMs || 0));
  const deadLetterCount = Number(outboxSummary.deadLetter || 0);
  const staleLeaseCount = Number(healthSignals.staleProcessingCount || 0);
  const retryRate = Number(metrics.window.retryRate || 0);

  if (pendingAgeMs >= thresholds.pendingAgeCritMs) {
    alerts.push({
      key: "pending_age",
      severity: "critical",
      message: `oldest pending age ${pendingAgeMs}ms >= ${thresholds.pendingAgeCritMs}ms`,
      value: pendingAgeMs,
      threshold: thresholds.pendingAgeCritMs,
    });
  } else if (pendingAgeMs >= thresholds.pendingAgeWarnMs) {
    alerts.push({
      key: "pending_age",
      severity: "warning",
      message: `oldest pending age ${pendingAgeMs}ms >= ${thresholds.pendingAgeWarnMs}ms`,
      value: pendingAgeMs,
      threshold: thresholds.pendingAgeWarnMs,
    });
  }

  if (deadLetterCount >= thresholds.deadLetterCritCount) {
    alerts.push({
      key: "dead_letter_count",
      severity: "critical",
      message: `dead-letter count ${deadLetterCount} >= ${thresholds.deadLetterCritCount}`,
      value: deadLetterCount,
      threshold: thresholds.deadLetterCritCount,
    });
  } else if (deadLetterCount >= thresholds.deadLetterWarnCount) {
    alerts.push({
      key: "dead_letter_count",
      severity: "warning",
      message: `dead-letter count ${deadLetterCount} >= ${thresholds.deadLetterWarnCount}`,
      value: deadLetterCount,
      threshold: thresholds.deadLetterWarnCount,
    });
  }

  if (staleLeaseCount >= thresholds.staleLeaseCritCount) {
    alerts.push({
      key: "stale_leases",
      severity: "critical",
      message: `stale lease count ${staleLeaseCount} >= ${thresholds.staleLeaseCritCount}`,
      value: staleLeaseCount,
      threshold: thresholds.staleLeaseCritCount,
    });
  } else if (staleLeaseCount >= thresholds.staleLeaseWarnCount) {
    alerts.push({
      key: "stale_leases",
      severity: "warning",
      message: `stale lease count ${staleLeaseCount} >= ${thresholds.staleLeaseWarnCount}`,
      value: staleLeaseCount,
      threshold: thresholds.staleLeaseWarnCount,
    });
  }

  if (retryRate >= thresholds.retryRateCrit) {
    alerts.push({
      key: "retry_rate",
      severity: "critical",
      message: `retry rate ${retryRate.toFixed(4)} >= ${thresholds.retryRateCrit.toFixed(4)}`,
      value: retryRate,
      threshold: thresholds.retryRateCrit,
    });
  } else if (retryRate >= thresholds.retryRateWarn) {
    alerts.push({
      key: "retry_rate",
      severity: "warning",
      message: `retry rate ${retryRate.toFixed(4)} >= ${thresholds.retryRateWarn.toFixed(4)}`,
      value: retryRate,
      threshold: thresholds.retryRateWarn,
    });
  }

  return {
    ok: true,
    windowMs: Math.max(1000, Number(windowMs || DEFAULT_WINDOW_MS)),
    thresholds,
    alerts,
    hasCritical: alerts.some((x) => x.severity === "critical"),
    hasWarning: alerts.some((x) => x.severity === "warning"),
    metrics,
  };
}

async function deliverAlerts({ payload = {}, force = false, urls = null } = {}) {
  const alertPayload = payload && typeof payload === "object" ? payload : {};
  const alerts = Array.isArray(alertPayload.alerts) ? alertPayload.alerts : [];
  const resolvedUrls = normalizeHookUrls(urls == null ? ALERT_HOOK_URLS : urls);

  if (!resolvedUrls.length) {
    pushEvent("alerts.dispatch_skipped", { reason: "no_hook_urls" });
    return {
      ok: true,
      attempted: 0,
      delivered: 0,
      failed: 0,
      skipped: "no_hook_urls",
      dedupeKey: null,
      results: [],
    };
  }

  if (!alerts.length && !force) {
    pushEvent("alerts.dispatch_skipped", { reason: "no_alerts" });
    return {
      ok: true,
      attempted: 0,
      delivered: 0,
      failed: 0,
      skipped: "no_alerts",
      dedupeKey: null,
      results: [],
    };
  }

  const dedupeKey = buildAlertDispatchKey(alertPayload);
  const lastDeliveredAt = Number(state.lastAlertDispatchByKey[dedupeKey] || 0);
  const nowMs = Date.now();
  if (!force && ALERT_HOOK_DEDUPE_MS > 0 && nowMs - lastDeliveredAt < ALERT_HOOK_DEDUPE_MS) {
    pushEvent("alerts.dispatch_skipped", {
      reason: "dedupe_window",
      dedupeKey,
      dedupeMs: ALERT_HOOK_DEDUPE_MS,
    });
    return {
      ok: true,
      attempted: 0,
      delivered: 0,
      failed: 0,
      skipped: "dedupe_window",
      dedupeKey,
      results: [],
    };
  }

  state.lastAlertDispatchByKey[dedupeKey] = nowMs;
  const envelope = {
    ts: nowIso(),
    source: "operational_outbox_observability",
    dedupeKey,
    force: !!force,
    ...alertPayload,
    alerts,
  };

  const results = await Promise.all(
    resolvedUrls.map(async (url) => {
      try {
        const out = await postJsonWithTimeout(url, envelope, ALERT_HOOK_TIMEOUT_MS);
        return { url, ok: true, status: out.status };
      } catch (error) {
        return { url, ok: false, error: String(error?.message || error || "alert_hook_failed") };
      }
    })
  );

  const delivered = results.filter((x) => x.ok).length;
  const failed = results.length - delivered;
  const record = {
    ts: nowIso(),
    dedupeKey,
    householdId: alertPayload.householdId == null ? null : String(alertPayload.householdId),
    force: !!force,
    attempted: results.length,
    delivered,
    failed,
    alertCount: alerts.length,
    results,
  };

  state.alertDeliveries.push(record);
  trimArray(state.alertDeliveries, MAX_EVENT_LOG);

  pushEvent("alerts.dispatched", {
    dedupeKey,
    attempted: record.attempted,
    delivered,
    failed,
    alertCount: alerts.length,
  });

  if (failed > 0) {
    logStructured("warn", "alerts.dispatch_failed", {
      dedupeKey,
      attempted: record.attempted,
      delivered,
      failed,
    });
  } else {
    logStructured("info", "alerts.dispatched", {
      dedupeKey,
      attempted: record.attempted,
      delivered,
      failed,
    });
  }

  return {
    ok: true,
    attempted: record.attempted,
    delivered,
    failed,
    skipped: null,
    dedupeKey,
    results,
  };
}

function getAlertDeliveryHistory({ limit = 50 } = {}) {
  const safeLimit = Math.max(1, Number(limit || 50));
  return state.alertDeliveries.slice(Math.max(0, state.alertDeliveries.length - safeLimit));
}

function getRecentEvents({ limit = 100 } = {}) {
  const safeLimit = Math.max(1, Number(limit || 100));
  return state.events.slice(Math.max(0, state.events.length - safeLimit));
}

module.exports = {
  recordBatchStart,
  recordBatchResult,
  recordBatchError,
  recordClaimedEvent,
  recordProcessedEvent,
  recordRetriedEvent,
  recordDeadLetteredEvent,
  recordEventFailure,
  recordHeartbeatRun,
  getMetricsSnapshot,
  getRecentEvents,
  getAlertDeliveryHistory,
  evaluateAlerts,
  deliverAlerts,
  ensureThresholdOverridesLoaded,
  getThresholds,
  setThresholdOverrides,
  clearThresholdOverrides,
  logStructured,
};
