/* eslint-disable no-console */
/**
 * Storehouse Shim — PAR Planner, Maintenance & Label Export
 * -----------------------------------------------------------------------------
 * Shim wrapper that replaces the old storehouseAgent-style file.
 *
 * Responsibilities:
 *  - Accept a ShimRequest for the "storehouse" domain.
 *  - Normalize legacy intents:
 *      starterPlan, applyPlan, estimatePars, maintain, exportLabels, undo
 *  - Resolve Reasoner mode via modes/map.js.
 *  - Enforce:
 *      - gating.js (canCallReasoner)
 *      - budget.json (enforceBudget)
 *      - freshness.js (applyFreshnessRules)
 *      - confidence.js (enforceConfidence)
 *      - cache (getMemo / setMemo with keys.js)
 *  - Build a prompt using system.md + templates.
 *  - Call the Reasoner.
 *  - Validate output with mode schemas.
 *  - Normalize storehouse result into SSA data:
 *      targets, gaps, starter/maintenance plans, label export payload, etc.
 *  - Optionally compose a "storehouse" session from sessionDraft.
 *  - Persist sessions to Dexie and optionally export to the Hub.
 *  - Emit Reasoner & session events via eventBus.
 *
 * NOTE:
 *  - All the heavy logic (PAR math, maintenance workflows, label mapping)
 *    must live in Reasoner modes + schemas, not in this shim.
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
  selectStorehouseContext, // implement in selectors.js
} from "@/agents/runtime/selectors";

import { applyFreshnessRules } from "@/agents/runtime/freshness";

import {
  getMemo,
  setMemo,
} from "@/agents/runtime/cache/memo";

import {
  makeStorehouseCacheKey, // implement in cache/keys.js
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

const SHIM_SOURCE = "agents/shims/storehouse";
const isoNow = () => new Date().toISOString();

/**
 * Wrapper around the global event bus.
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
    console.warn("[storehouseShim] failed to emit event:", err);
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
  const allowedDomains = ["storehouse"];
  if (!allowedDomains.includes(req.domain)) {
    return {
      ok: false,
      reason: `Unsupported domain "${req.domain}". Expected "storehouse".`,
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
 * Normalize legacy storehouseAgent commands to canonical storehouse intents.
 *
 * @param {string} intent
 * @returns {string}
 */
function normalizeIntent(intent) {
  const s = String(intent || "").toLowerCase().trim();

  const map = {
    starterplan: "starterPlan",
    "starter_plan": "starterPlan",

    applyplan: "applyPlan",
    "apply_plan": "applyPlan",

    estimatepars: "estimatePars",

    maintain: "maintain",

    exportlabels: "exportLabels",
    "export_labels": "exportLabels",

    undo: "undo",
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
 * Normalize Reasoner output into SSA shapes for the "storehouse" domain.
 *
 * Expected (from mode schemas for storehouse modes) something like:
 *
 *   {
 *     summary?: string,
 *     targets?: Array<Object>,    // PAR targets
 *     gaps?: Array<Object>,       // shortfalls vs PAR
 *     plan?: any,                 // starter or maintenance plan (structured or markdown)
 *     labels?: Array<Object>,     // badges/labels for items or plan
 *
 *     maintenance?: {
 *       gapsPushed?: number,
 *       harvestsQueued?: number,
 *       details?: any
 *     },
 *
 *     exportResult?: any,         // label export payload/result
 *
 *     emptyState?: string | null,
 *     recommendations?: string[],
 *     logs?: string[],
 *
 *     sessionDraft?: Object       // optional: "storehouse" session draft
 *   }
 *
 * This shim does not enforce a specific shape beyond what schemas guarantee,
 * but it extracts these common fields for consumers and SessionRunner.
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
  const targets = Array.isArray(validated.targets) ? validated.targets : [];
  const gaps = Array.isArray(validated.gaps) ? validated.gaps : [];
  const plan = typeof validated.plan !== "undefined" ? validated.plan : null;
  const labels = Array.isArray(validated.labels) ? validated.labels : [];

  const maintenance = validated.maintenance || null;
  const exportResult = validated.exportResult || null;

  const emptyState = typeof validated.emptyState === "string" ? validated.emptyState : null;
  const recommendations = Array.isArray(validated.recommendations)
    ? validated.recommendations
    : [];
  const logs = Array.isArray(validated.logs) ? validated.logs : [];

  let session;
  const sessionDraft = validated.sessionDraft || null;

  // Only some intents are expected to generate interactive sessions:
  // - starterPlan: maybe a "stock the storehouse" multi-step session
  // - maintain: maintenance/inspection/checklist flow
  // - applyPlan: applying PAR to inventory might also be sessionized
  if (
    sessionDraft &&
    (canonicalIntent === "starterPlan" ||
      canonicalIntent === "maintain" ||
      canonicalIntent === "applyPlan")
  ) {
    session = await composeSession({
      domain: "storehouse",
      intent: canonicalIntent,
      draft: sessionDraft,
      input,
      context,
    });
  }

  return {
    data: {
      summary,
      targets,
      gaps,
      plan,
      labels,
      maintenance,
      exportResult,
      emptyState,
      recommendations,
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
 * Optionally export a storehouse session to the Family Fund Hub.
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
 * Main Storehouse Shim entrypoint.
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

  const intent = normalizeIntent(req.intent);
  const input = req.input || {};
  const runtime = req.runtime || {};
  const domain = req.domain; // "storehouse"

  debug.push({
    stage: "request.accepted",
    intent,
    domain,
    inputKeys: Object.keys(input || {}),
  });

  // 2. Resolve Reasoner mode
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

  // 3. Gating checks
  const gatingDecision = await canCallReasoner({ domain: "storehouse", intent, runtime });
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
  const context = await selectStorehouseContext(input);
  debug.push({
    stage: "context.loaded",
    contextKeys: context ? Object.keys(context) : [],
  });

  // 5. Freshness rules
  const freshContext = applyFreshnessRules({
    domain: "storehouse",
    intent,
    context,
    runtime,
  });
  debug.push({ stage: "freshness.applied" });

  // 6. Cache lookup
  const cacheKey = makeStorehouseCacheKey({
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

    const confidenceOk = enforceConfidence({
      domain: "storehouse",
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
      domain: "storehouse",
      intent,
      mode,
      cacheKey,
    });
    debug.push({ stage: "cache.miss", cacheKey });
  }

  // 7. Budget enforcement
  const budgetOk = await enforceBudget({
    domain: "storehouse",
    intent,
    mode,
    runtime,
  });
  debug.push({ stage: "budget.checked", budgetOk });

  if (!budgetOk.allowed) {
    const reason =
      budgetOk.reason || "Budget exhausted or unavailable for this Reasoner call.";
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

  // 12. If a session exists (e.g., storehouse maintenance or stocking session),
  //     run guards + persist + optional Hub export.
  if (session) {
    const guarded = await evaluateGuards({
      session,
      domain: "storehouse",
      guards: ["Sabbath", "QuietHours", "Inventory", "Battery"],
    });

    session = guarded.session || session;
    data.session = session;

    // Persist to Dexie Sessions store
    try {
      await sessionsDb.upsert(session);
      debug.push({ stage: "session.persisted", sessionId: session.id });
    } catch (err) {
      warnings.push("Failed to persist storehouse session to local DB.");
      debug.push({ stage: "session.persist.error", error: String(err) });
    }

    if (runtime.exportToHub) {
      await maybeExportToHub(session, runtime);
    }
  }

  // 13. Final confidence check
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
/* Per-intent wrappers (back-compat style)                                    */
/* -------------------------------------------------------------------------- */

/**
 * starterPlan(ctx)
 *   ctx expected to include:
 *     { people, days, includeNonFood, budget, dietNotes, controlLevel, templateId, ... }
 *
 * Returns a ShimResponse.
 */
export async function starterPlan(ctx = {}) {
  const req = {
    domain: "storehouse",
    intent: "starterPlan",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * applyPlan(planOrCtx, maybeOptions)
 *   Legacy agent signature:
 *     applyPlan(planTextOrObj, options?)
 *
 *   Shim supports:
 *     - applyPlan({ plan, options, ... })
 *     - applyPlan(planTextOrObj, options)
 */
export async function applyPlan(planOrCtx, maybeOptions = {}) {
  let input;

  if (
    typeof planOrCtx === "string" ||
    Array.isArray(planOrCtx) ||
    (planOrCtx && typeof planOrCtx === "object" && !planOrCtx.plan && !planOrCtx.options)
  ) {
    input = { plan: planOrCtx, options: maybeOptions || {} };
  } else {
    input = planOrCtx || {};
  }

  const req = {
    domain: "storehouse",
    intent: "applyPlan",
    input,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * estimatePars(ctx)
 *   ctx expected to include:
 *     { people, days, includeNonFood, ... }
 *
 * NOTE: actual PAR math is handled inside Reasoner mode.
 */
export async function estimatePars(ctx = {}) {
  const req = {
    domain: "storehouse",
    intent: "estimatePars",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * maintain(ctx)
 *   ctx may include:
 *     { controlLevel, vendorPrefs, budgetLimit, ... }
 *
 * NOTE: inventory/procurement/preservation coordination handled by Reasoner.
 */
export async function maintain(ctx = {}) {
  const req = {
    domain: "storehouse",
    intent: "maintain",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/**
 * exportLabels(ctx)
 *   ctx expected to include:
 *     { items, scope, badges, ... }
 *
 * NOTE: label shaping + exportService integration handled by Reasoner.
 */
export async function exportLabels(ctx = {}) {
  const req = {
    domain: "storehouse",
    intent: "exportLabels",
    input: ctx,
    runtime: {},
  };
  return invokeShim(req);
}

/* -------------------------------------------------------------------------- */
/* Back-compat command router                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Back-compat entrypoint similar to the old:
 *   handleCommand(cmd, payload)
 *
 * Returns a ShimResponse.
 *
 * Supported commands:
 *   "starterPlan", "applyPlan", "estimatePars", "maintain", "exportLabels", "undo"
 *
 * "undo" no longer uses an internal undo stack; instead, it returns
 * a standardized failure response so higher-level systems can handle history.
 *
 * @param {string|Object} cmd
 * @param {Object} [payload]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(cmd, payload = {}) {
  let command = cmd;

  if (typeof cmd === "object" && cmd !== null) {
    command = cmd.command || cmd.type || "starterPlan";
    if (cmd.payload && !Object.keys(payload || {}).length) {
      // eslint-disable-next-line no-param-reassign
      payload = cmd.payload;
    }
  }

  const normalized = normalizeIntent(command);

  switch (normalized) {
    case "starterPlan":
      return starterPlan(payload);

    case "applyPlan":
      return applyPlan(payload?.plan || payload, {
        controlLevel: payload?.controlLevel,
      });

    case "estimatePars":
      return estimatePars(payload || {});

    case "maintain":
      return maintain(payload || {});

    case "exportLabels":
      return exportLabels(payload || {});

    case "undo":
      // Old agent used an in-memory undo stack; shim cannot hold global mutable state.
      return makeShimResponse({
        ok: false,
        mode: "undo.unsupported",
        data: {
          summary: "Undo is not supported at the shim layer.",
          message:
            "Use higher-level history/automation to revert storehouse actions instead.",
        },
        warnings: ["Undo not supported in storehouseShim."],
        debug: [],
      });

    default:
      return makeShimResponse({
        ok: false,
        mode: "unknown.command",
        data: {
          summary: `Unknown storehouse command "${normalized}"`,
          message:
            "Use: starterPlan, applyPlan, estimatePars, maintain, exportLabels, undo.",
        },
        warnings: [`Unknown command "${normalized}"`],
        debug: [],
      });
  }
}

/* -------------------------------------------------------------------------- */
/* Event subscription (no UI / DOM logic)                                     */
/* -------------------------------------------------------------------------- */

/**
 * subscribe(bus)
 *  - Back-compat glue: listens to domain events and emits a generic
 *    "storehouse.invalidate" event on changes.
 *  - NO UI events (no ui.toast, no DOM).
 *
 * @param {Object} bus
 * @returns {boolean}
 */
export function subscribe(bus) {
  try {
    const on = bus?.on || (() => {});
    const emitBus = bus?.emit || (() => {});

    const invalidate = (reason) => {
      emitBus("storehouse.invalidate", { at: isoNow(), reason });
    };

    on("recipe.consolidated", () => invalidate("recipe.consolidated"));
    on("inventory.updated", () => invalidate("inventory.updated"));
    on("calendar.synced", () => invalidate("calendar.synced"));
    on("preferences.changed", () => invalidate("preferences.changed"));

    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Optional class/factory (minimal back-compat)                               */
/* -------------------------------------------------------------------------- */

/**
 * Minimal StorehouseAgent wrapper for older code that expects a class instance.
 * This no longer extends automation BaseAgent; it simply forwards to handleCommand.
 */
export class StorehouseAgent {
  constructor(opts = {}) {
    this.name = "storehouseShim";
    this.version = "2.0.0";
    this.opts = opts;
  }

  /**
   * Proxy legacy handleCommand to shim handleCommand.
   *
   * @param {string|Object} cmd
   * @param {Object} [payload]
   * @returns {Promise<ShimResponse>}
   */
  async handleCommand(cmd, payload) {
    return handleCommand(cmd, payload);
  }
}

/**
 * createAgent(opts)
 *  - Legacy factory wrapper, returns a StorehouseAgent instance.
 *
 * @param {Object} opts
 * @returns {StorehouseAgent}
 */
export function createAgent(opts) {
  return new StorehouseAgent(opts);
}

/* -------------------------------------------------------------------------- */
/* Default export (back-compat object shape)                                  */
/* -------------------------------------------------------------------------- */

const api = {
  handleCommand,
  starterPlan,
  applyPlan,
  estimatePars,
  maintain,
  exportLabels,
};

export default api;
