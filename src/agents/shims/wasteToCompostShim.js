/* eslint-disable no-console */
/**
 * wasteToCompost Shim — Animal Waste → Compost Planner
 * -----------------------------------------------------------------------------
 * Responsibilities:
 *  - Accept a ShimRequest for the composting workflow (animals → compost → garden).
 *  - Normalize legacy "wasteToCompostAgent" commands:
 *      estimateOutputs, scheduleCompost, matchToGardenNeeds,
 *      optimizeMix, recordBatch, simulateSystem, syncWithGardenAgent
 *  - Resolve Reasoner mode via modes/map.js.
 *  - Enforce:
 *      - gating.js (canCallReasoner)
 *      - budget.json (enforceBudget)
 *      - confidence.js (enforceConfidence)
 *      - freshness.js (applyFreshnessRules)
 *      - cache (getMemo / setMemo with keys.js)
 *  - Build prompts from system + templates, call Reasoner, validate with schemas.
 *  - Normalize Reasoner output to:
 *      { summary, recommendations, calendarEvents, gardenUpdates, logs, session? }
 *  - Optionally compose a compost session (SessionRunner) from sessionDraft.
 *  - Persist sessions to Dexie and optionally export to the Hub.
 *  - Emit Reasoner + session events via eventBus.
 *
 * Domain note:
 *  - Canonical domain is treated as "animals" (because it starts from animal waste),
 *    but the shim accepts ShimRequest.domain === "animals" or "garden" and normalizes
 *    internally to "animals" for mode mapping. Adjust if you later introduce a
 *    dedicated "compost" Reasoner domain.
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
  selectWasteToCompostContext, // implement in selectors.js
} from "@/agents/runtime/selectors";

import { applyFreshnessRules } from "@/agents/runtime/reasoner/freshness";

import { getMemo, setMemo } from "@/agents/runtime/reasoner/cache/memo";

import {
  makeWasteToCompostCacheKey, // implement in cache/keys.js
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
/* Constants & Small Helpers                                                  */
/* -------------------------------------------------------------------------- */

const SHIM_SOURCE = "agents/shims/wasteToCompost";
const isoNow = () => new Date().toISOString();

/**
 * Normalize domain: accept "animals" or "garden", treat canonical as "animals".
 *
 * @param {string} domain
 * @returns {("animals"|"garden")}
 */
function normalizeDomain(domain) {
  const d = String(domain || "").toLowerCase();
  if (d === "garden") return "garden";
  return "animals";
}

/**
 * EventBus wrapper.
 *
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
    console.warn("[wasteToCompostShim] failed to emit event:", err);
  }
}

/**
 * Validate that the ShimRequest has a minimally correct shape.
 *
 * @param {*} req
 * @returns {{ok: boolean, reason?: string}}
 */
function validateShimRequestShape(req) {
  if (!req || typeof req !== "object") {
    return { ok: false, reason: "Request must be an object." };
  }
  const allowedDomains = ["animals", "garden"];
  if (!allowedDomains.includes(String(req.domain || "").toLowerCase())) {
    return {
      ok: false,
      reason: `Unsupported domain "${req.domain}". Expected "animals" or "garden".`,
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
 * Normalize legacy wasteToCompost commands to canonical intents.
 *
 * @param {string} intent
 * @returns {string}
 */
function normalizeIntent(intent) {
  const s = String(intent || "")
    .trim()
    .toLowerCase();

  const alias = {
    estimateoutputs: "estimateOutputs",
    "estimate-outputs": "estimateOutputs",

    schedulecompost: "scheduleCompost",
    "schedule-compost": "scheduleCompost",

    matchtogardenneeds: "matchToGardenNeeds",
    "match-to-garden-needs": "matchToGardenNeeds",

    optimizemix: "optimizeMix",
    "optimize-mix": "optimizeMix",

    recordbatch: "recordBatch",
    "record-batch": "recordBatch",

    simulatesystem: "simulateSystem",
    "simulate-system": "simulateSystem",

    syncwithgardenagent: "syncWithGardenAgent",
    sync: "syncWithGardenAgent",
  };

  return alias[s] || intent;
}

/**
 * Construct a ShimResponse.
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
 * Short prompt summary for debug logs.
 *
 * @param {*} prompt
 * @returns {Object}
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
 * Normalize Reasoner output into SSA shapes for "wasteToCompost".
 *
 * Expected (from mode schemas) something like:
 *
 *  {
 *    summary?: string,
 *    recommendations?: string[],
 *    calendarEvents?: Array<Object>,  // compost schedule, application, ready
 *    gardenUpdates?: Array<Object>,   // compost.batch_draft, compost.allocate, etc.
 *    logs?: string[],
 *    batches?: Array<Object>,         // optional derived batch info
 *    mixStrategies?: Array<Object>,   // for optimizeMix
 *    sessionDraft?: Object            // optional session draft for SessionRunner
 *  }
 *
 * This shim only standardizes the envelope; detailed fields are enforced by
 * mode schemas and consumed by downstream engines.
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

  const batches = Array.isArray(validated.batches) ? validated.batches : [];
  const mixStrategies = Array.isArray(validated.mixStrategies)
    ? validated.mixStrategies
    : [];

  let session;
  const sessionDraft = validated.sessionDraft || null;

  // Only some intents are expected to generate interactive sessions:
  //  - estimateOutputs (for a "build compost batch" session)
  //  - scheduleCompost (scheduling/turning session)
  //  - recordBatch (logging + checks)
  //  - simulateSystem (scenario-run as a guided workflow)
  if (
    sessionDraft &&
    (canonicalIntent === "estimateOutputs" ||
      canonicalIntent === "scheduleCompost" ||
      canonicalIntent === "recordBatch" ||
      canonicalIntent === "simulateSystem")
  ) {
    session = await composeSession({
      domain: "animals", // canonical domain for compost pipeline
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
      batches,
      mixStrategies,
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
 * Optionally export a compost session to the Family Fund Hub.
 *
 * @param {Object} session
 * @param {Object} [runtime]
 */
async function maybeExportToHub(session, runtime = {}) {
  if (!familyFundMode) return;

  try {
    const packet = HubPacketFormatter.formatSession(session, {
      domain: "animals",
      source: SHIM_SOURCE,
      runtime,
    });

    await FamilyFundConnector.send(packet);

    emit("session.exported", {
      sessionId: session.id,
      domain: "animals",
      exportedAt: isoNow(),
      hubPacketType: packet?.type || null,
    });
  } catch (err) {
    emit("session.exported", {
      sessionId: session?.id || null,
      domain: "animals",
      exportedAt: isoNow(),
      error: String(err),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Core Shim: invokeShim                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Main waste-to-compost Shim entrypoint.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const debug = [];
  const warnings = [];

  // 1. Request shape validation
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

  const canonicalDomain = normalizeDomain(req.domain);
  const intent = normalizeIntent(req.intent);
  const input = req.input || {};
  const runtime = req.runtime || {};

  debug.push({
    stage: "request.accepted",
    intent,
    domain: canonicalDomain,
    inputKeys: Object.keys(input || {}),
  });

  // 2. Resolve Reasoner mode
  const mode = getModeForIntent(canonicalDomain, intent);
  if (!mode) {
    const reason = `No Reasoner mode mapped for intent "${intent}" in domain "${canonicalDomain}".`;
    warnings.push(reason);
    debug.push({ stage: "mode.unmapped", intent, domain: canonicalDomain });
    return makeShimResponse({
      ok: false,
      mode: "unmapped.intent",
      data: { reason },
      warnings,
      debug,
    });
  }

  debug.push({ stage: "mode.resolved", mode });

  // 3. Gating checks
  const gatingDecision = await canCallReasoner({
    domain: canonicalDomain,
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

  // 4. Context from Dexie / selectors
  const context = await selectWasteToCompostContext(input);
  debug.push({
    stage: "context.loaded",
    contextKeys: context ? Object.keys(context) : [],
  });

  // 5. Freshness rules
  const freshContext = applyFreshnessRules({
    domain: canonicalDomain,
    intent,
    context,
    runtime,
  });
  debug.push({ stage: "freshness.applied" });

  // 6. Cache lookup
  const cacheKey = makeWasteToCompostCacheKey({
    domain: canonicalDomain,
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
      domain: canonicalDomain,
      intent,
      mode,
      cacheKey,
    });
    debug.push({ stage: "cache.hit", cacheKey });

    const confidenceOk = enforceConfidence({
      domain: canonicalDomain,
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
      domain: canonicalDomain,
      intent,
      mode,
      cacheKey,
    });
    debug.push({ stage: "cache.miss", cacheKey });
  }

  // 7. Budget enforcement
  const budgetOk = await enforceBudget({
    domain: canonicalDomain,
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
    domain: canonicalDomain,
    intent,
    input,
    context: freshContext,
    runtime,
  });

  debug.push({ stage: "prompt.built", promptSummary: summarizePrompt(prompt) });

  emit("reasoner.invoked", {
    domain: canonicalDomain,
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
    const msg = String(err);
    warnings.push("Reasoner call failed.");
    debug.push({ stage: "reasoner.error", error: msg });
    return makeShimResponse({
      ok: false,
      mode,
      data: { error: msg },
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
      domain: canonicalDomain,
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
    domain: canonicalDomain,
    intent,
    mode,
  });

  const validated = validationResult.value;

  // 11. Normalize domain-specific data
  const normalized = await normalizeReasonerOutput({
    intent,
    validated,
    input,
    context: freshContext,
  });

  warnings.push(...(normalized.warnings || []));
  const data = normalized.data || {};
  let session = normalized.session;

  // 12. Session guards + persistence + optional Hub export
  if (session) {
    const guarded = await evaluateGuards({
      session,
      domain: canonicalDomain,
      guards: ["Sabbath", "QuietHours", "Weather", "Inventory", "Battery"],
    });

    session = guarded.session || session;
    data.session = session;

    try {
      await sessionsDb.upsert(session);
      debug.push({ stage: "session.persisted", sessionId: session.id });
    } catch (err) {
      warnings.push("Failed to persist compost session to local DB.");
      debug.push({ stage: "session.persist.error", error: String(err) });
    }

    if (runtime.exportToHub) {
      await maybeExportToHub(session, runtime);
    }
  }

  // 13. Final confidence check
  const confidenceOk = enforceConfidence({
    domain: canonicalDomain,
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
/* Per-intent wrappers (back-compat style)                                    */
/* -------------------------------------------------------------------------- */

/**
 * estimateOutputs(ctx)
 *  Legacy: animal waste → manure/DM/urineN summary + compost batch draft.
 *
 *  ctx roughly matches old payload fields:
 *    {
 *      animals, beddingInventory, wasteParams, compostSystem,
 *      weatherTimeline, gardenPlan, options, ...
 *    }
 */
export async function estimateOutputs(ctx = {}) {
  const req = {
    domain: "animals",
    intent: "estimateOutputs",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * scheduleCompost(ctx)
 *  Legacy: build compost calendar events from a batchDraft + weather.
 */
export async function scheduleCompost(ctx = {}) {
  const req = {
    domain: "animals",
    intent: "scheduleCompost",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * matchToGardenNeeds(ctx)
 *  Legacy: finished compost batches → bed allocations and application events.
 */
export async function matchToGardenNeeds(ctx = {}) {
  const req = {
    domain: "animals",
    intent: "matchToGardenNeeds",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * optimizeMix(ctx)
 *  Legacy: pick mix strategy (straw/leaves, straw/sawdust, etc.) and optionally
 *  refine with LLM. Now delegated to Reasoner mode.
 */
export async function optimizeMix(ctx = {}) {
  const req = {
    domain: "animals",
    intent: "optimizeMix",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * recordBatch(ctx)
 *  Legacy: logging single compost batch reading, update thermoDays/turnCount,
 *  and generate "ready" or follow-up events.
 */
export async function recordBatch(ctx = {}) {
  const req = {
    domain: "animals",
    intent: "recordBatch",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * simulateSystem(ctx)
 *  Legacy: scenario engine (adjust animals, bedding, method, start date) and
 *  simulate compost outputs/size/schedule.
 */
export async function simulateSystem(ctx = {}) {
  const req = {
    domain: "animals",
    intent: "simulateSystem",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * syncWithGardenAgent(ctx)
 *  Legacy: normalize compost deltas for gardenAgent (allocate + batch_update).
 */
export async function syncWithGardenAgent(ctx = {}) {
  const req = {
    domain: "animals",
    intent: "syncWithGardenAgent",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/* -------------------------------------------------------------------------- */
/* Back-compat command router                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Back-compat entrypoint similar to original:
 *   handleWasteCommand(command, payload)
 *
 * Returns a ShimResponse.
 *
 * Supported commands:
 *   estimateOutputs, scheduleCompost, matchToGardenNeeds,
 *   optimizeMix, recordBatch, simulateSystem, syncWithGardenAgent
 *
 * @param {string|Object} command
 * @param {Object} [payload]
 * @returns {Promise<ShimResponse>}
 */
export async function handleWasteCommand(command, payload = {}) {
  let cmd = command;

  if (typeof command === "object" && command !== null) {
    cmd = command.command || command.type || "estimateOutputs";
    if (command.payload && !Object.keys(payload || {}).length) {
      // eslint-disable-next-line no-param-reassign
      payload = command.payload;
    }
  }

  const normalized = normalizeIntent(cmd);

  switch (normalized) {
    case "estimateOutputs":
      return estimateOutputs(payload);

    case "scheduleCompost":
      return scheduleCompost(payload);

    case "matchToGardenNeeds":
      return matchToGardenNeeds(payload);

    case "optimizeMix":
      return optimizeMix(payload);

    case "recordBatch":
      return recordBatch(payload);

    case "simulateSystem":
      return simulateSystem(payload);

    case "syncWithGardenAgent":
      return syncWithGardenAgent(payload);

    default:
      return makeShimResponse({
        ok: false,
        mode: "unknown.command",
        data: {
          summary: `Unknown wasteToCompost command "${normalized}"`,
          message:
            "Use: estimateOutputs, scheduleCompost, matchToGardenNeeds, optimizeMix, recordBatch, simulateSystem, syncWithGardenAgent.",
        },
        warnings: [`Unknown command "${normalized}"`],
        debug: [],
      });
  }
}

/* -------------------------------------------------------------------------- */
/* Optional class/factory (minimal back-compat)                               */
/* -------------------------------------------------------------------------- */

/**
 * Minimal WasteToCompostAgent wrapper for older imports.
 * No internal mutable state; simply forwards to handleWasteCommand.
 */
export class WasteToCompostAgent {
  constructor() {
    this.name = "wasteToCompostShim";
    this.version = "2.0.0";
  }

  /**
   * Proxy legacy handleCommand to shim handleWasteCommand.
   *
   * @param {string|Object} command
   * @param {Object} [payload]
   * @returns {Promise<ShimResponse>}
   */
  async handleCommand(command, payload) {
    return handleWasteCommand(command, payload);
  }
}

/**
 * createAgent(opts)
 *  - Legacy factory wrapper; options are currently ignored.
 *
 * @param {Object} [opts]
 * @returns {WasteToCompostAgent}
 */
export function createAgent(opts) {
  // opts kept for signature compatibility
  return new WasteToCompostAgent(opts);
}

/* -------------------------------------------------------------------------- */
/* Default export                                                             */
/* -------------------------------------------------------------------------- */

const agentInstance = new WasteToCompostAgent();
export default agentInstance;
