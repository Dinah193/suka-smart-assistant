// C:\Users\larho\suka-smart-assistant\src\services\farmToTable/GapActionRecommender.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead GapActionRecommender
 * -----------------------------------------------------------------------------
 * Converts demand gaps into actionable, prioritized recommendations for:
 *  - Homestead targets page (actions list)
 *  - Garden targets page (planting actions derived from provisioning gaps)
 *  - Animal targets page (breeding/purchase actions derived from provisioning gaps)
 *  - Preservation batches page (start batch from gaps)
 *  - Shopping list generator (buy actions)
 *
 * Deterministic + explainable. No AI.
 *
 * -----------------------------------------------------------------------------
 * Inputs
 * -----------------------------------------------------------------------------
 * recommendGapActions({
 *   householdId,
 *   startISO,
 *   horizonDays,
 *   catalogBundle,            // CatalogLoader output
 *   demandPlan,               // ComponentDemandBuilder output
 *   targetsOutput,            // ProvisioningTargetEngine output (optional)
 *   inventorySnapshot,        // optional
 *   cuisineSelection,         // CuisineResolver output (optional)
 *   preferencesPack,          // PreferenceResolver output (optional)
 *   feasibilityReport,        // FeasibilityChecker output (optional)
 *   options
 * })
 *
 * demandPlan expected (flexible shape):
 *  {
 *    gaps: [{
 *      componentId, name,
 *      requiredQty, availableQty, plannedQty, gapQty,
 *      unit,
 *      category?, // staples/protein/produce/etc
 *      urgency?: "high"|"medium"|"low",
 *      byISO?
 *    }]
 *  }
 *
 * -----------------------------------------------------------------------------
 * Outputs
 * -----------------------------------------------------------------------------
 * {
 *   meta: {...},
 *   actions: GapActionCard[],
 *   grouped: { shopping:[], garden:[], animals:[], preservation:[], substitutions:[], scheduling:[] },
 *   trace: { rulesApplied[], notes[] }
 * }
 *
 * Action card shape:
 * {
 *   id,
 *   type: "buy"|"plant"|"breed"|"process"|"substitute"|"schedule"|"research",
 *   componentId,
 *   title,
 *   detail,
 *   qty,
 *   unit,
 *   urgency,
 *   confidence: 0..1,
 *   effort: { minutes, difficulty: 1..5 },
 *   costHint: { kind:"low"|"medium"|"high"|"unknown", notes? },
 *   dependencies?: [{ kind, id, title }],
 *   links?: { to?: string, payload?: any },
 *   tags?: string[],
 *   score: number, // internal ranking
 *   explain: string[]
 * }
 */

const SOURCE = "services/farmToTable/GapActionRecommender";

const DEFAULTS = {
  // Ranking weights
  weights: {
    urgency: 0.35,
    size: 0.25,
    feasibility: 0.2,
    preferenceFit: 0.1,
    effortPenalty: 0.1,
  },

  // Gap severity thresholds (relative)
  majorGapShare: 0.25, // gap / required
  hugeGapShare: 0.5,

  // Action mix preferences
  enable: {
    buy: true,
    plant: true,
    breed: true,
    process: true,
    substitute: true,
    schedule: true,
  },

  // Lead time assumptions (days)
  leadTimes: {
    buy: 2,
    plant: 45,
    breed: 120,
    process: 7,
    substitute: 1,
    schedule: 1,
  },

  // Effort assumptions (minutes per unit)
  effort: {
    buy_per_unit: 0.25,
    plant_per_unit: 1.0,
    breed_per_unit: 2.0,
    process_per_unit: 6.0,
    substitute_per_unit: 0.5,
    schedule_base: 10,
  },

  // Difficulty by type (1..5)
  difficulty: {
    buy: 1,
    plant: 3,
    breed: 4,
    process: 4,
    substitute: 2,
    schedule: 2,
    research: 2,
  },

  // Cost hint defaults
  costHint: {
    buy: "medium",
    plant: "low",
    breed: "high",
    process: "medium",
    substitute: "low",
    schedule: "low",
  },

  // Category to default action preferences
  categoryDefaultActions: {
    staples: ["buy", "substitute", "process"],
    protein: ["buy", "breed", "process", "substitute"],
    produce: ["plant", "buy", "process", "substitute"],
    fat: ["buy", "substitute"],
    dairy: ["buy", "breed", "substitute"],
    beverage: ["buy", "substitute"],
    dessert: ["buy", "substitute"],
    unknown: ["buy", "substitute"],
  },

  // Tag mapping (catalog components tags -> "source domain")
  tagDomainHints: {
    // garden
    vegetable: "garden",
    fruit: "garden",
    herb: "garden",
    produce: "garden",
    grain: "garden",
    legume: "garden",
    bean: "garden",
    // animals
    meat: "animals",
    poultry: "animals",
    eggs: "animals",
    dairy: "animals",
    fish: "animals",
  },

  // Substitution rules: map tag -> substitute tags (fallback)
  substitution: {
    // staples
    rice: ["pasta", "grain", "starch"],
    pasta: ["rice", "grain", "starch"],
    flour: ["grain", "starch"],
    // proteins
    chicken: ["poultry", "meat", "fish", "eggs"],
    beef: ["meat", "poultry", "fish"],
    fish: ["protein", "meat", "poultry"],
    eggs: ["protein", "poultry"],
    // produce
    greens: ["vegetable", "produce"],
    cabbage: ["vegetable", "produce"],
  },

  // Keep actions manageable
  maxActions: 120,
  maxPerGap: 4,

  // If feasibility checker says blocked, push "reduce scope" actions
  scopeReductionActions: true,
};

export const GapActionRecommender = {
  recommendGapActions,
  groupActions,
  summarize,
};

/* -----------------------------------------------------------------------------
 * Main
 * --------------------------------------------------------------------------- */

export function recommendGapActions(input = {}) {
  const opts = mergeOptions(input.options);

  const householdId = safeStr(input.householdId || "primary");
  const startISO = input.startISO || new Date().toISOString();
  const horizonDays = Number.isFinite(input.horizonDays)
    ? input.horizonDays
    : input.targetsOutput?.meta?.horizonDays || 28;

  const catalog = input.catalogBundle || { components: [], methods: [] };
  const components = Array.isArray(catalog.components)
    ? catalog.components
    : [];
  const byId = new Map(components.map((c) => [toLower(c.id), c]));

  const demandPlan = input.demandPlan || {};
  const gaps = Array.isArray(demandPlan.gaps) ? demandPlan.gaps : [];

  const cuisineSelection = input.cuisineSelection || null;
  const preferencesPack = input.preferencesPack || null;
  const feasibility = input.feasibilityReport || null;

  const actions = [];
  const rulesApplied = [];
  const notes = [];

  if (!gaps.length) {
    notes.push("No gaps provided; no actions generated.");
    return {
      meta: {
        householdId,
        startISO,
        horizonDays,
        builtAtISO: new Date().toISOString(),
        source: SOURCE,
      },
      actions: [],
      grouped: groupActions([]),
      trace: { rulesApplied, notes },
    };
  }

  // Scope reduction suggestions when feasibility is blocked
  if (
    opts.scopeReductionActions &&
    feasibility?.feasibilityStatus === "blocked"
  ) {
    actions.push(
      ...buildScopeReductionActions(feasibility, startISO, horizonDays)
    );
    rulesApplied.push("Feasibility blocked: added scope reduction actions.");
  }

  // Generate actions per gap
  for (const g of gaps) {
    const gapActions = buildActionsForGap(g, {
      byId,
      opts,
      cuisineSelection,
      preferencesPack,
      feasibility,
      startISO,
      horizonDays,
      rulesApplied,
    });
    actions.push(...gapActions);
  }

  // Rank + trim
  const ranked = actions
    .map((a) => ({ ...a, score: scoreAction(a, { opts, feasibility }) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxActions);

  const grouped = groupActions(ranked);

  return {
    meta: {
      householdId,
      startISO,
      horizonDays,
      builtAtISO: new Date().toISOString(),
      source: SOURCE,
    },
    actions: ranked,
    grouped,
    trace: { rulesApplied: uniq(rulesApplied), notes },
  };
}

/* -----------------------------------------------------------------------------
 * Build actions for a single gap
 * --------------------------------------------------------------------------- */

function buildActionsForGap(gap, ctx) {
  const {
    byId,
    opts,
    cuisineSelection,
    preferencesPack,
    feasibility,
    startISO,
    horizonDays,
    rulesApplied,
  } = ctx;

  const componentId = safeStr(gap.componentId);
  const component = componentId ? byId.get(toLower(componentId)) : null;

  const name = safeStr(
    gap.name || component?.name || componentId || "Unknown component"
  );
  const unit = normalizeUnit(gap.unit || component?.defaults?.unit || "each");
  const requiredQty = toNum(gap.requiredQty, 0);
  const gapQty = Math.max(0, toNum(gap.gapQty, 0));
  if (gapQty <= 0) return [];

  const category = safeStr(
    gap.category ||
      component?.defaults?.category ||
      component?.category ||
      inferCategoryFromTags(component, opts) ||
      "unknown"
  ).toLowerCase();
  const urgency = inferUrgency(gap, startISO);

  const share = requiredQty > 0 ? gapQty / requiredQty : 1;
  const isHuge = share >= opts.hugeGapShare;
  const isMajor = share >= opts.majorGapShare;

  const preferOrder =
    opts.categoryDefaultActions[category] ||
    opts.categoryDefaultActions.unknown;

  const out = [];
  const explainBase = [
    `Gap: ${fmtQty(gapQty)} ${unit} missing (${fmtQty(requiredQty)} required).`,
    `Category: ${category}. Urgency: ${urgency}.`,
    isHuge
      ? "Gap severity: huge."
      : isMajor
      ? "Gap severity: major."
      : "Gap severity: moderate.",
  ];

  // Decide "domain" based on tags
  const domainHint = inferDomain(component, opts);

  // Produce a limited set of actions per gap
  for (const type of preferOrder) {
    if (out.length >= opts.maxPerGap) break;
    if (!opts.enable[type]) continue;

    if (type === "plant" && domainHint !== "garden") continue;
    if (type === "breed" && domainHint !== "animals") continue;

    const card = buildActionCard(type, {
      gap,
      component,
      componentId,
      name,
      unit,
      gapQty,
      requiredQty,
      category,
      urgency,
      domainHint,
      isHuge,
      isMajor,
      cuisineSelection,
      preferencesPack,
      feasibility,
      startISO,
      horizonDays,
      opts,
      explainBase,
      rulesApplied,
    });

    if (card) out.push(card);
  }

  // If nothing produced (e.g., tags unknown), ensure at least a "buy" action
  if (!out.length && opts.enable.buy) {
    const buy = buildActionCard("buy", {
      gap,
      component,
      componentId,
      name,
      unit,
      gapQty,
      requiredQty,
      category,
      urgency,
      domainHint,
      isHuge,
      isMajor,
      cuisineSelection,
      preferencesPack,
      feasibility,
      startISO,
      horizonDays,
      opts,
      explainBase,
      rulesApplied,
    });
    if (buy) out.push(buy);
  }

  // Add substitution as fallback if preferences allow and gap is huge/major
  if (
    opts.enable.substitute &&
    (isMajor || isHuge) &&
    out.length < opts.maxPerGap
  ) {
    const sub = buildActionCard("substitute", {
      gap,
      component,
      componentId,
      name,
      unit,
      gapQty,
      requiredQty,
      category,
      urgency,
      domainHint,
      isHuge,
      isMajor,
      cuisineSelection,
      preferencesPack,
      feasibility,
      startISO,
      horizonDays,
      opts,
      explainBase,
      rulesApplied,
    });
    if (sub) out.push(sub);
  }

  return out;
}

function buildActionCard(type, ctx) {
  const {
    component,
    componentId,
    name,
    unit,
    gapQty,
    category,
    urgency,
    isHuge,
    isMajor,
    preferencesPack,
    feasibility,
    startISO,
    horizonDays,
    opts,
    explainBase,
    rulesApplied,
  } = ctx;

  const id = `${type}:${componentId || name}:${hashTiny(
    `${type}|${componentId}|${gapQty}|${unit}`
  )}`;
  const leadDays = toNum(opts.leadTimes[type], 1);
  const byISO =
    ctx.gap.byISO || addDaysISO(startISO, Math.min(horizonDays, leadDays));

  const effort = estimateEffort(type, gapQty, unit, opts);
  const costKind = opts.costHint[type] || "unknown";

  const avoidReason = violatesPreferences(component, preferencesPack);
  const prefFit = avoidReason ? 0.2 : 1.0;

  // If plan is already blocked, high-effort actions should be deprioritized unless "buy"/"substitute"
  const feasibilityPenalty =
    feasibility?.feasibilityStatus === "blocked" &&
    !["buy", "substitute"].includes(type)
      ? 0.75
      : 1.0;

  const base = {
    id,
    type,
    componentId: componentId || null,
    title: "",
    detail: "",
    qty: gapQty,
    unit,
    urgency,
    confidence: 0.7 * prefFit * feasibilityPenalty,
    effort,
    costHint: { kind: costKind, notes: "" },
    dependencies: [],
    links: {},
    tags: uniq([
      `cat:${category}`,
      `urg:${urgency}`,
      isHuge ? "gap:huge" : isMajor ? "gap:major" : "gap:moderate",
    ]),
    score: 0,
    explain: explainBase.slice(),
  };

  // Customize by action type
  if (type === "buy") {
    base.title = `Buy ${name}`;
    base.detail = `Acquire ${fmtQty(gapQty)} ${unit} by ${formatDateShort(
      byISO
    )} to close the gap.`;
    base.links = {
      to: "/shopping",
      payload: { componentId, name, qty: gapQty, unit, byISO, category },
    };
    base.costHint.notes = "Use Scan/Compare or bulk shopping if available.";
    base.explain.push("Action type: buy (fastest gap closure).");
    rulesApplied.push("Generated buy actions from gaps.");
    return base;
  }

  if (type === "plant") {
    base.title = `Plant to supply ${name}`;
    base.detail = `Convert gap into a planting target; expected lead time ~${leadDays} days.`;
    base.links = {
      to: "/homesteadplanner/garden-targets",
      payload: {
        componentId,
        name,
        qty: gapQty,
        unit,
        byISO,
        category,
        derivedFrom: "gap",
      },
    };
    base.costHint.notes = "Seed/starts + bed space required.";
    base.explain.push("Action type: plant (garden-derived supply).");
    base.dependencies.push({
      kind: "capacity",
      id: "garden_sqft",
      title: "Garden bed space",
    });
    rulesApplied.push("Generated plant actions for garden-tagged gaps.");
    return base;
  }

  if (type === "breed") {
    base.title = `Breed or source livestock for ${name}`;
    base.detail = `Convert protein gap into breeding/purchase targets; lead time ~${leadDays} days.`;
    base.links = {
      to: "/homesteadplanner/animal-targets",
      payload: {
        componentId,
        name,
        qty: gapQty,
        unit,
        byISO,
        category,
        derivedFrom: "gap",
      },
    };
    base.costHint.notes = "Consider coop/pen capacity + feed requirements.";
    base.explain.push("Action type: breed/source (animal-derived supply).");
    base.dependencies.push({
      kind: "capacity",
      id: "coop_capacity",
      title: "Animal housing capacity",
    });
    rulesApplied.push("Generated breed actions for animal-tagged gaps.");
    return base;
  }

  if (type === "process") {
    base.title = `Preserve/process ${name}`;
    base.detail = `Start a preservation batch to build shelf-stable stock and reduce future gaps.`;
    base.links = {
      to: "/homesteadplanner/batches",
      payload: {
        componentId,
        name,
        qty: gapQty,
        unit,
        byISO,
        category,
        derivedFrom: "gap",
      },
    };
    base.costHint.notes =
      "Requires jars/freezer/dehydrator depending on method.";
    base.explain.push(
      "Action type: process/preserve (turn supply into stable inventory)."
    );
    base.dependencies.push({
      kind: "tool",
      id: "canner_or_freezer_or_dehydrator",
      title: "Preservation equipment",
    });
    rulesApplied.push(
      "Generated process actions where preservation can reduce recurrence."
    );
    return base;
  }

  if (type === "substitute") {
    const subs = suggestSubstitutes(component, category, opts);
    if (!subs.length) return null;

    base.title = `Substitute for ${name}`;
    base.detail = `Swap some of this gap with: ${subs.slice(0, 3).join(", ")}.`;
    base.links = {
      to: "/homesteadplanner/components",
      payload: {
        componentId,
        name,
        substitutes: subs,
        category,
        derivedFrom: "gap",
      },
    };
    base.costHint.notes = "Keeps menu feasible while supply catches up.";
    base.explain.push("Action type: substitute (menu-level mitigation).");
    rulesApplied.push("Generated substitution actions for major gaps.");
    return base;
  }

  if (type === "schedule") {
    base.title = `Schedule work to close ${name} gap`;
    base.detail = `Add a focused session for this gap (shopping / batch / garden) before ${formatDateShort(
      byISO
    )}.`;
    base.qty = 1;
    base.unit = "session";
    base.effort = {
      minutes: opts.effort.schedule_base,
      difficulty: opts.difficulty.schedule,
    };
    base.links = {
      to: "/schedule",
      payload: {
        title: base.title,
        byISO,
        domain: inferScheduleDomain(ctx),
        componentId,
        qty: gapQty,
        unit,
        category,
      },
    };
    base.costHint.notes = "Turns action into calendar commitment.";
    base.explain.push("Action type: schedule (makes the plan real).");
    rulesApplied.push("Generated scheduling actions for high urgency gaps.");
    // only keep schedule for high urgency
    if (urgency !== "high") return null;
    return base;
  }

  return null;
}

/* -----------------------------------------------------------------------------
 * Scope reduction actions (when feasibility blocked)
 * --------------------------------------------------------------------------- */

function buildScopeReductionActions(feasibility, startISO, horizonDays) {
  const actions = [];
  const blockers = Array.isArray(feasibility.blockers)
    ? feasibility.blockers
    : [];

  actions.push({
    id: `scope:reduce:${hashTiny(JSON.stringify(blockers).slice(0, 80))}`,
    type: "research",
    componentId: null,
    title: "Reduce plan scope for this cycle",
    detail:
      "Feasibility is blocked. Reduce horizon, narrow cuisines, or defer preservation volume until constraints are resolved.",
    qty: 1,
    unit: "plan",
    urgency: "high",
    confidence: 0.9,
    effort: { minutes: 15, difficulty: 2 },
    costHint: { kind: "low", notes: "" },
    dependencies: [],
    links: { to: "/homesteadplanner/targets", payload: { focus: "scope" } },
    tags: ["scope", "feasibility:blocked"],
    score: 0,
    explain: [
      "FeasibilityChecker indicates 'blocked'.",
      `Top blockers: ${
        blockers
          .slice(0, 3)
          .map((b) => b.title)
          .join("; ") || "unknown"
      }.`,
      "Reducing scope is the fastest way to restore feasibility.",
    ],
  });

  actions.push({
    id: `scope:horizon:${hashTiny(startISO)}`,
    type: "schedule",
    componentId: null,
    title: "Shorten horizon to 14 days",
    detail:
      "Recompute targets for 14 days to reduce storage/time pressure and close gaps faster.",
    qty: 14,
    unit: "days",
    urgency: "high",
    confidence: 0.8,
    effort: { minutes: 8, difficulty: 2 },
    costHint: { kind: "low", notes: "" },
    dependencies: [],
    links: { to: "/homesteadplanner/targets", payload: { horizonDays: 14 } },
    tags: ["scope", "horizon"],
    score: 0,
    explain: ["Shorter horizons reduce gaps, time load, and storage pressure."],
  });

  return actions;
}

/* -----------------------------------------------------------------------------
 * Grouping + summarization
 * --------------------------------------------------------------------------- */

export function groupActions(actions) {
  const grouped = {
    shopping: [],
    garden: [],
    animals: [],
    preservation: [],
    substitutions: [],
    scheduling: [],
    other: [],
  };

  for (const a of actions || []) {
    if (a.type === "buy") grouped.shopping.push(a);
    else if (a.type === "plant") grouped.garden.push(a);
    else if (a.type === "breed") grouped.animals.push(a);
    else if (a.type === "process") grouped.preservation.push(a);
    else if (a.type === "substitute") grouped.substitutions.push(a);
    else if (a.type === "schedule") grouped.scheduling.push(a);
    else grouped.other.push(a);
  }

  return grouped;
}

export function summarize(output) {
  const o = output || {};
  const actions = Array.isArray(o.actions) ? o.actions : [];
  const grouped = o.grouped || groupActions(actions);

  const lines = [];
  lines.push(`Actions: ${actions.length}`);
  lines.push(
    `Shopping: ${grouped.shopping.length} • Garden: ${grouped.garden.length} • Animals: ${grouped.animals.length} • Preservation: ${grouped.preservation.length}`
  );
  lines.push(
    `Substitutions: ${grouped.substitutions.length} • Scheduling: ${grouped.scheduling.length}`
  );
  const top = actions.slice(0, 5).map((a) => `• ${a.title} (${a.urgency})`);
  if (top.length) lines.push(...top);
  return lines;
}

/* -----------------------------------------------------------------------------
 * Scoring
 * --------------------------------------------------------------------------- */

function scoreAction(action, ctx) {
  const { opts, feasibility } = ctx;
  const w = normalizeWeights(opts.weights);

  const urgencyScore =
    action.urgency === "high" ? 1 : action.urgency === "medium" ? 0.6 : 0.3;

  // size score uses qty log-ish
  const sizeScore = clampNum(
    Math.log10(1 + Math.max(0, toNum(action.qty, 0))) / 2,
    0,
    1
  );

  // feasibility score: if feasibility blocked, prioritize buy/substitute/schedule
  let feasibilityScore = 0.7;
  if (feasibility?.feasibilityStatus === "blocked") {
    feasibilityScore = ["buy", "substitute", "schedule"].includes(action.type)
      ? 1
      : 0.4;
  } else if (feasibility?.feasibilityStatus === "at_risk") {
    feasibilityScore = ["buy", "process", "schedule"].includes(action.type)
      ? 0.9
      : 0.7;
  }

  const preferenceFit = clampNum(toNum(action.confidence, 0.7), 0, 1);

  const effortPenalty = clampNum(toNum(action.effort?.minutes, 0) / 240, 0, 1); // 0..1 (4 hours)
  const score =
    100 *
    (w.urgency * urgencyScore +
      w.size * sizeScore +
      w.feasibility * feasibilityScore +
      w.preferenceFit * preferenceFit -
      w.effortPenalty * effortPenalty);

  return clampNum(score, 0, 100);
}

function normalizeWeights(w) {
  const ww = { ...DEFAULTS.weights, ...(w || {}) };
  const sum =
    toNum(ww.urgency, 0) +
    toNum(ww.size, 0) +
    toNum(ww.feasibility, 0) +
    toNum(ww.preferenceFit, 0) +
    toNum(ww.effortPenalty, 0);
  if (sum <= 0) return { ...DEFAULTS.weights };
  return {
    urgency: ww.urgency / sum,
    size: ww.size / sum,
    feasibility: ww.feasibility / sum,
    preferenceFit: ww.preferenceFit / sum,
    effortPenalty: ww.effortPenalty / sum,
  };
}

/* -----------------------------------------------------------------------------
 * Helpers: urgency, domains, substitutions, preferences
 * --------------------------------------------------------------------------- */

function inferUrgency(gap, startISO) {
  if (gap.urgency) return gap.urgency;
  const by = gap.byISO ? new Date(gap.byISO) : null;
  if (!by || Number.isNaN(by.getTime())) return "medium";
  const start = new Date(startISO);
  const days = (by.getTime() - start.getTime()) / 86400000;
  if (days <= 7) return "high";
  if (days <= 21) return "medium";
  return "low";
}

function inferDomain(component, opts) {
  const tags = normalizeStringArray(component?.tags).map(toLower);
  for (const t of tags) {
    const d = opts.tagDomainHints[t];
    if (d) return d;
  }
  return "storehouse";
}

function inferCategoryFromTags(component, opts) {
  const tags = normalizeStringArray(component?.tags).map(toLower);
  if (
    tags.some((t) =>
      [
        "grain",
        "starch",
        "bread",
        "rice",
        "pasta",
        "flour",
        "bean",
        "legume",
      ].includes(t)
    )
  )
    return "staples";
  if (tags.some((t) => ["meat", "poultry", "fish", "eggs"].includes(t)))
    return "protein";
  if (tags.some((t) => ["vegetable", "fruit", "produce", "herb"].includes(t)))
    return "produce";
  if (tags.some((t) => ["oil", "fat", "butter"].includes(t))) return "fat";
  if (tags.some((t) => ["dairy", "milk", "cheese"].includes(t))) return "dairy";
  if (tags.some((t) => ["beverage", "tea", "coffee", "juice"].includes(t)))
    return "beverage";
  return "unknown";
}

function suggestSubstitutes(component, category, opts) {
  const tags = normalizeStringArray(component?.tags).map(toLower);
  const name = toLower(component?.name || "");

  // 1) Use substitution map by name tag hints
  for (const key of Object.keys(opts.substitution || {})) {
    if (tags.includes(key) || name.includes(key)) {
      return opts.substitution[key].slice();
    }
  }

  // 2) Category fallback substitutes
  if (category === "staples") return ["rice", "pasta", "oats", "cornmeal"];
  if (category === "protein") return ["eggs", "beans", "fish", "poultry"];
  if (category === "produce")
    return ["frozen vegetables", "canned vegetables", "root vegetables"];
  if (category === "dairy") return ["shelf-stable milk", "powdered milk"];
  return [];
}

function violatesPreferences(component, preferencesPack) {
  if (!component || !preferencesPack) return "";
  const forbidden = normalizeStringArray(
    preferencesPack.constraints?.forbiddenTags ||
      preferencesPack.resolved?.constraints?.forbiddenTags
  ).map(toLower);
  const dislikes = normalizeStringArray(
    preferencesPack.dislikes ||
      preferencesPack.scoring?.dislikedIngredients ||
      []
  ).map(toLower);
  const avoid = new Set([...forbidden, ...dislikes].filter(Boolean));
  if (!avoid.size) return "";

  const tags = normalizeStringArray(component.tags).map(toLower);
  for (const t of tags) {
    if (avoid.has(t)) return `Avoid tag "${t}".`;
  }
  return "";
}

function inferScheduleDomain(ctx) {
  // Prefer garden/animals/preservation based on action type potential
  if (ctx.domainHint === "garden") return "garden_care";
  if (ctx.domainHint === "animals") return "animals_care";
  if (ctx.type === "process") return "preservation";
  return "storehouse";
}

/* -----------------------------------------------------------------------------
 * Effort estimates
 * --------------------------------------------------------------------------- */

function estimateEffort(type, qty, unit, opts) {
  const q = Math.max(0, toNum(qty, 0));
  let minutes = 0;

  if (type === "buy") minutes = q * opts.effort.buy_per_unit;
  else if (type === "plant") minutes = q * opts.effort.plant_per_unit;
  else if (type === "breed") minutes = q * opts.effort.breed_per_unit;
  else if (type === "process") minutes = q * opts.effort.process_per_unit;
  else if (type === "substitute") minutes = q * opts.effort.substitute_per_unit;
  else if (type === "schedule") minutes = opts.effort.schedule_base;
  else minutes = 10;

  // Clamp and round
  minutes = clampNum(minutes, 2, 600);
  return {
    minutes: Math.round(minutes),
    difficulty: opts.difficulty[type] || 2,
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

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = safeStr(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function fmtQty(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return String(q);
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, "");
  return n.toFixed(2).replace(/\.00$/, "").replace(/0$/, "");
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function toLower(s) {
  return (typeof s === "string" ? s : s == null ? "" : String(s))
    .trim()
    .toLowerCase();
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeUnit(u) {
  const s = safeStr(u).toLowerCase();
  if (!s) return "each";
  if (["ea", "unit", "item", "piece", "pc", "count"].includes(s)) return "each";
  return s;
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
  // Locale-safe short date
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Tiny stable hash (non-crypto) for ids
function hashTiny(str) {
  const s = safeStr(str);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
