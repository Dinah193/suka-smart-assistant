// src/utils/apiConfig.js
// -----------------------------------------------------------------------------
// API Config helpers
// -----------------------------------------------------------------------------
// - Centralizes URL building + fetchJson
// - Imports API_BASE_URL from config.js (canonical)
// - Safe timeout + JSON parsing helpers
// -----------------------------------------------------------------------------

import { API_BASE_URL } from "@/config";

export { API_BASE_URL };

export function toQueryString(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s === "") continue;
    sp.set(k, s);
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export function buildApiUrl(base, params = null) {
  const b = String(base || "").trim();
  if (!params || typeof params !== "object") return b;

  // If base already includes ?, append with &
  const qs = toQueryString(params);
  if (!qs) return b;
  if (b.includes("?")) return `${b}&${qs.slice(1)}`;
  return `${b}${qs}`;
}

export async function fetchJson(url, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body = undefined,
    timeoutMs = 12000,
    signal,
    credentials = "same-origin",
  } = opts || {};

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  const mergedSignal = mergeSignals(signal, ctrl.signal);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": body != null ? "application/json" : "application/json",
        ...headers,
      },
      body:
        body != null
          ? typeof body === "string"
            ? body
            : JSON.stringify(body)
          : undefined,
      signal: mergedSignal,
      credentials,
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const msg =
        json?.error?.message ||
        json?.message ||
        `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = json;
      throw err;
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convenience helpers using API_BASE_URL
 */
export function apiUrl(path, params = null) {
  const p = String(path || "");
  const base =
    p.startsWith("http://") || p.startsWith("https://")
      ? p
      : `${API_BASE_URL}${p.startsWith("/") ? "" : "/"}${p}`;
  return buildApiUrl(base, params);
}

export async function getJson(pathOrUrl, params, opts) {
  const url = pathOrUrl.startsWith("http")
    ? buildApiUrl(pathOrUrl, params)
    : apiUrl(pathOrUrl, params);
  return fetchJson(url, { ...(opts || {}), method: "GET" });
}

export async function postJson(pathOrUrl, body, opts) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : apiUrl(pathOrUrl);
  return fetchJson(url, { ...(opts || {}), method: "POST", body });
}

/* ------------------------------ Signal helpers ------------------------------ */

function mergeSignals(a, b) {
  if (!a) return b;
  if (!b) return a;

  // If either is aborted, abort immediately.
  if (a.aborted || b.aborted) {
    const ctrl = new AbortController();
    ctrl.abort();
    return ctrl.signal;
  }

  const ctrl = new AbortController();
  const onAbort = () => {
    try {
      ctrl.abort();
    } catch {}
  };
  a.addEventListener?.("abort", onAbort, { once: true });
  b.addEventListener?.("abort", onAbort, { once: true });
  return ctrl.signal;
}
