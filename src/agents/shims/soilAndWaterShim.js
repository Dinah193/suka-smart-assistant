/* eslint-disable no-console */

/**
 * Soil & Water Shim
 * ---------------------------------------------------------------------------
 * Shim wrapper that replaces the old soilAndWaterAgent-style code.
 *
 * Responsibilities:
 *  - Accept a ShimRequest for the garden domain (soil/water intents)
 *  - Normalize intents (ingestMoisture, planIrrigation, recommendAmendments,
 *    waterBudgetAndMaintenance, getDashboard, syncWithGardenAgent)
 *  - Resolve the Reasoner mode using modes/map.js
 *  - Enforce:
 *      - gating.js (whether Reasoner may be called)
 *      - budget.json limits (tokens/time)
 *      - freshness.js (context filters)
 *      - confidence.js (output acceptance)
 *      - memo.js + keys.js (optional cache)
 *  - Build a prompt using system.md + prompt templates
 *  - Call the Reasoner
 *  - Validate output via mode schemas
 *  - Normalize into SSA shapes:
 *      - recommendations[]
 *      - calendarEvents[]
 *      - gardenUpdates[]
 *      - logs[]
 *      - optional Session object (for irrigation/maintenance sessions)
 *  - Persist sessions to Dexie, run guards, optionally export to Hub
 *  - Emit Reasoner + session lifecycle events via the event bus
 */

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */

import { emit as emitEventBus } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

import { enforceBudget } from "@/agents/runtime/reasoner/budget";
import { canCallReasoner } from "@/reasoner/gating";
import { enforceConfidence } from "@/agents/runtime/reasoner/confidence";

import {
  selectSoilWaterContext, // implement/extend this in selectors.js
} from "@/agents/runtime/selectors";

import { applyFreshnessRules } from "@/agents/runtime/reasoner/freshness";

import { getMemo, setMemo } from "@/agents/runtime/reasoner/cache/memo";

import {
  makeSoilWaterCacheKey, // from cache/keys.js
} from "@/agents/runtime/reasoner/cache/keys";

import { getModeForIntent } from "@/agents/modes/map";
import { validateModeOutput } from "@/agents/runtime/reasoner/modes/validator";
import { buildPromptForMode } from "@/agents/runtime/reasoner/prompts/builder";
import { callReasoner } from "@/agents/runtime/reasoner";

import { composeSession } from "@/agents/skills/sessions/compose";

import { evaluateGuards } from "@/agents/skills/sessions/guardsEvaluate";

import { sessionsDb } from "@/db/sessions";

/* -------------------------------------------------------------------------- */
/* Typedefs                                                                   */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Constants / Small Helpers                                                  */
/* -------------------------------------------------------------------------- */

const SHIM_SOURCE = "agents/shims/soil-water";

const isoNow = () => new Date().toISOString();

/**
 * Wrapper around eventBus emit()
 * @param {string} type
 * @param {Object} data
 */
function emit(type, data) {
  try {
    emitEventBus({
      type,
      ts: isoNow(),
      source: SHIM_SOURCE,
      data,
    });
  } catch (err) {
    console.warn("[soilWaterShim] event emit failed:", err);
  }
}

/**
 * Quick ShimRequest shape validation.
 *
 * @param {*} req
 * @returns {{ok: boolean, reason?: string}}
 */
function validateShimRequestShape(req) {
  if (!req || typeof req !== "object") {
    return { ok: false, reason: "Request must be an object." };
  }
  const allowedDomains = ["garden"];
  if (!allowedDomains.includes(req.domain)) {
    return {
      ok: false,
      reason: `Unsupported domain "${req.domain}". Expected "garden".`,
    };
  }
  if (!req.intent || typeof req.intent !== "string") {
    return {
      ok: false,
      reason: "Missing or invalid intent (expected non-empty string).",
    };
  }
  if (!req.input || typeof req.input !== "object") {
    return { ok: false, reason: "Missing input object." };
  }
  return { ok: true };
}

/**
 * Normalize legacy soil/water command names into canonical intents.
 *
 * @param {string} intent
 * @returns {string}
 */
function normalizeIntent(intent) {
  const s = String(intent || "")
    .trim()
    .toLowerCase();

  const map = {
    ingestmoisture: "ingestMoisture",
    "ingest-moisture": "ingestMoisture",

    planirrigation: "planIrrigation",
    "plan-irrigation": "planIrrigation",

    recommendamendments: "recommendAmendments",
    "recommend-amendments": "recommendAmendments",

    waterbudget: "waterBudgetAndMaintenance",
    "water-budget": "waterBudgetAndMaintenance",
    waterbudgetandmaintenance: "waterBudgetAndMaintenance",

    dashboard: "getDashboard",
    getdashboard: "getDashboard",

    sync: "syncWithGardenAgent",
    syncwithgardenagent: "syncWithGardenAgent",
  };

  return map[s] || intent;
}

/**
 * ShimResponse builder.
 *
 * @param {Object} args
 * @param {boolean} args.ok
 * @param {string} args.mode
 * @param {Object} [args.data]
 * @param {Array<Object>} [args.warnings]
 * @param {Array<Object>} [args.debug]
 * @returns {ShimResponse}
 */
function makeShimResponse({ ok, mode, data = {}, warnings = [], debug = [] }) {
  return { ok, mode, data, warnings, debug };
}

/**
 * Compact prompt summary for debug logs.
 *
 * @param {*} prompt
 */
function summarizePrompt(prompt) {
  if (typeof prompt === "string") {
    return {
      type: "text",
      length: prompt.length,
      preview: prompt.slice(0, 200),
    };
  }
  if (Array.isArray(prompt)) {
    return {
      type: "messages",
      count: prompt.length,
      roles: Array.from(new Set(prompt.map((m) => m.role))).sort(),
    };
  }
  return { type: typeof prompt };
}

/* -------------------------------------------------------------------------- */
/* Reasoner Output Normalization                                              */
/* -------------------------------------------------------------------------- */

/**
 * Normalize Reasoner output into SSA shapes for the soil/water domain.
 *
 * Expected (per mode schemas, conceptually):
 *
 *   {
 *     summary?: string,
 *     recommendations?: string[],
 *     calendarEvents?: Array<{
 *       type: string,
 *       title: string,
 *       date: string,
 *       bedId?: string,
 *       notes?: string
 *     }>,
 *     gardenUpdates?: Array<Object>,
 *     logs?: string[],
 *     sessionDraft?: Object,       // optional session draft (e.g. irrigation run)
 *     ...
 *   }
 *
 * @param {Object} params
 * @param {string} params.intent
 * @param {Object} params.validated
 * @param {Object} params.input
 * @param {Object} params.context
 * @returns {Promise<{data: Object, session?: Object, warnings: string[]}>}
 */
async function normalizeReasonerOutput({ intent, validated, input, context }) {
  const warnings = [];
  const canonicalIntent = normalizeIntent(intent);

  // Common envelope-like shape, matching old soilAndWaterAgent’s outputs
  const summary = validated.summary || null;
  const recommendations = Array.isArray(validated.recommendations)
    ? validated.recommendations
    : [];
  const calendarEvents = Array.isArray(validated.calendarEvents)
    ? validated.calendarEvents
    : [];
  const gardenUpdates = Array.isArray(validated.gardenUpdates)
    ? validated.gardenUpdates
    : [];
  const logs = Array.isArray(validated.logs) ? validated.logs : [];

  let session;
  const sessionDraft =
    validated.sessionDraft || validated.irrigationSessionDraft || null;

  // Only some intents are expected to generate an interactive session,
  // e.g. an “Irrigation Run” or “Maintenance Sweep”.
  if (
    sessionDraft &&
    (canonicalIntent === "planIrrigation" ||
      canonicalIntent === "waterBudgetAndMaintenance")
  ) {
    session = await composeSession({
      domain: "garden",
      intent: canonicalIntent,
      draft: sessionDraft,
      input,
      context,
    });
  }

  return {
    data: {
      summary,
      recommendations,
      calendarEvents,
      gardenUpdates,
      logs,
      raw: validated,
      ...(session ? { session } : {}),
    },
    session,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Hub Export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Optionally export a soil/water-related session to the Family Fund Hub.
 *
 * @param {Object} session
 * @param {Object} [runtime]
 */
async function maybeExportToHub(session, runtime = {}) {
  if (!familyFundMode) return;

  try {
    const packet = HubPacketFormatter.formatSession(session, {
      domain: "garden",
      source: SHIM_SOURCE,
      runtime,
    });

    await FamilyFundConnector.send(packet);

    emit("session.exported", {
      sessionId: session.id,
      domain: "garden",
      exportedAt: isoNow(),
      hubPacketType: packet?.type || null,
    });
  } catch (err) {
    emit("session.exported", {
      sessionId: session?.id || null,
      domain: "garden",
      exportedAt: isoNow(),
      error: String(err),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Core Shim: invokeShim                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Main Soil & Water Shim entrypoint.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const debug = [];
  const warnings = [];

  // 1. Basic request validation
  const shapeCheck = validateShimRequestShape(req);
  if (!shapeCheck.ok) {
    warnings.push(shapeCheck.reason);
    return makeShimResponse({
      ok: false,
      mode: "invalid.request",
      data: { reason: shapeCheck.reason },
      warnings,
      debug,
    });
  }

  const intent = normalizeIntent(req.intent);
  const input = req.input || {};
  const runtime = req.runtime || {};
  const domain = req.domain; // Should be "garden"

  debug.push({
    stage: "request.accepted",
    intent,
    domain,
    inputKeys: Object.keys(input || {}),
  });

  // 2. Resolve Reasoner mode for this domain/intent
  const mode = getModeForIntent("garden", intent);
  if (!mode) {
    const reason = `No Reasoner mode mapped for intent "${intent}" in domain "garden".`;
    warnings.push(reason);
    debug.push({ stage: "mode.unmapped", intent });
    return makeShimResponse({
      ok: false,
      mode: "unmapped.intent",
      data: { reason },
      warnings,
      debug,
    });
  }

  debug.push({ stage: "mode.resolved", mode });

  // 3. Gating (e.g., global on/off, Sabbath-aware Reasoner gating)
  const gatingDecision = await canCallReasoner({
    domain: "garden",
    intent,
    runtime,
  });
  debug.push({ stage: "gating.checked", gatingDecision });

  if (!gatingDecision.allowed) {
    const reason =
      gatingDecision.reason || "Reasoner call not allowed by gating rules.";
    warnings.push(reason);
    return makeShimResponse({
      ok: false,
      mode,
      data: {
        reason,
        retryAt: gatingDecision.retryAt || null,
      },
      warnings,
      debug,
    });
  }

  // 4. Context from Dexie / runtime selectors
  const context = await selectSoilWaterContext(input);
  debug.push({
    stage: "context.loaded",
    contextKeys: context ? Object.keys(context) : [],
  });

  // 5. Freshness rules
  const freshContext = applyFreshnessRules({
    domain: "garden",
    intent,
    context,
    runtime,
  });
  debug.push({ stage: "freshness.applied" });

  // 6. Cache lookup
  const cacheKey = makeSoilWaterCacheKey({
    intent,
    input,
    context: freshContext,
    mode,
  });

  let cached = null;
  if (!runtime.bypassCache) {
    cached = await getMemo(cacheKey);
  }

  if (cached && cached.mode === mode) {
    emit("reasoner.cachedHit", {
      domain: "garden",
      intent,
      mode,
      cacheKey,
    });

    debug.push({ stage: "cache.hit", cacheKey });

    // Confidence rules for cached results
    const confidenceOk = enforceConfidence({
      domain: "garden",
      intent,
      result: cached.data,
    });

    if (!confidenceOk) {
      warnings.push(
        "Cached result rejected by confidence rules; making fresh Reasoner call."
      );
      debug.push({ stage: "cache.confidenceRejected" });
    } else {
      return makeShimResponse({
        ok: true,
        mode,
        data: cached.data,
        warnings: (cached.warnings || []).concat(warnings),
        debug: debug.concat(cached.debug || []),
      });
    }
  } else {
    emit("reasoner.cachedMiss", {
      domain: "garden",
      intent,
      mode,
      cacheKey,
    });
    debug.push({ stage: "cache.miss", cacheKey });
  }

  // 7. Budget enforcement
  const budgetOk = await enforceBudget({
    domain: "garden",
    intent,
    mode,
    runtime,
  });
  debug.push({ stage: "budget.checked", budgetOk });

  if (!budgetOk.allowed) {
    const reason =
      budgetOk.reason ||
      "Budget exhausted or unavailable for this Reasoner call.";
    warnings.push(reason);
    return makeShimResponse({
      ok: false,
      mode,
      data: { reason, remaining: budgetOk.remaining || null },
      warnings,
      debug,
    });
  }

  // 8. Build Reasoner prompt
  const prompt = buildPromptForMode({
    mode,
    domain: "garden",
    intent,
    input,
    context: freshContext,
    runtime,
  });

  debug.push({ stage: "prompt.built", promptSummary: summarizePrompt(prompt) });

  emit("reasoner.invoked", {
    domain: "garden",
    intent,
    mode,
  });

  // 9. Call Reasoner
  let rawOutput;
  try {
    rawOutput = await callReasoner({
      mode,
      prompt,
      runtime,
    });
  } catch (err) {
    warnings.push("Reasoner call failed.");
    debug.push({ stage: "reasoner.error", error: String(err) });
    return makeShimResponse({
      ok: false,
      mode,
      data: { error: String(err) },
      warnings,
      debug,
    });
  }

  debug.push({ stage: "reasoner.returned" });

  // 10. Schema validation
  const validationResult = validateModeOutput({ mode, output: rawOutput });
  debug.push({ stage: "schema.validated", validationResult });

  if (!validationResult.ok) {
    emit("reasoner.invalidSchema", {
      domain: "garden",
      intent,
      mode,
      errors: validationResult.errors,
    });

    warnings.push("Reasoner output failed schema validation.");
    return makeShimResponse({
      ok: false,
      mode,
      data: {
        validationErrors: validationResult.errors,
      },
      warnings,
      debug,
    });
  }

  emit("reasoner.validated", {
    domain: "garden",
    intent,
    mode,
  });

  const validated = validationResult.value;

  // 11. Domain-specific normalization
  const normalized = await normalizeReasonerOutput({
    intent,
    validated,
    input,
    context: freshContext,
  });

  warnings.push(...(normalized.warnings || []));
  const data = normalized.data || {};
  let session = normalized.session;

  // 12. If a session exists (e.g., irrigation run), run guards + persist + optional Hub export
  if (session) {
    const guarded = await evaluateGuards({
      session,
      domain: "garden",
      guards: ["Sabbath", "QuietHours", "Weather", "Inventory", "Battery"],
    });

    session = guarded.session || session;
    data.session = session;

    // Persist to Dexie
    try {
      await sessionsDb.upsert(session);
      debug.push({ stage: "session.persisted", sessionId: session.id });
    } catch (err) {
      warnings.push("Failed to persist soil/water session to local DB.");
      debug.push({ stage: "session.persist.error", error: String(err) });
    }

    // Optional Hub export
    if (runtime.exportToHub) {
      await maybeExportToHub(session, runtime);
    }
  }

  // 13. Final confidence check
  const confidenceOk = enforceConfidence({
    domain: "garden",
    intent,
    result: data,
  });

  if (!confidenceOk) {
    warnings.push("Final result rejected by confidence rules.");
    debug.push({ stage: "confidence.rejected" });
    return makeShimResponse({
      ok: false,
      mode,
      data: { reason: "Rejected by confidence rules." },
      warnings,
      debug,
    });
  }

  // 14. Save to cache
  try {
    if (!runtime.bypassCache) {
      await setMemo(cacheKey, {
        mode,
        data,
        warnings,
        debug,
        savedAt: isoNow(),
      });
      debug.push({ stage: "cache.saved", cacheKey });
    }
  } catch (err) {
    debug.push({ stage: "cache.save.error", error: String(err) });
  }

  // 15. Done
  return makeShimResponse({
    ok: true,
    mode,
    data,
    warnings,
    debug,
  });
}

/* -------------------------------------------------------------------------- */
/* Back-compat wrapper: handleSoilWaterCommand                                */
/* -------------------------------------------------------------------------- */

/**
 * Back-compat entrypoint that mimics:
 *
 *   handleSoilWaterCommand(command, payload)
 *
 * It builds a ShimRequest and delegates to invokeShim().
 * Returns a ShimResponse (not the old envelope).
 *
 * @param {string|Object} command
 * @param {Object} [payload]
 * @returns {Promise<ShimResponse>}
 */
export async function handleSoilWaterCommand(command, payload = {}) {
  let intent =
    typeof command === "string"
      ? command
      : command?.command || command?.type || "planIrrigation";

  intent = normalizeIntent(intent);

  if (
    typeof command === "object" &&
    command?.payload &&
    !Object.keys(payload || {}).length
  ) {
    // eslint-disable-next-line no-param-reassign
    payload = command.payload;
  }

  const req = {
    domain: "garden",
    intent,
    input: payload || {},
    runtime: {},
  };

  return invokeShim(req);
}

/* -------------------------------------------------------------------------- */
/* Optional class wrapper for legacy imports                                  */
/* -------------------------------------------------------------------------- */

/**
 * Optional class wrapper so legacy code like:
 *   const agent = new SoilAndWaterAgent();
 *   agent.handleCommand("planIrrigation", payload);
 * can still work, but now routed through the shim.
 */
export class SoilAndWaterAgent {
  async handleCommand(command, payload) {
    return handleSoilWaterCommand(command, payload);
  }
}

const agentInstance = new SoilAndWaterAgent();
export default agentInstance;
