// C:\Users\larho\suka-smart-assistant\src\agents\shims\preservationShim.js
/* eslint-disable no-console */

/**
 * Preservation Shim — SSA Reasoner bridge (no UI, no DOM)
 * ------------------------------------------------------------------
 * Responsibilities:
 * - Normalize intents for the preservation domain (plan/simulate/creator tools)
 * - Select the correct Reasoner mode
 * - Build prompts from templates + system instructions
 * - Enforce budget / gating / confidence / freshness
 * - Optionally use cache
 * - Validate Reasoner output against the correct schema
 * - Normalize into SSA-friendly data + preservation sessions
 * - Emit SSA events (reasoner + optional Hub export)
 *
 * This replaces the old preservationAgent "big object" with a thin shim.
 */

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */

import { emit as emitEvent } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

import { checkBudget } from "@/agents/runtime/budget";
import { canInvokeReasoner } from "@/agents/runtime/gating";
import { evaluateConfidence } from "@/agents/runtime/confidence";
import { getPreservationContext } from "@/agents/runtime/selectors";
import { applyFreshnessRules } from "@/agents/runtime/freshness";

import { maybeGetCached, updateCache } from "@/agents/cache/memo";
import { makeCacheKey } from "@/agents/cache/keys";

import { selectMode } from "@/agents/modes/map";
import { validateWithSchema } from "@/agents/modes/validate";
import { buildPrompt } from "@/agents/prompts/templates";
import { callReasoner } from "@/agents/runtime/reasoner";

import { composeSessionsFromPreservationPlan } from "@/skills/sessions/compose";

/* -------------------------------------------------------------------------- */
/* JSDoc Types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} ShimDomain
 */

/**
 * @typedef {Object} ShimRequest
 * @property {ShimDomain} domain                - Must be "preservation" for this shim
 * @property {string} intent                    - High-level intent (e.g. "planJobs", "simulate")
 * @property {Object} input                     - Intent-specific input payload
 * @property {Object} [runtime]                 - Runtime hints (budget, user, tracing, etc.)
 */

/**
 * @typedef {Object} ShimResponse
 * @property {boolean} ok                       - True if Reasoner flow succeeded and schema validated
 * @property {string} mode                      - Selected Reasoner mode key
 * @property {Object} data                      - Normalized payload (plan/sessions/etc.)
 * @property {Array<Object>} [warnings]         - Non-fatal warnings
 * @property {Array<Object>} [debug]            - Debug trace for observability
 */

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

const nowISO = () => new Date().toISOString();

function pushDebug(debugArr, label, payload) {
  debugArr.push({ ts: nowISO(), label, payload });
}

/**
 * Normalize incoming intent → internal mode key segment
 * (keeps back-compat with many legacy command names from the old agent)
 * @param {string} intent
 * @returns {string}
 */
function normalizeIntent(intent) {
  const raw = String(intent || "").toLowerCase().trim();

  const map = {
    // legacy queue / planning
    buildqueue: "planJobs",
    queue: "planJobs",
    plan: "planJobs",
    "preservation.plan": "planJobs",
    "preservation.planjobs": "planJobs",

    // legacy method-plan
    methodplan: "methodPlan",
    planmethod: "methodPlan",
    method: "methodPlan",
    "preservation.methodplan": "methodPlan",

    // simulation / commit-like flows
    simulate: "simulate",
    "preservation.simulate": "simulate",

    // creator toolkit
    creatorpack: "creatorPack",
    "preservation.creatorpack": "creatorPack",

    // coalition-only utilities
    coalitionsplit: "coalitionSplit",
    "preservation.coalitionsplit": "coalitionSplit",

    // templates
    listtemplates: "listTemplates",
    "preservation.listtemplates": "listTemplates",
  };

  return map[raw] || raw;
}

/**
 * Map normalized intent → Reasoner mode key
 * These keys must exist in modes/map.js for this shim to work fully.
 * @param {string} normalizedIntent
 * @returns {string}
 */
function mapIntentToModeKey(normalizedIntent) {
  switch (normalizedIntent) {
    case "planJobs":
      return "preservation.plan.jobs";
    case "simulate":
      return "preservation.simulate.plan";
    case "creatorPack":
      return "preservation.creator.pack";
    case "coalitionSplit":
      return "preservation.coalition.split";
    case "methodPlan":
      return "preservation.method.plan";
    case "listTemplates":
      return "preservation.templates.list";
    default:
      return "";
  }
}

/**
 * Construct a standard ShimResponse
 * @param {Object} params
 * @param {boolean} params.ok
 * @param {string} params.mode
 * @param {Object} params.data
 * @param {Array<Object>} [params.warnings]
 * @param {Array<Object>} [params.debug]
 * @returns {ShimResponse}
 */
function makeShimResponse({ ok, mode, data, warnings = [], debug = [] }) {
  return { ok, mode, data, warnings, debug };
}

/* -------------------------------------------------------------------------- */
/* Core invokeShim                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Main Preservation Shim entrypoint.
 * This is the *only* function external callers should use.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const debug = [];
  const warnings = [];

  try {
    pushDebug(debug, "request.received", { req });

    if (!req || typeof req !== "object") {
      return makeShimResponse({
        ok: false,
        mode: "preservation/unknown",
        data: { reason: "invalid_request", detail: "ShimRequest must be an object." },
        warnings: [{ code: "invalid_request", message: "Request must be an object." }],
        debug,
      });
    }

    const domain = /** @type {ShimDomain} */ (req.domain || "preservation");
    const normalizedIntent = normalizeIntent(req.intent);
    const runtime = req.runtime || {};
    const input = req.input || {};

    if (domain !== "preservation") {
      warnings.push({
        code: "wrong_domain",
        message: `Preservation shim only supports domain "preservation", received "${domain}".`,
      });
      return makeShimResponse({
        ok: false,
        mode: "preservation/invalid-domain",
        data: { reason: "invalid_domain" },
        warnings,
        debug,
      });
    }

    if (!normalizedIntent) {
      warnings.push({
        code: "missing_intent",
        message: "No intent provided for preservation shim.",
      });
      return makeShimResponse({
        ok: false,
        mode: "preservation/missing-intent",
        data: { reason: "missing_intent" },
        warnings,
        debug,
      });
    }

    const modeKey = mapIntentToModeKey(normalizedIntent);
    if (!modeKey) {
      warnings.push({
        code: "unknown_intent",
        message: `Unknown preservation intent "${req.intent}".`,
      });
      return makeShimResponse({
        ok: false,
        mode: "preservation/unknown-intent",
        data: { reason: "unknown_intent", intent: req.intent },
        warnings,
        debug,
      });
    }

    // -----------------------------------------------------------------------
    // Mode selection
    // -----------------------------------------------------------------------
    const mode = selectMode({ domain, intent: normalizedIntent, modeKey });
    if (!mode) {
      warnings.push({
        code: "mode_not_found",
        message: `No Reasoner mode configured for "${modeKey}".`,
      });
      pushDebug(debug, "mode.missing", { modeKey });
      return makeShimResponse({
        ok: false,
        mode: modeKey,
        data: { reason: "mode_not_found", modeKey },
        warnings,
        debug,
      });
    }

    pushDebug(debug, "mode.selected", { mode });

    // -----------------------------------------------------------------------
    // Gating (when not allowed to call Reasoner)
    // -----------------------------------------------------------------------
    const gating = await canInvokeReasoner({ domain, intent: normalizedIntent, mode, runtime, input });
    pushDebug(debug, "gating.result", gating);

    if (!gating.allowed) {
      warnings.push({
        code: "gating_block",
        message: gating.reason || "Reasoner call not allowed.",
      });
      emitEvent({
        type: "reasoner.gated",
        ts: nowISO(),
        source: "agents/shims/preservation",
        data: { domain, intent: normalizedIntent, mode: mode.name, reason: gating.reason || null },
      });
      return makeShimResponse({
        ok: false,
        mode: mode.name,
        data: { reason: "gated", details: gating },
        warnings,
        debug,
      });
    }

    // -----------------------------------------------------------------------
    // Context & freshness
    // -----------------------------------------------------------------------
    const context = await getPreservationContext({ domain, intent: normalizedIntent, input, runtime });
    pushDebug(debug, "context.loaded", { contextSummary: context?.summary || null });

    const { input: freshInput, context: freshContext } = applyFreshnessRules({
      domain,
      intent: normalizedIntent,
      mode,
      input,
      context,
      runtime,
    });

    pushDebug(debug, "freshness.applied", { freshInput, freshContext });

    // -----------------------------------------------------------------------
    // Memoization / cache
    // -----------------------------------------------------------------------
    const cacheKey = makeCacheKey({ domain, intent: normalizedIntent, mode: mode.name, input: freshInput });
    let cached = null;

    if (mode.cache !== false) {
      cached = await maybeGetCached(cacheKey);
      if (cached) {
        emitEvent({
          type: "reasoner.cache.hit",
          ts: nowISO(),
          source: "agents/shims/preservation",
          data: { cacheKey, domain, intent: normalizedIntent, mode: mode.name },
        });
        pushDebug(debug, "cache.hit", { cacheKey });

        const normalizedFromCache = await normalizeOutput(normalizedIntent, mode, cached);
        const data = await buildShimData(normalizedIntent, mode, normalizedFromCache, runtime);

        return makeShimResponse({
          ok: true,
          mode: mode.name,
          data: {
            ...data,
            fromCache: true,
            cacheKey,
          },
          warnings,
          debug,
        });
      }

      emitEvent({
        type: "reasoner.cache.miss",
        ts: nowISO(),
        source: "agents/shims/preservation",
        data: { cacheKey, domain, intent: normalizedIntent, mode: mode.name },
      });
      pushDebug(debug, "cache.miss", { cacheKey });
    }

    // -----------------------------------------------------------------------
    // Prompt building
    // -----------------------------------------------------------------------
    const prompt = await buildPrompt({
      systemId: mode.systemId || "preservation.system",
      templateId: mode.templateId || mode.name,
      mode: mode.name,
      domain,
      intent: normalizedIntent,
      input: freshInput,
      context: freshContext,
      runtime,
    });

    pushDebug(debug, "prompt.built", { promptPreview: prompt?.preview || null });

    // -----------------------------------------------------------------------
    // Budget enforcement
    // -----------------------------------------------------------------------
    const budgetResult = await checkBudget({
      domain,
      intent: normalizedIntent,
      mode,
      runtime,
      prompt,
    });

    pushDebug(debug, "budget.checked", budgetResult);

    if (!budgetResult.ok) {
      warnings.push({
        code: "budget_exceeded",
        message: budgetResult.reason || "Budget exceeded for this operation.",
      });
      emitEvent({
        type: "reasoner.budget.exceeded",
        ts: nowISO(),
        source: "agents/shims/preservation",
        data: { domain, intent: normalizedIntent, mode: mode.name, ...budgetResult },
      });
      return makeShimResponse({
        ok: false,
        mode: mode.name,
        data: { reason: "budget_exceeded", budget: budgetResult },
        warnings,
        debug,
      });
    }

    // -----------------------------------------------------------------------
    // Reasoner invocation
    // -----------------------------------------------------------------------
    emitEvent({
      type: "reasoner.invoked",
      ts: nowISO(),
      source: "agents/shims/preservation",
      data: { domain, intent: normalizedIntent, mode: mode.name },
    });

    const reasonerResult = await callReasoner({
      mode: mode.name,
      prompt,
      runtime,
    });

    pushDebug(debug, "reasoner.result", {
      usage: reasonerResult?.usage || null,
      meta: reasonerResult?.meta || null,
    });

    const rawOutput = reasonerResult?.output ?? reasonerResult;
    if (!rawOutput) {
      warnings.push({
        code: "empty_reasoner_output",
        message: "Reasoner returned no output.",
      });
      return makeShimResponse({
        ok: false,
        mode: mode.name,
        data: { reason: "empty_output" },
        warnings,
        debug,
      });
    }

    // -----------------------------------------------------------------------
    // Schema validation
    // -----------------------------------------------------------------------
    const validation = await validateWithSchema(mode.schemaId, rawOutput);
    pushDebug(debug, "schema.validation", validation);

    if (!validation.ok) {
      warnings.push({
        code: "invalid_schema",
        message: "Reasoner output failed schema validation.",
        errors: validation.errors,
      });
      emitEvent({
        type: "reasoner.invalidSchema",
        ts: nowISO(),
        source: "agents/shims/preservation",
        data: {
          domain,
          intent: normalizedIntent,
          mode: mode.name,
          schemaId: mode.schemaId,
          errors: validation.errors,
        },
      });

      return makeShimResponse({
        ok: false,
        mode: mode.name,
        data: {
          reason: "invalid_schema",
          errors: validation.errors,
        },
        warnings,
        debug,
      });
    }

    emitEvent({
      type: "reasoner.validated",
      ts: nowISO(),
      source: "agents/shims/preservation",
      data: {
        domain,
        intent: normalizedIntent,
        mode: mode.name,
        schemaId: mode.schemaId,
      },
    });

    // -----------------------------------------------------------------------
    // Confidence evaluation
    // -----------------------------------------------------------------------
    const confidence = await evaluateConfidence({
      domain,
      intent: normalizedIntent,
      mode,
      result: validation.data,
      usage: reasonerResult?.usage,
      runtime,
    });

    pushDebug(debug, "confidence.evaluated", confidence);

    if (!confidence.ok) {
      warnings.push({
        code: "low_confidence",
        message: confidence.reason || "Reasoner result below confidence threshold.",
      });
      // We still return the result but flag low confidence; callers may decide.
    }

    // -----------------------------------------------------------------------
    // Cache store (if enabled)
    // -----------------------------------------------------------------------
    if (mode.cache !== false && cacheKey) {
      try {
        await updateCache(cacheKey, {
          mode: mode.name,
          domain,
          intent: normalizedIntent,
          data: validation.data,
          usage: reasonerResult?.usage || null,
        });
        pushDebug(debug, "cache.updated", { cacheKey });
      } catch (e) {
        warnings.push({
          code: "cache_update_failed",
          message: `Failed to update cache: ${e?.message || String(e)}`,
        });
        pushDebug(debug, "cache.update.error", { error: String(e) });
      }
    }

    // -----------------------------------------------------------------------
    // Normalization → Shim-level data
    // -----------------------------------------------------------------------
    const normalized = await normalizeOutput(normalizedIntent, mode, validation.data);
    const data = await buildShimData(normalizedIntent, mode, normalized, runtime, reasonerResult);

    // -----------------------------------------------------------------------
    // Optional Hub export (familyFundMode)
    // -----------------------------------------------------------------------
    if (familyFundMode && mode.exportable !== false) {
      try {
        const hubPacket = HubPacketFormatter.fromPreservationShim({
          domain,
          intent: normalizedIntent,
          mode: mode.name,
          input: freshInput,
          context: freshContext,
          result: normalized,
          sessions: data.sessions || [],
          usage: reasonerResult?.usage || null,
        });

        await FamilyFundConnector.queueExport(hubPacket);

        emitEvent({
          type: "session.exported",
          ts: nowISO(),
          source: "agents/shims/preservation",
          data: { domain, intent: normalizedIntent, mode: mode.name, hubPacketId: hubPacket?.id || null },
        });

        pushDebug(debug, "hub.exported", { hubPacketId: hubPacket?.id || null });
      } catch (e) {
        warnings.push({
          code: "hub_export_failed",
          message: `Failed to export preservation data to Hub: ${e?.message || String(e)}`,
        });
        pushDebug(debug, "hub.export.error", { error: String(e) });
      }
    }

    return makeShimResponse({
      ok: true,
      mode: mode.name,
      data,
      warnings,
      debug,
    });
  } catch (err) {
    console.error("[preservationShim] invokeShim error:", err);
    warnings.push({
      code: "shim_exception",
      message: err?.message || String(err),
    });
    return makeShimResponse({
      ok: false,
      mode: "preservation/error",
      data: {
        reason: "exception",
        error: { message: err?.message || String(err), stack: err?.stack || null },
      },
      warnings,
      debug,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Normalization & Shim data builders                                         */
/* -------------------------------------------------------------------------- */

/**
 * Normalize Reasoner result into a predictable object for this shim.
 * This is where we map legacy shapes (planJobs/simulate/etc.) into a
 * common "plan-ish" contract for the rest of SSA.
 *
 * @param {string} normalizedIntent
 * @param {Object} mode
 * @param {any} raw
 * @returns {Promise<Object>}
 */
async function normalizeOutput(normalizedIntent, mode, raw) {
  // NOTE: We assume schemas already enforce basic structure; this function
  // just does light massaging for SSA.
  const out = raw || {};

  switch (normalizedIntent) {
    case "planJobs":
      // Expected schema: preservation.plan.jobs.result
      // { plan: { planned:[], blocked:[], timezone, ... }, summary, warnings? }
      return {
        summary: out.summary || null,
        plan: out.plan || null,
        blocked: out.blocked || [],
        timezone: out.timezone || null,
      };

    case "simulate":
      // Expected schema: preservation.simulate.plan.result
      // { commitPacket, preview, warnings? }
      return {
        summary: out.summary || null,
        commitPacket: out.commitPacket || null,
        preview: out.preview || null,
      };

    case "creatorPack":
      // Expected: { pack: { lot, summary, cogs, suggested, qrUrl, labels } }
      return {
        pack: out.pack || null,
      };

    case "coalitionSplit":
      // Expected: { lot, per, windows }
      return {
        lot: out.lot || null,
        per: out.per || [],
        windows: out.windows || [],
      };

    case "methodPlan":
      // Expected: { plan: { jobItem/queueItem }, summary }
      return {
        summary: out.summary || null,
        plan: out.plan || null,
      };

    case "listTemplates":
      // Expected: { templates: [] }
      return {
        templates: out.templates || [],
      };

    default:
      // Default: pass through
      return out;
  }
}

/**
 * Build final shim-facing data object from normalized Reasoner output.
 * This is where we optionally compose Sessions, but we do *not* run them.
 *
 * @param {string} normalizedIntent
 * @param {Object} mode
 * @param {Object} normalized
 * @param {Object} runtime
 * @param {Object} [reasonerResult]
 * @returns {Promise<Object>}
 */
async function buildShimData(normalizedIntent, mode, normalized, runtime, reasonerResult) {
  const base = {
    intent: normalizedIntent,
    mode: mode.name,
    result: normalized,
    usage: reasonerResult?.usage || null,
  };

  // Only some intents need preservation sessions.
  if (normalizedIntent === "planJobs" || normalizedIntent === "simulate" || normalizedIntent === "methodPlan") {
    let planForSessions = null;

    if (normalizedIntent === "planJobs") {
      planForSessions = normalized.plan || null;
    } else if (normalizedIntent === "simulate") {
      // simulate result may include a full plan in `preview.plan`
      planForSessions = normalized.preview?.plan || normalized.commitPacket?.plan || null;
    } else if (normalizedIntent === "methodPlan") {
      // single job item → we treat as a 1-job plan
      planForSessions = normalized.plan
        ? { planned: [normalized.plan], blocked: [], timezone: runtime?.timezone || null }
        : null;
    }

    if (planForSessions) {
      try {
        const sessions = await composeSessionsFromPreservationPlan(planForSessions, {
          runtime,
        });

        return {
          ...base,
          sessions,
        };
      } catch (e) {
        // If session composition fails, we still return the plan.
        return {
          ...base,
          sessions: [],
          sessionError: e?.message || String(e),
        };
      }
    }
  }

  return base;
}

/* -------------------------------------------------------------------------- */
/* Optional tiny wrapper for legacy command-style calls                       */
/* -------------------------------------------------------------------------- */

/**
 * Legacy-style entrypoint to preserve the old `handleCommand` shape.
 * This is a thin adapter over invokeShim and should be used only where
 * the rest of the app still expects the old preservationAgent API.
 *
 * @param {string|Object} command
 * @param {Object} [payload]
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommandLegacy(command, payload = {}, runtime = {}) {
  let intent = "";
  let input = {};

  if (typeof command === "string") {
    intent = command;
    input = payload || {};
  } else if (command && typeof command === "object") {
    intent = command.command || command.type || "plan";
    input = command.payload || payload || {};
  } else {
    intent = "plan";
    input = payload || {};
  }

  return invokeShim({
    domain: "preservation",
    intent,
    input,
    runtime,
  });
}
