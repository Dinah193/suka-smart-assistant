// C:\Users\larho\suka-smart-assistant\src\agents\clients\reasonerClient.js
// -----------------------------------------------------------------------------
// PURPOSE (Browser/Worker-safe)
// -----------------------------------------------------------------------------
// Client wrapper for calling SSA's Reasoner/LLM service.
//
// Build fix:
// ✅ Export `callReasoner` (HouseholdOrchestrator imports it).
// ✅ No Node imports.
// ✅ Works in browser + web worker.
// ✅ Defensive defaults (won't crash if server not configured).
//
// Expected usage:
//   import { callReasoner } from "@/agents/clients/reasonerClient";
//   const res = await callReasoner({ intent: "session.compose", input: {...} });

/* -------------------------------------------------------------------------- */
/*  Types (JSDoc)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ReasonerRequest
 * @property {string} intent                 // e.g. "session.compose.cooking"
 * @property {any} input                     // prompt/context/body
 * @property {Record<string, any>} [meta]    // optional metadata (domain, user, etc.)
 * @property {string} [model]                // optional model hint
 */

/**
 * @typedef {Object} ReasonerOptions
 * @property {string} [endpoint]             // override endpoint (default resolves automatically)
 * @property {number} [timeoutMs]            // default 30s
 * @property {AbortSignal} [signal]          // abort support
 * @property {Record<string, string>} [headers] // extra headers
 * @property {boolean} [throwOnError]        // default false
 */

/**
 * @typedef {Object} ReasonerResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {string} requestId
 * @property {any} data
 * @property {string} [error]
 */

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Call the Reasoner service.
 *
 * - POST JSON to the configured endpoint.
 * - Returns a normalized response shape.
 * - If endpoint is not configured, returns `{ ok:false, status:0, ... }`
 *   (so callers can degrade gracefully).
 *
 * @param {ReasonerRequest} req
 * @param {ReasonerOptions} [options]
 * @returns {Promise<ReasonerResponse>}
 */
export async function callReasoner(req, options = {}) {
  const requestId = makeReasonerRequestId();

  const endpoint = resolveReasonerEndpoint(options.endpoint);
  if (!endpoint) {
    const out = {
      ok: false,
      status: 0,
      requestId,
      data: null,
      error: "reasoner-endpoint-not-configured",
    };
    if (options.throwOnError) throw new Error(out.error);
    return out;
  }

  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 30_000;

  const controller = new AbortController();
  const outerSignal = options.signal;

  // If caller supplies a signal, abort our controller when it aborts.
  let onAbort = null;
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    onAbort = () => controller.abort();
    try {
      outerSignal.addEventListener("abort", onAbort, { once: true });
    } catch {
      // ignore
    }
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = {
      requestId,
      ts: new Date().toISOString(),
      intent: String(req?.intent || "unknown"),
      input: req?.input ?? null,
      meta: req?.meta ?? {},
      model: req?.model,
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const status = res.status;
    const text = await safeReadText(res);

    // Try JSON parse, but don't require it.
    const parsed = safeJsonParse(text);

    if (!res.ok) {
      const errMsg =
        (parsed && (parsed.error || parsed.message)) ||
        `reasoner-http-${status}`;
      const out = {
        ok: false,
        status,
        requestId,
        data: parsed ?? text ?? null,
        error: String(errMsg),
      };
      if (options.throwOnError) throw new Error(out.error);
      return out;
    }

    return {
      ok: true,
      status,
      requestId,
      data: parsed ?? text ?? null,
    };
  } catch (err) {
    const out = {
      ok: false,
      status: 0,
      requestId,
      data: null,
      error: normalizeReasonerError(err),
    };
    if (options.throwOnError) throw new Error(out.error);
    return out;
  } finally {
    clearTimeout(timer);
    if (outerSignal && onAbort) {
      try {
        outerSignal.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Generate a short request id for correlation.
 * @returns {string}
 */
export function makeReasonerRequestId() {
  // crypto.randomUUID where available; otherwise fallback.
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    )
      return crypto.randomUUID();
  } catch {
    // ignore
  }
  return `r_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

/**
 * Normalize errors from fetch/abort/etc.
 * @param {any} err
 * @returns {string}
 */
export function normalizeReasonerError(err) {
  const msg = String(err?.message || err || "");
  if (!msg) return "reasoner-error";

  // AbortController timeout / abort cases
  if (
    msg.toLowerCase().includes("aborted") ||
    msg.toLowerCase().includes("abort")
  ) {
    return "reasoner-request-aborted";
  }

  // Network errors in browsers often show as TypeError: Failed to fetch
  if (msg.toLowerCase().includes("failed to fetch")) {
    return "reasoner-network-failed-to-fetch";
  }

  return msg;
}

export default {
  callReasoner,
  makeReasonerRequestId,
  normalizeReasonerError,
};

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

function resolveReasonerEndpoint(override) {
  if (typeof override === "string" && override.trim()) return override.trim();

  // Vite env (preferred)
  try {
    // eslint-disable-next-line no-undef
    const env = typeof import.meta !== "undefined" ? import.meta.env : null;
    if (env && typeof env.VITE_REASONER_ENDPOINT === "string") {
      const v = env.VITE_REASONER_ENDPOINT.trim();
      if (v) return v;
    }
  } catch {
    // ignore
  }

  // Common fallback: same-origin API route
  return "/api/reasoner";
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function safeJsonParse(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
