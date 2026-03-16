// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\FeasibilityChecker.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead FeasibilityChecker
 * -----------------------------------------------------------------------------
 * Evaluates whether a Homestead plan is feasible given:
 *  - Targets (ProvisioningTargetEngine output)
 *  - Demand plan / gaps (ComponentDemandBuilder output)
 *  - Inventory snapshot (what you have now)
 *  - Planned batches (what you'll produce/preserve)
 *  - Household preferences (constraints)
 *  - Skills (what household can do)
 *  - Equipment / capacity (freezer, pantry, canner, dehydrator, garden bed space, etc.)
 *  - Time budget / workload
 *
 * Produces:
 *  - readinessScore (0..100)
 *  - feasibilityStatus: "good" | "tight" | "at_risk" | "blocked"
 *  - blockers (hard stops)
 *  - risks (soft constraints)
 *  - recommendations (actions to raise feasibility)
 *  - perDomain summaries (storehouse, garden, animals, preservation, skills, time)
 *
 * This engine is deterministic and explainable. No AI.
 *
 * -----------------------------------------------------------------------------
 * Public API
 * -----------------------------------------------------------------------------
 *  - checkFeasibility(input) -> FeasibilityReport
 *  - summarize(report) -> string[]
 *
 * -----------------------------------------------------------------------------
 * Input (flexible)
 * -----------------------------------------------------------------------------
 * checkFeasibility({
 *   householdId,
 *   startISO,
 *   horizonDays,
 *   targets,            // ProvisioningTargetEngine output
 *   demandPlan,         // ComponentDemandBuilder output
 *   catalogBundle,      // CatalogLoader output
 *   inventorySnapshot,  // optional
 *   plannedBatches,     // optional
 *   preferencesPack,    // PreferenceResolver output (optional)
 *   skillsProfile,      // optional: { skills: { [skillId]: level 0..5 }, certificates?, notes? }
 *   equipmentProfile,   // optional: { tools: { [toolId]: true }, capacities: { freezer_liters, pantry_liters, jars_pints, dehydrator_trays, garden_sqft, coop_capacity, ... } }
 *   timeBudget,         // optional: { minutesPerWeek, preservationMinutesPerWeek, gardeningMinutesPerWeek, cookingMinutesPerWeek }
 *   options
 * })
 */

const SOURCE = "services/farmToTable/FeasibilityChecker";

const DEFAULTS = {
  // Scoring weights (sum doesn't need to be 1; we normalize)
  weights: {
    inventoryCoverage: 0.35,
    capacity: 0.2,
    skills: 0.15,
    time: 0.15,
    constraintFit: 0.15,
  },

  // Thresholds for status
  thresholds: {
    good: 80,
    tight: 60,
    atRisk: 40,
  },

  // When a gap is "major"
  majorGapShare: 0.25, // gapQty / requiredQty

  // Skill requirements per domain (simple)
  skillRequirements: {
    preservation: { canning: 2, dehydrating: 1, fermenting: 1, butchery: 1 },
    garden: { gardening: 1, composting: 0 },
    animals: { animal_care: 1, butchery: 1 },
    storehouse: { inventory_management: 1 },
    cooking: { cooking: 1 },
  },

  // Tool requirements per domain (simple)
  toolRequirements: {
    preservation: ["canner", "jars", "dehydrator"], // any subset can satisfy depending on methods
    garden: ["garden_tools"],
    animals: ["coop_or_pen"], // if doing animals
  },

  // Capacity baselines (safe defaults)
  capacityDefaults: {
    freezer_liters: 0,
    pantry_liters: 0,
    jars_pints: 0,
    dehydrator_trays: 0,
    garden_sqft: 0,
    coop_capacity: 0, // number of birds or equivalent
  },

  // Approximate storage footprints per unit type (very rough; used only if no catalog data)
  storageFootprints: {
    // liters per "each"/"unit"
    each_to_liters: 1.0,
    // liters per serving (assume 0.25L)
    serving_to_liters: 0.25,
  },

  // Time estimates (minutes) per unit of activity when catalog/method not available
  timeEstimates: {
    // minutes per preserved "unit" (or serving)
    preservation_per_unit: 6,
    gardening_per_unit: 1,
    animal_per_unit: 2,
    cooking_per_unit: 1,
  },

  // Whether to treat missing tools/skills as blockers or risks
  missingAs: "risk", // "risk" | "blocker"
};

export const FeasibilityChecker = {
  checkFeasibility,
  summarize,
};

/* -----------------------------------------------------------------------------
 * Main
 * --------------------------------------------------------------------------- */

export function checkFeasibility(input = {}) {
  const opts = mergeOptions(input.options);

  const householdId = safeStr(input.householdId || "primary");
  const startISO = input.startISO || new Date().toISOString();
  const horizonDays = Number.isFinite(input.horizonDays)
    ? input.horizonDays
    : input.targets?.meta?.horizonDays || 28;

  const targets = input.targets || { provisioning: [], preservation: [] };
  const demandPlan = input.demandPlan || null;

  const catalog = input.catalogBundle || { components: [], methods: [] };
  const componentsById = new Map(
    (catalog.components || []).map((c) => [toLower(c.id), c])
  );
  const methodsById = new Map(
    (catalog.methods || []).map((m) => [toLower(m.id), m])
  );

  const inventorySnapshot = input.inventorySnapshot || null;
  const plannedBatches = input.plannedBatches || null;

  const preferencesPack = input.preferencesPack || null;
  const skillsProfile = normalizeSkills(input.skillsProfile);
  const equipmentProfile = normalizeEquipment(input.equipmentProfile, opts);

  const timeBudget = normalizeTimeBudget(input.timeBudget);

  // --------------------
  // 1) Inventory coverage score
  // --------------------
  const coverage = scoreInventoryCoverage(
    demandPlan,
    targets,
    inventorySnapshot,
    plannedBatches,
    opts
  );

  // --------------------
  // 2) Capacity score (storage + production capacity)
  // --------------------
  const capacity = scoreCapacity(
    targets,
    demandPlan,
    catalog,
    componentsById,
    equipmentProfile,
    opts
  );

  // --------------------
  // 3) Skills score
  // --------------------
  const skills = scoreSkills(
    targets,
    demandPlan,
    catalog,
    componentsById,
    methodsById,
    skillsProfile,
    equipmentProfile,
    opts
  );

  // --------------------
  // 4) Time score
  // --------------------
  const time = scoreTime(
    targets,
    demandPlan,
    catalog,
    componentsById,
    methodsById,
    timeBudget,
    opts
  );

  // --------------------
  // 5) Constraints fit score (preferences)
  // --------------------
  const constraintFit = scoreConstraintsFit(
    targets,
    demandPlan,
    catalog,
    componentsById,
    preferencesPack,
    opts
  );

  // Aggregate weighted score
  const weights = normalizeWeights(opts.weights);
  const rawScore =
    coverage.score * weights.inventoryCoverage +
    capacity.score * weights.capacity +
    skills.score * weights.skills +
    time.score * weights.time +
    constraintFit.score * weights.constraintFit;

  const readinessScore = clampNum(rawScore, 0, 100);

  const status =
    readinessScore >= opts.thresholds.good
      ? "good"
      : readinessScore >= opts.thresholds.tight
      ? "tight"
      : readinessScore >= opts.thresholds.atRisk
      ? "at_risk"
      : "blocked";

  // Merge blockers/risks/recommendations
  const blockers = []
    .concat(coverage.blockers)
    .concat(capacity.blockers)
    .concat(skills.blockers)
    .concat(time.blockers)
    .concat(constraintFit.blockers);

  const risks = []
    .concat(coverage.risks)
    .concat(capacity.risks)
    .concat(skills.risks)
    .concat(time.risks)
    .concat(constraintFit.risks);

  const recommendations = dedupeRecommendations(
    []
      .concat(coverage.recommendations)
      .concat(capacity.recommendations)
      .concat(skills.recommendations)
      .concat(time.recommendations)
      .concat(constraintFit.recommendations)
  );

  // Per-domain summaries
  const perDomain = {
    storehouse: summarizeDomain("storehouse", coverage, capacity),
    preservation: summarizeDomain(
      "preservation",
      coverage,
      capacity,
      skills,
      time
    ),
    garden: summarizeDomain("garden", capacity, skills, time),
    animals: summarizeDomain("animals", capacity, skills, time),
    skills: {
      score: skills.score,
      notes: skills.notes,
      blockers: skills.blockers,
      risks: skills.risks,
    },
    time: {
      score: time.score,
      notes: time.notes,
      blockers: time.blockers,
      risks: time.risks,
    },
    constraints: {
      score: constraintFit.score,
      notes: constraintFit.notes,
      blockers: constraintFit.blockers,
      risks: constraintFit.risks,
    },
  };

  return {
    meta: {
      householdId,
      startISO,
      horizonDays,
      builtAtISO: new Date().toISOString(),
      source: SOURCE,
    },
    readinessScore,
    feasibilityStatus: status,
    components: {
      inventoryCoverage: coverage,
      capacity,
      skills,
      time,
      constraintFit,
    },
    blockers: rankIssues(blockers),
    risks: rankIssues(risks),
    recommendations,
    perDomain,
  };
}

export function summarize(report) {
  const r = report || {};
  const lines = [];
  lines.push(
    `Readiness score: ${Math.round(r.readinessScore || 0)}/100 (${
      r.feasibilityStatus || "unknown"
    })`
  );

  const topBlockers = (r.blockers || []).slice(0, 5);
  if (topBlockers.length) {
    lines.push("Top blockers:");
    lines.push(
      ...topBlockers.map(
        (b) => `• ${b.title}${b.detail ? ` — ${b.detail}` : ""}`
      )
    );
  }

  const topRisks = (r.risks || []).slice(0, 5);
  if (topRisks.length) {
    lines.push("Top risks:");
    lines.push(
      ...topRisks.map((b) => `• ${b.title}${b.detail ? ` — ${b.detail}` : ""}`)
    );
  }

  const recs = (r.recommendations || []).slice(0, 5);
  if (recs.length) {
    lines.push("Next best actions:");
    lines.push(...recs.map((x) => `• ${x.title}`));
  }

  return lines;
}

/* -----------------------------------------------------------------------------
 * Scoring components
 * --------------------------------------------------------------------------- */

function scoreInventoryCoverage(
  demandPlan,
  targets,
  inventorySnapshot,
  plannedBatches,
  opts
) {
  const blockers = [];
  const risks = [];
  const recommendations = [];
  const notes = [];

  // Prefer demandPlan gaps if available
  const gaps = Array.isArray(demandPlan?.gaps) ? demandPlan.gaps : null;

  if (!gaps) {
    // fallback: if no demandPlan, coverage is unknown -> partial score
    notes.push(
      "No demandPlan provided; inventory coverage score is estimated."
    );
    return {
      score: 60,
      blockers,
      risks: [
        {
          title: "No demand plan",
          severity: 2,
          detail: "Coverage is estimated without gaps.",
        },
      ],
      recommendations,
      notes,
    };
  }

  let required = 0;
  let covered = 0;
  let majorGapCount = 0;

  for (const g of gaps) {
    const req = toNum(g.requiredQty, 0);
    const gap = toNum(g.gapQty, 0);
    const avail = toNum(g.availableQty, 0) + toNum(g.plannedQty, 0);

    required += req;
    covered += Math.max(0, Math.min(req, avail));

    const share = req > 0 ? gap / req : 0;
    if (share >= opts.majorGapShare && gap > 0) majorGapCount += 1;
  }

  const coverageRatio = required > 0 ? covered / required : 1;
  const score = clampNum(coverageRatio * 100, 0, 100);

  notes.push(
    `Coverage ratio: ${(coverageRatio * 100).toFixed(
      1
    )}% of demand met by inventory + planned production.`
  );

  if (coverageRatio < 0.6 && majorGapCount >= 3) {
    blockers.push({
      title: "Large supply gaps",
      severity: 5,
      detail: `${majorGapCount} major gaps across core components.`,
      domain: "storehouse",
      code: "coverage.major_gaps",
    });
    recommendations.push({
      title: "Reduce horizon or narrow cuisine rotation until gaps shrink",
      domain: "planner",
      code: "recs.reduce_scope",
      priority: 1,
    });
  } else if (coverageRatio < 0.8) {
    risks.push({
      title: "Supply gaps likely",
      severity: 3,
      detail: `Only ${(coverageRatio * 100).toFixed(0)}% of demand covered.`,
      domain: "storehouse",
      code: "coverage.gaps",
    });
    recommendations.push({
      title:
        "Generate shopping list from gaps and schedule 1–2 replenishment runs",
      domain: "shopping",
      code: "recs.shopping_from_gaps",
      priority: 2,
    });
  }

  return { score, blockers, risks, recommendations, notes };
}

function scoreCapacity(
  targets,
  demandPlan,
  catalog,
  componentsById,
  equipmentProfile,
  opts
) {
  const blockers = [];
  const risks = [];
  const recommendations = [];
  const notes = [];

  // Storage capacity check (very approximate)
  const caps = equipmentProfile.capacities;

  // Estimate storage liters needed from demand totals (or targets if no demandPlan)
  const totals = Array.isArray(demandPlan?.totals) ? demandPlan.totals : null;

  let estimatedLiters = 0;
  if (totals) {
    for (const t of totals) {
      // try catalog storage footprint per unit if exists
      const c = componentsById.get(toLower(t.componentId));
      const unit = normalizeUnit(t.unit);
      const req = toNum(t.requiredQty, 0);
      estimatedLiters += estimateStorageLiters(c, req, unit, opts);
    }
  } else {
    const prov = Array.isArray(targets?.provisioning)
      ? targets.provisioning
      : [];
    for (const p of prov) {
      const c = componentsById.get(toLower(p.componentId));
      const unit = normalizeUnit(p.unit);
      // provisioning qty is typically weekly; approximate for horizon as * (horizonDays/7)
      const req =
        toNum(p.qty, 0) * Math.max(1, (targets?.meta?.horizonDays || 28) / 7);
      estimatedLiters += estimateStorageLiters(c, req, unit, opts);
    }
  }

  // Available storage liters: pantry + freezer (we treat both as storage)
  const availableLiters =
    toNum(caps.pantry_liters, 0) + toNum(caps.freezer_liters, 0);

  notes.push(
    `Estimated storage need: ~${Math.round(
      estimatedLiters
    )} L; available: ${Math.round(availableLiters)} L.`
  );

  // If no capacity provided, treat as risk
  if (availableLiters <= 0) {
    risks.push({
      title: "Storage capacity not set",
      severity: 2,
      detail: "Add pantry/freezer capacities to improve feasibility accuracy.",
      domain: "storehouse",
      code: "capacity.missing_storage",
    });
    recommendations.push({
      title: "Add freezer/pantry capacities to Household Profile → Equipment",
      domain: "storehouse",
      code: "recs.set_storage_capacity",
      priority: 3,
    });
    return { score: 70, blockers, risks, recommendations, notes };
  }

  const ratio = availableLiters > 0 ? estimatedLiters / availableLiters : 999;
  const score = clampNum(100 - Math.max(0, (ratio - 1) * 120), 0, 100);

  if (ratio > 1.25) {
    blockers.push({
      title: "Insufficient storage capacity",
      severity: 5,
      detail: `Need ~${Math.round(
        estimatedLiters
      )} L but only have ~${Math.round(availableLiters)} L.`,
      domain: "storehouse",
      code: "capacity.storage_blocked",
    });
    recommendations.push({
      title:
        "Reduce provisioning horizon, increase preservation-to-shelf methods, or add storage",
      domain: "storehouse",
      code: "recs.storage_fix",
      priority: 1,
    });
  } else if (ratio > 1.05) {
    risks.push({
      title: "Storage capacity tight",
      severity: 3,
      detail: `Estimated usage ~${Math.round(ratio * 100)}% of capacity.`,
      domain: "storehouse",
      code: "capacity.storage_tight",
    });
    recommendations.push({
      title:
        "Prioritize shelf-stable preservation and avoid bulk purchases until capacity is expanded",
      domain: "preservation",
      code: "recs.capacity_tight",
      priority: 2,
    });
  }

  // Preservation capacity: jars/trays vs preservation targets
  const presTargets = Array.isArray(targets?.preservation)
    ? targets.preservation
    : [];
  if (presTargets.length) {
    const jarsNeeded = estimateJarsNeeded(presTargets);
    const jarsHave = toNum(caps.jars_pints, 0);

    if (jarsHave <= 0 && jarsNeeded > 0) {
      addIssue(opts, blockers, risks, {
        title: "No jars capacity for preservation plan",
        severity: 4,
        detail: `Preservation targets imply ~${Math.round(
          jarsNeeded
        )} pint-jars, but jars_pints is 0.`,
        domain: "preservation",
        code: "capacity.no_jars",
      });
      recommendations.push({
        title: "Add jars or reduce canning-based preservation targets",
        domain: "preservation",
        code: "recs.get_jars",
        priority: 2,
      });
    } else if (jarsHave > 0 && jarsNeeded > jarsHave * 1.1) {
      addIssue(opts, blockers, risks, {
        title: "Jar capacity shortfall",
        severity: 4,
        detail: `Need ~${Math.round(jarsNeeded)} pint-jars, have ${Math.round(
          jarsHave
        )}.`,
        domain: "preservation",
        code: "capacity.jars_short",
      });
      recommendations.push({
        title:
          "Shift some preservation to freezing/dehydrating or schedule jar acquisition",
        domain: "preservation",
        code: "recs.shift_preservation",
        priority: 3,
      });
    }
  }

  return { score, blockers, risks, recommendations, notes };
}

function scoreSkills(
  targets,
  demandPlan,
  catalog,
  componentsById,
  methodsById,
  skillsProfile,
  equipmentProfile,
  opts
) {
  const blockers = [];
  const risks = [];
  const recommendations = [];
  const notes = [];

  const required = inferRequiredSkills(
    targets,
    demandPlan,
    catalog,
    componentsById
  );
  const missing = [];

  for (const req of required) {
    const have = toNum(skillsProfile.skills[req.skillId], 0);
    if (have < req.level) {
      missing.push({ ...req, have });
    }
  }

  if (!required.length) {
    notes.push("No skill requirements inferred; assuming baseline capability.");
    return { score: 85, blockers, risks, recommendations, notes };
  }

  const totalReq = required.reduce((a, b) => a + b.level, 0);
  const totalHave = required.reduce(
    (a, b) => a + Math.min(toNum(skillsProfile.skills[b.skillId], 0), b.level),
    0
  );
  const ratio = totalReq > 0 ? totalHave / totalReq : 1;
  const score = clampNum(ratio * 100, 0, 100);

  notes.push(
    `Skill coverage: ${(ratio * 100).toFixed(0)}% of inferred requirements.`
  );

  for (const m of missing.slice(0, 8)) {
    addIssue(opts, blockers, risks, {
      title: `Skill gap: ${m.skillId}`,
      severity: m.level >= 3 ? 4 : 3,
      detail: `Need level ${m.level}, have ${m.have}.`,
      domain: "skills",
      code: "skills.missing",
    });
    recommendations.push({
      title: `Add a skill path for "${m.skillId}" (level ${m.have}→${m.level}) tied to upcoming plan`,
      domain: "skills",
      code: "recs.skill_path",
      priority: 2,
      meta: { skillId: m.skillId, needLevel: m.level, haveLevel: m.have },
    });
  }

  // Tool gating: if preservation targets exist but no canner/dehydrator/freezer, amplify risk/blocker
  const presTargets = Array.isArray(targets?.preservation)
    ? targets.preservation
    : [];
  if (presTargets.length) {
    const hasCanner = !!equipmentProfile.tools.canner;
    const hasDehydrator = !!equipmentProfile.tools.dehydrator;
    const hasFreezer = toNum(equipmentProfile.capacities.freezer_liters, 0) > 0;

    if (!hasCanner && !hasDehydrator && !hasFreezer) {
      addIssue(opts, blockers, risks, {
        title: "Preservation plan without equipment",
        severity: 5,
        detail:
          "Preservation targets exist but no canner, dehydrator, or freezer capacity is configured.",
        domain: "preservation",
        code: "skills.tools_missing",
      });
      recommendations.push({
        title:
          "Choose at least one preservation path (canning/dehydrating/freezing) and add the required tool/capacity",
        domain: "preservation",
        code: "recs.pick_preservation_path",
        priority: 1,
      });
    }
  }

  return { score, blockers, risks, recommendations, notes };
}

function scoreTime(
  targets,
  demandPlan,
  catalog,
  componentsById,
  methodsById,
  timeBudget,
  opts
) {
  const blockers = [];
  const risks = [];
  const recommendations = [];
  const notes = [];

  const est = estimateTimeWorkload(
    targets,
    demandPlan,
    catalog,
    componentsById,
    methodsById,
    opts
  );
  const budget = timeBudget.minutesPerWeek;

  if (!Number.isFinite(budget) || budget <= 0) {
    risks.push({
      title: "Time budget not set",
      severity: 2,
      detail: "Set minutesPerWeek to improve feasibility accuracy.",
      domain: "time",
      code: "time.missing_budget",
    });
    recommendations.push({
      title: "Set weekly time budget (minutes/week) for homestead work",
      domain: "time",
      code: "recs.set_time_budget",
      priority: 3,
    });
    // Score based on workload only, conservative
    const score =
      est.totalMinutesPerWeek <= 300
        ? 80
        : est.totalMinutesPerWeek <= 600
        ? 60
        : 40;
    notes.push(
      `Estimated workload ~${Math.round(
        est.totalMinutesPerWeek
      )} min/week (budget unknown).`
    );
    return { score, blockers, risks, recommendations, notes };
  }

  notes.push(
    `Estimated workload ~${Math.round(
      est.totalMinutesPerWeek
    )} min/week. Budget: ${Math.round(budget)} min/week.`
  );

  const ratio = budget > 0 ? est.totalMinutesPerWeek / budget : 999;
  const score = clampNum(100 - Math.max(0, (ratio - 1) * 130), 0, 100);

  if (ratio > 1.3) {
    blockers.push({
      title: "Time budget exceeded",
      severity: 5,
      detail: `Estimated ${Math.round(
        est.totalMinutesPerWeek
      )} min/week vs budget ${Math.round(budget)}.`,
      domain: "time",
      code: "time.blocked",
    });
    recommendations.push({
      title:
        "Reduce preservation volume, extend timelines, or shift some tasks to batch weekends",
      domain: "planner",
      code: "recs.reduce_time_load",
      priority: 1,
    });
  } else if (ratio > 1.05) {
    risks.push({
      title: "Time budget tight",
      severity: 3,
      detail: `Estimated ${Math.round(ratio * 100)}% of budget.`,
      domain: "time",
      code: "time.tight",
    });
    recommendations.push({
      title: "Front-load prep and choose quicker methods for the next cycle",
      domain: "planner",
      code: "recs.time_tight",
      priority: 2,
    });
  }

  return { score, blockers, risks, recommendations, notes };
}

function scoreConstraintsFit(
  targets,
  demandPlan,
  catalog,
  componentsById,
  preferencesPack,
  opts
) {
  const blockers = [];
  const risks = [];
  const recommendations = [];
  const notes = [];

  // If no preferences, assume neutral
  if (!preferencesPack) {
    notes.push("No preferencesPack provided; constraint-fit assumed neutral.");
    return { score: 85, blockers, risks, recommendations, notes };
  }

  const forbiddenTags = normalizeStringArray(
    preferencesPack.constraints?.forbiddenTags ||
      preferencesPack.resolved?.constraints?.forbiddenTags
  ).map(toLower);
  const dislikes = normalizeStringArray(
    preferencesPack.dislikes ||
      preferencesPack.scoring?.dislikedIngredients ||
      []
  );
  const avoid = new Set(
    [...forbiddenTags, ...dislikes].map(toLower).filter(Boolean)
  );

  if (!avoid.size) {
    notes.push("No forbidden/disliked constraints detected.");
    return { score: 95, blockers, risks, recommendations, notes };
  }

  // Check targets for forbidden tags
  const prov = Array.isArray(targets?.provisioning) ? targets.provisioning : [];
  let hits = 0;

  for (const t of prov) {
    const c = componentsById.get(toLower(t.componentId));
    const tags = normalizeStringArray(c?.tags).map(toLower);
    if (tags.some((x) => avoid.has(x))) hits += 1;
  }

  const share = prov.length ? hits / prov.length : 0;
  const score = clampNum(100 - share * 120, 0, 100);

  notes.push(
    `Constraint hits: ${hits}/${prov.length} provisioning targets match avoid tags.`
  );

  if (share > 0.25) {
    addIssue(opts, blockers, risks, {
      title: "Plan conflicts with household constraints",
      severity: 4,
      detail: `${hits} targets contain forbidden/disliked tags.`,
      domain: "constraints",
      code: "constraints.conflict",
    });
    recommendations.push({
      title:
        "Replace conflicting components in basket selection (swap to acceptable alternatives)",
      domain: "planner",
      code: "recs.swap_components",
      priority: 1,
    });
  } else if (share > 0.1) {
    risks.push({
      title: "Some plan items conflict with preferences",
      severity: 2,
      detail: `${hits} targets contain avoid tags.`,
      domain: "constraints",
      code: "constraints.some_conflict",
    });
    recommendations.push({
      title: "Review and edit the provisioning basket for preference fit",
      domain: "planner",
      code: "recs.review_preferences",
      priority: 3,
    });
  }

  return { score, blockers, risks, recommendations, notes };
}

/* -----------------------------------------------------------------------------
 * Inference helpers
 * --------------------------------------------------------------------------- */

function inferRequiredSkills(targets, demandPlan, catalog, componentsById) {
  const reqs = [];

  const presTargets = Array.isArray(targets?.preservation)
    ? targets.preservation
    : [];
  const provTargets = Array.isArray(targets?.provisioning)
    ? targets.provisioning
    : [];

  if (presTargets.length) {
    // preservation implies canning/dehydrating/fermenting skill baseline
    reqs.push({ skillId: "canning", level: 2, domain: "preservation" });
    reqs.push({ skillId: "dehydrating", level: 1, domain: "preservation" });
    reqs.push({ skillId: "fermenting", level: 1, domain: "preservation" });
  }

  // If there are proteins with tags meat/fish/poultry, require butchery at level 1
  let hasAnimalProtein = false;
  for (const t of provTargets) {
    const c = componentsById.get(toLower(t.componentId));
    const tags = normalizeStringArray(c?.tags).map(toLower);
    if (tags.some((x) => ["meat", "fish", "poultry"].includes(x))) {
      hasAnimalProtein = true;
      break;
    }
  }
  if (hasAnimalProtein) {
    reqs.push({ skillId: "butchery", level: 1, domain: "animals" });
    reqs.push({ skillId: "animal_care", level: 1, domain: "animals" });
  }

  // Always recommend basic inventory management
  reqs.push({
    skillId: "inventory_management",
    level: 1,
    domain: "storehouse",
  });
  reqs.push({ skillId: "cooking", level: 1, domain: "cooking" });
  reqs.push({ skillId: "gardening", level: 1, domain: "garden" });

  return dedupeSkillReqs(reqs);
}

function dedupeSkillReqs(reqs) {
  const map = new Map();
  for (const r of reqs || []) {
    const k = `${toLower(r.skillId)}|${toLower(r.domain || "")}`;
    const prev = map.get(k);
    if (!prev || prev.level < r.level) map.set(k, r);
  }
  return Array.from(map.values());
}

function estimateTimeWorkload(
  targets,
  demandPlan,
  catalog,
  componentsById,
  methodsById,
  opts
) {
  const prov = Array.isArray(targets?.provisioning) ? targets.provisioning : [];
  const pres = Array.isArray(targets?.preservation) ? targets.preservation : [];
  const horizonDays = targets?.meta?.horizonDays || 28;

  // Provisioning is weekly; approximate total units per week directly from p.qty
  const weeklyProvisionUnits = prov.reduce((a, p) => a + toNum(p.qty, 0), 0);

  // Preservation is usually one-time; convert to per-week by dividing over horizon weeks
  const weeks = Math.max(1, horizonDays / 7);
  const weeklyPresUnits = pres.reduce((a, p) => a + toNum(p.qty, 0), 0) / weeks;

  // Gardening/animals workload inferred from categories/tags (very rough)
  let gardeningUnits = 0;
  let animalUnits = 0;

  for (const p of prov) {
    const c = componentsById.get(toLower(p.componentId));
    const tags = normalizeStringArray(c?.tags).map(toLower);
    const qty = toNum(p.qty, 0);

    if (
      tags.some((x) =>
        ["produce", "vegetable", "fruit", "herb", "grain", "legume"].includes(x)
      )
    )
      gardeningUnits += qty;
    if (
      tags.some((x) => ["meat", "poultry", "fish", "eggs", "dairy"].includes(x))
    )
      animalUnits += qty;
  }

  const cookingMinutes =
    weeklyProvisionUnits * opts.timeEstimates.cooking_per_unit;
  const preservationMinutes =
    weeklyPresUnits * opts.timeEstimates.preservation_per_unit;
  const gardeningMinutes =
    gardeningUnits * opts.timeEstimates.gardening_per_unit;
  const animalMinutes = animalUnits * opts.timeEstimates.animal_per_unit;

  const total =
    cookingMinutes + preservationMinutes + gardeningMinutes + animalMinutes;

  return {
    cookingMinutesPerWeek: cookingMinutes,
    preservationMinutesPerWeek: preservationMinutes,
    gardeningMinutesPerWeek: gardeningMinutes,
    animalMinutesPerWeek: animalMinutes,
    totalMinutesPerWeek: total,
  };
}

function estimateStorageLiters(component, qty, unit, opts) {
  // If catalog provides storageLitersPerUnit, use it
  const litersPerUnit = toNum(component?.defaults?.storageLitersPerUnit, null);
  if (Number.isFinite(litersPerUnit) && litersPerUnit >= 0)
    return qty * litersPerUnit;

  const u = normalizeUnit(unit);
  if (u === "serving") return qty * opts.storageFootprints.serving_to_liters;
  if (u === "each" || u === "unit" || u === "item")
    return qty * opts.storageFootprints.each_to_liters;

  // If it's a mass/volume unit, approximate 1L per 1kg / 1L per 1L
  if (["g", "kg", "oz", "lb"].includes(u)) {
    const grams =
      u === "g"
        ? qty
        : u === "kg"
        ? qty * 1000
        : u === "oz"
        ? qty * 28.3495
        : qty * 453.592;
    // assume density ~1g/ml => 1000g ~ 1L
    return grams / 1000;
  }
  if (["ml", "l", "cup", "qt", "gal", "pt", "tbsp", "tsp"].includes(u)) {
    const ml =
      u === "ml"
        ? qty
        : u === "l"
        ? qty * 1000
        : u === "cup"
        ? qty * 236.588
        : u === "pt"
        ? qty * 473.176
        : u === "qt"
        ? qty * 946.353
        : u === "gal"
        ? qty * 3785.412
        : u === "tbsp"
        ? qty * 14.787
        : qty * 4.929;
    return ml / 1000;
  }

  // unknown
  return qty * 0.25;
}

function estimateJarsNeeded(preservationTargets) {
  // Very rough: assume 1 "unit" == 1 pint jar unless unit suggests otherwise
  let jars = 0;
  for (const p of preservationTargets || []) {
    const u = normalizeUnit(p.unit);
    const qty = toNum(p.qty, 0);
    if (u === "serving") jars += qty * 0.5; // 2 servings per pint as a guess
    else jars += qty;
  }
  return jars;
}

/* -----------------------------------------------------------------------------
 * Normalizers
 * --------------------------------------------------------------------------- */

function normalizeSkills(raw) {
  const skills = raw && typeof raw === "object" ? raw.skills || raw : {};
  const out = {};
  if (skills && typeof skills === "object") {
    for (const k of Object.keys(skills)) out[toLower(k)] = toNum(skills[k], 0);
  }
  return { skills: out };
}

function normalizeEquipment(raw, opts) {
  const toolsIn = raw?.tools && typeof raw.tools === "object" ? raw.tools : {};
  const capsIn =
    raw?.capacities && typeof raw.capacities === "object" ? raw.capacities : {};

  const tools = {};
  for (const k of Object.keys(toolsIn)) tools[toLower(k)] = !!toolsIn[k];

  const capacities = { ...DEFAULTS.capacityDefaults };
  for (const k of Object.keys(capacities))
    capacities[k] = toNum(capsIn[k], capacities[k]);

  return { tools, capacities };
}

function normalizeTimeBudget(raw) {
  if (!raw || typeof raw !== "object") return { minutesPerWeek: 0 };
  return {
    minutesPerWeek: toNum(raw.minutesPerWeek, 0),
    preservationMinutesPerWeek: toNum(raw.preservationMinutesPerWeek, 0),
    gardeningMinutesPerWeek: toNum(raw.gardeningMinutesPerWeek, 0),
    cookingMinutesPerWeek: toNum(raw.cookingMinutesPerWeek, 0),
  };
}

/* -----------------------------------------------------------------------------
 * Utilities
 * --------------------------------------------------------------------------- */

function mergeOptions(options) {
  const out = deepMerge({}, DEFAULTS);
  return deepMerge(out, options || {});
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

function normalizeWeights(w) {
  const ww = { ...DEFAULTS.weights, ...(w || {}) };
  const sum =
    toNum(ww.inventoryCoverage, 0) +
    toNum(ww.capacity, 0) +
    toNum(ww.skills, 0) +
    toNum(ww.time, 0) +
    toNum(ww.constraintFit, 0);
  if (sum <= 0) return { ...DEFAULTS.weights };
  return {
    inventoryCoverage: ww.inventoryCoverage / sum,
    capacity: ww.capacity / sum,
    skills: ww.skills / sum,
    time: ww.time / sum,
    constraintFit: ww.constraintFit / sum,
  };
}

function summarizeDomain(name, ...parts) {
  const score = Math.round(
    parts.map((p) => toNum(p?.score, 0)).reduce((a, b) => a + b, 0) /
      Math.max(1, parts.length)
  );

  const blockers = [];
  const risks = [];
  const notes = [];
  for (const p of parts) {
    if (!p) continue;
    if (Array.isArray(p.blockers))
      blockers.push(
        ...p.blockers.filter((x) => x.domain === name || !x.domain)
      );
    if (Array.isArray(p.risks))
      risks.push(...p.risks.filter((x) => x.domain === name || !x.domain));
    if (Array.isArray(p.notes)) notes.push(...p.notes);
  }

  return {
    score,
    blockers: rankIssues(blockers),
    risks: rankIssues(risks),
    notes,
  };
}

function rankIssues(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.sort((a, b) => toNum(b.severity, 0) - toNum(a.severity, 0));
  return arr;
}

function dedupeRecommendations(list) {
  const out = [];
  const seen = new Set();
  for (const r of list || []) {
    const key = `${toLower(r.code || r.title)}|${toLower(r.domain || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  out.sort((a, b) => toNum(a.priority, 99) - toNum(b.priority, 99));
  return out;
}

function addIssue(opts, blockers, risks, issue) {
  if (opts.missingAs === "blocker") blockers.push(issue);
  else risks.push(issue);
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function toLower(s) {
  return (typeof s === "string" ? s : s == null ? "" : String(s))
    .trim()
    .toLowerCase();
}

function normalizeStringArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((x) => safeStr(x)).filter(Boolean);
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUnit(u) {
  const s = safeStr(u).toLowerCase();
  if (!s) return "";
  if (s === "unit" || s === "item" || s === "piece") return "each";
  return s;
}
