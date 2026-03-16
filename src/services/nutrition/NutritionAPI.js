/**
 * @file C:\Users\larho\suka-smart-assistant\src\services\nutrition\NutritionAPI.js
 *
 * NutritionAPI — thin, defensive wrapper around fetch() for the central backend’s
 * nutrition routes.
 *
 * HOW THIS FITS THE SSA PIPELINE
 * imports → normalize → intelligence (NutritionResolver) → automation → (optional) hub export
 * - NutritionResolver calls into this module when a local Dexie lookup is missing or stale.
 * - This module ONLY performs network reads; it never mutates household data.
 * - We still emit automation.event envelopes for observability and metrics.
 *
 * EVENT ENVELOPE (consistent shape): { type, ts, source, data }
 *   - nutrition.api.request
 *   - nutrition.api.response
 *   - nutrition.api.error
 *
 * FORWARD-LOOKING EXTENSION POINTS
 * - If the backend exposes additional endpoints (e.g., POST /nutrition/bulk-lookup),
 *   add small wrappers below and keep the same return shape { ok, data? , error? }.
 * - If auth is introduced, implement token retrieval via a soft import (see getAuth()).
 */

import eventBus from "../events/eventBus.js";

const SOURCE = "NutritionAPI";

// ───────────────────────────────────────────────────────────────────────────────
// Configuration

/**
 * Resolve the API base URL in a resilient order:
 * 1) window.__SSA_API_BASE__ (runtime-injected)
 * 2) import.meta.env.VITE_SSA_API_BASE (Vite env)
 * 3) process.env.SSA_API_BASE (SSR / Node)
 * 4) fallback to same-origin "/api"
 */
function getApiBase() {
  /* eslint-disable no-undef */
  // @ts-ignore
  const w = typeof window !== "undefined" ? window : undefined;
  const fromWindow = w && w.__SSA_API_BASE__;
  // @ts-ignore
  const fromVite =
    typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_SSA_API_BASE;
  // @ts-ignore
  const fromNode =
    typeof process !== "undefined" && process.env && process.env.SSA_API_BASE;
  /* eslint-enable no-undef */
  return (fromWindow || fromVite || fromNode || "/api")
    .toString()
    .replace(/\/+$/, "");
}

/**
 * Default timeout (ms) for network requests.
 */
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Default retry configuration.
 */
const DEFAULT_RETRY = {
  retries: 1, // total attempts = retries + 1
  backoffMs: 350, // linear backoff
  retryOn: [502, 503, 504, 522, 524], // transient server errors
};

// ───────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * Lookup nutrition by normalized (or raw) name.
 * Tries multiple backend shapes:
 *   1) GET /nutrition/lookup?name=normalizedName
 *   2) GET /nutrition?name=normalizedName
 *
 * @param {string} normalizedName
 * @param {{ timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<{ ok: true, data: any } | { ok: false, status?: number, error: string }>}
 */
export async function nutritionLookup(normalizedName, options = {}) {
  const name = (normalizedName || "").trim();
  if (!name) {
    return { ok: false, error: "Invalid name" };
  }

  const base = getApiBase();
  const url1 = `${base}/nutrition/lookup?name=${encodeURIComponent(name)}`;
  const url2 = `${base}/nutrition?name=${encodeURIComponent(name)}`;

  emit("nutrition.api.request", { method: "GET", url: url1, alt: url2, name });

  // Try primary then fallback
  const first = await fetchJson(url1, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  if (first.ok) {
    emit("nutrition.api.response", { url: url1, status: 200 });
    return first;
  }
  // If first call failed with 404, try alternate route before giving up
  if (first.status === 404) {
    const second = await fetchJson(url2, {
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });
    if (second.ok) {
      emit("nutrition.api.response", { url: url2, status: 200 });
      return second;
    }
    emit("nutrition.api.error", {
      url: url2,
      status: second.status,
      error: second.error,
    });
    return second;
  }

  // Non-404 error from first call
  emit("nutrition.api.error", {
    url: url1,
    status: first.status,
    error: first.error,
  });
  return first;
}

/**
 * Get nutrition by id (preferred) or by name (fallback).
 * Tries multiple backend shapes:
 *   1) GET /nutrition/:id
 *   2) GET /nutrition?id=...
 *   3) Falls back to nutritionLookup(name) when input is not an id
 *
 * @param {string} idOrName
 * @param {{ timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<{ ok: true, data: any } | { ok: false, status?: number, error: string }>}
 */
export async function getNutrition(idOrName, options = {}) {
  const key = (idOrName || "").trim();
  if (!key) return { ok: false, error: "Invalid id/name" };

  // Heuristic: treat "food:slug:hash" as id, otherwise fallback to name lookup
  if (!/^[a-z]+:[a-z0-9\-]+:[0-9a-f]+$/i.test(key)) {
    return nutritionLookup(key, options);
  }

  const base = getApiBase();
  const url1 = `${base}/nutrition/${encodeURIComponent(key)}`;
  const url2 = `${base}/nutrition?id=${encodeURIComponent(key)}`;

  emit("nutrition.api.request", {
    method: "GET",
    url: url1,
    alt: url2,
    id: key,
  });

  const first = await fetchJson(url1, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  if (first.ok) {
    emit("nutrition.api.response", { url: url1, status: 200 });
    return first;
  }
  if (first.status === 404) {
    const second = await fetchJson(url2, {
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });
    if (second.ok) {
      emit("nutrition.api.response", { url: url2, status: 200 });
      return second;
    }
    emit("nutrition.api.error", {
      url: url2,
      status: second.status,
      error: second.error,
    });
    return second;
  }

  emit("nutrition.api.error", {
    url: url1,
    status: first.status,
    error: first.error,
  });
  return first;
}

// ───────────────────────────────────────────────────────────────────────────────
// Internal: fetch helpers

/**
 * Perform a GET and parse JSON with timeout + basic retry.
 * Returns a uniform shape for callers:
 *   { ok: true, data }
 *   { ok: false, status?, error }
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, retries?: number, headers?: Record<string,string> }} [opts]
 */
async function fetchJson(url, opts = {}) {
  const timeoutMs = isPosInt(opts.timeoutMs)
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const retries = isPosInt(opts.retries) ? opts.retries : DEFAULT_RETRY.retries;
  const backoffMs = DEFAULT_RETRY.backoffMs;
  const retryOn = DEFAULT_RETRY.retryOn;

  const headers = await buildHeaders(opts.headers);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const ac =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const id = ac ? setTimeoutSafe(() => ac.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: ac?.signal,
        credentials: "include",
      });
      if (id) clearTimeout(id);

      if (!res.ok) {
        // Retry only on transient statuses
        if (attempt < retries && retryOn.includes(res.status)) {
          await delay(backoffMs * (attempt + 1));
          continue;
        }
        const errorText = await safeText(res);
        return {
          ok: false,
          status: res.status,
          error: errorText || `HTTP ${res.status}`,
        };
      }

      // Parse JSON safely
      const data = await safeJson(res);
      return { ok: true, data };
    } catch (err) {
      if (id) clearTimeout(id);
      const networkish = isNetworkLike(err);
      // Retry network-ish failures once or twice
      if (attempt < retries && networkish) {
        await delay(backoffMs * (attempt + 1));
        continue;
      }
      return { ok: false, error: err?.message || "Network error" };
    }
  }

  return { ok: false, error: "Exhausted retries" };
}

// ───────────────────────────────────────────────────────────────────────────────
// Headers / Auth

async function buildHeaders(extra = {}) {
  const hdrs = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };

  // Soft-import token provider (if present). Failure should not crash.
  const auth = await getAuth();
  if (auth?.token) {
    hdrs.Authorization = `${auth.scheme || "Bearer"} ${auth.token}`;
  }
  return hdrs;
}

async function getAuth() {
  try {
    // NOTE:
    // Rollup cannot resolve "src/..." unless you explicitly alias it.
    // Your project already aliases "@/..." to /src, so use that here.
    const mod = await import(
      /* @vite-ignore */ "@/services/auth/tokenProvider.js"
    );
    const m = mod?.default || mod;
    if (m && typeof m.getToken === "function") {
      const token = await m.getToken();
      if (token) return { token, scheme: m.scheme || "Bearer" };
    }
  } catch {
    // no-op
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Small utilities

function emit(type, data) {
  try {
    eventBus.emit("automation.event", {
      type,
      ts: new Date().toISOString(),
      source: SOURCE,
      data,
    });
  } catch {
    // never throw from telemetry
  }
}

function isNetworkLike(err) {
  const msg = (err && err.message ? String(err.message) : "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("abort") ||
    msg.includes("failed to fetch")
  );
}

function isPosInt(n) {
  return Number.isFinite(n) && n > 0;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Safe JSON/text helpers that won’t throw on empty bodies.
async function safeJson(res) {
  try {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// Avoid jest/vitest unref warnings in some environments
function setTimeoutSafe(fn, ms) {
  const id = setTimeout(fn, ms);
  // @ts-ignore
  if (typeof id.unref === "function") id.unref();
  return id;
}

// ───────────────────────────────────────────────────────────────────────────────

export default {
  nutritionLookup,
  getNutrition,
};
