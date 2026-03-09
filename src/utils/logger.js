// File: src/utils/logger.js
/**
 * logger
 * -----------------------------------------------------------------------------
 * SSA Unified Logger (browser-safe, production-ready)
 *
 * Why this exists
 *  - A single logging facade that can be used by any module without:
 *      • importing UI
 *      • crashing builds
 *      • relying on Node APIs
 *  - Supports:
 *      • console logging with level control
 *      • structured events to DashboardLog (if available)
 *      • eventBus emit (if available)
 *      • scoped loggers: createLogger("module.name")
 *
 * Design principles
 *  - Never throw from logging
 *  - Prefer structured logs (message + data + meta)
 *  - Opt-in debug/trace via:
 *      • localStorage "ssa.logLevel" (trace|debug|info|warn|error|silent)
 *      • window.__SSA_LOG_LEVEL__ (same values)
 *      • import.meta.env.VITE_LOG_LEVEL (optional)
 *
 * Usage
 *  import logger, { createLogger } from "@/utils/logger";
 *  const log = createLogger("services.inventory");
 *  log.info("Loaded", { count });
 *  log.warn("Missing UPC", { upc });
 *
 *  // One-off
 *  logger.error("Boom", err, { source: "foo" });
 */

const SOURCE = "utils.logger";

/* -----------------------------------------------------------------------------
 * Optional dependencies (do not crash builds)
 * -------------------------------------------------------------------------- */

let DashboardLog = null;
try {
  const mod = await import("@/services/dashboard/DashboardLog.js");
  DashboardLog = mod?.default ?? mod ?? null;
} catch {
  DashboardLog = null;
}

let eventBus = null;
try {
  const mod = await import("@/services/events/eventBus");
  eventBus = mod?.default ?? mod ?? null;
} catch {
  eventBus = null;
}

/* -----------------------------------------------------------------------------
 * Levels / gating
 * -------------------------------------------------------------------------- */

const LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 999,
});

function normLevel(lvl) {
  const s = String(lvl ?? "info")
    .toLowerCase()
    .trim();
  if (s in LEVELS) return s;
  if (s === "warning") return "warn";
  if (s === "err") return "error";
  return "info";
}

function getRuntimeLevel() {
  // Priority: window override > localStorage > env var > default
  try {
    if (typeof window !== "undefined" && window.__SSA_LOG_LEVEL__) {
      return normLevel(window.__SSA_LOG_LEVEL__);
    }
  } catch {
    // ignore
  }

  try {
    const v = localStorage.getItem("ssa.logLevel");
    if (v) return normLevel(v);
  } catch {
    // ignore
  }

  try {
    // Vite exposes env vars at build time
    const env = import.meta?.env;
    const v = env?.VITE_LOG_LEVEL;
    if (v) return normLevel(v);
  } catch {
    // ignore
  }

  return "info";
}

function shouldLog(level) {
  const current = getRuntimeLevel();
  return LEVELS[normLevel(level)] >= LEVELS[current] ? false : true;
  // Note: Inverted? Let's do it carefully:
  // We want to log if requested severity >= threshold severity.
}

function shouldLogFixed(level) {
  const current = getRuntimeLevel();
  return LEVELS[normLevel(level)] >= LEVELS[current];
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function safeObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : null;
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function nowMs() {
  return Date.now();
}

function toErrorLike(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  if (typeof err === "string") return { message: err };
  if (typeof err === "object") {
    const o = err;
    return {
      name: o.name || "Error",
      message: o.message || String(err),
      stack: o.stack,
      ...o,
    };
  }
  return { message: String(err) };
}

function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
}

function shortStack() {
  try {
    const e = new Error();
    if (!e.stack) return null;
    // Remove first line (Error) and logger frames best-effort
    const lines = String(e.stack).split("\n").slice(2, 8);
    return lines.map((l) => l.trim()).join(" | ");
  } catch {
    return null;
  }
}

/* -----------------------------------------------------------------------------
 * Console sink
 * -------------------------------------------------------------------------- */

function consoleSink(level, message, data, meta) {
  try {
    const prefix = meta?.source ? `[${meta.source}]` : "[SSA]";
    const payload = data != null ? data : undefined;

    if (level === "error") {
      console.error(prefix, message, payload ?? "", meta ?? "");
    } else if (level === "warn") {
      console.warn(prefix, message, payload ?? "", meta ?? "");
    } else if (level === "info") {
      console.info(prefix, message, payload ?? "", meta ?? "");
    } else if (level === "debug") {
      console.debug(prefix, message, payload ?? "", meta ?? "");
    } else {
      console.log(prefix, message, payload ?? "", meta ?? "");
    }
  } catch {
    // ignore
  }
}

/* -----------------------------------------------------------------------------
 * Dashboard sink (structured)
 * -------------------------------------------------------------------------- */

async function dashboardSink(level, message, data, meta) {
  if (!DashboardLog) return;

  // DashboardLog in your project supports:
  //   DashboardLog.info(message, data, opts)
  //   DashboardLog.warn(message, data, opts) ...
  // We pass meta as opts where possible.
  try {
    const opts = {
      source: meta?.source || SOURCE,
      domain: meta?.domain || null,
      tags: safeArray(meta?.tags),
      sessionId: meta?.sessionId || null,
      runId: meta?.runId || null,
      householdId: meta?.householdId || null,
      userId: meta?.userId || null,
      persist: meta?.persist,
    };

    const fn =
      level === "error"
        ? DashboardLog.error
        : level === "warn"
        ? DashboardLog.warn
        : level === "debug"
        ? DashboardLog.debug
        : level === "trace"
        ? DashboardLog.trace
        : DashboardLog.info;

    if (typeof fn === "function") {
      await fn.call(DashboardLog, message, data ?? null, opts);
    } else if (typeof DashboardLog.log === "function") {
      await DashboardLog.log(message, data ?? null, opts);
    }
  } catch {
    // ignore — never break execution due to logging
  }
}

/* -----------------------------------------------------------------------------
 * Main write path
 * -------------------------------------------------------------------------- */

async function write(level, message, data, meta = {}) {
  const lvl = normLevel(level);

  // Gate
  if (!shouldLogFixed(lvl)) return null;

  const msg = String(message ?? "");
  const obj = safeObject(data);
  const errLike = data instanceof Error ? toErrorLike(data) : null;

  const payload =
    errLike ||
    obj ||
    (data != null && typeof data !== "function" ? { value: data } : null);

  const fullMeta = {
    source: meta.source || SOURCE,
    domain: meta.domain || null,
    tags: safeArray(meta.tags),
    ts: nowMs(),
    stack: meta.stack ? shortStack() : null,
    sessionId: meta.sessionId || null,
    runId: meta.runId || null,
    householdId: meta.householdId || null,
    userId: meta.userId || null,
    persist: meta.persist,
  };

  // EventBus emit for UI listeners
  emit("log", { level: lvl, message: msg, data: payload, meta: fullMeta });
  emit(`log.${lvl}`, {
    level: lvl,
    message: msg,
    data: payload,
    meta: fullMeta,
  });

  // Console
  consoleSink(lvl, msg, payload, fullMeta);

  // Dashboard (best-effort async)
  await dashboardSink(lvl, msg, payload, fullMeta);

  return { level: lvl, message: msg, data: payload, meta: fullMeta };
}

/* -----------------------------------------------------------------------------
 * Public facade
 * -------------------------------------------------------------------------- */

function buildLogger(scopeSource) {
  const scoped = String(scopeSource || SOURCE);

  return {
    trace: (message, data, meta) =>
      write("trace", message, data, { ...(meta || {}), source: scoped }),
    debug: (message, data, meta) =>
      write("debug", message, data, { ...(meta || {}), source: scoped }),
    info: (message, data, meta) =>
      write("info", message, data, { ...(meta || {}), source: scoped }),
    warn: (message, data, meta) =>
      write("warn", message, data, { ...(meta || {}), source: scoped }),
    error: (message, data, meta) =>
      write("error", message, data, { ...(meta || {}), source: scoped }),

    /**
     * setLevel
     *  - Sets runtime log level (localStorage) for debugging.
     */
    setLevel: (lvl) => {
      try {
        localStorage.setItem("ssa.logLevel", normLevel(lvl));
        return true;
      } catch {
        return false;
      }
    },

    getLevel: () => getRuntimeLevel(),

    /**
     * child
     *  - Create a nested logger:
     *      const log = createLogger("a"); const child = log.child("b"); // source "a.b"
     */
    child: (name) => buildLogger(`${scoped}.${String(name || "").trim()}`),

    /**
     * with
     *  - Convenience to bind default meta (domain/tags/sessionId, etc.)
     */
    with: (defaults = {}) => {
      const d = safeObject(defaults) || {};
      return {
        trace: (m, data, meta) =>
          write("trace", m, data, { ...d, ...(meta || {}), source: scoped }),
        debug: (m, data, meta) =>
          write("debug", m, data, { ...d, ...(meta || {}), source: scoped }),
        info: (m, data, meta) =>
          write("info", m, data, { ...d, ...(meta || {}), source: scoped }),
        warn: (m, data, meta) =>
          write("warn", m, data, { ...d, ...(meta || {}), source: scoped }),
        error: (m, data, meta) =>
          write("error", m, data, { ...d, ...(meta || {}), source: scoped }),
      };
    },
  };
}

/**
 * createLogger(scope)
 */
export function createLogger(scope) {
  return buildLogger(scope);
}

/**
 * Default logger (SOURCE = utils.logger)
 */
const logger = buildLogger(SOURCE);

/**
 * Named export for modules that import: `import { logger } from "@/utils/logger"`
 */
export { logger };

export default logger;
