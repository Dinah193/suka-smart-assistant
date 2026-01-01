// C:\Users\larho\suka-smart-assistant\src\server\services\n8nClient.js
//
// Suka Smart Assistant — n8n Client (Dynamic, ESM)
//
// Purpose:
//   Resilient client for calling n8n Public API and Webhook nodes.
//   - Public API first, /rest fallback
//   - Retries with backoff + jitter, small circuit breaker
//   - Optional HMAC signing for Webhook nodes
//   - Per-call overrides (baseURL, apiKey, timeout)
//   - Idempotency keys & Suka tracing headers
//   - Convenience helpers to ship Suka entity payloads (n8n-friendly)
//
// Env:
//   N8N_BASE_URL
//   N8N_API_KEY
//   N8N_WEBHOOK_SECRET
//   N8N_TIMEOUT_MS (default: 20000)
//   N8N_RETRY_MAX (default: 3)
//   N8N_RETRY_BASE_MS (default: 400)
//   N8N_BREAKER_THRESHOLD (default: 5)
//   N8N_BREAKER_COOLDOWN_MS (default: 15000)
//

import axios from "axios";
import crypto from "node:crypto";

const ENV = {
  BASE_URL: (process.env.N8N_BASE_URL || "http://localhost:5678").replace(/\/+$/, ""),
  API_KEY: process.env.N8N_API_KEY || "",
  WEBHOOK_SECRET: process.env.N8N_WEBHOOK_SECRET || "",
  TIMEOUT: Number(process.env.N8N_TIMEOUT_MS || 20000),
  RETRY_MAX: Number(process.env.N8N_RETRY_MAX || 3),
  RETRY_BASE_MS: Number(process.env.N8N_RETRY_BASE_MS || 400),
  BREAKER_THRESHOLD: Number(process.env.N8N_BREAKER_THRESHOLD || 5),
  BREAKER_COOLDOWN_MS: Number(process.env.N8N_BREAKER_COOLDOWN_MS || 15000),
};

// ---- Axios instances (created lazily to honor per-call overrides) -----------
function buildClients({ baseURL = ENV.BASE_URL, apiKey = ENV.API_KEY, timeout = ENV.TIMEOUT } = {}) {
  const headers = apiKey ? { "X-N8N-API-KEY": apiKey } : {};
  const api = axios.create({ baseURL: `${baseURL}/api/v1`, timeout, headers });
  const rest = axios.create({ baseURL: `${baseURL}/rest`, timeout, headers });
  const raw = axios.create({ timeout });
  return { api, rest, raw, baseURL, apiKey, timeout };
}

// ---- Resilience: backoff + breaker ------------------------------------------
const breaker = {
  state: "CLOSED", // CLOSED | OPEN | HALF
  failures: 0,
  nextTryAt: 0,
};
function breakerOk() {
  if (breaker.state === "OPEN" && Date.now() >= breaker.nextTryAt) {
    breaker.state = "HALF";
  }
  return breaker.state !== "OPEN";
}
function noteSuccess() {
  breaker.failures = 0;
  breaker.state = "CLOSED";
}
function noteFailure() {
  breaker.failures += 1;
  if (breaker.failures >= ENV.BREAKER_THRESHOLD) {
    breaker.state = "OPEN";
    breaker.nextTryAt = Date.now() + ENV.BREAKER_COOLDOWN_MS;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeErr(e) {
  if (e?.response) {
    const { status, data, config } = e.response;
    const path = config?.url;
    const method = config?.method;
    const msg = data?.message || e.message || "n8n API error";
    const err = new Error(`n8n ${method?.toUpperCase()} ${path} -> ${status}: ${msg}`);
    err.status = status;
    err.data = data;
    err.path = path;
    err.method = method;
    return err;
  }
  return e;
}

async function resilientRequest(doRequest, { retryMax = ENV.RETRY_MAX, retryBaseMs = ENV.RETRY_BASE_MS } = {}) {
  if (!breakerOk()) {
    const err = new Error("n8n circuit breaker open; skipping request temporarily");
    err.status = 503;
    throw err;
  }

  let attempt = 0;
  while (attempt <= retryMax) {
    try {
      const res = await doRequest();
      noteSuccess();
      return res;
    } catch (e) {
      const err = normalizeErr(e);
      const retryable = !err.status || err.status === 408 || err.status === 429 || (err.status >= 500 && err.status <= 599);
      if (!retryable || attempt === retryMax) {
        noteFailure();
        throw err;
      }
      const backoff = Math.round(retryBaseMs * Math.pow(2, attempt) + Math.random() * 125);
      await sleep(backoff);
      attempt += 1;
      // If we were in HALF and a retry happens, keep breaker HALF until final failure.
    }
  }
  // Should not reach here
  const err = new Error("Unknown n8n request error");
  err.status = 520;
  throw err;
}

// ---- Signing & headers -------------------------------------------------------
function computeHmacSignature({ secret, bodyString, timestamp }) {
  const payload = `${timestamp}.${bodyString}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function makeWebhookHeaders(body, { sign = !!ENV.WEBHOOK_SECRET, extra = {}, idempotencyKey, userId, homeId, source, correlationId } = {}) {
  const base = { "content-type": "application/json" };
  const tracing = {
    ...(userId ? { "X-Suka-User": String(userId) } : {}),
    ...(homeId ? { "X-Suka-Home": String(homeId) } : {}),
    ...(source ? { "X-Suka-Source": String(source) } : {}),
    ...(correlationId ? { "X-Correlation-Id": String(correlationId) } : {}),
  };
  const idem = idempotencyKey ? { "Idempotency-Key": String(idempotencyKey) } : {};
  if (!sign) return { ...base, ...idem, ...tracing, ...(extra || {}) };

  const ts = Date.now().toString();
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const sig = computeHmacSignature({ secret: ENV.WEBHOOK_SECRET, bodyString: bodyStr, timestamp: ts });
  return {
    ...base,
    ...idem,
    ...tracing,
    "x-n8n-timestamp": ts,
    "x-n8n-signature": sig,
    ...(extra || {}),
  };
}

function sukaHeaders({ userId, homeId, source, correlationId, idempotencyKey } = {}) {
  return makeWebhookHeaders("", { sign: false, idempotencyKey, userId, homeId, source, correlationId });
}

// ---- Public API: workflows & executions -------------------------------------
/**
 * Run workflow by ID.
 * opts: { waitForFinish, pollIntervalMs, timeoutMs, baseURL, apiKey, timeout, idempotencyKey, userId, homeId, source, correlationId }
 */
export async function runWorkflow(workflowId, payload = {}, opts = {}) {
  const { waitForFinish = false, pollIntervalMs = 1000, timeoutMs = 60_000, idempotencyKey } = opts;
  const { api, rest } = buildClients(opts);
  const headers = { ...sukaHeaders(opts), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) };

  let res;
  try {
    res = await resilientRequest(() => api.post(`/workflows/${encodeURIComponent(workflowId)}/run`, payload, { headers }));
  } catch {
    res = await resilientRequest(() => rest.post(`/workflows/${encodeURIComponent(workflowId)}/run`, payload, { headers }));
  }

  const { data } = res || {};
  const executionId = data?.executionId || data?.id || data?.data?.id;
  if (!waitForFinish || !executionId) return { executionId, data };

  const started = Date.now();
  while (true) {
    const exec = await getExecution(executionId, opts);
    const status = exec?.status || exec?.data?.status || exec?.state;
    if (["success", "error", "crashed", "canceled"].includes(status)) return exec;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`n8n runWorkflow wait timed out after ${timeoutMs}ms (executionId=${executionId})`);
    }
    await sleep(pollIntervalMs);
  }
}

export async function getExecution(executionId, opts = {}) {
  const { api, rest } = buildClients(opts);
  try {
    const r = await resilientRequest(() => api.get(`/executions/${encodeURIComponent(executionId)}`, { headers: sukaHeaders(opts) }));
    return r.data;
  } catch {
    const r = await resilientRequest(() => rest.get(`/executions/${encodeURIComponent(executionId)}`, { headers: sukaHeaders(opts) }));
    return r.data;
  }
}

export async function listExecutions(params = {}, opts = {}) {
  const { api, rest } = buildClients(opts);
  try {
    const r = await resilientRequest(() => api.get("/executions", { params, headers: sukaHeaders(opts) }));
    return r.data;
  } catch {
    const r = await resilientRequest(() => rest.get("/executions", { params, headers: sukaHeaders(opts) }));
    return r.data;
  }
}

export async function cancelExecution(executionId, opts = {}) {
  const { api, rest } = buildClients(opts);
  try {
    const r = await resilientRequest(() => api.delete(`/executions/${encodeURIComponent(executionId)}`, { headers: sukaHeaders(opts) }));
    return r.data;
  } catch {
    const r = await resilientRequest(() => rest.delete(`/executions/${encodeURIComponent(executionId)}`, { headers: sukaHeaders(opts) }));
    return r.data;
  }
}

export async function getWorkflow(workflowId, opts = {}) {
  const { api, rest } = buildClients(opts);
  try {
    const r = await resilientRequest(() => api.get(`/workflows/${encodeURIComponent(workflowId)}`, { headers: sukaHeaders(opts) }));
    return r.data;
  } catch {
    const r = await resilientRequest(() => rest.get(`/workflows/${encodeURIComponent(workflowId)}`, { headers: sukaHeaders(opts) }));
    return r.data;
  }
}

export async function listWorkflows(params = {}, opts = {}) {
  const { api, rest } = buildClients(opts);
  try {
    const r = await resilientRequest(() => api.get("/workflows", { params, headers: sukaHeaders(opts) }));
    return r.data;
  } catch {
    const r = await resilientRequest(() => rest.get("/workflows", { params, headers: sukaHeaders(opts) }));
    return r.data;
  }
}

// ---- Webhooks ----------------------------------------------------------------
/**
 * Trigger a Webhook node using a full URL.
 * opts: { method, body, headers, sign, idempotencyKey, userId, homeId, source, correlationId, timeout, baseURL }
 */
export async function triggerWebhook(webhookUrl, opts = {}) {
  const method = (opts.method || "POST").toUpperCase();
  const body = opts.body ?? {};
  const { raw } = buildClients(opts);
  const headers = opts.sign
    ? makeWebhookHeaders(body, { sign: true, extra: opts.headers, idempotencyKey: opts.idempotencyKey, userId: opts.userId, homeId: opts.homeId, source: opts.source, correlationId: opts.correlationId })
    : { "content-type": "application/json", ...sukaHeaders(opts), ...(opts.headers || {}) };

  const data = method === "GET" || method === "DELETE" ? undefined : body;
  const res = await resilientRequest(() => raw.request({ url: webhookUrl, method, headers, data }));
  return res.data;
}

/**
 * Build a Production webhook URL from node hash and optional suffix.
 * Example: buildWebhookUrl('a1b2c3', 'ingest') -> https://.../webhook/a1b2c3/ingest
 */
export function buildWebhookUrl(webhookHash, suffix = "", { baseURL = ENV.BASE_URL } = {}) {
  const clean = String(suffix || "").replace(/^\/+/, "");
  return `${baseURL}/webhook/${webhookHash}${clean ? `/${clean}` : ""}`;
}

/**
 * Convenience: trigger by hash (uses Production URL) with signing by default if secret is set.
 */
export async function triggerWebhookByHash(hash, { suffix = "", body = {}, sign = !!ENV.WEBHOOK_SECRET, ...opts } = {}) {
  const url = buildWebhookUrl(hash, suffix, opts);
  return triggerWebhook(url, { method: "POST", body, sign, ...opts });
}

// ---- Suka entity helpers -----------------------------------------------------
/**
 * sendEntity(entity, { workflowId?, webhookHash?, ...opts })
 * Sends a Suka service entity/object to n8n. If workflowId is provided, runs workflow;
 * else if webhookHash is provided, triggers webhook; otherwise throws.
 * Entity is sent as { entity, meta:{source, userId, homeId, correlationId} }.
 */
export async function sendEntity(entity, { workflowId, webhookHash, suffix = "", source = "suka-server", userId, homeId, correlationId, idempotencyKey, ...opts } = {}) {
  const payload = { entity, meta: { source, userId, homeId, correlationId, sentAt: new Date().toISOString() } };

  if (workflowId) {
    return runWorkflow(workflowId, payload, { ...opts, idempotencyKey, userId, homeId, source, correlationId });
  }
  if (webhookHash) {
    return triggerWebhookByHash(webhookHash, { suffix, body: payload, sign: !!ENV.WEBHOOK_SECRET, idempotencyKey, userId, homeId, source, correlationId, ...opts });
  }
  throw new Error("sendEntity requires workflowId or webhookHash");
}

// ---- Ping / health -----------------------------------------------------------
export async function ping(opts = {}) {
  const { api, rest } = buildClients(opts);
  try {
    const r = await resilientRequest(() => api.get("/me", { headers: sukaHeaders(opts) }));
    return { ok: true, via: "api", data: r.data };
  } catch {
    try {
      const r2 = await resilientRequest(() => rest.get("/ping", { headers: sukaHeaders(opts) }));
      return { ok: true, via: "rest", data: r2.data };
    } catch (e2) {
      throw normalizeErr(e2);
    }
  }
}

// ---- Named export of env (useful for diagnostics) ----------------------------
export const BASE_URL = ENV.BASE_URL;
export const API_KEY = ENV.API_KEY;
export const WEBHOOK_SECRET = ENV.WEBHOOK_SECRET;

// ---- Default export ----------------------------------------------------------
const n8nClient = {
  BASE_URL,
  API_KEY,
  WEBHOOK_SECRET,
  runWorkflow,
  getExecution,
  listExecutions,
  cancelExecution,
  getWorkflow,
  listWorkflows,
  triggerWebhook,
  triggerWebhookByHash,
  buildWebhookUrl,
  sendEntity,
  ping,
};

export default n8nClient;
