/* eslint-disable no-console */
/**
 * Spice Shim — Flavor Balancer, Blend Builder & Garden Bridge
 * ---------------------------------------------------------------------------
 * Shim wrapper that replaces the old spiceAgent-style code.
 *
 * Responsibilities:
 *  - Accept a ShimRequest for the "cooking" domain
 *  - Normalize intents:
 *      analyzeDish, balanceDish, suggestBlends, buildSpicePantry,
 *      planSpiceGarden, generateSpiceKits
 *  - Resolve Reasoner mode via modes/map.js
 *  - Enforce:
 *      - gating.js (canCallReasoner)
 *      - budget.json (enforceBudget)
 *      - freshness.js (applyFreshnessRules)
 *      - confidence.js (enforceConfidence)
 *      - cache (getMemo / setMemo with keys.js)
 *  - Build a prompt using system.md + templates
 *  - Call the Reasoner
 *  - Validate with mode schemas
 *  - Normalize output into SSA shapes, including:
 *      - flavorVector / flavorGaps
 *      - cuisineCombos: cuisine-specific spice/herb sets for the dish
 *      - cart / pantry suggestions
 *      - gardenPlan and spice garden combos
 *  - Optionally compose a "cooking" session (e.g., flavor-adjust steps)
 *  - Persist sessions to Dexie, run guard evaluation, and optionally export to Hub
 *  - Emit Reasoner and session events via eventBus
 */

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */

import { emit as emitEventBus } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

import { enforceBudget } from "@/agents/runtime/budget";
import { canCallReasoner } from "@/agents/runtime/gating";
import { enforceConfidence } from "@/agents/runtime/confidence";

import {
  selectSpiceContext, // implement in selectors.js for spice/cooking context
} from "@/agents/runtime/selectors";

import { applyFreshnessRules } from "@/agents/runtime/freshness";

import {
  getMemo,
  setMemo,
} from "@/agents/runtime/cache/memo";

import {
  makeSpiceCacheKey, // implement in cache/keys.js
} from "@/agents/runtime/cache/keys";

import { getModeForIntent } from "@/agents/modes/map";
import { validateModeOutput } from "@/agents/modes/validator";
import { buildPromptForMode } from "@/agents/prompts/builder";
import { callReasoner } from "@/agents/reasoner";

import {
  composeSession,
} from "@/agents/skills/sessions/compose";

import {
  evaluateGuards,
} from "@/agents/guards/guardsEvaluate";

import {
  sessionsDb,
} from "@/db/sessions";

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

const SHIM_SOURCE = "agents/shims/spice";
const isoNow = () => new Date().toISOString();

/**
 * Lightweight wrapper around eventBus emit
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
    console.warn("[spiceShim] failed to emit event:", err);
  }
}

/**
 * Validate ShimRequest shape quickly.
 *
 * @param {*} req
 * @returns {{ok: boolean, reason?: string}}
 */
function validateShimRequestShape(req) {
  if (!req || typeof req !== "object") {
    return { ok: false, reason: "Request must be an object." };
  }
  const allowedDomains = ["cooking"];
  if (!allowedDomains.includes(req.domain)) {
    return {
      ok: false,
      reason: `Unsupported domain "${req.domain}". Expected "cooking".`,
    };
  }
  if (!req.intent || typeof req.intent !== "string") {
    return { ok: false, reason: "Missing or invalid intent (expected non-empty string)." };
  }
  if (!req.input || typeof req.input !== "object") {
    return { ok: false, reason: "Missing input object." };
  }
  return { ok: true };
}

/**
 * Normalize legacy spiceAgent commands to canonical spice intents.
 *
 * @param {string} intent
 * @returns {string}
 */
function normalizeIntent(intent) {
  const s = String(intent || "").toLowerCase().trim();

  const map = {
    analyze: "analyzeDish",
    analyzedish: "analyzeDish",

    balance: "balanceDish",
    balancedish: "balanceDish",

    blends: "suggestBlends",
    suggestblends: "suggestBlends",

    pantry: "buildSpicePantry",
    buildpantry: "buildSpicePantry",

    kits: "generateSpiceKits",
    generatekits: "generateSpiceKits",

    spicegarden: "planSpiceGarden",
    plangarden: "planSpiceGarden",
  };

  return map[s] || intent;
}

/**
 * Build a ShimResponse.
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
 * Normalize Reasoner output into SSA shapes for the spice / flavor domain.
 *
 * Expected (from mode schemas for spice-related modes):
 *
 *   {
 *     summary?: string,
 *     flavorVector?: Object,
 *     flavorGaps?: Object,
 *     targetProfile?: Object,
 *     pantryMatches?: string[],
 *     torahProfile?: Object,
 *     cuisine?: string | null,
 *
 *     // NEW: cuisine-specific spice & herb combos for the dish
 *     cuisineCombos?: Array<{
 *       cuisineId: string,
 *       cuisineLabel: string,
 *       primaryHerbs: string[],
 *       primarySpices: string[],
 *       classicBlendName?: string,
 *       notes?: string
 *     }>,
 *
 *     cart?: Array<Object>,
 *     gardenPlan?: Object,
 *     blends?: Array<Object>,
 *     spiceKits?: Array<Object>,
 *
 *     logs?: string[],
 *     recommendations?: string[],
 *     actions?: Array<Object>,
 *
 *     sessionDraft?: Object    // flavor-adjust steps / pantry session
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

  // Common fields
  const summary = validated.summary || null;
  const flavorVector = validated.flavorVector || null;
  const flavorGaps = validated.flavorGaps || null;
  const targetProfile = validated.targetProfile || null;
  const pantryMatches = Array.isArray(validated.pantryMatches)
    ? validated.pantryMatches
    : [];

  const cuisine = validated.cuisine || input?.dish?.cuisine || null;

  // Cuisine-specific combos (explicitly surfaced for UI + SSA)
  const cuisineCombos = Array.isArray(validated.cuisineCombos)
    ? validated.cuisineCombos
    : [];

  const recommendations = Array.isArray(validated.recommendations)
    ? validated.recommendations
    : [];
  const logs = Array.isArray(validated.logs) ? validated.logs : [];

  const cart = Array.isArray(validated.cart) ? validated.cart : [];
  const gardenPlan = validated.gardenPlan || null;
  const blends = Array.isArray(validated.blends) ? validated.blends : [];
  const spiceKits = Array.isArray(validated.spiceKits) ? validated.spiceKits : [];

  let session;
  const sessionDraft = validated.sessionDraft || null;

  // Only some intents are expected to create a "cooking" session:
  // e.g., flavor adjustment steps for the dish.
  if (
    sessionDraft &&
    (canonicalIntent === "balanceDish" || canonicalIntent === "analyzeDish")
  ) {
    session = await composeSession({
      domain: "cooking",
      intent: canonicalIntent,
      draft: sessionDraft,
      input,
      context,
    });
  }

  return {
    data: {
      summary,
      flavorVector,
      flavorGaps,
      targetProfile,
      pantryMatches,
      cuisine,
      cuisineCombos, // <--- cuisine-specific spice/herb combos
      recommendations,
      logs,
      cart,
      gardenPlan,
      blends,
      spiceKits,
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
 * Optionally export a spice-related cooking session to the Family Fund Hub.
 *
 * @param {Object} session
 * @param {Object} [runtime]
 */
async function maybeExportToHub(session, runtime = {}) {
  if (!familyFundMode) return;

  try {
    const packet = HubPacketFormatter.formatSession(session, {
      domain: "cooking",
      source: SHIM_SOURCE,
      runtime,
    });

    await FamilyFundConnector.send(packet);

    emit("session.exported", {
      sessionId: session.id,
      domain: "cooking",
      exportedAt: isoNow(),
      hubPacketType: packet?.type || null,
    });
  } catch (err) {
    emit("session.exported", {
      sessionId: session?.id || null,
      domain: "cooking",
      exportedAt: isoNow(),
      error: String(err),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Core Shim: invokeShim                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Main Spice Shim entrypoint.
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
  const domain = req.domain; // "cooking"

  debug.push({
    stage: "request.accepted",
    intent,
    domain,
    inputKeys: Object.keys(input || {}),
  });

  // 2. Resolve Reasoner mode
  const mode = getModeForIntent("cooking", intent);
  if (!mode) {
    const reason = `No Reasoner mode mapped for intent "${intent}" in domain "cooking".`;
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

  // 3. Gating (global / Torah / Sabbath / heavy-mode checks)
  const gatingDecision = await canCallReasoner({ domain: "cooking", intent, runtime });
  debug.push({ stage: "gating.checked", gatingDecision });

  if (!gatingDecision.allowed) {
    const reason = gatingDecision.reason || "Reasoner call not allowed by gating rules.";
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
  const context = await selectSpiceContext(input);
  debug.push({
    stage: "context.loaded",
    contextKeys: context ? Object.keys(context) : [],
  });

  // 5. Freshness rules
  const freshContext = applyFreshnessRules({
    domain: "cooking",
    intent,
    context,
    runtime,
  });
  debug.push({ stage: "freshness.applied" });

  // 6. Cache lookup
  const cacheKey = makeSpiceCacheKey({
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
      domain: "cooking",
      intent,
      mode,
      cacheKey,
    });
    debug.push({ stage: "cache.hit", cacheKey });

    const confidenceOk = enforceConfidence({
      domain: "cooking",
      intent,
      result: cached.data,
    });

    if (!confidenceOk) {
      warnings.push("Cached result rejected by confidence rules; making fresh Reasoner call.");
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
      domain: "cooking",
      intent,
      mode,
      cacheKey,
    });
    debug.push({ stage: "cache.miss", cacheKey });
  }

  // 7. Budget enforcement
  const budgetOk = await enforceBudget({
    domain: "cooking",
    intent,
    mode,
    runtime,
  });
  debug.push({ stage: "budget.checked", budgetOk });

  if (!budgetOk.allowed) {
    const reason = budgetOk.reason || "Budget exhausted or unavailable for this Reasoner call.";
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
    domain: "cooking",
    intent,
    input,
    context: freshContext,
    runtime,
  });

  debug.push({ stage: "prompt.built", promptSummary: summarizePrompt(prompt) });

  emit("reasoner.invoked", {
    domain: "cooking",
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
      domain: "cooking",
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
    domain: "cooking",
    intent,
    mode,
  });

  const validated = validationResult.value;

  // 11. Normalize domain-specific data (including cuisineCombos)
  const normalized = await normalizeReasonerOutput({
    intent,
    validated,
    input,
    context: freshContext,
  });

  warnings.push(...(normalized.warnings || []));
  const data = normalized.data || {};
  let session = normalized.session;

  // 12. If a session exists (e.g., flavor-adjust cooking session), run guards + persist + optional Hub export
  if (session) {
    const guarded = await evaluateGuards({
      session,
      domain: "cooking",
      guards: ["Sabbath", "QuietHours", "Weather", "Inventory", "Battery"],
    });

    session = guarded.session || session;
    data.session = session;

    // Persist to Dexie
    try {
      await sessionsDb.upsert(session);
      debug.push({ stage: "session.persisted", sessionId: session.id });
    } catch (err) {
      warnings.push("Failed to persist spice/cooking session to local DB.");
      debug.push({ stage: "session.persist.error", error: String(err) });
    }

    if (runtime.exportToHub) {
      await maybeExportToHub(session, runtime);
    }
  }

  // 13. Final confidence check
  const confidenceOk = enforceConfidence({
    domain: "cooking",
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
/* Per-intent wrappers (back-compat to old agent API)                         */
/* -------------------------------------------------------------------------- */

/**
 * analyzeDish(ctx) shim
 *  ctx: { dish, preferences, ... }
 */
export async function analyzeDish(ctx = {}) {
  const req = {
    domain: "cooking",
    intent: "analyzeDish",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * balanceDish(ctx) shim
 *  ctx: { dish, preferences, garden?, coalition? }
 */
export async function balanceDish(ctx = {}) {
  const req = {
    domain: "cooking",
    intent: "balanceDish",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * suggestBlends(ctx) shim
 *  ctx: { dish, preferences, mode, garden? }
 */
export async function suggestBlends(ctx = {}) {
  const req = {
    domain: "cooking",
    intent: "suggestBlends",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * buildSpicePantry(ctx) shim
 *  ctx: { cuisines, size, preferences, coalition, garden? }
 */
export async function buildSpicePantry(ctx = {}) {
  const req = {
    domain: "cooking",
    intent: "buildSpicePantry",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * planSpiceGarden(ctx) shim
 *  ctx: { keys, zone, cuisines }
 */
export async function planSpiceGarden(ctx = {}) {
  const req = {
    domain: "cooking",
    intent: "planSpiceGarden",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * generateSpiceKits(ctx) shim
 *  ctx: { blends, pricePerKit, qty, labelPreset }
 */
export async function generateSpiceKits(ctx = {}) {
  const req = {
    domain: "cooking",
    intent: "generateSpiceKits",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/* -------------------------------------------------------------------------- */
/* Back-compat command router                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Back-compat entrypoint that mimics:
 *   handleCommand(command, payload)
 *
 * Returns a ShimResponse.
 *
 * @param {string|Object} command
 * @param {Object} [payload]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}) {
  const mapping = {
    analyze: "analyzeDish",
    analyzedish: "analyzeDish",
    balance: "balanceDish",
    balancedish: "balanceDish",
    blends: "suggestBlends",
    suggestblends: "suggestBlends",
    pantry: "buildSpicePantry",
    buildpantry: "buildSpicePantry",
    kits: "generateSpiceKits",
    generatekits: "generateSpiceKits",
    spicegarden: "planSpiceGarden",
    plangarden: "planSpiceGarden",
  };

  const norm = (cmd) => mapping[String(cmd || "").toLowerCase().trim()] || cmd;

  let cmd = typeof command === "string"
    ? command
    : command?.command || command?.type || "analyze";

  cmd = norm(cmd);

  if (typeof command === "object" && command?.payload && !Object.keys(payload || {}).length) {
    // eslint-disable-next-line no-param-reassign
    payload = command.payload;
  }

  switch (cmd) {
    case "analyzeDish":
      return analyzeDish(payload);
    case "balanceDish":
      return balanceDish(payload);
    case "suggestBlends":
      return suggestBlends(payload);
    case "buildSpicePantry":
      return buildSpicePantry(payload);
    case "generateSpiceKits":
      return generateSpiceKits(payload);
    case "planSpiceGarden":
      return planSpiceGarden(payload);
    default:
      return makeShimResponse({
        ok: false,
        mode: "unknown.command",
        data: {
          summary: `Unknown spice command "${cmd}"`,
          message: "Use: analyze, balance, blends, pantry, kits, spicegarden.",
        },
        warnings: [`Unknown command "${cmd}"`],
        debug: [],
      });
  }
}

/* -------------------------------------------------------------------------- */
/* Event subscription (no UI logic)                                           */
/* -------------------------------------------------------------------------- */

/**
 * subscribe(bus)
 *  - Back-compat non-UI glue. We just emit invalidation events;
 *    UI toasts / DOM concerns are handled elsewhere.
 *
 * @param {Object} bus
 * @returns {boolean}
 */
export function subscribe(bus) {
  try {
    const on = bus?.on || (() => {});
    const emitBus = bus?.emit || (() => {});

    const invalidate = (reason) => {
      emitBus("spice.invalidate", { at: isoNow(), reason });
    };

    on("inventory.updated", () => invalidate("inventory.updated"));
    on("torah.profile.updated", () => invalidate("torah.profile.updated"));
    on("garden.plan.updated", () => invalidate("garden.plan.updated"));

    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Default export (back-compat object shape)                                  */
/* -------------------------------------------------------------------------- */

const spiceAgent = {
  name: "spiceShim",
  version: "2.0.0",
  actions: {
    analyzeDish,
    balanceDish,
    suggestBlends,
    buildSpicePantry,
    planSpiceGarden,
    generateSpiceKits,
    handleCommand,
    subscribe,
  },
};

export default spiceAgent;
