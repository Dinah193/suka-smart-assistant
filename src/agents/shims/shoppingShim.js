/* eslint-disable no-console */

/**
 * Shopping Shim
 * ---------------------------------------------------------------------------
 * SSA shim that replaces the old "shoppingAgent" style code.
 *
 * Responsibilities:
 *  - Accept ShimRequest for the shopping/storehouse domain
 *  - Normalize intent into canonical forms (buildList, optimizeList, compareStores, finalizeTrip, etc.)
 *  - Resolve the correct Reasoner mode using modes/map.js
 *  - Enforce:
 *      - gating.js (when we may call the Reasoner)
 *      - budget.json limits (tokens/time)
 *      - freshness.js rules (for context)
 *      - confidence.js (for final outputs and cached results)
 *      - memo.js + keys.js (optional cache)
 *  - Build Reasoner prompt using system.md + prompt templates
 *  - Call Reasoner via a single orchestration point
 *  - Validate Reasoner output using mode schemas
 *  - Normalize Reasoner output into:
 *      - shopping deltas (list items, store suggestions, coupons, etc.)
 *      - optional Session object (for running a "shopping trip" session via SessionRunner)
 *  - Persist sessions to Dexie and run guard checks (Sabbath, Quiet Hours, Weather, Inventory, Battery)
 *  - Optionally export sessions to the Family Fund Hub
 *  - Emit reasoner + session events over the event bus
 */

/* -------------------------------------------------------------------------- */
/* Imports (adjust to match your actual paths)                                */
/* -------------------------------------------------------------------------- */

import { emit as emitEventBus } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

import { enforceBudget } from "@/agents/runtime/reasoner/budget";
import { canCallReasoner } from "@/reasoner/gating";
import { enforceConfidence } from "@/agents/runtime/reasoner/confidence";

import {
  selectStorehouseContext, // you’ll implement/extend this in selectors.js
} from "@/agents/runtime/selectors";

import { applyFreshnessRules } from "@/agents/runtime/reasoner/freshness";

import { getMemo, setMemo } from "@/agents/runtime/reasoner/cache/memo";

import {
  makeShoppingCacheKey, // from cache/keys.js
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
/* Constants / Helpers                                                        */
/* -------------------------------------------------------------------------- */

const SHIM_SOURCE = "agents/shims/shopping";

const isoNow = () => new Date().toISOString();

/**
 * Uniform wrapper around eventBus emit()
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
    console.warn("[shoppingShim] event emit failed:", err);
  }
}

/**
 * Validate base ShimRequest shape.
 * We’re strict on having a domain, intent, and input,
 * but we don’t fully validate the input’s internal fields here.
 *
 * @param {*} req
 * @returns {{ok: boolean, reason?: string}}
 */
function validateShimRequestShape(req) {
  if (!req || typeof req !== "object") {
    return { ok: false, reason: "Request must be an object." };
  }
  const allowedDomains = ["storehouse", "cooking"];
  if (!allowedDomains.includes(req.domain)) {
    return {
      ok: false,
      reason: `Unsupported domain "${
        req.domain
      }". Expected one of: ${allowedDomains.join(", ")}.`,
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
 * Normalize intent aliases into canonical forms.
 * Map legacy shoppingAgent commands into the new SSA intents.
 *
 * @param {string} intent
 * @returns {string}
 */
function normalizeIntent(intent) {
  const s = String(intent || "")
    .toLowerCase()
    .trim();

  const map = {
    // legacy aliases
    buildlist: "buildList",
    list: "buildList",
    listbuilder: "buildList",

    optimizelist: "optimizeList",
    optimize: "optimizeList",
    reducecost: "optimizeList",
    minbasket: "optimizeList",

    comparestores: "compareStores",
    compare: "compareStores",

    finalize: "finalizeTrip",
    finalizetrip: "finalizeTrip",
    committrip: "finalizeTrip",

    suggestsubs: "suggestSubstitutions",
    substitutions: "suggestSubstitutions",
    suggestsavings: "suggestSubstitutions",

    // you can add more aliases as needed
  };

  return map[s] || intent;
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
 * Debug-friendly summarizer for prompts.
 * Supports text or chat-style arrays.
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
 * Normalize Reasoner output into SSA shapes.
 *
 * For shopping:
 *  - buildList / optimizeList / compareStores / suggestSubstitutions may all
 *    return "listDraft" + cost / store recommendations.
 *  - finalizeTrip may return a "tripSessionDraft" (for SessionRunner) plus
 *    inventory deltas and store meta.
 *
 * This function assumes your mode schemas enforce a predictable shape such as:
 *
 *   {
 *     listDraft?: {...},
 *     tripSessionDraft?: {...},
 *     inventoryDeltas?: [...],
 *     storeComparisons?: [...],
 *     notes?: string
 *   }
 *
 * @param {Object} params
 * @param {string} params.intent
 * @param {Object} params.validated
 * @param {Object} params.input
 * @param {Object} params.context
 */
async function normalizeReasonerOutput({ intent, validated, input, context }) {
  const warnings = [];
  const canonicalIntent = normalizeIntent(intent);

  // For any list-building intent, we expect a "listDraft"
  if (
    canonicalIntent === "buildList" ||
    canonicalIntent === "optimizeList" ||
    canonicalIntent === "compareStores" ||
    canonicalIntent === "suggestSubstitutions"
  ) {
    const listDraft = validated.listDraft || validated.list || null;

    if (!listDraft) {
      warnings.push(
        "Reasoner output did not contain listDraft/list; returning raw output."
      );
      return { data: { raw: validated }, session: undefined, warnings };
    }

    // No session needed here (shopping list is not necessarily a live session).
    return {
      data: {
        list: listDraft,
        storeComparisons: validated.storeComparisons || null,
        notes: validated.notes || null,
        raw: validated,
      },
      session: undefined,
      warnings,
    };
  }

  // finalizeTrip: may create a Session for running the "shopping trip"
  if (canonicalIntent === "finalizeTrip") {
    const tripDraft = validated.tripSessionDraft || validated.session || null;

    if (!tripDraft) {
      warnings.push(
        "Reasoner output did not contain a tripSessionDraft/session; returning raw output."
      );
      return { data: { raw: validated }, session: undefined, warnings };
    }

    // Compose a Session object using shared Session composer
    const session = await composeSession({
      domain: "storehouse",
      intent: canonicalIntent,
      draft: tripDraft,
      input,
      context,
    });

    return {
      data: {
        session,
        inventoryDeltas: validated.inventoryDeltas || [],
        notes: validated.notes || null,
        raw: validated,
      },
      session,
      warnings,
    };
  }

  // Fallback: no special normalization; return raw validated payload
  return {
    data: validated,
    session: undefined,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Hub Export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Optionally export a shopping session (trip) to the Family Fund Hub.
 *
 * @param {Object} session
 * @param {Object} [runtime]
 */
async function maybeExportToHub(session, runtime = {}) {
  if (!familyFundMode) return;

  try {
    const packet = HubPacketFormatter.formatSession(session, {
      domain: "storehouse",
      source: SHIM_SOURCE,
      runtime,
    });

    await FamilyFundConnector.send(packet);

    emit("session.exported", {
      sessionId: session.id,
      domain: "storehouse",
      exportedAt: isoNow(),
      hubPacketType: packet?.type || null,
    });
  } catch (err) {
    emit("session.exported", {
      sessionId: session?.id || null,
      domain: "storehouse",
      exportedAt: isoNow(),
      error: String(err),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Core Shim: invokeShim                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Main Shopping Shim entrypoint.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const debug = [];
  const warnings = [];

  // 1. Basic shape validation
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
  const domain = req.domain; // "storehouse" or "cooking" (back-compat convenience)

  debug.push({
    stage: "request.accepted",
    intent,
    domain,
    inputKeys: Object.keys(input || {}),
  });

  // 2. Resolve Reasoner mode via modes/map.js
  const mode = getModeForIntent("storehouse", intent);
  if (!mode) {
    const reason = `No Reasoner mode mapped for intent "${intent}" in domain "storehouse".`;
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

  // 3. Enforce gating (e.g., global toggles, Sabbath constraints at AI layer, etc.)
  const gatingDecision = await canCallReasoner({
    domain: "storehouse",
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

  // 4. Pull context from Dexie via selectors (inventory, coupons, store preferences, etc.)
  const context = await selectStorehouseContext(input);
  debug.push({
    stage: "context.loaded",
    contextKeys: context ? Object.keys(context) : [],
  });

  // 5. Freshness rules over the context
  const freshContext = applyFreshnessRules({
    domain: "storehouse",
    intent,
    context,
    runtime,
  });
  debug.push({ stage: "freshness.applied" });

  // 6. Look up cache
  const cacheKey = makeShoppingCacheKey({
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
      domain: "storehouse",
      intent,
      mode,
      cacheKey,
    });

    debug.push({ stage: "cache.hit", cacheKey });

    // Confidence rules still apply to cached results
    const confidenceOk = enforceConfidence({
      domain: "storehouse",
      intent,
      result: cached.data,
    });

    if (!confidenceOk) {
      warnings.push(
        "Cached result rejected by confidence rules; forcing fresh Reasoner call."
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
      domain: "storehouse",
      intent,
      mode,
      cacheKey,
    });
    debug.push({ stage: "cache.miss", cacheKey });
  }

  // 7. Enforce budget
  const budgetOk = await enforceBudget({
    domain: "storehouse",
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

  // 8. Build prompt using templates + system
  const prompt = buildPromptForMode({
    mode,
    domain: "storehouse",
    intent,
    input,
    context: freshContext,
    runtime,
  });

  debug.push({ stage: "prompt.built", promptSummary: summarizePrompt(prompt) });

  emit("reasoner.invoked", {
    domain: "storehouse",
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
      domain: "storehouse",
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
    domain: "storehouse",
    intent,
    mode,
  });

  const validated = validationResult.value;

  // 11. Normalize into list/session/deltas for SSA
  const normalized = await normalizeReasonerOutput({
    intent,
    validated,
    input,
    context: freshContext,
  });

  warnings.push(...(normalized.warnings || []));
  const data = normalized.data || {};

  // 12. If we have a shopping session (trip), run guards + persist + optional Hub export
  let session = normalized.session;
  if (session) {
    const guarded = await evaluateGuards({
      session,
      domain: "storehouse",
      guards: ["Sabbath", "QuietHours", "Weather", "Inventory", "Battery"],
    });

    session = guarded.session || session;
    data.session = session;

    // Persist in Dexie
    try {
      await sessionsDb.upsert(session);
      debug.push({ stage: "session.persisted", sessionId: session.id });
    } catch (err) {
      warnings.push("Failed to persist shopping session to local DB.");
      debug.push({ stage: "session.persist.error", error: String(err) });
    }

    // Optional Hub export
    if (runtime.exportToHub) {
      await maybeExportToHub(session, runtime);
    }
  }

  // 13. Final confidence check on result
  const confidenceOk = enforceConfidence({
    domain: "storehouse",
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
/* Optional Back-compat Wrapper (old shoppingAgent style)                     */
/* -------------------------------------------------------------------------- */

/**
 * Optional compatibility wrapper that mimics the old shoppingAgent-style
 * command entrypoint:
 *
 *   shoppingAgent.actions.handleCommand(command, payload)
 *
 * It constructs a ShimRequest and forwards to invokeShim().
 * Returns a ShimResponse instead of the old envelope shape.
 *
 * @param {string|Object} command
 * @param {Object} [payload]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}) {
  let intent =
    typeof command === "string"
      ? command
      : command?.command || command?.type || "buildList";

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
    domain: "storehouse",
    intent,
    input: payload || {},
    runtime: {},
  };

  return invokeShim(req);
}
