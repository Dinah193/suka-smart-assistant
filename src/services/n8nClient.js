// C:\Users\larho\suka-smart-assistant\src\services\n8nClient.js
/**
 * n8nClient (resilient, orchestration-friendly)
 * ---------------------------------------------
 * A resilient client for triggering n8n webhooks and calling the n8n Public API.
 *
 * Env vars:
 *   N8N_BASE_URL         e.g. https://automations.yourdomain.com
 *   N8N_API_KEY          Public API key (Enterprise/Cloud/Pro; or self-hosted public API)
 *   N8N_WEBHOOK_SECRET   Shared secret for HMAC signing to your Webhook node (optional)
 *   N8N_TIMEOUT_MS       Request timeout (default 20000)
 *   N8N_RETRY_MAX        Max retries on 429/5xx (default 3)
 *   N8N_RETRY_BASE_MS    Base backoff ms (default 400)
 *   N8N_NAME_CACHE_TTL   ms for workflow name->id cache (default 300000 = 5m)
 *   N8N_CB_OPEN_MS       Circuit breaker open cooldown ms (default 15000)
 */

const axios = require("axios");
const crypto = require("crypto");
const ms = require("ms");
const { URL } = require("url");

/* -------------------------------------------
   Config
--------------------------------------------*/
const BASE_URL = process.env.N8N_BASE_URL?.replace(/\/+$/, "") || "http://localhost:5678";
const API_KEY = process.env.N8N_API_KEY || "";
const WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET || "";
const TIMEOUT = Number(process.env.N8N_TIMEOUT_MS || 20000);
const RETRY_MAX = Number(process.env.N8N_RETRY_MAX || 3);
const RETRY_BASE_MS = Number(process.env.N8N_RETRY_BASE_MS || 400);
const NAME_CACHE_TTL = Number(process.env.N8N_NAME_CACHE_TTL || 300_000);
const CB_OPEN_MS = Number(process.env.N8N_CB_OPEN_MS || 15_000);

/* -------------------------------------------
   Axios instances
--------------------------------------------*/
const commonHeaders = API_KEY ? { "X-N8N-API-KEY": API_KEY } : {};
const api = axios.create({
  baseURL: `${BASE_URL}/api/v1`,
  timeout: TIMEOUT,
  headers: commonHeaders,
});
const rest = axios.create({
  baseURL: `${BASE_URL}/rest`,
  timeout: TIMEOUT,
  headers: commonHeaders,
});
const raw = axios.create({ timeout: TIMEOUT });

/* -------------------------------------------
   Internal state (cache + circuit breaker)
--------------------------------------------*/
const _nameIdCache = new Map(); // name -> { id, ts }
let _cbOpenUntil = 0;

/* -------------------------------------------
   Helpers
--------------------------------------------*/
const sleep = (n) => new Promise((r) => setTimeout(r, n));

function computeHmacSignature({ secret, bodyString, timestamp }) {
  const payload = `${timestamp}.${bodyString}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function webhookHeaders(body, extra = {}) {
  if (!WEBHOOK_SECRET) return { "content-type": "application/json", ...extra };
  const ts = Date.now().toString();
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const sig = computeHmacSignature({ secret: WEBHOOK_SECRET, bodyString: bodyStr, timestamp: ts });
  return {
    "content-type": "application/json",
    "x-n8n-timestamp": ts,
    "x-n8n-signature": sig,
    ...extra,
  };
}

function normErr(e) {
  if (e?.response) {
    const { status, data, config, headers } = e.response;
    const method = (config?.method || "GET").toUpperCase();
    const url = config?.url || "";
    const msg = data?.message || e.message || "n8n API error";
    const err = new Error(`n8n ${method} ${url} -> ${status}: ${msg}`);
    err.status = status;
    err.data = data;
    err.method = method;
    err.path = url;
    err.headers = headers;
    return err;
  }
  return e;
}

function jitteredBackoff(base, attempt) {
  const expo = Math.pow(2, attempt);
  const rawDelay = base * expo;
  // +/- 20% jitter
  const jitter = rawDelay * (0.6 + Math.random() * 0.8);
  return Math.max(50, Math.min(jitter, 30_000));
}

function honorRetryAfter(err, fallbackMs) {
  const ra = err?.headers?.["retry-after"];
  if (!ra) return fallbackMs;
  const n = Number(ra);
  if (!Number.isNaN(n)) return Math.max(fallbackMs, n * 1000);
  // HTTP-date not handled -> fallback
  return fallbackMs;
}

async function resilientRequest(fn) {
  let attempt = 0;
  for (;;) {
    const now = Date.now();
    if (_cbOpenUntil && now < _cbOpenUntil) {
      // Circuit open
      const wait = Math.max(1, _cbOpenUntil - now);
      await sleep(wait);
    }

    try {
      const out = await fn();
      // Close circuit on success
      _cbOpenUntil = 0;
      return out;
    } catch (errRaw) {
      const err = normErr(errRaw);
      const retryable =
        !err.status ||
        err.status === 408 ||
        err.status === 409 || // some nodes can return lock/queue signals
        err.status === 425 ||
        err.status === 429 ||
        (err.status >= 500 && err.status <= 599);

      if (!retryable || attempt >= RETRY_MAX) {
        // Open circuit briefly on hard failure
        _cbOpenUntil = Date.now() + CB_OPEN_MS;
        throw err;
      }
      let delay = jitteredBackoff(RETRY_BASE_MS, attempt);
      if (err.status === 429) delay = honorRetryAfter(err, delay);
      await sleep(delay);
      attempt += 1;
    }
  }
}

function withIdempotency(headers, idempotencyKey) {
  if (!idempotencyKey) return headers;
  return { ...headers, "Idempotency-Key": String(idempotencyKey) };
}

/* -------------------------------------------
   Public API: Workflows & Executions
--------------------------------------------*/

/**
 * Run workflow by ID.
 * @param {string} workflowId
 * @param {object} payload
 * @param {object} opts { waitForFinish?: boolean, pollIntervalMs?: number, timeoutMs?: number, idempotencyKey?: string, meta?: {tenantId?, userId?} }
 */
async function runWorkflow(workflowId, payload = {}, opts = {}) {
  const {
    waitForFinish = false,
    pollIntervalMs = 1200,
    timeoutMs = 90_000,
    idempotencyKey = undefined,
    meta = undefined,
  } = opts;

  const body = meta ? { ...payload, _meta: meta } : payload;

  let res;
  try {
    res = await resilientRequest(() =>
      api.post(
        `/workflows/${encodeURIComponent(workflowId)}/run`,
        body,
        { headers: withIdempotency(commonHeaders, idempotencyKey) }
      )
    );
  } catch (_) {
    res = await resilientRequest(() =>
      rest.post(
        `/workflows/${encodeURIComponent(workflowId)}/run`,
        body,
        { headers: withIdempotency(commonHeaders, idempotencyKey) }
      )
    );
  }

  const executionId = res?.data?.executionId || res?.data?.id || res?.data?.data?.id;
  if (!waitForFinish || !executionId) return { executionId, data: res?.data };

  const start = Date.now();
  for (;;) {
    const info = await getExecution(executionId);
    const status = info?.status || info?.data?.status || info?.state;
    if (["success", "error", "crashed", "canceled"].includes(status)) return { executionId, ...info };
    if (Date.now() - start > timeoutMs) {
      throw new Error(`n8n runWorkflow timed out after ${ms(timeoutMs)} (executionId=${executionId})`);
    }
    await sleep(pollIntervalMs);
  }
}

/** Run workflow by name (cached name→id lookup, optional tag filter) */
async function runWorkflowByName(name, payload = {}, opts = {}) {
  const { tag = undefined, cacheTtl = NAME_CACHE_TTL, ...restOpts } = opts;

  const cached = _nameIdCache.get(name);
  if (cached && Date.now() - cached.ts < cacheTtl) {
    return runWorkflow(cached.id, payload, restOpts);
  }

  const wf = await findWorkflowByName(name, { tag });
  if (!wf?.id) throw new Error(`Workflow not found by name "${name}"${tag ? ` (tag=${tag})` : ""}`);
  _nameIdCache.set(name, { id: wf.id, ts: Date.now() });

  return runWorkflow(wf.id, payload, restOpts);
}

/** Get execution by ID */
async function getExecution(executionId) {
  try {
    const r = await resilientRequest(() => api.get(`/executions/${encodeURIComponent(executionId)}`));
    return r.data;
  } catch (_) {
    const r = await resilientRequest(() => rest.get(`/executions/${encodeURIComponent(executionId)}`));
    return r.data;
  }
}

/** List executions (supports typical filters) */
async function listExecutions(params = {}) {
  try {
    const r = await resilientRequest(() => api.get("/executions", { params }));
    return r.data;
  } catch (_) {
    const r = await resilientRequest(() => rest.get("/executions", { params }));
    return r.data;
  }
}

/** Cancel an execution (if supported) */
async function cancelExecution(executionId) {
  try {
    const r = await resilientRequest(() => api.delete(`/executions/${encodeURIComponent(executionId)}`));
    return r.data;
  } catch (_) {
    const r = await resilientRequest(() => rest.delete(`/executions/${encodeURIComponent(executionId)}`));
    return r.data;
  }
}

/* -------------------------------------------
   Workflows meta
--------------------------------------------*/

async function getWorkflow(workflowId) {
  try {
    const r = await resilientRequest(() => api.get(`/workflows/${encodeURIComponent(workflowId)}`));
    return r.data;
  } catch (_) {
    const r = await resilientRequest(() => rest.get(`/workflows/${encodeURIComponent(workflowId)}`));
    return r.data;
  }
}

async function listWorkflows(params = {}) {
  try {
    const r = await resilientRequest(() => api.get("/workflows", { params }));
    return r.data;
  } catch (_) {
    const r = await resilientRequest(() => rest.get("/workflows", { params }));
    return r.data;
  }
}

/** Find one workflow by exact name (optionally by tag) */
async function findWorkflowByName(name, { tag } = {}) {
  const params = tag ? { tags: tag } : {};
  const list = await listWorkflows(params);
  if (!Array.isArray(list)) return null;
  return list.find((w) => w?.name === name) || null;
}

async function listWorkflowsByTag(tag) {
  const list = await listWorkflows({ tags: tag });
  return Array.isArray(list) ? list : [];
}

/* -------------------------------------------
   Webhooks
--------------------------------------------*/

/**
 * Trigger an n8n webhook URL (production/test), optionally with signing & query merge.
 * @param {string} webhookUrl
 * @param {object} opts { method?: 'POST'|'GET'|'PUT'|'PATCH'|'DELETE', body?: any, headers?: object, sign?: boolean, query?: object, idempotencyKey?: string }
 */
async function triggerWebhook(webhookUrl, opts = {}) {
  const method = (opts.method || "POST").toUpperCase();
  const body = opts.body ?? {};
  const query = opts.query || {};
  const idk = opts.idempotencyKey;

  // merge query params into URL safely
  const u = new URL(webhookUrl, BASE_URL);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }

  const headersBase = opts.sign
    ? webhookHeaders(body, opts.headers)
    : { "content-type": "application/json", ...(opts.headers || {}) };

  const headers = withIdempotency(headersBase, idk);
  const data = method === "GET" || method === "DELETE" ? undefined : body;

  const res = await resilientRequest(() =>
    raw.request({ url: u.toString(), method, headers, data })
  );
  return res.data;
}

/** Build a production webhook URL from a hash + optional suffix */
function buildWebhookUrl(webhookHash, suffix = "") {
  const clean = String(suffix || "").replace(/^\/+/, "");
  return `${BASE_URL}/webhook/${webhookHash}${clean ? `/${clean}` : ""}`;
}

/** Build a test webhook URL from a hash + optional suffix */
function buildTestWebhookUrl(webhookHash, suffix = "") {
  const clean = String(suffix || "").replace(/^\/+/, "");
  return `${BASE_URL}/webhook-test/${webhookHash}${clean ? `/${clean}` : ""}`;
}

/* -------------------------------------------
   Misc
--------------------------------------------*/

async function ping() {
  try {
    const r = await resilientRequest(() => api.get("/me"));
    return { ok: true, via: "api", data: r.data };
  } catch (_) {
    try {
      const r2 = await resilientRequest(() => rest.get("/ping"));
      return { ok: true, via: "rest", data: r2.data };
    } catch (e2) {
      throw normErr(e2);
    }
  }
}

/**
 * Fluent helper: inject default meta (tenant/user) into run calls.
 * Usage:
 *   const n8n = withMeta({ tenantId, userId });
 *   await n8n.runWorkflow("123", { foo: "bar" });
 */
function withMeta(meta = {}) {
  return {
    runWorkflow: (id, payload = {}, opts = {}) =>
      runWorkflow(id, payload, { ...opts, meta: { ...(opts.meta || {}), ...meta } }),
    runWorkflowByName: (name, payload = {}, opts = {}) =>
      runWorkflowByName(name, payload, { ...opts, meta: { ...(opts.meta || {}), ...meta } }),
    triggerWebhook: (url, opts = {}) => triggerWebhook(url, opts),
    getExecution,
    listExecutions,
    cancelExecution,
    getWorkflow,
    listWorkflows,
    listWorkflowsByTag,
    findWorkflowByName,
    ping,
    buildWebhookUrl,
    buildTestWebhookUrl,
  };
}

/* -------------------------------------------
   Exports
--------------------------------------------*/
module.exports = {
  // config
  BASE_URL,
  API_KEY,
  WEBHOOK_SECRET,

  // workflow & execution
  runWorkflow,
  runWorkflowByName,
  getExecution,
  listExecutions,
  cancelExecution,
  getWorkflow,
  listWorkflows,
  listWorkflowsByTag,
  findWorkflowByName,

  // webhooks
  triggerWebhook,
  buildWebhookUrl,
  buildTestWebhookUrl,

  // misc
  ping,
  withMeta,
};
