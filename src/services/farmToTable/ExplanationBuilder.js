// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\ExplanationBuilder.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead ExplanationBuilder
 * -----------------------------------------------------------------------------
 * Produces consistent, human-readable "why" explanations + structured reasoning
 * traces across the Farm-to-Table pipeline:
 *   - ProvisioningTargetEngine
 *   - ComponentDemandBuilder
 *   - ConversionEngine
 *   - FeasibilityChecker
 *   - GapActionRecommender
 *   - GardenTargetBuilder
 *   - AnimalTargetBuilder
 *   - TimelinePlanner
 *
 * Goals
 *  - Make every plan/target/action/timeline item explainable in the UI.
 *  - Provide both:
 *      (1) Render-ready text blocks (headlines, bullets)
 *      (2) A structured trace object for debugging / auditing
 *  - Never throw in production. Degrades gracefully.
 *
 * Deterministic. No AI.
 *
 * -----------------------------------------------------------------------------
 * Public API
 * -----------------------------------------------------------------------------
 * buildPlanExplanation({
 *   planName, // optional
 *   startISO,
 *   horizonDays,
 *   outputs: { ...engineOutputs },
 *   selections: { cuisines?, prefs?, household? },
 *   options
 * })
 *
 * buildItemExplanation({
 *   kind: "gap"|"target"|"action"|"gardenTarget"|"animalTarget"|"timelineItem"|"session",
 *   item,
 *   context: { startISO, horizonDays, outputs? }
 * })
 *
 * toDisplayBlocks(explanation) -> [{ title, bullets[], meta? }]
 *
 * -----------------------------------------------------------------------------
 * Output format
 * -----------------------------------------------------------------------------
 * Explanation = {
 *   id,
 *   title,
 *   subtitle?,
 *   severity?: "info"|"warning"|"blocked",
 *   bullets: string[],
 *   facts: [{ label, value, unit? }],
 *   assumptions: string[],
 *   rulesApplied: string[],
 *   sources: [{ name, id?, note? }],
 *   links?: { to, payload },
 *   trace: {
 *     inputSummary?: object,
 *     derived?: object,
 *     math?: object,
 *     debug?: object
 *   }
 * }
 */

const SOURCE = "services/farmToTable/ExplanationBuilder";

const DEFAULTS = {
  maxBullets: 16,
  maxAssumptions: 12,
  maxRules: 12,
  maxFacts: 18,
  // If true, include more computed details in trace (UI should hide by default)
  includeDebugTrace: true,

  // Severity thresholds
  severity: {
    blockersAs: "blocked",
    risksAs: "warning",
    defaultAs: "info",
  },

  // Friendly label maps
  labels: {
    domains: {
      storehouse: "Storehouse",
      garden: "Garden",
      animals: "Animals",
      preservation: "Preservation",
      cooking: "Cooking",
      shopping: "Shopping",
      planning: "Planning",
      hygiene: "Hygiene",
      cleaning: "Cleaning",
    },
    actionTypes: {
      buy: "Buy",
      plant: "Plant",
      breed: "Breed",
      process: "Preserve/Process",
      substitute: "Substitute",
      schedule: "Schedule",
      research: "Research",
    },
    supplyKinds: {
      eggs: "Eggs",
      meat: "Meat",
      milk: "Milk",
      other: "Other",
    },
  },
};

export const ExplanationBuilder = {
  buildPlanExplanation,
  buildItemExplanation,
  toDisplayBlocks,

  // helper exports (useful in UI)
  formatIssueSummary,
  formatQty,
};

/* -----------------------------------------------------------------------------
 * Plan explanation (roll-up)
 * --------------------------------------------------------------------------- */

export function buildPlanExplanation(input = {}) {
  const opts = mergeOptions(input.options);
  const startISO = input.startISO || new Date().toISOString();
  const horizonDays = Number.isFinite(input.horizonDays)
    ? input.horizonDays
    : input.outputs?.targetsOutput?.meta?.horizonDays || 28;
  const planName = safeStr(input.planName || "Homestead Plan");

  const outputs = input.outputs || {};
  const selections = input.selections || {};

  const rulesApplied = uniq([
    ...(outputs.targetsOutput?.trace?.rulesApplied || []),
    ...(outputs.demandPlan?.trace?.rulesApplied || []),
    ...(outputs.conversionOutput?.trace?.rulesApplied || []),
    ...(outputs.feasibilityReport?.trace?.rulesApplied || []),
    ...(outputs.gapActionsOutput?.trace?.rulesApplied || []),
    ...(outputs.gardenTargetsOutput?.trace?.rulesApplied || []),
    ...(outputs.animalTargetsOutput?.trace?.rulesApplied || []),
    ...(outputs.timelineOutput?.trace?.rulesApplied || []),
  ]);

  const issues = collectPlanIssues(outputs);
  const severity = inferSeverityFromIssues(issues, opts);

  const bullets = [];
  const facts = [];

  // What is planned
  const provCount = (outputs.targetsOutput?.provisioning || []).length;
  const gapCount = (
    outputs.demandPlan?.gaps ||
    outputs.targetsOutput?.gaps ||
    []
  ).length;
  const actionCount = (outputs.gapActionsOutput?.actions || []).length;
  const gardenCount = (outputs.gardenTargetsOutput?.targets || []).length;
  const animalCount = (outputs.animalTargetsOutput?.targets || []).length;
  const timelineCount = (outputs.timelineOutput?.timeline?.items || []).length;

  bullets.push(
    `Time horizon: ${horizonDays} days starting ${formatDateShort(startISO)}.`
  );
  if (selections?.cuisines?.selected && selections.cuisines.selected.length) {
    bullets.push(
      `Cuisine rotation: ${selections.cuisines.selected
        .map((c) => safeStr(c.name || c.id || c))
        .filter(Boolean)
        .join(", ")}.`
    );
  }
  if (selections?.prefs?.summary) {
    bullets.push(`Preferences applied: ${safeStr(selections.prefs.summary)}.`);
  }

  bullets.push(`Provisioning targets: ${provCount}.`);
  bullets.push(`Gaps detected: ${gapCount}.`);
  bullets.push(`Recommended actions: ${actionCount}.`);
  bullets.push(`Garden targets: ${gardenCount}.`);
  bullets.push(`Animal targets: ${animalCount}.`);
  if (timelineCount)
    bullets.push(`Timeline items scheduled: ${timelineCount}.`);

  // Key constraints
  if (issues.blockers.length)
    bullets.push(
      `Blockers: ${issues.blockers.length} (must resolve to make plan feasible).`
    );
  if (issues.risks.length)
    bullets.push(`Risks: ${issues.risks.length} (monitor/mitigate).`);

  // Useful facts summary
  const feas = outputs.feasibilityReport || null;
  if (feas) {
    facts.push({
      label: "Feasibility",
      value: safeStr(feas.feasibilityStatus || "unknown"),
    });
    if (Number.isFinite(feas.readinessScore))
      facts.push({
        label: "Readiness score",
        value: `${Math.round(feas.readinessScore)} / 100`,
      });
  }

  const tOut = outputs.timelineOutput || null;
  if (tOut?.next?.dueISO)
    facts.push({ label: "Next due", value: formatDateShort(tOut.next.dueISO) });
  if (tOut?.next?.items?.length)
    facts.push({ label: "Next items", value: `${tOut.next.items.length}` });
  if (tOut?.next?.sessions?.length)
    facts.push({
      label: "Next sessions",
      value: `${tOut.next.sessions.length}`,
    });

  const assumptions = uniq([
    ...(outputs.targetsOutput?.trace?.notes || []),
    ...(outputs.demandPlan?.trace?.notes || []),
    ...(outputs.conversionOutput?.trace?.notes || []),
    ...(outputs.feasibilityReport?.trace?.notes || []),
    ...(outputs.gapActionsOutput?.trace?.notes || []),
    ...(outputs.gardenTargetsOutput?.trace?.notes || []),
    ...(outputs.animalTargetsOutput?.trace?.notes || []),
    ...(outputs.timelineOutput?.trace?.notes || []),
  ])
    .map(cleanNote)
    .filter(Boolean)
    .slice(0, opts.maxAssumptions);

  const sources = buildPlanSources(outputs);

  const trace = {
    inputSummary: {
      startISO,
      horizonDays,
      cuisineCount: selections?.cuisines?.selected?.length || 0,
      hasPreferences: !!selections?.prefs,
    },
    derived: {
      counts: {
        provCount,
        gapCount,
        actionCount,
        gardenCount,
        animalCount,
        timelineCount,
      },
      issueCounts: {
        blockers: issues.blockers.length,
        risks: issues.risks.length,
      },
      feasibility: feas?.feasibilityStatus || null,
    },
    debug: opts.includeDebugTrace
      ? {
          issues,
          rulesApplied,
        }
      : undefined,
  };

  return clampExplanation(
    {
      id: `explain:plan:${hashTiny(`${planName}|${startISO}|${horizonDays}`)}`,
      title: planName,
      subtitle: `Why this plan looks the way it does`,
      severity,
      bullets,
      facts,
      assumptions,
      rulesApplied,
      sources,
      links: {
        to: "/homesteadplanner/targets",
        payload: { focus: "overview" },
      },
      trace,
    },
    opts
  );
}

/* -----------------------------------------------------------------------------
 * Item explanation (single object)
 * --------------------------------------------------------------------------- */

export function buildItemExplanation(input = {}) {
  const opts = mergeOptions(input.options);
  const kind = safeStr(input.kind);
  const item = input.item || {};
  const ctx = input.context || {};
  const startISO = ctx.startISO || new Date().toISOString();
  const horizonDays = Number.isFinite(ctx.horizonDays) ? ctx.horizonDays : 28;
  const outputs = ctx.outputs || {};

  if (!kind) {
    return clampExplanation(
      {
        id: `explain:item:unknown:${hashTiny(JSON.stringify(item || {}))}`,
        title: "Explanation unavailable",
        severity: "info",
        bullets: ["Missing explanation kind."],
        facts: [],
        assumptions: [],
        rulesApplied: [],
        sources: [{ name: "ExplanationBuilder", note: "No kind provided" }],
        trace: {
          debug: opts.includeDebugTrace
            ? { item, ctx: { startISO, horizonDays } }
            : undefined,
        },
      },
      opts
    );
  }

  switch (kind) {
    case "gap":
      return explainGap(item, { startISO, horizonDays, outputs }, opts);
    case "target":
      return explainTarget(item, { startISO, horizonDays, outputs }, opts);
    case "action":
      return explainAction(item, { startISO, horizonDays, outputs }, opts);
    case "gardenTarget":
      return explainGardenTarget(
        item,
        { startISO, horizonDays, outputs },
        opts
      );
    case "animalTarget":
      return explainAnimalTarget(
        item,
        { startISO, horizonDays, outputs },
        opts
      );
    case "timelineItem":
      return explainTimelineItem(
        item,
        { startISO, horizonDays, outputs },
        opts
      );
    case "session":
      return explainSession(item, { startISO, horizonDays, outputs }, opts);
    default:
      return clampExplanation(
        {
          id: `explain:item:${kind}:${hashTiny(JSON.stringify(item || {}))}`,
          title: `Explanation: ${kind}`,
          severity: "info",
          bullets: ["No specialized explainer found; showing generic details."],
          facts: objectFacts(item, opts.maxFacts),
          assumptions: [],
          rulesApplied: [],
          sources: [{ name: "ExplanationBuilder", note: "Generic" }],
          trace: { debug: opts.includeDebugTrace ? { item } : undefined },
        },
        opts
      );
  }
}

/* -----------------------------------------------------------------------------
 * Specific explainers
 * --------------------------------------------------------------------------- */

function explainGap(gap, ctx, opts) {
  const componentName = safeStr(
    gap.componentName || gap.name || gap.componentId || "Component"
  );
  const gapQty = toNum(gap.gapQty, toNum(gap.qty, 0));
  const unit = safeStr(gap.unit || "each");

  const title = `Gap: ${componentName}`;
  const bullets = [
    `You are short by ${formatQty(gapQty)} ${unit} for this planning horizon.`,
    `This gap was computed as (required − available) after applying conversions, preferences, and feasibility constraints (if present).`,
  ];

  const facts = [
    { label: "Gap", value: formatQty(gapQty), unit },
    ...(Number.isFinite(gap.requiredQty)
      ? [{ label: "Required", value: formatQty(gap.requiredQty), unit }]
      : []),
    ...(Number.isFinite(gap.availableQty)
      ? [{ label: "Available", value: formatQty(gap.availableQty), unit }]
      : []),
  ];

  const assumptions = normalizeStringArray(gap.assumptions).slice(
    0,
    opts.maxAssumptions
  );
  const rulesApplied = uniq([
    ...(ctx.outputs?.demandPlan?.trace?.rulesApplied || []),
    ...(ctx.outputs?.targetsOutput?.trace?.rulesApplied || []),
  ]).slice(0, opts.maxRules);

  const sources = [
    {
      name: "ComponentDemandBuilder",
      id: ctx.outputs?.demandPlan?.meta?.source || null,
      note: "Gap computation",
    },
    {
      name: "ProvisioningTargetEngine",
      id: ctx.outputs?.targetsOutput?.meta?.source || null,
      note: "Targets/availability",
    },
  ].filter((s) => s.name);

  return clampExplanation(
    {
      id: safeStr(gap.id)
        ? `explain:gap:${safeStr(gap.id)}`
        : `explain:gap:${hashTiny(`${componentName}|${gapQty}|${unit}`)}`,
      title,
      subtitle: "Why this is a gap",
      severity: gapQty > 0 ? "warning" : "info",
      bullets,
      facts,
      assumptions,
      rulesApplied,
      sources,
      links: gap.links || {
        to: "/homesteadplanner/targets",
        payload: { componentId: gap.componentId },
      },
      trace: {
        derived: { componentName, gapQty, unit },
        math: {
          requiredQty: gap.requiredQty,
          availableQty: gap.availableQty,
          formula: "gap = max(0, required - available)",
        },
        debug: opts.includeDebugTrace ? { gap, ctx } : undefined,
      },
    },
    opts
  );
}

function explainTarget(target, ctx, opts) {
  const componentName = safeStr(
    target.componentName || target.name || target.componentId || "Component"
  );
  const qty = toNum(target.qty, 0);
  const unit = safeStr(target.unit || "each");
  const byISO = target.byISO || null;

  const bullets = [
    `Target quantity is ${formatQty(qty)} ${unit}${
      byISO ? ` by ${formatDateShort(byISO)}` : ""
    }.`,
    `Targets come from household horizon needs and menu/cuisine preferences (when configured).`,
  ];

  const facts = [
    { label: "Target", value: formatQty(qty), unit },
    ...(byISO ? [{ label: "By date", value: formatDateShort(byISO) }] : []),
    ...(target.category
      ? [{ label: "Category", value: safeStr(target.category) }]
      : []),
  ];

  const assumptions = normalizeStringArray(target.assumptions).slice(
    0,
    opts.maxAssumptions
  );
  const rulesApplied = uniq([
    ...(ctx.outputs?.targetsOutput?.trace?.rulesApplied || []),
  ]).slice(0, opts.maxRules);

  const sources = [
    {
      name: "ProvisioningTargetEngine",
      id: ctx.outputs?.targetsOutput?.meta?.source || null,
      note: "Target generation",
    },
  ];

  return clampExplanation(
    {
      id: safeStr(target.id)
        ? `explain:target:${safeStr(target.id)}`
        : `explain:target:${hashTiny(
            `${componentName}|${qty}|${unit}|${byISO || ""}`
          )}`,
      title: `Target: ${componentName}`,
      subtitle: "Why this target exists",
      severity: "info",
      bullets,
      facts,
      assumptions,
      rulesApplied,
      sources,
      links: target.links || {
        to: "/homesteadplanner/targets",
        payload: { componentId: target.componentId },
      },
      trace: {
        derived: { componentName, qty, unit, byISO },
        debug: opts.includeDebugTrace ? { target, ctx } : undefined,
      },
    },
    opts
  );
}

function explainAction(action, ctx, opts) {
  const type = safeStr(action.type || "action");
  const label = DEFAULTS.labels.actionTypes[type] || capitalize(type);
  const title = `${label}: ${safeStr(
    action.title || action.componentName || action.componentId || ""
  )}`.trim();

  const qty = Number.isFinite(action.qty) ? action.qty : null;
  const unit = safeStr(action.unit || "");
  const byISO = action.links?.payload?.byISO || action.byISO || null;

  const bullets = [];
  if (action.detail) bullets.push(safeStr(action.detail));
  bullets.push(
    `This action was recommended to close a gap or reach a target within the current horizon.`
  );
  if (byISO)
    bullets.push(`Recommended completion by ${formatDateShort(byISO)}.`);

  const facts = [
    { label: "Type", value: label },
    ...(qty != null
      ? [{ label: "Qty", value: formatQty(qty), unit: unit || undefined }]
      : []),
    ...(action.urgency
      ? [{ label: "Urgency", value: safeStr(action.urgency) }]
      : []),
    ...(Number.isFinite(action.confidence)
      ? [
          {
            label: "Confidence",
            value: `${Math.round(action.confidence * 100)}%`,
          },
        ]
      : []),
  ];

  const assumptions = normalizeStringArray(action.assumptions).slice(
    0,
    opts.maxAssumptions
  );
  const rulesApplied = uniq([
    ...(ctx.outputs?.gapActionsOutput?.trace?.rulesApplied || []),
  ]).slice(0, opts.maxRules);
  const sources = [
    {
      name: "GapActionRecommender",
      id: ctx.outputs?.gapActionsOutput?.meta?.source || null,
      note: "Action generation",
    },
  ];

  const severity =
    action.type === "schedule"
      ? "info"
      : action.urgency === "high"
      ? "warning"
      : "info";

  return clampExplanation(
    {
      id: safeStr(action.id)
        ? `explain:action:${safeStr(action.id)}`
        : `explain:action:${hashTiny(
            `${type}|${title}|${qty}|${unit}|${byISO || ""}`
          )}`,
      title: title || `Action: ${label}`,
      subtitle: "Why this action is recommended",
      severity,
      bullets,
      facts,
      assumptions,
      rulesApplied,
      sources,
      links: action.links || {
        to: "/homesteadplanner/targets",
        payload: { componentId: action.componentId },
      },
      trace: {
        derived: { type, title, qty, unit, byISO },
        debug: opts.includeDebugTrace ? { action, ctx } : undefined,
      },
    },
    opts
  );
}

function explainGardenTarget(t, ctx, opts) {
  const cropName = safeStr(t.cropName || t.cropId || "Crop");
  const componentName = safeStr(
    t.componentName || t.componentId || "Component"
  );
  const timing = t.timing || {};
  const plant = t.planting || {};

  const bullets = [
    `This garden target supports provisioning for "${componentName}".`,
    `Planting window: ${formatDateShort(
      timing.idealStartISO || ctx.startISO
    )} → ${formatDateShort(
      timing.latestStartISO || timing.idealStartISO || ctx.startISO
    )}.`,
    `Planned area: ${formatQty(plant.sqft)} sqft • Plants: ${formatQty(
      plant.plants
    )} • Seeds: ${formatQty(plant.seeds)}.`,
  ];

  if (timing.withinSeason === false)
    bullets.push(
      "Season warning: this may be out-of-season for your configured window—consider swapping crops or shifting timing."
    );

  const facts = [
    { label: "Crop", value: cropName },
    ...(plant.sqft != null
      ? [{ label: "Area", value: formatQty(plant.sqft), unit: "sqft" }]
      : []),
    ...(plant.plants != null
      ? [{ label: "Plants", value: formatQty(plant.plants) }]
      : []),
    ...(plant.seeds != null
      ? [{ label: "Seeds", value: formatQty(plant.seeds) }]
      : []),
    ...(Number.isFinite(t.confidence)
      ? [{ label: "Confidence", value: `${Math.round(t.confidence * 100)}%` }]
      : []),
  ];

  const assumptions = uniq([
    ...(t.assumptions || []),
    ...(t.capacity?.assumptions || []),
  ]).slice(0, opts.maxAssumptions);
  const rulesApplied = uniq([
    ...(ctx.outputs?.gardenTargetsOutput?.trace?.rulesApplied || []),
  ]).slice(0, opts.maxRules);
  const sources = [
    {
      name: "GardenTargetBuilder",
      id: ctx.outputs?.gardenTargetsOutput?.meta?.source || null,
      note: "Garden target generation",
    },
  ];

  return clampExplanation(
    {
      id: safeStr(t.id)
        ? `explain:garden:${safeStr(t.id)}`
        : `explain:garden:${hashTiny(
            `${cropName}|${componentName}|${timing.idealStartISO || ""}`
          )}`,
      title: `Garden target: ${cropName}`,
      subtitle: `Derived from ${componentName}`,
      severity: timing.withinSeason === false ? "warning" : "info",
      bullets,
      facts,
      assumptions,
      rulesApplied,
      sources,
      links: t.links || {
        to: "/homesteadplanner/garden-targets",
        payload: { componentId: t.componentId, cropId: t.cropId },
      },
      trace: {
        derived: { cropName, componentName, timing, planting: plant },
        debug: opts.includeDebugTrace ? { target: t, ctx } : undefined,
      },
    },
    opts
  );
}

function explainAnimalTarget(t, ctx, opts) {
  const animalName = safeStr(t.animalName || t.animalId || "Animals");
  const componentName = safeStr(
    t.componentName || t.componentId || "Component"
  );
  const plan = t.plan || {};
  const cap = t.capacity || {};
  const supply = t.supply || {};

  const bullets = [
    `This animal plan supports provisioning for "${componentName}".`,
    `Strategy: ${safeStr(plan.mode || "unknown")} • Headcount: ${formatQty(
      plan.headcount
    )} (♀ ${formatQty(plan.females)} / ♂ ${formatQty(plan.males)}).`,
    `First expected yield: ${formatDateShort(
      plan.firstYieldISO || ctx.startISO
    )}.`,
  ];

  if (supply.kind)
    bullets.push(
      `Supply type: ${
        DEFAULTS.labels.supplyKinds[supply.kind] || supply.kind
      } • Planned total: ${formatQty(supply.totalQty)} ${safeStr(
        supply.unit || ""
      )}.`
    );

  const facts = [
    { label: "Animal", value: animalName },
    ...(plan.headcount != null
      ? [{ label: "Headcount", value: formatQty(plan.headcount) }]
      : []),
    ...(cap.coopSlotsNeeded != null
      ? [{ label: "Coop slots", value: formatQty(cap.coopSlotsNeeded) }]
      : []),
    ...(cap.pastureSqftNeeded != null && cap.pastureSqftNeeded > 0
      ? [
          {
            label: "Pasture",
            value: formatQty(cap.pastureSqftNeeded),
            unit: "sqft",
          },
        ]
      : []),
    ...(cap.feedKgPerWeek != null
      ? [
          {
            label: "Feed / week",
            value: formatQty(cap.feedKgPerWeek),
            unit: "kg",
          },
        ]
      : []),
    ...(cap.freezerLitersNeeded != null && cap.freezerLitersNeeded > 0
      ? [
          {
            label: "Freezer",
            value: formatQty(cap.freezerLitersNeeded),
            unit: "L",
          },
        ]
      : []),
    ...(Number.isFinite(t.confidence)
      ? [{ label: "Confidence", value: `${Math.round(t.confidence * 100)}%` }]
      : []),
  ];

  const assumptions = uniq([
    ...(t.assumptions || []),
    ...(plan.assumptions || []),
    ...(cap.assumptions || []),
  ]).slice(0, opts.maxAssumptions);
  const rulesApplied = uniq([
    ...(ctx.outputs?.animalTargetsOutput?.trace?.rulesApplied || []),
  ]).slice(0, opts.maxRules);
  const sources = [
    {
      name: "AnimalTargetBuilder",
      id: ctx.outputs?.animalTargetsOutput?.meta?.source || null,
      note: "Animal target generation",
    },
  ];

  return clampExplanation(
    {
      id: safeStr(t.id)
        ? `explain:animal:${safeStr(t.id)}`
        : `explain:animal:${hashTiny(
            `${animalName}|${componentName}|${plan.mode}|${plan.headcount}`
          )}`,
      title: `Animal target: ${animalName}`,
      subtitle: `Derived from ${componentName}`,
      severity: "info",
      bullets,
      facts,
      assumptions,
      rulesApplied,
      sources,
      links: t.links || {
        to: "/homesteadplanner/animal-targets",
        payload: { componentId: t.componentId, animalId: t.animalId },
      },
      trace: {
        derived: { animalName, componentName, supply, plan, capacity: cap },
        debug: opts.includeDebugTrace ? { target: t, ctx } : undefined,
      },
    },
    opts
  );
}

function explainTimelineItem(it, ctx, opts) {
  const title = safeStr(it.title || "Timeline item");
  const domainLabel =
    DEFAULTS.labels.domains[safeStr(it.domain)] ||
    safeStr(it.domain || "Planning");
  const kind = safeStr(it.kind || "task");

  const bullets = [
    `Scheduled date: ${formatDateShort(it.dateISO || ctx.startISO)}${
      it.endISO ? ` → ${formatDateShort(it.endISO)}` : ""
    }.`,
    `Domain: ${domainLabel} • Type: ${capitalize(kind)}.`,
  ];
  if (it.detail) bullets.push(safeStr(it.detail));
  if (Array.isArray(it.explain) && it.explain.length)
    bullets.push(
      ...it.explain
        .slice(0, 3)
        .map((x) => safeStr(x))
        .filter(Boolean)
    );

  const facts = [
    {
      label: "Priority",
      value: `${clampInt(toNum(it.priority, 3), 1, 5)} / 5`,
    },
    {
      label: "Confidence",
      value: `${Math.round(clampNum(toNum(it.confidence, 0.7), 0, 1) * 100)}%`,
    },
    ...(it.tags && it.tags.length
      ? [{ label: "Tags", value: it.tags.join(", ") }]
      : []),
  ].slice(0, opts.maxFacts);

  const assumptions = [];
  const rulesApplied = uniq([
    ...(ctx.outputs?.timelineOutput?.trace?.rulesApplied || []),
  ]).slice(0, opts.maxRules);
  const sources = [
    {
      name: "TimelinePlanner",
      id: ctx.outputs?.timelineOutput?.meta?.source || null,
      note: "Timeline scheduling",
    },
  ];

  return clampExplanation(
    {
      id: safeStr(it.id)
        ? `explain:timeline:${safeStr(it.id)}`
        : `explain:timeline:${hashTiny(
            `${title}|${it.dateISO}|${it.domain}|${it.kind}`
          )}`,
      title: `${title}`,
      subtitle: `Scheduled in ${domainLabel}`,
      severity:
        kind === "window" ? "info" : it.priority >= 4 ? "warning" : "info",
      bullets,
      facts,
      assumptions,
      rulesApplied,
      sources,
      links: it.links || { to: "/homesteadplanner/targets", payload: {} },
      trace: {
        derived: {
          title,
          domain: it.domain,
          kind,
          dateISO: it.dateISO,
          endISO: it.endISO,
        },
        debug: opts.includeDebugTrace ? { item: it, ctx } : undefined,
      },
    },
    opts
  );
}

function explainSession(s, ctx, opts) {
  const title = safeStr(s.title || "Session");
  const domainKey = safeStr(s.domainKey || "storehouse");
  const start = s.startISO || ctx.startISO;

  const bullets = [
    `Recommended start: ${formatDateShort(start)} • Duration: ${Math.round(
      toNum(s.durationMin, 45)
    )} minutes.`,
    `Domain: ${domainKey}.`,
  ];

  if (Array.isArray(s.explain) && s.explain.length)
    bullets.push(...s.explain.slice(0, 4).map(cleanNote).filter(Boolean));

  const facts = [
    { label: "Priority", value: `${clampInt(toNum(s.priority, 3), 1, 5)} / 5` },
    {
      label: "Confidence",
      value: `${Math.round(clampNum(toNum(s.confidence, 0.7), 0, 1) * 100)}%`,
    },
    ...(s.tags && s.tags.length
      ? [{ label: "Tags", value: s.tags.join(", ") }]
      : []),
    ...(s.steps && s.steps.length
      ? [{ label: "Steps", value: `${s.steps.length}` }]
      : []),
  ].slice(0, opts.maxFacts);

  const assumptions = [];
  const rulesApplied = uniq([
    ...(ctx.outputs?.timelineOutput?.trace?.rulesApplied || []),
  ]).slice(0, opts.maxRules);
  const sources = [
    {
      name: "TimelinePlanner",
      id: ctx.outputs?.timelineOutput?.meta?.source || null,
      note: "Session suggestion",
    },
  ];

  return clampExplanation(
    {
      id: safeStr(s.id)
        ? `explain:session:${safeStr(s.id)}`
        : `explain:session:${hashTiny(`${title}|${start}|${domainKey}`)}`,
      title,
      subtitle: "Why this session is recommended",
      severity: s.priority >= 4 ? "warning" : "info",
      bullets,
      facts,
      assumptions,
      rulesApplied,
      sources,
      links: s.links || { to: "/play", payload: { domainKey, title } },
      trace: {
        derived: {
          title,
          domainKey,
          startISO: start,
          durationMin: s.durationMin,
          stepCount: s.steps?.length || 0,
        },
        debug: opts.includeDebugTrace ? { session: s, ctx } : undefined,
      },
    },
    opts
  );
}

/* -----------------------------------------------------------------------------
 * Display helpers
 * --------------------------------------------------------------------------- */

export function toDisplayBlocks(explanation) {
  const e = explanation || {};
  const blocks = [];

  blocks.push({
    title: safeStr(e.title || "Explanation"),
    bullets: uniq([safeStr(e.subtitle), ...(e.bullets || [])])
      .filter(Boolean)
      .slice(0, 10),
    meta: { severity: e.severity || "info" },
  });

  if (Array.isArray(e.facts) && e.facts.length) {
    blocks.push({
      title: "Key facts",
      bullets: e.facts
        .slice(0, 12)
        .map(
          (f) =>
            `${safeStr(f.label)}: ${safeStr(f.value)}${
              f.unit ? ` ${safeStr(f.unit)}` : ""
            }`
        ),
    });
  }

  if (Array.isArray(e.assumptions) && e.assumptions.length) {
    blocks.push({
      title: "Assumptions",
      bullets: e.assumptions
        .slice(0, 10)
        .map((x) => `• ${cleanNote(x)}`)
        .filter(Boolean),
    });
  }

  if (Array.isArray(e.rulesApplied) && e.rulesApplied.length) {
    blocks.push({
      title: "Rules applied",
      bullets: e.rulesApplied
        .slice(0, 10)
        .map((x) => `• ${cleanNote(x)}`)
        .filter(Boolean),
    });
  }

  return blocks;
}

export function formatIssueSummary(issues) {
  const blockers = issues?.blockers || [];
  const risks = issues?.risks || [];
  const parts = [];
  if (blockers.length) parts.push(`Blockers: ${blockers.length}`);
  if (risks.length) parts.push(`Risks: ${risks.length}`);
  return parts.join(" • ") || "No issues";
}

/* -----------------------------------------------------------------------------
 * Internal: issue collection + severity
 * --------------------------------------------------------------------------- */

function collectPlanIssues(outputs) {
  const blockers = [];
  const risks = [];

  const collect = (obj) => {
    if (!obj) return;
    const b = obj.issues?.blockers || obj.blockers || [];
    const r = obj.issues?.risks || obj.risks || [];
    if (Array.isArray(b)) blockers.push(...b.map((x) => ({ ...x })));
    if (Array.isArray(r)) risks.push(...r.map((x) => ({ ...x })));
  };

  collect(outputs.targetsOutput);
  collect(outputs.demandPlan);
  collect(outputs.conversionOutput);
  collect(outputs.feasibilityReport);
  collect(outputs.gapActionsOutput);
  collect(outputs.gardenTargetsOutput);
  collect(outputs.animalTargetsOutput);
  collect(outputs.timelineOutput);

  return { blockers: rankIssues(blockers), risks: rankIssues(risks) };
}

function inferSeverityFromIssues(issues, opts) {
  if (issues?.blockers?.length) return opts.severity.blockersAs;
  if (issues?.risks?.length) return opts.severity.risksAs;
  return opts.severity.defaultAs;
}

function rankIssues(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.sort((a, b) => toNum(b.severity, 0) - toNum(a.severity, 0));
  return arr;
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

function clampExplanation(e, opts) {
  const ex = e || {};
  return {
    id: safeStr(ex.id) || `explain:${hashTiny(JSON.stringify(ex || {}))}`,
    title: safeStr(ex.title || "Explanation"),
    subtitle: safeStr(ex.subtitle || ""),
    severity: safeStr(ex.severity || "info"),
    bullets: normalizeStringArray(ex.bullets).slice(0, opts.maxBullets),
    facts: Array.isArray(ex.facts)
      ? ex.facts.slice(0, opts.maxFacts).map(normalizeFact).filter(Boolean)
      : [],
    assumptions: normalizeStringArray(ex.assumptions)
      .map(cleanNote)
      .filter(Boolean)
      .slice(0, opts.maxAssumptions),
    rulesApplied: normalizeStringArray(ex.rulesApplied)
      .map(cleanNote)
      .filter(Boolean)
      .slice(0, opts.maxRules),
    sources: Array.isArray(ex.sources)
      ? ex.sources.slice(0, 12).map(normalizeSource).filter(Boolean)
      : [],
    links: ex.links || undefined,
    trace: ex.trace || {},
  };
}

function normalizeFact(f) {
  if (!f || typeof f !== "object") return null;
  const label = safeStr(f.label);
  const value = safeStr(f.value);
  if (!label || !value) return null;
  const unit = safeStr(f.unit || "");
  return unit ? { label, value, unit } : { label, value };
}

function normalizeSource(s) {
  if (!s || typeof s !== "object") return null;
  const name = safeStr(s.name);
  if (!name) return null;
  const id = safeStr(s.id || "");
  const note = safeStr(s.note || "");
  const out = { name };
  if (id) out.id = id;
  if (note) out.note = note;
  return out;
}

function objectFacts(obj, max = 12) {
  if (!obj || typeof obj !== "object") return [];
  const entries = Object.entries(obj).slice(0, max);
  return entries
    .map(([k, v]) => ({
      label: safeStr(k),
      value:
        typeof v === "string"
          ? v
          : Array.isArray(v)
          ? `[${v.length}]`
          : typeof v === "object"
          ? "{…}"
          : String(v),
    }))
    .filter((x) => x.label && x.value);
}

function normalizeStringArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((x) => safeStr(x)).filter(Boolean);
}

function cleanNote(s) {
  const x = safeStr(s);
  if (!x) return "";
  return x.replace(/\s+/g, " ").trim();
}

export function formatQty(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return safeStr(n);
  if (Math.abs(x) >= 100) return String(Math.round(x));
  if (Math.abs(x) >= 10) return x.toFixed(1).replace(/\.0$/, "");
  return x.toFixed(2).replace(/\.00$/, "").replace(/0$/, "");
}

export function formatDateShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function capitalize(s) {
  const x = safeStr(s);
  if (!x) return "";
  return x.charAt(0).toUpperCase() + x.slice(1);
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

function clampInt(v, min, max) {
  const n = Math.round(toNum(v, min));
  return Math.max(min, Math.min(max, n));
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
