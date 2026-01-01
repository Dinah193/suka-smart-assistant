// File: C:\Users\larho\suka-smart-assistant\src\logging\structured.js

/**
 * Structured logging for SSA
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Provide consistent, structured, JSON-first logging across the SSA stack.
 *  - Attach correlation fields (sessionId, stepId, planId, modelVersion, requestId)
 *    to every entry so UI, workers, and runtime can stitch narratives together.
 *  - Emit logs to multiple sinks:
 *      • console (dev-friendly)
 *      • eventBus (for in-app telemetry dashboards & automations)
 *
 * Pipeline fit (imports → intelligence → automation → (optional) hub export)
 *  - All stages can log through this utility; log entries also mirror as
 *    eventBus telemetry events with normalized payload shape:
 *      { type, ts, source, data }
 *  - This file does NOT export to the Hub; it's observability only.
 *
 * Design notes
 *  - Defensive: safe-stringify, small redaction for common sensitive keys.
 *  - Extensible: pluggable sinks, child loggers with merged context.
 *  - Lightweight tracing helpers: span() for duration and outcome logging.
 */

import eventBus from "../services/eventBus";
import featureFlags from "../config/featureFlags";

/** @typedef {'debug'|'info'|'warn'|'error'} LogLevel */

const DEFAULT_SOURCE = "ssa.logger";
const LEVELS = /** @type {const} */ (["debug", "info", "warn", "error"]);
const LEVEL_NUM = { debug: 10, info: 20, warn: 30, error: 40 };

const nowISO = () => new Date().toISOString();

// -----------------------------
// Redaction / stringify helpers
// -----------------------------
const DEFAULT_REDACT_KEYS = new Set([
  "password",
  "token",
  "authorization",
  "auth",
  "secret",
  "apiKey",
  "email",
  "phone",
]);

/**
 * Best-effort redaction for known keys (shallow + nested objects).
 * Does not aim to be perfect PII protection—just prevents common accidents.
 */
function redact(value, extraKeys) {
  const KEYS = new Set([...DEFAULT_REDACT_KEYS, ...(extraKeys || [])]);

  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);

    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (KEYS.has(k)) out[k] = "[REDACTED]";
      else out[k] = walk(val);
    }
    return out;
  };
  return walk(value);
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    try {
      return JSON.stringify(JSON.decycle ? JSON.decycle(obj) : String(obj));
    } catch {
      return String(obj);
    }
  }
}

// -----------------------------
// Sinks
// -----------------------------
/** Console sink (dev-friendly) */
function consoleSink(entry) {
  try {
    const { level } = entry;
    const line = safeStringify(entry);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else if (level === "info") console.info(line);
    else console.debug(line);
  } catch {
    // ignore console errors
  }
}

/** EventBus sink (normalized telemetry payload) */
function eventBusSink(entry) {
  try {
    const payload = {
      type: "telemetry.log",
      ts: entry.ts || nowISO(),
      source: entry.source || DEFAULT_SOURCE,
      data: entry,
    };
    eventBus.emit(payload.type, payload);
  } catch {
    // bus is best-effort for logs
  }
}

// -----------------------------
// Rate limit (per source+key)
// -----------------------------
const rateMap = new Map();
/**
 * rateKey: `${source}|${key}|${level}`
 */
function rateLimited(rateKey, perMs) {
  if (!perMs || perMs <= 0) return false;
  const now = Date.now();
  const next = rateMap.get(rateKey) || 0;
  if (now < next) return true;
  rateMap.set(rateKey, now + perMs);
  return false;
}

// -----------------------------
// Logger factory
// -----------------------------

/**
 * @typedef {Object} LoggerContext
 * @property {string=} source             // subsystem name
 * @property {string=} sessionId          // planning/execution session correlation
 * @property {string=} stepId             // granular step within a session
 * @property {string=} planId             // schedule plan id
 * @property {string=} modelVersion       // calibration/model version
 * @property {string=} requestId          // externally supplied request id
 * @property {string=} domain             // cooking/cleaning/garden/animals/storehouse/preservation
 * @property {Record<string, any>=} tags  // free-form small label bag
 */

/**
 * @typedef {Object} LoggerOptions
 * @property {LogLevel=} level           // minimum level to emit
 * @property {Array<(entry:any)=>void>=} sinks
 * @property {Array<string>=} redactKeys // additional redact keys
 * @property {number=} sampleRate        // 0..1; probability to emit debug entries
 */

const DEFAULT_OPTS = /** @type {LoggerOptions} */ ({
  level: featureFlags?.telemetry?.minLevel || "debug",
  sinks: featureFlags?.telemetry?.emitDebug === false ? [eventBusSink] : [consoleSink, eventBusSink],
  redactKeys: [],
  sampleRate: 1,
});

/**
 * Create a structured logger.
 * @param {LoggerContext} ctx
 * @param {LoggerOptions=} opts
 */
export function createLogger(ctx = {}, opts = {}) {
  const options = { ...DEFAULT_OPTS, ...opts };
  const minLevelNum = LEVEL_NUM[options.level || "debug"] ?? 10;

  function baseEntry(level, msg, data, meta) {
    /** @type {any} */
    const entry = {
      ts: nowISO(),
      level,
      message: String(msg ?? ""),
      source: ctx.source || DEFAULT_SOURCE,
      // Correlation context
      sessionId: ctx.sessionId || undefined,
      stepId: ctx.stepId || undefined,
      planId: ctx.planId || undefined,
      modelVersion: ctx.modelVersion || undefined,
      requestId: ctx.requestId || undefined,
      domain: ctx.domain || undefined,
      tags: ctx.tags || undefined,
      // Data payload
      data: redact(data, options.redactKeys),
      ...meta,
    };
    return entry;
  }

  function emit(level, msg, data, meta) {
    if ((LEVEL_NUM[level] ?? 999) < minLevelNum) return;
    if (level === "debug" && options.sampleRate < 1 && Math.random() > options.sampleRate) return;

    const entry = baseEntry(level, msg, data, meta);

    const keyForRate =
      entry.tags?.rateKey ||
      (entry.data && entry.data.rateKey) ||
      `${entry.source}|${entry.message}|${level}`;
    const perMs = Number(entry.tags?.rateMs || entry.data?.rateMs || 0);
    if (rateLimited(keyForRate, perMs)) return;

    for (const sink of options.sinks || []) {
      try {
        sink(entry);
      } catch {
        // sink errors are swallowed
      }
    }
  }

  /** Child logger with merged context */
  function child(extraCtx = {}, extraOpts = {}) {
    return createLogger(
      { ...ctx, ...extraCtx, tags: { ...(ctx.tags || {}), ...(extraCtx.tags || {}) } },
      { ...options, ...extraOpts }
    );
  }

  /**
   * Start a simple span (timed section). Returns { end, fail }.
   * Usage:
   *   const span = log.span("schedule.compute", { planId });
   *   try { ...; span.end({ ok: true }); } catch (e) { span.fail(e); }
   */
  function span(operation, data) {
    const spanId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const startedAt = Date.now();
    emit("debug", `span.start:${operation}`, data, { spanId, operation, phase: "start" });

    return {
      id: spanId,
      end(extra) {
        const durMs = Date.now() - startedAt;
        emit("info", `span.end:${operation}`, { ...data, ...extra, durMs }, { spanId, operation, durMs, phase: "end" });
      },
      fail(error, extra) {
        const durMs = Date.now() - startedAt;
        emit(
          "error",
          `span.fail:${operation}`,
          { ...data, ...extra, error: errorToObject(error), durMs },
          { spanId, operation, durMs, phase: "fail" }
        );
      },
    };
  }

  /** Convenience: log duration of a function (sync/async) and bubble result/throw */
  function timed(operation, fn, data) {
    const s = span(operation, data);
    try {
      const res = fn();
      if (res && typeof res.then === "function") {
        return res
          .then((v) => {
            s.end({ ok: true });
            return v;
          })
          .catch((e) => {
            s.fail(e);
            throw e;
          });
      }
      s.end({ ok: true });
      return res;
    } catch (e) {
      s.fail(e);
      throw e;
    }
  }

  // Public API
  return {
    context: { ...ctx },
    setTag(key, value) {
      ctx.tags = { ...(ctx.tags || {}), [key]: value };
      return this;
    },
    child,
    span,
    timed,
    debug: (msg, data, meta) => emit("debug", msg, data, meta),
    info: (msg, data, meta) => emit("info", msg, data, meta),
    warn: (msg, data, meta) => emit("warn", msg, data, meta),
    error: (msg, data, meta) => emit("error", msg, data, meta),
  };
}

// -----------------------------
// Convenience globals
// -----------------------------
/** Default logger with minimal context */
export const log = createLogger({ source: DEFAULT_SOURCE });

/**
 * Attach commonly used correlation context quickly (e.g., per session/plan).
 * Example:
 *   const slog = withCorrelation({ source:'ui.scheduling', sessionId, planId, modelVersion });
 *   slog.info('user.nudge', { minutes: 5 });
 */
export function withCorrelation({ source, sessionId, stepId, planId, modelVersion, requestId, domain, tags }) {
  return createLogger({ source, sessionId, stepId, planId, modelVersion, requestId, domain, tags });
}

// -----------------------------
// Error shape helper
// -----------------------------
function errorToObject(err) {
  if (!err) return null;
  if (typeof err === "string") return { message: err };
  return {
    name: err.name || "Error",
    message: err.message || String(err),
    stack: err.stack || undefined,
    code: err.code || undefined,
  };
}

// -----------------------------
// Example: bridge to normalized events
// -----------------------------
/**
 * Emit a normalized eventBus entry that also writes a structured log.
 * Keeps the SSA-wide payload shape { type, ts, source, data }.
 * NOTE: This helper does not export to the Hub—observability only.
 */
export function auditEvent(source, type, data) {
  const payload = { type, ts: nowISO(), source: source || DEFAULT_SOURCE, data };
  try {
    eventBus.emit(type, payload);
  } catch {
    // ignore
  }
  log.info(`audit:${type}`, { source, data });
  return payload;
}

// -----------------------------
// Minimal no-throw guards for external usage
// -----------------------------
export function tryInfo(logger, msg, data) {
  try {
    (logger || log).info(msg, data);
  } catch {
    // swallow
  }
}
export function tryError(logger, msg, data) {
  try {
    (logger || log).error(msg, data);
  } catch {
    // swallow
  }
}

// -----------------------------
// Usage examples (commented):
// -----------------------------
/**
 * // In scheduler:
 * const logger = withCorrelation({
 *   source: 'runtime.scheduler',
 *   planId,
 *   modelVersion,
 *   domain: 'cooking',
 *   sessionId
 * });
 * const span = logger.span('reschedule.window', { from: fromISO, to: toISO });
 * try {
 *   const out = await scheduler.recompute(...);
 *   span.end({ ok: true, affected: out.affectedSessions?.length || 0 });
 * } catch (e) {
 *   span.fail(e);
 * }
 *
 * // In UI:
 * import { log } from '@/logging/structured';
 * log.debug('ui.click', { target: 'autofit.button' }, { ui: true });
 */
