// File: src/agents/runtime/reasoner/index.js
// SSA Reasoner adapter
//
// Purpose:
// - Provide a stable entrypoint used by shims:
//     import { callReasoner } from "@/agents/runtime/reasoner";
// - In production you can swap in a real provider (OpenAI, local model, etc.).
// - For now, this implementation is "safe" for builds:
//     - No network required
//     - Deterministic mock outputs
//     - Returns JSON objects compatible with downstream validators
//
// IMPORTANT:
// - Shims + mode validators should be the truth source for structure.
// - This adapter should NOT embed business logic (PAR math, etc.).
// - This module must exist for Vite builds even if AI is disabled.

const SOURCE = "agents/runtime/reasoner";

function isoNow() {
  return new Date().toISOString();
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function safeObject(v) {
  return isPlainObject(v) ? v : {};
}

function safeString(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

/**
 * Creates a deterministic-ish hash for prompts to keep mock results stable.
 * Not cryptographic; just to generate repeatable outputs for caching/tests.
 */
function simpleHash(input) {
  const s = typeof input === "string" ? input : JSON.stringify(input);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * Normalize prompt input into a consistent object for downstream use.
 * Supports:
 * - string prompt
 * - array of chat messages: [{ role, content }]
 */
function normalizePrompt(prompt) {
  if (typeof prompt === "string") {
    return { type: "text", text: prompt, messages: null };
  }
  if (Array.isArray(prompt)) {
    const msgs = prompt
      .filter((m) => m && typeof m === "object")
      .map((m) => ({
        role: safeString(m.role, "user"),
        content: safeString(m.content, ""),
      }));
    return { type: "messages", text: null, messages: msgs };
  }
  return { type: "unknown", text: null, messages: null };
}

/**
 * Minimal "model" selection logic.
 * You can later map mode->model here.
 */
function pickModel({ mode, runtime }) {
  const r = safeObject(runtime);
  return (
    r.model ||
    (mode && String(mode).includes("high") ? "mock-high" : "mock-default")
  );
}

/**
 * Generates a safe mock output envelope.
 * Mode validators decide if this is acceptable.
 *
 * To avoid blowing up schema validation, we include common fields:
 * - summary, recommendations, logs
 * - plus domain-ish placeholders if mode is storehouse-related
 */
function buildMockOutput({ mode, prompt, runtime }) {
  const norm = normalizePrompt(prompt);
  const seed = simpleHash({
    mode: safeString(mode),
    model: pickModel({ mode, runtime }),
    prompt: norm.type === "text" ? norm.text : norm.messages,
  });

  const base = {
    _meta: {
      source: SOURCE,
      provider: "mock",
      model: pickModel({ mode, runtime }),
      mode: safeString(mode),
      seed,
      ts: isoNow(),
    },
    summary:
      safeString(mode) && safeString(mode).includes("storehouse")
        ? "Mock storehouse result (Reasoner disabled/offline)."
        : "Mock result (Reasoner disabled/offline).",
    recommendations: [],
    logs: [
      "Reasoner adapter running in mock mode.",
      "No network calls were performed.",
      `mode=${safeString(mode) || "unknown"}`,
      `seed=${seed}`,
    ],
  };

  // Provide common storehouse-ish fields so shims can proceed without crashing
  if (safeString(mode).toLowerCase().includes("storehouse")) {
    return {
      ...base,
      targets: [],
      gaps: [],
      plan: {
        kind: "mock",
        note: "This is a placeholder plan. Connect a real Reasoner provider for real results.",
      },
      labels: [],
      maintenance: null,
      exportResult: null,
      emptyState:
        "Reasoner is disabled/offline. Connect a provider to generate storehouse plans.",
      sessionDraft: null,
    };
  }

  // Preservation-ish placeholders
  if (safeString(mode).toLowerCase().includes("preservation")) {
    return {
      ...base,
      actions: [],
      batchPlans: [],
      emptyState:
        "Reasoner is disabled/offline. Connect a provider to generate preservation plans.",
      sessionDraft: null,
    };
  }

  // Generic fallback
  return {
    ...base,
    data: {},
    emptyState:
      "Reasoner is disabled/offline. Connect a provider to generate results.",
  };
}

/**
 * callReasoner({ mode, prompt, runtime })
 *
 * Contract:
 * - Return a plain JSON object (the "rawOutput") which will be validated by
 *   validateModeOutput in your shims.
 *
 * Runtime controls (supported):
 * - runtime.mock === true -> always returns mock output
 * - runtime.dryRun === true -> returns mock output + debug info
 * - runtime.noNetwork === true -> never attempts network
 *
 * Future:
 * - Add real provider behind runtime.provider or env flags.
 *
 * @param {Object} args
 * @param {string} args.mode
 * @param {string|Array<{role:string,content:string}>} args.prompt
 * @param {Object} [args.runtime]
 */
export async function callReasoner({ mode, prompt, runtime = {} }) {
  const r = safeObject(runtime);

  // If caller explicitly wants mock/dryRun/noNetwork, return a mock output.
  const forceMock = !!r.mock || !!r.dryRun || !!r.noNetwork || !!r.offline;
  if (forceMock) {
    const out = buildMockOutput({ mode, prompt, runtime: r });
    if (r.dryRun) {
      out._meta.dryRun = true;
      out._meta.promptType = normalizePrompt(prompt).type;
    }
    return out;
  }

  // Default behavior: still return mock output unless a real provider is configured.
  // This prevents accidental build/runtime crashes.
  const provider = safeString(r.provider || "", "").toLowerCase();

  // Placeholder for future providers.
  // For now, no provider is implemented, so we safely fall back.
  if (!provider || provider === "mock") {
    return buildMockOutput({ mode, prompt, runtime: r });
  }

  // If someone set a provider but we don't implement it yet,
  // return a clear mock error-shaped response.
  return {
    _meta: {
      source: SOURCE,
      provider,
      model: pickModel({ mode, runtime: r }),
      mode: safeString(mode),
      ts: isoNow(),
    },
    summary: "Reasoner provider not implemented.",
    emptyState:
      "A Reasoner provider was requested but is not implemented in this build.",
    recommendations: [],
    logs: [
      `provider=${provider}`,
      "This build of callReasoner does not include a network/model provider.",
      "Set runtime.mock=true to silence this or implement a provider in src/agents/reasoner/index.js.",
    ],
  };
}

/**
 * Back-compat alias expected by some shims:
 *   import { runReasoner } from "@/agents/runtime/reasoner/index";
 *
 * Accepts the same args as callReasoner.
 */
export async function runReasoner({ mode, prompt, runtime = {} }) {
  return await callReasoner({ mode, prompt, runtime });
}

/**
 * Back-compat entrypoint expected by procurementShim:
 *   import { invokeReasoner } from "@/agents/runtime/reasoner/index";
 *
 * Alias invokeReasoner -> callReasoner
 */
export async function invokeReasoner({ mode, prompt, runtime = {} }) {
  return await callReasoner({ mode, prompt, runtime });
}

/**
 * Optional helper: detect if reasoner is "available".
 * Useful for UI badges.
 */
export function isReasonerAvailable(runtime = {}) {
  const r = safeObject(runtime);
  const provider = safeString(r.provider || "", "").toLowerCase();
  if (r.noNetwork || r.offline || r.mock || r.dryRun) return false;
  // Since we haven't implemented real providers yet:
  return provider && provider !== "mock";
}

export default {
  callReasoner,
  runReasoner,
  invokeReasoner,
  isReasonerAvailable,
};
