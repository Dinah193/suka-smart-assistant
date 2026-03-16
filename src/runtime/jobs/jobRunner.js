// C:\Users\larho\suka-smart-assistant\src\runtime\jobs\jobRunner.js
// SSA Runtime - Job Runner
// ----------------------------------------------------------
// Responsibilities:
//   - Load cron schedule (src/runtime/jobs/cron.schedule.json)
//   - Feature-flag gating
//   - Cron matching at minute granularity (supports "*/n", lists, names)
//   - Jitter, timeout, retries (exponential or fixed)
//   - Concurrency limits and simple debounce (no overlap per job)
//   - Emits events on the shared eventBus with payload { type, ts, source, data }
//
// Pipeline fit: imports -> intelligence -> automation -> (optional) hub export
// This runner orchestrates automation by firing scheduled jobs. Handlers emit
// their own domain events and may export to the Hub when enabled.

const path = require("path");

let eventBus = {
  emit: function () {
    /* fallback for tests */
  },
  on: function () {
    return function () {};
  },
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_) {
  /* noop */
}

let featureFlags = { familyFundMode: false };
try {
  const ff = require("@/config/featureFlags");
  featureFlags = (ff && (ff.default || ff)) || featureFlags;
} catch (_) {
  /* noop */
}

const SCHEDULE_PATH = path.join(__dirname, "cron.schedule.json");
let loadedSchedule = null;

// ------------------------------ State ---------------------------------------

const state = {
  started: false,
  intervalHandle: null,
  tickMs: 15000, // check 4x per minute to catch jitter offsets
  defaults: {
    maxConcurrency: 3,
    retryPolicy: {
      maxAttempts: 3,
      backoff: { type: "exponential", initialSeconds: 15, maxSeconds: 300 },
      retryOn: ["timeout", "network", "5xx"],
    },
    timeoutSeconds: 600,
    jitterSeconds: 30,
  },
  activeCount: 0,
  jobs: new Map(), // id -> runtime info
};

function newRuntimeInfo(job) {
  return {
    id: job.id,
    enabled: !!job.enabled,
    featureFlag: job.featureFlag || null,
    cron: job.cron,
    payload: job.payload,
    timeoutSeconds:
      job.timeoutSeconds != null
        ? job.timeoutSeconds
        : state.defaults.timeoutSeconds,
    jitterSeconds:
      job.jitterSeconds != null
        ? job.jitterSeconds
        : state.defaults.jitterSeconds,
    description: job.description || "",
    running: false,
    lastRunISO: null,
    lastOkISO: null,
    lastErrISO: null,
    lastError: null,
    attempts: 0,
    nextAt: null,
    backoffUntil: null,
  };
}

// ------------------------------- API ----------------------------------------

module.exports = {
  start: function () {
    if (state.started) return;
    loadSchedule();
    planAll();
    state.started = true;
    state.intervalHandle = setInterval(tick, state.tickMs);
    emit("runtime.jobs.started", { next: snapshotNext() });
  },

  stop: function () {
    if (!state.started) return;
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
    state.started = false;
    emit("runtime.jobs.stopped", {});
  },

  runNow: async function (id, opts) {
    opts = opts || {};
    const info = state.jobs.get(id);
    if (!info) throw new Error("job-not-found:" + id);
    if (!isJobEnabled(info)) {
      emit("runtime.job.skipped", {
        id: id,
        reason: "disabled-or-flagged-off",
      });
      return;
    }
    if (info.running && !opts.ignoreDebounce) {
      emit("runtime.job.debounced", { id: id, reason: "already-running" });
      return;
    }
    await runJob(info, { forced: true });
  },

  reload: function () {
    loadSchedule(true);
    planAll();
    emit("runtime.jobs.reloaded", { next: snapshotNext() });
  },

  getState: function () {
    const jobs = Array.from(state.jobs.values()).map(lightSnapshot);
    return {
      started: state.started,
      activeCount: state.activeCount,
      defaults: state.defaults,
      jobs: jobs,
    };
  },
};

// ------------------------------ Core Loop -----------------------------------

function tick() {
  const now = new Date();

  const cap =
    (loadedSchedule &&
      loadedSchedule.defaults &&
      loadedSchedule.defaults.maxConcurrency) != null
      ? loadedSchedule.defaults.maxConcurrency
      : state.defaults.maxConcurrency;

  if (state.activeCount >= cap) return;

  state.jobs.forEach(function (info) {
    if (!isJobEnabled(info)) return;

    if (info.backoffUntil && now < info.backoffUntil) return;
    if (info.running) return;

    if (!info.nextAt) {
      info.nextAt = nextOccurrence(info.cron, now);
      return;
    }

    if (now >= info.nextAt) {
      var jitterMs = (info.jitterSeconds || 0) * 1000 * Math.random();
      var staggerMs = hash(info.id) % 500; // up to 0.5s
      var delay = Math.max(0, Math.min(jitterMs + staggerMs, 60000)); // never > 60s

      setTimeout(function () {
        runJob(info).catch(function () {});
      }, delay);

      info.nextAt = nextOccurrence(info.cron, new Date(now.getTime() + 60000));
    }
  });
}

// ------------------------------ Scheduling ----------------------------------

function loadSchedule(force) {
  if (loadedSchedule && !force) return;

  // re-require to support reload
  delete require.cache[require.resolve(SCHEDULE_PATH)];
  const schedule = require(SCHEDULE_PATH);

  state.defaults = Object.assign({}, state.defaults, schedule.defaults || {});
  state.jobs.clear();

  (schedule.jobs || []).forEach(function (job) {
    if (
      !job ||
      !job.id ||
      !job.cron ||
      !(job.payload && job.payload.module && job.payload.fn)
    ) {
      emit("runtime.job.skipped", {
        id: (job && job.id) || "unknown",
        reason: "invalid-definition",
      });
      return;
    }
    state.jobs.set(job.id, newRuntimeInfo(job));
  });

  loadedSchedule = schedule;
}

function planAll() {
  const now = new Date();
  state.jobs.forEach(function (info) {
    info.nextAt = nextOccurrence(info.cron, now);
  });
}

function isJobEnabled(info) {
  if (!info.enabled) return false;
  if (info.featureFlag && !(featureFlags && featureFlags[info.featureFlag]))
    return false;
  return true;
}

// ------------------------------ Execution -----------------------------------

async function runJob(info, meta) {
  meta = meta || {};

  const cap =
    (loadedSchedule &&
      loadedSchedule.defaults &&
      loadedSchedule.defaults.maxConcurrency) != null
      ? loadedSchedule.defaults.maxConcurrency
      : state.defaults.maxConcurrency;
  if (state.activeCount >= cap) {
    emit("runtime.job.skipped", {
      id: info.id,
      reason: "global-concurrency-cap",
    });
    return;
  }

  if (info.running) {
    emit("runtime.job.debounced", { id: info.id, reason: "already-running" });
    return;
  }

  info.running = true;
  info.attempts = (info.attempts || 0) + 1;
  info.lastRunISO = new Date().toISOString();
  state.activeCount++;

  emit("runtime.job.started", {
    id: info.id,
    forced: !!meta.forced,
    attempt: info.attempts,
    description: info.description,
  });

  try {
    const handler = requireSafe(info.payload.module);
    const fn = handler && handler[info.payload.fn];
    if (typeof fn !== "function")
      throw new Error("handler-missing-fn:" + info.payload.fn);

    const timeoutMs =
      (info.timeoutSeconds != null
        ? info.timeoutSeconds
        : state.defaults.timeoutSeconds) * 1000;
    const result = await withTimeout(function () {
      return fn(info.payload.args || {});
    }, timeoutMs);

    info.lastOkISO = new Date().toISOString();
    info.lastError = null;
    info.lastErrISO = null;
    info.attempts = 0;
    info.backoffUntil = null;

    emit("runtime.job.succeeded", {
      id: info.id,
      durationMs: Date.parse(info.lastOkISO) - Date.parse(info.lastRunISO),
      result: summarizeResult(result),
    });
  } catch (err) {
    info.lastErrISO = new Date().toISOString();
    info.lastError = String((err && err.message) || err || "unknown");

    const policy =
      (loadedSchedule &&
        loadedSchedule.defaults &&
        loadedSchedule.defaults.retryPolicy) ||
      state.defaults.retryPolicy;
    const shouldRetry = decideRetry(err, policy);
    if (shouldRetry && info.attempts < (policy.maxAttempts || 3)) {
      const backoff = computeBackoff(info.attempts, policy);
      info.backoffUntil = new Date(Date.now() + backoff * 1000);

      emit("runtime.job.retry.scheduled", {
        id: info.id,
        attempt: info.attempts,
        backoffSeconds: backoff,
        error: info.lastError,
      });
    } else {
      emit("runtime.job.failed", {
        id: info.id,
        attempt: info.attempts,
        error: info.lastError,
      });
      info.attempts = 0;
      info.backoffUntil = null;
    }
  } finally {
    info.running = false;
    state.activeCount = Math.max(0, state.activeCount - 1);
  }
}

// ------------------------------ Cron Utils ----------------------------------

function nextOccurrence(expr, from) {
  const p = parseCron(expr);
  if (!p) return new Date(from.getTime() + 60000);

  var t = new Date(from.getTime() + 60000);
  t.setSeconds(0, 0);

  for (var i = 0; i < 370 * 24 * 60; i++) {
    var m = t.getMinutes();
    var h = t.getHours();
    var dow = t.getDay(); // 0=Sun
    if (p.minutes.has(m) && p.hours.has(h) && p.dows.has(dow)) {
      return t;
    }
    t = new Date(t.getTime() + 60000);
  }
  return new Date(from.getTime() + 3600000);
}

function parseCron(expr) {
  if (typeof expr !== "string") return null;
  var parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return null;
  var minS = parts[0];
  var hourS = parts[1];
  var dowS = parts[4];

  var minutes = parsePart(minS, 0, 59);
  var hours = parsePart(hourS, 0, 23);
  var dows = parseDOW(dowS || "*");

  if (!minutes || !hours || !dows) return null;
  return { minutes: minutes, hours: hours, dows: dows };
}

function parsePart(s, lo, hi) {
  if (!s || s === "*") return asSet(range(lo, hi));
  if (s.indexOf("*/") === 0) {
    var n = Number(s.slice(2));
    if (!isFinite(n) || n <= 0) return null;
    return asSet(
      range(lo, hi).filter(function (v) {
        return v % n === 0;
      })
    );
  }
  var out = new Set();
  s.split(",").forEach(function (token) {
    var n2 = Number(token);
    if (isFinite(n2) && n2 >= lo && n2 <= hi) out.add(n2);
  });
  return out.size ? out : null;
}

function parseDOW(s) {
  if (!s || s === "*") return asSet([0, 1, 2, 3, 4, 5, 6]);
  var nameMap = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  var out = new Set();
  s.split(",").forEach(function (token) {
    var t = String(token || "")
      .trim()
      .toUpperCase();
    if (t.indexOf("*/") === 0) {
      var n = Number(t.slice(2));
      if (isFinite(n) && n > 0) {
        for (var i = 0; i < 7; i++) if (i % n === 0) out.add(i);
      }
      return;
    }
    if (nameMap.hasOwnProperty(t)) {
      out.add(nameMap[t]);
      return;
    }
    var num = Number(t);
    if (isFinite(num)) out.add(num === 7 ? 0 : Math.max(0, Math.min(6, num)));
  });
  return out.size ? out : null;
}

function range(a, b) {
  var arr = [];
  for (var i = a; i <= b; i++) arr.push(i);
  return arr;
}
function asSet(arr) {
  return new Set(arr);
}

// ------------------------------ Retry/Timeout -------------------------------

function decideRetry(err, policy) {
  var msg = String((err && err.message) || err || "").toLowerCase();
  var classes = (policy && policy.retryOn) || [];
  if (!classes.length) return false;
  return classes.some(function (c) {
    var t = String(c || "").toLowerCase();
    if (t === "timeout") return msg.indexOf("timeout") >= 0;
    if (t === "network")
      return (
        msg.indexOf("network") >= 0 ||
        msg.indexOf("fetch") >= 0 ||
        msg.indexOf("econn") >= 0
      );
    if (t === "5xx")
      return /\b5\d{2}\b/.test(msg) || msg.indexOf("server") >= 0;
    return false;
  });
}

function computeBackoff(attempt, policy) {
  var type = (policy && policy.backoff && policy.backoff.type) || "exponential";
  var init = Number(
    (policy && policy.backoff && policy.backoff.initialSeconds) != null
      ? policy.backoff.initialSeconds
      : 15
  );
  var max = Number(
    (policy && policy.backoff && policy.backoff.maxSeconds) != null
      ? policy.backoff.maxSeconds
      : 300
  );
  if (type === "fixed") return Math.min(max, init);
  var exp = Math.min(max, init * Math.pow(2, Math.max(0, attempt - 1)));
  var factor = 0.7 + Math.random() * 0.3;
  return Math.max(1, Math.floor(exp * factor));
}

async function withTimeout(fn, timeoutMs) {
  var to;
  var timeout = new Promise(function (_, rej) {
    to = setTimeout(function () {
      rej(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    var result = await Promise.race([Promise.resolve().then(fn), timeout]);
    return result;
  } finally {
    clearTimeout(to);
  }
}

// ------------------------------ Helpers -------------------------------------

function requireSafe(modulePath) {
  try {
    if (modulePath.indexOf("@/") === 0) {
      var root = path.resolve(__dirname, "../.."); // src/
      var abs = path.join(root, modulePath.replace("@/", ""));
      return require(abs);
    }
    return require(modulePath);
  } catch (err) {
    throw new Error(
      "handler-load-failed:" + modulePath + ":" + ((err && err.message) || err)
    );
  }
}

function emit(type, data) {
  try {
    eventBus.emit({
      type: type,
      ts: new Date().toISOString(),
      source: "runtime.jobs.jobRunner",
      data: data,
    });
  } catch (_) {
    /* ignore */
  }
}

function lightSnapshot(info) {
  return {
    id: info.id,
    enabled: info.enabled,
    featureFlag: info.featureFlag,
    cron: info.cron,
    running: info.running,
    lastRunISO: info.lastRunISO,
    lastOkISO: info.lastOkISO,
    lastErrISO: info.lastErrISO,
    nextAtISO: info.nextAt ? info.nextAt.toISOString() : null,
    attempts: info.attempts,
    backoffUntilISO: info.backoffUntil ? info.backoffUntil.toISOString() : null,
  };
}

function snapshotNext() {
  var next = {};
  state.jobs.forEach(function (info, id) {
    next[id] = info.nextAt ? info.nextAt.toISOString() : null;
  });
  return next;
}

function hash(str) {
  var s = String(str);
  var h = 0;
  for (var i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function summarizeResult(res) {
  if (res == null) return null;
  var t = typeof res;
  if (t === "string") return res.slice(0, 200);
  if (t === "number" || t === "boolean") return res;
  if (Array.isArray(res)) return { arrayLen: res.length };
  if (t === "object") {
    var keys = Object.keys(res);
    return { keys: keys.slice(0, 8) };
  }
  return String(res).slice(0, 200);
}
