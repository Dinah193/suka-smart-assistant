const WEB_VITALS_STORAGE_KEY = "suka.webVitalsTelemetry.v1";
const MAX_RECORDS = 400;

function isBrowserRuntime() {
  return typeof window !== "undefined";
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return fallback;
}

function getPathname() {
  if (!isBrowserRuntime()) return "unknown";
  const path = window.location?.pathname || "/";
  const search = window.location?.search || "";
  return `${path}${search}`;
}

function readJson(key, fallback) {
  if (!isBrowserRuntime()) return fallback;
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  if (!isBrowserRuntime()) return;
  try {
    window.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors.
  }
}

function shouldEnableCollection(options = {}) {
  if (!isBrowserRuntime()) return false;

  if (typeof options.enabled === "boolean") {
    return options.enabled;
  }

  const env = options.env || {};
  if ("VITE_WEB_VITALS_ENABLED" in env) {
    return asBoolean(env.VITE_WEB_VITALS_ENABLED, false);
  }

  return !!env.PROD;
}

function resolveTransport(options = {}) {
  const endpoint = options.endpoint || options.env?.VITE_WEB_VITALS_ENDPOINT;
  if (!endpoint) return null;
  return String(endpoint);
}

function toMetricRecord(metric, context = {}) {
  const ts = Date.now();
  const value = Number(metric?.value);
  const delta = Number(metric?.delta);

  return {
    name: String(metric?.name || "unknown"),
    id: String(metric?.id || `metric-${ts}`),
    value: Number.isFinite(value) ? value : null,
    delta: Number.isFinite(delta) ? delta : null,
    rating: metric?.rating ? String(metric.rating) : "unknown",
    navigationType: metric?.navigationType
      ? String(metric.navigationType)
      : "unknown",
    path: String(context.path || getPathname()),
    timestamp: ts,
  };
}

function appendRecord(record) {
  const current = readWebVitalsTelemetry();
  const events = [...current.events, record].slice(-MAX_RECORDS);
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    events,
  };
  writeJson(WEB_VITALS_STORAGE_KEY, next);
  return next;
}

function emitToSinks(record, options = {}) {
  if (!isBrowserRuntime()) return;

  try {
    window.analytics?.track?.("perf/web-vital", record);
  } catch {
    // Do not break metric collection when analytics sinks fail.
  }

  try {
    window.__suka?.eventBus?.emit?.("performance.web_vital", record);
  } catch {
    // Optional sink.
  }

  try {
    window.dispatchEvent(
      new CustomEvent("ssa.web-vitals", {
        detail: record,
      })
    );
  } catch {
    // Optional sink.
  }

  const endpoint = resolveTransport(options);
  if (!endpoint) return;

  const body = JSON.stringify(record);
  if (navigator?.sendBeacon) {
    try {
      navigator.sendBeacon(endpoint, body);
      return;
    } catch {
      // Fall through to fetch.
    }
  }

  try {
    fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Ignore transport errors.
  }
}

export function readWebVitalsTelemetry() {
  return (
    readJson(WEB_VITALS_STORAGE_KEY, {
      version: 1,
      updatedAt: null,
      events: [],
    }) || { version: 1, updatedAt: null, events: [] }
  );
}

export function clearWebVitalsTelemetry() {
  writeJson(WEB_VITALS_STORAGE_KEY, {
    version: 1,
    updatedAt: new Date().toISOString(),
    events: [],
  });
}

export function recordWebVitalMetric(metric, options = {}) {
  const record = toMetricRecord(metric, options);
  const snapshot = appendRecord(record);
  emitToSinks(record, options);
  return {
    record,
    snapshot,
  };
}

export async function initWebVitalsTelemetry(options = {}) {
  if (!shouldEnableCollection(options)) {
    return { enabled: false, reason: "disabled" };
  }

  if (window.__suka?.webVitalsTelemetry?.initialized) {
    return { enabled: true, reason: "already-initialized" };
  }

  const vitalsModule = options.vitalsModule || (await import("web-vitals"));

  const collect = (metric) => {
    recordWebVitalMetric(metric, options);
  };

  vitalsModule.onCLS?.(collect, { reportAllChanges: true });
  vitalsModule.onINP?.(collect, { reportAllChanges: true });
  vitalsModule.onLCP?.(collect, { reportAllChanges: true });
  vitalsModule.onFCP?.(collect, { reportAllChanges: true });
  vitalsModule.onTTFB?.(collect, { reportAllChanges: true });

  if (!window.__suka) window.__suka = {};
  window.__suka.webVitalsTelemetry = {
    initialized: true,
    startedAt: new Date().toISOString(),
    storageKey: WEB_VITALS_STORAGE_KEY,
    endpoint: resolveTransport(options),
  };

  return {
    enabled: true,
    storageKey: WEB_VITALS_STORAGE_KEY,
    endpoint: resolveTransport(options),
  };
}

export { WEB_VITALS_STORAGE_KEY };
