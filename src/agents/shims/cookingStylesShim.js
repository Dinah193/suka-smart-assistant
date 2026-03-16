// src/agents/shims/cookingStylesShim.js
// -----------------------------------------------------------------------------
// SSA Cooking Styles Shim
//
// Replaces the old "cookingStylesAgent" that used to:
//
//  - Load a JSON template and call callLLM directly to generate a style plan
//  - Pull preferences and sliders from CookingPrefsStore
//  - Apply slider/texture adjustments to the returned plan
//  - Emit automation events for draftReady, timers, bucket suggestions, etc.
//  - Learn from feedback and nudge CookingPrefsStore
//  - Drive UI timers and step events
//
// New behavior (SSA-compliant shim):
//  - Delegates all LLM + planning logic to the central Reasoner.
//  - Uses budget.json, gating, confidence, freshness, memo cache.
//  - Uses selectors.js to fetch cooking-style context (prefs, sliders, history).
//  - Uses modes/map.js + mode schemas for validation.
//  - Emits standardized reasoner.* and session.* export events via eventBus.
//  - Optionally composes Sessions from style plans and exports to the Hub.
//
// High-level intents:
//
//   "cooking.style.generate"        ← old generateStyle()
//   "cooking.style.approveDraft"    ← old approveStyleDraft()
//   "cooking.style.startRun"        ← old startPlanRun()
//   "cooking.style.markStepComplete"← old markStepComplete()
//   "cooking.style.learnFeedback"   ← old learnFromFeedback()
//
// NOTE:
// - All UI wiring (timers/register, styles/draftReady, styles/approved, etc.)
//   now lives in the automation/runtime + SessionRunner layer, not the shim.
// - All direct CookingPrefsStore manipulation is now a Reasoner responsibility.
//
// -----------------------------------------------------------------------------
// ✅ Added (buildChecklist):
// - Some UI components (TechniqueFeedbackBar) expect buildChecklist() to exist.
// - This implementation is deterministic (no Reasoner call), browser-safe,
//   and tries to derive a useful checklist from common plan shapes.
//
// -----------------------------------------------------------------------------

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

import budget from "@/reasoner/budget.js";
import { canInvokeReasoner } from "@/reasoner/gating";
import { evaluateConfidence } from "@/reasoner/confidence";
import { selectCookingContext } from "@/reasoner/selectors";
import { applyFreshnessRules } from "@/reasoner/freshness";
import { getMemo, setMemo } from "@/reasoner/cache/memo";
import { buildCookingMemoKey } from "@/reasoner/cache/keys";
import { resolveMode } from "@/reasoner/modes/map";
import { validateModeOutput } from "@/reasoner/modes/validate";
import { getSystemPrompt } from "@/reasoner/prompts/system";
import { buildCookingPrompt } from "@/reasoner/prompts/templates";
import { invokeReasoner } from "@/reasoner/core";

import { evaluateGuards } from "@/agents/skills/sessions/guardsEvaluate";
import { composeSessionsFromPlan } from "@agents/skills/sessions/compose";

import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

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

const SHIM_SOURCE = "agents/shims/cookingStyles";
const isoNow = () => new Date().toISOString();

/**
 * Build a standard ShimResponse.
 * @param {boolean} ok
 * @param {string} mode
 * @param {Object} data
 * @param {Array<Object>} [warnings]
 * @param {Array<Object>} [debug]
 * @returns {ShimResponse}
 */
function buildShimResponse(ok, mode, data, warnings = [], debug = []) {
  return {
    ok: Boolean(ok),
    mode: mode || "none",
    data: data || {},
    warnings,
    debug,
  };
}

/**
 * Build an error ShimResponse.
 * @param {string} reason
 * @param {string} [mode]
 * @param {Error} [err]
 * @param {Array<Object>} [debug]
 * @returns {ShimResponse}
 */
function buildErrorResponse(reason, mode = "none", err, debug = []) {
  const payload = {
    reason,
    ...(err
      ? {
          error: {
            message: err.message || String(err),
            name: err.name || "Error",
          },
        }
      : {}),
  };

  return buildShimResponse(
    false,
    mode,
    payload,
    [{ type: "error", reason }],
    debug
  );
}

/**
 * Enforce budget constraints using budget.json for cooking styles.
 *
 * @param {ShimRequest} reqLike
 * @param {Array<Object>} debug
 * @returns {{ ok: boolean, reason?: string }}
 */
function enforceBudget(reqLike, debug) {
  const domainBudget =
    (budget && (budget.cookingStyles || budget.cooking || budget.household)) ||
    {};

  const maxChars = domainBudget.maxChars || 20000;
  const serializedInput = JSON.stringify(reqLike.input || {});
  const estimateSize = serializedInput.length;

  debug.push({
    stage: "budget.check",
    maxChars,
    estimateSize,
  });

  if (estimateSize > maxChars) {
    return {
      ok: false,
      reason: "input_too_large_for_cookingStyles_budget",
    };
  }

  return { ok: true };
}

/**
 * Resolve Reasoner mode for a cooking styles request via modes/map.js.
 *
 * @param {ShimRequest} req
 * @param {Object} context
 * @returns {string}
 */
function resolveShimMode(req, context) {
  return (
    resolveMode({
      domain: "cooking",
      intent: req.intent,
      context,
      runtime: req.runtime || {},
      source: SHIM_SOURCE,
    }) ||
    req.intent ||
    "cooking.style.generate"
  );
}

/**
 * Optionally compose cooking sessions from Reasoner output.
 *
 * Expected payload shape from Reasoner (example):
 *
 * {
 *   stylePlan: {...},        // full style plan
 *   sessionsDraft: [
 *     {
 *       title: "House-style braise workflow",
 *       domain: "cooking",
 *       sourceType: "manual",
 *       refId: "style:bolognese:house",
 *       // stepsDraft, timing, etc...
 *     }
 *   ]
 * }
 *
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<Array<Object>>}
 */
async function maybeComposeSessions(normalizedData, req, debug) {
  const drafts = normalizedData && normalizedData.sessionsDraft;
  if (!Array.isArray(drafts) || !drafts.length) return [];

  const sessions = await composeSessionsFromPlan({
    domain: "cooking",
    drafts,
    source: {
      type: normalizedData.sourceType || "manual",
      refId: normalizedData.sourceRefId || null,
    },
    runtime: req.runtime || {},
  });

  debug.push({
    stage: "sessions.compose",
    count: Array.isArray(sessions) ? sessions.length : 0,
  });

  return Array.isArray(sessions) ? sessions : [];
}

/**
 * Export cooking style plan/session info to Hub if familyFundMode is enabled.
 *
 * @param {Array<Object>} sessions
 * @param {Object} normalizedData
 * @param {ShimRequest} req
 * @param {Array<Object>} debug
 * @returns {Promise<void>}
 */
async function maybeExportToHub(sessions, normalizedData, req, debug) {
  if (!familyFundMode) return;

  const packets = HubPacketFormatter.fromCookingPlan({
    domain: "cooking",
    sessions,
    plan: normalizedData,
    runtime: req.runtime || {},
    mode: req.intent, // typically a style intent
  });

  debug.push({
    stage: "hub.format",
    packetCount: Array.isArray(packets) ? packets.length : 0,
  });

  if (!packets || !packets.length) return;

  await FamilyFundConnector.sendBatch(packets);

  emit({
    type: "session.exported",
    ts: isoNow(),
    source: SHIM_SOURCE,
    data: {
      domain: "cooking",
      origin: "CookingStylesShim",
      sessionCount: sessions.length,
      packetCount: packets.length,
    },
  });
}

/**
 * Main Cooking Styles shim.
 *
 * Intents:
 *
 *  - "cooking.style.generate"
 *      Input: {
 *        cuisine: string,
 *        dish?: string,
 *        constraints?: {...},
 *        inventoryHints?: string[],
 *        shoppingContext?: {...},
 *        now?: string
 *      }
 *      Output (schema-owned): {
 *        stylePlan: {...},        // full style JSON
 *        variants: {...},
 *        events?: {...},
 *        sessionsDraft?: [...],
 *        summary: string
 *      }
 *
 *  - "cooking.style.approveDraft"
 *  - "cooking.style.startRun"
 *  - "cooking.style.markStepComplete"
 *  - "cooking.style.learnFeedback"
 *
 * All detailed logic (template loading, slider adjustments, texture matrix,
 * feedback heuristics, timers, automation events) now lives with the Reasoner
 * and/or downstream SessionRunner + prefs pipeline, not in this shim.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const debug = [];
  const warnings = [];

  try {
    // -------------------------------------------------
    // 1. Basic validation & normalization
    // -------------------------------------------------
    if (!req || typeof req !== "object") {
      return buildErrorResponse("invalid_request", "none", undefined, debug);
    }

    const domain = req.domain || "cooking";
    if (domain !== "cooking") {
      warnings.push({
        type: "domain.mismatch",
        expected: "cooking",
        got: domain,
      });
    }

    const intent = req.intent || "cooking.style.generate";
    const runtime = req.runtime || {};
    const input = req.input || {};

    debug.push({
      stage: "request.parsed",
      domain,
      intent,
      runtimeSummary: {
        userId: runtime.userId || null,
        requestId: runtime.requestId || null,
      },
    });

    // -------------------------------------------------
    // 2. Budget + gating
    // -------------------------------------------------
    const budgetCheck = enforceBudget(
      { domain, intent, input, runtime },
      debug
    );
    if (!budgetCheck.ok) {
      warnings.push({
        type: "budget.blocked",
        reason: budgetCheck.reason,
      });
      return buildErrorResponse(budgetCheck.reason, "none", undefined, debug);
    }

    const allowed = canInvokeReasoner({
      domain: "cooking",
      intent,
      runtime,
      input,
    });

    debug.push({
      stage: "gating.check",
      allowed,
    });

    if (!allowed) {
      return buildErrorResponse("gated_by_policy", "none", undefined, debug);
    }

    // -------------------------------------------------
    // 3. Context selection (Dexie-backed)
    //    Replaces direct CookingPrefsStore usage.
    // -------------------------------------------------
    const context = await selectCookingContext({
      intent,
      input,
      runtime,
      hint: "styles", // optional hint so selectors can load style-related prefs
    });

    debug.push({
      stage: "context.selected",
      keys: Object.keys(context || {}),
    });

    // -------------------------------------------------
    // 4. Guard evaluation (Sabbath, Quiet Hours, Weather, Inventory, Battery)
    // -------------------------------------------------
    const guardsResult = await evaluateGuards({
      domain: "cooking",
      intent,
      input,
      context,
      runtime,
    });

    debug.push({
      stage: "guards.evaluated",
      result: guardsResult,
    });

    if (guardsResult && guardsResult.blocked) {
      warnings.push({
        type: "guards.blocked",
        guards: guardsResult,
      });

      emit({
        type: "reasoner.skipped.guardsBlocked",
        ts: isoNow(),
        source: SHIM_SOURCE,
        data: {
          domain: "cooking",
          intent,
          guards: guardsResult,
        },
      });

      return buildShimResponse(
        true,
        "cooking.style.guarded.noop",
        {
          guards: guardsResult,
          note: "Cooking style action blocked by guard conditions.",
        },
        warnings,
        debug
      );
    }

    // -------------------------------------------------
    // 5. Mode resolution via modes/map.js
    // -------------------------------------------------
    const mode = resolveShimMode({ domain, intent, input, runtime }, context);

    debug.push({
      stage: "mode.resolved",
      mode,
    });

    // -------------------------------------------------
    // 6. Cache / memoization
    // -------------------------------------------------
    const memoKey = buildCookingMemoKey({
      mode,
      intent,
      input,
      context,
      runtime,
      scope: "styles",
    });

    const cached = await getMemo(memoKey);

    if (cached) {
      const isFresh = applyFreshnessRules({
        domain: "cooking",
        mode,
        cached,
        context,
        runtime,
      });

      debug.push({
        stage: "memo.checked",
        hit: true,
        fresh: isFresh,
      });

      if (isFresh) {
        emit({
          type: "reasoner.cachedHit",
          ts: isoNow(),
          source: SHIM_SOURCE,
          data: {
            domain: "cooking",
            mode,
            intent,
            memoKey,
          },
        });

        return buildShimResponse(true, mode, cached.data, warnings, debug);
      }

      warnings.push({
        type: "memo.stale",
        memoKey,
      });
    } else {
      debug.push({
        stage: "memo.checked",
        hit: false,
      });
    }

    emit({
      type: "reasoner.cachedMiss",
      ts: isoNow(),
      source: SHIM_SOURCE,
      data: {
        domain: "cooking",
        mode,
        intent,
        memoKey,
      },
    });

    // -------------------------------------------------
    // 7. Prompt construction
    //    We reuse the generic cooking prompt builder; it should
    //    branch internally on mode (style vs non-style).
    // -------------------------------------------------
    const systemPrompt = getSystemPrompt("cooking");
    const prompt = buildCookingPrompt({
      mode,
      intent,
      input,
      context,
    });

    debug.push({
      stage: "prompt.built",
      systemLength: systemPrompt ? systemPrompt.length : 0,
      userLength: prompt ? prompt.length : 0,
    });

    // -------------------------------------------------
    // 8. Reasoner invocation
    // -------------------------------------------------
    emit({
      type: "reasoner.invoked",
      ts: isoNow(),
      source: SHIM_SOURCE,
      data: {
        domain: "cooking",
        mode,
        intent,
        runtime,
      },
    });

    const rawOutput = await invokeReasoner({
      domain: "cooking",
      mode,
      intent,
      system: systemPrompt,
      prompt,
      context,
      runtime,
    });

    debug.push({
      stage: "reasoner.returned",
      typeofRaw: typeof rawOutput,
    });

    // -------------------------------------------------
    // 9. Schema validation + normalization
    // -------------------------------------------------
    const validation = await validateModeOutput({
      domain: "cooking",
      mode,
      payload: rawOutput,
    });

    if (!validation || !validation.ok) {
      const errors = (validation && validation.errors) || [];

      warnings.push({
        type: "schema.invalid",
        mode,
        errors,
      });

      emit({
        type: "reasoner.invalidSchema",
        ts: isoNow(),
        source: SHIM_SOURCE,
        data: {
          domain: "cooking",
          mode,
          intent,
          errors,
        },
      });

      return buildErrorResponse("invalid_schema", mode, undefined, debug);
    }

    emit({
      type: "reasoner.validated",
      ts: isoNow(),
      source: SHIM_SOURCE,
      data: {
        domain: "cooking",
        mode,
        intent,
      },
    });

    const normalized = validation.value || validation.data || rawOutput;

    debug.push({
      stage: "schema.normalized",
      keys: Object.keys(normalized || {}),
    });

    // -------------------------------------------------
    // 10. Confidence evaluation
    // -------------------------------------------------
    const confidence = evaluateConfidence({
      domain: "cooking",
      mode,
      intent,
      output: normalized,
      context,
      runtime,
    });

    debug.push({
      stage: "confidence.evaluated",
      confidence,
    });

    if (confidence && confidence.level === "low") {
      warnings.push({
        type: "confidence.low",
        confidence,
      });
    }

    // -------------------------------------------------
    // 11. Compose sessions (optional)
    // -------------------------------------------------
    const sessions = await maybeComposeSessions(
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // -------------------------------------------------
    // 12. Cache store
    // -------------------------------------------------
    await setMemo(memoKey, {
      data: normalized,
      mode,
      intent,
      storedAt: isoNow(),
      confidence,
    });

    debug.push({
      stage: "memo.stored",
      memoKey,
    });

    // -------------------------------------------------
    // 13. Optional Hub export (for familyFundMode)
    // -------------------------------------------------
    await maybeExportToHub(
      sessions,
      normalized,
      { domain, intent, input, runtime },
      debug
    );

    // -------------------------------------------------
    // 14. Final response
    // -------------------------------------------------
    const data = {
      style: normalized,
      sessions,
      meta: {
        confidence,
        guards: guardsResult,
      },
    };

    return buildShimResponse(true, mode, data, warnings, debug);
  } catch (err) {
    return buildErrorResponse("shim_runtime_error", "none", err, [
      ...debug,
      {
        stage: "error",
        message: err.message || String(err),
        name: err.name || "Error",
      },
    ]);
  }
}

/* ------------------------------------------------------------------
 * ✅ Deterministic checklist builder (UI helper)
 * ------------------------------------------------------------------ */

/**
 * Normalize checklist item into a consistent shape.
 * @param {any} item
 * @param {number} idx
 */
function normalizeChecklistItem(item, idx) {
  if (item == null) {
    return {
      id: `chk_${idx}`,
      label: "",
      ok: false,
      weight: 1,
      category: "general",
      tips: [],
    };
  }

  if (typeof item === "string") {
    return {
      id: `chk_${idx}`,
      label: item,
      ok: false,
      weight: 1,
      category: "general",
      tips: [],
    };
  }

  const label = String(item.label || item.title || item.name || "").trim();
  const ok =
    typeof item.ok === "boolean"
      ? item.ok
      : typeof item.done === "boolean"
      ? item.done
      : typeof item.checked === "boolean"
      ? item.checked
      : false;

  const weight =
    typeof item.weight === "number" && Number.isFinite(item.weight)
      ? item.weight
      : 1;

  const category = String(
    item.category || item.group || item.section || "general"
  ).trim();

  const tipsRaw = item.tips || item.hints || item.notes || [];
  const tips = Array.isArray(tipsRaw)
    ? tipsRaw.map((t) => String(t)).filter(Boolean)
    : tipsRaw
    ? [String(tipsRaw)]
    : [];

  return {
    id: String(item.id || item.key || `chk_${idx}`),
    label,
    ok,
    weight,
    category: category || "general",
    tips,
  };
}

/**
 * Attempt to extract checklist candidates from common plan shapes:
 * - payload.checklist (array)
 * - payload.style?.checklist / stylePlan?.checklist
 * - payload.style?.techniqueChecklist / techniqueChecklist
 * - payload.plan?.steps / stylePlan?.steps => infer "prep/heat/season/finish" checks
 */
function deriveChecklistCandidates(payload) {
  if (!payload || typeof payload !== "object") return [];

  const direct =
    payload.checklist ||
    payload.items ||
    payload.techniqueChecklist ||
    payload.style?.checklist ||
    payload.stylePlan?.checklist ||
    payload.style?.techniqueChecklist ||
    payload.stylePlan?.techniqueChecklist;

  if (Array.isArray(direct)) return direct;

  const steps =
    payload.steps ||
    payload.plan?.steps ||
    payload.style?.steps ||
    payload.stylePlan?.steps ||
    payload.style?.stylePlan?.steps ||
    payload.stylePlan?.stylePlan?.steps;

  if (!Array.isArray(steps) || !steps.length) return [];

  // Lightweight inference: look for common step keywords.
  const text = steps
    .map((s) => (typeof s === "string" ? s : s?.label || s?.title || s?.text))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const inferred = [];

  const add = (label, category, tips = []) => {
    inferred.push({
      label,
      category,
      tips,
    });
  };

  add("Prep station ready (tools, pans, mise en place)", "prep", [
    "Set out tools before heat goes on.",
    "Measure salt/acid/fat early for consistency.",
  ]);

  if (/\bpreheat\b|\bheat\b|\bhot\b|\bsear\b/.test(text)) {
    add("Heat management on track (preheat / steady temp)", "heat", [
      "Preheat thoroughly before searing.",
      "Adjust heat early to avoid overshooting.",
    ]);
  } else {
    add("Heat plan chosen (low/medium/high) and monitored", "heat", [
      "Decide target heat before starting.",
      "Check pan response and adjust.",
    ]);
  }

  if (/\bsalt\b|\bseason\b|\bspice\b|\bmarinad\b/.test(text)) {
    add("Seasoning balanced (salt + aromatics + spice)", "seasoning", [
      "Season in layers, not all at once.",
      "Taste for salt/acid balance near the end.",
    ]);
  } else {
    add("Flavor layers considered (salt/acid/fat/aromatics)", "seasoning", [
      "Add aromatics early; adjust salt/acid late.",
    ]);
  }

  if (/\brest\b|\bfinish\b|\bgarnish\b|\bserve\b/.test(text)) {
    add("Finish is clean (rest, final taste, garnish)", "finish", [
      "Rest proteins where applicable.",
      "Final taste: salt/acid/heat.",
    ]);
  } else {
    add("Final taste check (salt/acid/texture) before serving", "finish", [
      "One last taste saves the dish.",
    ]);
  }

  return inferred;
}

/**
 * buildChecklist (exported)
 * UI helper expected by TechniqueFeedbackBar.
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {{ ok: boolean, mode: string, data: { checklist: Array<Object>, score: number, categories: string[] } }}
 */
export function buildChecklist(payload = {}, runtime = {}) {
  const candidates = deriveChecklistCandidates(payload);
  const checklist = (Array.isArray(candidates) ? candidates : [])
    .map((it, idx) => normalizeChecklistItem(it, idx))
    .filter((it) => it.label);

  // Score is a simple weighted completion ratio if items contain ok=true.
  let wTotal = 0;
  let wOk = 0;
  for (const it of checklist) {
    const w = Number(it.weight || 1);
    wTotal += w;
    if (it.ok) wOk += w;
  }
  const score = wTotal > 0 ? Math.round((wOk / wTotal) * 100) : 0;

  const categories = Array.from(
    new Set(checklist.map((c) => c.category).filter(Boolean))
  );

  // Optional event for analytics/debug (safe/no-op if unused)
  emit({
    type: "cooking.style.checklist.built",
    ts: isoNow(),
    source: SHIM_SOURCE,
    data: {
      score,
      count: checklist.length,
      categories,
      runtime: {
        userId: runtime?.userId || null,
        requestId: runtime?.requestId || null,
      },
    },
  });

  return {
    ok: true,
    mode: "cooking.style.buildChecklist",
    data: { checklist, score, categories },
  };
}

/* ------------------------------------------------------------------
 * Thin intent helpers (shim-backed public API)
 * ------------------------------------------------------------------ */

/**
 * Internal helper to build a ShimRequest and call invokeShim.
 *
 * @param {string} intent
 * @param {Object} input
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
async function handleIntent(intent, input = {}, runtime = {}) {
  return invokeShim({
    domain: "cooking",
    intent,
    input,
    runtime,
  });
}

/**
 * Generate a cooking style plan (tradition-first, with variants).
 * Replaces generateStyle().
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function generateStyle(payload = {}, runtime = {}) {
  return handleIntent("cooking.style.generate", payload, runtime);
}

/**
 * Approve a generated style draft (orthodox/house/quick) so that
 * downstream modules can persist and schedule it.
 * Replaces approveStyleDraft().
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function approveStyleDraft(payload = {}, runtime = {}) {
  return handleIntent("cooking.style.approveDraft", payload, runtime);
}

/**
 * Start running a style plan (used when the user chooses to cook
 * a given variant now).
 * Replaces startPlanRun().
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function startPlanRun(payload = {}, runtime = {}) {
  return handleIntent("cooking.style.startRun", payload, runtime);
}

/**
 * Mark a specific step in the style plan complete.
 * Replaces markStepComplete().
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function markStepComplete(payload = {}, runtime = {}) {
  return handleIntent("cooking.style.markStepComplete", payload, runtime);
}

/**
 * Learn from user feedback and nudge the cooking style profile
 * and sliders accordingly.
 * Replaces learnFromFeedback().
 *
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function learnFromFeedback(payload = {}, runtime = {}) {
  return handleIntent("cooking.style.learnFeedback", payload, runtime);
}

/* ------------------------------------------------------------------
 * Backward-compatible command router (like old agent.handleCommand)
 * ------------------------------------------------------------------ */

/**
 * Backward-compatible router (if you previously used a command-based API).
 *
 * @param {string} command
 * @param {Object} payload
 * @param {Object} [runtime]
 * @returns {Promise<ShimResponse>}
 */
export async function handleCommand(command, payload = {}, runtime = {}) {
  switch (command) {
    case "generateStyle":
      return generateStyle(payload, runtime);
    case "approveStyleDraft":
      return approveStyleDraft(payload, runtime);
    case "startPlanRun":
      return startPlanRun(payload, runtime);
    case "markStepComplete":
      return markStepComplete(payload, runtime);
    case "learnFromFeedback":
      return learnFromFeedback(payload, runtime);
    // ✅ allow older UI to call "buildChecklist" through command router if needed
    case "buildChecklist":
      return buildChecklist(payload, runtime);
    default:
      return buildShimResponse(
        false,
        "cooking.style.unknownCommand",
        {
          reason: "unknown_command",
          command,
        },
        [
          {
            type: "unknown.command",
            command,
          },
        ],
        []
      );
  }
}

/* ------------------------------------------------------------------
 * Default export (for compatibility with old imports)
 * ------------------------------------------------------------------ */

const CookingStylesShim = {
  id: "CookingStylesAgent",
  invokeShim,
  handleCommand,
  generateStyle,
  approveStyleDraft,
  startPlanRun,
  markStepComplete,
  learnFromFeedback,
  buildChecklist, // ✅ added
};

export default CookingStylesShim;
