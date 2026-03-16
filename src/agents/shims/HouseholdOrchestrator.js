// src/agents/shims/HouseholdOrchestrator.js
/* HouseholdOrchestrator Shim
 *
 * Role:
 * - Entry point for "Cook Now", "Clean Now", "Garden Now", "Animal Care Now", etc.
 * - Find or create a session for a given domain + intent
 * - Enforce budget/gating/confidence/freshness where Reasoner is used
 * - Compose sessions via session skills
 * - Run guard checks (Sabbath, Quiet Hours, Weather, Inventory, Battery)
 * - Persist sessions in Dexie
 * - Emit session events to the eventBus
 * - Optionally export summary data to the Family Fund Hub
 *
 * NO UI logic, NO DOM access, NO timers.
 */

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} intent
 * @property {Object} input
 * @property {Object} [runtime]
 */

/**
 * @typedef {Object} ShimResponse
 * @property {boolean} ok
 * @property {string} mode
 * @property {Object} data
 * @property {Array<Object>} [warnings]
 * @property {Array<Object>} [debug]
 */

import { emit as eventEmit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

import budgetConfig from "@/agents/policies/budget.json" assert { type: "json" };
import { checkBudget } from "@/agents/policies/budget";
import { isReasonerAllowed } from "@/agents/policies/gating";
import { ensureConfidence } from "@/agents/policies/confidence";
import * as selectors from "@/agents/context/selectors";
import { applyFreshnessRules } from "@/agents/context/freshness";
import { getMemo, setMemo } from "@/agents/cache/memo";
import { makeSessionOrchestratorCacheKey } from "@/agents/cache/keys";
import { resolveMode } from "@/agents/modes/map";
import { callReasoner } from "@/agents/clients/reasonerClient";

import { composeSession } from "@/agents/skills/sessions/compose";
import { evaluateGuards } from "@/agents/skills/sessions/guardsEvaluate";

import { db } from "@/services/db"; // Dexie instance with db.sessions

// NEW: domain-specific shim imports
import { invokecookingSessionShim } from "./cookingSessionShim";

const SOURCE = "agents/shims/HouseholdOrchestrator";

const isoNow = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* Event + Hub helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Emit an SSA event.
 * @param {string} type
 * @param {Object} data
 */
function emit(type, data) {
  try {
    eventEmit({
      type,
      ts: isoNow(),
      source: SOURCE,
      data,
    });
  } catch {
    // fail-safe: never throw from event emit
  }
}

/**
 * Optionally export to Hub (when familyFundMode === true).
 * @param {Object} payload
 */
async function exportToHubIfEnabled(payload) {
  try {
    if (!familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const packet = HubPacketFormatter.formatSessionEvent(payload);
    await FamilyFundConnector.send(packet);
    emit("session.exported", {
      sessionId: payload.sessionId,
      domain: payload.domain,
    });
  } catch {
    // Fail silently; Hub is optional.
  }
}

/**
 * Persist session to Dexie.
 * @param {Object} session
 */
async function saveSession(session) {
  if (!db?.sessions) return;
  await db.sessions.put({ ...session, updatedAt: isoNow() });
}

/**
 * Load a session by id from Dexie.
 * @param {string} sessionId
 */
async function loadSession(sessionId) {
  if (!db?.sessions || !sessionId) return null;
  return db.sessions.get(sessionId);
}

/**
 * Normalize Reasoner output against our session contract.
 * Delegates to composeSession() which understands sessionShape + domain rules.
 *
 * @param {Object} args
 * @returns {Promise<Object>} Session
 */
async function buildSessionFromReasonerOutput(args) {
  return composeSession(args);
}

/* -------------------------------------------------------------------------- */
/* Reasoner + budget / gating wrapper                                        */
/* -------------------------------------------------------------------------- */

/**
 * Enforce budget + gating + caching + Reasoner call.
 *
 * @param {Object} params
 * @param {ShimRequest} params.req
 * @param {string} params.mode
 * @param {Object} params.context
 * @returns {Promise<{ ok: boolean, result?: any, warnings: any[], debug: any[] }>}
 */
async function runReasonerWithGuards({ req, mode, context }) {
  const warnings = [];
  const debug = [];

  const budget = budgetConfig?.[mode] || budgetConfig?.default || {};
  const cacheKey = makeSessionOrchestratorCacheKey({
    domain: req.domain,
    intent: req.intent,
    input: req.input,
  });

  // Budget check
  if (!checkBudget({ budget, mode })) {
    warnings.push({ code: "BUDGET_EXCEEDED", mode });
    return { ok: false, warnings, debug };
  }

  // Gating
  if (!isReasonerAllowed({ domain: req.domain, intent: req.intent })) {
    warnings.push({ code: "REASONER_BLOCKED", reason: "gating" });
    return { ok: false, warnings, debug };
  }

  // Cache
  const cached = await getMemo(cacheKey);
  if (cached) {
    debug.push({ code: "CACHE_HIT", key: cacheKey });
    emit("reasoner.cachedHit", {
      cacheKey,
      mode,
      domain: req.domain,
      intent: req.intent,
    });
    return { ok: true, result: cached, warnings, debug };
  }

  emit("reasoner.invoked", {
    domain: req.domain,
    intent: req.intent,
    mode,
    budget,
  });

  const promptContext = applyFreshnessRules({
    context,
    domain: req.domain,
    intent: req.intent,
  });

  const result = await callReasoner({
    mode,
    domain: req.domain,
    intent: req.intent,
    input: req.input,
    context: promptContext,
  });

  const confident = ensureConfidence({
    mode,
    domain: req.domain,
    intent: req.intent,
    result,
  });
  if (!confident.ok) {
    warnings.push({ code: "LOW_CONFIDENCE", detail: confident });
    return { ok: false, warnings, debug };
  }

  await setMemo(cacheKey, result);
  emit("reasoner.cachedMiss", {
    cacheKey,
    mode,
    domain: req.domain,
    intent: req.intent,
  });

  return { ok: true, result, warnings, debug };
}

/* -------------------------------------------------------------------------- */
/* NEW: Simple shim dispatcher for domain-specific shims                     */
/* -------------------------------------------------------------------------- */

/**
 * Registry of known shims by request type.
 * Extend this as you add more domains/abilities.
 */
const SHIM_REGISTRY = {
  // Cooking
  "cooking.session.generate": invokecookingSessionShim,

  // placeholders for future domains:
  // "cleaning.session.generate": invokeCleaningSessionShim,
  // "garden.session.generate": invokeGardenSessionShim,
};

/**
 * Returns true if we have a shim for the given request type.
 * Useful for guards in HouseholdReasoner or elsewhere.
 */
export function canHandleShim(type) {
  return Boolean(type && SHIM_REGISTRY[type]);
}

/**
 * Main shim-dispatch entrypoint (no Reasoner / budget involved).
 *
 * @param {Object} request
 * @returns {Promise<Object>} normalized shim response
 *
 * Response shape:
 *  {
 *    ok: boolean,
 *    type: string,
 *    domain?: string,
 *    sessionId?: string,
 *    session?: object,
 *    reason?: string,
 *    warnings?: string[],
 *    meta?: object
 *  }
 */
export async function dispatchShim(request = {}) {
  const { type } = request || {};

  if (!type) {
    return {
      ok: false,
      type: "unknown",
      reason: "MISSING_TYPE",
      meta: { request },
    };
  }

  const handler = SHIM_REGISTRY[type];

  if (!handler) {
    return {
      ok: false,
      type,
      reason: "NO_SHIM_REGISTERED",
      meta: { request },
    };
  }

  try {
    const res = await handler(request);

    return {
      ok: Boolean(res?.ok),
      type,
      domain: res?.domain || request.domain,
      sessionId: res?.sessionId,
      session: res?.session,
      reason: res?.reason,
      warnings: res?.warnings || [],
      meta: {
        ...(res?.meta || {}),
        orchestratedAt: isoNow(),
      },
    };
  } catch (err) {
    console.warn("[HouseholdOrchestrator] shim error for", type, err);
    return {
      ok: false,
      type,
      reason: "SHIM_THROW",
      meta: {
        message: err?.message,
        stack: err?.stack,
      },
    };
  }
}

/**
 * Convenience helper for the cooking page "Now" button.
 * Shapes the request for the cookingSessionShim.
 */
export async function orchestrateCookingSessionGenerate(payload = {}) {
  return dispatchShim({
    type: "cooking.session.generate",
    domain: "cooking",
    source: payload.source || "ui.cooking.page.nowButton",
    payload,
  });
}

/* -------------------------------------------------------------------------- */
/* Existing high-level shim entry (Reasoner + guards)                         */
/* -------------------------------------------------------------------------- */

/**
 * Main orchestration entry.
 * - startDomainSession: create a new session for domain
 * - resumeDomainSession: load existing session
 * - quickSession: build a quick session using Reasoner/templates
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const warnings = [];
  const debug = [];

  const ts = isoNow();

  if (!req || typeof req !== "object") {
    return {
      ok: false,
      mode: "invalid",
      data: { error: "Missing request object" },
      warnings: [{ code: "BAD_REQUEST" }],
      debug,
    };
  }

  const { domain, intent, input = {}, runtime = {} } = req;

  const allowedDomains = [
    "cooking",
    "cleaning",
    "garden",
    "animals",
    "preservation",
    "storehouse",
  ];
  if (!allowedDomains.includes(domain)) {
    return {
      ok: false,
      mode: "invalid",
      data: { error: `Unsupported domain "${domain}"` },
      warnings: [{ code: "UNSUPPORTED_DOMAIN" }],
      debug,
    };
  }

  if (!intent || typeof intent !== "string") {
    return {
      ok: false,
      mode: "invalid",
      data: { error: "Missing intent" },
      warnings: [{ code: "MISSING_INTENT" }],
      debug,
    };
  }

  const mode = resolveMode({ domain, intent });

  emit("orchestrator.invoked", {
    domain,
    intent,
    mode,
    requestedAt: ts,
  });

  try {
    switch (intent) {
      case "startDomainSession":
        return await handleStartDomainSession({ req, mode, warnings, debug });

      case "resumeDomainSession":
        return await handleResumeDomainSession({ req, mode, warnings, debug });

      case "quickSession":
        return await handleQuickSession({ req, mode, warnings, debug });

      case "import.parse":
      case "session.generate.fromImport": {
        return await invokeImportSessionShim({ intent, payload });
      }
      default:
        warnings.push({ code: "UNKNOWN_INTENT", intent });
        return {
          ok: false,
          mode,
          data: { error: `Unknown intent "${intent}"` },
          warnings,
          debug,
        };
    }
  } catch (err) {
    warnings.push({
      code: "INTERNAL_ERROR",
      message: err?.message || String(err),
    });
    debug.push({ stack: err?.stack || null });

    return {
      ok: false,
      mode,
      data: { error: "HouseholdOrchestrator error" },
      warnings,
      debug,
    };
  }
}

/**
 * Start a new session for the domain.
 */
async function handleStartDomainSession({ req, mode, warnings, debug }) {
  const { domain, input } = req;

  // Pull contextual intel from selectors/Dexie
  const context = await selectors.getDomainContext(domain, input);
  debug.push({ code: "CONTEXT_LOADED", domain });

  // Let session skills decide how to turn context into session steps.
  const draft = input.sessionDraft || null;

  const baseSession = draft
    ? await composeSession({
        domain,
        intent: "startDomainSession",
        draft,
        context,
      })
    : await composeSession({ domain, intent: "startDomainSession", context });

  const guarded = await evaluateGuards({
    session: baseSession,
    domain,
    guards: ["sabbath", "quietHours", "weather", "inventory", "battery"],
  });

  if (!guarded.ok) {
    warnings.push({ code: "GUARD_BLOCKED", reason: guarded.reason });
    return {
      ok: false,
      mode,
      data: {
        error: "Session blocked by guard",
        reason: guarded.reason,
      },
      warnings,
      debug,
    };
  }

  const session = guarded.adjustedSession || baseSession;
  session.status = "running";
  session.progress = session.progress || {
    currentStepIndex: 0,
    elapsedSec: 0,
    startedAt: isoNow(),
    pausedAt: null,
  };
  session.createdAt = session.createdAt || isoNow();
  session.updatedAt = isoNow();

  await saveSession(session);

  emit("session.started", {
    sessionId: session.id,
    domain: session.domain,
    title: session.title,
    sourceType: session.source?.type,
  });

  await exportToHubIfEnabled({
    event: "session.started",
    sessionId: session.id,
    domain: session.domain,
    startedAt: session.progress.startedAt,
    title: session.title,
  });

  return {
    ok: true,
    mode,
    data: {
      sessionId: session.id,
      session,
      summary: `Started ${domain} session "${session.title}"`,
    },
    warnings,
    debug,
  };
}

/**
 * Resume a previously pending/running session for the domain.
 */
async function handleResumeDomainSession({ req, mode, warnings, debug }) {
  const { domain } = req;

  const existing = await selectors.getPendingOrRunningSessionForDomain(domain);
  if (!existing) {
    warnings.push({ code: "NO_SESSION_TO_RESUME", domain });
    return {
      ok: false,
      mode,
      data: { error: `No pending/running session for domain "${domain}"` },
      warnings,
      debug,
    };
  }

  const session = { ...existing };
  if (session.status !== "running") {
    session.status = "running";
    session.progress = session.progress || {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: session.createdAt || isoNow(),
      pausedAt: null,
    };
  }
  session.updatedAt = isoNow();
  await saveSession(session);

  emit("session.resumed", {
    sessionId: session.id,
    domain: session.domain,
    title: session.title,
  });

  await exportToHubIfEnabled({
    event: "session.resumed",
    sessionId: session.id,
    domain: session.domain,
    resumedAt: session.updatedAt,
    title: session.title,
  });

  return {
    ok: true,
    mode,
    data: {
      sessionId: session.id,
      session,
      summary: `Resumed ${domain} session "${session.title}"`,
    },
    warnings,
    debug,
  };
}

/**
 * Build or fetch a "quick" session for the domain using Reasoner.
 */
async function handleQuickSession({ req, mode, warnings, debug }) {
  const { domain, input } = req;

  // Maybe reuse a recent quick session
  const existing = await selectors.getLatestSessionForDomain(domain);
  if (existing && existing.status !== "completed") {
    warnings.push({ code: "REUSED_EXISTING_SESSION", domain });
    return {
      ok: true,
      mode,
      data: {
        sessionId: existing.id,
        session: existing,
        summary: `Reusing existing ${domain} session "${existing.title}"`,
      },
      warnings,
      debug,
    };
  }

  const context = await selectors.getDomainContext(domain, input);

  const reasonerRes = await runReasonerWithGuards({ req, mode, context });
  warnings.push(...reasonerRes.warnings);
  debug.push(...reasonerRes.debug);

  if (!reasonerRes.ok || !reasonerRes.result) {
    return {
      ok: false,
      mode,
      data: { error: "Unable to build quick session" },
      warnings,
      debug,
    };
  }

  const session = await buildSessionFromReasonerOutput({
    domain,
    intent: "quickSession",
    draft: reasonerRes.result,
    context,
  });

  session.status = "running";
  session.progress = session.progress || {
    currentStepIndex: 0,
    elapsedSec: 0,
    startedAt: isoNow(),
    pausedAt: null,
  };
  session.createdAt = session.createdAt || isoNow();
  session.updatedAt = isoNow();

  await saveSession(session);

  emit("session.started", {
    sessionId: session.id,
    domain: session.domain,
    title: session.title,
    quick: true,
  });

  await exportToHubIfEnabled({
    event: "session.started",
    quick: true,
    sessionId: session.id,
    domain: session.domain,
    startedAt: session.progress.startedAt,
    title: session.title,
  });

  return {
    ok: true,
    mode,
    data: {
      sessionId: session.id,
      session,
      summary: `Started quick ${domain} session "${session.title}"`,
    },
    warnings,
    debug,
  };
}

export default { invokeShim, dispatchShim };
