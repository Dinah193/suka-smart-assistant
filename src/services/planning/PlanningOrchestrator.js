/**
 * File: src/services/planning/PlanningOrchestrator.js
 * SSA Fixed-Layer Orchestration Glue
 *
 * End-to-end: ingest intent → resolve → build blueprint → emit events → return UI payload.
 *
 * Conventions:
 * - Deterministic planning resolution (resolvers are deterministic).
 * - Lexicon action constraints are respected: only the known action types are processed.
 * - Event bus: emits planning.resolved, blueprint.built, session.ready.
 * - No heavy deps. Callers can inject cache/DB as needed via context.
 */

import LayerAssetLoader from "../../layers/loaders/LayerAssetLoader.js";
import PlanningResolver from "../../layers/resolvers/PlanningResolver.js";
import CultureResolver from "../../layers/resolvers/CultureResolver.js";
import SeasonResolver from "../../layers/resolvers/SeasonResolver.js";
import LeanOptimizer from "../../layers/resolvers/LeanOptimizer.js";
import OverrideResolver from "../../layers/resolvers/OverrideResolver.js";

import BlueprintAdapter from "./BlueprintAdapter.js";
import PlanningUIModel from "./PlanningUIModel.js";

// SSA eventBus helper: tolerate different export shapes.
// Expected typical locations: src/services/events/eventBus.js
import * as EventBusModule from "../events/eventBus.js";

function getEmitter() {
  const m = EventBusModule || {};
  const bus = m.eventBus || m.default || null;

  // Accept either bus.emit(name, payload) or exported emit(name, payload)
  const emitFn =
    (bus && typeof bus.emit === "function" && bus.emit.bind(bus)) ||
    (typeof m.emit === "function" && m.emit) ||
    (typeof bus === "function" && bus) ||
    null;

  if (!emitFn) {
    // Production-safe fallback (does not crash UI). Events become no-ops.
    return function emitNoop() {};
  }
  return emitFn;
}

const emit = getEmitter();

function nowIso() {
  return new Date().toISOString();
}

function safeArr(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function normalizeDomain(domain) {
  const d = String(domain || "")
    .trim()
    .toLowerCase();
  if (["meals", "storehouse", "homestead"].includes(d)) return d;
  return "meals";
}

/**
 * Extract intentCandidates from lexicon hits with constrained actions.
 * LayerAssetLoader is expected to build phrase→match index and return match objects.
 * If your loader emits a different shape, adapt in one place: normalizeLexiconHits().
 */
function normalizeLexiconHits(hits = []) {
  const out = [];
  for (const h of safeArr(hits)) {
    const confidence = Number.isFinite(h?.confidence) ? h.confidence : 0.6;
    const domain = h?.domain ? String(h.domain) : h?.lexiconName || "unknown";
    const patternId = h?.patternId || h?.methodId || h?.id || null;

    out.push({
      domain,
      patternId,
      methodId: h?.methodId || null,
      tags: safeArr(h?.tags),
      tokens: safeArr(h?.tokens),
      confidence,
      actions: safeArr(h?.actions),
      reason: h?.reason || null,
    });
  }
  return out;
}

function applyLexiconActionsToContext(candidates, context) {
  const ctx = { ...context };
  const hintTags = new Set(safeArr(ctx.hintTags).map(String));
  const notes = safeArr(ctx.notes);
  const warnings = safeArr(ctx.warnings);

  // Only allowed action types:
  const ALLOWED = new Set([
    "boostMethodKey",
    "downrankMethodKey",
    "blockMethodKey",
    "addNote",
    "addWarning",
    "emitHintTag",
  ]);

  // We treat “methodKey” as patternId/methodId identifiers; PlanningResolver can interpret patternId directly.
  const boosts = {};
  const downranks = {};
  const blocks = new Set();

  for (const c of safeArr(candidates)) {
    for (const a of safeArr(c.actions)) {
      const type = String(a?.type || "");
      if (!ALLOWED.has(type)) continue;

      if (type === "emitHintTag" && a?.emitHintTag) {
        hintTags.add(String(a.emitHintTag));
      }
      if (type === "addNote" && a?.note) notes.push(String(a.note));
      if (type === "addWarning" && a?.warning) warnings.push(String(a.warning));

      const key = a?.methodKey
        ? String(a.methodKey)
        : c.methodId
        ? String(c.methodId)
        : null;
      const amt = Number.isFinite(a?.amount) ? a.amount : 0.1;

      if (type === "boostMethodKey" && key)
        boosts[key] = (boosts[key] || 0) + amt;
      if (type === "downrankMethodKey" && key)
        downranks[key] = (downranks[key] || 0) + amt;
      if (type === "blockMethodKey" && key) blocks.add(key);
    }
  }

  ctx.hintTags = [...hintTags];
  ctx.notes = notes;
  ctx.warnings = warnings;
  ctx.lexiconAdjustments = { boosts, downranks, blocks: [...blocks] };
  return ctx;
}

function applyLexiconAdjustmentsToRanked(ranked = [], lexAdj = {}) {
  const boosts = lexAdj?.boosts || {};
  const downranks = lexAdj?.downranks || {};
  const blocks = new Set(safeArr(lexAdj?.blocks).map(String));

  return safeArr(ranked)
    .filter((r) => !blocks.has(String(r.id)))
    .map((r) => {
      const id = String(r.id);
      const b = Number(boosts[id] || 0);
      const d = Number(downranks[id] || 0);
      const score = Number(r.score || 0) + b - d;
      const reasons = safeArr(r.reasons);
      if (b) reasons.push(`Lexicon boost applied (+${b.toFixed(2)}).`);
      if (d) reasons.push(`Lexicon downrank applied (-${d.toFixed(2)}).`);
      return { ...r, score, reasons };
    })
    .sort(
      (a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))
    );
}

/**
 * PlanningOrchestrator
 * - buildPlan({ domain, userInput, context })
 */
export class PlanningOrchestrator {
  constructor(opts = {}) {
    this.loader =
      opts.loader ||
      new LayerAssetLoader({ devHotReload: !!opts.devHotReload });
    this.planningResolver = opts.planningResolver || new PlanningResolver();
    this.seasonResolver =
      opts.seasonResolver || new SeasonResolver({ catalogs: null });
    this.leanOptimizer = opts.leanOptimizer || new LeanOptimizer();
    this.overrideResolver = opts.overrideResolver || new OverrideResolver();

    this.blueprintAdapter = opts.blueprintAdapter || new BlueprintAdapter();
    this.uiModel = opts.uiModel || new PlanningUIModel();

    // CultureResolver needs overlay lookup; use loader helper.
    this.cultureResolver =
      opts.cultureResolver ||
      new CultureResolver({
        getWorkflowOverlay: (id) =>
          this.loader.getWorkflowOverlay?.(id) || null,
      });
  }

  /**
   * @param {{ domain?: string, userInput: string, context?: object }} args
   */
  async buildPlan(args = {}) {
    const domain = normalizeDomain(args.domain);
    const userInput = String(args.userInput || "");
    const contextIn = args.context || {};

    // 1) Ensure assets loaded (catalogs + lexicons + schemas)
    const assets = await this.loader.ensureLoaded();

    // 2) Lexicon parse (routing + domain lexicons)
    const lexiconNames = [
      "planning",
      "cultural",
      "lean",
      "meals",
      "storehouse",
      "homestead",
      // existing lexicons in your SSA can also be included by registry
    ];

    const lexHitsRaw = [];
    for (const name of lexiconNames) {
      try {
        const hits =
          this.loader.matchLexicon?.(name, userInput, { domain }) || [];
        for (const h of safeArr(hits))
          lexHitsRaw.push({ ...h, lexiconName: name });
      } catch (e) {
        // Do not hard-fail. Loader will surface in layerAssets tests.
      }
    }
    const intentCandidates = normalizeLexiconHits(lexHitsRaw);

    // 3) Apply constrained lexicon actions → context adjustments
    const context = applyLexiconActionsToContext(intentCandidates, contextIn);

    // 4) Seasonal resolution (works with missing location/zone)
    const seasonal = this.seasonResolver.resolve(
      context.dateISO || new Date(),
      context.zone || null,
      {
        hemisphere: context.hemisphere || "north",
        seasonalMode: context.seasonalMode || "default",
        hebrew: context.hebrew || {},
        feastCounting: context.feastCounting || {},
      },
      {
        seasons: assets?.seasonal?.seasons,
        zones: assets?.seasonal?.zones,
        feastWindows: assets?.seasonal?.feastWindows,
      }
    );

    // 5) Planning resolution (deterministic)
    const planningContext = {
      ...context,
      seasonTags: seasonal.tags,
      feast: {
        active: seasonal.feastTags?.length > 0,
        tags: seasonal.feastTags,
      },
    };

    const resolved = this.planningResolver.resolve(
      intentCandidates,
      planningContext
    );
    let ranked = resolved.ranked;

    // 6) Apply lexicon adjustments (boost/downrank/block) to ranked list
    ranked = applyLexiconAdjustmentsToRanked(
      ranked,
      context.lexiconAdjustments
    );

    // 7) Apply household overrides (hard blocks, must-haves, params)
    const patternMetaLookup = (patternId) =>
      this.loader.getPatternMeta?.(patternId) || null;
    const overrideRes = this.overrideResolver.apply(
      ranked,
      context.overrides || {},
      patternMetaLookup
    );
    const rankedAfterOverrides = overrideRes.selected;

    // 8) Choose top patterns (finite) + build UI models
    const selectedTop = rankedAfterOverrides.slice(0, context.maxPatterns || 3);

    // 9) Cultural overlay (optional + blend mode)
    const culturePrefs = context.culturePrefs || { enabled: false };
    const cultureApplied = this.cultureResolver.apply(
      selectedTop,
      culturePrefs
    );

    // 10) Lean optimizer recommendations (optional)
    const leanOut = this.leanOptimizer.optimize(
      context.logs || [],
      context.complaints || [],
      context.kpiSnapshot || {},
      { optedIn: !!context.leanOptIn, allowAutoApply: !!context.leanAutoApply }
    );

    // 11) Build blueprints/sessions from patterns (may be multi-session)
    const patterns = cultureApplied.selected
      .map((p) => this.loader.getPattern?.(p.id))
      .filter(Boolean);

    const blueprintBundle = this.blueprintAdapter.fromPatterns({
      domain,
      patterns,
      ranked: cultureApplied.selected,
      seasonal,
      culture: cultureApplied.blueprintSettings,
      context: planningContext,
      lean: leanOut,
    });

    // 12) UI model for interactive page/cards
    const ui = this.uiModel.build({
      domain,
      patterns,
      ranked: cultureApplied.selected,
      seasonal,
      culture: cultureApplied.blueprintSettings,
      constraints: uniqTags([
        ...seasonal.constraints,
        ...safeArr(planningContext.hintTags),
      ]),
      context: planningContext,
      lean: leanOut,
    });

    const payload = {
      id: `plan_${Date.now()}`,
      ts: nowIso(),
      domain,
      input: { userInput },
      intentCandidates,
      seasonal,
      resolution: {
        ranked: cultureApplied.selected,
        blocked: overrideRes.blocked,
        why: buildWhy(cultureApplied.selected),
      },
      blueprints: blueprintBundle,
      ui,
      lean: leanOut,
      notes: planningContext.notes || [],
      warnings: planningContext.warnings || [],
    };

    // 13) Emit events in SSA style
    emit("planning.resolved", { domain, payload });
    emit("blueprint.built", {
      domain,
      blueprints: blueprintBundle,
      payloadId: payload.id,
    });
    emit("session.ready", {
      domain,
      sessions: blueprintBundle.sessions,
      payloadId: payload.id,
    });

    return payload;
  }
}

function uniqTags(tags = []) {
  const out = [];
  const set = new Set();
  for (const t of safeArr(tags)) {
    const s = String(t);
    if (!set.has(s)) {
      set.add(s);
      out.push(s);
    }
  }
  return out;
}

function buildWhy(ranked = []) {
  return safeArr(ranked).map((r) => ({
    patternId: String(r.id),
    score: Number(r.score || 0),
    reasons: safeArr(r.reasons),
  }));
}

export default PlanningOrchestrator;
