// File: src/agents/shimsClient.js
/**
 * shimsClient.js (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Browser-safe client for SSA "shims" (agent shims + intent routes).
 *  - Provides a single, consistent API that:
 *      • calls local shims (in-memory JS modules) when available
 *      • optionally calls remote HTTP endpoints when configured
 *      • enforces guardrails (timeouts, abort, safe payload sizes)
 *      • standardizes responses (ok/result/error/meta)
 *
 * Why this exists
 *  - SSA is primarily a deterministic household steward.
 *  - "Agents" are optional accelerators, and must never break builds.
 *  - Shims provide thin adapters around deterministic engines:
 *      • importSessionShim
 *      • blueprintBuilder shim
 *      • preference resolver shim
 *      • nutrition/meal planning shims
 *      • scan-compare-trust orchestrator shims
 *
 * Key decisions
 *  - No Node imports (browser-only).
 *  - No direct Dexie imports here (shims can import db if needed).
 *  - Supports "local-first": local shim registry resolves before remote.
 *
 * Usage
 *  import { shimsClient } from "@/agents/shimsClient";
 *  const res = await shimsClient.call("imports.ingest", { fileId, kind:"receipt" });
 *  if (res.ok) { ...res.result... } else { console.error(res.error) }
 */

import { isPlainObject, isArr, isStr, isNum, deepMerge } from "@/utils/obj";
import { nowISO } from "@/utils/dates";

/* -------------------------------- Constants -------------------------------- */

const SOURCE = "agents.shimsClient";

const DEFAULTS = Object.freeze({
  enabled: true,

  /**
   * If remoteBaseUrl is provided, shimsClient can call:
   *   POST ${remoteBaseUrl}/shims/<route>
   * by default, remote is disabled.
   */
  remote: {
    enabled: false,
    baseUrl: "", // e.g. "https://api.example.com"
    routePrefix: "/shims", // "/shims"
    headers: {}, // static headers
    authToken: "", // optional bearer
    timeoutMs: 15000,
    maxPayloadBytes: 250_000, // safety
    maxResponseBytes: 750_000, // safety (best-effort)
    mode: "cors", // fetch mode
    credentials: "omit", // fetch credentials
  },

  /**
   * Local shim registry.
   * - Populate by calling shimsClient.register(route, handler)
   * - Or by importing a registry module that registers at startup.
   */
  local: {
    enabled: true,
  },

  /**
   * Global call behavior
   */
  call: {
    timeoutMs: 12000,
    allowRemoteFallback: true,
    preferLocal: true,
    logErrors: true,
    includeDebugMeta: false,
  },
});

/* --------------------------------- State ----------------------------------- */

const state = {
  config: deepClone(DEFAULTS),
  registry: new Map(), // route -> handler(payload, ctx)
  middleware: {
    before: [], // fn({ route, payload, ctx }) => ({ route, payload, ctx })
    after: [], // fn({ route, payload, ctx, response }) => response
  },
};

/* ------------------------------ Public API ---------------------------------- */

export const shimsClient = Object.freeze({
  configure,
  getConfig,
  enableRemote,
  disableRemote,
  register,
  unregister,
  listRoutes,
  useBefore,
  useAfter,
  call,
  batch,
  healthcheck,
  __debugDump,
});

/**
 * Configure client behavior.
 * - Uses deep merge to avoid breaking existing config.
 */
function configure(partial = {}) {
  if (!isPlainObject(partial)) return getConfig();
  state.config = deepMerge(deepClone(state.config), partial);
  return getConfig();
}

function getConfig() {
  return deepClone(state.config);
}

function enableRemote(baseUrl, opts = {}) {
  const next = {
    remote: {
      enabled: true,
      baseUrl: isStr(baseUrl) ? baseUrl : state.config.remote.baseUrl,
      ...opts,
    },
  };
  return configure(next);
}

function disableRemote() {
  return configure({ remote: { enabled: false } });
}

/**
 * Register a local shim handler for a route.
 * - handler signature: async (payload, ctx) => result
 * - Route examples:
 *    "imports.ingest"
 *    "mealplan.recommend"
 *    "nutrition.macroTargets"
 */
function register(route, handler) {
  const r = normRoute(route);
  if (!r) throw new Error(`[${SOURCE}] register(): invalid route`);
  if (typeof handler !== "function")
    throw new Error(`[${SOURCE}] register(): handler must be function`);
  state.registry.set(r, handler);
  return true;
}

function unregister(route) {
  const r = normRoute(route);
  if (!r) return false;
  return state.registry.delete(r);
}

function listRoutes() {
  return Array.from(state.registry.keys()).sort();
}

/**
 * Add middleware that runs before dispatch.
 * - Can modify {route, payload, ctx}
 */
function useBefore(fn) {
  if (typeof fn !== "function") return false;
  state.middleware.before.push(fn);
  return true;
}

/**
 * Add middleware that runs after dispatch.
 * - Can modify standardized response
 */
function useAfter(fn) {
  if (typeof fn !== "function") return false;
  state.middleware.after.push(fn);
  return true;
}

/**
 * Call a shim route.
 *
 * @param {string} route
 * @param {any} payload
 * @param {object} options
 *  {
 *    timeoutMs,
 *    preferLocal,
 *    allowRemoteFallback,
 *    remoteOnly,
 *    localOnly,
 *    debugMeta,
 *    signal (AbortSignal)
 *    ctx: { ... } // optional context injected to shim handler
 *  }
 *
 * Standard response:
 *  {
 *    ok: boolean,
 *    route: string,
 *    source: "local"|"remote"|"none",
 *    result?: any,
 *    error?: { code, message, details? },
 *    meta: { startedAt, endedAt, ms, requestId, ... }
 *  }
 */
async function call(route, payload = null, options = {}) {
  const startedAt = Date.now();
  const requestId = makeRequestId(route);

  const cfg = state.config;
  const r = normRoute(route);
  if (!r)
    return fail("bad_route", "Invalid route", { route }, startedAt, requestId);

  if (!cfg.enabled) {
    return fail(
      "disabled",
      "Shims client is disabled",
      { route: r },
      startedAt,
      requestId
    );
  }

  // Build call options
  const opt = normalizeCallOptions(options, cfg);

  // Build ctx passed to shims
  let ctx = buildContext(r, payload, opt, requestId);

  // Run before middleware
  const beforeOut = await runBeforeMiddleware(r, payload, ctx);
  if (!beforeOut.ok) {
    return fail(
      "middleware_before_failed",
      beforeOut.message,
      beforeOut.details,
      startedAt,
      requestId
    );
  }
  const route2 = beforeOut.route;
  const payload2 = beforeOut.payload;
  ctx = beforeOut.ctx;

  // Dispatch order
  const allowLocal =
    cfg.local.enabled && !opt.remoteOnly && opt.localOnly !== true;
  const allowRemote =
    cfg.remote.enabled &&
    cfg.remote.baseUrl &&
    !opt.localOnly &&
    opt.remoteOnly !== true &&
    (opt.allowRemoteFallback || opt.remoteOnly);

  const preferLocal = opt.preferLocal && allowLocal;

  let response = null;

  if (preferLocal) {
    response = await tryLocal(route2, payload2, ctx, opt);
    if (!response.ok && allowRemote) {
      response = await tryRemote(route2, payload2, ctx, opt);
    }
  } else {
    if (allowRemote) {
      response = await tryRemote(route2, payload2, ctx, opt);
      if (!response.ok && allowLocal) {
        response = await tryLocal(route2, payload2, ctx, opt);
      }
    } else if (allowLocal) {
      response = await tryLocal(route2, payload2, ctx, opt);
    }
  }

  if (!response) {
    response = fail(
      "no_dispatch",
      "No dispatch path available",
      { route: route2 },
      startedAt,
      requestId
    );
  }

  // Run after middleware
  const afterOut = await runAfterMiddleware(route2, payload2, ctx, response);
  response = afterOut.ok ? afterOut.response : response;

  // final meta
  response.meta = response.meta || {};
  response.meta.startedAt =
    response.meta.startedAt || new Date(startedAt).toISOString();
  response.meta.endedAt = new Date().toISOString();
  response.meta.ms = Date.now() - startedAt;
  response.meta.requestId = requestId;

  // optional debug
  if (opt.debugMeta || cfg.call.includeDebugMeta) {
    response.meta.debug = {
      route: route2,
      preferLocal: opt.preferLocal,
      allowRemoteFallback: opt.allowRemoteFallback,
      localOnly: opt.localOnly,
      remoteOnly: opt.remoteOnly,
      registryHasRoute: state.registry.has(route2),
    };
  }

  return response;
}

/**
 * Batch call shims with concurrency control.
 * items: [{ route, payload, options }]
 */
async function batch(items = [], opts = {}) {
  const list = isArr(items) ? items : [];
  const concurrency = Math.max(1, Math.floor(safeNum(opts.concurrency, 4)));
  const results = new Array(list.length);

  let idx = 0;
  const workers = new Array(concurrency).fill(0).map(async () => {
    while (idx < list.length) {
      const my = idx++;
      const it = list[my] || {};
      results[my] = await call(it.route, it.payload, it.options);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Healthcheck:
 * - returns local registry info and remote reachability (best-effort).
 */
async function healthcheck(opts = {}) {
  const cfg = state.config;

  const out = {
    ok: true,
    source: SOURCE,
    timeISO: nowISO ? nowISO() : new Date().toISOString(),
    local: {
      enabled: !!cfg.local.enabled,
      routes: listRoutes(),
    },
    remote: {
      enabled: !!cfg.remote.enabled,
      baseUrl: cfg.remote.baseUrl || "",
      reachable: null,
    },
  };

  if (cfg.remote.enabled && cfg.remote.baseUrl && opts.checkRemote) {
    try {
      // ping endpoint (optional convention)
      const url = joinUrl(
        cfg.remote.baseUrl,
        cfg.remote.routePrefix,
        "/health"
      );
      const res = await fetch(url, { method: "GET", mode: cfg.remote.mode });
      out.remote.reachable = !!res.ok;
      out.ok = out.ok && !!res.ok;
    } catch {
      out.remote.reachable = false;
      out.ok = false;
    }
  }

  return out;
}

/* ------------------------------- Dispatchers -------------------------------- */

async function tryLocal(route, payload, ctx, opt) {
  const startedAt = Date.now();
  const handler = state.registry.get(route);

  if (!handler) {
    return fail(
      "not_found",
      "No local shim registered for route",
      { route },
      startedAt,
      ctx?.requestId
    );
  }

  try {
    const { signal, timeoutMs } = opt;
    const res = await withTimeout(
      Promise.resolve(handler(payload, ctx)),
      timeoutMs,
      signal,
      "Local shim timed out"
    );

    return ok("local", route, res, startedAt, ctx?.requestId);
  } catch (e) {
    if (opt.logErrors) logErr("[shimsClient] local shim failed", route, e);
    return fail(
      "local_error",
      e?.message || "Local shim error",
      { route, stack: e?.stack, name: e?.name },
      startedAt,
      ctx?.requestId
    );
  }
}

async function tryRemote(route, payload, ctx, opt) {
  const startedAt = Date.now();
  const cfg = state.config.remote;

  if (!cfg.enabled || !cfg.baseUrl) {
    return fail(
      "remote_disabled",
      "Remote shims disabled",
      { route },
      startedAt,
      ctx?.requestId
    );
  }

  // safety: payload size
  const payloadBytes = approximateJsonBytes(payload);
  const maxPayload = safeNum(cfg.maxPayloadBytes, 250_000);
  if (payloadBytes > maxPayload) {
    return fail(
      "payload_too_large",
      `Payload exceeds maxPayloadBytes (${payloadBytes} > ${maxPayload})`,
      { route, payloadBytes, maxPayloadBytes: maxPayload },
      startedAt,
      ctx?.requestId
    );
  }

  const url = joinUrl(
    cfg.baseUrl,
    cfg.routePrefix,
    `/${encodeURIComponent(route)}`
  );

  const headers = {
    "Content-Type": "application/json",
    "X-SSA-Shim-Route": route,
    "X-SSA-Request-Id": ctx?.requestId || "",
    ...(isPlainObject(cfg.headers) ? cfg.headers : {}),
  };

  const token = isStr(cfg.authToken) ? cfg.authToken.trim() : "";
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const chainedSignal = mergeAbortSignals(opt.signal, controller.signal);
  const timeoutMs = safeNum(opt.timeoutMs, cfg.timeoutMs);

  const body = JSON.stringify({
    route,
    payload,
    ctx: sanitizeCtxForRemote(ctx),
  });

  try {
    const res = await withTimeout(
      fetch(url, {
        method: "POST",
        mode: cfg.mode || "cors",
        credentials: cfg.credentials || "omit",
        headers,
        body,
        signal: chainedSignal,
      }),
      timeoutMs,
      chainedSignal,
      "Remote shim timed out"
    );

    const text = await safeReadText(
      res,
      safeNum(cfg.maxResponseBytes, 750_000)
    );
    if (!res.ok) {
      return fail(
        "remote_http_error",
        `Remote responded ${res.status}`,
        { route, status: res.status, body: text },
        startedAt,
        ctx?.requestId
      );
    }

    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (e) {
      return fail(
        "remote_bad_json",
        "Remote returned non-JSON response",
        { route, body: text?.slice(0, 500) },
        startedAt,
        ctx?.requestId
      );
    }

    // Accept either {ok,result,error,meta} or raw value.
    if (isPlainObject(parsed) && typeof parsed.ok === "boolean") {
      // normalize meta
      const out = {
        ok: !!parsed.ok,
        route,
        source: "remote",
        ...(parsed.ok
          ? { result: parsed.result }
          : { error: parsed.error || { message: "Remote error" } }),
        meta: {
          ...(isPlainObject(parsed.meta) ? parsed.meta : {}),
          httpStatus: res.status,
        },
      };
      return out;
    }

    return ok("remote", route, parsed, startedAt, ctx?.requestId);
  } catch (e) {
    if (opt.logErrors) logErr("[shimsClient] remote shim failed", route, e);
    return fail(
      "remote_error",
      e?.message || "Remote shim error",
      { route, stack: e?.stack, name: e?.name },
      startedAt,
      ctx?.requestId
    );
  }
}

/* ------------------------------ Middleware ---------------------------------- */

async function runBeforeMiddleware(route, payload, ctx) {
  let r = route;
  let p = payload;
  let c = ctx;

  for (const fn of state.middleware.before) {
    try {
      const out = await fn({ route: r, payload: p, ctx: c });
      if (out && isPlainObject(out)) {
        if (isStr(out.route)) r = normRoute(out.route) || r;
        if ("payload" in out) p = out.payload;
        if ("ctx" in out && isPlainObject(out.ctx)) c = out.ctx;
      }
    } catch (e) {
      return {
        ok: false,
        message: e?.message || "before middleware failed",
        details: { route: r },
      };
    }
  }

  return { ok: true, route: r, payload: p, ctx: c };
}

async function runAfterMiddleware(route, payload, ctx, response) {
  let resp = response;

  for (const fn of state.middleware.after) {
    try {
      const out = await fn({ route, payload, ctx, response: resp });
      if (out && isPlainObject(out) && typeof out.ok === "boolean") {
        resp = out;
      }
    } catch {
      // ignore after errors to avoid breaking callers
    }
  }

  return { ok: true, response: resp };
}

/* -------------------------------- Context ---------------------------------- */

function buildContext(route, payload, opt, requestId) {
  const base = {
    requestId,
    route,
    timeISO: new Date().toISOString(),
    caller: opt.caller || "ui",
    // house/user ids can be set by caller in options.ctx
    ...((isPlainObject(opt.ctx) && opt.ctx) || {}),
  };

  return base;
}

function sanitizeCtxForRemote(ctx) {
  // Keep ctx small and non-sensitive by default.
  if (!isPlainObject(ctx)) return {};
  const out = {
    requestId: ctx.requestId,
    route: ctx.route,
    timeISO: ctx.timeISO,
    caller: ctx.caller,
    activeHouseholdId: ctx.activeHouseholdId,
    activeUserId: ctx.activeUserId,
    locale: ctx.locale,
    timezone: ctx.timezone,
  };
  // Include any explicitly allowed fields
  if (isPlainObject(ctx.allowRemoteCtx)) {
    for (const [k, v] of Object.entries(ctx.allowRemoteCtx)) out[k] = v;
  }
  return out;
}

/* --------------------------------- Options --------------------------------- */

function normalizeCallOptions(options, cfg) {
  const o = isPlainObject(options) ? options : {};

  const timeoutMs = safeNum(o.timeoutMs, cfg.call.timeoutMs);
  const preferLocal =
    o.preferLocal !== undefined ? !!o.preferLocal : !!cfg.call.preferLocal;
  const allowRemoteFallback =
    o.allowRemoteFallback !== undefined
      ? !!o.allowRemoteFallback
      : !!cfg.call.allowRemoteFallback;

  return {
    timeoutMs: Math.max(250, timeoutMs),
    preferLocal,
    allowRemoteFallback,
    remoteOnly: !!o.remoteOnly,
    localOnly: !!o.localOnly,
    logErrors: o.logErrors !== undefined ? !!o.logErrors : !!cfg.call.logErrors,
    debugMeta: !!o.debugMeta,
    caller: isStr(o.caller) ? o.caller : undefined,
    ctx: isPlainObject(o.ctx) ? o.ctx : undefined,
    signal: o.signal instanceof AbortSignal ? o.signal : undefined,
  };
}

/* -------------------------------- Responses -------------------------------- */

function ok(source, route, result, startedAt, requestId) {
  return {
    ok: true,
    route,
    source,
    result,
    meta: {
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      ms: Date.now() - startedAt,
      requestId: requestId || "",
    },
  };
}

function fail(code, message, details, startedAt, requestId) {
  return {
    ok: false,
    route: details?.route || "",
    source: "none",
    error: {
      code: String(code || "error"),
      message: String(message || "Error"),
      ...(details ? { details } : {}),
    },
    meta: {
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      ms: Date.now() - startedAt,
      requestId: requestId || "",
    },
  };
}

/* ------------------------------- Utilities ---------------------------------- */

function normRoute(route) {
  const s = normStr(route);
  if (!s) return "";
  // allow dot or slash; normalize to dot
  return s
    .replace(/\//g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

function makeRequestId(route) {
  // stable-ish unique id
  const r = normRoute(route);
  const rand = Math.random().toString(16).slice(2);
  return `${r || "shim"}_${Date.now()}_${rand}`;
}

function deepClone(x) {
  // safer than JSON for many SSA objects? keep simple for config
  if (!isPlainObject(x) && !Array.isArray(x)) return x;
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    // fallback shallow-ish
    if (Array.isArray(x)) return x.slice();
    return { ...x };
  }
}

function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function approximateJsonBytes(obj) {
  try {
    return new Blob([JSON.stringify(obj)]).size;
  } catch {
    // rough fallback
    try {
      return String(obj).length * 2;
    } catch {
      return 0;
    }
  }
}

function joinUrl(base, prefix, path) {
  const b = String(base || "").replace(/\/+$/g, "");
  const p = String(prefix || "").trim();
  const pr = p ? `/${p.replace(/^\/+|\/+$/g, "")}` : "";
  const pa = String(path || "").trim();
  const pt = pa ? `/${pa.replace(/^\/+/g, "")}` : "";
  return `${b}${pr}${pt}`;
}

function mergeAbortSignals(a, b) {
  // If either aborts, abort merged controller.
  // Here we return one signal; fetch takes single signal.
  // We emulate "merge" by listening to both and aborting a controller.
  const controller = new AbortController();

  const onAbort = () => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  };

  if (a) {
    if (a.aborted) onAbort();
    else a.addEventListener("abort", onAbort, { once: true });
  }
  if (b) {
    if (b.aborted) onAbort();
    else b.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}

async function withTimeout(
  promise,
  timeoutMs,
  signal,
  timeoutMessage = "Timed out"
) {
  const ms = Math.max(1, Math.floor(timeoutMs || 0));
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let t = null;
  const controller = new AbortController();
  const merged = mergeAbortSignals(signal, controller.signal);

  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
      const err = new Error(timeoutMessage);
      err.code = "timeout";
      reject(err);
    }, ms);
  });

  try {
    // If promise is a fetch, it should respect merged signal when passed at callsite.
    // Here we just race timeouts for generic promises.
    return await Promise.race([promise, timeout]);
  } finally {
    if (t) clearTimeout(t);
    // avoid unused merged; it exists for conceptual consistency
    void merged;
  }
}

async function safeReadText(response, maxBytes) {
  const max = Math.max(10_000, Math.floor(safeNum(maxBytes, 750_000)));
  // Prefer response.clone().text() and then clamp; we can't reliably stream-limit everywhere.
  const txt = await response.text();
  // best-effort clamp
  if (txt && txt.length > max) return txt.slice(0, max);
  return txt;
}

function logErr(prefix, route, e) {
  try {
    // eslint-disable-next-line no-console
    console.warn(prefix, route, e?.message || e);
  } catch {
    // ignore
  }
}

/* ----------------------------- Debug / Introspection ------------------------- */

function __debugDump() {
  return {
    source: SOURCE,
    config: getConfig(),
    routes: listRoutes(),
    middleware: {
      before: state.middleware.before.length,
      after: state.middleware.after.length,
    },
  };
}
