// C:\Users\larho\suka-smart-assistant\src\services\homesteadPlanner\index.js
/* eslint-disable no-console */
/**
 * SSA • Homestead Planner Service (Facade / Orchestrator)
 * -----------------------------------------------------------------------------
 * Provides a stable, browser-safe API for all Homestead Planner pages.
 *
 * What this file does:
 *  - Loads & validates catalogs (components, preservation methods, crops, animals)
 *  - Resolves cuisine rotation + household preferences into normalized rules
 *  - Builds component demand → provisioning targets → feasibility → gaps/actions
 *  - Builds garden + animal targets derived from provisioning
 *  - Plans a dated timeline and builds UI-friendly explanations
 *
 * Design goals:
 *  - Deterministic, explainable planning (no AI required)
 *  - Safe in Vite/browser builds (no Node imports)
 *  - Loose coupling: pages call this facade; internal engines can evolve
 *
 * Usage (pages):
 *  const out = await HomesteadPlanner.runPlan({ householdId, startISO, horizonDays, selections, options });
 *  out.planSummary, out.timeline, out.explanations, etc.
 *
 * -----------------------------------------------------------------------------
 * Inputs
 * -----------------------------------------------------------------------------
 * runPlan({
 *   householdId,
 *   startISO,
 *   horizonDays,
 *   timezone,
 *   selections: {
 *     cuisines?: { selected: [{id,name,weight?}], rotation?: {...} } | { selectedIds: [...] },
 *     preferences?: { ... }, // same shapes used by PreferenceResolver
 *     inventorySnapshot?: { ... }, // optional on-hand snapshot
 *   },
 *   catalogs?: { bundle? }, // optional: preloaded catalog bundle
 *   options?: { ... },      // optional: passed to engines (scoped per engine)
 * })
 *
 * -----------------------------------------------------------------------------
 * Output
 * -----------------------------------------------------------------------------
 * {
 *   meta,
 *   catalogBundle,
 *   selectionsNormalized,
 *   outputs: {
 *     preferencesResolved,
 *     cuisinesResolved,
 *     demandPlan,
 *     targetsOutput,
 *     conversionOutput,
 *     feasibilityReport,
 *     gapActionsOutput,
 *     gardenTargetsOutput,
 *     animalTargetsOutput,
 *     timelineOutput,
 *   },
 *   planSummary,
 *   timeline,
 *   next,
 *   issues,
 *   explanations: {
 *     plan,
 *     byId: { [id]: Explanation },
 *     blocks: { plan: DisplayBlock[], byId: { [id]: DisplayBlock[] } }
 *   },
 * }
 */

import { CatalogLoader } from "@/services/farmToTable/CatalogLoader";
import { CatalogValidator } from "@/services/farmToTable/CatalogValidator";
import { PreferenceResolver } from "@/services/farmToTable/PreferenceResolver";
import { CuisineResolver } from "@/services/farmToTable/CuisineResolver";
import { ComponentDemandBuilder } from "@/services/farmToTable/ComponentDemandBuilder";
import { ProvisioningTargetEngine } from "@/services/farmToTable/ProvisioningTargetEngine";
import { ConversionEngine } from "@/services/farmToTable/ConversionEngine";
import { FeasibilityChecker } from "@/services/farmToTable/FeasibilityChecker";
import { GapActionRecommender } from "@/services/farmToTable/GapActionRecommender";
import { GardenTargetBuilder } from "@/services/farmToTable/GardenTargetBuilder";
import { AnimalTargetBuilder } from "@/services/farmToTable/AnimalTargetBuilder";
import { planTimeline as planTimelineInternal } from "@/services/farmToTable/TimelinePlanner";
import { ExplanationBuilder } from "@/services/farmToTable/ExplanationBuilder";

const SOURCE = "services/homesteadPlanner/index";

const DEFAULTS = {
  timezone: "America/Chicago",
  horizonDays: 28,
  validateCatalogs: true,
  buildExplanations: true,

  // How much we build for UI convenience
  includeByIdExplanations: true,
  includeDisplayBlocks: true,

  // Engine option defaults (passed through)
  engineOptions: {
    preferenceResolver: {},
    cuisineResolver: {},
    demandBuilder: {},
    targetEngine: {},
    conversionEngine: {},
    feasibilityChecker: {},
    gapActionRecommender: {},
    gardenTargetBuilder: {},
    animalTargetBuilder: {},
    timelinePlanner: {},
    explanationBuilder: {},
    catalogLoader: {},
    catalogValidator: {},
  },
};

export const HomesteadPlanner = {
  runPlan,
  loadCatalogBundle,
  validateCatalogBundle,
  normalizeSelections,

  // utility exports used by pages
  summarizePlan,
  buildExplanations,
};

export default HomesteadPlanner;

/* -----------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

export async function runPlan(input = {}) {
  const startedAtISO = new Date().toISOString();
  const opts = mergeOptions(input.options);

  const householdId = safeStr(input.householdId || "primary");
  const startISO = input.startISO || new Date().toISOString();
  const horizonDays = Number.isFinite(input.horizonDays)
    ? input.horizonDays
    : DEFAULTS.horizonDays;
  const timezone = safeStr(input.timezone || DEFAULTS.timezone);

  // 1) Catalogs
  const catalogBundle = input.catalogs?.bundle
    ? input.catalogs.bundle
    : await loadCatalogBundle({
        householdId,
        startISO,
        timezone,
        options: opts.engineOptions.catalogLoader,
      });

  // Optional validation
  if (opts.validateCatalogs) {
    validateCatalogBundle({
      bundle: catalogBundle,
      options: opts.engineOptions.catalogValidator,
    });
  }

  // 2) Normalize selections (cuisines, prefs, inventory snapshot)
  const selectionsNormalized = normalizeSelections(input.selections || {}, {
    householdId,
    startISO,
    horizonDays,
    timezone,
  });

  // 3) Resolve preferences + cuisines
  const preferencesResolved = safeResolvePreferences(
    selectionsNormalized,
    catalogBundle,
    opts
  );
  const cuisinesResolved = safeResolveCuisines(
    selectionsNormalized,
    catalogBundle,
    opts
  );

  // 4) Demand plan (what components are needed for this horizon)
  const demandPlan = safeBuildDemandPlan({
    householdId,
    startISO,
    horizonDays,
    timezone,
    catalogBundle,
    preferencesResolved,
    cuisinesResolved,
    inventorySnapshot: selectionsNormalized.inventorySnapshot,
    options: opts.engineOptions.demandBuilder,
  });

  // 5) Provisioning targets derived from demand
  const targetsOutput = safeBuildTargets({
    householdId,
    startISO,
    horizonDays,
    timezone,
    catalogBundle,
    demandPlan,
    preferencesResolved,
    cuisinesResolved,
    inventorySnapshot: selectionsNormalized.inventorySnapshot,
    options: opts.engineOptions.targetEngine,
  });

  // 6) Conversions (e.g., yields, processing, unit conversion)
  const conversionOutput = safeConvert({
    householdId,
    startISO,
    horizonDays,
    timezone,
    catalogBundle,
    targetsOutput,
    options: opts.engineOptions.conversionEngine,
  });

  // 7) Feasibility (capacity / season / equipment checks)
  const feasibilityReport = safeFeasibility({
    householdId,
    startISO,
    horizonDays,
    timezone,
    catalogBundle,
    targetsOutput,
    conversionOutput,
    options: opts.engineOptions.feasibilityChecker,
  });

  // 8) Gap actions (buy/plant/breed/process/substitute/schedule)
  const gapActionsOutput = safeRecommendActions({
    householdId,
    startISO,
    horizonDays,
    timezone,
    catalogBundle,
    demandPlan,
    targetsOutput,
    conversionOutput,
    feasibilityReport,
    preferencesResolved,
    cuisinesResolved,
    options: opts.engineOptions.gapActionRecommender,
  });

  // 9) Garden targets derived from provisioning
  const gardenTargetsOutput = safeGardenTargets({
    householdId,
    startISO,
    horizonDays,
    timezone,
    catalogBundle,
    targetsOutput,
    conversionOutput,
    gapActionsOutput,
    options: opts.engineOptions.gardenTargetBuilder,
  });

  // 10) Animal targets derived from provisioning
  const animalTargetsOutput = safeAnimalTargets({
    householdId,
    startISO,
    horizonDays,
    timezone,
    catalogBundle,
    targetsOutput,
    conversionOutput,
    gapActionsOutput,
    options: opts.engineOptions.animalTargetBuilder,
  });

  // 11) Timeline
  const timelineOutput = safeTimeline({
    householdId,
    startISO,
    horizonDays,
    timezone,
    catalogBundle,
    targetsOutput,
    gardenTargetsOutput,
    animalTargetsOutput,
    gapActionsOutput,
    feasibilityReport,
    options: opts.engineOptions.timelinePlanner,
  });

  // 12) Unified issues
  const issues = collectIssues([
    demandPlan,
    targetsOutput,
    conversionOutput,
    feasibilityReport,
    gapActionsOutput,
    gardenTargetsOutput,
    animalTargetsOutput,
    timelineOutput,
  ]);

  // 13) Plan summary
  const planSummary = summarizePlan({
    householdId,
    startISO,
    horizonDays,
    timezone,
    selectionsNormalized,
    outputs: {
      preferencesResolved,
      cuisinesResolved,
      demandPlan,
      targetsOutput,
      conversionOutput,
      feasibilityReport,
      gapActionsOutput,
      gardenTargetsOutput,
      animalTargetsOutput,
      timelineOutput,
    },
    issues,
  });

  // 14) Explanations (optional)
  const explanations = opts.buildExplanations
    ? buildExplanations({
        householdId,
        startISO,
        horizonDays,
        timezone,
        selectionsNormalized,
        outputs: {
          preferencesResolved,
          cuisinesResolved,
          demandPlan,
          targetsOutput,
          conversionOutput,
          feasibilityReport,
          gapActionsOutput,
          gardenTargetsOutput,
          animalTargetsOutput,
          timelineOutput,
        },
        options: opts.engineOptions.explanationBuilder,
        includeById: opts.includeByIdExplanations,
        includeBlocks: opts.includeDisplayBlocks,
      })
    : null;

  const endedAtISO = new Date().toISOString();

  return {
    meta: {
      source: SOURCE,
      householdId,
      startISO,
      horizonDays,
      timezone,
      startedAtISO,
      endedAtISO,
      durationMs: Math.max(
        0,
        new Date(endedAtISO).getTime() - new Date(startedAtISO).getTime()
      ),
      version: 1,
    },
    catalogBundle,
    selectionsNormalized,
    outputs: {
      preferencesResolved,
      cuisinesResolved,
      demandPlan,
      targetsOutput,
      conversionOutput,
      feasibilityReport,
      gapActionsOutput,
      gardenTargetsOutput,
      animalTargetsOutput,
      timelineOutput,
    },
    planSummary,
    timeline: timelineOutput?.timeline || {
      startISO,
      endISO: addDaysISO(startISO, horizonDays),
      items: [],
      sessions: [],
      milestones: [],
    },
    next: timelineOutput?.next || { dueISO: null, items: [], sessions: [] },
    issues,
    explanations,
  };
}

export async function loadCatalogBundle({
  householdId = "primary",
  startISO,
  timezone,
  options,
} = {}) {
  const opts = options || {};
  try {
    const bundle = await CatalogLoader.loadBundle({
      householdId,
      atISO: startISO,
      timezone,
      options: opts,
    });
    return bundle;
  } catch (e) {
    console.warn(
      `[${SOURCE}] CatalogLoader failed; returning minimal empty bundle.`,
      e
    );
    return {
      meta: {
        source: "CatalogLoader",
        loadedAtISO: new Date().toISOString(),
        ok: false,
        error: safeStr(e?.message || e),
      },
      components: [],
      preservation: { methods: [], recipes: [] },
      garden: { crops: [], varieties: [], calendars: [] },
      animals: { species: [], breeds: [], calendars: [] },
    };
  }
}

export function validateCatalogBundle({ bundle, options } = {}) {
  const opts = options || {};
  try {
    return CatalogValidator.validateBundle(bundle, opts);
  } catch (e) {
    console.warn(
      `[${SOURCE}] CatalogValidator threw; continuing with warnings.`,
      e
    );
    return {
      ok: false,
      errors: [{ message: safeStr(e?.message || e) }],
      warnings: [],
    };
  }
}

/**
 * Normalize selections passed from UI into stable shapes the engines can accept.
 */
export function normalizeSelections(selections = {}, ctx = {}) {
  const out = {
    cuisines: normalizeCuisinesSelection(selections.cuisines),
    preferences: selections.preferences || selections.prefs || {},
    inventorySnapshot:
      selections.inventorySnapshot || selections.inventory || null,
    household: selections.household ||
      selections.profile || { householdId: ctx.householdId || "primary" },
  };

  // Back-compat convenience fields:
  if (!out.cuisines.selected && Array.isArray(selections.selectedCuisineIds)) {
    out.cuisines = normalizeCuisinesSelection({
      selectedIds: selections.selectedCuisineIds,
    });
  }

  return out;
}

/* -----------------------------------------------------------------------------
 * Explanations (roll-up + byId)
 * --------------------------------------------------------------------------- */

export function buildExplanations({
  householdId,
  startISO,
  horizonDays,
  timezone,
  selectionsNormalized,
  outputs,
  options,
  includeById = true,
  includeBlocks = true,
} = {}) {
  const opts = options || {};
  const byId = {};
  const blocksById = {};

  const plan = ExplanationBuilder.buildPlanExplanation({
    planName: "Homestead Planner",
    startISO,
    horizonDays,
    selections: {
      cuisines: selectionsNormalized?.cuisines || null,
      prefs: selectionsNormalized?.preferences || null,
      household: selectionsNormalized?.household || null,
    },
    outputs: {
      targetsOutput: outputs.targetsOutput,
      demandPlan: outputs.demandPlan,
      conversionOutput: outputs.conversionOutput,
      feasibilityReport: outputs.feasibilityReport,
      gapActionsOutput: outputs.gapActionsOutput,
      gardenTargetsOutput: outputs.gardenTargetsOutput,
      animalTargetsOutput: outputs.animalTargetsOutput,
      timelineOutput: outputs.timelineOutput,
    },
    options: opts,
  });

  const planBlocks = includeBlocks
    ? ExplanationBuilder.toDisplayBlocks(plan)
    : null;

  if (includeById) {
    // Build by-id explanations for commonly displayed entities in homestead pages
    const gaps = outputs.demandPlan?.gaps || outputs.targetsOutput?.gaps || [];
    const prov =
      outputs.targetsOutput?.provisioning ||
      outputs.targetsOutput?.targets ||
      [];
    const actions = outputs.gapActionsOutput?.actions || [];
    const garden = outputs.gardenTargetsOutput?.targets || [];
    const animals = outputs.animalTargetsOutput?.targets || [];
    const timelineItems = outputs.timelineOutput?.timeline?.items || [];
    const sessions = outputs.timelineOutput?.timeline?.sessions || [];

    const ctx = { startISO, horizonDays, outputs: outputsToCtx(outputs) };

    // Gaps
    for (const g of gaps) {
      const ex = ExplanationBuilder.buildItemExplanation({
        kind: "gap",
        item: g,
        context: ctx,
        options: opts,
      });
      if (ex?.id) {
        byId[ex.id] = ex;
        if (includeBlocks)
          blocksById[ex.id] = ExplanationBuilder.toDisplayBlocks(ex);
      }
    }

    // Targets/provisioning
    for (const t of prov) {
      const ex = ExplanationBuilder.buildItemExplanation({
        kind: "target",
        item: t,
        context: ctx,
        options: opts,
      });
      if (ex?.id) {
        byId[ex.id] = ex;
        if (includeBlocks)
          blocksById[ex.id] = ExplanationBuilder.toDisplayBlocks(ex);
      }
    }

    // Actions
    for (const a of actions) {
      const ex = ExplanationBuilder.buildItemExplanation({
        kind: "action",
        item: a,
        context: ctx,
        options: opts,
      });
      if (ex?.id) {
        byId[ex.id] = ex;
        if (includeBlocks)
          blocksById[ex.id] = ExplanationBuilder.toDisplayBlocks(ex);
      }
    }

    // Garden targets
    for (const gt of garden) {
      const ex = ExplanationBuilder.buildItemExplanation({
        kind: "gardenTarget",
        item: gt,
        context: ctx,
        options: opts,
      });
      if (ex?.id) {
        byId[ex.id] = ex;
        if (includeBlocks)
          blocksById[ex.id] = ExplanationBuilder.toDisplayBlocks(ex);
      }
    }

    // Animal targets
    for (const at of animals) {
      const ex = ExplanationBuilder.buildItemExplanation({
        kind: "animalTarget",
        item: at,
        context: ctx,
        options: opts,
      });
      if (ex?.id) {
        byId[ex.id] = ex;
        if (includeBlocks)
          blocksById[ex.id] = ExplanationBuilder.toDisplayBlocks(ex);
      }
    }

    // Timeline items
    for (const ti of timelineItems) {
      const ex = ExplanationBuilder.buildItemExplanation({
        kind: "timelineItem",
        item: ti,
        context: ctx,
        options: opts,
      });
      if (ex?.id) {
        byId[ex.id] = ex;
        if (includeBlocks)
          blocksById[ex.id] = ExplanationBuilder.toDisplayBlocks(ex);
      }
    }

    // Sessions
    for (const s of sessions) {
      const ex = ExplanationBuilder.buildItemExplanation({
        kind: "session",
        item: s,
        context: ctx,
        options: opts,
      });
      if (ex?.id) {
        byId[ex.id] = ex;
        if (includeBlocks)
          blocksById[ex.id] = ExplanationBuilder.toDisplayBlocks(ex);
      }
    }
  }

  return {
    plan,
    byId: includeById ? byId : null,
    blocks: includeBlocks
      ? { plan: planBlocks, byId: includeById ? blocksById : null }
      : null,
  };
}

/* -----------------------------------------------------------------------------
 * Summary helpers
 * --------------------------------------------------------------------------- */

export function summarizePlan({
  householdId,
  startISO,
  horizonDays,
  timezone,
  selectionsNormalized,
  outputs,
  issues,
}) {
  const provCount = (
    outputs.targetsOutput?.provisioning ||
    outputs.targetsOutput?.targets ||
    []
  ).length;
  const gapCount = (
    outputs.demandPlan?.gaps ||
    outputs.targetsOutput?.gaps ||
    []
  ).length;
  const actionCount = (outputs.gapActionsOutput?.actions || []).length;
  const gardenCount = (outputs.gardenTargetsOutput?.targets || []).length;
  const animalCount = (outputs.animalTargetsOutput?.targets || []).length;

  const feas = outputs.feasibilityReport || null;
  const feasibilityStatus = safeStr(feas?.feasibilityStatus || "unknown");
  const readinessScore = Number.isFinite(feas?.readinessScore)
    ? Math.round(feas.readinessScore)
    : null;

  const nextDueISO = outputs.timelineOutput?.next?.dueISO || null;

  return {
    householdId,
    startISO,
    endISO: addDaysISO(startISO, horizonDays),
    horizonDays,
    timezone,
    cuisinesSelected: selectionsNormalized?.cuisines?.selected?.length || 0,
    provCount,
    gapCount,
    actionCount,
    gardenCount,
    animalCount,
    feasibilityStatus,
    readinessScore,
    blockers: (issues?.blockers || []).length,
    risks: (issues?.risks || []).length,
    nextDueISO,
    nextDueLabel: nextDueISO ? formatDateShort(nextDueISO) : null,
    // Minimal UI-friendly headline
    headline:
      readinessScore != null
        ? `Readiness ${readinessScore}/100 • ${gapCount} gaps • next due ${
            nextDueISO ? formatDateShort(nextDueISO) : "soon"
          }`
        : `${gapCount} gaps • ${actionCount} actions • next due ${
            nextDueISO ? formatDateShort(nextDueISO) : "soon"
          }`,
  };
}

/* -----------------------------------------------------------------------------
 * Internal safe wrappers (never throw)
 * --------------------------------------------------------------------------- */

function safeResolvePreferences(selectionsNormalized, catalogBundle, opts) {
  try {
    return PreferenceResolver.resolve({
      selections: selectionsNormalized.preferences || {},
      household: selectionsNormalized.household || {},
      catalogBundle,
      options: opts.engineOptions.preferenceResolver,
    });
  } catch (e) {
    console.warn(`[${SOURCE}] PreferenceResolver failed; using defaults.`, e);
    return {
      ok: false,
      rules: {},
      summary: "Defaults",
      issues: {
        blockers: [],
        risks: [{ message: safeStr(e?.message || e), severity: 2 }],
      },
      trace: {
        notes: ["PreferenceResolver failed; default rules used."],
        rulesApplied: [],
      },
    };
  }
}

function safeResolveCuisines(selectionsNormalized, catalogBundle, opts) {
  try {
    return CuisineResolver.resolve({
      selections: selectionsNormalized.cuisines || {},
      catalogBundle,
      options: opts.engineOptions.cuisineResolver,
    });
  } catch (e) {
    console.warn(
      `[${SOURCE}] CuisineResolver failed; using empty selection.`,
      e
    );
    return {
      ok: false,
      selected: [],
      rotation: null,
      issues: {
        blockers: [],
        risks: [{ message: safeStr(e?.message || e), severity: 2 }],
      },
      trace: {
        notes: ["CuisineResolver failed; no cuisines applied."],
        rulesApplied: [],
      },
    };
  }
}

function safeBuildDemandPlan(args) {
  try {
    return ComponentDemandBuilder.buildDemandPlan(args);
  } catch (e) {
    console.warn(
      `[${SOURCE}] ComponentDemandBuilder failed; using empty demand plan.`,
      e
    );
    return {
      meta: {
        source: "ComponentDemandBuilder",
        ok: false,
        error: safeStr(e?.message || e),
      },
      demands: [],
      gaps: [],
      issues: {
        blockers: [
          {
            message: "Demand plan failed",
            detail: safeStr(e?.message || e),
            severity: 5,
          },
        ],
        risks: [],
      },
      trace: {
        notes: ["Demand plan failed; downstream outputs will be limited."],
        rulesApplied: [],
      },
    };
  }
}

function safeBuildTargets(args) {
  try {
    return ProvisioningTargetEngine.buildTargets(args);
  } catch (e) {
    console.warn(
      `[${SOURCE}] ProvisioningTargetEngine failed; using empty targets.`,
      e
    );
    return {
      meta: {
        source: "ProvisioningTargetEngine",
        ok: false,
        error: safeStr(e?.message || e),
      },
      provisioning: [],
      targets: [],
      gaps: [],
      issues: {
        blockers: [
          {
            message: "Targets failed",
            detail: safeStr(e?.message || e),
            severity: 5,
          },
        ],
        risks: [],
      },
      trace: {
        notes: ["Target engine failed; no targets produced."],
        rulesApplied: [],
      },
    };
  }
}

function safeConvert(args) {
  try {
    return ConversionEngine.convert(args);
  } catch (e) {
    console.warn(`[${SOURCE}] ConversionEngine failed; passing through.`, e);
    return {
      meta: {
        source: "ConversionEngine",
        ok: false,
        error: safeStr(e?.message || e),
      },
      conversions: [],
      issues: {
        blockers: [],
        risks: [
          {
            message: "Conversion failed; quantities may be unnormalized.",
            detail: safeStr(e?.message || e),
            severity: 3,
          },
        ],
      },
      trace: {
        notes: ["Conversion engine failed; using raw units."],
        rulesApplied: [],
      },
    };
  }
}

function safeFeasibility(args) {
  try {
    return FeasibilityChecker.check(args);
  } catch (e) {
    console.warn(
      `[${SOURCE}] FeasibilityChecker failed; defaulting to unknown.`,
      e
    );
    return {
      meta: {
        source: "FeasibilityChecker",
        ok: false,
        error: safeStr(e?.message || e),
      },
      feasibilityStatus: "unknown",
      readinessScore: 0,
      issues: {
        blockers: [],
        risks: [
          {
            message: "Feasibility check failed.",
            detail: safeStr(e?.message || e),
            severity: 3,
          },
        ],
      },
      trace: {
        notes: ["Feasibility checker failed; treat plan as unverified."],
        rulesApplied: [],
      },
    };
  }
}

function safeRecommendActions(args) {
  try {
    return GapActionRecommender.recommend(args);
  } catch (e) {
    console.warn(`[${SOURCE}] GapActionRecommender failed; no actions.`, e);
    return {
      meta: {
        source: "GapActionRecommender",
        ok: false,
        error: safeStr(e?.message || e),
      },
      actions: [],
      issues: {
        blockers: [],
        risks: [
          {
            message: "Action recommendations unavailable.",
            detail: safeStr(e?.message || e),
            severity: 2,
          },
        ],
      },
      trace: {
        notes: ["GapActionRecommender failed; actions list empty."],
        rulesApplied: [],
      },
    };
  }
}

function safeGardenTargets(args) {
  try {
    return GardenTargetBuilder.build(args);
  } catch (e) {
    console.warn(
      `[${SOURCE}] GardenTargetBuilder failed; no garden targets.`,
      e
    );
    return {
      meta: {
        source: "GardenTargetBuilder",
        ok: false,
        error: safeStr(e?.message || e),
      },
      targets: [],
      issues: {
        blockers: [],
        risks: [
          {
            message: "Garden targets unavailable.",
            detail: safeStr(e?.message || e),
            severity: 2,
          },
        ],
      },
      trace: {
        notes: ["GardenTargetBuilder failed; targets empty."],
        rulesApplied: [],
      },
    };
  }
}

function safeAnimalTargets(args) {
  try {
    return AnimalTargetBuilder.build(args);
  } catch (e) {
    console.warn(
      `[${SOURCE}] AnimalTargetBuilder failed; no animal targets.`,
      e
    );
    return {
      meta: {
        source: "AnimalTargetBuilder",
        ok: false,
        error: safeStr(e?.message || e),
      },
      targets: [],
      issues: {
        blockers: [],
        risks: [
          {
            message: "Animal targets unavailable.",
            detail: safeStr(e?.message || e),
            severity: 2,
          },
        ],
      },
      trace: {
        notes: ["AnimalTargetBuilder failed; targets empty."],
        rulesApplied: [],
      },
    };
  }
}

function safeTimeline({
  householdId,
  startISO,
  horizonDays,
  timezone,
  catalogBundle,
  targetsOutput,
  gardenTargetsOutput,
  animalTargetsOutput,
  gapActionsOutput,
  feasibilityReport,
  options,
}) {
  try {
    return planTimelineInternal({
      householdId,
      startISO,
      horizonDays,
      timezone,
      catalogBundle,
      targetsOutput,
      gardenTargetsOutput,
      animalTargetsOutput,
      gapActionsOutput,
      feasibilityReport,
      options,
    });
  } catch (e) {
    console.warn(
      `[${SOURCE}] TimelinePlanner failed; returning empty timeline.`,
      e
    );
    return {
      meta: {
        source: "TimelinePlanner",
        ok: false,
        error: safeStr(e?.message || e),
      },
      timeline: {
        startISO,
        endISO: addDaysISO(startISO, horizonDays),
        items: [],
        sessions: [],
        milestones: [],
      },
      next: { dueISO: null, items: [], sessions: [] },
      issues: {
        blockers: [],
        risks: [
          {
            message: "Timeline unavailable.",
            detail: safeStr(e?.message || e),
            severity: 2,
          },
        ],
      },
      trace: {
        notes: ["TimelinePlanner failed; timeline empty."],
        rulesApplied: [],
      },
    };
  }
}

/* -----------------------------------------------------------------------------
 * Selection normalizers
 * --------------------------------------------------------------------------- */

function normalizeCuisinesSelection(raw) {
  const r = raw || {};

  // Accept:
  //  - { selected: [{id,name,weight?}], rotation? }
  //  - { selectedIds: ["aai", "med"], rotation? }
  //  - ["aai","med"]
  //  - null
  const out = { selected: [], rotation: r.rotation || null };

  if (Array.isArray(r)) {
    out.selected = r
      .map((id) => ({ id: safeStr(id), name: safeStr(id) }))
      .filter((x) => x.id);
    return out;
  }

  if (Array.isArray(r.selected)) {
    out.selected = r.selected
      .map((c) =>
        typeof c === "string"
          ? { id: safeStr(c), name: safeStr(c) }
          : {
              id: safeStr(c.id || c.key || c.slug),
              name: safeStr(c.name || c.title || c.id),
              weight: toNum(c.weight, undefined),
            }
      )
      .filter((x) => x.id);
    return out;
  }

  if (Array.isArray(r.selectedIds)) {
    out.selected = r.selectedIds
      .map((id) => ({ id: safeStr(id), name: safeStr(id) }))
      .filter((x) => x.id);
    return out;
  }

  // empty
  return out;
}

/* -----------------------------------------------------------------------------
 * Issues aggregator
 * --------------------------------------------------------------------------- */

function collectIssues(objs) {
  const blockers = [];
  const risks = [];

  for (const obj of objs || []) {
    if (!obj) continue;
    const b = obj.issues?.blockers || obj.blockers || [];
    const r = obj.issues?.risks || obj.risks || [];
    if (Array.isArray(b)) blockers.push(...b.map((x) => ({ ...x })));
    if (Array.isArray(r)) risks.push(...r.map((x) => ({ ...x })));
  }

  // Rank by severity desc (if present)
  blockers.sort((a, b) => toNum(b.severity, 0) - toNum(a.severity, 0));
  risks.sort((a, b) => toNum(b.severity, 0) - toNum(a.severity, 0));

  return { blockers, risks };
}

function outputsToCtx(outputs) {
  return {
    demandPlan: outputs.demandPlan,
    targetsOutput: outputs.targetsOutput,
    conversionOutput: outputs.conversionOutput,
    feasibilityReport: outputs.feasibilityReport,
    gapActionsOutput: outputs.gapActionsOutput,
    gardenTargetsOutput: outputs.gardenTargetsOutput,
    animalTargetsOutput: outputs.animalTargetsOutput,
    timelineOutput: outputs.timelineOutput,
  };
}

/* -----------------------------------------------------------------------------
 * Options + utils
 * --------------------------------------------------------------------------- */

function mergeOptions(options) {
  const base = deepMerge({}, DEFAULTS);
  const out = deepMerge(base, options || {});
  // Ensure engineOptions exists
  out.engineOptions = deepMerge(
    deepMerge({}, DEFAULTS.engineOptions),
    out.engineOptions || {}
  );
  return out;
}

function deepMerge(target, source) {
  const out = target && typeof target === "object" ? target : {};
  if (!source || typeof source !== "object") return out;

  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = out[k];
    if (Array.isArray(sv)) out[k] = sv.slice();
    else if (sv && typeof sv === "object")
      out[k] = deepMerge(
        tv && typeof tv === "object" && !Array.isArray(tv) ? tv : {},
        sv
      );
    else out[k] = sv;
  }
  return out;
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function addDaysISO(startISO, days) {
  const d = new Date(startISO);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString();
}

function formatDateShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* -----------------------------------------------------------------------------
 * Re-exports (Farm-to-Table engines under "homesteadPlanner" namespace)
 * -----------------------------------------------------------------------------
 * So app code can import from "@/services/homesteadPlanner" without caring
 * whether the implementation lives in /farmToTable or elsewhere.
 */
export {
  CatalogLoader,
  CatalogValidator,
  PreferenceResolver,
  CuisineResolver,
  ComponentDemandBuilder,
  ProvisioningTargetEngine,
  ConversionEngine,
  FeasibilityChecker,
  GapActionRecommender,
  GardenTargetBuilder,
  AnimalTargetBuilder,
  ExplanationBuilder,
};

// Provide timeline planner export with stable naming options
export const planTimeline = planTimelineInternal;
export { planTimelineInternal };
