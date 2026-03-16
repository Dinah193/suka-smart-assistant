// C:\Users\larho\suka-smart-assistant\src\agents\shims\sessionShim.js
/**
 * Session Shim
 * -----------------------------------------------------------------------------
 * Production-ready, browser-safe shim that bridges SSA "intents" into
 * SessionRunner-ready Session drafts (and/or session blueprints), using:
 *  - gating (allow/deny reasoner calls)
 *  - budget enforcement (tokens/time)
 *  - freshness + cache (memoized results)
 *  - modes/map.js (choose reasoning mode)
 *  - modes/validate.js (validate/normalize mode output)
 *  - eventBus emits (observability)
 *  - optional Hub export (Family Fund) when enabled
 *
 * IMPORTANT:
 * - This shim MUST stay browser-compatible (no node:* imports).
 * - All optional modules are guarded to prevent build crashes.
 *
 * Typical intents this shim supports (extensible):
 * - "session.buildDraft"                : build a Session draft from structured input
 * - "session.buildFromBlueprint"        : blueprint -> Session draft
 * - "session.planSteps"                 : create steps list based on goal/context
 * - "session.normalizeDraft"            : normalize/repair a partial session
 *
 * Contracts assumed in repo (best effort; guarded):
 * - "@/services/events/eventBus"        : emits canonical {type,ts,source,data}
 * - "@/config/featureFlags.json"        : { familyFundMode?: boolean }
 * - "@/agents/modes/map.js"             : getModeConfig({domain,intent,runtime,input})
 * - "@/agents/runtime/reasoner/modes/validator.js"        : validateModeOutput(modeId, rawResult)
 * - "@/agents/runtime/reasoner/index.js": invokeReasoner({mode,model,messages,options})
 * - "@/agents/runtime/reasoner/cache/memo.js"      : getCachedResult(key), setCachedResult(key, payload)
 * - "@/agents/runtime/reasoner/cache/keys.js"      : makeSessionCacheKey(...) or generic key maker
 * - "@/agents/runtime/reasoner/freshness.js"       : applyFreshnessRules(...)
 * - "@/agents/runtime/reasoner/gating.js"          : isReasonerCallAllowed(...)
 * - "@/agents/runtime/reasoner/confidence.js" : enforceBudgetForMode(), evaluateConfidence()
 */

import { emit as emitBus } from "@/services/events/eventBus";
import featureFlags from "@/config/featureFlags.json";

const familyFundMode = !!featureFlags?.familyFundMode;

const SHIM_SOURCE = "agents/shims/session";
const VALID_DOMAINS = [
  "cooking",
  "cleaning",
  "garden",
  "animals",
  "preservation",
  "storehouse",
  "planning",
  "general",
];

/* -------------------------------------------------------------------------- */
/* Lazy/optional imports (guarded)                                            */
/* -------------------------------------------------------------------------- */

let _depsLoaded = false;

let isReasonerCallAllowed;
let applyFreshnessRules;

let getCachedResult;
let setCachedResult;

let makeSessionCacheKey;

let getModeConfig;
let validateModeOutput;
let invokeReasoner;

let enforceBudgetForMode;
let evaluateConfidence;

let selectSessionContext;

let HubPacketFormatter;
let FamilyFundConnector;

async function loadDeps() {
  if (_depsLoaded) return;
  _depsLoaded = true;

  // Gating / Freshness -------------------------------------------------------
  try {
    ({ isReasonerCallAllowed } = await import(
      "@/agents/runtime/reasoner/gating.js"
    ));
  } catch {
    isReasonerCallAllowed = () => ({ allowed: true, reason: "gating.missing" });
  }

  try {
    ({ applyFreshnessRules } = await import(
      "@/agents/runtime/reasoner/freshness.js"
    ));
  } catch {
    applyFreshnessRules = () => ({
      skipCacheRead: false,
      skipCacheWrite: false,
      reason: "freshness.missing",
    });
  }

  // Cache -------------------------------------------------------------------
  try {
    ({ getCachedResult, setCachedResult } = await import(
      "@/agents/runtime/reasoner/cache/memo.js"
    ));
  } catch {
    // In-memory fallback (session-only)
    const mem = new Map();
    getCachedResult = async (k) => mem.get(k) || null;
    setCachedResult = async (k, v) => void mem.set(k, v);
  }

  try {
    ({ makeSessionCacheKey } = await import(
      "@/agents/runtime/reasoner/cache/keys.js"
    ));
  } catch {
    makeSessionCacheKey = ({ mode, domain, intent, input, context }) => {
      // stable-ish but not huge (avoid large context)
      const safeInput = safeStableObject(input, 5_000);
      const safeCtx = safeStableObject(context, 3_000);
      return [
        "session",
        mode || "unknown",
        domain || "unknown",
        intent || "unknown",
        hashString(JSON.stringify({ safeInput, safeCtx })),
      ].join(":");
    };
  }

  // Modes + validation --------------------------------------------------------
  try {
    ({ getModeConfig } = await import("@/agents/modes/map.js"));
  } catch {
    getModeConfig = () => ({
      id: "session.draft.v1",
      model: null,
      temperature: 0.2,
      maxTokens: 2048,
      prompts: {
        system:
          "You are the SSA session planner. Return ONLY valid JSON that matches the requested schema.",
      },
    });
  }

  try {
    ({ validateModeOutput } = await import(
      "@/agents/runtime/reasoner/modes/validator.js"
    ));
  } catch {
    validateModeOutput = async (_modeId, raw) => ({
      valid: !!raw,
      normalized: raw,
      errors: raw ? null : [{ message: "Empty output" }],
    });
  }

  // Reasoner ---------------------------------------------------------------
  try {
    ({ invokeReasoner } = await import("@/agents/runtime/reasoner/index.js"));
  } catch {
    invokeReasoner = async () => {
      throw new Error(
        "invokeReasoner() is missing. Ensure '@/agents/runtime/reasoner/index.js' exists."
      );
    };
  }

  // Budget + Confidence ------------------------------------------------------
  try {
    ({ enforceBudgetForMode, evaluateConfidence } = await import(
      "@/agents/runtime/reasoner/confidence.js"
    ));
  } catch {
    // No budget/confidence module found; allow by default
    enforceBudgetForMode = () => ({ ok: true, reason: "budget.missing" });
    evaluateConfidence = () => ({ level: "unknown", score: 0.5 });
  }

  // Context selector (optional) ---------------------------------------------
  try {
    ({ selectSessionContext } = await import("@/agents/context/selectors.js"));
  } catch {
    selectSessionContext = async () => ({});
  }

  // Hub (optional) -----------------------------------------------------------
  try {
    HubPacketFormatter = (await import("@/services/hub/HubPacketFormatter.js"))
      .default;
  } catch {
    HubPacketFormatter = null;
  }

  try {
    FamilyFundConnector = (
      await import("@/services/hub/FamilyFundConnector.js")
    ).default;
  } catch {
    FamilyFundConnector = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function isoNow() {
  return new Date().toISOString();
}

function emitEvent(type, data) {
  try {
    emitBus({ type, ts: isoNow(), source: SHIM_SOURCE, data });
  } catch {
    // never crash because of the bus
  }
}

function debugEntry(stage, info) {
  return { ts: isoNow(), stage, ...(info || {}) };
}

/**
 * Avoid accidental huge cache keys.
 * @param {any} obj
 * @param {number} maxChars
 */
function safeStableObject(obj, maxChars = 4000) {
  try {
    const s = JSON.stringify(obj ?? null);
    if (typeof s === "string" && s.length > maxChars)
      return { _truncated: true };
    return obj ?? null;
  } catch {
    return { _unstable: true };
  }
}

function hashString(str) {
  // tiny non-crypto hash (fast + stable)
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/* -------------------------------------------------------------------------- */
/* Prompt Builder                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build messages for the Reasoner from mode config + request + context.
 * This respects system/templates indirectly via modeConfig.
 *
 * @param {Object} params
 * @param {Object} params.modeConfig
 * @param {string} params.mode
 * @param {string} params.domain
 * @param {string} params.intent
 * @param {Object} params.input
 * @param {Object} params.context
 * @returns {Array<{role:"system"|"user",content:string}>}
 */
function buildPromptForMode({
  modeConfig,
  mode,
  domain,
  intent,
  input,
  context,
}) {
  const systemPrompt =
    modeConfig?.prompts?.system ||
    "You are the SSA session planner. Return ONLY JSON.";

  const template = modeConfig?.prompts?.template;

  let userContent;

  if (typeof template === "function") {
    userContent = template({ mode, domain, intent, input, context });
  } else if (typeof template === "string") {
    userContent = template
      .replace("{{mode}}", String(mode))
      .replace("{{domain}}", String(domain))
      .replace("{{intent}}", String(intent))
      .replace("{{payload}}", JSON.stringify({ input, context }, null, 2));
  } else {
    userContent = JSON.stringify(
      {
        task: "session-planning",
        mode,
        domain,
        intent,
        input,
        context,
      },
      null,
      2
    );
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

/* -------------------------------------------------------------------------- */
/* Local deterministic fallback (no Reasoner)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Creates a minimal Session draft that SessionRunner can run.
 * Used when gating/budget blocks Reasoner or validation fails.
 *
 * @param {Object} params
 * @param {string} params.domain
 * @param {string} params.intent
 * @param {Object} params.input
 * @returns {Object} Session-like draft
 */
function buildLocalFallbackSession({ domain, intent, input }) {
  const now = isoNow();
  const id =
    input?.sessionId ||
    `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const title =
    input?.title ||
    input?.goal ||
    (intent === "session.buildFromBlueprint"
      ? "Session (from blueprint)"
      : "Session");

  const stepsFromInput = Array.isArray(input?.steps) ? input.steps : null;

  const baseSteps =
    stepsFromInput && stepsFromInput.length
      ? stepsFromInput
      : [
          {
            id: `${id}_step_1`,
            title: "Prepare",
            desc: "Gather what you need and clear your workspace.",
            durationSec: 600,
            blockers: ["inventory", "equipment"],
            metadata: { cue: "timer" },
          },
          {
            id: `${id}_step_2`,
            title: "Execute",
            desc: "Perform the core work for this session.",
            durationSec: 1800,
            blockers: ["quietHours"],
            metadata: { cue: "checklist" },
          },
          {
            id: `${id}_step_3`,
            title: "Wrap up",
            desc: "Clean up, store results, and log outcomes.",
            durationSec: 900,
            blockers: ["equipment"],
            metadata: { cue: "timer" },
          },
        ];

  return {
    id,
    domain: domain || "general",
    title,
    source: {
      type: "shim.fallback",
      intent,
      refId: input?.refId || null,
    },
    steps: baseSteps,
    prefs: {
      voiceGuidance: !!input?.prefs?.voiceGuidance,
      haptic: input?.prefs?.haptic !== false,
      autoAdvance: !!input?.prefs?.autoAdvance,
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: {
      skippedSteps: [],
      adjustments: [],
    },
    createdAt: now,
    updatedAt: now,
    meta: {
      fallback: true,
      note: "Generated without Reasoner (gating/budget/validation).",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Result Normalization                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Normalize various mode outputs into a standard shim payload.
 * Modes may return:
 * - { session: {...} }
 * - { draftSession: {...} }
 * - { blueprint: {...}, session: {...} }
 * - { steps: [...] } (we wrap into a session)
 */
function normalizeToShimData({ domain, intent, raw, normalized, context }) {
  const out = normalized || raw || {};
  const now = isoNow();

  // Best-case: mode produced a session object
  const session =
    out.session ||
    out.draftSession ||
    out.sessionDraft ||
    (out.data && (out.data.session || out.data.draftSession));

  if (session && typeof session === "object") {
    // Ensure required-ish fields exist
    const safeSession = {
      id:
        session.id ||
        `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      domain: session.domain || domain || "general",
      title: session.title || "Session",
      source: session.source || { type: "shim", intent, refId: null },
      steps: Array.isArray(session.steps) ? session.steps : [],
      prefs: session.prefs || {},
      status: session.status || "pending",
      progress: session.progress || {
        currentStepIndex: 0,
        elapsedSec: 0,
        startedAt: null,
        pausedAt: null,
      },
      analytics: session.analytics || { skippedSteps: [], adjustments: [] },
      createdAt: session.createdAt || now,
      updatedAt: now,
      meta: { ...(session.meta || {}), shim: "sessionShim" },
    };

    return {
      type: "sessionDraft",
      session: safeSession,
      blueprint: out.blueprint || null,
      context: {
        household: context?.household || null,
        inventorySummary: context?.inventorySummary || null,
      },
    };
  }

  // Steps-only output -> wrap into session draft
  if (Array.isArray(out.steps) && out.steps.length) {
    const fallback = buildLocalFallbackSession({
      domain,
      intent,
      input: { steps: out.steps },
    });
    fallback.meta = { ...(fallback.meta || {}), fromStepsOnly: true };
    return {
      type: "sessionDraft",
      session: fallback,
      blueprint: out.blueprint || null,
      context: {
        household: context?.household || null,
        inventorySummary: context?.inventorySummary || null,
      },
    };
  }

  // Blueprint-only output
  if (out.blueprint && typeof out.blueprint === "object") {
    return {
      type: "blueprint",
      blueprint: out.blueprint,
      session: null,
      context: {
        household: context?.household || null,
        inventorySummary: context?.inventorySummary || null,
      },
    };
  }

  // Generic
  return {
    type: "generic",
    result: out,
    context: {
      household: context?.household || null,
      inventorySummary: context?.inventorySummary || null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Optional Hub export                                                        */
/* -------------------------------------------------------------------------- */

async function exportToHubIfEnabled({ domain, intent, mode, data, context }) {
  try {
    if (!familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    if (typeof FamilyFundConnector?.send !== "function") return;

    // Prefer a dedicated formatter function if available; otherwise "format"
    const packet =
      HubPacketFormatter?.fromSessionDraft?.({
        domain,
        intent,
        mode,
        data,
        context,
      }) ||
      HubPacketFormatter?.fromShimResult?.({
        domain,
        intent,
        mode,
        data,
        context,
      }) ||
      HubPacketFormatter?.format?.({
        type: "sessionShimResult",
        domain,
        intent,
        mode,
        data,
        context,
      });

    if (!packet) return;

    await FamilyFundConnector.send(packet);

    emitEvent("session.exported", {
      via: "sessionShim",
      domain,
      intent,
      mode,
      hubPacketType: packet?.type || "unknown",
      hubMeta: packet?.meta || null,
    });
  } catch {
    // best-effort; silent by design
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"|"planning"|"general"} domain
 * @property {string} intent
 * @property {Object} input
 * @property {Object} [runtime]
 *
 * @typedef {Object} ShimResponse
 * @property {boolean} ok
 * @property {string} mode
 * @property {Object} data
 * @property {Array<Object>} [warnings]
 * @property {Array<Object>} [debug]
 */

/**
 * Main entrypoint for Session shim.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  await loadDeps();

  const debug = [];
  const warnings = [];
  let mode = "";

  try {
    const domain = req?.domain || "general";
    const intent = req?.intent || "session.buildDraft";
    const input = req?.input || {};
    const runtime = req?.runtime || {};

    debug.push(debugEntry("request.received", { domain, intent }));

    if (!VALID_DOMAINS.includes(domain)) {
      warnings.push({
        type: "domain.unsupported",
        message: `Unsupported domain "${domain}" for session shim.`,
      });
      return {
        ok: false,
        mode,
        data: { error: "Unsupported domain for session shim", domain },
        warnings,
        debug,
      };
    }

    // Gating ----------------------------------------------------------------
    const gatingDecision = isReasonerCallAllowed
      ? isReasonerCallAllowed({ domain, intent, runtime, input })
      : { allowed: true, reason: "gating.unavailable" };

    debug.push(debugEntry("gating.checked", gatingDecision));

    // Mode selection ---------------------------------------------------------
    const modeConfig = getModeConfig
      ? getModeConfig({ domain, intent, runtime, input })
      : null;

    mode = modeConfig?.id || modeConfig?.name || "session.draft.v1";

    debug.push(
      debugEntry("mode.selected", { mode, model: modeConfig?.model || null })
    );

    // Budget ----------------------------------------------------------------
    const budgetDecision = enforceBudgetForMode
      ? enforceBudgetForMode({
          mode,
          domain,
          intent,
          runtime,
          budgetConfig: runtime?.budgetConfig || null,
        })
      : { ok: true };

    debug.push(debugEntry("budget.checked", budgetDecision));

    // Context ----------------------------------------------------------------
    const context = await (selectSessionContext
      ? selectSessionContext({ domain, intent, input, runtime })
      : Promise.resolve({}));

    debug.push(debugEntry("context.selected", { hasContext: !!context }));

    // Freshness + cache ------------------------------------------------------
    const freshnessDecision = applyFreshnessRules
      ? applyFreshnessRules({ mode, domain, intent, input, context, runtime })
      : { skipCacheRead: false, skipCacheWrite: false };

    debug.push(debugEntry("freshness.applied", freshnessDecision));

    const cacheKey = makeSessionCacheKey
      ? makeSessionCacheKey({ mode, domain, intent, input, context })
      : `${mode}:${domain}:${intent}`;

    if (!freshnessDecision.skipCacheRead) {
      const cached = await getCachedResult(cacheKey);
      if (cached?.data) {
        emitEvent("reasoner.cache.hit", { mode, domain, intent, cacheKey });
        debug.push(debugEntry("cache.hit", { cacheKey }));
        return {
          ok: true,
          mode,
          data: cached.data,
          warnings: [...warnings, ...(cached.warnings || [])],
          debug,
        };
      }
      emitEvent("reasoner.cache.miss", { mode, domain, intent, cacheKey });
      debug.push(debugEntry("cache.miss", { cacheKey }));
    }

    // If gating/budget blocks Reasoner, return deterministic draft ------------
    if (!gatingDecision.allowed || !budgetDecision.ok) {
      const reason = !gatingDecision.allowed
        ? gatingDecision.reason || "gating.blocked"
        : budgetDecision.reason || "budget.blocked";

      warnings.push({
        type: !gatingDecision.allowed ? "gating.blocked" : "budget.exceeded",
        reason,
      });

      const fallbackSession = buildLocalFallbackSession({
        domain,
        intent,
        input,
      });
      const data = normalizeToShimData({
        domain,
        intent,
        raw: { session: fallbackSession },
        normalized: { session: fallbackSession },
        context,
      });

      // Cache write (still OK, deterministic)
      if (!freshnessDecision.skipCacheWrite) {
        await setCachedResult(cacheKey, {
          mode,
          domain,
          intent,
          data,
          warnings,
          ts: isoNow(),
        });
        debug.push(debugEntry("cache.write", { cacheKey, fallback: true }));
      }

      emitEvent("shim.session.completed", {
        mode,
        domain,
        intent,
        ok: false,
        reason,
      });

      return { ok: false, mode, data, warnings, debug };
    }

    // Prompt construction ----------------------------------------------------
    const messages = buildPromptForMode({
      modeConfig,
      mode,
      domain,
      intent,
      input,
      context,
    });

    debug.push(debugEntry("prompt.built", { messagesCount: messages.length }));

    emitEvent("reasoner.invoked", { mode, domain, intent, runtime });

    // Reasoner call ----------------------------------------------------------
    const rawResult = await invokeReasoner({
      mode,
      model: modeConfig?.model,
      messages,
      options: {
        temperature: modeConfig?.temperature ?? 0.2,
        maxTokens: modeConfig?.maxTokens ?? 2048,
        responseFormat: "json",
        runtime,
      },
    });

    emitEvent("reasoner.result.raw", { mode, domain, intent });
    debug.push(debugEntry("reasoner.returned", { hasResult: !!rawResult }));

    // Validation -------------------------------------------------------------
    const validation = await validateModeOutput(mode, rawResult);
    debug.push(
      debugEntry("schema.validated", {
        valid: !!validation?.valid,
        errors: validation?.errors || null,
      })
    );

    if (!validation?.valid) {
      warnings.push({
        type: "schema.invalid",
        errors: validation?.errors || null,
      });

      const fallbackSession = buildLocalFallbackSession({
        domain,
        intent,
        input,
      });
      const data = normalizeToShimData({
        domain,
        intent,
        raw: rawResult,
        normalized: {
          session: fallbackSession,
          blueprint: rawResult?.blueprint || null,
        },
        context,
      });

      emitEvent("reasoner.validation.failed", {
        mode,
        domain,
        intent,
        errors: validation?.errors || null,
      });

      if (!freshnessDecision.skipCacheWrite) {
        await setCachedResult(cacheKey, {
          mode,
          domain,
          intent,
          data,
          warnings,
          ts: isoNow(),
        });
        debug.push(debugEntry("cache.write", { cacheKey, fallback: true }));
      }

      emitEvent("shim.session.completed", {
        mode,
        domain,
        intent,
        ok: false,
        reason: "schema.invalid",
      });

      return { ok: false, mode, data, warnings, debug };
    }

    emitEvent("reasoner.validation.ok", { mode, domain, intent });

    const normalized = validation.normalized ?? rawResult;

    // Confidence evaluation --------------------------------------------------
    const confidence = evaluateConfidence
      ? evaluateConfidence({
          mode,
          domain,
          intent,
          result: normalized,
          raw: rawResult,
        })
      : { level: "unknown", score: 0.5 };

    debug.push(debugEntry("confidence.evaluated", confidence));

    if (confidence?.level === "low") {
      warnings.push({
        type: "confidence.low",
        score: confidence?.score,
        message: confidence?.message || "Low confidence output.",
      });
    }

    // Normalize result into shim data ---------------------------------------
    const data = normalizeToShimData({
      domain,
      intent,
      raw: rawResult,
      normalized,
      context,
    });

    // Cache write ------------------------------------------------------------
    if (!freshnessDecision.skipCacheWrite) {
      await setCachedResult(cacheKey, {
        mode,
        domain,
        intent,
        data,
        warnings,
        ts: isoNow(),
      });
      debug.push(debugEntry("cache.write", { cacheKey }));
    }

    // Optional Hub export ----------------------------------------------------
    if (runtime?.exportToHub) {
      await exportToHubIfEnabled({ domain, intent, mode, data, context });
    }

    emitEvent("shim.session.completed", { mode, domain, intent, ok: true });

    return { ok: true, mode, data, warnings, debug };
  } catch (err) {
    debug.push(
      debugEntry("shim.error", {
        error: err?.message || String(err),
        stack: err?.stack || null,
      })
    );

    emitEvent("shim.session.error", {
      mode,
      error: err?.message || String(err),
    });

    return {
      ok: false,
      mode,
      data: { error: err?.message || String(err) },
      warnings,
      debug,
    };
  }
}

/**
 * ✅ Named export expected by:
 *   import { sessionShim } from "../../agents/shims/sessionShim";
 *
 * Keep this tiny and stable:
 * - sessionShim.invoke(req) -> invokeShim(req)
 * - sessionShim.invokeShim(req) -> invokeShim(req) (alias)
 */
export const sessionShim = {
  invoke: invokeShim,
  invokeShim, // alias for convenience/back-compat
};

export default {
  invokeShim,
  sessionShim,
};
