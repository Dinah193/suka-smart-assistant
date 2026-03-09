// File: src/reasoner/index.js
/**
 * SSA Reasoner Facade (Browser-safe)
 * -----------------------------------------------------------------------------
 * Purpose
 * - Provide a stable import surface at "@/reasoner" (and "@/reasoner/index.js")
 *   for legacy and cross-module callers.
 * - Bridge to the *actual* runtime implementation that lives under:
 *     src/agents/runtime/reasoner/*
 *
 * Why this exists
 * - Your repo has multiple places that historically imported:
 *     "@/reasoner/runtime/reasoner"
 *   but your current implementation lives under:
 *     "@/agents/runtime/reasoner/index.js"
 * - Vite will fail builds if any module imports a non-existent path.
 *
 * Contracts
 * - Exports a single canonical entrypoint:
 *     invokeReasoner({ mode, model, messages, options })
 * - Also exports helpers that shims commonly expect:
 *     safeInvokeReasoner(), normalizeReasonerError(), ensureJsonObject()
 *
 * Browser Safety
 * - No node:* imports.
 * - No fs/path usage.
 *
 * Usage
 *   import { invokeReasoner } from "@/reasoner";
 *   const res = await invokeReasoner({ mode, model, messages, options });
 *
 * -----------------------------------------------------------------------------
 */

const SOURCE = "reasoner/index";

/* -------------------------------------------------------------------------- */
/* Internal: dynamic resolver                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the current runtime implementation in a browser-safe way.
 * We lazily import so that:
 * - dev can run without loading the whole agent stack immediately
 * - builds don't hard-crash if a file is temporarily missing (we fail gracefully)
 */
async function _loadRuntime() {
  // Primary (current canonical location)
  try {
    const mod = await import("@/agents/runtime/reasoner/index.js");
    if (mod && (mod.invokeReasoner || mod.default?.invokeReasoner)) return mod;
  } catch {
    // fallthrough
  }

  // Secondary: allow an index barrel if you prefer that structure
  try {
    const mod = await import("@/agents/runtime/reasoner/index.js");
    if (mod && (mod.invokeReasoner || mod.default?.invokeReasoner)) return mod;
  } catch {
    // fallthrough
  }

  // Tertiary: legacy path (only if you actually have it)
  try {
    const mod = await import("@/reasoner/index.js");
    if (mod && (mod.invokeReasoner || mod.default?.invokeReasoner)) return mod;
  } catch {
    // fallthrough
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Canonical Reasoner invocation wrapper.
 *
 * Expected envelope:
 * @param {Object} args
 * @param {string} [args.mode]   - reasoner mode id (ex: "procurement.plan.v1")
 * @param {string} [args.model]  - model name
 * @param {Array<{role:"system"|"user"|"assistant", content:string}>} args.messages
 * @param {Object} [args.options]
 * @returns {Promise<any>} - implementation-dependent result (usually JSON)
 */
export async function invokeReasoner(args = {}) {
  const runtime = await _loadRuntime();
  const fn =
    runtime?.invokeReasoner ||
    runtime?.default?.invokeReasoner ||
    runtime?.default;

  if (typeof fn !== "function") {
    const err = new Error(
      "Reasoner runtime is not available. Expected '@/agents/runtime/reasoner/index.js' (or index.js) to export invokeReasoner()."
    );
    err.code = "REASONER_RUNTIME_MISSING";
    err.meta = { source: SOURCE };
    throw err;
  }

  // Pass-through. Runtime owns detailed validation.
  return fn(args);
}

/**
 * Back-compat export expected by some shims:
 *   import { runReasoner } from "@/reasoner";
 *
 * Alias to invokeReasoner().
 */
export async function runReasoner(args = {}) {
  return invokeReasoner(args);
}

/**
 * Safe wrapper that never throws. Useful for shims that must not crash.
 *
 * @param {Object} args - same as invokeReasoner
 * @returns {Promise<{ok:boolean, result:any|null, error:string|null, meta?:any}>}
 */
export async function safeInvokeReasoner(args = {}) {
  try {
    const result = await invokeReasoner(args);
    return { ok: true, result, error: null, meta: { source: SOURCE } };
  } catch (e) {
    const msg = normalizeReasonerError(e);
    return {
      ok: false,
      result: null,
      error: msg,
      meta: {
        source: SOURCE,
        code: e?.code || null,
        name: e?.name || null,
      },
    };
  }
}

/**
 * Normalize errors to a clean string for UI/shim logging.
 * @param {any} err
 * @returns {string}
 */
export function normalizeReasonerError(err) {
  if (!err) return "Reasoner error.";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || "Reasoner error.";
  if (typeof err?.message === "string") return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return "Reasoner error.";
  }
}

/**
 * Ensure a returned value is a plain object (typical JSON mode expectation).
 * If a string is returned, attempts JSON.parse.
 *
 * @param {any} value
 * @returns {{ok:boolean, value:Object|null, error?:string}}
 */
export function ensureJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value };
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return { ok: false, value: null, error: "Empty string result." };
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, value: parsed };
      }
      return {
        ok: false,
        value: null,
        error: "Parsed JSON is not an object.",
      };
    } catch (e) {
      return {
        ok: false,
        value: null,
        error: `Invalid JSON string: ${e?.message || "parse error"}`,
      };
    }
  }

  return {
    ok: false,
    value: null,
    error: "Result is not a JSON object.",
  };
}

/* -------------------------------------------------------------------------- */
/* Default export                                                             */
/* -------------------------------------------------------------------------- */

export default {
  invokeReasoner,
  runReasoner,
  safeInvokeReasoner,
  normalizeReasonerError,
  ensureJsonObject,
};
